import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { EmbeddingProvider } from "../search/index.js";
import { openMemoryDb, type MemoryDb } from "../store/index.js";

import {
  acquireMemoryWriterLeaseForMaintenance,
  resolveActiveMemoryDbPath,
  type MemoryWriterLease,
} from "./generations.js";
import {
  acquireMemoryMaintenanceLease,
  fsyncMaintenanceDirectory,
  memoryMaintenanceTransactionPath,
} from "./maintenance.js";
import {
  forgetExplicitMemories,
  previewExplicitForgetMemories,
} from "./migrate.js";
import { recoverDurableMutationState } from "./mutation-lock.js";
import { canonicalMemoryRootPath } from "./path-safety.js";
import {
  assertCanonicalGraphRepairBaseParity,
  auditCanonicalIndexHealth,
  safeRebuildMemoryIndexForMaintenance,
} from "./rebuild.js";
import { readBujoCanonicalSourceFingerprint } from "./replay-projection.js";

const SCHEMA_VERSION = 1;
const MAX_IDS = 32;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const WRITER_LOCK_RELATIVE_PATH = `.index${sep}writer.lock`;

type BackupStatus = "prepared" | "applying" | "applied" | "recovered";
type TransactionPhase =
  | "applying"
  | "restore-prepared"
  | "quarantine-intent"
  | "root-quarantined"
  | "activation-intent"
  | "root-activated";

export interface ExplicitMemoryForgetHooks {
  readonly afterBackupDurable?: () => void | Promise<void>;
  readonly afterTransactionDurable?: () => void | Promise<void>;
  readonly afterMutation?: () => void | Promise<void>;
  readonly afterQuarantineIntentDurable?: () => void | Promise<void>;
  readonly afterRootRenameDurable?: () => void | Promise<void>;
  readonly afterRootQuarantined?: () => void | Promise<void>;
  readonly afterActivationIntentDurable?: () => void | Promise<void>;
  readonly afterSnapshotRenameDurable?: () => void | Promise<void>;
  readonly afterRootActivated?: () => void | Promise<void>;
}

export interface ApplyExplicitMemoryForgetOptions {
  readonly root: string;
  readonly ids: readonly string[];
  readonly expectedRootFingerprint: string;
  readonly expectedSourceFingerprint: string;
  readonly planDigest: string;
  readonly embeddings: EmbeddingProvider;
  readonly dimension: number;
  readonly now?: () => Date;
  readonly hooks?: ExplicitMemoryForgetHooks;
}

export interface RestoreExplicitMemoryForgetOptions {
  readonly root: string;
  readonly backupPath: string;
  readonly expectedRootFingerprint: string;
  readonly hooks?: ExplicitMemoryForgetHooks;
}

export interface ExplicitMemoryForgetApplyResult {
  readonly status: "applied";
  readonly forgotten: number;
  readonly sourceFingerprint: string;
  readonly backupPath: string;
}

export interface ExplicitMemoryForgetRestoreResult {
  readonly status: "restored";
  readonly sourceFingerprint: string;
  readonly backupPath: string;
  readonly planDigest: string;
}

/** Resolve without erasing a configured-root symlink from the safety decision. */
export function resolveExplicitMemoryForgetRoot(root: string): string {
  try {
    return canonicalMemoryRootPath(root, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const absolute = resolve(root);
    const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
    // A missing configured root is valid only during the two durable swap
    // intents. The complete sibling marker authenticates the expected path;
    // malformed or absent state remains fail-closed.
    const transaction = readTransaction(memoryMaintenanceTransactionPath(canonical));
    if (transaction.rootFingerprint !== rootFingerprint(canonical)) throw error;
    return canonical;
  }
}

export type ExplicitMemoryForgetErrorCode =
  | "apply_failed"
  | "apply_failed_recovered"
  | "apply_recovery_failed"
  | "restore_failed";

export class ExplicitMemoryForgetError extends Error {
  constructor(
    readonly code: ExplicitMemoryForgetErrorCode,
    readonly backupPath?: string,
    cause?: unknown,
  ) {
    super(`memory-forget: ${code}`, cause === undefined ? undefined : { cause });
    this.name = "ExplicitMemoryForgetError";
  }
}

export interface ExplicitMemoryForgetBackupManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operation: "memory-forget-backup";
  readonly status: BackupStatus;
  readonly rootFingerprint: string;
  readonly sourceFingerprint: string;
  readonly treeFingerprint: string;
  readonly activeDbRelativePath: string;
  readonly dimension: number;
  readonly createdAt: string;
  readonly planDigest: string;
  readonly postTreeFingerprint?: string;
  readonly postActiveDbRelativePath?: string;
}

interface MaintenanceTransaction {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operation: "memory-forget";
  readonly phase: TransactionPhase;
  readonly rootFingerprint: string;
  readonly backupPath: string;
  readonly planDigest: string;
  readonly originalTreeFingerprint: string;
  readonly expectedCurrentTreeFingerprint?: string;
}

interface BackupState {
  readonly path: string;
  readonly snapshotPath: string;
  readonly manifestPath: string;
  readonly postRootPath: string;
  manifest: ExplicitMemoryForgetBackupManifest;
}

export async function applyExplicitMemoryForget(
  options: ApplyExplicitMemoryForgetOptions,
): Promise<ExplicitMemoryForgetApplyResult> {
  assertApplyOptions(options);
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  let db: MemoryDb | undefined;
  let backup: BackupState | undefined;
  let transactionDurable = false;
  try {
    const root = resolveExplicitMemoryForgetRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const existing = readTransactionOptional(maintenance.transactionPath);
    if (existing !== undefined) {
      if (existing.planDigest !== options.planDigest
        || actualRootFingerprint !== options.expectedRootFingerprint) {
        throw new ExplicitMemoryForgetError("apply_recovery_failed", existing.backupPath);
      }
      backup = readBackup(existing.backupPath);
      if (!transactionMatchesRootAndBackup(existing, actualRootFingerprint, backup)) {
        throw new ExplicitMemoryForgetError("apply_recovery_failed", backup.path);
      }
      try {
        await restoreFromTransaction(root, maintenance.transactionPath, existing, backup, undefined, options.hooks);
      } catch (recoveryError) {
        throw new ExplicitMemoryForgetError("apply_recovery_failed", backup.path, recoveryError);
      }
      writer = undefined;
      throw new ExplicitMemoryForgetError("apply_failed_recovered", backup.path);
    }

    if (actualRootFingerprint !== options.expectedRootFingerprint) throw new Error("root mismatch");
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) throw new Error("root mismatch");
    const dbPath = resolveActiveMemoryDbPath(root);
    db = openMemoryDb({ path: dbPath, embeddings: options.embeddings, dim: options.dimension });
    recoverDurableMutationState(root, db, "bujo", assertCanonicalGraphRepairBaseParity);
    db.checkpoint();
    if (readBujoCanonicalSourceFingerprint(root) !== options.expectedSourceFingerprint) {
      throw new Error("stale plan");
    }
    previewExplicitForgetMemories(root, db, options.ids);
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);

    backup = createBackup(root, dbPath, options);
    await options.hooks?.afterBackupDurable?.();
    const transaction: MaintenanceTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: "memory-forget",
      phase: "applying",
      rootFingerprint: options.expectedRootFingerprint,
      backupPath: backup.path,
      planDigest: options.planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
    };
    writeJsonExclusiveDurable(maintenance.transactionPath, transaction);
    transactionDurable = true;
    backup.manifest = { ...backup.manifest, status: "applying" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    await options.hooks?.afterTransactionDurable?.();

    db = openMemoryDb({ path: dbPath, embeddings: options.embeddings, dim: options.dimension });
    const result = await forgetExplicitMemories({
      root,
      db,
      ids: options.ids,
      now: options.now ?? (() => new Date()),
      expectedSourceFingerprint: options.expectedSourceFingerprint,
    });
    db.checkpoint();
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);
    await options.hooks?.afterMutation?.();
    writer.release();
    writer = undefined;
    const rebuilt = await safeRebuildMemoryIndexForMaintenance({
      root,
      tier: "bujo",
      embeddings: options.embeddings,
      dim: options.dimension,
    });
    assertHealthyRoot(root, rebuilt.active, options.dimension, result.sourceFingerprint);
    const postTreeFingerprint = memoryTreeFingerprint(root);
    const postActiveDbRelativePath = relative(root, rebuilt.active);
    assertSafeRelative(postActiveDbRelativePath);
    backup.manifest = {
      ...backup.manifest,
      status: "applied",
      postTreeFingerprint,
      postActiveDbRelativePath,
    };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    unlinkDurable(maintenance.transactionPath);
    transactionDurable = false;
    return {
      status: "applied",
      forgotten: result.forgotten,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: backup.path,
    };
  } catch (error) {
    try { db?.close(); } catch { /* recovery owns the decisive result */ }
    db = undefined;
    if (!transactionDurable || backup === undefined) {
      if (error instanceof ExplicitMemoryForgetError) throw error;
      throw new ExplicitMemoryForgetError("apply_failed", backup?.path, error);
    }
    try {
      const transaction = readTransaction(maintenance.transactionPath);
      await restoreFromTransaction(options.root, maintenance.transactionPath, transaction, backup, writer, options.hooks);
      writer = undefined;
      throw new ExplicitMemoryForgetError("apply_failed_recovered", backup.path);
    } catch (recoveryError) {
      if (recoveryError instanceof ExplicitMemoryForgetError
        && recoveryError.code === "apply_failed_recovered") throw recoveryError;
      throw new ExplicitMemoryForgetError("apply_recovery_failed", backup.path);
    }
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

export async function restoreExplicitMemoryForget(
  options: RestoreExplicitMemoryForgetOptions,
): Promise<ExplicitMemoryForgetRestoreResult> {
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  try {
    const root = resolveExplicitMemoryForgetRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const backup = readBackup(resolve(options.backupPath));
    if (actualRootFingerprint !== options.expectedRootFingerprint
      || backup.manifest.rootFingerprint !== actualRootFingerprint) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    const existing = readTransactionOptional(maintenance.transactionPath);
    if (existing !== undefined) {
      if (!transactionMatchesRootAndBackup(existing, actualRootFingerprint, backup)) {
        throw new ExplicitMemoryForgetError("restore_failed");
      }
      await restoreFromTransaction(root, maintenance.transactionPath, existing, backup, undefined, options.hooks);
      writer = undefined;
      return restoredResult(backup);
    }
    if (backup.manifest.status !== "applied" || backup.manifest.postTreeFingerprint === undefined
      || backup.manifest.postActiveDbRelativePath === undefined) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    cleanupSqliteCoordination(join(
      writer.root,
      ...backup.manifest.postActiveDbRelativePath.split(/[\\/]/u),
    ));
    const currentTreeFingerprint = memoryTreeFingerprint(writer.root);
    if (currentTreeFingerprint !== backup.manifest.postTreeFingerprint) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    const transaction: MaintenanceTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: "memory-forget",
      phase: "restore-prepared",
      rootFingerprint: actualRootFingerprint,
      backupPath: backup.path,
      planDigest: backup.manifest.planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
      expectedCurrentTreeFingerprint: currentTreeFingerprint,
    };
    writeJsonExclusiveDurable(maintenance.transactionPath, transaction);
    await restoreFromTransaction(root, maintenance.transactionPath, transaction, backup, writer, options.hooks);
    writer = undefined;
    return restoredResult(backup);
  } catch (error) {
    if (error instanceof ExplicitMemoryForgetError) throw error;
    throw new ExplicitMemoryForgetError("restore_failed", undefined, error);
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

function transactionMatchesRootAndBackup(
  transaction: MaintenanceTransaction,
  actualRootFingerprint: string,
  backup: BackupState,
): boolean {
  return transaction.rootFingerprint === actualRootFingerprint
    && transaction.rootFingerprint === backup.manifest.rootFingerprint
    && resolve(transaction.backupPath) === backup.path
    && transaction.planDigest === backup.manifest.planDigest
    && transaction.originalTreeFingerprint === backup.manifest.treeFingerprint;
}

function createBackup(
  root: string,
  dbPath: string,
  options: ApplyExplicitMemoryForgetOptions,
): BackupState {
  const backupPath = join(
    dirname(root),
    `.${basename(root)}-forget-backup-${options.planDigest.slice(0, 24)}`,
  );
  if (existsSync(backupPath)) {
    const existing = readBackup(backupPath);
    if (existing.manifest.status !== "prepared"
      || existing.manifest.planDigest !== options.planDigest
      || existing.manifest.rootFingerprint !== options.expectedRootFingerprint
      || existing.manifest.sourceFingerprint !== options.expectedSourceFingerprint
      || memoryTreeFingerprint(root) !== existing.manifest.treeFingerprint) {
      throw new Error("backup already exists in a non-resumable state");
    }
    assertBackupSnapshot(existing);
    return existing;
  }
  const stagingPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(stagingPath, { mode: 0o700 });
  chmodSync(stagingPath, 0o700);
  fsyncMaintenanceDirectory(dirname(stagingPath));
  const snapshotPath = join(stagingPath, "snapshot");
  try {
    copyTreeDurably(root, snapshotPath, root);
    const treeFingerprint = memoryTreeFingerprint(root);
    if (memoryTreeFingerprint(snapshotPath) !== treeFingerprint) throw new Error("backup mismatch");
    const activeDbRelativePath = relative(root, dbPath);
    assertSafeRelative(activeDbRelativePath);
    const manifest: ExplicitMemoryForgetBackupManifest = {
      schemaVersion: SCHEMA_VERSION,
      operation: "memory-forget-backup",
      status: "prepared",
      rootFingerprint: options.expectedRootFingerprint,
      sourceFingerprint: options.expectedSourceFingerprint,
      treeFingerprint,
      activeDbRelativePath,
      dimension: options.dimension,
      createdAt: new Date().toISOString(),
      planDigest: options.planDigest,
    };
    const manifestPath = join(stagingPath, "manifest.json");
    writeJsonExclusiveDurable(manifestPath, manifest);
    fsyncMaintenanceDirectory(stagingPath);
    if (existsSync(backupPath)) throw new Error("backup was published concurrently");
    renameSync(stagingPath, backupPath);
    fsyncMaintenanceDirectory(dirname(backupPath));
    return readBackup(backupPath);
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    fsyncMaintenanceDirectory(dirname(stagingPath));
    throw error;
  }
}

async function restoreFromTransaction(
  rawRoot: string,
  transactionPath: string,
  initialTransaction: MaintenanceTransaction,
  backup: BackupState,
  initialWriter: MemoryWriterLease | undefined,
  hooks: ExplicitMemoryForgetHooks | undefined,
): Promise<void> {
  let writer = initialWriter;
  let transaction = reconcileRestoreTransaction(
    transactionPath,
    initialTransaction,
    resolve(rawRoot),
    backup,
  );
  const root = resolve(rawRoot);
  try {
    const activatedOnDisk = transaction.phase === "root-activated"
      && existsSync(root) && existsSync(backup.postRootPath) && !existsSync(backup.snapshotPath);
    if (transaction.phase === "root-activated" && !activatedOnDisk) {
      // A prior in-process rollback restored the pre-restore layout while a
      // crash prevented the phase record from being rewound. Re-pin the root
      // and restart the swap instead of stranding an impossible phase.
      if (!existsSync(root) || !existsSync(backup.snapshotPath) || existsSync(backup.postRootPath)) {
        throw new Error("restore activation recovery state is invalid");
      }
      transaction = {
        ...transaction,
        phase: transaction.expectedCurrentTreeFingerprint === undefined ? "applying" : "restore-prepared",
      };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (!activatedOnDisk && existsSync(backup.snapshotPath)) assertBackupSnapshot(backup);
    if (transaction.phase === "applying") {
      writer ??= acquireMemoryWriterLeaseForMaintenance(root);
      transaction = { ...transaction, phase: "restore-prepared" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase === "restore-prepared") {
      writer ??= acquireMemoryWriterLeaseForMaintenance(root);
      if (transaction.expectedCurrentTreeFingerprint !== undefined
        && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
        throw new Error("current memory changed before restore");
      }
      writer?.release();
      writer = undefined;
      if (existsSync(backup.postRootPath)) throw new Error("restore quarantine already exists");
      if (transaction.expectedCurrentTreeFingerprint !== undefined
        && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
        throw new Error("current memory changed at restore commit");
      }
      transaction = { ...transaction, phase: "quarantine-intent" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterQuarantineIntentDurable?.();
    }
    if (transaction.phase === "quarantine-intent") {
      const rootExists = existsSync(root);
      const snapshotExists = existsSync(backup.snapshotPath);
      const postRootExists = existsSync(backup.postRootPath);
      if (rootExists && snapshotExists && !postRootExists) {
        if (transaction.expectedCurrentTreeFingerprint !== undefined
          && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
          throw new Error("current memory changed at restore rename");
        }
        renameAcrossMaintenanceDirectoriesDurably(root, backup.postRootPath);
        await hooks?.afterRootRenameDurable?.();
      } else if (rootExists || !snapshotExists || !postRootExists) {
        throw new Error("restore quarantine intent state is invalid");
      }
      transaction = { ...transaction, phase: "root-quarantined" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterRootQuarantined?.();
    }
    if (transaction.phase === "root-quarantined") {
      if (existsSync(root) || !existsSync(backup.snapshotPath) || !existsSync(backup.postRootPath)) {
        throw new Error("restore quarantine state is invalid");
      }
      transaction = { ...transaction, phase: "activation-intent" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterActivationIntentDurable?.();
    }
    if (transaction.phase === "activation-intent") {
      const rootExists = existsSync(root);
      const snapshotExists = existsSync(backup.snapshotPath);
      const postRootExists = existsSync(backup.postRootPath);
      if (!rootExists && snapshotExists && postRootExists) {
        renameAcrossMaintenanceDirectoriesDurably(backup.snapshotPath, root);
        await hooks?.afterSnapshotRenameDurable?.();
      } else if (!rootExists || snapshotExists || !postRootExists) {
        throw new Error("restore activation intent state is invalid");
      }
      transaction = { ...transaction, phase: "root-activated" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterRootActivated?.();
    }
    if (transaction.phase !== "root-activated" || !existsSync(root) || !existsSync(backup.postRootPath)) {
      throw new Error("restore activation state is invalid");
    }
    assertHealthyRoot(
      root,
      join(root, ...backup.manifest.activeDbRelativePath.split(/[\\/]/u)),
      backup.manifest.dimension,
      backup.manifest.sourceFingerprint,
    );
    if (memoryTreeFingerprint(root) !== backup.manifest.treeFingerprint) {
      throw new Error("restored tree fingerprint mismatch");
    }
    backup.manifest = { ...backup.manifest, status: "recovered" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    unlinkDurable(transactionPath);
    try {
      rmSync(backup.postRootPath, { recursive: true, force: false });
      fsyncMaintenanceDirectory(backup.path);
    } catch {
      // Restore is already validated and durably committed. Retain harmless
      // quarantine rather than misreporting the committed root as a failure.
    }
  } catch (error) {
    writer?.release();
    try {
      if (existsSync(backup.postRootPath)) {
        if (existsSync(root)) {
          if (existsSync(backup.snapshotPath)) throw new Error("snapshot destination occupied");
          renameAcrossMaintenanceDirectoriesDurably(root, backup.snapshotPath);
        }
        renameAcrossMaintenanceDirectoriesDurably(backup.postRootPath, root);
        const restoredCurrent = memoryTreeFingerprint(root);
        if (transaction.expectedCurrentTreeFingerprint !== undefined
          && restoredCurrent !== transaction.expectedCurrentTreeFingerprint) {
          throw new Error("rollback fingerprint mismatch");
        }
      } else if (!existsSync(root) || !existsSync(backup.snapshotPath)) {
        throw new Error("restore rollback state is invalid");
      } else if (transaction.expectedCurrentTreeFingerprint !== undefined
        && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
        throw new Error("rollback fingerprint mismatch");
      }

      if (transaction.expectedCurrentTreeFingerprint !== undefined) {
        if (backup.manifest.status === "recovered") {
          backup.manifest = { ...backup.manifest, status: "applied" };
          replaceJsonDurable(backup.manifestPath, backup.manifest);
        }
        if (existsSync(transactionPath)) unlinkDurable(transactionPath);
      } else {
        transaction = { ...transaction, phase: "applying" };
        replaceJsonDurable(transactionPath, transaction);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "memory-forget: restore rollback failed; quarantine retained.");
    }
    throw error;
  }
}

function reconcileRestoreTransaction(
  transactionPath: string,
  initial: MaintenanceTransaction,
  root: string,
  backup: BackupState,
): MaintenanceTransaction {
  const rootExists = existsSync(root);
  const snapshotExists = existsSync(backup.snapshotPath);
  const postRootExists = existsSync(backup.postRootPath);
  let phase = initial.phase;

  // Accept the two legacy predecessor-phase crash layouts as well as the new
  // intent-first layouts. Reconciliation occurs before any writer acquisition,
  // so a missing root can never be accidentally recreated.
  if (phase === "restore-prepared" && !rootExists && snapshotExists && postRootExists) {
    phase = "root-quarantined";
  } else if (phase === "root-quarantined" && rootExists && !snapshotExists && postRootExists) {
    phase = "root-activated";
  } else if (phase === "root-activated" && rootExists && snapshotExists && !postRootExists) {
    phase = initial.expectedCurrentTreeFingerprint === undefined ? "applying" : "restore-prepared";
  }
  if (phase === initial.phase) return initial;
  const reconciled = { ...initial, phase };
  replaceJsonDurable(transactionPath, reconciled);
  return reconciled;
}

function assertBackupSnapshot(backup: BackupState): void {
  if (!existsSync(backup.snapshotPath)) throw new Error("backup snapshot is unavailable");
  if (memoryTreeFingerprint(backup.snapshotPath) !== backup.manifest.treeFingerprint) {
    throw new Error("backup snapshot changed");
  }
  assertHealthyRoot(
    backup.snapshotPath,
    join(backup.snapshotPath, ...backup.manifest.activeDbRelativePath.split(/[\\/]/u)),
    backup.manifest.dimension,
    backup.manifest.sourceFingerprint,
  );
  if (memoryTreeFingerprint(backup.snapshotPath) !== backup.manifest.treeFingerprint) {
    throw new Error("backup snapshot changed during validation");
  }
}

function assertHealthyRoot(root: string, dbPath: string, dimension: number, sourceFingerprint: string): void {
  if (readBujoCanonicalSourceFingerprint(root) !== sourceFingerprint) {
    throw new Error("canonical source fingerprint mismatch");
  }
  const db = openMemoryDb({ path: dbPath, readOnly: true, dim: dimension });
  try {
    if (db.integrityCheck().toLowerCase() !== "ok") throw new Error("SQLite integrity check failed");
    if (auditCanonicalIndexHealth(root, "bujo", db).status !== "match") {
      throw new Error("canonical and index state do not match");
    }
  } finally {
    db.close();
  }
  cleanupSqliteCoordination(dbPath);
}

function readBackup(path: string): BackupState {
  const info = lstatSync(path);
  assertExplicitMemoryForgetBackupDirectoryInfo(info);
  const manifestPath = join(path, "manifest.json");
  const manifest = parseExplicitMemoryForgetBackupManifest(readOwnerJson(manifestPath));
  return {
    path,
    snapshotPath: join(path, "snapshot"),
    manifestPath,
    postRootPath: join(path, "post-root"),
    manifest,
  };
}

/** @internal Shared with the asynchronous retention reader. */
export function assertExplicitMemoryForgetBackupDirectoryInfo(info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("backup directory is unsafe");
  }
}

/** @internal Shared with the asynchronous retention reader. */
export function parseExplicitMemoryForgetBackupManifest(value: unknown): ExplicitMemoryForgetBackupManifest {
  const manifest = value !== null && typeof value === "object"
    ? value as Partial<ExplicitMemoryForgetBackupManifest>
    : {};
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.operation !== "memory-forget-backup"
    || !["prepared", "applying", "applied", "recovered"].includes(String(manifest.status))
    || !isSha256(manifest.rootFingerprint) || !isSha256(manifest.sourceFingerprint)
    || !isSha256(manifest.treeFingerprint) || !isSha256(manifest.planDigest)
    || typeof manifest.activeDbRelativePath !== "string"
    || !Number.isInteger(manifest.dimension) || Number(manifest.dimension) <= 0
    || typeof manifest.createdAt !== "string"
    || (manifest.postTreeFingerprint !== undefined && !isSha256(manifest.postTreeFingerprint))
    || (manifest.postActiveDbRelativePath !== undefined && typeof manifest.postActiveDbRelativePath !== "string")) {
    throw new Error("backup manifest is invalid");
  }
  assertSafeRelative(manifest.activeDbRelativePath);
  if (manifest.postActiveDbRelativePath !== undefined) assertSafeRelative(manifest.postActiveDbRelativePath);
  return manifest as ExplicitMemoryForgetBackupManifest;
}

function readTransactionOptional(path: string): MaintenanceTransaction | undefined {
  return existsSync(path) ? readTransaction(path) : undefined;
}

function readTransaction(path: string): MaintenanceTransaction {
  const value = readOwnerJson(path) as Partial<MaintenanceTransaction>;
  if (value.schemaVersion !== SCHEMA_VERSION || value.operation !== "memory-forget"
    || ![
      "applying",
      "restore-prepared",
      "quarantine-intent",
      "root-quarantined",
      "activation-intent",
      "root-activated",
    ].includes(String(value.phase))
    || !isSha256(value.rootFingerprint) || !isSha256(value.planDigest)
    || !isSha256(value.originalTreeFingerprint) || typeof value.backupPath !== "string"
    || (value.expectedCurrentTreeFingerprint !== undefined && !isSha256(value.expectedCurrentTreeFingerprint))) {
    throw new Error("maintenance transaction is invalid");
  }
  return value as MaintenanceTransaction;
}

function memoryTreeFingerprint(root: string): string {
  const hash = createHash("sha256");
  hashTreeEntry(root, ".", hash);
  return hash.digest("hex");
}

function hashTreeEntry(root: string, relativePath: string, hash: ReturnType<typeof createHash>): void {
  const absolute = relativePath === "." ? root : join(root, relativePath);
  const info = lstatSync(absolute);
  const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
  if (info.isDirectory() && !info.isSymbolicLink()) {
    hash.update(`directory\0${relativePath}\0${mode}\0`);
    for (const name of readdirSync(absolute).sort()) {
      const child = relativePath === "." ? name : join(relativePath, name);
      if (child === WRITER_LOCK_RELATIVE_PATH) continue;
      hashTreeEntry(root, child, hash);
    }
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("memory-forget: backup tree contains an unsafe entry");
  }
  // File mtimes are part of the legacy capture-outbox freshness contract.
  // Directory mtimes are intentionally excluded because writer-lock churn
  // changes .index without changing committed memory content.
  // Node's Date-based futimes API preserves millisecond precision, which is
  // also the precision consumed by the legacy timestamp derivation.
  hash.update(`file\0${relativePath}\0${mode}\0${info.size}\0${info.mtime.valueOf()}\0`);
  hashFilePinned(absolute, info, hash);
  hash.update("\0");
}

function renameAcrossMaintenanceDirectoriesDurably(source: string, destination: string): void {
  renameSync(source, destination);
  const sourceParent = dirname(source);
  const destinationParent = dirname(destination);
  fsyncMaintenanceDirectory(sourceParent);
  if (destinationParent !== sourceParent) fsyncMaintenanceDirectory(destinationParent);
}

function hashFilePinned(path: string, before: Stats, hash: ReturnType<typeof createHash>): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSameExplicitMemoryForgetFile(before, opened, path);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (count <= 0) throw new Error("memory-forget: short fingerprint read");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    assertSameExplicitMemoryForgetSnapshot(opened, fstatSync(fd), path);
    assertSameExplicitMemoryForgetFile(opened, lstatSync(path), path);
  } finally {
    closeSync(fd);
  }
}

function copyTreeDurably(source: string, destination: string, sourceRoot: string): void {
  const relativePath = relative(sourceRoot, source) || ".";
  const info = lstatSync(source);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    mkdirSync(destination, { mode: info.mode & 0o777 });
    chmodSync(destination, info.mode & 0o777);
    fsyncMaintenanceDirectory(dirname(destination));
    for (const name of readdirSync(source).sort()) {
      const childRelative = relativePath === "." ? name : join(relativePath, name);
      if (childRelative === WRITER_LOCK_RELATIVE_PATH) continue;
      copyTreeDurably(join(source, name), join(destination, name), sourceRoot);
    }
    utimesSync(destination, info.atime, info.mtime);
    fsyncMaintenanceDirectory(destination);
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("memory-forget: memory tree contains an unsafe entry");
  }
  const input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    assertSameExplicitMemoryForgetFile(info, opened, source);
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      info.mode & 0o777,
    );
    fchmodSync(output, opened.mode & 0o777);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (count <= 0) throw new Error("memory-forget: short backup read");
      let written = 0;
      while (written < count) written += writeSync(output, buffer, written, count - written);
      offset += count;
    }
    futimesSync(output, opened.atime, opened.mtime);
    fsyncSync(output);
    assertSameExplicitMemoryForgetSnapshot(opened, fstatSync(input), source);
    assertSameExplicitMemoryForgetFile(opened, lstatSync(source), source);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

function cleanupSqliteCoordination(dbPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const path = `${dbPath}${suffix}`;
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("memory-forget: unsafe SQLite coordination file");
    }
    if (suffix !== "-shm" && info.size !== 0) {
      throw new Error("memory-forget: SQLite coordination file is not checkpointed");
    }
    unlinkSync(path);
    fsyncMaintenanceDirectory(dirname(path));
  }
}

function writeJsonExclusiveDurable(path: string, value: unknown): void {
  const temp = `${path}.publish-${process.pid}-${randomUUID()}`;
  try {
    writeJsonFileDurable(temp, value);
    if (existsSync(path)) throw new Error("memory-forget: durable artifact already exists");
    renameSync(temp, path);
    fsyncMaintenanceDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function writeJsonFileDurable(path: string, value: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replaceJsonDurable(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeJsonFileDurable(temp, value);
    renameSync(temp, path);
    fsyncMaintenanceDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function readOwnerJson(path: string): unknown {
  const before = lstatSync(path);
  assertExplicitMemoryForgetPrivateArtifactInfo(before);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSameExplicitMemoryForgetFile(before, opened, path);
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count <= 0) throw new Error("memory-forget: short artifact read");
      offset += count;
    }
    assertSameExplicitMemoryForgetSnapshot(opened, fstatSync(fd), path);
    assertSameExplicitMemoryForgetFile(opened, lstatSync(path), path);
    return JSON.parse(data.toString("utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** @internal Shared with the asynchronous retention reader. */
export function assertExplicitMemoryForgetPrivateArtifactInfo(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size > MAX_ARTIFACT_BYTES || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("memory-forget: private artifact is unsafe");
  }
}

function unlinkDurable(path: string): void {
  unlinkSync(path);
  fsyncMaintenanceDirectory(dirname(path));
}

function assertApplyOptions(options: ApplyExplicitMemoryForgetOptions): void {
  resolveExplicitMemoryForgetRoot(options.root);
  if (options.ids.length === 0 || options.ids.length > MAX_IDS || new Set(options.ids).size !== options.ids.length
    || !isSha256(options.expectedRootFingerprint) || !isSha256(options.expectedSourceFingerprint)
    || !isSha256(options.planDigest) || !Number.isInteger(options.dimension) || options.dimension <= 0) {
    throw new ExplicitMemoryForgetError("apply_failed");
  }
}

function assertSafeRelative(path: string): void {
  const parts = path.split(/[\\/]/u);
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")
    || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("memory-forget: unsafe relative path");
  }
}

export function assertSameExplicitMemoryForgetFile(
  expected: Pick<Stats, "dev" | "ino" | "isFile" | "isSymbolicLink" | "nlink">,
  actual: Stats,
  label: string,
): void {
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1
    || expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`memory-forget: ${label} changed identity`);
  }
}

export function assertSameExplicitMemoryForgetSnapshot(
  expected: Stats,
  actual: Stats,
  label: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.size !== actual.size
    || expected.mtimeMs !== actual.mtimeMs || expected.ctimeMs !== actual.ctimeMs) {
    throw new Error(`memory-forget: ${label} changed while accessed`);
  }
}

function rootFingerprint(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function restoredResult(backup: BackupState): ExplicitMemoryForgetRestoreResult {
  return {
    status: "restored",
    sourceFingerprint: backup.manifest.sourceFingerprint,
    backupPath: backup.path,
    planDigest: backup.manifest.planDigest,
  };
}

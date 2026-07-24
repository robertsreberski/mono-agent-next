import { backup as backupSqlite, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { load as loadSqliteVec } from "sqlite-vec";

import {
  auditBujoDatabase,
  type BujoAuditSnapshot,
} from "./bujo-db.js";
import { auditBujoProjections } from "./consolidation.js";
import type { MemoryEmbeddingProvider } from "./embeddings.js";
import { MemoryLocalError } from "./errors.js";
import {
  bindSecureDatabaseFile,
  createSecureFile,
  identity,
  openSecureRoot,
  pathExists,
  readSecureFile,
  sameFileIdentity,
  syncDirectory,
  verifySecureRoot,
  type BoundSecureDatabaseFile,
  type FileIdentity,
  type SecureRoot,
} from "./security.js";
import {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  openMemoryLocal,
  type MemoryLocalAudit,
} from "./store.js";
import {
  acquireMemoryWriterLease,
  MEMORY_LOCAL_WRITER_LEASE_FILENAME,
} from "./writer-lease.js";

export const MEMORY_LOCAL_V0_SNAPSHOT_SCHEMA =
  "mono-agent.memory-local.v0-snapshot.v1";
export const MEMORY_LOCAL_V0_ADOPTION_SCHEMA =
  "mono-agent.memory-local.v0-adoption.v1";

const MANIFEST_MAX_BYTES = 256 * 1024;
const MARKER_MAX_BYTES = 128;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_BYTES = 64 * 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MANAGED_GENERATION = /^g-[0-9]{8}T[0-9]{9}Z-[a-f0-9-]{36}$/u;
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SQLITE_SIDECARS = ["-journal", "-shm", "-wal"] as const;
const TRANSIENT_V0_PATHS = new Set([
  ".index/runtime.json",
  ".index/writer.lock",
]);

export interface SnapshotV0MemoryLocalRootOptions {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly signal?: AbortSignal;
}

export interface AdoptV0MemoryLocalCopyOptions {
  readonly liveSourceRoot: string;
  readonly targetRoot: string;
  readonly expectedSourceStateSha256: string;
  readonly expectedTreeSha256: string;
  readonly confirm: string;
  readonly signal?: AbortSignal;
}

export interface MemoryLocalV0DatabaseEvidence {
  readonly sha256: string;
  readonly bytes: number;
  readonly records: number;
  readonly recordBytes: number;
  readonly ftsIndexed: number;
  readonly ftsMissing: number;
  readonly ftsOrphaned: number;
  readonly vectorsIndexed: number;
  readonly vectorsMissing: number;
  readonly vectorDimensions: number;
  readonly pendingCaptures: number;
  readonly pendingVectors: number;
}

export interface MemoryLocalV0SnapshotResult {
  readonly schema: typeof MEMORY_LOCAL_V0_SNAPSHOT_SCHEMA;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly activeGeneration: string;
  readonly sourceStateSha256: string;
  readonly sourceMarker:
    | { readonly state: "absent" }
    | {
        readonly state: "initialized";
        readonly storeId: string;
        readonly sha256: string;
      };
  readonly treeSha256: string;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly database: MemoryLocalV0DatabaseEvidence;
}

export interface MemoryLocalV0AdoptionResult {
  readonly schema: typeof MEMORY_LOCAL_V0_ADOPTION_SCHEMA;
  readonly liveSourceRoot: string;
  readonly targetRoot: string;
  readonly activeGeneration: string;
  readonly sourceStateSha256: string;
  readonly preAdoptionTreeSha256: string;
  readonly storeId: string;
  readonly markerSha256: string;
  readonly marker: {
    readonly device: string;
    readonly inode: string;
    readonly mode: 384;
    readonly links: 1;
  };
  readonly database: MemoryLocalV0DatabaseEvidence;
  readonly audit: MemoryLocalAudit;
}

interface ManagedDatabase {
  readonly generation: string;
  readonly relativePath: string;
  readonly path: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly manifestIdentity: FileIdentity;
  readonly databaseIdentity: FileIdentity;
}

interface ProtectedSourceRoot {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

interface TreeEvidence {
  readonly sha256: string;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

interface BoundAdoptionTree {
  readonly databaseRelativePath: string;
  readonly bindingRelativePath: string;
  readonly authorityRelativePath: string;
  readonly database: BoundSecureDatabaseFile;
}

interface EmbeddingIdentity {
  readonly id: string;
  readonly dimensions: number;
}

type SourceMarkerEvidence = MemoryLocalV0SnapshotResult["sourceMarker"];

interface MemoryLocalMigrationTestHooks {
  readonly beforeSnapshotTargetCreate?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotTargetOpen?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotTargetCleanupRename?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotTargetCleanupParentSync?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotFailureCleanupRename?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotFailureCleanupParentSync?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotSourceRecheck?: (
    sourceRoot: string,
    targetRoot: string,
  ) => void | Promise<void>;
  readonly afterSnapshotDirectorySync?: (
    targetDirectory: string,
  ) => void | Promise<void>;
  readonly beforeAdoptionDatabaseBind?: (path: string) => void | Promise<void>;
  readonly beforeAdoptionCommit?: (path: string) => void | Promise<void>;
}

interface SnapshotSourceFileEvidence {
  readonly stats: BigIntStats;
  readonly sha256: string;
}

interface SnapshotSourceDirectoryEvidence {
  readonly stats: BigIntStats;
  readonly children: readonly string[];
}

interface MutableSourceDatabase {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export async function snapshotV0MemoryLocalRoot(
  options: SnapshotV0MemoryLocalRootOptions,
): Promise<MemoryLocalV0SnapshotResult> {
  return await snapshotV0MemoryLocalRootInternal(options, {});
}

/** @internal Test-only adversarial hook surface; not exported by the package entrypoint. */
export async function snapshotV0MemoryLocalRootForTesting(
  options: SnapshotV0MemoryLocalRootOptions,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<MemoryLocalV0SnapshotResult> {
  return await snapshotV0MemoryLocalRootInternal(options, hooks);
}

async function snapshotV0MemoryLocalRootInternal(
  options: SnapshotV0MemoryLocalRootOptions,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<MemoryLocalV0SnapshotResult> {
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const sourceRoot = absolutePath(options.sourceRoot, "sourceRoot");
  const targetRoot = absolutePath(options.targetRoot, "targetRoot");
  if (sourceRoot === targetRoot) {
    throw migrationFailure("Snapshot source and target roots must differ.");
  }
  if (pathsOverlap(sourceRoot, targetRoot)) {
    throw migrationFailure("Snapshot source and target roots must be disjoint.");
  }

  const source = await openProtectedSourceRoot(sourceRoot);
  let target: SecureRoot | undefined;
  let createdTargetIdentity: FileIdentity | undefined;
  let sourceDatabaseFile: MutableSourceDatabase | undefined;
  let sourceDatabase: DatabaseSync | undefined;
  let completed = false;
  try {
    const sourceMarker = await inspectSourceMarker(source.path);
    const managed = await readManagedDatabase(source.path);
    const sourceStateBefore = sourceStateDigest(source, managed, sourceMarker);
    const activeDatabaseBytes = await sourceDatabaseFootprint(managed.path);
    await assertDistinctTarget(source, targetRoot);
    await hooks.beforeSnapshotTargetCreate?.(targetRoot);
    target = await createPrivateTargetRoot(targetRoot, hooks);
    createdTargetIdentity = target.identity;
    await syncDirectory(dirname(targetRoot));
    if (sameRoot(source.identity, target.identity)) {
      throw migrationFailure("Snapshot source and target resolve to the same directory.");
    }

    const copy = new SnapshotCopier(
      source.path,
      target.path,
      managed.relativePath,
      activeDatabaseBytes,
      signal,
      hooks,
    );
    await copy.copyDirectory("");
    throwIfAborted(signal);

    const targetDatabasePath = join(target.path, managed.relativePath);
    sourceDatabaseFile = await openMutableSourceDatabase(managed.path);
    const liveDatabaseStats = await sourceDatabaseFile.handle.stat({ bigint: true });
    assertSourceFile(managed.path, liveDatabaseStats);
    copy.assertActiveDatabaseBytes(Math.max(
      activeDatabaseBytes,
      Number(liveDatabaseStats.size),
    ));
    sourceDatabase = openDatabase(managed.path, true);
    await sourceDatabaseFile.verify();
    sourceDatabase.exec("BEGIN");
    copy.assertActiveDatabaseBytes(Math.max(
      activeDatabaseBytes,
      logicalDatabaseBytes(sourceDatabase),
    ));
    const sourceAudit = auditBujoDatabase(sourceDatabase);
    await createPrivateFile(targetDatabasePath);
    await backupSqlite(sourceDatabase, targetDatabasePath);
    await sourceDatabaseFile.verify();
    sourceDatabase.exec("COMMIT");
    sourceDatabase.close();
    sourceDatabase = undefined;
    await sourceDatabaseFile.close();
    sourceDatabaseFile = undefined;
    await normalizeSnapshotDatabase(targetDatabasePath);
    const targetDatabaseStats = await lstat(targetDatabasePath, { bigint: true });
    assertTargetFile(targetDatabaseStats);
    copy.assertActiveDatabaseBytes(Number(targetDatabaseStats.size));
    await syncSnapshotDirectory(dirname(targetDatabasePath), hooks);
    await hooks.beforeSnapshotSourceRecheck?.(source.path, target.path);
    await copy.verifySourceTree();
    await assertManifestCurrent(managed);
    await verifyProtectedSourceRoot(source);
    const refreshedManaged = await readManagedDatabase(source.path);
    const sourceStateAfter = sourceStateDigest(
      source,
      refreshedManaged,
      await inspectSourceMarker(source.path),
    );
    if (sourceStateAfter !== sourceStateBefore) {
      throw migrationFailure("Migration source state changed during snapshot.");
    }
    await verifySecureRoot(target);

    const database = await inspectBoundDatabaseEvidence(targetDatabasePath);
    assertDatabaseCoverage(database, sourceAudit);
    const firstTree = await digestTree(target.path, signal);
    const secondTree = await digestTree(target.path, signal);
    if (firstTree.sha256 !== secondTree.sha256) {
      throw migrationFailure("Snapshot target changed while its digest was computed.");
    }
    const result = Object.freeze({
      schema: MEMORY_LOCAL_V0_SNAPSHOT_SCHEMA,
      sourceRoot: source.path,
      targetRoot: target.path,
      activeGeneration: managed.generation,
      sourceStateSha256: sourceStateBefore,
      sourceMarker,
      treeSha256: firstTree.sha256,
      files: firstTree.files,
      directories: firstTree.directories,
      bytes: firstTree.bytes,
      database,
    });
    completed = true;
    return result;
  } finally {
    try {
      sourceDatabase?.close();
    } catch {
      // The source process retains ownership of its live SQLite state.
    }
    await sourceDatabaseFile?.close().catch(() => undefined);
    let cleanupError: unknown;
    if (!completed && createdTargetIdentity !== undefined) {
      try {
        await cleanupFailedSnapshotTarget(
          targetRoot,
          createdTargetIdentity,
          target,
          hooks,
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    await target?.handle.close().catch(() => undefined);
    await source.handle.close().catch(() => undefined);
    if (cleanupError !== undefined) throw cleanupError;
  }
}

export async function adoptV0MemoryLocalCopy(
  options: AdoptV0MemoryLocalCopyOptions,
): Promise<MemoryLocalV0AdoptionResult> {
  return await adoptV0MemoryLocalCopyInternal(options, {});
}

/** @internal Test-only adversarial hook surface; not exported by the package entrypoint. */
export async function adoptV0MemoryLocalCopyForTesting(
  options: AdoptV0MemoryLocalCopyOptions,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<MemoryLocalV0AdoptionResult> {
  return await adoptV0MemoryLocalCopyInternal(options, hooks);
}

async function adoptV0MemoryLocalCopyInternal(
  options: AdoptV0MemoryLocalCopyOptions,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<MemoryLocalV0AdoptionResult> {
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  if (
    !SHA256.test(options.expectedSourceStateSha256)
    || !SHA256.test(options.expectedTreeSha256)
    || options.confirm !== options.expectedTreeSha256
  ) {
    throw migrationFailure(
      "Adoption requires exact lowercase source/tree SHA-256 values and matching tree confirmation.",
    );
  }
  const liveSourceRoot = absolutePath(options.liveSourceRoot, "liveSourceRoot");
  const targetRoot = absolutePath(options.targetRoot, "targetRoot");
  if (liveSourceRoot === targetRoot) {
    throw migrationFailure("Live source and adoption target roots must differ.");
  }
  if (pathsOverlap(liveSourceRoot, targetRoot)) {
    throw migrationFailure("Live source and adoption target roots must be disjoint.");
  }

  const liveSource = await openProtectedSourceRoot(liveSourceRoot);
  const target = await openSecureRoot(targetRoot);
  let databaseBinding: BoundSecureDatabaseFile | undefined;
  let preCommit: DatabaseSync | undefined;
  let markerHandle: FileHandle | undefined;
  let lease: Awaited<ReturnType<typeof acquireMemoryWriterLease>> | undefined;
  let storeId: string | undefined;
  try {
    if (sameRoot(liveSource.identity, target.identity)) {
      throw migrationFailure("Live source and adoption target are the same directory.");
    }
    const firstSourceState = await inspectSourceState(liveSource);
    const secondSourceState = await inspectSourceState(liveSource);
    if (
      firstSourceState !== secondSourceState
      || firstSourceState !== options.expectedSourceStateSha256
    ) {
      throw migrationFailure("Live source state does not match the confirmed snapshot source.");
    }
    if (await pathExists(join(target.path, MEMORY_LOCAL_MARKER_FILENAME))) {
      throw migrationFailure("Adoption target already has a permanent memory marker.");
    }
    await rejectAdoptionTransients(target.path);
    const managed = await readManagedDatabase(target.path);
    const firstTree = await digestTree(target.path, signal);
    const secondTree = await digestTree(target.path, signal);
    if (
      firstTree.sha256 !== secondTree.sha256
      || firstTree.sha256 !== options.expectedTreeSha256
    ) {
      throw migrationFailure("Adoption target tree does not match the confirmed snapshot digest.");
    }

    lease = await acquireMemoryWriterLease(target);
    const markerPath = join(target.path, MEMORY_LOCAL_MARKER_FILENAME);
    markerHandle = await createSecureFile(markerPath);
    storeId = randomUUID();
    await writeMarkerState(markerHandle, "initializing", storeId);
    await syncDirectory(target.path);
    const markerIdentity = identity(await markerHandle.stat());
    await assertMarkerCurrent(markerPath, markerIdentity, "initializing", storeId);

    databaseBinding = await bindSecureDatabaseFile(
      managed.path,
      () => hooks.beforeAdoptionDatabaseBind?.(managed.path),
    );
    preCommit = openDatabase(databaseBinding.openPath, true);
    await databaseBinding.verify();
    const snapshot = auditBujoDatabase(preCommit);
    const database = await databaseEvidenceFromBound(
      databaseBinding,
      snapshot,
    );
    let embedding: EmbeddingIdentity | undefined;
    embedding = readEmbeddingIdentity(preCommit, snapshot);
    assertStrictDatabase(snapshot, embedding);
    await databaseBinding.verify();
    await assertManifestCurrent(managed);
    const projections = await auditBujoProjections(target);
    if (!projections.coherent) {
      throw migrationFailure("Adoption target has incomplete or unsafe projections.");
    }
    await verifySecureRoot(target);
    await lease.verify();
    if (await inspectSourceState(liveSource) !== firstSourceState) {
      throw migrationFailure("Live source state changed during adoption.");
    }
    await databaseBinding.verify();
    await assertMarkerCurrent(markerPath, markerIdentity, "initializing", storeId);
    const boundTree = Object.freeze({
      databaseRelativePath: managed.relativePath,
      bindingRelativePath: relative(target.path, databaseBinding.openPath),
      authorityRelativePath: relative(target.path, databaseBinding.authorityPath),
      database: databaseBinding,
    });
    await hooks.beforeAdoptionCommit?.(managed.path);
    await assertAdoptionTreeCurrent(
      target.path,
      signal,
      options.expectedTreeSha256,
      boundTree,
    );
    await lease.verify();

    await writeMarkerState(markerHandle, "initialized", storeId);
    await syncDirectory(target.path);
    await assertMarkerCurrent(markerPath, markerIdentity, "initialized", storeId);
    try {
      await assertAdoptionTreeCurrent(
        target.path,
        signal,
        options.expectedTreeSha256,
        boundTree,
      );
      await lease.verify();
    } catch (error) {
      await writeMarkerState(markerHandle, "initializing", storeId);
      await syncDirectory(target.path);
      await assertMarkerCurrent(markerPath, markerIdentity, "initializing", storeId);
      throw error;
    }
    await markerHandle.close();
    markerHandle = undefined;
    preCommit.close();
    preCommit = undefined;
    await databaseBinding.verify();
    await databaseBinding.close();
    databaseBinding = undefined;
    await lease.release();
    lease = undefined;
    await target.handle.close();

    const provider = embedding === undefined
      ? undefined
      : new AuditOnlyEmbeddingProvider(embedding);
    const memory = await openMemoryLocal({
      config: {
        root: targetRoot,
        ...(embedding === undefined ? {} : {
          embeddings: {
            provider: "ollama",
            endpoint: "http://127.0.0.1:1",
            model: embedding.id.slice("ollama:".length),
            dimensions: embedding.dimensions,
          },
        }),
      },
      configDirectory: dirname(targetRoot),
      dataDirectory: targetRoot,
      ...(provider === undefined ? {} : { embeddingProvider: provider }),
    });
    let audit: MemoryLocalAudit;
    try {
      audit = await memory.audit({ signal, strict: true });
    } finally {
      await memory.stop();
    }
    const marker = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    assertMarkerBytes(marker.bytes, "initialized", storeId);
    return Object.freeze({
      schema: MEMORY_LOCAL_V0_ADOPTION_SCHEMA,
      liveSourceRoot: liveSource.path,
      targetRoot,
      activeGeneration: managed.generation,
      sourceStateSha256: firstSourceState,
      preAdoptionTreeSha256: firstTree.sha256,
      storeId,
      markerSha256: createHash("sha256").update(marker.bytes).digest("hex"),
      marker: markerSummary(marker.identity),
      database,
      audit,
    });
  } finally {
    await markerHandle?.close().catch(() => undefined);
    try {
      preCommit?.close();
    } catch {
      // Binding cleanup below retains ambiguous state for inspection.
    }
    await databaseBinding?.close().catch(() => undefined);
    await lease?.release().catch(() => undefined);
    await target.handle.close().catch(() => undefined);
    await liveSource.handle.close().catch(() => undefined);
  }
}

class SnapshotCopier {
  readonly #sourceRoot: string;
  readonly #targetRoot: string;
  readonly #activeDatabase: string;
  readonly #signal: AbortSignal;
  readonly #hooks: MemoryLocalMigrationTestHooks;
  readonly #files = new Map<string, SnapshotSourceFileEvidence>();
  readonly #directories = new Map<string, SnapshotSourceDirectoryEvidence>();
  #activeDatabaseBytes: number;
  #entries = 0;
  #bytes = 0;

  constructor(
    sourceRoot: string,
    targetRoot: string,
    activeDatabase: string,
    activeDatabaseBytes: number,
    signal: AbortSignal,
    hooks: MemoryLocalMigrationTestHooks,
  ) {
    this.#sourceRoot = sourceRoot;
    this.#targetRoot = targetRoot;
    this.#activeDatabase = activeDatabase;
    this.#signal = signal;
    this.#hooks = hooks;
    this.#activeDatabaseBytes = activeDatabaseBytes;
    this.#count(activeDatabaseBytes);
  }

  assertActiveDatabaseBytes(bytes: number): void {
    assertBoundedActiveDatabase(bytes);
    this.#bytes += bytes - this.#activeDatabaseBytes;
    this.#activeDatabaseBytes = bytes;
    if (this.#bytes > MAX_TREE_BYTES) {
      throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
    }
  }

  async copyDirectory(relativePath: string): Promise<void> {
    throwIfAborted(this.#signal);
    const sourcePath = relativePath === "" ? this.#sourceRoot : join(this.#sourceRoot, relativePath);
    const before = await lstat(sourcePath, { bigint: true });
    assertSourceDirectory(sourcePath, before);
    if (relativePath !== "") {
      await mkdir(join(this.#targetRoot, relativePath), { mode: 0o700 });
    }
    this.#count(0);
    const entries = (await readdir(sourcePath, { withFileTypes: true }))
      .sort((left, right) => comparePathNames(left.name, right.name));
    const copiedChildren: string[] = [];
    for (const entry of entries) {
      const childRelative = relativePath === "" ? entry.name : join(relativePath, entry.name);
      if (skipSnapshotPath(childRelative, this.#activeDatabase)) continue;
      copiedChildren.push(entry.name);
      const sourceChild = join(this.#sourceRoot, childRelative);
      const stats = await lstat(sourceChild, { bigint: true });
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await this.copyDirectory(childRelative);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw migrationFailure("Snapshot source contains an unsupported filesystem entry.");
      }
      this.#count(Number(stats.size));
      this.#files.set(childRelative, await copyStableFile(
        sourceChild,
        join(this.#targetRoot, childRelative),
        this.#signal,
        stats,
      ));
    }
    const after = await lstat(sourcePath, { bigint: true });
    if (!sameStableDirectoryIdentity(before, after)) {
      throw migrationFailure("Snapshot source directory changed while it was copied.");
    }
    this.#directories.set(relativePath, Object.freeze({
      stats: after,
      children: Object.freeze(copiedChildren),
    }));
    await syncSnapshotDirectory(
      relativePath === "" ? this.#targetRoot : join(this.#targetRoot, relativePath),
      this.#hooks,
    );
  }

  async verifySourceTree(): Promise<void> {
    const seenFiles = new Set<string>();
    const seenDirectories = new Set<string>();
    const walk = async (relativePath: string): Promise<void> => {
      throwIfAborted(this.#signal);
      const expected = this.#directories.get(relativePath);
      if (expected === undefined) {
        throw migrationFailure("Snapshot source directory manifest is incomplete.");
      }
      const sourcePath = relativePath === ""
        ? this.#sourceRoot
        : join(this.#sourceRoot, relativePath);
      const current = await lstat(sourcePath, { bigint: true });
      assertSourceDirectory(sourcePath, current);
      if (!sameStableDirectoryIdentity(expected.stats, current)) {
        throw migrationFailure("Snapshot source directory changed after it was copied.");
      }
      const children = (await readdir(sourcePath))
        .sort(comparePathNames)
        .filter((name) => {
          const child = relativePath === "" ? name : join(relativePath, name);
          return !skipSnapshotPath(child, this.#activeDatabase);
        });
      if (
        children.length !== expected.children.length
        || children.some((name, index) => name !== expected.children[index])
      ) {
        throw migrationFailure("Snapshot source tree changed after it was copied.");
      }
      seenDirectories.add(relativePath);
      for (const name of children) {
        const child = relativePath === "" ? name : join(relativePath, name);
        const directory = this.#directories.get(child);
        if (directory !== undefined) {
          await walk(child);
          continue;
        }
        const file = this.#files.get(child);
        if (file === undefined) {
          throw migrationFailure("Snapshot source file manifest is incomplete.");
        }
        await verifyCopiedSourceFile(join(this.#sourceRoot, child), file, this.#signal);
        seenFiles.add(child);
      }
    };
    await walk("");
    if (
      seenFiles.size !== this.#files.size
      || seenDirectories.size !== this.#directories.size
    ) {
      throw migrationFailure("Snapshot source tree manifest no longer matches the source.");
    }
  }

  #count(bytes: number): void {
    this.#entries += 1;
    this.#bytes += bytes;
    if (this.#entries > MAX_TREE_ENTRIES || this.#bytes > MAX_TREE_BYTES) {
      throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
    }
  }
}

async function readManagedDatabase(root: string): Promise<ManagedDatabase> {
  const manifestPath = join(root, ".index", "manifest.json");
  const manifest = await readSecureFile(manifestPath, MANIFEST_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes));
  } catch {
    throw migrationFailure("Managed BuJo manifest is malformed.");
  }
  if (!plainObject(parsed) || parsed.schemaVersion !== 1 || !plainObject(parsed.active)) {
    throw migrationFailure("Managed BuJo manifest has an unsupported identity.");
  }
  const generation = parsed.active.name;
  if (typeof generation !== "string" || !MANAGED_GENERATION.test(generation)) {
    throw migrationFailure("Managed BuJo manifest active generation is invalid.");
  }
  const relativePath = join(
    ".index",
    "generations",
    generation,
    MEMORY_LOCAL_DATABASE_FILENAME,
  );
  const databasePath = join(root, relativePath);
  const databaseIdentity = await inspectSourceFile(databasePath, true);
  return Object.freeze({
    generation,
    relativePath,
    path: databasePath,
    manifestPath,
    manifestDigest: createHash("sha256").update(manifest.bytes).digest("hex"),
    manifestIdentity: manifest.identity,
    databaseIdentity,
  });
}

async function assertManifestCurrent(managed: ManagedDatabase): Promise<void> {
  const current = await readSecureFile(managed.manifestPath, MANIFEST_MAX_BYTES);
  const digest = createHash("sha256").update(current.bytes).digest("hex");
  if (
    digest !== managed.manifestDigest
    || !sameFileIdentity(current.identity, managed.manifestIdentity)
  ) {
    throw migrationFailure("Managed BuJo manifest changed during snapshot.");
  }
}

async function inspectSourceState(root: ProtectedSourceRoot): Promise<string> {
  await verifyProtectedSourceRoot(root);
  const marker = await inspectSourceMarker(root.path);
  const managed = await readManagedDatabase(root.path);
  await assertManifestCurrent(managed);
  const currentDatabase = await inspectSourceFile(managed.path, true);
  if (!sameMutableFileIdentity(currentDatabase, managed.databaseIdentity)) {
    throw migrationFailure("Live source database identity changed.");
  }
  await verifyProtectedSourceRoot(root);
  return sourceStateDigest(root, managed, marker);
}

function sourceStateDigest(
  root: ProtectedSourceRoot,
  managed: ManagedDatabase,
  marker: SourceMarkerEvidence,
): string {
  const hash = createHash("sha256");
  hash.update(`${MEMORY_LOCAL_V0_SNAPSHOT_SCHEMA}\0source-state\0`);
  hash.update(JSON.stringify({
    root: {
      path: root.path,
      device: root.identity.device,
      inode: root.identity.inode,
      owner: root.identity.owner,
      mode: root.identity.mode,
      links: root.identity.links,
    },
    marker,
    manifest: {
      generation: managed.generation,
      sha256: managed.manifestDigest,
      device: managed.manifestIdentity.device,
      inode: managed.manifestIdentity.inode,
      owner: managed.manifestIdentity.owner,
      mode: managed.manifestIdentity.mode,
      links: managed.manifestIdentity.links,
      size: managed.manifestIdentity.size,
    },
    database: {
      device: managed.databaseIdentity.device,
      inode: managed.databaseIdentity.inode,
      owner: managed.databaseIdentity.owner,
      mode: managed.databaseIdentity.mode,
      links: managed.databaseIdentity.links,
    },
  }));
  return hash.digest("hex");
}

async function inspectBoundDatabaseEvidence(
  path: string,
): Promise<MemoryLocalV0DatabaseEvidence> {
  const binding = await bindSecureDatabaseFile(path);
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(binding.openPath, true);
    await binding.verify();
    const snapshot = auditBujoDatabase(database);
    return await databaseEvidenceFromBound(binding, snapshot);
  } finally {
    database?.close();
    await binding.close();
  }
}

async function databaseEvidenceFromBound(
  binding: BoundSecureDatabaseFile,
  snapshot: BujoAuditSnapshot,
): Promise<MemoryLocalV0DatabaseEvidence> {
  await binding.verify();
  const sha256 = await hashPinnedFile(binding);
  await binding.verify();
  return Object.freeze({
    sha256,
    bytes: binding.identity.size,
    records: snapshot.recordCount,
    recordBytes: snapshot.recordBytes,
    ftsIndexed: snapshot.ftsCount,
    ftsMissing: snapshot.missingFtsRows,
    ftsOrphaned: snapshot.orphanFtsRows,
    vectorsIndexed: snapshot.vectorCount,
    vectorsMissing: snapshot.missingVectorRows,
    vectorDimensions: requiredVectorDimension(snapshot),
    pendingCaptures: snapshot.pendingCaptureCount,
    pendingVectors: snapshot.pendingVectorCount,
  });
}

function openDatabase(path: string, vectors: boolean): DatabaseSync {
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: vectors });
  try {
    if (vectors) {
      loadSqliteVec(database);
      database.enableLoadExtension(false);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openMutableSourceDatabase(path: string): Promise<MutableSourceDatabase> {
  const before = await inspectSourceFile(path, true);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = identity(await handle.stat());
    if (!sameMutableFileIdentity(before, opened)) {
      throw migrationFailure("Live source database changed while opening.");
    }
    const verify = async (): Promise<void> => {
      const descriptor = identity(await handle.stat());
      const current = await inspectSourceFile(path, true);
      if (
        !sameMutableFileIdentity(before, descriptor)
        || !sameMutableFileIdentity(descriptor, current)
      ) {
        throw migrationFailure("Live source database identity changed during snapshot.");
      }
    };
    await verify();
    let closed = false;
    return {
      path,
      handle,
      identity: before,
      verify: async () => {
        if (closed) throw migrationFailure("Live source database descriptor is closed.");
        await verify();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function normalizeSnapshotDatabase(path: string): Promise<void> {
  const pinned = await openMutableSourceDatabase(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    await pinned.verify();
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const journal = database.prepare("PRAGMA journal_mode = DELETE").get() as
      | { journal_mode?: unknown }
      | undefined;
    if (journal?.journal_mode !== "delete") {
      throw migrationFailure("Snapshot database journal mode could not be normalized.");
    }
    await pinned.verify();
    database.close();
    database = undefined;
    await pinned.verify();
    for (const suffix of SQLITE_SIDECARS) {
      if (await pathExists(`${path}${suffix}`)) {
        throw migrationFailure("Snapshot database retained SQLite recovery state.");
      }
    }
  } finally {
    try {
      database?.close();
    } finally {
      await pinned.close();
    }
  }
}

async function hashPinnedFile(binding: BoundSecureDatabaseFile): Promise<string> {
  const before = await binding.handle.stat({ bigint: true });
  if (
    !before.isFile()
    || before.uid !== BigInt(currentUid())
    || before.nlink !== 2n
    || (before.mode & 0o777n) !== 0o600n
    || String(before.dev) !== binding.identity.device
    || String(before.ino) !== binding.identity.inode
    || before.size !== BigInt(binding.identity.size)
  ) {
    throw migrationFailure("Bound memory database identity is unsafe.");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let offset = 0;
  try {
    while (offset < Number(before.size)) {
      const length = Math.min(buffer.byteLength, Number(before.size) - offset);
      const { bytesRead } = await binding.handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset !== Number(before.size)) {
      throw migrationFailure("Bound memory database changed size while hashing.");
    }
    const after = await binding.handle.stat({ bigint: true });
    if (!sameStableIdentity(before, after)) {
      throw migrationFailure("Bound memory database changed while hashing.");
    }
    return hash.digest("hex");
  } finally {
    await binding.verify();
  }
}

async function copyStableFile(
  source: string,
  target: string,
  signal: AbortSignal,
  before: BigIntStats,
): Promise<SnapshotSourceFileEvidence> {
  assertSourceFile(source, before);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: FileHandle | undefined;
  try {
    const opened = await input.stat({ bigint: true });
    assertSourceFile(source, opened);
    if (!sameStableIdentity(before, opened)) {
      throw migrationFailure("Snapshot source file changed while opening.");
    }
    output = await open(
      target,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < Number(opened.size)) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, Number(opened.size) - offset);
      const { bytesRead } = await input.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      const { bytesWritten } = await output.write(buffer, 0, bytesRead, offset);
      if (bytesWritten !== bytesRead) {
        throw migrationFailure("Snapshot target file write was incomplete.");
      }
      offset += bytesRead;
    }
    if (offset !== Number(opened.size)) {
      throw migrationFailure("Snapshot source file changed size while reading.");
    }
    await output.sync();
    const after = await input.stat({ bigint: true });
    const current = await lstat(source, { bigint: true });
    if (!sameStableIdentity(opened, after) || !sameStableIdentity(after, current)) {
      throw migrationFailure("Snapshot source file changed while it was copied.");
    }
    return Object.freeze({ stats: after, sha256: hash.digest("hex") });
  } finally {
    await output?.close().catch(() => undefined);
    await input.close();
  }
}

async function verifyCopiedSourceFile(
  path: string,
  expected: SnapshotSourceFileEvidence,
  signal: AbortSignal,
): Promise<void> {
  const before = await lstat(path, { bigint: true });
  assertSourceFile(path, before);
  if (!sameStableIdentity(expected.stats, before)) {
    throw migrationFailure("Snapshot source file changed after it was copied.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableIdentity(before, opened)) {
      throw migrationFailure("Snapshot source file changed while it was re-opened.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < Number(opened.size)) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, Number(opened.size) - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset !== Number(opened.size) || hash.digest("hex") !== expected.sha256) {
      throw migrationFailure("Snapshot source file content changed after it was copied.");
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameStableIdentity(opened, after) || !sameStableIdentity(after, current)) {
      throw migrationFailure("Snapshot source file changed while it was rechecked.");
    }
  } finally {
    await handle.close();
  }
}

async function digestTree(root: string, signal: AbortSignal): Promise<TreeEvidence> {
  return await digestTreeInternal(root, signal);
}

async function assertAdoptionTreeCurrent(
  root: string,
  signal: AbortSignal,
  expectedSha256: string,
  bound: BoundAdoptionTree,
): Promise<void> {
  const tree = await digestTreeInternal(root, signal, bound);
  if (tree.sha256 !== expectedSha256) {
    throw migrationFailure("Adoption target tree changed after snapshot confirmation.");
  }
}

async function digestTreeInternal(
  root: string,
  signal: AbortSignal,
  bound?: BoundAdoptionTree,
): Promise<TreeEvidence> {
  const hash = createHash("sha256");
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const walk = async (relativePath: string): Promise<void> => {
    throwIfAborted(signal);
    const path = relativePath === "" ? root : join(root, relativePath);
    const stats = await lstat(path, { bigint: true });
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      assertTargetDirectory(stats);
      directories += 1;
      if (directories + files > MAX_TREE_ENTRIES) {
        throw migrationFailure("Snapshot tree exceeds the entry limit.");
      }
      hash.update(`D\0${relativePath || "."}\0${String(stats.mode & 0o777n)}\n`);
      for (const entry of (await readdir(path)).sort()) {
        const child = relativePath === "" ? entry : join(relativePath, entry);
        if (skipDigestPath(child, bound)) continue;
        await walk(child);
      }
      return;
    }
    const isBoundDatabase = bound !== undefined
      && relativePath === bound.databaseRelativePath;
    if (isBoundDatabase) {
      await assertBoundAdoptionDatabase(stats, bound.database);
    } else {
      assertTargetFile(stats);
    }
    files += 1;
    bytes += Number(stats.size);
    if (directories + files > MAX_TREE_ENTRIES || bytes > MAX_TREE_BYTES) {
      throw migrationFailure("Snapshot tree exceeds the bounded limits.");
    }
    const content = isBoundDatabase
      ? await hashPinnedFile(bound.database)
      : await hashFile(path, signal);
    hash.update(
      `F\0${relativePath}\0${String(stats.mode & 0o777n)}\0${String(stats.size)}\0${content}\n`,
    );
  };
  await walk("");
  return Object.freeze({
    sha256: hash.digest("hex"),
    files,
    directories,
    bytes,
  });
}

async function assertBoundAdoptionDatabase(
  stats: BigIntStats,
  binding: BoundSecureDatabaseFile,
): Promise<void> {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || stats.nlink !== 2n
    || (stats.mode & 0o777n) !== 0o600n
    || stats.dev.toString() !== binding.identity.device
    || stats.ino.toString() !== binding.identity.inode
    || stats.size !== BigInt(binding.identity.size)
  ) {
    throw migrationFailure("Bound adoption database identity changed.");
  }
  await binding.verify();
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const before = await lstat(path, { bigint: true });
  assertTargetFile(before);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableIdentity(before, opened)) {
      throw migrationFailure("Snapshot file changed while opening for hashing.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < Number(opened.size)) {
      if (signal !== undefined) throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, Number(opened.size) - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset !== Number(opened.size)) {
      throw migrationFailure("Snapshot file changed size while hashing.");
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameStableIdentity(opened, after) || !sameStableIdentity(after, current)) {
      throw migrationFailure("Snapshot file changed while hashing.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function openProtectedSourceRoot(path: string): Promise<ProtectedSourceRoot> {
  const before = await lstat(path);
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || before.uid !== currentUid()
    || (before.mode & 0o022) !== 0
    || await realpath(path) !== path
  ) {
    throw migrationFailure(
      "Migration source root must be canonical, user-owned, and not group/world writable.",
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== currentUid()
      || (opened.mode & 0o022) !== 0
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw migrationFailure("Migration source root changed while opening.");
    }
    return Object.freeze({ path, handle, identity: identity(opened) });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyProtectedSourceRoot(root: ProtectedSourceRoot): Promise<void> {
  const pathStats = await lstat(root.path);
  const descriptorStats = await root.handle.stat();
  if (
    !pathStats.isDirectory()
    || pathStats.isSymbolicLink()
    || pathStats.uid !== currentUid()
    || (pathStats.mode & 0o022) !== 0
    || !descriptorStats.isDirectory()
    || descriptorStats.uid !== currentUid()
    || (descriptorStats.mode & 0o022) !== 0
    || !sameFileIdentity(identity(pathStats), root.identity)
    || !sameFileIdentity(identity(descriptorStats), root.identity)
  ) {
    throw migrationFailure("Migration source root identity changed.");
  }
}

async function inspectSourceMarker(root: string): Promise<SourceMarkerEvidence> {
  const path = join(root, MEMORY_LOCAL_MARKER_FILENAME);
  if (!(await pathExists(path))) return Object.freeze({ state: "absent" });
  const marker = await readSecureFile(path, MARKER_MAX_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(marker.bytes);
  const match = /^initialized:([0-9a-f-]{36})\n$/u.exec(text);
  if (match === null || !STORE_ID.test(match[1]!)) {
    throw migrationFailure("Migration source has an unsafe permanent marker state.");
  }
  return Object.freeze({
    state: "initialized",
    storeId: match[1]!,
    sha256: createHash("sha256").update(marker.bytes).digest("hex"),
  });
}

async function createPrivateTargetRoot(
  path: string,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<SecureRoot> {
  const parent = dirname(path);
  const parentReal = await realpath(parent).catch(() => undefined);
  if (parentReal !== parent) {
    throw migrationFailure("Snapshot target parent must be an existing canonical directory.");
  }
  const parentStats = await lstat(parent);
  if (
    !parentStats.isDirectory()
    || parentStats.isSymbolicLink()
    || (parentStats.mode & 0o022) !== 0
  ) {
    throw migrationFailure("Snapshot target parent is not protected.");
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw migrationFailure("Snapshot target must not already exist.");
    }
    throw error;
  }
  let observed: BigIntStats | undefined;
  let handle: FileHandle | undefined;
  let target: SecureRoot | undefined;
  try {
    observed = await lstat(path, { bigint: true });
    assertFreshSnapshotTarget(observed);
    // Portable Node does not expose mkdir-with-fd or openat. Within this
    // owner-private migration boundary, a same-UID swap before the first
    // observation is excluded because that principal can already inspect and
    // mutate this process's private data. From this observation onward, bind
    // and recheck the exact directory identity before copying.
    await hooks.beforeSnapshotTargetOpen?.(path);
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameObservedSnapshotDirectory(observed, opened)) {
      throw migrationFailure("Snapshot target identity changed while binding its created directory.");
    }
    target = Object.freeze({
      path,
      handle,
      identity: snapshotDirectoryIdentity(opened),
    });
    await assertPinnedSnapshotDirectory(path, target.identity, target);
    return target;
  } catch (error) {
    let removed = false;
    try {
      removed = observed !== undefined
        && await removeObservedEmptySnapshotTarget(path, observed, target, hooks);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (!removed) {
      throw migrationFailure(
        "Snapshot target identity changed during creation; preserving it as unusable.",
      );
    }
    throw error;
  }
}

async function removeObservedEmptySnapshotTarget(
  path: string,
  expected: BigIntStats,
  pinned: SecureRoot | undefined,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<boolean> {
  const current = await lstat(path, { bigint: true }).catch(() => undefined);
  if (
    current === undefined
    || !sameObservedSnapshotDirectory(expected, current)
    || (await readdir(path).catch(() => ["unsafe"])).length !== 0
  ) {
    return false;
  }
  const quarantine = join(
    dirname(path),
    `.${basename(path)}.snapshot-creation-cleanup-${randomUUID()}`,
  );
  let moved = false;
  try {
    if (pinned !== undefined) {
      await assertPinnedSnapshotDirectory(path, pinned.identity, pinned);
    }
    await hooks.beforeSnapshotTargetCleanupRename?.(path);
    await rename(path, quarantine);
    moved = true;
    const movedStats = await lstat(quarantine, { bigint: true });
    if (
      !sameObservedSnapshotDirectoryObject(expected, movedStats)
      || (await readdir(quarantine)).length !== 0
    ) {
      await restoreQuarantinedSnapshotTarget(path, quarantine);
      return false;
    }
    if (pinned !== undefined) {
      try {
        await assertPinnedSnapshotDirectory(quarantine, pinned.identity, pinned);
      } catch {
        await restoreQuarantinedSnapshotTarget(path, quarantine);
        return false;
      }
    }
    await rmdir(quarantine);
    moved = false;
  } catch {
    if (moved) await restoreQuarantinedSnapshotTarget(path, quarantine);
    return false;
  }
  try {
    await hooks.beforeSnapshotTargetCleanupParentSync?.(path);
    await syncDirectory(dirname(path));
  } catch {
    throw migrationFailure(
      "Snapshot target was removed, but parent-directory durability could not be confirmed.",
    );
  }
  return true;
}

async function restoreQuarantinedSnapshotTarget(
  path: string,
  quarantine: string,
): Promise<void> {
  const occupied = await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isErrno(error, "ENOENT")) return false;
      return true;
    },
  );
  if (occupied) return;
  // Portable Node has no no-replace directory rename. This best-effort restore
  // avoids overwriting an observed pathname; the remaining same-UID race is the
  // same explicitly excluded threat boundary as target creation.
  try {
    await rename(quarantine, path);
    await syncDirectory(dirname(path));
  } catch {
    // Restored or quarantined ambiguous data remains for operator remediation.
  }
}

async function cleanupFailedSnapshotTarget(
  path: string,
  expected: FileIdentity,
  pinned: SecureRoot | undefined,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<void> {
  if (pinned === undefined) {
    throw migrationFailure(
      "Failed snapshot target identity changed; preserving it as unusable.",
    );
  }
  const quarantine = join(
    dirname(path),
    `.${basename(path)}.snapshot-cleanup-${randomUUID()}`,
  );
  try {
    await assertPinnedSnapshotDirectory(path, expected, pinned);
  } catch {
    throw migrationFailure(
      "Failed snapshot target identity changed; preserving it as unusable.",
    );
  }
  let moved = false;
  try {
    await hooks.beforeSnapshotFailureCleanupRename?.(path);
    await rename(path, quarantine);
    moved = true;
    await assertPinnedSnapshotDirectory(quarantine, expected, pinned);
    await rm(quarantine, { recursive: true });
    moved = false;
  } catch {
    if (moved) await restoreQuarantinedSnapshotTarget(path, quarantine);
    throw migrationFailure(
      "Failed snapshot target could not be safely removed and remains unusable.",
    );
  }
  try {
    await hooks.beforeSnapshotFailureCleanupParentSync?.(path);
    await syncDirectory(dirname(path));
  } catch {
    throw migrationFailure(
      "Failed snapshot target was removed, but parent-directory durability could not be confirmed.",
    );
  }
}

function assertFreshSnapshotTarget(stats: BigIntStats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw migrationFailure("Exclusively created snapshot target is not owner-private.");
  }
}

function sameObservedSnapshotDirectory(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return sameObservedSnapshotDirectoryObject(left, right)
    && left.ctimeNs === right.ctimeNs;
}

function sameObservedSnapshotDirectoryObject(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function snapshotDirectoryIdentity(stats: BigIntStats): FileIdentity {
  return Object.freeze({
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: Number(stats.mode & 0o7777n),
    links: Number(stats.nlink),
    owner: Number(stats.uid),
    size: Number(stats.size),
  });
}

async function assertPinnedSnapshotDirectory(
  path: string,
  expected: FileIdentity,
  pinned: SecureRoot,
): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  const descriptor = await pinned.handle.stat().catch(() => undefined);
  if (
    current === undefined
    || descriptor === undefined
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !descriptor.isDirectory()
    || String(current.dev) !== expected.device
    || String(current.ino) !== expected.inode
    || String(descriptor.dev) !== expected.device
    || String(descriptor.ino) !== expected.inode
    || current.uid !== expected.owner
    || descriptor.uid !== expected.owner
    || (current.mode & 0o777) !== 0o700
    || (descriptor.mode & 0o777) !== 0o700
  ) {
    throw migrationFailure("Snapshot target directory identity changed.");
  }
}

async function syncSnapshotDirectory(
  path: string,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<void> {
  await syncDirectory(path);
  await hooks.afterSnapshotDirectorySync?.(path);
}

async function createPrivateFile(path: string): Promise<void> {
  const handle = await createSecureFile(path);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertBoundedActiveDatabase(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_TREE_BYTES) {
    throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
  }
}

async function sourceDatabaseFootprint(path: string): Promise<number> {
  let bytes = 0;
  for (const suffix of ["", ...SQLITE_SIDECARS]) {
    const sidecarPath = `${path}${suffix}`;
    const stats = await lstat(sidecarPath, { bigint: true }).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (stats === undefined) continue;
    assertBoundedActiveDatabase(Number(stats.size));
    assertSourceFile(sidecarPath, stats);
    bytes += Number(stats.size);
    assertBoundedActiveDatabase(bytes);
  }
  return bytes;
}

function logicalDatabaseBytes(database: DatabaseSync): number {
  const pageCount = pragmaInteger(database, "page_count");
  const pageSize = pragmaInteger(database, "page_size");
  const bytes = pageCount * pageSize;
  if (pageCount < 1n || pageSize < 1n || bytes > BigInt(MAX_TREE_BYTES)) {
    throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
  }
  return Number(bytes);
}

function pragmaInteger(database: DatabaseSync, name: "page_count" | "page_size"): bigint {
  const row = database.prepare(`PRAGMA ${name}`).get() as
    | Record<string, number | bigint>
    | undefined;
  const value = row?.[name];
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value))
    && typeof value !== "bigint"
  ) {
    throw migrationFailure("Memory database size metadata is invalid.");
  }
  return BigInt(value);
}

async function inspectSourceFile(path: string, exactPrivate = false): Promise<FileIdentity> {
  const stats = await lstat(path);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== currentUid()
    || stats.nlink !== 1
    || (exactPrivate ? (stats.mode & 0o777) !== 0o600 : (stats.mode & 0o022) !== 0)
  ) {
    throw migrationFailure("Migration source contains an unsafe file.");
  }
  return identity(stats);
}

async function assertDistinctTarget(
  source: { readonly path: string; readonly identity: FileIdentity },
  targetPath: string,
): Promise<void> {
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing === undefined) return;
  if (
    String(existing.dev) === source.identity.device
    && String(existing.ino) === source.identity.inode
  ) {
    throw migrationFailure("Snapshot target aliases the source root.");
  }
  throw migrationFailure("Snapshot target must not already exist.");
}

async function rejectAdoptionTransients(root: string): Promise<void> {
  const paths = [
    ...TRANSIENT_V0_PATHS,
    MEMORY_LOCAL_WRITER_LEASE_FILENAME,
  ];
  for (const relativePath of paths) {
    if (await pathExists(join(root, relativePath))) {
      throw migrationFailure("Adoption target contains transient writer state.");
    }
  }
}

function skipSnapshotPath(path: string, activeDatabase: string): boolean {
  if (
    path === activeDatabase
    || path === MEMORY_LOCAL_MARKER_FILENAME
    || TRANSIENT_V0_PATHS.has(path)
    || path === MEMORY_LOCAL_WRITER_LEASE_FILENAME
  ) {
    return true;
  }
  return SQLITE_SIDECARS.some((suffix) =>
    path.endsWith(`.db${suffix}`)
    || path === `${MEMORY_LOCAL_WRITER_LEASE_FILENAME}${suffix}`);
}

function skipDigestPath(path: string, bound?: BoundAdoptionTree): boolean {
  if (
    bound !== undefined
    && (
      path === bound.bindingRelativePath
      || path === bound.authorityRelativePath
    )
  ) {
    return true;
  }
  return path === MEMORY_LOCAL_MARKER_FILENAME
    || path === MEMORY_LOCAL_WRITER_LEASE_FILENAME;
}

function assertSourceDirectory(_path: string, stats: BigIntStats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || (stats.mode & 0o022n) !== 0n
  ) {
    throw migrationFailure("Snapshot source contains an unsafe directory.");
  }
}

function assertSourceFile(_path: string, stats: BigIntStats): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || stats.nlink !== 1n
    || (stats.mode & 0o022n) !== 0n
    || stats.size > BigInt(MAX_TREE_BYTES)
  ) {
    throw migrationFailure("Snapshot source contains an unsafe file.");
  }
}

function assertTargetDirectory(stats: BigIntStats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw migrationFailure("Snapshot target contains an unsafe directory.");
  }
}

function assertTargetFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw migrationFailure("Snapshot target contains a non-regular file.");
  }
  if (stats.uid !== BigInt(currentUid())) {
    throw migrationFailure("Snapshot target contains a file owned by another user.");
  }
  if (stats.nlink !== 1n) {
    throw migrationFailure("Snapshot target contains a hard-linked file.");
  }
  if ((stats.mode & 0o777n) !== 0o600n) {
    throw migrationFailure("Snapshot target contains a file with unsafe permissions.");
  }
  if (stats.size > BigInt(MAX_TREE_BYTES)) {
    throw migrationFailure("Snapshot target contains an oversized file.");
  }
}

function assertDatabaseCoverage(
  database: MemoryLocalV0DatabaseEvidence,
  source: BujoAuditSnapshot,
): void {
  if (
    database.records !== source.recordCount
    || database.recordBytes !== source.recordBytes
    || database.ftsIndexed !== source.ftsCount
    || database.vectorsIndexed !== source.vectorCount
  ) {
    throw migrationFailure("Online database snapshot does not match source counts.");
  }
}

function assertStrictDatabase(
  snapshot: BujoAuditSnapshot,
  embedding: EmbeddingIdentity | undefined,
): void {
  const missingVectors = embedding === undefined
    ? snapshot.missingDeclaredVectorRows
    : snapshot.missingVectorRows;
  if (
    snapshot.missingFtsRows !== 0
    || snapshot.orphanFtsRows !== 0
    || snapshot.pendingCaptureCount !== 0
    || snapshot.pendingVectorCount !== 0
    || missingVectors !== 0
  ) {
    throw migrationFailure("Adoption target fails strict memory coverage.");
  }
}

function readEmbeddingIdentity(
  database: DatabaseSync,
  snapshot: BujoAuditSnapshot,
): EmbeddingIdentity | undefined {
  if (snapshot.vectorCount === 0) return undefined;
  const rows = database.prepare(`
    SELECT DISTINCT embedding_model AS model, dim AS dimensions
    FROM memories m JOIN memories_vec v ON v.rowid = m.seq
    ORDER BY embedding_model, dim
  `).all() as unknown as Array<{ model: unknown; dimensions: unknown }>;
  const row = rows.length === 1 ? rows[0] : undefined;
  const identity_ = row?.model;
  const model = typeof identity_ === "string" && identity_.startsWith("ollama:")
    ? identity_.slice("ollama:".length)
    : undefined;
  if (
    row === undefined
    || model === undefined
    || model.length === 0
    || model !== model.trim()
    || model.length > 512
    || /[\u0000-\u001f\u007f]/u.test(model)
    || !Number.isSafeInteger(row.dimensions)
    || (row.dimensions as number) !== snapshot.vectorDimension
  ) {
    throw migrationFailure("Adoption target has an unsupported vector identity.");
  }
  return Object.freeze({
    id: `ollama:${model}`,
    dimensions: row.dimensions as number,
  });
}

function requiredVectorDimension(snapshot: BujoAuditSnapshot): number {
  const dimension = snapshot.vectorDimension;
  if (dimension === undefined || !Number.isSafeInteger(dimension) || dimension < 1) {
    throw migrationFailure("Memory database has no valid vector dimension.");
  }
  return dimension;
}

class AuditOnlyEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(identity_: EmbeddingIdentity) {
    this.id = identity_.id;
    this.dimensions = identity_.dimensions;
  }

  async embed(): Promise<never> {
    throw migrationFailure("Migration audit must not call an embedding service.");
  }
}

async function writeMarkerState(
  handle: FileHandle,
  state: "initializing" | "initialized",
  storeId: string,
): Promise<void> {
  const bytes = markerBytes(state, storeId);
  const result = await handle.write(bytes, 0, bytes.byteLength, 0);
  if (result.bytesWritten !== bytes.byteLength) {
    throw migrationFailure("Permanent marker write was incomplete.");
  }
  await handle.truncate(bytes.byteLength);
  await handle.sync();
}

async function assertMarkerCurrent(
  path: string,
  expectedIdentity: FileIdentity,
  state: "initializing" | "initialized",
  storeId: string,
): Promise<void> {
  const current = await readSecureFile(path, MARKER_MAX_BYTES);
  if (!sameFileIdentity(current.identity, expectedIdentity)) {
    throw migrationFailure("Permanent marker identity changed during adoption.");
  }
  assertMarkerBytes(current.bytes, state, storeId);
}

function assertMarkerBytes(
  bytes: Uint8Array,
  state: "initializing" | "initialized",
  storeId: string,
): void {
  if (!Buffer.from(bytes).equals(markerBytes(state, storeId))) {
    throw migrationFailure("Permanent marker bytes are not canonical.");
  }
}

function markerBytes(
  state: "initializing" | "initialized",
  storeId: string,
): Buffer {
  return Buffer.from(`${state}:${storeId}\n`, "utf8");
}

function markerSummary(identity_: FileIdentity): {
  readonly device: string;
  readonly inode: string;
  readonly mode: 384;
  readonly links: 1;
} {
  if (identity_.mode !== 0o600 || identity_.links !== 1) {
    throw migrationFailure("Permanent marker does not have its required identity.");
  }
  return Object.freeze({
    device: identity_.device,
    inode: identity_.inode,
    mode: 0o600 as const,
    links: 1 as const,
  });
}

function sameRoot(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameMutableFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.links === right.links
    && left.owner === right.owner;
}

function pathsOverlap(left: string, right: string): boolean {
  return isNested(left, right) || isNested(right, left);
}

function isNested(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ""
    && path !== ".."
    && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(path);
}

function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

function sameStableDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function comparePathNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function absolutePath(value: string, field: string): string {
  const canonical = typeof value === "string" ? resolve(value) : "";
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || value.includes("\0")
    || value !== value.trim()
    || value !== canonical
  ) {
    throw migrationFailure(`${field} must be an absolute canonical path.`);
  }
  return canonical;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw migrationFailure("Memory migration requires POSIX ownership checks.");
  }
  return uid;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function migrationFailure(message: string): MemoryLocalError {
  return new MemoryLocalError("maintenance_failed", message);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { readonly code?: unknown }).code === code;
}

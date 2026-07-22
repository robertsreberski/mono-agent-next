import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import { openMemoryDb, type MemoryDb } from "../store/index.js";

import {
  assertPendingCaptureReplayAdoptionPreview,
  hasMutablePendingCaptureIntent,
  hasPendingCaptureIntent,
  previewPendingCaptureReplayAdoption,
} from "./capture-outbox.js";
import {
  acquireMemoryWriterLease,
  assertManagedManifestState,
  captureManagedManifestState,
  managedGenerationDbPath,
  readManagedIndexManifest,
  withManagedRollbackRetirement,
} from "./generations.js";
import {
  assertPendingMigrateReplayAdoptionPreview,
  hasPendingMigrateDecision,
  previewPendingMigrateReplayAdoption,
} from "./migrate.js";
import {
  composeAdoptedReplayProjection,
  cleanupReplayProjectionTemporaryArtifacts,
  emptyReplayProjection,
  assertProjectionContainsDelta,
  mergeReplayProjectionDelta,
  prepareReplayProjectionPublication,
  publishPreparedReplayProjection,
  readBujoCanonicalBaseFingerprint,
  readReplayProjectionStrict,
  replayProjectionAuthorityId,
  serializeReplayProjection,
} from "./replay-projection.js";
import { assertLegacyReplayAdoptionBaseParity } from "./rebuild.js";

export interface LegacyReplayAdoptionOptions {
  readonly root: string;
  readonly mode: "bujo";
  readonly embeddingModel: string;
  readonly dimension: number;
}

interface LegacyReplayAdoptionHooks {
  /** Test-only race seam after the complete read-only preflight. */
  readonly beforePublication?: () => void;
  /** Test-only race seam after sidecar publication and before final re-pins. */
  readonly afterPublication?: () => void;
}

export interface LegacyReplayAdoptionResult {
  readonly backend: "bujo";
  readonly mode: "bujo";
  readonly status: "adopted";
  readonly counts: {
    readonly terminals: number;
    readonly supersedes: number;
    readonly threads: number;
  };
  readonly authorityDigest: string;
  readonly rebuildRequired: true;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
}

interface SqliteFamilyEntry {
  readonly suffix: "" | "-wal" | "-shm" | "-journal";
  readonly identity?: FileIdentity;
}

/**
 * Explicitly adopt structurally valid replay-only state from one stopped BuJo
 * index, including authority still pinned by a durable capture or migration
 * protocol.
 *
 * This is a deliberate trust-on-first-use boundary: no startup or rebuild path
 * may infer historical residual authority automatically. The operator approves
 * one exact canonical base, one exact SQLite family, and any exact pending
 * protocol commitments. The resulting sidecar is published once via a
 * missing-only CAS and intentionally makes a follow-up rebuild necessary.
 */
export function adoptLegacyReplayProjection(
  options: LegacyReplayAdoptionOptions,
): LegacyReplayAdoptionResult {
  return adoptLegacyReplayProjectionWithHooks(options);
}

/** Internal race-test seam; intentionally not re-exported from the package subpath. */
export function adoptLegacyReplayProjectionWithHooks(
  options: LegacyReplayAdoptionOptions,
  hooks: LegacyReplayAdoptionHooks = {},
): LegacyReplayAdoptionResult {
  if (options.mode !== "bujo") {
    throw new Error("memory-replay-adoption: explicit adoption is available only for BuJo memory.");
  }

  const lease = acquireMemoryWriterLease(options.root);
  let db: MemoryDb | undefined;
  let sqliteFence: Database | undefined;
  try {
    const root = lease.root;
    cleanupReplayProjectionTemporaryArtifacts(root);
    const captureQueued = hasPendingCaptureIntent(root);
    const capturePending = hasMutablePendingCaptureIntent(root);
    const migrationPending = hasPendingMigrateDecision(root);
    if (capturePending && migrationPending) {
      throw new Error("memory-replay-adoption: capture and migration protocols are both pending.");
    }
    const manifestState = captureManagedManifestState(root);
    const manifest = readManagedIndexManifest(root);
    if (manifest !== undefined && manifest.active.tier !== "bujo") {
      throw new Error("memory-replay-adoption: managed active generation is not BuJo.");
    }
    if (options.embeddingModel.length === 0 || !Number.isInteger(options.dimension) || options.dimension <= 0
      || (manifest !== undefined && (manifest.active.embeddingModel !== options.embeddingModel
        || manifest.active.dimension !== options.dimension))) {
      throw new Error(
        "memory-replay-adoption: configured semantic identity does not match the stopped BuJo index.",
      );
    }
    if (readReplayProjectionStrict(root).state.kind !== "missing") {
      throw new Error("memory-replay-adoption: replay projection sidecar already exists; refusing to overwrite it.");
    }

    const dbPath = manifest === undefined
      ? join(root, "memory.db")
      : managedGenerationDbPath(root, manifest.active.name, true);
    if (!existsSync(dbPath)) {
      throw new Error("memory-replay-adoption: a stopped BuJo memory database is required.");
    }
    const sqliteFamilyBefore = captureSqliteFamily(dbPath);
    const dbIdentity = fileIdentity(dbPath);
    sqliteFence = acquireSqliteWriterFence(dbPath);
    assertFileIdentity(dbPath, dbIdentity);
    db = openMemoryDb({
      path: dbPath,
      readOnly: true,
      dim: options.dimension,
      embeddings: {
        id: options.embeddingModel,
        embed: async () => {
          throw new Error("memory-replay-adoption: read-only preview must not call an embedding provider.");
        },
      },
    });
    assertFileIdentity(dbPath, dbIdentity);
    const sqliteFamily = captureSqliteFamily(dbPath);
    assertSqliteFamilyTransition(sqliteFamilyBefore, sqliteFamily);
    if (manifest === undefined) assertUnmanagedSemanticIdentity(db, options);

    const capturePreview = captureQueued ? previewPendingCaptureReplayAdoption(root, db) : undefined;
    const migrationPreview = migrationPending ? previewPendingMigrateReplayAdoption(root, db) : undefined;
    if (captureQueued && capturePreview === undefined) {
      throw new Error("memory-replay-adoption: pending capture disappeared during preflight.");
    }
    if (migrationPending && migrationPreview === undefined) {
      throw new Error("memory-replay-adoption: pending migration disappeared during preflight.");
    }
    let pendingProjection = emptyReplayProjection();
    if (capturePreview !== undefined) {
      pendingProjection = mergeReplayProjectionDelta(pendingProjection, {
        terminals: capturePreview.projection.terminals,
        supersedes: capturePreview.projection.supersedes,
        threads: capturePreview.projection.threads,
      });
    }
    if (migrationPreview !== undefined) {
      pendingProjection = mergeReplayProjectionDelta(pendingProjection, {
        terminals: migrationPreview.projection.terminals,
        supersedes: migrationPreview.projection.supersedes,
        threads: migrationPreview.projection.threads,
      });
    }
    const pendingMemoryIds = [
      ...(capturePreview?.pendingMemoryIds ?? []),
      ...(migrationPreview?.pendingMemoryIds ?? []),
    ];
    const pendingGraphEntityIds = [
      ...(capturePreview?.graphEntityIds ?? []),
      ...(migrationPreview?.graphEntityIds ?? []),
    ];
    const pendingGraphRelationKeys = capturePreview?.graphRelationKeys ?? [];
    const pendingGraphAssociationKeys = [
      ...(capturePreview?.graphAssociationKeys ?? []),
      ...(migrationPreview?.graphAssociationKeys ?? []),
    ];
    const base = assertLegacyReplayAdoptionBaseParity(root, db, {
      pendingMemoryIds,
      pendingGraphEntityIds,
      pendingGraphRelationKeys,
      pendingGraphAssociationKeys,
    });
    const logicalIntegrityDigest = db.logicalIntegrityDigest();
    const authorityDigest = replayProjectionAuthorityId({
      schemaVersion: 1,
      kind: "legacy-adoption",
      sourceFingerprint: base.sourceFingerprint,
      logicalIntegrityDigest,
      pendingCaptureCommitment: capturePreview?.commitment ?? null,
      pendingMigrationCommitment: migrationPreview?.commitment ?? null,
    });
    const projection = composeAdoptedReplayProjection(db, {
      projection: pendingProjection,
      ownedThreadSources: capturePreview?.ownedThreadSources ?? [],
      ownedLifecycleSources: [
        ...(capturePreview?.ownedLifecycleSources ?? []),
        ...(migrationPreview?.ownedLifecycleSources ?? []),
      ],
      legacyThreadTimestampKeys: capturePreview?.legacyThreadTimestampKeys ?? [],
    }, authorityDigest);
    if (capturePreview !== undefined) {
      assertProjectionContainsDelta(projection, {
        terminals: capturePreview.mustPresentProjection.terminals,
        supersedes: capturePreview.mustPresentProjection.supersedes,
        threads: capturePreview.mustPresentProjection.threads,
      });
    }
    if (!captureQueued && !migrationPending
      && projection.terminals.length + projection.supersedes.length + projection.threads.length === 0) {
      throw new Error(
        "memory-replay-adoption: active database has no legacy replay state; use safe rebuild for an empty projection.",
      );
    }
    const prepared = prepareReplayProjectionPublication(root, projection, { requireMissing: true });

    hooks.beforePublication?.();
    if (capturePreview !== undefined) {
      assertPendingCaptureReplayAdoptionPreview(root, db, capturePreview.commitment);
    } else if (hasPendingCaptureIntent(root)) {
      throw new Error("memory-replay-adoption: capture protocol appeared before publication.");
    }
    if (migrationPreview !== undefined) {
      assertPendingMigrateReplayAdoptionPreview(root, db, migrationPreview.commitment);
    } else if (hasPendingMigrateDecision(root)) {
      throw new Error("memory-replay-adoption: migration protocol appeared before publication.");
    }
    assertManagedManifestState(root, manifestState);
    assertFileIdentity(dbPath, dbIdentity);
    assertSqliteFamily(dbPath, sqliteFamily);
    if (readBujoCanonicalBaseFingerprint(root) !== base.sourceFingerprint) {
      throw new Error("memory-replay-adoption: canonical base changed before publication.");
    }
    if (db.logicalIntegrityDigest() !== logicalIntegrityDigest) {
      throw new Error("memory-replay-adoption: active database changed before publication.");
    }
    const reprojection = composeAdoptedReplayProjection(db, {
      projection: pendingProjection,
      ownedThreadSources: capturePreview?.ownedThreadSources ?? [],
      ownedLifecycleSources: [
        ...(capturePreview?.ownedLifecycleSources ?? []),
        ...(migrationPreview?.ownedLifecycleSources ?? []),
      ],
      legacyThreadTimestampKeys: capturePreview?.legacyThreadTimestampKeys ?? [],
    }, authorityDigest);
    if (capturePreview !== undefined) {
      assertProjectionContainsDelta(reprojection, {
        terminals: capturePreview.mustPresentProjection.terminals,
        supersedes: capturePreview.mustPresentProjection.supersedes,
        threads: capturePreview.mustPresentProjection.threads,
      });
    }
    if (serializeReplayProjection(reprojection) !== serializeReplayProjection(projection)) {
      throw new Error("memory-replay-adoption: replay partition changed before publication.");
    }

    const published = withManagedRollbackRetirement(root, "replay", () => (
      publishPreparedReplayProjection(root, prepared)
    ));
    hooks.afterPublication?.();

    // The writer lease excludes legitimate index publishers. These final
    // checks additionally catch an out-of-band path replacement or SQLite
    // writer in the narrow synchronous publication window.
    const manifestAfter = readManagedIndexManifest(root);
    const expectedManifest = expectedManifestAfterReplayPublication(manifest);
    if (JSON.stringify(manifestAfter) !== JSON.stringify(expectedManifest)) {
      throw new Error("memory-replay-adoption: managed identity changed unexpectedly during publication.");
    }
    assertFileIdentity(dbPath, dbIdentity);
    assertSqliteFamily(dbPath, sqliteFamily);
    if (db.logicalIntegrityDigest() !== logicalIntegrityDigest) {
      throw new Error("memory-replay-adoption: active database changed during publication.");
    }
    if (serializeReplayProjection(published.projection) !== serializeReplayProjection(projection)) {
      throw new Error("memory-replay-adoption: published replay authority changed during publication.");
    }
    if (readBujoCanonicalBaseFingerprint(root) !== base.sourceFingerprint) {
      throw new Error("memory-replay-adoption: canonical base changed during publication.");
    }
    if (capturePreview !== undefined) {
      assertPendingCaptureReplayAdoptionPreview(root, db, capturePreview.commitment);
    } else if (hasPendingCaptureIntent(root)) {
      throw new Error("memory-replay-adoption: capture protocol appeared during publication.");
    }
    if (migrationPreview !== undefined) {
      assertPendingMigrateReplayAdoptionPreview(root, db, migrationPreview.commitment);
    } else if (hasPendingMigrateDecision(root)) {
      throw new Error("memory-replay-adoption: migration protocol appeared during publication.");
    }

    return {
      backend: "bujo",
      mode: "bujo",
      status: "adopted",
      counts: {
        terminals: projection.terminals.length,
        supersedes: projection.supersedes.length,
        threads: projection.threads.length,
      },
      authorityDigest,
      rebuildRequired: true,
    };
  } finally {
    try {
      db?.close();
    } finally {
      try {
        if (sqliteFence?.inTransaction === true) sqliteFence.exec("ROLLBACK");
      } finally {
        try {
          sqliteFence?.close();
        } finally {
          lease.release();
        }
      }
    }
  }
}

function assertUnmanagedSemanticIdentity(
  db: MemoryDb,
  options: LegacyReplayAdoptionOptions,
): void {
  if (db.integrityCheck().toLowerCase() !== "ok" || db.vectorDimension() !== options.dimension) {
    throw new Error("memory-replay-adoption: unmanaged SQLite identity does not match configured BuJo.");
  }
  const metadata = db.indexMetadata();
  if (metadata !== undefined && (metadata.tier !== "bujo"
    || metadata.embeddingModel !== options.embeddingModel
    || metadata.dimension !== options.dimension)) {
    throw new Error("memory-replay-adoption: unmanaged index metadata does not match configured BuJo.");
  }
  const state = db.validationSnapshot();
  if (state.vectors !== state.memories || state.vectorOrphans !== 0 || state.vectorIdentityMissing !== 0
    || state.embeddingModels.length !== 1 || state.embeddingModels[0] !== options.embeddingModel
    || state.embeddingDimensions.length !== 1 || state.embeddingDimensions[0] !== options.dimension) {
    throw new Error("memory-replay-adoption: unmanaged vector identity does not match configured BuJo.");
  }
}

function expectedManifestAfterReplayPublication(
  manifest: ReturnType<typeof readManagedIndexManifest>,
): ReturnType<typeof readManagedIndexManifest> {
  if (manifest?.rollback?.tier !== "bujo") return manifest;
  return { schemaVersion: manifest.schemaVersion, active: manifest.active };
}

function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("memory-replay-adoption: active database is not a pinned regular file.");
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function assertFileIdentity(path: string, expected: FileIdentity): void {
  const actual = fileIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs
    || actual.ctimeMs !== expected.ctimeMs || actual.mode !== expected.mode
    || actual.nlink !== expected.nlink || actual.uid !== expected.uid) {
    throw new Error("memory-replay-adoption: active database was replaced concurrently.");
  }
}

function captureSqliteFamily(path: string): readonly SqliteFamilyEntry[] {
  return (["", "-wal", "-shm", "-journal"] as const).map((suffix) => {
    const candidate = `${path}${suffix}`;
    let identity: FileIdentity | undefined;
    try {
      identity = fileIdentity(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (identity !== undefined && ((identity.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && identity.uid !== process.getuid()))) {
      throw new Error("memory-replay-adoption: SQLite family must be owner-only mode 0600.");
    }
    if (suffix === "" && identity === undefined) {
      throw new Error("memory-replay-adoption: memory database is missing.");
    }
    return { suffix, ...(identity === undefined ? {} : { identity }) };
  });
}

function assertSqliteFamilyTransition(
  before: readonly SqliteFamilyEntry[],
  after: readonly SqliteFamilyEntry[],
): void {
  for (const [index, entry] of before.entries()) {
    const current = after[index];
    if (current === undefined || current.suffix !== entry.suffix) {
      throw new Error("memory-replay-adoption: SQLite family inventory changed unexpectedly.");
    }
    if (entry.identity !== undefined) {
      if (current.identity === undefined
        || current.identity.dev !== entry.identity.dev || current.identity.ino !== entry.identity.ino
        || current.identity.mode !== entry.identity.mode || current.identity.nlink !== entry.identity.nlink
        || current.identity.uid !== entry.identity.uid) {
        throw new Error("memory-replay-adoption: SQLite family changed while acquiring its writer fence.");
      }
    }
  }
}

function assertSqliteFamily(path: string, expected: readonly SqliteFamilyEntry[]): void {
  const actual = captureSqliteFamily(path);
  if (actual.length !== expected.length || actual.some((entry, index) => {
    const prior = expected[index];
    return prior === undefined || entry.suffix !== prior.suffix
      || (entry.identity === undefined) !== (prior.identity === undefined)
      || (entry.identity !== undefined && prior.identity !== undefined
        && !sameFileIdentity(entry.identity, prior.identity));
  })) {
    throw new Error("memory-replay-adoption: SQLite family changed during authority publication.");
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid;
}

function acquireSqliteWriterFence(path: string): Database {
  const fence = new BetterSqlite3(path, { fileMustExist: true });
  try {
    fence.pragma("busy_timeout = 0");
    fence.exec("BEGIN IMMEDIATE");
    return fence;
  } catch {
    fence.close();
    throw new Error(
      "memory-replay-adoption: an active SQLite writer owns the managed database; stop it and retry.",
    );
  }
}

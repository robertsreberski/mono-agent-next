import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { DEFAULT_VEC_DIM, openMemoryDb } from "../store/index.js";
import type {
  EntityRecord,
  MemoryDb,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../store/index.js";
import type { EmbeddingProvider } from "../search/index.js";

import { normalizedContentHash } from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import {
  emptyCanonicalGraphProjection,
  isLegacyHostObservation,
  parseCanonicalGraphStrict,
  projectCanonicalGraph,
  readGraph,
  type CanonicalGraphProjection,
} from "./graph.js";
import {
  assertNoPendingCaptureIntent,
  hasPendingCaptureIntent,
  hasMutablePendingCaptureIntent,
  listRetainedCaptureIntentKeys,
  replayCaptureOutbox,
} from "./capture-outbox.js";
import {
  assertNoPendingMigrateDecision,
  hasPendingMigrateDecision,
  recoverPendingMigrateDecisionWithMetadata,
} from "./migrate.js";
import {
  CanonicalFileRetiredError,
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
} from "./path-safety.js";
import {
  REPLAY_PROJECTION_FILE,
  assertReplayProjectionMatchesDb,
  cleanupReplayProjectionTemporaryArtifacts,
  emptyReplayProjection,
  initializeReplayProjection,
  legacyReplayProjectionFromDb,
  parseReplayProjectionStrict,
  readBujoCanonicalSourceFingerprint,
  readReplayProjectionStrict,
  replayProjectionDbReplacement,
  replayProjectionDbSnapshot,
  type ReplayProjectionV1,
} from "./replay-projection.js";
import type { BujoTier, Bullet } from "./types.js";
import {
  CANONICAL_VISIBLE_BULLET,
  assertStrictBulletRaw,
  isLegacySourceRecord,
  isMissingOnlyIdentity,
} from "./rebuild-source-validation.js";
import {
  acquireSqliteWriterFences,
  assertNoActiveSqliteWriter,
  backupRawSqlite,
} from "./rebuild-sqlite-safety.js";
import type { SqliteWriterFence } from "./rebuild-sqlite-safety.js";
import {
  MANAGED_INDEX_SCHEMA_VERSION,
  MEMORY_REBUILD_POLICY_VERSION,
  acquireMemoryWriterLease,
  acquireMemoryWriterLeaseForMaintenance,
  activateManagedIndex,
  assertManagedLayoutState,
  assertManagedManifestState,
  assertSafeRegularFile,
  captureManagedLayoutState,
  captureManagedManifestState,
  createManagedGeneration,
  fsyncDirectory,
  managedGenerationDbPath,
  readManagedIndexManifest,
  withManagedRollbackRetirement,
  type ManagedGeneration,
  type ManagedIndexManifest,
  type ManagedManifestState,
} from "./generations.js";

/**
 * Rebuild the SQLite index from canonical markdown. No LLM — re-embeds via the db's provider.
 *
 * This low-level utility mutates a caller-owned `MemoryDb` in place; it does not create, validate,
 * activate, or retain managed generations. Product callers should use {@link safeRebuildMemoryIndex}.
 *
 * After indexing memory bullets, reads `graph.jsonl` and mirrors entities/relations into the db.
 * Legacy memory↔entity `about` edges are retired. They are not canonical source
 * data, no built-in production path emits them in v1, and rebuild does not recreate them.
 *
 * @see safeRebuildMemoryIndex for the supported managed-generation rebuild path.
 */
export async function rebuildFromMarkdown(root: string, db: MemoryDb): Promise<{ indexed: number }> {
  const files = listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  });
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const snapshot = readCanonicalFileSnapshot(root, `daily/${file}`);
    if (snapshot === undefined) throw new Error(`memory-rebuild: canonical source daily/${file} disappeared.`);
    const parsed = parseDailyFile(snapshot.content);
    // Use the real 1-based file line number (not the bullet ordinal) so source.line points at the
    // actual markdown line for provenance / jump-to-source.
    parsed.lines.forEach((line) => {
      if (line.bullet !== undefined) {
        records.push(toRecord(line.bullet, `daily/${file}`, line.lineNumber));
      }
    });
  }
  const result = await db.rebuild(records);

  // Ingest entity graph — db.rebuild already wiped the entity tables, so start fresh.
  // No LLM: graph.jsonl is the canonical source written by captureTurn.
  const g = readGraph(root);
  for (const entity of g.entities) {
    try {
      db.mirrorCanonicalEntity(entity);
    } catch {
      // Per-item isolation: a single corrupt entity must not abort the rebuild
    }
  }
  for (const relation of g.relations) {
    try {
      db.mirrorCanonicalRelation(relation);
    } catch {
      // Per-item isolation
    }
  }
  for (const association of g.associations) {
    try {
      db.mirrorCanonicalAssociation(association);
    } catch {
      // Candidate validation reports orphan endpoints; a malformed canonical
      // association does not prevent preservation of the remaining source.
    }
  }

  return result;
}

function toRecord(bullet: Bullet, file: string, line: number): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    ...(bullet.dueAt !== undefined ? { dueAt: bullet.dueAt } : {}),
    tags: [],
    source: { file, line },
  };
}

export interface SafeMemoryRebuildHooks {
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterCandidateBuilt?: () => void | Promise<void>;
  readonly afterCandidateClosed?: () => void | Promise<void>;
  readonly afterCandidateValidated?: () => void | Promise<void>;
  readonly beforeSourceCas?: () => void | Promise<void>;
  /** Test-only race seam while the prior active BEGIN IMMEDIATE fence is held. */
  readonly beforeReplayProjectionInitialization?: () => void;
  readonly afterManifestTempFsync?: () => void | Promise<void>;
  readonly afterManifestRename?: () => void | Promise<void>;
  readonly afterManifestDirFsync?: () => void | Promise<void>;
}

export interface SafeMemoryIndexOptions {
  readonly root: string;
  readonly tier: BujoTier;
  readonly embeddings?: EmbeddingProvider;
  readonly dim?: number;
  readonly hooks?: SafeMemoryRebuildHooks;
}

export interface SafeMemoryIndexResult {
  readonly active: string;
  readonly rollback?: string;
  readonly indexed: number;
  readonly sourceFingerprint: string;
  readonly generation: string;
  readonly skippedRawRecords: number;
  readonly skippedUnstructuredRecords: number;
  readonly skippedMissingIdentityRecords: number;
  readonly missingIdentityLocations: readonly string[];
  readonly skippedLegacySourceRecords: number;
  readonly legacySourceLocations: readonly string[];
  readonly skippedJournalDuplicateRecords: number;
  readonly parsedSourceItems: number;
  readonly derivedLegacyAssociations: number;
}

interface SourceFileSnapshot {
  readonly relativePath: string;
  readonly bytes: Buffer;
}

interface SourceSnapshot {
  readonly fingerprint: string;
  readonly daily: readonly SourceFileSnapshot[];
  readonly graph?: SourceFileSnapshot;
  readonly replay?: SourceFileSnapshot;
}

interface BuildPlan {
  readonly records: readonly MemoryRecord[];
  readonly contentHashes: ReadonlyMap<string, string>;
  readonly graph: CanonicalGraphProjection;
  readonly replay: ReplayProjectionV1;
  readonly skippedRawRecords: number;
  readonly skippedUnstructuredRecords: number;
  readonly skippedMissingIdentityRecords: number;
  readonly missingIdentityLocations: readonly string[];
  readonly skippedLegacySourceRecords: number;
  readonly legacySourceLocations: readonly string[];
  readonly skippedJournalDuplicateRecords: number;
  readonly parsedSourceItems: number;
}

/** Content-free handle to the exact graph projection a safe rebuild would write. */
export interface CanonicalGraphAuditSourceSnapshot {
  readonly fingerprint: string;
  readonly graph: CanonicalGraphProjection;
}

/** Read the same identity-stable canonical daily+graph projection used by safe rebuild. */
export function readCanonicalGraphAuditSourceSnapshot(
  root: string,
  tier: BujoTier,
): CanonicalGraphAuditSourceSnapshot {
  if (tier !== "bujo") {
    return { fingerprint: `ignored:${tier}`, graph: emptyCanonicalGraphProjection() };
  }
  const snapshot = snapshotCanonicalSources(root, tier);
  // This surface audits only graph projection. Replay absence is independently
  // owned by strict index health and must not turn an otherwise exact graph
  // comparison into a graph parse failure.
  return { fingerprint: snapshot.fingerprint, graph: buildPlan(snapshot, tier, emptyReplayProjection()).graph };
}

/**
 * Prove the canonical base beneath a legacy replay projection without writing.
 *
 * This is deliberately narrower than normal health: it is available only
 * while the replay sidecar is absent, validates every non-replay payload
 * exactly, and admits replay-only lifecycle/edges only through the core's
 * structural legacy extractor. The adoption command may then bind that exact
 * projection to an explicit operator-approved authority.
 */
export function assertLegacyReplayAdoptionBaseParity(
  root: string,
  db: MemoryDb,
  options: {
    readonly pendingMemoryIds?: readonly string[];
    readonly pendingGraphEntityIds?: readonly string[];
    readonly pendingGraphRelationKeys?: readonly string[];
    readonly pendingGraphAssociationKeys?: readonly string[];
  } = {},
): { readonly sourceFingerprint: string } {
  if (readReplayProjectionStrict(root).state.kind !== "missing") {
    throw new Error("memory-rebuild: replay projection adoption requires the canonical sidecar to be absent.");
  }
  const before = snapshotCanonicalSources(root, "bujo");
  const parityError = db.withAuditSnapshot(() => {
    const legacy = legacyReplayProjectionFromDb(db, "0".repeat(64));
    const plan = buildPlan(before, "bujo", legacy);
    return buildPlanParityError(db, "bujo", plan, {
      allowCanonicalGraphProjectionRepair: true,
      omitMutableLiveState: true,
      pendingMemoryIds: new Set(options.pendingMemoryIds ?? []),
      pendingGraphEntityIds: new Set(options.pendingGraphEntityIds ?? []),
      pendingGraphRelationKeys: new Set(options.pendingGraphRelationKeys ?? []),
      pendingGraphAssociationKeys: new Set(options.pendingGraphAssociationKeys ?? []),
    });
  });
  if (parityError !== undefined) {
    throw new Error(
      `memory-rebuild: legacy replay adoption base parity failed: ${parityError.replace(/^memory-rebuild: /u, "")}`,
    );
  }
  const after = snapshotCanonicalSources(root, "bujo");
  if (after.fingerprint !== before.fingerprint) {
    throw new Error("memory-rebuild: canonical source changed during legacy replay adoption preflight.");
  }
  return { sourceFingerprint: before.fingerprint };
}

/**
 * Required pre/post guard for total graph replacement in a live BuJo index.
 * It proves only the complete canonical memory/FTS/vector/replay base; graph
 * rows and the derived collection cache are intentionally allowed to lag.
 */
export function assertCanonicalGraphRepairBaseParity(root: string, db: MemoryDb): void {
  assertCanonicalGraphRepairBaseParityForTier(root, db, "bujo");
}

/** Cross-tier recovery variant used only while safe rebuild still owns the stopped prior index. */
export function assertCanonicalGraphRepairBaseParityForTier(
  root: string,
  db: MemoryDb,
  currentTier: BujoTier,
): void {
  const before = snapshotCanonicalSources(root, "bujo");
  const plan = buildPlan(before, "bujo");
  const parityError = db.withAuditSnapshot(() => buildPlanCanonicalMemoryParityError(
    db,
    currentTier,
    plan,
    { omitMutableLiveState: true, omitDerivedCollection: true },
  ));
  if (parityError !== undefined) throw new Error(parityError);
  const after = snapshotCanonicalSources(root, "bujo");
  if (after.fingerprint !== before.fingerprint) {
    throw new Error("memory-rebuild: canonical source changed during graph-repair base parity.");
  }
}

export type CanonicalIndexHealthStatus = "match" | "mismatch" | "in_progress" | "invalid";

/** Content-free result from the same canonical plan/parity rules used by rebuild. */
export interface CanonicalIndexHealthAudit {
  readonly status: CanonicalIndexHealthStatus;
}

/**
 * Compare canonical Markdown/graph state to an already-open provider-free DB.
 *
 * The caller holds MemoryDb.withAuditSnapshot so every SQLite query observes
 * one WAL-visible point in time. Canonical sources are fingerprinted on both
 * sides and retried to avoid reporting a source rewrite as stable divergence.
 */
export function auditCanonicalIndexHealth(
  root: string,
  tier: BujoTier,
  db: MemoryDb,
): CanonicalIndexHealthAudit {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const mutationBefore = inspectCanonicalIndexMutation(root);
    if (mutationBefore === "invalid") return { status: "invalid" };
    if (mutationBefore === "pending") return { status: "in_progress" };
    if (mutationBefore === "changed") {
      if (attempt < maxAttempts) continue;
      return { status: "in_progress" };
    }

    let before: SourceSnapshot;
    let plan: BuildPlan;
    try {
      before = snapshotCanonicalSources(root, tier);
      plan = buildPlan(before, tier);
    } catch (error) {
      const mutation = inspectCanonicalIndexMutation(root);
      if (mutation === "invalid") return { status: "invalid" };
      if (mutation === "pending") return { status: "in_progress" };
      if ((mutation === "changed" || error instanceof CanonicalFileRetiredError) && attempt < maxAttempts) continue;
      if (mutation === "changed" || error instanceof CanonicalFileRetiredError) return { status: "in_progress" };
      return { status: "invalid" };
    }

    const parityError = buildPlanParityError(db, tier, plan, {
      // Replay-owned lifecycle and edges are canonical in the bounded sidecar;
      // only transient source provenance remains repairable at runtime.
      // Live append records may carry a session instead of a line until a
      // restart/rebuild repairs provenance. Existing explicit line numbers
      // still have to match the canonical source exactly.
      allowReplaySourceRepair: true,
      allowJournalVectorBacklog: true,
      omitMutableLiveState: true,
    });

    let after: SourceSnapshot;
    try {
      after = snapshotCanonicalSources(root, tier);
    } catch (error) {
      const mutation = inspectCanonicalIndexMutation(root);
      if (mutation === "invalid") return { status: "invalid" };
      if (mutation === "pending") return { status: "in_progress" };
      if ((mutation === "changed" || error instanceof CanonicalFileRetiredError) && attempt < maxAttempts) continue;
      if (mutation === "changed" || error instanceof CanonicalFileRetiredError) return { status: "in_progress" };
      return { status: "invalid" };
    }

    const mutationAfter = inspectCanonicalIndexMutation(root);
    if (mutationAfter === "invalid") return { status: "invalid" };
    if (mutationAfter === "pending") return { status: "in_progress" };
    if (mutationAfter === "changed") {
      if (attempt < maxAttempts) continue;
      return { status: "in_progress" };
    }
    if (before.fingerprint !== after.fingerprint) {
      if (attempt < maxAttempts) continue;
      return { status: "in_progress" };
    }
    return { status: parityError === undefined ? "match" : "mismatch" };
  }
  return { status: "in_progress" };
}

function inspectCanonicalIndexMutation(root: string): "clear" | "pending" | "changed" | "invalid" {
  try {
    return hasPendingCaptureIntent(root) || hasPendingMigrateDecision(root) ? "pending" : "clear";
  } catch (error) {
    if (error instanceof CanonicalFileRetiredError) return "changed";
    return "invalid";
  }
}

/**
 * Build and validate a new generation beside the active index, then atomically switch one manifest.
 * This path never accepts an LLM and never reads BuJo audit files.
 */
export async function safeRebuildMemoryIndex(options: SafeMemoryIndexOptions): Promise<SafeMemoryIndexResult> {
  assertSafeRebuildOptions(options);
  return await safeRebuildMemoryIndexWithLease(options, acquireMemoryWriterLease(options.root));
}

/** Internal stopped-store path; the caller owns the durable sibling transaction marker. */
export async function safeRebuildMemoryIndexForMaintenance(
  options: SafeMemoryIndexOptions,
): Promise<SafeMemoryIndexResult> {
  assertSafeRebuildOptions(options);
  return await safeRebuildMemoryIndexWithLease(options, acquireMemoryWriterLeaseForMaintenance(options.root));
}

async function safeRebuildMemoryIndexWithLease(
  options: SafeMemoryIndexOptions,
  lease: ReturnType<typeof acquireMemoryWriterLease>,
): Promise<SafeMemoryIndexResult> {
  let sourceFence: SqliteWriterFence | undefined;
  let candidateName: string | undefined;
  let activated = false;
  try {
    const root = lease.root;
    cleanupReplayProjectionTemporaryArtifacts(root);
    const rootIdentity = identityOf(root);
    const layoutState = captureManagedLayoutState(root);
    let manifestState = captureManagedManifestState(root);
    const priorManifest = readManagedIndexManifest(root);
    assertManagedManifestState(root, manifestState);
    const priorActivePath = activeDbPathFromManifest(root, priorManifest);
    const hasPriorActiveDb = existsSync(priorActivePath);
    const priorGraphRepairGuard = (guardRoot: string, guardDb: MemoryDb): void => {
      assertCanonicalGraphRepairBaseParityForTier(
        guardRoot,
        guardDb,
        priorManifest?.active.tier ?? (hasPriorActiveDb ? "bujo" : options.tier),
      );
    };
    assertNoActiveSqliteWriter(priorActivePath);
    const captureQueued = hasPendingCaptureIntent(root);
    const capturePending = hasMutablePendingCaptureIntent(root);
    const migrationPending = hasPendingMigrateDecision(root);
    if (capturePending && migrationPending) {
      throw new Error(
        "memory-rebuild: capture and migration protocols are both pending; refusing ambiguous recovery.",
      );
    }
    // A completed-turn intent remains deliberately pending after its canonical
    // and current-index outcome commits, until the owning intake receipt is
    // durable. BuJo rebuilds can safely re-embed that canonical outcome under a
    // new provider identity, but Journal remaps canonical ids to J-<hash> and a
    // non-BuJo startup would otherwise replay the retained C-... action/vector
    // beside that row (or fail on the old vector dimension). Refuse before the
    // prior intent can mutate canonical source under an incompatible tier.
    if (options.tier !== "bujo" && listRetainedCaptureIntentKeys(root).length > 0) {
      throw new Error(
        "memory-rebuild: a retained completed-turn capture intent requires BuJo; "
        + `finish its durable intake before rebuilding into ${options.tier}.`,
      );
    }
    let stagedCaptureForCandidate = false;
    const recoverCaptureQueue = (): void => {
      assertManagedManifestState(root, manifestState);
      if (hasPriorActiveDb) {
        // A current index gives the durable action its original provider and
        // lifecycle identity. Validate it before any source write, finish the
        // transaction there, and retire it before the rebuild snapshot.
        validateCurrentReplayDb(priorActivePath, priorManifest?.active);
        const priorReplay = openCurrentReplayDb(priorActivePath, priorManifest);
        try {
          replayCaptureOutbox(root, priorReplay, {
            canonicalGraphRepairGuard: priorGraphRepairGuard,
          });
          priorReplay.checkpoint();
        } finally {
          priorReplay.close();
        }
        fsyncFile(priorActivePath);
      } else {
        if (options.tier !== "bujo") {
          throw new Error(
            `memory-rebuild: pending capture without an active index can only recover into BuJo, not ${options.tier}.`,
          );
        }
        // With no index, stage only rebuildable BuJo source. The candidate
        // completes and retires the intent before manifest activation.
        replayCaptureOutbox(root, undefined, { retainIntent: true });
        stagedCaptureForCandidate = true;
      }
      const postReplayManifestState = captureManagedManifestState(root);
      if (!sameManagedManifestState(postReplayManifestState, manifestState)) {
        // Canonical replay is one of the normal source mutation boundaries. If
        // an advertised rollback existed, replay atomically retired it before
        // committing the source. Accept only that exact owned manifest change;
        // every active-descriptor or unexpected rollback change remains a CAS
        // failure even though this process holds the configured writer lease.
        const currentManifest = readManagedIndexManifest(root);
        const expectedRetirement = priorManifest?.rollback === undefined
          ? undefined
          : {
              schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
              active: priorManifest.active,
            } satisfies ManagedIndexManifest;
        if (expectedRetirement === undefined
          || JSON.stringify(currentManifest) !== JSON.stringify(expectedRetirement)) {
          throw new Error("memory-rebuild: managed index manifest changed unexpectedly during capture recovery.");
        }
        manifestState = postReplayManifestState;
      }
      assertManagedManifestState(root, manifestState);
    };
    if (captureQueued && !migrationPending) recoverCaptureQueue();
    if (migrationPending) {
      if (!hasPriorActiveDb) {
        throw new Error("memory-rebuild: pending migration recovery requires its pinned current database.");
      }
      if (readReplayProjectionStrict(root).state.kind === "missing") {
        throw new Error(
          `memory-rebuild: ${REPLAY_PROJECTION_FILE} is missing while migration is pending; `
          + "run explicit stopped-store replay projection adoption first.",
        );
      }
      assertManagedManifestState(root, manifestState);
      validateCurrentReplayDb(priorActivePath, priorManifest?.active);
      const priorReplay = openCurrentReplayDb(priorActivePath, priorManifest);
      try {
        if (recoverPendingMigrateDecisionWithMetadata(
          root,
          priorReplay,
          priorGraphRepairGuard,
        ) === undefined) {
          throw new Error("memory-rebuild: pending migration disappeared during provider-free recovery.");
        }
        priorReplay.checkpoint();
      } finally {
        priorReplay.close();
      }
      fsyncFile(priorActivePath);
      const postRecoveryManifestState = captureManagedManifestState(root);
      if (!sameManagedManifestState(postRecoveryManifestState, manifestState)) {
        const currentManifest = readManagedIndexManifest(root);
        const expectedRetirement = priorManifest?.rollback === undefined
          ? undefined
          : {
              schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
              active: priorManifest.active,
            } satisfies ManagedIndexManifest;
        if (expectedRetirement === undefined
          || JSON.stringify(currentManifest) !== JSON.stringify(expectedRetirement)) {
          throw new Error("memory-rebuild: managed index manifest changed unexpectedly during migration recovery.");
        }
        manifestState = postRecoveryManifestState;
      }
      assertManagedManifestState(root, manifestState);
    }
    // A complete-only receipt may coexist with a later migration. Recover the
    // migration first because its sidecar delta can legitimately be DB-before;
    // only then may the receipt perform global replay equality verification.
    if (captureQueued && migrationPending) recoverCaptureQueue();
    // The configured process is stopped. Hold the prior active BEGIN IMMEDIATE
    // fence across every missing-sidecar proof/publication and all later
    // snapshot/provider/activation work so raw SQLite writers cannot cross the
    // trust boundary.
    sourceFence = hasPriorActiveDb ? acquireSqliteWriterFences([priorActivePath]) : undefined;
    if (options.tier === "bujo" || priorManifest?.active.tier === "bujo") {
      const manifestBeforeReplayInitialization = readManagedIndexManifest(root);
      const initialized = ensureReplayProjectionForSafeRebuild(
        root,
        hasPriorActiveDb ? priorActivePath : undefined,
        priorManifest?.active,
        options.hooks,
      );
      if (initialized) {
        const postInitializationManifestState = captureManagedManifestState(root);
        if (!sameManagedManifestState(postInitializationManifestState, manifestState)) {
          const expectedRetirement = manifestBeforeReplayInitialization?.rollback === undefined
            ? undefined
            : {
                schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
                active: manifestBeforeReplayInitialization.active,
              } satisfies ManagedIndexManifest;
          if (expectedRetirement === undefined
            || JSON.stringify(readManagedIndexManifest(root)) !== JSON.stringify(expectedRetirement)) {
            throw new Error(
              "memory-rebuild: managed index manifest changed unexpectedly during replay projection initialization.",
            );
          }
          manifestState = postInitializationManifestState;
        }
        assertManagedManifestState(root, manifestState);
      }
    } else if (priorManifest === undefined && hasPriorActiveDb
      && readReplayProjectionStrict(root).state.kind === "missing") {
      // A non-BuJo first rebuild must discover legacy replay before any paid
      // provider work instead of failing only while trying to retain rollback.
      assertMissingReplayProjectionHasEmptyDb(root, priorActivePath, undefined);
    }
    // Pin the complete prior SQLite state before any model/provider or test
    // hook await. A later rollback snapshot may trust vectors that cannot be
    // regenerated without a paid call, so concurrent mutation must be caught.
    const priorActiveIntegrity = hasPriorActiveDb
      ? logicalIntegrityDigest(priorActivePath, priorManifest?.active)
      : "";
    const snapshot = snapshotCanonicalSources(root, options.tier);
    const priorTier = priorManifest?.active.tier ?? (hasPriorActiveDb ? "bujo" : options.tier);
    const rollbackSnapshot = priorTier === options.tier
      ? snapshot
      : snapshotCanonicalSources(root, priorTier);
    await options.hooks?.afterSnapshot?.();
    const plan = buildPlan(snapshot, options.tier);
    const generation = createManagedGeneration(root);
    candidateName = generation.name;
    const generationIdentity = identityOf(generation.dir);
    const createdAt = new Date().toISOString();
    const descriptor: ManagedGeneration = {
      name: generation.name,
      tier: options.tier,
      sourceFingerprint: snapshot.fingerprint,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      createdAt,
      origin: "rebuild",
      skippedRawRecords: plan.skippedRawRecords,
      skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
      skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
      missingIdentityLocations: plan.missingIdentityLocations,
      skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
      legacySourceLocations: plan.legacySourceLocations,
      skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
      parsedSourceItems: plan.parsedSourceItems,
      derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      ...(options.embeddings === undefined ? {} : { embeddingModel: options.embeddings.id }),
      ...(options.dim === undefined ? {} : { dimension: options.dim }),
    };

    let openCandidateIdentity!: { readonly dev: number; readonly ino: number; readonly size: number };
    const assertOpenCandidateLocation = (): void => {
      assertManagedLayoutState(root, layoutState);
      assertSameIdentity(generation.dir, generationIdentity, "candidate generation");
      assertSameIdentity(generation.dbPath, openCandidateIdentity, "candidate database");
    };
    const guardedEmbeddings = options.embeddings === undefined ? undefined : {
      id: options.embeddings.id,
      embed: async (texts: readonly string[]): Promise<number[][]> => {
        assertOpenCandidateLocation();
        const vectors = await options.embeddings!.embed(texts);
        // The provider is the only awaited seam between preparing user text
        // and persisting it. Re-pin before returning vectors to MemoryDb.
        assertOpenCandidateLocation();
        return vectors;
      },
    };
    const db = openMemoryDb({
      path: generation.dbPath,
      ...(guardedEmbeddings === undefined ? {} : { embeddings: guardedEmbeddings }),
      ...(options.dim === undefined ? {} : { dim: options.dim }),
    });
    openCandidateIdentity = identityOf(generation.dbPath);
    let stagedReplayIntegrity: string | undefined;
    try {
      await db.rebuild(plan.records);
      const planRecordsById = new Map(plan.records.map((record) => [record.id, record]));
      for (const [contentHash, memoryId] of plan.contentHashes) {
        const record = planRecordsById.get(memoryId);
        if (record?.source.file === undefined) throw new Error("memory-rebuild: Journal record lost source provenance.");
        db.recordContentHash({
          contentHash,
          memoryId,
          sourceFile: record.source.file,
          createdAt: record.createdAt,
        });
      }
      for (const entity of plan.graph.entities) db.mirrorCanonicalEntity(entity);
      for (const relation of plan.graph.relations) db.mirrorCanonicalRelation(relation);
      for (const association of plan.graph.associations) db.mirrorCanonicalAssociation(association);
      for (const support of plan.graph.collectionSupports) {
        db.addEdge(
          support.memoryId,
          support.entityId,
          "supports",
          1,
          canonicalSupportCreatedAt(plan.graph, support.memoryId, support.entityId),
        );
      }
      db.replaceReplayProjection(replayProjectionDbReplacement(plan.replay));
      assertReplayProjectionMatchesDb(db, plan.replay);
      db.setIndexMetadata({
        schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
        policyVersion: MEMORY_REBUILD_POLICY_VERSION,
        tier: options.tier,
        sourceFingerprint: snapshot.fingerprint,
        generation: generation.name,
        createdAt,
        skippedRawRecords: plan.skippedRawRecords,
        skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
        skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
        missingIdentityLocations: plan.missingIdentityLocations,
        skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
        legacySourceLocations: plan.legacySourceLocations,
        skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
        parsedSourceItems: plan.parsedSourceItems,
        derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
        ...(options.embeddings === undefined ? {} : { embeddingModel: options.embeddings.id }),
        ...(options.dim === undefined ? {} : { dimension: options.dim }),
      });
      if (stagedCaptureForCandidate) {
        replayCaptureOutbox(root, db, {
          canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
        });
        // The durable intent is the exact authority for the lifecycle/thread
        // state that canonical Markdown cannot reconstruct. Pin that known-good
        // replay result before exposing any hook or other asynchronous seam.
        stagedReplayIntegrity = db.logicalIntegrityDigest();
      }
      await options.hooks?.afterCandidateBuilt?.();
      db.checkpoint();
    } finally {
      db.close();
    }
    await options.hooks?.afterCandidateClosed?.();
    if (stagedReplayIntegrity !== undefined
      && logicalIntegrityDigest(generation.dbPath, descriptor) !== stagedReplayIntegrity) {
      throw new Error("memory-rebuild: staged capture candidate changed after exact durable replay.");
    }
    fsyncFile(generation.dbPath);
    fsyncDirectory(generation.dir);
    validateCandidate(generation.dbPath, descriptor, plan);
    const candidateDbIdentity = identityOf(generation.dbPath);
    const candidateDigest = fileDigest(generation.dbPath);
    const candidateLogicalDigest = logicalIntegrityDigest(generation.dbPath, descriptor);
    await options.hooks?.afterCandidateValidated?.();
    await options.hooks?.beforeSourceCas?.();
    let rollback = await snapshotCurrentRollback(
      root,
      priorManifest?.active,
      rollbackSnapshot,
      priorActiveIntegrity,
    );
    const tentativeRollbackPath = rollback === undefined ? undefined : managedGenerationDbPath(root, rollback.name, true);
    if (tentativeRollbackPath !== undefined && rollback !== undefined) {
      validateRollbackSnapshot(tentativeRollbackPath, rollback, buildPlan(rollbackSnapshot, rollback.tier));
      if (!retainedVectorsMatchCandidate(generation.dbPath, descriptor, tentativeRollbackPath, rollback)) {
        rollback = undefined;
      }
    }
    const rollbackPath = rollback === undefined ? undefined : managedGenerationDbPath(root, rollback.name, true);
    const rollbackIdentity = rollbackPath === undefined ? undefined : identityOf(rollbackPath);
    const rollbackDigest = rollbackPath === undefined ? undefined : fileDigest(rollbackPath);
    // This is the final source/root/candidate CAS. All potentially long awaited
    // candidate and rollback work has completed; activation performs only the
    // same-directory manifest transaction after this point.
    const assertFinalCas = (): void => {
      const finalSnapshot = snapshotCanonicalSources(root, options.tier);
      if (finalSnapshot.fingerprint !== snapshot.fingerprint) {
        throw new Error("memory-rebuild: canonical source fingerprint changed concurrently; active index was not switched.");
      }
      if (rollback !== undefined
        && snapshotCanonicalSources(root, rollback.tier).fingerprint !== rollback.sourceFingerprint) {
        throw new Error("memory-rebuild: rollback source domain changed concurrently; active index was not switched.");
      }
      assertSameIdentity(root, rootIdentity, "memory root");
      assertManagedLayoutState(root, layoutState);
      assertSameIdentity(generation.dir, generationIdentity, "candidate generation");
      assertSameIdentity(generation.dbPath, candidateDbIdentity, "candidate database");
      if (fileDigest(generation.dbPath) !== candidateDigest) {
        throw new Error("memory-rebuild: candidate database changed after validation.");
      }
      if (logicalIntegrityDigest(generation.dbPath, descriptor) !== candidateLogicalDigest) {
        throw new Error("memory-rebuild: candidate logical state changed after validation.");
      }
      validateCandidate(generation.dbPath, descriptor, plan);
      if (rollbackPath !== undefined && rollbackIdentity !== undefined && rollbackDigest !== undefined && rollback !== undefined) {
        assertSameIdentity(rollbackPath, rollbackIdentity, "retained rollback database");
        if (fileDigest(rollbackPath) !== rollbackDigest) {
          throw new Error("memory-rebuild: retained rollback database changed after validation.");
        }
        validateRollbackSnapshot(rollbackPath, rollback, buildPlan(rollbackSnapshot, rollback.tier));
      }
      assertManagedManifestState(root, manifestState);
    };
    const nextManifest: ManagedIndexManifest = {
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      active: descriptor,
      ...(rollback === undefined ? {} : { rollback }),
    };
    const activationFence = acquireSqliteWriterFences([
      generation.dbPath,
      ...(rollbackPath === undefined ? [] : [rollbackPath]),
    ]);
    try {
      assertFinalCas();
      await activateManagedIndex(root, nextManifest, {
        ...options.hooks,
        beforeManifestRename: assertFinalCas,
      });
      activated = true;
      return {
        active: generation.dbPath,
        ...(rollback === undefined ? {} : { rollback: managedGenerationDbPath(root, rollback.name, true) }),
        indexed: plan.records.length,
        sourceFingerprint: snapshot.fingerprint,
        generation: generation.name,
        skippedRawRecords: plan.skippedRawRecords,
        skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
        skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
        missingIdentityLocations: plan.missingIdentityLocations,
        skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
        legacySourceLocations: plan.legacySourceLocations,
        skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
        parsedSourceItems: plan.parsedSourceItems,
        derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      };
    } finally {
      activationFence.release();
    }
  } catch (error) {
    // A generation referenced by a renamed manifest must never be deleted. Other
    // candidates are intentionally retained as orphans for explicit inspection;
    // the resolver never auto-adopts them.
    if (activated && candidateName === undefined) throw new Error("memory-rebuild: activated generation identity was lost.");
    throw error;
  } finally {
    try {
      sourceFence?.release();
    } finally {
      lease.release();
    }
  }
}

function sameManagedManifestState(left: ManagedManifestState, right: ManagedManifestState): boolean {
  return left.exists === right.exists
    && left.dev === right.dev
    && left.ino === right.ino
    && left.sha256 === right.sha256;
}

/**
 * Bootstrap only the provably empty legacy case. Historical replay rows are
 * not provenance: a stopped operator must explicitly adopt them after the
 * dedicated canonical-base check instead of having rebuild bless them.
 */
function ensureReplayProjectionForSafeRebuild(
  root: string,
  activePath: string | undefined,
  descriptor: ManagedGeneration | undefined,
  hooks: SafeMemoryRebuildHooks | undefined,
): boolean {
  const current = readReplayProjectionStrict(root);
  if (current.state.kind === "present") return false;
  assertMissingReplayProjectionHasEmptyDb(root, activePath, descriptor);
  hooks?.beforeReplayProjectionInitialization?.();
  withManagedRollbackRetirement(root, "replay", () => initializeReplayProjection(root));
  return true;
}

function assertMissingReplayProjectionHasEmptyDb(
  root: string,
  activePath: string | undefined,
  descriptor: ManagedGeneration | undefined,
): void {
  if (readReplayProjectionStrict(root).state.kind === "present") return;
  if (activePath !== undefined) {
    const db = descriptor === undefined
      ? openMemoryDb({ path: activePath, readOnly: true })
      : readOnlyDb(activePath, descriptor);
    try {
      const replay = replayProjectionDbSnapshot(db);
      if (replay.terminals.length > 0 || replay.supersedes.length > 0 || replay.threads.length > 0) {
        throw new Error(
          `memory-rebuild: ${REPLAY_PROJECTION_FILE} is missing while the active index contains replay-owned state; `
          + "automatic adoption is unsafe. Stop the store and run explicit replay projection adoption, then retry.",
        );
      }
    } finally {
      db.close();
    }
  }
}

/** Atomically swap active/rollback after validating the retained target. No provider call is made. */
export async function rollbackMemoryIndex(options: SafeMemoryIndexOptions): Promise<SafeMemoryIndexResult> {
  assertSafeRebuildOptions(options);
  const lease = acquireMemoryWriterLease(options.root);
  let sourceFence: SqliteWriterFence | undefined;
  try {
    const root = lease.root;
    assertNoPendingMigrateDecision(root);
    assertNoPendingCaptureIntent(root);
    const rootIdentity = identityOf(root);
    const layoutState = captureManagedLayoutState(root);
    const manifestState = captureManagedManifestState(root);
    const manifest = readManagedIndexManifest(root);
    if (manifest?.rollback === undefined) throw new Error("memory-rebuild: no retained rollback generation is available.");
    assertNoActiveSqliteWriter(managedGenerationDbPath(root, manifest.active.name, true));
    const target = manifest.rollback;
    assertConfiguredIdentity(target, options);
    const snapshot = snapshotCanonicalSources(root, target.tier);
    if (snapshot.fingerprint !== target.sourceFingerprint) {
      throw new Error("memory-rebuild: canonical source changed after the retained generation; stale rollback refused.");
    }
    const targetPath = managedGenerationDbPath(root, target.name, true);
    const targetPlan = buildPlan(snapshot, target.tier);
    validateRollbackSnapshot(targetPath, target, targetPlan);
    const targetIdentity = identityOf(targetPath);
    const targetDigest = fileDigest(targetPath);
    const currentPath = managedGenerationDbPath(root, manifest.active.name, true);
    sourceFence = acquireSqliteWriterFences([currentPath]);
    const currentIdentity = identityOf(currentPath);
    const currentDigest = fileDigest(currentPath);
    let currentIntegrity: string | undefined;
    try {
      currentIntegrity = logicalIntegrityDigest(currentPath, manifest.active);
    } catch {
      // A damaged current active must not prevent rescue to a verified target.
      // It simply cannot be advertised as the next one-command rollback.
    }
    const outgoingSnapshot = snapshotCanonicalSources(root, manifest.active.tier);
    let outgoing: ManagedGeneration | undefined;
    if (currentIntegrity !== undefined) {
      try {
        outgoing = await snapshotCurrentRollback(
          root,
          manifest.active,
          outgoingSnapshot,
          currentIntegrity,
        );
      } catch (error) {
        // Semantic/coverage divergence omits the outgoing snapshot. A concurrent
        // mutation is different: preserve the original failure and do not swap.
        assertSameIdentity(currentPath, currentIdentity, "current active database");
        if (fileDigest(currentPath) !== currentDigest
          || logicalIntegrityDigest(currentPath, manifest.active) !== currentIntegrity) {
          throw error;
        }
        outgoing = undefined;
      }
    }
    const outgoingPath = outgoing === undefined ? undefined : managedGenerationDbPath(root, outgoing.name, true);
    const outgoingIdentity = outgoingPath === undefined ? undefined : identityOf(outgoingPath);
    const outgoingDigest = outgoingPath === undefined ? undefined : fileDigest(outgoingPath);
    const outgoingPlan = outgoing === undefined ? undefined : buildPlan(outgoingSnapshot, outgoing.tier);
    if (outgoingPath !== undefined && outgoing !== undefined && outgoingPlan !== undefined) {
      validateRollbackSnapshot(outgoingPath, outgoing, outgoingPlan);
    }
    const next: ManagedIndexManifest = {
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      active: target,
      ...(outgoing === undefined ? {} : { rollback: outgoing }),
    };
    const assertFinalRollbackCas = (): void => {
      assertSameIdentity(root, rootIdentity, "memory root");
      assertManagedLayoutState(root, layoutState);
      assertSameIdentity(targetPath, targetIdentity, "rollback target database");
      assertSameIdentity(currentPath, currentIdentity, "current active database");
      if (fileDigest(targetPath) !== targetDigest || fileDigest(currentPath) !== currentDigest) {
        throw new Error("memory-rebuild: active or rollback database changed after validation.");
      }
      if (currentIntegrity !== undefined
        && logicalIntegrityDigest(currentPath, manifest.active) !== currentIntegrity) {
        throw new Error("memory-rebuild: current active logical state changed during rollback.");
      }
      if (snapshotCanonicalSources(root, target.tier).fingerprint !== target.sourceFingerprint) {
        throw new Error("memory-rebuild: canonical source changed before rollback activation.");
      }
      validateRollbackSnapshot(targetPath, target, targetPlan);
      if (outgoingPath !== undefined && outgoingIdentity !== undefined && outgoingDigest !== undefined
        && outgoing !== undefined && outgoingPlan !== undefined) {
        assertSameIdentity(outgoingPath, outgoingIdentity, "outgoing rollback database");
        if (fileDigest(outgoingPath) !== outgoingDigest) {
          throw new Error("memory-rebuild: outgoing rollback database changed after validation.");
        }
        if (snapshotCanonicalSources(root, outgoing.tier).fingerprint !== outgoing.sourceFingerprint) {
          throw new Error("memory-rebuild: outgoing rollback source changed before activation.");
        }
        validateRollbackSnapshot(outgoingPath, outgoing, outgoingPlan);
      }
      assertManagedManifestState(root, manifestState);
    };
    const activationFence = acquireSqliteWriterFences([
      targetPath,
      ...(outgoingPath === undefined ? [] : [outgoingPath]),
    ]);
    try {
      assertFinalRollbackCas();
      await activateManagedIndex(root, next, {
        ...options.hooks,
        beforeManifestRename: assertFinalRollbackCas,
      });
      const inspected = readOnlyDb(targetPath, target);
      let indexed: number;
      try {
        indexed = inspected.validationSnapshot().memories;
      } finally {
        inspected.close();
      }
      return {
        active: targetPath,
        ...(outgoingPath === undefined ? {} : { rollback: outgoingPath }),
        indexed,
        sourceFingerprint: target.sourceFingerprint,
        generation: target.name,
        skippedRawRecords: target.skippedRawRecords ?? 0,
        skippedUnstructuredRecords: target.skippedUnstructuredRecords ?? 0,
        skippedMissingIdentityRecords: target.skippedMissingIdentityRecords ?? 0,
        missingIdentityLocations: target.missingIdentityLocations ?? [],
        skippedLegacySourceRecords: target.skippedLegacySourceRecords ?? 0,
        legacySourceLocations: target.legacySourceLocations ?? [],
        skippedJournalDuplicateRecords: target.skippedJournalDuplicateRecords ?? 0,
        parsedSourceItems: target.parsedSourceItems ?? indexed,
        derivedLegacyAssociations: target.derivedLegacyAssociations ?? 0,
      };
    } finally {
      activationFence.release();
    }
  } finally {
    try {
      sourceFence?.release();
    } finally {
      lease.release();
    }
  }
}

function snapshotCanonicalSources(root: string, tier: BujoTier): SourceSnapshot {
  const files: SourceFileSnapshot[] = [];
  const dailyNames = new Set(listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  }));
  // Older stores placed dated logs at the root. A canonical daily/<date>.md
  // wins when both layouts contain the same date, matching operator preview.
  for (const name of listCanonicalRootFileNames(root, { include: (file) => LEGACY_DAILY_FILE.test(file) })) {
    if (dailyNames.has(name)) continue;
    files.push(readStableSourceFile(root, name));
  }
  for (const name of [...dailyNames].sort()) {
    files.push(readStableSourceFile(root, `daily/${name}`));
  }
  let graph: SourceFileSnapshot | undefined;
  let replay: SourceFileSnapshot | undefined;
  if (tier === "bujo") {
    const graphSnapshot = readCanonicalFileSnapshot(root, "graph.jsonl", { allowMissing: true });
    if (graphSnapshot !== undefined) {
      graph = { relativePath: "graph.jsonl", bytes: Buffer.from(graphSnapshot.content, "utf8") };
    }
    const replaySnapshot = readCanonicalFileSnapshot(root, REPLAY_PROJECTION_FILE, { allowMissing: true });
    if (replaySnapshot !== undefined) {
      // Parse the exact bytes that participate in the source fingerprint. A
      // second live read here would let a rename pair one file's digest with
      // another file's semantic plan.
      parseReplayProjectionStrict(replaySnapshot.content);
      replay = { relativePath: REPLAY_PROJECTION_FILE, bytes: Buffer.from(replaySnapshot.content, "utf8") };
    }
  }
  const hash = createHash("sha256");
  for (const file of [
    ...files,
    ...(graph === undefined ? [] : [graph]),
    ...(replay === undefined ? [] : [replay]),
  ]) {
    hash.update(String(Buffer.byteLength(file.relativePath)));
    hash.update("\0");
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.bytes.length));
    hash.update("\0");
    hash.update(file.bytes);
  }
  return {
    fingerprint: hash.digest("hex"),
    daily: files,
    ...(graph === undefined ? {} : { graph }),
    ...(replay === undefined ? {} : { replay }),
  };
}

/** Provider-free fingerprint of the exact canonical source set for one tier. */
export function readCanonicalSourceFingerprint(root: string, tier: BujoTier): string {
  if (tier === "bujo") return readBujoCanonicalSourceFingerprint(root);
  return snapshotCanonicalSources(root, tier).fingerprint;
}

function readStableSourceFile(root: string, relativePath: string): SourceFileSnapshot {
  const snapshot = readCanonicalFileSnapshot(root, relativePath);
  if (snapshot === undefined) throw new Error(`memory-rebuild: canonical source ${relativePath} disappeared.`);
  return { relativePath, bytes: Buffer.from(snapshot.content, "utf8") };
}

function buildPlan(
  snapshot: SourceSnapshot,
  tier: BujoTier,
  replayOverride?: ReplayProjectionV1,
): BuildPlan {
  const rawRecords: MemoryRecord[] = [];
  let skippedUnstructuredRecords = 0;
  const missingIdentityLocations: string[] = [];
  const legacySourceLocations: string[] = [];
  for (const source of snapshot.daily) {
    const content = source.bytes.toString("utf8");
    const parsed = parseDailyFile(content);
    for (const line of parsed.lines) {
      if (line.bullet === undefined) {
        if (line.raw.includes("<!--mem")) {
          if (isMissingOnlyIdentity(line.raw)) {
            missingIdentityLocations.push(`${source.relativePath}:${line.lineNumber}`);
            continue;
          }
          if (isLegacySourceRecord(line.raw)) {
            legacySourceLocations.push(`${source.relativePath}:${line.lineNumber}`);
            continue;
          }
          throw new Error(`memory-rebuild: malformed memory bullet at ${source.relativePath}:${line.lineNumber}.`);
        }
        if (CANONICAL_VISIBLE_BULLET.test(line.raw)) skippedUnstructuredRecords += 1;
        continue;
      }
      assertStrictBulletRaw(line.raw, source.relativePath, line.lineNumber);
      if (!Number.isFinite(Date.parse(line.bullet.createdAt))) {
        throw new Error(`memory-rebuild: invalid memory timestamp at ${source.relativePath}:${line.lineNumber}.`);
      }
      rawRecords.push(toRecord(line.bullet, source.relativePath, line.lineNumber));
    }
  }

  const records = new Map<string, MemoryRecord>();
  const contentHashes = new Map<string, string>();
  let skippedRawRecords = 0;
  let skippedJournalDuplicateRecords = 0;
  for (const record of rawRecords) {
    if (tier === "bujo" && isLegacyHostObservation(record.text)) {
      skippedRawRecords += 1;
      continue;
    }
    if (tier === "journal") {
      const hash = normalizedContentHash(record.text);
      if (contentHashes.has(hash)) {
        skippedJournalDuplicateRecords += 1;
        continue;
      }
      const canonical = { ...record, id: `J-${hash}` };
      records.set(canonical.id, canonical);
      contentHashes.set(hash, canonical.id);
      continue;
    }
    const existing = records.get(record.id);
    if (existing !== undefined) {
      throw new Error(`memory-rebuild: duplicate canonical memory id ${record.id}.`);
    }
    records.set(record.id, record);
  }

  const graph = tier === "bujo"
    ? projectCanonicalGraph(parseCanonicalGraphStrict(snapshot.graph?.bytes.toString("utf8")), [...records.values()])
    : emptyCanonicalGraphProjection();
  for (const support of graph.collectionSupports) {
    const record = records.get(support.memoryId);
    if (record === undefined) throw new Error("memory-rebuild: collection support lost its memory endpoint.");
    records.set(record.id, { ...record, collection: support.collection });
  }
  const replay = replayOverride ?? (tier === "bujo"
    ? snapshot.replay === undefined
      ? (() => {
          throw new Error(
            `memory-rebuild: ${REPLAY_PROJECTION_FILE} is missing; `
            + "refusing to infer replay-owned lifecycle or edges from SQLite. "
            + "Run explicit stopped-store replay projection adoption for a legacy nonempty index.",
          );
        })()
      : parseReplayProjectionStrict(snapshot.replay.bytes.toString("utf8"))
    : emptyReplayProjection());
  applyReplayProjectionToPlan(records, replay, tier);
  const parsedSourceItems = rawRecords.length + skippedUnstructuredRecords
    + missingIdentityLocations.length + legacySourceLocations.length;
  const accountedSourceItems = records.size + skippedRawRecords + skippedUnstructuredRecords
    + missingIdentityLocations.length + legacySourceLocations.length + skippedJournalDuplicateRecords;
  if (accountedSourceItems !== parsedSourceItems) {
    throw new Error(`memory-rebuild: source accounting mismatch (${accountedSourceItems}/${parsedSourceItems}).`);
  }
  return {
    records: [...records.values()],
    contentHashes,
    graph,
    replay,
    skippedRawRecords,
    skippedUnstructuredRecords,
    skippedMissingIdentityRecords: missingIdentityLocations.length,
    missingIdentityLocations,
    skippedLegacySourceRecords: legacySourceLocations.length,
    legacySourceLocations,
    skippedJournalDuplicateRecords,
    parsedSourceItems,
  };
}

/** Bind the exact replay authority to the canonical memory inventory. */
function applyReplayProjectionToPlan(
  records: Map<string, MemoryRecord>,
  replay: ReplayProjectionV1,
  tier: BujoTier,
): void {
  if (tier !== "bujo") {
    if (replay.terminals.length > 0 || replay.supersedes.length > 0 || replay.threads.length > 0) {
      throw new Error(`memory-rebuild: ${tier} cannot carry a BuJo replay projection.`);
    }
    return;
  }

  const lifecycleOwners = new Set<string>();
  for (const terminal of replay.terminals) {
    const record = records.get(terminal.id);
    if (record === undefined || record.status !== "dropped"
      || record.validTo !== undefined || record.supersededBy !== undefined || record.supersededAt !== undefined
      || timestampMillis(terminal.at) < timestampMillis(record.createdAt)
      || lifecycleOwners.has(terminal.id)) {
      throw new Error(`memory-rebuild: replay terminal does not match canonical memory ${terminal.id}.`);
    }
    lifecycleOwners.add(terminal.id);
    records.set(record.id, { ...record, validTo: terminal.at });
  }

  const successors = new Map<string, string>();
  const predecessors = new Set<string>();
  for (const supersede of replay.supersedes) {
    const source = records.get(supersede.src);
    const target = records.get(supersede.dst);
    if (source === undefined || target === undefined || source.status !== "invalidated"
      || source.validTo !== undefined || source.supersededBy !== undefined || source.supersededAt !== undefined
      || supersede.src === supersede.dst || lifecycleOwners.has(supersede.src)
      || predecessors.has(supersede.dst)
      || timestampMillis(supersede.at) < timestampMillis(source.createdAt)
      || timestampMillis(supersede.at) !== timestampMillis(target.createdAt)) {
      throw new Error(`memory-rebuild: replay supersede does not match canonical memories ${supersede.src} -> ${supersede.dst}.`);
    }
    lifecycleOwners.add(supersede.src);
    predecessors.add(supersede.dst);
    successors.set(supersede.src, supersede.dst);
    records.set(source.id, {
      ...source,
      validTo: supersede.at,
      supersededBy: supersede.dst,
      supersededAt: supersede.at,
    });
  }
  assertNoReplaySuccessorCycle(successors);

  const threadCounts = new Map<string, number>();
  for (const thread of replay.threads) {
    const source = records.get(thread.src);
    const target = records.get(thread.dst);
    const count = (threadCounts.get(thread.src) ?? 0) + 1;
    if (source === undefined || target === undefined || thread.src === thread.dst
      || timestampMillis(thread.at) < timestampMillis(source.createdAt)
      || timestampMillis(thread.at) < timestampMillis(target.createdAt)
      || count > 5) {
      throw new Error(`memory-rebuild: replay thread does not match canonical memories ${thread.src} -> ${thread.dst}.`);
    }
    threadCounts.set(thread.src, count);
  }
}

function assertNoReplaySuccessorCycle(successors: ReadonlyMap<string, string>): void {
  const finished = new Set<string>();
  for (const start of successors.keys()) {
    const path = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !finished.has(current)) {
      if (path.has(current)) throw new Error("memory-rebuild: replay supersession graph contains a cycle.");
      path.add(current);
      current = successors.get(current);
    }
    for (const id of path) finished.add(id);
  }
}

function timestampMillis(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("memory-rebuild: replay projection contains an invalid timestamp.");
  return millis;
}

function canonicalSupportCreatedAt(
  graph: CanonicalGraphProjection,
  memoryId: string,
  entityId: string,
): string {
  const association = graph.associations.find((candidate) => (
    candidate.memoryId === memoryId && candidate.entityId === entityId
  ));
  if (association === undefined) {
    throw new Error(`memory-rebuild: collection support ${memoryId} -> ${entityId} has no canonical association.`);
  }
  return association.createdAt;
}

function validateCandidate(
  path: string,
  descriptor: ManagedGeneration,
  plan: BuildPlan,
): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const parityError = buildPlanParityError(db, descriptor.tier, plan, {
    });
    if (parityError !== undefined) throw new Error(parityError);
  } finally {
    db.close();
  }
}

interface BuildPlanParityOptions {
  readonly allowReplaySourceRepair?: boolean;
  readonly allowJournalVectorBacklog?: boolean;
  readonly allowJournalHashRepair?: boolean;
  /**
   * Stopped legacy adoption only. Canonical entities, relations, and capture
   * associations remain exact; only deterministic legacy associations,
   * collection fields, and their safe supports/about mirrors may drift until
   * the mandatory rebuild normalizes them.
   */
  readonly allowCanonicalGraphProjectionRepair?: boolean;
  readonly omitDerivedCollection?: boolean;
  /**
   * Runtime/graph-repair parity ignores state intentionally preserved outside
   * canonical Markdown: live interval start, tags, transient source
   * provenance. Graph-repair guards opt out of the separately derived
   * collection cache; runtime health keeps collection exact. Rebuild
   * candidates and immutable rollback validation remain fully strict.
   */
  readonly omitMutableLiveState?: boolean;
  readonly pendingMemoryIds?: ReadonlySet<string>;
  readonly pendingGraphEntityIds?: ReadonlySet<string>;
  readonly pendingGraphRelationKeys?: ReadonlySet<string>;
  readonly pendingGraphAssociationKeys?: ReadonlySet<string>;
}

function buildPlanParityError(
  db: MemoryDb,
  tier: BujoTier,
  plan: BuildPlan,
  options: BuildPlanParityOptions,
): string | undefined {
  const memoryParityError = buildPlanCanonicalMemoryParityError(db, tier, plan, options);
  if (memoryParityError !== undefined) return memoryParityError;
  const state = db.validationSnapshot();
  const memoryInventory = db.allMemories();
  const actualMemoryById = new Map(memoryInventory.map((record) => [record.id, record]));
  const expectedMemoryById = new Map(plan.records.map((record) => [record.id, record]));
  const allowGraphProjectionRepair = options.allowCanonicalGraphProjectionRepair === true;
  const pendingEntityIds = options.pendingGraphEntityIds ?? new Set<string>();
  const pendingRelationKeys = options.pendingGraphRelationKeys ?? new Set<string>();
  const pendingAssociationKeys = options.pendingGraphAssociationKeys ?? new Set<string>();
  if (state.relationOrphans !== 0 || state.associationOrphans !== 0) {
    return "memory-rebuild: candidate graph coverage or endpoint validation failed.";
  }
  const actualEntities = db.allEntities();
  const actualRelations = db.allEntityRelations();
  const actualAssociations = db.allMemoryAssociations();
  const comparedActualEntities = actualEntities.filter((entity) => !pendingEntityIds.has(entity.id));
  const comparedExpectedEntities = plan.graph.entities.filter((entity) => !pendingEntityIds.has(entity.id));
  const comparedActualRelations = actualRelations.filter((relation) => !pendingRelationKeys.has(relationKey(relation)));
  const comparedExpectedRelations = plan.graph.relations.filter((relation) => !pendingRelationKeys.has(relationKey(relation)));
  const comparedActualAssociations = actualAssociations.filter((association) => !pendingAssociationKeys.has(associationKey(association)));
  const comparedExpectedAssociations = plan.graph.associations.filter((association) => !pendingAssociationKeys.has(associationKey(association)));
  if (!sameKeyedInventory(comparedActualEntities, comparedExpectedEntities, (entity) => entity.id, (entity) => entity.id)
    || !sameKeyedInventory(
      comparedActualRelations,
      comparedExpectedRelations,
      relationKey,
      relationKey,
    )) {
    return "memory-rebuild: candidate graph payload validation failed.";
  }
  const associationsExact = sameKeyedInventory(
    comparedActualAssociations,
    comparedExpectedAssociations,
    associationKey,
    associationKey,
  );
  if (!associationsExact && (!allowGraphProjectionRepair || !safeRepairableAssociationInventory(
      comparedActualAssociations,
      comparedExpectedAssociations,
      actualMemoryById,
      new Map(actualEntities.map((entity) => [entity.id, entity])),
    ))) {
    return "memory-rebuild: candidate graph payload validation failed.";
  }
  const expectedEdges = [
    ...plan.graph.collectionSupports.map((support) => ({
      src: support.memoryId,
      dst: support.entityId,
      kind: "supports",
      weight: 1,
      createdAt: canonicalSupportCreatedAt(plan.graph, support.memoryId, support.entityId),
    })),
    ...plan.replay.supersedes.map((entry) => ({
      src: entry.src,
      dst: entry.dst,
      kind: "supersedes",
      weight: 1,
      createdAt: entry.at,
    })),
    ...plan.replay.threads.map((entry) => ({
      src: entry.src,
      dst: entry.dst,
      kind: "thread",
      weight: entry.weight,
      createdAt: entry.at,
    })),
  ];
  const actualEdges = db.allEdges();
  if (actualEdges.some((edge) => edge.kind !== "supports" && edge.kind !== "about"
    && edge.kind !== "thread" && edge.kind !== "supersedes")) {
    return "memory-rebuild: candidate contains an unknown edge kind.";
  }
  const edgesExact = sameKeyedInventory(actualEdges, expectedEdges, edgeKey, edgeKey);
  if (!edgesExact && (!allowGraphProjectionRepair || !safeRepairableEdgeInventory(
      actualEdges,
      actualAssociations,
      plan.graph.associations,
      actualMemoryById,
      new Map(actualEntities.map((entity) => [entity.id, entity])),
    ))) {
    return "memory-rebuild: candidate edge inventory validation failed.";
  }
  if (tier === "journal") {
    if (state.contentHashes !== plan.contentHashes.size || state.contentHashOrphans !== 0) {
      return "memory-rebuild: Journal content-hash bijection validation failed.";
    }
    const actual = db.contentHashRecords();
    for (const hash of actual) {
      const record = actualMemoryById.get(hash.memoryId);
      if (record === undefined || normalizedContentHash(record.text) !== hash.contentHash
        || plan.contentHashes.get(hash.contentHash) !== hash.memoryId) {
        return "memory-rebuild: Journal content-hash correctness validation failed.";
      }
    }
    if (options.allowJournalHashRepair !== true) {
      const expected = [...plan.contentHashes].map(([contentHash, memoryId]) => {
        const record = expectedMemoryById.get(memoryId);
        return {
          contentHash,
          memoryId,
          sourceFile: record?.source.file,
          createdAt: record?.createdAt,
        };
      });
      if (!sameKeyedInventory(
        actual,
        expected,
        (record) => record.contentHash,
        (record) => record.contentHash,
      )) {
        return "memory-rebuild: Journal content-hash provenance validation failed.";
      }
    }
  } else if (state.contentHashes !== 0) {
    return "memory-rebuild: non-Journal candidate unexpectedly contains content hashes.";
  }
  return undefined;
}

function buildPlanCanonicalMemoryParityError(
  db: MemoryDb,
  tier: BujoTier,
  plan: BuildPlan,
  options: BuildPlanParityOptions,
): string | undefined {
  const state = db.validationSnapshot();
  if (state.ftsRows !== state.memories || state.ftsMismatches !== 0) {
    return "memory-rebuild: candidate memory/FTS coverage validation failed.";
  }
  const memoryInventory = db.allMemories();
  const pendingMemoryIds = options.pendingMemoryIds ?? new Set<string>();
  const comparedRecords = plan.records.filter((record) => !pendingMemoryIds.has(record.id));
  const comparedActual = memoryInventory.filter((record) => !pendingMemoryIds.has(record.id));
  const comparedActualById = new Map(comparedActual.map((record) => [record.id, record]));
  const actualMemories = comparedRecords.map((record) => comparedActualById.get(record.id));
  const omitDerivedCollection = options.omitDerivedCollection === true
    || options.allowCanonicalGraphProjectionRepair === true;
  const omitRepairableSourceProvenance = options.allowReplaySourceRepair === true
    || options.omitMutableLiveState === true;
  if (comparedActualById.size !== comparedRecords.length || comparedRecords.some((expected) => !sameCanonicalValue(
    memoryPayload(
      comparedActualById.get(expected.id),
      omitRepairableSourceProvenance,
      omitDerivedCollection,
      options.omitMutableLiveState === true,
    ),
    memoryPayload(
      expected,
      omitRepairableSourceProvenance,
      omitDerivedCollection,
      options.omitMutableLiveState === true,
    ),
  ))) {
    return "memory-rebuild: candidate memory payload validation failed.";
  }
  if (options.allowReplaySourceRepair === true && options.omitMutableLiveState !== true
    && actualMemories.some((record, index) => {
    const expected = comparedRecords[index];
    return record?.source.line !== undefined && record.source.line !== expected?.source.line;
  })) {
    return "memory-rebuild: candidate memory payload validation failed.";
  }
  const invalidVectorCoverage = tier === "lite"
    ? state.vectors !== 0
    : tier === "bujo" || options.allowJournalVectorBacklog !== true
      ? state.vectors !== state.memories
      : false;
  if (invalidVectorCoverage || state.vectorOrphans !== 0 || state.vectorIdentityMissing !== 0) {
    return "memory-rebuild: candidate vector coverage validation failed.";
  }
  if (tier !== "lite" && state.vectors > 0
    && (state.embeddingModels.length !== 1 || state.embeddingDimensions.length !== 1
      || state.embeddingDimensions[0] !== db.vectorDimension())) {
    return "memory-rebuild: candidate vector identity validation failed.";
  }
  if (tier !== "journal" && (state.contentHashes !== 0 || state.contentHashOrphans !== 0)) {
    return "memory-rebuild: non-Journal candidate unexpectedly contains content hashes.";
  }
  try {
    assertReplayProjectionMatchesDb(db, plan.replay);
  } catch {
    return "memory-rebuild: candidate replay projection validation failed.";
  }
  return undefined;
}

function hasTierExactSourceParity(
  path: string,
  descriptor: ManagedGeneration,
  plan: BuildPlan,
  allowReplaySourceRepair: boolean,
): boolean {
  const db = readOnlyDb(path, descriptor);
  try {
    return buildPlanParityError(db, descriptor.tier, plan, {
      allowReplaySourceRepair,
      allowJournalVectorBacklog: true,
      allowJournalHashRepair: allowReplaySourceRepair,
    }) === undefined;
  } finally {
    db.close();
  }
}

function validateRollbackSnapshot(path: string, descriptor: ManagedGeneration, plan: BuildPlan): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const parityError = buildPlanParityError(db, descriptor.tier, plan, {
      allowJournalVectorBacklog: true,
    });
    if (parityError !== undefined) {
      throw new Error(`memory-rebuild: rollback source parity validation failed: ${parityError.replace(/^memory-rebuild: /u, "")}`);
    }
    if (descriptor.integrityDigest === undefined) {
      throw new Error("memory-rebuild: rollback generation has no trusted logical integrity digest; run rebuild first.");
    }
    if (db.logicalIntegrityDigest() !== descriptor.integrityDigest) {
      throw new Error("memory-rebuild: rollback logical integrity digest changed after retention.");
    }
  } finally {
    db.close();
  }
}

function validateRetainedGeneration(path: string, descriptor: ManagedGeneration): void {
  const db = readOnlyDb(path, descriptor);
  try {
    validateDb(db, descriptor);
    const state = db.validationSnapshot();
    const invalidTierVectorCoverage = descriptor.tier === "lite"
      ? state.vectors !== 0
      : descriptor.tier === "bujo"
        ? state.vectors !== state.memories
        : false;
    if (state.ftsRows !== state.memories || state.ftsMismatches !== 0 || state.vectorOrphans !== 0
      || invalidTierVectorCoverage || state.contentHashOrphans !== 0
      || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
      throw new Error("memory-rebuild: retained rollback generation failed coverage validation.");
    }
  } finally {
    db.close();
  }
}

export const MANAGED_GENERATION_DB_VALIDATION_ISSUE_CODES = [
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
] as const;

export type ManagedGenerationDbValidationIssue =
  (typeof MANAGED_GENERATION_DB_VALIDATION_ISSUE_CODES)[number];

/**
 * Provider-free validation shared by rebuild/rollback and strict health.
 *
 * The caller chooses the SQLite snapshot boundary. The result is deliberately
 * closed and content-free so health surfaces never need to classify exception
 * text or expose descriptor/database payloads.
 */
export function validateManagedGenerationDb(
  db: MemoryDb,
  descriptor: ManagedGeneration,
): readonly ManagedGenerationDbValidationIssue[] {
  const issues = new Set<ManagedGenerationDbValidationIssue>();
  if (db.integrityCheck().toLowerCase() !== "ok") {
    return ["sqlite_integrity_failed"];
  }

  let metadata: ReturnType<MemoryDb["indexMetadata"]>;
  try {
    metadata = db.indexMetadata();
  } catch {
    metadata = undefined;
  }
  if (!metadataMatchesManagedGeneration(metadata, descriptor)) {
    issues.add("metadata_mismatch");
  }

  const expectedDimension = descriptor.dimension ?? DEFAULT_VEC_DIM;
  try {
    if (db.vectorDimension() !== expectedDimension) issues.add("vector_mismatch");
  } catch {
    issues.add("vector_mismatch");
  }

  const state = db.validationSnapshot();
  if (state.ftsRows !== state.memories || state.ftsMismatches !== 0) issues.add("fts_mismatch");
  if (state.vectorOrphans !== 0 || state.contentHashOrphans !== 0
    || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
    issues.add("orphaned_rows");
  }

  const invalidVectorCoverage = descriptor.tier === "lite"
    ? state.vectors !== 0
    : descriptor.tier === "bujo"
      ? state.vectors !== state.memories
      : state.vectors > state.memories;
  const invalidHashCoverage = descriptor.tier === "journal"
    ? state.contentHashes !== state.memories
    : state.contentHashes !== 0;
  const invalidVectorIdentity = vectorIdentityMismatch(state, descriptor);
  if (invalidVectorCoverage || invalidHashCoverage || invalidVectorIdentity) issues.add("vector_mismatch");

  return MANAGED_GENERATION_DB_VALIDATION_ISSUE_CODES.filter((issue) => issues.has(issue));
}

function validateDb(db: MemoryDb, descriptor: ManagedGeneration): void {
  if (db.integrityCheck().toLowerCase() !== "ok") throw new Error("memory-rebuild: SQLite integrity check failed.");
  const metadata = db.indexMetadata();
  if (!metadataMatchesManagedGeneration(metadata, descriptor)) {
    throw new Error("memory-rebuild: candidate metadata does not match its manifest generation.");
  }
  const expectedDimension = descriptor.dimension ?? DEFAULT_VEC_DIM;
  if (db.vectorDimension() !== expectedDimension) throw new Error("memory-rebuild: actual vector DDL dimension does not match metadata.");
  const state = db.validationSnapshot();
  if (state.vectorIdentityMissing !== 0) {
    throw new Error("memory-rebuild: vector rows have incomplete embedding model/dimension identity.");
  }
  if (vectorIdentityMismatch(state, descriptor)) {
    throw new Error("memory-rebuild: embedding model/dimension identity validation failed.");
  }
}

function metadataMatchesManagedGeneration(
  metadata: ReturnType<MemoryDb["indexMetadata"]>,
  descriptor: ManagedGeneration,
): boolean {
  return metadata !== undefined
    && metadata.schemaVersion === MANAGED_INDEX_SCHEMA_VERSION
    && metadata.policyVersion === descriptor.policyVersion
    && metadata.tier === descriptor.tier
    && metadata.sourceFingerprint === descriptor.sourceFingerprint
    && metadata.generation === descriptor.name
    && metadata.createdAt === descriptor.createdAt
    && metadata.embeddingModel === descriptor.embeddingModel
    && metadata.dimension === descriptor.dimension
    && metadata.skippedRawRecords === descriptor.skippedRawRecords
    && metadata.skippedUnstructuredRecords === descriptor.skippedUnstructuredRecords
    && metadata.skippedMissingIdentityRecords === descriptor.skippedMissingIdentityRecords
    && stableJson(metadata.missingIdentityLocations ?? []) === stableJson(descriptor.missingIdentityLocations ?? [])
    && metadata.skippedLegacySourceRecords === descriptor.skippedLegacySourceRecords
    && stableJson(metadata.legacySourceLocations ?? []) === stableJson(descriptor.legacySourceLocations ?? [])
    && metadata.skippedJournalDuplicateRecords === descriptor.skippedJournalDuplicateRecords
    && metadata.parsedSourceItems === descriptor.parsedSourceItems
    && metadata.derivedLegacyAssociations === descriptor.derivedLegacyAssociations;
}

function vectorIdentityMismatch(
  state: ReturnType<MemoryDb["validationSnapshot"]>,
  descriptor: ManagedGeneration,
): boolean {
  return state.vectorIdentityMissing !== 0
    || (descriptor.embeddingModel === undefined
      ? state.embeddingModels.length !== 0 || state.embeddingDimensions.length !== 0
      : state.embeddingModels.some((model) => model !== descriptor.embeddingModel)
        || state.embeddingDimensions.some((dimension) => dimension !== descriptor.dimension));
}

function openCurrentReplayDb(
  path: string,
  manifest: ManagedIndexManifest | undefined,
): MemoryDb {
  if (manifest !== undefined) {
    const active = manifest.active;
    return openMemoryDb({
      path,
      ...(active.embeddingModel === undefined ? {} : { embeddings: noCallEmbeddings(active.embeddingModel) }),
      ...(active.dimension === undefined ? {} : { dim: active.dimension }),
    });
  }

  // A pre-managed database has no manifest descriptor. Read its actual vec DDL
  // and persisted model identity before reopening writable; the provider stub
  // supplies identity only and must never perform a paid embedding call.
  const probe = openMemoryDb({ path, readOnly: true });
  let dimension: number;
  let embeddingModel: string | undefined;
  try {
    dimension = probe.vectorDimension();
    const state = probe.validationSnapshot();
    if (state.embeddingModels.length > 1) {
      throw new Error("memory-rebuild: active legacy index contains multiple embedding model identities.");
    }
    embeddingModel = probe.indexMetadata()?.embeddingModel ?? state.embeddingModels[0];
    if (state.vectors > 0 && embeddingModel === undefined) {
      throw new Error(
        "memory-rebuild: active legacy vectors have no embedding model identity; recover them under their prior configuration.",
      );
    }
  } finally {
    probe.close();
  }
  return openMemoryDb({
    path,
    dim: dimension,
    ...(embeddingModel === undefined ? {} : { embeddings: noCallEmbeddings(embeddingModel) }),
  });
}

function activeDbPathFromManifest(root: string, manifest: ManagedIndexManifest | undefined): string {
  if (manifest !== undefined) return managedGenerationDbPath(root, manifest.active.name, true);
  const path = join(root, "memory.db");
  if (existsSync(path)) assertSafeRegularFile(root, path, "legacy memory database");
  return path;
}

function validateCurrentReplayDb(path: string, descriptor: ManagedGeneration | undefined): void {
  if (descriptor !== undefined) {
    validateRetainedGeneration(path, descriptor);
    return;
  }
  const db = openMemoryDb({ path, readOnly: true });
  try {
    if (db.integrityCheck().toLowerCase() !== "ok") {
      throw new Error("memory-rebuild: active legacy SQLite integrity check failed.");
    }
    const actualDimension = db.vectorDimension();
    const metadata = db.indexMetadata();
    const state = db.validationSnapshot();
    if (state.ftsRows !== state.memories || state.ftsMismatches !== 0 || state.vectorOrphans !== 0
      || state.vectorIdentityMissing !== 0 || state.contentHashOrphans !== 0
      || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
      throw new Error("memory-rebuild: active legacy index failed replay coverage validation.");
    }
    if (state.embeddingModels.length > 1 || state.embeddingDimensions.length > 1
      || state.embeddingDimensions.some((dimension) => dimension !== actualDimension)
      || (state.vectors > 0 && (state.embeddingModels.length !== 1 || state.embeddingDimensions.length !== 1))
      || (metadata?.dimension !== undefined && metadata.dimension !== actualDimension)
      || (metadata?.embeddingModel !== undefined
        && state.embeddingModels.some((model) => model !== metadata.embeddingModel))) {
      throw new Error("memory-rebuild: active legacy embedding identity does not match its actual vector DDL.");
    }
  } finally {
    db.close();
  }
}

function noCallEmbeddings(id: string): EmbeddingProvider {
  return {
    id,
    embed: async (): Promise<number[][]> => {
      throw new Error("memory-rebuild: durable replay must not call the embedding provider.");
    },
  };
}

async function adoptLegacyRollback(
  root: string,
  expectedIntegrity?: string,
): Promise<ManagedGeneration | undefined> {
  const legacyPath = join(root, "memory.db");
  if (!existsSync(legacyPath)) return undefined;
  assertSafeRegularFile(root, legacyPath, "legacy memory database");
  const legacyIntegrity = logicalIntegrityDigest(legacyPath);
  if (expectedIntegrity !== undefined && legacyIntegrity !== expectedIntegrity) {
    throw new Error("memory-rebuild: legacy database changed concurrently before it could be retained.");
  }
  const generation = createManagedGeneration(root);
  const actualDimension = await backupRawSqlite(legacyPath, generation.dbPath);
  if (logicalIntegrityDigest(legacyPath) !== legacyIntegrity) {
    throw new Error("memory-rebuild: legacy database changed concurrently while it was being retained.");
  }
  if (logicalIntegrityDigest(generation.dbPath) !== legacyIntegrity) {
    throw new Error("memory-rebuild: legacy backup does not match the pinned source state.");
  }
  const copy = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let embeddingModel: string | undefined;
  let tier!: BujoTier;
  const createdAt = new Date().toISOString();
  try {
    const state = copy.validationSnapshot();
    const models = state.embeddingModels;
    if (models.length > 1) throw new Error("memory-rebuild: legacy index contains multiple embedding model identities.");
    const priorMetadata = copy.indexMetadata();
    embeddingModel = priorMetadata?.embeddingModel ?? models[0];
    const semantic = state.vectors > 0 || embeddingModel !== undefined;
    if (priorMetadata?.tier === "lite" || priorMetadata?.tier === "journal" || priorMetadata?.tier === "bujo") {
      tier = priorMetadata.tier;
    } else if (!semantic) {
      tier = "lite";
    } else {
      tier = state.entities > 0 || state.relations > 0 || state.associations > 0 || existsSync(join(root, "graph.jsonl"))
        ? "bujo"
        : "journal";
    }
    if (tier === "lite") {
      if (semantic || actualDimension !== DEFAULT_VEC_DIM) {
        throw new Error(
          "memory-rebuild: legacy index identity cannot be represented as Lite; first rebuild it under its prior semantic configuration.",
        );
      }
      embeddingModel = undefined;
    } else if (embeddingModel === undefined) {
      throw new Error(
        "memory-rebuild: legacy semantic index has no embedding-model identity; first rebuild it under its prior configuration.",
      );
    }
  } finally {
    copy.close();
  }
  if (tier === "bujo" && readReplayProjectionStrict(root).state.kind === "missing") {
    const legacy = openMemoryDb({ path: generation.dbPath, readOnly: true, dim: actualDimension });
    try {
      const replay = replayProjectionDbSnapshot(legacy);
      if (replay.terminals.length > 0 || replay.supersedes.length > 0 || replay.threads.length > 0) {
        throw new Error(
          `memory-rebuild: ${REPLAY_PROJECTION_FILE} is missing while the legacy BuJo index contains replay state; `
          + "explicit stopped-store replay projection adoption is required.",
        );
      }
    } finally {
      legacy.close();
    }
    // The caller is not performing a BuJo rebuild, so do not invent a BuJo
    // source authority merely to advertise this legacy DB as rollback.
    return undefined;
  }
  const source = snapshotCanonicalSources(root, tier);
  const plan = buildPlan(source, tier);
  const descriptorBase: ManagedGeneration = {
    name: generation.name,
    tier,
    sourceFingerprint: source.fingerprint,
    policyVersion: MEMORY_REBUILD_POLICY_VERSION,
    createdAt,
    origin: "legacy-snapshot",
    skippedRawRecords: plan.skippedRawRecords,
    skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
    skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
    missingIdentityLocations: plan.missingIdentityLocations,
    skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
    legacySourceLocations: plan.legacySourceLocations,
    skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
    parsedSourceItems: plan.parsedSourceItems,
    derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
    ...(embeddingModel === undefined ? {} : { embeddingModel, dimension: actualDimension }),
  };

  // A pre-managed database remains byte-for-byte preserved at memory.db even
  // when it differs from canonical source, but it must not be advertised as a
  // one-command rollback. Only an exact, repairable mirror becomes managed.
  if (!hasTierExactSourceParity(generation.dbPath, descriptorBase, plan, true)) return undefined;
  normalizeRollbackToPlan(generation.dbPath, plan);
  if (!hasTierExactSourceParity(generation.dbPath, descriptorBase, plan, false)) return undefined;

  const managed = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let integrityDigest!: string;
  try {
    managed.setIndexMetadata({
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      tier,
      sourceFingerprint: source.fingerprint,
      generation: generation.name,
      createdAt,
      skippedRawRecords: plan.skippedRawRecords,
      skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
      skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
      missingIdentityLocations: plan.missingIdentityLocations,
      skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
      legacySourceLocations: plan.legacySourceLocations,
      skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
      parsedSourceItems: plan.parsedSourceItems,
      derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      ...(embeddingModel === undefined ? {} : { embeddingModel, dimension: actualDimension }),
    });
    managed.checkpoint();
    integrityDigest = managed.logicalIntegrityDigest();
  } finally {
    managed.close();
  }
  const descriptor: ManagedGeneration = { ...descriptorBase, integrityDigest };
  fsyncFile(generation.dbPath);
  fsyncDirectory(generation.dir);
  validateRollbackSnapshot(generation.dbPath, descriptor, plan);
  return descriptor;
}

async function snapshotCurrentRollback(
  root: string,
  active: ManagedGeneration | undefined,
  snapshot: SourceSnapshot,
  expectedIntegrity: string,
): Promise<ManagedGeneration | undefined> {
  if (active === undefined) return await adoptLegacyRollback(root, expectedIntegrity);
  const sourcePath = managedGenerationDbPath(root, active.name, true);
  if (logicalIntegrityDigest(sourcePath, active) !== expectedIntegrity) {
    throw new Error("memory-rebuild: active database changed concurrently before it could be retained.");
  }
  validateRetainedGeneration(sourcePath, active);
  // Never turn the formerly writable active path into an immutable rollback
  // in place. An online backup gets its own generation, canonical repair, WAL
  // boundary, and logical commitment before the manifest can advertise it.
  return await snapshotDatabaseForRollback(
    root,
    sourcePath,
    snapshot,
    active,
    expectedIntegrity,
  );
}

async function snapshotDatabaseForRollback(
  root: string,
  sourcePath: string,
  snapshot: SourceSnapshot,
  preservedIdentity: ManagedGeneration,
  expectedIntegrity: string,
): Promise<ManagedGeneration | undefined> {
  const tier = preservedIdentity.tier;
  const plan = buildPlan(snapshot, tier);
  if (!hasTierExactSourceParity(sourcePath, preservedIdentity, plan, true)) return undefined;

  const generation = createManagedGeneration(root);
  const actualDimension = await backupRawSqlite(sourcePath, generation.dbPath);
  if (logicalIntegrityDigest(sourcePath, preservedIdentity) !== expectedIntegrity) {
    throw new Error("memory-rebuild: active database changed concurrently while it was being retained.");
  }
  if (logicalIntegrityDigest(generation.dbPath, preservedIdentity) !== expectedIntegrity) {
    throw new Error("memory-rebuild: retained backup does not match the pinned active database state.");
  }
  // Re-check the online copy before changing its metadata. A concurrent source
  // mutation may produce a structurally valid backup that no longer mirrors
  // the canonical tier snapshot; such a copy must never be stamped as current.
  if (!hasTierExactSourceParity(generation.dbPath, preservedIdentity, plan, true)) return undefined;
  normalizeRollbackToPlan(generation.dbPath, plan);
  if (!hasTierExactSourceParity(generation.dbPath, preservedIdentity, plan, false)) return undefined;

  const embeddingModel = preservedIdentity.embeddingModel;
  const createdAt = new Date().toISOString();
  const descriptorBase: ManagedGeneration = {
    name: generation.name,
    tier,
    sourceFingerprint: snapshot.fingerprint,
    policyVersion: MEMORY_REBUILD_POLICY_VERSION,
    createdAt,
    origin: "legacy-snapshot",
    skippedRawRecords: plan.skippedRawRecords,
    skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
    skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
    missingIdentityLocations: plan.missingIdentityLocations,
    skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
    legacySourceLocations: plan.legacySourceLocations,
    skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
    parsedSourceItems: plan.parsedSourceItems,
    derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
    ...(embeddingModel === undefined ? {} : {
      embeddingModel,
      dimension: preservedIdentity.dimension ?? actualDimension,
    }),
  };
  const copy = openMemoryDb({ path: generation.dbPath, dim: actualDimension });
  let integrityDigest!: string;
  try {
    copy.setIndexMetadata({
      schemaVersion: MANAGED_INDEX_SCHEMA_VERSION,
      policyVersion: MEMORY_REBUILD_POLICY_VERSION,
      tier,
      sourceFingerprint: snapshot.fingerprint,
      generation: generation.name,
      createdAt,
      skippedRawRecords: plan.skippedRawRecords,
      skippedUnstructuredRecords: plan.skippedUnstructuredRecords,
      skippedMissingIdentityRecords: plan.skippedMissingIdentityRecords,
      missingIdentityLocations: plan.missingIdentityLocations,
      skippedLegacySourceRecords: plan.skippedLegacySourceRecords,
      legacySourceLocations: plan.legacySourceLocations,
      skippedJournalDuplicateRecords: plan.skippedJournalDuplicateRecords,
      parsedSourceItems: plan.parsedSourceItems,
      derivedLegacyAssociations: plan.graph.derivedLegacyAssociations,
      ...(embeddingModel === undefined ? {} : {
        embeddingModel,
        dimension: preservedIdentity.dimension ?? actualDimension,
      }),
    });
    copy.checkpoint();
    integrityDigest = copy.logicalIntegrityDigest();
  } finally {
    copy.close();
  }
  const descriptor: ManagedGeneration = { ...descriptorBase, integrityDigest };
  fsyncFile(generation.dbPath);
  fsyncDirectory(generation.dir);
  validateRollbackSnapshot(generation.dbPath, descriptor, plan);
  return descriptor;
}

function normalizeRollbackToPlan(path: string, plan: BuildPlan): void {
  const raw = new BetterSqlite3(path, { fileMustExist: true });
  const recordsById = new Map(plan.records.map((record) => [record.id, record]));
  try {
    const update = raw.prepare(
      `UPDATE memories
       SET valid_from = ?, valid_to = ?, superseded_by = ?, superseded_at = ?,
           source_session = ?, source_file = ?, source_line = ?
       WHERE id = ?`,
    );
    const insertEdge = raw.prepare(
      `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertHash = raw.prepare(
      `INSERT INTO content_hashes (content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)`,
    );
    const normalize = raw.transaction(() => {
      for (const record of plan.records) {
        const result = update.run(
          record.validFrom ?? null,
          record.validTo ?? null,
          record.supersededBy ?? null,
          record.supersededAt ?? null,
          record.source.session ?? null,
          record.source.file ?? null,
          record.source.line ?? null,
          record.id,
        );
        if (result.changes !== 1) {
          throw new Error("memory-rebuild: rollback normalization lost a canonical memory row.");
        }
      }
      raw.prepare(`DELETE FROM edges`).run();
      for (const support of plan.graph.collectionSupports) {
        insertEdge.run(
          support.memoryId,
          support.entityId,
          "supports",
          1,
          canonicalSupportCreatedAt(plan.graph, support.memoryId, support.entityId),
        );
      }
      for (const supersede of plan.replay.supersedes) {
        insertEdge.run(supersede.src, supersede.dst, "supersedes", 1, supersede.at);
      }
      for (const thread of plan.replay.threads) {
        insertEdge.run(thread.src, thread.dst, "thread", thread.weight, thread.at);
      }
      raw.prepare(`DELETE FROM content_hashes`).run();
      for (const [contentHash, memoryId] of plan.contentHashes) {
        const record = recordsById.get(memoryId);
        if (record?.source.file === undefined) {
          throw new Error("memory-rebuild: rollback Journal normalization lost source provenance.");
        }
        insertHash.run(contentHash, memoryId, record.source.file, record.createdAt);
      }
    });
    normalize();
    raw.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

function assertConfiguredIdentity(target: ManagedGeneration, options: SafeMemoryIndexOptions): void {
  if (target.tier !== options.tier
    || target.embeddingModel !== options.embeddings?.id
    || target.dimension !== options.dim) {
    throw new Error(
      `memory-rebuild: rollback target requires tier=${target.tier}, model=${target.embeddingModel ?? "none"}, `
      + `dim=${target.dimension ?? "none"}; revert configuration before rollback.`,
    );
  }
}

function assertSafeRebuildOptions(options: SafeMemoryIndexOptions): void {
  if (options.tier === "lite") {
    if (options.embeddings !== undefined || options.dim !== undefined) {
      throw new Error("memory-rebuild: lite rebuild rejects embeddings and dimensions.");
    }
    return;
  }
  if (options.embeddings === undefined || options.dim === undefined || !Number.isInteger(options.dim) || options.dim <= 0) {
    throw new Error(`memory-rebuild: ${options.tier} rebuild requires embeddings and an explicit positive dimension.`);
  }
}

function readOnlyDb(path: string, descriptor: ManagedGeneration): MemoryDb {
  return openMemoryDb({ path, readOnly: true, dim: descriptor.dimension ?? DEFAULT_VEC_DIM });
}

function identityOf(path: string): { readonly dev: number; readonly ino: number; readonly size: number } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("memory-rebuild: identity target became a symlink.");
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSameIdentity(
  path: string,
  expected: { readonly dev: number; readonly ino: number },
  label: string,
): void {
  if (!sameIdentity(identityOf(path), expected)) throw new Error(`memory-rebuild: ${label} was replaced concurrently.`);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function logicalIntegrityDigest(path: string, descriptor?: ManagedGeneration): string {
  const db = openMemoryDb({
    path,
    readOnly: true,
    dim: descriptor?.dimension ?? DEFAULT_VEC_DIM,
  });
  try {
    return db.logicalIntegrityDigest();
  } finally {
    db.close();
  }
}

/**
 * When the new candidate re-embedded the exact same source with the exact same
 * provider identity, it is an independent vector oracle we already paid for.
 * Journal may retain missing vectors, but every vector it does retain must
 * equal the candidate. Other tier/model/source migrations have no comparable
 * no-call oracle and rely on the pinned online-backup commitment instead.
 */
function retainedVectorsMatchCandidate(
  candidatePath: string,
  candidate: ManagedGeneration,
  retainedPath: string,
  retained: ManagedGeneration,
): boolean {
  if (candidate.tier !== retained.tier
    || candidate.sourceFingerprint !== retained.sourceFingerprint
    || candidate.embeddingModel !== retained.embeddingModel
    || candidate.dimension !== retained.dimension) return true;
  const candidateDb = readOnlyDb(candidatePath, candidate);
  const retainedDb = readOnlyDb(retainedPath, retained);
  try {
    const expected = new Map(candidateDb.vectorPayloadDigests().map((entry) => [entry.memoryId, entry.sha256]));
    return retainedDb.vectorPayloadDigests().every((entry) => expected.get(entry.memoryId) === entry.sha256);
  } finally {
    retainedDb.close();
    candidateDb.close();
  }
}

function sameKeyedInventory<Left, Right>(
  left: readonly Left[],
  right: readonly Right[],
  leftKey: (value: Left) => string,
  rightKey: (value: Right) => string,
): boolean {
  if (left.length !== right.length) return false;
  const inventory = new Map<string, string>();
  for (const value of left) {
    const key = leftKey(value);
    if (inventory.has(key)) return false;
    inventory.set(key, canonicalJson(value));
  }
  for (const value of right) {
    const key = rightKey(value);
    if (inventory.get(key) !== canonicalJson(value)) return false;
    inventory.delete(key);
  }
  return inventory.size === 0;
}

function relationKey(value: { readonly src: string; readonly dst: string; readonly relation: string }): string {
  return `${value.src}\0${value.dst}\0${value.relation}`;
}

function associationKey(value: { readonly memoryId: string; readonly entityId: string }): string {
  return `${value.memoryId}\0${value.entityId}`;
}

function edgeKey(value: { readonly src: string; readonly dst: string; readonly kind: string }): string {
  return `${value.src}\0${value.dst}\0${value.kind}`;
}

/**
 * Legacy-name-match rows are a deterministic cache and may be stale on the
 * one explicit adoption boundary. Model-produced capture evidence remains an
 * exact bidirectional commitment.
 */
function safeRepairableAssociationInventory(
  actual: readonly MemoryEntityAssociation[],
  expected: readonly MemoryEntityAssociation[],
  memories: ReadonlyMap<string, MemoryRecord>,
  entities: ReadonlyMap<string, EntityRecord>,
): boolean {
  const actualCapture = actual.filter((association) => association.provenance === "capture");
  const expectedCapture = expected.filter((association) => association.provenance === "capture");
  if (!sameKeyedInventory(actualCapture, expectedCapture, associationKey, associationKey)) return false;
  return actual.every((association) => {
    const memory = memories.get(association.memoryId);
    return (association.provenance === "capture" || association.provenance === "legacy-name-match")
      && memory !== undefined
      && entities.has(association.entityId)
      && (isExactIsoTimestamp(association.createdAt)
        || (association.provenance === "legacy-name-match"
          && isCanonicalMemoryTimestamp(association.createdAt, memory)));
  });
}

/**
 * Pre-projection databases may retain graph-owned supports/about mirrors.
 * They are safe to normalize only when their canonical endpoints and an
 * active or canonical association independently attest the pair.
 */
function safeRepairableEdgeInventory(
  actual: readonly { src: string; dst: string; kind: string; weight: number; createdAt: string }[],
  actualAssociations: readonly MemoryEntityAssociation[],
  expectedAssociations: readonly MemoryEntityAssociation[],
  memories: ReadonlyMap<string, MemoryRecord>,
  entities: ReadonlyMap<string, EntityRecord>,
): boolean {
  const associatedPairs = new Set([
    ...actualAssociations.map(associationKey),
    ...expectedAssociations.map(associationKey),
  ]);
  return actual.every((edge) => {
    if (edge.kind === "thread" || edge.kind === "supersedes") return true;
    if (edge.kind !== "supports" && edge.kind !== "about") return false;
    const memory = memories.get(edge.src);
    const entity = entities.get(edge.dst);
    if (memory === undefined || entity === undefined
      || !associatedPairs.has(associationKey({ memoryId: edge.src, entityId: edge.dst }))
      || !Number.isFinite(edge.weight) || edge.weight <= 0 || edge.weight > 1
      || !isExactIsoTimestamp(edge.createdAt)) return false;
    if (edge.kind === "supports") {
      return edge.weight === 1 && memory.status === "migrated" && entity.type === "collection";
    }
    return true;
  });
}

function isExactIsoTimestamp(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

/**
 * Historical canonical bullets may use a valid ISO offset form instead of the
 * normalized `toISOString()` spelling. A derived legacy cache row is still
 * safe to replace when it preserves that exact, already parity-checked memory
 * timestamp; arbitrary or capture-authored timestamp drift remains rejected.
 */
function isCanonicalMemoryTimestamp(value: string, memory: MemoryRecord): boolean {
  return value === memory.createdAt && Number.isFinite(Date.parse(value));
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function stableJson(values: readonly unknown[]): string {
  return JSON.stringify(values.map(canonicalJsonValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function memoryPayload(
  record: MemoryRecord | undefined,
  omitRepairableSourceProvenance = false,
  omitDerivedCollection = false,
  omitMutableLiveState = false,
): unknown {
  if (record === undefined) return undefined;
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    text: record.text,
    salience: record.salience,
    isInsight: record.isInsight,
    createdAt: record.createdAt,
    ...(omitMutableLiveState || record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    ...(record.supersededAt === undefined ? {} : { supersededAt: record.supersededAt }),
    ...(record.dueAt === undefined ? {} : { dueAt: record.dueAt }),
    ...(omitDerivedCollection || record.collection === undefined ? {} : { collection: record.collection }),
    ...(omitMutableLiveState ? {} : { tags: [...record.tags] }),
    source: omitRepairableSourceProvenance
      ? { ...(record.source.file === undefined ? {} : { file: record.source.file }) }
      : { ...record.source },
  };
}

const LEGACY_DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/u;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import { join } from "node:path";

import {
  openMemoryDb,
  type IndexMetadata,
  type MemoryDb,
} from "../store/index.js";
import {
  auditCanonicalIndexHealth,
  readCanonicalSourceFingerprint,
  validateManagedGenerationDb,
  type CanonicalIndexHealthAudit,
} from "./rebuild.js";
import {
  auditCompletedTurnIntakeHealthState,
  type CompletedTurnIntakeAudit,
  type CompletedTurnIntakeHealthAudit,
} from "./capture-intake.js";
import {
  auditCaptureOutboxHealthState,
  type CaptureOutboxHealthAudit,
} from "./capture-outbox.js";
import {
  assertSafeSqlitePathState,
  captureManagedManifestState,
  captureSafeSqlitePathState,
  managedGenerationDbPath,
  readManagedIndexManifestForAudit,
  type ManagedGeneration,
  type ManagedIndexManifest,
  type ManagedManifestState,
  type SafeSqlitePathState,
} from "./generations.js";
import { inspectJournalWriteLock } from "./daily.js";
import { canonicalMemoryRootPath } from "./path-safety.js";
import {
  auditReplayProjectionTemporaryArtifacts,
  type ReplayProjectionTemporaryAudit,
} from "./replay-projection.js";
import {
  BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS,
  readBujoRuntimeSnapshot,
  type BujoRuntimeSnapshotObservation,
} from "./runtime-snapshot.js";
import type { BujoTier } from "./types.js";

export const BUJO_MEMORY_HEALTH_SCHEMA_VERSION = 1;

export type MemoryHealthStatus = "healthy" | "in_progress" | "degraded" | "unhealthy" | "unknown";

export const MEMORY_HEALTH_ISSUE_CODES = [
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "mutation_in_progress",
  "intake_invalid",
  "intake_pending",
  "dead_letters",
  "outbox_invalid",
  "outbox_pending",
  "work_stalled",
  "temporary_artifacts",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
] as const;

export type MemoryHealthIssueCode = (typeof MEMORY_HEALTH_ISSUE_CODES)[number];

export interface MemoryHealthCounts {
  readonly pending: number;
  readonly due: number;
  readonly dead: number;
  readonly outbox: number;
  readonly temporary: number;
  readonly memories: number;
  readonly vectors: number;
  readonly missingVectors: number;
}

export interface BujoMemoryHealthOptions {
  readonly root: string;
  readonly mode: BujoTier;
  readonly configuredEmbeddingModel?: string;
  readonly configuredDimension?: number;
  readonly now?: Date;
}

/** Closed, metadata-only health contract. No paths, ids, text, or raw errors. */
export interface BujoMemoryHealthReport {
  readonly schemaVersion: typeof BUJO_MEMORY_HEALTH_SCHEMA_VERSION;
  readonly backend: "bujo";
  readonly mode: BujoTier;
  readonly status: MemoryHealthStatus;
  readonly checkedAt: string;
  readonly issues: readonly MemoryHealthIssueCode[];
  readonly counts: MemoryHealthCounts;
}

interface DbObservation {
  readonly integrityOk: boolean;
  readonly metadataValid: boolean;
  readonly metadata?: IndexMetadata;
  readonly vectorDimensionValid: boolean;
  readonly vectorDimension?: number;
  readonly state?: ReturnType<MemoryDb["validationSnapshot"]>;
  readonly canonical?: CanonicalIndexHealthAudit;
}

interface AuditAttempt {
  readonly issues: ReadonlySet<MemoryHealthIssueCode>;
  readonly counts: MemoryHealthCounts;
  readonly unstable: boolean;
}

interface RollbackSourceObservation {
  readonly status: "absent" | "match" | "mismatch" | "invalid";
  readonly fingerprint?: string;
}

const MAX_STABILITY_ATTEMPTS = 3;

/** Provider-free strict health across managed identity, SQLite, canonical state, queues, and runtime. */
export function auditBujoMemoryHealth(options: BujoMemoryHealthOptions): BujoMemoryHealthReport {
  assertOptions(options);
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  let last: AuditAttempt | undefined;
  for (let attempt = 1; attempt <= MAX_STABILITY_ATTEMPTS; attempt += 1) {
    last = auditAttempt(options, now);
    if (!last.unstable) return report(options.mode, checkedAt, last.issues, last.counts);
  }
  if (last !== undefined && !last.unstable) {
    return report(options.mode, checkedAt, last.issues, last.counts);
  }
  const issues = new Set<MemoryHealthIssueCode>(["mutation_in_progress"]);
  if (last !== undefined) {
    for (const issue of last.issues) {
      if (issue === "intake_pending" || issue === "dead_letters" || issue === "outbox_pending"
        || issue === "runtime_missing" || issue === "runtime_stale" || issue === "runtime_invalid"
        || issue === "intake_invalid" || issue === "outbox_invalid" || issue === "work_stalled"
        || issue === "temporary_artifacts") {
        issues.add(issue);
      }
    }
  }
  return report(options.mode, checkedAt, issues, last?.counts ?? emptyCounts());
}

function auditAttempt(options: BujoMemoryHealthOptions, now: Date): AuditAttempt {
  const issues = new Set<MemoryHealthIssueCode>();
  const counts = mutableCounts();
  let root: string;
  try {
    root = canonicalMemoryRootPath(options.root, false);
  } catch (error) {
    const missing = errorCode(error) === "ENOENT";
    if (options.mode !== "lite") issues.add("manifest_missing");
    issues.add(missing ? "database_missing" : "database_unavailable");
    issues.add("runtime_missing");
    return { issues, counts, unstable: false };
  }

  let manifestStateBefore: ManagedManifestState | undefined;
  let manifest: ManagedIndexManifest | undefined;
  let manifestValid = true;
  try {
    manifestStateBefore = captureManagedManifestState(root);
  } catch {
    manifestValid = false;
    issues.add("manifest_invalid");
  }
  try {
    if (manifestValid) manifest = readManagedIndexManifestForAudit(root);
  } catch {
    manifestValid = false;
    issues.add("manifest_invalid");
  }
  if (manifestValid && manifest === undefined && options.mode !== "lite") issues.add("manifest_missing");
  let rollbackSourceBefore: RollbackSourceObservation = { status: "absent" };
  if (manifest !== undefined) {
    inspectConfiguredIdentity(options, manifest.active, issues);
    inspectManagedReferences(root, manifest, issues);
    rollbackSourceBefore = inspectRollbackSource(root, manifest.rollback);
    applyRollbackSourceHealth(rollbackSourceBefore, issues);
  }

  const intakeHealthBefore = auditCompletedTurnIntakeHealthState(root, now);
  const outboxHealthBefore = auditCaptureOutboxHealthState(root);
  const replayTemporaryBefore = auditReplayProjectionTemporaryArtifacts(root);
  const intakeBefore = intakeHealthBefore.audit;
  const runtimeBefore = readBujoRuntimeSnapshot(root, now);
  applyDurableQueueHealth(
    intakeHealthBefore,
    outboxHealthBefore,
    replayTemporaryBefore,
    runtimeShowsActiveIntakeRetry(options.mode, runtimeBefore, intakeBefore),
    now,
    issues,
    counts,
  );
  const journalMutationBefore = inspectJournalWriteMutation(root, options.mode, now);
  if (journalMutationBefore === "active") issues.add("mutation_in_progress");
  else if (journalMutationBefore === "invalid") issues.add("canonical_invalid");

  if (manifestValid) {
    inspectDatabase(
      root,
      options,
      manifest,
      issues,
      counts,
      journalMutationBefore === "active" || runtimeIndicatesCanonicalMutation(options.mode, runtimeBefore),
    );
  }
  inspectRuntime(options.mode, runtimeBefore, intakeBefore, counts, issues);

  let manifestStable = manifestStateBefore === undefined;
  if (manifestStateBefore !== undefined) {
    try {
      const manifestStateAfter = captureManagedManifestState(root);
      manifestStable = sameManifestState(manifestStateBefore, manifestStateAfter);
    } catch {
      manifestStable = false;
    }
  }
  const intakeHealthAfter = auditCompletedTurnIntakeHealthState(root, now);
  const outboxHealthAfter = auditCaptureOutboxHealthState(root);
  const replayTemporaryAfter = auditReplayProjectionTemporaryArtifacts(root);
  const runtimeAfter = readBujoRuntimeSnapshot(root, now);
  const journalMutationAfter = inspectJournalWriteMutation(root, options.mode, now);
  const rollbackSourceAfter = manifest === undefined
    ? { status: "absent" } as const
    : inspectRollbackSource(root, manifest.rollback);
  const unstable = !manifestStable
    || durableQueueSignature(intakeHealthBefore, outboxHealthBefore, replayTemporaryBefore)
      !== durableQueueSignature(intakeHealthAfter, outboxHealthAfter, replayTemporaryAfter)
    || runtimeQueueSignature(runtimeBefore) !== runtimeQueueSignature(runtimeAfter)
    || journalMutationBefore !== journalMutationAfter
    || rollbackSourceSignature(rollbackSourceBefore) !== rollbackSourceSignature(rollbackSourceAfter);
  return { issues, counts, unstable };
}

function inspectDatabase(
  root: string,
  options: BujoMemoryHealthOptions,
  manifest: ManagedIndexManifest | undefined,
  issues: Set<MemoryHealthIssueCode>,
  counts: Mutable<MemoryHealthCounts>,
  skipCanonical: boolean,
): void {
  const descriptor = manifest?.active;
  const path = descriptor === undefined
    ? join(root, "memory.db")
    : managedGenerationDbPath(root, descriptor.name, false);
  let pathState: SafeSqlitePathState;
  try {
    pathState = captureSafeSqlitePathState(root, path, "memory health database");
  } catch (error) {
    issues.add(errorCode(error) === "ENOENT" ? "database_missing" : "database_unavailable");
    return;
  }
  if (!pathState.exists) {
    issues.add("database_missing");
    return;
  }

  let db: MemoryDb | undefined;
  try {
    db = openMemoryDb({ path, readOnly: true });
    assertSafeSqlitePathState(root, path, pathState, "memory health database");
    const opened = db;
    let observation: DbObservation;
    try {
      observation = opened.withAuditSnapshot(() => inspectDbSnapshot(
        root,
        options.mode,
        opened,
        !issues.has("outbox_invalid") && !skipCanonical,
      ));
    } catch (error) {
      issues.add(isNativeModuleError(error) ? "native_module_unavailable" : "database_unavailable");
      return;
    }
    applyDbObservation(options, descriptor, observation, issues, counts);
  } catch (error) {
    issues.add(isNativeModuleError(error) ? "native_module_unavailable" : "database_unavailable");
  } finally {
    if (db !== undefined) {
      try { db.close(); } catch { issues.add("database_unavailable"); }
    }
  }
}

function inspectDbSnapshot(root: string, mode: BujoTier, db: MemoryDb, inspectCanonical: boolean): DbObservation {
  const integrityOk = db.integrityCheck().toLowerCase() === "ok";
  if (!integrityOk) return { integrityOk: false, metadataValid: true, vectorDimensionValid: true };
  let metadata: IndexMetadata | undefined;
  let metadataValid = true;
  try {
    metadata = db.indexMetadata();
  } catch {
    metadataValid = false;
  }
  let vectorDimension: number | undefined;
  let vectorDimensionValid = true;
  try {
    vectorDimension = db.vectorDimension();
  } catch {
    vectorDimensionValid = false;
  }
  return {
    integrityOk,
    metadataValid,
    ...(metadata === undefined ? {} : { metadata }),
    vectorDimensionValid,
    ...(vectorDimension === undefined ? {} : { vectorDimension }),
    state: db.validationSnapshot(),
    ...(inspectCanonical ? { canonical: auditCanonicalIndexHealth(root, mode, db) } : {}),
  };
}

function applyDbObservation(
  options: BujoMemoryHealthOptions,
  descriptor: ManagedGeneration | undefined,
  observation: DbObservation,
  issues: Set<MemoryHealthIssueCode>,
  counts: Mutable<MemoryHealthCounts>,
): void {
  if (!observation.integrityOk) {
    issues.add("sqlite_integrity_failed");
    return;
  }
  const state = observation.state;
  if (state === undefined) {
    issues.add("database_unavailable");
    return;
  }
  counts.memories = state.memories;
  counts.vectors = state.vectors;
  counts.missingVectors = options.mode === "lite" ? 0 : Math.max(0, state.memories - state.vectors);

  if (!observation.metadataValid
    || (descriptor !== undefined && (observation.metadata === undefined
      || !metadataMatchesGeneration(observation.metadata, descriptor)))) {
    issues.add("metadata_mismatch");
  }
  if (descriptor === undefined && observation.metadata !== undefined) {
    if (observation.metadata.tier !== options.mode
      || (options.configuredEmbeddingModel !== undefined
        && observation.metadata.embeddingModel !== options.configuredEmbeddingModel)
      || (options.configuredDimension !== undefined
        && observation.metadata.dimension !== options.configuredDimension)) {
      issues.add("configured_identity_mismatch");
    }
  }

  if (state.ftsRows !== state.memories || state.ftsMismatches !== 0) issues.add("fts_mismatch");
  if (state.vectorOrphans !== 0 || state.contentHashOrphans !== 0
    || state.relationOrphans !== 0 || state.associationOrphans !== 0) {
    issues.add("orphaned_rows");
  }
  const expectedModel = descriptor?.embeddingModel ?? options.configuredEmbeddingModel;
  const expectedDimension = descriptor?.dimension ?? options.configuredDimension;
  const invalidCoverage = options.mode === "lite"
    ? state.vectors !== 0
    : options.mode === "bujo"
      ? state.vectors !== state.memories
      : state.vectors > state.memories;
  const invalidVectorIdentity = state.vectorIdentityMissing !== 0
    || (expectedModel === undefined
      ? state.embeddingModels.length !== 0
      : state.embeddingModels.some((model) => model !== expectedModel))
    || (expectedDimension === undefined
      ? state.embeddingDimensions.length !== 0
      : state.embeddingDimensions.some((dimension) => dimension !== expectedDimension))
    || (expectedDimension !== undefined && observation.vectorDimension !== expectedDimension);
  if (!observation.vectorDimensionValid || invalidCoverage || state.vectorOrphans !== 0 || invalidVectorIdentity) {
    issues.add("vector_mismatch");
  } else if (options.mode === "journal" && counts.missingVectors > 0) {
    issues.add("mutation_in_progress");
  }

  if (observation.canonical?.status === "mismatch") issues.add("canonical_mismatch");
  else if (observation.canonical?.status === "invalid") issues.add("canonical_invalid");
  else if (observation.canonical?.status === "in_progress") issues.add("mutation_in_progress");
}

function inspectConfiguredIdentity(
  options: BujoMemoryHealthOptions,
  active: ManagedGeneration,
  issues: Set<MemoryHealthIssueCode>,
): void {
  if (active.tier !== options.mode
    || (options.configuredEmbeddingModel !== undefined
      && active.embeddingModel !== options.configuredEmbeddingModel)
    || (options.configuredDimension !== undefined && active.dimension !== options.configuredDimension)) {
    issues.add("configured_identity_mismatch");
  }
  if (active.tier !== "lite" && (active.embeddingModel === undefined || active.dimension === undefined)) {
    issues.add("manifest_invalid");
  }
}

function inspectManagedReferences(
  root: string,
  manifest: ManagedIndexManifest,
  issues: Set<MemoryHealthIssueCode>,
): void {
  const descriptor = manifest.rollback;
  if (descriptor === undefined) return;
  if (descriptor.integrityDigest === undefined) {
    issues.add("manifest_invalid");
    return;
  }
  let path: string;
  let pathState: SafeSqlitePathState;
  try {
    path = managedGenerationDbPath(root, descriptor.name, false);
    pathState = captureSafeSqlitePathState(root, path, "memory health rollback database");
    if (!pathState.exists) {
      issues.add("manifest_invalid");
      return;
    }
  } catch {
    issues.add("manifest_invalid");
    return;
  }

  let db: MemoryDb | undefined;
  try {
    db = openMemoryDb({ path, readOnly: true });
    assertSafeSqlitePathState(root, path, pathState, "memory health rollback database");
    const result = db.withAuditSnapshot(() => {
      const validationIssues = validateManagedGenerationDb(db!, descriptor);
      return { validationIssues, digest: db!.logicalIntegrityDigest() };
    });
    for (const issue of result.validationIssues) issues.add(issue);
    if (result.digest !== descriptor.integrityDigest) issues.add("sqlite_integrity_failed");
  } catch (error) {
    issues.add(isNativeModuleError(error) ? "native_module_unavailable" : "database_unavailable");
  } finally {
    if (db !== undefined) {
      try { db.close(); } catch { issues.add("database_unavailable"); }
    }
  }
}

function inspectRollbackSource(
  root: string,
  descriptor: ManagedGeneration | undefined,
): RollbackSourceObservation {
  if (descriptor === undefined) return { status: "absent" };
  try {
    const fingerprint = readCanonicalSourceFingerprint(root, descriptor.tier);
    return {
      status: fingerprint === descriptor.sourceFingerprint ? "match" : "mismatch",
      fingerprint,
    };
  } catch {
    return { status: "invalid" };
  }
}

function applyRollbackSourceHealth(
  observation: RollbackSourceObservation,
  issues: Set<MemoryHealthIssueCode>,
): void {
  if (observation.status === "mismatch") issues.add("canonical_mismatch");
  else if (observation.status === "invalid") issues.add("canonical_invalid");
}

function applyDurableQueueHealth(
  intakeHealth: CompletedTurnIntakeHealthAudit,
  outboxHealth: CaptureOutboxHealthAudit,
  replayTemporary: ReplayProjectionTemporaryAudit,
  activeIntakeRetry: boolean,
  now: Date,
  issues: Set<MemoryHealthIssueCode>,
  counts: Mutable<MemoryHealthCounts>,
): void {
  const intake = intakeHealth.audit;
  const outbox = outboxHealth.audit;
  counts.pending = intake.counts.pending;
  counts.due = intake.counts.due;
  counts.dead = intake.counts.dead;
  counts.outbox = outbox.pending;
  counts.temporary = intake.counts.temporary + outbox.temporary + replayTemporary.temporary;
  if (!intake.valid) issues.add("intake_invalid");
  if (intake.counts.pending > 0) issues.add("intake_pending");
  if (intake.counts.dead > 0) issues.add("dead_letters");
  if (!outbox.valid) issues.add("outbox_invalid");
  if (outbox.pending > 0) {
    issues.add("outbox_pending");
    issues.add("mutation_in_progress");
  }
  const oldestDueAt = intakeHealth.privateState.oldestDueAt;
  const intakeStalled = oldestDueAt !== undefined
    && now.getTime() - Date.parse(oldestDueAt) >= BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS
    && !activeIntakeRetry;
  const oldestPublishedAt = outboxHealth.privateState.oldestPublishedAt;
  const outboxStalled = oldestPublishedAt !== undefined
    && now.getTime() - Date.parse(oldestPublishedAt) >= BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS;
  if (intakeStalled || outboxStalled) issues.add("work_stalled");
  if (counts.temporary > 0) issues.add("temporary_artifacts");
}

function runtimeShowsActiveIntakeRetry(
  mode: BujoTier,
  runtime: BujoRuntimeSnapshotObservation,
  intake: CompletedTurnIntakeAudit,
): boolean {
  if (!runtime.available || runtime.stale || runtime.snapshot?.tier !== mode
    || runtime.snapshot.state !== "running"
    || runtime.snapshot.queues.shutdown.timedOut
    || runtime.snapshot.queues.shutdown.discarded !== 0) return false;
  const snapshot = runtime.snapshot.queues.intake;
  return snapshot !== undefined
    && snapshot.retrying === 1
    && snapshot.pending === intake.counts.pending
    && snapshot.dead === intake.counts.dead
    && snapshot.due === intake.counts.due
    && snapshot.transitioning === (intake.inspection?.snapshot.transitioning ?? 0)
    && snapshot.accepting
    && snapshot.shutdown === "running";
}

function inspectRuntime(
  mode: BujoTier,
  runtime: BujoRuntimeSnapshotObservation,
  intake: CompletedTurnIntakeAudit,
  counts: MemoryHealthCounts,
  issues: Set<MemoryHealthIssueCode>,
): void {
  if (!runtime.available) {
    issues.add(runtime.reason === "invalid" ? "runtime_invalid" : "runtime_missing");
    return;
  }
  if (runtime.stale) {
    issues.add("runtime_stale");
    return;
  }
  const snapshot = runtime.snapshot;
  if (snapshot === undefined || snapshot.tier !== mode) {
    issues.add("runtime_invalid");
    return;
  }
  if (snapshot.queues.shutdown.timedOut || snapshot.queues.shutdown.discarded > 0) {
    issues.add("runtime_invalid");
  }
  const runtimeIntake = snapshot.queues.intake;
  if (runtimeIntake === undefined) {
    issues.add("runtime_invalid");
  } else if (runtimeIntake.pending !== intake.counts.pending
    || runtimeIntake.dead !== intake.counts.dead
    || runtimeIntake.transitioning !== (intake.inspection?.snapshot.transitioning ?? 0)
    || runtimeIntake.retrying > 1
    || !runtimeIntake.accepting
    || runtimeIntake.shutdown !== "running") {
    issues.add("runtime_invalid");
  }
  if (mode === "journal") {
    if (snapshot.queues.index === undefined) {
      issues.add("runtime_invalid");
    } else if (snapshot.queues.index.remainingBacklog !== counts.missingVectors
      || snapshot.queues.index.recoveryPaused
      || !queueOperational(snapshot.queues.index)) {
      issues.add("runtime_invalid");
    }
    if (snapshot.queues.index?.recoveryFilesRemaining !== 0 || counts.missingVectors > 0) {
      issues.add("mutation_in_progress");
    }
    if (snapshot.queues.capture !== undefined) issues.add("runtime_invalid");
  } else if (mode === "bujo") {
    // The legacy best-effort queue is lazy and absent in the bundled strong-write path. When a
    // direct compatibility caller has activated it, its operational state remains authoritative.
    if ((snapshot.queues.capture !== undefined && !queueOperational(snapshot.queues.capture))
      || snapshot.queues.index !== undefined) {
      issues.add("runtime_invalid");
    }
  } else if (snapshot.queues.index !== undefined || snapshot.queues.capture !== undefined) {
    issues.add("runtime_invalid");
  }
}

function queueOperational(queue: {
  readonly accepting: boolean;
  readonly dropped: number;
  readonly discarded: number;
}): boolean {
  return queue.accepting && queue.dropped === 0 && queue.discarded === 0;
}

function runtimeIndicatesCanonicalMutation(
  mode: BujoTier,
  runtime: BujoRuntimeSnapshotObservation,
): boolean {
  return mode === "journal"
    && runtime.available
    && !runtime.stale
    && (runtime.snapshot?.queues.index?.recoveryFilesRemaining ?? 0) > 0;
}

function inspectJournalWriteMutation(root: string, mode: BujoTier, now: Date): "clear" | "active" | "invalid" {
  if (mode !== "journal") return "clear";
  try {
    const status = inspectJournalWriteLock(root, now.getTime());
    return status === "clear" || status === "active" ? status : "invalid";
  } catch {
    return "invalid";
  }
}

function metadataMatchesGeneration(metadata: IndexMetadata, descriptor: ManagedGeneration): boolean {
  return metadata.schemaVersion === 1
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
    && sameStrings(metadata.missingIdentityLocations, descriptor.missingIdentityLocations)
    && metadata.skippedLegacySourceRecords === descriptor.skippedLegacySourceRecords
    && sameStrings(metadata.legacySourceLocations, descriptor.legacySourceLocations)
    && metadata.skippedJournalDuplicateRecords === descriptor.skippedJournalDuplicateRecords
    && metadata.parsedSourceItems === descriptor.parsedSourceItems
    && metadata.derivedLegacyAssociations === descriptor.derivedLegacyAssociations;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function durableQueueSignature(
  intakeHealth: CompletedTurnIntakeHealthAudit,
  outboxHealth: CaptureOutboxHealthAudit,
  replayTemporary: ReplayProjectionTemporaryAudit,
): string {
  const intake = intakeHealth.audit;
  const outbox = outboxHealth.audit;
  return JSON.stringify({
    intake: {
      valid: intake.valid,
      counts: intake.counts,
      issues: intake.issues,
      inspection: intake.inspection === undefined ? undefined : {
        schemaVersion: intake.inspection.schemaVersion,
        temporary: intake.inspection.temporary,
        snapshot: intake.inspection.snapshot,
      },
    },
    outbox,
    replayTemporary,
    privateState: {
      intake: intakeHealth.privateState,
      outbox: outboxHealth.privateState,
    },
  });
}

function rollbackSourceSignature(observation: RollbackSourceObservation): string {
  return JSON.stringify(observation);
}

function runtimeQueueSignature(runtime: BujoRuntimeSnapshotObservation): string {
  return JSON.stringify({
    available: runtime.available,
    stale: runtime.stale,
    reason: runtime.reason,
    pid: runtime.snapshot?.pid,
    tier: runtime.snapshot?.tier,
    state: runtime.snapshot?.state,
    queues: runtime.snapshot?.queues,
  });
}

function sameManifestState(left: ManagedManifestState, right: ManagedManifestState): boolean {
  return left.exists === right.exists && left.dev === right.dev && left.ino === right.ino && left.sha256 === right.sha256;
}

function report(
  mode: BujoTier,
  checkedAt: string,
  issueSet: ReadonlySet<MemoryHealthIssueCode>,
  counts: MemoryHealthCounts,
): BujoMemoryHealthReport {
  const issues = MEMORY_HEALTH_ISSUE_CODES.filter((issue) => issueSet.has(issue));
  return {
    schemaVersion: BUJO_MEMORY_HEALTH_SCHEMA_VERSION,
    backend: "bujo",
    mode,
    status: statusFor(issues),
    checkedAt,
    issues,
    counts: { ...counts },
  };
}

function statusFor(issues: readonly MemoryHealthIssueCode[]): MemoryHealthStatus {
  if (issues.some((issue) => issue === "database_unavailable" || issue === "native_module_unavailable"
    || issue === "health_check_failed")) return "unknown";
  if (issues.some((issue) => UNHEALTHY_ISSUES.has(issue))) return "unhealthy";
  if (issues.some((issue) => issue === "dead_letters" || issue === "runtime_missing"
    || issue === "runtime_stale" || issue === "runtime_invalid" || issue === "work_stalled")) return "degraded";
  if (issues.length > 0) return "in_progress";
  return "healthy";
}

const UNHEALTHY_ISSUES = new Set<MemoryHealthIssueCode>([
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "intake_invalid",
  "outbox_invalid",
  "temporary_artifacts",
]);

function isNativeModuleError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "ERR_DLOPEN_FAILED" || code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return true;
  let message = "";
  try {
    if (typeof error === "object" && error !== null && "message" in error
      && typeof (error as { readonly message?: unknown }).message === "string") {
      message = (error as { readonly message: string }).message;
    }
  } catch {
    return false;
  }
  return /(?:node_module_version|could not locate the bindings file|dlopen|wrong architecture|mach-o|shared object|sqlite[-_]vec)/iu
    .test(message);
}

function errorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function assertOptions(options: BujoMemoryHealthOptions): void {
  if (typeof options.root !== "string" || options.root.length === 0
    || (options.mode !== "lite" && options.mode !== "journal" && options.mode !== "bujo")
    || (options.configuredEmbeddingModel !== undefined
      && (typeof options.configuredEmbeddingModel !== "string" || options.configuredEmbeddingModel.length === 0))
    || (options.configuredDimension !== undefined
      && (!Number.isInteger(options.configuredDimension) || options.configuredDimension <= 0))) {
    throw new Error("memory-bujo: invalid strict health options.");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("memory-bujo: invalid strict health timestamp.");
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function mutableCounts(): Mutable<MemoryHealthCounts> {
  return { pending: 0, due: 0, dead: 0, outbox: 0, temporary: 0, memories: 0, vectors: 0, missingVectors: 0 };
}

function emptyCounts(): MemoryHealthCounts {
  return mutableCounts();
}

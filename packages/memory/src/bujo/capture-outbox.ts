import { createHash, randomUUID } from "node:crypto";
import { relative } from "node:path";

import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../store/index.js";
import { appendBullet, dailyFilePath, rewriteBullet } from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import {
  appendGraphBatch,
  assertCanonicalGraphBatch,
  replaceDbCanonicalGraphProjectionWithParity,
  type CanonicalGraphRepairGuard,
  type GraphBatchInput,
  type GraphBatchResult,
} from "./graph.js";
import {
  assertCanonicalDailySourcePath,
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
  removeCanonicalFile,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
import { withManagedRollbackRetirement } from "./generations.js";
import {
  assertReplayDbStateSubsetOfProjection,
  assertProjectionContainsDelta,
  assertReplayProjectionMatchesDb,
  emptyReplayProjection,
  mergeReplayProjectionDelta,
  prepareReplayProjectionDelta,
  publishPreparedReplayProjection,
  readBujoCanonicalSourceFingerprint,
  readReplayProjectionStrict,
  replayProjectionAuthorityId,
  replayProjectionDbSnapshot,
  replayProjectionDbReplacement,
  type ReplayProjectionDelta,
  type ReplayProjectionV1,
} from "./replay-projection.js";
import type { Bullet } from "./types.js";

const OUTBOX_DIR = ".capture-outbox";
const INTENT_FILE_RE = /^intent-[a-f0-9-]{36}\.json$/u;
const INTENT_TEMP_RE = /^\.intent-[a-f0-9-]{36}\.json-[a-f0-9-]{36}\.tmp$/u;
const MAX_INTENTS = 32;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const MAX_ACTIONS = 8;
const MAX_ENTITIES = 16;
const MAX_RELATIONS = 16;
const MAX_ASSOCIATIONS = 128;
const MAX_VECTOR_DIM = 16_384;

export interface CanonicalBulletState {
  readonly file: string;
  readonly bullet: Bullet;
}

export interface CaptureThreadEdge {
  readonly src: string;
  readonly dst: string;
  readonly weight: number;
  /** Exact replay timestamp. New intents persist it; legacy intents may omit it. */
  readonly createdAt?: string;
}

interface CaptureActionBase {
  readonly candidateIndex: number;
}

export type CaptureIntentAction =
  | (CaptureActionBase & {
    readonly kind: "add";
    readonly id: string;
    readonly after: CanonicalBulletState;
    readonly record: MemoryRecord;
    readonly vector?: readonly number[];
    readonly threads: readonly CaptureThreadEdge[];
  })
  | (CaptureActionBase & {
    readonly kind: "update";
    readonly id: string;
    readonly before: CanonicalBulletState;
    readonly after: CanonicalBulletState;
    readonly record: MemoryRecord;
    readonly vector?: readonly number[];
  })
  | (CaptureActionBase & {
    readonly kind: "supersede";
    readonly oldId: string;
    readonly newId: string;
    readonly beforeOld: CanonicalBulletState;
    readonly afterOld: CanonicalBulletState;
    readonly afterNew: CanonicalBulletState;
    readonly record: MemoryRecord;
    readonly vector?: readonly number[];
    readonly at: string;
  })
  | (CaptureActionBase & {
    readonly kind: "noop";
    readonly id: string;
    readonly expected: CanonicalBulletState;
  });

interface CaptureIntent {
  readonly schemaVersion: 1;
  readonly state: "pending" | "complete";
  readonly id: string;
  readonly createdAt: string;
  /** Actual durable publication time; legacy intents fall back to pinned file mtime. */
  readonly publishedAt?: string;
  /** Run-keyed owner that keeps this exact plan replayable until intake resolves. */
  readonly retentionKey?: string;
  readonly actions: readonly CaptureIntentAction[];
  readonly graph: {
    readonly entities: readonly EntityRecord[];
    readonly relations: readonly EntityRelationRecord[];
    readonly associations: readonly MemoryEntityAssociation[];
  };
}

export interface CaptureIntentHandle {
  readonly file: string;
}

export interface CaptureIntentWriteOptions {
  readonly retentionKey?: string;
}

export interface CaptureIntentReplayResult extends GraphBatchResult {
  readonly appliedMemoryIds: readonly string[];
}

export interface CaptureIntentReplayOptions {
  /** Apply/verify canonical and DB outcomes but leave the durable intent pending. */
  readonly retainIntent?: boolean;
  readonly canonicalGraphRepairGuard?: CanonicalGraphRepairGuard;
}

/** Provider-free, content-hidden authority preview for explicit stopped-store adoption. */
export interface PendingCaptureReplayAdoptionPreview {
  readonly projection: ReplayProjectionV1;
  /** Replay receipt deltas already committed before `state: complete`. */
  readonly mustPresentProjection: ReplayProjectionV1;
  readonly ownedThreadSources: readonly string[];
  readonly ownedLifecycleSources: readonly string[];
  readonly legacyThreadTimestampKeys: readonly string[];
  readonly pendingMemoryIds: readonly string[];
  readonly graphEntityIds: readonly string[];
  readonly graphRelationKeys: readonly string[];
  readonly graphAssociationKeys: readonly string[];
  readonly commitment: string;
}

/** Content-free physical inventory for strict health. */
export interface CaptureOutboxAudit {
  readonly valid: boolean;
  readonly pending: number;
  readonly temporary: number;
}

/** Internal-only, content-free stability metadata consumed by strict health. */
export interface CaptureOutboxPrivateHealthState {
  readonly oldestPublishedAt?: string;
  readonly digest: string;
}

/** Internal module contract; intentionally not exported from the package subpath. */
export interface CaptureOutboxHealthAudit {
  readonly audit: CaptureOutboxAudit;
  readonly privateState: CaptureOutboxPrivateHealthState;
}

/** Atomically publish one bounded, fsynced capture intent before source mutation. */
export function writeCaptureIntent(
  root: string,
  actions: readonly CaptureIntentAction[],
  graph: GraphBatchInput,
  createdAt: string,
  options: CaptureIntentWriteOptions = {},
): CaptureIntentHandle {
  if (actions.length > MAX_ACTIONS) throw new Error("memory-capture: prepared action batch exceeds the outbox bound.");
  for (const action of actions) validateAction(action);
  assertCanonicalGraphBatch(graph);
  const files = listCanonicalFileNames(root, OUTBOX_DIR, {
    allowMissing: true,
    include: (name) => INTENT_FILE_RE.test(name),
  });
  if (files.length >= MAX_INTENTS) throw new Error("memory-capture: pending capture outbox is full; restart recovery before capturing more.");
  if (options.retentionKey !== undefined) {
    assertRetentionKey(options.retentionKey);
    if (findRetainedCaptureIntent(root, options.retentionKey) !== undefined) {
      throw new Error("memory-capture: retained run already owns a durable capture intent.");
    }
  }
  const id = randomUUID();
  const intent: CaptureIntent = {
    schemaVersion: 1,
    state: "pending",
    id,
    createdAt,
    publishedAt: new Date().toISOString(),
    ...(options.retentionKey === undefined ? {} : { retentionKey: options.retentionKey }),
    actions: materializeNewIntentThreads(root, actions),
    graph: {
      entities: [...(graph.entities ?? [])],
      relations: [...(graph.relations ?? [])],
      associations: [...(graph.associations ?? [])],
    },
  };
  const data = serializeIntent(intent);
  if (Buffer.byteLength(data, "utf8") > MAX_INTENT_BYTES) {
    throw new Error("memory-capture: prepared capture intent exceeds the durable outbox byte bound.");
  }
  parseIntent(data);
  const file = `${OUTBOX_DIR}/intent-${id}.json`;
  writeCanonicalFileAtomic(root, file, data);
  return { file };
}

/** Find one exact run-owned intent without exposing its payload. */
export function findRetainedCaptureIntent(root: string, retentionKey: string): CaptureIntentHandle | undefined {
  assertRetentionKey(retentionKey);
  const matches = captureIntentFiles(root)
    .map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`))
    .filter(({ intent }) => intent.retentionKey === retentionKey);
  if (matches.length > 1) throw new Error("memory-capture: retained run owns multiple capture intents.");
  return matches[0] === undefined ? undefined : { file: matches[0].file };
}

/** Content-free keys for bounded startup cleanup after intake resolution. */
export function listRetainedCaptureIntentKeys(root: string): string[] {
  return captureIntentFiles(root)
    .map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`).intent.retentionKey)
    .filter((key): key is string => key !== undefined)
    .sort();
}

/** Remove a run-owned exact-plan receipt only after its intake resolution is durable. */
export function removeRetainedCaptureIntent(root: string, retentionKey: string): boolean {
  const handle = findRetainedCaptureIntent(root, retentionKey);
  if (handle === undefined) return false;
  const snapshot = readCanonicalFileSnapshot(root, handle.file, { maxBytes: MAX_INTENT_BYTES });
  if (snapshot === undefined) return false;
  const intent = parseIntent(snapshot.content);
  if (intent.retentionKey !== retentionKey) {
    throw new Error("memory-capture: retained intent ownership changed before cleanup.");
  }
  assertProjectionContainsDelta(
    readReplayProjectionStrict(root).projection,
    captureReplayDelta(root, intent),
  );
  removeCanonicalFile(root, handle.file, snapshot.identity);
  return true;
}

/** Replay one just-written intent through the same exact-match path used at startup. */
export function replayCaptureIntent(
  root: string,
  handle: CaptureIntentHandle,
  db?: MemoryDb,
  options: CaptureIntentReplayOptions = {},
): CaptureIntentReplayResult {
  assertReplayMode(db, options);
  const files = captureIntentFiles(root);
  if (files.length > MAX_INTENTS) throw new Error("memory-capture: capture outbox exceeds its bounded intent count.");
  const replays = files.map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`));
  assertGraphRepairGuardForReplay(db, replays, options);
  assertDistinctQueuedMemoryIds(replays);
  const plans = replays.map((replay) => preflightReplay(root, replay, db));
  const selectedIndex = plans.findIndex((candidate) => candidate.file === handle.file);
  if (selectedIndex < 0) throw new Error(`memory-capture: pending intent "${handle.file}" disappeared.`);
  const expectedReplay = preflightReplayDeltas(root, plans);
  assertCompleteReplayReceipts(root, plans);
  assertMissingProjectionReplayIsAuthorized(root, db, expectedReplay, legacyThreadTimestampKeys(plans), plans);
  return applyReplayPlans(root, plans, db, options)[selectedIndex]!;
}

/** Replay every pending capture before accepting new writes or taking a rebuild snapshot. */
export function replayCaptureOutbox(
  root: string,
  db?: MemoryDb,
  options: CaptureIntentReplayOptions = {},
): CaptureIntentReplayResult[] {
  assertReplayMode(db, options);
  const files = captureIntentFiles(root);
  if (files.length > MAX_INTENTS) throw new Error("memory-capture: capture outbox exceeds its bounded intent count.");
  const replays = files.map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`));
  assertGraphRepairGuardForReplay(db, replays, options);
  assertDistinctQueuedMemoryIds(replays);
  // Validate every queued action and every vector against the current DB before
  // the first Markdown or graph append. A bad later intent cannot leave an
  // earlier intent half-applied merely because filenames sort first.
  const plans = replays.map((replay) => preflightReplay(root, replay, db));
  const expectedReplay = preflightReplayDeltas(root, plans);
  assertCompleteReplayReceipts(root, plans);
  assertMissingProjectionReplayIsAuthorized(root, db, expectedReplay, legacyThreadTimestampKeys(plans), plans);
  return applyReplayPlans(root, plans, db, options);
}

function assertReplayMode(db: MemoryDb | undefined, options: CaptureIntentReplayOptions): void {
  if (db === undefined && options.retainIntent !== true) {
    throw new Error(
      "memory-capture: replay without an active index may only stage canonical source while retaining the intent.",
    );
  }
}

function assertGraphRepairGuardForReplay(
  db: MemoryDb | undefined,
  replays: readonly LoadedReplay[],
  options: CaptureIntentReplayOptions,
): void {
  if (db !== undefined && replays.some((replay) => replay.intent.state === "pending")
    && options.canonicalGraphRepairGuard === undefined) {
    throw new Error("memory-capture: DB replay requires a canonical graph repair parity guard.");
  }
}

function assertMissingProjectionReplayIsAuthorized(
  root: string,
  db: MemoryDb | undefined,
  expectedReplay: ReplayProjectionV1,
  legacyThreadKeys: ReadonlySet<string>,
  plans: readonly ReplayPlan[],
): void {
  if (db === undefined || readReplayProjectionStrict(root).state.kind === "present") return;
  if (plans.some((plan) => plan.intent.state === "complete")) {
    throw new Error(
      "memory-capture: completed intent replay authority is missing; explicitly adopt replay before recovery.",
    );
  }
  assertReplayDbStateSubsetOfProjection(db, expectedReplay, {
    legacyThreadTimestampKeys: legacyThreadKeys,
  });
}

/** Explicit rollback cannot carry provider-bound pending vectors across identities. */
export function assertNoPendingCaptureIntent(root: string): void {
  if (!hasPendingCaptureIntent(root)) return;
  throw new Error(
    "memory-capture: a durable capture intent is pending; start the current writable store "
    + "or recover it before rollback.",
  );
}

/** Read-only bounded probe used to avoid opening an active DB when there is no recovery work. */
export function hasPendingCaptureIntent(root: string): boolean {
  const files = captureIntentFiles(root);
  if (files.length > MAX_INTENTS) throw new Error("memory-capture: capture outbox exceeds its bounded intent count.");
  for (const name of files) loadReplay(root, `${OUTBOX_DIR}/${name}`);
  return files.length > 0;
}

/** Bounded probe for the capture protocol's still-mutable action phase. */
export function hasMutablePendingCaptureIntent(root: string): boolean {
  const files = captureIntentFiles(root);
  if (files.length > MAX_INTENTS) throw new Error("memory-capture: capture outbox exceeds its bounded intent count.");
  return files.some((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`).intent.state === "pending");
}

/**
 * Validate every durable capture intent against its exact canonical/SQLite
 * before-or-after phase without writing source, sidecar, graph, or DB state.
 */
export function previewPendingCaptureReplayAdoption(
  root: string,
  db: MemoryDb,
): PendingCaptureReplayAdoptionPreview | undefined {
  const files = captureIntentFiles(root);
  if (files.length === 0) return undefined;
  if (files.length > MAX_INTENTS) throw new Error("memory-capture: capture outbox exceeds its bounded intent count.");
  const replays = files.map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`));
  assertDistinctQueuedMemoryIds(replays);
  const plans = replays.map((replay) => preflightReplay(root, replay, db));
  let projection = emptyReplayProjection();
  for (const plan of plans) projection = mergeReplayProjectionDelta(projection, plan.replayDelta);
  let mustPresentProjection = emptyReplayProjection();
  for (const plan of plans) {
    if (plan.intent.state === "complete") {
      mustPresentProjection = mergeReplayProjectionDelta(mustPresentProjection, plan.replayDelta);
    }
  }
  const ownedThreadSources = uniqueSorted(plans.flatMap((plan) => plan.intent.actions.flatMap((action) => (
    action.kind === "add" ? [action.id] : []
  ))));
  const ownedLifecycleSources = uniqueSorted(plans.flatMap((plan) => plan.intent.actions.flatMap((action) => (
    action.kind === "supersede" ? [action.oldId] : []
  ))));
  const legacyThreadKeys = uniqueSorted([...legacyThreadTimestampKeys(plans)]);
  const pendingPlans = plans.filter((plan) => plan.intent.state === "pending");
  const pendingMemoryIds = uniqueSorted(pendingPlans.flatMap((plan) => (
    plan.intent.actions.flatMap((action) => touchedMemoryIds(action))
  )));
  const graphEntityIds = uniqueSorted(pendingPlans.flatMap((plan) => plan.intent.graph.entities.map((entity) => entity.id)));
  const graphRelationKeys = uniqueSorted(pendingPlans.flatMap((plan) => plan.intent.graph.relations.map((relation) => (
    `${relation.src}\0${relation.dst}\0${relation.relation}`
  ))));
  const graphAssociationKeys = uniqueSorted(pendingPlans.flatMap((plan) => plan.intent.graph.associations.map((association) => (
    `${association.memoryId}\0${association.entityId}`
  ))));
  const commitment = replayProjectionAuthorityId({
    schemaVersion: 1,
    kind: "pending-capture-adoption-preview",
    files: replays.map((replay) => ({
      file: replay.file,
      sha256: createHash("sha256").update(replay.snapshot.content).digest("hex"),
      identity: replay.snapshot.identity,
    })),
    projection,
    mustPresentProjection,
    ownedThreadSources,
    ownedLifecycleSources,
    legacyThreadTimestampKeys: legacyThreadKeys,
    pendingMemoryIds,
    graphEntityIds,
    graphRelationKeys,
    graphAssociationKeys,
  });
  return {
    projection,
    mustPresentProjection,
    ownedThreadSources,
    ownedLifecycleSources,
    legacyThreadTimestampKeys: legacyThreadKeys,
    pendingMemoryIds,
    graphEntityIds,
    graphRelationKeys,
    graphAssociationKeys,
    commitment,
  };
}

export function assertPendingCaptureReplayAdoptionPreview(
  root: string,
  db: MemoryDb,
  expectedCommitment: string,
): void {
  const current = previewPendingCaptureReplayAdoption(root, db);
  if (current === undefined || current.commitment !== expectedCommitment) {
    throw new Error("memory-capture: durable adoption preview changed before replay authority publication.");
  }
}

/**
 * Validate every physical outbox entry without exposing an intent id or body.
 * Unknown names, malformed intents, and abandoned atomic-write temps all fail
 * closed while their aggregate file counts remain visible.
 */
export function auditCaptureOutbox(root: string): CaptureOutboxAudit {
  return auditCaptureOutboxHealthState(root).audit;
}

/** Strict health audit plus private content-free queue stability metadata. */
export function auditCaptureOutboxHealthState(root: string): CaptureOutboxHealthAudit {
  let pending = 0;
  let temporary = 0;
  try {
    const names = listCanonicalFileNames(root, OUTBOX_DIR, { allowMissing: true });
    let validNames = true;
    const intentNames: string[] = [];
    for (const name of names) {
      if (INTENT_TEMP_RE.test(name)) {
        temporary += 1;
        continue;
      }
      pending += 1;
      if (!INTENT_FILE_RE.test(name)) {
        validNames = false;
        continue;
      }
      intentNames.push(name);
    }
    // Count the entire physical inventory before parsing any bounded payload.
    // Invalid names, temps, and over-capacity queues already fail closed and
    // must not force up to 2 MiB of JSON allocation per entry.
    if (!validNames || temporary > 0 || pending > MAX_INTENTS) {
      return invalidOutboxHealth(pending, temporary);
    }
    const replays = intentNames.map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`));
    assertDistinctQueuedMemoryIds(replays);
    const publications = replays.map((replay) => replay.intent.publishedAt
      ?? new Date(replay.snapshot.identity.mtimeMs).toISOString()).sort();
    const digest = createHash("sha256").update(JSON.stringify(replays.map((replay) => ({
      id: replay.intent.id,
      state: replay.intent.state,
      publishedAt: replay.intent.publishedAt ?? new Date(replay.snapshot.identity.mtimeMs).toISOString(),
    })).sort((left, right) => left.id.localeCompare(right.id)))).digest("hex");
    return {
      audit: { valid: true, pending, temporary },
      privateState: {
        ...(publications.length === 0 ? {} : { oldestPublishedAt: publications[0]! }),
        digest,
      },
    };
  } catch {
    return invalidOutboxHealth(pending, temporary);
  }
}

function invalidOutboxHealth(pending: number, temporary: number): CaptureOutboxHealthAudit {
  return {
    audit: { valid: false, pending, temporary },
    privateState: {
      digest: createHash("sha256").update(JSON.stringify({ invalid: true, pending, temporary })).digest("hex"),
    },
  };
}

interface LoadedReplay {
  readonly file: string;
  readonly snapshot: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
  readonly intent: CaptureIntent;
}

interface ReplayPlan extends LoadedReplay {
  readonly writes: readonly ReplayWrite[];
  readonly appliedMemoryIds: ReadonlySet<string>;
  readonly legacySalienceRepairs: readonly LegacySalienceRepair[];
  readonly replayDelta: ReplayProjectionDelta;
}

interface ReplayWrite {
  readonly action: Exclude<CaptureIntentAction, { readonly kind: "noop" }>;
  readonly record: MemoryRecord;
}

interface LegacySalienceRepair {
  readonly id: string;
  readonly expectedCurrent: number;
  readonly canonical: number;
}

function captureIntentFiles(root: string): string[] {
  return listCanonicalFileNames(root, OUTBOX_DIR, {
    allowMissing: true,
    include: (name) => INTENT_FILE_RE.test(name),
  });
}

function loadReplay(root: string, file: string): LoadedReplay {
  const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_INTENT_BYTES });
  if (snapshot === undefined) throw new Error(`memory-capture: pending intent "${file}" disappeared.`);
  const intent = parseIntent(snapshot.content);
  return { file, snapshot, intent };
}

function preflightReplay(root: string, replay: LoadedReplay, db: MemoryDb | undefined): ReplayPlan {
  const { intent } = replay;
  const replayDelta = captureReplayDelta(root, intent, db);

  // `complete` is a durable receipt written only after canonical, replay, DB,
  // and the exact graph repair all committed. It must never replay its stale
  // mutable action/graph payload: later captures are allowed to evolve the
  // same memory or entity while the retained receipt remains on disk.
  if (intent.state === "complete") {
    return {
      ...replay,
      writes: [],
      appliedMemoryIds: new Set(),
      legacySalienceRepairs: [],
      replayDelta,
    };
  }

  const appliedMemoryIds = new Set<string>();
  for (const action of intent.actions) {
    if (!canonicalActionCanApply(root, action)) {
      throw new Error(`memory-capture: pending intent ${intent.id} conflicts with canonical action ${action.kind}.`);
    }
    appliedMemoryIds.add(memoryIdFor(action));
  }

  const legacySalienceRepairs = new Map<string, LegacySalienceRepair>();
  const writes = db === undefined
    ? intent.actions.flatMap((action) => action.kind === "noop" ? [] : [{ action, record: action.record }])
    : intent.actions.flatMap((action) => preflightDbAction(root, db, action, legacySalienceRepairs));
  if (db !== undefined) {
    db.assertPreparedUpserts(
      writes.map((write) => write.record),
      writes.map((write) => write.action.vector),
    );
  }

  return {
    ...replay,
    writes,
    appliedMemoryIds,
    legacySalienceRepairs: [...legacySalienceRepairs.values()],
    replayDelta,
  };
}

/** Validate the whole queue's replay authority before the first source write. */
function preflightReplayDeltas(root: string, plans: readonly ReplayPlan[]): ReplayProjectionV1 {
  let projection = readReplayProjectionStrict(root).projection;
  for (const plan of plans) {
    projection = mergeReplayProjectionDelta(projection, plan.replayDelta);
  }
  return projection;
}

function assertCompleteReplayReceipts(root: string, plans: readonly ReplayPlan[]): void {
  const complete = plans.filter((plan) => plan.intent.state === "complete");
  if (complete.length === 0) return;
  const replay = readReplayProjectionStrict(root);
  if (replay.state.kind !== "present") {
    throw new Error(
      "memory-capture: completed intent replay authority is missing; explicitly adopt replay before recovery.",
    );
  }
  for (const plan of complete) assertProjectionContainsDelta(replay.projection, plan.replayDelta);
}

function legacyThreadTimestampKeys(plans: readonly ReplayPlan[]): ReadonlySet<string> {
  return new Set(plans.flatMap((plan) => plan.intent.actions.flatMap((action) => (
    action.kind === "add"
      ? action.threads.filter((edge) => edge.createdAt === undefined)
        .map((edge) => `${edge.src}\0${edge.dst}`)
      : []
  ))));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function applyReplay(
  root: string,
  plan: ReplayPlan,
  db: MemoryDb | undefined,
  options: CaptureIntentReplayOptions,
  deferGraphAndRetirement = false,
): CaptureIntentReplayResult {
  const { intent, writes, appliedMemoryIds, legacySalienceRepairs, replayDelta } = plan;
  if (intent.state === "complete") {
    const replay = readReplayProjectionStrict(root);
    if (replay.state.kind !== "present") {
      throw new Error("memory-capture: completed intent replay authority disappeared during receipt verification.");
    }
    assertProjectionContainsDelta(replay.projection, replayDelta);
    if (db !== undefined && !deferGraphAndRetirement) {
      assertOrNormalizeCompleteReceiptReplay(db, replay.projection, [plan]);
    }
    if (deferGraphAndRetirement || options.retainIntent === true || intent.retentionKey !== undefined) {
      return emptyReplay();
    }
    removeReplayIntent(root, plan);
    return emptyReplay();
  }
  // This fresh publication CAS is intentionally prepared at apply time. Batch
  // preflight folded every delta purely, but intent N must observe the sidecar
  // identity written by intent N-1 rather than retaining a shared stale CAS.
  const preparedReplay = prepareReplayProjectionDelta(root, replayDelta);
  for (const action of intent.actions) {
    if (applyCanonicalAction(root, action) === "conflict") {
      throw new Error(`memory-capture: pending intent ${intent.id} conflicts with canonical action ${action.kind}.`);
    }
  }

  // Canonical graph evidence is part of the same source transaction and must
  // be durable before the sidecar advertises replay state that may reference
  // these new memories.
  const canonical = appendGraphBatch(root, {
    entities: intent.graph.entities,
    relations: intent.graph.relations,
    associations: intent.graph.associations.filter((association) => appliedMemoryIds.has(association.memoryId)),
  });
  const publishedReplay = preparedReplay.changed
    ? withManagedRollbackRetirement(
        root,
        "replay",
        () => publishPreparedReplayProjection(root, preparedReplay),
      )
    : publishPreparedReplayProjection(root, preparedReplay);
  assertProjectionContainsDelta(publishedReplay.projection, replayDelta);
  const committedSourceFingerprint = readBujoCanonicalSourceFingerprint(root);

  if (db !== undefined) {
    for (const repair of legacySalienceRepairs) {
      db.repairLegacySalience(repair.id, repair.expectedCurrent, repair.canonical);
    }
    if (writes.length > 0) {
      db.commitPreparedUpserts(
        writes.map((write) => write.record),
        writes.map((write) => write.action.vector),
      );
    }
    for (const action of intent.actions) {
      if (action.kind === "supersede") db.markSuperseded(action.oldId, action.newId, action.at);
    }
    db.replaceReplayProjection(replayProjectionDbReplacement(publishedReplay.projection));
    assertReplayProjectionMatchesDb(db, publishedReplay.projection);
    // The exact DB projection is part of intent completion. Recomputing the
    // whole deterministic projection also adds/removes legacy-name matches
    // affected by this memory or entity change. Any failure leaves the intent
    // pending so restart retries the idempotent canonical graph.
    if (!deferGraphAndRetirement) {
      replaceDbCanonicalGraphProjectionWithParity(root, db, options.canonicalGraphRepairGuard!);
      assertDbReplayOutcome(db, intent.actions, canonical);
    }
  }

  if (readBujoCanonicalSourceFingerprint(root) !== committedSourceFingerprint) {
    throw new Error("memory-capture: canonical source changed during replay projection commit.");
  }

  if (deferGraphAndRetirement || db === undefined) {
    return { ...canonical, appliedMemoryIds: [...appliedMemoryIds] };
  }

  const completed = markReplayIntentComplete(root, plan);
  if (options.retainIntent !== true && intent.retentionKey === undefined) {
    removeReplayIntent(root, completed);
  }
  return { ...canonical, appliedMemoryIds: [...appliedMemoryIds] };
}

function applyReplayPlans(
  root: string,
  plans: readonly ReplayPlan[],
  db: MemoryDb | undefined,
  options: CaptureIntentReplayOptions,
): CaptureIntentReplayResult[] {
  if (db === undefined || plans.length <= 1) {
    return plans.map((plan) => applyReplay(root, plan, db, options));
  }
  // All plans were preflighted before the first mutation. Defer total graph
  // repair and receipt retirement until every disjoint canonical/DB endpoint
  // exists; an adopted later DB-after intent can otherwise make the first
  // plan's exact base guard fail even though the batch is fully recoverable.
  const results = plans.map((plan) => applyReplay(root, plan, db, options, true));
  const sourceFingerprint = readBujoCanonicalSourceFingerprint(root);
  const replay = readReplayProjectionStrict(root);
  if (replay.state.kind !== "present") {
    throw new Error("memory-capture: replay authority disappeared before batch finalization.");
  }
  assertOrNormalizeCompleteReceiptReplay(db, replay.projection, plans);
  const pendingPlans = plans.filter((plan) => plan.intent.state === "pending");
  if (pendingPlans.length > 0) {
    replaceDbCanonicalGraphProjectionWithParity(root, db, options.canonicalGraphRepairGuard!);
  }
  for (const [index, plan] of plans.entries()) {
    if (plan.intent.state === "complete") continue;
    assertDbReplayOutcome(db, plan.intent.actions, results[index]!, false);
  }
  if (readBujoCanonicalSourceFingerprint(root) !== sourceFingerprint) {
    throw new Error("memory-capture: canonical source changed during replay batch finalization.");
  }
  const completedPlans = plans.map((plan) => (
    plan.intent.state === "complete" ? plan : markReplayIntentComplete(root, plan)
  ));
  if (options.retainIntent !== true) {
    for (const plan of completedPlans) {
      if (plan.intent.retentionKey === undefined) removeReplayIntent(root, plan);
    }
  }
  return results;
}

function markReplayIntentComplete(root: string, plan: ReplayPlan): ReplayPlan {
  const { file, snapshot, intent } = plan;
  if (intent.state === "complete") return plan;

  const completed: CaptureIntent = { ...intent, state: "complete" };
  writeCanonicalFileAtomic(root, file, serializeIntent(completed), snapshot.identity);
  const completeSnapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_INTENT_BYTES });
  if (completeSnapshot === undefined) throw new Error(`memory-capture: completed intent "${file}" disappeared.`);
  return { ...plan, intent: completed, snapshot: completeSnapshot };
}

function removeReplayIntent(root: string, plan: ReplayPlan): void {
  removeCanonicalFile(root, plan.file, plan.snapshot.identity);
}

function assertOrNormalizeCompleteReceiptReplay(
  db: MemoryDb,
  projection: ReplayProjectionV1,
  plans: readonly ReplayPlan[],
): void {
  try {
    assertReplayProjectionMatchesDb(db, projection);
    return;
  } catch (exactError) {
    const legacyKeys = new Set(plans.flatMap((plan) => (
      plan.intent.state !== "complete"
        ? []
        : plan.intent.actions.flatMap((action) => action.kind === "add"
          ? action.threads.filter((edge) => edge.createdAt === undefined)
            .map((edge) => `${edge.src}\0${edge.dst}`)
          : [])
    )));
    if (legacyKeys.size === 0) throw exactError;
    const actual = replayProjectionDbSnapshot(db);
    const expected = replayProjectionDbReplacement(projection);
    if (actual.terminals.length !== expected.terminals.length
      || actual.supersedes.length !== expected.supersedes.length
      || actual.threads.length !== expected.threads.length) {
      throw exactError;
    }
    // This is the one legacy receipt exception: old ADD intents omitted their
    // edge timestamp. Equal key counts plus subset equality prove the DB differs
    // only at a receipt-declared thread timestamp before one replay-only total
    // replacement. Mutable memory/graph action payloads are never consulted.
    assertReplayDbStateSubsetOfProjection(db, projection, {
      legacyThreadTimestampKeys: legacyKeys,
    });
    db.replaceReplayProjection(expected);
    assertReplayProjectionMatchesDb(db, projection);
  }
}

function assertDistinctQueuedMemoryIds(replays: readonly LoadedReplay[]): void {
  const memoryOwners = new Map<string, string>();
  const entityOwners = new Map<string, string>();
  const relationOwners = new Map<string, string>();
  const associationOwners = new Map<string, string>();
  for (const replay of replays) {
    if (replay.intent.state === "complete") continue;
    for (const action of replay.intent.actions) {
      for (const id of touchedMemoryIds(action)) {
        const owner = memoryOwners.get(id);
        if (owner !== undefined) {
          throw new Error(
            `memory-capture: queued intents ${owner} and ${replay.intent.id} overlap on memory ${id}.`,
          );
        }
        memoryOwners.set(id, replay.intent.id);
      }
    }
    assertDistinctQueuedKeys(
      replay.intent.id,
      replay.intent.graph.entities.map((entity) => entity.id),
      entityOwners,
      "graph entity",
    );
    assertDistinctQueuedKeys(
      replay.intent.id,
      replay.intent.graph.relations.map((relation) => `${relation.src}\0${relation.dst}\0${relation.relation}`),
      relationOwners,
      "graph relation",
    );
    assertDistinctQueuedKeys(
      replay.intent.id,
      replay.intent.graph.associations.map((association) => `${association.memoryId}\0${association.entityId}`),
      associationOwners,
      "graph association",
    );
  }
}

function assertDistinctQueuedKeys(
  intentId: string,
  keys: readonly string[],
  owners: Map<string, string>,
  label: string,
): void {
  for (const key of new Set(keys)) {
    const owner = owners.get(key);
    if (owner !== undefined) {
      throw new Error(`memory-capture: queued intents ${owner} and ${intentId} overlap on ${label}.`);
    }
    owners.set(key, intentId);
  }
}

function touchedMemoryIds(action: CaptureIntentAction): readonly string[] {
  return action.kind === "supersede" ? [action.oldId, action.newId] : [action.id];
}

function preflightDbAction(
  root: string,
  db: MemoryDb,
  action: CaptureIntentAction,
  legacySalienceRepairs: Map<string, LegacySalienceRepair>,
): ReplayWrite[] {
  if (action.kind === "noop") {
    const current = db.get(action.id);
    const match = current === undefined ? "different" : replayRecordMatch(root, current, action.expected);
    if (current === undefined || match === "different"
      || !hasUnsupersededLifecycle(db, current)) {
      throw new Error(`memory-capture: pending NOOP target ${action.id} does not match the active index.`);
    }
    if (match === "legacy-salience") queueLegacySalienceRepair(legacySalienceRepairs, current, action.expected);
    return [];
  }

  if (action.kind === "add") {
    for (const edge of action.threads) {
      const target = db.get(edge.dst);
      if (target === undefined) {
        throw new Error(`memory-capture: pending ADD thread target ${edge.dst} is missing from the active index.`);
      }
      resolveThreadCreatedAt(root, db, action, edge);
    }
    const current = db.get(action.id);
    const match = current === undefined ? "exact" : replayRecordMatch(root, current, action.after);
    if (current !== undefined && (match === "different"
      || !hasUnsupersededLifecycle(db, current))) {
      throw new Error(`memory-capture: pending ADD target ${action.id} conflicts with the active index.`);
    }
    if (current !== undefined && match === "legacy-salience") {
      queueLegacySalienceRepair(legacySalienceRepairs, current, action.after);
    }
    if (current !== undefined && dbHasCanonicalOutcome(db, action)) return [];
    return [{ action, record: mergeLiveRecordState(action.record, current) }];
  }

  if (action.kind === "update") {
    const current = db.get(action.id);
    const beforeMatch = current === undefined
      ? "different"
      : replayRecordMatch(root, current, action.before, action.after);
    const afterMatch = current === undefined ? "different" : replayRecordMatch(root, current, action.after);
    if (current === undefined
      || (beforeMatch === "different" && afterMatch === "different")
      || !hasUnsupersededLifecycle(db, current)) {
      throw new Error(`memory-capture: pending UPDATE target ${action.id} matches neither allowed active-index state.`);
    }
    if (beforeMatch === "legacy-salience" || afterMatch === "legacy-salience") {
      queueLegacySalienceRepair(
        legacySalienceRepairs,
        current,
        beforeMatch === "legacy-salience" ? action.before : action.after,
      );
    }
    if (recordMatchesCanonicalState(current, action.after) && dbHasCanonicalOutcome(db, action)) return [];
    return [{ action, record: mergeLiveRecordState(action.record, current) }];
  }

  const old = db.get(action.oldId);
  if (old === undefined) {
    throw new Error(`memory-capture: pending supersede target ${action.oldId} is missing from the active index.`);
  }
  const oldBeforeMatch = replayRecordMatch(root, old, action.beforeOld, action.afterOld);
  const oldAfterMatch = replayRecordMatch(root, old, action.afterOld);
  const oldBefore = oldBeforeMatch !== "different"
    && old.supersededBy === undefined
    && old.supersededAt === undefined
    && old.validTo === undefined;
  const oldAfter = oldAfterMatch !== "different"
    && old.supersededBy === action.newId
    && old.supersededAt === action.at
    && old.validTo === action.at
    && db.edges(action.oldId).some((edge) => edge.kind === "supersedes" && edge.dst === action.newId);
  const oldAwaitingFinalize = oldAfterMatch !== "different"
    && old.supersededBy === undefined
    && old.supersededAt === undefined
    && old.validTo === undefined
    && !db.edges(action.oldId).some((edge) => edge.kind === "supersedes");
  if (!oldBefore && !oldAfter && !oldAwaitingFinalize) {
    throw new Error(`memory-capture: pending supersede target ${action.oldId} conflicts with the active index.`);
  }
  if ((oldBefore && oldBeforeMatch === "legacy-salience")
    || ((oldAfter || oldAwaitingFinalize) && oldAfterMatch === "legacy-salience")) {
    queueLegacySalienceRepair(
      legacySalienceRepairs,
      old,
      oldBefore && oldBeforeMatch === "legacy-salience" ? action.beforeOld : action.afterOld,
    );
  }
  const replacement = db.get(action.newId);
  const replacementMatch = replacement === undefined
    ? "exact"
    : replayRecordMatch(root, replacement, action.afterNew);
  if (replacement !== undefined && replacementMatch === "different") {
    throw new Error(`memory-capture: pending supersede replacement ${action.newId} conflicts with the active index.`);
  }
  if (replacement !== undefined && replacementMatch === "legacy-salience") {
    queueLegacySalienceRepair(legacySalienceRepairs, replacement, action.afterNew);
  }
  if (replacement !== undefined && dbHasCanonicalOutcome(db, action)) return [];
  return [{ action, record: mergeLiveRecordState(action.record, replacement) }];
}

/** Provider- and wall-clock-free timestamp for replay-owned thread evidence. */
function deterministicThreadCreatedAt(sourceCreatedAt: string, targetCreatedAt: string): string {
  const sourceMillis = Date.parse(sourceCreatedAt);
  const targetMillis = Date.parse(targetCreatedAt);
  if (!Number.isFinite(sourceMillis) || !Number.isFinite(targetMillis)) {
    throw new Error("memory-capture: pending ADD thread endpoint has an invalid creation timestamp.");
  }
  return new Date(Math.max(sourceMillis, targetMillis)).toISOString();
}

function resolveThreadCreatedAt(
  root: string,
  db: MemoryDb | undefined,
  action: Extract<CaptureIntentAction, { readonly kind: "add" }>,
  edge: CaptureThreadEdge,
): string {
  const targetCreatedAt = findCanonicalMemoryCreatedAt(root, edge.dst);
  if (targetCreatedAt === undefined) {
    throw new Error(`memory-capture: legacy pending ADD thread target ${edge.dst} has no canonical timestamp.`);
  }
  const dbTarget = db?.get(edge.dst);
  if (dbTarget !== undefined && dbTarget.createdAt !== targetCreatedAt) {
    throw new Error("memory-capture: pending ADD thread target timestamp differs between canonical source and SQLite.");
  }
  const expected = deterministicThreadCreatedAt(action.after.bullet.createdAt, targetCreatedAt);
  if (edge.createdAt !== undefined && edge.createdAt !== expected) {
    throw new Error("memory-capture: pending ADD thread timestamp does not match its canonical endpoints.");
  }
  return expected;
}

function materializeNewIntentThreads(
  root: string,
  actions: readonly CaptureIntentAction[],
): CaptureIntentAction[] {
  return actions.map((action) => {
    if (action.kind !== "add") return action;
    const threads = action.threads.map((edge) => {
      const targetCreatedAt = findCanonicalMemoryCreatedAt(root, edge.dst);
      if (targetCreatedAt === undefined) {
        throw new Error(`memory-capture: new ADD thread target ${edge.dst} has no canonical timestamp.`);
      }
      const createdAt = deterministicThreadCreatedAt(action.after.bullet.createdAt, targetCreatedAt);
      if (edge.createdAt !== undefined && edge.createdAt !== createdAt) {
        throw new Error(`memory-capture: new ADD thread target ${edge.dst} has a conflicting timestamp.`);
      }
      return { ...edge, createdAt };
    });
    return { ...action, threads };
  });
}

function findCanonicalMemoryCreatedAt(root: string, id: string): string | undefined {
  const dailyNames = listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  });
  const dailyNameSet = new Set(dailyNames);
  const files = [
    ...dailyNames.map((name) => `daily/${name}`),
    ...listCanonicalRootFileNames(root, {
      include: (name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name) && !dailyNameSet.has(name),
    }),
  ];
  const matches: string[] = [];
  for (const file of files) {
    const snapshot = readCanonicalFileSnapshot(root, file);
    if (snapshot === undefined) throw new Error(`memory-capture: canonical source "${file}" disappeared.`);
    for (const bullet of parseDailyFile(snapshot.content).bullets) {
      if (bullet.id === id) matches.push(bullet.createdAt);
    }
  }
  if (matches.length > 1) {
    throw new Error(`memory-capture: thread target ${id} is duplicated in canonical source.`);
  }
  return matches[0];
}

function captureReplayDelta(
  root: string,
  intent: CaptureIntent,
  db?: MemoryDb,
): ReplayProjectionDelta {
  const { state: _state, ...immutableAuthority } = intent;
  const authorityId = replayProjectionAuthorityId(immutableAuthority);
  return {
    terminals: [],
    supersedes: intent.actions.flatMap((action) => action.kind === "supersede" ? [{
      src: action.oldId,
      dst: action.newId,
      at: action.at,
      authorityKind: "capture" as const,
      authorityId,
    }] : []),
    threads: intent.actions.flatMap((action) => action.kind === "add"
      ? action.threads.map((edge) => ({
          src: edge.src,
          dst: edge.dst,
          weight: edge.weight,
          at: resolveThreadCreatedAt(root, db, action, edge),
          authorityKind: "capture" as const,
          authorityId,
        }))
      : []),
  };
}

function hasUnsupersededLifecycle(db: MemoryDb, record: MemoryRecord): boolean {
  return record.supersededBy === undefined
    && record.supersededAt === undefined
    && record.validTo === undefined
    && !db.edges(record.id).some((edge) => edge.kind === "supersedes");
}

/** Preserve SQLite-only state that may advance after the intent is published. */
function mergeLiveRecordState(intended: MemoryRecord, current: MemoryRecord | undefined): MemoryRecord {
  if (current === undefined) return intended;
  const {
    id: _id,
    type: _type,
    status: _status,
    text: _text,
    salience: _salience,
    isInsight: _isInsight,
    createdAt: _createdAt,
    dueAt: _dueAt,
    source: currentSource,
    ...live
  } = current;
  return {
    ...intended,
    ...live,
    tags: [...current.tags],
    source: {
      ...intended.source,
      ...currentSource,
      ...(intended.source.file === undefined ? {} : { file: intended.source.file }),
    },
  };
}

function canonicalActionCanApply(root: string, action: CaptureIntentAction): boolean {
  if (action.kind === "add") {
    const current = bulletState(root, action.after);
    return current === "exact" || current === "missing";
  }
  if (action.kind === "update") {
    return bulletState(root, action.after) === "exact" || bulletState(root, action.before) === "exact";
  }
  if (action.kind === "noop") return bulletState(root, action.expected) === "exact";

  const oldAfter = bulletState(root, action.afterOld);
  const oldBefore = bulletState(root, action.beforeOld);
  const next = bulletState(root, action.afterNew);
  return (oldAfter === "exact" && next === "exact")
    || (oldBefore === "exact" && next === "missing")
    || (oldAfter === "exact" && next === "missing")
    || (oldBefore === "exact" && next === "exact");
}

function dbHasCanonicalOutcome(db: MemoryDb, action: CaptureIntentAction): boolean {
  const state = action.kind === "noop"
    ? action.expected
    : action.kind === "supersede" ? action.afterNew : action.after;
  const record = db.get(state.bullet.id);
  if (record === undefined || !recordMatchesCanonicalState(record, state)) return false;
  if (action.kind === "noop" || action.vector === undefined) return true;
  // A safe rebuild re-embeds the canonical record under the target identity.
  // Its already-present vector is authoritative; replaying the outbox's old
  // provider-bound bytes would either downgrade it or fail on a new dimension.
  if (db.hasVector(record.id)) return true;
  return db.indexMetadata()?.tier === "lite";
}

function recordMatchesCanonicalState(record: MemoryRecord, state: CanonicalBulletState): boolean {
  return record.salience === state.bullet.salience
    && recordMatchesCanonicalStateExceptSalience(record, state);
}

/**
 * Historical `applyDecay` releases could mutate only the SQLite salience mirror.
 * An upgrade may trust that one-field drift only when either this exact bullet
 * or the action's validated completed bullet is independently present in
 * canonical source. The completed-state proof is supplied only for a DB-before
 * row after canonical mutation. Replay records a compare-and-swap repair and
 * requires canonical salience again before retiring the durable intent.
 */
function replayRecordMatch(
  root: string,
  record: MemoryRecord,
  state: CanonicalBulletState,
  completedState?: CanonicalBulletState,
): "exact" | "legacy-salience" | "different" {
  if (recordMatchesCanonicalState(record, state)) return "exact";
  if (Number.isFinite(record.salience)
    && record.salience !== state.bullet.salience
    && recordMatchesCanonicalStateExceptSalience(record, state)
    && (bulletState(root, state) === "exact"
      || (completedState !== undefined && bulletState(root, completedState) === "exact"))) {
    return "legacy-salience";
  }
  return "different";
}

function recordMatchesCanonicalStateExceptSalience(
  record: MemoryRecord,
  state: CanonicalBulletState,
): boolean {
  const bullet = state.bullet;
  return record.id === bullet.id
    && record.type === bullet.type
    && record.status === bullet.status
    && record.text === bullet.text
    && record.isInsight === bullet.isInsight
    && record.createdAt === bullet.createdAt
    && record.dueAt === bullet.dueAt
    && record.source.file === state.file;
}

function queueLegacySalienceRepair(
  repairs: Map<string, LegacySalienceRepair>,
  record: MemoryRecord,
  state: CanonicalBulletState,
): void {
  const repair: LegacySalienceRepair = {
    id: record.id,
    expectedCurrent: record.salience,
    canonical: state.bullet.salience,
  };
  const existing = repairs.get(record.id);
  if (existing !== undefined
    && (existing.expectedCurrent !== repair.expectedCurrent || existing.canonical !== repair.canonical)) {
    throw new Error(`memory-capture: conflicting legacy salience repair for ${record.id}.`);
  }
  repairs.set(record.id, repair);
}

function assertDbReplayOutcome(
  db: MemoryDb,
  actions: readonly CaptureIntentAction[],
  graph: GraphBatchResult,
  assertGraph = true,
): void {
  for (const action of actions) {
    if (!dbHasCanonicalOutcome(db, action)) {
      throw new Error(`memory-capture: active index did not reach canonical ${action.kind} outcome.`);
    }
    if (action.kind === "add") {
      const edges = db.edges(action.id);
      for (const expected of action.threads) {
        if (!edges.some((edge) => edge.kind === "thread" && edge.dst === expected.dst && edge.weight === expected.weight)) {
          throw new Error(`memory-capture: active index did not retain thread edge for ${action.id}.`);
        }
      }
    } else if (action.kind === "supersede") {
      const old = db.get(action.oldId);
      if (old === undefined || !recordMatchesCanonicalState(old, action.afterOld)
        || old.supersededBy !== action.newId || old.supersededAt !== action.at || old.validTo !== action.at
        || !db.edges(action.oldId).some((edge) => edge.kind === "supersedes" && edge.dst === action.newId)) {
        throw new Error(`memory-capture: active index did not reach supersede outcome for ${action.oldId}.`);
      }
    }
  }
  if (!assertGraph) return;
  for (const entity of graph.entities) {
    if (!entityRecordsEqual(db.getEntity(entity.id), entity)) {
      throw new Error(`memory-capture: active index did not mirror entity ${entity.id}.`);
    }
  }
  for (const relation of graph.relations) {
    if (!db.relationsFor(relation.src).some((actual) => relationRecordsEqual(actual, relation))) {
      throw new Error(`memory-capture: active index did not mirror relation ${relation.src} -> ${relation.dst}.`);
    }
  }
  for (const association of graph.associations) {
    if (!db.associationsForMemory(association.memoryId)
      .some((actual) => associationRecordsEqual(actual, association))) {
      throw new Error(`memory-capture: active index did not mirror association for ${association.memoryId}.`);
    }
  }
}

function entityRecordsEqual(left: EntityRecord | undefined, right: EntityRecord): boolean {
  return left !== undefined
    && left.id === right.id
    && left.name === right.name
    && left.type === right.type
    && left.summary === right.summary
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function relationRecordsEqual(left: EntityRelationRecord, right: EntityRelationRecord): boolean {
  return left.src === right.src
    && left.dst === right.dst
    && left.relation === right.relation
    && left.createdAt === right.createdAt;
}

function associationRecordsEqual(left: MemoryEntityAssociation, right: MemoryEntityAssociation): boolean {
  return left.memoryId === right.memoryId
    && left.entityId === right.entityId
    && left.provenance === right.provenance
    && left.createdAt === right.createdAt;
}

function applyCanonicalAction(root: string, action: CaptureIntentAction): "applied" | "conflict" {
  if (action.kind === "add") {
    const current = bulletState(root, action.after);
    if (current === "exact") return "applied";
    if (current !== "missing") return "conflict";
    appendExpectedBullet(root, action.after);
    return bulletState(root, action.after) === "exact" ? "applied" : "conflict";
  }
  if (action.kind === "update") {
    const after = bulletState(root, action.after);
    if (after === "exact") return "applied";
    const before = bulletState(root, action.before);
    if (before !== "exact") return "conflict";
    if (!rewriteBullet(root, action.after.file, action.id, { text: action.after.bullet.text })) return "conflict";
    return bulletState(root, action.after) === "exact" ? "applied" : "conflict";
  }
  if (action.kind === "noop") {
    return bulletState(root, action.expected) === "exact" ? "applied" : "conflict";
  }

  const oldAfter = bulletState(root, action.afterOld);
  const oldBefore = bulletState(root, action.beforeOld);
  const next = bulletState(root, action.afterNew);
  if (oldAfter === "exact" && next === "exact") return "applied";
  if (oldBefore === "exact" && next === "missing") {
    appendExpectedBullet(root, action.afterNew);
    if (!rewriteBullet(root, action.afterOld.file, action.oldId, { status: action.afterOld.bullet.status })) {
      return "conflict";
    }
    return bulletState(root, action.afterOld) === "exact"
      && bulletState(root, action.afterNew) === "exact" ? "applied" : "conflict";
  }
  if (oldAfter === "exact" && next === "missing") {
    appendExpectedBullet(root, action.afterNew);
    return bulletState(root, action.afterNew) === "exact" ? "applied" : "conflict";
  }
  if (oldBefore === "exact" && next === "exact") {
    if (!rewriteBullet(root, action.afterOld.file, action.oldId, { status: action.afterOld.bullet.status })) {
      return "conflict";
    }
    return bulletState(root, action.afterOld) === "exact" ? "applied" : "conflict";
  }
  return "conflict";
}

function appendExpectedBullet(root: string, expected: CanonicalBulletState): void {
  const when = new Date(expected.bullet.createdAt);
  if (!Number.isFinite(when.getTime()) || relative(root, dailyFilePath(root, when)) !== expected.file) {
    throw new Error("memory-capture: supersede replacement has an inconsistent canonical path.");
  }
  appendBullet(root, expected.bullet, when);
}

function bulletState(root: string, expected: CanonicalBulletState): "exact" | "missing" | "different" {
  assertCanonicalDailySourcePath(expected.file);
  const snapshot = readCanonicalFileSnapshot(root, expected.file, { allowMissing: true });
  if (snapshot === undefined) return "missing";
  const matches = parseDailyFile(snapshot.content).bullets.filter((bullet) => bullet.id === expected.bullet.id);
  if (matches.length === 0) return "missing";
  if (matches.length !== 1) return "different";
  return bulletsEqual(matches[0]!, expected.bullet) ? "exact" : "different";
}

function bulletsEqual(left: Bullet, right: Bullet): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.status === right.status
    && left.text === right.text
    && left.salience === right.salience
    && left.isInsight === right.isInsight
    && left.createdAt === right.createdAt
    && left.dueAt === right.dueAt
    && left.refs.length === right.refs.length
    && left.refs.every((ref, index) => ref === right.refs[index]);
}

function memoryIdFor(action: CaptureIntentAction): string {
  return action.kind === "supersede" ? action.newId : action.id;
}

function serializeIntent(intent: CaptureIntent): string {
  const actions = intent.actions.map((action) => {
    if (action.kind === "noop" || action.vector === undefined) return action;
    return { ...action, vector: encodeVector(action.vector) };
  });
  return `${JSON.stringify({ ...intent, actions })}\n`;
}

function encodeVector(vector: readonly number[]): {
  readonly encoding: "float32-le-base64";
  readonly dimension: number;
  readonly data: string;
} {
  if (vector.length === 0 || vector.length > MAX_VECTOR_DIM
    || vector.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error("memory-capture: invalid prepared vector in outbox intent.");
  }
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (const [index, value] of vector.entries()) bytes.writeFloatLE(value, index * 4);
  return { encoding: "float32-le-base64", dimension: vector.length, data: bytes.toString("base64") };
}

function decodeActionVector(value: unknown): unknown {
  if (!isRecord(value) || value.kind === "noop" || value.vector === undefined) return value;
  const encoded = value.vector;
  if (!isRecord(encoded)
    || encoded.encoding !== "float32-le-base64"
    || !Number.isInteger(encoded.dimension)
    || Number(encoded.dimension) <= 0
    || Number(encoded.dimension) > MAX_VECTOR_DIM
    || typeof encoded.data !== "string") {
    throw new Error("memory-capture: invalid encoded vector in outbox intent.");
  }
  const bytes = Buffer.from(encoded.data, "base64");
  if (bytes.length !== Number(encoded.dimension) * 4 || bytes.toString("base64") !== encoded.data) {
    throw new Error("memory-capture: malformed encoded vector in outbox intent.");
  }
  const vector: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) vector.push(bytes.readFloatLE(offset));
  if (vector.some((part) => !Number.isFinite(part))) {
    throw new Error("memory-capture: non-finite encoded vector in outbox intent.");
  }
  return { ...value, vector };
}

function parseIntent(raw: string): CaptureIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("memory-capture: malformed capture outbox intent.");
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || (value.state !== "pending" && value.state !== "complete")
    || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.id)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || (value.publishedAt !== undefined
      && (typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt))))
    || (value.retentionKey !== undefined && (typeof value.retentionKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.retentionKey)))
    || !Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS
    || !isRecord(value.graph)
    || !Array.isArray(value.graph.entities) || value.graph.entities.length > MAX_ENTITIES
    || !Array.isArray(value.graph.relations) || value.graph.relations.length > MAX_RELATIONS
    || !Array.isArray(value.graph.associations) || value.graph.associations.length > MAX_ASSOCIATIONS) {
    throw new Error("memory-capture: invalid capture outbox intent schema.");
  }
  const intent = {
    ...value,
    actions: value.actions.map(decodeActionVector),
  } as unknown as CaptureIntent;
  const indexes = new Set<number>();
  const touchedMemoryIds = new Set<string>();
  for (const action of intent.actions) {
    validateAction(action);
    if (indexes.has(action.candidateIndex)) throw new Error("memory-capture: duplicate candidate index in outbox intent.");
    indexes.add(action.candidateIndex);
    const ids = action.kind === "supersede" ? [action.oldId, action.newId] : [action.id];
    for (const id of ids) {
      if (touchedMemoryIds.has(id)) {
        throw new Error("memory-capture: overlapping memory actions in outbox intent.");
      }
      touchedMemoryIds.add(id);
    }
  }
  assertCanonicalGraphBatch(intent.graph);
  if (intent.graph.associations.some((association) => association.provenance !== "capture")) {
    throw new Error("memory-capture: invalid association in outbox intent.");
  }
  const memoryIds = new Set(intent.actions.map(memoryIdFor));
  const entityIds = new Set(intent.graph.entities.map((entity) => entity.id));
  if (intent.graph.associations.some((association) => !memoryIds.has(association.memoryId)
    || !entityIds.has(association.entityId))) {
    throw new Error("memory-capture: outbox association does not match its planned action and entity.");
  }
  if (intent.graph.relations.some((relation) => !entityIds.has(relation.src) || !entityIds.has(relation.dst))) {
    throw new Error("memory-capture: outbox relation has an unknown entity endpoint.");
  }
  return intent;
}

function assertRetentionKey(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("memory-capture: retention key is invalid.");
}

function validateAction(action: CaptureIntentAction): void {
  if (!isRecord(action) || !Number.isInteger(action.candidateIndex)
    || action.candidateIndex < 0 || action.candidateIndex >= MAX_ACTIONS) {
    throw new Error("memory-capture: invalid action index in outbox intent.");
  }
  if (action.kind === "add") {
    validateState(action.after);
    validateRecord(action.record, action.id);
    assertRecordMatchesBullet(action.record, action.after);
    validateVector(action.vector);
    if (action.id !== action.after.bullet.id || action.record.source.file !== action.after.file
      || !Array.isArray(action.threads) || action.threads.length > 5
      || action.threads.some((edge) => !isRecord(edge) || edge.src !== action.id
        || typeof edge.dst !== "string" || edge.dst.length === 0 || edge.dst === action.id
        || typeof edge.weight !== "number" || !Number.isFinite(edge.weight)
        || edge.weight <= 0 || edge.weight > 1
        || (edge.createdAt !== undefined && (typeof edge.createdAt !== "string"
          || !Number.isFinite(Date.parse(edge.createdAt))
          || new Date(Date.parse(edge.createdAt)).toISOString() !== edge.createdAt)))) {
      throw new Error("memory-capture: invalid add action in outbox intent.");
    }
    return;
  }
  if (action.kind === "update") {
    validateState(action.before);
    validateState(action.after);
    validateRecord(action.record, action.id);
    validateVector(action.vector);
    if (action.before.bullet.id !== action.id || action.after.bullet.id !== action.id
      || action.before.file !== action.after.file || action.record.source.file !== action.after.file) {
      throw new Error("memory-capture: invalid update action in outbox intent.");
    }
    assertRecordMatchesBullet(action.record, action.after);
    if (!bulletsEqual({ ...action.before.bullet, text: action.after.bullet.text }, action.after.bullet)) {
      throw new Error("memory-capture: update intent changes fields outside its text outcome.");
    }
    return;
  }
  if (action.kind === "supersede") {
    validateState(action.beforeOld);
    validateState(action.afterOld);
    validateState(action.afterNew);
    validateRecord(action.record, action.newId);
    validateVector(action.vector);
    if (typeof action.oldId !== "string" || action.beforeOld.bullet.id !== action.oldId
      || typeof action.newId !== "string" || action.afterNew.bullet.id !== action.newId
      || action.afterOld.bullet.id !== action.oldId
      || action.beforeOld.file !== action.afterOld.file
      || action.record.source.file !== action.afterNew.file
      || typeof action.at !== "string" || !Number.isFinite(Date.parse(action.at))) {
      throw new Error("memory-capture: invalid supersede action in outbox intent.");
    }
    assertRecordMatchesBullet(action.record, action.afterNew);
    if (!bulletsEqual({ ...action.beforeOld.bullet, status: "invalidated" }, action.afterOld.bullet)) {
      throw new Error("memory-capture: supersede intent has an invalid prior-memory outcome.");
    }
    return;
  }
  if (action.kind === "noop") {
    validateState(action.expected);
    if (typeof action.id !== "string" || action.expected.bullet.id !== action.id) {
      throw new Error("memory-capture: invalid noop action in outbox intent.");
    }
    return;
  }
  throw new Error("memory-capture: unknown action in outbox intent.");
}

function validateState(state: CanonicalBulletState): void {
  if (!isRecord(state) || typeof state.file !== "string" || !isBullet(state.bullet)) {
    throw new Error("memory-capture: invalid canonical bullet state in outbox intent.");
  }
  assertCanonicalDailySourcePath(state.file);
}

function validateRecord(record: MemoryRecord, id: string): void {
  if (!isRecord(record)
    || record.id !== id
    || (record.type !== "task" && record.type !== "event" && record.type !== "note")
    || !isMemoryStatus(record.status)
    || typeof record.text !== "string"
    || typeof record.salience !== "number" || !Number.isFinite(record.salience)
    || typeof record.isInsight !== "boolean"
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.accessCount !== "number" || !Number.isInteger(record.accessCount) || record.accessCount < 0
    || !isRecord(record.source) || typeof record.source.file !== "string"
    || (record.source.line !== undefined && (!Number.isInteger(record.source.line) || Number(record.source.line) <= 0))
    || !Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string")
    || (record.dueAt !== undefined && typeof record.dueAt !== "string")
    || (record.collection !== undefined && typeof record.collection !== "string")) {
    throw new Error("memory-capture: invalid memory record in outbox intent.");
  }
  assertCanonicalDailySourcePath(record.source.file);
}

function assertRecordMatchesBullet(record: MemoryRecord, state: CanonicalBulletState): void {
  const bullet = state.bullet;
  if (record.source.file !== state.file
    || record.id !== bullet.id
    || record.type !== bullet.type
    || record.status !== bullet.status
    || record.text !== bullet.text
    || record.salience !== bullet.salience
    || record.isInsight !== bullet.isInsight
    || record.createdAt !== bullet.createdAt
    || record.dueAt !== bullet.dueAt) {
    throw new Error("memory-capture: memory record does not match its canonical bullet outcome.");
  }
}

function validateVector(vector: readonly number[] | undefined): void {
  if (vector === undefined) return;
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_VECTOR_DIM
    || vector.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error("memory-capture: invalid prepared vector in outbox intent.");
  }
}

function isBullet(value: unknown): value is Bullet {
  return isRecord(value)
    && typeof value.id === "string" && value.id.length > 0
    && (value.type === "task" || value.type === "event" || value.type === "note")
    && isMemoryStatus(value.status)
    && typeof value.text === "string"
    && typeof value.salience === "number" && Number.isFinite(value.salience)
    && typeof value.isInsight === "boolean"
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && Array.isArray(value.refs) && value.refs.length <= 64 && value.refs.every((ref) => typeof ref === "string")
    && (value.dueAt === undefined || typeof value.dueAt === "string");
}

function isMemoryStatus(value: unknown): value is Bullet["status"] {
  return value === "open" || value === "done" || value === "scheduled"
    || value === "migrated" || value === "dropped" || value === "invalidated";
}

function emptyReplay(): CaptureIntentReplayResult {
  return { entities: [], relations: [], associations: [], appliedMemoryIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

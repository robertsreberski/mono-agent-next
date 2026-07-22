import { createHash } from "node:crypto";

import type { EntityRecord, MemoryDb, MemoryEntityAssociation, MemoryRecord } from "../store/index.js";
import { parseJsonLoose } from "./json.js";
import { MemoryModelError } from "./model-error.js";
import {
  appendCanonicalFile,
  assertCanonicalDailySourcePath,
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
import type { LlmComplete } from "./llm.js";
import { parseDailyFile, serializeDailyFile, type DailyFile } from "./grammar.js";
import {
  appendGraphBatch,
  readGraph,
  replaceDbCanonicalGraphProjectionWithParity,
  type CanonicalGraphRepairGuard,
} from "./graph.js";
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
  replayProjectionDbReplacement,
  type ReplayProjectionDelta,
} from "./replay-projection.js";
import { withSerializedBujoMutation } from "./mutation-lock.js";
import type { Bullet } from "./types.js";

export interface MigrateDeps {
  readonly db: MemoryDb;
  readonly root: string;
  readonly llm: LlmComplete;
  readonly now: () => Date;
  readonly abortSignal?: AbortSignal;
  readonly canonicalGraphRepairGuard?: CanonicalGraphRepairGuard;
  /** Fault-injection seams used to prove the durable decision boundary. */
  readonly hooks?: {
    readonly afterDecisionDurable?: (decisionId: string) => void;
    readonly afterActionCommitted?: (decisionId: string) => void;
  };
}

export interface MigrateResult {
  readonly promoted: number;
  readonly rescheduled: number;
  readonly clustered: number;
  readonly forgotten: number;
  readonly reviewed: number;
}

export interface ExplicitForgetDeps {
  readonly root: string;
  readonly db: MemoryDb;
  readonly ids: readonly string[];
  readonly now: () => Date;
  readonly expectedSourceFingerprint: string;
  readonly abortSignal?: AbortSignal;
}

export interface ExplicitForgetResult {
  readonly forgotten: number;
  readonly recoveredPendingDecision: boolean;
  readonly sourceFingerprint: string;
}

export interface ExplicitForgetPreview {
  readonly eligible: number;
}

export type MigrateAction = "promote" | "reschedule" | "cluster" | "forget";

export interface PendingMigrateRecovery {
  readonly action: MigrateAction;
}

/** Provider-free, content-hidden authority preview for explicit stopped-store adoption. */
export interface PendingMigrateReplayAdoptionPreview {
  readonly action: MigrateAction;
  readonly projection: ReturnType<typeof emptyReplayProjection>;
  readonly ownedLifecycleSources: readonly string[];
  readonly pendingMemoryIds: readonly string[];
  readonly graphEntityIds: readonly string[];
  readonly graphAssociationKeys: readonly string[];
  readonly commitment: string;
}

interface LlmDecision {
  readonly action: MigrateAction;
  readonly dueAt?: string;
  readonly collection?: string;
}

interface DurableMigrateDecision {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly action: MigrateAction;
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly before: MemoryRecord;
  readonly updated: MemoryRecord;
  readonly vector?: readonly number[];
  readonly collection?: string;
}

type DurableMigrateApplyDeps = Pick<MigrateDeps, "db" | "root" | "hooks" | "canonicalGraphRepairGuard">;

interface CanonicalMigrationState {
  readonly file: string;
  readonly snapshot: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
  readonly parsed: ReturnType<typeof parseDailyFile>;
  readonly lineNumber: number;
  readonly bullet: Bullet;
}

class CanonicalMigrationMultiplicityError extends Error {}

const MIGRATE_MARKER = "mono-agent-migrate:";
const MAX_MONTHLY_AUDIT_BYTES = 8 * 1024 * 1024;
const MAX_COLLECTION_INPUT_CHARS = 128;
const MAX_COLLECTION_SLUG_CHARS = 64;
const COLLECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INVALID_COLLECTION_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const VALID_ACTIONS = new Set<string>(["promote", "reschedule", "cluster", "forget"]);

function buildMigratePrompt(id: string, text: string): string {
  return `You are a BuJo (Bullet Journal) migration assistant. This memory has been open for over 30 days with low salience.

MEMORY:
id=${id}
text="${text}"

Decide what to do with it. Return ONLY a JSON object (no prose, no code fences):
{"action":"promote|reschedule|cluster|forget","dueAt":"<ISO 8601, only for reschedule>","collection":"<slug, only for cluster>"}

- promote: worth keeping + elevating salience
- reschedule: has a future due date, schedule it
- cluster: belongs to a named collection/theme (provide slug)
- forget: no longer relevant, drop it`;
}

/** Monthly BuJo migration ritual: review aging open memories and apply LLM decisions. */
export async function migrate(deps: MigrateDeps): Promise<MigrateResult> {
  return await withSerializedBujoMutation(
    deps,
    async (recovery) => await migrateUnlocked(deps, recovery.migrationAction),
  );
}

/**
 * Forget an operator-selected set of BuJo memories without asking an LLM to
 * choose them. The ordinary durable migration transaction remains the sole
 * mutation path, so canonical source, replay authority, and SQLite cannot
 * silently diverge.
 */
export async function forgetExplicitMemories(
  deps: ExplicitForgetDeps,
): Promise<ExplicitForgetResult> {
  return await withSerializedBujoMutation(
    { root: deps.root, db: deps.db, tier: "bujo", ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }) },
    async (recovery) => {
      deps.abortSignal?.throwIfAborted();
      if (readBujoCanonicalSourceFingerprint(deps.root) !== deps.expectedSourceFingerprint) {
        throw new Error("memory-forget: canonical source changed after the plan was prepared.");
      }
      if (deps.ids.length === 0 || new Set(deps.ids).size !== deps.ids.length) {
        throw new Error("memory-forget: ids must be a non-empty set without duplicates.");
      }

      const before = previewExplicitForgetRecords(deps.root, deps.db, deps.ids);
      const now = deps.now();
      const updated = before.map((record) => updatedRecord(record, "forget", now, undefined, undefined));
      const vectors = await deps.db.prepareUpsertVectors(updated);
      deps.abortSignal?.throwIfAborted();

      // Provider work happens before the first durable marker. Recheck every
      // source afterwards so a paid vector cannot bind to stale source bytes.
      before.forEach((record) => assertCanonicalDecisionState(deps.root, record));
      const decisions = before.map((record, index) => durableDecision(
        record,
        updated[index]!,
        "forget",
        now,
        vectors[index],
        undefined,
      ));
      for (const decision of decisions) {
        const monthlyFile = monthlyFileFor(now);
        appendPendingDecision(deps.root, monthlyFile, decision);
        applyDurableDecision(deps, monthlyFile, decision);
      }
      return {
        forgotten: decisions.length,
        recoveredPendingDecision: recovery.migrationAction !== undefined,
        sourceFingerprint: readBujoCanonicalSourceFingerprint(deps.root),
      };
    },
  );
}

/** Content-free read-only validation for an explicit forget plan. */
export function previewExplicitForgetMemories(
  root: string,
  db: MemoryDb,
  ids: readonly string[],
): ExplicitForgetPreview {
  return { eligible: previewExplicitForgetRecords(root, db, ids).length };
}

/** Read-only canonical-source validation used while preparing an operator plan. */
export function previewCanonicalExplicitForgetMemories(
  root: string,
  ids: readonly string[],
): ExplicitForgetPreview {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("memory-forget: ids must be a non-empty set without duplicates.");
  }
  const wanted = new Set(ids);
  const matches = new Map<string, Bullet[]>();
  const dailyNames = new Set(listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  }));
  const paths = [
    ...listCanonicalRootFileNames(root, {
      include: (name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name) && !dailyNames.has(name),
    }),
    ...[...dailyNames].sort().map((name) => `daily/${name}`),
  ];
  for (const path of paths) {
    const snapshot = readCanonicalFileSnapshot(root, path);
    if (snapshot === undefined) continue;
    for (const bullet of parseDailyFile(snapshot.content).bullets) {
      if (!wanted.has(bullet.id)) continue;
      const found = matches.get(bullet.id) ?? [];
      found.push(bullet);
      matches.set(bullet.id, found);
    }
  }
  for (const id of ids) {
    const found = matches.get(id) ?? [];
    if (found.length !== 1) {
      throw new Error(`memory-forget: memory ${id} requires exactly one canonical source bullet.`);
    }
    if (found[0]!.status === "dropped" || found[0]!.status === "invalidated") {
      throw new Error(`memory-forget: memory ${id} is already terminal.`);
    }
  }
  return { eligible: ids.length };
}

function previewExplicitForgetRecords(
  root: string,
  db: MemoryDb,
  ids: readonly string[],
): readonly MemoryRecord[] {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("memory-forget: ids must be a non-empty set without duplicates.");
  }
  return ids.map((id) => {
    const record = db.get(id);
    if (record === undefined) {
      throw new Error(`memory-forget: unknown memory id ${id}.`);
    }
    if (record.status === "dropped" || record.status === "invalidated") {
      throw new Error(`memory-forget: memory ${id} is already terminal.`);
    }
    assertCanonicalDecisionState(root, record);
    return record;
  });
}

/** The caller holds the per-root mutation lease for planning through durable application. */
async function migrateUnlocked(
  deps: MigrateDeps,
  recoveredAction: MigrateAction | undefined,
): Promise<MigrateResult> {
  deps.abortSignal?.throwIfAborted();
  const now = deps.now();
  let promoted = recoveredAction === "promote" ? 1 : 0;
  let rescheduled = recoveredAction === "reschedule" ? 1 : 0;
  let clustered = recoveredAction === "cluster" ? 1 : 0;
  let forgotten = recoveredAction === "forget" ? 1 : 0;

  const aging = deps.db.agingOpen(now, { olderThanDays: 30, maxSalience: 0.4, limit: 50 });

  for (const item of aging) {
    // Canonical identity is a prerequisite for paying the model or embedding
    // provider. Missing source is an isolatable stale-index item; duplicate ids
    // are ambiguous corruption and must stop the ritual without rewriting both.
    try {
      assertCanonicalDecisionState(deps.root, item);
    } catch (error) {
      if (error instanceof CanonicalMigrationMultiplicityError) throw error;
      continue;
    }

    let decision: DurableMigrateDecision | undefined;
    try {
      const prompt = buildMigratePrompt(item.id, item.text);
      let raw: string;
      try {
        raw = await deps.llm.complete(prompt, {
          label: "migrate",
          ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
        });
      } catch (cause) {
        deps.abortSignal?.throwIfAborted();
        // A model outage fails every item, so tag it and let the catch below surface it rather than
        // swallowing it as a per-item skip (which would make a dead model look like an empty migration).
        throw new MemoryModelError("llm", "migrate", cause);
      }
      deps.abortSignal?.throwIfAborted();
      const parsed = parseJsonLoose<LlmDecision>(raw);

      // Validate: must be a non-null object with a recognized action
      if (
        parsed === undefined ||
        parsed === null ||
        typeof parsed !== "object" ||
        !VALID_ACTIONS.has(parsed.action)
      ) {
        continue;
      }

      const action = parsed.action;
      const collection = action === "cluster"
        ? normalizeCollectionSlug(parsed.collection)
        : undefined;
      if (action === "cluster" && (collection === undefined || collection.length === 0)) continue;
      const updated = updatedRecord(item, action, now, parsed.dueAt, collection);
      let vector: readonly number[] | undefined;
      try {
        [vector] = await deps.db.prepareUpsertVectors([updated]);
      } catch (cause) {
        deps.abortSignal?.throwIfAborted();
        throw new MemoryModelError("embedding", "migrate", cause);
      }
      deps.abortSignal?.throwIfAborted();
      // Recheck after both provider awaits. A concurrent source edit cannot be
      // bound into a paid durable decision merely because preflight once passed.
      assertCanonicalDecisionState(deps.root, item);
      decision = durableDecision(item, updated, action, now, vector, collection);
    } catch (err) {
      deps.abortSignal?.throwIfAborted();
      // A model outage is systemic — surface it (the ritual scheduler logs it).
      if (err instanceof MemoryModelError) throw err;
      if (err instanceof CanonicalMigrationMultiplicityError) throw err;
      // Per-item isolation: a genuine per-item data error (e.g. a missing daily file) is skipped so
      // it doesn't abort the rest of the batch.
      continue;
    }

    // Publication is the commitment boundary. Any later failure must stop the
    // ritual with this one marker intact so retry reuses the exact paid
    // decision instead of accumulating more hidden vectors or model calls.
    const monthlyFile = monthlyFileFor(now);
    appendPendingDecision(deps.root, monthlyFile, decision);
    deps.hooks?.afterDecisionDurable?.(decision.decisionId);
    applyDurableDecision(deps, monthlyFile, decision);
    increment(decision.action);
  }

  return {
    promoted,
    rescheduled,
    clustered,
    forgotten,
    reviewed: aging.length + (recoveredAction === undefined ? 0 : 1),
  };

  function increment(action: MigrateAction): void {
    if (action === "promote") promoted += 1;
    else if (action === "reschedule") rescheduled += 1;
    else if (action === "cluster") clustered += 1;
    else forgotten += 1;
  }
}

function updatedRecord(
  item: MemoryRecord,
  action: MigrateAction,
  now: Date,
  rawDueAt: unknown,
  collection: string | undefined,
): MemoryRecord {
  if (action === "promote") return { ...item, salience: Math.max(0.5, Math.min(1, item.salience + 0.3)) };
  if (action === "reschedule") {
    const dueAt = typeof rawDueAt === "string" ? rawDueAt : undefined;
    return {
      ...item,
      status: "scheduled",
      ...(dueAt === undefined ? {} : { dueAt }),
    };
  }
  if (action === "cluster") return { ...item, status: "migrated", collection: collection! };
  return { ...item, status: "dropped", validTo: now.toISOString() };
}

function normalizeCollectionSlug(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0
    || [...value].length > MAX_COLLECTION_INPUT_CHARS
    || INVALID_COLLECTION_CONTROL.test(value)) {
    return undefined;
  }
  const normalized = value.normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[ _]+/gu, "-");
  if (normalized.length === 0 || normalized.length > MAX_COLLECTION_SLUG_CHARS
    || !COLLECTION_SLUG.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function durableDecision(
  before: MemoryRecord,
  updated: MemoryRecord,
  action: MigrateAction,
  now: Date,
  vector: readonly number[] | undefined,
  collection: string | undefined,
): DurableMigrateDecision {
  if (vector === undefined) throw new Error("memory-migrate: migration requires a prepared embedding vector.");
  const at = now.toISOString();
  const payload: Omit<DurableMigrateDecision, "decisionId"> = {
    schemaVersion: 1,
    action,
    id: before.id,
    text: before.text,
    at,
    before,
    updated,
    ...(vector === undefined ? {} : { vector }),
    ...(collection === undefined ? {} : { collection }),
  };
  return { ...payload, decisionId: decisionHash(payload) };
}

function monthlyFileFor(now: Date): string {
  return `monthly/${now.toISOString().slice(0, 7)}.md`;
}

function appendPendingDecision(root: string, file: string, decision: DurableMigrateDecision): void {
  const date = decision.at.slice(0, 10);
  const addition = `\n## ${date}\n- ${decision.action} ${decision.id}: ${JSON.stringify(decision.text)}\n`
    + `${pendingMarker(decision)}\n`;
  const current = readCanonicalFileSnapshot(root, file, {
    allowMissing: true,
    maxBytes: MAX_MONTHLY_AUDIT_BYTES,
  });
  if ((current?.identity.size ?? 0) + Buffer.byteLength(addition, "utf8") > MAX_MONTHLY_AUDIT_BYTES) {
    throw new Error(`memory-migrate: monthly audit "${file}" exceeds its ${MAX_MONTHLY_AUDIT_BYTES}-byte bound.`);
  }
  appendCanonicalFile(
    root,
    file,
    addition,
  );
}

function pendingMarker(decision: DurableMigrateDecision): string {
  const encoded = Buffer.from(JSON.stringify(decision), "utf8").toString("base64url");
  return `<!-- ${MIGRATE_MARKER}${encoded} -->`;
}

function applyDurableDecision(
  deps: DurableMigrateApplyDeps,
  file: string,
  decision: DurableMigrateDecision,
): void {
  if (decision.action === "cluster" && deps.canonicalGraphRepairGuard === undefined) {
    throw new Error("memory-migrate: clustered durable replay requires a canonical graph repair parity guard.");
  }
  const preflight = preflightDurableDecision(deps.root, deps.db, decision);
  const { replayDelta, dbAfter, expectedDb, canonical, canonicalAfter } = preflight;
  const preparedReplay = prepareReplayProjectionDelta(deps.root, replayDelta);
  if (preparedReplay.prior.state.kind === "missing") {
    assertReplayDbStateSubsetOfProjection(deps.db, preparedReplay.projection);
  }
  if (!canonicalAfter) rewriteCanonicalDecision(deps.root, canonical, decision);
  if (!canonicalDecisionStateMatches(deps.root, decision.updated)) {
    throw new Error(`memory-migrate: canonical outcome for ${decision.id} did not match its durable decision.`);
  }
  const cluster = decision.action === "cluster"
    ? applyCanonicalClusterOutcome(deps.root, decision)
    : undefined;
  const publishedReplay = preparedReplay.changed
    ? withManagedRollbackRetirement(
        deps.root,
        "replay",
        () => publishPreparedReplayProjection(deps.root, preparedReplay),
      )
    : publishPreparedReplayProjection(deps.root, preparedReplay);
  assertProjectionContainsDelta(publishedReplay.projection, replayDelta);
  const committedSourceFingerprint = readBujoCanonicalSourceFingerprint(deps.root);

  if (!dbAfter) deps.db.commitPreparedUpserts([expectedDb], [decision.vector]);
  deps.db.replaceReplayProjection(replayProjectionDbReplacement(publishedReplay.projection));
  assertReplayProjectionMatchesDb(deps.db, publishedReplay.projection);
  if (cluster !== undefined) {
    replaceDbCanonicalGraphProjectionWithParity(
      deps.root,
      deps.db,
      deps.canonicalGraphRepairGuard!,
    );
    assertClusterOutcome(deps.root, deps.db, decision.id, cluster.entity, cluster.association);
  }
  const after = deps.db.get(decision.id);
  if (after === undefined || !sameMemoryRecord(after, expectedDb)) {
    throw new Error(`memory-migrate: SQLite outcome for ${decision.id} did not match its durable decision.`);
  }
  if (!canonicalDecisionStateMatches(deps.root, decision.updated)) {
    throw new Error(`memory-migrate: canonical outcome for ${decision.id} changed before completion.`);
  }
  if (readBujoCanonicalSourceFingerprint(deps.root) !== committedSourceFingerprint) {
    throw new Error("memory-migrate: canonical source changed during durable replay projection commit.");
  }
  deps.hooks?.afterActionCommitted?.(decision.decisionId);
  assertProjectionContainsDelta(readReplayProjectionStrict(deps.root).projection, replayDelta);
  removePendingDecision(deps.root, file, decision);
}

interface DurableDecisionPreflight {
  readonly replayDelta: ReplayProjectionDelta;
  readonly dbAfter: boolean;
  readonly expectedDb: MemoryRecord;
  readonly canonical: CanonicalMigrationState;
  readonly canonicalAfter: boolean;
}

/** Exact provider-free before/after validation shared by recovery and adoption. */
function preflightDurableDecision(
  root: string,
  db: MemoryDb,
  decision: DurableMigrateDecision,
): DurableDecisionPreflight {
  const replayDelta = migrationReplayDelta(decision);
  const current = db.get(decision.id);
  const dbBefore = current !== undefined && sameDecisionState(current, decision.before);
  const dbAfter = current !== undefined && sameDecisionState(current, decision.updated);
  const canonical = readCanonicalMigrationState(root, decision.updated);
  const canonicalBefore = bulletMatchesRecord(canonical.bullet, decision.before);
  const canonicalAfter = bulletMatchesRecord(canonical.bullet, decision.updated);
  if (current === undefined || (!dbBefore && !dbAfter) || (!canonicalBefore && !canonicalAfter)) {
    throw new Error(`memory-migrate: durable decision ${decision.decisionId} no longer matches memory ${decision.id}.`);
  }
  const expectedDb = dbAfter ? current : withLatestLiveState(decision.updated, current);
  if (!dbAfter) {
    // Stored vectors and the active DB identity must agree before any source
    // or authority publication. This assertion consumes only durable bytes.
    db.assertPreparedUpserts([expectedDb], [decision.vector]);
  }
  return { replayDelta, dbAfter, expectedDb, canonical, canonicalAfter };
}

function applyCanonicalClusterOutcome(
  root: string,
  decision: DurableMigrateDecision,
): { readonly entity: EntityRecord; readonly association: MemoryEntityAssociation } {
  const collection = decision.collection!;
  const entity: EntityRecord = {
    id: `collection:${collection}`,
    name: collection,
    type: "collection",
    createdAt: decision.at,
  };
  const association: MemoryEntityAssociation = {
    memoryId: decision.id,
    entityId: entity.id,
    provenance: "capture",
    createdAt: decision.at,
  };
  // Collection membership is canonical graph evidence, not SQLite-only ritual
  // state. Any canonical or mirror fault leaves the marker for exact replay.
  const canonical = appendGraphBatch(root, { entities: [entity], associations: [association] });
  const canonicalEntity = canonical.entities[0];
  const canonicalAssociation = canonical.associations[0];
  if (canonicalEntity === undefined || canonicalAssociation === undefined) {
    throw new Error(`memory-migrate: canonical collection graph outcome for ${decision.id} is incomplete.`);
  }
  return { entity: canonicalEntity, association: canonicalAssociation };
}

function assertClusterOutcome(
  root: string,
  db: MemoryDb,
  memoryId: string,
  entity: EntityRecord,
  association: MemoryEntityAssociation,
): void {
  const graph = readGraph(root);
  const sourceEntity = graph.entities.find((candidate) => candidate.id === entity.id);
  const sourceAssociation = graph.associations.find((candidate) => (
    candidate.memoryId === association.memoryId && candidate.entityId === association.entityId
  ));
  const dbEntity = db.getEntity(entity.id);
  const dbAssociation = db.associationsForMemory(memoryId).find((candidate) => (
    candidate.entityId === association.entityId
  ));
  if (!sameEntity(sourceEntity, entity)
    || !sameAssociation(sourceAssociation, association)
    || !sameEntity(dbEntity, entity)
    || !sameAssociation(dbAssociation, association)
    || !db.edges(memoryId).some((edge) => edge.kind === "supports" && edge.dst === entity.id)) {
    throw new Error(`memory-migrate: collection graph outcome for ${memoryId} did not match its durable decision.`);
  }
}

function removePendingDecision(root: string, file: string, decision: DurableMigrateDecision): void {
  const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_MONTHLY_AUDIT_BYTES });
  if (snapshot === undefined) throw new Error(`memory-migrate: monthly audit "${file}" disappeared.`);
  const marker = pendingMarker(decision);
  const lines = snapshot.content.split("\n");
  const matches = lines.filter((line) => line.trim() === marker);
  if (matches.length !== 1) {
    throw new Error(`memory-migrate: pending marker ${decision.decisionId} is missing or duplicated.`);
  }
  writeCanonicalFileAtomic(
    root,
    file,
    lines.filter((line) => line.trim() !== marker).join("\n"),
    snapshot.identity,
  );
}

type CanonicalMigrationPatch = Partial<Pick<Bullet, "status" | "salience" | "dueAt">>;

function canonicalPatch(decision: DurableMigrateDecision): CanonicalMigrationPatch | undefined {
  if (decision.action === "promote") return { salience: decision.updated.salience };
  if (decision.action === "reschedule") {
    return {
      status: "scheduled",
      ...(decision.updated.dueAt === undefined ? {} : { dueAt: decision.updated.dueAt }),
    };
  }
  if (decision.action === "cluster") return { status: "migrated" };
  if (decision.action === "forget") return { status: "dropped" };
  return undefined;
}

function sameDecisionState(left: MemoryRecord, right: MemoryRecord): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.status === right.status
    && left.text === right.text
    && left.salience === right.salience
    && left.isInsight === right.isInsight
    && left.createdAt === right.createdAt
    && left.validTo === right.validTo
    && left.supersededBy === right.supersededBy
    && left.supersededAt === right.supersededAt
    && left.dueAt === right.dueAt
    && left.collection === right.collection
    && left.source.file === right.source.file
    && left.embeddingModel === right.embeddingModel
    && left.dim === right.dim;
}

function assertCanonicalDecisionState(root: string, record: MemoryRecord): void {
  const canonical = readCanonicalMigrationState(root, record);
  if (!bulletMatchesRecord(canonical.bullet, record)) {
    throw new Error(`memory-migrate: canonical source does not exactly match memory ${record.id}.`);
  }
}

function canonicalDecisionStateMatches(root: string, record: MemoryRecord): boolean {
  const canonical = readCanonicalMigrationState(root, record);
  return bulletMatchesRecord(canonical.bullet, record);
}

function readCanonicalMigrationState(root: string, record: MemoryRecord): CanonicalMigrationState {
  const file = record.source.file;
  if (file === undefined) {
    throw new Error(`memory-migrate: memory ${record.id} requires exactly one canonical source bullet.`);
  }
  assertCanonicalDailySourcePath(file);
  const snapshot = readCanonicalFileSnapshot(root, file, { allowMissing: true });
  if (snapshot === undefined) {
    throw new Error(`memory-migrate: canonical source "${file}" is missing for memory ${record.id}.`);
  }
  const parsed = parseDailyFile(snapshot.content);
  const matches = parsed.lines.filter((line) => line.bullet?.id === record.id);
  if (matches.length !== 1) {
    if (matches.length > 1) {
      throw new CanonicalMigrationMultiplicityError(
        `memory-migrate: canonical source "${file}" contains ${matches.length} bullets for ${record.id}; exactly one is required.`,
      );
    }
    throw new Error(`memory-migrate: canonical source "${file}" does not contain memory ${record.id}.`);
  }
  const match = matches[0]!;
  return {
    file,
    snapshot,
    parsed,
    lineNumber: match.lineNumber,
    bullet: match.bullet!,
  };
}

function rewriteCanonicalDecision(
  root: string,
  canonical: CanonicalMigrationState,
  decision: DurableMigrateDecision,
): void {
  const patch = canonicalPatch(decision);
  if (patch === undefined) return;
  const lines: DailyFile["lines"] = canonical.parsed.lines.map((line) => (
    line.lineNumber === canonical.lineNumber && line.bullet?.id === decision.id
      ? { ...line, bullet: { ...line.bullet, ...patch } }
      : line
  ));
  const serialized = serializeDailyFile({ lines });
  if (serialized === canonical.snapshot.content) return;
  withManagedRollbackRetirement(root, "daily", () => {
    writeCanonicalFileAtomic(
      root,
      canonical.file,
      serialized,
      canonical.snapshot.identity,
    );
  });
}

function bulletMatchesRecord(bullet: Bullet, record: MemoryRecord): boolean {
  return bullet.id === record.id
    && bullet.type === record.type
    && bullet.status === record.status
    && bullet.text === record.text
    && bullet.salience === record.salience
    && bullet.isInsight === record.isInsight
    && bullet.createdAt === record.createdAt
    && bullet.dueAt === record.dueAt;
}

function withLatestLiveState(updated: MemoryRecord, current: MemoryRecord): MemoryRecord {
  const {
    accessCount: _accessCount,
    lastAccessedAt: _lastAccessedAt,
    validFrom: _validFrom,
    tags: _tags,
    source: _source,
    ...durable
  } = updated;
  return {
    ...durable,
    accessCount: current.accessCount,
    ...(current.lastAccessedAt === undefined ? {} : { lastAccessedAt: current.lastAccessedAt }),
    ...(current.validFrom === undefined ? {} : { validFrom: current.validFrom }),
    tags: [...current.tags],
    source: { ...current.source },
  };
}

function sameMemoryRecord(left: MemoryRecord, right: MemoryRecord): boolean {
  return sameDecisionState(left, right)
    && left.validFrom === right.validFrom
    && left.lastAccessedAt === right.lastAccessedAt
    && left.accessCount === right.accessCount
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index])
    && left.source.session === right.source.session
    && left.source.line === right.source.line;
}

function sameEntity(left: EntityRecord | undefined, right: EntityRecord): boolean {
  return left !== undefined
    && left.id === right.id
    && left.name === right.name
    && left.type === right.type
    && left.summary === right.summary
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function sameAssociation(
  left: MemoryEntityAssociation | undefined,
  right: MemoryEntityAssociation,
): boolean {
  return left !== undefined
    && left.memoryId === right.memoryId
    && left.entityId === right.entityId
    && left.provenance === right.provenance
    && left.createdAt === right.createdAt;
}

function readPendingDecision(
  root: string,
): {
  readonly file: string;
  readonly snapshot: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
  readonly decision: DurableMigrateDecision;
} | undefined {
  const files = listCanonicalFileNames(root, "monthly", {
    allowMissing: true,
    include: (name) => /^\d{4}-\d{2}\.md$/u.test(name),
  });
  const pending: Array<{
    readonly file: string;
    readonly snapshot: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
    readonly decision: DurableMigrateDecision;
  }> = [];
  for (const name of files) {
    const file = `monthly/${name}`;
    const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_MONTHLY_AUDIT_BYTES });
    if (snapshot === undefined) continue;
    for (const raw of snapshot.content.split("\n")) {
      const line = raw.trim();
      const prefix = `<!-- ${MIGRATE_MARKER}`;
      if (!line.startsWith("<!--") || !line.includes(MIGRATE_MARKER)) continue;
      if (!line.startsWith(prefix) || !line.endsWith(" -->")) {
        throw new Error(`memory-migrate: malformed pending marker in "${file}".`);
      }
      const payload = line.slice(prefix.length, -4);
      const decision = parseDurableDecision(payload);
      pending.push({ file, snapshot, decision });
    }
  }
  if (pending.length > 1) throw new Error("memory-migrate: multiple pending monthly decisions require operator repair.");
  return pending[0];
}

/**
 * Finish one already-paid migration transaction synchronously from its stored
 * vector and exact before/after states. No LLM or embedding provider is called.
 */
export function recoverPendingMigrateDecision(
  root: string,
  db: MemoryDb,
  canonicalGraphRepairGuard?: CanonicalGraphRepairGuard,
): boolean {
  return recoverPendingMigrateDecisionWithMetadata(root, db, canonicalGraphRepairGuard) !== undefined;
}

/** Provider-free recovery metadata used by the shared per-root mutation fence. */
export function recoverPendingMigrateDecisionWithMetadata(
  root: string,
  db: MemoryDb,
  canonicalGraphRepairGuard?: CanonicalGraphRepairGuard,
): PendingMigrateRecovery | undefined {
  const pending = readPendingDecision(root);
  if (pending === undefined) return undefined;
  applyDurableDecision({
    root,
    db,
    ...(canonicalGraphRepairGuard === undefined ? {} : { canonicalGraphRepairGuard }),
  }, pending.file, pending.decision);
  return { action: pending.decision.action };
}

/** Read-only, provider-free probe for an admitted durable migration mutation. */
export function hasPendingMigrateDecision(root: string): boolean {
  return readPendingDecision(root) !== undefined;
}

/** Validate a durable migration marker in any supported before/after crash phase without writing. */
export function previewPendingMigrateReplayAdoption(
  root: string,
  db: MemoryDb,
): PendingMigrateReplayAdoptionPreview | undefined {
  const pending = readPendingDecision(root);
  if (pending === undefined) return undefined;
  const preflight = preflightDurableDecision(root, db, pending.decision);
  const projection = mergeReplayProjectionDelta(emptyReplayProjection(), preflight.replayDelta);
  const ownedLifecycleSources = pending.decision.action === "forget" ? [pending.decision.id] : [];
  const pendingMemoryIds = [pending.decision.id];
  const graphEntityIds = pending.decision.action === "cluster"
    ? [`collection:${pending.decision.collection!}`]
    : [];
  const graphAssociationKeys = pending.decision.action === "cluster"
    ? [`${pending.decision.id}\0collection:${pending.decision.collection!}`]
    : [];
  const commitment = replayProjectionAuthorityId({
    schemaVersion: 1,
    kind: "pending-migration-adoption-preview",
    file: pending.file,
    sha256: createHash("sha256").update(pending.snapshot.content).digest("hex"),
    identity: pending.snapshot.identity,
    decisionId: pending.decision.decisionId,
    action: pending.decision.action,
    projection,
    ownedLifecycleSources,
    pendingMemoryIds,
    graphEntityIds,
    graphAssociationKeys,
  });
  return {
    action: pending.decision.action,
    projection,
    ownedLifecycleSources,
    pendingMemoryIds,
    graphEntityIds,
    graphAssociationKeys,
    commitment,
  };
}

export function assertPendingMigrateReplayAdoptionPreview(
  root: string,
  db: MemoryDb,
  expectedCommitment: string,
): void {
  const current = previewPendingMigrateReplayAdoption(root, db);
  if (current === undefined || current.commitment !== expectedCommitment) {
    throw new Error("memory-migrate: durable adoption preview changed before replay authority publication.");
  }
}

/** Refuse maintenance that cannot carry a paid pending migration transaction. */
export function assertNoPendingMigrateDecision(root: string): void {
  const pending = readPendingDecision(root);
  if (pending !== undefined) {
    throw new Error(
      `memory-migrate: durable decision ${pending.decision.decisionId} is pending; `
      + "restart the writable BuJo store under its current identity or run migration recovery before rebuilding.",
    );
  }
}

function parseDurableDecision(encoded: string): DurableMigrateDecision {
  let value: unknown;
  try {
    if (encoded.length > MAX_MONTHLY_AUDIT_BYTES) throw new Error("pending marker exceeds bound");
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("pending marker is not canonical base64url");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("memory-migrate: malformed durable pending decision.");
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.decisionId !== "string" || !/^[a-f0-9]{64}$/u.test(value.decisionId)
    || !VALID_ACTIONS.has(String(value.action))
    || typeof value.id !== "string" || value.id.length === 0
    || typeof value.text !== "string"
    || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || !isMemoryRecord(value.before)
    || !isMemoryRecord(value.updated)
    || value.before.id !== value.id || value.updated.id !== value.id
    || !Array.isArray(value.vector) || value.vector.length === 0 || value.vector.length > 16_384
    || value.vector.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error("memory-migrate: invalid durable pending decision schema.");
  }
  const decision = value as unknown as DurableMigrateDecision;
  const { decisionId: _decisionId, ...payload } = decision;
  if (decision.decisionId !== decisionHash(payload) || !validDecisionTransition(decision)) {
    throw new Error("memory-migrate: durable pending decision binding is invalid.");
  }
  return decision;
}

function decisionHash(decision: Omit<DurableMigrateDecision, "decisionId">): string {
  return createHash("sha256").update(JSON.stringify(decision)).digest("hex");
}

function migrationReplayDelta(decision: DurableMigrateDecision): ReplayProjectionDelta {
  return decision.action === "forget"
    ? {
        terminals: [{
          id: decision.id,
          at: decision.at,
          authorityKind: "migration",
          authorityId: decision.decisionId,
        }],
        supersedes: [],
        threads: [],
      }
    : { terminals: [], supersedes: [], threads: [] };
}

function validDecisionTransition(decision: DurableMigrateDecision): boolean {
  const canonicalCollection = normalizeCollectionSlug(decision.collection);
  if (decision.text !== decision.before.text
    || decision.updated.id !== decision.before.id
    || decision.updated.source.file !== decision.before.source.file
    || (decision.action === "cluster"
      ? canonicalCollection === undefined || canonicalCollection !== decision.collection
        || decision.updated.collection !== decision.collection
      : decision.collection !== undefined)) {
    return false;
  }
  const expected = updatedRecord(
    decision.before,
    decision.action,
    new Date(decision.at),
    decision.updated.dueAt,
    decision.collection,
  );
  return JSON.stringify(expected) === JSON.stringify(decision.updated);
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isRecord(value) || !isRecord(value.source) || !Array.isArray(value.tags)) return false;
  return typeof value.id === "string"
    && (value.type === "task" || value.type === "event" || value.type === "note")
    && (value.status === "open" || value.status === "done" || value.status === "scheduled"
      || value.status === "migrated" || value.status === "dropped" || value.status === "invalidated")
    && typeof value.text === "string"
    && typeof value.salience === "number" && Number.isFinite(value.salience)
    && typeof value.isInsight === "boolean"
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.accessCount === "number" && Number.isInteger(value.accessCount) && value.accessCount >= 0
    && value.tags.every((tag) => typeof tag === "string")
    && (value.source.file === undefined || typeof value.source.file === "string")
    && (value.source.line === undefined || (Number.isInteger(value.source.line) && Number(value.source.line) > 0))
    && (value.dueAt === undefined || typeof value.dueAt === "string")
    && (value.collection === undefined || typeof value.collection === "string")
    && (value.validTo === undefined || typeof value.validTo === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

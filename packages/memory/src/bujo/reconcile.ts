import { relative } from "node:path";

import type { MemoryDb, MemoryRecord, SimilarHit } from "../store/index.js";

import {
  replayCaptureIntent,
  writeCaptureIntent,
  type CaptureIntentAction,
} from "./capture-outbox.js";
import { dailyFilePath, readBullet } from "./daily.js";
import {
  MAX_RECONCILIATION_TEXT_CODE_POINTS,
  normalizeCandidateText,
  type CandidateMemory,
} from "./distill.js";
import { parseJsonExact, parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import type { CanonicalGraphRepairGuard } from "./graph.js";
import { MemoryModelError, MemoryModelOutputError } from "./model-error.js";
import { withSerializedBujoMutation } from "./mutation-lock.js";
import type { Bullet } from "./types.js";

/** The outcome of reconciling a single candidate against the existing index. */
export type ReconcileAction =
  | { readonly kind: "add"; readonly id: string }
  | { readonly kind: "update"; readonly id: string }
  | { readonly kind: "supersede"; readonly oldId: string; readonly newId: string }
  | { readonly kind: "noop"; readonly id: string };

export interface ReconcileDeps {
  readonly db: MemoryDb;
  readonly root: string;
  readonly llm: LlmComplete;
  readonly nextId: () => string;
  readonly now: () => Date;
  readonly abortSignal?: AbortSignal;
  /** Distance below which an ADD also threads a `thread` edge to the neighbour. Default 0.35. */
  readonly threadThreshold?: number;
  /** Distance below which we consult the LLM to classify; above → ADD outright (skip LLM). Default 0.5. */
  readonly dupThreshold?: number;
  /** Capture-only durable boundary invoked after provider planning and before source mutation. */
  readonly beforeBatchCommit?: (actions: readonly CaptureIntentAction[]) => void;
  /**
   * Leave persistence to the durable boundary after it publishes the prepared
   * actions. Capture uses this so its graph-bearing intent remains the sole
   * canonical/SQLite commit owner. Ordinary callers publish their own
   * memory-only intent and replay it through the same durable path.
   */
  readonly deferBatchCommit?: boolean;
  /** Strong completed-turn mode: every model decision is exact and all-or-nothing. */
  readonly strictModelOutput?: boolean;
  /** Run-owned capture plans remain replayable until durable intake resolution. */
  readonly captureRetentionKey?: string;
  readonly canonicalGraphRepairGuard?: CanonicalGraphRepairGuard;
}

const VALID_ACTIONS = new Set(["add", "update", "supersede", "noop"]);

function normalizeReconciliationText(value: unknown): string | undefined {
  return normalizeCandidateText(value, "reconcile");
}

interface Classification {
  readonly action: string;
  readonly targetId?: string;
  readonly text?: string;
}

/**
 * Reconcile distilled candidates against the existing memory index, writing to BOTH the
 * canonical markdown daily files and the SQLite index. Per-candidate planning/source errors are
 * isolated, while model and durable-commit failures stop the batch. The LLM is consulted only for
 * candidates that are close to an existing memory; clearly-novel candidates are added without an
 * LLM call.
 */
export async function reconcile(
  candidates: readonly CandidateMemory[],
  deps: ReconcileDeps,
): Promise<ReconcileAction[]> {
  return await withSerializedBujoMutation(deps, async () => await reconcileUnlocked(candidates, deps));
}

async function reconcileUnlocked(
  candidates: readonly CandidateMemory[],
  deps: ReconcileDeps,
): Promise<ReconcileAction[]> {
  const threadThreshold = deps.threadThreshold ?? 0.35;
  const dupThreshold = deps.dupThreshold ?? 0.5;
  const actions: ReconcileAction[] = [];

  for (const candidate of candidates) {
    let plan: Omit<BatchActionPlan, "index"> | undefined;
    try {
      // findSimilar embeds the query, so a down embedding model throws here for EVERY candidate —
      // a systemic outage, not a per-item data problem. Tag it so the catch below surfaces it.
      let similar: readonly SimilarHit[];
      try {
        similar = await deps.db.findSimilar(candidate.text, 5, {
          ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
        });
      } catch (cause) {
        deps.abortSignal?.throwIfAborted();
        throw new MemoryModelError("embedding", "findSimilar", cause);
      }
      deps.abortSignal?.throwIfAborted();

      // Clearly novel (nothing close enough) → ADD outright, no LLM.
      if (similar.length === 0 || (similar[0]?.distance ?? Infinity) > dupThreshold) {
        plan = planAddWithoutIndex(candidate, similar, deps, threadThreshold);
      } else {
        const decision = await classify(candidate, similar, deps);
        plan = planLegacyAction(candidate, decision, similar, deps, threadThreshold);
      }
    } catch (err) {
      // Abort is a lifecycle boundary, not an isolatable candidate failure. In
      // particular, an abort-ignoring provider may settle only after close()
      // has already released this operation's database.
      deps.abortSignal?.throwIfAborted();
      // A model outage (embedding or classify LLM) is systemic and must surface — every candidate
      // would hit it, so swallowing it would make a dead model look like a no-op capture.
      if (err instanceof MemoryModelError) throw err;
      // Per-candidate isolation: a genuine per-item *data* failure (e.g. a missing daily file during
      // UPDATE/SUPERSEDE) must not abort the rest of the batch. Skip it.
      continue;
    }

    // Once provider planning succeeds, persistence failures are systemic. In
    // particular, a replay fault leaves a published intent that must be
    // recovered before another candidate can be planned against stale state.
    actions.push(await executePlannedAction(plan, deps));
  }

  return actions;
}

/**
 * Reconcile a whole captured turn with one embedding batch and at most one LLM
 * classification call. Novel candidates bypass the second LLM call.
 */
export async function reconcileBatch(
  candidates: readonly CandidateMemory[],
  deps: ReconcileDeps,
): Promise<Array<ReconcileAction | undefined>> {
  return await withSerializedBujoMutation(deps, async () => await reconcileBatchUnlocked(candidates, deps));
}

async function reconcileBatchUnlocked(
  candidates: readonly CandidateMemory[],
  deps: ReconcileDeps,
): Promise<Array<ReconcileAction | undefined>> {
  const threadThreshold = deps.threadThreshold ?? 0.35;
  const dupThreshold = deps.dupThreshold ?? 0.5;
  let neighbours: readonly SimilarHit[][];
  try {
    neighbours = await deps.db.findSimilarMany(candidates.map((candidate) => candidate.text), 5, {
      ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    });
  } catch (cause) {
    deps.abortSignal?.throwIfAborted();
    throw new MemoryModelError("embedding", "findSimilarBatch", cause);
  }
  deps.abortSignal?.throwIfAborted();

  const reconcileIndexes = candidates.flatMap((_candidate, index) => {
    const similar = neighbours[index] ?? [];
    return similar.length > 0 && (similar[0]?.distance ?? Infinity) <= dupThreshold ? [index] : [];
  });
  const reconcileIndexSet = new Set(reconcileIndexes);
  const decisions = reconcileIndexes.length === 0
    ? new Map<number, Classification>()
    : await classifyBatch(candidates, neighbours, reconcileIndexes, deps);
  rejectConflictingTargets(decisions, deps.strictModelOutput === true);
  deps.abortSignal?.throwIfAborted();
  const plans: Array<BatchActionPlan | undefined> = candidates.map(() => undefined);
  for (const [index, candidate] of candidates.entries()) {
    const similar = neighbours[index] ?? [];
    try {
      if (!reconcileIndexSet.has(index)) {
        plans[index] = { index, ...planAddWithoutIndex(candidate, similar, deps, threadThreshold) };
      } else {
        // A close candidate with a missing or malformed batch decision must
        // fail closed. Leave its slot empty: synthesizing a noop would later
        // attach this candidate's entities to a neighbour the model never
        // selected, corrupting the precise graph.
        const decision = decisions.get(index);
        if (decision === undefined) continue;
        plans[index] = { index, ...planBatchAction(candidate, decision, similar, deps, threadThreshold) };
      }
    } catch (error) {
      if (error instanceof MemoryModelError) throw error;
      if (deps.strictModelOutput === true) throw error;
      // One malformed candidate cannot abort the rest of the turn.
    }
  }

  const writes = plans.flatMap((plan) => plan?.record === undefined ? [] : [plan]);
  let vectors: readonly (readonly number[] | undefined)[];
  try {
    // One persistence embedding batch for every ADD/UPDATE/SUPERSEDE. This
    // happens before canonical mutation so a provider outage is systemic and
    // cannot masquerade as an empty successful capture.
    vectors = await deps.db.prepareUpsertVectors(writes.map((plan) => plan.record!));
  } catch (cause) {
    throw new MemoryModelError("embedding", "persistBatch", cause);
  }
  deps.abortSignal?.throwIfAborted();

  const vectorsByIndex = new Map(writes.map((plan, index) => [plan.index, vectors[index]]));
  const preparedActions = plans.flatMap((plan) => plan === undefined ? [] : [withPreparedVector(
    plan.intent,
    plan.index,
    vectorsByIndex.get(plan.index),
  )]);
  if (deps.beforeBatchCommit !== undefined) deps.beforeBatchCommit(preparedActions);
  deps.abortSignal?.throwIfAborted();

  if (deps.deferBatchCommit === true) {
    if (deps.beforeBatchCommit === undefined) {
      throw new Error("memory-reconcile: deferred batch commit requires a durable commit boundary.");
    }
    return plans.map((plan) => plan?.action);
  }

  commitPreparedActionsDurably(preparedActions, deps);
  return plans.map((plan) => plan?.action);
}

/**
 * A batch is planned against one pre-write snapshot. Every target-bearing
 * decision contributes candidate-specific graph evidence, including NOOP.
 * Allowing any two candidates to share a target would either race mutations or
 * merge unrelated entity evidence onto one row. Fail the entire target group
 * closed before vector preflight or canonical writes.
 */
function rejectConflictingTargets(decisions: Map<number, Classification>, strict: boolean): void {
  const byTarget = new Map<string, number[]>();
  for (const [index, decision] of decisions) {
    if (decision.targetId === undefined) continue;
    const indexes = byTarget.get(decision.targetId) ?? [];
    indexes.push(index);
    byTarget.set(decision.targetId, indexes);
  }
  for (const indexes of byTarget.values()) {
    if (indexes.length < 2) continue;
    if (strict) throw new MemoryModelOutputError("classify-batch", "multiple candidates selected one target");
    for (const index of indexes) decisions.delete(index);
  }
}

interface BatchActionPlan {
  readonly index: number;
  readonly action: ReconcileAction;
  readonly intent: CaptureIntentAction;
  readonly record?: MemoryRecord;
}

/** Preserve the exported legacy reconcile semantics while sharing the batch planner's fenced writes. */
function planLegacyAction(
  candidate: CandidateMemory,
  decision: Classification | undefined,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Omit<BatchActionPlan, "index"> {
  const resolved = decision ?? closestNoop(similar);
  return resolved === undefined
    ? planAddWithoutIndex(candidate, similar, deps, threadThreshold)
    : planBatchAction(candidate, resolved, similar, deps, threadThreshold);
}

/**
 * Finish every legacy ADD/UPDATE/SUPERSEDE with the same provider-first,
 * durable boundary as reconcileBatch. No canonical source can be touched
 * until both the persistence vector and its fsynced intent exist.
 */
async function executePlannedAction(
  plan: Omit<BatchActionPlan, "index">,
  deps: ReconcileDeps,
): Promise<ReconcileAction> {
  if (plan.record === undefined) {
    deps.abortSignal?.throwIfAborted();
    commitPreparedActionsDurably([withPreparedVector(plan.intent, 0, undefined)], deps);
    return plan.action;
  }

  let vectors: readonly (readonly number[] | undefined)[];
  try {
    vectors = await deps.db.prepareUpsertVectors([plan.record]);
  } catch (cause) {
    deps.abortSignal?.throwIfAborted();
    throw new MemoryModelError("embedding", "persist", cause);
  }
  deps.abortSignal?.throwIfAborted();

  commitPreparedActionsDurably([withPreparedVector(plan.intent, 0, vectors[0])], deps);
  return plan.action;
}

const MAX_ACTIONS_PER_INTENT = 8;

/** Publish each bounded action group, then let exact replay own every write. */
function commitPreparedActionsDurably(
  actions: readonly CaptureIntentAction[],
  deps: ReconcileDeps,
): void {
  deps.abortSignal?.throwIfAborted();
  for (let offset = 0; offset < actions.length; offset += MAX_ACTIONS_PER_INTENT) {
    const bounded = actions
      .slice(offset, offset + MAX_ACTIONS_PER_INTENT)
      .map((action, candidateIndex) => ({ ...action, candidateIndex } as CaptureIntentAction));
    const handle = writeCaptureIntent(
      deps.root,
      bounded,
      { entities: [], relations: [], associations: [] },
      intentCreatedAt(bounded[0]!),
    );
    // Do not insert an async/abort gap after publication. Replay either
    // completes synchronously or leaves the exact pending intent for startup.
    replayCaptureIntent(deps.root, handle, deps.db, {
      ...(deps.canonicalGraphRepairGuard === undefined
        ? {}
        : { canonicalGraphRepairGuard: deps.canonicalGraphRepairGuard }),
    });
  }
}

function intentCreatedAt(action: CaptureIntentAction): string {
  if (action.kind === "supersede") return action.at;
  if (action.kind === "noop") return action.expected.bullet.createdAt;
  return action.record.createdAt;
}

function planBatchAction(
  candidate: CandidateMemory,
  decision: Classification,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Omit<BatchActionPlan, "index"> {
  switch (decision.action) {
    case "add":
      return planAddWithoutIndex(candidate, similar, deps, threadThreshold);
    case "noop":
      return planNoop(decision, deps);
    case "update":
      return planUpdate(candidate, decision, deps);
    case "supersede":
      return planSupersede(candidate, decision, deps);
    default:
      throw new Error("memory-reconcile: unsupported batch action.");
  }
}

function planAddWithoutIndex(
  candidate: CandidateMemory,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Omit<BatchActionPlan, "index"> {
  const now = deps.now();
  const id = deps.nextId();
  const bullet: Bullet = {
    id,
    type: candidate.type,
    status: "open",
    text: candidate.text,
    salience: candidate.salience,
    isInsight: candidate.isInsight,
    createdAt: now.toISOString(),
    refs: [],
  };
  const record = recordFor(bullet, deps.root, now);
  const file = record.source.file!;
  const threads = similar.flatMap((hit) => {
    if (hit.record.id === id || hit.distance > threadThreshold) return [];
    const weight = 1 - hit.distance;
    return Number.isFinite(weight) && weight > 0 && weight <= 1
      ? [{ src: id, dst: hit.record.id, weight }]
      : [];
  }).slice(0, 5);
  return {
    action: { kind: "add", id },
    intent: {
      candidateIndex: -1,
      kind: "add",
      id,
      after: { file, bullet },
      record,
      threads,
    },
    record,
  };
}

function planNoop(
  decision: Classification,
  deps: ReconcileDeps,
): Omit<BatchActionPlan, "index"> {
  const targetId = decision.targetId ?? "";
  const target = deps.db.get(targetId);
  if (target?.source.file === undefined) {
    throw new Error(`memory-reconcile: noop target "${targetId}" is unavailable.`);
  }
  const bullet = requireCanonicalTarget(deps.root, target.source.file, targetId);
  return {
    action: { kind: "noop", id: targetId },
    intent: {
      candidateIndex: -1,
      kind: "noop",
      id: targetId,
      expected: { file: target.source.file, bullet },
    },
  };
}

function planUpdate(
  candidate: CandidateMemory,
  decision: Classification,
  deps: ReconcileDeps,
): Omit<BatchActionPlan, "index"> {
  const targetId = decision.targetId ?? "";
  const target = deps.db.get(targetId);
  if (target === undefined || target.source.file === undefined) {
    throw new Error(`memory-reconcile: update target "${targetId}" is unavailable.`);
  }
  const before = requireCanonicalTarget(deps.root, target.source.file, targetId);
  const mergedText = decision.text ?? candidate.text;
  const after: Bullet = { ...before, text: mergedText };
  return {
    action: { kind: "update", id: targetId },
    intent: {
      candidateIndex: -1,
      kind: "update",
      id: targetId,
      before: { file: target.source.file, bullet: before },
      after: { file: target.source.file, bullet: after },
      record: { ...target, text: mergedText },
    },
    record: { ...target, text: mergedText },
  };
}

function planSupersede(
  candidate: CandidateMemory,
  decision: Classification,
  deps: ReconcileDeps,
): Omit<BatchActionPlan, "index"> {
  const targetId = decision.targetId ?? "";
  const old = deps.db.get(targetId);
  if (old === undefined || old.source.file === undefined) {
    throw new Error(`memory-reconcile: supersede target "${targetId}" is unavailable.`);
  }
  const oldSourceFile = old.source.file;
  const beforeOld = requireCanonicalTarget(deps.root, oldSourceFile, targetId);
  const now = deps.now();
  const id = deps.nextId();
  const bullet: Bullet = {
    id,
    type: candidate.type,
    status: "open",
    text: decision.text ?? candidate.text,
    salience: candidate.salience,
    isInsight: candidate.isInsight,
    createdAt: now.toISOString(),
    refs: [],
  };
  const record = recordFor(bullet, deps.root, now);
  const newSourceFile = record.source.file!;
  return {
    action: { kind: "supersede", oldId: targetId, newId: id },
    intent: {
      candidateIndex: -1,
      kind: "supersede",
      oldId: targetId,
      newId: id,
      beforeOld: { file: oldSourceFile, bullet: beforeOld },
      afterOld: { file: oldSourceFile, bullet: { ...beforeOld, status: "invalidated" } },
      afterNew: { file: newSourceFile, bullet },
      record,
      at: now.toISOString(),
    },
    record,
  };
}

function requireCanonicalTarget(root: string, file: string, id: string): Bullet {
  const bullet = readBullet(root, file, id);
  if (bullet === undefined) {
    throw new Error(`memory-reconcile: canonical source "${file}" does not contain target "${id}".`);
  }
  return bullet;
}

function withPreparedVector(
  action: CaptureIntentAction,
  candidateIndex: number,
  vector: readonly number[] | undefined,
): CaptureIntentAction {
  if (action.kind === "noop") return { ...action, candidateIndex };
  return {
    ...action,
    candidateIndex,
    ...(vector === undefined ? {} : { vector }),
  };
}

async function classifyBatch(
  candidates: readonly CandidateMemory[],
  neighbours: readonly (readonly SimilarHit[])[],
  indexes: readonly number[],
  deps: ReconcileDeps,
): Promise<Map<number, Classification>> {
  const input = indexes.map((index) => ({
    index,
    candidate: candidates[index],
    existing: (neighbours[index] ?? []).map((hit) => ({
      id: hit.record.id,
      distance: Number(hit.distance.toFixed(6)),
      text: hit.record.text,
    })),
  }));
  let raw: string;
  try {
    raw = await deps.llm.complete(
      `Classify each candidate against only its supplied existing memories. Return ONLY one exact JSON array with one object per offered index.

Use exactly one of these object shapes:
- add: {"index":N,"action":"add"}
- noop: {"index":N,"action":"noop","targetId":"existing-id"}
- update: {"index":N,"action":"update","targetId":"existing-id","text":"complete merged memory"}
- supersede: {"index":N,"action":"supersede","targetId":"existing-id","text":"complete replacement memory"}

Rules:
- add means genuinely new; noop means duplicate; update means refinement; supersede means contradiction.
- Preserve every input index exactly once. N is the exact JSON integer from that input item.
- For noop, update, and supersede, targetId is REQUIRED and copied byte-for-byte from that candidate's existing[].id. add MUST omit targetId.
- A targetId may be selected by at most one decision in the whole batch.
- add and noop MUST omit text. update and supersede REQUIRE one complete, non-empty replacement text with no leading/trailing whitespace, at most ${MAX_RECONCILIATION_TEXT_CODE_POINTS} Unicode code points, no control, formatting, surrogate, line-separator, or paragraph-separator characters, and no reserved <!--mem delimiter.
- Every object contains exactly the keys shown for its action. Do not emit duplicate object keys, nulls, extra keys, comments, or prose.

INPUT:
${JSON.stringify(input)}`,
      {
        label: "capture:reconcile-batch",
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      },
    );
  } catch (cause) {
    throw new MemoryModelError("llm", "classify-batch", cause);
  }
  if (deps.strictModelOutput === true) {
    return parseStrictBatchClassifications(raw, indexes, neighbours);
  }
  const parsed = parseJsonLoose<unknown[]>(raw);
  const decisions = new Map<number, Classification>();
  const seenIndexes = new Set<number>();
  const duplicates = new Set<number>();
  if (!Array.isArray(parsed)) return decisions;
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { index?: unknown; action?: unknown; targetId?: unknown; text?: unknown };
    const index = typeof record.index === "number" && Number.isInteger(record.index) ? record.index : -1;
    if (!indexes.includes(index) || duplicates.has(index)) continue;
    if (seenIndexes.has(index)) {
      decisions.delete(index);
      duplicates.add(index);
      continue;
    }
    seenIndexes.add(index);
    if (typeof record.action !== "string" || !VALID_ACTIONS.has(record.action)) continue;
    const targetId = typeof record.targetId === "string" ? record.targetId : undefined;
    if (record.action !== "add" && (
      targetId === undefined || !(neighbours[index] ?? []).some((hit) => hit.record.id === targetId)
    )) continue;
    const text = normalizeReconciliationText(record.text);
    decisions.set(index, {
      action: record.action,
      ...(targetId === undefined ? {} : { targetId }),
      ...(text === undefined ? {} : { text }),
    });
  }
  return decisions;
}

function parseStrictBatchClassifications(
  raw: string,
  indexes: readonly number[],
  neighbours: readonly (readonly SimilarHit[])[],
): Map<number, Classification> {
  let parsed: unknown;
  try {
    parsed = parseJsonExact<unknown>(raw);
  } catch {
    throw new MemoryModelOutputError("classify-batch", "completion is not exact JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== indexes.length) {
    throw new MemoryModelOutputError("classify-batch", "one decision per offered candidate is required");
  }
  const offered = new Set(indexes);
  const decisions = new Map<number, Classification>();
  for (const [position, value] of parsed.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MemoryModelOutputError("classify-batch", `decision ${position} is not an object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => !["index", "action", "targetId", "text"].includes(key))) {
      throw new MemoryModelOutputError("classify-batch", `decision ${position} has unknown fields`);
    }
    const index = record.index;
    const action = record.action;
    if (!Number.isInteger(index) || !offered.has(Number(index)) || decisions.has(Number(index))
      || typeof action !== "string" || !VALID_ACTIONS.has(action)) {
      throw new MemoryModelOutputError("classify-batch", `decision ${position} has an invalid index or action`);
    }
    const targetId = record.targetId;
    const text = record.text;
    if (action === "add") {
      if (targetId !== undefined || text !== undefined || keys.length !== 2) {
        throw new MemoryModelOutputError("classify-batch", "add decisions contain only index and action");
      }
      decisions.set(Number(index), { action });
      continue;
    }
    if (typeof targetId !== "string"
      || !(neighbours[Number(index)] ?? []).some((hit) => hit.record.id === targetId)) {
      throw new MemoryModelOutputError("classify-batch", "decision target was not offered for that candidate");
    }
    if (action === "noop") {
      if (text !== undefined || keys.length !== 3) {
        throw new MemoryModelOutputError("classify-batch", "noop decisions must not contain text");
      }
      decisions.set(Number(index), { action, targetId });
      continue;
    }
    const exactText = strictClassificationText(text);
    if (keys.length !== 4) {
      throw new MemoryModelOutputError("classify-batch", "update and supersede require exact text");
    }
    decisions.set(Number(index), { action, targetId, text: exactText });
  }
  if (decisions.size !== offered.size || [...offered].some((index) => !decisions.has(index))) {
    throw new MemoryModelOutputError("classify-batch", "every offered index must appear exactly once");
  }
  return decisions;
}

function strictClassificationText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || [...value].length > MAX_RECONCILIATION_TEXT_CODE_POINTS
    || Buffer.byteLength(value, "utf8") > MAX_RECONCILIATION_TEXT_CODE_POINTS * 4
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || value.includes("<!--mem")) {
    throw new MemoryModelOutputError("classify-batch", "replacement text is invalid or exceeds its bound");
  }
  return value;
}

/**
 * Ask the LLM to classify the candidate against its nearest neighbours. A malformed *reply* is
 * tolerated (→ undefined → caller fails closed to the nearest neighbour), but a model *failure* is rethrown as a
 * {@link MemoryModelError} so a dead model surfaces instead of silently degrading to ADD.
 */
async function classify(
  candidate: CandidateMemory,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
): Promise<Classification | undefined> {
  let raw: string;
  try {
    raw = await deps.llm.complete(classifyPrompt(candidate, similar), {
      label: "capture:reconcile",
      ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    });
  } catch (cause) {
    deps.abortSignal?.throwIfAborted();
    throw new MemoryModelError("llm", "classify", cause);
  }
  deps.abortSignal?.throwIfAborted();
  const parsed = parseJsonLoose<Classification>(raw);
  if (parsed === undefined || typeof parsed !== "object") return undefined;
  const action = typeof parsed.action === "string" ? parsed.action : "";
  if (!VALID_ACTIONS.has(action)) return undefined;

  const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
  // The target must be one of the neighbours we offered the LLM. "add" needs no target.
  if (action !== "add") {
    if (targetId === undefined || !similar.some((h) => h.record.id === targetId)) return undefined;
  }
  const text = normalizeReconciliationText(parsed.text);
  return {
    action,
    ...(targetId !== undefined && { targetId }),
    ...(text === undefined ? {} : { text }),
  };
}

const classifyPrompt = (candidate: CandidateMemory, similar: readonly SimilarHit[]): string => {
  const neighbours = similar
    .map((h) => `- id=${h.record.id} distance=${h.distance.toFixed(3)} text="${h.record.text}"`)
    .join("\n");
  return `CLASSIFY a new candidate memory against existing memories. Decide whether it is novel,
a duplicate, a refinement, or a contradiction. Return ONLY JSON:
{"action":"add|update|supersede|noop","targetId":"<existing id, omit for add>","text":"<merged/new text for update|supersede>"}.
- add: genuinely new information.
- noop: an exact duplicate of an existing memory (no change needed).
- update: refines/merges an existing memory; set targetId and text to the merged sentence.
- supersede: contradicts/replaces an existing memory; set targetId and text to the new sentence.

CANDIDATE: type=${candidate.type} text="${candidate.text}"

EXISTING:
${neighbours}`;
};

function closestNoop(similar: readonly SimilarHit[]): Classification | undefined {
  const id = similar[0]?.record.id;
  return id === undefined ? undefined : { action: "noop", targetId: id };
}

/** Build an index record mirroring a freshly-appended bullet (source.file is the daily file, relative to root). */
function recordFor(bullet: Bullet, root: string, now: Date): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, now)) },
  };
}

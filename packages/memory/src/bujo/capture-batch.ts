import {
  MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS,
  normalizeCandidate,
  type CandidateMemory,
} from "./distill.js";
import { normalizeExtraction, type ExtractedEntity, type ExtractedRelation } from "./entities.js";
import { MAX_MODEL_JSON_CHARS, parseJsonExact, parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import { MemoryModelError, MemoryModelOutputError } from "./model-error.js";

export const MAX_CAPTURE_MEMORIES = 8;
export const MAX_CAPTURE_ENTITIES = 16;
export const MAX_CAPTURE_RELATIONS = 16;

export interface CapturePlan {
  readonly candidates: readonly CandidateMemory[];
  readonly entities: readonly ExtractedEntity[];
  readonly relations: readonly ExtractedRelation[];
}

interface RawCapturePlan {
  readonly memories?: unknown;
  readonly entities?: unknown;
  readonly relations?: unknown;
}

const SINGLE_JSON_FENCE = /^[\t\n\r ]*```(?:[jJ][sS][oO][nN])?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t\n\r ]*$/;

const prompt = (text: string): string => `Extract one bounded, durable memory plan from the completed turn below.
Return ONLY one exact JSON object with exactly these root keys:
{"memories":[{"type":"note","text":"one atomic sentence","salience":0.8,"isInsight":false,"entityIds":["person:name"]}],"entities":[{"id":"person:name","name":"display name","type":"person"},{"id":"project:example","name":"example project","type":"project"}],"relations":[{"src":"person:name","dst":"project:example","relation":"works on"}]}

Rules:
- At most ${MAX_CAPTURE_MEMORIES} memories, ${MAX_CAPTURE_ENTITIES} entities, and ${MAX_CAPTURE_RELATIONS} relations.
- Omit chit-chat and transient tool output.
- All three root arrays are required, even when empty. Every shown object field is required; emit no other fields.
- Every memory object has exactly type, text, salience, isInsight, and entityIds. type is task, event, or note; isInsight is a JSON boolean.
- salience MUST be a finite JSON number from 0 to 1 inclusive, such as 0.8. Never use a 0-10, 0-100, or percentage scale.
- Every memory text is one distinct durable fact: non-empty, at most ${MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS} Unicode code points, no leading/trailing whitespace, no control, formatting, surrogate, line-separator, or paragraph-separator characters, and no reserved <!--mem delimiter.
- Every entity object has exactly id, name, and type. id is lowercase ASCII type:name-kebab including the colon, at most 96 characters, and its 1-32 character prefix before : exactly matches type. name is non-empty, at most 160 Unicode code points, trimmed, and contains none of the unsafe character classes forbidden for memory text.
- Every relation object has exactly src, dst, and relation. src and dst are copied entity ids. relation is non-empty, at most 96 characters, and contains lowercase ASCII letters/digits separated only by single spaces or hyphens.
- A memory.entityIds list contains ONLY entities directly stated in that same fact, copied byte-for-byte from entities[].id with no repeated id; otherwise use [].
- Relations and entityIds reference exact entity ids in this response. Never associate every memory with every turn entity.
- Do not emit duplicate JSON object keys, duplicate entity ids, duplicate relations, duplicate memories, near-duplicate memories, extra keys, comments, or prose.
- Use empty arrays when there are no durable memories, entities, or relations.

TURN:
${text}`;

/** One LLM call produces candidates and their precise graph evidence. */
export async function extractCapturePlan(text: string, llm: LlmComplete, abortSignal?: AbortSignal): Promise<CapturePlan> {
  if (text.trim().length === 0) return { candidates: [], entities: [], relations: [] };
  let raw: string;
  try {
    raw = await llm.complete(prompt(text), {
      label: "capture:extract",
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
  } catch (cause) {
    throw new MemoryModelError("llm", "capture-extract", cause);
  }
  const parsed = parseJsonLoose<RawCapturePlan>(raw);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { candidates: [], entities: [], relations: [] };
  }

  const normalizedGraph = normalizeExtraction({ entities: parsed.entities, relations: parsed.relations });
  const entities = normalizedGraph.entities.slice(0, MAX_CAPTURE_ENTITIES);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relations = normalizedGraph.relations
    .filter((relation) => entityIds.has(relation.src) && entityIds.has(relation.dst))
    .slice(0, MAX_CAPTURE_RELATIONS);
  const rawMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const normalizedCandidates = rawMemories.slice(0, MAX_CAPTURE_MEMORIES).flatMap((rawMemory) => {
    const candidate = normalizeCandidate(rawMemory)[0];
    if (candidate === undefined) return [];
    const record = rawMemory as { entityIds?: unknown };
    const associated = Array.isArray(record.entityIds)
      ? [...new Set(record.entityIds.filter((id): id is string => typeof id === "string" && entityIds.has(id)))]
      : [];
    return [{ ...candidate, entityIds: associated }];
  });
  const candidates = dedupeCaptureCandidates(normalizedCandidates);
  return { candidates, entities, relations };
}

/**
 * Strict completed-turn extraction. Every item is accepted as a whole or the
 * whole attempt fails; no coercion, truncation, filtering, or partial success.
 */
export async function extractCapturePlanStrict(
  text: string,
  llm: LlmComplete,
  abortSignal?: AbortSignal,
): Promise<CapturePlan> {
  if (text.trim().length === 0) return { candidates: [], entities: [], relations: [] };
  let raw: string;
  try {
    raw = await llm.complete(prompt(text), {
      label: "capture:extract",
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
  } catch (cause) {
    throw new MemoryModelError("llm", "capture-extract", cause);
  }
  abortSignal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = parseJsonExact<unknown>(stripSingleJsonFence(raw));
  } catch {
    throw outputError("capture-extract", "completion is not exact JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["memories", "entities", "relations"])) {
    throw outputError("capture-extract", "root must contain only memories, entities, and relations");
  }
  if (!Array.isArray(parsed.memories) || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) {
    throw outputError("capture-extract", "all three root arrays are required");
  }
  if (parsed.memories.length > MAX_CAPTURE_MEMORIES
    || parsed.entities.length > MAX_CAPTURE_ENTITIES
    || parsed.relations.length > MAX_CAPTURE_RELATIONS) {
    throw outputError("capture-extract", "one or more arrays exceed their item bound");
  }

  const entities = parsed.entities.map((value, index) => strictEntity(value, index));
  const entityIds = new Set<string>();
  for (const entity of entities) {
    if (entityIds.has(entity.id)) throw outputError("capture-extract", "entity ids must be unique");
    entityIds.add(entity.id);
  }
  const relations = parsed.relations.map((value, index) => strictRelation(value, index, entityIds));
  const relationKeys = new Set<string>();
  for (const relation of relations) {
    const key = `${relation.src}\u0000${relation.dst}\u0000${relation.relation}`;
    if (relationKeys.has(key)) throw outputError("capture-extract", "relations must be unique");
    relationKeys.add(key);
  }
  const candidates = parsed.memories.map((value, index) => strictCandidate(value, index, entityIds));
  const candidateTokenSets: string[][] = [];
  for (const candidate of candidates) {
    const tokens = candidateTokens(candidate.text);
    const key = tokens.join("\u0000");
    if (candidateTokenSets.some((prior) => prior.join("\u0000") === key
      || isAmbiguousNearDuplicate(prior, tokens))) {
      throw outputError("capture-extract", "memories must be distinct and non-ambiguous");
    }
    candidateTokenSets.push(tokens);
  }
  return { candidates, entities, relations };
}

function stripSingleJsonFence(raw: string): string {
  // Keep the exact parser's limit on the complete untrusted model response;
  // stripping a small wrapper must not let an over-bound response through.
  if (raw.length > MAX_MODEL_JSON_CHARS) return raw;
  const body = SINGLE_JSON_FENCE.exec(raw)?.[1];
  return body ?? raw;
}

const STRICT_ENTITY_ID = /^[a-z][a-z0-9-]{0,31}:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STRICT_ENTITY_TYPE = /^[a-z][a-z0-9-]{0,47}$/u;
const STRICT_RELATION = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/u;

function strictCandidate(value: unknown, index: number, entityIds: ReadonlySet<string>): CandidateMemory {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "text", "salience", "isInsight", "entityIds"])) {
    throw outputError("capture-extract", `memory ${index} has missing or unknown fields`);
  }
  if (value.type !== "task" && value.type !== "event" && value.type !== "note") {
    throw outputError("capture-extract", `memory ${index} has an unknown type`);
  }
  const text = strictText(value.text, MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS, `memory ${index} text`);
  if (text.includes("<!--mem")) throw outputError("capture-extract", `memory ${index} text contains a reserved delimiter`);
  if (typeof value.salience !== "number" || !Number.isFinite(value.salience)
    || value.salience < 0 || value.salience > 1) {
    throw outputError("capture-extract", `memory ${index} salience is invalid`);
  }
  if (typeof value.isInsight !== "boolean" || !Array.isArray(value.entityIds)
    || value.entityIds.length > MAX_CAPTURE_ENTITIES) {
    throw outputError("capture-extract", `memory ${index} flags or entityIds are invalid`);
  }
  const associated = value.entityIds.map((id, entityIndex) => {
    const exact = strictText(id, 96, `memory ${index} entityIds ${entityIndex}`);
    if (!entityIds.has(exact)) throw outputError("capture-extract", `memory ${index} references an unknown entity`);
    return exact;
  });
  if (new Set(associated).size !== associated.length) {
    throw outputError("capture-extract", `memory ${index} repeats an entity id`);
  }
  return { type: value.type, text, salience: value.salience, isInsight: value.isInsight, entityIds: associated };
}

function strictEntity(value: unknown, index: number): ExtractedEntity {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "name", "type"])) {
    throw outputError("capture-extract", `entity ${index} has missing or unknown fields`);
  }
  const id = strictText(value.id, 96, `entity ${index} id`);
  const name = strictText(value.name, 160, `entity ${index} name`);
  const type = strictText(value.type, 48, `entity ${index} type`);
  if (!STRICT_ENTITY_ID.test(id) || !STRICT_ENTITY_TYPE.test(type) || id.slice(0, id.indexOf(":")) !== type) {
    throw outputError("capture-extract", `entity ${index} has an invalid id or type`);
  }
  return { id, name, type };
}

function strictRelation(value: unknown, index: number, entityIds: ReadonlySet<string>): ExtractedRelation {
  if (!isRecord(value) || !hasExactKeys(value, ["src", "dst", "relation"])) {
    throw outputError("capture-extract", `relation ${index} has missing or unknown fields`);
  }
  const src = strictText(value.src, 96, `relation ${index} src`);
  const dst = strictText(value.dst, 96, `relation ${index} dst`);
  const relation = strictText(value.relation, 96, `relation ${index} relation`);
  if (!entityIds.has(src) || !entityIds.has(dst) || !STRICT_RELATION.test(relation)) {
    throw outputError("capture-extract", `relation ${index} references invalid graph data`);
  }
  return { src, dst, relation };
}

function strictText(value: unknown, maxCodePoints: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0
    || value !== value.trim() || [...value].length > maxCodePoints
    || Buffer.byteLength(value, "utf8") > maxCodePoints * 4
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw outputError("capture-extract", `${label} is invalid or exceeds its bound`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputError(stage: string, detail: string): MemoryModelOutputError {
  return new MemoryModelOutputError(stage, detail);
}

/**
 * Freeze one deterministic fact per intra-turn ambiguity before taking the
 * pre-turn similarity snapshot. Exact normalized duplicates merge only their
 * explicitly supplied entity ids. A later near-duplicate/refinement/conflict
 * is dropped rather than producing competing durable rows without a third LLM
 * adjudication call; distinct facts remain independent.
 */
function dedupeCaptureCandidates(candidates: readonly CandidateMemory[]): CandidateMemory[] {
  const kept: CandidateMemory[] = [];
  const exactIndexes = new Map<string, number>();
  for (const candidate of candidates) {
    const tokens = candidateTokens(candidate.text);
    const key = tokens.join("\u0000");
    const exactIndex = exactIndexes.get(key);
    if (exactIndex !== undefined) {
      const current = kept[exactIndex];
      if (current !== undefined) {
        kept[exactIndex] = {
          ...current,
          entityIds: [...new Set([...(current.entityIds ?? []), ...(candidate.entityIds ?? [])])].sort(),
        };
      }
      continue;
    }
    if (kept.some((current) => isAmbiguousNearDuplicate(candidateTokens(current.text), tokens))) continue;
    exactIndexes.set(key, kept.length);
    kept.push(candidate);
  }
  return kept;
}

function candidateTokens(text: string): string[] {
  return text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isAmbiguousNearDuplicate(left: readonly string[], right: readonly string[]): boolean {
  if (left.length < 3 || right.length < 3) return false;
  const smaller = Math.min(left.length, right.length);
  const rightSet = new Set(right);
  const overlap = new Set(left.filter((token) => rightSet.has(token))).size / smaller;
  let prefix = 0;
  while (prefix < smaller && left[prefix] === right[prefix]) prefix += 1;
  return prefix >= 2 && prefix / smaller >= 0.5 && overlap >= 0.6;
}

import type { EntityRecord, MemoryDb } from "../store/index.js";
import { writeCanonicalFileAtomic } from "./path-safety.js";

const INDEX_ENTITY_LIMIT = 50;
const INDEX_ENTITY_PAGE_SIZE = 250;
const INDEX_ENTITY_MAX_SCAN = 10_000;
const LOW_VALUE_INDEX_ENTITY_TYPES = new Set([
  "date",
  "datetime",
  "day",
  "duration",
  "month",
  "quarter",
  "temporal",
  "time",
  "timestamp",
  "week",
  "weekday",
  "year",
]);

interface IndexEntityPreview {
  readonly name: string;
  /** Omitted when the canonical graph assigns more than one type to this lexical group. */
  readonly type?: string;
}

interface IndexEntityGroup {
  representative: EntityRecord;
  /** The first non-empty normalized type; later disagreement flips the conflict bit. */
  type?: string;
  typeConflict: boolean;
}

/** Write <root>/future-log.md: the due/scheduled intentions queue, soonest first. Returns count. */
export function writeFutureLog(root: string, db: MemoryDb, now: Date, horizonDays = 365): number {
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000);
  const items = db.dueItems(horizon, 200);
  const lines = items.map((m) => `- [<] ${m.text}  (due ${m.dueAt ?? "?"})  ^${m.id}`);
  const body = ["# Future Log", "", ...lines, ""].join("\n");
  writeCanonicalFileAtomic(root, "future-log.md", body);
  return items.length;
}

/** Write the deterministic consolidation future log. No synthesis or due-item expansion. */
export function writeEmptyFutureLog(root: string): void {
  writeCanonicalFileAtomic(root, "future-log.md", "# Future Log\n");
}

/** Write <root>/index.md: a living table of contents — counts + top entities + top-salient memories. */
export function writeIndex(root: string, db: MemoryDb, _now: Date): void {
  const memoryCount = db.count();
  const entityCount = db.countEntities();
  const topMemories = db.topSalient(15);
  const entities = collectEntityPreview(db);

  const overviewLines = [
    "## Overview",
    "",
    `- Memories: ${memoryCount}`,
    `- Entities: ${entityCount}`,
  ];

  const topMemoryLines = [
    "## Top memories",
    "",
    ...topMemories.map((m) => `- ${m.text}  ^${m.id}`),
  ];

  const entityLines = [
    "## Entities",
    "",
    ...entities.map((entity) => entity.type === undefined
      ? `- ${entity.name}`
      : `- ${entity.name} (${entity.type})`),
  ];

  const body = [
    "# Index",
    "",
    ...overviewLines,
    "",
    ...topMemoryLines,
    "",
    ...entityLines,
    "",
  ].join("\n");

  writeCanonicalFileAtomic(root, "index.md", body);
}

/**
 * Reconcile deterministic source pages through inventory exhaustion or the
 * scheduled projection's explicit raw-scan ceiling. Filling the 50-row output
 * is not a safe stopping condition: a later lexical duplicate can change the
 * chosen representative or prove that its displayed type is ambiguous.
 */
function collectEntityPreview(db: MemoryDb): IndexEntityPreview[] {
  const groups = new Map<string, IndexEntityGroup>();
  for (let offset = 0; offset < INDEX_ENTITY_MAX_SCAN; offset += INDEX_ENTITY_PAGE_SIZE) {
    const limit = Math.min(INDEX_ENTITY_PAGE_SIZE, INDEX_ENTITY_MAX_SCAN - offset);
    const page = db.listEntities(limit, offset);
    if (page.length === 0) break;
    mergeEntityPreviewGroups(groups, page);
    if (page.length < limit) break;
  }
  return buildEntityPreview(groups.values());
}

/**
 * Keep the living index useful without rewriting the canonical entity graph.
 *
 * Capture models can assign different types to the same displayed entity across
 * turns. The preview collapses those rows by a conservative lexical name key,
 * omits a misleading type label when the source rows disagree, and leaves every
 * canonical id/relation/association intact. Ephemeral calendar/time nodes stay
 * available to graph recall but do not consume the bounded human-facing list.
 */
function mergeEntityPreviewGroups(
  groups: Map<string, IndexEntityGroup>,
  entities: readonly EntityRecord[],
): void {
  for (const entity of entities) {
    const type = normalizedEntityType(entity);
    if (type !== undefined && LOW_VALUE_INDEX_ENTITY_TYPES.has(type)) continue;
    const key = normalizedReferent(entity.name);
    if (key.length === 0) continue;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        representative: entity,
        ...(type === undefined ? {} : { type }),
        typeConflict: false,
      });
      continue;
    }
    if (compareRepresentatives(entity, group.representative) < 0) {
      group.representative = entity;
    }
    if (type !== undefined) {
      if (group.type === undefined) {
        group.type = type;
      } else if (group.type !== type) {
        group.typeConflict = true;
      }
    }
  }
}

function buildEntityPreview(groups: Iterable<IndexEntityGroup>): IndexEntityPreview[] {
  return [...groups]
    .map((group): IndexEntityPreview => {
      return {
        name: group.representative.name,
        ...(group.typeConflict ? {} : { type: group.type ?? "unknown" }),
      };
    })
    .sort((left, right) => compareStrings(left.name, right.name))
    .slice(0, INDEX_ENTITY_LIMIT);
}

function normalizedReferent(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{Z}\p{Dash_Punctuation}_]+/gu, " ")
    .trim();
  return normalized.length > 0
    ? normalized
    : name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizedEntityType(entity: EntityRecord): string | undefined {
  const separator = entity.id.indexOf(":");
  const idType = separator > 0 ? entity.id.slice(0, separator) : undefined;
  const normalized = (entity.type ?? idType)?.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function compareRepresentatives(left: EntityRecord, right: EntityRecord): number {
  const byLength = [...left.name].length - [...right.name].length;
  return byLength || compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

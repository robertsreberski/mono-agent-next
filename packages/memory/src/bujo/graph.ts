import { createHash } from "node:crypto";

import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../store/index.js";
import { withManagedRollbackRetirement } from "./generations.js";
import {
  appendCanonicalFile,
  readCanonicalFileSnapshot,
  type CanonicalFileIdentity,
} from "./path-safety.js";

const GRAPH_FILE = "graph.jsonl";
const INVALID_GRAPH_STRING = /[\p{Cc}\p{Cf}\p{Cs}]/u;

type GraphLine =
  | ({ readonly kind: "entity" } & EntityRecord)
  | ({ readonly kind: "relation" } & EntityRelationRecord)
  | ({ readonly kind: "association" } & MemoryEntityAssociation);

export interface GraphBatchInput {
  readonly entities?: readonly EntityRecord[];
  readonly relations?: readonly EntityRelationRecord[];
  readonly associations?: readonly MemoryEntityAssociation[];
}

export interface GraphBatchResult {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
}

export type GraphProjectionMemory = Pick<MemoryRecord, "id" | "status" | "text" | "createdAt">;

export interface CanonicalGraphRecords {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
}

export interface CanonicalGraphProjection extends CanonicalGraphRecords {
  readonly collectionSupports: readonly {
    readonly memoryId: string;
    readonly entityId: string;
    readonly collection: string;
  }[];
  readonly derivedLegacyAssociations: number;
}

/**
 * Synchronous, read-only proof that SQLite memory/replay state is safe input
 * for a total canonical graph repair. Graph inventory is intentionally outside
 * this proof because it is the state being repaired. The guard must throw
 * unless canonical memory and replay parity are exact; returning a value
 * (including a Promise) is rejected fail-closed.
 */
export type CanonicalGraphRepairGuard = (root: string, db: MemoryDb) => void;

export type CanonicalGraphIssueCode =
  | "malformed-json"
  | "unknown-kind"
  | "invalid-record"
  | "orphan-endpoint"
  | "invalid-projection";

/** Content-free strict canonical graph failure suitable for health reporting. */
export class CanonicalGraphValidationError extends Error {
  constructor(
    readonly code: CanonicalGraphIssueCode,
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "CanonicalGraphValidationError";
  }
}

export interface StrictCanonicalGraphSnapshot {
  readonly fingerprint: string;
  /** Exact physical identity paired with the fingerprint; absent when graph.jsonl is absent. */
  readonly identity?: CanonicalFileIdentity;
  readonly records: CanonicalGraphRecords;
}

/** Read and strictly validate one identity-stable canonical graph snapshot. */
export function readCanonicalGraphStrictSnapshot(root: string): StrictCanonicalGraphSnapshot {
  const snapshot = readCanonicalFileSnapshot(root, GRAPH_FILE, { allowMissing: true });
  const hash = createHash("sha256");
  if (snapshot === undefined) {
    hash.update("missing\0");
  } else {
    hash.update("present\0");
    hash.update(snapshot.content);
  }
  return {
    fingerprint: hash.digest("hex"),
    ...(snapshot === undefined ? {} : { identity: snapshot.identity }),
    records: parseCanonicalGraphStrict(snapshot?.content),
  };
}

/** Strict parser shared by safe rebuild and provider-free parity. */
export function parseCanonicalGraphStrict(content: string | undefined): CanonicalGraphRecords {
  if (content === undefined) return emptyCanonicalGraphRecords();
  const entities = new Map<string, EntityRecord>();
  const relations = new Map<string, EntityRelationRecord>();
  const associations = new Map<string, MemoryEntityAssociation>();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index]?.trim() ?? "";
    if (raw.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw graphValidationError("malformed-json", `memory-rebuild: malformed graph JSON at graph.jsonl:${line}.`, line);
    }
    if (!isRecord(value)) {
      throw graphValidationError("invalid-record", `memory-rebuild: graph record at line ${line} is not an object.`, line);
    }
    if (value.kind === "entity") {
      const entity = strictEntity(value, line);
      // graph.jsonl is an append log: validated later records update earlier
      // names/types/summaries for the same stable entity id.
      entities.set(entity.id, entity);
    } else if (value.kind === "relation") {
      const relation = strictRelation(value, line);
      relations.set(strictRelationKey(relation), relation);
    } else if (value.kind === "association") {
      const association = strictAssociation(value, line);
      associations.set(strictAssociationKey(association), association);
    } else {
      throw graphValidationError("unknown-kind", `memory-rebuild: unknown graph kind at graph.jsonl:${line}.`, line);
    }
  }
  for (const relation of relations.values()) {
    if (!entities.has(relation.src) || !entities.has(relation.dst)) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-rebuild: graph relation has an orphan endpoint (${relation.src} -> ${relation.dst}).`,
      );
    }
  }
  for (const association of associations.values()) {
    if (!entities.has(association.entityId)) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-rebuild: graph association has an orphan entity endpoint (${association.memoryId} -> ${association.entityId}).`,
      );
    }
  }
  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
    associations: [...associations.values()],
  };
}

/** Apply the exact deterministic graph projection used by safe BuJo rebuild. */
export function projectCanonicalGraph(
  canonical: CanonicalGraphRecords,
  memoriesInput: readonly GraphProjectionMemory[],
): CanonicalGraphProjection {
  const entities = new Map(canonical.entities.map((entity) => [entity.id, entity]));
  const associations = new Map(
    canonical.associations.map((association) => [strictAssociationKey(association), association]),
  );
  const memories = new Map(
    memoriesInput
      .filter((memory) => !isLegacyHostObservation(memory.text))
      .map((memory) => [memory.id, memory]),
  );
  for (const association of associations.values()) {
    if (!memories.has(association.memoryId) || !entities.has(association.entityId)) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-rebuild: graph association has an orphan endpoint (${association.memoryId} -> ${association.entityId}).`,
      );
    }
  }

  const collectionSupports: Array<{ memoryId: string; entityId: string; collection: string }> = [];
  for (const memory of memories.values()) {
    if (memory.status !== "migrated") continue;
    const collectionAssociations = [...associations.values()].filter((association) => {
      if (association.memoryId !== memory.id) return false;
      return entities.get(association.entityId)?.type === "collection";
    });
    if (collectionAssociations.length > 1) {
      throw graphValidationError(
        "invalid-projection",
        `memory-rebuild: migrated memory ${memory.id} has ambiguous collection associations.`,
      );
    }
    if (collectionAssociations.length === 0) continue;
    const entityId = collectionAssociations[0]!.entityId;
    const collection = entityId.startsWith("collection:") ? entityId.slice("collection:".length) : "";
    if (collection.length === 0) {
      throw graphValidationError(
        "invalid-projection",
        `memory-rebuild: migrated memory ${memory.id} has an invalid collection entity.`,
      );
    }
    collectionSupports.push({ memoryId: memory.id, entityId, collection });
  }

  let derivedLegacyAssociations = 0;
  const uniqueNames = new Map<string, EntityRecord | undefined>();
  for (const entity of entities.values()) {
    const key = normalizedNameWords(entity.name).join("\0");
    if (key.length === 0) continue;
    uniqueNames.set(key, uniqueNames.has(key) ? undefined : entity);
  }
  const memoriesWithCanonicalAssociations = new Set(
    canonical.associations.map((association) => association.memoryId),
  );
  for (const memory of memories.values()) {
    if (memoriesWithCanonicalAssociations.has(memory.id)) continue;
    const memoryWords = normalizedNameWords(memory.text);
    for (const [key, entity] of uniqueNames) {
      if (entity === undefined) continue;
      const words = key.split("\0");
      if (!containsPhrase(memoryWords, words)) continue;
      const keyForAssociation = strictAssociationKey({ memoryId: memory.id, entityId: entity.id });
      if (associations.has(keyForAssociation)) continue;
      associations.set(keyForAssociation, {
        memoryId: memory.id,
        entityId: entity.id,
        provenance: "legacy-name-match",
        createdAt: memory.createdAt,
      });
      derivedLegacyAssociations += 1;
    }
  }
  return {
    entities: [...canonical.entities],
    relations: [...canonical.relations],
    associations: [...associations.values()],
    collectionSupports,
    derivedLegacyAssociations,
  };
}

/**
 * Replace SQLite's total canonical graph projection bracketed by an exact
 * memory/replay parity guard. Guard execution is deliberately the first
 * operation: canonical graph and SQLite memory are not read on a missing,
 * throwing, or asynchronous guard. The same guard runs again after derivation
 * immediately before the transactional DB replacement, then once more after
 * the existing graph source and DB replacement fences. The middle proof plus
 * SQLite CAS prevents a raced DB snapshot from becoming graph input; the last
 * proof keeps canonical daily/replay or SQLite memory races across the mutation
 * visible to the caller.
 *
 * The memory snapshot is both the deterministic legacy-name derivation input
 * and the compare-and-swap fence used by MemoryDb. The guard establishes that
 * the snapshot may be trusted; the existing source identity and SQLite CAS
 * fences still reject races during projection replacement.
 */
export function replaceDbCanonicalGraphProjectionWithParity(
  root: string,
  db: MemoryDb,
  guard: CanonicalGraphRepairGuard,
): CanonicalGraphProjection {
  if (typeof guard !== "function") {
    throw new Error("memory-graph: canonical graph repair requires an exact synchronous parity guard.");
  }
  assertCanonicalGraphRepairGuard(root, db, guard);
  const projection = replaceDbCanonicalGraphProjectionUnchecked(
    root,
    db,
    () => assertCanonicalGraphRepairGuard(root, db, guard),
  );
  assertCanonicalGraphRepairGuard(root, db, guard);
  return projection;
}

function assertCanonicalGraphRepairGuard(
  root: string,
  db: MemoryDb,
  guard: CanonicalGraphRepairGuard,
): void {
  const result: unknown = guard(root, db);
  if (result !== undefined) {
    throw new Error("memory-graph: canonical graph repair parity guard must complete synchronously.");
  }
}

/** Internal projection engine; only the guarded public boundary can invoke it. */
function replaceDbCanonicalGraphProjectionUnchecked(
  root: string,
  db: MemoryDb,
  assertSafeBeforeReplace: () => void,
): CanonicalGraphProjection {
  const source = readCanonicalGraphStrictSnapshot(root);
  const memorySnapshot = db.canonicalGraphSnapshot().memories;
  const projection = projectCanonicalGraph(source.records, memorySnapshot);
  const memoryById = new Map(memorySnapshot.map((memory) => [memory.id, memory]));
  const associationByKey = new Map(
    projection.associations.map((association) => [strictAssociationKey(association), association]),
  );
  const supports = projection.collectionSupports.map((support) => {
    const memory = memoryById.get(support.memoryId);
    if (memory === undefined) {
      throw graphValidationError(
        "orphan-endpoint",
        `memory-graph: collection support lost memory endpoint ${support.memoryId}.`,
      );
    }
    const association = associationByKey.get(strictAssociationKey({
      memoryId: support.memoryId,
      entityId: support.entityId,
    }));
    if (association === undefined) {
      throw graphValidationError(
        "invalid-projection",
        `memory-graph: collection support lost canonical association ${support.memoryId} -> ${support.entityId}.`,
      );
    }
    return {
      ...support,
      weight: 1,
      createdAt: association.createdAt,
    };
  });
  // Re-prove the derived memory snapshot immediately before the transaction.
  // MemoryDb's compare-and-swap then fences the remaining guard-to-write gap.
  assertSafeBeforeReplace();
  db.replaceCanonicalGraphProjection(memorySnapshot, {
    entities: projection.entities,
    relations: projection.relations,
    associations: projection.associations,
    supports,
  });
  const confirmed = readCanonicalGraphStrictSnapshot(root);
  if (!sameCanonicalGraphSourceSnapshot(source, confirmed)) {
    throw new Error("memory-graph: canonical graph source changed during DB projection replacement.");
  }
  return projection;
}

function sameCanonicalGraphSourceSnapshot(
  left: StrictCanonicalGraphSnapshot,
  right: StrictCanonicalGraphSnapshot,
): boolean {
  if (left.fingerprint !== right.fingerprint) return false;
  if (left.identity === undefined || right.identity === undefined) {
    return left.identity === undefined && right.identity === undefined;
  }
  return left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.size === right.identity.size
    && left.identity.mtimeMs === right.identity.mtimeMs
    && left.identity.ctimeMs === right.identity.ctimeMs
    && left.identity.mode === right.identity.mode
    && left.identity.nlink === right.identity.nlink
    && left.identity.uid === right.identity.uid;
}

export function emptyCanonicalGraphProjection(): CanonicalGraphProjection {
  return {
    entities: [],
    relations: [],
    associations: [],
    collectionSupports: [],
    derivedLegacyAssociations: 0,
  };
}

/** Raw host observations are audit-only and never enter the curated BuJo projection. */
export function isLegacyHostObservation(text: string): boolean {
  return text.startsWith("Host-observed completed turn.")
    || text.startsWith("Host-observed completed trigger turn.");
}

/**
 * Read the canonical graph.jsonl at `<root>/graph.jsonl`.
 * Missing file → `{entities:[], relations:[]}`.
 * Malformed lines are skipped defensively (never throws).
 * Dedupes on read: entities by `id` keeping the LAST occurrence;
 * relations by `src|dst|relation` keeping the last.
 */
export function readGraph(root: string): {
  entities: EntityRecord[];
  relations: EntityRelationRecord[];
  associations: MemoryEntityAssociation[];
} {
  const snapshot = readCanonicalFileSnapshot(root, GRAPH_FILE, { allowMissing: true });
  if (snapshot === undefined) return { entities: [], relations: [], associations: [] };
  const raw = snapshot.content;
  const entityMap = new Map<string, EntityRecord>();
  const relationMap = new Map<string, EntityRelationRecord>();
  const associationMap = new Map<string, MemoryEntityAssociation>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // skip malformed lines
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec["kind"] === "entity") {
      const { kind: _kind, ...rest } = rec;
      const entity = rest as unknown as EntityRecord;
      if (typeof entity.id === "string" && entity.id.length > 0) {
        entityMap.set(entity.id, entity);
      }
    } else if (rec["kind"] === "relation") {
      const { kind: _kind, ...rest } = rec;
      const relation = rest as unknown as EntityRelationRecord;
      if (
        typeof relation.src === "string" &&
        typeof relation.dst === "string" &&
        typeof relation.relation === "string"
      ) {
        relationMap.set(relationKey(relation), relation);
      }
    } else if (rec["kind"] === "association") {
      const { kind: _kind, ...rest } = rec;
      const association = rest as unknown as MemoryEntityAssociation;
      if (
        typeof association.memoryId === "string"
        && association.memoryId.length > 0
        && typeof association.entityId === "string"
        && association.entityId.length > 0
        && (association.provenance === "capture" || association.provenance === "legacy-name-match")
        && typeof association.createdAt === "string"
        && association.createdAt.length > 0
      ) {
        associationMap.set(associationKey(association), association);
      }
    }
  }

  return {
    entities: Array.from(entityMap.values()),
    relations: Array.from(relationMap.values()),
    associations: Array.from(associationMap.values()),
  };
}

/**
 * Validate graph records with the same strict field rules used by rebuild/audit.
 *
 * This is a write-boundary validator only; endpoint validation still happens
 * against the complete canonical projection after existing records are read.
 */
export function assertCanonicalGraphBatch(input: GraphBatchInput): void {
  if (!isRecord(input)) {
    throw graphValidationError("invalid-record", "memory-graph: graph batch must be an object.");
  }
  const entities = input.entities ?? [];
  const relations = input.relations ?? [];
  const associations = input.associations ?? [];
  if (!Array.isArray(entities) || !Array.isArray(relations) || !Array.isArray(associations)) {
    throw graphValidationError("invalid-record", "memory-graph: graph batch fields must be arrays.");
  }
  entities.forEach((record, index) => {
    if (!isRecord(record)) {
      throw graphValidationError("invalid-record", `memory-graph: invalid entity at batch index ${index}.`);
    }
    if (Object.prototype.hasOwnProperty.call(record, "kind")) {
      throw graphValidationError("invalid-record", `memory-graph: invalid entity at batch index ${index}; kind is reserved.`);
    }
    strictEntity(record, index + 1);
  });
  relations.forEach((record, index) => {
    if (!isRecord(record)) {
      throw graphValidationError("invalid-record", `memory-graph: invalid relation at batch index ${index}.`);
    }
    if (Object.prototype.hasOwnProperty.call(record, "kind")) {
      throw graphValidationError("invalid-record", `memory-graph: invalid relation at batch index ${index}; kind is reserved.`);
    }
    strictRelation(record, index + 1);
  });
  associations.forEach((record, index) => {
    if (!isRecord(record)) {
      throw graphValidationError("invalid-record", `memory-graph: invalid association at batch index ${index}.`);
    }
    if (Object.prototype.hasOwnProperty.call(record, "kind")) {
      throw graphValidationError("invalid-record", `memory-graph: invalid association at batch index ${index}; kind is reserved.`);
    }
    strictAssociation(record, index + 1);
  });
}

/**
 * Merge a capture's graph evidence with one source read and one append.
 * Returned records are the exact canonical forms callers must mirror to DB.
 */
export function appendGraphBatch(root: string, input: GraphBatchInput): GraphBatchResult {
  assertCanonicalGraphBatch(input);
  const current = readGraph(root);
  const originalEntities = new Map(current.entities.map((record) => [record.id, record]));
  const originalRelations = new Map(current.relations.map((record) => [relationKey(record), record]));
  const originalAssociations = new Map(current.associations.map((record) => [associationKey(record), record]));
  const entities = new Map(originalEntities);
  const relations = new Map(originalRelations);
  const associations = new Map(originalAssociations);
  const touchedEntities = new Set<string>();
  const touchedRelations = new Set<string>();
  const touchedAssociations = new Set<string>();

  for (const record of input.entities ?? []) {
    const prior = entities.get(record.id);
    entities.set(record.id, prior === undefined ? record : mergeEntityRecord(prior, record));
    touchedEntities.add(record.id);
  }
  for (const record of input.relations ?? []) {
    const key = relationKey(record);
    if (!relations.has(key)) relations.set(key, record);
    touchedRelations.add(key);
  }
  for (const record of input.associations ?? []) {
    const key = associationKey(record);
    const prior = associations.get(key);
    if (prior === undefined) {
      associations.set(key, record);
    } else if (prior.provenance !== "capture" && record.provenance === "capture") {
      associations.set(key, { ...record, createdAt: prior.createdAt });
    }
    touchedAssociations.add(key);
  }

  const result: GraphBatchResult = {
    entities: [...touchedEntities].map((key) => entities.get(key)!),
    relations: [...touchedRelations].map((key) => relations.get(key)!),
    associations: [...touchedAssociations].map((key) => associations.get(key)!),
  };
  // A permissively-read legacy record may participate in a merge. Validate the
  // exact merged records too, so a new append never republishes strict-invalid
  // state merely because the caller's delta was valid.
  assertCanonicalGraphBatch(result);

  const lines: GraphLine[] = [];
  for (const key of touchedEntities) {
    const record = entities.get(key)!;
    const prior = originalEntities.get(key);
    if (prior === undefined || !entityRecordsEqual(prior, record)) lines.push({ ...record, kind: "entity" });
  }
  for (const key of touchedRelations) {
    const record = relations.get(key)!;
    if (!originalRelations.has(key)) lines.push({ ...record, kind: "relation" });
  }
  for (const key of touchedAssociations) {
    const record = associations.get(key)!;
    const prior = originalAssociations.get(key);
    if (prior === undefined || prior.provenance !== record.provenance || prior.createdAt !== record.createdAt) {
      lines.push({ ...record, kind: "association" });
    }
  }
  if (lines.length > 0) {
    const serialized = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    withManagedRollbackRetirement(root, "graph", () => {
      appendCanonicalFile(root, GRAPH_FILE, serialized);
    });
  }

  return result;
}

/** Append one precise memory/entity association and return its canonical merged record. */
export function appendAssociation(root: string, record: MemoryEntityAssociation): MemoryEntityAssociation {
  return appendGraphBatch(root, { associations: [record] }).associations[0]!;
}

/** Append an entity and return the exact canonical merged record. */
export function appendEntity(root: string, record: EntityRecord): EntityRecord {
  return appendGraphBatch(root, { entities: [record] }).entities[0]!;
}

/** Append a single relation record to `<root>/graph.jsonl` (mkdir root if needed). */
export function appendRelation(root: string, record: EntityRelationRecord): void {
  appendGraphBatch(root, { relations: [record] });
}

function relationKey(record: Pick<EntityRelationRecord, "src" | "dst" | "relation">): string {
  return JSON.stringify([record.src, record.dst, record.relation]);
}

function associationKey(record: Pick<MemoryEntityAssociation, "memoryId" | "entityId">): string {
  return JSON.stringify([record.memoryId, record.entityId]);
}

function entityRecordsEqual(a: EntityRecord, b: EntityRecord): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    a.summary === b.summary &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

function mergeEntityRecord(current: EntityRecord, next: EntityRecord): EntityRecord {
  const type = next.type ?? current.type;
  const summary = next.summary ?? current.summary;
  const merged: EntityRecord = {
    id: next.id,
    name: next.name,
    createdAt: current.createdAt,
    ...(type === undefined ? {} : { type }),
    ...(summary === undefined ? {} : { summary }),
  };
  const changed = current.name !== merged.name
    || current.type !== merged.type
    || current.summary !== merged.summary;
  return {
    ...merged,
    ...(changed
      ? { updatedAt: next.updatedAt ?? next.createdAt }
      : current.updatedAt === undefined ? {} : { updatedAt: current.updatedAt }),
  };
}

function emptyCanonicalGraphRecords(): CanonicalGraphRecords {
  return { entities: [], relations: [], associations: [] };
}

function strictEntity(value: Record<string, unknown>, line: number): EntityRecord {
  const id = requiredString(value.id, "entity id", line);
  const name = requiredString(value.name, "entity name", line);
  const createdAt = requiredTimestamp(value.createdAt, "entity createdAt", line);
  const type = optionalString(value.type, "entity type", line);
  const summary = optionalString(value.summary, "entity summary", line);
  return {
    id,
    name,
    createdAt,
    ...(type === undefined ? {} : { type }),
    ...(summary === undefined ? {} : { summary }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: requiredTimestamp(value.updatedAt, "entity updatedAt", line) }),
  };
}

function strictRelation(value: Record<string, unknown>, line: number): EntityRelationRecord {
  return {
    src: requiredString(value.src, "relation src", line),
    dst: requiredString(value.dst, "relation dst", line),
    relation: requiredString(value.relation, "relation label", line),
    createdAt: requiredTimestamp(value.createdAt, "relation createdAt", line),
  };
}

function strictAssociation(value: Record<string, unknown>, line: number): MemoryEntityAssociation {
  const provenance = value.provenance;
  if (provenance !== "capture" && provenance !== "legacy-name-match") {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: invalid association provenance at graph.jsonl:${line}.`,
      line,
    );
  }
  return {
    memoryId: requiredString(value.memoryId, "association memoryId", line),
    entityId: requiredString(value.entityId, "association entityId", line),
    provenance,
    createdAt: requiredTimestamp(value.createdAt, "association createdAt", line),
  };
}

function requiredString(value: unknown, label: string, line: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || INVALID_GRAPH_STRING.test(value)) {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: missing ${label} at graph.jsonl:${line}.`,
      line,
    );
  }
  return value;
}

function optionalString(value: unknown, label: string, line: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || INVALID_GRAPH_STRING.test(value)) {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: invalid ${label} at graph.jsonl:${line}.`,
      line,
    );
  }
  return value;
}

function requiredTimestamp(value: unknown, label: string, line: number): string {
  const timestamp = requiredString(value, label, line);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw graphValidationError(
      "invalid-record",
      `memory-rebuild: invalid ${label} at graph.jsonl:${line}.`,
      line,
    );
  }
  return timestamp;
}

function graphValidationError(
  code: CanonicalGraphIssueCode,
  message: string,
  line?: number,
): CanonicalGraphValidationError {
  return new CanonicalGraphValidationError(code, message, line);
}

function strictRelationKey(record: Pick<EntityRelationRecord, "src" | "dst" | "relation">): string {
  return JSON.stringify([record.src, record.dst, record.relation]);
}

function strictAssociationKey(record: Pick<MemoryEntityAssociation, "memoryId" | "entityId">): string {
  return JSON.stringify([record.memoryId, record.entityId]);
}

function normalizedNameWords(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((word, index) => haystack[offset + index] === word)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

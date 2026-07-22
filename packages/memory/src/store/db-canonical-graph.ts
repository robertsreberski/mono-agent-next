import type {
  CanonicalGraphMemoryRecord,
  CanonicalGraphSnapshot,
  EntityRecord,
  EntityRelationRecord,
  MemoryEntityAssociation,
} from "./types.js";
import { MEMORY_STATUSES } from "./types.js";
import type {
  CanonicalGraphReplacement,
  CanonicalGraphReplacementSupport,
} from "./db-projection-types.js";

export interface NormalizedCanonicalGraphReplacement extends CanonicalGraphReplacement {
  readonly memories: readonly CanonicalGraphMemoryRecord[];
}

export interface CanonicalGraphOwnedEdge {
  readonly src: string;
  readonly dst: string;
  readonly kind: "supports" | "about";
  readonly weight: number;
  readonly createdAt: string;
}

const INVALID_CANONICAL_GRAPH_VALUE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function validateCanonicalGraphReplacement(
  expectedMemories: readonly CanonicalGraphMemoryRecord[],
  projection: CanonicalGraphReplacement,
): NormalizedCanonicalGraphReplacement {
  if (!Array.isArray(expectedMemories) || projection === null || typeof projection !== "object"
    || !Array.isArray(projection.entities) || !Array.isArray(projection.relations)
    || !Array.isArray(projection.associations) || !Array.isArray(projection.supports)) {
    throw new Error("memory-store: invalid canonical graph replacement.");
  }
  const memories = [...expectedMemories].sort((left, right) => left.id.localeCompare(right.id));
  const entities = [...projection.entities].sort((left, right) => left.id.localeCompare(right.id));
  const relations = [...projection.relations].sort((left, right) => (
    canonicalRelationKey(left).localeCompare(canonicalRelationKey(right))
  ));
  const associations = [...projection.associations].sort((left, right) => (
    canonicalAssociationKey(left).localeCompare(canonicalAssociationKey(right))
  ));
  const supports = [...projection.supports].sort((left, right) => (
    canonicalSupportKey(left).localeCompare(canonicalSupportKey(right))
  ));

  assertUniqueCanonicalKeys(memories, (memory) => memory.id, "memory");
  assertUniqueCanonicalKeys(entities, (entity) => entity.id, "entity");
  assertUniqueCanonicalKeys(relations, canonicalRelationKey, "relation");
  assertUniqueCanonicalKeys(associations, canonicalAssociationKey, "association");
  assertUniqueCanonicalKeys(supports, canonicalSupportKey, "support");
  assertUniqueCanonicalKeys(supports, (support) => support.memoryId, "support memory endpoint");

  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const associationByKey = new Map(
    associations.map((association) => [canonicalAssociationKey(association), association]),
  );
  for (const memory of memories) {
    assertCanonicalGraphValue(memory.id, "memory id");
    if (typeof memory.text !== "string" || !MEMORY_STATUSES.includes(memory.status)) {
      throw new Error("memory-store: canonical graph memory projection is invalid.");
    }
    assertCanonicalGraphTimestamp(memory.createdAt, "memory createdAt");
    if (memory.collection !== undefined) assertCanonicalGraphValue(memory.collection, "memory collection");
  }
  for (const entity of entities) {
    assertCanonicalGraphValue(entity.id, "entity id");
    assertCanonicalGraphValue(entity.name, "entity name");
    if (entity.type !== undefined) assertCanonicalGraphValue(entity.type, "entity type");
    if (entity.summary !== undefined) assertCanonicalGraphValue(entity.summary, "entity summary");
    assertCanonicalGraphTimestamp(entity.createdAt, "entity createdAt");
    if (entity.updatedAt !== undefined) assertCanonicalGraphTimestamp(entity.updatedAt, "entity updatedAt");
  }
  for (const relation of relations) {
    if (!entityById.has(relation.src) || !entityById.has(relation.dst)) {
      throw new Error(`memory-store: canonical graph relation has an orphan endpoint (${relation.src} -> ${relation.dst}).`);
    }
    assertCanonicalGraphValue(relation.relation, "relation label");
    assertCanonicalGraphTimestamp(relation.createdAt, "relation createdAt");
  }
  for (const association of associations) {
    if (!memoryById.has(association.memoryId) || !entityById.has(association.entityId)) {
      throw new Error(
        `memory-store: canonical graph association has an orphan endpoint (${association.memoryId} -> ${association.entityId}).`,
      );
    }
    if (association.provenance !== "capture" && association.provenance !== "legacy-name-match") {
      throw new Error("memory-store: canonical graph association has invalid provenance.");
    }
    assertCanonicalGraphTimestamp(association.createdAt, "association createdAt");
  }
  for (const support of supports) {
    const memory = memoryById.get(support.memoryId);
    const entity = entityById.get(support.entityId);
    if (memory === undefined || entity === undefined) {
      throw new Error(
        `memory-store: canonical graph support has an orphan endpoint (${support.memoryId} -> ${support.entityId}).`,
      );
    }
    if (memory.status !== "migrated" || entity.type !== "collection"
      || support.entityId !== `collection:${support.collection}`) {
      throw new Error("memory-store: canonical graph support is not an exact migrated collection projection.");
    }
    if (support.weight !== 1) {
      throw new Error("memory-store: canonical graph support weight must be exactly 1.");
    }
    assertCanonicalGraphValue(support.collection, "support collection");
    assertCanonicalGraphTimestamp(support.createdAt, "support createdAt");
    const association = associationByKey.get(canonicalAssociationKey({
      memoryId: support.memoryId,
      entityId: support.entityId,
    }));
    if (association === undefined) {
      throw new Error("memory-store: canonical graph support has no exact association.");
    }
    if (support.createdAt !== association.createdAt) {
      throw new Error("memory-store: canonical graph support timestamp is not deterministic.");
    }
  }
  return { memories, entities, relations, associations, supports };
}

export function sameCanonicalGraphReplacement(
  current: CanonicalGraphSnapshot,
  ownedEdges: readonly CanonicalGraphOwnedEdge[],
  expected: NormalizedCanonicalGraphReplacement,
): boolean {
  const desiredCollections = new Map(expected.supports.map((support) => [support.memoryId, support.collection]));
  if (current.memories.some((memory) => memory.collection !== desiredCollections.get(memory.id))) return false;
  const expectedEdges: CanonicalGraphOwnedEdge[] = expected.supports.map((support) => ({
    src: support.memoryId,
    dst: support.entityId,
    kind: "supports",
    weight: support.weight,
    createdAt: support.createdAt,
  }));
  return sameEntities(current.entities, expected.entities)
    && sameRelations(current.relations, expected.relations)
    && sameAssociations(current.associations, expected.associations)
    && sameOwnedEdges(ownedEdges, expectedEdges);
}

export function sameCanonicalGraphMemories(
  current: readonly CanonicalGraphMemoryRecord[],
  expected: readonly CanonicalGraphMemoryRecord[],
): boolean {
  const left = [...current].sort((a, b) => a.id.localeCompare(b.id));
  const right = [...expected].sort((a, b) => a.id.localeCompare(b.id));
  return left.length === right.length && left.every((memory, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && memory.id === candidate.id
      && memory.status === candidate.status
      && memory.text === candidate.text
      && memory.createdAt === candidate.createdAt
      && memory.collection === candidate.collection;
  });
}

function sameEntities(left: readonly EntityRecord[], right: readonly EntityRecord[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a.id.localeCompare(b.id));
  const sortedRight = [...right].sort((a, b) => a.id.localeCompare(b.id));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((entity, index) => {
    const candidate = sortedRight[index];
    return candidate !== undefined
      && entity.id === candidate.id
      && entity.name === candidate.name
      && entity.type === candidate.type
      && entity.summary === candidate.summary
      && entity.createdAt === candidate.createdAt
      && entity.updatedAt === candidate.updatedAt;
  });
}

function sameRelations(left: readonly EntityRelationRecord[], right: readonly EntityRelationRecord[]): boolean {
  const sortedLeft = [...left].sort((a, b) => canonicalRelationKey(a).localeCompare(canonicalRelationKey(b)));
  const sortedRight = [...right].sort((a, b) => canonicalRelationKey(a).localeCompare(canonicalRelationKey(b)));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((relation, index) => {
    const candidate = sortedRight[index];
    return candidate !== undefined
      && canonicalRelationKey(relation) === canonicalRelationKey(candidate)
      && relation.createdAt === candidate.createdAt;
  });
}

function sameAssociations(
  left: readonly MemoryEntityAssociation[],
  right: readonly MemoryEntityAssociation[],
): boolean {
  const sortedLeft = [...left].sort((a, b) => canonicalAssociationKey(a).localeCompare(canonicalAssociationKey(b)));
  const sortedRight = [...right].sort((a, b) => canonicalAssociationKey(a).localeCompare(canonicalAssociationKey(b)));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((association, index) => {
    const candidate = sortedRight[index];
    return candidate !== undefined
      && canonicalAssociationKey(association) === canonicalAssociationKey(candidate)
      && association.provenance === candidate.provenance
      && association.createdAt === candidate.createdAt;
  });
}

function sameOwnedEdges(left: readonly CanonicalGraphOwnedEdge[], right: readonly CanonicalGraphOwnedEdge[]): boolean {
  const key = (edge: CanonicalGraphOwnedEdge): string => JSON.stringify([edge.kind, edge.src, edge.dst]);
  const sortedLeft = [...left].sort((a, b) => key(a).localeCompare(key(b)));
  const sortedRight = [...right].sort((a, b) => key(a).localeCompare(key(b)));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((edge, index) => {
    const candidate = sortedRight[index];
    return candidate !== undefined
      && edge.src === candidate.src
      && edge.dst === candidate.dst
      && edge.kind === candidate.kind
      && edge.weight === candidate.weight
      && edge.createdAt === candidate.createdAt;
  });
}

function assertUniqueCanonicalKeys<T>(
  records: readonly T[],
  keyFor: (record: T) => string,
  label: string,
): void {
  const keys = new Set<string>();
  for (const record of records) {
    const key = keyFor(record);
    if (keys.has(key)) throw new Error(`memory-store: duplicate canonical graph ${label} key.`);
    keys.add(key);
  }
}

function canonicalRelationKey(record: Pick<EntityRelationRecord, "src" | "dst" | "relation">): string {
  return JSON.stringify([record.src, record.dst, record.relation]);
}

function canonicalAssociationKey(record: Pick<MemoryEntityAssociation, "memoryId" | "entityId">): string {
  return JSON.stringify([record.memoryId, record.entityId]);
}

function canonicalSupportKey(record: Pick<CanonicalGraphReplacementSupport, "memoryId" | "entityId">): string {
  return JSON.stringify([record.memoryId, record.entityId]);
}

function assertCanonicalGraphValue(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || INVALID_CANONICAL_GRAPH_VALUE.test(value)) {
    throw new Error(`memory-store: canonical graph ${label} is invalid.`);
  }
}

function assertCanonicalGraphTimestamp(value: string, label: string): void {
  assertCanonicalGraphValue(value, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`memory-store: canonical graph ${label} is invalid.`);
  }
}

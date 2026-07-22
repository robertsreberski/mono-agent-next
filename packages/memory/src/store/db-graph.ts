import { MemoryDbMaintenance } from "./db-maintenance.js";
import {
  canonicalWords,
  entityNameVariants,
  GENERIC_ENTITY_PREFIXES,
  lexicalEvidence,
  normalizedRelationPhrases,
  QUERY_NAME_PREFIXES,
  relationDirectionMatches,
  relevanceTokens,
  startsUppercase,
  tokenOverlap,
} from "./db-relation-evidence.js";
import {
  replayProjectionDbStateMatches,
  validateReplayProjectionReplacement,
} from "./db-replay-projection.js";
import {
  sameCanonicalGraphMemories,
  sameCanonicalGraphReplacement,
  validateCanonicalGraphReplacement,
} from "./db-canonical-graph.js";
import {
  REPLAY_EDGE_STATE_INDEX,
  REPLAY_LIFECYCLE_STATE_INDEX,
} from "./schema.js";
import type {
  CanonicalGraphReplacement,
  ReplayProjectionDbReplacement,
  ReplayProjectionDbSnapshot,
} from "./db-projection-types.js";
import type {
  CanonicalGraphMemoryRecord,
  CanonicalGraphSnapshot,
  EntityRecord,
  EntityRelationRecord,
  MemoryEntityAssociation,
  MemoryRecord,
} from "./types.js";

export const REPLAY_PROJECTION_STATE_PROBE_SQL = `SELECT
  EXISTS (
    SELECT 1 FROM memories INDEXED BY ${REPLAY_LIFECYCLE_STATE_INDEX}
    WHERE valid_to IS NOT NULL OR superseded_by IS NOT NULL OR superseded_at IS NOT NULL
    LIMIT 1
  ) AS lifecycle_present,
  EXISTS (
    SELECT 1 FROM edges INDEXED BY ${REPLAY_EDGE_STATE_INDEX}
    WHERE kind IN ('thread','supersedes')
    LIMIT 1
  ) AS edge_present`;

export class MemoryDbGraph extends MemoryDbMaintenance {
  async supersede(oldId: string, replacement: MemoryRecord): Promise<void> {
    if (oldId === replacement.id) {
      throw new Error("memory-store: supersede requires a replacement with a distinct id.");
    }
    if (this.get(oldId) === undefined) {
      throw new Error(`memory-store: cannot supersede unknown memory "${oldId}".`);
    }
    const now = this.clock().toISOString();
    await this.upsert(replacement);
    this.markSuperseded(oldId, replacement.id, now);
  }

  markSuperseded(oldId: string, replacementId: string, at = this.clock().toISOString()): void {
    if (oldId === replacementId) {
      throw new Error("memory-store: supersede requires a replacement with a distinct id.");
    }
    if (this.get(oldId) === undefined) {
      throw new Error(`memory-store: cannot supersede unknown memory "${oldId}".`);
    }
    if (this.get(replacementId) === undefined) {
      throw new Error(`memory-store: cannot supersede with unknown replacement "${replacementId}".`);
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE memories SET status = 'invalidated', superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?`,
      ).run(replacementId, at, at, oldId);
      this.db.prepare(
        `INSERT OR IGNORE INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supersedes', 1.0, ?)`,
      ).run(oldId, replacementId, at);
    });
    tx();
  }

  edges(src: string): { src: string; dst: string; kind: string; weight: number }[] {
    return this.db.prepare(`SELECT src, dst, kind, weight FROM edges WHERE src = ?`).all(src) as {
      src: string; dst: string; kind: string; weight: number;
    }[];
  }

  /** Complete edge inventory for closed-candidate and rollback parity checks. */
  allEdges(): { src: string; dst: string; kind: string; weight: number; createdAt: string }[] {
    const rows = this.db.prepare(
      `SELECT src, dst, kind, weight, created_at FROM edges ORDER BY src, dst, kind`,
    ).all() as Array<{ src: string; dst: string; kind: string; weight: number; created_at: string }>;
    return rows.map((row) => ({
      src: row.src,
      dst: row.dst,
      kind: row.kind,
      weight: row.weight,
      createdAt: row.created_at,
    }));
  }

  /** One provider-free snapshot of every field governed or checked by replay projection. */
  replayProjectionSnapshot(): ReplayProjectionDbSnapshot {
    return this.db.transaction((): ReplayProjectionDbSnapshot => {
      const memories = (this.db.prepare(
        `SELECT id, status, created_at, valid_to, superseded_by, superseded_at
         FROM memories ORDER BY id`,
      ).all() as Array<{
        id: string;
        status: MemoryRecord["status"];
        created_at: string;
        valid_to: string | null;
        superseded_by: string | null;
        superseded_at: string | null;
      }>).map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
        ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
        ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at }),
      }));
      const edges = (this.db.prepare(
        `SELECT src, dst, kind, weight, created_at FROM edges ORDER BY kind, src, dst`,
      ).all() as Array<{
        src: string;
        dst: string;
        kind: "thread" | "about" | "supports" | "supersedes";
        weight: number;
        created_at: string;
      }>).map((row) => ({
        src: row.src,
        dst: row.dst,
        kind: row.kind,
        weight: row.weight,
        createdAt: row.created_at,
      }));
      return { memories, edges };
    })();
  }

  /** Constant-work presence guard for tiers that reject every replay-owned row. */
  hasReplayProjectionState(): boolean {
    const row = this.db.prepare(REPLAY_PROJECTION_STATE_PROBE_SQL).get() as {
      lifecycle_present: number;
      edge_present: number;
    };
    return row.lifecycle_present === 1 || row.edge_present === 1;
  }

  /**
   * Atomically replace only SQLite state that cannot be reconstructed from
   * canonical BuJo Markdown. Supports/about graph evidence and all telemetry,
   * vectors, text, provenance, and canonical status fields are left untouched.
   */
  replaceReplayProjection(projection: ReplayProjectionDbReplacement): boolean {
    const tx = this.db.transaction((): boolean => {
      const snapshot = this.replayProjectionSnapshot();
      const normalized = validateReplayProjectionReplacement(snapshot.memories, projection);
      if (replayProjectionDbStateMatches(snapshot, normalized)) return false;

      this.db.prepare(`DELETE FROM edges WHERE kind IN ('thread','supersedes')`).run();
      this.db.prepare(
        `UPDATE memories SET valid_to = NULL, superseded_by = NULL, superseded_at = NULL
         WHERE valid_to IS NOT NULL OR superseded_by IS NOT NULL OR superseded_at IS NOT NULL`,
      ).run();

      const setTerminal = this.db.prepare(`UPDATE memories SET valid_to = ? WHERE id = ?`);
      for (const terminal of normalized.terminals) {
        if (setTerminal.run(terminal.at, terminal.id).changes !== 1) {
          throw new Error(`memory-store: replay terminal endpoint "${terminal.id}" disappeared.`);
        }
      }

      const setSuperseded = this.db.prepare(
        `UPDATE memories SET valid_to = ?, superseded_by = ?, superseded_at = ? WHERE id = ?`,
      );
      const insertSupersedes = this.db.prepare(
        `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supersedes', 1, ?)`,
      );
      for (const supersede of normalized.supersedes) {
        if (setSuperseded.run(supersede.at, supersede.dst, supersede.at, supersede.src).changes !== 1) {
          throw new Error(`memory-store: replay supersede endpoint "${supersede.src}" disappeared.`);
        }
        insertSupersedes.run(supersede.src, supersede.dst, supersede.at);
      }

      const insertThread = this.db.prepare(
        `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'thread', ?, ?)`,
      );
      for (const thread of normalized.threads) {
        insertThread.run(thread.src, thread.dst, thread.weight, thread.at);
      }
      return true;
    });
    return tx();
  }

  addEdge(
    src: string,
    dst: string,
    kind: "thread" | "about" | "supports" | "supersedes",
    weight = 1.0,
    createdAt?: string,
  ): void {
    const edgeCreatedAt = createdAt ?? this.clock().toISOString();
    const millis = Date.parse(edgeCreatedAt);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== edgeCreatedAt) {
      throw new Error("memory-store: edge createdAt must be an exact ISO timestamp.");
    }
    this.db.prepare(createdAt === undefined
      ? `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight`
      : `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, kind) DO UPDATE SET
           weight = excluded.weight,
           created_at = excluded.created_at`)
      .run(src, dst, kind, weight, edgeCreatedAt);
  }

  expand(seedIds: readonly string[], hops = 1): MemoryRecord[] {
    const seeds = new Set(seedIds);
    let frontier = new Set(seedIds);
    const reached = new Set<string>();
    for (let hop = 0; hop < hops; hop += 1) {
      const next = new Set<string>();
      for (const id of frontier) {
        const rows = this.db
          .prepare(`SELECT dst FROM edges WHERE src = ? AND kind IN ('thread','about')`)
          .all(id) as { dst: string }[];
        for (const { dst } of rows) {
          if (!seeds.has(dst) && !reached.has(dst)) {
            next.add(dst);
            reached.add(dst);
          }
        }
      }
      frontier = next;
    }
    const ids = [...reached];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }
  /**
   * Compatibility entity upsert. Its established behavior is a total overwrite:
   * absent optional fields clear existing columns and createdAt is replaced.
   * Canonical graph callers use the explicitly named mirror method below so
   * relation/association merge semantics cannot be selected accidentally.
   */
  upsertEntity(entity: EntityRecord): void {
    this.writeCanonicalEntity(entity);
  }

  /**
   * Total-overwrite one entity from canonical graph.jsonl state.
   *
   * This deliberately has a distinct name from the compatibility repository
   * methods below: canonical replay must never inherit merge/ignore semantics.
   */
  mirrorCanonicalEntity(entity: EntityRecord): void {
    this.writeCanonicalEntity(entity);
  }

  private writeCanonicalEntity(entity: EntityRecord): void {
    this.db.prepare(
      `INSERT INTO entities (id, name, type, summary, created_at, updated_at)
       VALUES (@id, @name, @type, @summary, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         summary = excluded.summary,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ).run({
      id: entity.id,
      name: entity.name,
      type: entity.type ?? null,
      summary: entity.summary ?? null,
      created_at: entity.createdAt,
      updated_at: entity.updatedAt ?? null,
    });
  }

  getEntity(id: string): EntityRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.entityFromRow(row);
  }

  countEntities(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number }).n;
  }

  /** A bounded entity page ordered deterministically by name and id, for index projections. */
  listEntities(limit = 50, offset = 0): EntityRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM entities ORDER BY name, id LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.entityFromRow(r));
  }

  /** Complete deterministic entity inventory for rebuild/parity validation. */
  allEntities(): EntityRecord[] {
    const rows = this.db.prepare(`SELECT * FROM entities ORDER BY id`).all() as Record<string, unknown>[];
    return rows.map((row) => this.entityFromRow(row));
  }

  addEntityRelation(src: string, dst: string, relation: string, createdAt = this.clock().toISOString()): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO entity_relations (src, dst, relation, created_at) VALUES (?, ?, ?, ?)`,
    ).run(src, dst, relation, createdAt);
  }

  /** Total-overwrite one relation from canonical graph.jsonl state. */
  mirrorCanonicalRelation(record: EntityRelationRecord): void {
    this.db.prepare(
      `INSERT INTO entity_relations (src, dst, relation, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(src, dst, relation) DO UPDATE SET created_at = excluded.created_at`,
    ).run(record.src, record.dst, record.relation, record.createdAt);
  }

  relationsFor(src: string): EntityRelationRecord[] {
    const rows = this.db
      .prepare(`SELECT src, dst, relation, created_at FROM entity_relations WHERE src = ?`)
      .all(src) as { src: string; dst: string; relation: string; created_at: string }[];
    return rows.map((r) => ({ src: r.src, dst: r.dst, relation: r.relation, createdAt: r.created_at }));
  }

  /** Complete deterministic relation inventory for rebuild/parity validation. */
  allEntityRelations(): EntityRelationRecord[] {
    const rows = this.db.prepare(
      `SELECT src, dst, relation, created_at FROM entity_relations ORDER BY src, dst, relation`,
    ).all() as Array<{ src: string; dst: string; relation: string; created_at: string }>;
    return rows.map((row) => ({
      src: row.src,
      dst: row.dst,
      relation: row.relation,
      createdAt: row.created_at,
    }));
  }

  relationsTouching(entityId: string): EntityRelationRecord[] {
    const rows = this.db
      .prepare(`SELECT src, dst, relation, created_at FROM entity_relations WHERE src = ? OR dst = ?`)
      .all(entityId, entityId) as { src: string; dst: string; relation: string; created_at: string }[];
    return rows.map((row) => ({
      src: row.src,
      dst: row.dst,
      relation: row.relation,
      createdAt: row.created_at,
    }));
  }

  associateMemory(record: MemoryEntityAssociation): void {
    this.assertAssociationEndpoints(record);
    this.db.prepare(
      `INSERT INTO memory_entities (memory_id, entity_id, provenance, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id, entity_id) DO UPDATE SET
         provenance = CASE
           WHEN memory_entities.provenance = 'capture' THEN memory_entities.provenance
           ELSE excluded.provenance
         END`,
    ).run(record.memoryId, record.entityId, record.provenance, record.createdAt);
  }

  /** Total-overwrite one memory/entity association from canonical graph.jsonl state. */
  mirrorCanonicalAssociation(record: MemoryEntityAssociation): void {
    this.assertAssociationEndpoints(record);
    this.db.prepare(
      `INSERT INTO memory_entities (memory_id, entity_id, provenance, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id, entity_id) DO UPDATE SET
         provenance = excluded.provenance,
         created_at = excluded.created_at`,
    ).run(record.memoryId, record.entityId, record.provenance, record.createdAt);
  }

  private assertAssociationEndpoints(record: Pick<MemoryEntityAssociation, "memoryId" | "entityId">): void {
    if (this.get(record.memoryId) === undefined) {
      throw new Error(`memory-store: cannot associate unknown memory "${record.memoryId}".`);
    }
    if (this.getEntity(record.entityId) === undefined) {
      throw new Error(`memory-store: cannot associate unknown entity "${record.entityId}".`);
    }
  }

  associationsForMemory(memoryId: string): MemoryEntityAssociation[] {
    const rows = this.db.prepare(
      `SELECT memory_id, entity_id, provenance, created_at FROM memory_entities WHERE memory_id = ? ORDER BY entity_id`,
    ).all(memoryId) as Array<{ memory_id: string; entity_id: string; provenance: MemoryEntityAssociation["provenance"]; created_at: string }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      entityId: row.entity_id,
      provenance: row.provenance,
      createdAt: row.created_at,
    }));
  }

  /** Complete deterministic memory/entity inventory for rebuild/parity validation. */
  allMemoryAssociations(): MemoryEntityAssociation[] {
    const rows = this.db.prepare(
      `SELECT memory_id, entity_id, provenance, created_at
       FROM memory_entities ORDER BY memory_id, entity_id`,
    ).all() as Array<{
      memory_id: string;
      entity_id: string;
      provenance: MemoryEntityAssociation["provenance"];
      created_at: string;
    }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      entityId: row.entity_id,
      provenance: row.provenance,
      createdAt: row.created_at,
    }));
  }

  /**
   * Atomically replace the complete graph projection derived from canonical
   * source while retaining only replay-owned thread/supersedes edges.
   *
   * `expectedMemories` is the exact provider-free SQLite snapshot used by the
   * caller to derive legacy associations and collection membership. The
   * transaction re-reads and compare-and-swaps that projection before its first
   * graph write, so a concurrent memory change fails closed. Canonical graph
   * `about` edges are intentionally empty in v1 and are retired together with
   * stale `supports` rows. Returns false when every projected field is already
   * exact and no write was needed.
   */
  replaceCanonicalGraphProjection(
    expectedMemories: readonly CanonicalGraphMemoryRecord[],
    projection: CanonicalGraphReplacement,
  ): boolean {
    const normalized = validateCanonicalGraphReplacement(expectedMemories, projection);
    const tx = this.db.transaction((): boolean => {
      const current = this.canonicalGraphSnapshot();
      if (!sameCanonicalGraphMemories(current.memories, normalized.memories)) {
        throw new Error("memory-store: canonical graph replacement lost memory projection compare-and-swap.");
      }

      const ownedEdges = (this.db.prepare(
        `SELECT src, dst, kind, weight, created_at
         FROM edges WHERE kind IN ('supports','about') ORDER BY kind, src, dst`,
      ).all() as Array<{
        src: string;
        dst: string;
        kind: "supports" | "about";
        weight: number;
        created_at: string;
      }>).map((row) => ({
        src: row.src,
        dst: row.dst,
        kind: row.kind,
        weight: row.weight,
        createdAt: row.created_at,
      }));
      if (sameCanonicalGraphReplacement(current, ownedEdges, normalized)) return false;

      this.db.prepare(`DELETE FROM memory_entities`).run();
      this.db.prepare(`DELETE FROM entity_relations`).run();
      this.db.prepare(`DELETE FROM entities`).run();
      this.db.prepare(`DELETE FROM edges WHERE kind IN ('supports','about')`).run();
      this.db.prepare(`UPDATE memories SET collection = NULL WHERE collection IS NOT NULL`).run();

      const insertEntity = this.db.prepare(
        `INSERT INTO entities (id, name, type, summary, created_at, updated_at)
         VALUES (@id, @name, @type, @summary, @created_at, @updated_at)`,
      );
      for (const entity of normalized.entities) {
        insertEntity.run({
          id: entity.id,
          name: entity.name,
          type: entity.type ?? null,
          summary: entity.summary ?? null,
          created_at: entity.createdAt,
          updated_at: entity.updatedAt ?? null,
        });
      }
      const insertRelation = this.db.prepare(
        `INSERT INTO entity_relations (src, dst, relation, created_at) VALUES (?, ?, ?, ?)`,
      );
      for (const relation of normalized.relations) {
        insertRelation.run(relation.src, relation.dst, relation.relation, relation.createdAt);
      }
      const insertAssociation = this.db.prepare(
        `INSERT INTO memory_entities (memory_id, entity_id, provenance, created_at) VALUES (?, ?, ?, ?)`,
      );
      for (const association of normalized.associations) {
        insertAssociation.run(
          association.memoryId,
          association.entityId,
          association.provenance,
          association.createdAt,
        );
      }
      const insertSupport = this.db.prepare(
        `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supports', ?, ?)`,
      );
      const setCollection = this.db.prepare(`UPDATE memories SET collection = ? WHERE id = ?`);
      for (const support of normalized.supports) {
        insertSupport.run(support.memoryId, support.entityId, support.weight, support.createdAt);
        if (setCollection.run(support.collection, support.memoryId).changes !== 1) {
          throw new Error(`memory-store: canonical graph replacement lost memory endpoint "${support.memoryId}".`);
        }
      }
      return true;
    });
    return tx();
  }

  /** Provider-free graph inventory and derivation inputs from one SQLite read transaction. */
  canonicalGraphSnapshot(): CanonicalGraphSnapshot {
    return this.db.transaction((): CanonicalGraphSnapshot => {
      const memories = (this.db.prepare(
        `SELECT id, status, text, created_at, collection FROM memories ORDER BY id`,
      ).all() as Array<{
        id: string;
        status: MemoryRecord["status"];
        text: string;
        created_at: string;
        collection: string | null;
      }>).map((row) => ({
        id: row.id,
        status: row.status,
        text: row.text,
        createdAt: row.created_at,
        ...(row.collection === null ? {} : { collection: row.collection }),
      }));
      const entities = (this.db.prepare(
        `SELECT id, name, type, summary, created_at, updated_at FROM entities ORDER BY id`,
      ).all() as Record<string, unknown>[]).map((row) => this.entityFromRow(row));
      const relations = (this.db.prepare(
        `SELECT src, dst, relation, created_at FROM entity_relations ORDER BY src, dst, relation`,
      ).all() as Array<{ src: string; dst: string; relation: string; created_at: string }>).map((row) => ({
        src: row.src,
        dst: row.dst,
        relation: row.relation,
        createdAt: row.created_at,
      }));
      const associations = (this.db.prepare(
        `SELECT memory_id, entity_id, provenance, created_at
         FROM memory_entities ORDER BY memory_id, entity_id`,
      ).all() as Array<{
        memory_id: string;
        entity_id: string;
        provenance: MemoryEntityAssociation["provenance"];
        created_at: string;
      }>).map((row) => ({
        memoryId: row.memory_id,
        entityId: row.entity_id,
        provenance: row.provenance,
        createdAt: row.created_at,
      }));
      const supports = this.db.prepare(
        `SELECT src, dst, weight FROM edges WHERE kind = 'supports' ORDER BY src, dst`,
      ).all() as Array<{ src: string; dst: string; weight: number }>;
      const metadata = this.indexMetadata();
      return {
        ...(metadata === undefined ? {} : { metadata }),
        memories,
        entities,
        relations,
        associations,
        supports,
      };
    })();
  }

  /**
   * Deterministic one-relation expansion for the explicit MemoryRecall tool.
   * Both relation directions are traversed, but never more than one relation.
   */
  expandEntityRelations(
    seedIds: readonly string[],
    options: { readonly query: string; readonly seedLimit?: number; readonly maxAdditions?: number; readonly now?: Date },
  ): MemoryRecord[] {
    const seedLimit = Math.max(1, Math.min(options.seedLimit ?? 3, 3));
    const maxAdditions = Math.max(0, Math.min(options.maxAdditions ?? 5, 5));
    if (maxAdditions === 0) return [];
    const seeds = new Set(seedIds.slice(0, seedLimit));
    const seedEntities = new Set<string>();
    for (const seedId of seeds) {
      for (const association of this.associationsForMemory(seedId)) seedEntities.add(association.entityId);
    }
    if (seedEntities.size === 0) return [];

    const queryTokens = relevanceTokens(options.query);
    const queryEntityIds = this.entityIdsMentionedInQuery(options.query);
    const relatedEntities = new Map<string, number>();
    for (const entityId of seedEntities) {
      for (const relation of this.relationsTouching(entityId)) {
        if (relation.src === relation.dst) continue;
        const relatedId = relation.src === entityId ? relation.dst : relation.src;
        const seedEntity = this.getEntity(entityId);
        const relatedEntity = this.getEntity(relatedId);
        if (seedEntity === undefined || relatedEntity === undefined) continue;
        // The seed name is deliberately excluded from path evidence. A query
        // about Morgan is not permission to traverse every relation Morgan has.
        const relationPhrases = normalizedRelationPhrases(relation.relation);
        if (relationPhrases.length === 0) continue;
        const relationTokens = new Set(relationPhrases.flat());
        const relatedTokens = relevanceTokens(relatedEntity.name);
        const overlap = tokenOverlap(queryTokens, relationTokens) + tokenOverlap(queryTokens, relatedTokens);
        if (overlap === 0 || !relationDirectionMatches(
          options.query,
          seedEntity.name,
          relatedEntity.name,
          relation.relation,
          relation.src === entityId,
          entityId,
          relatedId,
          (id, words) => this.entityReferenceIsUnique(id, words),
          queryEntityIds,
        )) continue;
        relatedEntities.set(relatedId, Math.max(relatedEntities.get(relatedId) ?? 0, overlap));
      }
    }
    if (relatedEntities.size === 0) return [];

    const entities = [...relatedEntities.keys()];
    const placeholders = entities.map(() => "?").join(",");
    const now = (options.now ?? this.clock()).toISOString();
    const rows = this.db.prepare(
      `SELECT m.*, me.entity_id AS graph_entity_id
       FROM memory_entities me
       JOIN memories m ON m.id = me.memory_id
       JOIN entities e ON e.id = me.entity_id
       WHERE me.entity_id IN (${placeholders})
         AND m.status NOT IN ('invalidated','dropped')
         AND (m.valid_to IS NULL OR m.valid_to >= ?)
       ORDER BY m.created_at DESC, m.id ASC`,
    ).all(...entities, now) as Array<Record<string, unknown> & { graph_entity_id: string }>;
    const ranked = new Map<string, { record: MemoryRecord; score: number }>();
    for (const row of rows) {
      const record = this.fromRow(row);
      if (seeds.has(record.id)) continue;
      const pathScore = relatedEntities.get(String(row.graph_entity_id)) ?? 0;
      const lexical = lexicalEvidence(queryTokens, record.text);
      const score = pathScore + lexical;
      const prior = ranked.get(record.id);
      if (prior === undefined || score > prior.score) ranked.set(record.id, { record, score });
    }
    return [...ranked.values()]
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id))
      .slice(0, maxAdditions)
      .map((entry) => entry.record);
  }

  /** Resolve one query-local entity spelling without materializing the entity catalog. */
  private entityReferenceIsUnique(entityId: string, words: readonly string[]): boolean {
    if (words.length === 0) return false;
    const phrase = words.join(" ");
    const rows = this.db.prepare(
      `SELECT id, name FROM entities
       WHERE id = ?
          OR lower(name) = (SELECT lower(name) FROM entities WHERE id = ?)
          OR lower(name) = ?
          OR lower(name) LIKE ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
       LIMIT 3`,
    ).all(entityId, entityId, phrase, `% ${phrase}`, entityId) as Array<{ id: string; name: string }>;
    const key = words.join("\u0000");
    const owners = rows.filter((row) => entityNameVariants(row.name).some((variant) => variant.join("\u0000") === key));
    return owners.length === 1 && owners[0]?.id === entityId;
  }

  /** Resolve only capitalized/type-qualified query-local names; never scan/materialize the catalog. */
  private entityIdsMentionedInQuery(query: string): ReadonlySet<string> {
    const rawWords = query.normalize("NFKC").match(/[\p{L}\p{N}-]+/gu) ?? [];
    const candidates = new Map<string, string[]>();
    for (let index = 0; index < rawWords.length;) {
      if (!startsUppercase(rawWords[index] ?? "")) {
        index += 1;
        continue;
      }
      const group: string[] = [];
      while (index < rawWords.length && startsUppercase(rawWords[index] ?? "")) {
        group.push(rawWords[index] ?? "");
        index += 1;
      }
      while (group.length > 0 && QUERY_NAME_PREFIXES.has((group[0] ?? "").toLocaleLowerCase("en-US"))) group.shift();
      const words = group.flatMap((word) => canonicalWords(word));
      if (words.length > 0) candidates.set(words.join("\u0000"), words);
    }
    const canonical = canonicalWords(query);
    for (let index = 0; index < canonical.length - 1; index += 1) {
      if (!GENERIC_ENTITY_PREFIXES.has(canonical[index] ?? "")) continue;
      const words = canonical.slice(index, index + 2);
      candidates.set(words.join("\u0000"), words);
    }
    const ids = new Set<string>();
    for (const words of candidates.values()) {
      for (const id of this.entityIdsForReference(words)) ids.add(id);
    }
    return ids;
  }

  private entityIdsForReference(words: readonly string[]): string[] {
    if (words.length === 0) return [];
    const phrase = words.join(" ");
    const rows = this.db.prepare(
      `SELECT id, name FROM entities
       WHERE lower(name) = ? OR lower(name) LIKE ?
       ORDER BY id
       LIMIT 4`,
    ).all(phrase, `% ${phrase}`) as Array<{ id: string; name: string }>;
    const key = words.join("\u0000");
    return rows
      .filter((row) => entityNameVariants(row.name).some((variant) => variant.join("\u0000") === key))
      .map((row) => row.id);
  }
}

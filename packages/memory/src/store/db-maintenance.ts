import { createHash } from "node:crypto";

import { MemoryDbCore } from "./db-core.js";
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type ContentHashRecord,
  type IndexMetadata,
  type MemoryRecord,
  type MemoryStoreAudit,
  type MemoryStoreStats,
  type MemoryStoreStatsOptions,
} from "./types.js";

export class MemoryDbMaintenance extends MemoryDbCore {
  stats(options: MemoryStoreStatsOptions = {}): MemoryStoreStats {
    const topEntitiesLimit = normalizeNonNegativeInteger(
      options.topEntitiesLimit ?? 10,
      "memory-store: stats topEntitiesLimit must be a non-negative integer.",
    );
    const countsByStatus = Object.fromEntries(MEMORY_STATUSES.map((status) => [status, 0])) as Record<
      (typeof MEMORY_STATUSES)[number],
      number
    >;
    const countsByType = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])) as Record<
      (typeof MEMORY_TYPES)[number],
      number
    >;

    const totalMemories = (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
    const liveMemories = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status NOT IN ('invalidated','dropped')`).get() as { n: number }
    ).n;

    const statusRows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).all() as {
      status: MemoryRecord["status"];
      n: number;
    }[];
    for (const row of statusRows) countsByStatus[row.status] = row.n;

    const typeRows = this.db.prepare(`SELECT type, COUNT(*) AS n FROM memories GROUP BY type`).all() as {
      type: MemoryRecord["type"];
      n: number;
    }[];
    for (const row of typeRows) countsByType[row.type] = row.n;

    const latestCreatedRow = this.db.prepare(
      `SELECT * FROM memories ORDER BY created_at DESC, id ASC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    const latestAccessedRow = this.db.prepare(
      `SELECT * FROM memories WHERE last_accessed_at IS NOT NULL ORDER BY last_accessed_at DESC, created_at DESC, id ASC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    const entityRows = this.db.prepare(
      `SELECT * FROM entities ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, name ASC, id ASC LIMIT ?`,
    ).all(topEntitiesLimit) as Record<string, unknown>[];

    return {
      totalMemories,
      liveMemories,
      countsByStatus,
      countsByType,
      ...(latestCreatedRow !== undefined && { latestCreatedMemory: this.fromRow(latestCreatedRow) }),
      ...(latestAccessedRow !== undefined && { latestAccessedMemory: this.fromRow(latestAccessedRow) }),
      topEntities: entityRows.map((row) => this.entityFromRow(row)),
    };
  }

  /** Aggregate-only health metrics for `mono-agent memory audit --json`. */
  audit(): MemoryStoreAudit {
    const counts = this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status NOT IN ('invalidated','dropped') THEN 1 ELSE 0 END) AS live,
         SUM(CASE WHEN status NOT IN ('invalidated','dropped') THEN access_count ELSE 0 END) AS total_access,
         SUM(CASE WHEN status NOT IN ('invalidated','dropped') AND access_count > 0 THEN 1 ELSE 0 END) AS accessed
       FROM memories`,
    ).get() as { total: number; live: number | null; total_access: number | null; accessed: number | null };
    const duplicate = this.db.prepare(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS redundant
       FROM (
         SELECT COUNT(*) AS n
         FROM memories
         WHERE status NOT IN ('invalidated','dropped')
         GROUP BY lower(trim(text))
         HAVING COUNT(*) > 1
       )`,
    ).get() as { groups: number; redundant: number };
    const vectors = this.db.prepare(
      `SELECT
         COUNT(*) AS indexed,
         SUM(CASE WHEN m.status NOT IN ('invalidated','dropped') THEN 1 ELSE 0 END) AS live_indexed
       FROM memories_vec v
       JOIN memories m ON m.seq = v.rowid`,
    ).get() as { indexed: number; live_indexed: number | null };
    const entities = (this.db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number }).n;
    const entityRelations = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM entity_relations`).get() as { n: number }
    ).n;
    const hasMemoryEntities = this.tableExists("memory_entities");
    const memoryEntityAssociations = hasMemoryEntities
      ? (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_entities`).get() as { n: number }).n
      : 0;
    const orphanedAssociations = hasMemoryEntities ? this.orphanedAssociationCount() : 0;
    const live = counts.live ?? 0;
    const totalAccess = counts.total_access ?? 0;
    const concentrationRows = this.db.prepare(
      `SELECT access_count FROM memories
       WHERE status NOT IN ('invalidated','dropped')
       ORDER BY access_count DESC, id ASC LIMIT ?`,
    ).all(Math.max(1, Math.ceil(live * 0.01))) as Array<{ access_count: number }>;
    const concentrated = concentrationRows.reduce((sum, row) => sum + row.access_count, 0);
    const liveIndexed = vectors.live_indexed ?? 0;
    return {
      counts: {
        total: counts.total,
        live,
        entities,
        entityRelations,
        memoryEntityAssociations,
        orphanedAssociations,
      },
      duplicates: {
        groups: duplicate.groups,
        redundantRecords: duplicate.redundant,
        ratio: live === 0 ? 0 : duplicate.redundant / live,
      },
      vectors: {
        indexed: vectors.indexed,
        liveIndexed,
        liveCoverage: live === 0 ? 1 : liveIndexed / live,
      },
      access: {
        totalCount: totalAccess,
        accessedMemories: counts.accessed ?? 0,
        topOnePercentShare: totalAccess === 0 ? 0 : concentrated / totalAccess,
      },
    };
  }
  orphanedAssociationCount(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM memory_entities me
       LEFT JOIN memories m ON m.id = me.memory_id
       LEFT JOIN entities e ON e.id = me.entity_id
       WHERE m.id IS NULL OR e.id IS NULL`,
    ).get() as { n: number }).n;
  }
  setIndexMetadata(metadata: IndexMetadata): void {
    const entries: Array<[string, string]> = [
      ["schemaVersion", String(metadata.schemaVersion)],
      ["policyVersion", metadata.policyVersion],
      ["tier", metadata.tier],
      ["sourceFingerprint", metadata.sourceFingerprint],
      ["generation", metadata.generation],
      ["createdAt", metadata.createdAt],
      ...(metadata.embeddingModel === undefined ? [] : [["embeddingModel", metadata.embeddingModel] as [string, string]]),
      ...(metadata.dimension === undefined ? [] : [["dimension", String(metadata.dimension)] as [string, string]]),
      ...(metadata.skippedRawRecords === undefined ? [] : [["skippedRawRecords", String(metadata.skippedRawRecords)] as [string, string]]),
      ...(metadata.skippedUnstructuredRecords === undefined ? [] : [["skippedUnstructuredRecords", String(metadata.skippedUnstructuredRecords)] as [string, string]]),
      ...(metadata.skippedMissingIdentityRecords === undefined ? [] : [["skippedMissingIdentityRecords", String(metadata.skippedMissingIdentityRecords)] as [string, string]]),
      ...(metadata.missingIdentityLocations === undefined ? [] : [["missingIdentityLocations", JSON.stringify(metadata.missingIdentityLocations)] as [string, string]]),
      ...(metadata.skippedLegacySourceRecords === undefined ? [] : [["skippedLegacySourceRecords", String(metadata.skippedLegacySourceRecords)] as [string, string]]),
      ...(metadata.legacySourceLocations === undefined ? [] : [["legacySourceLocations", JSON.stringify(metadata.legacySourceLocations)] as [string, string]]),
      ...(metadata.skippedJournalDuplicateRecords === undefined ? [] : [["skippedJournalDuplicateRecords", String(metadata.skippedJournalDuplicateRecords)] as [string, string]]),
      ...(metadata.parsedSourceItems === undefined ? [] : [["parsedSourceItems", String(metadata.parsedSourceItems)] as [string, string]]),
      ...(metadata.derivedLegacyAssociations === undefined ? [] : [["derivedLegacyAssociations", String(metadata.derivedLegacyAssociations)] as [string, string]]),
    ];
    const statement = this.db.prepare(
      `INSERT INTO index_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM index_metadata`).run();
      for (const entry of entries) statement.run(...entry);
    });
    tx();
  }

  indexMetadata(): IndexMetadata | undefined {
    if (!this.tableExists("index_metadata")) return undefined;
    const rows = this.db.prepare(`SELECT key, value FROM index_metadata`).all() as Array<{ key: string; value: string }>;
    if (rows.length === 0) return undefined;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const schemaVersion = Number(values.get("schemaVersion"));
    const policyVersion = values.get("policyVersion");
    const tier = values.get("tier");
    const sourceFingerprint = values.get("sourceFingerprint");
    const generation = values.get("generation");
    const createdAt = values.get("createdAt");
    if (!Number.isInteger(schemaVersion) || policyVersion === undefined
      || (tier !== "lite" && tier !== "journal" && tier !== "bujo")
      || sourceFingerprint === undefined || generation === undefined || createdAt === undefined) {
      throw new Error("memory-store: index metadata is incomplete or corrupt.");
    }
    const embeddingModel = values.get("embeddingModel");
    const dimensionRaw = values.get("dimension");
    const dimension = dimensionRaw === undefined ? undefined : Number(dimensionRaw);
    if (dimension !== undefined && (!Number.isInteger(dimension) || dimension <= 0)) {
      throw new Error("memory-store: index metadata dimension is invalid.");
    }
    const optionalCount = (key: string): number | undefined => {
      const raw = values.get(key);
      if (raw === undefined) return undefined;
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 0) throw new Error(`memory-store: index metadata ${key} is invalid.`);
      return count;
    };
    const skippedRawRecords = optionalCount("skippedRawRecords");
    const skippedUnstructuredRecords = optionalCount("skippedUnstructuredRecords");
    const skippedMissingIdentityRecords = optionalCount("skippedMissingIdentityRecords");
    let missingIdentityLocations: string[] | undefined;
    const missingIdentityLocationsRaw = values.get("missingIdentityLocations");
    if (missingIdentityLocationsRaw !== undefined) {
      try {
        const parsed = JSON.parse(missingIdentityLocationsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.some((location) => typeof location !== "string")) throw new Error();
        missingIdentityLocations = parsed;
      } catch {
        throw new Error("memory-store: index metadata missingIdentityLocations is invalid.");
      }
    }
    const skippedLegacySourceRecords = optionalCount("skippedLegacySourceRecords");
    let legacySourceLocations: string[] | undefined;
    const legacySourceLocationsRaw = values.get("legacySourceLocations");
    if (legacySourceLocationsRaw !== undefined) {
      try {
        const parsed = JSON.parse(legacySourceLocationsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.some((location) => typeof location !== "string")) throw new Error();
        legacySourceLocations = parsed;
      } catch {
        throw new Error("memory-store: index metadata legacySourceLocations is invalid.");
      }
    }
    const skippedJournalDuplicateRecords = optionalCount("skippedJournalDuplicateRecords");
    const parsedSourceItems = optionalCount("parsedSourceItems");
    const derivedLegacyAssociations = optionalCount("derivedLegacyAssociations");
    return {
      schemaVersion,
      policyVersion,
      tier,
      sourceFingerprint,
      generation,
      createdAt,
      ...(embeddingModel === undefined ? {} : { embeddingModel }),
      ...(dimension === undefined ? {} : { dimension }),
      ...(skippedRawRecords === undefined ? {} : { skippedRawRecords }),
      ...(skippedUnstructuredRecords === undefined ? {} : { skippedUnstructuredRecords }),
      ...(skippedMissingIdentityRecords === undefined ? {} : { skippedMissingIdentityRecords }),
      ...(missingIdentityLocations === undefined ? {} : { missingIdentityLocations }),
      ...(skippedLegacySourceRecords === undefined ? {} : { skippedLegacySourceRecords }),
      ...(legacySourceLocations === undefined ? {} : { legacySourceLocations }),
      ...(skippedJournalDuplicateRecords === undefined ? {} : { skippedJournalDuplicateRecords }),
      ...(parsedSourceItems === undefined ? {} : { parsedSourceItems }),
      ...(derivedLegacyAssociations === undefined ? {} : { derivedLegacyAssociations }),
    };
  }

  integrityCheck(): string {
    return String(this.db.pragma("integrity_check", { simple: true }));
  }

  /**
   * Hold one provider-free SQLite read snapshot across the strict health probes.
   *
   * The callback can use only MemoryDb's typed read surface; the underlying
   * better-sqlite3 handle remains private. Nested callers share an existing
   * transaction so rebuild/parity helpers can compose without changing the
   * observed database point in time.
   */
  withAuditSnapshot<T>(read: () => T): T {
    const ownsSnapshot = !this.db.inTransaction;
    if (ownsSnapshot) this.db.exec("BEGIN");
    try {
      return read();
    } finally {
      if (ownsSnapshot && this.db.inTransaction) this.db.exec("ROLLBACK");
    }
  }

  /**
   * Commit the complete runtime-visible SQLite state to one deterministic hash.
   *
   * Unlike hashing only `memory.db`, this observes committed WAL pages through
   * SQLite and includes vector blobs plus the graph, FTS, provenance, lifecycle,
   * and metadata tables. Safe rebuild stores this digest outside an immutable
   * rollback snapshot so later semantic tampering cannot authenticate itself.
   */
  logicalIntegrityDigest(): string {
    const ownsSnapshot = !this.db.inTransaction;
    if (ownsSnapshot) this.db.exec("BEGIN");
    const hash = createHash("sha256");
    try {
      hash.update("mono-agent-memory-logical-integrity-v1\0");
      const bytes = (marker: string, value: Uint8Array): void => {
        hash.update(marker);
        hash.update(String(value.byteLength));
        hash.update("\0");
        hash.update(value);
      };
      const add = (value: unknown): void => {
        if (value === null) {
          hash.update("N");
        } else if (value === undefined) {
          hash.update("U");
        } else if (typeof value === "string") {
          bytes("S", Buffer.from(value));
        } else if (typeof value === "number") {
          const encoded = Buffer.allocUnsafe(8);
          encoded.writeDoubleBE(value);
          bytes("D", encoded);
        } else if (typeof value === "bigint") {
          bytes("I", Buffer.from(value.toString()));
        } else if (typeof value === "boolean") {
          hash.update(value ? "T" : "F");
        } else if (ArrayBuffer.isView(value)) {
          bytes("B", Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        } else if (value instanceof ArrayBuffer) {
          bytes("B", Buffer.from(value));
        } else if (Array.isArray(value)) {
          hash.update("A");
          add(value.length);
          for (const entry of value) add(entry);
        } else {
          const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right));
          hash.update("O");
          add(entries.length);
          for (const [key, entry] of entries) {
            add(key);
            add(entry);
          }
        }
      };
      const section = (name: string, sql: string): void => {
        add(name);
        for (const row of this.db.prepare(sql).iterate()) add(row);
      };

      section(
        "sqlite_master",
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      );
      for (const table of [
        "memories",
        "edges",
        "memories_fts",
        "memories_vec",
        "entities",
        "entity_relations",
        "memory_entities",
        "content_hashes",
        "index_metadata",
      ]) {
        if (this.tableExists(table)) section(table, `SELECT rowid, * FROM ${table} ORDER BY rowid`);
      }
      return hash.digest("hex");
    } finally {
      if (ownsSnapshot && this.db.inTransaction) this.db.exec("ROLLBACK");
    }
  }

  vectorCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories_vec`).get() as { n: number }).n;
  }

  /** Deterministic per-memory vector commitments for same-provider rebuild parity. */
  vectorPayloadDigests(): { readonly memoryId: string; readonly sha256: string }[] {
    const rows = this.db.prepare(
      `SELECT m.id AS memory_id, v.embedding AS embedding
       FROM memories_vec v JOIN memories m ON m.seq = v.rowid ORDER BY m.id`,
    ).all() as Array<{ memory_id: string; embedding: Uint8Array }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      sha256: createHash("sha256").update(row.embedding).digest("hex"),
    }));
  }

  /** Dimension encoded in the actual vec0 DDL, including an empty vector table. */
  vectorDimension(): number {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_vec'`,
    ).get() as { sql: string } | undefined;
    const match = row?.sql.match(/embedding\s+float\[(\d+)\]/iu);
    const dimension = Number(match?.[1]);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("memory-store: memories_vec DDL has no valid vector dimension.");
    }
    return dimension;
  }

  /** Closed-candidate validation counters; every value is derived without mutating the DB. */
  validationSnapshot(): {
    readonly memories: number;
    readonly ftsRows: number;
    readonly ftsMismatches: number;
    readonly vectors: number;
    readonly vectorOrphans: number;
    readonly vectorIdentityMissing: number;
    readonly contentHashes: number;
    readonly contentHashOrphans: number;
    readonly entities: number;
    readonly relations: number;
    readonly relationOrphans: number;
    readonly associations: number;
    readonly associationOrphans: number;
    readonly embeddingModels: readonly string[];
    readonly embeddingDimensions: readonly number[];
  } {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const embeddingModels = (this.db.prepare(
      `SELECT DISTINCT m.embedding_model AS model FROM memories m
       JOIN memories_vec v ON v.rowid = m.seq
       WHERE m.embedding_model IS NOT NULL ORDER BY m.embedding_model`,
    ).all() as Array<{ model: string }>).map((row) => row.model);
    const embeddingDimensions = (this.db.prepare(
      `SELECT DISTINCT m.dim AS dim FROM memories m
       JOIN memories_vec v ON v.rowid = m.seq
       WHERE m.dim IS NOT NULL ORDER BY m.dim`,
    ).all() as Array<{ dim: number }>).map((row) => row.dim);
    return {
      memories: count(`SELECT COUNT(*) AS n FROM memories`),
      ftsRows: count(`SELECT COUNT(*) AS n FROM memories_fts`),
      ftsMismatches: count(
        `SELECT COUNT(*) AS n FROM (
           SELECT id, text FROM memories EXCEPT SELECT id, text FROM memories_fts
           UNION ALL
           SELECT id, text FROM memories_fts EXCEPT SELECT id, text FROM memories
         )`,
      ),
      vectors: count(`SELECT COUNT(*) AS n FROM memories_vec`),
      vectorOrphans: count(`SELECT COUNT(*) AS n FROM memories_vec v LEFT JOIN memories m ON m.seq = v.rowid WHERE m.id IS NULL`),
      vectorIdentityMissing: count(
        `SELECT COUNT(*) AS n FROM memories_vec v JOIN memories m ON m.seq = v.rowid
         WHERE m.embedding_model IS NULL OR m.dim IS NULL`,
      ),
      contentHashes: count(`SELECT COUNT(*) AS n FROM content_hashes`),
      contentHashOrphans: count(
        `SELECT COUNT(*) AS n FROM content_hashes h LEFT JOIN memories m ON m.id = h.memory_id WHERE m.id IS NULL`,
      ),
      entities: count(`SELECT COUNT(*) AS n FROM entities`),
      relations: count(`SELECT COUNT(*) AS n FROM entity_relations`),
      relationOrphans: count(
        `SELECT COUNT(*) AS n FROM entity_relations r
         LEFT JOIN entities s ON s.id = r.src LEFT JOIN entities d ON d.id = r.dst
         WHERE s.id IS NULL OR d.id IS NULL`,
      ),
      associations: count(`SELECT COUNT(*) AS n FROM memory_entities`),
      associationOrphans: count(
        `SELECT COUNT(*) AS n FROM memory_entities a
         LEFT JOIN memories m ON m.id = a.memory_id LEFT JOIN entities e ON e.id = a.entity_id
         WHERE m.id IS NULL OR e.id IS NULL`,
      ),
      embeddingModels,
      embeddingDimensions,
    };
  }

  contentHashRecords(): ContentHashRecord[] {
    const rows = this.db.prepare(
      `SELECT content_hash, memory_id, source_file, created_at FROM content_hashes ORDER BY content_hash`,
    ).all() as Array<{ content_hash: string; memory_id: string; source_file: string; created_at: string }>;
    return rows.map((row) => ({
      contentHash: row.content_hash,
      memoryId: row.memory_id,
      sourceFile: row.source_file,
      createdAt: row.created_at,
    }));
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  async backupTo(path: string): Promise<void> {
    await this.db.backup(path);
  }

  private tableExists(name: string): boolean {
    return this.db.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(name) !== undefined;
  }

  assertEmbeddingIdentity(): void {
    if (this.embeddings === undefined) return;
    const ddlDimension = this.vectorDimension();
    if (ddlDimension !== this.dim) {
      throw new Error(
        `memory-store: active index vector dimension ${ddlDimension} does not match configured ${this.dim}; `
        + "run the safe memory rebuild before writing or recalling semantically.",
      );
    }
    const rows = this.db.prepare(
      `SELECT DISTINCT m.embedding_model AS model, m.dim AS dim
       FROM memories m JOIN memories_vec v ON v.rowid = m.seq`,
    ).all() as Array<{ model: string | null; dim: number | null }>;
    for (const row of rows) {
      if (row.dim === null || row.model === null) {
        throw new Error(
          "memory-store: active index contains vectors without complete embedding model/dimension identity; "
          + "run the safe memory rebuild before writing or recalling semantically.",
        );
      }
      if (row.dim !== this.dim) {
        throw new Error(
          `memory-store: active index dimension ${row.dim} does not match configured ${this.dim}; run the safe memory rebuild.`,
        );
      }
      if (row.model !== this.embeddings.id) {
        throw new Error(
          `memory-store: active index model "${row.model}" does not match configured "${this.embeddings.id}"; run the safe memory rebuild.`,
        );
      }
    }
  }
  /** Open memories with a due date at/under `now`, soonest first (the future-log queue). */
  dueItems(now: Date, limit = 50): MemoryRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE status IN ('open','scheduled') AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT ?`,
    ).all(now.toISOString(), limit) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Live, low-salience, old, infrequently-accessed open memories — migration candidates. */
  agingOpen(now: Date, opts: { olderThanDays?: number; maxSalience?: number; limit?: number } = {}): MemoryRecord[] {
    const olderThan = new Date(now.getTime() - (opts.olderThanDays ?? 30) * 86_400_000).toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE status = 'open' AND created_at <= ? AND salience <= ? ORDER BY salience ASC, created_at ASC LIMIT ?`,
    ).all(olderThan, opts.maxSalience ?? 0.4, opts.limit ?? 50) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Highest-salience live memories (for promotion / always-in-context / index). */
  topSalient(limit = 20): MemoryRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE status NOT IN ('invalidated','dropped') ORDER BY salience DESC, created_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  close(): void {
    this.db.close();
  }
}

function normalizeNonNegativeInteger(value: number, message: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}

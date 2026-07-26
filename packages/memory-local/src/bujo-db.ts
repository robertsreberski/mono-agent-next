// SPDX-License-Identifier: MIT
import { DatabaseSync } from "node:sqlite";

import { load as loadSqliteVec } from "sqlite-vec";

import type { JsonObject, MemoryRecord } from "@mono-agent/module-sdk";

import {
  DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS,
  type MemoryLocalConfig,
} from "./config.js";
import { MemoryLocalError } from "./errors.js";
import { toVectorBlob } from "./embeddings.js";
import {
  canonicalStoredMemoryTimestamp,
  canonicalJson,
  reconstructMemoryRecord,
  type ValidatedMemoryRecord,
} from "./records.js";

const MEMORY_TYPES = ["task", "event", "note"] as const;
const MEMORY_STATUSES = ["open", "done", "scheduled", "migrated", "dropped", "invalidated"] as const;
const REQUIRED_TABLES = [
  "content_hashes",
  "edges",
  "entities",
  "entity_relations",
  "index_metadata",
  "memories",
  "memories_fts",
  "memories_vec",
  "memory_entities",
] as const;
const APPLICATION_ID = 0x4d414d31;
const MAX_NON_RECEIPT_METADATA_ROWS = 1_000_000;
const MAX_STORED_TIMESTAMP_BYTES = 64;
const MAX_CAPTURE_RECEIPT_BYTES = 4_096;
const CAPTURE_RECEIPT_PREFIX = "memory-local:capture-receipt:";
const CAPTURE_RECEIPT_GLOB = `${CAPTURE_RECEIPT_PREFIX}*`;
const CAPTURE_RECEIPT_KEY =
  /^memory-local:capture-receipt:[A-Za-z0-9_-]{2,342}$/u;
const CAPTURE_RECEIPT_PAGE_SIZE = 512;
export const MAX_CAPTURE_RECEIPTS = 100_000;
export const CAPTURE_RECEIPT_LOW_WATERMARK = 90_000;
const MAX_CAPTURE_RECEIPT_SCAN_ROWS = 1_000_000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const CANONICAL_RECEIPT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MEMORY_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface BujoMemoryRow {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly status: string;
  readonly text: string;
  readonly salience: number;
  readonly is_insight: number;
  readonly created_at: string;
  readonly last_accessed_at: string | null;
  readonly access_count: number;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly superseded_by: string | null;
  readonly superseded_at: string | null;
  readonly due_at: string | null;
  readonly collection: string | null;
  readonly source_session: string | null;
  readonly source_file: string | null;
  readonly source_line: number | null;
  readonly embedding_model: string | null;
  readonly dim: number | null;
  readonly tags: string;
}

type ReadableBujoMemoryRow = Pick<
  BujoMemoryRow,
  | "id"
  | "type"
  | "status"
  | "text"
  | "salience"
  | "is_insight"
  | "created_at"
  | "collection"
  | "source_session"
  | "tags"
>;

export interface BujoAuditSnapshot {
  readonly recordCount: number;
  readonly recordBytes: number;
  readonly ftsCount: number;
  readonly vectorCount: number;
  readonly pendingCaptureCount: number;
  readonly pendingVectorCount: number;
  readonly captureReceiptCount: number;
  readonly missingFtsRows: number;
  readonly orphanFtsRows: number;
  readonly missingVectorRows: number;
  readonly missingDeclaredVectorRows: number;
  readonly vectorDimension?: number;
  readonly integrity: "ok";
}

export interface MemoryCaptureCommit {
  readonly intakeKey: string;
  readonly receiptKey: string;
  readonly receiptValue: string;
  readonly beforeCommit?: () => void;
}

export type CaptureReceipt =
  | {
    readonly version: 1;
    readonly sourceHash: string;
    readonly recordIds: readonly string[];
  }
  | {
    readonly version: 2;
    readonly sourceHash: string;
    readonly recordIds: readonly string[];
    readonly retainedAt: string;
  };

export interface MemoryCaptureReservation {
  readonly receipt?: CaptureReceipt;
  readonly intakeValue?: string;
}

export function openBujoDatabase(path: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { timeout: 0, allowExtension: true });
    loadSqliteVec(database);
    database.enableLoadExtension(false);
    return database;
  } catch (error) {
    database?.close();
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory database could not be opened with the required SQLite vector extension.",
      { cause: safeSqliteCause(error) },
    );
  }
}

export function configureBujoDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 0;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
  `);
}

export function createBujoSchema(database: DatabaseSync, dimensions: number): void {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16_384) {
    throw new MemoryLocalError("corrupt_store", "Memory vector dimensions are invalid.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('task','event','note')),
        status TEXT NOT NULL CHECK(status IN ('open','done','scheduled','migrated','dropped','invalidated')),
        text TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.5,
        is_insight INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        valid_from TEXT,
        valid_to TEXT,
        superseded_by TEXT,
        superseded_at TEXT,
        due_at TEXT,
        collection TEXT,
        source_session TEXT,
        source_file TEXT,
        source_line INTEGER,
        embedding_model TEXT,
        dim INTEGER,
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE edges (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('thread','about','supports','supersedes')),
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(src, dst, kind)
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text);
      CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${dimensions}] distance_metric=cosine);
      CREATE INDEX idx_memories_status ON memories(status);
      CREATE INDEX idx_memories_due ON memories(due_at);
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE entity_relations (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(src, dst, relation)
      );
      CREATE TABLE memory_entities (
        memory_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        provenance TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, entity_id)
      );
      CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
      CREATE TABLE content_hashes (
        content_hash TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory database schema creation failed.",
      { cause: safeSqliteCause(error) },
    );
  }
}

export function verifyBujoSchema(database: DatabaseSync): number {
  quickCheck(database);
  const rows = database.prepare(
    "SELECT name, sql FROM sqlite_schema WHERE type IN ('table','view')",
  ).all() as unknown as { name: string; sql: string | null }[];
  const names = new Set(rows.map(({ name }) => name));
  for (const table of REQUIRED_TABLES) {
    if (!names.has(table)) {
      throw new MemoryLocalError("corrupt_store", `Memory database is missing required BuJo table ${table}.`);
    }
  }
  const vecSql = rows.find(({ name }) => name === "memories_vec")?.sql ?? "";
  const match = /embedding\s+float\[(\d+)\]/iu.exec(vecSql);
  const dimensions = Number(match?.[1]);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16_384) {
    throw new MemoryLocalError("corrupt_store", "Memory vector table has an invalid dimension.");
  }
  const metadataCount = database.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(
        CASE WHEN key GLOB 'memory-local:capture-receipt:*' THEN 1 ELSE 0 END
      ), 0) AS receipt_count
    FROM index_metadata
  `).get() as unknown as { count: number; receipt_count: number };
  const totalMetadata = number(metadataCount.count, "metadata row count");
  const receiptMetadata = number(metadataCount.receipt_count, "capture receipt count");
  if (totalMetadata - receiptMetadata > MAX_NON_RECEIPT_METADATA_ROWS) {
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory non-receipt metadata row count exceeds its safety bound.",
    );
  }
  return dimensions;
}

export function quickCheck(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA quick_check(1)").all() as unknown as Record<string, unknown>[];
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
    throw new MemoryLocalError("corrupt_store", "SQLite quick_check did not return ok.");
  }
}

export function readMemoryRow(database: DatabaseSync, id: string): BujoMemoryRow | undefined {
  return database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as BujoMemoryRow | undefined;
}

export function readMemoryRows(
  database: DatabaseSync,
  maximum: number,
): readonly BujoMemoryRow[] {
  return database.prepare(
    "SELECT * FROM memories ORDER BY seq ASC LIMIT ?",
  ).all(maximum) as unknown as BujoMemoryRow[];
}

export function assertReadableMemoryRows(
  database: DatabaseSync,
  config: MemoryLocalConfig,
  snapshot: BujoAuditSnapshot,
): void {
  if (
    snapshot.recordCount > DEFAULT_CAPACITY.maxRecords
    || snapshot.recordBytes > DEFAULT_CAPACITY.maxTotalBytes
  ) {
    throw new MemoryLocalError("corrupt_store", "Memory records exceed their bounded capacity.");
  }
  const storage = database.prepare(`
    SELECT COUNT(*) AS invalid_storage
    FROM memories
    WHERE typeof(id) != 'text'
      OR typeof(type) != 'text'
      OR typeof(status) != 'text'
      OR typeof(text) != 'text'
      OR typeof(salience) NOT IN ('integer', 'real')
      OR typeof(is_insight) != 'integer'
      OR typeof(created_at) != 'text'
      OR typeof(tags) != 'text'
      OR (source_session IS NOT NULL AND typeof(source_session) != 'text')
      OR (collection IS NOT NULL AND typeof(collection) != 'text')
  `).get() as unknown as { invalid_storage: number };
  if (number(storage.invalid_storage, "record storage-class count") !== 0) {
    throw new MemoryLocalError("corrupt_store", "Stored BuJo memory row has an invalid storage class.");
  }
  const maximums = database.prepare(`
    SELECT
      COALESCE(MAX(LENGTH(CAST(id AS BLOB))), 0) AS id_bytes,
      COALESCE(MAX(LENGTH(CAST(type AS BLOB))), 0) AS type_bytes,
      COALESCE(MAX(LENGTH(CAST(status AS BLOB))), 0) AS status_bytes,
      COALESCE(MAX(LENGTH(CAST(text AS BLOB))), 0) AS text_bytes,
      COALESCE(MAX(LENGTH(CAST(created_at AS BLOB))), 0) AS created_at_bytes,
      COALESCE(MAX(LENGTH(CAST(tags AS BLOB))), 0) AS tags_bytes,
      COALESCE(MAX(LENGTH(CAST(source_session AS BLOB))), 0) AS source_session_bytes,
      COALESCE(MAX(LENGTH(CAST(collection AS BLOB))), 0) AS collection_bytes
    FROM memories
  `).get() as unknown as Record<string, number>;
  if (
    number(maximums.id_bytes, "record id byte bound") > 256
    || number(maximums.type_bytes, "record type byte bound") > 32
    || number(maximums.status_bytes, "record status byte bound") > 32
    || number(maximums.text_bytes, "record text byte bound") > DEFAULT_CAPACITY.maxTextBytes
    || number(maximums.created_at_bytes, "record timestamp byte bound") > MAX_STORED_TIMESTAMP_BYTES
    || number(maximums.tags_bytes, "record tags byte bound") > DEFAULT_CAPACITY.maxMetadataBytes
    || number(maximums.source_session_bytes, "record session byte bound") > DEFAULT_CAPACITY.maxMetadataBytes
    || number(maximums.collection_bytes, "record collection byte bound") > DEFAULT_CAPACITY.maxMetadataBytes
  ) {
    throw new MemoryLocalError("corrupt_store", "Stored BuJo memory row exceeds its field bounds.");
  }
  let count = 0;
  const rows = database.prepare(`
    SELECT
      id, type, status, text, salience, is_insight, created_at,
      collection, source_session, tags
    FROM memories
    ORDER BY seq ASC
    LIMIT ?
  `).iterate(snapshot.recordCount + 1);
  for (const row of rows as unknown as Iterable<ReadableBujoMemoryRow>) {
    count += 1;
    if (count > snapshot.recordCount) {
      throw new MemoryLocalError("corrupt_store", "Memory record count changed during semantic validation.");
    }
    decodeMemoryRow(row, config);
  }
  if (count !== snapshot.recordCount) {
    throw new MemoryLocalError("corrupt_store", "Memory record count changed during semantic validation.");
  }
}

export function decodeMemoryRow(row: ReadableBujoMemoryRow, config: MemoryLocalConfig): MemoryRecord {
  if (
    typeof row.id !== "string"
    || typeof row.type !== "string"
    || typeof row.status !== "string"
    || typeof row.text !== "string"
    || typeof row.salience !== "number"
    || !Number.isFinite(row.salience)
    || typeof row.is_insight !== "number"
    || typeof row.created_at !== "string"
    || typeof row.tags !== "string"
    || (row.source_session !== null && typeof row.source_session !== "string")
    || (row.collection !== null && typeof row.collection !== "string")
    || !MEMORY_TYPES.includes(row.type as never)
    || !MEMORY_STATUSES.includes(row.status as never)
    || (row.is_insight !== 0 && row.is_insight !== 1)
  ) {
    corruptRow();
  }
  let tags: unknown;
  try {
    tags = JSON.parse(row.tags);
  } catch {
    corruptRow();
  }
  if (!Array.isArray(tags) || tags.length > 256 || tags.some((tag) =>
    typeof tag !== "string" || tag.length === 0 || tag.length > 256)) {
    corruptRow();
  }
  const metadata: JsonObject = {
    memoryType: row.type,
    memoryStatus: row.status,
    salience: row.salience,
    isInsight: row.is_insight === 1,
    tags,
    ...(row.source_session === null ? {} : { conversationId: row.source_session }),
    ...(row.collection === null ? {} : { collection: row.collection }),
  };
  try {
    return reconstructMemoryRecord({
      id: row.id,
      text: row.text,
      createdAt: canonicalStoredMemoryTimestamp(row.created_at),
      metadata,
    }, recordLimits(config));
  } catch (error) {
    if (error instanceof MemoryLocalError && error.code === "invalid_record") corruptRow();
    throw error;
  }
}

export function insertMemoryRows(
  database: DatabaseSync,
  records: readonly ValidatedMemoryRecord[],
  vectors: ReadonlyMap<string, readonly number[]>,
  embeddingIdentity: { readonly id: string; readonly dimensions: number } | undefined,
  _config: MemoryLocalConfig,
  completion: MemoryCaptureCommit,
): { readonly inserted: number; readonly duplicates: number; readonly pendingVectors: readonly string[] } {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (
      getMetadata(database, completion.receiptKey) === undefined
      && captureReceiptCount(database) >= MAX_CAPTURE_RECEIPTS
    ) {
      throw new MemoryLocalError(
        "capacity_exceeded",
        "Memory capture receipt capacity is exhausted; no records were captured.",
      );
    }
    const capacity = database.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM memories",
    ).get() as unknown as { count: number; bytes: number };
    let count = Number(capacity.count);
    let bytes = Number(capacity.bytes);
    let inserted = 0;
    let duplicates = 0;
    const pendingVectors: string[] = [];
    const currentHash = database.prepare("SELECT value FROM index_metadata WHERE key = ?");
    const currentRow = database.prepare("SELECT id, seq, text, created_at FROM memories WHERE id = ?");
    const currentVector = database.prepare("SELECT 1 AS present FROM memories_vec WHERE rowid = ?");
    const insert = database.prepare(`
      INSERT INTO memories(
        id, seq, type, status, text, salience, is_insight, created_at,
        last_accessed_at, access_count, valid_from, valid_to, superseded_by,
        superseded_at, due_at, collection, source_session, source_file,
        source_line, embedding_model, dim, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?)
    `);
    const insertFts = database.prepare("INSERT INTO memories_fts(id, text) VALUES (?, ?)");
    const insertVector = database.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)");
    const insertHash = database.prepare(
      "INSERT INTO content_hashes(content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING",
    );
    const setMetadata = database.prepare(
      "INSERT INTO index_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    let nextSeq = Number((database.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS value FROM memories",
    ).get() as unknown as { value: number }).value);

    for (const item of records) {
      const hashKey = recordHashKey(item.record.id);
      const storedHash = currentHash.get(hashKey) as unknown as { value: string } | undefined;
      const existing = currentRow.get(item.record.id) as unknown as
        | { id: string; seq: number; text: string; created_at: string }
        | undefined;
      if (existing !== undefined) {
        const exact = storedHash?.value === item.contentHash
          || (storedHash === undefined
            && existing.text === item.record.text
            && existing.created_at === item.record.createdAt);
        if (!exact) {
          throw new MemoryLocalError(
            "duplicate_record",
            `Memory id ${JSON.stringify(item.record.id)} already has different content.`,
          );
        }
        if (storedHash === undefined) setMetadata.run(hashKey, item.contentHash);
        if (
          embeddingIdentity !== undefined
          && currentVector.get(BigInt(existing.seq)) === undefined
        ) {
          setMetadata.run(
            vectorIntakeKey(item.record.id),
            vectorIntakeValue(item.record.id),
          );
          pendingVectors.push(item.record.id);
        }
        duplicates += 1;
        continue;
      }
      count += 1;
      bytes += Buffer.byteLength(item.record.text, "utf8");
      if (count > DEFAULT_CAPACITY.maxRecords || bytes > DEFAULT_CAPACITY.maxTotalBytes) {
        throw new MemoryLocalError("capacity_exceeded", "Memory capacity would be exceeded; no records were captured.");
      }
      nextSeq += 1;
      const fields = memoryFields(item.record.metadata);
      const vector = vectors.get(item.record.id);
      insert.run(
        item.record.id,
        nextSeq,
        fields.type,
        fields.status,
        item.record.text,
        fields.salience,
        fields.isInsight ? 1 : 0,
        item.record.createdAt,
        fields.collection ?? null,
        fields.conversationId ?? null,
        "v1:capture",
        vector === undefined ? null : embeddingIdentity?.id ?? null,
        vector === undefined ? null : embeddingIdentity?.dimensions ?? null,
        JSON.stringify(fields.tags),
      );
      insertFts.run(item.record.id, item.record.text);
      if (vector === undefined) {
        if (embeddingIdentity !== undefined) {
          setMetadata.run(
            vectorIntakeKey(item.record.id),
            vectorIntakeValue(item.record.id),
          );
          pendingVectors.push(item.record.id);
        }
      } else {
        insertVector.run(BigInt(nextSeq), toVectorBlob(vector));
      }
      insertHash.run(item.contentHash, item.record.id, "v1:capture", item.record.createdAt);
      setMetadata.run(hashKey, item.contentHash);
      inserted += 1;
    }
    setMetadata.run(completion.receiptKey, completion.receiptValue);
    database.prepare("DELETE FROM index_metadata WHERE key = ?").run(completion.intakeKey);
    completion.beforeCommit?.();
    database.exec("COMMIT");
    return Object.freeze({
      inserted,
      duplicates,
      pendingVectors: Object.freeze(pendingVectors),
    });
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function ensureVectorIntake(
  database: DatabaseSync,
  recordIds: readonly string[],
): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT seq FROM memories WHERE id = ?");
    const vector = database.prepare("SELECT 1 AS present FROM memories_vec WHERE rowid = ?");
    const metadata = database.prepare(
      "INSERT INTO index_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    let repaired = 0;
    for (const recordId of new Set(recordIds)) {
      const stored = row.get(recordId) as unknown as { seq: number } | undefined;
      if (stored === undefined) {
        throw new MemoryLocalError(
          "corrupt_store",
          "Memory capture receipt points to a missing canonical record.",
        );
      }
      if (vector.get(BigInt(stored.seq)) !== undefined) continue;
      metadata.run(vectorIntakeKey(recordId), vectorIntakeValue(recordId));
      repaired += 1;
    }
    database.exec("COMMIT");
    return repaired;
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function forgetMemoryRow(
  database: DatabaseSync,
  recordId: string,
  retainedAt: string,
  retentionDays: number,
): boolean {
  receiptTimestampMillis(retainedAt);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT seq FROM memories WHERE id = ?").get(recordId) as unknown as
      | { seq: number }
      | undefined;
    if (row === undefined) {
      database.exec("COMMIT");
      return false;
    }
    forgetCaptureReceiptReferences(database, recordId, retainedAt);
    database.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(row.seq));
    database.prepare("DELETE FROM memories_fts WHERE id = ?").run(recordId);
    database.prepare("DELETE FROM content_hashes WHERE memory_id = ?").run(recordId);
    database.prepare("DELETE FROM memory_entities WHERE memory_id = ?").run(recordId);
    database.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(recordId, recordId);
    database.prepare("DELETE FROM index_metadata WHERE key IN (?, ?)").run(
      recordHashKey(recordId),
      vectorIntakeKey(recordId),
    );
    database.prepare("DELETE FROM memories WHERE id = ?").run(recordId);
    assertCaptureReceiptIntegrity(database, { retainedAt, retentionDays });
    database.exec("COMMIT");
    return true;
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function rebuildBujoIndexes(
  database: DatabaseSync,
  rows: readonly BujoMemoryRow[],
  vectors: ReadonlyMap<string, readonly number[]>,
  embeddingIdentity: { readonly id: string; readonly dimensions: number } | undefined,
  currentVectorDimensions: number,
): { readonly ftsIndexed: number; readonly vectorsIndexed: number; readonly vectorDimensions: number } {
  const dimensions = embeddingIdentity?.dimensions ?? currentVectorDimensions;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM memories_fts; DROP TABLE memories_vec;");
    database.exec(
      `CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${dimensions}] distance_metric=cosine);`,
    );
    const insertFts = database.prepare("INSERT INTO memories_fts(id, text) VALUES (?, ?)");
    const insertVector = database.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)");
    const updateVectorIdentity = database.prepare(
      "UPDATE memories SET embedding_model = ?, dim = ? WHERE id = ?",
    );
    const clearVectorIdentity = database.prepare(
      "UPDATE memories SET embedding_model = NULL, dim = NULL WHERE id = ?",
    );
    let vectorCount = 0;
    for (const row of rows) {
      insertFts.run(row.id, row.text);
      const vector = vectors.get(row.id);
      if (vector === undefined || embeddingIdentity === undefined) {
        clearVectorIdentity.run(row.id);
        continue;
      }
      insertVector.run(BigInt(row.seq), toVectorBlob(vector));
      updateVectorIdentity.run(embeddingIdentity.id, embeddingIdentity.dimensions, row.id);
      vectorCount += 1;
    }
    database.exec("COMMIT");
    return Object.freeze({
      ftsIndexed: rows.length,
      vectorsIndexed: vectorCount,
      vectorDimensions: dimensions,
    });
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function writeMemoryVector(
  database: DatabaseSync,
  row: BujoMemoryRow,
  vector: readonly number[],
  embeddingIdentity: { readonly id: string; readonly dimensions: number },
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(row.seq));
    database.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)")
      .run(BigInt(row.seq), toVectorBlob(vector));
    database.prepare("UPDATE memories SET embedding_model = ?, dim = ? WHERE id = ?")
      .run(embeddingIdentity.id, embeddingIdentity.dimensions, row.id);
    deleteMetadata(database, vectorIntakeKey(row.id));
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function auditBujoDatabase(database: DatabaseSync): BujoAuditSnapshot {
  quickCheck(database);
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM memories) AS record_count,
      (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM memories) AS record_bytes,
      (SELECT COUNT(*) FROM memories_fts) AS fts_count,
      (SELECT COUNT(*) FROM memories_vec) AS vector_count,
      (SELECT COUNT(*) FROM index_metadata WHERE key LIKE 'memory-local:capture-intake:%') AS pending_capture_count,
      (SELECT COUNT(*) FROM index_metadata WHERE key LIKE 'memory-local:vector-intake:%') AS pending_vector_count,
      (
        SELECT COUNT(*)
        FROM index_metadata
        WHERE key GLOB 'memory-local:capture-receipt:*'
      ) AS capture_receipt_count,
      (SELECT COUNT(*) FROM memories m LEFT JOIN memories_fts f ON f.id = m.id WHERE f.id IS NULL) AS missing_fts,
      (SELECT COUNT(*) FROM memories_fts f LEFT JOIN memories m ON m.id = f.id WHERE m.id IS NULL) AS orphan_fts,
      (SELECT COUNT(*) FROM memories m LEFT JOIN memories_vec v ON v.rowid = m.seq WHERE v.rowid IS NULL) AS missing_vectors,
      (
        SELECT COUNT(*)
        FROM memories m
        LEFT JOIN memories_vec v ON v.rowid = m.seq
        WHERE v.rowid IS NULL AND (m.embedding_model IS NOT NULL OR m.dim IS NOT NULL)
      ) AS missing_declared_vectors
  `).get() as unknown as Record<string, number>;
  return Object.freeze({
    recordCount: number(counts.record_count, "record count"),
    recordBytes: number(counts.record_bytes, "record bytes"),
    ftsCount: number(counts.fts_count, "FTS count"),
    vectorCount: number(counts.vector_count, "vector count"),
    pendingCaptureCount: number(counts.pending_capture_count, "pending capture count"),
    pendingVectorCount: number(counts.pending_vector_count, "pending vector count"),
    captureReceiptCount: number(counts.capture_receipt_count, "capture receipt count"),
    missingFtsRows: number(counts.missing_fts, "missing FTS count"),
    orphanFtsRows: number(counts.orphan_fts, "orphan FTS count"),
    missingVectorRows: number(counts.missing_vectors, "missing vector count"),
    missingDeclaredVectorRows: number(
      counts.missing_declared_vectors,
      "missing declared vector count",
    ),
    vectorDimension: verifyBujoSchema(database),
    integrity: "ok",
  });
}

export function getMetadata(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as unknown as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMetadata(database: DatabaseSync, key: string, value: string): void {
  database.prepare(
    "INSERT INTO index_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteMetadata(database: DatabaseSync, key: string): void {
  database.prepare("DELETE FROM index_metadata WHERE key = ?").run(key);
}

export function listMetadata(
  database: DatabaseSync,
  prefix: string,
  limit: number,
): readonly { readonly key: string; readonly value: string }[] {
  const escaped = prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return database.prepare(
    "SELECT key, value FROM index_metadata WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?",
  ).all(`${escaped}%`, limit) as unknown as { key: string; value: string }[];
}

export function captureIntakeKey(id: string): string {
  return `memory-local:capture-intake:${digestKey(id)}`;
}

export function captureReceiptKey(id: string): string {
  return `${CAPTURE_RECEIPT_PREFIX}${digestKey(id)}`;
}

export function reserveMemoryCapture(
  database: DatabaseSync,
  request: {
    readonly receiptKey: string;
    readonly intakeKey: string;
    readonly intakeValue: string;
    readonly retainedAt: string;
    readonly retentionDays: number;
  },
): MemoryCaptureReservation {
  const now = receiptTimestampMillis(request.retainedAt);
  if (
    !Number.isSafeInteger(request.retentionDays)
    || request.retentionDays < 1
    || request.retentionDays > 3_650
  ) {
    throw new MemoryLocalError("corrupt_store", "Memory capture receipt retention is invalid.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const originalCount = captureReceiptCount(database);
    const currentValue = getMetadata(database, request.receiptKey);
    if (currentValue !== undefined) {
      const current = parseCaptureReceipt(currentValue);
      if (!captureReceiptExpired(current, now, request.retentionDays)) {
        database.exec("COMMIT");
        return Object.freeze({ receipt: current });
      }
      const removed = database.prepare(
        "DELETE FROM index_metadata WHERE key = ?",
      ).run(request.receiptKey);
      if (Number(removed.changes) !== 1) {
        throw new MemoryLocalError(
          "corrupt_store",
          "Memory capture receipt changed during capacity reservation.",
        );
      }
    }

    let retainedCount = originalCount - (currentValue === undefined ? 0 : 1);
    if (originalCount >= MAX_CAPTURE_RECEIPTS) {
      const expired: { readonly key: string; readonly retainedAt: string }[] = [];
      for (const { key, value } of captureReceiptRows(database)) {
        const receipt = parseCaptureReceipt(value);
        if (
          receipt.version === 2
          && captureReceiptExpired(receipt, now, request.retentionDays)
        ) {
          expired.push({ key, retainedAt: receipt.retainedAt });
        }
      }
      expired.sort((left, right) =>
        left.retainedAt.localeCompare(right.retainedAt)
        || left.key.localeCompare(right.key));
      const remove = database.prepare("DELETE FROM index_metadata WHERE key = ?");
      for (const candidate of expired) {
        if (retainedCount <= CAPTURE_RECEIPT_LOW_WATERMARK) break;
        const result = remove.run(candidate.key);
        if (Number(result.changes) !== 1) {
          throw new MemoryLocalError(
            "corrupt_store",
            "Memory capture receipt changed during bounded eviction.",
          );
        }
        retainedCount -= 1;
      }
    }

    if (retainedCount >= MAX_CAPTURE_RECEIPTS) {
      throw new MemoryLocalError(
        "capacity_exceeded",
        "Memory capture receipt capacity is exhausted by retained receipts.",
      );
    }

    database.prepare(
      "INSERT INTO index_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    ).run(request.intakeKey, request.intakeValue);
    const intakeValue = getMetadata(database, request.intakeKey);
    if (intakeValue === undefined) {
      throw new MemoryLocalError(
        "corrupt_store",
        "Memory capture intake reservation was not durable.",
      );
    }
    database.exec("COMMIT");
    return Object.freeze({ intakeValue });
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function assertCaptureReceiptIntegrity(
  database: DatabaseSync,
  retention?: {
    readonly retainedAt: string;
    readonly retentionDays: number;
  },
  scanLimit = MAX_CAPTURE_RECEIPT_SCAN_ROWS,
): void {
  const now = retention === undefined
    ? undefined
    : receiptTimestampMillis(retention.retainedAt);
  const record = database.prepare("SELECT 1 AS present FROM memories WHERE id = ?");
  for (const { value } of captureReceiptRows(database, scanLimit)) {
    const receipt = parseCaptureReceipt(value);
    if (
      retention !== undefined
      && receipt.version === 2
      && captureReceiptExpired(receipt, now!, retention.retentionDays)
    ) {
      continue;
    }
    for (const recordId of new Set(receipt.recordIds)) {
      if (record.get(recordId) === undefined) {
        throw new MemoryLocalError(
          "corrupt_store",
          "Memory capture receipt points to a missing canonical record.",
        );
      }
    }
  }
}

export function vectorIntakeKey(id: string): string {
  return `memory-local:vector-intake:${digestKey(id)}`;
}

function vectorIntakeValue(recordId: string): string {
  return JSON.stringify({ version: 1, recordId });
}

function forgetCaptureReceiptReferences(
  database: DatabaseSync,
  recordId: string,
  retainedAt: string,
): void {
  const update = database.prepare("UPDATE index_metadata SET value = ? WHERE key = ?");
  for (const { key, value } of captureReceiptRows(database)) {
    const receipt = parseCaptureReceipt(value);
    const recordIds = receipt.recordIds.filter((candidate) => candidate !== recordId);
    if (recordIds.length === receipt.recordIds.length) continue;
    const result = update.run(canonicalJson(receipt.version === 1
      ? {
        recordIds,
        sourceHash: receipt.sourceHash,
        version: 1,
      }
      : {
        recordIds,
        retainedAt,
        sourceHash: receipt.sourceHash,
        version: 2,
      }), key);
    if (Number(result.changes) !== 1) {
      throw new MemoryLocalError(
        "corrupt_store",
        "Memory capture receipt changed during forgetting.",
      );
    }
  }
}

function captureReceiptRows(
  database: DatabaseSync,
  scanLimit = MAX_CAPTURE_RECEIPT_SCAN_ROWS,
): Iterable<{ readonly key: string; readonly value: string }> {
  const preflight = database.prepare(`
    SELECT
      COUNT(*) AS receipt_count,
      COALESCE(SUM(
        CASE
          WHEN typeof(key) != 'text'
            OR typeof(value) != 'text'
            OR LENGTH(CAST(key AS BLOB)) > 371
            OR LENGTH(CAST(value AS BLOB)) > ?
          THEN 1
          ELSE 0
        END
      ), 0) AS invalid_count
    FROM index_metadata
    WHERE key GLOB ?
  `).get(MAX_CAPTURE_RECEIPT_BYTES, CAPTURE_RECEIPT_GLOB) as unknown as {
    receipt_count: number;
    invalid_count: number;
  };
  const count = number(preflight.receipt_count, "capture receipt count");
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 0 || count > scanLimit) {
    throw new MemoryLocalError(
      "capacity_exceeded",
      "Memory capture receipt count exceeds the bounded integrity scan limit.",
    );
  }
  if (number(preflight.invalid_count, "invalid capture receipt storage count") !== 0) {
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory capture receipt storage is invalid.",
    );
  }
  const page = database.prepare(`
    SELECT key, value
    FROM index_metadata
    WHERE key GLOB ? AND key > ?
    ORDER BY key
    LIMIT ?
  `);
  return {
    *[Symbol.iterator]() {
      let after = "";
      while (true) {
        const rows = page.all(
          CAPTURE_RECEIPT_GLOB,
          after,
          CAPTURE_RECEIPT_PAGE_SIZE,
        ) as unknown as { key: unknown; value: unknown }[];
        if (rows.length === 0) return;
        for (const row of rows) {
          if (
            typeof row.key !== "string"
            || !validCaptureReceiptKey(row.key)
            || typeof row.value !== "string"
          ) {
            throw new MemoryLocalError(
              "corrupt_store",
              "Memory capture receipt storage is invalid.",
            );
          }
          yield { key: row.key, value: row.value };
        }
        after = rows.at(-1)!.key as string;
      }
    },
  };
}

export function parseCaptureReceipt(value: string): CaptureReceipt {
  if (Buffer.byteLength(value, "utf8") > MAX_CAPTURE_RECEIPT_BYTES) {
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory capture receipt exceeds its byte bound.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MemoryLocalError("corrupt_store", "Memory capture receipt is malformed.");
  }
  if (
    !isPlainObject(parsed)
    || typeof parsed.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(parsed.sourceHash)
    || !Array.isArray(parsed.recordIds)
    || parsed.recordIds.length > DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS
    || parsed.recordIds.some((id) => typeof id !== "string" || !MEMORY_RECORD_ID.test(id))
  ) {
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory capture receipt has invalid bounded fields.",
    );
  }
  const recordIds = Object.freeze([...(parsed.recordIds as string[])]);
  if (
    parsed.version === 1
    && Object.keys(parsed).sort().join(",") === "recordIds,sourceHash,version"
  ) {
    return Object.freeze({
      version: 1,
      sourceHash: parsed.sourceHash,
      recordIds,
    });
  }
  if (
    parsed.version === 2
    && Object.keys(parsed).sort().join(",") === "recordIds,retainedAt,sourceHash,version"
    && typeof parsed.retainedAt === "string"
  ) {
    receiptTimestampMillis(parsed.retainedAt);
    return Object.freeze({
      version: 2,
      sourceHash: parsed.sourceHash,
      recordIds,
      retainedAt: parsed.retainedAt,
    });
  }
  throw new MemoryLocalError(
    "corrupt_store",
    "Memory capture receipt has invalid bounded fields.",
  );
}

export function captureReceiptCount(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM index_metadata
    WHERE key GLOB ?
  `).get(CAPTURE_RECEIPT_GLOB) as unknown as { count: number };
  return number(row.count, "capture receipt count");
}

function captureReceiptExpired(
  receipt: CaptureReceipt,
  now: number,
  retentionDays: number,
): boolean {
  if (receipt.version === 1) return false;
  if (
    !Number.isSafeInteger(retentionDays)
    || retentionDays < 1
    || retentionDays > 3_650
  ) {
    throw new MemoryLocalError("corrupt_store", "Memory capture receipt retention is invalid.");
  }
  return now - receiptTimestampMillis(receipt.retainedAt)
    >= retentionDays * MILLISECONDS_PER_DAY;
}

function receiptTimestampMillis(value: string): number {
  if (!CANONICAL_RECEIPT_TIMESTAMP.test(value)) {
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory capture receipt retention timestamp is invalid.",
    );
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory capture receipt retention timestamp is invalid.",
    );
  }
  return millis;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validCaptureReceiptKey(value: string): boolean {
  if (!CAPTURE_RECEIPT_KEY.test(value)) return false;
  const encoded = value.slice(CAPTURE_RECEIPT_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return MEMORY_RECORD_ID.test(decoded)
    && Buffer.from(decoded, "utf8").toString("base64url") === encoded;
}

export function ftsMatchExpression(value: string): string {
  const tokens = value.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)].slice(0, 64).map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" OR ");
}

export function recordLimits(_config: MemoryLocalConfig): {
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly maxTextBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxRecallResults: number;
} {
  return {
    maxRecords: DEFAULT_CAPACITY.maxRecords,
    maxTotalBytes: DEFAULT_CAPACITY.maxTotalBytes,
    maxTextBytes: DEFAULT_CAPACITY.maxTextBytes,
    maxMetadataBytes: DEFAULT_CAPACITY.maxMetadataBytes,
    maxRecallResults: DEFAULT_CAPACITY.maxRecallResults,
  };
}

function memoryFields(metadata: JsonObject | undefined): {
  readonly type: "task" | "event" | "note";
  readonly status: "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated";
  readonly salience: number;
  readonly isInsight: boolean;
  readonly tags: readonly string[];
  readonly conversationId?: string;
  readonly collection?: string;
} {
  const type = MEMORY_TYPES.includes(metadata?.memoryType as never)
    ? metadata!.memoryType as "task" | "event" | "note"
    : "note";
  const status = MEMORY_STATUSES.includes(metadata?.memoryStatus as never)
    ? metadata!.memoryStatus as "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated"
    : "open";
  const salience = typeof metadata?.salience === "number"
    && Number.isFinite(metadata.salience)
    && metadata.salience >= 0
    && metadata.salience <= 1
    ? metadata.salience
    : 0.5;
  const rawTags = metadata?.tags;
  const tags = Array.isArray(rawTags)
    && rawTags.length <= 256
    && rawTags.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 256)
    ? Object.freeze([...rawTags] as string[])
    : Object.freeze([] as string[]);
  return Object.freeze({
    type,
    status,
    salience,
    isInsight: metadata?.isInsight === true,
    tags,
    ...(typeof metadata?.conversationId === "string" ? { conversationId: metadata.conversationId } : {}),
    ...(typeof metadata?.collection === "string" ? { collection: metadata.collection } : {}),
  });
}

function recordHashKey(id: string): string {
  return `memory-local:record-hash:${digestKey(id)}`;
}

function digestKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function corruptRow(): never {
  throw new MemoryLocalError("corrupt_store", "Stored BuJo memory row is invalid.");
}

function number(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MemoryLocalError("corrupt_store", `Memory ${label} is invalid.`);
  }
  return result;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function safeSqliteCause(error: unknown): Error {
  const code = typeof error === "object" && error !== null
    && Object.getOwnPropertyDescriptor(error, "code")?.value;
  return new Error(typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? `SQLite error ${code}`
    : "SQLite operation failed");
}

const DEFAULT_CAPACITY = Object.freeze({
  maxRecords: 100_000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxTextBytes: 64 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxRecallResults: 50,
});

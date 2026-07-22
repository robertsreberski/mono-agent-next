import { MEMORY_STATUSES, MEMORY_TYPES } from "./types.js";

export const REPLAY_LIFECYCLE_STATE_INDEX = "idx_memories_replay_projection_state";
export const REPLAY_EDGE_STATE_INDEX = "idx_edges_replay_projection_state";

/**
 * SQLite schema-evolution contract:
 *
 * - `CREATE ... IF NOT EXISTS` is safe for appending a new table or index.
 * - Never add a column by editing an existing create statement alone: SQLite
 *   leaves every existing `memory.db` unchanged in that case.
 * - Add explicit, idempotent open-time migration work for an existing table
 *   before changing its fresh-database definition. Because SQLite appends an
 *   added column, append it at the end of that create statement too so fresh
 *   and upgraded databases retain the same column order.
 * - Keep the cumulative-schema regression in `schema-evolution.test.ts` green.
 *
 * `${dim}` is substituted with the configured vector dimension.
 */
export function migrations(dim: number): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN (${sqlStringList(MEMORY_TYPES)})),
      status TEXT NOT NULL CHECK(status IN (${sqlStringList(MEMORY_STATUSES)})),
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
    )`,
    `CREATE TABLE IF NOT EXISTS edges (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('thread','about','supports','supersedes')),
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(src, dst, kind)
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_due ON memories(due_at)`,
    `CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS entity_relations (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(src, dst, relation)
    )`,
    `CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(memory_id, entity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id)`,
    `CREATE TABLE IF NOT EXISTS content_hashes (
      content_hash TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      source_file TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${REPLAY_LIFECYCLE_STATE_INDEX} ON memories(id)
      WHERE valid_to IS NOT NULL OR superseded_by IS NOT NULL OR superseded_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${REPLAY_EDGE_STATE_INDEX} ON edges(kind)
      WHERE kind IN ('thread','supersedes')`,
  ];
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

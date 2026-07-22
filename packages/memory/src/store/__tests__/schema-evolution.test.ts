import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { loadVec } from "../vec.js";

const DIMENSION = 8;

/**
 * Cumulative baseline from the released schema before explicit column
 * migrations existed.
 *
 * Never regenerate or edit an existing statement to make a schema-shape
 * failure green. Append only a brand-new table's initial CREATE here in the
 * same change that introduces it; never append ALTER, DROP, or table-rebuild
 * migration work. The inventory assertion makes that step mandatory so a
 * later inline-only column edit on the new table cannot escape this fixture.
 * A new column on an existing table must first make this baseline converge
 * through explicit migration work, or change this test to assert a deliberate
 * schema-specific rejection. Silent divergence is never accepted.
 *
 * This is intentionally an add-only shape and repeat-open guard. A deliberate
 * table rename/drop needs its own migration contract and a reviewed change to
 * this guard. Each real migration also needs a focused test that seeds and
 * verifies its data; equal empty schemas alone do not prove data preservation.
 */
const CUMULATIVE_SCHEMA_BASELINE_DDL = [
  `CREATE TABLE IF NOT EXISTS memories (
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
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${DIMENSION}] distance_metric=cosine)`,
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
] as const;

interface ColumnShape {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
  readonly hidden: number;
}

interface TableShape {
  readonly name: string;
  readonly columns: readonly ColumnShape[];
}

function withRawDb<T>(path: string, callback: (db: Database) => T): T {
  const db = new BetterSqlite3(path);
  try {
    loadVec(db);
    return callback(db);
  } finally {
    db.close();
  }
}

function seedSchemaBaseline(path: string): void {
  withRawDb(path, (db) => {
    for (const statement of CUMULATIVE_SCHEMA_BASELINE_DDL) db.exec(statement);
  });
}

function readSchemaShape(path: string): { readonly userVersion: number; readonly tables: readonly TableShape[] } {
  return withRawDb(path, (db) => {
    const names = db.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ readonly name: string }>;
    return {
      userVersion: Number(db.pragma("user_version", { simple: true })),
      tables: names.map(({ name }) => ({
        name,
        columns: db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).all() as ColumnShape[],
      })),
    };
  });
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe("memory schema evolution", () => {
  it("represents every table, converges on first open, and remains idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-schema-evolution-"));
    const baselinePath = join(root, "baseline.db");
    const freshPath = join(root, "fresh.db");
    seedSchemaBaseline(baselinePath);

    const fresh = openMemoryDb({ path: freshPath, dim: DIMENSION });
    fresh.close();
    const freshShape = readSchemaShape(freshPath);
    const representedTableNames = readSchemaShape(baselinePath).tables.map(({ name }) => name);
    expect(representedTableNames).toEqual(freshShape.tables.map(({ name }) => name));

    const upgraded = openMemoryDb({ path: baselinePath, dim: DIMENSION });
    upgraded.close();
    const upgradedShape = readSchemaShape(baselinePath);
    expect(upgradedShape).toEqual(freshShape);

    const reopened = openMemoryDb({ path: baselinePath, dim: DIMENSION });
    reopened.close();
    expect(readSchemaShape(baselinePath)).toEqual(upgradedShape);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { REPLAY_PROJECTION_STATE_PROBE_SQL } from "../db-graph.js";
import { openMemoryDb } from "../db.js";
import {
  REPLAY_EDGE_STATE_INDEX,
  REPLAY_LIFECYCLE_STATE_INDEX,
} from "../schema.js";
import type { MemoryRecord } from "../types.js";

const OLD_AT = "2026-06-01T00:00:00.000Z";
const REPLACED_AT = "2026-06-02T00:00:00.000Z";
const TERMINAL_AT = "2026-06-03T00:00:00.000Z";

function sqliteConnection(db: ReturnType<typeof openMemoryDb>): BetterSqlite3.Database {
  return (db as unknown as { readonly db: BetterSqlite3.Database }).db;
}

function memory(id: string, status: MemoryRecord["status"], createdAt = OLD_AT): MemoryRecord {
  return {
    id,
    type: "note",
    status,
    text: `memory ${id}`,
    salience: 0.5,
    isInsight: false,
    createdAt,
    accessCount: 0,
    tags: [],
    source: {},
  };
}

describe("MemoryDb replay projection replacement", () => {
  it("replaces only replay-owned lifecycle and edges, preserves graph/telemetry, and is a no-op when exact", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("old", "invalidated"));
    db.upsertLexical(memory("new", "open", REPLACED_AT));
    db.upsertLexical(memory("terminal", "dropped"));
    db.addEdge("old", "collection:one", "supports", 1, OLD_AT);
    db.addEdge("old", "entity:one", "about", 0.8, OLD_AT);
    db.recordAccess(["old"], new Date(TERMINAL_AT));

    const projection = {
      terminals: [{ id: "terminal", at: TERMINAL_AT }],
      supersedes: [{ src: "old", dst: "new", at: REPLACED_AT }],
      threads: [{ src: "new", dst: "terminal", weight: 0.75, at: TERMINAL_AT }],
    } as const;
    expect(db.replaceReplayProjection(projection)).toBe(true);
    expect(db.replaceReplayProjection(projection)).toBe(false);

    expect(db.get("old")).toMatchObject({
      status: "invalidated",
      supersededBy: "new",
      supersededAt: REPLACED_AT,
      validTo: REPLACED_AT,
      accessCount: 1,
    });
    expect(db.get("terminal")?.validTo).toBe(TERMINAL_AT);
    expect(db.allEdges()).toEqual(expect.arrayContaining([
      { src: "old", dst: "new", kind: "supersedes", weight: 1, createdAt: REPLACED_AT },
      { src: "new", dst: "terminal", kind: "thread", weight: 0.75, createdAt: TERMINAL_AT },
      { src: "old", dst: "collection:one", kind: "supports", weight: 1, createdAt: OLD_AT },
      { src: "old", dst: "entity:one", kind: "about", weight: 0.8, createdAt: OLD_AT },
    ]));

    expect(db.replaceReplayProjection({ terminals: [], supersedes: [], threads: [] })).toBe(true);
    expect(db.get("old")).toMatchObject({ status: "invalidated", accessCount: 1 });
    expect(db.get("old")?.validTo).toBeUndefined();
    expect(db.get("terminal")?.validTo).toBeUndefined();
    expect(db.allEdges().filter((edge) => edge.kind === "thread" || edge.kind === "supersedes")).toEqual([]);
    expect(db.allEdges().filter((edge) => edge.kind === "supports" || edge.kind === "about")).toHaveLength(2);
    db.close();
  });

  it("allows a supersede destination to be forgotten later", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("a", "invalidated"));
    db.upsertLexical(memory("b", "dropped", REPLACED_AT));

    expect(db.replaceReplayProjection({
      terminals: [{ id: "b", at: TERMINAL_AT }],
      supersedes: [{ src: "a", dst: "b", at: REPLACED_AT }],
      threads: [],
    })).toBe(true);
    expect(db.get("a")).toMatchObject({ supersededBy: "b", validTo: REPLACED_AT });
    expect(db.get("b")).toMatchObject({ status: "dropped", validTo: TERMINAL_AT });
    expect(db.replaceReplayProjection({
      terminals: [{ id: "b", at: TERMINAL_AT }],
      supersedes: [{ src: "a", dst: "b", at: REPLACED_AT }],
      threads: [],
    })).toBe(false);
    db.close();
  });

  it("rejects invalid topology before changing the existing projection", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("a", "invalidated"));
    db.upsertLexical(memory("b", "invalidated", REPLACED_AT));
    db.upsertLexical(memory("c", "open", TERMINAL_AT));
    const valid = {
      terminals: [],
      supersedes: [{ src: "b", dst: "c", at: TERMINAL_AT }],
      threads: [],
    } as const;
    db.replaceReplayProjection(valid);
    const before = db.replayProjectionSnapshot();

    expect(() => db.replaceReplayProjection({
      terminals: [],
      supersedes: [
        { src: "a", dst: "b", at: REPLACED_AT },
        { src: "b", dst: "a", at: TERMINAL_AT },
      ],
      threads: [],
    })).toThrow(/cycle|destination|endpoint/iu);
    expect(db.replayProjectionSnapshot()).toEqual(before);
    db.close();
  });

  it("distinguishes replay-owned lifecycle and edges from ordinary status and graph state", () => {
    const ordinary = openMemoryDb({ path: ":memory:" });
    ordinary.upsertLexical(memory("dropped", "dropped"));
    ordinary.upsertLexical(memory("invalidated", "invalidated"));
    ordinary.addEdge("dropped", "entity:one", "about", 0.8, OLD_AT);
    ordinary.addEdge("invalidated", "collection:one", "supports", 1, OLD_AT);
    expect(ordinary.hasReplayProjectionState()).toBe(false);
    ordinary.close();

    const cases: ReadonlyArray<readonly [string, (db: ReturnType<typeof openMemoryDb>) => void]> = [
      ["validTo", (db) => db.upsertLexical({ ...memory("subject", "open"), validTo: TERMINAL_AT })],
      ["supersededBy", (db) => db.upsertLexical({ ...memory("subject", "open"), supersededBy: "replacement" })],
      ["supersededAt", (db) => db.upsertLexical({ ...memory("subject", "open"), supersededAt: REPLACED_AT })],
      ["complete supersession", (db) => db.upsertLexical({
        ...memory("subject", "invalidated"),
        validTo: REPLACED_AT,
        supersededBy: "replacement",
        supersededAt: REPLACED_AT,
      })],
      ["thread edge", (db) => db.addEdge("subject", "target", "thread", 0.8, REPLACED_AT)],
      ["supersedes edge", (db) => db.addEdge("subject", "target", "supersedes", 1, REPLACED_AT)],
    ];
    for (const [, seed] of cases) {
      const db = openMemoryDb({ path: ":memory:" });
      seed(db);
      expect(db.hasReplayProjectionState()).toBe(true);
      db.close();
    }
  });

  it("keeps the absence probe on replay-only partial indexes as ordinary rows scale", () => {
    const root = mkdtempSync(join(tmpdir(), "mono-agent-replay-probe-"));
    const path = join(root, "memory.db");
    const db = openMemoryDb({ path });
    const raw = new BetterSqlite3(path);
    try {
      const definitions = new Map((raw.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)`,
      ).all(REPLAY_LIFECYCLE_STATE_INDEX, REPLAY_EDGE_STATE_INDEX) as Array<{
        name: string;
        sql: string;
      }>).map((row) => [row.name, row.sql] as const));
      expect(definitions.get(REPLAY_LIFECYCLE_STATE_INDEX)).toMatch(
        /WHERE valid_to IS NOT NULL OR superseded_by IS NOT NULL OR superseded_at IS NOT NULL/u,
      );
      expect(definitions.get(REPLAY_EDGE_STATE_INDEX)).toMatch(
        /WHERE kind IN \('thread','supersedes'\)/u,
      );
      const memoryIndexes = raw.prepare(`PRAGMA index_list('memories')`).all() as Array<{
        name: string;
        partial: number;
      }>;
      const edgeIndexes = raw.prepare(`PRAGMA index_list('edges')`).all() as Array<{
        name: string;
        partial: number;
      }>;
      expect(memoryIndexes.find((index) => index.name === REPLAY_LIFECYCLE_STATE_INDEX)?.partial).toBe(1);
      expect(edgeIndexes.find((index) => index.name === REPLAY_EDGE_STATE_INDEX)?.partial).toBe(1);

      const insertMemory = raw.prepare(
        `INSERT INTO memories (
          id, seq, type, status, text, salience, is_insight, created_at, access_count, tags
        ) VALUES (?, ?, 'note', 'open', ?, 0.5, 0, ?, 0, '[]')`,
      );
      const insertEdge = raw.prepare(
        `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, 1, ?)`,
      );
      const growTo = raw.transaction((start: number, end: number) => {
        for (let index = start; index < end; index += 1) {
          const id = `ordinary-${index}`;
          insertMemory.run(id, index + 1, `ordinary memory ${index}`, OLD_AT);
          insertEdge.run(id, `graph:${index}`, index % 2 === 0 ? "supports" : "about", OLD_AT);
        }
      });

      const plans: string[] = [];
      let populated = 0;
      const prepare = vi.spyOn(sqliteConnection(db), "prepare");
      try {
        for (const size of [0, 300, 1_000]) {
          growTo(populated, size);
          populated = size;
          const callsBeforeProbe = prepare.mock.calls.length;
          expect(db.hasReplayProjectionState()).toBe(false);
          const probeCalls = prepare.mock.calls.slice(callsBeforeProbe);
          expect(probeCalls).toHaveLength(1);
          const executedSql = probeCalls[0]?.[0];
          expect(executedSql).toBe(REPLAY_PROJECTION_STATE_PROBE_SQL);
          expect(executedSql?.match(/\bEXISTS\s*\(/gu)).toHaveLength(2);
          expect(executedSql?.match(/\bLIMIT 1\b/gu)).toHaveLength(2);
          expect(executedSql).toContain(`INDEXED BY ${REPLAY_LIFECYCLE_STATE_INDEX}`);
          expect(executedSql).toContain(`INDEXED BY ${REPLAY_EDGE_STATE_INDEX}`);
          const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${executedSql}`).all() as Array<{
            detail: string;
          }>).map((row) => row.detail).join("\n");
          expect(plan).toContain(REPLAY_LIFECYCLE_STATE_INDEX);
          expect(plan).toContain(REPLAY_EDGE_STATE_INDEX);
          expect((raw.prepare(
            `SELECT COUNT(*) AS count FROM memories INDEXED BY ${REPLAY_LIFECYCLE_STATE_INDEX}
             WHERE valid_to IS NOT NULL OR superseded_by IS NOT NULL OR superseded_at IS NOT NULL`,
          ).get() as { count: number }).count).toBe(0);
          expect((raw.prepare(
            `SELECT COUNT(*) AS count FROM edges INDEXED BY ${REPLAY_EDGE_STATE_INDEX}
             WHERE kind IN ('thread','supersedes')`,
          ).get() as { count: number }).count).toBe(0);
          plans.push(plan);
        }
      } finally {
        prepare.mockRestore();
      }
      expect(new Set(plans).size).toBe(1);

      raw.prepare(`UPDATE memories SET valid_to = ? WHERE id = 'ordinary-0'`).run(TERMINAL_AT);
      expect(db.hasReplayProjectionState()).toBe(true);
      expect((raw.prepare(
        `SELECT COUNT(*) AS count FROM memories INDEXED BY ${REPLAY_LIFECYCLE_STATE_INDEX}
         WHERE valid_to IS NOT NULL OR superseded_by IS NOT NULL OR superseded_at IS NOT NULL`,
      ).get() as { count: number }).count).toBe(1);
      raw.prepare(`UPDATE memories SET valid_to = NULL WHERE id = 'ordinary-0'`).run();

      raw.prepare(
        `INSERT INTO edges (src, dst, kind, weight, created_at)
         VALUES ('ordinary-0', 'ordinary-1', 'thread', 0.8, ?)`,
      ).run(REPLACED_AT);
      expect(db.hasReplayProjectionState()).toBe(true);
      expect((raw.prepare(
        `SELECT COUNT(*) AS count FROM edges INDEXED BY ${REPLAY_EDGE_STATE_INDEX}
         WHERE kind IN ('thread','supersedes')`,
      ).get() as { count: number }).count).toBe(1);
    } finally {
      raw.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Tests for the FTS-only (no embeddings) path.
 * Opening `openMemoryDb` with no `embeddings` and no `dim` should work:
 * - upsert writes memories + FTS rows
 * - recall returns keyword matches (no throw)
 * - findSimilar returns []
 * - dueItems / upsertEntity+getEntity still work
 */
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import type { MemoryRecord } from "../types.js";

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    type: "note",
    status: "open",
    text: "alpha is a keyword we search for",
    salience: 0.7,
    isInsight: false,
    createdAt: "2026-06-16T08:00:00.000Z",
    accessCount: 0,
    tags: [],
    source: {},
    ...over,
  };
}

describe("no-embeddings (FTS-only) path", () => {
  it("opens without embeddings or dim (defaults to 768 vec table DDL)", () => {
    const db = openMemoryDb({ path: ":memory:" });
    expect(db.count()).toBe(0);
    db.close();
  });

  it("opens without embeddings but with an explicit dim", () => {
    const db = openMemoryDb({ path: ":memory:", dim: 64 });
    expect(db.count()).toBe(0);
    db.close();
  });

  it("rejects a non-positive dim", () => {
    expect(() => openMemoryDb({ path: ":memory:", dim: 0 })).toThrow();
    expect(() => openMemoryDb({ path: ":memory:", dim: -1 })).toThrow();
  });

  it("rejects a non-integer dim", () => {
    expect(() => openMemoryDb({ path: ":memory:", dim: 1.5 })).toThrow();
  });

  it("upserts memories without throwing", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(record({ id: "a1", text: "alpha is a keyword we search for" }));
    await db.upsert(record({ id: "b1", text: "beta topic about something else" }));
    await db.upsert(record({ id: "c1", text: "gamma another unrelated note" }));
    expect(db.count()).toBe(3);
    db.close();
  });

  it("recall returns the FTS-matching memory (keyword-only, no throw)", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(record({ id: "a1", text: "alpha is a keyword we search for" }));
    await db.upsert(record({ id: "b1", text: "beta topic about something else" }));
    await db.upsert(record({ id: "c1", text: "gamma another unrelated note" }));

    const hits = await db.recall("alpha");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.record.id).toBe("a1");
    db.close();
  });

  it("recall returns [] for a query that matches nothing (no throw)", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(record({ id: "a1", text: "alpha is a keyword we search for" }));

    const hits = await db.recall("zzznomatch");
    expect(hits).toEqual([]);
    db.close();
  });

  it("findSimilar returns [] when no embeddings", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(record({ id: "a1", text: "alpha is a keyword we search for" }));

    const similar = await db.findSimilar("alpha");
    expect(similar).toEqual([]);
    db.close();
  });

  it("dueItems works without embeddings", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(
      record({ id: "d1", text: "something due", status: "scheduled", dueAt: "2026-06-15T00:00:00.000Z" }),
    );
    const due = db.dueItems(new Date("2026-06-16T00:00:00.000Z"));
    expect(due.length).toBe(1);
    expect(due[0]?.id).toBe("d1");
    db.close();
  });

  it("upsertEntity + getEntity work without embeddings", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertEntity({
      id: "person:alice",
      name: "Alice",
      type: "person",
      createdAt: "2026-06-16T08:00:00.000Z",
    });
    const entity = db.getEntity("person:alice");
    expect(entity?.name).toBe("Alice");
    expect(entity?.type).toBe("person");
    db.close();
  });
});

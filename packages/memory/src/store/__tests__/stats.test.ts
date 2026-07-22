import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../index.js";
import type { MemoryRecord, MemoryStoreStats } from "../index.js";

function record(over: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    type: "note",
    status: "open",
    text: `Memory ${over.id}`,
    salience: 0.5,
    isInsight: false,
    createdAt: "2026-06-15T12:00:00.000Z",
    accessCount: 0,
    tags: [],
    source: {},
    ...over,
  };
}

describe("stats", () => {
  it("returns read-only memory counts, latest memories, and top entities", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(record({
      id: "m-open",
      type: "note",
      status: "open",
      createdAt: "2026-06-14T00:00:00.000Z",
      lastAccessedAt: "2026-06-16T00:00:00.000Z",
      accessCount: 4,
    }));
    await db.upsert(record({
      id: "m-done",
      type: "task",
      status: "done",
      createdAt: "2026-06-19T00:00:00.000Z",
    }));
    await db.upsert(record({
      id: "m-scheduled",
      type: "event",
      status: "scheduled",
      createdAt: "2026-06-13T00:00:00.000Z",
      lastAccessedAt: "2026-06-18T00:00:00.000Z",
      accessCount: 2,
    }));
    await db.upsert(record({
      id: "m-migrated",
      type: "note",
      status: "migrated",
      createdAt: "2026-06-15T00:00:00.000Z",
    }));
    await db.upsert(record({
      id: "m-dropped",
      type: "note",
      status: "dropped",
      createdAt: "2026-06-12T00:00:00.000Z",
    }));
    await db.upsert(record({
      id: "m-invalidated",
      type: "task",
      status: "invalidated",
      createdAt: "2026-06-11T00:00:00.000Z",
    }));

    db.upsertEntity({
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      summary: "Prefers explicit memory controls.",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
    db.upsertEntity({
      id: "project:mono-agent",
      name: "mono-agent",
      type: "project",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    });
    db.upsertEntity({
      id: "concept:bujo",
      name: "BuJo",
      type: "concept",
      summary: "Local journal-backed memory.",
      createdAt: "2026-06-12T00:00:00.000Z",
    });

    const stats: MemoryStoreStats = db.stats({ topEntitiesLimit: 2 });

    expect(stats.totalMemories).toBe(6);
    expect(stats.liveMemories).toBe(4);
    expect(stats.countsByStatus).toEqual({
      open: 1,
      done: 1,
      scheduled: 1,
      migrated: 1,
      dropped: 1,
      invalidated: 1,
    });
    expect(stats.countsByType).toEqual({ task: 2, event: 1, note: 3 });
    expect(stats.latestCreatedMemory?.id).toBe("m-done");
    expect(stats.latestAccessedMemory?.id).toBe("m-scheduled");
    expect(stats.topEntities.map((entity) => entity.id)).toEqual(["project:mono-agent", "person:morgan"]);
    expect(stats.topEntities[1]).toMatchObject({
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      summary: "Prefers explicit memory controls.",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    });

    expect(db.get("m-open")).toMatchObject({
      accessCount: 4,
      lastAccessedAt: "2026-06-16T00:00:00.000Z",
    });
    expect(db.get("m-done")?.accessCount).toBe(0);
    expect(db.get("m-done")?.lastAccessedAt).toBeUndefined();
    db.close();
  });

  it("returns deterministic empty stats", () => {
    const db = openMemoryDb({ path: ":memory:" });

    const stats = db.stats({ topEntitiesLimit: 0 });

    expect(stats.totalMemories).toBe(0);
    expect(stats.liveMemories).toBe(0);
    expect(stats.countsByStatus).toEqual({
      open: 0,
      done: 0,
      scheduled: 0,
      migrated: 0,
      dropped: 0,
      invalidated: 0,
    });
    expect(stats.countsByType).toEqual({ task: 0, event: 0, note: 0 });
    expect("latestCreatedMemory" in stats).toBe(false);
    expect("latestAccessedMemory" in stats).toBe(false);
    expect(stats.topEntities).toEqual([]);
    db.close();
  });

  it("rejects invalid top entity limits", () => {
    const db = openMemoryDb({ path: ":memory:" });
    expect(() => db.stats({ topEntitiesLimit: -1 })).toThrow(/topEntitiesLimit/u);
    expect(() => db.stats({ topEntitiesLimit: 1.5 })).toThrow(/topEntitiesLimit/u);
    db.close();
  });

  it("returns aggregate audit health without memory or entity content", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    await db.upsert(record({ id: "one", text: "private duplicate text", accessCount: 9 }));
    await db.upsert(record({ id: "two", text: "private duplicate text", accessCount: 1 }));
    await db.upsert(record({ id: "invalid", text: "retired private text", status: "invalidated", accessCount: 100 }));
    db.upsertEntity({ id: "person:private", name: "Private Person", createdAt: "2026-06-15T00:00:00.000Z" });

    const audit = db.audit();
    const serialized = JSON.stringify(audit);

    expect(audit).toMatchObject({
      counts: { total: 3, live: 2, entities: 1 },
      duplicates: { groups: 1, redundantRecords: 1, ratio: 0.5 },
      vectors: { indexed: 0, liveIndexed: 0, liveCoverage: 0 },
      access: { totalCount: 10, accessedMemories: 2, topOnePercentShare: 0.9 },
    });
    expect(serialized).not.toContain("private duplicate text");
    expect(serialized).not.toContain("Private Person");
    db.close();
  });
});

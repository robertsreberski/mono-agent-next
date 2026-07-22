import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

const DIM = 8;

function record(over: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    type: "note",
    status: "open",
    text: `Memory ${over.id}`,
    salience: 0.5,
    isInsight: false,
    createdAt: "2026-05-15T12:00:00.000Z",
    accessCount: 0,
    tags: [],
    source: {},
    ...over,
  };
}

// Fixed clock: June 15, 2026 noon UTC
const NOW = new Date("2026-06-15T12:00:00.000Z");

describe("dueItems", () => {
  it("returns open/scheduled memories with due_at <= now, soonest first", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    // Due yesterday — should appear first
    await db.upsert(record({ id: "due-yesterday", status: "open", dueAt: "2026-06-14T12:00:00.000Z", text: "Due yesterday" }));
    // Due this morning — should appear second
    await db.upsert(record({ id: "due-morning", status: "scheduled", dueAt: "2026-06-15T08:00:00.000Z", text: "Due morning" }));
    // Due exactly now — should appear
    await db.upsert(record({ id: "due-now", status: "open", dueAt: "2026-06-15T12:00:00.000Z", text: "Due now" }));
    // Due tomorrow — should NOT appear
    await db.upsert(record({ id: "due-tomorrow", status: "open", dueAt: "2026-06-16T00:00:00.000Z", text: "Due tomorrow" }));
    // Open, no due_at — should NOT appear
    await db.upsert(record({ id: "no-due", status: "open", text: "No due date" }));
    // Done with due_at in the past — should NOT appear (wrong status)
    await db.upsert(record({ id: "done-past", status: "done", dueAt: "2026-06-14T00:00:00.000Z", text: "Done past" }));
    // Dropped with past due — should NOT appear
    await db.upsert(record({ id: "dropped-past", status: "dropped", dueAt: "2026-06-13T00:00:00.000Z", text: "Dropped" }));

    const result = db.dueItems(NOW);

    const ids = result.map((r) => r.id);
    expect(ids).toContain("due-yesterday");
    expect(ids).toContain("due-morning");
    expect(ids).toContain("due-now");
    expect(ids).not.toContain("due-tomorrow");
    expect(ids).not.toContain("no-due");
    expect(ids).not.toContain("done-past");
    expect(ids).not.toContain("dropped-past");

    // Soonest first: yesterday before morning before now
    const idxYesterday = ids.indexOf("due-yesterday");
    const idxMorning = ids.indexOf("due-morning");
    const idxNow = ids.indexOf("due-now");
    expect(idxYesterday).toBeLessThan(idxMorning);
    expect(idxMorning).toBeLessThan(idxNow);

    db.close();
  });

  it("respects the limit parameter", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    for (let i = 0; i < 5; i += 1) {
      await db.upsert(record({ id: `m${i}`, status: "open", dueAt: `2026-06-14T0${i}:00:00.000Z`, text: `memory ${i}` }));
    }

    const result = db.dueItems(NOW, 3);
    expect(result).toHaveLength(3);

    db.close();
  });
});

describe("agingOpen", () => {
  it("returns old, low-salience, open memories ordered by salience ASC, created_at ASC", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    // Old + low salience — should appear
    await db.upsert(record({ id: "old-low-1", createdAt: "2026-04-10T12:00:00.000Z", salience: 0.3, text: "old low 1" }));
    await db.upsert(record({ id: "old-low-2", createdAt: "2026-04-20T12:00:00.000Z", salience: 0.2, text: "old low 2" }));
    // Old + exactly at maxSalience boundary (0.4) — should appear (<=)
    await db.upsert(record({ id: "old-boundary", createdAt: "2026-04-15T12:00:00.000Z", salience: 0.4, text: "old boundary" }));
    // Old + high salience — should NOT appear
    await db.upsert(record({ id: "old-high", createdAt: "2026-04-01T12:00:00.000Z", salience: 0.9, text: "old high salience" }));
    // Recent + low salience — should NOT appear (not old enough, olderThan = June 15 - 30d = May 16)
    await db.upsert(record({ id: "recent-low", createdAt: "2026-06-10T12:00:00.000Z", salience: 0.1, text: "recent low" }));
    // Old + scheduled (non-open) — should NOT appear
    await db.upsert(record({ id: "old-scheduled", createdAt: "2026-04-01T12:00:00.000Z", salience: 0.1, status: "scheduled", text: "old scheduled" }));
    // Old + done — should NOT appear
    await db.upsert(record({ id: "old-done", createdAt: "2026-04-01T12:00:00.000Z", salience: 0.1, status: "done", text: "old done" }));

    const result = db.agingOpen(NOW, { olderThanDays: 30, maxSalience: 0.4 });

    const ids = result.map((r) => r.id);
    expect(ids).toContain("old-low-1");
    expect(ids).toContain("old-low-2");
    expect(ids).toContain("old-boundary");
    expect(ids).not.toContain("old-high");
    expect(ids).not.toContain("recent-low");
    expect(ids).not.toContain("old-scheduled");
    expect(ids).not.toContain("old-done");

    // Order: salience ASC first — old-low-2 (0.2) < old-low-1 (0.3) < old-boundary (0.4)
    const idxLow2 = ids.indexOf("old-low-2");
    const idxLow1 = ids.indexOf("old-low-1");
    const idxBoundary = ids.indexOf("old-boundary");
    expect(idxLow2).toBeLessThan(idxLow1);
    expect(idxLow1).toBeLessThan(idxBoundary);

    db.close();
  });

  it("uses default opts (olderThanDays=30, maxSalience=0.4, limit=50)", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    await db.upsert(record({ id: "old-low", createdAt: "2026-04-10T12:00:00.000Z", salience: 0.3, text: "old low default" }));
    await db.upsert(record({ id: "recent-low", createdAt: "2026-06-10T12:00:00.000Z", salience: 0.3, text: "recent low default" }));

    const result = db.agingOpen(NOW);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("old-low");
    expect(ids).not.toContain("recent-low");

    db.close();
  });
});

describe("topSalient", () => {
  it("returns highest-salience live memories, excluding invalidated/dropped, highest first", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    await db.upsert(record({ id: "high", salience: 0.9, text: "high salience" }));
    await db.upsert(record({ id: "mid", salience: 0.6, text: "mid salience" }));
    await db.upsert(record({ id: "low", salience: 0.2, text: "low salience" }));
    await db.upsert(record({ id: "dropped", salience: 0.95, status: "dropped", text: "dropped high" }));
    await db.upsert(record({ id: "invalidated", salience: 0.99, status: "invalidated", text: "invalidated high" }));
    // done/migrated/scheduled are live
    await db.upsert(record({ id: "done-high", salience: 0.85, status: "done", text: "done high" }));

    const result = db.topSalient(2);
    expect(result).toHaveLength(2);

    const ids = result.map((r) => r.id);
    // Top 2 live: "high" (0.9) and "done-high" (0.85)
    expect(ids[0]).toBe("high");
    expect(ids[1]).toBe("done-high");
    expect(ids).not.toContain("dropped");
    expect(ids).not.toContain("invalidated");

    db.close();
  });

  it("excludes invalidated and dropped regardless of salience", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    await db.upsert(record({ id: "inv", salience: 1.0, status: "invalidated", text: "should not appear" }));
    await db.upsert(record({ id: "drp", salience: 1.0, status: "dropped", text: "should not appear either" }));
    await db.upsert(record({ id: "live", salience: 0.1, text: "live low salience" }));

    const result = db.topSalient(10);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("live");
    expect(ids).not.toContain("inv");
    expect(ids).not.toContain("drp");

    db.close();
  });

  it("uses default limit of 20", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });

    for (let i = 0; i < 25; i += 1) {
      await db.upsert(record({ id: `m${i}`, salience: i / 100, text: `memory ${i}` }));
    }

    const result = db.topSalient();
    expect(result.length).toBeLessThanOrEqual(20);

    db.close();
  });
});

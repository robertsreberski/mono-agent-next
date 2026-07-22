import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {}, ...over };
}

describe("findSimilar", () => {
  it("returns nearest live memories by vector distance, closest first", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "morgan lives in lisbon"));
    await db.upsert(note("b", "the weather is sunny today"));
    await db.upsert(note("c", "morgan moved to lisbon last year"));
    const hits = await db.findSimilar("morgan lisbon home", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(["a", "c"]).toContain(hits[0]?.record.id); // a morgan/lisbon memory is nearest
    expect(hits[0]?.distance).toBeLessThanOrEqual(hits[hits.length - 1]?.distance ?? 1);
    db.close();
  });

  it("excludes invalidated/dropped memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("old", "morgan lisbon", { status: "invalidated" }));
    await db.upsert(note("live", "morgan lisbon"));
    const hits = await db.findSimilar("morgan lisbon", 5);
    expect(hits.map((h) => h.record.id)).toEqual(["live"]);
    db.close();
  });
});

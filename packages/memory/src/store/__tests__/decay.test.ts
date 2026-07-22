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
    salience: 0.8,
    isInsight: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    accessCount: 0,
    tags: [],
    source: {},
    ...over,
  };
}

describe("legacy salience repair", () => {
  it("CAS-repairs only legacy salience while preserving vectors, FTS, telemetry, and lifecycle", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    const vector = [1, ...new Array<number>(DIM - 1).fill(0)];
    const legacy = record({
      id: "legacy-salience",
      status: "invalidated",
      text: "Legacy salience repair sentinel",
      salience: 0.05,
      lastAccessedAt: "2026-06-14T12:00:00.000Z",
      accessCount: 7,
      validFrom: "2025-01-01T00:00:00.000Z",
      validTo: "2026-06-15T12:00:00.000Z",
      supersededBy: "replacement",
      supersededAt: "2026-06-15T12:00:00.000Z",
      dueAt: "2026-07-01T00:00:00.000Z",
      collection: "legacy",
      tags: ["preserved"],
      source: { session: "session-1", file: "2025-01-01.md", line: 4 },
      embeddingModel: `fake-${DIM}`,
      dim: DIM,
    });
    db.commitPreparedUpserts([legacy], [vector]);
    db.addEdge(legacy.id, "replacement", "supersedes", 1);
    const before = db.get(legacy.id)!;
    const edgesBefore = db.edges(legacy.id);

    db.repairLegacySalience(legacy.id, 0.05, 0.8);

    expect(db.get(legacy.id)).toEqual({ ...before, salience: 0.8 });
    expect(db.hasVector(legacy.id)).toBe(true);
    expect(db.edges(legacy.id)).toEqual(edgesBefore);
    expect(await db.recall("salience repair sentinel", {
      includeInvalid: true,
      trackAccess: false,
    })).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ id: legacy.id, salience: 0.8 }) }),
    ]);
    expect(() => db.repairLegacySalience(legacy.id, 0.05, 0.9)).toThrow(/compare-and-swap/iu);
    expect(db.get(legacy.id)).toEqual({ ...before, salience: 0.8 });
    db.close();
  });
});

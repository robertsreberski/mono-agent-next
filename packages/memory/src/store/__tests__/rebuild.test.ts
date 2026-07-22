import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("rebuild", () => {
  it("is deterministic — same records produce the same recall ordering and count", async () => {
    const records = [note("a", "cat sat"), note("b", "dog ran"), note("c", "cat napped")];
    const build = async () => {
      const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
      await db.rebuild(records);
      const ids = (await db.recall("cat", { topK: 3 })).map((h) => h.record.id);
      const count = db.count();
      db.close();
      return { ids, count };
    };
    const first = await build();
    const second = await build();
    expect(first.count).toBe(3);
    expect(second).toEqual(first);
  });
});

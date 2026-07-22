import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {}, ...over,
  };
}

describe("recall", () => {
  it("ranks the topically-matching memory first via hybrid search", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "the cat sat on the mat"));
    await db.upsert(note("b", "stock market crash wiped out savings"));
    await db.upsert(note("c", "a cat themed cafe downtown"));
    const hits = await db.recall("cat mat", { topK: 3 });
    expect(hits[0]?.record.id).toBe("a"); // shares both query tokens (cat, mat)
    expect(hits.map((h) => h.record.id)).toContain("c"); // shares one (cat); b shares none
    db.close();
  });

  it("excludes invalidated/dropped memories by default", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "cat one", { status: "invalidated" }));
    await db.upsert(note("b", "cat two", { status: "dropped" }));
    await db.upsert(note("c", "cat three"));
    const hits = await db.recall("cat", { topK: 5 });
    expect(hits.map((h) => h.record.id)).toEqual(["c"]);
    db.close();
  });

  it("bumps access_count and last_accessed_at on returned memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("a", "cat"));
    await db.recall("cat", { topK: 1 });
    const got = db.get("a");
    expect(got?.accessCount).toBe(1);
    expect(got?.lastAccessedAt).toBe("2026-06-16T00:00:00.000Z");
    db.close();
  });

  it("can recall without mutating access metadata", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("a", "cat"));
    const hits = await db.recall("cat", { topK: 1, trackAccess: false });
    const got = db.get("a");
    expect(hits[0]?.record.accessCount).toBe(0);
    expect(hits[0]?.record.lastAccessedAt).toBeUndefined();
    expect(got?.accessCount).toBe(0);
    expect(got?.lastAccessedAt).toBeUndefined();
    db.close();
  });

  it("keeps alternating query rankings stable regardless of access history", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("cats", "cats prefer quiet window seats", { accessCount: 900, lastAccessedAt: "2026-06-15T23:59:59.000Z" }));
    await db.upsert(note("deploy", "deploy pipeline uses blue green releases"));

    const before = (await db.recall("deploy pipeline", { topK: 1 })).at(0)?.record.id;
    for (let index = 0; index < 20; index += 1) {
      await db.recall(index % 2 === 0 ? "quiet window cats" : "deploy pipeline", { topK: 2 });
    }
    const after = (await db.recall("deploy pipeline", { topK: 1 })).at(0)?.record.id;

    expect(before).toBe("deploy");
    expect(after).toBe("deploy");
    db.close();
  });

  it("excludes memories whose validTo has passed, unless includeInvalid", async () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });
    await db.upsert(note("expired", "cat expired note", { validTo: "2026-01-01T00:00:00.000Z" }));
    await db.upsert(note("future", "cat future note", { validTo: "2026-12-31T00:00:00.000Z" }));
    expect((await db.recall("cat", { topK: 5 })).map((h) => h.record.id)).toEqual(["future"]);
    expect((await db.recall("cat", { topK: 5, includeInvalid: true })).map((h) => h.record.id).sort()).toEqual([
      "expired",
      "future",
    ]);
    db.close();
  });

  it("filters invalid candidates before the bounded FTS limit so they cannot crowd out a live answer", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (let index = 0; index < 250; index += 1) {
      await db.upsert(note(`stale-${String(index).padStart(3, "0")}`, "The release train now leaves on Tuesday.", {
        status: "invalidated",
      }));
    }
    await db.upsert(note("live-thursday", "The release train now leaves on Thursday."));

    const hits = await db.recall("When does the release train now leave?", {
      topK: 50,
      trackAccess: false,
    });

    expect(hits.map((hit) => hit.record.id)).toEqual(["live-thursday"]);
    db.close();
  });

  it("boundedly over-fetches vector-only candidates when stale nearest neighbours consume the KNN budget", async () => {
    const constantEmbeddings = {
      id: "constant-8",
      embed: async (texts: readonly string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
    };
    const db = openMemoryDb({ path: ":memory:", embeddings: constantEmbeddings, dim: 8 });
    for (let index = 0; index < 250; index += 1) {
      await db.upsert(note(`stale-vector-${String(index).padStart(3, "0")}`, "obsolete unrelated archive", {
        status: "invalidated",
      }));
    }
    await db.upsert(note("live-vector", "current semantic answer"));

    const hits = await db.recall("needle with no lexical overlap", {
      topK: 50,
      trackAccess: false,
    });

    expect(hits.map((hit) => hit.record.id)).toEqual(["live-vector"]);
    db.close();
  });
});

import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";

describe("entity repository", () => {
  it("upserts entities idempotently and reads them back", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", summary: "prefers opt-in memory", createdAt: "2026-06-15T09:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z" });
    expect(db.getEntity("person:morgan")).toMatchObject({ name: "Morgan", type: "person", summary: "prefers opt-in memory" });
    expect(db.countEntities()).toBe(1);
    db.close();
  });

  it("upsertEntity mirrors every column of the given record, including created_at and cleared summary", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      summary: "stale summary",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });
    // The DB is a dumb mirror of the canonical merged record (appendGraphBatch
    // output owns all field-preservation via mergeEntityRecord). A canonical record
    // that omits summary/updatedAt and carries a fresh createdAt overwrites every
    // column — the prior summary/createdAt/updatedAt are NOT preserved here.
    db.upsertEntity({
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      createdAt: "2026-07-11T00:00:00.000Z",
    });

    expect(db.getEntity("person:morgan")).toEqual({
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      createdAt: "2026-07-11T00:00:00.000Z",
    });
    expect(db.countEntities()).toBe(1);
    db.close();
  });

  it("stores entity relations and lists them by src", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", createdAt: "2026-06-15T09:00:00.000Z" });
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains");
    expect(db.relationsFor("person:morgan")).toContainEqual(expect.objectContaining({ dst: "project:mono-agent", relation: "maintains" }));
    db.close();
  });

  it("keeps compatibility relation semantics but canonical mirroring overwrites createdAt", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", createdAt: "2026-01-01T00:00:00.000Z" });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", createdAt: "2026-01-01T00:00:00.000Z" });
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains", "2025-01-01T00:00:00.000Z");
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains", "2025-06-01T00:00:00.000Z");
    expect(db.relationsFor("person:morgan")[0]?.createdAt).toBe("2025-01-01T00:00:00.000Z");

    db.mirrorCanonicalRelation({
      src: "person:morgan",
      dst: "project:mono-agent",
      relation: "maintains",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(db.relationsFor("person:morgan")).toEqual([{
      src: "person:morgan",
      dst: "project:mono-agent",
      relation: "maintains",
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    db.close();
  });

  it("keeps compatibility association precedence but canonical mirroring overwrites provenance and createdAt", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertLexical(memory("M1"));
    db.upsertEntity({ id: "person:morgan", name: "Morgan", createdAt: "2026-01-01T00:00:00.000Z" });
    db.associateMemory({
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    db.associateMemory({
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "legacy-name-match",
      createdAt: "2025-06-01T00:00:00.000Z",
    });
    expect(db.associationsForMemory("M1")).toEqual([{
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: "2025-01-01T00:00:00.000Z",
    }]);

    db.mirrorCanonicalAssociation({
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "legacy-name-match",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(db.associationsForMemory("M1")).toEqual([{
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "legacy-name-match",
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    db.close();
  });

  it("listEntities returns entities ordered by name up to limit", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "concept:bujo", name: "BuJo", type: "concept", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "tool:shared-z", name: "Shared", type: "tool", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "concept:shared-a", name: "Shared", type: "concept", createdAt: "2026-06-15T09:00:00.000Z" });

    const all = db.listEntities(50);
    expect(all).toHaveLength(5);
    // Ordered by name, then id (case-sensitive SQLite default: uppercase < lowercase).
    const names = all.map((e) => e.name);
    expect(names).toEqual([...names].sort());
    expect(all.filter((entity) => entity.name === "Shared").map((entity) => entity.id)).toEqual([
      "concept:shared-a",
      "tool:shared-z",
    ]);

    // Respects limit.
    const one = db.listEntities(1);
    expect(one).toHaveLength(1);
    expect(db.listEntities(2, 2).map((entity) => entity.id)).toEqual([
      "concept:shared-a",
      "tool:shared-z",
    ]);

    // Returns empty when no entities.
    const db2 = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    expect(db2.listEntities()).toEqual([]);
    db2.close();

    db.close();
  });
});

function memory(id: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text: "Morgan maintains mono-agent.",
    salience: 0.7,
    isInsight: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-01-01.md", line: 3 },
  };
}

import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import type { MemoryRecord } from "../types.js";

const AT = "2026-07-12T08:00:00.000Z";
const LATER = "2026-07-12T09:00:00.000Z";

describe("canonical graph projection replacement", () => {
  it("replaces the total graph, clears drift, syncs collections, and preserves replay edges", () => {
    let providerCalls = 0;
    const db = openMemoryDb({
      path: ":memory:",
      dim: 3,
      embeddings: {
        id: "must-not-run",
        embed: async () => {
          providerCalls += 1;
          return [[1, 0, 0]];
        },
      },
    });
    db.upsertLexical(memory("M1", "open", "Morgan maintains mono-agent.", "stale"));
    db.upsertLexical(memory("M2", "migrated", "Project archive."));
    db.upsertLexical(memory("M0", "invalidated", "Old note."));
    db.upsertEntity({ id: "person:stale", name: "Stale", createdAt: AT });
    db.associateMemory({ memoryId: "M1", entityId: "person:stale", provenance: "capture", createdAt: AT });
    db.addEdge("M1", "person:stale", "supports");
    db.addEdge("M1", "person:stale", "about");
    db.addEdge("M1", "M2", "thread", 0.75);
    db.addEdge("M0", "M2", "supersedes", 1);
    const replayEdges = db.allEdges().filter((edge) => edge.kind === "thread" || edge.kind === "supersedes");
    const expectedMemories = db.canonicalGraphSnapshot().memories;
    const projection = {
      entities: [
        { id: "collection:projects", name: "projects", type: "collection", createdAt: AT },
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: AT },
      ],
      relations: [{
        src: "person:morgan",
        dst: "collection:projects",
        relation: "maintains",
        createdAt: AT,
      }],
      associations: [
        { memoryId: "M1", entityId: "person:morgan", provenance: "legacy-name-match" as const, createdAt: AT },
        { memoryId: "M2", entityId: "collection:projects", provenance: "capture" as const, createdAt: LATER },
      ],
      supports: [{
        memoryId: "M2",
        entityId: "collection:projects",
        collection: "projects",
        weight: 1,
        createdAt: LATER,
      }],
    };

    expect(db.replaceCanonicalGraphProjection(expectedMemories, projection)).toBe(true);
    expect(providerCalls).toBe(0);
    expect(db.allEntities()).toEqual(projection.entities);
    expect(db.allEntityRelations()).toEqual(projection.relations);
    expect(db.allMemoryAssociations()).toEqual(projection.associations);
    expect(db.get("M1")?.collection).toBeUndefined();
    expect(db.get("M2")?.collection).toBe("projects");
    expect(db.allEdges().filter((edge) => edge.kind === "thread" || edge.kind === "supersedes")).toEqual(replayEdges);
    expect(db.allEdges().filter((edge) => edge.kind === "supports" || edge.kind === "about")).toEqual([{
      src: "M2",
      dst: "collection:projects",
      kind: "supports",
      weight: 1,
      createdAt: LATER,
    }]);

    const exactMemories = db.canonicalGraphSnapshot().memories;
    const digest = db.logicalIntegrityDigest();
    expect(db.replaceCanonicalGraphProjection(exactMemories, {
      ...projection,
      entities: projection.entities.map((entity) => ({
        createdAt: entity.createdAt,
        type: entity.type,
        name: entity.name,
        id: entity.id,
      })),
    })).toBe(false);
    expect(db.logicalIntegrityDigest()).toBe(digest);
    expect(providerCalls).toBe(0);
    db.close();
  });

  it("CAS-fails before graph mutation when the derivation memory snapshot changed", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "open", "Before"));
    db.upsertEntity({ id: "person:existing", name: "Existing", createdAt: AT });
    db.associateMemory({ memoryId: "M1", entityId: "person:existing", provenance: "capture", createdAt: AT });
    db.addEdge("M1", "person:existing", "about");
    const staleMemories = db.canonicalGraphSnapshot().memories;
    db.upsertLexical(memory("M1", "open", "Changed concurrently"));
    const graphBefore = db.canonicalGraphSnapshot();
    const edgesBefore = db.allEdges();

    expect(() => db.replaceCanonicalGraphProjection(staleMemories, {
      entities: [],
      relations: [],
      associations: [],
      supports: [],
    })).toThrow(/compare-and-swap/iu);
    expect(db.canonicalGraphSnapshot()).toEqual(graphBefore);
    expect(db.allEdges()).toEqual(edgesBefore);
    db.close();
  });

  it.each([
    ["duplicate keys", (base: ReturnType<typeof validProjection>) => ({
      ...base,
      entities: [...base.entities, { ...base.entities[0]! }],
    })],
    ["orphan endpoints", (base: ReturnType<typeof validProjection>) => ({
      ...base,
      relations: [{ src: "person:missing", dst: "collection:projects", relation: "uses", createdAt: AT }],
    })],
    ["non-unit support weight", (base: ReturnType<typeof validProjection>) => ({
      ...base,
      supports: [{ ...base.supports[0]!, weight: 0.5 }],
    })],
    ["support without an exact association", (base: ReturnType<typeof validProjection>) => ({
      ...base,
      associations: [],
    })],
  ])("rejects %s without changing existing graph state", (_label, mutate) => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "migrated", "Project archive."));
    db.upsertEntity({ id: "person:existing", name: "Existing", createdAt: AT });
    const memories = db.canonicalGraphSnapshot().memories;
    const graphBefore = db.canonicalGraphSnapshot();
    const edgesBefore = db.allEdges();

    expect(() => db.replaceCanonicalGraphProjection(memories, mutate(validProjection()))).toThrow(/canonical graph|weight/iu);
    expect(db.canonicalGraphSnapshot()).toEqual(graphBefore);
    expect(db.allEdges()).toEqual(edgesBefore);
    db.close();
  });
});

function validProjection() {
  return {
    entities: [{ id: "collection:projects", name: "projects", type: "collection", createdAt: AT }],
    relations: [],
    associations: [{
      memoryId: "M1",
      entityId: "collection:projects",
      provenance: "capture" as const,
      createdAt: AT,
    }],
    supports: [{
      memoryId: "M1",
      entityId: "collection:projects",
      collection: "projects",
      weight: 1,
      createdAt: AT,
    }],
  };
}

function memory(
  id: string,
  status: MemoryRecord["status"],
  text: string,
  collection?: string,
): MemoryRecord {
  return {
    id,
    type: "note",
    status,
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: AT,
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-07-12.md", line: 1 },
    ...(collection === undefined ? {} : { collection }),
  };
}

import { describe, expect, it, vi } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

const NOW = "2026-06-15T09:00:00.000Z";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: NOW,
    accessCount: 0,
    tags: [],
    source: {},
    ...over,
  };
}

describe("addEdge/expand", () => {
  it("persists a validated explicit timestamp and deterministically repairs an existing edge", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "memory a"));
    await db.upsert(note("b", "memory b"));
    db.addEdge("a", "b", "thread", 0.5, "2099-01-01T00:00:00.000Z");
    db.addEdge("a", "b", "thread", 0.8, "2099-01-02T00:00:00.000Z");

    expect(db.allEdges()).toEqual([{
      src: "a",
      dst: "b",
      kind: "thread",
      weight: 0.8,
      createdAt: "2099-01-02T00:00:00.000Z",
    }]);
    expect(() => db.addEdge("a", "b", "thread", 0.8, "2099-01-02T00:00:00Z"))
      .toThrow(/exact ISO timestamp/iu);
    db.close();
  });

  it("expands one hop along thread/about edges, excluding the seed ids", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (const id of ["a", "b", "c", "d"]) await db.upsert(note(id, `memory ${id}`));
    db.addEdge("a", "b", "thread", 0.9);
    db.addEdge("a", "c", "about", 1.0);
    db.addEdge("c", "d", "thread", 0.5); // 2 hops from a — must NOT appear at hops=1

    const expanded = db.expand(["a"], 1).map((r) => r.id).sort();
    expect(expanded).toEqual(["b", "c"]);
    db.close();
  });
});

describe("expandEntityRelations", () => {
  it("traverses an outgoing relation and the same stored relation in the incoming direction", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-memory", "Morgan owns the leadership decision."));
      await db.upsert(note("atlas-memory", "Project Atlas has a budget of 200."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      associate(db, "morgan-memory", "person:morgan");
      associate(db, "atlas-memory", "project:atlas");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");

      expect(expandIds(db, ["morgan-memory"], "Which project does Morgan lead?")).toEqual(["atlas-memory"]);
      expect(expandIds(db, ["atlas-memory"], "Who leads Atlas?")).toEqual(["morgan-memory"]);
    } finally {
      db.close();
    }
  });

  it("rejects the semantic inverse of a directed relation", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-memory", "Morgan owns the leadership decision."));
      await db.upsert(note("atlas-memory", "Project Atlas has a budget of 200."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      associate(db, "morgan-memory", "person:morgan");
      associate(db, "atlas-memory", "project:atlas");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");

      expect(expandIds(db, ["atlas-memory"], "Who does Atlas lead?")).toEqual([]);
      expect(expandIds(db, ["atlas-memory"], "Who is Atlas led by?")).toEqual([]);
      expect(expandIds(db, ["atlas-memory"], "What is the lead relationship between Morgan and Atlas?")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("treats a possessive manager as incoming and does not authorize the seed's location edge", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-seed", "Morgan has durable team context."));
      await db.upsert(note("taylor-manager", "Taylor is based in Utrecht."));
      await db.upsert(note("casey-report", "Casey is based in Rotterdam."));
      await db.upsert(note("amsterdam-distractor", "Amsterdam is Morgan's current home."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "person:taylor", "Taylor");
      addEntity(db, "person:casey", "Casey");
      addEntity(db, "city:amsterdam", "Amsterdam");
      associate(db, "morgan-seed", "person:morgan");
      associate(db, "taylor-manager", "person:taylor");
      associate(db, "casey-report", "person:casey");
      associate(db, "amsterdam-distractor", "city:amsterdam");
      db.addEntityRelation("person:taylor", "person:morgan", "manages");
      db.addEntityRelation("person:morgan", "person:casey", "manages");
      db.addEntityRelation("person:morgan", "city:amsterdam", "lives in");

      expect(expandIds(db, ["morgan-seed"], "Where is Morgan's manager based?")).toEqual(["taylor-manager"]);
      expect(expandIds(db, ["morgan-seed"], "Who manages Morgan?")).toEqual(["taylor-manager"]);
      expect(expandIds(db, ["morgan-seed"], "Who does Morgan manage?")).toEqual(["casey-report"]);
      expect(expandIds(db, ["morgan-seed"], "Who is not Morgan's manager?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Where is Morgan's manager not based?")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("uses relation evidence beyond the seed name and rejects a distractor edge", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-memory", "Morgan has durable project context."));
      await db.upsert(note("atlas-memory", "Project Atlas has a budget of 200."));
      await db.upsert(note("amsterdam-memory", "Amsterdam has a quiet office."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      addEntity(db, "city:amsterdam", "Amsterdam");
      associate(db, "morgan-memory", "person:morgan");
      associate(db, "atlas-memory", "project:atlas");
      associate(db, "amsterdam-memory", "city:amsterdam");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");
      db.addEntityRelation("person:morgan", "city:amsterdam", "lives in");

      expect(expandIds(db, ["morgan-memory"], "What does Morgan lead?")).toEqual(["atlas-memory"]);
    } finally {
      db.close();
    }
  });

  it("fails closed on negated queries and negated, historical, or modal stored relations", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-seed", "Morgan has durable project context."));
      await db.upsert(note("atlas-positive", "Project Atlas is currently active."));
      await db.upsert(note("apollo-negative", "Project Apollo is not led by Morgan."));
      await db.upsert(note("orion-historical", "Project Orion was historical context."));
      await db.upsert(note("vega-modal", "Project Vega is uncertain context."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      addEntity(db, "project:apollo", "Project Apollo");
      addEntity(db, "project:orion", "Project Orion");
      addEntity(db, "project:vega", "Project Vega");
      associate(db, "morgan-seed", "person:morgan");
      associate(db, "atlas-positive", "project:atlas");
      associate(db, "apollo-negative", "project:apollo");
      associate(db, "orion-historical", "project:orion");
      associate(db, "vega-modal", "project:vega");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");
      db.addEntityRelation("person:morgan", "project:apollo", "does not lead");
      db.addEntityRelation("person:morgan", "project:orion", "formerly led");
      db.addEntityRelation("person:morgan", "project:vega", "might lead");

      expect(expandIds(db, ["morgan-seed"], "Which project does Morgan lead?")).toEqual(["atlas-positive"]);
      for (const query of [
        "Which project does Morgan not lead?",
        "Which project does Morgan no longer lead?",
        "Morgan never leads which project?",
        "Morgan doesn't lead which project?",
        "Morgan can't lead which project?",
      ]) {
        expect(expandIds(db, ["morgan-seed"], query), query).toEqual([]);
      }
      expect(expandIds(db, ["atlas-positive"], "Who does not lead Atlas?")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a concrete endpoint that is not the stored endpoint in every direction branch", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-seed", "Morgan has durable project context."));
      await db.upsert(note("atlas-target", "Project Atlas is based in Paris."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      addEntity(db, "project:apollo", "Project Apollo");
      addEntity(db, "city:amsterdam", "Amsterdam");
      associate(db, "morgan-seed", "person:morgan");
      associate(db, "atlas-target", "project:atlas");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");
      db.addEntityRelation("project:atlas", "person:morgan", "manages");

      expect(expandIds(db, ["morgan-seed"], "Does Morgan lead Project Atlas?")).toEqual(["atlas-target"]);
      expect(expandIds(db, ["morgan-seed"], "Does Morgan lead Project Apollo?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Does Morgan lead Amsterdam?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Does Morgan lead Project Unknown?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Does Morgan lead the garden club?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Morgan leads Unknown?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Does Atlas manage Morgan?")).toEqual(["atlas-target"]);
      expect(expandIds(db, ["morgan-seed"], "Does Apollo manage Morgan?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Does Unknown manage Morgan?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Unknown manages Morgan?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Where is Morgan's manager Atlas based?")).toEqual(["atlas-target"]);
      expect(expandIds(db, ["morgan-seed"], "Where is Morgan's manager Apollo based?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Where is Morgan's manager Unknown based?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Where is Morgan's manager the garden club based?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Who is Morgan's manager?")).toEqual(["atlas-target"]);
      expect(expandIds(db, ["morgan-seed"], "Is Atlas Morgan's manager?")).toEqual(["atlas-target"]);
      expect(expandIds(db, ["morgan-seed"], "Is Unknown Morgan's manager?")).toEqual([]);
      expect(expandIds(db, ["morgan-seed"], "Is the garden club Morgan's manager?")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("preserves relation-defining particles instead of collapsing near-collision phrases", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("acme-seed", "Acme has durable organization context."));
      await db.upsert(note("worker-target", "Willa works with Acme."));
      await db.upsert(note("reporter-target", "Riley reports about Acme."));
      await db.upsert(note("talker-target", "Taylor talks about Acme."));
      addEntity(db, "org:acme", "Acme");
      addEntity(db, "person:willa", "Willa");
      addEntity(db, "person:riley", "Riley");
      addEntity(db, "person:taylor", "Taylor");
      associate(db, "acme-seed", "org:acme");
      associate(db, "worker-target", "person:willa");
      associate(db, "reporter-target", "person:riley");
      associate(db, "talker-target", "person:taylor");
      db.addEntityRelation("person:willa", "org:acme", "works with");
      db.addEntityRelation("person:riley", "org:acme", "reports about");
      db.addEntityRelation("person:taylor", "org:acme", "talks about");

      expect(expandIds(db, ["acme-seed"], "Who works with Acme?")).toEqual(["worker-target"]);
      expect(expandIds(db, ["acme-seed"], "Who reports about Acme?")).toEqual(["reporter-target"]);
      expect(expandIds(db, ["acme-seed"], "Who talks about Acme?")).toEqual(["talker-target"]);
      expect(expandIds(db, ["acme-seed"], "Who works for Acme?")).toEqual([]);
      expect(expandIds(db, ["acme-seed"], "Who reports to Acme?")).toEqual([]);
      expect(expandIds(db, ["acme-seed"], "Who talks to Acme?")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("matches a base-form query verb to an inflected relation label", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-memory", "Morgan has durable location context."));
      await db.upsert(note("amsterdam-memory", "Amsterdam is Morgan's current home."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "city:amsterdam", "Amsterdam");
      associate(db, "morgan-memory", "person:morgan");
      associate(db, "amsterdam-memory", "city:amsterdam");
      db.addEntityRelation("person:morgan", "city:amsterdam", "lives in");

      expect(expandIds(db, ["morgan-memory"], "Where does Morgan live?")).toEqual(["amsterdam-memory"]);
    } finally {
      db.close();
    }
  });

  it("does not materialize the full entity catalog to resolve a query-local relation", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-memory", "Morgan has durable project context."));
      await db.upsert(note("atlas-memory", "Project Atlas has a budget of 200."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      associate(db, "morgan-memory", "person:morgan");
      associate(db, "atlas-memory", "project:atlas");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");
      const fullCatalog = vi.spyOn(db, "listEntities").mockImplementation(() => {
        throw new Error("graph expansion must not scan the full entity catalog");
      });

      expect(expandIds(db, ["morgan-memory"], "Which project does Morgan lead?")).toEqual(["atlas-memory"]);
      expect(fullCatalog).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });

  it("stays at one hop, ignores self-loops, and deduplicates a target reached by two relations", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    try {
      await db.upsert(note("morgan-seed", "Morgan has durable project context."));
      await db.upsert(note("morgan-other", "Morgan prefers quiet mornings."));
      await db.upsert(note("atlas-target", "Project Atlas has a budget of 200."));
      await db.upsert(note("casey-two-hop", "Casey starts the migration Monday."));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      addEntity(db, "person:casey", "Casey");
      associate(db, "morgan-seed", "person:morgan");
      associate(db, "morgan-other", "person:morgan");
      associate(db, "atlas-target", "project:atlas");
      associate(db, "casey-two-hop", "person:casey");
      db.addEntityRelation("person:morgan", "person:morgan", "leads");
      db.addEntityRelation("person:morgan", "project:atlas", "leads");
      db.addEntityRelation("person:morgan", "project:atlas", "manages");
      db.addEntityRelation("project:atlas", "person:casey", "mentors");
      db.addEntityRelation("person:casey", "project:atlas", "mentors");

      expect(expandIds(db, ["morgan-seed"], "What does Morgan lead and manage?")).toEqual(["atlas-target"]);
    } finally {
      db.close();
    }
  });

  it("excludes invalidated, dropped, and temporally stale target memories", async () => {
    const db = openMemoryDb({
      path: ":memory:",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      clock: () => new Date(NOW),
    });
    try {
      await db.upsert(note("morgan-seed", "Morgan has durable project context."));
      await db.upsert(note("atlas-live", "Project Atlas has a live budget of 200."));
      await db.upsert(note("atlas-invalid", "Project Atlas has an invalid budget.", { status: "invalidated" }));
      await db.upsert(note("atlas-dropped", "Project Atlas has a dropped budget.", { status: "dropped" }));
      await db.upsert(note("atlas-stale", "Project Atlas had an expired budget.", { validTo: "2026-06-14T09:00:00.000Z" }));
      addEntity(db, "person:morgan", "Morgan");
      addEntity(db, "project:atlas", "Project Atlas");
      associate(db, "morgan-seed", "person:morgan");
      for (const id of ["atlas-live", "atlas-invalid", "atlas-dropped", "atlas-stale"]) {
        associate(db, id, "project:atlas");
      }
      db.addEntityRelation("person:morgan", "project:atlas", "leads");

      expect(expandIds(db, ["morgan-seed"], "What project does Morgan lead?")).toEqual(["atlas-live"]);
    } finally {
      db.close();
    }
  });
});

function addEntity(db: ReturnType<typeof openMemoryDb>, id: string, name: string): void {
  db.upsertEntity({ id, name, createdAt: NOW });
}

function associate(db: ReturnType<typeof openMemoryDb>, memoryId: string, entityId: string): void {
  db.associateMemory({ memoryId, entityId, provenance: "capture", createdAt: NOW });
}

function expandIds(db: ReturnType<typeof openMemoryDb>, seedIds: readonly string[], query: string): string[] {
  return db.expandEntityRelations(seedIds, { query, now: new Date(NOW), maxAdditions: 20 }).map((record) => record.id);
}

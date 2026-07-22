import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAssociation,
  appendEntity,
  appendGraphBatch,
  appendRelation,
  readGraph,
  type GraphBatchInput,
} from "../graph.js";
import type { EntityRecord, EntityRelationRecord } from "../../store/index.js";

function entity(id: string, name: string): EntityRecord {
  return { id, name, type: "person", createdAt: "2026-06-15T09:00:00.000Z" };
}

function relation(src: string, dst: string, rel: string): EntityRelationRecord {
  return { src, dst, relation: rel, createdAt: "2026-06-15T09:00:00.000Z" };
}

describe("readGraph", () => {
  it("returns empty collections when file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
  });

  it("round-trips: appended entities and relations are readable", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, entity("person:alice", "Alice"));
    appendRelation(root, relation("person:alice", "project:x", "maintains"));
    const g = readGraph(root);
    expect(g.entities).toHaveLength(1);
    expect(g.entities[0]).toMatchObject({ id: "person:alice", name: "Alice" });
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0]).toMatchObject({ src: "person:alice", dst: "project:x", relation: "maintains" });
  });

  it("dedupes entities by id keeping the LAST occurrence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, { id: "person:alice", name: "Alice", createdAt: "2026-06-15T09:00:00.000Z" });
    appendEntity(root, {
      id: "person:alice",
      name: "Alice Updated",
      summary: "new summary",
      createdAt: "2026-06-15T09:00:00.000Z",
      updatedAt: "2026-06-15T10:00:00.000Z",
    });
    const g = readGraph(root);
    expect(g.entities).toHaveLength(1);
    expect(g.entities[0]).toMatchObject({ name: "Alice Updated", summary: "new summary" });
  });

  it("does not append a duplicate entity record", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    const alice = entity("person:alice", "Alice");
    appendEntity(root, alice);
    appendEntity(root, { ...alice, createdAt: "2026-06-15T10:00:00.000Z" });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readGraph(root).entities).toHaveLength(1);
  });

  it("does not append a partial duplicate that omits existing optional entity details", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, {
      id: "person:alice",
      name: "Alice",
      type: "person",
      summary: "prefers quiet mornings",
      createdAt: "2026-06-15T09:00:00.000Z",
    });
    appendEntity(root, {
      id: "person:alice",
      name: "Alice",
      createdAt: "2026-06-15T10:00:00.000Z",
    });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readGraph(root).entities[0]).toMatchObject({
      type: "person",
      summary: "prefers quiet mornings",
    });
  });

  it("preserves existing optional entity details when appending a partial update", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, {
      id: "person:alice",
      name: "Alice",
      type: "person",
      summary: "prefers quiet mornings",
      createdAt: "2026-06-15T09:00:00.000Z",
    });
    appendEntity(root, {
      id: "person:alice",
      name: "Alice Updated",
      createdAt: "2026-06-15T10:00:00.000Z",
    });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readGraph(root).entities[0]).toMatchObject({
      name: "Alice Updated",
      type: "person",
      summary: "prefers quiet mornings",
    });
  });

  it("still appends entity updates so the last occurrence wins", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, entity("person:alice", "Alice"));
    appendEntity(root, {
      id: "person:alice",
      name: "Alice Updated",
      summary: "new summary",
      createdAt: "2026-06-15T09:00:00.000Z",
      updatedAt: "2026-06-15T10:00:00.000Z",
    });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readGraph(root).entities[0]).toMatchObject({ name: "Alice Updated", summary: "new summary" });
  });

  it("dedupes relations by src|dst|relation triple keeping the LAST occurrence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendRelation(root, { src: "a", dst: "b", relation: "knows", createdAt: "2026-06-15T09:00:00.000Z" });
    appendFileSync(
      join(root, "graph.jsonl"),
      '{"kind":"relation","src":"a","dst":"b","relation":"knows","createdAt":"2026-06-15T10:00:00.000Z"}\n',
      "utf8",
    );
    const g = readGraph(root);
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0]?.createdAt).toBe("2026-06-15T10:00:00.000Z");
  });

  it("does not append duplicate relation triples", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    const rel = relation("person:alice", "project:x", "maintains");
    appendRelation(root, rel);
    appendRelation(root, { ...rel, createdAt: "2026-06-15T10:00:00.000Z" });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readGraph(root).relations).toHaveLength(1);
  });

  it("appends a precise capture association over legacy evidence so last-write wins", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendAssociation(root, {
      memoryId: "memory-1",
      entityId: "person:alice",
      provenance: "legacy-name-match",
      createdAt: "2026-06-15T09:00:00.000Z",
    });
    appendAssociation(root, {
      memoryId: "memory-1",
      entityId: "person:alice",
      provenance: "capture",
      createdAt: "2026-06-16T09:00:00.000Z",
    });
    appendAssociation(root, {
      memoryId: "memory-1",
      entityId: "person:alice",
      provenance: "legacy-name-match",
      createdAt: "2026-06-17T09:00:00.000Z",
    });

    expect(readGraph(root).associations).toEqual([
      expect.objectContaining({
        memoryId: "memory-1",
        entityId: "person:alice",
        provenance: "capture",
        createdAt: "2026-06-15T09:00:00.000Z",
      }),
    ]);
    expect(readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("merges a maximum capture batch against a realistic graph without quadratic rereads", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-batch-"));
    const existing = Array.from({ length: 11_000 }, (_, index) => JSON.stringify({
      kind: "entity",
      id: `concept:existing-${index}`,
      name: `Existing ${index}`,
      type: "concept",
      createdAt: "2026-06-15T09:00:00.000Z",
    })).join("\n");
    appendFileSync(join(root, "graph.jsonl"), `${existing}\n`, "utf8");
    const entities = Array.from({ length: 16 }, (_, index) => ({
      id: `person:capture-${index}`,
      name: `Capture ${index}`,
      type: "person",
      createdAt: "2026-06-16T09:00:00.000Z",
    }));
    const relations = entities.map((item, index) => ({
      src: item.id,
      dst: entities[(index + 1) % entities.length]!.id,
      relation: "knows",
      createdAt: "2026-06-16T09:00:00.000Z",
    }));
    const associations = Array.from({ length: 128 }, (_, index) => ({
      memoryId: `memory-${Math.floor(index / 16)}`,
      entityId: entities[index % entities.length]!.id,
      provenance: "capture" as const,
      createdAt: "2026-06-16T09:00:00.000Z",
    }));

    const result = appendGraphBatch(root, { entities, relations, associations });

    expect(result.entities).toHaveLength(16);
    expect(result.relations).toHaveLength(16);
    expect(result.associations).toHaveLength(128);
    expect(readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n")).toHaveLength(11_160);
  });

  it("skips malformed lines without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, entity("person:bob", "Bob"));
    appendFileSync(join(root, "graph.jsonl"), "NOT_VALID_JSON\n", "utf8");
    appendFileSync(
      join(root, "graph.jsonl"),
      '{"kind":"entity","id":"person:charlie","name":"Charlie","createdAt":"2026-06-15T09:00:00.000Z"}\n',
      "utf8",
    );
    const g = readGraph(root);
    expect(g.entities).toHaveLength(2);
    expect(g.entities.map((e) => e.id)).toContain("person:charlie");
  });

  it.each([
    ["control identity", { entities: [{ id: "person:bad\0id", name: "Bad", createdAt: "2026-06-15T09:00:00.000Z" }] }],
    ["invalid optional type", { entities: [{ id: "person:bad", name: "Bad", type: 42, createdAt: "2026-06-15T09:00:00.000Z" }] }],
    ["format-control summary", { entities: [{ id: "person:bad", name: "Bad", summary: "bad\u202Esummary", createdAt: "2026-06-15T09:00:00.000Z" }] }],
    ["invalid entity update timestamp", { entities: [{ id: "person:bad", name: "Bad", createdAt: "2026-06-15T09:00:00.000Z", updatedAt: "not-a-date" }] }],
    ["invalid relation timestamp", { relations: [{ src: "person:a", dst: "person:b", relation: "knows", createdAt: "not-a-date" }] }],
    ["invalid association provenance", { associations: [{ memoryId: "M1", entityId: "person:a", provenance: "future", createdAt: "2026-06-15T09:00:00.000Z" }] }],
    ["graph-line discriminator override", { entities: [{ kind: "relation", id: "person:bad", name: "Bad", createdAt: "2026-06-15T09:00:00.000Z" }] }],
  ])("rejects %s before appending canonical graph state", (_label, input) => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-invalid-write-"));

    expect(() => appendGraphBatch(root, input as unknown as GraphBatchInput)).toThrow(/invalid|missing/iu);
    expect(existsSync(join(root, "graph.jsonl"))).toBe(false);
  });

  it("keeps the legacy compatibility reader permissive for strict-invalid records", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-legacy-invalid-"));
    writeFileSync(join(root, "graph.jsonl"), `${JSON.stringify({
      kind: "entity",
      id: "person:legacy\0id",
      name: "Legacy",
      createdAt: "2026-06-15T09:00:00.000Z",
    })}\n`, "utf8");

    expect(readGraph(root).entities).toEqual([
      expect.objectContaining({ id: "person:legacy\0id", name: "Legacy" }),
    ]);
  });

  it("does not republish a strict-invalid legacy field through an otherwise valid merge", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-legacy-merge-"));
    const graphPath = join(root, "graph.jsonl");
    writeFileSync(graphPath, `${JSON.stringify({
      kind: "entity",
      id: "person:legacy",
      name: "Legacy",
      summary: "bad\u202Esummary",
      createdAt: "2026-06-15T09:00:00.000Z",
    })}\n`, "utf8");
    const before = readFileSync(graphPath, "utf8");

    expect(() => appendEntity(root, {
      id: "person:legacy",
      name: "Legacy Updated",
      createdAt: "2026-06-16T09:00:00.000Z",
    })).toThrow(/invalid/iu);
    expect(readFileSync(graphPath, "utf8")).toBe(before);
  });

  it("rejects a symlinked graph target without reading or appending its referent", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-link-"));
    const outside = join(mkdtempSync(join(tmpdir(), "bujo-graph-outside-")), "graph.jsonl");
    writeFileSync(outside, '{"kind":"entity","id":"secret","name":"Secret"}\n', "utf8");
    symlinkSync(outside, join(root, "graph.jsonl"));

    expect(() => readGraph(root)).toThrow(/symlink|regular/iu);
    expect(() => appendEntity(root, entity("person:alice", "Alice"))).toThrow(/symlink|regular/iu);
    expect(readFileSync(outside, "utf8")).toContain('"secret"');
  });

  it("rejects a symlinked root component used as graph storage", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-link-"));
    const outside = mkdtempSync(join(tmpdir(), "bujo-graph-outside-"));
    mkdirSync(join(root, "container"));
    symlinkSync(outside, join(root, "container", "memory"), "dir");

    expect(() => appendEntity(join(root, "container", "memory"), entity("person:alice", "Alice"))).toThrow(/root.*symlink/iu);
    expect(() => readGraph(join(root, "container", "memory"))).toThrow(/root.*symlink/iu);
  });
});

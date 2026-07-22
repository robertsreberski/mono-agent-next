import { describe, expect, it } from "vitest";

import { normalizeExtraction } from "../entities.js";

describe("entity extraction normalization", () => {
  it("normalizes well-formed entities and relations", () => {
    const result = normalizeExtraction({
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "project:mono-agent", name: "mono-agent", type: "project" },
      ],
      relations: [{ src: "person:morgan", dst: "project:mono-agent", relation: "maintains" }],
    });

    expect(result.entities).toEqual([
      { id: "person:morgan", name: "Morgan", type: "person" },
      { id: "project:mono-agent", name: "mono-agent", type: "project" },
    ]);
    expect(result.relations).toEqual([
      { src: "person:morgan", dst: "project:mono-agent", relation: "maintains" },
    ]);
  });

  it("drops malformed entities and relations that do not reference accepted ids", () => {
    const result = normalizeExtraction({
      entities: [
        { name: "No ID", type: "person" },
        { id: "person:nameless", type: "person" },
        { id: "person:alice", name: "Alice", type: "person" },
        { id: "person:bob", name: "Bob", type: "person" },
      ],
      relations: [
        { src: "person:alice", dst: "person:bob", relation: "knows" },
        { src: "person:unknown", dst: "person:bob", relation: "knows" },
        { src: "person:alice", dst: "person:unknown", relation: "knows" },
        { src: "person:alice", dst: "person:bob" },
      ],
    });

    expect(result.entities.map((entity) => entity.id)).toEqual(["person:alice", "person:bob"]);
    expect(result.relations).toEqual([
      { src: "person:alice", dst: "person:bob", relation: "knows" },
    ]);
  });

  it("returns an empty extraction for non-object and missing-array input", () => {
    expect(normalizeExtraction(undefined)).toEqual({ entities: [], relations: [] });
    expect(normalizeExtraction("not an extraction")).toEqual({ entities: [], relations: [] });
    expect(normalizeExtraction({})).toEqual({ entities: [], relations: [] });
  });
});

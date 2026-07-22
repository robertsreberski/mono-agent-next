import { describe, expect, it } from "vitest";

import { rrfFuse, reScore } from "../ranking.js";
import { ftsQuery } from "../fts.js";
import { DEFAULT_WEIGHTS } from "../types.js";

describe("rrfFuse", () => {
  it("rewards items ranked high in either list; top of both wins", () => {
    const vec = ["a", "b", "c"];
    const kw = ["a", "d", "b"];
    const fused = rrfFuse([vec, kw], 60);
    expect(fused[0]?.id).toBe("a"); // appears in both, high in both
    expect(fused.map((f) => f.id)).toContain("d");
  });
});

describe("reScore", () => {
  it("ignores access recency while retaining salience and insight tie-breakers", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const base = { rrfScore: 1, salience: 0.5, isInsight: false };
    const old = reScore(base, DEFAULT_WEIGHTS, 0.995, new Date("2026-01-01T00:00:00.000Z"));
    const fresh = reScore(base, DEFAULT_WEIGHTS, 0.995, now);
    const insight = reScore({ ...base, isInsight: true }, DEFAULT_WEIGHTS, 0.995, now);
    expect(fresh).toBe(old);
    expect(insight).toBeGreaterThan(fresh);
  });

  it("returns a finite score from relevance and bounded tie-breakers", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const score = reScore(
      { rrfScore: 1, salience: 0.5, isInsight: false },
      DEFAULT_WEIGHTS,
      0.995,
      now,
    );
    expect(Number.isNaN(score)).toBe(false);
  });
});

describe("ftsQuery", () => {
  it("quotes tokens and ORs them, dropping punctuation", () => {
    expect(ftsQuery("cat's pricing? plan!")).toBe('"cat" OR "s" OR "pricing" OR "plan"');
  });
  it("returns empty string for tokenless input", () => {
    expect(ftsQuery("!?  ")).toBe("");
  });
});

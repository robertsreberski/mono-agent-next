import { describe, expect, it } from "vitest";

import { extractCapturePlan } from "../capture-batch.js";
import { fakeLlm } from "./helpers.js";

describe("extractCapturePlan intra-turn precision", () => {
  it("normalizes legally escaped lone surrogates on the lenient capture path", async () => {
    const response = JSON.stringify({
      memories: [
        { type: "note", text: "alpha\ud83dbeta", salience: 0.8, isInsight: false, entityIds: [] },
        { type: "note", text: "gamma\udc00delta", salience: 0.8, isInsight: false, entityIds: [] },
        { type: "note", text: "\ud83d", salience: 0.8, isInsight: false, entityIds: [] },
        { type: "note", text: "valid 🧠 memory", salience: 0.8, isInsight: false, entityIds: [] },
      ],
      entities: [],
      relations: [],
    });
    expect(response).toContain("\\ud83d");
    expect(response).toContain("\\udc00");

    const plan = await extractCapturePlan(
      "The model returned legal JSON escapes.",
      fakeLlm([["Extract one bounded", response]]),
    );

    expect(plan.candidates.map((candidate) => candidate.text)).toEqual([
      "alphabeta",
      "gammadelta",
      "valid 🧠 memory",
    ]);
    expect(plan.candidates.every((candidate) => !candidate.text.includes("�"))).toBe(true);
    expect(plan.candidates.every((candidate) => !/\p{Cs}/u.test(candidate.text))).toBe(true);
  });

  it("merges normalized exact duplicates and unions only their explicit entity ids", async () => {
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [
        { type: "note", text: "Morgan  prefers tea.", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
        { type: "task", text: "morgan prefers tea", salience: 0.2, isInsight: true, entityIds: ["concept:tea"] },
      ],
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "concept:tea", name: "Tea", type: "concept" },
      ],
      relations: [],
    })]]);

    const plan = await extractCapturePlan("Morgan prefers tea.", llm);

    expect(plan.candidates).toEqual([expect.objectContaining({
      type: "note",
      text: "Morgan prefers tea.",
      salience: 0.8,
      isInsight: false,
      entityIds: ["concept:tea", "person:morgan"],
    })]);
  });

  it("retains one near-duplicate ambiguity but preserves distinct facts", async () => {
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [
        { type: "note", text: "Morgan prefers tea", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
        { type: "note", text: "Morgan prefers coffee", salience: 0.8, isInsight: false, entityIds: ["person:morgan", "concept:coffee"] },
        { type: "note", text: "Morgan lives in Amsterdam", salience: 0.8, isInsight: false, entityIds: ["person:morgan", "city:amsterdam"] },
      ],
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "concept:coffee", name: "Coffee", type: "concept" },
        { id: "city:amsterdam", name: "Amsterdam", type: "concept" },
      ],
      relations: [],
    })]]);

    const plan = await extractCapturePlan("Morgan supplied conflicting preference text and a location.", llm);

    expect(plan.candidates.map((candidate) => candidate.text)).toEqual([
      "Morgan prefers tea",
      "Morgan lives in Amsterdam",
    ]);
    expect(plan.candidates[0]?.entityIds).toEqual(["person:morgan"]);
  });

  it("drops malformed or oversized graph fields before canonical capture", async () => {
    const huge = "x".repeat(2_000);
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [
        { type: "note", text: "Morgan keeps the bounded graph fact", salience: 0.8, isInsight: false,
          entityIds: ["Person:Morgan", `person:${huge}`, "person:morgan"] },
      ],
      entities: [
        { id: "Person:Morgan", name: "wrong case", type: "person" },
        { id: "person:bad id", name: "bad slug", type: "person" },
        { id: `person:${huge}`, name: "oversized id", type: "person" },
        { id: "person:morgan", name: `Morgan\n${"R".repeat(200)}`, type: "person" },
        { id: "person:morgan", name: "  Morgan\nReberski  ", type: "PERSON!" },
        { id: "project:mono-agent", name: "mono-agent", type: "project" },
      ],
      relations: [
        { src: "person:morgan", dst: "project:mono-agent", relation: huge },
        { src: "person:morgan", dst: "project:mono-agent", relation: "Maintains!" },
        { src: "person:morgan", dst: "project:mono-agent", relation: "maintains 🔥" },
        { src: "person:morgan", dst: "project:mono-agent", relation: "  maintains\ncarefully  " },
        { src: "Person:Morgan", dst: "project:mono-agent", relation: "invalid endpoint" },
      ],
    })]]);

    const plan = await extractCapturePlan("Morgan maintains mono-agent.", llm);

    expect(plan.entities).toEqual([
      { id: "person:morgan", name: "Morgan Reberski" },
      { id: "project:mono-agent", name: "mono-agent", type: "project" },
    ]);
    expect(plan.relations).toEqual([
      { src: "person:morgan", dst: "project:mono-agent", relation: "maintains carefully" },
    ]);
    expect(plan.candidates[0]?.entityIds).toEqual(["person:morgan"]);
  });
});

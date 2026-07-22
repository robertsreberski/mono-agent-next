import { describe, expect, it } from "vitest";

import { createSkillsCache, loadSelectedSkills } from "../index.js";

describe("agent-harness skills public API", () => {
  it("exports selected-skill helpers from the package root", () => {
    expect(loadSelectedSkills).toBeTypeOf("function");
    expect(createSkillsCache).toBeTypeOf("function");
  });
});

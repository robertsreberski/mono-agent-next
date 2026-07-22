import { describe, expect, it } from "vitest";

import { thinkingLevelForEffort } from "../../ai/providers/pi-native/turn-runner.js";

describe("thinkingLevelForEffort", () => {
  it("keeps the documented ultra mapping specific to reasoning-capable Pi models", () => {
    expect(thinkingLevelForEffort("ultra", { reasoning: true })).toBe("low");
    expect(thinkingLevelForEffort("ultra", { reasoning: false })).toBe("off");
    expect(thinkingLevelForEffort("ultra", { reasoning: true, reasoning_mode: "none" })).toBe("off");
  });
});

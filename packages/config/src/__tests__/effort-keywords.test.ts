import { describe, expect, it } from "vitest";

import { detectEffortKeyword, EFFORT_KEYWORD_TRIGGERS, effortRank, maxEffortLevel } from "../effort-keywords.js";

describe("detectEffortKeyword", () => {
  it("maps a bare 'think' anywhere in the message to high", () => {
    expect(detectEffortKeyword("think")).toEqual({ effort: "high", keyword: "think" });
    expect(detectEffortKeyword("Think hard about this bug")).toEqual({ effort: "high", keyword: "Think" });
    expect(detectEffortKeyword("what do you think?")).toEqual({ effort: "high", keyword: "think" });
  });

  it("maps 'extra think' and 'extrathink' to xhigh", () => {
    expect(detectEffortKeyword("extra think about the edge cases")).toEqual({ effort: "xhigh", keyword: "extra think" });
    expect(detectEffortKeyword("please extrathink this")).toEqual({ effort: "xhigh", keyword: "extrathink" });
  });

  it("maps 'ultra think' and 'ultrathink' to max, case-insensitively", () => {
    expect(detectEffortKeyword("ultra think about it")).toEqual({ effort: "max", keyword: "ultra think" });
    expect(detectEffortKeyword("ultrathink: what is 2+2")).toEqual({ effort: "max", keyword: "ultrathink" });
    expect(detectEffortKeyword("ULTRA THINK")).toEqual({ effort: "max", keyword: "ULTRA THINK" });
  });

  it("prefers the longest phrase when phrases overlap", () => {
    // "ultra think" also contains a standalone \bthink\b — the max trigger must win.
    expect(detectEffortKeyword("ultra think")?.effort).toBe("max");
    expect(detectEffortKeyword("extra think")?.effort).toBe("xhigh");
    expect(detectEffortKeyword("ultra think and think again")?.effort).toBe("max");
  });

  it("does not match inside larger words (word boundaries)", () => {
    expect(detectEffortKeyword("thinking")).toBeUndefined();
    expect(detectEffortKeyword("rethink")).toBeUndefined();
    expect(detectEffortKeyword("overthinking it")).toBeUndefined();
    expect(detectEffortKeyword("ultrathinking")).toBeUndefined();
  });

  it("does not match hyphenated or empty forms", () => {
    // "ultra-think" would match \bthink\b after the hyphen boundary, which is
    // exactly the spec: only "ultra think"/"ultrathink" earn max.
    expect(detectEffortKeyword("ultra-think")?.effort).toBe("high");
    expect(detectEffortKeyword("")).toBeUndefined();
    expect(detectEffortKeyword("no trigger words here")).toBeUndefined();
  });

  it("exposes triggers in descending effort order for downstream consumers", () => {
    expect(EFFORT_KEYWORD_TRIGGERS.map((trigger) => trigger.effort)).toEqual(["max", "xhigh", "high"]);
  });
});

describe("effortRank", () => {
  it("orders the closed effort enum by index", () => {
    const ranks = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(effortRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("ranks unknown and missing values below every real level", () => {
    expect(effortRank("turbo")).toBe(-1);
    expect(effortRank(undefined)).toBe(-1);
    expect(effortRank("")).toBe(-1);
  });
});

describe("maxEffortLevel", () => {
  it("escalates only on a strict rank increase", () => {
    expect(maxEffortLevel(undefined, "high")).toBe("high");
    expect(maxEffortLevel("low", "xhigh")).toBe("xhigh");
    expect(maxEffortLevel("max", "high")).toBe("max");
    expect(maxEffortLevel("high", "high")).toBe("high");
  });

  it("treats an unknown current level as escalatable", () => {
    expect(maxEffortLevel("turbo", "high")).toBe("high");
  });

  it("never downgrades a configured 'ultra' (outranks max by enum position)", () => {
    expect(maxEffortLevel("ultra", "max")).toBe("ultra");
  });
});

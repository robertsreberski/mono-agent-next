// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { escalateMessageEffort } from "../effort.js";

/** The bare `think` tier is opt-in; the two deliberate idioms are on by default. */
const WITH_THINK = { think: true } as const;

describe("message effort escalation", () => {
  it("recognizes bare, spaced, and fused keywords in descending strength", () => {
    expect(escalateMessageEffort("what do you think?", undefined, WITH_THINK).effort).toBe("high");
    expect(escalateMessageEffort("please extra think", undefined).effort).toBe("xhigh");
    expect(escalateMessageEffort("please extrathink", undefined).effort).toBe("xhigh");
    expect(escalateMessageEffort("ULTRA THINK then think", undefined).effort).toBe("max");
    expect(escalateMessageEffort("ultrathink", undefined).effort).toBe("max");
  });

  it("uses strict escalation-only rank semantics", () => {
    expect(escalateMessageEffort("think", "low", WITH_THINK).effort).toBe("high");
    expect(escalateMessageEffort("think", "high", WITH_THINK).effort).toBe("high");
    expect(escalateMessageEffort("think", "max", WITH_THINK).effort).toBe("max");
    expect(escalateMessageEffort("ultra think", "xhigh").effort).toBe("max");
    expect(escalateMessageEffort("ultra think", "ultra").effort).toBe("ultra");
  });

  it("does not match substrings or replace provider-owned unknown values", () => {
    expect(escalateMessageEffort("keep thinking", "low", WITH_THINK).effort).toBe("low");
    expect(escalateMessageEffort("rethink this", undefined, WITH_THINK).effort).toBeUndefined();
    expect(escalateMessageEffort("think", "provider-deep", WITH_THINK).effort).toBe("provider-deep");
    expect(escalateMessageEffort("ordinary request", "medium").effort).toBe("medium");
  });

  it("leaves ordinary English alone unless the bare tier is enabled", () => {
    // "what do you think?" is a normal question. Escalating it raised provider
    // reasoning tokens, latency, and cost on every such turn with no signal.
    for (const text of ["what do you think?", "I think we should use the other approach"]) {
      expect(escalateMessageEffort(text, "low").effort).toBe("low");
      expect(escalateMessageEffort(text, "low").escalation).toBeUndefined();
      expect(escalateMessageEffort(text, "low", { think: false }).effort).toBe("low");
      expect(escalateMessageEffort(text, "low", WITH_THINK).effort).toBe("high");
    }
  });

  it("honours an operator disabling the deliberate idioms", () => {
    expect(escalateMessageEffort("ultra think", "low", { ultraThink: false }).effort).toBe("low");
    expect(escalateMessageEffort("extra think", "low", { extraThink: false }).effort).toBe("low");
  });

  it("reports what raised the effort so the cost is attributable", () => {
    expect(escalateMessageEffort("ultra think", "low").escalation)
      .toEqual({ keyword: "ultraThink", from: "low", to: "max" });
    expect(escalateMessageEffort("ultra think", undefined).escalation)
      .toEqual({ keyword: "ultraThink", to: "max" });
    // No escalation is reported when the keyword did not actually raise anything.
    expect(escalateMessageEffort("ultra think", "ultra").escalation).toBeUndefined();
    expect(escalateMessageEffort("ordinary request", "medium").escalation).toBeUndefined();
  });
});

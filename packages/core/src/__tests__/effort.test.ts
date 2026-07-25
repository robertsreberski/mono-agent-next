// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { escalateMessageEffort } from "../effort.js";

describe("message effort escalation", () => {
  it("recognizes bare, spaced, and fused keywords in descending strength", () => {
    expect(escalateMessageEffort("what do you think?", undefined)).toBe("high");
    expect(escalateMessageEffort("please extra think", undefined)).toBe("xhigh");
    expect(escalateMessageEffort("please extrathink", undefined)).toBe("xhigh");
    expect(escalateMessageEffort("ULTRA THINK then think", undefined)).toBe("max");
    expect(escalateMessageEffort("ultrathink", undefined)).toBe("max");
  });

  it("uses strict escalation-only rank semantics", () => {
    expect(escalateMessageEffort("think", "low")).toBe("high");
    expect(escalateMessageEffort("think", "high")).toBe("high");
    expect(escalateMessageEffort("think", "max")).toBe("max");
    expect(escalateMessageEffort("ultra think", "xhigh")).toBe("max");
    expect(escalateMessageEffort("ultra think", "ultra")).toBe("ultra");
  });

  it("does not match substrings or replace provider-owned unknown values", () => {
    expect(escalateMessageEffort("keep thinking", "low")).toBe("low");
    expect(escalateMessageEffort("rethink this", undefined)).toBeUndefined();
    expect(escalateMessageEffort("think", "provider-deep")).toBe("provider-deep");
    expect(escalateMessageEffort("ordinary request", "medium")).toBe("medium");
  });
});

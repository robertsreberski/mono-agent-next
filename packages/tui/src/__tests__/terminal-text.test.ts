import { describe, expect, it } from "vitest";

import { sanitizeTerminalText } from "../ui/terminal-text.js";

const FORBIDDEN_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

describe("sanitizeTerminalText", () => {
  it("makes OSC, CSI, C1, and bidi payloads visible but inert", () => {
    const sanitized = sanitizeTerminalText(
      "before\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[2J\u009b31m\u202eafter",
    );
    expect(sanitized).toBe(
      "before\\u001b]52;c;Y2xpcGJvYXJk\\u0007\\u001b[2J\\u009b31m\\u202eafter",
    );
    expect(FORBIDDEN_CONTROL.test(sanitized)).toBe(false);
  });

  it("preserves LF only on explicitly multiline renderer surfaces", () => {
    expect(sanitizeTerminalText("one\ntwo\tthree")).toBe("one\\u000atwo\\u0009three");
    expect(sanitizeTerminalText("one\ntwo\tthree", { multiline: true }))
      .toBe("one\ntwo\\u0009three");
  });
});

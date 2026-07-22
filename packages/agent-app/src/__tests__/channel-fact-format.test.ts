import { describe, expect, it } from "vitest";

import { describeChannel } from "../background.js";
import { formatChannelFactValue } from "../channel-fact-format.js";
import { describeChannelStatus } from "../cli.js";

// A webhook channel summary with a NESTED object fact — the exact shape that
// rendered as `invokeUrls=[object Object]` (E4). The regression guard below asserts
// no output path can produce `[object Object]` for it.
const WEBHOOK_SUMMARY = {
  invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
  port: 9999,
  invokeUrls: { default: "http://127.0.0.1:9999/webhook/invoke" },
};

describe("formatChannelFactValue", () => {
  it("expands nested objects instead of [object Object]", () => {
    const rendered = formatChannelFactValue(WEBHOOK_SUMMARY.invokeUrls);
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toBe("{default: http://127.0.0.1:9999/webhook/invoke}");
  });

  it("handles primitives, arrays, and empty objects", () => {
    expect(formatChannelFactValue(9999)).toBe("9999");
    expect(formatChannelFactValue(null)).toBe("null");
    expect(formatChannelFactValue([1, { a: 2 }])).toBe("[1, {a: 2}]");
    expect(formatChannelFactValue({})).toBe("{}");
  });
});

describe("channel fact rendering never leaks [object Object] on any output path", () => {
  it("cli status line (describeChannelStatus)", () => {
    const text = describeChannelStatus({ kind: "running", summary: WEBHOOK_SUMMARY });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("invokeUrls={default: http://127.0.0.1:9999/webhook/invoke}");
  });

  it("backgrounded start/status summary (describeChannel)", () => {
    // The persisted trace-source channel entry shape: `{ kind, ...summary }`.
    const { text } = describeChannel({ kind: "running", ...WEBHOOK_SUMMARY });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("invokeUrls={default: http://127.0.0.1:9999/webhook/invoke}");
    expect(text).toContain("port=9999");
  });
});

// Precedence for the Claude SDK tool_result byte cap is PER-GROUP
// (MIGRATION.md §8): a present typed `toolLimits` object wins wholesale for
// its group, so the legacy `settings.agent_tool_payload_max_bytes` key is
// only ever consulted when `toolLimits` is entirely absent.
//   explicit options.toolPayloadMaxBytes
//   -> typed options.toolLimits (present -> group wins wholesale, settings ignored)
//   -> DEPRECATED options.settings.agent_tool_payload_max_bytes (usedSettings)
//   -> MAX_TOOL_RESULT_BYTES default.

import { describe, expect, it } from "vitest";
import { toolPayloadLimit } from "../../ai/providers/claude-sdk.js";
import { MAX_TOOL_RESULT_BYTES } from "../../agent/tool-bloat.js";

describe("claude-sdk toolPayloadLimit precedence", () => {
  it("uses the explicit toolPayloadMaxBytes first (no settings consumed)", () => {
    expect(toolPayloadLimit({ toolPayloadMaxBytes: 4096, toolLimits: { toolPayloadMaxBytes: 1 }, settings: { agent_tool_payload_max_bytes: 2 } }))
      .toEqual({ bytes: 4096, usedSettings: false });
  });

  it("uses the typed toolLimits.toolPayloadMaxBytes next (no settings consumed)", () => {
    expect(toolPayloadLimit({ toolLimits: { toolPayloadMaxBytes: 8192 }, settings: { agent_tool_payload_max_bytes: 2 } }))
      .toEqual({ bytes: 8192, usedSettings: false });
  });

  it("falls back to the DEPRECATED settings key and flags usedSettings", () => {
    expect(toolPayloadLimit({ settings: { agent_tool_payload_max_bytes: 16384 } }))
      .toEqual({ bytes: 16384, usedSettings: true });
  });

  it("uses the default cap when nothing is configured", () => {
    expect(toolPayloadLimit({})).toEqual({ bytes: MAX_TOOL_RESULT_BYTES, usedSettings: false });
  });

  it("ignores a non-positive/non-finite typed value but does NOT fall through to settings (per-group precedence)", () => {
    expect(toolPayloadLimit({ toolPayloadMaxBytes: 0, toolLimits: { toolPayloadMaxBytes: -5 }, settings: { agent_tool_payload_max_bytes: 1024 } }))
      .toEqual({ bytes: MAX_TOOL_RESULT_BYTES, usedSettings: false });
  });

  // A present toolLimits group wins WHOLESALE even when it doesn't carry
  // toolPayloadMaxBytes at all: the settings fallback (and its deprecation
  // warning, gated on usedSettings in claude-sdk.js) must never fire.
  it("ignores settings.agent_tool_payload_max_bytes when toolLimits is present but lacks toolPayloadMaxBytes (no deprecated_settings_option warning)", () => {
    expect(toolPayloadLimit({ toolLimits: { toolTextLimitChars: 500 }, settings: { agent_tool_payload_max_bytes: 999 } }))
      .toEqual({ bytes: MAX_TOOL_RESULT_BYTES, usedSettings: false });
  });
});

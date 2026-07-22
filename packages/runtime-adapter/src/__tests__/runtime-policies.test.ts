import { describe, expect, it } from "vitest";

import { resolveAgentCompactionPolicy } from "@mono-agent/agent-runtime/agent/compaction.js";

import { resolveRuntimePolicies } from "../runtime-policies.js";

describe("resolveRuntimePolicies", () => {
  it("projects a settings bag into the typed toolLimits / compaction objects", () => {
    const { toolLimits, compaction } = resolveRuntimePolicies({
      agent_tool_text_limit_chars: 1500,
      agent_search_result_limit: 40,
      agent_compaction_trigger_ratio: 0.8,
      agent_compaction_fixed_overhead_enabled: false,
    });
    expect(toolLimits.toolTextLimitChars).toBe(1500);
    expect(toolLimits.searchResultLimit).toBe(40);
    expect(compaction.triggerRatio).toBe(0.8);
    expect(compaction.fixedOverheadEnabled).toBe(false);
    // Fields with no settings equivalent are not projected.
    expect(toolLimits.bashTimeoutMs).toBeUndefined();
    expect(compaction.contextWindowOverride).toBeUndefined();
  });

  it("PARITY: the typed objects re-resolve to the same policy as the raw settings bag", () => {
    const settings = {
      agent_tool_text_limit_chars: 1500,
      agent_search_result_limit: 40,
      agent_mcp_call_timeout_ms: 90_000,
      agent_compaction_trigger_ratio: 0.8,
      agent_compaction_keep_recent_tokens: 12_000,
      agent_compaction_summary_max_tokens: 8000,
      agent_compaction_min_savings_tokens: 15_000,
      agent_compaction_enabled: true,
      agent_compaction_fixed_overhead_enabled: false,
    };
    const model = { contextWindow: 200_000 };
    const fromSettings = resolveAgentCompactionPolicy(settings, model);

    const { toolLimits, compaction } = resolveRuntimePolicies(settings);
    // Re-derive a settings-like bag from the typed objects (what a host passing
    // the typed objects to run() would feed the kernel's shim).
    const roundTrip: Record<string, unknown> = {
      agent_tool_text_limit_chars: toolLimits.toolTextLimitChars,
      agent_bash_output_limit_chars: toolLimits.bashOutputLimitChars,
      agent_mcp_text_limit_chars: toolLimits.mcpTextLimitChars,
      agent_search_result_limit: toolLimits.searchResultLimit,
      agent_image_inline_max_bytes: toolLimits.imageInlineMaxBytes,
      agent_tool_payload_max_bytes: toolLimits.toolPayloadMaxBytes,
      agent_mcp_call_timeout_ms: toolLimits.mcpCallTimeoutMs,
      agent_mcp_call_max_total_timeout_ms: toolLimits.mcpCallMaxTotalTimeoutMs,
      agent_compaction_enabled: compaction.enabled,
      agent_compaction_trigger_ratio: compaction.triggerRatio,
      agent_compaction_keep_recent_tokens: compaction.keepRecentTokens,
      agent_compaction_summary_max_tokens: compaction.summaryMaxTokens,
      agent_compaction_min_savings_tokens: compaction.minSavingsTokens,
      agent_compaction_fixed_overhead_enabled: compaction.fixedOverheadEnabled,
    };
    expect(resolveAgentCompactionPolicy(roundTrip, model)).toEqual(fromSettings);
  });

  it("keeps omitted legacy compaction settings omitted so live-model defaults stay adaptive", () => {
    const empty = resolveRuntimePolicies();
    expect(empty.compaction).toEqual({});
    expect(typeof empty.toolLimits.toolTextLimitChars).toBe("number");
  });
});

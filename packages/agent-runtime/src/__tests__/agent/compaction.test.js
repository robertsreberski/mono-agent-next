// Pure helpers in agent/compaction.js.
//
// These have no Agent loop / harness dependency, so they are exercised directly.
// estimateFixedOverheadTokens is the budget-aware-compaction helper that accounts
// for the fixed per-request overhead (system prompt + tool/MCP schemas + per-turn
// user messages) the provider meters but the raw transcript estimate excludes.

import { describe, expect, it } from "vitest";
import {
  DEPRECATED_SETTINGS_WARNING_KIND,
  deprecatedSettingsWarning,
  estimateFixedOverheadTokens,
  resolveAgentCompactionPolicy,
  resolveRuntimePolicyInputs,
} from "../../agent/compaction.js";

// Mirrors pi-ai's chars/4 heuristic so the expected values are derived, not magic.
const tokensForChars = (value) => Math.ceil(String(value ?? "").length / 4);

describe("estimateFixedOverheadTokens", () => {
  it("counts system prompt, tool schemas, and user messages with the chars/4 heuristic", () => {
    const systemPrompt = "x".repeat(400); // 100 tokens
    const tools = [
      { name: "Read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "Grep", description: "search", inputSchema: { type: "object" } },
    ];
    const messages = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: "ignored? no — every message content is counted" },
      { role: "user", content: "second user turn" },
    ];

    const out = estimateFixedOverheadTokens({ systemPrompt, tools, messages });

    const expectedSystem = tokensForChars(systemPrompt);
    const expectedTools = tools.reduce(
      (sum, tool) => sum + tokensForChars(JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema ?? {},
      })),
      0,
    );
    const expectedUsers = messages.reduce(
      (sum, message) => sum + tokensForChars(JSON.stringify(message.content ?? "")),
      0,
    );

    expect(out.systemPromptTokens).toBe(expectedSystem);
    expect(out.toolSchemaTokens).toBe(expectedTools);
    expect(out.userMessageTokens).toBe(expectedUsers);
    expect(out.fixedOverheadTokens).toBe(expectedSystem + expectedTools + expectedUsers);
    expect(expectedSystem).toBe(100);
  });

  it("prefers `parameters`, falls back to `inputSchema`, then to {}", () => {
    const withParameters = estimateFixedOverheadTokens({
      tools: [{ name: "A", description: "d", parameters: { p: 1 }, inputSchema: { other: 2 } }],
    });
    const withInputSchema = estimateFixedOverheadTokens({
      tools: [{ name: "A", description: "d", inputSchema: { other: 2 } }],
    });
    const withNeither = estimateFixedOverheadTokens({
      tools: [{ name: "A", description: "d" }],
    });

    expect(withParameters.toolSchemaTokens).toBe(
      tokensForChars(JSON.stringify({ name: "A", description: "d", parameters: { p: 1 } })),
    );
    expect(withInputSchema.toolSchemaTokens).toBe(
      tokensForChars(JSON.stringify({ name: "A", description: "d", parameters: { other: 2 } })),
    );
    expect(withNeither.toolSchemaTokens).toBe(
      tokensForChars(JSON.stringify({ name: "A", description: "d", parameters: {} })),
    );
  });

  it("counts a circular tool schema as 0 instead of throwing", () => {
    const circular = { name: "loop", description: "d" };
    circular.parameters = circular; // self-reference -> JSON.stringify throws
    const out = estimateFixedOverheadTokens({ tools: [circular] });
    expect(out.toolSchemaTokens).toBe(0);
    expect(out.fixedOverheadTokens).toBe(0);
  });

  it("returns all-zero for empty/undefined input", () => {
    expect(estimateFixedOverheadTokens()).toEqual({
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      userMessageTokens: 0,
      fixedOverheadTokens: 0,
    });
    expect(estimateFixedOverheadTokens({ systemPrompt: "", tools: [], messages: [] })).toEqual({
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      userMessageTokens: 0,
      fixedOverheadTokens: 0,
    });
  });

  it("handles array-shaped user content (text blocks) by stringifying it", () => {
    const content = [{ type: "text", text: "describe this" }, { type: "image", data: "B64" }];
    const out = estimateFixedOverheadTokens({ messages: [{ role: "user", content }] });
    expect(out.userMessageTokens).toBe(tokensForChars(JSON.stringify(content)));
  });
});

describe("resolveAgentCompactionPolicy MCP call timeouts", () => {
  it("defaults mcpCallMaxTotalTimeoutMs to 45 minutes, separate from the 120s inactivity cap", () => {
    const policy = resolveAgentCompactionPolicy({}, null);
    expect(policy.mcpCallTimeoutMs).toBe(120_000);
    expect(policy.mcpCallMaxTotalTimeoutMs).toBe(2_700_000);
  });

  it("reads agent_mcp_call_max_total_timeout_ms from settings and falls back on junk", () => {
    const policy = resolveAgentCompactionPolicy({ agent_mcp_call_max_total_timeout_ms: 300_000 }, null);
    expect(policy.mcpCallMaxTotalTimeoutMs).toBe(300_000);
    const junk = resolveAgentCompactionPolicy({ agent_mcp_call_max_total_timeout_ms: "soon" }, null);
    expect(junk.mcpCallMaxTotalTimeoutMs).toBe(2_700_000);
  });

  it("resolves fixedOverheadEnabled (default true, false only when explicitly disabled)", () => {
    expect(resolveAgentCompactionPolicy({}, null).fixedOverheadEnabled).toBe(true);
    expect(resolveAgentCompactionPolicy({ agent_compaction_fixed_overhead_enabled: false }, null).fixedOverheadEnabled).toBe(false);
    // Any non-false value keeps the default-on behavior.
    expect(resolveAgentCompactionPolicy({ agent_compaction_fixed_overhead_enabled: true }, null).fixedOverheadEnabled).toBe(true);
  });
});

describe("resolveAgentCompactionPolicy adaptive defaults", () => {
  const cases = [
    { window: 32_000, trigger: 16_000, keep: 4_000, summary: 2_000, savings: 4_000 },
    { window: 128_000, trigger: 89_600, keep: 12_800, summary: 5_120, savings: 12_800 },
    { window: 272_000, trigger: 190_400, keep: 20_000, summary: 10_880, savings: 20_000 },
    { window: 372_000, trigger: 260_400, keep: 20_000, summary: 12_000, savings: 20_000 },
  ];

  for (const row of cases) {
    it(`derives conservative defaults for a ${row.window}-token window`, () => {
      const policy = resolveAgentCompactionPolicy({}, { contextWindow: row.window });
      expect(policy).toMatchObject({
        enabled: true,
        contextWindow: row.window,
        triggerRatio: 0.70,
        triggerTokens: row.trigger,
        keepRecentTokens: row.keep,
        summaryMaxTokens: row.summary,
        compactionMinSavingsTokens: row.savings,
        fixedOverheadEnabled: true,
      });
    });
  }

  it("lets every explicit scalar override its adaptive value while retaining existing clamps", () => {
    const policy = resolveAgentCompactionPolicy({
      agent_compaction_enabled: false,
      agent_compaction_trigger_ratio: 0.8,
      agent_compaction_keep_recent_tokens: 9_000,
      agent_compaction_summary_max_tokens: 3_000,
      agent_compaction_min_savings_tokens: 7_000,
      agent_compaction_fixed_overhead_enabled: false,
    }, { contextWindow: 372_000 });
    expect(policy).toMatchObject({
      enabled: false,
      triggerRatio: 0.8,
      triggerTokens: 279_000,
      keepRecentTokens: 9_000,
      summaryMaxTokens: 3_000,
      compactionMinSavingsTokens: 7_000,
      fixedOverheadEnabled: false,
    });
  });
});

describe("resolveRuntimePolicyInputs (typed policy objects <-> deprecated settings shim)", () => {
  it("consumes no settings when typed objects are supplied (per-group precedence)", () => {
    const { settingsLike, consumedSettingsKeys } = resolveRuntimePolicyInputs({
      toolLimits: { toolTextLimitChars: 1000, searchResultLimit: 25 },
      compaction: { triggerRatio: 0.9, enabled: false, fixedOverheadEnabled: false },
    });
    expect(consumedSettingsKeys).toEqual([]);
    expect(settingsLike).toMatchObject({
      agent_tool_text_limit_chars: 1000,
      agent_search_result_limit: 25,
      agent_compaction_trigger_ratio: 0.9,
      agent_compaction_enabled: false,
      agent_compaction_fixed_overhead_enabled: false,
    });
  });

  it("falls back to settings per-group and reports the consumed keys", () => {
    const { settingsLike, consumedSettingsKeys } = resolveRuntimePolicyInputs({
      settings: {
        agent_tool_text_limit_chars: 2000,
        agent_compaction_trigger_ratio: 0.7,
        unrelated_key: "ignored",
      },
    });
    expect(settingsLike).toMatchObject({
      agent_tool_text_limit_chars: 2000,
      agent_compaction_trigger_ratio: 0.7,
    });
    expect(settingsLike.unrelated_key).toBeUndefined();
    expect(consumedSettingsKeys).toEqual(
      expect.arrayContaining(["agent_tool_text_limit_chars", "agent_compaction_trigger_ratio"]),
    );
  });

  it("mixes a typed group with a settings fallback for the OTHER group", () => {
    const { settingsLike, consumedSettingsKeys } = resolveRuntimePolicyInputs({
      toolLimits: { toolTextLimitChars: 1000 },
      // compaction absent -> its settings keys are consumed; toolLimits present ->
      // its settings key is ignored.
      settings: { agent_tool_text_limit_chars: 9999, agent_compaction_trigger_ratio: 0.6 },
    });
    expect(settingsLike.agent_tool_text_limit_chars).toBe(1000); // typed wins for its group
    expect(settingsLike.agent_compaction_trigger_ratio).toBe(0.6); // settings fallback for compaction
    // Only the compaction key was consumed from settings.
    expect(consumedSettingsKeys).toEqual(["agent_compaction_trigger_ratio"]);
  });

  it("reports no consumed keys when neither typed objects nor settings are passed", () => {
    expect(resolveRuntimePolicyInputs()).toEqual({ settingsLike: {}, consumedSettingsKeys: [] });
    expect(resolveRuntimePolicyInputs({ settings: {} })).toEqual({ settingsLike: {}, consumedSettingsKeys: [] });
  });

  it("PARITY: settings and equivalent typed objects resolve to identical policies", () => {
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
    const viaSettings = resolveRuntimePolicyInputs({ settings });
    const viaTyped = resolveRuntimePolicyInputs({
      toolLimits: { toolTextLimitChars: 1500, searchResultLimit: 40, mcpCallTimeoutMs: 90_000 },
      compaction: {
        triggerRatio: 0.8,
        keepRecentTokens: 12_000,
        summaryMaxTokens: 8000,
        minSavingsTokens: 15_000,
        enabled: true,
        fixedOverheadEnabled: false,
      },
    });
    const model = { contextWindow: 200_000 };
    expect(resolveAgentCompactionPolicy(viaTyped.settingsLike, model))
      .toEqual(resolveAgentCompactionPolicy(viaSettings.settingsLike, model));
  });
});

describe("deprecatedSettingsWarning", () => {
  it("builds the one-per-run deprecation warning with the consumed keys", () => {
    const warning = deprecatedSettingsWarning(["agent_tool_text_limit_chars", "agent_compaction_trigger_ratio"]);
    expect(warning.warning_kind).toBe(DEPRECATED_SETTINGS_WARNING_KIND);
    expect(warning.warning_kind).toBe("deprecated_settings_option");
    expect(warning.source).toBe("runtime");
    expect(warning.settings_keys).toEqual(["agent_tool_text_limit_chars", "agent_compaction_trigger_ratio"]);
    expect(warning.message).toContain("deprecated");
    expect(warning.message).toContain("agent_tool_text_limit_chars");
  });
});

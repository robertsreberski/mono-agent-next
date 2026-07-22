import { resolveAgentCompactionPolicy } from "@mono-agent/agent-runtime/agent/compaction.js";

import type { RuntimeCompactionPolicy, RuntimePolicies, RuntimeToolLimits } from "./types.js";

/**
 * Host-side migration helper: project a legacy flat settings bag (the
 * `agent_tool_*` / `agent_mcp_*` / `agent_compaction_*` keys) into the typed
 * `toolLimits` / `compaction` policy objects a host now passes on
 * RuntimeRunOptions. Pass the result's fields straight through to `run()`.
 *
 * This is the SUPPORTED replacement for handing the kernel `runOptions.settings`
 * (which the kernel still accepts as a deprecated per-group fallback, emitting a
 * `deprecated_settings_option` warning when consumed). Resolution reuses the
 * kernel's own clamp/mapper (`resolveAgentCompactionPolicy`) so explicitly
 * supplied values are identical to what the deprecated shim would have
 * resolved — only the transport (typed objects vs. the flat bag) differs.
 * Omitted compaction values remain omitted. The model-derived fields the mapper
 * computes (including adaptive budgets, contextWindow, and triggerTokens) are
 * intentionally NOT projected: they are re-derived at run time against the live
 * model, so the typed objects carry only the run-tunable INPUTS.
 *
 * Fields with no legacy settings equivalent — `toolLimits.bashTimeoutMs` and
 * `compaction.contextWindowOverride` — are omitted here; set them directly on the
 * typed objects if needed.
 */
export function resolveRuntimePolicies(settings?: Record<string, unknown>): RuntimePolicies {
  const input = settings ?? {};
  const resolved = resolveAgentCompactionPolicy(input, {});
  const toolLimits: RuntimeToolLimits = {
    toolTextLimitChars: resolved.toolTextLimitChars,
    bashOutputLimitChars: resolved.bashOutputLimitChars,
    mcpTextLimitChars: resolved.mcpTextLimitChars,
    searchResultLimit: resolved.searchResultLimit,
    imageInlineMaxBytes: resolved.imageInlineMaxBytes,
    toolPayloadMaxBytes: resolved.toolPayloadMaxBytes,
    mcpCallTimeoutMs: resolved.mcpCallTimeoutMs,
    mcpCallMaxTotalTimeoutMs: resolved.mcpCallMaxTotalTimeoutMs,
  };
  // Preserve omission for compaction fields. Adaptive defaults must be derived
  // later against the live model window; projecting the mapper's 128k fallback
  // here would freeze model-specific defaults during host migration.
  const compaction: RuntimeCompactionPolicy = {
    ...(Object.hasOwn(input, "agent_compaction_enabled") ? { enabled: resolved.enabled } : {}),
    ...(Object.hasOwn(input, "agent_compaction_trigger_ratio") ? { triggerRatio: resolved.triggerRatio } : {}),
    ...(Object.hasOwn(input, "agent_compaction_keep_recent_tokens") ? { keepRecentTokens: resolved.keepRecentTokens } : {}),
    ...(Object.hasOwn(input, "agent_compaction_summary_max_tokens") ? { summaryMaxTokens: resolved.summaryMaxTokens } : {}),
    ...(Object.hasOwn(input, "agent_compaction_min_savings_tokens")
      ? { minSavingsTokens: resolved.compactionMinSavingsTokens }
      : {}),
    ...(Object.hasOwn(input, "agent_compaction_fixed_overhead_enabled")
      ? { fixedOverheadEnabled: resolved.fixedOverheadEnabled }
      : {}),
  };
  return { toolLimits, compaction };
}

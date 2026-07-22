// @ts-check

// Context-compaction policy + heuristics for the pi-native bridge.
//
// The hand-rolled in-loop compaction manager (transformContext/afterToolCall)
// was retired with the legacy pi-sdk Agent path — the sole pi bridge uses
// pi-agent-core's AgentHarness, which owns compaction via harness.compact().
// What remains here are two pure helpers the bridge still consumes:
//   - resolveAgentCompactionPolicy: derives the context-window compaction
//     trigger and the tool-output payload limits from settings + the running
//     model. Pure (no Agent loop), so the bridge computes it directly.
//   - isLikelyContextTermination: classifies a provider error/termination as a
//     context-pressure event.

/**
 * @typedef {Object} AgentCompactionPolicy
 * @property {boolean} enabled
 * @property {number} contextWindow
 * @property {number} triggerRatio
 * @property {number} triggerTokens
 * @property {number} keepRecentTokens
 * @property {number} summaryMaxTokens
 * @property {boolean} fixedOverheadEnabled
 * @property {number} compactionMinSavingsTokens
 * @property {number} toolPayloadCompactionTriggerChars
 * @property {number} toolPruneTriggerTokens
 * @property {number} toolTextLimitChars
 * @property {number} bashOutputLimitChars
 * @property {number} mcpTextLimitChars
 * @property {number} searchResultLimit
 * @property {number} imageInlineMaxBytes
 * @property {number} toolPayloadMaxBytes
 * @property {number} mcpCallTimeoutMs
 * @property {number} mcpCallMaxTotalTimeoutMs
 */

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_TRIGGER_RATIO = 0.70;
const DEFAULT_TOOL_PAYLOAD_COMPACTION_TRIGGER_CHARS = 0;
const DEFAULT_TOOL_PRUNE_TRIGGER_TOKENS = 40000;
// intelligence-ramp Phase 3: lifted from 16K/20K/12K. Mid-task tool reads
// (large file edits, long bash output, deep MCP results) were being silently
// clipped before the agent could reason about them. The 256KB hard ceiling
// in tool-bloat.js still protects against runaway payloads.
const DEFAULT_TOOL_TEXT_LIMIT_CHARS = 64000;
const DEFAULT_BASH_OUTPUT_LIMIT_CHARS = 64000;
const DEFAULT_MCP_TEXT_LIMIT_CHARS = 48000;
const DEFAULT_SEARCH_RESULT_LIMIT = 100;
// Images are returned to vision models whole (a Read of an image attachment, an
// MCP screenshot). The byte size is large but token cost is driven by image
// tokens, not base64 length, so allow multi-MB screenshots through instead of
// clipping them to a "[truncated]" summary the model can't see. Clamp ceiling
// (10MB) is enforced in resolveAgentCompactionPolicy.
const DEFAULT_IMAGE_INLINE_MAX_BYTES = 5_000_000;
const DEFAULT_TOOL_PAYLOAD_MAX_BYTES = 262144;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120000;
// Hard wall clock for a single MCP tool call. Progress notifications reset the
// inactivity timeout above but must never extend a call past this cap (45 min) —
// sized for legitimately long tools (audio transcription, ask-the-user waits).
const DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = 2_700_000;

/**
 * @param {*} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {*} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInteger(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max));
}

/**
 * @param {Object<string, *>} [settings]
 * @param {Object} [model]
 * @param {number} [model.contextWindow]
 * @returns {AgentCompactionPolicy}
 */
export function resolveAgentCompactionPolicy(settings = {}, model = {}) {
  const contextWindow = clampInteger(model?.contextWindow, DEFAULT_CONTEXT_WINDOW, 32000, 10_000_000);
  const triggerRatio = clampNumber(
    settings.agent_compaction_trigger_ratio,
    DEFAULT_TRIGGER_RATIO,
    0.2,
    0.95,
  );
  const safetyHeadroom = clampInteger(contextWindow * 0.25, 16000, 16000, 96000);
  // Add a tiny scale-aware epsilon before flooring so decimal ratios such as
  // 0.70 do not lose a token to IEEE-754 representation (372000 * 0.70 is
  // otherwise 260399.99999999997 in JavaScript).
  const ratioTrigger = Math.floor((contextWindow * triggerRatio) + (Number.EPSILON * contextWindow));
  const reserveTrigger = Math.max(1, contextWindow - safetyHeadroom);
  const adaptiveKeepRecentTokens = clampInteger(contextWindow * 0.10, 4000, 4000, 20000);
  const adaptiveSummaryMaxTokens = clampInteger(contextWindow * 0.04, 2000, 2000, 12000);
  const adaptiveMinSavingsTokens = clampInteger(contextWindow * 0.10, 4000, 4000, 20000);
  return {
    enabled: settings.agent_compaction_enabled !== false,
    contextWindow,
    triggerRatio,
    triggerTokens: Math.min(ratioTrigger, reserveTrigger),
    keepRecentTokens: clampInteger(
      settings.agent_compaction_keep_recent_tokens,
      adaptiveKeepRecentTokens,
      4000,
      200000,
    ),
    summaryMaxTokens: clampInteger(
      settings.agent_compaction_summary_max_tokens,
      adaptiveSummaryMaxTokens,
      1000,
      64000,
    ),
    // ON by default; the proactive fixed-overhead correction (system prompt +
    // tool schemas + per-turn message) is disabled only when explicitly false.
    // Read by the compaction driver off the resolved policy so it never has to
    // re-sniff the raw settings/policy inputs.
    fixedOverheadEnabled: settings.agent_compaction_fixed_overhead_enabled !== false,
    compactionMinSavingsTokens: clampInteger(
      settings.agent_compaction_min_savings_tokens,
      adaptiveMinSavingsTokens,
      0,
      500000,
    ),
    toolPayloadCompactionTriggerChars: clampInteger(
      settings.agent_tool_payload_compaction_trigger_chars,
      DEFAULT_TOOL_PAYLOAD_COMPACTION_TRIGGER_CHARS,
      0,
      10 * 1024 * 1024,
    ),
    toolPruneTriggerTokens: clampInteger(settings.agent_tool_prune_trigger_tokens, DEFAULT_TOOL_PRUNE_TRIGGER_TOKENS, 0, 500000),
    toolTextLimitChars: clampInteger(settings.agent_tool_text_limit_chars, DEFAULT_TOOL_TEXT_LIMIT_CHARS, 1000, 200000),
    bashOutputLimitChars: clampInteger(settings.agent_bash_output_limit_chars, DEFAULT_BASH_OUTPUT_LIMIT_CHARS, 1000, 200000),
    mcpTextLimitChars: clampInteger(settings.agent_mcp_text_limit_chars, DEFAULT_MCP_TEXT_LIMIT_CHARS, 1000, 200000),
    searchResultLimit: clampInteger(settings.agent_search_result_limit, DEFAULT_SEARCH_RESULT_LIMIT, 10, 1000),
    imageInlineMaxBytes: clampInteger(settings.agent_image_inline_max_bytes, DEFAULT_IMAGE_INLINE_MAX_BYTES, 0, 10 * 1024 * 1024),
    toolPayloadMaxBytes: clampInteger(settings.agent_tool_payload_max_bytes, DEFAULT_TOOL_PAYLOAD_MAX_BYTES, 0, 16 * 1024 * 1024),
    mcpCallTimeoutMs: clampInteger(settings.agent_mcp_call_timeout_ms, DEFAULT_MCP_CALL_TIMEOUT_MS, 1000, Number.MAX_SAFE_INTEGER),
    mcpCallMaxTotalTimeoutMs: clampInteger(
      settings.agent_mcp_call_max_total_timeout_ms,
      DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
      1000,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

// --- Typed policy objects <-> deprecated `settings` shim -------------------
//
// RuntimeRunOptions now carries typed `toolLimits` / `compaction` policy
// objects. The DEPRECATED `settings` bag remains a per-group fallback: it is
// consumed only when the corresponding typed object is ABSENT, and consuming it
// surfaces one `deprecated_settings_option` runtime_warning per run.
//
// resolveAgentCompactionPolicy stays the canonical settings->policy clamp/mapper
// (its signature is unchanged — worklab deep-imports it). The helpers below
// project the typed objects back onto the same snake_case settings keys so the
// resolution goes through that one clamp path unchanged, whether the values came
// from a typed object or the legacy settings bag.

// Typed toolLimits field -> settings key. `bashTimeoutMs` is intentionally
// ABSENT: no `agent_bash_*_timeout` setting exists today and this phase does not
// invent new timeout behavior, so the field is documented on the RuntimeToolLimits
// typedef but not wired through the settings shim or any tool.
const TOOL_LIMIT_SETTINGS_KEYS = /** @type {const} */ ({
  toolTextLimitChars: "agent_tool_text_limit_chars",
  bashOutputLimitChars: "agent_bash_output_limit_chars",
  mcpTextLimitChars: "agent_mcp_text_limit_chars",
  searchResultLimit: "agent_search_result_limit",
  imageInlineMaxBytes: "agent_image_inline_max_bytes",
  toolPayloadMaxBytes: "agent_tool_payload_max_bytes",
  mcpCallTimeoutMs: "agent_mcp_call_timeout_ms",
  mcpCallMaxTotalTimeoutMs: "agent_mcp_call_max_total_timeout_ms",
});

// Typed compaction field -> settings key. `contextWindowOverride` is ABSENT: it
// has no legacy settings equivalent and is applied directly at the live-window
// resolution site (resolveLiveCompactionPolicy), not through this shim.
const COMPACTION_SETTINGS_KEYS = /** @type {const} */ ({
  enabled: "agent_compaction_enabled",
  triggerRatio: "agent_compaction_trigger_ratio",
  keepRecentTokens: "agent_compaction_keep_recent_tokens",
  summaryMaxTokens: "agent_compaction_summary_max_tokens",
  minSavingsTokens: "agent_compaction_min_savings_tokens",
  fixedOverheadEnabled: "agent_compaction_fixed_overhead_enabled",
});

export const DEPRECATED_SETTINGS_WARNING_KIND = "deprecated_settings_option";

/**
 * @param {Object<string, *>|null|undefined} group
 * @param {Record<string, string>} keyMap
 * @param {Object<string, *>} out
 */
function copyTypedGroup(group, keyMap, out) {
  for (const [field, settingKey] of Object.entries(keyMap)) {
    if (group && group[field] !== undefined) out[settingKey] = group[field];
  }
}

/**
 * @param {Object<string, *>|null|undefined} settings
 * @param {Record<string, string>} keyMap
 * @param {Object<string, *>} out
 * @param {Array<string>} consumed
 */
function copySettingsGroup(settings, keyMap, out, consumed) {
  if (!settings || typeof settings !== "object") return;
  for (const settingKey of Object.values(keyMap)) {
    if (settings[settingKey] !== undefined) {
      out[settingKey] = settings[settingKey];
      consumed.push(settingKey);
    }
  }
}

/**
 * Fold the typed `toolLimits` / `compaction` policy objects and the deprecated
 * `settings` bag into ONE settings-like object resolveAgentCompactionPolicy
 * consumes, honoring PER-GROUP precedence: when a typed object is present its
 * fields win and the legacy settings keys for that group are ignored entirely;
 * when the typed object is absent, that group's settings keys are consumed (and
 * reported in `consumedSettingsKeys` so the caller can emit exactly one
 * deprecation warning per run).
 * @param {{toolLimits?: Object<string, *>, compaction?: Object<string, *>, settings?: Object<string, *>}} [options]
 * @returns {{settingsLike: Object<string, *>, consumedSettingsKeys: Array<string>}}
 */
export function resolveRuntimePolicyInputs({ toolLimits, compaction, settings } = {}) {
  /** @type {Object<string, *>} */
  const settingsLike = {};
  /** @type {Array<string>} */
  const consumedSettingsKeys = [];

  if (toolLimits && typeof toolLimits === "object") {
    copyTypedGroup(toolLimits, TOOL_LIMIT_SETTINGS_KEYS, settingsLike);
  } else {
    copySettingsGroup(settings, TOOL_LIMIT_SETTINGS_KEYS, settingsLike, consumedSettingsKeys);
  }

  if (compaction && typeof compaction === "object") {
    copyTypedGroup(compaction, COMPACTION_SETTINGS_KEYS, settingsLike);
  } else {
    copySettingsGroup(settings, COMPACTION_SETTINGS_KEYS, settingsLike, consumedSettingsKeys);
  }

  return { settingsLike, consumedSettingsKeys };
}

/**
 * Build the one-per-run deprecation warning fired when the legacy `settings`
 * bag was consumed as a policy fallback. Shape matches the other pi/claude
 * bridge runtime warnings ({warning_kind, source, message}).
 * @param {ReadonlyArray<string>} consumedKeys
 * @returns {{warning_kind: string, source: string, message: string, settings_keys: Array<string>}}
 */
export function deprecatedSettingsWarning(consumedKeys) {
  const keys = Array.from(consumedKeys || []);
  return {
    warning_kind: DEPRECATED_SETTINGS_WARNING_KIND,
    source: "runtime",
    message:
      "runOptions.settings is deprecated; pass the typed `toolLimits` / `compaction` policy objects instead "
      + "(host migration helper: resolveRuntimePolicies in @mono-agent/runtime-adapter). Consumed settings keys: "
      + `${keys.join(", ")}.`,
    settings_keys: keys,
  };
}

// Estimate the FIXED per-request overhead the provider meters but the raw
// transcript estimate excludes: the system prompt, the tool/MCP schemas, and the
// per-turn user message(s). estimateCurrentContextTokens' raw branch sums ONLY
// session.buildContext().messages (the transcript), so on a seeded session whose
// last-assistant usage is stale/0 the proactive-compaction trigger under-counts
// and under-fires, letting the real request overflow the window. Adding this
// overhead to the raw estimate makes the trigger reflect what the provider counts.
//
// Uses Math.ceil(len/4) to mirror pi-ai's chars/4 heuristic — consistency with
// the transcript estimate matters more than precision. Pure + dependency-free.
/**
 * @param {Object} [options]
 * @param {string} [options.systemPrompt]
 * @param {Array<Object>} [options.tools]
 * @param {Array<Object>} [options.messages]
 * @returns {{systemPromptTokens: number, toolSchemaTokens: number, userMessageTokens: number, fixedOverheadTokens: number}}
 */
export function estimateFixedOverheadTokens({ systemPrompt, tools, messages } = {}) {
  const tokensForChars = (value) => Math.ceil(String(value ?? "").length / 4);

  const systemPromptTokens = tokensForChars(systemPrompt);

  let toolSchemaTokens = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    try {
      const serialized = JSON.stringify({
        name: tool?.name,
        description: tool?.description,
        parameters: tool?.parameters ?? tool?.inputSchema ?? {},
      });
      toolSchemaTokens += tokensForChars(serialized);
    } catch {
      // Circular/unserializable tool schema — count it as 0 rather than throw.
    }
  }

  let userMessageTokens = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    try {
      userMessageTokens += tokensForChars(JSON.stringify(message?.content ?? ""));
    } catch {
      // Unserializable content — count it as 0 rather than throw.
    }
  }

  return {
    systemPromptTokens,
    toolSchemaTokens,
    userMessageTokens,
    fixedOverheadTokens: systemPromptTokens + toolSchemaTokens + userMessageTokens,
  };
}

/**
 * @param {string} message
 * @param {Object<string, *>} [diagnostics]
 * @returns {boolean}
 */
export function isLikelyContextTermination(message, diagnostics = {}) {
  const text = String(message || "");
  if (!/terminated|aborted before final output|aborted before final|stream.*aborted|context window|context budget/i.test(text)) return false;
  const compactions = Number(diagnostics.context_compactions) || 0;
  if (compactions > 0) return true;
  const estimate = Number(diagnostics.context_tokens_estimate_max || diagnostics.context_tokens_estimate || 0);
  const trigger = Number(diagnostics.context_compaction_trigger_tokens || 0);
  return Boolean(trigger > 0 && estimate >= trigger * 0.85);
}

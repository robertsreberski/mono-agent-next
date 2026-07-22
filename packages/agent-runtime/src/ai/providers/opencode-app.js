import { randomUUID } from "node:crypto";
import { estimateCost } from "../cost.js";
import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";
import { createApprovalManager, RISK_TIERS } from "../../agent/approval.js";
import { resolveSandboxPolicy } from "../../agent/tools/shared/tool-context.js";
import { createIsolatedOpencode } from "./opencode-server.js";
import {
  toolUseEvent,
  toolResultEvent,
  thinkingEvent,
  assistantTextEvent,
  toolPartSettled,
} from "../streaming/opencode-events.js";

// OpenCode agent backend (sdk='opencode', execution_mode='cli'). Drives the local
// `opencode` server via @opencode-ai/sdk/v2 and resolves provider credentials from
// OpenCode's own auth.json (Copilot / ChatGPT / Zen / 75+ providers). Structurally
// modeled on codex-app.js, but over the SDK's HTTP + event-stream surface.
//
// Capability notes (verified against @opencode-ai/sdk/v2):
//   - `session.prompt` blocks until the turn is done and returns the final message.
//   - The v2 prompt accepts a `format` field, but this bridge does not yet enforce
//     structured output; the system prompt asks for JSON and the host can recover
//     it (same as codex-app).
//   - No mid-turn steering primitive and no native-subagent injection in this SDK
//     revision, so supports_live_input / supports_native_subagents are false.
const OPENCODE_APP_CAPABILITIES = {
  kind: "opencode-app",
  runtime: "app-server",
  streaming: true,
  structured_output: false,
  supports_session_resume: false,
  native_runtime_config: null,
  supports_mcp: false,
  supports_skills: false,
  supports_builtin_tools: true,
  supports_live_input: false,
  supports_native_subagents: false,
  supports_fast_mode: false,
};

// How long to keep draining the event stream after session.prompt resolves, in
// case the terminal session.idle event lands just after the HTTP response.
const POST_PROMPT_DRAIN_MS = 1500;
const OPENCODE_ERROR_MESSAGE_MAX_CHARS = 1000;
const OPENCODE_PERMISSION_TOOL_NAMES = {
  read: "Read",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "List",
  bash: "Bash",
  task: "Task",
  external_directory: "ExternalDirectory",
  todowrite: "TodoWrite",
  question: "Question",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  lsp: "LSP",
  doom_loop: "DoomLoop",
  skill: "Skill",
  repo_clone: "RepoClone",
  repo_overview: "RepoOverview",
  plan_enter: "PlanEnter",
  plan_exit: "PlanExit",
};
const OPENCODE_UNSUPPORTED_PERMISSIONS = new Set([
  "question",
  "task",
  "plan_enter",
  "plan_exit",
]);
const OPENCODE_RUN_AGENT = "mono-agent-run";

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    timer.unref?.();
  });
}

function num(value) {
  return Number.isFinite(value) ? value : null;
}

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n\n")
    : String(messages || "");
}

function normalizePermissionMode(permissionMode) {
  return ["plan", "acceptEdits", "bypassPermissions"].includes(permissionMode)
    ? permissionMode
    : "default";
}

function opencodePermissionConfig(permissionMode) {
  const mode = normalizePermissionMode(permissionMode);
  const unsupported = {
    question: "deny",
    task: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
  };
  if (mode === "plan") {
    return {
      "*": "deny",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
      ...unsupported,
    };
  }
  if (mode === "bypassPermissions") {
    return { "*": "allow", ...unsupported };
  }
  return {
    "*": "ask",
    ...unsupported,
    ...(mode === "acceptEdits" ? { edit: "allow" } : {}),
  };
}

function opencodeRunAgent(permission) {
  return {
    name: `${OPENCODE_RUN_AGENT}-${randomUUID()}`,
    config: {
      description: "mono-agent isolated run",
      mode: "primary",
      permission,
    },
  };
}

function opencodePermissionToolName(permissionType) {
  const raw = typeof permissionType === "string" && permissionType.length > 0
    ? permissionType
    : "unknown_permission";
  return OPENCODE_PERMISSION_TOOL_NAMES[raw] || raw;
}

function normalizeApprovalToolName(toolName) {
  if (typeof toolName !== "string" || toolName.trim().length === 0) return null;
  const normalized = toolName.trim();
  const rawPermissionType = Object.keys(OPENCODE_PERMISSION_TOOL_NAMES)
    .find((key) => key.toLowerCase() === normalized.toLowerCase());
  if (rawPermissionType !== undefined) return OPENCODE_PERMISSION_TOOL_NAMES[rawPermissionType];
  const canonical = Object.values(OPENCODE_PERMISSION_TOOL_NAMES)
    .find((name) => name.toLowerCase() === normalized.toLowerCase());
  return canonical || normalized;
}

function opencodeAlwaysAllowTools(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeApprovalToolName).filter(Boolean))];
}

function opencodeRiskTiersByTool(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = { ...source };
  for (const [permissionType, toolName] of Object.entries(OPENCODE_PERMISSION_TOOL_NAMES)) {
    if (normalized[toolName] === undefined && RISK_TIERS.includes(source[permissionType])) {
      normalized[toolName] = source[permissionType];
    }
  }
  return normalized;
}

function opencodeRiskTier(options, permissionType, toolName) {
  const configured = options.toolRiskTiers?.[toolName]
    || options.toolRiskTiers?.[permissionType]
    || options.approvalDefaultRiskTier;
  return RISK_TIERS.includes(configured) ? configured : "medium";
}

function strictOpenCodeApprovalCallback(callback) {
  return async (payload) => {
    const response = await callback(payload);
    if (response?.decision === "approve" || response?.decision === "always" || response?.decision === "deny") {
      return response;
    }
    return { decision: "deny", reason: "invalid_host_response" };
  };
}

function emitForcedApproval(emit, perm, toolName, riskTier, decision, reason) {
  emit({
    type: decision === "deny" ? "tool_approval_denied" : "tool_approval_granted",
    requestId: typeof perm.id === "string" && perm.id.trim().length > 0 ? perm.id : null,
    toolName,
    toolUseId: perm.tool?.callID || null,
    decision,
    reason,
    riskTier,
  });
}

async function opencodePermissionDecision(perm, context) {
  const {
    options,
    reference,
    emit,
    approvalManager,
    alwaysAllowTools,
  } = context;
  const permissionMode = normalizePermissionMode(options.permissionMode);
  const permissionType = typeof perm.permission === "string" ? perm.permission : "unknown_permission";
  const toolName = opencodePermissionToolName(permissionType);
  const riskTier = approvalManager?.riskTierFor(toolName)
    || opencodeRiskTier(options, permissionType, toolName);

  if (permissionMode === "plan") {
    emitForcedApproval(emit, perm, toolName, riskTier, "deny", "permission_mode_plan");
    return "reject";
  }
  if (OPENCODE_UNSUPPORTED_PERMISSIONS.has(permissionType)) {
    emitForcedApproval(emit, perm, toolName, riskTier, "deny", "unsupported_permission_type");
    return "reject";
  }
  if (permissionMode === "bypassPermissions") {
    emitForcedApproval(emit, perm, toolName, riskTier, "always", "permission_mode_bypass");
    return "once";
  }
  if (permissionMode === "acceptEdits" && permissionType === "edit") {
    emitForcedApproval(emit, perm, toolName, riskTier, "always", "permission_mode_accept_edits");
    return "once";
  }

  if (approvalManager === null) {
    if (alwaysAllowTools.has(toolName)) {
      emitForcedApproval(emit, perm, toolName, riskTier, "always", "session_allowed");
      return "once";
    }
    emitForcedApproval(emit, perm, toolName, riskTier, "deny", "no_host_callback");
    return "reject";
  }

  const verdict = await approvalManager.request({
    requestId: perm.id,
    toolName,
    toolUseId: perm.tool?.callID || null,
    input: {
      patterns: Array.isArray(perm.patterns) ? perm.patterns : [],
      metadata: perm.metadata || {},
    },
    model: reference,
  });
  if (verdict.decision === "deny") return "reject";
  // OpenCode's `always` reply persists a project-wide approval. Mono-agent keeps
  // `always` decisions inside this run's ApprovalManager and sends only `once`
  // to the isolated provider server so no user project policy is mutated.
  if (verdict.decision === "always" || approvalManager.isAlwaysAllowed(toolName)) return "once";
  return "once";
}

function opencodePermissionReplyError(code, permissionId = null) {
  return Object.assign(
    new Error(code === "opencode_permission_invalid"
      ? "OpenCode emitted an invalid permission request."
      : "OpenCode could not accept the permission decision; the turn was aborted."),
    {
      opencodeFailureKind: "tool_failure",
      opencodeErrorCode: code,
      opencodePermissionId: typeof permissionId === "string" && permissionId.length > 0
        ? permissionId
        : null,
    },
  );
}

// hey-api RequestResult resolves to { data, error }. Surface errors as throws so
// the caller's try/catch maps them to a failure kind.
function unwrap(result) {
  if (result && typeof result === "object" && ("data" in result || "error" in result)) {
    if (result.error) {
      const message = safeOpenCodeErrorMessage(result.error, "OpenCode request failed.");
      throw Object.assign(new Error(message), { opencodeError: result.error });
    }
    return result.data;
  }
  return result;
}

/**
 * Extract only SDK-declared human-readable fields. In particular, never
 * stringify API error objects: `responseBody`, response headers, and metadata
 * can contain provider credentials or echoed request secrets.
 */
export function safeOpenCodeErrorMessage(error, fallback = "OpenCode request failed.") {
  let candidate;
  try {
    candidate = typeof error?.message === "string" && error.message.trim().length > 0
      ? error.message
      : typeof error?.data?.message === "string" && error.data.message.trim().length > 0
        ? error.data.message
        : undefined;
  } catch {
    candidate = undefined;
  }
  const text = (candidate || fallback).trim();
  if (text.length <= OPENCODE_ERROR_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, OPENCODE_ERROR_MESSAGE_MAX_CHARS - 1)}…`;
}

function usageFromInfo(info) {
  const tokens = info?.tokens || {};
  const cache = tokens.cache || {};
  return {
    input_tokens: num(tokens.input),
    output_tokens: num(tokens.output),
    cache_read_tokens: num(cache.read),
    cache_creation_tokens: num(cache.write),
  };
}

async function opencodeContextWindows(client, directoryParams) {
  try {
    if (typeof client?.provider?.list !== "function") return new Map();
    const listed = unwrap(await client.provider.list(directoryParams));
    const providers = Array.isArray(listed?.all) ? listed.all : [];
    const windows = new Map();
    for (const provider of providers) {
      const models = provider?.models && typeof provider.models === "object"
        ? Object.values(provider.models)
        : [];
      for (const model of models) {
        const providerID = model?.providerID || provider?.id;
        const modelID = model?.id;
        const contextWindow = Number(model?.limit?.context) || 0;
        if (providerID && modelID && contextWindow > 0) {
          windows.set(`${providerID}:${modelID}`, contextWindow);
        }
      }
    }
    return windows;
  } catch {
    return new Map();
  }
}

function contextUsageFromInfo(info, contextWindows, fallbackProviderID, fallbackModelID) {
  if (info?.role !== "assistant" || info.error) return null;
  const total = num(info?.tokens?.total);
  if (total === null || total <= 0) return null;
  const providerID = info.providerID || fallbackProviderID;
  const modelID = info.modelID || fallbackModelID;
  const input = num(info.tokens?.input) || 0;
  const output = num(info.tokens?.output) || 0;
  const reasoning = num(info.tokens?.reasoning) || 0;
  const cachedInput = num(info.tokens?.cache?.read) || 0;
  const cacheCreation = num(info.tokens?.cache?.write) || 0;
  const contextWindow = contextWindows.get(`${providerID}:${modelID}`);
  return {
    model: `opencode:${providerID}:${modelID}`,
    tokens: {
      input: Math.max(0, input - cachedInput),
      cachedInput,
      cacheCreation,
      output,
      reasoning,
      total,
    },
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function aggregateAssistantInfos(infos) {
  const entries = [...infos];
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  const seenUsage = new Set();
  let reportedCost = 0;
  let hasReportedCost = false;
  for (const info of entries) {
    const next = usageFromInfo(info);
    for (const key of Object.keys(totals)) {
      if (Number.isFinite(next[key])) {
        totals[key] += next[key];
        seenUsage.add(key);
      }
    }
    const cost = num(info?.cost);
    if (cost !== null) {
      reportedCost += cost;
      hasReportedCost = true;
    }
  }
  return {
    usage: entries.length === 0
      ? null
      : Object.fromEntries(Object.keys(totals).map((key) => [key, seenUsage.has(key) ? totals[key] : null])),
    reportedCost: hasReportedCost ? reportedCost : null,
  };
}

function finalTextFromParts(parts) {
  const text = (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text")
    .map((p) => p.text || "")
    .join("")
    .trim();
  return text || null;
}

export function mapErrorFailureKind(error) {
  const name = error?.name || error?.data?.name || "";
  if (name === "MessageAbortedError") return "cancelled";
  if (name === "ContextOverflowError") return "context_limit";
  if (name === "MessageOutputLengthError") return "usage_limit";
  if (name === "ProviderAuthError") return "provider_auth";
  return "provider_unavailable";
}

export function mapSpawnFailureKind(err) {
  const text = `${err?.code || ""} ${err?.message || ""}`.toLowerCase();
  if (/enoent|command not found|spawn/.test(text)) return "spawn";
  return "provider_unavailable";
}

function opencodeToolPolicyProblem(options) {
  const allowedTools = Array.isArray(options.allowedTools) ? options.allowedTools : null;
  const disallowedTools = Array.isArray(options.disallowedTools) ? options.disallowedTools : [];
  const exactAllowAll = allowedTools === null
    || (allowedTools.length === 1 && allowedTools[0] === "*");
  return exactAllowAll && disallowedTools.length === 0
    ? null
    : "Direct OpenCode cannot enforce allowedTools/disallowedTools. Use exact allow-all ([\"*\"] with no disallowedTools) or a Pi runtime (including pi:opencode-go:*).";
}

function opencodeCapabilityMismatchResult({
  reference,
  outputSchema,
  start,
  error,
  code,
}) {
  return {
    text: null,
    structuredResult: undefined,
    structuredResultSource: null,
    events: [],
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: reference,
    effort: null,
    sdk: "opencode",
    providerSessionId: null,
    provider_session_id: null,
    cancelled: false,
    error,
    failureKind: "skipped_capability_mismatch",
    diagnostics: { opencode_error_code: code },
    capabilitiesUsed: buildCapabilitiesUsed({
      promptCacheActive: null,
      thinkingEnabled: null,
      structuredOutputEnforced: !!outputSchema,
      subagentInvoked: null,
      mcpServersUsed: [],
      nativeSubagentsUsed: [],
      toolCompactionApplied: false,
      contextCompactionApplied: null,
    }),
  };
}

async function generateOpencodeAppResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model?.sdk
    ? options.model
    : { sdk: "opencode", provider: "", model: String(options.model || "") };
  const providerID = resolved.provider;
  const modelID = resolved.model;
  const reference = resolved.reference || `opencode:${providerID}:${modelID}`;
  const requestedSessionId = (typeof options.providerSessionId === "string" && options.providerSessionId)
    || (typeof options.sessionId === "string" && options.sessionId)
    || null;

  if (requestedSessionId !== null) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode session resume is disabled because each run uses isolated provider state. Start a fresh run or use pi:opencode-go:* for resumable sessions.",
      code: "opencode_session_resume_unsupported",
    });
  }

  if (
    options.outputSchema !== undefined
    && options.outputSchema !== null
  ) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode cannot enforce structured output for outputSchema. Remove outputSchema or use a runtime that advertises structured_output.",
      code: "opencode_structured_output_unsupported",
    });
  }
  if (Array.isArray(options.nativeSubagents?.teammates) && options.nativeSubagents.teammates.length > 0) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode does not expose native subagents through this bridge. Remove nativeSubagents or use a capable runtime.",
      code: "opencode_native_subagents_unsupported",
    });
  }
  if (options.liveInput) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode does not support live input through this bridge. Remove liveInput or use a capable runtime.",
      code: "opencode_live_input_unsupported",
    });
  }
  if (options.fastMode === true) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode does not support fastMode through this bridge. Disable fastMode or use a capable runtime.",
      code: "opencode_fast_mode_unsupported",
    });
  }
  if (Array.isArray(options.skills) && options.skills.length > 0) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode cannot expose runtime skill metadata because external skills are disabled. Use full prompt disclosure, remove skills, or use a Pi runtime.",
      code: "opencode_skills_unsupported",
    });
  }

  if (resolveSandboxPolicy(options.toolContext, options.sandboxPolicy) !== undefined) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode cannot enforce mono-agent's native srt sandbox scopes. Remove the mono-agent sandbox policy or use a Pi runtime (including pi:opencode-go:*) for exact readableRoots, writableRoots, denyWrite, and network rules.",
      code: "opencode_sandbox_policy_unsupported",
    });
  }
  const toolPolicyProblem = opencodeToolPolicyProblem(options);
  if (toolPolicyProblem !== null) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: toolPolicyProblem,
      code: "opencode_tool_policy_unsupported",
    });
  }
  if (Object.keys(options.mcpServers || {}).length > 0) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode cannot safely inject MCP configuration because provider-owned shell tools inherit the server environment. Remove mcpServers or use a Pi runtime (including pi:opencode-go:*).",
      code: "opencode_mcp_unsupported",
    });
  }
  if (typeof options.effort === "string" && options.effort.trim().length > 0) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode has no reasoning-effort input, so runtime.effort cannot be enforced. Remove the effort setting or use a runtime that supports it.",
      code: "opencode_effort_unsupported",
    });
  }
  if (Number.isFinite(Number(options.maxTurns)) && Number(options.maxTurns) > 0) {
    return opencodeCapabilityMismatchResult({
      reference,
      outputSchema: options.outputSchema,
      start,
      error: "Direct OpenCode has no enforceable hard turn cap, so runtime.maxTurns cannot be enforced. Omit maxTurns, set it to 0, or use a runtime that supports a hard cap.",
      code: "opencode_max_turns_unsupported",
    });
  }

  const events = [];
  const emit = (event) => {
    if (!event) return;
    events.push(event);
    try { options.onEvent?.(event); } catch { /* listener errors must not abort the run */ }
  };

  const permission = opencodePermissionConfig(options.permissionMode);
  const alwaysAllowToolNames = opencodeAlwaysAllowTools(options.approvalAlwaysAllowTools);
  const alwaysAllowTools = new Set(alwaysAllowToolNames);
  const approvalManager = typeof options.onToolApprovalRequest === "function"
    ? createApprovalManager({
      onToolApprovalRequest: strictOpenCodeApprovalCallback(options.onToolApprovalRequest),
      defaultRiskTier: options.approvalDefaultRiskTier,
      timeoutMs: options.approvalTimeoutMs,
      onEvent: emit,
      riskTiersByTool: opencodeRiskTiersByTool(options.toolRiskTiers),
      alwaysAllowTools: alwaysAllowToolNames,
      // An OpenCode permission.asked event is an explicit ask. Even a low-risk
      // tier must receive a strict host answer rather than silently widening it.
      autoApproveLowRisk: false,
    })
    : null;
  const runAgent = opencodeRunAgent(permission);
  const directoryParams = typeof options.cwd === "string" && options.cwd.length > 0
    ? { directory: options.cwd }
    : {};
  let sessionId = requestedSessionId;

  let client = null;
  let server = null;
  let usage = null;
  let errorMessage = null;
  let failureKind = null;
  let permissionErrorCode = null;
  let permissionErrorId = null;
  let finalText = null;
  const seenToolUse = new Set();
  const seenToolResult = new Set();
  // v2 sends text/reasoning content as `message.part.delta` events that only
  // identify the part by ID. Remember the owning run + part type from the
  // preceding `message.part.updated` event before accepting any delta.
  const streamParts = new Map();
  const textDeltaPartIds = new Set();
  const reasoningDeltaPartIds = new Set();
  const assistantInfos = new Map();
  const contextUsageSignatures = new Map();
  const compactionStatuses = new Map();
  const activeCompactions = new Map();
  const seenLegacyCompactionIds = new Set();
  let nativeCompactionSeen = false;
  let legacyCompactionMode = false;
  let contextWindows = new Map();

  /**
   * @param {{operationId: string, status: string, trigger?: string, timestamp?: number, reason?: string, message?: string}} event
   */
  const emitCompaction = ({ operationId, status, trigger = "automatic", timestamp, reason, message }) => {
    const previous = compactionStatuses.get(operationId);
    if (previous === status || previous === "succeeded" || previous === "failed" || previous === "skipped") return;
    compactionStatuses.set(operationId, status);
    if (status === "running") activeCompactions.set(operationId, { trigger });
    else activeCompactions.delete(operationId);
    emit({
      type: "context_compaction",
      operationId,
      status,
      sdk: "opencode",
      trigger,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      model: reference,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    });
  };

  const finalizeOpenCompactions = (reason, message) => {
    for (const [operationId, active] of [...activeCompactions]) {
      emitCompaction({
        operationId,
        status: "failed",
        trigger: active.trigger,
        reason,
        message,
      });
    }
  };

  const recordAssistantInfo = (info, fallbackKey, { terminal = false } = {}) => {
    if (info?.role !== "assistant") return;
    const key = typeof info.id === "string" && info.id.length > 0 ? info.id : fallbackKey;
    assistantInfos.set(key, info);
    usage = aggregateAssistantInfos(assistantInfos.values()).usage;
    const completed = terminal
      || Number.isFinite(info?.time?.completed)
      || (typeof info?.finish === "string" && info.finish.length > 0);
    if (!completed) return;
    const contextUsage = contextUsageFromInfo(info, contextWindows, providerID, modelID);
    if (!contextUsage) return;
    const signature = JSON.stringify([contextUsage.model, contextUsage.contextWindow, contextUsage.tokens]);
    if (contextUsageSignatures.get(key) === signature) return;
    contextUsageSignatures.set(key, signature);
    emit({
      type: "context_usage",
      sdk: "opencode",
      model: contextUsage.model,
      timestamp: Number.isFinite(info?.time?.completed) ? info.time.completed : Date.now(),
      measurementId: key,
      ...(contextUsage.contextWindow === undefined ? {} : { contextWindow: contextUsage.contextWindow }),
      tokens: contextUsage.tokens,
    });
  };

  const abortHandler = () => {
    try {
      const abortResult = sessionId
        ? client?.session?.abort?.({ sessionID: sessionId, ...directoryParams })
        : undefined;
      if (abortResult !== undefined) {
        void Promise.resolve(abortResult).catch(() => undefined);
      }
    } catch { /* best effort */ }
  };

  try {
    const opencode = await createIsolatedOpencode(/** @type {any} */ ({
      hostname: "127.0.0.1",
      port: 0,
      config: {
        permission,
        agent: { [runAgent.name]: runAgent.config },
      },
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    }));
    client = opencode.client;
    server = opencode.server;
    options.abortSignal?.addEventListener?.("abort", abortHandler, { once: true });
    contextWindows = await opencodeContextWindows(client, directoryParams);

    if (!sessionId) {
      const created = unwrap(await client.session.create(directoryParams));
      sessionId = created?.id;
      if (!sessionId) throw new Error("opencode did not return a session id");
    }

    let pumpDone = false;
    let rejectPermissionFailure;
    const permissionFailure = new Promise((_, reject) => {
      rejectPermissionFailure = reject;
    });
    // The prompt race below observes this rejection. Keep a second handler so a
    // very fast prompt resolution cannot turn a later permission failure into
    // an unhandled rejection while the event pump drains.
    void permissionFailure.catch(() => undefined);

    const failPermissionReply = (error) => {
      if (permissionErrorCode !== null) return;
      permissionErrorCode = error.opencodeErrorCode || "opencode_permission_reply_failed";
      permissionErrorId = error.opencodePermissionId || null;
      errorMessage = error.message;
      failureKind = error.opencodeFailureKind || "tool_failure";
      pumpDone = true;
      rejectPermissionFailure(error);
      try {
        const abortResult = client.session.abort({
          sessionID: sessionId,
          ...directoryParams,
        });
        void Promise.resolve(abortResult).catch(() => undefined);
      } catch { /* the raced failure already terminates the run */ }
    };

    const respondToPermission = async (perm) => {
      if (perm.sessionID && perm.sessionID !== sessionId) return;
      if (typeof perm.id !== "string" || perm.id.trim().length === 0) {
        const permissionType = typeof perm.permission === "string" ? perm.permission : "unknown_permission";
        const toolName = opencodePermissionToolName(permissionType);
        emitForcedApproval(
          emit,
          perm,
          toolName,
          approvalManager?.riskTierFor(toolName) || opencodeRiskTier(options, permissionType, toolName),
          "deny",
          "invalid_permission_id",
        );
        failPermissionReply(opencodePermissionReplyError("opencode_permission_invalid"));
        return;
      }
      if (typeof perm.permission !== "string" || perm.permission.trim().length === 0) {
        const toolName = opencodePermissionToolName(perm.permission);
        emitForcedApproval(
          emit,
          perm,
          toolName,
          approvalManager?.riskTierFor(toolName) || opencodeRiskTier(options, perm.permission, toolName),
          "deny",
          "invalid_permission_type",
        );
        failPermissionReply(opencodePermissionReplyError("opencode_permission_invalid", perm.id));
        return;
      }
      const decision = await opencodePermissionDecision(perm, {
        options,
        reference,
        emit,
        approvalManager,
        alwaysAllowTools,
      });
      try {
        const processed = unwrap(await client.permission.reply({
          requestID: perm.id,
          reply: decision,
          ...directoryParams,
        }));
        if (processed !== true) {
          throw opencodePermissionReplyError("opencode_permission_reply_failed", perm.id);
        }
      } catch {
        failPermissionReply(opencodePermissionReplyError("opencode_permission_reply_failed", perm.id));
      }
    };

    const handleEvent = async (event) => {
      if (!event || typeof event !== "object") return;
      const props = event.properties || {};
      switch (event.type) {
        case "message.part.updated": {
          const part = props.part;
          if (
            !part
            || (props.sessionID && props.sessionID !== sessionId)
            || (part.sessionID && part.sessionID !== sessionId)
          ) return;
          if (typeof part.id === "string" && part.id.length > 0) {
            streamParts.set(part.id, {
              type: part.type,
              sessionID: part.sessionID || props.sessionID || sessionId,
              ...(part.type === "reasoning" && typeof part.text === "string"
                ? { latestText: part.text }
                : {}),
            });
          }
          if (part.type === "tool") {
            if (!seenToolUse.has(part.callID)) {
              seenToolUse.add(part.callID);
              emit(toolUseEvent(part));
            }
            if (toolPartSettled(part) && !seenToolResult.has(part.callID)) {
              seenToolResult.add(part.callID);
              emit(toolResultEvent(part));
            }
          }
          return;
        }
        case "message.part.delta": {
          if (
            props.sessionID !== sessionId
            || props.field !== "text"
            || typeof props.partID !== "string"
            || typeof props.delta !== "string"
            || props.delta.length === 0
          ) return;
          const tracked = streamParts.get(props.partID);
          if (!tracked || tracked.sessionID !== sessionId) return;
          if (tracked.type === "text") {
            textDeltaPartIds.add(props.partID);
            emit(assistantTextEvent(props.delta));
          } else if (tracked.type === "reasoning") {
            reasoningDeltaPartIds.add(props.partID);
            emit(thinkingEvent({ text: props.delta }));
          }
          return;
        }
        case "message.updated": {
          const info = props.info;
          recordAssistantInfo(info, "event-anonymous");
          return;
        }
        case "session.next.compaction.started": {
          if (props.sessionID && props.sessionID !== sessionId) return;
          nativeCompactionSeen = true;
          if (legacyCompactionMode) return;
          const operationId = `opencode:${sessionId}:${props.messageID || event.id || "compaction"}`;
          emitCompaction({
            operationId,
            status: "running",
            trigger: props.reason === "manual" ? "manual" : "automatic",
            timestamp: props.timestamp,
          });
          return;
        }
        case "session.next.compaction.ended": {
          if (props.sessionID && props.sessionID !== sessionId) return;
          nativeCompactionSeen = true;
          if (legacyCompactionMode) return;
          const operationId = `opencode:${sessionId}:${props.messageID || event.id || "compaction"}`;
          emitCompaction({
            operationId,
            status: "succeeded",
            trigger: props.reason === "manual" ? "manual" : "automatic",
            timestamp: props.timestamp,
          });
          return;
        }
        case "session.compacted": {
          if (props.sessionID && props.sessionID !== sessionId) return;
          if (nativeCompactionSeen) return;
          legacyCompactionMode = true;
          const legacyId = typeof event.id === "string" && event.id.length > 0
            ? event.id
            : randomUUID();
          if (seenLegacyCompactionIds.has(legacyId)) return;
          seenLegacyCompactionIds.add(legacyId);
          emitCompaction({
            operationId: `opencode:${sessionId}:legacy:${legacyId}`,
            status: "succeeded",
          });
          return;
        }
        case "permission.asked":
          await respondToPermission(props);
          return;
        case "session.error":
          if (props.sessionID && props.sessionID !== sessionId) return;
          errorMessage = safeOpenCodeErrorMessage(props.error, "OpenCode session error.");
          failureKind = mapErrorFailureKind(props.error);
          finalizeOpenCompactions("provider_error", "Compaction was interrupted by a provider error.");
          pumpDone = true;
          return;
        case "session.idle":
          if (props.sessionID === sessionId) {
            finalizeOpenCompactions("incomplete", "Compaction ended without a completion event.");
            pumpDone = true;
          }
          return;
        default:
          return;
      }
    };

    const subscription = await client.event.subscribe(directoryParams);
    const pump = (async () => {
      try {
        for await (const event of subscription.stream) {
          await handleEvent(event);
          if (pumpDone) break;
        }
      } catch { /* stream closed; teardown handles the rest */ }
    })();

    const promptRequest = client.session.prompt({
      sessionID: sessionId,
      ...directoryParams,
      model: { providerID, modelID },
      system: systemPrompt,
      agent: runAgent.name,
      parts: [{ type: "text", text: promptFromMessages(options.messages) }],
    });
    void Promise.resolve(promptRequest).catch(() => undefined);
    const promptResult = unwrap(await Promise.race([promptRequest, permissionFailure]));

    // Let the pump drain to the terminal session.idle (which lands around when
    // prompt resolves); don't force-stop it or in-flight tool events are lost.
    await Promise.race([pump, delay(POST_PROMPT_DRAIN_MS)]);

    // Some providers send only completed reasoning-part updates, while others
    // stream deltas and then repeat the completed text. Keep the live deltas;
    // emit the latest completed text only for parts that never streamed.
    for (const [partID, part] of streamParts) {
      if (
        part.type === "reasoning"
        && !reasoningDeltaPartIds.has(partID)
        && typeof part.latestText === "string"
        && part.latestText.length > 0
      ) {
        emit(thinkingEvent({ text: part.latestText }));
      }
    }

    const info = promptResult?.info || {};
    recordAssistantInfo(info, "prompt-final", { terminal: true });
    if (info.error && !errorMessage) {
      errorMessage = safeOpenCodeErrorMessage(info.error, "OpenCode turn failed.");
      failureKind = mapErrorFailureKind(info.error);
    }
    const finalParts = Array.isArray(promptResult?.parts) ? promptResult.parts : [];
    finalText = finalTextFromParts(finalParts);
    // `session.prompt` returns complete parts after streaming. Deduplicate by
    // part ID rather than globally: a multi-part response may stream one part
    // while another arrives only in the final response.
    for (const part of finalParts) {
      if (
        part?.type === "text"
        && typeof part.text === "string"
        && part.text.length > 0
        && !(typeof part.id === "string" && textDeltaPartIds.has(part.id))
      ) {
        emit(assistantTextEvent(part.text));
      }
    }

    const aggregate = aggregateAssistantInfos(assistantInfos.values());
    usage = aggregate.usage;
    const reportedCost = aggregate.reportedCost;
    const costUsd = reportedCost !== null ? reportedCost : estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: Math.max(0, (usage?.input_tokens || 0) - (usage?.cache_read_tokens || 0)),
      outputTokens: usage?.output_tokens || 0,
      cachedTokens: usage?.cache_read_tokens || 0,
      cacheWriteTokens: usage?.cache_creation_tokens || 0,
    });

    return {
      text: finalText,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: { ...(usage || {}), cost_usd: costUsd },
      durationMs: Date.now() - start,
      numTurns: Math.max(1, assistantInfos.size),
      model: reference,
      effort: null,
      sdk: "opencode",
      providerSessionId: null,
      provider_session_id: null,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind,
      diagnostics: permissionErrorCode === null
        ? {}
        : {
          opencode_error_code: permissionErrorCode,
          ...(permissionErrorId === null ? {} : { opencode_permission_id: permissionErrorId }),
        },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: (usage?.cache_read_tokens || 0) > 0 || (usage?.cache_creation_tokens || 0) > 0,
        thinkingEnabled: null,
        structuredOutputEnforced: false,
        subagentInvoked: null,
        mcpServersUsed: [],
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } catch (err) {
    finalizeOpenCompactions(
      options.abortSignal?.aborted ? "cancelled" : "provider_error",
      options.abortSignal?.aborted ? "Compaction was interrupted." : "Compaction was interrupted by a provider error.",
    );
    const partialAggregate = aggregateAssistantInfos(assistantInfos.values());
    const partialUsage = partialAggregate.usage ?? usage;
    const partialCost = partialAggregate.reportedCost !== null
      ? partialAggregate.reportedCost
      : partialUsage === null
        ? 0
        : estimateCost({
          resolveCustomPricing: options.resolveCustomPricing,
          model: reference,
          inputTokens: Math.max(0, (partialUsage.input_tokens || 0) - (partialUsage.cache_read_tokens || 0)),
          outputTokens: partialUsage.output_tokens || 0,
          cachedTokens: partialUsage.cache_read_tokens || 0,
          cacheWriteTokens: partialUsage.cache_creation_tokens || 0,
        });
    return {
      text: finalText,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: partialUsage ? { ...partialUsage, cost_usd: partialCost } : null,
      durationMs: Date.now() - start,
      numTurns: assistantInfos.size > 0 ? assistantInfos.size : (events.length ? 1 : 0),
      model: reference,
      effort: null,
      sdk: "opencode",
      providerSessionId: null,
      provider_session_id: null,
      cancelled: !!options.abortSignal?.aborted,
      error: err?.message || String(err),
      failureKind: failureKind
        || err?.opencodeFailureKind
        || (err?.opencodeError ? mapErrorFailureKind(err.opencodeError) : mapSpawnFailureKind(err)),
      diagnostics: {
        ...(events.length ? { had_partial_progress: true } : {}),
        ...((err?.opencodeErrorCode || permissionErrorCode) === null || (err?.opencodeErrorCode || permissionErrorCode) === undefined
          ? {}
          : { opencode_error_code: err?.opencodeErrorCode || permissionErrorCode }),
        ...((err?.opencodePermissionId || permissionErrorId) === null || (err?.opencodePermissionId || permissionErrorId) === undefined
          ? {}
          : { opencode_permission_id: err?.opencodePermissionId || permissionErrorId }),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        structuredOutputEnforced: false,
        mcpServersUsed: [],
      }),
    };
  } finally {
    finalizeOpenCompactions(
      options.abortSignal?.aborted ? "cancelled" : "incomplete",
      options.abortSignal?.aborted ? "Compaction was interrupted." : "Compaction ended without a completion event.",
    );
    options.abortSignal?.removeEventListener?.("abort", abortHandler);
    try { await server?.close?.(); } catch { /* best effort */ }
  }
}

export const opencodeAppRuntimeBridge = {
  id: "opencode-app",
  kind: "opencode-app",
  capabilities: OPENCODE_APP_CAPABILITIES,
  supports: (ref, options) => ref?.sdk === "opencode" && options?.executionMode === "cli",
  execute: generateOpencodeAppResponse,
};

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  parseApprovalDecision,
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  RuntimeTurnError,
} from "@mono-agent/module-sdk";
import type {
  ApprovalRequest,
  JsonObject,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleDrainContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStartContext,
  ModuleStopContext,
  Runtime,
  RuntimeSession,
  RuntimeSideEffectStatus,
  RuntimeRetryability,
  RuntimeTurnContext,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  RuntimeNativeToolDescriptor,
  TurnMessage,
} from "@mono-agent/module-sdk";

import type { RuntimeCodexConfig } from "./config.js";
import { codexProcessEnvironment } from "./environment.js";
import {
  JsonRpcProcess,
  JsonRpcRequestError,
  type JsonRpcMessage,
  type JsonRpcServerRequest,
  type ProcessLike,
  type SpawnProcess,
} from "./json-rpc.js";
import {
  isRuntimeCodexModel,
  runtimeCodexCapabilities,
  runtimeCodexCommandEscalationTool,
  runtimeCodexFileChangeEscalationTool,
  validateRuntimeCodexModel,
} from "./model.js";

type RuntimeState = "created" | "running" | "draining" | "stopped";

export class RuntimeCodexError extends RuntimeTurnError {
  constructor(
    code: string,
    message: string,
    options: {
      readonly retryability?: RuntimeRetryability;
      readonly sideEffects?: RuntimeSideEffectStatus;
      readonly cause?: unknown;
    } = {},
  ) {
    super({
      code,
      message,
      retryability: options.retryability ?? "unknown",
      sideEffects: options.sideEffects ?? "none",
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "RuntimeCodexError";
  }
}

export interface CreateRuntimeCodexOptions {
  readonly config: RuntimeCodexConfig;
  readonly instanceId: string;
  readonly workspaceDirectory: string;
  readonly dataDirectory: string;
  readonly spawnProcess?: SpawnProcess;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return record(record(value)[key]);
}

function messageText(message: TurnMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "tool-call") parts.push(`[tool call ${part.call.name}: ${JSON.stringify(part.call.input)}]`);
    else if (part.type === "tool-result") parts.push(`[tool result ${part.result.callId}: ${JSON.stringify(part.result.content)}]`);
    else throw new RuntimeCodexError("ATTACHMENT_UNSUPPORTED", "runtime-codex does not accept binary attachments", { retryability: "not-retryable" });
  }
  return parts.join("\n");
}

function authoredSystem(messages: readonly TurnMessage[]): string | undefined {
  const text = messages.filter((message) => message.role === "system").map(messageText).filter(Boolean);
  return text.length === 0 ? undefined : text.join("\n\n");
}

function prompt(messages: readonly TurnMessage[], resumed: boolean): string {
  if (resumed) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") return messageText(message);
    }
  }
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${messageText(message)}`)
    .join("\n\n");
}

function session(
  instanceId: string,
  id: string,
  conversationId: string,
  model: string,
): RuntimeSession {
  return {
    id,
    conversationId,
    route: { runtimeInstanceId: instanceId, model },
    createdAt: new Date().toISOString(),
    metadata: { provider: "codex", protocol: "codex-app-server-v2" },
  };
}

function assertSessionLinkage(
  request: RuntimeTurnRequest,
  instanceId: string,
): void {
  if (request.session === undefined) return;
  if (request.session.route?.runtimeInstanceId !== instanceId) {
    throw new RuntimeCodexError(
      "SESSION_INVALID",
      "Codex session belongs to another runtime instance",
      { retryability: "not-retryable" },
    );
  }
  if (request.session.route.model !== request.model) {
    throw new RuntimeCodexError(
      "SESSION_INVALID",
      "Codex session belongs to another model route",
      { retryability: "not-retryable" },
    );
  }
  if (request.session.conversationId !== request.conversationId) {
    throw new RuntimeCodexError(
      "SESSION_INVALID",
      "Codex session belongs to another conversation",
      { retryability: "not-retryable" },
    );
  }
}

function diagnostic(code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic {
  return { code, severity, message };
}

function redact(value: unknown, secret: string | undefined): string {
  let message = "Codex provider operation failed";
  if (typeof value === "string") {
    message = value;
  } else if (value instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    if (
      descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string"
    ) {
      message = descriptor.value;
    }
  }
  if (secret !== undefined && secret.length > 0) message = message.split(secret).join("[REDACTED]");
  message = message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  return message.length <= 4_096 ? message : `${message.slice(0, 4_095)}…`;
}

function safeErrorCause(value: unknown, secret: string | undefined): Error {
  const cause = new Error(redact(value, secret));
  cause.name = "RuntimeCodexCause";
  return cause;
}

function resultThreadId(value: unknown): string | undefined {
  const thread = nestedRecord(value, "thread");
  return typeof thread.id === "string" ? thread.id : undefined;
}

function resultTurnId(value: unknown): string | undefined {
  const turn = nestedRecord(value, "turn");
  return typeof turn.id === "string" ? turn.id : undefined;
}

function isMissingCodexSession(
  error: unknown,
  threadId: string,
): boolean {
  if (!(error instanceof JsonRpcRequestError)) return false;
  return error.rpcMessage === `no rollout found for thread id ${threadId}`
    || error.rpcMessage === `thread not found: ${threadId}`;
}

function notificationMatches(params: Record<string, unknown>, threadId: string, turnId: string | undefined): boolean {
  if (params.threadId !== undefined && params.threadId !== threadId) return false;
  return turnId === undefined || params.turnId === undefined || params.turnId === turnId
    || record(params.turn).id === turnId;
}

type CodexApprovalOutcome = "allow" | "deny" | "cancel";
type CodexApprovalPolicy = "on-request" | "never";

const APPROVAL_SUMMARY_MAX_BYTES = 16_000;
const MAX_TRACKED_APPROVAL_ITEMS = 64;
const SUPPORTED_CODEX_VERSION = "codex-cli 0.145.0";
const PREFLIGHT_OUTPUT_MAX_BYTES = 65_536;
const MAX_EFFECTIVE_MCP_SERVERS = 64;
const MAX_MCP_SERVER_NAME_BYTES = 256;
const MAX_MCP_OVERRIDE_BYTES = 32_768;
const INERT_MCP_COMMAND = "/usr/bin/false";
const INERT_MCP_URL = "http://127.0.0.1:1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const DIRECTIONAL_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/iu;

const CODEX_DISABLED_FEATURES = Object.freeze([
  "apply_patch_freeform",
  "apply_patch_streaming_events",
  "apps",
  "apps_mcp_path_override",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "codex_git_commit",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_only",
  "collaboration_modes",
  "concurrent_reasoning_summaries",
  "computer_use",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "elevated_windows_sandbox",
  "enable_fanout",
  "enable_mcp_apps",
  "enable_request_compression",
  "exec_permission_approvals",
  "executor_capability_discovery",
  "experimental_windows_sandbox",
  "external_agent_memory_import",
  "external_migration",
  "fast_mode",
  "goals",
  "guardian_approval",
  "hooks",
  "image_detail_original",
  "image_generation",
  "in_app_browser",
  "item_ids",
  "js_repl",
  "js_repl_tools_only",
  "local_thread_store_compression",
  "memories",
  "mentions_v2",
  "multi_agent",
  "multi_agent_mode",
  "multi_agent_v2",
  "network_proxy",
  "non_prefixed_mcp_tool_names",
  "personality",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "prevent_idle_sleep",
  "realtime_conversation",
  "remote_compaction_v2",
  "remote_control",
  "remote_models",
  "remote_plugin",
  "request_permissions_tool",
  "request_rule",
  "resize_all_images",
  "respect_system_proxy",
  "responses_websockets",
  "responses_websockets_v2",
  "rollout_budget",
  "runtime_metrics",
  "search_tool",
  "secret_auth_storage",
  "shell_snapshot",
  "shell_zsh_fork",
  "skill_env_var_dependency_prompt",
  "skill_mcp_dependency_install",
  "skill_search",
  "sqlite",
  "standalone_web_search",
  "steer",
  "terminal_resize_reflow",
  "terminal_visualization_instructions",
  "token_budget",
  "tool_call_mcp_elicitation",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "tool_suggest",
  "tui_app_server",
  "unavailable_dummy_tools",
  "undo",
  "unified_exec_zsh_fork",
  "use_agent_identity",
  "use_legacy_landlock",
  "use_linux_sandbox_bwrap",
  "web_search_cached",
  "web_search_request",
  "web_search",
  "workspace_dependencies",
  "workspace_owner_usage_nudge",
  // 0.145 compatibility aliases must be disabled alongside their canonical
  // feature so a lower-precedence config cannot revive the authority.
  "codex_hooks",
  "collab",
  "connectors",
  "imagegenext",
  "memory_tool",
  "request_permissions",
  "telepathy",
] as const);

const CODEX_ENABLED_FEATURES = Object.freeze([
  "shell_tool",
  "unified_exec",
] as const);

const CODEX_HOOK_EVENTS = Object.freeze([
  "PermissionRequest",
  "PostCompact",
  "PostToolUse",
  "PreCompact",
  "PreToolUse",
  "SessionEnd",
  "SessionStart",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
] as const);

function approvalPolicy(context: RuntimeTurnContext): CodexApprovalPolicy {
  return context.requestApproval === undefined ? "never" : "on-request";
}

type CodexMcpTransport = "stdio" | "streamable_http";

interface EffectiveCodexMcpServer {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: CodexMcpTransport;
}

function inertMcpServerConfig(
  transport: CodexMcpTransport,
): Record<string, unknown> {
  return transport === "stdio"
    ? {
        enabled: false,
        required: false,
        command: INERT_MCP_COMMAND,
        args: [],
      }
    : { enabled: false, required: false, url: INERT_MCP_URL };
}

function containedCodexConfig(
  mcpServers: readonly EffectiveCodexMcpServer[],
): Record<string, unknown> {
  return {
    mcp_servers: Object.fromEntries(mcpServers.map((server) => [
      server.name,
      inertMcpServerConfig(server.transport),
    ])),
    notify: [],
    web_search: "disabled",
    model_provider: "openai",
    openai_base_url: "",
    chatgpt_base_url: "https://chatgpt.com/backend-api/",
    approvals_reviewer: "user",
    approval_policy: "never",
    sandbox_mode: "read-only",
    allow_login_shell: false,
    check_for_update_on_startup: false,
    hooks: Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, []])),
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    include_permissions_instructions: false,
    experimental_use_unified_exec_tool: false,
    plugins: {},
    skills: {
      config: [],
      include_instructions: false,
    },
    tool_suggest: {
      discoverables: [],
    },
    analytics: { enabled: false },
    feedback: { enabled: false },
    otel: {
      exporter: "none",
      metrics_exporter: "none",
      trace_exporter: "none",
      log_user_prompt: false,
    },
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
    features: {
      ...Object.fromEntries(CODEX_DISABLED_FEATURES.map((feature) => [
        feature,
        false,
      ])),
      ...Object.fromEntries(CODEX_ENABLED_FEATURES.map((feature) => [
        feature,
        true,
      ])),
    },
  };
}

function tomlBasicString(value: string): string {
  let encoded = '"';
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) throw new Error("Codex MCP server name is invalid");
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error("Codex MCP server name contains invalid Unicode");
    }
    index += codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x22) encoded += '\\"';
    else if (codePoint === 0x5c) encoded += "\\\\";
    else if (codePoint === 0x08) encoded += "\\b";
    else if (codePoint === 0x09) encoded += "\\t";
    else if (codePoint === 0x0a) encoded += "\\n";
    else if (codePoint === 0x0c) encoded += "\\f";
    else if (codePoint === 0x0d) encoded += "\\r";
    else if (codePoint <= 0x1f || codePoint === 0x7f) {
      encoded += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      encoded += String.fromCodePoint(codePoint);
    }
  }
  return `${encoded}"`;
}

function mcpDisableConfigArguments(
  servers: readonly EffectiveCodexMcpServer[],
): readonly string[] {
  if (servers.length === 0) return [];
  const entries = servers.map((server) => {
    const config = server.transport === "stdio"
      ? `enabled=false,required=false,command=${tomlBasicString(INERT_MCP_COMMAND)},args=[]`
      : `enabled=false,required=false,url=${tomlBasicString(INERT_MCP_URL)}`;
    return `${tomlBasicString(server.name)}={${config}}`;
  });
  const override = `mcp_servers={${entries.join(",")}}`;
  if (Buffer.byteLength(override, "utf8") > MAX_MCP_OVERRIDE_BYTES) {
    throw new Error("Codex MCP disable override exceeds the bounded size limit");
  }
  return ["-c", override];
}

function codexProcessConfigArguments(
  mcpServers: readonly EffectiveCodexMcpServer[] = [],
): readonly string[] {
  const overrides = [
    "project_doc_max_bytes=0",
    'approval_policy="never"',
    'approvals_reviewer="user"',
    'sandbox_mode="read-only"',
    "allow_login_shell=false",
    'model_provider="openai"',
    'openai_base_url=""',
    'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    "check_for_update_on_startup=false",
    "include_apps_instructions=false",
    "include_collaboration_mode_instructions=false",
    "include_environment_context=false",
    "include_permissions_instructions=false",
    "experimental_use_unified_exec_tool=false",
    "analytics.enabled=false",
    "feedback.enabled=false",
    'otel.exporter="none"',
    'otel.metrics_exporter="none"',
    'otel.trace_exporter="none"',
    "otel.log_user_prompt=false",
    "notify=[]",
    "mcp_servers={}",
    "plugins={}",
    "skills.config=[]",
    "skills.include_instructions=false",
    "tool_suggest.discoverables=[]",
    ...CODEX_HOOK_EVENTS.map((event) => `hooks.${event}=[]`),
    ...CODEX_DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
    ...CODEX_ENABLED_FEATURES.map((feature) => `features.${feature}=true`),
  ];
  return [
    ...overrides.flatMap((value) => ["-c", value]),
    ...mcpDisableConfigArguments(mcpServers),
  ];
}

function approvalCallId(params: Record<string, unknown>): string {
  for (const key of ["approvalId", "itemId", "callId"]) {
    const candidate = params[key];
    if (
      typeof candidate === "string"
      && candidate.length <= 256
      && IDENTIFIER.test(candidate)
    ) {
      return candidate;
    }
  }
  return `codex-call-${randomUUID()}`;
}

function approvalText(value: unknown): string | readonly string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (
    Array.isArray(value)
    && value.length > 0
    && value.every((candidate) => typeof candidate === "string")
  ) {
    return [...value];
  }
  return undefined;
}

function approvalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface FileChangeAuthority {
  readonly path: string;
  readonly kind?: string;
}

type CodexItemEvidence =
  | {
      readonly type: "commandExecution";
      readonly command?: string;
      readonly cwd?: string;
    }
  | {
      readonly type: "fileChange";
      readonly changes: readonly FileChangeAuthority[];
    };

function fileChangeAuthority(value: unknown): readonly FileChangeAuthority[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: FileChangeAuthority[] = [];
  for (const candidate of value) {
    const change = record(candidate);
    if (typeof change.path !== "string" || change.path.trim() === "") return undefined;
    changes.push({
      path: change.path,
      ...(typeof change.kind === "string" ? { kind: change.kind } : {}),
    });
  }
  return changes;
}

function exactApprovalSummary(
  title: string,
  authority: Record<string, unknown>,
  secret: string | undefined,
): string | undefined {
  let encoded: string;
  try {
    encoded = JSON.stringify(authority);
  } catch {
    return undefined;
  }
  if (
    encoded === undefined
    || DIRECTIONAL_CONTROLS.test(encoded)
    || BEARER_TOKEN.test(encoded)
    || (secret !== undefined && secret.length > 0 && encoded.includes(secret))
  ) {
    return undefined;
  }
  encoded = encoded
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const summary = `${title}\nExact authority JSON: ${encoded}`;
  return Buffer.byteLength(summary, "utf8") <= APPROVAL_SUMMARY_MAX_BYTES
    ? summary
    : undefined;
}

function commandApprovalSummary(
  params: Record<string, unknown>,
  evidence: CodexItemEvidence | undefined,
  secret: string | undefined,
): string | undefined {
  const command = approvalText(params.command)
    ?? (evidence?.type === "commandExecution" ? evidence.command : undefined);
  if (command === undefined) return undefined;
  const cwd = approvalString(params.cwd)
    ?? (evidence?.type === "commandExecution" ? evidence.cwd : undefined);
  return exactApprovalSummary(
    "Codex requests permission to execute a command.",
    {
      command,
      cwd: cwd ?? null,
      reason: approvalString(params.reason) ?? null,
      networkApprovalContext: params.networkApprovalContext ?? null,
      additionalPermissions: params.additionalPermissions ?? null,
    },
    secret,
  );
}

function fileChangeApprovalSummary(
  params: Record<string, unknown>,
  evidence: CodexItemEvidence | undefined,
  secret: string | undefined,
): string | undefined {
  const fileChanges = record(params.fileChanges);
  const legacyChanges = Object.keys(fileChanges)
    .sort()
    .map((path) => ({ path }));
  const changes = legacyChanges.length > 0
    ? legacyChanges
    : evidence?.type === "fileChange"
      ? evidence.changes
      : [];
  const grantRoot = approvalString(params.grantRoot);
  if (changes.length === 0 && grantRoot === undefined) return undefined;
  return exactApprovalSummary(
    "Codex requests permission to change files.",
    {
      changes,
      grantRoot: grantRoot ?? null,
      reason: approvalString(params.reason) ?? null,
    },
    secret,
  );
}

function approvalRouteMatches(
  method: string,
  params: Record<string, unknown>,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  if (threadId === undefined) return false;
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return params.conversationId === threadId;
  }
  return params.threadId === threadId
    && turnId !== undefined
    && params.turnId === turnId;
}

function captureApprovalEvidence(
  message: JsonRpcMessage,
  evidence: Map<string, CodexItemEvidence>,
): void {
  const params = record(message.params);
  if (message.method === "item/started") {
    const item = record(params.item);
    if (typeof item.id !== "string") return;
    let next: CodexItemEvidence | undefined;
    if (item.type === "commandExecution") {
      const command = approvalString(item.command);
      const cwd = approvalString(item.cwd);
      next = {
        type: "commandExecution",
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
      };
    } else if (item.type === "fileChange") {
      const changes = fileChangeAuthority(item.changes);
      if (changes !== undefined) next = { type: "fileChange", changes };
    }
    if (
      next !== undefined
      && (evidence.has(item.id) || evidence.size < MAX_TRACKED_APPROVAL_ITEMS)
    ) {
      evidence.set(item.id, next);
    }
    return;
  }
  if (
    message.method === "item/fileChange/patchUpdated"
    && typeof params.itemId === "string"
  ) {
    const changes = fileChangeAuthority(params.changes);
    if (
      changes !== undefined
      && (evidence.has(params.itemId) || evidence.size < MAX_TRACKED_APPROVAL_ITEMS)
    ) {
      evidence.set(params.itemId, { type: "fileChange", changes });
    }
  }
}

async function coreApproval(
  context: RuntimeTurnContext,
  signal: AbortSignal,
  descriptor: RuntimeNativeToolDescriptor,
  callId: string,
  summary: string,
  timeoutMs: number,
): Promise<CodexApprovalOutcome> {
  if (signal.aborted) return "cancel";
  if (context.requestApproval === undefined) return "deny";
  const request: ApprovalRequest = {
    interactionId: `codex-${randomUUID()}`,
    callId,
    toolId: descriptor.id,
    displayName: descriptor.displayName,
    effects: descriptor.effects,
    summary,
    requestedAt: new Date().toISOString(),
  };
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const callback = Promise.resolve()
      .then(async () => context.requestApproval?.(request, signal))
      .then((decision) => {
        if (decision === undefined) return "deny" as const;
        const parsed = parseApprovalDecision(decision, request);
        return parsed.decision === "allow_once" ? "allow" as const : "deny" as const;
      })
      .catch(() => "deny" as const);
    const timeout = new Promise<"deny">((resolve) => {
      timer = setTimeout(() => resolve("deny"), timeoutMs);
      timer.unref?.();
    });
    const cancelled = new Promise<"cancel">((resolve) => {
      abortHandler = () => resolve("cancel");
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    });
    const outcome = await Promise.race([callback, timeout, cancelled]);
    return signal.aborted ? "cancel" : outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function v2ApprovalResponse(outcome: CodexApprovalOutcome): {
  readonly decision: "accept" | "decline" | "cancel";
} {
  return {
    decision: outcome === "allow"
      ? "accept"
      : outcome === "cancel"
        ? "cancel"
        : "decline",
  };
}

function v2CommandApprovalResponse(
  outcome: CodexApprovalOutcome,
  params: Record<string, unknown>,
): { readonly decision: "accept" | "decline" | "cancel" } {
  if (
    outcome === "allow"
    && Array.isArray(params.availableDecisions)
    && !params.availableDecisions.includes("accept")
  ) {
    return { decision: "decline" };
  }
  return v2ApprovalResponse(outcome);
}

function legacyApprovalResponse(outcome: CodexApprovalOutcome): {
  readonly decision: "approved" | "abort" | {
    readonly denied: { readonly rejection: string };
  };
} {
  return {
    decision: outcome === "allow"
      ? "approved"
      : outcome === "cancel"
        ? "abort"
        : { denied: { rejection: "Denied by mono-agent policy" } },
  };
}

async function handleCodexServerRequest(
  message: JsonRpcServerRequest,
  context: RuntimeTurnContext,
  signal: AbortSignal,
  threadId: string | undefined,
  turnId: string | undefined,
  evidence: ReadonlyMap<string, CodexItemEvidence>,
  secret: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const params = record(message.params);
  const itemEvidence = typeof params.itemId === "string"
    ? evidence.get(params.itemId)
    : undefined;
  const routeMatches = approvalRouteMatches(
    message.method,
    params,
    threadId,
    turnId,
  );

  if (message.method === "item/commandExecution/requestApproval") {
    const summary = commandApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexCommandEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return v2CommandApprovalResponse(outcome, params);
  }
  if (message.method === "item/fileChange/requestApproval") {
    const summary = fileChangeApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexFileChangeEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return v2ApprovalResponse(outcome);
  }
  if (message.method === "execCommandApproval") {
    const summary = commandApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexCommandEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return legacyApprovalResponse(outcome);
  }
  if (message.method === "applyPatchApproval") {
    const summary = fileChangeApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexFileChangeEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return legacyApprovalResponse(outcome);
  }
  if (message.method === "item/permissions/requestApproval") {
    // The provider protocol has no explicit denial variant for permission
    // profiles. An empty, turn-scoped grant is the protocol-correct
    // fail-closed response; runtime-codex never echoes requested authority.
    return {
      permissions: {},
      scope: "turn",
      strictAutoReview: true,
    };
  }
  throw new Error(`Unsupported Codex server request: ${message.method}`);
}

function errnoCode(error: unknown): string | undefined {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("runtime-codex requires POSIX ownership checks");
  }
  return process.getuid();
}

function assertOwnedDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
  path: string,
  exactPrivate: boolean,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${path} must be a regular directory, not a symbolic link`);
  }
  if (info.uid !== currentUid()) {
    throw new Error(`${path} must be owned by the current user`);
  }
  const mode = Number(info.mode) & 0o777;
  if (exactPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) {
    throw new Error(exactPrivate
      ? `${path} must have mode 0700`
      : `${path} must not be group/world writable`);
  }
}

async function prepareDataDirectory(authoredPath: string): Promise<string> {
  const root = resolve(authoredPath);
  const missing: string[] = [];
  let cursor = root;
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  while (existing === undefined) {
    existing = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) {
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("runtime-codex data directory has no existing parent");
      missing.unshift(cursor);
      cursor = parent;
    }
  }
  assertOwnedDirectory(existing, cursor, false);
  if (await realpath(cursor) !== cursor) {
    throw new Error("runtime-codex data directory ancestors must not traverse symbolic links");
  }
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 });
    const created = await lstat(path);
    assertOwnedDirectory(created, path, true);
    if (await realpath(path) !== path) {
      throw new Error("runtime-codex data directory creation crossed a symbolic link");
    }
  }
  return root;
}

async function preparePersistentCodexHome(dataDirectory: string): Promise<string> {
  const root = await prepareDataDirectory(dataDirectory);
  const codexHome = join(root, "codex-home");
  const existing = await lstat(codexHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) {
    await mkdir(codexHome, { mode: 0o700 });
  }
  const prepared = await lstat(codexHome);
  assertOwnedDirectory(prepared, codexHome, true);
  if (await realpath(codexHome) !== codexHome) {
    throw new Error("runtime-codex contained home must be a canonical non-symlink path");
  }
  const config = await lstat(join(codexHome, "config.toml")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (config !== undefined) {
    throw new Error("runtime-codex contained home must not contain config.toml");
  }
  return codexHome;
}

async function resolveNativeCodexHome(): Promise<string> {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const userHome = process.env.HOME?.trim();
  const authored = configuredHome !== undefined && configuredHome !== ""
    ? configuredHome
    : userHome === undefined || userHome === ""
      ? undefined
      : join(userHome, ".codex");
  if (authored === undefined) {
    throw new Error("runtime-codex native auth requires CODEX_HOME or HOME");
  }
  const canonical = await realpath(resolve(authored));
  const info = await lstat(canonical);
  assertOwnedDirectory(info, canonical, false);
  return canonical;
}

async function createProcessWorkingDirectory(): Promise<{
  readonly directory: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mono-agent-codex-process-"));
  const info = await lstat(directory);
  assertOwnedDirectory(info, directory, true);
  return {
    directory,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

interface DirectProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function defaultDirectSpawn(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
  },
): ProcessLike {
  return spawn(command, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

async function runBoundedProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly spawnProcess?: SpawnProcess;
}): Promise<DirectProcessResult> {
  if (options.signal.aborted) throw cancellationError(options.signal);
  const launch = options.spawnProcess ?? defaultDirectSpawn;
  const child = launch(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });
  return new Promise<DirectProcessResult>((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      result: DirectProcessResult | undefined,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (error !== undefined) rejectResult(error);
      else if (result !== undefined) resolveResult(result);
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stream === "stdout") stdout += value;
      else stderr += value;
      if (
        Buffer.byteLength(stream === "stdout" ? stdout : stderr, "utf8")
        > PREFLIGHT_OUTPUT_MAX_BYTES
      ) {
        child.kill("SIGKILL");
        finish(undefined, new Error(`Codex ${stream} exceeded the preflight output limit`));
      }
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
      finish(undefined, cancellationError(options.signal));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined, new Error("Codex preflight timed out"));
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", (error) => finish(undefined, error));
    child.once("close", (code, signal) => {
      finish({ code, signal, stdout, stderr });
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdin.end();
    if (options.signal.aborted) onAbort();
  });
}

function codexAppServerArguments(
  mcpServers: readonly EffectiveCodexMcpServer[],
): readonly string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
    ...codexProcessConfigArguments(mcpServers),
  ];
}

function assertCleanProcessResult(
  result: DirectProcessResult,
  operation: string,
): void {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${operation} exited unsuccessfully`);
  }
  if (result.stderr.trim() !== "") {
    throw new Error(`${operation} emitted stderr`);
  }
}

function parseEffectiveMcpServers(
  output: string,
  operation: string,
): readonly EffectiveCodexMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${operation} emitted malformed JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${operation} did not return a server array`);
  }
  if (parsed.length > MAX_EFFECTIVE_MCP_SERVERS) {
    throw new Error(`${operation} exceeded the MCP server-count limit`);
  }
  const names = new Set<string>();
  const servers: EffectiveCodexMcpServer[] = [];
  for (const candidate of parsed) {
    const entry = record(candidate);
    const name = entry.name;
    const enabled = entry.enabled;
    const transport = record(entry.transport).type;
    if (
      typeof name !== "string"
      || Buffer.byteLength(name, "utf8") > MAX_MCP_SERVER_NAME_BYTES
      || typeof enabled !== "boolean"
      || (transport !== "stdio" && transport !== "streamable_http")
    ) {
      throw new Error(`${operation} returned an invalid MCP server entry`);
    }
    if (names.has(name)) {
      throw new Error(`${operation} returned duplicate MCP server names`);
    }
    // Exercise the same encoder used in the frozen CLI override now, before
    // any provider process is allowed to start.
    tomlBasicString(name);
    names.add(name);
    servers.push({ name, enabled, transport });
  }
  return servers.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

async function preflightCodexProcess(options: {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly spawnProcess?: SpawnProcess;
  readonly probeStrictConfig: boolean;
}): Promise<readonly EffectiveCodexMcpServer[]> {
  const run = async (args: readonly string[]): Promise<DirectProcessResult> =>
    runBoundedProcess({ ...options, args });
  const version = await run(["--version"]);
  assertCleanProcessResult(version, "Codex version preflight");
  if (version.stdout.trim() !== SUPPORTED_CODEX_VERSION) {
    throw new Error(`runtime-codex requires exactly ${SUPPORTED_CODEX_VERSION}`);
  }

  const discovery = await run([
    "mcp",
    "list",
    "--json",
    ...codexProcessConfigArguments(),
  ]);
  assertCleanProcessResult(discovery, "Codex MCP discovery preflight");
  const configuredServers = parseEffectiveMcpServers(
    discovery.stdout,
    "Codex MCP discovery preflight",
  );

  if (options.probeStrictConfig) {
    const strictConfig = await run(codexAppServerArguments(configuredServers));
    assertCleanProcessResult(strictConfig, "Codex strict-config preflight");
    if (strictConfig.stdout.trim() !== "") {
      throw new Error("Codex strict-config preflight emitted unexpected output");
    }
  }

  const mcp = await run([
    "mcp",
    "list",
    "--json",
    ...codexProcessConfigArguments(configuredServers),
  ]);
  assertCleanProcessResult(mcp, "Codex MCP preflight");
  const verifiedServers = parseEffectiveMcpServers(
    mcp.stdout,
    "Codex MCP preflight",
  );
  if (
    verifiedServers.length !== configuredServers.length
    || verifiedServers.some((server, index) =>
      server.name !== configuredServers[index]?.name
      || server.transport !== configuredServers[index]?.transport
    )
  ) {
    throw new Error("Codex MCP server set changed during containment preflight");
  }
  if (verifiedServers.some((server) => server.enabled)) {
    throw new Error("runtime-codex could not disable every effective Codex MCP server");
  }
  return verifiedServers;
}

function assertFrozenAppServerMcpConfig(
  value: unknown,
  expected: readonly EffectiveCodexMcpServer[],
): void {
  const response = record(value);
  if (
    response.config === null
    || typeof response.config !== "object"
    || Array.isArray(response.config)
  ) {
    throw new Error("Codex app-server returned malformed effective config");
  }
  const config = response.config as Record<string, unknown>;
  if (
    config.mcp_servers === null
    || typeof config.mcp_servers !== "object"
    || Array.isArray(config.mcp_servers)
  ) {
    throw new Error("Codex app-server returned malformed effective MCP config");
  }
  const mcpServers = config.mcp_servers as Record<string, unknown>;
  const actualNames = Object.keys(mcpServers).sort();
  const expectedNames = expected.map((server) => server.name).sort();
  if (
    actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Codex app-server MCP config changed after containment preflight");
  }
  const expectedByName = new Map(expected.map((server) => [
    server.name,
    server,
  ]));
  for (const name of actualNames) {
    const server = expectedByName.get(name);
    const actual = record(mcpServers[name]);
    if (
      server === undefined
      || actual.enabled !== false
      || actual.required === true
    ) {
      throw new Error("Codex app-server exposed an enabled MCP server");
    }
    if (
      server.transport === "stdio"
      && (
        actual.command !== INERT_MCP_COMMAND
        || !Array.isArray(actual.args)
        || actual.args.length !== 0
        || actual.url !== undefined
      )
    ) {
      throw new Error("Codex app-server changed an inert MCP transport");
    }
    if (
      server.transport === "streamable_http"
      && (
        actual.url !== INERT_MCP_URL
        || actual.command !== undefined
      )
    ) {
      throw new Error("Codex app-server changed an inert MCP transport");
    }
  }
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex turn was cancelled");
}

async function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw cancellationError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

export function createRuntimeCodex(options: CreateRuntimeCodexOptions): Runtime {
  let state: RuntimeState = "created";
  const active = new Set<JsonRpcProcess>();
  let codexHome: string | undefined;
  let startMcpServers: readonly EffectiveCodexMcpServer[] | undefined;

  const processEnvironment = (home: string): NodeJS.ProcessEnv => ({
    ...codexProcessEnvironment(options.config.auth === undefined
      ? {}
      : { OPENAI_API_KEY: options.config.auth.apiKey }),
    CODEX_HOME: home,
  });

  const newClient = (
    processDirectory: string,
    home: string,
    mcpServers: readonly EffectiveCodexMcpServer[],
  ): JsonRpcProcess => new JsonRpcProcess({
    command: options.config.binary,
    args: codexAppServerArguments(mcpServers),
    cwd: processDirectory,
    env: processEnvironment(home),
    timeoutMs: options.config.requestTimeoutMs,
    maxLineBytes: options.config.maxLineBytes,
    maxStderrBytes: options.config.maxStderrBytes,
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
  });

  return {
    capabilities: runtimeCodexCapabilities,

    async start(context: ModuleStartContext) {
      if (state === "stopped") throw new RuntimeCodexError("RUNTIME_NOT_RUNNING", "runtime-codex cannot restart after stop", { retryability: "not-retryable" });
      if (state === "running") return;
      let processDirectory:
        | Awaited<ReturnType<typeof createProcessWorkingDirectory>>
        | undefined;
      try {
        const preparedHome = options.config.auth === undefined
          ? await resolveNativeCodexHome()
          : await preparePersistentCodexHome(options.dataDirectory);
        processDirectory = await createProcessWorkingDirectory();
        startMcpServers = await preflightCodexProcess({
          command: options.config.binary,
          cwd: processDirectory.directory,
          env: processEnvironment(preparedHome),
          timeoutMs: Math.min(options.config.requestTimeoutMs, 15_000),
          signal: context.signal,
          ...(options.spawnProcess === undefined
            ? {}
            : { spawnProcess: options.spawnProcess }),
          probeStrictConfig: true,
        });
        codexHome = preparedHome;
      } catch (error) {
        throw new RuntimeCodexError(
          "RUNTIME_PREFLIGHT_FAILED",
          redact(error, options.config.auth?.apiKey),
          {
            retryability: "not-retryable",
            sideEffects: "none",
            cause: safeErrorCause(error, options.config.auth?.apiKey),
          },
        );
      } finally {
        await processDirectory?.cleanup();
      }
      state = "running";
    },

    async drain(_context: ModuleDrainContext) {
      if (state !== "stopped") state = "draining";
    },

    async stop(_context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      await Promise.allSettled([...active].map(async (client) => client.close()));
      active.clear();
      state = "stopped";
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      return {
        status: state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown",
        checkedAt: new Date().toISOString(),
        summary: `runtime-codex is ${state}`,
        details: { state, activeTurns: active.size },
      };
    },

    diagnostics(_context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
      return [diagnostic("runtime-codex.lifecycle", "info", `Runtime state: ${state}`)];
    },

    preflightModel(request) {
      request.signal.throwIfAborted();
      return validateRuntimeCodexModel({
        model: request.model,
        config: options.config,
      });
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimeCodexError("RUNTIME_NOT_RUNNING", `runtime-codex is ${state}`, { retryability: "not-retryable" });
      if (!isRuntimeCodexModel(request.model)) throw new RuntimeCodexError("MODEL_INVALID", "Codex model identifier is invalid", { retryability: "not-retryable" });
      if (request.tools.length > 0) throw new RuntimeCodexError("TOOLS_UNSUPPORTED", "runtime-codex does not expose Core tools", { retryability: "not-retryable" });
      assertSessionLinkage(request, options.instanceId);
      if (request.signal.aborted) return { status: "cancelled" };

      const preparedHome = codexHome;
      if (preparedHome === undefined || startMcpServers === undefined) {
        throw new RuntimeCodexError(
          "RUNTIME_NOT_RUNNING",
          "runtime-codex has no preflighted process home",
          { retryability: "not-retryable" },
        );
      }
      let turnMcpServers: readonly EffectiveCodexMcpServer[];
      let processDirectory:
        | Awaited<ReturnType<typeof createProcessWorkingDirectory>>
        | undefined;
      try {
        processDirectory = await createProcessWorkingDirectory();
        turnMcpServers = await preflightCodexProcess({
          command: options.config.binary,
          cwd: processDirectory.directory,
          env: processEnvironment(preparedHome),
          timeoutMs: Math.min(options.config.requestTimeoutMs, 15_000),
          signal: request.signal,
          ...(options.spawnProcess === undefined
            ? {}
            : { spawnProcess: options.spawnProcess }),
          probeStrictConfig: false,
        });
      } catch (error) {
        await processDirectory?.cleanup();
        throw new RuntimeCodexError(
          "PROVIDER_FAILED",
          "runtime-codex could not preflight its isolated provider process",
          {
            retryability: "unknown",
            sideEffects: "none",
            cause: safeErrorCause(error, options.config.auth?.apiKey),
          },
        );
      }
      let client: JsonRpcProcess;
      try {
        client = newClient(
          processDirectory.directory,
          preparedHome,
          turnMcpServers,
        );
      } catch (error) {
        await processDirectory.cleanup();
        throw new RuntimeCodexError(
          "PROVIDER_FAILED",
          redact(error, options.config.auth?.apiKey),
          {
            retryability: "unknown",
            sideEffects: "none",
            cause: safeErrorCause(error, options.config.auth?.apiKey),
          },
        );
      }
      active.add(client);
      const clientRequest = async (method: string, params: unknown): Promise<unknown> =>
        abortable(async () => client.request(method, params), request.signal);
      const clientNotify = async (method: string, params: unknown): Promise<void> =>
        abortable(async () => client.notify(method, params), request.signal);
      let threadId: string | undefined;
      let turnId: string | undefined;
      let turnStartPending = false;
      let resolveTurnIdentity!: () => void;
      let turnIdentitySettled = false;
      const turnIdentityReady = new Promise<void>((resolve) => {
        resolveTurnIdentity = () => {
          if (turnIdentitySettled) return;
          turnIdentitySettled = true;
          resolve();
        };
      });
      let output = "";
      const nativeApprovalPolicy = approvalPolicy(context);
      const streamedItemIds = new Set<string>();
      const approvalEvidence = new Map<string, CodexItemEvidence>();
      let terminalResolve!: (message: JsonRpcMessage) => void;
      let terminalReject!: (error: Error) => void;
      const terminal = new Promise<JsonRpcMessage>((resolve, reject) => {
        terminalResolve = resolve;
        terminalReject = reject;
      });
      const unsubscribe = client.subscribe((message) => {
        if (message.method === undefined || threadId === undefined) return;
        const params = record(message.params);
        if (!notificationMatches(params, threadId, turnId)) return;
        captureApprovalEvidence(message, approvalEvidence);
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
          if (typeof params.itemId === "string") streamedItemIds.add(params.itemId);
          output += params.delta;
          void context.emit({ type: "text-delta", delta: params.delta });
        } else if (message.method === "item/completed") {
          const item = record(params.item);
          if (item.type === "agentMessage" && typeof item.text === "string"
            && (typeof item.id !== "string" || !streamedItemIds.has(item.id))) {
            output += item.text;
            void context.emit({ type: "text-delta", delta: item.text });
          }
        } else if ((message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") && typeof params.delta === "string") {
          void context.emit({ type: "thinking-delta", delta: params.delta });
        } else if (message.method === "turn/completed") terminalResolve(message);
        else if (message.method === "error" || message.method === "$transport/closed") {
          terminalReject(new Error(redact(
            typeof params.message === "string" ? params.message : "Codex turn failed",
            options.config.auth?.apiKey,
          )));
        }
      });
      const unregisterServerRequests = client.handleServerRequests(
        async (message) => {
          if (
            turnStartPending
            && turnId === undefined
            && (
              message.method === "item/commandExecution/requestApproval"
              || message.method === "item/fileChange/requestApproval"
              || message.method === "item/permissions/requestApproval"
            )
          ) {
            await turnIdentityReady;
          }
          return handleCodexServerRequest(
            message,
            context,
            request.signal,
            threadId,
            turnId,
            approvalEvidence,
            options.config.auth?.apiKey,
            options.config.requestTimeoutMs,
          );
        },
      );

      const onAbort = (): void => {
        resolveTurnIdentity();
        if (threadId !== undefined && turnId !== undefined) void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        void client.close().catch(() => undefined);
        terminalResolve({ method: "cancelled" });
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      let unregisterLiveInput: (() => void) | undefined;
      try {
        await clientRequest("initialize", {
          clientInfo: { name: "mono-agent", title: "mono-agent runtime-codex", version: "0.15.0" },
          capabilities: { experimentalApi: false },
        });
        await clientNotify("initialized", {});
        const effectiveConfig = await clientRequest("config/read", {
          includeLayers: false,
          cwd: processDirectory.directory,
        });
        assertFrozenAppServerMcpConfig(effectiveConfig, turnMcpServers);
        const workspaceConfig = await clientRequest("config/read", {
          includeLayers: false,
          cwd: options.workspaceDirectory,
        });
        assertFrozenAppServerMcpConfig(workspaceConfig, turnMcpServers);

        const system = authoredSystem(request.messages);
        const threadResult = request.session === undefined
          ? await clientRequest("thread/start", {
              cwd: options.workspaceDirectory,
              model: request.model,
              approvalPolicy: nativeApprovalPolicy,
              approvalsReviewer: "user",
              sandbox: "read-only",
              ephemeral: false,
              config: containedCodexConfig(turnMcpServers),
              ...(system === undefined ? {} : { developerInstructions: system }),
            })
          : await clientRequest("thread/resume", {
              threadId: request.session.id,
              cwd: options.workspaceDirectory,
              model: request.model,
              approvalPolicy: nativeApprovalPolicy,
              approvalsReviewer: "user",
              sandbox: "read-only",
              config: containedCodexConfig(turnMcpServers),
              ...(system === undefined ? {} : { developerInstructions: system }),
            });
        threadId = resultThreadId(threadResult);
        if (threadId === undefined) throw new Error("Codex app-server did not return a thread id");
        const linked = session(
          options.instanceId,
          threadId,
          request.conversationId,
          request.model,
        );
        await context.emit({ type: "session", session: linked });

        if (context.registerLiveInput !== undefined) {
          unregisterLiveInput = context.registerLiveInput(async (input) => {
            if (threadId === undefined || turnId === undefined || request.signal.aborted) return "requeue";
            try {
              await abortable(
                async () => client.request("turn/steer", {
                  threadId,
                  expectedTurnId: turnId,
                  input: [{ type: "text", text: input.text }],
                }),
                request.signal,
              );
              return "applied";
            } catch {
              return "requeue";
            }
          });
        }

        let turnResult: unknown;
        turnStartPending = true;
        try {
          turnResult = await clientRequest("turn/start", {
            threadId,
            model: request.model,
            approvalPolicy: nativeApprovalPolicy,
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            input: [{ type: "text", text: prompt(request.messages, request.session !== undefined) }],
            ...(request.options?.effort === undefined ? {} : { effort: request.options.effort }),
            ...(request.options?.responseSchema === undefined ? {} : { outputSchema: request.options.responseSchema }),
          });
          turnId = resultTurnId(turnResult);
          if (turnId === undefined) throw new Error("Codex app-server did not return a turn id");
        } finally {
          turnStartPending = false;
          resolveTurnIdentity();
        }
        if (request.signal.aborted) onAbort();
        const completed = await terminal;
        const linkedSession = session(
          options.instanceId,
          threadId,
          request.conversationId,
          request.model,
        );
        if (request.signal.aborted || completed.method === "cancelled") {
          return { status: "cancelled", session: linkedSession };
        }
        const turn = nestedRecord(completed.params, "turn");
        if (turn.status !== "completed") {
          const error = record(turn.error);
          throw new RuntimeCodexError(
            "PROVIDER_FAILED",
            redact(typeof error.message === "string" ? error.message : "Codex turn failed", options.config.auth?.apiKey),
            { retryability: "unknown", sideEffects: "unknown" },
          );
        }
        if (output === "" && Array.isArray(turn.items)) {
          output = turn.items.map((candidate) => {
            const item = record(candidate);
            return item.type === "agentMessage" && typeof item.text === "string" ? item.text : "";
          }).join("");
          if (output !== "") await context.emit({ type: "text-delta", delta: output });
        }
        let structuredOutput;
        if (request.options?.responseSchema !== undefined) {
          try { structuredOutput = JSON.parse(output); }
          catch (error) {
            throw new RuntimeCodexError("PROTOCOL_INVALID", "Codex structured response was not valid JSON", {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: safeErrorCause(error, options.config.auth?.apiKey),
            });
          }
        }
        return {
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text: output }] },
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          session: linkedSession,
          metadata: { provider: "codex", model: request.model, nativeTurnId: turnId } as JsonObject,
        };
      } catch (error) {
        if (request.signal.aborted) {
          return {
            status: "cancelled",
            ...(threadId === undefined
              ? {}
              : {
                  session: session(
                    options.instanceId,
                    threadId,
                    request.conversationId,
                    request.model,
                  ),
            }),
          };
        }
        if (
          request.session !== undefined
          && isMissingCodexSession(error, request.session.id)
        ) {
          throw new RuntimeCodexError(
            RUNTIME_SESSION_UNAVAILABLE_CODE,
            "The Codex session is no longer available for resume",
            { retryability: "not-retryable", sideEffects: "none" },
          );
        }
        if (error instanceof RuntimeCodexError) throw error;
        throw new RuntimeCodexError("PROVIDER_FAILED", redact(error, options.config.auth?.apiKey), {
          retryability: "unknown",
          sideEffects: turnId === undefined ? "none" : "unknown",
          cause: safeErrorCause(error, options.config.auth?.apiKey),
        });
      } finally {
        resolveTurnIdentity();
        unregisterLiveInput?.();
        request.signal.removeEventListener("abort", onAbort);
        unregisterServerRequests();
        unsubscribe();
        try {
          await client.close();
        } finally {
          active.delete(client);
          await processDirectory.cleanup();
        }
      }
    },
  };
}

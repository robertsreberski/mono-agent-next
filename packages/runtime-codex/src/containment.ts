// SPDX-License-Identifier: MIT
import type { RuntimeTurnContext } from "@mono-agent/module-sdk";

export type CodexApprovalPolicy = "on-request" | "never";
export type CodexMcpTransport = "stdio" | "streamable_http";

export interface EffectiveCodexMcpServer {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: CodexMcpTransport;
}

const MAX_MCP_OVERRIDE_BYTES = 32_768;
const INERT_MCP_COMMAND = "/usr/bin/false";
const INERT_MCP_URL = "http://127.0.0.1:1";

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

export function approvalPolicy(
  context: RuntimeTurnContext,
): CodexApprovalPolicy {
  return context.requestApproval === undefined ? "never" : "on-request";
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

export function containedCodexConfig(
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

export function tomlBasicString(value: string): string {
  let encoded = '"';
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      throw new Error("Codex MCP server name is invalid");
    }
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

export function codexProcessConfigArguments(
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

export const INERT_CODEX_MCP_COMMAND = INERT_MCP_COMMAND;
export const INERT_CODEX_MCP_URL = INERT_MCP_URL;

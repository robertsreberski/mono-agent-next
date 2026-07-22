import { ALLOW_ALL_TOOLS } from "./enums.js";
import type { MonoAgentConfigJson } from "./json-source.js";
import type {
  RedactedLocalProviderDefinition,
  RedactedMemoryConfig,
  RedactedMonoAgentConfig,
  RedactedObservabilityExporterConfig,
} from "./types.js";

/**
 * Where a resolved config value came from. Mirrors the loader's precedence:
 * a real `MONO_AGENT_*` env var wins, then the JSON config file, else the
 * built-in default.
 */
export type ConfigViewFieldSource = "env" | "json" | "default";

/**
 * Section-level lifecycle, aligned with the doctor's vocabulary. Optional
 * blocks (memory, sandbox, observability, local providers) report `disabled`
 * when absent and `active` when configured. The core view never emits
 * `waiting` — that is reserved for channel sections the app composes on top.
 */
export type ConfigViewSectionStatus = "active" | "disabled";

export interface ConfigViewField {
  /** Stable id, e.g. `runtime.model`. Matches the key in {@link CONFIG_ENV_KEYS}. */
  readonly id: string;
  readonly label: string;
  /** Already-redacted, display-ready value (never a raw secret). */
  readonly value: string;
  readonly source: ConfigViewFieldSource;
  /** True when a JSON-sourced value only restates the built-in default. */
  readonly restatesDefault?: boolean;
  /** True when the underlying value is a secret that has been redacted. */
  readonly redacted?: boolean;
  /**
   * Env var for fields outside {@link CONFIG_ENV_KEYS} (channel sections the
   * app composes on top of the core view). Core fields omit it and resolve
   * through the registry instead.
   */
  readonly envKey?: string;
}

export interface ConfigViewSection {
  readonly id: string;
  readonly label: string;
  readonly status: ConfigViewSectionStatus;
  readonly fields: readonly ConfigViewField[];
}

export interface BuildMonoAgentConfigViewInput {
  readonly redacted: RedactedMonoAgentConfig;
  readonly json: MonoAgentConfigJson;
  readonly env: Record<string, string | undefined>;
}

/**
 * The single env-key registry for every core config field, keyed by the stable
 * field id used in {@link ConfigViewField}. This is the authoritative map the
 * view resolves `source` against, and the surface the parity test checks
 * against the loader so the view can never silently drift from what the loader
 * actually reads. Complex sections (local providers) expose only their
 * registry env var here; their single-provider `MONO_AGENT_LOCAL_PROVIDER_*`
 * input form is an alternate encoding the parity test allowlists.
 */
export const CONFIG_ENV_KEYS = {
  "agent.name": "MONO_AGENT_NAME",
  "runtime.model": "MONO_AGENT_MODEL",
  "runtime.fallbackModels": "MONO_AGENT_FALLBACK_MODELS",
  "runtime.fallbacks": "MONO_AGENT_FALLBACKS_JSON",
  "runtime.routeSafety": "MONO_AGENT_ROUTE_SAFETY",
  "runtime.executionMode": "MONO_AGENT_EXECUTION_MODE",
  "runtime.effort": "MONO_AGENT_EFFORT",
  "runtime.permissionMode": "MONO_AGENT_PERMISSION_MODE",
  "runtime.maxTurns": "MONO_AGENT_MAX_TURNS",
  "runtime.compaction.enabled": "MONO_AGENT_COMPACTION_ENABLED",
  "runtime.compaction.triggerRatio": "MONO_AGENT_COMPACTION_TRIGGER_RATIO",
  "runtime.compaction.keepRecentTokens": "MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS",
  "runtime.compaction.summaryMaxTokens": "MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS",
  "runtime.compaction.minSavingsTokens": "MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS",
  "runtime.compaction.fixedOverheadEnabled": "MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED",
  "runtime.compaction.contextWindowOverride": "MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE",
  "runtime.workspace": "MONO_AGENT_WORKSPACE",
  "runtime.session.mode": "MONO_AGENT_SESSION_MODE",
  "runtime.session.idleTimeoutMs": "MONO_AGENT_SESSION_IDLE_TIMEOUT_MS",
  "runtime.session.rollover": "MONO_AGENT_SESSION_ROLLOVER",
  "runtime.session.rolloverTimezone": "MONO_AGENT_SESSION_ROLLOVER_TIMEZONE",
  "runtime.session.rolloverNotice": "MONO_AGENT_SESSION_ROLLOVER_NOTICE",
  "runtime.session.isolateProactive": "MONO_AGENT_SESSION_ISOLATE_PROACTIVE",
  "concurrency.maxConcurrentRuns": "MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS",
  "concurrency.maxPendingRuns": "MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS",
  "context.identityPath": "MONO_AGENT_IDENTITY_PATH",
  "context.soulPath": "MONO_AGENT_SOUL_PATH",
  "context.skillsRoot": "MONO_AGENT_SKILLS_ROOT",
  "context.selectedSkills": "MONO_AGENT_SELECTED_SKILLS",
  "context.skillMaxBytes": "MONO_AGENT_SKILL_MAX_BYTES",
  "context.skillDisclosure": "MONO_AGENT_SKILL_DISCLOSURE",
  "memory.backend": "MONO_AGENT_MEMORY_BACKEND",
  "memory.mode": "MONO_AGENT_MEMORY_MODE",
  "memory.path": "MONO_AGENT_MEMORY_PATH",
  "memory.maxBytes": "MONO_AGENT_MEMORY_MAX_BYTES",
  "memory.writeMode": "MONO_AGENT_MEMORY_WRITE_MODE",
  "memory.supermemory.baseUrl": "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL",
  "memory.supermemory.apiKey": "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY",
  "memory.supermemory.apiKeyEnv": "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV",
  "memory.supermemory.container": "MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER",
  "memory.supermemory.timeoutMs": "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS",
  "memory.supermemory.exposeMcpServer": "MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER",
  "memory.embeddings.provider": "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
  "memory.embeddings.model": "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
  "memory.embeddings.endpoint": "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT",
  "memory.embeddings.apiKey": "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
  "memory.embeddings.apiKeyEnv": "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
  "memory.embeddings.dim": "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
  "memory.embeddings.timeoutMs": "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
  "memory.embeddings.circuitBreaker.failureThreshold": "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  "memory.embeddings.circuitBreaker.cooldownMs": "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
  "memory.llm.provider": "MONO_AGENT_MEMORY_LLM_PROVIDER",
  "memory.llm.model": "MONO_AGENT_MEMORY_LLM_MODEL",
  "memory.llm.executionMode": "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
  "memory.llm.trace": "MONO_AGENT_MEMORY_LLM_TRACE",
  "memory.llm.timeoutMs": "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS",
  "memory.llm.endpoint": "MONO_AGENT_MEMORY_LLM_ENDPOINT",
  "memory.recallTool.enabled": "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED",
  "memory.consolidation.enabled": "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED",
  "memory.consolidation.cron": "MONO_AGENT_MEMORY_CONSOLIDATION_CRON",
  "tools.allowedTools": "MONO_AGENT_ALLOWED_TOOLS",
  "tools.disallowedTools": "MONO_AGENT_DISALLOWED_TOOLS",
  "tools.mcpConfigPath": "MONO_AGENT_MCP_CONFIG_PATH",
  "tools.mcpRequestContextServers": "MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS",
  "tools.continuationServers": "MONO_AGENT_CONTINUATION_SERVERS",
  "tools.mcpCallTimeoutMs": "MONO_AGENT_MCP_CALL_TIMEOUT_MS",
  "tools.mcpCallMaxTotalTimeoutMs": "MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS",
  "sandbox.mode": "MONO_AGENT_SANDBOX_MODE",
  "sandbox.network.mode": "MONO_AGENT_SANDBOX_NETWORK",
  "sandbox.network.allowlist": "MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST",
  "sandbox.readableRoots": "MONO_AGENT_SANDBOX_READABLE_ROOTS",
  "sandbox.writableRoots": "MONO_AGENT_SANDBOX_WRITABLE_ROOTS",
  "sandbox.denyWrite": "MONO_AGENT_SANDBOX_DENY_WRITE",
  "sandbox.fallback": "MONO_AGENT_SANDBOX_FALLBACK",
  "sandbox.unsafeAllowHostProcess": "MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS",
  "artifacts.dir": "MONO_AGENT_ARTIFACT_DIR",
  "artifacts.retention.maxAgeDays": "MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS",
  "artifacts.retention.maxCount": "MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT",
  "artifacts.retention.dryRun": "MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN",
  "artifacts.memoryRetention.maxAgeDays": "MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS",
  "artifacts.memoryRetention.maxCount": "MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT",
  "artifacts.memoryRetention.dryRun": "MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN",
  "traceability.registryDir": "MONO_AGENT_TRACE_REGISTRY_DIR",
  "traceability.sourceId": "MONO_AGENT_TRACE_SOURCE_ID",
  "traceability.sourceLabel": "MONO_AGENT_TRACE_SOURCE_LABEL",
  "traceability.heartbeatMs": "MONO_AGENT_TRACE_HEARTBEAT_MS",
  "traceability.staleAfterMs": "MONO_AGENT_TRACE_STALE_AFTER_MS",
  "traceability.globalDiscovery": "MONO_AGENT_TRACE_GLOBAL_DISCOVERY",
  "observability.exporters": "MONO_AGENT_OBSERVABILITY_EXPORTERS",
  "providers.piAuthPath": "MONO_AGENT_PI_AUTH_PATH",
  "providers.piNative.transport": "MONO_AGENT_PI_TRANSPORT",
  "providers.piNative.piMaxRetries": "MONO_AGENT_PI_MAX_RETRIES",
  "providers.piNative.maxRetryDelayMs": "MONO_AGENT_MAX_RETRY_DELAY_MS",
  "providers.piNative.piSessionsRoot": "MONO_AGENT_PI_SESSIONS_ROOT",
  "providers.local": "MONO_AGENT_LOCAL_PROVIDERS_JSON",
} as const satisfies Record<string, string>;

export type ConfigViewFieldId = keyof typeof CONFIG_ENV_KEYS;

const PLACEHOLDER = "—";

function envHas(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return value !== undefined && value.trim().length > 0;
}

function legacyFallbackEnvPresent(env: Record<string, string | undefined>): boolean {
  return env.MONO_AGENT_FALLBACK_MODELS !== undefined;
}

function resolveSource(
  env: Record<string, string | undefined>,
  id: ConfigViewFieldId,
  jsonPresent: boolean,
): ConfigViewFieldSource {
  if (envHas(env, CONFIG_ENV_KEYS[id])) {
    return "env";
  }
  return jsonPresent ? "json" : "default";
}

interface FieldSpec {
  readonly id: ConfigViewFieldId;
  readonly label: string;
  readonly value: string;
  readonly jsonPresent: boolean;
  readonly jsonValue?: unknown;
  readonly defaultValue?: unknown;
  readonly source?: ConfigViewFieldSource;
  readonly redacted?: boolean;
}

function toField(
  env: Record<string, string | undefined>,
  spec: FieldSpec,
): ConfigViewField {
  const source = spec.source ?? resolveSource(env, spec.id, spec.jsonPresent);
  return {
    id: spec.id,
    label: spec.label,
    value: spec.value,
    source,
    ...(source === "json" && spec.defaultValue !== undefined && sameJsonValue(spec.jsonValue, spec.defaultValue)
      ? { restatesDefault: true }
      : {}),
    ...(spec.redacted === true ? { redacted: true } : {}),
  };
}

export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function formatModelReference(
  reference: RedactedMonoAgentConfig["runtime"]["model"],
): string {
  if (typeof reference === "string") {
    return reference;
  }
  if (reference.reference !== undefined && reference.reference.length > 0) {
    return reference.reference;
  }
  const provider = reference.provider !== undefined ? `${reference.provider}:` : "";
  return `${reference.sdk}:${provider}${reference.model}`;
}

function formatFallbackModels(
  models: RedactedMonoAgentConfig["runtime"]["fallbackModels"],
): string {
  if (models === undefined || models.length === 0) {
    return PLACEHOLDER;
  }
  return models.map(formatModelReference).join(", ");
}

function formatFallbacks(
  fallbacks: RedactedMonoAgentConfig["runtime"]["fallbacks"],
): string {
  if (fallbacks === undefined || fallbacks.length === 0) {
    return PLACEHOLDER;
  }
  return fallbacks
    .map((entry) => `${formatModelReference(entry.model)} (${entry.effort ?? "provider default"})`)
    .join(", ");
}

function buildAgentSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  return {
    id: "agent",
    label: "Agent",
    status: redacted.agent === undefined ? "disabled" : "active",
    fields: [
      toField(env, {
        id: "agent.name",
        label: "Display name",
        value: redacted.agent?.name ?? PLACEHOLDER,
        jsonPresent: json.agent?.name !== undefined,
      }),
    ],
  };
}

function buildRuntimeSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const runtime = redacted.runtime;
  const session = runtime.session;
  const compaction = runtime.compaction ?? {};
  return {
    id: "runtime",
    label: "Runtime",
    status: "active",
    fields: [
      toField(env, {
        id: "runtime.model",
        label: "Model",
        value: formatModelReference(runtime.model),
        jsonPresent: json.runtime?.model !== undefined,
      }),
      toField(env, {
        id: "runtime.fallbackModels",
        label: "Legacy fallback models",
        value: formatFallbackModels(runtime.fallbackModels),
        // The two fallback env encodings are aliases at the precedence layer:
        // either real env value suppresses the other JSON form.
        jsonPresent: json.runtime?.fallbackModels !== undefined
          && !envHas(env, CONFIG_ENV_KEYS["runtime.fallbacks"]),
        source: legacyFallbackEnvPresent(env)
          ? "env"
          : json.runtime?.fallbackModels !== undefined && !envHas(env, CONFIG_ENV_KEYS["runtime.fallbacks"])
            ? "json"
            : "default",
      }),
      toField(env, {
        id: "runtime.fallbacks",
        label: "Fallback routes",
        value: formatFallbacks(runtime.fallbacks),
        jsonPresent: json.runtime?.fallbacks !== undefined
          && !legacyFallbackEnvPresent(env),
      }),
      toField(env, {
        id: "runtime.routeSafety",
        label: "Route safety",
        value: runtime.routeSafety ?? "uniform",
        jsonPresent: json.runtime?.routeSafety !== undefined,
        jsonValue: json.runtime?.routeSafety,
        defaultValue: "uniform",
      }),
      toField(env, {
        id: "runtime.executionMode",
        label: "Execution mode",
        value: runtime.executionMode,
        jsonPresent: json.runtime?.executionMode !== undefined,
      }),
      toField(env, {
        id: "runtime.effort",
        label: "Effort",
        value: runtime.effort ?? PLACEHOLDER,
        jsonPresent: json.runtime?.effort !== undefined,
      }),
      toField(env, {
        id: "runtime.permissionMode",
        label: "Permission mode",
        value: runtime.permissionMode ?? PLACEHOLDER,
        jsonPresent: json.runtime?.permissionMode !== undefined,
      }),
      toField(env, {
        id: "runtime.maxTurns",
        label: "Max turns",
        value: runtime.maxTurns === undefined ? "unlimited" : String(runtime.maxTurns),
        jsonPresent: json.runtime?.maxTurns !== undefined,
      }),
      toField(env, {
        id: "runtime.compaction.enabled",
        label: "Context compaction",
        value: compaction.enabled === false ? "no" : "yes",
        jsonPresent: json.runtime?.compaction?.enabled !== undefined,
        jsonValue: json.runtime?.compaction?.enabled,
        defaultValue: true,
      }),
      toField(env, {
        id: "runtime.compaction.triggerRatio",
        label: "Compaction trigger ratio",
        value: String(compaction.triggerRatio ?? 0.70),
        jsonPresent: json.runtime?.compaction?.triggerRatio !== undefined,
        jsonValue: json.runtime?.compaction?.triggerRatio,
        defaultValue: 0.70,
      }),
      toField(env, {
        id: "runtime.compaction.keepRecentTokens",
        label: "Compaction retained tokens",
        value: compaction.keepRecentTokens === undefined ? "adaptive by model" : String(compaction.keepRecentTokens),
        jsonPresent: json.runtime?.compaction?.keepRecentTokens !== undefined,
      }),
      toField(env, {
        id: "runtime.compaction.summaryMaxTokens",
        label: "Compaction summary budget",
        value: compaction.summaryMaxTokens === undefined ? "adaptive by model" : String(compaction.summaryMaxTokens),
        jsonPresent: json.runtime?.compaction?.summaryMaxTokens !== undefined,
      }),
      toField(env, {
        id: "runtime.compaction.minSavingsTokens",
        label: "Compaction minimum savings",
        value: compaction.minSavingsTokens === undefined ? "adaptive by model" : String(compaction.minSavingsTokens),
        jsonPresent: json.runtime?.compaction?.minSavingsTokens !== undefined,
      }),
      toField(env, {
        id: "runtime.compaction.fixedOverheadEnabled",
        label: "Compaction fixed overhead",
        value: compaction.fixedOverheadEnabled === false ? "no" : "yes",
        jsonPresent: json.runtime?.compaction?.fixedOverheadEnabled !== undefined,
        jsonValue: json.runtime?.compaction?.fixedOverheadEnabled,
        defaultValue: true,
      }),
      toField(env, {
        id: "runtime.compaction.contextWindowOverride",
        label: "Context window override",
        value: compaction.contextWindowOverride === undefined ? "auto" : String(compaction.contextWindowOverride),
        jsonPresent: json.runtime?.compaction?.contextWindowOverride !== undefined,
      }),
      toField(env, {
        id: "runtime.workspace",
        label: "Workspace",
        value: runtime.workspace,
        jsonPresent: json.runtime?.workspace !== undefined,
      }),
      toField(env, {
        id: "runtime.session.mode",
        label: "Session mode",
        value: session.mode,
        jsonPresent: json.runtime?.session?.mode !== undefined,
      }),
      toField(env, {
        id: "runtime.session.idleTimeoutMs",
        label: "Session idle timeout (ms)",
        value: String(session.idleTimeoutMs),
        jsonPresent: json.runtime?.session?.idleTimeoutMs !== undefined,
      }),
      toField(env, {
        id: "runtime.session.rollover",
        label: "Session rollover",
        value: session.rollover ?? "none",
        jsonPresent: json.runtime?.session?.rollover !== undefined,
      }),
      toField(env, {
        id: "runtime.session.rolloverTimezone",
        label: "Session rollover timezone",
        value: session.rolloverTimezone ?? PLACEHOLDER,
        jsonPresent: json.runtime?.session?.rolloverTimezone !== undefined,
      }),
      toField(env, {
        id: "runtime.session.rolloverNotice",
        label: "Session rollover notice",
        value: session.rolloverNotice === true ? "yes" : "no",
        jsonPresent: json.runtime?.session?.rolloverNotice !== undefined,
      }),
      toField(env, {
        id: "runtime.session.isolateProactive",
        label: "Isolate proactive runs",
        value: session.isolateProactive === true ? "yes" : "no",
        jsonPresent: json.runtime?.session?.isolateProactive !== undefined,
      }),
    ],
  };
}

function buildConcurrencySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const concurrency = redacted.concurrency;
  const present = concurrency !== undefined;
  return {
    id: "concurrency",
    label: "Concurrency",
    status: present ? "active" : "disabled",
    fields: [
      toField(env, {
        id: "concurrency.maxConcurrentRuns",
        label: "Max concurrent runs",
        value: concurrency?.maxConcurrentRuns === undefined ? "unbounded" : String(concurrency.maxConcurrentRuns),
        jsonPresent: json.concurrency?.maxConcurrentRuns !== undefined,
      }),
      toField(env, {
        id: "concurrency.maxPendingRuns",
        label: "Max pending runs",
        value: concurrency?.maxPendingRuns === undefined ? "unbounded" : String(concurrency.maxPendingRuns),
        jsonPresent: json.concurrency?.maxPendingRuns !== undefined,
      }),
    ],
  };
}

function buildContextSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const context = redacted.context;
  return {
    id: "context",
    label: "Context",
    status: "active",
    fields: [
      toField(env, {
        id: "context.identityPath",
        label: "Identity document",
        value: context.identityPath,
        jsonPresent: json.context?.identityPath !== undefined,
      }),
      toField(env, {
        id: "context.soulPath",
        label: "Soul document",
        value: context.soulPath ?? PLACEHOLDER,
        jsonPresent: json.context?.soulPath !== undefined,
      }),
      toField(env, {
        id: "context.skillsRoot",
        label: "Skills root",
        value: context.skillsRoot ?? PLACEHOLDER,
        jsonPresent: json.context?.skillsRoot !== undefined,
      }),
      toField(env, {
        id: "context.selectedSkills",
        label: "Selected skills",
        value: context.selectedSkills.length === 0 ? "none" : context.selectedSkills.join(", "),
        jsonPresent: json.context?.selectedSkills !== undefined,
      }),
      toField(env, {
        id: "context.skillMaxBytes",
        label: "Skill byte cap",
        value: context.skillMaxBytes === undefined ? "default" : String(context.skillMaxBytes),
        jsonPresent: json.context?.skillMaxBytes !== undefined,
      }),
      toField(env, {
        id: "context.skillDisclosure",
        label: "Skill disclosure",
        value: context.skillDisclosure ?? "full",
        jsonPresent: json.context?.skillDisclosure !== undefined,
      }),
    ],
  };
}

function buildMemorySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const memory: RedactedMemoryConfig | undefined = redacted.memory;
  if (memory === undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: "disabled",
      fields: [{ id: "memory.mode", label: "Status", value: "not configured", source: "default" }],
    };
  }

  const fields: ConfigViewField[] = [
    toField(env, {
      id: "memory.backend",
      label: "Backend",
      value: memory.backend ?? "bujo",
      jsonPresent: json.memory?.backend !== undefined,
    }),
    toField(env, {
      id: "memory.mode",
      label: "Mode",
      value: memory.mode,
      jsonPresent: json.memory?.mode !== undefined,
    }),
    toField(env, {
      id: "memory.path",
      label: "Path",
      value: memory.path,
      jsonPresent: json.memory?.path !== undefined,
    }),
    toField(env, {
      id: "memory.maxBytes",
      label: "Max bytes",
      value: String(memory.maxBytes),
      jsonPresent: json.memory?.maxBytes !== undefined,
    }),
    toField(env, {
      id: "memory.writeMode",
      label: "Write mode",
      value: memory.writeMode,
      jsonPresent: json.memory?.writeMode !== undefined,
    }),
    toField(env, {
      id: "memory.recallTool.enabled",
      label: "Recall tool",
      value: memory.recallTool === undefined ? "default" : memory.recallTool.enabled ? "on" : "off",
      jsonPresent: json.memory?.recallTool?.enabled !== undefined,
    }),
  ];

  const embeddings = memory.embeddings;
  if (embeddings !== undefined) {
    fields.push(
      toField(env, {
        id: "memory.embeddings.provider",
        label: "Embeddings provider",
        value: embeddings.provider,
        jsonPresent: json.memory?.embeddings?.provider !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.model",
        label: "Embeddings model",
        value: embeddings.model,
        jsonPresent: json.memory?.embeddings?.model !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.endpoint",
        label: "Embeddings endpoint",
        value: embeddings.endpoint ?? PLACEHOLDER,
        jsonPresent: json.memory?.embeddings?.endpoint !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.apiKey",
        label: "Embeddings API key",
        value: embeddings.apiKey?.present === true ? "set" : "unset",
        jsonPresent: json.memory?.embeddings?.apiKey !== undefined,
        redacted: true,
      }),
      toField(env, {
        id: "memory.embeddings.apiKeyEnv",
        label: "Embeddings API key env",
        value: embeddings.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.memory?.embeddings?.apiKeyEnv !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.dim",
        label: "Embeddings dimension",
        value: embeddings.dim === undefined ? "default" : String(embeddings.dim),
        jsonPresent: json.memory?.embeddings?.dim !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.timeoutMs",
        label: "Embeddings timeout (ms)",
        value: embeddings.timeoutMs === undefined ? "default" : String(embeddings.timeoutMs),
        jsonPresent: json.memory?.embeddings?.timeoutMs !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.circuitBreaker.failureThreshold",
        label: "Embeddings breaker threshold",
        value: embeddings.circuitBreaker?.failureThreshold === undefined ? "default" : String(embeddings.circuitBreaker.failureThreshold),
        jsonPresent: json.memory?.embeddings?.circuitBreaker?.failureThreshold !== undefined,
      }),
      toField(env, {
        id: "memory.embeddings.circuitBreaker.cooldownMs",
        label: "Embeddings breaker cooldown (ms)",
        value: embeddings.circuitBreaker?.cooldownMs === undefined ? "default" : String(embeddings.circuitBreaker.cooldownMs),
        jsonPresent: json.memory?.embeddings?.circuitBreaker?.cooldownMs !== undefined,
      }),
    );
  }

  const supermemory = memory.supermemory;
  if (supermemory !== undefined) {
    fields.push(
      toField(env, {
        id: "memory.supermemory.baseUrl",
        label: "Supermemory base URL",
        value: supermemory.baseUrl,
        jsonPresent: json.memory?.supermemory?.baseUrl !== undefined,
      }),
      toField(env, {
        id: "memory.supermemory.apiKey",
        label: "Supermemory API key",
        value: supermemory.apiKey?.present === true ? "set" : "unset",
        jsonPresent: json.memory?.supermemory?.apiKey !== undefined,
        redacted: true,
      }),
      toField(env, {
        id: "memory.supermemory.apiKeyEnv",
        label: "Supermemory API key env",
        value: supermemory.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.memory?.supermemory?.apiKeyEnv !== undefined,
      }),
      toField(env, {
        id: "memory.supermemory.container",
        label: "Supermemory container",
        value: supermemory.container ?? "default",
        jsonPresent: json.memory?.supermemory?.container !== undefined,
      }),
      toField(env, {
        id: "memory.supermemory.timeoutMs",
        label: "Supermemory timeout (ms)",
        value: supermemory.timeoutMs === undefined ? "default" : String(supermemory.timeoutMs),
        jsonPresent: json.memory?.supermemory?.timeoutMs !== undefined,
      }),
      toField(env, {
        id: "memory.supermemory.exposeMcpServer",
        label: "Supermemory MCP server",
        value: supermemory.exposeMcpServer === true ? "on" : "off",
        jsonPresent: json.memory?.supermemory?.exposeMcpServer !== undefined,
      }),
    );
  }

  const llm = memory.llm;
  if (llm !== undefined) {
    fields.push(
      toField(env, {
        id: "memory.llm.provider",
        label: "LLM provider",
        value: llm.provider,
        jsonPresent: json.memory?.llm?.provider !== undefined,
      }),
      toField(env, {
        id: "memory.llm.model",
        label: "LLM model",
        value: llm.model,
        jsonPresent: json.memory?.llm?.model !== undefined,
      }),
    );
    if (llm.provider === "ollama") {
      fields.push(
        toField(env, {
          id: "memory.llm.endpoint",
          label: "LLM endpoint",
          value: llm.endpoint ?? PLACEHOLDER,
          jsonPresent: json.memory?.llm?.endpoint !== undefined,
        }),
      );
    } else {
      fields.push(
        toField(env, {
          id: "memory.llm.executionMode",
          label: "LLM execution mode",
          value: llm.executionMode ?? "default",
          jsonPresent: json.memory?.llm?.executionMode !== undefined,
        }),
        toField(env, {
          id: "memory.llm.trace",
          label: "LLM trace",
          value: llm.trace === false ? "off" : "on",
          jsonPresent: json.memory?.llm?.trace !== undefined,
        }),
        toField(env, {
          id: "memory.llm.timeoutMs",
          label: "LLM timeout (ms)",
          value: llm.timeoutMs === undefined ? "default" : String(llm.timeoutMs),
          jsonPresent: json.memory?.llm?.timeoutMs !== undefined,
        }),
      );
    }
  }

  if (memory.mode === "bujo" || memory.consolidation !== undefined) {
    fields.push(
      toField(env, {
        id: "memory.consolidation.enabled",
        label: "Consolidation",
        value: memory.consolidation?.enabled === false ? "off" : "on",
        jsonPresent: json.memory?.consolidation?.enabled !== undefined,
      }),
      toField(env, {
        id: "memory.consolidation.cron",
        label: "Consolidation cron",
        value: memory.consolidation?.cron ?? "default (0 */2 * * *)",
        jsonPresent: json.memory?.consolidation?.cron !== undefined,
      }),
    );
  }

  return { id: "memory", label: "Memory", status: "active", fields };
}

function buildToolsSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const tools = redacted.tools;
  return {
    id: "tools",
    label: "Tools",
    status: "active",
    fields: [
      toField(env, {
        id: "tools.allowedTools",
        label: "Allowed tools",
        value: tools.allowedTools.includes(ALLOW_ALL_TOOLS)
          ? "All tools allowed"
          : tools.allowedTools.length === 0
            ? "none (chat-only)"
            : tools.allowedTools.join(", "),
        jsonPresent: json.tools?.allowedTools !== undefined,
      }),
      toField(env, {
        id: "tools.disallowedTools",
        label: "Disallowed tools",
        value: tools.disallowedTools.length === 0 ? "none" : tools.disallowedTools.join(", "),
        jsonPresent: json.tools?.disallowedTools !== undefined,
      }),
      toField(env, {
        id: "tools.mcpConfigPath",
        label: "MCP config",
        value: tools.mcpConfigPath ?? PLACEHOLDER,
        jsonPresent: json.tools?.mcpConfigPath !== undefined,
      }),
      toField(env, {
        id: "tools.mcpRequestContextServers",
        label: "Request-context MCP servers",
        value: tools.mcpRequestContextServers?.join(", ") ?? "none",
        jsonPresent: json.tools?.mcpRequestContextServers !== undefined,
      }),
      toField(env, {
        id: "tools.continuationServers",
        label: "Continuation MCP servers",
        value: tools.continuationServers?.join(", ") ?? "none",
        jsonPresent: json.tools?.continuationServers !== undefined,
      }),
      toField(env, {
        id: "tools.mcpCallTimeoutMs",
        label: "MCP call inactivity timeout",
        value: tools.mcpCallTimeoutMs === undefined ? "runtime default (120s)" : `${tools.mcpCallTimeoutMs}ms`,
        jsonPresent: json.tools?.mcpCallTimeoutMs !== undefined,
      }),
      toField(env, {
        id: "tools.mcpCallMaxTotalTimeoutMs",
        label: "MCP call max total timeout",
        value: tools.mcpCallMaxTotalTimeoutMs === undefined
          ? "runtime default (45 min)"
          : `${tools.mcpCallMaxTotalTimeoutMs}ms`,
        jsonPresent: json.tools?.mcpCallMaxTotalTimeoutMs !== undefined,
      }),
    ],
  };
}

function buildSandboxSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const sandbox = redacted.sandbox;
  if (sandbox === undefined) {
    return {
      id: "sandbox",
      label: "Sandbox",
      status: "disabled",
      fields: [{ id: "sandbox.mode", label: "Status", value: "not configured", source: "default" }],
    };
  }
  return {
    id: "sandbox",
    label: "Sandbox",
    status: "active",
    fields: [
      toField(env, {
        id: "sandbox.mode",
        label: "Mode",
        value: sandbox.mode,
        jsonPresent: json.sandbox?.mode !== undefined,
      }),
      toField(env, {
        id: "sandbox.network.mode",
        label: "Network",
        value: sandbox.network.mode,
        jsonPresent: json.sandbox?.network?.mode !== undefined,
      }),
      toField(env, {
        id: "sandbox.network.allowlist",
        label: "Network allowlist",
        value: sandbox.network.allowlist.length === 0 ? "none" : sandbox.network.allowlist.join(", "),
        jsonPresent: json.sandbox?.network?.allowlist !== undefined,
      }),
      toField(env, {
        id: "sandbox.readableRoots",
        label: "Readable roots",
        value: sandbox.readableRoots.join(", "),
        jsonPresent: json.sandbox?.readableRoots !== undefined,
      }),
      toField(env, {
        id: "sandbox.writableRoots",
        label: "Writable roots",
        value: sandbox.writableRoots.join(", "),
        jsonPresent: json.sandbox?.writableRoots !== undefined,
      }),
      toField(env, {
        id: "sandbox.denyWrite",
        label: "Deny-write patterns",
        value: sandbox.denyWrite.join(", "),
        jsonPresent: json.sandbox?.denyWrite !== undefined,
      }),
      toField(env, {
        id: "sandbox.fallback",
        label: "Fallback",
        value: sandbox.fallback,
        jsonPresent: json.sandbox?.fallback !== undefined,
      }),
      toField(env, {
        id: "sandbox.unsafeAllowHostProcess",
        label: "Allow host process",
        value: sandbox.unsafeAllowHostProcess ? "yes" : "no",
        jsonPresent: json.sandbox?.unsafeAllowHostProcess !== undefined,
      }),
    ],
  };
}

function buildArtifactsSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const memoryDryRunJsonPresent = json.artifacts?.memoryRetention?.dryRun !== undefined;
  const inheritedDryRunSource = resolveSource(env, "artifacts.retention.dryRun", json.artifacts?.retention?.dryRun !== undefined);
  const memoryDryRunSource = envHas(env, CONFIG_ENV_KEYS["artifacts.memoryRetention.dryRun"])
    ? "env"
    : memoryDryRunJsonPresent
      ? "json"
      : inheritedDryRunSource;
  return {
    id: "artifacts",
    label: "Artifacts",
    status: "active",
    fields: [
      toField(env, {
        id: "artifacts.dir",
        label: "Artifact directory",
        value: redacted.artifacts.dir,
        jsonPresent: json.artifacts?.dir !== undefined,
      }),
      toField(env, {
        id: "artifacts.retention.maxAgeDays",
        label: "Retention max age",
        value: `${redacted.artifacts.retention.maxAgeDays} day(s)`,
        jsonPresent: json.artifacts?.retention?.maxAgeDays !== undefined,
      }),
      toField(env, {
        id: "artifacts.retention.maxCount",
        label: "Retention max count",
        value: String(redacted.artifacts.retention.maxCount),
        jsonPresent: json.artifacts?.retention?.maxCount !== undefined,
      }),
      toField(env, {
        id: "artifacts.retention.dryRun",
        label: "Retention dry run",
        value: redacted.artifacts.retention.dryRun ? "yes" : "no",
        jsonPresent: json.artifacts?.retention?.dryRun !== undefined,
      }),
      toField(env, {
        id: "artifacts.memoryRetention.maxAgeDays",
        label: "Memory retention max age",
        value: `${redacted.artifacts.memoryRetention.maxAgeDays} day(s)`,
        jsonPresent: json.artifacts?.memoryRetention?.maxAgeDays !== undefined,
      }),
      toField(env, {
        id: "artifacts.memoryRetention.maxCount",
        label: "Memory retention max count",
        value: String(redacted.artifacts.memoryRetention.maxCount),
        jsonPresent: json.artifacts?.memoryRetention?.maxCount !== undefined,
      }),
      toField(env, {
        id: "artifacts.memoryRetention.dryRun",
        label: "Memory retention dry run",
        value: redacted.artifacts.memoryRetention.dryRun ? "yes" : "no",
        jsonPresent: memoryDryRunJsonPresent,
        source: memoryDryRunSource,
      }),
    ],
  };
}

function buildTraceabilitySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const trace = redacted.traceability;
  return {
    id: "traceability",
    label: "Traceability",
    status: "active",
    fields: [
      toField(env, {
        id: "traceability.registryDir",
        label: "Trace registry",
        value: trace.registryDir,
        jsonPresent: json.traceability?.registryDir !== undefined,
      }),
      toField(env, {
        id: "traceability.sourceId",
        label: "Source ID",
        value: trace.sourceId ?? PLACEHOLDER,
        jsonPresent: json.traceability?.sourceId !== undefined,
      }),
      toField(env, {
        id: "traceability.sourceLabel",
        label: "Source label",
        value: trace.sourceLabel ?? PLACEHOLDER,
        jsonPresent: json.traceability?.sourceLabel !== undefined,
      }),
      toField(env, {
        id: "traceability.heartbeatMs",
        label: "Heartbeat (ms)",
        value: trace.heartbeatMs === undefined ? "default" : String(trace.heartbeatMs),
        jsonPresent: json.traceability?.heartbeatMs !== undefined,
        jsonValue: json.traceability?.heartbeatMs,
        defaultValue: 10_000,
      }),
      toField(env, {
        id: "traceability.staleAfterMs",
        label: "Stale after (ms)",
        value: trace.staleAfterMs === undefined ? "default" : String(trace.staleAfterMs),
        jsonPresent: json.traceability?.staleAfterMs !== undefined,
        jsonValue: json.traceability?.staleAfterMs,
        defaultValue: 30_000,
      }),
      toField(env, {
        id: "traceability.globalDiscovery",
        label: "Global discovery",
        value: trace.globalDiscovery === false ? "no" : "yes",
        jsonPresent: json.traceability?.globalDiscovery !== undefined,
      }),
    ],
  };
}

function formatExporters(
  exporters: readonly RedactedObservabilityExporterConfig[],
): string {
  if (exporters.length === 0) {
    return "none";
  }
  return exporters.map((exporter) => exporter.type).join(", ");
}

function buildObservabilitySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const observability = redacted.observability;
  if (observability === undefined) {
    return {
      id: "observability",
      label: "Observability",
      status: "disabled",
      fields: [{ id: "observability.exporters", label: "Exporters", value: "none (local JSONL only)", source: "default" }],
    };
  }
  return {
    id: "observability",
    label: "Observability",
    status: "active",
    fields: [
      toField(env, {
        id: "observability.exporters",
        label: "Exporters",
        value: formatExporters(observability.exporters),
        jsonPresent: json.observability?.exporters !== undefined,
      }),
    ],
  };
}

function formatLocalProviders(
  providers: readonly RedactedLocalProviderDefinition[],
): string {
  if (providers.length === 0) {
    return "none";
  }
  return providers.map((provider) => `${provider.id} (${provider.type})`).join(", ");
}

function buildProvidersSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json, env } = input;
  const providers = redacted.providers;
  const present = providers !== undefined;
  const localPresent = json.providers?.local !== undefined;
  return {
    id: "providers",
    label: "Providers",
    status: present ? "active" : "disabled",
    fields: [
      toField(env, {
        id: "providers.piAuthPath",
        label: "Pi auth path",
        value: providers?.piAuthPath ?? PLACEHOLDER,
        jsonPresent: json.providers?.piAuthPath !== undefined,
      }),
      toField(env, {
        id: "providers.piNative.transport",
        label: "Pi transport",
        value: providers?.piNative?.transport ?? "auto",
        jsonPresent: json.providers?.piNative?.transport !== undefined,
      }),
      toField(env, {
        id: "providers.piNative.piMaxRetries",
        label: "Pi max retries",
        value: providers?.piNative?.piMaxRetries === undefined ? "default" : String(providers.piNative.piMaxRetries),
        jsonPresent: json.providers?.piNative?.piMaxRetries !== undefined,
      }),
      toField(env, {
        id: "providers.piNative.maxRetryDelayMs",
        label: "Pi max retry delay (ms)",
        value: providers?.piNative?.maxRetryDelayMs === undefined ? "default" : String(providers.piNative.maxRetryDelayMs),
        jsonPresent: json.providers?.piNative?.maxRetryDelayMs !== undefined,
      }),
      toField(env, {
        id: "providers.piNative.piSessionsRoot",
        label: "Pi sessions root",
        value: providers?.piNative?.piSessionsRoot ?? "in-memory",
        jsonPresent: json.providers?.piNative?.piSessionsRoot !== undefined,
      }),
      toField(env, {
        id: "providers.local",
        label: "Local providers",
        value: providers?.local === undefined ? "none" : formatLocalProviders(providers.local),
        jsonPresent: localPresent,
      }),
    ],
  };
}

/**
 * Build the single, complete, source-annotated view of a resolved
 * `MonoAgentConfig`. Every core section and field is represented exactly once,
 * including the `observability.exporters` and `providers.local` blocks that the
 * retired field-group registry omitted. Drives both the read-only TUI config
 * pane and the `mono-agent config` CLI command, so the two surfaces can never
 * disagree about what the loader produced.
 */
export function buildMonoAgentConfigView(
  input: BuildMonoAgentConfigViewInput,
): readonly ConfigViewSection[] {
  return [
    buildAgentSection(input),
    buildRuntimeSection(input),
    buildConcurrencySection(input),
    buildContextSection(input),
    buildMemorySection(input),
    buildToolsSection(input),
    buildSandboxSection(input),
    buildArtifactsSection(input),
    buildTraceabilitySection(input),
    buildObservabilitySection(input),
    buildProvidersSection(input),
  ];
}

function envKeyForFieldId(id: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(CONFIG_ENV_KEYS, id)) {
    return CONFIG_ENV_KEYS[id as ConfigViewFieldId];
  }
  return undefined;
}

/**
 * Find advisory warnings for secret-marked fields whose resolved source is the
 * committed JSON config. The warning uses only stable field ids and env-var
 * names, never the secret value itself.
 */
export function findJsonSecretConfigWarnings(
  sections: readonly ConfigViewSection[],
): readonly string[] {
  const warnings: string[] = [];
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.redacted !== true || field.source !== "json") {
        continue;
      }
      const envVar = field.envKey ?? envKeyForFieldId(field.id);
      if (envVar === undefined) {
        continue;
      }
      warnings.push(`[WARN] ${field.id} is a secret read from mono-agent.config.json — move it to .env (${envVar}).`);
    }
  }
  return warnings;
}

export interface RemovedConfigWarningsInput {
  readonly json: MonoAgentConfigJson;
  readonly env: Record<string, string | undefined>;
}

const REMOVED_MEMORY_ENV_KEYS = [
  "MONO_AGENT_MEMORY_REFLECTION_ENABLED",
  "MONO_AGENT_MEMORY_REFLECTION_CRON",
  "MONO_AGENT_MEMORY_MIGRATION_ENABLED",
  "MONO_AGENT_MEMORY_MIGRATION_CRON",
] as const;

/**
 * Find advisory warnings for removed config keys that are tolerated but ignored.
 * Warnings mention only stable JSON paths and env var names, never values.
 */
export function findRemovedConfigWarnings(input: RemovedConfigWarningsInput): readonly string[] {
  const warnings: string[] = [];
  if (input.json.memory?.reflection !== undefined) {
    warnings.push("[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.");
  }
  if (input.json.memory?.migration !== undefined) {
    warnings.push("[WARN] memory.migration is removed and ignored; use memory.consolidation instead.");
  }
  for (const key of REMOVED_MEMORY_ENV_KEYS) {
    if (envHas(input.env, key)) {
      warnings.push(`[WARN] ${key} is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.`);
    }
  }
  return warnings;
}

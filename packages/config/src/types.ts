import type { LocalProviderDefinition, PiTransport, RuntimeCompactionPolicy, RuntimeExecutionMode, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/runtime-adapter";
import type { RedactedSecretValue } from "@mono-agent/agent-contracts";

import type {
  EFFORT_LEVELS,
  MEMORY_BACKENDS,
  MEMORY_EMBEDDINGS_PROVIDERS,
  MEMORY_LLM_PROVIDERS,
  MEMORY_MODES,
  MEMORY_WRITE_MODES,
  PERMISSION_MODES,
  ROUTE_SAFETY_MODES,
} from "./enums.js";

export type MemoryWriteMode = (typeof MEMORY_WRITE_MODES)[number];
export type MemoryMode = (typeof MEMORY_MODES)[number];
/**
 * Which memory engine backs the store. `"bujo"` (default) is the homegrown
 * SQLite/embeddings engine selected by {@link MemoryMode}. External backends
 * (e.g. `"supermemory"`) implement the same MemoryStore contract; for them
 * `mode`/`embeddings`/`llm` are ignored and a backend-specific block applies.
 * Extensible union: add a backend here and its config block on the memory shape.
 */
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];
/**
 * Supermemory external backend (https://supermemory.ai). Points at a local OSS
 * binary or the hosted cloud via `baseUrl`. Extraction/consolidation happens
 * server-side, so no `memory.llm` is needed for this backend.
 */
export interface MemorySupermemoryConfig {
  /** REST base URL — local OSS binary (e.g. http://127.0.0.1:8080) or hosted cloud. */
  readonly baseUrl: string;
  /** Resolved API key value (inline or read from `apiKeyEnv` at load time). Optional for no-auth local. */
  readonly apiKey?: string;
  /** Name of the env var the key was read from, kept for redacted display. */
  readonly apiKeyEnv?: string;
  /** Namespace/container tag scoping this agent's memories. Defaults to the trace sourceId. */
  readonly container?: string;
  /** Per-call HTTP timeout in ms (default 10000). */
  readonly timeoutMs?: number;
  /** Also inject Supermemory's official MCP server alongside the in-app recall tool. Default false. */
  readonly exposeMcpServer?: boolean;
}
/** Configuration for bujo-tier lightweight consolidation. */
export interface MemoryConsolidationConfig {
  readonly enabled?: boolean;
  readonly cron?: string;
}
export type MemoryEmbeddingsProvider = (typeof MEMORY_EMBEDDINGS_PROVIDERS)[number];
/** Circuit-breaker tuning for the embeddings provider used by journal/bujo recall. */
export interface MemoryEmbeddingsCircuitBreakerConfig {
  /** Consecutive failures before the breaker trips OPEN (default 3). */
  readonly failureThreshold?: number;
  /** How long the breaker stays OPEN before a half-open trial, in ms (default 30000). */
  readonly cooldownMs?: number;
}
export interface MemoryEmbeddingsConfig {
  readonly provider: MemoryEmbeddingsProvider;
  readonly model: string;
  /**
   * Provider service root. LM Studio defaults to `http://localhost:1234` and
   * resolves embeddings below this root at `/v1/embeddings`.
   */
  readonly endpoint?: string;
  /** Resolved key value (inline or read from `apiKeyEnv` at load time). */
  readonly apiKey?: string;
  /**
   * Name of the env var configured for the key. Optional-auth local providers
   * keep it even while unset so readiness can report a waiting credential.
   */
  readonly apiKeyEnv?: string;
  /** Embedding vector dimension (bujo mode default: 768 for nomic-embed-text). */
  readonly dim?: number;
  /** Per-call embeddings timeout in ms (default 10000 in the host). */
  readonly timeoutMs?: number;
  /** Circuit-breaker overrides; unset fields fall back to the breaker defaults. */
  readonly circuitBreaker?: MemoryEmbeddingsCircuitBreakerConfig;
}
export type MemoryLlmProvider = (typeof MEMORY_LLM_PROVIDERS)[number];
export interface MemoryOllamaLlmConfig {
  readonly provider: "ollama";
  readonly model: string;
  readonly endpoint?: string;
}
export interface MemoryAgentHostLlmConfig {
  readonly provider: "agent-host";
  /** Runtime model reference string, parsed by the host when constructing the LLM. */
  readonly model: string;
  readonly executionMode?: RuntimeExecutionMode;
  /**
   * Record each memory LLM `complete()` as a run through the same JSONL + Phoenix
   * pipeline as channel runs (per-ritual labelled, `mem-*` run ids). Defaults to
   * `true`; set `false` to keep memory LLM calls unrecorded.
   */
  readonly trace?: boolean;
  /**
   * Per-`complete()` timeout in ms before the memory LLM run is aborted. Defaults
   * to 60000. Raise it when a slow local model (e.g. opencode-go) trips the cap on
   * the heavier reconcile/entities steps.
   */
  readonly timeoutMs?: number;
}
export type MemoryLlmConfig = MemoryOllamaLlmConfig | MemoryAgentHostLlmConfig;

/**
 * Phoenix OTLP-HTTP trace exporter config. Best-effort, additive sink: never
 * changes run outcome and never suppresses the local JSONL recorder. Header
 * values are secrets and are redacted by `redactMonoAgentConfig`.
 */
export interface PhoenixExporterConfig {
  readonly type: "phoenix";
  /** OTLP/HTTP traces endpoint; defaults to Phoenix's local `/v1/traces`. */
  readonly endpoint?: string;
  /** Extra HTTP headers (e.g. auth) sent on the OTLP POST. Values are secrets. */
  readonly headers?: Readonly<Record<string, string>>;
  /** When true, redacted raw payloads are exported; default false (metadata only). */
  readonly includeSensitiveData?: boolean;
  /**
   * Scan retained exported free-text values for a closed set of high-confidence
   * credential shapes. Default false; object-key redaction remains enabled.
   */
  readonly contentPatternRedaction?: boolean;
  /** Hard cap (ms) on a single export attempt; bounded {1..60000}, default 5000. */
  readonly timeoutMs?: number;
  /**
   * Phoenix project the traces land in (resource attr `openinference.project.name`,
   * also sent as the `x-project-name` header). Defaults to the run's trace source
   * label/id, else "default". Not a secret.
   */
  readonly projectName?: string;
}

/** Union of supported observability exporters (future: langfuse/otlp). */
export type ObservabilityExporterConfig = PhoenixExporterConfig;

export type SessionMode = "continuous" | "per-message";

/**
 * Session rollover policy. "daily" appends a local-date bucket to each
 * conversationId so a new calendar day starts a fresh session across ALL
 * channels (cron, telegram, slack, …), bounding unbounded history growth;
 * within-day growth is absorbed by context compaction. "none" = unchanged.
 */
export type SessionRollover = "none" | "daily";

/**
 * Skill disclosure mode. "index" injects only the skill index (names +
 * descriptions) plus a `ReadSkill` tool the agent calls to pull a full body on
 * demand; "full" inlines `selectedSkills` bodies into the prompt up front. See
 * `MonoAgentConfig.context.skillDisclosure`. Default "full" (legacy behavior); set
 * "index" to opt in to progressive disclosure.
 */
export type SkillDisclosureMode = "index" | "full";
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type RouteSafetyMode = (typeof ROUTE_SAFETY_MODES)[number];

/** One canonical fallback route. Omitted effort means provider default. */
export interface RuntimeFallbackConfig {
  readonly model: RuntimeModelReference;
  readonly effort?: EffortLevel;
}

export interface ArtifactRetentionConfig {
  /** Delete terminal run artifacts older than this many days. */
  readonly maxAgeDays: number;
  /** Keep at most this many newest terminal runs after age pruning. */
  readonly maxCount: number;
  /** Report what would be deleted without unlinking files. */
  readonly dryRun: boolean;
}

export interface MonoAgentConfig {
  /** Public display identity. It never participates in paths or service ids. */
  readonly agent?: {
    readonly name: string;
  };
  readonly runtime: {
    readonly model: RuntimeModelReference;
    /**
     * Ordered backup models tried after `model` when a run fails with a
     * retryable provider error. Each entry runs under its default execution
     * mode.
     */
    readonly fallbackModels?: readonly RuntimeModelReference[];
    /**
     * Canonical fallback routes. Unlike legacy `fallbackModels`, an omitted
     * per-route effort selects that provider's default rather than inheriting
     * `runtime.effort`.
     */
    readonly fallbacks?: readonly RuntimeFallbackConfig[];
    /** Uniform is the compatibility-preserving default. */
    readonly routeSafety?: RouteSafetyMode;
    readonly executionMode: RuntimeExecutionMode;
    readonly effort?: EffortLevel;
    /** Tool-permission posture forwarded to the runtime (CLI execution modes). */
    readonly permissionMode?: PermissionMode;
    /** Optional hard cap per run; omitted means unlimited. */
    readonly maxTurns?: number;
    /** Adaptive context compaction policy forwarded directly to the runtime. */
    readonly compaction?: RuntimeCompactionPolicy;
    readonly workspace: string;
    readonly session: {
      readonly mode: SessionMode;
      readonly idleTimeoutMs: number;
      /** Daily/none session rollover; default "none". */
      readonly rollover?: SessionRollover;
      /** IANA timezone for the rollover date boundary; default system-local. */
      readonly rolloverTimezone?: string;
      /** Show an operator-facing notice when session rollover starts a fresh session. */
      readonly rolloverNotice?: boolean;
      /**
       * When true, cron/proactive runs are handled as one-shot ephemeral turns:
       * they neither resume nor persist into the shared continuous session, so
       * their large tool dumps stay out of the interactive transcript. Interactive
       * (non-cron) turns are unaffected. Default false (no behavior change).
       */
      readonly isolateProactive?: boolean;
    };
  };
  /**
   * Concurrency bounds across all conversations. Two independent tiers, both
   * unset (default) = unbounded:
   * - `maxConcurrentRuns` caps how many runs execute against the provider at
   *   once (execution width, around the model call only).
   * - `maxPendingRuns` caps how many runs may be admitted before the expensive
   *   pre-provider work (attachment persistence + context prep); requests over
   *   this bound fail fast instead of queuing, providing backpressure.
   *
   * Bounds apply per channel harness instance, not globally across channels:
   * the app builds one harness per channel, so with N configured channels the
   * effective ceiling is N× this value.
   */
  readonly concurrency?: {
    readonly maxConcurrentRuns?: number;
    readonly maxPendingRuns?: number;
  };
  readonly context: {
    readonly identityPath: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills: readonly string[];
    /** Hard byte cap per selected skill body (default 48000 in the harness). */
    readonly skillMaxBytes?: number;
    /**
     * How skill bodies reach the agent. "full" (default) preserves the legacy
     * behavior where `selectedSkills` bodies are inlined into the prompt up front
     * (via skillInstructions). "index" injects only the skill INDEX (names +
     * descriptions) and exposes a `ReadSkill` tool so the agent pulls a full body
     * on demand — keeping the system prompt small. Unset = "full".
     */
    readonly skillDisclosure?: SkillDisclosureMode;
  };
  readonly memory?: {
    /**
     * Memory engine. `"bujo"` (default) uses the homegrown SQLite engine driven
     * by `mode`. External backends (e.g. `"supermemory"`) implement the same
     * MemoryStore contract and ignore `mode`/`embeddings`/`llm`.
     */
    readonly backend?: MemoryBackend;
    readonly mode: MemoryMode;
    readonly path: string;
    readonly maxBytes: number;
    readonly writeMode: MemoryWriteMode;
    /** Supermemory external backend config; required when `backend` is `"supermemory"`. */
    readonly supermemory?: MemorySupermemoryConfig;
    /** Embedding provider for semantic memory recall; keyword fallback when unset. */
    readonly embeddings?: MemoryEmbeddingsConfig;
    /** LLM for bujo capture and effective tier selection. */
    readonly llm?: MemoryLlmConfig;
    /**
     * Read-only `MemoryRecall` tool exposed to the agent (embeddings + FTS, no
     * chat LLM). Derived from this single memory block — no hand-wired MCP entry.
     * Defaults on for every configured memory tier; explicit false opts out.
     */
    readonly recallTool?: { readonly enabled: boolean };
    /** Bujo-tier lightweight consolidation. Scheduler default cadence: every two hours. */
    readonly consolidation?: MemoryConsolidationConfig;
  };
  readonly tools: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    readonly mcpConfigPath?: string;
    /**
     * Names of configured stdio MCP servers that receive trusted per-request
     * producing-conversation, run, output-directory, and progress capability
     * context. Unlisted servers preserve the legacy static environment.
     */
    readonly mcpRequestContextServers?: readonly string[];
    /**
     * Names of stdio or loopback-HTTP MCP servers allowed to receive a
     * host-minted, destination-bound continuation claim capability.
     */
    readonly continuationServers?: readonly string[];
    /** Inactivity timeout per MCP tool call; progress notifications reset it. Runtime default: 120s. */
    readonly mcpCallTimeoutMs?: number;
    /** Hard wall clock per MCP tool call that progress cannot extend. Runtime default: 45 min. */
    readonly mcpCallMaxTotalTimeoutMs?: number;
  };
  readonly sandbox?: SandboxPolicy;
  readonly artifacts: {
    readonly dir: string;
    readonly retention: ArtifactRetentionConfig;
    /** Retention policy for memory-run artifacts under the memory namespace. */
    readonly memoryRetention: ArtifactRetentionConfig;
  };
  readonly traceability: {
    readonly registryDir: string;
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly heartbeatMs?: number;
    readonly staleAfterMs?: number;
    /**
     * When this agent's own `registryDir` is not the machine-wide default
     * (e.g. `mono-agent init`'s config-local scaffold), also mirror its
     * heartbeat manifest into the global `~/.mono-agent/trace-sources`
     * registry so `mono-agent tui` run from anywhere on the machine can find
     * it. Default true; set false to keep this agent's registration local-only.
     */
    readonly globalDiscovery?: boolean;
  };
  /**
   * Best-effort observability sinks. Present only when at least one exporter is
   * configured; the local JSONL recorder always runs regardless.
   */
  readonly observability?: {
    readonly exporters: readonly ObservabilityExporterConfig[];
  };
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly LocalProviderDefinition[];
    readonly piNative?: PiNativeProviderConfig;
  };
}

/** Tuning knobs for the pi-native provider bridge. */
export interface PiNativeProviderConfig {
  /** Preferred Pi provider transport (default auto; unsupported providers ignore it). */
  readonly transport?: PiTransport;
  /** Max retry attempts for the pi provider transport (0-8; default 2). */
  readonly piMaxRetries?: number;
  /** Maximum delay between retry attempts, in milliseconds (default 60000). */
  readonly maxRetryDelayMs?: number;
  /**
   * Directory for durable JSONL session storage. When set, provider sessions
   * persist to disk and resume across restarts; unset keeps sessions in-memory.
   */
  readonly piSessionsRoot?: string;
}

export type RedactedLocalProviderDefinition = Omit<LocalProviderDefinition, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedMemoryEmbeddingsConfig = Omit<MemoryEmbeddingsConfig, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedMemorySupermemoryConfig = Omit<MemorySupermemoryConfig, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export type RedactedMemoryConfig = Omit<
  NonNullable<MonoAgentConfig["memory"]>,
  "embeddings" | "supermemory"
> & {
  readonly embeddings?: RedactedMemoryEmbeddingsConfig;
  readonly supermemory?: RedactedMemorySupermemoryConfig;
};

export type RedactedPhoenixExporterConfig = Omit<PhoenixExporterConfig, "headers"> & {
  /** Header VALUES are secrets and replaced with the literal `[redacted]`. */
  readonly headers?: Readonly<Record<string, "[redacted]">>;
};

export type RedactedObservabilityExporterConfig = RedactedPhoenixExporterConfig;

export interface RedactedObservabilityConfig {
  readonly exporters: readonly RedactedObservabilityExporterConfig[];
}

export interface RedactedMonoAgentConfig {
  readonly agent?: MonoAgentConfig["agent"];
  readonly runtime: MonoAgentConfig["runtime"];
  readonly concurrency?: MonoAgentConfig["concurrency"];
  readonly context: MonoAgentConfig["context"];
  readonly memory?: RedactedMemoryConfig;
  readonly tools: MonoAgentConfig["tools"];
  readonly sandbox?: MonoAgentConfig["sandbox"];
  readonly artifacts: MonoAgentConfig["artifacts"];
  readonly traceability: MonoAgentConfig["traceability"];
  readonly observability?: RedactedObservabilityConfig;
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly RedactedLocalProviderDefinition[];
    readonly piNative?: PiNativeProviderConfig;
  };
}

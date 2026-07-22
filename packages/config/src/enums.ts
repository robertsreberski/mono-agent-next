/**
 * Closed enum sets shared between the loader's `MONO_AGENT_*` validation and the
 * config-view builder's select options, so the two surfaces never drift.
 */

/**
 * Closed set of reasoning-effort hints, validated by the loader's
 * `MONO_AGENT_EFFORT` parsing and surfaced as the runtime effort options.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** How a mixed-provider fallback chain applies tool and sandbox policy. */
export const ROUTE_SAFETY_MODES = ["uniform", "per-route-native"] as const;

/**
 * Closed set of runtime permission modes, validated by the loader's
 * `MONO_AGENT_PERMISSION_MODE` parsing.
 */
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;

/** Built-in and external memory store implementations. */
export const MEMORY_BACKENDS = ["bujo", "supermemory"] as const;

/** Strict capability tiers for the built-in BuJo memory backend. */
export const MEMORY_MODES = ["lite", "journal", "bujo"] as const;

/** Supported memory persistence policies. */
export const MEMORY_WRITE_MODES = ["disabled", "append-host-summary", "capture"] as const;

/** Embedding providers supported by the built-in memory backend. */
export const MEMORY_EMBEDDINGS_PROVIDERS = ["ollama", "lmstudio", "openai"] as const;

/** Chat-LLM providers supported by BuJo capture. */
export const MEMORY_LLM_PROVIDERS = ["ollama", "agent-host"] as const;

/** Sentinel in tools.allowedTools meaning "all built-in tools" (an allow-all wildcard). */
export const ALLOW_ALL_TOOLS = "*";

import { resolveSupermemoryContainer } from "@mono-agent/config";
import type { MemoryMode, MonoAgentConfig } from "@mono-agent/config";

/** Circuit-breaker tuning carried into the recall child. Mirrors `config.memory.embeddings.circuitBreaker`. */
export interface MemoryRecallEmbeddingsCircuitBreaker {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
}

/** Embeddings the recall server needs. Mirrors the resolved `config.memory.embeddings` slice. */
export interface MemoryRecallEmbeddings {
  readonly provider: "ollama" | "lmstudio" | "openai";
  readonly model: string;
  readonly endpoint?: string;
  /** Resolved key value. Only used as a last resort (inline apiKey, no apiKeyEnv). */
  readonly apiKey?: string;
  /** Name of the env var the key was read from; forwarded instead of the raw value when present. */
  readonly apiKeyEnv?: string;
  readonly dim?: number;
  /** Per-call embeddings timeout in ms; mirrors the host default when unset. */
  readonly timeoutMs?: number;
  /** Circuit-breaker overrides; unset fields fall back to the breaker defaults. */
  readonly circuitBreaker?: MemoryRecallEmbeddingsCircuitBreaker;
}

/**
 * Supermemory params the recall child needs to build its REST client. The key is the resolved value:
 * unlike the embeddings path, recall forwards it because the stdio child does not inherit the
 * parent environment under every runtime.
 */
export interface MemoryRecallSupermemory {
  readonly baseUrl: string;
  readonly container: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

/** bujo recall: a memory root (+ optional embeddings for semantic ranking). */
export interface MemoryRecallBujoSettings {
  /** Memory root directory (config.memory.path). */
  readonly root: string;
  /** Configured strict tier; required to retain BuJo graph capability in read-only recall. */
  readonly tier?: MemoryMode;
  /**
   * Optional exact managed-generation database path. Command paths resolve this once so a semantic
   * attempt and its FTS fallback cannot observe different active generations.
   */
  readonly dbPath?: string;
  /** Embeddings for semantic recall. Omitted for an FTS-only (lite) recall store. */
  readonly embeddings?: MemoryRecallEmbeddings;
  /** Explicit degraded path used only after a configured semantic recall failure. */
  readonly ftsOnlyFallback?: true;
}

/** supermemory recall: search the external instance over REST. */
export interface MemoryRecallSupermemorySettings {
  readonly supermemory: MemoryRecallSupermemory;
}

/** Recall settings discriminated structurally by the presence of `supermemory`. */
export type MemoryRecallSettings = MemoryRecallBujoSettings | MemoryRecallSupermemorySettings;

export interface ResolveMemoryRecallSettingsOptions {
  /** Ignore only the live MCP-tool availability gate for explicit operator preview/maintenance. */
  readonly ignoreRecallToolGate?: boolean;
}

/**
 * Resolve recall settings from the single in-app memory block. Returns `undefined` when memory is
 * unconfigured or, unless explicitly bypassed for operator commands, the live recall tool is off.
 */
export function resolveMemoryRecallSettings(
  config: MonoAgentConfig,
  options: ResolveMemoryRecallSettingsOptions = {},
): MemoryRecallSettings | undefined {
  const memory = config.memory;
  if (memory === undefined) {
    return undefined;
  }
  if (!options.ignoreRecallToolGate && memory.recallTool?.enabled === false) {
    return undefined;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const sm = memory.supermemory;
    if (sm === undefined) {
      // Defensive: the loader already rejects backend "supermemory" without a block.
      return undefined;
    }
    return {
      supermemory: {
        baseUrl: sm.baseUrl,
        container: resolveSupermemoryContainer(config),
        // The loader already resolved apiKeyEnv to apiKey; the child needs the value.
        ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
        ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
      },
    };
  }
  const embeddings = memory.embeddings;
  if (embeddings === undefined) {
    return { root: memory.path, tier: memory.mode };
  }
  return {
    root: memory.path,
    tier: memory.mode,
    embeddings: {
      provider: embeddings.provider,
      model: embeddings.model,
      ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
      // Keep the configured env name authoritative in the child; retain the resolved value for the
      // in-app provider and for the inline-key case where no name exists.
      ...(embeddings.apiKeyEnv === undefined ? {} : { apiKeyEnv: embeddings.apiKeyEnv }),
      ...(embeddings.apiKey === undefined ? {} : { apiKey: embeddings.apiKey }),
      ...(embeddings.dim === undefined ? {} : { dim: embeddings.dim }),
      ...(embeddings.timeoutMs === undefined ? {} : { timeoutMs: embeddings.timeoutMs }),
      ...(embeddings.circuitBreaker === undefined ? {} : { circuitBreaker: embeddings.circuitBreaker }),
    },
  };
}

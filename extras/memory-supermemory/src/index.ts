import { createSupermemoryHttpClient } from "./client.js";
import type { SupermemorySearchMode } from "./client.js";
import { SupermemoryMemoryStore } from "./store.js";

export { createSupermemoryHttpClient } from "./client.js";
export type {
  SupermemoryAddParams,
  SupermemoryClient,
  SupermemoryFetch,
  SupermemoryFetchResponse,
  SupermemoryHit,
  SupermemoryHttpClientConfig,
  SupermemoryMetadataValue,
  SupermemorySearchMode,
  SupermemorySearchParams,
} from "./client.js";
export { formatHitsAsBlock, SUPERMEMORY_SOURCE } from "./format.js";
export { SupermemoryMemoryStore } from "./store.js";
export type { SupermemoryRecallHit, SupermemoryStoreOptions } from "./store.js";

/** Config for the convenience factory that wires an HTTP client + store in one call. */
export interface CreateSupermemoryStoreConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Namespace tag scoping this agent's memories. */
  readonly container: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly searchLimit?: number;
  readonly searchMode?: SupermemorySearchMode;
  readonly threshold?: number;
  readonly rerank?: boolean;
  readonly logger?: { warn(message: string): void };
}

export interface SupermemoryConfigValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate plugin-owned service settings without making a network request.
 * Connectivity remains the explicit live smoke because installation must not
 * send agent data to an external service implicitly.
 */
export function validateSupermemoryConfig(
  config: CreateSupermemoryStoreConfig,
): SupermemoryConfigValidation {
  const errors: string[] = [];
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push("baseUrl must use http or https.");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      errors.push("baseUrl must not contain credentials; use apiKey instead.");
    }
  } catch {
    errors.push("baseUrl must be a valid absolute URL.");
  }
  if (config.container.trim().length === 0) {
    errors.push("container must not be empty.");
  }
  if (config.apiKey !== undefined && config.apiKey.trim().length === 0) {
    errors.push("apiKey must be omitted rather than set to an empty value.");
  }
  positiveNumberError(errors, "timeoutMs", config.timeoutMs);
  positiveNumberError(errors, "maxBytes", config.maxBytes);
  positiveIntegerError(errors, "searchLimit", config.searchLimit);
  if (
    config.threshold !== undefined
    && (!Number.isFinite(config.threshold) || config.threshold < 0 || config.threshold > 1)
  ) {
    errors.push("threshold must be between 0 and 1.");
  }
  return { valid: errors.length === 0, errors };
}

/** Build a {@link SupermemoryMemoryStore} over the REST client. The single entry point hosts use. */
export function createSupermemoryStore(config: CreateSupermemoryStoreConfig): SupermemoryMemoryStore {
  const validation = validateSupermemoryConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid Supermemory configuration: ${validation.errors.join(" ")}`);
  }
  const client = createSupermemoryHttpClient({
    baseUrl: config.baseUrl,
    containerTag: config.container,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.searchLimit === undefined ? {} : { searchLimit: config.searchLimit }),
    ...(config.searchMode === undefined ? {} : { searchMode: config.searchMode }),
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(config.rerank === undefined ? {} : { rerank: config.rerank }),
  });
  return new SupermemoryMemoryStore(client, {
    ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
    ...(config.searchLimit === undefined ? {} : { recallLimit: config.searchLimit }),
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  });
}

function positiveNumberError(errors: string[], field: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    errors.push(`${field} must be greater than zero.`);
  }
}

function positiveIntegerError(errors: string[], field: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    errors.push(`${field} must be a positive integer.`);
  }
}

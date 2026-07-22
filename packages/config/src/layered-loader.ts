import { readMonoAgentConfigJson } from "./json-source.js";
import type {
  MonoAgentConfigJson,
  MonoAgentMemoryConsolidationJson,
  MonoAgentMemoryEmbeddingsJson,
  MonoAgentMemoryLlmJson,
} from "./json-source.js";
import { loadMonoAgentConfig, MEMORY_LLM_ENV_KEYS, MonoAgentConfigError } from "./config.js";
import type { MonoAgentConfig } from "./types.js";

export interface LoadMonoAgentConfigWithSourcesInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /**
   * Optional path to a JSON config file. Missing or empty file is OK.
   * When set, values from JSON fill in fields that are not present in env;
   * env always wins for fields present in both layers.
   */
  readonly jsonPath?: string;
}

/**
 * Layered loader: JSON file provides defaults, env vars override.
 *
 * Precedence (highest first):
 *   1. process env
 *   2. mono-agent.config.json
 *   3. built-in defaults from loadMonoAgentConfig (executionMode, sessions, etc.)
 *
 * Returns the same `MonoAgentConfig` shape as `loadMonoAgentConfig` so
 * existing call sites only need to swap the loader.
 */
export async function loadMonoAgentConfigWithSources(
  input: LoadMonoAgentConfigWithSourcesInput,
): Promise<MonoAgentConfig> {
  const jsonLayer = input.jsonPath === undefined
    ? {}
    : (await readMonoAgentConfigJson(input.jsonPath)).json;
  // Validate raw JSON before flattening it into the string-only env surface.
  // String(...) coercion is intentional for valid numeric/boolean settings,
  // but must never make arrays or other malformed nested values look valid.
  validateJsonMemoryBlocks(jsonLayer, input.env);
  const layeredEnv = layerJsonOntoEnv(jsonLayer, input.env);
  try {
    return loadMonoAgentConfig({ env: layeredEnv, cwd: input.cwd });
  } catch (error) {
    throw remapJsonMemoryError(error, jsonLayer, input.env);
  }
}

/** Preserve the operator's real source surface when layered memory validation fails. */
function remapJsonMemoryError(
  error: unknown,
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): unknown {
  if (!(error instanceof MonoAgentConfigError) || json.memory === undefined) return error;

  const source = error.details.env;
  const scalarPath = jsonMemoryPathForSource(source, json.memory, env);
  if (scalarPath !== undefined && source !== undefined) {
    return remapConfigErrorToJson(error, source, scalarPath);
  }
  if (error.code !== "invalid_env") return error;
  if (
    source === "MONO_AGENT_MEMORY_BACKEND"
    && !hasValue(env.MONO_AGENT_MEMORY_BACKEND)
    && json.memory.backend !== undefined
  ) {
    return remapConfigErrorToJson(error, source, "memory.backend");
  }
  if (hasValue(env.MONO_AGENT_MEMORY_MODE)) return error;

  if (error.details.env === "MONO_AGENT_MEMORY_MODE") {
    const mode = normalizeJsonEnum(json.memory.mode) ?? "lite";
    const jsonPath = incompatibleJsonMemoryPath(mode, json.memory);
    if (jsonPath !== undefined) {
      const message = `memory.mode "${mode}" cannot configure ${jsonPath}.`;
      return new MonoAgentConfigError("invalid_json", message, { path: jsonPath, reason: message });
    }
    const implicatedEnv = envCapabilityActivator(mode, env);
    if (implicatedEnv !== undefined) {
      const message = `${implicatedEnv} is incompatible with memory.mode "${mode}" from mono-agent.config.json.`;
      return new MonoAgentConfigError("invalid_env", message, { env: implicatedEnv, reason: message });
    }
  }

  let path: string | undefined;
  if (source === "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL") path = "memory.embeddings";
  else if (source === "MONO_AGENT_MEMORY_LLM_MODEL") path = "memory.llm";
  else if (source === "MONO_AGENT_MEMORY_MODE") path = "memory.mode";
  if (path === undefined) return error;

  const mode = normalizeJsonEnum(json.memory.mode) ?? "lite";
  const message = source === "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL"
    ? `memory.mode "${mode}" requires an explicit memory.embeddings block.`
    : source === "MONO_AGENT_MEMORY_LLM_MODEL"
      ? `memory.mode "${mode}" requires an explicit memory.llm block.`
      : error.message.replaceAll("MONO_AGENT_MEMORY_MODE", "memory.mode");
  return new MonoAgentConfigError("invalid_json", message, { path, reason: message });
}

type MemoryJson = NonNullable<MonoAgentConfigJson["memory"]>;
type MemoryJsonBackend = "bujo" | "supermemory";

const MEMORY_JSON_SOURCES = {
  MONO_AGENT_MEMORY_BACKEND: jsonMemorySource("memory.backend", (memory) => memory.backend),
  MONO_AGENT_MEMORY_PATH: jsonMemorySource("memory.path", (memory) => memory.path),
  MONO_AGENT_MEMORY_MAX_BYTES: jsonMemorySource("memory.maxBytes", (memory) => memory.maxBytes),
  MONO_AGENT_MEMORY_WRITE_MODE: jsonMemorySource("memory.writeMode", (memory) => memory.writeMode),
  MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: jsonMemorySource(
    "memory.recallTool.enabled",
    (memory) => memory.recallTool?.enabled,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: jsonMemorySource(
    "memory.supermemory.baseUrl",
    (memory) => memory.supermemory?.baseUrl,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: jsonMemorySource(
    "memory.supermemory.apiKey",
    (memory) => memory.supermemory?.apiKey,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV: jsonMemorySource(
    "memory.supermemory.apiKeyEnv",
    (memory) => memory.supermemory?.apiKeyEnv,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: jsonMemorySource(
    "memory.supermemory.container",
    (memory) => memory.supermemory?.container,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS: jsonMemorySource(
    "memory.supermemory.timeoutMs",
    (memory) => memory.supermemory?.timeoutMs,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER: jsonMemorySource(
    "memory.supermemory.exposeMcpServer",
    (memory) => memory.supermemory?.exposeMcpServer,
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: jsonMemorySource(
    "memory.embeddings.provider",
    (memory) => memory.embeddings?.provider,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: jsonMemorySource(
    "memory.embeddings.model",
    (memory) => memory.embeddings?.model,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: jsonMemorySource(
    "memory.embeddings.endpoint",
    (memory) => memory.embeddings?.endpoint,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: jsonMemorySource(
    "memory.embeddings.apiKey",
    (memory) => memory.embeddings?.apiKey,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: jsonMemorySource(
    "memory.embeddings.apiKeyEnv",
    (memory) => memory.embeddings?.apiKeyEnv,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_DIM: jsonMemorySource(
    "memory.embeddings.dim",
    (memory) => memory.embeddings?.dim,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: jsonMemorySource(
    "memory.embeddings.timeoutMs",
    (memory) => memory.embeddings?.timeoutMs,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: jsonMemorySource(
    "memory.embeddings.circuitBreaker.failureThreshold",
    (memory) => memory.embeddings?.circuitBreaker?.failureThreshold,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS: jsonMemorySource(
    "memory.embeddings.circuitBreaker.cooldownMs",
    (memory) => memory.embeddings?.circuitBreaker?.cooldownMs,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_PROVIDER: jsonMemorySource(
    "memory.llm.provider",
    (memory) => memory.llm?.provider,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_MODEL: jsonMemorySource(
    "memory.llm.model",
    (memory) => memory.llm?.model,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_EXECUTION_MODE: jsonMemorySource(
    "memory.llm.executionMode",
    (memory) => memory.llm?.executionMode,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_ENDPOINT: jsonMemorySource(
    "memory.llm.endpoint",
    (memory) => memory.llm?.endpoint,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_TRACE: jsonMemorySource(
    "memory.llm.trace",
    (memory) => memory.llm?.trace,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: jsonMemorySource(
    "memory.llm.timeoutMs",
    (memory) => memory.llm?.timeoutMs,
    "bujo",
  ),
  MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: jsonMemorySource(
    "memory.consolidation.enabled",
    (memory) => memory.consolidation?.enabled,
    "bujo",
  ),
  MONO_AGENT_MEMORY_CONSOLIDATION_CRON: jsonMemorySource(
    "memory.consolidation.cron",
    (memory) => memory.consolidation?.cron,
    "bujo",
  ),
} as const;

function jsonMemorySource(
  path: string,
  read: (memory: MemoryJson) => unknown,
  backend?: MemoryJsonBackend,
): { readonly path: string; readonly read: (memory: MemoryJson) => unknown; readonly backend?: MemoryJsonBackend } {
  return { path, read, ...(backend === undefined ? {} : { backend }) };
}

function jsonMemoryPathForSource(
  source: unknown,
  memory: MemoryJson,
  env: Record<string, string | undefined>,
): string | undefined {
  if (source === "MONO_AGENT_MEMORY_MODE") return undefined;
  if (
    source === "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL"
    && !hasValue(env.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL)
  ) {
    return jsonSupermemoryRequiresBaseUrl(memory, env)
      ? "memory.supermemory.baseUrl"
      : undefined;
  }
  if (
    source === "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY"
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY)
  ) {
    return jsonEmbeddingsCredentialPath(memory, env);
  }
  if (typeof source !== "string" || !Object.hasOwn(MEMORY_JSON_SOURCES, source)) return undefined;
  const envName = source as keyof typeof MEMORY_JSON_SOURCES;
  const mapping = MEMORY_JSON_SOURCES[envName];
  const effectiveBackend = env.MONO_AGENT_MEMORY_BACKEND?.trim()
    || normalizeJsonEnum(memory.backend)
    || "bujo";
  if (
    hasValue(env[envName])
    || (mapping.backend !== undefined && mapping.backend !== effectiveBackend)
    || mapping.read(memory) === undefined
  ) return undefined;
  return mapping.path;
}

function jsonSupermemoryRequiresBaseUrl(
  memory: MemoryJson,
  env: Record<string, string | undefined>,
): boolean {
  if (
    !hasValue(env.MONO_AGENT_MEMORY_BACKEND)
    && normalizeJsonEnum(memory.backend) === "supermemory"
  ) return true;
  const supermemory = memory.supermemory;
  if (supermemory === undefined) return false;
  const activatingStringLeaves = [
    ["apiKey", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY"],
    ["apiKeyEnv", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV"],
    ["container", "MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER"],
  ] as const;
  if (activatingStringLeaves.some(([field, envName]) => (
    hasJsonString(supermemory[field]) && !hasValue(env[envName])
  ))) return true;
  const activatingScalarLeaves = [
    ["timeoutMs", "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS"],
    ["exposeMcpServer", "MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER"],
  ] as const;
  return activatingScalarLeaves.some(([field, envName]) => (
    supermemory[field] !== undefined && !hasValue(env[envName])
  ));
}

function jsonEmbeddingsCredentialPath(
  memory: MemoryJson,
  env: Record<string, string | undefined>,
): "memory.embeddings.apiKey" | "memory.embeddings.apiKeyEnv" | undefined {
  const embeddings = memory.embeddings;
  if (embeddings === undefined) return undefined;
  if (
    hasJsonString(embeddings.apiKeyEnv)
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV)
  ) return "memory.embeddings.apiKeyEnv";
  if (
    normalizeJsonEnum(embeddings.provider) === "openai"
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER)
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV)
    && !hasJsonString(embeddings.apiKey)
    && !hasJsonString(embeddings.apiKeyEnv)
  ) return "memory.embeddings.apiKey";
  return undefined;
}

function remapConfigErrorToJson(
  error: MonoAgentConfigError,
  source: string,
  path: string,
): MonoAgentConfigError {
  const replaced = error.message.replaceAll(source, path);
  const message = replaced.includes(path) ? replaced : `${path}: ${replaced}`;
  const { code: _code, env: _env, ...details } = error.details;
  return new MonoAgentConfigError("invalid_json", message, {
    ...details,
    path,
    reason: error.details.reason ?? message,
  });
}

function validateJsonMemoryBlocks(
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): void {
  const memory: unknown = json.memory;
  if (memory !== undefined && !isJsonObject(memory)) {
    throwInvalidJsonValue("memory", "an object");
  }

  // Strict BuJo tier blocks do not belong to external memory backends. Resolve
  // backend precedence first (env wins directly here), then ignore stale
  // local blocks exactly as the runtime and published schema do. Unknown
  // backends are left to loadMonoAgentConfig so the authoritative invalid_env
  // diagnostic is not masked by a lower-precedence JSON detail.
  const effectiveBackendValue: unknown = hasValue(env.MONO_AGENT_MEMORY_BACKEND)
    ? env.MONO_AGENT_MEMORY_BACKEND
    : memory?.backend;
  if (effectiveBackendValue !== undefined && typeof effectiveBackendValue !== "string") {
    throwInvalidJsonValue("memory.backend", "a string");
  }
  const effectiveBackend = effectiveBackendValue?.trim() || "bujo";
  if (effectiveBackend !== "bujo" && effectiveBackend !== "supermemory") return;
  if (memory === undefined) return;

  validateJsonScalarFields(memory, "memory", env, [
    ["backend", "MONO_AGENT_MEMORY_BACKEND", "string"],
    ["mode", "MONO_AGENT_MEMORY_MODE", "string"],
    ["path", "MONO_AGENT_MEMORY_PATH", "string"],
    ["maxBytes", "MONO_AGENT_MEMORY_MAX_BYTES", "number"],
    ["writeMode", "MONO_AGENT_MEMORY_WRITE_MODE", "string"],
  ]);

  const recallTool = validateOptionalJsonObject(memory.recallTool, "memory.recallTool");
  if (recallTool !== undefined) {
    validateJsonScalarFields(recallTool, "memory.recallTool", env, [
      ["enabled", "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED", "boolean"],
    ]);
  }

  const supermemory = validateOptionalJsonObject(memory.supermemory, "memory.supermemory");
  if (supermemory !== undefined) {
    validateJsonScalarFields(supermemory, "memory.supermemory", env, [
      ["baseUrl", "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL", "string"],
      ["apiKey", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY", "string"],
      ["apiKeyEnv", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV", "string"],
      ["container", "MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER", "string"],
      ["timeoutMs", "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS", "number"],
      ["exposeMcpServer", "MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER", "boolean"],
    ]);
  }
  if (effectiveBackend === "supermemory") return;

  const embeddings = validateOptionalJsonObject(memory.embeddings, "memory.embeddings");
  if (embeddings !== undefined) {
    validateJsonScalarFields(embeddings, "memory.embeddings", env, [
      ["provider", "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER", "string"],
      ["model", "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL", "string"],
      ["endpoint", "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT", "string"],
      ["apiKey", "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY", "string"],
      ["apiKeyEnv", "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV", "string"],
      ["dim", "MONO_AGENT_MEMORY_EMBEDDINGS_DIM", "number"],
      ["timeoutMs", "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS", "number"],
    ]);
    const circuitBreaker = validateOptionalJsonObject(
      embeddings.circuitBreaker,
      "memory.embeddings.circuitBreaker",
    );
    if (circuitBreaker !== undefined) {
      validateJsonScalarFields(circuitBreaker, "memory.embeddings.circuitBreaker", env, [
        [
          "failureThreshold",
          "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
          "number",
        ],
        ["cooldownMs", "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS", "number"],
      ]);
    }
  }
  if (embeddings !== undefined && Object.keys(embeddings).length === 0) {
    const path = "memory.embeddings";
    const message = `${path} must contain at least one setting; provider, model, and dim default after the block is activated.`;
    throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
  }

  const llm = validateOptionalJsonObject(memory.llm, "memory.llm");
  if (llm !== undefined) validateJsonMemoryLlmFields(llm, env);
  if (llm !== undefined && Object.keys(llm).length === 0) {
    const path = "memory.llm";
    const effectiveModeValue: unknown = hasValue(env.MONO_AGENT_MEMORY_MODE)
      ? env.MONO_AGENT_MEMORY_MODE
      : memory.mode;
    if (effectiveModeValue !== undefined && typeof effectiveModeValue !== "string") {
      throwInvalidJsonValue("memory.mode", "a string");
    }
    const mode = effectiveModeValue?.trim() || "lite";
    const message = mode === "bujo"
      ? `${path} must contain a model for memory.mode "bujo".`
      : `memory.mode "${mode}" cannot configure ${path}.`;
    throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
  }

  const consolidation = validateOptionalJsonObject(memory.consolidation, "memory.consolidation");
  if (consolidation !== undefined) {
    validateJsonScalarFields(consolidation, "memory.consolidation", env, [
      ["enabled", "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED", "boolean"],
      ["cron", "MONO_AGENT_MEMORY_CONSOLIDATION_CRON", "string"],
    ]);
  }
}

type JsonScalarKind = "string" | "number" | "boolean";
type JsonScalarFieldSpec = readonly [field: string, envName: string, kind: JsonScalarKind];

function validateJsonScalarFields(
  value: Record<string, unknown>,
  path: string,
  env: Record<string, string | undefined>,
  specs: readonly JsonScalarFieldSpec[],
): void {
  for (const [field, envName, kind] of specs) {
    if (hasValue(env[envName]) || value[field] === undefined) continue;
    if (typeof value[field] !== kind) {
      throwInvalidJsonValue(`${path}.${field}`, `a ${kind}`);
    }
  }
}

function validateOptionalJsonObject(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throwInvalidJsonValue(path, "an object");
  return value;
}

function validateJsonMemoryLlmFields(
  llm: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  const stringFields = [
    ["provider", "MONO_AGENT_MEMORY_LLM_PROVIDER"],
    ["model", "MONO_AGENT_MEMORY_LLM_MODEL"],
    ["executionMode", "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE"],
    ["endpoint", "MONO_AGENT_MEMORY_LLM_ENDPOINT"],
  ] as const;
  for (const [field, envName] of stringFields) {
    if (field === "endpoint" && shouldDropJsonMemoryLlmEndpoint(llm, env)) continue;
    if (hasValue(env[envName]) || llm[field] === undefined) continue;
    if (typeof llm[field] !== "string") throwInvalidJsonValue(`memory.llm.${field}`, "a string");
  }

  if (
    !hasValue(env.MONO_AGENT_MEMORY_LLM_TRACE)
    && llm.trace !== undefined
    && typeof llm.trace !== "boolean"
  ) {
    throwInvalidJsonValue("memory.llm.trace", "a boolean");
  }
  if (
    !hasValue(env.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS)
    && llm.timeoutMs !== undefined
    && typeof llm.timeoutMs !== "number"
  ) {
    throwInvalidJsonValue("memory.llm.timeoutMs", "a number");
  }
}

/** Match the established provider-switch cleanup before validating the stale JSON endpoint leaf. */
function shouldDropJsonMemoryLlmEndpoint(
  llm: { readonly provider?: unknown } | undefined,
  env: Record<string, string | undefined>,
): boolean {
  return env.MONO_AGENT_MEMORY_LLM_PROVIDER?.trim() === "agent-host"
    && normalizeJsonEnum(llm?.provider) !== "agent-host"
    && !hasValue(env.MONO_AGENT_MEMORY_LLM_ENDPOINT);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwInvalidJsonValue(path: string, expected: string): never {
  const message = `${path} must be ${expected}.`;
  throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
}

const MEMORY_EMBEDDINGS_ENV_KEYS = [
  "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
  "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
  "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT",
  "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
  "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
  "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
  "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
  "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
] as const;
const MEMORY_CONSOLIDATION_ENV_KEYS = [
  "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED",
  "MONO_AGENT_MEMORY_CONSOLIDATION_CRON",
] as const;
function incompatibleJsonMemoryPath(
  mode: string,
  memory: NonNullable<MonoAgentConfigJson["memory"]>,
): string | undefined {
  const normalizedMode = normalizeJsonEnum(mode) ?? "lite";
  if (normalizedMode === "lite" && jsonEmbeddingsActive(memory.embeddings)) return "memory.embeddings";
  if (
    (normalizedMode === "lite" || normalizedMode === "journal")
    && jsonLlmActive(memory.llm)
  ) return "memory.llm";
  if (
    (normalizedMode === "lite" || normalizedMode === "journal")
    && jsonConsolidationActive(memory.consolidation)
  ) {
    return "memory.consolidation";
  }
  return undefined;
}

function envCapabilityActivator(
  mode: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const normalizedMode = normalizeJsonEnum(mode) ?? "lite";
  if (normalizedMode === "lite") {
    const embeddings = firstConfiguredEnv(env, MEMORY_EMBEDDINGS_ENV_KEYS);
    if (embeddings !== undefined) return embeddings;
  }
  if (normalizedMode === "lite" || normalizedMode === "journal") {
    const llm = firstConfiguredEnv(env, MEMORY_LLM_ENV_KEYS);
    if (llm !== undefined) return llm;
  }
  if (normalizedMode === "lite" || normalizedMode === "journal") {
    return firstConfiguredEnv(env, MEMORY_CONSOLIDATION_ENV_KEYS);
  }
  return undefined;
}

function jsonEmbeddingsActive(value: MonoAgentMemoryEmbeddingsJson | undefined): boolean {
  return value !== undefined && (
    hasJsonString(value.provider)
    || hasJsonString(value.model)
    || hasJsonString(value.endpoint)
    || hasJsonString(value.apiKey)
    || hasJsonString(value.apiKeyEnv)
    || value.dim !== undefined
    || value.timeoutMs !== undefined
    || value.circuitBreaker?.failureThreshold !== undefined
    || value.circuitBreaker?.cooldownMs !== undefined
  );
}

function jsonConsolidationActive(value: MonoAgentMemoryConsolidationJson | undefined): boolean {
  return value !== undefined && (value.enabled !== undefined || hasJsonString(value.cron));
}

function jsonLlmActive(value: MonoAgentMemoryLlmJson | undefined): boolean {
  return value !== undefined && (
    hasJsonString(value.provider)
    || hasJsonString(value.model)
    || hasJsonString(value.executionMode)
    || hasJsonString(value.endpoint)
    || value.trace !== undefined
    || value.timeoutMs !== undefined
  );
}

function hasJsonString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Mirror normalizeOptionalString before comparing enum-like JSON values. */
function normalizeJsonEnum(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function firstConfiguredEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  return names.find((name) => hasValue(env[name]));
}

/**
 * Convert a JSON config object into a flat env-like record so we can hand it
 * to the existing env-based loader. Env values present in `env` take
 * precedence over JSON-derived values.
 */
export function layerJsonOntoEnv(
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  validateJsonRuntimeCompaction(json);
  const fromJson: Record<string, string | undefined> = {};
  if (json.agent?.name !== undefined) {
    fromJson.MONO_AGENT_NAME = json.agent.name;
  }
  if (json.runtime?.model !== undefined) {
    fromJson.MONO_AGENT_MODEL = json.runtime.model;
  }
  // Legacy CSV intentionally uses an empty string to clear JSON fallbacks.
  // Canonical JSON clears with `[]`; an empty JSON string remains unset.
  const fallbackEnvPresent = hasValue(env.MONO_AGENT_FALLBACKS_JSON)
    || env.MONO_AGENT_FALLBACK_MODELS !== undefined;
  if (!fallbackEnvPresent) {
    if (json.runtime?.fallbackModels !== undefined) {
      fromJson.MONO_AGENT_FALLBACK_MODELS = csv(json.runtime.fallbackModels);
    }
    if (json.runtime?.fallbacks !== undefined) {
      fromJson.MONO_AGENT_FALLBACKS_JSON = JSON.stringify(json.runtime.fallbacks);
    }
  }
  if (json.runtime?.routeSafety !== undefined) {
    fromJson.MONO_AGENT_ROUTE_SAFETY = json.runtime.routeSafety;
  }
  if (json.runtime?.executionMode !== undefined) {
    fromJson.MONO_AGENT_EXECUTION_MODE = json.runtime.executionMode;
  }
  if (json.runtime?.effort !== undefined) {
    fromJson.MONO_AGENT_EFFORT = json.runtime.effort;
  }
  if (json.runtime?.permissionMode !== undefined) {
    fromJson.MONO_AGENT_PERMISSION_MODE = json.runtime.permissionMode;
  }
  if (json.runtime?.maxTurns !== undefined) {
    fromJson.MONO_AGENT_MAX_TURNS = String(json.runtime.maxTurns);
  }
  if (json.runtime?.compaction?.enabled !== undefined) {
    if (typeof json.runtime.compaction.enabled !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", "runtime.compaction.enabled must be a boolean.", {
        path: "runtime.compaction.enabled",
      });
    }
    fromJson.MONO_AGENT_COMPACTION_ENABLED = String(json.runtime.compaction.enabled);
  }
  if (json.runtime?.compaction?.triggerRatio !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_TRIGGER_RATIO = String(json.runtime.compaction.triggerRatio);
  }
  if (json.runtime?.compaction?.keepRecentTokens !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS = String(json.runtime.compaction.keepRecentTokens);
  }
  if (json.runtime?.compaction?.summaryMaxTokens !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS = String(json.runtime.compaction.summaryMaxTokens);
  }
  if (json.runtime?.compaction?.minSavingsTokens !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS = String(json.runtime.compaction.minSavingsTokens);
  }
  if (json.runtime?.compaction?.fixedOverheadEnabled !== undefined) {
    if (typeof json.runtime.compaction.fixedOverheadEnabled !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", "runtime.compaction.fixedOverheadEnabled must be a boolean.", {
        path: "runtime.compaction.fixedOverheadEnabled",
      });
    }
    fromJson.MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED = String(json.runtime.compaction.fixedOverheadEnabled);
  }
  if (json.runtime?.compaction?.contextWindowOverride !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE = String(json.runtime.compaction.contextWindowOverride);
  }
  if (json.runtime?.workspace !== undefined) {
    fromJson.MONO_AGENT_WORKSPACE = json.runtime.workspace;
  }
  if (json.runtime?.session?.mode !== undefined) {
    fromJson.MONO_AGENT_SESSION_MODE = json.runtime.session.mode;
  }
  if (json.runtime?.session?.idleTimeoutMs !== undefined) {
    fromJson.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS = String(json.runtime.session.idleTimeoutMs);
  }
  if (json.runtime?.session?.rollover !== undefined) {
    fromJson.MONO_AGENT_SESSION_ROLLOVER = json.runtime.session.rollover;
  }
  if (json.runtime?.session?.rolloverTimezone !== undefined) {
    fromJson.MONO_AGENT_SESSION_ROLLOVER_TIMEZONE = json.runtime.session.rolloverTimezone;
  }
  if (json.runtime?.session?.rolloverNotice !== undefined) {
    if (typeof json.runtime.session.rolloverNotice !== "boolean") {
      throw new MonoAgentConfigError("invalid_env", "runtime.session.rolloverNotice must be a boolean.", {
        path: "runtime.session.rolloverNotice",
      });
    }
    fromJson.MONO_AGENT_SESSION_ROLLOVER_NOTICE = String(json.runtime.session.rolloverNotice);
  }
  if (json.runtime?.session?.isolateProactive !== undefined) {
    fromJson.MONO_AGENT_SESSION_ISOLATE_PROACTIVE = String(json.runtime.session.isolateProactive);
  }
  if (json.concurrency?.maxConcurrentRuns !== undefined) {
    fromJson.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS = String(json.concurrency.maxConcurrentRuns);
  }
  if (json.concurrency?.maxPendingRuns !== undefined) {
    fromJson.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS = String(json.concurrency.maxPendingRuns);
  }
  if (json.context?.identityPath !== undefined) {
    fromJson.MONO_AGENT_IDENTITY_PATH = json.context.identityPath;
  }
  if (json.context?.soulPath !== undefined) {
    fromJson.MONO_AGENT_SOUL_PATH = json.context.soulPath;
  }
  if (json.context?.skillsRoot !== undefined) {
    fromJson.MONO_AGENT_SKILLS_ROOT = json.context.skillsRoot;
  }
  if (json.context?.selectedSkills !== undefined) {
    fromJson.MONO_AGENT_SELECTED_SKILLS = csv(json.context.selectedSkills);
  }
  if (json.context?.skillMaxBytes !== undefined) {
    fromJson.MONO_AGENT_SKILL_MAX_BYTES = String(json.context.skillMaxBytes);
  }
  if (json.context?.skillDisclosure !== undefined) {
    fromJson.MONO_AGENT_SKILL_DISCLOSURE = json.context.skillDisclosure;
  }
  if (json.memory?.backend !== undefined) {
    fromJson.MONO_AGENT_MEMORY_BACKEND = json.memory.backend;
  }
  if (json.memory?.mode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_MODE = json.memory.mode;
  }
  if (json.memory?.path !== undefined) {
    fromJson.MONO_AGENT_MEMORY_PATH = json.memory.path;
  }
  if (json.memory?.maxBytes !== undefined) {
    fromJson.MONO_AGENT_MEMORY_MAX_BYTES = String(json.memory.maxBytes);
  }
  if (json.memory?.writeMode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_WRITE_MODE = json.memory.writeMode;
  }
  if (json.memory?.supermemory?.baseUrl !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL = json.memory.supermemory.baseUrl;
  }
  if (json.memory?.supermemory?.apiKey !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY = json.memory.supermemory.apiKey;
  }
  if (json.memory?.supermemory?.apiKeyEnv !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV = json.memory.supermemory.apiKeyEnv;
  }
  if (json.memory?.supermemory?.container !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER = json.memory.supermemory.container;
  }
  if (json.memory?.supermemory?.timeoutMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS = String(json.memory.supermemory.timeoutMs);
  }
  if (json.memory?.supermemory?.exposeMcpServer !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER = String(json.memory.supermemory.exposeMcpServer);
  }
  if (json.memory?.embeddings?.provider !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER = json.memory.embeddings.provider;
  }
  if (json.memory?.embeddings?.model !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL = json.memory.embeddings.model;
  }
  if (json.memory?.embeddings?.endpoint !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT = json.memory.embeddings.endpoint;
  }
  if (json.memory?.embeddings?.apiKey !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY = json.memory.embeddings.apiKey;
  }
  if (json.memory?.embeddings?.apiKeyEnv !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV = json.memory.embeddings.apiKeyEnv;
  }
  if (json.memory?.embeddings?.dim !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_DIM = String(json.memory.embeddings.dim);
  }
  if (json.memory?.embeddings?.timeoutMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS = String(json.memory.embeddings.timeoutMs);
  }
  if (json.memory?.embeddings?.circuitBreaker?.failureThreshold !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD = String(
      json.memory.embeddings.circuitBreaker.failureThreshold,
    );
  }
  if (json.memory?.embeddings?.circuitBreaker?.cooldownMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS = String(
      json.memory.embeddings.circuitBreaker.cooldownMs,
    );
  }
  if (json.memory?.llm?.provider !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_PROVIDER = json.memory.llm.provider;
  }
  if (json.memory?.llm?.model !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_MODEL = json.memory.llm.model;
  }
  if (json.memory?.llm?.executionMode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_EXECUTION_MODE = json.memory.llm.executionMode;
  }
  if (json.memory?.llm?.trace !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_TRACE = String(json.memory.llm.trace);
  }
  if (json.memory?.llm?.timeoutMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS = String(json.memory.llm.timeoutMs);
  }
  if (json.memory?.llm?.endpoint !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_ENDPOINT = json.memory.llm.endpoint;
  }
  if (json.memory?.recallTool?.enabled !== undefined) {
    fromJson.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED = String(json.memory.recallTool.enabled);
  }
  if (json.memory?.consolidation?.enabled !== undefined) {
    fromJson.MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED = String(json.memory.consolidation.enabled);
  }
  if (json.memory?.consolidation?.cron !== undefined) {
    fromJson.MONO_AGENT_MEMORY_CONSOLIDATION_CRON = json.memory.consolidation.cron;
  }
  if (json.tools?.allowedTools !== undefined) {
    fromJson.MONO_AGENT_ALLOWED_TOOLS = csv(json.tools.allowedTools);
  }
  if (json.tools?.disallowedTools !== undefined) {
    fromJson.MONO_AGENT_DISALLOWED_TOOLS = csv(json.tools.disallowedTools);
  }
  if (json.tools?.mcpConfigPath !== undefined) {
    fromJson.MONO_AGENT_MCP_CONFIG_PATH = json.tools.mcpConfigPath;
  }
  if (json.tools?.mcpRequestContextServers !== undefined) {
    fromJson.MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS = csv(json.tools.mcpRequestContextServers);
  }
  if (json.tools?.continuationServers !== undefined) {
    fromJson.MONO_AGENT_CONTINUATION_SERVERS = csv(json.tools.continuationServers);
  }
  if (json.tools?.mcpCallTimeoutMs !== undefined) {
    fromJson.MONO_AGENT_MCP_CALL_TIMEOUT_MS = String(json.tools.mcpCallTimeoutMs);
  }
  if (json.tools?.mcpCallMaxTotalTimeoutMs !== undefined) {
    fromJson.MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = String(json.tools.mcpCallMaxTotalTimeoutMs);
  }
  if (json.sandbox?.mode !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_MODE = json.sandbox.mode;
  }
  if (json.sandbox?.network?.mode !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_NETWORK = json.sandbox.network.mode;
  }
  if (json.sandbox?.network?.allowlist !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST = csv(json.sandbox.network.allowlist);
  }
  if (json.sandbox?.readableRoots !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_READABLE_ROOTS = csv(json.sandbox.readableRoots);
  }
  if (json.sandbox?.writableRoots !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_WRITABLE_ROOTS = csv(json.sandbox.writableRoots);
  }
  if (json.sandbox?.denyWrite !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_DENY_WRITE = csv(json.sandbox.denyWrite);
  }
  if (json.sandbox?.fallback !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_FALLBACK = json.sandbox.fallback;
  }
  if (json.sandbox?.unsafeAllowHostProcess !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS = String(json.sandbox.unsafeAllowHostProcess);
  }
  if (json.artifacts?.dir !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_DIR = json.artifacts.dir;
  }
  if (json.artifacts?.retention?.maxAgeDays !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS = String(json.artifacts.retention.maxAgeDays);
  }
  if (json.artifacts?.retention?.maxCount !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT = String(json.artifacts.retention.maxCount);
  }
  if (json.artifacts?.retention?.dryRun !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN = String(json.artifacts.retention.dryRun);
  }
  if (json.artifacts?.memoryRetention?.maxAgeDays !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS = String(json.artifacts.memoryRetention.maxAgeDays);
  }
  if (json.artifacts?.memoryRetention?.maxCount !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT = String(json.artifacts.memoryRetention.maxCount);
  }
  if (json.artifacts?.memoryRetention?.dryRun !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN = String(json.artifacts.memoryRetention.dryRun);
  }
  if (json.traceability?.registryDir !== undefined) {
    fromJson.MONO_AGENT_TRACE_REGISTRY_DIR = json.traceability.registryDir;
  }
  if (json.traceability?.sourceId !== undefined) {
    fromJson.MONO_AGENT_TRACE_SOURCE_ID = json.traceability.sourceId;
  }
  if (json.traceability?.sourceLabel !== undefined) {
    fromJson.MONO_AGENT_TRACE_SOURCE_LABEL = json.traceability.sourceLabel;
  }
  if (json.traceability?.heartbeatMs !== undefined) {
    fromJson.MONO_AGENT_TRACE_HEARTBEAT_MS = String(json.traceability.heartbeatMs);
  }
  if (json.traceability?.staleAfterMs !== undefined) {
    fromJson.MONO_AGENT_TRACE_STALE_AFTER_MS = String(json.traceability.staleAfterMs);
  }
  if (json.traceability?.globalDiscovery !== undefined) {
    fromJson.MONO_AGENT_TRACE_GLOBAL_DISCOVERY = String(json.traceability.globalDiscovery);
  }
  if (json.observability?.exporters !== undefined && !hasObservabilityEnv(env)) {
    fromJson.MONO_AGENT_OBSERVABILITY_EXPORTERS = JSON.stringify(json.observability.exporters);
  }
  if (json.providers?.piAuthPath !== undefined) {
    fromJson.MONO_AGENT_PI_AUTH_PATH = json.providers.piAuthPath;
  }
  if (json.providers?.local !== undefined && !hasLocalProviderEnv(env)) {
    fromJson.MONO_AGENT_LOCAL_PROVIDERS_JSON = JSON.stringify(json.providers.local);
  }
  if (json.providers?.piNative?.piMaxRetries !== undefined) {
    fromJson.MONO_AGENT_PI_MAX_RETRIES = String(json.providers.piNative.piMaxRetries);
  }
  if (json.providers?.piNative?.transport !== undefined) {
    fromJson.MONO_AGENT_PI_TRANSPORT = String(json.providers.piNative.transport);
  }
  if (json.providers?.piNative?.maxRetryDelayMs !== undefined) {
    fromJson.MONO_AGENT_MAX_RETRY_DELAY_MS = String(json.providers.piNative.maxRetryDelayMs);
  }
  if (json.providers?.piNative?.piSessionsRoot !== undefined) {
    fromJson.MONO_AGENT_PI_SESSIONS_ROOT = json.providers.piNative.piSessionsRoot;
  }

  // env wins: spread env last
  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined
      && (value.trim().length > 0 || key === "MONO_AGENT_FALLBACK_MODELS")
    ) {
      layered[key] = value;
    }
  }
  if (shouldDropJsonMemoryLlmEndpoint(json.memory?.llm, env)) {
    delete layered.MONO_AGENT_MEMORY_LLM_ENDPOINT;
  }
  return layered;
}

function validateJsonRuntimeCompaction(json: MonoAgentConfigJson): void {
  const compaction: unknown = json.runtime?.compaction;
  if (compaction === undefined) return;
  if (!isJsonObject(compaction)) {
    throw new MonoAgentConfigError("invalid_json", "runtime.compaction must be an object.", {
      path: "runtime.compaction",
    });
  }
  for (const field of ["enabled", "fixedOverheadEnabled"] as const) {
    const value = compaction[field];
    if (value !== undefined && typeof value !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", `runtime.compaction.${field} must be a boolean.`, {
        path: `runtime.compaction.${field}`,
      });
    }
  }
  const numbers = [
    ["triggerRatio", 0.2, 0.95, false],
    ["keepRecentTokens", 4_000, 200_000, true],
    ["summaryMaxTokens", 1_000, 64_000, true],
    ["minSavingsTokens", 0, 500_000, true],
    ["contextWindowOverride", 32_000, 10_000_000, true],
  ] as const;
  for (const [field, min, max, integer] of numbers) {
    const value = compaction[field];
    if (
      value !== undefined
      && (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max)
    ) {
      const kind = integer ? "an integer" : "a number";
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.compaction.${field} must be ${kind} between ${min} and ${max}.`,
        { path: `runtime.compaction.${field}` },
      );
    }
  }
}

function csv(values: readonly string[]): string {
  return values.join(",");
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasObservabilityEnv(env: Record<string, string | undefined>): boolean {
  const value = env.MONO_AGENT_OBSERVABILITY_EXPORTERS;
  return value !== undefined && value.trim().length > 0;
}

function hasLocalProviderEnv(env: Record<string, string | undefined>): boolean {
  return [
    "MONO_AGENT_LOCAL_PROVIDERS_JSON",
    "MONO_AGENT_LOCAL_PROVIDER_ID",
    "MONO_AGENT_LOCAL_PROVIDER_TYPE",
    "MONO_AGENT_LOCAL_PROVIDER_BASE_URL",
    "MONO_AGENT_LOCAL_PROVIDER_ENABLED",
    "MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL",
    "MONO_AGENT_LOCAL_PROVIDER_API_KEY",
  ].some((name) => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0;
  });
}

import {
  createProvider,
  getSupportedThinkingLevels,
  InMemoryModelsStore,
  lazyApi,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
  type ProviderModelsStore,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import type {
  RuntimePiConfig,
  RuntimePiLocalProviderConfig,
  RuntimePiModelConfig,
} from "./config.js";
import { parsePiModelReference } from "./config.js";

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_MODEL_DISCOVERY_BYTES = 1_048_576;
const MAX_DISCOVERED_MODELS = 10_000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export interface RuntimePiModelCapabilities {
  readonly tools: true;
  readonly attachments: boolean;
  readonly structuredOutput: false;
  readonly approvals: false;
  readonly sandbox: false;
  readonly thinkingLevels: readonly string[];
}

export interface RuntimePiModelRegistry {
  readonly models: Models;
  readonly configuredSecrets: readonly string[];
  resolve(reference: string, signal?: AbortSignal): Promise<Model<string>>;
  capabilities(reference: string, signal?: AbortSignal): Promise<RuntimePiModelCapabilities>;
}

function openAiCompatibleBaseUrl(authored: string): string {
  const url = new URL(authored);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "" || pathname === "/api") url.pathname = "/v1";
  else url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

function localAuth(providerId: string, _config: RuntimePiLocalProviderConfig) {
  const apiKey = "mono-agent-keyless-loopback";
  const source = "keyless loopback";
  return {
    apiKey: {
      name: `${providerId} API key`,
      async check() {
        return { type: "api_key" as const, source };
      },
      async resolve() {
        return { auth: { apiKey }, source };
      },
    },
  };
}

function piModel(
  providerId: string,
  baseUrl: string,
  model: RuntimePiModelConfig,
): Model<"openai-completions"> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    reasoning: model.reasoning ?? false,
    input: [...(model.input ?? ["text"])],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: model.reasoning ?? false,
      maxTokensField: "max_tokens",
    },
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new TypeError("runtime-pi local model discovery must return application/json");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_MODEL_DISCOVERY_BYTES) {
    throw new TypeError(`runtime-pi local model discovery exceeds ${MAX_MODEL_DISCOVERY_BYTES} bytes`);
  }
  if (response.body === null) {
    throw new TypeError("runtime-pi local model discovery returned an empty response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODEL_DISCOVERY_BYTES) {
        await reader.cancel();
        throw new TypeError(`runtime-pi local model discovery exceeds ${MAX_MODEL_DISCOVERY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new TypeError("runtime-pi local model discovery returned invalid JSON", { cause: error });
  }
}

function discoveredModelId(value: unknown, index: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)) {
    throw new TypeError(`runtime-pi local model discovery data[${index}].id must be a valid model id`);
  }
  return value;
}

async function discoverLocalModels(
  providerId: string,
  baseUrl: string,
  context: RefreshModelsContext,
): Promise<readonly Model<"openai-completions">[]> {
  if (!context.allowNetwork) return [];
  const timeoutSignal = AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS);
  const signal = context.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([context.signal, timeoutSignal]);
  const endpoint = new URL("models", `${baseUrl}/`);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (context.signal?.aborted === true) throw context.signal.reason;
    if (timeoutSignal.aborted) {
      throw new TypeError(`runtime-pi local model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms`);
    }
    throw new TypeError(`runtime-pi local model discovery failed for ${providerId}`, { cause: error });
  }
  if (!response.ok) {
    throw new TypeError(`runtime-pi local model discovery failed for ${providerId} with HTTP ${response.status}`);
  }

  const payload = await readBoundedJson(response);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("runtime-pi local model discovery response must be an object");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new TypeError("runtime-pi local model discovery response must contain a data array");
  }
  if (data.length > MAX_DISCOVERED_MODELS) {
    throw new TypeError(`runtime-pi local model discovery exceeds ${MAX_DISCOVERED_MODELS} models`);
  }

  const ids = new Set<string>();
  return data.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`runtime-pi local model discovery data[${index}] must be an object`);
    }
    const id = discoveredModelId((entry as { id?: unknown }).id, index);
    if (ids.has(id)) {
      throw new TypeError(`runtime-pi local model discovery contains duplicate model id ${JSON.stringify(id)}`);
    }
    ids.add(id);
    return piModel(providerId, baseUrl, { id });
  });
}

interface LocalProviderRegistration {
  readonly provider: Provider<"openai-completions">;
  readonly store: ProviderModelsStore;
}

function withoutLocalCredentials(
  credentials: CredentialStore,
  localProviderIds: ReadonlySet<string>,
): CredentialStore {
  return {
    async read(providerId) {
      return localProviderIds.has(providerId) ? undefined : credentials.read(providerId);
    },
    async list() {
      return (await credentials.list()).filter((credential) => !localProviderIds.has(credential.providerId));
    },
    async modify(providerId, fn) {
      if (localProviderIds.has(providerId)) {
        throw new TypeError("runtime-pi local providers do not persist credentials");
      }
      return credentials.modify(providerId, fn);
    },
    async delete(providerId) {
      if (!localProviderIds.has(providerId)) await credentials.delete(providerId);
    },
  };
}

function addLocalProvider(
  models: MutableModels,
  catalogStore: InMemoryModelsStore,
  config: RuntimePiLocalProviderConfig,
): LocalProviderRegistration {
  const providerId = config.id;
  if (models.getProvider(providerId) !== undefined) {
    throw new TypeError(`runtime-pi local provider ${JSON.stringify(providerId)} conflicts with a built-in provider`);
  }
  const baseUrl = openAiCompatibleBaseUrl(config.baseUrl);
  const provider = createProvider({
    id: providerId,
    name: providerId,
    baseUrl,
    auth: localAuth(providerId, config),
    models: (config.models ?? []).map((model) => piModel(providerId, baseUrl, model)),
    fetchModels: (context) => discoverLocalModels(providerId, baseUrl, context),
    api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  });
  models.setProvider(provider);
  return {
    provider,
    store: {
      read: () => catalogStore.read(providerId),
      write: (entry) => catalogStore.write(providerId, entry),
      delete: () => catalogStore.delete(providerId),
    },
  };
}

export function createRuntimePiModelRegistry(
  config: RuntimePiConfig,
  credentials: CredentialStore,
  injectedModels?: Models,
): RuntimePiModelRegistry {
  let models: Models;
  const localProviders = new Map<string, LocalProviderRegistration>();
  if (injectedModels !== undefined) {
    models = injectedModels;
  } else {
    const catalogStore = new InMemoryModelsStore();
    const localProviderIds = new Set(config.localProviders.map((provider) => provider.id));
    const mutableModels = builtinModels({
      credentials: withoutLocalCredentials(credentials, localProviderIds),
      modelsStore: catalogStore,
      authContext: {
        async env() { return undefined; },
        async fileExists() { return false; },
      },
    });
    for (const providerConfig of config.localProviders) {
      localProviders.set(providerConfig.id, addLocalProvider(mutableModels, catalogStore, providerConfig));
    }
    models = mutableModels;
  }
  const configuredSecrets: string[] = [];
  const resolve = async (reference: string, signal?: AbortSignal): Promise<Model<string>> => {
    const { provider, model } = parsePiModelReference(reference);
    let resolved = models.getModel(provider, model);
    const local = localProviders.get(provider);
    if (resolved === undefined && local?.provider.refreshModels !== undefined) {
      await local.provider.refreshModels({
        store: local.store,
        allowNetwork: true,
        force: true,
        ...(signal === undefined ? {} : { signal }),
      });
      resolved = models.getModel(provider, model);
    }
    if (resolved === undefined) {
      throw new TypeError(`runtime-pi model not found: ${provider}:${model}`);
    }
    return resolved as Model<string>;
  };
  return {
    models,
    configuredSecrets,
    resolve,
    async capabilities(reference, signal) {
      const model = await resolve(reference, signal);
      return {
        tools: true,
        attachments: model.input.includes("image"),
        structuredOutput: false,
        approvals: false,
        sandbox: false,
        thinkingLevels: getSupportedThinkingLevels(model),
      };
    },
  };
}

/** Local embedding services supported by the guided managed-memory setup. */
export type ManagedMemoryEmbeddingProvider = "ollama" | "lmstudio";

/** Stable service roots used by guided setup and by non-interactive defaults. */
export const DEFAULT_MEMORY_EMBEDDING_ENDPOINTS: Readonly<Record<ManagedMemoryEmbeddingProvider, string>> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
};

const EMBEDDING_PROBE_TEXT = "mono-agent managed-memory embedding readiness probe";
const OLLAMA_DISCOVERY_CONCURRENCY = 6;

export interface DiscoverMemoryEmbeddingModelsOptions {
  readonly provider: ManagedMemoryEmbeddingProvider;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ProbeMemoryEmbeddingSelectionOptions extends DiscoverMemoryEmbeddingModelsOptions {
  readonly model: string;
  /** When supplied, fail if the service returns a vector with another dimension. */
  readonly expectedDimension?: number;
}

export interface MemoryEmbeddingProbeResult {
  readonly dimension: number;
}

/** Validate a provider service root before appending native API routes. */
export function memoryEmbeddingEndpointProblem(value: string | undefined): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value?.trim() ?? "");
  } catch {
    return "Enter an absolute HTTP(S) service root.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Enter an absolute HTTP(S) service root.";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "Do not include credentials in the embedding service root; use apiKeyEnv.";
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return "Do not include a query or fragment in the embedding service root.";
  }
  return undefined;
}

/**
 * Discover only models whose service-native metadata explicitly marks them as
 * embedding-capable. Runtime chat-model catalogs are deliberately not reused.
 */
export async function discoverMemoryEmbeddingModels(
  options: DiscoverMemoryEmbeddingModelsOptions,
): Promise<readonly string[]> {
  const endpoint = normalizeEndpoint(options.endpoint, options.provider);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  if (options.provider === "lmstudio") {
    const payload = await requestJson(fetchImpl, `${endpoint}/api/v1/models`, {
      method: "GET",
      headers: authorizationHeaders(options.apiKey),
      redirect: "error",
      signal,
    }, "LM Studio embedding model discovery");
    const models = objectArrayProperty(payload, "models");
    return stableUnique(models.flatMap((entry) =>
      entry.type === "embedding" && typeof entry.key === "string" && entry.key.trim().length > 0
        ? [entry.key.trim()]
        : []
    ));
  }

  const payload = await requestJson(fetchImpl, `${endpoint}/api/tags`, {
    method: "GET",
    headers: authorizationHeaders(options.apiKey),
    redirect: "error",
    signal,
  }, "Ollama embedding model discovery");
  const taggedModels = objectArrayProperty(payload, "models");
  const taggedModelNames = taggedModels.flatMap((entry) => {
    const model = stringProperty(entry, "name") ?? stringProperty(entry, "model");
    return model === undefined ? [] : [model];
  });
  const capabilities = await mapBounded(taggedModelNames, OLLAMA_DISCOVERY_CONCURRENCY, async (model) => {
    try {
      const details = await requestJson(fetchImpl, `${endpoint}/api/show`, {
        method: "POST",
        headers: jsonHeaders(options.apiKey),
        body: JSON.stringify({ model }),
        redirect: "error",
        signal,
      }, `Ollama capability discovery for ${model}`);
      return unknownArrayProperty(details, "capabilities").includes("embedding") ? model : undefined;
    } catch {
      // One stale/broken catalog entry must not hide healthy embedding models.
      // The manual path and exact-model readiness probe remain available when
      // individual capability inspection fails or the overall deadline expires.
      return undefined;
    }
  });
  return stableUnique(capabilities.filter((model): model is string => model !== undefined));
}

/**
 * Prove one selected model through the service's real embedding endpoint and
 * return the actual vector dimension. Empty, non-numeric, non-finite, and
 * dimension-mismatched responses fail closed.
 */
export async function probeMemoryEmbeddingSelection(
  options: ProbeMemoryEmbeddingSelectionOptions,
): Promise<MemoryEmbeddingProbeResult> {
  const model = options.model.trim();
  if (model.length === 0) throw new Error("An embedding model is required.");
  if (
    options.expectedDimension !== undefined
    && (!Number.isSafeInteger(options.expectedDimension) || options.expectedDimension <= 0)
  ) {
    throw new Error("The expected embedding dimension must be a positive integer.");
  }

  const endpoint = normalizeEndpoint(options.endpoint, options.provider);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  const payload = options.provider === "ollama"
    ? await requestJson(fetchImpl, `${endpoint}/api/embed`, {
        method: "POST",
        headers: jsonHeaders(options.apiKey),
        body: JSON.stringify({ model, input: EMBEDDING_PROBE_TEXT }),
        redirect: "error",
        signal,
      }, `Ollama embedding probe for ${model}`)
    : await requestJson(fetchImpl, `${endpoint}/v1/embeddings`, {
        method: "POST",
        headers: jsonHeaders(options.apiKey),
        body: JSON.stringify({ model, input: EMBEDDING_PROBE_TEXT }),
        redirect: "error",
        signal,
      }, `LM Studio embedding probe for ${model}`);

  const vector = options.provider === "ollama"
    ? firstNestedNumberArray(payload, "embeddings")
    : firstOpenAiEmbedding(payload);
  if (vector === undefined || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`${serviceLabel(options.provider)} returned an invalid embedding vector for ${model}.`);
  }
  const dimension = vector.length;
  if (options.expectedDimension !== undefined && options.expectedDimension !== dimension) {
    throw new Error(
      `${serviceLabel(options.provider)} returned dimension ${dimension} for ${model}; configured dimension is ${options.expectedDimension}.`,
    );
  }
  return { dimension };
}

function normalizeEndpoint(endpoint: string | undefined, provider: ManagedMemoryEmbeddingProvider): string {
  const value = (endpoint ?? DEFAULT_MEMORY_EMBEDDING_ENDPOINTS[provider]).trim().replace(/\/+$/u, "");
  const problem = memoryEmbeddingEndpointProblem(value);
  if (problem !== undefined) {
    throw new Error(`${serviceLabel(provider)} endpoint is invalid: ${problem}`);
  }
  return value;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const detail = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "timed out"
      : "could not connect";
    throw new Error(`${operation} ${detail}.`);
  }
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON.`);
  }
}

function authorizationHeaders(apiKey: string | undefined): Record<string, string> {
  const key = apiKey?.trim();
  return key === undefined || key.length === 0 ? {} : { Authorization: `Bearer ${key}` };
}

function jsonHeaders(apiKey: string | undefined): Record<string, string> {
  return { "Content-Type": "application/json", ...authorizationHeaders(apiKey) };
}

function objectArrayProperty(value: unknown, key: string): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return [];
  const nested = (value as Record<string, unknown>)[key];
  return Array.isArray(nested)
    ? nested.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
}

function unknownArrayProperty(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const nested = (value as Record<string, unknown>)[key];
  return Array.isArray(nested) ? nested : [];
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const nested = value[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested.trim() : undefined;
}

function firstNestedNumberArray(value: unknown, key: string): number[] | undefined {
  const rows = unknownArrayProperty(value, key);
  const first = rows[0];
  return Array.isArray(first) && first.every((entry) => typeof entry === "number") ? first : undefined;
}

function firstOpenAiEmbedding(value: unknown): number[] | undefined {
  const first = objectArrayProperty(value, "data")[0];
  const embedding = first?.embedding;
  return Array.isArray(embedding) && embedding.every((entry) => typeof entry === "number")
    ? embedding
    : undefined;
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => await worker(),
  ));
  return results;
}

function serviceLabel(provider: ManagedMemoryEmbeddingProvider): string {
  return provider === "ollama" ? "Ollama" : "LM Studio";
}

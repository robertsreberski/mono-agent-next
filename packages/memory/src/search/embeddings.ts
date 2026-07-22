import type { EmbeddingProvider, EmbeddingProviderConfig, MemorySearchErrorCode } from "./types.js";

export class MemorySearchError extends Error {
  readonly code: MemorySearchErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: MemorySearchErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "MemorySearchError";
    this.code = code;
    this.details = { ...details, code };
  }
}

type FetchLike = typeof fetch;

const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
const DEFAULT_LMSTUDIO_ENDPOINT = "http://localhost:1234";
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_EMBEDDING_NETWORK_CAUSE_CANDIDATES = 64;
const EMBEDDING_NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface OllamaEmbeddingOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** Local embeddings via Ollama's `/api/embed` endpoint (e.g. nomic-embed-text). */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OllamaEmbeddingOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "Ollama embedding model is required.");
    }
    this.model = options.model;
    this.endpoint = normalizeServiceRoot(options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT, "Ollama");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `ollama:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const body = JSON.stringify({ model: this.model, input: [...texts] });
    let response: Response;
    try {
      response = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(`${this.endpoint}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
        }),
      );
    } catch (cause) {
      throw normalizeEmbeddingRequestFailure("Ollama", cause);
    }
    if (!response.ok) {
      throw new MemorySearchError("embedding_request_failed", `Ollama embeddings request failed (${response.status}).`, {
        status: response.status,
        endpoint: this.endpoint,
      });
    }
    const json = await readEmbeddingResponseJson(response, "Ollama");
    const embeddings = typeof json === "object" && json !== null
      ? (json as Record<string, unknown>).embeddings
      : undefined;
    return validateEmbeddings(embeddings, texts.length);
  }
}

export interface OpenAIEmbeddingOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

export interface LmStudioEmbeddingOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** Local embeddings via LM Studio's OpenAI-compatible `/v1/embeddings` endpoint. */
export class LmStudioEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: LmStudioEmbeddingOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "LM Studio embedding model is required.");
    }
    this.model = options.model;
    this.apiKey = typeof options.apiKey === "string" && options.apiKey.trim().length > 0
      ? options.apiKey
      : undefined;
    this.endpoint = normalizeServiceRoot(options.endpoint ?? DEFAULT_LMSTUDIO_ENDPOINT, "LM Studio");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `lmstudio:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    let response: Response;
    try {
      response = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(`${this.endpoint}/v1/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: this.model, input: [...texts] }),
          redirect: "error",
          signal,
        }),
      );
    } catch (cause) {
      throw normalizeEmbeddingRequestFailure("LM Studio", cause);
    }
    if (!response.ok) {
      throw new MemorySearchError("embedding_request_failed", `LM Studio embeddings request failed (${response.status}).`, {
        status: response.status,
        endpoint: this.endpoint,
      });
    }
    return readOpenAICompatibleEmbeddings(response, texts.length, "LM Studio");
  }
}

/** Remote embeddings via the OpenAI-compatible `/embeddings` endpoint. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAIEmbeddingOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "OpenAI embedding model is required.");
    }
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new MemorySearchError("invalid_embedding_options", "OpenAI embeddings require an API key.");
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.endpoint = normalizeServiceRoot(options.endpoint ?? DEFAULT_OPENAI_ENDPOINT, "OpenAI");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `openai:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    let response: Response;
    try {
      response = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(`${this.endpoint}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, input: [...texts] }),
          signal,
        }),
      );
    } catch (cause) {
      throw normalizeEmbeddingRequestFailure("OpenAI", cause);
    }
    if (!response.ok) {
      throw new MemorySearchError("embedding_request_failed", `OpenAI embeddings request failed (${response.status}).`, {
        status: response.status,
      });
    }
    return readOpenAICompatibleEmbeddings(response, texts.length, "OpenAI");
  }
}

export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  fetchImpl?: FetchLike,
): EmbeddingProvider {
  if (config.provider === "ollama") {
    return new OllamaEmbeddingProvider({
      model: config.model,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  if (config.provider === "openai") {
    if (config.apiKey === undefined) {
      throw new MemorySearchError("invalid_embedding_options", "OpenAI embeddings require an API key.");
    }
    return new OpenAIEmbeddingProvider({
      model: config.model,
      apiKey: config.apiKey,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  if (config.provider === "lmstudio") {
    return new LmStudioEmbeddingProvider({
      model: config.model,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  throw new MemorySearchError("invalid_embedding_options", `Unknown embedding provider "${String(config.provider)}".`);
}

async function readEmbeddingResponseJson(response: Response, provider: string): Promise<unknown> {
  // Keep body transport/state failures honest. Only JSON.parse below can create
  // the SyntaxError that this boundary translates into a provider response error.
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) {
      throw cause;
    }
    throw new MemorySearchError(
      "embedding_response_invalid",
      `${provider} embedding response was not valid JSON.`,
      { provider },
      { cause },
    );
  }
}

async function readOpenAICompatibleEmbeddings(
  response: Response,
  expected: number,
  provider: string,
): Promise<number[][]> {
  const json = await readEmbeddingResponseJson(response, provider);
  const data = typeof json === "object" && json !== null
    ? (json as Record<string, unknown>).data
    : undefined;
  const embeddings = Array.isArray(data)
    ? data.map((entry) => (
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>).embedding
          : undefined
      ))
    : undefined;
  return validateEmbeddings(embeddings, expected);
}

function validateEmbeddings(value: unknown, expected: number): number[][] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new MemorySearchError("embedding_response_invalid", "Embedding response shape was unexpected.", {
      expected,
      received: Array.isArray(value) ? value.length : typeof value,
    });
  }
  return value.map((vector) => {
    if (
      !Array.isArray(vector)
      || vector.length === 0
      || vector.some((component) => typeof component !== "number" || !Number.isFinite(component))
    ) {
      throw new MemorySearchError(
        "embedding_response_invalid",
        "Embedding vector was not a non-empty array of finite numbers.",
      );
    }
    return vector as number[];
  });
}

function normalizeServiceRoot(value: string, label: string): string {
  const normalized = value.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new MemorySearchError("invalid_embedding_options", `${label} endpoint must be an absolute HTTP(S) service root.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MemorySearchError("invalid_embedding_options", `${label} endpoint must be an absolute HTTP(S) service root.`);
  }
  if (
    parsed.username.length > 0
    || parsed.password.length > 0
    || normalized.includes("?")
    || normalized.includes("#")
  ) {
    throw new MemorySearchError(
      "invalid_embedding_options",
      `${label} endpoint service root must not include credentials, a query, or a fragment.`,
    );
  }
  return normalized;
}

function normalizeEmbeddingRequestFailure(provider: string, cause: unknown): unknown {
  if (!isStructuredNetworkTypeError(cause) && !(cause instanceof Error && cause.name === "AbortError")) {
    return cause;
  }
  return new MemorySearchError(
    "embedding_request_failed",
    `${provider} embeddings request failed before receiving a response.`,
    {},
    { cause },
  );
}

function isStructuredNetworkTypeError(value: unknown): value is TypeError {
  if (!(value instanceof TypeError)) {
    return false;
  }

  const pending: Error[] = [];
  const seen = new Set<Error>();
  let candidateCount = 0;

  const enqueue = (candidate: unknown): void => {
    if (candidateCount >= MAX_EMBEDDING_NETWORK_CAUSE_CANDIDATES) {
      return;
    }
    candidateCount += 1;
    let isError = false;
    try {
      isError = candidate instanceof Error;
    } catch {
      return;
    }
    if (!isError || seen.has(candidate as Error)) {
      return;
    }
    seen.add(candidate as Error);
    pending.push(candidate as Error);
  };

  const readProperty = (target: object, key: PropertyKey): unknown => {
    try {
      return Reflect.get(target, key);
    } catch {
      return undefined;
    }
  };

  const enqueueChildren = (current: Error): void => {
    enqueue(readProperty(current, "cause"));
    let isAggregate = false;
    try {
      isAggregate = current instanceof AggregateError;
    } catch {
      return;
    }
    if (!isAggregate) {
      return;
    }
    const errors = readProperty(current, "errors");
    let errorEntries: unknown[];
    try {
      if (!Array.isArray(errors)) {
        return;
      }
      errorEntries = errors;
    } catch {
      return;
    }
    const length = readProperty(errorEntries, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      return;
    }
    const readable = Math.min(length, MAX_EMBEDDING_NETWORK_CAUSE_CANDIDATES - candidateCount);
    for (let index = 0; index < readable; index += 1) {
      enqueue(readProperty(errorEntries, String(index)));
    }
  };

  enqueue(readProperty(value, "cause"));
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) {
      continue;
    }
    const code = readProperty(current, "code");
    if (typeof code === "string" && EMBEDDING_NETWORK_ERROR_CODES.has(code.toUpperCase())) {
      return true;
    }
    enqueueChildren(current);
  }
  return false;
}

async function withTimeout(timeoutMs: number, run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

import { describe, expect, it } from "vitest";

import {
  createEmbeddingProvider,
  LmStudioEmbeddingProvider,
  MemorySearchError,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "../index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type ProviderFactory = (fetchImpl: typeof fetch, timeoutMs?: number) => {
  embed(texts: readonly string[]): Promise<number[][]>;
};

const providerFactories = [
  ["Ollama", (fetchImpl: typeof fetch, timeoutMs?: number) => new OllamaEmbeddingProvider({
    model: "test-model",
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })],
  ["LM Studio", (fetchImpl: typeof fetch, timeoutMs?: number) => new LmStudioEmbeddingProvider({
    model: "test-model",
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })],
  ["OpenAI", (fetchImpl: typeof fetch, timeoutMs?: number) => new OpenAIEmbeddingProvider({
    model: "test-model",
    apiKey: "test-key",
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })],
] as const satisfies readonly (readonly [string, ProviderFactory])[];

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("embedding provider failure taxonomy", () => {
  it.each(providerFactories)("wraps malformed successful %s JSON as an invalid response with its cause", async (_label, createProvider) => {
    const fetchImpl = (async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({ code: "embedding_response_invalid" });
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it.each(providerFactories)("preserves non-parser %s body-read failures by identity", async (_label, createProvider) => {
    const bodyReadFailure = new Error("response adapter invariant failed");
    const fetchImpl = (async () => ({
      ok: true,
      text: async () => {
        throw bodyReadFailure;
      },
    }) as unknown as Response) as typeof fetch;

    expect(await rejectionOf(createProvider(fetchImpl).embed(["text"]))).toBe(bodyReadFailure);
  });

  it.each(providerFactories)("propagates a native disturbed %s response as a hard TypeError", async (_label, createProvider) => {
    const response = jsonResponse({ embeddings: [[1]], data: [{ embedding: [1] }] });
    await response.text();
    const fetchImpl = (async () => response) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(MemorySearchError);
  });

  it.each(providerFactories)("keeps non-OK %s responses in the request-failed category", async (_label, createProvider) => {
    const fetchImpl = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({ code: "embedding_request_failed" });
  });

  it.each(providerFactories)("wraps request-boundary %s TypeErrors with a stable code and original cause", async (provider, createProvider) => {
    const connectionCause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const networkFailure = Object.assign(new TypeError("fetch failed"), { cause: connectionCause });
    const fetchImpl = (async () => {
      throw networkFailure;
    }) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({
      code: "embedding_request_failed",
      details: { code: "embedding_request_failed" },
      message: `${provider} embeddings request failed before receiving a response.`,
    });
    expect((error as Error).cause).toBe(networkFailure);
  });

  it.each(providerFactories)("preserves unstructured %s TypeErrors by identity", async (_provider, createProvider) => {
    const programmingFailure = new TypeError("Cannot read properties of undefined (reading 'ECONNREFUSED')");
    const fetchImpl = (async () => {
      throw programmingFailure;
    }) as typeof fetch;

    expect(await rejectionOf(createProvider(fetchImpl).embed(["text"]))).toBe(programmingFailure);
  });

  it.each(providerFactories)("preserves unknown-code %s TypeErrors by identity", async (_provider, createProvider) => {
    const unknownCause = Object.assign(new Error("adapter failure"), { code: "EADAPTERBUG" });
    const programmingFailure = new TypeError("fetch adapter bug", { cause: unknownCause });
    const fetchImpl = (async () => {
      throw programmingFailure;
    }) as typeof fetch;

    expect(await rejectionOf(createProvider(fetchImpl).embed(["text"]))).toBe(programmingFailure);
  });

  it.each(providerFactories)("wraps nested aggregate %s network failures", async (_provider, createProvider) => {
    const dnsFailure = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const aggregateFailure = new AggregateError([new Error("other address failed"), dnsFailure]);
    const networkFailure = new TypeError("fetch failed", { cause: aggregateFailure });
    const fetchImpl = (async () => {
      throw networkFailure;
    }) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({ code: "embedding_request_failed" });
    expect((error as Error).cause).toBe(networkFailure);
  });

  it.each(providerFactories)("bounds cyclic %s cause graphs and preserves identity", async (_provider, createProvider) => {
    const cycle = new AggregateError([]);
    Object.defineProperty(cycle, "errors", { value: [cycle] });
    const programmingFailure = new TypeError("fetch adapter bug", { cause: cycle });
    const fetchImpl = (async () => {
      throw programmingFailure;
    }) as typeof fetch;

    expect(await rejectionOf(createProvider(fetchImpl).embed(["text"]))).toBe(programmingFailure);
  });

  it.each(providerFactories)("wraps %s abort failures with a stable code and original cause", async (provider, createProvider) => {
    const abortFailure = new DOMException("request aborted", "AbortError");
    const fetchImpl = (async () => {
      throw abortFailure;
    }) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl).embed(["text"]));

    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({
      code: "embedding_request_failed",
      details: { code: "embedding_request_failed" },
      message: `${provider} embeddings request failed before receiving a response.`,
    });
    expect((error as Error).cause).toBe(abortFailure);
  });

  it.each(providerFactories)("wraps timer-driven %s timeouts with the abort signal's reason", async (provider, createProvider) => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        reject(new Error("embedding request did not receive an AbortSignal"));
        return;
      }
      observedSignal = signal;
      const rejectWithAbortReason = (): void => reject(signal.reason);
      if (signal.aborted) {
        rejectWithAbortReason();
        return;
      }
      signal.addEventListener("abort", rejectWithAbortReason, { once: true });
    })) as typeof fetch;

    const error = await rejectionOf(createProvider(fetchImpl, 5).embed(["text"]));
    const signal = observedSignal as AbortSignal | undefined;

    expect(signal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({
      code: "embedding_request_failed",
      details: { code: "embedding_request_failed" },
      message: `${provider} embeddings request failed before receiving a response.`,
    });
    expect((error as Error).cause).toBe(signal?.reason);
    expect((error as Error).cause).toBeInstanceOf(DOMException);
    expect(((error as Error).cause as DOMException).name).toBe("AbortError");
  });

  it.each(providerFactories)("preserves non-TypeError %s fetch failures by identity", async (_provider, createProvider) => {
    const adapterFailure = new Error("custom fetch adapter invariant failed");
    const fetchImpl = (async () => {
      throw adapterFailure;
    }) as typeof fetch;

    expect(await rejectionOf(createProvider(fetchImpl).embed(["text"]))).toBe(adapterFailure);
  });
});

function expectInvalidEmbeddingOptions(create: () => unknown): void {
  try {
    create();
  } catch (error) {
    expect(error).toBeInstanceOf(MemorySearchError);
    expect(error).toMatchObject({ code: "invalid_embedding_options" });
    return;
  }
  throw new Error("Expected invalid_embedding_options.");
}

describe("OllamaEmbeddingProvider", () => {
  it("posts to /api/embed and returns the embedding vectors", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ embeddings: [[1, 0, 0], [0, 1, 0]] });
    }) as typeof fetch;

    const provider = new OllamaEmbeddingProvider({ model: "nomic-embed-text", fetchImpl });
    const vectors = await provider.embed(["a", "b"]);

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/embed");
    expect(calls[0]?.body).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
    expect(provider.id).toBe("ollama:nomic-embed-text");
  });

  it("throws on non-OK responses", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
  });

  it("throws when the response shape is wrong", async () => {
    const fetchImpl = (async () => jsonResponse({ embeddings: [[1, 2]] })) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });
    await expect(provider.embed(["x", "y"])).rejects.toThrow(/unexpected/u);
  });

  it("short-circuits empty input without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({ embeddings: [] });
    }) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });
    expect(await provider.embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("preserves a configured service-root path while trimming whitespace and trailing slashes", async () => {
    let calledUrl: string | undefined;
    const fetchImpl = (async (url: string | URL) => {
      calledUrl = String(url);
      return jsonResponse({ embeddings: [[1]] });
    }) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({
      model: "m",
      endpoint: "  https://embeddings.example.test/ollama-root///  ",
      fetchImpl,
    });

    await provider.embed(["x"]);

    expect(calledUrl).toBe("https://embeddings.example.test/ollama-root/api/embed");
  });

  it.each([
    "/ollama-root",
    "file:///tmp/ollama.sock",
    "http://user:pass@localhost:11434",
    "http://localhost:11434?route=elsewhere",
    "http://localhost:11434?",
    "http://localhost:11434#fragment",
    "http://localhost:11434#",
  ])("rejects invalid service root %s with the stable options code", (endpoint) => {
    expectInvalidEmbeddingOptions(() => new OllamaEmbeddingProvider({ model: "m", endpoint }));
  });

  it.each([
    ["an empty vector", [[]]],
    ["a NaN component", [[Number.NaN]]],
    ["an infinite component", [[Number.POSITIVE_INFINITY]]],
  ])("rejects %s from the shared response validator", async (_name, embeddings) => {
    const fetchImpl = (async () => jsonResponse({ embeddings })) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: "m", fetchImpl });

    await expect(provider.embed(["x"])).rejects.toThrow(/non-empty array of finite numbers/u);
  });
});

describe("LmStudioEmbeddingProvider", () => {
  it("posts to the default service root without an authorization header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] });
    }) as typeof fetch;

    const provider = new LmStudioEmbeddingProvider({ model: "nomic-embed", fetchImpl });
    await expect(provider.embed(["a", "b"])).resolves.toEqual([[1, 0], [0, 1]]);

    expect(provider.id).toBe("lmstudio:nomic-embed");
    expect(calls[0]?.url).toBe("http://localhost:1234/v1/embeddings");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: "nomic-embed", input: ["a", "b"] });
  });

  it("treats a configured endpoint as a service root and sends a resolved key", async () => {
    const calls: Array<{ url: string; headers: RequestInit["headers"] }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers });
      return jsonResponse({ data: [{ embedding: [1] }] });
    }) as typeof fetch;

    const provider = new LmStudioEmbeddingProvider({
      model: "embed-model",
      endpoint: "http://127.0.0.1:1234/",
      apiKey: "resolved-token",
      fetchImpl,
    });
    await provider.embed(["a"]);

    expect(calls).toEqual([{
      url: "http://127.0.0.1:1234/v1/embeddings",
      headers: { "content-type": "application/json", authorization: "Bearer resolved-token" },
    }]);
  });

  it("does not authenticate with a blank unresolved key", async () => {
    let headers: RequestInit["headers"];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headers = init?.headers;
      return jsonResponse({ data: [{ embedding: [1] }] });
    }) as typeof fetch;
    const provider = new LmStudioEmbeddingProvider({ model: "embed-model", apiKey: "   ", fetchImpl });

    await provider.embed(["a"]);

    expect(headers).toEqual({ "content-type": "application/json" });
  });

  it.each([
    "file:///tmp/lmstudio.sock",
    "http://user:pass@localhost:1234",
    "http://localhost:1234?route=elsewhere",
    "http://localhost:1234?",
    "http://localhost:1234#fragment",
    "http://localhost:1234#",
  ])("rejects invalid service root %s", (endpoint) => {
    expectInvalidEmbeddingOptions(() => new LmStudioEmbeddingProvider({ model: "embed-model", endpoint }));
  });

  it("uses the shared OpenAI-compatible response validator", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [{ embedding: [] }] })) as typeof fetch;
    const provider = new LmStudioEmbeddingProvider({ model: "embed-model", fetchImpl });

    await expect(provider.embed(["a"])).rejects.toThrow(/non-empty array of finite numbers/u);
  });
});

describe("OpenAIEmbeddingProvider", () => {
  it("keeps the OpenAI endpoint, authorization, identity, and response contract", async () => {
    const calls: Array<{ url: string; headers: RequestInit["headers"] }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers });
      return jsonResponse({ data: [{ embedding: [1, 2] }] });
    }) as typeof fetch;
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      apiKey: "openai-key",
      fetchImpl,
    });

    await expect(provider.embed(["a"])).resolves.toEqual([[1, 2]]);
    expect(provider.id).toBe("openai:text-embedding-3-small");
    expect(calls).toEqual([{
      url: "https://api.openai.com/v1/embeddings",
      headers: { "content-type": "application/json", authorization: "Bearer openai-key" },
    }]);
  });

  it("preserves a configured service-root path while trimming whitespace and trailing slashes", async () => {
    let calledUrl: string | undefined;
    const fetchImpl = (async (url: string | URL) => {
      calledUrl = String(url);
      return jsonResponse({ data: [{ embedding: [1] }] });
    }) as typeof fetch;
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      apiKey: "openai-key",
      endpoint: "  https://gateway.example.test/openai/v1///  ",
      fetchImpl,
    });

    await provider.embed(["x"]);

    expect(calledUrl).toBe("https://gateway.example.test/openai/v1/embeddings");
  });

  it.each([
    "/v1",
    "file:///tmp/openai.sock",
    "https://user:pass@gateway.example.test/v1",
    "https://gateway.example.test/v1?tenant=elsewhere",
    "https://gateway.example.test/v1?",
    "https://gateway.example.test/v1#fragment",
    "https://gateway.example.test/v1#",
  ])("rejects invalid service root %s with the stable options code", (endpoint) => {
    expectInvalidEmbeddingOptions(() => new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      apiKey: "openai-key",
      endpoint,
    }));
  });
});

describe("createEmbeddingProvider", () => {
  it("builds an Ollama provider", () => {
    const provider = createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text" });
    expect(provider.id).toBe("ollama:nomic-embed-text");
  });

  it("requires an API key for OpenAI", () => {
    expect(() => createEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small" })).toThrow(/API key/u);
  });

  it("builds an LM Studio provider without requiring an API key", () => {
    const provider = createEmbeddingProvider({ provider: "lmstudio", model: "nomic-embed" });
    expect(provider.id).toBe("lmstudio:nomic-embed");
  });
});

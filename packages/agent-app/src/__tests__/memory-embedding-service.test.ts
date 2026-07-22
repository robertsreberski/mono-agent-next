import { describe, expect, it, vi } from "vitest";

import {
  discoverMemoryEmbeddingModels,
  probeMemoryEmbeddingSelection,
} from "../memory-embedding-service.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("managed-memory embedding service", () => {
  it("discovers only Ollama models whose /api/show capabilities include embedding", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({
          models: [
            { name: "nomic-embed-text:v1.5" },
            { model: "llama3.1:8b" },
            { name: "all-minilm:latest" },
          ],
        });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      return jsonResponse({
        capabilities: body.model === "llama3.1:8b" ? ["completion"] : ["embedding"],
      });
    });

    await expect(discoverMemoryEmbeddingModels({
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434/",
      fetchImpl,
    })).resolves.toEqual(["nomic-embed-text:v1.5", "all-minilm:latest"]);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const showBodies = fetchImpl.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)));
    expect(showBodies).toEqual(expect.arrayContaining([
      { model: "nomic-embed-text:v1.5" },
      { model: "llama3.1:8b" },
      { model: "all-minilm:latest" },
    ]));
  });

  it("keeps healthy Ollama models when an unrelated catalog entry fails capability inspection", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "stale-model" }, { name: "embed-model" }] });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      return body.model === "stale-model"
        ? jsonResponse({ error: "broken" }, 500)
        : jsonResponse({ capabilities: ["embedding"] });
    });

    await expect(discoverMemoryEmbeddingModels({
      provider: "ollama",
      fetchImpl,
    })).resolves.toEqual(["embed-model"]);
  });

  it("uses LM Studio's typed native model catalog and exact model keys", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      models: [
        { key: "text-embedding-nomic-embed-text-v1.5", type: "embedding" },
        { key: "qwen3-8b", type: "llm" },
        { key: "unknown", type: "Embedding" },
      ],
    }));

    await expect(discoverMemoryEmbeddingModels({
      provider: "lmstudio",
      apiKey: "test-token",
      fetchImpl,
    })).resolves.toEqual(["text-embedding-nomic-embed-text-v1.5"]);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:1234/api/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer test-token" },
      }),
    );
  });

  it("probes Ollama with a fixed nonsensitive input and returns the actual dimension", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ embeddings: [[0.1, -0.2, 0.3]] }));

    await expect(probeMemoryEmbeddingSelection({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      fetchImpl,
    })).resolves.toEqual({ dimension: 3 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "nomic-embed-text:v1.5" });
    expect(body.input).toBe("mono-agent managed-memory embedding readiness probe");
  });

  it("probes LM Studio's /v1/embeddings endpoint without inventing auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      data: [{ embedding: [0.25, 0.5] }],
    }));

    await expect(probeMemoryEmbeddingSelection({
      provider: "lmstudio",
      endpoint: "http://127.0.0.1:1234/",
      model: "nomic-embed-text",
      expectedDimension: 2,
      fetchImpl,
    })).resolves.toEqual({ dimension: 2 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/embeddings",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("rejects empty, non-finite, and dimension-mismatched vectors", async () => {
    const emptyFetch = vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ embedding: [] }] }));
    await expect(probeMemoryEmbeddingSelection({
      provider: "lmstudio",
      model: "embed",
      fetchImpl: emptyFetch,
    })).rejects.toThrow(/invalid embedding vector/u);

    const nonFiniteFetch = vi.fn<typeof fetch>(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[0.1, Number.NaN]] }),
    } as Response));
    await expect(probeMemoryEmbeddingSelection({
      provider: "ollama",
      model: "embed",
      fetchImpl: nonFiniteFetch,
    })).rejects.toThrow(/invalid embedding vector/u);

    const mismatchFetch = vi.fn<typeof fetch>(async () => jsonResponse({ embeddings: [[0.1, 0.2]] }));
    await expect(probeMemoryEmbeddingSelection({
      provider: "ollama",
      model: "embed",
      expectedDimension: 3,
      fetchImpl: mismatchFetch,
    })).rejects.toThrow(/returned dimension 2.*configured dimension is 3/u);
  });

  it("fails closed on untyped discovery responses and invalid endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ id: "looks-like-embed" }] }));
    await expect(discoverMemoryEmbeddingModels({
      provider: "lmstudio",
      fetchImpl,
    })).resolves.toEqual([]);
    await expect(discoverMemoryEmbeddingModels({
      provider: "ollama",
      endpoint: "file:///tmp/ollama.sock",
      fetchImpl,
    })).rejects.toThrow(/absolute HTTP\(S\) service root/u);
  });

  it.each([
    "http://user:pass@localhost:1234",
    "http://localhost:1234?route=elsewhere",
    "http://localhost:1234#fragment",
  ])("rejects unsafe or ambiguous service root %s", async (endpoint) => {
    await expect(discoverMemoryEmbeddingModels({
      provider: "lmstudio",
      endpoint,
      fetchImpl: vi.fn(),
    })).rejects.toThrow(/endpoint is invalid/u);
  });
});

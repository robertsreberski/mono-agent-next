import { describe, expect, it } from "vitest";

import { createSupermemoryHttpClient } from "../client.js";
import type { SupermemoryFetch } from "../client.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recordingFetch(handler: (call: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl: SupermemoryFetch = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const { status, json } = handler(call);
    return { status, json: async () => json };
  };
  return { calls, fetchImpl };
}

const BASE = "http://127.0.0.1:6767";

describe("createSupermemoryHttpClient.add", () => {
  it("POSTs /v3/documents with the container tag and content", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ status: 200, json: { id: "d1", status: "queued" } }));
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "agent-x", fetch: fetchImpl });

    await client.add({ content: "hello", customId: "c1", metadata: { kind: "host-summary" } });

    expect(calls[0]?.url).toBe(`${BASE}/v3/documents`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      content: "hello",
      containerTag: "agent-x",
      customId: "c1",
      metadata: { kind: "host-summary" },
    });
  });

  it("sends a Bearer header only when an api key is configured", async () => {
    const withKey = recordingFetch(() => ({ status: 200 }));
    await createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", apiKey: "sm_secret", fetch: withKey.fetchImpl }).add({ content: "a" });
    expect(withKey.calls[0]?.headers.authorization).toBe("Bearer sm_secret");

    const noKey = recordingFetch(() => ({ status: 200 }));
    await createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", fetch: noKey.fetchImpl }).add({ content: "a" });
    expect(noKey.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("throws on a non-2xx add", async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 500 }));
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", fetch: fetchImpl });
    await expect(client.add({ content: "a" })).rejects.toThrow(/HTTP 500/u);
  });
});

describe("createSupermemoryHttpClient.search", () => {
  it("POSTs /v4/search and normalizes memory + similarity into hits", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      status: 200,
      json: {
        results: [
          { id: "a", memory: "extracted fact", similarity: 0.88 },
          { id: "b", chunk: "doc snippet", similarity: 0.5 },
          { id: "c", memory: "   ", similarity: 0.9 },
        ],
        total: 3,
        timing: 12,
      },
    }));
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "agent-x", fetch: fetchImpl });

    const hits = await client.search({ query: "q", limit: 5 });

    expect(calls[0]?.url).toBe(`${BASE}/v4/search`);
    expect(calls[0]?.body).toMatchObject({ q: "q", containerTag: "agent-x", searchMode: "hybrid", limit: 5 });
    // No similarity floor by default (parity with bujo top-N recall).
    expect(calls[0]?.body.threshold).toBeUndefined();
    // Empty-text row dropped; memory preferred over chunk.
    expect(hits).toEqual([
      { id: "a", text: "extracted fact", score: 0.88 },
      { id: "b", text: "doc snippet", score: 0.5 },
    ]);
  });

  it("sends a similarity threshold only when explicitly configured", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ status: 200, json: { results: [] } }));
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", threshold: 0.4, fetch: fetchImpl });
    await client.search({ query: "q" });
    expect(calls[0]?.body.threshold).toBe(0.4);
  });

  it("stops probing /v4 after a 404 and routes subsequent searches straight to /v3", async () => {
    const { calls, fetchImpl } = recordingFetch((call) =>
      call.url.endsWith("/v4/search")
        ? { status: 404 }
        : { status: 200, json: { results: [{ id: "a", content: "legacy", score: 0.7 }] } },
    );
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", fetch: fetchImpl });

    await client.search({ query: "first" });
    await client.search({ query: "second" });

    // First search probes v4 (404) then v3; the second skips v4 entirely.
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v4/search`, `${BASE}/v3/search`, `${BASE}/v3/search`]);
  });

  it("falls back to /v3/search on a 404 and maps documentId + content + score", async () => {
    const { calls, fetchImpl } = recordingFetch((call) =>
      call.url.endsWith("/v4/search")
        ? { status: 404 }
        : // Legacy v3 identifies hits as documentId (not id).
          { status: 200, json: { results: [{ documentId: "doc-1", content: "legacy text", score: 0.7 }] } },
    );
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "agent-x", fetch: fetchImpl });

    const hits = await client.search({ query: "q" });

    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v4/search`, `${BASE}/v3/search`]);
    expect(calls[1]?.body).toMatchObject({ q: "q", containerTags: ["agent-x"] });
    expect(hits).toEqual([{ id: "doc-1", text: "legacy text", score: 0.7 }]);
  });

  it("reads v3 text from chunks[].content when top-level content is absent", async () => {
    const { fetchImpl } = recordingFetch((call) =>
      call.url.endsWith("/v4/search")
        ? { status: 404 }
        : { status: 200, json: { documents: [{ id: "a", score: 0.6, chunks: [{ content: "chunk text" }] }] } },
    );
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", fetch: fetchImpl });

    const hits = await client.search({ query: "q" });
    expect(hits).toEqual([{ id: "a", text: "chunk text", score: 0.6 }]);
  });

  it("throws on a non-2xx, non-404 search", async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 503 }));
    const client = createSupermemoryHttpClient({ baseUrl: BASE, containerTag: "x", fetch: fetchImpl });
    await expect(client.search({ query: "q" })).rejects.toThrow(/HTTP 503/u);
  });

  it("strips a trailing slash from the base URL", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ status: 200, json: { results: [] } }));
    const client = createSupermemoryHttpClient({ baseUrl: `${BASE}/`, containerTag: "x", fetch: fetchImpl });
    await client.search({ query: "q" });
    expect(calls[0]?.url).toBe(`${BASE}/v4/search`);
  });
});

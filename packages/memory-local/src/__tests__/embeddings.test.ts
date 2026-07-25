// SPDX-License-Identifier: MIT
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { parseMemoryLocalConfig } from "../config.js";
import { OllamaMemoryEmbeddingProvider } from "../embeddings.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("OllamaMemoryEmbeddingProvider", () => {
  it("posts the bounded model and input payload to the real Ollama HTTP path", async () => {
    let observed:
      | {
          readonly method: string | undefined;
          readonly url: string | undefined;
          readonly contentType: string | undefined;
          readonly body: unknown;
        }
      | undefined;
    const endpoint = await listen(async (request, response) => {
      observed = {
        method: request.method,
        url: request.url,
        contentType: request.headers["content-type"],
        body: JSON.parse(await readBody(request)) as unknown,
      };
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"embeddings":[[1,2],[3,4]]}');
    });
    const provider = new OllamaMemoryEmbeddingProvider(config(endpoint, 2));

    await expect(provider.embed(["first", "second"], new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(observed).toEqual({
      method: "POST",
      url: "/api/embed",
      contentType: "application/json",
      body: { model: "nomic-embed-text:v1.5", input: ["first", "second"] },
    });
  });

  it("rejects non-JSON and malformed bounded responses", async () => {
    for (const response of [
      { contentType: "text/plain", body: '{"embeddings":[[1,2]]}' },
      { contentType: "application/json", body: '{"embeddings":[[1,2]]}' },
      { contentType: "application/json", body: '{"embeddings":[[1]]}' },
      { contentType: "application/json", body: '{"embeddings":[[1e999,2]]}' },
    ]) {
      const endpoint = await listen((_request, outgoing) => {
        outgoing.writeHead(200, { "content-type": response.contentType });
        outgoing.end(response.body);
      });
      const provider = new OllamaMemoryEmbeddingProvider(config(endpoint, 2));
      const input = response.body === '{"embeddings":[[1,2]]}'
        && response.contentType === "application/json"
        ? ["first", "second"]
        : ["first"];

      await expect(provider.embed(input, new AbortController().signal))
        .rejects.toMatchObject({ code: "embedding_unavailable" });
    }
  });

  it("rejects empty and oversized batches before issuing a request", async () => {
    let requests = 0;
    const endpoint = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"embeddings":[]}');
    });
    const provider = new OllamaMemoryEmbeddingProvider(config(endpoint, 2));

    await expect(provider.embed([], new AbortController().signal))
      .rejects.toMatchObject({ code: "embedding_unavailable" });
    await expect(provider.embed(Array.from({ length: 65 }, () => "text"), new AbortController().signal))
      .rejects.toMatchObject({ code: "embedding_unavailable" });
    expect(requests).toBe(0);
  });

  it("propagates an aborted signal as AbortError", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const endpoint = await listen((_request, _response) => {
      requestStarted?.();
    });
    const provider = new OllamaMemoryEmbeddingProvider(config(endpoint, 2));
    const controller = new AbortController();
    const pending = provider.embed(["first"], controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await pending.catch((error: unknown) => {
      expect(error).not.toMatchObject({ code: "embedding_unavailable" });
    });
  });
});

function config(endpoint: string, dimensions: number) {
  return parseMemoryLocalConfig({
    embeddings: {
      provider: "ollama",
      endpoint,
      model: "nomic-embed-text:v1.5",
      dimensions,
      timeoutMs: 1_000,
    },
  }).embeddings!;
}

/**
 * Adapts an async handler, because `RequestListener` returns void.
 *
 * A rejection thrown inside an async handler passed straight to `createServer`
 * has nowhere to go: it becomes an unhandled rejection, the request never gets
 * a response, and the test times out with the reason detached from the failure.
 * Answering 500 keeps the reason attached to the request that caused it.
 */
async function listen(
  listener: (...args: Parameters<RequestListener>) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => listener(request, response))().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readBody(request: Parameters<RequestListener>[0]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

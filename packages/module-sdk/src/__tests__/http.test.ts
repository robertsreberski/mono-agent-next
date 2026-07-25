// SPDX-License-Identifier: MIT
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafeHttpUrl,
  checkedFetch,
  isLiteralLoopbackHostname,
} from "../http.js";

const servers: Server[] = [];

async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("safe HTTP URLs", () => {
  it("allows HTTPS and numeric loopback literals only", () => {
    expect(assertSafeHttpUrl("https://example.com/models").protocol).toBe("https:");
    expect(assertSafeHttpUrl("http://127.0.0.1:11434/api/tags").hostname).toBe("127.0.0.1");
    expect(assertSafeHttpUrl("http://[::1]:11434/api/tags").protocol).toBe("http:");
    expect(isLiteralLoopbackHostname("localhost")).toBe(false);
    expect(() => assertSafeHttpUrl("http://localhost:11434/api/tags")).toThrow(/literal/u);
    expect(() => assertSafeHttpUrl("http://2130706433/api/tags")).toThrow(/literal/u);
    expect(() => assertSafeHttpUrl("https://user:secret@example.com/")).toThrow(/credentials/u);
  });
});

describe("checkedFetch", () => {
  it("reads a bounded body and follows a checked same-origin redirect", async () => {
    const origin = await listen((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/ok" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });

    const result = await checkedFetch(`${origin}/redirect`, {}, { maxResponseBytes: 32 });
    expect(result.status).toBe(200);
    expect(result.json()).toEqual({ ok: true });
  });

  it("aborts a chunked response that crosses the streaming byte limit", async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.write("01234");
      response.end("56789");
    });

    await expect(checkedFetch(origin, {}, { maxResponseBytes: 5 })).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("rejects unsafe, cross-origin, and mutating redirects", async () => {
    let receivedHeaders: Headers | undefined;
    const target = await listen((request, response) => {
      receivedHeaders = new Headers(request.headers as Record<string, string>);
      response.end("target");
    });
    const origin = await listen((request, response) => {
      if (request.url === "/unsafe") response.writeHead(302, { location: "http://localhost:9/" });
      else response.writeHead(302, { location: target });
      response.end();
    });

    await expect(checkedFetch(`${origin}/unsafe`)).rejects.toMatchObject({ code: "unsafe_protocol" });
    await expect(checkedFetch(origin)).rejects.toMatchObject({ code: "redirect_cross_origin" });
    await expect(checkedFetch(origin, { method: "POST" })).rejects.toMatchObject({
      code: "redirect_unsafe_method",
    });

    const allowed = await checkedFetch(origin, {
      headers: {
        accept: "application/json",
        authorization: "Bearer secret",
        "x-api-key": "custom-secret",
        "api-key": "azure-secret",
      },
    }, { allowCrossOriginRedirects: true });
    expect(allowed.text()).toBe("target");
    expect(receivedHeaders?.get("accept")).toBe("application/json");
    expect(receivedHeaders?.get("authorization")).toBeNull();
    expect(receivedHeaders?.get("x-api-key")).toBeNull();
    expect(receivedHeaders?.get("api-key")).toBeNull();
  });

  it("enforces a whole-request timeout", async () => {
    const origin = await listen((_request, _response) => {
      // Intentionally leave the response pending until the client aborts.
    });

    await expect(checkedFetch(origin, {}, { timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

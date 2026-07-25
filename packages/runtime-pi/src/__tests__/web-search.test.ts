// SPDX-License-Identifier: MIT
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatWebSearchResults,
  searchWeb,
} from "../web-search.js";

const servers: Server[] = [];

async function listen(listener: RequestListener): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
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
  return { origin: `http://127.0.0.1:${String(address.port)}`, server };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function resultPage(): string {
  return [
    "<!doctype html><html><body><div class=\"results\">",
    "<a class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone\">Result &amp; One</a>",
    "<a class=\"result__snippet\">First <b>summary</b>.</a>",
    "<a class=\"result__a\" href=\"https://example.org/two\">Result Two</a>",
    "<div class=\"result__snippet\">Second summary.</div>",
    "</div></body></html>",
  ].join("");
}

describe("checked WebSearch implementation", () => {
  it("follows a bounded same-origin redirect and returns parsed, limited results", async () => {
    const { origin } = await listen((request, response) => {
      if (request.url?.startsWith("/redirect") === true) {
        response.writeHead(302, { location: "/results" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(resultPage());
    });

    const results = await searchWeb(
      { query: "literal query", limit: 1 },
      { endpoint: `${origin}/redirect` },
    );

    expect(results).toEqual([{
      title: "Result & One",
      url: "https://example.com/one",
      snippet: "First summary.",
    }]);
    expect(formatWebSearchResults(results)).toBe(
      "Result & One\nhttps://example.com/one\nFirst summary.",
    );
  });

  it("accepts an explicit recognized no-results page", async () => {
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><div class=\"no-results\">No results.</div></html>");
    });

    const results = await searchWeb(
      { query: "nothing", limit: 5 },
      { endpoint: origin },
    );
    expect(results).toEqual([]);
    expect(formatWebSearchResults(results)).toBe("No results.");
  });

  it("fails visibly on network, non-2xx, and unsupported content-type responses", async () => {
    const closed = await listen((_request, response) => response.end());
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    servers.splice(servers.indexOf(closed.server), 1);
    await expect(searchWeb(
      { query: "network", limit: 5 },
      { endpoint: closed.origin },
    )).rejects.toThrow("WebSearch failed");

    const nonSuccess = await listen((_request, response) => {
      response.writeHead(503, { "content-type": "text/html" });
      response.end("<html>unavailable</html>");
    });
    await expect(searchWeb(
      { query: "status", limit: 5 },
      { endpoint: nonSuccess.origin },
    )).rejects.toThrow("HTTP 503");

    const json = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"results\":[]}");
    });
    await expect(searchWeb(
      { query: "json", limit: 5 },
      { endpoint: json.origin },
    )).rejects.toThrow("unsupported content type");
  });

  it("rejects cross-origin and redirect-limit violations", async () => {
    let targetRequests = 0;
    const target = await listen((_request, response) => {
      targetRequests += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(resultPage());
    });
    const crossOrigin = await listen((_request, response) => {
      response.writeHead(302, { location: target.origin });
      response.end();
    });
    await expect(searchWeb(
      { query: "redirect", limit: 5 },
      { endpoint: crossOrigin.origin },
    )).rejects.toThrow("Cross-origin HTTP redirect");
    expect(targetRequests).toBe(0);

    const looping = await listen((_request, response) => {
      response.writeHead(302, { location: "/loop" });
      response.end();
    });
    await expect(searchWeb(
      { query: "loop", limit: 5 },
      { endpoint: looping.origin },
    )).rejects.toThrow("redirect limit");
  });

  it("rejects malformed UTF-8 and structurally unrecognized success pages", async () => {
    const malformed = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(Buffer.from([0xc3, 0x28]));
    });
    await expect(searchWeb(
      { query: "malformed", limit: 5 },
      { endpoint: malformed.origin },
    )).rejects.toThrow("malformed UTF-8");

    const unrecognized = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>Search portal changed.</body></html>");
    });
    await expect(searchWeb(
      { query: "changed", limit: 5 },
      { endpoint: unrecognized.origin },
    )).rejects.toThrow("unrecognized response");
  });
});

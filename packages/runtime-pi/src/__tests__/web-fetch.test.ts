import { Buffer } from "node:buffer";
import {
  createServer,
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
} from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  fetchPublicWeb,
  isPublicWebFetchAddress,
  requestPinnedHttps,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  type WebFetchAddress,
  type WebFetchResponse,
} from "../web-fetch.js";

const PUBLIC_V4: WebFetchAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: WebFetchAddress = {
  address: "2606:2800:220:1:248:1893:25c8:1946",
  family: 6,
};

function response(
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" },
): WebFetchResponse {
  return {
    url: "https://example.test/",
    status,
    statusText: status === 200 ? "OK" : "Failure",
    headers: new Headers(headers),
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  };
}

function input(overrides: Partial<Parameters<typeof fetchPublicWeb>[0]> = {}) {
  return {
    url: "https://example.test/resource",
    headers: {},
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}

describe("public HTTPS WebFetch", () => {
  it("classifies only globally routable unicast addresses as public", () => {
    expect(isPublicWebFetchAddress(PUBLIC_V4)).toBe(true);
    expect(isPublicWebFetchAddress(PUBLIC_V6)).toBe(true);
    for (const address of [
      { address: "0.0.0.0", family: 4 },
      { address: "10.0.0.1", family: 4 },
      { address: "100.64.0.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
      { address: "172.16.0.1", family: 4 },
      { address: "192.168.1.1", family: 4 },
      { address: "198.51.100.7", family: 4 },
      { address: "224.0.0.1", family: 4 },
      { address: "::", family: 6 },
      { address: "::1", family: 6 },
      { address: "::93.184.216.34", family: 6 },
      { address: "::192.168.1.1", family: 6 },
      { address: "::ffff:127.0.0.1", family: 6 },
      { address: "::ffff:0:192.168.1.1", family: 6 },
      { address: "100:0:0:1::1", family: 6 },
      { address: "2001:db8::1", family: 6 },
      { address: "3fff::1", family: 6 },
      { address: "5f00::1", family: 6 },
      { address: "fc00::1", family: 6 },
      { address: "fec0::1", family: 6 },
      { address: "fe80::1", family: 6 },
      { address: "ff02::1", family: 6 },
    ] as const) {
      expect(isPublicWebFetchAddress(address)).toBe(false);
    }
  });

  it("pins the checked DNS address into the request", async () => {
    const resolve = vi.fn(async () => [PUBLIC_V4]);
    const request = vi.fn(async (
      url: URL,
      address: WebFetchAddress,
      headers: Headers,
    ) => {
      expect(url.href).toBe("https://example.test/resource");
      expect(address).toEqual(PUBLIC_V4);
      expect(headers.get("accept-encoding")).toBe("identity");
      return response(200, "bounded body");
    });

    await expect(fetchPublicWeb(input(), { resolve, request }))
      .resolves.toBe("bounded body");
    expect(resolve).toHaveBeenCalledWith("example.test");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses the pinned scalar lookup for a normal hostname with family auto-selection enabled", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const serverAddress = server.address();
    if (serverAddress === null || typeof serverAddress === "string") {
      throw new Error("Expected a TCP fixture address.");
    }
    const previousAutoSelectFamily = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(true);
    let requestError: unknown;
    try {
      await requestPinnedHttps(
        new URL(`https://normal-hostname.test:${String(serverAddress.port)}/`),
        { address: "127.0.0.1", family: 4 },
        new Headers(),
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      requestError = error;
    } finally {
      setDefaultAutoSelectFamily(previousAutoSelectFamily);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }

    expect(requestError).toBeInstanceOf(Error);
    expect((requestError as NodeJS.ErrnoException).code).not.toBe("ERR_INVALID_IP_ADDRESS");
    expect(connections).toBe(1);
  });

  it("rejects mixed or private DNS answers before opening a request", async () => {
    const request = vi.fn();
    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4, { address: "127.0.0.1", family: 4 }],
      request,
    })).rejects.toThrow("non-public address");
    await expect(fetchPublicWeb(input(), {
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      request,
    })).rejects.toThrow("non-public address");
    expect(request).not.toHaveBeenCalled();
  });

  it("re-resolves redirects and drops caller headers across origins", async () => {
    const hosts: string[] = [];
    const seen: { url: string; userAgent: string | null; accept: string | null }[] = [];
    const request = vi.fn(async (
      url: URL,
      _address: WebFetchAddress,
      headers: Headers,
    ) => {
      seen.push({
        url: url.href,
        userAgent: headers.get("user-agent"),
        accept: headers.get("accept"),
      });
      return url.hostname === "example.test"
        ? response(302, "", {
            location: "https://other.test/final",
            "content-type": "text/plain",
          })
        : response(200, "redirected");
    });

    await expect(fetchPublicWeb(input({
      headers: { Accept: "text/plain", "User-Agent": "PersonalAgent/1" },
    }), {
      resolve: async (hostname) => {
        hosts.push(hostname);
        return [PUBLIC_V4];
      },
      request,
    })).resolves.toBe("redirected");

    expect(hosts).toEqual(["example.test", "other.test"]);
    expect(seen).toEqual([
      {
        url: "https://example.test/resource",
        userAgent: "PersonalAgent/1",
        accept: "text/plain",
      },
      {
        url: "https://other.test/final",
        userAgent: "mono-agent-runtime-pi/0.15",
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
      },
    ]);
  });

  it("retries transient HTTP and network failures with fresh DNS validation", async () => {
    const resolve = vi.fn(async () => [PUBLIC_V4]);
    const request = vi.fn()
      .mockResolvedValueOnce(response(503, "temporarily unavailable"))
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), {
        code: "ECONNRESET",
      }))
      .mockResolvedValueOnce(response(200, "recovered"));

    await expect(fetchPublicWeb(input(), {
      resolve,
      request,
      retryDelaysMs: [0, 0],
    })).resolves.toBe("recovered");
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry policy failures or non-transient HTTP responses", async () => {
    const resolve = vi.fn(async () => [PUBLIC_V4]);
    const request = vi.fn(async () => response(400, "bad request"));

    await expect(fetchPublicWeb(input(), {
      resolve,
      request,
      retryDelaysMs: [0, 0],
    })).rejects.toThrow("HTTP 400");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects plaintext, embedded credentials, credential headers, and unknown headers", async () => {
    const resolve = vi.fn(async () => [PUBLIC_V4]);
    await expect(fetchPublicWeb(input({ url: "http://example.test/" }), { resolve }))
      .rejects.toThrow("public HTTPS");
    await expect(fetchPublicWeb(input({ url: "https://user:secret@example.test/" }), { resolve }))
      .rejects.toThrow("embedded credentials");
    for (const headers of [
      { Authorization: "Bearer secret" },
      { Cookie: "session=secret" },
      { "Proxy-Authorization": "Basic secret" },
    ]) {
      await expect(fetchPublicWeb(input({ headers }), { resolve }))
        .rejects.toThrow("credential header");
    }
    await expect(fetchPublicWeb(input({ headers: { "X-Internal-Token": "secret" } }), { resolve }))
      .rejects.toThrow("is not allowed");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("bounds attempts and applies caller cancellation to DNS", async () => {
    const never = new Promise<readonly WebFetchAddress[]>(() => undefined);
    await expect(fetchPublicWeb(input(), {
      resolve: () => never,
      timeoutMs: 10,
      retryDelaysMs: [],
    })).rejects.toMatchObject({ name: "TimeoutError" });

    const controller = new AbortController();
    const run = fetchPublicWeb(input(), {
      resolve: () => never,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort(new Error("cancelled by caller"));
    await expect(run).rejects.toThrow("cancelled by caller");
  });

  it("retries an attempt timeout and retains a bounded overall deadline", async () => {
    const resolve = vi.fn(async () => [PUBLIC_V4]);
    const request = vi.fn(async (
      _url: URL,
      _address: WebFetchAddress,
      _headers: Headers,
      signal: AbortSignal,
    ) => {
      if (request.mock.calls.length === 1) {
        return new Promise<WebFetchResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return response(200, "recovered after timeout");
    });

    await expect(fetchPublicWeb(input(), {
      resolve,
      request,
      retryDelaysMs: [0],
      timeoutMs: 10,
    })).resolves.toBe("recovered after timeout");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds response and output bytes and rejects binary or malformed text", async () => {
    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(
        200,
        new Uint8Array(WEB_FETCH_MAX_RESPONSE_BYTES).fill(0x61),
      ),
    })).resolves.toContain("truncated");

    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(
        200,
        new Uint8Array(WEB_FETCH_MAX_RESPONSE_BYTES + 1),
      ),
    })).rejects.toThrow("response exceeds");

    const output = await fetchPublicWeb(input({ maxOutputBytes: 64 }), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(200, "é".repeat(100)),
    });
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(64);
    expect(output).toContain("truncated");

    const oneByteOutput = await fetchPublicWeb(input({ maxOutputBytes: 1 }), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(200, "ascii"),
    });
    expect(oneByteOutput).toBe("a");

    for (const maxOutputBytes of [1, 2, 8, 32]) {
      const tinyOutput = await fetchPublicWeb(input({ maxOutputBytes }), {
        resolve: async () => [PUBLIC_V4],
        request: async () => response(200, "é".repeat(100)),
      });
      expect(Buffer.byteLength(tinyOutput, "utf8")).toBeLessThanOrEqual(maxOutputBytes);
      expect(tinyOutput).not.toContain("\uFFFD");
      expect(tinyOutput).not.toContain("truncated");
    }

    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(200, "binary", {
        "content-type": "application/octet-stream",
      }),
    })).rejects.toThrow("unsupported content type");
    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(200, new Uint8Array([0xc3, 0x28])),
    })).rejects.toThrow("malformed UTF-8");
  });

  it("fails visibly on invalid redirects and non-success responses", async () => {
    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(302, "", {
        location: "http://127.0.0.1/private",
      }),
    })).rejects.toThrow("public HTTPS");
    await expect(fetchPublicWeb(input(), {
      resolve: async () => [PUBLIC_V4],
      request: async () => response(503, "unavailable"),
      retryDelaysMs: [],
    })).rejects.toThrow("HTTP 503");
  });
});

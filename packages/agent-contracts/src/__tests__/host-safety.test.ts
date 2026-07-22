import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  assertSafeBind,
  bearerTokensEqual,
  BoundedHttpResponseWriter,
  hostForUrl,
  isLoopbackHost,
  isWildcardHost,
  normalizeHostForBind,
  readAuthorizationBearer,
} from "../index.js";

class StubServerResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly frames: string[] = [];
  writable = false;

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.writable;
  }
}

describe("isLoopbackHost", () => {
  it("recognizes exact loopback forms including mapped IPv6", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.5.5.5",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "[::ffff:7f05:505]",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects public, malformed, and loopback-looking hostnames", () => {
    for (const host of [
      "0.0.0.0",
      "10.0.0.1",
      "example.com",
      "192.168.1.1",
      "127.attacker.example",
      "127.0.0.1.attacker.example",
      "127.0.0.1:80",
      "127.1",
      "127.00.00.01",
      "[127.0.0.1]",
      "[::1",
      "::1]",
      "::ffff:126.255.255.255",
      "::ffff:128.0.0.1",
      "::ffff:example.com",
      "localhost.attacker.example",
      " localhost",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("bind-host normalization", () => {
  it("removes matched IPv6 brackets without accepting malformed pairs", () => {
    expect(normalizeHostForBind("[::1]")).toBe("::1");
    expect(normalizeHostForBind("::1")).toBe("::1");
    expect(normalizeHostForBind("[::1")).toBe("[::1");
  });

  it("recognizes exact wildcard forms", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("[::]")).toBe(true);
    expect(isWildcardHost("0:0:0:0:0:0:0:0")).toBe(true);
    expect(isWildcardHost("::ffff:0.0.0.0")).toBe(true);
    expect(isWildcardHost("[::ffff:0.0.0.0]")).toBe(true);
    expect(isWildcardHost("0:0:0:0:0:ffff:0:0")).toBe(true);
    expect(isWildcardHost("::ffff:0.0.0.1")).toBe(false);
    expect(isWildcardHost("0.0.0.0.example")).toBe(false);
  });
});

describe("hostForUrl", () => {
  it("brackets bare IPv6 hosts only", () => {
    expect(hostForUrl("::1")).toBe("[::1]");
    expect(hostForUrl("[::1]")).toBe("[::1]");
    expect(hostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("assertSafeBind", () => {
  it("allows loopback, allows non-loopback when opted in, else throws", () => {
    const makeError = (host: string): Error => new Error(`unsafe:${host}`);
    expect(() => assertSafeBind("127.0.0.1", false, makeError)).not.toThrow();
    expect(() => assertSafeBind("0.0.0.0", true, makeError)).not.toThrow();
    expect(() => assertSafeBind("0.0.0.0", false, makeError)).toThrow("unsafe:0.0.0.0");
  });
});

describe("bearerTokensEqual", () => {
  it("is true only for identical tokens", () => {
    expect(bearerTokensEqual("abc", "abc")).toBe(true);
    expect(bearerTokensEqual("abc", "abd")).toBe(false);
    expect(bearerTokensEqual("abc", "abcd")).toBe(false);
  });

  it("returns false when code-unit lengths match but UTF-8 byte lengths differ", () => {
    expect(bearerTokensEqual("abé", "abc")).toBe(false);
  });
});

describe("readAuthorizationBearer", () => {
  it("parses the bearer credential case-insensitively", () => {
    expect(readAuthorizationBearer("Bearer xyz")).toBe("xyz");
    expect(readAuthorizationBearer("bearer  xyz ")).toBe("xyz");
    expect(readAuthorizationBearer("Basic xyz")).toBeUndefined();
    expect(readAuthorizationBearer(undefined)).toBeUndefined();
    expect(readAuthorizationBearer("Bearer   ")).toBeUndefined();
  });
});

describe("BoundedHttpResponseWriter", () => {
  it("serializes writes until a backpressured response drains", async () => {
    const response = new StubServerResponse();
    const writer = new BoundedHttpResponseWriter(response as unknown as ServerResponse);

    const first = writer.write("first");
    const second = writer.write("second");
    await Promise.resolve();
    expect(response.frames).toEqual(["first"]);

    response.writable = true;
    response.emit("drain");
    await Promise.all([first, second]);
    expect(response.frames).toEqual(["first", "second"]);
  });

  it("rejects a queue that exceeds its byte budget and reports failure once", async () => {
    const response = new StubServerResponse();
    const onFailure = vi.fn();
    const writer = new BoundedHttpResponseWriter(response as unknown as ServerResponse, {
      maxPendingBytes: 5,
      onFailure,
    });

    const first = writer.write("1234");
    await expect(writer.write("67")).rejects.toThrow("5-byte pending-write limit");
    await expect(writer.write("8")).rejects.toThrow("5-byte pending-write limit");
    expect(onFailure).toHaveBeenCalledTimes(1);

    await expect(first).rejects.toThrow("5-byte pending-write limit");
  });
});

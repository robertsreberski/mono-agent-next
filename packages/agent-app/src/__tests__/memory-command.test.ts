import { MemorySearchError } from "@mono-agent/memory/search";
import type { MemorySearchErrorCode } from "@mono-agent/memory/search";
import { describe, expect, it } from "vitest";

import { isFtsFallbackEligible } from "../memory-command.js";
import type { MemoryRecallSettings } from "../memory-recall.js";

const semanticSettings: MemoryRecallSettings = {
  root: "/memory",
  embeddings: { provider: "ollama", model: "test-embed" },
};

const fallbackMemorySearchCodes = [
  "embedding_circuit_open",
  "embedding_request_failed",
  "embedding_response_invalid",
  "invalid_embedding_options",
] as const satisfies readonly MemorySearchErrorCode[];

describe("isFtsFallbackEligible", () => {
  it.each(fallbackMemorySearchCodes)("accepts the typed provider failure code %s", (code) => {
    expect(isFtsFallbackEligible(semanticSettings, new MemorySearchError(code, "provider unavailable"))).toBe(true);
  });

  it("accepts a real fetch failure with a structured network cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("uses intrinsic TypeError identity even when its mutable name is changed", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause, name: "Error" });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("accepts bounded AggregateError network causes", () => {
    const nested = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
    const error = new AggregateError([new AggregateError([nested], "nested fetch failures")], "fetch failed");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("bounds a huge root AggregateError fan-out before reading or enqueueing every entry", () => {
    const error = new AggregateError(new Array(200_000).fill(null), "many failures");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("bounds a huge nested AggregateError fan-out before reading or enqueueing every entry", () => {
    const nested = new AggregateError(new Array(200_000).fill(null), "many nested failures");
    const error = new AggregateError([nested], "fetch failed");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("recognizes a network failure at the exact traversal bound", () => {
    const failures = Array.from({ length: 16 }, () => new Error("unrelated failure"));
    failures[15] = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });

    expect(isFtsFallbackEligible(semanticSettings, new AggregateError(failures, "fetch failed"))).toBe(true);
  });

  it("does not read or recognize a network failure beyond the traversal bound", () => {
    const error = new AggregateError(new Array<Error | null>(17).fill(null), "fetch failed");
    let beyondBoundReads = 0;
    Object.defineProperty(error.errors, 16, {
      configurable: true,
      get() {
        beyondBoundReads += 1;
        return Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
      },
    });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
    expect(beyondBoundReads).toBe(0);
  });

  it("terminates on cyclic cause graphs", () => {
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = error;

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("accepts an intrinsic DOM AbortError even when an own name property tries to hide it", () => {
    const timeout = new DOMException("This operation was aborted", "AbortError");
    Object.defineProperty(timeout, "name", { configurable: true, value: "Error" });

    expect(isFtsFallbackEligible(semanticSettings, timeout)).toBe(true);
  });

  it.each([
    [
      "an ordinary Error renamed AbortError",
      () => Object.assign(new Error("programming failure"), { name: "AbortError" }),
    ],
    [
      "an ordinary Error renamed TypeError with a plain network-shaped cause",
      () => Object.assign(new Error("programming failure"), {
        name: "TypeError",
        cause: { code: "ECONNREFUSED" },
      }),
    ],
    [
      "a real TypeError whose plain cause carries an arbitrary errors array",
      () => Object.assign(new TypeError("fetch failed"), {
        cause: {
          errors: [Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
        },
      }),
    ],
    [
      "a real TypeError with a throwing cause getter",
      () => {
        const error = new TypeError("fetch failed");
        Object.defineProperty(error, "cause", {
          configurable: true,
          get() {
            throw new Error("cause getter exploded");
          },
        });
        return error;
      },
    ],
  ] as const)("reviewer honesty matrix rejects %s without replacing the original failure", (_label, createError) => {
    expect(isFtsFallbackEligible(semanticSettings, createError())).toBe(false);
  });

  it("ignores an arbitrary errors array on a non-aggregate TypeError", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      errors: [Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
    });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it.each([
    [
      "AggregateError.errors",
      () => {
        const error = new AggregateError([], "fetch failed");
        Object.defineProperty(error, "errors", {
          configurable: true,
          get() {
            throw new Error("errors getter exploded");
          },
        });
        return error;
      },
    ],
    [
      "nested Error.code",
      () => {
        const cause = new Error("lookup failed");
        Object.defineProperty(cause, "code", {
          configurable: true,
          get() {
            throw new Error("code getter exploded");
          },
        });
        return Object.assign(new TypeError("fetch failed"), { cause });
      },
    ],
    [
      "AggregateError.errors array entry",
      () => {
        const errors = new Array<Error>(1);
        Object.defineProperty(errors, 0, {
          configurable: true,
          get() {
            throw new Error("errors entry getter exploded");
          },
        });
        const aggregate = new AggregateError([], "fetch failed");
        Object.defineProperty(aggregate, "errors", { configurable: true, value: errors });
        return aggregate;
      },
    ],
  ] as const)("fails closed when %s inspection throws", (_label, createError) => {
    expect(isFtsFallbackEligible(semanticSettings, createError())).toBe(false);
  });

  it.each([
    ["a bare TypeError", new TypeError("request failed")],
    [
      "a programming TypeError whose message mentions ECONNREFUSED",
      new TypeError("Cannot read properties of undefined (reading 'ECONNREFUSED')"),
    ],
    ["an invariant Error whose message mentions embedding", new Error("embedding adapter invariant violated")],
    [
      "a fetch-shaped TypeError with an unknown cause code",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      }),
    ],
    [
      "a TypeError with only a top-level network code",
      Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
    ],
    [
      "a genuine TypeError with only a plain-object network cause",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    ],
    [
      "an ordinary Error renamed AggregateError with an errors array",
      Object.assign(new Error("fetch failed"), {
        name: "AggregateError",
        errors: [Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
      }),
    ],
    [
      "an untyped lookalike provider error",
      Object.assign(new Error("provider failed"), {
        name: "MemorySearchError",
        code: "embedding_request_failed",
      }),
    ],
    ["an unknown non-error cause", { cause: { code: "ECONNREFUSED" } }],
  ])("rejects %s", (_label, error) => {
    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("never falls back without configured local embeddings", () => {
    const providerError = new MemorySearchError("embedding_request_failed", "provider unavailable");

    expect(isFtsFallbackEligible({ root: "/memory" }, providerError)).toBe(false);
    expect(isFtsFallbackEligible({
      supermemory: { baseUrl: "https://example.invalid", container: "agent" },
    }, providerError)).toBe(false);
  });
});

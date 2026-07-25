// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PI_AUTH_PATH,
  isLiteralLoopback,
  parsePiModelReference,
  parseRuntimePiConfig,
} from "../config.js";

describe("runtime-pi config", () => {
  it("applies bounded side-effect-free defaults", () => {
    expect(parseRuntimePiConfig({})).toEqual({
      auth: { path: DEFAULT_PI_AUTH_PATH },
      retry: { maxRetries: 2, maxDelayMs: 60_000, timeoutMs: 600_000 },
      localProviders: [],
    });
  });

  it("rejects unknown fields and invalid retry bounds", () => {
    expect(() => parseRuntimePiConfig({ enabled: true })).toThrow("$.enabled");
    expect(() => parseRuntimePiConfig({ retry: { maxRetries: 11 } })).toThrow("$.retry.maxRetries");
    expect(() => parseRuntimePiConfig({ retry: { maxDelayMs: -1 } })).toThrow("$.retry.maxDelayMs");
    expect(() => parseRuntimePiConfig({ retry: { maxRetryDelayMs: 1 } })).toThrow("$.retry.maxRetryDelayMs");
  });

  it("allows keyless providers only on literal loopback", () => {
    const local = parseRuntimePiConfig({
      localProviders: [
        {
          id: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: [{ id: "qwen3.6:latest", reasoning: true, input: ["text", "image"] }],
        },
      ],
    });
    expect(local.localProviders[0]?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(() => parseRuntimePiConfig({
      localProviders: [{ id: "remote", baseUrl: "https://models.example.test/v1" }],
    })).toThrow("literal loopback");
  });

  it("accepts discovery-only providers and rejects duplicate provider ids", () => {
    expect(parseRuntimePiConfig({
      localProviders: [{ id: "ollama", baseUrl: "http://127.0.0.1:11434" }],
    }).localProviders).toEqual([{ id: "ollama", baseUrl: "http://127.0.0.1:11434" }]);
    expect(() => parseRuntimePiConfig({
      localProviders: [
        { id: "ollama", baseUrl: "http://127.0.0.1:11434" },
        { id: "ollama", baseUrl: "http://127.0.0.1:11435" },
      ],
    })).toThrow("duplicate provider id");
    expect(() => parseRuntimePiConfig({
      localProviders: { ollama: { baseUrl: "http://127.0.0.1:11434" } },
    })).toThrow("must be an array");
  });

  it("does not treat lookalike or credential-bearing URLs as keyless local endpoints", () => {
    expect(isLiteralLoopback("localhost")).toBe(false);
    expect(isLiteralLoopback("127.23.4.5")).toBe(true);
    expect(isLiteralLoopback("::1")).toBe(true);
    expect(isLiteralLoopback("localhost.example.test")).toBe(false);
    expect(() => parseRuntimePiConfig({
      localProviders: [{ id: "local", baseUrl: "http://localhost:11434/v1" }],
    })).toThrow("literal loopback");
    expect(() => parseRuntimePiConfig({
      localProviders: [{ id: "local", baseUrl: "http://user:pass@127.0.0.1:11434/v1" }],
    })).toThrow("must not contain URL credentials");
  });

  it("parses provider-qualified model ids at the first colon", () => {
    expect(parsePiModelReference("ollama:qwen3.6:latest")).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
    });
    expect(() => parsePiModelReference("missing-provider")).toThrow("provider:model");
    expect(() => parsePiModelReference("Bad:model")).toThrow("valid provider id");
  });
});

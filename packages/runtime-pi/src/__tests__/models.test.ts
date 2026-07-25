// SPDX-License-Identifier: MIT
import { createServer, type RequestListener, type Server } from "node:http";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRuntimePiConfig } from "../config.js";
import {
  createRuntimePiModelRegistry,
  piThinkingLevel,
  publicEffortLevel,
  runtimePiModelDescriptor,
  RuntimePiModelDiscoveryError,
} from "../models.js";
import { isCheckedTransientProviderFailure } from "../runtime.js";

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

async function fixtureServer(
  handler: RequestListener,
): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("runtime-pi model registry", () => {
  it("uses explicit stored API-key credentials and ignores ambient provider secrets", async () => {
    const credentials = new InMemoryCredentialStore();
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({}), credentials);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-secret-must-not-be-used";
    try {
      await expect(registry.models.getAuth("openai")).resolves.toBeUndefined();
      await credentials.modify("openai", async () => ({
        type: "api_key",
        key: "stored-openai-key",
      }));
      await expect(registry.models.getAuth("openai")).resolves.toMatchObject({
        auth: { apiKey: "stored-openai-key" },
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("resolves configured local models without model-discovery network access", async () => {
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{
        id: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [{ id: "vision", input: ["text", "image"] }],
      }],
    }), new InMemoryCredentialStore());

    await expect(registry.resolve("fixture:vision")).resolves.toMatchObject({
      id: "vision",
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    await expect(registry.capabilities("fixture:vision")).resolves.toMatchObject({
      attachments: true,
      approvals: true,
      sandbox: false,
    });
  });

  it("describes a configured local route from config alone, without network access", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const config = parseRuntimePiConfig({
      localProviders: [{
        id: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [{ id: "vision", name: "Fixture Vision", contextWindow: 64_000 }],
      }],
    });

    expect(runtimePiModelDescriptor(config, "fixture:vision")).toMatchObject({
      label: "Fixture Vision",
      contextWindow: 64_000,
    });
    // A route the config never declares is not describable, and is reported as
    // absent rather than guessed from a same-named model on another provider.
    expect(runtimePiModelDescriptor(config, "fixture:undeclared")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("maps Pi's off level onto the public none effort in both directions", () => {
    expect(publicEffortLevel("off")).toBe("none");
    expect(publicEffortLevel("high")).toBe("high");
    expect(piThinkingLevel("none")).toBe("off");
    expect(piThinkingLevel("high")).toBe("high");
  });

  it("discovers an omitted local model list through Pi's provider refresh hook", async () => {
    let requests = 0;
    const { baseUrl } = await fixtureServer((request, response) => {
      requests += 1;
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/v1/models");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "discovered" }] }));
    });
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl }],
    }), new InMemoryCredentialStore());

    await expect(registry.resolve("fixture:discovered")).resolves.toMatchObject({
      id: "discovered",
      provider: "fixture",
      input: ["text"],
    });
    await expect(registry.resolve("fixture:discovered")).resolves.toMatchObject({ id: "discovered" });
    expect(requests).toBe(1);
  });

  it("does not follow model-discovery redirects away from the configured endpoint", async () => {
    const { baseUrl } = await fixtureServer((_request, response) => {
      response.writeHead(302, { location: "https://models.example.test/v1/models" });
      response.end();
    });
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl }],
    }), new InMemoryCredentialStore());

    await expect(registry.resolve("fixture:model")).rejects.toThrow("HTTP 302");
  });

  it("preserves trusted HTTP status for transient model-discovery failures", async () => {
    const { baseUrl } = await fixtureServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl }],
    }), new InMemoryCredentialStore());

    const error = await rejection(registry.resolve("fixture:model"));
    expect(error).toBeInstanceOf(RuntimePiModelDiscoveryError);
    expect(error).toMatchObject({ status: 503 });
    expect(isCheckedTransientProviderFailure(error)).toBe(true);
  });

  it("preserves trusted HTTP status without retrying authentication failures", async () => {
    const { baseUrl } = await fixtureServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl }],
    }), new InMemoryCredentialStore());

    const error = await rejection(registry.resolve("fixture:model"));
    expect(error).toBeInstanceOf(RuntimePiModelDiscoveryError);
    expect(error).toMatchObject({ status: 401 });
    expect(isCheckedTransientProviderFailure(error)).toBe(false);
  });

  it("preserves an allowlisted transport timeout code for retry classification", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError("socket timeout"), { code: "ETIMEDOUT" });
    }));
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl: "http://127.0.0.1:1/v1" }],
    }), new InMemoryCredentialStore());

    const error = await rejection(registry.resolve("fixture:model"));
    expect(error).toBeInstanceOf(RuntimePiModelDiscoveryError);
    expect(error).toMatchObject({ code: "ETIMEDOUT" });
    expect(isCheckedTransientProviderFailure(error)).toBe(true);
  });

  it("does not invoke or trust accessor-backed transport classifications", async () => {
    let accessorCalls = 0;
    const failure = new TypeError("untrusted transport failure");
    Object.defineProperty(failure, "code", {
      get() {
        accessorCalls += 1;
        return "ETIMEDOUT";
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw failure;
    }));
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl: "http://127.0.0.1:1/v1" }],
    }), new InMemoryCredentialStore());

    const error = await rejection(registry.resolve("fixture:model"));
    expect(error).toBeInstanceOf(RuntimePiModelDiscoveryError);
    expect(error).toMatchObject({ code: undefined });
    expect(isCheckedTransientProviderFailure(error)).toBe(false);
    expect(accessorCalls).toBe(0);
  });

  it("keeps a valid but absent model non-retryable and unclassified", async () => {
    const { baseUrl } = await fixtureServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "other-model" }] }));
    });
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl }],
    }), new InMemoryCredentialStore());

    const error = await rejection(registry.resolve("fixture:missing-model"));
    expect(error).toBeInstanceOf(TypeError);
    expect(Object.getOwnPropertyDescriptor(error, "status")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(error, "code")).toBeUndefined();
    expect(isCheckedTransientProviderFailure(error)).toBe(false);
  });

  it("rejects oversized discovery responses before reading their body", async () => {
    const { baseUrl } = await fixtureServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "1048577",
      });
      response.end("{}");
    });
    const registry = createRuntimePiModelRegistry(parseRuntimePiConfig({
      localProviders: [{ id: "fixture", baseUrl }],
    }), new InMemoryCredentialStore());

    await expect(registry.resolve("fixture:model")).rejects.toThrow("exceeds 1048576 bytes");
  });
});

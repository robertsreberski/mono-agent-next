import { createServer, type RequestListener, type Server } from "node:http";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { parseRuntimePiConfig } from "../config.js";
import { createRuntimePiModelRegistry } from "../models.js";

const servers: Server[] = [];

afterEach(async () => {
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
      approvals: false,
      sandbox: false,
    });
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

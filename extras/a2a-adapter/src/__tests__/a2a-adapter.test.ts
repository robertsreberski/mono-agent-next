import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type {
  A2AAdapterConfig,
  A2AProviderOptions,
  A2AProviderStartResult,
} from "../index.js";

import {
  A2AConsumerError,
  A2AProviderError,
  createA2AAgentCard,
  createA2AChannelDriver,
  createChannelDriver,
  createA2AConsumer,
  createA2AConsumerResponder,
  loadA2AAdapterConfig,
  redactA2AAdapterConfig,
  sendA2AMessage,
  startA2AProvider,
} from "../index.js";

describe("A2A adapter contract", () => {
  it("creates a v1 Agent Card without secrets and with JSON-RPC and REST interfaces", () => {
    const card = createA2AAgentCard({
      name: "Local Mono",
      description: "Local test agent",
      version: "0.1.0",
      publicBaseUrl: "http://127.0.0.1:4300",
      requireBearer: true,
      provider: {
        organization: "Demo Org",
        url: "https://example.com",
      },
      skill: {
        id: "mono-chat",
        name: "Mono Chat",
        description: "Answers text prompts.",
        tags: ["mono", "chat"],
      },
    });

    expect(card.supportedInterfaces).toEqual([
      {
        url: "http://127.0.0.1:4300/a2a/json-rpc",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
      {
        url: "http://127.0.0.1:4300/a2a/rest",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "",
      },
    ]);
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
    expect(card.securitySchemes.bearer?.scheme?.$case).toBe("httpAuthSecurityScheme");
    expect(JSON.stringify(card)).not.toContain("secret");
  });

  it("round-trips text over loopback HTTP through provider discovery and consumer send", async () => {
    const responder: AgentResponder = {
      async respond(request, stream) {
        expect(request.conversationId).toEqual(expect.any(String));
        expect(request.metadata?.a2a).toMatchObject({
          taskId: expect.any(String),
          messageId: expect.any(String),
          inputModes: ["text/plain"],
        });
        await stream.append(`echo: ${request.text}`);
        return {};
      },
    };

    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder,
      agent: {
        name: "Echo Mono",
        description: "Echoes text",
        version: "0.1.0",
      },
      skill: {
        id: "echo",
        name: "Echo",
        description: "Echo text",
        tags: ["echo"],
      },
    });

    try {
      const response = await sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      });
      expect(response.text).toBe("echo: hello");
      expect(response.metadata.a2a).toMatchObject({
        remoteAgentUrl: provider.agentCardUrl,
        protocolVersion: "1.0",
      });
    } finally {
      await provider.stop();
    }
  });

  it("accepts a request above the SDK default when maxRequestBytes is configured", async () => {
    let observedLength = 0;
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      maxRequestBytes: 512 * 1_024,
      responder: {
        async respond(request) {
          observedLength = request.text.length;
          return { text: "accepted" };
        },
      },
      agent: {
        name: "Large Request Mono",
        description: "Accepts a configured large request",
        version: "0.1.0",
      },
      skill: {
        id: "large-request",
        name: "Large Request",
        description: "Accept a configured large request",
        tags: ["large-request"],
      },
    });

    try {
      const text = "x".repeat(150_000);
      await expect(sendA2AMessage({ agentUrl: provider.agentCardUrl, text }))
        .resolves.toMatchObject({ text: "accepted" });
      expect(observedLength).toBe(text.length);
    } finally {
      await provider.stop();
    }
  });

  it("authenticates before enforcing configured JSON-RPC and REST request limits", async () => {
    let responderCalls = 0;
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      requireBearer: true,
      bearerToken: "request-limit-token",
      maxRequestBytes: 1_024,
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: "unexpected" };
        },
      },
      agent: {
        name: "Bounded Mono",
        description: "Rejects oversized requests",
        version: "0.1.0",
      },
      skill: {
        id: "bounded",
        name: "Bounded",
        description: "Reject oversized requests",
        tags: ["bounded"],
      },
    });
    const oversized = JSON.stringify({ payload: "x".repeat(2_048) });

    try {
      const unauthenticated = await fetch(provider.jsonRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      });
      expect(unauthenticated.status).toBe(401);

      const jsonRpc = await fetch(provider.jsonRpcUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer request-limit-token",
          "content-type": "application/json",
        },
        body: oversized,
      });
      expect(jsonRpc.status).toBe(413);
      await expect(jsonRpc.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        error: { message: "Request body exceeds the configured limit." },
      });

      const rest = await fetch(provider.restUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer request-limit-token",
          "content-type": "application/a2a+json",
        },
        body: oversized,
      });
      expect(rest.status).toBe(413);
      await expect(rest.json()).resolves.toMatchObject({
        error: {
          code: 413,
          status: "RESOURCE_EXHAUSTED",
          message: "Request body exceeds the configured limit.",
        },
      });
      expect(responderCalls).toBe(0);
    } finally {
      await provider.stop();
    }
  });

  it.each([1_023, 100_000_001])(
    "rejects an invalid programmatic maxRequestBytes value (%s)",
    async (maxRequestBytes) => {
      await expect(startA2AProvider({
        host: "127.0.0.1",
        port: 0,
        maxRequestBytes,
        responder: echoResponder(),
        agent: {
          name: "Invalid Limit Mono",
          description: "Invalid request limit",
          version: "0.1.0",
        },
        skill: {
          id: "invalid-limit",
          name: "Invalid Limit",
          description: "Invalid request limit",
          tags: ["invalid-limit"],
        },
      })).rejects.toMatchObject({
        code: "invalid_config",
        details: { field: "maxRequestBytes" },
      });
    },
  );

  it.each([
    ["no capabilities", (card: Record<string, unknown>) => {
      delete card.capabilities;
    }],
    ["capabilities without extensions", (card: Record<string, unknown>) => {
      card.capabilities = { streaming: false };
    }],
    ["non-array extensions", (card: Record<string, unknown>) => {
      card.capabilities = { streaming: false, extensions: "malformed" };
    }],
    ["a malformed extension entry", (card: Record<string, unknown>) => {
      card.capabilities = { streaming: false, extensions: [null] };
    }],
  ] as const)(
    "keeps unkeyed compatibility but refuses keyed sends for a card with %s",
    async (label, mutateCard) => {
      const provider = await startA2AProvider({
        host: "127.0.0.1",
        port: 0,
        responder: echoResponder(),
        agent: {
          name: "Legacy Mono",
          description: "Omits modern extension capability fields",
          version: "0.1.0",
        },
        skill: {
          id: "legacy",
          name: "Legacy",
          description: "Legacy compatibility",
          tags: ["legacy"],
        },
      });
      let posts = 0;
      try {
        const consumer = await createA2AConsumer({
          agentUrl: provider.agentCardUrl,
          fetchImpl: async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const response = await fetch(request);
            if (request.method !== "GET") {
              posts += 1;
              return response;
            }
            const card = await response.json() as Record<string, unknown>;
            mutateCard(card);
            return new Response(JSON.stringify(card), {
              status: response.status,
              headers: { "Content-Type": "application/json" },
            });
          },
        });

        await expect(consumer.sendMessage({ text: "unkeyed remains compatible" }))
          .resolves.toMatchObject({ text: "echo: unkeyed remains compatible" });
        expect(posts).toBe(1);
        await expect(consumer.sendMessage({
          text: "keyed must fail before dispatch",
          idempotencyKey: `legacy-${label.replace(/[^A-Za-z0-9]/gu, "-")}`,
        })).rejects.toMatchObject({ code: "idempotency_unsupported" });
        expect(posts).toBe(1);
      } finally {
        await provider.stop();
      }
    },
  );

  it("enforces bearer auth on message endpoints while keeping the card discoverable", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      requireBearer: true,
      bearerToken: "top-secret",
      responder: echoResponder(),
      agent: {
        name: "Secure Mono",
        description: "Secure echo",
        version: "0.1.0",
      },
      skill: {
        id: "secure-echo",
        name: "Secure Echo",
        description: "Echo text",
        tags: ["echo"],
      },
    });

    try {
      const cardResponse = await fetch(provider.agentCardUrl);
      expect(cardResponse.status).toBe(200);
      expect(await cardResponse.json()).toMatchObject({ name: "Secure Mono" });

      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      })).rejects.toMatchObject({
        code: "remote_auth_required",
      });

      const authed = await sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        bearerToken: "top-secret",
        text: "hello",
      });
      expect(authed.text).toBe("echo: hello");
    } finally {
      await provider.stop();
    }
  });

  it("rejects non-text-only requests explicitly", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: echoResponder(),
      agent: {
        name: "Text Mono",
        description: "Text only",
        version: "0.1.0",
      },
      skill: {
        id: "text",
        name: "Text",
        description: "Text only",
        tags: ["text"],
      },
    });

    try {
      const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
      await expect(consumer.sendMessage({
        message: {
          messageId: "file-only",
          role: 1,
          parts: [
            {
              content: { $case: "url", value: "file:///tmp/example.txt" },
              mediaType: "text/plain",
              filename: "example.txt",
              metadata: {},
            },
          ],
          contextId: "",
          taskId: "",
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
      })).rejects.toMatchObject({
        code: "remote_rejected",
      });
    } finally {
      await provider.stop();
    }
  });

  it("cancels active responder work through A2A task cancellation", async () => {
    let observedAbort = false;
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return { text: "should not complete" };
      },
    };

    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder,
      agent: {
        name: "Cancelable Mono",
        description: "Can cancel",
        version: "0.1.0",
      },
      skill: {
        id: "cancel",
        name: "Cancel",
        description: "Cancellation",
        tags: ["cancel"],
      },
    });

    try {
      const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
      const task = await consumer.sendMessage({ text: "wait", returnImmediately: true });
      const taskId = task.metadata.a2a.taskId;
      expect(taskId).toEqual(expect.any(String));
      await consumer.cancelTask(taskId as string);
      expect(observedAbort).toBe(true);
    } finally {
      await provider.stop();
    }
  });

  it("aborts active responder work and bounds repeated provider shutdown", async () => {
    let requestSignal: AbortSignal | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        requestSignal = request.abortSignal;
        return await new Promise(() => undefined);
      },
    };
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder,
      agent: {
        name: "Stopping Mono",
        description: "Stops boundedly",
        version: "0.1.0",
      },
      skill: {
        id: "stop",
        name: "Stop",
        description: "Bounded shutdown",
        tags: ["stop"],
      },
    });

    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    await consumer.sendMessage({ text: "wait", returnImmediately: true });
    const startedAt = Date.now();
    const firstStop = provider.stop();
    expect(provider.stop()).toBe(firstStop);
    await firstStop;

    expect(requestSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("returns typed failures for empty remote output", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: {
        async respond() {
          return {};
        },
      },
      agent: {
        name: "Empty Mono",
        description: "No output",
        version: "0.1.0",
      },
      skill: {
        id: "empty",
        name: "Empty",
        description: "No output",
        tags: ["empty"],
      },
    });

    try {
      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      })).rejects.toBeInstanceOf(A2AConsumerError);
      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
      })).rejects.toMatchObject({
        code: "empty_a2a_response",
      });
    } finally {
      await provider.stop();
    }
  });

  it("returns a typed timeout error when a remote agent exceeds the consumer timeout", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: {
        async respond() {
          await delay(100);
          return { text: "late response" };
        },
      },
      agent: {
        name: "Slow Mono",
        description: "Responds too slowly",
        version: "0.1.0",
      },
      skill: {
        id: "slow",
        name: "Slow",
        description: "Slow response",
        tags: ["slow"],
      },
    });

    try {
      await expect(sendA2AMessage({
        agentUrl: provider.agentCardUrl,
        text: "hello",
        timeoutMs: 10,
      })).rejects.toMatchObject({
        code: "timeout",
        message: "A2A request timed out after 10ms.",
        details: {
          timeoutMs: 10,
          agentUrl: provider.agentCardUrl,
        },
      });
    } finally {
      await provider.stop();
    }
  });

  it("adapts a remote A2A agent as an AgentResponder", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: echoResponder(),
      agent: {
        name: "Remote Mono",
        description: "Remote responder",
        version: "0.1.0",
      },
      skill: {
        id: "remote",
        name: "Remote",
        description: "Remote text",
        tags: ["remote"],
      },
    });

    try {
      const responder = createA2AConsumerResponder({ agentUrl: provider.agentCardUrl });
      const chunks: string[] = [];
      const response = await responder.respond({
        conversationId: "local-conversation",
        text: "hello",
        abortSignal: new AbortController().signal,
      }, {
        async append(delta) {
          chunks.push(delta);
        },
      });
      expect(response.text).toBe("echo: hello");
      expect(chunks.join("")).toContain("echo: hello");
    } finally {
      await provider.stop();
    }
  });

  it("loads optional config from JSON and env with redacted secrets", async () => {
    await expect(loadA2AAdapterConfig({ env: {}, json: {} }))
      .resolves.toMatchObject({ provider: { enabled: false } });

    const config = await loadA2AAdapterConfig({
      env: {
        MONO_AGENT_A2A_PROVIDER_ENABLED: "true",
        MONO_AGENT_A2A_BEARER_TOKEN: "env-token",
        MONO_AGENT_A2A_MAX_REQUEST_BYTES: "50000000",
        MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE: "env-principal",
        MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS: "321",
        MONO_AGENT_A2A_REMOTE_AGENT_URLS: "http://127.0.0.1:4300, http://127.0.0.1:4301",
      },
      json: {
        a2a: {
          provider: {
            host: "127.0.0.1",
            port: 4300,
            requireBearer: true,
            maxRequestBytes: 40000000,
            idempotency: {
              stateDir: ".mono-agent/a2a-state",
              namespace: "json-principal",
              retentionMs: 120000,
              maxRecords: 123,
            },
          },
          agent: {
            name: "Configured Mono",
            description: "Configured provider",
            version: "0.1.0",
          },
          skill: {
            id: "configured",
            name: "Configured",
            description: "Configured skill",
            tags: ["configured"],
          },
          consumer: {
            defaultRemoteAgentUrl: "http://127.0.0.1:4300",
            timeoutMs: 1234,
          },
        },
      },
    });

    expect(config.provider).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 4300,
      requireBearer: true,
      bearerToken: "env-token",
      maxRequestBytes: 50000000,
      idempotency: {
        stateDir: ".mono-agent/a2a-state",
        namespace: "env-principal",
        retentionMs: 120000,
        maxRecords: 321,
      },
    });
    expect(config.consumer.remoteAgentUrls).toEqual([
      "http://127.0.0.1:4300",
      "http://127.0.0.1:4301",
    ]);
    expect(redactA2AAdapterConfig(config)).toMatchObject({
      provider: {
        enabled: true,
        bearerToken: { present: true, redacted: true },
      },
      consumer: {
        bearerToken: { present: false, redacted: true },
      },
    });
    expect(JSON.stringify(redactA2AAdapterConfig(config))).not.toContain("env-token");
  });

  it("enables the provider from the canonical root `a2a.enabled` flag", async () => {
    const config = await loadA2AAdapterConfig({
      env: {},
      json: {
        a2a: {
          enabled: true,
          provider: { host: "127.0.0.1", port: 4300 },
          agent: { name: "Root", description: "Root-enabled provider", version: "0.1.0" },
          skill: { id: "root", name: "Root", description: "Root skill", tags: [] },
        },
      },
    });
    expect(config.provider.enabled).toBe(true);
  });

  it.each(["1023", "100000001"])(
    "rejects an out-of-range configured request limit (%s)",
    async (maxRequestBytes) => {
      await expect(loadA2AAdapterConfig({
        env: {
          MONO_AGENT_A2A_ENABLED: "true",
          MONO_AGENT_A2A_MAX_REQUEST_BYTES: maxRequestBytes,
        },
        json: {},
      })).rejects.toMatchObject({
        code: "invalid_config",
        details: { env: "MONO_AGENT_A2A_MAX_REQUEST_BYTES" },
      });
    },
  );

  it("does not parse provider-only request limits while the provider is disabled", async () => {
    await expect(loadA2AAdapterConfig({
      env: { MONO_AGENT_A2A_MAX_REQUEST_BYTES: "not-an-integer" },
      json: {},
    })).resolves.toMatchObject({ provider: { enabled: false } });
  });

  it("uses the public agent name as the default Agent Card name without overriding A2A-specific identity", async () => {
    const shared = {
      a2a: {
        enabled: true,
        provider: { host: "127.0.0.1", port: 0 },
        skill: { id: "default", name: "Default", description: "Default skill", tags: [] },
      },
    };
    const inherited = await loadA2AAdapterConfig({
      env: {},
      json: {
        ...shared,
        agent: { name: "Research Companion" },
        a2a: {
          ...shared.a2a,
          agent: { description: "Public agent", version: "1.0.0" },
        },
      },
    });
    expect(inherited.agent?.name).toBe("Research Companion");

    const explicit = await loadA2AAdapterConfig({
      env: {},
      json: {
        ...shared,
        agent: { name: "Research Companion" },
        a2a: {
          ...shared.a2a,
          agent: { name: "External Card", description: "Public agent", version: "1.0.0" },
        },
      },
    });
    expect(explicit.agent?.name).toBe("External Card");

    const environmentDefault = await loadA2AAdapterConfig({
      env: { MONO_AGENT_NAME: "Environment Companion" },
      json: {
        ...shared,
        a2a: {
          ...shared.a2a,
          agent: { description: "Public agent", version: "1.0.0" },
        },
      },
    });
    expect(environmentDefault.agent?.name).toBe("Environment Companion");
  });

  it("keeps the legacy `a2a.provider.enabled` form working, with the root flag winning when both are set", async () => {
    // Legacy form alone still enables.
    const legacy = await loadA2AAdapterConfig({
      env: {},
      json: {
        a2a: {
          provider: { enabled: true, host: "127.0.0.1", port: 4300 },
          agent: { name: "Legacy", description: "Legacy-enabled provider", version: "0.1.0" },
          skill: { id: "legacy", name: "Legacy", description: "Legacy skill", tags: [] },
        },
      },
    });
    expect(legacy.provider.enabled).toBe(true);

    // Root form wins over the legacy form when they disagree.
    const both = await loadA2AAdapterConfig({
      env: {},
      json: { a2a: { enabled: false, provider: { enabled: true } } },
    });
    expect(both.provider.enabled).toBe(false);

    // Env forms follow the same precedence.
    const env = await loadA2AAdapterConfig({
      env: { MONO_AGENT_A2A_ENABLED: "false", MONO_AGENT_A2A_PROVIDER_ENABLED: "true" },
      json: {},
    });
    expect(env.provider.enabled).toBe(false);
  });

  it("fails fast for unsafe provider exposure and invalid enabled config", async () => {
    await expect(loadA2AAdapterConfig({
      env: { MONO_AGENT_A2A_PROVIDER_ENABLED: "true" },
      json: {
        a2a: {
          provider: {
            host: "0.0.0.0",
            port: 4300,
          },
          agent: {
            name: "Unsafe",
            description: "Unsafe",
            version: "0.1.0",
          },
          skill: {
            id: "unsafe",
            name: "Unsafe",
            description: "Unsafe",
            tags: [],
          },
        },
      },
    })).rejects.toBeInstanceOf(A2AProviderError);
  });

  it("loads disabled channel-driver config without starting the provider", async () => {
    let providerCalls = 0;
    const driver = createA2AChannelDriver({
      config: { enabled: false },
      providerFactory: async () => {
        providerCalls += 1;
        return fakeProviderResult();
      },
    });

    const config = await driver.loadConfig({
      env: {},
      cwd: "/repo",
      configPath: "/repo/missing-mono-agent.config.json",
    });

    expect(driver.id).toBe("a2a");
    expect(driver.label).toBe("A2A");
    expect(config.provider.enabled).toBe(false);
    expect(driver.disabledReason?.(config)).toBe("A2A provider is disabled.");
    expect(driver.waitingReason?.(config)).toBeUndefined();
    expect(providerCalls).toBe(0);
  });

  it("exports the generic channel-driver alias from the package root", () => {
    const driver = createChannelDriver({ config: { enabled: false } });

    expect(driver.id).toBe("a2a");
    expect(driver.label).toBe("A2A");
  });

  it("marks JSON bearer tokens as redacted config-view fields for secret-placement warnings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-a2a-driver-view-"));
    const configPath = join(dir, "mono-agent.config.json");
    try {
      await writeFile(configPath, JSON.stringify({
        a2a: {
          enabled: false,
          provider: {
            bearerToken: "provider-json-secret",
          },
          consumer: {
            bearerToken: "consumer-json-secret",
          },
        },
      }), "utf8");

      const driver = createA2AChannelDriver();
      const section = await driver.configView?.({
        env: {},
        cwd: dir,
        configPath,
      });

      if (section === undefined) {
        throw new Error("Expected A2A driver to expose configView.");
      }
      expect(section.status).toBe("disabled");
      const fields = new Map(section.fields.map((field) => [field.id, field]));
      expect(fields.get("a2a.provider.bearerToken")).toMatchObject({
        value: "set",
        source: "json",
        redacted: true,
        envKey: "MONO_AGENT_A2A_BEARER_TOKEN",
      });
      expect(fields.get("a2a.consumer.bearerToken")).toMatchObject({
        value: "set",
        source: "json",
        redacted: true,
        envKey: "MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN",
      });
      expect(JSON.stringify(section)).not.toContain("provider-json-secret");
      expect(JSON.stringify(section)).not.toContain("consumer-json-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the same inherited public name in config view and the runtime Agent Card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-a2a-driver-name-view-"));
    const configPath = join(dir, "mono-agent.config.json");
    try {
      await writeFile(configPath, JSON.stringify({
        agent: { name: "JSON Companion" },
        a2a: { enabled: false },
      }), "utf8");
      const driver = createA2AChannelDriver();
      const jsonView = await driver.configView?.({ env: {}, cwd: dir, configPath });
      const envView = await driver.configView?.({
        env: { MONO_AGENT_NAME: "Environment Companion" },
        cwd: dir,
        configPath,
      });

      const jsonName = jsonView?.fields.find((field) => field.id === "a2a.agent.name");
      const envName = envView?.fields.find((field) => field.id === "a2a.agent.name");
      expect(jsonName).toMatchObject({ value: "JSON Companion", source: "json" });
      expect(envName).toMatchObject({
        value: "Environment Companion",
        source: "env",
        envKey: "MONO_AGENT_NAME",
      });

      await writeFile(configPath, JSON.stringify({
        agent: { name: "JSON Companion" },
        a2a: { enabled: false, agent: { name: "Protocol Card" } },
      }), "utf8");
      const explicitProtocolView = await driver.configView?.({
        env: { MONO_AGENT_NAME: "Environment Companion" },
        cwd: dir,
        configPath,
      });
      expect(explicitProtocolView?.fields.find((field) => field.id === "a2a.agent.name")).toMatchObject({
        value: "Protocol Card",
        source: "json",
        envKey: "MONO_AGENT_A2A_AGENT_NAME",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads channel-driver config from an existing configPath when inline config is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-a2a-driver-"));
    const configPath = join(dir, "mono-agent.config.json");
    try {
      await writeFile(configPath, JSON.stringify({
        a2a: {
          enabled: true,
          provider: {
            host: "127.0.0.1",
            port: 4305,
            publicBaseUrl: "http://127.0.0.1:4305",
          },
          agent: {
            name: "File Mono",
            description: "File provider",
            version: "0.1.0",
          },
          skill: {
            id: "file",
            name: "File",
            description: "File skill",
            tags: ["file"],
          },
          consumer: {
            remoteAgentUrls: ["http://127.0.0.1:7000"],
            timeoutMs: 4321,
          },
        },
      }), "utf8");

      const driver = createA2AChannelDriver();
      const config = await driver.loadConfig({
        env: {},
        cwd: dir,
        configPath,
      });

      expect(config.provider).toMatchObject({
        enabled: true,
        host: "127.0.0.1",
        port: 4305,
        publicBaseUrl: "http://127.0.0.1:4305",
      });
      expect(config.agent).toMatchObject({ name: "File Mono" });
      expect(config.skill).toMatchObject({ tags: ["file"] });
      expect(config.consumer).toMatchObject({
        remoteAgentUrls: ["http://127.0.0.1:7000"],
        timeoutMs: 4321,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports enabled-but-incomplete channel-driver config as typed or waiting config", async () => {
    const driver = createA2AChannelDriver({
      config: {
        enabled: true,
        provider: { host: "127.0.0.1", port: 0 },
      },
    });

    let error: unknown;
    try {
      await driver.loadConfig({
        env: {},
        cwd: "/repo",
        configPath: "/repo/missing-mono-agent.config.json",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(A2AProviderError);
    expect(driver.isConfigError(error)).toBe(true);

    const waitingConfig: A2AAdapterConfig = {
      provider: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        allowNonLoopback: false,
        requireBearer: false,
      },
      consumer: {
        remoteAgentUrls: [],
        timeoutMs: 30_000,
      },
    };
    expect(driver.waitingReason?.(waitingConfig)).toBe("A2A provider requires agent and skill configuration.");
    await expect(driver.start({
      config: waitingConfig,
      coreConfig: {},
      responder: echoResponder(),
      cwd: "/repo",
      onFailure() {},
    })).rejects.toMatchObject({
      code: "missing_required_config",
      message: "A2A provider requires agent and skill configuration.",
    });
  });

  it("starts through the injected channel-driver provider factory and returns its agent card summary", async () => {
    const responder = echoResponder();
    const logger = { info() {} };
    let captured: A2AProviderOptions | undefined;
    let stopped = false;
    const agentCardUrl = "http://127.0.0.1:4300/.well-known/agent-card.json";
    const driver = createA2AChannelDriver({
      providerFactory: async (options) => {
        captured = options;
        return fakeProviderResult({
          agentCardUrl,
          stop: async () => {
            stopped = true;
          },
        });
      },
    });

    const running = await driver.start({
      config: completeChannelConfig(),
      coreConfig: {},
      responder,
      cwd: "/repo",
      logger,
      onFailure() {},
    });

    expect(running.summary).toEqual({ agentCardUrl });
    expect(captured).toMatchObject({
      host: "127.0.0.1",
      port: 4300,
      publicBaseUrl: "http://127.0.0.1:4300",
      allowNonLoopback: false,
      requireBearer: true,
      bearerToken: "provider-token",
      maxRequestBytes: 50_000_000,
      idempotency: {
        stateDir: expect.stringMatching(/^\/repo\/\.mono-agent\/a2a-idempotency\/driver-production-/u),
        namespace: "driver-production",
        retentionMs: 120_000,
        maxRecords: 123,
      },
      agent: {
        name: "Driver Mono",
        description: "Driver provider",
        version: "0.1.0",
        provider: {
          organization: "Mono Org",
          url: "https://example.com/mono",
        },
      },
      skill: {
        id: "driver",
        name: "Driver",
        description: "Driver skill",
        tags: ["driver"],
      },
    });
    expect(captured?.responder).toBe(responder);
    expect(captured?.logger).toBe(logger);

    await running.stop();
    expect(stopped).toBe(true);
  });

  it("does not enable durable idempotency from config without an explicit namespace", async () => {
    let captured: A2AProviderOptions | undefined;
    const driver = createA2AChannelDriver({
      providerFactory: async (options) => {
        captured = options;
        return fakeProviderResult();
      },
    });
    const complete = completeChannelConfig();
    const { idempotency: _idempotency, ...providerWithoutIdempotency } = complete.provider;
    await driver.start({
      config: {
        ...complete,
        provider: providerWithoutIdempotency,
      },
      coreConfig: {},
      responder: echoResponder(),
      cwd: "/repo",
      onFailure() {},
    });

    expect(captured).not.toHaveProperty("idempotency");
  });

  it("rejects partial idempotency config that omits its stable namespace", async () => {
    await expect(loadA2AAdapterConfig({
      env: {},
      json: {
        a2a: {
          provider: {
            idempotency: {
              stateDir: ".mono-agent/ambiguous-a2a-state",
            },
          },
        },
      },
    })).rejects.toMatchObject({
      code: "missing_required_config",
      details: { env: "MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE" },
    });
  });

  it.each([
    [
      "empty",
      {},
      {
        code: "missing_required_config",
        details: { path: "a2a.provider.idempotency.namespace" },
      },
    ],
    [
      "unknown",
      { namespce: "production" },
      {
        code: "invalid_config",
        details: {
          path: "a2a.provider.idempotency",
          unknownFields: ["namespce"],
        },
      },
    ],
  ] as const)("rejects an explicitly present %s idempotency block", async (_label, idempotency, expected) => {
    const driver = createA2AChannelDriver({
      config: {
        provider: { idempotency },
      },
    });

    await expect(driver.loadConfig({
      env: {},
      cwd: "/repo",
      configPath: "/repo/missing-mono-agent.config.json",
    })).rejects.toMatchObject(expected);
  });

  it("honors plugin-style raw config while letting env overrides win", async () => {
    const driver = createA2AChannelDriver({
      id: "plugin-a2a",
      label: "Plugin A2A",
      config: {
        enabled: true,
        provider: {
          host: "127.0.0.1",
          port: 1111,
          publicBaseUrl: "http://127.0.0.1:1111",
        },
        agent: {
          name: "Plugin Mono",
          description: "Plugin provider",
          version: "0.1.0",
        },
        skill: {
          id: "plugin",
          name: "Plugin",
          description: "Plugin skill",
          tags: ["plugin"],
        },
        consumer: {
          remoteAgentUrls: ["http://127.0.0.1:7000"],
          timeoutMs: 1234,
        },
      },
    });

    const config = await driver.loadConfig({
      env: {
        MONO_AGENT_A2A_PORT: "2222",
        MONO_AGENT_A2A_AGENT_NAME: "Env Mono",
        MONO_AGENT_A2A_REMOTE_AGENT_URLS: "http://127.0.0.1:8000",
      },
      cwd: "/repo",
      configPath: "/repo/this-file-is-not-read.json",
    });

    expect(driver.id).toBe("plugin-a2a");
    expect(driver.label).toBe("Plugin A2A");
    expect(config.provider).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 2222,
      publicBaseUrl: "http://127.0.0.1:1111",
    });
    expect(config.agent).toMatchObject({
      name: "Env Mono",
      description: "Plugin provider",
      version: "0.1.0",
    });
    expect(config.skill).toMatchObject({
      id: "plugin",
      name: "Plugin",
      description: "Plugin skill",
      tags: ["plugin"],
    });
    expect(config.consumer).toMatchObject({
      remoteAgentUrls: ["http://127.0.0.1:8000"],
      timeoutMs: 1234,
    });
  });

  it("rejects wrong-typed plugin-style raw config fields as A2A config errors", async () => {
    const cases = [
      {
        name: "boolean",
        config: { provider: { requireBearer: "true" } },
        path: "a2a.provider.requireBearer",
      },
      {
        name: "integer",
        config: { provider: { port: "4300" } },
        path: "a2a.provider.port",
      },
      {
        name: "request limit integer",
        config: { provider: { maxRequestBytes: "50000000" } },
        path: "a2a.provider.maxRequestBytes",
      },
      {
        name: "skill csv",
        config: { skill: { tags: "a,b" } },
        path: "a2a.skill.tags",
      },
      {
        name: "consumer csv",
        config: { consumer: { remoteAgentUrls: "http://127.0.0.1:7000" } },
        path: "a2a.consumer.remoteAgentUrls",
      },
      {
        name: "section",
        config: { agent: ["not", "an", "object"] },
        path: "a2a.agent",
      },
    ];

    for (const testCase of cases) {
      const driver = createA2AChannelDriver({ config: testCase.config });
      const error = await driver.loadConfig({
        env: {},
        cwd: "/repo",
        configPath: "/repo/this-file-is-not-read.json",
      }).catch((caught: unknown) => caught);

      expect(error, testCase.name).toBeInstanceOf(A2AProviderError);
      expect(error, testCase.name).toMatchObject({
        code: "invalid_config",
        details: {
          code: "invalid_config",
          path: testCase.path,
        },
      });
      expect(driver.isConfigError(error)).toBe(true);
    }
  });
});

function echoResponder(): AgentResponder {
  return {
    async respond(request) {
      return { text: `echo: ${request.text}` };
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function completeChannelConfig(): A2AAdapterConfig {
  return {
    provider: {
      enabled: true,
      host: "127.0.0.1",
      port: 4300,
      publicBaseUrl: "http://127.0.0.1:4300",
      allowNonLoopback: false,
      requireBearer: true,
      bearerToken: "provider-token",
      maxRequestBytes: 50_000_000,
      idempotency: {
        namespace: "driver-production",
        retentionMs: 120_000,
        maxRecords: 123,
      },
    },
    agent: {
      name: "Driver Mono",
      description: "Driver provider",
      version: "0.1.0",
      providerOrganization: "Mono Org",
      providerUrl: "https://example.com/mono",
    },
    skill: {
      id: "driver",
      name: "Driver",
      description: "Driver skill",
      tags: ["driver"],
    },
    consumer: {
      remoteAgentUrls: [],
      timeoutMs: 30_000,
    },
  };
}

function fakeProviderResult(
  options: {
    readonly agentCardUrl?: string;
    readonly stop?: () => Promise<void>;
  } = {},
): A2AProviderStartResult {
  const agentCardUrl = options.agentCardUrl ?? "http://127.0.0.1:4300/.well-known/agent-card.json";
  return {
    url: "http://127.0.0.1:4300",
    agentCardUrl,
    jsonRpcUrl: "http://127.0.0.1:4300/a2a/json-rpc",
    restUrl: "http://127.0.0.1:4300/a2a/rest",
    host: "127.0.0.1",
    port: 4300,
    agentCard: {} as A2AProviderStartResult["agentCard"],
    stop: options.stop ?? (async () => {}),
  };
}

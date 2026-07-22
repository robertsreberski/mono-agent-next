import dns from "node:dns";
import { createServer, Server } from "node:http";
import { createConnection } from "node:net";

import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import {
  NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS,
  startWebhookAdapter,
  WebhookAdapterError,
  type WebhookAdapterStartResult,
} from "../index.js";

describe("Webhook adapter", () => {
  it("keeps the native callback policy exact and immutable", () => {
    expect(NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS).toEqual(["telegram", "slack"]);
    expect(Object.isFrozen(NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS)).toBe(true);
  });

  it("runs sync HTTP invocations through a structural responder", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request.metadata?.webhook);
        await stream.append(`echo: ${request.text}`);
        return { metadata: { ok: true } };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
    });

    try {
      const response = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", conversationId: "conversation-1", mode: "sync" }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "succeeded",
        conversationId: "conversation-1",
        text: "echo: hello",
        metadata: { ok: true },
      });
      expect(seen).toEqual([
        expect.objectContaining({
          mode: "sync",
          path: "/webhook/invoke",
          requestId: expect.any(String),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("requires the configured bearer token, protects status lookups, and strips secrets from request metadata", async () => {
    const apiKey = "fixture-webhook-key";
    const seenHeaders: unknown[] = [];
    const responderCalls: string[] = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const responder: AgentResponder = {
      async respond(request, stream) {
        responderCalls.push(request.text);
        seenHeaders.push(request.metadata?.webhook);
        await stream.append(`echo: ${request.text}`);
        return {};
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      apiKey,
      responder,
      logger,
    });

    try {
      const rejectedAuthorizationHeaders: readonly (string | undefined)[] = [
        undefined,
        "Bearer fixture-webhook-kex", // same length: exercises constant-time comparison
        "Bearer short", // different length: still fails without leaking which part differed
        `Basic ${apiKey}`,
        "Bearer   ",
        `Bearer ${apiKey} extra`,
      ];
      for (const authorization of rejectedAuthorizationHeaders) {
        const response = await fetch(server.invokeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: JSON.stringify({ text: "must not run", mode: "sync" }),
        });
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          status: "unauthorized",
          error: "Invalid API key.",
        });
      }
      expect(responderCalls).toEqual([]);

      const accepted = await fetch(server.invokeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          cookie: "session=fixture-cookie-secret",
          "set-cookie": "session=fixture-response-cookie-secret",
          "proxy-authorization": "Bearer fixture-proxy-secret",
          "x-api-key": "fixture-secondary-secret",
          "x-request-id": "safe-request-id",
        },
        body: JSON.stringify({ text: "authorized", mode: "async" }),
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = await accepted.json() as { requestId: string; statusUrl: string };
      expect(responderCalls).toEqual(["authorized"]);
      expect(seenHeaders).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({ "x-request-id": "safe-request-id" }),
        }),
      ]);
      expect(seenHeaders[0]).not.toHaveProperty("headers.authorization");
      expect(seenHeaders[0]).not.toHaveProperty("headers.cookie");
      expect(seenHeaders[0]).not.toHaveProperty("headers.set-cookie");
      expect(seenHeaders[0]).not.toHaveProperty("headers.proxy-authorization");
      expect(seenHeaders[0]).not.toHaveProperty("headers.x-api-key");

      const missingStatusAuth = await fetch(`${server.url}${acceptedBody.statusUrl}`);
      expect(missingStatusAuth.status).toBe(401);
      const wrongStatusAuth = await fetch(`${server.url}${acceptedBody.statusUrl}`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(wrongStatusAuth.status).toBe(401);
      const authorizedStatus = await fetch(`${server.url}${acceptedBody.statusUrl}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(authorizedStatus.status).toBe(200);

      const logged = JSON.stringify(Object.values(logger).map((mock) => mock.mock.calls));
      expect(logged).not.toContain(apiKey);
      expect(logged).not.toContain("fixture-cookie-secret");
      expect(logged).not.toContain("fixture-response-cookie-secret");
      expect(logged).not.toContain("fixture-proxy-secret");
      expect(logged).not.toContain("fixture-secondary-secret");
    } finally {
      await server.stop();
    }
  });

  it("authenticates protected invocations before parsing malformed or oversized JSON", async () => {
    const responder = {
      respond: vi.fn(async () => ({ text: "must not run" })),
    } satisfies AgentResponder;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      apiKey: "fixture-webhook-key",
      responder,
      logger,
    });
    const malformedBody = '{"text":';
    const oversizedBody = JSON.stringify({ text: "x".repeat(1_048_576) });

    try {
      for (const body of [malformedBody, oversizedBody]) {
        for (const authorization of [undefined, "Bearer wrong-key"]) {
          const response = await fetch(server.invokeUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization === undefined ? {} : { authorization }),
            },
            body,
          });
          expect(response.status).toBe(401);
          await expect(response.json()).resolves.toEqual({
            status: "unauthorized",
            error: "Invalid API key.",
          });
        }
      }

      for (const body of [malformedBody, oversizedBody]) {
        const authorized = await fetch(server.invokeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fixture-webhook-key",
          },
          body,
        });
        expect(authorized.status).toBe(400);
        await expect(authorized.json()).resolves.toMatchObject({ status: "failed" });
      }

      expect(responder.respond).not.toHaveBeenCalled();
      expect(Object.values(logger).flatMap((mock) => mock.mock.calls)).toEqual([]);
    } finally {
      await server.stop();
    }

    const keyless = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: echoResponder(),
    });
    try {
      const response = await fetch(keyless.invokeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: malformedBody,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    } finally {
      await keyless.stop();
    }
  });

  it("preserves unauthenticated loopback compatibility when no API key is configured", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: echoResponder(),
    });

    try {
      const response = await fetch(server.invokeUrl, postJson({ text: "compatible", mode: "sync" }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "echo: compatible" });
    } finally {
      await server.stop();
    }
  });

  it("strips an unsafe responder system prompt from sync HTTP without changing unrelated metadata", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.append("safe response");
        return {
          metadata: {
            summary: {
              status: "succeeded",
              runId: "run-1",
              systemPrompt: "private compiled prompt",
              diagnostics: {
                systemPrompt: "unrelated nested value",
                nested: {
                  retained: true,
                  toJSON() {
                    return { systemPrompt: "nested serialization bypass" };
                  },
                },
              },
              toJSON() {
                return { systemPrompt: "summary serialization bypass" };
              },
            },
            trace: { systemPrompt: "unrelated metadata value" },
          },
        };
      },
    };
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });

    try {
      const response = await fetch(`${server.invokeUrl}`, postJson({ text: "hello", mode: "sync" }));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        metadata?: {
          summary?: Record<string, unknown>;
          trace?: Record<string, unknown>;
        };
      };
      expect(body.metadata?.summary).toEqual({
        status: "succeeded",
        runId: "run-1",
        diagnostics: {
          systemPrompt: "unrelated nested value",
          nested: { retained: true },
        },
      });
      expect(body.metadata?.summary).not.toHaveProperty("systemPrompt");
      expect(body.metadata?.trace).toEqual({ systemPrompt: "unrelated metadata value" });
    } finally {
      await server.stop();
    }
  });

  it.each([
    {
      shape: "array",
      summary: () => Object.assign([], {
        toJSON() {
          return { systemPrompt: "array serialization bypass" };
        },
      }),
    },
    {
      shape: "function",
      summary: () => Object.assign(() => undefined, {
        toJSON() {
          return { systemPrompt: "function serialization bypass" };
        },
      }),
    },
    { shape: "primitive", summary: () => "not-a-summary-object" },
  ])("drops a malformed $shape responder summary instead of serializing it", async ({ summary }) => {
    const responder: AgentResponder = {
      async respond() {
        return {
          text: "safe response",
          metadata: {
            summary: summary(),
            retained: { safe: true },
          },
        };
      },
    };
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });

    try {
      const response = await fetch(`${server.invokeUrl}`, postJson({ text: "hello", mode: "sync" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "succeeded",
        metadata: { retained: { safe: true } },
      });
      expect(body).not.toHaveProperty("metadata.summary");
    } finally {
      await server.stop();
    }
  });

  it("includes native notify metadata and reports completed runs", async () => {
    const seen: unknown[] = [];
    const results: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request);
        await stream.append(`digest: ${request.text}`);
        return {};
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        {
          name: "digest",
          path: "/digest",
          mode: "sync",
          notify: true,
          notifyConversationId: "telegram:42",
        },
      ],
      responder,
      onResult: (status, request) => {
        results.push({ status, webhook: request.metadata.webhook });
      },
    });

    try {
      const response = await fetch(`${server.url}/digest`, postJson({ text: "payload", conversationId: "c1", mode: "sync" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "digest: payload" });
      expect(seen).toEqual([
        expect.objectContaining({
          conversationId: "c1",
          replyTo: { conversationId: "telegram:42" },
          metadata: {
            webhook: expect.objectContaining({
              endpointName: "digest",
              nativeNotify: { enabled: true, conversationId: "telegram:42" },
            }),
          },
        }),
      ]);
      expect(results).toEqual([
        expect.objectContaining({
          status: expect.objectContaining({ status: "succeeded", text: "digest: payload" }),
          webhook: expect.objectContaining({ endpointName: "digest" }),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("snapshots each inferred route before a mid-invocation candidate change", async () => {
    const seen: unknown[] = [];
    const completed: unknown[] = [];
    let candidates = ["slack:C1"];
    let resolutionCount = 0;
    const resolveNotifyFallbackConversationId = vi.fn(async () => {
      const resolved = candidates.length === 1 ? candidates[0] : undefined;
      if (resolutionCount === 0) {
        // The allowlist changes after this invocation selects C1 but before the
        // responder starts. The request must keep the selected route.
        candidates = ["slack:C1", "slack:C2"];
      }
      resolutionCount += 1;
      return resolved;
    });
    const responder: AgentResponder = {
      async respond(request) {
        seen.push(request.replyTo);
        return { text: "digest" };
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{ name: "digest", path: "/digest", mode: "sync", notify: true }],
      responder,
      resolveNotifyFallbackConversationId,
      onResult: (_status, request) => {
        completed.push(request.replyTo);
      },
    });

    try {
      const first = await fetch(
        `${server.url}/digest`,
        postJson({ text: "first", conversationId: "logical:first", mode: "sync" }),
      );
      expect(first.status).toBe(200);
      expect(seen[0]).toEqual({ conversationId: "slack:C1" });
      expect(completed[0]).toEqual({ conversationId: "slack:C1" });

      const second = await fetch(
        `${server.url}/digest`,
        postJson({ text: "second", conversationId: "logical:second", mode: "sync" }),
      );
      expect(second.status).toBe(200);
      expect(seen[1]).toBeUndefined();
      expect(completed[1]).toBeUndefined();
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["rewrites a selected route", "rewrite", "slack:C1"],
    ["deletes a selected route", "delete", "slack:C1"],
    ["injects a route when none was selected", "inject", undefined],
  ] as const)(
    "keeps the completion route private when the responder %s",
    async (_label, tamper, selectedRoute) => {
      let responderRequest: object | undefined;
      let completionRequest: object | undefined;
      let routeBeforeTampering: string | undefined;
      let onResultCallCount = 0;
      const deliveredRoutes: string[] = [];
      const responder: AgentResponder = {
        async respond(request) {
          responderRequest = request;
          routeBeforeTampering = request.replyTo?.conversationId;
          const mutableRequest = request as { replyTo?: { conversationId: string } };
          if (tamper === "rewrite" && mutableRequest.replyTo !== undefined) {
            mutableRequest.replyTo.conversationId = "slack:C2";
          } else if (tamper === "delete") {
            delete mutableRequest.replyTo;
          } else if (tamper === "inject") {
            mutableRequest.replyTo = { conversationId: "slack:C-INJECTED" };
          }
          return { text: "digest" };
        },
      };
      const server = await startWebhookAdapter({
        host: "127.0.0.1",
        port: 0,
        endpoints: [{ name: "digest", path: "/digest", mode: "sync", notify: true }],
        responder,
        resolveNotifyFallbackConversationId: async () => selectedRoute,
        onResult: (status, request) => {
          onResultCallCount += 1;
          completionRequest = request;
          if (status.status === "succeeded" && request.replyTo !== undefined) {
            deliveredRoutes.push(request.replyTo.conversationId);
          }
        },
      });

      try {
        const response = await fetch(
          `${server.url}/digest`,
          postJson({ text: "payload", conversationId: "logical:digest", mode: "sync" }),
        );
        expect(response.status).toBe(200);
        expect(responderRequest).toBeDefined();
        expect(completionRequest).toBeDefined();
        expect(onResultCallCount).toBe(1);
        expect(routeBeforeTampering).toBe(selectedRoute);
        expect(completionRequest).not.toBe(responderRequest);
        if (selectedRoute === undefined) {
          expect(completionRequest).not.toHaveProperty("replyTo");
          expect(deliveredRoutes).toEqual([]);
        } else {
          expect(completionRequest).toHaveProperty("replyTo.conversationId", "slack:C1");
          expect(deliveredRoutes).toEqual(["slack:C1"]);
        }
      } finally {
        await server.stop();
      }
    },
  );

  it("preserves route precedence and contains live resolver rejection", async () => {
    const seen = new Map<string, unknown>();
    const warn = vi.fn();
    const resolveNotifyFallbackConversationId = vi.fn(async () => {
      throw new Error("destination lookup failed");
    });
    const responder: AgentResponder = {
      async respond(request) {
        const endpointName = (request.metadata as { webhook: { endpointName: string } }).webhook.endpointName;
        seen.set(endpointName, request.replyTo);
        return { text: endpointName };
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        {
          name: "explicit",
          path: "/explicit",
          mode: "sync",
          notify: true,
          notifyConversationId: "slack:C-EXPLICIT",
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        {
          name: "request",
          path: "/request",
          mode: "sync",
          notify: true,
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        {
          name: "fallback",
          path: "/fallback",
          mode: "sync",
          notify: true,
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        { name: "dynamic", path: "/dynamic", mode: "sync", notify: true },
      ],
      responder,
      resolveNotifyFallbackConversationId,
      logger: { warn },
    });

    try {
      const explicit = await fetch(
        `${server.url}/explicit`,
        postJson({ text: "p", conversationId: "slack:C-REQUEST", mode: "sync" }),
      );
      const request = await fetch(
        `${server.url}/request`,
        postJson({ text: "p", conversationId: "slack:C-REQUEST", mode: "sync" }),
      );
      const fallback = await fetch(
        `${server.url}/fallback`,
        postJson({ text: "p", conversationId: "logical:fallback", mode: "sync" }),
      );
      const dynamic = await fetch(
        `${server.url}/dynamic`,
        postJson({ text: "p", conversationId: "logical:dynamic", mode: "sync" }),
      );

      expect([explicit.status, request.status, fallback.status, dynamic.status]).toEqual([200, 200, 200, 200]);
      expect(seen.get("explicit")).toEqual({ conversationId: "slack:C-EXPLICIT" });
      expect(seen.get("request")).toEqual({ conversationId: "slack:C-REQUEST" });
      expect(seen.get("fallback")).toEqual({ conversationId: "slack:C-FALLBACK" });
      expect(seen.has("dynamic")).toBe(true);
      expect(seen.get("dynamic")).toBeUndefined();
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Webhook native-notify destination resolution failed; running without a reply target.",
        { endpointName: "dynamic", error: "destination lookup failed" },
      );
    } finally {
      await server.stop();
    }
  });

  it("prefers a native callback request conversation and excludes WhatsApp", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request.replyTo);
        await stream.append("ok");
        return {};
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{
        name: "callback",
        path: "/callback",
        mode: "sync",
        notify: true,
        notifyFallbackConversationId: "slack:C-FALLBACK",
      }],
      responder,
    });

    try {
      const response = await fetch(
        `${server.url}/callback`,
        postJson({ text: "payload", conversationId: "slack:C-REQUEST", mode: "sync" }),
      );
      expect(response.status).toBe(200);
      const whatsappResponse = await fetch(
        `${server.url}/callback`,
        postJson({ text: "payload", conversationId: "whatsapp:123@s.whatsapp.net", mode: "sync" }),
      );
      expect(whatsappResponse.status).toBe(200);
      expect(seen).toEqual([
        { conversationId: "slack:C-REQUEST" },
        { conversationId: "slack:C-FALLBACK" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("carries endpoint model/effort and lets the request body override them", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request.metadata?.webhook);
        await stream.append("ok");
        return {};
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        {
          name: "delegate",
          path: "/delegate",
          mode: "sync",
          model: "claude:claude-sonnet-4-6",
          effort: "low",
        },
      ],
      responder,
    });

    try {
      // Request body model/effort win over the endpoint defaults (delegate use case).
      await fetch(
        `${server.url}/delegate`,
        postJson({ text: "deep research", conversationId: "c1", mode: "sync", model: "claude:claude-opus-4-8", effort: "high" }),
      );
      // No body override: endpoint defaults apply.
      await fetch(`${server.url}/delegate`, postJson({ text: "quick", conversationId: "c2", mode: "sync" }));

      expect(seen).toEqual([
        expect.objectContaining({ model: "claude:claude-opus-4-8", effort: "high" }),
        expect.objectContaining({ model: "claude:claude-sonnet-4-6", effort: "low" }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("logs and contains rejected async onResult hooks", async () => {
    const logger = { warn: vi.fn() };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
      logger,
      onResult: async () => {
        await Promise.resolve();
        throw new Error("async hook failure");
      },
    });

    try {
      const response = await invokeSync(server.url, "payload", "conversation-hook");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "echo: payload" });
      await expect.poll(() => logger.warn.mock.calls.length).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Webhook onResult callback failed.",
        expect.objectContaining({
          conversationId: "conversation-hook",
          error: "async hook failure",
        }),
      );
    } finally {
      await server.stop();
    }
  });

  it("accepts async invocations and exposes in-memory request status", async () => {
    let finish!: () => void;
    let onResultStatus: unknown;
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await stream.append("async done");
        return {
          metadata: {
            summary: {
              status: "succeeded",
              runId: "async-run",
              systemPrompt: "private async prompt",
              cost: { totalUsd: 0.01 },
            },
            custom: { retained: true },
            toJSON() {
              return { summary: { systemPrompt: "metadata serialization bypass" } };
            },
          },
        };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
      onResult: (status) => {
        onResultStatus = structuredClone(status);
        if (status.status === "succeeded") {
          const custom = status.metadata?.custom;
          if (custom !== null && typeof custom === "object" && !Array.isArray(custom)) {
            (custom as Record<string, unknown>).retained = false;
          }
          const summary = status.metadata?.summary;
          if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
            (summary as Record<string, unknown>).systemPrompt = "mutation through onResult";
            const cost = (summary as Record<string, unknown>).cost;
            if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
              (cost as Record<string, unknown>).totalUsd = 999;
            }
          }
        }
      },
    });

    try {
      const accepted = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "background", mode: "async" }),
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = await accepted.json() as { requestId: string; statusUrl: string };
      expect(acceptedBody).toMatchObject({
        requestId: expect.any(String),
        status: "accepted",
        statusUrl: expect.stringContaining(`/webhook/requests/${acceptedBody.requestId}`),
      });

      const running = await fetch(`${server.url}${acceptedBody.statusUrl}`);
      expect(running.status).toBe(200);
      await expect(running.json()).resolves.toMatchObject({ status: "running" });

      finish();

      let statusBody: unknown;
      await expect.poll(async () => {
        const response = await fetch(`${server.url}${acceptedBody.statusUrl}`);
        statusBody = await response.json();
        return statusBody;
      }).toMatchObject({
        status: "succeeded",
        text: "async done",
        metadata: {
          summary: {
            status: "succeeded",
            runId: "async-run",
            cost: { totalUsd: 0.01 },
          },
          custom: { retained: true },
        },
      });

      expect(statusBody).not.toHaveProperty("metadata.summary.systemPrompt");
      expect(onResultStatus).toMatchObject({
        status: "succeeded",
        metadata: { summary: { runId: "async-run" }, custom: { retained: true } },
      });
      expect(onResultStatus).not.toHaveProperty("metadata.summary.systemPrompt");

      const programmaticStatus = server.getStatus(acceptedBody.requestId);
      expect(programmaticStatus).not.toHaveProperty("metadata.summary.systemPrompt");
      if (programmaticStatus?.status === "succeeded") {
        const summary = programmaticStatus.metadata?.summary;
        if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
          (summary as Record<string, unknown>).systemPrompt = "mutation through getStatus";
          const cost = (summary as Record<string, unknown>).cost;
          if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
            (cost as Record<string, unknown>).totalUsd = 777;
          }
        }
        const custom = programmaticStatus.metadata?.custom;
        if (custom !== null && typeof custom === "object" && !Array.isArray(custom)) {
          (custom as Record<string, unknown>).retained = false;
        }
      }

      const afterMutation = await fetch(`${server.url}${acceptedBody.statusUrl}`);
      const afterMutationBody = await afterMutation.json();
      expect(afterMutationBody).not.toHaveProperty("metadata.summary.systemPrompt");
      expect(afterMutationBody).toMatchObject({
        metadata: {
          summary: { cost: { totalUsd: 0.01 } },
          custom: { retained: true },
        },
      });
      expect(server.getStatus(acceptedBody.requestId)).toMatchObject({
        metadata: {
          summary: { cost: { totalUsd: 0.01 } },
          custom: { retained: true },
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("returns busy for concurrent active requests with the same conversation id", async () => {
    let finish!: () => void;
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
    });

    try {
      const first = fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "first", conversationId: "same", mode: "sync" }),
      });

      await expect.poll(async () => server.activeRequestCount).toBe(1);

      const second = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "second", conversationId: "same", mode: "sync" }),
      });

      expect(second.status).toBe(409);
      await expect(second.json()).resolves.toMatchObject({ status: "busy", conversationId: "same" });

      finish();
      await expect(first).resolves.toMatchObject({ status: 200 });
    } finally {
      await server.stop();
    }
  });

  it("derives the status base path from the invoke path's parent directory", async () => {
    const nested = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
    });
    try {
      expect(nested.statusBasePath).toBe("/webhook/requests");
      expect(nested.invokeUrl).toBe(`${nested.url}/webhook/invoke`);
    } finally {
      await nested.stop();
    }

    const topLevel = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/invoke",
      responder: echoResponder(),
    });
    try {
      expect(topLevel.statusBasePath).toBe("/requests");
    } finally {
      await topLevel.stop();
    }
  });

  it("prunes stored statuses once the per-request cap is exceeded", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      maxStoredRequests: 1,
      responder: echoResponder(),
    });

    try {
      const first = await invokeSync(server.url, "first", "conversation-a");
      expect(first.status).toBe(200);
      const firstId = (await first.json() as { requestId: string }).requestId;
      expect(server.getStatus(firstId)).toBeDefined();

      const second = await invokeSync(server.url, "second", "conversation-b");
      expect(second.status).toBe(200);
      const secondId = (await second.json() as { requestId: string }).requestId;

      // Oldest entry is evicted to honour maxStoredRequests: 1.
      expect(server.getStatus(secondId)).toBeDefined();
      expect(server.getStatus(firstId)).toBeUndefined();

      const lookup = await fetch(`${server.url}${server.statusBasePath}/${firstId}`);
      expect(lookup.status).toBe(404);
      await expect(lookup.json()).resolves.toMatchObject({ status: "not_found" });
    } finally {
      await server.stop();
    }
  });

  it("prunes stored statuses once they age past the retention window", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      retentionMs: 1,
      responder: echoResponder(),
    });

    try {
      const stored = await invokeSync(server.url, "ephemeral", "conversation-ttl");
      expect(stored.status).toBe(200);
      const requestId = (await stored.json() as { requestId: string }).requestId;

      await new Promise((resolve) => setTimeout(resolve, 10));

      // A status lookup triggers a prune of the now-expired entry.
      const lookup = await fetch(`${server.url}${server.statusBasePath}/${requestId}`);
      expect(lookup.status).toBe(404);
      expect(server.getStatus(requestId)).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("aborts the responder when a sync client disconnects", async () => {
    let abortObserved!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((_resolve, reject) => {
          request.abortSignal.addEventListener("abort", () => {
            abortObserved();
            reject(new Error("aborted by client"));
          });
        });
        return {};
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
    });

    try {
      const controller = new AbortController();
      const pending = fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hang", conversationId: "conversation-abort", mode: "sync" }),
        signal: controller.signal,
      });
      const settled = pending.catch(() => undefined);

      await expect.poll(async () => server.activeRequestCount).toBe(1);
      controller.abort();

      await abortSeen;
      await settled;
      await expect.poll(async () => server.activeRequestCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("aborts hung destination resolution on client disconnect without maxRunMs and reclaims the slot", async () => {
    let settleFirstResolver!: (value: string | undefined) => void;
    const firstResolver = new Promise<string | undefined>((resolve) => {
      settleFirstResolver = resolve;
    });
    const resolverSignals: AbortSignal[] = [];
    let resolverCallCount = 0;
    const resolveNotifyFallbackConversationId = vi.fn((abortSignal?: AbortSignal) => {
      if (abortSignal !== undefined) {
        resolverSignals.push(abortSignal);
      }
      resolverCallCount += 1;
      return resolverCallCount === 1 ? firstResolver : Promise.resolve("slack:C-SECOND");
    });
    const responder = {
      respond: vi.fn(async (request) => ({
        text: request.replyTo?.conversationId ?? "no route",
      })),
    } satisfies AgentResponder;
    const completed: Array<{ status: string; conversationId: string }> = [];
    const onResult = vi.fn((status: { status: string; conversationId: string }) => {
      completed.push(status);
    });
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{ name: "notify", path: "/notify", mode: "sync", notify: true }],
      responder,
      resolveNotifyFallbackConversationId,
      onResult: (status) => onResult(status),
    });

    try {
      const controller = new AbortController();
      const first = fetch(`${server.url}/notify`, {
        ...postJson({ text: "first", conversationId: "logical:same", mode: "sync" }),
        signal: controller.signal,
      });
      const firstSettled = first.catch(() => undefined);

      await expect.poll(() => server.activeRequestCount).toBe(1);
      await expect.poll(() => resolveNotifyFallbackConversationId.mock.calls.length).toBe(1);
      controller.abort();
      await firstSettled;

      await expect.poll(() => server.activeRequestCount).toBe(0);
      await expect
        .poll(() => completed)
        .toContainEqual(expect.objectContaining({
          status: "cancelled",
          conversationId: "logical:same",
        }));
      expect(resolverSignals[0]?.aborted).toBe(true);

      // The same endpoint/conversation can start again immediately; its fresh
      // resolution and responder are not blocked by the discarded resolver.
      const second = await fetch(
        `${server.url}/notify`,
        postJson({ text: "second", conversationId: "logical:same", mode: "sync" }),
      );
      expect(second.status).toBe(200);
      expect(responder.respond).toHaveBeenCalledOnce();
      expect(responder.respond.mock.calls[0]?.[0]).toHaveProperty(
        "replyTo.conversationId",
        "slack:C-SECOND",
      );

      // Late settlement of the first resolver cannot start another responder
      // or emit a second terminal result for the disconnected request.
      settleFirstResolver("slack:C-STALE");
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).toHaveBeenCalledOnce();
      expect(onResult).toHaveBeenCalledTimes(2);
      expect(completed.filter((status) => status.status === "cancelled")).toHaveLength(1);
      expect(completed.filter((status) => status.status === "succeeded")).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("observes a resolver that reentrantly stops the adapter before returning a late rejection", async () => {
    let rejectDiscardedResolver!: (error: Error) => void;
    const discardedResolver = new Promise<string | undefined>((_resolve, reject) => {
      rejectDiscardedResolver = reject;
    });
    const thenSpy = vi.spyOn(discardedResolver, "then");
    const responder = {
      respond: vi.fn(async () => ({ text: "unexpected" })),
    } satisfies AgentResponder;
    const completed: Array<{ status: string }> = [];
    const onResult = vi.fn((status: { status: string }) => {
      completed.push(status);
    });
    let server!: Awaited<ReturnType<typeof startWebhookAdapter>>;
    let stopPromise: Promise<void> | undefined;
    let resolverCallCount = 0;
    const resolveNotifyFallbackConversationId = (): Promise<string | undefined> => {
      resolverCallCount += 1;
      // stop() aborts the current request synchronously before its first await,
      // so the resolver race receives an already-aborted signal.
      stopPromise = server.stop();
      return discardedResolver;
    };
    server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{ name: "notify", path: "/notify", mode: "async", notify: true }],
      responder,
      resolveNotifyFallbackConversationId,
      onResult: (status) => onResult(status),
    });

    try {
      const accepted = await fetch(
        `${server.url}/notify`,
        postJson({ text: "stop", conversationId: "logical:stop", mode: "async" }),
      );
      expect(accepted.status).toBe(202);
      await expect.poll(() => completed).toContainEqual(expect.objectContaining({ status: "cancelled" }));
      expect(stopPromise).toBeDefined();
      await stopPromise;

      expect(resolverCallCount).toBe(1);
      expect(thenSpy).toHaveBeenCalledOnce();
      expect(responder.respond).not.toHaveBeenCalled();
      expect(server.activeRequestCount).toBe(0);
      expect(onResult).toHaveBeenCalledOnce();

      rejectDiscardedResolver(new Error("late discarded resolver rejection"));
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).not.toHaveBeenCalled();
      expect(onResult).toHaveBeenCalledOnce();
    } finally {
      if (stopPromise === undefined) {
        await server.stop();
      } else {
        await stopPromise;
      }
    }
  });

  it("returns 400 for a malformed JSON body via the express error handler", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["non-object body", "[]"],
    ["missing text", JSON.stringify({ conversationId: "c" })],
    ["blank text", JSON.stringify({ text: "   " })],
    ["invalid mode", JSON.stringify({ text: "hi", mode: "fire-and-forget" })],
  ])("returns 500 with a failed status for a semantically invalid body (%s)", async (_label, body) => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    } finally {
      await server.stop();
    }
  });

  it("rejects non-loopback binds unless explicitly allowed", async () => {
    await expect(
      startWebhookAdapter({
        host: "0.0.0.0",
        port: 0,
        path: "/webhook/invoke",
        responder: { async respond() { return { text: "ok" }; } },
      }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it("rejects an explicitly allowed non-loopback bind without bearer auth", async () => {
    await expect(
      startWebhookAdapter({
        host: "0.0.0.0",
        port: 0,
        allowNonLoopback: true,
        path: "/webhook/invoke",
        responder: echoResponder(),
      }),
    ).rejects.toMatchObject({ code: "missing_required_config" });
  });

  it("closes a non-loopback actual bind when localhost resolution has no exposure consent", async () => {
    const originalLookup = dns.lookup;
    let unexpectedServer: WebhookAdapterStartResult | undefined;
    let rejection: unknown;
    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    try {
      try {
        unexpectedServer = await startWebhookAdapter({
          host: "localhost",
          port: 0,
          apiKey: "fixture-key-without-exposure-consent",
          responder: echoResponder(),
        });
      } catch (error) {
        rejection = error;
      }
    } finally {
      await unexpectedServer?.stop();
      dns.lookup = originalLookup;
    }
    expect(rejection).toMatchObject({
      code: "unsafe_host",
      details: {
        host: "localhost",
        boundAddress: expect.stringMatching(/^(?:0\.0\.0\.0|::)$/u),
        boundPort: expect.any(Number),
      },
    });
    if (!(rejection instanceof WebhookAdapterError)
      || typeof rejection.details.boundPort !== "number") {
      throw new Error("Expected rejected webhook bind details to include the kernel-selected port.");
    }
    await expectPortReusable(rejection.details.boundPort);
  });

  it("closes a consented non-loopback actual bind when no API key is configured", async () => {
    const originalLookup = dns.lookup;
    let unexpectedServer: WebhookAdapterStartResult | undefined;
    let rejection: unknown;
    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    try {
      try {
        unexpectedServer = await startWebhookAdapter({
          host: "localhost",
          port: 0,
          allowNonLoopback: true,
          responder: echoResponder(),
        });
      } catch (error) {
        rejection = error;
      }
    } finally {
      await unexpectedServer?.stop();
      dns.lookup = originalLookup;
    }
    expect(rejection).toMatchObject({
      code: "missing_required_config",
      details: {
        host: "localhost",
        boundAddress: expect.stringMatching(/^(?:0\.0\.0\.0|::)$/u),
        boundPort: expect.any(Number),
      },
    });
    if (!(rejection instanceof WebhookAdapterError)
      || typeof rejection.details.boundPort !== "number") {
      throw new Error("Expected rejected webhook bind details to include the kernel-selected port.");
    }
    await expectPortReusable(rejection.details.boundPort);
  });

  it("accepts a keyed non-loopback actual bind without weakening auth or header redaction", async () => {
    const apiKey = "fixture-resolved-bind-key";
    const seenHeaders: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seenHeaders.push(request.metadata?.webhook);
        await stream.append("resolved bind ok");
        return {};
      },
    };
    const originalLookup = dns.lookup;
    let server: WebhookAdapterStartResult | undefined;
    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    try {
      server = await startWebhookAdapter({
        host: "localhost",
        port: 0,
        allowNonLoopback: true,
        apiKey,
        responder,
      });
      const invokeUrl = `http://127.0.0.1:${server.port}/webhook/invoke`;
      const unauthorizedResponses = [
        await fetch(invokeUrl, postJson({ text: "missing auth" })),
        await fetch(invokeUrl, {
          ...postJson({ text: "wrong auth" }),
          headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        }),
      ];
      for (const response of unauthorizedResponses) {
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          status: "unauthorized",
          error: "Invalid API key.",
        });
      }

      const accepted = await fetch(invokeUrl, {
        ...postJson({ text: "authorized" }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          cookie: "session=fixture-cookie-secret",
          "set-cookie": "session=fixture-response-cookie-secret",
          "proxy-authorization": "Bearer fixture-proxy-secret",
          "x-api-key": "fixture-secondary-secret",
          "x-request-id": "safe-resolved-bind-request",
        },
      });
      expect(accepted.status).toBe(200);
      expect(seenHeaders).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({ "x-request-id": "safe-resolved-bind-request" }),
        }),
      ]);
      expect(seenHeaders[0]).not.toHaveProperty("headers.authorization");
      expect(seenHeaders[0]).not.toHaveProperty("headers.cookie");
      expect(seenHeaders[0]).not.toHaveProperty("headers.set-cookie");
      expect(seenHeaders[0]).not.toHaveProperty("headers.proxy-authorization");
      expect(seenHeaders[0]).not.toHaveProperty("headers.x-api-key");
    } finally {
      await server?.stop();
      dns.lookup = originalLookup;
    }
  });

  it("enforces bearer auth on an explicitly allowed non-loopback bind", async () => {
    const server = await startWebhookAdapter({
      host: "0.0.0.0",
      port: 0,
      allowNonLoopback: true,
      apiKey: "fixture-non-loopback-key",
      path: "/webhook/invoke",
      responder: echoResponder(),
    });
    const invokeUrl = `http://127.0.0.1:${server.port}/webhook/invoke`;

    try {
      const missing = await fetch(invokeUrl, postJson({ text: "missing", mode: "sync" }));
      expect(missing.status).toBe(401);

      const incorrect = await fetch(invokeUrl, {
        ...postJson({ text: "incorrect", mode: "sync" }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-key",
        },
      });
      expect(incorrect.status).toBe(401);

      const correct = await fetch(invokeUrl, {
        ...postJson({ text: "authorized", mode: "sync" }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture-non-loopback-key",
        },
      });
      expect(correct.status).toBe(200);
      await expect(correct.json()).resolves.toMatchObject({ status: "succeeded", text: "echo: authorized" });
    } finally {
      await server.stop();
    }
  });

  it("rejects queued startup requests before responder admission and force-closes slow connections", async () => {
    const originalLookup = dns.lookup;
    const originalClose = Server.prototype.close;
    let queuedResponse: Promise<string> | undefined;
    let slowConnectionClosed: Promise<void> | undefined;
    let queuedConnection: ReturnType<typeof createConnection> | undefined;
    let slowConnection: ReturnType<typeof createConnection> | undefined;
    let responderCalls = 0;
    let rejected: unknown;
    let unexpectedServer: Awaited<ReturnType<typeof startWebhookAdapter>> | undefined;

    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    Server.prototype.close = function (this: Server, callback?: (error?: Error) => void): Server {
      const address = this.address();
      if (typeof address !== "object" || address === null) {
        throw new TypeError("Expected the intercepted server to have a TCP address.");
      }

      const body = JSON.stringify({ text: "queued", conversationId: "queued-race", mode: "sync" });
      const queued = createConnection({ host: "127.0.0.1", port: address.port });
      queuedConnection = queued;
      let responseText = "";
      queuedResponse = new Promise<string>((resolvePromise, rejectPromise) => {
        queued.on("data", (chunk: Buffer) => {
          responseText += chunk.toString("utf8");
        });
        queued.once("close", () => resolvePromise(responseText));
        queued.once("error", rejectPromise);
      });
      void queuedResponse.catch(() => undefined);
      const queuedConnected = new Promise<void>((resolvePromise, rejectPromise) => {
        queued.once("connect", () => {
          queued.write([
            "POST /webhook/invoke HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            "Connection: close",
            `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
            "",
            body,
          ].join("\r\n"), (error?: Error | null) => {
            if (error !== undefined && error !== null) {
              rejectPromise(error);
              return;
            }
            resolvePromise();
          });
        });
        queued.once("error", rejectPromise);
      });

      const slow = createConnection({ host: "127.0.0.1", port: address.port });
      slowConnection = slow;
      slowConnectionClosed = new Promise<void>((resolvePromise) => {
        slow.once("close", () => resolvePromise());
      });
      const slowConnected = new Promise<void>((resolvePromise, rejectPromise) => {
        slow.once("connect", () => {
          slow.write([
            "POST /webhook/invoke HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            "Connection: close",
            "Content-Length: 1000000",
            "",
            "{",
          ].join("\r\n"), (error?: Error | null) => {
            if (error !== undefined && error !== null) {
              rejectPromise(error);
              return;
            }
            resolvePromise();
          });
        });
        slow.once("error", rejectPromise);
      });

      void Promise.all([queuedConnected, slowConnected, queuedResponse])
        .catch(() => undefined)
        .finally(() => {
          originalClose.call(this, callback);
        });
      return this;
    } as typeof Server.prototype.close;

    try {
      unexpectedServer = await startWebhookAdapter({
        host: "localhost",
        port: 0,
        path: "/webhook/invoke",
        responder: {
          async respond() {
            responderCalls += 1;
            return { text: "unexpected" };
          },
        },
      });
    } catch (error) {
      rejected = error;
    } finally {
      dns.lookup = originalLookup;
      Server.prototype.close = originalClose;
      queuedConnection?.destroy();
      slowConnection?.destroy();
      await unexpectedServer?.stop();
    }

    expect(unexpectedServer).toBeUndefined();
    expect(rejected).toMatchObject({
      code: "unsafe_host",
      details: {
        host: "localhost",
        boundAddress: "0.0.0.0",
        boundPort: expect.any(Number),
      },
    });
    expect(responderCalls).toBe(0);
    if (queuedResponse === undefined || slowConnectionClosed === undefined) {
      throw new TypeError("Expected rejected-bind cleanup to create both race connections.");
    }
    const queuedResponseText = await queuedResponse;
    expect(queuedResponseText).toContain("HTTP/1.1 503 Service Unavailable");
    expect(queuedResponseText).toContain("Webhook adapter is stopping before request admission.");
    await slowConnectionClosed;

    const boundPort = rejectedBoundPort(rejected);
    const permitted = await startWebhookAdapter({
      host: "0.0.0.0",
      port: boundPort,
      allowNonLoopback: true,
      apiKey: "fixture-port-reuse-key",
      path: "/webhook/invoke",
      responder: echoResponder(),
    });
    try {
      expect(permitted.port).toBe(boundPort);
    } finally {
      await permitted.stop();
    }
  });

  it("preserves unsafe_host and retries cleanup when the first close callback errors", async () => {
    const originalLookup = dns.lookup;
    const originalClose = Server.prototype.close;
    let closeCalls = 0;
    let rejected: unknown;
    let unexpectedServer: Awaited<ReturnType<typeof startWebhookAdapter>> | undefined;

    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    Server.prototype.close = function (this: Server, callback?: (error?: Error) => void): Server {
      closeCalls += 1;
      if (closeCalls === 1) {
        queueMicrotask(() => callback?.(new Error("synthetic rejected-server close failure")));
        return this;
      }
      return originalClose.call(this, callback);
    } as typeof Server.prototype.close;

    try {
      unexpectedServer = await startWebhookAdapter({
        host: "localhost",
        port: 0,
        path: "/webhook/invoke",
        responder: echoResponder(),
      });
    } catch (error) {
      rejected = error;
    } finally {
      dns.lookup = originalLookup;
      Server.prototype.close = originalClose;
      await unexpectedServer?.stop();
    }

    expect(unexpectedServer).toBeUndefined();
    expect(closeCalls).toBe(2);
    expect(rejected).toMatchObject({
      code: "unsafe_host",
      details: {
        host: "localhost",
        boundAddress: "0.0.0.0",
        boundPort: expect.any(Number),
      },
    });

    const boundPort = rejectedBoundPort(rejected);
    const permitted = await startWebhookAdapter({
      host: "0.0.0.0",
      port: boundPort,
      allowNonLoopback: true,
      apiKey: "fixture-port-reuse-key",
      path: "/webhook/invoke",
      responder: echoResponder(),
    });
    try {
      expect(permitted.port).toBe(boundPort);
    } finally {
      await permitted.stop();
    }
  });

  it("aborts a hung async run at maxRunMs and reclaims the conversation slot", async () => {
    let resolveResult: ((status: { status: string; error?: string }) => void) | undefined;
    const resultPromise = new Promise<{ status: string; error?: string }>((resolve) => {
      resolveResult = resolve;
    });
    // A responder that never settles AND ignores the abort signal: the runaway
    // case the cron-style watchdog must reclaim. async mode has no client to
    // disconnect, so the max-run bound is its only escape.
    const hangingResponder: AgentResponder = { respond: () => new Promise<never>(() => {}) };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      defaultMode: "async",
      maxRunMs: 100,
      responder: hangingResponder,
      onResult: (status) => { resolveResult?.(status as { status: string; error?: string }); },
    });

    try {
      const accepted = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hang", conversationId: "c-timeout", mode: "async" }),
      });
      expect(accepted.status).toBe(202);

      const result = await resultPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/timed out/i);
      // The slot was reclaimed even though the responder never settled.
      await expect.poll(async () => server.activeRequestCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("times out endpoints independently using each override before the adapter fallback", async () => {
    const results = new Map<string, unknown>();
    const hangingResponder: AgentResponder = { respond: () => new Promise<never>(() => {}) };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      maxRunMs: 200,
      endpoints: [
        { name: "short", path: "/short", mode: "async", maxRunMs: 100 },
        { name: "long", path: "/long", mode: "async", maxRunMs: 300 },
      ],
      responder: hangingResponder,
      onResult: (status, request) => {
        results.set(request.metadata.webhook.endpointName, status);
      },
    });
    vi.useFakeTimers();

    try {
      const [shortAccepted, longAccepted] = await Promise.all([
        fetch(`${server.url}/short`, postJson({ text: "short", conversationId: "short-run" })),
        fetch(`${server.url}/long`, postJson({ text: "long", conversationId: "long-run" })),
      ]);
      expect(shortAccepted.status).toBe(202);
      expect(longAccepted.status).toBe(202);
      expect(server.activeRequestCount).toBe(2);

      await vi.advanceTimersByTimeAsync(99);
      expect(results.size).toBe(0);
      expect(server.activeRequestCount).toBe(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(results.get("short")).toMatchObject({ status: "failed", error: expect.stringContaining("100ms") });
      expect(results.has("long")).toBe(false);
      expect(server.activeRequestCount).toBe(1);

      // Total elapsed is now the 200ms adapter fallback. The long endpoint's
      // explicit 300ms override must still own its independent watchdog.
      await vi.advanceTimersByTimeAsync(100);
      expect(results.has("long")).toBe(false);
      expect(server.activeRequestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(results.get("long")).toMatchObject({ status: "failed", error: expect.stringContaining("300ms") });
      expect(server.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });

  it("uses an endpoint maxRunMs override for sync requests", async () => {
    let markResponderStarted!: () => void;
    const responderStarted = new Promise<void>((resolve) => { markResponderStarted = resolve; });
    const hangingResponder: AgentResponder = {
      respond() {
        markResponderStarted();
        return new Promise<never>(() => {});
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      maxRunMs: 300,
      endpoints: [{ name: "sync", path: "/sync", mode: "sync", maxRunMs: 100 }],
      responder: hangingResponder,
    });
    vi.useFakeTimers();

    try {
      let responseSettled = false;
      const responsePromise = fetch(
        `${server.url}/sync`,
        postJson({ text: "sync", conversationId: "sync-run" }),
      ).then((response) => {
        responseSettled = true;
        return response;
      });
      await responderStarted;

      await vi.advanceTimersByTimeAsync(99);
      expect(responseSettled).toBe(false);
      expect(server.activeRequestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      const response = await responsePromise;
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining("100ms"),
      });
      expect(server.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });

  it("uses the adapter fallback only when maxRunMs is absent and preserves endpoint zero as disabled", async () => {
    const results = new Map<string, unknown>();
    const responder: AgentResponder = {
      async respond(request) {
        if (request.text === "disabled") {
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          return { text: "completed without a watchdog" };
        }
        return await new Promise<never>(() => {});
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      maxRunMs: 100,
      endpoints: [
        { name: "fallback", path: "/fallback", mode: "async" },
        { name: "disabled", path: "/disabled", mode: "async", maxRunMs: 0 },
      ],
      responder,
      onResult: (status, request) => {
        results.set(request.metadata.webhook.endpointName, status);
      },
    });
    vi.useFakeTimers();

    try {
      const [fallbackAccepted, disabledAccepted] = await Promise.all([
        fetch(`${server.url}/fallback`, postJson({ text: "fallback", conversationId: "fallback-run" })),
        fetch(`${server.url}/disabled`, postJson({ text: "disabled", conversationId: "disabled-run" })),
      ]);
      expect(fallbackAccepted.status).toBe(202);
      expect(disabledAccepted.status).toBe(202);

      await vi.advanceTimersByTimeAsync(100);
      expect(results.get("fallback")).toMatchObject({ status: "failed", error: expect.stringContaining("100ms") });
      expect(results.has("disabled")).toBe(false);
      expect(server.activeRequestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(results.get("disabled")).toMatchObject({
        status: "succeeded",
        text: "completed without a watchdog",
      });
      expect(server.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });

  it("reports cancelled when a responder resolves after the run was aborted", async () => {
    let resolveResult: ((status: { status: string }) => void) | undefined;
    const resultPromise = new Promise<{ status: string }>((resolve) => { resolveResult = resolve; });
    let abortObserved!: () => void;
    const abortSeen = new Promise<void>((resolve) => { abortObserved = resolve; });
    // A responder that observes the abort but RESOLVES successfully anyway — the
    // success path must still classify the run as cancelled, not succeeded.
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => { abortObserved(); resolve(); }, { once: true });
        });
        return { text: "ignored the abort" };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
      onResult: (status) => { resolveResult?.(status as { status: string }); },
    });

    try {
      const controller = new AbortController();
      const pending = fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x", conversationId: "c-abort-success", mode: "sync" }),
        signal: controller.signal,
      });
      const settled = pending.catch(() => undefined);

      await expect.poll(async () => server.activeRequestCount).toBe(1);
      controller.abort();
      await abortSeen;
      await settled;

      const result = await resultPromise;
      expect(result.status).toBe("cancelled");
      await expect.poll(async () => server.activeRequestCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("includes destination resolution in maxRunMs without starting a stale responder", async () => {
    let resolveResult: ((status: { status: string; error?: string }) => void) | undefined;
    const resultPromise = new Promise<{ status: string; error?: string }>((resolve) => {
      resolveResult = resolve;
    });
    let settleResolver!: (value: string | undefined) => void;
    const resolverPromise = new Promise<string | undefined>((resolve) => {
      settleResolver = resolve;
    });
    const resolveNotifyFallbackConversationId = vi.fn(() => resolverPromise);
    const responder = { respond: vi.fn(async () => ({ text: "unexpected" })) } satisfies AgentResponder;
    const onResult = vi.fn((status: { status: string; error?: string }) => {
      resolveResult?.(status);
    });
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{ name: "notify", path: "/notify", mode: "async", notify: true }],
      maxRunMs: 100,
      responder,
      resolveNotifyFallbackConversationId,
      onResult: (status) => onResult(status as { status: string; error?: string }),
    });

    try {
      const accepted = await fetch(`${server.url}/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hang", conversationId: "logical:timeout", mode: "async" }),
      });
      expect(accepted.status).toBe(202);

      const result = await resultPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/timed out/i);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledOnce();
      expect(responder.respond).not.toHaveBeenCalled();
      await expect.poll(async () => server.activeRequestCount).toBe(0);

      settleResolver("slack:C1");
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).not.toHaveBeenCalled();
      expect(onResult).toHaveBeenCalledOnce();
    } finally {
      await server.stop();
    }
  });

  it("leaves a run that finishes within maxRunMs untouched", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      maxRunMs: 5000,
      responder: echoResponder(),
    });

    try {
      const response = await invokeSync(server.url, "hi", "c-fast");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "echo: hi" });
    } finally {
      await server.stop();
    }
  });
});

describe("Webhook adapter multi-endpoint", () => {
  it.each([-1, 1.5, 86_400_001, Number.NaN])(
    "rejects invalid programmatic endpoint maxRunMs value %s",
    async (maxRunMs) => {
      await expect(startWebhookAdapter({
        host: "127.0.0.1",
        port: 0,
        endpoints: [{ name: "invalid", path: "/invalid", maxRunMs }],
        responder: echoResponder(),
      })).rejects.toMatchObject({
        code: "invalid_config",
        details: { endpointName: "invalid", maxRunMs },
      });
    },
  );

  it("serves multiple endpoints on one server and prepends each endpoint's prompt", async () => {
    const seen: Array<{ text: string; endpoint: string | undefined }> = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        const webhook = request.metadata?.webhook as { endpointName?: string } | undefined;
        seen.push({ text: request.text, endpoint: webhook?.endpointName });
        await stream.append("ok");
        return {};
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      defaultMode: "sync",
      endpoints: [
        { name: "plain", path: "/plain" },
        { name: "guided", path: "/guided", prompt: "PREAMBLE", mode: "sync" },
      ],
      responder,
    });

    try {
      expect(server.endpoints.map((endpoint) => endpoint.name)).toEqual(["plain", "guided"]);
      expect(server.endpoints[1]?.invokeUrl).toBe(`${server.url}/guided`);

      await fetch(`${server.url}/guided`, postJson({ text: "hello", conversationId: "c1", mode: "sync" }));
      await fetch(`${server.url}/plain`, postJson({ text: "hi", conversationId: "c2", mode: "sync" }));

      expect(seen).toContainEqual({ text: "PREAMBLE\n\nhello", endpoint: "guided" });
      expect(seen).toContainEqual({ text: "hi", endpoint: "plain" });
    } finally {
      await server.stop();
    }
  });

  it("namespaces active runs per endpoint so the same conversation is not busy across endpoints", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        { name: "a", path: "/a", mode: "async" },
        { name: "b", path: "/b", mode: "async" },
      ],
      responder: blockingResponder(),
    });

    try {
      const a1 = await fetch(`${server.url}/a`, postJson({ text: "x", conversationId: "same" }));
      expect(a1.status).toBe(202);
      await expect.poll(async () => server.activeRequestCount).toBe(1);

      // Same conversation, different endpoint → must NOT be reported busy.
      const b1 = await fetch(`${server.url}/b`, postJson({ text: "x", conversationId: "same" }));
      expect(b1.status).toBe(202);
      await expect.poll(async () => server.activeRequestCount).toBe(2);

      // Same conversation AND same endpoint → busy.
      const a2 = await fetch(`${server.url}/a`, postJson({ text: "x", conversationId: "same" }));
      expect(a2.status).toBe(409);
      await expect(a2.json()).resolves.toMatchObject({ status: "busy", conversationId: "same" });
    } finally {
      await server.stop();
    }
  });
});

function echoResponder(): AgentResponder {
  return {
    async respond(request, stream) {
      await stream.append(`echo: ${request.text}`);
      return {};
    },
  };
}

function blockingResponder(): AgentResponder {
  return {
    async respond(request) {
      await new Promise<void>((resolve) => {
        request.abortSignal.addEventListener("abort", () => resolve());
      });
      return { text: "aborted" };
    },
  };
}

function postJson(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function invokeSync(url: string, text: string, conversationId: string): Promise<globalThis.Response> {
  return fetch(`${url}/webhook/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, conversationId, mode: "sync" }),
  });
}

async function expectPortReusable(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    probe.once("error", rejectPromise);
    probe.listen(port, "127.0.0.1", () => resolvePromise());
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    probe.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  });
}

function wildcardLocalhostLookup(
  _hostname: string,
  options: unknown,
  callback?: unknown,
): void {
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") {
    throw new TypeError("dns.lookup callback is required");
  }
  const all = typeof options === "object"
    && options !== null
    && "all" in options
    && options.all === true;
  queueMicrotask(() => {
    if (all) {
      (done as (
        error: null,
        addresses: Array<{ address: string; family: number }>,
      ) => void)(null, [{ address: "0.0.0.0", family: 4 }]);
      return;
    }
    (done as (error: null, address: string, family: number) => void)(null, "0.0.0.0", 4);
  });
}

function rejectedBoundPort(error: unknown): number {
  const boundPort = (error as { details?: { boundPort?: unknown } } | undefined)?.details?.boundPort;
  if (typeof boundPort !== "number") {
    throw new TypeError("Expected a rejected bind error with a numeric boundPort detail.");
  }
  return boundPort;
}

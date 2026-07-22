import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type {
  WebhookAdapterConfig,
  WebhookAdapterOptions,
  WebhookAdapterStartResult,
  WebhookInvocationRequest,
  WebhookInvocationStatus,
} from "@mono-agent/webhook-adapter";

import type { ChannelStartInput } from "../channels.js";
import { createWebhookChannelDriver } from "../channels.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseInput = {
  coreConfig: {} as never,
  responder: noopResponder,
  cwd: "/tmp",
  onFailure: () => {},
  config: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    allowNonLoopback: false,
    defaultMode: "sync",
    retentionMs: 300_000,
    maxStoredRequests: 100,
    path: "/webhook/invoke",
    endpoints: [{ name: "digest", path: "/digest", mode: "sync", enabled: true }],
  },
} satisfies ChannelStartInput<WebhookAdapterConfig>;

function succeededStatus(text?: string): WebhookInvocationStatus {
  return {
    status: "succeeded",
    requestId: "req-1",
    conversationId: "webhook-source",
    statusUrl: "/requests/req-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...(text === undefined ? {} : { text }),
  };
}

function webhookRequest(endpointName = "digest", replyToConversationId?: string): WebhookInvocationRequest {
  return {
    conversationId: "webhook-source",
    text: "payload",
    abortSignal: new AbortController().signal,
    ...(replyToConversationId === undefined ? {} : { replyTo: { conversationId: replyToConversationId } }),
    metadata: {
      webhook: {
        requestId: "req-1",
        endpointName,
        mode: "sync",
        method: "POST",
        path: "/digest",
        receivedAt: "2026-01-01T00:00:00.000Z",
        headers: {},
      },
    },
  };
}

async function startCapturingWebhook(input: unknown): Promise<WebhookAdapterOptions> {
  let captured: WebhookAdapterOptions | undefined;
  const driver = createWebhookChannelDriver({
    adapterFactory: async (options): Promise<WebhookAdapterStartResult> => {
      captured = options;
      return {
        url: "http://127.0.0.1:9999",
        invokeUrl: "http://127.0.0.1:9999/digest",
        statusBasePath: "/requests",
        host: "127.0.0.1",
        port: 9999,
        endpoints: (options.endpoints ?? []).map((endpoint) => ({
          name: endpoint.name,
          path: endpoint.path,
          invokeUrl: `http://127.0.0.1:9999${endpoint.path}`,
          statusBasePath: "/requests",
          mode: endpoint.mode ?? "sync",
        })),
        activeRequestCount: 0,
        getStatus: () => undefined,
        stop: async () => {},
      };
    },
  });

  await driver.start(input as never);
  if (captured === undefined) {
    throw new Error("Webhook adapter was not started.");
  }
  return captured;
}

describe("webhook channel driver — native notification delivery", () => {
  it("passes the optional API key through to the webhook adapter", async () => {
    const captured = await startCapturingWebhook({
      ...baseInput,
      config: { ...baseInput.config, apiKey: "fixture-webhook-key" },
    });

    expect(captured.apiKey).toBe("fixture-webhook-key");
  });

  it("passes endpoint maxRunMs overrides without replacing the adapter fallback", async () => {
    const captured = await startCapturingWebhook({
      ...baseInput,
      config: {
        ...baseInput.config,
        maxRunMs: 60_000,
        endpoints: [
          { name: "bounded", path: "/bounded", mode: "async", enabled: true, maxRunMs: 5_000 },
          { name: "unbounded", path: "/unbounded", mode: "async", enabled: true, maxRunMs: 0 },
        ],
      },
    });

    expect(captured.maxRunMs).toBe(60_000);
    expect(captured.endpoints).toEqual([
      { name: "bounded", path: "/bounded", mode: "async", maxRunMs: 5_000 },
      { name: "unbounded", path: "/unbounded", mode: "async", maxRunMs: 0 },
    ]);
  });

  it("passes native notify settings through to the webhook adapter", async () => {
    const captured = await startCapturingWebhook({
      ...baseInput,
      config: {
        ...baseInput.config,
        endpoints: [
          {
            name: "digest",
            path: "/digest",
            mode: "sync",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    expect(captured.endpoints).toEqual([
      {
        name: "digest",
        path: "/digest",
        mode: "sync",
        notify: true,
        notifyConversationId: "telegram:42",
      },
    ]);
  });

  it("delivers successful native notify webhook results to the configured destination", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingWebhook({
      ...baseInput,
      notifyDestination,
      config: {
        ...baseInput.config,
        endpoints: [
          {
            name: "digest",
            path: "/digest",
            mode: "sync",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    captured.onResult?.(succeededStatus("Webhook digest"), webhookRequest("digest", "telegram:42"));

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledOnce());
    // Verbatim delivery: the final answer is posted as-is (no echo-turn wrapper).
    expect(notifyDestination).toHaveBeenCalledWith("telegram:42", "Webhook digest", { verbatim: true });
    const deliveredText = (notifyDestination.mock.calls[0] as [string, string, unknown] | undefined)?.[1];
    expect(deliveredText).toBe("Webhook digest");
    expect(deliveredText).not.toContain("Do not call tools");
  });

  it("adds the stable request delivery key for web:new", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingWebhook({
      ...baseInput,
      notifyDestination,
      config: {
        ...baseInput.config,
        endpoints: [{
          name: "daily digest",
          path: "/digest",
          mode: "sync",
          enabled: true,
          notify: true,
          notifyConversationId: "web:new",
        }],
      },
    });

    captured.onResult?.(
      succeededStatus("Webhook digest"),
      webhookRequest("daily digest", "web:new"),
    );
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledOnce());
    expect(notifyDestination).toHaveBeenCalledWith("web:new", "Webhook digest", {
      verbatim: true,
      deliveryKey: "webhook:daily%20digest:req-1:success",
    });
  });

  it("infers a single notify destination when no endpoint destination is configured", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "slack:C1", channelId: "slack" as const },
    ]);
    const captured = await startCapturingWebhook({
      ...baseInput,
      notifyDestination,
      listNotifyDestinations,
      config: {
        ...baseInput.config,
        endpoints: [{ name: "digest", path: "/digest", mode: "sync", enabled: true, notify: true }],
      },
    });

    expect(captured.endpoints?.[0]).not.toHaveProperty("notifyFallbackConversationId");
    const notifyConversationId = await captured.resolveNotifyFallbackConversationId?.();
    expect(notifyConversationId).toBe("slack:C1");

    captured.onResult?.(
      succeededStatus("Webhook digest"),
      webhookRequest("digest", notifyConversationId),
    );

    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "Webhook digest", { verbatim: true }),
    );
  });

  it("re-resolves inferred destinations per invocation and delivers only on that request's replyTo", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    let candidates = [
      { conversationId: "slack:C1", channelId: "slack" as const },
    ];
    const listNotifyDestinations = vi.fn(async () => candidates);
    const captured = await startCapturingWebhook({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      listNotifyDestinations,
      config: {
        ...baseInput.config,
        endpoints: [{ name: "digest", path: "/digest", mode: "sync", enabled: true, notify: true }],
      },
    });

    expect(listNotifyDestinations).not.toHaveBeenCalled();
    const firstRoute = await captured.resolveNotifyFallbackConversationId?.();
    candidates = [
      { conversationId: "slack:C1", channelId: "slack" as const },
      { conversationId: "slack:C2", channelId: "slack" as const },
    ];
    // The first request keeps the route it resolved before starting even though a
    // second candidate appears before completion; replyTo and delivery cannot drift.
    captured.onResult?.(succeededStatus("First digest"), webhookRequest("digest", firstRoute));
    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "First digest", { verbatim: true }),
    );

    const secondRoute = await captured.resolveNotifyFallbackConversationId?.();
    expect(secondRoute).toBeUndefined();
    captured.onResult?.(succeededStatus("Second digest"), webhookRequest("digest", secondRoute));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(notifyDestination).toHaveBeenCalledTimes(1);
    expect(listNotifyDestinations).toHaveBeenCalledTimes(2);
  });

  it("delivers to the request's conversation when the payload names a deliverable chat (async-callback)", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingWebhook({
      ...baseInput,
      notifyDestination,
      config: {
        ...baseInput.config,
        endpoints: [{ name: "callback", path: "/callback", mode: "async", enabled: true, notify: true }],
      },
    });

    // No notifyConversationId and no single inferred candidate — the destination is
    // taken from the inbound payload's conversationId (the originating chat).
    captured.onResult?.(succeededStatus("Job done"), {
      ...webhookRequest("callback", "telegram:99"),
      conversationId: "telegram:99",
    });

    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("telegram:99", "Job done", { verbatim: true }),
    );
  });

  it("skips native delivery for blank final text", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingWebhook({
      ...baseInput,
      notifyDestination,
      config: {
        ...baseInput.config,
        endpoints: [
          {
            name: "digest",
            path: "/digest",
            mode: "sync",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    captured.onResult?.(succeededStatus("   "), webhookRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("logs delivery failures without failing the webhook result path", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: false, reason: "blocked" }));
    const captured = await startCapturingWebhook({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      config: {
        ...baseInput.config,
        endpoints: [
          {
            name: "digest",
            path: "/digest",
            mode: "sync",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    expect(() => captured.onResult?.(
      succeededStatus("Webhook digest"),
      webhookRequest("digest", "telegram:42"),
    )).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({ endpointName: "digest", reason: "blocked" });
  });
});

import { once } from "node:events";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isEnvEligibleSchema,
  isSecretSchema,
  type ChannelHost,
  type ChannelInboundRequest,
  type ChannelReplySink,
  type ModuleLogger,
} from "@mono-agent/module-sdk";
import {
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
} from "@mono-agent/module-sdk/testing";

import {
  DEFAULT_MAX_BODY_BYTES,
  parseWebhookConfig,
  webhookConfigSchema,
  type WebhookConfig,
} from "../config.js";
import {
  createWebhookChannel,
  type WebhookChannel,
  type WebhookInboundRequest,
  type WebhookSubmit,
} from "../server.js";
import { monoAgentModule, type WebhookModuleChannel } from "../index.js";
import { WebhookDelivery } from "../delivery.js";

const channels = new Set<WebhookChannel>();
const moduleChannels = new Set<WebhookModuleChannel>();
const TEST_API_KEY = "test-webhook-key";

afterEach(async () => {
  await Promise.all([...channels].map(async (channel) => channel.stop()));
  await Promise.all([...moduleChannels].map(async (channel) => {
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  }));
  channels.clear();
  moduleChannels.clear();
});

describe("webhook config", () => {
  it("applies bounded loopback defaults", () => {
    const config = parseWebhookConfig({ apiKey: TEST_API_KEY });
    expect(config).toMatchObject({
      listen: { host: "127.0.0.1", port: 0 },
      apiKey: TEST_API_KEY,
      path: "/webhook/invoke",
      mode: "sync",
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      maxRunMs: 1_200_000,
      retentionMs: 300_000,
      maxStoredRequests: 100,
    });
  });

  it("requires env-only secrets and gates non-loopback binds behind explicit strong dual authentication", () => {
    const properties = webhookConfigSchema.jsonSchema.properties as Record<string, unknown>;
    const apiKeySchema = properties.apiKey as Readonly<Record<string, unknown>>;
    expect(isEnvEligibleSchema(apiKeySchema)).toBe(true);
    expect(isSecretSchema(apiKeySchema)).toBe(true);
    expect(webhookConfigSchema.jsonSchema.required).toContain("apiKey");
    expect(() => parseWebhookConfig({})).toThrowError(/apiKey is required/u);
    expect(() => parseWebhookConfig({ apiKey: { $env: "WEBHOOK_KEY" } })).toThrowError(
      /resolved/u,
    );
    expect(parseWebhookConfig({ apiKey: "resolved-key" }).apiKey).toBe("resolved-key");
    expect(() => parseWebhookConfig({
      listen: { host: "0.0.0.0", port: 0 },
      apiKey: "resolved-key",
    })).toThrowError(/must be loopback/u);
    expect(() => parseWebhookConfig({
      listen: { host: "0.0.0.0" },
      allowNonLoopback: true,
      apiKey: "resolved-key",
    })).toThrowError(/at least 32/u);
    expect(parseWebhookConfig({
      listen: { host: "0.0.0.0" },
      allowNonLoopback: true,
      apiKey: "a".repeat(32),
      signatureSecret: "s".repeat(32),
    })).toMatchObject({ listen: { host: "0.0.0.0" }, allowNonLoopback: true });
    expect(parseWebhookConfig({
      listen: { host: "localhost", port: 0 },
      apiKey: "resolved-key",
    }).listen.host).toBe("localhost");
  });

  it("defensively rejects an unsafe bind passed around the public parser", () => {
    const parsed = parseWebhookConfig({ apiKey: TEST_API_KEY });
    const config: WebhookConfig = {
      ...parsed,
      listen: { host: "0.0.0.0", port: 0 },
    };
    expect(() => createWebhookChannel({
      config,
      submit: async () => ({ text: "unexpected" }),
    })).toThrowError(/outside loopback only with explicit/u);
    expect(() => createWebhookChannel({
      config: { ...config, allowNonLoopback: true },
      submit: async () => ({ text: "unexpected" }),
    })).toThrowError(/requires bearer and signature secrets/u);
  });
});

describe("webhook HTTP channel", () => {
  it("uses the parsed config apiKey as the sole public-API authentication key", async () => {
    const submit = vi.fn<WebhookSubmit>(async () => ({ text: "accepted" }));
    const config = parseWebhookConfig({ apiKey: "config-only-key" });
    const channel = createWebhookChannel({ config, submit });
    channels.add(channel);
    const info = await channel.start();
    const response = await fetch(info.invokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "browser request" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(submit).not.toHaveBeenCalled();

    const authorized = await invoke(info.invokeUrl, { text: "authorized" }, "config-only-key");
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ status: "succeeded", text: "accepted" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("requires an exact HMAC of the raw authenticated body when signing is configured", async () => {
    const secret = "signature-secret-that-is-long-enough";
    const { info } = await startChannel({ signatureSecret: secret }, async () => ({ text: "signed" }));
    const raw = JSON.stringify({ text: "signed request" });
    const unsigned = await fetch(info.invokeUrl, { method: "POST", headers: { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" }, body: raw });
    expect(unsigned.status).toBe(401);
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    const signed = await fetch(info.invokeUrl, { method: "POST", headers: { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json", "x-mono-agent-signature": `sha256=${signature}` }, body: raw });
    expect(signed.status).toBe(200);
  });

  it("rejects browser-simple content types before reading the body", async () => {
    const submit = vi.fn<WebhookSubmit>(async () => ({ text: "unexpected" }));
    const { info } = await startChannel({}, submit);
    const response = await fetch(info.invokeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ text: "browser request" }),
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_media_type" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("authenticates before parsing or bounding the request body", async () => {
    const { info } = await startChannel({ maxBodyBytes: 32 }, async () => ({ text: "unexpected" }), "right-key");
    const response = await fetch(info.invokeUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "application/json",
      },
      body: `{not-json:${"x".repeat(4_096)}`,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      status: "error",
      error: { code: "unauthorized", message: "Unauthorized." },
    });
  });

  it("rejects query-bearing invoke routes without dispatch", async () => {
    const submit = vi.fn<WebhookSubmit>(async () => ({ text: "unexpected" }));
    const { info } = await startChannel({}, submit);
    const response = await invoke(`${info.invokeUrl}?override=true`, { text: "query" });
    expect(response.status).toBe(404);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an untrusted Host authority before route handling", async () => {
    const submit = vi.fn<WebhookSubmit>(async () => ({ text: "unexpected" }));
    const { info } = await startChannel({}, submit);
    await expect(authorityStatus(info.port, `attacker.invalid:${String(info.port)}`, info.invokeUrl)).resolves.toBe(421);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an authorized body over the configured byte bound", async () => {
    const submit = vi.fn<WebhookSubmit>(async () => ({ text: "unexpected" }));
    const { info } = await startChannel({ maxBodyBytes: 64 }, submit, "right-key");
    const response = await fetch(info.invokeUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer right-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(1_024) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "body_too_large" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns async acceptance and protects status polling with the same bearer", async () => {
    let finish: ((value: { text: string }) => void) | undefined;
    const submit: WebhookSubmit = async () => new Promise((resolve) => {
      finish = resolve;
    });
    const { channel, info } = await startChannel({ mode: "async" }, submit, "async-key");

    const acceptedResponse = await invoke(info.invokeUrl, { text: "work" }, "async-key");
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json() as {
      requestId: string;
      statusUrl: string;
      status: string;
    };
    expect(accepted.status).toBe("accepted");
    expect(accepted.statusUrl).toContain(accepted.requestId);

    const unauthorized = await fetch(`${info.baseUrl}${accepted.statusUrl}`);
    expect(unauthorized.status).toBe(401);

    finish?.({ text: "done" });
    await vi.waitFor(() => {
      expect(channel.getStatus(accepted.requestId)?.status).toBe("succeeded");
    });
    const statusResponse = await fetch(`${info.baseUrl}${accepted.statusUrl}`, {
      headers: { authorization: "Bearer async-key" },
    });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      status: "succeeded",
      requestId: accepted.requestId,
      text: "done",
    });
  });

  it("times out a run, aborts its signal, and returns a redacted terminal error", async () => {
    let observed: WebhookInboundRequest | undefined;
    const { info } = await startChannel({ maxRunMs: 20 }, async (request) => {
      observed = request;
      return new Promise(() => undefined);
    });

    const response = await invoke(info.invokeUrl, { text: "hang" });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: { code: "timeout", message: "The request timed out." },
    });
    expect(observed?.abortSignal.aborted).toBe(true);
  });

  it("aborts active work and drains idempotently on shutdown", async () => {
    let observed: WebhookInboundRequest | undefined;
    const { channel, info } = await startChannel({ mode: "async" }, async (request) => {
      observed = request;
      return new Promise(() => undefined);
    });
    const response = await invoke(info.invokeUrl, { text: "long work" });
    const accepted = await response.json() as { requestId: string };

    const firstStop = channel.stop();
    const secondStop = channel.stop();
    await Promise.all([firstStop, secondStop]);

    expect(observed?.abortSignal.aborted).toBe(true);
    expect(channel.getStatus(accepted.requestId)).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
    });
    expect(channel.health()).toMatchObject({ status: "stopped", activeRequests: 0 });
  });

  it("destroys an open keep-alive socket during bounded shutdown", async () => {
    const { channel, info } = await startChannel({}, async () => ({ text: "unused" }));
    const socket = createConnection({ host: info.host, port: info.port });
    await once(socket, "connect");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await channel.stop();

    await expect(closed).resolves.toBeUndefined();
    expect(socket.destroyed).toBe(true);
  });

  it("never exposes an API key or raw host error in responses, status, start info, or health", async () => {
    const secret = "super-secret-token";
    const rawError = "provider exploded with private detail";
    const { channel, info } = await startChannel({}, async () => {
      throw new Error(`${rawError}: ${secret}`);
    }, secret);

    const response = await invoke(info.invokeUrl, { text: "fail" }, secret);
    expect(response.status).toBe(500);
    const surfaces = [
      await response.text(),
      JSON.stringify(info),
      JSON.stringify(channel.health()),
    ].join("\n");
    expect(surfaces).not.toContain(secret);
    expect(surfaces).not.toContain(rawError);
    expect(surfaces).toContain("The request failed.");
  });

  it("normalizes an invocation end to end and returns the submitted terminal text", async () => {
    const submit = vi.fn<WebhookSubmit>(async () => ({ text: "normalized reply" }));
    const { channel, info } = await startChannel({}, submit);
    const response = await invoke(info.invokeUrl, {
      text: "hello",
      conversationId: "conversation-7",
      runtime: "pi",
      model: "openai-codex:gpt-test",
      effort: "high",
      metadata: { source: "integration-test", count: 3 },
    });

    expect(response.status).toBe(200);
    const result = await response.json() as { requestId: string; status: string; text: string };
    expect(result).toMatchObject({ status: "succeeded", text: "normalized reply" });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      requestId: result.requestId,
      conversationId: "conversation-7",
      text: "hello",
      runtime: "pi",
      model: "openai-codex:gpt-test",
      effort: "high",
      metadata: { source: "integration-test", count: 3 },
      abortSignal: expect.any(AbortSignal),
    }));
    expect(channel.health()).toMatchObject({ status: "healthy", activeRequests: 0 });
  });
});

describe("webhook outbound delivery", () => {
  it("signs a fixed destination and collapses concurrent duplicate idempotency keys", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      const body = Buffer.from(init?.body as Uint8Array);
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer outbound-key");
      expect(headers["x-mono-agent-signature"]).toBe(`sha256=${createHmac("sha256", "outbound-signature-secret").update(body).digest("hex")}`);
      return new Response('{"messageId":"remote-1"}', { status: 200, headers: { "content-type": "application/json" } });
    });
    const delivery = new WebhookDelivery({ url: "https://hooks.example.test/deliver", apiKey: "outbound-key", signatureSecret: "outbound-signature-secret", timeoutMs: 1_000, maxResponseBytes: 1_024 }, fetchImpl);
    const message = { conversationId: "webhook:destination", text: "notice", idempotencyKey: "delivery-1" };
    await expect(Promise.all([delivery.deliver(message, new AbortController().signal), delivery.deliver(message, new AbortController().signal)])).resolves.toEqual([{ status: "delivered", idempotencyKey: "delivery-1", messageId: "remote-1" }, { status: "delivered", idempotencyKey: "delivery-1", messageId: "remote-1" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("mono-agent channel module", () => {
  it("declares the v1 channel boundary and dispatches through the injected host", async () => {
    expect(() => assertChannelModuleCompliance(monoAgentModule, {
      expectedPackageName: "@mono-agent/channel-webhook",
      expectedPackageVersion: "0.15.0",
    })).not.toThrow();
    expect(monoAgentModule.manifest).toMatchObject({
      packageName: "@mono-agent/channel-webhook",
      packageVersion: "0.15.0",
      apiVersion: 1,
      kind: "channel",
      capabilities: [],
    });

    const config = monoAgentModule.schema.parse({
      apiKey: "module-key",
      maxRunMs: 1_000,
    });
    let inbound: ChannelInboundRequest | undefined;
    const host: ChannelHost = {
      grantedCapabilities: new Set(),
      getCapability<T>(): T | undefined {
        return undefined;
      },
      async dispatch(request: ChannelInboundRequest, reply: ChannelReplySink) {
        inbound = request;
        await reply.emit({ type: "text-delta", delta: "module " });
        await reply.emit({ type: "text-delta", delta: "reply" });
        return { status: "completed" } as const;
      },
    };
    const lifecycle = new AbortController();
    const channel = await monoAgentModule.create({
      instanceId: "incoming",
      config,
      configDirectory: "/config",
      provenance: {},
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host,
      signal: lifecycle.signal,
    });
    moduleChannels.add(channel);
    expect(() => assertChannelInstanceCompliance(channel)).not.toThrow();

    await channel.start?.({ signal: lifecycle.signal });
    expect(channel.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook\/invoke$/u);
    const response = await invoke(channel.endpoint as string, {
      text: "module request",
      conversationId: "module-conversation",
      runtime: "pi",
      model: "openai-codex:gpt-test",
      effort: "high",
      metadata: { source: "module-test" },
    }, "module-key");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "succeeded", text: "module reply" });
    expect(inbound).toMatchObject({
      conversationId: "module-conversation",
      text: "module request",
      runtime: "pi",
      model: "openai-codex:gpt-test",
      effort: "high",
      attachments: [],
      metadata: { source: "module-test" },
      sender: { id: "webhook", displayName: "incoming" },
    });
    expect(inbound?.signal).toBeInstanceOf(AbortSignal);
    expect(await channel.health?.({ signal: lifecycle.signal })).toMatchObject({
      status: "healthy",
      details: { activeRequests: 0, storedRequests: 0 },
    });
    await channel.stop?.({ signal: lifecycle.signal, reason: "shutdown" });
  });
});

async function startChannel(
  configOverrides: Readonly<Record<string, unknown>>,
  submit: WebhookSubmit,
  apiKey = TEST_API_KEY,
): Promise<{
  readonly config: WebhookConfig;
  readonly channel: WebhookChannel;
  readonly info: Awaited<ReturnType<WebhookChannel["start"]>>;
}> {
  const config = parseWebhookConfig({ ...configOverrides, apiKey });
  const channel = createWebhookChannel({
    config,
    submit,
  });
  channels.add(channel);
  const info = await channel.start();
  return { config, channel, info };
}

async function invoke(
  invokeUrl: string,
  body: Readonly<Record<string, unknown>>,
  apiKey = TEST_API_KEY,
): Promise<Response> {
  return fetch(invokeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

function noopLogger(): ModuleLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function authorityStatus(port: number, host: string, invokeUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: new URL(invokeUrl).pathname,
      headers: { host, authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(JSON.stringify({ text: "host attack" }));
  });
}

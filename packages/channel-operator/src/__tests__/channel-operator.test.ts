import { once } from "node:events";
import { createConnection, isIP } from "node:net";

import {
  isEnvEligibleSchema,
  isSecretSchema,
  type ChannelHost,
  type ChannelInboundRequest,
  type ChannelReplySink,
  type ChannelTurnResult,
  type ModuleLogger,
} from "@mono-agent/module-sdk";
import {
  OperatorClient,
  parseOperatorFrame,
  parseOperatorHealth,
  parseOperatorInfo,
  type OperatorFrame,
} from "@mono-agent/operator";
import {
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
} from "@mono-agent/module-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIN_OPERATOR_TOKEN_BYTES,
  createOperatorChannel,
  monoAgentModule,
  operatorChannelConfigSchema,
  parseOperatorChannelConfig,
  type OperatorChannel,
  type OperatorModuleChannel,
} from "../index.js";

const TOKEN = "operator-fixture-token-that-is-long-enough";
const channels = new Set<OperatorChannel>();
const moduleChannels = new Set<OperatorModuleChannel>();

afterEach(async () => {
  await Promise.allSettled([
    ...[...channels].map((channel) => channel.stop()),
    ...[...moduleChannels].map((channel) => channel.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown" as const,
    })),
  ]);
  channels.clear();
  moduleChannels.clear();
});

describe("operator channel config", () => {
  it("marks the nested token env-only and secret, and rejects weak or missing authentication", () => {
    const properties = operatorChannelConfigSchema.jsonSchema.properties as Record<string, unknown>;
    const auth = properties.auth as { properties: { token: Readonly<Record<string, unknown>> } };
    expect(isEnvEligibleSchema(auth.properties.token)).toBe(true);
    expect(isSecretSchema(auth.properties.token)).toBe(true);
    expect(auth.properties.token.minLength).toBe(MIN_OPERATOR_TOKEN_BYTES);

    expect(() => parseOperatorChannelConfig({})).toThrow(/auth/u);
    expect(() => parseOperatorChannelConfig({ auth: { token: "too-short" } })).toThrow(/32-4096 byte/u);
    expect(() => parseOperatorChannelConfig({
      auth: { token: { $env: "MONO_AGENT_OPERATOR_TOKEN" } },
    })).toThrow(/resolved bearer token/u);
    expect(parseOperatorChannelConfig({ auth: { token: TOKEN } })).toMatchObject({
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: TOKEN },
    });
  });

  it("has an exact shape and rejects every non-loopback bind", () => {
    expect(() => parseOperatorChannelConfig({
      auth: { token: TOKEN },
      listen: { host: "0.0.0.0", port: 4000 },
    })).toThrow(/loopback/u);
    expect(() => parseOperatorChannelConfig({
      auth: { token: TOKEN },
      allowNonLoopback: true,
    })).toThrow(/unknown field.*allowNonLoopback/u);
    expect(() => parseOperatorChannelConfig({
      auth: { token: TOKEN, fallback: "secret" },
    })).toThrow(/unknown field.*fallback/u);
    expect(parseOperatorChannelConfig({
      auth: { token: TOKEN },
      listen: { host: "::1", port: 0 },
      label: "Test Agent",
    })).toMatchObject({ listen: { host: "::1" }, label: "Test Agent" });
  });
});

describe("operator HTTP channel", () => {
  it("advertises the actual literal loopback address when configured with localhost", async () => {
    const channel = createOperatorChannel({
      config: parseOperatorChannelConfig({
        auth: { token: TOKEN },
        listen: { host: "localhost", port: 0 },
        label: "Localhost Agent",
      }),
      instanceId: "localhost-operator",
      dispatch: async () => ({ status: "completed", text: "unused" }),
    });
    channels.add(channel);

    const startInfo = await channel.start();
    expect(startInfo.host).not.toBe("localhost");
    expect(isIP(startInfo.host)).toBeGreaterThan(0);
    expect(startInfo.host === "::1" || startInfo.host.split(".", 1)[0] === "127").toBe(true);
    expect(new URL(startInfo.endpoint).hostname).not.toBe("localhost");

    const client = new OperatorClient({ endpoint: startInfo.endpoint, token: TOKEN });
    await expect(client.getInfo()).resolves.toMatchObject({
      agent: { id: "localhost-operator", label: "Localhost Agent" },
    });
  });

  it("serves stable authenticated info and health from the shared protocol", async () => {
    const channel = await startChannel(async () => ({ status: "completed", text: "unused" }));
    const unauthorized = await fetch(channel.startInfo.infoUrl);
    expect(unauthorized.status).toBe(401);

    const first = parseOperatorInfo(await authorizedJson(channel.startInfo.infoUrl));
    const second = parseOperatorInfo(await authorizedJson(channel.startInfo.infoUrl));
    expect(first).toMatchObject({
      protocol: "mono-agent.operator.v1",
      agent: { id: "operator", label: "Fixture Agent" },
      capabilities: {
        attachments: false,
        cancellation: true,
        runtimeOverrides: true,
        health: true,
      },
    });
    expect(second.process.startedAt).toBe(first.process.startedAt);
    expect(parseOperatorHealth(await authorizedJson(channel.startInfo.healthUrl))).toMatchObject({
      status: "healthy",
      details: [{ id: "channel-operator", status: "healthy" }],
    });
  });

  it("streams only shared frames while preserving append, replace, activity, routing, and final text", async () => {
    let inbound: ChannelInboundRequest | undefined;
    const dispatch = vi.fn(async (request: ChannelInboundRequest, reply: ChannelReplySink) => {
      inbound = request;
      await reply.emit({ type: "text-delta", delta: "draft" });
      await reply.emit({ type: "text-replace", text: "answer" });
      await reply.emit({ type: "activity", text: "Checked the workspace" });
      return { status: "completed", text: "final answer" } as const;
    });
    const channel = await startChannel(dispatch);
    const response = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "conversation-1",
      input: { text: "hello" },
      runtime: "pi",
      model: "openai:gpt-test",
      effort: "high",
      metadata: { source: "test", count: 2 },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = await readFrames(response);
    const turnId = frames[0]?.type === "accepted" ? frames[0].turnId : undefined;
    expect(turnId).toEqual(expect.any(String));
    expect(frames).toEqual([
      {
        type: "accepted",
        turnId,
        conversationId: "conversation-1",
        startedAt: expect.any(String),
      },
      { type: "delta", turnId, target: "assistant", text: "draft", mode: "append" },
      { type: "delta", turnId, target: "assistant", text: "answer", mode: "replace" },
      { type: "activity", turnId, text: "Checked the workspace" },
      {
        type: "completed",
        turnId,
        finalMessage: { role: "assistant", text: "final answer" },
        finishedAt: expect.any(String),
        stopReason: "completed",
      },
    ]);
    expect(inbound).toMatchObject({
      requestId: turnId,
      conversationId: "conversation-1",
      text: "hello",
      runtime: "pi",
      model: "openai:gpt-test",
      effort: "high",
      metadata: { source: "test", count: 2 },
      sender: { id: "operator", displayName: "operator" },
      attachments: [],
    });
    expect(inbound?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed for malformed, unsupported, unauthorized, and cross-origin requests", async () => {
    const dispatch = vi.fn(async () => ({ status: "completed", text: "unexpected" }) as const);
    const channel = await startChannel(dispatch);
    const noAuth = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(noAuth.status).toBe(401);

    const simple = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ conversationId: "c", input: { text: "hi" } }),
    });
    expect(simple.status).toBe(415);

    const crossOrigin = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://attacker.invalid",
      },
      body: JSON.stringify({ conversationId: "c", input: { text: "hi" } }),
    });
    expect(crossOrigin.status).toBe(403);

    const malformed = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ conversationId: "c", input: { text: "hi" }, surprise: true }),
    });
    expect(malformed.status).toBe(400);

    const attachment = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        conversationId: "c",
        input: { attachments: [{ id: "a", name: "a.txt", mediaType: "text/plain" }] },
      }),
    });
    expect(attachment.status).toBe(422);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("aborts the exact Core dispatch when the stream client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const channel = await startChannel(async (request) => {
      observedSignal = request.signal;
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => {
        resolveAbort?.();
        resolve();
      }, { once: true }));
      return { status: "cancelled" };
    });

    const response = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "disconnect-me",
      input: { text: "wait" },
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();

    await expect(Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("abort not observed")), 2_000)),
    ])).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("supports authenticated explicit cancellation by conversation", async () => {
    const channel = await startChannel(async (request) => {
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled" };
    });
    const response = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "cancel-me",
      input: { text: "wait" },
    });
    const cancel = await postJson(
      `${channel.startInfo.baseUrl}/v1/conversations/cancel-me/cancel`,
      { reason: "operator requested" },
    );
    expect(cancel.status).toBe(202);
    await expect(cancel.json()).resolves.toEqual({ status: "accepted" });
    const frames = await readFrames(response);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      error: { code: "cancelled" },
      cancelled: true,
    });

    const idle = await postJson(
      `${channel.startInfo.baseUrl}/v1/conversations/missing/cancel`,
      {},
    );
    expect(idle.status).toBe(200);
    await expect(idle.json()).resolves.toEqual({ status: "idle" });
  });

  it("starts and stops idempotently and destroys open keep-alive sockets", async () => {
    const channel = await startChannel(async () => ({ status: "completed", text: "ok" }));
    const first = channel.startInfo;
    await expect(channel.channel.start()).resolves.toEqual(first);
    const socket = createConnection({ host: first.host, port: first.port });
    await once(socket, "connect");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await Promise.all([channel.channel.stop(), channel.channel.stop()]);

    await expect(closed).resolves.toBeUndefined();
    expect(socket.destroyed).toBe(true);
    expect(channel.channel.health()).toMatchObject({ status: "stopped", activeTurns: 0 });
  });
});

describe("mono-agent operator channel module", () => {
  it("is a compliant side-effect-free typed channel with a runnable endpoint", async () => {
    expect(() => assertChannelModuleCompliance(monoAgentModule, {
      expectedPackageName: "@mono-agent/channel-operator",
      expectedPackageVersion: "0.15.0",
    })).not.toThrow();
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN }, label: "Module Agent" });
    const dispatched: ChannelInboundRequest[] = [];
    const host: ChannelHost = {
      grantedCapabilities: new Set(),
      getCapability<T>(): T | undefined {
        return undefined;
      },
      async dispatch(request, reply): Promise<ChannelTurnResult> {
        dispatched.push(request);
        await reply.emit({ type: "text-delta", delta: "module reply" });
        return { status: "completed" };
      },
    };
    const lifecycle = new AbortController();
    const channel = await monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: {},
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host,
      signal: lifecycle.signal,
    });
    moduleChannels.add(channel);
    expect(() => assertChannelInstanceCompliance(channel)).not.toThrow();
    expect(channel.endpoint).toBeUndefined();

    await channel.start?.({ signal: lifecycle.signal });
    expect(channel.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const response = await postJson(`${channel.endpoint}/v1/turns`, {
      conversationId: "module-conversation",
      input: { text: "hello module" },
    });
    expect((await readFrames(response)).at(-1)).toMatchObject({
      type: "completed",
      finalMessage: { text: "module reply" },
    });
    expect(dispatched).toHaveLength(1);
    expect(await channel.health?.({ signal: lifecycle.signal })).toMatchObject({
      status: "healthy",
      details: { activeTurns: 0, endpoint: channel.endpoint },
    });
    await channel.drain?.({ signal: lifecycle.signal });
    await channel.stop?.({ signal: lifecycle.signal, reason: "shutdown" });
  });
});

async function startChannel(
  dispatch: (
    request: ChannelInboundRequest,
    reply: ChannelReplySink,
  ) => Promise<ChannelTurnResult>,
): Promise<{ readonly channel: OperatorChannel; readonly startInfo: NonNullable<OperatorChannel["startInfo"]> }> {
  const channel = createOperatorChannel({
    config: parseOperatorChannelConfig({ auth: { token: TOKEN }, label: "Fixture Agent" }),
    instanceId: "operator",
    dispatch,
  });
  channels.add(channel);
  const startInfo = await channel.start();
  return { channel, startInfo };
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

async function authorizedJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(response.status).toBe(200);
  return response.json() as Promise<unknown>;
}

async function readFrames(response: Response): Promise<OperatorFrame[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseOperatorFrame(JSON.parse(line) as unknown));
}

function noopLogger(): ModuleLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

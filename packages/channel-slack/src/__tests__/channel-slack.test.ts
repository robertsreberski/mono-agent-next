import { mkdtempSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEnvEligibleSchema, isSecretSchema, type ChannelHost, type ModuleLogger } from "@mono-agent/module-sdk";
import { assertChannelInstanceCompliance, assertChannelModuleCompliance } from "@mono-agent/module-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlackChannel, createSlackSocketModeTransport, createSlackWebApiClient, monoAgentModule, parseSlackConfig, slackConfigSchema, type SlackApiClient, type SlackSocketEvent, type SlackSocketEventHandler, type SlackSocketFailureHandler, type SlackSocketTransport } from "../index.js";
import { SlackInbox } from "../inbox.js";

const CONFIG = { appToken: "xapp-000000000000000", botToken: "xoxb-000000000000000", allowedTeamIds: ["T1"], allowedChannelIds: ["C1"], defaultDestination: "C1" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("slack channel", () => {
  it("marks both tokens env-only and rejects broad or unknown config", () => {
    const properties = slackConfigSchema.jsonSchema.properties as Record<string, Readonly<Record<string, unknown>>>;
    for (const key of ["appToken", "botToken"]) { expect(isEnvEligibleSchema(properties[key]!)).toBe(true); expect(isSecretSchema(properties[key]!)).toBe(true); }
    expect(() => parseSlackConfig({ ...CONFIG, appToken: { $env: "SLACK_APP_TOKEN" } })).toThrow(/resolved/u);
    expect(() => parseSlackConfig({ ...CONFIG, allowedTeamIds: [], surprise: true })).toThrow(/unknown/u);
  });

  it("normalizes one authorized Socket Mode event, ignores unauthorized events, and deduplicates delivery", async () => {
    let handler: SlackSocketEventHandler | undefined;
    const socket: SlackSocketTransport = { async start(next) { handler = next; }, async stop() {} };
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async () => ({ messageId: "2" }));
    const client: SlackApiClient = { async download(file) { return { id: file.id, kind: "file", name: file.name, mediaType: file.mediaType, sizeBytes: 1, data: new Uint8Array([1]) }; }, postMessage, async postFile() { return { messageId: "file" }; } };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (request) => ({ status: "completed", text: `${request.text}:${request.attachments.length}` }));
    const channel = createSlackChannel({ context: context(parseSlackConfig(CONFIG), dispatch), socketFactory: () => socket, clientFactory: () => client });
    expect(() => assertChannelModuleCompliance(monoAgentModule, { expectedPackageName: "@mono-agent/channel-slack" })).not.toThrow();
    expect(() => assertChannelInstanceCompliance(channel)).not.toThrow();
    await channel.start?.({ signal: new AbortController().signal });
    await handler?.({ kind: "message", envelopeId: "e0", teamId: "OTHER", channelId: "C1", messageId: "1", threadId: "1", userId: "U", text: "ignore", files: [], receivedAt: new Date().toISOString() });
    await handler?.({ kind: "message", envelopeId: "e1", teamId: "T1", channelId: "C1", messageId: "1", threadId: "1", userId: "U", text: "hello", files: [{ id: "F", name: "note.txt", mediaType: "text/plain", privateUrl: "https://files.slack.com/note" }], receivedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ conversationId: "slack:C1:1", text: "hello", attachments: [{ name: "note.txt" }] });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channelId: "C1", threadId: "1", text: "hello:1" }));
    const outbound = { conversationId: "slack:C1", text: "notice", idempotencyKey: "same" };
    await Promise.all([channel.deliver!(outbound, new AbortController().signal), channel.deliver!(outbound, new AbortController().signal)]);
    expect(postMessage.mock.calls.filter(([request]) => request.text === "notice")).toHaveLength(1);
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("routes AskUser actions, live input, and cancellation through supported Core controls", async () => {
    const now = new Date().toISOString();
    let handler: SlackSocketEventHandler | undefined;
    const socket: SlackSocketTransport = { async start(next) { handler = next; }, async stop() {} };
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async () => ({ messageId: "posted" }));
    const client: SlackApiClient = { async download() { throw new Error("unexpected download"); }, postMessage, async postFile() { return { messageId: "file" }; } };
    const offerLiveInput = vi.fn<NonNullable<ChannelHost["offerLiveInput"]>>(async (input) => ({ status: input.text === "steer" ? "applied" : "requeue" }));
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => ({ status: "accepted" }));
    const cancel = vi.fn<NonNullable<ChannelHost["cancel"]>>(async () => ({ status: "accepted" }));
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({ type: "ask-user", ask: { interactionId: "ask-1", requestedAt: now, questions: [{ id: "choice", prompt: "Choose", choices: [{ value: "yes", label: "Yes" }], allowFreeText: false, multiple: false }] } });
      return { status: "completed", text: "waiting" };
    });
    const channel = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), dispatch, { offerLiveInput, answerAsk, cancel }),
      socketFactory: () => socket,
      clientFactory: () => client,
    });
    expect(channel.capabilities).toMatchObject({ liveInput: true, askUser: true, cancellation: true, runtimeControl: false });
    await channel.start?.({ signal: new AbortController().signal });
    await handler?.({ kind: "message", envelopeId: "e1", teamId: "T1", channelId: "C1", messageId: "1", threadId: "1", userId: "U", text: "start", files: [], receivedAt: now });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    const token = postMessage.mock.calls.flatMap(([request]) => request.buttons ?? [])[0]?.value;
    expect(token).toEqual(expect.any(String));
    await handler?.({ kind: "action", envelopeId: "e2", teamId: "T1", channelId: "C1", messageId: "2", threadId: "1", userId: "U", actionId: "mono_agent_ask", value: token!, receivedAt: now });
    await handler?.({ kind: "message", envelopeId: "e3", teamId: "T1", channelId: "C1", messageId: "3", threadId: "1", userId: "U", text: "/cancel", files: [], receivedAt: now });
    await handler?.({ kind: "message", envelopeId: "e4", teamId: "T1", channelId: "C1", messageId: "4", threadId: "1", userId: "U", text: "steer", files: [], receivedAt: now });
    await vi.waitFor(() => expect(offerLiveInput).toHaveBeenCalledTimes(2));
    expect(answerAsk).toHaveBeenCalledWith("slack:C1:1", expect.objectContaining({ interactionId: "ask-1", answers: { choice: ["yes"] } }), expect.any(AbortSignal));
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "slack:C1:1" }));
    expect(offerLiveInput).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("rejects lookalike Slack attachment hosts before sending the bot credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createSlackWebApiClient(parseSlackConfig(CONFIG), fetchImpl);
    await expect(client.download({ id: "F", name: "secret.txt", mediaType: "text/plain", privateUrl: "https://evilslack.com/file" }, 1024, new AbortController().signal)).rejects.toThrow(/not trusted/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("durably admits before acknowledgement and deduplicates an envelope across restart", async () => {
    const dataDirectory = temporaryDirectory();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => {
      await dispatchGate;
      return { status: "completed", text: "done" };
    });
    const firstSocket = durableAckSocket(dataDirectory);
    const first = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), dispatch, {}, dataDirectory),
      socketFactory: () => firstSocket.transport,
      clientFactory: () => client(),
    });
    await first.start?.({ signal: new AbortController().signal });

    const event = message("durable-1", "persist me");
    await firstSocket.emit(event);
    await firstSocket.emit(event);
    expect(firstSocket.acknowledged).toEqual(["durable-1", "durable-1"]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    releaseDispatch();
    await vi.waitFor(async () => {
      expect(await first.health?.({ signal: new AbortController().signal })).toMatchObject({
        status: "healthy",
        details: { pendingEvents: 0, processingEvents: 0, completedReceipts: 1 },
      });
    });
    await first.stop?.({ signal: new AbortController().signal, reason: "shutdown" });

    const replayDispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({ status: "completed", text: "duplicate" }));
    const secondSocket = durableAckSocket(dataDirectory);
    const second = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), replayDispatch, {}, dataDirectory),
      socketFactory: () => secondSocket.transport,
      clientFactory: () => client(),
    });
    await second.start?.({ signal: new AbortController().signal });
    await secondSocket.emit(event);
    expect(secondSocket.acknowledged).toEqual(["durable-1"]);
    expect(replayDispatch).not.toHaveBeenCalled();
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("processes safely pending inbox work after restart", async () => {
    const dataDirectory = temporaryDirectory();
    const seeded = await SlackInbox.open(dataDirectory);
    await seeded.enqueue(message("pending-restart", "resume me"));
    await seeded.close();

    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({ status: "completed", text: "resumed" }));
    const channel = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), dispatch, {}, dataDirectory),
      socketFactory: () => durableAckSocket(dataDirectory).transport,
      clientFactory: () => client(),
    });
    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ requestId: "pending-restart", text: "resume me" });
    await vi.waitFor(async () => {
      expect(await channel.health?.({ signal: new AbortController().signal })).toMatchObject({
        status: "healthy",
        details: { pendingEvents: 0, processingEvents: 0, completedReceipts: 1 },
      });
    });
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("fails closed and retains an explicit failed record when queued processing becomes ambiguous", async () => {
    const dataDirectory = temporaryDirectory();
    const socket = durableAckSocket(dataDirectory);
    const failingClient = client({
      postMessage: vi.fn<SlackApiClient["postMessage"]>(async () => { throw new Error("ambiguous Slack post"); }),
    });
    const channel = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), async () => ({ status: "completed", text: "answer" }), {}, dataDirectory),
      socketFactory: () => socket.transport,
      clientFactory: () => failingClient,
    });
    await channel.start?.({ signal: new AbortController().signal });
    await socket.emit(message("failed-1", "fail after admission"));
    expect(socket.acknowledged).toEqual(["failed-1"]);
    await vi.waitFor(async () => {
      expect(await channel.health?.({ signal: new AbortController().signal })).toMatchObject({
        status: "unhealthy",
        details: { failedEvents: 1 },
      });
    });
    expect(channel.running).toBe(false);
    await channel.stop?.({ signal: new AbortController().signal, reason: "health-failed" });

    const restarted = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), async () => ({ status: "completed" }), {}, dataDirectory),
      socketFactory: () => durableAckSocket(dataDirectory).transport,
      clientFactory: () => client(),
    });
    await expect(restarted.start?.({ signal: new AbortController().signal })).rejects.toThrow(/operator|blocked|failed|recovery/iu);
    expect(restarted.running).toBe(false);
  });

  it("reports an unexpected Socket Mode error as stopped and unhealthy", async () => {
    let fail: SlackSocketFailureHandler | undefined;
    const socket: SlackSocketTransport = {
      async start(_handler, _signal, onFailure) { fail = onFailure; },
      async stop() {},
    };
    const channel = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), async () => ({ status: "completed" })),
      socketFactory: () => socket,
      clientFactory: () => client(),
    });
    await channel.start?.({ signal: new AbortController().signal });
    fail?.({ reason: "error", summary: "Slack Socket Mode connection failed." });
    expect(channel.running).toBe(false);
    await expect(channel.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "unhealthy",
      summary: "Slack Socket Mode connection failed.",
    });
    await channel.stop?.({ signal: new AbortController().signal, reason: "health-failed" });
  });

  it("sends the Socket Mode ACK only after durable admission and fails closed when admission rejects", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", fakeWebSocketClass(sockets));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      url: "wss://wss-primary.slack.com/link",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    const first = createSlackSocketModeTransport(parseSlackConfig(CONFIG), fetchImpl);
    await first.start(async () => admitted, new AbortController().signal);
    sockets[0]?.emitEnvelope(slackEnvelope("ack-after-durable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sockets[0]?.sent).toEqual([]);
    release();
    await vi.waitFor(() => expect(sockets[0]?.sent.map((entry) => JSON.parse(entry))).toEqual([
      { envelope_id: "ack-after-durable" },
    ]));
    await first.stop();

    const failure = vi.fn<SlackSocketFailureHandler>();
    const second = createSlackSocketModeTransport(parseSlackConfig(CONFIG), fetchImpl);
    await second.start(async () => { throw new Error("disk full"); }, new AbortController().signal, failure);
    sockets[1]?.emitEnvelope(slackEnvelope("no-ack"));
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith({
      reason: "ingestion-failed",
      summary: "Slack Socket Mode could not durably admit an envelope.",
    }));
    expect(sockets[1]?.sent).toEqual([]);
    expect(sockets[1]?.closeCodes).toContain(1011);
    await second.stop();

    const disconnectFailure = vi.fn<SlackSocketFailureHandler>();
    const third = createSlackSocketModeTransport(parseSlackConfig(CONFIG), fetchImpl);
    await third.start(async () => undefined, new AbortController().signal, disconnectFailure);
    sockets[2]?.emitEnvelope({ type: "disconnect", reason: "warning" });
    await vi.waitFor(() => expect(disconnectFailure).toHaveBeenCalledWith({
      reason: "closed",
      summary: "Slack Socket Mode requested a disconnect.",
    }));
    expect(sockets[2]?.sent).toEqual([]);
    expect(sockets[2]?.closeCodes).toContain(1012);
    await third.stop();
  });
});

function context(config: ReturnType<typeof parseSlackConfig>, dispatch: ChannelHost["dispatch"], controls: Partial<ChannelHost> = {}, dataDirectory = temporaryDirectory()): Parameters<typeof createSlackChannel>[0]["context"] {
  const host: ChannelHost = { grantedCapabilities: new Set(), getCapability() { return undefined; }, dispatch, ...controls };
  return { instanceId: "slack", config, provenance: {}, configDirectory: "/config", workspaceDirectory: "/workspace", dataDirectory, logger: logger(), host, signal: new AbortController().signal };
}
function logger(): ModuleLogger { return { debug() {}, info() {}, warn() {}, error() {} }; }

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "mono-agent-slack-"));
  temporaryDirectories.push(path);
  return join(path, "inbox");
}

function client(overrides: Partial<SlackApiClient> = {}): SlackApiClient {
  return {
    async download(file) { return { id: file.id, kind: "file", name: file.name, mediaType: file.mediaType, sizeBytes: 1, data: new Uint8Array([1]) }; },
    async postMessage() { return { messageId: "posted" }; },
    async postFile() { return { messageId: "file" }; },
    ...overrides,
  };
}

function message(envelopeId: string, text: string): SlackSocketEvent {
  return { kind: "message", envelopeId, teamId: "T1", channelId: "C1", messageId: "1", threadId: "1", userId: "U", text, files: [], receivedAt: new Date().toISOString() };
}

function durableAckSocket(dataDirectory: string): {
  readonly transport: SlackSocketTransport;
  readonly acknowledged: string[];
  emit(event: SlackSocketEvent): Promise<void>;
} {
  let handler: SlackSocketEventHandler | undefined;
  const acknowledged: string[] = [];
  return {
    transport: { async start(next) { handler = next; }, async stop() {} },
    acknowledged,
    async emit(event) {
      if (handler === undefined) throw new Error("socket is not started");
      await handler(event);
      const files = await readdir(dataDirectory);
      const persisted = (await Promise.all(files.map(async (name) => {
        try { return await readFile(join(dataDirectory, name), "utf8"); } catch { return ""; }
      }))).join("\n");
      expect(persisted).toContain(event.envelopeId);
      acknowledged.push(event.envelopeId);
    },
  };
}

function slackEnvelope(envelopeId: string): Record<string, unknown> {
  return {
    envelope_id: envelopeId,
    type: "events_api",
    payload: {
      team_id: "T1",
      event: { type: "message", channel: "C1", ts: "1", user: "U", text: "hello" },
    },
  };
}

function fakeWebSocketClass(instances: FakeWebSocket[]): typeof WebSocket {
  return class extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      instances.push(this);
    }
  } as unknown as typeof WebSocket;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly sent: string[] = [];
  readonly closeCodes: number[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") throw new TypeError("expected text frame");
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCodes.push(code);
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  emitEnvelope(value: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

import { mkdtempSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEnvEligibleSchema, isSecretSchema, type ChannelHost, type ModuleLogger } from "@mono-agent/module-sdk";
import {
  assertChannelBehaviorCompliance,
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
} from "@mono-agent/module-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlackChannel, createSlackSocketModeTransport, createSlackWebApiClient, monoAgentModule, parseSlackConfig, SlackDelivery, slackConfigSchema, type SlackApiClient, type SlackSocketEvent, type SlackSocketEventHandler, type SlackSocketFailureHandler, type SlackSocketTransport } from "../index.js";
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
    expect(parseSlackConfig({
      appToken: CONFIG.appToken,
      botToken: CONFIG.botToken,
      allowedTeamIds: ["T1"],
      allowAllChannels: true,
    }).allowedChannelIds).toEqual([]);
    expect(() => parseSlackConfig({
      ...CONFIG,
      defaultDestination: "C1:1712345678.000100:redirect",
    })).toThrow(/channel or channel:thread/u);
    expect(() => parseSlackConfig({
      ...CONFIG,
      allowedChannelIds: ["C1:redirect"],
    })).toThrow(/one non-empty identifier/u);
  });

  it("validates bounded shortcut and App Home actions against the destination allowlist", () => {
    const configured = parseSlackConfig({
      ...CONFIG,
      shortcuts: [{
        callbackId: "triage_request",
        prompt: "Prepare triage.",
        channelId: "C1",
        ackText: "Started.",
        threadReply: true,
      }],
      homeTab: {
        enabled: true,
        headerText: "*Quick actions*",
        buttons: [{
          actionId: "build_digest",
          label: "Build digest",
          prompt: "Build the digest.",
          channelId: "C1",
        }],
      },
    });
    expect(configured.shortcuts).toEqual([expect.objectContaining({
      callbackId: "triage_request",
      threadReply: true,
    })]);
    expect(configured.homeTab).toMatchObject({
      enabled: true,
      buttons: [{ actionId: "build_digest", threadReply: false }],
    });
    expect(() => parseSlackConfig({
      ...CONFIG,
      shortcuts: [{ callbackId: "one", prompt: "One" }, { callbackId: "ONE", prompt: "Two" }],
    })).toThrow(/unique/iu);
    expect(() => parseSlackConfig({
      ...CONFIG,
      shortcuts: [{ callbackId: "threaded", prompt: "Run", threadReply: true }],
    })).toThrow(/requires ackText/iu);
    expect(() => parseSlackConfig({
      ...CONFIG,
      homeTab: {
        enabled: true,
        buttons: [{ actionId: "unsafe", label: "Unsafe", prompt: "Run", channelId: "C2" }],
      },
    })).toThrow(/authorized/iu);
  });

  it("contributes an instance-bound message tool and resolves receipt-backed destination history", async () => {
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async () => ({
      messageId: "1712345678.000100",
    }));
    const channel = createSlackChannel({
      context: context(
        parseSlackConfig({ ...CONFIG, defaultDestination: "C1:1712345678.000100" }),
        async () => ({ status: "completed" }),
      ),
      socketFactory: () => ({ async start() {}, async stop() {} }),
      clientFactory: () => client({ postMessage }),
    });
    expect(channel.resolveDefaultDeliveryConversationId?.())
      .toBe("slack:C1:1712345678.000100");
    expect(channel.sendTools.map((tool) => tool.name)).toEqual([
      "SlackSendMessage",
    ]);
    const tool = channel.sendTools[0]!;
    const toolContext = {
      requestId: "request-1",
      conversationId: "producer",
      callId: "call-1",
      signal: new AbortController().signal,
    };
    const topLevel = await tool.prepare({
      channel: "C1",
      text: "Scheduled digest",
    }, toolContext);
    const result = await channel.deliver!({
      ...topLevel,
      idempotencyKey: "tool-top-level",
    }, toolContext.signal);
    expect(result).toMatchObject({
      status: "delivered",
      messageId: "1712345678.000100",
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C1",
      text: "Scheduled digest",
    }));
    expect(tool.historyConversationId(
      { ...topLevel, idempotencyKey: "tool-top-level" },
      result,
    )).toBe("slack:C1:1712345678.000100");

    const threaded = await tool.prepare({
      channel: "C1",
      thread_ts: "1700000000.000001",
      text: "Thread reply",
    }, { ...toolContext, callId: "call-2" });
    expect(tool.historyConversationId(
      { ...threaded, idempotencyKey: "tool-thread" },
      result,
    )).toBe("slack:C1:1700000000.000001");
    expect(() => tool.historyConversationId(
      { ...topLevel, idempotencyKey: "tool-unknown" },
      {
        status: "unknown",
        idempotencyKey: "tool-unknown",
      },
    )).toThrow(/confirmed delivery/u);
    expect(() => tool.historyConversationId(
      { ...topLevel, idempotencyKey: "tool-no-receipt" },
      {
        status: "delivered",
        idempotencyKey: "tool-no-receipt",
      },
    )).toThrow(/confirmed message id/u);
    expect(() => tool.historyConversationId(
      { ...topLevel, idempotencyKey: "tool-bad-receipt" },
      {
        status: "delivered",
        idempotencyKey: "tool-bad-receipt",
        messageId: "1712345678.000100 redirect",
      },
    )).toThrow(/confirmed message id/u);
    await expect(channel.deliver!({
      ...await tool.prepare({ channel: "C2", text: "forbidden" }, toolContext),
      idempotencyKey: "tool-forbidden",
    }, toolContext.signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "slack_destination_forbidden" },
    });
    expect(() => tool.prepare({
      channel: "C1:redirect",
      text: "unsafe",
    }, toolContext)).toThrow(/identifier/u);
    expect(() => tool.prepare({
      channel: "C 1",
      text: "unsafe",
    }, toolContext)).toThrow(/identifier/u);
    await expect(channel.deliver!({
      conversationId: "slack:C1:1700000000.000001:redirect",
      text: "unsafe",
      idempotencyKey: "tool-extra-segment",
    }, toolContext.signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "slack_destination_forbidden" },
    });
  });

  it("coalesces exact payloads, rejects conflicting keys, and keeps unknown outcomes sticky", async () => {
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async (request) => {
      if (request.text === "ambiguous") {
        throw new Error("secret transport detail /private/token");
      }
      return { messageId: "1712345678.000100" };
    });
    const delivery = new SlackDelivery(
      parseSlackConfig(CONFIG),
      client({ postMessage }),
    );
    const signal = new AbortController().signal;
    const message = {
      conversationId: "slack:C1",
      text: "one",
      idempotencyKey: "same",
    };
    await expect(Promise.all([
      delivery.deliver(message, signal),
      delivery.deliver(message, signal),
    ])).resolves.toEqual([
      expect.objectContaining({ status: "delivered" }),
      expect.objectContaining({ status: "delivered" }),
    ]);
    await expect(delivery.deliver(message, signal)).resolves.toMatchObject({
      status: "duplicate",
    });
    await expect(delivery.deliver({
      ...message,
      text: "different",
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "slack_delivery_idempotency_conflict" },
    });
    const metadata = Object.fromEntries([["é", "precomposed"], ["e\u0301", "decomposed"]]);
    const unicodeMessage = { ...message, idempotencyKey: "unicode-metadata", metadata };
    await expect(delivery.deliver(unicodeMessage, signal)).resolves.toMatchObject({
      status: "delivered",
    });
    await expect(delivery.deliver({
      ...unicodeMessage,
      metadata: Object.fromEntries(Object.entries(metadata).reverse()),
    }, signal)).resolves.toMatchObject({ status: "duplicate" });

    const ambiguous = {
      conversationId: "slack:C1",
      text: "ambiguous",
      idempotencyKey: "ambiguous",
    };
    const first = await delivery.deliver(ambiguous, signal);
    const second = await delivery.deliver(ambiguous, signal);
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: "unknown",
      idempotencyKey: "ambiguous",
      diagnostic: {
        code: "slack_delivery_unknown",
        severity: "error",
        message: "Slack delivery outcome is unknown.",
      },
    });
    expect(JSON.stringify(first)).not.toContain("secret transport");
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(delivery.degraded).toBe(true);
    expect(delivery.hasAmbiguousOutcome).toBe(true);
  });

  it("bounds and snapshots public delivery payloads before fingerprinting or transport", async () => {
    let releaseFile!: () => void;
    const fileGate = new Promise<void>((resolve) => { releaseFile = resolve; });
    let postedAttachment: Parameters<SlackApiClient["postFile"]>[0]["attachment"] | undefined;
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async () => ({
      messageId: "posted",
    }));
    const postFile = vi.fn<SlackApiClient["postFile"]>(async (request) => {
      postedAttachment = request.attachment;
      await fileGate;
      return { messageId: "file" };
    });
    const delivery = new SlackDelivery(
      parseSlackConfig({
        appToken: CONFIG.appToken,
        botToken: CONFIG.botToken,
        allowedTeamIds: ["T1"],
        allowAllChannels: true,
      }),
      client({ postMessage, postFile }),
    );
    const signal = new AbortController().signal;

    for (const conversationId of [
      "slack:C 1",
      `slack:${"C".repeat(129)}`,
      "slack:C1:\u0007thread",
    ]) {
      await expect(delivery.deliver({
        conversationId,
        text: "unsafe",
        idempotencyKey: `bad-destination-${conversationId.length}`,
      }, signal)).resolves.toMatchObject({
        status: "failed",
        diagnostic: { code: "slack_destination_forbidden" },
      });
    }

    await expect(delivery.deliver({
      conversationId: "slack:C1",
      text: "oversized metadata",
      idempotencyKey: "retry-after-invalid",
      metadata: { detail: "x".repeat(65_537) },
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "slack_delivery_invalid" },
    });
    await expect(delivery.deliver({
      conversationId: "slack:C1",
      text: "valid retry",
      idempotencyKey: "retry-after-invalid",
    }, signal)).resolves.toMatchObject({ status: "delivered" });

    const proxiedData = new Proxy(new Uint8Array([1]), {});
    await expect(delivery.deliver({
      conversationId: "slack:C1",
      text: "",
      attachments: [{
        id: "proxy",
        kind: "file",
        name: "proxy.bin",
        mediaType: "application/octet-stream",
        sizeBytes: 1,
        data: proxiedData,
      }],
      idempotencyKey: "proxy-data",
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "slack_delivery_invalid" },
    });

    const source = new Uint8Array([1, 2, 3]);
    const pending = delivery.deliver({
      conversationId: "slack:C1",
      text: "",
      attachments: [{
        id: "snapshot",
        kind: "file",
        name: "snapshot.bin",
        mediaType: "application/octet-stream",
        sizeBytes: source.byteLength,
        data: source,
      }],
      idempotencyKey: "snapshot",
    }, signal);
    await vi.waitFor(() => expect(postFile).toHaveBeenCalledOnce());
    source[0] = 9;
    expect(postedAttachment?.data).not.toBe(source);
    expect(postedAttachment?.data).toEqual(new Uint8Array([1, 2, 3]));
    releaseFile();
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("passes the reusable channel behavior compliance contract", async () => {
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async (request) => {
      if (request.text === "ambiguous compliance") {
        throw new Error("secret Slack transport failure /private/token");
      }
      return { messageId: "compliance-posted" };
    });
    await assertChannelBehaviorCompliance({
      create: () => createSlackChannel({
        context: context(
          parseSlackConfig(CONFIG),
          async () => ({ status: "completed" }),
        ),
        socketFactory: () => ({ async start() {}, async stop() {} }),
        clientFactory: () => client({ postMessage }),
      }),
      delivery: {
        delivered: {
          conversationId: "slack:C1",
          text: "compliance",
          idempotencyKey: "slack-compliance",
        },
        conflicting: {
          conversationId: "slack:C1",
          text: "conflicting compliance",
          idempotencyKey: "slack-compliance",
        },
        unknown: {
          conversationId: "slack:C1",
          text: "ambiguous compliance",
          idempotencyKey: "slack-compliance-unknown",
        },
      },
      secrets: [CONFIG.appToken, CONFIG.botToken, "secret Slack"],
      exercise(instance) {
        expect(instance.capabilities.proactive).toBe(true);
      },
    });
  });

  it("fails closed instead of evicting receipt authority at the live-instance bound", async () => {
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async (_request) => ({
      messageId: "posted",
    }));
    const delivery = new SlackDelivery(
      parseSlackConfig(CONFIG),
      client({ postMessage }),
    );
    const signal = new AbortController().signal;
    for (let index = 0; index < 1_000; index += 1) {
      await delivery.deliver({
        conversationId: "slack:C1",
        text: `notice-${String(index)}`,
        idempotencyKey: `key-${String(index)}`,
      }, signal);
    }
    await expect(delivery.deliver({
      conversationId: "slack:C1",
      text: "one too many",
      idempotencyKey: "capacity",
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "slack_delivery_receipt_capacity" },
    });
    expect(delivery.degraded).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1_000);
    await expect(delivery.deliver({
      conversationId: "slack:C1",
      text: "notice-0",
      idempotencyKey: "key-0",
    }, signal)).resolves.toMatchObject({ status: "duplicate" });
    expect(postMessage).toHaveBeenCalledTimes(1_000);
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
    expect(channel.resolveDefaultDeliveryConversationId?.()).toBe("slack:C1");
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
    expect(channel.capabilities).toMatchObject({ liveInput: true, askUser: true, approvals: false, cancellation: true, runtimeControl: true });
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

  it("uses assistant-thread status, retains a transient activity ledger, and applies per-thread runtime controls", async () => {
    let handler: SlackSocketEventHandler | undefined;
    const socket: SlackSocketTransport = { async start(next) { handler = next; }, async stop() {} };
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async () => ({ messageId: "posted" }));
    const setAssistantStatus = vi.fn<NonNullable<SlackApiClient["setAssistantStatus"]>>(async () => undefined);
    const addReaction = vi.fn<NonNullable<SlackApiClient["addReaction"]>>(async () => undefined);
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({ type: "activity", text: "Reading project files" });
      const health = await channel.health?.({ signal: new AbortController().signal });
      expect(health).toMatchObject({ details: { transientActivityEntries: 1 } });
      return { status: "completed", text: "done" };
    });
    const channel = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), dispatch),
      socketFactory: () => socket,
      clientFactory: () => client({ postMessage, setAssistantStatus, addReaction }),
    });
    await channel.start?.({ signal: new AbortController().signal });
    await handler?.(message("model", "/model runtime/model-a"));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/model-a/u) })));
    await handler?.(message("effort", "/effort high"));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/high/u) })));
    await handler?.(message("turn", "hello"));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "slack:C1:1",
      model: "runtime/model-a",
      effort: "high",
      text: "hello",
    });
    expect(setAssistantStatus).toHaveBeenCalledWith("C1", "1", "is thinking…", expect.any(AbortSignal));
    expect(setAssistantStatus).toHaveBeenCalledWith("C1", "1", "Reading project files", expect.any(AbortSignal));
    expect(addReaction).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect(await channel.health?.({ signal: new AbortController().signal })).toMatchObject({
        details: { transientActivityEntries: 0, deliveryMode: "final-only" },
      });
    });
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("falls back to the eyes reaction when assistant status is unavailable", async () => {
    const dataDirectory = temporaryDirectory();
    const socket = durableAckSocket(dataDirectory);
    const addReaction = vi.fn<NonNullable<SlackApiClient["addReaction"]>>(async () => undefined);
    const channel = createSlackChannel({
      context: context(parseSlackConfig(CONFIG), async () => ({ status: "completed", text: "done" }), {}, dataDirectory),
      socketFactory: () => socket.transport,
      clientFactory: () => client({
        async setAssistantStatus() { throw new Error("not an assistant thread"); },
        addReaction,
      }),
    });
    await channel.start?.({ signal: new AbortController().signal });
    await socket.emit(message("fallback", "hello"));
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledWith("C1", "1", "eyes", expect.any(AbortSignal)));
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("rejects lookalike Slack attachment hosts before sending the bot credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createSlackWebApiClient(parseSlackConfig(CONFIG), fetchImpl);
    await expect(client.download({ id: "F", name: "secret.txt", mediaType: "text/plain", privateUrl: "https://evilslack.com/file" }, 1024, new AbortController().signal)).rejects.toThrow(/not trusted/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls Slack's assistant thread status API with bounded auth transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = createSlackWebApiClient(parseSlackConfig(CONFIG), fetchImpl);
    await client.setAssistantStatus?.("C1", "1", "Reading files", new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/assistant.threads.setStatus",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ channel_id: "C1", thread_ts: "1", status: "Reading files" }),
      }),
    );
  });

  it("publishes App Home and runs configured shortcut and Home actions through allowlisted destinations", async () => {
    let handler: SlackSocketEventHandler | undefined;
    const socket: SlackSocketTransport = { async start(next) { handler = next; }, async stop() {} };
    let posted = 0;
    const postMessage = vi.fn<SlackApiClient["postMessage"]>(async () => ({ messageId: `posted-${++posted}` }));
    const publishHome = vi.fn<NonNullable<SlackApiClient["publishHome"]>>(async () => undefined);
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (request) => ({
      status: "completed",
      text: `done:${request.text}`,
    }));
    const channel = createSlackChannel({
      context: context(parseSlackConfig({
        ...CONFIG,
        shortcuts: [{
          callbackId: "triage_request",
          prompt: "Prepare triage.",
          ackText: "Triage started.",
          threadReply: true,
        }],
        homeTab: {
          enabled: true,
          headerText: "*Quick actions*",
          buttons: [{
            actionId: "build_digest",
            label: "Build digest",
            prompt: "Build the digest.",
            channelId: "C1",
          }],
        },
      }), dispatch),
      socketFactory: () => socket,
      clientFactory: () => client({ postMessage, publishHome }),
    });
    await channel.start?.({ signal: new AbortController().signal });
    await handler?.({
      kind: "home-opened",
      envelopeId: "home-opened-1",
      teamId: "T1",
      userId: "U1",
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(publishHome).toHaveBeenCalledOnce());
    expect(publishHome).toHaveBeenCalledWith("U1", {
      type: "home",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*Quick actions*" } },
        {
          type: "actions",
          elements: [{
            type: "button",
            action_id: "build_digest",
            text: { type: "plain_text", text: "Build digest", emoji: false },
          }],
        },
      ],
    }, expect.any(AbortSignal));

    await handler?.({
      kind: "shortcut",
      envelopeId: "shortcut-1",
      teamId: "T1",
      userId: "U1",
      callbackId: "triage_request",
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "slack:C1:posted-1",
      text: "Prepare triage.",
      metadata: { source: "shortcut" },
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C1",
      text: "done:Prepare triage.",
      threadId: "posted-1",
    }));

    await handler?.({
      kind: "home-action",
      envelopeId: "home-action-1",
      teamId: "T1",
      userId: "U1",
      actionId: "build_digest",
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      conversationId: "slack:C1:action-home-action-1",
      text: "Build the digest.",
      metadata: { source: "home-action" },
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C1",
      text: "done:Build the digest.",
    }));
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("normalizes Socket Mode shortcut and App Home envelopes before acknowledging them", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", fakeWebSocketClass(sockets));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      url: "wss://wss-primary.slack.com/link",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const received: SlackSocketEvent[] = [];
    const transport = createSlackSocketModeTransport(parseSlackConfig(CONFIG), fetchImpl);
    await transport.start(async (event) => { received.push(event); }, new AbortController().signal);
    sockets[0]?.emitEnvelope({
      envelope_id: "shortcut-envelope",
      type: "interactive",
      payload: {
        type: "message_action",
        callback_id: "triage_request",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "C1" },
        message: { ts: "20", thread_ts: "10" },
      },
    });
    sockets[0]?.emitEnvelope({
      envelope_id: "home-opened-envelope",
      type: "events_api",
      payload: {
        team_id: "T1",
        event: { type: "app_home_opened", user: "U1", tab: "home" },
      },
    });
    sockets[0]?.emitEnvelope({
      envelope_id: "home-action-envelope",
      type: "interactive",
      payload: {
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        view: { type: "home" },
        actions: [{ action_id: "build_digest" }],
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toEqual([
      expect.objectContaining({
        kind: "shortcut",
        callbackId: "triage_request",
        sourceChannelId: "C1",
        sourceMessageId: "20",
        sourceThreadId: "10",
      }),
      expect.objectContaining({ kind: "home-opened", userId: "U1" }),
      expect.objectContaining({ kind: "home-action", actionId: "build_digest" }),
    ]);
    await vi.waitFor(() => expect(sockets[0]?.sent.map((entry) => JSON.parse(entry))).toEqual([
      { envelope_id: "shortcut-envelope" },
      { envelope_id: "home-opened-envelope" },
      { envelope_id: "home-action-envelope" },
    ]));
    await transport.stop();
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

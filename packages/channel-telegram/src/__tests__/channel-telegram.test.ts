import { isEnvEligibleSchema, isSecretSchema, type ChannelHost, type ModuleLogger } from "@mono-agent/module-sdk";
import {
  assertChannelBehaviorCompliance,
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
} from "@mono-agent/module-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import {
  createTelegramChannel,
  createTelegramTranscriber,
  isWithinQuietHours,
  monoAgentModule,
  parseTelegramConfig,
  TelegramDelivery,
  telegramConfigSchema,
  type TelegramBotClient,
  type TelegramUpdate,
} from "../index.js";

const TOKEN = "1234567890:telegram-token-long-enough";

describe("telegram channel", () => {
  it("has strict env-only secret config and exact authorization", () => {
    const properties = telegramConfigSchema.jsonSchema.properties as Record<string, Readonly<Record<string, unknown>>>;
    expect(isEnvEligibleSchema(properties.botToken!)).toBe(true);
    expect(isSecretSchema(properties.botToken!)).toBe(true);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: [] })).toThrow(/at least one/u);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["1"], surprise: true })).toThrow(/unknown/u);
    expect(() => parseTelegramConfig({ botToken: { $env: "BOT" }, allowedChatIds: ["1"] })).toThrow(/resolved/u);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42:shadow"] })).toThrow(/colon/u);
    expect(parseTelegramConfig({ botToken: TOKEN, allowAllChats: true }).allowedChatIds).toEqual([]);
    const config = parseTelegramConfig({
      botToken: TOKEN,
      allowedChatIds: ["1"],
      quietHours: { start: "23:00", end: "07:00", timezone: "Europe/Rome" },
      transport: { ipFamily: 4 },
      transcription: {
        endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions",
        model: "large-v3",
      },
    });
    expect(config).toMatchObject({
      quietHours: { start: "23:00", end: "07:00", timezone: "Europe/Rome" },
      transport: { ipFamily: 4 },
      transcription: {
        endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions",
        model: "large-v3",
        timeoutMs: 120_000,
      },
    });
    expect(isWithinQuietHours(new Date("2026-01-01T23:30:00Z"), { start: "23:00", end: "07:00", timezone: "UTC" })).toBe(true);
    expect(isWithinQuietHours(new Date("2026-01-01T12:00:00Z"), { start: "23:00", end: "07:00", timezone: "UTC" })).toBe(false);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["1"], transport: { ipFamily: 5 } })).toThrow(/4 or 6/u);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["1"], quietHours: { start: "9pm", end: "07:00", timezone: "UTC" } })).toThrow(/HH:MM/u);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["1"], transcription: { endpoint: "file:///tmp/audio", model: "m" } })).toThrow(/HTTP/u);
  });

  it("contributes instance-bound message and file tools through the normal delivery allowlist", async () => {
    const sendMessage = vi.fn<TelegramBotClient["sendMessage"]>(async () => ({
      messageId: "message-1",
    }));
    const sendAttachment = vi.fn<TelegramBotClient["sendAttachment"]>(async () => ({
      messageId: "file-1",
    }));
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      sendMessage,
      sendAttachment,
    };
    const channel = createTelegramChannel({
      context: context(
        parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }),
        async () => ({ status: "completed" }),
      ),
      clientFactory: () => client,
    });
    expect(channel.resolveDefaultDeliveryConversationId?.()).toBeUndefined();
    expect(channel.sendTools.map((tool) => tool.name)).toEqual([
      "TelegramSendMessage",
      "TelegramSendFile",
    ]);
    const toolContext = {
      requestId: "request-1",
      conversationId: "producer",
      callId: "call-1",
      signal: new AbortController().signal,
    };
    const messageTool = channel.sendTools[0]!;
    const preparedMessage = await messageTool.prepare({
      chat_id: 42,
      text: "Choose",
      reply_options: ["Yes", "No"],
    }, toolContext);
    expect(preparedMessage).toEqual({
      conversationId: "telegram:42",
      text: "Choose",
      metadata: { telegram: { replyOptions: ["Yes", "No"] } },
    });
    const messageResult = await channel.deliver!({
      ...preparedMessage,
      idempotencyKey: "tool-message",
    }, toolContext.signal);
    expect(messageResult).toMatchObject({
      status: "delivered",
      messageId: "message-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "42",
      text: "Choose",
      buttons: [
        expect.objectContaining({ label: "Yes" }),
        expect.objectContaining({ label: "No" }),
      ],
    }));
    expect(channel.resolveDeliveryHistory?.(
      { ...preparedMessage, idempotencyKey: "tool-message" },
      messageResult,
    )).toEqual({ conversationId: "telegram:42" });
    expect(() => channel.resolveDeliveryHistory?.(
      { ...preparedMessage, conversationId: "telegram:42:shadow", idempotencyKey: "tool-invalid" },
      {
        status: "delivered",
        idempotencyKey: "tool-invalid",
      },
    )).toThrow(/invalid/u);

    const fileTool = channel.sendTools[1]!;
    const preparedFile = await fileTool.prepare({
      kind: "photo",
      chat_id: "42",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      filename: "photo.jpg",
      media_type: "image/jpeg",
      caption: "Rendered output",
    }, { ...toolContext, callId: "call-2" });
    const fileResult = await channel.deliver!({
      ...preparedFile,
      idempotencyKey: "tool-file",
    }, toolContext.signal);
    expect(fileResult).toMatchObject({ status: "delivered", messageId: "file-1" });
    expect(sendAttachment).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "42",
      caption: "Rendered output",
      attachment: expect.objectContaining({
        kind: "image",
        name: "photo.jpg",
        sizeBytes: 3,
      }),
    }));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const outputBytes = new Uint8Array([4, 5, 6, 7]);
    const readCurrentRunOutput = vi.fn(async () => ({
      id: "current-run-output:fixture",
      kind: "file" as const,
      name: "transcript.md",
      mediaType: "text/markdown",
      sizeBytes: outputBytes.byteLength,
      data: outputBytes,
    }));
    const preparedOutput = await fileTool.prepare({
      kind: "document",
      chat_id: "42",
      output_name: "transcript.md",
      caption: "Transcript",
    }, {
      ...toolContext,
      callId: "call-3",
      readCurrentRunOutput,
    });
    outputBytes[0] = 99;
    expect(readCurrentRunOutput).toHaveBeenCalledWith({
      name: "transcript.md",
      maxBytes: 10 * 1024 * 1024,
    });
    expect(preparedOutput).toMatchObject({
      conversationId: "telegram:42",
      text: "Transcript",
      attachments: [{
        name: "transcript.md",
        mediaType: "text/markdown",
        sizeBytes: 4,
        data: new Uint8Array([4, 5, 6, 7]),
      }],
    });
    await expect(fileTool.prepare({
      kind: "document",
      chat_id: "42",
      output_name: "../transcript.md",
    }, {
      ...toolContext,
      callId: "call-4",
      readCurrentRunOutput,
    })).rejects.toThrow(/safe basename/u);
    expect(readCurrentRunOutput).toHaveBeenCalledTimes(1);
    await expect(fileTool.prepare({
      kind: "document",
      chat_id: "42",
      output_name: "transcript.md",
    }, {
      ...toolContext,
      callId: "call-5",
    })).rejects.toThrow(/unavailable/u);
    await expect(fileTool.prepare({
      kind: "document",
      chat_id: "42",
      data: Buffer.from("inline").toString("base64"),
      output_name: "transcript.md",
      filename: "inline.txt",
    }, {
      ...toolContext,
      callId: "call-6",
      readCurrentRunOutput,
    })).rejects.toThrow(/exactly one/u);

    await expect(channel.deliver!({
      ...await messageTool.prepare({ chat_id: "99", text: "forbidden" }, toolContext),
      idempotencyKey: "tool-forbidden",
    }, toolContext.signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "telegram_destination_forbidden" },
    });
    expect(() => messageTool.prepare({
      chat_id: "42:shadow",
      text: "ambiguous",
    }, toolContext)).toThrow(/identifier/u);
    expect(() => messageTool.prepare({
      chat_id: "4 2",
      text: "ambiguous",
    }, toolContext)).toThrow(/identifier/u);
    await expect(channel.deliver!({
      conversationId: "telegram:42:shadow",
      text: "ambiguous",
      idempotencyKey: "tool-ambiguous",
    }, toolContext.signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "telegram_destination_forbidden" },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await expect(fileTool.prepare({
      kind: "document",
      chat_id: "42",
      data: "not-base64",
      filename: "../secret",
    }, toolContext)).rejects.toThrow(/base64|filename/u);
  });

  it("coalesces exact payloads, rejects conflicting keys, and keeps unknown outcomes sticky", async () => {
    const sendMessage = vi.fn<TelegramBotClient["sendMessage"]>(async (request) => {
      if (request.text === "ambiguous") {
        throw new Error("secret transport detail /private/token");
      }
      return { messageId: "message-1" };
    });
    const client: TelegramBotClient = {
      async poll() { return []; },
      async download() { throw new Error("unexpected download"); },
      sendMessage,
      async sendAttachment() { return { messageId: "attachment-1" }; },
    };
    const delivery = new TelegramDelivery(
      parseTelegramConfig({
        botToken: TOKEN,
        allowedChatIds: ["42"],
      }),
      client,
    );
    const signal = new AbortController().signal;
    const message = {
      conversationId: "telegram:42",
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
      diagnostic: { code: "telegram_delivery_idempotency_conflict" },
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
      conversationId: "telegram:42",
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
        code: "telegram_delivery_unknown",
        severity: "error",
        message: "Telegram delivery outcome is unknown.",
      },
    });
    expect(JSON.stringify(first)).not.toContain("secret transport");
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(delivery.degraded).toBe(true);
    expect(delivery.hasAmbiguousOutcome).toBe(true);
  });

  it("bounds and snapshots public delivery payloads before fingerprinting or transport", async () => {
    let releaseAttachment!: () => void;
    const attachmentGate = new Promise<void>((resolve) => {
      releaseAttachment = resolve;
    });
    let postedAttachment: Parameters<TelegramBotClient["sendAttachment"]>[0]["attachment"] | undefined;
    const sendMessage = vi.fn<TelegramBotClient["sendMessage"]>(async () => ({
      messageId: "posted",
    }));
    const sendAttachment = vi.fn<TelegramBotClient["sendAttachment"]>(
      async (request) => {
        postedAttachment = request.attachment;
        await attachmentGate;
        return { messageId: "attachment" };
      },
    );
    const delivery = new TelegramDelivery(
      parseTelegramConfig({
        botToken: TOKEN,
        allowAllChats: true,
      }),
      {
        async poll() { return []; },
        async download() { throw new Error("unexpected download"); },
        sendMessage,
        sendAttachment,
      },
    );
    const signal = new AbortController().signal;

    for (const conversationId of [
      "telegram:4 2",
      `telegram:${"4".repeat(129)}`,
      "telegram:42\u0007shadow",
    ]) {
      await expect(delivery.deliver({
        conversationId,
        text: "unsafe",
        idempotencyKey: `bad-destination-${conversationId.length}`,
      }, signal)).resolves.toMatchObject({
        status: "failed",
        diagnostic: { code: "telegram_destination_forbidden" },
      });
    }

    await expect(delivery.deliver({
      conversationId: "telegram:42",
      text: "oversized metadata",
      idempotencyKey: "retry-after-invalid",
      metadata: { detail: "x".repeat(65_537) },
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "telegram_delivery_invalid" },
    });
    await expect(delivery.deliver({
      conversationId: "telegram:42",
      text: "valid retry",
      idempotencyKey: "retry-after-invalid",
    }, signal)).resolves.toMatchObject({ status: "delivered" });

    const proxiedData = new Proxy(new Uint8Array([1]), {});
    await expect(delivery.deliver({
      conversationId: "telegram:42",
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
      diagnostic: { code: "telegram_delivery_invalid" },
    });

    const source = new Uint8Array([1, 2, 3]);
    const pending = delivery.deliver({
      conversationId: "telegram:42",
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
    await vi.waitFor(() => expect(sendAttachment).toHaveBeenCalledOnce());
    source[0] = 9;
    expect(postedAttachment?.data).not.toBe(source);
    expect(postedAttachment?.data).toEqual(new Uint8Array([1, 2, 3]));
    releaseAttachment();
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("passes the reusable channel behavior compliance contract", async () => {
    const sendMessage = vi.fn<TelegramBotClient["sendMessage"]>(
      async (request) => {
        if (request.text === "ambiguous compliance") {
          throw new Error("secret Telegram transport failure /private/token");
        }
        return { messageId: "compliance-posted" };
      },
    );
    await assertChannelBehaviorCompliance({
      create: () => createTelegramChannel({
        context: context(
          parseTelegramConfig({
            botToken: TOKEN,
            allowedChatIds: ["42"],
          }),
          async () => ({ status: "completed" }),
        ),
        clientFactory: () => ({
          async poll(_offset, _timeout, signal) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return [];
          },
          async download() { throw new Error("unexpected download"); },
          sendMessage,
          async sendAttachment() { return { messageId: "attachment" }; },
        }),
      }),
      delivery: {
        delivered: {
          conversationId: "telegram:42",
          text: "compliance",
          idempotencyKey: "telegram-compliance",
        },
        conflicting: {
          conversationId: "telegram:42",
          text: "conflicting compliance",
          idempotencyKey: "telegram-compliance",
        },
        unknown: {
          conversationId: "telegram:42",
          text: "ambiguous compliance",
          idempotencyKey: "telegram-compliance-unknown",
        },
      },
      secrets: [TOKEN, "secret Telegram"],
      exercise(instance) {
        expect(instance.capabilities.proactive).toBe(true);
      },
    });
  });

  it("fails closed instead of evicting receipt authority at the live-instance bound", async () => {
    const sendMessage = vi.fn<TelegramBotClient["sendMessage"]>(async () => ({
      messageId: "sent",
    }));
    const delivery = new TelegramDelivery(
      parseTelegramConfig({
        botToken: TOKEN,
        allowedChatIds: ["42"],
      }),
      {
        async poll() { return []; },
        async download() { throw new Error("unexpected download"); },
        sendMessage,
        async sendAttachment() { return { messageId: "attachment" }; },
      },
    );
    const signal = new AbortController().signal;
    for (let index = 0; index < 1_000; index += 1) {
      await delivery.deliver({
        conversationId: "telegram:42",
        text: `notice-${String(index)}`,
        idempotencyKey: `key-${String(index)}`,
      }, signal);
    }
    await expect(delivery.deliver({
      conversationId: "telegram:42",
      text: "one too many",
      idempotencyKey: "capacity",
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "telegram_delivery_receipt_capacity" },
    });
    expect(delivery.degraded).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1_000);
    await expect(delivery.deliver({
      conversationId: "telegram:42",
      text: "notice-0",
      idempotencyKey: "key-0",
    }, signal)).resolves.toMatchObject({ status: "duplicate" });
    expect(sendMessage).toHaveBeenCalledTimes(1_000);
  });

  it("normalizes authorized media, ignores unauthorized chats, and deduplicates proactive delivery", async () => {
    const updates: TelegramUpdate[] = [
      { updateId: 1, kind: "message", chatId: "forbidden", messageId: "10", senderId: "u", text: "ignore", attachments: [], receivedAt: new Date().toISOString() },
      { updateId: 2, kind: "message", chatId: "42", messageId: "11", senderId: "u", senderName: "Ada", text: "hello", attachments: [{ fileId: "f", name: "../../note.txt", mediaType: "text/plain" }], receivedAt: new Date().toISOString() },
    ];
    let firstPoll = true;
    const sent = vi.fn<TelegramBotClient["sendMessage"]>(async () => ({ messageId: "sent-1" }));
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (firstPoll) { firstPoll = false; return updates; }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download(attachment) { return { id: attachment.fileId, kind: "file", name: attachment.name.split("/").at(-1)!, mediaType: attachment.mediaType, sizeBytes: 1, data: new Uint8Array([1]) }; },
      sendMessage: sent,
      async sendAttachment() { return { messageId: "attachment-1" }; },
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (request) => ({ status: "completed", text: `${request.text}:${request.attachments[0]?.name}` }));
    const channel = createTelegramChannel({ context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"], defaultDestination: "42" }), dispatch), clientFactory: () => client });
    expect(() => assertChannelModuleCompliance(monoAgentModule, { expectedPackageName: "@mono-agent/channel-telegram" })).not.toThrow();
    expect(() => assertChannelInstanceCompliance(channel)).not.toThrow();
    expect(channel.resolveDefaultDeliveryConversationId?.()).toBe("telegram:42");
    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ conversationId: "telegram:42", sender: { id: "u", displayName: "Ada" }, attachments: [{ name: "note.txt" }] });
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ chatId: "42", text: "hello:note.txt" }));

    const outbound = { conversationId: "telegram:42", text: "notice", idempotencyKey: "same" };
    await Promise.all([channel.deliver!(outbound, new AbortController().signal), channel.deliver!(outbound, new AbortController().signal)]);
    expect(sent.mock.calls.filter(([request]) => request.text === "notice")).toHaveLength(1);
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("routes AskUser buttons, live input, and cancellation through supported Core controls", async () => {
    const now = new Date().toISOString();
    let stage = 0;
    let callbackToken: string | undefined;
    let sentCount = 0;
    const sent = vi.fn<TelegramBotClient["sendMessage"]>(async (request) => {
      callbackToken ??= request.buttons?.[0]?.data;
      sentCount += 1;
      return { messageId: `sent-${String(sentCount)}` };
    });
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (stage === 0) { stage += 1; return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "start", attachments: [], receivedAt: now }]; }
        if (stage === 1 && callbackToken !== undefined) { stage += 1; return [{ updateId: 2, kind: "callback", callbackId: "callback-1", chatId: "42", messageId: "2", senderId: "U", data: callbackToken, receivedAt: now }]; }
        if (stage === 2) { stage += 1; return [{ updateId: 3, kind: "message", chatId: "42", messageId: "3", senderId: "U", text: "/cancel", attachments: [], receivedAt: now }]; }
        if (stage === 3) { stage += 1; return [{ updateId: 4, kind: "message", chatId: "42", messageId: "4", senderId: "U", text: "steer", attachments: [], receivedAt: now }]; }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      sendMessage: sent,
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const offerLiveInput = vi.fn<NonNullable<ChannelHost["offerLiveInput"]>>(async (input) => ({ status: input.text === "steer" ? "applied" : "requeue" }));
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => ({ status: "accepted" }));
    const cancel = vi.fn<NonNullable<ChannelHost["cancel"]>>(async () => ({ status: "accepted" }));
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({ type: "ask-user", ask: { interactionId: "ask-1", requestedAt: now, questions: [{ id: "choice", prompt: "Choose", choices: [{ value: "yes", label: "Yes" }], allowFreeText: false, multiple: false }] } });
      return { status: "completed", text: "waiting" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch, { offerLiveInput, answerAsk, cancel }),
      clientFactory: () => client,
    });
    expect(channel.capabilities).toMatchObject({ liveInput: true, askUser: true, approvals: false, cancellation: true, runtimeControl: true });
    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(answerAsk).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(offerLiveInput).toHaveBeenCalledTimes(2);
    });
    expect(answerAsk).toHaveBeenCalledWith("telegram:42", expect.objectContaining({ interactionId: "ask-1", answers: { choice: ["yes"] } }), expect.any(AbortSignal));
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "telegram:42" }));
    expect(dispatch).toHaveBeenCalledOnce();
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("applies per-chat runtime controls, transcribes audio, and edits activity in place", async () => {
    const now = new Date().toISOString();
    let poll = 0;
    const sent = vi.fn<TelegramBotClient["sendMessage"]>(async () => ({ messageId: "status-1" }));
    const edit = vi.fn<NonNullable<TelegramBotClient["editMessage"]>>(async () => undefined);
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        poll += 1;
        if (poll === 1) return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "/model runtime/model-a", attachments: [], receivedAt: now }];
        if (poll === 2) return [{ updateId: 2, kind: "message", chatId: "42", messageId: "2", senderId: "U", text: "/effort high", attachments: [], receivedAt: now }];
        if (poll === 3) return [{ updateId: 3, kind: "message", chatId: "42", messageId: "3", senderId: "U", text: "summarize", attachments: [{ fileId: "voice", name: "voice.ogg", mediaType: "audio/ogg", transcriptionEligible: true }], receivedAt: now }];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { return { id: "voice", kind: "audio", name: "voice.ogg", mediaType: "audio/ogg", sizeBytes: 3, data: new Uint8Array([1, 2, 3]) }; },
      async transcribe() { return "spoken words"; },
      sendMessage: sent,
      editMessage: edit,
      async sendAttachment() { return { messageId: "attachment" }; },
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({ type: "activity", text: "Thinking" });
      await reply.emit({ type: "activity", text: "Still thinking" });
      return { status: "completed", text: "done" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({
        botToken: TOKEN,
        allowedChatIds: ["42"],
        transcription: { endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions", model: "large-v3" },
      }), dispatch),
      clientFactory: () => client,
    });
    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "telegram:42",
      model: "runtime/model-a",
      effort: "high",
      text: "summarize\n\n[Transcript of voice.ogg]\nspoken words",
      attachments: [{ name: "voice.ogg" }],
    });
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ messageId: "status-1", text: "Still thinking" }));
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("keeps non-blocking reply options distinct from AskUser and silences proactive delivery in quiet hours", async () => {
    let callbackData: string | undefined;
    let delivered: Parameters<TelegramBotClient["sendMessage"]>[0] | undefined;
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (callbackData !== undefined) {
          const data = callbackData;
          callbackData = undefined;
          return [{ updateId: 2, kind: "callback", callbackId: "reply-callback", chatId: "42", messageId: "2", senderId: "U", data, receivedAt: new Date().toISOString() }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage(request) {
        delivered = request;
        callbackData = request.buttons?.[0]?.data;
        return { messageId: "sent" };
      },
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const config = parseTelegramConfig({
      botToken: TOKEN,
      allowedChatIds: ["42"],
      defaultDestination: "42",
      quietHours: { start: "23:00", end: "07:00", timezone: "UTC" },
    });
    const delivery = new TelegramDelivery(config, client, () => new Date("2026-01-01T23:30:00Z"));
    expect(await delivery.deliver({
      conversationId: "telegram:42",
      text: "Proceed?",
      idempotencyKey: "reply-options",
      metadata: { telegram: { replyOptions: ["Yes", "No"] } },
    }, new AbortController().signal)).toMatchObject({ status: "delivered" });
    expect(delivered).toMatchObject({
      disableNotification: true,
      buttons: [{ label: "Yes" }, { label: "No" }],
    });

    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({ status: "completed", text: "accepted" }));
    const channel = createTelegramChannel({ context: context(config, dispatch), clientFactory: () => client });
    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ text: "Yes", conversationId: "telegram:42" });
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("bounds OpenAI-compatible transcription responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("large-v3");
      return new Response(JSON.stringify({ text: " transcript " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const transcribe = createTelegramTranscriber({
      endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions",
      model: "large-v3",
      timeoutMs: 1_000,
    }, fetchImpl);
    await expect(transcribe({
      id: "audio",
      kind: "audio",
      name: "voice.ogg",
      mediaType: "audio/ogg",
      sizeBytes: 1,
      data: new Uint8Array([1]),
    }, new AbortController().signal)).resolves.toBe("transcript");
  });
});

function context(config: ReturnType<typeof parseTelegramConfig>, dispatch: ChannelHost["dispatch"], controls: Partial<ChannelHost> = {}): Parameters<typeof createTelegramChannel>[0]["context"] {
  const host: ChannelHost = { grantedCapabilities: new Set(), getCapability() { return undefined; }, dispatch, ...controls };
  return { instanceId: "telegram", config, provenance: {}, configDirectory: "/config", workspaceDirectory: "/workspace", dataDirectory: "/data", logger: logger(), host, signal: new AbortController().signal };
}

function logger(): ModuleLogger { return { debug() {}, info() {}, warn() {}, error() {} }; }

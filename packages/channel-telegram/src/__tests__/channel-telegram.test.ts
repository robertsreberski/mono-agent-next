import {
  isEnvEligibleSchema,
  isSecretSchema,
  parseAskUserAnswer,
  type AskUserRequest,
  type ChannelHost,
  type ModuleLogger,
} from "@mono-agent/module-sdk";
import {
  assertChannelBehaviorCompliance,
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
} from "@mono-agent/module-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import {
  createTelegramBotApiClient,
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
import { readBoundedBytes } from "../http.js";

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

  it("advances past unsupported raw Telegram update kinds", async () => {
    const offsets: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { readonly offset: number };
      offsets.push(body.offset);
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{ update_id: 7, edited_message: { message_id: 1 } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      await new Promise<void>((resolve) => {
        if (init?.signal?.aborted === true) resolve();
        else init?.signal?.addEventListener("abort", () => { resolve(); }, { once: true });
      });
      throw new Error("poll aborted");
    });
    const botClient = createTelegramBotApiClient(
      parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }),
      fetchImpl,
    );
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({ status: "completed" }));
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch),
      clientFactory: () => botClient,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(offsets).toContain(8));
    expect(offsets.slice(0, 2)).toEqual([0, 8]);
    expect(dispatch).not.toHaveBeenCalled();
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
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

  it("does not wedge the poll loop and emits an error reaction when an outbound send fails", async () => {
    const now = new Date().toISOString();
    const offsets: number[] = [];
    let firstPoll = true;
    const sendMessage = vi.fn<TelegramBotClient["sendMessage"]>(async (request) => {
      if (request.text === "failed outbound") throw new Error("Telegram HTTP 400");
      return { messageId: "sent" };
    });
    const setReaction = vi.fn<NonNullable<TelegramBotClient["setReaction"]>>(async () => undefined);
    const client: TelegramBotClient = {
      async poll(offset, _timeout, signal) {
        offsets.push(offset);
        if (firstPoll) {
          firstPoll = false;
          return [
            { updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "poison", attachments: [], receivedAt: now },
            { updateId: 2, kind: "message", chatId: "42", messageId: "2", senderId: "U", text: "newer", attachments: [], receivedAt: now },
          ];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      sendMessage,
      async sendAttachment() { return { messageId: "attachment" }; },
      setReaction,
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (request) => ({
      status: "completed",
      text: request.text === "poison" ? "failed outbound" : "newer delivered",
    }));
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(offsets).toContain(3));
    expect(dispatch.mock.calls.map(([request]) => request.text)).toEqual(["poison", "newer"]);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "newer delivered" }));
    expect(setReaction).toHaveBeenCalledWith("42", "1", "👎", expect.any(AbortSignal));
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("removes each poll-retry abort listener after the delay settles", async () => {
    vi.useFakeTimers();
    try {
      let pollSignal!: AbortSignal;
      const poll = vi.fn<TelegramBotClient["poll"]>(async (_offset, _timeout, signal) => {
        if (pollSignal === undefined) {
          pollSignal = signal;
          vi.spyOn(signal, "addEventListener");
          vi.spyOn(signal, "removeEventListener");
        }
        throw new Error("poll failed");
      });
      const client: TelegramBotClient = {
        poll,
        async download() { throw new Error("unexpected download"); },
        async sendMessage() { return { messageId: "sent" }; },
        async sendAttachment() { return { messageId: "attachment" }; },
      };
      const channel = createTelegramChannel({
        context: context(
          parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }),
          async () => ({ status: "completed" }),
        ),
        clientFactory: () => client,
      });

      await channel.start?.({ signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(1_300);
      await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });

      expect(poll.mock.calls.length).toBeGreaterThan(12);
      const added = vi.mocked(pollSignal.addEventListener).mock.calls
        .filter(([type]) => type === "abort").length;
      const removed = vi.mocked(pollSignal.removeEventListener).mock.calls
        .filter(([type]) => type === "abort").length;
      expect(removed).toBe(added);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances offset when an attachment download fails mid-turn", async () => {
    const now = new Date().toISOString();
    const offsets: number[] = [];
    let firstPoll = true;
    const download = vi.fn<TelegramBotClient["download"]>(async () => {
      throw new Error("download failed");
    });
    const client: TelegramBotClient = {
      async poll(offset, _timeout, signal) {
        offsets.push(offset);
        if (firstPoll) {
          firstPoll = false;
          return [
            {
              updateId: 10,
              kind: "message",
              chatId: "42",
              messageId: "10",
              senderId: "U",
              text: "attachment",
              attachments: [{ fileId: "bad", name: "bad.bin", mediaType: "application/octet-stream" }],
              receivedAt: now,
            },
            { updateId: 11, kind: "message", chatId: "42", messageId: "11", senderId: "U", text: "after", attachments: [], receivedAt: now },
          ];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      download,
      async sendMessage() { return { messageId: "sent" }; },
      async sendAttachment() { return { messageId: "attachment" }; },
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({ status: "completed", text: "ok" }));
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(offsets).toContain(12));
    expect(download).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].text).toBe("after");
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("chunks final replies and AskUser prompts while bounding editable activity", async () => {
    const now = new Date().toISOString();
    const askPrompt = "P".repeat(9_000);
    const finalReply = "F".repeat(9_000);
    const sent: Parameters<TelegramBotClient["sendMessage"]>[0][] = [];
    const edited: Parameters<NonNullable<TelegramBotClient["editMessage"]>>[0][] = [];
    let firstPoll = true;
    const client: TelegramBotClient = {
      async poll(_offset, timeout, signal) {
        if (timeout === 0) return [];
        if (firstPoll) {
          firstPoll = false;
          return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "start", attachments: [], receivedAt: now }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage(request) {
        sent.push(request);
        return { messageId: "status" };
      },
      async editMessage(request) { edited.push(request); },
      async sendAttachment() { return { messageId: "attachment" }; },
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({ type: "activity", text: "A".repeat(5_000) });
      await reply.emit({ type: "activity", text: "B".repeat(5_000) });
      await reply.emit({
        type: "ask-user",
        ask: {
          interactionId: "long-ask",
          requestedAt: now,
          questions: [{
            id: "choice",
            prompt: askPrompt,
            choices: [{ value: "yes", label: "Yes" }],
            allowFreeText: false,
            multiple: false,
          }],
        },
      });
      return { status: "completed", text: finalReply };
    });
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => ({ status: "accepted" }));
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch, { answerAsk }),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(sent.filter((request) => request.text.startsWith("F"))).toHaveLength(3);
    });
    expect(sent.every((request) => request.text.length <= 4_096)).toBe(true);
    expect(edited.every((request) => request.text.length <= 4_096)).toBe(true);
    expect(sent[0]?.text).toHaveLength(4_096);
    expect(sent[0]?.text.endsWith("…")).toBe(true);
    expect(edited[0]?.text).toHaveLength(4_096);
    expect(edited[0]?.text.endsWith("…")).toBe(true);
    const promptMessages = sent.filter((request) => request.text.startsWith("P"));
    expect(promptMessages.map((request) => request.text).join("")).toBe(askPrompt);
    expect(promptMessages.slice(0, -1).every((request) => request.buttons === undefined)).toBe(true);
    expect(promptMessages.at(-1)?.buttons).toHaveLength(1);
    expect(sent.filter((request) => request.text.startsWith("F")).map((request) => request.text).join("")).toBe(finalReply);
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("lets an active turn finish during graceful drain", async () => {
    const now = new Date().toISOString();
    let firstPoll = true;
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let turnSignal: AbortSignal | undefined;
    const client: TelegramBotClient = {
      async poll(_offset, timeout, signal) {
        if (timeout === 0) return [];
        if (firstPoll) {
          firstPoll = false;
          return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "work", attachments: [], receivedAt: now }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage() { return { messageId: "sent" }; },
      async sendAttachment() { return { messageId: "attachment" }; },
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (request) => {
      turnSignal = request.signal;
      await turnGate;
      return { status: "completed", text: "done" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const draining = channel.drain?.({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 1_000).toISOString(),
    });
    await Promise.resolve();
    expect(turnSignal?.aborted).toBe(false);
    releaseTurn();
    await draining;
    expect(turnSignal?.aborted).toBe(false);
    expect(channel.running).toBe(false);
  });

  it("confirms a drained update before a fresh channel can poll it again", async () => {
    const now = new Date().toISOString();
    const offsets: number[] = [];
    let pending: TelegramUpdate[] = [
      { updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "work", attachments: [], receivedAt: now },
    ];
    const clientFactory = (): TelegramBotClient => ({
      async poll(offset, timeout, signal) {
        offsets.push(offset);
        if (offset > 0) pending = pending.filter((update) => update.updateId >= offset);
        if (pending.length > 0) return [...pending];
        if (timeout === 0) return [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { resolve(); }, { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage() { return { messageId: "sent" }; },
      async sendAttachment() { return { messageId: "attachment" }; },
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => {
      await turnGate;
      return { status: "completed", text: "done" };
    });
    const config = parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] });
    const first = createTelegramChannel({
      context: context(config, dispatch),
      clientFactory,
    });

    await first.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const draining = Promise.resolve(first.drain?.({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 1_000).toISOString(),
    }));
    releaseTurn();
    await draining;
    expect(offsets).toEqual([0, 2]);
    expect(pending).toEqual([]);

    const second = createTelegramChannel({
      context: context(config, dispatch),
      clientFactory,
    });
    await second.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(offsets).toEqual([0, 2, 0]));
    expect(dispatch).toHaveBeenCalledOnce();
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("rejects an aborted confirmation and lets a fresh channel replay the exact update", async () => {
    const now = new Date().toISOString();
    const pending: TelegramUpdate = {
      updateId: 1,
      kind: "message",
      chatId: "42",
      messageId: "1",
      senderId: "U",
      text: "replay me",
      attachments: [],
      receivedAt: now,
    };
    let clientNumber = 0;
    let confirmationStarted!: () => void;
    const confirmationStart = new Promise<void>((resolve) => { confirmationStarted = resolve; });
    const clientFactory = (): TelegramBotClient => {
      clientNumber += 1;
      const currentClient = clientNumber;
      let delivered = false;
      return {
        async poll(offset, timeout, signal) {
          if (offset === 0 && !delivered) {
            delivered = true;
            return [pending];
          }
          if (timeout === 0) {
            if (currentClient === 1) {
              confirmationStarted();
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => { reject(new Error("confirmation aborted")); }, { once: true });
              });
            }
            return [];
          }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => { reject(new Error("poll aborted")); }, { once: true });
          });
          return [];
        },
        async download() { throw new Error("unexpected download"); },
        async sendMessage() { return { messageId: "sent" }; },
        async sendAttachment() { return { messageId: "attachment" }; },
      };
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({
      status: "completed",
      text: "done",
    }));
    const config = parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] });
    const first = createTelegramChannel({
      context: context(config, dispatch),
      clientFactory,
    });
    const drainController = new AbortController();

    await first.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const draining = Promise.resolve(first.drain?.({
      signal: drainController.signal,
      deadline: new Date(Date.now() + 1_000).toISOString(),
    }));
    await confirmationStart;
    drainController.abort(new Error("host shutdown aborted"));
    await expect(draining).rejects.toThrow("Telegram update confirmation is degraded.");
    await expect(first.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      summary: "Telegram update confirmation is degraded.",
    });

    const second = createTelegramChannel({
      context: context(config, dispatch),
      clientFactory,
    });
    await second.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([request]) => request.text)).toEqual(["replay me", "replay me"]);
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("hard-bounds offset confirmation when the transport ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date().toISOString();
      let firstPoll = true;
      let confirmationSignal: AbortSignal | undefined;
      let confirmationStarted!: () => void;
      const confirmationStart = new Promise<void>((resolve) => { confirmationStarted = resolve; });
      let dispatched!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => { dispatched = resolve; });
      const client: TelegramBotClient = {
        async poll(_offset, timeout, signal) {
          if (firstPoll) {
            firstPoll = false;
            return [{
              updateId: 1,
              kind: "message",
              chatId: "42",
              messageId: "1",
              senderId: "U",
              text: "work",
              attachments: [],
              receivedAt: now,
            }];
          }
          if (timeout === 0) {
            confirmationSignal = signal;
            confirmationStarted();
            return await new Promise<readonly TelegramUpdate[]>(() => undefined);
          }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => { reject(new Error("poll aborted")); }, { once: true });
          });
          return [];
        },
        async download() { throw new Error("unexpected download"); },
        async sendMessage() { return { messageId: "sent" }; },
        async sendAttachment() { return { messageId: "attachment" }; },
      };
      const channel = createTelegramChannel({
        context: context(
          parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }),
          async () => {
            dispatched();
            return { status: "completed", text: "done" };
          },
        ),
        clientFactory: () => client,
      });

      await channel.start?.({ signal: new AbortController().signal });
      await dispatchStarted;
      const draining = Promise.resolve(channel.drain?.({
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 100).toISOString(),
      }));
      await confirmationStart;
      const rejected = expect(draining).rejects.toThrow("Telegram update confirmation is degraded.");
      await vi.advanceTimersByTimeAsync(101);
      await rejected;
      expect(confirmationSignal?.aborted).toBe(true);
      await expect(channel.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
        status: "degraded",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels and joins offset confirmation when stop races graceful drain", async () => {
    const now = new Date().toISOString();
    let firstPoll = true;
    let confirmationSignal: AbortSignal | undefined;
    let confirmationStarted!: () => void;
    const confirmationStart = new Promise<void>((resolve) => { confirmationStarted = resolve; });
    let closeStarted!: () => void;
    const closeStart = new Promise<void>((resolve) => { closeStarted = resolve; });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => {
      closeStarted();
      await closeGate;
    });
    const client: TelegramBotClient = {
      async poll(_offset, timeout, signal) {
        if (firstPoll) {
          firstPoll = false;
          return [{
            updateId: 1,
            kind: "message",
            chatId: "42",
            messageId: "1",
            senderId: "U",
            text: "work",
            attachments: [],
            receivedAt: now,
          }];
        }
        if (timeout === 0) {
          confirmationSignal = signal;
          confirmationStarted();
        }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => { reject(new Error("poll aborted")); }, { once: true });
        });
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage() { return { messageId: "sent" }; },
      async sendAttachment() { return { messageId: "attachment" }; },
      close,
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async () => ({
      status: "completed",
      text: "done",
    }));
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const draining = Promise.resolve(channel.drain?.({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 1_000).toISOString(),
    }));
    let drainSettled = false;
    const drainOutcome = draining.then(
      () => { drainSettled = true; return { status: "fulfilled" as const }; },
      (error: unknown) => { drainSettled = true; return { status: "rejected" as const, error }; },
    );
    await confirmationStart;
    let stopSettled = false;
    const stopOutcome = Promise.resolve(channel.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    })).then(
      () => { stopSettled = true; return { status: "fulfilled" as const }; },
      (error: unknown) => { stopSettled = true; return { status: "rejected" as const, error }; },
    );
    await closeStart;
    expect(confirmationSignal?.aborted).toBe(true);
    expect(drainSettled).toBe(false);
    expect(stopSettled).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    releaseClose();
    const [drained, stopped] = await Promise.all([drainOutcome, stopOutcome]);
    expect(drained).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: "Telegram update confirmation is degraded." }),
    });
    expect(stopped).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: "Telegram update confirmation is degraded." }),
    });
  });

  it("aborts an active turn after the drain deadline", async () => {
    const now = new Date().toISOString();
    let firstPoll = true;
    let turnSignal: AbortSignal | undefined;
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (firstPoll) {
          firstPoll = false;
          return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "work", attachments: [], receivedAt: now }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage() { return { messageId: "sent" }; },
      async sendAttachment() { return { messageId: "attachment" }; },
    };
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (request) => {
      turnSignal = request.signal;
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    await channel.drain?.({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 100).toISOString(),
    });
    expect(turnSignal?.aborted).toBe(true);
    expect(channel.running).toBe(false);
  });

  it("waits for an active AskUser callback before completing graceful drain", async () => {
    const now = new Date().toISOString();
    let callbackToken: string | undefined;
    let stage = 0;
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    const client: TelegramBotClient = {
      async poll(_offset, timeout, signal) {
        if (timeout === 0) return [];
        if (stage === 0) {
          stage += 1;
          return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "start", attachments: [], receivedAt: now }];
        }
        if (stage === 1 && callbackToken !== undefined) {
          stage += 1;
          return [{ updateId: 2, kind: "callback", callbackId: "callback-1", chatId: "42", messageId: "1", senderId: "U", data: callbackToken, receivedAt: now }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage(request) {
        callbackToken = request.buttons?.[0]?.data;
        return { messageId: "sent" };
      },
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => {
      await answerGate;
      return { status: "accepted" };
    });
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({
        type: "ask-user",
        ask: {
          interactionId: "ask-drain",
          requestedAt: now,
          questions: [{
            id: "choice",
            prompt: "Choose",
            choices: [{ value: "yes", label: "Yes" }],
            allowFreeText: false,
            multiple: false,
          }],
        },
      });
      return { status: "completed" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch, { answerAsk }),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(answerAsk).toHaveBeenCalledOnce());
    let drained = false;
    const draining = Promise.resolve(channel.drain?.({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 1_000).toISOString(),
    })).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseAnswer();
    await draining;
    expect(drained).toBe(true);
    expect(channel.running).toBe(false);
  });

  it("accumulates multi-select AskUser values until Done and answers free-text questions", async () => {
    const now = new Date().toISOString();
    const callbacks = new Map<string, string>();
    let stage = 0;
    const sent = vi.fn<TelegramBotClient["sendMessage"]>(async (request) => {
      for (const button of request.buttons ?? []) callbacks.set(button.label, button.data);
      return { messageId: "sent" };
    });
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (stage === 0) {
          stage += 1;
          return [{ updateId: 1, kind: "message", chatId: "42", messageId: "1", senderId: "U", text: "start", attachments: [], receivedAt: now }];
        }
        const callback = (updateId: number, label: string): readonly TelegramUpdate[] => {
          const data = callbacks.get(label);
          if (data === undefined) return [];
          stage += 1;
          return [{ updateId, kind: "callback", callbackId: `callback-${String(updateId)}`, chatId: "42", messageId: String(updateId), senderId: "U", data, receivedAt: now }];
        };
        if (stage === 1) return callback(2, "A");
        if (stage === 2) return callback(3, "B");
        if (stage === 3) {
          stage += 1;
          return [{ updateId: 4, kind: "message", chatId: "42", messageId: "4", senderId: "U", text: "typed choice", attachments: [], receivedAt: now }];
        }
        if (stage === 4) return callback(5, "Done");
        if (stage === 5) {
          stage += 1;
          return [{ updateId: 6, kind: "message", chatId: "42", messageId: "6", senderId: "U", text: "typed answer", attachments: [], receivedAt: now }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      sendMessage: sent,
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => ({ status: "accepted" }));
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({
        type: "ask-user",
        ask: {
          interactionId: "ask-multiple",
          requestedAt: now,
          questions: [
            {
              id: "multi",
              prompt: "Choose several",
              choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
              allowFreeText: true,
              multiple: true,
            },
            {
              id: "free",
              prompt: "Explain",
              allowFreeText: true,
              multiple: false,
            },
          ],
        },
      });
      return { status: "completed", text: "waiting" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }), dispatch, { answerAsk }),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(answerAsk).toHaveBeenCalledOnce());
    expect(answerAsk).toHaveBeenCalledWith("telegram:42", expect.objectContaining({
      interactionId: "ask-multiple",
      answers: { multi: ["a", "b", "typed choice"], free: ["typed answer"] },
    }), expect.any(AbortSignal));
    expect(dispatch).toHaveBeenCalledOnce();
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("keeps multiple free-text AskUser answers unique, non-empty, and within Core's value cap", async () => {
    const now = new Date().toISOString();
    const ask: AskUserRequest = {
      interactionId: "ask-bounded-multiple",
      requestedAt: now,
      questions: [{
        id: "multi",
        prompt: "List values",
        allowFreeText: true,
        multiple: true,
      }],
    };
    const typed = [
      "typed-0",
      "typed-0",
      ...Array.from({ length: 20 }, (_, index) => `typed-${String(index + 1)}`),
    ];
    let doneToken: string | undefined;
    let stage = 0;
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (stage === 0) {
          stage += 1;
          return [{
            updateId: 1,
            kind: "message",
            chatId: "42",
            messageId: "1",
            senderId: "U",
            text: "start",
            attachments: [],
            receivedAt: now,
          }];
        }
        if (stage === 1 && doneToken !== undefined) {
          stage += 1;
          return [{
            updateId: 2,
            kind: "callback",
            callbackId: "empty-done",
            chatId: "42",
            messageId: "2",
            senderId: "U",
            data: doneToken,
            receivedAt: now,
          }];
        }
        const textIndex = stage - 2;
        if (textIndex >= 0 && textIndex < typed.length) {
          stage += 1;
          return [{
            updateId: stage,
            kind: "message",
            chatId: "42",
            messageId: String(stage),
            senderId: "U",
            text: typed[textIndex]!,
            attachments: [],
            receivedAt: now,
          }];
        }
        if (textIndex === typed.length && doneToken !== undefined) {
          stage += 1;
          return [{
            updateId: stage,
            kind: "callback",
            callbackId: "bounded-done",
            chatId: "42",
            messageId: String(stage),
            senderId: "U",
            data: doneToken,
            receivedAt: now,
          }];
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { resolve(); }, { once: true });
        });
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage(request) {
        doneToken = request.buttons?.find((button) => button.label === "Done")?.data ?? doneToken;
        return { messageId: "sent" };
      },
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const parsedAnswers: ReturnType<typeof parseAskUserAnswer>[] = [];
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async (_conversationId, answer) => {
      try {
        parsedAnswers.push(parseAskUserAnswer(answer, ask));
        return { status: "accepted" };
      } catch {
        return { status: "mismatch" };
      }
    });
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({ type: "ask-user", ask });
      return { status: "completed" };
    });
    const channel = createTelegramChannel({
      context: context(
        parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }),
        dispatch,
        { answerAsk },
      ),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(answerAsk).toHaveBeenCalledOnce());
    expect(parsedAnswers).toHaveLength(1);
    expect(parsedAnswers[0]?.answers.multi).toEqual(
      Array.from({ length: 20 }, (_, index) => `typed-${String(index)}`),
    );
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("accepts a prototype-named multiple AskUser question through the Core parser", async () => {
    const now = new Date().toISOString();
    const ask: AskUserRequest = {
      interactionId: "ask-prototype-name",
      requestedAt: now,
      questions: [{
        id: "constructor",
        prompt: "Choose and explain",
        choices: [{ value: "selected", label: "Selected" }],
        allowFreeText: true,
        multiple: true,
      }],
    };
    const callbacks = new Map<string, string>();
    let stage = 0;
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (stage === 0) {
          stage += 1;
          return [{
            updateId: 1,
            kind: "message",
            chatId: "42",
            messageId: "1",
            senderId: "U",
            text: "start",
            attachments: [],
            receivedAt: now,
          }];
        }
        const callback = (updateId: number, label: string): readonly TelegramUpdate[] => {
          const data = callbacks.get(label);
          if (data === undefined) return [];
          stage += 1;
          return [{
            updateId,
            kind: "callback",
            callbackId: `callback-${label}`,
            chatId: "42",
            messageId: String(updateId),
            senderId: "U",
            data,
            receivedAt: now,
          }];
        };
        if (stage === 1) return callback(2, "Selected");
        if (stage === 2) {
          stage += 1;
          return [{
            updateId: 3,
            kind: "message",
            chatId: "42",
            messageId: "3",
            senderId: "U",
            text: "typed",
            attachments: [],
            receivedAt: now,
          }];
        }
        if (stage === 3) return callback(4, "Done");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { resolve(); }, { once: true });
        });
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage(request) {
        for (const button of request.buttons ?? []) callbacks.set(button.label, button.data);
        return { messageId: "sent" };
      },
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const parsedAnswers: ReturnType<typeof parseAskUserAnswer>[] = [];
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async (_conversationId, answer) => {
      parsedAnswers.push(parseAskUserAnswer(answer, ask));
      return { status: "accepted" };
    });
    const channel = createTelegramChannel({
      context: context(
        parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["42"] }),
        async (_request, reply) => {
          await reply.emit({ type: "ask-user", ask });
          return { status: "completed" };
        },
        { answerAsk },
      ),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(answerAsk).toHaveBeenCalledOnce());
    expect(parsedAnswers).toHaveLength(1);
    expect(Object.getPrototypeOf(parsedAnswers[0]!.answers)).toBeNull();
    expect(parsedAnswers[0]!.answers["constructor"]).toEqual(["selected", "typed"]);
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("preserves live AskUser callbacks when callback capacity rejects a newer ask", async () => {
    const now = new Date().toISOString();
    const firstChatTokens = new Map<string, string>();
    let stage = 0;
    const sent = vi.fn<TelegramBotClient["sendMessage"]>(async (request) => {
      if (request.chatId === "1") {
        for (const button of request.buttons ?? []) {
          if (button.label === "Trigger" || button.label === "Choice 0" || button.label === "Done") {
            firstChatTokens.set(`${request.text}:${button.label}`, button.data);
          }
        }
      }
      return { messageId: "sent" };
    });
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (stage === 0) {
          stage += 1;
          return Array.from({ length: 527 }, (_, index): TelegramUpdate => ({
            updateId: index + 1,
            kind: "message",
            chatId: String(index + 1),
            messageId: String(index + 1),
            senderId: "U",
            text: "ask",
            attachments: [],
            receivedAt: now,
          }));
        }
        const callback = (updateId: number, prompt: string, label: string): readonly TelegramUpdate[] => {
          const data = firstChatTokens.get(`${prompt}:${label}`);
          if (data === undefined) return [];
          stage += 1;
          return [{ updateId, kind: "callback", callbackId: `callback-${prompt}-${label}`, chatId: "1", messageId: "1", senderId: "U", data, receivedAt: now }];
        };
        if (stage === 1) return callback(528, "single", "Trigger");
        if (stage === 2) return callback(529, "multi-a", "Choice 0");
        if (stage === 3) return callback(530, "multi-a", "Done");
        if (stage === 4) return callback(531, "multi-b", "Choice 0");
        if (stage === 5) return callback(532, "multi-b", "Done");
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      sendMessage: sent,
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => ({ status: "accepted" }));
    const choices = Array.from({ length: 8 }, (_, index) => ({
      value: `value-${String(index)}`,
      label: `Choice ${String(index)}`,
    }));
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({
        type: "ask-user",
        ask: {
          interactionId: `ask-${String(dispatch.mock.calls.length)}`,
          requestedAt: now,
          questions: [
            { id: "single", prompt: "single", choices: [{ value: "trigger", label: "Trigger" }], allowFreeText: false, multiple: false },
            { id: "multi-a", prompt: "multi-a", choices, allowFreeText: false, multiple: true },
            { id: "multi-b", prompt: "multi-b", choices, allowFreeText: false, multiple: true },
          ],
        },
      });
      return { status: "completed" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowAllChats: true }), dispatch, { answerAsk }),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(answerAsk).toHaveBeenCalledOnce());
    expect(answerAsk).toHaveBeenCalledWith("telegram:1", expect.objectContaining({
      answers: {
        single: ["trigger"],
        "multi-a": ["value-0"],
        "multi-b": ["value-0"],
      },
    }), expect.any(AbortSignal));
    expect(dispatch).toHaveBeenCalledTimes(527);
    await channel.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("preserves live AskUser callbacks when pending-ask capacity rejects a newer ask", async () => {
    const now = new Date().toISOString();
    let firstToken: string | undefined;
    let stage = 0;
    const client: TelegramBotClient = {
      async poll(_offset, _timeout, signal) {
        if (stage === 0) {
          stage += 1;
          return Array.from({ length: 1_001 }, (_, index): TelegramUpdate => ({
            updateId: index + 1,
            kind: "message",
            chatId: String(index + 1),
            messageId: String(index + 1),
            senderId: "U",
            text: "ask",
            attachments: [],
            receivedAt: now,
          }));
        }
        if (stage === 1 && firstToken !== undefined) {
          stage += 1;
          return [{
            updateId: 1_002,
            kind: "callback",
            callbackId: "oldest-callback",
            chatId: "1",
            messageId: "1",
            senderId: "U",
            data: firstToken,
            receivedAt: now,
          }];
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { resolve(); }, { once: true }));
        return [];
      },
      async download() { throw new Error("unexpected download"); },
      async sendMessage(request) {
        if (request.chatId === "1") firstToken = request.buttons?.[0]?.data;
        return { messageId: "sent" };
      },
      async sendAttachment() { return { messageId: "attachment" }; },
      async answerCallback() {},
    };
    const answerAsk = vi.fn<NonNullable<ChannelHost["answerAsk"]>>(async () => ({ status: "accepted" }));
    const dispatch = vi.fn<ChannelHost["dispatch"]>(async (_request, reply) => {
      await reply.emit({
        type: "ask-user",
        ask: {
          interactionId: `ask-${String(dispatch.mock.calls.length)}`,
          requestedAt: now,
          questions: [{
            id: "choice",
            prompt: "Choose",
            choices: [{ value: "yes", label: "Yes" }],
            allowFreeText: false,
            multiple: false,
          }],
        },
      });
      return { status: "completed" };
    });
    const channel = createTelegramChannel({
      context: context(parseTelegramConfig({ botToken: TOKEN, allowAllChats: true }), dispatch, { answerAsk }),
      clientFactory: () => client,
    });

    await channel.start?.({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(answerAsk).toHaveBeenCalledOnce());
    expect(answerAsk).toHaveBeenCalledWith("telegram:1", expect.objectContaining({
      interactionId: "ask-1",
      answers: { choice: ["yes"] },
    }), expect.any(AbortSignal));
    expect(dispatch).toHaveBeenCalledTimes(1_001);
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

  it("reads highly fragmented HTTP responses with byte-bounded accumulation", async () => {
    const fragmentCount = 10_000;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < fragmentCount; index += 1) {
          controller.enqueue(new Uint8Array([index % 251]));
        }
        controller.close();
      },
    }));

    const bytes = await readBoundedBytes(response, fragmentCount, "fragmented response");

    expect(bytes).toHaveLength(fragmentCount);
    expect(bytes[0]).toBe(0);
    expect(bytes.at(-1)).toBe((fragmentCount - 1) % 251);
  });
});

function context(config: ReturnType<typeof parseTelegramConfig>, dispatch: ChannelHost["dispatch"], controls: Partial<ChannelHost> = {}): Parameters<typeof createTelegramChannel>[0]["context"] {
  const host: ChannelHost = { grantedCapabilities: new Set(), getCapability() { return undefined; }, dispatch, ...controls };
  return { instanceId: "telegram", config, provenance: {}, configDirectory: "/config", workspaceDirectory: "/workspace", dataDirectory: "/data", logger: logger(), host, signal: new AbortController().signal };
}

function logger(): ModuleLogger { return { debug() {}, info() {}, warn() {}, error() {} }; }

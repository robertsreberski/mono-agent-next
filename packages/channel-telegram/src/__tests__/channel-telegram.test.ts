import { isEnvEligibleSchema, isSecretSchema, type ChannelHost, type ModuleLogger } from "@mono-agent/module-sdk";
import { assertChannelInstanceCompliance, assertChannelModuleCompliance } from "@mono-agent/module-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { createTelegramChannel, monoAgentModule, parseTelegramConfig, telegramConfigSchema, type TelegramBotClient, type TelegramUpdate } from "../index.js";

const TOKEN = "1234567890:telegram-token-long-enough";

describe("telegram channel", () => {
  it("has strict env-only secret config and exact authorization", () => {
    const properties = telegramConfigSchema.jsonSchema.properties as Record<string, Readonly<Record<string, unknown>>>;
    expect(isEnvEligibleSchema(properties.botToken!)).toBe(true);
    expect(isSecretSchema(properties.botToken!)).toBe(true);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: [] })).toThrow(/at least one/u);
    expect(() => parseTelegramConfig({ botToken: TOKEN, allowedChatIds: ["1"], surprise: true })).toThrow(/unknown/u);
    expect(() => parseTelegramConfig({ botToken: { $env: "BOT" }, allowedChatIds: ["1"] })).toThrow(/resolved/u);
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
    expect(channel.capabilities).toMatchObject({ liveInput: true, askUser: true, approvals: false, cancellation: true, runtimeControl: false });
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
});

function context(config: ReturnType<typeof parseTelegramConfig>, dispatch: ChannelHost["dispatch"], controls: Partial<ChannelHost> = {}): Parameters<typeof createTelegramChannel>[0]["context"] {
  const host: ChannelHost = { grantedCapabilities: new Set(), getCapability() { return undefined; }, dispatch, ...controls };
  return { instanceId: "telegram", config, provenance: {}, configDirectory: "/config", workspaceDirectory: "/workspace", dataDirectory: "/data", logger: logger(), host, signal: new AbortController().signal };
}

function logger(): ModuleLogger { return { debug() {}, info() {}, warn() {}, error() {} }; }

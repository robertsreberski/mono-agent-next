import { describe, expect, it, vi } from "vitest";
import type { WhatsAppAdapter, WhatsAppMessageHandlingResult } from "../adapter.js";
import { WhatsAppEventRunner } from "../event-runner.js";
import type {
  WhatsAppEventEmitterLike,
  WhatsAppJid,
  WhatsAppRawMessage,
  WhatsAppSendMessageContent,
  WhatsAppSendMessageOptions,
  WhatsAppSocketLike,
} from "../types.js";

class FakeEmitter implements WhatsAppEventEmitterLike {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, listener: (payload: unknown) => void): void {
    const existing = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    existing.add(listener);
    this.listeners.set(event, existing);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeSocket implements WhatsAppSocketLike {
  readonly ev = new FakeEmitter();

  async sendMessage(
    _jid: WhatsAppJid,
    _content: WhatsAppSendMessageContent,
    _options?: WhatsAppSendMessageOptions,
  ): Promise<undefined> {
    return undefined;
  }
}

function adapterWithHandler(
  handler: (message: unknown) => Promise<WhatsAppMessageHandlingResult>,
): WhatsAppAdapter {
  return { handleMessage: handler } as unknown as WhatsAppAdapter;
}

function textMessage(chatJid: WhatsAppJid, id: string): WhatsAppRawMessage {
  return {
    key: { remoteJid: chatJid, id },
    message: { conversation: id },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function messageIdentity(message: unknown): { chatJid: string; id: string } {
  if (typeof message !== "object" || message === null || !("key" in message)) {
    return { chatJid: "unknown", id: "unknown" };
  }
  const key = (message as { key?: { remoteJid?: unknown; id?: unknown } }).key;
  return {
    chatJid: typeof key?.remoteJid === "string" ? key.remoteJid : "unknown",
    id: typeof key?.id === "string" ? key.id : "unknown",
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("WhatsAppEventRunner", () => {
  it("attaches and removes Baileys event listeners", () => {
    const socket = new FakeSocket();
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(async () => ({ kind: "ignored", reason: "empty_text" })),
    });

    runner.start();

    expect(socket.ev.listenerCount("messages.upsert")).toBe(1);
    expect(socket.ev.listenerCount("creds.update")).toBe(1);
    expect(socket.ev.listenerCount("connection.update")).toBe(1);

    runner.stop();

    expect(socket.ev.listenerCount("messages.upsert")).toBe(0);
    expect(socket.ev.listenerCount("creds.update")).toBe(0);
    expect(socket.ev.listenerCount("connection.update")).toBe(0);
  });

  it("processes notify messages from one chat sequentially and reports results", async () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    const results: WhatsAppMessageHandlingResult[] = [];
    const firstResultStarted = deferred();
    const releaseFirstResult = deferred();
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(async (message) => {
        const { chatJid, id } = messageIdentity(message);
        order.push(`start:${id}`);
        order.push(`end:${id}`);
        return { kind: "ignored", reason: "empty_text", chatJid, messageId: id };
      }),
      onMessageResult: async (result) => {
        results.push(result);
        order.push(`result:start:${result.messageId ?? "unknown"}`);
        if (result.messageId === "a") {
          firstResultStarted.resolve();
          await releaseFirstResult.promise;
        }
        order.push(`result:end:${result.messageId ?? "unknown"}`);
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "a")],
    });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "b")],
    });
    await firstResultStarted.promise;

    expect(order).toEqual(["start:a", "end:a", "result:start:a"]);

    releaseFirstResult.resolve();
    await runner.idle();

    expect(order).toEqual([
      "start:a",
      "end:a",
      "result:start:a",
      "result:end:a",
      "start:b",
      "end:b",
      "result:start:b",
      "result:end:b",
    ]);
    expect(results).toHaveLength(2);
  });

  it("processes different chats concurrently while preserving per-chat order", async () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    const results: WhatsAppMessageHandlingResult[] = [];
    const releaseFirstChat = deferred();
    const secondChatReported = deferred();
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(async (message) => {
        const { chatJid, id } = messageIdentity(message);
        order.push(`start:${id}`);
        if (id === "a1") {
          await releaseFirstChat.promise;
        }
        order.push(`end:${id}`);
        return { kind: "ignored", reason: "empty_text", chatJid, messageId: id };
      }),
      onMessageResult: (result) => {
        results.push(result);
        if (result.messageId === "b1") {
          secondChatReported.resolve();
        }
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "a1")],
    });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("two@s.whatsapp.net", "b1")],
    });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "a2")],
    });
    await secondChatReported.promise;

    expect(order).toEqual(["start:a1", "start:b1", "end:b1"]);
    expect(results.map((result) => result.messageId)).toEqual(["b1"]);

    releaseFirstChat.resolve();
    await runner.idle();

    expect(order).toEqual([
      "start:a1",
      "start:b1",
      "end:b1",
      "end:a1",
      "start:a2",
      "end:a2",
    ]);
    expect(results.map((result) => result.messageId)).toEqual(["b1", "a1", "a2"]);
  });

  it("ignores history/appended upserts unless explicitly configured", async () => {
    const socket = new FakeSocket();
    const handleMessage = vi.fn(async () => ({ kind: "ignored", reason: "empty_text" }) as const);
    const results: WhatsAppMessageHandlingResult[] = [];
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(handleMessage),
      onMessageResult: (result) => {
        results.push(result);
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", { type: "append", messages: [{ id: "history" }] });
    await runner.idle();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(results).toEqual([{ kind: "ignored", reason: "history_sync_ignored" }]);
  });

  it("contains hostile payload access and continues processing later messages", async () => {
    const socket = new FakeSocket();
    const logger = { error: vi.fn() };
    const results: WhatsAppMessageHandlingResult[] = [];
    const handleMessage = vi.fn(async (message: unknown) => {
      const { chatJid, id } = messageIdentity(message);
      return {
        kind: "ignored",
        reason: "empty_text",
        chatJid,
        messageId: id,
      } as const;
    });
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(handleMessage),
      logger,
      onMessageResult: (result) => {
        results.push(result);
      },
    });
    runner.start();

    const hostilePayload = Object.defineProperty({}, "messages", {
      get: () => {
        throw new Error("hostile messages getter");
      },
    });
    const hostileMessage = Object.defineProperty({}, "key", {
      get: () => {
        throw new Error("hostile key getter");
      },
    });

    expect(() => socket.ev.emit("messages.upsert", hostilePayload)).not.toThrow();
    expect(() => socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [hostileMessage, textMessage("later@s.whatsapp.net", "later")],
    })).not.toThrow();
    await runner.idle();

    expect(logger.error).toHaveBeenCalledWith(
      "WhatsApp messages.upsert processing failed.",
      { error: "hostile messages getter" },
    );
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.some((result) => result.kind === "error")).toBe(true);
    expect(results).toContainEqual({
      kind: "ignored",
      reason: "empty_text",
      chatJid: "later@s.whatsapp.net",
      messageId: "later",
    });
  });

  it("continues one chat after an adapter error and its result callback completes", async () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    const errorResultStarted = deferred();
    const releaseErrorResult = deferred();
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(async (message) => {
        const { chatJid, id } = messageIdentity(message);
        order.push(`start:${id}`);
        if (id === "a") {
          throw new Error("first message failed");
        }
        return { kind: "ignored", reason: "empty_text", chatJid, messageId: id };
      }),
      onMessageResult: async (result) => {
        order.push(`result:start:${result.kind}`);
        if (result.kind === "error") {
          errorResultStarted.resolve();
          await releaseErrorResult.promise;
        }
        order.push(`result:end:${result.kind}`);
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "a")],
    });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "b")],
    });
    await errorResultStarted.promise;

    expect(order).toEqual(["start:a", "result:start:error"]);

    releaseErrorResult.resolve();
    await runner.idle();

    expect(order).toEqual([
      "start:a",
      "result:start:error",
      "result:end:error",
      "start:b",
      "result:start:ignored",
      "result:end:ignored",
    ]);
  });

  it("drains accepted work after stop without accepting later events", async () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(async (message) => {
        const { chatJid, id } = messageIdentity(message);
        order.push(`start:${id}`);
        if (id === "a") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        order.push(`end:${id}`);
        return { kind: "ignored", reason: "empty_text", chatJid, messageId: id };
      }),
      onMessageResult: (result) => {
        order.push(`result:${result.messageId ?? result.kind}`);
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("one@s.whatsapp.net", "a")],
    });
    await firstStarted.promise;

    runner.stop();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("two@s.whatsapp.net", "b")],
    });
    releaseFirst.resolve();
    await runner.idle();

    expect(order).toEqual(["start:a", "end:a", "result:a"]);
  });

  it("saves credentials and surfaces connection QR only through explicit callbacks", async () => {
    const socket = new FakeSocket();
    const saveCreds = vi.fn(async () => undefined);
    const onQr = vi.fn();
    const onConnectionUpdate = vi.fn();
    const logger = { info: vi.fn() };
    const runner = new WhatsAppEventRunner({
      socket,
      adapter: adapterWithHandler(async () => ({ kind: "ignored", reason: "empty_text" })),
      saveCreds,
      onQr,
      onConnectionUpdate,
      logger,
    });
    runner.start();

    socket.ev.emit("creds.update", { secret: "redacted-credential-value" });
    socket.ev.emit("connection.update", { connection: "connecting", qr: "sensitive-qr" });
    await flushMicrotasks();

    expect(saveCreds).toHaveBeenCalledTimes(1);
    expect(onQr).toHaveBeenCalledWith("sensitive-qr");
    expect(onConnectionUpdate).toHaveBeenCalledWith({
      connection: "connecting",
      hasQr: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "WhatsApp connection update.",
      expect.objectContaining({ connection: "connecting", hasQr: true }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("sensitive-qr");
  });
});

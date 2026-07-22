import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "../adapter.js";
import type { BaileysWhatsAppSocket } from "../baileys-socket.js";
import type { WhatsAppAdapterConfig } from "../config.js";
import { WhatsAppAdapterConfigError } from "../config.js";
import { startWhatsAppAdapter, type WhatsAppSocketFactory } from "../start.js";
import type {
  WhatsAppEventEmitterLike,
  WhatsAppJid,
  WhatsAppRawMessage,
  WhatsAppSendMessageContent,
  WhatsAppSendMessageOptions,
  WhatsAppSentMessage,
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
  readonly sent: { jid: WhatsAppJid; content: WhatsAppSendMessageContent }[] = [];

  async sendMessage(
    jid: WhatsAppJid,
    content: WhatsAppSendMessageContent,
    _options?: WhatsAppSendMessageOptions,
  ): Promise<WhatsAppSentMessage | undefined> {
    this.sent.push({ jid, content });
    return undefined;
  }
}

function buildConfig(overrides: Partial<WhatsAppAdapterConfig> = {}): WhatsAppAdapterConfig {
  return {
    enabled: true,
    allowedChatJids: ["123@s.whatsapp.net"],
    allowAllChats: false,
    trigger: {
      groupMode: "mention",
      botJids: [],
      mentionTextAliases: [],
      stripMentionText: false,
    },
    ...overrides,
  };
}

function textMessage(chatJid: WhatsAppJid, text: string): WhatsAppRawMessage {
  return {
    key: { id: "msg-1", remoteJid: chatJid, fromMe: false },
    message: { conversation: text },
    messageTimestamp: 1,
  };
}

function fakeSocketFactory(socket: FakeSocket, saveCreds = vi.fn(async () => undefined)): {
  factory: WhatsAppSocketFactory;
  end: ReturnType<typeof vi.fn>;
  saveCreds: typeof saveCreds;
  calls: { authDir: string }[];
} {
  const end = vi.fn(async (_error: Error | undefined) => undefined);
  const calls: { authDir: string }[] = [];
  const factory: WhatsAppSocketFactory = async (options) => {
    calls.push({ authDir: options.authDir });
    return {
      socket,
      // Only `end` is exercised by stop(); cast covers the rest of WASocket.
      baileysSocket: { end } as unknown as BaileysWhatsAppSocket["baileysSocket"],
      saveCreds,
    };
  };
  return { factory, end, saveCreds, calls };
}

describe("startWhatsAppAdapter", () => {
  it("wires the socket, adapter, and runner then routes an inbound message", async () => {
    const socket = new FakeSocket();
    const { factory, calls } = fakeSocketFactory(socket);
    const respond = vi.fn(async () => ({ text: "pong" }));
    const responder = { respond } as unknown as AgentResponder;

    const handle = await startWhatsAppAdapter({
      authDir: "/tmp/whatsapp-auth",
      config: buildConfig(),
      responder,
      createSocket: factory,
    });

    expect(calls).toEqual([{ authDir: "/tmp/whatsapp-auth" }]);
    expect(socket.ev.listenerCount("messages.upsert")).toBe(1);
    expect(socket.ev.listenerCount("creds.update")).toBe(1);
    expect(socket.ev.listenerCount("connection.update")).toBe(1);

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("123@s.whatsapp.net", "hello")],
    });
    await handle.runner.idle();

    expect(respond).toHaveBeenCalledTimes(1);
    const request = (respond.mock.calls[0] as unknown[])[0] as {
      text: string;
      chatJid: string;
    };
    expect(request.text).toBe("hello");
    expect(request.chatJid).toBe("123@s.whatsapp.net");
    // Final response text is delivered back over the socket.
    expect(socket.sent.some((entry) => entry.content.text === "pong")).toBe(true);

    await handle.stop();
  });

  it("persists credentials through the injected saveCreds seam", async () => {
    const socket = new FakeSocket();
    const { factory, saveCreds } = fakeSocketFactory(socket);
    const responder = { respond: vi.fn(async () => ({ text: "ok" })) } as unknown as AgentResponder;

    const handle = await startWhatsAppAdapter({
      authDir: "/tmp/whatsapp-auth",
      config: buildConfig({ allowAllChats: true, allowedChatJids: [] }),
      responder,
      createSocket: factory,
    });

    socket.ev.emit("creds.update", {});
    await Promise.resolve();
    await Promise.resolve();

    expect(saveCreds).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("stop() removes listeners and closes the socket once", async () => {
    const socket = new FakeSocket();
    const { factory, end } = fakeSocketFactory(socket);
    const responder = { respond: vi.fn(async () => ({ text: "ok" })) } as unknown as AgentResponder;

    const handle = await startWhatsAppAdapter({
      authDir: "/tmp/whatsapp-auth",
      config: buildConfig(),
      responder,
      createSocket: factory,
    });

    await handle.stop();

    expect(socket.ev.listenerCount("messages.upsert")).toBe(0);
    expect(socket.ev.listenerCount("creds.update")).toBe(0);
    expect(socket.ev.listenerCount("connection.update")).toBe(0);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(undefined);

    // Idempotent: a second stop() must not double-close.
    await handle.stop();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("aborts active work and bounds hung processing plus socket close", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const { factory, end } = fakeSocketFactory(socket);
      end.mockImplementation(async () => await new Promise<void>(() => undefined));
      let enteredResolve: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const responder: AgentResponder = {
        async respond(request) {
          requestSignal = request.abortSignal;
          enteredResolve?.();
          return await new Promise<never>(() => undefined);
        },
      };
      const logger = { warn: vi.fn(), error: vi.fn() };
      const handle = await startWhatsAppAdapter({
        authDir: "/tmp/whatsapp-auth",
        config: buildConfig(),
        responder,
        logger,
        createSocket: factory,
      });
      socket.ev.emit("messages.upsert", {
        type: "notify",
        messages: [textMessage("123@s.whatsapp.net", "wait")],
      });
      await vi.advanceTimersByTimeAsync(0);
      await entered;

      const firstStop = handle.stop();
      expect(handle.stop()).toBe(firstStop);
      expect(requestSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await firstStop;

      expect(end).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(socket.ev.listenerCount("messages.upsert")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the responder is missing", async () => {
    const socket = new FakeSocket();
    const { factory } = fakeSocketFactory(socket);

    await expect(
      startWhatsAppAdapter({
        authDir: "/tmp/whatsapp-auth",
        config: buildConfig(),
        responder: undefined as unknown as AgentResponder,
        createSocket: factory,
      }),
    ).rejects.toMatchObject({ code: "missing_required_config" });
    // Socket must not be constructed when validation fails closed.
    expect(socket.ev.listenerCount("messages.upsert")).toBe(0);
  });

  it("fails closed when authDir is empty", async () => {
    const responder = { respond: vi.fn(async () => ({ text: "ok" })) } as unknown as AgentResponder;
    await expect(
      startWhatsAppAdapter({
        authDir: "   ",
        config: buildConfig(),
        responder,
      }),
    ).rejects.toBeInstanceOf(WhatsAppAdapterConfigError);
  });
});

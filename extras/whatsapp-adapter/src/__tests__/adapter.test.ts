import {
  AgentResponseCancelledError,
  isChannelUserCancelReason,
} from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  WhatsAppAdapter,
  type AgentRequest,
  type AgentResponder,
  type WhatsAppAdapterOptions,
} from "../adapter.js";
import type {
  WhatsAppJid,
  WhatsAppRawMessage,
  WhatsAppSendMessageContent,
  WhatsAppSendMessageOptions,
  WhatsAppSocketLike,
} from "../types.js";

interface SentMessage {
  jid: WhatsAppJid;
  content: WhatsAppSendMessageContent;
  options?: WhatsAppSendMessageOptions;
}

class FakeSocket implements WhatsAppSocketLike {
  readonly sent: SentMessage[] = [];

  async sendMessage(
    jid: WhatsAppJid,
    content: WhatsAppSendMessageContent,
    options?: WhatsAppSendMessageOptions,
  ): Promise<undefined> {
    const sent: SentMessage = { jid, content };
    if (options !== undefined) {
      sent.options = options;
    }
    this.sent.push(sent);
    return undefined;
  }
}

function directMessage(text: string, id = "m1"): WhatsAppRawMessage {
  return {
    key: { remoteJid: "123@s.whatsapp.net", id },
    message: { conversation: text },
    pushName: "Sender",
  };
}

function groupMessage(options: {
  text: string;
  id?: string;
  mentionedJids?: WhatsAppJid[];
}): WhatsAppRawMessage {
  return {
    key: {
      remoteJid: "456@g.us",
      participant: "participant@s.whatsapp.net",
      id: options.id ?? "g1",
    },
    message: {
      extendedTextMessage: {
        text: options.text,
        contextInfo: { mentionedJid: options.mentionedJids ?? [] },
      },
    },
  };
}

function createBridge(options: {
  socket?: FakeSocket;
  responder?: AgentResponder;
  allowedChatJids?: WhatsAppJid[];
  allowAllChats?: boolean;
  trigger?: ConstructorParameters<typeof WhatsAppAdapter>[0]["trigger"];
} = {}): { bridge: WhatsAppAdapter; socket: FakeSocket; responder: AgentResponder } {
  const socket = options.socket ?? new FakeSocket();
  const responder =
    options.responder ??
    ({
      respond: vi.fn(async () => ({ text: "agent response", metadata: { ok: true } })),
    } satisfies AgentResponder);
  const bridgeOptions: WhatsAppAdapterOptions = {
    socket,
    responder,
    allowedChatJids: options.allowedChatJids ?? ["123@s.whatsapp.net", "456@g.us"],
  };
  if (options.allowAllChats !== undefined) {
    bridgeOptions.allowAllChats = options.allowAllChats;
  }
  if (options.trigger !== undefined) {
    bridgeOptions.trigger = options.trigger;
  }
  const bridge = new WhatsAppAdapter(bridgeOptions);
  return { bridge, socket, responder };
}

describe("WhatsAppAdapter", () => {
  it("fails closed without allowed chats or explicit allowAllChats", () => {
    const socket = new FakeSocket();
    const responder: AgentResponder = {
      respond: vi.fn(async () => ({ text: "ignored" })),
    };

    expect(() => new WhatsAppAdapter({ socket, responder })).toThrow(
      /allowedChatJids or allowAllChats/,
    );
  });

  it("denies unauthorized chats without calling the responder", async () => {
    const socket = new FakeSocket();
    const responder: AgentResponder = {
      respond: vi.fn(async () => ({ text: "should not run" })),
    };
    const bridge = new WhatsAppAdapter({
      socket,
      responder,
      allowedChatJids: ["456@g.us"],
    });

    const result = await bridge.handleMessage(directMessage("hello"));

    expect(result).toMatchObject({ kind: "unauthorized", chatJid: "123@s.whatsapp.net" });
    expect(responder.respond).not.toHaveBeenCalled();
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "This WhatsApp chat is not authorized to use this bot.",
    ]);
  });

  it("handles direct text messages and builds WhatsApp request metadata", async () => {
    let capturedRequest: AgentRequest | undefined;
    const responder: AgentResponder = {
      respond: vi.fn(async (request) => {
        capturedRequest = request;
        return { text: `echo: ${request.text}`, metadata: { runtime: { model: "fake" } } };
      }),
    };
    const { bridge, socket } = createBridge({ responder });

    const result = await bridge.handleMessage(directMessage("hello"));

    expect(result).toMatchObject({
      kind: "handled",
      action: "responded",
      chatJid: "123@s.whatsapp.net",
      trigger: "direct",
    });
    expect(capturedRequest).toMatchObject({
      conversationId: "whatsapp:123@s.whatsapp.net",
      replyTo: { conversationId: "whatsapp:123@s.whatsapp.net" },
      chatJid: "123@s.whatsapp.net",
      senderJid: "123@s.whatsapp.net",
      text: "hello",
      trigger: "direct",
      metadata: {
        whatsapp: {
          chat: { jid: "123@s.whatsapp.net", kind: "direct" },
          sender: { jid: "123@s.whatsapp.net", pushName: "Sender" },
          mentionedJids: [],
          trigger: "direct",
        },
      },
    });
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Thinking…",
      "echo: hello",
    ]);
  });

  it("requires a configured bot mention for group messages by default", async () => {
    const responder: AgentResponder = {
      respond: vi.fn(async () => ({ text: "should not run" })),
    };
    const { bridge, socket } = createBridge({
      responder,
      trigger: { botJids: ["bot@s.whatsapp.net"] },
    });

    const result = await bridge.handleMessage(groupMessage({ text: "hello group" }));

    expect(result).toMatchObject({
      kind: "ignored",
      reason: "mention_required",
      chatJid: "456@g.us",
    });
    expect(responder.respond).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });

  it("handles mentioned group messages and strips configured mention aliases", async () => {
    let capturedRequest: AgentRequest | undefined;
    const responder: AgentResponder = {
      respond: vi.fn(async (request) => {
        capturedRequest = request;
        return { text: request.text };
      }),
    };
    const { bridge, socket } = createBridge({
      responder,
      trigger: {
        botJids: ["bot@s.whatsapp.net"],
        mentionTextAliases: ["@mybot"],
      },
    });

    const result = await bridge.handleMessage(
      groupMessage({
        text: "@mybot help me",
        mentionedJids: ["bot@s.whatsapp.net"],
      }),
    );

    expect(result).toMatchObject({
      kind: "handled",
      action: "responded",
      trigger: "group_mention",
    });
    expect(capturedRequest).toMatchObject({
      conversationId: "whatsapp:456@g.us",
      replyTo: { conversationId: "whatsapp:456@g.us" },
      chatKind: "group",
      participantJid: "participant@s.whatsapp.net",
      text: "help me",
      trigger: "group_mention",
      metadata: {
        whatsapp: {
          mentionedJids: ["bot@s.whatsapp.net"],
          participantJid: "participant@s.whatsapp.net",
          trigger: "group_mention",
        },
      },
    });
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Thinking…",
      "help me",
    ]);
  });

  it("supports explicit group any-text mode", async () => {
    const responder: AgentResponder = {
      respond: vi.fn(async (request) => ({ text: request.trigger })),
    };
    const { bridge, socket } = createBridge({
      responder,
      trigger: { groupMode: "any" },
    });

    const result = await bridge.handleMessage(groupMessage({ text: "ordinary group text" }));

    expect(result).toMatchObject({ kind: "handled", trigger: "group_any" });
    expect(responder.respond).toHaveBeenCalledTimes(1);
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Thinking…",
      "group_any",
    ]);
  });

  it("applies group trigger rules before commands", async () => {
    const { bridge, socket } = createBridge({
      trigger: {
        botJids: ["bot@s.whatsapp.net"],
        mentionTextAliases: ["@mybot"],
      },
    });

    const ignored = await bridge.handleMessage(groupMessage({ text: "/help" }));
    const handled = await bridge.handleMessage(
      groupMessage({
        text: "@mybot /help",
        mentionedJids: ["bot@s.whatsapp.net"],
        id: "g2",
      }),
    );

    expect(ignored).toMatchObject({ kind: "ignored", reason: "mention_required" });
    expect(handled).toMatchObject({ kind: "handled", action: "command", command: "help" });
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Send a text message to talk to the agent. Use /cancel to stop the current response.",
    ]);
  });

  it("ignores fromMe messages to avoid loops", async () => {
    const responder: AgentResponder = {
      respond: vi.fn(async () => ({ text: "should not run" })),
    };
    const { bridge, socket } = createBridge({ responder });

    const result = await bridge.handleMessage({
      key: { remoteJid: "123@s.whatsapp.net", fromMe: true, id: "self" },
      message: { conversation: "hello" },
    });

    expect(result).toMatchObject({ kind: "ignored", reason: "from_self" });
    expect(responder.respond).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });

  it("returns busy while one response is active", async () => {
    let finish!: (value: { text: string }) => void;
    const responder: AgentResponder = {
      respond: vi.fn(
        () =>
          new Promise((resolve: (value: { text: string }) => void) => {
            finish = resolve;
          }),
      ),
    };
    const { bridge, socket } = createBridge({ responder });

    const first = bridge.handleMessage(directMessage("first", "m1"));
    await vi.waitFor(() => expect(responder.respond).toHaveBeenCalledTimes(1));

    const busy = await bridge.handleMessage(directMessage("second", "m2"));
    finish({ text: "done" });
    await first;

    expect(busy).toMatchObject({ kind: "busy", chatJid: "123@s.whatsapp.net" });
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Thinking…",
      "I am still working on your previous message. Use /cancel to stop it.",
      "done",
    ]);
  });

  it("aborts an active run on /cancel", async () => {
    const cancelResponder = vi.fn();
    const responder: AgentResponder = {
      respond: vi.fn(
        (request) =>
          new Promise<never>((_resolve, reject) => {
            request.abortSignal.addEventListener(
              "abort",
              () => reject(new AgentResponseCancelledError()),
              { once: true },
            );
          }),
      ),
      cancel: cancelResponder,
    };
    const { bridge, socket } = createBridge({ responder });

    const first = bridge.handleMessage(directMessage("first", "m1"));
    await vi.waitFor(() => expect(responder.respond).toHaveBeenCalledTimes(1));

    const cancel = await bridge.handleMessage(directMessage("/cancel", "m2"));
    const cancelled = await first;

    expect(cancel).toMatchObject({ kind: "cancelled", chatJid: "123@s.whatsapp.net" });
    expect(cancelled).toMatchObject({ kind: "cancelled", chatJid: "123@s.whatsapp.net" });
    expect(socket.sent.filter((message) => message.content.text === "Cancelled.")).toHaveLength(1);
    expect(cancelResponder).toHaveBeenCalledTimes(1);
    expect(cancelResponder.mock.calls[0]?.[0]).toBe("whatsapp:123@s.whatsapp.net");
    expect(isChannelUserCancelReason(cancelResponder.mock.calls[0]?.[1])).toBe(true);
  });

  it("acknowledges /cancel exactly once when no turn is active", async () => {
    const cancel = vi.fn();
    const responder: AgentResponder = { respond: vi.fn(), cancel };
    const { bridge, socket } = createBridge({ responder });

    const result = await bridge.handleMessage(directMessage("/cancel"));

    expect(result).toMatchObject({ kind: "cancelled", chatJid: "123@s.whatsapp.net" });
    expect(socket.sent.filter((message) => message.content.text === "Cancelled.")).toHaveLength(1);
    expect(responder.respond).not.toHaveBeenCalled();
    expect(isChannelUserCancelReason(cancel.mock.calls[0]?.[1])).toBe(true);
  });

  it("keeps non-command responder cancellation terminal delivery unchanged", async () => {
    const responder: AgentResponder = {
      respond: vi.fn(async () => {
        throw new AgentResponseCancelledError();
      }),
    };
    const { bridge, socket } = createBridge({ responder });

    const result = await bridge.handleMessage(directMessage("please stop"));

    expect(result).toMatchObject({ kind: "cancelled", chatJid: "123@s.whatsapp.net" });
    expect(socket.sent.filter((message) => message.content.text === "Cancelled.")).toHaveLength(1);
  });

  it("surfaces responder failures without fake success", async () => {
    const responder: AgentResponder = {
      respond: vi.fn(async () => {
        throw new Error("runtime exploded");
      }),
    };
    const { bridge, socket } = createBridge({ responder });

    const result = await bridge.handleMessage(directMessage("boom"));

    expect(result).toMatchObject({ kind: "error", chatJid: "123@s.whatsapp.net" });
    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Thinking…",
      "The agent failed while processing your message.",
    ]);
  });
});

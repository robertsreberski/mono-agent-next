import { describe, expect, it } from "vitest";
import { splitWhatsAppText, WhatsAppMessageStream } from "../message-stream.js";
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

describe("WhatsAppMessageStream", () => {
  it("sends at most one status and buffers assistant deltas until finish", async () => {
    const socket = new FakeSocket();
    const stream = new WhatsAppMessageStream({
      socket,
      chatJid: "123@s.whatsapp.net",
    });

    await stream.status("Working");
    await stream.status("Still working");
    await stream.append("Hel");
    await stream.append("lo");

    expect(socket.sent.map((message) => message.content.text)).toEqual(["Working"]);

    await stream.finish();

    expect(socket.sent.map((message) => message.content.text)).toEqual([
      "Working",
      "Hello",
    ]);
  });

  it("can disable status and sends quoted final chunks", async () => {
    const socket = new FakeSocket();
    const quoted: WhatsAppRawMessage = {
      key: { remoteJid: "123@s.whatsapp.net", id: "m1" },
      message: { conversation: "source" },
    };
    const stream = new WhatsAppMessageStream({
      socket,
      chatJid: "123@s.whatsapp.net",
      quotedMessage: quoted,
      sendInitialStatus: false,
      maxMessageChars: 32,
    });

    const firstChunk = "a".repeat(32);
    const secondChunk = "b".repeat(32);
    await stream.status("ignored");
    await stream.replace(`${firstChunk}${secondChunk}`);
    await stream.finish();

    expect(socket.sent.map((message) => message.content.text)).toEqual([
      firstChunk,
      secondChunk,
    ]);
    expect(socket.sent.every((message) => message.options?.quoted === quoted)).toBe(true);
  });

  it("splits long text without dropping content", () => {
    const chunks = splitWhatsAppText("abcdef", 2);

    expect(chunks).toEqual(["ab", "cd", "ef"]);
    expect(chunks.join("")).toBe("abcdef");
  });

  it("splits on code points so multi-byte emoji are never cut in half", () => {
    const chunks = splitWhatsAppText("😀😀😀", 2);

    expect(chunks).toEqual(["😀😀", "😀"]);
    expect(chunks.join("")).toBe("😀😀😀");
    for (const chunk of chunks) {
      expect([...chunk].every((codePoint) => codePoint.length === 2)).toBe(true);
    }
  });

  it("rejects writes after the stream has finished", async () => {
    const socket = new FakeSocket();
    const stream = new WhatsAppMessageStream({
      socket,
      chatJid: "123@s.whatsapp.net",
      sendInitialStatus: false,
    });

    await stream.append("done");
    await stream.finish();

    await expect(stream.status("late")).rejects.toThrow(
      "Cannot write to a finished WhatsAppMessageStream.",
    );
    await expect(stream.append("late")).rejects.toThrow(
      "Cannot write to a finished WhatsAppMessageStream.",
    );
    await expect(stream.replace("late")).rejects.toThrow(
      "Cannot write to a finished WhatsAppMessageStream.",
    );
    expect(socket.sent.map((message) => message.content.text)).toEqual(["done"]);
  });
});

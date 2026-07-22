import { describe, expect, it } from "vitest";
import { normalizeWhatsAppMessage } from "../message-normalizer.js";
import type { WhatsAppRawMessage } from "../types.js";

function textMessage(overrides: Partial<WhatsAppRawMessage> = {}): WhatsAppRawMessage {
  return {
    key: { remoteJid: "123@s.whatsapp.net", id: "m1" },
    message: { conversation: "hello" },
    messageTimestamp: 1_715_000_000,
    pushName: "Sender",
    ...overrides,
  };
}

describe("normalizeWhatsAppMessage", () => {
  it("extracts direct conversation text", () => {
    const result = normalizeWhatsAppMessage(textMessage());

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      throw new Error("expected message result");
    }
    expect(result.message.chatKind).toBe("direct");
    expect(result.message.chatJid).toBe("123@s.whatsapp.net");
    expect(result.message.senderJid).toBe("123@s.whatsapp.net");
    expect(result.message.messageId).toBe("m1");
    expect(result.message.timestamp).toBe(1_715_000_000);
    expect(result.message.pushName).toBe("Sender");
    expect(result.message.text).toBe("hello");
  });

  it("extracts extended text, mentions, and group participant", () => {
    const result = normalizeWhatsAppMessage(
      textMessage({
        key: {
          remoteJid: "456@g.us",
          participant: "participant@s.whatsapp.net",
          id: "group-message",
        },
        message: {
          extendedTextMessage: {
            text: "@bot hi",
            contextInfo: {
              mentionedJid: ["bot@s.whatsapp.net", "bot@s.whatsapp.net"],
            },
          },
        },
      }),
    );

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      throw new Error("expected message result");
    }
    expect(result.message.chatKind).toBe("group");
    expect(result.message.chatJid).toBe("456@g.us");
    expect(result.message.participantJid).toBe("participant@s.whatsapp.net");
    expect(result.message.senderJid).toBe("participant@s.whatsapp.net");
    expect(result.message.mentionedJids).toEqual(["bot@s.whatsapp.net"]);
    expect(result.message.text).toBe("@bot hi");
  });

  it("ignores messages sent from the socket account", () => {
    const result = normalizeWhatsAppMessage(
      textMessage({ key: { remoteJid: "123@s.whatsapp.net", fromMe: true } }),
    );

    expect(result).toMatchObject({
      kind: "ignored",
      reason: "from_self",
      chatJid: "123@s.whatsapp.net",
    });
  });

  it("ignores empty text and unsupported media-only messages", () => {
    expect(
      normalizeWhatsAppMessage(
        textMessage({ message: { extendedTextMessage: { text: "   " } } }),
      ),
    ).toMatchObject({ kind: "ignored", reason: "empty_text" });

    expect(
      normalizeWhatsAppMessage(
        textMessage({ message: { imageMessage: { caption: "not supported" } } }),
      ),
    ).toMatchObject({ kind: "ignored", reason: "unsupported_message" });
  });

  it("ignores status and broadcast contexts", () => {
    expect(
      normalizeWhatsAppMessage(
        textMessage({ key: { remoteJid: "status@broadcast", id: "status" } }),
      ),
    ).toMatchObject({ kind: "ignored", reason: "status_broadcast_ignored" });

    expect(
      normalizeWhatsAppMessage(
        textMessage({ key: { remoteJid: "news@broadcast", id: "broadcast" } }),
      ),
    ).toMatchObject({ kind: "ignored", reason: "broadcast_ignored" });
  });
});

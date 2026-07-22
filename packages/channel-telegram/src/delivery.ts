import type { ChannelAttachment, ChannelDeliveryResult, ChannelOutboundMessage, ModuleDiagnostic } from "@mono-agent/module-sdk";

import type { TelegramConfig } from "./config.js";
import type { TelegramBotClient } from "./bot.js";

export class TelegramDelivery {
  private readonly settled = new Map<string, ChannelDeliveryResult>();
  private readonly pending = new Map<string, Promise<ChannelDeliveryResult>>();

  constructor(private readonly config: TelegramConfig, private readonly client: TelegramBotClient) {}

  deliver(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const key = message.idempotencyKey;
    const existing = this.settled.get(key);
    if (existing !== undefined) return Promise.resolve({ ...existing, status: "duplicate", idempotencyKey: key });
    const active = this.pending.get(key);
    if (active !== undefined) return active;
    const execution = this.send(message, signal).then((result) => {
      if (result.status === "delivered") {
        this.settled.set(key, result);
        while (this.settled.size > 1_000) this.settled.delete(this.settled.keys().next().value as string);
      }
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, execution);
    return execution;
  }

  private async send(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const chatId = destination(message.conversationId, this.config.defaultDestination);
    if (chatId === undefined || (!this.config.allowAllChats && !this.config.allowedChatIds.includes(chatId))) {
      return failed(message.idempotencyKey, "telegram_destination_forbidden", "Telegram delivery destination is not authorized.");
    }
    if (message.text.length === 0 && (message.attachments?.length ?? 0) === 0) {
      return failed(message.idempotencyKey, "telegram_delivery_empty", "Telegram delivery requires text or an attachment.");
    }
    for (const attachment of message.attachments ?? []) {
      if (attachment.sizeBytes !== attachment.data.byteLength || attachment.sizeBytes > this.config.maxAttachmentBytes) {
        return failed(message.idempotencyKey, "telegram_attachment_invalid", "Telegram delivery attachment size is invalid or exceeds the configured limit.");
      }
    }
    try {
      let messageId: string | undefined;
      if (message.text.length > 0) {
        messageId = (await this.client.sendMessage({ chatId, text: message.text, ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }), idempotencyKey: message.idempotencyKey, signal })).messageId;
      }
      for (const attachment of message.attachments ?? []) {
        messageId = (await this.sendAttachment(chatId, attachment, message.idempotencyKey, signal)).messageId;
      }
      return { status: "delivered", idempotencyKey: message.idempotencyKey, ...(messageId === undefined ? {} : { messageId }) };
    } catch {
      return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("telegram_delivery_unknown", "Telegram delivery outcome is unknown.") };
    }
  }

  private sendAttachment(chatId: string, attachment: ChannelAttachment, idempotencyKey: string | undefined, signal: AbortSignal) {
    return this.client.sendAttachment({ chatId, attachment, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), signal });
  }
}

function destination(conversationId: string, fallback: string | undefined): string | undefined {
  if (conversationId.startsWith("telegram:")) return conversationId.slice("telegram:".length).split(":", 1)[0];
  return conversationId.length === 0 ? fallback : undefined;
}

function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
function diagnostic(code: string, message: string): ModuleDiagnostic { return { code, severity: "error", message }; }

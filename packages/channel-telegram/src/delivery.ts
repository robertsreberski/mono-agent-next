import type { ChannelAttachment, ChannelDeliveryResult, ChannelOutboundMessage, ModuleDiagnostic } from "@mono-agent/module-sdk";

import { isWithinQuietHours, type TelegramConfig } from "./config.js";
import type { TelegramBotClient } from "./bot.js";

export class TelegramDelivery {
  private readonly settled = new Map<string, ChannelDeliveryResult>();
  private readonly pending = new Map<string, Promise<ChannelDeliveryResult>>();

  constructor(
    private readonly config: TelegramConfig,
    private readonly client: TelegramBotClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    const options = replyOptions(message.metadata);
    if (options.status === "invalid") {
      return failed(message.idempotencyKey, "telegram_reply_options_invalid", options.message);
    }
    if (options.buttons.length > 0 && message.text.length === 0) {
      return failed(message.idempotencyKey, "telegram_reply_options_without_text", "Telegram reply options require a text message.");
    }
    const caption = attachmentCaption(message.metadata);
    if (caption.status === "invalid") {
      return failed(message.idempotencyKey, "telegram_attachment_caption_invalid", caption.message);
    }
    if (caption.value !== undefined
      && ((message.attachments?.length ?? 0) !== 1
        || message.text !== caption.value
        || options.buttons.length > 0)) {
      return failed(
        message.idempotencyKey,
        "telegram_attachment_caption_invalid",
        "Telegram attachmentCaption requires exactly one attachment, matching text, and no reply options.",
      );
    }
    const disableNotification = this.config.quietHours === undefined
      ? undefined
      : isWithinQuietHours(this.now(), this.config.quietHours);
    try {
      let messageId: string | undefined;
      if (message.text.length > 0 && caption.value === undefined) {
        messageId = (await this.client.sendMessage({
          chatId,
          text: message.text,
          ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
          ...(options.buttons.length === 0 ? {} : { buttons: options.buttons }),
          ...(disableNotification === undefined ? {} : { disableNotification }),
          idempotencyKey: message.idempotencyKey,
          signal,
        })).messageId;
      }
      for (const attachment of message.attachments ?? []) {
        messageId = (await this.sendAttachment(
          chatId,
          attachment,
          message.idempotencyKey,
          disableNotification,
          caption.value,
          signal,
        )).messageId;
      }
      return { status: "delivered", idempotencyKey: message.idempotencyKey, ...(messageId === undefined ? {} : { messageId }) };
    } catch {
      return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("telegram_delivery_unknown", "Telegram delivery outcome is unknown.") };
    }
  }

  private sendAttachment(
    chatId: string,
    attachment: ChannelAttachment,
    idempotencyKey: string | undefined,
    disableNotification: boolean | undefined,
    caption: string | undefined,
    signal: AbortSignal,
  ) {
    return this.client.sendAttachment({
      chatId,
      attachment,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(disableNotification === undefined ? {} : { disableNotification }),
      ...(caption === undefined ? {} : { caption }),
      signal,
    });
  }
}

type ReplyOptionsResult =
  | { readonly status: "valid"; readonly buttons: readonly { readonly label: string; readonly data: string }[] }
  | { readonly status: "invalid"; readonly buttons: readonly []; readonly message: string };

function replyOptions(metadata: ChannelOutboundMessage["metadata"]): ReplyOptionsResult {
  const telegram = metadata?.telegram;
  if (telegram === undefined) return { status: "valid", buttons: [] };
  if (!isRecord(telegram)) {
    return invalidOptions("Telegram delivery metadata.telegram must be an object.");
  }
  const values = telegram.replyOptions;
  if (values === undefined) return { status: "valid", buttons: [] };
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    return invalidOptions("Telegram replyOptions must contain between 1 and 8 labels.");
  }
  const seen = new Set<string>();
  const buttons: { label: string; data: string }[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 64 || seen.has(value)) {
      return invalidOptions("Telegram replyOptions labels must be unique non-empty strings of at most 64 characters.");
    }
    const data = `reply:${Buffer.from(value, "utf8").toString("base64url")}`;
    if (Buffer.byteLength(data, "utf8") > 64) {
      return invalidOptions("Telegram replyOptions labels exceed Telegram's callback-data bound.");
    }
    seen.add(value);
    buttons.push({ label: value, data });
  }
  return { status: "valid", buttons: Object.freeze(buttons) };
}

function invalidOptions(message: string): ReplyOptionsResult {
  return { status: "invalid", buttons: [], message };
}

type AttachmentCaptionResult =
  | { readonly status: "valid"; readonly value?: string }
  | { readonly status: "invalid"; readonly message: string };

function attachmentCaption(
  metadata: ChannelOutboundMessage["metadata"],
): AttachmentCaptionResult {
  const telegram = metadata?.telegram;
  if (telegram === undefined || !isRecord(telegram)
    || telegram.attachmentCaption === undefined) {
    return { status: "valid" };
  }
  const value = telegram.attachmentCaption;
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    return {
      status: "invalid",
      message: "Telegram attachmentCaption must be a non-empty string of at most 1024 characters.",
    };
  }
  return { status: "valid", value };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function destination(conversationId: string, fallback: string | undefined): string | undefined {
  if (conversationId.startsWith("telegram:")) {
    const chatId = conversationId.slice("telegram:".length);
    return chatId.length > 0 && !chatId.includes(":") ? chatId : undefined;
  }
  return conversationId.length === 0 ? fallback : undefined;
}

function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
function diagnostic(code: string, message: string): ModuleDiagnostic { return { code, severity: "error", message }; }

// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  ChannelAttachment,
  ChannelDeliveryResult,
  ChannelOutboundMessage,
  JsonObject,
  JsonValue,
  ModuleDiagnostic,
} from "@mono-agent/module-sdk";

import { isWithinQuietHours, type TelegramConfig } from "./config.js";
import type { TelegramBotClient } from "./bot.js";
import {
  resolveTelegramChatId,
  telegramConversationId,
} from "./destination.js";
import { isRecord } from "./http.js";

const MAX_DELIVERY_RECEIPTS = 1_000;
const MAX_DELIVERY_ATTACHMENTS = 10;
const MAX_TOTAL_ATTACHMENT_BYTES = 50_000_000;
const MAX_METADATA_BYTES = 65_536;
const MAX_METADATA_ITEMS = 2_048;
const MAX_METADATA_DEPTH = 16;

interface DeliveryReceipt {
  readonly fingerprint: string;
  readonly promise: Promise<ChannelDeliveryResult>;
  result?: ChannelDeliveryResult;
}

interface PreparedTelegramDelivery {
  readonly message: ChannelOutboundMessage;
  readonly chatId: string;
}

export class TelegramDelivery {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private capacityExhausted = false;
  private ambiguousOutcome = false;

  constructor(
    private readonly config: TelegramConfig,
    private readonly client: TelegramBotClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get degraded(): boolean {
    return this.capacityExhausted || this.ambiguousOutcome;
  }

  get receiptCapacityExhausted(): boolean {
    return this.capacityExhausted;
  }

  get hasAmbiguousOutcome(): boolean {
    return this.ambiguousOutcome;
  }

  deliver(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const prepared = prepareTelegramDelivery(message, this.config);
    if ("failure" in prepared) return Promise.resolve(prepared.failure);
    const key = prepared.message.idempotencyKey;
    const fingerprint = deliveryFingerprint(prepared.message);
    const existing = this.receipts.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(failed(
          key,
          "telegram_delivery_idempotency_conflict",
          "The Telegram delivery idempotency key was reused for a different payload.",
        ));
      }
      if (existing.result?.status === "delivered" || existing.result?.status === "duplicate") {
        return Promise.resolve({ ...existing.result, status: "duplicate", idempotencyKey: key });
      }
      return existing.promise;
    }
    if (this.receipts.size >= MAX_DELIVERY_RECEIPTS) {
      this.capacityExhausted = true;
      return Promise.resolve(failed(
        key,
        "telegram_delivery_receipt_capacity",
        "Telegram delivery receipt capacity is exhausted; restart-safe Core delivery authority is required.",
      ));
    }
    let receipt: DeliveryReceipt;
    const execution = this.send(prepared, signal).catch(() => ({
      status: "unknown" as const,
      idempotencyKey: key,
      diagnostic: diagnostic(
        "telegram_delivery_unknown",
        "Telegram delivery outcome is unknown.",
      ),
    })).then((result) => {
      if (result.status === "delivered" || result.status === "duplicate" || result.status === "unknown") {
        receipt.result = result;
        if (result.status === "unknown") this.ambiguousOutcome = true;
      } else {
        this.receipts.delete(key);
        this.capacityExhausted = this.receipts.size >= MAX_DELIVERY_RECEIPTS;
      }
      return result;
    });
    receipt = { fingerprint, promise: execution };
    this.receipts.set(key, receipt);
    return execution;
  }

  private async send(prepared: PreparedTelegramDelivery, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const { chatId, message } = prepared;
    if (message.text.length === 0 && (message.attachments?.length ?? 0) === 0) {
      return failed(message.idempotencyKey, "telegram_delivery_empty", "Telegram delivery requires text or an attachment.");
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

function prepareTelegramDelivery(
  value: ChannelOutboundMessage,
  config: TelegramConfig,
):
  | PreparedTelegramDelivery
  | { readonly failure: ChannelDeliveryResult } {
  try {
    const input = ownDataRecord(value, "Telegram outbound message", [
      "conversationId",
      "text",
      "attachments",
      "replyToMessageId",
      "idempotencyKey",
      "metadata",
    ]);
    const key = boundedText(input.idempotencyKey, "idempotencyKey", 512);
    const conversationId = boundedText(
      input.conversationId,
      "conversationId",
      4_096,
      true,
    );
    const chatId = resolveTelegramChatId(
      conversationId,
      config.defaultDestination,
    );
    if (chatId === undefined
      || (!config.allowAllChats && !config.allowedChatIds.includes(chatId))) {
      return {
        failure: failed(
          key,
          "telegram_destination_forbidden",
          "Telegram delivery destination is not authorized.",
        ),
      };
    }
    const text = boundedText(input.text, "text", 4_096, true);
    const attachments = snapshotAttachments(
      input.attachments,
      config.maxAttachmentBytes,
    );
    const replyToMessageId = input.replyToMessageId === undefined
      ? undefined
      : boundedText(input.replyToMessageId, "replyToMessageId", 32);
    const metadata = input.metadata === undefined
      ? undefined
      : snapshotMetadata(input.metadata);
    return Object.freeze({
      chatId,
      message: Object.freeze({
        conversationId: telegramConversationId(chatId),
        text,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        idempotencyKey: key,
        ...(metadata === undefined ? {} : { metadata }),
      }),
    });
  } catch {
    const key = safeIdempotencyKey(value);
    return {
      failure: failed(
        key,
        "telegram_delivery_invalid",
        "Telegram delivery payload is invalid or exceeds a configured bound.",
      ),
    };
  }
}

function deliveryFingerprint(message: ChannelOutboundMessage): string {
  const encoded = JSON.stringify({
    conversationId: message.conversationId,
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: createHash("sha256").update(attachment.data).digest("hex"),
    })),
    replyToMessageId: message.replyToMessageId ?? null,
    metadata: message.metadata ?? null,
  }, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
  return createHash("sha256").update(encoded).digest("hex");
}

function snapshotAttachments(
  value: unknown,
  maxAttachmentBytes: number,
): readonly ChannelAttachment[] {
  if (value === undefined) return Object.freeze([]);
  if (utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_DELIVERY_ATTACHMENTS) {
    throw new TypeError("attachments must be one bounded ordinary array");
  }
  assertDenseDataArray(value, "attachments");
  let totalBytes = 0;
  const attachments = value.map((entry, index): ChannelAttachment => {
    const input = ownDataRecord(entry, `attachment ${String(index)}`, [
      "id",
      "kind",
      "name",
      "mediaType",
      "sizeBytes",
      "data",
    ]);
    if (input.kind !== "image" && input.kind !== "audio" && input.kind !== "file") {
      throw new TypeError("attachment kind is invalid");
    }
    const sizeBytes = input.sizeBytes;
    if (!Number.isSafeInteger(sizeBytes)
      || (sizeBytes as number) < 0
      || (sizeBytes as number) > maxAttachmentBytes) {
      throw new TypeError("attachment size is invalid");
    }
    const source = input.data;
    if (utilTypes.isProxy(source) || !(source instanceof Uint8Array)) {
      throw new TypeError("attachment data must be Uint8Array");
    }
    if (source.byteLength !== sizeBytes
      || totalBytes + source.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new TypeError("attachment size does not match its bounded data");
    }
    const data = new Uint8Array(source);
    if (data.byteLength !== sizeBytes) {
      throw new TypeError("attachment size does not match data");
    }
    totalBytes += data.byteLength;
    return Object.freeze({
      id: boundedText(input.id, "attachment id", 512),
      kind: input.kind,
      name: boundedText(input.name, "attachment name", 1_024),
      mediaType: boundedText(input.mediaType, "attachment mediaType", 255),
      sizeBytes: data.byteLength,
      data,
    });
  });
  return Object.freeze(attachments);
}

function snapshotMetadata(value: unknown): JsonObject {
  const state = {
    items: 0,
    bytes: 0,
    seen: new WeakSet<object>(),
  };
  const snapshot = snapshotJson(value, state, 0);
  if (!isRecord(snapshot)) throw new TypeError("metadata must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_METADATA_BYTES) {
    throw new TypeError("metadata exceeds the delivery bound");
  }
  return snapshot as JsonObject;
}

function snapshotJson(
  value: unknown,
  state: { items: number; bytes: number; seen: WeakSet<object> },
  depth: number,
): JsonValue {
  state.items += 1;
  if (state.items > MAX_METADATA_ITEMS || depth > MAX_METADATA_DEPTH) {
    throw new TypeError("metadata exceeds the delivery structure bound");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("metadata number is invalid");
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_METADATA_BYTES) {
      throw new TypeError("metadata exceeds the delivery byte bound");
    }
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("metadata contains a non-JSON value");
  }
  if (state.seen.has(value)) throw new TypeError("metadata contains a cycle");
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || value.length > MAX_METADATA_ITEMS) {
      throw new TypeError("metadata array is invalid");
    }
    assertDenseDataArray(value, "metadata array");
    const output = value.map((entry) => snapshotJson(entry, state, depth + 1));
    state.seen.delete(value);
    return Object.freeze(output);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("metadata object is invalid");
  }
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string"
      || key === "__proto__"
      || key === "prototype"
      || key === "constructor") {
      throw new TypeError("metadata key is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("metadata property is invalid");
    }
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MAX_METADATA_BYTES) {
      throw new TypeError("metadata exceeds the delivery byte bound");
    }
    output[key] = snapshotJson(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return Object.freeze(output);
}

function assertDenseDataArray(value: readonly unknown[], label: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError(`${label} must contain only dense data entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only dense data entries`);
    }
  }
}

function ownDataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const fields = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.has(key)) {
      throw new TypeError(`${label} contains an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function boundedText(
  value: unknown,
  label: string,
  maxCharacters: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maxCharacters
    || value.includes("\0")) {
    throw new TypeError(`${label} exceeds its delivery bound`);
  }
  return value;
}

function safeIdempotencyKey(value: unknown): string {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return "invalid";
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "idempotencyKey");
  return descriptor !== undefined
    && "value" in descriptor
    && typeof descriptor.value === "string"
    && descriptor.value.length > 0
    && descriptor.value.length <= 512
    && !descriptor.value.includes("\0")
      ? descriptor.value
      : "invalid";
}

function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
function diagnostic(code: string, message: string): ModuleDiagnostic { return { code, severity: "error", message }; }

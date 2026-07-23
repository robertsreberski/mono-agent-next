import { createHash } from "node:crypto";

import type {
  ChannelDeliveryResult,
  ChannelOutboundMessage,
  JsonSchema,
  JsonValue,
  RuntimeToolDefinition,
} from "@mono-agent/module-sdk";

import type { TelegramConfig } from "./config.js";

const MAX_TELEGRAM_MESSAGE_CHARACTERS = 4_096;
const MAX_TELEGRAM_CAPTION_CHARACTERS = 1_024;
const MAX_INLINE_TOOL_FILE_BYTES = 180 * 1024;

interface ChannelSendToolContext {
  readonly requestId: string;
  readonly conversationId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface TelegramChannelSendTool extends RuntimeToolDefinition {
  prepare(
    input: JsonValue,
    context: ChannelSendToolContext,
  ): Omit<ChannelOutboundMessage, "idempotencyKey">;
  historyConversationId(
    message: ChannelOutboundMessage,
    result: ChannelDeliveryResult,
  ): string;
}

export function createTelegramSendTools(
  config: TelegramConfig,
): readonly TelegramChannelSendTool[] {
  const inlineFileBytes = Math.min(
    config.maxAttachmentBytes,
    MAX_INLINE_TOOL_FILE_BYTES,
  );
  const chatIdSchema: JsonSchema = {
    anyOf: [
      { type: "string", minLength: 1, maxLength: 128 },
      { type: "integer" },
    ],
  };
  return Object.freeze([
    Object.freeze({
      name: "TelegramSendMessage",
      description: "Send one exact text message to a Telegram chat authorized by this configured channel instance. Optional reply_options are non-blocking.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["chat_id", "text"],
        properties: {
          chat_id: chatIdSchema,
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TELEGRAM_MESSAGE_CHARACTERS,
          },
          reply_to_message_id: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 32, pattern: "^[0-9]+$" },
              { type: "integer", minimum: 1 },
            ],
          },
          reply_options: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      }),
      prepare(input: JsonValue) {
        const value = record(
          input,
          ["chat_id", "text", "reply_to_message_id", "reply_options"],
          "TelegramSendMessage input",
        );
        const chatId = identifier(value.chat_id, "chat_id");
        const text = boundedText(
          value.text,
          "text",
          MAX_TELEGRAM_MESSAGE_CHARACTERS,
        );
        const replyTo = value.reply_to_message_id === undefined
          ? undefined
          : positiveIntegerIdentifier(value.reply_to_message_id, "reply_to_message_id");
        const options = value.reply_options === undefined
          ? undefined
          : replyOptions(value.reply_options);
        return {
          conversationId: `telegram:${chatId}`,
          text,
          ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
          ...(options === undefined
            ? {}
            : { metadata: { telegram: { replyOptions: options } } }),
        };
      },
      historyConversationId(message: ChannelOutboundMessage) {
        return message.conversationId;
      },
    } satisfies TelegramChannelSendTool),
    Object.freeze({
      name: "TelegramSendFile",
      description: `Send one inline base64 document or photo of at most ${String(inlineFileBytes)} bytes to a Telegram chat authorized by this configured channel instance.`,
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["kind", "chat_id", "data", "filename"],
        properties: {
          kind: { type: "string", enum: ["document", "photo"] },
          chat_id: chatIdSchema,
          data: {
            type: "string",
            minLength: 4,
            maxLength: Math.ceil(inlineFileBytes / 3) * 4,
            pattern: "^[A-Za-z0-9+/]+={0,2}$",
          },
          filename: { type: "string", minLength: 1, maxLength: 255 },
          media_type: { type: "string", minLength: 3, maxLength: 255 },
          caption: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TELEGRAM_CAPTION_CHARACTERS,
          },
        },
      }),
      prepare(input: JsonValue) {
        const value = record(
          input,
          ["kind", "chat_id", "data", "filename", "media_type", "caption"],
          "TelegramSendFile input",
        );
        if (value.kind !== "document" && value.kind !== "photo") {
          throw new TypeError("kind must be document or photo.");
        }
        const chatId = identifier(value.chat_id, "chat_id");
        const data = canonicalBase64(value.data, inlineFileBytes);
        const filename = safeFileName(value.filename);
        const mediaType = value.media_type === undefined
          ? value.kind === "photo" ? "image/jpeg" : "application/octet-stream"
          : validMediaType(value.media_type);
        if (value.kind === "photo" && !mediaType.startsWith("image/")) {
          throw new TypeError("TelegramSendFile photo media_type must be an image type.");
        }
        const caption = value.caption === undefined
          ? undefined
          : boundedText(
              value.caption,
              "caption",
              MAX_TELEGRAM_CAPTION_CHARACTERS,
            );
        const digest = createHash("sha256").update(data).digest("hex");
        return {
          conversationId: `telegram:${chatId}`,
          text: caption ?? "",
          attachments: [Object.freeze({
            id: `telegram-send:${digest.slice(0, 32)}`,
            kind: value.kind === "photo" ? "image" : "file",
            name: filename,
            mediaType,
            sizeBytes: data.byteLength,
            data,
          })],
          ...(caption === undefined
            ? {}
            : { metadata: { telegram: { attachmentCaption: caption } } }),
        };
      },
      historyConversationId(message: ChannelOutboundMessage) {
        return message.conversationId;
      },
    } satisfies TelegramChannelSendTool),
  ]);
}

function record(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const allowedKeys = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError(`${label} contains an unknown field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label}.${key} must be a data property.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function identifier(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer or string.`);
    value = String(value);
  }
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || value.includes(":")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
}

function positiveIntegerIdentifier(value: unknown, label: string): string {
  const normalized = identifier(value, label);
  if (!/^[1-9][0-9]*$/u.test(normalized)
    || !Number.isSafeInteger(Number(normalized))) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string of at most ${String(max)} characters.`);
  }
  return value;
}

function replyOptions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw new TypeError("reply_options must contain between 2 and 8 labels.");
  }
  const labels = value.map((label) => boundedText(label, "reply_options label", 64));
  if (new Set(labels).size !== labels.length) {
    throw new TypeError("reply_options labels must be unique.");
  }
  if (labels.some((label) =>
    Buffer.byteLength(`reply:${Buffer.from(label, "utf8").toString("base64url")}`, "utf8") > 64)) {
    throw new TypeError("reply_options label exceeds Telegram's callback-data bound.");
  }
  return Object.freeze(labels);
}

function canonicalBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw new TypeError("data must be non-empty canonical base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new TypeError("data must be non-empty canonical base64.");
  }
  if (bytes.byteLength > maxBytes) {
    throw new RangeError(`data exceeds the ${String(maxBytes)}-byte inline file bound.`);
  }
  return new Uint8Array(bytes);
}

function safeFileName(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || value !== value.trim()
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("filename must be one safe basename.");
  }
  return value;
}

function validMediaType(value: unknown): string {
  if (typeof value !== "string"
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu.test(value)) {
    throw new TypeError("media_type must be a valid bounded media type.");
  }
  return value.toLowerCase();
}

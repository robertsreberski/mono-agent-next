// SPDX-License-Identifier: MIT
import type { ChannelAttachment } from "@mono-agent/module-sdk";
import { Agent, type Dispatcher } from "undici";

import type { TelegramConfig } from "./config.js";
import { isRecord, readBoundedBytes, readBoundedJson } from "./http.js";
import { createTelegramTranscriber } from "./transcription.js";

export interface TelegramRemoteAttachment {
  readonly fileId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes?: number;
  readonly transcriptionEligible?: boolean;
}

export interface TelegramMessageUpdate {
  readonly updateId: number;
  readonly kind: "message";
  readonly chatId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly text: string;
  readonly attachments: readonly TelegramRemoteAttachment[];
  readonly receivedAt: string;
}

export interface TelegramCallbackUpdate {
  readonly updateId: number;
  readonly kind: "callback";
  readonly callbackId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly data: string;
  readonly receivedAt: string;
}

interface TelegramIgnoredUpdate {
  readonly updateId: number;
  readonly kind: "ignored";
}

export type TelegramUpdate = TelegramMessageUpdate | TelegramCallbackUpdate | TelegramIgnoredUpdate;

export interface TelegramSendMessageRequest {
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: string;
  readonly buttons?: readonly { readonly label: string; readonly data: string }[];
  readonly disableNotification?: boolean;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}

export interface TelegramEditMessageRequest {
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface TelegramSendAttachmentRequest {
  readonly chatId: string;
  readonly attachment: ChannelAttachment;
  readonly caption?: string;
  readonly disableNotification?: boolean;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}

export interface TelegramBotClient {
  poll(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<readonly TelegramUpdate[]>;
  download(attachment: TelegramRemoteAttachment, maxBytes: number, signal: AbortSignal): Promise<ChannelAttachment>;
  sendMessage(request: TelegramSendMessageRequest): Promise<{ readonly messageId: string }>;
  editMessage?(request: TelegramEditMessageRequest): Promise<void>;
  sendAttachment(request: TelegramSendAttachmentRequest): Promise<{ readonly messageId: string }>;
  transcribe?(attachment: ChannelAttachment, signal: AbortSignal): Promise<string>;
  answerCallback?(callbackId: string, signal: AbortSignal): Promise<void>;
  setReaction?(chatId: string, messageId: string, emoji: string, signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}

export type TelegramBotClientFactory = (config: TelegramConfig) => TelegramBotClient;

export function createTelegramBotApiClient(config: TelegramConfig, fetchImpl: typeof fetch = fetch): TelegramBotClient {
  const api = `https://api.telegram.org/bot${config.botToken}`;
  const fileApi = `https://api.telegram.org/file/bot${config.botToken}`;
  const dispatcher = config.transport?.ipFamily === undefined
    ? undefined
    : new Agent({ connect: { family: config.transport.ipFamily } });
  const telegramFetch = (
    input: string | URL | Request,
    init: RequestInit,
  ): Promise<Response> => fetchImpl(input, {
    ...init,
    ...(dispatcher === undefined ? {} : { dispatcher }),
  } as RequestInit & { dispatcher?: Dispatcher });
  const call = async (method: string, body: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> => {
    const response = await telegramFetch(`${api}/${method}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const value = await readBoundedJson(response, 2 * 1024 * 1024, "Telegram API response");
    if (!response.ok || !isRecord(value) || value.ok !== true) throw new Error(`Telegram API ${method} failed with HTTP ${response.status}.`);
    return value.result;
  };

  return {
    async poll(offset, timeoutSeconds, signal) {
      const raw = await call("getUpdates", {
        offset,
        limit: 100,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      }, signal);
      if (!Array.isArray(raw)) throw new Error("Telegram getUpdates returned an invalid result.");
      return raw.map(parseUpdate).filter((update): update is TelegramUpdate => update !== undefined);
    },
    async download(attachment, maxBytes, signal) {
      if (attachment.sizeBytes !== undefined && attachment.sizeBytes > maxBytes) throw new Error("Telegram attachment exceeds the configured byte limit.");
      const file = await call("getFile", { file_id: attachment.fileId }, signal);
      if (!isRecord(file) || typeof file.file_path !== "string" || !safeFilePath(file.file_path)) throw new Error("Telegram getFile returned an invalid path.");
      const response = await telegramFetch(`${fileApi}/${file.file_path}`, { signal, redirect: "error" });
      if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
      const data = await readBoundedBytes(response, maxBytes, "Telegram attachment");
      return { id: attachment.fileId, kind: attachmentKind(attachment.mediaType), name: safeName(attachment.name), mediaType: attachment.mediaType, sizeBytes: data.byteLength, data };
    },
    async sendMessage(request) {
      const result = await call("sendMessage", {
        chat_id: request.chatId,
        text: request.text,
        ...(request.replyToMessageId === undefined ? {} : { reply_parameters: { message_id: numericMessageId(request.replyToMessageId) } }),
        ...(request.buttons === undefined || request.buttons.length === 0 ? {} : { reply_markup: { inline_keyboard: [request.buttons.map((button) => ({ text: button.label, callback_data: button.data }))] } }),
        ...(request.disableNotification === undefined ? {} : { disable_notification: request.disableNotification }),
      }, request.signal);
      return { messageId: telegramMessageId(result) };
    },
    async editMessage(request) {
      await call("editMessageText", {
        chat_id: request.chatId,
        message_id: numericMessageId(request.messageId),
        text: request.text,
      }, request.signal);
    },
    async sendAttachment(request) {
      const bytes = Buffer.from(request.attachment.data);
      const form = new FormData();
      const photo = request.attachment.kind === "image";
      const field = photo ? "photo" : "document";
      form.set("chat_id", request.chatId);
      form.set(field, new Blob([bytes], { type: request.attachment.mediaType }), safeName(request.attachment.name));
      if (request.caption !== undefined) form.set("caption", request.caption);
      if (request.disableNotification !== undefined) form.set("disable_notification", String(request.disableNotification));
      const method = photo ? "sendPhoto" : "sendDocument";
      const response = await telegramFetch(`${api}/${method}`, { method: "POST", body: form, signal: request.signal, redirect: "error" });
      const value = await readBoundedJson(response, 2 * 1024 * 1024, "Telegram API response");
      if (!response.ok || !isRecord(value) || value.ok !== true) throw new Error(`Telegram ${method} failed with HTTP ${response.status}.`);
      return { messageId: telegramMessageId(value.result) };
    },
    async answerCallback(callbackId, signal) { await call("answerCallbackQuery", { callback_query_id: callbackId }, signal); },
    async setReaction(chatId, messageId, emoji, signal) { await call("setMessageReaction", { chat_id: chatId, message_id: numericMessageId(messageId), reaction: [{ type: "emoji", emoji }] }, signal); },
    ...(config.transcription === undefined
      ? {}
      : { transcribe: createTelegramTranscriber(config.transcription, fetchImpl) }),
    async close() { await dispatcher?.close(); },
  };
}

function parseUpdate(value: unknown): TelegramUpdate | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.update_id)) return undefined;
  const updateId = value.update_id as number;
  const ignored: TelegramIgnoredUpdate = { updateId, kind: "ignored" };
  const now = new Date().toISOString();
  if (isRecord(value.message)) {
    const message = value.message;
    if (!isRecord(message.chat) || !isRecord(message.from) || !Number.isSafeInteger(message.message_id)) return ignored;
    const chatId = identifier(message.chat.id);
    const senderId = identifier(message.from.id);
    if (chatId === undefined || senderId === undefined) return ignored;
    const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
    const senderName = telegramName(message.from);
    return { updateId, kind: "message", chatId, messageId: String(message.message_id), senderId, ...(senderName === undefined ? {} : { senderName }), text, attachments: Object.freeze(parseAttachments(message)), receivedAt: typeof message.date === "number" ? new Date(message.date * 1_000).toISOString() : now };
  }
  if (isRecord(value.callback_query)) {
    const callback = value.callback_query;
    if (typeof callback.id !== "string" || typeof callback.data !== "string" || !isRecord(callback.from) || !isRecord(callback.message) || !isRecord(callback.message.chat) || !Number.isSafeInteger(callback.message.message_id)) return ignored;
    const chatId = identifier(callback.message.chat.id);
    const senderId = identifier(callback.from.id);
    if (chatId === undefined || senderId === undefined) return ignored;
    return { updateId, kind: "callback", callbackId: callback.id, chatId, messageId: String(callback.message.message_id), senderId, data: callback.data, receivedAt: now };
  }
  return ignored;
}

function parseAttachments(message: Record<string, unknown>): TelegramRemoteAttachment[] {
  const result: TelegramRemoteAttachment[] = [];
  if (isRecord(message.document) && typeof message.document.file_id === "string") result.push(remote(message.document, typeof message.document.file_name === "string" ? message.document.file_name : "document", typeof message.document.mime_type === "string" ? message.document.mime_type : "application/octet-stream"));
  if (isRecord(message.voice) && typeof message.voice.file_id === "string") result.push(remote(message.voice, "voice.ogg", typeof message.voice.mime_type === "string" ? message.voice.mime_type : "audio/ogg", true));
  if (isRecord(message.audio) && typeof message.audio.file_id === "string") result.push(remote(message.audio, typeof message.audio.file_name === "string" ? message.audio.file_name : "audio", typeof message.audio.mime_type === "string" ? message.audio.mime_type : "audio/mpeg", true));
  if (isRecord(message.video_note) && typeof message.video_note.file_id === "string") result.push(remote(message.video_note, "video-note.mp4", typeof message.video_note.mime_type === "string" ? message.video_note.mime_type : "video/mp4", true));
  if (Array.isArray(message.photo)) {
    const photo = [...message.photo].reverse().find(isRecord);
    if (photo !== undefined && typeof photo.file_id === "string") result.push(remote(photo, "photo.jpg", "image/jpeg"));
  }
  return result;
}

function remote(value: Record<string, unknown>, name: string, mediaType: string, transcriptionEligible = false): TelegramRemoteAttachment {
  return { fileId: value.file_id as string, name: safeName(name), mediaType, ...(Number.isSafeInteger(value.file_size) ? { sizeBytes: value.file_size as number } : {}), ...(transcriptionEligible ? { transcriptionEligible: true } : {}) };
}

function telegramName(from: Record<string, unknown>): string | undefined {
  const parts = [from.first_name, from.last_name].filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.length > 0 ? parts.join(" ").slice(0, 256) : undefined;
}

function telegramMessageId(value: unknown): string {
  if (!isRecord(value) || !Number.isSafeInteger(value.message_id)) throw new Error("Telegram send returned an invalid message id.");
  return String(value.message_id);
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : undefined;
}

function safeName(value: string): string {
  const name = value.replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, "_").trim() ?? "attachment";
  return (name.length === 0 ? "attachment" : name).slice(0, 255);
}

function attachmentKind(mediaType: string): "image" | "audio" | "file" {
  return mediaType.startsWith("image/") ? "image" : mediaType.startsWith("audio/") ? "audio" : "file";
}

function safeFilePath(value: string): boolean {
  return value.length > 0
    && value.length <= 1_024
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("?")
    && !value.includes("#")
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function numericMessageId(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("Telegram reply message id is invalid.");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Telegram reply message id is invalid.");
  return result;
}

// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import type { ChannelAttachment, ChannelInboundRequest, JsonObject, JsonValue } from "@mono-agent/module-sdk";

import type { OpenAiApiConfig } from "./config.js";

export interface OpenAiChatRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  readonly conversationId: string;
  readonly user?: string;
  readonly text: string;
  readonly attachments: readonly ChannelAttachment[];
  readonly warnings: readonly string[];
  readonly metadata: JsonObject;
}

export class OpenAiRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "OpenAiRequestError"; }
}

export function parseOpenAiChatRequest(
  value: unknown,
  config: OpenAiApiConfig,
  conversationHint?: string,
): OpenAiChatRequest {
  const input = record(value, "request");
  const allowed = new Set(["model", "messages", "stream", "stream_options", "user", "conversation_id", "metadata", "temperature", "top_p", "max_tokens", "max_completion_tokens", "frequency_penalty", "presence_penalty", "stop", "seed", "n", "tools", "tool_choice", "parallel_tool_calls", "response_format"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new OpenAiRequestError("invalid_request", `Unknown request field(s): ${unknown.join(", ")}.`);
  if (input.model !== config.modelId) throw new OpenAiRequestError("model_not_found", `Model ${String(input.model)} is not available.`, 404);
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 1_000) throw new OpenAiRequestError("invalid_messages", "messages must contain 1-1000 entries.");
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw new OpenAiRequestError("invalid_stream", "stream must be a boolean.");
  const includeUsage = parseStreamOptions(input.stream_options, input.stream === true);
  if (input.n !== undefined && input.n !== 1) throw new OpenAiRequestError("unsupported_n", "Only n=1 is supported.");
  const warnings: string[] = [];
  for (const field of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "seed", "tools", "tool_choice", "parallel_tool_calls", "response_format", "max_tokens", "max_completion_tokens"]) if (input[field] !== undefined) warnings.push(`${field}_ignored`);
  const messages: {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly text: string;
    readonly attachments: readonly ChannelAttachment[];
  }[] = [];
  for (const [index, raw] of input.messages.entries()) {
    const message = record(raw, `messages[${index}]`);
    const fields = Object.keys(message).filter((key) => !["role", "content", "name", "tool_call_id", "tool_calls"].includes(key));
    if (fields.length > 0) throw new OpenAiRequestError("invalid_message", `messages[${index}] contains unknown field(s): ${fields.join(", ")}.`);
    if (!isRole(message.role)) throw new OpenAiRequestError("invalid_message", `messages[${index}].role is invalid.`);
    if (message.name !== undefined || message.tool_call_id !== undefined || message.tool_calls !== undefined) throw new OpenAiRequestError("unsupported_message", `messages[${index}] uses tool/name fields this channel cannot represent.`);
    const messageAttachments: ChannelAttachment[] = [];
    const parts = parseContent(message.content, `messages[${index}].content`, config.maxImageBytes, messageAttachments);
    messages.push({ role: message.role, text: parts, attachments: Object.freeze(messageAttachments) });
  }
  const user = input.user === undefined ? undefined : identifier(input.user, "user");
  const metadataInput = input.metadata === undefined ? {} : jsonObject(input.metadata, "metadata");
  const authoredConversation = conversationIdentity(input, metadataInput, conversationHint);
  const selected = authoredConversation === undefined
    ? messages
    : [latestUserMessage(messages)];
  const attachments = selected.flatMap((message) => message.attachments);
  const transcript = selected.map((message) => `[${message.role}]\n${message.text}`);
  return Object.freeze({
    model: config.modelId,
    stream: input.stream === true,
    includeUsage,
    conversationId: `openai:${authoredConversation ?? randomUUID()}`,
    ...(user === undefined ? {} : { user }),
    text: transcript.join("\n\n"),
    attachments: Object.freeze(attachments),
    warnings: Object.freeze(warnings),
    metadata: Object.freeze({ ...metadataInput, protocol: "openai-chat-completions" }),
  });
}

function latestUserMessage<T extends { readonly role: string }>(messages: readonly T[]): T {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return messages[messages.length - 1]!;
}

function conversationIdentity(
  input: Record<string, unknown>,
  metadata: JsonObject,
  hint: string | undefined,
): string | undefined {
  const candidates = [
    metadata.conversation_id,
    metadata.conversationId,
    metadata.chat_id,
    metadata.chatId,
    input.conversation_id,
    hint,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return identifier(candidate, "conversation identity");
  }
  return undefined;
}

export function toChannelRequest(parsed: OpenAiChatRequest, requestId: string, signal: AbortSignal): ChannelInboundRequest {
  return { requestId, conversationId: parsed.conversationId, sender: { id: parsed.user ?? "openai-client" }, text: parsed.text, attachments: parsed.attachments, receivedAt: new Date().toISOString(), signal, metadata: parsed.metadata };
}

function parseContent(value: unknown, label: string, maxImageBytes: number, attachments: ChannelAttachment[]): string {
  if (typeof value === "string") return value;
  if (value === null) return "";
  if (!Array.isArray(value) || value.length > 1_000) throw new OpenAiRequestError("invalid_content", `${label} must be a string or bounded content array.`);
  const texts: string[] = [];
  for (const [index, raw] of value.entries()) {
    const part = record(raw, `${label}[${index}]`);
    if (part.type === "text" && typeof part.text === "string") { texts.push(part.text); continue; }
    if (part.type === "image_url") {
      const image = record(part.image_url, `${label}[${index}].image_url`);
      if (typeof image.url !== "string") throw new OpenAiRequestError("invalid_content", `${label}[${index}].image_url.url must be a string.`);
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(image.url);
      if (match === null) throw new OpenAiRequestError("unsafe_image_url", "Only inline base64 data image URLs are accepted.");
      const mediaType = match[1]!.toLowerCase();
      if (!/^image\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(mediaType)) throw new OpenAiRequestError("invalid_image", "image_url must contain a valid image media type.");
      const encoded = match[2]!;
      if (!isCanonicalBase64(encoded)) throw new OpenAiRequestError("invalid_image", "image_url must contain canonical padded base64.");
      const decodedBytes = decodedBase64Size(encoded);
      if (decodedBytes > maxImageBytes) throw new OpenAiRequestError("image_too_large", "Inline image exceeds the configured byte limit.", 413);
      const data = Buffer.from(encoded, "base64");
      if (data.byteLength !== decodedBytes || data.toString("base64") !== encoded) throw new OpenAiRequestError("invalid_image", "image_url must contain canonical padded base64.");
      if (data.byteLength > maxImageBytes) throw new OpenAiRequestError("image_too_large", "Inline image exceeds the configured byte limit.", 413);
      attachments.push({ id: `openai-image-${attachments.length + 1}`, kind: "image", name: `image-${attachments.length + 1}.${extension(mediaType)}`, mediaType, sizeBytes: data.byteLength, data: new Uint8Array(data) });
      continue;
    }
    throw new OpenAiRequestError("invalid_content", `${label}[${index}] is unsupported.`);
  }
  return texts.join("\n");
}

function parseStreamOptions(value: unknown, stream: boolean): boolean {
  if (value === undefined) return false;
  const options = record(value, "stream_options");
  const unknown = Object.keys(options).filter((key) => key !== "include_usage");
  if (unknown.length > 0) throw new OpenAiRequestError("invalid_stream_options", `stream_options contains unknown field(s): ${unknown.sort().join(", ")}.`);
  if (typeof options.include_usage !== "boolean") throw new OpenAiRequestError("invalid_stream_options", "stream_options.include_usage must be a boolean.");
  if (!stream) throw new OpenAiRequestError("invalid_stream_options", "stream_options requires stream=true.");
  return options.include_usage;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function extension(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  return "jpg";
}

function isRole(value: unknown): value is "system" | "user" | "assistant" | "tool" {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OpenAiRequestError("invalid_identifier", `${label} must be a bounded non-empty string.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAiRequestError("invalid_request", `${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OpenAiRequestError("invalid_request", `${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown, label: string): JsonObject {
  const result = record(value, label);
  assertJson(result, label, 0);
  return result as JsonObject;
}

function assertJson(value: unknown, label: string, depth: number): asserts value is JsonValue {
  if (depth > 20) {
    throw new OpenAiRequestError("invalid_metadata", `${label} exceeds maximum depth.`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) {
      throw new OpenAiRequestError("invalid_metadata", `${label} is too large.`);
    }
    value.forEach((entry, index) => {
      assertJson(entry, `${label}[${index}]`, depth + 1);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new OpenAiRequestError("invalid_metadata", `${label} contains an unsafe key.`);
      }
      assertJson(entry, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new OpenAiRequestError("invalid_metadata", `${label} must be JSON.`);
}

// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";

import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  RuntimeToolResultPart,
  RuntimeUsage,
  TurnContentPart,
  TurnMessage,
} from "@mono-agent/module-sdk";

import { piThinkingLevel } from "./models.js";
import { RuntimePiError } from "./runtime-errors.js";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function timestamp(value: string | undefined): number {
  if (value === undefined) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
  } catch {
    return String(value);
  }
}

export function runtimeUsage(usage: Usage): RuntimeUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cost: {
      currency: "USD",
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function imagePart(part: Extract<TurnContentPart, { type: "image" }>): ImageContent {
  return {
    type: "image",
    data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
    mimeType: part.mediaType,
  };
}

function filePartText(part: Extract<TurnContentPart, { type: "file" }>): string {
  if (part.mediaType.startsWith("text/") && typeof part.data === "string") return part.data;
  return `[Attached file ${JSON.stringify(part.name)} (${part.mediaType})]`;
}

function textAndImages(parts: readonly TurnContentPart[]): {
  readonly text: string;
  readonly images: ImageContent[];
} {
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const part of parts) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image") images.push(imagePart(part));
    else if (part.type === "file") {
      if (part.mediaType.startsWith("image/")) {
        images.push({
          type: "image",
          data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
          mimeType: part.mediaType,
        });
      } else text.push(filePartText(part));
    } else if (part.type === "attachment") {
      text.push(`[Attached file attachment_id=${JSON.stringify(part.attachment.id)} `
        + `name=${JSON.stringify(part.attachment.name)} media_type=${JSON.stringify(part.attachment.mediaType)}]`);
      if (part.attachment.kind === "image") {
        images.push({
          type: "image",
          data: Buffer.from(part.attachment.data).toString("base64"),
          mimeType: part.attachment.mediaType,
        });
      }
    }
  }
  return { text: text.join("\n"), images };
}

function piContent(parts: readonly TurnContentPart[]): string | (TextContent | ImageContent)[] {
  const { text, images } = textAndImages(parts);
  if (images.length === 0) return text;
  return [...(text === "" ? [] : [{ type: "text" as const, text }]), ...images];
}

function objectArguments(input: JsonValue): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input };
}

function collectToolNames(messages: readonly TurnMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") names.set(part.call.id, part.call.name);
    }
  }
  return names;
}

export function seedMessages(
  messages: readonly TurnMessage[],
  model: Model<string>,
): AgentMessage[] {
  const toolNames = collectToolNames(messages);
  const seeded: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      seeded.push({
        role: "user",
        content: piContent(message.content),
        timestamp: timestamp(message.createdAt),
      });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "tool-call") {
          content.push({
            type: "toolCall",
            id: part.call.id,
            name: part.call.name,
            arguments: objectArguments(part.call.input),
          });
        }
      }
      seeded.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: timestamp(message.createdAt),
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const result = part.result;
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: result.callId,
        toolName: toolNames.get(result.callId) ?? "tool",
        content: runtimeToolResultToPiContent(result.content),
        details: { runtimeResult: result },
        isError: result.isError ?? false,
        timestamp: timestamp(message.createdAt),
      };
      seeded.push(toolResult);
    }
  }
  return seeded;
}

export function runtimeToolResultToPiContent(
  content: readonly RuntimeToolResultPart[],
): (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (part.type === "text") result.push({ type: "text", text: part.text });
    else if (part.type === "json") result.push({ type: "text", text: JSON.stringify(part.value) });
    else if (part.type === "artifact") {
      const reference = [
        `[Tool artifact ${JSON.stringify(part.ref.id)}`,
        `(${part.ref.mediaType}, ${String(part.ref.sizeBytes)} bytes, ${part.ref.sha256})]`,
      ].join(" ");
      result.push({
        type: "text",
        text: part.preview === undefined ? reference : `${part.preview}\n${reference}`,
      });
    } else if (part.mediaType.startsWith("image/")) {
      result.push({
        type: "image",
        data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
        mimeType: part.mediaType,
      });
    } else {
      const body = part.mediaType.startsWith("text/") && typeof part.data === "string"
        ? part.data
        : `[Tool file${part.name === undefined ? "" : ` ${JSON.stringify(part.name)}`} (${part.mediaType})]`;
      result.push({ type: "text", text: body });
    }
  }
  return result.length === 0 ? [{ type: "text", text: "" }] : result;
}

export function systemPrompt(messages: readonly TurnMessage[]): string | undefined {
  const values = messages
    .filter((message) => message.role === "system")
    .map((message) => textAndImages(message.content).text)
    .filter((value) => value !== "");
  return values.length === 0 ? undefined : values.join("\n\n");
}

export function finalUser(messages: readonly TurnMessage[]): {
  readonly index: number;
  readonly text: string;
  readonly images: ImageContent[];
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return { index, ...textAndImages(message.content) };
  }
  throw new RuntimePiError(
    "UNSUPPORTED",
    "runtime-pi turn requires a user message",
    { retryable: false },
  );
}

export function assistantTurnMessage(message: AssistantMessage): TurnMessage {
  const content: TurnContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "toolCall") {
      content.push({
        type: "tool-call",
        call: { id: part.id, name: part.name, input: jsonValue(part.arguments) },
      });
    }
  }
  return {
    role: "assistant",
    content,
    createdAt: new Date(message.timestamp).toISOString(),
  };
}

/**
 * Resolve one authored effort against this exact model. Public-but-unsupported
 * levels retain Pi's native clamp; values outside the public vocabulary fail.
 */
export function thinkingLevel(
  effort: string | undefined,
  model: Model<string>,
): { readonly level: ThinkingLevel; readonly clamped: boolean } {
  const requested = piThinkingLevel(effort ?? "none");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(requested)) {
    throw new RuntimePiError(
      "UNSUPPORTED",
      `runtime-pi effort is unsupported: ${JSON.stringify(effort)}`,
      { retryable: false },
    );
  }
  const level = clampThinkingLevel(model, requested as ThinkingLevel) as ThinkingLevel;
  return { level, clamped: level !== requested };
}

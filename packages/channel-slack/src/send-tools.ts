import type {
  ChannelSendTool,
  ChannelDeliveryResult,
  ChannelOutboundMessage,
  JsonValue,
} from "@mono-agent/module-sdk";

import {
  parseSlackDestination,
  parseSlackIdentifier,
} from "./destination.js";

const MAX_SLACK_MESSAGE_CHARACTERS = 40_000;

export function createSlackSendTools(): readonly ChannelSendTool[] {
  return Object.freeze([
    Object.freeze({
      name: "SlackSendMessage",
      description: "Send one exact text message to a Slack channel authorized by this configured channel instance, optionally inside an existing thread.",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["channel", "text"],
        properties: {
          channel: { type: "string", minLength: 1, maxLength: 128 },
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SLACK_MESSAGE_CHARACTERS,
          },
          thread_ts: { type: "string", minLength: 1, maxLength: 128 },
        },
      }),
      prepare(input: JsonValue) {
        const value = record(
          input,
          ["channel", "text", "thread_ts"],
          "SlackSendMessage input",
        );
        const channel = parseSlackIdentifier(value.channel, "channel");
        const text = boundedText(
          value.text,
          "text",
          MAX_SLACK_MESSAGE_CHARACTERS,
        );
        const thread = value.thread_ts === undefined
          ? undefined
          : parseSlackIdentifier(value.thread_ts, "thread_ts");
        return {
          conversationId: `slack:${channel}${thread === undefined ? "" : `:${thread}`}`,
          text,
        };
      },
      historyConversationId(
        message: ChannelOutboundMessage,
        result: ChannelDeliveryResult,
      ) {
        if (result.status !== "delivered" && result.status !== "duplicate") {
          throw new TypeError("Slack destination history requires confirmed delivery.");
        }
        const destination = exactDestination(message.conversationId);
        if (destination.threadId !== undefined) {
          return message.conversationId;
        }
        const messageId = parseSlackIdentifier(result.messageId, "confirmed message id");
        return `slack:${destination.channelId}:${messageId}`;
      },
    } satisfies ChannelSendTool),
  ]);
}

function exactDestination(
  conversationId: string,
): { readonly channelId: string; readonly threadId?: string } {
  if (!conversationId.startsWith("slack:")) {
    throw new TypeError("Slack destination history requires a Slack conversation.");
  }
  return parseSlackDestination(
    conversationId.slice("slack:".length),
    "Slack destination history",
  );
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

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string of at most ${String(max)} characters.`);
  }
  return value;
}

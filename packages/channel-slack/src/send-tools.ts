import type {
  ChannelDeliveryResult,
  ChannelOutboundMessage,
  JsonValue,
  RuntimeToolDefinition,
} from "@mono-agent/module-sdk";

const MAX_SLACK_MESSAGE_CHARACTERS = 40_000;

interface ChannelSendToolContext {
  readonly requestId: string;
  readonly conversationId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface SlackChannelSendTool extends RuntimeToolDefinition {
  prepare(
    input: JsonValue,
    context: ChannelSendToolContext,
  ): Omit<ChannelOutboundMessage, "idempotencyKey">;
  historyConversationId(
    message: ChannelOutboundMessage,
    result: ChannelDeliveryResult,
  ): string;
}

export function createSlackSendTools(): readonly SlackChannelSendTool[] {
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
        const channel = identifier(value.channel, "channel");
        const text = boundedText(
          value.text,
          "text",
          MAX_SLACK_MESSAGE_CHARACTERS,
        );
        const thread = value.thread_ts === undefined
          ? undefined
          : identifier(value.thread_ts, "thread_ts");
        return {
          conversationId: `slack:${channel}${thread === undefined ? "" : `:${thread}`}`,
          text,
        };
      },
      historyConversationId(
        message: ChannelOutboundMessage,
        result: ChannelDeliveryResult,
      ) {
        const destination = message.conversationId.slice("slack:".length);
        if (destination.includes(":") || result.messageId === undefined) {
          return message.conversationId;
        }
        return `slack:${destination}:${result.messageId}`;
      },
    } satisfies SlackChannelSendTool),
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
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || value.includes(":")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be one bounded Slack identifier.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string of at most ${String(max)} characters.`);
  }
  return value;
}

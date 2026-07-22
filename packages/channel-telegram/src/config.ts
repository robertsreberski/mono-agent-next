import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_TELEGRAM_POLL_SECONDS = 20;
export const DEFAULT_TELEGRAM_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface TelegramReactionConfig {
  readonly working: boolean;
  readonly done: boolean;
  readonly error: boolean;
}

export interface TelegramConfig {
  /** Resolved by Core from an env-only secret reference. */
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
  readonly defaultDestination?: string;
  readonly pollSeconds: number;
  readonly maxAttachmentBytes: number;
  readonly reactions: TelegramReactionConfig;
}

export class TelegramConfigError extends Error {
  readonly code = "invalid_telegram_config";
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigError";
  }
}

export function parseTelegramConfig(value: unknown): TelegramConfig {
  const input = record(value, "Telegram channel config");
  exact(input, ["botToken", "allowedChatIds", "allowAllChats", "defaultDestination", "pollSeconds", "maxAttachmentBytes", "reactions"], "Telegram channel config");
  if (typeof input.botToken !== "string") fail("botToken must be a resolved env-only secret.");
  const botToken = nonEmpty(input.botToken, "botToken", 4_096);
  if (botToken.length < 20 || /\s/u.test(botToken)) fail("botToken must be a resolved 20-4096 character secret.");
  const allowAllChats = boolean(input.allowAllChats, "allowAllChats", false);
  const allowedChatIds = stringArray(input.allowedChatIds, "allowedChatIds");
  if (!allowAllChats && allowedChatIds.length === 0) fail("allowedChatIds must contain at least one exact chat id unless allowAllChats is true.");
  const unique = [...new Set(allowedChatIds)];
  if (unique.length !== allowedChatIds.length) fail("allowedChatIds must not contain duplicates.");
  const defaultDestination = input.defaultDestination === undefined
    ? undefined
    : identifier(input.defaultDestination, "defaultDestination");
  if (defaultDestination !== undefined && !allowAllChats && !unique.includes(defaultDestination)) {
    fail("defaultDestination must be one of allowedChatIds.");
  }
  const reactionsInput = input.reactions === undefined ? {} : record(input.reactions, "reactions");
  exact(reactionsInput, ["working", "done", "error"], "reactions");
  return Object.freeze({
    botToken,
    allowedChatIds: Object.freeze(unique),
    allowAllChats,
    ...(defaultDestination === undefined ? {} : { defaultDestination }),
    pollSeconds: integer(input.pollSeconds, "pollSeconds", DEFAULT_TELEGRAM_POLL_SECONDS, 1, 50),
    maxAttachmentBytes: integer(input.maxAttachmentBytes, "maxAttachmentBytes", DEFAULT_TELEGRAM_MAX_ATTACHMENT_BYTES, 1, MAX_TELEGRAM_ATTACHMENT_BYTES),
    reactions: Object.freeze({
      working: boolean(reactionsInput.working, "reactions.working", true),
      done: boolean(reactionsInput.done, "reactions.done", false),
      error: boolean(reactionsInput.error, "reactions.error", true),
    }),
  });
}

const chatIdSchema = envEligibleSchema({ type: "string", minLength: 1, maxLength: 128 });

export const telegramConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["botToken", "allowedChatIds"],
    properties: {
      botToken: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096 }, { secret: true }),
      allowedChatIds: { type: "array", uniqueItems: true, items: chatIdSchema },
      allowAllChats: { type: "boolean", default: false },
      defaultDestination: chatIdSchema,
      pollSeconds: { type: "integer", minimum: 1, maximum: 50, default: DEFAULT_TELEGRAM_POLL_SECONDS },
      maxAttachmentBytes: { type: "integer", minimum: 1, maximum: MAX_TELEGRAM_ATTACHMENT_BYTES, default: DEFAULT_TELEGRAM_MAX_ATTACHMENT_BYTES },
      reactions: {
        type: "object",
        additionalProperties: false,
        properties: {
          working: { type: "boolean", default: true },
          done: { type: "boolean", default: false },
          error: { type: "boolean", default: true },
        },
      },
    },
  }),
  parse: parseTelegramConfig,
});

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, names: readonly string[], label: string): void {
  const allowed = new Set(names);
  const unknown = Object.keys(value).filter((name) => !allowed.has(name)).sort();
  if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
}

function nonEmpty(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) fail(`${label} must be a non-empty string of at most ${max} characters.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = nonEmpty(value, label, 128);
  if (/\s/u.test(result)) fail(`${label} must not contain whitespace.`);
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000) fail(`${label} must be an array with at most 1000 entries.`);
  return value.map((item, index) => identifier(item, `${label}[${index}]`));
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function integer(value: unknown, label: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  return value as number;
}

function fail(message: string): never { throw new TelegramConfigError(message); }

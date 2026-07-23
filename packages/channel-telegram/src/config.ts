import { envEligibleSchema } from "@mono-agent/module-sdk";

import { parseTelegramChatId } from "./destination.js";

export const DEFAULT_TELEGRAM_POLL_SECONDS = 20;
export const DEFAULT_TELEGRAM_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS = 120_000;
export const MAX_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS = 3_600_000;

export interface TelegramReactionConfig {
  readonly working: boolean;
  readonly done: boolean;
  readonly error: boolean;
}

export interface TelegramQuietHours {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

export interface TelegramTransportConfig {
  readonly ipFamily?: 4 | 6;
}

export interface TelegramTranscriptionConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly language?: string;
  readonly timeoutMs: number;
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
  readonly quietHours?: TelegramQuietHours;
  readonly transport?: TelegramTransportConfig;
  readonly transcription?: TelegramTranscriptionConfig;
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
  exact(input, ["botToken", "allowedChatIds", "allowAllChats", "defaultDestination", "pollSeconds", "maxAttachmentBytes", "reactions", "quietHours", "transport", "transcription"], "Telegram channel config");
  if (typeof input.botToken !== "string") fail("botToken must be a resolved env-only secret.");
  const botToken = nonEmpty(input.botToken, "botToken", 4_096);
  if (botToken.length < 20 || /\s/u.test(botToken)) fail("botToken must be a resolved 20-4096 character secret.");
  const allowAllChats = boolean(input.allowAllChats, "allowAllChats", false);
  const allowedChatIds = input.allowedChatIds === undefined
    ? []
    : chatIdArray(input.allowedChatIds, "allowedChatIds");
  if (!allowAllChats && allowedChatIds.length === 0) fail("allowedChatIds must contain at least one exact chat id unless allowAllChats is true.");
  const unique = [...new Set(allowedChatIds)];
  if (unique.length !== allowedChatIds.length) fail("allowedChatIds must not contain duplicates.");
  const defaultDestination = input.defaultDestination === undefined
    ? undefined
    : chatId(input.defaultDestination, "defaultDestination");
  if (defaultDestination !== undefined && !allowAllChats && !unique.includes(defaultDestination)) {
    fail("defaultDestination must be one of allowedChatIds.");
  }
  const reactionsInput = input.reactions === undefined ? {} : record(input.reactions, "reactions");
  exact(reactionsInput, ["working", "done", "error"], "reactions");
  const quietHours = parseQuietHours(input.quietHours);
  const transport = parseTransport(input.transport);
  const transcription = parseTranscription(input.transcription);
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
    ...(quietHours === undefined ? {} : { quietHours }),
    ...(transport === undefined ? {} : { transport }),
    ...(transcription === undefined ? {} : { transcription }),
  });
}

const chatIdSchema = envEligibleSchema({
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[^:]+$",
});

export const telegramConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["botToken"],
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
      quietHours: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "timezone"],
        properties: {
          start: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
          end: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
          timezone: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
      transport: {
        type: "object",
        additionalProperties: false,
        properties: {
          ipFamily: { type: "integer", enum: [4, 6] },
        },
      },
      transcription: {
        type: "object",
        additionalProperties: false,
        required: ["endpoint", "model"],
        properties: {
          endpoint: { type: "string", minLength: 1, maxLength: 2_048 },
          model: { type: "string", minLength: 1, maxLength: 256 },
          language: { type: "string", minLength: 1, maxLength: 64 },
          timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS, default: DEFAULT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS },
        },
      },
    },
  }),
  parse: parseTelegramConfig,
});

export function isWithinQuietHours(now: Date, quietHours: TelegramQuietHours): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quietHours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const current = hour * 60 + minute;
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function parseQuietHours(value: unknown): TelegramQuietHours | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "quietHours");
  exact(input, ["start", "end", "timezone"], "quietHours");
  const start = clock(input.start, "quietHours.start");
  const end = clock(input.end, "quietHours.end");
  const timezone = nonEmpty(input.timezone, "quietHours.timezone", 128);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    fail("quietHours.timezone must be a recognized IANA timezone.");
  }
  return Object.freeze({ start, end, timezone });
}

function parseTransport(value: unknown): TelegramTransportConfig | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "transport");
  exact(input, ["ipFamily"], "transport");
  if (input.ipFamily === undefined) return Object.freeze({});
  if (input.ipFamily !== 4 && input.ipFamily !== 6) fail("transport.ipFamily must be 4 or 6.");
  return Object.freeze({ ipFamily: input.ipFamily });
}

function parseTranscription(value: unknown): TelegramTranscriptionConfig | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "transcription");
  exact(input, ["endpoint", "model", "language", "timeoutMs"], "transcription");
  const rawEndpoint = nonEmpty(input.endpoint, "transcription.endpoint", 2_048);
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    fail("transcription.endpoint must be a valid HTTP(S) URL.");
  }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || endpoint.hash.length > 0) {
    fail("transcription.endpoint must be an HTTP(S) URL without credentials or a fragment.");
  }
  const model = identifier(input.model, "transcription.model");
  const language = input.language === undefined ? undefined : identifier(input.language, "transcription.language");
  return Object.freeze({
    endpoint: endpoint.href,
    model,
    ...(language === undefined ? {} : { language }),
    timeoutMs: integer(input.timeoutMs, "transcription.timeoutMs", DEFAULT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS, 1, MAX_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS),
  });
}

function clock(value: unknown, label: string): string {
  const result = nonEmpty(value, label, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(result)) fail(`${label} must use 24-hour HH:MM format.`);
  return result;
}

function clockMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

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

function chatId(value: unknown, label: string): string {
  try {
    return parseTelegramChatId(value, label);
  } catch {
    return fail(`${label} must not contain whitespace, controls, or a colon.`);
  }
}

function chatIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000) fail(`${label} must be an array with at most 1000 entries.`);
  return value.map((item, index) => chatId(item, `${label}[${index}]`));
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

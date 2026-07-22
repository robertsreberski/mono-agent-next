import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
  readRequired,
  readSettingsJson,
  redactedSecret,
} from "@mono-agent/agent-contracts";
import type {
  JsonEnvFieldSpec,
  RedactedSecretValue,
  SettingsJson,
} from "@mono-agent/agent-contracts";

import type { TelegramTranscriptionConfig } from "./transcription.js";

/**
 * A daily window during which proactive notifications (cron/webhook deliveries)
 * are posted silently (`disable_notification`). `start`/`end` are 24-hour `HH:MM`
 * clock times interpreted in `timezone` (an IANA zone); a window where `end` is
 * earlier than `start` wraps midnight (e.g. `22:00`–`07:00`).
 */
export interface TelegramQuietHours {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

/**
 * A custom bot command surfaced in Telegram's command menu (`setMyCommands`).
 * `command` is the bare name (no leading slash) of 1–32 lowercase letters,
 * digits, or underscores. When `prompt` is set, invoking the command runs that
 * prompt as a turn; a command with no `prompt` is a menu-only entry.
 */
export interface TelegramCommandConfig {
  readonly command: string;
  readonly description: string;
  readonly prompt?: string;
}

/**
 * Which lifecycle reactions are enabled. Resolved from `telegram.reactions`:
 * `true` enables all three; an object enables them individually (each key
 * defaults to `true`, so `{ done: false }` keeps 👀/👎 but drops 👍). Resolves to
 * `undefined` when reactions are off entirely.
 */
export interface TelegramReactionsConfig {
  readonly working: boolean;
  readonly done: boolean;
  readonly error: boolean;
}

/** Attachment sizing knobs; names mirror the adapter's DownloadTelegramAttachmentsOptions. */
export interface TelegramAttachmentsConfig {
  /** Inbound download cap (bytes). Omit for the adapter default (20 MiB — the hosted API's hard limit). */
  readonly maxBytes?: number;
  /** Per-file download timeout (ms) on the URL branch. Omit for the adapter default (30s). */
  readonly downloadTimeoutMs?: number;
  /** Upload cap (bytes) for the TelegramSendFile tool. Omit for 20 MiB. */
  readonly maxUploadBytes?: number;
}

/** Optional request-bound restrictions for app-owned Telegram send tools. */
export interface TelegramSendToolsConfig {
  readonly scope?: "producing-conversation";
  readonly pathScope?: "run-output";
}

export interface TelegramAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
  /**
   * Base URL of a self-hosted Bot API server (e.g. `http://127.0.0.1:8081`).
   * Omit for the hosted `https://api.telegram.org`. A `--local` server returns
   * absolute file paths from getFile, which the adapter reads from disk.
   */
  readonly apiRoot?: string;
  /** Attachment sizing (raise the 20 MiB defaults when running a self-hosted server). */
  readonly attachments?: TelegramAttachmentsConfig;
  /** Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`). Omit for dual-stack. */
  readonly ipFamily?: 4 | 6;
  /** Poll-liveness watchdog window (ms). Omit to use the adapter default (120000). */
  readonly pollWatchdogMs?: number;
  /** Window during which proactive notifications are delivered silently. Omit to always notify. */
  readonly quietHours?: TelegramQuietHours;
  /** Custom command-menu entries. Omit (or empty) to leave only the built-in commands. */
  readonly commands?: readonly TelegramCommandConfig[];
  /** Per-state lifecycle reactions (👀/👍/👎). Omit (or all-off) to disable reactions. */
  readonly reactions?: TelegramReactionsConfig;
  /**
   * Optional speech-to-text for inbound audio (voice / audio / video_note): the
   * full URL of an OpenAI-compatible `/v1/audio/transcriptions` route plus a
   * required model. Omit to leave audio as an on-disk file only. Not a secret.
   */
  readonly transcription?: TelegramTranscriptionConfig;
  readonly sendTools?: TelegramSendToolsConfig;
}

export interface RedactedTelegramAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: RedactedSecretValue;
  readonly allowedChatIds: { readonly count: number };
  readonly allowAllChats: boolean;
  readonly apiRoot?: string;
  readonly attachments?: TelegramAttachmentsConfig;
  readonly ipFamily?: 4 | 6;
  readonly pollWatchdogMs?: number;
  readonly quietHours?: TelegramQuietHours;
  readonly commands?: { readonly count: number };
  readonly reactions?: TelegramReactionsConfig;
  readonly transcription?: TelegramTranscriptionConfig;
  readonly sendTools?: TelegramSendToolsConfig;
}

export type TelegramAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface TelegramAdapterConfigErrorDetails {
  readonly code?: TelegramAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class TelegramAdapterConfigError extends Error {
  readonly code: TelegramAdapterConfigErrorCode;
  readonly details: TelegramAdapterConfigErrorDetails;

  constructor(
    code: TelegramAdapterConfigErrorCode,
    message: string,
    details: TelegramAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "TelegramAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadTelegramAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const missingRequiredConfig = (
  message: string,
  details?: Record<string, unknown>,
): TelegramAdapterConfigError =>
  new TelegramAdapterConfigError("missing_required_config", message, details);

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): TelegramAdapterConfigError =>
  new TelegramAdapterConfigError("invalid_config", message, details);

export async function loadTelegramAdapterConfig(
  input: LoadTelegramAdapterConfigInput,
): Promise<TelegramAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerTelegramJsonOntoEnv(json, input.env);
  const enabled = readBoolean(
    env.MONO_AGENT_TELEGRAM_ENABLED,
    "MONO_AGENT_TELEGRAM_ENABLED",
    false,
    invalidConfig,
  );
  const allowedChatIds = readCsv(env.MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS);
  const allowAllChats = readBoolean(
    env.MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS,
    "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS",
    false,
    invalidConfig,
  );

  // A disabled channel never validates its credentials: the status surface reads
  // it as "disabled", not "waiting for config". Only an enabled channel demands
  // its required fields (a missing token then becomes a real "waiting" reason).
  if (!enabled) {
    return {
      enabled: false,
      botToken: "",
      allowedChatIds,
      allowAllChats,
    };
  }

  const botToken = readRequired(
    env.MONO_AGENT_TELEGRAM_BOT_TOKEN,
    "MONO_AGENT_TELEGRAM_BOT_TOKEN",
    missingRequiredConfig,
  );

  if (!allowAllChats && allowedChatIds.length === 0) {
    throw missingRequiredConfig(
      "Telegram adapter requires MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS or MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS=true.",
      { env: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS" },
    );
  }

  const ipFamily = readIpFamily(env.MONO_AGENT_TELEGRAM_IP_FAMILY);
  const pollWatchdogRaw = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS);
  const pollWatchdogMs =
    pollWatchdogRaw === undefined
      ? undefined
      : readInteger(pollWatchdogRaw, "MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS", 0, invalidConfig, {
          min: 0,
          max: 3_600_000,
        });
  const sendTools = readTelegramSendTools(json);
  const quietHours = readTelegramQuietHours(json);
  const commands = readTelegramCommands(json);
  const reactions = readTelegramReactions(json, env);
  const apiRoot = readTelegramApiRoot(env.MONO_AGENT_TELEGRAM_API_ROOT);
  const attachments = readTelegramAttachments(env);
  const transcription = readTelegramTranscription(env);

  return {
    enabled: true,
    botToken,
    allowedChatIds,
    allowAllChats,
    ...(apiRoot === undefined ? {} : { apiRoot }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(ipFamily === undefined ? {} : { ipFamily }),
    ...(pollWatchdogMs === undefined ? {} : { pollWatchdogMs }),
    ...(quietHours === undefined ? {} : { quietHours }),
    ...(commands.length === 0 ? {} : { commands }),
    ...(reactions === undefined ? {} : { reactions }),
    ...(transcription === undefined ? {} : { transcription }),
    ...(sendTools === undefined ? {} : { sendTools }),
  };
}

function readTelegramSendTools(json: SettingsJson): TelegramSendToolsConfig | undefined {
  const raw = readJsonSection(json, "telegram").sendTools;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidConfig("telegram.sendTools must be an object with { scope?, pathScope? }.");
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "scope" && key !== "pathScope");
  if (unknown.length > 0) {
    throw invalidConfig("telegram.sendTools contains unknown fields.", { fields: unknown });
  }
  if (record.scope !== undefined && record.scope !== "producing-conversation") {
    throw invalidConfig('telegram.sendTools.scope must be "producing-conversation" when set.');
  }
  if (record.pathScope !== undefined && record.pathScope !== "run-output") {
    throw invalidConfig('telegram.sendTools.pathScope must be "run-output" when set.');
  }
  if (record.scope === undefined && record.pathScope === undefined) return undefined;
  return {
    ...(record.scope === undefined ? {} : { scope: "producing-conversation" as const }),
    ...(record.pathScope === undefined ? {} : { pathScope: "run-output" as const }),
  };
}

/**
 * Read `telegram.transcription`. Absent endpoint → feature off. When the endpoint
 * is set it must be a valid http(s) URL (validated like {@link readTelegramApiRoot},
 * but the full transcriptions-route path is preserved verbatim — no trailing-slash
 * stripping) and `model` becomes REQUIRED (a hard config error otherwise so a
 * half-configured endpoint fails loudly). `language` is optional.
 */
function readTelegramTranscription(
  env: Record<string, string | undefined>,
): TelegramTranscriptionConfig | undefined {
  const endpoint = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT);
  const model = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL);
  const language = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE);
  const timeoutRaw = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS);
  if (endpoint === undefined) {
    return undefined;
  }
  const timeoutMs =
    timeoutRaw === undefined
      ? undefined
      : readInteger(timeoutRaw, "MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS", 1, invalidConfig, {
          min: 1,
          max: 3_600_000,
        });
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw invalidConfig(
      "MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT (telegram.transcription.endpoint) must be a valid http(s) URL.",
      { env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT" },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidConfig(
      "MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT (telegram.transcription.endpoint) must use http or https.",
      { env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT" },
    );
  }
  if (model === undefined) {
    throw missingRequiredConfig(
      "Telegram transcription requires MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL (telegram.transcription.model) when the endpoint is set.",
      { env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL" },
    );
  }
  return {
    endpoint,
    model,
    ...(language === undefined ? {} : { language }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** Validate + normalize the self-hosted Bot API server base URL (trailing `/` stripped). */
function readTelegramApiRoot(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw);
  if (value === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidConfig("MONO_AGENT_TELEGRAM_API_ROOT (telegram.apiRoot) must be a valid http(s) URL.", {
      env: "MONO_AGENT_TELEGRAM_API_ROOT",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidConfig("MONO_AGENT_TELEGRAM_API_ROOT (telegram.apiRoot) must use http or https.", {
      env: "MONO_AGENT_TELEGRAM_API_ROOT",
    });
  }
  return value.replace(/\/+$/u, "");
}

/** The local Bot API server's hard upload/download limit (2 GiB) bounds both caps. */
const MAX_ATTACHMENT_CONFIG_BYTES = 2_147_483_648;

function readTelegramAttachments(
  env: Record<string, string | undefined>,
): TelegramAttachmentsConfig | undefined {
  const readOptional = (
    raw: string | undefined,
    name: string,
    bounds: { readonly min: number; readonly max: number },
  ): number | undefined => {
    const value = normalizeOptionalString(raw);
    return value === undefined ? undefined : readInteger(value, name, bounds.min, invalidConfig, bounds);
  };
  const maxBytes = readOptional(env.MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES, "MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES", {
    min: 1,
    max: MAX_ATTACHMENT_CONFIG_BYTES,
  });
  const downloadTimeoutMs = readOptional(
    env.MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    "MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
    { min: 0, max: 3_600_000 },
  );
  const maxUploadBytes = readOptional(env.MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES, "MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES", {
    min: 1,
    max: MAX_ATTACHMENT_CONFIG_BYTES,
  });
  if (maxBytes === undefined && downloadTimeoutMs === undefined && maxUploadBytes === undefined) {
    return undefined;
  }
  return {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs }),
    ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
  };
}

/**
 * Resolve `telegram.reactions` into a per-state config. The boolean env override
 * (`MONO_AGENT_TELEGRAM_REACTIONS`) wins and toggles all three at once; otherwise
 * the JSON value is read as either a boolean (all on/off) or an object whose
 * `working`/`done`/`error` keys each default to `true`. All-off resolves to
 * `undefined` (feature off).
 */
function readTelegramReactions(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): TelegramReactionsConfig | undefined {
  const envRaw = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_REACTIONS);
  if (envRaw !== undefined) {
    const on = readBoolean(envRaw, "MONO_AGENT_TELEGRAM_REACTIONS", false, invalidConfig);
    return on ? { working: true, done: true, error: true } : undefined;
  }
  const raw = readJsonSection(json, "telegram").reactions;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return raw ? { working: true, done: true, error: true } : undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidConfig("telegram.reactions must be a boolean or an object of { working?, done?, error? } booleans.");
  }
  const record = raw as Record<string, unknown>;
  const reactions: TelegramReactionsConfig = {
    working: readReactionFlag(record.working, "telegram.reactions.working"),
    done: readReactionFlag(record.done, "telegram.reactions.done"),
    error: readReactionFlag(record.error, "telegram.reactions.error"),
  };
  if (!reactions.working && !reactions.done && !reactions.error) {
    return undefined;
  }
  return reactions;
}

/** Read a reaction flag: absent → on (the object subtracts from the default-on set). */
function readReactionFlag(value: unknown, field: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw invalidConfig(`${field} must be a boolean.`, { field });
  }
  return value;
}

const RESERVED_TELEGRAM_COMMANDS = new Set(["start", "help", "cancel", "new", "model", "effort"]);
const TELEGRAM_COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/u;

/**
 * Read `telegram.commands` straight from the JSON config section. Absent → none;
 * a non-array, a malformed entry, a reserved name, or a duplicate is a hard
 * config error so a typo surfaces loudly instead of silently dropping a command.
 */
function readTelegramCommands(json: SettingsJson): readonly TelegramCommandConfig[] {
  const section = readJsonSection(json, "telegram");
  const raw = section.commands;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw invalidConfig("telegram.commands must be an array of { command, description, prompt? } objects.");
  }
  const commands = raw.map((entry, index) => normalizeCommandConfig(entry, index));
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.command)) {
      throw invalidConfig("telegram.commands entries must have unique command names.", {
        command: command.command,
      });
    }
    seen.add(command.command);
  }
  return commands;
}

function normalizeCommandConfig(entry: unknown, index: number): TelegramCommandConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw invalidConfig("telegram.commands entries must be objects.", { index });
  }
  const record = entry as Record<string, unknown>;
  const rawCommand = record.command;
  if (typeof rawCommand !== "string") {
    throw invalidConfig("telegram.commands entries require a string command name.", { index });
  }
  const name = rawCommand.trim().replace(/^\//u, "").toLowerCase();
  if (!TELEGRAM_COMMAND_PATTERN.test(name)) {
    throw invalidConfig(
      "telegram.commands command must be 1–32 lowercase letters, digits, or underscores.",
      { index, command: name },
    );
  }
  if (RESERVED_TELEGRAM_COMMANDS.has(name)) {
    throw invalidConfig("telegram.commands cannot redefine the built-in start, help, cancel, new, model, or effort commands.", {
      index,
      command: name,
    });
  }
  const description = record.description;
  if (typeof description !== "string" || description.trim().length === 0 || description.length > 256) {
    throw invalidConfig("telegram.commands entries require a non-empty description (max 256 chars).", {
      index,
    });
  }
  const prompt = record.prompt;
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim().length === 0)) {
    throw invalidConfig("telegram.commands prompt must be a non-empty string when set.", { index });
  }
  const config: { command: string; description: string; prompt?: string } = {
    command: name,
    description: description.trim(),
  };
  if (prompt !== undefined) {
    config.prompt = prompt;
  }
  return config;
}

/**
 * Read `telegram.quietHours` straight from the JSON config section (a structured
 * object, so not layered through env). Absent → undefined; a malformed shape is a
 * hard config error so a typo surfaces loudly instead of silently disabling the
 * window.
 */
function readTelegramQuietHours(json: SettingsJson): TelegramQuietHours | undefined {
  const section = readJsonSection(json, "telegram");
  const raw = section.quietHours;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidConfig("telegram.quietHours must be an object with { start, end, timezone }.");
  }
  const record = raw as Record<string, unknown>;
  const start = readClockTime(record.start, "telegram.quietHours.start");
  const end = readClockTime(record.end, "telegram.quietHours.end");
  const timezone = record.timezone;
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    throw invalidConfig("telegram.quietHours.timezone must be a non-empty IANA timezone string.");
  }
  const tz = timezone.trim();
  if (!isValidTimeZone(tz)) {
    throw invalidConfig("telegram.quietHours.timezone is not a recognized IANA timezone.", { reason: tz });
  }
  return { start, end, timezone: tz };
}

/** Validate a 24-hour `HH:MM` clock string, returning it trimmed. */
function readClockTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value.trim())) {
    throw invalidConfig(`${field} must be a 24-hour HH:MM time.`, { field });
  }
  return value.trim();
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `now` falls inside the configured quiet-hours window. Same-day
 * windows (`start < end`) are a simple range; an `end <= start` window wraps
 * midnight. A degenerate `start === end` window is never active (always notify).
 */
export function isWithinQuietHours(now: Date, quietHours: TelegramQuietHours): boolean {
  const nowMinutes = minutesOfDayInZone(now, quietHours.timezone);
  const startMinutes = clockToMinutes(quietHours.start);
  const endMinutes = clockToMinutes(quietHours.end);
  if (startMinutes === endMinutes) {
    return false;
  }
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/** Minutes-since-midnight for `now` rendered in `timeZone` (0–1439). */
function minutesOfDayInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hourRaw = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  // Node's ICU can render midnight as "24" under hour12:false; normalize to 0.
  const hour = hourRaw === 24 ? 0 : hourRaw;
  return hour * 60 + minute;
}

function clockToMinutes(clock: string): number {
  const [hour, minute] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** Parse an optional IPv4/IPv6 transport pin. Empty → undefined; anything but 4/6 throws. */
function readIpFamily(raw: string | undefined): 4 | 6 | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized === "4") {
    return 4;
  }
  if (normalized === "6") {
    return 6;
  }
  throw invalidConfig("MONO_AGENT_TELEGRAM_IP_FAMILY must be 4 or 6.", {
    env: "MONO_AGENT_TELEGRAM_IP_FAMILY",
    reason: normalized,
  });
}

export function redactTelegramAdapterConfig(
  config: TelegramAdapterConfig,
): RedactedTelegramAdapterConfig {
  return {
    enabled: config.enabled,
    botToken: redactedSecret(config.botToken),
    allowedChatIds: { count: config.allowedChatIds.length },
    allowAllChats: config.allowAllChats,
    ...(config.apiRoot === undefined ? {} : { apiRoot: config.apiRoot }),
    ...(config.attachments === undefined ? {} : { attachments: config.attachments }),
    ...(config.ipFamily === undefined ? {} : { ipFamily: config.ipFamily }),
    ...(config.pollWatchdogMs === undefined ? {} : { pollWatchdogMs: config.pollWatchdogMs }),
    ...(config.quietHours === undefined ? {} : { quietHours: config.quietHours }),
    ...(config.commands === undefined ? {} : { commands: { count: config.commands.length } }),
    ...(config.reactions === undefined ? {} : { reactions: config.reactions }),
    // The endpoint/model are not secrets, so they pass through verbatim.
    ...(config.transcription === undefined ? {} : { transcription: config.transcription }),
    ...(config.sendTools === undefined ? {} : { sendTools: config.sendTools }),
  };
}

/**
 * The `telegram` section's field registry: the single source of truth both the
 * JSON→env layering below and the app's config provenance view derive from.
 * Covers every env-mappable field (JSON-only structures like `commands`,
 * `quietHours`, and object-form `reactions` are read straight from JSON).
 */
export const TELEGRAM_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "telegram.enabled", env: "MONO_AGENT_TELEGRAM_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "telegram.botToken", env: "MONO_AGENT_TELEGRAM_BOT_TOKEN", secret: true, fromJson: (s) => s.botToken },
  { id: "telegram.allowedChatIds", env: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS", kind: "csv", fromJson: (s) => s.allowedChatIds },
  { id: "telegram.allowAllChats", env: "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS", kind: "boolean", fromJson: (s) => s.allowAllChats },
  { id: "telegram.transport.ipFamily", env: "MONO_AGENT_TELEGRAM_IP_FAMILY", kind: "integer", fromJson: (s) => readRecord(s.transport).ipFamily },
  { id: "telegram.pollWatchdogMs", env: "MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS", kind: "integer", fromJson: (s) => s.pollWatchdogMs },
  { id: "telegram.apiRoot", env: "MONO_AGENT_TELEGRAM_API_ROOT", fromJson: (s) => s.apiRoot },
  { id: "telegram.attachments.maxBytes", env: "MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES", kind: "integer", fromJson: (s) => readRecord(s.attachments).maxBytes },
  { id: "telegram.attachments.downloadTimeoutMs", env: "MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS", kind: "integer", fromJson: (s) => readRecord(s.attachments).downloadTimeoutMs },
  { id: "telegram.attachments.maxUploadBytes", env: "MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES", kind: "integer", fromJson: (s) => readRecord(s.attachments).maxUploadBytes },
  { id: "telegram.transcription.endpoint", env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT", fromJson: (s) => readRecord(s.transcription).endpoint },
  { id: "telegram.transcription.model", env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL", fromJson: (s) => readRecord(s.transcription).model },
  { id: "telegram.transcription.language", env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE", fromJson: (s) => readRecord(s.transcription).language },
  { id: "telegram.transcription.timeoutMs", env: "MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS", kind: "integer", fromJson: (s) => readRecord(s.transcription).timeoutMs },
];

function layerTelegramJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "telegram"), TELEGRAM_CONFIG_FIELDS));
}

import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readCsv,
  readInteger,
  readJsonSection,
  readRequired,
  readSettingsJson,
} from "@mono-agent/agent-contracts";
import type {
  JsonEnvFieldSpec,
  SettingsJson,
} from "@mono-agent/agent-contracts";

/** A Slack shortcut binding: invoking `callbackId` runs `prompt` as a turn. */
export interface SlackShortcutConfig {
  readonly callbackId: string;
  readonly prompt: string;
  /**
   * Optional destination. When omitted, a message shortcut uses its source
   * channel and is refused if that source is unauthorized. A source-less global
   * shortcut uses the first explicit `allowedChannelIds` entry.
   */
  readonly channelId?: string;
  /** Optional message posted instantly on invocation, before the run (e.g. "🔄 Syncing…"). */
  readonly ackText?: string;
  /** When true, post the result as a threaded reply under the ack. Requires `ackText`. Default off. */
  readonly threadReply?: boolean;
}

/** An App Home tab button: clicking it runs `prompt`; `label` is the button text. */
export interface SlackHomeButtonConfig {
  readonly actionId: string;
  readonly label: string;
  readonly prompt: string;
  /** Destination channel for the reply (the Home tab has none of its own). */
  readonly channelId?: string;
  /** Optional message posted instantly on click, before the run. */
  readonly ackText?: string;
  /** When true, post the result as a threaded reply under the ack. Requires `ackText`. Default off. */
  readonly threadReply?: boolean;
}

/** App Home tab config: whether to publish it, an optional header, and its buttons. */
export interface SlackHomeTabConfig {
  readonly enabled: boolean;
  readonly headerText?: string;
  readonly buttons: readonly SlackHomeButtonConfig[];
}

export interface SlackAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly appToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
  readonly botUserIds: readonly string[];
  readonly mentionTextAliases: readonly string[];
  readonly stripMentionText: boolean;
  /** Shortcut bindings, read from the `slack.shortcuts` JSON array. */
  readonly shortcuts: readonly SlackShortcutConfig[];
  /** App Home tab config, read from the `slack.homeTab` JSON object. */
  readonly homeTab: SlackHomeTabConfig;
  // Optional Socket Mode resilience tuning. Each is undefined unless the operator
  // sets it; the Socket Mode runner then applies its own defaults. See the runner's
  // SlackSocketModeRunnerBackoffOptions / SlackSocketModeRunnerHeartbeatOptions.
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectInitialBackoffMs?: number;
  readonly reconnectMaxBackoffMs?: number;
  readonly reconnectStabilityMs?: number;
  readonly reconnectStartupGraceMs?: number;
  readonly drainDeadlineMs?: number;
}

export type SlackAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface SlackAdapterConfigErrorDetails {
  readonly code?: SlackAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class SlackAdapterConfigError extends Error {
  readonly code: SlackAdapterConfigErrorCode;
  readonly details: SlackAdapterConfigErrorDetails;

  constructor(
    code: SlackAdapterConfigErrorCode,
    message: string,
    details: SlackAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "SlackAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadSlackAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const missingConfig = (
  message: string,
  details?: Record<string, unknown>,
): SlackAdapterConfigError =>
  new SlackAdapterConfigError("missing_required_config", message, details);

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): SlackAdapterConfigError =>
  new SlackAdapterConfigError("invalid_config", message, details);

export async function loadSlackAdapterConfig(
  input: LoadSlackAdapterConfigInput,
): Promise<SlackAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerSlackJsonOntoEnv(json, input.env);
  const enabled = readBoolean(env.MONO_AGENT_SLACK_ENABLED, "MONO_AGENT_SLACK_ENABLED", false, invalidConfig);
  const allowedChannelIds = readCsv(env.MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS);
  const allowAllChannels = readBoolean(
    env.MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS,
    "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS",
    false,
    invalidConfig,
  );
  const botUserIds = readCsv(env.MONO_AGENT_SLACK_BOT_USER_IDS);
  const mentionTextAliases = readCsv(env.MONO_AGENT_SLACK_MENTION_TEXT_ALIASES);
  const stripMentionText = readBoolean(
    env.MONO_AGENT_SLACK_STRIP_MENTION_TEXT,
    "MONO_AGENT_SLACK_STRIP_MENTION_TEXT",
    botUserIds.length > 0 || mentionTextAliases.length > 0,
    invalidConfig,
  );

  // A disabled channel never validates its credentials: the status surface reads
  // it as "disabled", not "waiting for config". Only an enabled channel demands
  // its tokens (a missing token then becomes a real "waiting" reason).
  if (!enabled) {
    return {
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds,
      allowAllChannels,
      botUserIds,
      mentionTextAliases,
      stripMentionText,
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    };
  }

  const botToken = readRequired(env.MONO_AGENT_SLACK_BOT_TOKEN, "MONO_AGENT_SLACK_BOT_TOKEN", missingConfig);
  const appToken = readRequired(env.MONO_AGENT_SLACK_APP_TOKEN, "MONO_AGENT_SLACK_APP_TOKEN", missingConfig);

  if (!allowAllChannels && allowedChannelIds.length === 0) {
    throw missingConfig(
      "Slack adapter requires MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS or MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS=true.",
      { env: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS" },
    );
  }

  // Shortcut bindings and the Home tab are structured config, so they are read
  // straight from the JSON section rather than via env layering.
  const shortcuts = readSlackShortcuts(json);
  const homeTab = readSlackHomeTab(json);

  return {
    enabled: true,
    botToken,
    appToken,
    allowedChannelIds,
    allowAllChannels,
    botUserIds,
    mentionTextAliases,
    stripMentionText,
    shortcuts,
    homeTab,
    ...readSlackSocketTuning(env),
  };
}

/** Field name → env var for the optional integer Socket Mode resilience knobs. */
const SLACK_SOCKET_TUNING_ENV: ReadonlyArray<readonly [keyof SlackSocketTuning, string]> = [
  ["heartbeatIntervalMs", "MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS"],
  ["heartbeatTimeoutMs", "MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS"],
  ["reconnectInitialBackoffMs", "MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS"],
  ["reconnectMaxBackoffMs", "MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS"],
  ["reconnectStabilityMs", "MONO_AGENT_SLACK_RECONNECT_STABILITY_MS"],
  ["reconnectStartupGraceMs", "MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS"],
  ["drainDeadlineMs", "MONO_AGENT_SLACK_DRAIN_DEADLINE_MS"],
];

type SlackSocketTuning = Pick<
  SlackAdapterConfig,
  | "heartbeatIntervalMs"
  | "heartbeatTimeoutMs"
  | "reconnectInitialBackoffMs"
  | "reconnectMaxBackoffMs"
  | "reconnectStabilityMs"
  | "reconnectStartupGraceMs"
  | "drainDeadlineMs"
>;

/**
 * Read the optional integer Socket Mode resilience knobs. Each is omitted (not 0) when
 * unset so the runner falls back to its own default; an invalid value is a hard error.
 */
function readSlackSocketTuning(env: Record<string, string | undefined>): SlackSocketTuning {
  const tuning: { -readonly [K in keyof SlackSocketTuning]?: number } = {};
  for (const [key, name] of SLACK_SOCKET_TUNING_ENV) {
    const raw = normalizeOptionalString(env[name]);
    if (raw === undefined) {
      continue;
    }
    tuning[key] = readInteger(raw, name, 0, invalidConfig, { min: 0, max: 3_600_000 });
  }
  return tuning;
}

/**
 * Read `slack.shortcuts` (shortcut bindings) straight from the JSON config
 * section. Absent → none; a non-array or a malformed entry is a hard config
 * error so a typo surfaces loudly instead of silently dropping a shortcut.
 */
function readSlackShortcuts(json: SettingsJson): readonly SlackShortcutConfig[] {
  const section = readJsonSection(json, "slack");
  const raw = section.shortcuts;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw invalidConfig("slack.shortcuts must be an array of { callbackId, prompt } objects.");
  }
  const shortcuts = raw.map((entry, index) => normalizeShortcutConfig(entry, index));
  assertUniqueIds(shortcuts.map((shortcut) => shortcut.callbackId), "slack.shortcuts callbackId");
  return shortcuts;
}

function normalizeShortcutConfig(entry: unknown, index: number): SlackShortcutConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw invalidConfig("slack.shortcuts entries must be objects.", { index });
  }
  const record = entry as Record<string, unknown>;
  const callbackId = record.callbackId;
  const prompt = record.prompt;
  const channelId = record.channelId;
  const ackText = record.ackText;
  const threadReply = record.threadReply;
  if (typeof callbackId !== "string" || callbackId.trim().length === 0) {
    throw invalidConfig("slack.shortcuts entries require a non-empty callbackId.", { index });
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw invalidConfig("slack.shortcuts entries require a non-empty prompt.", { index });
  }
  if (channelId !== undefined && (typeof channelId !== "string" || channelId.trim().length === 0)) {
    throw invalidConfig("slack.shortcuts channelId must be a non-empty string when set.", { index });
  }
  if (ackText !== undefined && (typeof ackText !== "string" || ackText.trim().length === 0)) {
    throw invalidConfig("slack.shortcuts ackText must be a non-empty string when set.", { index });
  }
  if (threadReply !== undefined && typeof threadReply !== "boolean") {
    throw invalidConfig("slack.shortcuts threadReply must be a boolean when set.", { index });
  }
  if (threadReply === true && ackText === undefined) {
    throw invalidConfig("slack.shortcuts threadReply requires ackText — the result threads under the ack message.", { index });
  }
  const config: { callbackId: string; prompt: string; channelId?: string; ackText?: string; threadReply?: boolean } = {
    callbackId,
    prompt,
  };
  if (channelId !== undefined) {
    config.channelId = channelId;
  }
  if (ackText !== undefined) {
    config.ackText = ackText;
  }
  if (threadReply !== undefined) {
    config.threadReply = threadReply;
  }
  return config;
}

/**
 * Read `slack.homeTab` (App Home tab config) from the JSON section. Absent →
 * disabled with no buttons; a malformed shape or button is a hard config error.
 */
function readSlackHomeTab(json: SettingsJson): SlackHomeTabConfig {
  const section = readJsonSection(json, "slack");
  const raw = section.homeTab;
  if (raw === undefined) {
    return { enabled: false, buttons: [] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidConfig("slack.homeTab must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const headerText = record.headerText;
  if (headerText !== undefined && (typeof headerText !== "string" || headerText.trim().length === 0)) {
    throw invalidConfig("slack.homeTab.headerText must be a non-empty string when set.");
  }
  const rawButtons = record.buttons;
  if (rawButtons !== undefined && !Array.isArray(rawButtons)) {
    throw invalidConfig("slack.homeTab.buttons must be an array of button objects.");
  }
  const buttons = (rawButtons ?? []).map((entry, index) => normalizeHomeButtonConfig(entry, index));
  assertUniqueIds(buttons.map((button) => button.actionId), "slack.homeTab.buttons actionId");
  // An enabled Home tab with neither buttons nor a header would publish an empty
  // view, which Slack's views.publish rejects (1–100 blocks) on every open.
  if (enabled && buttons.length === 0 && headerText === undefined) {
    throw invalidConfig("slack.homeTab is enabled but has no buttons and no headerText to render.");
  }
  const config: { enabled: boolean; headerText?: string; buttons: readonly SlackHomeButtonConfig[] } = {
    enabled,
    buttons,
  };
  if (headerText !== undefined) {
    config.headerText = headerText;
  }
  return config;
}

/** Reject duplicate ids (case-insensitive) so a copy-paste typo surfaces loudly at load. */
function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.trim().toLowerCase();
    if (seen.has(key)) {
      throw invalidConfig(`${label} must be unique; "${id}" is declared more than once.`);
    }
    seen.add(key);
  }
}

function normalizeHomeButtonConfig(entry: unknown, index: number): SlackHomeButtonConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw invalidConfig("slack.homeTab.buttons entries must be objects.", { index });
  }
  const record = entry as Record<string, unknown>;
  const actionId = record.actionId;
  const label = record.label;
  const prompt = record.prompt;
  const channelId = record.channelId;
  const ackText = record.ackText;
  const threadReply = record.threadReply;
  if (typeof actionId !== "string" || actionId.trim().length === 0) {
    throw invalidConfig("slack.homeTab.buttons entries require a non-empty actionId.", { index });
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    throw invalidConfig("slack.homeTab.buttons entries require a non-empty label.", { index });
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw invalidConfig("slack.homeTab.buttons entries require a non-empty prompt.", { index });
  }
  if (channelId !== undefined && (typeof channelId !== "string" || channelId.trim().length === 0)) {
    throw invalidConfig("slack.homeTab.buttons channelId must be a non-empty string when set.", { index });
  }
  if (ackText !== undefined && (typeof ackText !== "string" || ackText.trim().length === 0)) {
    throw invalidConfig("slack.homeTab.buttons ackText must be a non-empty string when set.", { index });
  }
  if (threadReply !== undefined && typeof threadReply !== "boolean") {
    throw invalidConfig("slack.homeTab.buttons threadReply must be a boolean when set.", { index });
  }
  if (threadReply === true && ackText === undefined) {
    throw invalidConfig("slack.homeTab.buttons threadReply requires ackText — the result threads under the ack message.", { index });
  }
  const config: {
    actionId: string;
    label: string;
    prompt: string;
    channelId?: string;
    ackText?: string;
    threadReply?: boolean;
  } = {
    actionId,
    label,
    prompt,
  };
  if (channelId !== undefined) {
    config.channelId = channelId;
  }
  if (ackText !== undefined) {
    config.ackText = ackText;
  }
  if (threadReply !== undefined) {
    config.threadReply = threadReply;
  }
  return config;
}

/**
 * The `slack` section's field registry: the single source of truth both the
 * JSON→env layering below and the app's config provenance view derive from.
 * Covers every env-mappable field (JSON-only structures like `shortcuts` and
 * `homeTab` are read straight from JSON).
 */
export const SLACK_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "slack.enabled", env: "MONO_AGENT_SLACK_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "slack.botToken", env: "MONO_AGENT_SLACK_BOT_TOKEN", secret: true, fromJson: (s) => s.botToken },
  { id: "slack.appToken", env: "MONO_AGENT_SLACK_APP_TOKEN", secret: true, fromJson: (s) => s.appToken },
  { id: "slack.allowedChannelIds", env: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS", kind: "csv", fromJson: (s) => s.allowedChannelIds },
  { id: "slack.allowAllChannels", env: "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS", kind: "boolean", fromJson: (s) => s.allowAllChannels },
  { id: "slack.botUserIds", env: "MONO_AGENT_SLACK_BOT_USER_IDS", kind: "csv", fromJson: (s) => s.botUserIds },
  { id: "slack.mentionTextAliases", env: "MONO_AGENT_SLACK_MENTION_TEXT_ALIASES", kind: "csv", fromJson: (s) => s.mentionTextAliases },
  { id: "slack.stripMentionText", env: "MONO_AGENT_SLACK_STRIP_MENTION_TEXT", kind: "boolean", fromJson: (s) => s.stripMentionText },
  { id: "slack.heartbeatIntervalMs", env: "MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS", kind: "integer", fromJson: (s) => s.heartbeatIntervalMs },
  { id: "slack.heartbeatTimeoutMs", env: "MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS", kind: "integer", fromJson: (s) => s.heartbeatTimeoutMs },
  { id: "slack.reconnectInitialBackoffMs", env: "MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS", kind: "integer", fromJson: (s) => s.reconnectInitialBackoffMs },
  { id: "slack.reconnectMaxBackoffMs", env: "MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS", kind: "integer", fromJson: (s) => s.reconnectMaxBackoffMs },
  { id: "slack.reconnectStabilityMs", env: "MONO_AGENT_SLACK_RECONNECT_STABILITY_MS", kind: "integer", fromJson: (s) => s.reconnectStabilityMs },
  { id: "slack.reconnectStartupGraceMs", env: "MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS", kind: "integer", fromJson: (s) => s.reconnectStartupGraceMs },
  { id: "slack.drainDeadlineMs", env: "MONO_AGENT_SLACK_DRAIN_DEADLINE_MS", kind: "integer", fromJson: (s) => s.drainDeadlineMs },
];

function layerSlackJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "slack"), SLACK_CONFIG_FIELDS));
}

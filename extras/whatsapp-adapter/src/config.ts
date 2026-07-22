import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  readBoolean,
  readChoice,
  readCsv,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec, SettingsJson } from "@mono-agent/agent-contracts";

import type { WhatsAppGroupTriggerMode } from "./adapter.js";
import type { WhatsAppJid } from "./types.js";

const WHATSAPP_GROUP_MODES = ["mention", "any"] as const satisfies readonly WhatsAppGroupTriggerMode[];

export interface WhatsAppAdapterTriggerConfig {
  readonly groupMode: WhatsAppGroupTriggerMode;
  readonly botJids: readonly WhatsAppJid[];
  readonly mentionTextAliases: readonly string[];
  readonly stripMentionText: boolean;
}

export interface WhatsAppAdapterConfig {
  readonly enabled: boolean;
  readonly allowedChatJids: readonly WhatsAppJid[];
  readonly allowAllChats: boolean;
  readonly trigger: WhatsAppAdapterTriggerConfig;
}

export interface RedactedWhatsAppAdapterConfig {
  readonly enabled: boolean;
  readonly allowedChatJids: { readonly count: number };
  readonly allowAllChats: boolean;
  readonly trigger: {
    readonly groupMode: WhatsAppGroupTriggerMode;
    readonly botJids: { readonly count: number };
    readonly mentionTextAliases: { readonly count: number };
    readonly stripMentionText: boolean;
  };
}

export type WhatsAppAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface WhatsAppAdapterConfigErrorDetails {
  readonly code?: WhatsAppAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class WhatsAppAdapterConfigError extends Error {
  readonly code: WhatsAppAdapterConfigErrorCode;
  readonly details: WhatsAppAdapterConfigErrorDetails;

  constructor(
    code: WhatsAppAdapterConfigErrorCode,
    message: string,
    details: WhatsAppAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "WhatsAppAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadWhatsAppAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): WhatsAppAdapterConfigError =>
  new WhatsAppAdapterConfigError("invalid_config", message, details);

const missingRequiredConfig = (
  message: string,
  details?: Record<string, unknown>,
): WhatsAppAdapterConfigError =>
  new WhatsAppAdapterConfigError("missing_required_config", message, details);

export async function loadWhatsAppAdapterConfig(
  input: LoadWhatsAppAdapterConfigInput,
): Promise<WhatsAppAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerWhatsAppJsonOntoEnv(json, input.env);
  const enabled = readBoolean(
    env.MONO_AGENT_WHATSAPP_ENABLED,
    "MONO_AGENT_WHATSAPP_ENABLED",
    false,
    invalidConfig,
  );
  const allowedChatJids = readCsv(env.MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS);
  const allowAllChats = readBoolean(
    env.MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS,
    "MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS",
    false,
    invalidConfig,
  );
  const groupMode = readChoice(
    env.MONO_AGENT_WHATSAPP_GROUP_MODE,
    "MONO_AGENT_WHATSAPP_GROUP_MODE",
    WHATSAPP_GROUP_MODES,
    "mention",
    invalidConfig,
  );
  const botJids = readCsv(env.MONO_AGENT_WHATSAPP_BOT_JIDS);
  const mentionTextAliases = readCsv(env.MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES);
  const stripMentionText = readBoolean(
    env.MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT,
    "MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT",
    mentionTextAliases.length > 0,
    invalidConfig,
  );

  const trigger: WhatsAppAdapterTriggerConfig = {
    groupMode,
    botJids,
    mentionTextAliases,
    stripMentionText,
  };

  // A disabled channel never validates its allowlist: the status surface reads
  // it as "disabled", not "waiting for config". Only an enabled channel demands
  // an allowlist (a missing one then becomes a real "waiting" reason).
  if (!enabled) {
    return { enabled: false, allowedChatJids, allowAllChats, trigger };
  }

  if (!allowAllChats && allowedChatJids.length === 0) {
    throw missingRequiredConfig(
      "WhatsApp adapter requires MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS or MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS=true.",
      { env: "MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS" },
    );
  }

  return { enabled: true, allowedChatJids, allowAllChats, trigger };
}

export function redactWhatsAppAdapterConfig(
  config: WhatsAppAdapterConfig,
): RedactedWhatsAppAdapterConfig {
  return {
    enabled: config.enabled,
    allowedChatJids: { count: config.allowedChatJids.length },
    allowAllChats: config.allowAllChats,
    trigger: {
      groupMode: config.trigger.groupMode,
      botJids: { count: config.trigger.botJids.length },
      mentionTextAliases: { count: config.trigger.mentionTextAliases.length },
      stripMentionText: config.trigger.stripMentionText,
    },
  };
}

/**
 * The `whatsapp` section's field registry: the single source of truth both the
 * JSON→env layering below and the app's config provenance view derive from.
 */
export const WHATSAPP_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "whatsapp.enabled", env: "MONO_AGENT_WHATSAPP_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "whatsapp.allowedChatJids", env: "MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS", kind: "csv", fromJson: (s) => s.allowedChatJids },
  { id: "whatsapp.allowAllChats", env: "MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS", kind: "boolean", fromJson: (s) => s.allowAllChats },
  { id: "whatsapp.groupMode", env: "MONO_AGENT_WHATSAPP_GROUP_MODE", fromJson: (s) => s.groupMode },
  { id: "whatsapp.botJids", env: "MONO_AGENT_WHATSAPP_BOT_JIDS", kind: "csv", fromJson: (s) => s.botJids },
  { id: "whatsapp.mentionTextAliases", env: "MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES", kind: "csv", fromJson: (s) => s.mentionTextAliases },
  { id: "whatsapp.stripMentionText", env: "MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT", kind: "boolean", fromJson: (s) => s.stripMentionText },
];

function layerWhatsAppJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "whatsapp"), WHATSAPP_CONFIG_FIELDS));
}

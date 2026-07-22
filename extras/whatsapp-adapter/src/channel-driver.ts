import { resolve } from "node:path";

import type {
  ChannelConfigInput,
  ChannelConfigViewField,
  ChannelConfigViewSection,
  ChannelDriver,
  JsonEnvFieldSpec,
  SettingsJson,
  SettingsJsonValue,
} from "@mono-agent/agent-contracts";
import {
  encodeJsonEnvValue,
  normalizeOptionalString,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/agent-contracts";

import {
  loadWhatsAppAdapterConfig,
  WhatsAppAdapterConfigError,
  WHATSAPP_CONFIG_FIELDS,
  type WhatsAppAdapterConfig,
} from "./config.js";
import {
  startWhatsAppAdapter,
  type StartWhatsAppAdapterOptions,
  type WhatsAppAdapterStartResult,
  type WhatsAppSocketFactory,
} from "./start.js";

export type WhatsAppChannelDriverConfig = {
  readonly [key: string]: SettingsJsonValue;
};

export interface WhatsAppChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: WhatsAppChannelDriverConfig;
  readonly authDir?: string;
  readonly socketFactory?: WhatsAppSocketFactory;
  readonly startAdapter?: (
    options: StartWhatsAppAdapterOptions,
  ) => Promise<WhatsAppAdapterStartResult>;
}

const BOOLEAN_RAW_CONFIG_FIELDS = ["enabled", "allowAllChats", "stripMentionText"] as const;
const STRING_RAW_CONFIG_FIELDS = ["groupMode"] as const;
const STRING_ARRAY_RAW_CONFIG_FIELDS = ["allowedChatJids", "botJids", "mentionTextAliases"] as const;
const DEFAULT_CHANNEL_ID = "whatsapp";
const DEFAULT_CHANNEL_LABEL = "WhatsApp";
const DISABLED_REASON = "WhatsApp is disabled.";
const CONFIG_VIEW_PLACEHOLDER = "\u2014";

export function createWhatsAppChannelDriver(
  options: WhatsAppChannelDriverOptions = {},
): ChannelDriver<WhatsAppAdapterConfig> {
  const id = options.id ?? DEFAULT_CHANNEL_ID;
  const label = options.label ?? DEFAULT_CHANNEL_LABEL;
  return {
    id,
    label,
    async configView(input) {
      const section = await readWhatsAppConfigViewSection(options, input);
      let status: ChannelConfigViewSection["status"] = "active";
      try {
        const config = await loadWhatsAppChannelConfig(options, input);
        if (!config.enabled) {
          status = "disabled";
        }
      } catch (error) {
        if (!isWhatsAppConfigError(error)) {
          throw error;
        }
      }
      return {
        id,
        label,
        status,
        fields: WHATSAPP_CONFIG_FIELDS.map((field) => toChannelConfigViewField(field, section, input.env)),
      };
    },
    async loadConfig(input) {
      return await loadWhatsAppChannelConfig(options, input);
    },
    isConfigError(error) {
      return isWhatsAppConfigError(error);
    },
    disabledReason(config) {
      return config.enabled ? undefined : DISABLED_REASON;
    },
    async start(input) {
      const startAdapter = options.startAdapter ?? startWhatsAppAdapter;
      const result = await startAdapter({
        authDir: options.authDir ?? resolve(input.cwd, ".mono-agent", "whatsapp-auth"),
        config: input.config,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        onQr: (qr) => {
          input.logger?.info?.("WhatsApp login QR code received; scan it with the WhatsApp app.", { qr });
        },
        ...(options.socketFactory === undefined ? {} : { createSocket: options.socketFactory }),
      });
      return {
        summary: {},
        stop: () => result.stop(),
      };
    },
  };
}

export const createChannelDriver = createWhatsAppChannelDriver;

async function loadWhatsAppChannelConfig(
  options: WhatsAppChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<WhatsAppAdapterConfig> {
  if (options.config !== undefined) {
    validateWhatsAppChannelDriverConfig(options.config);
    return await loadWhatsAppAdapterConfig({
      env: input.env,
      json: { whatsapp: options.config } satisfies SettingsJson,
    });
  }
  return await loadWhatsAppAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
}

async function readWhatsAppConfigViewSection(
  options: WhatsAppChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<Record<string, unknown>> {
  if (options.config !== undefined) {
    return options.config as Record<string, unknown>;
  }
  const { json } = await readSettingsJson(input.configPath);
  return readJsonSection(json, DEFAULT_CHANNEL_ID);
}

function isWhatsAppConfigError(error: unknown): boolean {
  return error instanceof WhatsAppAdapterConfigError;
}

function toChannelConfigViewField(
  field: JsonEnvFieldSpec,
  section: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ChannelConfigViewField {
  const envValue = normalizeOptionalString(env[field.env]);
  const jsonValue = encodeJsonEnvValue(field.fromJson(section), field.kind ?? "string");
  const resolved = envValue ?? jsonValue;
  const source = envValue !== undefined ? "env" : jsonValue !== undefined ? "json" : "default";
  return {
    id: field.id,
    label: labelForFieldId(field.id),
    value: field.secret === true ? (resolved === undefined ? "unset" : "set") : resolved ?? CONFIG_VIEW_PLACEHOLDER,
    source,
    ...(field.secret === true ? { redacted: true } : {}),
    envKey: field.env,
  };
}

function labelForFieldId(id: string): string {
  const words = id
    .split(".")
    .slice(1)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function validateWhatsAppChannelDriverConfig(config: WhatsAppChannelDriverConfig): void {
  for (const key of BOOLEAN_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, `whatsapp.${key}`, isBooleanValue, "a boolean");
  }
  for (const key of STRING_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, `whatsapp.${key}`, isStringValue, "a string");
  }
  for (const key of STRING_ARRAY_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, `whatsapp.${key}`, isStringArrayValue, "an array of strings");
  }
}

function validateRawField(
  config: WhatsAppChannelDriverConfig,
  key: string,
  field: string,
  isValid: (value: SettingsJsonValue | undefined) => boolean,
  expected: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(config, key)) {
    return;
  }
  const value = config[key];
  if (isValid(value)) {
    return;
  }
  throw new WhatsAppAdapterConfigError(
    "invalid_config",
    `${field} must be ${expected}.`,
    { field, expected, reason: describeRawValue(value) },
  );
}

function isBooleanValue(value: SettingsJsonValue | undefined): boolean {
  return typeof value === "boolean";
}

function isStringValue(value: SettingsJsonValue | undefined): boolean {
  return typeof value === "string";
}

function isStringArrayValue(value: SettingsJsonValue | undefined): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function describeRawValue(value: SettingsJsonValue | undefined): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

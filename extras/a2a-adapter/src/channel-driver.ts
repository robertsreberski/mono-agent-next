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
  A2A_CONFIG_FIELDS,
  type A2AAdapterConfig,
  loadA2AAdapterConfig,
} from "./config.js";
import {
  A2AConsumerError,
  A2AProviderError,
} from "./errors.js";
import {
  type A2AProviderOptions,
  type A2AProviderStartResult,
  startA2AProvider,
} from "./provider.js";
import { defaultA2AIdempotencyStateDir } from "./idempotency.js";

export type A2AAdapterRawConfig = Readonly<Record<string, SettingsJsonValue>>;

export interface A2AChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: A2AAdapterRawConfig;
  readonly providerFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
}

const DEFAULT_CHANNEL_ID = "a2a";
const DEFAULT_CHANNEL_LABEL = "A2A";
const DISABLED_REASON = "A2A provider is disabled.";
const MISSING_AGENT_SKILL_REASON = "A2A provider requires agent and skill configuration.";
const CONFIG_VIEW_PLACEHOLDER = "—";

function resolveA2AStateDir(cwd: string, configured: string): string {
  return resolve(cwd, configured);
}

export function createA2AChannelDriver(
  options: A2AChannelDriverOptions = {},
): ChannelDriver<A2AAdapterConfig> {
  const id = options.id ?? DEFAULT_CHANNEL_ID;
  const label = options.label ?? DEFAULT_CHANNEL_LABEL;
  return {
    id,
    label,
    async configView(input) {
      const view = await readA2AConfigViewSection(options, input);
      let status: ChannelConfigViewSection["status"] = "active";
      try {
        const config = await loadA2AChannelConfig(options, input);
        if (!config.provider.enabled) {
          status = "disabled";
        }
      } catch (error) {
        if (!isA2AConfigError(error)) {
          throw error;
        }
      }
      return {
        id,
        label,
        status,
        fields: A2A_CONFIG_FIELDS.map((field) => toChannelConfigViewField(
          field,
          view.section,
          input.env,
          view.publicAgentName,
        )),
      };
    },
    async loadConfig(input) {
      return await loadA2AChannelConfig(options, input);
    },
    isConfigError(error) {
      return isA2AConfigError(error);
    },
    disabledReason(config) {
      return config.provider.enabled ? undefined : DISABLED_REASON;
    },
    waitingReason(config) {
      if (!config.provider.enabled) {
        return undefined;
      }
      if (config.agent === undefined || config.skill === undefined) {
        return MISSING_AGENT_SKILL_REASON;
      }
      return undefined;
    },
    async start(input) {
      const config = input.config;
      if (config.agent === undefined || config.skill === undefined) {
        throw new A2AProviderError("missing_required_config", MISSING_AGENT_SKILL_REASON);
      }
      const providerFactory = options.providerFactory ?? startA2AProvider;
      const idempotency = config.provider.idempotency;
      const provider = await providerFactory({
        host: config.provider.host,
        port: config.provider.port,
        ...(config.provider.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.provider.publicBaseUrl }),
        allowNonLoopback: config.provider.allowNonLoopback,
        requireBearer: config.provider.requireBearer,
        ...(config.provider.bearerToken === undefined ? {} : { bearerToken: config.provider.bearerToken }),
        ...(config.provider.maxRequestBytes === undefined
          ? {}
          : { maxRequestBytes: config.provider.maxRequestBytes }),
        ...(idempotency === undefined
          ? {}
          : {
              idempotency: {
                stateDir: idempotency.stateDir === undefined
                  ? defaultA2AIdempotencyStateDir(input.cwd, idempotency.namespace)
                  : resolveA2AStateDir(input.cwd, idempotency.stateDir),
                namespace: idempotency.namespace,
                retentionMs: idempotency.retentionMs,
                maxRecords: idempotency.maxRecords,
              },
            }),
        responder: input.responder,
        agent: {
          name: config.agent.name,
          description: config.agent.description,
          version: config.agent.version,
          ...(config.agent.providerOrganization === undefined || config.agent.providerUrl === undefined
            ? {}
            : {
                provider: {
                  organization: config.agent.providerOrganization,
                  url: config.agent.providerUrl,
                },
              }),
        },
        skill: config.skill,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { agentCardUrl: provider.agentCardUrl },
        stop: () => provider.stop(),
      };
    },
  };
}

export const createChannelDriver: typeof createA2AChannelDriver = createA2AChannelDriver;

type RawConfigSection = Readonly<Record<string, SettingsJsonValue>>;

async function loadA2AChannelConfig(
  options: A2AChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<A2AAdapterConfig> {
  if (options.config !== undefined) {
    validateA2AAdapterRawConfig(options.config);
    return await loadA2AAdapterConfig({
      env: input.env,
      // A config-loaded plugin receives only channels.plugins[].config in its
      // factory options. Rehydrate the public root agent identity from the
      // actual config file so the A2A Agent Card inherits agent.name unless an
      // A2A-specific name (or environment override) was provided.
      json: await pluginScopedA2ASettings(options.config, input.configPath),
    });
  }
  return await loadA2AAdapterConfig({ env: input.env, jsonPath: input.configPath });
}

async function readA2AConfigViewSection(
  options: A2AChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<{ readonly section: Record<string, unknown>; readonly publicAgentName?: string }> {
  if (options.config !== undefined) {
    const settings = await pluginScopedA2ASettings(options.config, input.configPath);
    const publicName = publicAgentNameFromSettings(settings);
    return {
      section: readJsonSection(settings, DEFAULT_CHANNEL_ID),
      ...(publicName === undefined ? {} : { publicAgentName: publicName }),
    };
  }
  const { json } = await readSettingsJson(input.configPath);
  const publicName = publicAgentNameFromSettings(json);
  return {
    section: readJsonSection(json, DEFAULT_CHANNEL_ID),
    ...(publicName === undefined ? {} : { publicAgentName: publicName }),
  };
}

async function pluginScopedA2ASettings(
  config: A2AAdapterRawConfig,
  configPath: string,
): Promise<SettingsJson> {
  let publicAgentName: string | undefined;
  try {
    const { json } = await readSettingsJson(configPath);
    publicAgentName = publicAgentNameFromSettings(json);
  } catch {
    // Programmatic consumers may supply plugin config without a backing file.
  }
  return {
    ...(publicAgentName === undefined ? {} : { agent: { name: publicAgentName } }),
    a2a: config,
  } satisfies SettingsJson;
}

function publicAgentNameFromSettings(settings: SettingsJson): string | undefined {
  const agent = isSettingsRecord(settings.agent) ? settings.agent : {};
  return normalizeSettingsString(agent.name);
}

function normalizeSettingsString(value: SettingsJsonValue | undefined): string | undefined {
  return normalizeOptionalString(typeof value === "string" ? value : undefined);
}

function isSettingsRecord(value: unknown): value is Record<string, SettingsJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isA2AConfigError(error: unknown): boolean {
  return error instanceof A2AProviderError || error instanceof A2AConsumerError;
}

function toChannelConfigViewField(
  field: JsonEnvFieldSpec,
  section: Record<string, unknown>,
  env: Record<string, string | undefined>,
  publicJsonAgentName?: string,
): ChannelConfigViewField {
  const inheritedPublicName = field.id === "a2a.agent.name"
    ? normalizeOptionalString(env.MONO_AGENT_NAME)
    : undefined;
  const explicitEnvValue = normalizeOptionalString(env[field.env]);
  const jsonValue = encodeJsonEnvValue(field.fromJson(section), field.kind ?? "string");
  const inheritedEnvSelected = field.id === "a2a.agent.name"
    && explicitEnvValue === undefined
    && jsonValue === undefined
    && inheritedPublicName !== undefined;
  const inheritedJsonSelected = field.id === "a2a.agent.name"
    && explicitEnvValue === undefined
    && jsonValue === undefined
    && inheritedPublicName === undefined
    && publicJsonAgentName !== undefined;
  const resolved = explicitEnvValue
    ?? jsonValue
    ?? inheritedPublicName
    ?? (field.id === "a2a.agent.name" ? publicJsonAgentName : undefined);
  const source = explicitEnvValue !== undefined || inheritedEnvSelected
    ? "env"
    : jsonValue !== undefined || inheritedJsonSelected
      ? "json"
      : "default";
  const envKey = inheritedEnvSelected || inheritedJsonSelected ? "MONO_AGENT_NAME" : field.env;
  return {
    id: field.id,
    label: labelForFieldId(field.id),
    value: field.secret === true ? (resolved === undefined ? "unset" : "set") : resolved ?? CONFIG_VIEW_PLACEHOLDER,
    source,
    ...(field.secret === true ? { redacted: true } : {}),
    envKey,
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

function validateA2AAdapterRawConfig(config: A2AAdapterRawConfig): void {
  validateRawBoolean(config, "enabled", "a2a.enabled");

  const provider = readOptionalRawSection(config, "provider", "a2a.provider");
  if (provider !== undefined) {
    validateRawBoolean(provider, "enabled", "a2a.provider.enabled");
    validateRawString(provider, "host", "a2a.provider.host");
    validateRawInteger(provider, "port", "a2a.provider.port");
    validateRawString(provider, "publicBaseUrl", "a2a.provider.publicBaseUrl");
    validateRawBoolean(provider, "allowNonLoopback", "a2a.provider.allowNonLoopback");
    validateRawBoolean(provider, "requireBearer", "a2a.provider.requireBearer");
    validateRawString(provider, "bearerToken", "a2a.provider.bearerToken");
    validateRawInteger(provider, "maxRequestBytes", "a2a.provider.maxRequestBytes");
    const idempotency = readOptionalRawSection(provider, "idempotency", "a2a.provider.idempotency");
    if (idempotency !== undefined) {
      validateRawString(idempotency, "stateDir", "a2a.provider.idempotency.stateDir");
      validateRawString(idempotency, "namespace", "a2a.provider.idempotency.namespace");
      validateRawInteger(idempotency, "retentionMs", "a2a.provider.idempotency.retentionMs");
      validateRawInteger(idempotency, "maxRecords", "a2a.provider.idempotency.maxRecords");
    }
  }

  const agent = readOptionalRawSection(config, "agent", "a2a.agent");
  if (agent !== undefined) {
    validateRawString(agent, "name", "a2a.agent.name");
    validateRawString(agent, "description", "a2a.agent.description");
    validateRawString(agent, "version", "a2a.agent.version");
    validateRawString(agent, "providerOrganization", "a2a.agent.providerOrganization");
    validateRawString(agent, "providerUrl", "a2a.agent.providerUrl");
  }

  const skill = readOptionalRawSection(config, "skill", "a2a.skill");
  if (skill !== undefined) {
    validateRawString(skill, "id", "a2a.skill.id");
    validateRawString(skill, "name", "a2a.skill.name");
    validateRawString(skill, "description", "a2a.skill.description");
    validateRawCsv(skill, "tags", "a2a.skill.tags");
  }

  const consumer = readOptionalRawSection(config, "consumer", "a2a.consumer");
  if (consumer !== undefined) {
    validateRawCsv(consumer, "remoteAgentUrls", "a2a.consumer.remoteAgentUrls");
    validateRawString(consumer, "defaultRemoteAgentUrl", "a2a.consumer.defaultRemoteAgentUrl");
    validateRawString(consumer, "bearerToken", "a2a.consumer.bearerToken");
    validateRawInteger(consumer, "timeoutMs", "a2a.consumer.timeoutMs");
  }
}

function readOptionalRawSection(
  section: RawConfigSection,
  key: string,
  path: string,
): RawConfigSection | undefined {
  if (!hasRawField(section, key)) {
    return undefined;
  }
  const value = section[key];
  if (isRawConfigSection(value)) {
    return value;
  }
  throw invalidRawConfig(path, "an object", value);
}

function validateRawString(
  section: RawConfigSection,
  key: string,
  path: string,
): void {
  if (!hasRawField(section, key)) {
    return;
  }
  const value = section[key];
  if (typeof value !== "string") {
    throw invalidRawConfig(path, "a string", value);
  }
}

function validateRawBoolean(
  section: RawConfigSection,
  key: string,
  path: string,
): void {
  if (!hasRawField(section, key)) {
    return;
  }
  const value = section[key];
  if (typeof value !== "boolean") {
    throw invalidRawConfig(path, "a boolean", value);
  }
}

function validateRawInteger(
  section: RawConfigSection,
  key: string,
  path: string,
): void {
  if (!hasRawField(section, key)) {
    return;
  }
  const value = section[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidRawConfig(path, "an integer", value);
  }
}

function validateRawCsv(
  section: RawConfigSection,
  key: string,
  path: string,
): void {
  if (!hasRawField(section, key)) {
    return;
  }
  const value = section[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidRawConfig(path, "an array of strings", value);
  }
}

function hasRawField(
  section: RawConfigSection,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(section, key);
}

function isRawConfigSection(
  value: SettingsJsonValue | undefined,
): value is RawConfigSection {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRawConfig(
  path: string,
  expected: string,
  value: SettingsJsonValue | undefined,
): A2AProviderError {
  return new A2AProviderError(
    "invalid_config",
    `${path} must be ${expected}.`,
    {
      path,
      expected,
      actual: describeRawValue(value),
    },
  );
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

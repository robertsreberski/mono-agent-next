import {
  fieldSpecMappings,
  isLoopbackHost,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
  readRequired,
  readSettingsJson,
  readString,
  redactedSecret,
} from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec, RedactedSecretValue, SettingsJson } from "@mono-agent/agent-contracts";

import type { A2AAgentSkillOptions } from "./card.js";
import { A2AProviderError } from "./errors.js";
import { A2AConsumerError } from "./errors.js";

export interface A2AAdapterProviderConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl?: string;
  readonly allowNonLoopback: boolean;
  readonly requireBearer: boolean;
  readonly bearerToken?: string;
  readonly maxRequestBytes?: number;
  readonly idempotency?: {
    readonly stateDir?: string;
    readonly namespace: string;
    readonly retentionMs: number;
    readonly maxRecords: number;
  };
}

export interface A2AAdapterAgentConfig {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly providerOrganization?: string;
  readonly providerUrl?: string;
}

export interface A2AAdapterConsumerConfig {
  readonly remoteAgentUrls: readonly string[];
  readonly defaultRemoteAgentUrl?: string;
  readonly bearerToken?: string;
  readonly timeoutMs: number;
}

export interface A2AAdapterConfig {
  readonly provider: A2AAdapterProviderConfig;
  readonly agent?: A2AAdapterAgentConfig;
  readonly skill?: A2AAgentSkillOptions;
  readonly consumer: A2AAdapterConsumerConfig;
}

export interface RedactedA2AAdapterConfig {
  readonly provider: Omit<A2AAdapterProviderConfig, "bearerToken"> & {
    readonly bearerToken: RedactedSecretValue;
  };
  readonly agent?: A2AAdapterAgentConfig;
  readonly skill?: A2AAgentSkillOptions;
  readonly consumer: Omit<A2AAdapterConsumerConfig, "bearerToken" | "remoteAgentUrls"> & {
    readonly remoteAgentUrls: { readonly count: number };
    readonly bearerToken: RedactedSecretValue;
  };
}

export interface LoadA2AAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_IDEMPOTENCY_MAX_RECORDS = 10_000;
const A2A_IDEMPOTENCY_JSON_FIELDS = new Set([
  "stateDir",
  "namespace",
  "retentionMs",
  "maxRecords",
]);

const invalidConfig = (message: string, details?: Record<string, unknown>): A2AProviderError =>
  new A2AProviderError("invalid_config", message, details);

export async function loadA2AAdapterConfig(
  input: LoadA2AAdapterConfigInput,
): Promise<A2AAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const jsonIdempotencyWasConfigured = validateJsonIdempotencySection(json);
  const env = layerA2AJsonOntoEnv(json, input.env);
  // Canonical root flag first (`a2a.enabled` / MONO_AGENT_A2A_ENABLED), matching
  // every other channel; the legacy `a2a.provider.enabled` form keeps working.
  const enabledVar = env.MONO_AGENT_A2A_ENABLED !== undefined ? "MONO_AGENT_A2A_ENABLED" : "MONO_AGENT_A2A_PROVIDER_ENABLED";
  const enabled = readBoolean(env.MONO_AGENT_A2A_ENABLED ?? env.MONO_AGENT_A2A_PROVIDER_ENABLED, enabledVar, false, invalidConfig);
  const publicBaseUrl = normalizeOptionalString(env.MONO_AGENT_A2A_PUBLIC_BASE_URL);
  const providerBearerToken = normalizeOptionalString(env.MONO_AGENT_A2A_BEARER_TOKEN);
  const maxRequestBytes = enabled && env.MONO_AGENT_A2A_MAX_REQUEST_BYTES !== undefined
    ? readInteger(
      env.MONO_AGENT_A2A_MAX_REQUEST_BYTES,
      "MONO_AGENT_A2A_MAX_REQUEST_BYTES",
      100 * 1_024,
      invalidConfig,
      { min: 1_024, max: 100_000_000 },
    )
    : undefined;
  const idempotencyStateDir = normalizeOptionalString(env.MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR);
  const idempotencyNamespace = normalizeOptionalString(env.MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE);
  const idempotencyWasConfigured = jsonIdempotencyWasConfigured || [
    env.MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR,
    env.MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE,
    env.MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS,
    env.MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS,
  ].some((value) => value !== undefined);
  if (idempotencyWasConfigured && idempotencyNamespace === undefined) {
    throw new A2AProviderError(
      "missing_required_config",
      "MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE is required when any A2A idempotency setting is configured.",
      { env: "MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE" },
    );
  }
  const provider: A2AAdapterProviderConfig = {
    enabled,
    host: readString(env.MONO_AGENT_A2A_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_A2A_PORT, "MONO_AGENT_A2A_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 }),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    allowNonLoopback: readBoolean(env.MONO_AGENT_A2A_ALLOW_NON_LOOPBACK, "MONO_AGENT_A2A_ALLOW_NON_LOOPBACK", false, invalidConfig),
    requireBearer: readBoolean(env.MONO_AGENT_A2A_REQUIRE_BEARER, "MONO_AGENT_A2A_REQUIRE_BEARER", false, invalidConfig),
    ...(providerBearerToken === undefined ? {} : { bearerToken: providerBearerToken }),
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    ...(idempotencyNamespace === undefined
      ? {}
      : {
          idempotency: {
            ...(idempotencyStateDir === undefined ? {} : { stateDir: idempotencyStateDir }),
            namespace: idempotencyNamespace,
            retentionMs: readInteger(
              env.MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS,
              "MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS",
              DEFAULT_IDEMPOTENCY_RETENTION_MS,
              invalidConfig,
              { min: 60_000, max: 365 * 24 * 60 * 60 * 1_000 },
            ),
            maxRecords: readInteger(
              env.MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS,
              "MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS",
              DEFAULT_IDEMPOTENCY_MAX_RECORDS,
              invalidConfig,
              { min: 1, max: 1_000_000 },
            ),
          },
        }),
  };

  const consumerBearerToken = normalizeOptionalString(env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN);
  const defaultRemoteAgentUrl = normalizeOptionalString(env.MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL);
  const consumer: A2AAdapterConsumerConfig = {
    remoteAgentUrls: readCsv(env.MONO_AGENT_A2A_REMOTE_AGENT_URLS),
    ...(defaultRemoteAgentUrl === undefined ? {} : { defaultRemoteAgentUrl }),
    ...(consumerBearerToken === undefined ? {} : { bearerToken: consumerBearerToken }),
    timeoutMs: readInteger(env.MONO_AGENT_A2A_TIMEOUT_MS, "MONO_AGENT_A2A_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, invalidConfig, {
      min: 1,
      max: 600_000,
    }),
  };
  validateConsumer(consumer);

  if (!provider.enabled) {
    return { provider, consumer };
  }

  validateProvider(provider);
  const agent = readAgentConfig(env);
  const skill = readSkillConfig(env);
  return {
    provider,
    agent,
    skill,
    consumer,
  };
}

function validateJsonIdempotencySection(json: SettingsJson): boolean {
  const a2a = readJsonSection(json, "a2a");
  const providerValue = a2a.provider;
  if (!isRecordValue(providerValue)
    || !Object.prototype.hasOwnProperty.call(providerValue, "idempotency")) {
    return false;
  }

  const idempotency = providerValue.idempotency;
  if (!isRecordValue(idempotency)) {
    throw invalidConfig(
      "a2a.provider.idempotency must be an object.",
      { path: "a2a.provider.idempotency" },
    );
  }
  const fields = Object.keys(idempotency);
  if (fields.length === 0) {
    throw new A2AProviderError(
      "missing_required_config",
      "a2a.provider.idempotency.namespace is required when the idempotency block is present.",
      {
        path: "a2a.provider.idempotency.namespace",
        env: "MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE",
      },
    );
  }
  const unknownFields = fields.filter((field) => !A2A_IDEMPOTENCY_JSON_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw invalidConfig(
      `a2a.provider.idempotency contains unknown field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}.`,
      {
        path: "a2a.provider.idempotency",
        unknownFields,
      },
    );
  }
  return true;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function redactA2AAdapterConfig(
  config: A2AAdapterConfig,
): RedactedA2AAdapterConfig {
  return {
    provider: {
      ...withoutBearer(config.provider),
      bearerToken: redactedSecret(config.provider.bearerToken),
    },
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.skill === undefined ? {} : { skill: config.skill }),
    consumer: {
      remoteAgentUrls: { count: config.consumer.remoteAgentUrls.length },
      ...(config.consumer.defaultRemoteAgentUrl === undefined
        ? {}
        : { defaultRemoteAgentUrl: config.consumer.defaultRemoteAgentUrl }),
      timeoutMs: config.consumer.timeoutMs,
      bearerToken: redactedSecret(config.consumer.bearerToken),
    },
  };
}

function readRequiredEnv(raw: string | undefined, envName: string): string {
  return readRequired(
    raw,
    envName,
    () =>
      new A2AProviderError(
        "missing_required_config",
        `${envName} is required when A2A provider is enabled.`,
        { env: envName },
      ),
  );
}

function readAgentConfig(env: Record<string, string | undefined>): A2AAdapterAgentConfig {
  const providerOrganization = normalizeOptionalString(env.MONO_AGENT_A2A_PROVIDER_ORGANIZATION);
  const providerUrl = normalizeOptionalString(env.MONO_AGENT_A2A_PROVIDER_URL);
  return {
    name: readRequiredEnv(env.MONO_AGENT_A2A_AGENT_NAME, "MONO_AGENT_A2A_AGENT_NAME"),
    description: readRequiredEnv(env.MONO_AGENT_A2A_AGENT_DESCRIPTION, "MONO_AGENT_A2A_AGENT_DESCRIPTION"),
    version: readRequiredEnv(env.MONO_AGENT_A2A_AGENT_VERSION, "MONO_AGENT_A2A_AGENT_VERSION"),
    ...(providerOrganization === undefined ? {} : { providerOrganization }),
    ...(providerUrl === undefined ? {} : { providerUrl }),
  };
}

function readSkillConfig(env: Record<string, string | undefined>): A2AAgentSkillOptions {
  return {
    id: readRequiredEnv(env.MONO_AGENT_A2A_SKILL_ID, "MONO_AGENT_A2A_SKILL_ID"),
    name: readRequiredEnv(env.MONO_AGENT_A2A_SKILL_NAME, "MONO_AGENT_A2A_SKILL_NAME"),
    description: readRequiredEnv(env.MONO_AGENT_A2A_SKILL_DESCRIPTION, "MONO_AGENT_A2A_SKILL_DESCRIPTION"),
    tags: readCsv(env.MONO_AGENT_A2A_SKILL_TAGS),
  };
}

function validateProvider(provider: A2AAdapterProviderConfig): void {
  if (provider.requireBearer && provider.bearerToken === undefined) {
    throw new A2AProviderError(
      "missing_required_config",
      "MONO_AGENT_A2A_BEARER_TOKEN is required when MONO_AGENT_A2A_REQUIRE_BEARER=true.",
      { env: "MONO_AGENT_A2A_BEARER_TOKEN" },
    );
  }
  if (!provider.allowNonLoopback && !isLoopbackHost(provider.host)) {
    throw new A2AProviderError(
      "unsafe_host",
      "A2A provider refuses non-loopback host without MONO_AGENT_A2A_ALLOW_NON_LOOPBACK=true.",
      { host: provider.host },
    );
  }
  if (provider.publicBaseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(provider.publicBaseUrl);
    } catch (error) {
      throw new A2AProviderError("invalid_config", "MONO_AGENT_A2A_PUBLIC_BASE_URL must be an absolute URL.", {
        env: "MONO_AGENT_A2A_PUBLIC_BASE_URL",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (!provider.allowNonLoopback && !isLoopbackHost(parsed.hostname)) {
      throw new A2AProviderError(
        "unsafe_host",
        "A2A provider refuses non-loopback publicBaseUrl without MONO_AGENT_A2A_ALLOW_NON_LOOPBACK=true.",
        { publicBaseUrl: provider.publicBaseUrl },
      );
    }
  }
}

function validateConsumer(consumer: A2AAdapterConsumerConfig): void {
  for (const url of [
    ...consumer.remoteAgentUrls,
    ...(consumer.defaultRemoteAgentUrl === undefined ? [] : [consumer.defaultRemoteAgentUrl]),
  ]) {
    try {
      new URL(url);
    } catch (error) {
      throw new A2AConsumerError("invalid_agent_card", "A2A remote agent URL must be absolute.", {
        url,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * The `a2a` section's field registry: the single source of truth both the
 * JSON→env layering below and the app's config provenance view derive from.
 * Field ids mirror the JSON paths (`a2a.provider.*`, `a2a.agent.*`,
 * `a2a.skill.*`, `a2a.consumer.*`).
 */
export const A2A_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  // Canonical channel-root flag; wins over the legacy `a2a.provider.enabled` below.
  { id: "a2a.enabled", env: "MONO_AGENT_A2A_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "a2a.provider.enabled", env: "MONO_AGENT_A2A_PROVIDER_ENABLED", kind: "boolean", fromJson: (s) => readRecord(s.provider).enabled },
  { id: "a2a.provider.host", env: "MONO_AGENT_A2A_HOST", fromJson: (s) => readRecord(s.provider).host },
  { id: "a2a.provider.port", env: "MONO_AGENT_A2A_PORT", kind: "integer", fromJson: (s) => readRecord(s.provider).port },
  { id: "a2a.provider.publicBaseUrl", env: "MONO_AGENT_A2A_PUBLIC_BASE_URL", fromJson: (s) => readRecord(s.provider).publicBaseUrl },
  { id: "a2a.provider.allowNonLoopback", env: "MONO_AGENT_A2A_ALLOW_NON_LOOPBACK", kind: "boolean", fromJson: (s) => readRecord(s.provider).allowNonLoopback },
  { id: "a2a.provider.requireBearer", env: "MONO_AGENT_A2A_REQUIRE_BEARER", kind: "boolean", fromJson: (s) => readRecord(s.provider).requireBearer },
  { id: "a2a.provider.bearerToken", env: "MONO_AGENT_A2A_BEARER_TOKEN", secret: true, fromJson: (s) => readRecord(s.provider).bearerToken },
  { id: "a2a.provider.maxRequestBytes", env: "MONO_AGENT_A2A_MAX_REQUEST_BYTES", kind: "integer", fromJson: (s) => readRecord(s.provider).maxRequestBytes },
  { id: "a2a.provider.idempotency.stateDir", env: "MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR", fromJson: (s) => readRecord(readRecord(s.provider).idempotency).stateDir },
  { id: "a2a.provider.idempotency.namespace", env: "MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE", fromJson: (s) => readRecord(readRecord(s.provider).idempotency).namespace },
  { id: "a2a.provider.idempotency.retentionMs", env: "MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS", kind: "integer", fromJson: (s) => readRecord(readRecord(s.provider).idempotency).retentionMs },
  { id: "a2a.provider.idempotency.maxRecords", env: "MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS", kind: "integer", fromJson: (s) => readRecord(readRecord(s.provider).idempotency).maxRecords },

  { id: "a2a.agent.name", env: "MONO_AGENT_A2A_AGENT_NAME", fromJson: (s) => readRecord(s.agent).name },
  { id: "a2a.agent.description", env: "MONO_AGENT_A2A_AGENT_DESCRIPTION", fromJson: (s) => readRecord(s.agent).description },
  { id: "a2a.agent.version", env: "MONO_AGENT_A2A_AGENT_VERSION", fromJson: (s) => readRecord(s.agent).version },
  { id: "a2a.agent.providerOrganization", env: "MONO_AGENT_A2A_PROVIDER_ORGANIZATION", fromJson: (s) => readRecord(s.agent).providerOrganization },
  { id: "a2a.agent.providerUrl", env: "MONO_AGENT_A2A_PROVIDER_URL", fromJson: (s) => readRecord(s.agent).providerUrl },

  { id: "a2a.skill.id", env: "MONO_AGENT_A2A_SKILL_ID", fromJson: (s) => readRecord(s.skill).id },
  { id: "a2a.skill.name", env: "MONO_AGENT_A2A_SKILL_NAME", fromJson: (s) => readRecord(s.skill).name },
  { id: "a2a.skill.description", env: "MONO_AGENT_A2A_SKILL_DESCRIPTION", fromJson: (s) => readRecord(s.skill).description },
  { id: "a2a.skill.tags", env: "MONO_AGENT_A2A_SKILL_TAGS", kind: "csv", fromJson: (s) => readRecord(s.skill).tags },

  { id: "a2a.consumer.remoteAgentUrls", env: "MONO_AGENT_A2A_REMOTE_AGENT_URLS", kind: "csv", fromJson: (s) => readRecord(s.consumer).remoteAgentUrls },
  { id: "a2a.consumer.defaultRemoteAgentUrl", env: "MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL", fromJson: (s) => readRecord(s.consumer).defaultRemoteAgentUrl },
  { id: "a2a.consumer.bearerToken", env: "MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN", secret: true, fromJson: (s) => readRecord(s.consumer).bearerToken },
  { id: "a2a.consumer.timeoutMs", env: "MONO_AGENT_A2A_TIMEOUT_MS", kind: "integer", fromJson: (s) => readRecord(s.consumer).timeoutMs },
];

function layerA2AJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const a2a = readJsonSection(json, "a2a");
  const layered = layerJsonOntoEnv(env, fieldSpecMappings(a2a, A2A_CONFIG_FIELDS));
  if (normalizeOptionalString(layered.MONO_AGENT_A2A_AGENT_NAME) === undefined) {
    const jsonPublicName = readRecord(readRecord(json).agent).name;
    const publicAgentName = normalizeOptionalString(layered.MONO_AGENT_NAME)
      ?? normalizeOptionalString(typeof jsonPublicName === "string" ? jsonPublicName : undefined);
    if (publicAgentName !== undefined) {
      layered.MONO_AGENT_A2A_AGENT_NAME = publicAgentName;
    }
  }
  return layered;
}

function withoutBearer(
  provider: A2AAdapterProviderConfig,
): Omit<A2AAdapterProviderConfig, "bearerToken"> {
  const { bearerToken: _bearerToken, ...safeProvider } = provider;
  return safeProvider;
}

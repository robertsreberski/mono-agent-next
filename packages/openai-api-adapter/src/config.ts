import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  readBoolean,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
  isLoopbackHost,
  normalizeOptionalString,
  redactedSecret,
} from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec, RedactedSecretValue, SettingsJson } from "@mono-agent/agent-contracts";

import {
  DEFAULT_BASE_PATH,
  DEFAULT_HOST,
  DEFAULT_MODEL_ID,
  DEFAULT_PORT,
} from "./constants.js";
import { OpenAIApiAdapterError } from "./errors.js";

export interface OpenAIApiAdapterConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly allowNonLoopback: boolean;
  readonly apiKey?: string;
  readonly modelId: string;
}

export interface RedactedOpenAIApiAdapterConfig extends Omit<OpenAIApiAdapterConfig, "apiKey"> {
  readonly apiKey: RedactedSecretValue;
}

export interface LoadOpenAIApiAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_ENABLED = false;

const invalidConfig = (message: string, details?: Record<string, unknown>): OpenAIApiAdapterError =>
  new OpenAIApiAdapterError("invalid_config", message, details);

export async function loadOpenAIApiAdapterConfig(
  input: LoadOpenAIApiAdapterConfigInput,
): Promise<OpenAIApiAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerOpenAIApiJsonOntoEnv(json, input.env);
  const apiKey = normalizeOptionalString(env.MONO_AGENT_OPENAI_API_KEY);
  const enabled = readBoolean(env.MONO_AGENT_OPENAI_API_ENABLED, "MONO_AGENT_OPENAI_API_ENABLED", DEFAULT_ENABLED, invalidConfig);
  const host = readString(env.MONO_AGENT_OPENAI_API_HOST, DEFAULT_HOST);
  const allowNonLoopback = readBoolean(env.MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK, "MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK", false, invalidConfig);
  if (enabled && !isLoopbackHost(host) && !allowNonLoopback) {
    throw invalidConfig("MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK must be true when the enabled OpenAI API binds a non-loopback host.", { host });
  }
  if (enabled && !isLoopbackHost(host) && apiKey === undefined) {
    throw invalidConfig("MONO_AGENT_OPENAI_API_KEY is required when the enabled OpenAI API binds a non-loopback host.", { host });
  }
  return {
    enabled,
    host,
    port: readInteger(env.MONO_AGENT_OPENAI_API_PORT, "MONO_AGENT_OPENAI_API_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 }),
    basePath: readBasePath(env.MONO_AGENT_OPENAI_API_BASE_PATH),
    allowNonLoopback,
    ...(apiKey === undefined ? {} : { apiKey }),
    modelId: readString(env.MONO_AGENT_OPENAI_API_MODEL_ID, DEFAULT_MODEL_ID),
  };
}

export function redactOpenAIApiAdapterConfig(
  config: OpenAIApiAdapterConfig,
): RedactedOpenAIApiAdapterConfig {
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    basePath: config.basePath,
    allowNonLoopback: config.allowNonLoopback,
    apiKey: redactedSecret(config.apiKey),
    modelId: config.modelId,
  };
}

/**
 * The `openaiApi` section's field registry: the single source of truth both
 * the JSON→env layering below and the app's config provenance view derive from.
 */
export const OPENAI_API_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "openaiApi.enabled", env: "MONO_AGENT_OPENAI_API_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "openaiApi.host", env: "MONO_AGENT_OPENAI_API_HOST", fromJson: (s) => s.host },
  { id: "openaiApi.port", env: "MONO_AGENT_OPENAI_API_PORT", kind: "integer", fromJson: (s) => s.port },
  { id: "openaiApi.basePath", env: "MONO_AGENT_OPENAI_API_BASE_PATH", fromJson: (s) => s.basePath },
  { id: "openaiApi.allowNonLoopback", env: "MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK", kind: "boolean", fromJson: (s) => s.allowNonLoopback },
  { id: "openaiApi.apiKey", env: "MONO_AGENT_OPENAI_API_KEY", secret: true, fromJson: (s) => s.apiKey },
  { id: "openaiApi.modelId", env: "MONO_AGENT_OPENAI_API_MODEL_ID", fromJson: (s) => s.modelId },
];

function layerOpenAIApiJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "openaiApi"), OPENAI_API_CONFIG_FIELDS));
}

function readBasePath(raw: string | undefined): string {
  const value = readString(raw, DEFAULT_BASE_PATH);
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw invalidConfig("MONO_AGENT_OPENAI_API_BASE_PATH must be an absolute path without query or hash.");
  }
  return value.length === 1 ? "/" : value.replace(/\/+$/u, "");
}

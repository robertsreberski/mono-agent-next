import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  readBoolean,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
  normalizeOptionalString,
  redactedSecret,
} from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec, RedactedSecretValue, SettingsJson } from "@mono-agent/agent-contracts";

import { DEFAULT_BASE_PATH, DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import { TuiAdapterError } from "./errors.js";

export interface TuiAdapterConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly allowNonLoopback: boolean;
  readonly apiKey?: string;
}

export interface RedactedTuiAdapterConfig extends Omit<TuiAdapterConfig, "apiKey"> {
  readonly apiKey: RedactedSecretValue;
}

export interface LoadTuiAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

/**
 * Unlike every chat channel (telegram/slack/…, default OFF), the TUI endpoint
 * is ON by default: it is an operator surface, binds loopback-only on an
 * ephemeral port, and needs no credentials — and `mono-agent tui` must be able
 * to reach any running agent without a per-agent config edit. Set
 * `"tui": { "enabled": false }` to opt out.
 */
const DEFAULT_ENABLED = true;

const invalidConfig = (message: string, details?: Record<string, unknown>): TuiAdapterError =>
  new TuiAdapterError("invalid_config", message, details);

export async function loadTuiAdapterConfig(
  input: LoadTuiAdapterConfigInput,
): Promise<TuiAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerTuiJsonOntoEnv(json, input.env);
  const apiKey = normalizeOptionalString(env.MONO_AGENT_TUI_API_KEY);
  return {
    enabled: readBoolean(env.MONO_AGENT_TUI_ENABLED, "MONO_AGENT_TUI_ENABLED", DEFAULT_ENABLED, invalidConfig),
    host: readString(env.MONO_AGENT_TUI_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_TUI_PORT, "MONO_AGENT_TUI_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 }),
    basePath: readBasePath(env.MONO_AGENT_TUI_BASE_PATH),
    allowNonLoopback: readBoolean(env.MONO_AGENT_TUI_ALLOW_NON_LOOPBACK, "MONO_AGENT_TUI_ALLOW_NON_LOOPBACK", false, invalidConfig),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export function redactTuiAdapterConfig(config: TuiAdapterConfig): RedactedTuiAdapterConfig {
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    basePath: config.basePath,
    allowNonLoopback: config.allowNonLoopback,
    apiKey: redactedSecret(config.apiKey),
  };
}

/**
 * The `tui` section's field registry: the single source of truth both the
 * JSON→env layering below and the app's config provenance view derive from.
 * The `tui.apiKey` id doubles as a cross-package contract: `mono-agent tui`
 * resolves a running agent's key by reading this field from the agent's
 * config file (the trace-source registry never carries secrets).
 */
export const TUI_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "tui.enabled", env: "MONO_AGENT_TUI_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "tui.host", env: "MONO_AGENT_TUI_HOST", fromJson: (s) => s.host },
  { id: "tui.port", env: "MONO_AGENT_TUI_PORT", kind: "integer", fromJson: (s) => s.port },
  { id: "tui.basePath", env: "MONO_AGENT_TUI_BASE_PATH", fromJson: (s) => s.basePath },
  { id: "tui.allowNonLoopback", env: "MONO_AGENT_TUI_ALLOW_NON_LOOPBACK", kind: "boolean", fromJson: (s) => s.allowNonLoopback },
  { id: "tui.apiKey", env: "MONO_AGENT_TUI_API_KEY", secret: true, fromJson: (s) => s.apiKey },
];

function layerTuiJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "tui"), TUI_CONFIG_FIELDS));
}

function readBasePath(raw: string | undefined): string {
  const value = readString(raw, DEFAULT_BASE_PATH);
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw invalidConfig("MONO_AGENT_TUI_BASE_PATH must be an absolute path without query or hash.");
  }
  // An all-slashes value ("////") must collapse to "/" — stripping it to ""
  // here would pass config loading and then fail startTuiAdapter at startup.
  const stripped = value.replace(/\/+$/u, "");
  return stripped.length === 0 ? "/" : stripped;
}

import type { ConfigViewField, ConfigViewSection } from "@mono-agent/config";
import { encodeJsonEnvValue, normalizeOptionalString, readJsonSection, readSettingsJson } from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec } from "@mono-agent/agent-contracts";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { ChannelDriver } from "./channels.js";

const PLACEHOLDER = "—";

/**
 * The driver facts a channel config view needs: enough to resolve the section
 * status through the channel's own loader without starting anything.
 */
type ChannelViewDriver = Pick<ChannelDriver, "id" | "label" | "loadConfig" | "isConfigError" | "disabledReason">;

/**
 * Compose one channel's source-annotated config section from the adapter's
 * exported field registry — the channel counterpart of the core
 * `buildMonoAgentConfigView`. Field sources resolve with the loader's own
 * layering semantics (a set env var wins, then a JSON value the layer function
 * would encode, else the default), so the view can never disagree with what the
 * adapter actually reads. Secret fields are never printed — only set/unset.
 */
export async function buildChannelConfigView(
  driver: ChannelViewDriver,
  fields: readonly JsonEnvFieldSpec[],
  input: MonoAgentAppConfigInput,
  options: { readonly jsonKey?: string } = {},
): Promise<ConfigViewSection> {
  const { json } = await readSettingsJson(input.configPath);
  const section = readJsonSection(json, options.jsonKey ?? driver.id);

  // An explicitly disabled channel reports `disabled`; an enabled channel —
  // even one still waiting for credentials (typed config error) — is `active`.
  let status: ConfigViewSection["status"] = "active";
  try {
    const config = await driver.loadConfig(input);
    if (driver.disabledReason?.(config) !== undefined) {
      status = "disabled";
    }
  } catch (error) {
    if (!driver.isConfigError(error)) {
      throw error;
    }
  }

  return {
    id: driver.id,
    label: driver.label,
    status,
    fields: fields.map((field) => toChannelViewField(field, section, input.env)),
  };
}

function toChannelViewField(
  field: JsonEnvFieldSpec,
  section: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ConfigViewField {
  const envValue = normalizeOptionalString(env[field.env]);
  const jsonValue = encodeJsonEnvValue(field.fromJson(section), field.kind ?? "string");
  const resolved = envValue ?? jsonValue;
  const source = envValue !== undefined ? "env" : jsonValue !== undefined ? "json" : "default";
  return {
    id: field.id,
    label: labelForFieldId(field.id),
    value: field.secret === true ? (resolved === undefined ? "unset" : "set") : resolved ?? PLACEHOLDER,
    source,
    ...(field.secret === true ? { redacted: true } : {}),
    envKey: field.env,
  };
}

/**
 * Collect every driver's config view section. Advisory surface: a channel
 * whose view fails to compose is skipped — its validate section reports the
 * load problem loudly instead.
 */
export async function collectChannelConfigViews(
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<readonly ConfigViewSection[]> {
  const sections: ConfigViewSection[] = [];
  for (const driver of drivers) {
    if (driver.configView === undefined) {
      continue;
    }
    try {
      sections.push(await driver.configView(input));
    } catch {
      // Skip: the channel's own validate section owns error reporting.
    }
  }
  return sections;
}

/** `a2a.provider.bearerToken` → "Provider bearer token". */
function labelForFieldId(id: string): string {
  const words = id
    .split(".")
    .slice(1)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

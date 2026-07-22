/**
 * Typed env-coercion + JSON-layering toolkit shared by every adapter config
 * loader. Each adapter previously hand-rolled near-identical
 * readBoolean/readInteger/normalizeOptionalString/set* helpers plus a
 * `layer<X>JsonOntoEnv` merge; these helpers collapse that boilerplate while
 * keeping each adapter's own typed error via an injected error factory, so
 * fail-closed messages stay under the adapter's control.
 */
import type { SettingsJson } from "./types.js";

/**
 * Builds an adapter-specific typed error. Callers bind the error code so a
 * single helper can raise `invalid_config`, `missing_required_config`, etc.
 */
export type ConfigErrorFactory = (
  message: string,
  details?: Record<string, unknown>,
) => Error;

/** Trim a raw value and treat empty strings as absent. */
export function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

/** Read a string with a default when unset/blank. */
export function readString(
  raw: string | undefined,
  defaultValue: string,
): string {
  return normalizeOptionalString(raw) ?? defaultValue;
}

/**
 * Read a required string, raising the caller's typed error when absent. The
 * `${name} is required.` message is passed to the factory (callers that build
 * their own message can ignore it); `{ env: name }` is always in the details.
 */
export function readRequired(
  raw: string | undefined,
  name: string,
  onMissing: ConfigErrorFactory,
): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    throw onMissing(`${name} is required.`, { env: name });
  }
  return normalized;
}

/** Split a comma-separated value into trimmed, non-empty entries. */
export function readCsv(raw: string | undefined): string[] {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return [];
  }
  return normalized
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Coerce "true"/"false" to a boolean, raising the caller's error otherwise. */
export function readBoolean(
  raw: string | undefined,
  name: string,
  defaultValue: boolean,
  onInvalid: ConfigErrorFactory,
): boolean {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw onInvalid(`${name} must be true or false.`, {
    env: name,
    reason: normalized,
  });
}

/** Coerce a non-negative integer within optional bounds. */
export function readInteger(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  onInvalid: ConfigErrorFactory,
  bounds?: { readonly min: number; readonly max: number },
): number {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw onInvalid(`${name} must be an integer.`, { env: name });
  }
  const value = Number.parseInt(normalized, 10);
  if (
    bounds !== undefined &&
    (value < bounds.min || value > bounds.max)
  ) {
    throw onInvalid(
      `${name} must be between ${bounds.min} and ${bounds.max}.`,
      { env: name },
    );
  }
  return value;
}

/** Coerce a value to one of a closed set of string choices. */
export function readChoice<T extends string>(
  raw: string | undefined,
  name: string,
  choices: readonly T[],
  defaultValue: T,
  onInvalid: ConfigErrorFactory,
): T {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if ((choices as readonly string[]).includes(normalized)) {
    return normalized as T;
  }
  throw onInvalid(
    `${name} must be one of: ${choices.join(", ")}.`,
    { env: name, reason: normalized },
  );
}

/** Narrow an unknown JSON value to a plain record (never null/array). */
export function readRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** How a JSON value is encoded into the string env layer. */
export type EnvEncodeKind = "string" | "boolean" | "integer" | "csv";

export interface JsonEnvMapping {
  readonly env: string;
  readonly value: unknown;
  readonly kind?: EnvEncodeKind;
}

/**
 * One config field in an adapter's exported field registry: the JSON→env
 * layering facts (id + env + kind) plus the metadata provenance/secret surfaces
 * need. The registry is the single source of truth — the adapter's layer
 * function and the app's config view both derive from it, so the two can never
 * drift apart.
 */
export interface JsonEnvFieldSpec {
  /** Stable dotted field id mirroring the JSON path, e.g. `channel.botToken`. */
  readonly id: string;
  readonly env: string;
  readonly kind?: EnvEncodeKind;
  /** True for credential fields: views redact the value and flag JSON placement. */
  readonly secret?: boolean;
  /** Extract the field's raw value from the channel's JSON section. */
  readonly fromJson: (section: Record<string, unknown>) => unknown;
}

/** Build the {@link layerJsonOntoEnv} mappings from a field registry. */
export function fieldSpecMappings(
  section: Record<string, unknown>,
  fields: readonly JsonEnvFieldSpec[],
): readonly JsonEnvMapping[] {
  return fields.map((field) => ({
    env: field.env,
    value: field.fromJson(section),
    ...(field.kind === undefined ? {} : { kind: field.kind }),
  }));
}

/**
 * Encode a JSON value exactly the way {@link layerJsonOntoEnv} would
 * (`undefined` = absent or wrong type, i.e. the loader would fall through to
 * the real env or the default). Exposed so provenance views resolve a field's
 * source with the loader's own semantics.
 */
export function encodeJsonEnvValue(
  value: unknown,
  kind: EnvEncodeKind = "string",
): string | undefined {
  return encodeEnvValue(value, kind);
}

/**
 * Encode a JSON config section into the string env shape, then overlay the real
 * process env so explicit env vars always win over JSON defaults. This replaces
 * each adapter's bespoke `layer<X>JsonOntoEnv` + `set*` helpers.
 */
export function layerJsonOntoEnv(
  env: Record<string, string | undefined>,
  mappings: readonly JsonEnvMapping[],
): Record<string, string | undefined> {
  const layered: Record<string, string | undefined> = {};
  for (const mapping of mappings) {
    const encoded = encodeEnvValue(mapping.value, mapping.kind ?? "string");
    if (encoded !== undefined) {
      layered[mapping.env] = encoded;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function encodeEnvValue(
  value: unknown,
  kind: EnvEncodeKind,
): string | undefined {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? (value ? "true" : "false") : undefined;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? String(value)
        : undefined;
    case "csv":
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").join(",")
        : undefined;
    case "string":
    default:
      return typeof value === "string" ? value : undefined;
  }
}

/** Read a named object section from a settings JSON document. */
export function readJsonSection(
  json: SettingsJson,
  key: string,
): Record<string, unknown> {
  return readRecord((json as Record<string, unknown>)[key]);
}

/**
 * Canonical redacted-secret marker for adapter `redact<X>Config` helpers, so
 * each adapter stops inlining its own `{ present, redacted: true }` shape. This
 * is the diagnostics/redaction shape (distinct from the field-group-driven
 * {@link import("./redact.js").RedactedSecret} consumed by operator surfaces).
 */
export interface RedactedSecretValue {
  readonly present: boolean;
  readonly redacted: true;
}

/** Build a {@link RedactedSecretValue} from a (possibly absent) secret string. */
export function redactedSecret(
  value: string | undefined,
): RedactedSecretValue {
  return {
    present: value !== undefined && value.length > 0,
    redacted: true,
  };
}

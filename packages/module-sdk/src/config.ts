// SPDX-License-Identifier: MIT
export const MODULE_API_VERSION = 1 as const;
export const OPEN_MODULE_KINDS = ["runtime", "channel", "memory"] as const;
export type Awaitable<T> = T | PromiseLike<T>;
export type ModuleApiVersion = typeof MODULE_API_VERSION;
export type ModuleKind = (typeof OPEN_MODULE_KINDS)[number];
export type ModuleSlot = ModuleKind | "state" | "trigger" | "exporter" | "sandbox";
export type ModuleCapability = string;
export type ConfigPathSegment = string | number;
export type ConfigPath = readonly ConfigPathSegment[];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;
export type JsonSchema = Readonly<Record<string, unknown>>;
/** JSON Schema annotation consumed by core before a module parser runs. */
export const MODULE_SCHEMA_ENV_ELIGIBLE = "x-mono-agent-env-eligible" as const;
/** JSON Schema annotation that rejects inline literals and redacts explain output. */
export const MODULE_SCHEMA_SECRET = "x-mono-agent-secret" as const;
/** JSON Schema annotation naming a configured instance in another typed slot. */
export const MODULE_SCHEMA_SLOT_REFERENCE = "x-mono-agent-slot-reference" as const;
export interface EnvEligibleSchemaOptions { readonly secret?: boolean; }
export interface CrossSlotReference { readonly slot: ModuleSlot; readonly capability?: string; }
/**
 * Marks a scalar schema as eligible for core's `{$env: "NAME"}` directive.
 * Core validates and resolves the wrapper before calling the module parser.
 * Raw references remain only in core-owned provenance and explain data.
 */
export function envEligibleSchema(
  schema: JsonSchema,
  options: EnvEligibleSchemaOptions = {},
): JsonSchema {
  return Object.freeze({
    ...schema,
    [MODULE_SCHEMA_ENV_ELIGIBLE]: true,
    ...(options.secret === true ? { [MODULE_SCHEMA_SECRET]: true } : {}),
  });
}
export function isEnvEligibleSchema(schema: JsonSchema): boolean {
  return schema[MODULE_SCHEMA_ENV_ELIGIBLE] === true;
}
export function isSecretSchema(schema: JsonSchema): boolean {
  return schema[MODULE_SCHEMA_SECRET] === true;
}
/**
 * Marks a string schema as an instance-id reference into another configured
 * slot. Core validates existence, slot kind, and the optional capability after
 * every selected module schema has been composed.
 */
export function crossSlotReferenceSchema(
  schema: JsonSchema,
  reference: CrossSlotReference,
): JsonSchema {
  if (schema.type !== "string") throw new TypeError("Cross-slot references must annotate a string schema");
  if (!isModuleSlot(reference.slot)) throw new TypeError(`Unknown module slot: ${reference.slot}`);
  if (reference.capability !== undefined && reference.capability.trim().length === 0) {
    throw new TypeError("Cross-slot capability must not be empty");
  }
  return Object.freeze({
    ...schema,
    [MODULE_SCHEMA_SLOT_REFERENCE]: Object.freeze({ ...reference }),
  });
}
export function readCrossSlotReference(schema: JsonSchema): CrossSlotReference | undefined {
  const value = schema[MODULE_SCHEMA_SLOT_REFERENCE];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const slot = Reflect.get(value, "slot");
  const capability = Reflect.get(value, "capability");
  if (!isModuleSlot(slot)) return undefined;
  if (capability !== undefined && (typeof capability !== "string" || capability.trim().length === 0)) {
    return undefined;
  }
  return Object.freeze({ slot, ...(capability === undefined ? {} : { capability }) });
}
export interface ModuleManifest<K extends ModuleKind = ModuleKind> {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly apiVersion: ModuleApiVersion;
  readonly kind: K;
  readonly responsibility: string;
  readonly capabilities: readonly ModuleCapability[];
}
/**
 * An executable schema. Parsing must be deterministic and side-effect-free,
 * and return an acyclic graph of plain objects, dense arrays, and primitive
 * config values. Core takes and freezes an exact own-data snapshot before
 * validation or module creation; accessors, proxies, symbols, and exotic
 * prototypes are rejected.
 */
export interface ModuleSchema<TConfig> { readonly jsonSchema: JsonSchema; parse(input: unknown): TConfig; }
export type ModuleConfigSchema<TConfig> = ModuleSchema<TConfig>;
export type ConfigProvenanceSource =
  | "default"
  | "file"
  | "environment"
  | "argument"
  | "generated";
/**
 * Identifies where a value came from without retaining the value itself.
 * `environmentName` is safe to render; the referenced environment value is not.
 */
export interface ConfigProvenance {
  readonly source: ConfigProvenanceSource;
  readonly filePath?: string;
  readonly environmentName?: string;
  readonly description?: string;
}
/** JSON-pointer keys map to the provenance of the value at that path. */
export type ConfigProvenanceMap = Readonly<Record<string, ConfigProvenance>>;
export interface ConfigIssue {
  readonly code: string;
  readonly message: string;
  readonly path: ConfigPath;
  readonly provenance?: ConfigProvenance;
}
export interface ModuleConfigErrorOptions {
  readonly message?: string; readonly issues: readonly ConfigIssue[]; readonly cause?: unknown;
}
export class ModuleConfigError extends Error {
  readonly code = "MODULE_CONFIG_INVALID";
  readonly issues: readonly ConfigIssue[];
  constructor(options: ModuleConfigErrorOptions) {
    const issues = options.issues.map((issue) => freezeConfigIssue(issue));
    const message = options.message ?? issues[0]?.message ?? "Module configuration is invalid";
    if (options.cause === undefined) super(message);
    else super(message, { cause: options.cause });
    this.name = "ModuleConfigError";
    this.issues = Object.freeze(issues);
  }
}
export interface ParseModuleConfigOptions {
  readonly packageName?: string; readonly provenance?: ConfigProvenanceMap;
}
export function isModuleConfigError(value: unknown): value is ModuleConfigError {
  return value instanceof ModuleConfigError;
}
export function defineModuleSchema<TConfig>(schema: ModuleSchema<TConfig>): ModuleSchema<TConfig> {
  return Object.freeze({
    jsonSchema: Object.freeze({ ...schema.jsonSchema }),
    parse: schema.parse,
  });
}
export function defineConfigProvenance(provenance: ConfigProvenance): ConfigProvenance {
  return Object.freeze({ ...provenance });
}
export function configPathToPointer(path: ConfigPath): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => escapeJsonPointerSegment(String(segment))).join("/")}`;
}
export function provenanceAt(
  provenance: ConfigProvenanceMap | undefined,
  path: ConfigPath,
): ConfigProvenance | undefined {
  if (provenance === undefined) return undefined;
  for (let length = path.length; length >= 0; length -= 1) {
    const found = provenance[configPathToPointer(path.slice(0, length))];
    if (found !== undefined) return found;
  }
  return undefined;
}
export function configIssue(
  code: string,
  message: string,
  path: ConfigPath = [],
  provenance?: ConfigProvenance,
): ConfigIssue {
  return freezeConfigIssue({
    code,
    message,
    path,
    ...(provenance === undefined ? {} : { provenance }),
  });
}
export function parseModuleConfig<TConfig>(
  schema: ModuleSchema<TConfig>,
  input: unknown,
  options: ParseModuleConfigOptions = {},
): TConfig {
  try {
    return schema.parse(input);
  } catch (error) {
    if (isModuleConfigError(error)) throw error;
    const prefix = options.packageName === undefined ? "Module" : options.packageName;
    const message = error instanceof Error ? error.message : "Configuration parser rejected the input";
    throw new ModuleConfigError({
      message: `${prefix} configuration is invalid: ${message}`,
      issues: [configIssue("invalid_config", message, [], provenanceAt(options.provenance, []))],
      cause: error,
    });
  }
}
function freezeConfigIssue(issue: ConfigIssue): ConfigIssue {
  return Object.freeze({
    ...issue,
    path: Object.freeze([...issue.path]),
    ...(issue.provenance === undefined ? {} : { provenance: defineConfigProvenance(issue.provenance) }),
  });
}
function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
function isModuleSlot(value: unknown): value is ModuleSlot {
  return value === "runtime" || value === "channel" || value === "memory" || value === "state"
    || value === "trigger" || value === "exporter" || value === "sandbox";
}

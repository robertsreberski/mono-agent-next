// SPDX-License-Identifier: MIT
import { SandboxSrtError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ARGUMENTS = 1_024;
const DEFAULT_MAX_ARGUMENT_BYTES = 256 * 1024;
const DEFAULT_MAX_ENVIRONMENT_VARIABLES = 64;
const DEFAULT_MAX_ENVIRONMENT_BYTES = 64 * 1024;

export interface SandboxSrtFileConfig {
  readonly path: string;
  readonly sha256: string;
}

export interface SandboxSrtLimitsConfig {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
  readonly maxArguments: number;
  readonly maxArgumentBytes: number;
  readonly maxEnvironmentVariables: number;
  readonly maxEnvironmentBytes: number;
}

export interface SandboxSrtEnvironmentConfig {
  /** Ambient variables copied into the otherwise empty child environment. */
  readonly inherit: readonly string[];
  /** Per-command variables Core may supply. */
  readonly allow: readonly string[];
}

export interface SandboxSrtConfig {
  readonly executable: SandboxSrtFileConfig;
  readonly settings: SandboxSrtFileConfig;
  readonly limits: SandboxSrtLimitsConfig;
  readonly environment: SandboxSrtEnvironmentConfig;
}

export const sandboxSrtJsonSchema = Object.freeze({
  $id: "https://mono-agent.dev/schemas/sandbox-srt/v1.json",
  type: "object",
  additionalProperties: false,
  required: ["executable", "settings"],
  properties: {
    executable: fileSchema(),
    settings: fileSchema(),
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        defaultTimeoutMs: integerSchema(1, 3_600_000, DEFAULT_TIMEOUT_MS),
        maxTimeoutMs: integerSchema(1, 3_600_000, DEFAULT_MAX_TIMEOUT_MS),
        maxOutputBytes: integerSchema(1, 67_108_864, DEFAULT_MAX_OUTPUT_BYTES),
        maxInputBytes: integerSchema(0, 16_777_216, DEFAULT_MAX_INPUT_BYTES),
        maxArguments: integerSchema(0, 4_096, DEFAULT_MAX_ARGUMENTS),
        maxArgumentBytes: integerSchema(0, 1_048_576, DEFAULT_MAX_ARGUMENT_BYTES),
        maxEnvironmentVariables: integerSchema(0, 256, DEFAULT_MAX_ENVIRONMENT_VARIABLES),
        maxEnvironmentBytes: integerSchema(0, 1_048_576, DEFAULT_MAX_ENVIRONMENT_BYTES),
      },
    },
    environment: {
      type: "object",
      additionalProperties: false,
      properties: {
        inherit: { type: "array", uniqueItems: true, maxItems: 256, items: environmentNameSchema() },
        allow: { type: "array", uniqueItems: true, maxItems: 256, items: environmentNameSchema() },
      },
    },
  },
} as const);

const ROOT_KEYS = ["executable", "settings", "limits", "environment"] as const;
const FILE_KEYS = ["path", "sha256"] as const;
const LIMIT_KEYS = [
  "defaultTimeoutMs",
  "maxTimeoutMs",
  "maxOutputBytes",
  "maxInputBytes",
  "maxArguments",
  "maxArgumentBytes",
  "maxEnvironmentVariables",
  "maxEnvironmentBytes",
] as const;
const ENVIRONMENT_KEYS = ["inherit", "allow"] as const;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENVIRONMENT_PREFIX = /^(?:LD_|DYLD_)/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function parseSandboxSrtConfig(input: unknown): SandboxSrtConfig {
  const root = plainObject(input, "$", ROOT_KEYS);
  const executable = parseFile(root.executable, "$.executable");
  const settings = parseFile(root.settings, "$.settings");
  if (executable.path === settings.path) fail("$", "executable and settings paths must differ");
  const limits = root.limits === undefined ? {} : plainObject(root.limits, "$.limits", LIMIT_KEYS);
  const environment = root.environment === undefined
    ? {}
    : plainObject(root.environment, "$.environment", ENVIRONMENT_KEYS);
  const defaultTimeoutMs = boundedInteger(limits.defaultTimeoutMs, DEFAULT_TIMEOUT_MS, 1, 3_600_000, "$.limits.defaultTimeoutMs");
  const maxTimeoutMs = boundedInteger(limits.maxTimeoutMs, DEFAULT_MAX_TIMEOUT_MS, 1, 3_600_000, "$.limits.maxTimeoutMs");
  if (defaultTimeoutMs > maxTimeoutMs) fail("$.limits.defaultTimeoutMs", "must not exceed maxTimeoutMs");
  const inherit = environmentNames(environment.inherit, "$.environment.inherit");
  const allow = environmentNames(environment.allow, "$.environment.allow");

  return Object.freeze({
    executable,
    settings,
    limits: Object.freeze({
      defaultTimeoutMs,
      maxTimeoutMs,
      maxOutputBytes: boundedInteger(limits.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 67_108_864, "$.limits.maxOutputBytes"),
      maxInputBytes: boundedInteger(limits.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 0, 16_777_216, "$.limits.maxInputBytes"),
      maxArguments: boundedInteger(limits.maxArguments, DEFAULT_MAX_ARGUMENTS, 0, 4_096, "$.limits.maxArguments"),
      maxArgumentBytes: boundedInteger(limits.maxArgumentBytes, DEFAULT_MAX_ARGUMENT_BYTES, 0, 1_048_576, "$.limits.maxArgumentBytes"),
      maxEnvironmentVariables: boundedInteger(limits.maxEnvironmentVariables, DEFAULT_MAX_ENVIRONMENT_VARIABLES, 0, 256, "$.limits.maxEnvironmentVariables"),
      maxEnvironmentBytes: boundedInteger(limits.maxEnvironmentBytes, DEFAULT_MAX_ENVIRONMENT_BYTES, 0, 1_048_576, "$.limits.maxEnvironmentBytes"),
    }),
    environment: Object.freeze({ inherit, allow }),
  });
}

function parseFile(input: unknown, path: string): SandboxSrtFileConfig {
  const value = plainObject(input, path, FILE_KEYS);
  if (typeof value.path !== "string" || value.path.length === 0 || value.path !== value.path.trim() || CONTROL.test(value.path)) {
    fail(`${path}.path`, "must be a non-empty trimmed path without control characters");
  }
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    fail(`${path}.sha256`, "must be a lowercase SHA-256 digest");
  }
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}

function environmentNames(input: unknown, path: string): readonly string[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) fail(path, "must be an array");
  const names = input.map((value, index) => {
    if (typeof value !== "string" || !ENVIRONMENT_NAME.test(value)) fail(`${path}[${index}]`, "is not a valid environment name");
    if (isReservedSandboxEnvironmentName(value)) {
      fail(`${path}[${index}]`, "is reserved for the host runtime");
    }
    return value;
  });
  if (new Set(names).size !== names.length) fail(path, "must not contain duplicates");
  return Object.freeze([...names]);
}

export function isReservedSandboxEnvironmentName(name: string): boolean {
  return name === "NODE_OPTIONS"
    || name === "NODE_PATH"
    || RESERVED_ENVIRONMENT_PREFIX.test(name);
}

function plainObject(input: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(path, "must be an object");
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  const object = input as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).filter((key) => !allowedSet.has(key)).sort();
  if (unknown.length > 0) fail(path, `contains unknown field(s): ${unknown.join(", ")}`);
  return object;
}

function boundedInteger(input: unknown, fallback: number, minimum: number, maximum: number, path: string): number {
  if (input === undefined) return fallback;
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return input as number;
}

function fail(path: string, message: string): never {
  throw new SandboxSrtError(
    "invalid_config",
    `sandbox-srt config ${path} ${message}`,
  );
}

function fileSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["path", "sha256"],
    properties: {
      path: { type: "string", minLength: 1 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  };
}

function integerSchema(minimum: number, maximum: number, fallback: number): Readonly<Record<string, unknown>> {
  return { type: "integer", minimum, maximum, default: fallback };
}

function environmentNameSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "string",
    allOf: [
      { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      { not: { enum: ["NODE_OPTIONS", "NODE_PATH"] } },
      { not: { pattern: "^(?:LD_|DYLD_)" } },
    ],
  };
}

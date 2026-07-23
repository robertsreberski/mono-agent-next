import { envEligibleSchema } from "@mono-agent/module-sdk";

export interface RuntimeOpenCodeConfig {
  readonly binary: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly minimumVersion: string;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
  readonly pure: true;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const OPEN_CODE_SECURE_SERVER_VERSION = "1.15.13";

function versionTuple(value: string): readonly [number, number, number] {
  const match = VERSION.exec(value);
  if (match === null) throw new TypeError("runtime-opencode config.minimumVersion must be stable semver");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if ((actual[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((actual[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function strict(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${path}.${key} is not supported`);
}

function string(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL.test(value)) {
    throw new TypeError(`${path} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function integer(value: unknown, fallback: number, min: number, max: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${path} must be an integer from ${min} through ${max}`);
  return Number(value);
}

export const runtimeOpenCodeJsonSchema = {
  $id: "https://mono-agent.dev/schemas/runtime-opencode/v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    binary: { type: "string", minLength: 1 },
    environment: {
      type: "object",
      maxProperties: 64,
      propertyNames: { pattern: "^[A-Z_][A-Z0-9_]{0,127}$" },
      additionalProperties: envEligibleSchema({ type: "string" }, { secret: true }),
    },
    minimumVersion: { type: "string", pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$", default: OPEN_CODE_SECURE_SERVER_VERSION },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000, default: 600000 },
    maxLineBytes: { type: "integer", minimum: 1024, maximum: 16777216, default: 1048576 },
    maxStderrBytes: { type: "integer", minimum: 1024, maximum: 1048576, default: 65536 },
    pure: { type: "boolean", const: true, default: true },
  },
} as const;

export function parseRuntimeOpenCodeConfig(input: unknown): RuntimeOpenCodeConfig {
  const value = input === undefined ? {} : object(input, "runtime-opencode config");
  strict(value, ["binary", "environment", "minimumVersion", "timeoutMs", "maxLineBytes", "maxStderrBytes", "pure"], "runtime-opencode config");
  const environmentValue = value.environment === undefined ? {} : object(value.environment, "runtime-opencode config.environment");
  if (Object.keys(environmentValue).length > 64) throw new TypeError("runtime-opencode config.environment has too many entries");
  const environment: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(environmentValue)) {
    if (!ENV_NAME.test(name)) throw new TypeError(`runtime-opencode config.environment.${name} has an invalid environment name`);
    if (typeof candidate !== "string" || CONTROL.test(candidate)) throw new TypeError(`runtime-opencode config.environment.${name} must be an environment-resolved string`);
    environment[name] = candidate;
  }
  const minimumVersion = string(
    value.minimumVersion,
    OPEN_CODE_SECURE_SERVER_VERSION,
    "runtime-opencode config.minimumVersion",
  );
  const minimumTuple = versionTuple(minimumVersion);
  if (!versionAtLeast(minimumTuple, versionTuple(OPEN_CODE_SECURE_SERVER_VERSION))) {
    throw new TypeError(
      `runtime-opencode config.minimumVersion must be >=${OPEN_CODE_SECURE_SERVER_VERSION} `
      + "because authenticated tool-free server containment is unavailable below that version",
    );
  }
  if (value.pure !== undefined && value.pure !== true) {
    throw new TypeError("runtime-opencode config.pure must be true because external OpenCode plugins are unsupported");
  }
  return {
    binary: string(value.binary, "opencode", "runtime-opencode config.binary"),
    environment,
    minimumVersion,
    timeoutMs: integer(value.timeoutMs, 600_000, 1_000, 3_600_000, "runtime-opencode config.timeoutMs"),
    maxLineBytes: integer(value.maxLineBytes, 1_048_576, 1_024, 16_777_216, "runtime-opencode config.maxLineBytes"),
    maxStderrBytes: integer(value.maxStderrBytes, 65_536, 1_024, 1_048_576, "runtime-opencode config.maxStderrBytes"),
    pure: true,
  };
}

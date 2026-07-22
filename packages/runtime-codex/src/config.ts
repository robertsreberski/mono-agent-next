import { envEligibleSchema } from "@mono-agent/module-sdk";

export interface RuntimeCodexConfig {
  readonly binary: string;
  readonly auth?: { readonly apiKey: string };
  readonly requestTimeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function strict(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${path}.${key} is not supported`);
}

function text(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL.test(value)) {
    throw new TypeError(`${path} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function integer(value: unknown, fallback: number, min: number, max: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new TypeError(`${path} must be an integer from ${min} through ${max}`);
  }
  return Number(value);
}

export const runtimeCodexJsonSchema = {
  $id: "https://mono-agent.dev/schemas/runtime-codex/v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    binary: { type: "string", minLength: 1 },
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["apiKey"],
      properties: { apiKey: envEligibleSchema({ type: "string", minLength: 1 }, { secret: true }) },
    },
    requestTimeoutMs: { type: "integer", minimum: 1000, maximum: 3600000, default: 600000 },
    maxLineBytes: { type: "integer", minimum: 1024, maximum: 16777216, default: 1048576 },
    maxStderrBytes: { type: "integer", minimum: 1024, maximum: 1048576, default: 65536 },
  },
} as const;

export function parseRuntimeCodexConfig(input: unknown): RuntimeCodexConfig {
  const value = input === undefined ? {} : object(input, "runtime-codex config");
  strict(value, ["binary", "auth", "requestTimeoutMs", "maxLineBytes", "maxStderrBytes"], "runtime-codex config");
  let auth: RuntimeCodexConfig["auth"];
  if (value.auth !== undefined) {
    const candidate = object(value.auth, "runtime-codex config.auth");
    strict(candidate, ["apiKey"], "runtime-codex config.auth");
    auth = { apiKey: text(candidate.apiKey, "", "runtime-codex config.auth.apiKey") };
  }
  return {
    binary: text(value.binary, "codex", "runtime-codex config.binary"),
    ...(auth === undefined ? {} : { auth }),
    requestTimeoutMs: integer(value.requestTimeoutMs, 600_000, 1_000, 3_600_000, "runtime-codex config.requestTimeoutMs"),
    maxLineBytes: integer(value.maxLineBytes, 1_048_576, 1_024, 16_777_216, "runtime-codex config.maxLineBytes"),
    maxStderrBytes: integer(value.maxStderrBytes, 65_536, 1_024, 1_048_576, "runtime-codex config.maxStderrBytes"),
  };
}

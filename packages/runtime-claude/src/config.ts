import { envEligibleSchema } from "@mono-agent/module-sdk";

export type RuntimeClaudeMode = "sdk" | "cli";
export type RuntimeClaudeAuth =
  | { readonly method: "oauth-token"; readonly token: string }
  | { readonly method: "api-key"; readonly token: string };

export interface RuntimeClaudeConfig {
  readonly mode: RuntimeClaudeMode;
  readonly binary: string;
  readonly auth?: RuntimeClaudeAuth;
  readonly timeoutMs: number;
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
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL.test(value)) throw new TypeError(`${path} must be a non-empty trimmed string without control characters`);
  return value;
}

function integer(value: unknown, fallback: number, min: number, max: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${path} must be an integer from ${min} through ${max}`);
  return Number(value);
}

const tokenSchema = envEligibleSchema({ type: "string", minLength: 1 }, { secret: true });

export const runtimeClaudeJsonSchema = {
  $id: "https://mono-agent.dev/schemas/runtime-claude/v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: ["sdk", "cli"], default: "sdk" },
    binary: { type: "string", minLength: 1, default: "claude" },
    auth: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["method", "token"], properties: { method: { const: "oauth-token" }, token: tokenSchema } },
        { type: "object", additionalProperties: false, required: ["method", "token"], properties: { method: { const: "api-key" }, token: tokenSchema } },
      ],
    },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000, default: 600000 },
    maxLineBytes: { type: "integer", minimum: 1024, maximum: 16777216, default: 1048576 },
    maxStderrBytes: { type: "integer", minimum: 1024, maximum: 1048576, default: 65536 },
  },
} as const;

export function parseRuntimeClaudeConfig(input: unknown): RuntimeClaudeConfig {
  const value = input === undefined ? {} : object(input, "runtime-claude config");
  strict(value, ["mode", "binary", "auth", "timeoutMs", "maxLineBytes", "maxStderrBytes"], "runtime-claude config");
  if (value.mode !== undefined && value.mode !== "sdk" && value.mode !== "cli") throw new TypeError("runtime-claude config.mode must be sdk or cli");
  let auth: RuntimeClaudeAuth | undefined;
  if (value.auth !== undefined) {
    const candidate = object(value.auth, "runtime-claude config.auth");
    strict(candidate, ["method", "token"], "runtime-claude config.auth");
    if (candidate.method !== "oauth-token" && candidate.method !== "api-key") throw new TypeError("runtime-claude config.auth.method is invalid");
    auth = { method: candidate.method, token: text(candidate.token, "", "runtime-claude config.auth.token") };
  }
  return {
    mode: value.mode ?? "sdk",
    binary: text(value.binary, "claude", "runtime-claude config.binary"),
    ...(auth === undefined ? {} : { auth }),
    timeoutMs: integer(value.timeoutMs, 600_000, 1_000, 3_600_000, "runtime-claude config.timeoutMs"),
    maxLineBytes: integer(value.maxLineBytes, 1_048_576, 1_024, 16_777_216, "runtime-claude config.maxLineBytes"),
    maxStderrBytes: integer(value.maxStderrBytes, 65_536, 1_024, 1_048_576, "runtime-claude config.maxStderrBytes"),
  };
}

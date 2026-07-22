export const DEFAULT_PI_AUTH_PATH = "~/.pi/agent/auth.json";

export interface RuntimePiModelConfig {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface RuntimePiLocalProviderConfig {
  readonly id: string;
  readonly baseUrl: string;
  readonly models?: readonly RuntimePiModelConfig[];
}

export interface RuntimePiConfig {
  readonly auth: {
    readonly path: string;
  };
  readonly sessions?: {
    readonly root?: string;
  };
  readonly retry: {
    readonly maxRetries: number;
    readonly maxDelayMs: number;
    readonly timeoutMs: number;
  };
  readonly localProviders: readonly RuntimePiLocalProviderConfig[];
}

export const runtimePiJsonSchema = {
  $id: "https://mono-agent.dev/schemas/runtime-pi/v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    auth: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: envEligibleSchema({ type: "string", minLength: 1 }),
      },
    },
    sessions: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: envEligibleSchema({ type: "string", minLength: 1 }),
      },
    },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxRetries: { type: "integer", minimum: 0, maximum: 10, default: 2 },
        maxDelayMs: { type: "integer", minimum: 0, maximum: 60_000, default: 60_000 },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 3_600_000, default: 600_000 },
      },
    },
    localProviders: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "baseUrl"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
          baseUrl: { type: "string", minLength: 1, format: "uri" },
          models: {
            type: "array",
            minItems: 1,
            maxItems: 10_000,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                name: { type: "string", minLength: 1, maxLength: 256 },
                reasoning: { type: "boolean", default: false },
                input: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: { enum: ["text", "image"] },
                  default: ["text"],
                },
                contextWindow: { type: "integer", minimum: 1, maximum: 10_000_000 },
                maxTokens: { type: "integer", minimum: 1, maximum: 1_000_000 },
              },
            },
          },
        },
      },
    },
  },
} as const;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function fail(path: string, message: string): never {
  throw new TypeError(`runtime-pi config ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL_CHARACTER.test(value)) {
    fail(path, "must be a non-empty, trimmed string without control characters");
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function parseModel(value: unknown, path: string): RuntimePiModelConfig {
  const model = objectAt(value, path);
  rejectUnknown(model, ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"], path);
  const id = optionalString(model.id, `${path}.id`);
  if (id === undefined) fail(`${path}.id`, "is required");
  if (id.length > 256) fail(`${path}.id`, "must contain at most 256 characters");
  const name = optionalString(model.name, `${path}.name`);
  if (name !== undefined && name.length > 256) fail(`${path}.name`, "must contain at most 256 characters");
  if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
    fail(`${path}.reasoning`, "must be a boolean");
  }
  let input: readonly ("text" | "image")[] | undefined;
  if (model.input !== undefined) {
    if (!Array.isArray(model.input) || model.input.length === 0) fail(`${path}.input`, "must be a non-empty array");
    const values = model.input.map((entry, index) => {
      if (entry !== "text" && entry !== "image") fail(`${path}.input[${index}]`, "must be text or image");
      return entry;
    });
    if (new Set(values).size !== values.length) fail(`${path}.input`, "must not contain duplicates");
    input = values;
  }
  const contextWindow = model.contextWindow === undefined
    ? undefined
    : boundedInteger(model.contextWindow, 0, 1, 10_000_000, `${path}.contextWindow`);
  const maxTokens = model.maxTokens === undefined
    ? undefined
    : boundedInteger(model.maxTokens, 0, 1, 1_000_000, `${path}.maxTokens`);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(input === undefined ? {} : { input }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function parseLocalProvider(value: unknown, index: number): RuntimePiLocalProviderConfig {
  const path = `$.localProviders[${index}]`;
  const provider = objectAt(value, path);
  rejectUnknown(provider, ["id", "baseUrl", "models"], path);
  const providerId = optionalString(provider.id, `${path}.id`);
  if (providerId === undefined) fail(`${path}.id`, "is required");
  if (!PROVIDER_ID.test(providerId)) fail(path, "provider id must match ^[a-z][a-z0-9-]{0,63}$");
  const baseUrl = optionalString(provider.baseUrl, `${path}.baseUrl`);
  if (baseUrl === undefined) fail(`${path}.baseUrl`, "is required");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    fail(`${path}.baseUrl`, "must be an absolute URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    fail(`${path}.baseUrl`, "must use http or https");
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    fail(`${path}.baseUrl`, "must not contain URL credentials");
  }
  if (!isLiteralLoopback(parsedUrl.hostname)) {
    fail(`${path}.baseUrl`, "must use a literal loopback host; authenticated remote providers are not in this slice");
  }
  if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.length === 0)) {
    fail(`${path}.models`, "must be a non-empty array when provided");
  }
  if (Array.isArray(provider.models) && provider.models.length > 10_000) {
    fail(`${path}.models`, "must contain at most 10000 models");
  }
  const models = provider.models === undefined
    ? undefined
    : (provider.models as unknown[]).map((model, modelIndex) => parseModel(model, `${path}.models[${modelIndex}]`));
  const ids = new Set<string>();
  for (const model of models ?? []) {
    if (ids.has(model.id)) fail(`${path}.models`, `contains duplicate model id ${JSON.stringify(model.id)}`);
    ids.add(model.id);
  }
  return {
    id: providerId,
    baseUrl: parsedUrl.toString().replace(/\/$/, ""),
    ...(models === undefined ? {} : { models }),
  };
}

export function isLiteralLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function parseRuntimePiConfig(input: unknown): RuntimePiConfig {
  const config = input === undefined ? {} : objectAt(input, "$");
  rejectUnknown(config, ["auth", "sessions", "retry", "localProviders"], "$");

  const auth = config.auth === undefined ? {} : objectAt(config.auth, "$.auth");
  rejectUnknown(auth, ["path"], "$.auth");
  const authPath = optionalString(auth.path, "$.auth.path") ?? DEFAULT_PI_AUTH_PATH;

  let sessions: RuntimePiConfig["sessions"];
  if (config.sessions !== undefined) {
    const value = objectAt(config.sessions, "$.sessions");
    rejectUnknown(value, ["root"], "$.sessions");
    const root = optionalString(value.root, "$.sessions.root");
    sessions = root === undefined ? {} : { root };
  }

  const retry = config.retry === undefined ? {} : objectAt(config.retry, "$.retry");
  rejectUnknown(retry, ["maxRetries", "maxDelayMs", "timeoutMs"], "$.retry");

  if (config.localProviders !== undefined && !Array.isArray(config.localProviders)) {
    fail("$.localProviders", "must be an array");
  }
  if (Array.isArray(config.localProviders) && config.localProviders.length > 64) {
    fail("$.localProviders", "must contain at most 64 providers");
  }
  const localProviders = (config.localProviders ?? []) as unknown[];
  const parsedLocalProviders = localProviders.map((provider, index) => parseLocalProvider(provider, index));
  const providerIds = new Set<string>();
  for (const provider of parsedLocalProviders) {
    if (providerIds.has(provider.id)) {
      fail("$.localProviders", `contains duplicate provider id ${JSON.stringify(provider.id)}`);
    }
    providerIds.add(provider.id);
  }

  return {
    auth: { path: authPath },
    ...(sessions === undefined ? {} : { sessions }),
    retry: {
      maxRetries: boundedInteger(retry.maxRetries, 2, 0, 10, "$.retry.maxRetries"),
      maxDelayMs: boundedInteger(retry.maxDelayMs, 60_000, 0, 60_000, "$.retry.maxDelayMs"),
      timeoutMs: boundedInteger(retry.timeoutMs, 600_000, 1_000, 3_600_000, "$.retry.timeoutMs"),
    },
    localProviders: parsedLocalProviders,
  };
}

export function parsePiModelReference(reference: string): { provider: string; model: string } {
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new TypeError("runtime-pi model must use provider:model");
  }
  const provider = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  if (!PROVIDER_ID.test(provider) || model.trim() !== model || CONTROL_CHARACTER.test(model)) {
    throw new TypeError("runtime-pi model must use a valid provider id and non-empty model id");
  }
  return { provider, model };
}
import { envEligibleSchema } from "@mono-agent/module-sdk";

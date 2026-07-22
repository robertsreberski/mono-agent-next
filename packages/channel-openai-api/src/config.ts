import { isIP } from "node:net";

import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_OPENAI_API_HOST = "127.0.0.1";
export const DEFAULT_OPENAI_API_PORT = 0;
export const DEFAULT_OPENAI_API_BASE_PATH = "/v1";
export const DEFAULT_OPENAI_API_MODEL_ID = "mono-agent";
export const DEFAULT_OPENAI_API_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_OPENAI_API_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_OPENAI_API_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OPENAI_API_MAX_RUN_MS = 20 * 60 * 1_000;

export interface OpenAiApiConfig {
  readonly listen: { readonly host: string; readonly port: number };
  /** Resolved env-only secret. */
  readonly apiKey: string;
  readonly basePath: string;
  readonly modelId: string;
  readonly maxBodyBytes: number;
  readonly maxImageBytes: number;
  readonly maxResponseBytes: number;
  readonly maxRunMs: number;
}

export class OpenAiApiConfigError extends Error {
  readonly code = "invalid_openai_api_config";
  constructor(message: string) { super(message); this.name = "OpenAiApiConfigError"; }
}

export function parseOpenAiApiConfig(value: unknown): OpenAiApiConfig {
  const input = record(value, "OpenAI API channel config");
  exact(input, ["listen", "apiKey", "basePath", "modelId", "maxBodyBytes", "maxImageBytes", "maxResponseBytes", "maxRunMs"], "OpenAI API channel config");
  const listenInput = input.listen === undefined ? {} : record(input.listen, "listen");
  exact(listenInput, ["host", "port"], "listen");
  const host = text(listenInput.host, "listen.host", DEFAULT_OPENAI_API_HOST, 253);
  if (!isLoopbackHost(host) || host.includes("/") || host.includes("\\") || host.includes("://")) fail("listen.host must be a loopback hostname or address.");
  if (typeof input.apiKey !== "string") fail("apiKey must be a resolved env-only secret.");
  const apiKey = text(input.apiKey, "apiKey", undefined, 4_096);
  if (apiKey.length < 20 || /\s/u.test(apiKey)) fail("apiKey must be a resolved 20-4096 character env-only secret.");
  const basePath = path(input.basePath);
  const modelId = text(input.modelId, "modelId", DEFAULT_OPENAI_API_MODEL_ID, 256);
  if (/\s/u.test(modelId)) fail("modelId must not contain whitespace.");
  return Object.freeze({
    listen: Object.freeze({ host, port: integer(listenInput.port, "listen.port", DEFAULT_OPENAI_API_PORT, 0, 65_535) }),
    apiKey,
    basePath,
    modelId,
    maxBodyBytes: integer(input.maxBodyBytes, "maxBodyBytes", DEFAULT_OPENAI_API_MAX_BODY_BYTES, 1, 8 * 1024 * 1024),
    maxImageBytes: integer(input.maxImageBytes, "maxImageBytes", DEFAULT_OPENAI_API_MAX_IMAGE_BYTES, 1, 20 * 1024 * 1024),
    maxResponseBytes: integer(input.maxResponseBytes, "maxResponseBytes", DEFAULT_OPENAI_API_MAX_RESPONSE_BYTES, 4_096, 32 * 1024 * 1024),
    maxRunMs: integer(input.maxRunMs, "maxRunMs", DEFAULT_OPENAI_API_MAX_RUN_MS, 1, 24 * 60 * 60 * 1_000),
  });
}

export const openAiApiConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["apiKey"],
    properties: {
      listen: { type: "object", additionalProperties: false, properties: { host: { type: "string", default: DEFAULT_OPENAI_API_HOST }, port: { type: "integer", minimum: 0, maximum: 65_535, default: DEFAULT_OPENAI_API_PORT } } },
      apiKey: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096 }, { secret: true }),
      basePath: { type: "string", default: DEFAULT_OPENAI_API_BASE_PATH },
      modelId: { type: "string", default: DEFAULT_OPENAI_API_MODEL_ID },
      maxBodyBytes: { type: "integer", minimum: 1, maximum: 8 * 1024 * 1024, default: DEFAULT_OPENAI_API_MAX_BODY_BYTES },
      maxImageBytes: { type: "integer", minimum: 1, maximum: 20 * 1024 * 1024, default: DEFAULT_OPENAI_API_MAX_IMAGE_BYTES },
      maxResponseBytes: { type: "integer", minimum: 4_096, maximum: 32 * 1024 * 1024, default: DEFAULT_OPENAI_API_MAX_RESPONSE_BYTES },
      maxRunMs: { type: "integer", minimum: 1, maximum: 24 * 60 * 60 * 1_000, default: DEFAULT_OPENAI_API_MAX_RUN_MS },
    },
  }),
  parse: parseOpenAiApiConfig,
});

export function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host === "::1") return true;
  if (host.startsWith("::ffff:")) return isLoopbackHost(host.slice(7));
  return isIP(host) === 4 && host.startsWith("127.");
}

function path(value: unknown): string { const result = text(value, "basePath", DEFAULT_OPENAI_API_BASE_PATH, 256); if (!result.startsWith("/") || result.startsWith("//") || result.includes("\\") || result.includes("?") || result.includes("#") || result.includes("%") || /\s/u.test(result) || result.split("/").some((part) => part === "." || part === "..")) fail("basePath must be one absolute origin-form path without whitespace, escapes, dot segments, query, or fragment."); return result.length > 1 && result.endsWith("/") ? result.slice(0, -1) : result; }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`); const prototype = Object.getPrototypeOf(value) as unknown; if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void { const allowed = new Set(fields); const unknown = Object.keys(value).filter((field) => !allowed.has(field)).sort(); if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(", ")}.`); }
function text(value: unknown, label: string, fallback: string | undefined, maximum: number): string { if (value === undefined && fallback !== undefined) return fallback; if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must be a non-empty string of at most ${maximum} characters.`); return value as string; }
function integer(value: unknown, label: string, fallback: number, min: number, max: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} must be an integer from ${min} through ${max}.`); return value as number; }
function fail(message: string): never { throw new OpenAiApiConfigError(message); }

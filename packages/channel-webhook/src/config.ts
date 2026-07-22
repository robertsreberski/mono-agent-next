import { isIP } from "node:net";

import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_WEBHOOK_HOST = "127.0.0.1";
export const DEFAULT_WEBHOOK_PORT = 0;
export const DEFAULT_WEBHOOK_PATH = "/webhook/invoke";
export const DEFAULT_WEBHOOK_MODE = "sync";
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_MAX_RUN_MS = 20 * 60 * 1_000;
export const DEFAULT_RETENTION_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_STORED_REQUESTS = 100;

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_RUN_MS = 24 * 60 * 60 * 1_000;
export const MAX_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_STORED_REQUESTS = 10_000;

export type WebhookMode = "sync" | "async";

export interface WebhookListenConfig {
  readonly host: string;
  readonly port: number;
}

export interface WebhookConfig {
  readonly listen: WebhookListenConfig;
  /** Resolved secret. Public config accepts only the SDK-owned {$env} directive. */
  readonly apiKey: string;
  readonly path: string;
  readonly mode: WebhookMode;
  readonly maxBodyBytes: number;
  readonly maxRunMs: number;
  readonly retentionMs: number;
  readonly maxStoredRequests: number;
}

export class WebhookConfigError extends Error {
  readonly code = "invalid_webhook_config";

  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

const CONFIG_KEYS = new Set([
  "listen",
  "apiKey",
  "path",
  "mode",
  "maxBodyBytes",
  "maxRunMs",
  "retentionMs",
  "maxStoredRequests",
]);

export function parseWebhookConfig(value: unknown): WebhookConfig {
  const input = readRecord(value, "Webhook channel config");
  rejectUnknownKeys(input, CONFIG_KEYS, "Webhook channel config");

  const listen = parseListen(input.listen);
  const apiKey = parseApiKey(input.apiKey);
  const path = parsePath(input.path);
  const mode = parseMode(input.mode);
  const maxBodyBytes = readBoundedInteger(
    input.maxBodyBytes,
    "maxBodyBytes",
    DEFAULT_MAX_BODY_BYTES,
    1,
    MAX_BODY_BYTES,
  );
  const maxRunMs = readBoundedInteger(
    input.maxRunMs,
    "maxRunMs",
    DEFAULT_MAX_RUN_MS,
    1,
    MAX_RUN_MS,
  );
  const retentionMs = readBoundedInteger(
    input.retentionMs,
    "retentionMs",
    DEFAULT_RETENTION_MS,
    1,
    MAX_RETENTION_MS,
  );
  const maxStoredRequests = readBoundedInteger(
    input.maxStoredRequests,
    "maxStoredRequests",
    DEFAULT_MAX_STORED_REQUESTS,
    1,
    MAX_STORED_REQUESTS,
  );

  if (!isLoopbackHost(listen.host)) {
    throw new WebhookConfigError(
      "listen.host must be loopback for the HTTP-only webhook channel.",
    );
  }

  return {
    listen,
    apiKey,
    path,
    mode,
    maxBodyBytes,
    maxRunMs,
    retentionMs,
    maxStoredRequests,
  };
}

export const webhookConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      listen: {
        type: "object",
        additionalProperties: false,
        properties: {
          host: { type: "string", default: DEFAULT_WEBHOOK_HOST },
          port: { type: "integer", minimum: 0, maximum: 65_535, default: DEFAULT_WEBHOOK_PORT },
        },
      },
      apiKey: envEligibleSchema({
        type: "string",
        minLength: 1,
        maxLength: 4_096,
        pattern: "^\\S+$",
      }, { secret: true }),
      path: { type: "string", default: DEFAULT_WEBHOOK_PATH },
      mode: { enum: ["sync", "async"], default: DEFAULT_WEBHOOK_MODE },
      maxBodyBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_BODY_BYTES,
        default: DEFAULT_MAX_BODY_BYTES,
      },
      maxRunMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RUN_MS,
        default: DEFAULT_MAX_RUN_MS,
      },
      retentionMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RETENTION_MS,
        default: DEFAULT_RETENTION_MS,
      },
      maxStoredRequests: {
        type: "integer",
        minimum: 1,
        maximum: MAX_STORED_REQUESTS,
        default: DEFAULT_MAX_STORED_REQUESTS,
      },
    },
    required: ["apiKey"],
  }),
  parse: parseWebhookConfig,
});

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHost(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  const firstOctet = Number.parseInt(normalized.split(".", 1)[0] ?? "", 10);
  return firstOctet === 127;
}

function parseListen(value: unknown): WebhookListenConfig {
  if (value === undefined) {
    return { host: DEFAULT_WEBHOOK_HOST, port: DEFAULT_WEBHOOK_PORT };
  }
  const input = readRecord(value, "listen");
  rejectUnknownKeys(input, new Set(["host", "port"]), "listen");
  const host = readString(input.host, "listen.host", DEFAULT_WEBHOOK_HOST);
  if (
    host.length > 253 ||
    host.includes("://") ||
    host.includes("/") ||
    host.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(host)
  ) {
    throw new WebhookConfigError("listen.host must be a hostname or IP address without a scheme or path.");
  }
  const port = readBoundedInteger(input.port, "listen.port", DEFAULT_WEBHOOK_PORT, 0, 65_535);
  return { host, port };
}

function parseApiKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /\s/u.test(value)) {
    throw new WebhookConfigError(
      "apiKey is required and must be a resolved non-empty bearer token supplied through the public {$env} directive.",
    );
  }
  return value;
}

function parsePath(value: unknown): string {
  const path = readString(value, "path", DEFAULT_WEBHOOK_PATH);
  if (
    path.length > 1_024 ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new WebhookConfigError("path must be an absolute HTTP path without a query or fragment.");
  }
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WebhookConfigError("path must not contain dot segments.");
  }
  return normalized;
}

function parseMode(value: unknown): WebhookMode {
  if (value === undefined) {
    return DEFAULT_WEBHOOK_MODE;
  }
  if (value !== "sync" && value !== "async") {
    throw new WebhookConfigError('mode must be either "sync" or "async".');
  }
  return value;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined && field === "Webhook channel config") {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebhookConfigError(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WebhookConfigError(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new WebhookConfigError(`${field} contains unknown field(s): ${unknown.join(", ")}.`);
  }
}

function readString(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new WebhookConfigError(`${field} must be a non-empty string without surrounding whitespace.`);
  }
  return value;
}

function readBoundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WebhookConfigError(`${field} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return value as number;
}

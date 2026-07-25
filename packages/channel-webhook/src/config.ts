// SPDX-License-Identifier: MIT
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
  readonly allowNonLoopback: boolean;
  /** Resolved secret. Public config accepts only the SDK-owned {$env} directive. */
  readonly apiKey: string;
  /** Optional resolved HMAC-SHA256 secret required in addition to bearer auth. */
  readonly signatureSecret?: string;
  /** Directory-backed routes replace the legacy single `path` route when set. */
  readonly routesDirectory?: string;
  readonly path: string;
  readonly defaultMode: WebhookMode;
  /** Source-compatible alias for defaultMode. */
  readonly mode: WebhookMode;
  readonly maxBodyBytes: number;
  readonly maxRunMs: number;
  readonly retentionMs: number;
  readonly maxStoredRequests: number;
  readonly outbound?: WebhookOutboundConfig;
}

export interface WebhookOutboundConfig {
  readonly url: string;
  readonly apiKey?: string;
  readonly signatureSecret?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
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
  "allowNonLoopback",
  "apiKey",
  "signatureSecret",
  "routesDirectory",
  "path",
  "defaultMode",
  "mode",
  "maxBodyBytes",
  "maxRunMs",
  "retentionMs",
  "maxStoredRequests",
  "outbound",
]);

export function parseWebhookConfig(value: unknown): WebhookConfig {
  const input = readRecord(value, "Webhook channel config");
  rejectUnknownKeys(input, CONFIG_KEYS, "Webhook channel config");

  const listen = parseListen(input.listen);
  const allowNonLoopback = readBoolean(input.allowNonLoopback, "allowNonLoopback", false);
  const apiKey = parseApiKey(input.apiKey);
  const signatureSecret = parseOptionalSecret(input.signatureSecret, "signatureSecret");
  const routesDirectory = parseRoutesDirectory(input.routesDirectory);
  if (routesDirectory !== undefined && input.path !== undefined) {
    throw new WebhookConfigError("routesDirectory and the legacy single-route path cannot be configured together.");
  }
  if (input.defaultMode !== undefined && input.mode !== undefined) {
    throw new WebhookConfigError("defaultMode and the legacy mode alias cannot be configured together.");
  }
  const path = parsePath(input.path);
  const defaultMode = parseMode(input.defaultMode ?? input.mode);
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

  if (!isLoopbackHost(listen.host) && !allowNonLoopback) {
    throw new WebhookConfigError(
      "listen.host must be loopback unless allowNonLoopback is explicitly true.",
    );
  }
  if (!isLoopbackHost(listen.host) && (apiKey.length < 32 || (signatureSecret?.length ?? 0) < 32)) {
    throw new WebhookConfigError("A non-loopback webhook listener requires bearer and signature secrets of at least 32 characters.");
  }
  const outbound = parseOutbound(input.outbound);

  return Object.freeze({
    listen: Object.freeze(listen),
    allowNonLoopback,
    apiKey,
    ...(signatureSecret === undefined ? {} : { signatureSecret }),
    ...(routesDirectory === undefined ? {} : { routesDirectory }),
    path,
    defaultMode,
    mode: defaultMode,
    maxBodyBytes,
    maxRunMs,
    retentionMs,
    maxStoredRequests,
    ...(outbound === undefined ? {} : { outbound }),
  });
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
      allowNonLoopback: { type: "boolean", default: false },
      apiKey: envEligibleSchema({
        type: "string",
        minLength: 1,
        maxLength: 4_096,
        pattern: "^\\S+$",
      }, { secret: true }),
      signatureSecret: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096 }, { secret: true }),
      routesDirectory: {
        type: "string",
        minLength: 1,
        maxLength: 1_024,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\u0000-\\u001f\\u007f]).+$",
      },
      path: { type: "string", default: DEFAULT_WEBHOOK_PATH },
      defaultMode: { enum: ["sync", "async"], default: DEFAULT_WEBHOOK_MODE },
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
      outbound: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          apiKey: envEligibleSchema({ type: "string", minLength: 1, maxLength: 4_096 }, { secret: true }),
          signatureSecret: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096 }, { secret: true }),
          timeoutMs: { type: "integer", minimum: 1, maximum: 60_000, default: 10_000 },
          maxResponseBytes: { type: "integer", minimum: 1, maximum: 1024 * 1024, default: 256 * 1024 },
        },
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

function parseOptionalSecret(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 20 || value.length > 4_096 || /\s/u.test(value)) {
    throw new WebhookConfigError(`${field} must be a resolved 20-4096 character env-only secret.`);
  }
  return value;
}

function parseOutbound(value: unknown): WebhookOutboundConfig | undefined {
  if (value === undefined) return undefined;
  const input = readRecord(value, "outbound");
  rejectUnknownKeys(input, new Set(["url", "apiKey", "signatureSecret", "timeoutMs", "maxResponseBytes"]), "outbound");
  const urlText = readString(input.url, "outbound.url");
  let url: URL;
  try { url = new URL(urlText); } catch { throw new WebhookConfigError("outbound.url must be an absolute URL."); }
  if (url.username !== "" || url.password !== "" || url.hash !== "" || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
    throw new WebhookConfigError("outbound.url must use HTTPS, or HTTP on loopback, without credentials or a fragment.");
  }
  const apiKey = input.apiKey === undefined ? undefined : parseApiKey(input.apiKey);
  const signatureSecret = parseOptionalSecret(input.signatureSecret, "outbound.signatureSecret");
  if (apiKey === undefined && signatureSecret === undefined) throw new WebhookConfigError("outbound requires apiKey or signatureSecret authentication.");
  return Object.freeze({
    url: url.toString(),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(signatureSecret === undefined ? {} : { signatureSecret }),
    timeoutMs: readBoundedInteger(input.timeoutMs, "outbound.timeoutMs", 10_000, 1, 60_000),
    maxResponseBytes: readBoundedInteger(input.maxResponseBytes, "outbound.maxResponseBytes", 256 * 1024, 1, 1024 * 1024),
  });
}

export function parseWebhookPath(value: unknown): string {
  const path = readString(value, "path", DEFAULT_WEBHOOK_PATH);
  if (
    path.length > 1_024 ||
    path === "/" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("%") ||
    path.includes("?") ||
    path.includes("#") ||
    /\s|[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new WebhookConfigError("path must be one absolute origin-form HTTP path without escapes, whitespace, a query, or a fragment.");
  }
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WebhookConfigError("path must not contain dot segments.");
  }
  return normalized;
}

export function parseWebhookMode(value: unknown): WebhookMode {
  if (value === undefined) {
    return DEFAULT_WEBHOOK_MODE;
  }
  if (value !== "sync" && value !== "async") {
    throw new WebhookConfigError('mode must be either "sync" or "async".');
  }
  return value;
}

function parsePath(value: unknown): string {
  return parseWebhookPath(value);
}

function parseMode(value: unknown): WebhookMode {
  return parseWebhookMode(value);
}

function parseRoutesDirectory(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const path = readString(value, "routesDirectory");
  if (path.length > 1_024
    || path.startsWith("/")
    || path.startsWith("\\")
    || path.includes("\\")
    || /^[A-Za-z]:[\\/]/u.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.replace(/\\/gu, "/").split("/").some((segment) => segment === "..")) {
    throw new WebhookConfigError("routesDirectory must be a bounded path relative to the agent config directory.");
  }
  return path;
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

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new WebhookConfigError(`${field} must be a boolean.`);
  return value;
}

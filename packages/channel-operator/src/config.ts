// SPDX-License-Identifier: MIT
import { isIP } from "node:net";

import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_OPERATOR_HOST = "127.0.0.1";
export const DEFAULT_OPERATOR_PORT = 0;
export const MIN_OPERATOR_TOKEN_BYTES = 32;
export const MAX_OPERATOR_TOKEN_BYTES = 4_096;

export interface OperatorListenConfig {
  readonly host: string;
  readonly port: number;
}

export interface OperatorAuthConfig {
  /** Resolved secret. Public config accepts only the SDK-owned {$env} directive. */
  readonly token: string;
}

export interface OperatorChannelConfig {
  readonly listen: OperatorListenConfig;
  readonly auth: OperatorAuthConfig;
}

export class OperatorChannelConfigError extends Error {
  readonly code = "invalid_operator_channel_config";

  constructor(message: string) {
    super(message);
    this.name = "OperatorChannelConfigError";
  }
}

const CONFIG_KEYS = new Set(["listen", "auth"]);
const LISTEN_KEYS = new Set(["host", "port"]);
const AUTH_KEYS = new Set(["token"]);

export function parseOperatorChannelConfig(value: unknown): OperatorChannelConfig {
  const input = readRecord(value, "Operator channel config");
  rejectUnknownKeys(input, CONFIG_KEYS, "Operator channel config");
  const listen = parseListen(input.listen);
  const auth = parseAuth(input.auth);

  if (!isLoopbackHost(listen.host)) {
    throw new OperatorChannelConfigError("listen.host must resolve only to the loopback interface.");
  }

  return Object.freeze({
    listen: Object.freeze(listen),
    auth: Object.freeze(auth),
  });
}

export const operatorChannelConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      listen: {
        type: "object",
        additionalProperties: false,
        properties: {
          host: { type: "string", default: DEFAULT_OPERATOR_HOST },
          port: { type: "integer", minimum: 0, maximum: 65_535, default: DEFAULT_OPERATOR_PORT },
        },
      },
      auth: {
        type: "object",
        additionalProperties: false,
        properties: {
          token: envEligibleSchema({
            type: "string",
            minLength: MIN_OPERATOR_TOKEN_BYTES,
            maxLength: MAX_OPERATOR_TOKEN_BYTES,
            pattern: "^\\S+$",
          }, { secret: true }),
        },
        required: ["token"],
      },
    },
    required: ["auth"],
  }),
  parse: parseOperatorChannelConfig,
});

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHost(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) !== 4) return false;
  return Number.parseInt(normalized.split(".", 1)[0] ?? "", 10) === 127;
}

function parseListen(value: unknown): OperatorListenConfig {
  if (value === undefined) {
    return { host: DEFAULT_OPERATOR_HOST, port: DEFAULT_OPERATOR_PORT };
  }
  const input = readRecord(value, "listen");
  rejectUnknownKeys(input, LISTEN_KEYS, "listen");
  const host = input.host === undefined ? DEFAULT_OPERATOR_HOST : readString(input.host, "listen.host");
  if (host === "[::1]") {
    throw new OperatorChannelConfigError(
      "listen.host must use the unbracketed IPv6 loopback literal ::1, not [::1].",
    );
  }
  if (
    host.length > 253
    || host.includes("://")
    || host.includes("/")
    || host.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(host)
  ) {
    throw new OperatorChannelConfigError("listen.host must be a hostname or IP address without a scheme or path.");
  }
  const port = input.port === undefined ? DEFAULT_OPERATOR_PORT : readPort(input.port);
  return { host, port };
}

function parseAuth(value: unknown): OperatorAuthConfig {
  const input = readRecord(value, "auth");
  rejectUnknownKeys(input, AUTH_KEYS, "auth");
  if (typeof input.token !== "string") {
    throw new OperatorChannelConfigError(
      "auth.token is required and must be a resolved bearer token supplied through the public {$env} directive.",
    );
  }
  const byteLength = Buffer.byteLength(input.token, "utf8");
  if (
    input.token !== input.token.trim()
    || /\s/u.test(input.token)
    || input.token.length < MIN_OPERATOR_TOKEN_BYTES
    || byteLength < MIN_OPERATOR_TOKEN_BYTES
    || byteLength > MAX_OPERATOR_TOKEN_BYTES
  ) {
    throw new OperatorChannelConfigError(
      `auth.token must be a ${String(MIN_OPERATOR_TOKEN_BYTES)}-${String(MAX_OPERATOR_TOKEN_BYTES)} byte non-whitespace bearer token.`,
    );
  }
  return { token: input.token };
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OperatorChannelConfigError(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OperatorChannelConfigError(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new OperatorChannelConfigError(`${field} contains unknown field(s): ${unknown.join(", ")}.`);
  }
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new OperatorChannelConfigError(`${field} must be a non-empty string without surrounding whitespace.`);
  }
  return value;
}

function readPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 65_535) {
    throw new OperatorChannelConfigError("listen.port must be an integer from 0 through 65535.");
  }
  return value as number;
}

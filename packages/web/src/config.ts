import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { WebProductError } from "./errors.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_PORT = 5050;

/** JSON Schema for the independently owned `web.config.json` file. */
export const webConfigJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mono-agent.dev/schemas/web.config.schema.json",
  title: "mono-agent web product config",
  type: "object",
  additionalProperties: false,
  required: ["configVersion", "auth"],
  properties: {
    $schema: { type: "string" },
    configVersion: { const: 1 },
    listen: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "integer", minimum: 0, maximum: 65_535, default: DEFAULT_PORT },
      },
    },
    auth: {
      description: "Bearer token policy, or explicit unauthenticated operation with mode: none.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: {
            token: {
              type: "object",
              additionalProperties: false,
              required: ["$env"],
              properties: { $env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: {
            mode: { const: "none" },
          },
        },
      ],
    },
    allowInsecureHttp: {
      type: "boolean",
      default: false,
      description: "Explicitly allow token-mode plaintext HTTP on a non-loopback trusted network.",
    },
    dataDirectory: { type: "string", default: "./.mono-agent/web" },
    agentRegistries: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      default: ["./.mono-agent/trace-sources"],
    },
    externalOrigins: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        format: "uri",
        pattern: "^https://",
      },
      default: [],
      description: "Exact HTTPS reverse-proxy origins accepted as trusted browser authorities.",
    },
  },
} as const);

export interface WebListenConfig {
  readonly host: string;
  readonly port: number;
}

export interface WebConfig {
  readonly configVersion: 1;
  readonly listen: WebListenConfig;
  readonly auth:
    | { readonly token: string }
    | { readonly mode: "none" };
  readonly allowInsecureHttp: boolean;
  readonly dataDirectory: string;
  readonly agentRegistries: readonly string[];
  readonly externalOrigins: readonly string[];
  readonly sourcePath: string;
}

export interface LoadWebConfigOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function loadWebConfig(
  configPath: string,
  options: LoadWebConfigOptions = {},
): Promise<WebConfig> {
  const sourcePath = resolve(configPath);
  let source: string;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new WebProductError("config_read_failed", `Cannot read web config at ${sourcePath}: ${message(error)}`);
  }
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) {
    throw new WebProductError("config_too_large", "Web config exceeds the 1 MiB limit.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (error) {
    throw new WebProductError("invalid_config", `Web config is not valid JSON: ${message(error)}`);
  }
  return parseWebConfig(raw, {
    sourcePath,
    environment: options.environment ?? process.env,
  });
}

export interface ParseWebConfigOptions {
  readonly sourcePath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export function parseWebConfig(raw: unknown, options: ParseWebConfigOptions): WebConfig {
  const root = object(raw, "$", [
    "$schema",
    "configVersion",
    "listen",
    "auth",
    "allowInsecureHttp",
    "dataDirectory",
    "agentRegistries",
    "externalOrigins",
  ]);
  if (root.configVersion !== 1) invalid("$.configVersion", "must equal 1");
  if (root.$schema !== undefined && typeof root.$schema !== "string") invalid("$.$schema", "must be a string");

  const listen = root.listen === undefined
    ? { host: "127.0.0.1", port: DEFAULT_PORT }
    : parseListen(root.listen);
  const auth = parseAuth(root.auth, options.environment ?? process.env);
  if (root.allowInsecureHttp !== undefined && typeof root.allowInsecureHttp !== "boolean") {
    invalid("$.allowInsecureHttp", "must be a boolean");
  }

  const baseDirectory = dirname(resolve(options.sourcePath));
  const dataDirectory = root.dataDirectory === undefined
    ? resolve(baseDirectory, ".mono-agent", "web")
    : resolvePath(root.dataDirectory, "$.dataDirectory", baseDirectory);
  const registries = root.agentRegistries === undefined
    ? [resolve(baseDirectory, ".mono-agent", "trace-sources")]
    : stringArray(root.agentRegistries, "$.agentRegistries").map((path, index) =>
        resolvePath(path, `$.agentRegistries[${index}]`, baseDirectory));
  if (registries.length === 0) invalid("$.agentRegistries", "must contain at least one directory");
  const externalOrigins = root.externalOrigins === undefined
    ? []
    : stringArray(root.externalOrigins, "$.externalOrigins").map((origin, index) =>
        externalOrigin(origin, `$.externalOrigins[${index}]`));
  if (new Set(externalOrigins).size !== externalOrigins.length) {
    invalid("$.externalOrigins", "must not contain duplicates");
  }

  return Object.freeze({
    configVersion: 1,
    listen: Object.freeze(listen),
    auth,
    allowInsecureHttp: root.allowInsecureHttp === true,
    dataDirectory,
    agentRegistries: Object.freeze(registries),
    externalOrigins: Object.freeze(externalOrigins),
    sourcePath: resolve(options.sourcePath),
  });
}

function parseAuth(
  raw: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): WebConfig["auth"] {
  const auth = object(raw, "$.auth", ["mode", "token"]);
  if (auth.mode === "none") {
    if (auth.token !== undefined) {
      invalid("$.auth", 'must contain only mode: "none" when browser authentication is disabled');
    }
    return Object.freeze({ mode: "none" as const });
  }
  if (auth.mode !== undefined) invalid("$.auth.mode", 'must equal "none"');
  if (auth.token === undefined) invalid("$.auth.token", "is required");
  const tokenRef = object(auth.token, "$.auth.token", ["$env"]);
  if (typeof tokenRef.$env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenRef.$env)) {
    invalid("$.auth.token.$env", "must be an environment variable name");
  }
  const token = environment[tokenRef.$env];
  if (typeof token !== "string" || token.length < 16) {
    throw new WebProductError(
      "missing_auth_token",
      `Environment variable ${tokenRef.$env} must contain at least 16 characters.`,
    );
  }
  return Object.freeze({ token });
}

function parseListen(raw: unknown): WebListenConfig {
  const value = object(raw, "$.listen", ["host", "port"]);
  const host = value.host === undefined ? "127.0.0.1" : string(value.host, "$.listen.host");
  if (host.length === 0 || host.length > 253 || /[\s/\\]/u.test(host)) invalid("$.listen.host", "is invalid");
  const port = value.port === undefined ? DEFAULT_PORT : integer(value.port, "$.listen.port", 0, 65_535);
  return { host, port };
}

function object(raw: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid(path, "must be an object");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) invalid(`${path}.${field}`, "is an unknown field");
  }
  return value;
}

function string(raw: unknown, path: string): string {
  if (typeof raw !== "string") invalid(path, "must be a string");
  return raw;
}

function stringArray(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw)) invalid(path, "must be an array");
  return raw.map((entry, index) => string(entry, `${path}[${index}]`));
}

function resolvePath(raw: unknown, path: string, baseDirectory: string): string {
  const value = string(raw, path);
  if (value.length === 0 || value.includes("\0")) invalid(path, "must be a non-empty filesystem path");
  return resolve(baseDirectory, value);
}

function externalOrigin(value: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(path, "must be an absolute HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.hostname.length === 0
  ) {
    invalid(path, "must be an exact HTTPS origin without credentials, path, query, or fragment");
  }
  if (value !== parsed.origin) {
    invalid(path, `must use its canonical origin form ${JSON.stringify(parsed.origin)}`);
  }
  return parsed.origin;
}

function integer(raw: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(raw) || (raw as number) < min || (raw as number) > max) {
    invalid(path, `must be an integer from ${min} through ${max}`);
  }
  return raw as number;
}

function invalid(path: string, reason: string): never {
  throw new WebProductError("invalid_config", `${path} ${reason}.`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

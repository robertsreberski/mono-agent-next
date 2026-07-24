import { isAbsolute, resolve } from "node:path";
import { readServiceInput } from "./input.js";
export const SERVICE_MACOS_CONFIG_VERSION = 1;
export const DEFAULT_LOG_MAX_BYTES = 10_485_760;
export const DEFAULT_LOG_RETAIN_FILES = 5;
export const MAX_SERVICE_CONFIG_BYTES = 1_048_576;
export type ServiceRestartPolicy = "never" | "on-failure" | "always";
export interface ServiceMacosLogsConfig {
  readonly directory: string; readonly maxBytes: number; readonly retainFiles: number;
}
export type ServiceMacosServiceTarget =
  | { readonly kind: "agent"; readonly config: string }
  | { readonly kind: "web"; readonly config: string };
export interface ServiceMacosServiceConfig {
  readonly target: ServiceMacosServiceTarget;
  readonly startAtLogin: boolean; readonly restartPolicy: ServiceRestartPolicy;
  readonly environmentFile?: string;
  readonly logs: ServiceMacosLogsConfig;
}
export interface ServiceMacosConfig {
  readonly $schema?: string;
  readonly configVersion: 1;
  readonly services: Readonly<Record<string, ServiceMacosServiceConfig>>;
}
export interface LoadedServiceMacosConfig {
  readonly path: string; readonly source: string; readonly config: ServiceMacosConfig;
}
export class ServiceMacosConfigError extends Error {
  readonly code = "invalid_service_macos_config";
  constructor(message: string) {
    super(message);
    this.name = "ServiceMacosConfigError";
  }
}
const ROOT_KEYS = new Set(["$schema", "configVersion", "services"]);
const SERVICE_KEYS = new Set(["target", "startAtLogin", "restartPolicy", "environmentFile", "logs"]);
const TARGET_KEYS = new Set(["kind", "config"]);
const LOG_KEYS = new Set(["directory", "maxBytes", "retainFiles"]);
const BOUNDED_STRING_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: "^(?![\\s\\S]*[\\u0000-\\u001f\\u007f])\\S(?:[\\s\\S]*\\S)?$",
});
const ABSOLUTE_PATH_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: "^/(?![\\s\\S]*[\\u0000-\\u001f\\u007f])(?:[\\s\\S]*\\S)?$",
});
export async function loadServiceMacosConfig(path: string): Promise<LoadedServiceMacosConfig> {
  const absolutePath = resolve(path);
  let source: string;
  try {
    source = (await readServiceInput(absolutePath, MAX_SERVICE_CONFIG_BYTES)).source.toString("utf8");
  } catch (error) {
    throw new ServiceMacosConfigError(`Service config is not a protected regular file: ${errorMessage(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ServiceMacosConfigError(`Service config must be strict JSON: ${errorMessage(error)}`);
  }
  return Object.freeze({ path: absolutePath, source, config: parseServiceMacosConfig(value) });
}
export function parseServiceMacosConfig(value: unknown): ServiceMacosConfig {
  const input = readRecord(value, "Service config");
  rejectUnknown(input, ROOT_KEYS, "Service config");
  if (input.configVersion !== SERVICE_MACOS_CONFIG_VERSION) {
    throw new ServiceMacosConfigError("configVersion must be exactly 1.");
  }
  const schema = optionalString(input.$schema, "$schema", true);
  const servicesInput = readRecord(input.services, "services");
  const serviceIds = Object.keys(servicesInput).sort();
  if (serviceIds.length === 0 || serviceIds.length > 256) {
    throw new ServiceMacosConfigError("services must contain between 1 and 256 entries.");
  }
  const services: Record<string, ServiceMacosServiceConfig> = Object.create(null);
  for (const id of serviceIds) {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(id)) {
      throw new ServiceMacosConfigError(`Service id "${id}" must use lowercase letters, digits, dot, or hyphen.`);
    }
    services[id] = parseService(servicesInput[id], id);
  }
  return Object.freeze({
    ...(schema === undefined ? {} : { $schema: schema }),
    configVersion: 1 as const,
    services: Object.freeze(services),
  });
}
export const serviceMacosConfigSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: BOUNDED_STRING_SCHEMA,
    configVersion: { const: 1 },
    services: {
      type: "object",
      minProperties: 1,
      maxProperties: 256,
      patternProperties: {
        "^[a-z0-9][a-z0-9.-]{0,62}$": {
          type: "object",
          additionalProperties: false,
          properties: {
            target: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { const: "agent" },
                    config: ABSOLUTE_PATH_SCHEMA,
                  },
                  required: ["kind", "config"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { const: "web" },
                    config: ABSOLUTE_PATH_SCHEMA,
                  },
                  required: ["kind", "config"],
                },
              ],
            },
            startAtLogin: { type: "boolean" },
            restartPolicy: { enum: ["never", "on-failure", "always"] },
            environmentFile: ABSOLUTE_PATH_SCHEMA,
            logs: {
              type: "object",
              additionalProperties: false,
              properties: {
                directory: ABSOLUTE_PATH_SCHEMA,
                maxBytes: { type: "integer", minimum: 1, maximum: 1_073_741_824 },
                retainFiles: { type: "integer", minimum: 1, maximum: 100 },
              },
              required: ["directory"],
            },
          },
          required: ["target", "startAtLogin", "restartPolicy", "logs"],
        },
      },
      additionalProperties: false,
    },
  },
  required: ["configVersion", "services"],
});
function parseService(value: unknown, id: string): ServiceMacosServiceConfig {
  const input = readRecord(value, `services.${id}`);
  rejectUnknown(input, SERVICE_KEYS, `services.${id}`);
  const target = parseTarget(input.target, id);
  const startAtLogin = boolean(input.startAtLogin, `services.${id}.startAtLogin`);
  const restartPolicy = enumValue(
    input.restartPolicy,
    ["never", "on-failure", "always"] as const,
    `services.${id}.restartPolicy`,
  );
  const environmentFile = input.environmentFile === undefined
    ? undefined
    : absolutePath(input.environmentFile, `services.${id}.environmentFile`);
  const logs = parseLogs(input.logs, id);
  return Object.freeze({
    target,
    startAtLogin,
    restartPolicy,
    ...(environmentFile === undefined ? {} : { environmentFile }),
    logs,
  });
}
function parseTarget(value: unknown, id: string): ServiceMacosServiceTarget {
  const input = readRecord(value, `services.${id}.target`);
  rejectUnknown(input, TARGET_KEYS, `services.${id}.target`);
  const kind = enumValue(input.kind, ["agent", "web"] as const, `services.${id}.target.kind`);
  return Object.freeze({
    kind,
    config: absolutePath(input.config, `services.${id}.target.config`),
  });
}
function parseLogs(value: unknown, id: string): ServiceMacosLogsConfig {
  const input = readRecord(value, `services.${id}.logs`);
  rejectUnknown(input, LOG_KEYS, `services.${id}.logs`);
  return Object.freeze({
    directory: absolutePath(input.directory, `services.${id}.logs.directory`),
    maxBytes: integer(input.maxBytes, DEFAULT_LOG_MAX_BYTES, 1_073_741_824, `services.${id}.logs.maxBytes`),
    retainFiles: integer(input.retainFiles, DEFAULT_LOG_RETAIN_FILES, 100, `services.${id}.logs.retainFiles`),
  });
}
function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceMacosConfigError(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ServiceMacosConfigError(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}
function rejectUnknown(input: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new ServiceMacosConfigError(`${field} contains unknown field(s): ${unknown.join(", ")}.`);
}
function absolutePath(value: unknown, field: string): string {
  const path = optionalString(value, field, true);
  if (path === undefined || !isAbsolute(path)) throw new ServiceMacosConfigError(`${field} must be an absolute path.`);
  return resolve(path);
}
function optionalString(value: unknown, field: string, rejectControl: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > 8_192
    || Array.from(value).length > 4_096
    || (rejectControl && /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    throw new ServiceMacosConfigError(`${field} must be a non-empty bounded string without surrounding whitespace.`);
  }
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ServiceMacosConfigError(`${field} must be a boolean.`);
  return value;
}
function integer(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new ServiceMacosConfigError(`${field} must be a positive integer no greater than ${String(maximum)}.`);
  }
  return value as number;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ServiceMacosConfigError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

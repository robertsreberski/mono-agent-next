import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_CONTINUATION_LIMITS,
  type ContinuationLimits,
  type NamedContinuationRoute,
} from "./continuations.js";
import type { ContinuationRetentionOptions } from "./continuation-store.js";

/** Fixed by default so persisted callback/status URLs survive app restarts. */
export const DEFAULT_CONTINUATION_SERVICE_PORT = 4319;

export interface ContinuationSettings {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  readonly namedRoutes: Readonly<Record<string, NamedContinuationRoute>>;
  readonly detachedServices: Readonly<Record<string, string>>;
  readonly retention: ContinuationRetentionOptions;
  readonly limits: ContinuationLimits;
}

/**
 * Host-only continuation settings. Detached bearers are referenced by env name
 * so no secret is placed in mono-agent.config.json.
 */
export async function loadContinuationSettings(input: {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
}): Promise<ContinuationSettings> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(input.configPath, "utf8")) as unknown;
  } catch {
    // The core config loader reports malformed/missing configuration. This
    // optional host block simply remains unconfigured here.
  }
  const root = objectOf(raw);
  const blockValue = root.continuations;
  if (blockValue === undefined) {
    return {
      configured: false,
      enabled: true,
      host: "127.0.0.1",
      port: DEFAULT_CONTINUATION_SERVICE_PORT,
      stateDir: resolve(input.cwd, ".mono-agent", "continuations"),
      namedRoutes: {},
      detachedServices: {},
      retention: {},
      limits: DEFAULT_CONTINUATION_LIMITS,
    };
  }
  const block = requireObject(blockValue, "continuations");
  rejectUnknownKeys(block, "continuations", ["enabled", "host", "port", "stateDir", "namedRoutes", "detachedServices", "retention", "limits"]);
  const enabled = optionalBoolean(block.enabled, "continuations.enabled") ?? true;
  const host = optionalString(block.host, "continuations.host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("continuations.host must be a loopback host (127.0.0.1, ::1, or localhost).");
  }
  const port = optionalInteger(block.port, "continuations.port") ?? DEFAULT_CONTINUATION_SERVICE_PORT;
  if (port < 1 || port > 65_535) throw new Error("continuations.port must be between 1 and 65535.");
  const stateDirValue = optionalString(block.stateDir, "continuations.stateDir");
  const stateDir = resolve(input.cwd, stateDirValue ?? ".mono-agent/continuations");
  const namedRoutes = parseNamedRoutes(block.namedRoutes);
  const detachedServices = parseDetachedServices(block.detachedServices, input.env);
  const retention = parseRetention(block.retention);
  const limits = parseLimits(block.limits);
  return {
    configured: true,
    enabled,
    host,
    port,
    stateDir,
    namedRoutes,
    detachedServices,
    retention,
    limits,
  };
}

function parseLimits(value: unknown): ContinuationLimits {
  if (value === undefined) return DEFAULT_CONTINUATION_LIMITS;
  const object = requireObject(value, "continuations.limits");
  rejectUnknownKeys(object, "continuations.limits", [
    "maxActiveRecords",
    "maxActivePerOrigin",
    "maxConcurrent",
    "synthesisTimeoutMs",
    "deliveryTimeoutMs",
    "operatorPageSize",
  ]);
  const maxActiveRecords = optionalPositiveInteger(object.maxActiveRecords, "continuations.limits.maxActiveRecords")
    ?? DEFAULT_CONTINUATION_LIMITS.maxActiveRecords;
  const limits: ContinuationLimits = {
    maxActiveRecords,
    maxActivePerOrigin: optionalPositiveInteger(object.maxActivePerOrigin, "continuations.limits.maxActivePerOrigin")
      ?? Math.min(DEFAULT_CONTINUATION_LIMITS.maxActivePerOrigin, maxActiveRecords),
    maxConcurrent: optionalPositiveInteger(object.maxConcurrent, "continuations.limits.maxConcurrent")
      ?? DEFAULT_CONTINUATION_LIMITS.maxConcurrent,
    synthesisTimeoutMs: optionalPositiveInteger(object.synthesisTimeoutMs, "continuations.limits.synthesisTimeoutMs")
      ?? DEFAULT_CONTINUATION_LIMITS.synthesisTimeoutMs,
    deliveryTimeoutMs: optionalPositiveInteger(object.deliveryTimeoutMs, "continuations.limits.deliveryTimeoutMs")
      ?? DEFAULT_CONTINUATION_LIMITS.deliveryTimeoutMs,
    operatorPageSize: optionalPositiveInteger(object.operatorPageSize, "continuations.limits.operatorPageSize")
      ?? DEFAULT_CONTINUATION_LIMITS.operatorPageSize,
  };
  if (limits.maxActiveRecords > 1_000_000) throw new Error("continuations.limits.maxActiveRecords cannot exceed 1000000.");
  if (limits.maxActivePerOrigin > limits.maxActiveRecords) {
    throw new Error("continuations.limits.maxActivePerOrigin cannot exceed maxActiveRecords.");
  }
  if (limits.maxConcurrent > 256) throw new Error("continuations.limits.maxConcurrent cannot exceed 256.");
  if (limits.synthesisTimeoutMs > 86_400_000 || limits.deliveryTimeoutMs > 86_400_000) {
    throw new Error("continuations operation timeouts cannot exceed 24 hours.");
  }
  if (limits.operatorPageSize > 500) throw new Error("continuations.limits.operatorPageSize cannot exceed 500.");
  return limits;
}

function parseRetention(value: unknown): ContinuationRetentionOptions {
  if (value === undefined) return {};
  const object = requireObject(value, "continuations.retention");
  rejectUnknownKeys(object, "continuations.retention", [
    "terminalMaxRecords",
    "terminalMaxAgeMs",
    "capturedTextMaxRecords",
    "capturedTextMaxAgeMs",
  ]);
  const terminalMaxRecords = optionalNonNegativeInteger(object.terminalMaxRecords, "continuations.retention.terminalMaxRecords");
  const terminalMaxAgeMs = optionalNonNegativeInteger(object.terminalMaxAgeMs, "continuations.retention.terminalMaxAgeMs");
  const capturedTextMaxRecords = optionalNonNegativeInteger(object.capturedTextMaxRecords, "continuations.retention.capturedTextMaxRecords");
  const capturedTextMaxAgeMs = optionalNonNegativeInteger(object.capturedTextMaxAgeMs, "continuations.retention.capturedTextMaxAgeMs");
  return {
    ...(terminalMaxRecords === undefined ? {} : { terminalMaxRecords }),
    ...(terminalMaxAgeMs === undefined ? {} : { terminalMaxAgeMs }),
    ...(capturedTextMaxRecords === undefined ? {} : { capturedTextMaxRecords }),
    ...(capturedTextMaxAgeMs === undefined ? {} : { capturedTextMaxAgeMs }),
  };
}

function parseNamedRoutes(value: unknown): Readonly<Record<string, NamedContinuationRoute>> {
  if (value === undefined) return {};
  const object = requireObject(value, "continuations.namedRoutes");
  const routes: Record<string, NamedContinuationRoute> = {};
  for (const [name, routeValue] of Object.entries(object)) {
    if (name.trim().length === 0 || name.length > 128) {
      throw new Error("continuations.namedRoutes keys must be 1-128 characters.");
    }
    const route = requireObject(routeValue, `continuations.namedRoutes.${name}`);
    rejectUnknownKeys(route, `continuations.namedRoutes.${name}`, ["mode", "conversationId"]);
    const mode = route.mode;
    if (mode !== "notify_if_actionable" && mode !== "silent" && mode !== "capture") {
      throw new Error(`continuations.namedRoutes.${name}.mode must be notify_if_actionable, silent, or capture.`);
    }
    const conversationId = optionalString(route.conversationId, `continuations.namedRoutes.${name}.conversationId`);
    if ((mode === "notify_if_actionable" || mode === "capture") && conversationId === undefined) {
      throw new Error(`continuations.namedRoutes.${name}.conversationId is required for mode ${mode}.`);
    }
    if (mode === "silent" && conversationId !== undefined) {
      throw new Error(`continuations.namedRoutes.${name}.conversationId is forbidden for mode silent.`);
    }
    routes[name] = {
      mode,
      ...(conversationId === undefined ? {} : { conversationId }),
    };
  }
  return routes;
}

function parseDetachedServices(
  value: unknown,
  env: Record<string, string | undefined>,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error("continuations.detachedServices must be an array.");
  const services: Record<string, string> = {};
  for (const [index, serviceValue] of value.entries()) {
    const service = requireObject(serviceValue, `continuations.detachedServices[${String(index)}]`);
    rejectUnknownKeys(service, `continuations.detachedServices[${String(index)}]`, ["name", "tokenEnv"]);
    const name = requiredString(service.name, `continuations.detachedServices[${String(index)}].name`);
    if (name.length > 128) {
      throw new Error(`continuations.detachedServices[${String(index)}].name must be at most 128 characters.`);
    }
    const tokenEnv = requiredString(service.tokenEnv, `continuations.detachedServices[${String(index)}].tokenEnv`);
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(tokenEnv)) {
      throw new Error(`continuations.detachedServices[${String(index)}].tokenEnv must name an environment variable.`);
    }
    if (services[name] !== undefined) throw new Error(`Duplicate detached continuation service: ${name}.`);
    const token = env[tokenEnv]?.trim();
    if (token === undefined || token.length < 16) {
      throw new Error(`Detached continuation service ${name} requires ${tokenEnv} (at least 16 characters).`);
    }
    services[name] = token;
  }
  return services;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function optionalInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${path} must be an integer.`);
  return value;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  const integer = optionalInteger(value, path);
  if (integer !== undefined && (!Number.isSafeInteger(integer) || integer < 0)) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return integer;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  const integer = optionalInteger(value, path);
  if (integer !== undefined && (!Number.isSafeInteger(integer) || integer <= 0)) {
    throw new Error(`${path} must be a positive safe integer.`);
  }
  return integer;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}.`);
  }
}

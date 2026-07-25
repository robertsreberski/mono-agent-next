// SPDX-License-Identifier: MIT
import { join, resolve } from "node:path";

export const DEFAULT_STATE_ROOT = "./.mono-agent/state";
export const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RECORDS = 100_000;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 1_000_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MIN_HEARTBEAT_MS = 1_000;
const MAX_HEARTBEAT_MS = 5 * 60_000;
const MAX_ARTIFACT_RETENTION_DAYS = 3_650;

export interface StateLocalDiscoveryConfig {
  readonly registryDirectory: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly heartbeatMs: number;
}

export interface StateLocalRunsConfig {
  readonly artifactsDirectory?: string;
  readonly retentionDays: number;
}

export interface StateLocalConfig {
  readonly root: string;
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly runs?: StateLocalRunsConfig;
  readonly discovery?: StateLocalDiscoveryConfig;
}

export interface ResolvedStateLocalDiscoveryConfig extends StateLocalDiscoveryConfig {
  readonly registryDirectory: string;
}

export interface ResolvedStateLocalRunsConfig extends StateLocalRunsConfig {
  readonly artifactsDirectory: string;
}

export interface ResolvedStateLocalConfig extends StateLocalConfig {
  readonly root: string;
  readonly runs?: ResolvedStateLocalRunsConfig;
  readonly discovery?: ResolvedStateLocalDiscoveryConfig;
}

export class StateLocalConfigError extends Error {
  readonly code = "STATE_INVALID_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "StateLocalConfigError";
  }
}

const CONFIG_KEYS = new Set([
  "root",
  "maxRecordBytes",
  "maxRecords",
  "maxTotalBytes",
  "runs",
  "discovery",
]);
const RUNS_KEYS = new Set([
  "artifactsDirectory",
  "retentionDays",
]);
const DISCOVERY_KEYS = new Set([
  "registryDirectory",
  "sourceId",
  "sourceLabel",
  "heartbeatMs",
]);

export function parseStateLocalConfig(value: unknown): StateLocalConfig {
  const input = readRecord(value, "State-local config", true);
  rejectUnknownKeys(input, CONFIG_KEYS, "State-local config");

  const root = readPath(input.root, "root", DEFAULT_STATE_ROOT);
  const maxRecordBytes = readBoundedInteger(
    input.maxRecordBytes,
    "maxRecordBytes",
    DEFAULT_MAX_RECORD_BYTES,
    1,
    MAX_RECORD_BYTES,
  );
  const maxRecords = readBoundedInteger(
    input.maxRecords,
    "maxRecords",
    DEFAULT_MAX_RECORDS,
    1,
    MAX_RECORDS,
  );
  const maxTotalBytes = readBoundedInteger(
    input.maxTotalBytes,
    "maxTotalBytes",
    DEFAULT_MAX_TOTAL_BYTES,
    maxRecordBytes,
    MAX_TOTAL_BYTES,
  );
  const runs = parseRuns(input.runs);
  const discovery = parseDiscovery(input.discovery);

  return {
    root,
    maxRecordBytes,
    maxRecords,
    maxTotalBytes,
    ...(runs === undefined ? {} : { runs }),
    ...(discovery === undefined ? {} : { discovery }),
  };
}

export function resolveStateLocalConfig(
  config: StateLocalConfig,
  configDirectory: string,
): ResolvedStateLocalConfig {
  const root = resolve(configDirectory, config.root);
  const runs = config.runs;
  const discovery = config.discovery;
  return {
    ...config,
    root,
    runs: {
      artifactsDirectory: runs?.artifactsDirectory === undefined
        ? join(root, "artifacts")
        : resolve(configDirectory, runs.artifactsDirectory),
      retentionDays: runs?.retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS,
    },
    ...(discovery === undefined
      ? {}
      : {
          discovery: {
            ...discovery,
            registryDirectory: resolve(configDirectory, discovery.registryDirectory),
          },
        }),
  };
}

export const stateLocalConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      root: { type: "string", minLength: 1, maxLength: 4_096, default: DEFAULT_STATE_ROOT },
      maxRecordBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RECORD_BYTES,
        default: DEFAULT_MAX_RECORD_BYTES,
      },
      maxRecords: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RECORDS,
        default: DEFAULT_MAX_RECORDS,
      },
      maxTotalBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TOTAL_BYTES,
        default: DEFAULT_MAX_TOTAL_BYTES,
      },
      runs: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactsDirectory: { type: "string", minLength: 1, maxLength: 4_096 },
          retentionDays: {
            type: "integer",
            minimum: 1,
            maximum: MAX_ARTIFACT_RETENTION_DAYS,
            default: DEFAULT_ARTIFACT_RETENTION_DAYS,
          },
        },
      },
      discovery: {
        type: "object",
        additionalProperties: false,
        properties: {
          registryDirectory: { type: "string", minLength: 1, maxLength: 4_096 },
          sourceId: { type: "string", minLength: 1, maxLength: 128 },
          sourceLabel: { type: "string", minLength: 1, maxLength: 256 },
          heartbeatMs: {
            type: "integer",
            minimum: MIN_HEARTBEAT_MS,
            maximum: MAX_HEARTBEAT_MS,
            default: DEFAULT_HEARTBEAT_MS,
          },
        },
        required: ["registryDirectory", "sourceId", "sourceLabel"],
      },
    },
  }),
  parse: parseStateLocalConfig,
});

function parseRuns(value: unknown): StateLocalRunsConfig | undefined {
  if (value === undefined) return undefined;
  const input = readRecord(value, "runs");
  rejectUnknownKeys(input, RUNS_KEYS, "runs");
  const artifactsDirectory = input.artifactsDirectory === undefined
    ? undefined
    : readPath(input.artifactsDirectory, "runs.artifactsDirectory");
  const retentionDays = readBoundedInteger(
    input.retentionDays,
    "runs.retentionDays",
    DEFAULT_ARTIFACT_RETENTION_DAYS,
    1,
    MAX_ARTIFACT_RETENTION_DAYS,
  );
  return {
    ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
    retentionDays,
  };
}

function parseDiscovery(value: unknown): StateLocalDiscoveryConfig | undefined {
  if (value === undefined) return undefined;
  const input = readRecord(value, "discovery");
  rejectUnknownKeys(input, DISCOVERY_KEYS, "discovery");
  const registryDirectory = readPath(input.registryDirectory, "discovery.registryDirectory");
  const sourceId = readString(input.sourceId, "discovery.sourceId", 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(sourceId)) {
    throw new StateLocalConfigError(
      "discovery.sourceId must contain only letters, digits, dots, underscores, and hyphens.",
    );
  }
  const sourceLabel = readString(input.sourceLabel, "discovery.sourceLabel", 256);
  const heartbeatMs = readBoundedInteger(
    input.heartbeatMs,
    "discovery.heartbeatMs",
    DEFAULT_HEARTBEAT_MS,
    MIN_HEARTBEAT_MS,
    MAX_HEARTBEAT_MS,
  );
  return { registryDirectory, sourceId, sourceLabel, heartbeatMs };
}

function readRecord(
  value: unknown,
  field: string,
  allowUndefined = false,
): Record<string, unknown> {
  if (value === undefined && allowUndefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateLocalConfigError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StateLocalConfigError(`${field} must be a plain object.`);
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
    throw new StateLocalConfigError(`${field} contains unknown field(s): ${unknown.join(", ")}.`);
  }
}

function readPath(value: unknown, field: string, fallback?: string): string {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "string" ||
    result.length === 0 ||
    result.length > 4_096 ||
    result.includes("\0")
  ) {
    throw new StateLocalConfigError(`${field} must be a non-empty filesystem path.`);
  }
  return result;
}

function readString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new StateLocalConfigError(`${field} must be a non-empty printable string.`);
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
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) {
    throw new StateLocalConfigError(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return result as number;
}

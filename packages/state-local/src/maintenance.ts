// SPDX-License-Identifier: MIT
import { StateLocalError } from "./errors.js";

export const STATE_LOCAL_MAINTENANCE_DEFAULT_LIMIT = 1_000;
export const STATE_LOCAL_MAINTENANCE_MAX_LIMIT = 10_000;

export interface StateLocalMaintenanceRequest {
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly signal: AbortSignal;
}

export interface StateLocalMaintenanceResult {
  readonly checkedAt: string;
  readonly artifactCutoffAt: string;
  readonly dryRun: boolean;
  readonly expiredPresenceCandidates: number;
  readonly expiredPresenceRemoved: number;
  readonly unpublishedArtifactCandidates: number;
  readonly unpublishedArtifactRemoved: number;
  readonly reclaimedArtifactBytes: number;
  readonly terminalRunCandidates: number;
  readonly terminalRunsRemoved: number;
  readonly runEventsRemoved: number;
  readonly terminalAdmissionsRemoved: number;
  readonly terminalDeliveryCandidates: number;
  readonly terminalDeliveriesRemoved: number;
  readonly staleSessionCandidates: number;
  readonly staleSessionsRemoved: number;
  readonly publishedArtifactsReleased: number;
  readonly pendingRunRetentionCheckpoints: number;
  readonly truncated: boolean;
}

export interface NormalizedStateLocalMaintenanceRequest {
  readonly dryRun: boolean;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export const stateLocalMaintenanceInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    dryRun: { type: "boolean", default: false },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: STATE_LOCAL_MAINTENANCE_MAX_LIMIT,
      default: STATE_LOCAL_MAINTENANCE_DEFAULT_LIMIT,
    },
  },
});

export function normalizeStateLocalMaintenanceRequest(
  value: unknown,
): NormalizedStateLocalMaintenanceRequest {
  const input = readOwnRecord(
    value,
    ["dryRun", "limit", "signal"],
    ["signal"],
    "State maintenance request",
  );
  const signal = input.signal;
  if (!(signal instanceof AbortSignal)) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      "State maintenance request signal must be an AbortSignal.",
    );
  }
  return {
    dryRun: readBoolean(input.dryRun, "dryRun", false),
    limit: readLimit(input.limit),
    signal,
  };
}

export function stateLocalMaintenanceRequestFromCommand(
  value: unknown,
  signal: AbortSignal,
): NormalizedStateLocalMaintenanceRequest {
  const input = readOwnRecord(
    value === undefined ? {} : value,
    ["dryRun", "limit"],
    [],
    "State maintenance command input",
  );
  return {
    dryRun: readBoolean(input.dryRun, "dryRun", false),
    limit: readLimit(input.limit),
    signal,
  };
}

function readOwnRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${label} contains an unknown field.`);
  }
  for (const field of required) {
    if (!Object.hasOwn(descriptors, field)) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        `${label} is missing ${field}.`,
      );
    }
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        `${label}.${key} must be an own data property.`,
      );
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${field} must be a boolean.`);
  }
  return value;
}

function readLimit(value: unknown): number {
  if (value === undefined) return STATE_LOCAL_MAINTENANCE_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > STATE_LOCAL_MAINTENANCE_MAX_LIMIT
  ) {
    throw new StateLocalError(
      "STATE_LIMIT_EXCEEDED",
      `State maintenance limit must be from 1 through ${STATE_LOCAL_MAINTENANCE_MAX_LIMIT}.`,
    );
  }
  return value as number;
}

// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";

import type {
  JsonObject,
  JsonValue,
  ModuleDrainContext,
} from "@mono-agent/module-sdk";
import type { TriggerReceipt } from "@mono-agent/module-sdk/internal";

import type { CronJob } from "./jobs.js";
import {
  nextCronOccurrence,
  previousCronOccurrence,
} from "./jobs.js";
import type {
  CronClock,
  CronInvocationResult,
  CronInvocationSource,
} from "./scheduler.js";
import type { JobState, PendingInvocation } from "./scheduler-state.js";

export const MAX_TIMEOUT_MS = 2_147_483_647;

export interface DueSet {
  readonly selected: readonly Date[];
  readonly missed?: { readonly from: Date; readonly through: Date };
}

export function cronIdempotencyKey(
  instanceId: string,
  jobId: string,
  scheduledAt: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, instanceId, jobId, scheduledAt]), "utf8")
    .digest("hex");
  return `cron:v1:${digest}`;
}

export function hasPendingDurableRepair(state: JobState): boolean {
  return state.active?.releasePending === true
    || state.pendingClockRegression !== undefined
    || state.scheduleTransition
    || state.generationFenced;
}

export function fenceScheduleGeneration(state: JobState): void {
  state.generationFenced = true;
  state.foreignBlocked = false;
  state.persistenceError = "durable_state_schedule_changed";
}

export function isForeignActive(state: JobState, ownerId: string): boolean {
  const active = state.durable.record.active;
  return active !== undefined
    && (
      active.ownerId !== ownerId
      || active.idempotencyKey !== state.active?.idempotencyKey
    );
}

export function collectDue(
  job: CronJob,
  watermarkMs: number,
  nowMs: number,
  limit: number,
): DueSet {
  const boundary = dueBoundary(job, watermarkMs, nowMs);
  if (boundary === undefined) return { selected: [] };
  let cursor = boundary.through;
  const descending: Date[] = [];
  while (descending.length < limit && cursor.getTime() > watermarkMs) {
    descending.push(cursor);
    cursor = previousCronOccurrence(job, cursor);
  }
  const selected = descending.reverse();
  if (cursor.getTime() < boundary.from.getTime()) return { selected };
  return {
    selected,
    missed: {
      from: boundary.from,
      through: cursor,
    },
  };
}

export function allDueRange(
  job: CronJob,
  watermarkMs: number,
  nowMs: number,
): { readonly from: Date; readonly through: Date } | undefined {
  return dueBoundary(job, watermarkMs, nowMs);
}

function dueBoundary(
  job: CronJob,
  watermarkMs: number,
  nowMs: number,
): { readonly from: Date; readonly through: Date } | undefined {
  if (watermarkMs >= nowMs) return undefined;
  const probeMs = Math.min(nowMs + 1, 8_640_000_000_000_000);
  const through = previousCronOccurrence(job, new Date(probeMs));
  if (through.getTime() <= watermarkMs) return undefined;
  return {
    from: nextCronOccurrence(job, new Date(watermarkMs)),
    through,
  };
}

export function cronMetadata(
  job: CronJob,
  scheduledAt: string,
  invokedAt: string,
  idempotencyKey: string,
  source: CronInvocationSource,
): JsonObject {
  const cron: Record<string, JsonValue> = {
    schemaVersion: 1,
    jobId: job.id,
    expression: job.expression,
    timezone: job.timezone,
    scheduledAt,
    invokedAt,
    idempotencyKey,
    source,
    overlap: job.overlap,
    maxRunMs: job.maxRunMs,
  };
  if (job.effort !== undefined) cron.effort = job.effort;
  if (job.notify !== undefined) {
    cron.notify = typeof job.notify === "string"
      ? { channel: job.notify }
      : { channel: job.notify.channel, destination: job.notify.destination };
  }
  const metadata: Record<string, JsonValue> = {
    triggerKind: "cron",
    cron: Object.freeze(cron),
  };
  if (job.effort !== undefined) metadata.effort = job.effort;
  if (typeof job.notify === "string") metadata.destination = "";
  if (typeof job.notify === "object") metadata.destination = job.notify.destination;
  return Object.freeze(metadata);
}

export function deliveryChannel(job: CronJob): string | undefined {
  return typeof job.notify === "string" ? job.notify : job.notify?.channel;
}

export function receiptResult(
  job: CronJob,
  scheduledAt: string,
  idempotencyKey: string,
  receipt: TriggerReceipt,
): CronInvocationResult {
  if (receipt.status === "accepted") {
    return {
      status: "accepted",
      jobId: job.id,
      scheduledAt,
      idempotencyKey,
      ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
    };
  }
  if (receipt.status === "unknown") {
    return {
      status: "unknown",
      jobId: job.id,
      scheduledAt,
      idempotencyKey,
      reason: "The trigger host reported an unknown outcome.",
    };
  }
  if (receipt.code === "duplicate") {
    return {
      status: "duplicate",
      jobId: job.id,
      scheduledAt,
      idempotencyKey,
      reason: receipt.reason ?? "The trigger host reported a duplicate event.",
    };
  }
  return {
    status: "rejected",
    jobId: job.id,
    scheduledAt,
    idempotencyKey,
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  };
}

export function terminal(
  invocation: Pick<PendingInvocation, "job" | "scheduledAt" | "idempotencyKey">,
  status: "dropped" | "cancelled",
  reason: string,
): CronInvocationResult {
  return {
    status,
    jobId: invocation.job.id,
    scheduledAt: invocation.scheduledAt,
    idempotencyKey: invocation.idempotencyKey,
    reason,
  };
}

export function parseInvokeInput(
  value: unknown,
): { readonly jobId: string; readonly scheduledAt?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("trigger-cron:invoke input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== "jobId" && key !== "scheduledAt");
  if (unknown.length > 0) {
    throw new TypeError(`trigger-cron:invoke contains unknown field(s): ${unknown.join(", ")}.`);
  }
  if (
    typeof input.jobId !== "string"
    || input.jobId.length === 0
    || input.jobId !== input.jobId.trim()
  ) {
    throw new TypeError("trigger-cron:invoke jobId must be a non-empty string.");
  }
  const scheduledAt = input.scheduledAt === undefined
    ? undefined
    : normalizeInstant(input.scheduledAt);
  return { jobId: input.jobId, ...(scheduledAt === undefined ? {} : { scheduledAt }) };
}

export function normalizeInstant(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("scheduledAt must be an RFC3339 date-time string.");
  }
  const match = RFC3339_INSTANT.exec(value);
  if (match === null) throw new TypeError("scheduledAt must be an RFC3339 date-time string.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day > daysInMonth(year, month)) {
    throw new TypeError("scheduledAt must be an RFC3339 date-time string.");
  }
  const leapSecond = match[6] === "60";
  const normalizedInput = leapSecond
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:59${match[7] ?? ""}${match[8]}`
    : value;
  const parsed = new Date(normalizedInput);
  if (!Number.isFinite(parsed.getTime()) || (leapSecond && !isLeapSecondBoundary(parsed))) {
    throw new TypeError("scheduledAt must be an RFC3339 date-time string.");
  }
  return new Date(parsed.getTime() + (leapSecond ? 1_000 : 0)).toISOString();
}

export function invocationResultToJson(result: CronInvocationResult): JsonValue {
  const json: Record<string, JsonValue> = {
    status: result.status,
    jobId: result.jobId,
    scheduledAt: result.scheduledAt,
    idempotencyKey: result.idempotencyKey,
  };
  if ("runId" in result && result.runId !== undefined) json.runId = result.runId;
  if (result.reason !== undefined) json.reason = result.reason;
  return json;
}

export function validClockInstant(clock: CronClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Cron clock returned an invalid date.");
  }
  return value;
}

export function mutateState<T>(state: JobState, mutation: () => Promise<T>): Promise<T> {
  const result = state.mutation.then(mutation, mutation);
  state.mutation = result.then(() => undefined, () => undefined);
  return result;
}

export function stablePersistenceFailure(_error: unknown): string {
  return "durable_state_unavailable";
}

export async function waitForStopWork(
  work: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await work;
    return;
  }
  throwIfAborted(signal, "Cron trigger stop was aborted.");
  let removeAbortListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Cron trigger stop was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    removeAbortListener();
  }
}

export function drainSignal(context: ModuleDrainContext): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  if (context.deadline === undefined) {
    return { signal: context.signal, dispose: () => {} };
  }
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) {
    throw new TypeError("Cron drain deadline must be a valid date-time.");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error("Cron drain deadline reached.");
      error.name = "TimeoutError";
      controller.abort(error);
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_MS));
    timer.unref?.();
  };
  arm();
  return {
    signal: AbortSignal.any([context.signal, controller.signal]),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

const RFC3339_INSTANT =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(\.\d+)?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapSecondBoundary(value: Date): boolean {
  return value.getUTCHours() === 23
    && value.getUTCMinutes() === 59
    && value.getUTCSeconds() === 59
    && value.getUTCDate() === daysInMonth(value.getUTCFullYear(), value.getUTCMonth() + 1);
}

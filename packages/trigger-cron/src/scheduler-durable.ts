// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";

import type { TriggerHost } from "@mono-agent/module-sdk/internal";

import type { CronJob } from "./jobs.js";
import {
  cronIdempotencyKey,
  fenceScheduleGeneration,
  hasPendingDurableRepair,
  mutateState,
  stablePersistenceFailure,
  validClockInstant,
} from "./scheduler-helpers.js";
import type {
  CronClock,
  CronInvocationResult,
  CronInvocationStatus,
} from "./scheduler.js";
import type { JobState } from "./scheduler-state.js";

const DURABLE_RECORD_BYTES = 16 * 1024;
const DURABLE_CAS_ATTEMPTS = 4;
const OUTCOME_STATUSES = new Set<CronInvocationStatus>([
  "accepted",
  "rejected",
  "duplicate",
  "skipped",
  "queued",
  "dropped",
  "cancelled",
  "unknown",
  "missed",
]);
const ISSUE_STATUSES = new Set<CronHealthIssueStatus>([
  "missed",
  "rejected",
  "unknown",
  "clock-regressed",
]);

export const HOST_CAPABILITY_CRON_DURABLE_STATE = "cron.durable-state.v1" as const;

export interface CronDurableStateReadRequest {
  readonly key: string;
  readonly signal: AbortSignal;
}

export interface CronDurableStateReadResult {
  readonly value: Uint8Array;
  readonly version: string;
}

export interface CronDurableStateCompareAndSwapRequest extends CronDurableStateReadRequest {
  readonly expectedVersion: string | null;
  readonly value: Uint8Array;
}

export type CronDurableStateCompareAndSwapResult =
  | { readonly status: "applied"; readonly version: string }
  | { readonly status: "conflict"; readonly currentVersion?: string };

/**
 * A trigger-instance-scoped view of the selected durable state store.
 *
 * Core grants only these two operations and prefixes every key with the
 * requesting trigger instance's private namespace.
 */
export interface CronDurableStateCapability {
  read(request: CronDurableStateReadRequest): Promise<CronDurableStateReadResult | undefined>;
  compareAndSwap(
    request: CronDurableStateCompareAndSwapRequest,
  ): Promise<CronDurableStateCompareAndSwapResult>;
}

export interface DurableActiveInvocation {
  readonly ownerId: string;
  readonly idempotencyKey: string;
  readonly scheduledAt: string;
  readonly claimedAt: string;
}

interface DurableOutcome {
  readonly status: CronInvocationStatus;
  readonly scheduledAt: string;
  readonly idempotencyKey: string;
}

export type CronHealthIssueStatus = "missed" | "rejected" | "unknown" | "clock-regressed";

export interface DurableHealthIssue {
  readonly status: CronHealthIssueStatus;
  readonly observedAt: string;
  readonly scheduledAt: string;
}

export interface DurableMissedRange {
  readonly ranges: number;
  readonly atLeast: number;
  readonly from: string;
  readonly through: string;
}

export interface DurableClockRegression {
  readonly from: string;
  readonly to: string;
}

export interface DurableJobRecord {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly scheduleFingerprint: string;
  readonly watermark: string;
  readonly active?: DurableActiveInvocation;
  readonly lastOutcome?: DurableOutcome;
  readonly issue?: DurableHealthIssue;
  readonly missed?: DurableMissedRange;
  readonly clockRegressions: number;
  readonly lastClockRegression?: DurableClockRegression;
}

export interface DurableEnvelope {
  readonly record: DurableJobRecord;
  readonly version: string | null;
}

interface CreateCronDurableSchedulerOptions {
  readonly instanceId: string;
  readonly ownerId: string;
  readonly clock: CronClock;
  readonly capability?: CronDurableStateCapability;
}

export interface CronDurableScheduler {
  initializeJob(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void>;
  recoverDefinitivelySettledActive(
    job: CronJob,
    state: JobState,
    signal: AbortSignal,
  ): Promise<void>;
  replaceChangedSchedule(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void>;
  accountClockRegression(job: CronJob, state: JobState, now: Date): Promise<void>;
  refreshJob(job: CronJob, state: JobState): Promise<void>;
  recordMissedRange(
    job: CronJob,
    state: JobState,
    from: Date,
    through: Date,
    observedAt: Date,
  ): Promise<void>;
  claimActive(
    job: CronJob,
    state: JobState,
    scheduledAt: string,
    idempotencyKey: string,
  ): Promise<boolean>;
  clearActive(job: CronJob, state: JobState, idempotencyKey: string): Promise<boolean>;
  settleInvocation(
    job: CronJob,
    state: JobState,
    result: CronInvocationResult,
  ): Promise<CronInvocationResult>;
  updateRecord(
    job: CronJob,
    state: JobState,
    signal: AbortSignal,
    transform: (current: DurableJobRecord) => DurableJobRecord,
    allowScheduleMismatch?: boolean,
  ): Promise<boolean>;
}

export function createCronDurableScheduler(
  options: CreateCronDurableSchedulerOptions,
): CronDurableScheduler {
  const { capability, clock, instanceId, ownerId } = options;

  async function updateRecord(
    job: CronJob,
    state: JobState,
    signal: AbortSignal,
    transform: (current: DurableJobRecord) => DurableJobRecord,
    allowScheduleMismatch = false,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < DURABLE_CAS_ATTEMPTS; attempt += 1) {
      const current = state.durable;
      if (
        !allowScheduleMismatch
        && current.record.scheduleFingerprint !== scheduleFingerprint(job)
      ) {
        fenceScheduleGeneration(state);
        throw new Error(`Cron schedule generation for job "${job.id}" was replaced.`);
      }
      const next = transform(current.record);
      if (next === current.record) return false;
      if (capability === undefined) {
        state.durable = { record: next, version: null };
        return true;
      }
      const key = durableJobKey(instanceId, job.id);
      const result = await capability.compareAndSwap({
        key,
        expectedVersion: current.version,
        value: encodeDurableRecord(next),
        signal,
      });
      if (result.status === "applied") {
        state.durable = { record: next, version: result.version };
        return true;
      }
      const found = await capability.read({ key, signal });
      if (found === undefined) {
        throw new Error(`Cron durable state for job "${job.id}" disappeared during an update.`);
      }
      state.durable = {
        record: parseDurableRecord(found.value, job),
        version: found.version,
      };
    }
    throw new Error(`Cron durable state for job "${job.id}" changed repeatedly during an update.`);
  }

  async function recoverDefinitivelySettledActive(
    job: CronJob,
    state: JobState,
    signal: AbortSignal,
  ): Promise<void> {
    if (!hasDefinitivelySettledActive(state.durable.record)) return;
    await mutateState(state, async () => {
      await updateRecord(
        job,
        state,
        signal,
        (current) => hasDefinitivelySettledActive(current) ? omitActive(current) : current,
        true,
      );
    });
  }

  async function recoverRestartClockRegression(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    const watermarkMs = new Date(state.durable.record.watermark).getTime();
    if (watermarkMs <= startedAt.getTime()) return;
    const from = new Date(watermarkMs).toISOString();
    const to = startedAt.toISOString();
    await mutateState(state, async () => {
      await updateRecord(job, state, signal, (current) => ({
        ...current,
        issue: current.issue ?? {
          status: "clock-regressed",
          observedAt: to,
          scheduledAt: to,
        },
        clockRegressions: current.clockRegressions + 1,
        lastClockRegression: { from, to },
      }));
    });
  }

  async function recoverUnknownOutcome(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    if (state.durable.record.issue !== undefined) return;
    const active = state.durable.record.active;
    if (active !== undefined) {
      state.foreignBlocked = true;
      state.unsettledIssue = {
        status: "unknown",
        observedAt: startedAt.toISOString(),
        scheduledAt: active.scheduledAt,
      };
      return;
    }
    const scheduledAt = state.durable.record.lastOutcome?.status === "unknown"
      ? state.durable.record.lastOutcome.scheduledAt
      : undefined;
    if (scheduledAt === undefined) return;
    await mutateState(state, async () => {
      await updateRecord(job, state, signal, (current) => {
        const unknownAt = current.active?.scheduledAt
          ?? (current.lastOutcome?.status === "unknown"
            ? current.lastOutcome.scheduledAt
            : undefined);
        if (unknownAt === undefined || current.issue !== undefined) return current;
        return {
          ...current,
          issue: {
            status: "unknown",
            observedAt: startedAt.toISOString(),
            scheduledAt: unknownAt,
          },
        };
      });
    });
  }

  async function replaceChangedSchedule(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    await mutateState(state, async () => {
      await updateRecord(job, state, signal, (current) => {
        if (current.scheduleFingerprint === scheduleFingerprint(job)) return current;
        if (current.active !== undefined) return current;
        const watermark = new Date(Math.max(
          new Date(current.watermark).getTime(),
          startedAt.getTime(),
        )).toISOString();
        return {
          ...initialDurableRecord(job, new Date(watermark)),
          issue: current.issue ?? {
            status: "missed",
            observedAt: startedAt.toISOString(),
            scheduledAt: watermark,
          },
          missed: mergeMissed(current.missed, current.watermark, watermark),
          clockRegressions: current.clockRegressions,
          ...(current.lastClockRegression === undefined
            ? {}
            : { lastClockRegression: current.lastClockRegression }),
        };
      }, true);
    });
    state.scheduleTransition =
      state.durable.record.scheduleFingerprint !== scheduleFingerprint(job);
    if (state.scheduleTransition) {
      state.foreignBlocked = true;
      const active = state.durable.record.active;
      state.unsettledIssue ??= {
        status: "unknown",
        observedAt: startedAt.toISOString(),
        scheduledAt: active?.scheduledAt ?? state.durable.record.watermark,
      };
      return;
    }
    state.foreignBlocked = false;
    if (state.durable.record.issue === undefined) delete state.unsettledIssue;
  }

  async function initializeJob(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    state.observedClockMs = startedAt.getTime();
    if (capability === undefined) {
      state.durable = {
        version: null,
        record: initialDurableRecord(job, startedAt),
      };
      return;
    }
    const key = durableJobKey(instanceId, job.id);
    for (let attempt = 0; attempt < DURABLE_CAS_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal, "Cron durable state initialization was aborted.");
      const found = await capability.read({ key, signal });
      if (found !== undefined) {
        const parsed = parseDurableRecord(found.value, job);
        state.durable = { record: parsed, version: found.version };
        await recoverDefinitivelySettledActive(job, state, signal);
        if (state.durable.record.scheduleFingerprint !== scheduleFingerprint(job)) {
          await replaceChangedSchedule(job, state, startedAt, signal);
        }
        if (!state.scheduleTransition) {
          await recoverRestartClockRegression(job, state, startedAt, signal);
        }
        await recoverUnknownOutcome(job, state, startedAt, signal);
        return;
      }
      const record = initialDurableRecord(job, startedAt);
      const result = await capability.compareAndSwap({
        key,
        expectedVersion: null,
        value: encodeDurableRecord(record),
        signal,
      });
      if (result.status === "applied") {
        state.durable = { record, version: result.version };
        return;
      }
    }
    throw new Error(`Cron durable state for job "${job.id}" changed repeatedly during initialization.`);
  }

  async function accountClockRegression(
    job: CronJob,
    state: JobState,
    now: Date,
  ): Promise<void> {
    const previous = state.observedClockMs;
    if (state.pendingClockRegression === undefined && now.getTime() < previous) {
      state.pendingClockRegression = {
        from: new Date(previous).toISOString(),
        to: now.toISOString(),
      };
      state.unsettledIssue ??= {
        status: "clock-regressed",
        observedAt: now.toISOString(),
        scheduledAt: now.toISOString(),
      };
    }
    const pending = state.pendingClockRegression;
    if (pending === undefined) {
      state.observedClockMs = now.getTime();
      return;
    }
    await mutateState(state, async () => {
      await updateRecord(job, state, new AbortController().signal, (current) => {
        if (
          current.lastClockRegression?.from === pending.from
          && current.lastClockRegression.to === pending.to
        ) return current;
        return {
          ...current,
          issue: current.issue ?? {
            status: "clock-regressed",
            observedAt: pending.to,
            scheduledAt: pending.to,
          },
          clockRegressions: current.clockRegressions + 1,
          lastClockRegression: pending,
        };
      });
    });
    if (
      state.durable.record.lastClockRegression?.from !== pending.from
      || state.durable.record.lastClockRegression.to !== pending.to
    ) {
      throw new Error(`Cron durable clock regression for job "${job.id}" was not recorded.`);
    }
    state.observedClockMs = now.getTime();
    delete state.pendingClockRegression;
    if (!hasPendingDurableRepair(state)) delete state.persistenceError;
  }

  async function refreshJob(job: CronJob, state: JobState): Promise<void> {
    if (capability === undefined) return;
    await mutateState(state, async () => {
      const found = await capability.read({
        key: durableJobKey(instanceId, job.id),
        signal: new AbortController().signal,
      });
      if (found === undefined) {
        throw new Error(`Cron durable state for job "${job.id}" disappeared during reconciliation.`);
      }
      const record = parseDurableRecord(found.value, job);
      state.durable = {
        record,
        version: found.version,
      };
      if (
        !state.scheduleTransition
        && record.scheduleFingerprint !== scheduleFingerprint(job)
      ) {
        fenceScheduleGeneration(state);
        throw new Error(`Cron schedule generation for job "${job.id}" was replaced.`);
      }
    });
  }

  async function recordMissedRange(
    job: CronJob,
    state: JobState,
    from: Date,
    through: Date,
    observedAt: Date,
  ): Promise<void> {
    const fromIso = from.toISOString();
    const throughIso = through.toISOString();
    const idempotencyKey = cronIdempotencyKey(instanceId, job.id, throughIso);
    await mutateState(state, async () => {
      await updateRecord(job, state, new AbortController().signal, (current) => {
        if (new Date(current.watermark).getTime() >= through.getTime()) return current;
        return {
          ...current,
          watermark: throughIso,
          lastOutcome: {
            status: "missed",
            scheduledAt: throughIso,
            idempotencyKey,
          },
          issue: current.issue ?? {
            status: "missed",
            observedAt: observedAt.toISOString(),
            scheduledAt: throughIso,
          },
          missed: mergeMissed(current.missed, fromIso, throughIso),
        };
      });
      state.lastResult = {
        status: "missed",
        jobId: job.id,
        scheduledAt: throughIso,
        idempotencyKey,
        reason: `Catch-up was bounded; overdue firings from ${fromIso} through ${throughIso} were recorded as missed.`,
      };
    });
  }

  async function claimActive(
    job: CronJob,
    state: JobState,
    scheduledAt: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    let claimed = false;
    await mutateState(state, async () => {
      await updateRecord(job, state, new AbortController().signal, (current) => {
        claimed = false;
        if (
          current.active?.ownerId === ownerId
          && current.active.idempotencyKey === idempotencyKey
        ) {
          claimed = true;
          return current;
        }
        if (current.active !== undefined) return current;
        claimed = true;
        return {
          ...current,
          active: {
            ownerId,
            idempotencyKey,
            scheduledAt,
            claimedAt: validClockInstant(clock).toISOString(),
          },
        };
      });
    });
    return claimed;
  }

  async function clearActive(
    job: CronJob,
    state: JobState,
    idempotencyKey: string,
  ): Promise<boolean> {
    let cleared = false;
    await mutateState(state, async () => {
      await updateRecord(job, state, new AbortController().signal, (current) => {
        if (current.active === undefined) {
          cleared = true;
          return current;
        }
        if (
          current.active.ownerId !== ownerId
          || current.active.idempotencyKey !== idempotencyKey
        ) return current;
        cleared = true;
        return omitActive(current);
      }, true);
    });
    return cleared;
  }

  async function settleInvocation(
    job: CronJob,
    state: JobState,
    result: CronInvocationResult,
  ): Promise<CronInvocationResult> {
    try {
      await mutateState(state, async () => {
        await updateRecord(job, state, new AbortController().signal, (current) => {
          const issue = issueForResult(
            current.issue ?? state.unsettledIssue,
            result,
            validClockInstant(clock).toISOString(),
          );
          if (current.lastOutcome?.idempotencyKey !== result.idempotencyKey) {
            return issue === undefined || issue === current.issue
              ? current
              : { ...current, issue };
          }
          return {
            ...current,
            lastOutcome: {
              status: result.status,
              scheduledAt: result.scheduledAt,
              idempotencyKey: result.idempotencyKey,
            },
            ...(issue === undefined ? {} : { issue }),
          };
        });
      });
      if (!hasPendingDurableRepair(state)) {
        delete state.persistenceError;
        delete state.unsettledIssue;
      }
      return result;
    } catch (error) {
      state.persistenceError = stablePersistenceFailure(error);
      state.unsettledIssue ??= {
        status: "unknown",
        observedAt: validClockInstant(clock).toISOString(),
        scheduledAt: result.scheduledAt,
      };
      return {
        status: "unknown",
        jobId: result.jobId,
        scheduledAt: result.scheduledAt,
        idempotencyKey: result.idempotencyKey,
        reason: "Cron received an outcome but could not durably settle it; effects remain unknown.",
      };
    }
  }

  return {
    initializeJob,
    recoverDefinitivelySettledActive,
    replaceChangedSchedule,
    accountClockRegression,
    refreshJob,
    recordMissedRange,
    claimActive,
    clearActive,
    settleInvocation,
    updateRecord,
  };
}

export function readDurableStateCapability(
  host: TriggerHost,
): CronDurableStateCapability | undefined {
  if (!host.grantedCapabilities.has(HOST_CAPABILITY_CRON_DURABLE_STATE)) return undefined;
  const capability = host.getCapability<unknown>(HOST_CAPABILITY_CRON_DURABLE_STATE);
  if (typeof capability !== "object" || capability === null) {
    throw new TypeError("cron.durable-state.v1 grant must be an object.");
  }
  const read = Reflect.get(capability, "read");
  const compareAndSwap = Reflect.get(capability, "compareAndSwap");
  if (typeof read !== "function" || typeof compareAndSwap !== "function") {
    throw new TypeError("cron.durable-state.v1 grant must expose read and compareAndSwap.");
  }
  return capability as CronDurableStateCapability;
}

export function initialDurableRecord(job: CronJob, now: Date): DurableJobRecord {
  return {
    schemaVersion: 1,
    jobId: job.id,
    scheduleFingerprint: scheduleFingerprint(job),
    watermark: now.toISOString(),
    clockRegressions: 0,
  };
}

function omitActive(record: DurableJobRecord): DurableJobRecord {
  const { active: _active, ...remaining } = record;
  return remaining;
}

function hasDefinitivelySettledActive(record: DurableJobRecord): boolean {
  return record.active !== undefined
    && record.lastOutcome?.idempotencyKey === record.active.idempotencyKey
    && record.lastOutcome.status !== "unknown";
}

function scheduleFingerprint(job: CronJob): string {
  return createHash("sha256")
    .update(JSON.stringify([1, job.id, job.expression, job.timezone]), "utf8")
    .digest("hex");
}

function durableJobKey(instanceId: string, jobId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, instanceId, jobId]), "utf8")
    .digest("hex");
  return `trigger-cron/v1/jobs/${digest}`;
}

function mergeMissed(
  current: DurableMissedRange | undefined,
  from: string,
  through: string,
): DurableMissedRange {
  if (current === undefined) return { ranges: 1, atLeast: 1, from, through };
  return {
    ranges: Math.min(Number.MAX_SAFE_INTEGER, current.ranges + 1),
    atLeast: Math.min(Number.MAX_SAFE_INTEGER, current.atLeast + 1),
    from: new Date(current.from).getTime() <= new Date(from).getTime() ? current.from : from,
    through: new Date(current.through).getTime() >= new Date(through).getTime()
      ? current.through
      : through,
  };
}

function issueForResult(
  current: DurableHealthIssue | undefined,
  result: CronInvocationResult,
  observedAt: string,
): DurableHealthIssue | undefined {
  if (current !== undefined) return current;
  if (result.status !== "rejected" && result.status !== "unknown" && result.status !== "missed") {
    return undefined;
  }
  return {
    status: result.status,
    observedAt,
    scheduledAt: result.scheduledAt,
  };
}

function encodeDurableRecord(record: DurableJobRecord): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > DURABLE_RECORD_BYTES) {
    throw new Error("Cron durable state record exceeds its byte limit.");
  }
  return bytes;
}

function parseDurableRecord(value: Uint8Array, job: CronJob): DurableJobRecord {
  if (value.byteLength === 0 || value.byteLength > DURABLE_RECORD_BYTES) {
    throw new Error(`Cron durable state for job "${job.id}" has an invalid size.`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`Cron durable state for job "${job.id}" is not valid UTF-8.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error(`Cron durable state for job "${job.id}" is not valid JSON.`);
  }
  const input = exactRecord(parsed, [
    "schemaVersion",
    "jobId",
    "scheduleFingerprint",
    "watermark",
    "active",
    "lastOutcome",
    "issue",
    "missed",
    "clockRegressions",
    "lastClockRegression",
  ], `Cron durable state for job "${job.id}"`);
  if (input.schemaVersion !== 1 || input.jobId !== job.id) {
    throw new Error(`Cron durable state for job "${job.id}" has the wrong identity or schema version.`);
  }
  const schedule = boundedString(input.scheduleFingerprint, "scheduleFingerprint", 64);
  if (!/^[a-f0-9]{64}$/u.test(schedule)) {
    throw new Error(`Cron durable state for job "${job.id}" has an invalid schedule fingerprint.`);
  }
  const watermark = canonicalInstant(input.watermark, "watermark");
  const clockRegressions = boundedInteger(input.clockRegressions, "clockRegressions");
  const active = input.active === undefined ? undefined : parseActive(input.active);
  const lastOutcome = input.lastOutcome === undefined
    ? undefined
    : parseOutcome(input.lastOutcome);
  const issue = input.issue === undefined ? undefined : parseIssue(input.issue);
  const missed = input.missed === undefined ? undefined : parseMissed(input.missed);
  const lastClockRegression = input.lastClockRegression === undefined
    ? undefined
    : parseClockRegression(input.lastClockRegression);
  return {
    schemaVersion: 1,
    jobId: job.id,
    scheduleFingerprint: schedule,
    watermark,
    ...(active === undefined ? {} : { active }),
    ...(lastOutcome === undefined ? {} : { lastOutcome }),
    ...(issue === undefined ? {} : { issue }),
    ...(missed === undefined ? {} : { missed }),
    clockRegressions,
    ...(lastClockRegression === undefined ? {} : { lastClockRegression }),
  };
}

function parseActive(value: unknown): DurableActiveInvocation {
  const input = exactRecord(
    value,
    ["ownerId", "idempotencyKey", "scheduledAt", "claimedAt"],
    "Cron durable active invocation",
  );
  const ownerId = boundedString(input.ownerId, "ownerId", 64);
  if (!/^[a-f0-9-]{36}$/u.test(ownerId)) {
    throw new Error("Cron durable active invocation has an invalid owner id.");
  }
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey", 80);
  if (!/^cron:v1:[a-f0-9]{64}$/u.test(idempotencyKey)) {
    throw new Error("Cron durable active invocation has an invalid idempotency key.");
  }
  return {
    ownerId,
    idempotencyKey,
    scheduledAt: canonicalInstant(input.scheduledAt, "scheduledAt"),
    claimedAt: canonicalInstant(input.claimedAt, "claimedAt"),
  };
}

function parseOutcome(value: unknown): DurableOutcome {
  const input = exactRecord(
    value,
    ["status", "scheduledAt", "idempotencyKey"],
    "Cron durable outcome",
  );
  if (
    typeof input.status !== "string"
    || !OUTCOME_STATUSES.has(input.status as CronInvocationStatus)
  ) {
    throw new Error("Cron durable outcome has an invalid status.");
  }
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey", 80);
  if (!/^cron:v1:[a-f0-9]{64}$/u.test(idempotencyKey)) {
    throw new Error("Cron durable outcome has an invalid idempotency key.");
  }
  return {
    status: input.status as CronInvocationStatus,
    scheduledAt: canonicalInstant(input.scheduledAt, "scheduledAt"),
    idempotencyKey,
  };
}

function parseIssue(value: unknown): DurableHealthIssue {
  const input = exactRecord(
    value,
    ["status", "observedAt", "scheduledAt"],
    "Cron durable health issue",
  );
  if (
    typeof input.status !== "string"
    || !ISSUE_STATUSES.has(input.status as CronHealthIssueStatus)
  ) {
    throw new Error("Cron durable health issue has an invalid status.");
  }
  return {
    status: input.status as CronHealthIssueStatus,
    observedAt: canonicalInstant(input.observedAt, "observedAt"),
    scheduledAt: canonicalInstant(input.scheduledAt, "scheduledAt"),
  };
}

function parseMissed(value: unknown): DurableMissedRange {
  const input = exactRecord(
    value,
    ["ranges", "atLeast", "from", "through"],
    "Cron durable missed range",
  );
  const from = canonicalInstant(input.from, "from");
  const through = canonicalInstant(input.through, "through");
  if (new Date(from).getTime() > new Date(through).getTime()) {
    throw new Error("Cron durable missed range is reversed.");
  }
  return {
    ranges: positiveBoundedInteger(input.ranges, "ranges"),
    atLeast: positiveBoundedInteger(input.atLeast, "atLeast"),
    from,
    through,
  };
}

function parseClockRegression(value: unknown): DurableClockRegression {
  const input = exactRecord(value, ["from", "to"], "Cron durable clock regression");
  const from = canonicalInstant(input.from, "from");
  const to = canonicalInstant(input.to, "to");
  if (new Date(from).getTime() <= new Date(to).getTime()) {
    throw new Error("Cron durable clock regression must move backward.");
  }
  return { from, to };
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain object.`);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown fields.`);
  return input;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Cron durable ${field} is invalid.`);
  }
  return value;
}

function canonicalInstant(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Cron durable ${field} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Cron durable ${field} is invalid.`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Cron durable ${field} is invalid.`);
  }
  return value as number;
}

function positiveBoundedInteger(value: unknown, field: string): number {
  const parsed = boundedInteger(value, field);
  if (parsed === 0) throw new Error(`Cron durable ${field} is invalid.`);
  return parsed;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

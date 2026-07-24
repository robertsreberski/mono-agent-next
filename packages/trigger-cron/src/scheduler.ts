import { createHash, randomUUID } from "node:crypto";

import type {
  JsonObject,
  JsonValue,
  ModuleCommand,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStartContext,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import type { Trigger, TriggerHost, TriggerReceipt } from "@mono-agent/module-sdk/internal";

import type { CronJob } from "./jobs.js";
import {
  nextCronOccurrence,
  previousCronOccurrence,
} from "./jobs.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
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
export const MAX_CRON_CATCH_UP = 32;

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

export interface CronTimerHandle {}

export interface CronClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): CronTimerHandle;
  clearTimeout(handle: CronTimerHandle): void;
}

export const systemCronClock: CronClock = Object.freeze({
  now: () => new Date(),
  setTimeout(callback: () => void, delayMs: number): CronTimerHandle {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle: CronTimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export type CronInvocationSource = "schedule" | "command" | "recovery";
export type CronInvocationStatus =
  | "accepted"
  | "rejected"
  | "duplicate"
  | "skipped"
  | "queued"
  | "dropped"
  | "cancelled"
  | "unknown"
  | "missed";

export type CronInvocationResult =
  | {
      readonly status: "accepted" | "rejected";
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly idempotencyKey: string;
      readonly runId?: string;
      readonly reason?: string;
    }
  | {
      readonly status: Exclude<CronInvocationStatus, "accepted" | "rejected">;
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly idempotencyKey: string;
      readonly reason: string;
    };

export interface CreateCronTriggerOptions {
  readonly instanceId: string;
  readonly jobs: readonly CronJob[];
  readonly host: TriggerHost;
  readonly clock?: CronClock;
  readonly signal?: AbortSignal;
}

export interface CronTrigger extends Trigger {
  readonly jobs: readonly CronJob[];
  invoke(jobId: string, scheduledAt?: string): Promise<CronInvocationResult>;
}

interface PendingInvocation {
  readonly job: CronJob;
  readonly scheduledAt: string;
  readonly source: CronInvocationSource;
  readonly idempotencyKey: string;
  readonly resolve: (result: CronInvocationResult) => void;
}

interface ActiveInvocation {
  readonly controller: AbortController;
  readonly idempotencyKey: string;
  readonly settled: Promise<void>;
  readonly releasePending: boolean;
}

interface DurableActiveInvocation {
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

type CronHealthIssueStatus = "missed" | "rejected" | "unknown" | "clock-regressed";

interface DurableHealthIssue {
  readonly status: CronHealthIssueStatus;
  readonly observedAt: string;
  readonly scheduledAt: string;
}

interface DurableMissedRange {
  readonly ranges: number;
  readonly atLeast: number;
  readonly from: string;
  readonly through: string;
}

interface DurableClockRegression {
  readonly from: string;
  readonly to: string;
}

interface DurableJobRecord {
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

interface DurableEnvelope {
  readonly record: DurableJobRecord;
  readonly version: string | null;
}

interface JobState {
  timer: CronTimerHandle | undefined;
  target: Date | undefined;
  active: ActiveInvocation | undefined;
  pending: PendingInvocation[];
  durable: DurableEnvelope;
  mutation: Promise<void>;
  emitted: number;
  lastResult?: CronInvocationResult;
  observedClockMs: number;
  pendingClockRegression?: DurableClockRegression;
  persistenceError?: string;
  unsettledIssue?: DurableHealthIssue;
  reconciling: boolean;
  reconcileRequested?: CronInvocationSource;
  reconcileDone?: Promise<void>;
  foreignBlocked: boolean;
  scheduleTransition: boolean;
  generationFenced: boolean;
}

interface DueSet {
  readonly selected: readonly Date[];
  readonly missed?: { readonly from: Date; readonly through: Date };
}

export function createCronTrigger(options: CreateCronTriggerOptions): CronTrigger {
  const clock = options.clock ?? systemCronClock;
  const jobs = Object.freeze([...options.jobs]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  if (jobsById.size !== jobs.length) throw new Error("Cron job ids must be unique.");
  const durableState = readDurableStateCapability(options.host);
  const ownerId = randomUUID();
  const initialNow = validClockInstant(clock);
  const states = new Map(jobs.map((job) => [
    job.id,
    createJobState(job, initialNow),
  ]));
  let lifecycle: "new" | "starting" | "running" | "stopping" | "stopped" = "new";

  const start = async (context: ModuleStartContext): Promise<void> => {
    if (lifecycle === "running") return;
    if (lifecycle !== "new") throw new Error(`Cron trigger cannot start from ${lifecycle}.`);
    throwIfAborted(options.signal, "Cron trigger creation was aborted.");
    throwIfAborted(context.signal, "Cron trigger start was aborted.");
    lifecycle = "starting";
    const startedAt = validClockInstant(clock);
    const startSignal = options.signal === undefined
      ? context.signal
      : AbortSignal.any([context.signal, options.signal]);
    try {
      for (const job of jobs) {
        await initializeDurableJob(job, states.get(job.id)!, startedAt, startSignal);
      }
      throwIfAborted(startSignal, "Cron trigger start was aborted.");
      if (lifecycle !== "starting") throw new Error("Cron trigger stopped during startup.");
    } catch (error) {
      if (lifecycle === "starting") lifecycle = "new";
      throw error;
    }
    lifecycle = "running";
    for (const job of jobs) {
      scheduleNext(job);
      void reconcile(job, "recovery");
    }
  };

  const stop = async (context?: ModuleStopContext): Promise<void> => {
    if (lifecycle === "stopped") return;
    lifecycle = "stopping";
    const active: Promise<void>[] = [];
    const background: Promise<void>[] = [];
    const settlements: Promise<void>[] = [];
    for (const state of states.values()) {
      if (state.timer !== undefined) clock.clearTimeout(state.timer);
      state.timer = undefined;
      state.target = undefined;
      state.active?.controller.abort(new Error("Cron trigger stopped."));
      if (state.active !== undefined) active.push(state.active.settled);
      if (state.reconcileDone !== undefined) background.push(state.reconcileDone);
      for (const pending of state.pending.splice(0)) {
        settlements.push(completePending(
          pending,
          terminal(pending, "cancelled", "Cron trigger stopped before emission."),
          state,
        ));
      }
    }
    await waitForStopWork(
      Promise.all([...active, ...background, ...settlements]).then(() => undefined),
      context?.signal,
    );
    lifecycle = "stopped";
  };

  const invoke = async (jobId: string, scheduledAt?: string): Promise<CronInvocationResult> => {
    if (lifecycle !== "running") throw new Error(`Cron trigger is not running (${lifecycle}).`);
    const job = jobsById.get(jobId);
    if (job === undefined) throw new Error(`Unknown cron job "${jobId}".`);
    const now = validClockInstant(clock);
    const instant = scheduledAt === undefined ? now.toISOString() : normalizeInstant(scheduledAt);
    if (new Date(instant).getTime() > now.getTime()) {
      throw new RangeError("trigger-cron:invoke scheduledAt must not be in the future.");
    }
    return await admit(job, instant, "command");
  };

  const commands: readonly ModuleCommand[] = Object.freeze([{
    name: "trigger-cron:invoke",
    kind: "maintenance",
    description: "Invoke one configured cron job at an explicit deterministic instant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string", minLength: 1, maxLength: 128 },
        scheduledAt: { type: "string", format: "date-time" },
      },
      required: ["jobId"],
    },
    async run(input: unknown): Promise<JsonValue> {
      const parsed = parseInvokeInput(input);
      return invocationResultToJson(await invoke(parsed.jobId, parsed.scheduledAt));
    },
  }]);

  options.signal?.addEventListener("abort", () => { void stop(); }, { once: true });

  return {
    jobs,
    commands,
    start,
    async drain(): Promise<void> {
      await stop();
    },
    stop,
    async health(_context: ModuleHealthContext): Promise<ModuleHealth> {
      const active = [...states.values()].filter((state) => state.active !== undefined).length;
      const queued = [...states.values()].reduce((count, state) => count + state.pending.length, 0);
      const issues: Record<string, JsonValue> = {};
      const persistenceFailures: string[] = [];
      for (const [jobId, state] of states) {
        const issue = state.durable.record.issue ?? state.unsettledIssue;
        if (issue !== undefined) {
          issues[jobId] = {
            status: issue.status,
            scheduledAt: issue.scheduledAt,
            observedAt: issue.observedAt,
          };
        }
        if (state.persistenceError !== undefined) persistenceFailures.push(jobId);
      }
      const durable = durableState !== undefined;
      const degraded = lifecycle === "stopping"
        || !durable
        || Object.keys(issues).length > 0
        || persistenceFailures.length > 0;
      return {
        status: lifecycle === "running"
          ? degraded ? "degraded" : "healthy"
          : lifecycle === "stopping" ? "degraded" : "unknown",
        checkedAt: validClockInstant(clock).toISOString(),
        summary: !durable
          ? "Cron is running without a durable state grant; restart replay safety is unavailable."
          : Object.keys(issues).length > 0
            ? "Cron has unresolved missed, rejected, unknown, or clock-regression outcomes."
            : persistenceFailures.length > 0
              ? "Cron cannot currently prove durable scheduler state."
              : "Cron schedules and durable watermarks are ready.",
        details: {
          jobs: jobs.length,
          active,
          queued,
          lifecycle,
          durability: durable ? "available" : "unavailable",
          issues,
          persistenceFailures,
        },
      };
    },
    invoke,
  };

  async function initializeDurableJob(
    job: CronJob,
    state: JobState,
    startedAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    state.observedClockMs = startedAt.getTime();
    if (durableState === undefined) {
      state.durable = {
        version: null,
        record: initialDurableRecord(job, startedAt),
      };
      return;
    }
    const key = durableJobKey(options.instanceId, job.id);
    for (let attempt = 0; attempt < DURABLE_CAS_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal, "Cron durable state initialization was aborted.");
      const found = await durableState.read({ key, signal });
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
      const result = await durableState.compareAndSwap({
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

  async function reconcile(job: CronJob, source: CronInvocationSource): Promise<void> {
    const state = states.get(job.id)!;
    if (lifecycle !== "running") return;
    if (state.reconciling) {
      state.reconcileRequested = source;
      return;
    }
    state.reconciling = true;
    let finishReconcile!: () => void;
    const reconcileDone = new Promise<void>((resolve) => { finishReconcile = resolve; });
    state.reconcileDone = reconcileDone;
    try {
      let recovered = 0;
      while (lifecycle === "running") {
        const now = validClockInstant(clock);
        if (
          state.generationFenced
          && state.active?.releasePending
          && !await repairDurableRelease(job, state)
        ) break;
        if (state.generationFenced) break;
        await refreshDurableJob(job, state);
        await recoverDefinitivelySettledActive(job, state, new AbortController().signal);
        if (state.scheduleTransition) {
          await replaceChangedSchedule(job, state, now, new AbortController().signal);
          if (state.scheduleTransition) break;
        }
        if (state.active?.releasePending && !await repairDurableRelease(job, state)) break;
        await accountClockRegression(job, state, now);
        const wasForeignBlocked = state.foreignBlocked;
        if (isForeignActive(state, ownerId)) {
          state.foreignBlocked = true;
          state.unsettledIssue ??= {
            status: "unknown",
            observedAt: now.toISOString(),
            scheduledAt: state.durable.record.active!.scheduledAt,
          };
          break;
        }
        state.foreignBlocked = false;
        if (
          wasForeignBlocked
          && state.durable.record.issue === undefined
          && state.durable.record.lastOutcome?.status !== "unknown"
        ) {
          delete state.unsettledIssue;
        }
        const watermarkMs = new Date(state.durable.record.watermark).getTime();
        const remaining = MAX_CRON_CATCH_UP - recovered;
        if (remaining === 0) {
          const missed = allDueRange(job, watermarkMs, now.getTime());
          if (missed !== undefined) {
            await recordMissedRange(job, state, missed.from, missed.through, now);
          }
          break;
        }
        const due = collectDue(job, watermarkMs, now.getTime(), remaining);
        if (due.missed !== undefined) {
          await recordMissedRange(job, state, due.missed.from, due.missed.through, now);
        }
        if (due.selected.length === 0) break;
        for (const target of due.selected) {
          if (lifecycle !== "running") return;
          await admit(job, target.toISOString(), source);
          if (state.foreignBlocked) return;
          recovered += 1;
        }
      }
    } catch (error) {
      state.persistenceError = stablePersistenceFailure(error);
    } finally {
      state.reconciling = false;
      finishReconcile();
      if (state.reconcileDone === reconcileDone) delete state.reconcileDone;
      const requested = state.reconcileRequested;
      delete state.reconcileRequested;
      if (lifecycle === "running") {
        if (requested === undefined) scheduleNext(job);
        else void reconcile(job, requested);
      }
    }
  }

  function scheduleNext(job: CronJob): void {
    if (lifecycle !== "running") return;
    const state = states.get(job.id)!;
    if (state.timer !== undefined) clock.clearTimeout(state.timer);
    state.timer = undefined;
    if (state.generationFenced && !state.active?.releasePending) {
      state.target = undefined;
      return;
    }
    const now = validClockInstant(clock);
    if (
      state.scheduleTransition
      || state.foreignBlocked
      || state.active?.releasePending
      || state.pendingClockRegression !== undefined
    ) {
      state.target = undefined;
      state.timer = clock.setTimeout(() => {
        state.timer = undefined;
        if (lifecycle === "running") void reconcile(job, "recovery");
      }, 1_000);
      return;
    }
    const base = new Date(Math.max(
      now.getTime(),
      new Date(state.durable.record.watermark).getTime(),
    ));
    arm(job, nextCronOccurrence(job, base));
  }

  function arm(job: CronJob, target: Date): void {
    const state = states.get(job.id);
    if (state === undefined || lifecycle !== "running") return;
    const remaining = Math.max(0, target.getTime() - validClockInstant(clock).getTime());
    state.target = target;
    state.timer = clock.setTimeout(() => {
      state.timer = undefined;
      if (lifecycle !== "running") return;
      const now = validClockInstant(clock);
      if (now.getTime() < target.getTime()) {
        const adjustment = accountClockRegression(job, state, now)
          .catch((error: unknown) => { state.persistenceError = stablePersistenceFailure(error); })
          .finally(() => {
            if (state.reconcileDone === adjustment) delete state.reconcileDone;
            if (lifecycle === "running") {
              if (state.pendingClockRegression === undefined) arm(job, target);
              else scheduleNext(job);
            }
          });
        state.reconcileDone = adjustment;
        return;
      }
      void reconcile(job, "schedule");
    }, Math.min(remaining, MAX_TIMEOUT_MS));
  }

  async function accountClockRegression(job: CronJob, state: JobState, now: Date): Promise<void> {
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

  async function refreshDurableJob(job: CronJob, state: JobState): Promise<void> {
    if (durableState === undefined) return;
    await mutateState(state, async () => {
      const found = await durableState.read({
        key: durableJobKey(options.instanceId, job.id),
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
    const idempotencyKey = cronIdempotencyKey(options.instanceId, job.id, throughIso);
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

  async function admit(
    job: CronJob,
    scheduledAt: string,
    source: CronInvocationSource,
  ): Promise<CronInvocationResult> {
    const state = states.get(job.id);
    if (state === undefined) throw new Error(`Missing scheduler state for ${job.id}.`);
    const scheduledMs = new Date(scheduledAt).getTime();
    const idempotencyKey = cronIdempotencyKey(options.instanceId, job.id, scheduledAt);
    if (state.generationFenced || state.scheduleTransition) {
      return {
        status: "rejected",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Cron schedule authority changed; this scheduler generation is fenced.",
      };
    }
    if (state.pendingClockRegression !== undefined) {
      scheduleNext(job);
      return {
        status: "rejected",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Cron is awaiting durable clock-regression evidence.",
      };
    }
    if (state.active?.releasePending) {
      scheduleNext(job);
      return {
        status: "skipped",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "A definitively settled firing is awaiting durable fence repair.",
      };
    }
    let blockedByActive: DurableActiveInvocation | undefined;
    try {
      const reserved = await mutateState(state, async () => {
        if (scheduledMs <= new Date(state.durable.record.watermark).getTime()) return false;
        const applied = await updateRecord(job, state, new AbortController().signal, (current) => {
          if (scheduledMs <= new Date(current.watermark).getTime()) return current;
          const currentActive = current.active;
          const locallyActive = currentActive !== undefined
            && currentActive.ownerId === ownerId
            && state.active?.idempotencyKey === currentActive.idempotencyKey;
          if (currentActive !== undefined && !locallyActive) {
            blockedByActive = currentActive;
            return current;
          }
          const priorUnknown = current.lastOutcome?.status === "unknown"
            && current.lastOutcome.idempotencyKey !== state.active?.idempotencyKey
            ? {
                status: "unknown" as const,
                observedAt: validClockInstant(clock).toISOString(),
                scheduledAt: current.lastOutcome.scheduledAt,
              }
            : undefined;
          const issue = current.issue ?? state.unsettledIssue ?? priorUnknown;
          const active = currentActive ?? {
            ownerId,
            idempotencyKey,
            scheduledAt,
            claimedAt: validClockInstant(clock).toISOString(),
          };
          return {
            ...current,
            watermark: scheduledAt,
            active,
            lastOutcome: {
              status: "unknown",
              scheduledAt,
              idempotencyKey,
            },
            ...(issue === undefined ? {} : { issue }),
          };
        });
        return applied
          && scheduledMs <= new Date(state.durable.record.watermark).getTime()
          && state.durable.record.lastOutcome?.idempotencyKey === idempotencyKey;
      });
      if (!reserved || state.durable.record.lastOutcome?.idempotencyKey !== idempotencyKey) {
        if (blockedByActive !== undefined) {
          state.foreignBlocked = true;
          state.unsettledIssue ??= {
            status: "unknown",
            observedAt: validClockInstant(clock).toISOString(),
            scheduledAt: blockedByActive.scheduledAt,
          };
          return {
            status: "skipped",
            jobId: job.id,
            scheduledAt,
            idempotencyKey,
            reason: "Another scheduler owner has an unresolved in-flight firing.",
          };
        }
        return {
          status: "duplicate",
          jobId: job.id,
          scheduledAt,
          idempotencyKey,
          reason: "This job instant was already admitted or is older than the durable run watermark.",
        };
      }
      state.foreignBlocked = false;
      if (!hasPendingDurableRepair(state)) {
        delete state.persistenceError;
        delete state.unsettledIssue;
      }
    } catch (error) {
      state.persistenceError = stablePersistenceFailure(error);
      return {
        status: "rejected",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Cron could not durably reserve this firing; no emission was attempted.",
      };
    }
    if (lifecycle !== "running") {
      try {
        await clearDurableActive(job, state, idempotencyKey);
      } catch {
        state.persistenceError = "durable_state_unavailable";
      }
      return await settleInvocation(job, state, {
        status: "cancelled",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Cron trigger stopped after durable admission and before emission.",
      });
    }
    if (state.active === undefined) return await runNow(job, scheduledAt, source, idempotencyKey, state);
    if (job.overlap === "skip") {
      return await settleInvocation(job, state, {
        status: "skipped",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "A prior firing is still active.",
      });
    }
    return await new Promise<CronInvocationResult>((resolve) => {
      const pending: PendingInvocation = { job, scheduledAt, source, idempotencyKey, resolve };
      if (job.overlap === "replace") {
        for (const displaced of state.pending.splice(0)) {
          void completePending(
            displaced,
            terminal(displaced, "dropped", "Replaced by a newer firing."),
            state,
          );
        }
        state.pending.push(pending);
        state.active?.controller.abort(new Error("Cron firing replaced by a newer firing."));
        return;
      }
      if (state.pending.length < job.maxQueueDepth) {
        state.pending.push(pending);
        return;
      }
      if (job.overflow === "drop-oldest") {
        const displaced = state.pending.shift();
        if (displaced !== undefined) {
          void completePending(
            displaced,
            terminal(displaced, "dropped", "Cron queue dropped its oldest firing."),
            state,
          );
        }
        state.pending.push(pending);
        return;
      }
      if (job.overflow === "coalesce") {
        for (const displaced of state.pending.splice(0)) {
          void completePending(
            displaced,
            terminal(displaced, "dropped", "Cron queue coalesced to its newest firing."),
            state,
          );
        }
        state.pending.push(pending);
        return;
      }
      void settleInvocation(
        job,
        state,
        terminal(pending, "dropped", "Cron queue is full."),
      ).then(resolve);
    });
  }

  async function claimDurableActive(
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

  async function clearDurableActive(
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

  async function repairDurableRelease(job: CronJob, state: JobState): Promise<boolean> {
    const active = state.active;
    if (active === undefined || !active.releasePending) return true;
    try {
      if (!await clearDurableActive(job, state, active.idempotencyKey)) {
        state.persistenceError = "durable_state_active_conflict";
        return false;
      }
    } catch (error) {
      state.persistenceError = stablePersistenceFailure(error);
      return false;
    }
    if (state.active?.idempotencyKey !== active.idempotencyKey) return true;
    state.active = undefined;
    if (!hasPendingDurableRepair(state)) delete state.persistenceError;
    const next = state.pending.shift();
    if (next !== undefined && lifecycle === "running" && !state.generationFenced) {
      void runNow(next.job, next.scheduledAt, next.source, next.idempotencyKey, state).then(next.resolve);
    } else if (next !== undefined) {
      for (const pending of [next, ...state.pending.splice(0)]) {
        void completePending(
          pending,
          terminal(pending, "cancelled", "Cron trigger stopped or changed schedule before emission."),
          state,
        );
      }
    }
    return true;
  }

  async function runNow(
    job: CronJob,
    scheduledAt: string,
    source: CronInvocationSource,
    idempotencyKey: string,
    state: JobState,
  ): Promise<CronInvocationResult> {
    try {
      if (!await claimDurableActive(job, state, scheduledAt, idempotencyKey)) {
        state.unsettledIssue ??= {
          status: "unknown",
          observedAt: validClockInstant(clock).toISOString(),
          scheduledAt,
        };
        return await settleInvocation(job, state, {
          status: "skipped",
          jobId: job.id,
          scheduledAt,
          idempotencyKey,
          reason: "Another scheduler owner has an unresolved in-flight firing.",
        });
      }
    } catch {
      state.persistenceError = "durable_state_unavailable";
      return {
        status: "rejected",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Cron could not durably claim this firing; no emission was attempted.",
      };
    }
    const controller = new AbortController();
    let finishSettlement!: () => void;
    const settled = new Promise<void>((resolve) => { finishSettlement = resolve; });
    state.active = { controller, idempotencyKey, settled, releasePending: false };
    const invokedAt = validClockInstant(clock).toISOString();
    let watchdog: CronTimerHandle | undefined;
    const timeout = new Promise<CronInvocationResult>((resolve) => {
      watchdog = clock.setTimeout(() => {
        controller.abort(new Error(`Cron job exceeded its ${String(job.maxRunMs)} ms watchdog.`));
        resolve({
          status: "unknown",
          jobId: job.id,
          scheduledAt,
          idempotencyKey,
          reason: "The cron watchdog aborted an emission whose final effects are unknown.",
        });
      }, job.maxRunMs);
    });
    const cancellation = new Promise<CronInvocationResult>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        resolve({
          status: "unknown",
          jobId: job.id,
          scheduledAt,
          idempotencyKey,
          reason: "Cron emission was interrupted after durable admission; its final effects are unknown.",
        });
      }, { once: true });
    });
    const channel = deliveryChannel(job);
    let emissionSettled = false;
    const emission = Promise.resolve().then(async () => {
      throwIfAborted(controller.signal, "Cron emission was cancelled before dispatch.");
      return await options.host.emit({
        id: idempotencyKey,
        triggerInstanceId: options.instanceId,
        prompt: job.prompt,
        createdAt: invokedAt,
        ...(job.runtime === undefined ? {} : { runtime: job.runtime }),
        ...(job.model === undefined ? {} : { model: job.model }),
        ...(channel === undefined ? {} : { deliveryChannel: channel }),
        metadata: cronMetadata(job, scheduledAt, invokedAt, idempotencyKey, source),
      }, controller.signal);
    }).then(
      (receipt) => receiptResult(job, scheduledAt, idempotencyKey, receipt),
      () => ({
        status: "unknown" as const,
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Trigger emission ended without a definitive receipt; effects may have occurred.",
      }),
    ).finally(() => {
      emissionSettled = true;
    });
    let result = await Promise.race([emission, timeout, cancellation]);
    if (watchdog !== undefined) clock.clearTimeout(watchdog);
    result = await settleInvocation(job, state, result);
    finishSettlement();
    state.emitted += 1;
    state.lastResult = result;
    const release = async (): Promise<void> => {
      if (state.active?.idempotencyKey !== idempotencyKey) return;
      state.active = { ...state.active, releasePending: true };
      if (!await repairDurableRelease(job, state) && lifecycle === "running") {
        scheduleNext(job);
      }
    };
    if (emissionSettled) await release();
    else void emission.then(release, release);
    return result;
  }

  async function completePending(
    pending: PendingInvocation,
    result: CronInvocationResult,
    state: JobState,
  ): Promise<void> {
    pending.resolve(await settleInvocation(pending.job, state, result));
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
      if (durableState === undefined) {
        state.durable = { record: next, version: null };
        return true;
      }
      const key = durableJobKey(options.instanceId, job.id);
      const result = await durableState.compareAndSwap({
        key,
        expectedVersion: current.version,
        value: encodeDurableRecord(next),
        signal,
      });
      if (result.status === "applied") {
        state.durable = { record: next, version: result.version };
        return true;
      }
      const found = await durableState.read({ key, signal });
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
}

export function cronIdempotencyKey(instanceId: string, jobId: string, scheduledAt: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, instanceId, jobId, scheduledAt]), "utf8")
    .digest("hex");
  return `cron:v1:${digest}`;
}

function createJobState(job: CronJob, now: Date): JobState {
  return {
    timer: undefined,
    target: undefined,
    active: undefined,
    pending: [],
    durable: { record: initialDurableRecord(job, now), version: null },
    mutation: Promise.resolve(),
    emitted: 0,
    observedClockMs: now.getTime(),
    reconciling: false,
    foreignBlocked: false,
    scheduleTransition: false,
    generationFenced: false,
  };
}

function hasPendingDurableRepair(state: JobState): boolean {
  return state.active?.releasePending === true
    || state.pendingClockRegression !== undefined
    || state.scheduleTransition
    || state.generationFenced;
}

function fenceScheduleGeneration(state: JobState): void {
  state.generationFenced = true;
  state.foreignBlocked = false;
  state.persistenceError = "durable_state_schedule_changed";
}

function isForeignActive(state: JobState, ownerId: string): boolean {
  const active = state.durable.record.active;
  return active !== undefined
    && (
      active.ownerId !== ownerId
      || active.idempotencyKey !== state.active?.idempotencyKey
    );
}

function initialDurableRecord(job: CronJob, now: Date): DurableJobRecord {
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

function collectDue(job: CronJob, watermarkMs: number, nowMs: number, limit: number): DueSet {
  if (watermarkMs >= nowMs) return { selected: [] };
  const probeMs = Math.min(nowMs + 1, 8_640_000_000_000_000);
  let cursor = previousCronOccurrence(job, new Date(probeMs));
  if (cursor.getTime() <= watermarkMs) return { selected: [] };
  const descending: Date[] = [];
  while (descending.length < limit && cursor.getTime() > watermarkMs) {
    descending.push(cursor);
    cursor = previousCronOccurrence(job, cursor);
  }
  const selected = descending.reverse();
  if (cursor.getTime() <= watermarkMs) return { selected };
  return {
    selected,
    missed: {
      from: nextCronOccurrence(job, new Date(watermarkMs)),
      through: cursor,
    },
  };
}

function allDueRange(
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

function cronMetadata(
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

function deliveryChannel(job: CronJob): string | undefined {
  return typeof job.notify === "string" ? job.notify : job.notify?.channel;
}

function receiptResult(
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

function terminal(
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

function parseInvokeInput(value: unknown): { readonly jobId: string; readonly scheduledAt?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("trigger-cron:invoke input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== "jobId" && key !== "scheduledAt");
  if (unknown.length > 0) throw new TypeError(`trigger-cron:invoke contains unknown field(s): ${unknown.join(", ")}.`);
  if (typeof input.jobId !== "string" || input.jobId.length === 0 || input.jobId !== input.jobId.trim()) {
    throw new TypeError("trigger-cron:invoke jobId must be a non-empty string.");
  }
  const scheduledAt = input.scheduledAt === undefined ? undefined : normalizeInstant(input.scheduledAt);
  return { jobId: input.jobId, ...(scheduledAt === undefined ? {} : { scheduledAt }) };
}

function normalizeInstant(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("scheduledAt must be an ISO date-time string.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError("scheduledAt must be a canonical UTC ISO date-time string.");
  }
  return value;
}

function invocationResultToJson(result: CronInvocationResult): JsonValue {
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

function readDurableStateCapability(host: TriggerHost): CronDurableStateCapability | undefined {
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

function encodeDurableRecord(record: DurableJobRecord): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > DURABLE_RECORD_BYTES) throw new Error("Cron durable state record exceeds its byte limit.");
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
  const input = exactRecord(value, ["status", "scheduledAt", "idempotencyKey"], "Cron durable outcome");
  if (typeof input.status !== "string" || !OUTCOME_STATUSES.has(input.status as CronInvocationStatus)) {
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
  const input = exactRecord(value, ["status", "observedAt", "scheduledAt"], "Cron durable health issue");
  if (typeof input.status !== "string" || !ISSUE_STATUSES.has(input.status as CronHealthIssueStatus)) {
    throw new Error("Cron durable health issue has an invalid status.");
  }
  return {
    status: input.status as CronHealthIssueStatus,
    observedAt: canonicalInstant(input.observedAt, "observedAt"),
    scheduledAt: canonicalInstant(input.scheduledAt, "scheduledAt"),
  };
}

function parseMissed(value: unknown): DurableMissedRange {
  const input = exactRecord(value, ["ranges", "atLeast", "from", "through"], "Cron durable missed range");
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

function exactRecord(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object.`);
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

function validClockInstant(clock: CronClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Cron clock returned an invalid date.");
  }
  return value;
}

function mutateState<T>(state: JobState, mutation: () => Promise<T>): Promise<T> {
  const result = state.mutation.then(mutation, mutation);
  state.mutation = result.then(() => undefined, () => undefined);
  return result;
}

function stablePersistenceFailure(_error: unknown): string {
  return "durable_state_unavailable";
}

async function waitForStopWork(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
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

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

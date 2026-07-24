// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";

import type {
  JsonValue,
  ModuleCommand,
  ModuleDrainContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStartContext,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import type { Trigger, TriggerHost } from "@mono-agent/module-sdk/internal";

import type { CronJob } from "./jobs.js";
import { nextCronOccurrence } from "./jobs.js";
import {
  createCronDurableScheduler,
  initialDurableRecord,
  readDurableStateCapability,
} from "./scheduler-durable.js";
import type {
  DurableActiveInvocation,
} from "./scheduler-durable.js";
import {
  MAX_TIMEOUT_MS,
  allDueRange,
  collectDue,
  cronIdempotencyKey,
  cronMetadata,
  deliveryChannel,
  drainSignal,
  hasPendingDurableRepair,
  invocationResultToJson,
  isForeignActive,
  mutateState,
  normalizeInstant,
  parseInvokeInput,
  receiptResult,
  stablePersistenceFailure,
  terminal,
  throwIfAborted,
  validClockInstant,
  waitForStopWork,
} from "./scheduler-helpers.js";
import type { JobState, PendingInvocation } from "./scheduler-state.js";

export const MAX_CRON_CATCH_UP = 32;

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

export function createCronTrigger(options: CreateCronTriggerOptions): CronTrigger {
  const clock = options.clock ?? systemCronClock;
  const jobs = Object.freeze([...options.jobs]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  if (jobsById.size !== jobs.length) throw new Error("Cron job ids must be unique.");
  const durableState = readDurableStateCapability(options.host);
  const ownerId = randomUUID();
  const durableScheduler = createCronDurableScheduler({
    instanceId: options.instanceId,
    ownerId,
    clock,
    ...(durableState === undefined ? {} : { capability: durableState }),
  });
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
        await durableScheduler.initializeJob(job, states.get(job.id)!, startedAt, startSignal);
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
    async drain(context: ModuleDrainContext): Promise<void> {
      const deadline = drainSignal(context);
      try {
        await stop({ signal: deadline.signal, reason: "shutdown" });
      } finally {
        deadline.dispose();
      }
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
        await durableScheduler.refreshJob(job, state);
        await durableScheduler.recoverDefinitivelySettledActive(
          job,
          state,
          new AbortController().signal,
        );
        if (state.scheduleTransition) {
          await durableScheduler.replaceChangedSchedule(
            job,
            state,
            now,
            new AbortController().signal,
          );
          if (state.scheduleTransition) break;
        }
        if (state.active?.releasePending && !await repairDurableRelease(job, state)) break;
        await durableScheduler.accountClockRegression(job, state, now);
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
            await durableScheduler.recordMissedRange(job, state, missed.from, missed.through, now);
          }
          break;
        }
        const due = collectDue(job, watermarkMs, now.getTime(), remaining);
        if (due.missed !== undefined) {
          await durableScheduler.recordMissedRange(
            job,
            state,
            due.missed.from,
            due.missed.through,
            now,
          );
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
        const adjustment = durableScheduler.accountClockRegression(job, state, now)
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
        const applied = await durableScheduler.updateRecord(
          job,
          state,
          new AbortController().signal,
          (current) => {
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
          },
        );
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
        await durableScheduler.clearActive(job, state, idempotencyKey);
      } catch {
        state.persistenceError = "durable_state_unavailable";
      }
      return await durableScheduler.settleInvocation(job, state, {
        status: "cancelled",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "Cron trigger stopped after durable admission and before emission.",
      });
    }
    if (state.active === undefined) return await runNow(job, scheduledAt, source, idempotencyKey, state);
    if (job.overlap === "skip") {
      return await durableScheduler.settleInvocation(job, state, {
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
      void durableScheduler.settleInvocation(
        job,
        state,
        terminal(pending, "dropped", "Cron queue is full."),
      ).then(resolve);
    });
  }

  async function repairDurableRelease(job: CronJob, state: JobState): Promise<boolean> {
    const active = state.active;
    if (active === undefined || !active.releasePending) return true;
    try {
      if (!await durableScheduler.clearActive(job, state, active.idempotencyKey)) {
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
      if (!await durableScheduler.claimActive(job, state, scheduledAt, idempotencyKey)) {
        state.unsettledIssue ??= {
          status: "unknown",
          observedAt: validClockInstant(clock).toISOString(),
          scheduledAt,
        };
        return await durableScheduler.settleInvocation(job, state, {
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
    result = await durableScheduler.settleInvocation(job, state, result);
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
    pending.resolve(await durableScheduler.settleInvocation(pending.job, state, result));
  }

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

export { HOST_CAPABILITY_CRON_DURABLE_STATE } from "./scheduler-durable.js";
export type {
  CronDurableStateCapability,
  CronDurableStateCompareAndSwapRequest,
  CronDurableStateCompareAndSwapResult,
  CronDurableStateReadRequest,
  CronDurableStateReadResult,
} from "./scheduler-durable.js";
export { cronIdempotencyKey };

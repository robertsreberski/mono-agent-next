import { createHash } from "node:crypto";

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
import { nextCronOccurrence } from "./jobs.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

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

export type CronInvocationSource = "schedule" | "command";

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
      readonly status: "duplicate" | "skipped" | "queued" | "dropped" | "cancelled";
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
  readonly done: Promise<void>;
}

interface JobState {
  timer: CronTimerHandle | undefined;
  target: Date | undefined;
  active: ActiveInvocation | undefined;
  pending: PendingInvocation[];
  watermarkMs: number;
  emitted: number;
  lastResult?: CronInvocationResult;
}

export function createCronTrigger(options: CreateCronTriggerOptions): CronTrigger {
  const clock = options.clock ?? systemCronClock;
  const jobs = Object.freeze([...options.jobs]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  if (jobsById.size !== jobs.length) throw new Error("Cron job ids must be unique.");
  const states = new Map(jobs.map((job) => [job.id, createJobState()]));
  let lifecycle: "new" | "running" | "stopping" | "stopped" = "new";

  const start = (context: ModuleStartContext): void => {
    if (lifecycle === "running") return;
    if (lifecycle !== "new") throw new Error(`Cron trigger cannot start from ${lifecycle}.`);
    throwIfAborted(options.signal, "Cron trigger creation was aborted.");
    throwIfAborted(context.signal, "Cron trigger start was aborted.");
    lifecycle = "running";
    for (const job of jobs) scheduleNext(job);
  };

  const stop = async (_context?: ModuleStopContext): Promise<void> => {
    if (lifecycle === "stopped") return;
    lifecycle = "stopping";
    const active: Promise<void>[] = [];
    for (const [jobId, state] of states) {
      if (state.timer !== undefined) clock.clearTimeout(state.timer);
      state.timer = undefined;
      state.target = undefined;
      state.active?.controller.abort(new Error("Cron trigger stopped."));
      if (state.active !== undefined) active.push(state.active.done);
      for (const pending of state.pending.splice(0)) {
        pending.resolve(terminal(pending, "cancelled", "Cron trigger stopped before emission."));
      }
      states.set(jobId, state);
    }
    await Promise.all(active);
    lifecycle = "stopped";
  };

  const invoke = async (jobId: string, scheduledAt?: string): Promise<CronInvocationResult> => {
    if (lifecycle !== "running") throw new Error(`Cron trigger is not running (${lifecycle}).`);
    const job = jobsById.get(jobId);
    if (job === undefined) throw new Error(`Unknown cron job "${jobId}".`);
    const instant = scheduledAt === undefined ? clock.now().toISOString() : normalizeInstant(scheduledAt);
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
      return {
        status: lifecycle === "running" ? "healthy" : lifecycle === "stopping" ? "degraded" : "unknown",
        checkedAt: clock.now().toISOString(),
        details: { jobs: jobs.length, active, queued, lifecycle },
      };
    },
    invoke,
  };

  function scheduleNext(job: CronJob, previousTarget?: Date): void {
    if (lifecycle !== "running") return;
    const now = clock.now();
    const base = previousTarget === undefined
      ? now
      : new Date(Math.max(now.getTime(), previousTarget.getTime()));
    arm(job, nextCronOccurrence(job, base));
  }

  function arm(job: CronJob, target: Date): void {
    const state = states.get(job.id);
    if (state === undefined || lifecycle !== "running") return;
    const remaining = Math.max(0, target.getTime() - clock.now().getTime());
    state.target = target;
    state.timer = clock.setTimeout(() => {
      state.timer = undefined;
      if (lifecycle !== "running") return;
      if (clock.now().getTime() < target.getTime()) {
        arm(job, target);
        return;
      }
      void admit(job, target.toISOString(), "schedule");
      scheduleNext(job, target);
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
    if (scheduledMs <= state.watermarkMs) {
      return {
        status: "duplicate",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "This job instant was already admitted or is older than the durable run watermark.",
      };
    }
    state.watermarkMs = scheduledMs;
    if (state.active === undefined) return await runNow(job, scheduledAt, source, idempotencyKey, state);
    if (job.overlap === "skip") {
      return {
        status: "skipped",
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: "A prior firing is still active.",
      };
    }
    return await new Promise<CronInvocationResult>((resolve) => {
      const pending: PendingInvocation = { job, scheduledAt, source, idempotencyKey, resolve };
      if (job.overlap === "replace") {
        for (const displaced of state.pending.splice(0)) {
          displaced.resolve(terminal(displaced, "dropped", "Replaced by a newer firing."));
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
        displaced?.resolve(terminal(displaced, "dropped", "Cron queue dropped its oldest firing."));
        state.pending.push(pending);
        return;
      }
      if (job.overflow === "coalesce") {
        for (const displaced of state.pending.splice(0)) {
          displaced.resolve(terminal(displaced, "dropped", "Cron queue coalesced to its newest firing."));
        }
        state.pending.push(pending);
        return;
      }
      resolve(terminal(pending, "dropped", "Cron queue is full."));
    });
  }

  async function runNow(
    job: CronJob,
    scheduledAt: string,
    source: CronInvocationSource,
    idempotencyKey: string,
    state: JobState,
  ): Promise<CronInvocationResult> {
    const controller = new AbortController();
    let finishActive!: () => void;
    const done = new Promise<void>((resolve) => { finishActive = resolve; });
    state.active = { controller, idempotencyKey, done };
    const invokedAt = clock.now().toISOString();
    let watchdog: CronTimerHandle | undefined;
    const timeout = new Promise<CronInvocationResult>((resolve) => {
      watchdog = clock.setTimeout(() => {
        controller.abort(new Error(`Cron job exceeded its ${String(job.maxRunMs)} ms watchdog.`));
        resolve({
          status: "cancelled",
          jobId: job.id,
          scheduledAt,
          idempotencyKey,
          reason: `Cron job exceeded its ${String(job.maxRunMs)} ms watchdog.`,
        });
      }, job.maxRunMs);
    });
    const cancellation = new Promise<CronInvocationResult>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        resolve({
          status: "cancelled",
          jobId: job.id,
          scheduledAt,
          idempotencyKey,
          reason: errorMessage(controller.signal.reason ?? "Cron emission was cancelled."),
        });
      }, { once: true });
    });
    const channel = deliveryChannel(job);
    const emission = Promise.resolve().then(async () => await options.host.emit({
      id: idempotencyKey,
      triggerInstanceId: options.instanceId,
      prompt: job.prompt,
      createdAt: invokedAt,
      ...(job.runtime === undefined ? {} : { runtime: job.runtime }),
      ...(job.model === undefined ? {} : { model: job.model }),
      ...(channel === undefined ? {} : { deliveryChannel: channel }),
      metadata: cronMetadata(job, scheduledAt, invokedAt, idempotencyKey, source),
    }, controller.signal)).then(
      (receipt) => receiptResult(job, scheduledAt, idempotencyKey, receipt),
      (error: unknown) => ({
        status: controller.signal.aborted ? "cancelled" as const : "rejected" as const,
        jobId: job.id,
        scheduledAt,
        idempotencyKey,
        reason: errorMessage(error),
      }),
    );
    const result = await Promise.race([emission, timeout, cancellation]);
    if (watchdog !== undefined) clock.clearTimeout(watchdog);
    state.emitted += 1;
    state.lastResult = result;
    state.active = undefined;
    const next = state.pending.shift();
    if (next !== undefined && lifecycle === "running") {
      void runNow(next.job, next.scheduledAt, next.source, next.idempotencyKey, state).then(next.resolve);
    } else if (next !== undefined) {
      next.resolve(terminal(next, "cancelled", "Cron trigger stopped before emission."));
    }
    finishActive();
    return result;
  }
}

export function cronIdempotencyKey(instanceId: string, jobId: string, scheduledAt: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, instanceId, jobId, scheduledAt]), "utf8")
    .digest("hex");
  return `cron:v1:${digest}`;
}

function createJobState(): JobState {
  return {
    timer: undefined,
    target: undefined,
    active: undefined,
    pending: [],
    watermarkMs: Number.NEGATIVE_INFINITY,
    emitted: 0,
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
  const metadata: Record<string, JsonValue> = { cron: Object.freeze(cron) };
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
  return {
    status: receipt.status,
    jobId: job.id,
    scheduledAt,
    idempotencyKey,
    ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
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
  if ("reason" in result) json.reason = result.reason;
  return json;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { describe, expect, it } from "vitest";

import type { TriggerEvent, TriggerHost, TriggerReceipt } from "@mono-agent/module-sdk/internal";

import {
  TriggerCronConfigError,
  createCronTrigger,
  parseCronJobMarkdown,
  parseTriggerCronConfig,
  type CronClock,
  type CronJob,
  type CronTimerHandle,
} from "../index.js";

describe("trigger-cron configuration and jobs", () => {
  it("accepts the v1 config shape and rejects unknown, escaping, or invalid timezone input", () => {
    expect(parseTriggerCronConfig({ jobsDirectory: "./cron", timezone: "Europe/Rome" })).toEqual({
      jobsDirectory: "./cron",
      timezone: "Europe/Rome",
    });
    expect(() => parseTriggerCronConfig({ jobsDirectory: "../secrets" })).toThrow(TriggerCronConfigError);
    expect(() => parseTriggerCronConfig({ jobsDirectory: "cron", timezone: "Mars/Olympus" })).toThrow(
      /valid IANA timezone/u,
    );
    expect(() => parseTriggerCronConfig({ jobsDirectory: "cron", enabled: true })).toThrow(/unknown field/u);
  });

  it("strictly parses the canonical Markdown job and preserves explicit delivery intent", () => {
    const job = parseCronJobMarkdown("briefing.md", `---
id: morning-briefing
expression: 30 7 * * *
timezone: Europe/Rome
runtime: pi
model: openai-codex:gpt-5.6-sol
effort: high
notify:
  channel: telegram
  destination: telegram:42
---

Compose the morning briefing.
`);
    expect(job).toMatchObject({
      id: "morning-briefing",
      expression: "30 7 * * *",
      timezone: "Europe/Rome",
      runtime: "pi",
      model: "openai-codex:gpt-5.6-sol",
      effort: "high",
      notify: { channel: "telegram", destination: "telegram:42" },
      prompt: "Compose the morning briefing.",
      overlap: "skip",
    });
    expect(() => parseCronJobMarkdown("bad.md", "---\nexpression: '* * * * * *'\n---\nrun\n")).toThrow(
      /exactly five fields/u,
    );
    expect(() => parseCronJobMarkdown("bad.md", "---\nexpression: '* * * * *'\nsecret: x\n---\nrun\n")).toThrow(
      /unknown field/u,
    );
  });
});

describe("trigger-cron lifecycle", () => {
  it("emits one deterministic event per schedule and suppresses replay of the same instant", async () => {
    const clock = new TestClock("1970-01-01T00:00:00.000Z");
    const host = new RecordingHost();
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host,
      clock,
    });
    trigger.start?.({ signal: new AbortController().signal });

    await clock.advanceTo("1970-01-01T00:01:00.000Z");
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      triggerInstanceId: "cron",
      prompt: "check status",
      createdAt: "1970-01-01T00:01:00.000Z",
      runtime: "pi",
      model: "provider:model",
      deliveryChannel: "telegram",
      metadata: {
        effort: "high",
        destination: "telegram:42",
        cron: {
          schemaVersion: 1,
          jobId: "heartbeat",
          scheduledAt: "1970-01-01T00:01:00.000Z",
          invokedAt: "1970-01-01T00:01:00.000Z",
          source: "schedule",
          effort: "high",
          notify: { channel: "telegram", destination: "telegram:42" },
        },
      },
    });
    expect(host.events[0]?.id).toMatch(/^cron:v1:[a-f0-9]{64}$/u);

    const duplicate = await trigger.invoke("heartbeat", "1970-01-01T00:01:00.000Z");
    expect(duplicate.status).toBe("duplicate");
    expect(host.events).toHaveLength(1);
  });

  it("exposes a deterministic command and skips overlap without a second host emission", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    let settle: ((receipt: TriggerReceipt) => void) | undefined;
    const host = new RecordingHost(() => new Promise((resolve) => { settle = resolve; }));
    const trigger = createCronTrigger({ instanceId: "cron", jobs: [job()], host, clock });
    trigger.start?.({ signal: new AbortController().signal });
    const command = trigger.commands?.find((entry) => entry.name === "trigger-cron:invoke");
    expect(command).toBeDefined();
    const first = command?.run(
      { jobId: "heartbeat", scheduledAt: "2026-07-23T08:01:00.000Z" },
      { signal: new AbortController().signal, logger: nullLogger },
    );
    await flush();
    const second = await trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    expect(second).toMatchObject({ status: "skipped", reason: "A prior firing is still active." });
    expect(host.events).toHaveLength(1);
    settle?.({ status: "accepted", runId: "run-1" });
    await expect(first).resolves.toMatchObject({ status: "accepted", runId: "run-1" });
  });

  it("marks channel-only notify intent for the selected channel's default destination", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost();
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job({ notify: "telegram" })],
      host,
      clock,
    });
    trigger.start?.({ signal: new AbortController().signal });
    await trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    expect(host.events[0]).toMatchObject({
      deliveryChannel: "telegram",
      metadata: { destination: "", effort: "high" },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("aborts a wedged emission at the per-job watchdog and never emits after stop", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const signals: AbortSignal[] = [];
    const host = new RecordingHost((_event, signal) => {
      signals.push(signal);
      return new Promise<TriggerReceipt>(() => undefined);
    });
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job({ maxRunMs: 1_000 })],
      host,
      clock,
    });
    trigger.start?.({ signal: new AbortController().signal });
    const invocation = trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await flush();
    await clock.advanceBy(1_000);
    await expect(invocation).resolves.toMatchObject({ status: "cancelled" });
    expect(signals[0]?.aborted).toBe(true);

    const activeAtStop = trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    await flush();
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await expect(activeAtStop).resolves.toMatchObject({ status: "cancelled" });
    await clock.advanceBy(120_000);
    expect(host.events).toHaveLength(2);
  });

  it("bounds queued work and replace mode aborts before emitting the newest firing", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const queueResolvers: Array<(receipt: TriggerReceipt) => void> = [];
    const queueHost = new RecordingHost(() => new Promise((resolve) => { queueResolvers.push(resolve); }));
    const queued = createCronTrigger({
      instanceId: "queue",
      jobs: [job({ overlap: "queue", maxQueueDepth: 1, overflow: "drop-newest" })],
      host: queueHost,
      clock,
    });
    queued.start?.({ signal: new AbortController().signal });
    const first = queued.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await flush();
    const second = queued.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    const third = await queued.invoke("heartbeat", "2026-07-23T08:03:00.000Z");
    expect(third).toMatchObject({ status: "dropped", reason: "Cron queue is full." });
    expect(queueHost.events).toHaveLength(1);
    queueResolvers[0]?.({ status: "accepted", runId: "first" });
    await expect(first).resolves.toMatchObject({ status: "accepted" });
    await flush();
    expect(queueHost.events).toHaveLength(2);
    queueResolvers[1]?.({ status: "accepted", runId: "second" });
    await expect(second).resolves.toMatchObject({ status: "accepted" });
    await queued.stop?.({ signal: new AbortController().signal, reason: "shutdown" });

    const replaceSignals: AbortSignal[] = [];
    const replaceHost = new RecordingHost((_event, signal) => {
      replaceSignals.push(signal);
      return new Promise<TriggerReceipt>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const replacing = createCronTrigger({
      instanceId: "replace",
      jobs: [job({ overlap: "replace" })],
      host: replaceHost,
      clock,
    });
    replacing.start?.({ signal: new AbortController().signal });
    const old = replacing.invoke("heartbeat", "2026-07-23T08:04:00.000Z");
    await flush();
    const newest = replacing.invoke("heartbeat", "2026-07-23T08:05:00.000Z");
    await expect(old).resolves.toMatchObject({ status: "cancelled" });
    await flush();
    expect(replaceSignals[0]?.aborted).toBe(true);
    expect(replaceHost.events).toHaveLength(2);
    await replacing.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await expect(newest).resolves.toMatchObject({ status: "cancelled" });
  });
});

const nullLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "heartbeat",
    expression: "* * * * *",
    timezone: "UTC",
    prompt: "check status",
    runtime: "pi",
    model: "provider:model",
    effort: "high",
    notify: { channel: "telegram", destination: "telegram:42" },
    overlap: "skip",
    maxQueueDepth: 2,
    overflow: "drop-newest",
    maxRunMs: 20 * 60 * 1_000,
    source: "heartbeat.md",
    ...overrides,
  };
}

class RecordingHost implements TriggerHost {
  readonly grantedCapabilities = new Set<string>();
  readonly events: TriggerEvent[] = [];

  constructor(
    private readonly handler: (
      event: TriggerEvent,
      signal: AbortSignal,
    ) => Promise<TriggerReceipt> = async () => ({ status: "accepted", runId: "run" }),
  ) {}

  getCapability<T = unknown>(): T | undefined {
    return undefined;
  }

  async emit(event: TriggerEvent, signal: AbortSignal): Promise<TriggerReceipt> {
    this.events.push(event);
    return await this.handler(event, signal);
  }
}

interface TestTimer extends CronTimerHandle {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

class TestClock implements CronClock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, TestTimer>();

  constructor(instant: string) {
    this.#now = new Date(instant).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, delayMs: number): TestTimer {
    const timer = { id: this.#nextId++, at: this.#now + delayMs, callback };
    this.#timers.set(timer.id, timer);
    return timer;
  }

  clearTimeout(handle: CronTimerHandle): void {
    this.#timers.delete((handle as TestTimer).id);
  }

  async advanceBy(milliseconds: number): Promise<void> {
    await this.advanceTo(new Date(this.#now + milliseconds).toISOString());
  }

  async advanceTo(instant: string): Promise<void> {
    const target = new Date(instant).getTime();
    while (true) {
      const timer = [...this.#timers.values()]
        .filter((entry) => entry.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (timer === undefined) break;
      this.#timers.delete(timer.id);
      this.#now = timer.at;
      timer.callback();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

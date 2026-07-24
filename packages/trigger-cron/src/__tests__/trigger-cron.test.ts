// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";

import type { TriggerEvent, TriggerHost, TriggerReceipt } from "@mono-agent/module-sdk/internal";

import {
  MAX_CRON_CATCH_UP,
  TriggerCronConfigError,
  createCronTrigger,
  parseCronJobMarkdown,
  parseTriggerCronConfig,
  type CronClock,
  type CronJob,
  type CronTimerHandle,
  type CronTrigger,
} from "../index.js";
import {
  HOST_CAPABILITY_CRON_DURABLE_STATE,
  type CronDurableStateCapability,
  type CronDurableStateCompareAndSwapRequest,
  type CronDurableStateReadRequest,
} from "../scheduler.js";

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
    await trigger.start?.({ signal: new AbortController().signal });

    await clock.advanceTo("1970-01-01T00:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      triggerInstanceId: "cron",
      prompt: "check status",
      createdAt: "1970-01-01T00:01:00.000Z",
      runtime: "pi",
      model: "provider:model",
      deliveryChannel: "telegram",
      metadata: {
        triggerKind: "cron",
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
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:02:00.000Z");
    const command = trigger.commands?.find((entry) => entry.name === "trigger-cron:invoke");
    expect(command).toBeDefined();
    const first = command?.run(
      { jobId: "heartbeat", scheduledAt: "2026-07-23T08:01:00.000Z" },
      { signal: new AbortController().signal, logger: nullLogger },
    );
    await waitFor(() => host.events.length === 1);
    const second = await trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    expect(second).toMatchObject({ status: "skipped", reason: "A prior firing is still active." });
    expect(host.events).toHaveLength(1);
    settle?.({ status: "accepted", runId: "run-1" });
    await expect(first).resolves.toMatchObject({ status: "accepted", runId: "run-1" });
  });

  it("normalizes RFC3339 command offsets and deduplicates the same canonical instant", async () => {
    const clock = new TestClock("2026-07-23T07:59:00.000Z");
    const host = new RecordingHost();
    const trigger = createCronTrigger({ instanceId: "cron", jobs: [job()], host, clock });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    const command = trigger.commands?.find((entry) => entry.name === "trigger-cron:invoke");
    if (command === undefined) throw new Error("Expected trigger-cron:invoke command.");

    const first = await command.run(
      { jobId: "heartbeat", scheduledAt: "2026-07-23T10:00:00+02:00" },
      { signal: new AbortController().signal, logger: nullLogger },
    );
    expect(first).toMatchObject({
      status: "accepted",
      scheduledAt: "2026-07-23T08:00:00.000Z",
    });
    const duplicate = await command.run(
      { jobId: "heartbeat", scheduledAt: "2026-07-23T08:00:00.000Z" },
      { signal: new AbortController().signal, logger: nullLogger },
    );
    expect(duplicate).toMatchObject({
      status: "duplicate",
      scheduledAt: "2026-07-23T08:00:00.000Z",
      idempotencyKey: host.events[0]?.id,
    });
    expect(host.events.map(scheduledAt)).toEqual(["2026-07-23T08:00:00.000Z"]);
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("normalizes a valid RFC3339 leap second to its epoch boundary", async () => {
    const clock = new TestClock("2016-12-31T23:59:59.000Z");
    const host = new RecordingHost();
    const trigger = createCronTrigger({
      instanceId: "leap-second",
      jobs: [job({ expression: "0 12 1 1 *" })],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2017-01-01T00:01:00.000Z");

    const leap = await trigger.invoke("heartbeat", "2016-12-31T23:59:60Z");
    expect(leap).toMatchObject({
      status: "accepted",
      scheduledAt: "2017-01-01T00:00:00.000Z",
    });
    await expect(
      trigger.invoke("heartbeat", "2017-01-01T00:00:00.000Z"),
    ).resolves.toMatchObject({
      status: "duplicate",
      idempotencyKey: leap.idempotencyKey,
    });
    await expect(
      trigger.invoke("heartbeat", "2016-12-31T12:00:60Z"),
    ).rejects.toThrow(/RFC3339/u);
    expect(host.events.map(scheduledAt)).toEqual(["2017-01-01T00:00:00.000Z"]);
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("bounds drain with its signal or deadline and still permits a final stop", async () => {
    const signalTrigger = createCronTrigger({
      instanceId: "drain-signal",
      jobs: [job()],
      host: new RecordingHost(),
      clock: new TestClock("2026-07-23T08:00:00.000Z"),
    });
    await signalTrigger.start?.({ signal: new AbortController().signal });
    if (signalTrigger.drain === undefined) throw new Error("Expected drain lifecycle.");
    const cancelled = new Error("operator cancelled drain");
    const controller = new AbortController();
    controller.abort(cancelled);
    await expect(signalTrigger.drain({ signal: controller.signal })).rejects.toBe(cancelled);
    await signalTrigger.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });

    const deadlineTrigger = createCronTrigger({
      instanceId: "drain-deadline",
      jobs: [job()],
      host: new RecordingHost(),
      clock: new TestClock("2026-07-23T08:00:00.000Z"),
    });
    await deadlineTrigger.start?.({ signal: new AbortController().signal });
    if (deadlineTrigger.drain === undefined) throw new Error("Expected drain lifecycle.");
    await expect(deadlineTrigger.drain({
      signal: new AbortController().signal,
      deadline: "1970-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({ name: "TimeoutError" });
    await deadlineTrigger.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
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
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    await trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    expect(host.events[0]).toMatchObject({
      deliveryChannel: "telegram",
      metadata: { destination: "", effort: "high", triggerKind: "cron" },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("keeps a watchdog-unknown emission active until an abort-ignoring host actually settles", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const signals: AbortSignal[] = [];
    const settleEmissions: Array<(receipt: TriggerReceipt) => void> = [];
    const host = new RecordingHost((_event, signal) => {
      signals.push(signal);
      return new Promise<TriggerReceipt>((resolve) => { settleEmissions.push(resolve); });
    });
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job({ maxRunMs: 1_000 })],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:02:00.000Z");
    const invocation = trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => signals.length === 1);
    await clock.advanceBy(1_000);
    await expect(invocation).resolves.toMatchObject({ status: "unknown" });
    expect(signals[0]?.aborted).toBe(true);

    await expect(trigger.invoke("heartbeat")).resolves.toMatchObject({
      status: "skipped",
    });
    expect(signals).toHaveLength(1);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { active: 1, issues: { heartbeat: { status: "unknown" } } },
    });

    settleEmissions[0]?.({ status: "accepted", runId: "late" });
    await waitForActiveCount(trigger, 0);
    clock.setNow("2026-07-23T08:02:02.000Z");
    const afterSettlement = trigger.invoke("heartbeat");
    await waitFor(() => signals.length === 2);
    settleEmissions[1]?.({ status: "accepted", runId: "next" });
    await expect(afterSettlement).resolves.toMatchObject({ status: "accepted" });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
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
    await queued.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:05:00.000Z");
    const first = queued.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => queueHost.events.length === 1);
    const second = queued.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    const third = await queued.invoke("heartbeat", "2026-07-23T08:03:00.000Z");
    expect(third).toMatchObject({ status: "dropped", reason: "Cron queue is full." });
    expect(queueHost.events).toHaveLength(1);
    queueResolvers[0]?.({ status: "accepted", runId: "first" });
    await expect(first).resolves.toMatchObject({ status: "accepted" });
    await waitFor(() => queueHost.events.length === 2);
    expect(queueHost.events).toHaveLength(2);
    queueResolvers[1]?.({ status: "accepted", runId: "second" });
    await expect(second).resolves.toMatchObject({ status: "accepted" });
    await queued.stop?.({ signal: new AbortController().signal, reason: "shutdown" });

    clock.setNow("2026-07-23T08:00:00.000Z");
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
    await replacing.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:05:00.000Z");
    const old = replacing.invoke("heartbeat", "2026-07-23T08:04:00.000Z");
    await waitFor(() => replaceHost.events.length === 1);
    const newest = replacing.invoke("heartbeat", "2026-07-23T08:05:00.000Z");
    await expect(old).resolves.toMatchObject({ status: "unknown" });
    await waitFor(() => replaceHost.events.length === 2);
    expect(replaceSignals[0]?.aborted).toBe(true);
    expect(replaceHost.events).toHaveLength(2);
    await replacing.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await expect(newest).resolves.toMatchObject({ status: "unknown" });
  });

  it("drop-oldest keeps queue depth two and runs the surviving firings in order", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const resolvers: Array<(receipt: TriggerReceipt) => void> = [];
    const host = new RecordingHost(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const trigger = createCronTrigger({
      instanceId: "drop-oldest",
      jobs: [job({ overlap: "queue", maxQueueDepth: 2, overflow: "drop-oldest" })],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:05:00.000Z");

    const first = trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    const displaced = trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    const third = trigger.invoke("heartbeat", "2026-07-23T08:03:00.000Z");
    const fourth = trigger.invoke("heartbeat", "2026-07-23T08:04:00.000Z");
    await expect(displaced).resolves.toMatchObject({
      status: "dropped",
      reason: "Cron queue dropped its oldest firing.",
    });

    resolvers[0]?.({ status: "accepted", runId: "first" });
    await expect(first).resolves.toMatchObject({ status: "accepted" });
    await waitFor(() => host.events.length === 2);
    resolvers[1]?.({ status: "accepted", runId: "third" });
    await expect(third).resolves.toMatchObject({ status: "accepted" });
    await waitFor(() => host.events.length === 3);
    resolvers[2]?.({ status: "accepted", runId: "fourth" });
    await expect(fourth).resolves.toMatchObject({ status: "accepted" });
    expect(host.events.map(scheduledAt)).toEqual([
      "2026-07-23T08:01:00.000Z",
      "2026-07-23T08:03:00.000Z",
      "2026-07-23T08:04:00.000Z",
    ]);
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("coalesce drops every queued firing and runs only the newest replacement", async () => {
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const resolvers: Array<(receipt: TriggerReceipt) => void> = [];
    const host = new RecordingHost(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const trigger = createCronTrigger({
      instanceId: "coalesce",
      jobs: [job({ overlap: "queue", maxQueueDepth: 2, overflow: "coalesce" })],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:05:00.000Z");

    const first = trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    const second = trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z");
    const third = trigger.invoke("heartbeat", "2026-07-23T08:03:00.000Z");
    const newest = trigger.invoke("heartbeat", "2026-07-23T08:04:00.000Z");
    await expect(Promise.all([second, third])).resolves.toEqual([
      expect.objectContaining({
        status: "dropped",
        reason: "Cron queue coalesced to its newest firing.",
      }),
      expect.objectContaining({
        status: "dropped",
        reason: "Cron queue coalesced to its newest firing.",
      }),
    ]);

    resolvers[0]?.({ status: "accepted", runId: "first" });
    await expect(first).resolves.toMatchObject({ status: "accepted" });
    await waitFor(() => host.events.length === 2);
    expect(host.events.map(scheduledAt)).toEqual([
      "2026-07-23T08:01:00.000Z",
      "2026-07-23T08:04:00.000Z",
    ]);
    resolvers[1]?.({ status: "accepted", runId: "newest" });
    await expect(newest).resolves.toMatchObject({ status: "accepted" });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("restores the durable watermark and catches up downtime without replaying an accepted firing", async () => {
    const durable = new InMemoryCronDurableState();
    const firstClock = new TestClock("2026-07-23T08:00:00.000Z");
    const firstHost = new RecordingHost(undefined, durable);
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: firstHost,
      clock: firstClock,
    });
    await first.start?.({ signal: new AbortController().signal });
    await firstClock.advanceTo("2026-07-23T08:01:00.000Z");
    await waitFor(() => firstHost.events.length === 1);
    await waitFor(() =>
      (durable.onlyRecord().lastOutcome as { status?: unknown } | undefined)?.status === "accepted");
    await first.stop?.({ signal: new AbortController().signal, reason: "restart" });

    const restartClock = new TestClock("2026-07-23T08:03:00.000Z");
    const restartHost = new RecordingHost(undefined, durable);
    const restarted = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: restartHost,
      clock: restartClock,
    });
    await restarted.start?.({ signal: new AbortController().signal });
    await waitFor(() => restartHost.events.length === 2);
    await waitFor(() =>
      (durable.onlyRecord().lastOutcome as { scheduledAt?: unknown; status?: unknown } | undefined)?.scheduledAt
        === "2026-07-23T08:03:00.000Z"
      && (durable.onlyRecord().lastOutcome as { status?: unknown } | undefined)?.status === "accepted");
    expect(restartHost.events.map(scheduledAt)).toEqual([
      "2026-07-23T08:02:00.000Z",
      "2026-07-23T08:03:00.000Z",
    ]);
    expect(restartHost.events.every((event) =>
      event.metadata?.cron !== undefined
      && (event.metadata.cron as { source?: unknown }).source === "recovery")).toBe(true);
    await expect(restarted.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
      details: { durability: "available" },
    });
    await restarted.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("reconciles ticks that became due while a long scheduled emission was active", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    let settleFirst: ((receipt: TriggerReceipt) => void) | undefined;
    let calls = 0;
    const host = new RecordingHost(async () => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<TriggerReceipt>((resolve) => { settleFirst = resolve; });
      }
      return { status: "accepted", runId: `run-${String(calls)}` };
    }, durable);
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    await clock.advanceTo("2026-07-23T08:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    await clock.jumpTo("2026-07-23T08:03:00.000Z");
    settleFirst?.({ status: "accepted", runId: "run-1" });
    await waitFor(() => host.events.length === 3);
    await waitFor(() =>
      (durable.onlyRecord().lastOutcome as { scheduledAt?: unknown; status?: unknown } | undefined)?.scheduledAt
        === "2026-07-23T08:03:00.000Z"
      && (durable.onlyRecord().lastOutcome as { status?: unknown } | undefined)?.status === "accepted");
    expect(host.events.map(scheduledAt)).toEqual([
      "2026-07-23T08:01:00.000Z",
      "2026-07-23T08:02:00.000Z",
      "2026-07-23T08:03:00.000Z",
    ]);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("allows only one emitter to win a shared durable CAS reservation", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const firstHost = new RecordingHost(undefined, durable);
    const secondHost = new RecordingHost(undefined, durable);
    const first = createCronTrigger({ instanceId: "cron", jobs: [job()], host: firstHost, clock });
    const second = createCronTrigger({ instanceId: "cron", jobs: [job()], host: secondHost, clock });
    await first.start?.({ signal: new AbortController().signal });
    await second.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    const results = await Promise.all([
      first.invoke("heartbeat", "2026-07-23T08:01:00.000Z"),
      second.invoke("heartbeat", "2026-07-23T08:01:00.000Z"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["accepted", "duplicate"]);
    expect(firstHost.events.length + secondHost.events.length).toBe(1);
    await first.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("blocks scheduled work behind a foreign owner, refreshes durable state, and resumes after release", async () => {
    const durable = new InMemoryCronDurableState();
    const firstClock = new TestClock("2026-07-23T08:00:00.000Z");
    const secondClock = new TestClock("2026-07-23T08:00:00.000Z");
    let settleFirst: ((receipt: TriggerReceipt) => void) | undefined;
    const firstHost = new RecordingHost(
      () => new Promise((resolve) => { settleFirst = resolve; }),
      durable,
    );
    const secondHost = new RecordingHost(undefined, durable);
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: firstHost,
      clock: firstClock,
    });
    const second = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: secondHost,
      clock: secondClock,
    });
    await first.start?.({ signal: new AbortController().signal });
    await second.start?.({ signal: new AbortController().signal });
    await waitFor(() => firstClock.armedTimers > 0 && secondClock.armedTimers > 0);
    firstClock.setNow("2026-07-23T08:01:00.000Z");
    const active = first.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => firstHost.events.length === 1);
    await secondClock.advanceTo("2026-07-23T08:02:00.000Z");
    expect(secondHost.events).toHaveLength(0);
    await expect(second.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });
    settleFirst?.({ status: "accepted", runId: "first" });
    await expect(active).resolves.toMatchObject({ status: "accepted" });
    expect(durable.onlyRecord()).not.toHaveProperty("active");

    await secondClock.advanceBy(1_000);
    await waitFor(() => secondHost.events.length === 1);
    expect(secondHost.events.map(scheduledAt)).toEqual(["2026-07-23T08:02:00.000Z"]);
    await expect(second.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
    });
    await first.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("treats a scheduler that starts behind a live foreign fence as transient and heals after release", async () => {
    const durable = new InMemoryCronDurableState();
    const firstClock = new TestClock("2026-07-23T08:00:00.000Z");
    let settleFirst: ((receipt: TriggerReceipt) => void) | undefined;
    const firstHost = new RecordingHost(
      () => new Promise((resolve) => { settleFirst = resolve; }),
      durable,
    );
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: firstHost,
      clock: firstClock,
    });
    await first.start?.({ signal: new AbortController().signal });
    firstClock.setNow("2026-07-23T08:01:00.000Z");
    const active = first.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => firstHost.events.length === 1);

    const secondClock = new TestClock("2026-07-23T08:02:00.000Z");
    const secondHost = new RecordingHost(undefined, durable);
    const second = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: secondHost,
      clock: secondClock,
    });
    await second.start?.({ signal: new AbortController().signal });
    expect(durable.onlyRecord()).not.toHaveProperty("issue");
    await expect(second.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });

    settleFirst?.({ status: "accepted", runId: "first" });
    await expect(active).resolves.toMatchObject({ status: "accepted" });
    await secondClock.advanceBy(1_000);
    await waitFor(() => secondHost.events.length === 1);
    expect(secondHost.events.map(scheduledAt)).toEqual(["2026-07-23T08:02:00.000Z"]);
    expect(durable.onlyRecord()).not.toHaveProperty("issue");
    await expect(second.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
    });
    await first.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("lets an already-running peer repair a definitively settled foreign fence", async () => {
    const durable = new InMemoryCronDurableState();
    const firstClock = new TestClock("2026-07-23T08:00:00.000Z");
    const secondClock = new TestClock("2026-07-23T08:00:00.000Z");
    let settleFirst: ((receipt: TriggerReceipt) => void) | undefined;
    const firstHost = new RecordingHost(
      () => new Promise((resolve) => { settleFirst = resolve; }),
      durable,
    );
    const secondHost = new RecordingHost(undefined, durable);
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: firstHost,
      clock: firstClock,
    });
    const second = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: secondHost,
      clock: secondClock,
    });
    await first.start?.({ signal: new AbortController().signal });
    await second.start?.({ signal: new AbortController().signal });
    firstClock.setNow("2026-07-23T08:01:00.000Z");
    const active = first.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => firstHost.events.length === 1);
    await secondClock.advanceTo("2026-07-23T08:02:00.000Z");
    expect(secondHost.events).toHaveLength(0);

    durable.blockActiveClear();
    settleFirst?.({ status: "accepted", runId: "first" });
    await expect(active).resolves.toMatchObject({ status: "accepted" });
    expect(durable.onlyRecord()).toMatchObject({
      active: { scheduledAt: "2026-07-23T08:01:00.000Z" },
      lastOutcome: { status: "accepted", scheduledAt: "2026-07-23T08:01:00.000Z" },
    });
    await first.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    durable.allowActiveClear();

    await secondClock.advanceBy(1_000);
    await waitFor(() => secondHost.events.length === 1);
    await waitFor(() => !("active" in durable.onlyRecord()));
    expect(secondHost.events.map(scheduledAt)).toEqual(["2026-07-23T08:02:00.000Z"]);
    await expect(second.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
    });
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("records a restart clock regression even while a foreign owner is active", async () => {
    const durable = new InMemoryCronDurableState();
    const firstClock = new TestClock("2026-07-23T08:00:00.000Z");
    let settleFirst: ((receipt: TriggerReceipt) => void) | undefined;
    const firstHost = new RecordingHost(
      () => new Promise((resolve) => { settleFirst = resolve; }),
      durable,
    );
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: firstHost,
      clock: firstClock,
    });
    await first.start?.({ signal: new AbortController().signal });
    firstClock.setNow("2026-07-23T08:30:00.000Z");
    const active = first.invoke("heartbeat", "2026-07-23T08:30:00.000Z");
    await waitFor(() => firstHost.events.length === 1);

    const secondClock = new TestClock("2026-07-23T07:00:00.000Z");
    const second = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: new RecordingHost(undefined, durable),
      clock: secondClock,
    });
    await second.start?.({ signal: new AbortController().signal });
    expect(durable.onlyRecord()).toMatchObject({
      active: { scheduledAt: "2026-07-23T08:30:00.000Z" },
      clockRegressions: 1,
      lastClockRegression: {
        from: "2026-07-23T08:30:00.000Z",
        to: "2026-07-23T07:00:00.000Z",
      },
      issue: { status: "clock-regressed" },
    });

    settleFirst?.({ status: "accepted", runId: "first" });
    await expect(active).resolves.toMatchObject({ status: "accepted" });
    await secondClock.advanceBy(1_000);
    await expect(second.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "clock-regressed" } } },
    });
    expect(durable.onlyRecord()).toMatchObject({
      clockRegressions: 1,
      issue: { status: "clock-regressed" },
    });
    await first.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await second.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("retries a failed durable active-fence clear without losing the next firing", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost(undefined, durable);
    const trigger = createCronTrigger({ instanceId: "cron", jobs: [job()], host, clock });
    await trigger.start?.({ signal: new AbortController().signal });
    durable.blockActiveClear();
    clock.setNow("2026-07-23T08:01:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(durable.onlyRecord()).toMatchObject({
      watermark: "2026-07-23T08:01:00.000Z",
      active: { scheduledAt: "2026-07-23T08:01:00.000Z" },
      lastOutcome: { status: "accepted" },
    });
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { active: 1, persistenceFailures: ["heartbeat"] },
    });

    clock.setNow("2026-07-23T08:02:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z")).resolves.toMatchObject({
      status: "skipped",
      reason: "A definitively settled firing is awaiting durable fence repair.",
    });
    expect(host.events).toHaveLength(1);
    expect(durable.onlyRecord().watermark).toBe("2026-07-23T08:01:00.000Z");
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { active: 1, persistenceFailures: ["heartbeat"] },
    });

    durable.allowActiveClear();
    await clock.advanceBy(1_000);
    await waitFor(() => host.events.length === 2);
    await waitFor(() => !("active" in durable.onlyRecord()));
    await waitForActiveCount(trigger, 0);
    expect(host.events.map(scheduledAt)).toEqual([
      "2026-07-23T08:01:00.000Z",
      "2026-07-23T08:02:00.000Z",
    ]);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
      details: { active: 0, persistenceFailures: [] },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("repairs a definitively settled active fence after restart", async () => {
    const durable = new InMemoryCronDurableState();
    const firstClock = new TestClock("2026-07-23T08:00:00.000Z");
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: new RecordingHost(undefined, durable),
      clock: firstClock,
    });
    await first.start?.({ signal: new AbortController().signal });
    durable.blockActiveClear();
    firstClock.setNow("2026-07-23T08:01:00.000Z");
    await expect(first.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "accepted",
    });
    await first.stop?.({ signal: new AbortController().signal, reason: "restart" });
    expect(durable.onlyRecord()).toMatchObject({
      active: { scheduledAt: "2026-07-23T08:01:00.000Z" },
      lastOutcome: { status: "accepted", scheduledAt: "2026-07-23T08:01:00.000Z" },
    });

    durable.allowActiveClear();
    const restartHost = new RecordingHost(undefined, durable);
    const restarted = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: restartHost,
      clock: new TestClock("2026-07-23T08:02:00.000Z"),
    });
    await restarted.start?.({ signal: new AbortController().signal });
    await waitFor(() => restartHost.events.length === 1);
    await waitFor(() => !("active" in durable.onlyRecord()));
    expect(restartHost.events.map(scheduledAt)).toEqual(["2026-07-23T08:02:00.000Z"]);
    await expect(restarted.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
    });
    await restarted.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("fences a stale scheduler after another instance changes the durable schedule generation", async () => {
    const durable = new InMemoryCronDurableState();
    const oldClock = new TestClock("2026-07-23T08:00:00.000Z");
    const oldHost = new RecordingHost(undefined, durable);
    const oldTrigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: oldHost,
      clock: oldClock,
    });
    await oldTrigger.start?.({ signal: new AbortController().signal });

    const newClock = new TestClock("2026-07-23T08:00:00.000Z");
    const newHost = new RecordingHost(undefined, durable);
    const newTrigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job({ expression: "*/5 * * * *" })],
      host: newHost,
      clock: newClock,
    });
    await newTrigger.start?.({ signal: new AbortController().signal });
    const newFingerprint = durable.onlyRecord().scheduleFingerprint;

    await oldClock.advanceTo("2026-07-23T08:01:00.000Z");
    await flush();
    expect(oldHost.events).toHaveLength(0);
    expect(durable.onlyRecord().scheduleFingerprint).toBe(newFingerprint);
    await expect(oldTrigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "rejected",
      reason: "Cron schedule authority changed; this scheduler generation is fenced.",
    });
    await expect(oldTrigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { persistenceFailures: ["heartbeat"] },
    });

    await newClock.advanceTo("2026-07-23T08:05:00.000Z");
    await waitFor(() => newHost.events.length === 1);
    expect(newHost.events.map(scheduledAt)).toEqual(["2026-07-23T08:05:00.000Z"]);
    expect(oldHost.events).toHaveLength(0);
    expect(durable.onlyRecord().scheduleFingerprint).toBe(newFingerprint);
    await oldTrigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
    await newTrigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("bounds drain by its context signal or deadline and remains stoppable afterward", async () => {
    const aborted = createCronTrigger({
      instanceId: "aborted-drain",
      jobs: [job()],
      host: new RecordingHost(),
      clock: new TestClock("2026-07-23T08:00:00.000Z"),
    });
    await aborted.start?.({ signal: new AbortController().signal });
    if (aborted.drain === undefined) throw new Error("Expected cron drain lifecycle.");
    const cancellation = new Error("operator cancelled drain");
    const controller = new AbortController();
    controller.abort(cancellation);
    await expect(aborted.drain({ signal: controller.signal })).rejects.toBe(cancellation);
    await expect(aborted.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    })).resolves.toBeUndefined();

    const expired = createCronTrigger({
      instanceId: "expired-drain",
      jobs: [job()],
      host: new RecordingHost(),
      clock: new TestClock("2026-07-23T08:00:00.000Z"),
    });
    await expired.start?.({ signal: new AbortController().signal });
    if (expired.drain === undefined) throw new Error("Expected cron drain lifecycle.");
    await expect(expired.drain({
      signal: new AbortController().signal,
      deadline: "1970-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Cron drain deadline reached.",
    });
    await expect(expired.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    })).resolves.toBeUndefined();
  });

  it("stops after durable unknown settlement even when the raw host promise never settles", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost(
      () => new Promise<TriggerReceipt>(() => undefined),
      durable,
    );
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job({ maxRunMs: 1_000 })],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    const invocation = trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    await clock.advanceBy(1_000);
    await expect(invocation).resolves.toMatchObject({ status: "unknown" });
    let stopped = false;
    const stopping = Promise.resolve(trigger.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    })).then(() => { stopped = true; });
    await waitFor(() => stopped);
    await stopping;
    expect(durable.onlyRecord()).toMatchObject({
      active: { scheduledAt: "2026-07-23T08:01:00.000Z" },
      issue: { status: "unknown" },
    });

    const restartHost = new RecordingHost(undefined, durable);
    const restarted = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: restartHost,
      clock: new TestClock("2026-07-23T08:02:00.000Z"),
    });
    await restarted.start?.({ signal: new AbortController().signal });
    await expect(restarted.invoke("heartbeat", "2026-07-23T08:02:00.000Z")).resolves.toMatchObject({
      status: "skipped",
    });
    expect(restartHost.events).toHaveLength(0);
    await restarted.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("keeps a durable unknown issue after settlement persistence fails and later writes recover", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    let calls = 0;
    const host = new RecordingHost(async () => {
      calls += 1;
      if (calls === 1) durable.failNextCompareAndSwap();
      return { status: "accepted", runId: `run-${String(calls)}` };
    }, durable);
    const trigger = createCronTrigger({ instanceId: "cron", jobs: [job()], host, clock });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "unknown",
    });
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });

    clock.setNow("2026-07-23T08:02:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(durable.onlyRecord()).toMatchObject({
      issue: { status: "unknown", scheduledAt: "2026-07-23T08:01:00.000Z" },
      lastOutcome: { status: "accepted", scheduledAt: "2026-07-23T08:02:00.000Z" },
    });
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("does not forget an older active outcome whose settlement fails after a newer overlap decision", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    let settleFirst: ((receipt: TriggerReceipt) => void) | undefined;
    let calls = 0;
    const host = new RecordingHost(async () => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<TriggerReceipt>((resolve) => { settleFirst = resolve; });
      }
      return { status: "accepted", runId: `run-${String(calls)}` };
    }, durable);
    const trigger = createCronTrigger({ instanceId: "cron", jobs: [job()], host, clock });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:02:00.000Z");
    const first = trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:02:00.000Z")).resolves.toMatchObject({
      status: "skipped",
    });
    durable.failNextCompareAndSwap();
    settleFirst?.({ status: "rejected", code: "execution_failed", reason: "capacity" });
    await expect(first).resolves.toMatchObject({ status: "unknown" });
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });

    clock.setNow("2026-07-23T08:03:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:03:00.000Z")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(durable.onlyRecord()).toMatchObject({
      issue: { status: "unknown", scheduledAt: "2026-07-23T08:01:00.000Z" },
      lastOutcome: { status: "accepted", scheduledAt: "2026-07-23T08:03:00.000Z" },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("rejects future command instants without advancing the schedule watermark", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost(undefined, durable);
    const trigger = createCronTrigger({ instanceId: "cron", jobs: [job()], host, clock });
    await trigger.start?.({ signal: new AbortController().signal });
    const before = durable.onlyRecord().watermark;
    await expect(trigger.invoke("heartbeat", "2030-01-01T00:00:00.000Z")).rejects.toThrow(
      /must not be in the future/u,
    );
    expect(durable.onlyRecord().watermark).toBe(before);
    expect(host.events).toHaveLength(0);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "healthy",
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("records a restart behind the persisted watermark as a clock regression", async () => {
    const durable = new InMemoryCronDurableState();
    const first = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: new RecordingHost(undefined, durable),
      clock: new TestClock("2026-07-23T08:30:00.000Z"),
    });
    await first.start?.({ signal: new AbortController().signal });
    await first.stop?.({ signal: new AbortController().signal, reason: "restart" });

    const restartHost = new RecordingHost(undefined, durable);
    const restarted = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: restartHost,
      clock: new TestClock("2026-07-23T07:00:00.000Z"),
    });
    await restarted.start?.({ signal: new AbortController().signal });
    expect(restartHost.events).toHaveLength(0);
    expect(durable.onlyRecord()).toMatchObject({
      watermark: "2026-07-23T08:30:00.000Z",
      clockRegressions: 1,
      lastClockRegression: {
        from: "2026-07-23T08:30:00.000Z",
        to: "2026-07-23T07:00:00.000Z",
      },
    });
    await expect(restarted.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "clock-regressed" } } },
    });
    await restarted.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("bounds a forward-jump catch-up, records the omitted range, and stays degraded", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost(undefined, durable);
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    await clock.jumpTo("2026-07-23T08:35:00.000Z");
    await waitFor(() => host.events.length === MAX_CRON_CATCH_UP);
    expect(host.events.map(scheduledAt)).toEqual([
      "2026-07-23T08:04:00.000Z",
      ...Array.from({ length: MAX_CRON_CATCH_UP - 1 }, (_value, index) =>
        new Date(Date.parse("2026-07-23T08:05:00.000Z") + index * 60_000).toISOString()),
    ]);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: {
        issues: {
          heartbeat: {
            status: "missed",
            scheduledAt: "2026-07-23T08:03:00.000Z",
          },
        },
      },
    });
    expect(durable.onlyRecord()).toMatchObject({
      missed: {
        from: "2026-07-23T08:01:00.000Z",
        through: "2026-07-23T08:03:00.000Z",
      },
      watermark: "2026-07-23T08:35:00.000Z",
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("accounts for a backward wall-clock jump and emits the target once after time catches up", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost(undefined, durable);
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    await clock.fireNextAt("2026-07-23T07:00:00.000Z");
    await waitFor(() => durable.onlyRecord().clockRegressions === 1);
    await waitFor(() => clock.armedTimers > 0);
    expect(host.events).toHaveLength(0);
    await clock.jumpTo("2026-07-23T08:01:00.000Z");
    await waitFor(() => host.events.length === 1);
    expect(host.events.map(scheduledAt)).toEqual(["2026-07-23T08:01:00.000Z"]);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "clock-regressed" } } },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("retains and retries clock-regression evidence after a transient durable CAS failure", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const host = new RecordingHost(undefined, durable);
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    durable.blockClockRegression();
    await clock.fireNextAt("2026-07-23T07:00:00.000Z");
    expect(durable.onlyRecord().clockRegressions).toBe(0);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: {
        issues: { heartbeat: { status: "clock-regressed" } },
      },
    });

    clock.setNow("2026-07-23T08:01:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "rejected",
      reason: "Cron is awaiting durable clock-regression evidence.",
    });
    expect(host.events).toHaveLength(0);
    expect(durable.onlyRecord().clockRegressions).toBe(0);

    durable.allowClockRegression();
    await clock.jumpTo("2026-07-23T08:01:01.000Z");
    await waitFor(() => durable.onlyRecord().clockRegressions === 1);
    await waitFor(() => host.events.length === 1);
    expect(durable.onlyRecord()).toMatchObject({
      clockRegressions: 1,
      lastClockRegression: {
        from: "2026-07-23T08:00:00.000Z",
        to: "2026-07-23T07:00:00.000Z",
      },
    });
    expect(host.events.map(scheduledAt)).toEqual(["2026-07-23T08:01:00.000Z"]);
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "clock-regressed" } } },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("persists an unknown crash boundary, refuses replay after restart, and reports degraded health", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const uncertainHost = new RecordingHost(async () => {
      throw new Error("connection disappeared after dispatch");
    }, durable);
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: uncertainHost,
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "unknown",
    });
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "restart" });

    const restartedHost = new RecordingHost(undefined, durable);
    const restarted = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: restartedHost,
      clock: new TestClock("2026-07-23T08:01:00.000Z"),
    });
    await restarted.start?.({ signal: new AbortController().signal });
    await flush();
    expect(restartedHost.events).toHaveLength(0);
    await expect(restarted.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "unknown" } } },
    });
    await restarted.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("reports an explicit rejected receipt as a durable degraded outcome", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: new RecordingHost(
        async () => ({ status: "rejected", code: "execution_failed", reason: "unknown" }),
        durable,
      ),
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(trigger.health?.({ signal: new AbortController().signal })).resolves.toMatchObject({
      status: "degraded",
      details: { issues: { heartbeat: { status: "rejected" } } },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
  });

  it("uses typed unknown receipt status even when display text is fully redacted", async () => {
    const durable = new InMemoryCronDurableState();
    const clock = new TestClock("2026-07-23T08:00:00.000Z");
    const trigger = createCronTrigger({
      instanceId: "cron",
      jobs: [job()],
      host: new RecordingHost(
        async () => ({
          status: "unknown",
          code: "delivery_unknown",
          reason: "Trigger delivery ended with [REDACTED]",
        }),
        durable,
      ),
      clock,
    });
    await trigger.start?.({ signal: new AbortController().signal });
    clock.setNow("2026-07-23T08:01:00.000Z");
    await expect(trigger.invoke("heartbeat", "2026-07-23T08:01:00.000Z")).resolves.toMatchObject({
      status: "unknown",
    });
    expect(durable.onlyRecord()).toMatchObject({
      lastOutcome: { status: "unknown" },
      issue: { status: "unknown" },
    });
    await trigger.stop?.({ signal: new AbortController().signal, reason: "shutdown" });
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
  readonly grantedCapabilities: ReadonlySet<string>;
  readonly events: TriggerEvent[] = [];

  constructor(
    private readonly handler: (
      event: TriggerEvent,
      signal: AbortSignal,
    ) => Promise<TriggerReceipt> = async () => ({ status: "accepted", runId: "run" }),
    private readonly durableState?: CronDurableStateCapability,
  ) {
    this.grantedCapabilities = durableState === undefined
      ? new Set()
      : new Set([HOST_CAPABILITY_CRON_DURABLE_STATE]);
  }

  getCapability<T = unknown>(name: string): T | undefined {
    return name === HOST_CAPABILITY_CRON_DURABLE_STATE
      ? this.durableState as T | undefined
      : undefined;
  }

  async emit(event: TriggerEvent, signal: AbortSignal): Promise<TriggerReceipt> {
    this.events.push(event);
    return await this.handler(event, signal);
  }
}

class InMemoryCronDurableState implements CronDurableStateCapability {
  readonly #records = new Map<string, { readonly value: Uint8Array; readonly version: string }>();
  #generation = 0;
  #failNextCompareAndSwap = false;
  #blockActiveClear = false;
  #blockClockRegression = false;

  failNextCompareAndSwap(): void {
    this.#failNextCompareAndSwap = true;
  }

  blockActiveClear(): void {
    this.#blockActiveClear = true;
  }

  allowActiveClear(): void {
    this.#blockActiveClear = false;
  }

  blockClockRegression(): void {
    this.#blockClockRegression = true;
  }

  allowClockRegression(): void {
    this.#blockClockRegression = false;
  }

  async read(request: CronDurableStateReadRequest) {
    if (request.signal.aborted) throw request.signal.reason;
    const found = this.#records.get(request.key);
    return found === undefined
      ? undefined
      : { value: Uint8Array.from(found.value), version: found.version };
  }

  async compareAndSwap(request: CronDurableStateCompareAndSwapRequest) {
    if (request.signal.aborted) throw request.signal.reason;
    if (this.#failNextCompareAndSwap) {
      this.#failNextCompareAndSwap = false;
      throw new Error("injected durable CAS failure");
    }
    const current = this.#records.get(request.key);
    const currentRecord = current === undefined
      ? undefined
      : JSON.parse(Buffer.from(current.value).toString("utf8")) as Record<string, unknown>;
    const nextRecord = JSON.parse(Buffer.from(request.value).toString("utf8")) as Record<string, unknown>;
    if (
      this.#blockActiveClear
      && currentRecord !== undefined
      && "active" in currentRecord
      && !("active" in nextRecord)
    ) {
      throw new Error("injected durable active-clear failure");
    }
    if (
      this.#blockClockRegression
      && currentRecord !== undefined
      && typeof currentRecord.clockRegressions === "number"
      && typeof nextRecord.clockRegressions === "number"
      && nextRecord.clockRegressions > currentRecord.clockRegressions
    ) {
      throw new Error("injected durable clock-regression failure");
    }
    if ((current?.version ?? null) !== request.expectedVersion) {
      return {
        status: "conflict" as const,
        ...(current === undefined ? {} : { currentVersion: current.version }),
      };
    }
    const version = `v${String(++this.#generation)}`;
    this.#records.set(request.key, { value: Uint8Array.from(request.value), version });
    return { status: "applied" as const, version };
  }

  onlyRecord(): Record<string, unknown> {
    expect(this.#records.size).toBe(1);
    const stored = [...this.#records.values()][0];
    if (stored === undefined) throw new Error("Expected one durable record.");
    return JSON.parse(Buffer.from(stored.value).toString("utf8")) as Record<string, unknown>;
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

  get armedTimers(): number {
    return this.#timers.size;
  }

  now(): Date {
    return new Date(this.#now);
  }

  setNow(instant: string): void {
    this.#now = new Date(instant).getTime();
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

  async jumpTo(instant: string): Promise<void> {
    this.#now = new Date(instant).getTime();
    while (true) {
      const timer = [...this.#timers.values()]
        .filter((entry) => entry.at <= this.#now)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (timer === undefined) break;
      this.#timers.delete(timer.id);
      timer.callback();
      await flush();
    }
    await flush();
  }

  async fireNextAt(instant: string): Promise<void> {
    const timer = [...this.#timers.values()]
      .sort((left, right) => left.at - right.at || left.id - right.id)[0];
    if (timer === undefined) throw new Error("Expected an armed timer.");
    this.#timers.delete(timer.id);
    this.#now = new Date(instant).getTime();
    timer.callback();
    await flush();
  }
}

function scheduledAt(event: TriggerEvent): string {
  const cron = event.metadata?.cron;
  if (typeof cron !== "object" || cron === null || Array.isArray(cron)) {
    throw new Error("Expected cron metadata.");
  }
  const value = (cron as { scheduledAt?: unknown }).scheduledAt;
  if (typeof value !== "string") throw new Error("Expected scheduledAt metadata.");
  return value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for scheduler settlement.");
}

async function waitForActiveCount(trigger: CronTrigger, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const health = await trigger.health?.({ signal: new AbortController().signal });
    if (health?.details?.active === expected) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for cron active count.");
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

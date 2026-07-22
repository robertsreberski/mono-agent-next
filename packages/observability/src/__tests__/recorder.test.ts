import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

const writeFault = vi.hoisted(() => ({
  intercept: undefined as undefined | ((
    original: (filePath: string, contents: string) => Promise<void>,
    filePath: string,
    contents: string,
  ) => Promise<void>),
}));

vi.mock("../artifact-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../artifact-fs.js")>();
  return {
    ...actual,
    writeJsonAtomic: async (filePath: string, contents: string): Promise<void> => {
      const intercept = writeFault.intercept;
      return intercept === undefined
        ? await actual.writeJsonAtomic(filePath, contents)
        : await intercept(actual.writeJsonAtomic, filePath, contents);
    },
  };
});

import { createJsonlRunRecorder } from "../index.js";
import { ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS } from "../artifact-fs.js";
import {
  RUN_CHECKPOINT_EVENT_INTERVAL,
  RUN_CHECKPOINT_TIME_INTERVAL_MS,
  redactJsonValue,
} from "../recorder.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "observability-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  writeFault.intercept = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface CheckpointSummary {
  readonly status: string;
  readonly eventCount: number;
  readonly endedAt?: string;
}

async function waitForSummary(
  summaryPath: string,
  predicate: (summary: CheckpointSummary) => boolean,
): Promise<CheckpointSummary> {
  return await vi.waitFor(async () => {
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as CheckpointSummary;
    if (!predicate(summary)) {
      throw new Error(`summary has not reached the expected checkpoint: ${JSON.stringify(summary)}`);
    }
    return summary;
  }, { interval: 10, timeout: 2_000 });
}

describe("JsonlRunRecorder", () => {
  it("removes old atomic-write temps on init while retaining fresh and unrelated temps", async () => {
    const dir = await tempDir();
    const oldTemp = `cleanup-run.summary.json.${process.pid}.999999997.tmp`;
    const freshTemp = `cleanup-run.events.jsonl.${process.pid}.999999998.tmp`;
    const unrelatedTemp = `unrelated.${process.pid}.999999999.tmp`;
    for (const name of [oldTemp, freshTemp, unrelatedTemp]) {
      await writeFile(join(dir, name), name, "utf8");
    }
    const old = new Date(Date.now() - ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS - 1_000);
    await utimes(join(dir, oldTemp), old, old);

    const recorder = createJsonlRunRecorder({
      runId: "cleanup-run",
      conversationId: "cleanup",
      artifactDir: dir,
    });
    await recorder.start?.();

    const entries = await readdir(dir);
    expect(entries).not.toContain(oldTemp);
    expect(entries).toContain(freshTemp);
    expect(entries).toContain(unrelatedTemp);
  });

  it("persists the user prompt into the summary so backfill can show it as input", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "run:1",
      conversationId: "webhook:1",
      artifactDir: dir,
      userInput: "What is the capital of France?",
    });
    const summary = await recorder.finish({});
    expect(summary.userInput).toBe("What is the capital of France?");
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as { userInput?: string };
    expect(onDisk.userInput).toBe("What is the capital of France?");
  });

  it("persists the model (from the result) and system prompt (from the recorder option)", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "mem-capture-distill-1",
      conversationId: "memory:capture:distill",
      artifactDir: dir,
      systemPrompt: "You are the private memory maintenance LLM.",
    });
    const summary = await recorder.finish({ model: "pi:opencode-go:kimi-k2.6" });
    expect(summary.model).toBe("pi:opencode-go:kimi-k2.6");
    expect(summary.systemPrompt).toBe("You are the private memory maintenance LLM.");
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as {
      model?: string;
      systemPrompt?: string;
    };
    expect(onDisk.model).toBe("pi:opencode-go:kimi-k2.6");
    expect(onDisk.systemPrompt).toBe("You are the private memory maintenance LLM.");
  });

  it("writes memory-kind artifacts under the memory namespace without inventing source metadata", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "mem-capture-distill-1",
      conversationId: "memory:capture:distill",
      artifactDir: dir,
      artifactKind: "memory",
    });

    const summary = await recorder.finish({ model: "pi:opencode-go:kimi-k2.6" });

    expect(summary.artifactPaths[0]).toBe(join(dir, "memory", "mem-capture-distill-1.events.jsonl"));
    expect(summary.artifactPaths[1]).toBe(join(dir, "memory", "mem-capture-distill-1.summary.json"));
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as { source?: string };
    expect(onDisk.source).toBeUndefined();
  });

  it("prefers the result's system prompt and caps it beyond the per-event byte limit", async () => {
    const dir = await tempDir();
    // maxStringBytes (256) bounds event content, but the system prompt rides its
    // own larger cap, so a long compiled prompt survives well past 256 bytes.
    const longPrompt = "S".repeat(5_000);
    const recorder = createJsonlRunRecorder({
      runId: "run:sp",
      conversationId: "telegram:1",
      artifactDir: dir,
      maxStringBytes: 256,
      systemPrompt: "recorder-option-prompt",
    });
    const summary = await recorder.finish({ systemPrompt: longPrompt });
    // The result's prompt wins over the recorder option.
    expect(String(summary.systemPrompt).startsWith("SSSS")).toBe(true);
    expect(String(summary.systemPrompt).length).toBeGreaterThan(1_000);
  });

  it("captures events and writes redacted summary artifacts", async () => {
    const dir = await tempDir();
    let now = 1000;
    const recorder = createJsonlRunRecorder({ runId: "run:1", conversationId: "telegram:1", artifactDir: dir, clock: () => now });

    recorder.onEvent({ type: "request", apiKey: "redacted-value", nested: { token: "fixture-token-value" } });
    now = 1250;
    const summary = await recorder.finish({
      usage: { inputTokens: 3 },
      cost: { totalUsd: 0.01 },
      providerSessionId: "session-1",
      isolated: true,
      capabilitiesUsed: ["tools:read"],
    });

    expect(summary).toMatchObject({
      status: "succeeded",
      durationMs: 250,
      eventCount: 1,
      providerSessionId: "session-1",
      isolated: true,
      cost: { totalUsd: 0.01 },
      capabilitiesUsed: ["tools:read"],
    });
    const events = await readFile(summary.artifactPaths[0] ?? "", "utf8");
    expect(events).toContain('"apiKey":"[redacted]"');
    expect(events).toContain('"token":"[redacted]"');
    const summaryJson = await readFile(summary.artifactPaths[1] ?? "", "utf8");
    expect(summaryJson).toContain('"status": "succeeded"');
    expect(summaryJson).toContain('"isolated": true');
  });

  it("content-scans high-confidence credential shapes before any run content reaches disk", async () => {
    const dir = await tempDir();
    const credential = `sk-${"A".repeat(48)}`;
    const recorder = createJsonlRunRecorder({
      runId: "run:credential-scan",
      conversationId: "tui:credential-scan",
      artifactDir: dir,
      userInput: `user ${credential}`,
      systemPrompt: `option system ${credential}`,
      source: `source ${credential}`,
      sourceDetail: `detail ${credential}`,
    });

    recorder.onEvent({ type: "assistant", text: `event ${credential}` });
    const summary = await recorder.finish({
      systemPrompt: `result system ${credential}`,
      error: `provider ${credential}`,
      failureKind: `failure ${credential}`,
      failoverHistory: [{ requestId: credential }],
      usage: { note: `usage ${credential}` },
      cost: { note: `cost ${credential}` },
      model: `model ${credential}`,
      providerSessionId: credential,
      effort: `effort ${credential}`,
      runtimeWarnings: [`warning ${credential}`],
      diagnostics: { detail: `diagnostic ${credential}` },
      capabilitiesUsed: [`capability ${credential}`],
    });

    const persisted = `${await readFile(summary.artifactPaths[0]!, "utf8")}\n${await readFile(summary.artifactPaths[1]!, "utf8")}`;
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain("[redacted]");
    expect(JSON.stringify(summary)).not.toContain(credential);
    expect(summary).toMatchObject({
      userInput: "user [redacted]",
      systemPrompt: "result system [redacted]",
      error: "provider [redacted]",
      providerSessionId: "[redacted]",
      source: "source [redacted]",
      sourceDetail: "detail [redacted]",
    });
  });

  it("caps oversized event strings at the 4,096-byte recorder default before terminal JSONL persistence", async () => {
    const dir = await tempDir();
    const tailSentinel = "TAIL-MUST-NOT-REACH-JSONL";
    const recorder = createJsonlRunRecorder({
      runId: "run:oversized-event",
      conversationId: "tui:oversized-event",
      artifactDir: dir,
    });

    recorder.onEvent({
      type: "assistant_thought",
      text: `${"x".repeat(300_000)}${tailSentinel}`,
    });
    const summary = await recorder.finish({});
    const event = JSON.parse((await readFile(summary.artifactPaths[0] ?? "", "utf8")).trim()) as {
      text?: string;
    };
    const retainedHead = event.text?.split("…[truncated")[0] ?? "";

    expect(Buffer.byteLength(retainedHead, "utf8")).toBe(4_096);
    expect(event.text).toContain("…[truncated");
    expect(event.text).not.toContain(tailSentinel);
  });

  it("persists recorder-level isolated identity for running and failed summaries", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "run:isolated",
      conversationId: "cron:daily",
      artifactDir: dir,
      isolated: true,
    });

    const running = await recorder.start?.();
    const failed = await recorder.fail(new Error("boom"));

    expect(running).toMatchObject({ status: "running", isolated: true });
    expect(failed).toMatchObject({ status: "failed", isolated: true });
  });

  it("stamps events with no usable timestamp using the injected clock, but preserves provider-supplied timestamps untouched", async () => {
    const dir = await tempDir();
    let now = Date.parse("2026-05-16T08:00:00.000Z");
    const recorder = createJsonlRunRecorder({ runId: "run:ts", conversationId: "telegram:1", artifactDir: dir, clock: () => now });

    recorder.onEvent({ type: "assistant", message: "no timestamp field at all" });
    now = Date.parse("2026-05-16T08:00:01.000Z");
    recorder.onEvent({ type: "provider_request_started", timestamp: "1778952408375" });
    now = Date.parse("2026-05-16T08:00:02.000Z");
    recorder.onEvent({ type: "tool.call", timestamp: 1778952409000 });

    const summary = await recorder.finish({});
    const events = (await readFile(summary.artifactPaths[0] ?? "", "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; timestamp?: unknown });

    expect(events[0]?.timestamp).toBe("2026-05-16T08:00:00.000Z");
    expect(events[1]?.timestamp).toBe("1778952408375");
    expect(events[2]?.timestamp).toBe(1778952409000);
  });

  it("persists effort (from the result) and source/sourceDetail (from the recorder options)", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "run:effort",
      conversationId: "cron:nightly-digest",
      artifactDir: dir,
      source: "cron",
      sourceDetail: "nightly-digest",
    });
    const summary = await recorder.finish({ effort: "high" });
    expect(summary.effort).toBe("high");
    expect(summary.source).toBe("cron");
    expect(summary.sourceDetail).toBe("nightly-digest");
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as {
      effort?: string;
      source?: string;
      sourceDetail?: string;
    };
    expect(onDisk.effort).toBe("high");
    expect(onDisk.source).toBe("cron");
    expect(onDisk.sourceDetail).toBe("nightly-digest");
  });

  it("omits effort/source/sourceDetail when not supplied", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "run:no-effort", conversationId: "c", artifactDir: dir });
    const summary = await recorder.finish({});
    expect(summary.effort).toBeUndefined();
    expect(summary.source).toBeUndefined();
    expect(summary.sourceDetail).toBeUndefined();
  });

  it("writes empty running artifacts, buffers events, and persists them only at the terminal boundary", async () => {
    const dir = await tempDir();
    let now = Date.parse("2026-05-16T08:00:00.000Z");
    const recorder = createJsonlRunRecorder({
      runId: "live-run",
      conversationId: "telegram:live",
      artifactDir: dir,
      clock: () => now,
    });

    if (recorder.start === undefined) {
      throw new Error("recorder must support start()");
    }
    const running = await recorder.start();

    expect(running).toMatchObject({
      runId: "live-run",
      status: "running",
      startedAt: "2026-05-16T08:00:00.000Z",
      updatedAt: "2026-05-16T08:00:00.000Z",
      durationMs: 0,
      eventCount: 0,
    });
    expect(await readFile(running.artifactPaths[1] ?? "", "utf8")).toContain('"status": "running"');
    expect(await readFile(running.artifactPaths[0] ?? "", "utf8")).toBe("");

    recorder.onEvent({ type: "assistant", message: "visible" });
    // One event at 2.5 seconds has reached neither checkpoint threshold.
    expect(await readFile(running.artifactPaths[0] ?? "", "utf8")).toBe("");
    now = Date.parse("2026-05-16T08:00:02.500Z");
    const final = await recorder.finish({});

    expect(final).toMatchObject({
      status: "succeeded",
      startedAt: "2026-05-16T08:00:00.000Z",
      endedAt: "2026-05-16T08:00:02.500Z",
      updatedAt: "2026-05-16T08:00:02.500Z",
      durationMs: 2500,
      eventCount: 1,
    });
    expect(await readFile(final.artifactPaths[1] ?? "", "utf8")).toContain('"status": "succeeded"');
    expect(await readFile(final.artifactPaths[0] ?? "", "utf8")).toContain('"message":"visible"');
  });

  it("persists a running crash checkpoint after the event bound without requiring finish", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "crash-mid-run",
      conversationId: "webhook:crash",
      artifactDir: dir,
    });
    const running = await recorder.start?.();
    if (running === undefined) {
      throw new Error("recorder must support start()");
    }

    for (let index = 0; index < RUN_CHECKPOINT_EVENT_INTERVAL - 1; index += 1) {
      recorder.onEvent({ type: "assistant", index, text: `chunk-${index}` });
    }
    const beforeThreshold = JSON.parse(await readFile(running.artifactPaths[1] ?? "", "utf8")) as CheckpointSummary;
    expect(beforeThreshold.eventCount).toBe(0);
    recorder.onEvent({
      type: "assistant",
      index: RUN_CHECKPOINT_EVENT_INTERVAL - 1,
      text: `chunk-${RUN_CHECKPOINT_EVENT_INTERVAL - 1}`,
    });

    // Deliberately never call finish()/fail(): abandoning the recorder models a
    // process crash after the fire-and-forget checkpoint reaches disk.
    const checkpoint = await waitForSummary(
      running.artifactPaths[1] ?? "",
      (summary) => summary.status === "running" && summary.eventCount === RUN_CHECKPOINT_EVENT_INTERVAL,
    );
    const events = (await readFile(running.artifactPaths[0] ?? "", "utf8")).trim().split("\n");

    expect(checkpoint).toMatchObject({
      status: "running",
      eventCount: RUN_CHECKPOINT_EVENT_INTERVAL,
    });
    expect(checkpoint.endedAt).toBeUndefined();
    expect(events).toHaveLength(RUN_CHECKPOINT_EVENT_INTERVAL);
    expect(JSON.parse(events.at(-1) ?? "{}")).toMatchObject({
      index: RUN_CHECKPOINT_EVENT_INTERVAL - 1,
      text: `chunk-${RUN_CHECKPOINT_EVENT_INTERVAL - 1}`,
    });
  });

  it("checkpoints sparse events at the time bound without debouncing the first event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T08:00:00.000Z"));
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "sparse-run",
      conversationId: "cron:sparse",
      artifactDir: dir,
    });
    const running = await recorder.start?.();
    if (running === undefined) {
      throw new Error("recorder must support start()");
    }

    recorder.onEvent({ type: "assistant", text: "first" });
    await vi.advanceTimersByTimeAsync(RUN_CHECKPOINT_TIME_INTERVAL_MS - 1_000);
    recorder.onEvent({ type: "assistant", text: "second" });
    await vi.advanceTimersByTimeAsync(999);
    const beforeDeadline = JSON.parse(await readFile(running.artifactPaths[1] ?? "", "utf8")) as CheckpointSummary;
    expect(beforeDeadline.eventCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const checkpoint = await waitForSummary(
      running.artifactPaths[1] ?? "",
      (summary) => summary.status === "running" && summary.eventCount === 2,
    );
    expect(checkpoint.endedAt).toBeUndefined();
  });

  it("serializes an already-queued checkpoint before terminal finalization", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "checkpoint-terminal-race",
      conversationId: "telegram:race",
      artifactDir: dir,
    });
    await recorder.start?.();
    for (let index = 0; index < RUN_CHECKPOINT_EVENT_INTERVAL; index += 1) {
      recorder.onEvent({ type: "assistant", index });
    }

    // finish() starts while the threshold checkpoint is still fire-and-forget.
    // The serialized writer must leave the terminal snapshot as the last write.
    const final = await recorder.finish({ model: "test-model" });
    const onDisk = JSON.parse(await readFile(final.artifactPaths[1] ?? "", "utf8")) as CheckpointSummary;
    const events = (await readFile(final.artifactPaths[0] ?? "", "utf8")).trim().split("\n");

    expect(final).toMatchObject({
      status: "succeeded",
      eventCount: RUN_CHECKPOINT_EVENT_INTERVAL,
      model: "test-model",
    });
    expect(onDisk.status).toBe("succeeded");
    expect(onDisk.eventCount).toBe(RUN_CHECKPOINT_EVENT_INTERVAL);
    expect(onDisk.endedAt).toBeTypeOf("string");
    expect(events).toHaveLength(RUN_CHECKPOINT_EVENT_INTERVAL);
  });

  it("coalesces repeated triggers behind slow checkpoint I/O and follows with the newest snapshot", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "slow-checkpoint-coalescing",
      conversationId: "webhook:slow-checkpoint",
      artifactDir: dir,
    });
    const running = await recorder.start?.();
    if (running === undefined) {
      throw new Error("recorder must support start()");
    }

    const firstEventsWriteStarted = deferred();
    const releaseFirstEventsWrite = deferred();
    let eventsWriteCount = 0;
    writeFault.intercept = async (original, filePath, contents) => {
      if (filePath.endsWith(".events.jsonl")) {
        eventsWriteCount += 1;
        if (eventsWriteCount === 1) {
          firstEventsWriteStarted.resolve();
          await releaseFirstEventsWrite.promise;
        }
      }
      await original(filePath, contents);
    };

    for (let index = 0; index < RUN_CHECKPOINT_EVENT_INTERVAL; index += 1) {
      recorder.onEvent({ type: "assistant", index });
    }
    await firstEventsWriteStarted.promise;

    const finalEventCount = RUN_CHECKPOINT_EVENT_INTERVAL * 5;
    for (let index = RUN_CHECKPOINT_EVENT_INTERVAL; index < finalEventCount; index += 1) {
      recorder.onEvent({ type: "assistant", index });
    }
    const eventsWriteCountWhileBlocked = eventsWriteCount;
    releaseFirstEventsWrite.resolve();
    const checkpoint = await waitForSummary(
      running.artifactPaths[1] ?? "",
      (summary) => summary.status === "running" && summary.eventCount === finalEventCount,
    );
    const events = (await readFile(running.artifactPaths[0] ?? "", "utf8")).trim().split("\n");

    expect(checkpoint.endedAt).toBeUndefined();
    expect(eventsWriteCountWhileBlocked).toBe(1);
    expect(eventsWriteCount).toBe(2);
    expect(events).toHaveLength(finalEventCount);
    expect(events.map((line) => (JSON.parse(line) as { index: number }).index)).toEqual(
      Array.from({ length: finalEventCount }, (_, index) => index),
    );
  });

  it("swallows a checkpoint write failure without poisoning terminal recovery", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "checkpoint-write-failure",
      conversationId: "webhook:failure",
      artifactDir: dir,
    });
    await recorder.start?.();

    const checkpointAttempted = deferred();
    let failCheckpoint = true;
    writeFault.intercept = async (original, filePath, contents) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        checkpointAttempted.resolve();
        throw new Error("simulated checkpoint disk failure");
      }
      await original(filePath, contents);
    };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      for (let index = 0; index < RUN_CHECKPOINT_EVENT_INTERVAL; index += 1) {
        recorder.onEvent({ type: "assistant", index });
      }
      await checkpointAttempted.promise;

      // The required terminal write queues behind the rejected best-effort
      // checkpoint and must get a fresh, non-poisoned writer attempt.
      const final = await recorder.finish({ model: "recovered-model" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const onDisk = JSON.parse(await readFile(final.artifactPaths[1] ?? "", "utf8")) as CheckpointSummary;
      const events = (await readFile(final.artifactPaths[0] ?? "", "utf8")).trim().split("\n");

      expect(unhandledRejections).toEqual([]);
      expect(final).toMatchObject({
        status: "succeeded",
        eventCount: RUN_CHECKPOINT_EVENT_INTERVAL,
        model: "recovered-model",
      });
      expect(onDisk.status).toBe("succeeded");
      expect(onDisk.eventCount).toBe(RUN_CHECKPOINT_EVENT_INTERVAL);
      expect(events).toHaveLength(RUN_CHECKPOINT_EVENT_INTERVAL);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("cancels a pending sparse-event timer when terminal finalization starts", async () => {
    vi.useFakeTimers();
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "timer-terminal-race",
      conversationId: "telegram:timer-race",
      artifactDir: dir,
    });
    await recorder.start?.();
    recorder.onEvent({ type: "assistant", text: "only event" });

    const final = await recorder.finish({});
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RUN_CHECKPOINT_TIME_INTERVAL_MS * 2);
    const onDisk = JSON.parse(await readFile(final.artifactPaths[1] ?? "", "utf8")) as CheckpointSummary;

    expect(onDisk.status).toBe("succeeded");
    expect(onDisk.eventCount).toBe(1);
    expect(onDisk.endedAt).toBeTypeOf("string");
  });

  it("keeps prepareFinish non-terminal and commits late warnings exactly once", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "two-phase", conversationId: "telegram:1", artifactDir: dir });
    const running = await recorder.start?.();
    if (running === undefined || recorder.prepareFinish === undefined || recorder.commitFinish === undefined) {
      throw new Error("JSONL recorder must expose the two-phase terminal lifecycle");
    }

    await recorder.prepareFinish({ text: "provider answer" });
    expect(await readFile(running.artifactPaths[1] ?? "", "utf8")).toContain('"status": "running"');

    recorder.onEvent({
      type: "runtime_warning",
      warning_kind: "memory_persistence_degraded",
      message: "memory write failed",
    });
    const first = await recorder.commitFinish({ text: "provider answer" });
    const second = await recorder.commitFinish({ text: "different result must not replace terminal" });

    expect(second).toBe(first);
    expect(first).toMatchObject({ status: "succeeded", eventCount: 1 });
    const events = await readFile(first.artifactPaths[0] ?? "", "utf8");
    expect(events).toContain("memory_persistence_degraded");
  });

  it("marks runtime failures and cancellations honestly", async () => {
    const dir = await tempDir();
    const failed = createJsonlRunRecorder({ runId: "failed", conversationId: "c", artifactDir: dir });
    await expect(failed.finish({ error: "provider rejected request" })).resolves.toMatchObject({
      status: "failed",
      failureKind: "runtime_error",
    });

    const cancelled = createJsonlRunRecorder({ runId: "cancelled", conversationId: "c", artifactDir: dir });
    await expect(cancelled.finish({ cancelled: true })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("persists the underlying error message and normalized failover history for a failed run", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "exhausted", conversationId: "c", artifactDir: dir });
    const summary = await recorder.finish({
      error: "503 Service Unavailable",
      failureKind: "provider_unavailable_exhausted",
      failoverHistory: [
        { model: { reference: "pi:openai-codex:gpt-5.5" }, failureKind: "provider_unavailable", retryableSubkind: "timeout", requestId: null },
        { model: { reference: "pi:opencode-go:kimi-k2.6" }, failureKind: "provider_unavailable", retryableSubkind: "server_error", requestId: "abc123" },
      ],
    });
    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("503 Service Unavailable");
    expect(summary.failoverHistory).toEqual([
      { model: "pi:openai-codex:gpt-5.5", failureKind: "provider_unavailable", subkind: "timeout" },
      { model: "pi:opencode-go:kimi-k2.6", failureKind: "provider_unavailable", subkind: "server_error", requestId: "abc123" },
    ]);
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as {
      error?: string;
      failoverHistory?: unknown;
    };
    expect(onDisk.error).toBe("503 Service Unavailable");
    expect(onDisk.failoverHistory).toHaveLength(2);
  });

  it("creates failure summaries from thrown errors", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "throw", conversationId: "c", artifactDir: dir });
    const summary = await recorder.fail(new TypeError("Bad runtime"));
    expect(summary).toMatchObject({ status: "failed", failureKind: "TypeError" });
    const summaryJson = await readFile(summary.artifactPaths[1] ?? "", "utf8");
    expect(summaryJson).toContain("Bad runtime");
  });
});

describe("redactJsonValue", () => {
  it("redacts sensitive keys and handles circular objects", () => {
    const value: Record<string, unknown> = { authorization: "Bearer token" };
    value.self = value;
    expect(redactJsonValue(value)).toEqual({ authorization: "[redacted]", self: "[circular]" });
  });
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

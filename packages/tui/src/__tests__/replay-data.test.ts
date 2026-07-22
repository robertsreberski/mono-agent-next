import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonlRunRecorder } from "@mono-agent/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listReplayRuns, readReplayRun } from "../data/replay.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-replay-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("replay data", () => {
  it("lists recorded runs and reads a coalesced timeline with thinking + tools", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-1",
      conversationId: "telegram:42",
      artifactDir: dir,
      userInput: "list my files",
    });
    recorder.onEvent({ type: "provider_request_started", sdk: "pi", model: "claude-fable-5" });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: "let me " }] } });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: "look" }] } });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] } });
    recorder.onEvent({ type: "tool_update", tool_use_id: "t1", name: "bash", partial_result: "a.txt" });
    recorder.onEvent({ type: "tool_timing", tool_use_id: "t1", name: "bash", execution_ms: 5, is_error: false });
    recorder.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "You have one file." }] } });
    recorder.onEvent({ type: "cost_accumulated", cumulativeUsd: 0.01, tokens: { input: 10, output: 5 } });
    await recorder.finish({ text: "You have one file.", model: "claude-fable-5", usage: { input: 10, output: 5 } });

    const { runs } = await listReplayRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "run-1", conversationId: "telegram:42", status: "succeeded" });

    const replay = await readReplayRun(dir, "run-1");
    expect(replay).toBeDefined();
    const categories = replay!.timeline.map((item) => item.category);
    // Thinking deltas coalesce into ONE thinking item; the tool call and its
    // result stay visible; the answer is a message item.
    expect(categories).toContain("thinking");
    expect(categories).toContain("tool");
    expect(categories).toContain("message");
    const thinkingItems = replay!.timeline.filter((item) => item.category === "thinking");
    expect(thinkingItems).toHaveLength(1);
    expect(thinkingItems[0]?.sourceEventCount).toBe(2);
  });

  it("returns undefined for an unknown run id", async () => {
    await expect(readReplayRun(dir, "missing")).resolves.toBeUndefined();
  });

  it("stamps turnIndex/deltaMs on a multi-turn ISO-timestamped timeline and clamps a negative delta", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-multi-turn",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    // Turn 0: coalesced thinking (t0, t0+1s) -> tool_use (t0+5s) -> tool_result
    // (t0+3s, EARLIER than the tool_use before it -- clock skew). Turn 1 starts
    // right after the tool_result (segmentTimelineTurns boundary rule).
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { content: [{ type: "thinking", text: "let me " }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { content: [{ type: "thinking", text: "look" }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
    });
    recorder.onEvent({
      type: "user",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:10.000Z",
      message: { content: [{ type: "thinking", text: "done" }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:12.000Z",
      message: { content: [{ type: "text", text: "You have one file." }] },
    });
    await recorder.finish({ text: "You have one file.", model: "claude-fable-5" });

    const replay = await readReplayRun(dir, "run-multi-turn");
    expect(replay).toBeDefined();
    const { timeline, turns } = replay!;

    expect(timeline).toHaveLength(5); // thinking(coalesced) / tool_use / tool_result / thinking / text
    expect(turns).toHaveLength(2);

    const [thinking1, toolUse, toolResult, thinking2, text] = timeline;
    expect(thinking1?.turnIndex).toBe(0);
    expect(toolUse?.turnIndex).toBe(0);
    expect(toolResult?.turnIndex).toBe(0);
    expect(thinking2?.turnIndex).toBe(1);
    expect(text?.turnIndex).toBe(1);

    // First item: no previous item, so no delta.
    expect(thinking1?.deltaMs).toBeUndefined();
    expect(thinking1?.timestampMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));

    // deltaMs anchors on the PREVIOUS item's END, not its start: the coalesced
    // thinking item's last raw event is at t0+1s (its `endTimestamp`), so
    // tool_use (t0+5s) is 4s after that -- NOT 5s after the group's t0 start.
    expect(toolUse?.deltaMs).toBe(4_000);

    // tool_result's own timestamp (t0+3s) is BEFORE tool_use's (t0+5s) --
    // the raw delta would be -2000ms; clamp negatives to 0.
    expect(toolResult?.deltaMs).toBe(0);

    expect(thinking2?.deltaMs).toBe(7_000);
    expect(text?.deltaMs).toBe(2_000);

    expect(turns[0]?.turnIndex).toBe(0);
    expect(turns[1]?.turnIndex).toBe(1);
  });

  it("anchors deltaMs on a coalesced group's END timestamp, not its start", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-end-anchored-delta",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    // A coalesced thinking group spanning t0 -> t0+2s (timestamp != endTimestamp),
    // followed by a single item at t0+3s.
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { content: [{ type: "thinking", text: "first chunk " }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { content: [{ type: "thinking", text: "second chunk" }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { content: [{ type: "text", text: "answer" }] },
    });
    await recorder.finish({ text: "answer" });

    const replay = await readReplayRun(dir, "run-end-anchored-delta");
    expect(replay).toBeDefined();
    const { timeline } = replay!;
    expect(timeline).toHaveLength(2); // coalesced thinking group + text

    const [thinkingGroup, text] = timeline;
    expect(thinkingGroup?.sourceEventCount).toBe(2);
    expect(thinkingGroup?.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(thinkingGroup?.endTimestamp).toBe("2026-01-01T00:00:02.000Z");

    // If anchored on the group's START (t0), the delta would be 3000ms.
    // Anchored on its END (t0+2s) instead, it's 1000ms.
    expect(text?.deltaMs).toBe(1_000);
  });

  it("clamps a negative turn durationMs to 0 instead of leaving it negative", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-negative-turn-duration",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    // A single turn (no tool_result boundary) whose last item's timestamp is
    // BEFORE its first item's timestamp -- clock skew across the turn.
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:10.000Z",
      message: { content: [{ type: "text", text: "first" }] },
    });
    recorder.onEvent({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { content: [{ type: "text", text: "second" }] },
    });
    await recorder.finish({ text: "second" });

    const replay = await readReplayRun(dir, "run-negative-turn-duration");
    expect(replay).toBeDefined();
    expect(replay!.turns).toHaveLength(1);
    // Clamped to 0 (not dropped to undefined) -- see the comment on
    // clampTurnDuration in ../data/replay.ts for the rationale.
    expect(replay!.turns[0]?.durationMs).toBe(0);
  });

  it("has no timestamp annotations and a single turn for a pre-timestamp-stamping artifact", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-no-timestamps",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    const summary = await recorder.finish({ text: "hi" });
    // Simulate an artifact recorded before per-event ISO timestamps existed:
    // hand-write a raw event line with no `timestamp`/`createdAt`/`time` field
    // at all (the established pattern for this, see
    // observability/src/__tests__/recorded-runs.test.ts).
    await writeFile(
      summary.artifactPaths[0] ?? "",
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })}\n`,
      "utf8",
    );

    const replay = await readReplayRun(dir, "run-no-timestamps");
    expect(replay).toBeDefined();
    expect(replay!.timeline).toHaveLength(1);
    expect(replay!.timeline[0]?.timestampMs).toBeUndefined();
    expect(replay!.timeline[0]?.deltaMs).toBeUndefined();
    expect(replay!.timeline[0]?.turnIndex).toBe(0);
    expect(replay!.turns).toHaveLength(1);
  });

  it("uses summary.effort directly when present", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-effort-summary",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    await recorder.finish({ text: "hi", effort: "high" });

    const replay = await readReplayRun(dir, "run-effort-summary");
    expect(replay).toBeDefined();
    expect(replay!.detail.summary.effort).toBe("high");
    expect(replay!.effort).toBe("high");
  });

  it("falls back to the LAST run_config event's effort when summary.effort is absent (double-fire)", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-effort-fallback",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    recorder.onEvent({
      type: "run_config",
      model: "model-a",
      effort: "low",
      executionMode: "agentic",
      overridden: false,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    // Session-resume-retry double-fire: a second run_config later in the
    // stream. The LAST one wins.
    recorder.onEvent({
      type: "run_config",
      model: "model-b",
      effort: "high",
      executionMode: "agentic",
      overridden: true,
      timestamp: "2026-01-01T00:00:02.000Z",
    });
    await recorder.finish({ text: "hi" });

    const replay = await readReplayRun(dir, "run-effort-fallback");
    expect(replay).toBeDefined();
    expect(replay!.detail.summary.effort).toBeUndefined();
    expect(replay!.runConfig).toEqual({ model: "model-b", effort: "high", overridden: true });
    expect(replay!.effort).toBe("high");
  });

  it("resolves source: persisted source wins, otherwise falls back to deriveRunSource", async () => {
    const withSource = createJsonlRunRecorder({
      runId: "run-with-source",
      conversationId: "slack:99",
      artifactDir: dir,
      source: "cron",
      sourceDetail: "nightly-report",
    });
    await withSource.finish({ text: "ok" });

    const withoutSource = createJsonlRunRecorder({
      runId: "run-without-source",
      conversationId: "telegram:99",
      artifactDir: dir,
    });
    await withoutSource.finish({ text: "ok" });

    const { runs } = await listReplayRuns(dir);
    const withSourceItem = runs.find((run) => run.runId === "run-with-source");
    const withoutSourceItem = runs.find((run) => run.runId === "run-without-source");
    expect(withSourceItem?.resolvedSource).toBe("cron");
    expect(withoutSourceItem?.resolvedSource).toBe("telegram");
  });

  it("filters by resolved source", async () => {
    const telegramRun = createJsonlRunRecorder({
      runId: "run-telegram",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    await telegramRun.finish({ text: "ok" });
    const slackRun = createJsonlRunRecorder({
      runId: "run-slack",
      conversationId: "slack:1",
      artifactDir: dir,
    });
    await slackRun.finish({ text: "ok" });

    const { runs } = await listReplayRuns(dir, { sourceFilter: "telegram" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-telegram");
  });

  it("keeps memory runs out of the default list and opts them in with the memory source filter", async () => {
    await createJsonlRunRecorder({
      runId: "run-agent",
      conversationId: "telegram:1",
      artifactDir: dir,
      source: "telegram",
    }).finish({ text: "agent" });
    const namespacedMemory = createJsonlRunRecorder({
      runId: "mem-new",
      conversationId: "memory:capture:distill",
      artifactDir: dir,
      artifactKind: "memory",
      source: "memory",
    });
    namespacedMemory.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "new memory" }] } });
    await namespacedMemory.finish({ text: "new memory" });
    const legacyMemory = createJsonlRunRecorder({
      runId: "mem-legacy",
      conversationId: "memory:legacy",
      artifactDir: dir,
      source: "memory",
    });
    legacyMemory.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "legacy memory" }] } });
    await legacyMemory.finish({ text: "legacy memory" });

    const defaultList = await listReplayRuns(dir);
    expect(defaultList.runs.map((run) => run.runId)).toEqual(["run-agent"]);

    const memoryList = await listReplayRuns(dir, { sourceFilter: "memory" });
    expect(memoryList.runs.map((run) => run.runId).sort()).toEqual(["mem-legacy", "mem-new"]);
    expect(memoryList.runs.every((run) => run.resolvedSource === "memory")).toBe(true);

    await expect(readReplayRun(dir, "mem-new")).resolves.toBeUndefined();
    await expect(readReplayRun(dir, "mem-legacy")).resolves.toBeUndefined();
    await expect(readReplayRun(dir, "mem-new", { scope: "memory" })).resolves.toMatchObject({
      detail: { summary: { runId: "mem-new", summaryFileName: "memory/mem-new.summary.json" } },
    });
    await expect(readReplayRun(dir, "mem-legacy", { scope: "memory" })).resolves.toMatchObject({
      detail: { summary: { runId: "mem-legacy" } },
    });
  });

  it("filters BEFORE capping so a small maxRuns doesn't starve a rare, older matching source", async () => {
    // Four runs, newest-first by clock: 3 "other"-sourced runs (no known
    // conversationId prefix) plus 1 OLDER telegram run. A naive
    // cap-then-filter implementation with maxRuns=2 would only ever look at
    // the two newest ("other") runs and find zero telegram matches.
    const oldMatch = createJsonlRunRecorder({
      runId: "run-old-telegram",
      conversationId: "telegram:1",
      artifactDir: dir,
      clock: () => 1_000,
    });
    await oldMatch.finish({ text: "ok" });
    for (const [runId, epochMs] of [
      ["run-other-a", 2_000],
      ["run-other-b", 3_000],
      ["run-other-c", 4_000],
    ] as const) {
      const recorder = createJsonlRunRecorder({
        runId,
        conversationId: "unknown-channel:1",
        artifactDir: dir,
        clock: () => epochMs,
      });
      await recorder.finish({ text: "ok" });
    }

    const result = await listReplayRuns(dir, { sourceFilter: "telegram", maxRuns: 2 });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.runId).toBe("run-old-telegram");
    expect(result.totalRuns).toBe(4);
  });

  it("keeps the no-filter fast path capping behavior via the maxRuns option", async () => {
    for (const [runId, epochMs] of [
      ["run-a", 1_000],
      ["run-b", 2_000],
      ["run-c", 3_000],
    ] as const) {
      const recorder = createJsonlRunRecorder({
        runId,
        conversationId: "telegram:1",
        artifactDir: dir,
        clock: () => epochMs,
      });
      await recorder.finish({ text: "ok" });
    }

    const result = await listReplayRuns(dir, { maxRuns: 2 });
    expect(result.runs).toHaveLength(2);
    // Newest-first.
    expect(result.runs.map((run) => run.runId)).toEqual(["run-c", "run-b"]);
    expect(result.totalRuns).toBe(3);
  });

  it("accepts the legacy plain-number form of the second argument as maxRuns (back-compat)", async () => {
    for (const [runId, epochMs] of [
      ["run-a", 1_000],
      ["run-b", 2_000],
      ["run-c", 3_000],
    ] as const) {
      const recorder = createJsonlRunRecorder({
        runId,
        conversationId: "telegram:1",
        artifactDir: dir,
        clock: () => epochMs,
      });
      await recorder.finish({ text: "ok" });
    }

    const result = await listReplayRuns(dir, 2);
    expect(result.runs).toHaveLength(2);
    // Newest-first, same behavior as passing { maxRuns: 2 }.
    expect(result.runs.map((run) => run.runId)).toEqual(["run-c", "run-b"]);
    expect(result.totalRuns).toBe(3);
  });

  it("passes a larger maxStringBytes to readRecordedRun so large payloads aren't gutted", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-large-payload",
      conversationId: "telegram:1",
      artifactDir: dir,
      // Large enough that the full 10k-char payload below survives being
      // WRITTEN (recorder redaction also applies maxStringBytes at record
      // time); the assertion below is about the READ-side cap in
      // ../data/replay.ts (REPLAY_MAX_STRING_BYTES), not this one.
      maxStringBytes: 20_000,
    });
    const bigCommand = "x".repeat(10_000);
    recorder.onEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: bigCommand } }] },
    });
    await recorder.finish({ text: "ok" });

    const replay = await readReplayRun(dir, "run-large-payload");
    expect(replay).toBeDefined();
    const toolItem = replay!.timeline.find((item) => item.category === "tool");
    const payload = toolItem?.payload as { message?: { content?: Array<{ input?: { command?: string } }> } } | undefined;
    const command = payload?.message?.content?.[0]?.input?.command;
    // observability's own default READ maxStringBytes (4096) would have
    // truncated this 10k-char string; readReplayRun requests a larger cap
    // (see REPLAY_MAX_STRING_BYTES in ../data/replay.ts) so it survives whole.
    expect(command).toBe(bigCommand);
  });
});

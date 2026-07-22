import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mapRunToSession } from "../session-mapping.js";
import type { SessionStep } from "../session-mapping.js";
import type { RunSummary, RuntimeEventLike } from "../types.js";

/** Load a fixture summary + its raw event stream (one JSON object per JSONL line). */
function loadFixture(name: string): { summary: RunSummary; events: RuntimeEventLike[] } {
  const summaryUrl = new URL(`./fixtures/${name}.summary.json`, import.meta.url);
  const eventsUrl = new URL(`./fixtures/${name}.events.jsonl`, import.meta.url);
  const summary = JSON.parse(readFileSync(fileURLToPath(summaryUrl), "utf8")) as RunSummary;
  const events = readFileSync(fileURLToPath(eventsUrl), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RuntimeEventLike);
  return { summary, events };
}

const OPTS = { instanceLabel: "example-agent", cwd: "/repo" } as const;

/** Narrow a step union to its assistant variant for typed assertions. */
function assistantSteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "assistant" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "assistant" }> => step.k === "assistant");
}

function resultSteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "result" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "result" }> => step.k === "result");
}

function boundarySteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "boundary" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "boundary" }> => step.k === "boundary");
}

function runtimeSteps(steps: readonly SessionStep[]): Extract<SessionStep, { k: "runtime" }>[] {
  return steps.filter((step): step is Extract<SessionStep, { k: "runtime" }> => step.k === "runtime");
}

describe("mapRunToSession", () => {
  it("maps a sanitized notified run with a tool call, coercing redacted token usage to 0", () => {
    const { summary, events } = loadFixture("notified");
    const session = mapRunToSession(summary, events, OPTS);

    expect(session.id).toBe("run-public-fixture-001");
    expect(session.instance).toBe("example-agent");
    expect(session.cwd).toBe("/repo");
    expect(session.status).toBe("succeeded");
    // A UUID conversationId (no channel prefix, not a bare slug) -> "other".
    expect(session.source).toBe("other");

    // Last assistant text block is the final answer -> notified.
    expect(session.finalText).toBe("Synthetic fixture completed.");
    expect(session.outcome).toBe("notified");
    expect(session.hasRecall).toBe(false);
    expect(session.instr).toBe("");

    // Redaction caveat: usage token fields are "[redacted]" strings -> coerced to 0.
    // cost_usd is numeric and flows through.
    expect(session.totals.tokIn).toBe(0);
    expect(session.totals.tokOut).toBe(0);
    expect(session.totals.tokCache).toBe(0);
    expect(session.totals.cost).toBeCloseTo(0.01, 6);

    expect(session.totals.asst).toBe(2); // tool-call turn + final-answer turn
    expect(session.totals.tcalls).toBe(1);
    expect(session.totals.think).toBe(0);
    expect(session.totals.steps).toBe(events.length);
    expect(session.toolCounts).toEqual({ command_execution: 1 });

    // No model on this older summary -> provider/api omitted.
    expect(session.model).toBeUndefined();
    expect(session.provider).toBeUndefined();
    expect(session.api).toBeUndefined();

    // The tool-call assistant step carries a digest + full raw args, with the
    // call resolved ok:true once its (non-error) tool_result folds in.
    const callStep = assistantSteps(session.steps).find((step) => step.calls.length > 0);
    expect(callStep).toBeDefined();
    const call = callStep!.calls[0]!;
    expect(call.name).toBe("command_execution");
    expect(call.ok).toBe(true);
    expect(call.raw.startsWith('{"command"')).toBe(true);
    expect(call.dig.length).toBeLessThanOrEqual(DIGEST_CAP);
    expect(call.tr).toBe(true); // command line longer than the digest cap

    const result = resultSteps(session.steps)[0]!;
    expect(result.tool).toBe("command_execution");
    expect(result.ok).toBe(true);
    expect(result.tcid).toBe("call_public_fixture_001");
  });

  it("counts real Write tool events without synthetic file_edit entries", () => {
    const summary: RunSummary = {
      runId: "run-write-tool",
      conversationId: "chat:write",
      status: "succeeded",
      startedAt: "2026-07-09T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 2,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: "notes.txt" } }] },
        timestamp: "2026-07-09T10:00:00.100Z",
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "write-1",
            content: "Successfully wrote notes.txt",
            file_change: {
              status: "completed",
              summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
              changes: [{
                path: "/repo/notes.txt",
                kind: "update",
                line_stats: { before_lines: 4, after_lines: 5, added_lines: 2, removed_lines: 1, changed_lines: 3 },
              }],
            },
          }],
        },
        timestamp: "2026-07-09T10:00:00.200Z",
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.toolCounts).toEqual({ Write: 1 });
    expect(session.toolCounts).not.toHaveProperty("file_edit");
    const calls = assistantSteps(session.steps).flatMap((step) => step.calls);
    expect(calls.map((call) => call.name)).toEqual(["Write"]);
    expect(calls[0]?.fileChange).toEqual({
      status: "completed",
      files: 1,
      addedLines: 2,
      removedLines: 1,
      changedLines: 3,
      unavailableCount: 0,
      changes: [{
        path: "/repo/notes.txt",
        kind: "update",
        lineStats: { beforeLines: 4, afterLines: 5, addedLines: 2, removedLines: 1, changedLines: 3 },
      }],
    });
    expect(resultSteps(session.steps).map((step) => step.tool)).toEqual(["Write"]);
  });

  it("keeps provider-native file changes visible without counting them as tools", () => {
    const summary: RunSummary = {
      runId: "run-file-change",
      conversationId: "chat:file-change",
      status: "succeeded",
      startedAt: "2026-07-09T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 1,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "file_change",
        id: "change-1",
        status: "completed",
        changes: [{ path: "notes.txt", kind: "update" }],
        summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
        is_error: false,
        timestamp: "2026-07-09T10:00:00.100Z",
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.toolCounts).toEqual({});
    expect(session.totals.tcalls).toBe(0);
    expect(runtimeSteps(session.steps)).toContainEqual({
      k: "runtime",
      ts: "2026-07-09T10:00:00.100Z",
      type: "file_change",
      kind: "file_change",
      status: "completed",
      ok: true,
      paths: ["notes.txt"],
      files: 1,
      addedLines: 2,
      removedLines: 1,
      changedLines: 3,
      unavailableCount: 0,
    });
  });

  it("marks provider-native file changes failed when status is failed without an error field", () => {
    const summary: RunSummary = {
      runId: "run-file-change-failed",
      conversationId: "chat:file-change",
      status: "succeeded",
      startedAt: "2026-07-09T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 1,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "file_change",
        id: "change-1",
        status: "failed",
        changes: [{ path: "notes.txt", kind: "update" }],
        summary: { files: 1, unavailable_count: 1 },
        timestamp: "2026-07-09T10:00:00.100Z",
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.toolCounts).toEqual({});
    expect(session.totals.tcalls).toBe(0);
    expect(runtimeSteps(session.steps)).toContainEqual({
      k: "runtime",
      ts: "2026-07-09T10:00:00.100Z",
      type: "file_change",
      kind: "file_change",
      status: "failed",
      ok: false,
      paths: ["notes.txt"],
      files: 1,
      unavailableCount: 1,
    });
  });

  it("splits recalled memory, treats the NOTHING_TO_REPORT sentinel as silent, and marks a failed tool ok:false", () => {
    const { summary, events } = loadFixture("silent-recall");
    const session = mapRunToSession(summary, events, OPTS);

    // Recalled-memory tail split off the trigger prompt.
    expect(session.hasRecall).toBe(true);
    expect(session.instr).toBe("Summarize overnight logs.");
    expect(session.recalled?.startsWith("[Recalled long-term memory")).toBe(true);

    // Sentinel final text -> silent outcome.
    expect(session.finalText).toBe("NOTHING_TO_REPORT");
    expect(session.outcome).toBe("silent");

    // Trigger/source + model-ref parse (sdk:provider:model).
    expect(session.source).toBe("cron");
    expect(session.trigger).toBe("nightly-report");
    expect(session.model).toBe("pi:ollama:gemma4:31b");
    expect(session.api).toBe("pi");
    expect(session.provider).toBe("ollama");
    expect(session.effort).toBe("high");

    // cost prefers cost.cumulativeUsd over usage.cost_usd; tokCache sums read+creation.
    expect(session.totals.cost).toBeCloseTo(0.02, 6);
    expect(session.totals.tokIn).toBe(1200);
    expect(session.totals.tokOut).toBe(300);
    expect(session.totals.tokCache).toBe(150);

    // First step is the trigger prompt.
    expect(session.steps[0]!.k).toBe("prompt");

    // Errored tool_result -> result ok:false AND the linked call backfilled ok:false.
    const result = resultSteps(session.steps)[0]!;
    expect(result.ok).toBe(false);
    expect(result.tcid).toBe("t1");
    // Array-of-text-blocks content is joined into display text.
    expect(result.text).toBe("ENOENT: no such file or directory, open '/var/log/overnight.log'");

    const call = assistantSteps(session.steps).flatMap((step) => step.calls).find((c) => c.id === "t1");
    expect(call?.ok).toBe(false);
  });

  it("tolerates a partial/running run: coalesced thinking, an open (unresolved) tool call, no crash", () => {
    const { summary, events } = loadFixture("running");
    const session = mapRunToSession(summary, events, OPTS);

    expect(session.status).toBe("running");
    expect(session.source).toBe("tui"); // conversationId "tui-local"
    // No final assistant text yet -> provisionally silent.
    expect(session.finalText).toBe("");
    expect(session.outcome).toBe("silent");

    // No usage/cost on a partial summary -> zeros, not NaN.
    expect(session.totals.cost).toBe(0);
    expect(session.totals.tokIn).toBe(0);

    // Two streamed thinking deltas coalesce into one think run.
    expect(session.totals.think).toBe(1);
    expect(session.totals.tcalls).toBe(1);

    const step = assistantSteps(session.steps)[0]!;
    expect(step.think[0]!.t).toBe("Looking at the logs");
    // The tool call never received a result/timing -> ok stays undefined (in-flight).
    expect(step.calls[0]!.id).toBe("r1");
    expect(step.calls[0]!.ok).toBeUndefined();
  });

  it("degrades gracefully with an empty event stream (running summary, no events)", () => {
    const summary: RunSummary = {
      runId: "run-empty",
      conversationId: "telegram:42",
      status: "running",
      durationMs: 0,
      eventCount: 0,
      artifactPaths: [],
    };
    const session = mapRunToSession(summary, [], OPTS);

    expect(session.steps).toEqual([]);
    expect(session.outcome).toBe("silent");
    expect(session.finalText).toBe("");
    expect(session.source).toBe("telegram");
    expect(session.totals).toMatchObject({ asst: 0, tcalls: 0, think: 0, steps: 0, cost: 0 });
    expect(session.title).toBe("run-empty"); // no prompt/final text -> falls back to runId
  });

  it("maps failed-run detail fields from the run summary", () => {
    const summary: RunSummary = {
      runId: "run-failed",
      conversationId: "openai-api:req-123",
      status: "failed",
      failureKind: "provider_unavailable_exhausted",
      error: "All fallback models failed.",
      failoverHistory: [
        {
          model: "pi:openai-codex:gpt-5.5",
          failureKind: "provider_unavailable",
          subkind: "server_error",
          requestId: "req-a",
        },
      ],
      durationMs: 12,
      eventCount: 0,
      artifactPaths: [],
    };

    const session = mapRunToSession(summary, [], OPTS);

    expect(session.status).toBe("failed");
    expect(session.failureKind).toBe("provider_unavailable_exhausted");
    expect(session.error).toBe("All fallback models failed.");
    expect(session.failoverHistory).toEqual(summary.failoverHistory);
  });

  it("derives finalText only from assistant text, not user/commentary text blocks", () => {
    const summary: RunSummary = {
      runId: "run-final-role",
      conversationId: "chat:roles",
      status: "succeeded",
      durationMs: 0,
      eventCount: 3,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      { type: "assistant", message: { content: [{ type: "text", text: "Actual answer." }] } },
      { type: "commentary", message: { content: [{ type: "text", text: "Internal progress update." }] } },
      { type: "user", message: { content: [{ type: "text", text: "User follow-up should not be final." }] } },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.finalText).toBe("Actual answer.");
    expect(session.outcome).toBe("notified");
    expect(assistantSteps(session.steps)).toHaveLength(1);
  });

  it("does not treat commentary-phase assistant text as final output", () => {
    const summary: RunSummary = {
      runId: "run-commentary-phase",
      conversationId: "chat:commentary-phase",
      status: "succeeded",
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", phase: "commentary", text: "I am checking the files now." }],
        },
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.finalText).toBe("");
    expect(session.outcome).toBe("silent");
    expect(assistantSteps(session.steps)).toHaveLength(0);
  });

  it("maps session identity fields and session boundary events", () => {
    const summary: RunSummary = {
      runId: "run-boundary",
      conversationId: "chat:next",
      status: "succeeded",
      startedAt: "2026-07-06T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 2,
      artifactPaths: [],
      providerSessionId: "provider-next",
      isolated: true,
    };
    const events: RuntimeEventLike[] = [
      {
        type: "session_boundary",
        kind: "rollover",
        previousConversationId: "chat:previous",
        conversationId: "chat:next",
        providerSessionId: "provider-next",
        reason: "daily partition changed",
        timestamp: "2026-07-06T10:00:00.500Z",
      },
      { type: "assistant", message: { content: [{ type: "text", text: "Ready in the new session." }] } },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(session.conversationId).toBe("chat:next");
    expect(session.providerSessionId).toBe("provider-next");
    expect(session.isolated).toBe(true);
    expect(boundarySteps(session.steps)).toEqual([
      {
        k: "boundary",
        ts: "2026-07-06T10:00:00.500Z",
        kind: "rollover",
        conversationId: "chat:next",
        previousConversationId: "chat:previous",
        providerSessionId: "provider-next",
        reason: "daily partition changed",
      },
    ]);
    expect(session.finalText).toBe("Ready in the new session.");
  });

  it("maps live runtime telemetry session-boundary shapes without raw telemetry leakage", () => {
    const summary: RunSummary = {
      runId: "run-telemetry-boundary",
      conversationId: "telegram:42#2026-07-06",
      status: "succeeded",
      startedAt: "2026-07-06T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 2,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "runtime_telemetry",
        kind: "session_boundary",
        data: {
          type: "session_boundary",
          kind: "rollover",
          previousConversationId: "telegram:42#2026-07-05",
          conversationId: "telegram:42#2026-07-06",
          reason: "daily_rollover",
        },
        timestamp: "2026-07-06T10:00:00.100Z",
      },
      {
        type: "runtime_telemetry",
        kind: "runtime_event",
        data: { kind: "session_boundary" },
        timestamp: "2026-07-06T10:00:00.200Z",
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(boundarySteps(session.steps)).toEqual([
      {
        k: "boundary",
        ts: "2026-07-06T10:00:00.100Z",
        kind: "rollover",
        conversationId: "telegram:42#2026-07-06",
        previousConversationId: "telegram:42#2026-07-05",
        reason: "daily_rollover",
      },
      {
        k: "boundary",
        ts: "2026-07-06T10:00:00.200Z",
        kind: "session",
      },
    ]);
    expect(runtimeSteps(session.steps)).toEqual([]);
    expect(session.steps).not.toContainEqual(expect.objectContaining({ data: expect.anything() }));
  });

  it("keeps recognized content-less runtime events as compact timeline steps", () => {
    const summary: RunSummary = {
      runId: "run-runtime-events",
      conversationId: "chat:runtime-events",
      status: "succeeded",
      startedAt: "2026-07-06T10:00:00.000Z",
      durationMs: 1000,
      eventCount: 5,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "provider_status",
        kind: "failover_started",
        from: "gpt-5.5",
        to: "kimi",
        attemptIndex: 1,
        timestamp: "2026-07-06T10:00:00.100Z",
      },
      {
        type: "runtime_warning",
        warningKind: "context",
        message: "context compaction imminent",
        timestamp: "2026-07-06T10:00:00.200Z",
      },
      {
        type: "runtime_telemetry",
        kind: "cache_hit",
        data: { tokens: 400, source: "prompt_cache" },
        timestamp: "2026-07-06T10:00:00.300Z",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "AGENTS.md" } }],
        },
        timestamp: "2026-07-06T10:00:00.400Z",
      },
      {
        type: "tool_timing",
        tool_use_id: "tool-1",
        execution_ms: 42,
        is_error: false,
        timestamp: "2026-07-06T10:00:00.500Z",
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);

    expect(runtimeSteps(session.steps)).toEqual([
      {
        k: "runtime",
        ts: "2026-07-06T10:00:00.100Z",
        type: "provider_status",
        kind: "failover_started",
        from: "gpt-5.5",
        to: "kimi",
        attemptIndex: 1,
      },
      {
        k: "runtime",
        ts: "2026-07-06T10:00:00.200Z",
        type: "runtime_warning",
        severity: "warning",
        message: "context compaction imminent",
        kind: "context",
      },
      {
        k: "runtime",
        ts: "2026-07-06T10:00:00.300Z",
        type: "runtime_telemetry",
        kind: "cache_hit",
      },
    ]);
    const call = assistantSteps(session.steps).flatMap((step) => step.calls)[0]!;
    expect(call.durMs).toBe(42);
    expect(call.ok).toBe(true);
    expect(session.steps).not.toContainEqual(expect.objectContaining({ type: "tool_timing" }));
    expect(runtimeSteps(session.steps)).not.toContainEqual(expect.objectContaining({ data: expect.anything() }));
  });

  it("generates unique fallback ids for multiple anonymous tool calls in one event", () => {
    const summary: RunSummary = {
      runId: "run-anonymous-tools",
      conversationId: "chat:anonymous-tools",
      status: "running",
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    };
    const events: RuntimeEventLike[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "first_tool", input: { value: 1 } },
            { type: "tool_use", name: "second_tool", input: { value: 2 } },
          ],
        },
      },
    ];

    const session = mapRunToSession(summary, events, OPTS);
    const calls = assistantSteps(session.steps).flatMap((step) => step.calls);

    expect(calls.map((call) => call.id)).toEqual(["tool-0-0", "tool-0-1"]);
    expect(calls.map((call) => call.name)).toEqual(["first_tool", "second_tool"]);
  });

  it("classifies legacy (unstamped) runs from the conversationId", () => {
    const src = (conversationId: string): string => {
      const summary: RunSummary = {
        runId: "r",
        conversationId,
        status: "succeeded",
        durationMs: 0,
        eventCount: 0,
        artifactPaths: [],
      };
      return mapRunToSession(summary, [], OPTS).source;
    };
    // Bare cron job ids (with and without the daily-rollover "#<date>" suffix).
    expect(src("p2-notifications-check")).toBe("cron");
    expect(src("p2-notifications-check#2026-07-02")).toBe("cron");
    expect(src("gmail-focus-hourly")).toBe("cron");
    // Channel prefixes win (suffix stripped first).
    expect(src("cron:nightly")).toBe("cron");
    expect(src("memory:capture:reconcile")).toBe("memory");
    expect(src("telegram:123#2026-06-24")).toBe("telegram");
    expect(src("openai-api:resp-123")).toBe("openai-api");
    // TUI sessions.
    expect(src("work-agent-tui")).toBe("tui");
    expect(src("tui-local")).toBe("tui");
    // A UUID (chat/webhook without a stamped source) stays "other".
    expect(src("00000000-0000-4000-8000-000000000001")).toBe("other");
  });
});

function baseSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-ctx",
    conversationId: "chat:ctx",
    status: "succeeded",
    durationMs: 0,
    eventCount: 0,
    artifactPaths: [],
    ...overrides,
  };
}

describe("mapRunToSession turn_context + systemPrompt", () => {
  it("maps the LAST turn_context event (last-wins across the resume-replay double-fire)", () => {
    const events: RuntimeEventLike[] = [
      // First fire: warm-resume attempt, history omitted.
      { type: "turn_context", historyCount: 0, historyOmitted: true, timestamp: "2026-07-06T10:00:00.000Z" },
      // Second fire (retry): the history the model was actually driven with.
      {
        type: "turn_context",
        historyCount: 2,
        historyOmitted: false,
        history: [
          { role: "user", content: "q1", timestamp: "2026-06-01T00:00:00Z" },
          { role: "assistant", content: "a1", truncated: true },
        ],
        memory: { content: "recalled", source: "bujo" },
        timestamp: "2026-07-06T10:00:01.000Z",
      },
    ];

    const session = mapRunToSession(baseSummary({ eventCount: 2 }), events, OPTS);

    expect(session.ctx).toEqual({
      histCount: 2,
      hist: [
        { role: "user", text: "q1", ts: "2026-06-01T00:00:00Z" },
        { role: "assistant", text: "a1", tr: true },
      ],
      mem: { text: "recalled", src: "bujo" },
    });
    // historyOmitted:false on the winning event -> histOmitted key absent.
    expect(session.ctx?.histOmitted).toBeUndefined();
    // turn_context has no message.content -> it never becomes a timeline step.
    expect(session.steps).toEqual([]);
  });

  it("carries histOmitted only when the winning event omitted history", () => {
    const events: RuntimeEventLike[] = [
      { type: "turn_context", historyCount: 0, historyOmitted: true, timestamp: "2026-07-06T10:00:00.000Z" },
    ];
    const session = mapRunToSession(baseSummary({ eventCount: 1 }), events, OPTS);
    expect(session.ctx).toEqual({ histCount: 0, histOmitted: true });
  });

  it("never throws on a malformed turn_context payload and drops bad entries", () => {
    const events: RuntimeEventLike[] = [
      {
        type: "turn_context",
        historyCount: "not-a-number",
        historyOmitted: "yes",
        history: [
          "string-entry", // non-record -> dropped
          { role: "user" }, // missing content -> dropped
          { role: 42, content: "x" }, // non-string role -> dropped
          { role: "assistant", content: "kept", name: 7, timestamp: null }, // non-string name/ts omitted
        ],
        memory: { content: 123 }, // non-string content -> mem dropped
        timestamp: "2026-07-06T10:00:00.000Z",
      },
    ];

    let session!: ReturnType<typeof mapRunToSession>;
    expect(() => {
      session = mapRunToSession(baseSummary({ eventCount: 1 }), events, OPTS);
    }).not.toThrow();

    // Only the one well-formed entry survives; historyCount was unparseable so it
    // falls back to the surviving-entry count; "yes" !== true so histOmitted absent.
    expect(session.ctx).toEqual({ histCount: 1, hist: [{ role: "assistant", text: "kept" }] });
    expect(session.ctx?.mem).toBeUndefined();
  });

  it("maps and clamps systemPrompt at the dedicated 32k cap with sysPromptTr", () => {
    const longPrompt = "s".repeat(32_100);
    const session = mapRunToSession(baseSummary({ systemPrompt: longPrompt }), [], OPTS);
    expect(session.sysPrompt).toHaveLength(32_000);
    expect(session.sysPromptTr).toBe(true);
  });

  it("does not clamp a 25k systemPrompt (proves the 32k cap, not the 20k text cap)", () => {
    const prompt = "s".repeat(25_000);
    const session = mapRunToSession(baseSummary({ systemPrompt: prompt }), [], OPTS);
    expect(session.sysPrompt).toHaveLength(25_000);
    expect(session.sysPromptTr).toBeUndefined();
  });

  it("emits recalledTr when the recalled-memory tail is clamped", () => {
    const userInput = `Summarize logs.\n\n[Recalled long-term memory${"x".repeat(25_000)}`;
    const session = mapRunToSession(baseSummary({ userInput }), [], OPTS);
    expect(session.hasRecall).toBe(true);
    expect(session.recalled).toHaveLength(20_000);
    expect(session.recalledTr).toBe(true);
  });

  it("omits ctx/sysPrompt when neither a turn_context event nor a systemPrompt is present", () => {
    const session = mapRunToSession(baseSummary(), [], OPTS);
    expect(session.ctx).toBeUndefined();
    expect(session.sysPrompt).toBeUndefined();
    expect(session.sysPromptTr).toBeUndefined();
  });

  it("does not emit a timeline step for a turn_context event but still maps ctx", () => {
    const events: RuntimeEventLike[] = [
      {
        type: "turn_context",
        historyCount: 1,
        historyOmitted: false,
        history: [{ role: "user", content: "q" }],
        timestamp: "2026-07-06T10:00:00.000Z",
      },
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    ];
    const session = mapRunToSession(baseSummary({ eventCount: 2 }), events, OPTS);
    // Only the assistant step is a timeline step; the turn_context event is not.
    expect(session.steps).toHaveLength(1);
    expect(session.steps[0]!.k).toBe("assistant");
    expect(session.ctx).toEqual({ histCount: 1, hist: [{ role: "user", text: "q" }] });
  });
});

/** Mirrors the digest cap in session-mapping (first line, ~120 chars). */
const DIGEST_CAP = 121; // 120 chars + the ellipsis glyph

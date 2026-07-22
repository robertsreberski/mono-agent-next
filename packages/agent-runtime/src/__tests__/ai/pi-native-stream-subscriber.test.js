import { describe, expect, it } from "vitest";
import { createStreamSubscriber } from "../../ai/providers/pi-native/stream-subscriber.js";

function freshRunState() {
  return {
    assistantTexts: [],
    assistantThinking: [],
    textDeltaIndexes: new Set(),
    thinkingDeltaIndexes: new Set(),
    toolStartTimes: new Map(),
    turnCount: 0,
    toolResultsSeen: 0,
    lastToolName: null,
    maxTurnsHit: false,
  };
}

function harnessDouble() {
  const calls = { aborts: 0 };
  return {
    calls,
    abort: () => { calls.aborts += 1; },
    getModel: () => ({ contextWindow: 128_000 }),
  };
}

function driver(overrides = {}) {
  const runState = freshRunState();
  const emitted = [];
  const harness = harnessDouble();
  const handler = createStreamSubscriber(runState, {
    onEvent: (event) => emitted.push(event),
    options: { cwd: "/repo", maxTurns: overrides.maxTurns },
    toolLimits: {},
    harness,
    sdk: "pi",
    model: "pi:faux:m",
  });
  return { runState, emitted, harness, handler };
}

const msgUpdate = (assistantMessageEvent) => ({ type: "message_update", assistantMessageEvent });

describe("createStreamSubscriber — text/thinking dedup", () => {
  it("streams a text delta and suppresses the matching text_end (same content index)", () => {
    const { runState, emitted, handler } = driver();
    handler(msgUpdate({ type: "text_delta", delta: "hel", contentIndex: 0 }));
    handler(msgUpdate({ type: "text_delta", delta: "lo", contentIndex: 0 }));
    handler(msgUpdate({ type: "text_end", content: "hello", contentIndex: 0 }));

    expect(runState.assistantTexts.join("")).toBe("hello");
    const textEvents = emitted.filter((e) => e.type === "assistant" && e.message.content[0].type === "text");
    // Two deltas emitted; the text_end is deduped because its index streamed.
    expect(textEvents.map((e) => e.message.content[0].text)).toEqual(["hel", "lo"]);
  });

  it("emits a text_end that never streamed as a delta (no matching index)", () => {
    const { runState, emitted, handler } = driver();
    handler(msgUpdate({ type: "text_end", content: "whole", contentIndex: 2 }));
    expect(runState.assistantTexts).toEqual(["whole"]);
    expect(emitted.filter((e) => e.type === "assistant")).toHaveLength(1);
  });

  it("dedups thinking the same way", () => {
    const { runState, emitted, handler } = driver();
    handler(msgUpdate({ type: "thinking_delta", delta: "hm", contentIndex: 0 }));
    handler(msgUpdate({ type: "thinking_end", content: "hm", contentIndex: 0 }));
    handler(msgUpdate({ type: "thinking_end", content: "fresh", contentIndex: 5 }));

    expect(runState.assistantThinking).toEqual(["hm", "fresh"]);
    const thinkingTexts = emitted
      .filter((e) => e.type === "assistant" && e.message.content[0].type === "thinking")
      .map((e) => e.message.content[0].text);
    expect(thinkingTexts).toEqual(["hm", "fresh"]);
  });
});

describe("createStreamSubscriber — exact context snapshots", () => {
  const completedAssistant = (overrides = {}) => ({
    id: "assistant-1",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    usage: {
      input: 120,
      output: 15,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 170,
    },
    ...overrides,
  });

  it("emits the provider-counted request snapshot when each assistant message ends", () => {
    const { emitted, handler } = driver();

    handler({ type: "message_end", message: completedAssistant() });
    handler({
      type: "message_end",
      message: completedAssistant({
        id: "assistant-2",
        usage: { input: 60, output: 8, cacheRead: 10, cacheWrite: 2, totalTokens: 80 },
      }),
    });

    expect(emitted.filter((event) => event.type === "context_usage")).toEqual([
      expect.objectContaining({
        sdk: "pi",
        model: "pi:faux:m",
        measurementId: "assistant-1",
        contextWindow: 128_000,
        tokens: { input: 120, output: 15, cacheRead: 30, cacheCreation: 5, total: 170 },
      }),
      expect.objectContaining({
        measurementId: "assistant-2",
        tokens: { input: 60, output: 8, cacheRead: 10, cacheCreation: 2, total: 80 },
      }),
    ]);
  });

  it.each(["error", "aborted"])("does not report a %s assistant message as exact context", (stopReason) => {
    const { emitted, handler } = driver();

    handler({ type: "message_end", message: completedAssistant({ stopReason }) });

    expect(emitted.some((event) => event.type === "context_usage")).toBe(false);
  });
});

describe("createStreamSubscriber — tool lifecycle + timing", () => {
  it("emits tool_use on start, tool_update on update, tool_timing + tool_result on end", () => {
    const { runState, emitted, handler } = driver();
    handler({ type: "tool_execution_start", toolName: "my_tool", toolCallId: "call-1", args: { a: 1 } });
    handler({ type: "tool_execution_update", toolName: "my_tool", toolCallId: "call-1", args: { a: 1 }, partialResult: "partial" });
    handler({ type: "tool_execution_end", toolName: "my_tool", toolCallId: "call-1", result: "final", isError: false });

    expect(runState.lastToolName).toBe("my_tool");
    expect(runState.toolResultsSeen).toBe(1);
    expect(emitted.some((e) => e.type === "assistant" && e.message.content[0].type === "thinking")).toBe(false);
    expect(emitted.some((e) => e.type === "assistant" && e.message.content[0].type === "tool_use" && e.message.content[0].id === "call-1")).toBe(true);
    expect(emitted.some((e) => e.type === "tool_update" && e.tool_use_id === "call-1")).toBe(true);
    const timing = emitted.find((e) => e.type === "tool_timing");
    expect(timing).toMatchObject({ tool_use_id: "call-1", name: "my_tool", is_error: false });
    expect(typeof timing.execution_ms).toBe("number");
    const result = emitted.find((e) => e.type === "user");
    expect(result.message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call-1", is_error: false });
    // toolStartTimes cleaned up after the timing event.
    expect(runState.toolStartTimes.has("call-1")).toBe(false);
  });

  it("does not count an errored tool result and marks the timing/result is_error", () => {
    const { runState, emitted, handler } = driver();
    handler({ type: "tool_execution_start", toolName: "t", toolCallId: "c", args: {} });
    handler({ type: "tool_execution_end", toolName: "t", toolCallId: "c", result: "boom", isError: true });
    expect(runState.toolResultsSeen).toBe(0);
    expect(emitted.find((e) => e.type === "tool_timing").is_error).toBe(true);
    expect(emitted.find((e) => e.type === "user").message.content[0].is_error).toBe(true);
  });

  it("copies structured file-change details onto the normalized tool_result block", () => {
    const { emitted, handler } = driver();
    const fileChange = {
      status: "completed",
      summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
      changes: [{ path: "/repo/notes.txt", kind: "update" }],
    };
    handler({ type: "tool_execution_start", toolName: "Write", toolCallId: "write-1", args: {} });
    handler({
      type: "tool_execution_end",
      toolName: "Write",
      toolCallId: "write-1",
      result: { content: [{ type: "text", text: "Successfully wrote notes.txt" }], details: { file_change: fileChange } },
      isError: false,
    });

    const result = emitted.find((e) => e.type === "user");
    expect(result.message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "write-1",
      file_change: fileChange,
      is_error: false,
    });
  });

  it("emits no tool_timing when the end has no recorded start", () => {
    const { emitted, handler } = driver();
    handler({ type: "tool_execution_end", toolName: "t", toolCallId: "unseen", result: "x", isError: false });
    expect(emitted.some((e) => e.type === "tool_timing")).toBe(false);
  });
});

describe("createStreamSubscriber — turn counting + maxTurns stop", () => {
  it("increments turnCount on turn_end", () => {
    const { runState, handler } = driver();
    handler({ type: "turn_end", message: { stopReason: "endTurn" } });
    handler({ type: "turn_end", message: { stopReason: "endTurn" } });
    expect(runState.turnCount).toBe(2);
  });

  it("aborts and flags maxTurnsHit when the crossing turn ended to run more tools", () => {
    const { runState, harness, handler } = driver({ maxTurns: 1 });
    handler({ type: "turn_end", message: { stopReason: "toolUse" } });
    expect(runState.maxTurnsHit).toBe(true);
    expect(harness.calls.aborts).toBe(1);
  });

  it("does not stop when the crossing turn ended for a non-tool reason", () => {
    const { runState, harness, handler } = driver({ maxTurns: 1 });
    handler({ type: "turn_end", message: { stopReason: "endTurn" } });
    expect(runState.maxTurnsHit).toBe(false);
    expect(harness.calls.aborts).toBe(0);
  });

  it("does not stop before the ceiling is crossed", () => {
    const { runState, harness, handler } = driver({ maxTurns: 3 });
    handler({ type: "turn_end", message: { stopReason: "toolUse" } });
    expect(runState.maxTurnsHit).toBe(false);
    expect(harness.calls.aborts).toBe(0);
  });
});

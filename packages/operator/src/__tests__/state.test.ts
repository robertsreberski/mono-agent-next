import { describe, expect, it } from "vitest";

import {
  OperatorStateError,
  availableOperatorActions,
  initialOperatorState,
  reduceOperatorFrame,
  reduceOperatorFrames,
} from "../index.js";
import { ASK_USER_TURN_FRAMES, FIXTURE_CAPABILITIES, VALID_TURN_FRAMES, reduceFixture } from "../testing.js";

describe("operator domain state", () => {
  it("reduces a fixture deterministically without mutating its input", () => {
    const first = reduceFixture();
    const second = reduceFixture();
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "completed",
      assistantText: "Hello fixture",
      thoughtText: "",
      activities: [
        { type: "activity", text: "Calling a fixture tool" },
        { type: "tool_call", call: { id: "fixture-tool-call", name: "fixture_tool" } },
        { type: "tool_result", result: { callId: "fixture-tool-call" } },
        { type: "compaction", compaction: { compacted: true } },
      ],
      usage: { inputTokens: 12, outputTokens: 3, compacted: true },
    });
    expect(VALID_TURN_FRAMES).toHaveLength(12);
    const streaming = reduceOperatorFrames(
      initialOperatorState("fixture-conversation"),
      VALID_TURN_FRAMES.slice(0, 5),
    );
    expect(streaming.thoughtText).toBe("Checking the fixture.");
  });

  it("derives renderer actions from shared state and capabilities", () => {
    const idle = initialOperatorState("fixture-conversation");
    expect(availableOperatorActions(idle, FIXTURE_CAPABILITIES)).toEqual([
      "start_turn", "attach", "quote", "set_runtime", "set_model", "set_effort", "view_config", "view_replay", "view_health",
    ]);
    const awaiting = reduceOperatorFrames(idle, ASK_USER_TURN_FRAMES.slice(0, 2));
    expect(availableOperatorActions(awaiting, FIXTURE_CAPABILITIES)).toEqual([
      "cancel_turn", "offer_live_input", "answer_ask", "view_config", "view_replay", "view_health",
    ]);
  });

  it("rejects cross-conversation and cross-turn frames", () => {
    expect(() => reduceOperatorFrame(initialOperatorState("a"), {
      type: "accepted",
      turnId: "turn",
      conversationId: "b",
      startedAt: "2026-01-02T03:04:05.000Z",
    })).toThrow(OperatorStateError);
    const active = reduceOperatorFrame(initialOperatorState("a"), {
      type: "accepted",
      turnId: "turn-a",
      conversationId: "a",
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(() => reduceOperatorFrame(active, { type: "activity", turnId: "turn-b", text: "wrong" })).toThrow("expected turn-a");
    expect(() => reduceOperatorFrame(active, {
      type: "tool_call",
      turnId: "turn-b",
      call: { id: "call", name: "tool", input: {}, inputOmitted: false },
    })).toThrow("expected turn-a");
  });

  it("keeps compaction and session eviction sticky across later usage snapshots", () => {
    const accepted = reduceOperatorFrame(initialOperatorState("a"), {
      type: "accepted",
      turnId: "turn-a",
      conversationId: "a",
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    const compacted = reduceOperatorFrame(accepted, {
      type: "usage",
      turnId: "turn-a",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        contextWindow: 128_000,
        contextUsed: 15,
        compacted: true,
        sessionEvicted: false,
      },
    });
    const compactionEvent = reduceOperatorFrame(compacted, {
      type: "compaction",
      turnId: "turn-a",
      compaction: {
        compacted: true,
        tokensBefore: 15,
        tokensAfter: 8,
      },
    });
    expect(compactionEvent.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      contextWindow: 128_000,
      compacted: true,
      sessionEvicted: false,
    });
    const evicted = reduceOperatorFrame(compactionEvent, {
      type: "usage",
      turnId: "turn-a",
      usage: {
        inputTokens: 14,
        outputTokens: 4,
        compacted: false,
        sessionEvicted: true,
      },
    });
    const latest = reduceOperatorFrame(evicted, {
      type: "usage",
      turnId: "turn-a",
      usage: {
        inputTokens: 16,
        outputTokens: 5,
        contextUsed: 18,
        compacted: false,
        sessionEvicted: false,
      },
    });
    expect(latest.usage).toEqual({
      inputTokens: 16,
      outputTokens: 5,
      contextWindow: 128_000,
      contextUsed: 18,
      compacted: true,
      sessionEvicted: true,
    });
  });
});

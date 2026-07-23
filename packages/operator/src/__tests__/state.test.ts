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
      thoughtText: "Checking the fixture.",
      activities: ["Calling a fixture tool"],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(VALID_TURN_FRAMES).toHaveLength(9);
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
    const evicted = reduceOperatorFrame(compacted, {
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

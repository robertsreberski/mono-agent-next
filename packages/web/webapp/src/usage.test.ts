import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import type { MessagePart, RunStatus, ThreadDetail, WebMessage } from "./types";
import { conversationConsoleUsage } from "./usage";

const message = (
  id: string,
  parts: readonly MessagePart[],
  status: WebMessage["status"] = "complete",
): WebMessage => ({
  id,
  threadId: "thread",
  role: "assistant",
  parts,
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status,
});

const detail = (
  messages: readonly WebMessage[],
  runStatus: RunStatus = "complete",
): ThreadDetail => ({
  thread: thread("thread", "agent", { runState: { status: runStatus } }),
  messages,
});

const contextPart = (
  total: number,
  options: { readonly model?: string; readonly timestamp?: number; readonly contextWindow?: number } = {},
): MessagePart => ({
  type: "telemetry",
  event: "runtime_telemetry",
  data: {
    type: "runtime_telemetry",
    kind: "context_usage",
    data: {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      tokens: { total },
    },
  },
});

const compactionPart = (
  status: "running" | "succeeded" | "skipped" | "failed",
  timestamp: number,
): MessagePart => ({
  type: "telemetry",
  event: "runtime_telemetry",
  data: {
    type: "runtime_telemetry",
    kind: "context_compaction",
    data: { operationId: "compact-1", status, timestamp },
  },
});

describe("conversationConsoleUsage", () => {
  it("returns null only while no conversation detail is selected", () => {
    expect(conversationConsoleUsage(null)).toBeNull();
    expect(conversationConsoleUsage(detail([message("one", [
      { type: "telemetry", event: "provider_status", data: { kind: "request_completed" } },
    ])]))).toEqual({
      context: {
        status: "unavailable",
        reason: "Exact context usage has not been reported for this conversation.",
      },
    });
  });

  it("keeps exact current context separate from aggregate last-turn work", () => {
    expect(conversationConsoleUsage(detail([message("one", [
      {
        type: "telemetry",
        event: "usage_update",
        data: {
          model: "pi:openai-codex:gpt-5.5",
          cumulativeUsd: 0.0123,
          tokens: { input: 1200, output: 345, cacheRead: 800, cacheCreation: 12, reasoning: 90 },
        },
      },
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          kind: "context_usage",
          data: {
            model: "pi:openai-codex:gpt-5.5",
            contextWindow: 372_000,
            tokens: { input: 100, output: 20, cacheRead: 900, cacheCreation: 5, total: 1_025 },
          },
        },
      },
    ])]), { selectedModel: "pi:openai-codex:gpt-5.5" })).toEqual({
      context: {
        status: "current",
        usage: {
          input: 100,
          cachedInput: 900,
          cacheCreation: 5,
          output: 20,
          total: 1_025,
          contextWindow: 372_000,
          model: "pi:openai-codex:gpt-5.5",
        },
        measuredModel: "pi:openai-codex:gpt-5.5",
      },
      processed: {
        input: 1200,
        cachedInput: 800,
        cacheCreation: 12,
        output: 345,
        reasoning: 90,
        model: "pi:openai-codex:gpt-5.5",
      },
      cost: 0.0123,
    });
  });

  it("lets a post-compaction provider snapshot become current and decrease", () => {
    expect(conversationConsoleUsage(detail([
      message("first", [contextPart(90_000, { timestamp: 100, contextWindow: 100_000 })]),
      message("second", [
        compactionPart("succeeded", 200),
        contextPart(20_000, { timestamp: 300, contextWindow: 100_000 }),
      ]),
    ]))).toEqual({
      context: {
        status: "current",
        usage: { total: 20_000, contextWindow: 100_000 },
      },
    });
  });

  it("suppresses a pre-compaction number until a newer exact measurement arrives", () => {
    expect(conversationConsoleUsage(detail([
      message("first", [contextPart(90_000, { timestamp: 100, contextWindow: 100_000 })]),
      // The store updates the compaction row in its original position. Its
      // terminal timestamp must still invalidate a snapshot appended while the
      // operation was running, even though that snapshot follows it in parts.
      message("second", [
        compactionPart("succeeded", 200),
        contextPart(70_000, { timestamp: 150, contextWindow: 100_000 }),
      ]),
    ]))).toEqual({
      context: {
        status: "awaiting_measurement",
        reason: "Context changed during compaction; waiting for the next exact provider measurement.",
      },
    });
  });

  it("keeps the prior exact measurement when compaction is skipped or fails", () => {
    for (const status of ["skipped", "failed"] as const) {
      expect(conversationConsoleUsage(detail([
        message("first", [contextPart(90_000, { timestamp: 100 })]),
        message("second", [compactionPart(status, 200)]),
      ]))?.context).toEqual({ status: "current", usage: { total: 90_000 } });
    }
  });

  it("labels a running turn's latest exact snapshot as updating", () => {
    expect(conversationConsoleUsage(detail([
      message("running", [contextPart(42_000, { model: "pi:p:m", timestamp: 100 })], "running"),
    ], "running"), { selectedModel: "pi:p:m" })?.context).toEqual({
      status: "updating",
      usage: { total: 42_000, model: "pi:p:m" },
      measuredModel: "pi:p:m",
      reason: "The provider measurement is exact, but the current turn is still updating context.",
    });
  });

  it("shows updating without inventing a number before the first running-turn snapshot", () => {
    expect(conversationConsoleUsage(detail([
      message("running", [{ type: "reasoning", text: "Working" }], "running"),
    ], "running"))?.context).toEqual({
      status: "updating",
      reason: "The current turn has not reported an exact provider measurement yet.",
    });
  });

  it("ignores a failed turn's snapshots and falls back to the last committed measurement", () => {
    expect(conversationConsoleUsage(detail([
      message("complete", [contextPart(30_000, { model: "pi:p:m", timestamp: 100 })]),
      message("failed", [contextPart(99_000, { model: "pi:p:m", timestamp: 200 })], "failed"),
    ], "failed"), { selectedModel: "pi:p:m" })?.context).toEqual({
      status: "last_measured",
      usage: { total: 30_000, model: "pi:p:m" },
      measuredModel: "pi:p:m",
      reason: "The latest turn did not complete, so this is the last successful provider measurement.",
    });
  });

  it("labels an exact snapshot for a different next model as last measured", () => {
    expect(conversationConsoleUsage(detail([
      message("complete", [contextPart(30_000, { model: "pi:p:old", timestamp: 100 })]),
    ]), { selectedModel: "pi:p:new" })?.context).toEqual({
      status: "last_measured",
      usage: { total: 30_000, model: "pi:p:old" },
      measuredModel: "pi:p:old",
      reason: "This measurement belongs to pi:p:old; the next turn is set to pi:p:new.",
    });
  });

  it("states explicitly when direct Claude cannot provide a measurement", () => {
    expect(conversationConsoleUsage(detail([]), { selectedModel: "claude:sonnet" })?.context).toEqual({
      status: "unavailable",
      reason: "This Claude runtime does not expose exact context measurements.",
    });
  });

  it("shows only the latest turn's processed tokens while summing per-turn cost", () => {
    expect(conversationConsoleUsage(detail([
      message("first", [{
        type: "telemetry",
        event: "usage_update",
        data: { cumulativeUsd: 0.25, tokens: { input: 50, output: 8 } },
      }]),
      message("second", [
        { type: "telemetry", event: "usage_update", data: { cumulativeUsd: 0.5, tokens: { input: 100 } } },
        { type: "telemetry", event: "usage_update", data: { cumulativeUsd: 0.75, tokens: { input: 200, output: 12 } } },
      ]),
    ]))).toEqual({
      context: {
        status: "unavailable",
        reason: "Exact context usage has not been reported for this conversation.",
      },
      processed: { input: 200, output: 12 },
      cost: 1,
    });
  });

  it("keeps legacy aggregate telemetry useful without claiming context occupancy", () => {
    expect(conversationConsoleUsage(detail([message("legacy", [{
      type: "telemetry",
      event: "usage_update",
      data: {
        model: "provider/model",
        cumulativeUsd: 5.104078,
        tokens: { input: 429_128, output: 15_773, cacheRead: 4_970_496 },
      },
    }])]))).toEqual({
      context: {
        status: "unavailable",
        reason: "Exact context usage has not been reported for this conversation.",
      },
      processed: {
        input: 429_128,
        cachedInput: 4_970_496,
        output: 15_773,
        model: "provider/model",
      },
      cost: 5.104078,
    });
  });

  it("reads snake-case fields and ignores invalid values without inventing totals", () => {
    expect(conversationConsoleUsage(detail([message("one", [{
      type: "telemetry",
      event: "runtime_telemetry",
      data: {
        kind: "token_usage",
        model_id: "fallback/model",
        data: {
          cost_usd: 0.2,
          tokens: {
            input_tokens: 100,
            cached_input_tokens: 80,
            cache_creation_tokens: 4,
            output_tokens: Number.POSITIVE_INFINITY,
            reasoning_tokens: 9,
          },
        },
      },
    }])]))).toEqual({
      context: {
        status: "unavailable",
        reason: "Exact context usage has not been reported for this conversation.",
      },
      processed: { input: 100, cachedInput: 80, cacheCreation: 4, reasoning: 9, model: "fallback/model" },
      cost: 0.2,
    });
  });
});

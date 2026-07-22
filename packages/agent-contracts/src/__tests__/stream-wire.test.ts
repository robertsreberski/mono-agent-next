import { describe, expect, it } from "vitest";

import type { AgentMessageStream, AgentStreamEvent, AgentStreamWireFrame } from "../index.js";
import {
  frameFeedingMessageStream,
  isCodedError,
  parseAgentStreamFrame,
  serializeAgentStreamFrame,
} from "../index.js";

const EVENT_FIXTURES: AgentStreamEvent[] = [
  { type: "assistant_thought", text: "pondering" },
  { type: "tool_call_started", id: "t1", name: "read_file", arguments: { path: "/tmp/x" } },
  { type: "tool_call_progress", id: "t1", name: "read_file", partialResult: "line 1\n" },
  {
    type: "tool_call_completed",
    id: "t1",
    name: "read_file",
    content: "done",
    isError: false,
    executionMs: 42,
  },
  {
    type: "usage_update",
    model: "claude-fable-5",
    cumulativeUsd: 0.0123,
    tokens: { input: 100, output: 20, cacheRead: 400, cacheCreation: 0 },
  },
  { type: "provider_status", kind: "failover_started", from: "gpt-5.5", to: "kimi", attemptIndex: 1 },
  { type: "memory_recalled", source: "bujo", bytes: 2048 },
  { type: "runtime_telemetry", kind: "cache_hit", data: { tokens: 400, source: "provider" } },
  { type: "runtime_warning", message: "compaction imminent", warningKind: "compaction" },
];

describe("serialize/parse round-trip", () => {
  it("round-trips every frame kind, including every AgentStreamEvent variant", () => {
    const frames: AgentStreamWireFrame[] = [
      { kind: "status", text: "Thinking…" },
      { kind: "append", delta: "Hel" },
      { kind: "replace", text: "Hello" },
      ...EVENT_FIXTURES.map((event): AgentStreamWireFrame => ({ kind: "event", event })),
      { kind: "finish", finalText: "Hello!", metadata: { runId: "r1" } },
      { kind: "error", message: "boom", code: "run_failed", cancelled: false },
    ];
    for (const frame of frames) {
      const line = serializeAgentStreamFrame(frame);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1).includes("\n")).toBe(false);
      expect(parseAgentStreamFrame(line.trimEnd())).toEqual(frame);
    }
  });

  it("passes unknown frame kinds through for forward compatibility", () => {
    const frame = parseAgentStreamFrame('{"kind":"heartbeat","at":123}');
    expect(frame.kind).toBe("heartbeat");
  });

  it("passes unknown event types through for forward compatibility", () => {
    const frame = parseAgentStreamFrame('{"kind":"event","event":{"type":"quantum_flux","level":9}}');
    expect(frame.kind).toBe("event");
    expect((frame as { event: { type: string } }).event.type).toBe("quantum_flux");
  });

  it.each([
    ["not json", "{nope"],
    ["missing kind", '{"text":"x"}'],
    ["empty kind", '{"kind":""}'],
    ["status without text", '{"kind":"status"}'],
    ["append without delta", '{"kind":"append"}'],
    ["replace without text", '{"kind":"replace","delta":"x"}'],
    ["event without event", '{"kind":"event"}'],
    ["event without type", '{"kind":"event","event":{}}'],
    ["error without message", '{"kind":"error"}'],
  ])("rejects malformed line (%s) with a coded invalid_frame error", (_label, line) => {
    try {
      parseAgentStreamFrame(line);
      expect.unreachable("expected parseAgentStreamFrame to throw");
    } catch (error) {
      expect(isCodedError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("invalid_frame");
    }
  });
});

describe("frameFeedingMessageStream", () => {
  function recordingStream(): { stream: AgentMessageStream; calls: Array<[string, unknown]> } {
    const calls: Array<[string, unknown]> = [];
    return {
      calls,
      stream: {
        status: async (text) => void calls.push(["status", text]),
        append: async (delta) => void calls.push(["append", delta]),
        replace: async (text) => void calls.push(["replace", text]),
        event: async (event) => void calls.push(["event", event]),
      },
    };
  }

  it("replays status/append/replace/event onto the local stream in order", async () => {
    const { stream, calls } = recordingStream();
    const feed = frameFeedingMessageStream(stream);

    await feed({ kind: "status", text: "working" });
    await feed({ kind: "append", delta: "a" });
    await feed({ kind: "replace", text: "ab" });
    await feed({ kind: "event", event: { type: "assistant_thought", text: "hmm" } });

    expect(calls).toEqual([
      ["status", "working"],
      ["append", "a"],
      ["replace", "ab"],
      ["event", { type: "assistant_thought", text: "hmm" }],
    ]);
  });

  it("does not dispatch terminal finish/error frames and ignores unknown kinds", async () => {
    const { stream, calls } = recordingStream();
    const feed = frameFeedingMessageStream(stream);

    await feed({ kind: "finish", finalText: "done" });
    await feed({ kind: "error", message: "boom" });
    await feed(parseAgentStreamFrame('{"kind":"heartbeat"}'));

    expect(calls).toEqual([]);
  });

  it("tolerates streams that omit optional callbacks", async () => {
    const appended: string[] = [];
    const feed = frameFeedingMessageStream({ append: async (delta) => void appended.push(delta) });

    await feed({ kind: "status", text: "s" });
    await feed({ kind: "replace", text: "r" });
    await feed({ kind: "event", event: { type: "runtime_warning", message: "w" } });
    await feed({ kind: "append", delta: "only this lands" });

    expect(appended).toEqual(["only this lands"]);
  });
});

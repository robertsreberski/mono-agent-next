import { describe, expect, it } from "vitest";

import {
  combineRecordedRunEvents,
  type RecordedRunEvent,
} from "../index.js";

function event(input: {
  readonly index: number;
  readonly category: RecordedRunEvent["category"];
  readonly label: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly type?: string;
  readonly timestamp?: string;
}): RecordedRunEvent {
  return {
    index: input.index,
    category: input.category,
    label: input.label,
    summary: input.summary,
    payload: input.payload,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
  };
}

describe("combineRecordedRunEvents", () => {
  it("groups adjacent assistant thinking and visible text chunks with source metadata", () => {
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: "I should",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "I should" }] } },
      }),
      event({
        index: 1,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: " inspect",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: " inspect" }] } },
      }),
      event({
        index: 2,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: " files.",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: " files." }] } },
      }),
      event({
        index: 3,
        type: "tool.call",
        category: "tool",
        label: "Tool: Read",
        summary: "Read - started",
        payload: { type: "tool.call", toolName: "Read", status: "started" },
      }),
      event({
        index: 4,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "Visible",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "Visible" }] } },
      }),
      event({
        index: 5,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: " response",
        payload: { type: "assistant", message: { content: [{ type: "text", text: " response" }] } },
      }),
    ];

    const timeline = combineRecordedRunEvents(events);

    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      index: 0,
      category: "thinking",
      label: "Assistant thoughts",
      summary: "I should inspect files.",
      sourceEventCount: 3,
      sourceEventStartIndex: 0,
      sourceEventEndIndex: 2,
    });
    expect(timeline[1]).toMatchObject({
      index: 3,
      category: "tool",
      sourceEventCount: 1,
      sourceEventStartIndex: 3,
      sourceEventEndIndex: 3,
    });
    expect(timeline[2]).toMatchObject({
      index: 4,
      category: "message",
      label: "Assistant message",
      summary: "Visible response",
      sourceEventCount: 2,
      sourceEventStartIndex: 4,
      sourceEventEndIndex: 5,
    });
  });

  it("does not group across kind changes or mixed assistant payloads", () => {
    const mixedPayload = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "consider" }, { type: "text", text: "answer" }] },
    };
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: "first",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "first" }] } },
      }),
      event({
        index: 1,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "visible",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "visible" }] } },
      }),
      event({
        index: 2,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "mixed",
        payload: mixedPayload,
      }),
      event({
        index: 3,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "again",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "again" }] } },
      }),
    ];

    const timeline = combineRecordedRunEvents(events);

    expect(timeline).toHaveLength(4);
    expect(timeline.map((item) => item.sourceEventCount)).toEqual([1, 1, 1, 1]);
    expect(timeline[2]?.payload).toBe(mixedPayload);
  });

  it("does not merge tool_use/tool_result events into adjacent thinking/text groups", () => {
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: "considering",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "considering" }] } },
      }),
      event({
        index: 1,
        type: "assistant",
        category: "tool",
        label: "Tool: Read",
        summary: '{"path":"/etc/hosts"}',
        payload: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/etc/hosts" } }] },
        },
      }),
      event({
        index: 2,
        type: "user",
        category: "tool",
        label: "Tool result",
        summary: "file contents",
        payload: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] },
        },
      }),
      event({
        index: 3,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "done",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      }),
    ];

    const timeline = combineRecordedRunEvents(events);

    expect(timeline).toHaveLength(4);
    expect(timeline.map((item) => item.category)).toEqual(["thinking", "tool", "tool", "message"]);
    expect(timeline.map((item) => item.sourceEventCount)).toEqual([1, 1, 1, 1]);
  });

  it("bounds combined summaries and synthesized payload previews", () => {
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "a".repeat(180),
        payload: { type: "assistant", message: { content: [{ type: "text", text: "a".repeat(180) }] } },
      }),
      event({
        index: 1,
        type: "assistant",
        category: "message",
        label: "assistant",
        summary: "b".repeat(180),
        payload: { type: "assistant", message: { content: [{ type: "text", text: "b".repeat(180) }] } },
      }),
    ];

    const [combined] = combineRecordedRunEvents(events);

    expect(combined?.summary).toHaveLength(221);
    expect(combined?.summary.endsWith("…")).toBe(true);
    expect(combined?.payload).toMatchObject({
      type: "assistant.timeline.combined",
      contentKind: "text",
      sourceEventCount: 2,
      sourceEventStartIndex: 0,
      sourceEventEndIndex: 1,
    });
    expect(JSON.stringify(combined?.payload)).not.toContain("rawEvents");
  });

  it("captures contentChars (pre-compaction joined text length) and endTimestamp for a coalesced thinking group", () => {
    const chunkTexts = ["I should", " inspect", " files."];
    const events: readonly RecordedRunEvent[] = chunkTexts.map((text, index) =>
      event({
        index,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: text,
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } },
        timestamp: `2026-07-01T00:00:0${index}.000Z`,
      }),
    );

    const [combined] = combineRecordedRunEvents(events);

    expect(combined?.contentChars).toBe(chunkTexts.join("").length);
    expect(combined?.timestamp).toBe("2026-07-01T00:00:00.000Z");
    expect(combined?.endTimestamp).toBe("2026-07-01T00:00:02.000Z");
  });

  it("leaves contentChars/endTimestamp computed but timestamp-free when source events carry no timestamps", () => {
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: "a",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "a" }] } },
      }),
      event({
        index: 1,
        type: "assistant",
        category: "thinking",
        label: "assistant",
        summary: "b",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "b" }] } },
      }),
    ];

    const [combined] = combineRecordedRunEvents(events);

    expect(combined?.contentChars).toBe(2);
    expect(combined?.timestamp).toBeUndefined();
    expect(combined?.endTimestamp).toBeUndefined();
  });

  it("leaves contentChars undefined for single-event items but reuses their own timestamp as endTimestamp", () => {
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "tool.call",
        category: "tool",
        label: "Tool: Read",
        summary: "Read - started",
        payload: { type: "tool.call", toolName: "Read", status: "started" },
        timestamp: "2026-07-01T00:00:00.000Z",
      }),
    ];

    const [item] = combineRecordedRunEvents(events);

    expect(item?.contentChars).toBeUndefined();
    expect(item?.endTimestamp).toBe("2026-07-01T00:00:00.000Z");
  });

  it("leaves endTimestamp undefined for a single-event item with no source timestamp", () => {
    const events: readonly RecordedRunEvent[] = [
      event({
        index: 0,
        type: "tool.call",
        category: "tool",
        label: "Tool: Read",
        summary: "Read - started",
        payload: { type: "tool.call", toolName: "Read", status: "started" },
      }),
    ];

    const [item] = combineRecordedRunEvents(events);

    expect(item?.endTimestamp).toBeUndefined();
  });
});

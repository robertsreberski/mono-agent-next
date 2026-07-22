import { describe, expect, it } from "vitest";

import {
  assistantMessageContentKind,
  buildEventDescriptors,
  classifyRecordedRunEvent,
  countToolResultBlocks,
  eventLabel,
  eventSummary,
  textFromMessage,
} from "../event-classify.js";

describe("event-classify exported helpers", () => {
  it("classifies categories", () => {
    expect(classifyRecordedRunEvent({ type: "tool.call", toolName: "Read" })).toBe("tool");
    expect(classifyRecordedRunEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBe("message");
    expect(classifyRecordedRunEvent({ type: "error", error: "boom" })).toBe("error");
    // Real harness runtime_warning events carry a `message` string (harness.ts);
    // they must classify as "runtime", not be swept into "message" by the
    // generic message-field heuristic.
    expect(
      classifyRecordedRunEvent({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
        message: "Memory recall failed; continuing without memory.",
      }),
    ).toBe("runtime");
  });

  it("derives labels from a parsed record", () => {
    expect(eventLabel({ toolName: "Read" }, "tool", "tool.call")).toBe("Tool: Read");
    expect(eventLabel({ role: "assistant" }, "message", "assistant")).toBe("Message: assistant");
  });

  it("derives summaries from a parsed record", () => {
    expect(eventSummary({ summary: "hello" }, "runtime", { summary: "hello" }, 4096)).toBe("hello");
  });

  it("classifies provider-native file changes by their own status", () => {
    expect(buildEventDescriptors({ type: "file_change", status: "completed" })).toMatchObject({
      category: "runtime",
      label: "file change",
    });
    expect(buildEventDescriptors({ type: "File_Change", status: "failed" })).toMatchObject({
      category: "error",
      label: "file change failed",
    });
    expect(buildEventDescriptors({ type: "fileChange", status: "completed" })).toMatchObject({
      category: "runtime",
      label: "file change",
    });
  });

  it("extracts message text and assistant content kind", () => {
    expect(textFromMessage({ content: [{ type: "text", text: "answer" }] })).toBe("answer");
    expect(assistantMessageContentKind({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } })).toBe("thinking");
  });
});

describe("countToolResultBlocks", () => {
  it("counts multiple tool_result blocks on a single user event", () => {
    expect(
      countToolResultBlocks({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "a", content: "1" },
            { type: "tool_result", tool_use_id: "b", content: "2" },
          ],
        },
      }),
    ).toBe(2);
  });

  it("counts exactly one tool_result block", () => {
    expect(
      countToolResultBlocks({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "a", content: "1" }] },
      }),
    ).toBe(1);
  });

  it("returns 0 when a user event's content array has no tool_result block", () => {
    expect(countToolResultBlocks({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })).toBe(0);
  });

  it("falls back to 1 when content isn't an array", () => {
    expect(countToolResultBlocks({ type: "user", message: { content: "not-an-array" } })).toBe(1);
  });

  it("falls back to 1 when type isn't \"user\"", () => {
    expect(countToolResultBlocks({ type: "assistant", message: { content: [] } })).toBe(1);
  });
});

describe("nested tool blocks classify as category \"tool\"", () => {
  it("classifies an assistant tool_use block as tool, labelled Tool: <name>, summarized from input", () => {
    const descriptors = buildEventDescriptors({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/etc/hosts" } }],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool: Read");
    expect(descriptors.summary).toBe('{"path":"/etc/hosts"}');
  });

  it("labels an assistant tool_use block with no `name` field as the bare 'Tool call' fallback", () => {
    const descriptors = buildEventDescriptors({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", input: { path: "/etc/hosts" } }],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool call");
  });

  it("labels a tool_result block that itself carries a `name` field as 'Tool result: <name>'", () => {
    const descriptors = buildEventDescriptors({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", name: "Read", content: "file contents here" }],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool result: Read");
  });

  it("classifies a user tool_result block as tool, labelled Tool result, summarized from content", () => {
    const descriptors = buildEventDescriptors({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" }],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool result");
    expect(descriptors.summary).toBe("file contents here");
  });

  it("prefixes an errored tool_result summary with 'error: ' while the category stays tool", () => {
    const descriptors = buildEventDescriptors({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true }],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool result");
    expect(descriptors.summary).toBe("error: boom");
  });

  it("classifies mixed text+tool_use assistant content as tool (the tool call is salient)", () => {
    const descriptors = buildEventDescriptors({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", id: "toolu_2", name: "Grep", input: { pattern: "foo" } },
        ],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool: Grep");
  });

  it("regression: a plain thinking block is still classified as thinking", () => {
    expect(
      classifyRecordedRunEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "hmm" }] },
      }),
    ).toBe("thinking");
  });

  it("regression: a plain assistant text message (no nested tool blocks) is still classified as message", () => {
    expect(
      classifyRecordedRunEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ).toBe("message");
  });

  it("regression: a plain user text message (no nested tool blocks) is still classified as message", () => {
    expect(
      classifyRecordedRunEvent({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
    ).toBe("message");
  });

  it("extracts joined readable text from an array-of-text tool_result content (real Pi-runtime shape)", () => {
    const descriptors = buildEventDescriptors({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "line one\n" },
              { type: "text", text: "line two" },
            ],
          },
        ],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.label).toBe("Tool result");
    expect(descriptors.summary).toBe("line one line two");
  });

  it("falls back to JSON when array tool_result content mixes text with non-text blocks", () => {
    const descriptors = buildEventDescriptors({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "line one" },
              { type: "image", source: { data: "abc" } },
            ],
          },
        ],
      },
    });
    expect(descriptors.category).toBe("tool");
    expect(descriptors.summary).toContain('"type":"image"');
  });
});

describe("buildEventDescriptors (raw RuntimeEventLike -> descriptors)", () => {
  it("bridges a raw tool event to category/label/summary", () => {
    const descriptors = buildEventDescriptors({ type: "tool.call", toolName: "Read", status: "started" });
    expect(descriptors).toEqual({
      category: "tool",
      label: "Tool: Read",
      summary: "Read — started",
    });
  });

  it("bridges a raw assistant message event", () => {
    const descriptors = buildEventDescriptors({
      type: "assistant",
      message: { content: [{ type: "text", text: "visible response" }] },
    });
    expect(descriptors.category).toBe("message");
    expect(descriptors.summary).toBe("visible response");
  });

  it("redacts sensitive payload fields before deriving a fallback summary", () => {
    const descriptors = buildEventDescriptors({ type: "request", apiKey: "fixture-secret-value" });
    expect(descriptors.category).toBe("runtime");
    expect(descriptors.summary).toContain("[redacted]");
    expect(descriptors.summary).not.toContain("fixture-secret-value");
  });

  it("matches the same category/label/summary that toRecordedEvent produces", () => {
    // Parity guard: buildEventDescriptors must be the single source of truth so the
    // recorded-runs reader path and the export path agree.
    const raw = { type: "thinking.delta", summary: "checking available tools" };
    expect(buildEventDescriptors(raw)).toEqual({
      category: "thinking",
      label: "thinking.delta",
      summary: "checking available tools",
    });
  });
});

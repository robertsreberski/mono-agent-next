import { describe, expect, it } from "vitest";

import {
  convertMessage,
  convertOperatorActivities,
  resolveOperatorQuote,
} from "./runtime";
import type { Message } from "./types";

const timestamp = "2026-07-24T00:00:00.000Z";

describe("web assistant-ui runtime", () => {
  it("maps a browser-local selection to the authoritative replay id and full text", () => {
    const source = message({
      id: "web-local-message",
      operatorMessageId: "operator-message-7",
      text: "Authoritative full response",
    });

    expect(resolveOperatorQuote({
      messageId: "web-local-message",
      text: "selected fragment",
    }, [source], true)).toEqual({
      conversationId: "",
      messageId: "operator-message-7",
      text: "Authoritative full response",
    });
    expect(convertMessage(source).metadata?.custom).toMatchObject({
      operatorMessageId: "operator-message-7",
    });
  });

  it("does not emit quotes without capability or an authoritative replay id", () => {
    const localOnly = message({ id: "web-local-only" });
    const selected = { messageId: localOnly.id, text: "local text" };

    expect(resolveOperatorQuote(selected, [localOnly], true)).toBeUndefined();
    expect(resolveOperatorQuote(selected, [{
      ...localOnly,
      operatorMessageId: "operator-message-1",
    }], false)).toBeUndefined();
  });

  it("correlates tool results by call id without relying on adjacency or result order", () => {
    const parts = convertOperatorActivities([
      {
        type: "tool_call",
        call: {
          id: "call-first",
          name: "read_file",
          input: { path: "/tmp/first.txt" },
          inputOmitted: false,
        },
      },
      {
        type: "tool_result",
        result: {
          callId: "call-second",
          content: [{ type: "json", value: { found: true } }],
          contentOmitted: false,
        },
      },
      { type: "activity", text: "Checked both sources." },
      {
        type: "tool_result",
        result: {
          callId: "call-first",
          content: [{ type: "text", text: "first contents" }],
          contentOmitted: false,
        },
      },
      {
        type: "tool_call",
        call: {
          id: "call-second",
          name: "search",
          input: { query: "needle" },
          inputOmitted: false,
        },
      },
    ]);

    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-first",
      toolName: "read_file",
      args: { path: "/tmp/first.txt" },
      result: {
        callId: "call-first",
        content: ["first contents"],
        contentOmitted: false,
        isError: false,
      },
      isError: false,
    });
    expect(parts[1]).toEqual({ type: "reasoning", text: "Checked both sources." });
    expect(parts[2]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-second",
      toolName: "search",
      args: { query: "needle" },
      result: {
        callId: "call-second",
        content: [{ found: true }],
        contentOmitted: false,
        isError: false,
      },
      isError: false,
    });
  });

  it("preserves policy-omitted tool payloads and error state", () => {
    const [part] = convertOperatorActivities([
      {
        type: "tool_call",
        call: {
          id: "call-private",
          name: "private_lookup",
          inputOmitted: true,
        },
      },
      {
        type: "tool_result",
        result: {
          callId: "call-private",
          contentOmitted: true,
          isError: true,
        },
      },
    ]);

    expect(part).toEqual({
      type: "tool-call",
      toolCallId: "call-private",
      toolName: "private_lookup",
      args: { omitted: true, message: "Input omitted by policy" },
      argsText: "{\"omitted\":true}",
      result: {
        callId: "call-private",
        contentOmitted: true,
        isError: true,
      },
      isError: true,
    });
  });

  it("keeps an orphan tool result visible as an operator data part", () => {
    const parts = convertOperatorActivities([
      {
        type: "tool_result",
        result: {
          callId: "missing-call",
          content: [
            { type: "text", text: "partial output" },
            { type: "json", value: { retryable: false } },
          ],
          contentOmitted: false,
          isError: true,
        },
      },
    ]);

    expect(parts).toEqual([
      {
        type: "data-operator-result",
        data: {
          callId: "missing-call",
          content: ["partial output", { retryable: false }],
          contentOmitted: false,
          isError: true,
        },
      },
    ]);
  });

  it("retains activity order and compaction token counts before assistant text", () => {
    const converted = convertMessage(message({
      text: "Final answer",
      activities: [
        { type: "activity", text: "Reviewing context." },
        {
          type: "compaction",
          compaction: {
            compacted: true,
            tokensBefore: 9_000,
            tokensAfter: 3_000,
            summaryTokens: 420,
          },
        },
        {
          type: "tool_call",
          call: {
            id: "call-after-compaction",
            name: "finish",
            input: {},
            inputOmitted: false,
          },
        },
      ],
    }));

    expect(converted.content).toEqual([
      { type: "reasoning", text: "Reviewing context." },
      {
        type: "data-operator-compaction",
        data: {
          compacted: true,
          tokensBefore: 9_000,
          tokensAfter: 3_000,
          summaryTokens: 420,
        },
      },
      {
        type: "tool-call",
        toolCallId: "call-after-compaction",
        toolName: "finish",
        args: {},
        argsText: "{}",
      },
      { type: "text", text: "Final answer" },
    ]);
  });
});

function message(overrides: Partial<Message>): Message {
  return {
    id: "message",
    threadId: "thread",
    role: "assistant",
    text: "local text",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "complete",
    ...overrides,
  };
}

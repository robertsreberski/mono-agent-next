// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { convertMessage, resolveOperatorQuote } from "./runtime";
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

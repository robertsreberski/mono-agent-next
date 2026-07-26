// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

// Render contract for the console's message-part map.
//
// The predecessor guard for this surface asserted the *source text* of
// `chat.tsx`, which cannot observe whether a part reaches the DOM — and inverts
// polarity, failing when the map is corrected. These tests drive the real map
// through assistant-ui and assert what the operator actually sees.

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parts } from "./chat";
import { ConsoleProvider } from "./console";
import { convertMessage } from "./runtime";
import type { Message } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // These render-only tests do not mount the application shell. Keep its
      // provider bootstrap pending so an unrelated async auth transition does
      // not update the tree outside the render assertion's act boundary.
      probeBootstrap: async () => await new Promise<never>(() => undefined),
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node exposes disabled Web Storage globals unless a persistence file is
// configured; the console shell reads them on mount.
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

const CREATED_AT = "2026-07-25T10:00:00.000Z";

function assistantMessage(activities: NonNullable<Message["activities"]>): Message {
  return {
    id: "assistant-message",
    threadId: "thread",
    role: "assistant",
    text: "Done.",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    status: "complete",
    activities,
  } as Message;
}

function RenderedParts() {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts components={parts} />
    </MessagePrimitive.Root>
  );
}

function Harness({ message }: { readonly message: Message }) {
  const runtime = useExternalStoreRuntime<Message>({
    messages: [message],
    convertMessage,
    onNew: async () => undefined,
  });
  return (
    <ConsoleProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages
            components={{
              UserMessage: RenderedParts,
              AssistantMessage: RenderedParts,
            }}
          />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </ConsoleProvider>
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("console message parts", () => {
  it("renders a tool call the agent made", () => {
    render(<Harness message={assistantMessage([
      {
        type: "tool_call",
        call: { id: "call-1", name: "inspect_workspace", input: { depth: 2 }, inputOmitted: false },
      },
    ])} />);

    expect(screen.getByText("inspect_workspace")).toBeDefined();
  });

  it("renders a tool result against its originating call", () => {
    render(<Harness message={assistantMessage([
      {
        type: "tool_call",
        call: { id: "call-1", name: "read_file", input: { path: "AGENTS.md" }, inputOmitted: false },
      },
      {
        type: "tool_result",
        result: { callId: "call-1", content: [{ type: "text", text: "ok" }], contentOmitted: false },
      },
    ])} />);

    expect(screen.getByText("read_file")).toBeDefined();
    expect(screen.getByText("complete")).toBeDefined();
  });

  it("renders a compaction row through the data map", () => {
    render(<Harness message={assistantMessage([
      { type: "compaction", compaction: { reason: "context-window", removedMessages: 4 } },
    ] as unknown as NonNullable<Message["activities"]>)} />);

    expect(document.querySelector(".context-compaction-row")).not.toBeNull();
  });
});

// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { OperatorActivity } from "@mono-agent/operator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssistantMessage,
  attachmentMetadata,
  copyableMessageText,
  copyTextWithFallback,
} from "./Messages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
  else Reflect.deleteProperty(document, "execCommand");
  document.body.textContent = "";
});

describe("message presentation helpers", () => {
  it("copies visible answer text without activity or tool payloads", () => {
    expect(copyableMessageText([
      { type: "reasoning", text: "private chain" },
      { type: "text", text: "Answer" },
      { type: "tool-call" },
      { type: "text", text: "More" },
    ])).toBe("Answer\n\nMore");
  });

  it("uses the clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = setExecCommand(() => true);
    setClipboard({ writeText });

    await copyTextWithFallback("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a temporary selection and restores focus on LAN HTTP", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    setClipboard(undefined);
    const execCommand = setExecCommand((command) => command === "copy");

    await copyTextWithFallback("LAN copy");

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea[aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("rejects a clipboard failure after cleaning up the fallback", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    await expect(copyTextWithFallback("blocked")).rejects.toThrow(
      "did not allow clipboard access",
    );

    expect(document.querySelector("textarea")).toBeNull();
  });

  it("formats durable attachment metadata without depending on stripped data URLs", () => {
    expect(attachmentMetadata({
      id: "image",
      name: "diagram.png",
      mediaType: "image/png",
      sizeBytes: 12_400,
    })).toBe("image/png · 12 KB");
    expect(attachmentMetadata({
      id: "text",
      name: "notes.txt",
      mediaType: "text/plain",
    })).toBe("text/plain");
  });

  it("uses raw activity metadata to keep a matching result after intervening activity", async () => {
    const activities = [
      {
        type: "tool_call",
        call: {
          id: "call-a",
          name: "lookup",
          input: { query: "A" },
          inputOmitted: false,
        },
      },
      { type: "activity", text: "Activity B" },
      {
        type: "tool_result",
        result: {
          callId: "call-a",
          content: [{ type: "text", text: "Result A" }],
          contentOmitted: false,
        },
      },
    ] satisfies readonly OperatorActivity[];
    const message: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-a",
          toolName: "lookup",
          args: { query: "A" },
          argsText: "{\"query\":\"A\"}",
          result: {
            callId: "call-a",
            content: ["Result A"],
            contentOmitted: false,
          },
        },
        { type: "reasoning", text: "Activity B" },
      ],
      createdAt: new Date("2026-07-24T12:00:00.000Z"),
      status: { type: "complete", reason: "stop" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: { activities },
      },
    };
    const view = await mountAssistantMessage(message);

    const trigger = requiredElement<HTMLButtonElement>(view.host, ".activity-trigger");
    await act(async () => trigger.click());
    const occurrences = [
      ...view.host.querySelectorAll<HTMLElement>("[data-activity-occurrence]"),
    ];
    expect(occurrences.map((node) => node.dataset.activityOccurrence)).toEqual([
      "tool_call",
      "activity",
      "tool_result",
    ]);
    expect(view.host.querySelectorAll("[data-activity-occurrence='tool_call']")).toHaveLength(1);
    expect(view.host.querySelectorAll("[data-activity-occurrence='tool_result']")).toHaveLength(1);
    expect(occurrences[1]?.textContent).toContain("Activity B");
    expect(occurrences[2]?.textContent).toContain("lookup result");

    await view.unmount();
  });
});

function AssistantMessageHarness({ message }: { readonly message: ThreadMessage }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [message],
    onNew: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages
          components={{
            AssistantMessage,
            UserMessage: () => null,
          }}
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

async function mountAssistantMessage(message: ThreadMessage) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AssistantMessageHarness message={message} />);
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function setClipboard(
  value: { readonly writeText: (text: string) => Promise<void> } | undefined,
): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function setExecCommand(
  implementation: (command: string) => boolean,
): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(implementation);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function requiredElement<ElementType extends Element>(
  host: ParentNode,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

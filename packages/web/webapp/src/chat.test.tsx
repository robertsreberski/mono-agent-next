// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  ContextUsage,
  currentAssistantContext,
  displayedAssistantContext,
} from "./chat";
import { PopoverProvider } from "./components/Popover";
import type { Message } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.textContent = "";
});

describe("current assistant context", () => {
  it("hides prior settled telemetry from the instant a new send is pending", () => {
    const previous = assistantMessage("completed", "complete", {
      inputTokens: 120,
      outputTokens: 30,
      contextUsed: 150,
      contextWindow: 1_000,
      compacted: false,
      sessionEvicted: false,
    });
    expect(displayedAssistantContext([previous], true)).toEqual({ pending: true });
  });

  it("does not present prior-turn telemetry as current during a new run", async () => {
    const context = currentAssistantContext([
      assistantMessage("completed", "complete", {
        inputTokens: 120,
        outputTokens: 30,
        contextUsed: 150,
        contextWindow: 1_000,
        compacted: false,
        sessionEvicted: false,
      }),
      assistantMessage("running", "running", {
        inputTokens: 20,
        outputTokens: 0,
        contextWindow: 1_000,
        compacted: false,
        sessionEvicted: false,
      }),
    ]);
    expect(context).toEqual({
      pending: true,
      telemetry: {
        inputTokens: 20,
        outputTokens: 0,
        contextWindow: 1_000,
        compacted: false,
        sessionEvicted: false,
      },
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <PopoverProvider>
          <ContextUsage {...context} />
        </PopoverProvider>,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Context usage"]');
    expect(trigger?.textContent).toContain("Context pending");
    await act(async () => trigger?.click());
    expect(document.body.textContent).toContain(
      "Exact context telemetry is not available for the active response yet.",
    );
    expect(document.body.textContent).toContain("Pending");
    expect(document.body.textContent).not.toContain("Context 150");

    await act(async () => root.unmount());
  });
});

function assistantMessage(
  id: string,
  status: Message["status"],
  telemetry?: Message["telemetry"],
): Message {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    text: "",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    status,
    ...(telemetry === undefined ? {} : { telemetry }),
  };
}

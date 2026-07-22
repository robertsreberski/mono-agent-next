import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { StatusBar } from "../ui/components/status-bar.js";
import { ChatView, type ChatTurnSettledEvent } from "../ui/views/chat.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

function setup(onTurnSettled?: (event: ChatTurnSettledEvent) => void | Promise<void>): {
  chat: ChatView;
  status: () => string;
} {
  const tui = new TUI(new TestTerminal(100, 30));
  const statusBar = new StatusBar();
  const chat = new ChatView({
    tui,
    statusBar,
    conversationId: "chat-view-test",
    slashCommands: [],
    onSlashCommand: () => false,
    flushIntervalMs: 0,
    ...(onTurnSettled === undefined ? {} : { onTurnSettled }),
  });
  return { chat, status: () => stripAnsi(statusBar.render(80).join("\n")) };
}

async function waitForSettle(chat: ChatView): Promise<void> {
  while (chat.hasActiveTurn()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Responds once per call, in order, with the given (possibly absent) finish metadata. */
function responderReturning(metadataSequence: ReadonlyArray<Record<string, unknown> | undefined>): AgentResponder {
  let call = 0;
  return {
    respond: async (request) => {
      const metadata = metadataSequence[call];
      call += 1;
      return {
        text: `echo: ${request.text}`,
        ...(metadata === undefined ? {} : { metadata }),
      };
    },
  };
}

describe("ChatView finish metadata (C3)", () => {
  it("applies the finish response's runtime effort/model to the status bar", async () => {
    const { chat, status } = setup();
    chat.setResponder(responderReturning([{ runtime: { effort: "high", model: "claude-fable-5" } }]));

    chat.editor.onSubmit?.("hello");
    await waitForSettle(chat);

    const text = status();
    expect(text).toContain("effort:high");
    expect(text).toContain("claude-fable-5");
  });

  it("does not clear an existing effort/model when a later turn's finish metadata omits runtime", async () => {
    const { chat, status } = setup();
    chat.setResponder(
      responderReturning([{ runtime: { effort: "high", model: "claude-fable-5" } }, undefined]),
    );

    chat.editor.onSubmit?.("first");
    await waitForSettle(chat);
    expect(status()).toContain("effort:high");

    chat.editor.onSubmit?.("second");
    await waitForSettle(chat);
    const text = status();
    expect(text).toContain("effort:high");
    expect(text).toContain("claude-fable-5");
  });

  it("applies only whichever of effort/model is a string, leaving the other untouched", async () => {
    const { chat, status } = setup();
    chat.setResponder(
      responderReturning([{ runtime: { model: "claude-fable-5" } }, { runtime: { effort: "medium" } }]),
    );

    chat.editor.onSubmit?.("first");
    await waitForSettle(chat);
    expect(status()).toContain("claude-fable-5");
    expect(status()).not.toContain("effort:");

    chat.editor.onSubmit?.("second");
    await waitForSettle(chat);
    const text = status();
    expect(text).toContain("claude-fable-5");
    expect(text).toContain("effort:medium");
  });

  it("ignores malformed/non-object runtime metadata defensively", async () => {
    const { chat, status } = setup();
    chat.setResponder(responderReturning([{ runtime: "not-an-object" }]));

    chat.editor.onSubmit?.("hello");
    await waitForSettle(chat);

    expect(status()).not.toContain("effort:");
  });

  it("ignores a response with no metadata at all", async () => {
    const { chat, status } = setup();
    chat.setResponder(responderReturning([undefined]));

    chat.editor.onSubmit?.("hello");
    await waitForSettle(chat);

    expect(status()).not.toContain("effort:");
  });

  it("does not dispatch a fast follow-up until the settled hook completes", async () => {
    let releaseHook: (() => void) | undefined;
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let hooks = 0;
    const { chat } = setup(async () => {
      hooks += 1;
      if (hooks === 1) {
        markHookStarted?.();
        await hookGate;
      }
    });
    const calls: string[] = [];
    chat.setResponder({
      respond: async (request) => {
        calls.push(request.text);
        return { text: `echo: ${request.text}` };
      },
    });

    chat.editor.onSubmit?.("invitation");
    await hookStarted;
    chat.editor.onSubmit?.("fast configuration answer");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chat.hasActiveTurn()).toBe(true);
    expect(calls).toEqual(["invitation"]);

    releaseHook?.();
    await waitForSettle(chat);
    expect(calls).toEqual(["invitation", "fast configuration answer"]);
  });
});

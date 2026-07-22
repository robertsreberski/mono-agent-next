import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { AgentRequestBase, AgentResponder } from "@mono-agent/agent-contracts";

import { StatusBar } from "../ui/components/status-bar.js";
import { ChatView } from "../ui/views/chat.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

function setup(responder?: AgentResponder): {
  chat: ChatView;
  statusBar: StatusBar;
  status: () => string;
} {
  const tui = new TUI(new TestTerminal(100, 30));
  const statusBar = new StatusBar();
  const chat = new ChatView({
    tui,
    statusBar,
    conversationId: "model-override-test",
    slashCommands: [],
    onSlashCommand: () => false,
    flushIntervalMs: 0,
  });
  if (responder !== undefined) {
    chat.setResponder(responder);
  }
  return { chat, statusBar, status: () => stripAnsi(statusBar.render(120).join("\n")) };
}

async function waitForSettle(chat: ChatView): Promise<void> {
  while (chat.hasActiveTurn()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Records every outgoing request's metadata, in order, then echoes. */
function capturingResponder(): { responder: AgentResponder; metadata: (Record<string, unknown> | undefined)[] } {
  const metadata: (Record<string, unknown> | undefined)[] = [];
  return {
    metadata,
    responder: {
      respond: async (request: AgentRequestBase) => {
        metadata.push(request.metadata as Record<string, unknown> | undefined);
        return { text: `echo: ${request.text}` };
      },
    },
  };
}

describe("ChatView model override (Layer 3)", () => {
  it("attaches metadata.tui.model to the outgoing request when an override is set", async () => {
    const { responder, metadata } = capturingResponder();
    const { chat } = setup(responder);

    chat.setModelOverride("codex:gpt-5.5");
    chat.editor.onSubmit?.("hello");
    await waitForSettle(chat);

    expect(metadata[0]).toEqual({ source: "tui", tui: { model: "codex:gpt-5.5" } });
  });

  it("omits metadata.tui when no override is set (only source: tui)", async () => {
    const { responder, metadata } = capturingResponder();
    const { chat } = setup(responder);

    chat.editor.onSubmit?.("hello");
    await waitForSettle(chat);

    expect(metadata[0]).toEqual({ source: "tui" });
  });

  it("clearing the override (undefined) drops metadata.tui on the next turn", async () => {
    const { responder, metadata } = capturingResponder();
    const { chat } = setup(responder);

    chat.setModelOverride("codex:gpt-5.5");
    chat.editor.onSubmit?.("first");
    await waitForSettle(chat);

    chat.setModelOverride(undefined);
    chat.editor.onSubmit?.("second");
    await waitForSettle(chat);

    expect(metadata[0]).toEqual({ source: "tui", tui: { model: "codex:gpt-5.5" } });
    expect(metadata[1]).toEqual({ source: "tui" });
  });

  it("does not carry ordinary model or effort overrides into configuration turns", async () => {
    const { responder, metadata } = capturingResponder();
    const { chat } = setup(responder);
    chat.setModelOverride("opencode:test/model");
    chat.setEffortOverride("high");

    chat.beginConfiguration("open configuration", {
      conversationId: "configuration",
      sessionId: "11111111-2222-4333-8444-555555555555",
      operatorPrompt: "handle one configuration response",
    });
    await waitForSettle(chat);
    chat.continueConfiguration({
      conversationId: "configuration",
      sessionId: "11111111-2222-4333-8444-555555555555",
      operatorPrompt: "handle one configuration response",
    });
    chat.editor.onSubmit?.("make a safe change");
    await waitForSettle(chat);

    expect(metadata).toHaveLength(2);
    expect(metadata[0]).toEqual({
      source: "tui",
      tui: {
        configuration: true,
        configurationSessionId: "11111111-2222-4333-8444-555555555555",
        configurationPhase: "invitation",
      },
    });
    expect(metadata[1]).toEqual({
      source: "tui",
      tui: {
        configuration: true,
        configurationSessionId: "11111111-2222-4333-8444-555555555555",
        configurationPhase: "operator",
      },
    });
    expect(chat.getModelOverride()).toBe("opencode:test/model");
    expect(chat.getEffortOverride()).toBe("high");
  });

  it("exposes the current override for the picker's (current) marker", () => {
    const { chat } = setup();
    expect(chat.getModelOverride()).toBeUndefined();
    chat.setModelOverride("codex:gpt-5.5");
    expect(chat.getModelOverride()).toBe("codex:gpt-5.5");
    chat.setModelOverride(undefined);
    expect(chat.getModelOverride()).toBeUndefined();
  });

  it("reflects the override on the status bar model segment immediately (before any turn)", () => {
    const { chat, status } = setup();
    chat.setModelOverride("codex:gpt-5.5");
    const text = status();
    expect(text).toContain("codex:gpt-5.5");
    expect(text).toContain("(override)");
  });

  it("drops the (override) marker when the override is cleared", () => {
    const { chat, status } = setup();
    chat.setModelOverride("codex:gpt-5.5");
    expect(status()).toContain("(override)");
    chat.setModelOverride(undefined);
    expect(status()).not.toContain("(override)");
  });
});

describe("StatusBar model override marker", () => {
  it("shows (override) on the model segment only while active", () => {
    const bar = new StatusBar();
    bar.setModel("claude-fable-5");
    expect(stripAnsi(bar.render(120).join("\n"))).not.toContain("(override)");
    bar.setModelOverridden(true);
    const text = stripAnsi(bar.render(120).join("\n"));
    expect(text).toContain("claude-fable-5");
    expect(text).toContain("(override)");
    bar.setModelOverridden(false);
    expect(stripAnsi(bar.render(120).join("\n"))).not.toContain("(override)");
  });

  it("does not render (override) when there is no model, even if flagged", () => {
    const bar = new StatusBar();
    bar.setModelOverridden(true);
    expect(stripAnsi(bar.render(120).join("\n"))).not.toContain("(override)");
  });
});

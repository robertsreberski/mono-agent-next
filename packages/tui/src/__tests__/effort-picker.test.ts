import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { startMonoAgentTui } from "../runtime/start.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

const ESC = String.fromCharCode(27);

async function frame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function okResponder(): AgentResponder {
  return { respond: async () => ({ text: "ok" }) };
}

/** Records every turn's request metadata so a test can assert on metadata.tui. */
function capturingResponder(sink: (Record<string, unknown> | undefined)[]): AgentResponder {
  return {
    respond: async (request) => {
      sink.push(request.metadata as Record<string, unknown> | undefined);
      return { text: "ok" };
    },
  };
}

function type(terminal: TestTerminal, text: string): void {
  for (const char of text) {
    terminal.feed(char);
  }
}

/** Last full status-bar render line (identified by the persistent hint text). */
function lastStatusBar(terminal: TestTerminal): string {
  const renders = terminal.writes.map(stripAnsi).filter((write) => write.includes("tab views"));
  return renders.at(-1) ?? "";
}

describe("/effort slash command (Layer E)", () => {
  it("sets metadata.tui.effort with `/effort <level>` and clears it (no metadata.tui) with `/effort default`", async () => {
    const captured: (Record<string, unknown> | undefined)[] = [];
    const adapter = await startTuiAdapter({
      responder: capturingResponder(captured),
      info: { model: "claude-fable-5", effort: "medium", models: ["claude-fable-5"] },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort high");
      terminal.feed("\r");
      await frame();
      expect(lastStatusBar(terminal)).toContain("effort:high (override)");

      type(terminal, "hello");
      terminal.feed("\r");
      await frame();
      await frame();
      expect(captured[0]).toBeDefined();
      expect((captured[0] as Record<string, unknown>).tui).toEqual({ effort: "high" });

      type(terminal, "/effort default");
      terminal.feed("\r");
      await frame();
      const cleared = lastStatusBar(terminal);
      expect(cleared).toContain("effort:medium");
      expect(cleared).not.toContain("(override)");

      type(terminal, "again");
      terminal.feed("\r");
      await frame();
      await frame();
      // Both overrides absent -> no metadata.tui at all.
      expect((captured[1] as Record<string, unknown>).tui).toBeUndefined();
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("opens a picker limited to the effective model's effortLevels when present", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: {
        model: "local:llama",
        effort: "low",
        models: ["local:llama", "claude-fable-5"],
        modelOptions: { "local:llama": { effortLevels: ["low", "medium", "high"], reasoning: true } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();

      const overlay = stripAnsi(terminal.output());
      expect(overlay).toContain("Session effort override");
      expect(overlay).toContain("low");
      expect(overlay).toContain("medium");
      expect(overlay).toContain("default");
      // The model advertises only low/medium/high, so the global-only levels
      // (xhigh/max) must NOT appear -- proves per-model sourcing.
      expect(overlay).not.toContain("xhigh");
      expect(overlay).not.toContain("max");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("offers a binary on/off picker (not graded levels) for a toggle-reasoning model", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: {
        model: "pi:ollama:qwen3.6",
        models: ["pi:ollama:qwen3.6"],
        modelOptions: { "pi:ollama:qwen3.6": { reasoning: true, reasoningMode: "toggle", label: "qwen3.6" } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();

      const overlay = stripAnsi(terminal.output());
      expect(overlay).toContain("Session effort override");
      expect(overlay).toContain("thinking on");
      expect(overlay).toContain("thinking off");
      expect(overlay).toContain("default");
      // A toggle model supports only on/off, so the graded effort levels must
      // NOT appear -- proves it's mode-aware, not the global enum.
      expect(overlay).not.toContain("medium");
      expect(overlay).not.toContain("xhigh");
      expect(overlay).not.toContain("max");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("sends effort 'none' when 'thinking off' is picked for a toggle model", async () => {
    const captured: (Record<string, unknown> | undefined)[] = [];
    const adapter = await startTuiAdapter({
      responder: capturingResponder(captured),
      info: {
        model: "pi:ollama:qwen3.6",
        models: ["pi:ollama:qwen3.6"],
        modelOptions: { "pi:ollama:qwen3.6": { reasoning: true, reasoningMode: "toggle", label: "qwen3.6" } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();
      terminal.feed("\x1b[B"); // down -> "thinking off" (index 1)
      terminal.feed("\r"); // select
      await frame();

      type(terminal, "hello");
      terminal.feed("\r");
      await frame();
      await frame();
      expect((captured[0] as Record<string, unknown>).tui).toEqual({ effort: "none" });
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("sends a non-none effort when 'thinking on' is picked for a toggle model", async () => {
    const captured: (Record<string, unknown> | undefined)[] = [];
    const adapter = await startTuiAdapter({
      responder: capturingResponder(captured),
      info: {
        model: "pi:ollama:qwen3.6",
        models: ["pi:ollama:qwen3.6"],
        modelOptions: { "pi:ollama:qwen3.6": { reasoning: true, reasoningMode: "toggle", label: "qwen3.6" } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();
      terminal.feed("\r"); // select index 0 -> "thinking on"
      await frame();

      type(terminal, "hi");
      terminal.feed("\r");
      await frame();
      await frame();
      const tui = (captured[0] as Record<string, unknown>).tui as { effort?: string };
      expect(tui.effort).toBe("high"); // "high" maps to thinking-on via the harness
      expect(tui.effort).not.toBe("none");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("falls back to the global effort enum when the effective model advertises no effortLevels", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: {
        model: "claude-fable-5",
        models: ["claude-fable-5"],
        modelOptions: { "claude-fable-5": { reasoning: true } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();

      const overlay = stripAnsi(terminal.output());
      // No per-model effortLevels -> global EFFORT_LEVELS, which includes xhigh/max.
      expect(overlay).toContain("xhigh");
      expect(overlay).toContain("max");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("shows a not-supported notice (no picker) for a model with reasoning:false", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: {
        model: "local:embed",
        models: ["local:embed"],
        modelOptions: { "local:embed": { reasoning: false, label: "Local Embed" } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();

      const out = stripAnsi(terminal.output());
      expect(out).toContain("does not support adjustable thinking/effort");
      expect(out).not.toContain("Session effort override");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("shows the not-supported notice for a model with an empty effortLevels array", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: {
        model: "local:embed",
        models: ["local:embed"],
        modelOptions: { "local:embed": { effortLevels: [] } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();

      const out = stripAnsi(terminal.output());
      expect(out).toContain("does not support adjustable thinking/effort");
      expect(out).not.toContain("Session effort override");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("esc cancels the effort picker without setting an override", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: { model: "claude-fable-5", effort: "medium", models: ["claude-fable-5"] },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/effort");
      terminal.feed("\r");
      await frame();
      expect(stripAnsi(terminal.output())).toContain("Session effort override");

      terminal.feed(ESC);
      await frame();
      expect(lastStatusBar(terminal)).not.toContain("(override)");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("carries both model and effort in metadata.tui when both overrides are set", async () => {
    const captured: (Record<string, unknown> | undefined)[] = [];
    const adapter = await startTuiAdapter({
      responder: capturingResponder(captured),
      info: { model: "claude-fable-5", effort: "medium", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/model codex:gpt-5.5");
      terminal.feed("\r");
      await frame();
      type(terminal, "/effort high");
      terminal.feed("\r");
      await frame();

      type(terminal, "hello");
      terminal.feed("\r");
      await frame();
      await frame();

      expect(captured[0]).toBeDefined();
      expect((captured[0] as Record<string, unknown>).tui).toEqual({
        model: "codex:gpt-5.5",
        effort: "high",
      });
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("documents /effort (and its model-specific options) in the help overlay", async () => {
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      responder: okResponder(),
      flushIntervalMs: 0,
    });
    try {
      await frame();
      type(terminal, "/help");
      terminal.feed("\r");
      await frame();
      const helpText = stripAnsi(terminal.output()).replace(/\s+/gu, " ");
      expect(helpText).toContain("/effort");
      expect(helpText.toLowerCase()).toContain("model-specific");
    } finally {
      await handle.stop();
    }
  });
});

describe("/model picker per-model annotations (Layer E)", () => {
  it("annotates rows with friendly labels and a no-thinking marker", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: {
        model: "claude-fable-5",
        models: ["claude-fable-5", "local:embed"],
        modelOptions: { "local:embed": { reasoning: false, label: "Local Embed" } },
      },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame(); // info() resolves

      type(terminal, "/model");
      terminal.feed("\r");
      await frame();

      const overlay = stripAnsi(terminal.output());
      expect(overlay).toContain("Local Embed");
      expect(overlay).toContain("no thinking");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });
});

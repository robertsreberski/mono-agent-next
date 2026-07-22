import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { startMonoAgentTui } from "../runtime/start.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;

async function frame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function okResponder(): AgentResponder {
  return { respond: async () => ({ text: "ok" }) };
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

/** A discovery-registry manifest pointing at a live `startTuiAdapter` instance. */
async function writeTraceSourceManifest(
  dir: string,
  sourceId: string,
  baseUrl: string,
  updatedAt: string,
): Promise<void> {
  await writeFile(
    join(dir, `${sourceId}.json`),
    JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId,
      label: sourceId,
      artifactDir: join(dir, `${sourceId}-artifacts`),
      pid: process.pid,
      status: "running",
      startedAt: updatedAt,
      updatedAt,
      transports: ["tui"],
      metadata: { channels: { tui: { kind: "running", baseUrl } } },
    }),
  );
}

describe("/model slash command (Layer 4)", () => {
  it("sets an override with `/model <ref>` and clears it with `/model default`", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
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
      expect(lastStatusBar(terminal)).toContain("codex:gpt-5.5");
      expect(lastStatusBar(terminal)).toContain("(override)");

      type(terminal, "/model default");
      terminal.feed("\r");
      await frame();
      expect(lastStatusBar(terminal)).not.toContain("(override)");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("opens a picker overlay on bare `/model`, and selecting a model sets the override", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
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
      expect(overlay).toContain("claude-fable-5");
      expect(overlay).toContain("codex:gpt-5.5");
      expect(overlay).toContain("default");

      // Move down to the second model (codex) and select it.
      terminal.feed(DOWN);
      await frame();
      terminal.feed("\r"); // enter -> select
      await frame();

      expect(lastStatusBar(terminal)).toContain("codex:gpt-5.5");
      expect(lastStatusBar(terminal)).toContain("(override)");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("selecting the trailing default entry clears the override", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame();

      // Set an override first via the direct command.
      type(terminal, "/model codex:gpt-5.5");
      terminal.feed("\r");
      await frame();
      expect(lastStatusBar(terminal)).toContain("(override)");

      // Open the picker and pick the last row (the default / clear-override
      // entry). Two models + default entry = 3 rows; from index 0, two downs
      // land on the trailing default row.
      type(terminal, "/model");
      terminal.feed("\r");
      await frame();
      terminal.feed(DOWN);
      terminal.feed(DOWN);
      await frame();
      terminal.feed("\r");
      await frame();

      expect(lastStatusBar(terminal)).not.toContain("(override)");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("esc cancels the picker without changing the override", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: adapter.baseUrl },
      flushIntervalMs: 0,
    });
    try {
      await frame();
      await frame();

      type(terminal, "/model");
      terminal.feed("\r");
      await frame();
      expect(stripAnsi(terminal.output())).toContain("codex:gpt-5.5");

      terminal.feed(ESC); // esc cancels
      await frame();
      expect(lastStatusBar(terminal)).not.toContain("(override)");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });

  it("falls back to a hint when a bare `/model` has no advertised model list", async () => {
    const terminal = new TestTerminal(120, 30);
    const handle = startMonoAgentTui({
      terminal,
      responder: okResponder(), // embedded mode never calls /v1/info, so no models
      flushIntervalMs: 0,
    });
    try {
      await frame();
      type(terminal, "/model");
      terminal.feed("\r");
      await frame();
      // No overlay list; a hint tells the user how to override manually.
      expect(stripAnsi(terminal.output())).toContain("/model <ref>");
    } finally {
      await handle.stop();
    }
  });

  it("documents /model (and the fresh-session note) in the help overlay", async () => {
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
      expect(helpText).toContain("/model");
      expect(helpText.toLowerCase()).toContain("fresh provider session");
    } finally {
      await handle.stop();
    }
  });
});

describe("/model override agent-switch and clear regressions", () => {
  it("connecting to a different agent clears the override -- no metadata.tui on the next turn, no (override) tag", async () => {
    const capturedOnB: (Record<string, unknown> | undefined)[] = [];
    const agentA = await startTuiAdapter({
      responder: okResponder(),
      info: { label: "agent-a", model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });
    const agentB = await startTuiAdapter({
      responder: {
        respond: async (request) => {
          capturedOnB.push(request.metadata as Record<string, unknown> | undefined);
          return { text: "ok" };
        },
      },
      info: { label: "agent-b", model: "claude-fable-mini", models: ["claude-fable-mini"] },
    });
    const dir = await mkdtemp(join(tmpdir(), "tui-model-override-switch-"));
    try {
      // Same updatedAt so listTraceSources' tie-break (sourceId ascending) makes
      // the ordering deterministic: agent-a first, agent-b second.
      const updatedAt = new Date().toISOString();
      await writeTraceSourceManifest(dir, "agent-a", agentA.baseUrl, updatedAt);
      await writeTraceSourceManifest(dir, "agent-b", agentB.baseUrl, updatedAt);

      const terminal = new TestTerminal(120, 30);
      const handle = startMonoAgentTui({ terminal, discovery: { registryDir: dir }, flushIntervalMs: 0 });
      await frame();
      await frame(); // discovery's refreshInstances() is async; give it time to populate

      // Discovery opens on the picker with the first instance (agent-a) selected.
      terminal.feed("\r");
      await frame();
      await frame(); // info() resolves

      type(terminal, "/model codex:gpt-5.5");
      terminal.feed("\r");
      await frame();
      expect(lastStatusBar(terminal)).toContain("codex:gpt-5.5");
      expect(lastStatusBar(terminal)).toContain("(override)");

      terminal.feed("\x1b[15~"); // F5 -> back to the picker (already-populated list)
      await frame();
      terminal.feed(DOWN); // -> agent-b
      await frame();
      terminal.feed("\r"); // connect
      await frame();
      await frame(); // info() resolves

      const statusBarRenders = terminal.writes
        .map(stripAnsi)
        .filter((write) => write.includes("agent-b") && write.includes("tab views"));
      const finalStatusBarRender = statusBarRenders.at(-1) ?? "";
      expect(finalStatusBarRender).toContain("claude-fable-mini");
      expect(finalStatusBarRender).not.toContain("(override)");

      type(terminal, "hello");
      terminal.feed("\r");
      await frame();
      await frame();

      expect(capturedOnB[0]).toBeDefined();
      expect((capturedOnB[0] as Record<string, unknown>).tui).toBeUndefined();

      await handle.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await agentA.stop();
      await agentB.stop();
    }
  });

  it("clearing the override with `/model default` shows the agent's default model, not the last override string", async () => {
    const adapter = await startTuiAdapter({
      responder: okResponder(),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
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
      expect(lastStatusBar(terminal)).toContain("codex:gpt-5.5");

      type(terminal, "/model default");
      terminal.feed("\r");
      await frame();

      const finalStatus = lastStatusBar(terminal);
      expect(finalStatus).toContain("claude-fable-5");
      expect(finalStatus).not.toContain("codex:gpt-5.5");
      expect(finalStatus).not.toContain("(override)");
    } finally {
      await handle.stop();
      await adapter.stop();
    }
  });
});

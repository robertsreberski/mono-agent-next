import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryStore } from "@mono-agent/agent-contracts";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";
import type { RuntimeResult } from "@mono-agent/runtime-adapter";
import type { SkillsCache } from "../skills/index.js";

import { createAgentHarness } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-resilience-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function fakeRuntime(result: RuntimeResult = { text: "ok", providerSessionId: "ps-1" }) {
  return {
    async run(): Promise<RuntimeResult> {
      return result;
    },
    async disposeSession(): Promise<boolean> {
      return true;
    },
    async disposeAllSessions(): Promise<void> {},
  };
}

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness resilience + caching", () => {
  it("degrades to empty memory and warns (does not fail the turn) when memory.load throws", async () => {
    const identityPath = await identityFixture();
    const events: Array<Record<string, unknown>> = [];
    const memory = {
      load: async () => {
        throw new Error("ollama embeddings timed out");
      },
      appendHostSummary: async () => ({ ok: true }),
      scheduleCapture: () => {},
    } as unknown as MemoryStore;

    const harness = createAgentHarness({
      identityPath,
      runtime: fakeRuntime(),
      model,
      executionMode: "sdk",
      memory,
    });

    const response = await harness.run({
      ...request("conv-1"),
      onEvent: (event) => events.push(event as Record<string, unknown>),
    });

    // The turn still succeeds — a memory backend failure must not fail the request.
    expect(response.text).toBe("ok");
    expect(response.failure).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "runtime_warning", warning_kind: "memory_degraded" }),
    );
  });

  it("does not retroactively fail a provider answer when memory persistence and diagnostics throw", async () => {
    const identityPath = await identityFixture();
    const warnings: string[] = [];
    const lifecycle: string[] = [];
    let terminalCalls = 0;
    const memory: MemoryStore = {
      load: async () => undefined,
      appendHostSummary: async () => { throw new Error("legacy append must not run"); },
      persistCompletedTurn: async () => { throw new Error("disk became read-only at /private/secret?token=do-not-log"); },
    };
    const recorderFactory = (input: { readonly runId: string; readonly conversationId: string }): RunRecorder => {
      const events: RuntimeEventLike[] = [];
      const summary = (status: RunSummary["status"]): RunSummary => ({
        runId: input.runId,
        conversationId: input.conversationId,
        status,
        durationMs: 1,
        eventCount: events.length,
        artifactPaths: [],
      });
      const commit = async (_result: RuntimeResultLike): Promise<RunSummary> => {
        terminalCalls += 1;
        lifecycle.push("terminal");
        return summary("succeeded");
      };
      return {
        onEvent(event): void {
          events.push(event);
          if (event.type === "runtime_warning") lifecycle.push("warning");
        },
        async start(): Promise<RunSummary> { return summary("running"); },
        async prepareFinish(): Promise<void> { lifecycle.push("prepare"); },
        commitFinish: commit,
        finish: commit,
        async fail(): Promise<RunSummary> { return summary("failed"); },
      };
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: fakeRuntime({ text: "provider succeeded", providerSessionId: "ps-2" }),
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "append-host-summary",
      onMemoryWarning: (message) => {
        warnings.push(message);
        throw new Error("warning callback failed");
      },
      recorderFactory,
    });

    const response = await harness.run({
      ...request("conv-write-failure", "remember this"),
      onEvent: (event) => {
        if ((event as { type?: string }).type === "runtime_warning") throw new Error("event sink failed");
      },
    });

    expect(response.text).toBe("provider succeeded");
    expect(response.failure).toBeUndefined();
    expect(warnings).toEqual([
      "Memory persistence was not confirmed after the provider answer; the provider response was preserved.",
    ]);
    expect(warnings.join(" ")).not.toContain("secret");
    expect(lifecycle).toEqual(["prepare", "warning", "terminal"]);
    expect(terminalCalls).toBe(1);
    expect(response.metadata.summary?.eventCount).toBeGreaterThan(0);
  });

  it.each([
    ["hostile toString", { toString: () => { throw new Error("must not stringify"); } }],
    ["hostile Error.message", (() => {
      const value = Object.create(Error.prototype) as Error;
      Object.defineProperty(value, "message", { get: () => { throw new Error("must not read message"); } });
      return value;
    })()],
  ] as const)("preserves a successful provider answer for a %s persistence rejection", async (_label, rejection) => {
    const identityPath = await identityFixture();
    const warnings: string[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime: fakeRuntime({ text: "provider succeeded" }),
      model,
      executionMode: "sdk",
      memoryWriteMode: "append-host-summary",
      memory: {
        load: async () => undefined,
        appendHostSummary: async () => { throw new Error("legacy path must not run"); },
        persistCompletedTurn: async () => { throw rejection; },
      },
      onMemoryWarning: (message) => warnings.push(message),
    });

    const response = await harness.run(request(`conv-${_label}`));

    expect(response.text).toBe("provider succeeded");
    expect(response.failure).toBeUndefined();
    expect(warnings).toEqual([
      "Memory persistence was not confirmed after the provider answer; the provider response was preserved.",
    ]);
  });

  it("loads skills through the injected skills cache on every turn", async () => {
    const identityPath = await identityFixture();
    let calls = 0;
    const skillsCache: SkillsCache = {
      loadSelectedSkillsCached: async () => {
        calls += 1;
        return { index: [], instructions: [], loaded: [] };
      },
      clear: () => {},
    };

    const harness = createAgentHarness({
      identityPath,
      runtime: fakeRuntime(),
      model,
      executionMode: "sdk",
      skillsRoot: "/skills-root",
      selectedSkills: ["alpha"],
      skillsCache,
    });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));

    // loadSkills delegates to the cache (which dedupes disk reads internally).
    expect(calls).toBe(2);
  });
});

/**
 * Regression for the bug where the bujo memory LLM executed on the CHANNEL
 * runtime model instead of `config.memory.llm.model`.
 *
 * Root cause: createConfiguredMemory reused the channel runtime — which carries
 * the channel fallback chain (primary = config.runtime.model) — for the memory
 * LLM. The agent-runtime fallback router overrides each run's per-call `model`
 * with the chain's primary entry, so memory capture silently ran on
 * config.runtime.model. The fix gives the memory LLM its OWN fallback-free
 * runtime so the per-call memory model is the sole/effective primary.
 *
 * The runtime-adapter is mocked at module scope (mirrors agent-host-fallback /
 * agent-host-runtime-auth) so we can observe the OPTIONS createMonoRuntime is
 * built with AND capture the `model` reaching each `runtime.run`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";

const runCalls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
const fakeRuntime = {
  async run(systemPrompt: string, options: RuntimeRunOptions) {
    runCalls.push({ systemPrompt, options });
    // Empty JSON extraction so capture short-circuits without further work.
    return { text: "[]" };
  },
};
const createMonoRuntimeMock = vi.fn((_options: unknown) => fakeRuntime);

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  return {
    ...actual,
    createMonoRuntime: (options: unknown) => createMonoRuntimeMock(options),
  };
});

const { createConfiguredMemory } = await import("../index.js");

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-memory-model-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  runCalls.length = 0;
  createMonoRuntimeMock.mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RUNTIME_MODEL = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const FALLBACK_MODEL = { sdk: "pi", provider: "opencode-go", model: "kimi-k2.6", reference: "pi:opencode-go:kimi-k2.6" } as const;
const MEMORY_MODEL_REF = "pi:opencode-go:deepseek-v4-pro";

describe("memory LLM honours config.memory.llm.model", () => {
  it("runs the memory LLM on config.memory.llm.model even when runtime.model differs and fallbackModels is non-empty", async () => {
    const dir = await tempDir();

    const store = await createConfiguredMemory(memoryModelConfig(dir), {}) as unknown as {
      capture(conversationId: string, text: string): Promise<unknown>;
      close(): Promise<void>;
    };

    await store.capture("conv-1", "Morgan prefers the configured memory model.");
    await store.close();

    // The memory LLM must have actually run.
    expect(runCalls.length).toBeGreaterThanOrEqual(1);

    // Every memory run targets the configured memory model — NOT the runtime
    // model and NOT the fallback model. This is the core regression assertion.
    for (const call of runCalls) {
      expect(call.options.model).toMatchObject({ sdk: "pi", provider: "opencode-go", model: "deepseek-v4-pro" });
      expect(call.options.model).not.toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });
    }

    // The memory LLM's runtime was built WITHOUT a fallback chain, so the
    // per-call memory model is the sole/effective primary (a fallback chain would
    // let the router override `model` with the channel primary again).
    const memoryRuntimeOptions = createMonoRuntimeMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(memoryRuntimeOptions.length).toBeGreaterThanOrEqual(1);
    for (const options of memoryRuntimeOptions) {
      expect(options.fallbackChain).toBeUndefined();
    }
  });
});

function memoryModelConfig(dir: string): MonoAgentConfig {
  return {
    runtime: {
      model: { ...RUNTIME_MODEL },
      fallbackModels: [{ ...FALLBACK_MODEL }],
      executionMode: "sdk",
      maxTurns: 4,
      workspace: dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: join(dir, "IDENTITY.md"), selectedSkills: [] },
    memory: {
      mode: "bujo",
      path: join(dir, "bujo-memory"),
      writeMode: "disabled",
      maxBytes: 8_000,
      embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      llm: { provider: "agent-host", model: MEMORY_MODEL_REF, executionMode: "sdk" },
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: {
      dir: join(dir, "artifacts"),
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: { registryDir: join(dir, "trace-sources") },
  };
}

/**
 * Verifies createConfiguredMemory wires memory.mode "bujo" to a BujoMemoryStore
 * (and NOT the markdown fallback). Hermetic: the host-branch test only constructs
 * the harness (no embedding/network at construction); the direct-store tests inject
 * a fake embeddings provider so no Ollama call is made.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "@mono-agent/memory/search";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunSummary,
} from "@mono-agent/observability";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";

import { createConfiguredAgentHarness, createConfiguredMemory } from "../index.js";

/** Deterministic non-zero fake embeddings — no network. */
const fakeEmbeddings: EmbeddingProvider = {
  id: "fake",
  embed: async (texts) => texts.map(() => Array.from({ length: 768 }, () => 0.01)),
};

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-bujo-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createConfiguredMemory — bujo mode", () => {
  it("rejects a programmatic bujo config without its required capture LLM", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");

    const fakeRuntime = { async run() { return { text: "ok" }; } };
    await expect(createConfiguredAgentHarness({
      config: bujoConfig({ dir, identityPath, memoryRoot: join(dir, "bujo-memory") }),
      runtime: fakeRuntime as never,
    })).rejects.toThrow(/requires memory\.embeddings and memory\.llm/i);
  });

  it("BujoMemoryStore.appendHostSummary writes into <root>/daily/ (proves bujo, not markdown)", async () => {
    const dir = await tempDir();
    const memoryRoot = join(dir, "bujo-memory");
    const store = createBujoMemoryStore({ root: memoryRoot, embeddings: fakeEmbeddings, dim: 768 });
    await store.appendHostSummary("conv-1", "A summary of this turn.");
    await store.close();

    const files = await readdir(join(memoryRoot, "daily"));
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/u);
  });

  it("BujoMemoryStore exposes load, appendHostSummary, and capture (full contract)", async () => {
    const dir = await tempDir();

    const bujoStore = createBujoMemoryStore({ root: join(dir, "bujo-memory"), embeddings: fakeEmbeddings, dim: 768 });

    expect(typeof bujoStore.load).toBe("function");
    expect(typeof bujoStore.appendHostSummary).toBe("function");
    expect(typeof bujoStore.capture).toBe("function");
    await bujoStore.close();
  });

  it("lite-tier BujoMemoryStore (no embeddings) exposes the same contract, capture returns undefined", async () => {
    const dir = await tempDir();

    // lite tier: no embeddings — FTS only
    const liteStore = createBujoMemoryStore({ root: join(dir, "lite-memory") });

    expect(typeof liteStore.load).toBe("function");
    expect(typeof liteStore.appendHostSummary).toBe("function");
    // capture with no LLM returns undefined (not throws)
    const result = await liteStore.capture("conv-1", "summary text");
    expect(result).toBeUndefined();
    await liteStore.close();
  });

  it("keeps bujo tier when memory.llm uses an agent-host runtime model", async () => {
    const dir = await tempDir();
    const runtime = createRecordingRuntime();
    const store = await createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "agent-host-memory"),
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
      }),
      { memoryRuntime: runtime },
    );

    expect(store).toBeDefined();
    expect((store as unknown as { tier(): string }).tier()).toBe("bujo");
    await (store as unknown as { close(): Promise<void> }).close();
  });

  it("runs agent-host memory LLM calls without tools or MCP servers", async () => {
    const dir = await tempDir();
    const runtime = createRecordingRuntime();
    const store = await createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "agent-host-memory"),
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
      }),
      { memoryRuntime: runtime },
    );

    const result = await (store as unknown as { capture(conversationId: string, text: string): Promise<unknown> })
      .capture("conv-1", "Morgan prefers agent-host memory LLM calls.");

    expect(result).toEqual({ actions: 0, entities: 0 });
    expect(runtime.calls).toHaveLength(1);
    for (const call of runtime.calls) {
      expect(call.systemPrompt).toMatch(/private memory maintenance LLM/u);
      expect(call.options.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
      expect(call.options.executionMode).toBe("sdk");
      expect(call.options.cwd).toBe(dir);
      expect(call.options.maxTurns).toBe(1);
      expect(call.options.allowedTools).toEqual([]);
      expect(call.options.disallowedTools).toEqual([]);
      expect(call.options.mcpServers).toEqual({});
    }
    await (store as unknown as { close(): Promise<void> }).close();
  });

  it("rejects CLI-backed agent-host memory LLM configs", async () => {
    const dir = await tempDir();
    await expect(
      createConfiguredMemory(
        bujoConfig({
          dir,
          identityPath: join(dir, "IDENTITY.md"),
          memoryRoot: join(dir, "agent-host-memory"),
          llm: {
            provider: "agent-host",
            model: "codex:gpt-5.5",
          },
        }),
        { memoryRuntime: createRecordingRuntime() },
      ),
    ).rejects.toThrow(/SDK execution mode only/u);
  });

  it("uses LM Studio embeddings at runtime without involving the BuJo chat LLM provider", async () => {
    const dir = await tempDir();
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = createRecordingRuntime();
    const store = await createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "lm-studio-memory"),
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          endpoint: "http://localhost:1234",
          dim: 4,
        },
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
      }),
      { memoryRuntime: runtime },
    );

    await (store as unknown as { load(conversationId: string, query: string): Promise<unknown> })
      .load("conv-1", "remember the provider");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toMatch(/Authorization|11434|ollama/iu);
    expect(runtime.calls).toHaveLength(0);
    await (store as unknown as { close(): Promise<void> }).close();
  });

  it("fails managed memory when its declared embedding credential is unresolved", async () => {
    const dir = await tempDir();

    await expect(createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "lm-studio-memory"),
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          apiKeyEnv: "LM_STUDIO_API_KEY",
          dim: 4,
        },
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
        },
      }),
      { memoryRuntime: createRecordingRuntime() },
    )).rejects.toThrow(/LM_STUDIO_API_KEY.*no resolved value/iu);
  });
});

describe("createConfiguredMemory — memory LLM tracing", () => {
  const agentHostLlm: NonNullable<MonoAgentConfig["memory"]>["llm"] = {
    provider: "agent-host",
    model: "pi:openai-codex:gpt-5.5",
    executionMode: "sdk",
  };

  it("records each memory LLM call as a mem-* run with a per-ritual conversation id", async () => {
    const dir = await tempDir();
    const store = await createConfiguredMemory(
      bujoConfig({ dir, identityPath: join(dir, "IDENTITY.md"), memoryRoot: join(dir, "m"), llm: agentHostLlm }),
      { memoryRuntime: createRecordingRuntime(), observability: { observabilityContext: { sourceId: "s1", sourceLabel: "Test" } } },
    ) as unknown as CapturableStore;

    await store.capture("conv-1", "Morgan prefers agent-host memory LLM calls.");
    await store.close();

    expect(await readSummaries(join(dir, "artifacts"))).toHaveLength(0);
    const summaries = await readSummaries(join(dir, "artifacts", "memory"));
    expect(summaries).toHaveLength(1);
    for (const s of summaries) {
      expect(s.runId).toMatch(/^mem-/u);
      expect(s.status).toBe("succeeded");
      expect(s.conversationId).toMatch(/^memory:/u);
    }
    const convs = summaries.map((s) => s.conversationId);
    expect(convs).toEqual(["memory:capture:extract"]);
  });

  it("tags every memory run's summary with source 'memory' and sourceDetail = the operation", async () => {
    const dir = await tempDir();
    const store = await createConfiguredMemory(
      bujoConfig({ dir, identityPath: join(dir, "IDENTITY.md"), memoryRoot: join(dir, "m"), llm: agentHostLlm }),
      { memoryRuntime: createRecordingRuntime(), observability: { observabilityContext: { sourceId: "s1", sourceLabel: "Test" } } },
    ) as unknown as CapturableStore;

    await store.capture("conv-1", "Morgan prefers agent-host memory LLM calls.");
    await store.close();

    expect(await readSummaries(join(dir, "artifacts"))).toHaveLength(0);
    const summaries = await readSummaries(join(dir, "artifacts", "memory"));
    expect(summaries).toHaveLength(1);
    expect(summaries.every((s) => s.source === "memory")).toBe(true);
    const extract = summaries.find((s) => s.conversationId === "memory:capture:extract");
    expect(extract?.sourceDetail).toBe("extract");
  });

  it("exports memory runs through the configured exporter", async () => {
    const dir = await tempDir();
    const spy = createSpyExporter();
    const store = await createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "m"),
        llm: agentHostLlm,
        observabilityExporters: [{ type: "phoenix" }],
      }),
      {
        memoryRuntime: createRecordingRuntime(),
        observability: { observabilityContext: { sourceId: "s1" }, exporterFactory: () => spy.exporter },
      },
    ) as unknown as CapturableStore;

    await store.capture("conv-1", "some text");
    await store.close();

    expect(spy.finished).toHaveLength(1);
    expect(spy.finished.map((s) => s.conversationId)).toContain("memory:capture:extract");
    // Every memory run is tagged as a "memory" kind, and the extract run carries
    // its operation — these drive the Phoenix span kind + memory.operation attribute.
    expect(spy.contexts.every((c) => c.runKind === "memory")).toBe(true);
    const extract = spy.contexts.find((c) => c.conversationId === "memory:capture:extract");
    expect(extract?.memoryOperation).toBe("extract");
  });

  it("reports a memory LLM timeout distinctly from a cancellation (provider too slow/unavailable)", async () => {
    // Regression for the audit's dominant memory symptom: a dead/slow provider tripped the memory
    // LLM's 60s timeout, which the runtime reports as `cancelled`. The error must now say "timed out"
    // (with a provider hint) rather than the misleading "run was cancelled".
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const store = await createConfiguredMemory(
        bujoConfig({ dir, identityPath: join(dir, "IDENTITY.md"), memoryRoot: join(dir, "m"), llm: agentHostLlm }),
        { memoryRuntime: createAbortAwareRuntime() },
      ) as unknown as CapturableStore;

      const expectation = expect(store.capture("conv-1", "text")).rejects.toThrow(
        /timed out after 60000ms \(provider too slow or unavailable\)/u,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
      await store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed run AND rethrows when the memory LLM fails", async () => {
    const dir = await tempDir();
    const store = await createConfiguredMemory(
      bujoConfig({ dir, identityPath: join(dir, "IDENTITY.md"), memoryRoot: join(dir, "m"), llm: agentHostLlm }),
      { memoryRuntime: createFailingRuntime(), observability: { observabilityContext: { sourceId: "s1" } } },
    ) as unknown as CapturableStore;

    await expect(store.capture("conv-1", "text")).rejects.toThrow();
    await store.close();

    const summaries = await readSummaries(join(dir, "artifacts", "memory"));
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries.some((s) => s.status === "failed")).toBe(true);
  });

  it("stays a bare, unrecorded run when no observability deps are threaded", async () => {
    const dir = await tempDir();
    const runtime = createRecordingRuntime();
    const store = await createConfiguredMemory(
      bujoConfig({ dir, identityPath: join(dir, "IDENTITY.md"), memoryRoot: join(dir, "m"), llm: agentHostLlm }),
      { memoryRuntime: runtime },
    ) as unknown as CapturableStore;

    await store.capture("conv-1", "text");
    await store.close();

    expect(runtime.calls).toHaveLength(1);
    for (const call of runtime.calls) {
      expect("onEvent" in call.options).toBe(false);
    }
    expect(await readSummaries(join(dir, "artifacts"))).toHaveLength(0);
  });

  it("stays bare when memory.llm.trace is false even with observability threaded", async () => {
    const dir = await tempDir();
    const runtime = createRecordingRuntime();
    const store = await createConfiguredMemory(
      bujoConfig({
        dir,
        identityPath: join(dir, "IDENTITY.md"),
        memoryRoot: join(dir, "m"),
        llm: { ...agentHostLlm, trace: false },
      }),
      { memoryRuntime: runtime, observability: { observabilityContext: { sourceId: "s1" } } },
    ) as unknown as CapturableStore;

    await store.capture("conv-1", "text");
    await store.close();

    for (const call of runtime.calls) {
      expect("onEvent" in call.options).toBe(false);
    }
    expect(await readSummaries(join(dir, "artifacts"))).toHaveLength(0);
  });
});

type CapturableStore = {
  capture(conversationId: string, text: string): Promise<unknown>;
  close(): Promise<void>;
};

async function readSummaries(artifactsDir: string): Promise<RunSummary[]> {
  let files: string[];
  try {
    files = await readdir(artifactsDir);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const file of files) {
    if (file.endsWith(".summary.json")) {
      summaries.push(JSON.parse(await readFile(join(artifactsDir, file), "utf8")) as RunSummary);
    }
  }
  return summaries;
}

function createSpyExporter(): {
  exporter: RunExporter;
  finished: RunSummary[];
  contexts: RunExportContext[];
} {
  const finished: RunSummary[] = [];
  const contexts: RunExportContext[] = [];
  const exporter: RunExporter = {
    finish(summary: RunSummary, context: RunExportContext) {
      finished.push(summary);
      contexts.push(context);
    },
  };
  return { exporter, finished, contexts };
}

function bujoConfig(input: {
  readonly dir: string;
  readonly identityPath: string;
  readonly memoryRoot: string;
  readonly embeddings?: NonNullable<MonoAgentConfig["memory"]>["embeddings"];
  readonly llm?: NonNullable<MonoAgentConfig["memory"]>["llm"];
  readonly observabilityExporters?: readonly PhoenixExporterConfig[];
}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: input.identityPath, selectedSkills: [] },
    memory: {
      mode: "bujo",
      path: input.memoryRoot,
      writeMode: "disabled",
      maxBytes: 8_000,
      embeddings: input.embeddings ?? { provider: "ollama", model: "nomic-embed-text:v1.5" },
      ...(input.llm === undefined ? {} : { llm: input.llm }),
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: {
      dir: join(input.dir, "artifacts"),
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: { registryDir: join(input.dir, "trace-sources") },
    ...(input.observabilityExporters === undefined
      ? {}
      : { observability: { exporters: input.observabilityExporters } }),
  };
}

function createRecordingRuntime() {
  const calls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    async run(systemPrompt: string, options: RuntimeRunOptions) {
      calls.push({ systemPrompt, options });
      return { text: '{"memories":[],"entities":[],"relations":[]}' };
    },
  };
}

function createFailingRuntime() {
  const calls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    async run(systemPrompt: string, options: RuntimeRunOptions) {
      calls.push({ systemPrompt, options });
      return { failureKind: "provider_error", error: "boom" };
    },
  };
}

/** Hangs until its run is aborted, then resolves `cancelled` — models a slow/unavailable provider. */
function createAbortAwareRuntime() {
  const calls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    async run(systemPrompt: string, options: RuntimeRunOptions) {
      calls.push({ systemPrompt, options });
      return await new Promise<RuntimeResult>((resolve) => {
        const signal = options.abortSignal;
        if (signal?.aborted === true) {
          resolve({ cancelled: true });
          return;
        }
        signal?.addEventListener("abort", () => { resolve({ cancelled: true }); });
      });
    },
  };
}

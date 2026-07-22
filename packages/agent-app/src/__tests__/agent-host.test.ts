import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";
import type { MemoryStore } from "@mono-agent/agent-contracts";
import { createPhoenixRunExporter } from "@mono-agent/observability/otel";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import type { EmbeddingProvider } from "@mono-agent/memory/search";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { createSandboxPolicy } from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";
import {
  createToolPolicy,
  type ConversationHistoryStore,
  type HistoryMessage,
} from "@mono-agent/agent-harness";

/** Deterministic non-zero fake embeddings (dim 64) — keeps journal/bujo-tier tests hermetic (no Ollama). */
const fakeEmbeddings: EmbeddingProvider = {
  id: "fake",
  embed: async (texts) => texts.map(() => Array.from({ length: 64 }, () => 0.01)),
};

const fakeSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return true;
  },
  async prepareCommand() {
    throw new Error("not used by host composition tests");
  },
};

import {
  createConfiguredAgentHarness,
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
  createConfiguredMemory,
} from "../index.js";
import { createConfiguredAgentResponderForApp } from "../configured-agent.js";
import {
  CONFIGURATION_PROPOSAL_MCP_SERVER_NAME,
  CONFIGURATION_PROPOSAL_TOOL_NAME,
  configurationProposalMcpServerSpec,
} from "../configuration-proposal-tool.js";
import { isNotifyDestinationConversationId } from "../notify-destinations.js";
import { createSeenNotifyDestinationCache } from "../seen-conversations.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent host composition helpers", () => {
  it("creates a responder from MonoAgentConfig with runtime, tools, local providers, request extensions, and recording", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "streamed " }] } });
      return {
        text: "Final answer",
        model: options.model.model,
        sdk: options.model.sdk,
        capabilitiesUsed: ["agent-host"],
        cost: { totalUsd: 0 },
      };
    });

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        compaction: {
          enabled: true,
          triggerRatio: 0.75,
          keepRecentTokens: 9_000,
          summaryMaxTokens: 3_000,
          minSavingsTokens: 7_000,
          fixedOverheadEnabled: false,
          contextWindowOverride: 128_000,
        },
      }),
      runtime: fake.runtime,
      createRunId: () => "run-host",
      runtimeOptionsForRequest: ({ request, runId }) => {
        expect(request.conversationId).toBe("conversation-host");
        expect(runId).toBe("run-host");
        return {
          runtimeOptions: {
            allowedTools: ["AskCollaborator"],
            mcpServers: {
              collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
            },
          },
        };
      },
    });

    const streamText: string[] = [];
    const response = await responder.respond(
      { conversationId: "conversation-host", text: "What changed?", abortSignal: new AbortController().signal },
      { append: async (delta) => { streamText.push(delta); } },
    );

    expect(response.text).toBe("Final answer");
    expect(streamText).toEqual(["streamed "]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toContain("You are Mono.");
    expect(fake.calls[0]?.options).toMatchObject({
      cwd: dir,
      maxTurns: 4,
      allowedTools: ["Read", "AskCollaborator"],
      disallowedTools: ["Write"],
      customProvider: {
        id: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      },
      customModel: {
        provider_id: "ollama",
        model_name: "qwen3:8b",
      },
      mcpServers: {
        collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
      },
      compaction: {
        enabled: true,
        triggerRatio: 0.75,
        keepRecentTokens: 9_000,
        summaryMaxTokens: 3_000,
        minSavingsTokens: 7_000,
        fixedOverheadEnabled: false,
        contextWindowOverride: 128_000,
      },
    });

    const artifactFiles = await readdir(artifactDir);
    const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
    expect(summaryFile).toBeDefined();
    expect(await readFile(join(artifactDir, summaryFile as string), "utf8")).toContain("run-host");
  });

  it("auto-provisions MemoryRecall in direct configured responders and composes caller tools", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Configured" }));
    const base = monoConfig({ dir, identityPath, artifactDir, memoryPath: join(dir, "memory") });
    const config: MonoAgentConfig = {
      ...base,
      memory: { ...base.memory!, recallTool: { enabled: true } },
    };
    const memory = {
      async load() { return undefined; },
      async recall() { return []; },
      async appendHostSummary(conversationId: string) {
        return { conversationId, source: "test", bytesWritten: 0 };
      },
      async close() {},
    } satisfies MemoryStore & { recall(): Promise<readonly []>; close(): Promise<void> };

    const responder = await createConfiguredAgentResponder({
      config,
      runtime: fake.runtime,
      memory,
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          allowedTools: ["ProposeAgentConfiguration"],
          mcpServers: {
            configurator: { type: "http", url: "http://127.0.0.1:9876/mcp" },
          },
        },
      }),
    });

    await responder.respond(
      { conversationId: "configuration", text: "Configure yourself", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.allowedTools).toEqual(["Read", "ProposeAgentConfiguration"]);
    expect(fake.calls[0]?.options.mcpServers).toMatchObject({
      "mono-agent-memory": { type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//u) },
      configurator: { type: "http", url: "http://127.0.0.1:9876/mcp" },
    });
  });

  it("keeps local configuration authority to proposal, MemoryRecall, and ReadSkill", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    const skillsRoot = join(dir, "skills");
    const skillDir = join(skillsRoot, "mono-agent-configure");
    const mcpConfigPath = join(dir, "mcp.json");
    await mkdir(skillDir, { recursive: true });
    await writeFile(identityPath, "You are Mono.", "utf8");
    await writeFile(join(skillDir, "SKILL.md"), "# Configure\n\nInspect and propose configuration.", "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({
      allowedTools: ["*"],
      mcpServers: { configuredAction: { command: "configured-action" } },
    })}\n`, "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Configured" }));
    const base = monoConfig({
      dir,
      identityPath,
      artifactDir,
      memoryPath: join(dir, "memory"),
      skillsRoot,
      selectedSkills: ["mono-agent-configure"],
      mcpConfigPath,
    });
    const config: MonoAgentConfig = {
      ...base,
      context: { ...base.context, skillDisclosure: "index" },
      memory: { ...base.memory!, recallTool: { enabled: true } },
    };
    const memory = {
      async load() { return undefined; },
      async recall() { return []; },
      async appendHostSummary(conversationId: string) {
        return { conversationId, source: "test", bytesWritten: 0 };
      },
      async close() {},
    } satisfies MemoryStore & { recall(): Promise<readonly []>; close(): Promise<void> };
    const proposalServer = configurationProposalMcpServerSpec({
      sinkPath: join(dir, ".mono-agent", "configuration-proposal.json"),
      baseVersion: "test-version",
    }, dir);
    const allowedConfigurationTools = [
      "ReadSkill",
      "MemoryRecall",
      CONFIGURATION_PROPOSAL_TOOL_NAME,
      `mcp__${CONFIGURATION_PROPOSAL_MCP_SERVER_NAME}__${CONFIGURATION_PROPOSAL_TOOL_NAME}`,
    ];

    const responder = await createConfiguredAgentResponder({
      config,
      runtime: fake.runtime,
      memory,
      runtimeOptions: {
        allowedTools: ["Write"],
        mcpServers: { staticAction: { command: "static-action" } },
      },
      runtimeOptionsForRequest: () => ({
        toolPolicyOverride: createToolPolicy({
          allowedTools: allowedConfigurationTools,
          disallowedTools: [],
          mcpServers: {
            [CONFIGURATION_PROPOSAL_MCP_SERVER_NAME]: proposalServer,
          },
        }),
        runtimeOptions: {
          permissionMode: "plan",
          // These hostile tool-shaped fields exercise the harness's
          // authoritative-override stripping rather than the happy path alone.
          allowedTools: ["Bash", "Write", "Edit"],
          mcpServers: { requestAction: { command: "request-action" } },
        },
      }),
    });

    await responder.respond(
      {
        conversationId: "configuration",
        text: "Configure yourself",
        abortSignal: new AbortController().signal,
        metadata: { tui: { local: true, configuration: true } },
      },
      { append: async () => {} },
    );

    const options = fake.calls[0]?.options;
    expect(options).toMatchObject({
      allowedTools: allowedConfigurationTools,
      disallowedTools: [],
      permissionMode: "plan",
      skills: [{ name: "mono-agent-configure" }],
      skillsRoot,
    });
    expect(Object.keys(options?.mcpServers ?? {}).sort()).toEqual([
      CONFIGURATION_PROPOSAL_MCP_SERVER_NAME,
      "mono-agent-memory",
    ]);
    expect(options?.mcpServers).toMatchObject({
      [CONFIGURATION_PROPOSAL_MCP_SERVER_NAME]: proposalServer,
      "mono-agent-memory": {
        type: "http",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//u),
      },
    });
    expect(options?.mcpConfigPath).toBeUndefined();
    expect(options?.allowedTools).not.toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "Write", "Edit"]));
  });

  it("invalidates artifact-derived destinations at local commits without awaiting a slow exporter", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let releaseExporterStart!: () => void;
    let releaseExporterFinish!: () => void;
    const exporterStart = new Promise<void>((resolve) => { releaseExporterStart = resolve; });
    const exporterFinish = new Promise<void>((resolve) => { releaseExporterFinish = resolve; });
    const exporter: RunExporter = {
      start: async () => await exporterStart,
      finish: async () => await exporterFinish,
    };

    let scanCalls = 0;
    const cache = createSeenNotifyDestinationCache({
      scan: async () => [{ conversationId: `telegram:${++scanCalls}`, channelId: "telegram" }],
    });
    await cache.list(artifactDir);
    expect(scanCalls).toBe(1);

    let startedCommitted!: () => void;
    let finishedCommitted!: () => void;
    const started = new Promise<void>((resolve) => { startedCommitted = resolve; });
    const finished = new Promise<void>((resolve) => { finishedCommitted = resolve; });
    const responder = await createConfiguredAgentResponderForApp({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        observability: { exporters: [{ type: "phoenix", timeoutMs: 60_000 }] },
      }),
      runtime: createFakeRuntime(async () => ({ text: "Done" })).runtime,
      createRunId: () => "run-artifact-cache-boundary",
      exporterFactory: () => exporter,
    }, {
      onRunArtifactCommitted: (event) => {
        if (isNotifyDestinationConversationId(event.conversationId)) {
          cache.invalidate();
        }
        if (event.phase === "started") startedCommitted();
        else finishedCommitted();
      },
    });

    let responseSettled = false;
    const response = responder.respond(
      { conversationId: "telegram:42", text: "Run", abortSignal: new AbortController().signal },
      { append: async () => {} },
    ).finally(() => { responseSettled = true; });

    await started;
    expect(JSON.parse(await readFile(join(artifactDir, "run-artifact-cache-boundary.summary.json"), "utf8")))
      .toMatchObject({ status: "running", conversationId: "telegram:42" });
    await cache.list(artifactDir);
    expect(scanCalls).toBe(2);
    expect(responseSettled).toBe(false);

    releaseExporterStart();
    await finished;
    expect(JSON.parse(await readFile(join(artifactDir, "run-artifact-cache-boundary.summary.json"), "utf8")))
      .toMatchObject({ status: "succeeded", conversationId: "telegram:42" });
    await cache.list(artifactDir);
    expect(scanCalls).toBe(3);
    expect(responseSettled).toBe(false);

    releaseExporterFinish();
    await response;
    expect(responseSettled).toBe(true);
  });

  it("records and exports memory persistence degradation before exporter completion", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const exportOrder: string[] = [];
    const exporter: RunExporter = {
      onEvent(event): void { exportOrder.push(`event:${String(event.type)}`); },
      finish(): void { exportOrder.push("terminal"); },
    };
    const memory: MemoryStore = {
      load: async () => undefined,
      appendHostSummary: async () => { throw new Error("memory disk became read-only"); },
    };
    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        memoryPath: join(dir, "memory"),
        memoryWriteMode: "append-host-summary",
        observability: { exporters: [{ type: "phoenix" }] },
      }),
      runtime: createFakeRuntime(async () => ({ text: "Provider answer survives" })).runtime,
      memory,
      createRunId: () => "run-memory-warning-order",
      observabilityContext: { sourceId: "src-warning" },
      exporterFactory: () => exporter,
    });

    const response = await responder.respond(
      { conversationId: "telegram:warning", text: "remember this", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(response.text).toBe("Provider answer survives");
    const warningExportIndex = exportOrder.indexOf("event:runtime_warning");
    expect(warningExportIndex).toBeGreaterThanOrEqual(0);
    expect(warningExportIndex).toBeLessThan(exportOrder.indexOf("terminal"));
    const eventArtifact = await readFile(join(artifactDir, "run-memory-warning-order.events.jsonl"), "utf8");
    expect(eventArtifact).toContain("memory_persistence_degraded");
  });

  it("forwards the request-derived source/sourceDetail into the recorded run summary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Digest done" }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-cron",
    });

    await harness.run({
      conversationId: "conversation-cron",
      userMessage: "Run the nightly digest.",
      abortSignal: new AbortController().signal,
      metadata: { cron: { jobId: "nightly-digest" } },
    });

    const summary = await readSummary(artifactDir, "run-cron");
    expect(summary.source).toBe("cron");
    expect(summary.sourceDetail).toBe("nightly-digest");
  });

  it("records compound host summaries without auto-injecting ambiguous text", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Logged answer" }));

    // Inject a fake-embeddings journal-tier store so the test is hermetic (no live Ollama in CI).
    const memory = createBujoMemoryStore({ root: memoryRoot, embeddings: fakeEmbeddings, dim: 64 });
    try {
      const responder = await createConfiguredAgentResponder({
        config: monoConfig({
          dir,
          identityPath,
          memoryPath: memoryRoot,
          memoryMode: "journal",
          memoryWriteMode: "append-host-summary",
          artifactDir,
        }),
        runtime: fake.runtime,
        memory,
      });

      await responder.respond(
        { conversationId: "channel-a", text: "First message", abortSignal: new AbortController().signal },
        { append: async () => {} },
      );

      // The completed turn is appended as a bullet in today's daily file.
      const dailyFiles = await readdir(join(memoryRoot, "daily"));
      expect(dailyFiles.length).toBeGreaterThan(0);
      const todayFile = dailyFiles.find((f) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(f));
      expect(todayFile).toBeDefined();
      const dailyContent = await readFile(join(memoryRoot, "daily", todayFile!), "utf8");
      expect(dailyContent).toContain("Logged answer");

      // A compound host summary contains User/Assistant roles and is deliberately
      // outside the canonical direct-fact contract. It remains available through
      // the default-on explicit MemoryRecall endpoint instead of being injected.
      await responder.respond(
        { conversationId: "channel-b", text: "Logged answer", abortSignal: new AbortController().signal },
        { append: async () => {} },
      );
      const recalledMessage = String(fake.calls[1]?.options.messages?.[0]?.content);
      expect(recalledMessage).toBe("Logged answer");
      expect(fake.calls[1]?.prompt).not.toContain("## Memory (recalled)");
    } finally {
      await memory.close();
    }
  });

  it("runs agent-host memory LLM capture on its own runtime, never the channel runtime", async () => {
    // The memory LLM must NOT ride the channel runtime: that runtime carries the
    // channel fallback chain (primary = config.runtime.model) and the fallback
    // router overrides each run's per-call model, which would silently execute
    // memory capture on config.runtime.model instead of config.memory.llm.model.
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const memoryRoot = join(dir, "memory");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    // Channel runtime — should only ever see the channel turn (ollama), never the
    // memory model (openai-codex).
    const channel = createFakeRuntime(async () => ({ text: "Harness answer" }));
    // Dedicated memory runtime (the injection seam the production path builds for
    // itself). Captures the memory LLM calls so we can assert their shape.
    const memoryRuntime = createFakeRuntime(async () => ({ text: '{"memories":[],"entities":[],"relations":[]}' }));

    const config = monoConfig({
      dir,
      identityPath,
      memoryPath: memoryRoot,
      memoryMode: "bujo",
      memoryWriteMode: "capture",
      memoryEmbeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-test",
        endpoint: await startEmbeddingServer(),
      },
      memoryLlm: {
        provider: "agent-host",
        model: "pi:openai-codex:gpt-5.5",
        executionMode: "sdk",
      },
      artifactDir,
    });
    const memory = await createConfiguredMemory(config, { memoryRuntime: memoryRuntime.runtime });
    try {
      const responder = await createConfiguredAgentResponder({
        config,
        runtime: channel.runtime,
        ...(memory === undefined ? {} : { memory }),
      });

      const response = await responder.respond({
        conversationId: "channel-a",
        text: "Remember that memory capture must use its own runtime.",
        abortSignal: new AbortController().signal,
      }, { append: async () => {} });

      expect(response.text).toBe("Harness answer");
      for (let i = 0; i < 20 && memoryRuntime.calls.length < 1; i += 1) {
        await delay(5);
      }

      // The channel runtime served the channel turn only — the memory model never
      // leaked onto it.
      expect(channel.calls.every((call) => call.options.model.provider !== "openai-codex")).toBe(true);

      // The memory LLM ran on its own runtime, with the configured memory model and
      // the locked-down per-call shape.
      expect(memoryRuntime.calls).toHaveLength(1);
      for (const call of memoryRuntime.calls) {
        expect(call.options.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
        expect(call.options.allowedTools).toEqual([]);
        expect(call.options.disallowedTools).toEqual([]);
        expect(call.options.mcpServers).toEqual({});
        expect(call.options.maxTurns).toBe(1);
      }
    } finally {
      await (memory as unknown as { close(): Promise<void> }).close();
    }
  });

  it("caps selected skill bodies at context.skillMaxBytes", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "big"), { recursive: true });
    await writeFile(
      join(skillsRoot, "big", "SKILL.md"),
      `Big skill description.\n\n${"filler ".repeat(64)}SKILL_TAIL_MARKER`,
      "utf8",
    );
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const uncapped = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, skillsRoot, selectedSkills: ["big"], artifactDir }),
      runtime: fake.runtime,
    });
    await uncapped.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[0]?.prompt).toContain("SKILL_TAIL_MARKER");

    const capped = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, skillsRoot, selectedSkills: ["big"], skillMaxBytes: 256, artifactDir }),
      runtime: fake.runtime,
    });
    await capped.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.prompt).not.toContain("SKILL_TAIL_MARKER");
  });

  it("fails closed when tools.mcpConfigPath points at a missing file", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    await expect(
      createConfiguredAgentHarness({
        config: monoConfig({ dir, identityPath, artifactDir, mcpConfigPath: join(dir, "missing.json") }),
        runtime: fake.runtime,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "tool_policy_read_failed" }));
  });

  it("forwards runtime.permissionMode to the runtime and never sets a reasoning-summary option", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        permissionMode: "bypassPermissions",
      }),
      runtime: fake.runtime,
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.permissionMode).toBe("bypassPermissions");
    // The retired reasoning-summary knob is gone: pi-native derives reasoning from
    // effort and the codex/claude CLIs emit summaries themselves.
    expect(fake.calls[0]?.options.piReasoningSummary).toBeUndefined();
  });

  it("forwards tools.mcpCall*TimeoutMs to the runtime as agent settings, omitting settings when unset", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const configured = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        mcpCallTimeoutMs: 60_000,
        mcpCallMaxTotalTimeoutMs: 900_000,
      }),
      runtime: fake.runtime,
    });
    await configured.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[0]?.options.settings).toMatchObject({
      agent_mcp_call_timeout_ms: 60_000,
      agent_mcp_call_max_total_timeout_ms: 900_000,
    });

    // Unset timeouts must not materialize a settings object — the runtime's own
    // defaults (120s inactivity / 45 min total) apply.
    const plain = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });
    await plain.respond(
      { conversationId: "c2", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    expect(fake.calls[1]?.options.settings).toBeUndefined();
  });

  it("bounds in-flight runs at concurrency.maxConcurrentRuns", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const fake = createFakeRuntime(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { release.push(resolve); });
      active -= 1;
      return { text: "ok" };
    });

    const harness = await createConfiguredAgentHarness({
      config: { ...monoConfig({ dir, identityPath, artifactDir }), concurrency: { maxConcurrentRuns: 1 } },
      runtime: fake.runtime,
    });

    const first = harness.run({ conversationId: "c1", userMessage: "a", abortSignal: new AbortController().signal });
    const second = harness.run({ conversationId: "c2", userMessage: "b", abortSignal: new AbortController().signal });

    // Let the limiter settle: only one run should be in-flight.
    for (let i = 0; i < 20 && release.length < 1; i += 1) {
      await delay(5);
    }
    expect(release.length).toBe(1);
    release.shift()?.();
    for (let i = 0; i < 20 && release.length < 1; i += 1) {
      await delay(5);
    }
    release.shift()?.();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it("threads concurrency.maxPendingRuns from config so over-capacity runs fail fast", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");

    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const release: Array<() => void> = [];
    let calls = 0;
    const fake = createFakeRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        started();
      }
      await new Promise<void>((resolve) => { release.push(resolve); });
      return { text: "ok" };
    });

    // maxPendingRuns is config-only plumbing: if it were not threaded into the
    // harness, the third run would not fail fast.
    const harness = await createConfiguredAgentHarness({
      config: { ...monoConfig({ dir, identityPath, artifactDir }), concurrency: { maxConcurrentRuns: 1, maxPendingRuns: 1 } },
      runtime: fake.runtime,
    });

    // First admits and runs (holds the only provider slot).
    const first = harness.run({ conversationId: "c1", userMessage: "a", abortSignal: new AbortController().signal });
    await firstStarted;
    // Second admits but parks waiting for the slot (pending = 1).
    const second = harness.run({ conversationId: "c2", userMessage: "b", abortSignal: new AbortController().signal });
    await delay(10);
    // Third arrives at capacity -> fails fast.
    const third = await harness.run({ conversationId: "c3", userMessage: "c", abortSignal: new AbortController().signal });

    expect(third.failure?.kind).toBe("capacity_exceeded");
    expect(calls).toBe(1);

    // Drain.
    for (const fn of release.splice(0)) { fn(); }
    await first;
    for (let i = 0; i < 20 && release.length < 1; i += 1) { await delay(5); }
    for (const fn of release.splice(0)) { fn(); }
    await second;
  });

  it("trips the embeddings circuit breaker at the configured failureThreshold", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    const memoryRoot = join(dir, "memory");
    await writeFile(identityPath, "You are Mono.", "utf8");

    // A counting embeddings server that always errors. With failureThreshold 1 the breaker
    // trips OPEN after the first failure, so the second recall must NOT reach the server.
    let requests = 0;
    const endpoint = await startFailingEmbeddingServer(() => { requests += 1; });

    const memory = await createConfiguredMemory({
      ...monoConfig({
        dir,
        identityPath,
        artifactDir,
        memoryPath: memoryRoot,
        memoryMode: "journal",
        memoryEmbeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test", endpoint },
      }),
      memory: {
        mode: "journal",
        path: memoryRoot,
        maxBytes: 64_000,
        writeMode: "disabled",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-test",
          endpoint,
          timeoutMs: 1000,
          circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        },
      },
    } as MonoAgentConfig);

    try {
      // First load drives an embedding request that fails and trips the breaker.
      await expect(memory!.load("conv")).rejects.toThrow();
      expect(requests).toBe(1);
      // Second load fast-fails on the OPEN breaker without hitting the server again.
      await expect(memory!.load("conv")).rejects.toThrow();
      expect(requests).toBe(1);
    } finally {
      await (memory as unknown as { close(): Promise<void> }).close();
    }
  });

  it("lets host runtimeOptions override config runtime flags", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, permissionMode: "acceptEdits" }),
      runtime: fake.runtime,
      runtimeOptions: { permissionMode: "bypassPermissions" },
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.permissionMode).toBe("bypassPermissions");
  });

  it("keeps the configured Pi transport authoritative over request extensions", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const base = monoConfig({ dir, identityPath, artifactDir });

    const responder = await createConfiguredAgentResponder({
      config: {
        ...base,
        providers: { ...base.providers, piNative: { transport: "sse" } },
      },
      runtime: fake.runtime,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { piTransport: "websocket" } }),
    });
    await responder.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(fake.calls[0]?.options.piTransport).toBe("sse");
  });

  it("creates a configured harness when a host wants to wrap the responder itself", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Harness answer" }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      createRunId: () => "run-harness",
    });

    const response = await harness.run({
      conversationId: "conversation-harness",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Harness answer");
    expect(fake.calls[0]?.options.maxTurns).toBe(4);
  });

  it("omits maxTurns from runtime options when the config leaves it unlimited", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Unlimited answer" }));
    const config = monoConfig({ dir, identityPath, artifactDir });
    const { maxTurns: _maxTurns, ...runtime } = config.runtime;

    const harness = await createConfiguredAgentHarness({
      config: { ...config, runtime } as MonoAgentConfig,
      runtime: fake.runtime,
    });

    const response = await harness.run({
      conversationId: "conversation-unlimited",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Unlimited answer");
    expect(fake.calls[0]?.options.maxTurns).toBeUndefined();
  });

  it("restarts with the default 64-message durable history when maxTurns is unlimited", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const config = monoConfig({ dir, identityPath, artifactDir });
    const { maxTurns: _maxTurns, ...unlimitedRuntime } = config.runtime;
    const unlimitedConfig = { ...config, runtime: unlimitedRuntime } as MonoAgentConfig;
    let turn = 0;
    const firstRuntime = createFakeRuntime(async () => ({ text: `answer-${++turn}` }));
    const firstHarness = await createConfiguredAgentHarness({ config: unlimitedConfig, runtime: firstRuntime.runtime });

    for (let index = 1; index <= 7; index += 1) {
      await firstHarness.run({
        conversationId: "conversation-restart",
        userMessage: `question-${index}`,
        abortSignal: new AbortController().signal,
      });
    }

    const restartedRuntime = createFakeRuntime(async () => ({ text: "answer-after-restart" }));
    const restartedHarness = await createConfiguredAgentHarness({
      config: unlimitedConfig,
      runtime: restartedRuntime.runtime,
    });
    await restartedHarness.run({
      conversationId: "conversation-restart",
      userMessage: "question-after-restart",
      abortSignal: new AbortController().signal,
    });

    expect(restartedRuntime.calls[0]?.options.maxTurns).toBeUndefined();
    expect(restartedRuntime.calls[0]?.prompt).toContain("question-1");
    expect(restartedRuntime.calls[0]?.prompt).toContain("answer-1");
    const historyEntries = await readdir(join(dir, ".mono-agent", "history"));
    expect(historyEntries.filter((name) => name.endsWith(".history.json"))).toHaveLength(1);
    expect(historyEntries).toContain(".locks");
  });

  it("recreates a Telegram-like stateless responder with the first turn replayed exactly once", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const base = monoConfig({ dir, identityPath, artifactDir });
    const config: MonoAgentConfig = {
      ...base,
      runtime: {
        ...base.runtime,
        maxTurns: 0,
        fallbackModels: [{
          sdk: "opencode",
          provider: "github-copilot",
          model: "gpt-5.1",
          reference: "opencode:github-copilot:gpt-5.1",
        }],
        session: {
          mode: "continuous",
          idleTimeoutMs: 60_000,
          rollover: "daily",
          rolloverTimezone: "UTC",
        },
      },
      tools: { allowedTools: ["*"], disallowedTools: [] },
    };
    const now = () => new Date("2026-07-17T12:00:00Z");
    const firstRuntime = createFakeRuntime(async () => ({
      text: "FIRST_ASSISTANT_REPLAY_MARKER",
      providerSessionId: "must-not-resume",
    }));
    const firstResponder = await createConfiguredAgentResponder({ config, runtime: firstRuntime.runtime, now });
    await firstResponder.respond(
      {
        conversationId: "telegram:42",
        text: "FIRST_USER_REPLAY_MARKER",
        abortSignal: new AbortController().signal,
      },
      { append: async () => {} },
    );

    const restartedRuntime = createFakeRuntime(async () => ({ text: "answer-after-restart" }));
    const restartedResponder = await createConfiguredAgentResponder({ config, runtime: restartedRuntime.runtime, now });
    await restartedResponder.respond(
      {
        conversationId: "telegram:42",
        text: "What did you send?",
        abortSignal: new AbortController().signal,
      },
      { append: async () => {} },
    );

    const secondPrompt = restartedRuntime.calls[0]?.prompt ?? "";
    expect(restartedRuntime.calls[0]?.options.sessionId).toBeUndefined();
    expect(restartedRuntime.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(secondPrompt.split("FIRST_USER_REPLAY_MARKER")).toHaveLength(2);
    expect(secondPrompt.split("FIRST_ASSISTANT_REPLAY_MARKER")).toHaveLength(2);
    expect((await readdir(join(dir, ".mono-agent", "history")))
      .filter((name) => name.endsWith(".history.json"))).toHaveLength(1);
  });

  it("continues to honor a caller-supplied conversation history store", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const persisted: HistoryMessage[] = [];
    let loads = 0;
    const historyStore: ConversationHistoryStore = {
      async load() {
        loads += 1;
        return [...persisted];
      },
      async append(_conversationId: string, messages: readonly HistoryMessage[]) {
        persisted.push(...messages);
      },
    };
    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: createFakeRuntime(async () => ({ text: "custom-store-answer" })).runtime,
      historyStore,
    });

    await harness.run({
      conversationId: "custom-store",
      userMessage: "custom-store-question",
      abortSignal: new AbortController().signal,
    });

    expect(loads).toBeGreaterThan(0);
    expect(persisted.map((message) => message.content)).toEqual([
      "custom-store-question",
      "custom-store-answer",
    ]);
    await expect(readdir(join(dir, ".mono-agent", "history"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overrides config model and executionMode when supplied at composition time", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => ({ text: "ok", model: options.model.model }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
      model: { sdk: "claude", model: "claude-opus-4-7" },
      executionMode: "stream",
    });

    await harness.run({
      conversationId: "conversation-override",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.model).toEqual({ sdk: "claude", model: "claude-opus-4-7" });
    expect(fake.calls[0]?.options.executionMode).toBe("stream");
  });

  it("falls back to config model and executionMode when no override is supplied", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (_prompt, options) => ({ text: "ok", model: options.model.model }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });

    await harness.run({
      conversationId: "conversation-fallback",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.model.sdk).toBe("pi");
    expect(fake.calls[0]?.options.executionMode).toBe("sdk");
  });

  it("creates the default Mono runtime with config workspace and artifact directory", () => {
    const config = monoConfig({
      dir: "/tmp/mono-agent-host",
      identityPath: "/tmp/mono-agent-host/IDENTITY.md",
      artifactDir: "/tmp/mono-agent-host/artifacts",
    });

    const runtime = createConfiguredAgentRuntime(config);

    expect(runtime.run).toEqual(expect.any(Function));
    expect(runtime.configureTools).toEqual(expect.any(Function));
  });

  it("passes configured sandbox policy into runtime options", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const harness = await createConfiguredAgentHarness({
      config: {
        ...monoConfig({ dir, identityPath, artifactDir }),
        sandbox: createSandboxPolicy({
          root: dir,
          network: { mode: "none" },
        }),
      },
      runtime: fake.runtime,
      sandboxEngine: fakeSandboxEngine,
    });

    await harness.run({
      conversationId: "conversation-sandbox",
      userMessage: "Hello",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.sandboxPolicy).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "none", allowlist: [] },
    });
    expect(fake.calls[0]?.options.sandboxEngine).toBe(fakeSandboxEngine);
  });

  it("forwards continuous session config so consecutive requests resume the provider session", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-host-1" }));

    const config = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...config,
        runtime: { ...config.runtime, session: { mode: "continuous", idleTimeoutMs: 60_000 } },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-session", userMessage: "first", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-session", userMessage: "second", abortSignal: new AbortController().signal });

    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-host-1");
    expect(fake.calls[1]?.options.sessionKeepAlive).toBe(true);
  });

  it("keeps OpenAI API and Telegram histories and provider sessions independent", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async (prompt) => ({
      text: prompt.includes("TELEGRAM_") ? "TELEGRAM_ANSWER" : "OPENAI_API_ANSWER",
      providerSessionId: prompt.includes("TELEGRAM_") ? "telegram-provider-session" : "openai-api-provider-session",
    }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...base,
        runtime: { ...base.runtime, session: { mode: "continuous", idleTimeoutMs: 60_000 } },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "telegram:42", userMessage: "TELEGRAM_FIRST", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "openai-api:request-1", userMessage: "OPENAI_API_FIRST", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "telegram:42", userMessage: "TELEGRAM_SECOND", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "openai-api:request-1", userMessage: "OPENAI_API_SECOND", abortSignal: new AbortController().signal });

    expect(fake.calls.map((call) => call.options.sessionId)).toEqual([
      undefined,
      undefined,
      "telegram-provider-session",
      "openai-api-provider-session",
    ]);
    const historyRoot = join(dir, ".mono-agent", "history");
    const historyFiles = (await readdir(historyRoot)).filter((name) => name.endsWith(".history.json"));
    expect(historyFiles).toHaveLength(2);
    const histories = await Promise.all(historyFiles.map((name) => readFile(join(historyRoot, name), "utf8")));
    const telegramHistory = histories.find((history) => history.includes("TELEGRAM_FIRST"));
    const openaiApiHistory = histories.find((history) => history.includes("OPENAI_API_FIRST"));
    expect(telegramHistory).toContain("TELEGRAM_SECOND");
    expect(telegramHistory).not.toContain("OPENAI_API_FIRST");
    expect(openaiApiHistory).toContain("OPENAI_API_SECOND");
    expect(openaiApiHistory).not.toContain("TELEGRAM_FIRST");
  });

  it("replays later-turn history for stateless fallbacks when maxTurns is unlimited", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let turn = 0;
    const fake = createFakeRuntime(async () => ({
      text: `answer-${++turn}`,
      providerSessionId: "pi-provider-session",
    }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...base,
        runtime: {
          ...base.runtime,
          maxTurns: 0,
          fallbackModels: [{
            sdk: "opencode",
            provider: "github-copilot",
            model: "gpt-5.1",
            reference: "opencode:github-copilot:gpt-5.1",
          }],
          session: { mode: "continuous", idleTimeoutMs: 60_000 },
        },
        tools: { allowedTools: ["*"], disallowedTools: [] },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-mixed", userMessage: "first question", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-mixed", userMessage: "second question", abortSignal: new AbortController().signal });

    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.providerSessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
    expect(fake.calls[1]?.prompt).toContain("Conversation History");
    expect(fake.calls[1]?.prompt).toContain("first question");
    expect(fake.calls[1]?.prompt).toContain("answer-1");
  });

  it("keeps canonical fallback routes stateless even when every route supports resume", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let turn = 0;
    const fake = createFakeRuntime(async () => ({
      text: `answer-${++turn}`,
      providerSessionId: "resumable-provider-session",
    }));
    const base = monoConfig({ dir, identityPath, artifactDir });
    const harness = await createConfiguredAgentHarness({
      config: {
        ...base,
        runtime: {
          ...base.runtime,
          fallbacks: [{
            model: {
              sdk: "claude",
              model: "claude-sonnet-4-6",
              reference: "claude:claude-sonnet-4-6",
            },
          }],
          session: { mode: "continuous", idleTimeoutMs: 60_000 },
        },
      },
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-canonical", userMessage: "first", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-canonical", userMessage: "second", abortSignal: new AbortController().signal });

    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.providerSessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
    expect(fake.calls[1]?.prompt).toContain("first");
    expect(fake.calls[1]?.prompt).toContain("answer-1");
  });

  it("never passes session keys in per-message mode", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-host-1" }));

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir }),
      runtime: fake.runtime,
    });

    await harness.run({ conversationId: "conv-per-message", userMessage: "first", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "conv-per-message", userMessage: "second", abortSignal: new AbortController().signal });

    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
  });
});

describe("agent host phoenix exporter wiring", () => {
  function phoenixObservability(
    overrides: Partial<PhoenixExporterConfig> = {},
  ): NonNullable<MonoAgentConfig["observability"]> {
    return {
      exporters: [
        {
          type: "phoenix",
          endpoint: "http://127.0.0.1:6006/v1/traces",
          ...overrides,
        },
      ],
    };
  }

  it("still produces a response and writes JSONL artifacts when the exporter throws in every phase", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    const failing: RunExporter = {
      start: () => { throw new Error("start boom"); },
      onEvent: () => { throw new Error("onEvent boom"); },
      finish: () => { throw new Error("finish boom"); },
      fail: () => { throw new Error("fail boom"); },
    };
    const warnings: Array<{ phase: string; message: string }> = [];

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability() }),
      runtime: fake.runtime,
      createRunId: () => "run-failing-exporter",
      exporterFactory: () => failing,
      exporterWarn: (warning) => { warnings.push(warning); },
    });

    const response = await responder.respond(
      { conversationId: "conv-exporter", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    // Run outcome is unchanged by the failing exporter.
    expect(response.text).toBe("Final answer");

    // JSONL artifacts are written byte-for-byte as without an exporter.
    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-failing-exporter.summary.json");
    expect(artifactFiles).toContain("run-failing-exporter.events.jsonl");
    expect(await readFile(join(artifactDir, "run-failing-exporter.summary.json"), "utf8")).toContain(
      "run-failing-exporter",
    );

    // Exporter failures surface only as best-effort warnings.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.map((w) => w.message).join(" ")).toContain("boom");
  });

  it("a hanging exporter resolves within the bounded timeout and warns instead of stalling the run", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    // start/finish never resolve — the composite's bounded timeout must win.
    const hanging: RunExporter = {
      start: () => new Promise<void>(() => {}),
      finish: () => new Promise<void>(() => {}),
    };
    const warnings: Array<{ phase: string; message: string }> = [];

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability({ timeoutMs: 25 }) }),
      runtime: fake.runtime,
      createRunId: () => "run-hanging-exporter",
      exporterFactory: () => hanging,
      exporterWarn: (warning) => { warnings.push(warning); },
    });

    const started = Date.now();
    const response = await responder.respond(
      { conversationId: "conv-hang", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );
    const elapsed = Date.now() - started;

    expect(response.text).toBe("Final answer");
    // The bounded timeout (25ms) keeps the run from hanging; allow generous slack.
    expect(elapsed).toBeLessThan(5_000);
    expect(warnings.some((w) => /timed out/u.test(w.message))).toBe(true);

    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-hanging-exporter.summary.json");
  });

  it("does not delay startup when exporter.start hangs (harness awaits recorder.start once)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const hangingStart: RunExporter = {
      start: () => new Promise<void>(() => {}),
    };
    const warnings: Array<{ phase: string; message: string }> = [];

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability({ timeoutMs: 25 }) }),
      runtime: fake.runtime,
      createRunId: () => "run-hang-start",
      exporterFactory: () => hangingStart,
      exporterWarn: (warning) => { warnings.push(warning); },
    });

    const started = Date.now();
    const response = await harness.run({ conversationId: "conv-hang-start", userMessage: "hi", abortSignal: new AbortController().signal });
    const elapsed = Date.now() - started;

    expect(response.text).toBe("ok");
    expect(elapsed).toBeLessThan(5_000);
    expect(warnings.some((w) => w.phase === "start" && /timed out/u.test(w.message))).toBe(true);
  });

  it("still exports best-effort AND writes JSONL when a run is cancelled", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const finishCalls: RunSummary[] = [];
    const exporter: RunExporter = {
      finish: (summary) => { finishCalls.push(summary); },
    };

    const controller = new AbortController();
    controller.abort();

    const harness = await createConfiguredAgentHarness({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability() }),
      runtime: fake.runtime,
      createRunId: () => "run-cancelled",
      exporterFactory: () => exporter,
    });

    const response = await harness.run({ conversationId: "conv-cancelled", userMessage: "hi", abortSignal: controller.signal });

    // Cancelled runs surface as a failure but the runtime is never invoked.
    expect(response.failure?.kind).toBe("cancelled");
    expect(fake.calls).toHaveLength(0);

    // JSONL artifacts are written even for the cancelled path.
    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-cancelled.summary.json");

    // The cancelled summary was exported best-effort.
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.status).toBe("cancelled");
  });

  it("omits raw prompt and tool payloads from the exported body in metadata-only mode (default)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const secret = "SUPER_SECRET_PROMPT_PAYLOAD";
    const toolSecret = "TOOL_INPUT_SECRET_VALUE";

    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({
        type: "tool_use",
        name: "Read",
        input: { path: "/etc/passwd", note: toolSecret },
      } as RuntimeEventLike);
      return { text: "ok" };
    });

    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      // The body is a binary OTLP protobuf; attribute keys/values are UTF-8, so
      // decode the bytes to assert presence/absence of readable strings.
      bodies.push(init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "");
      return new Response(null, { status: 200 });
    };

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({
        dir,
        identityPath,
        artifactDir,
        // includeSensitiveData omitted -> defaults to false (metadata-only).
        observability: phoenixObservability(),
      }),
      runtime: fake.runtime,
      createRunId: () => "run-metadata-only",
      exporterFactory: (cfg) => realPhoenixExporter(cfg, { fetch: fetchImpl }),
    });

    await responder.respond(
      { conversationId: "conv-meta", text: secret, abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(bodies.length).toBeGreaterThan(0);
    const exported = bodies.join("\n");
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain(toolSecret);
    expect(exported).not.toContain("/etc/passwd");
    // Identifiers are still exported.
    expect(exported).toContain("run-metadata-only");
  });

  it("does NOT construct an exporter when config.observability.exporters is empty", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    let factoryCalls = 0;

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: { exporters: [] } }),
      runtime: fake.runtime,
      createRunId: () => "run-no-exporter",
      exporterFactory: () => { factoryCalls += 1; return {}; },
    });

    const response = await responder.respond(
      { conversationId: "conv-empty", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(response.text).toBe("ok");
    expect(factoryCalls).toBe(0);

    // JSONL is still written via the plain recorder.
    const artifactFiles = await readdir(artifactDir);
    expect(artifactFiles).toContain("run-no-exporter.summary.json");
  });

  it("threads source_id/source_label/config_path from observabilityContext onto root span attributes", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, "artifacts");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      // The body is a binary OTLP protobuf; attribute keys/values are UTF-8, so
      // decode the bytes to assert presence/absence of readable strings.
      bodies.push(init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "");
      return new Response(null, { status: 200 });
    };

    const responder = await createConfiguredAgentResponder({
      config: monoConfig({ dir, identityPath, artifactDir, observability: phoenixObservability() }),
      runtime: fake.runtime,
      createRunId: () => "run-ctx",
      observabilityContext: {
        sourceId: "src-123",
        sourceLabel: "Local Agent Alpha",
        configPath: "/home/me/mono-agent.config.json",
      },
      exporterFactory: (cfg) => realPhoenixExporter(cfg, { fetch: fetchImpl }),
    });

    await responder.respond(
      { conversationId: "conv-ctx", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => {} },
    );

    expect(bodies.length).toBeGreaterThan(0);
    const exported = bodies.join("\n");
    expect(exported).toContain("mono.agent.source_id");
    expect(exported).toContain("src-123");
    expect(exported).toContain("mono.agent.source_label");
    expect(exported).toContain("Local Agent Alpha");
    expect(exported).toContain("mono.agent.config_path");
    expect(exported).toContain("/home/me/mono-agent.config.json");
  });
});

function realPhoenixExporter(
  config: PhoenixExporterConfig,
  deps: { fetch: typeof fetch },
): RunExporter {
  return createPhoenixRunExporter(config, { fetch: deps.fetch });
}

/** Reads the JSONL recorder's `<runId>.summary.json` artifact for a given run. */
async function readSummary(artifactDir: string, runId: string): Promise<RunSummary> {
  const files = await readdir(artifactDir);
  const summaryFile = files.find((file) => file.startsWith(runId) && file.endsWith(".summary.json"));
  if (summaryFile === undefined) {
    throw new Error(`No summary artifact found for runId ${runId} in ${artifactDir}`);
  }
  return JSON.parse(await readFile(join(artifactDir, summaryFile), "utf8")) as RunSummary;
}

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options);
      },
    },
  };
}

async function startEmbeddingServer(): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embeddings") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { input?: unknown };
      const input = Array.isArray(parsed.input) ? parsed.input : [];
      const data = input.map(() => ({ embedding: Array.from({ length: 768 }, () => 0.01) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to start embeddings test server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startFailingEmbeddingServer(onRequest: () => void): Promise<string> {
  const server = createServer((req, res) => {
    onRequest();
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "backend down" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to start failing embeddings test server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function monoConfig(input: {
  readonly dir: string;
  readonly identityPath: string;
  readonly memoryPath?: string;
  readonly memoryMode?: "lite" | "journal" | "bujo";
  readonly memoryWriteMode?: "disabled" | "append-host-summary" | "capture";
  readonly memoryEmbeddings?: {
    readonly provider: "ollama" | "lmstudio" | "openai";
    readonly model: string;
    readonly endpoint?: string;
    readonly apiKey?: string;
  };
  readonly memoryLlm?: NonNullable<MonoAgentConfig["memory"]>["llm"];
  readonly skillsRoot?: string;
  readonly selectedSkills?: readonly string[];
  readonly skillMaxBytes?: number;
  readonly artifactDir: string;
  readonly mcpConfigPath?: string;
  readonly mcpCallTimeoutMs?: number;
  readonly mcpCallMaxTotalTimeoutMs?: number;
  readonly permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  readonly compaction?: NonNullable<MonoAgentConfig["runtime"]["compaction"]>;
  readonly observability?: NonNullable<MonoAgentConfig["observability"]>;
}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
    },
    providers: {
      local: [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: true,
          models: [{ name: "qwen3:8b", capabilities: { context_window: 32768 } }],
        },
      ],
    },
    context: {
      identityPath: input.identityPath,
      selectedSkills: input.selectedSkills ?? [],
      ...(input.skillsRoot === undefined ? {} : { skillsRoot: input.skillsRoot }),
      ...(input.skillMaxBytes === undefined ? {} : { skillMaxBytes: input.skillMaxBytes }),
    },
    ...(input.memoryPath === undefined
      ? {}
      : {
          memory: {
            mode: input.memoryMode ?? "lite",
            path: input.memoryPath,
            maxBytes: 64_000,
            writeMode: input.memoryWriteMode ?? "disabled",
            ...(input.memoryEmbeddings === undefined ? {} : { embeddings: input.memoryEmbeddings }),
            ...(input.memoryLlm === undefined ? {} : { llm: input.memoryLlm }),
          },
        }),
    tools: {
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
      ...(input.mcpConfigPath === undefined ? {} : { mcpConfigPath: input.mcpConfigPath }),
      ...(input.mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs: input.mcpCallTimeoutMs }),
      ...(input.mcpCallMaxTotalTimeoutMs === undefined ? {} : { mcpCallMaxTotalTimeoutMs: input.mcpCallMaxTotalTimeoutMs }),
    },
    artifacts: {
      dir: input.artifactDir,
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: {
      registryDir: join(input.dir, "trace-sources"),
    },
    ...(input.observability === undefined ? {} : { observability: input.observability }),
  };
}

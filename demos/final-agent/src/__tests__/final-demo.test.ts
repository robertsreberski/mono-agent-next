import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import { listRecordedRuns, listTraceRuns, readRecordedRun, readTraceRun } from "@mono-agent/observability";
import { sendA2AMessage } from "@mono-agent/a2a-adapter";
import type {
  A2AProviderOptions,
  A2AProviderStartResult,
} from "@mono-agent/a2a-adapter";
import type {
  AgentMessageStream,
  AgentRequest,
  AgentResponse,
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
} from "@mono-agent/telegram-adapter";
import type {
  CronAdapterOptions,
  CronAdapterStartResult,
} from "@mono-agent/cron-adapter";

import {
  resolveFinalDemoArtifactDir,
  resolveFinalDemoTraceRegistryDir,
  startFinalAgentDemo,
} from "../final-demo.js";
import type { FinalAgentDemo } from "../final-demo.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-final-demo-"));
  tempDirs.push(dir);
  return dir;
}

// The shared config patch references ./mcp.json; the host fails closed when
// the file is missing, so fixtures must provide it.
async function writeDemoMcpJson(dir: string): Promise<void> {
  await writeFile(
    join(dir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { demo: { command: "demo-mcp" } } })}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("final agent demo", () => {
  it("runs headless and waits honestly when config is missing", async () => {
    const dir = await tempDir();
    const telegram = createFakeTelegramAdapter();
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: createFakeRuntime().runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      expect(demo.configPath).toBe(resolve(dir, "mono-agent.config.json"));
      const missingConfigStatus = demo.telegramStatus;
      if (missingConfigStatus.kind !== "disabled") {
        throw new Error(`Expected disabled, got ${missingConfigStatus.kind}.`);
      }
      expect(missingConfigStatus.reason).toMatch(/disabled/iu);
      expect(demo.a2aStatus).toMatchObject({ kind: "disabled" });
      expect(telegram.starts).toHaveLength(0);

      const observability = await getObservabilityRuns(demo);
      expect(observability.artifactDir).toBe(resolve(dir, ".mono-agent", "artifacts"));
      expect(observability.runs).toEqual([]);
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        registryDir: resolve(dir, "trace-registry"),
        artifactDir: resolve(dir, ".mono-agent", "artifacts"),
      });
      const traceability = await getTraceabilityRuns(demo);
      expect(traceability.sources[0]).toMatchObject({ label: "Final Agent Demo", health: "running" });
    } finally {
      await demo.stop();
    }
  });

  it("restarts Telegram after a config change is applied and uses the updated runtime config", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono from a reloaded config.", "utf8");
    await writeDemoMcpJson(dir);

    const fakeRuntime = createFakeRuntime();
    const telegram = createFakeTelegramAdapter();

    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      // No config on disk yet: Telegram is disabled until the JSON is written and applied.
      expect(demo.telegramStatus.kind).toBe("disabled");
      await writeConfig(dir, validConfigPatch());
      const applied = await demo.applyConfigChange("test-config-write");
      expect(applied.kind).toBe("applied");

      await waitFor(() => telegram.starts.length === 1);
      expect(telegram.starts[0]).toMatchObject({
        deleteWebhookOnStart: true,
        allowedUpdates: ["message", "callback_query"],
      });
      expect(demo.telegramStatus.kind).toBe("running");
      expect(demo.a2aStatus.kind).toBe("disabled");
      expect(JSON.stringify(demo.telegramStatus)).not.toContain("secret-token");
      expect(JSON.stringify(demo.telegramStatus)).not.toContain("987654321");

      await writeConfig(dir, {
        ...validConfigPatch(),
        runtime: { ...validConfigPatch().runtime, maxTurns: 9 },
        tools: { ...validConfigPatch().tools, allowedTools: ["Read"] },
      });
      const second = await demo.applyConfigChange("test-config-write");
      expect(second.kind).toBe("applied");
      await waitFor(() => telegram.starts.length === 2);
      // Applying config stops the prior adapter before starting the reloaded one.
      expect(telegram.stops).toContain(0);

      const { response } = await respondViaTelegram(telegram.latest() as TelegramAdapterStartOptions, "Use the reloaded config", 2, 20);
      expect(response.text).toBe("runtime ok");
      expect(fakeRuntime.calls[0]?.options.maxTurns).toBe(9);
      expect(fakeRuntime.calls[0]?.options.allowedTools).toEqual(["Read"]);
    } finally {
      await demo.stop();
    }

    // Stopping the demo stops the live (second) adapter too.
    expect(telegram.stops).toContain(1);
  });

  it("resolves the observability artifact directory without requiring a valid full config", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "mono-agent.config.json");

    await writeFile(configPath, "{ this is not valid json", "utf8");
    await expect(resolveFinalDemoArtifactDir({ env: { MONO_AGENT_ARTIFACT_DIR: "./from-env" }, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-env"));
    await expect(resolveFinalDemoArtifactDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, ".mono-agent", "artifacts"));

    await writeFile(configPath, `${JSON.stringify({ artifacts: { dir: "./from-config" } })}\n`, "utf8");
    await expect(resolveFinalDemoArtifactDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-config"));
  });

  it("resolves traceability settings without requiring a valid full config", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "mono-agent.config.json");

    await writeFile(configPath, "{ this is not valid json", "utf8");
    await expect(resolveFinalDemoTraceRegistryDir({ env: { MONO_AGENT_TRACE_REGISTRY_DIR: "./from-env" }, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-env"));
    await expect(resolveFinalDemoTraceRegistryDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(homedir(), ".mono-agent", "trace-sources"));

    await writeFile(configPath, `${JSON.stringify({ traceability: { registryDir: "./from-config" } })}\n`, "utf8");
    await expect(resolveFinalDemoTraceRegistryDir({ env: {}, cwd: dir, configPath }))
      .resolves.toBe(resolve(dir, "from-config"));
  });

  it("starts an A2A provider independently when Telegram is not configured", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono over A2A.", "utf8");
    await writeDemoMcpJson(dir);
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify(validA2AOnlyConfigPatch(), null, 2)}\n`,
      "utf8",
    );

    const telegram = createFakeTelegramAdapter();
    const fakeRuntime = createFakeRuntime();
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      expect(demo.telegramStatus.kind).toBe("disabled");
      expect(telegram.starts).toHaveLength(0);
      const a2aStatus = demo.a2aStatus;
      if (a2aStatus.kind !== "running") {
        throw new Error(`Expected A2A running, got ${a2aStatus.kind}.`);
      }
      expect(a2aStatus.agentCardUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\.well-known\/agent-card\.json$/u);
      expect(JSON.stringify(a2aStatus)).not.toContain("a2a-secret");

      const cardResponse = await fetch(a2aStatus.agentCardUrl);
      expect(cardResponse.status).toBe(200);
      expect(await cardResponse.json()).toMatchObject({
        name: "Final Demo A2A",
      });

      const response = await sendA2AMessage({
        agentUrl: a2aStatus.agentCardUrl,
        text: "Hello from another Mono agent",
      });
      expect(response.text).toBe("runtime ok");
      expect(fakeRuntime.calls).toHaveLength(1);
      expect(fakeRuntime.calls[0]?.prompt).toContain("You are Mono over A2A.");
    } finally {
      const agentCardUrl = demo.a2aStatus.kind === "running" ? demo.a2aStatus.agentCardUrl : undefined;
      await demo.stop();
      if (agentCardUrl !== undefined) {
        await expect(fetch(agentCardUrl)).rejects.toThrow();
      }
    }
  });

  it("restarts the A2A provider after a config change is applied", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono over a reloaded A2A provider.", "utf8");
    await writeDemoMcpJson(dir);
    await writeConfig(dir, validA2AOnlyConfigPatch());

    const providers: Array<{ options: A2AProviderOptions; stopped: boolean }> = [];
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: createFakeRuntime().runtime,
      telegramStartAdapter: createFakeTelegramAdapter().startAdapter,
      a2aProviderFactory: async (options) => createFakeA2AProvider(options, providers),
    });

    try {
      expect(providers).toHaveLength(1);
      expect(providers[0]?.options.agent.name).toBe("Final Demo A2A");
      const patch = validA2AOnlyConfigPatch();
      const plugin = patch.channels.plugins[0]!;
      await writeConfig(dir, {
        ...patch,
        channels: {
          plugins: [{
            ...plugin,
            config: {
              ...plugin.config,
              agent: { ...plugin.config.agent, name: "Reloaded Final Demo A2A" },
            },
          }],
        },
      });
      const applied = await demo.applyConfigChange("test-config-write");
      expect(applied.kind).toBe("applied");
      await waitFor(() => providers.length === 2);
      expect(providers[0]?.stopped).toBe(true);
      expect(providers[1]?.options.agent.name).toBe("Reloaded Final Demo A2A");
      expect(demo.a2aStatus).toMatchObject({
        kind: "running",
        agentCardUrl: "http://127.0.0.1:4201/.well-known/agent-card.json",
      });
    } finally {
      await demo.stop();
    }

    expect(providers[1]?.stopped).toBe(true);
  });

  it("re-registers traceability after trace source config changes", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with reloaded traceability.", "utf8");
    await writeDemoMcpJson(dir);
    await writeConfig(dir, {
      ...validConfigPatch(),
      traceability: {
        registryDir: "./trace-registry-a",
        sourceId: "source-a",
        sourceLabel: "Source A",
        heartbeatMs: 500,
        staleAfterMs: 1500,
      },
    });
    const telegram = createFakeTelegramAdapter();
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: {},
      runtime: createFakeRuntime().runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      await waitFor(() => telegram.starts.length === 1);
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        sourceId: "source-a",
        registryDir: resolve(dir, "trace-registry-a"),
      });
      await writeConfig(dir, {
        ...validConfigPatch(),
        artifacts: { dir: "./artifacts-b" },
        traceability: {
          registryDir: "./trace-registry-b",
          sourceId: "source-b",
          sourceLabel: "Source B",
          heartbeatMs: 750,
          staleAfterMs: 2500,
        },
      });
      const applied = await demo.applyConfigChange("test-config-write");
      expect(applied.kind).toBe("applied");
      await waitFor(() => demo.traceabilityStatus.kind === "running" && demo.traceabilityStatus.sourceId === "source-b");
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        sourceId: "source-b",
        registryDir: resolve(dir, "trace-registry-b"),
        artifactDir: resolve(dir, "artifacts-b"),
      });

      const oldManifest = JSON.parse(await readFile(join(dir, "trace-registry-a", "source-a.json"), "utf8")) as { status: string };
      expect(oldManifest.status).toBe("stopped");
      const traceability = await getTraceabilityRuns(demo);
      expect(traceability.sources.map((source) => [source.sourceId, source.label, source.health])).toEqual([
        ["source-b", "Source B", "running"],
      ]);
    } finally {
      await demo.stop();
    }
  });

  it("composes Telegram, harness, runtime, memory, tools, traceability, and artifacts", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono and you love small LEGO blocks.", "utf8");
    await writeDemoMcpJson(dir);
    await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(validConfigPatch(), null, 2)}\n`, "utf8");

    const fakeRuntime = createFakeRuntime();
    const telegram = createFakeTelegramAdapter();
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      expect(demo.telegramStatus.kind).toBe("running");
      const telegramOptions = telegram.latest();
      expect(telegramOptions).toBeDefined();
      // The host wires the runtime+memory+artifacts responder into the adapter;
      // drive it directly with the request the grammY handler would synthesize.
      const { response } = await respondViaTelegram(telegramOptions as TelegramAdapterStartOptions, "Hello demo");

      expect(response.text).toBe("runtime ok");
      expect(fakeRuntime.calls).toHaveLength(1);
      const call = fakeRuntime.calls[0];
      expect(call?.prompt).toContain("You are Mono and you love small LEGO blocks.");
      // Empty recall injects no delimiter/header/block. Non-empty recall is appended to
      // the provider-facing user message, not the system prompt.
      const userMessage = String(call?.options.messages[0]?.content ?? "");
      expect(call?.prompt).not.toContain("Memory (recalled)");
      expect(call?.prompt).not.toContain("Recalled long-term memory");
      expect(userMessage).not.toContain("Memory (recalled)");
      expect(userMessage).not.toContain("Recalled long-term memory");
      expect(call?.options.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
      expect(call?.options.executionMode).toBe("sdk");
      expect(call?.options.cwd).toBe(resolve(dir, "workspace"));
      expect(call?.options.maxTurns).toBe(4);
      expect(call?.options.allowedTools).toEqual(["Read", "Grep"]);
      expect(call?.options.disallowedTools).toEqual(["Bash"]);
      expect(call?.options.mcpConfigPath).toBe(resolve(dir, "mcp.json"));
      expect(call?.options.mcpServers).toMatchObject({ demo: { command: "demo-mcp" } });

      // append-host-summary persists a deterministic rapid-log bullet to the canonical daily file
      // at <memory root>/daily/<day>.md (Memory v2 replaced the single MEMORY.md file).
      const dailyDir = join(dir, "memory", "daily");
      const dailyFiles = await readdir(dailyDir);
      expect(dailyFiles).toHaveLength(1);
      const daily = await readFile(join(dailyDir, dailyFiles[0] as string), "utf8");
      expect(daily).toContain("Host-observed completed turn.");
      expect(daily).toContain("Hello demo");
      const artifactFiles = await readdir(join(dir, "artifacts"));
      const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
      expect(summaryFile).toBeDefined();
      expect(await readFile(join(dir, "artifacts", summaryFile as string), "utf8")).toContain("capabilitiesUsed");

      const observedRuns = await getObservabilityRuns(demo);
      expect(observedRuns.artifactDir).toBe(resolve(dir, "artifacts"));
      expect(observedRuns.runs[0]).toMatchObject({ conversationId: "telegram:987654321", status: "succeeded" });
      const observedDetail = await getObservedRun(demo, observedRuns.runs[0]?.runId ?? "");
      expect(observedDetail.run?.events.find((event) => event.type === "fake-event")).toMatchObject({ category: "runtime" });
      expect(JSON.stringify(observedDetail)).not.toContain("redacted-value");
      const traceability = await getTraceabilityRuns(demo);
      expect(traceability.runs[0]).toMatchObject({
        conversationId: "telegram:987654321",
        source: { label: "Final Agent Demo" },
      });
      const traceDetail = await getTraceabilityRun(
        demo,
        traceability.runs[0]?.source.sourceId ?? "",
        traceability.runs[0]?.runId ?? "",
      );
      expect(traceDetail.detail?.run.events.find((event) => event.type === "fake-event")).toMatchObject({ category: "runtime" });
      // The responder returns the final answer for the channel to deliver.
      expect(response.text).toContain("runtime ok");
    } finally {
      await demo.stop();
    }
  });

  it("starts webhook, OpenAI API, and cron adapters from demo config", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono from webhook, OpenAI API, and cron.", "utf8");
    await writeDemoMcpJson(dir);
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...validConfigPatch(),
        webhook: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          path: "/hook",
          defaultMode: "sync",
        },
        openaiApi: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          modelId: "agent",
        },
        cron: {
          enabled: true,
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "scheduled check",
          conversationId: "cron:demo",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const fakeRuntime = createFakeRuntime();
    const cronStarts: CronAdapterOptions[] = [];
    const stoppedCronAdapters: CronAdapterStartResult[] = [];
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramStartAdapter: createFakeTelegramAdapter().startAdapter,
      cronAdapterFactory: (options) => createFakeCronAdapter(options, cronStarts, stoppedCronAdapters),
    });

    try {
      const webhookStatus = demo.webhookStatus;
      if (webhookStatus.kind !== "running") {
        throw new Error(`Expected webhook running, got ${webhookStatus.kind}.`);
      }
      expect(webhookStatus.invokeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/u);
      expect(JSON.stringify(webhookStatus)).toContain("\"defaultMode\":\"sync\"");

      const openAIApiStatus = demo.openAIApiStatus;
      if (openAIApiStatus.kind !== "running") {
        throw new Error(`Expected OpenAI API running, got ${openAIApiStatus.kind}.`);
      }
      expect(openAIApiStatus.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(JSON.stringify(openAIApiStatus)).toContain("\"modelId\":\"agent\"");

      const cronStatus = demo.cronStatus;
      if (cronStatus.kind !== "running") {
        throw new Error(`Expected cron running, got ${cronStatus.kind}.`);
      }
      expect(cronStatus.jobs).toBe(1);
      expect(cronStarts[0]?.jobs).toEqual([
        {
          id: "default",
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "scheduled check",
          conversationId: "cron:demo",
        },
      ]);

      const response = await fetch(webhookStatus.invokeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello webhook", conversationId: "webhook:test" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "succeeded",
        conversationId: "webhook:test",
        text: "runtime ok",
      });
      expect(fakeRuntime.calls[0]?.prompt).toContain("You are Mono from webhook, OpenAI API, and cron.");
      expect(fakeRuntime.calls[0]?.options.model).toMatchObject({ sdk: "pi", model: "gpt-5.5" });

      const models = await fetch(`${openAIApiStatus.baseUrl}/models`);
      expect(models.status).toBe(200);
      await expect(models.json()).resolves.toMatchObject({
        data: [expect.objectContaining({ id: "agent" })],
      });

      const chat = await fetch(`${openAIApiStatus.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          metadata: { conversation_id: "openai-api:test" },
          messages: [{ role: "user", content: "Hello from OpenWebUI" }],
        }),
      });
      expect(chat.status).toBe(200);
      await expect(chat.json()).resolves.toMatchObject({
        choices: [{ message: { role: "assistant", content: "runtime ok" } }],
      });
      expect(fakeRuntime.calls[1]?.prompt).toContain("You are Mono from webhook, OpenAI API, and cron.");
      expect(fakeRuntime.calls[1]?.prompt).toContain("user: Hello from OpenWebUI");

      const traceability = await getTraceabilityRuns(demo);
      expect(traceability.sources[0]).toMatchObject({
        transports: expect.arrayContaining(["webhook", "openai-api", "cron"]),
      });
    } finally {
      const invokeUrl = demo.webhookStatus.kind === "running" ? demo.webhookStatus.invokeUrl : undefined;
      const openAIApiBaseUrl = demo.openAIApiStatus.kind === "running" ? demo.openAIApiStatus.baseUrl : undefined;
      await demo.stop();
      expect(stoppedCronAdapters).toHaveLength(1);
      if (invokeUrl !== undefined) {
        await expect(fetch(invokeUrl, { method: "POST" })).rejects.toThrow();
      }
      if (openAIApiBaseUrl !== undefined) {
        await expect(fetch(`${openAIApiBaseUrl}/models`)).rejects.toThrow();
      }
    }
  });

  it("passes configured local Pi provider context into runtime calls", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with local runtime support.", "utf8");
    await writeDemoMcpJson(dir);
    const patch = validConfigPatch();
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...patch,
        runtime: {
          ...patch.runtime,
          model: "pi:ollama:qwen3:8b",
        },
        providers: {
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
              models: [
                {
                  name: "qwen3:8b",
                  capabilities: { context_window: 32768 },
                },
              ],
            },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const fakeRuntime = createFakeRuntime();
    const telegram = createFakeTelegramAdapter();
    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: fakeRuntime.runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      expect(demo.telegramStatus.kind).toBe("running");
      const { response } = await respondViaTelegram(telegram.latest() as TelegramAdapterStartOptions, "Use local model", 2, 20);

      expect(response.text).toBe("runtime ok");
      expect(fakeRuntime.calls).toHaveLength(1);
      const call = fakeRuntime.calls[0];
      expect(call?.options.model).toMatchObject({ sdk: "pi", provider: "ollama", model: "qwen3:8b" });
      expect(call?.options.customProvider).toMatchObject({
        id: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
        enabled: true,
      });
      expect(call?.options.customModel).toMatchObject({
        model_name: "qwen3:8b",
        display_name: "qwen3:8b",
        enabled: true,
      });
      expect(call?.options.modelCapabilities).toMatchObject({
        context_window: 32768,
        reasoning: true,
      });
      expect(call?.options.isPrivateProvider).toBe(true);
    } finally {
      await demo.stop();
    }
  });

  it("waits for config instead of starting Telegram when a local provider URL is unsafe", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono with local runtime support.", "utf8");
    await writeDemoMcpJson(dir);
    const patch = validConfigPatch();
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify({
        ...patch,
        runtime: {
          ...patch.runtime,
          model: "pi:ollama:qwen3:8b",
        },
        providers: {
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://api.example.com",
              enabled: true,
            },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const telegram = createFakeTelegramAdapter();

    const demo = await startFinalAgentDemo({
      cwd: dir,
      env: testTraceEnv(),
      runtime: createFakeRuntime().runtime,
      telegramStartAdapter: telegram.startAdapter,
    });

    try {
      const status = demo.telegramStatus;
      if (status.kind !== "waiting_for_config") {
        throw new Error(`Expected waiting_for_config, got ${status.kind}.`);
      }
      expect(status.reason).toMatch(/public host/u);
      expect(telegram.starts).toHaveLength(0);
    } finally {
      await demo.stop();
    }
  });
});

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function validConfigPatch() {
  return {
    telegram: {
      enabled: true,
      botToken: "123456:test-token",
      allowedChatIds: ["987654321"],
    },
    runtime: {
      model: "pi:openai-codex:gpt-5.5",
      executionMode: "sdk",
      maxTurns: 4,
      workspace: "./workspace",
    },
    context: {
      identityPath: "./IDENTITY.md",
      selectedSkills: [],
    },
    memory: {
      mode: "lite" as const,
      path: "./memory",
      maxBytes: 64_000,
      writeMode: "append-host-summary" as const,
    },
    tools: {
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      mcpConfigPath: "./mcp.json",
    },
    artifacts: {
      dir: "./artifacts",
    },
    traceability: {
      registryDir: "./trace-registry",
    },
  };
}

function testTraceEnv(): Record<string, string> {
  return {
    MONO_AGENT_TRACE_REGISTRY_DIR: "./trace-registry",
  };
}

function validA2AOnlyConfigPatch() {
  const { telegram: _telegram, memory: _memory, ...patch } = validConfigPatch();
  return {
    ...patch,
    channels: {
      plugins: [{
        package: "@mono-agent/a2a-adapter",
        config: {
          provider: {
            enabled: true,
            host: "127.0.0.1",
            port: 0,
          },
          agent: {
            name: "Final Demo A2A",
            description: "Final demo A2A provider.",
            version: "0.1.0",
          },
          skill: {
            id: "final-demo",
            name: "Final Demo",
            description: "Runs the configured final demo runtime over A2A.",
            tags: ["agent", "a2a"],
          },
        },
      }],
    },
  };
}

/**
 * The operator console (the prior trace/observability HTTP reader) was retired.
 * Tests now read the same recorded artifacts and trace-source registry directly
 * through the retained `@mono-agent/observability` reader API, keyed off the
 * demo's `traceabilityStatus` (registry + artifact directories).
 */
function readerOptionsFor(demo: FinalAgentDemo): { artifactDir: string; registryDir: string } {
  const status = demo.traceabilityStatus;
  if (status.kind !== "running") {
    throw new Error(`Expected running traceability, got ${status.kind}.`);
  }
  return { artifactDir: status.artifactDir, registryDir: status.registryDir };
}

async function getObservabilityRuns(demo: FinalAgentDemo): Promise<{
  artifactDir: string;
  runs: Array<{ runId: string; conversationId: string; status: string }>;
}> {
  const { artifactDir } = readerOptionsFor(demo);
  const result = await listRecordedRuns({ artifactDir });
  return {
    artifactDir,
    runs: result.runs.map((run) => ({ runId: run.runId, conversationId: run.conversationId, status: run.status })),
  };
}

async function getTraceabilityRuns(demo: FinalAgentDemo): Promise<{
  sources: Array<{ sourceId: string; label: string; health: string; transports?: readonly string[] }>;
  runs: Array<{ runId: string; conversationId: string; source: { sourceId: string; label: string } }>;
}> {
  const { registryDir } = readerOptionsFor(demo);
  const result = await listTraceRuns({ registryDir });
  return {
    sources: result.sources.map((source) => ({
      sourceId: source.sourceId,
      label: source.label,
      health: source.health,
      ...(source.transports === undefined ? {} : { transports: source.transports }),
    })),
    runs: result.runs.map((run) => ({
      runId: run.runId,
      conversationId: run.conversationId,
      source: { sourceId: run.traceSource.sourceId, label: run.traceSource.label },
    })),
  };
}

async function getTraceabilityRun(
  demo: FinalAgentDemo,
  sourceId: string,
  runId: string,
): Promise<{ detail?: { run: { events: readonly { category: string; type?: string }[] } } }> {
  const { registryDir } = readerOptionsFor(demo);
  const detail = await readTraceRun({ registryDir }, sourceId, runId);
  return detail === undefined ? {} : { detail };
}

async function getObservedRun(
  demo: FinalAgentDemo,
  runId: string,
): Promise<{ run?: { events: readonly { category: string; type?: string }[] } }> {
  const { artifactDir } = readerOptionsFor(demo);
  const run = await readRecordedRun({ artifactDir }, runId);
  return run === undefined ? {} : { run };
}

function createFakeRuntime(): {
  readonly calls: Array<{ prompt: string; options: RuntimeRunOptions; metadataRunId?: string }>;
  readonly runtime: { run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> };
} {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions; metadataRunId?: string }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        options.onEvent?.({ type: "fake-event", token: "redacted-value" });
        calls.push({ prompt, options });
        return {
          text: "runtime ok",
          model: options.model.model,
          sdk: options.model.sdk,
          cost: { totalUsd: 0 },
          capabilitiesUsed: ["telegram"],
        };
      },
    },
  };
}

/**
 * A fake `startTelegramAdapter` seam. The grammY-backed adapter is no longer
 * driven through a poller; the host now wires the responder + message copy into
 * `startTelegramAdapter(options)` and gets back the adapter delivery surface.
 * The fake captures every start's options (so tests can assert the wiring the
 * demo composed) and records start/stop without building a real bot.
 */
function createFakeTelegramAdapter(): {
  readonly starts: TelegramAdapterStartOptions[];
  readonly stops: number[];
  readonly startAdapter: (options: TelegramAdapterStartOptions) => Promise<TelegramAdapterStartResult>;
  /** The most recently captured start options, or undefined before first start. */
  latest(): TelegramAdapterStartOptions | undefined;
} {
  const starts: TelegramAdapterStartOptions[] = [];
  const stops: number[] = [];
  return {
    starts,
    stops,
    latest: () => starts.at(-1),
    startAdapter: async (options) => {
      const index = starts.length;
      starts.push(options);
      return {
        async stop() {
          stops.push(index);
        },
        async notify() {
          // No-op proactive delivery for the demo's fake Telegram adapter.
          return { delivered: true };
        },
        async post() {
          // No-op direct send (AskUser question) for the demo's fake adapter.
        },
        async postStatus() {
          // No-op tool-progress status for the demo's fake adapter.
        },
        async presentAsk() {
          // No-op initial AskUser presentation for the demo's fake adapter.
        },
        async updateAsk() {
          // No-op AskUser state update for the demo's fake adapter.
        },
      };
    },
  };
}

/**
 * A no-op Telegram-shaped {@link AgentMessageStream}. The grammY adapter (not
 * the responder) is what delivers the final answer to Telegram, so driving the
 * wired responder directly only needs a stream that accepts the streamed
 * deltas/events; the final answer is the responder's return value.
 */
function createNoopTelegramStream(): AgentMessageStream {
  return {
    async status() {},
    async append() {},
    async replace() {},
    async event() {},
    async finish() {},
  };
}

/**
 * Build the responder-facing Telegram {@link AgentRequest} the grammY message
 * handler would synthesize from an update, so tests can drive the wired
 * responder directly (previously done via `poller.adapter.handleUpdate`).
 */
function buildTelegramRequest(text: string, updateId: number, messageId: number): AgentRequest {
  return {
    conversationId: "telegram:987654321",
    chatId: 987654321,
    messageId,
    updateId,
    userId: 77,
    username: "tester",
    text,
    abortSignal: new AbortController().signal,
    metadata: {
      telegram: {
        updateId,
        chat: { id: 987654321, type: "private" },
        message: { id: messageId },
        from: { id: 77, username: "tester" },
      },
    },
  };
}

/** Drive the wired responder once and return its response. */
async function respondViaTelegram(
  options: TelegramAdapterStartOptions,
  text: string,
  updateId = 1,
  messageId = 10,
): Promise<{ response: AgentResponse }> {
  const response = await options.responder.respond(
    buildTelegramRequest(text, updateId, messageId),
    createNoopTelegramStream(),
  );
  return { response };
}

function createFakeA2AProvider(
  options: A2AProviderOptions,
  providers: Array<{ options: A2AProviderOptions; stopped: boolean }>,
): A2AProviderStartResult {
  const index = providers.length;
  const entry = { options, stopped: false };
  providers.push(entry);
  const port = 4200 + index;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    agentCardUrl: `${url}/.well-known/agent-card.json`,
    jsonRpcUrl: `${url}/a2a/json-rpc`,
    restUrl: `${url}/a2a/rest`,
    host: options.host ?? "127.0.0.1",
    port,
    agentCard: {
      name: options.agent.name,
      description: options.agent.description,
      version: options.agent.version,
      skills: [options.skill],
    } as A2AProviderStartResult["agentCard"],
    async stop() {
      entry.stopped = true;
    },
  };
}

function createFakeCronAdapter(
  options: CronAdapterOptions,
  starts: CronAdapterOptions[],
  stopped: CronAdapterStartResult[],
): CronAdapterStartResult {
  starts.push(options);
  const adapter: CronAdapterStartResult = {
    jobs: options.jobs.slice(),
    activeJobCount: 0,
    stop() {
      stopped.push(adapter);
    },
  };
  return adapter;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await delay(10);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

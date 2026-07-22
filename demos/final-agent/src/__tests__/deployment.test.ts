import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { sendA2AMessage } from "@mono-agent/a2a-adapter";
import { listTraceRuns, readTraceRun } from "@mono-agent/observability";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import { startFinalAgentDemo } from "../final-demo.js";
import type { FinalAgentDemo } from "../final-demo.js";
import {
  buildFinalDemoDeploymentConfig,
  checkOllamaModel,
  DEFAULT_FINAL_DEMO_DEPLOY_MODEL_REFERENCE,
  DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL,
  writeFinalDemoDeploymentFiles,
} from "../deployment.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-deploy-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("final demo deployment", () => {
  it("builds a Gemma 4 Ollama config with traceability and A2A enabled", () => {
    const config = buildFinalDemoDeploymentConfig({ cwd: "/repo" });

    expect(config.runtime).toMatchObject({
      model: DEFAULT_FINAL_DEMO_DEPLOY_MODEL_REFERENCE,
      executionMode: "sdk",
      workspace: "./.mono-agent/deploy/workspace",
    });
    expect(config.runtime).not.toHaveProperty("maxTurns");
    expect(config.providers?.local?.[0]).toMatchObject({
      id: "ollama",
      type: "ollama",
      baseUrl: DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL,
      enabled: true,
    });
    expect(config.providers?.local?.[0]?.models?.[0]).toMatchObject({
      name: "gemma4:31b",
      displayName: "Gemma 4 31B",
      capabilities: {
        family: "gemma4",
        context_window: 256000,
        reasoning: true,
        reasoning_mode: "toggle",
        vision: true,
        json_mode: true,
      },
    });
    expect(config.channels.plugins[0]).toMatchObject({
      package: "@mono-agent/a2a-adapter",
    });
    expect(config.channels.plugins[0].config.provider).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
    });
    expect(config.artifacts).toEqual({ dir: "./.mono-agent/deploy/artifacts" });
    expect(config.traceability).toMatchObject({
      registryDir: "./.mono-agent/trace-sources",
      sourceId: "final-agent-gemma4",
      sourceLabel: "Final Agent Demo (Gemma 4)",
    });
    expect(config.tools).toEqual({ allowedTools: [], disallowedTools: [] });
  });

  it("checks Ollama readiness for installed, missing, and unavailable models", async () => {
    const readyServer = await startOllamaTagsServer([{ name: "gemma4:31b" }]);
    try {
      await expect(checkOllamaModel({ model: "gemma4:31b", ollamaBaseUrl: readyServer.url }))
        .resolves.toEqual({ kind: "ready", model: "gemma4:31b", baseUrl: readyServer.url });

      await expect(checkOllamaModel({ model: "not-installed:latest", ollamaBaseUrl: readyServer.url }))
        .resolves.toEqual({
          kind: "model_missing",
          model: "not-installed:latest",
          baseUrl: readyServer.url,
          availableModels: ["gemma4:31b"],
        });
    } finally {
      await readyServer.stop();
    }

    const closedServer = await startOllamaTagsServer([{ name: "gemma4:31b" }]);
    await closedServer.stop();
    const unavailable = await checkOllamaModel({ model: "gemma4:31b", ollamaBaseUrl: closedServer.url });
    expect(unavailable.kind).toBe("server_unavailable");
    expect(unavailable.model).toBe("gemma4:31b");
    expect(unavailable.baseUrl).toBe(closedServer.url);
  });

  it("writes deployment files without secrets", async () => {
    const dir = await tempDir();
    const result = await writeFinalDemoDeploymentFiles({ cwd: dir });

    expect(result.configPath).toBe(resolve(dir, ".mono-agent/deploy/final-agent-gemma4.config.json"));
    expect(result.memoryPath).toBe(resolve(dir, ".mono-agent/deploy/memory"));
    expect(result.artifactDir).toBe(resolve(dir, ".mono-agent/deploy/artifacts"));
    expect(result.traceRegistryDir).toBe(resolve(dir, ".mono-agent/trace-sources"));

    const config = JSON.parse(await readFile(result.configPath, "utf8")) as unknown;
    expect(JSON.stringify(config)).toContain(DEFAULT_FINAL_DEMO_DEPLOY_MODEL_REFERENCE);
    expect(JSON.stringify(config)).not.toMatch(/token|secret|apiKey/iu);
    // Memory v2: the path is a root directory the engine populates, not a seeded markdown file.
    expect((await stat(result.memoryPath)).isDirectory()).toBe(true);
  });

  it("starts the generated deployment config through A2A and exposes traceability runs", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "demos/final-agent"), { recursive: true });
    await writeFile(join(dir, "demos/final-agent/IDENTITY.example.md"), "You are the deployed Final Agent.", "utf8");
    const files = await writeFinalDemoDeploymentFiles({ cwd: dir });
    const fakeRuntime = createFakeRuntime();

    const demo = await startFinalAgentDemo({
      cwd: dir,
      configPath: files.configPath,
      env: {},
      runtime: fakeRuntime.runtime,
    });

    try {
      expect(demo.traceabilityStatus).toMatchObject({
        kind: "running",
        sourceId: "final-agent-gemma4",
        registryDir: resolve(dir, ".mono-agent/trace-sources"),
        artifactDir: resolve(dir, ".mono-agent/deploy/artifacts"),
      });
      const a2aStatus = demo.a2aStatus;
      if (a2aStatus.kind !== "running") {
        throw new Error(`Expected A2A running, got ${a2aStatus.kind}.`);
      }

      const response = await sendA2AMessage({
        agentUrl: a2aStatus.agentCardUrl,
        text: "Say hello from the deployment smoke.",
      });
      expect(response.text).toBe("deployed runtime ok");
      expect(fakeRuntime.calls).toHaveLength(1);
      const call = fakeRuntime.calls[0];
      expect(call?.options.model).toMatchObject({ sdk: "pi", provider: "ollama", model: "gemma4:31b" });
      expect(call?.options.customProvider).toMatchObject({
        id: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      });
      expect(call?.options.customModel).toMatchObject({
        model_name: "gemma4:31b",
        display_name: "Gemma 4 31B",
      });

      const traceability = await getTraceabilityRuns(demo);
      expect(traceability.sources[0]).toMatchObject({
        sourceId: "final-agent-gemma4",
        label: "Final Agent Demo (Gemma 4)",
        health: "running",
      });
      await waitFor(async () => {
        const runs = await getTraceabilityRuns(demo);
        return runs.runs.some((run) => run.source.sourceId === "final-agent-gemma4");
      });
      const runs = await getTraceabilityRuns(demo);
      const run = runs.runs.find((candidate) => candidate.source.sourceId === "final-agent-gemma4");
      expect(run).toBeDefined();
      const detail = await getTraceabilityRun(demo, "final-agent-gemma4", run?.runId ?? "");
      expect(detail.detail?.run.events.find((event) => event.type === "fake-deploy-event")).toMatchObject({ category: "runtime" });
    } finally {
      await demo.stop();
    }
  });
});

function createFakeRuntime(): {
  readonly calls: Array<{ prompt: string; options: RuntimeRunOptions }>;
  readonly runtime: { run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> };
} {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        options.onEvent?.({ type: "fake-deploy-event", authorization: "redacted-value" });
        calls.push({ prompt, options });
        return {
          text: "deployed runtime ok",
          model: options.model.model,
          sdk: options.model.sdk,
          cost: { totalUsd: 0 },
          capabilitiesUsed: ["a2a"],
        };
      },
    },
  };
}

async function startOllamaTagsServer(
  models: Array<{ readonly name: string }>,
): Promise<{ readonly url: string; readonly stop: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/api/tags") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ models }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolvePromise();
            return;
          }
          reject(error);
        });
      });
    },
  };
}

/**
 * The operator console reader was retired; the deployment smoke test now reads
 * the trace-source registry directly via the retained observability reader API,
 * keyed off the demo's running `traceabilityStatus`.
 */
function registryDirFor(demo: FinalAgentDemo): string {
  const status = demo.traceabilityStatus;
  if (status.kind !== "running") {
    throw new Error(`Expected running traceability, got ${status.kind}.`);
  }
  return status.registryDir;
}

async function getTraceabilityRuns(demo: FinalAgentDemo): Promise<{
  sources: Array<{ sourceId: string; label: string; health: string }>;
  runs: Array<{ runId: string; conversationId: string; source: { sourceId: string; label: string } }>;
}> {
  const result = await listTraceRuns({ registryDir: registryDirFor(demo) });
  return {
    sources: result.sources.map((source) => ({ sourceId: source.sourceId, label: source.label, health: source.health })),
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
  const detail = await readTraceRun({ registryDir: registryDirFor(demo) }, sourceId, runId);
  return detail === undefined ? {} : { detail };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

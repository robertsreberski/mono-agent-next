import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";
import { requestOverridesModel, runSourceFromRequest } from "../harness.js";
import type { AgentHarnessRecorderFactoryInput, AgentHarnessRequest } from "../types.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-run-config-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult> = async () => ({ text: "ok" })) {
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

class SpyRecorder implements RunRecorder {
  readonly events: RuntimeEventLike[] = [];

  onEvent(event: RuntimeEventLike): void {
    this.events.push(event);
  }

  async start(): Promise<RunSummary> {
    return { runId: "r", conversationId: "c", status: "running", durationMs: 0, eventCount: 0, artifactPaths: [] };
  }

  async finish(_result: RuntimeResultLike): Promise<RunSummary> {
    return { runId: "r", conversationId: "c", status: "succeeded", durationMs: 1, eventCount: this.events.length, artifactPaths: [] };
  }

  async fail(_error: unknown): Promise<RunSummary> {
    return { runId: "r", conversationId: "c", status: "failed", durationMs: 1, eventCount: this.events.length, artifactPaths: [] };
  }
}

describe("runSourceFromRequest", () => {
  function req(metadata?: Record<string, unknown>, conversationId = "other-conv"): Pick<AgentHarnessRequest, "conversationId" | "metadata"> {
    return { conversationId, ...(metadata === undefined ? {} : { metadata }) };
  }

  it("derives 'tui' from metadata.source === 'tui'", () => {
    expect(runSourceFromRequest(req({ source: "tui" }))).toEqual({ source: "tui" });
  });

  it("derives 'web' from metadata.source === 'web'", () => {
    expect(runSourceFromRequest(req({ source: "web", web: { threadId: "thread-1" } }))).toEqual({
      source: "web",
    });
  });

  it("derives 'cron' + sourceDetail from metadata.cron.jobId", () => {
    expect(runSourceFromRequest(req({ cron: { jobId: "nightly-digest" } }))).toEqual({
      source: "cron",
      sourceDetail: "nightly-digest",
    });
  });

  it("derives 'cron' without sourceDetail when jobId is not a string", () => {
    expect(runSourceFromRequest(req({ cron: { jobId: 42 } }))).toEqual({ source: "cron" });
  });

  it("derives 'webhook' + sourceDetail from metadata.webhook.endpointName", () => {
    expect(runSourceFromRequest(req({ webhook: { endpointName: "my-endpoint" } }))).toEqual({
      source: "webhook",
      sourceDetail: "my-endpoint",
    });
  });

  it("derives 'slack' and 'telegram' from their metadata blocks", () => {
    expect(runSourceFromRequest(req({ slack: { channel: "C1" } }))).toEqual({ source: "slack" });
    expect(runSourceFromRequest(req({ telegram: { chatId: 1 } }))).toEqual({ source: "telegram" });
  });

  it("falls back to conversationId-prefix derivation for absent/unknown metadata", () => {
    expect(runSourceFromRequest(req(undefined, "telegram:123"))).toEqual({ source: "telegram" });
    expect(runSourceFromRequest(req({ somethingElse: true }, "webhook:my-endpoint"))).toEqual({ source: "webhook" });
    expect(runSourceFromRequest(req(undefined, "tui-local"))).toEqual({ source: "tui" });
    expect(runSourceFromRequest(req(undefined, "openai-api:resp-123"))).toEqual({ source: "openai-api" });
  });

  it("never throws on unusual metadata shapes", () => {
    expect(() => runSourceFromRequest(req({ cron: "not-a-record" } as never))).not.toThrow();
    expect(() => runSourceFromRequest(req(null as never))).not.toThrow();
  });
});

describe("requestOverridesModel", () => {
  const defaultModel = parseMonoRuntimeModelReference("claude:claude-fable-5");
  function req(metadata?: Record<string, unknown>): AgentHarnessRequest {
    return { conversationId: "c", text: "hi", ...(metadata === undefined ? {} : { metadata }) } as unknown as AgentHarnessRequest;
  }

  it("returns true for a tui model override that differs from the default", () => {
    expect(requestOverridesModel(req({ tui: { model: "claude:claude-opus-4-8" } }), defaultModel)).toBe(true);
  });

  it("returns true for a web model override that differs from the default", () => {
    expect(requestOverridesModel(req({ web: { model: "claude:claude-opus-4-8" } }), defaultModel)).toBe(true);
  });

  it("returns true for a Telegram model override that differs from the default", () => {
    expect(requestOverridesModel(req({ telegram: { model: "claude:claude-opus-4-8" } }), defaultModel)).toBe(true);
  });

  it("keeps the shared session for same-model and effort-only Telegram overrides", () => {
    expect(requestOverridesModel(req({ telegram: { model: "claude:claude-fable-5" } }), defaultModel)).toBe(false);
    expect(requestOverridesModel(req({ telegram: { effort: "high" } }), defaultModel)).toBe(false);
  });

  it("prefers the web override over its compatibility TUI mirror", () => {
    expect(requestOverridesModel(req({
      web: { model: "claude:claude-fable-5" },
      tui: { model: "claude:claude-opus-4-8" },
    }), defaultModel)).toBe(false);
  });

  it("returns false for a tui model override equal to the default", () => {
    expect(requestOverridesModel(req({ tui: { model: "claude:claude-fable-5" } }), defaultModel)).toBe(false);
  });

  it("returns false for a tui effort-only override (no model string)", () => {
    expect(requestOverridesModel(req({ tui: { effort: "high" } }), defaultModel)).toBe(false);
  });

  it("returns false for an unparseable tui model override", () => {
    expect(requestOverridesModel(req({ tui: { model: "not a model" } }), defaultModel)).toBe(false);
  });

  it("still honors webhook and cron overrides alongside tui", () => {
    expect(requestOverridesModel(req({ webhook: { model: "codex:gpt-5.5" } }), defaultModel)).toBe(true);
    expect(requestOverridesModel(req({ cron: { model: "codex:gpt-5.5" } }), defaultModel)).toBe(true);
  });
});

describe("AgentHarness recorderFactory source/sourceDetail plumbing", () => {
  it("passes source 'cron' + sourceDetail (jobId) for a cron-metadata request", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const factoryInputs: AgentHarnessRecorderFactoryInput[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      recorderFactory: (input) => {
        factoryInputs.push(input);
        return new SpyRecorder();
      },
    });

    await harness.run({
      conversationId: "conv-cron",
      userMessage: "tick",
      abortSignal: new AbortController().signal,
      metadata: { cron: { jobId: "nightly" } },
    });

    expect(factoryInputs[0]?.source).toBe("cron");
    expect(factoryInputs[0]?.sourceDetail).toBe("nightly");
  });

  it("passes source 'webhook' + sourceDetail (endpointName) for a webhook-metadata request", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const factoryInputs: AgentHarnessRecorderFactoryInput[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      recorderFactory: (input) => {
        factoryInputs.push(input);
        return new SpyRecorder();
      },
    });

    await harness.run({
      conversationId: "conv-webhook",
      userMessage: "fire",
      abortSignal: new AbortController().signal,
      metadata: { webhook: { endpointName: "deploy-hook" } },
    });

    expect(factoryInputs[0]?.source).toBe("webhook");
    expect(factoryInputs[0]?.sourceDetail).toBe("deploy-hook");
  });

  it("passes source 'tui' with no sourceDetail for a tui-metadata request", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const factoryInputs: AgentHarnessRecorderFactoryInput[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      recorderFactory: (input) => {
        factoryInputs.push(input);
        return new SpyRecorder();
      },
    });

    await harness.run({
      conversationId: "tui-local",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
      metadata: { source: "tui" },
    });

    expect(factoryInputs[0]?.source).toBe("tui");
    expect(factoryInputs[0]?.sourceDetail).toBeUndefined();
  });

  it("falls back to conversationId-prefix derivation for undefined/other metadata", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const factoryInputs: AgentHarnessRecorderFactoryInput[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      recorderFactory: (input) => {
        factoryInputs.push(input);
        return new SpyRecorder();
      },
    });

    await harness.run({
      conversationId: "telegram:99",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
    });

    expect(factoryInputs[0]?.source).toBe("telegram");
    expect(factoryInputs[0]?.sourceDetail).toBeUndefined();
  });
});

describe("AgentHarness run_config synthetic event", () => {
  it("emits run_config to both recorder.onEvent and the host onEvent with resolved model/effort/executionMode, overridden:false", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      effort: "low",
      recorderFactory: () => recorder,
    });

    const hostEvents: RuntimeEventLike[] = [];
    await harness.run({
      conversationId: "conv-1",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
      onEvent: (event) => hostEvents.push(event),
    });

    const recorderRunConfig = recorder.events.find((event) => event.type === "run_config");
    const hostRunConfig = hostEvents.find((event) => event.type === "run_config");
    expect(recorderRunConfig).toBeDefined();
    expect(hostRunConfig).toBeDefined();
    expect(recorderRunConfig).toMatchObject({
      type: "run_config",
      model: "pi:openai-codex:gpt-5.5",
      effort: "low",
      executionMode: "sdk",
      overridden: false,
    });
    expect(typeof recorderRunConfig?.timestamp).toBe("string");
    expect(hostRunConfig).toMatchObject(recorderRunConfig as Record<string, unknown>);
  });

  it("marks overridden:true and uses the resolved override effort for a per-request effort override", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      effort: "low",
      recorderFactory: () => recorder,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { effort: "high" } }),
    });

    const hostEvents: RuntimeEventLike[] = [];
    await harness.run({
      conversationId: "conv-2",
      userMessage: "tick",
      abortSignal: new AbortController().signal,
      metadata: { cron: { jobId: "nightly", effort: "high" } },
      onEvent: (event) => hostEvents.push(event),
    });

    const recorderRunConfig = recorder.events.find((event) => event.type === "run_config");
    expect(recorderRunConfig).toMatchObject({ effort: "high", overridden: true });
    const hostRunConfig = hostEvents.find((event) => event.type === "run_config");
    expect(hostRunConfig).toMatchObject({ effort: "high", overridden: true });
  });
});

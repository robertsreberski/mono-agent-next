import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createChannelUserCancelReason } from "@mono-agent/agent-contracts";
import type {
  AgentContinuationOriginContext,
  MemoryCompletedTurn,
  MemoryCompletedTurnResult,
  MemoryStore,
} from "@mono-agent/agent-contracts";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";
import { createSandboxPolicy } from "@mono-agent/runtime-adapter";

import {
  AgentHarnessFailureError,
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "../index.js";
import type { ExternalRunSummary } from "../index.js";

type ExternalRunSummaryOmitsSystemPrompt =
  "systemPrompt" extends keyof ExternalRunSummary ? false : true;
const externalRunSummaryOmitsSystemPrompt: ExternalRunSummaryOmitsSystemPrompt = true;

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeRecorder implements RunRecorder {
  readonly events: RuntimeEventLike[] = [];
  startCount = 0;
  summaryStatus?: string;
  systemPrompt?: string;

  constructor(
    private readonly runId: string,
    private readonly conversationId: string,
    private readonly forcedSystemPrompt?: string,
  ) {}

  onEvent(event: RuntimeEventLike): void {
    this.events.push(event);
  }

  async start(): Promise<RunSummary> {
    this.startCount += 1;
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status: "running",
      durationMs: 0,
      eventCount: this.events.length,
      artifactPaths: [],
    };
  }

  async finish(result: RuntimeResultLike): Promise<RunSummary> {
    const systemPrompt = result.systemPrompt ?? this.forcedSystemPrompt;
    if (systemPrompt !== undefined) {
      this.systemPrompt = systemPrompt;
    }
    const status = result.cancelled === true ? "cancelled" : result.failureKind !== undefined || result.error !== undefined ? "failed" : "succeeded";
    this.summaryStatus = status;
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(result.failureKind === undefined || result.failureKind === null ? {} : { failureKind: result.failureKind }),
      durationMs: 1,
      ...(result.cost === undefined ? {} : { cost: result.cost }),
      eventCount: this.events.length,
      artifactPaths: [],
      ...(result.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: result.capabilitiesUsed }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    };
  }

  async fail(error: unknown): Promise<RunSummary> {
    this.summaryStatus = "failed";
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status: "failed",
      failureKind: error instanceof Error ? error.name : "exception",
      durationMs: 1,
      eventCount: this.events.length,
      artifactPaths: [],
    };
  }
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

describe("AgentHarness", () => {
  it("feeds live follow-ups into the active runtime and commits them into durable history", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    let runtimeStarted!: () => void;
    const started = new Promise<void>((resolve) => { runtimeStarted = resolve; });
    const seen: string[] = [];
    const fake = createFakeRuntime(async (_prompt, options) => {
      runtimeStarted();
      const iterator = options.liveInput?.[Symbol.asyncIterator]();
      if (iterator === undefined) throw new Error("Expected live input for the Pi runtime.");
      const next = await iterator.next();
      if (next.done) throw new Error("Live input closed before delivery.");
      seen.push(next.value.body);
      next.value.acknowledge?.();
      return { text: "Updated answer" };
    });
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      historyStore,
      createRunId: () => "run-live",
    });
    const running = harness.run({
      conversationId: "telegram:42",
      userMessage: "Initial request",
      abortSignal: new AbortController().signal,
    });
    await started;

    const offered = harness.offerLiveInput?.({
      conversationId: "telegram:42",
      id: "input-1",
      text: "Use the new constraint",
      receivedAt: "2026-07-21T09:00:00.000Z",
    });
    expect(offered?.status).toBe("accepted");
    await expect(running).resolves.toMatchObject({ text: "Updated answer" });
    if (offered?.status === "accepted") {
      await expect(offered.settled).resolves.toEqual({ status: "applied", runId: "run-live" });
    }
    expect(seen).toEqual(["Use the new constraint"]);
    expect(await historyStore.load("telegram:42")).toMatchObject([
      { role: "user", content: "Initial request", runId: "run-live" },
      { role: "user", content: "Use the new constraint", timestamp: "2026-07-21T09:00:00.000Z", runId: "run-live" },
      { role: "assistant", content: "Updated answer", runId: "run-live" },
    ]);
  });

  it("preserves an explicit request runtime live-input source", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const explicitLiveInput = {
      async *[Symbol.asyncIterator]() {
        yield { id: "custom-1", body: "Custom host guidance" };
      },
    };
    const fake = createFakeRuntime(async (_prompt, options) => {
      expect(options.liveInput).toBe(explicitLiveInput);
      return { text: "Done" };
    });
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { liveInput: explicitLiveInput } }),
    });

    await expect(harness.run({
      conversationId: "custom:live-input",
      userMessage: "Initial request",
      abortSignal: new AbortController().signal,
    })).resolves.toMatchObject({ text: "Done" });
  });

  it("keeps the compiled system prompt in recorded summaries but never returns it to channel callers", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const recorder = new FakeRecorder("run-private-prompt", "webhook:1");
    const fake = createFakeRuntime(async () => ({ text: "ready" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      recorderFactory: () => recorder,
      createRunId: () => "run-private-prompt",
    });

    const response = await harness.run({
      conversationId: "webhook:1",
      userMessage: "Check readiness.",
      abortSignal: new AbortController().signal,
    });

    expect(recorder.systemPrompt).toContain("You are Mono.");
    expect(response.metadata.summary).not.toHaveProperty("systemPrompt");
    expect(externalRunSummaryOmitsSystemPrompt).toBe(true);
  });

  it("returns a serialization-safe deep copy of a custom recorder summary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const privatePrompt = "private prompt from callable serialization";
    const recorderCost = { totalUsd: 0.01 };
    const cyclicDiagnostics: Record<string, unknown> = {};
    cyclicDiagnostics.self = cyclicDiagnostics;
    const customPrototypeCapabilities = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
      retained: true,
    });
    const unsafeSummary = {
      runId: "run-unsafe-summary",
      conversationId: "webhook:unsafe-summary",
      status: "succeeded",
      durationMs: 1,
      eventCount: 0,
      artifactPaths: [],
      cost: recorderCost,
      usage: { left: recorderCost, right: recorderCost },
      runtimeWarnings: cyclicDiagnostics,
      capabilitiesUsed: customPrototypeCapabilities,
      diagnostics: {
        toJSON() {
          return { systemPrompt: privatePrompt };
        },
      },
      systemPrompt: privatePrompt,
      toJSON() {
        return { runId: this.runId, systemPrompt: privatePrompt };
      },
    } as RunSummary & { toJSON(): unknown };
    const recorder: RunRecorder = {
      onEvent() {},
      async finish() {
        return unsafeSummary;
      },
      async fail() {
        return unsafeSummary;
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "ready" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      recorderFactory: () => recorder,
      createRunId: () => "run-unsafe-summary",
    });

    const response = await harness.run({
      conversationId: "webhook:unsafe-summary",
      userMessage: "Check the boundary.",
      abortSignal: new AbortController().signal,
    });
    const externalCost = response.metadata.summary?.cost as { totalUsd: number } | undefined;
    const externalUsage = response.metadata.summary?.usage as {
      left: { totalUsd: number };
      right: { totalUsd: number };
    } | undefined;

    expect(response.metadata.summary).not.toHaveProperty("systemPrompt");
    expect(response.metadata.summary).not.toHaveProperty("toJSON");
    expect(response.metadata.summary).not.toHaveProperty("diagnostics");
    expect(response.metadata.summary).not.toHaveProperty("runtimeWarnings");
    expect(response.metadata.summary).not.toHaveProperty("capabilitiesUsed");
    expect(JSON.stringify(response)).not.toContain(privatePrompt);
    expect(externalCost).toEqual({ totalUsd: 0.01 });
    recorderCost.totalUsd = 99;
    expect(externalCost).toEqual({ totalUsd: 0.01 });
    if (externalCost !== undefined) externalCost.totalUsd = 0.02;
    if (externalUsage !== undefined) externalUsage.left.totalUsd = 0.03;
    expect(externalUsage?.right).toEqual({ totalUsd: 0.01 });
    expect(recorderCost.totalUsd).toBe(99);
  });

  it.each(["success", "pre-runtime cancellation", "runtime failure"])(
    "omits an invalid required summary shape on %s without invoking its serializer",
    async (responsePath) => {
      const dir = await tempDir();
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      const privatePrompt = `private required-field prompt (${responsePath})`;
      let serializerCalls = 0;
      const invalidRunId = {
        toJSON() {
          serializerCalls += 1;
          return { systemPrompt: privatePrompt };
        },
      };
      const unsafeSummary = {
        runId: invalidRunId,
        conversationId: "webhook:unsafe-required",
        status: "succeeded",
        durationMs: 1,
        eventCount: 0,
        artifactPaths: [],
      } as unknown as RunSummary;
      const recorder: RunRecorder = {
        onEvent() {},
        async finish() {
          return unsafeSummary;
        },
        async fail() {
          return unsafeSummary;
        },
      };
      const fake = createFakeRuntime(async () => {
        if (responsePath === "runtime failure") throw new Error("runtime failed");
        return { text: "ready" };
      });
      const harness = createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        cwd: dir,
        recorderFactory: () => recorder,
        createRunId: () => "outer-safe-run-id",
      });
      const controller = new AbortController();
      if (responsePath === "pre-runtime cancellation") {
        controller.abort(new Error("cancelled before context assembly"));
      }

      const response = await harness.run({
        conversationId: "webhook:unsafe-required",
        userMessage: "Check the boundary.",
        abortSignal: controller.signal,
      });

      expect(response.metadata.summary).toBeUndefined();
      expect(serializerCalls).toBe(0);
      expect(JSON.stringify(response)).not.toContain(privatePrompt);
    },
  );

  it("reads a custom recorder summary through descriptors and fails unsafe properties closed", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let optionalGetterCalls = 0;
    const summaryWithOptionalGetter = {
      runId: "run-optional-getter",
      conversationId: "webhook:optional-getter",
      status: "succeeded",
      durationMs: 1,
      eventCount: 0,
      artifactPaths: [],
    } as RunSummary;
    Object.defineProperty(summaryWithOptionalGetter, "cost", {
      enumerable: true,
      get() {
        optionalGetterCalls += 1;
        return { totalUsd: 0.01 };
      },
    });
    const optionalGetterRecorder: RunRecorder = {
      onEvent() {},
      async finish() {
        return summaryWithOptionalGetter;
      },
      async fail() {
        return summaryWithOptionalGetter;
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "ready" }));
    const getterHarness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      recorderFactory: () => optionalGetterRecorder,
    });

    const getterResponse = await getterHarness.run({
      conversationId: "webhook:optional-getter",
      userMessage: "Check the boundary.",
      abortSignal: new AbortController().signal,
    });

    expect(getterResponse.metadata.summary).toMatchObject({ runId: "run-optional-getter" });
    expect(getterResponse.metadata.summary).not.toHaveProperty("cost");
    expect(optionalGetterCalls).toBe(0);

    let requiredGetterCalls = 0;
    const summaryWithRequiredGetter = {
      runId: "run-required-getter",
      conversationId: "webhook:required-getter",
      status: "succeeded",
      durationMs: 1,
      eventCount: 0,
    } as unknown as RunSummary;
    Object.defineProperty(summaryWithRequiredGetter, "artifactPaths", {
      enumerable: true,
      get() {
        requiredGetterCalls += 1;
        throw new Error("required getter must not run");
      },
    });
    const requiredGetterRecorder: RunRecorder = {
      onEvent() {},
      async finish() {
        return summaryWithRequiredGetter;
      },
      async fail() {
        return summaryWithRequiredGetter;
      },
    };
    const requiredGetterHarness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      recorderFactory: () => requiredGetterRecorder,
    });

    const requiredGetterResponse = await requiredGetterHarness.run({
      conversationId: "webhook:required-getter",
      userMessage: "Check the boundary.",
      abortSignal: new AbortController().signal,
    });

    expect(requiredGetterResponse.metadata.summary).toBeUndefined();
    expect(requiredGetterCalls).toBe(0);

    let inheritedSerializerCalls = 0;
    const customPrototype = {
      toJSON() {
        inheritedSerializerCalls += 1;
        return { systemPrompt: "private inherited prompt" };
      },
    };
    const customSummary = Object.assign(Object.create(customPrototype) as Record<string, unknown>, {
      runId: "run-custom-prototype",
      conversationId: "webhook:custom-prototype",
      status: "succeeded",
      durationMs: 1,
      eventCount: 0,
      artifactPaths: [],
    }) as unknown as RunSummary;
    const customRecorder: RunRecorder = {
      onEvent() {},
      async finish() {
        return customSummary;
      },
      async fail() {
        return customSummary;
      },
    };
    const customHarness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      recorderFactory: () => customRecorder,
    });

    const customResponse = await customHarness.run({
      conversationId: "webhook:custom-prototype",
      userMessage: "Check the boundary.",
      abortSignal: new AbortController().signal,
    });

    expect(customResponse.metadata.summary).toBeUndefined();
    expect(inheritedSerializerCalls).toBe(0);
    expect(JSON.stringify(customResponse)).not.toContain("private inherited prompt");
  });

  it("sanitizes an unsafe custom recorder summary on pre-runtime cancellation", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const recorder = new FakeRecorder(
      "run-cancelled-before-context",
      "webhook:cancelled",
      "private prompt returned by a custom recorder",
    );
    const fake = createFakeRuntime(async () => ({ text: "must not run" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      recorderFactory: () => recorder,
      createRunId: () => "run-cancelled-before-context",
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before context assembly"));

    const response = await harness.run({
      conversationId: "webhook:cancelled",
      userMessage: "Do not run.",
      abortSignal: controller.signal,
    });

    expect(fake.calls).toHaveLength(0);
    expect(recorder.systemPrompt).toBe("private prompt returned by a custom recorder");
    expect(response.failure).toMatchObject({ kind: "cancelled" });
    expect(response.metadata.summary).toMatchObject({
      runId: "run-cancelled-before-context",
      status: "cancelled",
    });
    expect(response.metadata.summary).not.toHaveProperty("systemPrompt");
  });

  it("assembles context, memory, history, selected skills, tool policy, and runtime metadata", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "research"), { recursive: true });
    await writeFile(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nFind evidence.", "utf8");
    const recorder = new FakeRecorder("run-1", "telegram:1");
    const memory = {
      async load() {
        return { kind: "markdown" as const, content: "Remember: terse.", source: join(dir, "memory.md"), truncated: false };
      },
      async appendHostSummary() {
        throw new Error("memory writes should be disabled by default");
      },
    };
    const historyStore = createInMemoryHistoryStore({ maxMessages: 4 });
    await historyStore.append("telegram:1", [{ role: "assistant", content: "Earlier answer", timestamp: "2026-05-15T18:00:00Z" }]);
    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "delta" }] } });
      return {
        text: "Final answer",
        providerSessionId: "session-1",
        usage: { inputTokens: 1 },
        cost: { totalUsd: 0.01 },
        capabilitiesUsed: ["tools:read"],
      };
    });

    const harness = createAgentHarness({
      identityPath,
      skillsRoot,
      selectedSkills: ["research"],
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      cwd: dir,
      maxTurns: 3,
      memory,
      historyStore,
      toolPolicy: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
      recorderFactory: () => recorder,
      createRunId: () => "run-1",
    });

    const response = await harness.run({
      conversationId: "telegram:1",
      replyTo: { conversationId: "telegram:1" },
      userMessage: "What changed?",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Final answer");
    expect(response.failure).toBeUndefined();
    expect(response.metadata.summary).toMatchObject({
      status: "succeeded",
      // The memory_recalled diagnostic, the assistant event, and the synthetic
      // run_config + turn_context + provider_bridge_latency observability events.
      eventCount: 5,
      cost: { totalUsd: 0.01 },
      capabilitiesUsed: ["tools:read"],
    });
    expect(recorder.startCount).toBe(1);
    expect(response.metadata.runtime).toMatchObject({ cost: { totalUsd: 0.01 }, capabilitiesUsed: ["tools:read"] });
    // Recalled memory no longer lives in the system prompt, so it is not a context
    // section/source — it rides on the user message instead (asserted below).
    expect(response.metadata.contextSectionIds).toEqual(["core", "identity", "session", "history", "skills", "skill-instructions", "user-message"]);
    expect(response.metadata.contextSources).toEqual([join(dir, "IDENTITY.md"), join(skillsRoot, "research", "SKILL.md")]);
    expect(fake.calls).toHaveLength(1);
    // Recalled memory is appended to the user message, NOT the system prompt.
    expect(String(fake.calls[0]?.options.messages?.[0]?.content)).toContain("Remember: terse.");
    expect(fake.calls[0]?.prompt).not.toContain("Remember: terse.");
    expect(fake.calls[0]?.prompt).toContain("Earlier answer");
    // The deliverable conversation gets host-owned continuation guidance without
    // exposing its physical route to the model.
    expect(fake.calls[0]?.prompt).toContain("The host owns its exact channel and thread destination");
    expect(fake.calls[0]?.prompt).toContain("continuation-capable tool explicitly confirms");
    expect(fake.calls[0]?.prompt).not.toContain("telegram:1");
    expect(fake.calls[0]?.prompt).toContain("# Skill: research");
    expect(fake.calls[0]?.options).toMatchObject({ allowedTools: ["Read"], disallowedTools: ["Bash"], maxTurns: 3 });
    await expect(historyStore.load("telegram:1")).resolves.toHaveLength(3);
  });

  it("classifies push delivery structurally without exposing routing ids", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));
    let runNumber = 0;
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      createRunId: () => `run-delivery-${String(runNumber += 1)}`,
    });
    type DeliveryScenario = {
      readonly name: string;
      readonly conversationId: string;
      readonly replyTo?: { readonly conversationId: string };
      readonly metadata?: Record<string, unknown>;
      readonly expected: "interactive" | "request-driven";
    };
    const scenarios: readonly DeliveryScenario[] = [
      {
        name: "WhatsApp push conversation",
        conversationId: "whatsapp:123@s.whatsapp.net",
        replyTo: { conversationId: "whatsapp:123@s.whatsapp.net" },
        expected: "interactive",
      },
      {
        name: "third-party push conversation",
        conversationId: "discord:channel-7",
        replyTo: { conversationId: "discord:channel-7" },
        expected: "interactive",
      },
      {
        name: "OpenAI API request",
        conversationId: "openai-api:request-1",
        metadata: { openaiApi: { requestId: "request-1" } },
        expected: "request-driven",
      },
      {
        name: "TUI request",
        conversationId: "operator-session-1",
        metadata: { source: "tui", tuiRequestId: "tui-request-1" },
        expected: "request-driven",
      },
      {
        name: "notify-enabled cron request",
        conversationId: "cron:daily-brief",
        replyTo: { conversationId: "whatsapp:notify@s.whatsapp.net" },
        metadata: { cron: { jobId: "daily-brief", nativeNotify: { enabled: true } } },
        expected: "request-driven",
      },
      {
        name: "notify-enabled webhook request",
        conversationId: "webhook:deploy-event",
        replyTo: { conversationId: "telegram:42" },
        metadata: { webhook: { endpointName: "deploy-event", nativeNotify: { enabled: true } } },
        expected: "request-driven",
      },
    ];

    for (const scenario of scenarios) {
      await harness.run({
        conversationId: scenario.conversationId,
        userMessage: "Classify this turn.",
        abortSignal: new AbortController().signal,
        ...(scenario.replyTo === undefined ? {} : { replyTo: scenario.replyTo }),
        ...(scenario.metadata === undefined ? {} : { metadata: scenario.metadata }),
      });
      const prompt = fake.calls.at(-1)?.prompt ?? "";
      if (scenario.expected === "interactive") {
        expect(prompt, scenario.name).toContain("You are handling an interactive push conversation");
        expect(prompt, scenario.name).not.toContain("This is a request-driven run");
      } else {
        expect(prompt, scenario.name).toContain("This is a request-driven run");
        expect(prompt, scenario.name).not.toContain("You are handling an interactive push conversation");
      }
      expect(prompt, scenario.name).not.toContain(scenario.conversationId);
      if (scenario.replyTo !== undefined) {
        expect(prompt, scenario.name).not.toContain(scenario.replyTo.conversationId);
      }
    }
  });

  it("enriches only durable assistant history while preserving outward text and memory text", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const summaries: string[] = [];
    const releases: Array<{ runId: string; conversationId: string }> = [];
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      createRunId: () => "run-interaction-history",
      historyStore,
      memoryWriteMode: "append-host-summary",
      memory: {
        async load() {
          return undefined;
        },
        async appendHostSummary(_conversationId: string, summary: string) {
          summaries.push(summary);
          return { conversationId: "telegram:42#today", source: "memory.md", bytesWritten: summary.length };
        },
      },
      turnHistoryEnricher: {
        enrichAssistantHistory(input) {
          expect(input).toEqual({
            runId: "run-interaction-history",
            conversationId: "telegram:42#today",
            assistantText: "Final answer",
          });
          return `[Interaction transcript]\nQuestion: Deploy?\nOutcome: answered\n\n${input.assistantText}`;
        },
        releaseRun(input) {
          releases.push(input);
        },
      },
    });

    const response = await harness.run({
      conversationId: "telegram:42#today",
      userMessage: "Prepare the deployment.",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Final answer");
    const history = await historyStore.load("telegram:42#today");
    expect(history.at(-1)?.content).toBe(
      "[Interaction transcript]\nQuestion: Deploy?\nOutcome: answered\n\nFinal answer",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("Assistant: Final answer");
    expect(summaries[0]).not.toContain("Interaction transcript");
    expect(releases).toEqual([{ runId: "run-interaction-history", conversationId: "telegram:42#today" }]);
  });

  it("replays an exact interaction transcript into a following cold turn", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const runIds = ["run-ask", "run-follow-up"];
    const fake = createFakeRuntime(async () => ({ text: "Held—nothing was sent." }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      cwd: dir,
      historyStore,
      createRunId: () => runIds.shift() ?? "run-extra",
      turnHistoryEnricher: {
        enrichAssistantHistory(input) {
          return input.runId === "run-ask"
            ? `[Interaction transcript]\nTool: AskUser\nQuestion: Send the complete bank details including BIC and email?\nOptions: Send it | Hold on\nOutcome: answered\nAnswer: Hold on\n\n${input.assistantText}`
            : input.assistantText;
        },
        releaseRun() {},
      },
    });

    await harness.run({
      conversationId: "telegram:42#2026-07-12",
      userMessage: "Prepare the complete message.",
      abortSignal: new AbortController().signal,
    });
    await harness.run({
      conversationId: "telegram:42#2026-07-12",
      userMessage: "Now you also lost BIC and the email. All need to be there",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.prompt).toContain("Send the complete bank details including BIC and email?");
    expect(fake.calls[1]?.prompt).toContain("Answer: Hold on");
    expect(fake.calls[1]?.prompt).toContain("Held—nothing was sent.");
  });

  it("falls back to original history text when enrichment fails and still releases failed runs", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const releases: string[] = [];
    const successfulHarness = createAgentHarness({
      identityPath,
      runtime: createFakeRuntime(async () => ({ text: "Original answer" })).runtime,
      model,
      cwd: dir,
      createRunId: () => "run-enrichment-failure",
      historyStore,
      turnHistoryEnricher: {
        enrichAssistantHistory() {
          throw new Error("journal unavailable");
        },
        releaseRun({ runId }) {
          releases.push(runId);
        },
      },
    });

    const response = await successfulHarness.run({
      conversationId: "telegram:42",
      userMessage: "Continue.",
      abortSignal: new AbortController().signal,
    });
    expect(response.text).toBe("Original answer");
    expect((await historyStore.load("telegram:42")).at(-1)?.content).toBe("Original answer");

    const failedHarness = createAgentHarness({
      identityPath,
      runtime: createFakeRuntime(async () => {
        throw new Error("provider failed");
      }).runtime,
      model,
      cwd: dir,
      createRunId: () => "run-provider-failure",
      turnHistoryEnricher: {
        enrichAssistantHistory(text) {
          return text.assistantText;
        },
        releaseRun({ runId }) {
          releases.push(runId);
          throw new Error("cleanup failed");
        },
      },
    });
    const failure = await failedHarness.run({
      conversationId: "telegram:42",
      userMessage: "Continue.",
      abortSignal: new AbortController().signal,
    });

    expect(failure.failure).toBeDefined();
    expect(releases).toEqual(["run-enrichment-failure", "run-provider-failure"]);
  });

  it("injects native-notify delivery guidance for a notify-enabled cron turn (and omits it otherwise)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Digest" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, cwd: dir });

    await harness.run({
      conversationId: "cron:digest",
      userMessage: "Produce the digest.",
      abortSignal: new AbortController().signal,
      replyTo: { conversationId: "slack:C0123456789:1720000000.000001" },
      metadata: { cron: { jobId: "digest", nativeNotify: { enabled: true } } },
    });
    const notifyPrompt = fake.calls[0]?.prompt ?? "";
    expect(notifyPrompt).toContain("your final reply is delivered to the user");
    expect(notifyPrompt).toContain("delivery is automatic and posts your reply verbatim");
    expect(notifyPrompt).toContain("NOTHING_TO_REPORT");
    expect(notifyPrompt).not.toContain("C0123456789");
    expect(notifyPrompt).not.toContain("1720000000.000001");

    await harness.run({
      conversationId: "cron:maintenance",
      userMessage: "Run maintenance.",
      abortSignal: new AbortController().signal,
      metadata: { cron: { jobId: "maintenance" } },
    });
    expect(fake.calls[1]?.prompt ?? "").not.toContain("NOTHING_TO_REPORT");
  });

  it("appendVerbatimTurn records a delivered notification to history without a model call", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createFakeRuntime(async () => ({ text: "unused" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, cwd: dir, historyStore });

    await harness.appendVerbatimTurn?.("telegram:42", "Your morning brief.");

    const history = await historyStore.load("telegram:42");
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.at(-1)?.content).toBe("Your morning brief.");
    // No model turn ran — delivery happened in the channel, this only records it.
    expect(fake.calls).toHaveLength(0);
  });

  it("appendVerbatimTurn is idempotent by host delivery key and rejects conflicting content", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createFakeRuntime(async () => ({ text: "unused" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, cwd: dir, historyStore });

    await harness.appendVerbatimTurn?.("slack:D1:1.1", "Confirmed answer", { idempotencyKey: "continuation:one" });
    await harness.appendVerbatimTurn?.("slack:D1:1.1", "Confirmed answer", { idempotencyKey: "continuation:one" });
    await expect(harness.appendVerbatimTurn?.(
      "slack:D1:1.1",
      "Conflicting answer",
      { idempotencyKey: "continuation:one" },
    )).rejects.toThrow(/idempotency key conflicts/u);

    const history = await historyStore.load("slack:D1:1.1");
    expect(history).toHaveLength(2);
    expect(history.at(-1)).toMatchObject({
      role: "assistant",
      content: "Confirmed answer",
      idempotencyKey: "continuation:one",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("lists every discovered skill in the index while inlining only the selected skill bodies", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "research"), { recursive: true });
    await writeFile(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nFind evidence.", "utf8");
    await mkdir(join(skillsRoot, "writing"), { recursive: true });
    await writeFile(join(skillsRoot, "writing", "SKILL.md"), "# Writing\n\nDraft concise prose.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const harness = createAgentHarness({
      identityPath,
      skillsRoot,
      selectedSkills: ["research"],
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      cwd: dir,
    });

    await harness.run({ conversationId: "telegram:1", userMessage: "hi", abortSignal: new AbortController().signal });

    const prompt = fake.calls[0]?.prompt ?? "";
    // The index lists BOTH discovered skills, not just the selected one.
    expect(prompt).toContain("- **research** — Find evidence.");
    expect(prompt).toContain("- **writing** — Draft concise prose.");
    // Only the selected skill's full body is inlined.
    expect(prompt).toContain("# Skill: research");
    expect(prompt).not.toContain("# Skill: writing");
  });

  it("recalls memory using the user message as the query, not the conversation id", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const recalls: Array<{ conversationId: string; query: string | undefined; turnId?: string }> = [];
    const releasedTurns: string[] = [];
    const memory = {
      async load(conversationId: string, query?: string, options?: { readonly turnId?: string }) {
        recalls.push({ conversationId, query, ...(options?.turnId === undefined ? {} : { turnId: options.turnId }) });
        return undefined;
      },
      async appendHostSummary() {
        return { conversationId: "telegram:1", source: "", bytesWritten: 0 };
      },
      releaseTurn(turnId: string) {
        releasedTurns.push(turnId);
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      cwd: dir,
      memory,
    });

    await harness.run({
      conversationId: "telegram:1",
      userMessage: "What did we decide about pricing?",
      abortSignal: new AbortController().signal,
    });

    expect(recalls).toEqual([{
      conversationId: "telegram:1",
      query: "What did we decide about pricing?",
      turnId: releasedTurns[0],
    }]);
    expect(releasedTurns).toHaveLength(1);
  });

  it("does not append a recalled-memory block when recall returns nothing", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const memory = {
      async load() {
        return undefined;
      },
      async appendHostSummary() {
        return { conversationId: "telegram:1", source: "", bytesWritten: 0 };
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      cwd: dir,
      memory,
    }).run({
      conversationId: "telegram:1",
      userMessage: "What changed?",
      abortSignal: new AbortController().signal,
    });

    // No hits → the user message is sent verbatim, with no memory delimiter.
    expect(String(fake.calls[0]?.options.messages?.[0]?.content)).toBe("What changed?");
    expect(String(fake.calls[0]?.options.messages?.[0]?.content)).not.toContain("Recalled long-term memory");
  });

  it("does not persist the recalled-memory block injected into the user message", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const summaries: string[] = [];
    const memory = {
      async load() {
        return { kind: "markdown" as const, content: "## Memory (recalled)\n- [ ] ship the docs", source: "memory.md", truncated: false };
      },
      async appendHostSummary(_id: string, summary: string) {
        summaries.push(summary);
        return { conversationId: "telegram:1", source: "memory.md", bytesWritten: summary.length };
      },
    };
    const historyStore = createInMemoryHistoryStore({ maxMessages: 4 });
    const fake = createFakeRuntime(async () => ({ text: "Done." }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      cwd: dir,
      memory,
      memoryWriteMode: "append-host-summary",
      historyStore,
    }).run({
      conversationId: "telegram:1",
      userMessage: "What changed?",
      abortSignal: new AbortController().signal,
    });

    // The recalled memory rode on the provider-facing user message...
    expect(String(fake.calls[0]?.options.messages?.[0]?.content)).toContain("ship the docs");
    // ...but must NOT leak into the persisted host summary or durable history.
    expect(summaries.join("\n")).not.toContain("ship the docs");
    expect(summaries.join("\n")).toContain("User: What changed?");
    const persisted = await historyStore.load("telegram:1");
    expect(persisted.map((m) => m.content).join("\n")).not.toContain("ship the docs");
  });

  it("propagates runtime failure results without success text", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ error: "Provider limit", failureKind: "usage_limit" }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      createRunId: () => "run-fail",
    }).run({ conversationId: "c", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(response.text).toBeUndefined();
    expect(response.failure).toMatchObject({ kind: "usage_limit", message: "Provider limit" });
    expect(response.metadata.summary).toMatchObject({ status: "failed", failureKind: "usage_limit" });
  });

  it("merges request-scoped runtime options and cleans them up after runtime execution", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const cleanupCalls: string[] = [];
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      runtimeOptions: {
        allowedTools: ["Read"],
        mcpServers: {
          static: { command: "static-mcp" },
        },
      },
      toolPolicy: { allowedTools: ["Grep"], disallowedTools: ["Write"] },
      createRunId: () => "run-extension",
      runtimeOptionsForRequest: ({ request, runId, context }) => {
        expect(request.conversationId).toBe("conversation-extension");
        expect(runId).toBe("run-extension");
        expect(context.sections.map((section) => section.id)).toContain("identity");
        return {
          runtimeOptions: {
            allowedTools: ["AskCollaborator"],
            mcpServers: {
              collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
            },
          },
          cleanup: async () => {
            cleanupCalls.push("cleaned");
          },
        };
      },
    }).run({
      conversationId: "conversation-extension",
      userMessage: "Who should help?",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Final answer");
    expect(fake.calls).toHaveLength(1);
    // A non-push turn is described without exposing its internal conversation id
    // or suggesting that the model invent a callback route.
    expect(fake.calls[0]?.prompt).toContain("request-driven run (scheduled, webhook, or API) with no interactive user");
    expect(fake.calls[0]?.prompt).toContain("Do not invent or infer a callback destination");
    expect(fake.calls[0]?.prompt).not.toContain("conversation-extension");
    expect(fake.calls[0]?.options.allowedTools).toEqual(["Grep", "Read", "AskCollaborator"]);
    expect(fake.calls[0]?.options.disallowedTools).toEqual(["Write"]);
    expect(fake.calls[0]?.options.mcpServers).toEqual({
      static: { command: "static-mcp" },
      collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
    });
    expect(cleanupCalls).toEqual(["cleaned"]);
  });

  it("does not allow request-scoped runtime options to weaken sandbox policy", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      sandboxPolicy: createSandboxPolicy({
        root: dir,
        network: { mode: "none" },
      }),
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          sandboxPolicy: createSandboxPolicy({
            mode: "off",
            root: dir,
            network: { mode: "all" },
            fallback: "unsafe-host-process",
            unsafeAllowHostProcess: true,
          }),
        },
      }),
    }).run({
      conversationId: "conversation-sandbox",
      userMessage: "Can you run this?",
      abortSignal: new AbortController().signal,
    });

    expect(fake.calls[0]?.options.sandboxPolicy).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "none", allowlist: [] },
    });
  });

  it("appends a deterministic host summary when memoryWriteMode is append-host-summary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const summaries: Array<{ conversationId: string; summary: string }> = [];
    const memory = {
      async load() {
        return undefined;
      },
      async appendHostSummary(conversationId: string, summary: string) {
        summaries.push({ conversationId, summary });
        return { conversationId, source: "memory.md", bytesWritten: summary.length };
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "The build is green." }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "append-host-summary",
      createRunId: () => "run-summary",
    }).run({ conversationId: "telegram:9", userMessage: "Is the build ok?", abortSignal: new AbortController().signal });

    expect(response.text).toBe("The build is green.");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.conversationId).toBe("telegram:9");
    expect(summaries[0]?.summary).toBe(
      [
        "Host-observed completed turn.",
        "User: Is the build ok?",
        "Assistant: The build is green.",
      ].join("\n"),
    );
  });

  it("admits a capture-mode turn once through the strong store with the stable run id", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const admissions: MemoryCompletedTurn[] = [];
    const legacyCalls: string[] = [];
    const memory: MemoryStore = {
      load: async () => undefined,
      appendHostSummary: async (conversationId) => {
        legacyCalls.push(`append:${conversationId}`);
        return { conversationId, source: "legacy", bytesWritten: 0 };
      },
      scheduleCapture: (conversationId) => { legacyCalls.push(`capture:${conversationId}`); },
      async persistCompletedTurn(turn): Promise<MemoryCompletedTurnResult> {
        admissions.push(turn);
        return {
          id: "completed-turn-stable",
          runId: turn.runId,
          conversationId: turn.conversationId,
          source: "strong",
          bytesWritten: Buffer.byteLength(turn.summary + (turn.captureText ?? ""), "utf8"),
          admissionStatus: "admitted",
        };
      },
    };

    const response = await createAgentHarness({
      identityPath,
      runtime: createFakeRuntime(async () => ({ text: "The build is green." })).runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "capture",
      createRunId: () => "run-stable-idempotency-key",
    }).run({
      conversationId: "telegram:9",
      userMessage: "Is the build ok?",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("The build is green.");
    expect(admissions).toEqual([{
      runId: "run-stable-idempotency-key",
      conversationId: "telegram:9",
      summary: [
        "Host-observed completed turn.",
        "User: Is the build ok?",
        "Assistant: The build is green.",
      ].join("\n"),
      captureText: "User: Is the build ok?\nAssistant: The build is green.",
    }]);
    expect(legacyCalls).toEqual([]);
  });

  it("omits capture text from a strong append-host-summary admission", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const admissions: MemoryCompletedTurn[] = [];
    const memory: MemoryStore = {
      load: async () => undefined,
      appendHostSummary: async () => { throw new Error("legacy append must not run"); },
      scheduleCapture: () => { throw new Error("legacy capture must not run"); },
      async persistCompletedTurn(turn) {
        admissions.push(turn);
        return {
          id: "completed-turn-summary",
          runId: turn.runId,
          conversationId: turn.conversationId,
          source: "strong",
          bytesWritten: Buffer.byteLength(turn.summary, "utf8"),
          admissionStatus: "admitted",
        };
      },
    };

    const response = await createAgentHarness({
      identityPath,
      runtime: createFakeRuntime(async () => ({ text: "Done." })).runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "append-host-summary",
      createRunId: () => "run-summary-admission",
    }).run({ conversationId: "c1", userMessage: "Summarize build status", abortSignal: new AbortController().signal });

    expect(response.failure).toBeUndefined();
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).not.toHaveProperty("captureText");
  });

  it("waits for strong admission before returning the successful provider answer", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let enterAdmission!: () => void;
    const admissionEntered = new Promise<void>((resolve) => { enterAdmission = resolve; });
    let finishAdmission!: () => void;
    const admissionPending = new Promise<void>((resolve) => { finishAdmission = resolve; });
    const memory: MemoryStore = {
      load: async () => undefined,
      appendHostSummary: async () => { throw new Error("legacy append must not run"); },
      persistCompletedTurn: async (turn) => {
        enterAdmission();
        await admissionPending;
        return {
          id: "completed-turn-awaited",
          runId: turn.runId,
          conversationId: turn.conversationId,
          source: "strong",
          bytesWritten: 1,
          admissionStatus: "admitted" as const,
        };
      },
    };
    const responsePending = createAgentHarness({
      identityPath,
      runtime: createFakeRuntime(async () => ({ text: "Provider answer." })).runtime,
      model,
      memory,
      memoryWriteMode: "append-host-summary",
      createRunId: () => "run-awaited",
    }).run({ conversationId: "c-awaited", userMessage: "Remember this", abortSignal: new AbortController().signal });
    let settled = false;
    void responsePending.then(() => { settled = true; });

    await admissionEntered;
    await Promise.resolve();
    expect(settled).toBe(false);
    finishAdmission();
    const response = await responsePending;
    expect(response.text).toBe("Provider answer.");
    expect(response.failure).toBeUndefined();
  });

  for (const [label, userMessage, assistantText] of [
    ["nothing sentinel", "Run scan", "NOTHING_TO_REPORT"],
    ["trivial probe", "ping", "pong"],
  ] as const) {
    it(`keeps the strong admission boundary untouched for a skipped ${label}`, async () => {
      const dir = await tempDir();
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      let admissions = 0;
      const memory: MemoryStore = {
        load: async () => undefined,
        appendHostSummary: async (conversationId) => ({ conversationId, source: "legacy", bytesWritten: 0 }),
        persistCompletedTurn: async (turn) => {
          admissions += 1;
          return {
            id: "unexpected",
            runId: turn.runId,
            conversationId: turn.conversationId,
            source: "strong",
            bytesWritten: 0,
            admissionStatus: "admitted",
          };
        },
      };

      const response = await createAgentHarness({
        identityPath,
        runtime: createFakeRuntime(async () => ({ text: assistantText })).runtime,
        model,
        memory,
        memoryWriteMode: "capture",
        createRunId: () => `run-skip-${label}`,
      }).run({ conversationId: "c-skip", userMessage, abortSignal: new AbortController().signal });

      expect(response.text).toBe(assistantText);
      expect(admissions).toBe(0);
    });
  }

  it("does not write a host summary when memoryWriteMode is omitted", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let appendCount = 0;
    const memory = {
      async load() {
        return undefined;
      },
      async appendHostSummary() {
        appendCount += 1;
        return { conversationId: "c", source: "memory.md", bytesWritten: 0 };
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "Done." }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      createRunId: () => "run-no-summary",
    }).run({ conversationId: "c", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(appendCount).toBe(0);
  });

  it("writeMode 'capture' writes the rapid-log AND schedules an async capture", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const calls: string[] = [];
    const memory = {
      load: async () => undefined,
      appendHostSummary: async (id: string) => {
        calls.push(`append:${id}`);
        return { conversationId: id, source: "memory.md", bytesWritten: 1 };
      },
      scheduleCapture: (id: string, text: string) => {
        calls.push(`schedule:${id}:${text.includes("Assistant") ? "turn" : "?"}`);
      },
      flush: async () => {},
    };
    const fake = createFakeRuntime(async () => ({ text: "All good." }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "capture",
      createRunId: () => "run-capture",
    }).run({ conversationId: "c1", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(response.text).toBe("All good.");
    expect(calls).toContain("append:c1");
    expect(calls.some((c) => c.startsWith("schedule:c1"))).toBe(true);
    expect(fake.calls[0]?.prompt).toContain("Long-term memory state is owned by the host");
    expect(fake.calls[0]?.prompt).toContain("never edit memory Markdown, SQLite databases, indexes, manifests");
  });

  for (const [label, metadata] of [
    ["cron", { cron: { jobId: "focus-scan", scheduledAt: "2026-07-05T08:00:00.000Z" } }],
    ["webhook", { webhook: { endpointName: "focus-scan", requestId: "req-1", mode: "sync" } }],
  ] as const) {
    it(`writeMode 'capture' captures only the assistant answer for ${label} turns`, async () => {
      const dir = await tempDir();
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      const summaries: string[] = [];
      const captures: string[] = [];
      const memory = {
        load: async () => undefined,
        appendHostSummary: async (id: string, summary: string) => {
          summaries.push(summary);
          return { conversationId: id, source: "memory.md", bytesWritten: summary.length };
        },
        scheduleCapture: (_id: string, text: string) => {
          captures.push(text);
        },
        flush: async () => {},
      };
      const prompt = "Run the hourly focus scan. Do not run a broad project scan.";
      const answer = "No focus changes need your attention.";
      const fake = createFakeRuntime(async () => ({ text: answer }));

      await createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        memory,
        memoryWriteMode: "capture",
        createRunId: () => `run-${label}-capture`,
      }).run({ conversationId: `${label}:focus-scan`, userMessage: prompt, metadata, abortSignal: new AbortController().signal });

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(answer);
      expect(summaries[0]).not.toContain(prompt);
      expect(captures).toEqual([`Assistant: ${answer}`]);
      expect(captures[0]).not.toContain(prompt);
    });
  }

  const memoryWriteModes = ["append-host-summary", "capture"] as const;

  for (const mode of memoryWriteModes) {
    it(`writeMode '${mode}' skips memory writes when the assistant returns NOTHING_TO_REPORT`, async () => {
      const dir = await tempDir();
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      const calls: string[] = [];
      const memory = {
        load: async () => undefined,
        appendHostSummary: async (id: string) => {
          calls.push(`append:${id}`);
          return { conversationId: id, source: "memory.md", bytesWritten: 1 };
        },
        scheduleCapture: (id: string) => {
          calls.push(`schedule:${id}`);
        },
        flush: async () => {},
      };
      const fake = createFakeRuntime(async () => ({ text: "  nothing_to_report  " }));

      const response = await createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        memory,
        memoryWriteMode: mode,
        createRunId: () => `run-nothing-to-report-${mode}`,
      }).run({
        conversationId: "cron:focus-scan",
        userMessage: "Run the hourly focus scan.",
        metadata: { cron: { jobId: "focus-scan" } },
        abortSignal: new AbortController().signal,
      });

      expect(response.text).toBe("  nothing_to_report  ");
      expect(calls).toEqual([]);
    });

    for (const [probe, answer] of [["test", "test ok"], ["ping", "pong"]] as const) {
      it(`writeMode '${mode}' skips memory writes for tiny ${probe} turns`, async () => {
        const dir = await tempDir();
        const identityPath = join(dir, "IDENTITY.md");
        await writeFile(identityPath, "You are Mono.", "utf8");
        const calls: string[] = [];
        const memory = {
          load: async () => undefined,
          appendHostSummary: async (id: string) => {
            calls.push(`append:${id}`);
            return { conversationId: id, source: "memory.md", bytesWritten: 1 };
          },
          scheduleCapture: (id: string) => {
            calls.push(`schedule:${id}`);
          },
          flush: async () => {},
        };
        const fake = createFakeRuntime(async () => ({ text: answer }));

        await createAgentHarness({
          identityPath,
          runtime: fake.runtime,
          model,
          executionMode: "sdk",
          memory,
          memoryWriteMode: mode,
          createRunId: () => `run-trivial-${mode}-${probe}`,
        }).run({ conversationId: "telegram:9", userMessage: probe, abortSignal: new AbortController().signal });

        expect(calls).toEqual([]);
      });
    }

    it(`writeMode '${mode}' skips trigger probes even when the trigger prompt is prefixed`, async () => {
      const dir = await tempDir();
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      const calls: string[] = [];
      const memory = {
        load: async () => undefined,
        appendHostSummary: async (id: string) => {
          calls.push(`append:${id}`);
          return { conversationId: id, source: "memory.md", bytesWritten: 1 };
        },
        scheduleCapture: (id: string) => {
          calls.push(`schedule:${id}`);
        },
        flush: async () => {},
      };
      const fake = createFakeRuntime(async () => ({ text: "test ok" }));

      await createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        memory,
        memoryWriteMode: mode,
        createRunId: () => `run-prefixed-trivial-${mode}`,
      }).run({
        conversationId: "webhook:probe",
        userMessage: "Pre-instructions: answer tersely.\n\nRequest body:\ntest",
        metadata: { webhook: { endpointName: "probe", requestId: "req-1", mode: "sync" } },
        abortSignal: new AbortController().signal,
      });

      expect(calls).toEqual([]);
    });
  }

  it("still writes memory for short non-trivial turns", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const calls: string[] = [];
    const memory = {
      load: async () => undefined,
      appendHostSummary: async (id: string) => {
        calls.push(`append:${id}`);
        return { conversationId: id, source: "memory.md", bytesWritten: 1 };
      },
      scheduleCapture: (id: string, text: string) => {
        calls.push(`schedule:${id}:${text}`);
      },
      flush: async () => {},
    };
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "capture",
      createRunId: () => "run-short-meaningful",
    }).run({ conversationId: "telegram:9", userMessage: "call Paola", abortSignal: new AbortController().signal });

    expect(calls).toContain("append:telegram:9");
    expect(calls).toContain("schedule:telegram:9:User: call Paola\nAssistant: ok");
  });

  it("still writes memory for short contextual acknowledgements", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const calls: string[] = [];
    const memory = {
      load: async () => undefined,
      appendHostSummary: async (id: string) => {
        calls.push(`append:${id}`);
        return { conversationId: id, source: "memory.md", bytesWritten: 1 };
      },
      scheduleCapture: (id: string, text: string) => {
        calls.push(`schedule:${id}:${text}`);
      },
      flush: async () => {},
    };
    const fake = createFakeRuntime(async () => ({ text: "done" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "capture",
      createRunId: () => "run-short-ack",
    }).run({ conversationId: "telegram:9", userMessage: "yes", abortSignal: new AbortController().signal });

    expect(calls).toContain("append:telegram:9");
    expect(calls).toContain("schedule:telegram:9:User: yes\nAssistant: done");
  });

  it("still writes memory when a test-like word appears in a meaningful turn", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const calls: string[] = [];
    const memory = {
      load: async () => undefined,
      appendHostSummary: async (id: string) => {
        calls.push(`append:${id}`);
        return { conversationId: id, source: "memory.md", bytesWritten: 1 };
      },
      scheduleCapture: (id: string, text: string) => {
        calls.push(`schedule:${id}:${text}`);
      },
      flush: async () => {},
    };
    const fake = createFakeRuntime(async () => ({ text: "works" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "capture",
      createRunId: () => "run-test-meaningful",
    }).run({ conversationId: "telegram:9", userMessage: "test deploy", abortSignal: new AbortController().signal });

    expect(calls).toContain("append:telegram:9");
    expect(calls).toContain("schedule:telegram:9:User: test deploy\nAssistant: works");
  });

  it("writeMode 'append-host-summary' does NOT schedule a capture", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const calls: string[] = [];
    const memory = {
      load: async () => undefined,
      appendHostSummary: async (id: string) => {
        calls.push(`append:${id}`);
        return { conversationId: id, source: "memory.md", bytesWritten: 1 };
      },
      scheduleCapture: () => {
        calls.push("schedule");
      },
      flush: async () => {},
    };
    const fake = createFakeRuntime(async () => ({ text: "Done." }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "append-host-summary",
      createRunId: () => "run-no-capture",
    }).run({ conversationId: "c1", userMessage: "Summarize build status", abortSignal: new AbortController().signal });

    expect(calls).toContain("append:c1");
    expect(calls).not.toContain("schedule");
  });

  it("resolves scalar and mcpServers precedence collisions last-wins across merge layers", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      // tool policy (first merge layer) seeds mcpServers + allowedTools
      toolPolicy: {
        allowedTools: ["Read"],
        disallowedTools: [],
        mcpServers: { shared: { url: "policy" }, policyOnly: { url: "p" } },
      },
      // static runtimeOptions (second layer) sets a scalar + overrides one server
      runtimeOptions: {
        mcpConfigPath: "/from-static",
        mcpServers: { shared: { url: "static" }, staticOnly: { url: "s" } },
      },
      createRunId: () => "run-merge",
      // request extension (last layer) wins scalar + the shared server key
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          mcpConfigPath: "/from-request",
          allowedTools: ["Grep"],
          mcpServers: { shared: { url: "request" }, requestOnly: { url: "r" } },
        },
      }),
    }).run({ conversationId: "c", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(response.text).toBe("ok");
    const options = fake.calls[0]?.options;
    // scalar: last layer wins
    expect(options?.mcpConfigPath).toBe("/from-request");
    // allowedTools: list-merged + de-duplicated across layers
    expect(options?.allowedTools).toEqual(["Read", "Grep"]);
    // mcpServers: shallow merge per key, last layer wins on the shared key
    expect(options?.mcpServers).toEqual({
      shared: { url: "request" },
      policyOnly: { url: "p" },
      staticOnly: { url: "s" },
      requestOnly: { url: "r" },
    });
  });

  it("lets an authenticated request replace host/static tool and MCP authority", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      toolPolicy: {
        allowedTools: ["*"],
        disallowedTools: [],
        mcpServers: { configuredMutator: { command: "mutate" } },
        mcpConfigPath: "/configured/mcp.json",
      },
      runtimeOptions: {
        allowedTools: ["Write"],
        mcpServers: { staticMutator: { command: "mutate-static" } },
      },
      runtimeOptionsForRequest: () => ({
        toolPolicyOverride: {
          allowedTools: ["ReadSkill", "ProposeAgentConfiguration"],
          disallowedTools: [],
          mcpServers: { agent_configuration: { command: "proposal-only" } },
        },
        runtimeOptions: {
          permissionMode: "plan",
          // Tool-shaped fields in the same extension cannot escape the
          // authoritative request boundary.
          allowedTools: ["Bash"],
          mcpServers: { requestMutator: { command: "mutate-request" } },
        },
      }),
    }).run({ conversationId: "c", userMessage: "configure", abortSignal: new AbortController().signal });

    expect(fake.calls[0]?.options).toMatchObject({
      allowedTools: ["ReadSkill", "ProposeAgentConfiguration"],
      disallowedTools: [],
      permissionMode: "plan",
      mcpServers: { agent_configuration: { command: "proposal-only" } },
    });
    expect(fake.calls[0]?.options.mcpConfigPath).toBeUndefined();
  });

  it("injects trusted context into opted-in stdio MCPs after authoritative merging without mutating shared state", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const target = {
      type: "stdio",
      command: "transcribe-mcp",
      env: {
        KEEP_ME: "yes",
        MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID: "spoofed",
        MONO_AGENT_INTERACTION_PROGRESS_TOKEN: "spoofed-token",
        MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "master-must-not-leak",
        MONO_AGENT_MCP_ATTACHMENTS_ROOT: "/spoofed/root",
        MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS: '["/spoofed/file"]',
        MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES: '[{"path":"/spoofed/file","dev":1,"ino":2}]',
      },
    };
    const untouched = { command: "other-mcp", env: { STATIC: "unchanged" } };
    const remote = { type: "http", url: "https://mcp.example.test" };
    const releases: string[] = [];
    const ambientBefore = process.env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN;
    process.env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN = "ambient-master";
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    try {
      await createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        createRunId: () => "run-trusted-context",
        runtimeOptionsForRequest: () => ({
          toolPolicyOverride: {
            allowedTools: ["*"],
            disallowedTools: [],
            mcpServers: { target, untouched, remote },
          },
        }),
        mcpRequestContext: {
          serverNames: ["target", "remote"],
          runOutputRoot: join(dir, "outbound"),
          progressCapabilityIssuer: {
            issueProgressCapability: ({ conversationId, runId }) => ({
              url: "http://127.0.0.1:43123",
              token: `${conversationId}:${runId}:scoped`,
              release: () => { releases.push(runId); },
            }),
          },
        },
      }).run({
        conversationId: "telegram:42#2026-07-12",
        userMessage: "refine it",
        abortSignal: new AbortController().signal,
      });

      const servers = fake.calls[0]?.options.mcpServers as Record<string, Record<string, unknown>>;
      const injected = servers.target?.env as Record<string, string>;
      expect(servers.target).not.toBe(target);
      expect(injected).toMatchObject({
        KEEP_ME: "yes",
        MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID: "telegram:42#2026-07-12",
        MONO_AGENT_MCP_PRODUCING_RUN_ID: "run-trusted-context",
        MONO_AGENT_MCP_RUN_OUTPUT_DIR: join(dir, "outbound", "run-trusted-context"),
        MONO_AGENT_INTERACTION_PROGRESS_URL: "http://127.0.0.1:43123",
        MONO_AGENT_INTERACTION_PROGRESS_TOKEN: "telegram:42#2026-07-12:run-trusted-context:scoped",
        MONO_AGENT_MCP_ATTACHMENTS_ROOT: "",
        MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS: "[]",
        MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES: "[]",
        MONO_AGENT_INTERACTION_BRIDGE_URL: "",
        MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "",
      });
      expect(servers.untouched).toBe(untouched);
      expect(servers.remote).toBe(remote);
      expect(target.env.MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID).toBe("spoofed");
      expect(target.env.MONO_AGENT_INTERACTION_PROGRESS_TOKEN).toBe("spoofed-token");
      expect(process.env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN).toBe("ambient-master");
      expect(releases).toEqual(["run-trusted-context"]);
      await expect(lstat(join(dir, "outbound", "run-trusted-context"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (ambientBefore === undefined) delete process.env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN;
      else process.env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN = ambientBefore;
    }
  });

  it("injects destination-bound continuation claims into selected stdio and loopback HTTP servers", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const stdio = {
      type: "stdio",
      command: "a8c-control-stdio",
      env: {
        KEEP_ME: "yes",
        MONO_AGENT_CONTINUATION_CLAIM_TOKEN: "spoofed",
      },
    };
    const loopback = {
      type: "http",
      url: "http://127.0.0.1:43124/mcp",
      headers: {
        Authorization: "Bearer configured",
        "X-Mono-Agent-Continuation-Claim-Token": "spoofed-case-insensitive",
      },
    };
    const remote = { type: "http", url: "https://mcp.example.test", headers: { STATIC: "untouched" } };
    const issued: Array<Record<string, unknown>> = [];
    const released: string[] = [];
    const fake = createFakeRuntime(async () => ({ text: "accepted" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      createRunId: () => "run-continuation-claim",
      runtimeOptions: { mcpServers: { stdio, loopback, remote } },
      continuationContext: {
        serverNames: ["stdio", "loopback"],
        capabilityIssuer: {
          issueContinuationClaimCapability(input) {
            issued.push(input);
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: `token-${input.serverName}`,
              fingerprint: `fingerprint-${input.serverName}`,
              mode: "reply",
              requiresOriginContext: async () => false,
              finalizeOriginContext: async () => {},
              activateOriginContext: async () => {},
              abandonOriginContext: async () => {},
              release: () => { released.push(input.serverName); },
            };
          },
        },
      },
    }).run({
      conversationId: "slack:C1:thread#2026-07-14",
      replyTo: { conversationId: "slack:C1:thread" },
      userMessage: "delegate this",
      abortSignal: new AbortController().signal,
    });

    const servers = fake.calls[0]?.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.stdio?.env).toMatchObject({
      KEEP_ME: "yes",
      MONO_AGENT_CONTINUATION_CLAIM_URL: "http://127.0.0.1:43125/continuations/claim",
      MONO_AGENT_CONTINUATION_CLAIM_TOKEN: "token-stdio",
      MONO_AGENT_CONTINUATION_CLAIM_FINGERPRINT: "fingerprint-stdio",
      MONO_AGENT_CONTINUATION_CLAIM_MODE: "reply",
    });
    expect(servers.loopback?.headers).toEqual({
      Authorization: "Bearer configured",
      "x-mono-agent-continuation-claim-url": "http://127.0.0.1:43125/continuations/claim",
      "x-mono-agent-continuation-claim-token": "token-loopback",
      "x-mono-agent-continuation-claim-fingerprint": "fingerprint-loopback",
      "x-mono-agent-continuation-claim-mode": "reply",
    });
    expect(servers.remote).toBe(remote);
    expect(JSON.stringify(servers)).not.toContain("slack:C1:thread");
    expect(issued).toEqual([
      {
        runId: "run-continuation-claim",
        serverName: "stdio",
        conversationId: "slack:C1:thread#2026-07-14",
        replyTo: { conversationId: "slack:C1:thread" },
        historyBoundary: "run-continuation-claim",
      },
      {
        runId: "run-continuation-claim",
        serverName: "loopback",
        conversationId: "slack:C1:thread#2026-07-14",
        replyTo: { conversationId: "slack:C1:thread" },
        historyBoundary: "run-continuation-claim",
      },
    ]);
    expect(released).toEqual(["stdio", "loopback"]);
    expect(stdio.env.MONO_AGENT_CONTINUATION_CLAIM_TOKEN).toBe("spoofed");
    expect(loopback.headers["X-Mono-Agent-Continuation-Claim-Token"]).toBe("spoofed-case-insensitive");
  });

  it("pins the exact redacted completed origin turn before activating continuation work", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const history = createInMemoryHistoryStore({ maxMessages: 20 });
    await history.append("slack:C1:thread#2026-07-14", [
      { role: "user", content: "Earlier question", timestamp: "2026-07-14T08:00:00.000Z", runId: "run-earlier" },
      { role: "assistant", content: "Earlier answer", timestamp: "2026-07-14T08:00:00.000Z", runId: "run-earlier" },
    ]);
    const lifecycle: string[] = [];
    let snapshot: AgentContinuationOriginContext | undefined;
    const recorder = new class extends FakeRecorder {
      override async finish(result: RuntimeResultLike): Promise<RunSummary> {
        lifecycle.push("recorder_finish");
        return await super.finish(result);
      }
    }("run-origin-snapshot", "slack:C1:thread#2026-07-14");
    const fake = createFakeRuntime(async () => ({ text: "Origin acknowledgement" }));
    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      historyStore: history,
      attachmentsDir: join(dir, "attachments"),
      createRunId: () => "run-origin-snapshot",
      now: () => new Date("2026-07-14T09:00:00.000Z"),
      recorderFactory: () => recorder,
      runtimeOptions: { mcpServers: { control: { command: "a8c-control" } } },
      continuationContext: {
        serverNames: ["control"],
        capabilityIssuer: {
          issueContinuationClaimCapability() {
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: "origin-token",
              fingerprint: "origin-fingerprint",
              mode: "reply" as const,
              async requiresOriginContext() { return true; },
              async finalizeOriginContext(value) {
                lifecycle.push("finalize");
                snapshot = structuredClone(value);
              },
              async activateOriginContext() { lifecycle.push("activate"); },
              async abandonOriginContext() { lifecycle.push("abandon"); },
              release() { lifecycle.push("release"); },
            };
          },
        },
      },
      turnHistoryEnricher: {
        enrichAssistantHistory({ assistantText }) {
          return `[Verified interaction]\n${assistantText}`;
        },
        releaseRun() {},
      },
    }).run({
      conversationId: "slack:C1:thread#2026-07-14",
      replyTo: { conversationId: "slack:C1:thread" },
      userMessage: "Safe caption",
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        name: "private.txt",
        data: Buffer.from("PRIVATE RAW BYTES", "utf8").toString("base64"),
        text: "PRIVATE EXPANDED DOCUMENT TEXT",
      }],
      abortSignal: new AbortController().signal,
    });

    expect(response).toMatchObject({ text: "Origin acknowledgement" });
    expect(lifecycle).toEqual(["release", "finalize", "recorder_finish", "activate"]);
    expect(snapshot).toBeDefined();
    expect(snapshot).toMatchObject({
      conversationId: "slack:C1:thread#2026-07-14",
      originRunId: "run-origin-snapshot",
      historyBoundary: "run-origin-snapshot",
      capturedAt: "2026-07-14T09:00:00.000Z",
    });
    expect(snapshot?.messages.slice(0, 2)).toEqual([
      { role: "user", content: "Earlier question", timestamp: "2026-07-14T08:00:00.000Z", runId: "run-earlier" },
      { role: "assistant", content: "Earlier answer", timestamp: "2026-07-14T08:00:00.000Z", runId: "run-earlier" },
    ]);
    expect(snapshot?.messages.at(-2)?.content).toContain("Safe caption");
    expect(snapshot?.messages.at(-2)?.content).toContain("private.txt");
    expect(snapshot?.messages.at(-1)?.content).toBe("[Verified interaction]\nOrigin acknowledgement");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE EXPANDED DOCUMENT TEXT");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE RAW BYTES");
    expect(String(fake.calls[0]?.options.messages?.at(-1)?.content)).toContain("PRIVATE EXPANDED DOCUMENT TEXT");
    await expect(history.load("slack:C1:thread#2026-07-14")).resolves.toEqual(snapshot?.messages);
  });

  it("does not build a bounded origin snapshot when no continuation was claimed", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const history = createInMemoryHistoryStore({ maxMessages: 64 });
    const oversized = "x".repeat(64 * 1024 + 1);
    let finalized = 0;
    const fake = createFakeRuntime(async () => ({ text: oversized }));
    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      historyStore: history,
      runtimeOptions: { mcpServers: { control: { command: "a8c-control" } } },
      continuationContext: {
        serverNames: ["control"],
        capabilityIssuer: {
          issueContinuationClaimCapability() {
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: "unused-token",
              fingerprint: "unused-fingerprint",
              mode: "reply" as const,
              requiresOriginContext: async () => false,
              finalizeOriginContext: async () => { finalized += 1; },
              activateOriginContext: async () => {},
              abandonOriginContext: async () => {},
              release: async () => {},
            };
          },
        },
      },
    }).run({
      conversationId: "slack:C1:thread#2026-07-14",
      replyTo: { conversationId: "slack:C1:thread" },
      userMessage: "ordinary request",
      abortSignal: new AbortController().signal,
    });

    expect(response.failure).toBeUndefined();
    expect(response.text).toBe(oversized);
    expect(finalized).toBe(0);
    expect((await history.load("slack:C1:thread#2026-07-14")).at(-1)?.content).toBe(oversized);
  });

  it("keeps recorder success authoritative when origin activation fails", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const lifecycle: string[] = [];
    const fake = createFakeRuntime(async () => ({ text: "accepted" }));
    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      runtimeOptions: { mcpServers: { control: { command: "a8c-control" } } },
      continuationContext: {
        serverNames: ["control"],
        capabilityIssuer: {
          issueContinuationClaimCapability() {
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: "claimed-token",
              fingerprint: "claimed-fingerprint",
              mode: "reply" as const,
              requiresOriginContext: async () => true,
              finalizeOriginContext: async () => { lifecycle.push("finalize"); },
              activateOriginContext: async () => {
                lifecycle.push("activate");
                throw new Error("durable activation unavailable");
              },
              abandonOriginContext: async () => { lifecycle.push("abandon"); },
              release: async () => { lifecycle.push("release"); },
            };
          },
        },
      },
    }).run({
      conversationId: "slack:C1:thread#2026-07-14",
      replyTo: { conversationId: "slack:C1:thread" },
      userMessage: "delegate this",
      abortSignal: new AbortController().signal,
    });

    expect(response).toMatchObject({ text: "accepted" });
    expect(response.failure).toBeUndefined();
    expect(lifecycle).toEqual(["release", "finalize", "activate", "abandon"]);
  });

  it("preserves a committed answer and activates its continuation when recorder publication fails", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const history = createInMemoryHistoryStore({ maxMessages: 20 });
    const lifecycle: string[] = [];
    const fake = createFakeRuntime(async () => ({ text: "durably accepted" }));
    const recorder: RunRecorder = {
      onEvent() {},
      async prepareFinish() {},
      async commitFinish() {
        lifecycle.push("recorder");
        throw new Error("recorder export unavailable");
      },
      async finish() {
        throw new Error("legacy recorder export unavailable");
      },
      async fail() {
        lifecycle.push("fail");
        throw new Error("must not report a committed answer as failed");
      },
    };
    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      historyStore: history,
      recorderFactory: () => recorder,
      runtimeOptions: { mcpServers: { control: { command: "a8c-control" } } },
      continuationContext: {
        serverNames: ["control"],
        capabilityIssuer: {
          issueContinuationClaimCapability() {
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: "recorder-token",
              fingerprint: "recorder-fingerprint",
              mode: "reply" as const,
              async requiresOriginContext() { return true; },
              async finalizeOriginContext() { lifecycle.push("finalize"); },
              async activateOriginContext() { lifecycle.push("activate"); },
              async abandonOriginContext() { lifecycle.push("abandon"); },
              async release() { lifecycle.push("release"); },
            };
          },
        },
      },
    }).run({
      conversationId: "slack:C1:recorder#2026-07-14",
      replyTo: { conversationId: "slack:C1:recorder" },
      userMessage: "delegate this",
      abortSignal: new AbortController().signal,
    });

    expect(response).toMatchObject({ text: "durably accepted" });
    expect(response.failure).toBeUndefined();
    expect(response.metadata.summary).toBeUndefined();
    expect(lifecycle).toEqual(["release", "finalize", "recorder", "activate"]);
    expect((await history.load("slack:C1:recorder#2026-07-14")).at(-1)?.content).toBe("durably accepted");
  });

  it("rejects a selected non-loopback HTTP continuation server before provider execution", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "must not run" }));
    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      runtimeOptions: { mcpServers: { remote: { type: "http", url: "https://mcp.example.test" } } },
      continuationContext: {
        serverNames: ["remote"],
        capabilityIssuer: { issueContinuationClaimCapability: () => undefined },
      },
    }).run({ conversationId: "c", userMessage: "delegate", abortSignal: new AbortController().signal });

    expect(fake.calls).toHaveLength(0);
    expect(response.failure).toMatchObject({ kind: "unsupported_continuation_server" });
  });

  it.each([
    ["stdio without a command", "worker", { worker: { type: "stdio" } }],
    ["stdio with a blank command", "worker", { worker: { type: "stdio", command: "   " } }],
    ["conflicting stdio URL", "worker", {
      worker: { type: "stdio", command: "local-worker", url: "https://mcp.example.test" },
    }],
    ["conflicting HTTP command", "worker", {
      worker: { type: "http", command: "local-worker", url: "http://127.0.0.1:43124/mcp" },
    }],
    ["runtime-invalid server name", "bad name", { "bad name": { command: "local-worker" } }],
  ])("rejects a selected %s before provider execution", async (_label, serverName, mcpServers) => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "must not run" }));
    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      runtimeOptions: { mcpServers },
      continuationContext: {
        serverNames: [serverName],
        capabilityIssuer: { issueContinuationClaimCapability: () => undefined },
      },
    }).run({ conversationId: "c", userMessage: "delegate", abortSignal: new AbortController().signal });

    expect(fake.calls).toHaveLength(0);
    expect(response.failure).toMatchObject({ kind: "unsupported_continuation_server" });
  });

  it("issues detached named-route claims without an interactive history boundary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let issued: Record<string, unknown> | undefined;
    const fake = createFakeRuntime(async () => ({ text: "scheduled" }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      createRunId: () => "run-proactive",
      runtimeOptions: { mcpServers: { control: { command: "a8c-control" } } },
      continuationContext: {
        serverNames: ["control"],
        capabilityIssuer: {
          issueContinuationClaimCapability(input) {
            issued = input;
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: "detached-token",
              fingerprint: "detached-fingerprint",
              mode: "notify_if_actionable",
              requiresOriginContext: async () => false,
              finalizeOriginContext: async () => {},
              activateOriginContext: async () => {},
              abandonOriginContext: async () => {},
              release: () => {},
            };
          },
        },
      },
    }).run({
      conversationId: "cron:attention",
      userMessage: "collect attention",
      abortSignal: new AbortController().signal,
    });

    expect(issued).toEqual({
      runId: "run-proactive",
      serverName: "control",
      conversationId: "cron:attention",
    });
  });

  it("runs continuation synthesis through the origin boundary with no tools and no history commit", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const history = createInMemoryHistoryStore({ maxMessages: 20 });
    const runIds = ["run-origin", "run-later", "run-continuation"];
    const answers = ["origin answer", "later answer", "synthesized final"];
    const fake = createFakeRuntime(async () => ({ text: answers.shift() ?? null }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      historyStore: history,
      createRunId: () => runIds.shift() ?? "run-extra",
      runtimeOptions: {
        allowedTools: ["Bash"],
        disallowedTools: [],
        mcpConfigPath: join(dir, "mcp.json"),
        mcpServers: { dangerous: { command: "dangerous" } },
      },
    });

    await harness.run({ conversationId: "slack:C1", userMessage: "origin question", abortSignal: new AbortController().signal });
    const originHistory = await history.load("slack:C1");
    await harness.run({ conversationId: "slack:C1", userMessage: "later question", abortSignal: new AbortController().signal });
    const before = await history.load("slack:C1");
    const response = await harness.run({
      conversationId: "slack:C1",
      userMessage: "untrusted specialist result",
      abortSignal: new AbortController().signal,
      continuation: {
        continuationId: "continuation-1",
        originRunId: "run-origin",
        originContextPolicy: "pinned",
        historyBoundary: "run-origin",
        originContext: {
          schemaVersion: 1,
          conversationId: "slack:C1",
          originRunId: "run-origin",
          historyBoundary: "run-origin",
          capturedAt: originHistory[1]?.timestamp ?? "",
          messages: originHistory,
        },
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    });

    expect(response.text).toBe("synthesized final");
    expect(fake.calls[2]?.prompt).toContain("origin question");
    expect(fake.calls[2]?.prompt).toContain("origin answer");
    expect(fake.calls[2]?.prompt).not.toContain("later question");
    expect(fake.calls[2]?.prompt).not.toContain("later answer");
    expect(fake.calls[2]?.options.allowedTools).toEqual([]);
    expect(fake.calls[2]?.options.disallowedTools).toEqual(["*"]);
    expect(fake.calls[2]?.options.mcpServers).toEqual({});
    expect(fake.calls[2]?.options.mcpConfigPath).toBeUndefined();
    expect(await history.load("slack:C1")).toEqual(before);
  });

  it("uses latest conversation history when a detached continuation has no explicit boundary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const history = createInMemoryHistoryStore({ maxMessages: 20 });
    const runIds = ["run-first", "run-latest", "run-detached"];
    const answers = ["first answer", "latest answer", "detached final"];
    const fake = createFakeRuntime(async () => ({ text: answers.shift() ?? null }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      historyStore: history,
      createRunId: () => runIds.shift() ?? "run-extra",
    });

    await harness.run({ conversationId: "slack:C2", userMessage: "first question", abortSignal: new AbortController().signal });
    await harness.run({ conversationId: "slack:C2", userMessage: "latest question", abortSignal: new AbortController().signal });
    const before = await history.load("slack:C2");
    const response = await harness.run({
      conversationId: "slack:C2",
      userMessage: "detached proactive payload",
      abortSignal: new AbortController().signal,
      continuation: {
        continuationId: "continuation-detached",
        originRunId: "proactive-origin-for-trace-only",
        originContextPolicy: "detached_latest",
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    });

    expect(response.text).toBe("detached final");
    expect(fake.calls[2]?.prompt).toContain("first answer");
    expect(fake.calls[2]?.prompt).toContain("latest question");
    expect(fake.calls[2]?.prompt).toContain("latest answer");
    expect(fake.calls[2]?.options.allowedTools).toEqual([]);
    expect(fake.calls[2]?.options.mcpServers).toEqual({});
    expect(await history.load("slack:C2")).toEqual(before);
  });

  it.each(["success", "failure", "cancel"] as const)(
    "deletes request MCP output after runtime settlement on %s",
    async (outcome) => {
      const dir = await tempDir();
      const identityPath = join(dir, "IDENTITY.md");
      await writeFile(identityPath, "You are Mono.", "utf8");
      const runId = `run-output-${outcome}`;
      const outputPath = join(dir, "outbound", runId);
      const controller = new AbortController();
      const lifecycle: string[] = [];
      const fake = createFakeRuntime(async () => {
        expect((await lstat(outputPath)).isDirectory()).toBe(true);
        lifecycle.push("runtime");
        if (outcome === "cancel") controller.abort(new Error("cancelled"));
        if (outcome === "failure") return { text: "", error: "provider failed" };
        return { text: "ok" };
      });

      await createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        createRunId: () => runId,
        runtimeOptions: { mcpServers: { target: { type: "stdio", command: "target" } } },
        runtimeOptionsForRequest: () => ({
          settleCleanup: () => { lifecycle.push("settlement"); },
        }),
        mcpRequestContext: { serverNames: ["target"], runOutputRoot: join(dir, "outbound") },
      }).run({
        conversationId: "telegram:42",
        userMessage: "go",
        abortSignal: controller.signal,
      });

      expect(lifecycle).toEqual(["runtime", "settlement"]);
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("handles cancellation before runtime execution", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const controller = new AbortController();
    controller.abort();
    const fake = createFakeRuntime(async () => {
      throw new Error("runtime should not run");
    });

    const response = await createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk" }).run({
      conversationId: "c",
      userMessage: "hi",
      abortSignal: controller.signal,
    });

    expect(fake.calls).toHaveLength(0);
    expect(response.failure).toMatchObject({ kind: "cancelled" });
    expect(response.metadata.summary).toMatchObject({ status: "cancelled", failureKind: "cancelled" });
  });

  it("records an explicit channel-user cancellation as cancelled_user", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const controller = new AbortController();
    controller.abort(createChannelUserCancelReason("Telegram"));
    const fake = createFakeRuntime(async () => {
      throw new Error("runtime should not run");
    });

    const response = await createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk" }).run({
      conversationId: "telegram:42",
      userMessage: "cancel me",
      abortSignal: controller.signal,
    });

    expect(fake.calls).toHaveLength(0);
    expect(response.failure).toMatchObject({ kind: "cancelled" });
    expect(response.metadata.summary).toMatchObject({
      status: "cancelled",
      failureKind: "cancelled_user",
    });
  });

  it("exposes harness failures through the structural responder and streams runtime deltas", async () => {
    const harness = {
      async run(request: { readonly onEvent?: (event: RuntimeEventLike) => void }) {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "hello " }] } });
        return {
          text: "done",
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
        };
      },
    };
    const streamText: string[] = [];
    const response = await createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async (delta) => { streamText.push(delta); } },
    );

    expect(streamText).toEqual(["hello "]);
    expect(response.text).toBe("done");
  });

  it("forwards each runtime text delta to the stream immediately, in order (no batching)", async () => {
    const harness = {
      async run(request: { readonly onEvent?: (event: RuntimeEventLike) => void }) {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "hel" }] } });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "lo" }] } });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "!" }] } });
        return {
          text: "hello!",
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
        };
      },
    };
    const streamText: string[] = [];
    const response = await createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async (delta) => { streamText.push(delta); } },
    );

    // Each delta is flushed immediately (no microtask coalescing), so streaming
    // consumers like the OpenAI SSE adapter emit tokens as they arrive.
    expect(streamText).toEqual(["hel", "lo", "!"]);
    expect(response.text).toBe("hello!");
  });

  it("forwards thoughts and internal tool activity as stream events without appending them to answer text", async () => {
    const harness = {
      async run(request: { readonly onEvent?: (event: RuntimeEventLike) => void }) {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "checking tools" }] } });
        request.onEvent?.({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "mcp__context_example__search",
                input: { query: "release plan" },
              },
            ],
          },
        });
        request.onEvent?.({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: { matches: 2 },
                is_error: false,
              },
            ],
          },
        });
        request.onEvent?.({ type: "runtime_warning", warning_kind: "config_warning", message: "minor config warning" });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "final " }] } });
        return {
          text: "final answer",
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
        };
      },
    };
    const streamText: string[] = [];
    const streamEvents: unknown[] = [];
    const response = await createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      {
        append: async (delta) => { streamText.push(delta); },
        event: async (event) => { streamEvents.push(event); },
      },
    );

    expect(streamText).toEqual(["final "]);
    expect(streamEvents).toEqual([
      { type: "assistant_thought", text: "checking tools" },
      {
        type: "tool_call_started",
        id: "tool-1",
        name: "mcp__context_example__search",
        arguments: { query: "release plan" },
      },
      {
        type: "tool_call_completed",
        id: "tool-1",
        content: { matches: 2 },
        isError: false,
      },
      {
        type: "runtime_warning",
        warningKind: "config_warning",
        message: "minor config warning",
      },
    ]);
    expect(response.text).toBe("final answer");
  });

  it("throws AgentHarnessFailureError from the structural responder", async () => {
    const harness = {
      async run() {
        return {
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
          failure: { kind: "usage_limit", message: "No quota" },
        };
      },
    };

    await expect(createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => undefined },
    )).rejects.toBeInstanceOf(AgentHarnessFailureError);
  });
});

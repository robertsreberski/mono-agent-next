import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();

vi.mock("../ai/runtime/registry.js", () => ({
  resolveRuntimeBridge: (...args) => resolveRuntimeBridgeMock(...args),
}));

const { createRuntime } = await import("../runtime.js");
const { readToolRuntime, resetToolRuntime } = await import("../agent/tools/shared/runtime-context.js");

beforeEach(() => {
  executeMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
  resetToolRuntime();
});

afterEach(() => {
  resetToolRuntime();
});

describe("createRuntime", () => {
  it("exposes run() and configureTools() and threads a per-instance tool context to bridge.execute", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({
      workspace: "/tmp/work",
      repoRoot: "/tmp/repo",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
    });
    expect(typeof runtime.run).toBe("function");
    expect(typeof runtime.configureTools).toBe("function");
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    // The host tool config lives on the per-instance context threaded to the
    // bridge — NOT published to the process-global default context.
    expect(executeMock.mock.calls[0][1].toolContext).toMatchObject({
      workspace: "/tmp/work",
      repoRoot: "/tmp/repo",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
    });
    expect(readToolRuntime().workspace).toBeUndefined();
  });

  it("ignores host keys it does not recognize when building the tool context", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({ workspace: "/tmp/work", unrelated: "ignored" });
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    const { toolContext } = executeMock.mock.calls[0][1];
    expect(toolContext.workspace).toBe("/tmp/work");
    expect(toolContext.unrelated).toBeUndefined();
  });

  it("does not touch the global default tool runtime, regardless of host tool keys", () => {
    createRuntime({ workspace: "/tmp/work", ripgrepPath: "/usr/bin/rg" });
    expect(readToolRuntime().workspace).toBeUndefined();
    expect(readToolRuntime().ripgrepPath).toBeUndefined();
  });

  it("run() throws without a model", async () => {
    const runtime = createRuntime();
    await expect(runtime.run("sys", {})).rejects.toThrow(/requires options.model/);
  });

  it("run() resolves the bridge with the supplied model and executionMode", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    const model = { sdk: "claude", model: "claude-sonnet-4-6" };
    await runtime.run("sys", { model, executionMode: "cli", liveInput: false });
    expect(resolveRuntimeBridgeMock).toHaveBeenCalledWith(model, {
      executionMode: "cli",
      liveInput: false,
    });
  });

  it("run() defaults executionMode to 'sdk' and liveInput to false when omitted", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    expect(resolveRuntimeBridgeMock).toHaveBeenCalledWith(
      { sdk: "claude", model: "x" },
      { executionMode: "sdk", liveInput: false },
    );
  });

  it("emits one metadata-only live_input_applied event after a bridge acknowledges guidance", async () => {
    const acknowledge = vi.fn();
    const events = [];
    executeMock.mockImplementationOnce(async (_systemPrompt, options) => {
      const next = await options.liveInput[Symbol.asyncIterator]().next();
      next.value.acknowledge();
      next.value.acknowledge();
      return { text: "ok", events: [] };
    });
    const runtime = createRuntime();
    const liveInput = {
      async *[Symbol.asyncIterator]() {
        yield {
          body: "Do not expose this full guidance",
          id: "follow-up-1",
          receivedAt: "2026-07-22T08:30:00.000Z",
          acknowledge,
        };
      },
    };

    await runtime.run("sys", {
      model: { sdk: "claude", model: "x" },
      liveInput,
      onEvent: (event) => events.push(event),
    });

    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    }]);
    expect(events[0]).not.toHaveProperty("body");
    expect(events[0]).not.toHaveProperty("text");
  });

  it("run() forwards host defaults under per-call options to bridge.execute", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const resolveCustomPricing = () => null;
    const persistArtifact = () => null;
    const onCompactionRecorded = () => undefined;
    const resolvePiApiKey = async () => "key";
    const runtime = createRuntime({
      resolveCustomPricing,
      persistArtifact,
      onCompactionRecorded,
      resolvePiApiKey,
    });
    await runtime.run("sys", {
      model: { sdk: "claude", model: "x" },
      cwd: "/work",
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [systemPrompt, options] = executeMock.mock.calls[0];
    expect(systemPrompt).toBe("sys");
    expect(options).toMatchObject({
      cwd: "/work",
      executionMode: "sdk",
      resolveCustomPricing,
      persistArtifact,
      onCompactionRecorded,
      resolvePiApiKey,
    });
  });

  it("run() lets per-call options override host defaults", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostResolver = () => "host";
    const callResolver = () => "call";
    const runtime = createRuntime({ resolveCustomPricing: hostResolver });
    await runtime.run("sys", {
      model: { sdk: "claude", model: "x" },
      resolveCustomPricing: callResolver,
    });
    expect(executeMock.mock.calls[0][1].resolveCustomPricing).toBe(callResolver);
  });

  it("configureTools() updates the instance context observed by the next run", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({ workspace: "/tmp/initial" });
    runtime.configureTools({ workspace: "/tmp/updated", ripgrepPath: "/opt/rg" });
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    expect(executeMock.mock.calls[0][1].toolContext).toMatchObject({
      workspace: "/tmp/updated",
      ripgrepPath: "/opt/rg",
    });
  });

  it("configureTools() can explicitly clear previously configured tool state", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const sandboxPolicy = { mode: "native", marker: "configured" };
    const sandboxEngine = { name: "srt" };
    const runtime = createRuntime({ sandboxPolicy, sandboxEngine });
    runtime.configureTools({ sandboxPolicy: undefined, sandboxEngine: undefined });

    await runtime.run("sys", { model: { sdk: "claude", model: "x" }, messages: [] });

    const options = executeMock.mock.calls.at(-1)[1];
    expect(options.toolContext.sandboxPolicy).toBeUndefined();
    expect(options.toolContext.sandboxEngine).toBeUndefined();
  });

  it("configureTools() ignores unknown keys", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    runtime.configureTools({ workspace: "/w", bogus: "nope" });
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    const { toolContext } = executeMock.mock.calls[0][1];
    expect(toolContext.workspace).toBe("/w");
    expect(toolContext.bogus).toBeUndefined();
  });

  it("merges prompt overrides with run-over-host per-field precedence", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostInstruction = () => "host-instruction";
    const hostFinalization = () => "host-finalization";
    const runInstruction = () => "run-instruction";
    const runtime = createRuntime({
      prompts: { structuredOutputInstruction: hostInstruction, structuredOutputFinalization: hostFinalization },
    });
    await runtime.run("sys", {
      model: { sdk: "pi", model: "x" },
      // Run overrides ONE field; the host's other prompt default must survive.
      prompts: { structuredOutputInstruction: runInstruction },
    });
    const { prompts } = executeMock.mock.calls[0][1];
    expect(prompts.structuredOutputInstruction).toBe(runInstruction); // run wins
    expect(prompts.structuredOutputFinalization).toBe(hostFinalization); // host fills the rest
  });

  it("passes host-only prompt overrides through when the run supplies none", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostGuidance = () => "g";
    const runtime = createRuntime({ prompts: { liveInputGuidance: hostGuidance } });
    await runtime.run("sys", { model: { sdk: "pi", model: "x" } });
    expect(executeMock.mock.calls[0][1].prompts).toEqual({ liveInputGuidance: hostGuidance });
  });

  it("omits prompts entirely when neither host nor run supply any", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    await runtime.run("sys", { model: { sdk: "pi", model: "x" } });
    expect(executeMock.mock.calls[0][1].prompts).toBeUndefined();
  });

  it("two runtime instances keep independent tool contexts (no cross-instance clobber)", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const a = createRuntime({ workspace: "/tmp/a", runtimeBrand: { schemaPrefix: "aa" } });
    const b = createRuntime({ workspace: "/tmp/b", runtimeBrand: { schemaPrefix: "bb" } });
    // Mutate a AFTER b exists — the old global singleton would have leaked this
    // across both instances.
    a.configureTools({ workspace: "/tmp/a-updated" });
    await a.run("sys", { model: { sdk: "claude", model: "x" } });
    await b.run("sys", { model: { sdk: "claude", model: "x" } });
    const ctxA = executeMock.mock.calls[0][1].toolContext;
    const ctxB = executeMock.mock.calls[1][1].toolContext;
    expect(ctxA).not.toBe(ctxB);
    expect(ctxA.workspace).toBe("/tmp/a-updated");
    expect(ctxB.workspace).toBe("/tmp/b");
    expect(ctxA.runtimeBrand.schemaPrefix).toBe("aa");
    expect(ctxB.runtimeBrand.schemaPrefix).toBe("bb");
    // Neither instance published anything to the process-global default context.
    expect(readToolRuntime().workspace).toBeUndefined();
    expect(readToolRuntime().runtimeBrand.schemaPrefix).toBe("agent_runtime");
  });
});

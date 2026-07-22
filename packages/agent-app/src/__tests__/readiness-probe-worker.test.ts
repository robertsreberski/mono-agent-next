import { describe, expect, it, vi } from "vitest";

import type {
  CreateMonoRuntimeOptions,
  MonoRuntimeLike,
  RuntimeEventLike,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import {
  readWorkerData,
  runReadinessProbeWorker,
  safeWorkerMessage,
  toolActionInEvent,
} from "../readiness-probe-worker.js";
import type {
  ReadinessWorkerDependencies,
  ReadinessWorkerOutput,
  ReadinessWorkerPort,
} from "../readiness-probe-worker.js";

const SYNTHETIC_SECRET = "sk-test-secret";

function validWorkerData(): Record<string, unknown> {
  return {
    cwd: "/tmp/readiness-cwd",
    runtime: {
      model: {
        sdk: "pi",
        provider: "test-provider",
        model: "test-model",
        reference: "pi:test-provider:test-model",
      },
      executionMode: "sdk",
      effort: "high",
      workspace: "/tmp/readiness-workspace",
      artifactDir: "/tmp/readiness-artifacts",
      piAuthPath: "/tmp/readiness-auth.json",
      piTransport: "sse",
      ignoredRuntimeField: "not-forwarded",
    },
    ignoredTopLevelField: "not-forwarded",
  };
}

class CloneCheckingPort implements ReadinessWorkerPort {
  readonly messages: ReadinessWorkerOutput[] = [];
  closed = false;
  private messageListener: ((message: unknown) => void) | undefined;

  on(event: "message", listener: (message: unknown) => void): this {
    if (event === "message") {
      this.messageListener = listener;
    }
    return this;
  }

  postMessage(message: ReadinessWorkerOutput): void {
    // Mirror worker_threads structured-clone behavior: every asserted output
    // must be serializable, not merely structurally convenient in-process.
    this.messages.push(structuredClone(message));
  }

  close(): void {
    this.closed = true;
  }

  emit(message: unknown): void {
    this.messageListener?.(structuredClone(message));
  }
}

const noPiResolver: ReadinessWorkerDependencies["createPiApiKeyResolver"] = () =>
  async () => undefined;

function dependenciesWith(
  runtime: MonoRuntimeLike,
  captureOptions?: (options: CreateMonoRuntimeOptions) => void,
): ReadinessWorkerDependencies {
  return {
    createRuntime: (options) => {
      captureOptions?.(options);
      return runtime;
    },
    createPiApiKeyResolver: noPiResolver,
  };
}

describe("readWorkerData", () => {
  it("accepts and projects a complete clone-safe payload", () => {
    // Mutation sentinel: weakening or accidentally inverting readWorkerData's
    // positive validation makes this acceptance-critical assertion fail.
    expect(readWorkerData(validWorkerData())).toEqual({
      cwd: "/tmp/readiness-cwd",
      runtime: {
        model: {
          sdk: "pi",
          provider: "test-provider",
          model: "test-model",
          reference: "pi:test-provider:test-model",
        },
        executionMode: "sdk",
        effort: "high",
        workspace: "/tmp/readiness-workspace",
        artifactDir: "/tmp/readiness-artifacts",
        piAuthPath: "/tmp/readiness-auth.json",
        piTransport: "sse",
      },
    });
  });

  it("accepts the required-only payload without inventing optional fields", () => {
    expect(readWorkerData({
      cwd: "/tmp/readiness-cwd",
      runtime: {
        model: { sdk: "codex", model: "test-model" },
        workspace: "/tmp/readiness-workspace",
        artifactDir: "/tmp/readiness-artifacts",
      },
    })).toEqual({
      cwd: "/tmp/readiness-cwd",
      runtime: {
        model: { sdk: "codex", model: "test-model" },
        workspace: "/tmp/readiness-workspace",
        artifactDir: "/tmp/readiness-artifacts",
      },
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["non-string cwd", { ...validWorkerData(), cwd: 7 }],
    ["missing runtime", { cwd: "/tmp/readiness-cwd" }],
    ["array runtime", { ...validWorkerData(), runtime: [] }],
    ["missing model", { ...validWorkerData(), runtime: { workspace: "/tmp/w", artifactDir: "/tmp/a" } }],
    ["array model", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, model: [] } }],
    ["non-string model sdk", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, model: { sdk: 1, model: "m" } } }],
    ["non-string model name", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, model: { sdk: "pi", model: 1 } } }],
    ["non-string provider", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, model: { sdk: "pi", model: "m", provider: 1 } } }],
    ["non-string reference", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, model: { sdk: "pi", model: "m", reference: 1 } } }],
    ["non-string executionMode", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, executionMode: 1 } }],
    ["non-string effort", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, effort: 1 } }],
    ["missing workspace", { ...validWorkerData(), runtime: { model: { sdk: "pi", model: "m" }, artifactDir: "/tmp/a" } }],
    ["non-string workspace", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, workspace: 1 } }],
    ["missing artifactDir", { ...validWorkerData(), runtime: { model: { sdk: "pi", model: "m" }, workspace: "/tmp/w" } }],
    ["non-string artifactDir", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, artifactDir: 1 } }],
    ["non-string piAuthPath", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, piAuthPath: 1 } }],
    ["non-string piTransport", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, piTransport: 1 } }],
    ["unsupported piTransport", { ...validWorkerData(), runtime: { ...validWorkerData().runtime as object, piTransport: "stdio" } }],
  ])("rejects deliberate-invalid %s payloads", (_label, payload) => {
    expect(readWorkerData(payload)).toBeUndefined();
  });
});

describe("safeWorkerMessage", () => {
  it("redacts environment, resolver, bearer, labelled, and generic token values before bounding output", () => {
    const environmentSecret = "test-api-key";
    const resolverSecret = "resolver-test-secret";
    const genericToken = "testtoken".repeat(4);
    const message = safeWorkerMessage(
      new Error(
        `Bearer bearer-test-value api_key=${environmentSecret} resolver=${resolverSecret} ` +
        `${genericToken}\n${"ordinary ".repeat(100)}`,
      ),
      "fallback",
      new Set([resolverSecret]),
      { PROVIDER_API_KEY: environmentSecret },
    );

    expect(message).toContain("Bearer [REDACTED]");
    expect(message).toContain("api_key=[REDACTED]");
    expect(message).not.toContain(environmentSecret);
    expect(message).not.toContain(resolverSecret);
    expect(message).not.toContain(genericToken);
    expect(message).not.toContain("\n");
    expect(message).toHaveLength(400);
    expect(message.endsWith("…")).toBe(true);
  });

  it("uses the fallback for empty and non-error values", () => {
    expect(safeWorkerMessage("   ", "safe fallback", new Set(), {})).toBe("safe fallback");
    expect(safeWorkerMessage({ message: "not trusted" }, "safe fallback", new Set(), {})).toBe("safe fallback");
  });
});

describe("toolActionInEvent", () => {
  it.each([
    [{ type: "dynamicToolCall" }, "dynamic_tool_call"],
    [{ type: "assistant", item: { type: "mcp/tool-call" } }, "mcp_tool_call"],
    [{ type: "assistant", message: { content: [null, [], { type: "toolUse" }] } }, "tool_use"],
    [{ type: "assistant", message: { content: [{ type: "text" }, { type: "tool-result" }] } }, "tool_result"],
  ])("detects normalized tool action %#", (event, expected) => {
    expect(toolActionInEvent(event)).toBe(expected);
  });

  it("ignores malformed and ordinary events", () => {
    expect(toolActionInEvent({ type: 7 } as unknown as RuntimeEventLike)).toBeUndefined();
    expect(toolActionInEvent({ type: "assistant", item: [], message: null })).toBeUndefined();
    expect(toolActionInEvent({ type: "assistant", message: { content: "text" } })).toBeUndefined();
    expect(toolActionInEvent({ type: "assistant", message: { content: [null, [], { type: "text" }] } })).toBeUndefined();
  });
});

describe("runReadinessProbeWorker", () => {
  it("reports invalid startup data without constructing a runtime", async () => {
    const port = new CloneCheckingPort();
    const createRuntime = vi.fn(() => {
      throw new Error("runtime must not be constructed");
    });

    await runReadinessProbeWorker({
      port,
      workerData: { cwd: "/tmp", runtime: {} },
      environment: {},
      dependencies: {
        createRuntime,
        createPiApiKeyResolver: noPiResolver,
      },
    });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(port.messages).toEqual([{
      type: "error",
      message: "The isolated readiness worker received invalid startup data.",
    }]);
  });

  it("constructs one exact no-tool runtime probe and serializes only result state", async () => {
    const port = new CloneCheckingPort();
    const workerData = validWorkerData();
    delete (workerData.runtime as Record<string, unknown>).piAuthPath;
    let createOptions: CreateMonoRuntimeOptions | undefined;
    let runOptions: RuntimeRunOptions | undefined;
    const disposeAllSessions = vi.fn(async () => undefined);
    const runtime: MonoRuntimeLike = {
      run: vi.fn(async (systemPrompt, options): Promise<RuntimeResult> => {
        expect(systemPrompt).toBe("Reply concisely. Do not use tools.");
        runOptions = options;
        return { text: "  readiness acknowledged  " };
      }),
      disposeAllSessions,
    };

    await runReadinessProbeWorker({
      port,
      workerData,
      environment: { PATH: "/usr/bin:/bin", OMITTED: undefined },
      dependencies: dependenciesWith(runtime, (options) => { createOptions = options; }),
    });

    expect(createOptions).toEqual({
      workspace: "/tmp/readiness-workspace",
      qaOutputDir: "/tmp/readiness-artifacts",
    });
    expect(runOptions).toMatchObject({
      model: {
        sdk: "pi",
        provider: "test-provider",
        model: "test-model",
        reference: "pi:test-provider:test-model",
      },
      executionMode: "sdk",
      effort: "high",
      messages: [{ role: "user", content: "Reply with a short readiness acknowledgement." }],
      cwd: "/tmp/readiness-cwd",
      maxTurns: 1,
      piTransport: "sse",
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      codexNoToolsProbe: true,
      sessionKeepAlive: false,
      providerEnv: { PATH: "/usr/bin:/bin" },
    });
    expect(Object.isFrozen(runOptions?.providerEnv)).toBe(true);
    expect(port.messages).toEqual([
      { type: "result", hasText: true, cancelled: false },
      { type: "disposed" },
    ]);
    expect(JSON.stringify(port.messages)).not.toContain("readiness acknowledged");
    expect(disposeAllSessions).toHaveBeenCalledOnce();
    expect(port.closed).toBe(true);
  });

  it("redacts and bounds provider failure fields before clone-safe serialization", async () => {
    const port = new CloneCheckingPort();
    const runtime: MonoRuntimeLike = {
      run: async () => ({
        text: "partial text stays private",
        cancelled: true,
        failureKind: "provider_unavailable",
        error: `api_key=${SYNTHETIC_SECRET} ${"x".repeat(500)}`,
      }),
      disposeAllSessions: async () => undefined,
    };

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: { PROVIDER_API_KEY: SYNTHETIC_SECRET },
      dependencies: dependenciesWith(runtime),
    });

    expect(port.messages[0]).toEqual({
      type: "result",
      hasText: true,
      cancelled: true,
      failureKind: "provider_unavailable",
      errorMessage: expect.stringContaining("api_key=[REDACTED]"),
    });
    const first = port.messages[0];
    expect(first?.type === "result" ? first.errorMessage?.length : 0).toBeLessThanOrEqual(400);
    expect(JSON.stringify(port.messages)).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(port.messages)).not.toContain("partial text stays private");
    expect(port.messages.at(-1)).toEqual({ type: "disposed" });
  });

  it("redacts runtime-construction failures and still closes the port", async () => {
    const port = new CloneCheckingPort();

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: { PROVIDER_API_KEY: SYNTHETIC_SECRET },
      dependencies: {
        createRuntime: () => {
          throw new Error(`Bearer ${SYNTHETIC_SECRET}`);
        },
        createPiApiKeyResolver: noPiResolver,
      },
    });

    expect(port.messages).toEqual([
      { type: "error", message: "Bearer [REDACTED]" },
      { type: "disposed" },
    ]);
    expect(port.closed).toBe(true);
  });

  it("redacts rejected probes and treats rejected disposal as best effort", async () => {
    const port = new CloneCheckingPort();
    const disposeAllSessions = vi.fn(async () => {
      throw new Error("dispose failed");
    });
    const runtime: MonoRuntimeLike = {
      run: async () => {
        throw new Error(`secret=${SYNTHETIC_SECRET}`);
      },
      disposeAllSessions,
    };

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: { PROVIDER_SECRET: SYNTHETIC_SECRET },
      dependencies: dependenciesWith(runtime),
    });

    expect(port.messages).toEqual([
      { type: "error", message: "secret=[REDACTED]" },
      { type: "disposed" },
    ]);
    expect(disposeAllSessions).toHaveBeenCalledOnce();
    expect(port.closed).toBe(true);
  });

  it("propagates the parent timeout abort into the runtime signal and disposal", async () => {
    const port = new CloneCheckingPort();
    let seenSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const disposeAllSessions = vi.fn(async () => undefined);
    const runtime: MonoRuntimeLike = {
      run: (_systemPrompt, options) => new Promise<RuntimeResult>((resolve) => {
        seenSignal = options.abortSignal;
        markStarted?.();
        options.abortSignal.addEventListener("abort", () => {
          resolve({ text: "", cancelled: true });
        }, { once: true });
      }),
      disposeAllSessions,
    };

    const pending = runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: {},
      dependencies: dependenciesWith(runtime),
    });
    await started;
    port.emit(null);
    expect(seenSignal?.aborted).toBe(false);
    port.emit({ type: "abort" });
    await pending;

    expect(seenSignal?.aborted).toBe(true);
    expect(disposeAllSessions).toHaveBeenCalledOnce();
    expect(port.messages).toEqual([
      { type: "result", hasText: false, cancelled: true },
      { type: "disposed" },
    ]);
    expect(port.closed).toBe(true);
  });

  it("does not construct a runtime when abort arrives before startup", async () => {
    const port = new CloneCheckingPort();
    port.on = (_event, listener): CloneCheckingPort => {
      listener({ type: "abort" });
      return port;
    };
    const createRuntime = vi.fn(() => {
      throw new Error("runtime must not be constructed");
    });

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: {},
      dependencies: {
        createRuntime,
        createPiApiKeyResolver: noPiResolver,
      },
    });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(port.messages).toEqual([
      { type: "result", hasText: false, cancelled: true },
      { type: "disposed" },
    ]);
    expect(port.closed).toBe(true);
  });

  it("reports tool actions found in returned events instead of a successful result", async () => {
    const port = new CloneCheckingPort();
    const runtime: MonoRuntimeLike = {
      run: async () => ({
        text: "must not count as ready",
        events: [{ type: "assistant", message: { content: [{ type: "tool_use" }] } }],
      }),
      disposeAllSessions: async () => undefined,
    };

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: {},
      dependencies: dependenciesWith(runtime),
    });

    expect(port.messages).toEqual([
      { type: "tool", action: "tool_use" },
      { type: "disposed" },
    ]);
  });

  it("aborts and disposes when a tool action is observed live", async () => {
    const port = new CloneCheckingPort();
    const disposeAllSessions = vi.fn(async () => undefined);
    let seenSignal: AbortSignal | undefined;
    const runtime: MonoRuntimeLike = {
      run: async (_systemPrompt, options) => {
        seenSignal = options.abortSignal;
        options.onEvent?.({ type: "fileChange" });
        return { text: "must not count as ready" };
      },
      disposeAllSessions,
    };

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: {},
      dependencies: dependenciesWith(runtime),
    });

    expect(seenSignal?.aborted).toBe(true);
    expect(port.messages[0]).toEqual({ type: "tool", action: "file_change" });
    expect(port.messages.some((message) => message.type === "result")).toBe(false);
    expect(port.messages.at(-1)).toEqual({ type: "disposed" });
    expect(disposeAllSessions).toHaveBeenCalledOnce();
  });

  it("tracks a Pi credential resolved during the probe and redacts it before IPC", async () => {
    const port = new CloneCheckingPort();
    const resolver = vi.fn(async () => SYNTHETIC_SECRET);
    const createPiApiKeyResolver = vi.fn(() => resolver);
    let createOptions: CreateMonoRuntimeOptions | undefined;
    const runtime: MonoRuntimeLike = {
      run: async () => {
        const secret = await createOptions?.resolvePiApiKey?.("test-provider");
        return {
          failureKind: "provider_unavailable",
          error: `provider rejected ${secret}`,
        };
      },
      disposeAllSessions: async () => undefined,
    };

    await runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: {},
      dependencies: {
        createRuntime: (options) => {
          createOptions = options;
          return runtime;
        },
        createPiApiKeyResolver,
      },
    });

    expect(createPiApiKeyResolver).toHaveBeenCalledWith({ path: "/tmp/readiness-auth.json" });
    expect(resolver).toHaveBeenCalledWith("test-provider");
    expect(port.messages[0]).toEqual({
      type: "result",
      hasText: false,
      cancelled: false,
      failureKind: "provider_unavailable",
      errorMessage: "provider rejected [REDACTED]",
    });
    expect(JSON.stringify(port.messages)).not.toContain(SYNTHETIC_SECRET);
  });

  it("finishes disposal even if the parent port has already rejected serialized output", async () => {
    const port = new CloneCheckingPort();
    port.postMessage = () => {
      throw new Error("port already closed");
    };
    const disposeAllSessions = vi.fn(async () => undefined);

    await expect(runReadinessProbeWorker({
      port,
      workerData: validWorkerData(),
      environment: {},
      dependencies: dependenciesWith({
        run: async () => ({ text: "ready" }),
        disposeAllSessions,
      }),
    })).resolves.toBeUndefined();

    expect(disposeAllSessions).toHaveBeenCalledOnce();
    expect(port.closed).toBe(true);
  });
});

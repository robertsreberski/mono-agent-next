// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  type RuntimeTurnContext,
  type RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import type {
  SandboxExecutor,
  SandboxProcess,
} from "@mono-agent/module-sdk/internal";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeCliProcessTerminationError,
  createClaudeCliTransport,
  type ProcessLike,
} from "../cli.js";
import { parseRuntimeClaudeConfig } from "../config.js";
import { createRuntimeClaude, RuntimeClaudeError } from "../runtime.js";
import { createClaudeSdkTransport } from "../sdk.js";
import type {
  ClaudeTransport,
  ClaudeTransportEvents,
  ClaudeTransportResult,
} from "../transport.js";

class ControlledClaudeProcess extends EventEmitter implements ProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: NodeJS.WritableStream;
  readonly signals: NodeJS.Signals[] = [];
  readonly #onKill: ((signal: NodeJS.Signals) => void) | undefined;
  prompt = "";

  constructor(
    stdin?: NodeJS.WritableStream,
    onKill?: (signal: NodeJS.Signals) => void,
  ) {
    super();
    this.#onKill = onKill;
    this.stdin = stdin ?? new Writable({
      write: (chunk, _encoding, callback) => {
        this.prompt += String(chunk);
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.#onKill?.(signal);
    return true;
  }

  finish(
    lines: readonly unknown[],
    options: {
      readonly code?: number;
      readonly signal?: NodeJS.Signals | null;
      readonly stderr?: string;
    } = {},
  ): void {
    if (options.stderr !== undefined) this.stderr.write(options.stderr);
    this.stdout.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    this.stderr.end();
    this.emit("close", options.code ?? 0, options.signal ?? null);
  }
}

const transportEvents: ClaudeTransportEvents = {
  text() {},
  thinking() {},
  session() {},
  usage() {},
  control() {},
};

function transportRequest(
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    model: "claude-opus-4-8",
    prompt: "hello",
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    signal,
  };
}

function turnRequest(
  signal: AbortSignal = new AbortController().signal,
  sessionId?: string,
): RuntimeTurnRequest {
  return {
    turnId: "turn",
    conversationId: "conversation",
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    signal,
    ...(sessionId === undefined
      ? {}
      : {
          session: {
            id: sessionId,
            conversationId: "conversation",
            route: {
              runtimeInstanceId: "claude-runtime",
              model: "claude-opus-4-8",
            },
          },
        }),
  };
}

const runtimeContext: RuntimeTurnContext = {
  emit() {},
  async executeTool(call) {
    return { callId: call.id, content: [] };
  },
};

function cliOptions(spawnProcess: () => ProcessLike) {
  return {
    binary: "claude",
    timeoutMs: 5_000,
    maxLineBytes: 16_384,
    maxStderrBytes: 4_096,
    spawnProcess,
  };
}

describe("runtime-claude failure paths", () => {
  it("contains an asynchronous CLI stdin EPIPE to the failed turn", async () => {
    const brokenPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    let child!: ControlledClaudeProcess;
    child = new ControlledClaudeProcess(new Writable({
      write(_chunk, _encoding, callback) {
        callback(brokenPipe);
      },
    }), (signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
    });
    const transport = createClaudeCliTransport(cliOptions(() => child));

    await expect(transport.run(transportRequest(), transportEvents))
      .rejects.toMatchObject({ code: "EPIPE", message: "write EPIPE" });
    expect(child.signals).toContain("SIGTERM");
  });

  it.each(["stdout", "stderr"] as const)(
    "contains a CLI %s stream error to the failed turn",
    async (stream) => {
      let child!: ControlledClaudeProcess;
      child = new ControlledClaudeProcess(undefined, (signal) => {
        queueMicrotask(() => child.emit("close", null, signal));
      });
      let didLaunch!: () => void;
      const launched = new Promise<void>((resolve) => {
        didLaunch = resolve;
      });
      const transport = createClaudeCliTransport(cliOptions(() => {
        didLaunch();
        return child;
      }));
      const pending = transport.run(transportRequest(), transportEvents);
      const rejected = expect(pending).rejects.toThrow(`${stream} pipe failed`);

      await launched;
      child[stream].emit("error", new Error(`${stream} pipe failed`));
      await rejected;
      expect(child.signals).toContain("SIGTERM");
    },
  );

  it("does not launch the CLI when stop wins prompt-file creation", async () => {
    const spawnProcess = vi.fn<() => ProcessLike>();
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "cli" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess,
    });
    const signal = new AbortController().signal;
    await runtime.start?.({ signal });
    const inFlight = runtime.runTurn({
      ...turnRequest(),
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "private instructions" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }, runtimeContext);
    const settledInFlight = expect(inFlight).resolves.toMatchObject({
      status: "cancelled",
    });

    await runtime.stop?.({ signal, reason: "shutdown" });
    await settledInFlight;
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "stopped", activeTurns: 0 },
    });
  });

  it("cli transport escalates SIGTERM then SIGKILL on timeout", async () => {
    vi.useFakeTimers();
    try {
      let child!: ControlledClaudeProcess;
      child = new ControlledClaudeProcess(undefined, (signal) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => child.emit("close", null, signal));
        }
      });
      let promptPath: string | undefined;
      let didLaunch!: () => void;
      const launched = new Promise<void>((resolve) => {
        didLaunch = resolve;
      });
      const transport = createClaudeCliTransport({
        ...cliOptions(() => child),
        timeoutMs: 5,
        spawnProcess(_command, args) {
          promptPath = args[args.indexOf("--system-prompt-file") + 1];
          didLaunch();
          return child;
        },
      });
      const pending = transport.run(
        { ...transportRequest(), systemPrompt: "private instructions" },
        transportEvents,
      );
      const rejected = expect(pending).rejects.toThrow(
        "Claude CLI timed out after 5ms",
      );
      let didSettle = false;
      const settlement = pending.then(
        () => { didSettle = true; },
        () => { didSettle = true; },
      );

      await launched;
      expect(promptPath).toBeDefined();
      expect(existsSync(promptPath as string)).toBe(true);
      await vi.advanceTimersByTimeAsync(5);
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(didSettle).toBe(false);

      await vi.advanceTimersByTimeAsync(999);
      expect(didSettle).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      await settlement;
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(existsSync(promptPath as string)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires close after SIGKILL and retains isolation until a late close", async () => {
    vi.useFakeTimers();
    const dataDirectory = realpathSync(mkdtempSync(
      join(tmpdir(), "runtime-claude-stubborn-cli-"),
    ));
    let child: ControlledClaudeProcess | undefined;
    try {
      child = new ControlledClaudeProcess();
      let promptPath: string | undefined;
      let didLaunch!: () => void;
      const launched = new Promise<void>((resolve) => {
        didLaunch = resolve;
      });
      const transport = createClaudeCliTransport({
        ...cliOptions(() => child as ControlledClaudeProcess),
        timeoutMs: 5,
        terminationGraceMs: 5,
        dataDirectory,
        spawnProcess(_command, args) {
          promptPath = args[args.indexOf("--system-prompt-file") + 1];
          didLaunch();
          return child as ControlledClaudeProcess;
        },
      });
      const pending = transport.run(
        { ...transportRequest(), systemPrompt: "private instructions" },
        transportEvents,
      );
      const failure = pending.then(
        () => undefined,
        (error: unknown) => error,
      );

      await launched;
      await vi.advanceTimersByTimeAsync(5);
      expect(child.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(5);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(5);
      const terminationError = await failure;
      expect(terminationError).toBeInstanceOf(
        ClaudeCliProcessTerminationError,
      );
      expect((terminationError as Error).cause).toMatchObject({
        message: "Claude CLI timed out after 5ms",
      });

      expect(promptPath).toBeDefined();
      expect(existsSync(promptPath as string)).toBe(true);
      vi.useRealTimers();
      child.emit("close", null, "SIGKILL");
      await vi.waitFor(() => {
        expect(existsSync(promptPath as string)).toBe(false);
      });
    } finally {
      child?.emit("close", null, "SIGKILL");
      rmSync(dataDirectory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("rejects an invalid CLI termination grace", () => {
    expect(() => createClaudeCliTransport({
      ...cliOptions(() => new ControlledClaudeProcess()),
      terminationGraceMs: 0,
    })).toThrow("terminationGraceMs must be a positive safe integer");
  });

  it.each(["abort", "timeout"] as const)(
    "bounds %s when an active CLI event callback never settles",
    async (trigger) => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        let child!: ControlledClaudeProcess;
        child = new ControlledClaudeProcess(undefined, (signal) => {
          if (signal === "SIGKILL") {
            queueMicrotask(() => child.emit("close", null, signal));
          }
        });
        let didLaunch!: () => void;
        const launched = new Promise<void>((resolve) => {
          didLaunch = resolve;
        });
        const transport = createClaudeCliTransport({
          ...cliOptions(() => child),
          timeoutMs: trigger === "timeout" ? 5 : 5_000,
          spawnProcess() {
            didLaunch();
            return child;
          },
        });
        let didStartEmit!: () => void;
        const startedEmit = new Promise<void>((resolve) => {
          didStartEmit = resolve;
        });
        const pending = transport.run(
          transportRequest(controller.signal),
          {
            ...transportEvents,
            text() {
              didStartEmit();
              return new Promise<void>(() => undefined);
            },
          },
        );
        const rejected = expect(pending).rejects.toThrow(
          trigger === "abort"
            ? "turn aborted"
            : "Claude CLI timed out after 5ms",
        );
        let didSettle = false;
        void pending.then(
          () => { didSettle = true; },
          () => { didSettle = true; },
        );

        await launched;
        child.stdout.write(`${JSON.stringify({
          type: "stream_event",
          session_id: "cli-session",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "blocked emit" },
          },
        })}\n`);
        await startedEmit;
        if (trigger === "abort") controller.abort(new Error("turn aborted"));
        else await vi.advanceTimersByTimeAsync(5);

        await vi.advanceTimersByTimeAsync(999);
        expect(didSettle).toBe(false);
        expect(child.signals).toEqual(["SIGTERM"]);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(didSettle).toBe(true);
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cli transport surfaces provider error with redacted stderr", async () => {
    const secret = "configured-provider-secret";
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({
        mode: "cli",
        auth: { method: "api-key", token: secret },
      }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess() {
        const child = new ControlledClaudeProcess();
        queueMicrotask(() => child.finish([
          {
            type: "result",
            subtype: "error_during_execution",
            session_id: "cli-session",
            errors: [`provider rejected ${secret}`, "retry later"],
          },
        ], { stderr: `stderr also contained ${secret}` }));
        return child;
      },
    });
    await runtime.start?.({ signal: new AbortController().signal });

    let failure: unknown;
    try {
      await runtime.runTurn(turnRequest(), runtimeContext);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeClaudeError);
    expect(failure).toMatchObject({
      code: "PROVIDER_FAILED",
      message: "provider rejected [REDACTED]; retry later",
    });
    expect(String(failure)).not.toContain(secret);
    expect((failure as RuntimeClaudeError).cause).toMatchObject({
      message: "provider rejected [REDACTED]; retry later",
    });
  });

  it("cli transport maps missing native continuation to SESSION_UNAVAILABLE", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "cli" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess() {
        const child = new ControlledClaudeProcess();
        queueMicrotask(() => child.finish([{
          type: "result",
          subtype: "error_during_execution",
          session_id: sessionId,
          errors: [`Session ${sessionId} not found in any project directory`],
        }]));
        return child;
      },
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await expect(runtime.runTurn(
      turnRequest(new AbortController().signal, sessionId),
      runtimeContext,
    )).rejects.toMatchObject({
      code: RUNTIME_SESSION_UNAVAILABLE_CODE,
      retryability: "not-retryable",
      sideEffects: "none",
    });
  });

  it("settles callback work and cleans the prompt file on abort", async () => {
    const controller = new AbortController();
    let child!: ControlledClaudeProcess;
    child = new ControlledClaudeProcess(undefined, (signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
    });
    let promptPath: string | undefined;
    let didLaunch!: () => void;
    const launched = new Promise<void>((resolve) => {
      didLaunch = resolve;
    });
    const transport = createClaudeCliTransport({
      ...cliOptions(() => child),
      spawnProcess(_command, args) {
        promptPath = args[args.indexOf("--system-prompt-file") + 1];
        didLaunch();
        return child;
      },
    });
    let didStartEmit!: () => void;
    const startedEmit = new Promise<void>((resolve) => {
      didStartEmit = resolve;
    });
    let rejectEmit!: (error: Error) => void;
    const blockedEmit = new Promise<void>((_resolve, reject) => {
      rejectEmit = reject;
    });
    const text = vi.fn(() => {
      didStartEmit();
      return blockedEmit;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const pending = transport.run(
        {
          ...transportRequest(controller.signal),
          systemPrompt: "private instructions",
        },
        {
          ...transportEvents,
          text,
        },
      );
      const rejected = expect(pending).rejects.toThrow("turn aborted");
      await launched;
      child.stdout.write(`${JSON.stringify({
        type: "stream_event",
        session_id: "cli-session",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "before abort" },
        },
      })}\n`);
      await startedEmit;

      controller.abort(new Error("turn aborted"));
      rejectEmit(new Error("emit failed after abort"));
      await rejected;

      expect(promptPath).toBeDefined();
      expect(existsSync(promptPath as string)).toBe(false);
      child.stdout.write(`${JSON.stringify({
        type: "stream_event",
        session_id: "cli-session",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "after rejection" },
        },
      })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(text).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("SDK transport aborts while query creation is pending", async () => {
    let didStartQuery!: () => void;
    const startedQuery = new Promise<void>((resolve) => {
      didStartQuery = resolve;
    });
    const transport = createClaudeSdkTransport({
      async query(input) {
        const abortController = input.options.abortController as AbortController;
        didStartQuery();
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) resolve();
          else abortController.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw abortController.signal.reason;
      },
    });
    const controller = new AbortController();
    const pending = transport.run(
      transportRequest(controller.signal),
      transportEvents,
    );
    const rejected = expect(pending).rejects.toThrow("cancel query creation");

    await startedQuery;
    controller.abort(new Error("cancel query creation"));
    await rejected;
  });

  it("SDK transport settles uncooperative creation and closes a late query", async () => {
    let didStartQuery!: () => void;
    const startedQuery = new Promise<void>((resolve) => {
      didStartQuery = resolve;
    });
    let resolveQuery!: (query: AsyncIterable<unknown> & {
      interrupt(): Promise<void>;
      close(): void;
    }) => void;
    const pendingQuery = new Promise<AsyncIterable<unknown> & {
      interrupt(): Promise<void>;
      close(): void;
    }>((resolve) => {
      resolveQuery = resolve;
    });
    const control = vi.fn();
    const transport = createClaudeSdkTransport({
      query() {
        didStartQuery();
        return pendingQuery;
      },
    });
    const controller = new AbortController();
    const pending = transport.run(
      transportRequest(controller.signal),
      { ...transportEvents, control },
    );
    const rejected = expect(pending).rejects.toThrow(
      "cancel uncooperative query creation",
    );

    await startedQuery;
    controller.abort(new Error("cancel uncooperative query creation"));
    await rejected;

    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn();
    resolveQuery({
      async *[Symbol.asyncIterator]() {},
      interrupt,
      close,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(control).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("SDK transport closes its query when control registration throws", async () => {
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn();
    const transport = createClaudeSdkTransport({
      query: () => ({
        async *[Symbol.asyncIterator]() {},
        interrupt,
        close,
      }),
    });

    await expect(transport.run(transportRequest(), {
      ...transportEvents,
      control() {
        throw new Error("host registration failed");
      },
    })).rejects.toThrow("host registration failed");

    expect(interrupt).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("normalizes cached-token usage identically for CLI and SDK", async () => {
    const providerUsage = {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
    };
    const cli = createClaudeCliTransport(cliOptions(() => {
      const child = new ControlledClaudeProcess();
      queueMicrotask(() => child.finish([{
        type: "result",
        subtype: "success",
        session_id: "cli-session",
        result: "done",
        usage: providerUsage,
      }]));
      return child;
    }));
    async function* messages(): AsyncGenerator<unknown> {
      yield {
        type: "result",
        subtype: "success",
        session_id: "sdk-session",
        result: "done",
        usage: providerUsage,
      };
    }
    const iterator = messages() as AsyncGenerator<unknown> & {
      interrupt(): Promise<void>;
      close(): void;
    };
    iterator.interrupt = async () => undefined;
    iterator.close = () => undefined;
    const sdk = createClaudeSdkTransport({ query: () => iterator });

    const [cliResult, sdkResult] = await Promise.all([
      cli.run(transportRequest(), transportEvents),
      sdk.run(transportRequest(), transportEvents),
    ]);

    expect(cliResult.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 23,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
    });
    expect(cliResult.usage).toEqual(sdkResult.usage);
  });

  it("omits usage when either primary metering field is missing", async () => {
    const cliUsage = vi.fn();
    const cli = createClaudeCliTransport(cliOptions(() => {
      const child = new ControlledClaudeProcess();
      queueMicrotask(() => child.finish([{
        type: "result",
        subtype: "success",
        session_id: "cli-session",
        result: "done",
      }]));
      return child;
    }));
    async function* messages(): AsyncGenerator<unknown> {
      yield {
        type: "result",
        subtype: "success",
        session_id: "sdk-session",
        result: "done",
        usage: { input_tokens: 1 },
      };
    }
    const iterator = messages() as AsyncGenerator<unknown> & {
      interrupt(): Promise<void>;
      close(): void;
    };
    iterator.interrupt = async () => undefined;
    iterator.close = () => undefined;
    const sdkUsage = vi.fn();
    const sdk = createClaudeSdkTransport({ query: () => iterator });

    const [cliResult, sdkResult] = await Promise.all([
      cli.run(transportRequest(), { ...transportEvents, usage: cliUsage }),
      sdk.run(transportRequest(), { ...transportEvents, usage: sdkUsage }),
    ]);

    expect(cliResult.usage).toBeUndefined();
    expect(sdkResult.usage).toBeUndefined();
    expect(cliUsage).not.toHaveBeenCalled();
    expect(sdkUsage).not.toHaveBeenCalled();
  });

  it("redacts native Anthropic keys without configured auth", async () => {
    const nativeKey = `sk-ant-api03-${"x".repeat(32)}`;
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: {
        async run() {
          throw new Error(`native provider rejected ${nativeKey}`);
        },
      },
    });
    await runtime.start?.({ signal: new AbortController().signal });

    let failure: unknown;
    try {
      await runtime.runTurn(turnRequest(), runtimeContext);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PROVIDER_FAILED",
      message: "native provider rejected [REDACTED]",
    });
    expect((failure as RuntimeClaudeError).cause).toMatchObject({
      message: "native provider rejected [REDACTED]",
    });
    expect(JSON.stringify(failure)).not.toContain(nativeKey);
  });

  it("stop interrupts in-flight turns and rejects new ones", async () => {
    let rejectTransport!: (error: Error) => void;
    const interrupt = vi.fn(async () => {
      rejectTransport(new Error("interrupted by stop"));
    });
    let didRegisterControl!: () => void;
    const registeredControl = new Promise<void>((resolve) => {
      didRegisterControl = resolve;
    });
    const transport: ClaudeTransport = {
      async run(_request, events): Promise<ClaudeTransportResult> {
        return await new Promise<ClaudeTransportResult>((_resolve, reject) => {
          rejectTransport = reject;
          events.control({ interrupt });
          didRegisterControl();
        });
      },
    };
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: transport,
    });
    const signal = new AbortController().signal;
    await runtime.start?.({ signal });
    const inFlight = runtime.runTurn(turnRequest(), runtimeContext);
    const settledInFlight = expect(inFlight).resolves.toMatchObject({
      status: "cancelled",
    });
    await registeredControl;

    await runtime.stop?.({ signal, reason: "shutdown" });
    await settledInFlight;
    expect(interrupt).toHaveBeenCalledOnce();
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "stopped", activeTurns: 0 },
    });
    await expect(runtime.runTurn(turnRequest(), runtimeContext))
      .rejects.toMatchObject({ code: "RUNTIME_NOT_RUNNING" });

    const drainingTransport = vi.fn<ClaudeTransport["run"]>();
    const drainingRuntime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: { run: drainingTransport },
    });
    await drainingRuntime.start?.({ signal });
    await drainingRuntime.drain?.({ signal });
    await expect(drainingRuntime.runTurn(turnRequest(), runtimeContext))
      .rejects.toMatchObject({ code: "RUNTIME_NOT_RUNNING" });
    expect(drainingTransport).not.toHaveBeenCalled();
  });

  it("joins concurrent stop callers to one shutdown barrier", async () => {
    let didRegisterControl!: () => void;
    const registeredControl = new Promise<void>((resolve) => {
      didRegisterControl = resolve;
    });
    let resolveInterrupt!: () => void;
    const interrupt = vi.fn(() => new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    }));
    const transport: ClaudeTransport = {
      async run(request, events) {
        events.control({ interrupt });
        didRegisterControl();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw request.signal.reason;
      },
    };
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: transport,
    });
    const signal = new AbortController().signal;
    await runtime.start?.({ signal });
    const inFlight = runtime.runTurn(turnRequest(), runtimeContext);
    const settledInFlight = expect(inFlight).resolves.toMatchObject({
      status: "cancelled",
    });
    await registeredControl;

    let firstStopped = false;
    let secondStopped = false;
    const firstStop = Promise.resolve(
      runtime.stop?.({ signal, reason: "shutdown" }),
    ).then(() => { firstStopped = true; });
    await settledInFlight;
    const secondStop = Promise.resolve(
      runtime.stop?.({ signal, reason: "shutdown" }),
    ).then(() => { secondStopped = true; });
    await Promise.resolve();

    expect(interrupt).toHaveBeenCalledOnce();
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "draining", activeTurns: 0 },
    });

    resolveInterrupt();
    await Promise.all([firstStop, secondStop]);
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "stopped", activeTurns: 0 },
    });
  });

  it("settles turn ownership when live-input cleanup throws", async () => {
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: {
        async run(_request, events) {
          events.control({
            async interrupt() {},
            async sendInput() { return true; },
          });
          return { text: "done", sessionId: "sdk-session" };
        },
      },
    });
    const signal = new AbortController().signal;
    await runtime.start?.({ signal });

    await expect(runtime.runTurn(turnRequest(), {
      ...runtimeContext,
      registerLiveInput() {
        return () => {
          throw new Error("unregister failed");
        };
      },
    })).rejects.toThrow("unregister failed");
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "running", activeTurns: 0 },
    });

    await runtime.stop?.({ signal, reason: "shutdown" });
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "stopped", activeTurns: 0 },
    });
  });

  it("bounds a never-settling SDK interrupt and closes the query once", async () => {
    vi.useFakeTimers();
    try {
      let didWaitForMessage!: () => void;
      const waitingForMessage = new Promise<void>((resolve) => {
        didWaitForMessage = resolve;
      });
      let resolveMessage!: (result: IteratorResult<unknown>) => void;
      const interrupt = vi.fn(() => new Promise<void>(() => undefined));
      const close = vi.fn(() => {
        resolveMessage?.({ done: true, value: undefined });
      });
      const query = {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next() {
              didWaitForMessage();
              return new Promise<IteratorResult<unknown>>((resolve) => {
                resolveMessage = resolve;
              });
            },
          };
        },
        interrupt,
        close,
      };
      const runtime = createRuntimeClaude({
        config: parseRuntimeClaudeConfig({ mode: "sdk" }),
        instanceId: "claude-runtime",
        workspaceDirectory: process.cwd(),
        sdkTransport: createClaudeSdkTransport({ query: () => query }),
      });
      const signal = new AbortController().signal;
      await runtime.start?.({ signal });
      const inFlight = runtime.runTurn(turnRequest(), runtimeContext);
      const settledInFlight = expect(inFlight).resolves.toMatchObject({
        status: "cancelled",
      });
      await waitingForMessage;

      let didStop = false;
      const stopping = Promise.resolve(
        runtime.stop?.({ signal, reason: "shutdown" }),
      ).then(() => { didStop = true; });
      await Promise.resolve();
      expect(interrupt).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(didStop).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([stopping, settledInFlight]);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(await runtime.health?.({ signal })).toMatchObject({
        details: { state: "stopped", activeTurns: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts a late control after caller cancellation", async () => {
    let didStartTransport!: () => void;
    const startedTransport = new Promise<void>((resolve) => {
      didStartTransport = resolve;
    });
    let didInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      didInterrupt = resolve;
    });
    const interrupt = vi.fn(async () => {
      didInterrupt();
    });
    const transport: ClaudeTransport = {
      async run(request, events) {
        didStartTransport();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        events.control({ interrupt });
        await interrupted;
        return { text: "must be cancelled", sessionId: "late-session" };
      },
    };
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: transport,
    });
    const signal = new AbortController().signal;
    const turnController = new AbortController();
    await runtime.start?.({ signal });
    const inFlight = runtime.runTurn(
      turnRequest(turnController.signal),
      runtimeContext,
    );
    const settledInFlight = expect(inFlight).resolves.toMatchObject({
      status: "cancelled",
    });
    await startedTransport;

    turnController.abort(new Error("caller cancelled"));
    await settledInFlight;

    expect(interrupt).toHaveBeenCalledOnce();
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "running", activeTurns: 0 },
    });
  });

  it("stop owns a turn before transport control registers", async () => {
    let didStartTransport!: () => void;
    const startedTransport = new Promise<void>((resolve) => {
      didStartTransport = resolve;
    });
    let didInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      didInterrupt = resolve;
    });
    const interrupt = vi.fn(async () => {
      didInterrupt();
    });
    const transport: ClaudeTransport = {
      async run(request, events) {
        didStartTransport();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        events.control({ interrupt });
        await interrupted;
        return { text: "must be cancelled", sessionId: "late-session" };
      },
    };
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: transport,
    });
    const signal = new AbortController().signal;
    await runtime.start?.({ signal });
    const inFlight = runtime.runTurn(turnRequest(), runtimeContext);
    const settledInFlight = expect(inFlight).resolves.toMatchObject({
      status: "cancelled",
    });
    await startedTransport;
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "running", activeTurns: 1 },
    });

    await runtime.stop?.({ signal, reason: "shutdown" });
    await settledInFlight;
    expect(interrupt).toHaveBeenCalledOnce();
    expect(await runtime.health?.({ signal })).toMatchObject({
      details: { state: "stopped", activeTurns: 0 },
    });
  });

  it("CLI stop escalates to SIGKILL and waits for prompt cleanup", async () => {
    vi.useFakeTimers();
    try {
      let child!: ControlledClaudeProcess;
      child = new ControlledClaudeProcess(undefined, (signal) => {
        if (signal === "SIGKILL") child.emit("close", null, "SIGKILL");
      });
      let promptPath: string | undefined;
      let didLaunch!: () => void;
      const launched = new Promise<void>((resolve) => {
        didLaunch = resolve;
      });
      const runtime = createRuntimeClaude({
        config: parseRuntimeClaudeConfig({ mode: "cli", timeoutMs: 5_000 }),
        instanceId: "claude-runtime",
        workspaceDirectory: process.cwd(),
        spawnProcess(_command, args) {
          promptPath = args[args.indexOf("--system-prompt-file") + 1];
          didLaunch();
          return child;
        },
      });
      const signal = new AbortController().signal;
      await runtime.start?.({ signal });
      const inFlight = runtime.runTurn({
        ...turnRequest(),
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "private instructions" }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      }, runtimeContext);
      const settledInFlight = expect(inFlight).resolves.toMatchObject({
        status: "cancelled",
      });
      await launched;
      expect(promptPath).toBeDefined();
      expect(existsSync(promptPath as string)).toBe(true);

      let didStop = false;
      const stopping = Promise.resolve(
        runtime.stop?.({ signal, reason: "shutdown" }),
      )
        .then(() => {
          didStop = true;
        });
      await Promise.resolve();
      expect(didStop).toBe(false);
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(await runtime.health?.({ signal })).toMatchObject({
        details: { state: "draining" },
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(didStop).toBe(false);
      expect(child.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      await settledInFlight;
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(existsSync(promptPath as string)).toBe(false);
      expect(await runtime.health?.({ signal })).toMatchObject({
        details: { state: "stopped", activeTurns: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines cancellation when a sandboxed CLI child remains live", async () => {
    vi.useFakeTimers();
    const dataDirectory = realpathSync(mkdtempSync(
      join(tmpdir(), "runtime-claude-stubborn-sandbox-"),
    ));
    const child = new ControlledClaudeProcess();
    let promptPath: string | undefined;
    let didLaunch!: () => void;
    const launched = new Promise<void>((resolve) => {
      didLaunch = resolve;
    });
    const sandboxExecutor: SandboxExecutor = {
      async execute() {
        throw new Error("one-shot sandbox execution is not expected");
      },
      spawn(command) {
        promptPath = command.arguments[
          command.arguments.indexOf("--system-prompt-file") + 1
        ];
        didLaunch();
        return child as unknown as SandboxProcess;
      },
    };
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({
        mode: "cli",
        binary: process.execPath,
        timeoutMs: 5_000,
      }),
      instanceId: "claude-stubborn-sandbox-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory,
      sandboxExecutor,
      terminationGraceMs: 5,
    });
    const controller = new AbortController();
    const signal = new AbortController().signal;

    try {
      await runtime.start?.({ signal });
      const inFlight = runtime.runTurn({
        ...turnRequest(controller.signal),
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "private instructions" }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      }, runtimeContext);
      const turnRejected = expect(inFlight).rejects.toMatchObject({
        code: "PROCESS_TERMINATION_FAILED",
      });
      await launched;
      expect(promptPath).toBeDefined();
      expect(existsSync(promptPath as string)).toBe(true);

      controller.abort(new Error("operator cancelled"));
      const stopping = Promise.resolve(runtime.stop?.({
        signal,
        reason: "shutdown",
      }));
      const stopRejected = expect(stopping).rejects.toMatchObject({
        code: "PROCESS_TERMINATION_FAILED",
      });
      expect(child.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(5);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(5);
      await Promise.all([turnRejected, stopRejected]);

      expect(await runtime.health?.({ signal })).toMatchObject({
        status: "unhealthy",
        details: {
          state: "draining",
          activeTurns: 0,
          quarantineCode: "PROCESS_TERMINATION_FAILED",
        },
      });
      expect(existsSync(promptPath as string)).toBe(true);

      vi.useRealTimers();
      child.emit("close", null, "SIGKILL");
      await vi.waitFor(() => {
        expect(existsSync(promptPath as string)).toBe(false);
      });
    } finally {
      child.emit("close", null, "SIGKILL");
      rmSync(dataDirectory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out CLI turn owned until the SIGKILL barrier", async () => {
    vi.useFakeTimers();
    try {
      let child!: ControlledClaudeProcess;
      child = new ControlledClaudeProcess(undefined, (signal) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => child.emit("close", null, signal));
        }
      });
      let didLaunch!: () => void;
      const launched = new Promise<void>((resolve) => {
        didLaunch = resolve;
      });
      const runtime = createRuntimeClaude({
        config: parseRuntimeClaudeConfig({ mode: "cli", timeoutMs: 1_000 }),
        instanceId: "claude-runtime",
        workspaceDirectory: process.cwd(),
        spawnProcess() {
          didLaunch();
          return child;
        },
      });
      const signal = new AbortController().signal;
      await runtime.start?.({ signal });
      const inFlight = runtime.runTurn(turnRequest(), runtimeContext);
      const settledInFlight = expect(inFlight).resolves.toMatchObject({
        status: "cancelled",
      });
      await launched;

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(await runtime.health?.({ signal })).toMatchObject({
        details: { state: "running", activeTurns: 1 },
      });

      let didStop = false;
      const stopping = Promise.resolve(
        runtime.stop?.({ signal, reason: "shutdown" }),
      ).then(() => { didStop = true; });
      await Promise.resolve();
      expect(didStop).toBe(false);
      expect(await runtime.health?.({ signal })).toMatchObject({
        details: { state: "draining", activeTurns: 1 },
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(didStop).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([stopping, settledInFlight]);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(await runtime.health?.({ signal })).toMatchObject({
        details: { state: "stopped", activeTurns: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

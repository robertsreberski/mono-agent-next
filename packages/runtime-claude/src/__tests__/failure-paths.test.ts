import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";

import {
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  type RuntimeTurnContext,
  type RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import {
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
  prompt = "";

  constructor(stdin?: NodeJS.WritableStream) {
    super();
    this.stdin = stdin ?? new Writable({
      write: (chunk, _encoding, callback) => {
        this.prompt += String(chunk);
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
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
    const child = new ControlledClaudeProcess(new Writable({
      write(_chunk, _encoding, callback) {
        callback(brokenPipe);
      },
    }));
    const transport = createClaudeCliTransport(cliOptions(() => child));

    await expect(transport.run(transportRequest(), transportEvents))
      .rejects.toMatchObject({ code: "EPIPE", message: "write EPIPE" });
    expect(child.signals).toContain("SIGTERM");
  });

  it("cli transport escalates SIGTERM then SIGKILL on timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = new ControlledClaudeProcess();
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

      await launched;
      expect(promptPath).toBeDefined();
      expect(existsSync(promptPath as string)).toBe(true);
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(existsSync(promptPath as string)).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

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
    const child = new ControlledClaudeProcess();
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
      child.emit("close", null, "SIGTERM");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
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
      totalTokens: 14,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
    });
    expect(cliResult.usage).toEqual(sdkResult.usage);
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
    const rejectedInFlight = expect(inFlight).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
    await registeredControl;

    await runtime.stop?.({ signal, reason: "shutdown" });
    await rejectedInFlight;
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
});

// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";

import type {
  RuntimeLiveInputHandler,
  RuntimeSession,
  RuntimeTurnEvent,
} from "@mono-agent/module-sdk";
import { RUNTIME_SESSION_UNAVAILABLE_CODE } from "@mono-agent/module-sdk";
import type {
  SandboxExecutor,
  SandboxProcess,
  SandboxProcessInput,
  SandboxProcessOutput,
} from "@mono-agent/module-sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeCliTransport, type ProcessLike, type SpawnProcess } from "../cli.js";
import { parseRuntimeClaudeConfig, runtimeClaudeJsonSchema } from "../config.js";
import { claudeProcessEnvironment } from "../environment.js";
import { createRuntimeClaude, RuntimeClaudeError } from "../runtime.js";
import { claudeSdkSandboxSpawn } from "../sandbox.js";
import { createClaudeSdkTransport } from "../sdk.js";
import type { ClaudeTransport, ClaudeTransportControl } from "../transport.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  prompt = "";

  constructor(lines: readonly unknown[]) {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => { this.prompt += String(chunk); callback(); } });
    queueMicrotask(() => {
      this.stdout.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      this.stderr.end();
      this.emit("close", 0, null);
    });
  }

  kill(_signal?: NodeJS.Signals): boolean { return true; }
}

class FakeClaudeFailureProcess extends EventEmitter implements ProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  constructor(message: string) {
    super();
    queueMicrotask(() => {
      this.stderr.emit("data", new TextEncoder().encode(message));
      this.stdout.end();
      this.stderr.end();
      this.emit("close", 1, null);
    });
  }

  kill(_signal?: NodeJS.Signals): boolean { return true; }
}

class MinimalSandboxInput implements SandboxProcessInput {
  value = "";
  ended = false;
  readonly #errorListeners: Array<(error: Error) => void> = [];

  write(
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean;
  write(
    chunk: string,
    encoding: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    this.value += typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk).toString("utf8");
    const done = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
    queueMicrotask(() => done?.());
    return true;
  }

  end(callback?: () => void): this;
  end(chunk: string | Uint8Array, callback?: () => void): this;
  end(chunk: string, encoding: BufferEncoding, callback?: () => void): this;
  end(
    chunkOrCallback?: string | Uint8Array | (() => void),
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    if (typeof chunkOrCallback === "string") this.value += chunkOrCallback;
    else if (chunkOrCallback instanceof Uint8Array) {
      this.value += Buffer.from(chunkOrCallback).toString("utf8");
    }
    this.ended = true;
    const done = typeof chunkOrCallback === "function"
      ? chunkOrCallback
      : typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    queueMicrotask(() => done?.());
    return this;
  }

  on(event: "drain", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "drain" | "error",
    listener: (() => void) | ((error: Error) => void),
  ): this {
    if (event === "error") {
      this.#errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }
}

class MinimalSandboxOutput implements SandboxProcessOutput {
  readonly #dataListeners: Array<(chunk: Uint8Array) => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];

  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "data" | "error",
    listener: ((chunk: Uint8Array) => void) | ((error: Error) => void),
  ): this {
    if (event === "data") {
      this.#dataListeners.push(listener as (chunk: Uint8Array) => void);
    } else {
      this.#errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }

  emitData(chunk: Uint8Array): void {
    for (const listener of this.#dataListeners) listener(chunk);
  }
}

class MinimalSdkSandboxProcess implements SandboxProcess {
  readonly pid = 4_321;
  readonly stdin = new MinimalSandboxInput();
  readonly stdout = new MinimalSandboxOutput();
  readonly stderr = new MinimalSandboxOutput();
  readonly signals: NodeJS.Signals[] = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
  readonly #closeListeners: Array<(
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void> = [];

  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): this;
  once(
    event: "error" | "close",
    listener: ((error: Error) => void) | ((
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void),
  ): this {
    if (event === "error") {
      this.#errorListeners.push(listener as (error: Error) => void);
    } else {
      this.#closeListeners.push(listener as (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => void);
    }
    return this;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.#closeListeners.splice(0)) {
      listener(code, signal);
    }
  }
}

function transportRequest() {
  return {
    model: "claude-opus-4-8",
    prompt: "hello",
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  };
}

const CLAUDE_CLI_CONTAINMENT_ARGS = Object.freeze([
  "--print",
  "--input-format", "text",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-mode", "dontAsk",
  "--setting-sources", "",
  "--tools", "",
  "--model", "claude-opus-4-8",
]);

describe("runtime-claude transports", () => {
  it("imports its module definition without loading the SDK or network", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const definition = await import("../index.js");
    expect(definition.monoAgentModule.manifest.packageName).toBe("@mono-agent/runtime-claude");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("normalizes the SDK stream behind an injected query factory", async () => {
    async function* messages(): AsyncGenerator<unknown> {
      yield { type: "stream_event", session_id: "sdk-session", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } };
      yield { type: "stream_event", session_id: "sdk-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } };
      yield { type: "result", subtype: "success", session_id: "sdk-session", result: "hello", usage: { input_tokens: 2, output_tokens: 1 } };
    }
    const iterator = messages() as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void };
    iterator.interrupt = async () => undefined;
    iterator.close = () => undefined;
    const replacementSpawn = claudeSdkSandboxSpawn({
      async execute() {
        throw new Error("not reached");
      },
      spawn() {
        throw new Error("not reached");
      },
    });
    let observedSpawn: unknown;
    const query = vi.fn(async (input: {
      readonly prompt: AsyncIterable<unknown>;
      readonly options: Record<string, unknown>;
    }) => {
      observedSpawn = input.options.spawnClaudeCodeProcess;
      return iterator;
    });
    const transport = createClaudeSdkTransport({
      query,
      spawnClaudeCodeProcess: replacementSpawn,
    });
    const text: string[] = [];
    const thinking: string[] = [];
    let control: ClaudeTransportControl | undefined;
    const result = await transport.run(transportRequest(), {
      text(delta) { text.push(delta); },
      thinking(delta) { thinking.push(delta); },
      session() {},
      usage() {},
      control(value) { control = value; },
    });
    expect(result).toMatchObject({ text: "hello", sessionId: "sdk-session", usage: { inputTokens: 2, outputTokens: 1 } });
    expect(text).toEqual(["hello"]);
    expect(thinking).toEqual(["hmm"]);
    expect(control?.sendInput).toBeTypeOf("function");
    expect(query).toHaveBeenCalledOnce();
    expect(observedSpawn).toBe(replacementSpawn);
  });

  it("adapts a minimal sandbox facade to the SDK's Node stream seam", async () => {
    const child = new MinimalSdkSandboxProcess();
    const sandboxSpawn = vi.fn<SandboxExecutor["spawn"]>(
      () => child,
    );
    const executor: SandboxExecutor = {
      async execute() {
        throw new Error("one-shot execution is not expected");
      },
      spawn: sandboxSpawn,
    };
    const replacementSpawn = claudeSdkSandboxSpawn(executor);
    const controller = new AbortController();
    const spawned = replacementSpawn({
      command: process.execPath,
      args: ["claude-native-entry"],
      cwd: process.cwd(),
      env: {
        ANTHROPIC_API_KEY: "selected-sandbox-token",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        CLAUDE_AGENT_SDK_VERSION: "0.3.206",
      },
      signal: controller.signal,
    });

    expect(sandboxSpawn).toHaveBeenCalledWith({
      command: process.execPath,
      arguments: ["claude-native-entry"],
      workingDirectory: process.cwd(),
      environment: {
        ANTHROPIC_API_KEY: "selected-sandbox-token",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        CLAUDE_AGENT_SDK_VERSION: "0.3.206",
      },
    });
    expect(spawned.killed).toBe(false);
    await new Promise<void>((resolve, reject) => {
      spawned.stdin.write("minimal request\n", (error) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
    await new Promise<void>((resolve) => spawned.stdin.end(resolve));
    expect(child.stdin.value).toBe("minimal request\n");
    expect(child.stdin.ended).toBe(true);
    expect(spawned.stdin.writableEnded).toBe(true);

    const lines: string[] = [];
    const lineReader = createInterface({ input: spawned.stdout });
    const reading = (async () => {
      for await (const line of lineReader) lines.push(line);
    })();
    child.stdout.emitData(
      new TextEncoder().encode('{"type":"minimal-facade"}\n'),
    );
    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(spawned.killed).toBe(true);

    const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
      spawned.once("exit", (code, signal) => resolve([code, signal]));
    });
    child.close(0, null);
    await expect(exited).resolves.toEqual([0, null]);
    await reading;
    expect(lines).toEqual(['{"type":"minimal-facade"}']);
    expect(spawned.exitCode).toBe(0);
    expect(() => replacementSpawn({
      command: "node",
      args: [],
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
    })).toThrow("SDK sandbox command must be an absolute path");
  });

  it("runs the CLI with exact containment argv, direct stdin, and bounded fake JSONL", async () => {
    let child: FakeClaudeProcess | undefined;
    let systemPromptPath: string | undefined;
    const responseSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const launch = vi.fn<SpawnProcess>((_command, args, options) => {
      expect(options.shell).toBe(false);
      expect(args).not.toContain("private system instructions");
      const promptFileIndex = args.indexOf("--system-prompt-file");
      expect(promptFileIndex).toBeGreaterThan(-1);
      systemPromptPath = args[promptFileIndex + 1];
      expect(readFileSync(systemPromptPath as string, "utf8")).toBe("private system instructions");
      expect(args).toEqual([
        ...CLAUDE_CLI_CONTAINMENT_ARGS,
        "--system-prompt-file", systemPromptPath,
        "--resume", "cli-resume",
        "--max-turns", "3",
        "--effort", "high",
        "--json-schema", JSON.stringify(responseSchema),
      ]);
      child = new FakeClaudeProcess([
        { type: "stream_event", session_id: "cli-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } },
        { type: "result", subtype: "success", session_id: "cli-session", result: "hello", usage: { input_tokens: 2, output_tokens: 1 } },
      ]);
      return child;
    });
    const transport = createClaudeCliTransport({
      binary: "claude",
      timeoutMs: 1_000,
      maxLineBytes: 16_384,
      maxStderrBytes: 4_096,
      spawnProcess: launch,
    });
    const result = await transport.run({
      ...transportRequest(),
      systemPrompt: "private system instructions",
      sessionId: "cli-resume",
      maxTurns: 3,
      effort: "high",
      responseSchema,
    }, {
      text() {}, thinking() {}, session() {}, usage() {}, control() {},
    });
    expect(result).toMatchObject({ text: "hello", sessionId: "cli-session" });
    expect(child?.prompt).toBe("hello");
    expect(systemPromptPath).toBeDefined();
    expect(existsSync(systemPromptPath as string)).toBe(false);
    expect(launch).toHaveBeenCalledWith("claude", expect.any(Array), expect.objectContaining({ shell: false }));
  });

  it("omits every optional CLI argv pair when request fields are absent", async () => {
    const launch = vi.fn<SpawnProcess>((_command, args) => {
      expect(args).toEqual(CLAUDE_CLI_CONTAINMENT_ARGS);
      return new FakeClaudeProcess([
        { type: "result", subtype: "success", session_id: "cli-session", result: "hello" },
      ]);
    });
    const transport = createClaudeCliTransport({
      binary: "claude",
      timeoutMs: 1_000,
      maxLineBytes: 16_384,
      maxStderrBytes: 4_096,
      spawnProcess: launch,
    });
    await expect(transport.run(transportRequest(), {
      text() {}, thinking() {}, session() {}, usage() {}, control() {},
    })).resolves.toMatchObject({ text: "hello", sessionId: "cli-session" });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("decodes plain Uint8Array CLI stderr without numeric byte coercion", async () => {
    const transport = createClaudeCliTransport({
      binary: "claude",
      timeoutMs: 1_000,
      maxLineBytes: 16_384,
      maxStderrBytes: 4_096,
      spawnProcess: () => new FakeClaudeFailureProcess("provider boom"),
    });

    await expect(transport.run(transportRequest(), {
      text() {}, thinking() {}, session() {}, usage() {}, control() {},
    })).rejects.toThrow("provider boom");
  });

  it("routes the CLI child through the selected Core sandbox without host-spawn fallback", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "selected-sandbox-token");
    const dataDirectory = temporaryRoot("mono-agent-claude-sandbox-data-");
    let child: FakeClaudeProcess | undefined;
    let systemPromptPath: string | undefined;
    const sandboxSpawn = vi.fn<SandboxExecutor["spawn"]>(
      (command) => {
        const index = command.arguments.indexOf("--system-prompt-file");
        systemPromptPath = command.arguments[index + 1];
        expect(index).toBeGreaterThan(-1);
        expect(systemPromptPath?.startsWith(`${dataDirectory}/`)).toBe(true);
        expect(readFileSync(systemPromptPath as string, "utf8")).toBe(
          "private system instructions",
        );
        expect(statSync(systemPromptPath as string).mode & 0o777).toBe(0o600);
        child = new FakeClaudeProcess([
          {
            type: "stream_event",
            session_id: "sandbox-session",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "sandboxed" },
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sandbox-session",
            result: "sandboxed",
          },
        ]);
        return child as unknown as ReturnType<SandboxExecutor["spawn"]>;
      },
    );
    const sandboxExecutor: SandboxExecutor = {
      async execute() {
        throw new Error("one-shot sandbox execution is not expected");
      },
      spawn: sandboxSpawn,
    };
    const hostSpawn = vi.fn<SpawnProcess>(() => {
      throw new Error("host spawn must not run");
    });
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({
        mode: "cli",
        binary: process.execPath,
        auth: { method: "api-key", token: "selected-sandbox-token" },
        timeoutMs: 1_000,
      }),
      instanceId: "claude-sandbox-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory,
      spawnProcess: hostSpawn,
      sandboxExecutor,
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await expect(runtime.runTurn({
      turnId: "sandbox-turn",
      conversationId: "sandbox-conversation",
      model: "claude-opus-4-8",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "private system instructions" }],
        },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) {
        return { callId: call.id, content: [] };
      },
    })).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "sandboxed" }] },
    });

    expect(runtime.capabilities.sandbox).toBe(true);
    expect(hostSpawn).not.toHaveBeenCalled();
    expect(child?.prompt).toBe("USER:\nhello");
    expect(sandboxSpawn).toHaveBeenCalledWith(expect.objectContaining({
      command: process.execPath,
      workingDirectory: process.cwd(),
      arguments: expect.arrayContaining(["--output-format", "stream-json"]),
    }));
    expect(sandboxSpawn.mock.calls[0]?.[0].environment).toEqual({
      ANTHROPIC_API_KEY: "selected-sandbox-token",
    });
    expect(systemPromptPath).toBeDefined();
    expect(existsSync(systemPromptPath as string)).toBe(false);
    expect(readdirSync(dataDirectory)).toEqual([]);
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("rejects unsafe selected-sandbox data roots before any process spawn", async () => {
    const unsafe = temporaryRoot("mono-agent-claude-unsafe-data-");
    chmodSync(unsafe, 0o755);
    const parent = temporaryRoot("mono-agent-claude-linked-data-");
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    mkdtempSync(`${target}-`);
    const actualTarget = readdirSync(parent)
      .map((name) => join(parent, name))
      .find((path) => path.startsWith(target));
    if (actualTarget === undefined) throw new Error("linked target is absent");
    symlinkSync(actualTarget, linked);
    const sandboxSpawn = vi.fn<SandboxExecutor["spawn"]>(() => {
      throw new Error("sandbox spawn must not run");
    });
    const hostSpawn = vi.fn<SpawnProcess>(() => {
      throw new Error("host spawn must not run");
    });
    const executor: SandboxExecutor = {
      async execute() {
        throw new Error("sandbox execute must not run");
      },
      spawn: sandboxSpawn,
    };
    const create = (dataDirectory: string) => createRuntimeClaude({
      config: parseRuntimeClaudeConfig({
        mode: "cli",
        binary: process.execPath,
      }),
      instanceId: "claude-unsafe-data-root",
      workspaceDirectory: process.cwd(),
      dataDirectory,
      spawnProcess: hostSpawn,
      sandboxExecutor: executor,
    });

    await expect(create(unsafe).start?.({
      signal: new AbortController().signal,
    })).rejects.toThrow(/mode 0700/u);
    await expect(create(linked).start?.({
      signal: new AbortController().signal,
    })).rejects.toThrow(/canonical directory/u);
    expect(sandboxSpawn).not.toHaveBeenCalled();
    expect(hostSpawn).not.toHaveBeenCalled();
  });

  it("rejects a PATH-resolved CLI binary before a selected sandbox can run", () => {
    const executor: SandboxExecutor = {
      async execute() {
        throw new Error("not reached");
      },
      spawn() {
        throw new Error("not reached");
      },
    };
    expect(() => createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "cli" }),
      instanceId: "claude-sandbox-relative-binary",
      workspaceDirectory: process.cwd(),
      sandboxExecutor: executor,
    })).toThrow("config.binary must be an absolute path when a Core sandbox is selected");
  });

  it("rejects a custom SDK transport that could bypass a selected sandbox", () => {
    const executor: SandboxExecutor = {
      async execute() {
        throw new Error("not reached");
      },
      spawn() {
        throw new Error("not reached");
      },
    };
    const sdkTransport: ClaudeTransport = {
      async run() {
        throw new Error("not reached");
      },
    };
    expect(() => createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-custom-sdk-sandbox",
      workspaceDirectory: process.cwd(),
      sandboxExecutor: executor,
      sdkTransport,
    })).toThrow("cannot use a custom SDK transport with a selected sandbox");
  });

  it("passes only operational and explicitly configured environment values", () => {
    const environment = claudeProcessEnvironment({ ANTHROPIC_API_KEY: "configured" }, {
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      CLAUDE_CONFIG_DIR: "/private/claude",
      AMBIENT_SECRET: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      CLAUDE_CONFIG_DIR: "/private/claude",
      ANTHROPIC_API_KEY: "configured",
    });
  });

  it("removes the private system-prompt file when process launch fails", async () => {
    const dataDirectory = temporaryRoot("mono-agent-claude-prompt-failure-");
    let systemPromptPath: string | undefined;
    const transport = createClaudeCliTransport({
      binary: "claude",
      timeoutMs: 1_000,
      maxLineBytes: 16_384,
      maxStderrBytes: 4_096,
      dataDirectory,
      spawnProcess(_command, args) {
        systemPromptPath = args[args.indexOf("--system-prompt-file") + 1];
        throw new Error("launch failed");
      },
    });
    await expect(transport.run({ ...transportRequest(), systemPrompt: "private system instructions" }, {
      text() {}, thinking() {}, session() {}, usage() {}, control() {},
    })).rejects.toThrow("launch failed");
    expect(systemPromptPath).toBeDefined();
    expect(systemPromptPath?.startsWith(`${dataDirectory}/`)).toBe(true);
    expect(existsSync(systemPromptPath as string)).toBe(false);
    expect(readdirSync(dataDirectory)).toEqual([]);
  });

  it("binds SDK live input to the exact active runtime attempt", async () => {
    const sendInput = vi.fn(async () => true);
    const fake: ClaudeTransport = {
      async run(_request, events) {
        events.control({ interrupt: async () => undefined, sendInput });
        await events.session("native-session");
        return { text: "done", sessionId: "native-session" };
      },
    };
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: fake,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    let handler: RuntimeLiveInputHandler | undefined;
    let unregistered = false;
    const events: RuntimeTurnEvent[] = [];
    const result = await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit(event) { events.push(event); },
      async executeTool(call) { return { callId: call.id, content: [] }; },
      registerLiveInput(value) {
        handler = value;
        void value(
          { id: "input", text: "steer", receivedAt: "2026-01-01T00:00:00.000Z" },
          new AbortController().signal,
        );
        return () => { unregistered = true; };
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      session: {
        id: "native-session",
        conversationId: "conversation",
        route: {
          runtimeInstanceId: "claude-runtime",
          model: "claude-opus-4-8",
        },
      },
    });
    expect(handler).toBeDefined();
    expect(sendInput).toHaveBeenCalledWith("steer", "2026-01-01T00:00:00.000Z");
    expect(unregistered).toBe(true);
  });

  it("rejects wrong session linkage before transport and resumes only the exact route", async () => {
    const run = vi.fn<ClaudeTransport["run"]>(async (transportTurn) => ({
      text: transportTurn.sessionId === undefined ? "first" : "continued",
      sessionId: transportTurn.sessionId ?? "native-session",
    }));
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: { run },
    });
    await runtime.start?.({ signal: new AbortController().signal });
    const runtimeContext = {
      emit() {},
      async executeTool(call: { readonly id: string }) {
        return { callId: call.id, content: [] };
      },
    };
    const exactSession: RuntimeSession = {
      id: "native-session",
      conversationId: "conversation",
      route: {
        runtimeInstanceId: "claude-runtime",
        model: "claude-opus-4-8",
      },
    };
    const invalidSessions: RuntimeSession[] = [
      {
        ...exactSession,
        route: { ...exactSession.route, runtimeInstanceId: "other-runtime" },
      },
      {
        ...exactSession,
        route: { ...exactSession.route, model: "claude-sonnet-4-7" },
      },
      {
        ...exactSession,
        conversationId: "other-conversation",
      },
    ];
    for (const session of invalidSessions) {
      await expect(runtime.runTurn({
        turnId: "invalid",
        conversationId: "conversation",
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: [{ type: "text", text: "no call" }] }],
        tools: [],
        signal: new AbortController().signal,
        session,
      }, runtimeContext)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    }
    expect(run).not.toHaveBeenCalled();

    const first = await runtime.runTurn({
      turnId: "first",
      conversationId: "conversation",
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, runtimeContext);
    const second = await runtime.runTurn({
      turnId: "second",
      conversationId: "conversation",
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "user", content: [{ type: "text", text: "follow up" }] },
      ],
      tools: [],
      signal: new AbortController().signal,
      session: first.session!,
    }, runtimeContext);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "native-session",
      prompt: "follow up",
    });
    expect(second).toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "continued" }] },
      session: exactSession,
    });
  });

  it("maps only a genuinely missing native continuation to SESSION_UNAVAILABLE", async () => {
    const missingSession = "11111111-1111-4111-8111-111111111111";
    const transport = createClaudeSdkTransport({
      query(input) {
        const resumed = String(input.options.resume);
        throw new Error(
          resumed === missingSession
            ? `Session ${missingSession} not found in any project directory`
            : `Session ${missingSession} not found in any project directory`,
        );
      },
    });
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "sdk" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: transport,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    const runtimeContext = {
      emit() {},
      async executeTool(call: { readonly id: string }) {
        return { callId: call.id, content: [] };
      },
    };
    const run = (sessionId: string) => runtime.runTurn({
      turnId: `turn-${sessionId}`,
      conversationId: "conversation",
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "resume" }] }],
      tools: [],
      signal: new AbortController().signal,
      session: {
        id: sessionId,
        conversationId: "conversation",
        route: {
          runtimeInstanceId: "claude-runtime",
          model: "claude-opus-4-8",
        },
      },
    }, runtimeContext);

    await expect(run(missingSession)).rejects.toMatchObject({
      code: RUNTIME_SESSION_UNAVAILABLE_CODE,
      retryability: "not-retryable",
      sideEffects: "none",
    });
    await expect(
      run("22222222-2222-4222-8222-222222222222"),
    ).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
  });

  it("publishes only bounded accessor-free redacted provider causes", async () => {
    const secret = "sk-secret";
    let accessorReads = 0;
    const providerCause = new Error(
      `provider rejected ${secret} ${"x".repeat(8_192)}`,
    ) as Error & { code?: string };
    providerCause.name = `ClaudeProvider-${secret}`;
    Object.defineProperty(providerCause, "code", {
      configurable: true,
      enumerable: true,
      value: `AUTH_${secret}`,
      writable: true,
    });
    Object.defineProperty(providerCause, "cause", {
      configurable: true,
      get() {
        accessorReads += 1;
        return new Error(`nested ${secret}`);
      },
    });
    Object.defineProperty(providerCause, "danger", {
      configurable: true,
      get() {
        accessorReads += 1;
        return secret;
      },
    });
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({
        mode: "sdk",
        auth: { method: "api-key", token: secret },
      }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      sdkTransport: {
        async run() {
          throw providerCause;
        },
      },
    });
    await runtime.start?.({ signal: new AbortController().signal });

    let failure: unknown;
    try {
      await runtime.runTurn({
        turnId: "secret-failure",
        conversationId: "conversation",
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        signal: new AbortController().signal,
      }, {
        emit() {},
        async executeTool(call) {
          return { callId: call.id, content: [] };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeClaudeError);
    const typed = failure as RuntimeClaudeError;
    expect(typed.message).not.toContain(secret);
    expect(typed.message.length).toBeLessThanOrEqual(4_096);
    expect(typed.cause).toBeInstanceOf(Error);
    expect(typed.cause === providerCause).toBe(false);
    const cause = typed.cause as Error & { readonly code?: string };
    expect(cause.message).not.toContain(secret);
    expect(cause.message.length).toBeLessThanOrEqual(4_096);
    expect(cause.name).toBe("ClaudeProvider-[REDACTED]");
    expect(cause.code).toBe("AUTH_[REDACTED]");
    expect(Object.getOwnPropertyDescriptor(cause, "cause")).toBeUndefined();
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(cause));
    expect(descriptors.every((descriptor) => !("get" in descriptor))).toBe(true);
    expect(
      descriptors
        .filter((descriptor) => "value" in descriptor)
        .map((descriptor) => String(descriptor.value))
        .join("\n"),
    ).not.toContain(secret);
    expect(accessorReads).toBe(0);
  });

  it("preflights the created instance without retaining deprecated validation", async () => {
    const runtime = createRuntimeClaude({
      config: parseRuntimeClaudeConfig({ mode: "cli" }),
      instanceId: "claude-runtime",
      workspaceDirectory: process.cwd(),
      cliTransport: {
        async run() {
          throw new Error("preflight must not execute a turn");
        },
      },
    });

    expect(runtime.validateModel).toBeUndefined();
    expect(await runtime.preflightModel?.({
      model: "claude-opus-4-8",
      signal: new AbortController().signal,
    })).toMatchObject({
      supported: true,
      capabilities: { liveInput: false },
      nativeTools: [],
    });
    expect(await runtime.preflightModel?.({
      model: "not-a-claude-model",
      signal: new AbortController().signal,
    })).toMatchObject({
      supported: false,
      diagnostics: [{ code: "runtime-claude.model", severity: "error" }],
    });
  });

  it("keeps auth token fields environment-only and parses strictly", () => {
    const alternatives = runtimeClaudeJsonSchema.properties.auth.oneOf;
    for (const alternative of alternatives) {
      const token = alternative.properties.token as Record<string, unknown>;
      expect(token["x-mono-agent-env-eligible"]).toBe(true);
      expect(token["x-mono-agent-secret"]).toBe(true);
    }
    expect(() => parseRuntimeClaudeConfig({ unexpected: true })).toThrow("is not supported");
    expect(() => parseRuntimeClaudeConfig({
      auth: { method: "api-key" },
    })).toThrow("runtime-claude config.auth.token is required");
    expect(() => parseRuntimeClaudeConfig({
      auth: { method: "oauth-token", token: "" },
    })).toThrow("runtime-claude config.auth.token must be a non-empty trimmed string");
  });
});

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  expect(lstatSync(root).isSymbolicLink()).toBe(false);
  return root;
}

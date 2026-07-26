// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";

import type {
  RuntimeLiveInputHandler,
  RuntimeSession,
  RuntimeTurnEvent,
} from "@mono-agent/module-sdk";
import { RUNTIME_SESSION_UNAVAILABLE_CODE } from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import { createClaudeCliTransport, type ProcessLike, type SpawnProcess } from "../cli.js";
import { parseRuntimeClaudeConfig, runtimeClaudeJsonSchema } from "../config.js";
import { claudeProcessEnvironment } from "../environment.js";
import { createRuntimeClaude, RuntimeClaudeError } from "../runtime.js";
import { createClaudeSdkTransport } from "../sdk.js";
import type { ClaudeTransport, ClaudeTransportControl } from "../transport.js";

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
    const query = vi.fn(async () => iterator);
    const transport = createClaudeSdkTransport({ query });
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
    let systemPromptPath: string | undefined;
    const transport = createClaudeCliTransport({
      binary: "claude",
      timeoutMs: 1_000,
      maxLineBytes: 16_384,
      maxStderrBytes: 4_096,
      spawnProcess(_command, args) {
        systemPromptPath = args[args.indexOf("--system-prompt-file") + 1];
        throw new Error("launch failed");
      },
    });
    await expect(transport.run({ ...transportRequest(), systemPrompt: "private system instructions" }, {
      text() {}, thinking() {}, session() {}, usage() {}, control() {},
    })).rejects.toThrow("launch failed");
    expect(systemPromptPath).toBeDefined();
    expect(existsSync(systemPromptPath as string)).toBe(false);
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

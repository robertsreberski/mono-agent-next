import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";

import type { RuntimeLiveInputHandler, RuntimeTurnEvent } from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import { createClaudeCliTransport, type ProcessLike, type SpawnProcess } from "../cli.js";
import { parseRuntimeClaudeConfig, runtimeClaudeJsonSchema } from "../config.js";
import { claudeProcessEnvironment } from "../environment.js";
import { createRuntimeClaude } from "../runtime.js";
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

  it("runs the CLI via direct argv/stdin and bounded fake JSONL", async () => {
    let child: FakeClaudeProcess | undefined;
    let systemPromptPath: string | undefined;
    const launch = vi.fn<SpawnProcess>((_command, args, options) => {
      expect(options.shell).toBe(false);
      expect(args).toContain("--output-format");
      expect(args).not.toContain("private system instructions");
      const promptFileIndex = args.indexOf("--system-prompt-file");
      expect(promptFileIndex).toBeGreaterThan(-1);
      systemPromptPath = args[promptFileIndex + 1];
      expect(readFileSync(systemPromptPath as string, "utf8")).toBe("private system instructions");
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
    const result = await transport.run({ ...transportRequest(), systemPrompt: "private system instructions" }, {
      text() {}, thinking() {}, session() {}, usage() {}, control() {},
    });
    expect(result).toMatchObject({ text: "hello", sessionId: "cli-session" });
    expect(child?.prompt).toBe("hello");
    expect(systemPromptPath).toBeDefined();
    expect(existsSync(systemPromptPath as string)).toBe(false);
    expect(launch).toHaveBeenCalledWith("claude", expect.any(Array), expect.objectContaining({ shell: false }));
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
    expect(result).toMatchObject({ status: "completed", session: { id: "native-session", runtimeInstanceId: "claude-runtime" } });
    expect(handler).toBeDefined();
    expect(sendInput).toHaveBeenCalledWith("steer", "2026-01-01T00:00:00.000Z");
    expect(unregistered).toBe(true);
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
  });
});

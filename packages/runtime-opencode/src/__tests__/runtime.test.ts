import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import type { RuntimeTurnEvent } from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import { parseRuntimeOpenCodeConfig, runtimeOpenCodeJsonSchema } from "../config.js";
import { openCodeProcessEnvironment } from "../environment.js";
import type { ProcessLike, SpawnProcess } from "../process.js";
import { createRuntimeOpenCode, RuntimeOpenCodeError } from "../runtime.js";

class FakeProcess extends EventEmitter implements ProcessLike {
  readonly pid = 4321;
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  input = "";

  constructor() {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => { this.input += String(chunk); callback(); } });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.signals.push(signal); return true; }

  complete(stdout: string, code = 0, stderr = ""): void {
    queueMicrotask(() => {
      if (stdout !== "") this.stdout.write(stdout);
      if (stderr !== "") this.stderr.write(stderr);
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, null);
    });
  }
}

describe("runtime-opencode", () => {
  it("imports its module definition without network work", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const definition = await import("../index.js");
    expect(definition.monoAgentModule.manifest.packageName).toBe("@mono-agent/runtime-opencode");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("checks the stable CLI and streams bounded JSONL without a shell", async () => {
    const invocations: { command: string; args: readonly string[]; shell: boolean; child: FakeProcess }[] = [];
    const launch = vi.fn<SpawnProcess>((command, args, processOptions) => {
      const child = new FakeProcess();
      invocations.push({ command, args, shell: processOptions.shell, child });
      if (args[0] === "--version") child.complete("1.15.13\n");
      else child.complete([
        JSON.stringify({ type: "text", sessionID: "session-1", part: { text: "hello" } }),
        JSON.stringify({ type: "step_finish", sessionID: "session-1", part: { tokens: { input: 3, output: 2 } } }),
        "",
      ].join("\n"));
      return child;
    });
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({ minimumVersion: "1.15.0" }),
      instanceId: "opencode-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    const events: RuntimeTurnEvent[] = [];
    const result = await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello; $(unsafe)" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit(event) { events.push(event); },
      async executeTool(call) { return { callId: call.id, content: [] }; },
    });

    expect(result).toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "hello" }] },
      usage: { inputTokens: 3, outputTokens: 2 },
      session: { id: "session-1", provider: "opencode", runtimeInstanceId: "opencode-runtime" },
    });
    expect(events).toContainEqual({ type: "text-delta", delta: "hello" });
    expect(invocations.every((entry) => entry.shell === false)).toBe(true);
    expect(invocations[1]?.args.join(" ")).not.toContain("hello; $(unsafe)");
    expect(invocations[1]?.child.input).toContain("hello; $(unsafe)");
  });

  it("passes only operational and explicitly configured environment values", () => {
    const environment = openCodeProcessEnvironment({ OPENAI_API_KEY: "configured" }, {
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      XDG_DATA_HOME: "/private/data",
      AMBIENT_SECRET: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      XDG_DATA_HOME: "/private/data",
      OPENAI_API_KEY: "configured",
    });
  });

  it("force-kills and awaits active children before stop completes", async () => {
    let turnChild: FakeProcess | undefined;
    const launch: SpawnProcess = (_command, args) => {
      const child = new FakeProcess();
      if (args[0] === "--version") child.complete("1.15.13\n");
      else turnChild = child;
      return child;
    };
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({ minimumVersion: "1.15.0" }),
      instanceId: "opencode-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    vi.useFakeTimers();
    try {
      const turn = runtime.runTurn({
        turnId: "turn",
        conversationId: "conversation",
        model: "anthropic/claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "private transcript" }] }],
        tools: [],
        signal: new AbortController().signal,
      }, {
        emit() {},
        async executeTool(call) { return { callId: call.id, content: [] }; },
      });
      expect(turnChild?.input).toContain("private transcript");
      let stopped = false;
      const stopping = Promise.resolve(runtime.stop?.({ signal: new AbortController().signal, reason: "shutdown" }))
        .then(() => { stopped = true; });
      expect(turnChild?.signals).toEqual(["SIGTERM"]);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(turnChild?.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(stopped).toBe(false);
      turnChild?.emit("close", null, "SIGKILL");
      await stopping;
      expect(await turn).toMatchObject({ status: "cancelled" });
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the runtime draining when a child never confirms SIGKILL exit", async () => {
    let turnChild: FakeProcess | undefined;
    const launch: SpawnProcess = (_command, args) => {
      const child = new FakeProcess();
      if (args[0] === "--version") child.complete("1.15.13\n");
      else turnChild = child;
      return child;
    };
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({ minimumVersion: "1.15.0" }),
      instanceId: "opencode-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    vi.useFakeTimers();
    try {
      const turn = runtime.runTurn({
        turnId: "turn",
        conversationId: "conversation",
        model: "anthropic/claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "private transcript" }] }],
        tools: [],
        signal: new AbortController().signal,
      }, {
        emit() {},
        async executeTool(call) { return { callId: call.id, content: [] }; },
      });
      const turnFailure = expect(turn).rejects.toMatchObject({ code: "PROCESS_TERMINATION_FAILED" });
      const stopping = Promise.resolve(runtime.stop?.({ signal: new AbortController().signal, reason: "shutdown" }));
      const stopFailure = expect(stopping).rejects.toMatchObject({ code: "PROCESS_TERMINATION_FAILED" });
      await vi.advanceTimersByTimeAsync(2_000);
      await turnFailure;
      await stopFailure;
      expect(turnChild?.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(runtime.health?.({ signal: new AbortController().signal })).toMatchObject({
        status: "degraded",
        details: { state: "draining" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a concurrent start once stop has begun draining startup", async () => {
    let versionChild: FakeProcess | undefined;
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({ minimumVersion: "1.15.0" }),
      instanceId: "opencode-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess() {
        versionChild = new FakeProcess();
        return versionChild;
      },
    });
    const starting = Promise.resolve(runtime.start?.({ signal: new AbortController().signal }));
    const startFailure = expect(starting).rejects.toMatchObject({ code: "VERSION_CHECK_FAILED" });
    const stopping = Promise.resolve(runtime.stop?.({ signal: new AbortController().signal, reason: "shutdown" }));
    await expect(Promise.resolve(runtime.start?.({ signal: new AbortController().signal }))).rejects.toMatchObject({
      code: "RUNTIME_NOT_RUNNING",
    });
    expect(versionChild?.signals).toEqual(["SIGTERM"]);
    versionChild?.emit("close", null, "SIGTERM");
    await startFailure;
    await stopping;
    expect(runtime.health?.({ signal: new AbortController().signal })).toMatchObject({
      details: { state: "stopped" },
    });
  });

  it("rejects prerelease/old installations and keeps configured environment values secret", async () => {
    const launch: SpawnProcess = (_command, _args, options) => {
      expect(options.shell).toBe(false);
      const child = new FakeProcess();
      child.complete("1.14.9\n");
      return child;
    };
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({ environment: { OPENAI_API_KEY: "secret" } }),
      instanceId: "test",
      workspaceDirectory: process.cwd(),
      spawnProcess: launch,
    });
    await expect(runtime.start?.({ signal: new AbortController().signal })).rejects.toBeInstanceOf(RuntimeOpenCodeError);
    const environment = runtimeOpenCodeJsonSchema.properties.environment.additionalProperties as Record<string, unknown>;
    expect(environment["x-mono-agent-env-eligible"]).toBe(true);
    expect(environment["x-mono-agent-secret"]).toBe(true);
    expect(() => parseRuntimeOpenCodeConfig({ extra: true })).toThrow("is not supported");
  });
});

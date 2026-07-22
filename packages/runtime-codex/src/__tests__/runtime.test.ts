import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import type { RuntimeTurnEvent } from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import { parseRuntimeCodexConfig, runtimeCodexJsonSchema } from "../config.js";
import { codexProcessEnvironment } from "../environment.js";
import type { ProcessLike, SpawnProcess } from "../json-rpc.js";
import { createRuntimeCodex, RuntimeCodexError } from "../runtime.js";

class FakeCodexProcess extends EventEmitter implements ProcessLike {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly requests: Record<string, unknown>[] = [];

  constructor() {
    super();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += String(chunk);
        while (input.includes("\n")) {
          const index = input.indexOf("\n");
          const line = input.slice(0, index);
          input = input.slice(index + 1);
          const request = JSON.parse(line) as Record<string, unknown>;
          this.requests.push(request);
          const id = request.id as number | undefined;
          if (id !== undefined) {
            const method = request.method;
            if (method === "initialize") this.send({ id, result: { userAgent: "fake" } });
            else if (method === "thread/start") this.send({ id, result: { thread: { id: "thread-1" } } });
            else if (method === "turn/start") {
              this.send({ id, result: { turn: { id: "turn-1" } } });
              queueMicrotask(() => {
                this.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" } });
                this.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
              });
            }
          }
        }
        callback();
      },
    });
  }

  send(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill(_signal?: NodeJS.Signals): boolean { queueMicrotask(() => this.emit("close", 0, null)); return true; }
}

describe("runtime-codex", () => {
  it("imports its module definition without network work", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const definition = await import("../index.js");
    expect(definition.monoAgentModule.manifest.packageName).toBe("@mono-agent/runtime-codex");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("uses a bounded direct app-server protocol and returns native session linkage", async () => {
    const child = new FakeCodexProcess();
    const launch = vi.fn<SpawnProcess>((_command, _args, options) => {
      expect(options.shell).toBe(false);
      return child;
    });
    const runtime = createRuntimeCodex({
      config: parseRuntimeCodexConfig({ requestTimeoutMs: 1_000 }),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    const events: RuntimeTurnEvent[] = [];
    const result = await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit(event) { events.push(event); },
      async executeTool(call) { return { callId: call.id, content: [] }; },
    });

    expect(result).toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "hello" }] },
      session: { id: "thread-1", runtimeInstanceId: "codex-runtime", provider: "codex" },
    });
    expect(events).toContainEqual({ type: "text-delta", delta: "hello" });
    expect(child.requests.map((request) => request.method)).toEqual(expect.arrayContaining(["initialize", "thread/start", "turn/start"]));
    expect(launch).toHaveBeenCalledWith("codex", expect.arrayContaining(["app-server", "--listen", "stdio://"]), expect.objectContaining({ shell: false }));
  });

  it("publishes an env-only secret schema and typed fail-closed errors", () => {
    const auth = (runtimeCodexJsonSchema.properties.auth.properties.apiKey) as Record<string, unknown>;
    expect(auth["x-mono-agent-env-eligible"]).toBe(true);
    expect(auth["x-mono-agent-secret"]).toBe(true);
    expect(() => parseRuntimeCodexConfig({ unknown: true })).toThrow("is not supported");
    expect(new RuntimeCodexError("TEST", "failed", { retryability: "not-retryable" })).toMatchObject({
      code: "TEST",
      retryability: "not-retryable",
      sideEffects: "none",
    });
  });

  it("passes only operational and explicitly configured environment values", () => {
    const environment = codexProcessEnvironment({ OPENAI_API_KEY: "configured" }, {
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      CODEX_HOME: "/private/codex",
      AMBIENT_SECRET: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      CODEX_HOME: "/private/codex",
      OPENAI_API_KEY: "configured",
    });
  });
});

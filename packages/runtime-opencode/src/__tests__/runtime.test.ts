import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import type {
  RuntimeSession,
  RuntimeTurnEvent,
  RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import { RUNTIME_SESSION_UNAVAILABLE_CODE } from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  OPEN_CODE_SECURE_SERVER_VERSION,
  parseRuntimeOpenCodeConfig,
  runtimeOpenCodeJsonSchema,
} from "../config.js";
import {
  OPEN_CODE_TOOL_FREE_AGENT,
  openCodeProcessEnvironment,
} from "../environment.js";
import type { ProcessLike, SpawnProcess } from "../process.js";
import { createRuntimeOpenCode, RuntimeOpenCodeError } from "../runtime.js";

class FakeProcess extends EventEmitter implements ProcessLike {
  readonly pid = 4321;
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly autoClose: boolean;
  input = "";
  closed = false;

  constructor(autoClose = true) {
    super();
    this.autoClose = autoClose;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += String(chunk);
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.autoClose) queueMicrotask(() => this.closeNow(signal));
    return true;
  }

  complete(stdout: string, code = 0, stderr = ""): void {
    queueMicrotask(() => {
      if (stdout !== "") this.stdout.write(stdout);
      if (stderr !== "") this.stderr.write(stderr);
      this.stdout.end();
      this.stderr.end();
      this.closeNow(null, code);
    });
  }

  ready(port = 43_123): void {
    queueMicrotask(() => {
      this.stdout.write(
        `opencode server listening on http://127.0.0.1:${port}\n`,
      );
    });
  }

  closeNow(signal: NodeJS.Signals | null, code: number | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | undefined;
}

const DENY_ALL = [{ permission: "*", pattern: "*", action: "deny" }] as const;
const LIVE_OPENCODE_1_15_13 = (() => {
  const result = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0
    && result.stdout.trim() === OPEN_CODE_SECURE_SERVER_VERSION;
})();

class FakeOpenCodeApi {
  readonly requests: CapturedRequest[] = [];
  readonly sessions = new Map<string, readonly unknown[]>();
  readonly prompts: CapturedRequest[] = [];
  #nextSession = 1;
  #nextStream = 1;
  #streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  #encoder = new TextEncoder();

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const body = rawBody === undefined
      ? undefined
      : JSON.parse(rawBody) as Record<string, unknown>;
    const captured: CapturedRequest = {
      method,
      path: url.pathname,
      headers: new Headers(init?.headers),
      body,
    };
    this.requests.push(captured);

    if (method === "GET" && url.pathname === "/global/health") {
      return Response.json({
        healthy: true,
        version: OPEN_CODE_SECURE_SERVER_VERSION,
      });
    }
    if (method === "GET" && url.pathname === "/event") {
      const id = this.#nextStream++;
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.#streams.set(id, controller);
          controller.enqueue(this.#encode({
            id: `event-${id}`,
            type: "server.connected",
            properties: {},
          }));
          signal?.addEventListener("abort", () => {
            this.#streams.delete(id);
            try {
              controller.error(signal.reason);
            } catch {
              // The runtime may have already closed this stream.
            }
          }, { once: true });
        },
        cancel: () => {
          this.#streams.delete(id);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (method === "POST" && url.pathname === "/session") {
      const id = `session-${this.#nextSession++}`;
      const permission = Array.isArray(body?.permission) ? body.permission : [];
      this.sessions.set(id, permission);
      return Response.json({ id, permission });
    }

    const match = /^\/session\/([^/]+)(?:\/(prompt_async|abort))?$/u.exec(
      url.pathname,
    );
    if (match !== null) {
      const id = decodeURIComponent(match[1] ?? "");
      const action = match[2];
      if (!this.sessions.has(id)) return new Response("", { status: 404 });
      if (method === "GET" && action === undefined) {
        return Response.json({ id, permission: this.sessions.get(id) });
      }
      if (method === "PATCH" && action === undefined) {
        const current = this.sessions.get(id) ?? [];
        const appended = Array.isArray(body?.permission)
          ? [...current, ...body.permission]
          : current;
        this.sessions.set(id, appended);
        return Response.json({ id, permission: appended });
      }
      if (method === "POST" && action === "prompt_async") {
        this.prompts.push(captured);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && action === "abort") {
        return Response.json(true);
      }
    }
    return new Response("", { status: 500 });
  }) as typeof globalThis.fetch;

  addSession(id: string, permission: readonly unknown[]): void {
    this.sessions.set(id, permission);
  }

  emit(type: string, properties: Record<string, unknown>): void {
    const encoded = this.#encode({
      id: `event-${Date.now()}-${Math.random()}`,
      type,
      properties,
    });
    for (const [id, stream] of this.#streams) {
      try {
        stream.enqueue(encoded);
      } catch {
        this.#streams.delete(id);
      }
    }
  }

  failStreams(error: Error): void {
    for (const [id, stream] of this.#streams) {
      this.#streams.delete(id);
      try {
        stream.error(error);
      } catch {
        // The runtime may have already closed this stream.
      }
    }
  }

  assistant(
    sessionId: string,
    text: string,
    suffix: string,
    includeIdle = true,
  ): void {
    const messageID = `assistant-${suffix}`;
    const partID = `part-${suffix}`;
    this.emit("message.updated", {
      sessionID: sessionId,
      info: { id: messageID, sessionID: sessionId, role: "assistant", time: {} },
    });
    this.emit("message.part.updated", {
      sessionID: sessionId,
      part: {
        id: partID,
        sessionID: sessionId,
        messageID,
        type: "text",
        text: "",
      },
    });
    this.emit("message.part.delta", {
      sessionID: sessionId,
      messageID,
      partID,
      field: "text",
      delta: text,
    });
    this.emit("message.updated", {
      sessionID: sessionId,
      info: {
        id: messageID,
        sessionID: sessionId,
        role: "assistant",
        time: { completed: Date.now() },
        tokens: {
          input: 3,
          output: 2,
          reasoning: 1,
          cache: { read: 1, write: 0 },
        },
      },
    });
    if (includeIdle) this.idle(sessionId);
  }

  idle(sessionId: string): void {
    this.emit("session.status", {
      sessionID: sessionId,
      status: { type: "idle" },
    });
  }

  #encode(value: unknown): Uint8Array {
    return this.#encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  }
}

function request(
  turnId: string,
  session?: RuntimeTurnRequest["session"],
): RuntimeTurnRequest {
  return {
    turnId,
    conversationId: "conversation",
    model: "anthropic/claude-sonnet-4-5",
    messages: [{
      role: "user",
      content: [{ type: "text", text: `hello from ${turnId}; $(unsafe)` }],
    }],
    tools: [],
    signal: new AbortController().signal,
    ...(session === undefined ? {} : { session }),
  };
}

function context(events: RuntimeTurnEvent[] = []) {
  return {
    emit(event: RuntimeTurnEvent) {
      events.push(event);
    },
    async executeTool(call: { readonly id: string }) {
      return { callId: call.id, content: [] };
    },
  };
}

function harness(api: FakeOpenCodeApi, autoClose = true) {
  const invocations: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly shell: boolean;
    readonly child: FakeProcess;
  }[] = [];
  let serverChild: FakeProcess | undefined;
  const spawnProcess = vi.fn<SpawnProcess>((command, args, options) => {
    const child = new FakeProcess(args[0] === "serve" ? autoClose : true);
    invocations.push({
      command,
      args,
      env: options.env,
      shell: options.shell,
      child,
    });
    if (args[0] === "--version") child.complete(`${OPEN_CODE_SECURE_SERVER_VERSION}\n`);
    else {
      serverChild = child;
      child.ready();
    }
    return child;
  });
  const runtime = createRuntimeOpenCode({
    config: parseRuntimeOpenCodeConfig({ timeoutMs: 5_000 }),
    instanceId: "opencode-runtime",
    workspaceDirectory: process.cwd(),
    spawnProcess,
    fetch: api.fetch,
    terminationGraceMs: 500,
  });
  return {
    runtime,
    invocations,
    serverChild: () => serverChild,
  };
}

describe("runtime-opencode", () => {
  it("validates the 1.15.13 security floor and constructs an isolated owned environment", async () => {
    const definition = await import("../index.js");
    const config = parseRuntimeOpenCodeConfig({});
    expect(config.minimumVersion).toBe(OPEN_CODE_SECURE_SERVER_VERSION);
    expect(() => parseRuntimeOpenCodeConfig({ minimumVersion: "1.15.12" }))
      .toThrow(`must be >=${OPEN_CODE_SECURE_SERVER_VERSION}`);
    expect(() => parseRuntimeOpenCodeConfig({ minimumVersion: "1.15.13-beta.1" }))
      .toThrow("must be stable semver");
    expect(definition.monoAgentModule.validateModel?.({
      model: "anthropic/claude-sonnet-4-5",
      config,
    })).toMatchObject({
      supported: true,
      capabilities: { tools: false, sessions: true },
      nativeTools: [],
    });
    expect(() => definition.monoAgentModule.validateModel?.({
      model: "anthropic:claude-sonnet-4-5",
      config: { minimumVersion: "1.15.12" },
    })).toThrow();

    const environment = openCodeProcessEnvironment({
      OPENAI_API_KEY: "configured",
      OPENCODE_CONFIG_CONTENT: "{\"permission\":\"allow\"}",
      OPENCODE_PERMISSION: "{\"*\":\"allow\"}",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "false",
    }, {
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      AMBIENT_SECRET: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
    }, {
      agentName: "owned-agent",
      directories: {
        home: "/owned/home",
        config: "/owned/config",
        data: "/owned/data",
        cache: "/owned/cache",
        state: "/owned/state",
      },
      serverUsername: "opencode",
      serverPassword: "owned-password",
    });
    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/owned/home",
      XDG_CONFIG_HOME: "/owned/config",
      XDG_DATA_HOME: "/owned/data",
      XDG_CACHE_HOME: "/owned/cache",
      XDG_STATE_HOME: "/owned/state",
      OPENAI_API_KEY: "configured",
      OPENCODE_PERMISSION: "{\"*\":\"deny\"}",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "owned-password",
    });
    expect(environment.AMBIENT_SECRET).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
      permission: { "*": "deny" },
      tools: { "*": false },
      agent: {
        "owned-agent": {
          mode: "primary",
          permission: { "*": "deny" },
        },
      },
    });
    const environmentSchema =
      runtimeOpenCodeJsonSchema.properties.environment.additionalProperties as
        Record<string, unknown>;
    expect(environmentSchema["x-mono-agent-env-eligible"]).toBe(true);
    expect(environmentSchema["x-mono-agent-secret"]).toBe(true);
  });

  it("does not return a startup failure until the owned child confirms exit", async () => {
    let serverChild: FakeProcess | undefined;
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({ timeoutMs: 2_000 }),
      instanceId: "opencode-runtime",
      workspaceDirectory: process.cwd(),
      terminationGraceMs: 500,
      spawnProcess(_command, args) {
        if (args[0] === "--version") {
          const version = new FakeProcess();
          version.complete(`${OPEN_CODE_SECURE_SERVER_VERSION}\n`);
          return version;
        }
        serverChild = new FakeProcess(false);
        queueMicrotask(() => {
          serverChild?.stdout.write(
            "opencode server listening on http://0.0.0.0:1234\n",
          );
        });
        return serverChild;
      },
    });
    let settled = false;
    const starting = Promise.resolve(runtime.start?.({
      signal: new AbortController().signal,
    })).finally(() => {
      settled = true;
    });
    void starting.catch(() => undefined);
    await vi.waitFor(() => expect(serverChild?.signals).toEqual(["SIGTERM"]));
    expect(settled).toBe(false);
    serverChild?.closeNow("SIGTERM");
    await expect(starting).rejects.toMatchObject({ code: "START_FAILED" });
    expect(runtime.health?.({
      signal: new AbortController().signal,
    })).toMatchObject({ details: { state: "created" } });
  });

  it("publishes only bounded accessor-free redacted process causes", async () => {
    const secret = "sk-secret";
    let accessorReads = 0;
    const processCause = new Error(
      `spawn rejected ${secret} ${"x".repeat(8_192)}`,
    ) as Error & { code?: string };
    processCause.name = `SpawnFailure-${secret}`;
    Object.defineProperty(processCause, "code", {
      configurable: true,
      enumerable: true,
      value: `SPAWN_${secret}`,
      writable: true,
    });
    Object.defineProperty(processCause, "cause", {
      configurable: true,
      get() {
        accessorReads += 1;
        return new Error(`nested ${secret}`);
      },
    });
    Object.defineProperty(processCause, "danger", {
      configurable: true,
      get() {
        accessorReads += 1;
        return secret;
      },
    });
    const runtime = createRuntimeOpenCode({
      config: parseRuntimeOpenCodeConfig({
        timeoutMs: 2_000,
        environment: { OPENAI_API_KEY: secret },
      }),
      instanceId: "opencode-runtime",
      workspaceDirectory: process.cwd(),
      spawnProcess() {
        const child = new FakeProcess();
        queueMicrotask(() => child.emit("error", processCause));
        return child;
      },
    });

    let failure: unknown;
    try {
      await runtime.start?.({ signal: new AbortController().signal });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeOpenCodeError);
    const typed = failure as RuntimeOpenCodeError;
    expect(typed.message).not.toContain(secret);
    expect(typed.message.length).toBeLessThanOrEqual(4_096);
    expect(typed.cause).toBeInstanceOf(Error);
    expect(typed.cause === processCause).toBe(false);
    const cause = typed.cause as Error & { readonly code?: string };
    expect(cause.message).not.toContain(secret);
    expect(cause.message.length).toBeLessThanOrEqual(4_096);
    expect(cause.name).toBe("SpawnFailure-[REDACTED]");
    expect(cause.code).toBe("SPAWN_[REDACTED]");
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

  it("uses the authenticated 1.15.13 server API and waits for completed assistant plus final idle", async () => {
    const api = new FakeOpenCodeApi();
    const { runtime, invocations, serverChild } = harness(api);
    await runtime.start?.({ signal: new AbortController().signal });
    const events: RuntimeTurnEvent[] = [];
    let settled = false;
    const turn = runtime.runTurn(request("turn-1"), context(events))
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(api.prompts).toHaveLength(1));

    api.assistant("session-1", "hello", "one", false);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    api.idle("session-1");

    await expect(turn).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "hello" }] },
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        reasoningTokens: 1,
        cacheReadTokens: 1,
      },
      session: {
        id: "session-1",
        conversationId: "conversation",
        route: {
          runtimeInstanceId: "opencode-runtime",
          model: "anthropic/claude-sonnet-4-5",
        },
      },
    });
    expect(events).toContainEqual({ type: "text-delta", delta: "hello" });
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    expect(events.findIndex((event) => event.type === "text-delta"))
      .toBeLessThan(events.findIndex((event) => event.type === "usage"));

    const create = api.requests.find(
      (entry) => entry.method === "POST" && entry.path === "/session",
    );
    expect(create?.body).toMatchObject({
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      permission: DENY_ALL,
    });
    expect(create?.body?.agent).toMatch(
      new RegExp(`^${OPEN_CODE_TOOL_FREE_AGENT}-[0-9a-f]{16}$`, "u"),
    );
    const promptRequest = api.prompts[0];
    expect(promptRequest?.body).toMatchObject({
      model: { modelID: "claude-sonnet-4-5", providerID: "anthropic" },
      tools: { "*": false },
      parts: [{ type: "text", text: expect.stringContaining("$(unsafe)") }],
    });
    const eventIndex = api.requests.findIndex((entry) => entry.path === "/event");
    const promptIndex = api.requests.findIndex(
      (entry) => entry.path.endsWith("/prompt_async"),
    );
    expect(eventIndex).toBeGreaterThan(-1);
    expect(eventIndex).toBeLessThan(promptIndex);

    const serverInvocation = invocations.find((entry) => entry.args[0] === "serve");
    expect(serverInvocation?.args).toEqual([
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
      "--pure",
    ]);
    expect(serverInvocation?.shell).toBe(false);
    const password = serverInvocation?.env.OPENCODE_SERVER_PASSWORD;
    expect(password).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    const expectedAuthorization = `Basic ${Buffer.from(
      `opencode:${password}`,
      "utf8",
    ).toString("base64")}`;
    expect(
      api.requests.every(
        (entry) => entry.headers.get("authorization") === expectedAuthorization,
      ),
    ).toBe(true);
    expect(
      api.requests.every(
        (entry) => entry.headers.get("x-opencode-directory") === process.cwd(),
      ),
    ).toBe(true);
    expect(serverInvocation?.env.HOME).not.toBe(process.env.HOME);

    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
    expect(serverChild()?.signals).toEqual(["SIGTERM"]);
  });

  it("rejects wrong session linkage before any per-turn server request", async () => {
    const api = new FakeOpenCodeApi();
    const { runtime } = harness(api);
    await runtime.start?.({ signal: new AbortController().signal });
    const requestsAfterStart = api.requests.length;
    const exactSession: RuntimeSession = {
      id: "shared",
      conversationId: "conversation",
      route: {
        runtimeInstanceId: "opencode-runtime",
        model: "anthropic/claude-sonnet-4-5",
      },
    };
    const invalidSessions: RuntimeSession[] = [
      {
        ...exactSession,
        route: { ...exactSession.route, runtimeInstanceId: "other-runtime" },
      },
      {
        ...exactSession,
        route: { ...exactSession.route, model: "anthropic/claude-opus-4-1" },
      },
      {
        ...exactSession,
        conversationId: "other-conversation",
      },
    ];

    for (const session of invalidSessions) {
      await expect(runtime.runTurn(
        request("wrong-linkage", session),
        context(),
      )).rejects.toMatchObject({ code: "SESSION_INVALID" });
    }
    expect(api.requests).toHaveLength(requestsAfterStart);
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("maps a provider-native 404 continuation to the shared unavailable code", async () => {
    const api = new FakeOpenCodeApi();
    const { runtime } = harness(api);
    await runtime.start?.({ signal: new AbortController().signal });
    await expect(runtime.runTurn(
      request("missing-session", {
        id: "missing",
        conversationId: "conversation",
        route: {
          runtimeInstanceId: "opencode-runtime",
          model: "anthropic/claude-sonnet-4-5",
        },
      }),
      context(),
    )).rejects.toMatchObject({
      code: RUNTIME_SESSION_UNAVAILABLE_CODE,
      retryability: "not-retryable",
      sideEffects: "none",
    });
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("repairs resumed permissions and serializes prompts for the same session", async () => {
    const api = new FakeOpenCodeApi();
    api.addSession("shared", [
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    const { runtime } = harness(api);
    await runtime.start?.({ signal: new AbortController().signal });
    const session = {
      id: "shared",
      conversationId: "conversation",
      route: {
        runtimeInstanceId: "opencode-runtime",
        model: "anthropic/claude-sonnet-4-5",
      },
    };
    const first = runtime.runTurn(request("first", session), context());
    const second = runtime.runTurn(request("second", session), context());
    await vi.waitFor(() => expect(api.prompts).toHaveLength(1));

    const patch = api.requests.find(
      (entry) => entry.method === "PATCH" && entry.path === "/session/shared",
    );
    expect(patch?.body).toEqual({ permission: DENY_ALL });
    expect(api.sessions.get("shared")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      ...DENY_ALL,
    ]);
    api.assistant("shared", "first", "first");
    await expect(first).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "first" }] },
    });

    await vi.waitFor(() => expect(api.prompts).toHaveLength(2));
    api.assistant("shared", "second", "second");
    await expect(second).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "second" }] },
    });
    expect(api.prompts.map((entry) => entry.body?.tools)).toEqual([
      { "*": false },
      { "*": false },
    ]);
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("does not let a cancelled queued turn abort the active same-session prompt", async () => {
    const api = new FakeOpenCodeApi();
    api.addSession("shared", DENY_ALL);
    const { runtime } = harness(api);
    await runtime.start?.({ signal: new AbortController().signal });
    const session = {
      id: "shared",
      conversationId: "conversation",
      route: {
        runtimeInstanceId: "opencode-runtime",
        model: "anthropic/claude-sonnet-4-5",
      },
    };
    const first = runtime.runTurn(request("first", session), context());
    await vi.waitFor(() => expect(api.prompts).toHaveLength(1));
    const queuedController = new AbortController();
    const second = runtime.runTurn({
      ...request("second", session),
      signal: queuedController.signal,
    }, context());
    queuedController.abort(new DOMException("cancel queued turn", "AbortError"));
    await expect(second).resolves.toMatchObject({ status: "cancelled" });
    expect(
      api.requests.filter((entry) => entry.path === "/session/shared/abort"),
    ).toHaveLength(0);

    api.assistant("shared", "first", "active");
    await expect(first).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "first" }] },
    });
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("finishes native abort before unlocking a session after SSE failure", async () => {
    const api = new FakeOpenCodeApi();
    api.addSession("shared", DENY_ALL);
    const { runtime } = harness(api);
    await runtime.start?.({ signal: new AbortController().signal });
    const session = {
      id: "shared",
      conversationId: "conversation",
      route: {
        runtimeInstanceId: "opencode-runtime",
        model: "anthropic/claude-sonnet-4-5",
      },
    };
    const failed = runtime.runTurn(request("failed", session), context());
    await vi.waitFor(() => expect(api.prompts).toHaveLength(1));
    api.failStreams(new Error("event stream failed"));
    await expect(failed).rejects.toMatchObject({ code: "SSE_FAILED" });
    expect(
      api.requests.filter((entry) => entry.path === "/session/shared/abort"),
    ).toHaveLength(1);

    const recovered = runtime.runTurn(request("recovered", session), context());
    await vi.waitFor(() => expect(api.prompts).toHaveLength(2));
    api.assistant("shared", "recovered", "recovered");
    await expect(recovered).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "recovered" }] },
    });
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("quarantines synchronously on native tools, aborts siblings, and rejects new turns before process exit", async () => {
    const api = new FakeOpenCodeApi();
    const { runtime, serverChild } = harness(api, false);
    await runtime.start?.({ signal: new AbortController().signal });
    const first = runtime.runTurn(request("first"), context());
    const second = runtime.runTurn(request("second"), context());
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    await vi.waitFor(() => expect(api.prompts).toHaveLength(2));

    api.emit("message.part.updated", {
      sessionID: "session-1",
      part: {
        id: "tool-1",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "tool",
        tool: "bash",
        state: { status: "running" },
      },
    });
    await vi.waitFor(() => {
      expect(runtime.health?.({
        signal: new AbortController().signal,
      })).toMatchObject({
        status: "degraded",
        details: {
          state: "draining",
          quarantineCode: "NATIVE_TOOL_PROTOCOL_VIOLATION",
        },
      });
    });
    expect(serverChild()?.closed).toBe(false);
    expect(serverChild()?.signals[0]).toBe("SIGTERM");
    await expect(runtime.runTurn(request("later"), context())).rejects.toMatchObject({
      code: "RUNTIME_NOT_RUNNING",
    });
    await expect(first).rejects.toMatchObject({
      code: "NATIVE_TOOL_PROTOCOL_VIOLATION",
      retryability: "not-retryable",
      sideEffects: "unknown",
    });
    await expect(second).rejects.toMatchObject({
      code: "NATIVE_TOOL_PROTOCOL_VIOLATION",
      retryability: "not-retryable",
      sideEffects: "unknown",
    });

    serverChild()?.closeNow("SIGTERM");
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("treats a matching permission request as the same fatal native-tool violation", async () => {
    const api = new FakeOpenCodeApi();
    const { runtime, serverChild } = harness(api, false);
    await runtime.start?.({ signal: new AbortController().signal });
    const turn = runtime.runTurn(request("turn"), context());
    await vi.waitFor(() => expect(api.prompts).toHaveLength(1));
    api.emit("permission.asked", {
      id: "permission-1",
      sessionID: "session-1",
      permission: "bash",
      patterns: ["*"],
    });
    await expect(turn).rejects.toMatchObject({
      code: "NATIVE_TOOL_PROTOCOL_VIOLATION",
    });
    expect(runtime.health?.({
      signal: new AbortController().signal,
    })).toMatchObject({ details: { state: "draining" } });
    serverChild()?.closeNow("SIGTERM");
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it("quarantines on native activity that omits its session binding", async () => {
    const api = new FakeOpenCodeApi();
    const { runtime, serverChild } = harness(api, false);
    await runtime.start?.({ signal: new AbortController().signal });
    const turn = runtime.runTurn(request("turn"), context());
    await vi.waitFor(() => expect(api.prompts).toHaveLength(1));
    api.emit("permission.asked", {
      id: "permission-unbound",
      permission: "bash",
      patterns: ["*"],
    });
    await expect(turn).rejects.toMatchObject({
      code: "NATIVE_TOOL_PROTOCOL_VIOLATION",
      retryability: "not-retryable",
      sideEffects: "unknown",
    });
    expect(runtime.health?.({
      signal: new AbortController().signal,
    })).toMatchObject({
      status: "degraded",
      details: {
        state: "draining",
        quarantineCode: "NATIVE_TOOL_PROTOCOL_VIOLATION",
      },
    });
    expect(serverChild()?.signals[0]).toBe("SIGTERM");
    serverChild()?.closeNow("SIGTERM");
    await runtime.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown",
    });
  });

  it.runIf(LIVE_OPENCODE_1_15_13)(
    "proves hostile managed config cannot put tools in the first provider request",
    async () => {
      let resolveProviderRequest!: (body: Record<string, unknown>) => void;
      const firstProviderRequest = new Promise<Record<string, unknown>>(
        (resolve) => {
          resolveProviderRequest = resolve;
        },
      );
      let providerRequestObserved = false;
      const provider = createServer((incoming, response) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        incoming.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
            Record<string, unknown>;
          if (!providerRequestObserved) {
            providerRequestObserved = true;
            resolveProviderRequest(body);
          }
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const events = [
            {
              type: "response.created",
              response: {
                id: "resp_tool_free",
                created_at: Math.floor(Date.now() / 1_000),
                model: "test",
                service_tier: null,
              },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_tool_free",
                phase: "final_answer",
              },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg_tool_free",
              output_index: 0,
              content_index: 0,
              delta: "safe",
              logprobs: null,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_tool_free",
                phase: "final_answer",
              },
            },
            {
              type: "response.completed",
              response: {
                incomplete_details: null,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 1,
                  output_tokens_details: { reasoning_tokens: 0 },
                },
                service_tier: null,
              },
            },
          ];
          for (const event of events) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", () => resolve());
      });
      const address = provider.address();
      if (address === null || typeof address === "string") {
        throw new Error("provider test server did not bind a TCP port");
      }

      const managed = await mkdtemp(join(tmpdir(), "opencode-managed-hostile-"));
      await writeFile(join(managed, "opencode.json"), JSON.stringify({
        permission: { "*": "allow" },
        tools: { "*": true },
        provider: {
          hostile: {
            name: "Hostile managed provider",
            npm: "@ai-sdk/openai",
            options: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "managed-hostile-key",
            },
            models: {
              test: {
                name: "Hostile test",
                tool_call: true,
                modalities: { input: ["text"], output: ["text"] },
                limit: { context: 8_192, output: 1_024 },
              },
            },
          },
        },
        model: "hostile/test",
        small_model: "hostile/test",
      }), { mode: 0o600 });

      const runtime = createRuntimeOpenCode({
        config: parseRuntimeOpenCodeConfig({
          timeoutMs: 20_000,
          environment: {
            OPENCODE_TEST_MANAGED_CONFIG_DIR: managed,
          },
        }),
        instanceId: "opencode-live-proof",
        workspaceDirectory: process.cwd(),
      });
      let started = false;
      try {
        await runtime.start?.({ signal: new AbortController().signal });
        started = true;
        const turn = runtime.runTurn({
          ...request("live-proof"),
          model: "hostile/test",
        }, context());
        const outbound = await firstProviderRequest;
        expect(Object.hasOwn(outbound, "tools")).toBe(false);
        expect(Object.hasOwn(outbound, "tool_choice")).toBe(false);
        await expect(turn).resolves.toMatchObject({
          status: "completed",
          message: { content: [{ type: "text", text: "safe" }] },
        });
      } finally {
        if (started) {
          await runtime.stop?.({
            signal: new AbortController().signal,
            reason: "shutdown",
          });
        }
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(managed, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

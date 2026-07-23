import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Models,
} from "@earendil-works/pi-ai";
import type {
  ModuleStopReason,
  Runtime,
  RuntimeToolCall,
  RuntimeTurnContext,
  RuntimeTurnEvent,
  RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRuntimePiConfig } from "../config.js";
import { createRuntimePi, RuntimePiError } from "../runtime.js";

const abortSignal = () => new AbortController().signal;
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(
  text: string,
  overrides: Partial<RuntimeTurnRequest> = {},
): RuntimeTurnRequest {
  return {
    turnId: `turn-${Math.random()}`,
    conversationId: "conversation-1",
    model: "faux:faux-model",
    messages: [
      { role: "system", content: [{ type: "text", text: "Be concise." }] },
      { role: "user", content: [{ type: "text", text }] },
    ],
    tools: [],
    signal: abortSignal(),
    ...overrides,
  };
}

function turnContext(executeTool = vi.fn<RuntimeTurnContext["executeTool"]>()): {
  context: RuntimeTurnContext;
  events: RuntimeTurnEvent[];
} {
  const events: RuntimeTurnEvent[] = [];
  return {
    events,
    context: {
      async emit(event) { events.push(event); },
      executeTool,
    },
  };
}

function fauxRuntime(options: { tokensPerSecond?: number; authPath?: string } = {}): {
  runtime: Runtime;
  faux: ReturnType<typeof fauxProvider>;
  models: Models;
} {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning: true, input: ["text"] }],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = createRuntimePi({
    config: parseRuntimePiConfig(options.authPath === undefined ? {} : { auth: { path: options.authPath } }),
    instanceId: "test-runtime",
    configDirectory: process.cwd(),
    workspaceDirectory: process.cwd(),
    models,
  });
  return { runtime, faux, models };
}

async function start(runtime: Runtime): Promise<void> {
  await runtime.start?.({ signal: abortSignal() });
}

async function stop(runtime: Runtime, reason: ModuleStopReason = "shutdown"): Promise<void> {
  await runtime.stop?.({ signal: abortSignal(), reason });
}

describe("Pi-native runtime module", () => {
  it("runs through the real AgentHarness and reconstructs continuity from canonical messages", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxText("first")]),
      (context) => fauxAssistantMessage([
        fauxText(context.messages.some((message) => message.role === "assistant"
          && message.content.some((part) => part.type === "text" && part.text === "first"))
          ? "continued"
          : "history-missing"),
      ]),
    ]);
    await start(runtime);

    const firstContext = turnContext();
    const first = await runtime.runTurn(request("one"), firstContext.context);
    expect(first.status).toBe("completed");
    expect(first.message?.content).toContainEqual({ type: "text", text: "first" });
    expect(first.session).toMatchObject({ provider: "pi", model: "faux:faux-model", runtimeInstanceId: "test-runtime" });
    expect(firstContext.events.some((event) => event.type === "text-delta")).toBe(true);
    expect(firstContext.events.some((event) => event.type === "usage")).toBe(true);
    expect(firstContext.events.some((event) => event.type === "session")).toBe(true);

    const secondContext = turnContext();
    const second = await runtime.runTurn(request("two", {
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "user", content: [{ type: "text", text: "two" }] },
      ],
      session: first.session!,
    }), secondContext.context);
    expect(second.message?.content).toContainEqual({ type: "text", text: "continued" });
    expect(second.session?.id).not.toBe(first.session?.id);
    await stop(runtime);
  });

  it("delegates Pi tool calls through the host context and emits normalized tool events", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Echo", { value: "hello" }, { id: "call-1" })]),
      fauxAssistantMessage([fauxText("tool complete")]),
    ]);
    const executeTool = vi.fn(async (call: RuntimeToolCall, _signal: AbortSignal) => ({
      callId: call.id,
      content: [{ type: "text" as const, text: `echo:${(call.input as { value: string }).value}` }],
    }));
    const { context, events } = turnContext(executeTool);
    await start(runtime);
    const result = await runtime.runTurn(request("use the tool", {
      tools: [{
        name: "Echo",
        description: "Echo a value.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      }],
    }), context);

    expect(result.message?.content).toContainEqual({ type: "text", text: "tool complete" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0]).toEqual({ id: "call-1", name: "Echo", input: { value: "hello" } });
    expect(executeTool.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(events).toContainEqual({ type: "tool-call", call: { id: "call-1", name: "Echo", input: { value: "hello" } } });
    expect(events.some((event) => event.type === "tool-result")).toBe(true);
    await stop(runtime);
  });

  it("projects artifact-backed tool results through their bounded preview and opaque reference", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("LargeResult", {}, { id: "call-artifact" })]),
      (context) => {
        const transcript = JSON.stringify(context.messages);
        return fauxAssistantMessage([fauxText(
          transcript.includes("bounded preview")
            && transcript.includes("artifact-1")
            && transcript.includes("sha256:")
            ? "artifact visible"
            : "artifact missing",
        )]);
      },
    ]);
    const executeTool = vi.fn(async (call: RuntimeToolCall) => ({
      callId: call.id,
      content: [{
        type: "artifact" as const,
        ref: {
          id: "artifact-1",
          sha256: `sha256:${"a".repeat(64)}` as const,
          sizeBytes: 300_000,
          mediaType: "application/json",
          fileName: "result.json",
        },
        preview: "bounded preview",
      }],
    }));
    const { context } = turnContext(executeTool);
    await start(runtime);

    const result = await runtime.runTurn(request("use the large-result tool", {
      tools: [{
        name: "LargeResult",
        description: "Return one large result.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }],
    }), context);

    expect(result.message?.content).toContainEqual({
      type: "text",
      text: "artifact visible",
    });
    await stop(runtime);
  });

  it("maps external abort to a cancelled settled result", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      (_context, streamOptions) => new Promise((resolve) => {
        const settleAborted = () => resolve(fauxAssistantMessage([], {
          stopReason: "aborted",
          errorMessage: "request aborted",
        }));
        if (streamOptions?.signal?.aborted === true) settleAborted();
        else streamOptions?.signal?.addEventListener("abort", settleAborted, { once: true });
      }),
    ]);
    const controller = new AbortController();
    const { context } = turnContext();
    await start(runtime);
    const run = runtime.runTurn(request("abort", { signal: controller.signal }), context);
    setTimeout(() => controller.abort(), 10);
    await expect(run).resolves.toMatchObject({ status: "cancelled" });
    await stop(runtime);
  });

  it("rejects invalid models and refuses turns outside the running lifecycle", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([fauxAssistantMessage("unused")]);
    expect(runtime.capabilities).toMatchObject({ approvals: false, sandbox: false });
    await expect(runtime.runTurn(request("not started"), turnContext().context))
      .rejects.toMatchObject({ code: "RUNTIME_NOT_RUNNING" });
    await start(runtime);
    expect(runtime.validateModel).toBeUndefined();
    expect(await runtime.preflightModel?.({ model: "bad-reference", signal: abortSignal() }))
      .toMatchObject({ supported: false });
    expect(await runtime.preflightModel?.({ model: "faux:faux-model", signal: abortSignal() })).toMatchObject({
      supported: true,
      capabilities: { attachments: false, approvals: false, sandbox: false, sessions: true, liveInput: true },
      nativeTools: [],
    });
    const aborted = new AbortController();
    aborted.abort(new Error("preflight cancelled"));
    await expect(runtime.preflightModel?.({
      model: "faux:faux-model",
      signal: aborted.signal,
    })).rejects.toThrow("preflight cancelled");
    await expect(runtime.runTurn(request("bad model", { model: "faux:missing" }), turnContext().context))
      .rejects.toMatchObject({ code: "MODEL_INVALID" });
    await expect(runtime.runTurn(request("opaque resume", {
      session: { id: "unsafe-native-session" },
    }), turnContext().context)).rejects.toMatchObject({ code: "SESSION_INVALID", retryable: false });
    await stop(runtime);
    await expect(runtime.runTurn(request("stopped"), turnContext().context))
      .rejects.toBeInstanceOf(RuntimePiError);
  });

  it("resolves authored auth and session paths from the config directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-config-directory-"));
    roots.push(root);
    const configDirectory = join(root, "config");
    const workspaceDirectory = join(root, "workspace");
    await Promise.all([
      mkdir(configDirectory, { mode: 0o700 }),
      mkdir(workspaceDirectory, { mode: 0o700 }),
    ]);
    await writeFile(
      join(configDirectory, "auth.json"),
      JSON.stringify({ faux: { type: "api_key", key: "provider-secret" } }),
      { mode: 0o600 },
    );

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text"] }],
    });
    faux.setResponses([fauxAssistantMessage([fauxText("configured")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({
        auth: { path: "./auth.json" },
        sessions: { root: "./sessions" },
      }),
      instanceId: "relative-paths",
      configDirectory,
      workspaceDirectory,
      models,
    });

    await expect(runtime.diagnostics?.({ signal: abortSignal(), verbose: true })).resolves.toContainEqual(
      expect.objectContaining({ code: "runtime-pi.auth", message: "Explicit auth store contains 1 provider credential" }),
    );
    await start(runtime);
    await expect(runtime.runTurn(request("relative paths"), turnContext().context)).resolves.toMatchObject({
      status: "completed",
    });
    await stop(runtime);
    expect(await readdir(join(configDirectory, "sessions"))).toHaveLength(1);
    await expect(readdir(join(workspaceDirectory, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts auth-store secrets from provider failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-error-redaction-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    await writeFile(authPath, JSON.stringify({ faux: { type: "api_key", key: "provider-secret" } }), { mode: 0o600 });
    await chmod(authPath, 0o600);
    const { runtime, faux } = fauxRuntime({ authPath });
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider rejected provider-secret" }),
    ]);
    await start(runtime);
    let error: unknown;
    try {
      await runtime.runTurn(request("fail"), turnContext().context);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimePiError);
    expect((error as Error).message).not.toContain("provider-secret");
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    await stop(runtime);
  });

  it("marks provider failure after a tool attempt as committed", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "effect-1" })]),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed after tool" }),
    ]);
    const { context } = turnContext(vi.fn(async (call: RuntimeToolCall) => ({
      callId: call.id,
      content: [{ type: "text" as const, text: "done" }],
    })));
    await start(runtime);
    await expect(runtime.runTurn(request("run effect", {
      tools: [{
        name: "Effect",
        description: "Perform an effect.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      }],
    }), context)).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
      committedSideEffects: true,
      retryable: true,
    });
    await stop(runtime);
  });

  it("does not seed a failed attempt into the next turn", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "first failed" }),
      (providerContext) => fauxAssistantMessage([
        fauxText(providerContext.messages.some((message) => message.role === "assistant") ? "poisoned" : "clean"),
      ]),
    ]);
    await start(runtime);
    await expect(runtime.runTurn(request("first"), turnContext().context)).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
    const second = await runtime.runTurn(request("retry"), turnContext().context);
    expect(second.message?.content).toContainEqual({ type: "text", text: "clean" });
    await stop(runtime);
  });
});

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((incoming, outgoing) => {
    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    outgoing.write(`data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "fixture ok" }, finish_reason: null }],
    })}\n\n`);
    outgoing.write(`data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`);
    outgoing.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

describe("local OpenAI-compatible provider", () => {
  it("runs a real credential-free HTTP stream through Pi's native API adapter", async () => {
    const { baseUrl } = await startFixtureServer();
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({
        retry: { maxRetries: 0, timeoutMs: 10_000 },
        localProviders: [
          {
            id: "fixture",
            baseUrl,
            models: [{ id: "fixture-model", contextWindow: 8_192, maxTokens: 256 }],
          },
        ],
      }),
      instanceId: "http-fixture",
      configDirectory: process.cwd(),
      workspaceDirectory: process.cwd(),
    });
    await start(runtime);
    const { context, events } = turnContext();
    const result = await runtime.runTurn(request("hello", { model: "fixture:fixture-model" }), context);
    expect(result).toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "fixture ok" }] },
      metadata: { provider: "fixture", model: "fixture-model" },
    });
    expect(result.session).toMatchObject({ provider: "pi", model: "fixture:fixture-model" });
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""))
      .toBe("fixture ok");
    await stop(runtime);
  });
});

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  close: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp.js")>();
  return {
    ...actual,
    async connectProjectMcpTools(...args: Parameters<typeof actual.connectProjectMcpTools>) {
      const connected = await actual.connectProjectMcpTools(...args);
      return mcpMocks.close === undefined ? connected : { ...connected, close: mcpMocks.close };
    },
  };
});

import { createAgentHost } from "../index.js";
import type { AgentConfig } from "../types.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  type FixtureController,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  mcpMocks.close = undefined;
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("agent host lifecycle", () => {
  it("accounts channel-dispatched turns before draining", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-${suffix}`;
    const channel = `@fixture/channel-${suffix}`;
    type Dispatch = (
      request: Readonly<Record<string, unknown>>,
      reply: { emit(event: unknown): Promise<void> },
    ) => Promise<{ status: string; text?: string }>;
    let dispatch: Dispatch | undefined;
    const project = await fixture([
      {
        name: runtime,
        kind: "runtime",
        controller: { create: () => runtimeInstance(async () => completed("channel reply")) },
      },
      {
        name: channel,
        kind: "channel",
        controller: {
          create(context) {
            dispatch = (context as { host: { dispatch: Dispatch } }).host.dispatch;
            return {
              capabilities: {
                attachments: false,
                liveInput: false,
                askUser: false,
                proactive: false,
                runtimeControl: false,
                verbatim: false,
              },
            };
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: { inbound: { $use: channel } },
    }));
    const host = await createAgentHost(project.configPath);
    if (dispatch === undefined) throw new Error("channel dispatch was not installed");
    const response = await dispatch({
      requestId: "request-1",
      conversationId: "channel-conversation",
      sender: { id: "test" },
      text: "hello",
      attachments: [],
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    }, { async emit() {} });

    expect(response).toMatchObject({ status: "completed", text: "channel reply" });
    await expect(host.health()).resolves.toMatchObject({ pending: 0, active: 0 });
    await expect(host.drain()).resolves.toBeUndefined();
    await host.stop();
  });

  it("starts runtimes then channels deterministically and drains/stops in reverse", async () => {
    const events: string[] = [];
    const suffix = randomUUID().toLowerCase();
    const names = {
      runtimeA: `@fixture/runtime-a-${suffix}`,
      runtimeB: `@fixture/runtime-b-${suffix}`,
      channelA: `@fixture/channel-a-${suffix}`,
      channelB: `@fixture/channel-b-${suffix}`,
    };
    const project = await fixture([
      { name: names.runtimeA, kind: "runtime", controller: lifecycleRuntime("runtime:a", events) },
      { name: names.runtimeB, kind: "runtime", controller: lifecycleRuntime("runtime:b", events) },
      { name: names.channelA, kind: "channel", controller: lifecycleChannel("channel:a", events) },
      { name: names.channelB, kind: "channel", controller: lifecycleChannel("channel:b", events) },
    ]);
    const config = minimalConfig(names.runtimeA, {
      runtimes: {
        z: { $use: names.runtimeB },
        a: { $use: names.runtimeA },
      },
      routing: { primary: { runtime: "a", model: "fixture:model" }, fallbacks: [] },
      channels: {
        z: { $use: names.channelB },
        a: { $use: names.channelA },
      },
    });
    await project.writeConfig(config);
    const host = await createAgentHost(project.configPath);
    expect(events).toEqual([
      "create:runtime:a",
      "start:runtime:a",
      "create:runtime:b",
      "start:runtime:b",
      "create:channel:a",
      "start:channel:a",
      "create:channel:b",
      "start:channel:b",
    ]);
    expect(host.startInfo.channels.map((entry) => entry.instanceId)).toEqual(["a", "z"]);
    await host.start();
    await host.stop();
    await host.stop();
    expect(events.slice(8)).toEqual([
      "drain:channel:b",
      "drain:channel:a",
      "drain:runtime:b",
      "drain:runtime:a",
      "stop:channel:b",
      "stop:channel:a",
      "stop:runtime:b",
      "stop:runtime:a",
    ]);
  });

  it("reverse-unwinds every created instance when startup fails", async () => {
    const events: string[] = [];
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-${suffix}`;
    const channelA = `@fixture/channel-a-${suffix}`;
    const channelB = `@fixture/channel-b-${suffix}`;
    const failing = lifecycleChannel("channel:b", events);
    const originalCreate = failing.create;
    failing.create = async (context) => {
      const instance = await originalCreate(context) as Record<string, unknown>;
      instance.start = () => {
        events.push("start:channel:b");
        throw new Error("fixture startup failed");
      };
      return instance;
    };
    const project = await fixture([
      { name: runtime, kind: "runtime", controller: lifecycleRuntime("runtime", events) },
      { name: channelA, kind: "channel", controller: lifecycleChannel("channel:a", events) },
      { name: channelB, kind: "channel", controller: failing },
    ]);
    const config = minimalConfig(runtime, {
      channels: { a: { $use: channelA }, b: { $use: channelB } },
    });
    await project.writeConfig(config);
    await expect(createAgentHost(project.configPath)).rejects.toThrow(/startup failed/u);
    expect(events).toEqual([
      "create:runtime",
      "start:runtime",
      "create:channel:a",
      "start:channel:a",
      "create:channel:b",
      "start:channel:b",
      "stop:channel:b",
      "stop:channel:a",
      "stop:runtime",
    ]);
  });

  it("redacts resolved environment values from module startup failures", async () => {
    const secret = "startup-echo-secret-value";
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            "x-mono-agent-env-eligible": true,
            "x-mono-agent-secret": true,
          },
        },
        required: ["apiKey"],
        additionalProperties: false,
      },
      controller: {
        create(context) {
          const config = isRecord(context) ? context.config : undefined;
          const apiKey = isRecord(config) ? config.apiKey : undefined;
          throw new Error(`startup rejected ${String(apiKey)}`);
        },
      },
    }]);
    const config = minimalConfig(runtime);
    (config.runtimes as Record<string, unknown>).main = {
      $use: runtime,
      apiKey: { $env: "FIXTURE_API_KEY" },
    };
    await project.writeConfig(config);

    let message = "";
    try {
      await createAgentHost(project.configPath, { environment: { FIXTURE_API_KEY: secret } });
      throw new Error("expected startup to fail");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
  });

  it("reports bounded module health without starting work during inspection", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async () => completed("ok"), {
            health: () => ({ status: "degraded", checkedAt: new Date().toISOString(), summary: "fixture" }),
          });
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    const health = await host.health();
    expect(health.status).toBe("degraded");
    expect(health.modules[0]?.status).toBe("degraded");
    await host.stop();
    expect((await host.health()).status).toBe("stopped");
  });

  it("passes the loaded config directory to module creation", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    let configDirectory: string | undefined;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create(context) {
          configDirectory = isRecord(context) && typeof context.configDirectory === "string"
            ? context.configDirectory
            : undefined;
          return runtimeInstance(async () => completed("ok"));
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));

    const host = await createAgentHost(project.configPath);
    expect(configDirectory).toBe(project.root);
    await host.stop();
  });

  it("bounds a module create that ignores abort and reverse-unwinds prior modules", async () => {
    const events: string[] = [];
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-${suffix}`;
    const channel = `@fixture/channel-${suffix}`;
    const project = await fixture([
      { name: runtime, kind: "runtime", controller: lifecycleRuntime("runtime", events) },
      {
        name: channel,
        kind: "channel",
        controller: {
          create() {
            events.push("create:channel");
            return new Promise<never>(() => {});
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: { inbound: { $use: channel } },
    }));

    await expect(settleWithin(
      createAgentHost(project.configPath, { lifecycleTimeoutMs: 20 }),
      500,
    )).rejects.toThrow(/inbound create timed out after 20ms/u);
    expect(events).toEqual([
      "create:runtime",
      "start:runtime",
      "create:channel",
      "stop:runtime",
    ]);
  });

  it("bounds late-rejecting start hooks and consumes their eventual rejection", async () => {
    const events: string[] = [];
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async () => completed("ok"), {
            start() {
              events.push("start");
              return new Promise<void>((_resolve, reject) => {
                setTimeout(() => reject(new Error("late startup rejection")), 60);
              });
            },
            stop() {
              events.push("stop");
            },
          });
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));

    await expect(settleWithin(
      createAgentHost(project.configPath, { lifecycleTimeoutMs: 20 }),
      500,
    )).rejects.toThrow(/main start timed out after 20ms/u);
    expect(events).toEqual(["start", "stop"]);
    await delay(80);
  });

  it("bounds health, drain, and stop hooks that ignore abort", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const never = (): Promise<never> => new Promise(() => {});
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async () => completed("ok"), {
            health: never,
            drain: never,
            stop: never,
          });
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath, { lifecycleTimeoutMs: 20 });

    await expect(settleWithin(host.health(), 500)).resolves.toMatchObject({
      status: "degraded",
      modules: [{ instanceId: "main", status: "unhealthy" }],
    });
    await expect(settleWithin(host.drain(), 500)).rejects.toThrow(/Agent host drain failed/u);
    await expect(settleWithin(host.stop(), 500)).rejects.toThrow(/Agent host stopped with lifecycle errors/u);
    await expect(host.health()).resolves.toMatchObject({ status: "stopped", accepting: false });
  });

  it("bounds MCP close during stop when the client ignores shutdown", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: { create: () => runtimeInstance(async () => completed("ok")) },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    mcpMocks.close = () => new Promise<never>(() => {});
    const host = await createAgentHost(project.configPath, { lifecycleTimeoutMs: 20 });

    let stopError: unknown;
    try {
      await settleWithin(host.stop(), 500);
    } catch (error) {
      stopError = error;
    }
    expect(stopError).toBeInstanceOf(AggregateError);
    expect((stopError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "MCP close timed out after 20ms" }),
    ]);
    await expect(host.health()).resolves.toMatchObject({ status: "stopped", accepting: false });
  });

  it("bounds MCP close while unwinding a failed startup", async () => {
    const events: string[] = [];
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-${suffix}`;
    const channel = `@fixture/channel-${suffix}`;
    const project = await fixture([
      { name: runtime, kind: "runtime", controller: lifecycleRuntime("runtime", events) },
      {
        name: channel,
        kind: "channel",
        controller: {
          create() {
            throw new Error("channel startup failed");
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: { inbound: { $use: channel } },
    }));
    mcpMocks.close = () => new Promise<never>(() => {});

    await expect(settleWithin(
      createAgentHost(project.configPath, { lifecycleTimeoutMs: 20 }),
      500,
    )).rejects.toThrow(/channel startup failed/u);
    expect(events).toEqual(["create:runtime", "start:runtime", "stop:runtime"]);
  });

  it("does not settle a late runtime result after the drain deadline", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    let markStarted!: () => void;
    let releaseTurn!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const gate = new Promise<void>((resolveGate) => {
      releaseTurn = resolveGate;
    });
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async () => {
            markStarted();
            await gate;
            return completed("must not settle");
          });
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath, {
      drainTimeoutMs: 20,
      lifecycleTimeoutMs: 20,
    });
    const turn = host.submit({ conversationId: "late", text: "wait" });
    const turnOutcome = turn.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await started;

    let drainError: unknown;
    try {
      await settleWithin(host.drain(), 500);
    } catch (error) {
      drainError = error;
    }
    expect(drainError).toMatchObject({ message: "Agent host drain failed" });
    expect(drainError).toBeInstanceOf(AggregateError);
    expect((drainError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "Agent drain timed out after 20ms" }),
    ]);
    await expect(settleWithin(host.stop(), 500)).resolves.toBeUndefined();
    releaseTurn();

    const outcome = await settleWithin(turnOutcome, 500);
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.error).toMatchObject({ name: "AbortError" });
    await expect(host.health()).resolves.toMatchObject({ status: "stopped", pending: 0, active: 0 });
  });

  it("removes all executable tools under deny approval and requires mediation for ask", async () => {
    const observedTools: string[][] = [];
    let turns = 0;
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return {
            capabilities: {
              tools: true,
              mcp: true,
              attachments: false,
              approvals: false,
              structuredOutput: false,
              sandbox: false,
              sessions: false,
            },
            runTurn(request: unknown) {
              turns += 1;
              const tools = isRecord(request) && Array.isArray(request.tools) ? request.tools : [];
              observedTools.push(tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []));
              return completed("ok");
            },
          };
        },
      },
    }]);
    const serverPath = join(project.root, "policy-mcp-server.mjs");
    await writeFile(serverPath, POLICY_MCP_SERVER_SOURCE);
    await project.writeMcp({
      mcpServers: {
        policy: { type: "stdio", command: process.execPath, args: ["./policy-mcp-server.mjs"] },
      },
    });
    const policy = (approvals: "deny" | "ask") => ({
      tools: { default: "allow" as const, deny: [] },
      approvals: { default: approvals },
      sandbox: { mode: "off" as const },
    });

    await project.writeConfig(minimalConfig(runtime, {
      context: { mcp: { configPath: "./.mcp.json" } },
      policy: policy("deny"),
    }));
    const denied = await createAgentHost(project.configPath);
    await expect(denied.submit({ conversationId: "deny", text: "go" })).resolves.toMatchObject({ text: "ok" });
    expect(observedTools).toEqual([[]]);
    await denied.stop();

    await project.writeConfig(minimalConfig(runtime, {
      context: { mcp: { configPath: "./.mcp.json" } },
      policy: policy("ask"),
    }));
    const ask = await createAgentHost(project.configPath);
    let askError: unknown;
    try {
      await ask.submit({ conversationId: "ask", text: "go" });
    } catch (error) {
      askError = error;
    }
    expect(askError).toMatchObject({ message: "Every eligible runtime route failed for conversation ask" });
    expect(askError).toBeInstanceOf(AggregateError);
    expect((askError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/approvals unsupported/u) }),
    ]);
    expect(turns).toBe(1);
    await ask.stop();
  });
});

describe("turn admission and routing", () => {
  it("serializes each conversation while allowing bounded cross-conversation concurrency", async () => {
    const events: string[] = [];
    let active = 0;
    let maximum = 0;
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async (request) => {
            const text = requestText(request);
            events.push(`start:${text}`);
            active += 1;
            maximum = Math.max(maximum, active);
            await delay(35);
            active -= 1;
            events.push(`end:${text}`);
            return completed(text);
          });
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath, { maxConcurrentTurns: 2, maxPendingTurns: 3 });
    const results = await Promise.all([
      host.submit({ conversationId: "a", text: "a1" }),
      host.submit({ conversationId: "a", text: "a2" }),
      host.submit({ conversationId: "b", text: "b1" }),
    ]);
    expect(results.map((entry) => entry.text)).toEqual(["a1", "a2", "b1"]);
    expect(maximum).toBe(2);
    expect(events.indexOf("start:a2")).toBeGreaterThan(events.indexOf("end:a1"));
    await expect(host.submit({ conversationId: "", text: "bad" })).rejects.toThrow(/conversationId/u);
    await host.stop();
  });

  it("aborts a queued turn without disturbing the running turn", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async (request) => {
            await delay(requestText(request) === "first" ? 60 : 1);
            return completed(requestText(request));
          });
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath, { maxConcurrentTurns: 1, maxPendingTurns: 2 });
    const first = host.submit({ conversationId: "same", text: "first" });
    const controller = new AbortController();
    const second = host.submit({ conversationId: "same", text: "second", signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await expect(first).resolves.toMatchObject({ text: "first" });
    await host.stop();
  });

  it("uses ordered fallback and does not fallback after a committed effect", async () => {
    const suffix = randomUUID().toLowerCase();
    const primary = `@fixture/runtime-primary-${suffix}`;
    const fallback = `@fixture/runtime-fallback-${suffix}`;
    let primaryCommitted = false;
    let fallbackCalls = 0;
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: {
          create() {
            return runtimeInstance(async () => {
              const error = Object.assign(new Error("primary failed"), {
                retryable: true,
                ...(primaryCommitted ? { committedSideEffects: true } : {}),
              });
              throw error;
            });
          },
        },
      },
      {
        name: fallback,
        kind: "runtime",
        controller: {
          create() {
            return runtimeInstance(async () => {
              fallbackCalls += 1;
              return completed("fallback");
            });
          },
        },
      },
    ]);
    const config = minimalConfig(primary, {
      runtimes: { primary: { $use: primary }, fallback: { $use: fallback } },
      routing: {
        primary: { runtime: "primary", model: "fixture:primary" },
        fallbacks: [{ runtime: "fallback", model: "fixture:fallback" }],
      },
    });
    await project.writeConfig(config);
    const host = await createAgentHost(project.configPath);
    await expect(host.submit({ conversationId: "one", text: "go" })).resolves.toMatchObject({
      runtime: "fallback",
      model: "fixture:fallback",
      text: "fallback",
    });
    expect(fallbackCalls).toBe(1);
    primaryCommitted = true;
    await expect(host.submit({ conversationId: "two", text: "go" })).rejects.toThrow(/Every eligible runtime route failed/u);
    expect(fallbackCalls).toBe(1);
    await host.stop();
  });

  it("uses exact model capabilities for route eligibility", async () => {
    const runtime = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    let turns = 0;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return {
            ...runtimeInstance(async () => {
              turns += 1;
              return completed("unexpected");
            }),
            validateModel() {
              return {
                supported: true,
                capabilities: {
                  tools: true,
                  mcp: true,
                  attachments: false,
                  approvals: true,
                  structuredOutput: false,
                  sandbox: true,
                  sessions: false,
                },
              };
            },
          };
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);

    await expect(host.submit({
      conversationId: "capabilities",
      text: "image required",
      requiredCapabilities: ["attachments"],
    })).rejects.toThrow(/Every eligible runtime route failed/u);
    expect(turns).toBe(0);
    await host.stop();
  });
});

function lifecycleRuntime(label: string, events: string[]): FixtureController {
  return {
    create() {
      events.push(`create:${label}`);
      return runtimeInstance(async () => completed("ok"), lifecycle(label, events));
    },
  };
}

function lifecycleChannel(label: string, events: string[]): FixtureController {
  return {
    create() {
      events.push(`create:${label}`);
      return {
        capabilities: {
          attachments: false,
          liveInput: false,
          askUser: false,
          proactive: false,
          runtimeControl: false,
          verbatim: false,
        },
        ...lifecycle(label, events),
      };
    },
  };
}

function lifecycle(label: string, events: string[]) {
  return {
    start() { events.push(`start:${label}`); },
    drain() { events.push(`drain:${label}`); },
    stop() { events.push(`stop:${label}`); },
  };
}

function runtimeInstance(
  runTurn: (request: unknown, context: unknown) => unknown | Promise<unknown>,
  lifecycleMethods: Record<string, unknown> = {},
) {
  return {
    capabilities: {
      tools: true,
      mcp: true,
      attachments: true,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
    },
    runTurn,
    ...lifecycleMethods,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.messages)) return "";
  const last = value.messages.at(-1);
  if (!isRecord(last) || !Array.isArray(last.content)) return "";
  const text = last.content.find((entry) => isRecord(entry) && entry.type === "text");
  return isRecord(text) && typeof text.text === "string" ? text.text : "";
}

async function fixture(options: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await createFixtureProject(options);
  projects.push(project);
  return project;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`operation did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const POLICY_MCP_SERVER_SOURCE = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "policy-probe", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? {
            tools: [{
              name: "dangerous_tool",
              description: "Must be removed when approvals default to deny.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            }],
          }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeTurnError } from "@mono-agent/module-sdk";

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
  vi.useRealTimers();
  mcpMocks.close = undefined;
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("agent host lifecycle", () => {
  it("rejects created instances that do not satisfy their selected slot contract", async () => {
    const cases = [
      {
        kind: "runtime" as const,
        instance: {
          capabilities: {
            tools: true,
            mcp: true,
            attachments: true,
            approvals: true,
            structuredOutput: true,
            sandbox: true,
            sessions: true,
          },
        },
        expected: /runtime instance runTurn must be a function/u,
      },
      {
        kind: "channel" as const,
        instance: {
          capabilities: {
            attachments: false,
            liveInput: false,
            askUser: false,
            proactive: true,
            runtimeControl: false,
            verbatim: false,
            cancellation: false,
          },
        },
        expected: /proactive channel instance deliver must be a function/u,
      },
      {
        kind: "memory" as const,
        instance: { capabilities: { capture: false, forget: false } },
        expected: /memory instance recall must be a function/u,
      },
      { kind: "state" as const, instance: {}, expected: /state instance read must be a function/u },
      {
        kind: "exporter" as const,
        instance: { async export() { return { accepted: 0, rejected: 0 }; } },
        expected: /exporter instance flush must be a function/u,
      },
      { kind: "sandbox" as const, instance: {}, expected: /invalid sandbox instance/u },
      { kind: "trigger" as const, instance: { start: true }, expected: /trigger instance start must be a function/u },
    ];

    for (const testCase of cases) {
      const suffix = randomUUID().toLowerCase();
      const runtime = testCase.kind === "runtime"
        ? `@fixture/runtime-${suffix}`
        : `@fixture/runtime-valid-${suffix}`;
      const selected = testCase.kind === "runtime" ? runtime : `@fixture/${testCase.kind}-${suffix}`;
      const project = await fixture([
        {
          name: runtime,
          kind: "runtime",
          controller: testCase.kind === "runtime"
            ? { create: () => testCase.instance }
            : { create: () => runtimeInstance(async () => completed("unused")) },
        },
        ...(testCase.kind === "runtime" ? [] : [{
          name: selected,
          kind: testCase.kind,
          controller: { create: () => testCase.instance },
        }]),
      ]);
      const override = testCase.kind === "channel"
        ? { channels: { selected: { $use: selected } } }
        : testCase.kind === "memory"
          ? { memory: { $use: selected } }
          : testCase.kind === "state"
            ? { state: { $use: selected } }
            : testCase.kind === "exporter"
              ? { observability: { exporters: { selected: { $use: selected } } } }
              : testCase.kind === "sandbox"
                ? { policy: {
                    tools: { default: "deny", allow: [] },
                    approvals: { default: "allow" },
                    sandbox: { $use: selected },
                  } }
                : testCase.kind === "trigger"
                  ? { triggers: { selected: { $use: selected } } }
                  : {};
      await project.writeConfig(minimalConfig(runtime, override));
      await expect(createAgentHost(project.configPath)).rejects.toThrow(testCase.expected);
    }
  });

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
                cancellation: false,
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

  it("discovers indexed skills and exposes their bounded bodies through the reserved ReadSkill tool", async () => {
    const runtime = `@fixture/runtime-skills-${randomUUID().toLowerCase()}`;
    let systemText = "";
    let toolNames: string[] = [];
    let skillResult = "";
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request, context) => {
          if (isRecord(request) && Array.isArray(request.messages)) {
            systemText = JSON.stringify(request.messages[0]);
          }
          toolNames = isRecord(request) && Array.isArray(request.tools)
            ? request.tools.flatMap((tool) => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])
            : [];
          if (!isRecord(context) || typeof context.executeTool !== "function") throw new Error("ReadSkill bridge missing");
          skillResult = JSON.stringify(await context.executeTool(
            { id: "read-skill", name: "ReadSkill", input: { name: "focused-review" } },
            new AbortController().signal,
          ));
          return completed("ok");
        }),
      },
    }]);
    const skillDirectory = join(project.root, "skills", "focused-review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), [
      "---",
      "name: focused-review",
      "description: Review only the requested public boundary.",
      "---",
      "# Focused review",
      "",
    ].join("\n"));
    await project.writeConfig(minimalConfig(runtime, {
      context: {
        skills: {
          roots: ["./skills"],
          load: "all",
          disclosure: "index",
          maxBytes: 4_096,
        },
      },
    }));
    const host = await createAgentHost(project.configPath);

    await host.submit({ conversationId: "skills", text: "go" });
    expect(systemText).toContain("Configured skill index");
    expect(systemText).toContain("focused-review");
    expect(systemText).toContain("Review only the requested public boundary.");
    expect(systemText).toContain("ReadSkill");
    expect(systemText).not.toContain(project.root);
    expect(toolNames).toContain("ReadSkill");
    expect(skillResult).toContain("# Focused review");
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
  it("expires idle sessions and never retains provider sessions for isolated proactive runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00.000Z"));
    const runtime = `@fixture/runtime-session-${randomUUID().toLowerCase()}`;
    const observedSessions: unknown[] = [];
    let sequence = 0;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request) => {
          observedSessions.push(isRecord(request) ? request.session : undefined);
          sequence += 1;
          return { ...(completed(`answer-${sequence}`) as Record<string, unknown>), session: { id: `session-${sequence}` } };
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime, {
      session: {
        mode: "continuous",
        idleTimeoutMs: 1_000,
        rollover: "none",
        isolateProactiveRuns: true,
      },
    }));
    const host = await createAgentHost(project.configPath);

    await host.submit({ conversationId: "normal", text: "one" });
    vi.setSystemTime(new Date("2026-07-22T10:00:00.500Z"));
    await host.submit({ conversationId: "normal", text: "two" });
    vi.setSystemTime(new Date("2026-07-22T10:00:02.000Z"));
    await host.submit({ conversationId: "normal", text: "three" });
    await host.submit({ conversationId: "trigger:cron:event", text: "proactive-one" });
    await host.submit({ conversationId: "trigger:cron:event", text: "proactive-two" });

    expect(observedSessions).toEqual([
      undefined,
      { id: "session-1" },
      undefined,
      undefined,
      undefined,
    ]);
    await host.stop();
  });

  it("rolls continuous sessions at the configured timezone day boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T23:59:59.000Z"));
    const runtime = `@fixture/runtime-daily-session-${randomUUID().toLowerCase()}`;
    const observedSessions: unknown[] = [];
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request) => {
          observedSessions.push(isRecord(request) ? request.session : undefined);
          return { ...(completed("ok") as Record<string, unknown>), session: { id: "daily-session" } };
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime, {
      session: {
        mode: "continuous",
        rollover: "daily",
        timezone: "UTC",
        isolateProactiveRuns: false,
      },
    }));
    const host = await createAgentHost(project.configPath);

    await host.submit({ conversationId: "daily", text: "one" });
    vi.setSystemTime(new Date("2026-07-23T00:00:01.000Z"));
    await host.submit({ conversationId: "daily", text: "two" });

    expect(observedSessions).toEqual([undefined, undefined]);
    await host.stop();
  });

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
              const error = new RuntimeTurnError({
                code: "fixture_primary_failed",
                message: "primary failed",
                retryability: "retryable",
                sideEffects: primaryCommitted ? "committed" : "none",
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

  it("fails closed instead of falling back when a runtime omits settlement metadata", async () => {
    const suffix = randomUUID().toLowerCase();
    const primary = `@fixture/runtime-unknown-${suffix}`;
    const fallback = `@fixture/runtime-unused-${suffix}`;
    let fallbackCalls = 0;
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: { create: () => runtimeInstance(async () => { throw new Error("untyped failure"); }) },
      },
      {
        name: fallback,
        kind: "runtime",
        controller: { create: () => runtimeInstance(async () => { fallbackCalls += 1; return completed("unsafe"); }) },
      },
    ]);
    await project.writeConfig(minimalConfig(primary, {
      runtimes: { primary: { $use: primary }, fallback: { $use: fallback } },
      routing: {
        primary: { runtime: "primary", model: "fixture:primary" },
        fallbacks: [{ runtime: "fallback", model: "fixture:fallback" }],
      },
    }));
    const host = await createAgentHost(project.configPath);
    await expect(host.submit({ conversationId: "unknown", text: "go" })).rejects.toThrow(
      /Every eligible runtime route failed/u,
    );
    expect(fallbackCalls).toBe(0);
    await host.stop();
  });

  it("rejects malformed runtime result metadata before it can enter durable state", async () => {
    const runtime = `@fixture/runtime-invalid-result-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async () => ({
          ...(completed("must not settle") as Record<string, unknown>),
          session: { id: "" },
          usage: { inputTokens: -1, outputTokens: 1 },
        })),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);

    await expect(host.submit({ conversationId: "invalid-result", text: "go" })).rejects.toThrow(
      /Every eligible runtime route failed/u,
    );
    expect((await host.replay("invalid-result")).messages).toEqual([]);
    await host.stop();
  });

  it("never falls back after the host observes output from an attempt", async () => {
    const suffix = randomUUID().toLowerCase();
    const primary = `@fixture/runtime-observed-${suffix}`;
    const fallback = `@fixture/runtime-observed-fallback-${suffix}`;
    let fallbackCalls = 0;
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async (_request, context) => {
            await (context as { emit(event: unknown): Promise<void> }).emit({ type: "text-delta", delta: "partial" });
            throw new RuntimeTurnError({
              code: "fixture_retryable_after_output",
              message: "retryable after output",
              retryability: "retryable",
              sideEffects: "none",
            });
          }),
        },
      },
      {
        name: fallback,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async () => {
            fallbackCalls += 1;
            return completed("must not run");
          }),
        },
      },
    ]);
    await project.writeConfig(minimalConfig(primary, {
      runtimes: { primary: { $use: primary }, fallback: { $use: fallback } },
      routing: {
        primary: { runtime: "primary", model: "fixture:primary" },
        fallbacks: [{ runtime: "fallback", model: "fixture:fallback" }],
      },
    }));
    const host = await createAgentHost(project.configPath);

    await expect(host.submit({ conversationId: "observed", text: "go" })).rejects.toThrow(
      /Every eligible runtime route failed/u,
    );
    expect(fallbackCalls).toBe(0);
    await host.stop();
  });

  it("does not fallback or publish staged history and sessions when persistence fails", async () => {
    const suffix = randomUUID().toLowerCase();
    const primary = `@fixture/runtime-transaction-${suffix}`;
    const fallback = `@fixture/runtime-transaction-fallback-${suffix}`;
    const stateName = `@fixture/state-transaction-${suffix}`;
    let failWrites = false;
    let calls = 0;
    let fallbackCalls = 0;
    const observedSessions: unknown[] = [];
    const state = stateFixtureController(() => failWrites);
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async (request) => {
            observedSessions.push(isRecord(request) ? request.session : undefined);
            calls += 1;
            return {
              ...(completed(`answer-${calls}`) as Record<string, unknown>),
              session: { id: `session-${calls}` },
            };
          }),
        },
      },
      {
        name: fallback,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async () => {
            fallbackCalls += 1;
            return completed("unsafe fallback");
          }),
        },
      },
      { name: stateName, kind: "state", controller: state.controller },
    ]);
    await project.writeConfig(minimalConfig(primary, {
      runtimes: { primary: { $use: primary }, fallback: { $use: fallback } },
      routing: {
        primary: { runtime: "primary", model: "fixture:primary" },
        fallbacks: [{ runtime: "fallback", model: "fixture:fallback" }],
      },
      state: { $use: stateName },
      session: { mode: "continuous" },
    }));
    const host = await createAgentHost(project.configPath);

    await host.submit({ conversationId: "transaction", text: "one" });
    const before = await host.replay("transaction");
    failWrites = true;
    await expect(host.submit({ conversationId: "transaction", text: "two" })).rejects.toThrow(
      /Every eligible runtime route failed/u,
    );
    expect(fallbackCalls).toBe(0);
    expect(await host.replay("transaction")).toEqual(before);

    failWrites = false;
    await host.submit({ conversationId: "transaction", text: "three" });
    expect(observedSessions).toEqual([
      undefined,
      { id: "session-1" },
      { id: "session-1" },
    ]);
    expect((await host.replay("transaction")).messages).toHaveLength(4);
    await host.stop();
  });

  it("persists attachment transcripts above the state record limit as restart-safe chunks", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-chunked-${suffix}`;
    const stateName = `@fixture/state-chunked-${suffix}`;
    const state = stateFixtureController();
    const project = await fixture([
      {
        name: runtime,
        kind: "runtime",
        controller: { create: () => runtimeInstance(async () => completed("stored")) },
      },
      { name: stateName, kind: "state", controller: state.controller },
    ]);
    await project.writeConfig(minimalConfig(runtime, { state: { $use: stateName } }));
    const payloads = [new Uint8Array(randomBytes(700_000)), new Uint8Array(randomBytes(700_000))];
    const first = await createAgentHost(project.configPath);

    for (const [index, data] of payloads.entries()) {
      await first.submit({
        conversationId: "chunked",
        text: `attachment-${index}`,
        attachments: [{
          id: `attachment-${index}`,
          kind: "file",
          name: `attachment-${index}.bin`,
          mediaType: "application/octet-stream",
          sizeBytes: data.byteLength,
          data,
        }],
      });
    }
    const conversationRecord = [...state.records.entries()]
      .find(([key]) => key.startsWith("core/conversations/"))?.[1];
    expect(conversationRecord).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(conversationRecord?.value)) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      kind: "mono-agent.conversation-chunks.v1",
      conversationId: "chunked",
      encoding: "gzip-json",
    });
    const chunks = [...state.records.entries()].filter(([key]) => key.startsWith("core/conversation-chunks/"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(([, record]) => record.value.byteLength <= 256 * 1024)).toBe(true);
    await first.stop();

    const second = await createAgentHost(project.configPath);
    const replay = await second.replay("chunked");
    expect(replay.messages).toHaveLength(4);
    const replayed = replay.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.find((part) => part.type === "attachment"))
      .map((part) => part?.type === "attachment" ? part.attachment.data : undefined);
    expect(replayed).toHaveLength(2);
    for (const [index, data] of payloads.entries()) {
      expect(replayed[index]?.byteLength).toBe(data.byteLength);
      expect(Buffer.compare(Buffer.from(replayed[index] ?? []), Buffer.from(data))).toBe(0);
    }
    await second.stop();
  });

  it("detaches runtime results, request attachments, and replay byte graphs", async () => {
    const runtime = `@fixture/runtime-boundary-${randomUUID().toLowerCase()}`;
    const runtimeResult = {
      status: "completed" as const,
      message: {
        role: "assistant" as const,
        content: [{ type: "file" as const, mediaType: "application/octet-stream", data: new Uint8Array([3]), name: "answer.bin" }],
      },
    };
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request) => {
          if (isRecord(request) && Array.isArray(request.messages)) {
            const user = request.messages.at(-1);
            if (isRecord(user) && Array.isArray(user.content)) {
              const attachment = user.content.find((part) => isRecord(part) && part.type === "attachment");
              if (isRecord(attachment) && isRecord(attachment.attachment)
                && attachment.attachment.data instanceof Uint8Array) {
                attachment.attachment.data[0] = 99;
              }
            }
          }
          return runtimeResult;
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    const response = await host.submit({
      conversationId: "immutable",
      text: "with attachment",
      attachments: [{
        id: "input-1",
        kind: "file",
        name: "input.bin",
        mediaType: "application/octet-stream",
        sizeBytes: 1,
        data: new Uint8Array([7]),
      }],
    });

    runtimeResult.message.content[0]!.data[0] = 55;
    const output = response.output as typeof runtimeResult;
    output.message.content[0]!.data[0] = 44;
    const firstReplay = await host.replay("immutable");
    const userPart = firstReplay.messages[0]!.content[1];
    const assistantPart = firstReplay.messages[1]!.content[0];
    expect(userPart?.type === "attachment" ? [...userPart.attachment.data] : []).toEqual([7]);
    expect(assistantPart?.type === "file" && assistantPart.data instanceof Uint8Array ? [...assistantPart.data] : []).toEqual([3]);
    if (assistantPart?.type === "file" && assistantPart.data instanceof Uint8Array) assistantPart.data[0] = 88;
    const secondReplay = await host.replay("immutable");
    const secondAssistant = secondReplay.messages[1]!.content[0];
    expect(secondAssistant?.type === "file" && secondAssistant.data instanceof Uint8Array ? [...secondAssistant.data] : []).toEqual([3]);
    await host.stop();
  });

  it("binds live input to the exact active runtime attempt and unregisters it on settlement", async () => {
    const runtime = `@fixture/runtime-live-${randomUUID().toLowerCase()}`;
    let ready!: () => void;
    const registered = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (_request, context) => {
          let resolveSteering!: (text: string) => void;
          const steered = new Promise<string>((resolveInput) => { resolveSteering = resolveInput; });
          const register = (context as { registerLiveInput?: (handler: (input: { text: string }) => string) => () => void })
            .registerLiveInput;
          if (register === undefined) throw new Error("live input bridge missing");
          const unregister = register((input) => { resolveSteering(input.text); return "applied"; });
          ready();
          const text = await steered;
          unregister();
          return completed(text);
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    const turn = host.submit({ conversationId: "live", text: "start" });
    await registered;
    await expect(host.offerLiveInput("live", {
      id: "steer-1",
      text: "steered",
      receivedAt: new Date().toISOString(),
    })).resolves.toBe("applied");
    await expect(turn).resolves.toMatchObject({ text: "steered" });
    await expect(host.offerLiveInput("live", {
      id: "late",
      text: "late",
      receivedAt: new Date().toISOString(),
    })).resolves.toBe("unavailable");
    await host.stop();
  });

  it("bridges one bounded blocking AskUser interaction through a channel", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-ask-${suffix}`;
    const channel = `@fixture/channel-ask-${suffix}`;
    let dispatch!: (request: unknown, reply: unknown) => Promise<unknown>;
    const project = await fixture([
      {
        name: runtime,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async (request, context) => {
            const askUser = (context as {
              askUser?: (ask: unknown, signal: AbortSignal) => Promise<{ answers: Record<string, readonly string[]> }>;
            }).askUser;
            if (askUser === undefined || !isRecord(request) || !(request.signal instanceof AbortSignal)) {
              throw new Error("AskUser bridge missing");
            }
            const answer = await askUser({
              interactionId: "ask-1",
              requestedAt: new Date().toISOString(),
              questions: [{
                id: "tone",
                prompt: "Choose a tone",
                choices: [{ value: "concise", label: "Concise" }],
                allowFreeText: true,
                multiple: false,
              }],
            }, request.signal);
            return completed(answer.answers.tone?.[0] ?? "missing");
          }),
        },
      },
      {
        name: channel,
        kind: "channel",
        controller: {
          create(context) {
            const host = (context as { host: { dispatch(request: unknown, reply: unknown): Promise<unknown> } }).host;
            dispatch = (request, reply) => host.dispatch(request, reply);
            return {
              capabilities: {
                attachments: true,
                liveInput: true,
                askUser: true,
                proactive: false,
                runtimeControl: true,
                verbatim: false,
                cancellation: true,
              },
            };
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, { channels: { operator: { $use: channel } } }));
    const host = await createAgentHost(project.configPath);
    const events: unknown[] = [];
    const result = await dispatch({
      requestId: "request-1",
      conversationId: "ask",
      sender: { id: "operator" },
      text: "ask me",
      attachments: [],
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    }, {
      emit: async (event: unknown) => {
        events.push(event);
        if (isRecord(event) && event.type === "ask-user" && isRecord(event.ask)) {
          await expect(host.answerAsk("ask", {
            interactionId: String(event.ask.interactionId),
            answers: { tone: ["concise"] },
          })).resolves.toBe("accepted");
        }
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "ask-user" }));
    expect(result).toMatchObject({ status: "completed", text: "concise" });
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
          cancellation: false,
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

function stateFixtureController(shouldFailWrite: () => boolean = () => false): {
  readonly controller: FixtureController;
  readonly records: Map<string, { value: Uint8Array; version: string; updatedAt: string }>;
} {
  const records = new Map<string, { value: Uint8Array; version: string; updatedAt: string }>();
  let version = 0;
  const controller: FixtureController = {
    create() {
      return {
        async read(request: { key: string }) {
          const record = records.get(request.key);
          return record === undefined ? undefined : { key: request.key, ...record };
        },
        async write(request: { key: string; value: Uint8Array; expectedVersion?: string }) {
          if (request.value.byteLength > 1024 * 1024) throw new Error("fixture state record exceeds 1 MiB");
          if (shouldFailWrite()) {
            throw new RuntimeTurnError({
              code: "fixture_state_write_failed",
              message: "fixture state write failed",
              retryability: "retryable",
              sideEffects: "none",
            });
          }
          const current = records.get(request.key);
          if (request.expectedVersion !== undefined && current?.version !== request.expectedVersion) {
            throw new Error("fixture state CAS mismatch");
          }
          const result = { version: String(++version), updatedAt: new Date().toISOString() };
          records.set(request.key, { value: new Uint8Array(request.value), ...result });
          return result;
        },
        async compareAndSwap(request: { key: string; value: Uint8Array; expectedVersion: string | null }) {
          if (request.value.byteLength > 1024 * 1024) throw new Error("fixture state record exceeds 1 MiB");
          const current = records.get(request.key);
          const matches = request.expectedVersion === null
            ? current === undefined
            : current?.version === request.expectedVersion;
          if (!matches) return { status: "conflict", ...(current === undefined ? {} : { currentVersion: current.version }) };
          const result = { version: String(++version), updatedAt: new Date().toISOString() };
          const record = { key: request.key, value: new Uint8Array(request.value), ...result };
          records.set(request.key, { value: record.value, ...result });
          return { status: "applied", record };
        },
        async delete(request: { key: string }) { return records.delete(request.key); },
        async list(request: { prefix?: string }) {
          return {
            records: [...records.entries()]
              .filter(([key]) => request.prefix === undefined || key.startsWith(request.prefix))
              .map(([key, record]) => ({ key, ...record })),
          };
        },
        async upsertPresence(request: { presence: unknown }) { return request.presence; },
        async removePresence() { return false; },
        async listPresence() { return []; },
      };
    },
  };
  return { controller, records };
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

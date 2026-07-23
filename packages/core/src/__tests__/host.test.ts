import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeTurnError,
  type AgentInteractionHandler,
  type ApprovalDecision,
} from "@mono-agent/module-sdk";

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
            approvals: false,
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

  it("rejects hostile runtime capability authority without invoking accessors", async () => {
    const validCapabilities = () => ({
      tools: true,
      mcp: true,
      attachments: true,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
      liveInput: false,
    });
    const runtimeWith = (capabilities: unknown) => ({
      capabilities,
      async runTurn() {
        return completed("unused");
      },
    });
    const cases: readonly {
      readonly label: string;
      readonly create: () => {
        readonly instance: unknown;
        readonly accessorCalls?: () => number;
      };
      readonly expected: RegExp;
    }[] = [
      {
        label: "missing",
        create() {
          const capabilities = validCapabilities() as Partial<ReturnType<typeof validCapabilities>>;
          delete capabilities.tools;
          return { instance: runtimeWith(capabilities) };
        },
        expected: /runtime capabilities\.tools.*required/u,
      },
      {
        label: "extra",
        create() {
          const capabilities = validCapabilities();
          Object.defineProperty(capabilities, "unexpected", {
            enumerable: false,
            value: true,
          });
          return { instance: runtimeWith(capabilities) };
        },
        expected: /runtime capabilities.*unknown key/u,
      },
      {
        label: "prototype",
        create: () => ({
          instance: runtimeWith(Object.create(validCapabilities())),
        }),
        expected: /runtime capabilities.*plain object/u,
      },
      {
        label: "field-accessor",
        create() {
          let calls = 0;
          const capabilities = validCapabilities();
          Object.defineProperty(capabilities, "tools", {
            enumerable: true,
            get() {
              calls += 1;
              return true;
            },
          });
          return {
            instance: runtimeWith(capabilities),
            accessorCalls: () => calls,
          };
        },
        expected: /runtime capabilities\.tools.*data property/u,
      },
      {
        label: "optional-accessor",
        create() {
          let calls = 0;
          const capabilities = validCapabilities();
          Object.defineProperty(capabilities, "liveInput", {
            enumerable: true,
            get() {
              calls += 1;
              return true;
            },
          });
          return {
            instance: runtimeWith(capabilities),
            accessorCalls: () => calls,
          };
        },
        expected: /runtime capabilities\.liveInput.*data property/u,
      },
      {
        label: "instance-accessor",
        create() {
          let calls = 0;
          const instance = {
            async runTurn() {
              return completed("unused");
            },
          };
          Object.defineProperty(instance, "capabilities", {
            enumerable: true,
            get() {
              calls += 1;
              return validCapabilities();
            },
          });
          return {
            instance,
            accessorCalls: () => calls,
          };
        },
        expected: /runtime instance capabilities.*own data property/u,
      },
    ];

    for (const testCase of cases) {
      const runtime = `@fixture/runtime-authority-${testCase.label}-${randomUUID().toLowerCase()}`;
      const created = testCase.create();
      const project = await fixture([{
        name: runtime,
        kind: "runtime",
        controller: { create: () => created.instance },
      }]);
      await project.writeConfig(minimalConfig(runtime));

      await expect(createAgentHost(project.configPath)).rejects.toThrow(testCase.expected);
      if (created.accessorCalls !== undefined) {
        expect(created.accessorCalls(), testCase.label).toBe(0);
      }
    }
  });

  it("rejects hostile channel capability authority without invoking accessors", async () => {
    const validCapabilities = () => ({
      attachments: false,
      liveInput: false,
      askUser: false,
      approvals: false,
      proactive: false,
      runtimeControl: false,
      verbatim: false,
      cancellation: false,
    });
    const cases: readonly {
      readonly label: string;
      readonly create: () => {
        readonly instance: unknown;
        readonly accessorCalls?: () => number;
      };
      readonly expected: RegExp;
    }[] = [
      {
        label: "missing",
        create() {
          const capabilities = validCapabilities() as Partial<ReturnType<typeof validCapabilities>>;
          delete capabilities.askUser;
          return { instance: { capabilities } };
        },
        expected: /channel capabilities\.askUser.*required/u,
      },
      {
        label: "extra",
        create: () => ({
          instance: { capabilities: { ...validCapabilities(), unexpected: false } },
        }),
        expected: /channel capabilities.*unknown key/u,
      },
      {
        label: "non-boolean",
        create: () => ({
          instance: { capabilities: { ...validCapabilities(), approvals: "false" } },
        }),
        expected: /channel capabilities\.approvals.*boolean/u,
      },
      {
        label: "field-accessor",
        create() {
          let calls = 0;
          const capabilities = validCapabilities();
          Object.defineProperty(capabilities, "askUser", {
            enumerable: true,
            get() {
              calls += 1;
              return true;
            },
          });
          return {
            instance: { capabilities },
            accessorCalls: () => calls,
          };
        },
        expected: /channel capabilities\.askUser.*data property/u,
      },
      {
        label: "cyclic",
        create() {
          const capabilities = validCapabilities() as Record<string, unknown>;
          capabilities.askUser = capabilities;
          return { instance: { capabilities } };
        },
        expected: /channel capabilities\.askUser.*boolean/u,
      },
      {
        label: "instance-accessor",
        create() {
          let calls = 0;
          const instance = {};
          Object.defineProperty(instance, "capabilities", {
            enumerable: true,
            get() {
              calls += 1;
              return validCapabilities();
            },
          });
          return {
            instance,
            accessorCalls: () => calls,
          };
        },
        expected: /channel instance capabilities.*own data property/u,
      },
    ];

    for (const testCase of cases) {
      const suffix = randomUUID().toLowerCase();
      const runtime = `@fixture/runtime-channel-authority-${testCase.label}-${suffix}`;
      const channel = `@fixture/channel-authority-${testCase.label}-${suffix}`;
      const created = testCase.create();
      const project = await fixture([
        {
          name: runtime,
          kind: "runtime",
          controller: { create: () => runtimeInstance(async () => completed("unused")) },
        },
        {
          name: channel,
          kind: "channel",
          controller: { create: () => created.instance },
        },
      ]);
      await project.writeConfig(minimalConfig(runtime, {
        channels: { hostile: { $use: channel } },
      }));

      await expect(createAgentHost(project.configPath)).rejects.toThrow(testCase.expected);
      if (created.accessorCalls !== undefined) {
        expect(created.accessorCalls(), testCase.label).toBe(0);
      }
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
                approvals: false,
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

  it("does not redact unrelated ambient environment values from diagnostics", async () => {
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
              return new Promise<void>(() => {});
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
      createAgentHost(project.configPath, {
        environment: { GITHUB_REF_NAME: "main" },
        lifecycleTimeoutMs: 20,
      }),
      500,
    )).rejects.toThrow(/main start timed out after 20ms/u);
    expect(events).toEqual(["start", "stop"]);
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

    await host.submit({ requestId: "skills-1", conversationId: "skills", text: "go" });
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
    const turn = host.submit({ requestId: "late-1", conversationId: "late", text: "wait" });
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
    await expect(denied.submit({
      requestId: "deny-1",
      conversationId: "deny",
      text: "go",
    })).resolves.toMatchObject({ text: "ok" });
    expect(observedTools).toEqual([[]]);
    await denied.stop();

    await project.writeConfig(minimalConfig(runtime, {
      context: { mcp: { configPath: "./.mcp.json" } },
      policy: policy("ask"),
    }));
    const ask = await createAgentHost(project.configPath);
    let askError: unknown;
    try {
      await ask.submit({ requestId: "ask-approval-1", conversationId: "ask", text: "go" });
    } catch (error) {
      askError = error;
    }
    expect(askError).toMatchObject({ message: "Every eligible runtime route failed for conversation ask" });
    expect(askError).toBeInstanceOf(AggregateError);
    expect((askError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/approval interaction handler unavailable/u) }),
    ]);
    expect(turns).toBe(1);
    await ask.stop();
  });

  it("mediates each governed MCP call through a direct approval handler and fails malformed decisions closed", async () => {
    const runtime = `@fixture/runtime-approval-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          let call = 0;
          return runtimeInstance(async (request, context) => {
            const tools = isRecord(request) && Array.isArray(request.tools) ? request.tools : [];
            const tool = tools.find((entry) => isRecord(entry) && typeof entry.name === "string");
            if (!isRecord(tool) || typeof tool.name !== "string"
              || !isRecord(context) || typeof context.executeTool !== "function"
              || !isRecord(request) || !(request.signal instanceof AbortSignal)) {
              throw new Error("governed MCP fixture is unavailable");
            }
            call += 1;
            const result = await context.executeTool(
              { id: `approval-call-${call}`, name: tool.name, input: {} },
              request.signal,
            );
            return completed(JSON.stringify(result));
          });
        },
      },
    }]);
    const serverPath = join(project.root, "approval-mcp-server.mjs");
    const executionMarker = join(project.root, "approval-executions.log");
    await writeFile(serverPath, approvalMcpServerSource(executionMarker));
    await project.writeMcp({
      mcpServers: {
        approval: {
          type: "stdio",
          command: process.execPath,
          args: ["./approval-mcp-server.mjs"],
        },
      },
    });
    await project.writeConfig(minimalConfig(runtime, {
      context: { mcp: { configPath: "./.mcp.json" } },
      policy: {
        tools: { default: "deny", allow: ["dangerous_tool"] },
        approvals: { default: "ask", timeoutMs: 1_000 },
        sandbox: { mode: "off" },
      },
    }));
    const host = await createAgentHost(project.configPath);
    const approvalRequests: unknown[] = [];
    const handler = (decision: "allow_once" | "deny" | "malformed"): AgentInteractionHandler => ({
      async askUser() {
        throw new Error("AskUser is not expected");
      },
      async requestApproval(request, context) {
        approvalRequests.push({ request, context });
        if (decision === "malformed") {
          return {
            interactionId: request.interactionId,
            decision: "malformed",
            decidedAt: new Date().toISOString(),
          } as unknown as ApprovalDecision;
        }
        return {
          interactionId: request.interactionId,
          decision,
          decidedAt: new Date().toISOString(),
        };
      },
    });

    const allowed = await host.submit({
      requestId: "approval-allow",
      conversationId: "approval",
      text: "allow",
      interactionHandler: handler("allow_once"),
    });
    expect(allowed).toMatchObject({ status: "completed", text: expect.stringContaining("executed") });
    expect(await executionCount(executionMarker)).toBe(1);

    const denied = await host.submit({
      requestId: "approval-deny",
      conversationId: "approval",
      text: "deny",
      interactionHandler: handler("deny"),
    });
    expect(denied).toMatchObject({ status: "completed", text: expect.stringContaining("was denied") });
    expect(await executionCount(executionMarker)).toBe(1);

    const malformed = await host.submit({
      requestId: "approval-malformed",
      conversationId: "approval",
      text: "malformed",
      interactionHandler: handler("malformed"),
    });
    expect(malformed).toMatchObject({ status: "completed", text: expect.stringContaining("was denied") });
    expect(await executionCount(executionMarker)).toBe(1);
    expect(approvalRequests).toHaveLength(3);
    expect(approvalRequests).toEqual(approvalRequests.map(() => expect.objectContaining({
      request: expect.objectContaining({ toolId: "dangerous_tool" }),
      context: expect.objectContaining({
        conversationId: "approval",
        route: { runtimeInstanceId: "main", model: "fixture:model" },
        signal: expect.any(AbortSignal),
      }),
    })));
    await host.stop();
  });

  it("gates artifact-backed tool results on the immutable runtime capability snapshot", async () => {
    const observed = new Map<"legacy" | "capable", readonly string[]>();
    const mutableCapabilities = new Map<"legacy" | "capable", Record<string, boolean>>();
    const artifactWrites: Uint8Array[] = [];

    for (const mode of ["legacy", "capable"] as const) {
      const runtime = `@fixture/runtime-artifacts-${mode}-${randomUUID().toLowerCase()}`;
      const stateName = `@fixture/state-artifacts-${mode}-${randomUUID().toLowerCase()}`;
      const state = stateFixtureController(() => false, artifactWrites);
      const project = await fixture([
        {
          name: runtime,
          kind: "runtime",
          controller: {
            create() {
              const instance = runtimeInstance(async (request, context) => {
                if (!isRecord(request) || !Array.isArray(request.tools)
                  || !(request.signal instanceof AbortSignal)
                  || !isRecord(context) || typeof context.executeTool !== "function") {
                  throw new Error("artifact tool fixture context missing");
                }
                const tool = request.tools.find((candidate) =>
                  isRecord(candidate) && candidate.name === "large_tool");
                if (!isRecord(tool) || typeof tool.name !== "string") {
                  throw new Error("large tool missing");
                }
                const result = await context.executeTool({
                  id: `artifact-call-${mode}`,
                  name: tool.name,
                  input: {},
                }, request.signal);
                const content = isRecord(result) && Array.isArray(result.content)
                  ? result.content
                  : [];
                const types = content.flatMap((part) =>
                  isRecord(part) && typeof part.type === "string" ? [part.type] : []);
                observed.set(mode, types);
                return completed(types.join(","));
              });
              const capabilities = {
                ...instance.capabilities,
                ...(mode === "capable" ? { artifactResults: true } : {}),
              };
              mutableCapabilities.set(mode, capabilities);
              return {
                ...instance,
                capabilities,
              };
            },
          },
        },
        {
          name: stateName,
          kind: "state",
          controller: state.controller,
        },
      ]);
      const serverPath = join(project.root, "large-tool-mcp-server.mjs");
      await writeFile(serverPath, LARGE_TOOL_MCP_SERVER_SOURCE);
      await project.writeMcp({
        mcpServers: {
          large: {
            type: "stdio",
            command: process.execPath,
            args: ["./large-tool-mcp-server.mjs"],
          },
        },
      });
      await project.writeConfig(minimalConfig(runtime, {
        context: { mcp: { configPath: "./.mcp.json" } },
        state: { $use: stateName },
        policy: {
          tools: { default: "deny", allow: ["large_tool"] },
          approvals: { default: "allow" },
          sandbox: { mode: "off" },
        },
      }));
      const host = await createAgentHost(project.configPath);
      mutableCapabilities.get(mode)!.artifactResults = mode === "legacy";
      await expect(host.submit({
        requestId: `artifact-${mode}`,
        conversationId: `artifact-${mode}`,
        text: "run",
      })).resolves.toMatchObject({
        status: "completed",
        text: mode === "capable" ? "text,artifact" : "text",
      });
      await host.stop();
    }

    expect(observed.get("legacy")).toEqual(["text"]);
    expect(observed.get("capable")).toEqual(["text", "artifact"]);
    expect(artifactWrites).toHaveLength(1);
  });

  it("rejects a malformed runtime tool call before lookup or execution", async () => {
    const runtime = `@fixture/runtime-malformed-tool-call-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return runtimeInstance(async (request, context) => {
            if (!isRecord(request) || !Array.isArray(request.tools)
              || !(request.signal instanceof AbortSignal)
              || !isRecord(context) || typeof context.executeTool !== "function") {
              throw new Error("tool-call fixture context missing");
            }
            const tool = request.tools.find((candidate) =>
              isRecord(candidate) && candidate.name === "dangerous_tool");
            if (!isRecord(tool) || typeof tool.name !== "string") {
              throw new Error("dangerous tool missing");
            }
            try {
              await context.executeTool({
                id: "malformed-call",
                name: tool.name,
                input: {},
                unexpected: true,
              }, request.signal);
            } catch (error) {
              return completed(error instanceof Error ? error.message : String(error));
            }
            return completed("must not execute");
          });
        },
      },
    }]);
    const serverPath = join(project.root, "malformed-tool-mcp-server.mjs");
    const executionMarker = join(project.root, "malformed-tool-executions.log");
    await writeFile(serverPath, approvalMcpServerSource(executionMarker));
    await project.writeMcp({
      mcpServers: {
        malformed: {
          type: "stdio",
          command: process.execPath,
          args: ["./malformed-tool-mcp-server.mjs"],
        },
      },
    });
    await project.writeConfig(minimalConfig(runtime, {
      context: { mcp: { configPath: "./.mcp.json" } },
      policy: {
        tools: { default: "deny", allow: ["dangerous_tool"] },
        approvals: { default: "allow" },
        sandbox: { mode: "off" },
      },
    }));
    const host = await createAgentHost(project.configPath);

    await expect(host.submit({
      requestId: "malformed-tool-call-1",
      conversationId: "malformed-tool-call",
      text: "go",
    })).resolves.toMatchObject({
      status: "completed",
      text: expect.stringMatching(/unknown key/u),
    });
    expect(await executionCount(executionMarker)).toBe(0);
    await host.stop();
  });

  it("keeps approvals ask runnable when the turn has no governed tools", async () => {
    const runtime = `@fixture/runtime-no-tools-${randomUUID().toLowerCase()}`;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: { create: () => runtimeInstance(async () => completed("no approval needed")) },
    }]);
    await project.writeConfig(minimalConfig(runtime, {
      policy: {
        tools: { default: "deny", allow: [] },
        approvals: { default: "ask" },
        sandbox: { mode: "off" },
      },
    }));
    const host = await createAgentHost(project.configPath);

    await expect(host.submit({
      requestId: "approval-no-tools",
      conversationId: "approval-no-tools",
      text: "run",
    })).resolves.toMatchObject({
      status: "completed",
      text: "no approval needed",
    });
    await host.stop();
  });
});

describe("turn admission and routing", () => {
  it("forwards bounded runtime options and returns the canonical assistant message", async () => {
    const runtime = `@fixture/runtime-options-${randomUUID().toLowerCase()}`;
    let observedRequest: unknown;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request) => {
          observedRequest = request;
          return completed("structured answer");
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    const responseSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };

    const response = await host.submit({
      requestId: "runtime-options",
      conversationId: "runtime-options",
      text: "answer structurally",
      maxTurns: 7,
      maxOutputTokens: 321,
      responseSchema,
    });

    expect(observedRequest).toMatchObject({
      options: {
        maxTurns: 7,
        maxOutputTokens: 321,
        responseSchema,
      },
    });
    expect((observedRequest as { options: { responseSchema: unknown } }).options.responseSchema)
      .not.toBe(responseSchema);
    expect(response).toMatchObject({
      status: "completed",
      text: "structured answer",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "structured answer" }],
      },
      output: {
        status: "completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "structured answer" }],
        },
      },
    });
    expect(response.message).toEqual((response.output as { message: unknown }).message);
    expect(Object.isFrozen(response.message)).toBe(true);
    await host.stop();
  });

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

    await host.submit({ requestId: "normal-1", conversationId: "normal", text: "one" });
    vi.setSystemTime(new Date("2026-07-22T10:00:00.500Z"));
    await host.submit({ requestId: "normal-2", conversationId: "normal", text: "two" });
    vi.setSystemTime(new Date("2026-07-22T10:00:02.000Z"));
    await host.submit({ requestId: "normal-3", conversationId: "normal", text: "three" });
    await host.submit({
      requestId: "proactive-1",
      conversationId: "trigger:cron:event",
      text: "proactive-one",
    });
    await host.submit({
      requestId: "proactive-2",
      conversationId: "trigger:cron:event",
      text: "proactive-two",
    });

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

    await host.submit({ requestId: "daily-1", conversationId: "daily", text: "one" });
    vi.setSystemTime(new Date("2026-07-23T00:00:01.000Z"));
    await host.submit({ requestId: "daily-2", conversationId: "daily", text: "two" });

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
      host.submit({ requestId: "serialize-a1", conversationId: "a", text: "a1" }),
      host.submit({ requestId: "serialize-a2", conversationId: "a", text: "a2" }),
      host.submit({ requestId: "serialize-b1", conversationId: "b", text: "b1" }),
    ]);
    expect(results.map((entry) => entry.text)).toEqual(["a1", "a2", "b1"]);
    expect(maximum).toBe(2);
    expect(events.indexOf("start:a2")).toBeGreaterThan(events.indexOf("end:a1"));
    await expect(host.submit({
      requestId: "invalid-conversation",
      conversationId: "",
      text: "bad",
    })).rejects.toThrow(/conversationId/u);
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
    const first = host.submit({ requestId: "same-first", conversationId: "same", text: "first" });
    const controller = new AbortController();
    const second = host.submit({
      requestId: "same-second",
      conversationId: "same",
      text: "second",
      signal: controller.signal,
    });
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
    await expect(host.submit({
      requestId: "fallback-one",
      conversationId: "one",
      text: "go",
    })).resolves.toMatchObject({
      runtime: "fallback",
      model: "fixture:fallback",
      text: "fallback",
    });
    expect(fallbackCalls).toBe(1);
    primaryCommitted = true;
    await expect(host.submit({
      requestId: "fallback-two",
      conversationId: "two",
      text: "go",
    })).rejects.toThrow(/Every eligible runtime route failed/u);
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
    await expect(host.submit({
      requestId: "unknown-1",
      conversationId: "unknown",
      text: "go",
    })).rejects.toThrow(
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

    await expect(host.submit({
      requestId: "invalid-result-1",
      conversationId: "invalid-result",
      text: "go",
    })).rejects.toThrow(
      /Every eligible runtime route failed/u,
    );
    expect((await host.replay("invalid-result")).messages).toEqual([]);
    await host.stop();
  });

  it("rejects oversized runtime output before any conversation state is persisted", async () => {
    const runtime = `@fixture/runtime-oversized-${randomUUID().toLowerCase()}`;
    const stateName = `@fixture/state-oversized-${randomUUID().toLowerCase()}`;
    const state = stateFixtureController();
    const project = await fixture([
      {
        name: runtime,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async () => ({
            status: "completed",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }],
            },
          })),
        },
      },
      { name: stateName, kind: "state", controller: state.controller },
    ]);
    await project.writeConfig(minimalConfig(runtime, { state: { $use: stateName } }));
    const host = await createAgentHost(project.configPath);

    await expect(host.submit({
      requestId: "oversized-result-1",
      conversationId: "oversized-result",
      text: "go",
    })).rejects.toThrow(/Every eligible runtime route failed/u);
    expect([...state.records.keys()].filter((key) =>
      key.startsWith("core/conversations/"))).toEqual([]);
    expect((await host.replay("oversized-result")).messages).toEqual([]);
    await host.stop();
  });

  it("keeps a caught runtime event-boundary violation fatal for the attempt", async () => {
    const suffix = randomUUID().toLowerCase();
    const primary = `@fixture/runtime-event-boundary-${suffix}`;
    const fallback = `@fixture/runtime-event-boundary-fallback-${suffix}`;
    let fallbackCalls = 0;
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async (_request, context) => {
            try {
              await (context as { emit(event: unknown): Promise<void> }).emit({
                type: "text-delta",
                delta: "x".repeat(1024 * 1024 + 1),
              });
            } catch {
              // A runtime cannot recover the attempt after violating the stream boundary.
            }
            return completed("must not settle");
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

    await expect(host.submit({
      requestId: "event-boundary-1",
      conversationId: "event-boundary",
      text: "go",
    })).rejects.toThrow(/Every eligible runtime route failed/u);
    expect(fallbackCalls).toBe(0);
    expect((await host.replay("event-boundary")).messages).toEqual([]);
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

    await expect(host.submit({
      requestId: "observed-1",
      conversationId: "observed",
      text: "go",
    })).rejects.toThrow(
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

    await host.submit({ requestId: "transaction-one", conversationId: "transaction", text: "one" });
    const before = await host.replay("transaction");
    failWrites = true;
    await expect(host.submit({
      requestId: "transaction-two",
      conversationId: "transaction",
      text: "two",
    })).rejects.toThrow(
      /Every eligible runtime route failed/u,
    );
    expect(fallbackCalls).toBe(0);
    expect(await host.replay("transaction")).toEqual(before);

    failWrites = false;
    await host.submit({ requestId: "transaction-three", conversationId: "transaction", text: "three" });
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
        requestId: `chunked-${index}`,
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
    await expect(host.submit({
      conversationId: "sparse-attachment",
      text: "",
      attachments: new Array(1),
    })).rejects.toThrow(/attachments\.0.*required/u);
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
    const turn = host.submit({ requestId: "live-1", conversationId: "live", text: "start" });
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

  it("rejects an invalid runtime live-input disposition instead of swallowing it", async () => {
    const runtime = `@fixture/runtime-live-invalid-${randomUUID().toLowerCase()}`;
    let ready!: () => void;
    const registered = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request, context) => {
          const turnSignal = isRecord(request) ? request.signal : undefined;
          if (!isRecord(context) || typeof context.registerLiveInput !== "function"
            || !(turnSignal instanceof AbortSignal)) {
            throw new Error("live-input fixture context missing");
          }
          context.registerLiveInput(() => "invalid");
          ready();
          await new Promise<never>((_, reject) => {
            turnSignal.addEventListener("abort", () => reject(new Error("turn aborted")), {
              once: true,
            });
          });
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    const turn = host.submit({
      requestId: "live-invalid-1",
      conversationId: "live-invalid",
      text: "start",
    });
    await registered;

    await expect(host.offerLiveInput("live-invalid", {
      id: "invalid-disposition",
      text: "steer",
      receivedAt: new Date().toISOString(),
    })).resolves.toBe("requeue");
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    await host.stop();
  });

  it("bounds live-input acknowledgement by the supplied signal and host timeout", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-live-bounded-${suffix}`;
    const channel = `@fixture/channel-live-bounded-${suffix}`;
    let ready!: () => void;
    const registered = new Promise<void>((resolveReady) => { ready = resolveReady; });
    let offer!: (input: unknown) => Promise<unknown>;
    const acknowledgementSignals: AbortSignal[] = [];
    const project = await fixture([
      {
        name: runtime,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async (request, context) => {
            const turnSignal = isRecord(request) ? request.signal : undefined;
            if (!isRecord(context) || typeof context.registerLiveInput !== "function"
              || !(turnSignal instanceof AbortSignal)) {
              throw new Error("live-input fixture context missing");
            }
            context.registerLiveInput((_input: unknown, acknowledgementSignal: AbortSignal) => {
              acknowledgementSignals.push(acknowledgementSignal);
              return new Promise(() => {});
            });
            ready();
            await new Promise<never>((_, reject) => {
              turnSignal.addEventListener("abort", () => reject(new Error("turn aborted")), {
                once: true,
              });
            });
          }),
        },
      },
      {
        name: channel,
        kind: "channel",
        controller: {
          create(context) {
            if (!isRecord(context) || !isRecord(context.host)
              || typeof context.host.offerLiveInput !== "function") {
              throw new Error("channel live-input host missing");
            }
            offer = (input) => (
              context.host as { offerLiveInput(input: unknown): Promise<unknown> }
            ).offerLiveInput(input);
            return {
              capabilities: {
                attachments: false,
                liveInput: true,
                askUser: false,
                approvals: false,
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
      channels: { steering: { $use: channel } },
    }));
    const host = await createAgentHost(project.configPath, { lifecycleTimeoutMs: 50 });
    const turn = host.submit({
      requestId: "live-bounded-1",
      conversationId: "live-bounded",
      text: "start",
    });
    await registered;

    const suppliedController = new AbortController();
    const supplied = offer({
      conversationId: "live-bounded",
      id: "signal",
      text: "steer",
      receivedAt: new Date().toISOString(),
      signal: suppliedController.signal,
    });
    suppliedController.abort();
    await expect(supplied).rejects.toMatchObject({ name: "AbortError" });
    expect(acknowledgementSignals).toHaveLength(0);

    await expect(host.offerLiveInput("live-bounded", {
      id: "timeout",
      text: "steer",
      receivedAt: new Date().toISOString(),
    })).resolves.toBe("requeue");
    expect(acknowledgementSignals[0]?.aborted).toBe(true);
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
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
                approvals: false,
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

  it("cancels an uncooperative direct AskUser handler and releases the conversation tail", async () => {
    const runtime = `@fixture/runtime-direct-ask-${randomUUID().toLowerCase()}`;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseLate!: (answer: {
      interactionId: string;
      answers: Record<string, readonly string[]>;
      answeredAt: string;
    }) => void;
    const late = new Promise<{
      interactionId: string;
      answers: Record<string, readonly string[]>;
      answeredAt: string;
    }>((resolve) => {
      releaseLate = resolve;
    });
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request, context) => {
          if (!isRecord(request) || !(request.signal instanceof AbortSignal)
            || !isRecord(context) || typeof context.askUser !== "function") {
            throw new Error("direct AskUser fixture is unavailable");
          }
          const answer = await context.askUser({
            interactionId: "direct-ask",
            requestedAt: new Date().toISOString(),
            questions: [{
              id: "answer",
              prompt: "Answer",
              choices: [{ value: "done", label: "Done" }],
              allowFreeText: false,
              multiple: false,
            }],
          }, request.signal);
          return completed(String(
            isRecord(answer)
              && isRecord(answer.answers)
              && Array.isArray(answer.answers.answer)
              ? answer.answers.answer[0]
              : "missing",
          ));
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    const uncooperative: AgentInteractionHandler = {
      askUser(request) {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.questions)).toBe(true);
        expect(Object.isFrozen(request.questions[0])).toBe(true);
        expect(Object.isFrozen(request.questions[0]?.choices)).toBe(true);
        handlerStarted();
        return late;
      },
      async requestApproval() {
        throw new Error("Approval is not expected");
      },
    };

    const first = host.submit({
      requestId: "direct-ask-cancelled",
      conversationId: "direct-ask",
      text: "first",
      interactionHandler: uncooperative,
    });
    await started;
    await expect(host.cancel("direct-ask")).resolves.toBe(true);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    releaseLate({
      interactionId: "direct-ask",
      answers: { answer: ["done"] },
      answeredAt: new Date().toISOString(),
    });
    await expect(host.submit({
      requestId: "direct-ask-next",
      conversationId: "direct-ask",
      text: "second",
      interactionHandler: {
        async askUser(request) {
          return {
            interactionId: request.interactionId,
            answers: { answer: ["done"] },
            answeredAt: new Date().toISOString(),
          };
        },
        async requestApproval() {
          throw new Error("Approval is not expected");
        },
      },
    })).resolves.toMatchObject({ text: "done" });
    await host.stop();
  });

  it("cancels an uncooperative direct approval handler without waiting for its timeout", async () => {
    const runtime = `@fixture/runtime-direct-approval-${randomUUID().toLowerCase()}`;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create: () => runtimeInstance(async (request, context) => {
          if (!isRecord(request) || !(request.signal instanceof AbortSignal)
            || !isRecord(context) || typeof context.requestApproval !== "function") {
            throw new Error("direct approval fixture is unavailable");
          }
          const decision = await context.requestApproval({
            interactionId: "direct-approval",
            callId: "native-call",
            toolId: "runtime__native",
            displayName: "Native action",
            effects: ["execute"],
            summary: "Run the native action",
            requestedAt: new Date().toISOString(),
          }, request.signal);
          return completed(isRecord(decision) ? String(decision.decision) : "missing");
        }),
      },
    }]);
    await project.writeConfig(minimalConfig(runtime, {
      policy: {
        tools: { default: "deny", allow: [] },
        approvals: { default: "ask", timeoutMs: 3_600_000 },
        sandbox: { mode: "off" },
      },
    }));
    const host = await createAgentHost(project.configPath);
    const first = host.submit({
      requestId: "direct-approval-cancelled",
      conversationId: "direct-approval",
      text: "first",
      interactionHandler: {
        async askUser() {
          throw new Error("AskUser is not expected");
        },
        requestApproval() {
          handlerStarted();
          return new Promise<ApprovalDecision>(() => {});
        },
      },
    });
    await started;
    await expect(host.cancel("direct-approval")).resolves.toBe(true);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    await expect(host.submit({
      requestId: "direct-approval-next",
      conversationId: "direct-approval",
      text: "second",
      interactionHandler: {
        async askUser() {
          throw new Error("AskUser is not expected");
        },
        async requestApproval(request) {
          return {
            interactionId: request.interactionId,
            decision: "deny",
            decidedAt: new Date().toISOString(),
          };
        },
      },
    })).resolves.toMatchObject({ text: "deny" });
    await host.stop();
  });

  it("withholds unsupported channel interaction callbacks and emits zero events", async () => {
    for (const kind of ["ask", "approval"] as const) {
      const suffix = randomUUID().toLowerCase();
      const runtime = `@fixture/runtime-${kind}-${suffix}`;
      const channel = `@fixture/channel-${kind}-${suffix}`;
      let dispatch!: (request: unknown, reply: unknown) => Promise<unknown>;
      const project = await fixture([
        {
          name: runtime,
          kind: "runtime",
          controller: {
            create: () => runtimeInstance(async (request, context) => {
              if (!isRecord(context) || !isRecord(request)
                || !(request.signal instanceof AbortSignal)) {
                throw new Error("invalid interaction fixture context");
              }
              if (kind === "ask") {
                if (typeof context.askUser !== "function") {
                  throw new Error("AskUser interaction is unsupported by the channel");
                }
                await context.askUser({
                  interactionId: "unsupported-ask",
                  requestedAt: new Date().toISOString(),
                  questions: [{
                    id: "choice",
                    prompt: "Choose",
                    choices: [{ value: "yes", label: "Yes" }],
                    allowFreeText: false,
                    multiple: false,
                  }],
                }, request.signal);
              } else {
                if (typeof context.requestApproval !== "function") {
                  throw new Error("Approval interaction is unsupported by the channel");
                }
                await context.requestApproval({
                  interactionId: "unsupported-approval",
                  callId: "call-1",
                  toolId: "runtime__native",
                  displayName: "Native tool",
                  effects: ["execute"],
                  summary: "Run a native tool",
                  requestedAt: new Date().toISOString(),
                }, request.signal);
              }
              return completed("must not complete");
            }),
          },
        },
        {
          name: channel,
          kind: "channel",
          controller: {
            create(context) {
              dispatch = (context as {
                host: { dispatch(request: unknown, reply: unknown): Promise<unknown> };
              }).host.dispatch;
              return {
                capabilities: {
                  attachments: false,
                  liveInput: false,
                  askUser: false,
                  approvals: false,
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
        channels: { unsupported: { $use: channel } },
      }));
      const host = await createAgentHost(project.configPath);
      const events: unknown[] = [];

      await expect(dispatch({
        requestId: `unsupported-${kind}`,
        conversationId: `unsupported-${kind}`,
        sender: { id: "operator" },
        text: kind,
        attachments: [],
        receivedAt: new Date().toISOString(),
        signal: new AbortController().signal,
      }, {
        emit(event: unknown) {
          events.push(event);
          throw new Error("unsupported interaction event was emitted");
        },
      })).resolves.toMatchObject({ status: "rejected" });
      expect(events).toEqual([]);
      await host.stop();
    }
  });

  it("uses immutable capabilities from the exact originating channel instance", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-snapshot-${suffix}`;
    const channel = `@fixture/channel-snapshot-${suffix}`;
    const dispatches = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
    const capabilities = new Map<string, { askUser: boolean; approvals: boolean }>();
    const project = await fixture([
      {
        name: runtime,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async (request, context) => {
            if (!isRecord(context) || !isRecord(request)
              || !(request.signal instanceof AbortSignal)
              || typeof context.askUser !== "function"
              || typeof context.requestApproval !== "function") {
              throw new Error("channel interactions are unavailable");
            }
            await context.askUser({
              interactionId: `snapshot-ask-${String(request.conversationId)}`,
              requestedAt: new Date().toISOString(),
              questions: [{
                id: "choice",
                prompt: "Choose",
                choices: [{ value: "yes", label: "Yes" }],
                allowFreeText: false,
                multiple: false,
              }],
            }, request.signal);
            await context.requestApproval({
              interactionId: `snapshot-approval-${String(request.conversationId)}`,
              callId: "call-1",
              toolId: "runtime__native",
              displayName: "Native tool",
              effects: ["execute"],
              summary: "Run the native tool",
              requestedAt: new Date().toISOString(),
            }, request.signal);
            return completed("completed");
          }),
        },
      },
      {
        name: channel,
        kind: "channel",
        controller: {
          create(context) {
            if (!isRecord(context) || typeof context.instanceId !== "string"
              || !isRecord(context.host) || typeof context.host.dispatch !== "function") {
              throw new Error("invalid channel fixture context");
            }
            const enabled = context.instanceId === "enabled";
            const mutable = {
              attachments: false,
              liveInput: false,
              askUser: enabled,
              approvals: enabled,
              proactive: false,
              runtimeControl: false,
              verbatim: false,
              cancellation: false,
            };
            capabilities.set(context.instanceId, mutable);
            dispatches.set(
              context.instanceId,
              (request, reply) => (
                context.host as { dispatch(request: unknown, reply: unknown): Promise<unknown> }
              ).dispatch(request, reply),
            );
            return {
              capabilities: mutable,
            };
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: {
        disabled: { $use: channel },
        enabled: { $use: channel },
      },
    }));
    const host = await createAgentHost(project.configPath);
    capabilities.get("disabled")!.askUser = true;
    capabilities.get("disabled")!.approvals = true;
    capabilities.get("enabled")!.askUser = false;
    capabilities.get("enabled")!.approvals = false;

    const disabledEvents: unknown[] = [];
    await expect(dispatches.get("disabled")!({
      requestId: "snapshot-disabled",
      conversationId: "snapshot-disabled",
      sender: { id: "operator" },
      text: "go",
      attachments: [],
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    }, {
      emit(event: unknown) {
        disabledEvents.push(event);
      },
    })).resolves.toMatchObject({ status: "rejected" });
    expect(disabledEvents).toEqual([]);

    const enabledEvents: unknown[] = [];
    await expect(dispatches.get("enabled")!({
      requestId: "snapshot-enabled",
      conversationId: "snapshot-enabled",
      sender: { id: "operator" },
      text: "go",
      attachments: [],
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    }, {
      async emit(event: unknown) {
        enabledEvents.push(event);
        if (!isRecord(event)) return;
        if (event.type === "ask-user" && isRecord(event.ask)) {
          await host.answerAsk("snapshot-enabled", {
            interactionId: String(event.ask.interactionId),
            answers: { choice: ["yes"] },
          });
        }
        if (event.type === "approval" && isRecord(event.approval)) {
          await host.answerApproval("snapshot-enabled", {
            interactionId: String(event.approval.interactionId),
            decision: "allow_once",
            decidedAt: new Date().toISOString(),
          });
        }
      },
    })).resolves.toMatchObject({ status: "completed", text: "completed" });
    expect(enabledEvents.map((event) => isRecord(event) ? event.type : undefined))
      .toEqual(["ask-user", "approval", "text-replace"]);
    await host.stop();
  });

  it("automatically requires attachment capability when the submission carries attachment content", async () => {
    const runtime = `@fixture/runtime-no-attachments-${randomUUID().toLowerCase()}`;
    let turns = 0;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return {
            ...runtimeInstance(async () => {
              turns += 1;
              return completed("must not run");
            }),
            capabilities: {
              tools: true,
              mcp: true,
              attachments: false,
              approvals: true,
              structuredOutput: true,
              sandbox: true,
              sessions: true,
            },
          };
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);

    let attachmentError: unknown;
    try {
      await host.submit({
        requestId: "implicit-attachment-capability",
        conversationId: "implicit-attachment-capability",
        text: "inspect the file",
        attachments: [{
          id: "fixture-file",
          kind: "file",
          name: "fixture.txt",
          mediaType: "text/plain",
          sizeBytes: 7,
          data: new TextEncoder().encode("fixture"),
        }],
      });
    } catch (error) {
      attachmentError = error;
    }
    expect(attachmentError).toBeInstanceOf(AggregateError);
    expect((attachmentError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/attachments unsupported/u) }),
    ]);
    expect(turns).toBe(0);
    await host.stop();
  });

  it("routes from an immutable runtime capability snapshot after creation", async () => {
    const runtime = `@fixture/runtime-capability-snapshot-${randomUUID().toLowerCase()}`;
    let turns = 0;
    const mutableCapabilities = {
      tools: true,
      mcp: true,
      attachments: false,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
      liveInput: false,
    };
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return {
            ...runtimeInstance(async () => {
              turns += 1;
              return completed("must not run");
            }),
            capabilities: mutableCapabilities,
          };
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    mutableCapabilities.attachments = true;

    let snapshotError: unknown;
    try {
      await host.submit({
        requestId: "runtime-capability-snapshot-1",
        conversationId: "runtime-capability-snapshot",
        text: "inspect",
        attachments: [{
          id: "snapshot-file",
          kind: "file",
          name: "snapshot.txt",
          mediaType: "text/plain",
          sizeBytes: 1,
          data: new Uint8Array([1]),
        }],
      });
    } catch (error) {
      snapshotError = error;
    }
    expect(snapshotError).toBeInstanceOf(AggregateError);
    expect((snapshotError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/attachments unsupported/u) }),
    ]);
    expect(turns).toBe(0);
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
      requestId: "capabilities-1",
      conversationId: "capabilities",
      text: "image required",
      requiredCapabilities: ["attachments"],
    })).rejects.toThrow(/Every eligible runtime route failed/u);
    expect(turns).toBe(0);
    await host.stop();
  });

  it("rejects advertised native tools until Core can govern their effects", async () => {
    const runtime = `@fixture/runtime-native-tool-${randomUUID().toLowerCase()}`;
    let turns = 0;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return {
            ...runtimeInstance(async () => {
              turns += 1;
              return completed("must not run");
            }),
            preflightModel() {
              return {
                supported: true,
                nativeTools: [{
                  id: "runtime__shell",
                  displayName: "Shell",
                  effects: ["execute"],
                  approval: "runtime-enforced",
                  sandbox: "runtime-enforced",
                }],
              };
            },
          };
        },
      },
    }]);
    await project.writeConfig(minimalConfig(runtime));
    const host = await createAgentHost(project.configPath);
    let nativeToolError: unknown;
    try {
      await host.submit({
        requestId: "native-tool-rejected",
        conversationId: "native-tool",
        text: "run",
      });
    } catch (error) {
      nativeToolError = error;
    }
    expect(nativeToolError).toBeInstanceOf(AggregateError);
    expect((nativeToolError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/cannot govern/u) }),
    ]);
    expect(turns).toBe(0);
    await host.stop();
  });

  it("rejects malformed model-preflight capability claims before running a turn", async () => {
    const runtime = `@fixture/runtime-preflight-${randomUUID().toLowerCase()}`;
    let turns = 0;
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: {
        create() {
          return {
            ...runtimeInstance(async () => {
              turns += 1;
              return completed("must not run");
            }),
            preflightModel() {
              return {
                supported: true,
                capabilities: {
                  tools: "yes",
                  mcp: true,
                  attachments: true,
                  approvals: true,
                  structuredOutput: true,
                  sandbox: true,
                  sessions: true,
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
      requestId: "malformed-preflight-1",
      conversationId: "malformed-preflight",
      text: "go",
    })).rejects.toThrow(/capabilities\.tools.*boolean/u);
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
          approvals: false,
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

function stateFixtureController(
  shouldFailWrite: () => boolean = () => false,
  artifactWrites?: Uint8Array[],
): {
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
        ...(artifactWrites === undefined ? {} : {
          async putArtifact(request: {
            data: Uint8Array;
            mediaType: string;
            fileName?: string;
          }) {
            const data = new Uint8Array(request.data);
            artifactWrites.push(data);
            const digest = createHash("sha256").update(data).digest("hex");
            return {
              id: `artifact:sha256:${digest}`,
              sha256: `sha256:${digest}` as const,
              sizeBytes: data.byteLength,
              mediaType: request.mediaType,
              ...(request.fileName === undefined ? {} : { fileName: request.fileName }),
            };
          },
          async readArtifact() { return undefined; },
          async listArtifacts() { return { artifacts: [] }; },
          async deleteArtifact() { return false; },
        }),
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

async function executionCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line === "executed")
      .length;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

function approvalMcpServerSource(executionMarker: string): string {
  return String.raw`
import { appendFileSync } from "node:fs";
const executionMarker = ${JSON.stringify(executionMarker)};
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
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "approval-probe", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [{
          name: "dangerous_tool",
          description: "Execute exactly once only after direct approval.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      };
    } else if (message.method === "tools/call") {
      appendFileSync(executionMarker, "executed\n");
      result = { content: [{ type: "text", text: "executed" }] };
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "unknown" },
      }) + "\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;
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

const LARGE_TOOL_MCP_SERVER_SOURCE = String.raw`
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
          serverInfo: { name: "large-tool-probe", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? {
            tools: [{
              name: "large_tool",
              description: "Returns one oversized result.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            }],
          }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: "x".repeat(300000) }] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;

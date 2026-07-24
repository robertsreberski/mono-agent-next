import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentInteractionHandler,
  Channel,
  JsonValue,
  ModuleToolCallContext,
  ModuleToolContribution,
  ModuleToolTurnContext,
  RuntimeToolResult,
  RuntimeTurnContext,
  RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfigError, createAgentHost } from "../index.js";
import type { AgentHost } from "../types.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  runtimeController,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];
const hosts: AgentHost[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("selected-module tools", () => {
  it("snapshots, binds, executes, and revokes a selected instance per logical turn", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-module-tool-${suffix}`;
    const memoryName = `@fixture/memory-module-tool-${suffix}`;
    const turnContexts: ModuleToolTurnContext[] = [];
    const callContexts: ModuleToolCallContext[] = [];
    const results: RuntimeToolResult[] = [];
    const observedNames: string[][] = [];
    let retainedExecute: RuntimeTurnContext["executeTool"] | undefined;
    let originalBindings = 0;
    let mutatedBindings = 0;
    const descriptor = mutableTool("Echo", [], (turn) => {
      originalBindings += 1;
      turnContexts.push(turn);
      return {
        execute(input, call) {
          callContexts.push(call);
          return { content: [{ type: "json", value: { input, runId: turn.runId } }] };
        },
      };
    });
    const project = await tracked([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(async (rawRequest, rawContext) => {
          const request = rawRequest as RuntimeTurnRequest;
          const context = rawContext as RuntimeTurnContext;
          observedNames.push(request.tools.map((tool) => tool.name));
          retainedExecute = context.executeTool;
          const echo = request.tools.find((tool) => tool.name === "Echo");
          if (echo !== undefined) {
            results.push(await context.executeTool(
              { id: `call-${request.turnId}`, name: echo.name, input: { text: "hello" } },
              request.signal,
            ));
          }
          return completed(echo === undefined ? "absent" : "present");
        }),
      },
      {
        name: memoryName,
        kind: "memory",
        controller: {
          create: () => ({
            capabilities: { capture: false, forget: false },
            recall: async () => ({ records: [] }),
            toolContributions: [descriptor],
          }),
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtimeName, {
      memory: { $use: memoryName },
      policy: allowPolicy(),
    }));
    const host = await started(project);

    descriptor.name = "Mutated";
    descriptor.description = "Mutated after Core took its snapshot.";
    descriptor.inputSchema = { type: "string" };
    descriptor.effects.push("network");
    descriptor.bind = () => {
      mutatedBindings += 1;
      return { execute: () => ({ mutated: true }) };
    };

    const first = await host.submit({
      requestId: "module-first",
      conversationId: "conversation-first",
      text: "use the tool",
    });
    const second = await host.submit({
      requestId: "module-second",
      conversationId: "conversation-second",
      text: "use it again",
    });

    expect(observedNames).toEqual([["Echo"], ["Echo"]]);
    expect(originalBindings).toBe(2);
    expect(mutatedBindings).toBe(0);
    expect(turnContexts.map(({ conversationId, runId, requestId }) =>
      ({ conversationId, runId, requestId }))).toEqual([
      {
        conversationId: "conversation-first",
        runId: first.runId,
        requestId: "module-first",
      },
      {
        conversationId: "conversation-second",
        runId: second.runId,
        requestId: "module-second",
      },
    ]);
    expect(turnContexts.every((context) => context.signal.aborted)).toBe(true);
    expect(callContexts.map((context) => context.callId)).toEqual([
      `call-${first.runId}`,
      `call-${second.runId}`,
    ]);
    expect(callContexts.every((context) => context.signal.aborted)).toBe(true);
    expect(results.every((result) => result.isError !== true)).toBe(true);
    await expect(retainedExecute!(
      { id: "stale", name: "Echo", input: {} },
      new AbortController().signal,
    )).rejects.toThrow("Runtime attempt context is closed");

    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    await project.writeConfig(minimalConfig(runtimeName, { policy: allowPolicy() }));
    const absent = await started(project);
    await absent.submit({
      requestId: "module-absent",
      conversationId: "module-absent",
      text: "no selected contributor",
    });
    expect(observedNames.at(-1)).toEqual([]);
  });

  it("applies tool policy and exact effects to approval without governing effect-free reads", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-module-policy-${suffix}`;
    const memoryName = `@fixture/memory-module-policy-${suffix}`;
    const names: string[][] = [];
    const results: RuntimeToolResult[] = [];
    const project = await tracked([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(async (rawRequest, rawContext) => {
          const request = rawRequest as RuntimeTurnRequest;
          const context = rawContext as RuntimeTurnContext;
          names.push(request.tools.map((tool) => tool.name));
          for (const tool of request.tools) {
            results.push(await context.executeTool(
              { id: `${request.turnId}:${tool.name}`, name: tool.name, input: {} },
              request.signal,
            ));
          }
          return completed("ok");
        }),
      },
      {
        name: memoryName,
        kind: "memory",
        controller: {
          create: () => memory([
            tool("ReadOnly", [], () => ({ ok: true })),
            tool("Effect", ["read", "network"], () => ({ changed: true })),
            tool("Failure", [], () => {
              throw new Error("module failure");
            }),
          ]),
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtimeName, {
      memory: { $use: memoryName },
      policy: {
        tools: { default: "deny", allow: ["ReadOnly", "Effect", "Failure"] },
        approvals: { default: "ask" },
        sandbox: { mode: "off" },
      },
    }));
    const approvals: Array<{ readonly toolId: string; readonly effects: readonly string[] }> = [];
    const handler: AgentInteractionHandler = {
      async askUser() {
        throw new Error("not expected");
      },
      async requestApproval(request) {
        approvals.push({ toolId: request.toolId, effects: request.effects });
        return {
          interactionId: request.interactionId,
          decision: "allow_once",
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const host = await started(project);
    await host.submit({
      requestId: "module-policy",
      conversationId: "module-policy",
      text: "execute",
      interactionHandler: handler,
    });
    expect(names[0]).toEqual(["Effect", "Failure", "ReadOnly"]);
    expect(approvals).toEqual([{ toolId: "Effect", effects: ["read", "network"] }]);
    expect(results.find((result) =>
      result.content.some((part) => part.type === "text" && part.text.includes("module failure"))))
      .toMatchObject({ isError: true });

    approvals.length = 0;
    await host.submit({
      requestId: "module-narrow",
      conversationId: "module-narrow",
      text: "narrow",
      toolPolicy: { allow: ["ReadOnly"] },
    });
    expect(names[1]).toEqual(["ReadOnly"]);
    expect(approvals).toEqual([]);

    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    await project.writeConfig(minimalConfig(runtimeName, {
      memory: { $use: memoryName },
      policy: {
        tools: { default: "allow" },
        approvals: { default: "deny" },
        sandbox: { mode: "off" },
      },
    }));
    const denied = await started(project);
    await denied.submit({
      requestId: "module-approval-deny",
      conversationId: "module-approval-deny",
      text: "deny effects",
    });
    expect(names[2]).toEqual(["Failure", "ReadOnly"]);
  });

  it("rejects an active sandbox route only while an effectful module tool remains exposed", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-module-sandbox-${suffix}`;
    const memoryName = `@fixture/memory-module-sandbox-${suffix}`;
    const sandboxName = `@fixture/sandbox-module-tool-${suffix}`;
    let runtimeCalls = 0;
    const project = await tracked([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(() => {
          runtimeCalls += 1;
          return completed("ok");
        }),
      },
      {
        name: memoryName,
        kind: "memory",
        controller: {
          create: () => memory([
            tool("Effect", ["execute"], () => ({ ok: true })),
          ]),
        },
      },
      {
        name: sandboxName,
        kind: "sandbox",
        controller: {
          create: () => ({
            execute: async () => ({
              exitCode: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
              timedOut: false,
            }),
          }),
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtimeName, {
      memory: { $use: memoryName },
      policy: {
        tools: { default: "allow" },
        approvals: { default: "allow" },
        sandbox: { $use: sandboxName },
      },
    }));
    const host = await started(project);
    await expect(host.submit({
      requestId: "sandbox-reject",
      conversationId: "sandbox-reject",
      text: "reject",
    })).rejects.toThrow("Every eligible runtime route failed");
    expect(runtimeCalls).toBe(0);

    await expect(host.submit({
      requestId: "sandbox-narrow",
      conversationId: "sandbox-narrow",
      text: "narrow",
      toolPolicy: { deny: ["Effect"] },
    })).resolves.toMatchObject({ status: "completed" });
    expect(runtimeCalls).toBe(1);
  });

  it("canonicalizes cross-source collisions deterministically and diagnoses raw policy aliases", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-module-collision-${suffix}`;
    const channels = ["alpha", "beta"].map((instanceId) => ({
      instanceId,
      packageName: `@fixture/channel-module-collision-${instanceId}-${suffix}`,
    }));
    const observed: string[][] = [];
    const project = await tracked([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController((request) => {
          observed.push((request as RuntimeTurnRequest).tools.map((entry) => entry.name).sort());
          return completed("ok");
        }),
      },
      ...channels.map(({ packageName }, index) => ({
        name: packageName,
        kind: "channel" as const,
        controller: {
          create: () => collisionChannel(index === 0),
        },
      })),
    ]);
    await mkdir(join(project.root, "skills", "focused"), { recursive: true });
    await writeFile(
      join(project.root, "skills", "focused", "SKILL.md"),
      "---\nname: focused\ndescription: Focused fixture skill.\n---\nUse the fixture.\n",
    );
    await writeFile(join(project.root, "shared.mjs"), mcpServerSource("Shared"));
    await project.writeMcp({
      mcpServers: {
        shared: { type: "stdio", command: process.execPath, args: ["./shared.mjs"] },
      },
    });
    const channelConfig = Object.fromEntries(
      channels.map(({ instanceId, packageName }) => [instanceId, { $use: packageName }]),
    );
    const config = minimalConfig(runtimeName, {
      channels: channelConfig,
      context: {
        mcp: { configPath: "./.mcp.json" },
        skills: { roots: ["./skills"], load: "all", disclosure: "index" },
      },
      policy: allowPolicy(),
    });
    await project.writeConfig(config);
    const host = await started(project);
    await host.submit({
      requestId: "collision-first",
      conversationId: "collision-first",
      text: "inspect",
      interactionHandler: passiveHandler(),
    });
    const first = observed[0]!;
    expect(first).toContain("AskUser");
    expect(first).toContain("ReadSkill");
    expect(first).not.toContain("Shared");
    expect(first.filter((name) => /^module__[A-Za-z0-9_-]{43}$/u.test(name))).toHaveLength(4);
    expect(first.filter((name) => /^channel__[A-Za-z0-9_-]{43}$/u.test(name))).toHaveLength(1);
    expect(first.filter((name) => /^mcp__[A-Za-z0-9_-]{43}$/u.test(name))).toHaveLength(1);
    await expect(host.submit({
      requestId: "collision-request-policy",
      conversationId: "collision-request-policy",
      text: "ambiguous",
      toolPolicy: { allow: ["Shared"] },
    })).rejects.toThrow("request tool policy contains ambiguous tool aliases");

    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    await project.writeConfig({
      ...config,
      channels: Object.fromEntries([...channels].reverse().map(
        ({ instanceId, packageName }) => [instanceId, { $use: packageName }],
      )),
    });
    const reversed = await started(project);
    await reversed.submit({
      requestId: "collision-reversed",
      conversationId: "collision-reversed",
      text: "inspect",
      interactionHandler: passiveHandler(),
    });
    expect(observed[1]).toEqual(first);
    await reversed.stop();
    hosts.splice(hosts.indexOf(reversed), 1);

    await project.writeConfig({
      ...config,
      policy: {
        tools: { default: "deny", allow: ["Shared"] },
        approvals: { default: "allow" },
        sandbox: { mode: "off" },
      },
    });
    let error: AgentConfigError | undefined;
    try {
      await createAgentHost(project.configPath);
    } catch (candidate) {
      if (candidate instanceof AgentConfigError) error = candidate;
    }
    expect(error).toBeInstanceOf(AgentConfigError);
    expect(error?.issues[0]?.message).toMatch(/"Shared" resolves to/u);
    expect(error?.issues[0]?.message).toMatch(/module__/u);
    expect(error?.issues[0]?.message).toMatch(/channel__/u);
    expect(error?.issues[0]?.message).toMatch(/mcp__/u);
  });

  it("composes call cancellation and the 120-second hard deadline", async () => {
    vi.useFakeTimers();
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-module-cancel-${suffix}`;
    const memoryName = `@fixture/memory-module-cancel-${suffix}`;
    const signals: AbortSignal[] = [];
    const results: RuntimeToolResult[] = [];
    let secondCallStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      secondCallStarted = resolve;
    });
    const project = await tracked([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(async (rawRequest, rawContext) => {
          const request = rawRequest as RuntimeTurnRequest;
          const context = rawContext as RuntimeTurnContext;
          const name = request.tools[0]!.name;
          if (request.conversationId === "cancel") {
            const controller = new AbortController();
            const pending = context.executeTool(
              { id: "cancel-call", name, input: {} },
              controller.signal,
            );
            controller.abort(new Error("cancelled call"));
            results.push(await pending);
          } else {
            results.push(await context.executeTool(
              { id: "timeout-call", name, input: {} },
              request.signal,
            ));
          }
          return completed("ok");
        }),
      },
      {
        name: memoryName,
        kind: "memory",
        controller: {
          create: () => memory([
            tool("Wait", [], (_input, context) => {
              signals.push(context.signal);
              if (signals.length === 2) secondCallStarted();
              return new Promise(() => undefined);
            }),
          ]),
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtimeName, {
      memory: { $use: memoryName },
      policy: allowPolicy(),
    }));
    const host = await started(project);
    await host.submit({
      requestId: "cancel",
      conversationId: "cancel",
      text: "cancel",
    });
    expect(results[0]).toMatchObject({ isError: true });
    expect(signals[0]?.aborted).toBe(true);

    const timed = host.submit({
      requestId: "timeout",
      conversationId: "timeout",
      text: "timeout",
    });
    await secondStarted;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(timed).resolves.toMatchObject({ status: "completed" });
    expect(results[1]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[1])).toContain("timed out after 120000ms");
    expect(signals[1]?.aborted).toBe(true);
  });

  it("fails startup when selected instances exceed the aggregate contribution bound", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimes = Array.from({ length: 5 }, (_, index) =>
      `@fixture/runtime-module-limit-${String(index)}-${suffix}`);
    const contributions = Array.from({ length: 64 }, (_, index) =>
      tool(`Tool${String(index)}`, [], () => ({ ok: true })));
    const project = await tracked(runtimes.map((name) => ({
      name,
      kind: "runtime" as const,
      controller: {
        create: () => ({
          ...(runtimeController(() => completed("unused")).create({}) as Record<string, unknown>),
          toolContributions: contributions,
        }),
      },
    })));
    await project.writeConfig(minimalConfig(runtimes[0]!, {
      runtimes: Object.fromEntries(runtimes.map((name, index) => [
        `runtime-${String(index)}`,
        { $use: name },
      ])),
      routing: {
        primary: { runtime: "runtime-0", model: "fixture:model" },
        fallbacks: [],
      },
    }));
    await expect(createAgentHost(project.configPath)).rejects.toThrow(
      "Selected modules contribute more than 256 tools",
    );
  });

  it("never catalogs a contribution from an instance whose startup fails", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-module-start-failure-${suffix}`;
    const memoryName = `@fixture/memory-module-start-failure-${suffix}`;
    let bindings = 0;
    let stops = 0;
    const project = await tracked([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(() => completed("unused")),
      },
      {
        name: memoryName,
        kind: "memory",
        controller: {
          create: () => ({
            ...memory([
              {
                ...tool("NeverCallable", [], () => ({ ok: true })),
                bind(context) {
                  bindings += 1;
                  return { execute: () => ({ runId: context.runId }) };
                },
              },
            ]),
            start() {
              throw new Error("startup failed");
            },
            stop() {
              stops += 1;
            },
          }),
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtimeName, {
      memory: { $use: memoryName },
      policy: allowPolicy(),
    }));
    await expect(createAgentHost(project.configPath)).rejects.toThrow("startup failed");
    expect(bindings).toBe(0);
    expect(stops).toBe(1);
  });
});

function mutableTool(
  name: string,
  effects: string[],
  bind: ModuleToolContribution["bind"],
): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects: string[];
  bind: ModuleToolContribution["bind"];
} {
  return {
    name,
    description: `${name} fixture tool.`,
    inputSchema: { type: "object", additionalProperties: true },
    effects,
    bind,
  };
}

function tool(
  name: string,
  effects: ModuleToolContribution["effects"],
  execute: (
    input: JsonValue,
    context: ModuleToolCallContext,
  ) => unknown,
): ModuleToolContribution {
  return {
    name,
    description: `${name} fixture tool.`,
    inputSchema: { type: "object", additionalProperties: true },
    effects,
    bind: () => ({ execute }),
  };
}

function memory(toolContributions: readonly ModuleToolContribution[]) {
  return {
    capabilities: { capture: false, forget: false },
    recall: async () => ({ records: [] }),
    toolContributions,
  };
}

function collisionChannel(includeReservedCollisions: boolean): Channel {
  return {
    capabilities: {
      attachments: false,
      liveInput: false,
      askUser: false,
      approvals: false,
      proactive: true,
      runtimeControl: false,
      verbatim: true,
      cancellation: false,
    },
    toolContributions: [
      tool("Shared", [], () => ({ source: "module" })),
      ...(includeReservedCollisions
        ? [
            tool("AskUser", [], () => ({ source: "module" })),
            tool("ReadSkill", [], () => ({ source: "module" })),
          ]
        : []),
    ],
    sendTools: includeReservedCollisions
      ? [{
          name: "Shared",
          description: "Shared channel delivery.",
          inputSchema: { type: "object", additionalProperties: false },
          prepare: () => ({ conversationId: "destination", text: "shared" }),
        }]
      : [],
    deliver: async (message) => ({
      status: "delivered",
      idempotencyKey: message.idempotencyKey,
      messageId: "shared",
    }),
    resolveDeliveryHistory: () => ({ conversationId: "destination" }),
  };
}

function passiveHandler(): AgentInteractionHandler {
  return {
    async askUser(request) {
      return {
        interactionId: request.interactionId,
        answers: {},
        answeredAt: new Date().toISOString(),
      };
    },
    async requestApproval(request) {
      return {
        interactionId: request.interactionId,
        decision: "allow_once",
        decidedAt: new Date().toISOString(),
      };
    },
  };
}

function allowPolicy() {
  return {
    tools: { default: "allow" as const },
    approvals: { default: "allow" as const },
    sandbox: { mode: "off" as const },
  };
}

async function tracked(options: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await createFixtureProject(options);
  projects.push(project);
  return project;
}

async function started(project: FixtureProject): Promise<AgentHost> {
  const host = await createAgentHost(project.configPath);
  hosts.push(host);
  return host;
}

function mcpServerSource(name: string): string {
  return String.raw`
const name = ${JSON.stringify(name)};
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
        serverInfo: { name: "module-tool-collision", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [{
        name,
        description: "Shared MCP tool.",
        inputSchema: { type: "object", additionalProperties: false },
      }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: "mcp" }] };
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "unknown" },
      }) + "\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;
}

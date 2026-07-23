import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import type {
  ApprovalRequest,
  RuntimeSession,
  RuntimeTurnEvent,
} from "@mono-agent/module-sdk";
import { RUNTIME_SESSION_UNAVAILABLE_CODE } from "@mono-agent/module-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseRuntimeCodexConfig, runtimeCodexJsonSchema } from "../config.js";
import { codexProcessEnvironment } from "../environment.js";
import { JsonRpcProcess, type ProcessLike, type SpawnProcess } from "../json-rpc.js";
import { createRuntimeCodex, RuntimeCodexError } from "../runtime.js";

class FakeCodexProcess extends EventEmitter implements ProcessLike {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly requests: Record<string, unknown>[] = [];

  constructor(
    private readonly observeRequest?: (
      request: Record<string, unknown>,
      process: FakeCodexProcess,
    ) => boolean,
  ) {
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
          if (this.observeRequest?.(request, this) === true) continue;
          const id = request.id as number | undefined;
          if (id !== undefined) {
            const method = request.method;
            if (method === "initialize") this.send({ id, result: { userAgent: "fake" } });
            else if (method === "config/read") {
              this.send({ id, result: { config: { mcp_servers: {} } } });
            }
            else if (method === "thread/start" || method === "thread/resume") {
              this.send({ id, result: { thread: { id: "thread-1" } } });
            }
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

class FakeCommandProcess extends EventEmitter implements ProcessLike {
  readonly pid = 4321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  #closed = false;

  constructor(
    private readonly output: {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
    } = {},
  ) {
    super();
    this.stdin = new Writable({
      final: (callback) => {
        queueMicrotask(() => {
          if (this.#closed) return;
          this.#closed = true;
          this.stdout.end(this.output.stdout ?? "");
          this.stderr.end(this.output.stderr ?? "");
          this.emit("close", this.output.code ?? 0, null);
        });
        callback();
      },
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  }
}

interface FakeLaunchOptions {
  readonly version?: string;
  readonly mcpOutputs?: readonly string[];
  readonly strictProbe?: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
  };
}

function runtimeLaunch(
  appProcesses: readonly FakeCodexProcess[],
  options: FakeLaunchOptions = {},
): ReturnType<typeof vi.fn<SpawnProcess>> {
  const remaining = [...appProcesses];
  let strictProbePending = true;
  let mcpOutputIndex = 0;
  return vi.fn<SpawnProcess>((_command, args) => {
    if (args[0] === "--version") {
      return new FakeCommandProcess({
        stdout: `${options.version ?? "codex-cli 0.145.0"}\n`,
      });
    }
    if (args[0] === "mcp") {
      return new FakeCommandProcess({
        stdout: options.mcpOutputs?.[mcpOutputIndex++] ?? "[]\n",
      });
    }
    if (args[0] === "app-server" && strictProbePending) {
      strictProbePending = false;
      return new FakeCommandProcess(options.strictProbe);
    }
    const next = remaining.shift();
    if (args[0] !== "app-server" || next === undefined) {
      throw new Error(`Unexpected fake Codex launch: ${args.join(" ")}`);
    }
    return next;
  });
}

let testRoot = "";

beforeEach(async () => {
  testRoot = await realpath(await mkdtemp(join(tmpdir(), "runtime-codex-test-")));
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

function testDataDirectory(suffix = "default"): string {
  return join(testRoot, "data", suffix);
}

function explicitConfig(
  options: Record<string, unknown> = {},
): ReturnType<typeof parseRuntimeCodexConfig> {
  return parseRuntimeCodexConfig({
    auth: { apiKey: "test-api-key" },
    requestTimeoutMs: 1_000,
    ...options,
  });
}

function mcpJson(
  entries: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly transport?: "stdio" | "streamable_http";
  }[],
): string {
  return `${JSON.stringify(entries.map((entry) => ({
    name: entry.name,
    enabled: entry.enabled,
    transport: entry.transport === "streamable_http"
      ? { type: "streamable_http", url: "https://ambient.invalid/mcp" }
      : { type: "stdio", command: "ambient-command", args: [] },
  })))}\n`;
}

function approvalProcess(
  method: string,
  params: Record<string, unknown>,
  evidenceItem?: Record<string, unknown>,
): {
  readonly child: FakeCodexProcess;
  readonly response: Promise<Record<string, unknown>>;
} {
  let resolveResponse!: (response: Record<string, unknown>) => void;
  const response = new Promise<Record<string, unknown>>((resolve) => {
    resolveResponse = resolve;
  });
  const child = new FakeCodexProcess((request, process) => {
    if (request.method === "turn/start") {
      process.send({ id: request.id, result: { turn: { id: "turn-1" } } });
      queueMicrotask(() => {
        if (evidenceItem !== undefined) {
          process.send({
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              startedAtMs: Date.now(),
              item: evidenceItem,
            },
          });
        }
        process.send({
          id: "server-approval-1",
          method,
          params,
        });
      });
      return true;
    }
    if (request.id === "server-approval-1" && request.method === undefined) {
      resolveResponse(request);
      process.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          delta: "approved flow completed",
        },
      });
      process.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      });
      return true;
    }
    return false;
  });
  return { child, response };
}

describe("runtime-codex", () => {
  it("validates deterministic model and config syntax before create without effects", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const definition = await import("../index.js");
    const config = parseRuntimeCodexConfig({});
    const validation = definition.monoAgentModule.validateModel?.({
      model: "gpt-5.6-codex",
      config,
    });

    expect(definition.monoAgentModule.manifest.packageName).toBe("@mono-agent/runtime-codex");
    expect(validation).toEqual({
      supported: true,
      capabilities: {
        tools: false,
        mcp: false,
        attachments: false,
        approvals: true,
        structuredOutput: true,
        sandbox: false,
        sessions: true,
        maxTurns: false,
        maxOutputTokens: false,
        liveInput: true,
      },
      nativeTools: [{
        id: "codex.command-execution",
        displayName: "Codex command execution",
        effects: ["read", "write", "execute"],
        approval: "runtime-enforced",
        sandbox: "runtime-enforced",
      }, {
        id: "codex.image-view",
        displayName: "Codex image view",
        effects: ["read"],
        approval: "runtime-enforced",
        sandbox: "runtime-enforced",
      }, {
        id: "codex.command-escalation",
        displayName: "Codex command escalation",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "runtime-enforced",
      }, {
        id: "codex.file-change-escalation",
        displayName: "Codex file change escalation",
        effects: ["write"],
        approval: "core-callback",
        sandbox: "runtime-enforced",
      }],
    });
    expect(validation).not.toBeInstanceOf(Promise);
    expect(definition.monoAgentModule.validateModel?.({
      model: " gpt-5.6-codex",
      config,
    })).toMatchObject({
      supported: false,
      diagnostics: [{ code: "runtime-codex.model", severity: "error" }],
    });
    expect(() => definition.monoAgentModule.validateModel?.({
      model: "gpt-5.6-codex",
      config: { binary: " codex" },
    })).toThrow("must be a non-empty trimmed string");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("keeps instance preflight effect-free and removes the deprecated validator", async () => {
    const launch = vi.fn<SpawnProcess>();
    const runtime = createRuntimeCodex({
      config: parseRuntimeCodexConfig({ requestTimeoutMs: 1_000 }),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("preflight-model"),
      spawnProcess: launch,
    });

    expect(await runtime.preflightModel?.({
      model: "gpt-5.6-codex",
      signal: new AbortController().signal,
    })).toMatchObject({
      supported: true,
      capabilities: { approvals: true, sandbox: false },
      nativeTools: [
        { id: "codex.command-execution", approval: "runtime-enforced" },
        { id: "codex.image-view", approval: "runtime-enforced" },
        { id: "codex.command-escalation", approval: "core-callback" },
        { id: "codex.file-change-escalation", approval: "core-callback" },
      ],
    });
    expect(await runtime.preflightModel?.({
      model: "bad\u0000model",
      signal: new AbortController().signal,
    })).toMatchObject({ supported: false });
    const aborted = new AbortController();
    aborted.abort(new Error("preflight cancelled"));
    expect(() => runtime.preflightModel?.({
      model: "gpt-5.6-codex",
      signal: aborted.signal,
    })).toThrow("preflight cancelled");
    expect(runtime.validateModel).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses a bounded direct app-server protocol and returns native session linkage", async () => {
    const child = new FakeCodexProcess();
    const launch = runtimeLaunch([child]);
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("direct"),
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
      session: {
        id: "thread-1",
        conversationId: "conversation",
        route: {
          runtimeInstanceId: "codex-runtime",
          model: "gpt-5.6-codex",
        },
      },
    });
    expect(events).toContainEqual({ type: "text-delta", delta: "hello" });
    expect(child.requests.map((request) => request.method)).toEqual(expect.arrayContaining(["initialize", "thread/start", "turn/start"]));
    expect(child.requests.filter((request) =>
      request.method === "config/read")).toHaveLength(2);
    expect(child.requests).toContainEqual(expect.objectContaining({
      method: "config/read",
      params: {
        includeLayers: false,
        cwd: process.cwd(),
      },
    }));
    expect(child.requests).toContainEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "read-only",
        config: expect.objectContaining({
          approvals_reviewer: "user",
          hooks: expect.objectContaining({ PreToolUse: [], SessionStart: [] }),
          mcp_servers: {},
          notify: [],
          web_search: "disabled",
          apps: { _default: expect.objectContaining({ enabled: false }) },
          features: expect.objectContaining({
            apps: false,
            hooks: false,
            multi_agent: false,
            skill_search: false,
            web_search: false,
          }),
        }),
      }),
    }));
    expect(child.requests).toContainEqual(expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }),
    }));
    const actualLaunch = [...launch.mock.calls].reverse().find((call) =>
      call[1][0] === "app-server"
      && call[2].cwd !== call[2].env.CODEX_HOME);
    expect(actualLaunch).toBeDefined();
    const launchArgs = actualLaunch?.[1] ?? [];
    const launchOptions = actualLaunch?.[2];
    expect(launch).toHaveBeenCalledWith("codex", expect.arrayContaining(["app-server", "--listen", "stdio://", "--strict-config"]), expect.objectContaining({ shell: false }));
    expect(launchArgs).toEqual(expect.arrayContaining([
      "-c",
      'approvals_reviewer="user"',
      "hooks.PreToolUse=[]",
      "features.hooks=false",
      "features.skill_search=false",
      "notify=[]",
    ]));
    expect(launchOptions?.cwd).not.toBe(launchOptions?.env.CODEX_HOME);
    expect(launchOptions?.cwd).not.toBe(process.cwd());
    await expect(lstat(String(launchOptions?.cwd))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const containedHome = String(launchOptions?.env.CODEX_HOME);
    expect(containedHome).toBe(join(testDataDirectory("direct"), "codex-home"));
    expect((await lstat(containedHome)).mode & 0o777).toBe(0o700);
  });

  it("bridges v2 command approvals through Core before Codex continues", async () => {
    const fixture = approvalProcess(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-item-1",
        startedAtMs: Date.now(),
        command: "pnpm test",
        cwd: process.cwd(),
        reason: "Run the focused tests",
        networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: { writableRoots: [process.cwd()] },
        },
        availableDecisions: ["accept", "decline"],
      },
    );
    let pendingApproval: ApprovalRequest | undefined;
    let releaseApproval!: () => void;
    const requestApproval = vi.fn((request: ApprovalRequest) =>
      new Promise<{
        readonly interactionId: string;
        readonly decision: "allow_once";
        readonly decidedAt: string;
      }>((resolve) => {
        pendingApproval = request;
        releaseApproval = () => resolve({
          interactionId: request.interactionId,
          decision: "allow_once",
          decidedAt: new Date().toISOString(),
        });
      }));
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("command-approval"),
      spawnProcess: runtimeLaunch([fixture.child]),
    });
    await runtime.start?.({ signal: new AbortController().signal });

    const pendingResult = runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "test it" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
      requestApproval,
    });

    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());
    expect(fixture.child.requests.some((request) =>
      request.id === "server-approval-1"
      && request.method === undefined)).toBe(false);
    expect(pendingApproval).toBeDefined();
    releaseApproval();
    const result = await pendingResult;

    expect(result).toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "approved flow completed" }] },
    });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      callId: "command-item-1",
      toolId: "codex.command-escalation",
      displayName: "Codex command escalation",
      effects: ["read", "write", "execute", "network"],
      summary: expect.stringContaining("pnpm test"),
    }), expect.any(AbortSignal));
    expect(pendingApproval?.summary).toContain('"host":"registry.npmjs.org"');
    expect(pendingApproval?.summary).toContain('"writableRoots"');
    expect(pendingApproval?.summary).toContain(`"cwd":${JSON.stringify(process.cwd())}`);
    await expect(fixture.response).resolves.toEqual({
      id: "server-approval-1",
      result: { decision: "accept" },
    });
    expect(fixture.child.requests).toContainEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "read-only",
      }),
    }));
    expect(fixture.child.requests).toContainEqual(expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({ approvalPolicy: "on-request" }),
    }));
  });

  it.each([
    {
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-item-1",
        startedAtMs: Date.now(),
        reason: "Update source",
      },
      evidenceItem: {
        type: "fileChange",
        id: "file-item-1",
        changes: [{
          path: "src/index.ts",
          kind: "update",
          diff: "@@ -1 +1 @@",
        }],
        status: "inProgress",
      },
      expectedDecision: { decision: "decline" },
    },
    {
      method: "applyPatchApproval",
      params: {
        conversationId: "thread-1",
        callId: "legacy-file-item-1",
        fileChanges: { "src/index.ts": { type: "update" } },
        reason: "Update source",
        grantRoot: null,
      },
      evidenceItem: undefined,
      expectedDecision: {
        decision: {
          denied: { rejection: "Denied by mono-agent policy" },
        },
      },
    },
  ])("maps $method to the exact file escalation descriptor", async ({
    method,
    params,
    evidenceItem,
    expectedDecision,
  }) => {
    const fixture = approvalProcess(method, params, evidenceItem);
    const requestApproval = vi.fn(async (request: ApprovalRequest) => ({
      interactionId: request.interactionId,
      decision: "deny" as const,
      decidedAt: new Date().toISOString(),
      reason: "not approved",
    }));
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory(`file-approval-${method}`),
      spawnProcess: runtimeLaunch([fixture.child]),
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "edit" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
      requestApproval,
    });

    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "codex.file-change-escalation",
      displayName: "Codex file change escalation",
      effects: ["write"],
      summary: expect.stringContaining('"path":"src/index.ts"'),
    }), expect.any(AbortSignal));
    await expect(fixture.response).resolves.toEqual({
      id: "server-approval-1",
      result: expectedDecision,
    });
  });

  it("declines unexpected approval requests when Core exposes no callback", async () => {
    const fixture = approvalProcess(
      "item/fileChange/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-item-1",
        startedAtMs: Date.now(),
        reason: "Edit a file",
      },
    );
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("no-callback"),
      spawnProcess: runtimeLaunch([fixture.child]),
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "edit" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
    });

    await expect(fixture.response).resolves.toEqual({
      id: "server-approval-1",
      result: { decision: "decline" },
    });
    expect(fixture.child.requests).toContainEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({ approvalPolicy: "never" }),
    }));
  });

  it("fails legacy approval callbacks closed with a protocol denial", async () => {
    const fixture = approvalProcess(
      "execCommandApproval",
      {
        conversationId: "thread-1",
        callId: "legacy-command-1",
        approvalId: null,
        command: ["pnpm", "test"],
        cwd: process.cwd(),
        reason: "Run tests",
        parsedCmd: [],
      },
    );
    const requestApproval = vi.fn(async () => {
      throw new Error("approval backend unavailable");
    });
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("legacy-callback"),
      spawnProcess: runtimeLaunch([fixture.child]),
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
      requestApproval,
    });

    expect(requestApproval).toHaveBeenCalledOnce();
    await expect(fixture.response).resolves.toEqual({
      id: "server-approval-1",
      result: {
        decision: {
          denied: { rejection: "Denied by mono-agent policy" },
        },
      },
    });
  });

  it("never echoes a requested Codex permission escalation", async () => {
    const fixture = approvalProcess(
      "item/permissions/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permissions-item-1",
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: process.cwd(),
        reason: "Need broad access",
        permissions: {
          network: { enabled: true },
          fileSystem: { writableRoots: ["/"] },
        },
      },
    );
    const requestApproval = vi.fn();
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("permission-escalation"),
      spawnProcess: runtimeLaunch([fixture.child]),
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "escalate" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
      requestApproval,
    });

    expect(requestApproval).not.toHaveBeenCalled();
    await expect(fixture.response).resolves.toEqual({
      id: "server-approval-1",
      result: {
        permissions: {},
        scope: "turn",
        strictAutoReview: true,
      },
    });
  });

  it("rejects wrong session linkage before spawn and resumes only the exact route", async () => {
    const child = new FakeCodexProcess();
    const launch = runtimeLaunch([child]);
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("session-linkage"),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    const launchCountAfterStart = launch.mock.calls.length;
    const runtimeContext = {
      emit() {},
      async executeTool(call: { readonly id: string }) {
        return { callId: call.id, content: [] };
      },
    };
    const exactSession: RuntimeSession = {
      id: "thread-1",
      conversationId: "conversation",
      route: {
        runtimeInstanceId: "codex-runtime",
        model: "gpt-5.6-codex",
      },
    };
    const invalidSessions: RuntimeSession[] = [
      {
        ...exactSession,
        route: { ...exactSession.route, runtimeInstanceId: "other-runtime" },
      },
      {
        ...exactSession,
        route: { ...exactSession.route, model: "gpt-5.6-codex-other" },
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
        model: "gpt-5.6-codex",
        messages: [{ role: "user", content: [{ type: "text", text: "no spawn" }] }],
        tools: [],
        signal: new AbortController().signal,
        session,
      }, runtimeContext)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    }
    expect(launch).toHaveBeenCalledTimes(launchCountAfterStart);

    const result = await runtime.runTurn({
      turnId: "continued",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      tools: [],
      signal: new AbortController().signal,
      session: exactSession,
    }, runtimeContext);

    expect(result).toMatchObject({
      status: "completed",
      session: exactSession,
    });
    expect(launch).toHaveBeenCalledTimes(launchCountAfterStart + 4);
    expect(child.requests).toContainEqual(expect.objectContaining({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-1" }),
    }));
  });

  it("requires the exact supported Codex CLI before any provider process starts", async () => {
    const launch = runtimeLaunch([], { version: "codex-cli 0.146.0" });
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("version-mismatch"),
      spawnProcess: launch,
    });

    await expect(runtime.start?.({
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "RUNTIME_PREFLIGHT_FAILED",
      retryability: "not-retryable",
      sideEffects: "none",
      message: "runtime-codex requires exactly codex-cli 0.145.0",
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[1]).toEqual(["--version"]);
  });

  it("TOML-quotes hostile MCP names and proves every frozen server disabled", async () => {
    const hostileName = "dot.name \"quoted\" \\\\ newline\nnul\u0000 λ";
    const discovered = mcpJson([
      { name: hostileName, enabled: true },
      { name: "remote=server", enabled: true, transport: "streamable_http" },
    ]);
    const disabled = mcpJson([
      { name: hostileName, enabled: false },
      { name: "remote=server", enabled: false, transport: "streamable_http" },
    ]);
    const launch = runtimeLaunch([], { mcpOutputs: [discovered, disabled] });
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("hostile-mcp"),
      spawnProcess: launch,
    });

    await runtime.start?.({ signal: new AbortController().signal });

    const strictArgs = launch.mock.calls.find((call) =>
      call[1][0] === "app-server")?.[1] ?? [];
    const dynamicOverrides = strictArgs.filter((value) =>
      value.startsWith("mcp_servers={")
      && value !== "mcp_servers={}");
    expect(dynamicOverrides).toHaveLength(1);
    expect(dynamicOverrides[0]).toContain('\\"quoted\\"');
    expect(dynamicOverrides[0]).toContain("\\\\ newline\\nnul\\u0000 λ");
    expect(dynamicOverrides[0]).toContain(`${JSON.stringify("remote=server")}={enabled=false,required=false,url=`);
    expect(dynamicOverrides[0]).toContain('command="/usr/bin/false"');
  });

  it.each(["hostile user config", "hostile system config"])(
    "fails closed when %s remains enabled after its disable override",
    async () => {
      const server = { name: "ambient", enabled: true } as const;
      const launch = runtimeLaunch([], {
        mcpOutputs: [mcpJson([server]), mcpJson([server])],
      });
      const runtime = createRuntimeCodex({
        config: explicitConfig(),
        instanceId: "codex-runtime",
        workspaceDirectory: process.cwd(),
        dataDirectory: testDataDirectory(`enabled-mcp-${testRoot.length}`),
        spawnProcess: launch,
      });

      await expect(runtime.start?.({
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: "RUNTIME_PREFLIGHT_FAILED",
        sideEffects: "none",
        message: "runtime-codex could not disable every effective Codex MCP server",
      });
    },
  );

  it("bounds hostile MCP server names and server counts before encoding", async () => {
    const oversizedName = "x".repeat(257);
    const oversizedLaunch = runtimeLaunch([], {
      mcpOutputs: [mcpJson([{ name: oversizedName, enabled: true }])],
    });
    const oversizedRuntime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("oversized-mcp-name"),
      spawnProcess: oversizedLaunch,
    });
    await expect(oversizedRuntime.start?.({
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: "Codex MCP discovery preflight returned an invalid MCP server entry",
    });

    const tooMany = Array.from({ length: 65 }, (_, index) => ({
      name: `server-${index}`,
      enabled: true,
    }));
    const countLaunch = runtimeLaunch([], {
      mcpOutputs: [mcpJson(tooMany)],
    });
    const countRuntime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("oversized-mcp-count"),
      spawnProcess: countLaunch,
    });
    await expect(countRuntime.start?.({
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: "Codex MCP discovery preflight exceeded the MCP server-count limit",
    });
  });

  it("uses the canonical native CODEX_HOME when explicit auth is omitted", async () => {
    const nativeHome = join(testRoot, "native-codex-home");
    await mkdir(nativeHome, { mode: 0o755 });
    await chmod(nativeHome, 0o755);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = nativeHome;
    try {
      const launch = runtimeLaunch([]);
      const runtime = createRuntimeCodex({
        config: parseRuntimeCodexConfig({ requestTimeoutMs: 1_000 }),
        instanceId: "codex-runtime",
        workspaceDirectory: process.cwd(),
        dataDirectory: testDataDirectory("native-unused"),
        spawnProcess: launch,
      });

      await runtime.start?.({ signal: new AbortController().signal });
      expect(launch.mock.calls).not.toHaveLength(0);
      for (const call of launch.mock.calls) {
        expect(call[2].env.CODEX_HOME).toBe(nativeHome);
        expect(call[2].cwd).not.toBe(nativeHome);
      }
      expect((await lstat(nativeHome)).mode & 0o777).toBe(0o755);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it("rejects unsafe contained homes without repairing user-owned data", async () => {
    const dataDirectory = testDataDirectory("unsafe-mode");
    const home = join(dataDirectory, "codex-home");
    await mkdir(home, { recursive: true, mode: 0o755 });
    await chmod(home, 0o755);
    const launch = runtimeLaunch([]);
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory,
      spawnProcess: launch,
    });

    await expect(runtime.start?.({
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: expect.stringContaining("must have mode 0700"),
    });
    expect((await lstat(home)).mode & 0o777).toBe(0o755);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a symlinked contained home and an authored contained config", async () => {
    const target = join(testRoot, "symlink-target");
    await mkdir(target, { mode: 0o700 });
    const symlinkData = testDataDirectory("symlink-home");
    await mkdir(symlinkData, { recursive: true, mode: 0o700 });
    await symlink(target, join(symlinkData, "codex-home"));
    const symlinkRuntime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: symlinkData,
      spawnProcess: runtimeLaunch([]),
    });
    await expect(symlinkRuntime.start?.({
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: expect.stringContaining("not a symbolic link"),
    });

    const configData = testDataDirectory("authored-config");
    const configHome = join(configData, "codex-home");
    await mkdir(configHome, { recursive: true, mode: 0o700 });
    await writeFile(join(configHome, "config.toml"), "[mcp_servers.hostile]\ncommand = \"hostile\"\n", {
      mode: 0o600,
    });
    const configRuntime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: configData,
      spawnProcess: runtimeLaunch([]),
    });
    await expect(configRuntime.start?.({
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: expect.stringContaining("must not contain config.toml"),
    });
  });

  it("persists explicit-auth session state across runtime process restarts", async () => {
    const dataDirectory = testDataDirectory("persistent-session");
    const firstChild = new FakeCodexProcess();
    const firstLaunch = runtimeLaunch([firstChild]);
    const firstRuntime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory,
      spawnProcess: firstLaunch,
    });
    await firstRuntime.start?.({ signal: new AbortController().signal });
    const firstResult = await firstRuntime.runTurn({
      turnId: "first",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
    });
    const persistentHome = join(dataDirectory, "codex-home");
    await writeFile(join(persistentHome, "session-marker"), "persisted", {
      mode: 0o600,
    });
    await firstRuntime.stop?.({
      signal: new AbortController().signal,
      reason: "restart",
    });

    expect(await readFile(join(persistentHome, "session-marker"), "utf8")).toBe("persisted");
    if (firstResult.session === undefined) throw new Error("expected Codex session");
    const secondChild = new FakeCodexProcess();
    const secondLaunch = runtimeLaunch([secondChild]);
    const secondRuntime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory,
      spawnProcess: secondLaunch,
    });
    await secondRuntime.start?.({ signal: new AbortController().signal });
    await secondRuntime.runTurn({
      turnId: "second",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      tools: [],
      signal: new AbortController().signal,
      session: firstResult.session,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
    });

    expect(secondChild.requests).toContainEqual(expect.objectContaining({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-1" }),
    }));
    const secondActual = [...secondLaunch.mock.calls].reverse().find((call) =>
      call[1][0] === "app-server");
    expect(secondActual?.[2].env.CODEX_HOME).toBe(persistentHome);
  });

  it("maps a genuinely missing Codex continuation to the shared session code", async () => {
    const child = new FakeCodexProcess((request, process) => {
      if (request.method !== "thread/resume") return false;
      process.send({
        id: request.id,
        error: {
          code: -32600,
          message: "no rollout found for thread id missing-thread",
        },
      });
      return true;
    });
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("missing-session"),
      spawnProcess: runtimeLaunch([child]),
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await expect(runtime.runTurn({
      turnId: "continued",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      tools: [],
      signal: new AbortController().signal,
      session: {
        id: "missing-thread",
        conversationId: "conversation",
        route: {
          runtimeInstanceId: "codex-runtime",
          model: "gpt-5.6-codex",
        },
      },
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
    })).rejects.toMatchObject({
      code: RUNTIME_SESSION_UNAVAILABLE_CODE,
      retryability: "not-retryable",
      sideEffects: "none",
    });
  });

  it("re-discovers per process and blocks a newly effective app-server MCP", async () => {
    let configReadCount = 0;
    const child = new FakeCodexProcess((request, process) => {
      if (request.method !== "config/read") return false;
      configReadCount += 1;
      process.send({
        id: request.id,
        result: {
          config: {
            mcp_servers: {
              known: {
                enabled: false,
                command: "/usr/bin/false",
                args: [],
              },
              ...(configReadCount === 1
                ? {}
                : {
                    "appeared-after-preflight": {
                      enabled: true,
                      command: "hostile",
                    },
                  }),
            },
          },
        },
      });
      return true;
    });
    const server = { name: "known", enabled: true } as const;
    const disabled = { ...server, enabled: false } as const;
    const launch = runtimeLaunch([child], {
      mcpOutputs: [
        "[]\n",
        "[]\n",
        mcpJson([server]),
        mcpJson([disabled]),
      ],
    });
    const runtime = createRuntimeCodex({
      config: explicitConfig(),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("mcp-config-change"),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });

    await expect(runtime.runTurn({
      turnId: "turn",
      conversationId: "conversation",
      model: "gpt-5.6-codex",
      messages: [{ role: "user", content: [{ type: "text", text: "no MCP" }] }],
      tools: [],
      signal: new AbortController().signal,
    }, {
      emit() {},
      async executeTool(call) { return { callId: call.id, content: [] }; },
    })).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
      sideEffects: "none",
      message: "Codex app-server MCP config changed after containment preflight",
    });
    expect(child.requests.map((request) => request.method)).not.toContain("thread/start");
    expect(configReadCount).toBe(2);
    const actualArgs = [...launch.mock.calls].reverse().find((call) =>
      call[1][0] === "app-server")?.[1] ?? [];
    expect(actualArgs.some((argument) =>
      argument.startsWith("mcp_servers={")
      && argument.includes('"known"={enabled=false'))).toBe(true);
  });

  it("never attaches an unredacted provider error as a cause", async () => {
    const secret = "sk-secret";
    const providerError = new Error(`Bearer ${secret}`);
    const baseLaunch = runtimeLaunch([]);
    let failActual = false;
    const launch = vi.fn<SpawnProcess>((command, args, options) => {
      if (failActual && args[0] === "app-server") throw providerError;
      return baseLaunch(command, args, options);
    });
    const runtime = createRuntimeCodex({
      config: explicitConfig({ auth: { apiKey: secret } }),
      instanceId: "codex-runtime",
      workspaceDirectory: process.cwd(),
      dataDirectory: testDataDirectory("redacted-cause"),
      spawnProcess: launch,
    });
    await runtime.start?.({ signal: new AbortController().signal });
    failActual = true;

    let failure: unknown;
    try {
      await runtime.runTurn({
        turnId: "turn",
        conversationId: "conversation",
        model: "gpt-5.6-codex",
        messages: [{ role: "user", content: [{ type: "text", text: "fail" }] }],
        tools: [],
        signal: new AbortController().signal,
      }, {
        emit() {},
        async executeTool(call) { return { callId: call.id, content: [] }; },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeCodexError);
    const typed = failure as RuntimeCodexError & { readonly cause?: unknown };
    expect(typed.message).not.toContain(secret);
    expect(typed.cause).toBeInstanceOf(Error);
    expect(typed.cause).not.toBe(providerError);
    expect((typed.cause as Error).message).not.toContain(secret);
    expect((typed.cause as Error).message).toContain("[REDACTED]");
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

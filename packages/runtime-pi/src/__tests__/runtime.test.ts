import { createServer, type Server } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  ApprovalRequest,
  ModuleStopReason,
  Runtime,
  RuntimeToolCall,
  RuntimeTurnContext,
  RuntimeTurnEvent,
  RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import {
  AGENT_INTERACTION_LIMITS,
  RUNTIME_SESSION_UNAVAILABLE_CODE,
} from "@mono-agent/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRuntimePiConfig } from "../config.js";
import {
  createRuntimePi,
  isCheckedTransientProviderFailure,
  RuntimePiError,
} from "../runtime.js";

const abortSignal = () => new AbortController().signal;
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

function turnContext(
  executeTool = vi.fn<RuntimeTurnContext["executeTool"]>(),
  options: {
    readonly omitApproval?: boolean;
    readonly requestApproval?: NonNullable<RuntimeTurnContext["requestApproval"]>;
  } = {},
): {
  context: RuntimeTurnContext;
  events: RuntimeTurnEvent[];
} {
  const events: RuntimeTurnEvent[] = [];
  const requestApproval = options.requestApproval ?? (async (approval: ApprovalRequest) => ({
    interactionId: approval.interactionId,
    decision: "allow_once" as const,
    decidedAt: new Date().toISOString(),
  }));
  return {
    events,
    context: {
      async emit(event) { events.push(event); },
      executeTool,
      ...(options.omitApproval === true ? {} : { requestApproval }),
    },
  };
}

function fauxRuntime(options: { tokensPerSecond?: number; authPath?: string; attachments?: boolean } = {}): {
  runtime: Runtime;
  faux: ReturnType<typeof fauxProvider>;
  models: Models;
} {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning: true, input: options.attachments ? ["text", "image"] : ["text"] }],
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
  it("retries only explicit own transient provider status and transport codes", () => {
    expect(isCheckedTransientProviderFailure({ status: 503 })).toBe(true);
    expect(isCheckedTransientProviderFailure({ statusCode: 429 })).toBe(true);
    expect(isCheckedTransientProviderFailure({ code: "ECONNRESET" })).toBe(true);
    expect(isCheckedTransientProviderFailure({ status: 401 })).toBe(false);
    expect(isCheckedTransientProviderFailure(new Error("HTTP 503"))).toBe(false);
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "status", {
      get() {
        getterCalls += 1;
        return 503;
      },
    });
    expect(isCheckedTransientProviderFailure(accessor)).toBe(false);
    expect(getterCalls).toBe(0);
  });

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
    expect(first.session).toMatchObject({
      conversationId: "conversation-1",
      route: {
        runtimeInstanceId: "test-runtime",
        model: "faux:faux-model",
      },
      metadata: { provider: "pi", nativeProvider: "faux" },
    });
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
    expect(second.session).toMatchObject({
      conversationId: "conversation-1",
      route: {
        runtimeInstanceId: "test-runtime",
        model: "faux:faux-model",
      },
    });
    await stop(runtime);
  });

  it("labels normalized attachments with their trusted ids without inventing filesystem paths", async () => {
    const { runtime, faux } = fauxRuntime({ attachments: true });
    let providerMessages = "";
    faux.setResponses([(context) => {
      providerMessages = JSON.stringify(context.messages);
      return fauxAssistantMessage([fauxText("attachments visible")]);
    }]);
    await start(runtime);
    await runtime.runTurn(request("inspect", {
      messages: [{
        role: "user",
        content: [{
          type: "attachment",
          attachment: {
            id: "trusted-file", kind: "file", name: "notes.txt", mediaType: "text/plain",
            sizeBytes: 3, data: new Uint8Array([111, 110, 101]),
          },
        }, {
          type: "attachment",
          attachment: {
            id: "trusted-image", kind: "image", name: "scan.png", mediaType: "image/png",
            sizeBytes: 3, data: new Uint8Array([1, 2, 3]),
          },
        }],
      }],
    }), turnContext().context);
    expect(providerMessages).toContain("trusted-file");
    expect(providerMessages).toContain("trusted-image");
    expect(providerMessages).toContain("attachment_id=");
    expect(providerMessages).not.toContain(".mono-agent/data/core/mcp-runs");
    await stop(runtime);
  });

  it("keeps provider-native tool order aligned with preflight authority", async () => {
    const { runtime, faux } = fauxRuntime();
    let providerToolNames: string[] = [];
    faux.setResponses([
      (context) => {
        providerToolNames = context.tools?.map((tool) => tool.name) ?? [];
        return fauxAssistantMessage([fauxText("ordered")]);
      },
    ]);
    await start(runtime);
    const preflight = await runtime.preflightModel?.({
      model: "faux:faux-model",
      signal: abortSignal(),
    });
    await expect(runtime.runTurn(request("tool order"), turnContext().context))
      .resolves.toMatchObject({ status: "completed" });
    expect(providerToolNames).toEqual(preflight?.nativeTools?.map((tool) => tool.id));
    await stop(runtime);
  });

  it("exposes Core-owned MemoryRecall through Pi and emits normalized tool events", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("MemoryRecall", { query: "durable preference" }, { id: "call-1" })]),
      fauxAssistantMessage([fauxText("tool complete")]),
    ]);
    const executeTool = vi.fn(async (call: RuntimeToolCall, _signal: AbortSignal) => ({
      callId: call.id,
      content: [{ type: "json" as const, value: { records: [{ text: "concise output" }] } }],
    }));
    const { context, events } = turnContext(executeTool);
    await start(runtime);
    const result = await runtime.runTurn(request("use the tool", {
      tools: [{
        name: "MemoryRecall",
        description: "Recall durable memory.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string" } },
        },
      }],
    }), context);

    expect(result.message?.content).toContainEqual({ type: "text", text: "tool complete" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0]).toEqual({
      id: "call-1",
      name: "MemoryRecall",
      input: { query: "durable preference" },
    });
    expect(executeTool.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(events).toContainEqual({
      type: "tool-call",
      call: {
        id: "call-1",
        name: "MemoryRecall",
        input: { query: "durable preference" },
      },
    });
    expect(events.some((event) => event.type === "tool-result")).toBe(true);
    await stop(runtime);
  });

  it("executes Core-owned AskUser through Pi and continues with its structured answer", async () => {
    const { runtime, faux } = fauxRuntime();
    const questions = [{
      id: "tone",
      prompt: "Which tone should I use?",
      choices: [
        { value: "concise", label: "Concise", description: "Keep it short." },
        { value: "detailed", label: "Detailed" },
      ],
      allowFreeText: false,
      multiple: false,
    }, {
      id: "notes",
      prompt: "Any other constraints?",
      allowFreeText: true,
      multiple: false,
    }];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("AskUser", { questions }, { id: "ask-1" })]),
      (providerContext) => fauxAssistantMessage([fauxText(
        JSON.stringify(providerContext.messages).includes("No jargon.")
          ? "structured answer observed"
          : "structured answer missing",
      )]),
    ]);
    const executeTool = vi.fn(async (call: RuntimeToolCall, signal: AbortSignal) => {
      signal.throwIfAborted();
      return {
        callId: call.id,
        content: [{
          type: "json" as const,
          value: {
            interactionId: "interaction-1",
            answers: { tone: ["concise"], notes: ["No jargon."] },
            answeredAt: "2026-07-24T00:00:00.000Z",
          },
        }],
      };
    });
    const { context, events } = turnContext(executeTool);
    await start(runtime);
    const result = await runtime.runTurn(request("ask before answering", {
      tools: [{
        name: "AskUser",
        description: "Ask the user and wait for a structured answer.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["questions"],
          properties: { questions: { type: "array", minItems: 1, maxItems: 3 } },
        },
      }],
    }), context);

    expect(result.message?.content).toContainEqual({ type: "text", text: "structured answer observed" });
    expect(executeTool).toHaveBeenCalledWith({
      id: "ask-1",
      name: "AskUser",
      input: { questions },
    }, expect.any(AbortSignal));
    expect(events).toContainEqual({
      type: "tool-call",
      call: { id: "ask-1", name: "AskUser", input: { questions } },
    });
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        callId: "ask-1",
        content: [{
          type: "json",
          value: {
            interactionId: "interaction-1",
            answers: { tone: ["concise"], notes: ["No jargon."] },
            answeredAt: "2026-07-24T00:00:00.000Z",
          },
        }],
      },
    });
    await stop(runtime);
  });

  it("uses a terminating schema-constrained Pi tool for structured output", async () => {
    const { runtime, faux } = fauxRuntime();
    let maxTokens: number | undefined;
    const providerAttempt = vi.fn((_providerContext, _streamOptions, _state, model) => {
      maxTokens = model.maxTokens;
      return fauxAssistantMessage([
        fauxToolCall("mono_agent_structured_output", {
          records: [{ text: "A durable fact." }],
        }, { id: "structured-1" }),
      ]);
    });
    faux.setResponses([providerAttempt]);
    const executeTool = vi.fn<RuntimeTurnContext["executeTool"]>();
    const { context, events } = turnContext(executeTool, { omitApproval: true });
    await start(runtime);

    const result = await runtime.runTurn(request("extract memory", {
      options: {
        maxOutputTokens: 321,
        responseSchema: {
          type: "object",
          additionalProperties: false,
          required: ["records"],
          properties: {
            records: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text"],
                properties: { text: { type: "string" } },
              },
            },
          },
        },
      },
    }), context);

    expect(result).toMatchObject({
      status: "completed",
      structuredOutput: { records: [{ text: "A durable fact." }] },
    });
    expect(providerAttempt).toHaveBeenCalledTimes(1);
    expect(maxTokens).toBe(321);
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.some((event) =>
      (event.type === "tool-call" && event.call.name === "mono_agent_structured_output")
      || (event.type === "tool-result" && event.result.callId === "structured-1"))).toBe(false);
    await stop(runtime);
  });

  it("fails closed when a structured-output turn does not submit the schema tool", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([fauxAssistantMessage([fauxText("loose JSON is not accepted")])]);
    await start(runtime);

    await expect(runtime.runTurn(request("extract memory", {
      options: {
        responseSchema: {
          type: "object",
          required: ["records"],
          properties: { records: { type: "array" } },
        },
      },
    }), turnContext(undefined, { omitApproval: true }).context)).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
      message: "Pi completed without the required structured output.",
      retryable: false,
    });
    await stop(runtime);
  });

  it("advertises and executes the governed run-scoped NodeRepl through Pi", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("NodeRepl", {
        code: "const answer = 40",
      }, { id: "repl-1" })]),
      fauxAssistantMessage([fauxToolCall("NodeRepl", {
        code: "answer + 2",
      }, { id: "repl-2" })]),
      fauxAssistantMessage([fauxText("tool complete")]),
    ]);
    const requestApproval = vi.fn<NonNullable<RuntimeTurnContext["requestApproval"]>>(
      async (approval) => ({
        interactionId: approval.interactionId,
        decision: "allow_once",
        decidedAt: new Date().toISOString(),
      }),
    );
    const { context, events } = turnContext(undefined, { requestApproval });
    await start(runtime);

    const result = await runtime.runTurn(request("calculate in Node"), context);

    expect(result).toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "tool complete" }] },
    });
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(requestApproval.mock.calls.map(([approval]) => approval)).toEqual([
      expect.objectContaining({
        callId: "repl-1",
        toolId: "NodeRepl",
        displayName: "Node REPL",
        effects: ["read", "write", "execute", "network"],
      }),
      expect.objectContaining({
        callId: "repl-2",
        toolId: "NodeRepl",
        displayName: "Node REPL",
        effects: ["read", "write", "execute", "network"],
      }),
    ]);
    expect(new Set(requestApproval.mock.calls.map(([approval]) => approval.interactionId)).size).toBe(2);
    const approvals = requestApproval.mock.calls.map(([approval]) => approval);
    for (const [approval, signal] of requestApproval.mock.calls) {
      expect(approval.summary).toContain(
        "unsandboxed access to the inherited process environment, filesystem, subprocess execution, and network",
      );
      expect(approval.summary).toMatch(
        /Code evidence: \d+ UTF-8 bytes; sha256:[0-9a-f]{64}\./u,
      );
      expect(approval.summary).toContain("bytes, complete)");
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(approvals[0]?.summary).toContain(JSON.stringify("const answer = 40"));
    expect(approvals[1]?.summary).toContain(JSON.stringify("answer + 2"));
    expect(approvals[0]?.summary).not.toBe(approvals[1]?.summary);
    const digests = approvals.map((approval) =>
      /sha256:([0-9a-f]{64})/u.exec(approval.summary)?.[1]);
    expect(digests[0]).toBeDefined();
    expect(digests[1]).toBeDefined();
    expect(digests[0]).not.toBe(digests[1]);
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        callId: "repl-1",
        content: [{ type: "text", text: "undefined" }],
      },
    });
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        callId: "repl-2",
        content: [{ type: "text", text: "42" }],
      },
    });
    await stop(runtime);
  });

  it("executes approved Bash for composite Pi call ids without changing result identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-composite-bash-"));
    roots.push(root);
    const firstMarker = join(root, "first-executed.txt");
    const secondMarker = join(root, "second-executed.txt");
    const compositeCallId = "call_TerraApprovalProbe123|fc_0ea6d06dbcf4ce22";
    const validCollisionCandidate =
      "pi-call-9143b1b46edac8943eac571a46464b59655bdaef6f3b895ed82bc7d1812fec16";
    const command = (marker: string, output: string): string => {
      const script = [
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`,
        `process.stdout.write(${JSON.stringify(output)})`,
      ].join(";");
      return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    };
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text"] }],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Bash", {
        command: command(firstMarker, "first Bash completed"),
        timeout: 30_000,
        workdir: root,
        max_output_chars: 1_024,
      }, { id: compositeCallId })]),
      fauxAssistantMessage([fauxToolCall("Bash", {
        command: command(secondMarker, "second Bash completed"),
        timeout: 30_000,
        workdir: root,
        max_output_chars: 1_024,
      }, { id: validCollisionCandidate })]),
      fauxAssistantMessage([fauxText("bash observed")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({}),
      instanceId: "composite-bash-runtime",
      configDirectory: root,
      workspaceDirectory: root,
      models,
    });
    const requestApproval = vi.fn<NonNullable<RuntimeTurnContext["requestApproval"]>>(
      async (approval) => ({
        interactionId: approval.interactionId,
        decision: "allow_once",
        decidedAt: new Date().toISOString(),
      }),
    );
    const { context, events } = turnContext(undefined, { requestApproval });
    await start(runtime);

    await expect(runtime.runTurn(request("run both Bash calls"), context))
      .resolves.toMatchObject({
        status: "completed",
        message: { content: [{ type: "text", text: "bash observed" }] },
      });

    expect(await readFile(firstMarker, "utf8")).toBe("executed");
    expect(await readFile(secondMarker, "utf8")).toBe("executed");
    expect(requestApproval).toHaveBeenCalledTimes(2);
    const approvals = requestApproval.mock.calls.map(([approval]) => approval);
    expect(approvals[0]).toMatchObject({
      callId: validCollisionCandidate,
      toolId: "Bash",
      displayName: "Bash",
      effects: ["read", "write", "execute", "network"],
    });
    expect(approvals[0]?.callId).not.toBe(compositeCallId);
    expect(approvals[1]?.callId).toMatch(/^pi-call-escaped-[0-9a-f]{64}$/u);
    expect(approvals[1]?.callId).not.toBe(validCollisionCandidate);
    expect(new Set(approvals.map((approval) => approval.callId)).size).toBe(2);
    expect(new Set(approvals.map((approval) => approval.interactionId)).size).toBe(2);
    for (const approval of approvals) {
      expect(approval.callId.length)
        .toBeLessThanOrEqual(AGENT_INTERACTION_LIMITS.identifierCharacters);
      expect(approval.callId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
    }
    for (const [callId, output] of [
      [compositeCallId, "first Bash completed"],
      [validCollisionCandidate, "second Bash completed"],
    ] as const) {
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool-call",
        call: expect.objectContaining({ id: callId, name: "Bash" }),
      }));
      const resultEvent = events.find(
        (event) => event.type === "tool-result" && event.result.callId === callId,
      );
      expect(resultEvent).toEqual(expect.objectContaining({
        type: "tool-result",
        result: expect.objectContaining({
          callId,
          content: [expect.objectContaining({
            type: "text",
            text: expect.stringContaining(output),
          })],
        }),
      }));
      if (resultEvent?.type === "tool-result") {
        expect(resultEvent.result.isError).not.toBe(true);
      }
    }
    await stop(runtime);
  });

  it("fails closed before provider access when Core omits native-tool approval authority", async () => {
    const { runtime, faux } = fauxRuntime();
    const providerAttempt = vi.fn(() => fauxAssistantMessage([fauxText("must not run")]));
    faux.setResponses([providerAttempt]);
    await start(runtime);

    await expect(runtime.runTurn(
      request("do not dispatch"),
      turnContext(undefined, { omitApproval: true }).context,
    )).rejects.toMatchObject({
      code: "UNSUPPORTED",
      committedSideEffects: false,
      retryable: false,
    });
    expect(providerAttempt).not.toHaveBeenCalled();
    await stop(runtime);
  });

  it("denies NodeRepl before execution when Core refuses the native-tool approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-node-repl-denied-"));
    roots.push(root);
    const marker = join(root, "must-not-exist.txt");
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text"] }],
    });
    const deniedCode = [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe");`,
      `// ${"x".repeat(2_000)}`,
    ].join("\n");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("NodeRepl", {
        code: deniedCode,
      }, { id: "repl-denied" })]),
      (providerContext) => fauxAssistantMessage([
        fauxText(JSON.stringify(providerContext.messages).includes("Node REPL execution was denied")
          ? "denial observed"
          : "denial missing"),
      ]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({}),
      instanceId: "denied-runtime",
      configDirectory: root,
      workspaceDirectory: root,
      models,
    });
    const requestApproval = vi.fn<NonNullable<RuntimeTurnContext["requestApproval"]>>(
      async (approval) => ({
        interactionId: approval.interactionId,
        decision: "deny",
        decidedAt: new Date().toISOString(),
      }),
    );
    await start(runtime);

    await expect(runtime.runTurn(
      request("try the denied tool"),
      turnContext(undefined, { requestApproval }).context,
    )).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "denial observed" }] },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const approval = requestApproval.mock.calls[0]?.[0];
    expect(approval?.summary).toContain(JSON.stringify(deniedCode.slice(0, 1_024)));
    expect(approval?.summary).toContain(
      `Escaped preview (1024/${String(Buffer.byteLength(deniedCode, "utf8"))} bytes, truncated)`,
    );
    expect(approval?.summary).toMatch(
      /Code evidence: \d+ UTF-8 bytes; sha256:[0-9a-f]{64}\./u,
    );
    await stop(runtime);
  });

  it("denies Edit and WebSearch before filesystem or network effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-native-denied-"));
    roots.push(root);
    const target = join(root, "editable.txt");
    await writeFile(target, "before", "utf8");
    const fetchAttempt = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("network must not be reached"),
    );
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text"] }],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Edit", {
        file_path: "editable.txt",
        old_string: "before",
        new_string: "after",
        replace_all: false,
      }, { id: "edit-denied" })]),
      fauxAssistantMessage([fauxToolCall("WebSearch", {
        query: "exact denied query",
        limit: 3,
      }, { id: "search-denied" })]),
      fauxAssistantMessage([fauxText("denials observed")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({}),
      instanceId: "native-denied-runtime",
      configDirectory: root,
      workspaceDirectory: root,
      models,
    });
    const requestApproval = vi.fn<NonNullable<RuntimeTurnContext["requestApproval"]>>(
      async (approval) => ({
        interactionId: approval.interactionId,
        decision: "deny",
        decidedAt: new Date().toISOString(),
      }),
    );
    await start(runtime);

    await expect(runtime.runTurn(
      request("try denied native tools"),
      turnContext(undefined, { requestApproval }).context,
    )).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "denials observed" }] },
    });

    expect(await readFile(target, "utf8")).toBe("before");
    expect(fetchAttempt).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledTimes(2);
    const [editApproval, searchApproval] = requestApproval.mock.calls.map(
      ([approval]) => approval,
    );
    expect(editApproval).toMatchObject({
      callId: "edit-denied",
      toolId: "Edit",
      effects: ["read", "write"],
    });
    expect(editApproval?.summary).toContain("file_path: \"editable.txt\"");
    expect(editApproval?.summary).toContain("replace_all: false");
    expect(editApproval?.summary).toMatch(
      /old_string evidence: 6 UTF-8 bytes; sha256:[0-9a-f]{64}\./u,
    );
    expect(editApproval?.summary).toMatch(
      /new_string evidence: 5 UTF-8 bytes; sha256:[0-9a-f]{64}\./u,
    );
    expect(searchApproval).toMatchObject({
      callId: "search-denied",
      toolId: "WebSearch",
      effects: ["network"],
    });
    expect(searchApproval?.summary).toContain("query: \"exact denied query\"");
    expect(searchApproval?.summary).toContain("limit: 3");
    expect(searchApproval?.summary).toMatch(
      /query evidence: 18 UTF-8 bytes; sha256:[0-9a-f]{64}\./u,
    );
    await stop(runtime);
  });

  it("executes approved literal Edit and checked WebSearch through Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-native-approved-"));
    roots.push(root);
    const target = join(root, "editable.txt");
    await writeFile(target, "one literal value", "utf8");
    const searchResponse = new Response([
        "<html><div class=\"results\">",
        "<a class=\"result__a\" href=\"https://example.com/result\">Exact result</a>",
        "<div class=\"result__snippet\">Bounded summary.</div>",
        "</div></html>",
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    Object.defineProperty(searchResponse, "url", {
      value: "https://html.duckduckgo.com/html/?q=approved%20query",
    });
    const fetchAttempt = vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse);
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text"] }],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Edit", {
        file_path: "editable.txt",
        old_string: "literal",
        new_string: "atomic",
        replace_all: false,
      }, { id: "edit-approved" })]),
      fauxAssistantMessage([fauxToolCall("WebSearch", {
        query: "approved query",
        limit: 1,
      }, { id: "search-approved" })]),
      fauxAssistantMessage([fauxText("native tools complete")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({}),
      instanceId: "native-approved-runtime",
      configDirectory: root,
      workspaceDirectory: root,
      models,
    });
    const requestApproval = vi.fn<NonNullable<RuntimeTurnContext["requestApproval"]>>(
      async (approval) => ({
        interactionId: approval.interactionId,
        decision: "allow_once",
        decidedAt: new Date().toISOString(),
      }),
    );
    const { context, events } = turnContext(undefined, { requestApproval });
    await start(runtime);

    await expect(runtime.runTurn(
      request("use approved native tools"),
      context,
    )).resolves.toMatchObject({
      status: "completed",
      message: { content: [{ type: "text", text: "native tools complete" }] },
    });

    expect(await readFile(target, "utf8")).toBe("one atomic value");
    expect(fetchAttempt).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls.map(([approval]) => approval.toolId))
      .toEqual(["Edit", "WebSearch"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool-result",
      result: expect.objectContaining({
        callId: "edit-approved",
        content: [expect.objectContaining({
          type: "text",
          text: expect.stringContaining("1 literal replacement"),
        })],
      }),
    }));
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        callId: "search-approved",
        content: [{
          type: "text",
          text: "Exact result\nhttps://example.com/result\nBounded summary.",
        }],
      },
    });
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
    const providerAttempt = vi.fn(() => fauxAssistantMessage("unused"));
    faux.setResponses([providerAttempt]);
    expect(runtime.capabilities).toMatchObject({
      approvals: true,
      sandbox: false,
      structuredOutput: true,
      maxOutputTokens: true,
    });
    await expect(runtime.runTurn(request("not started"), turnContext().context))
      .rejects.toMatchObject({ code: "RUNTIME_NOT_RUNNING" });
    await start(runtime);
    expect(runtime.validateModel).toBeUndefined();
    expect(await runtime.preflightModel?.({ model: "bad-reference", signal: abortSignal() }))
      .toMatchObject({ supported: false });
    expect(await runtime.preflightModel?.({ model: "faux:faux-model", signal: abortSignal() })).toMatchObject({
      supported: true,
      capabilities: {
        attachments: false,
        approvals: true,
        sandbox: false,
        sessions: true,
        liveInput: true,
        structuredOutput: true,
        maxOutputTokens: true,
      },
      nativeTools: [{
        id: "NodeRepl",
        displayName: "Node REPL",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Read",
        displayName: "Read",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Write",
        displayName: "Write",
        effects: ["write"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Edit",
        displayName: "Edit",
        effects: ["read", "write"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Glob",
        displayName: "Glob",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Grep",
        displayName: "Grep",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "Bash",
        displayName: "Bash",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "WebFetch",
        displayName: "Web Fetch",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }, {
        id: "WebSearch",
        displayName: "Web Search",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "unsupported",
      }],
    });
    const aborted = new AbortController();
    aborted.abort(new Error("preflight cancelled"));
    await expect(runtime.preflightModel?.({
      model: "faux:faux-model",
      signal: aborted.signal,
    })).rejects.toThrow("preflight cancelled");
    await expect(runtime.runTurn(request("bad model", { model: "faux:missing" }), turnContext().context))
      .rejects.toMatchObject({ code: "MODEL_INVALID" });
    const exactSession = {
      id: "native-session",
      conversationId: "conversation-1",
      route: {
        runtimeInstanceId: "test-runtime",
        model: "faux:faux-model",
      },
    } as const;
    const wrongSessions = [
      {
        ...exactSession,
        route: { ...exactSession.route, runtimeInstanceId: "other-runtime" },
      },
      {
        ...exactSession,
        route: { ...exactSession.route, model: "faux:other-model" },
      },
      {
        ...exactSession,
        conversationId: "other-conversation",
      },
    ];
    for (const session of wrongSessions) {
      await expect(runtime.runTurn(request("wrong linkage", {
        session,
      }), turnContext().context)).rejects.toMatchObject({
        code: "SESSION_INVALID",
        retryable: false,
      });
    }
    expect(providerAttempt).not.toHaveBeenCalled();
    await stop(runtime);
    await expect(runtime.runTurn(request("stopped"), turnContext().context))
      .rejects.toBeInstanceOf(RuntimePiError);
  });

  it("classifies typed model-discovery failures for safe fallback", async () => {
    for (const [status, retryable] of [[503, true], [401, false]] as const) {
      const fetchAttempt = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("", { status }),
      );
      const runtime = createRuntimePi({
        config: parseRuntimePiConfig({
          localProviders: [{
            id: "fixture",
            baseUrl: "http://127.0.0.1:1/v1",
          }],
        }),
        instanceId: `discovery-${String(status)}`,
        configDirectory: process.cwd(),
        workspaceDirectory: process.cwd(),
      });
      await start(runtime);
      await expect(runtime.runTurn(
        request("discover", { model: "fixture:model" }),
        turnContext().context,
      )).rejects.toMatchObject({
        code: "PROVIDER_FAILED",
        retryable,
        committedSideEffects: false,
      });
      expect(fetchAttempt).toHaveBeenCalledTimes(1);
      fetchAttempt.mockRestore();
      await stop(runtime);
    }
  });

  it("fails startup before reporting healthy when persistent state is unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-startup-reconcile-"));
    roots.push(root);
    const sessionsRoot = join(root, "sessions");
    await mkdir(sessionsRoot, { mode: 0o755 });
    await chmod(sessionsRoot, 0o755);
    const { models } = fauxRuntime();
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({ sessions: { root: sessionsRoot } }),
      instanceId: "unsafe-startup",
      configDirectory: root,
      workspaceDirectory: root,
      models,
    });

    await expect(start(runtime)).rejects.toThrow("mode must be exactly 0700");
    expect(await runtime.health?.({ signal: abortSignal() })).toMatchObject({
      status: "unknown",
      details: { state: "created" },
    });
    await stop(runtime);
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
    expect((await readdir(join(configDirectory, "sessions"), { recursive: true }))
      .filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(1);
    await expect(readdir(join(workspaceDirectory, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts auth-store secrets from provider failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-error-redaction-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    await writeFile(authPath, JSON.stringify({ faux: { type: "api_key", key: "sk-secret-provider-payload" } }), { mode: 0o600 });
    await chmod(authPath, 0o600);
    const { runtime, faux } = fauxRuntime({ authPath });
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider rejected sk-secret-provider-payload" }),
    ]);
    await start(runtime);
    let error: unknown;
    try {
      await runtime.runTurn(request("fail"), turnContext().context);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimePiError);
    expect((error as Error).message).not.toContain("sk-secret-provider-payload");
    expect((error as Error).message).toContain("[REDACTED]");
    const cause = (error as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).name).toBe("RuntimePiCause");
    expect((cause as Error).message).toContain("[REDACTED]");
    expect((cause as Error).message).not.toContain("sk-secret-provider-payload");
    expect((cause as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(cause))).not.toContain(
      "sk-secret-provider-payload",
    );
    await stop(runtime);
  });

  it("redacts credentials rotated during a failing provider request", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-rotated-redaction-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({ faux: { type: "api_key", key: "sk-before-rotation" } }),
      { mode: 0o600 },
    );
    await chmod(authPath, 0o600);
    const { runtime, faux } = fauxRuntime({ authPath });
    faux.setResponses([
      async () => {
        await writeFile(
          authPath,
          JSON.stringify({ faux: { type: "api_key", key: "sk-after-rotation" } }),
        );
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "provider rejected sk-after-rotation",
        });
      },
    ]);
    await start(runtime);

    let failure: unknown;
    try {
      await runtime.runTurn(request("rotate then fail"), turnContext().context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimePiError);
    expect((failure as Error).message).toContain("[REDACTED]");
    expect((failure as Error).message).not.toContain("sk-after-rotation");
    expect(((failure as Error & { cause?: Error }).cause?.message ?? ""))
      .not.toContain("sk-after-rotation");
    await stop(runtime);
  });

  it("emits no session linkage before persistent data commits durably", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-durable-linkage-"));
    roots.push(root);
    const sessionsRoot = join(root, "sessions");
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text"] }],
    });
    faux.setResponses([
      async () => {
        const sessionEntry = (await readdir(sessionsRoot, { recursive: true }))
          .find((entry) => entry.endsWith(".jsonl"));
        if (sessionEntry === undefined) throw new Error("session fixture was not materialized");
        const sessionPath = join(sessionsRoot, sessionEntry);
        const bytes = await readFile(sessionPath);
        await writeFile(sessionPath, bytes.subarray(0, bytes.byteLength - 1));
        return fauxAssistantMessage([fauxText("must not commit")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createRuntimePi({
      config: parseRuntimePiConfig({ sessions: { root: sessionsRoot } }),
      instanceId: "durable-linkage",
      configDirectory: root,
      workspaceDirectory: root,
      models,
    });
    const { context, events } = turnContext();
    await start(runtime);

    await expect(runtime.runTurn(request("corrupt commit"), context))
      .rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(events.some((event) => event.type === "session")).toBe(false);
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
      retryable: false,
    });
    await stop(runtime);
  });

  it("classifies a genuinely missing backing session for canonical replay", async () => {
    const { runtime, faux } = fauxRuntime();
    const providerAttempt = vi.fn(() => fauxAssistantMessage([fauxText("must not run")]));
    faux.setResponses([providerAttempt]);
    await start(runtime);

    await expect(runtime.runTurn(request("resume canonical history", {
      session: {
        id: "missing-native-session",
        conversationId: "conversation-1",
        route: {
          runtimeInstanceId: "test-runtime",
          model: "faux:faux-model",
        },
      },
    }), turnContext().context)).rejects.toMatchObject({
      code: RUNTIME_SESSION_UNAVAILABLE_CODE,
      retryability: "not-retryable",
      sideEffects: "none",
    });
    expect(providerAttempt).not.toHaveBeenCalled();
    await stop(runtime);
  });

  it("does not classify an untyped 401 provider failure as retryable fallback", async () => {
    const { runtime, faux } = fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "HTTP 401 unauthorized",
      }),
    ]);
    await start(runtime);

    await expect(runtime.runTurn(
      request("auth failure"),
      turnContext().context,
    )).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
      retryable: false,
      retryability: "not-retryable",
      committedSideEffects: false,
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
    expect(result.session).toMatchObject({
      conversationId: "conversation-1",
      route: {
        runtimeInstanceId: "http-fixture",
        model: "fixture:fixture-model",
      },
      metadata: { provider: "pi", nativeProvider: "fixture" },
    });
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""))
      .toBe("fixture ok");
    await stop(runtime);
  });
});

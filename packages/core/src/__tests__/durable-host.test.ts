import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  RuntimeTurnError,
  type AgentInteractionHandler,
  type Runtime,
  type RuntimeSession,
  type RuntimeTurnContext,
  type RuntimeTurnRequest,
  type RuntimeTurnResult,
} from "@mono-agent/module-sdk";
import {
  AgentAdmissionError,
  createAgentHost,
  type AgentHost,
} from "../index.js";
import {
  createFixtureProject,
  minimalConfig,
  runtimeSession,
  type FixtureController,
  type FixtureProject,
} from "./fixture.js";
import { MemoryStateStore } from "./durable-state-fixture.js";

const projects: FixtureProject[] = [];
const hosts: AgentHost[] = [];
const EMPTY_MCP_SERVER_SOURCE = String.raw`
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
          serverInfo: { name: "empty-staging", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? { tools: [] }
        : undefined;
    const response = result === undefined
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } }
      : { jsonrpc: "2.0", id: message.id, result };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
`;

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).reverse().map((host) => host.stop()));
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("durable AgentHost execution", () => {
  it("joins exact in-process duplicates, replays a settled response after restart, and conflicts on changed authority", async () => {
    const state = new MemoryStateStore();
    const entered = deferred<void>();
    const release = deferred<void>();
    let providerCalls = 0;
    const runtime = runtimeController(async () => {
      providerCalls += 1;
      entered.resolve(undefined);
      await release.promise;
      return completedResult("durable answer");
    });
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const first = await trackedHost(project);
    const input = {
      requestId: "durable-request-1",
      conversationId: "durable-conversation-1",
      text: "hello",
    } as const;

    const original = first.submit(input);
    const duplicate = first.submit(input);
    await entered.promise;
    expect(providerCalls).toBe(1);
    release.resolve(undefined);

    const [firstResponse, duplicateResponse] = await Promise.all([original, duplicate]);
    expect(duplicateResponse).toEqual(firstResponse);
    expect(firstResponse).toMatchObject({
      requestId: input.requestId,
      conversationId: input.conversationId,
      text: "durable answer",
      status: "completed",
    });
    await first.stop();

    const restarted = await trackedHost(project);
    await expect(restarted.submit(input)).resolves.toEqual(firstResponse);
    expect(providerCalls).toBe(1);

    await expect(restarted.submit({
      ...input,
      text: "different payload",
    })).rejects.toMatchObject({
      name: "AgentAdmissionError",
      code: "request_conflict",
      requestId: input.requestId,
      runId: firstResponse.runId,
    });
    await expect(restarted.submit({
      ...input,
      conversationId: "different-conversation",
    })).rejects.toMatchObject({
      name: "AgentAdmissionError",
      code: "request_conflict",
      requestId: input.requestId,
      runId: firstResponse.runId,
    });
    expect(providerCalls).toBe(1);
  });

  it("does not leave a durable admission when a same-conversation queued request is aborted", async () => {
    const state = new MemoryStateStore();
    const entered = deferred<void>();
    const release = deferred<void>();
    let providerCalls = 0;
    const runtime = runtimeController(async (request) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        entered.resolve(undefined);
        await release.promise;
      }
      return completedResult(`answer:${lastUserText(request)}`);
    });
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const firstHost = await trackedHost(project);
    const first = firstHost.submit({
      requestId: "queued-abort-first",
      conversationId: "queued-abort-conversation",
      text: "first",
    });
    await entered.promise;

    const controller = new AbortController();
    const queuedInput = {
      requestId: "queued-abort-second",
      conversationId: "queued-abort-conversation",
      text: "second",
      signal: controller.signal,
    } as const;
    const queued = firstHost.submit(queuedInput);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(providerCalls).toBe(1);
    await expect(firstHost.listRuns()).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          requestId: "queued-abort-first",
          status: "running",
        }),
      ],
    });

    release.resolve(undefined);
    await expect(first).resolves.toMatchObject({ status: "completed", text: "answer:first" });
    await firstHost.stop();

    const restarted = await trackedHost(project);
    const { signal: _ignoredSignal, ...retryInput } = queuedInput;
    void _ignoredSignal;
    await expect(restarted.submit(retryInput)).resolves.toMatchObject({
      requestId: queuedInput.requestId,
      status: "completed",
      text: "answer:second",
    });
    expect(providerCalls).toBe(2);
  });

  it("settles duplicate-attachment staging failure and replays its durable failure", async () => {
    const state = new MemoryStateStore();
    let providerCalls = 0;
    const runtime = runtimeController(async () => {
      providerCalls += 1;
      return completedResult("must not run");
    });
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        context: {
          mcp: {
            configPath: "./.mcp.json",
            requestContextServers: ["staging"],
          },
        },
      },
    });
    await writeFile(join(project.root, "empty-mcp.mjs"), EMPTY_MCP_SERVER_SOURCE);
    await project.writeMcp({
      mcpServers: {
        staging: {
          type: "stdio",
          command: process.execPath,
          args: ["./empty-mcp.mjs"],
        },
      },
    });
    const first = await trackedHost(project);
    const duplicate = {
      id: "duplicate",
      kind: "audio" as const,
      name: "voice.ogg",
      mediaType: "audio/ogg",
      sizeBytes: 1,
      data: Uint8Array.of(1),
    };
    const input = {
      requestId: "staging-failure-request",
      conversationId: "staging-failure-conversation",
      text: "transcribe",
      attachments: [duplicate, { ...duplicate, name: "other.ogg" }],
    } as const;

    const firstError = await rejectionOf(first.submit(input));
    expect(firstError).toMatchObject({
      name: "RunExecutionError",
      status: "failed",
      failureCode: "core-execution-failed",
      requestId: input.requestId,
    });
    expect(providerCalls).toBe(0);
    const runs = await first.listRuns();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      requestId: input.requestId,
      conversationId: input.conversationId,
      status: "failed",
      failureCode: "core-execution-failed",
    });
    const runId = runs.runs[0]!.runId;
    expect(firstError).toMatchObject({ runId });
    await expect(first.replay(input.conversationId)).resolves.toEqual({
      conversationId: input.conversationId,
      messages: [],
    });
    await expect(first.submit(input)).rejects.toMatchObject({
      name: "RunExecutionError",
      status: "failed",
      failureCode: "core-execution-failed",
      requestId: input.requestId,
      runId,
    });
    expect(providerCalls).toBe(0);
    await first.stop();

    const restarted = await trackedHost(project);
    await expect(restarted.submit(input)).rejects.toMatchObject({
      name: "RunExecutionError",
      status: "failed",
      failureCode: "core-execution-failed",
      requestId: input.requestId,
      runId,
    });
    expect(providerCalls).toBe(0);
    await expect(restarted.replay(input.conversationId)).resolves.toEqual({
      conversationId: input.conversationId,
      messages: [],
    });
  });

  it("settles a returned runtime result even when caller cancellation races the return", async () => {
    const state = new MemoryStateStore();
    const controller = new AbortController();
    let providerCalls = 0;
    const runtime = runtimeController(async () => {
      providerCalls += 1;
      controller.abort();
      return completedResult("committed result");
    });
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const first = await trackedHost(project);
    const input = {
      requestId: "returned-cancellation-request",
      conversationId: "returned-cancellation-conversation",
      text: "execute once",
      signal: controller.signal,
    } as const;

    const response = await first.submit(input);
    expect(response).toMatchObject({
      requestId: input.requestId,
      status: "completed",
      text: "committed result",
    });
    expect(providerCalls).toBe(1);
    await expect(first.readRun(response.runId)).resolves.toMatchObject({
      summary: {
        requestId: input.requestId,
        status: "completed",
      },
    });
    await first.stop();

    const restarted = await trackedHost(project);
    const { signal: _ignoredSignal, ...retryInput } = input;
    void _ignoredSignal;
    await expect(restarted.submit(retryInput)).resolves.toEqual(response);
    expect(providerCalls).toBe(1);
  });

  it("classifies an expired running admission as uncertain without another provider call", async () => {
    const state = new MemoryStateStore();
    const entered = deferred<void>();
    const sourceAbort = new AbortController();
    let providerCalls = 0;
    const runtime = runtimeController(async (request) => {
      providerCalls += 1;
      entered.resolve(undefined);
      await waitForAbort(request.signal);
      throw abortError();
    });
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const first = await trackedHost(project);
    const input = {
      requestId: "stale-request-1",
      conversationId: "stale-conversation-1",
      text: "once only",
      signal: sourceAbort.signal,
    } as const;
    const original = first.submit(input);
    void original.catch(() => {});
    await entered.promise;
    expect(providerCalls).toBe(1);

    state.executionFixture.markAdmissionUncertain(input.requestId);

    const restarted = await trackedHost(project);
    let staleError: unknown;
    try {
      const { signal: _ignoredSignal, ...restartedInput } = input;
      void _ignoredSignal;
      await restarted.submit(restartedInput);
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toMatchObject({
      name: "AgentAdmissionError",
      code: "uncertain_admission",
      requestId: input.requestId,
    });
    expect(providerCalls).toBe(1);
    const runId = staleError instanceof AgentAdmissionError
      ? staleError.runId
      : undefined;
    expect(runId).toBeDefined();
    await expect(restarted.readRun(runId ?? "")).resolves.toMatchObject({
      summary: {
        requestId: input.requestId,
        status: "uncertain",
        failureCode: "stale-running-admission",
      },
      transcript: [],
    });

    sourceAbort.abort();
    await expect(original).rejects.toBeInstanceOf(Error);
  });

  it("persists provider continuation only for its exact conversation, runtime, and model", async () => {
    const state = new MemoryStateStore();
    const mainRequests: Array<{
      readonly conversationId: string;
      readonly model: string;
      readonly session: RuntimeSession | undefined;
    }> = [];
    const otherRequests: typeof mainRequests = [];
    let mainSequence = 0;
    let otherSequence = 0;
    const main = runtimeController(async (request) => {
      mainRequests.push(requestIdentity(request));
      mainSequence += 1;
      return {
        ...completedResult(`main-${String(mainSequence)}`),
        session: runtimeSession(`main-session-${String(mainSequence)}`, request, "main"),
      };
    });
    const other = runtimeController(async (request) => {
      otherRequests.push(requestIdentity(request));
      otherSequence += 1;
      return {
        ...completedResult(`other-${String(otherSequence)}`),
        session: runtimeSession(`other-session-${String(otherSequence)}`, request, "other"),
      };
    });
    const project = await durableProject({
      state,
      runtimes: { main, other },
      config: {
        routing: {
          primary: { runtime: "main", model: "fixture:model-a" },
          fallbacks: [{ runtime: "other", model: "fixture:model-a" }],
        },
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);

    await first.submit({
      requestId: "session-request-1",
      conversationId: "conversation-a",
      text: "one",
    });
    await first.stop();

    const restarted = await trackedHost(project);
    await restarted.submit({
      requestId: "session-request-2",
      conversationId: "conversation-a",
      text: "two",
    });
    await restarted.submit({
      requestId: "session-request-3",
      conversationId: "conversation-b",
      text: "other conversation",
    });
    await restarted.submit({
      requestId: "session-request-4",
      conversationId: "conversation-a",
      runtime: "main",
      model: "fixture:model-b",
      text: "other model",
    });
    await restarted.submit({
      requestId: "session-request-5",
      conversationId: "conversation-a",
      runtime: "other",
      model: "fixture:model-a",
      text: "other runtime",
    });
    await restarted.submit({
      requestId: "session-request-6",
      conversationId: "conversation-a",
      runtime: "main",
      model: "fixture:model-a",
      text: "original route again",
    });

    expect(mainRequests).toEqual([
      {
        conversationId: "conversation-a",
        model: "fixture:model-a",
        session: undefined,
      },
      {
        conversationId: "conversation-a",
        model: "fixture:model-a",
        session: exactSession(
          "main-session-1",
          "conversation-a",
          "main",
          "fixture:model-a",
        ),
      },
      {
        conversationId: "conversation-b",
        model: "fixture:model-a",
        session: undefined,
      },
      {
        conversationId: "conversation-a",
        model: "fixture:model-b",
        session: undefined,
      },
      {
        conversationId: "conversation-a",
        model: "fixture:model-a",
        session: exactSession(
          "main-session-2",
          "conversation-a",
          "main",
          "fixture:model-a",
        ),
      },
    ]);
    expect(otherRequests).toEqual([{
      conversationId: "conversation-a",
      model: "fixture:model-a",
      session: undefined,
    }]);
  });

  it("evicts a retained exact session when the route stops advertising sessions and rejects dishonest results", async () => {
    const state = new MemoryStateStore();
    const observedSessions: Array<RuntimeSession | undefined> = [];
    let sessionsSupported = true;
    let dishonestResult = false;
    let sequence = 0;
    const runtime: FixtureController = {
      create(): Runtime {
        return {
          capabilities: runtimeCapabilities(true),
          preflightModel() {
            return {
              supported: true,
              capabilities: runtimeCapabilities(sessionsSupported),
            };
          },
          async runTurn(request) {
            observedSessions.push(request.session);
            sequence += 1;
            return {
              ...completedResult(`answer-${String(sequence)}`),
              ...(!sessionsSupported && !dishonestResult
                ? {}
                : { session: runtimeSession(`cap-session-${String(sequence)}`, request) }),
            };
          },
        };
      },
    };
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);
    await first.submit({
      requestId: "capability-migration-1",
      conversationId: "capability-migration",
      text: "store",
    });
    await first.stop();

    sessionsSupported = false;
    const restarted = await trackedHost(project);
    await restarted.submit({
      requestId: "capability-migration-2",
      conversationId: "capability-migration",
      text: "migrate",
    });
    expect(observedSessions).toEqual([undefined, undefined]);

    dishonestResult = true;
    await expect(restarted.submit({
      requestId: "capability-migration-3",
      conversationId: "capability-migration",
      text: "dishonest",
    })).rejects.toMatchObject({
      name: "RunExecutionError",
      status: "uncertain",
      failureCode: "runtime-result-unsettled",
    });
    expect(observedSessions.at(-1)).toBeUndefined();
  });

  it("exact-evicts a continuous session when configuration migrates to per-message", async () => {
    const state = new MemoryStateStore();
    const observedSessions: Array<RuntimeSession | undefined> = [];
    let sequence = 0;
    const runtime = runtimeController(async (request) => {
      observedSessions.push(request.session);
      sequence += 1;
      return {
        ...completedResult(`answer-${String(sequence)}`),
        session: runtimeSession(`mode-session-${String(sequence)}`, request),
      };
    });
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const originalConfig = JSON.parse(
      await readFile(project.configPath, "utf8"),
    ) as Record<string, unknown>;
    const first = await trackedHost(project);
    await first.submit({
      requestId: "mode-migration-1",
      conversationId: "mode-migration",
      text: "continuous",
    });
    await first.stop();

    await project.writeConfig({
      ...originalConfig,
      session: {
        mode: "per-message",
        rollover: "none",
        isolateProactiveRuns: false,
      },
    });
    const perMessage = await trackedHost(project);
    await perMessage.submit({
      requestId: "mode-migration-2",
      conversationId: "mode-migration",
      text: "per-message",
    });
    await perMessage.stop();

    await project.writeConfig(originalConfig);
    const continuousAgain = await trackedHost(project);
    await continuousAgain.submit({
      requestId: "mode-migration-3",
      conversationId: "mode-migration",
      text: "continuous again",
    });
    expect(observedSessions).toEqual([undefined, undefined, undefined]);
  });

  it("evicts an unavailable provider session and retries the same route once from canonical history", async () => {
    const state = new MemoryStateStore();
    const observedSessions: Array<RuntimeSession | undefined> = [];
    const retryMessages: unknown[] = [];
    let calls = 0;
    const runtime = runtimeController(async (request) => {
      observedSessions.push(request.session);
      calls += 1;
      if (calls === 1) {
        return {
          ...completedResult("seed"),
          session: runtimeSession("missing-provider-session", request),
        };
      }
      if (calls === 2) {
        retryMessages.push(request.messages);
        throw new RuntimeTurnError({
          code: RUNTIME_SESSION_UNAVAILABLE_CODE,
          message: "provider continuation no longer exists",
          retryability: "not-retryable",
          sideEffects: "none",
        });
      }
      retryMessages.push(request.messages);
      return {
        ...completedResult(calls === 3 ? "recovered" : "continued"),
        session: runtimeSession(
          calls === 3 ? "replacement-session" : "continued-session",
          request,
        ),
      };
    });
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);
    await first.submit({
      requestId: "missing-session-1",
      conversationId: "missing-session",
      text: "seed",
    });
    await first.stop();

    const restarted = await trackedHost(project);
    const recovered = await restarted.submit({
      requestId: "missing-session-2",
      conversationId: "missing-session",
      text: "recover",
    });
    expect(recovered).toMatchObject({ text: "recovered", runtime: "main" });
    expect(observedSessions).toEqual([
      undefined,
      exactSession(
        "missing-provider-session",
        "missing-session",
        "main",
        "fixture:model",
      ),
      undefined,
    ]);
    expect(retryMessages).toHaveLength(2);
    expect(retryMessages[1]).toEqual(retryMessages[0]);
    await expect(restarted.readRun(recovered.runId)).resolves.toMatchObject({
      summary: {
        attempts: [
          {
            status: "failed",
            code: RUNTIME_SESSION_UNAVAILABLE_CODE,
            sideEffects: "none",
          },
          { status: "completed" },
        ],
      },
    });
    await restarted.stop();

    const restartedAgain = await trackedHost(project);
    await restartedAgain.submit({
      requestId: "missing-session-3",
      conversationId: "missing-session",
      text: "continue",
    });
    expect(observedSessions.at(-1)).toEqual(exactSession(
      "replacement-session",
      "missing-session",
      "main",
      "fixture:model",
    ));
  });

  it("does not loop when the same route stays session-unavailable without a session", async () => {
    const state = new MemoryStateStore();
    let calls = 0;
    const runtime = runtimeController(async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          ...completedResult("seed"),
          session: runtimeSession("loop-seed-session", request),
        };
      }
      throw new RuntimeTurnError({
        code: RUNTIME_SESSION_UNAVAILABLE_CODE,
        message: "provider still unavailable",
        retryability: "not-retryable",
        sideEffects: "none",
      });
    });
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);
    await first.submit({
      requestId: "missing-session-loop-1",
      conversationId: "missing-session-loop",
      text: "seed",
    });
    await first.stop();

    const restarted = await trackedHost(project);
    await expect(restarted.submit({
      requestId: "missing-session-loop-2",
      conversationId: "missing-session-loop",
      text: "recover",
    })).rejects.toMatchObject({
      name: "RunExecutionError",
      status: "failed",
      failureCode: "runtime-routes-failed",
    });
    expect(calls).toBe(3);
  });

  it("does not reuse an expired durable provider session after restart", async () => {
    const state = new MemoryStateStore();
    const observedSessions: Array<RuntimeSession | undefined> = [];
    let sequence = 0;
    const runtime = runtimeController(async (request) => {
      observedSessions.push(request.session);
      sequence += 1;
      if (sequence === 1) {
        return {
          ...completedResult("expired session stored"),
          session: {
            ...runtimeSession("expired-session", request),
            createdAt: "2000-01-01T00:00:00.000Z",
            expiresAt: "2000-01-02T00:00:00.000Z",
          },
        };
      }
      return {
        ...completedResult(`fresh answer ${String(sequence)}`),
        session: runtimeSession("fresh-session", request),
      };
    });
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);
    await first.submit({
      requestId: "expired-session-request-1",
      conversationId: "expired-session-conversation",
      text: "store expired continuation",
    });
    await first.stop();

    const restarted = await trackedHost(project);
    await restarted.submit({
      requestId: "expired-session-request-2",
      conversationId: "expired-session-conversation",
      text: "must start without expired continuation",
    });
    await restarted.stop();

    const restartedAgain = await trackedHost(project);
    await restartedAgain.submit({
      requestId: "expired-session-request-3",
      conversationId: "expired-session-conversation",
      text: "reuse only the fresh continuation",
    });

    expect(observedSessions).toEqual([
      undefined,
      undefined,
      exactSession(
        "fresh-session",
        "expired-session-conversation",
        "main",
        "fixture:model",
      ),
    ]);
  });

  it("falls back only for typed safe failures and treats diagnostic, usage, and session events as non-effects", async () => {
    const state = new MemoryStateStore();
    const liveReady = deferred<void>();
    const releaseLiveFailure = deferred<void>();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = runtimeController(async (request, context) => {
      primaryCalls += 1;
      const scenario = lastUserText(request);
      if (scenario === "safe-events") {
        await context.emit({
          type: "diagnostic",
          diagnostic: {
            code: "fixture-diagnostic",
            severity: "info",
            message: "non-effect diagnostic",
          },
        });
        await context.emit({
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 0 },
        });
        await context.emit({
          type: "session",
          session: runtimeSession("discarded-failed-session", request, "primary"),
        });
        throw safeFailure("safe-events");
      }
      if (scenario === "safe-empty") throw safeFailure("safe-empty");
      if (scenario === "not-retryable") {
        throw new RuntimeTurnError({
          code: "not-retryable",
          message: "not retryable",
          retryability: "not-retryable",
          sideEffects: "none",
        });
      }
      if (scenario === "committed") {
        throw new RuntimeTurnError({
          code: "committed",
          message: "committed",
          retryability: "retryable",
          sideEffects: "committed",
        });
      }
      if (scenario === "text-effect") {
        await context.emit({ type: "text-delta", delta: "partial" });
        throw safeFailure("text-effect");
      }
      if (scenario === "tool-effect") {
        await context.emit({
          type: "tool-call",
          call: {
            id: "call-observed",
            name: "fixture__tool",
            input: { secret: "must-not-retry" },
          },
        });
        throw safeFailure("tool-effect");
      }
      if (scenario === "interaction-effect") {
        if (context.askUser === undefined) throw new Error("AskUser is unavailable");
        await context.askUser({
          interactionId: "ask-observed",
          questions: [{
            id: "proceed",
            prompt: "Proceed?",
            choices: [{ value: "yes", label: "Yes" }],
            allowFreeText: false,
            multiple: false,
          }],
          requestedAt: "2026-07-23T10:00:00.000Z",
        }, request.signal);
        throw safeFailure("interaction-effect");
      }
      if (scenario === "live-effect") {
        if (context.registerLiveInput === undefined) {
          throw new Error("Live input is unavailable");
        }
        const unregister = context.registerLiveInput(
          async (): Promise<"applied"> => "applied",
        );
        liveReady.resolve(undefined);
        await releaseLiveFailure.promise;
        unregister();
        throw safeFailure("live-effect");
      }
      throw new Error(`unexpected fallback scenario ${scenario}`);
    }, true);
    const fallback = runtimeController(async () => {
      fallbackCalls += 1;
      return completedResult("fallback");
    });
    const project = await durableProject({
      state,
      runtimes: { primary, fallback },
      config: {
        routing: {
          primary: { runtime: "primary", model: "fixture:primary" },
          fallbacks: [{ runtime: "fallback", model: "fixture:fallback" }],
        },
      },
    });
    const host = await trackedHost(project);
    const handler = interactionHandler();

    for (const scenario of ["safe-empty", "safe-events"] as const) {
      await expect(host.submit({
        requestId: `fallback-${scenario}`,
        conversationId: `fallback-${scenario}`,
        text: scenario,
      })).resolves.toMatchObject({
        runtime: "fallback",
        model: "fixture:fallback",
        text: "fallback",
      });
    }

    for (const scenario of [
      "not-retryable",
      "committed",
      "text-effect",
      "tool-effect",
      "interaction-effect",
    ] as const) {
      await expect(host.submit({
        requestId: `fallback-${scenario}`,
        conversationId: `fallback-${scenario}`,
        text: scenario,
        ...(scenario === "interaction-effect" ? { interactionHandler: handler } : {}),
      })).rejects.toThrow(/Every eligible runtime route failed/u);
    }

    const liveTurn = host.submit({
      requestId: "fallback-live-effect",
      conversationId: "fallback-live-effect",
      text: "live-effect",
    });
    await liveReady.promise;
    await expect(host.offerLiveInput("fallback-live-effect", {
      id: "live-observed",
      text: "steer",
      receivedAt: "2026-07-23T10:00:00.000Z",
    })).resolves.toBe("applied");
    releaseLiveFailure.resolve(undefined);
    await expect(liveTurn).rejects.toThrow(/Every eligible runtime route failed/u);

    expect(primaryCalls).toBe(8);
    expect(fallbackCalls).toBe(2);
  });

  it("replays canonical artifact-backed transcripts after restart without provider-private session or tool internals", async () => {
    const state = new MemoryStateStore();
    const inputBytes = new TextEncoder().encode("attachment payload");
    const outputBytes = new TextEncoder().encode("generated payload");
    const runtime = runtimeController(async (request) => ({
      status: "completed",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "safe answer" },
          {
            type: "tool-call",
            call: {
              id: "private-call",
              name: "provider_private_tool",
              input: { credential: "private-tool-argument" },
            },
          },
          {
            type: "tool-result",
            result: {
              callId: "private-call",
              content: [{ type: "text", text: "private-tool-result" }],
            },
          },
          {
            type: "file",
            mediaType: "text/plain",
            data: outputBytes,
            name: "generated.txt",
          },
        ],
      },
      session: runtimeSession("provider-private-session", request),
    }));
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);
    const response = await first.submit({
      requestId: "transcript-request-1",
      conversationId: "transcript-conversation-1",
      text: "inspect this",
      attachments: [{
        id: "attachment-1",
        kind: "file",
        name: "input.txt",
        mediaType: "text/plain",
        sizeBytes: inputBytes.byteLength,
        data: inputBytes,
      }],
    });
    const firstRun = await first.readRun(response.runId);
    expect(firstRun).toBeDefined();
    expect(firstRun?.summary).toMatchObject({
      status: "completed",
      requestId: response.requestId,
      conversationId: response.conversationId,
    });
    expect(firstRun?.transcript).toMatchObject([
      {
        kind: "message",
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "artifact",
            name: "input.txt",
            ref: {
              sizeBytes: inputBytes.byteLength,
              mediaType: "text/plain",
            },
          },
        ],
      },
      {
        kind: "message",
        role: "assistant",
        content: [
          { type: "text", text: "safe answer" },
          {
            type: "artifact",
            name: "generated.txt",
            ref: {
              sizeBytes: outputBytes.byteLength,
              mediaType: "text/plain",
            },
          },
        ],
      },
    ]);
    const durableProjection = JSON.stringify(firstRun);
    expect(durableProjection).not.toContain("provider-private-session");
    expect(durableProjection).not.toContain("provider_private_tool");
    expect(durableProjection).not.toContain("private-tool-argument");
    expect(durableProjection).not.toContain("private-tool-result");
    expect([...state.artifacts.values()].some((bytes) =>
      equalBytes(bytes, inputBytes))).toBe(true);
    expect([...state.artifacts.values()].some((bytes) =>
      equalBytes(bytes, outputBytes))).toBe(true);
    await first.stop();

    const restarted = await trackedHost(project);
    const replay = await restarted.replay("transcript-conversation-1");
    expect(replay.messages).toHaveLength(2);
    expect(JSON.stringify(replay)).not.toContain("provider-private-session");
    expect(JSON.stringify(replay)).not.toContain("provider_private_tool");
    expect(JSON.stringify(replay)).not.toContain("private-tool-argument");
    expect(JSON.stringify(replay)).not.toContain("private-tool-result");
    const replayedInput = replay.messages[0]?.content.find((part) =>
      part.type === "file");
    expect(replayedInput?.type === "file" && replayedInput.data instanceof Uint8Array
      ? [...replayedInput.data]
      : undefined).toEqual([...inputBytes]);
    const generated = replay.messages[1]?.content.find((part) =>
      part.type === "file");
    expect(generated?.type === "file" && generated.data instanceof Uint8Array
      ? [...generated.data]
      : undefined).toEqual([...outputBytes]);
    await expect(restarted.readRun(response.runId)).resolves.toEqual(firstRun);
  });

  it("persists compact AskUser evidence and user-visible interaction transcript across restart", async () => {
    const state = new MemoryStateStore();
    const runtime = runtimeController(async (request, context) => {
      if (context.askUser === undefined) throw new Error("AskUser is unavailable");
      const answer = await context.askUser({
        interactionId: "ask-release-channel",
        questions: [{
          id: "release-channel",
          prompt: "Which release channel should be used?",
          choices: [
            { value: "candidate-private-choice", label: "Beta Candidate" },
            { value: "stable", label: "Stable" },
          ],
          allowFreeText: false,
          multiple: false,
        }],
        requestedAt: "2026-07-23T10:00:00.000Z",
      }, request.signal);
      return {
        status: "completed",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Proceeding with ${answer.answers["release-channel"]?.[0] ?? "nothing"}.`,
            },
            {
              type: "tool-call",
              call: {
                id: "provider-private-call",
                name: "provider_private_tool",
                input: { credential: "raw-provider-tool-argument" },
              },
            },
          ],
        },
        session: runtimeSession("raw-provider-session", request),
      };
    });
    const project = await durableProject({
      state,
      runtimes: { main: runtime },
      config: {
        session: {
          mode: "continuous",
          rollover: "none",
          isolateProactiveRuns: false,
        },
      },
    });
    const first = await trackedHost(project);
    const response = await first.submit({
      requestId: "ask-durable-request",
      conversationId: "ask-durable-conversation",
      text: "Start release planning.",
      interactionHandler: {
        async askUser(request) {
          return {
            interactionId: request.interactionId,
            answers: { "release-channel": ["candidate-private-choice"] },
            answeredAt: "2026-07-23T10:00:01.000Z",
          };
        },
        async requestApproval() {
          throw new Error("approval is not expected");
        },
      },
    });
    await first.stop();

    const restarted = await trackedHost(project);
    const run = await restarted.readRun(response.runId);
    expect(run).toBeDefined();
    const interactionEvents = run?.events.filter((event) =>
      event.type === "interaction") ?? [];
    expect(interactionEvents).toMatchObject([
      {
        type: "interaction",
        evidence: {
          kind: "ask-user",
          interactionId: "ask-release-channel",
          phase: "requested",
          requestedAt: "2026-07-23T10:00:00.000Z",
          questionCount: 1,
        },
      },
      {
        type: "interaction",
        evidence: {
          kind: "ask-user",
          interactionId: "ask-release-channel",
          phase: "answered",
          requestedAt: "2026-07-23T10:00:00.000Z",
          settledAt: "2026-07-23T10:00:01.000Z",
          questionCount: 1,
          answeredQuestionCount: 1,
        },
      },
    ]);
    expect(JSON.stringify(interactionEvents)).not.toContain(
      "Which release channel should be used?",
    );
    expect(JSON.stringify(interactionEvents)).not.toContain(
      "candidate-private-choice",
    );
    expect(run?.transcript).toMatchObject([
      {
        kind: "message",
        runId: response.runId,
        requestId: response.requestId,
        role: "user",
        content: [{ type: "text", text: "Start release planning." }],
      },
      {
        kind: "interaction",
        runId: response.runId,
        requestId: response.requestId,
        evidence: { kind: "ask-user", phase: "requested" },
        content: [{
          type: "text",
          text: "Which release channel should be used?\nChoices: Beta Candidate, Stable",
        }],
      },
      {
        kind: "interaction",
        runId: response.runId,
        requestId: response.requestId,
        evidence: { kind: "ask-user", phase: "answered" },
        content: [{
          type: "text",
          text: "Which release channel should be used?\nAnswer: candidate-private-choice",
        }],
      },
      {
        kind: "message",
        runId: response.runId,
        requestId: response.requestId,
        role: "assistant",
        content: [{
          type: "text",
          text: "Proceeding with candidate-private-choice.",
        }],
      },
    ]);

    const replay = await restarted.replay(response.conversationId);
    expect(replay.messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Start release planning." }],
      },
      {
        role: "assistant",
        name: "interaction:ask-user",
        content: [{
          type: "text",
          text: "Which release channel should be used?\nChoices: Beta Candidate, Stable",
        }],
      },
      {
        role: "user",
        name: "interaction:ask-user",
        content: [{
          type: "text",
          text: "Which release channel should be used?\nAnswer: candidate-private-choice",
        }],
      },
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "Proceeding with candidate-private-choice.",
        }],
      },
    ]);
    const publicProjection = JSON.stringify({ run, replay });
    expect(publicProjection).not.toContain("raw-provider-session");
    expect(publicProjection).not.toContain("provider_private_tool");
    expect(publicProjection).not.toContain("raw-provider-tool-argument");
  });

  it("scopes readRun transcript entries to one run while replay remains append-only", async () => {
    const state = new MemoryStateStore();
    const runtime = runtimeController(async (request) =>
      completedResult(`Answer to ${lastUserText(request)}`));
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const first = await trackedHost(project);
    const firstResponse = await first.submit({
      requestId: "run-scope-request-1",
      conversationId: "run-scope-conversation",
      text: "first question",
    });
    const secondResponse = await first.submit({
      requestId: "run-scope-request-2",
      conversationId: "run-scope-conversation",
      text: "second question",
    });
    await first.stop();

    const restarted = await trackedHost(project);
    const firstRun = await restarted.readRun(firstResponse.runId);
    const secondRun = await restarted.readRun(secondResponse.runId);
    expect(firstRun?.transcript).toMatchObject([
      {
        kind: "message",
        runId: firstResponse.runId,
        requestId: firstResponse.requestId,
        role: "user",
        content: [{ type: "text", text: "first question" }],
      },
      {
        kind: "message",
        runId: firstResponse.runId,
        requestId: firstResponse.requestId,
        role: "assistant",
        content: [{ type: "text", text: "Answer to first question" }],
      },
    ]);
    expect(secondRun?.transcript).toMatchObject([
      {
        kind: "message",
        runId: secondResponse.runId,
        requestId: secondResponse.requestId,
        role: "user",
        content: [{ type: "text", text: "second question" }],
      },
      {
        kind: "message",
        runId: secondResponse.runId,
        requestId: secondResponse.requestId,
        role: "assistant",
        content: [{ type: "text", text: "Answer to second question" }],
      },
    ]);
    expect(firstRun?.transcript).toHaveLength(2);
    expect(secondRun?.transcript).toHaveLength(2);
    expect(firstRun?.transcript.every((entry) =>
      entry.runId === firstResponse.runId)).toBe(true);
    expect(secondRun?.transcript.every((entry) =>
      entry.runId === secondResponse.runId)).toBe(true);

    await expect(restarted.replay("run-scope-conversation")).resolves.toMatchObject({
      conversationId: "run-scope-conversation",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "first question" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Answer to first question" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second question" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Answer to second question" }],
        },
      ],
    });
  });

  it("preserves uncertain side-effect classification when failed-attempt evidence cannot be persisted", async () => {
    const state = new SettlementFailingStateStore();
    let providerCalls = 0;
    const runtime = runtimeController(async () => {
      providerCalls += 1;
      throw new RuntimeTurnError({
        code: "committed-effect-failure",
        message: "effect committed before failure",
        retryability: "not-retryable",
        sideEffects: "committed",
      });
    });
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const first = await trackedHost(project);
    const input = {
      requestId: "failed-attempt-evidence-request-1",
      conversationId: "failed-attempt-evidence-conversation-1",
      text: "execute once",
    } as const;

    state.failNextFailedAttemptEvidence = true;
    await expect(first.submit(input)).rejects.toMatchObject({
      name: "RunExecutionError",
      status: "uncertain",
      failureCode: "attempt-evidence-unsettled",
    });
    expect(state.failedAttemptEvidenceFailures).toBe(1);
    expect(providerCalls).toBe(1);
    const runs = await first.listRuns();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      requestId: input.requestId,
      conversationId: input.conversationId,
      status: "uncertain",
      failureCode: "attempt-evidence-unsettled",
    });
    const runId = runs.runs[0]?.runId;
    expect(runId).toBeDefined();
    await first.stop();

    const restarted = await trackedHost(project);
    await expect(restarted.submit(input)).rejects.toMatchObject({
      name: "AgentAdmissionError",
      code: "uncertain_admission",
      requestId: input.requestId,
      runId,
    });
    expect(providerCalls).toBe(1);
  });

  it("marks a post-provider settlement failure uncertain and never replays that request", async () => {
    const state = new SettlementFailingStateStore();
    let providerCalls = 0;
    const runtime = runtimeController(async () => {
      providerCalls += 1;
      return completedResult("must not be replayed");
    });
    const project = await durableProject({ state, runtimes: { main: runtime } });
    const first = await trackedHost(project);
    const input = {
      requestId: "settlement-failure-request-1",
      conversationId: "settlement-failure-conversation-1",
      text: "execute once",
    } as const;

    state.failNextCompletedSettlement = true;
    await expect(first.submit(input)).rejects.toThrow(/settlement|transaction|injected/u);
    expect(state.completedSettlementFailures).toBe(1);
    expect(providerCalls).toBe(1);
    const runs = await first.listRuns();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      requestId: input.requestId,
      conversationId: input.conversationId,
      status: "uncertain",
    });
    const runId = runs.runs[0]?.runId;
    expect(runId).toBeDefined();
    await expect(first.readRun(runId ?? "")).resolves.toMatchObject({
      summary: { status: "uncertain" },
      transcript: [],
    });
    await expect(first.replay(input.conversationId)).resolves.toEqual({
      conversationId: input.conversationId,
      messages: [],
    });
    await first.stop();

    const restarted = await trackedHost(project);
    await expect(restarted.submit(input)).rejects.toMatchObject({
      name: "AgentAdmissionError",
      code: "uncertain_admission",
      requestId: input.requestId,
      runId,
    });
    expect(providerCalls).toBe(1);
    await expect(restarted.replay(input.conversationId)).resolves.toEqual({
      conversationId: input.conversationId,
      messages: [],
    });
  });
});

class SettlementFailingStateStore extends MemoryStateStore {
  failNextFailedAttemptEvidence = false;
  failedAttemptEvidenceFailures = 0;
  failNextCompletedSettlement = false;
  completedSettlementFailures = 0;

  override beforeExecutionOperation(operation: string, input: unknown): void {
    const value = input as {
      readonly attempt?: { readonly status?: unknown };
      readonly status?: unknown;
    };
    if (
      this.failNextFailedAttemptEvidence
      && operation === "run.record-attempt"
      && value.attempt?.status === "failed"
    ) {
      this.failNextFailedAttemptEvidence = false;
      this.failedAttemptEvidenceFailures += 1;
      throw new Error("injected failed-attempt evidence failure");
    }
    if (
      this.failNextCompletedSettlement
      && operation === "run.settle"
      && value.status === "completed"
    ) {
      this.failNextCompletedSettlement = false;
      this.completedSettlementFailures += 1;
      throw new Error("injected completed-settlement transaction failure");
    }
    super.beforeExecutionOperation(operation, input);
  }
}

interface DurableProjectOptions {
  readonly state: MemoryStateStore;
  readonly runtimes: Readonly<Record<string, FixtureController>>;
  readonly config?: Readonly<Record<string, unknown>>;
}

async function durableProject(options: DurableProjectOptions): Promise<FixtureProject> {
  const suffix = randomUUID().toLowerCase();
  const runtimePackages = Object.fromEntries(Object.keys(options.runtimes).map((instanceId) => [
    instanceId,
    `@fixture/runtime-${instanceId}-${suffix}`,
  ])) as Readonly<Record<string, string>>;
  const statePackage = `@fixture/state-durable-${suffix}`;
  const project = await createFixtureProject([
    ...Object.entries(options.runtimes).map(([instanceId, controller]) => ({
      name: runtimePackages[instanceId]!,
      kind: "runtime" as const,
      controller,
    })),
    {
      name: statePackage,
      kind: "state" as const,
      controller: { create: () => options.state },
    },
  ]);
  projects.push(project);
  const primaryRuntime = Object.keys(options.runtimes)[0];
  if (primaryRuntime === undefined) throw new Error("durable project requires a runtime");
  const overrideRuntimes = Object.fromEntries(Object.entries(runtimePackages).map(
    ([instanceId, packageName]) => [instanceId, { $use: packageName }],
  ));
  await project.writeConfig(minimalConfig(runtimePackages[primaryRuntime]!, {
    runtimes: overrideRuntimes,
    routing: {
      primary: { runtime: primaryRuntime, model: "fixture:model" },
      fallbacks: [],
    },
    state: { $use: statePackage },
    ...options.config,
  }));
  return project;
}

async function trackedHost(project: FixtureProject): Promise<AgentHost> {
  const host = await createAgentHost(project.configPath, {
    drainTimeoutMs: 1_000,
    lifecycleTimeoutMs: 1_000,
  });
  hosts.push(host);
  return host;
}

function runtimeCapabilities(sessions: boolean): Runtime["capabilities"] {
  return {
    tools: true,
    mcp: true,
    attachments: true,
    approvals: true,
    structuredOutput: true,
    sandbox: true,
    sessions,
    liveInput: false,
  };
}

function runtimeController(
  runTurn: (
    request: RuntimeTurnRequest,
    context: RuntimeTurnContext,
  ) => Promise<RuntimeTurnResult>,
  liveInput = false,
): FixtureController {
  return {
    create(): Runtime {
      return {
        capabilities: { ...runtimeCapabilities(true), liveInput },
        runTurn,
      };
    },
  };
}

function completedResult(text: string): RuntimeTurnResult {
  return {
    status: "completed",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function requestIdentity(request: RuntimeTurnRequest): {
  readonly conversationId: string;
  readonly model: string;
  readonly session: RuntimeSession | undefined;
} {
  return {
    conversationId: request.conversationId,
    model: request.model,
    session: request.session,
  };
}

function exactSession(
  id: string,
  conversationId: string,
  runtimeInstanceId: string,
  model: string,
): RuntimeSession {
  return {
    id,
    conversationId,
    route: { runtimeInstanceId, model },
  };
}

function safeFailure(code: string): RuntimeTurnError {
  return new RuntimeTurnError({
    code,
    message: code,
    retryability: "retryable",
    sideEffects: "none",
  });
}

function interactionHandler(): AgentInteractionHandler {
  return {
    async askUser(request) {
      return {
        interactionId: request.interactionId,
        answers: { proceed: ["yes"] },
        answeredAt: "2026-07-23T10:00:01.000Z",
      };
    },
    async requestApproval(request) {
      return {
        interactionId: request.interactionId,
        decision: "deny",
        decidedAt: "2026-07-23T10:00:01.000Z",
      };
    },
  };
}

function lastUserText(request: RuntimeTurnRequest): string {
  const message = [...request.messages].reverse().find((entry) => entry.role === "user");
  const part = message?.content.find((entry) => entry.type === "text");
  return part?.type === "text" ? part.text : "";
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T extends void ? undefined : T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: resolve as (value: T extends void ? undefined : T) => void,
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

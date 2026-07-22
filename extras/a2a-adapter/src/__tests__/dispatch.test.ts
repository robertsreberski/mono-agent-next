import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type SendMessageRequest,
  type SendMessageResult,
  type Task,
} from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import type { AgentResponder } from "@mono-agent/agent-contracts";

import {
  A2AConsumer,
  A2AConsumerError,
  A2A_IDEMPOTENCY_EXTENSION_URI,
  A2A_IDEMPOTENCY_METADATA_KEY,
  A2A_IDEMPOTENCY_SCHEMA_VERSION,
  createA2AAgentCard,
  createA2AConsumer,
  dispatchA2AMessage,
  startA2AProvider,
  type A2AConsumerTerminalOutcome,
  type A2AProviderStartResult,
} from "../index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("A2A durable dispatch lifecycle", () => {
  it("admits immediately and joins one responder execution for terminal observation", async () => {
    const gate = deferred<void>();
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          await gate.promise;
          return { text: "terminal result" };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });

    const dispatch = await consumer.dispatchMessage({
      text: "durable work",
      idempotencyKey: "dispatch-one-execution-1",
      timeoutMs: 1_000,
    });
    expect(dispatch.current.metadata.a2a.state).toBe("TASK_STATE_SUBMITTED");
    expect(responderCalls).toBe(1);

    const observations = [
      dispatch.observeTerminal({ timeoutMs: 1_000 }),
      dispatch.observeTerminal({ timeoutMs: 1_000 }),
    ];
    gate.resolve();
    for (const observation of observations) {
      await expect(observation).resolves.toMatchObject({
        status: "completed",
        response: {
          text: "terminal result",
          metadata: {
            a2a: {
              taskId: dispatch.current.metadata.a2a.taskId,
              state: "TASK_STATE_COMPLETED",
            },
          },
        },
      });
    }
    expect(dispatch.current.text).toBe("terminal result");
    expect(responderCalls).toBe(1);
  });

  it("keeps observer cancellation and timeout independent from remote work and permits rejoin", async () => {
    const gate = deferred<void>();
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          await gate.promise;
          return { text: "survived observer abort" };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    const dispatch = await consumer.dispatchMessage({
      text: "long work",
      idempotencyKey: "dispatch-observer-rejoin-1",
      timeoutMs: 500,
    });

    await expect(dispatch.observeTerminal({ timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
    const observer = new AbortController();
    const abortedObservation = dispatch.observeTerminal({ signal: observer.signal });
    observer.abort(new Error("caller stopped observing"));
    await expect(abortedObservation).rejects.toBeInstanceOf(A2AConsumerError);

    const rejoined = dispatch.observeTerminal({ timeoutMs: 1_000 });
    gate.resolve();
    await expect(rejoined).resolves.toMatchObject({
      status: "completed",
      response: { text: "survived observer abort" },
    });
    expect(responderCalls).toBe(1);
  });

  it("cancels only through the explicit dispatch cancellation method", async () => {
    let observedAbort = false;
    const provider = await startProvider({
      responder: {
        async respond(request) {
          await new Promise<void>((resolve) => {
            request.abortSignal.addEventListener("abort", () => {
              observedAbort = true;
              resolve();
            }, { once: true });
          });
          return { text: "must not complete" };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    const dispatch = await consumer.dispatchMessage({
      text: "cancel me",
      idempotencyKey: "dispatch-explicit-cancel-1",
    });

    const outcome = await dispatch.cancel();
    expect(outcome).toMatchObject({
      status: "canceled",
      response: { metadata: { a2a: { state: "TASK_STATE_CANCELED" } } },
      error: { code: "remote_canceled" },
    });
    expect(observedAbort).toBe(true);
    expect(dispatch.current).toBe(outcome.response);
  });

  it("replays a terminal dispatch after provider restart without another responder call", async () => {
    const stateDir = await temporaryStateDir();
    let firstCalls = 0;
    const original = await startProvider({
      stateDir,
      responder: {
        async respond() {
          firstCalls += 1;
          return { text: "persisted lifecycle result" };
        },
      },
    });
    const input = {
      text: "restart-safe dispatch",
      idempotencyKey: "dispatch-restart-terminal-1",
    } as const;
    const first = await dispatchA2AMessage({ ...input, agentUrl: original.agentCardUrl });
    await expect(first.observeTerminal()).resolves.toMatchObject({ status: "completed" });
    await original.stop();

    let restartedCalls = 0;
    const restarted = await startProvider({
      stateDir,
      responder: {
        async respond() {
          restartedCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    const replay = await dispatchA2AMessage({ ...input, agentUrl: restarted.agentCardUrl });
    const outcome = await replay.observeTerminal();
    expect(outcome).toMatchObject({
      status: "completed",
      response: { text: "persisted lifecycle result" },
    });
    expect(outcome.response.metadata.a2a.taskId).toBe(first.current.metadata.a2a.taskId);
    expect(firstCalls).toBe(1);
    expect(restartedCalls).toBe(0);
  });

  it("fails closed on an in-doubt crash-remnant admission after restart", async () => {
    const stateDir = await temporaryStateDir();
    const gate = deferred<void>();
    const original = await startProvider({
      stateDir,
      responder: {
        async respond() {
          await gate.promise;
          return { text: "late" };
        },
      },
    });
    const input = {
      text: "ambiguous dispatch",
      idempotencyKey: "dispatch-restart-active-1",
    } as const;
    await dispatchA2AMessage({ ...input, agentUrl: original.agentCardUrl });
    const recordPath = await onlyRecordPath(stateDir);
    const crashRemnant = await readFile(recordPath);
    expect(JSON.parse(crashRemnant.toString("utf8"))).toMatchObject({ status: "active" });
    await original.stop();
    await expect.poll(async () =>
      (JSON.parse(await readFile(recordPath, "utf8")) as { status?: unknown }).status,
    ).toBe("completed");
    // A graceful stop records a terminal cancellation. Restore the last
    // pre-shutdown durable receipt to model a process crash after admission.
    await writeFile(recordPath, crashRemnant);

    let restartedCalls = 0;
    const restarted = await startProvider({
      stateDir,
      responder: {
        async respond() {
          restartedCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    await expect(dispatchA2AMessage({ ...input, agentUrl: restarted.agentCardUrl }))
      .rejects.toMatchObject({ code: "idempotency_in_doubt" });
    expect(restartedCalls).toBe(0);
    gate.resolve();
  });

  it("rejects a changed payload for an existing dispatch key", async () => {
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond(request) {
          responderCalls += 1;
          return { text: request.text };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    const original = await consumer.dispatchMessage({
      text: "original workload",
      idempotencyKey: "dispatch-conflict-1",
    });
    await original.observeTerminal();

    await expect(consumer.dispatchMessage({
      text: "changed workload",
      idempotencyKey: "dispatch-conflict-1",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(responderCalls).toBe(1);
  });

  it("rejects a missing dispatch key before any transport call", async () => {
    let sends = 0;
    const consumer = new A2AConsumer({
      client: fakeClient({
        async sendMessage() {
          sends += 1;
          return task(TaskState.TASK_STATE_COMPLETED, "must not send");
        },
      }),
      agentCard: idempotentAgentCard(),
      agentUrl: "http://127.0.0.1:65535",
    });

    await expect(consumer.dispatchMessage({ text: "missing key" } as never))
      .rejects.toMatchObject({ code: "invalid_idempotency_key" });
    expect(sends).toBe(0);
  });

  it("returns an already-terminal failed admission as an outcome instead of rejecting", async () => {
    let sends = 0;
    const consumer = new A2AConsumer({
      client: fakeClient({
        async sendMessage() {
          sends += 1;
          return task(TaskState.TASK_STATE_FAILED, "persisted failure");
        },
      }),
      agentCard: idempotentAgentCard(),
      agentUrl: "http://127.0.0.1:65535",
    });

    const dispatch = await consumer.dispatchMessage({
      text: "failed before observer attached",
      idempotencyKey: "dispatch-current-failed-1",
    });
    await expect(dispatch.observeTerminal()).resolves.toMatchObject({
      status: "failed",
      response: { text: "persisted failure" },
      error: { code: "remote_failed" },
    });
    expect(sends).toBe(1);
  });

  it.each([
    [TaskState.TASK_STATE_COMPLETED, "completed", undefined],
    [TaskState.TASK_STATE_FAILED, "failed", "remote_failed"],
    [TaskState.TASK_STATE_CANCELED, "canceled", "remote_canceled"],
    [TaskState.TASK_STATE_REJECTED, "rejected", "remote_rejected"],
    [TaskState.TASK_STATE_AUTH_REQUIRED, "auth_required", "remote_auth_required"],
    [TaskState.TASK_STATE_INPUT_REQUIRED, "input_required", "remote_input_required"],
  ] as const)(
    "resolves protocol state %s as the %s lifecycle outcome",
    async (state, expectedStatus, expectedErrorCode) => {
      const requests: SendMessageRequest[] = [];
      const client = fakeClient({
        async sendMessage(request) {
          requests.push(request);
          return requests.length === 1
            ? task(TaskState.TASK_STATE_SUBMITTED, "accepted")
            : task(state, "terminal detail");
        },
      });
      const consumer = new A2AConsumer({
        client,
        agentCard: idempotentAgentCard(),
        agentUrl: "http://127.0.0.1:65535",
      });

      const dispatch = await consumer.dispatchMessage({
        text: "same canonical work",
        idempotencyKey: `dispatch-state-${expectedStatus}`,
        metadata: { source: "test" },
      });
      const outcome = await dispatch.observeTerminal();

      expect(outcome.status).toBe(expectedStatus);
      expect(outcome.response.metadata.a2a.state).toBe(TaskState[state]);
      if (expectedErrorCode === undefined) {
        expect(outcome).not.toHaveProperty("error");
      } else {
        expect(outcome).toMatchObject({
          error: {
            code: expectedErrorCode,
            message: "terminal detail",
          },
        });
        expect((outcome as Exclude<A2AConsumerTerminalOutcome, { status: "completed" }>).error)
          .toBeInstanceOf(A2AConsumerError);
      }
      expect(requests).toHaveLength(2);
      expect(requests[0]?.message).toEqual(requests[1]?.message);
      expect(requests[0]?.metadata).toEqual(requests[1]?.metadata);
      expect(requests[0]?.configuration?.returnImmediately).toBe(true);
      expect(requests[1]?.configuration?.returnImmediately).toBe(false);
    },
  );
});

async function startProvider(input: {
  readonly responder: AgentResponder;
  readonly stateDir?: string;
}): Promise<A2AProviderStartResult> {
  const stateDir = input.stateDir ?? await temporaryStateDir();
  const provider = await startA2AProvider({
    host: "127.0.0.1",
    port: 0,
    responder: input.responder,
    idempotency: {
      stateDir,
      namespace: "dispatch-lifecycle-test",
      retentionMs: 60_000,
      maxRecords: 100,
    },
    agent: {
      name: "Dispatch lifecycle test agent",
      description: "Exercises durable dispatch observation.",
      version: "test",
    },
    skill: {
      id: "dispatch-lifecycle-test",
      name: "Dispatch lifecycle test",
      description: "Exercises durable dispatch observation.",
      tags: ["test"],
    },
  });
  cleanups.push(() => provider.stop().catch(() => undefined));
  return provider;
}

async function temporaryStateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-a2a-dispatch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

async function onlyRecordPath(stateDir: string): Promise<string> {
  const records = (await readdir(stateDir)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  expect(records).toHaveLength(1);
  return join(stateDir, records[0] as string);
}

function idempotentAgentCard(): AgentCard {
  const card = createA2AAgentCard({
    name: "Fake durable agent",
    description: "Fake durable dispatch agent",
    version: "test",
    publicBaseUrl: "http://127.0.0.1:65535",
    skill: {
      id: "fake",
      name: "Fake",
      description: "Fake",
      tags: ["test"],
    },
  });
  card.capabilities?.extensions.push({
    uri: A2A_IDEMPOTENCY_EXTENSION_URI,
    description: "Durable logical dispatch identity",
    required: false,
    params: {
      schemaVersion: A2A_IDEMPOTENCY_SCHEMA_VERSION,
      metadataKey: A2A_IDEMPOTENCY_METADATA_KEY,
    },
  });
  return card;
}

function fakeClient(input: {
  readonly sendMessage: (request: SendMessageRequest) => Promise<SendMessageResult>;
}): Client {
  return {
    protocolVersion: "1.0",
    sendMessage: input.sendMessage,
    async cancelTask() {
      return task(TaskState.TASK_STATE_CANCELED, "canceled");
    },
  } as unknown as Client;
}

function task(state: TaskState, text: string): Task {
  const taskId = "fake-task";
  const contextId = "fake-context";
  return {
    id: taskId,
    contextId,
    status: {
      state,
      message: message(taskId, contextId, text),
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: {},
  };
}

function message(taskId: string, contextId: string, text: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: "fake-message",
    taskId,
    contextId,
    parts: [{
      content: { $case: "text", value: text },
      mediaType: "text/plain",
      filename: "",
      metadata: {},
    }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

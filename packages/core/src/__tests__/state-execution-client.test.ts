import { describe, expect, it } from "vitest";
import type {
  StateExecution,
  StateExecutionRequest,
} from "@mono-agent/module-sdk/internal";

import { StateExecutionClient } from "../state-execution-client.js";

const signal = new AbortController().signal;
const route = { runtimeInstanceId: "runtime", model: "model" } as const;
const summary = {
  runId: "run-1",
  requestId: "request-1",
  conversationId: "conversation-1",
  status: "running",
  startedAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
  attempts: [],
} as const;
const transcript = {
  schemaVersion: 1,
  kind: "mono-agent.canonical-transcript",
  conversationId: "conversation-1",
  revision: 1,
  entries: [],
} as const;
const ref = {
  id: "artifact-1",
  sha256: `sha256:${"a".repeat(64)}` as const,
  sizeBytes: 3,
  mediaType: "application/octet-stream",
} as const;
const runtimeSession = {
  id: "session-1",
  conversationId: "conversation-1",
  route,
} as const;
const protocol = {
  protocol: "mono-agent.state-execution",
  version: 1,
  operations: [
    "transcript.append",
    "conversation.open",
    "conversation.load",
    "conversation.list",
    "run.admit",
    "run.record-attempt",
    "run.record-interaction",
    "run.stage-artifacts",
    "run.settle",
    "run.read-cached-response",
    "run.read",
    "run.list",
    "session.load",
    "session.evict",
    "delivery.prepare",
    "delivery.settle",
  ],
} as const;

class StubExecution implements StateExecution {
  readonly calls: StateExecutionRequest[] = [];

  constructor(readonly outputs: unknown[]) {}

  async perform(request: StateExecutionRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.outputs.length === 0) throw new Error("missing stub output");
    return this.outputs.shift();
  }
}

describe("StateExecutionClient", () => {
  it("maps every host operation to the opaque protocol and strips embedded signals", async () => {
    const execution = new StubExecution([
      protocol,
      transcript,
      {
        conversationId: "conversation-1",
        createdAt: "2026-07-23T10:00:00.000Z",
        updatedAt: "2026-07-23T10:00:00.000Z",
        transcript,
      },
      undefined,
      {
        conversations: [{
          conversationId: "conversation-1",
          createdAt: "2026-07-23T10:00:00.000Z",
          updatedAt: "2026-07-23T10:00:00.000Z",
        }],
      },
      { status: "accepted", summary },
      { ...summary, status: "completed" },
      summary,
      summary,
      [{ slot: "answer", ref }],
      new Uint8Array([1, 2, 3]),
      { summary, events: [], transcript: [] },
      { runs: [summary] },
      { value: runtimeSession, updatedAt: "2026-07-23T10:00:00.000Z" },
      true,
      { status: "send", attempt: 1, token: "token-1" },
      { status: "duplicate", messageId: "message-1" },
    ]);
    const client = new StateExecutionClient(execution);

    await client.assertCompatible(signal);
    await client.appendTranscript(undefined, "conversation-1", [], signal);
    await client.openConversation({ title: "New" }, signal);
    await client.loadConversation("conversation-1", signal);
    await client.listConversations(undefined, signal);
    await client.admit({
      requestId: "request-1",
      conversationId: "conversation-1",
      fingerprint: `sha256:${"b".repeat(64)}`,
      signal,
    });
    await client.settle({
      runId: "run-1",
      requestId: "request-1",
      status: "completed",
      signal,
    });
    await client.recordAttempt("run-1", {
      attempt: 1,
      route,
      status: "started",
      startedAt: "2026-07-23T10:00:00.000Z",
    }, signal);
    await client.recordInteraction("run-1", {
      kind: "live-input",
      interactionId: "interaction-1",
      phase: "applied",
      receivedAt: "2026-07-23T10:00:00.000Z",
      settledAt: "2026-07-23T10:00:00.001Z",
    }, signal);
    await client.stageRunArtifacts({
      runId: "run-1",
      requestId: "request-1",
      artifacts: [{
        slot: "answer",
        data: new Uint8Array([1]),
        mediaType: "application/octet-stream",
      }],
      signal,
    });
    await client.readCachedResponse(ref, signal);
    await client.readRun("run-1", signal);
    await client.listRuns(undefined, signal);
    await client.loadSession("conversation-1", route, signal);
    await client.evictSession(
      "conversation-1",
      route,
      { sessionId: "session-1", updatedAt: "2026-07-23T10:00:00.000Z" },
      signal,
    );
    await client.prepareDelivery({
      idempotencyKey: "delivery-1",
      fingerprint: `sha256:${"c".repeat(64)}`,
      channelInstanceId: "channel-1",
      signal,
    });
    await client.settleDelivery({
      idempotencyKey: "delivery-1",
      fingerprint: `sha256:${"c".repeat(64)}`,
      attempt: 1,
      token: "token-1",
      status: "delivered",
      signal,
    });

    expect(execution.calls.map(({ operation }) => operation)).toEqual([
      "protocol.describe",
      "transcript.append",
      "conversation.open",
      "conversation.load",
      "conversation.list",
      "run.admit",
      "run.settle",
      "run.record-attempt",
      "run.record-interaction",
      "run.stage-artifacts",
      "run.read-cached-response",
      "run.read",
      "run.list",
      "session.load",
      "session.evict",
      "delivery.prepare",
      "delivery.settle",
    ]);
    expect(execution.calls.every((call) => call.signal === signal)).toBe(true);
    expect(execution.calls.every((call) =>
      typeof call.input !== "object"
      || call.input === null
      || !Object.hasOwn(call.input, "signal"))).toBe(true);
  });

  it.each([
    {
      label: "unknown protocol",
      value: { ...protocol, protocol: "future.state-execution" },
    },
    {
      label: "unsupported version",
      value: { ...protocol, version: 2 },
    },
    {
      label: "missing operation",
      value: { ...protocol, operations: protocol.operations.slice(1) },
    },
    {
      label: "duplicate operation",
      value: { ...protocol, operations: [...protocol.operations, protocol.operations[0]] },
    },
  ])("fails the startup handshake for $label", async ({ value }) => {
    const client = new StateExecutionClient(new StubExecution([value]));
    await expect(client.assertCompatible(signal)).rejects.toThrow(/malformed protocol/u);
  });

  it("fails closed when the private protocol returns malformed output", async () => {
    const outputs: unknown[] = [{ status: "future-admission" }];
    const client = new StateExecutionClient(new StubExecution(outputs));
    await expect(client.admit({
      requestId: "request-1",
      conversationId: "conversation-1",
      fingerprint: `sha256:${"d".repeat(64)}`,
      signal,
    })).rejects.toThrow(/malformed run admission/u);

    outputs.push({ status: "send", attempt: 1 });
    await expect(client.prepareDelivery({
      idempotencyKey: "delivery-1",
      fingerprint: `sha256:${"e".repeat(64)}`,
      channelInstanceId: "channel-1",
      signal,
    })).rejects.toThrow(/malformed delivery token/u);

    outputs.push("not-bytes");
    await expect(client.readCachedResponse(ref, signal)).rejects.toThrow(
      /malformed cached response/u,
    );

    outputs.push(Object.defineProperty({}, "status", { get: () => "join" }));
    await expect(client.prepareDelivery({
      idempotencyKey: "delivery-2",
      fingerprint: `sha256:${"f".repeat(64)}`,
      channelInstanceId: "channel-1",
      signal,
    })).rejects.toThrow(/malformed delivery/u);
  });

  it("detaches valid output and rejects hostile nested values without invoking accessors", async () => {
    const raw = {
      summary: { ...summary },
      events: [],
      transcript: [],
    };
    const outputs: unknown[] = [raw];
    const client = new StateExecutionClient(new StubExecution(outputs));
    const detached = await client.readRun("run-1", signal);
    (raw.summary as { runId: string }).runId = "mutated";
    expect(detached?.summary.runId).toBe("run-1");

    let accessorCalls = 0;
    const hostilePart = Object.defineProperty(
      { type: "text" },
      "text",
      { enumerable: true, get() { accessorCalls += 1; return "secret"; } },
    );
    outputs.push({
      ...transcript,
      entries: [{
        kind: "message",
        entryId: "entry-1",
        runId: "run-1",
        requestId: "request-1",
        conversationId: "conversation-1",
        recordedAt: "2026-07-23T10:00:00.000Z",
        role: "assistant",
        content: [hostilePart],
      }],
    });
    await expect(client.appendTranscript(undefined, "conversation-1", [], signal))
      .rejects.toThrow(/malformed transcript\.append/u);
    expect(accessorCalls).toBe(0);

    outputs.push({
      ...summary,
      attempts: [{
        attempt: 1,
        route,
        status: "started",
        startedAt: "2026-07-23T10:00:00.000Z",
        futureField: true,
      }],
    });
    await expect(client.recordAttempt("run-1", {
      attempt: 1,
      route,
      status: "started",
      startedAt: "2026-07-23T10:00:00.000Z",
    }, signal)).rejects.toThrow(/malformed run attempt/u);

    outputs.push({ ...summary, runId: "x".repeat(1_000_001) });
    await expect(client.recordAttempt("run-1", {
      attempt: 1,
      route,
      status: "started",
      startedAt: "2026-07-23T10:00:00.000Z",
    }, signal)).rejects.toThrow(/malformed run runId/u);
  });

  it("accepts attachment-only and empty assistant transcript text from durable state", async () => {
    const entries = [
      {
        kind: "message",
        entryId: "entry-user",
        runId: "run-1",
        requestId: "request-1",
        conversationId: "conversation-1",
        recordedAt: "2026-07-23T10:00:00.000Z",
        role: "user",
        content: [{ type: "artifact", ref, name: "input.bin" }],
      },
      {
        kind: "message",
        entryId: "entry-assistant",
        runId: "run-1",
        requestId: "request-1",
        conversationId: "conversation-1",
        recordedAt: "2026-07-23T10:00:00.001Z",
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    ] as const;
    const client = new StateExecutionClient(new StubExecution([{
      conversationId: "conversation-1",
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:00.001Z",
      transcript: { ...transcript, entries },
    }]));

    await expect(client.loadConversation("conversation-1", signal)).resolves.toMatchObject({
      transcript: { entries },
    });
  });
});

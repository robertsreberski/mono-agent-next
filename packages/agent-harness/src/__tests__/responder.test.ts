import { describe, expect, it } from "vitest";

import {
  createChannelUserCancelReason,
  isAgentResponseCancelledError,
  type AgentLiveInputRequest,
  type AgentMessageStream,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";

import { bucketConversationId, createAgentResponder, streamEventFromRuntimeEvent } from "../responder.js";
import type { AgentHarness, AgentHarnessRequest, AgentHarnessResponse } from "../types.js";

function okResponse(conversationId: string): AgentHarnessResponse {
  return {
    text: "ok",
    metadata: { runId: "r", conversationId, contextSources: [], contextSectionIds: [] },
  };
}

function noopStream(): AgentMessageStream {
  return { append: async () => {} };
}

function baseRequest(conversationId = "c1") {
  return { conversationId, text: "hi", abortSignal: new AbortController().signal };
}

describe("createAgentResponder", () => {
  it("maps live input onto the exact active daily bucket and closes the mapping after the turn", async () => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let finish!: (response: AgentHarnessResponse) => void;
    const finished = new Promise<AgentHarnessResponse>((resolve) => { finish = resolve; });
    let offered: AgentLiveInputRequest | undefined;
    const harness: AgentHarness = {
      async run() {
        start();
        return finished;
      },
      offerLiveInput(request) {
        offered = request;
        return { status: "unavailable", reason: "inactive" };
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-07-21T23:59:59.000Z"),
    });
    const response = responder.respond(baseRequest("telegram:42"), noopStream());
    await started;

    expect(responder.offerLiveInput?.({
      conversationId: "telegram:42",
      id: "input-1",
      text: "Follow up",
      receivedAt: "2026-07-21T23:59:59.500Z",
    })).toEqual({ status: "unavailable", reason: "inactive" });
    expect(offered?.conversationId).toBe("telegram:42#2026-07-21");

    finish(okResponse("telegram:42#2026-07-21"));
    await response;
    offered = undefined;
    expect(responder.offerLiveInput?.({
      conversationId: "telegram:42",
      id: "input-2",
      text: "Too late",
      receivedAt: "2026-07-22T00:00:01.000Z",
    })).toEqual({ status: "unavailable", reason: "inactive" });
    expect(offered).toBeUndefined();
  });

  it("emits one completed synthetic Steered tool activity only after live input is applied", async () => {
    let activeRequest: AgentHarnessRequest | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishRun!: () => void;
    const finished = new Promise<void>((resolve) => { finishRun = resolve; });
    let settle!: (value: { status: "applied"; runId: string }) => void;
    const settled = new Promise<{ status: "applied"; runId: string }>((resolve) => { settle = resolve; });
    const harness: AgentHarness = {
      async run(request) {
        activeRequest = request;
        markStarted();
        await finished;
        return okResponse(request.conversationId);
      },
      offerLiveInput() {
        return { status: "accepted", settled };
      },
    };
    const events: AgentStreamEvent[] = [];
    const responder = createAgentResponder({ harness });
    const response = responder.respond(baseRequest(), {
      append: async () => {},
      event: async (event) => { events.push(event); },
    });
    await started;

    const offer = responder.offerLiveInput?.({
      conversationId: "c1",
      id: "follow-up-1",
      text: "Use TOKEN=fixture then test the fallback",
      receivedAt: "2026-07-22T08:30:00.000Z",
    });
    expect(offer?.status).toBe("accepted");
    settle({ status: "applied", runId: "run-1" });
    await settled;
    await Promise.resolve();
    activeRequest?.onEvent?.({
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    });
    activeRequest?.onEvent?.({
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    });
    finishRun();
    await response;

    const metadata = {
      liveInput: true,
      synthetic: true,
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    };
    expect(events).toEqual([
      {
        type: "tool_call_started",
        id: "live-input:follow-up-1",
        name: "↪️ Steered: “Use TOKEN=[redacted] then test the fall…”",
        metadata,
      },
      {
        type: "tool_call_completed",
        id: "live-input:follow-up-1",
        name: "↪️ Steered: “Use TOKEN=[redacted] then test the fall…”",
        content: "Applied to current run",
        metadata,
      },
    ]);
  });

  it("does not emit steering activity for a requeued live-input offer", async () => {
    let activeRequest: AgentHarnessRequest | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishRun!: () => void;
    const finished = new Promise<void>((resolve) => { finishRun = resolve; });
    let settle!: (value: { status: "requeue"; reason: "closed" }) => void;
    const settled = new Promise<{ status: "requeue"; reason: "closed" }>((resolve) => { settle = resolve; });
    const harness: AgentHarness = {
      async run(request) {
        activeRequest = request;
        markStarted();
        await finished;
        return okResponse(request.conversationId);
      },
      offerLiveInput() {
        return { status: "accepted", settled };
      },
    };
    const events: AgentStreamEvent[] = [];
    const responder = createAgentResponder({ harness });
    const response = responder.respond(baseRequest(), {
      append: async () => {},
      event: async (event) => { events.push(event); },
    });
    await started;

    responder.offerLiveInput?.({
      conversationId: "c1",
      id: "follow-up-2",
      text: "Run this next instead",
      receivedAt: "2026-07-22T08:31:00.000Z",
    });
    settle({ status: "requeue", reason: "closed" });
    await settled;
    finishRun();
    await response;

    expect(activeRequest).toBeDefined();
    expect(events).toEqual([]);
  });

  it("routes respond() through harness.submit when available (queue-after-turn)", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        calls.push("run");
        return okResponse(request.conversationId);
      },
      submit: async (request: AgentHarnessRequest) => {
        calls.push("submit");
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), noopStream());

    expect(calls).toEqual(["submit"]);
  });

  it("forwards host-only reply and continuation controls without changing the session bucket", async () => {
    let seen: AgentHarnessRequest | undefined;
    const harness: AgentHarness = {
      run: async (request) => {
        seen = request;
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-07-14T12:00:00Z"),
    });

    await responder.respond({
      ...baseRequest("slack:C1:thread"),
      replyTo: { conversationId: "slack:C1:thread" },
      continuation: {
        continuationId: "continuation-1",
        originRunId: "run-origin",
        originContextPolicy: "detached_latest",
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    }, noopStream());

    expect(seen?.conversationId).toBe("slack:C1:thread#2026-07-14");
    expect(seen?.replyTo).toEqual({ conversationId: "slack:C1:thread" });
    expect(seen?.continuation).toMatchObject({ continuationId: "continuation-1", originRunId: "run-origin" });
  });

  it("preserves an explicit prior-day origin bucket for continuation synthesis", async () => {
    let seen: AgentHarnessRequest | undefined;
    const responder = createAgentResponder({
      harness: {
        run: async (request) => {
          seen = request;
          return okResponse(request.conversationId);
        },
      },
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-07-15T12:00:00Z"),
    });

    await responder.respond({
      ...baseRequest("slack:C1:thread#2026-07-14"),
      continuation: {
        continuationId: "continuation-prior-day",
        originRunId: "run-prior-day",
        originContextPolicy: "detached_latest",
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    }, noopStream());

    expect(seen?.conversationId).toBe("slack:C1:thread#2026-07-14");
    expect(seen?.sessionBoundary).toBeUndefined();
  });

  it("falls back to harness.run when submit is absent", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        calls.push("run");
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), noopStream());

    expect(calls).toEqual(["run"]);
  });

  it("deliverVerbatim delegates to harness.appendVerbatimTurn under the same bucketed id as respond()", async () => {
    const verbatim: Array<[string, string, string | undefined]> = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      appendVerbatimTurn: async (conversationId: string, text: string, options) => {
        verbatim.push([conversationId, text, options?.idempotencyKey]);
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-06-24T10:00:00Z"),
    });

    await responder.deliverVerbatim!("telegram:42", "Morning brief.", { idempotencyKey: "delivery:one" });

    // Bucketed identically to respond(), so a later reply resumes with it in context.
    expect(verbatim).toEqual([["telegram:42#2026-06-24", "Morning brief.", "delivery:one"]]);
  });

  it("streams each assistant text delta to stream.append in order (no batching)", async () => {
    const appended: string[] = [];
    const stream: AgentMessageStream = {
      append: async (delta: string) => {
        appended.push(delta);
      },
    };
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Hel" }] } });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "lo" }] } });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "!" }] } });
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), stream);

    expect(appended).toEqual(["Hel", "lo", "!"]);
  });

  it("returns response text without trimming trailing formatting", async () => {
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => ({
        ...okResponse(request.conversationId),
        text: "ok\n\n",
      }),
    };
    const responder = createAgentResponder({ harness });

    const response = await responder.respond(baseRequest(), noopStream());

    expect(response.text).toBe("ok\n\n");
  });

  it("cancel(conversationId) delegates to the harness", async () => {
    const cancelled: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      cancel: (conversationId: string) => {
        cancelled.push(conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    responder.cancel?.("conv-7");

    expect(cancelled).toEqual(["conv-7"]);
  });

  it("starts a new session under the same rollover bucket after cancelling earlier work", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request) => okResponse(request.conversationId),
      cancel: (conversationId) => {
        calls.push(`cancel:${conversationId}`);
      },
      resetConversation: async (conversationId) => {
        calls.push(`reset:${conversationId}`);
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    await responder.startNewSession("telegram:42");

    expect(calls).toEqual([
      "cancel:telegram:42#2026-07-18",
      "reset:telegram:42#2026-07-18",
    ]);
  });

  it("cancels responder-queued turns before they can reach the harness", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const submitted: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      submit: async (request: AgentHarnessRequest) => {
        submitted.push(request.userMessage);
        if (submitted.length === 1) {
          firstStarted();
          await firstRelease;
        }
        return okResponse(request.conversationId);
      },
      cancel: () => undefined,
    };
    const responder = createAgentResponder({ harness });
    const first = responder.respond({ ...baseRequest(), text: "first" }, noopStream());
    await started;
    const queued = responder.respond({ ...baseRequest(), text: "queued" }, noopStream());
    const reason = createChannelUserCancelReason("Test");

    responder.cancel("c1", reason);
    releaseFirst();

    await expect(first).resolves.toMatchObject({ text: "ok" });
    await expect(queued).rejects.toSatisfy((error: unknown) =>
      isAgentResponseCancelledError(error) && error.reason === reason,
    );
    expect(submitted).toEqual(["first"]);

    await expect(responder.respond({ ...baseRequest(), text: "after" }, noopStream()))
      .resolves.toMatchObject({ text: "ok" });
    expect(submitted).toEqual(["first", "after"]);
  });

  it("applies a daily bucket to respond() and cancel() with the same key", async () => {
    const seen: { submitted?: string; cancelled?: string } = {};
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      submit: async (request: AgentHarnessRequest) => {
        seen.submitted = request.conversationId;
        return okResponse(request.conversationId);
      },
      cancel: (conversationId: string) => {
        seen.cancelled = conversationId;
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-06-19T23:30:00Z"),
    });

    await responder.respond(baseRequest("telegram:42"), noopStream());
    responder.cancel?.("telegram:42");

    expect(seen.submitted).toBe("telegram:42#2026-06-19");
    // cancel buckets identically, so it targets the same queue/session key.
    expect(seen.cancelled).toBe("telegram:42#2026-06-19");
  });

  it("cancels the active daily bucket when midnight passes during the turn", async () => {
    let now = new Date("2026-06-19T23:59:00Z");
    let release!: () => void;
    let started!: () => void;
    const releaseTurn = new Promise<void>((resolve) => { release = resolve; });
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    const submitted: string[] = [];
    const cancelled: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      submit: async (request: AgentHarnessRequest) => {
        submitted.push(request.conversationId);
        started();
        await releaseTurn;
        return okResponse(request.conversationId);
      },
      cancel: (conversationId) => { cancelled.push(conversationId); },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => now,
    });

    const active = responder.respond(baseRequest("telegram:42"), noopStream());
    await turnStarted;
    now = new Date("2026-06-20T00:01:00Z");
    responder.cancel("telegram:42");
    release();
    await active;

    expect(submitted).toEqual(["telegram:42#2026-06-19"]);
    expect(cancelled).toEqual(["telegram:42#2026-06-19"]);
  });

  it("replaces an old daily bucket suffix instead of appending another one", async () => {
    expect(bucketConversationId(
      "telegram:42#2026-06-18",
      "daily",
      "UTC",
      () => new Date("2026-06-19T23:30:00Z"),
    )).toBe("telegram:42#2026-06-19");
  });

  it("passes a rollover session_boundary only on the first turn of a new bucket", async () => {
    let now = new Date("2026-06-19T23:30:00Z");
    const seen: AgentHarnessRequest[] = [];
    const streamed: AgentStreamEvent[] = [];
    const harness: AgentHarness = {
      submit: async (request: AgentHarnessRequest) => {
        seen.push(request);
        if (request.sessionBoundary !== undefined) {
          request.onEvent?.({ ...request.sessionBoundary });
        }
        return okResponse(request.conversationId);
      },
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => now,
    });
    const stream: AgentMessageStream = {
      append: async () => {},
      event: async (event) => {
        streamed.push(event);
      },
    };

    await responder.respond(baseRequest("telegram:42"), stream);
    now = new Date("2026-06-20T00:05:00Z");
    await responder.respond(baseRequest("telegram:42"), stream);
    await responder.respond(baseRequest("telegram:42"), stream);

    expect(seen.map((request) => request.conversationId)).toEqual([
      "telegram:42#2026-06-19",
      "telegram:42#2026-06-20",
      "telegram:42#2026-06-20",
    ]);
    expect(seen[0]?.sessionBoundary).toBeUndefined();
    expect(seen[1]?.sessionBoundary).toMatchObject({
      type: "session_boundary",
      kind: "rollover",
      conversationId: "telegram:42#2026-06-20",
      baseConversationId: "telegram:42",
      previousConversationId: "telegram:42#2026-06-19",
    });
    expect(seen[2]?.sessionBoundary).toBeUndefined();
    expect(streamed).toContainEqual({
      type: "runtime_telemetry",
      kind: "session_boundary",
      data: {
        kind: "rollover",
        conversationId: "telegram:42#2026-06-20",
        baseConversationId: "telegram:42",
        previousConversationId: "telegram:42#2026-06-19",
        timestamp: "2026-06-20T00:05:00.000Z",
      },
    });
  });

  it("streams and returns an opt-in rollover notice without writing durable history", async () => {
    let now = new Date("2026-06-19T23:30:00Z");
    const verbatim: Array<[string, string]> = [];
    const appended: string[] = [];
    const harness: AgentHarness = {
      submit: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      appendVerbatimTurn: async (conversationId, text) => {
        verbatim.push([conversationId, text]);
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      rolloverNotice: true,
      now: () => now,
    });

    await responder.respond(baseRequest("telegram:42"), noopStream());
    now = new Date("2026-06-20T00:05:00Z");
    const response = await responder.respond(baseRequest("telegram:42"), {
      append: async (delta) => {
        appended.push(delta);
      },
    });

    expect(verbatim).toEqual([]);
    expect(appended).toEqual(["New session bucket started: telegram:42#2026-06-20.\n\n"]);
    expect(response.text).toBe("New session bucket started: telegram:42#2026-06-20.\n\nok");
  });

  it("serializes rollover boundary decisions per base conversation", async () => {
    let now = new Date("2026-06-19T23:30:00Z");
    let firstNewStarted!: () => void;
    let releaseFirstNew!: () => void;
    const firstNewSubmitted = new Promise<void>((resolve) => {
      firstNewStarted = resolve;
    });
    const firstNewRelease = new Promise<void>((resolve) => {
      releaseFirstNew = resolve;
    });
    const seen: AgentHarnessRequest[] = [];
    const harness: AgentHarness = {
      submit: async (request: AgentHarnessRequest) => {
        seen.push(request);
        if (seen.length === 2) {
          firstNewStarted();
          await firstNewRelease;
        }
        return okResponse(request.conversationId);
      },
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => now,
    });

    await responder.respond(baseRequest("telegram:42"), noopStream());
    now = new Date("2026-06-20T00:05:00Z");
    const first = responder.respond(baseRequest("telegram:42"), noopStream());
    await firstNewSubmitted;
    const second = responder.respond(baseRequest("telegram:42"), noopStream());
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(2);
    releaseFirstNew();
    await Promise.all([first, second]);

    expect(seen).toHaveLength(3);
    expect(seen[1]?.sessionBoundary).toMatchObject({
      kind: "rollover",
      conversationId: "telegram:42#2026-06-20",
      previousConversationId: "telegram:42#2026-06-19",
    });
    expect(seen[2]?.sessionBoundary).toBeUndefined();
  });

  it("does not bucket the conversationId when rollover is off (default)", async () => {
    let submitted = "";
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      submit: async (request: AgentHarnessRequest) => {
        submitted = request.conversationId;
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest("cron:scan"), noopStream());

    expect(submitted).toBe("cron:scan");
  });

  it("does not serialize distinct non-rollover conversations that naturally end with daily bucket syntax", async () => {
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const harness: AgentHarness = {
      submit: async (request: AgentHarnessRequest) => {
        started.push(request.conversationId);
        if (started.length === 1) {
          await firstRelease;
        }
        return okResponse(request.conversationId);
      },
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
    };
    const responder = createAgentResponder({ harness });

    const first = responder.respond(baseRequest("thread#2026-06-19"), noopStream());
    await Promise.resolve();
    const second = responder.respond(baseRequest("thread#2026-06-20"), noopStream());
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["thread#2026-06-19", "thread#2026-06-20"]);
    releaseFirst();
    await Promise.all([first, second]);
  });
});

describe("streamEventFromRuntimeEvent telemetry mapping", () => {
  it("maps tool_update to tool_call_progress", () => {
    expect(
      streamEventFromRuntimeEvent({
        type: "tool_update",
        tool_use_id: "t1",
        name: "bash",
        input: { command: "ls" },
        partial_result: "file-a\n",
      }),
    ).toEqual({ type: "tool_call_progress", id: "t1", name: "bash", partialResult: "file-a\n" });
  });

  it("maps cost_accumulated to usage_update with renamed cache token fields", () => {
    expect(
      streamEventFromRuntimeEvent({
        type: "cost_accumulated",
        sdk: "pi",
        model: "claude-fable-5",
        cumulativeUsd: 0.42,
        tokens: { input: 10, output: 5, cacheReadTokens: 300, cacheCreationTokens: 7 },
      }),
    ).toEqual({
      type: "usage_update",
      model: "claude-fable-5",
      cumulativeUsd: 0.42,
      tokens: { input: 10, output: 5, cacheRead: 300, cacheCreation: 7 },
    });
  });

  it("maps provider request lifecycle to provider_status", () => {
    expect(
      streamEventFromRuntimeEvent({
        type: "provider_request_started",
        sdk: "pi",
        model: "claude-fable-5",
        runtime: "pi",
        timestamp: 1,
      }),
    ).toEqual({ type: "provider_status", kind: "request_started", model: "claude-fable-5" });

    expect(
      streamEventFromRuntimeEvent({
        type: "provider_request_completed",
        sdk: "pi",
        model: "claude-fable-5",
        runtime: "pi",
        timestamp: 2,
        durationMs: 1234,
        cancelled: false,
      }),
    ).toEqual({
      type: "provider_status",
      kind: "request_completed",
      model: "claude-fable-5",
      durationMs: 1234,
      cancelled: false,
    });
  });

  it("maps provider failover to provider_status", () => {
    expect(
      streamEventFromRuntimeEvent({
        type: "provider_failover_started",
        from: "gpt-5.5",
        to: "kimi",
        attemptIndex: 1,
      }),
    ).toEqual({ type: "provider_status", kind: "failover_started", from: "gpt-5.5", to: "kimi", attemptIndex: 1 });

    expect(
      streamEventFromRuntimeEvent({ type: "provider_failover_completed", attemptIndex: 1, model: "kimi" }),
    ).toEqual({ type: "provider_status", kind: "failover_completed", model: "kimi", attemptIndex: 1 });
  });

  it("maps memory_recalled through with source and bytes", () => {
    expect(streamEventFromRuntimeEvent({ type: "memory_recalled", source: "bujo", bytes: 512 }))
      .toEqual({ type: "memory_recalled", source: "bujo", bytes: 512 });
    expect(streamEventFromRuntimeEvent({ type: "memory_recalled", bytes: 16 }))
      .toEqual({ type: "memory_recalled", bytes: 16 });
  });

  it("wraps allowlisted telemetry kinds as runtime_telemetry with the payload minus type", () => {
    expect(
      streamEventFromRuntimeEvent({ type: "cache_hit", sdk: "pi", model: "m", tokens: 400, source: "prompt_cache" }),
    ).toEqual({
      type: "runtime_telemetry",
      kind: "cache_hit",
      data: { sdk: "pi", model: "m", tokens: 400, source: "prompt_cache" },
    });
    expect(streamEventFromRuntimeEvent({ type: "cache_miss", tokens: 12 }))
      .toEqual({ type: "runtime_telemetry", kind: "cache_miss", data: { tokens: 12 } });
    expect(streamEventFromRuntimeEvent({ type: "capabilities_resolved", capabilitiesUsed: ["vision"] }))
      .toEqual({ type: "runtime_telemetry", kind: "capabilities_resolved", data: { capabilitiesUsed: ["vision"] } });
    expect(streamEventFromRuntimeEvent({ type: "provider_bridge_latency", durationMs: 88, timestamp: "t" }))
      .toEqual({ type: "runtime_telemetry", kind: "provider_bridge_latency", data: { durationMs: 88, timestamp: "t" } });
    expect(streamEventFromRuntimeEvent({
      type: "context_usage",
      model: "pi:openai-codex:gpt-5.5",
      contextWindow: 372_000,
      tokens: { input: 100, output: 20, cacheRead: 800, cacheCreation: 5, total: 925 },
    })).toEqual({
      type: "runtime_telemetry",
      kind: "context_usage",
      data: {
        model: "pi:openai-codex:gpt-5.5",
        contextWindow: 372_000,
        tokens: { input: 100, output: 20, cacheRead: 800, cacheCreation: 5, total: 925 },
      },
    });
    expect(streamEventFromRuntimeEvent({
      type: "context_compaction",
      operationId: "compact-1",
      status: "running",
      sdk: "pi",
      trigger: "proactive",
      timestamp: 1_750_000_000_000,
    })).toEqual({
      type: "runtime_telemetry",
      kind: "context_compaction",
      data: {
        operationId: "compact-1",
        status: "running",
        sdk: "pi",
        trigger: "proactive",
        timestamp: 1_750_000_000_000,
      },
    });
  });

  it("wraps run_config as runtime_telemetry with effort/model intact", () => {
    expect(
      streamEventFromRuntimeEvent({
        type: "run_config",
        model: "pi:openai-codex:gpt-5.5",
        effort: "high",
        executionMode: "sdk",
        overridden: true,
        timestamp: "t",
      }),
    ).toEqual({
      type: "runtime_telemetry",
      kind: "run_config",
      data: {
        model: "pi:openai-codex:gpt-5.5",
        effort: "high",
        executionMode: "sdk",
        overridden: true,
        timestamp: "t",
      },
    });
  });

  it("still returns undefined for unknown event types (no accidental catch-all)", () => {
    expect(streamEventFromRuntimeEvent({ type: "system", subtype: "init" })).toBeUndefined();
    expect(streamEventFromRuntimeEvent({ type: "result", result: "big payload" })).toBeUndefined();
    expect(streamEventFromRuntimeEvent("not an object")).toBeUndefined();
  });

  it("maps thinking blocks to assistant_thought but NOT commentary-phase text (tool preambles are not reasoning)", () => {
    expect(
      streamEventFromRuntimeEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: "reason about it" }] },
      }),
    ).toEqual({ type: "assistant_thought", text: "reason about it" });

    // A phase:"commentary" text block (tool-preamble narration) is status,
    // not model reasoning — it must not become an assistant_thought. This
    // also matches replay, where classifyAssistantContent counts only
    // thinking-typed blocks as the thinking category.
    expect(
      streamEventFromRuntimeEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "inspecting glob results", phase: "commentary" }] },
      }),
    ).toBeUndefined();
  });

  it("records tool_timing into the context map instead of emitting, then stamps executionMs onto tool_call_completed", () => {
    const toolTimings = new Map<string, number>();

    const timing = streamEventFromRuntimeEvent(
      { type: "tool_timing", tool_use_id: "t9", name: "bash", execution_ms: 777, is_error: false },
      { toolTimings },
    );
    expect(timing).toBeUndefined();
    expect(toolTimings.get("t9")).toBe(777);

    const completed = streamEventFromRuntimeEvent(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "ok", is_error: false }] },
      },
      { toolTimings },
    );
    expect(completed).toEqual({
      type: "tool_call_completed",
      id: "t9",
      content: "ok",
      isError: false,
      executionMs: 777,
    });
    // Consumed on use so the per-turn map stays bounded.
    expect(toolTimings.has("t9")).toBe(false);
  });

  it("omits executionMs when no timing was recorded for the tool call", () => {
    expect(
      streamEventFromRuntimeEvent(
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
        { toolTimings: new Map() },
      ),
    ).toEqual({ type: "tool_call_completed", id: "t1", content: "x" });
  });
});

describe("respond() end-to-end event forwarding", () => {
  it("forwards the full telemetry stream in order with executionMs merged onto tool completion", async () => {
    const events: AgentStreamEvent[] = [];
    const stream: AgentMessageStream = {
      append: async () => {},
      event: async (event) => {
        events.push(event);
      },
    };
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        const emit = request.onEvent!;
        emit({ type: "provider_request_started", sdk: "pi", model: "m1", runtime: "pi", timestamp: 1 });
        emit({ type: "assistant", message: { content: [{ type: "thinking", text: "hmm" }] } });
        emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] } });
        emit({ type: "tool_update", tool_use_id: "t1", name: "bash", partial_result: "partial" });
        emit({ type: "tool_timing", tool_use_id: "t1", name: "bash", execution_ms: 55, is_error: false });
        emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: false }] } });
        emit({ type: "cost_accumulated", cumulativeUsd: 0.01, tokens: { input: 1, output: 2, cacheReadTokens: 3, cacheCreationTokens: 4 } });
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), stream);

    expect(events).toEqual([
      { type: "provider_status", kind: "request_started", model: "m1" },
      { type: "assistant_thought", text: "hmm" },
      { type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } },
      { type: "tool_call_progress", id: "t1", name: "bash", partialResult: "partial" },
      { type: "tool_call_completed", id: "t1", content: "done", isError: false, executionMs: 55 },
      { type: "usage_update", cumulativeUsd: 0.01, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } },
    ]);
  });

  it("routes commentary-phase text to stream.status only — never into thinking or the answer", async () => {
    const events: AgentStreamEvent[] = [];
    const appended: string[] = [];
    const statuses: string[] = [];
    const stream: AgentMessageStream = {
      append: async (delta: string) => {
        appended.push(delta);
      },
      event: async (event) => {
        events.push(event);
      },
      status: async (text: string) => {
        statuses.push(text);
      },
    };
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        const emit = request.onEvent!;
        emit({ type: "assistant", message: { content: [{ type: "text", text: "inspecting glob results", phase: "commentary" }] } });
        emit({ type: "assistant", message: { content: [{ type: "thinking", text: "actual reasoning" }] } });
        emit({ type: "assistant", message: { content: [{ type: "text", text: "The answer." }] } });
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), stream);

    // Commentary contributes NOTHING to thinking (so thinking chars/duration
    // stats reflect pure reasoning) and nothing to the streamed answer.
    expect(events).toEqual([{ type: "assistant_thought", text: "actual reasoning" }]);
    expect(appended).toEqual(["The answer."]);
    // The operator still sees the preamble transiently as ephemeral status.
    expect(statuses).toEqual(["inspecting glob results"]);
  });

  it("drops commentary-phase text entirely when the stream has no status callback", async () => {
    const events: AgentStreamEvent[] = [];
    const appended: string[] = [];
    const stream: AgentMessageStream = {
      append: async (delta: string) => {
        appended.push(delta);
      },
      event: async (event) => {
        events.push(event);
      },
    };
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "inspecting glob results", phase: "commentary" }] } });
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), stream);

    expect(events).toEqual([]);
    expect(appended).toEqual([]);
  });

  it("scopes tool timing state per respond() call (no bleed across turns)", async () => {
    const completions: AgentStreamEvent[] = [];
    const stream: AgentMessageStream = {
      append: async () => {},
      event: async (event) => {
        if (event.type === "tool_call_completed") {
          completions.push(event);
        }
      },
    };
    let turn = 0;
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        turn += 1;
        if (turn === 1) {
          // Timing recorded but the tool never completes this turn.
          request.onEvent?.({ type: "tool_timing", tool_use_id: "tX", name: "bash", execution_ms: 999, is_error: false });
        } else {
          request.onEvent?.({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tX", content: "late" }] } });
        }
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), stream);
    await responder.respond(baseRequest(), stream);

    // The second turn must not inherit turn one's orphaned timing.
    expect(completions).toEqual([{ type: "tool_call_completed", id: "tX", content: "late" }]);
  });
});

describe("bucketConversationId", () => {
  const at = (iso: string) => () => new Date(iso);

  it("appends a local-date bucket under the daily policy", () => {
    expect(bucketConversationId("cron:scan", "daily", "UTC", at("2026-06-19T10:00:00Z")))
      .toBe("cron:scan#2026-06-19");
  });

  it("is a passthrough when rollover is none/undefined", () => {
    expect(bucketConversationId("cron:scan", "none", "UTC", at("2026-06-19T10:00:00Z"))).toBe("cron:scan");
    expect(bucketConversationId("cron:scan", undefined, "UTC", at("2026-06-19T10:00:00Z"))).toBe("cron:scan");
  });

  it("is idempotent within the same day (no double suffix)", () => {
    const once = bucketConversationId("cron:scan", "daily", "UTC", at("2026-06-19T10:00:00Z"));
    const twice = bucketConversationId(once, "daily", "UTC", at("2026-06-19T18:00:00Z"));
    expect(twice).toBe("cron:scan#2026-06-19");
  });

  it("honors the rollover timezone at the day boundary", () => {
    // 00:30 UTC on the 20th is still the 19th in New York (UTC-4 in June).
    expect(bucketConversationId("c", "daily", "America/New_York", at("2026-06-20T00:30:00Z")))
      .toBe("c#2026-06-19");
    // Same instant in Rome (UTC+2) is already the 20th.
    expect(bucketConversationId("c", "daily", "Europe/Rome", at("2026-06-20T00:30:00Z")))
      .toBe("c#2026-06-20");
  });

  it("falls back to system-local when the timezone is invalid", () => {
    expect(bucketConversationId("c", "daily", "Not/AZone", at("2026-06-19T10:00:00Z")))
      .toMatch(/^c#\d{4}-\d{2}-\d{2}$/);
  });
});

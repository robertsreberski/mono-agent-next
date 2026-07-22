import dns from "node:dns";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  isChannelUserCancelReason,
  parseAgentStreamFrame,
  serializeAgentStreamFrame,
  type AgentMessageStream,
  type AgentLiveInputRequest,
  type AgentLiveInputSettlement,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamWireFrame,
  type ChannelAskSubmission,
  type ChannelInteractionHub,
} from "@mono-agent/agent-contracts";

import { MAX_FRAME_BYTES, startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

let running: TuiAdapterStartResult | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function scriptedResponder(
  script: (request: AgentRequestBase, stream: AgentMessageStream) => Promise<AgentResponse>,
  cancel?: (conversationId: string, reason?: unknown) => void,
): AgentResponder {
  return { respond: script, ...(cancel === undefined ? {} : { cancel }) };
}

async function readFrames(response: globalThis.Response): Promise<AgentStreamWireFrame[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseAgentStreamFrame);
}

async function postTurn(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("startTuiAdapter", () => {
  it("serves /v1/info with schema and identity", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5" },
    });

    const info = await (await fetch(running.infoUrl)).json();
    const legacy = await fetch(`${new URL(running.baseUrl).origin}/tui/v1/info`);

    expect(running.baseUrl).toMatch(/\/gui$/u);
    expect(legacy.status).toBe(404);
    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      label: "test-agent",
      model: "claude-fable-5",
    });
  });

  it("advertises and serves structured AskUser state through the operator boundary", async () => {
    const snapshot = {
      interactionId: "ask-test",
      questions: [{
        id: "q0",
        header: "Delivery",
        question: "Send the draft?",
        options: [
          { id: "q0o0", label: "Send", description: "Send it now." },
          { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        ],
        multiSelect: false,
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending" as const,
      createdAt: "2026-07-21T09:00:00.000Z",
      expiresAt: "2026-07-21T09:10:00.000Z",
    };
    let submission: ChannelAskSubmission | undefined;
    const interaction: ChannelInteractionHub = {
      registerSink: () => undefined,
      getPendingAsk: (conversationId) => conversationId === "web:thread/one" ? snapshot : undefined,
      submitAskAnswers: (input) => {
        submission = input;
        return { accepted: true, snapshot: { ...snapshot, status: "answered" } };
      },
      cancelAsks: () => undefined,
    };
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      interaction,
    });

    await expect((await fetch(running.infoUrl)).json()).resolves.toMatchObject({
      capabilities: { attachments: true, askUser: true },
    });
    const route = `${running.baseUrl}/v1/conversations/${encodeURIComponent("web:thread/one")}/ask`;
    await expect((await fetch(route)).json()).resolves.toEqual({ ask: snapshot });
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ask-test",
        answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
      }),
    });
    await expect(response.json()).resolves.toMatchObject({ accepted: true, snapshot: { status: "answered" } });
    expect(submission).toEqual({
      conversationId: "web:thread/one",
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
  });

  it("includes effort in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5", effort: "high" },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      label: "test-agent",
      model: "claude-fable-5",
      effort: "high",
    });
  });

  it("includes the candidate models list in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      model: "claude-fable-5",
      models: ["claude-fable-5", "codex:gpt-5.5"],
    });
  });

  it("omits models from /v1/info when the list is empty or absent", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", models: [] },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("models" in info).toBe(false);
  });

  it("omits effort from /v1/info when not configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5" },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("effort" in info).toBe(false);
  });

  it("includes modelOptions in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
        model: "pi:ollama:qwen3.6",
        models: ["pi:ollama:qwen3.6", "pi:lmstudio:qwen3-8b"],
        modelOptions: {
          // A toggle-reasoning model (mode, no graded levels) and an effort model
          // (mode + levels) — both pass through /v1/info verbatim.
          "pi:ollama:qwen3.6": {
            reasoning: true,
            reasoningMode: "toggle",
            label: "qwen3.6",
            contextWindow: 131_072,
          },
          "pi:lmstudio:qwen3-8b": { effortLevels: ["low", "medium", "high"], reasoning: true, reasoningMode: "effort", label: "qwen3-8b" },
        },
      },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      model: "pi:ollama:qwen3.6",
      models: ["pi:ollama:qwen3.6", "pi:lmstudio:qwen3-8b"],
      modelOptions: {
        "pi:ollama:qwen3.6": {
          reasoning: true,
          reasoningMode: "toggle",
          label: "qwen3.6",
          contextWindow: 131_072,
        },
        "pi:lmstudio:qwen3-8b": { effortLevels: ["low", "medium", "high"], reasoning: true, reasoningMode: "effort", label: "qwen3-8b" },
      },
    });
  });

  it("omits modelOptions from /v1/info when absent or empty", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", modelOptions: {} },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("modelOptions" in info).toBe(false);
  });

  it("accepts an info PROVIDER function and resolves it fresh on every /v1/info request", async () => {
    let calls = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: () => {
        calls += 1;
        return { model: "claude-fable-5", models: [`model-${calls}`] };
      },
    });

    const first = (await (await fetch(running.infoUrl)).json()) as { models: string[] };
    const second = (await (await fetch(running.infoUrl)).json()) as { models: string[] };

    expect(first.models).toEqual(["model-1"]);
    expect(second.models).toEqual(["model-2"]);
  });

  it("reports a 500 (not a crash) when the info provider rejects", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: async () => {
        throw new Error("discovery exploded");
      },
    });

    const response = await fetch(running.infoUrl);

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("discovery exploded");
  });

  it("accepts an ASYNC info provider function (returning a promise)", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { model: "claude-fable-5", modelOptions: { "claude-fable-5": { reasoning: true } } };
      },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      model: "claude-fable-5",
      modelOptions: { "claude-fable-5": { reasoning: true } },
    });
  });

  it("streams the full callback sequence as NDJSON frames in order", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request, stream) => {
        expect(request.conversationId).toBe("tui:main");
        expect(request.metadata?.source).toBe("tui");
        await stream.status?.("Thinking…");
        await stream.event?.({ type: "assistant_thought", text: "let me look" });
        await stream.event?.({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });
        await stream.event?.({ type: "tool_call_progress", id: "t1", partialResult: "a.txt\n" });
        await stream.event?.({ type: "tool_call_completed", id: "t1", content: "a.txt\nb.txt", isError: false, executionMs: 12 });
        await stream.event?.({ type: "usage_update", cumulativeUsd: 0.02, tokens: { input: 5, output: 9, cacheRead: 0, cacheCreation: 0 } });
        await stream.append("Here");
        await stream.append(" you go.");
        return { text: "Here you go.", metadata: { runId: "r1" } };
      }),
    });

    const response = await postTurn(running.baseUrl, { conversationId: "tui:main", text: "list files" });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = await readFrames(response);

    expect(frames).toEqual([
      { kind: "status", text: "Thinking…" },
      { kind: "event", event: { type: "assistant_thought", text: "let me look" } },
      { kind: "event", event: { type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } } },
      { kind: "event", event: { type: "tool_call_progress", id: "t1", partialResult: "a.txt\n" } },
      { kind: "event", event: { type: "tool_call_completed", id: "t1", content: "a.txt\nb.txt", isError: false, executionMs: 12 } },
      { kind: "event", event: { type: "usage_update", cumulativeUsd: 0.02, tokens: { input: 5, output: 9, cacheRead: 0, cacheCreation: 0 } } },
      { kind: "append", delta: "Here" },
      { kind: "append", delta: " you go." },
      { kind: "finish", finalText: "Here you go.", metadata: { runId: "r1" } },
    ]);
  });

  it("accepts attachment-only web turns and preserves web metadata with a TUI override mirror", async () => {
    const requests: AgentRequestBase[] = [];
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        requests.push(request);
        return { text: "received" };
      }),
    });

    const data = Buffer.from("hello from the browser", "utf8").toString("base64");
    const frames = await readFrames(await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "web:thread-1",
      metadata: { web: { model: "claude:claude-opus-4-8", effort: "high" } },
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data,
        name: "note.txt",
        sizeBytes: 22,
      }],
    }));

    expect(frames).toEqual([{ kind: "finish", finalText: "received" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: "web:thread-1",
      text: "",
      metadata: {
        source: "web",
        web: { model: "claude:claude-opus-4-8", effort: "high" },
        tui: { model: "claude:claude-opus-4-8", effort: "high" },
        webRequestId: expect.any(String),
      },
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data,
        name: "note.txt",
        text: "hello from the browser",
        sizeBytes: 22,
      }],
    });
  });

  it("emits a terminal error frame with cancelled=true for a cancelled turn", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));

    expect(frames).toEqual([
      { kind: "error", message: "Agent response was cancelled.", cancelled: true },
    ]);
  });

  it("emits a terminal error frame for a failed turn", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => {
        throw new Error("model exploded");
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));

    expect(frames).toEqual([{ kind: "error", message: "model exploded", cancelled: false }]);
  });

  it("aborts the in-flight turn when the client socket closes mid-stream", async () => {
    let sawAbort: Promise<void> | undefined;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request, stream) => {
        await stream.append("started");
        sawAbort = new Promise((resolve) => {
          request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await sawAbort;
        throw new AgentResponseCancelledError();
      }),
    });

    const controller = new AbortController();
    const responsePromise = postTurn(running.baseUrl, { conversationId: "c", text: "hi" });
    const response = await responsePromise;
    const reader = response.body!.getReader();
    await reader.read(); // first chunk arrived — the turn is in flight
    controller.abort();
    await reader.cancel(); // tear down the client side of the socket

    // The server-side abort must fire (fail the test via timeout otherwise).
    await expect(
      Promise.race([
        sawAbort,
        new Promise((_, reject) => setTimeout(() => reject(new Error("abort never fired")), 4000)),
      ]),
    ).resolves.toBeUndefined();
  });

  it("aborts active turns and bounds repeated shutdown calls", async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        requestSignal = request.abortSignal;
        enteredResolve?.();
        return await new Promise<AgentResponse>(() => undefined);
      }),
    });

    const response = await postTurn(running.baseUrl, { conversationId: "c", text: "hi" });
    await entered;
    const startedAt = Date.now();
    const firstStop = running.stop();
    expect(running.stop()).toBe(firstStop);
    await firstStop;

    expect(requestSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await response.body?.cancel();
    running = undefined;
  });

  it("routes explicit cancel to responder.cancel and 501s when unsupported", async () => {
    const cancelled: Array<[string, unknown]> = [];
    running = await startTuiAdapter({
      responder: scriptedResponder(
        async () => ({ text: "ok" }),
        (conversationId, reason) => void cancelled.push([conversationId, reason]),
      ),
    });

    const accepted = await fetch(`${running.baseUrl}/v1/conversations/tui%3Amain/cancel`, { method: "POST" });
    expect(accepted.status).toBe(202);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.[0]).toBe("tui:main");
    expect(isChannelUserCancelReason(cancelled[0]?.[1])).toBe(true);

    await running.stop();
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const unsupported = await fetch(`${running.baseUrl}/v1/conversations/c/cancel`, { method: "POST" });
    expect(unsupported.status).toBe(501);
  });

  it("advertises and authorizes durable verbatim history append", async () => {
    const recorded: Array<[string, string, string | undefined]> = [];
    running = await startTuiAdapter({
      apiKey: "fixture-secret",
      responder: {
        ...scriptedResponder(async () => ({ text: "ok" })),
        async deliverVerbatim(conversationId, text, options) {
          recorded.push([conversationId, text, options?.idempotencyKey]);
        },
      },
    });

    const info = await (await fetch(running.infoUrl, {
      headers: { authorization: "Bearer fixture-secret" },
    })).json() as { capabilities: Record<string, boolean> };
    expect(info.capabilities).toEqual({ attachments: true, historyAppend: true });

    const url = `${running.baseUrl}/v1/conversations/web%3Anotification-1/verbatim`;
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Morning brief", idempotencyKey: "cron:job:one" }),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Morning brief", idempotencyKey: "cron:job:one" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ recorded: true, conversationId: "web:notification-1" });
    expect(recorded).toEqual([["web:notification-1", "Morning brief", "cron:job:one"]]);
  });

  it("advertises live input and holds the request until the active run settles it", async () => {
    let markOffered!: (request: AgentLiveInputRequest) => void;
    const offered = new Promise<AgentLiveInputRequest>((resolve) => { markOffered = resolve; });
    let settle!: (value: AgentLiveInputSettlement) => void;
    const settled = new Promise<AgentLiveInputSettlement>((resolve) => { settle = resolve; });
    running = await startTuiAdapter({
      responder: {
        ...scriptedResponder(async () => ({ text: "ok" })),
        offerLiveInput(request) {
          markOffered(request);
          return { status: "accepted", settled };
        },
      },
    });

    const info = await (await fetch(running.infoUrl)).json() as { capabilities: Record<string, boolean> };
    expect(info.capabilities).toEqual({ attachments: true, liveInput: true });
    const responsePromise = fetch(`${running.baseUrl}/v1/conversations/web%3Athread-1/live-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "input-1",
        text: "Use the latest requirements",
        receivedAt: "2026-07-21T09:00:00.000Z",
      }),
    });
    await expect(offered).resolves.toEqual({
      conversationId: "web:thread-1",
      id: "input-1",
      text: "Use the latest requirements",
      receivedAt: "2026-07-21T09:00:00.000Z",
    });
    settle({ status: "applied", runId: "run-1" });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "applied", runId: "run-1" });
  });

  it("reports unavailable live input for responders without an active mailbox", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const response = await fetch(`${running.baseUrl}/v1/conversations/web%3Athread-1/live-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "input-1",
        text: "Follow up",
        receivedAt: "2026-07-21T09:00:00.000Z",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "unsupported" });
  });

  it("validates verbatim history append and reports unsupported responders", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const url = `${running.baseUrl}/v1/conversations/web%3Aone/verbatim`;

    const invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", idempotencyKey: "delivery:one" }),
    });
    expect(invalid.status).toBe(400);

    const unsupported = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", idempotencyKey: "delivery:one" }),
    });
    expect(unsupported.status).toBe(501);
  });

  it("rejects malformed turn bodies with 400", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    expect((await postTurn(running.baseUrl, { text: "no conversation" })).status).toBe(400);
    expect((await postTurn(running.baseUrl, { conversationId: "c" })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "image", mimeType: "text/plain", data: "aGk=" }],
    })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "document", mimeType: "application/octet-stream", data: "aGk=" }],
    })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "document", mimeType: "text/plain", data: "not-base64" }],
    })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: Array.from({ length: 11 }, () => ({
        kind: "document",
        mimeType: "text/plain",
        data: "AA==",
      })),
    })).status).toBe(400);
  });

  it("enforces the decoded 20 MiB per-file limit", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const oversized = Buffer.alloc((20 * 1024 * 1024) + 1).toString("base64");

    const response = await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "document", mimeType: "text/plain", data: oversized }],
    });

    expect(response.status).toBe(400);
  }, 30_000);

  it("accepts 64 MiB of control-heavy text through the 96 MiB parser, derives text, and rejects one byte more", async () => {
    let responderCalls = 0;
    let derivedTextBytes = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        responderCalls += 1;
        derivedTextBytes = request.attachments?.reduce(
          (total, attachment) => total + Buffer.byteLength(attachment.text ?? "", "utf8"),
          0,
        ) ?? 0;
        return { text: "ok" };
      }),
    });
    const twentyMiB = Buffer.alloc(20 * 1024 * 1024).toString("base64");
    const fourMiB = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    const atLimit = [twentyMiB, twentyMiB, twentyMiB, fourMiB].map((data, index) => ({
      kind: "document",
      mimeType: "text/plain",
      data,
      name: `part-${String(index + 1)}.txt`,
    }));

    const accepted = await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "web:limit",
      attachments: atLimit,
    });
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(responderCalls).toBe(1);
    expect(derivedTextBytes).toBe(64 * 1024 * 1024);

    const rejected = await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "web:over-limit",
      attachments: [
        ...atLimit,
        { kind: "document", mimeType: "text/plain", data: "AA==", name: "one-more-byte.txt" },
      ],
    });
    expect(rejected.status).toBe(400);
    expect(responderCalls).toBe(1);
  }, 30_000);

  it("reports server-side handler failures as 500, not 400", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(
        async () => ({ text: "ok" }),
        () => {
          throw new Error("cancel backend exploded");
        },
      ),
    });

    const response = await fetch(`${running.baseUrl}/v1/conversations/c/cancel`, { method: "POST" });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("exploded");
  });

  it("keeps body-parse failures as 400", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    const response = await fetch(`${running.baseUrl}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });

  it("reports turn bodies over the parser ceiling as 413", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    const response = await fetch(`${running.baseUrl}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc((96 * 1024 * 1024) + 1, 0x20),
    });

    expect(response.status).toBe(413);
  }, 30_000);

  it("enforces the bearer key on every route when configured", async () => {
    running = await startTuiAdapter({
      apiKey: "fixture-secret",
      responder: scriptedResponder(async () => ({ text: "ok" })),
    });

    expect((await fetch(running.infoUrl)).status).toBe(401);
    expect((await postTurn(running.baseUrl, { conversationId: "c", text: "hi" })).status).toBe(401);
    expect(
      (await fetch(running.infoUrl, { headers: { authorization: "Bearer fixture-secret" } })).status,
    ).toBe(200);
  });

  it("refuses to bind a non-loopback host without allowNonLoopback", async () => {
    await expect(
      startTuiAdapter({ host: "0.0.0.0", responder: scriptedResponder(async () => ({ text: "ok" })) }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it("rechecks the resolved address, closes a rejected port, and permits an explicit non-loopback bind", async () => {
    const originalLookup = dns.lookup;
    let unexpectedServer: TuiAdapterStartResult | undefined;
    let rejected: unknown;
    dns.lookup = wildcardNonLoopbackLookup as typeof dns.lookup;
    try {
      try {
        unexpectedServer = await startTuiAdapter({
          host: "localhost",
          port: 0,
          responder: scriptedResponder(async () => ({ text: "ok" })),
        });
      } catch (error) {
        rejected = error;
      }
    } finally {
      dns.lookup = originalLookup;
    }

    if (unexpectedServer !== undefined) {
      await unexpectedServer.stop();
    }
    expect(unexpectedServer).toBeUndefined();
    expect(rejected).toMatchObject({
      code: "unsafe_host",
      details: {
        host: "localhost",
        boundAddress: "0.0.0.0",
        boundPort: expect.any(Number),
      },
    });

    const boundPort = rejectedBoundPort(rejected);
    running = await startTuiAdapter({
      host: "0.0.0.0",
      port: boundPort,
      allowNonLoopback: true,
      responder: scriptedResponder(async () => ({ text: "ok" })),
    });
    expect(running.port).toBe(boundPort);
  });

  it("truncates oversized event frames instead of streaming them verbatim", async () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1024);
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({ type: "tool_call_completed", id: "t1", content: huge });
        return { text: "done" };
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));
    const eventFrame = frames[0] as Extract<AgentStreamWireFrame, { kind: "event" }>;

    expect(eventFrame.kind).toBe("event");
    const event = eventFrame.event as { content: string; metadata?: Record<string, unknown> };
    expect(event.content.length).toBeLessThan(huge.length);
    expect(event.content.endsWith("… [truncated]")).toBe(true);
    expect(event.metadata?.truncated).toBe(true);
    expect(frames.at(-1)).toEqual({ kind: "finish", finalText: "done" });
  });

  it("rechecks the encoded byte cap after reducing multibyte event text", async () => {
    const huge = "é".repeat(MAX_FRAME_BYTES);
    const priorSinglePass = serializeAgentStreamFrame({
      kind: "event",
      event: {
        type: "assistant_thought",
        text: huge.slice(0, MAX_FRAME_BYTES / 2),
        metadata: { truncated: true },
      },
    });
    expect(Buffer.byteLength(priorSinglePass, "utf8")).toBe(262_238);

    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({ type: "assistant_thought", text: huge });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    const eventLine = lines[0];
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);

    const eventFrame = parseAgentStreamFrame(eventLine ?? "") as Extract<
      AgentStreamWireFrame,
      { kind: "event" }
    >;
    expect(eventFrame.kind).toBe("event");
    expect(eventFrame.event).toMatchObject({
      type: "assistant_thought",
      metadata: { truncated: true },
    });
    expect((eventFrame.event as { text: string }).text.length).toBeLessThan(MAX_FRAME_BYTES / 2);
    expect(lines.slice(1).map(parseAgentStreamFrame)).toEqual([
      { kind: "finish", finalText: "done" },
    ]);
  });

  it("uses a bounded marker when oversized metadata cannot be field-reduced", async () => {
    let metadataSerializations = 0;
    let eventFrameSerializations = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "assistant_thought",
          text: "bounded thought",
          metadata: {
            toJSON() {
              metadataSerializations += 1;
              return { oversized: "é".repeat(MAX_FRAME_BYTES) };
            },
          },
        });
        return { text: "done" };
      }),
    });

    const originalStringify = JSON.stringify;
    JSON.stringify = ((...args: unknown[]) => {
      const value = args[0];
      if (
        typeof value === "object"
        && value !== null
        && (value as { kind?: unknown }).kind === "event"
      ) {
        eventFrameSerializations += 1;
      }
      return Reflect.apply(originalStringify, JSON, args) as string | undefined;
    }) as typeof JSON.stringify;
    let responseText = "";
    try {
      responseText = await (await postTurn(
        running.baseUrl,
        { conversationId: "c", text: "hi" },
      )).text();
    } finally {
      JSON.stringify = originalStringify;
    }
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    const eventLine = lines[0];
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toEqual({
      kind: "event",
      event: {
        type: "runtime_telemetry",
        kind: "oversized_event",
        data: { originalType: "assistant_thought" },
        metadata: { truncated: true },
      },
    });
    expect(metadataSerializations).toBe(1);
    // Original oversized frame + one minimal probe + the bounded marker.
    expect(eventFrameSerializations).toBe(3);
  });

  it("replaces an oversized runtime warning with one bounded marker", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "runtime_warning",
          message: "warning".repeat(MAX_FRAME_BYTES),
        });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const eventLine = responseText.split("\n").find((line) => line.length > 0);
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toEqual({
      kind: "event",
      event: {
        type: "runtime_telemetry",
        kind: "oversized_event",
        data: { originalType: "runtime_warning" },
        metadata: { truncated: true },
      },
    });
  });

  it("serializes an oversized default-branch telemetry payload only once", async () => {
    let dataSerializations = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "runtime_telemetry",
          kind: "large_payload",
          data: {
            toJSON() {
              dataSerializations += 1;
              return { payload: "x".repeat(MAX_FRAME_BYTES) };
            },
          },
        });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const eventLine = responseText.split("\n").find((line) => line.length > 0);
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toEqual({
      kind: "event",
      event: {
        type: "runtime_telemetry",
        kind: "oversized_event",
        data: { originalType: "runtime_telemetry" },
        metadata: { truncated: true },
      },
    });
    expect(dataSerializations).toBe(1);
  });

  it("stabilizes a reducible tool payload before the bounded size search", async () => {
    let contentSerializations = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "tool_call_completed",
          id: "t1",
          content: {
            toJSON() {
              contentSerializations += 1;
              return { payload: "é".repeat(MAX_FRAME_BYTES) };
            },
          },
        });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const eventLine = responseText.split("\n").find((line) => line.length > 0);
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toMatchObject({
      kind: "event",
      event: {
        type: "tool_call_completed",
        id: "t1",
        metadata: { truncated: true },
      },
    });
    expect(contentSerializations).toBe(1);
  });
});

function wildcardNonLoopbackLookup(
  _hostname: string,
  options: unknown,
  callback?: unknown,
): void {
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") {
    throw new TypeError("dns.lookup callback is required");
  }
  const all = typeof options === "object"
    && options !== null
    && (options as { all?: unknown }).all === true;
  queueMicrotask(() => {
    if (all) {
      (done as (error: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: "0.0.0.0", family: 4 }],
      );
      return;
    }
    (done as (error: null, address: string, family: number) => void)(null, "0.0.0.0", 4);
  });
}

function rejectedBoundPort(error: unknown): number {
  const boundPort = (error as { details?: { boundPort?: unknown } } | undefined)?.details?.boundPort;
  if (typeof boundPort !== "number") {
    throw new TypeError("Expected an unsafe_host error with a numeric boundPort detail.");
  }
  return boundPort;
}

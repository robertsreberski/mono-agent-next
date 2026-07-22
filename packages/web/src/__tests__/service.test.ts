import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_ATTACHMENT_MAX_BYTES } from "@mono-agent/agent-contracts";

import { WebService, WeightedTurnBudget } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function createService(options: Partial<Parameters<typeof WebService.create>[0]> = {}): Promise<WebService> {
  const base = await temporaryRoot();
  cleanup.push(base);
  return WebService.create({
    stateDir: join(base, "state"),
    discoveryIntervalMs: 0,
    purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: operatorFetch(),
    ...options,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for service state.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

describe("WebService", () => {
  it("preserves operator context-window metadata through discovery, storage, and bootstrap", async () => {
    const service = await createService();

    expect((await service.bootstrap()).agents[0]?.modelOptions?.["provider/default"]?.contextWindow)
      .toBe(128_000);

    await service.stop();
  });

  it("records notification history before publishing a marked idempotent thread", async () => {
    let failHistory = true;
    const recorded: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsHistoryAppend: true,
        async onVerbatim(conversationId, body) {
          recorded.push({ conversationId, body });
          if (failHistory) throw new Error("history unavailable");
        },
      }),
    });
    const input = {
      sourceId: "agent-one",
      triggerKind: "webhook" as const,
      deliveryKey: "webhook:digest:req-1:success",
      text: "Webhook digest",
    };

    await expect(service.deliverNotification(input)).rejects.toBeDefined();
    expect((await service.bootstrap()).threads).toEqual([]);

    failHistory = false;
    const delivered = await service.deliverNotification(input);
    expect(delivered).toMatchObject({
      duplicate: false,
      thread: { title: "Webhook notification", trigger: { kind: "webhook" } },
    });
    expect(recorded.at(-1)).toEqual({
      conversationId: `web:${delivered.thread.id}`,
      body: { text: "Webhook digest", idempotencyKey: input.deliveryKey },
    });
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: true,
      thread: { id: delivered.thread.id },
    });
    expect(recorded).toHaveLength(2);
    await expect(service.deliverNotification({ ...input, text: "Changed digest" }))
      .rejects.toMatchObject({ code: "notification_idempotency_conflict" });
    await service.stop();
  });

  it("publishes persisted pin changes through bootstrap and agent invalidation events", async () => {
    const service = await createService();
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "agents.changed") events.push(event.payload);
    });

    expect(service.patchAgent("agent-one", { pinned: true })).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect((await service.bootstrap()).agents[0]).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect(events).toEqual([
      { agents: [expect.objectContaining({ sourceId: "agent-one", pinned: true })] },
    ]);
    await service.refreshAgents();
    expect((await service.bootstrap()).agents[0]).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect(() => service.patchAgent("missing", { pinned: true })).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    unsubscribe();
    await service.stop();
  });

  it("keeps a losing second service from mutating live turns", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const first = await WebService.create({
      stateDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [],
    });
    first.store.replaceAgents([{
      sourceId: "agent-one", label: "Agent", status: "online", supportsAttachments: true,
      updatedAt: new Date().toISOString(),
    }]);
    const thread = first.store.createThread("agent-one");
    first.store.beginTurn({ threadId: thread.id, text: "still running", attachmentIds: [] });

    const startedAt = Date.now();
    await expect(WebService.create({ stateDir, discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [] }))
      .rejects.toMatchObject({ code: "web_service_running" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(first.store.getThread(thread.id)?.runState.status).toBe("running");
    await first.stop();
  });

  it("coalesces a long stream, preserves interleaved part order/names, and reconciles finish metadata", async () => {
    const lines = [
      JSON.stringify({ kind: "append", delta: "a" }),
      JSON.stringify({ kind: "event", event: { type: "assistant_thought", text: "why" } }),
      JSON.stringify({ kind: "event", event: { type: "tool_call_started", id: "t", name: "Search", arguments: { q: 1 } } }),
      JSON.stringify({ kind: "event", event: { type: "tool_call_progress", id: "t", partialResult: "half" } }),
      JSON.stringify({ kind: "event", event: { type: "tool_call_completed", id: "t", content: "done" } }),
      ...Array.from({ length: 1_000 }, () => JSON.stringify({ kind: "append", delta: "x" })),
      JSON.stringify({ kind: "append", delta: "b" }),
      JSON.stringify({ kind: "finish", finalText: `a${"x".repeat(1_000)}b`, metadata: { runtime: { model: "actual/model", effort: "high" } } }),
      "",
    ];
    const service = await createService({ fetchImpl: operatorFetch({ turns: () => lines.join("\n") }) });
    const thread = service.createThread("agent-one");
    let messageInvalidations = 0;
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "message.changed") {
        messageInvalidations += 1;
        expect(event.payload).not.toHaveProperty("message");
      }
    });
    await service.startTurn(thread.id, { text: "prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");

    const detail = service.thread(thread.id);
    expect(messageInvalidations).toBeLessThanOrEqual(2);
    expect(detail.thread.runState).toMatchObject({ model: "actual/model", effort: "high" });
    expect(detail.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "a" },
      { type: "reasoning", text: "why" },
      { type: "tool-call", toolCallId: "t", toolName: "Search", args: { q: 1 }, result: "done", status: "complete" },
      { type: "text", text: `${"x".repeat(1_000)}b` },
    ]);
    unsubscribe();
    await service.stop();
  });

  it("preserves streamed text when the finish frame carries an empty finalText", async () => {
    const service = await createService({
      fetchImpl: operatorFetch({ turns: () => [
        JSON.stringify({ kind: "append", delta: "keep me" }),
        JSON.stringify({ kind: "finish", finalText: "" }),
        "",
      ].join("\n") }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.thread(thread.id).messages.at(-1)?.parts).toEqual([{ type: "text", text: "keep me" }]);
    await service.stop();
  });

  it("delivers a live follow-up into the active operator run and publishes applied state", async () => {
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const delivered: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "status", text: "working" })}\n`));
          },
        }),
        onLiveInput(conversationId, body) {
          delivered.push({ conversationId, body });
          return { status: "applied", runId: "run-live" };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial task" });

    const receipt = service.submitLiveInput(thread.id, "Also check the edge case");
    expect(receipt).toMatchObject({ disposition: "pending", message: { liveInputStatus: "pending" } });
    await waitFor(() => service.thread(thread.id).messages.some(
      (message) => message.id === receipt.message.id && message.liveInputStatus === "applied",
    ));
    expect(delivered).toEqual([{
      conversationId: `web:${thread.id}`,
      body: {
        id: expect.any(String),
        text: "Also check the edge case",
        receivedAt: expect.any(String),
      },
    }]);

    stream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    stream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    await service.stop();
  });

  it("queues a follow-up as the next turn when the active operator lacks live input", async () => {
    const encoder = new TextEncoder();
    let firstStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const turnBodies: Record<string, unknown>[] = [];
    let turnCount = 0;
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: false,
        onTurn(body) { turnBodies.push(body); },
        turns: () => {
          turnCount += 1;
          if (turnCount === 1) {
            return new ReadableStream<Uint8Array>({
              start(controller) { firstStream = controller; },
            });
          }
          return `${JSON.stringify({ kind: "finish", finalText: "Follow-up done" })}\n`;
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial task" });
    const receipt = service.submitLiveInput(thread.id, "Run this immediately after");
    expect(receipt).toMatchObject({ disposition: "queued", message: { liveInputStatus: "queued" } });

    await waitFor(() => firstStream !== undefined);
    firstStream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Initial done" })}\n`));
    firstStream?.close();
    await waitFor(() => turnBodies.length === 2);
    await waitFor(() => service.thread(thread.id).messages.filter((message) => message.role === "assistant").length === 2
      && service.store.getThread(thread.id)?.runState.status === "complete");
    expect(turnBodies.map((body) => body.text)).toEqual(["Initial task", "Run this immediately after"]);
    expect(service.thread(thread.id).messages.find((message) => message.id === receipt.message.id))
      .toMatchObject({ role: "user", parts: [{ type: "text", text: "Run this immediately after" }] });
    await service.stop();
  });

  it("sends a formatted blockquote upstream while preserving the authored message and quote", async () => {
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({ onTurn(body) { turnBodies.push(body); } }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Source prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const sourceMessage = service.thread(thread.id).messages.at(-1)!;

    await service.startTurn(thread.id, {
      text: "Please expand.",
      quote: { text: "First line\nSecond line", messageId: sourceMessage.id },
    });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");

    expect(turnBodies.at(-1)?.text).toBe(
      "Quoted context:\n> First line\n> Second line\n\nPlease expand.",
    );
    expect(service.thread(thread.id).messages.at(-2)).toMatchObject({
      quote: { text: "First line\nSecond line", messageId: sourceMessage.id },
      parts: [{ type: "text", text: "Please expand." }],
    });
    await expect(service.startTurn(thread.id, {
      text: "x".repeat(199_990),
      quote: { text: "First line", messageId: sourceMessage.id },
    })).rejects.toMatchObject({ code: "turn_text_too_large", status: 413 });
    expect(turnBodies).toHaveLength(2);
    await service.stop();
  });

  it("persists an internal stream-storage failure as failed rather than cancelled", async () => {
    const service = await createService();
    const thread = service.createThread("agent-one");
    vi.spyOn(service.store, "applyStreamFrames").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    await service.startTurn(thread.id, { text: "prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status !== "running");
    expect(service.store.getThread(thread.id)?.runState).toMatchObject({
      status: "failed",
      error: { message: "disk unavailable" },
    });
    expect(service.thread(thread.id).messages.at(-1)?.status).toBe("failed");
    await service.stop();
  });

  it("supports attachment-only turns without duplicating decoded text on the wire", async () => {
    let turnBody: Record<string, unknown> | undefined;
    const service = await createService({ fetchImpl: operatorFetch({ onTurn(body) { turnBody = body; } }) });
    const thread = service.createThread("agent-one");
    const attachment = service.createUpload({ name: "notes.txt", contentType: "text/plain", sizeBytes: 5 });
    const stored = service.storedAttachment(attachment.id);
    await writeFile(service.store.attachmentPath(stored), "hello", { mode: 0o600 });
    service.completeUpload(attachment.id, 5);

    await service.startTurn(thread.id, { text: "", attachmentIds: [attachment.id] });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(turnBody).toMatchObject({ client: "web", text: "" });
    expect(turnBody?.attachments).toEqual([{
      kind: "document", mimeType: "text/plain", data: "aGVsbG8=", name: "notes.txt", sizeBytes: 5,
    }]);
    expect(service.thread(thread.id).messages[0]?.attachments[0]?.contentUrl).toBe(`/api/v1/uploads/${attachment.id}/content`);
    await service.stop();
  });

  it("cancels an active upstream turn and persists the cancelled state", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return operatorFetch()(input, init);
      if (url.endsWith("/cancel")) return Response.json({ cancelled: true }, { status: 202 });
      if (url.endsWith("/v1/turns")) {
        if (init?.signal?.aborted === true) throw init.signal.reason;
        return new Promise<Response>((_resolvePromise, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "wait" });
    await service.cancelTurn(thread.id);
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "cancelled");
    expect(service.thread(thread.id).messages.at(-1)?.status).toBe("cancelled");
    await service.stop();
  });

  it("keeps thread selection read-only and validates advertised model/effort semantics", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "cloud",
        models: ["cloud", "toggle", "graded", "none"],
        modelOptions: {
          cloud: { reasoning: true },
          toggle: { reasoning: true, reasoningMode: "toggle" },
          graded: { reasoning: true, reasoningMode: "effort", effortLevels: ["low", "high"] },
          none: { reasoning: false, reasoningMode: "none" },
        },
        capabilities: { attachments: true },
      });
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const one = service.createThread("agent-one");
    const two = service.createThread("agent-one");
    service.thread(one.id);
    expect((await service.bootstrap()).currentThreadId).toBe(two.id);

    const cloud = service.createThread("agent-one");
    await expect(service.startTurn(cloud.id, { text: "cloud", model: "cloud", effort: "ultra" })).resolves.toBeDefined();
    const toggle = service.createThread("agent-one");
    await expect(service.startTurn(toggle.id, { text: "toggle", model: "toggle", effort: "minimal" })).rejects.toMatchObject({ code: "invalid_effort" });
    await expect(service.startTurn(toggle.id, { text: "toggle", model: "toggle", effort: "high" })).resolves.toBeDefined();
    const graded = service.createThread("agent-one");
    await expect(service.startTurn(graded.id, { text: "graded", model: "graded", effort: "high" })).resolves.toBeDefined();
    const none = service.createThread("agent-one");
    await expect(service.startTurn(none.id, { text: "none", model: "none", effort: "high" })).rejects.toMatchObject({ code: "invalid_effort" });
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("accounts for all active worst-case upload reservations in the staged quota", async () => {
    const service = await createService();
    const reservations = Array.from({ length: 4 }, (_, index) => {
      const attachment = service.createUpload({ name: `unknown-${index}.txt`, contentType: "text/plain" });
      return service.reserveUpload(attachment.id);
    });
    for (let index = 0; index < 8; index += 1) {
      expect(service.createUpload({ name: `full-${index}.txt`, contentType: "text/plain", sizeBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES })).toBeDefined();
    }
    expect(() => service.createUpload({ name: "over.txt", contentType: "text/plain", sizeBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES }))
      .toThrowError(/quota/u);
    for (const reservation of reservations) reservation.release();
    await service.stop();
  });

  it("waits for an in-flight discovery refresh before closing SQLite", async () => {
    let calls = 0;
    let releaseRefresh: (() => void) | undefined;
    const service = await createService({
      discoverImpl: async () => {
        calls += 1;
        if (calls === 1) return [fakeDiscoveredAgent()];
        await new Promise<void>((resolvePromise) => { releaseRefresh = resolvePromise; });
        return [];
      },
    });
    const refresh = service.refreshAgents();
    await waitFor(() => releaseRefresh !== undefined);
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(stopped).toBe(false);
    releaseRefresh?.();
    await Promise.all([refresh, stopping]);
  });

  it("surfaces reachable stale agents as degraded and missing endpoints as offline", async () => {
    const stale = fakeDiscoveredAgent({
      source: { ...fakeDiscoveredAgent().source, sourceId: "stale", label: "Stale", health: "stale" },
    });
    const offline = {
      source: { ...fakeDiscoveredAgent().source, sourceId: "offline", label: "Offline" },
    };
    const service = await createService({ discoverImpl: async () => [stale, offline] });
    expect((await service.bootstrap()).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "stale", status: "degraded" }),
      expect.objectContaining({ sourceId: "offline", status: "offline" }),
    ]));
    await service.stop();
  });

  it("uses the canonical TUI effort ladder for older agents while keeping model selection exact", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({ schema: 1, model: "legacy/model", effort: "medium" });
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const compatible = service.createThread("agent-one");
    expect(service.store.getAgent("agent-one")?.efforts).toContain("xhigh");
    await expect(service.startTurn(compatible.id, { text: "legacy", model: "legacy/model", effort: "xhigh" })).resolves.toBeDefined();
    const invalid = service.createThread("agent-one");
    await expect(service.startTurn(invalid.id, { text: "legacy", model: "other/model" })).rejects.toMatchObject({ code: "invalid_model" });
    await expect(service.startTurn(invalid.id, { text: "legacy", effort: "impossible" })).rejects.toMatchObject({ code: "invalid_effort" });
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });
});

describe("WeightedTurnBudget", () => {
  it("queues weighted attachment turns while allowing text turns through", async () => {
    const budget = new WeightedTurnBudget(10, 1);
    const releaseFirst = await budget.acquire(10, new AbortController().signal);
    let secondGranted = false;
    const second = budget.acquire(1, new AbortController().signal).then((release) => {
      secondGranted = true;
      return release;
    });
    await expect(budget.acquire(1, new AbortController().signal)).rejects.toMatchObject({ code: "attachment_turn_queue_full" });
    await expect(budget.acquire(0, new AbortController().signal)).resolves.toBeTypeOf("function");
    expect(secondGranted).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondGranted).toBe(true);
    releaseSecond();
  });
});

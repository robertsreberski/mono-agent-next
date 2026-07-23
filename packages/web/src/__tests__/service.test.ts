import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebAgent } from "../contracts.js";
import { WebService, type WebOperatorGateway } from "../service.js";
import { DurableWebStore } from "../store.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

afterEach(cleanup);

describe("web service lifecycle", () => {
  it("durably imports proactive conversations once and retains deletion tombstones", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const proactive = {
      agentId: "personal",
      conversationId: "proactive:notice-1",
      title: "Scheduled update",
      updatedAt: new Date().toISOString(),
      messages: [{ id: "agent-message-1", role: "assistant" as const, text: "Backup completed." }],
    };
    const firstStore = await DurableWebStore.open(stateDirectory);
    const first = new WebService(firstStore, gateway({
      async discoverProactiveConversations() { return [proactive]; },
    }));

    const initial = await first.bootstrap();
    expect(initial.newProactiveThreadIds).toHaveLength(1);
    expect(initial.threads).toMatchObject([{
      proactive: true,
      operatorConversationId: "proactive:notice-1",
    }]);
    expect(first.thread(initial.newProactiveThreadIds[0]!)).toMatchObject({
      messages: [{ operatorMessageId: "agent-message-1", text: "Backup completed." }],
    });
    expect((await first.bootstrap()).newProactiveThreadIds).toEqual([]);

    await first.patchThread(initial.newProactiveThreadIds[0]!, { archived: true });
    await first.deleteThread(initial.newProactiveThreadIds[0]!);
    expect((await first.bootstrap()).threads).toEqual([]);
    await first.stop();

    const reopenedStore = await DurableWebStore.open(stateDirectory);
    const reopened = new WebService(reopenedStore, gateway({
      async discoverProactiveConversations() { return [proactive]; },
    }));
    expect(await reopened.bootstrap()).toMatchObject({ threads: [], newProactiveThreadIds: [] });
    await reopened.stop();
  });

  it("persists AskUser state and routes answers and live input to the exact active conversation", async () => {
    const root = await temporaryDirectory();
    const store = await DurableWebStore.open(join(root, "state"));
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readyGate = new Promise<void>((resolve) => { ready = resolve; });
    const answerAsk = vi.fn<NonNullable<WebOperatorGateway["answerAsk"]>>(async () => ({ status: "accepted" }));
    const offerLiveInput = vi.fn<NonNullable<WebOperatorGateway["offerLiveInput"]>>(async () => ({ status: "applied" }));
    const service = new WebService(store, gateway({
      answerAsk,
      offerLiveInput,
      async runTurn(input) {
        await input.onState?.({
          conversationId: input.conversationId,
          status: "awaiting_user",
          activeTurnId: "operator-turn",
          assistantText: "Need a choice.",
          thoughtText: "",
          activities: [],
          pendingAsk: {
            interactionId: "ask-1",
            requestedAt: new Date().toISOString(),
            questions: [{
              id: "choice",
              prompt: "Continue?",
              allowFreeText: false,
              multiple: false,
              choices: [{ value: "yes", label: "Yes" }],
            }],
          },
        });
        ready();
        await gate;
      },
    }));
    const thread = await service.createThread("personal");
    const running = service.runTurn(thread.id, { text: "start" }, async () => undefined);
    await readyGate;

    expect(service.thread(thread.id).thread.pendingAsk).toMatchObject({ interactionId: "ask-1" });
    await expect(service.offerLiveInput(thread.id, "More context")).resolves.toEqual({ status: "applied" });
    await expect(service.answerAsk(thread.id, {
      interactionId: "ask-1",
      answers: { choice: ["yes"] },
    })).resolves.toEqual({ status: "accepted" });
    expect(service.thread(thread.id).thread.pendingAsk).toBeUndefined();
    expect(offerLiveInput).toHaveBeenCalledWith("personal", `web:${thread.id}`, "More context");
    expect(answerAsk).toHaveBeenCalledWith("personal", `web:${thread.id}`, {
      interactionId: "ask-1",
      answers: { choice: ["yes"] },
    });

    release();
    await expect(running).resolves.toMatchObject({ thread: { status: "complete" } });
    await service.stop();
  });

  it("preserves full assistant text while persisting usage and sticky runtime events across restart", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const store = await DurableWebStore.open(stateDirectory);
    const service = new WebService(store, gateway({
      async runTurn(input) {
        await input.onState?.({
          conversationId: input.conversationId,
          status: "streaming",
          activeTurnId: "operator-turn",
          assistantText: "First <literal> line",
          thoughtText: "",
          activities: [],
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            contextWindow: 200_000,
            contextUsed: 120,
            compacted: true,
            sessionEvicted: false,
          },
        });
        await input.onState?.({
          conversationId: input.conversationId,
          status: "completed",
          assistantText: "First <literal> line\nSecond & final line",
          thoughtText: "",
          activities: [],
          usage: {
            inputTokens: 110,
            outputTokens: 30,
            contextWindow: 200_000,
            contextUsed: 140,
            compacted: false,
            sessionEvicted: true,
          },
          finalMessage: {
            id: "operator-final",
            role: "assistant",
            text: "First <literal> line\nSecond & final line",
          },
        });
      },
    }));
    const thread = await service.createThread("personal");
    await expect(service.runTurn(thread.id, { text: "measure" }, async () => undefined)).resolves.toMatchObject({
      messages: [
        { role: "user", text: "measure" },
        {
          role: "assistant",
          operatorMessageId: "operator-final",
          text: "First <literal> line\nSecond & final line",
          telemetry: {
            inputTokens: 110,
            outputTokens: 30,
            contextWindow: 200_000,
            contextUsed: 140,
            compacted: true,
            sessionEvicted: true,
          },
        },
      ],
    });
    await service.stop();

    const reopened = await DurableWebStore.open(stateDirectory);
    expect(reopened.getThreadDetail(thread.id)?.messages[1]).toMatchObject({
      text: "First <literal> line\nSecond & final line",
      telemetry: { compacted: true, sessionEvicted: true },
    });
    await reopened.close();
  });

  it("persists bounded structured activity without ever persisting transient thought text", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const store = await DurableWebStore.open(stateDirectory);
    const service = new WebService(store, gateway({
      async runTurn(input) {
        await input.onState?.({
          conversationId: input.conversationId,
          status: "streaming",
          activeTurnId: "operator-turn",
          assistantText: "Visible answer",
          thoughtText: "PRIVATE TRANSIENT REASONING",
          activities: [
            {
              type: "tool_call",
              call: {
                id: "call-1",
                name: "CalendarLookup",
                input: { range: "today" },
                inputOmitted: false,
              },
            },
            {
              type: "tool_result",
              result: {
                callId: "call-1",
                content: [{ type: "text", text: "No events" }],
                contentOmitted: false,
              },
            },
            {
              type: "compaction",
              compaction: { compacted: true, tokensBefore: 9_000, tokensAfter: 3_000 },
            },
          ],
        });
      },
    }));
    const thread = await service.createThread("personal");
    await expect(service.runTurn(thread.id, { text: "What is next?" }, async () => undefined)).resolves.toMatchObject({
      messages: [
        { role: "user" },
        {
          role: "assistant",
          text: "Visible answer",
          activities: [
            { type: "tool_call", call: { name: "CalendarLookup" } },
            { type: "tool_result", result: { content: [{ text: "No events" }] } },
            { type: "compaction", compaction: { compacted: true } },
          ],
        },
      ],
    });
    await service.stop();
    const stored = await readFile(join(stateDirectory, "state.json"), "utf8");
    expect(stored).toContain("CalendarLookup");
    expect(stored).not.toContain("PRIVATE TRANSIENT REASONING");
    expect(stored).not.toContain("thoughtText");
  });

  it("registers a durable turn before a blocked first renderer update so cancel cannot miss it", async () => {
    const root = await temporaryDirectory();
    const store = await DurableWebStore.open(join(root, "state"));
    let releaseUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const startedGate = new Promise<void>((resolve) => { updateStarted = resolve; });
    let releaseSettlement!: () => void;
    let settlementStarted!: () => void;
    const settlementGate = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    const settlementStartedGate = new Promise<void>((resolve) => { settlementStarted = resolve; });
    const finishTurn = store.finishTurn.bind(store);
    vi.spyOn(store, "finishTurn").mockImplementation(async (...args) => {
      settlementStarted();
      await settlementGate;
      return await finishTurn(...args);
    });
    const runTurn = vi.fn<WebOperatorGateway["runTurn"]>();
    const service = new WebService(store, gateway({ runTurn }), { shutdownTimeoutMs: 10 });
    const thread = await service.createThread("personal");

    const running = service.runTurn(thread.id, { text: "blocked update" }, async () => {
      updateStarted();
      await updateGate;
    });
    await startedGate;
    const cancelling = service.cancel(thread.id);
    releaseUpdate();
    await settlementStartedGate;
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseSettlement();

    await expect(cancelling).resolves.toMatchObject({ thread: { status: "cancelled" } });
    await expect(running).resolves.toMatchObject({ thread: { status: "cancelled" } });
    expect(runTurn).not.toHaveBeenCalled();
    await service.stop();
  });

  it("emits revision-ordered invalidations and resets cursors outside its replay window", async () => {
    const root = await temporaryDirectory();
    const store = await DurableWebStore.open(join(root, "state"));
    const service = new WebService(store, gateway(), { eventReplayLimit: 1 });
    const live: Array<{ readonly type: string; readonly revision: number }> = [];
    const close = service.openEventStream(undefined, (event) => {
      live.push(event);
    });
    expect(live.map(({ type, revision }) => ({ type, revision }))).toEqual([
      { type: "ready", revision: 0 },
    ]);

    const thread = await service.createThread("personal");
    await service.patchThread(thread.id, { title: "Manual title" });
    close();
    expect(live.slice(1).map(({ type, revision }) => ({ type, revision }))).toEqual([
      { type: "threads.changed", revision: 1 },
      { type: "thread.changed", revision: 2 },
    ]);

    const reset: Array<{ readonly type: string; readonly revision: number }> = [];
    service.openEventStream(0, (event) => { reset.push(event); })();
    expect(reset.map(({ type, revision }) => ({ type, revision }))).toEqual([
      { type: "reset", revision: 2 },
    ]);
    const future: Array<{ readonly type: string; readonly revision: number }> = [];
    service.openEventStream(99, (event) => { future.push(event); })();
    expect(future.map(({ type, revision }) => ({ type, revision }))).toEqual([
      { type: "reset", revision: 2 },
    ]);
    await service.stop();
  });

  it("bounds shutdown, durably interrupts an abort-ignoring gateway, and releases the lease", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const store = await DurableWebStore.open(stateDirectory);
    let gatewayStarted!: () => void;
    const gatewayStartedGate = new Promise<void>((resolve) => { gatewayStarted = resolve; });
    const never = new Promise<void>(() => undefined);
    const service = new WebService(store, gateway({
      async runTurn() {
        gatewayStarted();
        await never;
      },
      async cancel() { await never; },
    }), { shutdownTimeoutMs: 25 });
    const thread = await service.createThread("personal");
    const running = service.runTurn(thread.id, { text: "ignore shutdown" }, async () => undefined);
    await gatewayStartedGate;

    const startedAt = Date.now();
    await service.stop();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(running).resolves.toMatchObject({ thread: { status: "interrupted" } });

    const reopened = await DurableWebStore.open(stateDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({ thread: { status: "interrupted" } });
    await reopened.close();
  });
});

function gateway(overrides: Partial<WebOperatorGateway> = {}): WebOperatorGateway {
  return {
    async listAgents() { return [agent()]; },
    async runTurn(input) { await input.onText("done"); },
    async cancel() {},
    ...overrides,
  };
}

function agent(): WebAgent {
  return {
    id: "personal",
    label: "Personal Agent",
    endpoint: "http://127.0.0.1:1",
    online: true,
    pinned: false,
    capabilities: {},
  };
}

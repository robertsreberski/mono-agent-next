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

  it("registers a durable turn before a blocked first renderer update so cancel cannot miss it", async () => {
    const root = await temporaryDirectory();
    const store = await DurableWebStore.open(join(root, "state"));
    let releaseUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const startedGate = new Promise<void>((resolve) => { updateStarted = resolve; });
    const runTurn = vi.fn<WebOperatorGateway["runTurn"]>();
    const service = new WebService(store, gateway({ runTurn }), { shutdownTimeoutMs: 100 });
    const thread = await service.createThread("personal");

    const running = service.runTurn(thread.id, { text: "blocked update" }, async () => {
      updateStarted();
      await updateGate;
    });
    await startedGate;
    const cancelling = service.cancel(thread.id);
    releaseUpdate();

    await expect(cancelling).resolves.toMatchObject({ thread: { status: "cancelled" } });
    await expect(running).resolves.toMatchObject({ thread: { status: "cancelled" } });
    expect(runTurn).not.toHaveBeenCalled();
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
    capabilities: {},
  };
}

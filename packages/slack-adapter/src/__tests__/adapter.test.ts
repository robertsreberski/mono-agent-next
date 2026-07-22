import { describe, expect, it, vi } from "vitest";

import {
  AgentResponseCancelledError,
  isChannelUserCancelReason,
  type AgentLiveInputRequest,
  type AgentLiveInputSettlement,
  type ChannelAskSnapshot,
} from "@mono-agent/agent-contracts";

import {
  SerialQueue,
  SerialQueueFullError,
  type AgentRequest,
  type AgentResponder,
} from "../adapter.js";
import {
  SlackAdapter,
  type SlackNotifyOptions,
  type SlackRuntimeControls,
} from "../index.js";
import { SlackApiError } from "../slack-client.js";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatDeleteParams,
  SlackChatUpdateParams,
  SlackDownloadFileParams,
  SlackReactionsAddParams,
  SlackRequestOptions,
  SlackEventCallback,
  SlackViewsPublishParams,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  readonly deleteCalls: SlackChatDeleteParams[] = [];
  readonly reactionsAddCalls: SlackReactionsAddParams[] = [];
  readonly viewsPublishCalls: SlackViewsPublishParams[] = [];
  readonly setAssistantStatusCalls: Array<{ channelId: string; threadTs: string; status: string }> = [];
  /**
   * When true, setAssistantStatus rejects (simulating a regular channel/DM that is
   * NOT a Slack AI-assistant thread). Defaults true since most threads are not
   * assistant threads → the adapter falls back to the 👀 reaction. Assistant-thread
   * tests set this false.
   */
  failSetAssistantStatus = true;
  /** When set, chatPostMessage throws for any message whose text includes this — used to simulate an ack failure. */
  failPostMessageWhenTextIncludes: string | undefined = undefined;
  /** Fail every post after this many successful calls. */
  failPostMessageAfter: number | undefined = undefined;
  postFailure: unknown = undefined;
  updateFailure: unknown = undefined;
  nextTs = 200;

  async authTest() {
    return { ok: true as const };
  }

  async setAssistantStatus(params: { channelId: string; threadTs: string; status: string }): Promise<void> {
    this.setAssistantStatusCalls.push(params);
    if (this.failSetAssistantStatus) {
      throw new Error("not_in_assistant_thread");
    }
  }

  async appsConnectionsOpen() {
    return { ok: true as const, url: "wss://slack.test/socket" };
  }

  async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
    this.postMessageCalls.push(params);
    if (this.failPostMessageAfter !== undefined && this.postMessageCalls.length > this.failPostMessageAfter) {
      throw this.postFailure ?? new Error("post_failed_after_partial_delivery");
    }
    if (
      this.failPostMessageWhenTextIncludes !== undefined &&
      params.text.includes(this.failPostMessageWhenTextIncludes)
    ) {
      throw new Error("post_failed");
    }
    return { ok: true, channel: params.channel, ts: `${this.nextTs++}.000001` };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    this.updateCalls.push(params);
    if (this.updateFailure !== undefined) throw this.updateFailure;
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }

  async chatDelete(params: SlackChatDeleteParams) {
    this.deleteCalls.push(params);
    return { ok: true as const, channel: params.channel, ts: params.ts };
  }

  async reactionsAdd(params: SlackReactionsAddParams): Promise<void> {
    this.reactionsAddCalls.push(params);
  }

  async viewsPublish(params: SlackViewsPublishParams): Promise<void> {
    this.viewsPublishCalls.push(params);
  }

  async downloadFile(
    _params: SlackDownloadFileParams,
    _options?: SlackRequestOptions,
  ): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

const RUNTIME_CONTROLS: SlackRuntimeControls = {
  defaultModel: "pi:openai:gpt-default",
  defaultEffort: "medium",
  models: [
    {
      value: "pi:openai:gpt-default",
      label: "Default GPT",
      efforts: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
    {
      value: "pi:anthropic:claude-fallback",
      label: "Claude fallback",
      efforts: [{ value: "high", label: "High" }],
    },
    {
      value: "opencode:provider-owned",
      label: "OpenCode",
      efforts: [],
    },
  ],
};

describe("SlackAdapter", () => {
  it("exports the public silent notify options contract", () => {
    const options: readonly SlackNotifyOptions[] = [
      {},
      { silent: false },
      { silent: true },
    ];

    expect(options.map((entry) => entry.silent)).toEqual([undefined, false, true]);
  });

  it("fails closed unless channels are explicitly allowed", () => {
    expect(
      () =>
        new SlackAdapter({
          api: new FakeSlackApi(),
          responder: responderFrom(async () => ({ text: "ok" })),
        }),
    ).toThrow(/allowedChannelIds/);
  });

  it("renders AskUser as Block Kit buttons and submits a native selection", async () => {
    const api = new FakeSlackApi();
    const snapshot = askSnapshot();
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });

    await adapter.presentAsk("D123", "171.000001", snapshot);

    expect(api.postMessageCalls[0]).toMatchObject({
      channel: "D123",
      thread_ts: "171.000001",
      text: "*Draft reply*",
    });
    const controls = api.postMessageCalls[1]?.blocks as Array<{
      type?: string;
      block_id?: string;
      elements?: Array<{ action_id?: string; text?: { text?: string }; value?: string }>;
    }>;
    const actionBlock = controls.find((block) => block.type === "actions");
    const buttons = actionBlock?.elements ?? [];
    expect(buttons.map((button) => button.action_id)).toEqual([
      "mono_agent_ask_user_option_0",
      "mono_agent_ask_user_option_1",
      "mono_agent_ask_user_option_2",
      "mono_agent_ask_user_other",
    ]);
    expect(new Set(buttons.map((button) => button.action_id)).size).toBe(buttons.length);
    expect(actionBlock).not.toHaveProperty("block_id");
    const send = buttons
      .find((element) => element.text?.text === "Send");
    expect(send?.action_id).toBe("mono_agent_ask_user_option_0");

    await expect(adapter.handleInteraction({
      type: "block_actions",
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{ action_id: "mono_agent_ask_user_other", value: send!.value! }],
    })).resolves.toEqual({ kind: "ignored", reason: "unbound", id: snapshot.interactionId });
    expect(submitAskAnswers).not.toHaveBeenCalled();

    await expect(adapter.handleInteraction({
      type: "block_actions",
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{ action_id: send!.action_id!, value: send!.value! }],
    })).resolves.toMatchObject({ kind: "ask", outcome: "answered" });
    expect(submitAskAnswers).toHaveBeenCalledWith({
      conversationId: "slack:D123:171.000001",
      interactionId: snapshot.interactionId,
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("routes unique Other and multi-select Done AskUser actions", async () => {
    const api = new FakeSlackApi();
    const base = askSnapshot();
    const question = base.questions[0]!;
    const snapshot: ChannelAskSnapshot = {
      ...base,
      questions: [{ ...question, multiSelect: true }],
    };
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const adapter = new SlackAdapter({
      api,
      responder: { respond: vi.fn() },
      allowAllChannels: true,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });

    await adapter.presentAsk("D123", "171.000001", snapshot);

    const controls = api.postMessageCalls[1]?.blocks as Array<{
      type?: string;
      elements?: Array<{ action_id?: string; text?: { text?: string }; value?: string }>;
    }>;
    const buttons = controls.find((block) => block.type === "actions")?.elements ?? [];
    expect(buttons.map((button) => button.action_id)).toEqual([
      "mono_agent_ask_user_option_0",
      "mono_agent_ask_user_option_1",
      "mono_agent_ask_user_option_2",
      "mono_agent_ask_user_other",
      "mono_agent_ask_user_done",
    ]);

    const other = buttons.find((button) => button.action_id === "mono_agent_ask_user_other")!;
    await expect(adapter.handleInteraction({
      type: "block_actions",
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{ action_id: other.action_id!, value: other.value! }],
    })).resolves.toMatchObject({ kind: "ask", outcome: "custom_requested" });
    expect(api.postMessageCalls.at(-1)?.text).toBe("Reply in this thread with your custom answer.");

    const send = buttons.find((button) => button.action_id === "mono_agent_ask_user_option_0")!;
    await expect(adapter.handleInteraction({
      type: "block_actions",
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{ action_id: send.action_id!, value: send.value! }],
    })).resolves.toMatchObject({ kind: "ask", outcome: "selection_updated" });

    const done = buttons.find((button) => button.action_id === "mono_agent_ask_user_done")!;
    await expect(adapter.handleInteraction({
      type: "block_actions",
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{ action_id: done.action_id!, value: done.value! }],
    })).resolves.toMatchObject({ kind: "ask", outcome: "answered" });
    expect(submitAskAnswers).toHaveBeenCalledWith({
      conversationId: "slack:D123:171.000001",
      interactionId: snapshot.interactionId,
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
  });

  it("consumes a threaded custom AskUser reply before normal turn admission", async () => {
    const api = new FakeSlackApi();
    const snapshot = askSnapshot();
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });

    await expect(adapter.handleEventCallback(directMessage("Rewrite the opening", {
      ts: "171.000002",
      threadTs: "171.000001",
    }))).resolves.toMatchObject({
      kind: "handled",
      metadata: { askUser: true },
    });
    expect(submitAskAnswers).toHaveBeenCalledWith({
      conversationId: "slack:D123:171.000001",
      interactionId: snapshot.interactionId,
      answers: [{ questionId: "q0", selectedOptionIds: [], customReply: "Rewrite the opening" }],
    });
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("notify() runs a proactive turn on the target thread and posts the answer there", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "morning brief" };
      }),
    });

    const result = await adapter.notify("C1", "171.5", "Compose the brief");

    expect(result).toEqual({
      delivered: true,
      code: "delivered",
      channelId: "slack",
      deliveryId: "slack:C1:200.000001",
    });
    expect(captured?.conversationId).toBe("slack:C1:171.5");
    expect(captured?.text).toBe("Compose the brief");
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("C1");
    expect(post?.thread_ts).toBe("171.5");
    expect(post?.text).toContain("morning brief");
    // A proactive turn does not react to a (non-existent) inbound message.
    expect(api.reactionsAddCalls).toEqual([]);
  });

  it("notify() suppresses transient tool activity for proactive turns", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({
          type: "tool_call_started",
          id: "t1",
          name: "WebSearch",
          arguments: { query: "scheduled research" },
        });
        return { text: "research complete" };
      }),
    });

    await adapter.notify("C1", "171.5", "Research this in the background");

    expect(api.postMessageCalls.map((call) => call.text)).toEqual(["research complete"]);
    expect(api.updateCalls).toEqual([]);
  });

  it("notify() verbatim posts the text as-is without running a turn and records it to history", async () => {
    const api = new FakeSlackApi();
    let responded = false;
    const verbatim: Array<[string, string]> = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async () => {
          responded = true;
          return { text: "should not run" };
        },
        deliverVerbatim: async (conversationId, text) => {
          verbatim.push([conversationId, text]);
        },
      },
    });

    const result = await adapter.notify("C1", "171.5", "All clear today.", { verbatim: true });

    expect(result).toEqual({
      delivered: true,
      code: "delivered",
      channelId: "slack",
      deliveryId: "slack:C1:200.000001",
      historyRecorded: true,
    });
    // No model turn ran — the body is posted as-is to the thread.
    expect(responded).toBe(false);
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("C1");
    expect(post?.thread_ts).toBe("171.5");
    expect(post?.text).toContain("All clear today.");
    // The body is recorded to history so a later reply resumes with it in context.
    expect(verbatim).toEqual([["slack:C1:171.5", "All clear today."]]);
  });

  it("notify(..., { silent: true }) documents Slack's limitation without inventing a Web API field", async () => {
    const api = new FakeSlackApi();
    const warn = vi.fn();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      logger: { warn },
      responder: {
        respond: async () => ({ text: "unused" }),
        deliverVerbatim: async () => undefined,
      },
    });

    const result = await adapter.notify("C1", "171.5", "Overnight digest.", {
      verbatim: true,
      silent: true,
    });

    expect(result).toMatchObject({ delivered: true, code: "delivered", channelId: "slack" });
    expect(api.postMessageCalls).toEqual([
      {
        channel: "C1",
        text: "Overnight digest.",
        thread_ts: "171.5",
        mrkdwn: true,
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Slack chat.postMessage has no bot-controlled silent-delivery option; posting with normal Slack notification behavior.",
      { silentRequested: true, silentApplied: false },
    );
  });

  it("threads the silent limitation through model-backed proactive notify", async () => {
    const api = new FakeSlackApi();
    const warn = vi.fn();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      logger: { warn },
      responder: responderFrom(async () => ({ text: "Prepared digest." })),
    });

    const result = await adapter.notify("C1", undefined, "Prepare the digest", { silent: true });

    expect(result).toMatchObject({ delivered: true, code: "delivered", channelId: "slack" });
    expect(api.postMessageCalls).toEqual([
      { channel: "C1", text: "Prepared digest.", mrkdwn: true },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Slack chat.postMessage has no bot-controlled silent-delivery option; posting with normal Slack notification behavior.",
      { silentRequested: true, silentApplied: false },
    );
  });

  it.each([
    ["verbatim notify with omitted silent", true, undefined],
    ["verbatim notify with false silent", true, false],
    ["model-backed notify with omitted silent", false, undefined],
    ["model-backed notify with false silent", false, false],
  ] as const)("does not warn for %s", async (_label, verbatim, silent) => {
    const api = new FakeSlackApi();
    const warn = vi.fn();
    const input = verbatim ? "Verbatim normal delivery." : "Prepare normal delivery";
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      logger: { warn },
      responder: {
        respond: async () => ({ text: "Model normal delivery." }),
        deliverVerbatim: async () => undefined,
      },
    });
    const options: SlackNotifyOptions = {
      ...(verbatim ? { verbatim: true } : {}),
      ...(silent === undefined ? {} : { silent }),
    };

    const result = await adapter.notify("C1", undefined, input, options);

    expect(result).toMatchObject({ delivered: true, code: "delivered", channelId: "slack" });
    expect(warn).not.toHaveBeenCalled();
    expect(api.postMessageCalls).toEqual([{
      channel: "C1",
      text: verbatim ? input : "Model normal delivery.",
      mrkdwn: true,
    }]);
  });

  it("reports confirmed Slack delivery with explicit degraded history instead of reposting", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async () => ({ text: "unused" }),
        deliverVerbatim: async () => { throw new Error("history storage unavailable"); },
      },
    });

    const result = await adapter.notify("C1", "171.5", "Confirmed channel answer", {
      verbatim: true,
      deliveryKey: "continuation:history-degraded",
    });

    expect(api.postMessageCalls).toHaveLength(1);
    expect(result).toEqual({
      delivered: true,
      code: "delivered",
      channelId: "slack",
      deliveryId: "slack:C1:200.000001",
      historyRecorded: false,
      historyErrorCode: "history_record_failed",
    });
  });

  it("reports partial multi-chunk verbatim delivery as ambiguous and never records full history", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageAfter = 1;
    const recorded: string[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { maxMessageChars: 32, maxSendRetries: 0, retryBaseDelayMs: 0 },
      responder: {
        respond: async () => ({ text: "unused" }),
        deliverVerbatim: async (_conversationId, text) => { recorded.push(text); },
      },
    });

    const result = await adapter.notify("C1", "171.5", "x".repeat(70), {
      verbatim: true,
      deliveryKey: "continuation:partial-overflow",
    });

    expect(result).toMatchObject({
      delivered: false,
      code: "delivery_unknown",
      retryable: false,
      ambiguous: true,
    });
    expect(api.postMessageCalls[0]?.text).toHaveLength(32);
    expect(recorded).toEqual([]);
  });

  it("reports a definite Slack refusal before any answer receipt as permanent", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageAfter = 0;
    api.postFailure = slackApiFailure("channel_not_found");
    const recorded: string[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { maxSendRetries: 0, retryBaseDelayMs: 0 },
      responder: {
        respond: async () => ({ text: "unused" }),
        deliverVerbatim: async (_conversationId, text) => { recorded.push(text); },
      },
    });

    const result = await adapter.notify("C1", "171.5", "definitely rejected", {
      verbatim: true,
      deliveryKey: "continuation:permanent-refusal",
    });

    expect(result).toEqual({
      delivered: false,
      reason: "Slack refused delivery",
      code: "channel_not_found",
      retryable: false,
    });
    expect(api.postMessageCalls).toHaveLength(2);
    expect(recorded).toEqual([]);
  });

  it("does not count a streaming status placeholder as a confirmed answer", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageAfter = 1;
    api.postFailure = slackApiFailure("channel_not_found");
    api.updateFailure = slackApiFailure("channel_not_found", "chat.update");
    const recorded: string[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { finalOnly: false, maxSendRetries: 0, retryBaseDelayMs: 0 },
      responder: {
        respond: async () => ({ text: "unused" }),
        deliverVerbatim: async (_conversationId, text) => { recorded.push(text); },
      },
    });

    const result = await adapter.notify("C1", "171.5", "answer never accepted", {
      verbatim: true,
      deliveryKey: "continuation:status-only",
    });

    expect(api.postMessageCalls.map((call) => call.text)).toEqual(["Thinking...", "answer never accepted"]);
    expect(api.updateCalls).toHaveLength(1);
    expect(result).toEqual({
      delivered: false,
      reason: "Slack refused delivery",
      code: "channel_not_found",
      retryable: false,
    });
    expect(recorded).toEqual([]);
  });

  it("keeps a receipt-less network failure ambiguous", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageAfter = 0;
    api.postFailure = new SlackApiError("connection reset", {
      kind: "network",
      method: "chat.postMessage",
    });
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { maxSendRetries: 0, retryBaseDelayMs: 0 },
      responder: responderFrom(async () => ({ text: "unused" })),
    });

    const result = await adapter.notify("C1", "171.5", "possibly accepted", {
      verbatim: true,
      deliveryKey: "continuation:network-unknown",
    });

    expect(result).toMatchObject({
      delivered: false,
      code: "delivery_unknown",
      retryable: false,
      ambiguous: true,
    });
  });

  it("reports a definite exhausted rate limit as retryable rather than ambiguous", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageAfter = 0;
    api.postFailure = new SlackApiError("rate limited", {
      kind: "slack",
      method: "chat.postMessage",
      status: 429,
      slackError: "ratelimited",
      retryAfterMs: 1,
    });
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { maxSendRetries: 0, retryBaseDelayMs: 0 },
      responder: responderFrom(async () => ({ text: "unused" })),
    });

    const result = await adapter.notify("C1", "171.5", "retry later", {
      verbatim: true,
      deliveryKey: "continuation:rate-limited",
    });

    expect(result).toEqual({
      delivered: false,
      reason: "Slack temporarily refused delivery",
      code: "ratelimited",
      retryable: true,
    });
  });

  it("commits continuation history without posting to Slack", async () => {
    const api = new FakeSlackApi();
    const recorded: Array<[string, string]> = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async () => ({ text: "unused" }),
        deliverVerbatim: async (conversationId, text) => { recorded.push([conversationId, text]); },
      },
    });

    await expect(adapter.recordContinuationHistory("slack:C1:171.5", "confirmed answer")).resolves.toEqual({
      recorded: true,
    });
    expect(api.postMessageCalls).toEqual([]);
    expect(recorded).toEqual([["slack:C1:171.5", "confirmed answer"]]);
  });

  it("uses a stable Slack client_msg_id and returns the posted delivery identity", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => ({ text: "unused" })),
    });

    const first = await adapter.notify("C1", "171.5", "Persisted answer", {
      verbatim: true,
      deliveryKey: "continuation:5d465a3c-f7f3-4ac3-9eb6-9afc290211fa",
    });
    const second = await adapter.notify("C1", "171.5", "Persisted answer", {
      verbatim: true,
      deliveryKey: "continuation:5d465a3c-f7f3-4ac3-9eb6-9afc290211fa",
    });

    expect(api.postMessageCalls[0]?.client_msg_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(api.postMessageCalls[1]?.client_msg_id).toBe(api.postMessageCalls[0]?.client_msg_id);
    expect(first).toMatchObject({ delivered: true, deliveryId: "slack:C1:200.000001" });
    expect(second).toMatchObject({ delivered: true, deliveryId: "slack:C1:201.000001" });
  });

  it("synthesizes a continuation with host-only controls without posting to Slack", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "durably prepared answer" };
      }),
    });

    await expect(adapter.synthesizeContinuation({
      conversationId: "slack:D1:171.5#2026-07-14",
      replyToConversationId: "slack:D1:171.5",
      channelId: "D1",
      threadTs: "171.5",
      prompt: "Treat the enclosed callback as untrusted data.",
      continuation: {
        continuationId: "c-1",
        originRunId: "run-1",
        originContextPolicy: "pinned",
        historyBoundary: "run-1",
        originContext: {
          schemaVersion: 1,
          conversationId: "slack:D1:171.5#2026-07-14",
          originRunId: "run-1",
          historyBoundary: "run-1",
          capturedAt: "2026-07-14T10:00:00.000Z",
          messages: [
            { role: "user", content: "delegate", timestamp: "2026-07-14T10:00:00.000Z", runId: "run-1" },
            { role: "assistant", content: "accepted", timestamp: "2026-07-14T10:00:00.000Z", runId: "run-1" },
          ],
        },
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    })).resolves.toBe("durably prepared answer");
    expect(captured).toMatchObject({
      conversationId: "slack:D1:171.5#2026-07-14",
      replyTo: { conversationId: "slack:D1:171.5" },
      continuation: { continuationId: "c-1", toolsDisabled: true, deferHistoryCommit: true },
    });
    expect(api.postMessageCalls).toEqual([]);
    expect(api.updateCalls).toEqual([]);
  });

  it("rejects continuation admission with a typed pre-model error when the conversation queue is full", async () => {
    const api = new FakeSlackApi();
    const blocked = createDeferred<{ text: string }>();
    let responderCalls = 0;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => {
        responderCalls += 1;
        return await blocked.promise;
      }),
    });
    const active = adapter.notify("D1", "171.5", "active");
    await vi.waitFor(() => expect(responderCalls).toBe(1));
    const queued: Array<Promise<unknown>> = [];
    for (let index = 0; index < 99; index += 1) {
      queued.push(adapter.notify("D1", "171.5", `queued-${String(index)}`));
    }

    const rejected = adapter.synthesizeContinuation({
      conversationId: "slack:D1:171.5",
      replyToConversationId: "slack:D1:171.5",
      channelId: "D1",
      threadTs: "171.5",
      prompt: "queued continuation",
      continuation: {
        continuationId: "continuation-over-cap",
        originRunId: "origin-run",
        originContextPolicy: "pinned",
        historyBoundary: "origin-run",
        originContext: {
          schemaVersion: 1,
          conversationId: "slack:D1:171.5",
          originRunId: "origin-run",
          historyBoundary: "origin-run",
          capturedAt: "2026-07-14T10:00:00.000Z",
          messages: [
            { role: "user", content: "delegate", timestamp: "2026-07-14T10:00:00.000Z", runId: "origin-run" },
            { role: "assistant", content: "accepted", timestamp: "2026-07-14T10:00:00.000Z", runId: "origin-run" },
          ],
        },
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    });

    await expect(rejected).rejects.toBeInstanceOf(SerialQueueFullError);
    expect(responderCalls).toBe(1);
    blocked.resolve({ text: "done" });
    await active;
    await Promise.allSettled(queued);
  });

  it("notify() reports an honest drop when the agent produces no answer", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => ({ text: "   " })),
    });

    const result = await adapter.notify("C1", "171.5", "Compose the brief");

    expect(result).toEqual({
      delivered: false,
      reason: "agent produced no answer",
      code: "empty_response",
      retryable: false,
    });
    // Nothing is posted when the agent has nothing to say.
    expect(api.postMessageCalls).toEqual([]);
  });

  it("notify() reports an honest drop when the conversation is at its concurrency cap", async () => {
    const api = new FakeSlackApi();
    const blocked = createDeferred<{ text: string }>();
    let activeStarted = false;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => {
        activeStarted = true;
        // The active proactive run holds the queue's running slot so the flood
        // parks behind it and the cap+1-th notify is rejected.
        return blocked.promise;
      }),
    });

    // One blocking active run takes the queue's running slot (depth 1).
    const activeRun = adapter.notify("C1", "171.5", "active");
    await vi.waitFor(() => expect(activeStarted).toBe(true));

    // The admission SerialQueue caps depth at 100. Fill it to the cap with 99
    // more same-conversation notifies, then the next one must be dropped.
    const maxDepth = 100;
    const queued: Array<Promise<unknown>> = [];
    for (let i = 0; i < maxDepth - 1; i += 1) {
      queued.push(adapter.notify("C1", "171.5", `fill-${i}`));
    }

    const overCap = await adapter.notify("C1", "171.5", "over-cap");

    expect(overCap).toEqual({
      delivered: false,
      reason: "conversation at concurrency cap",
      code: "conversation_busy",
      retryable: true,
    });

    // Drain: settle the active run and let the genuinely-queued fills resolve.
    blocked.resolve({ text: "done" });
    await activeRun;
    await Promise.allSettled(queued);
  });

  it("notify() into a thread registers under the /cancel key so a concurrent /cancel aborts it", async () => {
    const api = new FakeSlackApi();
    let capturedSignal: AbortSignal | undefined;
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(
        async (request, stream) => {
          await stream.event?.({
            type: "tool_call_started",
            id: "cancelled-tool",
            name: "Bash",
            arguments: { command: "pnpm test" },
          });
          return await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
          });
        },
      ),
    });

    // A threaded proactive run registers under the inbound /cancel runKey
    // `${channelId}:${threadTs}` rather than `proactive:...`, so a /cancel
    // posted to the same thread can abort it mid-flight.
    const notifyRun = adapter.notify("D123", "171.000001", "nudge");
    await responderStarted.promise;

    await expect(
      adapter.handleEventCallback(
        directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
      ),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(capturedSignal?.aborted).toBe(true);

    await expect(notifyRun).resolves.toEqual({
      delivered: false,
      reason: "cancelled",
      code: "cancelled",
      retryable: false,
    });
    expect(api.postMessageCalls.filter((call) => call.text === "Cancelled.")).toHaveLength(1);
  });

  it("notify() without a thread posts top-level and keys on the bare channel", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "channel ping" };
      }),
    });

    await adapter.notify("C2", undefined, "Post an announcement");

    expect(captured?.conversationId).toBe("slack:C2");
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("C2");
    expect(post?.thread_ts).toBeUndefined();
  });

  it("handles /start and /help commands with deterministic replies", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      runtimeControls: RUNTIME_CONTROLS,
    });

    await expect(adapter.handleEventCallback(directMessage("/start"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "start",
    });
    await expect(adapter.handleEventCallback(directMessage("/help"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "help",
    });

    expect(api.postMessageCalls.map((call) => call.text)).toEqual([
      "Hello! Send me a Slack message and I will pass it to the configured agent.",
      "Send a Slack DM or mention the app in a channel. Use /model and /effort to choose the runtime, or /cancel to stop an in-flight response.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("rejects malformed runtime-control catalogs at construction", () => {
    expect(() => new SlackAdapter({
      api: new FakeSlackApi(),
      responder: responderFrom(async () => ({ text: "ok" })),
      allowAllChannels: true,
      runtimeControls: {
        defaultModel: "missing",
        models: [{ value: "configured", label: "Configured", efforts: [] }],
      },
    })).toThrow(/defaultModel must appear/u);

    expect(() => new SlackAdapter({
      api: new FakeSlackApi(),
      responder: responderFrom(async () => ({ text: "ok" })),
      allowAllChannels: true,
      runtimeControls: {
        defaultModel: "duplicate",
        models: [
          { value: "duplicate", label: "First", efforts: [] },
          { value: "duplicate", label: "Second", efforts: [] },
        ],
      },
    })).toThrow(/duplicate model duplicate/u);
  });

  it("leaves runtime commands unbound when no runtime catalog is supplied", async () => {
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api: new FakeSlackApi(),
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ordinary response" };
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("/model"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });
    expect(captured?.text).toBe("/model");
  });

  it("falls back to exact model arguments when the catalog exceeds Slack's menu limit", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const runtimeControls = {
      defaultModel: "model-0",
      models: Array.from({ length: 101 }, (_, index) => ({
        value: `model-${index}`,
        label: `Model ${index}`,
        efforts: [],
      })),
    } satisfies SlackRuntimeControls;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      runtimeControls,
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
    });

    await adapter.handleEventCallback(directMessage("/model", { eventId: "Ev-menu" }));
    expect(api.postMessageCalls.at(-1)).toMatchObject({
      text: expect.stringContaining("exceeds Slack's 100-option menu limit"),
    });
    expect(api.postMessageCalls.at(-1)?.blocks).toBeUndefined();

    await adapter.handleEventCallback(directMessage("/model model-100", {
      eventId: "Ev-select",
      ts: "172.000001",
    }));
    await adapter.handleEventCallback(directMessage("use the selected model", {
      eventId: "Ev-run",
      ts: "173.000001",
    }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.metadata.slack.model).toBe("model-100");
  });

  it("uses a Block Kit model menu and applies the DM selection to new threads", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const respond = vi.fn(async (request: AgentRequest) => {
      requests.push(request);
      return { text: "ok" };
    });
    const responder: AgentResponder = { respond };
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      runtimeControls: RUNTIME_CONTROLS,
    });

    await expect(adapter.handleEventCallback(directMessage("/model"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "model",
    });
    expect(respond).not.toHaveBeenCalled();
    const menu = api.postMessageCalls[0];
    expect(menu?.text).toBe("Current model: Default GPT. Choose a configured model:");
    const select = staticSelectFrom(menu, "mono_agent_runtime_model");
    const fallback = select.options.find((option) => option.text.text === "Claude fallback");
    if (fallback === undefined) throw new Error("expected Claude fallback option");
    expect(fallback?.value).toMatch(/^[a-f0-9]{16}$/u);

    const interaction = {
      type: "block_actions" as const,
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{
        action_id: "mono_agent_runtime_model",
        selected_option: { value: fallback.value },
      }],
    };
    await expect(adapter.handleInteraction(interaction)).resolves.toEqual({
      kind: "runtime_control",
      id: "mono_agent_runtime_model",
      channelId: "D123",
      control: "model",
      outcome: "updated",
    });
    expect(api.updateCalls.at(-1)).toMatchObject({
      channel: "D123",
      ts: "200.000001",
      text: "Model changed to Claude fallback for this DM until /model default or restart.",
      blocks: [],
    });
    await expect(adapter.handleInteraction(interaction)).resolves.toMatchObject({
      kind: "runtime_control",
      outcome: "already_recorded",
    });
    expect(api.updateCalls).toHaveLength(1);

    await adapter.handleEventCallback(directMessage("first new thread", {
      eventId: "Ev-new-1",
      ts: "181.000001",
    }));
    await adapter.handleEventCallback(directMessage("second new thread", {
      eventId: "Ev-new-2",
      ts: "182.000001",
    }));

    expect(requests.map((request) => request.metadata.slack.model)).toEqual([
      "pi:anthropic:claude-fallback",
      "pi:anthropic:claude-fallback",
    ]);
  });

  it("keeps shared-channel selections isolated to the target thread", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const adapter = new SlackAdapter({
      api,
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      allowAllChannels: true,
      runtimeControls: RUNTIME_CONTROLS,
    });

    await adapter.handleEventCallback(appMention("/model pi:anthropic:claude-fallback", {
      eventId: "Ev-command",
      ts: "172.000010",
      threadTs: "172.000001",
    }));
    await adapter.handleEventCallback(appMention("thread A", {
      eventId: "Ev-A",
      ts: "172.000011",
      threadTs: "172.000001",
      user: "UUSER2",
    }));
    await adapter.handleEventCallback(appMention("thread B", {
      eventId: "Ev-B",
      ts: "173.000011",
      threadTs: "173.000001",
    }));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.metadata.slack.model).toBe("pi:anthropic:claude-fallback");
    expect(requests[1]?.metadata.slack.model).toBeUndefined();
  });

  it("inherits channel-wide slash choices while preserving thread-local overrides", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const adapter = new SlackAdapter({
      api,
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      allowAllChannels: true,
      runtimeControls: RUNTIME_CONTROLS,
      runtimeSlashCommands: {
        model: "/mickey-model",
        effort: "/mickey-effort",
      },
    });

    await expect(adapter.handleSlashCommand({
      command: "/mickey-model",
      text: "pi:anthropic:claude-fallback",
      channel_id: "C123",
    })).resolves.toMatchObject({
      kind: "runtime_command",
      control: "model",
      channelId: "C123",
    });
    await adapter.handleEventCallback(appMention("thread A inherits", {
      eventId: "Ev-A1",
      ts: "174.000002",
      threadTs: "174.000001",
    }));
    await adapter.handleEventCallback(appMention("thread B inherits", {
      eventId: "Ev-B1",
      ts: "175.000002",
      threadTs: "175.000001",
    }));

    await adapter.handleEventCallback(appMention("/model pi:openai:gpt-default", {
      eventId: "Ev-A-model",
      ts: "174.000003",
      threadTs: "174.000001",
    }));
    await adapter.handleEventCallback(appMention("thread A override", {
      eventId: "Ev-A2",
      ts: "174.000004",
      threadTs: "174.000001",
    }));
    await adapter.handleEventCallback(appMention("thread B still inherits", {
      eventId: "Ev-B2",
      ts: "175.000003",
      threadTs: "175.000001",
    }));

    await adapter.handleEventCallback(appMention("/model default", {
      eventId: "Ev-A-reset",
      ts: "174.000005",
      threadTs: "174.000001",
    }));
    await adapter.handleEventCallback(appMention("thread A inherits again", {
      eventId: "Ev-A3",
      ts: "174.000006",
      threadTs: "174.000001",
    }));

    await adapter.handleSlashCommand({
      command: "/mickey-model",
      text: "default",
      channel_id: "C123",
    });
    await adapter.handleEventCallback(appMention("thread B back to configured default", {
      eventId: "Ev-B3",
      ts: "175.000004",
      threadTs: "175.000001",
    }));

    expect(requests.map((request) => request.metadata.slack.model)).toEqual([
      "pi:anthropic:claude-fallback",
      "pi:anthropic:claude-fallback",
      "pi:openai:gpt-default",
      "pi:anthropic:claude-fallback",
      "pi:anthropic:claude-fallback",
      undefined,
    ]);
  });

  it("supports effort arguments and clears an incompatible effort when the model changes", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const responder = responderFrom(async (request) => {
      requests.push(request);
      return { text: "ok" };
    });
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      runtimeControls: RUNTIME_CONTROLS,
    });

    await adapter.handleEventCallback(directMessage("/effort high", { eventId: "Ev-effort" }));
    await adapter.handleEventCallback(directMessage("with effort", {
      eventId: "Ev-run-1",
      ts: "180.000001",
    }));
    expect(requests.at(-1)?.metadata.slack.effort).toBe("high");

    await adapter.handleEventCallback(directMessage("/model opencode:provider-owned", {
      eventId: "Ev-model",
      ts: "181.000001",
    }));
    expect(api.postMessageCalls.at(-1)?.text).toContain("previous effort selection was reset");
    await adapter.handleEventCallback(directMessage("without effort", {
      eventId: "Ev-run-2",
      ts: "182.000001",
    }));
    expect(requests.at(-1)?.metadata.slack).toMatchObject({ model: "opencode:provider-owned" });
    expect(requests.at(-1)?.metadata.slack.effort).toBeUndefined();
  });

  it("expires an effort menu if the effective model changes before selection", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      responder: responderFrom(async () => ({ text: "ok" })),
      allowAllChannels: true,
      runtimeControls: RUNTIME_CONTROLS,
    });

    await adapter.handleEventCallback(directMessage("/effort"));
    const menu = api.postMessageCalls[0];
    const select = staticSelectFrom(menu, "mono_agent_runtime_effort");
    const high = select.options.find((option) => option.text.text === "High");
    if (high === undefined) throw new Error("expected high effort option");
    await adapter.handleEventCallback(directMessage("/model pi:anthropic:claude-fallback", {
      eventId: "Ev-model",
      ts: "172.000001",
    }));

    await expect(adapter.handleInteraction({
      type: "block_actions",
      channel: { id: "D123" },
      message: { ts: "200.000001", thread_ts: "171.000001" },
      actions: [{
        action_id: "mono_agent_runtime_effort",
        selected_option: { value: high.value },
      }],
    })).resolves.toMatchObject({
      kind: "runtime_control",
      control: "effort",
      outcome: "expired",
    });
    expect(api.updateCalls.at(-1)).toMatchObject({
      text: "This effort menu has expired. Run /effort again.",
      blocks: [],
    });
  });

  it("acknowledges /cancel exactly once when no turn is active", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({ api, responder, allowAllChannels: true });

    await adapter.handleEventCallback(directMessage("/cancel"));

    expect(api.postMessageCalls.filter((call) => call.text === "Cancelled.")).toHaveLength(1);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("denies unauthorized channels without calling the responder", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowedChannelIds: ["C999"],
    });

    await expect(adapter.handleEventCallback(directMessage("hello", { channel: "D123" }))).resolves.toEqual({
      kind: "unauthorized",
      eventId: "Ev1",
      channelId: "D123",
    });

    expect(api.postMessageCalls).toEqual([
      {
        channel: "D123",
        text: "This Slack channel is not authorized to use this bot.",
        thread_ts: "171.000001",
      },
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("invokes the responder for DMs with bounded Slack metadata", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request, stream) => {
        requests.push(request);
        await stream.append("partial");
        return { text: "final", metadata: { provider: "fake" } };
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("  hello agent  "))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
      metadata: { provider: "fake" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: "slack:D123:171.000001",
      replyTo: { conversationId: "slack:D123:171.000001" },
      channelId: "D123",
      messageTs: "171.000001",
      threadTs: "171.000001",
      eventId: "Ev1",
      teamId: "T1",
      userId: "UUSER1",
      text: "hello agent",
      trigger: "direct",
      metadata: {
        slack: {
          teamId: "T1",
          apiAppId: "A1",
          eventId: "Ev1",
          eventTime: 171,
          channel: { id: "D123", type: "im" },
          message: { ts: "171.000001", eventTs: "171.000001" },
          user: { id: "UUSER1" },
          trigger: "direct",
        },
      },
    });
    expect(requests[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    // Final-only delivery: the answer arrives as a single chat.postMessage at
    // finish() — no interim "Thinking..." post and no streaming edits.
    expect(api.postMessageCalls).toEqual([
      {
        channel: "D123",
        text: "final",
        thread_ts: "171.000001",
        mrkdwn: true,
      },
    ]);
    expect(api.updateCalls).toEqual([]);
    // A 👀 "seen" reaction was added once to the triggering message while working.
    expect(api.reactionsAddCalls).toEqual([
      { channel: "D123", timestamp: "171.000001", name: "eyes" },
    ]);
  });

  it("sets an assistant-thread status while working when setAssistantStatus is available", async () => {
    const api = new FakeSlackApi();
    api.failSetAssistantStatus = false; // this conversation IS an assistant thread
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("partial");
        return { text: "final" };
      }),
    });

    await adapter.handleEventCallback(directMessage("hello"));

    // The official assistant-thread status is set (Slack auto-clears it when the
    // final message posts), and the 👀 reaction fallback is NOT used.
    expect(api.setAssistantStatusCalls).toEqual([
      { channelId: "D123", threadTs: "171.000001", status: "is thinking…" },
    ]);
    expect(api.reactionsAddCalls).toEqual([]);
  });

  it("falls back to the 👀 reaction when assistant status is unavailable (not an assistant thread)", async () => {
    const api = new FakeSlackApi();
    api.failSetAssistantStatus = true;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("partial");
        return { text: "final" };
      }),
    });

    await adapter.handleEventCallback(directMessage("hello"));

    // It tried the assistant status, hit the not-an-assistant-thread error, and
    // fell back to the 👀 reaction (added once).
    expect(api.setAssistantStatusCalls.length).toBeGreaterThanOrEqual(1);
    expect(api.reactionsAddCalls).toEqual([
      { channel: "D123", timestamp: "171.000001", name: "eyes" },
    ]);
  });

  it("sends responder Markdown as Slack mrkdwn", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => ({
        text: "**Done** [details](https://example.com/report)",
      })),
    });

    await expect(adapter.handleEventCallback(directMessage("summarize"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    // Final-only delivery: the Markdown answer is rendered to Slack mrkdwn and
    // sent in a single chat.postMessage at finish() — no separate placeholder
    // post and no chat.update edit.
    expect(api.postMessageCalls).toEqual([
      {
        channel: "D123",
        text: "*Done* <https://example.com/report|details>",
        thread_ts: "171.000001",
        mrkdwn: true,
      },
    ]);
    expect(api.updateCalls).toEqual([]);
  });

  it("handles app mentions and strips configured bot mentions and aliases", async () => {
    let capturedRequest: AgentRequest | undefined;
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      botUserIds: ["Ubot"],
      mentionTextAliases: ["@mono"],
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        capturedRequest = request;
        return { text: request.text };
      }),
    });

    const result = await adapter.handleEventCallback(appMention("<@Ubot> @mono help me"));

    expect(result).toMatchObject({ kind: "handled", action: "responded" });
    expect(capturedRequest).toMatchObject({
      conversationId: "slack:C123:172.000001",
      channelId: "C123",
      text: "help me",
      trigger: "app_mention",
      metadata: {
        slack: {
          channel: { id: "C123" },
          trigger: "app_mention",
        },
      },
    });
    // Final-only delivery: the stripped text is the final answer, posted once.
    expect(api.postMessageCalls.at(-1)?.text).toBe("help me");
    expect(api.updateCalls).toEqual([]);
  });

  it("normalizes Slack mrkdwn input to multiline Markdown after stripping mentions", async () => {
    let capturedRequest: AgentRequest | undefined;
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      botUserIds: ["Ubot"],
      mentionTextAliases: ["@mono"],
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        capturedRequest = request;
        return { text: request.text };
      }),
    });
    const slackText = [
      "<@Ubot> @mono",
      "\u2022 Release tooling",
      "\u00a0\u00a0\u25e6 Merged <https://github.example/pr/8|PR 8> and _noted follow-up_.",
    ].join("\n");

    await expect(adapter.handleEventCallback(appMention(slackText))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    expect(capturedRequest?.text).toBe(
      "- Release tooling\n  - Merged [PR 8](https://github.example/pr/8) and *noted follow-up*.",
    );
    expect(api.postMessageCalls.at(-1)).toMatchObject({
      channel: "C123",
      text: "- Release tooling\n  - Merged <https://github.example/pr/8|PR 8> and _noted follow-up_.",
      thread_ts: "172.000001",
      mrkdwn: true,
    });
  });

  it("ignores bot/self/subtyped and unsupported events without sending", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      botUserIds: ["Ubot"],
    });

    await expect(adapter.handleEventCallback(directMessage("self", { user: "Ubot" }))).resolves.toMatchObject({
      kind: "ignored",
      reason: "from_self",
    });
    await expect(adapter.handleEventCallback(directMessage("bot", { botId: "B1" }))).resolves.toMatchObject({
      kind: "ignored",
      reason: "from_bot",
    });
    await expect(adapter.handleEventCallback(directMessage("join", { subtype: "channel_join" }))).resolves.toMatchObject({
      kind: "ignored",
      reason: "unsupported_message",
    });
    await expect(adapter.handleEventCallback({ ...directMessage("x"), event: { type: "reaction_added" } })).resolves.toMatchObject({
      kind: "ignored",
      reason: "unsupported_event",
    });

    expect(responder.respond).not.toHaveBeenCalled();
    expect(api.postMessageCalls).toEqual([]);
  });

  it("admits a concurrent same-thread message in arrival order without rejecting it", async () => {
    const api = new FakeSlackApi();
    const first = createDeferred<{ text: string }>();
    const second = createDeferred<{ text: string }>();
    const queue = [first, second];
    let started = 0;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      // Concurrent same-thread messages are admitted through a per-conversation
      // serial queue: the second waits for the first (preserving order) and is
      // never rejected with a "busy" reply.
      responder: responderFrom(async () => {
        started += 1;
        return queue.shift()!.promise;
      }),
    });

    const firstRun = adapter.handleEventCallback(directMessage("first"));
    await vi.waitFor(() => expect(started).toBe(1));

    const secondRun = adapter.handleEventCallback(
      directMessage("second", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
    );
    // The second message is queued behind the first (serial admission): its
    // responder has NOT run yet, and no "busy" copy is posted.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(1);
    expect(
      api.postMessageCalls.some((call) =>
        call.text.includes("still working on this Slack thread"),
      ),
    ).toBe(false);

    // Completing the first admits the second, in order.
    first.resolve({ text: "done-1" });
    await vi.waitFor(() => expect(started).toBe(2));
    second.resolve({ text: "done-2" });

    await expect(firstRun).resolves.toMatchObject({ kind: "handled", action: "responded" });
    await expect(secondRun).resolves.toMatchObject({ kind: "handled", action: "responded" });

    // Delivered in arrival order, one final post each.
    expect(api.postMessageCalls.map((call) => call.text)).toEqual(["done-1", "done-2"]);
    expect(api.updateCalls).toEqual([]);
  });

  it("steers the active Slack run without starting a second responder turn", async () => {
    const api = new FakeSlackApi();
    const active = createDeferred<{ text: string }>();
    let respondCalls = 0;
    let offered: AgentLiveInputRequest | undefined;
    let settle!: (result: AgentLiveInputSettlement) => void;
    const settled = new Promise<AgentLiveInputSettlement>((resolve) => { settle = resolve; });
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async () => {
          respondCalls += 1;
          return active.promise;
        },
        offerLiveInput(request) {
          if (request.text !== "steer now") return { status: "unavailable", reason: "inactive" };
          offered = request;
          return { status: "accepted", settled };
        },
      },
    });

    const first = adapter.handleEventCallback(directMessage("long task"));
    await vi.waitFor(() => expect(respondCalls).toBe(1));
    await expect(adapter.handleEventCallback(directMessage("steer now", {
      eventId: "Ev2",
      ts: "171.000002",
      threadTs: "171.000001",
    }))).resolves.toMatchObject({ metadata: { liveInput: true } });
    expect(offered).toMatchObject({
      conversationId: "slack:D123:171.000001",
      id: "Ev2",
      text: "steer now",
    });
    expect(api.reactionsAddCalls).toContainEqual({
      channel: "D123",
      timestamp: "171.000002",
      name: "eyes",
    });
    expect(respondCalls).toBe(1);

    settle({ status: "applied", runId: "run-1" });
    active.resolve({ text: "steered answer" });
    await expect(first).resolves.toMatchObject({ kind: "handled" });
    await vi.waitFor(() => expect(api.postMessageCalls.map((call) => call.text)).toEqual(["steered answer"]));
    expect(respondCalls).toBe(1);
  });

  it("runs an unsettled Slack follow-up as the next queued turn", async () => {
    const api = new FakeSlackApi();
    const firstResponse = createDeferred<{ text: string }>();
    const seen: string[] = [];
    let settle!: (result: AgentLiveInputSettlement) => void;
    const settled = new Promise<AgentLiveInputSettlement>((resolve) => { settle = resolve; });
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async (request) => {
          seen.push(request.text);
          return request.text === "long task" ? firstResponse.promise : { text: "follow-up answer" };
        },
        offerLiveInput(request) {
          return request.text === "follow up"
            ? { status: "accepted", settled }
            : { status: "unavailable", reason: "inactive" };
        },
      },
    });

    const first = adapter.handleEventCallback(directMessage("long task"));
    await vi.waitFor(() => expect(seen).toEqual(["long task"]));
    await adapter.handleEventCallback(directMessage("follow up", {
      eventId: "Ev2",
      ts: "171.000002",
      threadTs: "171.000001",
    }));
    settle({ status: "requeue", reason: "closed" });
    firstResponse.resolve({ text: "first answer" });
    await first;
    await vi.waitFor(() => expect(seen).toEqual(["long task", "follow up"]));
    await vi.waitFor(() => expect(api.postMessageCalls.map((call) => call.text)).toEqual([
      "first answer",
      "follow-up answer",
    ]));
  });

  it("rejects an over-cap same-thread flood with a busy result and posts busyText without leaking its controller", async () => {
    const api = new FakeSlackApi();
    const active = createDeferred<{ text: string }>();
    let respondCalls = 0;
    let activeStarted = false;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        respondCalls += 1;
        activeStarted = true;
        // The first run blocks forever (until the test settles it), holding the
        // queue's active slot so the flood parks behind it.
        return active.promise;
      }),
    });

    // One blocking active run takes the queue's running slot (depth 1).
    const activeRun = adapter.handleEventCallback(directMessage("active"));
    await vi.waitFor(() => expect(activeStarted).toBe(true));

    // The admission SerialQueue caps depth at 100. The active run holds 1 slot, so
    // 99 more same-thread messages fill the queue to the cap; the 100th queued
    // message (the cap+1-th in total) must be rejected as busy.
    const maxDepth = 100;
    const queued: Array<Promise<unknown>> = [];
    for (let i = 0; i < maxDepth - 1; i += 1) {
      queued.push(
        adapter.handleEventCallback(
          directMessage(`fill-${i}`, {
            eventId: `Evfill${i}`,
            ts: `171.0001${i}`,
            threadTs: "171.000001",
          }),
        ),
      );
    }

    // This over-cap message is rejected synchronously by the queue (depth === cap)
    // and never reaches the responder.
    const overCap = await adapter.handleEventCallback(
      directMessage("over-cap", {
        eventId: "EvOverCap",
        ts: "171.000999",
        threadTs: "171.000001",
      }),
    );

    expect(overCap).toEqual({ kind: "busy", eventId: "EvOverCap", channelId: "D123" });
    // The busy terminal copy was posted to the thread.
    expect(api.postMessageCalls.at(-1)).toEqual({
      channel: "D123",
      text: "I am still working on this Slack thread. Use /cancel to stop it.",
      thread_ts: "171.000001",
    });
    // Only the active run reached the responder; the over-cap message did not.
    expect(respondCalls).toBe(1);

    // The over-cap message's controller was unregistered on the rejected path (no
    // leak): only the active run + the 99 genuinely-queued fills remain tracked
    // (exactly maxDepth), NOT maxDepth + 1. respondToEvent's finally never ran for
    // the rejected message, so the busy path must clean its eager controller up.
    const controllers = (
      adapter as unknown as {
        activeControllers: Map<string, Set<AbortController>>;
      }
    ).activeControllers;
    const tracked = [...controllers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(tracked).toBe(maxDepth);

    // Drain: settle the active run and let the genuinely-queued fills resolve.
    active.resolve({ text: "done" });
    await activeRun;
    await Promise.allSettled(queued);

    // After draining, every controller is unregistered (the rejected one left
    // nothing behind, and the run-through fills cleaned up in their finally).
    const remaining = [...controllers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(remaining).toBe(0);
  });

  it("preserves arrival order when an earlier same-thread message stalls on file download", async () => {
    const api = new FakeSlackApi();
    const order: string[] = [];
    const firstDownload = createDeferred<void>();
    api.downloadFile = async () => {
      await firstDownload.promise; // the first message's download stalls
      return new Uint8Array([1, 2, 3]);
    };
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      attachments: { allowedMimeTypes: ["image/png"] },
      responder: responderFrom(async (request) => {
        order.push(request.text);
        return { text: `ok:${request.text}` };
      }),
    });

    // A has a (stalled) file; B has none and would otherwise race ahead.
    const aRun = adapter.handleEventCallback(
      directMessage("A-with-file", {
        files: [{ id: "F1", name: "a.png", mimetype: "image/png", url_private: "https://files.slack.test/a.png" }],
      }),
    );
    const bRun = adapter.handleEventCallback(
      directMessage("B-no-file", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    // B must NOT have reached the responder before A (it is queued behind A).
    expect(order).toEqual([]);

    firstDownload.resolve();
    await Promise.all([aRun, bRun]);
    // The responder saw the messages in arrival order, not download-completion order.
    expect(order).toEqual(["A-with-file", "B-no-file"]);
  });

  it("aborts active runs and clears queued follow-ups on /cancel in the same Slack thread", async () => {
    const api = new FakeSlackApi();
    let capturedSignal: AbortSignal | undefined;
    const cancelCalls: Array<{ conversationId: string; reason: unknown }> = [];
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request) =>
          await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
          }),
        cancel: (conversationId: string, reason?: unknown) => {
          cancelCalls.push({ conversationId, reason });
        },
      },
    });

    const first = adapter.handleEventCallback(directMessage("long task"));
    await responderStarted.promise;

    await expect(
      adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(capturedSignal?.aborted).toBe(true);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.conversationId).toBe("slack:D123:171.000001");
    expect(isChannelUserCancelReason(cancelCalls[0]?.reason)).toBe(true);
    await expect(first).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(api.postMessageCalls.filter((call) => call.text === "Cancelled.")).toHaveLength(1);
    expect(api.updateCalls).toEqual([]);
  });

  it("/cancel silences a queued same-thread follow-up before it reaches the responder", async () => {
    const api = new FakeSlackApi();
    let respondCalls = 0;
    const aBlocked = createDeferred<{ text: string }>();
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request) => {
          respondCalls += 1;
          // A blocks until aborted; B must never reach here (it is silenced by the
          // /cancel that fires while it is still parked in the admission queue).
          return await new Promise<{ text: string }>((resolve) => {
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
            void aBlocked.promise.then(resolve);
          });
        },
        cancel: () => undefined,
      },
    });

    // A becomes the active run.
    const aRun = adapter.handleEventCallback(directMessage("long task"));
    await responderStarted.promise;

    // B arrives on the same thread and parks behind A in the admission queue
    // (its controller is registered eagerly, before the queued task starts).
    const bRun = adapter.handleEventCallback(
      directMessage("queued follow-up", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
    );

    // /cancel aborts every controller for the thread — including B's still-queued one.
    await expect(
      adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev3", ts: "171.000003", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });

    await expect(aRun).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    await expect(bRun).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });

    // The responder ran exactly once (A only) — B bailed before responder.respond.
    expect(respondCalls).toBe(1);
    // No agent answer or per-turn cancellation is posted after the command ack.
    expect(api.postMessageCalls.filter((call) => call.text === "Cancelled.")).toHaveLength(1);
  });

  it("/cancel aborts another physical thread queued under the same resolved conversation", async () => {
    const api = new FakeSlackApi();
    const firstRelease = createDeferred<{ text: string }>();
    const responderStarted = createDeferred<void>();
    const requests: string[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      resolvePostIndex: async () => "slack:D123",
      responder: {
        respond: async (request) => {
          requests.push(request.text);
          if (requests.length === 1) {
            responderStarted.resolve(undefined);
            return await firstRelease.promise;
          }
          return { text: "must not run" };
        },
        cancel: () => undefined,
      },
    });

    const threadA = adapter.handleEventCallback(
      directMessage("thread A", { eventId: "EvA", ts: "171.000010", threadTs: "171.000001" }),
    );
    await responderStarted.promise;
    const threadB = adapter.handleEventCallback(
      directMessage("thread B", { eventId: "EvB", ts: "172.000010", threadTs: "172.000001" }),
    );

    await expect(adapter.handleEventCallback(
      directMessage("/cancel", { eventId: "EvCancel", ts: "171.000011", threadTs: "171.000001" }),
    )).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    firstRelease.resolve({ text: "must not deliver" });

    await expect(threadA).resolves.toMatchObject({ kind: "cancelled" });
    await expect(threadB).resolves.toMatchObject({ kind: "cancelled" });
    expect(requests).toEqual(["thread A"]);
    expect(api.postMessageCalls.filter((call) => call.text === "Cancelled.")).toHaveLength(1);
  });

  it("does not require a responder.cancel to handle /cancel", async () => {
    const api = new FakeSlackApi();
    let capturedSignal: AbortSignal | undefined;
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(
        async (request, stream) => {
          await stream.event?.({
            type: "tool_call_started",
            id: "cancelled-inbound-tool",
            name: "Bash",
            arguments: { command: "pnpm test" },
          });
          return await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
          });
        },
      ),
    });

    const first = adapter.handleEventCallback(directMessage("long task"));
    await responderStarted.promise;

    await expect(
      adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(capturedSignal?.aborted).toBe(true);
    await expect(first).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(api.deleteCalls).toEqual([{ channel: "D123", ts: "200.000001" }]);
    expect(api.postMessageCalls.filter((call) => call.text === "Cancelled.")).toHaveLength(1);
  });

  it("shows transient tool activity with a 👀 reaction and never leaks reasoning text", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "tool_call_started", id: "t1", name: "WebSearch" });
        await stream.event?.({ type: "assistant_thought", text: "secret reasoning" });
        return { text: "final answer" };
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("look it up"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    const allText = [
      ...api.postMessageCalls.map((call) => call.text),
      ...api.updateCalls.map((call) => call.text),
    ];
    // The existing 👀 acknowledgement accompanies one transient tool status;
    // the final answer posts fresh before that status is deleted.
    expect(api.reactionsAddCalls).toEqual([
      { channel: "D123", timestamp: "171.000001", name: "eyes" },
    ]);
    expect(allText.some((text) => text.includes("Searching the web"))).toBe(true);
    expect(allText.some((text) => text.includes("WebSearch"))).toBe(false);
    expect(allText.some((text) => text.includes("secret reasoning"))).toBe(false);
    expect(api.postMessageCalls.map((call) => call.text)).toEqual([
      "🌐 Searching the web",
      "final answer",
    ]);
    expect(api.updateCalls).toEqual([]);
    expect(api.deleteCalls).toEqual([{ channel: "D123", ts: "200.000001" }]);
  });

  it("downloads inbound files into request.attachments with base64 data", async () => {
    const api = new FakeSlackApi();
    const downloads: Array<{ url: string; signalAborted: boolean }> = [];
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const textBytes = new TextEncoder().encode("hello doc");
    api.downloadFile = async (params, options) => {
      downloads.push({ url: params.url, signalAborted: options?.signal?.aborted === true });
      if (params.url.includes("photo")) {
        return imageBytes;
      }
      return textBytes;
    };

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const callback = directMessage("here are files", {
      files: [
        {
          id: "F1",
          name: "photo.png",
          mimetype: "image/png",
          url_private: "https://files.slack.test/photo.png",
          size: imageBytes.byteLength,
        },
        {
          id: "F2",
          title: "Notes",
          name: "notes.txt",
          mimetype: "text/plain",
          url_private: "https://files.slack.test/notes.txt",
          size: textBytes.byteLength,
        },
      ],
    });

    await expect(adapter.handleEventCallback(callback)).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    expect(downloads.map((d) => d.url)).toEqual([
      "https://files.slack.test/photo.png",
      "https://files.slack.test/notes.txt",
    ]);
    expect(downloads.every((d) => d.signalAborted === false)).toBe(true);

    expect(captured?.attachments).toHaveLength(2);
    expect(captured?.attachments?.[0]).toEqual({
      kind: "image",
      mimeType: "image/png",
      data: Buffer.from(imageBytes).toString("base64"),
      name: "photo.png",
      sizeBytes: imageBytes.byteLength,
    });
    // Text mimetypes are also decoded to UTF-8 text.
    expect(captured?.attachments?.[1]).toEqual({
      kind: "document",
      mimeType: "text/plain",
      data: Buffer.from(textBytes).toString("base64"),
      name: "notes.txt",
      sizeBytes: textBytes.byteLength,
      text: "hello doc",
    });
  });

  it("downloads files from a file_share subtyped message instead of ignoring it", async () => {
    const api = new FakeSlackApi();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    api.downloadFile = async () => imageBytes;

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    // Slack delivers a file upload as subtype "file_share"; it must NOT be
    // rejected as an unsupported subtyped message.
    const callback = directMessage("here is a screenshot", {
      subtype: "file_share",
      files: [
        { id: "F1", name: "shot.png", mimetype: "image/png", url_private: "https://files.slack.test/shot.png", size: imageBytes.byteLength },
      ],
    });

    await expect(adapter.handleEventCallback(callback)).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });
    expect(captured?.attachments).toHaveLength(1);
    expect(captured?.attachments?.[0]?.name).toBe("shot.png");
  });

  it("skips a file whose download fails and keeps the rest", async () => {
    const api = new FakeSlackApi();
    const okBytes = new Uint8Array([1, 2, 3]);
    api.downloadFile = async (params) => {
      if (params.url.includes("bad")) {
        throw new Error("download failed");
      }
      return okBytes;
    };

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const callback = directMessage("files", {
      files: [
        { id: "F1", name: "bad.png", mimetype: "image/png", url_private: "https://files.slack.test/bad.png" },
        { id: "F2", name: "good.png", mimetype: "image/png", url_private: "https://files.slack.test/good.png" },
      ],
    });

    await adapter.handleEventCallback(callback);

    expect(captured?.attachments).toHaveLength(1);
    expect(captured?.attachments?.[0]?.name).toBe("good.png");
  });

  it("enforces the maxBytes cap and mimetype allowlist", async () => {
    const api = new FakeSlackApi();
    api.downloadFile = async () => new Uint8Array([1, 2, 3, 4]);

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      attachments: { maxBytes: 3, allowedMimeTypes: ["image/png"] },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const callback = directMessage("files", {
      files: [
        // Disallowed mimetype: skipped before any download.
        { id: "F1", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.test/doc.pdf" },
        // Allowed mimetype but advertised size exceeds the cap: skipped.
        { id: "F2", name: "big.png", mimetype: "image/png", size: 9, url_private: "https://files.slack.test/big.png" },
      ],
    });

    await adapter.handleEventCallback(callback);

    expect(captured?.attachments ?? []).toHaveLength(0);
  });

  it("returns a deterministic no-usable-files response when a file-only message has all files skipped", async () => {
    const api = new FakeSlackApi();
    let responderCalled = false;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      attachments: { allowedMimeTypes: ["image/png"] },
      responder: responderFrom(async () => {
        responderCalled = true;
        return { text: "ok" };
      }),
    });

    // File-only (no caption) with a disallowed-MIME file → every file skipped.
    const result = await adapter.handleEventCallback(
      directMessage("", {
        files: [{ id: "F1", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.test/doc.pdf" }],
      }),
    );

    // The adapter answers deterministically instead of submitting an empty
    // request that the harness would reject.
    expect(result).toMatchObject({ kind: "ignored", reason: "no_usable_attachments" });
    expect(responderCalled).toBe(false);
    expect(api.postMessageCalls.at(-1)?.text).toContain("only handle Slack text messages");
  });

  it("works with a text-only SlackWebApi client that has no downloadFile (forwards metadata only)", async () => {
    const posts: SlackChatPostMessageParams[] = [];
    // A minimal client WITHOUT downloadFile / reactionsAdd — must typecheck and
    // not crash even on a file event.
    const textOnlyApi: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params: SlackChatPostMessageParams) {
        posts.push(params);
        return { ok: true as const, channel: params.channel, ts: "200.000001" };
      },
      async chatUpdate(params: SlackChatUpdateParams) {
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api: textOnlyApi,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const result = await adapter.handleEventCallback(
      directMessage("look at this", {
        files: [{ id: "F1", name: "a.png", mimetype: "image/png", url_private: "https://files.slack.test/a.png" }],
      }),
    );

    expect(result).toMatchObject({ kind: "handled", action: "responded" });
    // No bytes were downloaded (the client has no downloadFile), so no attachments.
    expect(captured?.attachments ?? []).toHaveLength(0);
    expect(posts.some((p) => p.text === "ok")).toBe(true);
  });

  it("surfaces responder failures without fake success", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => {
        throw new Error("runtime exploded");
      }),
    });

    const result = await adapter.handleEventCallback(directMessage("boom"));

    expect(result).toMatchObject({ kind: "error", channelId: "D123" });
    // Final-only delivery: the failure copy is the single final post.
    expect(api.postMessageCalls.at(-1)?.text).toBe(
      "The agent failed while processing your Slack message.",
    );
    expect(api.updateCalls).toEqual([]);
  });

  it("finishes with cancelled text when the responder reports cancellation", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("please stop"))).resolves.toMatchObject({
      kind: "cancelled",
      channelId: "D123",
    });
    // Final-only delivery: the cancelled copy is the single final post.
    expect(api.postMessageCalls.at(-1)?.text).toBe("Cancelled.");
    expect(api.updateCalls).toEqual([]);
  });
});

describe("SlackAdapter.handleShortcut", () => {
  it("runs the bound prompt as a proactive turn in the shortcut's destination channel", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1" }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "synced 3 items" };
      }),
    });

    const result = await adapter.handleShortcut({
      type: "shortcut",
      callback_id: "sync_now",
      trigger_id: "T1",
      user: { id: "U1" },
    });

    expect(result).toMatchObject({
      kind: "triggered",
      id: "sync_now",
      channelId: "D1",
      delivered: true,
    });
    expect(captured?.text).toBe("Run the sync.");
    // A global shortcut has no thread → the run posts top-level in the destination.
    expect(captured?.conversationId).toBe("slack:D1");
    expect(api.postMessageCalls.at(-1)?.channel).toBe("D1");
    expect(api.postMessageCalls.at(-1)?.thread_ts).toBeUndefined();
    expect(api.postMessageCalls.at(-1)?.text).toContain("synced 3 items");
  });

  it("posts an instant ack before the run when ackText is set", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [
        { callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…" },
      ],
      responder: responderFrom(async () => ({ text: "No changes" })),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toMatchObject({ kind: "triggered", delivered: true });
    // First post is the instant ack; the run's result follows as its own message.
    const ack = api.postMessageCalls[0];
    const summary = api.postMessageCalls[1];
    expect(ack?.text).toBe("🔄 Syncing…");
    expect(ack?.thread_ts).toBeUndefined();
    expect(summary?.text).toContain("No changes");
    // Default (no threadReply): the result is its own top-level message.
    expect(summary?.thread_ts).toBeUndefined();
  });

  it("threads the interaction result under the ack when threadReply is set (one thread, not two top-level posts)", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [
        { callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…", threadReply: true },
      ],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "No changes" };
      }),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toMatchObject({ kind: "triggered", delivered: true });
    const ack = api.postMessageCalls[0];
    const summary = api.postMessageCalls[1];
    // Ack is the thread root (posted top-level); the result replies under it. The
    // fake api hands the first post ts "200.000001".
    expect(ack?.thread_ts).toBeUndefined();
    expect(summary?.thread_ts).toBe("200.000001");
    // The run's conversation is keyed on that ack thread, so a later in-thread
    // reply resolves back to it rather than to the bare-DM chat.
    expect(captured?.conversationId).toBe("slack:D1:200.000001");
  });

  it("keeps threadReply best-effort: the result still posts top-level when the ack throws", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageWhenTextIncludes = "Syncing";
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [
        { callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…", threadReply: true },
      ],
      responder: responderFrom(async () => ({ text: "No changes" })),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toMatchObject({ kind: "triggered", delivered: true });
    // Ack throw was swallowed; with no ack ts to thread under, the result posts top-level.
    expect(api.postMessageCalls.at(-1)?.text).toContain("No changes");
    expect(api.postMessageCalls.at(-1)?.thread_ts).toBeUndefined();
  });

  it("with threadReply set, a message shortcut in a source thread keeps that thread (does not re-parent under the ack)", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", ackText: "🔄 Syncing…", threadReply: true }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
    });

    const result = await adapter.handleShortcut({
      type: "message_action",
      callback_id: "sync_now",
      channel: { id: "C1" },
      message: { ts: "171.5" },
    });

    expect(result).toMatchObject({ kind: "triggered", channelId: "C1", delivered: true });
    // threadReply only fills a MISSING thread; a real source thread wins, so both the
    // ack and the result stay under the source message — not re-parented to the ack ts.
    expect(api.postMessageCalls[0]?.thread_ts).toBe("171.5");
    expect(api.postMessageCalls.at(-1)?.thread_ts).toBe("171.5");
    expect(captured?.conversationId).toBe("slack:C1:171.5");
  });

  it("threads a Home button's result under its ack when threadReply is set (block_actions path)", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: {
        enabled: true,
        buttons: [
          { actionId: "draft", label: "📝 Draft", prompt: "Draft it.", channelId: "D1", ackText: "📝 Drafting…", threadReply: true },
        ],
      },
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "the draft" };
      }),
    });

    const result = await adapter.handleBlockActions({
      type: "block_actions",
      actions: [{ action_id: "draft", value: "draft" }],
    });

    expect(result).toMatchObject({ kind: "triggered", id: "draft", delivered: true });
    // Home tab carries no source channel → the ack posts top-level and the draft
    // threads under it (fake api hands the first post ts "200.000001").
    expect(api.postMessageCalls[0]?.thread_ts).toBeUndefined();
    expect(api.postMessageCalls[1]?.thread_ts).toBe("200.000001");
    expect(captured?.conversationId).toBe("slack:D1:200.000001");
  });

  it("falls back to the first allowlisted channel when the binding omits channelId", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync." }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "ok" };
      }),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toMatchObject({ kind: "triggered", channelId: "D1", delivered: true });
    expect(captured?.channelId).toBe("D1");
  });

  it("ignores an unbound shortcut without running anything", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1" }],
      responder: { respond },
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "some_other" });

    expect(result).toEqual({ kind: "ignored", reason: "unbound", id: "some_other" });
    expect(respond).not.toHaveBeenCalled();
    expect(api.postMessageCalls).toEqual([]);
  });

  it("rejects a shortcut whose destination is outside the allowlist", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D-evil" }],
      responder: { respond },
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toEqual({ kind: "unauthorized", id: "sync_now", channelId: "D-evil" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("threads a message shortcut's reply in its source channel when no channelId is pinned", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync." }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
    });

    const result = await adapter.handleShortcut({
      type: "message_action",
      callback_id: "sync_now",
      channel: { id: "C1" },
      message: { ts: "171.5" },
    });

    expect(result).toMatchObject({ kind: "triggered", id: "sync_now", channelId: "C1", delivered: true });
    // Destination == source channel → the reply threads under the source message.
    expect(captured?.conversationId).toBe("slack:C1:171.5");
    expect(api.postMessageCalls.at(-1)?.thread_ts).toBe("171.5");
  });

  it("posts top-level (no foreign thread_ts) when a binding redirects to a different channel", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D2"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D2" }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
    });

    // Message shortcut invoked in D1, but the binding pins D2 — the D1 thread_ts is
    // channel-scoped and must NOT be carried into D2.
    const result = await adapter.handleShortcut({
      type: "message_action",
      callback_id: "sync_now",
      channel: { id: "D1" },
      message: { ts: "171.1" },
    });

    expect(result).toMatchObject({ kind: "triggered", channelId: "D2", delivered: true });
    expect(captured?.conversationId).toBe("slack:D2");
    expect(api.postMessageCalls.at(-1)?.channel).toBe("D2");
    expect(api.postMessageCalls.at(-1)?.thread_ts).toBeUndefined();
  });

  it("ignores a global shortcut with no resolvable destination channel", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true, // no allowlist → no default destination
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync." }],
      responder: { respond },
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toEqual({ kind: "ignored", reason: "missing_channel", id: "sync_now" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("still runs when the instant ack post fails (best-effort)", async () => {
    const api = new FakeSlackApi();
    api.failPostMessageWhenTextIncludes = "Syncing"; // only the ack fails
    let ran = false;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…" }],
      responder: responderFrom(async () => {
        ran = true;
        return { text: "done" };
      }),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(ran).toBe(true);
    expect(result).toMatchObject({ kind: "triggered", delivered: true });
    expect(api.postMessageCalls.at(-1)?.text).toContain("done");
  });
});

describe("SlackAdapter App Home tab", () => {
  it("publishes a Home view with a button per configured Home button on app_home_opened", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: {
        enabled: true,
        headerText: "Controls",
        buttons: [{ actionId: "sync_now", label: "🔄 Sync", prompt: "Run the sync.", channelId: "D1" }],
      },
      responder: responderFrom(async () => ({ text: "ok" })),
    });

    const result = await adapter.handleEventCallback(appHomeOpened("U1"));

    expect(result).toEqual({ kind: "home_published", eventId: "EvHome", userId: "U1" });
    expect(api.viewsPublishCalls.at(-1)?.userId).toBe("U1");
    const view = api.viewsPublishCalls.at(-1)?.view;
    expect(view?.type).toBe("home");
    // Structured: header section first, then an actions block whose button maps
    // action_id (and value) to the configured id and renders the configured label.
    const blocks = (view?.blocks ?? []) as Array<Record<string, any>>;
    expect(blocks[0]).toMatchObject({ type: "section", text: { type: "mrkdwn", text: "Controls" } });
    expect(blocks[1]).toMatchObject({ type: "actions" });
    expect(blocks[1]?.elements?.[0]).toMatchObject({
      type: "button",
      action_id: "sync_now",
      value: "sync_now",
      text: { type: "plain_text", text: "🔄 Sync" },
    });
  });

  it("publishes a button-only Home view (no header) with just the actions block", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: { enabled: true, buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run.", channelId: "D1" }] },
      responder: responderFrom(async () => ({ text: "ok" })),
    });

    await adapter.handleEventCallback(appHomeOpened("U1"));

    const blocks = (api.viewsPublishCalls.at(-1)?.view?.blocks ?? []) as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "actions" });
  });

  it("skips publishing (no error) when the Home client cannot publish views", async () => {
    const api = new FakeSlackApi();
    (api as { viewsPublish?: unknown }).viewsPublish = undefined; // text-only client
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: { enabled: true, buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run.", channelId: "D1" }] },
      responder: responderFrom(async () => ({ text: "ok" })),
    });

    const result = await adapter.handleEventCallback(appHomeOpened("U1"));

    expect(result).toMatchObject({ kind: "ignored" });
    expect(api.viewsPublishCalls).toEqual([]);
  });

  it("acts on the first BOUND action when a block_actions payload carries several", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: { enabled: true, buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run the sync.", channelId: "D1" }] },
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "ok" };
      }),
    });

    // First action is unbound; the bound one is second.
    const result = await adapter.handleBlockActions({
      type: "block_actions",
      actions: [{ action_id: "unrelated" }, { action_id: "sync_now", value: "sync_now" }],
    });

    expect(result).toMatchObject({ kind: "triggered", id: "sync_now" });
    expect(captured?.text).toBe("Run the sync.");
  });

  it("runs a Home button's prompt and replies in its channel on block_actions", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: {
        enabled: true,
        buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…" }],
      },
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "No changes" };
      }),
    });

    // A Home-tab button click carries no channel — routing falls to the binding's channelId.
    const result = await adapter.handleBlockActions({
      type: "block_actions",
      user: { id: "U1" },
      actions: [{ action_id: "sync_now", value: "sync_now" }],
    });

    expect(result).toMatchObject({ kind: "triggered", id: "sync_now", channelId: "D1", delivered: true });
    expect(captured?.text).toBe("Run the sync.");
    expect(api.postMessageCalls[0]?.text).toBe("🔄 Syncing…"); // instant ack first
    expect(api.postMessageCalls.at(-1)?.text).toContain("No changes");
  });

  it("ignores a block_actions click on an unbound action", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: { enabled: true, buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run.", channelId: "D1" }] },
      responder: { respond },
    });

    const result = await adapter.handleBlockActions({
      type: "block_actions",
      actions: [{ action_id: "not_bound" }],
    });

    expect(result).toEqual({ kind: "ignored", reason: "unbound" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not publish a Home view when the Home tab is disabled", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      responder: responderFrom(async () => ({ text: "ok" })),
    });

    const result = await adapter.handleEventCallback(appHomeOpened("U1"));

    expect(result).toMatchObject({ kind: "ignored" });
    expect(api.viewsPublishCalls).toEqual([]);
  });
});

describe("SerialQueue", () => {
  it("rejects synchronously with SerialQueueFullError once depth >= maxDepth, then admits later tasks after decrements", async () => {
    const queue = new SerialQueue(2);
    const gateA = createDeferred<void>();
    const gateB = createDeferred<void>();

    // Two blocking tasks fill the queue to its cap (depth 2).
    let aStarted = false;
    const a = queue.run(async () => {
      aStarted = true;
      await gateA.promise;
      return "a";
    });
    const b = queue.run(async () => {
      await gateB.promise;
      return "b";
    });

    // The third task is rejected synchronously (before incrementing/chaining):
    // run() returns an already-rejected promise carrying the sentinel error.
    const overCap = queue.run(async () => "c");
    await expect(overCap).rejects.toBeInstanceOf(SerialQueueFullError);

    // A is running; B is queued behind it. The rejected task never ran.
    await vi.waitFor(() => expect(aStarted).toBe(true));

    // Draining A decrements depth (back to 1), so a later task is admitted.
    gateA.resolve();
    await expect(a).resolves.toBe("a");

    let dStarted = false;
    const d = queue.run(async () => {
      dStarted = true;
      return "d";
    });
    // d was admitted (not rejected) because the decrement freed a slot. It runs
    // serially after B settles.
    gateB.resolve();
    await expect(b).resolves.toBe("b");
    await expect(d).resolves.toBe("d");
    expect(dStarted).toBe(true);
    expect(queue.idle).toBe(true);
  });
});

describe("SlackAdapter posted-message linkage", () => {
  it("aliases an in-thread reply to the producing conversation while still posting to the thread", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
      resolvePostIndex: async (channelId, ts) =>
        channelId === "D123" && ts === "171.000001" ? "scheduled-scan" : undefined,
    });

    await adapter.handleEventCallback(directMessage("that's a good idea", { ts: "171.000099", threadTs: "171.000001" }));

    // The run continues the producing conversation (so it loads that history)…
    expect(captured?.conversationId).toBe("scheduled-scan");
    expect(captured?.replyTo).toEqual({ conversationId: "slack:D123:171.000001" });
    // …but the answer still posts into the user's Slack thread.
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("D123");
    expect(post?.thread_ts).toBe("171.000001");
  });

  it("falls back to the default slack conversation id when the index has no match", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
      resolvePostIndex: async () => undefined,
    });

    await adapter.handleEventCallback(directMessage("hello", { ts: "171.000099", threadTs: "171.000001" }));

    expect(captured?.conversationId).toBe("slack:D123:171.000001");
  });

  it("does not consult the index for a top-level message (no producing post to resume)", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const resolvePostIndex = vi.fn(async () => "should-not-be-used");
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
      resolvePostIndex,
    });

    await adapter.handleEventCallback(directMessage("hello"));

    expect(resolvePostIndex).not.toHaveBeenCalled();
    expect(captured?.conversationId).toBe("slack:D123:171.000001");
  });

  it("/cancel cancels the resolved producing conversation", async () => {
    const api = new FakeSlackApi();
    const cancelCalls: string[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async () => ({ text: "ok" }),
        cancel: (conversationId: string) => {
          cancelCalls.push(conversationId);
        },
      },
      resolvePostIndex: async (channelId, ts) =>
        channelId === "D123" && ts === "171.000001" ? "scheduled-scan" : undefined,
    });

    await adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }));

    expect(cancelCalls).toEqual(["scheduled-scan"]);
  });

  it("records a top-level proactive post so a later reply can resume it; threaded posts are not recorded", async () => {
    const api = new FakeSlackApi();
    const recordCalls: Array<[string, string, string]> = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => ({ text: "brief" })),
      recordPostedMessage: (channelId, ts, conversationId) => {
        recordCalls.push([channelId, ts, conversationId]);
      },
    });

    // Top-level proactive post (no thread): the posted ts is recorded under slack:C1.
    await adapter.notify("C1", undefined, "ping");
    expect(recordCalls).toEqual([["C1", "200.000001", "slack:C1"]]);

    // A threaded proactive post already shares the thread's conversationId → not recorded.
    recordCalls.length = 0;
    await adapter.notify("C1", "171.5", "ping again");
    expect(recordCalls).toEqual([]);
  });
});

function responderFrom(respond: AgentResponder["respond"]): AgentResponder {
  return { respond };
}

function askSnapshot(): ChannelAskSnapshot {
  return {
    interactionId: "ask-test",
    message: "**Draft reply**",
    questions: [{
      id: "q0",
      header: "Delivery",
      question: "What should I do with this draft?",
      options: [
        { id: "q0o0", label: "Send", description: "Send it now." },
        { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        { id: "q0o2", label: "Revise", description: "Keep editing it." },
      ],
      multiSelect: false,
    }],
    answers: [],
    activeQuestionIndex: 0,
    status: "pending",
    createdAt: "2026-07-21T09:00:00.000Z",
    expiresAt: "2026-07-21T09:10:00.000Z",
  };
}

function slackApiFailure(slackError: string, method = "chat.postMessage"): SlackApiError {
  return new SlackApiError(`Slack rejected ${method}.`, {
    kind: "slack",
    method,
    slackError,
  });
}

function directMessage(
  text: string,
  options: {
    channel?: string;
    eventId?: string;
    ts?: string;
    threadTs?: string;
    user?: string;
    botId?: string;
    subtype?: string;
    files?: readonly Record<string, unknown>[];
  } = {},
): SlackEventCallback {
  const event: Record<string, unknown> = {
    type: "message",
    channel: options.channel ?? "D123",
    user: options.user ?? "UUSER1",
    text,
    ts: options.ts ?? "171.000001",
    event_ts: options.ts ?? "171.000001",
    channel_type: "im",
  };
  if (options.threadTs !== undefined) {
    event.thread_ts = options.threadTs;
  }
  if (options.files !== undefined) {
    event.files = options.files;
  }
  if (options.botId !== undefined) {
    event.bot_id = options.botId;
  }
  if (options.subtype !== undefined) {
    event.subtype = options.subtype;
  }
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: options.eventId ?? "Ev1",
    event_time: 171,
    event,
  };
}

function appMention(
  text: string,
  options: {
    channel?: string;
    eventId?: string;
    ts?: string;
    threadTs?: string;
    user?: string;
  } = {},
): SlackEventCallback {
  const event: Record<string, unknown> = {
    type: "app_mention",
    channel: options.channel ?? "C123",
    user: options.user ?? "UUSER1",
    text,
    ts: options.ts ?? "172.000001",
    event_ts: options.ts ?? "172.000001",
  };
  if (options.threadTs !== undefined) {
    event.thread_ts = options.threadTs;
  }
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: options.eventId ?? "Ev2",
    event_time: 172,
    event,
  };
}

function staticSelectFrom(
  message: SlackChatPostMessageParams | undefined,
  actionId: string,
): {
  readonly options: readonly {
    readonly text: { readonly text: string };
    readonly value: string;
  }[];
} {
  const blocks = message?.blocks as readonly {
    readonly elements?: readonly {
      readonly action_id?: string;
      readonly options?: readonly {
        readonly text: { readonly text: string };
        readonly value: string;
      }[];
    }[];
  }[] | undefined;
  const select = blocks
    ?.flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === actionId);
  if (select?.options === undefined) {
    throw new Error(`Missing static select ${actionId}.`);
  }
  return { options: select.options };
}

function appHomeOpened(userId: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "EvHome",
    event_time: 173,
    event: {
      type: "app_home_opened",
      user: userId,
      tab: "home",
      event_ts: "173.000001",
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

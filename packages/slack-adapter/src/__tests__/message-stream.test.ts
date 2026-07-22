import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifySlackError,
  SlackDeliveryError,
  SlackMessageStream,
} from "../message-stream.js";
import { SlackApiError } from "../slack-client.js";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatDeleteParams,
  SlackChatUpdateParams,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  readonly deleteCalls: SlackChatDeleteParams[] = [];
  readonly writeOperations: string[] = [];
  nextTs = 100;
  failPostWith: Error | undefined;
  failUpdateWith: Error | undefined;
  failDeleteWith: Error | undefined;

  async authTest() {
    return { ok: true as const };
  }

  async appsConnectionsOpen() {
    return { ok: true as const, url: "wss://slack.test/socket" };
  }

  async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
    this.postMessageCalls.push(params);
    this.writeOperations.push(`post:${params.text}`);
    if (this.failPostWith !== undefined) {
      throw this.failPostWith;
    }
    return { ok: true, channel: params.channel, ts: `${this.nextTs++}.000001` };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    this.updateCalls.push(params);
    this.writeOperations.push(`update:${params.text}`);
    if (this.failUpdateWith !== undefined) {
      throw this.failUpdateWith;
    }
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }

  async chatDelete(params: SlackChatDeleteParams) {
    this.deleteCalls.push(params);
    this.writeOperations.push(`delete:${params.ts}`);
    if (this.failDeleteWith !== undefined) {
      throw this.failDeleteWith;
    }
    return { ok: true as const, channel: params.channel, ts: params.ts };
  }

  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

function slackApiError(
  options: {
    method?: string;
    kind?: SlackApiError["kind"];
    status?: number;
    slackError?: string;
    retryAfterMs?: number;
  } = {},
): SlackApiError {
  return new SlackApiError("Slack API rejected the request.", {
    kind: options.kind ?? "slack",
    method: options.method ?? "chat.update",
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.slackError === undefined ? {} : { slackError: options.slackError }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  });
}

describe("SlackMessageStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts a status message and debounces Slack update calls", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      initialStatusText: "Starting",
      editDebounceMs: 50,
    });

    await stream.append("Hel");
    await stream.append("lo");

    // The shared substrate posts the initial status and streams interim edits as
    // plain text (mrkdwn: false); only the final answer is markdown-rendered.
    expect(api.postMessageCalls).toEqual([
      { channel: "C1", text: "Starting", thread_ts: "171.000001", mrkdwn: false },
    ]);
    expect(api.updateCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);

    expect(api.updateCalls).toEqual([
      { channel: "C1", ts: "100.000001", text: "Hello", mrkdwn: false },
    ]);
  });

  it("warns before the first silent-requested post and only once across overflow posts", async () => {
    const api = new FakeSlackApi();
    const postCountsAtWarning: number[] = [];
    const warn = vi.fn(() => {
      postCountsAtWarning.push(api.postMessageCalls.length);
    });
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      finalOnly: false,
      editDebounceMs: 10_000,
      maxMessageChars: 32,
      silent: true,
      logger: { warn },
    });

    await stream.append("draft");
    await stream.finish("a".repeat(70));

    expect(postCountsAtWarning).toEqual([0]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Slack chat.postMessage has no bot-controlled silent-delivery option; posting with normal Slack notification behavior.",
      { silentRequested: true, silentApplied: false },
    );
    expect(api.postMessageCalls.map((call) => call.text)).toEqual([
      "Thinking...",
      "a".repeat(32),
      "a".repeat(6),
    ]);
    expect(api.postMessageCalls.every((call) => !Object.hasOwn(call, "silent"))).toBe(true);
  });

  it("does not let a throwing silent-delivery warning block the Slack post", async () => {
    const api = new FakeSlackApi();
    const warn = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      finalOnly: true,
      maxSendRetries: 0,
      silent: true,
      logger: { warn },
    });

    await expect(stream.finish("delivered normally")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(api.postMessageCalls).toEqual([
      { channel: "C1", text: "delivered normally", mrkdwn: true },
    ]);
  });

  it("posts a fresh final-only Slack answer before deleting the tool ledger", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      finalOnly: true,
      editDebounceMs: 0,
    });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "WebFetch",
      arguments: { url: "https://example.test/product" },
    });
    await stream.finish("final answer");

    expect(api.postMessageCalls).toEqual([
      {
        channel: "C1",
        text: "🌐 Browsing https://example.test/product",
        thread_ts: "171.000001",
        mrkdwn: false,
      },
      {
        channel: "C1",
        text: "final answer",
        thread_ts: "171.000001",
        mrkdwn: true,
      },
    ]);
    expect(api.updateCalls).toEqual([]);
    expect(api.deleteCalls).toEqual([{ channel: "C1", ts: "100.000001" }]);
    expect(api.writeOperations).toEqual([
      "post:🌐 Browsing https://example.test/product",
      "post:final answer",
      "delete:100.000001",
    ]);
  });

  it("moves the Slack tool ledger behind an applied live follow-up, then keeps final delivery fresh", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      finalOnly: true,
      editDebounceMs: 0,
    });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "Read",
      arguments: { path: "/repo/a.ts" },
    });
    await stream.event({
      type: "tool_call_started",
      id: "live-input:follow-up-1",
      name: "↪️ Steered: “Use the API instead”",
      metadata: { liveInput: true, synthetic: true },
    });
    await stream.finish("final answer");

    expect(api.writeOperations).toEqual([
      "post:📖 Reading /repo/a.ts",
      "delete:100.000001",
      "post:📖 Reading /repo/a.ts\n↪️ Steered: “Use the API instead”",
      "post:final answer",
      "delete:101.000001",
    ]);
    expect(api.updateCalls).toEqual([]);
  });

  it("keeps a confirmed fresh final when transient-ledger deletion fails", async () => {
    const api = new FakeSlackApi();
    const debug = vi.fn();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      finalOnly: true,
      editDebounceMs: 0,
      logger: { debug },
    });

    await stream.event({ type: "tool_call_started", id: "t1", name: "Read", arguments: { path: "/repo/a.ts" } });
    api.failDeleteWith = new Error("delete unavailable");

    await expect(stream.finish("final answer")).resolves.toBeUndefined();

    expect(api.postMessageCalls.map((call) => call.text)).toEqual([
      "📖 Reading /repo/a.ts",
      "final answer",
    ]);
    expect(api.updateCalls).toEqual([]);
    expect(api.deleteCalls).toEqual([{ channel: "C1", ts: "100.000001" }]);
    expect(debug).toHaveBeenCalledWith(
      "Slack transient progress deletion failed after final delivery (ignored).",
      { error: "delete unavailable" },
    );
  });

  it("deletes a transient Slack tool ledger on dismissal", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({ api, channelId: "C1", finalOnly: true });

    await stream.event({ type: "tool_call_started", id: "t1", name: "Read", arguments: { path: "/repo/a.ts" } });
    await stream.dismissTransient();

    expect(api.deleteCalls).toEqual([{ channel: "C1", ts: "100.000001" }]);
  });

  it.each([
    ["omitted", undefined],
    ["false", false],
  ] as const)("does not warn when silent is %s", async (_label, silent) => {
    const api = new FakeSlackApi();
    const warn = vi.fn();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      finalOnly: true,
      ...(silent === undefined ? {} : { silent }),
      logger: { warn },
    });

    await stream.finish("normal delivery");

    expect(warn).not.toHaveBeenCalled();
    expect(api.postMessageCalls).toEqual([
      { channel: "C1", text: "normal delivery", mrkdwn: true },
    ]);
  });

  it("notifies onPosted with the channel and ts of each posted message", async () => {
    const api = new FakeSlackApi(); // nextTs = 100 → first post "100.000001"
    const posted: Array<{ ts: string; channel: string }> = [];
    const stream = new SlackMessageStream({
      api,
      channelId: "C9",
      editDebounceMs: 0,
      onPosted: (ref) => {
        posted.push(ref);
      },
    });

    await stream.finish("the answer");

    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((ref) => ref.channel === "C9")).toBe(true);
    expect(posted[0]?.ts).toBe("100.000001");
  });

  it("labels confirmed status and answer writes separately", async () => {
    const api = new FakeSlackApi();
    const receipts: Array<{ contentKind: string; operation: string; ts: string }> = [];
    const stream = new SlackMessageStream({
      api,
      channelId: "C9",
      finalOnly: false,
      editDebounceMs: 0,
      onDeliveryReceipt: (receipt) => {
        receipts.push({
          contentKind: receipt.contentKind,
          operation: receipt.operation,
          ts: receipt.ts,
        });
      },
    });

    await stream.status("Still working");
    await stream.finish("the answer");

    expect(receipts).toEqual([
      { contentKind: "status", operation: "post", ts: "100.000001" },
      { contentKind: "answer", operation: "edit", ts: "100.000001" },
    ]);
  });

  it("does not retry a confirmed Slack post when its observer fails", async () => {
    const api = new FakeSlackApi();
    const warn = vi.fn();
    const stream = new SlackMessageStream({
      api,
      channelId: "C9",
      finalOnly: true,
      onPosted: () => { throw new Error("posted-message index unavailable"); },
      logger: { warn },
    });

    await expect(stream.finish("confirmed once")).resolves.toBeUndefined();

    expect(api.postMessageCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "Slack post observer failed after confirmed delivery.",
      { reason: "posted-message index unavailable" },
    );
  });

  it("keeps a default final-only Slack reply above the shared 3,800-char default in one message", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      finalOnly: true,
    });
    const finalText = "a".repeat(3_901);

    await stream.finish(finalText);

    expect(api.updateCalls).toHaveLength(0);
    expect(api.postMessageCalls.map((call) => call.text)).toEqual([finalText]);
  });

  it("splits default final-only Slack replies only at Slack's 40,000-char platform limit", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "172.000001",
      finalOnly: true,
      clientMsgId: "5d465a3c-f7f3-4ac3-9eb6-9afc290211fa",
    });
    const finalText = `${"a".repeat(40_000)}tail`;

    await stream.finish(finalText);

    expect(api.updateCalls).toHaveLength(0);
    expect(api.postMessageCalls.map((call) => call.text.length)).toEqual([40_000, 4]);
    expect(api.postMessageCalls.every((call) => call.thread_ts === "172.000001")).toBe(true);
    const firstIds = api.postMessageCalls.map((call) => call.client_msg_id);
    expect(firstIds).toHaveLength(2);
    expect(firstIds[0]).toMatch(/^[a-f0-9-]{36}$/u);
    expect(firstIds[1]).toMatch(/^[a-f0-9-]{36}$/u);
    expect(firstIds[1]).not.toBe(firstIds[0]);

    const retriedApi = new FakeSlackApi();
    const retriedStream = new SlackMessageStream({
      api: retriedApi,
      channelId: "C1",
      threadTs: "172.000001",
      finalOnly: true,
      clientMsgId: "5d465a3c-f7f3-4ac3-9eb6-9afc290211fa",
    });
    await retriedStream.finish(finalText);
    expect(retriedApi.postMessageCalls.map((call) => call.client_msg_id)).toEqual(firstIds);
  });

  it("reuses the logical post client_msg_id and warns once when Slack retries before returning a receipt", async () => {
    const postCalls: SlackChatPostMessageParams[] = [];
    const postCountsAtWarning: number[] = [];
    const warn = vi.fn(() => {
      postCountsAtWarning.push(postCalls.length);
    });
    let attempt = 0;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        attempt += 1;
        if (attempt === 1) {
          throw slackApiError({ kind: "network", method: "chat.postMessage" });
        }
        return { ok: true as const, channel: params.channel, ts: "173.000001" };
      },
      async chatUpdate(params) {
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      finalOnly: true,
      clientMsgId: "5d465a3c-f7f3-4ac3-9eb6-9afc290211fa",
      maxSendRetries: 1,
      retryBaseDelayMs: 0,
      silent: true,
      logger: { warn },
    });

    await expect(stream.finish("durable answer")).resolves.toBeUndefined();

    expect(postCalls).toHaveLength(2);
    expect(postCalls[0]?.client_msg_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(postCalls[1]?.client_msg_id).toBe(postCalls[0]?.client_msg_id);
    expect(postCountsAtWarning).toEqual([0]);
    expect(warn).toHaveBeenCalledOnce();
    expect(postCalls.every((call) => !Object.hasOwn(call, "silent"))).toBe(true);
  });

  it("flushes final output and sends overflow chunks as thread replies (no labels)", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "D1",
      threadTs: "172.000001",
      editDebounceMs: 10_000,
      maxMessageChars: 32,
    });
    const finalText = "a".repeat(70);

    await stream.append("draft");
    await stream.finish(finalText);

    expect(api.updateCalls).toHaveLength(1);
    expect(api.updateCalls[0]?.text).toHaveLength(32);
    expect(api.postMessageCalls).toHaveLength(3);
    // Initial status post is plain (mrkdwn: false) under the shared substrate.
    expect(api.postMessageCalls[0]).toEqual({
      channel: "D1",
      text: "Thinking...",
      thread_ts: "172.000001",
      mrkdwn: false,
    });
    // The first final chunk edits the placeholder in place; overflow
    // continuation chunks are posted as plain (mrkdwn: false) thread replies.
    expect(api.postMessageCalls[1]?.text).toHaveLength(32);
    expect(api.postMessageCalls[1]?.thread_ts).toBe("172.000001");
    expect(api.postMessageCalls[1]?.mrkdwn).toBe(false);
    expect(api.postMessageCalls[2]?.text).toHaveLength(6);
    expect(api.postMessageCalls[2]?.mrkdwn).toBe(false);
  });

  it("translates Markdown output to Slack mrkdwn for posts and updates", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      editDebounceMs: 0,
    });

    await stream.status("Working on **the fix**");
    await stream.append("## Result\n\n**Done** [details](https://example.com?a=1&b=2)");
    await vi.runAllTimersAsync();
    await stream.finish("__Final__ ~~ready~~");

    // The status post and interim edit stream as plain text under the shared
    // substrate; only the final answer is translated to Slack mrkdwn.
    expect(api.postMessageCalls[0]).toEqual({
      channel: "C1",
      text: "Working on **the fix**",
      thread_ts: "171.000001",
      mrkdwn: false,
    });
    expect(api.updateCalls).toEqual([
      {
        channel: "C1",
        ts: "100.000001",
        text: "## Result\n\n**Done** [details](https://example.com?a=1&b=2)",
        mrkdwn: false,
      },
      {
        channel: "C1",
        ts: "100.000001",
        text: "*Final* ~ready~",
        mrkdwn: true,
      },
    ]);
  });

  it("uses a bounded preview for long in-progress content", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      editDebounceMs: 0,
      maxMessageChars: 32,
    });

    await stream.append("x".repeat(60));
    await vi.runAllTimersAsync();

    expect(api.updateCalls[0]?.text).toHaveLength(32);
    // The shared substrate marks a truncated in-progress preview with an ellipsis.
    expect(api.updateCalls[0]?.text.startsWith("…\n")).toBe(true);
  });

  it("does not surface an interim update failure to the caller", async () => {
    const api = new FakeSlackApi();
    api.failUpdateWith = new Error("update failed");
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
    });

    // Interim edits are best-effort; a failed update never throws back into the
    // stream consumer.
    await expect(stream.append("hello")).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(api.updateCalls.length).toBeGreaterThan(0);
  });

  it("still rejects append when the initial placeholder post fails", async () => {
    const api = new FakeSlackApi();
    api.failPostWith = new Error("post failed");

    await expect(
      new SlackMessageStream({ api, channelId: "C1" }).append("hello"),
    ).rejects.toThrow("post failed");
  });

  it("recreates a vanished message target by posting a fresh message", async () => {
    const postCalls: SlackChatPostMessageParams[] = [];
    const updateFailures = [slackApiError({ slackError: "message_not_found" })];
    let nextTs = 200;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        return { ok: true as const, channel: params.channel, ts: `${nextTs++}.000001` };
      },
      async chatUpdate(params) {
        const failure = updateFailures.shift();
        if (failure !== undefined) {
          throw failure;
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C7", editDebounceMs: 0 });
    await expect(stream.finish("recovered answer")).resolves.toBeUndefined();

    expect(postCalls.map((call) => call.text)).toEqual([
      "Thinking...",
      "recovered answer",
    ]);
  });

  it("waits for retry-after then retries a rate-limited final update", async () => {
    let updateCalls = 0;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        return { ok: true as const, channel: params.channel, ts: "400.000001" };
      },
      async chatUpdate(params) {
        updateCalls += 1;
        if (updateCalls === 1) {
          throw slackApiError({ slackError: "ratelimited", status: 429, retryAfterMs: 2000 });
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C1", editDebounceMs: 0 });
    const finished = stream.finish("rate limited answer");
    await vi.advanceTimersByTimeAsync(2000);

    await expect(finished).resolves.toBeUndefined();
    expect(updateCalls).toBe(2);
  });

  it("swallows a rate-limited interim update without waiting or failing", async () => {
    let updateCalls = 0;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        return { ok: true as const, channel: params.channel, ts: "500.000001" };
      },
      async chatUpdate(params) {
        updateCalls += 1;
        if (updateCalls === 1) {
          throw slackApiError({ slackError: "ratelimited", status: 429, retryAfterMs: 5000 });
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C1", editDebounceMs: 0 });
    await stream.append("partial");
    await expect(stream.finish("done")).resolves.toBeUndefined();
    expect(updateCalls).toBe(2);
  });

  it("retries the final update with mrkdwn disabled when Slack rejects the markup", async () => {
    const updateParams: SlackChatUpdateParams[] = [];
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        return { ok: true as const, channel: params.channel, ts: "600.000001" };
      },
      async chatUpdate(params) {
        updateParams.push(params);
        if (params.mrkdwn !== false) {
          throw slackApiError({ slackError: "invalid_blocks" });
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C1", editDebounceMs: 0 });
    await expect(stream.finish("**bold** answer")).resolves.toBeUndefined();

    expect(updateParams).toHaveLength(2);
    expect(updateParams[0]?.mrkdwn).toBe(true);
    expect(updateParams[1]?.mrkdwn).toBe(false);
  });

  it("falls back to a fresh post when the final update cannot be edited or recreated", async () => {
    const postCalls: SlackChatPostMessageParams[] = [];
    let nextTs = 700;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        return { ok: true as const, channel: params.channel, ts: `${nextTs++}.000001` };
      },
      async chatUpdate() {
        // Persistent transient failure on every edit; recreate not signalled, so
        // the stream must last-resort a fresh post to deliver the answer.
        throw slackApiError({ kind: "network", method: "chat.update" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      maxSendRetries: 1,
      retryBaseDelayMs: 0,
    });
    const finished = stream.finish("last resort answer");
    await vi.runAllTimersAsync();
    await expect(finished).resolves.toBeUndefined();

    expect(postCalls.map((call) => call.text)).toEqual([
      "Thinking...",
      "last resort answer",
    ]);
  });

  it("throws SlackDeliveryError when even the last-resort post fails", async () => {
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        if (params.text === "Thinking...") {
          return { ok: true as const, channel: params.channel, ts: "800.000001" };
        }
        throw slackApiError({ kind: "network", method: "chat.postMessage" });
      },
      async chatUpdate() {
        throw slackApiError({ kind: "network", method: "chat.update" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      maxSendRetries: 0,
    });
    await expect(stream.finish("doomed answer")).rejects.toBeInstanceOf(SlackDeliveryError);
  });

  it("does not post a fresh message with the answer once aborted", async () => {
    const controller = new AbortController();
    const postCalls: SlackChatPostMessageParams[] = [];
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        return { ok: true as const, channel: params.channel, ts: "950.000001" };
      },
      async chatUpdate() {
        // Edit target is gone — without the abort guard this would recreate or
        // last-resort a brand-new message carrying the now-unwanted answer.
        throw slackApiError({ slackError: "message_not_found" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      abortSignal: controller.signal,
    });
    controller.abort(new Error("cancelled by user"));

    await expect(stream.finish("unwanted answer")).resolves.toBeUndefined();
    expect(postCalls.map((call) => call.text)).toEqual(["Thinking..."]);
  });

  it("shows a friendly activity hint on tool_call_started while no answer text yet", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      initialStatusText: "Thinking...",
      editDebounceMs: 0,
    });

    await stream.status("Thinking...");
    await stream.event({ type: "tool_call_started", id: "t1", name: "WebSearch" });
    await vi.runAllTimersAsync();

    expect(api.updateCalls.at(-1)?.text).toBe("Searching the web…");
  });

  it("does not render assistant_thought reasoning as message text", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      initialStatusText: "Thinking...",
      editDebounceMs: 0,
    });

    await stream.status("Thinking...");
    await stream.event({ type: "assistant_thought", text: "secret private reasoning" });
    await stream.append("answer");
    await stream.finish("answer");

    const allText = [
      ...api.postMessageCalls.map((call) => call.text),
      ...api.updateCalls.map((call) => call.text),
    ];
    expect(allText.some((text) => text.includes("secret private reasoning"))).toBe(false);
    expect(api.updateCalls.at(-1)?.text).toBe("answer");
  });

  it("delegates to the shared substrate: renders final markdown via the Slack transport and preserves thread_ts", async () => {
    // Equivalence probe for the thin-wrapper refactor: the wrapper builds a
    // ChannelTransport (post -> chatPostMessage, edit -> chatUpdate,
    // renderMarkdown -> formatMarkdownForSlack, thread_ts preserved) and lets the
    // shared ResilientMessageStream drive delivery.
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C42",
      threadTs: "999.000001",
      editDebounceMs: 0,
    });

    await stream.append("draft");
    await vi.runAllTimersAsync();
    await stream.finish("**bold** done");

    // Initial post + every edit carry the thread_ts through the transport.
    expect(api.postMessageCalls[0]?.thread_ts).toBe("999.000001");
    expect(api.updateCalls.every((call) => call.ts === "100.000001")).toBe(true);
    // The final answer is markdown-rendered (mrkdwn: true) by the transport.
    expect(api.updateCalls.at(-1)).toEqual({
      channel: "C42",
      ts: "100.000001",
      text: "*bold* done",
      mrkdwn: true,
    });
  });

  it("normalizes a substrate ChannelDeliveryError into a SlackDeliveryError", async () => {
    // The placeholder post succeeds, but every edit and the last-resort fresh
    // post fail with a transient error. The substrate raises a
    // ChannelDeliveryError, which the wrapper must surface as a SlackDeliveryError.
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async downloadFile() {
        return new Uint8Array();
      },
      async chatPostMessage(params) {
        if (params.text === "Thinking...") {
          return { ok: true as const, channel: params.channel, ts: "900.000001" };
        }
        throw slackApiError({ kind: "network", method: "chat.postMessage" });
      },
      async chatUpdate() {
        throw slackApiError({ kind: "network", method: "chat.update" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      maxSendRetries: 0,
    });

    await expect(stream.finish("doomed")).rejects.toBeInstanceOf(SlackDeliveryError);
  });

  it("stops refreshing the hint once answer text streams in", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      initialStatusText: "Thinking...",
      editDebounceMs: 0,
    });

    await stream.status("Thinking...");
    await stream.append("partial answer");
    await stream.event({ type: "tool_call_started", id: "t2", name: "WebSearch" });
    await vi.runAllTimersAsync();

    // After answer text exists, a tool-start hint must not overwrite it.
    expect(api.updateCalls.at(-1)?.text).toBe("partial answer");
  });
});

describe("classifySlackError", () => {
  it("classifies ratelimited / 429 as retry with the honored retry-after", () => {
    expect(
      classifySlackError(slackApiError({ slackError: "ratelimited", status: 429, retryAfterMs: 3000 })),
    ).toEqual({ kind: "retry", retryAfterMs: 3000, failureCertainty: "not_delivered" });
    expect(classifySlackError(slackApiError({ status: 429 }))).toEqual({
      kind: "retry",
      failureCertainty: "not_delivered",
    });
  });

  it("classifies missing/non-editable messages as recreate", () => {
    expect(classifySlackError(slackApiError({ slackError: "message_not_found" }))).toEqual({
      kind: "recreate",
      failureCertainty: "not_delivered",
    });
    expect(classifySlackError(slackApiError({ slackError: "cant_update_message" }))).toEqual({
      kind: "recreate",
      failureCertainty: "not_delivered",
    });
    expect(classifySlackError(slackApiError({ slackError: "edit_window_closed" }))).toEqual({
      kind: "recreate",
      failureCertainty: "not_delivered",
    });
  });

  it("classifies markup errors as reformat-plain", () => {
    expect(classifySlackError(slackApiError({ slackError: "invalid_blocks" }))).toEqual({
      kind: "reformat_plain",
      failureCertainty: "not_delivered",
    });
  });

  it("classifies network/5xx/aborted appropriately", () => {
    expect(classifySlackError(slackApiError({ kind: "network" }))).toEqual({
      kind: "retry",
      failureCertainty: "unknown",
    });
    expect(classifySlackError(slackApiError({ kind: "http", status: 503 }))).toEqual({
      kind: "retry",
      failureCertainty: "unknown",
    });
    expect(classifySlackError(slackApiError({ kind: "aborted" }))).toEqual({
      kind: "fatal",
      failureCertainty: "unknown",
    });
    expect(classifySlackError(slackApiError({ slackError: "channel_not_found" }))).toEqual({
      kind: "fatal",
      failureCertainty: "not_delivered",
    });
  });

  it("retries unknown non-SlackApiError failures conservatively", () => {
    expect(classifySlackError(new Error("boom"))).toEqual({
      kind: "retry",
      failureCertainty: "unknown",
    });
  });

  it("does not invoke Proxy prototype traps while classifying unknown failures", () => {
    const descriptorHook = vi.fn(() => { throw new Error("hostile descriptor hook"); });
    const prototypeHook = vi.fn(() => { throw new Error("hostile prototype hook"); });
    const proxyPrototype = new Proxy({}, {
      getOwnPropertyDescriptor: descriptorHook,
      getPrototypeOf: prototypeHook,
    });

    expect(classifySlackError(Object.create(proxyPrototype))).toEqual({
      kind: "retry",
      failureCertainty: "unknown",
    });
    expect(descriptorHook).not.toHaveBeenCalled();
    expect(prototypeHook).not.toHaveBeenCalled();
  });
});

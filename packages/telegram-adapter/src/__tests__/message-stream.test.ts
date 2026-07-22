import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  splitTelegramText,
  TelegramDeliveryError,
  TelegramMessageStream,
} from "../message-stream.js";
import { TelegramApiError } from "../telegram-error.js";
import type {
  TelegramBotApi,
  TelegramDeleteMessageParams,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
} from "../types.js";

class FakeTelegramApi implements TelegramBotApi {
  readonly sendMessageCalls: TelegramSendMessageParams[] = [];
  readonly editMessageTextCalls: TelegramEditMessageTextParams[] = [];
  readonly deleteMessageCalls: TelegramDeleteMessageParams[] = [];
  readonly writeOperations: string[] = [];
  nextMessageId = 100;
  failSendWith: Error | undefined;
  failEditWith: Error | undefined;
  failDeleteWith: Error | undefined;

  async sendMessage(
    params: TelegramSendMessageParams,
  ): Promise<TelegramSentMessage> {
    this.sendMessageCalls.push(params);
    this.writeOperations.push(`send:${params.text}`);
    if (this.failSendWith !== undefined) {
      throw this.failSendWith;
    }

    return {
      message_id: this.nextMessageId++,
      chat: { id: params.chat_id },
      text: params.text,
    };
  }

  async editMessageText(
    params: TelegramEditMessageTextParams,
  ): Promise<TelegramSentMessage | true> {
    this.editMessageTextCalls.push(params);
    this.writeOperations.push(`edit:${params.text}`);
    if (this.failEditWith !== undefined) {
      throw this.failEditWith;
    }

    return {
      message_id: params.message_id ?? 0,
      chat: { id: params.chat_id ?? 0 },
      text: params.text,
    };
  }

  async deleteMessage(params: TelegramDeleteMessageParams): Promise<true> {
    this.deleteMessageCalls.push(params);
    this.writeOperations.push(`delete:${params.message_id}`);
    if (this.failDeleteWith !== undefined) {
      throw this.failDeleteWith;
    }
    return true;
  }

  async getUpdates(_params: TelegramGetUpdatesParams): Promise<TelegramUpdate[]> {
    return [];
  }
}

describe("TelegramMessageStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a placeholder and debounces Telegram edit updates", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      initialStatusText: "Starting…",
      editDebounceMs: 50,
    });

    await stream.append("Hel");
    await stream.append("lo");

    expect(api.sendMessageCalls).toEqual([{ chat_id: 42, text: "Starting…" }]);
    expect(api.editMessageTextCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(49);
    expect(api.editMessageTextCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 42, message_id: 100, text: "Hello" },
    ]);
  });

  it("flushes final output immediately and cancels pending edits", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: "chat-a",
      editDebounceMs: 10_000,
    });

    await stream.append("draft");
    await stream.finish("final answer");

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: "chat-a", message_id: 100, text: "final answer", parse_mode: "MarkdownV2" },
    ]);
    await vi.runOnlyPendingTimersAsync();
    expect(api.editMessageTextCalls).toHaveLength(1);
  });

  it("posts a final-only answer separately and deletes the transient tool ledger", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
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

    expect(api.sendMessageCalls).toEqual([
      {
        chat_id: 42,
        text: "🌐 Browsing https://example.test/product",
      },
      {
        chat_id: 42,
        text: "final answer",
        parse_mode: "MarkdownV2",
      },
    ]);
    expect(api.editMessageTextCalls).toEqual([]);
    expect(api.deleteMessageCalls).toEqual([{ chat_id: 42, message_id: 100 }]);
  });

  it("moves the Telegram tool ledger behind an applied live follow-up, then keeps final delivery fresh", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
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
      "send:📖 Reading /repo/a.ts",
      "delete:100",
      "send:📖 Reading /repo/a.ts\n↪️ Steered: “Use the API instead”",
      "send:final answer",
      "delete:101",
    ]);
    expect(api.editMessageTextCalls).toEqual([]);
  });

  it("keeps a separate final answer deliverable when its reply parent was removed", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      replyToMessageId: 9,
      finalOnly: true,
      editDebounceMs: 0,
      formatMarkdown: false,
    });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "Read",
      arguments: { path: "/repo/a.ts" },
    });
    await stream.finish("final answer", { format: false });

    expect(api.sendMessageCalls).toEqual([
      {
        chat_id: 42,
        text: "📖 Reading /repo/a.ts",
        reply_to_message_id: 9,
      },
      {
        chat_id: 42,
        text: "final answer",
        reply_to_message_id: 9,
        allow_sending_without_reply: true,
      },
    ]);
    expect(api.deleteMessageCalls).toEqual([{ chat_id: 42, message_id: 100 }]);
  });

  it("posts an identical final answer separately when it matches the transient tool ledger", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      finalOnly: true,
      editDebounceMs: 0,
      formatMarkdown: false,
    });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "Bash",
      arguments: { command: "echo hello" },
    });
    const progress = api.sendMessageCalls[0]?.text as string;
    await stream.finish(progress, { format: false });

    expect(api.sendMessageCalls.map((call) => call.text)).toEqual([progress, progress]);
    expect(api.editMessageTextCalls).toEqual([]);
    expect(api.deleteMessageCalls).toEqual([{ chat_id: 42, message_id: 100 }]);
  });

  it("does not duplicate a final-only answer when progress deletion fails", async () => {
    const api = new FakeTelegramApi();
    const debug = vi.fn();
    api.failDeleteWith = new Error("delete unavailable");
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      finalOnly: true,
      editDebounceMs: 0,
      logger: { debug },
    });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "Read",
      arguments: { path: "/repo/a.ts" },
    });
    await expect(stream.finish("final answer")).resolves.toBeUndefined();

    expect(api.sendMessageCalls.map((call) => call.text)).toEqual([
      "📖 Reading /repo/a.ts",
      "final answer",
    ]);
    expect(api.deleteMessageCalls).toEqual([{ chat_id: 42, message_id: 100 }]);
    expect(debug).toHaveBeenCalledWith(
      "Telegram transient progress deletion failed after final delivery (ignored).",
      { error: "delete unavailable" },
    );
  });

  it("deletes a transient Telegram tool ledger on dismissal", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({ api, chatId: 42, finalOnly: true });

    await stream.event({ type: "tool_call_started", id: "t1", name: "Read", arguments: { path: "/repo/a.ts" } });
    await stream.dismissTransient();

    expect(api.deleteMessageCalls).toEqual([{ chat_id: 42, message_id: 100 }]);
  });

  it("never renders assistant reasoning as message text", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      initialStatusText: "Working...",
      editDebounceMs: 0,
    });

    await stream.status("Working...");
    await stream.event({ type: "assistant_thought", text: "private reasoning" });
    await stream.finish("final answer");

    // Reasoning prose is never shown: the placeholder stays put until the final
    // answer replaces it, and no edit ever carries the reasoning text.
    expect(api.sendMessageCalls).toEqual([{ chat_id: 42, text: "Working..." }]);
    expect(api.editMessageTextCalls.map((call) => call.text)).toEqual([
      "final answer",
    ]);
    expect(
      api.editMessageTextCalls.some((call) => call.text.includes("private reasoning")),
    ).toBe(false);
  });

  it("shows a friendly activity hint on tool_call_started, then is replaced by the answer", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      initialStatusText: "Thinking…",
      editDebounceMs: 0,
    });

    // The channel establishes the placeholder first (as the bot does), then a
    // tool starting before any answer text refreshes it with the shared friendly
    // hint (never the raw tool name).
    await stream.status("Thinking…");
    await stream.event({ type: "tool_call_started", id: "t1", name: "WebSearch" });
    expect(api.editMessageTextCalls.map((call) => call.text)).toEqual(["Searching the web…"]);
    expect(api.editMessageTextCalls.some((call) => call.text.includes("WebSearch"))).toBe(false);

    // Once the answer starts streaming, the hint is superseded by the answer text.
    await stream.append("here is the answer");
    expect(api.editMessageTextCalls.at(-1)?.text).toBe("here is the answer");

    // A later tool start does NOT clobber the streamed answer with a hint.
    await stream.event({ type: "tool_call_started", id: "t2", name: "Bash" });
    expect(api.editMessageTextCalls.at(-1)?.text).toBe("here is the answer");
    expect(api.editMessageTextCalls.some((call) => call.text === "Running a command…")).toBe(false);
  });

  it("does not show activity hints when showHints is disabled", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      initialStatusText: "Thinking…",
      editDebounceMs: 0,
      showHints: false,
    });

    await stream.event({ type: "tool_call_started", id: "t1", name: "WebSearch" });

    expect(api.editMessageTextCalls).toHaveLength(0);
  });

  it("re-renders the streamed answer as MarkdownV2 on the final edit", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      editDebounceMs: 0,
    });

    await stream.append("final answer");
    await stream.finish("final answer");

    // The interim edit streams plain text; the final edit re-applies MarkdownV2
    // (the formatting that interim streaming intentionally skips).
    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 42, message_id: 100, text: "final answer" },
      { chat_id: 42, message_id: 100, text: "final answer", parse_mode: "MarkdownV2" },
    ]);
  });

  it("preserves an already-streamed answer when finish receives no final text", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      editDebounceMs: 0,
    });

    await stream.append("streamed answer");
    await stream.finish();

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 42, message_id: 100, text: "streamed answer" },
      { chat_id: 42, message_id: 100, text: "streamed answer", parse_mode: "MarkdownV2" },
    ]);
  });

  it("replaces a hint-only run with an explicit final placeholder", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      editDebounceMs: 0,
    });

    await stream.status("Thinking…");
    await stream.event({ type: "tool_call_started", id: "t1", name: "todoist" });
    await stream.finish();

    expect(api.editMessageTextCalls.map((call) => call.text)).toEqual([
      "Checking your tasks…",
      "No response text was returned\\.",
    ]);
    expect(api.editMessageTextCalls.at(-1)?.parse_mode).toBe("MarkdownV2");
  });

  it("does not render any message text for assistant_thought reasoning", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 42,
      editDebounceMs: 0,
    });

    await stream.event({ type: "assistant_thought", text: "Still checking" });

    expect(api.sendMessageCalls).toHaveLength(0);
    expect(api.editMessageTextCalls).toHaveLength(0);
  });

  it("splits final output into Telegram-sized message chunks", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 99,
      editDebounceMs: 0,
      maxMessageChars: 32,
    });
    const finalText = "a".repeat(70);

    await stream.finish(finalText);

    const expectedChunks = splitTelegramText(finalText, 32);
    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 99, message_id: 100, text: expectedChunks[0], parse_mode: "MarkdownV2" },
    ]);
    expect(api.sendMessageCalls[0]).toEqual({ chat_id: 99, text: "Thinking…" });
    expect(api.sendMessageCalls.slice(1)).toEqual(
      expectedChunks.slice(1).map((text) => ({ chat_id: 99, text })),
    );
  });

  it("uses a bounded preview for long in-progress content", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 1,
      editDebounceMs: 0,
      maxMessageChars: 32,
    });

    await stream.append("x".repeat(60));
    await vi.runAllTimersAsync();

    expect(api.editMessageTextCalls[0]?.text).toHaveLength(32);
    expect(api.editMessageTextCalls[0]?.text.startsWith("…\n")).toBe(true);
  });

  it("shows the empty-content placeholder for a blank interim status update", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 7,
      initialStatusText: "Working…",
      editDebounceMs: 0,
    });

    // Establish the message, then push a whitespace-only status update. The shared
    // resilience substrate surfaces the empty-content placeholder rather than an
    // empty bubble, so a blank interim status never renders as nothing.
    await stream.status("first");
    await stream.status("   \n");

    const lastEdit = api.editMessageTextCalls.at(-1);
    expect(lastEdit?.text).toBe("No response text was returned.");
  });

  it("substitutes the placeholder only when finishing with empty content", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({ api, chatId: 8, editDebounceMs: 0 });

    await stream.finish("   ");

    // The empty-content placeholder is rendered through MarkdownV2 like any final
    // answer, so its trailing "." is escaped (it still displays as a period).
    expect(api.editMessageTextCalls).toEqual([
      {
        chat_id: 8,
        message_id: 100,
        text: "No response text was returned\\.",
        parse_mode: "MarkdownV2",
      },
    ]);
  });

  it("delivers the final message as plain text when formatting is disabled", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({ api, chatId: 5, editDebounceMs: 0 });

    // Terminal/system copy (e.g. "Cancelled.") is fixed text, not model markdown,
    // so the adapter finishes it with formatting disabled — no MarkdownV2 escaping.
    await stream.finish("Cancelled.", { format: false });

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 5, message_id: 100, text: "Cancelled." },
    ]);
  });

  it("keeps parse_mode for markdown telegramify leaves byte-identical (inline code)", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({ api, chatId: 9, editDebounceMs: 0 });

    // telegramify renders an inline code span back to the same bytes; without
    // parse_mode Telegram would show the literal backticks, so it must still be
    // sent as MarkdownV2 (a string-equality "is it plain?" check is unsafe).
    await stream.finish("Run `npm i` now");

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 9, message_id: 100, text: "Run `npm i` now", parse_mode: "MarkdownV2" },
    ]);
  });

  it("falls back to plain text when MarkdownV2 escaping overflows the size limit", async () => {
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 3,
      editDebounceMs: 0,
      maxMessageChars: 50,
    });

    // 30 dots fit the limit, but MarkdownV2 escapes each "." to "\." (60 chars),
    // overflowing it. The plain source is within the limit, so deliver it plain
    // rather than fail with "message is too long".
    const dots = ".".repeat(30);
    await stream.finish(dots);

    const call = api.editMessageTextCalls.at(-1);
    expect(call?.parse_mode).toBeUndefined();
    expect(call?.text).toBe(dots);
  });

  it("still rejects append when the initial placeholder send fails", async () => {
    const api = new FakeTelegramApi();
    api.failSendWith = new Error("send failed");

    await expect(
      new TelegramMessageStream({ api, chatId: 1 }).append("hello"),
    ).rejects.toThrow("send failed");
  });

  it("normalizes a substrate final-delivery failure to TelegramDeliveryError", async () => {
    // Every send fails, so finish() exhausts the retry path and the last-resort
    // fresh send: the substrate raises the shared ChannelDeliveryError, which the
    // wrapper must re-throw as the Telegram type (the base type must not escape).
    const api = new FakeTelegramApi();
    api.failSendWith = new Error("send failed");

    const stream = new TelegramMessageStream({
      api,
      chatId: 9,
      editDebounceMs: 0,
      maxSendRetries: 0,
      retryBaseDelayMs: 0,
    });

    const error = await stream.finish("final answer").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TelegramDeliveryError);
    expect((error as TelegramDeliveryError).name).toBe("TelegramDeliveryError");
    expect((error as TelegramDeliveryError).attempts).toBeGreaterThanOrEqual(1);
    expect((error as TelegramDeliveryError).cause).toBeDefined();
  });

  it("recovers a vanished edit target by sending a fresh message", async () => {
    const sendCalls: TelegramSendMessageParams[] = [];
    const editFailures = [
      telegramApiError("Bad Request: message to edit not found"),
    ];
    let nextId = 200;
    const api: TelegramBotApi = {
      async sendMessage(params) {
        sendCalls.push(params);
        return { message_id: nextId++, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        const failure = editFailures.shift();
        if (failure !== undefined) {
          throw failure;
        }
        return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
    };

    const stream = new TelegramMessageStream({ api, chatId: 7, editDebounceMs: 0 });
    await expect(stream.finish("recovered answer")).resolves.toBeUndefined();

    expect(sendCalls.map((call) => call.text)).toEqual([
      "Thinking…",
      "recovered answer",
    ]);
  });

  it("treats 'message is not modified' on the final edit as a success", async () => {
    let editCalls = 0;
    const api: TelegramBotApi = {
      async sendMessage(params) {
        return { message_id: 300, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText() {
        editCalls += 1;
        throw telegramApiError("Bad Request: message is not modified");
      },
      async getUpdates() {
        return [];
      },
    };

    const stream = new TelegramMessageStream({ api, chatId: 1, editDebounceMs: 0 });
    await expect(stream.finish("answer")).resolves.toBeUndefined();
    expect(editCalls).toBe(1);
  });

  it("waits for retry_after then retries a rate-limited final edit", async () => {
    let editCalls = 0;
    const api: TelegramBotApi = {
      async sendMessage(params) {
        return { message_id: 400, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        editCalls += 1;
        if (editCalls === 1) {
          throw telegramApiError("Too Many Requests: retry after 2", {
            errorCode: 429,
            retryAfterMs: 2000,
          });
        }
        return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
    };

    const stream = new TelegramMessageStream({ api, chatId: 1, editDebounceMs: 0 });
    const finished = stream.finish("rate limited answer");
    await vi.advanceTimersByTimeAsync(2000);

    await expect(finished).resolves.toBeUndefined();
    expect(editCalls).toBe(2);
  });

  it("swallows a rate-limited interim edit without waiting or failing", async () => {
    let editCalls = 0;
    const api: TelegramBotApi = {
      async sendMessage(params) {
        return { message_id: 500, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        editCalls += 1;
        if (editCalls === 1) {
          throw telegramApiError("Too Many Requests", {
            errorCode: 429,
            retryAfterMs: 5000,
          });
        }
        return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
    };

    const stream = new TelegramMessageStream({ api, chatId: 1, editDebounceMs: 0 });
    await stream.append("partial");
    await expect(stream.finish("done")).resolves.toBeUndefined();
    expect(editCalls).toBe(2);
  });

  it("falls back to plain text when Telegram rejects the MarkdownV2 entities", async () => {
    const editParams: TelegramEditMessageTextParams[] = [];
    const api: TelegramBotApi = {
      async sendMessage(params) {
        return { message_id: 600, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText(params) {
        editParams.push(params);
        if (params.parse_mode === "MarkdownV2") {
          throw telegramApiError("Bad Request: can't parse entities: unexpected end");
        }
        return { message_id: params.message_id ?? 0, chat: { id: params.chat_id ?? 0 }, text: params.text };
      },
      async getUpdates() {
        return [];
      },
    };

    const stream = new TelegramMessageStream({ api, chatId: 1, editDebounceMs: 0 });
    await expect(stream.finish("**bold** answer")).resolves.toBeUndefined();

    expect(editParams).toHaveLength(2);
    expect(editParams[0]?.parse_mode).toBe("MarkdownV2");
    expect(editParams[0]?.text).toBe("*bold* answer");
    expect(editParams[1]?.parse_mode).toBeUndefined();
    expect(editParams[1]?.text).toBe("**bold** answer");
  });

  it("does not post a fresh message with the answer once aborted", async () => {
    const controller = new AbortController();
    const sendCalls: TelegramSendMessageParams[] = [];
    const api: TelegramBotApi = {
      async sendMessage(params) {
        sendCalls.push(params);
        return { message_id: 950, chat: { id: params.chat_id }, text: params.text };
      },
      async editMessageText() {
        // Edit target is gone — without the abort guard this would recreate or
        // last-resort a brand-new message carrying the now-unwanted answer.
        throw telegramApiError("Bad Request: message to edit not found");
      },
      async getUpdates() {
        return [];
      },
    };

    const stream = new TelegramMessageStream({
      api,
      chatId: 1,
      editDebounceMs: 0,
      abortSignal: controller.signal,
    });
    controller.abort(new Error("cancelled by user"));

    await expect(stream.finish("unwanted answer")).resolves.toBeUndefined();
    expect(sendCalls.map((call) => call.text)).toEqual(["Thinking…"]);
  });
});

describe("TelegramMessageStream (substrate wrapper)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates streaming + finish to the shared ResilientMessageStream substrate", async () => {
    // Equivalence proof that the wrapper is a thin pass-through onto the substrate:
    // the substrate owns the lazy placeholder, the debounced interim edit, and the
    // final MarkdownV2 re-render — the wrapper only builds the Telegram transport.
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 77,
      initialStatusText: "Thinking…",
      editDebounceMs: 0,
    });

    await stream.append("Answer with a dot.");
    await stream.finish("Answer with a dot.");

    // Lazy placeholder posted once via transport.post -> sendMessage.
    expect(api.sendMessageCalls).toEqual([{ chat_id: 77, text: "Thinking…" }]);
    // Interim edit streams plain; final edit re-renders MarkdownV2 (substrate FSM).
    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 77, message_id: 100, text: "Answer with a dot." },
      { chat_id: 77, message_id: 100, text: "Answer with a dot\\.", parse_mode: "MarkdownV2" },
    ]);
  });

  it("classifies a MarkdownV2 size overflow as a reformat-to-plain recovery", async () => {
    // The transport pre-empts an oversized MarkdownV2 chunk by signalling
    // reformat_plain to the substrate, which re-delivers the plain source. The
    // oversized markdown attempt never reaches the Telegram API.
    const api = new FakeTelegramApi();
    const stream = new TelegramMessageStream({
      api,
      chatId: 88,
      editDebounceMs: 0,
      maxMessageChars: 50,
    });

    const dots = ".".repeat(30);
    await stream.finish(dots);

    expect(api.editMessageTextCalls).toEqual([
      { chat_id: 88, message_id: 100, text: dots },
    ]);
  });
});

function telegramApiError(
  description: string,
  overrides?: { errorCode?: number; retryAfterMs?: number },
): TelegramApiError {
  return new TelegramApiError("Telegram API editMessageText rejected the request.", {
    kind: "telegram",
    method: "editMessageText",
    errorCode: overrides?.errorCode ?? 400,
    telegramDescription: description,
    ...(overrides?.retryAfterMs === undefined ? {} : { retryAfterMs: overrides.retryAfterMs }),
  });
}

describe("splitTelegramText", () => {
  it("splits text without dropping characters", () => {
    expect(splitTelegramText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(splitTelegramText("abc", 10)).toEqual(["abc"]);
  });
});

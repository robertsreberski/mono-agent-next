import { Bot } from "grammy";
import { describe, expect, it } from "vitest";

import type { AgentRequest, AgentResponder } from "../adapter.js";
import { createTelegramBot } from "../bot.js";

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Example Bot",
  username: "ExampleBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

function ok(result: unknown): never {
  return { ok: true, result } as never;
}

function buildNotifiableBot(responder: AgentResponder): {
  controller: ReturnType<typeof createTelegramBot>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let nextMessageId = 2000;
  const controller = createTelegramBot({
    botToken: "test-token",
    allowAllChats: true,
    responder,
    botFactory: () => {
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method, payload) => {
        const typedPayload = payload as Record<string, unknown>;
        calls.push({ method, payload: typedPayload });
        if (method === "sendMessage") {
          return ok({
            message_id: nextMessageId++,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        if (method === "editMessageText") {
          return ok({
            message_id: typedPayload.message_id ?? 0,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        return ok(true);
      });
      return bot;
    },
  });
  return { controller, calls };
}

describe("createTelegramBot notify (proactive)", () => {
  it("runs a turn keyed on telegram:<chatId> and delivers the answer to that chat", async () => {
    let captured: AgentRequest | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        captured = request as AgentRequest;
        return { text: "Morning brief ready" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(42, "Compose and report the morning brief.");

    expect(result).toEqual({ delivered: true });
    expect(captured?.conversationId).toBe("telegram:42");
    expect(captured?.replyTo).toEqual({ conversationId: "telegram:42" });
    expect(captured?.text).toBe("Compose and report the morning brief.");
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.at(-1)?.payload).toMatchObject({
      chat_id: 42,
      text: "Morning brief ready",
    });
  });

  it("suppresses transient tool activity for proactive turns", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "t1",
          name: "WebSearch",
          arguments: { query: "scheduled research" },
        });
        return { text: "Research complete" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    await controller.notify(42, "Research this in the background.");

    expect(calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text))
      .toEqual(["Research complete"]);
    expect(calls.some((call) => String(call.payload.text).includes("Searching the web")))
      .toBe(false);
  });

  it("verbatim mode posts the text as-is without running a turn and records it to history", async () => {
    let responded = false;
    const verbatimCalls: Array<[string, string]> = [];
    const responder: AgentResponder = {
      async respond() {
        responded = true;
        return { text: "should not run" };
      },
      async deliverVerbatim(conversationId, text) {
        verbatimCalls.push([conversationId, text]);
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(42, "Your morning brief: all clear.", { verbatim: true });

    expect(result).toEqual({ delivered: true });
    // No model turn ran — the body is posted through the normal stream (markdown
    // rendering still applies, so punctuation may be MarkdownV2-escaped).
    expect(responded).toBe(false);
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent.at(-1)?.payload.text)).toContain("Your morning brief");
    // The UNrendered body is recorded to history so a later reply resumes with it in context.
    expect(verbatimCalls).toEqual([["telegram:42", "Your morning brief: all clear."]]);
  });

  it("forwards silent through the verbatim path as disable_notification", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "should not run" };
      },
      async deliverVerbatim() {},
    };
    const { controller, calls } = buildNotifiableBot(responder);

    await controller.notify(42, "Overnight digest.", { verbatim: true, silent: true });

    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent.at(-1)?.payload).toMatchObject({ disable_notification: true });
  });

  it("does not set disable_notification when silent is not requested", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "answer" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    await controller.notify(42, "Anything urgent?");

    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.at(-1)?.payload.disable_notification).toBeUndefined();
  });

  it("posts nothing (and reports the reason) when the proactive turn produces no answer", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(7, "Anything urgent?");

    expect(result).toEqual({ delivered: false, reason: "agent produced no answer" });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("reports the queue-full reason when the chat is at its concurrency cap", async () => {
    // Hold the first turn open so a flood past the depth cap is rejected by the
    // per-chat admission queue while the run is still in-flight.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder: AgentResponder = {
      async respond() {
        await gate;
        return { text: "done" };
      },
    };
    const { controller } = buildNotifiableBot(responder);

    // Fill the queue to its depth cap (100) with notifies that park on `gate`,
    // then the next notify is rejected synchronously as queue-full.
    const inflight = Array.from({ length: 100 }, () => controller.notify(5, "tick"));
    const rejected = await controller.notify(5, "one too many");

    expect(rejected).toEqual({ delivered: false, reason: "chat at concurrency cap" });

    release?.();
    await Promise.all(inflight);
  });
});

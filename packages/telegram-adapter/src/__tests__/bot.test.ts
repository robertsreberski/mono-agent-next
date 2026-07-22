import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentResponseCancelledError,
  isChannelUserCancelReason,
  type AgentLiveInputRequest,
  type AgentLiveInputSettlement,
  type ChannelAskSnapshot,
} from "@mono-agent/agent-contracts";
import { Bot } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequest, AgentResponder, TelegramAdapterLogger } from "../adapter.js";
import { telegramAskUserCallbackData } from "../ask-user.js";
import {
  buildTelegramBotClientOptions,
  createTelegramBot,
  SerialQueue,
  SerialQueueFullError,
  type CreateTelegramBotOptions,
  type TelegramRuntimeControls,
} from "../bot.js";
import { telegramReplyCallbackData } from "../reply-options.js";

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

const RUNTIME_CONTROLS = {
  defaultModel: "codex:gpt-primary",
  defaultEffort: "high",
  models: [
    {
      value: "codex:gpt-primary",
      label: "Primary",
      efforts: [
        { value: "none", label: "None" },
        { value: "high", label: "High" },
      ],
    },
    {
      value: "codex:gpt-fallback",
      label: "Fallback",
      efforts: [{ value: "low", label: "Low" }],
    },
  ],
} satisfies TelegramRuntimeControls;

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

interface StubbedDownload {
  /** Bytes returned by download(); when omitted the download throws. */
  bytes?: Uint8Array;
  /** Force a missing file_path from getFile (resolveFilePath -> undefined). */
  noFilePath?: boolean;
  /**
   * When set, download() awaits this gate before returning (simulating a slow
   * getFile/fetch). Used to prove same-chat admission ordering.
   */
  gate?: Promise<void>;
}

function buildTestBot(
  options: Partial<CreateTelegramBotOptions> & { responder: AgentResponder },
): {
  bot: Bot;
  controller: ReturnType<typeof createTelegramBot>;
  calls: RecordedCall[];
  failures: Map<string, () => unknown>;
  downloads: Map<string, StubbedDownload>;
  downloadedFileIds: string[];
  stop: () => Promise<void>;
  activeControllerCount: () => number;
} {
  const calls: RecordedCall[] = [];
  const failures = new Map<string, () => unknown>();
  // By default every attachment file_id resolves to a tiny deterministic byte
  // payload so the request carries base64 data without touching the network.
  const downloads = new Map<string, StubbedDownload>();
  const downloadedFileIds: string[] = [];
  let nextMessageId = 1000;

  const controller = createTelegramBot({
    botToken: "test-token",
    allowAllChats: true,
    fileDownloaderFactory: () => ({
      async resolveFilePath(fileId) {
        const stub = downloads.get(fileId);
        if (stub?.noFilePath === true) {
          return undefined;
        }
        return `path/${fileId}`;
      },
      async download(filePath: string, _signal: AbortSignal, _maxBytes?: number) {
        const fileId = filePath.replace(/^path\//u, "");
        downloadedFileIds.push(fileId);
        const stub = downloads.get(fileId);
        if (stub?.gate !== undefined) {
          await stub.gate;
        }
        if (stub?.bytes !== undefined) {
          return stub.bytes;
        }
        if (stub !== undefined && stub.gate === undefined) {
          // Stub present but no bytes (and not just a gate) => simulate a failed download.
          throw new Error(`download failed for ${fileId}`);
        }
        // Default: deterministic bytes derived from the file id.
        return new TextEncoder().encode(`bytes:${fileId}`);
      },
    }),
    ...options,
    botFactory: () => {
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method, payload) => {
        const typedPayload = payload as Record<string, unknown>;
        calls.push({ method, payload: typedPayload });
        const override = failures.get(method);
        if (override !== undefined) {
          return override() as never;
        }
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

  return {
    bot: controller.bot,
    controller,
    calls,
    failures,
    downloads,
    downloadedFileIds,
    stop: () => controller.stop(),
    activeControllerCount: () => controller.activeControllerCount(),
  };
}

function ok(result: unknown): never {
  return { ok: true, result } as never;
}

function err(errorCode: number, description: string): never {
  return { ok: false, error_code: errorCode, description, parameters: {} } as never;
}

function textUpdate(
  text: string,
  options?: { chatId?: number; messageId?: number; updateId?: number; username?: string },
): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: options?.messageId ?? 10,
      date: 1234,
      chat: { id: options?.chatId ?? 42, type: "private" },
      from: {
        id: 7,
        is_bot: false,
        first_name: "Person A",
        username: options?.username ?? "person_a",
      },
      text,
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function commandUpdate(
  command: string,
  options?: { chatId?: number; updateId?: number },
): Parameters<Bot["handleUpdate"]>[0] {
  const commandToken = command.trim().split(/\s/u, 1)[0] ?? command;
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: options?.chatId ?? 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      text: command,
      entities: [{ type: "bot_command", offset: 0, length: commandToken.length }],
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function callbackUpdate(options: {
  data: string;
  chatId?: number;
  messageId?: number;
  updateId?: number;
  questionText?: string;
  buttons?: Array<{ text: string; callback_data: string }>;
}): Parameters<Bot["handleUpdate"]>[0] {
  const chatId = options.chatId ?? 42;
  const messageId = options.messageId ?? 500;
  const buttons = options.buttons ?? [
    { text: "Approve", callback_data: telegramReplyCallbackData(0) },
    { text: "Reject", callback_data: telegramReplyCallbackData(1) },
  ];
  return {
    update_id: options.updateId ?? 1,
    callback_query: {
      id: "cbq-1",
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      chat_instance: "ci-1",
      data: options.data,
      message: {
        message_id: messageId,
        date: 1234,
        chat: { id: chatId, type: "private" },
        from: FAKE_BOT_INFO,
        text: options.questionText ?? "Proceed?",
        reply_markup: { inline_keyboard: [buttons] },
      },
    },
  } as unknown as Parameters<Bot["handleUpdate"]>[0];
}

function stickerUpdate(): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      sticker: { file_id: "s", file_unique_id: "u", width: 1, height: 1, type: "regular", is_animated: false, is_video: false },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function animationUpdate(): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      animation: {
        file_id: "animation-file-id",
        file_unique_id: "animation-unique-id",
        width: 320,
        height: 240,
        duration: 3,
        file_name: "funny.gif",
        mime_type: "image/gif",
        file_size: 20_000,
      },
      document: {
        file_id: "animation-file-id",
        file_unique_id: "animation-unique-id",
        file_name: "funny.gif",
        mime_type: "image/gif",
        file_size: 20_000,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function documentUpdate(
  options?: { caption?: string; updateId?: number; mimeType?: string },
): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      caption: options?.caption,
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "brief.pdf",
        mime_type: options?.mimeType ?? "application/pdf",
        file_size: 12_345,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function photoUpdate(options?: { caption?: string; updateId?: number }): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      caption: options?.caption,
      photo: [
        {
          file_id: "photo-small-id",
          file_unique_id: "photo-small-unique",
          width: 160,
          height: 90,
          file_size: 1_024,
        },
        {
          file_id: "photo-large-id",
          file_unique_id: "photo-large-unique",
          width: 1280,
          height: 720,
          file_size: 65_536,
        },
      ],
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function albumPhotoUpdate(options: {
  groupId: string;
  fileId: string;
  caption?: string;
  updateId: number;
  messageId: number;
}): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      media_group_id: options.groupId,
      caption: options.caption,
      photo: [
        {
          file_id: options.fileId,
          file_unique_id: `${options.fileId}-unique`,
          width: 1280,
          height: 720,
          file_size: 65_536,
        },
      ],
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function voiceUpdate(options?: { caption?: string; updateId?: number }): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: options?.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
      caption: options?.caption,
      voice: {
        file_id: "voice-file-id",
        file_unique_id: "voice-unique-id",
        duration: 17,
        mime_type: "audio/ogg",
        file_size: 23_456,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function responderFrom(respond: AgentResponder["respond"]): AgentResponder {
  return { respond };
}

function askSnapshot(multiSelect = false): ChannelAskSnapshot {
  return {
    interactionId: "ask-test",
    message: "Draft reply",
    questions: [{
      id: "q0",
      header: "Delivery",
      question: "What should I do with this draft?",
      options: [
        { id: "q0o0", label: "Send", description: "Send it now." },
        { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        { id: "q0o2", label: "Revise", description: "Keep editing it." },
      ],
      multiSelect,
    }],
    answers: [],
    activeQuestionIndex: 0,
    status: "pending",
    createdAt: "2026-07-21T09:00:00.000Z",
    expiresAt: "2026-07-21T09:10:00.000Z",
  };
}

/** The sequence of reaction emojis applied (undefined = a cleared reaction). */
function reactionEmojis(calls: RecordedCall[]): Array<string | undefined> {
  return calls
    .filter((call) => call.method === "setMessageReaction")
    .map((call) => (call.payload.reaction as Array<{ emoji: string }>)[0]?.emoji);
}

function texts(calls: RecordedCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.payload.text);
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("createTelegramBot", () => {
  it("fails closed unless chats are explicitly allowed", () => {
    expect(() =>
      createTelegramBot({
        botToken: "test-token",
        responder: responderFrom(async () => ({ text: "ok" })),
        botFactory: () => new Bot("test-token", { botInfo: FAKE_BOT_INFO }),
      }),
    ).toThrow(/allowedChatIds/);
  });

  it("answers /start and /help with deterministic plain replies", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(commandUpdate("/start"));
    await bot.handleUpdate(commandUpdate("/help@ExampleBot", { updateId: 2 }));

    expect(texts(calls, "sendMessage")).toEqual([
      "Hello! Send text or Telegram media. I pass your caption and download allowed attachments to share with the configured agent.",
      "Send text, documents, photos, audio, video, round videos (video notes), or voice messages. I forward your caption and download supported attachments (within size/type limits) for the agent. Use /cancel to stop the current response.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("acknowledges /cancel exactly once when no turn is active", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(commandUpdate("/cancel"));

    expect(texts(calls, "sendMessage").filter((text) => text === "Cancelled.")).toEqual([
      "Cancelled.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("dispatches a configured command by running its prompt as a turn", async () => {
    const requests: AgentRequest[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        requests.push(request as AgentRequest);
        return { text: "Brief all clear" };
      },
    };
    const { bot, calls } = buildTestBot({
      responder,
      commands: [{ command: "brief", description: "Morning brief", prompt: "Compose my morning brief" }],
    });

    await bot.handleUpdate(commandUpdate("/brief"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe("Compose my morning brief");
    expect(requests[0]?.conversationId).toBe("telegram:42");
    expect(texts(calls, "sendMessage")).toContain("Brief all clear");
  });

  it("treats a prompt-less command as menu-only and echoes its description", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({
      responder,
      commands: [{ command: "about", description: "What this agent does" }],
    });

    await bot.handleUpdate(commandUpdate("/about"));

    expect(responder.respond).not.toHaveBeenCalled();
    expect(texts(calls, "sendMessage")).toEqual(["What this agent does"]);
  });

  it("opens model and effort menus without running the responder", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder, runtimeControls: RUNTIME_CONTROLS });

    await bot.handleUpdate(commandUpdate("/model"));
    await bot.handleUpdate(commandUpdate("/effort", { updateId: 2 }));

    const menus = calls.filter((call) => call.method === "sendMessage");
    expect(menus).toHaveLength(2);
    expect(menus[0]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [
        [expect.objectContaining({ text: expect.stringContaining("Default"), callback_data: expect.stringMatching(/^ma:m:[a-f0-9]{16}$/u) })],
        [expect.objectContaining({ text: "Fallback", callback_data: expect.stringMatching(/^ma:m:[a-f0-9]{16}$/u) })],
        [expect.objectContaining({ text: "Cancel", callback_data: "ma:cancel" })],
      ],
    });
    expect(menus[1]?.payload.reply_markup).toMatchObject({
      inline_keyboard: expect.arrayContaining([
        [expect.objectContaining({ callback_data: expect.stringMatching(/^ma:e:[a-f0-9]{16}:/u) })],
      ]),
    });
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("keeps model and effort selections per chat, clearing only incompatible effort", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = buildTestBot({
      runtimeControls: RUNTIME_CONTROLS,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
    });

    await bot.handleUpdate(commandUpdate("/effort high"));
    await bot.handleUpdate(commandUpdate("/model codex:gpt-fallback", { updateId: 2 }));
    await bot.handleUpdate(textUpdate("fallback default effort", { updateId: 3 }));
    await bot.handleUpdate(commandUpdate("/effort low", { updateId: 4 }));
    await bot.handleUpdate(textUpdate("fallback low effort", { updateId: 5 }));
    await bot.handleUpdate(textUpdate("other chat", { chatId: 99, updateId: 6 }));
    await bot.handleUpdate(commandUpdate("/model default", { updateId: 7 }));
    await bot.handleUpdate(textUpdate("back to defaults", { updateId: 8 }));

    expect(requests).toHaveLength(4);
    expect(requests[0]?.metadata.telegram).toMatchObject({ model: "codex:gpt-fallback" });
    expect(requests[0]?.metadata.telegram.effort).toBeUndefined();
    expect(requests[1]?.metadata.telegram).toMatchObject({
      model: "codex:gpt-fallback",
      effort: "low",
    });
    expect(requests[2]?.metadata.telegram.model).toBeUndefined();
    expect(requests[2]?.metadata.telegram.effort).toBeUndefined();
    expect(requests[3]?.metadata.telegram.model).toBeUndefined();
    expect(requests[3]?.metadata.telegram.effort).toBeUndefined();
  });

  it("applies opaque model callbacks and rejects stale or forged runtime callbacks", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = buildTestBot({
      runtimeControls: RUNTIME_CONTROLS,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
    });

    await bot.handleUpdate(commandUpdate("/model"));
    const modelMenu = calls.find((call) => call.method === "sendMessage");
    const modelRows = (modelMenu?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    }).inline_keyboard;
    const fallbackData = modelRows[1]?.[0]?.callback_data as string;
    expect(fallbackData).not.toContain("gpt-fallback");
    await bot.handleUpdate(callbackUpdate({ data: fallbackData, messageId: 501 }));
    expect(texts(calls, "editMessageText")).toEqual([
      "Model changed to Fallback for this chat until /model default or restart.",
    ]);
    expect(texts(calls, "sendMessage")).toEqual([
      "Current model: Primary. Choose a configured model:",
    ]);
    await bot.handleUpdate(textUpdate("use selection", { updateId: 3 }));
    await bot.handleUpdate(callbackUpdate({ data: "ma:m:forged", messageId: 502, updateId: 4 }));

    expect(requests[0]?.metadata.telegram.model).toBe("codex:gpt-fallback");
    expect(
      calls.filter((call) => call.method === "answerCallbackQuery").at(-1)?.payload.text,
    ).toBe("This menu has expired.");
    expect(requests).toHaveLength(1);
  });

  it("deletes a runtime menu when Cancel is tapped without changing the selection", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = buildTestBot({
      runtimeControls: RUNTIME_CONTROLS,
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
    });

    await bot.handleUpdate(commandUpdate("/model"));
    await bot.handleUpdate(callbackUpdate({ data: "ma:cancel", messageId: 501, updateId: 2 }));
    await bot.handleUpdate(textUpdate("still default", { updateId: 3 }));

    expect(calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 501)).toBe(true);
    expect(requests[0]?.metadata.telegram.model).toBeUndefined();
  });

  it("edits the effort menu into its selection confirmation", async () => {
    const { bot, calls } = buildTestBot({
      runtimeControls: RUNTIME_CONTROLS,
      responder: responderFrom(async () => ({ text: "ok" })),
    });
    await bot.handleUpdate(commandUpdate("/effort"));
    const menu = calls.find((call) => call.method === "sendMessage");
    const rows = (menu?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }).inline_keyboard;
    const none = rows.flat().find((button) => button.text === "None");

    await bot.handleUpdate(callbackUpdate({ data: none?.callback_data as string, messageId: 503, updateId: 2 }));

    expect(texts(calls, "editMessageText")).toEqual([
      "Effort changed to None for this chat until /effort default or restart.",
    ]);
  });

  it("handles /new as a host-owned per-conversation reset without running a turn", async () => {
    const startNewSession = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const responder = { respond: vi.fn(), cancel } satisfies AgentResponder;
    const pendingCancel = vi.fn();
    const { bot, calls } = buildTestBot({
      responder,
      startNewSession,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => undefined),
        submitAskAnswers: vi.fn(async () => ({ accepted: false, code: "not_found" as const })),
        cancel: pendingCancel,
      },
    });

    await bot.handleUpdate(commandUpdate("/new"));

    expect(startNewSession).toHaveBeenCalledWith("telegram:42");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pendingCancel).toHaveBeenCalledWith("telegram:42");
    expect(responder.respond).not.toHaveBeenCalled();
    expect(texts(calls, "sendMessage")).toEqual([
      "Started a new session. Conversation history was cleared; skills and startup context will reload on your next message.",
    ]);
  });

  it("does not cancel current work when /new is unsupported", async () => {
    const cancel = vi.fn();
    const responder = { respond: vi.fn(), cancel } satisfies AgentResponder;
    const pendingCancel = vi.fn();
    const { bot, calls } = buildTestBot({
      responder,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => undefined),
        submitAskAnswers: vi.fn(async () => ({ accepted: false, code: "not_found" as const })),
        cancel: pendingCancel,
      },
    });

    await bot.handleUpdate(commandUpdate("/new"));

    expect(cancel).not.toHaveBeenCalled();
    expect(pendingCancel).not.toHaveBeenCalled();
    expect(responder.respond).not.toHaveBeenCalled();
    expect(texts(calls, "sendMessage")).toEqual([
      "I could not start a new session. The existing conversation was left available; check the agent logs for details.",
    ]);
  });

  it("uses chat selections for interactive command prompts but not public proactive notify", async () => {
    const requests: AgentRequest[] = [];
    const { bot, controller } = buildTestBot({
      runtimeControls: RUNTIME_CONTROLS,
      commands: [{ command: "brief", description: "Morning brief", prompt: "Compose the brief" }],
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
    });

    await bot.handleUpdate(commandUpdate("/model codex:gpt-fallback"));
    await bot.handleUpdate(commandUpdate("/brief", { updateId: 2 }));
    await controller.notify(42, "proactive check");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.metadata.telegram.model).toBe("codex:gpt-fallback");
    expect(requests[1]?.metadata.telegram.model).toBeUndefined();
  });

  it("reacts 👀 then 👍 around a successful turn when all reactions are enabled", async () => {
    const responder = responderFrom(async () => ({ text: "done" }));
    const { bot, calls } = buildTestBot({
      responder,
      reactions: { working: true, done: true, error: true },
      stream: { editDebounceMs: 0 },
    });

    await bot.handleUpdate(textUpdate("hello"));

    expect(reactionEmojis(calls)).toEqual(["👀", "👍"]);
  });

  it("does not react when reactions are disabled", async () => {
    const responder = responderFrom(async () => ({ text: "done" }));
    const { bot, calls } = buildTestBot({ responder, stream: { editDebounceMs: 0 } });

    await bot.handleUpdate(textUpdate("hello"));

    expect(calls.some((call) => call.method === "setMessageReaction")).toBe(false);
  });

  it("reacts 👎 when the responder fails and the error reaction is enabled", async () => {
    const responder = responderFrom(async () => {
      throw new Error("boom");
    });
    const { bot, calls } = buildTestBot({
      responder,
      reactions: { working: true, done: true, error: true },
      stream: { editDebounceMs: 0 },
    });

    await bot.handleUpdate(textUpdate("hello"));

    const reactions = reactionEmojis(calls);
    expect(reactions[0]).toBe("👀");
    expect(reactions.at(-1)).toBe("👎");
  });

  it("clears the working reaction on success when the done reaction is disabled", async () => {
    const responder = responderFrom(async () => ({ text: "done" }));
    const { bot, calls } = buildTestBot({
      responder,
      reactions: { working: true, done: false, error: true },
      stream: { editDebounceMs: 0 },
    });

    await bot.handleUpdate(textUpdate("hello"));

    // 👀 while working, then cleared on success (no 👍 clutter).
    expect(reactionEmojis(calls)).toEqual(["👀", undefined]);
  });

  it("only reacts on completion when the working reaction is disabled", async () => {
    const responder = responderFrom(async () => ({ text: "done" }));
    const { bot, calls } = buildTestBot({
      responder,
      reactions: { working: false, done: true, error: true },
      stream: { editDebounceMs: 0 },
    });

    await bot.handleUpdate(textUpdate("hello"));

    // No 👀 (working off) and nothing to clear: just the 👍 on success.
    expect(reactionEmojis(calls)).toEqual(["👍"]);
  });

  it("submits a structured AskUser option without running a new turn", async () => {
    const snapshot = askSnapshot();
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({
      responder,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });

    await bot.handleUpdate(callbackUpdate({
      data: telegramAskUserCallbackData(snapshot.interactionId, 0, { kind: "option", optionIndex: 0 }),
    }));

    expect(submitAskAnswers).toHaveBeenCalledWith({
      conversationId: "telegram:42",
      interactionId: snapshot.interactionId,
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
    expect(responder.respond).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
  });

  it("toggles multi-select AskUser options and submits them on Done", async () => {
    const snapshot = askSnapshot(true);
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const { bot, controller, calls } = buildTestBot({
      responder: { respond: vi.fn() },
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });
    await controller.presentAsk(42, snapshot);

    await bot.handleUpdate(callbackUpdate({
      data: telegramAskUserCallbackData(snapshot.interactionId, 0, { kind: "option", optionIndex: 0 }),
    }));
    await bot.handleUpdate(callbackUpdate({
      data: telegramAskUserCallbackData(snapshot.interactionId, 0, { kind: "option", optionIndex: 2 }),
      updateId: 2,
    }));
    await bot.handleUpdate(callbackUpdate({
      data: telegramAskUserCallbackData(snapshot.interactionId, 0, { kind: "done" }),
      updateId: 3,
    }));

    expect(submitAskAnswers).toHaveBeenCalledWith({
      conversationId: "telegram:42",
      interactionId: snapshot.interactionId,
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0", "q0o2"] }],
    });
    const editedButtons = (calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string }>>;
    }).inline_keyboard.flat().map((button) => button.text);
    expect(editedButtons).toContain("✓ Send");
    expect(editedButtons).toContain("✓ Revise");
  });

  it("acknowledges stale AskUser callbacks without starting a new turn", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({
      responder,
      pendingAsks: {
        getPendingAsk: vi.fn(async () => undefined),
        submitAskAnswers: vi.fn(async () => ({ accepted: false, code: "not_found" as const })),
        cancel: vi.fn(),
      },
    });

    await bot.handleUpdate(callbackUpdate({
      data: telegramAskUserCallbackData("ask-stale", 0, { kind: "option", optionIndex: 0 }),
    }));

    expect(responder.respond).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "answerCallbackQuery")?.payload.text).toBe(
      "This question has expired.",
    );
  });

  it("runs non-blocking reply options as a new turn and de-dupes a second tap", async () => {
    let runCount = 0;
    const responder = responderFrom(async () => {
      runCount += 1;
      return { text: "ok" };
    });
    const { bot, calls } = buildTestBot({ responder, stream: { editDebounceMs: 0 } });
    const buttons = [
      { text: "Approve", callback_data: telegramReplyCallbackData(0) },
      { text: "Reject", callback_data: telegramReplyCallbackData(1) },
    ];

    await bot.handleUpdate(callbackUpdate({ data: telegramReplyCallbackData(0), messageId: 500, buttons }));
    await bot.handleUpdate(callbackUpdate({
      data: telegramReplyCallbackData(1),
      messageId: 500,
      updateId: 2,
      buttons,
    }));

    expect(runCount).toBe(1);
    expect(calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
  });

  it("denies unauthorized chats without calling the responder", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({
      responder,
      allowAllChats: false,
      allowedChatIds: [99],
    });

    await bot.handleUpdate(textUpdate("hello", { chatId: 42 }));

    expect(texts(calls, "sendMessage")).toEqual([
      "This Telegram chat is not authorized to use this bot.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("invokes the responder with a bounded request and streams the answer", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request, stream) => {
        requests.push(request);
        await stream.append("partial");
        return { text: "final", metadata: { provider: "fake" } };
      }),
    });

    await bot.handleUpdate(textUpdate("  hello agent  ", { username: "person_a" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: "telegram:42",
      replyTo: { conversationId: "telegram:42" },
      chatId: 42,
      messageId: 10,
      updateId: 1,
      userId: 7,
      username: "person_a",
      text: "hello agent",
      metadata: {
        telegram: {
          updateId: 1,
          chat: { id: 42, type: "private" },
          message: { id: 10, date: 1234 },
          from: { id: 7, username: "person_a", firstName: "Person A" },
        },
      },
    });
    expect(requests[0]?.abortSignal).toBeInstanceOf(AbortSignal);

    // Final-only delivery: no interim edits. The single sendMessage at finish()
    // carries the final answer (the lazy first send happens at finish), rendered
    // as MarkdownV2, and replies to the inbound message.
    expect(texts(calls, "editMessageText")).toEqual([]);
    const finalSend = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(finalSend?.payload).toMatchObject({
      chat_id: 42,
      text: "final",
      parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    });
  });

  it("downloads inbound document bytes into request.attachments while preserving metadata", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received document" };
      }),
    });

    await bot.handleUpdate(documentUpdate({ caption: "Please summarize this" }));

    expect(requests).toHaveLength(1);
    // request.attachments now carries downloaded bytes in the transport-agnostic
    // AgentAttachment shape: a non-image MIME maps to kind "document".
    const expectedBase64 = Buffer.from("bytes:doc-file-id").toString("base64");
    expect(requests[0]?.text).toBe("Please summarize this");
    expect(requests[0]?.attachments).toEqual([
      {
        kind: "document",
        mimeType: "application/pdf",
        data: expectedBase64,
        name: "brief.pdf",
        sizeBytes: Buffer.from("bytes:doc-file-id").length,
      },
    ]);
    // The original Telegram file metadata is preserved under metadata.telegram.
    expect(requests[0]?.metadata.telegram.attachments).toEqual([
      {
        kind: "document",
        fileId: "doc-file-id",
        fileUniqueId: "doc-unique-id",
        fileName: "brief.pdf",
        mimeType: "application/pdf",
        fileSize: 12_345,
      },
    ]);
    expect(texts(calls, "sendMessage")).not.toContain(
      "I can handle text and Telegram document, photo, audio, video, round video, or voice metadata in this adapter.",
    );
  });

  it("decodes text/* document downloads into the attachment text field", async () => {
    const requests: AgentRequest[] = [];
    const { bot, downloads } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received note" };
      }),
    });

    downloads.set("note-file-id", { bytes: new TextEncoder().encode("hello from a file") });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1234,
        chat: { id: 42, type: "private" },
        from: { id: 7, is_bot: false, first_name: "Person A", username: "person_a" },
        document: {
          file_id: "note-file-id",
          file_unique_id: "note-unique-id",
          file_name: "note.txt",
          mime_type: "text/plain",
          file_size: 17,
        },
      },
    } as Parameters<Bot["handleUpdate"]>[0]);

    expect(requests[0]?.attachments).toEqual([
      {
        kind: "document",
        mimeType: "text/plain",
        data: Buffer.from("hello from a file").toString("base64"),
        name: "note.txt",
        sizeBytes: 17,
        text: "hello from a file",
      },
    ]);
  });

  it("skips an attachment whose download fails and still runs the responder", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls, downloads } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ran anyway" };
      }),
    });

    // Stub present without bytes => the download throws; the attachment is skipped.
    downloads.set("doc-file-id", {});

    await bot.handleUpdate(documentUpdate({ caption: "summarize" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments).toBeUndefined();
    // Telegram metadata is still preserved even though the bytes were skipped.
    expect(requests[0]?.metadata.telegram.attachments).toHaveLength(1);
    // Final-only delivery: the final answer arrives as a single sendMessage.
    expect(texts(calls, "sendMessage").at(-1)).toBe("ran anyway");
  });

  it("skips attachments whose MIME type is not on the allowlist", async () => {
    const requests: AgentRequest[] = [];
    const { bot, downloadedFileIds } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
    });

    // application/x-msdownload is not on the default allowlist, so no download is attempted.
    await bot.handleUpdate(documentUpdate({ mimeType: "application/x-msdownload" }));

    expect(downloadedFileIds).toEqual([]);
    expect(requests[0]?.attachments).toBeUndefined();
    // Metadata is still forwarded even when the bytes are not downloaded.
    expect(requests[0]?.metadata.telegram.attachments).toHaveLength(1);
  });

  it("downloads the largest photo as an image attachment and keeps the text summary", async () => {
    const requests: AgentRequest[] = [];
    const { bot, downloadedFileIds } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received photo" };
      }),
    });

    await bot.handleUpdate(photoUpdate());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toContain("Telegram photo");
    // The largest photo size is the one downloaded; image MIME maps to kind "image".
    expect(downloadedFileIds).toEqual(["photo-large-id"]);
    expect(requests[0]?.attachments).toEqual([
      {
        kind: "image",
        mimeType: "image/jpeg",
        data: Buffer.from("bytes:photo-large-id").toString("base64"),
        sizeBytes: Buffer.from("bytes:photo-large-id").length,
      },
    ]);
    // Telegram photo metadata (all sizes) is preserved under metadata.telegram.
    expect(requests[0]?.metadata.telegram.attachments?.[0]).toMatchObject({
      kind: "photo",
      fileId: "photo-large-id",
      width: 1280,
      height: 720,
    });
  });

  it("aggregates a multi-photo album (shared media_group_id) into one request with every attachment", async () => {
    const requests: AgentRequest[] = [];
    const { bot, downloadedFileIds } = buildTestBot({
      // Flush the album on the next tick so the test does not wait a full second.
      albumAggregationDelayMs: 0,
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "got the album" };
      }),
    });

    // Telegram delivers an album as separate messages sharing a media_group_id;
    // the caption rides on only the first one.
    await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p1", caption: "look at these", updateId: 1, messageId: 10 }));
    await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p2", updateId: 2, messageId: 11 }));
    await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p3", updateId: 3, messageId: 12 }));

    await vi.waitFor(() => expect(requests).toHaveLength(1));

    // One request carrying ALL three photos plus the single caption — not three
    // separate single-attachment turns.
    expect(requests[0]?.text).toContain("look at these");
    expect(requests[0]?.attachments).toHaveLength(3);
    expect(requests[0]?.metadata.telegram.attachments).toHaveLength(3);
    expect(downloadedFileIds).toEqual(["p1", "p2", "p3"]);
  });

  it("preserves arrival order: an album runs before a later same-chat text buffered within its quiet window", async () => {
    const received: { text: string; attachments: number }[] = [];
    const { bot } = buildTestBot({
      stream: { editDebounceMs: 0 },
      // A short (non-zero) quiet window so the text lands while the album buffers,
      // but the test still completes quickly under real timers.
      albumAggregationDelayMs: 30,
      responder: responderFrom(async (request) => {
        received.push({ text: request.text, attachments: request.attachments?.length ?? 0 });
        return { text: "ok" };
      }),
    });

    // Two album parts (shared media_group_id) then an immediate same-chat text,
    // ALL delivered back-to-back (well within the 30ms quiet window). The album
    // reserves its admission slot on the first part, so the later text cannot
    // overtake it even though the album only flushes after the window elapses.
    // The text's handleUpdate stays parked behind the reserved album slot, so we
    // must NOT await it inline (it would block until the album+text both ran).
    await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p1", caption: "look at these", updateId: 1, messageId: 10 }));
    await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p2", updateId: 2, messageId: 11 }));
    const textTurn = bot.handleUpdate(textUpdate("what do you think?", { updateId: 3 }));

    // Nothing has run yet: the album timer is still pending and the text is parked
    // behind the reserved album slot.
    expect(received).toEqual([]);

    // After the quiet window the reserved album slot fills and runs first, then
    // the text admitted behind it.
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await textTurn;

    expect(received.map((entry) => entry.text)).toEqual([
      expect.stringContaining("look at these"),
      "what do you think?",
    ]);
    // The album still carried all of its attachments.
    expect(received[0]?.attachments).toBe(2);
  });

  it("settles the reserved album admission slot on stop() so a later same-chat turn is not wedged", async () => {
    vi.useFakeTimers();
    try {
      const received: string[] = [];
      const { bot, stop } = buildTestBot({
        // Default (non-zero) quiet window so the album timer is pending at stop().
        responder: responderFrom(async (request) => {
          received.push(request.text);
          return { text: "ok" };
        }),
      });

      // Buffer an album (reserves a per-chat admission slot), then tear down.
      await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p1", caption: "hi", updateId: 1, messageId: 10 }));
      await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p2", updateId: 2, messageId: 11 }));

      await stop();
      // Past the quiet window: no album turn fires (stopped guard), and crucially
      // the reserved slot is settled so the per-chat admission queue is not wedged.
      await vi.advanceTimersByTimeAsync(2000);
      expect(received).toEqual([]);

      // The parked admit() task settled rather than hanging forever: awaiting a
      // microtask-bounded loop confirms the queue did not deadlock.
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
      }
      expect(received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("downloads Telegram voice attachments now that audio/ogg is on the allowlist", async () => {
    const requests: AgentRequest[] = [];
    const { bot, downloadedFileIds } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "received voice" };
      }),
    });

    await bot.handleUpdate(voiceUpdate());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toContain("17s");
    // audio/ogg is on the default allowlist, so the bytes are downloaded and inlined.
    expect(downloadedFileIds).toEqual(["voice-file-id"]);
    expect(requests[0]?.attachments).toEqual([
      {
        kind: "document",
        mimeType: "audio/ogg",
        data: Buffer.from("bytes:voice-file-id").toString("base64"),
        sizeBytes: Buffer.from("bytes:voice-file-id").length,
        // Duration rides the transport-agnostic attachment so downstream tools
        // (transcription ETA estimates) need no Telegram-specific metadata.
        durationSeconds: 17,
      },
    ]);
    // …and the Telegram metadata is still forwarded.
    expect(requests[0]?.metadata.telegram.attachments).toEqual([
      {
        kind: "voice",
        fileId: "voice-file-id",
        fileUniqueId: "voice-unique-id",
        duration: 17,
        mimeType: "audio/ogg",
        fileSize: 23_456,
      },
    ]);
  });

  it("never renders reasoning and delivers only the final answer text", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "assistant_thought", text: "secret" });
        await stream.append("the answer");
        return { text: "the answer" };
      }),
    });

    await bot.handleUpdate(textUpdate("hello"));

    // The reasoning is never rendered. Final-only delivery: no interim edits;
    // the answer arrives as a single sendMessage rendered as MarkdownV2.
    expect(texts(calls, "editMessageText")).toEqual([]);
    const finalSend = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(finalSend?.payload.text).toBe("the answer");
    expect(finalSend?.payload.parse_mode).toBe("MarkdownV2");
    expect(calls.some((call) => String(call.payload.text).includes("secret"))).toBe(false);
  });

  it("shows a transient tool ledger and typing indicator without leaking the raw tool name", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({
          type: "tool_call_started",
          id: "t1",
          name: "WebSearch",
          arguments: { query: "mono agent" },
        });
        await stream.append("the answer");
        return { text: "the answer" };
      }),
    });

    await bot.handleUpdate(textUpdate("look it up"));

    const typing = calls.filter(
      (call) => call.method === "sendChatAction" && call.payload.action === "typing",
    );
    expect(typing.length).toBeGreaterThanOrEqual(1);
    expect(texts(calls, "sendMessage")).toEqual([
      "🌐 Searching the web for mono agent",
      "the answer",
    ]);
    expect(texts(calls, "editMessageText")).toEqual([]);
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload))
      .toEqual([{ chat_id: 42, message_id: 1000 }]);
    // The raw tool name never leaks into any outbound payload text.
    expect(calls.some((call) => String(call.payload.text).includes("WebSearch"))).toBe(false);
  });

  it("replaces hint-only bot runs with a separate final placeholder", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event({ type: "tool_call_started", id: "t1", name: "todoist" });
        return {};
      }),
    });

    await bot.handleUpdate(textUpdate("clean up todoist"));

    expect(texts(calls, "sendMessage")).toEqual([
      "🔧 Todoist",
      "No response text was returned\\.",
    ]);
    expect(texts(calls, "editMessageText")).toEqual([]);
    const finalSend = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(finalSend?.payload.parse_mode).toBe("MarkdownV2");
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload))
      .toEqual([{ chat_id: 42, message_id: 1000 }]);
  });

  it("preserves streamed bot answers when the responder returns no text", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("streamed answer");
        return {};
      }),
    });

    await bot.handleUpdate(textUpdate("stream only"));

    // Final-only delivery: the streamed answer is held back and delivered as a
    // single sendMessage at finish(), rendered as MarkdownV2 (no interim edits).
    expect(texts(calls, "editMessageText")).toEqual([]);
    const finalSend = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(finalSend?.payload.text).toBe("streamed answer");
    expect(finalSend?.payload.parse_mode).toBe("MarkdownV2");
  });

  it("does not reject a second concurrent message in the same chat (admits it in order)", async () => {
    const started: string[] = [];
    const firstFinish = createDeferred<{ text: string }>();
    const secondFinish = createDeferred<{ text: string }>();
    const received: string[] = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        received.push(request.text);
        if (received.length === 1) {
          started.push("first");
          return firstFinish.promise;
        }
        started.push("second");
        return secondFinish.promise;
      }),
    });

    const first = bot.handleUpdate(textUpdate("first"));
    // Wait until the first run is actually in the responder.
    while (started.length === 0) {
      await Promise.resolve();
    }

    // The follow-up is admitted, not rejected. With per-chat admission it is
    // serialized BEHIND the first run (the harness owns per-conversation order),
    // so it does not reach the responder until the first run settles.
    const second = bot.handleUpdate(textUpdate("second", { updateId: 2 }));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(received).toEqual(["first"]);

    // Release the first run; the second is then admitted in arrival order.
    firstFinish.resolve({ text: "done one" });
    while (received.length < 2) {
      await Promise.resolve();
    }
    expect(received).toEqual(["first", "second"]);
    // No "busy" rejection was sent for the follow-up.
    expect(
      texts(calls, "sendMessage").includes(
        "I am still working on your previous message. Use /cancel to stop it.",
      ),
    ).toBe(false);

    secondFinish.resolve({ text: "done two" });
    await first;
    await second;
  });

  it("steers the active Telegram run without starting another responder turn", async () => {
    const active = createDeferred<{ text: string }>();
    let respondCalls = 0;
    let offered: AgentLiveInputRequest | undefined;
    let settle!: (result: AgentLiveInputSettlement) => void;
    const settled = new Promise<AgentLiveInputSettlement>((resolve) => { settle = resolve; });
    const { bot, calls } = buildTestBot({
      reactions: { working: true, done: true, error: true },
      stream: { editDebounceMs: 0 },
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

    const first = bot.handleUpdate(textUpdate("long task", { messageId: 10 }));
    await vi.waitFor(() => expect(respondCalls).toBe(1));
    await bot.handleUpdate(textUpdate("steer now", { updateId: 2, messageId: 11 }));
    expect(offered).toMatchObject({
      conversationId: "telegram:42",
      id: "42:11",
      text: "steer now",
    });
    expect(respondCalls).toBe(1);
    expect(calls).toContainEqual(expect.objectContaining({
      method: "setMessageReaction",
      payload: expect.objectContaining({ chat_id: 42, message_id: 11, reaction: [{ type: "emoji", emoji: "👀" }] }),
    }));

    settle({ status: "applied", runId: "run-1" });
    active.resolve({ text: "steered answer" });
    await first;
    await vi.waitFor(() => expect(calls.filter(
      (call) => call.method === "setMessageReaction" && call.payload.message_id === 11,
    ).at(-1)?.payload.reaction).toEqual([{ type: "emoji", emoji: "👍" }]));
    expect(respondCalls).toBe(1);
    expect(texts(calls, "sendMessage")).toContain("steered answer");
  });

  it("admits same-chat turns in arrival order: a slow media message is not overtaken by a later text message", async () => {
    const received: string[] = [];
    const downloadGate = createDeferred<void>();
    const { bot, downloads } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        received.push(request.text);
        return { text: "ok" };
      }),
    });

    // The document download blocks on a gate, simulating a slow getFile/fetch.
    downloads.set("doc-file-id", {
      bytes: new TextEncoder().encode("doc bytes"),
      gate: downloadGate.promise,
    });

    // Media message first (its download stalls), then an immediate text-only
    // message in the SAME chat. Without admission serialization the text message
    // would skip the download branch and reach respond() first.
    const mediaTurn = bot.handleUpdate(documentUpdate({ caption: "look at this", updateId: 1 }));
    const textTurn = bot.handleUpdate(textUpdate("quick question", { updateId: 2 }));

    // Let the event loop spin: the text turn must NOT overtake the still-downloading
    // media turn while the gate is closed.
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(received).toEqual([]);

    // Release the download: now the media turn completes first, then the text turn.
    downloadGate.resolve();
    await mediaTurn;
    await textTurn;

    expect(received).toEqual(["look at this", "quick question"]);
  });

  it("/cancel aborts a same-chat message still parked in the admission queue", async () => {
    const received: string[] = [];
    const cancelCalls: string[] = [];
    const downloadGate = createDeferred<void>();
    const { bot, calls, downloads } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request) => {
          received.push(request.text);
          return { text: "ok" };
        },
        cancel: (conversationId) => {
          cancelCalls.push(conversationId);
        },
      },
    });
    // The media message's download stalls, so the text message parks behind it.
    downloads.set("doc-file-id", {
      bytes: new TextEncoder().encode("doc bytes"),
      gate: downloadGate.promise,
    });

    const mediaTurn = bot.handleUpdate(documentUpdate({ caption: "look at this", updateId: 1 }));
    const textTurn = bot.handleUpdate(textUpdate("quick question", { updateId: 2 }));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(received).toEqual([]);

    // /cancel arrives while the media turn downloads and the text turn is parked.
    // The text turn's controller is registered before admission, so it is aborted
    // even though it never reached the responder.
    await bot.handleUpdate(commandUpdate("/cancel", { updateId: 3 }));
    expect(cancelCalls).toEqual(["telegram:42"]);

    downloadGate.resolve();
    await mediaTurn;
    await textTurn;

    // Neither the cancelled active media turn nor the parked text turn reached the
    // responder — the parked message was genuinely cancelled, not run later.
    expect(received).toEqual([]);
    expect(texts(calls, "sendMessage").filter((text) => text === "Cancelled.")).toEqual([
      "Cancelled.",
    ]);
  });

  it("replies busyText for an over-cap same-chat flood without invoking the responder or leaking its controller", async () => {
    const received: string[] = [];
    const activeFinish = createDeferred<{ text: string }>();
    let activeStarted = false;
    const { bot, calls, activeControllerCount } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        received.push(request.text);
        if (received.length === 1) {
          activeStarted = true;
          // The first run blocks, holding the admission queue's active slot so the
          // flood parks behind it.
          return activeFinish.promise;
        }
        return { text: "ok" };
      }),
    });

    // One blocking active run takes the queue's running slot (depth 1).
    const activeRun = bot.handleUpdate(textUpdate("active", { updateId: 0 }));
    while (!activeStarted) {
      await Promise.resolve();
    }

    // The per-chat SerialQueue caps depth at 100. The active run holds 1 slot, so
    // 99 more same-chat messages fill the queue to the cap; the 100th queued
    // message (cap+1-th overall) must be rejected as busy.
    const maxDepth = 100;
    const fills: Array<Promise<void>> = [];
    for (let i = 0; i < maxDepth - 1; i += 1) {
      fills.push(bot.handleUpdate(textUpdate(`fill-${i}`, { updateId: i + 1 })));
    }
    // grammY dispatches each update through async middleware, so the fills reach
    // the queue across microtasks. Wait until every fill has registered its
    // controller (and thus incremented queue depth) so the queue is exactly at the
    // cap before the over-cap message is dispatched.
    await vi.waitFor(() => expect(activeControllerCount()).toBe(maxDepth));

    // Over-cap message: rejected synchronously by the queue (depth === cap). Its
    // runAgentTurn (the responder) is never invoked, and a busy reply is sent.
    await bot.handleUpdate(textUpdate("over-cap", { updateId: 999 }));

    // The over-cap message did not reach the responder (still only the active run).
    expect(received).toEqual(["active"]);
    // The busy terminal copy was replied.
    expect(texts(calls, "sendMessage")).toContain(
      "I am still working on your previous message. Use /cancel to stop it.",
    );

    // No controller leak: only the active run + the 99 genuinely-queued fills are
    // tracked (exactly maxDepth), NOT maxDepth + 1. The over-cap message's eager
    // controller was unregistered on the rejected path (runAgentTurn never ran).
    expect(activeControllerCount()).toBe(maxDepth);

    // Drain: release the active run so the fills resolve in order.
    activeFinish.resolve({ text: "done" });
    await activeRun;
    await Promise.all(fills);

    // After draining, every controller is unregistered (no orphan from the
    // rejected message; the run-through turns cleaned up in their finally).
    expect(activeControllerCount()).toBe(0);
  });

  it("bounds concurrent same-chat downloads: the second download does not start until the first turn settles", async () => {
    const firstDownloadGate = createDeferred<void>();
    const respondCount: number[] = [];
    const { bot, downloads, downloadedFileIds } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        respondCount.push(1);
        return { text: "ok" };
      }),
    });

    // Two same-chat media messages. The first download blocks on a gate; the
    // second carries a distinct file id so we can observe whether its download
    // started while the first was still in flight.
    downloads.set("doc-file-id", {
      bytes: new TextEncoder().encode("first"),
      gate: firstDownloadGate.promise,
    });

    const firstTurn = bot.handleUpdate(documentUpdate({ caption: "first", updateId: 1 }));
    const secondTurn = bot.handleUpdate(documentUpdate({ caption: "second", updateId: 2 }));

    // While the first download is gated, the second must NOT have started its
    // download (serialized admission bounds concurrent same-chat downloads).
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(downloadedFileIds).toEqual(["doc-file-id"]);

    firstDownloadGate.resolve();
    await firstTurn;
    await secondTurn;

    // Both downloads ran (same file id since documentUpdate reuses it), strictly
    // in sequence — two invocations total.
    expect(downloadedFileIds).toEqual(["doc-file-id", "doc-file-id"]);
    expect(respondCount).toHaveLength(2);
  });

  it("does not fire a buffered album turn after stop() clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const requests: string[] = [];
      const { bot, calls, stop } = buildTestBot({
        // Use the default (non-zero) quiet window so the album timer is pending.
        responder: responderFrom(async (request) => {
          requests.push(request.text);
          return { text: "should not run" };
        }),
      });

      // Buffer an album so a flush timer is live.
      await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p1", caption: "hi", updateId: 1, messageId: 10 }));
      await bot.handleUpdate(albumPhotoUpdate({ groupId: "AG1", fileId: "p2", updateId: 2, messageId: 11 }));

      // Stop the channel, then advance past the quiet window: the pending timer
      // must be cleared and the stopped guard must prevent any turn from firing.
      await stop();
      await vi.advanceTimersByTimeAsync(2000);

      expect(requests).toEqual([]);
      expect(texts(calls, "sendMessage")).toEqual([]);

      // A fresh update delivered after stop() is also ignored (stopped guard).
      await bot.handleUpdate(textUpdate("post-stop", { updateId: 3 }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(requests).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-text messages as unsupported", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(stickerUpdate());

    expect(texts(calls, "sendMessage")).toEqual([
      "I can handle text and Telegram document, photo, audio, video, round video, or voice metadata in this adapter.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("rejects Telegram animation documents as unsupported", async () => {
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const { bot, calls } = buildTestBot({ responder });

    await bot.handleUpdate(animationUpdate());

    expect(texts(calls, "sendMessage")).toEqual([
      "I can handle text and Telegram document, photo, audio, video, round video, or voice metadata in this adapter.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("treats media captions with /cancel as control commands", async () => {
    let capturedSignal: AbortSignal | undefined;
    const started = createDeferred<void>();
    const cancelCalls: string[] = [];
    const responder: AgentResponder = {
      respond: async (request) =>
        await new Promise<{ text: string }>((resolve) => {
          capturedSignal = request.abortSignal;
          request.abortSignal.addEventListener(
            "abort",
            () => resolve({ text: "should not be used" }),
            { once: true },
          );
          started.resolve();
        }),
      cancel: (conversationId) => {
        cancelCalls.push(conversationId);
      },
    };
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder,
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    await started.promise;

    await bot.handleUpdate(documentUpdate({ caption: "/cancel", updateId: 2 }));

    // /cancel clears queued follow-ups via responder.cancel AND aborts the live run.
    expect(cancelCalls).toEqual(["telegram:42"]);
    expect(capturedSignal?.aborted).toBe(true);
    await first;
    const cancelledSends = calls
      .filter((call) => call.method === "sendMessage" && call.payload.text === "Cancelled.");
    expect(cancelledSends).toHaveLength(1);
    const cancelledSend = cancelledSends[0];
    expect(cancelledSend?.payload.parse_mode).toBeUndefined();
  });

  it("ignores media caption commands targeted at another bot", async () => {
    const signals: AbortSignal[] = [];
    const received: string[] = [];
    const finishers: Array<(value: { text: string }) => void> = [];
    const { bot } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        signals.push(request.abortSignal);
        received.push(request.text);
        return await new Promise<{ text: string }>((resolve) => {
          finishers.push(resolve);
        });
      }),
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    while (received.length === 0) {
      await Promise.resolve();
    }

    // A caption command aimed at another bot is NOT our /cancel, so it is treated
    // as an ordinary media message and reaches the responder (no busy rejection,
    // no cancellation of the in-flight run). Per-chat admission serializes it
    // behind the in-flight run, so it reaches the responder only after the first
    // settles — crucially without aborting the first run's signal.
    const second = bot.handleUpdate(documentUpdate({ caption: "/cancel@OtherBot", updateId: 2 }));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    // The in-flight run was not cancelled by the other-bot caption command.
    expect(signals[0]?.aborted).toBe(false);
    expect(received).toEqual(["long task"]);

    // Release the first run; the second is then admitted as ordinary media.
    finishers[0]?.({ text: "done" });
    while (received.length < 2) {
      await Promise.resolve();
    }

    expect(signals.every((signal) => signal.aborted === false)).toBe(true);

    finishers.forEach((resolve) => resolve({ text: "done" }));
    await first;
    await second;
  });

  it("finishes with plain cancelled text when the responder reports cancellation", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    await bot.handleUpdate(textUpdate("please stop"));

    // Final-only delivery: the cancelled copy arrives as a single PLAIN
    // sendMessage (no MarkdownV2 parse_mode), with no interim edits.
    expect(texts(calls, "editMessageText")).toEqual([]);
    const finalSend = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(finalSend?.payload.text).toBe("Cancelled.");
    expect(finalSend?.payload.parse_mode).toBeUndefined();
  });

  it("lets hosts derive terminal error text from responder failure details", async () => {
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      messages: {
        errorText: ({ error, request }) => {
          const failure = (error as { failure?: { kind?: string } }).failure;
          return failure?.kind === "usage_limit"
            ? `I hit the turn limit while handling "${request.text}".`
            : "I could not complete that message.";
        },
      },
      responder: responderFrom(async () => {
        throw Object.assign(new Error("Provider limit"), {
          failure: { kind: "usage_limit", message: "Provider limit" },
        });
      }),
    });

    await bot.handleUpdate(textUpdate("check calendar"));

    // Final-only delivery: the host-derived error text arrives as a single
    // PLAIN sendMessage.
    const finalSend = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(finalSend?.payload.text).toBe('I hit the turn limit while handling "check calendar".');
    expect(finalSend?.payload.parse_mode).toBeUndefined();
  });

  it("aborts the active run when /cancel is received and acks it", async () => {
    let capturedSignal: AbortSignal | undefined;
    const started = createDeferred<void>();
    const cancelCalls: Array<{ conversationId: string; reason: unknown }> = [];
    const { bot, calls } = buildTestBot({
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request, stream) => {
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
            started.resolve();
          });
        },
        cancel: (conversationId, reason) => {
          cancelCalls.push({ conversationId, reason });
        },
      },
    });

    const first = bot.handleUpdate(textUpdate("long task"));
    await started.promise;

    await bot.handleUpdate(commandUpdate("/cancel", { updateId: 2 }));

    // /cancel clears queued follow-ups via responder.cancel and aborts the live run.
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.conversationId).toBe("telegram:42");
    expect(isChannelUserCancelReason(cancelCalls[0]?.reason)).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    await first;

    // The command owns the only plain cancellation acknowledgement. The aborted
    // in-flight turn stays silent.
    expect(texts(calls, "editMessageText")).toEqual([]);
    const cancelledSends = calls
      .filter((call) => call.method === "sendMessage" && call.payload.text === "Cancelled.");
    expect(cancelledSends).toHaveLength(1);
    const cancelledSend = cancelledSends[0];
    expect(cancelledSend?.payload.parse_mode).toBeUndefined();
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload))
      .toEqual([{ chat_id: 42, message_id: 1000 }]);
  });

  it("acknowledges /cancel exactly once while a proactive turn is active", async () => {
    const started = createDeferred<void>();
    const { bot, controller, calls } = buildTestBot({
      responder: responderFrom(
        async (request) =>
          await new Promise<{ text: string }>((resolve) => {
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            started.resolve();
          }),
      ),
    });

    const proactive = controller.notify(42, "scheduled nudge");
    await started.promise;
    await bot.handleUpdate(commandUpdate("/cancel", { updateId: 2 }));

    await expect(proactive).resolves.toEqual({ delivered: false, reason: "cancelled" });
    expect(texts(calls, "sendMessage").filter((text) => text === "Cancelled.")).toEqual([
      "Cancelled.",
    ]);
  });

  it("does not throw when every delivery path fails after a successful run", async () => {
    const errors: string[] = [];
    const logger: TelegramAdapterLogger = {
      error: (message) => errors.push(message),
    };
    const { bot, failures } = buildTestBot({
      stream: { editDebounceMs: 0 },
      logger,
      responder: responderFrom(async () => ({ text: "the real answer" })),
    });

    // Editing always fails fatally (no retry, no recreate) — final-only mode does
    // not edit, but this guards any future interim path too.
    failures.set("editMessageText", () => err(403, "Forbidden: bot was blocked by the user"));
    // Final-only delivery posts the answer with a single sendMessage at finish();
    // every send fails, so there is no delivery path left.
    failures.set("sendMessage", () => err(403, "Forbidden: bot was blocked by the user"));

    // The AI run succeeded, so a delivery failure must not throw out of the handler.
    await expect(bot.handleUpdate(textUpdate("hello"))).resolves.toBeUndefined();
    expect(errors.some((message) => message.includes("final delivery"))).toBe(true);
  });

  it("reports a post-start polling crash without leaking nested Bot API tokens", async () => {
    const crashes: unknown[] = [];
    const token = "123456789:AAExampleSecret_0123456789abcdef";
    const apiUrl = `https://api.telegram.org/bot${token}/getUpdates`;
    const logs: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    const failure = Object.assign(new Error(`polling crashed at ${apiUrl}`, {
      cause: { request: { url: apiUrl, token } },
    }), {
      request: { url: apiUrl },
    });
    const controller = createTelegramBot({
      botToken: token,
      allowAllChats: true,
      responder: responderFrom(async () => ({ text: "ok" })),
      onPollingError: (error) => crashes.push(error),
      logger: {
        error: (message, metadata) => logs.push(
          metadata === undefined ? { message } : { message, metadata },
        ),
      },
      botFactory: () => {
        const bot = new Bot(token, { botInfo: FAKE_BOT_INFO });
        bot.api.config.use(async () => ok(true));
        return bot;
      },
      runnerFactory: () => ({
        start: () => undefined,
        stop: () => Promise.resolve(),
        size: () => 0,
        isRunning: () => true,
        task: () => Promise.reject(failure),
      }),
    });

    await controller.start();
    // Let the task().catch microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toBeInstanceOf(Error);
    expect((crashes[0] as Error).message).toContain("polling crashed");
    expect((crashes[0] as Error).message).not.toContain(token);
    expect(JSON.stringify(crashes)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).toContain("[REDACTED_TELEGRAM_BOT_TOKEN]");
    await controller.stop();
  });

  it("still schedules polling recovery when redaction inputs and the host callback are hostile", async () => {
    vi.useFakeTimers();
    try {
      let runnerFactories = 0;
      const failure = new Error("polling crashed");
      Object.defineProperty(failure, "throwing", {
        enumerable: true,
        get: () => { throw new Error("getter failed"); },
      });
      const controller = createTelegramBot({
        botToken: "test-token",
        allowAllChats: true,
        responder: responderFrom(async () => ({ text: "ok" })),
        onPollingError: () => { throw new Error("host callback failed"); },
        logger: { error: () => { throw new Error("logger failed"); } },
        botFactory: () => {
          const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
          bot.api.config.use(async () => ok(true));
          return bot;
        },
        runnerFactory: () => {
          runnerFactories += 1;
          const first = runnerFactories === 1;
          return {
            start: () => undefined,
            stop: () => Promise.resolve(),
            size: () => 0,
            isRunning: () => true,
            task: () => first ? Promise.reject(failure) : new Promise<void>(() => {}),
          };
        },
      });

      await controller.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(runnerFactories).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(runnerFactories).toBe(2);
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms message handling after stop() + start() (a message after restart IS handled)", async () => {
    const received: string[] = [];
    const sent: unknown[] = [];
    // A stateful fake runner whose isRunning() reflects start/stop so the
    // restart guard in start() behaves like the real runner.
    const makeRunner = () => {
      let running = false;
      return {
        start: () => { running = true; },
        stop: () => { running = false; return Promise.resolve(); },
        size: () => 0,
        isRunning: () => running,
        task: () => Promise.resolve(),
      };
    };
    const controller = createTelegramBot({
      botToken: "test-token",
      allowAllChats: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        received.push(request.text);
        return { text: "ok" };
      }),
      botFactory: () => {
        const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
        bot.api.config.use(async (_prev, method, payload) => {
          const typedPayload = payload as Record<string, unknown>;
          if (method === "sendMessage") {
            sent.push(typedPayload.text);
            return ok({
              message_id: 1,
              date: 0,
              chat: { id: typedPayload.chat_id, type: "private" },
              text: typedPayload.text,
            });
          }
          return ok(true);
        });
        return bot;
      },
      runnerFactory: () => {
        const runner = makeRunner();
        runner.start();
        return runner;
      },
    });

    // First start: a message is handled and a reply is sent.
    await controller.start();
    await controller.bot.handleUpdate(textUpdate("before stop", { updateId: 1 }));
    expect(received).toEqual(["before stop"]);
    expect(sent).toContain("ok");

    // Stop latches `stopped = true`.
    await controller.stop();

    // Restart MUST reset the latch so the next message is handled (regresses to a
    // silent drop before the fix).
    await controller.start();
    await controller.bot.handleUpdate(textUpdate("after restart", { updateId: 2 }));
    expect(received).toEqual(["before stop", "after restart"]);

    await controller.stop();
  });
});

describe("createTelegramBot default file downloader (streaming cap + timeout)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  // Drive the DEFAULT downloader (no fileDownloaderFactory) through the bot. The
  // botFactory transformer answers getFile with a file_path so resolveFilePath
  // succeeds; the body bytes come from a stubbed global.fetch. A successfully
  // downloaded attachment appears on request.attachments; a cap/timeout skip
  // leaves it undefined (the run still proceeds).
  function buildDefaultDownloaderBot(options: {
    responder: AgentResponder;
    attachments?: CreateTelegramBotOptions["attachments"];
  }): { bot: Bot } {
    const controller = createTelegramBot({
      botToken: "test-token",
      allowAllChats: true,
      responder: options.responder,
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      botFactory: () => {
        const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
        bot.api.config.use(async (_prev, method, payload) => {
          const typed = payload as Record<string, unknown>;
          if (method === "getFile") {
            return ok({ file_id: typed.file_id, file_unique_id: "u", file_path: "docs/file.bin" });
          }
          if (method === "sendMessage") {
            return ok({ message_id: 1, date: 0, chat: { id: typed.chat_id, type: "private" }, text: typed.text });
          }
          if (method === "editMessageText") {
            return ok({ message_id: typed.message_id ?? 0, date: 0, chat: { id: typed.chat_id, type: "private" }, text: typed.text });
          }
          return ok(true);
        });
        return bot;
      },
    });
    return { bot: controller.bot };
  }

  function streamResponse(chunks: Uint8Array[], pulled: number[], init?: ResponseInit): Response {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        const chunk = chunks[i];
        if (chunk === undefined) {
          streamController.close();
          return;
        }
        pulled.push(i);
        streamController.enqueue(chunk);
        i += 1;
      },
    });
    return new Response(stream, init);
  }

  it("streams with a byte cap and cancels the reader before buffering the whole body", async () => {
    const requests: AgentRequest[] = [];
    const pulled: number[] = [];
    // Three 4-byte chunks (12 bytes) exceed a 6-byte cap; no Content-Length so the
    // early-skip does not short-circuit it.
    const chunks = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)];
    globalThis.fetch = vi.fn(async () => streamResponse(chunks, pulled)) as unknown as typeof fetch;

    const { bot } = buildDefaultDownloaderBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      attachments: { maxBytes: 6 },
    });

    await bot.handleUpdate(documentUpdate({ caption: "big" }));

    // The download exceeded the cap and was skipped; the run still proceeded.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments).toBeUndefined();
    // Not all chunks were pulled: the reader was cancelled once the cap tripped.
    expect(pulled.length).toBeLessThan(chunks.length);
  });

  it("early-skips a download whose Content-Length exceeds the cap without reading the body", async () => {
    const requests: AgentRequest[] = [];
    const pulled: number[] = [];
    const chunks = [new Uint8Array(4)];
    globalThis.fetch = vi.fn(
      async () => streamResponse(chunks, pulled, { headers: { "content-length": "999999" } }),
    ) as unknown as typeof fetch;

    const { bot } = buildDefaultDownloaderBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      attachments: { maxBytes: 6 },
    });

    await bot.handleUpdate(documentUpdate({ caption: "declared big" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments).toBeUndefined();
    // The body reader was never pulled — the Content-Length early-skip threw first.
    expect(pulled).toEqual([]);
  });

  it("aborts a stalled download via the composed download timeout", async () => {
    vi.useFakeTimers();
    const requests: AgentRequest[] = [];
    let abortedByTimeout = false;
    // A fetch that never resolves until its signal aborts.
    globalThis.fetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          abortedByTimeout = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const { bot } = buildDefaultDownloaderBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      attachments: { maxBytes: 1_000_000, downloadTimeoutMs: 50 },
    });

    const turn = bot.handleUpdate(documentUpdate({ caption: "stalled" }));
    await vi.advanceTimersByTimeAsync(60);
    await turn;

    expect(abortedByTimeout).toBe(true);
    // The download timed out and was skipped; the run still proceeded.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments).toBeUndefined();
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
    while (!aStarted) {
      await Promise.resolve();
    }

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

describe("createTelegramBot pending asks and status posts", () => {
  it("consumes a plain text reply as the pending ask's answer instead of running a turn", async () => {
    const requests: AgentRequest[] = [];
    const snapshot = askSnapshot();
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const { bot, calls } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "turn" };
      }),
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });

    await bot.handleUpdate(textUpdate("Alice and Bob, in Polish"));

    expect(submitAskAnswers).toHaveBeenCalledWith({
      conversationId: "telegram:42",
      interactionId: snapshot.interactionId,
      answers: [{ questionId: "q0", selectedOptionIds: [], customReply: "Alice and Bob, in Polish" }],
    });
    expect(requests).toHaveLength(0);
    expect(reactionEmojis(calls)).toContain("👍");
  });

  it("does not run a deadlocking turn when a pending AskUser submission is rejected", async () => {
    const requests: AgentRequest[] = [];
    const snapshot = askSnapshot();
    const submitAskAnswers = vi.fn(async () => ({ accepted: false, code: "stale" as const, snapshot }));
    const { bot, calls } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "turn" };
      }),
      pendingAsks: {
        getPendingAsk: vi.fn(async () => snapshot),
        submitAskAnswers,
        cancel: vi.fn(),
      },
    });

    await bot.handleUpdate(textUpdate("please approve this way"));

    expect(submitAskAnswers).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(
      calls.some(
        (call) =>
          call.method === "sendMessage" &&
          call.payload.text === "I am still working on your previous message. Use /cancel to stop it.",
      ),
    ).toBe(true);
  });

  it("runs a normal turn when the interceptor reports no pending ask", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = buildTestBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "turn" };
      }),
      pendingAsks: {
        getPendingAsk: vi.fn(async () => undefined),
        submitAskAnswers: vi.fn(async () => ({ accepted: false, code: "not_found" as const })),
        cancel: vi.fn(),
      },
    });

    await bot.handleUpdate(textUpdate("just a normal message"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe("just a normal message");
  });

  it("does not consume media messages or slash commands as ask answers", async () => {
    const getPendingAsk = vi.fn(async () => askSnapshot());
    const { bot } = buildTestBot({
      responder: responderFrom(async () => ({ text: "turn" })),
      pendingAsks: {
        getPendingAsk,
        submitAskAnswers: vi.fn(async () => ({ accepted: true, snapshot: askSnapshot() })),
        cancel: vi.fn(),
      },
    });

    await bot.handleUpdate(voiceUpdate());
    await bot.handleUpdate(textUpdate("/unknowncommand", { updateId: 2 }));

    expect(getPendingAsk).not.toHaveBeenCalled();
  });

  it("cancels the pending ask on /cancel", async () => {
    const cancel = vi.fn();
    const { bot, calls } = buildTestBot({
      responder: responderFrom(async () => ({ text: "turn" })),
      pendingAsks: {
        getPendingAsk: vi.fn(async () => undefined),
        submitAskAnswers: vi.fn(async () => ({ accepted: false, code: "not_found" as const })),
        cancel,
      },
    });

    await bot.handleUpdate(commandUpdate("/cancel"));

    expect(cancel).toHaveBeenCalledWith("telegram:42");
    expect(texts(calls, "sendMessage").filter((text) => text === "Cancelled.")).toEqual([
      "Cancelled.",
    ]);
  });

  it("presents AskUser context and controls, then updates the same message", async () => {
    const { controller, calls } = buildTestBot({
      responder: responderFrom(async () => ({ text: "turn" })),
    });
    const snapshot = askSnapshot();

    await controller.presentAsk(42, snapshot);
    await controller.updateAsk(42, { ...snapshot, status: "answered", answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }] });

    expect(texts(calls, "sendMessage")).toEqual(["Draft reply", expect.stringContaining("Delivery · 1/1")]);
    expect(texts(calls, "editMessageText")).toEqual(["Answer recorded."]);
  });

  it("edits a keyed status message in place and starts fresh after a terminal state", async () => {
    const { controller, calls } = buildTestBot({
      responder: responderFrom(async () => ({ text: "turn" })),
    });

    await controller.postStatus(42, "Transcribing… 10%", { key: "job", state: "working" });
    await controller.postStatus(42, "Transcribing… 90%", { key: "job", state: "working" });
    await controller.postStatus(42, "Transcript ready.", { key: "job", state: "done" });
    // Terminal state cleared the tracking: the same key posts a NEW message.
    await controller.postStatus(42, "Second run…", { key: "job", state: "working" });

    expect(texts(calls, "sendMessage")).toEqual(["Transcribing… 10%", "Second run…"]);
    expect(texts(calls, "editMessageText")).toEqual(["Transcribing… 90%", "Transcript ready."]);
  });
});

describe("buildTelegramBotClientOptions", () => {
  it("defaults to the api timeout only", () => {
    const built = buildTelegramBotClientOptions({});
    expect(built.client).toEqual({ timeoutSeconds: 50 });
    expect(built.agent).toBeUndefined();
  });

  it("sets apiRoot for a self-hosted server", () => {
    const built = buildTelegramBotClientOptions({ apiRoot: "http://127.0.0.1:8081" });
    expect(built.client.apiRoot).toBe("http://127.0.0.1:8081");
  });

  it("keeps the family-locked agent https for the hosted API", () => {
    const built = buildTelegramBotClientOptions({ ipFamily: 4 });
    expect(built.agent).toBeInstanceOf(HttpsAgent);
    expect((built.client.baseFetchConfig as { agent?: unknown } | undefined)?.agent).toBe(built.agent);
  });

  it("switches to an http agent when the apiRoot is plain http (node-fetch rejects protocol-mismatched agents)", () => {
    const built = buildTelegramBotClientOptions({ ipFamily: 4, apiRoot: "http://127.0.0.1:8081" });
    expect(built.agent).toBeInstanceOf(HttpAgent);
    expect((built.client.baseFetchConfig as { agent?: unknown } | undefined)?.agent).toBe(built.agent);
  });
});

describe("createTelegramBot default file downloader (self-hosted server)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function buildApiRootBot(options: {
    responder: AgentResponder;
    filePath: string;
    apiRoot?: string;
    attachments?: CreateTelegramBotOptions["attachments"];
  }): { bot: Bot } {
    const controller = createTelegramBot({
      botToken: "test-token",
      allowAllChats: true,
      responder: options.responder,
      ...(options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      botFactory: () => {
        const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
        bot.api.config.use(async (_prev, method, payload) => {
          const typed = payload as Record<string, unknown>;
          if (method === "getFile") {
            return ok({ file_id: typed.file_id, file_unique_id: "u", file_path: options.filePath });
          }
          if (method === "sendMessage") {
            return ok({ message_id: 1, date: 0, chat: { id: typed.chat_id, type: "private" }, text: typed.text });
          }
          return ok(true);
        });
        return bot;
      },
    });
    return { bot: controller.bot };
  }

  it("reads a --local absolute file_path from disk and deletes the daemon copy after the read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-local-"));
    const filePath = join(dir, "recording.m4a");
    writeFileSync(filePath, "LOCALDAT");
    // Any HTTP fetch would be a bug on this branch.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected HTTP fetch in local mode");
    }) as unknown as typeof fetch;
    const requests: AgentRequest[] = [];

    const { bot } = buildApiRootBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      filePath,
      apiRoot: "http://127.0.0.1:8081",
    });
    await bot.handleUpdate(documentUpdate({ mimeType: "audio/mp4" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments?.[0]?.data).toBe(Buffer.from("LOCALDAT").toString("base64"));
    // The daemon copy is a drained cache once the bytes are consumed.
    expect(existsSync(filePath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips an over-cap local file via stat (stale declared size) and leaves it on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-local-"));
    const filePath = join(dir, "big.m4a");
    // Declared file_size in the update is 12,345 (under the cap); the REAL file is
    // larger — the stat check must trip where the declared-size check cannot.
    writeFileSync(filePath, Buffer.alloc(30_000));
    const requests: AgentRequest[] = [];

    const { bot } = buildApiRootBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      filePath,
      apiRoot: "http://127.0.0.1:8081",
      attachments: { maxBytes: 20_000 },
    });
    await bot.handleUpdate(documentUpdate({ mimeType: "audio/mp4" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments).toBeUndefined();
    // Skips never delete: only a consumed read drains the daemon copy.
    expect(existsSync(filePath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips a missing (expired) local file and the run proceeds", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = buildApiRootBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      filePath: "/nonexistent/expired/recording.m4a",
      apiRoot: "http://127.0.0.1:8081",
    });
    await bot.handleUpdate(documentUpdate({ mimeType: "audio/mp4" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachments).toBeUndefined();
  });

  it("builds the file URL from apiRoot for a relative file_path (non-local self-hosted server)", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const requests: AgentRequest[] = [];

    const { bot } = buildApiRootBot({
      responder: responderFrom(async (request) => {
        requests.push(request);
        return { text: "ok" };
      }),
      filePath: "docs/file.bin",
      apiRoot: "http://127.0.0.1:8081",
    });
    await bot.handleUpdate(documentUpdate({ mimeType: "audio/mp4" }));

    expect(urls).toEqual(["http://127.0.0.1:8081/file/bottest-token/docs/file.bin"]);
    expect(requests[0]?.attachments).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";

import {
  MODULE_API_VERSION,
  defineChannelModule,
  type Channel,
  type ChannelAttachment,
  type ChannelInboundRequest,
  type ChannelModuleCreateContext,
  type ChannelReplyEvent,
  type ChannelReplySink,
  type ChannelTurnResult,
  type AskUserRequest,
  type ModuleHealth,
} from "@mono-agent/module-sdk";

import { createTelegramBotApiClient, type TelegramBotClient, type TelegramBotClientFactory, type TelegramMessageUpdate, type TelegramUpdate } from "./bot.js";
import { type TelegramConfig, telegramConfigSchema } from "./config.js";
import { TelegramDelivery } from "./delivery.js";
import {
  createTelegramSendTools,
  type TelegramChannelSendTool,
} from "./send-tools.js";

const PACKAGE_NAME = "@mono-agent/channel-telegram";
const PACKAGE_VERSION = "0.15.0";
const STOP_TIMEOUT_MS = 1_000;
const MAX_PENDING_ASKS = 1_000;
const MAX_CALLBACK_ANSWERS = 10_000;
const MAX_RUNTIME_SELECTIONS = 1_000;
const TRANSCRIPTION_UNAVAILABLE = "[Automatic transcription unavailable; audio attachment retained.]";

interface PendingTelegramAsk {
  readonly ask: AskUserRequest;
  readonly answers: Record<string, readonly string[]>;
  readonly done: Set<string>;
  readonly tokens: Set<string>;
}

interface TelegramCallbackAnswer {
  readonly chatId: string;
  readonly interactionId: string;
  readonly questionId: string;
  readonly value?: string;
  readonly done: boolean;
}

interface TelegramRuntimeSelection {
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface TelegramChannel extends Channel {
  readonly running: boolean;
  readonly sendTools: readonly TelegramChannelSendTool[];
}

export interface CreateTelegramChannelOptions {
  readonly context: ChannelModuleCreateContext<TelegramConfig>;
  readonly clientFactory?: TelegramBotClientFactory;
}

export const monoAgentModule = defineChannelModule({
  manifest: {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "channel",
    responsibility: "Maps Telegram Bot API updates and deliveries onto normalized channel turns.",
    capabilities: [],
  },
  schema: telegramConfigSchema,
  create(context) { return createTelegramChannel({ context }); },
});

export function createTelegramChannel(options: CreateTelegramChannelOptions): TelegramChannel {
  const { context } = options;
  const client = (options.clientFactory ?? ((config) => createTelegramBotApiClient(config)))(context.config);
  const delivery = new TelegramDelivery(context.config, client);
  const sendTools = createTelegramSendTools(context.config);
  let lifecycle: AbortController | undefined;
  let polling: Promise<void> | undefined;
  let offset = 0;
  let running = false;
  let stopped = false;
  let active = 0;
  let lastError: string | undefined;
  const pendingAsks = new Map<string, PendingTelegramAsk>();
  const callbackAnswers = new Map<string, TelegramCallbackAnswer>();
  const runtimeSelections = new Map<string, TelegramRuntimeSelection>();

  const clearPendingAsk = (chatId: string): void => {
    const pending = pendingAsks.get(chatId);
    if (pending !== undefined) for (const token of pending.tokens) callbackAnswers.delete(token);
    pendingAsks.delete(chatId);
  };

  const rememberCallback = (token: string, answer: TelegramCallbackAnswer, pending: PendingTelegramAsk): void => {
    callbackAnswers.set(token, answer);
    pending.tokens.add(token);
    while (callbackAnswers.size > MAX_CALLBACK_ANSWERS) {
      const oldest = callbackAnswers.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      callbackAnswers.delete(oldest);
    }
  };

  const rememberAsk = (chatId: string, ask: AskUserRequest): PendingTelegramAsk => {
    clearPendingAsk(chatId);
    const pending: PendingTelegramAsk = { ask, answers: {}, done: new Set(), tokens: new Set() };
    pendingAsks.set(chatId, pending);
    while (pendingAsks.size > MAX_PENDING_ASKS) {
      const oldest = pendingAsks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      clearPendingAsk(oldest);
    }
    return pending;
  };

  const authorized = (chatId: string): boolean => context.config.allowAllChats || context.config.allowedChatIds.includes(chatId);

  const processUpdate = async (update: TelegramUpdate, signal: AbortSignal): Promise<void> => {
    if (!authorized(update.chatId)) return;
    if (update.kind === "callback") {
      const replyText = decodeReplyCallback(update.data);
      if (replyText !== undefined) {
        await client.answerCallback?.(update.callbackId, signal).catch(() => undefined);
        await processUpdate({
          updateId: update.updateId,
          kind: "message",
          chatId: update.chatId,
          messageId: update.messageId,
          senderId: update.senderId,
          text: replyText,
          attachments: [],
          receivedAt: update.receivedAt,
        }, signal);
        return;
      }
      const answer = callbackAnswers.get(update.data);
      if (answer !== undefined && answer.chatId === update.chatId && context.host.answerAsk !== undefined) {
        const pending = pendingAsks.get(update.chatId);
        if (pending !== undefined && pending.ask.interactionId === answer.interactionId) {
          callbackAnswers.delete(update.data);
          pending.tokens.delete(update.data);
          if (answer.value !== undefined) pending.answers[answer.questionId] = pending.ask.questions.find((question) => question.id === answer.questionId)?.multiple === true ? [...(pending.answers[answer.questionId] ?? []), answer.value] : [answer.value];
          if (answer.done || pending.ask.questions.find((question) => question.id === answer.questionId)?.multiple !== true) pending.done.add(answer.questionId);
          if (await maybeAnswerAsk(context, update.chatId, pending, signal)) clearPendingAsk(update.chatId);
        }
      }
      await client.answerCallback?.(update.callbackId, signal).catch(() => undefined);
      return;
    }
    active += 1;
    try {
      await react(client, context.config.reactions.working, update, "👀", signal);
      const pendingAsk = pendingAsks.get(update.chatId);
      if (pendingAsk !== undefined && context.host.answerAsk !== undefined) {
        const question = pendingAsk.ask.questions.find((candidate) => !pendingAsk.done.has(candidate.id));
        if (question !== undefined && question.allowFreeText && update.text.trim().length > 0) {
          pendingAsk.answers[question.id] = [update.text];
          pendingAsk.done.add(question.id);
          if (await maybeAnswerAsk(context, update.chatId, pendingAsk, signal)) clearPendingAsk(update.chatId);
          return;
        }
      }
      if (update.text.trim() === "/cancel" && context.host.cancel !== undefined) {
        await context.host.cancel({ conversationId: `telegram:${update.chatId}`, reason: "Telegram user requested cancellation.", signal });
        return;
      }
      const command = runtimeCommand(update.text);
      if (command !== undefined) {
        const selection = updateRuntimeSelection(runtimeSelections.get(update.chatId), command);
        rememberRuntimeSelection(runtimeSelections, update.chatId, selection);
        await client.sendMessage({
          chatId: update.chatId,
          text: runtimeConfirmation(command, selection),
          replyToMessageId: update.messageId,
          signal,
        });
        return;
      }
      if (/^\/help(?:@\S+)?\s*$/u.test(update.text.trim())) {
        await client.sendMessage({
          chatId: update.chatId,
          text: "Commands: /model <id|default>, /effort <level|default>, /cancel, /help",
          replyToMessageId: update.messageId,
          signal,
        });
        return;
      }
      if (context.host.offerLiveInput !== undefined && update.text.length > 0 && update.attachments.length === 0) {
        const offered = await context.host.offerLiveInput({ conversationId: `telegram:${update.chatId}`, id: `telegram:${update.updateId}`, text: update.text, receivedAt: update.receivedAt, signal });
        if (offered.status === "applied" || offered.status === "discarded") return;
      }
      const attachments: ChannelAttachment[] = [];
      const transcriptNotes: string[] = [];
      for (const attachment of update.attachments) {
        const downloaded = await client.download(attachment, context.config.maxAttachmentBytes, signal);
        attachments.push(downloaded);
        if (attachment.transcriptionEligible === true && client.transcribe !== undefined) {
          try {
            transcriptNotes.push(`[Transcript of ${downloaded.name}]\n${await client.transcribe(downloaded, signal)}`);
          } catch (error) {
            if (signal.aborted) throw error;
            transcriptNotes.push(`${TRANSCRIPTION_UNAVAILABLE} (${downloaded.name})`);
            context.logger.warn("Telegram automatic transcription failed.", {
              instanceId: context.instanceId,
              chatId: update.chatId,
              attachmentId: downloaded.id,
            });
          }
        }
      }
      const normalizedText = [update.text, ...transcriptNotes].filter((part) => part.length > 0).join("\n\n");
      let replyText = "";
      let activityMessageId: string | undefined;
      const reply: ChannelReplySink = {
        async emit(event: ChannelReplyEvent): Promise<void> {
          if (event.type === "text-delta") replyText += event.delta;
          else if (event.type === "text-replace") replyText = event.text;
          else if (event.type === "activity" && event.text.length > 0) {
            if (activityMessageId !== undefined && client.editMessage !== undefined) {
              await client.editMessage({ chatId: update.chatId, messageId: activityMessageId, text: event.text, signal });
            } else {
              activityMessageId = (await client.sendMessage({
                chatId: update.chatId,
                text: event.text,
                replyToMessageId: update.messageId,
                signal,
              })).messageId;
            }
          } else if (event.type === "attachment") {
            await client.sendAttachment({ chatId: update.chatId, attachment: event.attachment, signal });
          } else if (event.type === "ask-user" && context.host.answerAsk !== undefined) {
            const pending = rememberAsk(update.chatId, event.ask);
            for (const question of event.ask.questions) {
              const buttons = (question.choices ?? []).slice(0, 8).map((choice) => {
                const token = `ask:${randomUUID().slice(0, 12)}`;
                rememberCallback(token, { chatId: update.chatId, interactionId: event.ask.interactionId, questionId: question.id, value: choice.value, done: false }, pending);
                return { label: choice.label, data: token };
              });
              if (question.multiple) {
                const token = `ask:${randomUUID().slice(0, 12)}`;
                rememberCallback(token, { chatId: update.chatId, interactionId: event.ask.interactionId, questionId: question.id, done: true }, pending);
                buttons.push({ label: "Done", data: token });
              }
              await client.sendMessage({ chatId: update.chatId, text: question.prompt, replyToMessageId: update.messageId, ...(buttons.length === 0 ? {} : { buttons }), signal });
            }
          }
        },
      };
      const request = inbound(
        context.instanceId,
        update,
        normalizedText,
        attachments,
        runtimeSelections.get(update.chatId),
        signal,
      );
      const result = await context.host.dispatch(request, reply);
      const final = result.text ?? replyText;
      if (result.status === "completed" && final.length > 0) {
        await client.sendMessage({ chatId: update.chatId, text: final, replyToMessageId: update.messageId, signal });
        await react(client, context.config.reactions.done, update, "👍", signal);
      } else if (result.status === "rejected") {
        await react(client, context.config.reactions.error, update, "👎", signal);
      }
    } finally {
      active -= 1;
    }
  };

  const poll = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try {
        const updates = await client.poll(offset, context.config.pollSeconds, signal);
        for (const update of updates) {
          if (signal.aborted) break;
          if (update.updateId < offset) continue;
          await processUpdate(update, signal);
          offset = Math.max(offset, update.updateId + 1);
        }
        lastError = undefined;
      } catch (error) {
        if (signal.aborted) break;
        lastError = "Telegram polling is degraded.";
        context.logger.warn(lastError, { instanceId: context.instanceId });
        await delay(100, signal);
      }
    }
  };

  return {
    capabilities: Object.freeze({ attachments: true, liveInput: context.host.offerLiveInput !== undefined, askUser: context.host.answerAsk !== undefined, approvals: false, proactive: true, runtimeControl: true, verbatim: true, cancellation: context.host.cancel !== undefined }),
    sendTools,
    get running() { return running; },
    async start(startContext) {
      if (running) return;
      if (stopped) throw new Error("Telegram channel cannot restart after stop.");
      throwIfAborted(startContext.signal);
      lifecycle = new AbortController();
      running = true;
      polling = poll(lifecycle.signal).finally(() => { running = false; });
    },
    async drain() { await stop(); },
    async stop() { await stop(); },
    async health(): Promise<ModuleHealth> {
      return { status: lastError === undefined ? running ? "healthy" : "unknown" : "degraded", checkedAt: new Date().toISOString(), ...(lastError === undefined ? {} : { summary: lastError }), details: { activeUpdates: active } };
    },
    deliver(message, signal) { return delivery.deliver(message, signal); },
  };

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    lifecycle?.abort(new Error("Telegram channel stopped."));
    if (polling !== undefined) await Promise.race([polling.catch(() => undefined), delay(STOP_TIMEOUT_MS)]);
    for (const chatId of [...pendingAsks.keys()]) clearPendingAsk(chatId);
    callbackAnswers.clear();
    runtimeSelections.clear();
    await client.close?.().catch(() => undefined);
    running = false;
  }
}

async function maybeAnswerAsk(
  context: ChannelModuleCreateContext<TelegramConfig>,
  chatId: string,
  pending: Pick<PendingTelegramAsk, "ask" | "answers" | "done">,
  signal: AbortSignal,
): Promise<boolean> {
  if (!pending.ask.questions.every((question) => pending.done.has(question.id))) return false;
  const result = await context.host.answerAsk?.(`telegram:${chatId}`, { interactionId: pending.ask.interactionId, answers: pending.answers, answeredAt: new Date().toISOString() }, signal);
  return result?.status === "accepted" || result?.status === "expired" || result?.status === "mismatch";
}

function inbound(
  instanceId: string,
  update: TelegramMessageUpdate,
  text: string,
  attachments: readonly ChannelAttachment[],
  selection: TelegramRuntimeSelection | undefined,
  signal: AbortSignal,
): ChannelInboundRequest {
  return {
    requestId: `telegram:${update.updateId}`,
    conversationId: `telegram:${update.chatId}`,
    messageId: update.messageId,
    sender: { id: update.senderId, ...(update.senderName === undefined ? {} : { displayName: update.senderName }) },
    text,
    attachments,
    receivedAt: update.receivedAt,
    ...(selection?.runtime === undefined ? {} : { runtime: selection.runtime }),
    ...(selection?.model === undefined ? {} : { model: selection.model }),
    ...(selection?.effort === undefined ? {} : { effort: selection.effort }),
    signal,
    metadata: { channel: "telegram", instanceId, chatId: update.chatId },
  };
}

async function react(client: TelegramBotClient, enabled: boolean, update: TelegramMessageUpdate, emoji: string, signal: AbortSignal): Promise<void> {
  if (enabled) await client.setReaction?.(update.chatId, update.messageId, emoji, signal).catch(() => undefined);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Telegram channel start aborted."); }

function runtimeCommand(text: string): { readonly field: "model" | "effort"; readonly value?: string } | undefined {
  const match = /^\/(model|effort)(?:@\S+)?(?:\s+(\S+))?\s*$/u.exec(text.trim());
  if (match === null) return undefined;
  const value = match[2];
  if (value !== undefined && (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))) return undefined;
  return { field: match[1] as "model" | "effort", ...(value === undefined ? {} : { value }) };
}

function updateRuntimeSelection(
  current: TelegramRuntimeSelection | undefined,
  command: { readonly field: "model" | "effort"; readonly value?: string },
): TelegramRuntimeSelection {
  if (command.value === undefined) return Object.freeze({ ...(current ?? {}) });
  const next = { ...(current ?? {}) };
  if (command.value === "default") {
    delete next[command.field];
    if (command.field === "model") delete next.effort;
  } else {
    next[command.field] = command.value;
    if (command.field === "model") delete next.effort;
  }
  return Object.freeze(next);
}

function rememberRuntimeSelection(
  selections: Map<string, TelegramRuntimeSelection>,
  chatId: string,
  selection: TelegramRuntimeSelection,
): void {
  selections.delete(chatId);
  if (Object.keys(selection).length > 0) selections.set(chatId, selection);
  while (selections.size > MAX_RUNTIME_SELECTIONS) {
    const oldest = selections.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    selections.delete(oldest);
  }
}

function runtimeConfirmation(
  command: { readonly field: "model" | "effort"; readonly value?: string },
  selection: TelegramRuntimeSelection,
): string {
  if (command.value === undefined) {
    return `${command.field}: ${selection[command.field] ?? "default"}`;
  }
  const suffix = command.field === "model" ? " Effort reset to default." : "";
  return `${command.field} set to ${selection[command.field] ?? "default"}.${suffix}`;
}

function decodeReplyCallback(data: string): string | undefined {
  if (!data.startsWith("reply:") || Buffer.byteLength(data, "utf8") > 64) return undefined;
  const encoded = data.slice("reply:".length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (decoded.length === 0
    || decoded.length > 64
    || `reply:${Buffer.from(decoded, "utf8").toString("base64url")}` !== data) {
    return undefined;
  }
  return decoded;
}

export * from "./bot.js";
export * from "./config.js";
export * from "./delivery.js";
export * from "./transcription.js";

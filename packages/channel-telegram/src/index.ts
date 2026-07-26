// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import {
  AGENT_INTERACTION_LIMITS,
  ASK_USER_MAX_ANSWER_BYTES,
  MODULE_API_VERSION,
  defineChannelModule,
  parseAskUserAnswer,
  type Channel,
  type ChannelAttachment,
  type ChannelInboundRequest,
  type ChannelModuleCreateContext,
  type ChannelReplyEvent,
  type ChannelReplySink,
  type ChannelSendTool,
  type AskUserRequest,
  type ModuleHealth,
} from "@mono-agent/module-sdk";

import {
  createTelegramBotApiClient,
  type TelegramBotClient,
  type TelegramBotClientFactory,
  type TelegramMessageUpdate,
  type TelegramSendMessageRequest,
  type TelegramUpdate,
} from "./bot.js";
import { type TelegramConfig, telegramConfigSchema } from "./config.js";
import { TelegramDelivery } from "./delivery.js";
import { resolveTelegramChatId, telegramConversationId } from "./destination.js";
import {
  createTelegramSendTools,
} from "./send-tools.js";

const PACKAGE_NAME = "@mono-agent/channel-telegram";
const PACKAGE_VERSION = "0.15.0";
const STOP_TIMEOUT_MS = 1_000;
const TELEGRAM_TEXT_LIMIT = 4_096;
const MAX_ASK_BUTTONS_PER_QUESTION = 8;
const MAX_PENDING_ASKS = 1_000;
const MAX_CALLBACK_ANSWERS = 10_000;
const MAX_RUNTIME_SELECTIONS = 1_000;
const MAX_TRACKED_UPDATES = 100;
const MAX_TRACKED_TOOL_CALLS = 256;
const MAX_POLL_BACKOFF_MS = 1_000;
const TRANSCRIPTION_UNAVAILABLE = "[Automatic transcription unavailable; audio attachment retained.]";
const RETRY_CONTROL_UPDATE = Symbol("retry-control-update");
const RUN_AS_PRIMARY_UPDATE = Symbol("run-as-primary-update");

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
  readonly model?: string;
  readonly effort?: string;
}

interface TrackedTelegramUpdate {
  readonly update: TelegramUpdate;
  state: "queued" | "primary" | "control" | "settled";
  controlDisposition: "eligible" | "deferred" | "primary";
}

interface ActiveTelegramPoll {
  readonly controller: AbortController;
  frontierInterrupted: boolean;
}

export interface TelegramChannel extends Channel {
  readonly running: boolean;
  readonly sendTools: readonly ChannelSendTool[];
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
  let pollLifecycle: AbortController | undefined;
  let turnLifecycle: AbortController | undefined;
  let polling: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let confirmationLifecycle: AbortController | undefined;
  let offset = 0;
  let confirmedOffset = 0;
  let running = false;
  let startAttempted = false;
  let stopped = false;
  let forceStopped = false;
  let active = 0;
  let lastError: string | undefined;
  let primaryUpdate: TrackedTelegramUpdate | undefined;
  let controlUpdate: TrackedTelegramUpdate | undefined;
  let primaryChatId: string | undefined;
  let primaryControlsReady = false;
  let processingFailureObserved = false;
  const pendingAsks = new Map<string, PendingTelegramAsk>();
  const callbackAnswers = new Map<string, TelegramCallbackAnswer>();
  const runtimeSelections = new Map<string, TelegramRuntimeSelection>();
  const trackedUpdates = new Map<number, TrackedTelegramUpdate>();
  const receivedUpdateIds: number[] = [];
  const idleWaiters = new Set<() => void>();
  let pollProgressVersion = 0;
  let wakePollBackoff: (() => void) | undefined;
  let activePollRequest: ActiveTelegramPoll | undefined;
  let controlRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let controlRetryMs = 100;

  const clearPendingAsk = (chatId: string, expected?: PendingTelegramAsk): void => {
    const pending = pendingAsks.get(chatId);
    if (expected !== undefined && pending !== expected) return;
    if (pending !== undefined) for (const token of pending.tokens) callbackAnswers.delete(token);
    pendingAsks.delete(chatId);
  };

  const rememberCallback = (token: string, answer: TelegramCallbackAnswer, pending: PendingTelegramAsk): void => {
    if (callbackAnswers.size >= MAX_CALLBACK_ANSWERS) {
      throw new Error("Telegram AskUser callback capacity is exhausted.");
    }
    callbackAnswers.set(token, answer);
    pending.tokens.add(token);
  };

  const rememberAsk = (chatId: string, ask: AskUserRequest): PendingTelegramAsk => {
    const existingTokens = pendingAsks.get(chatId)?.tokens.size ?? 0;
    if (!pendingAsks.has(chatId) && pendingAsks.size >= MAX_PENDING_ASKS) {
      throw new Error("Telegram pending AskUser capacity is exhausted.");
    }
    if (callbackAnswers.size - existingTokens + askCallbackCount(ask) > MAX_CALLBACK_ANSWERS) {
      throw new Error("Telegram AskUser callback capacity is exhausted.");
    }
    clearPendingAsk(chatId);
    const answers = Object.create(null) as Record<string, readonly string[]>;
    const pending: PendingTelegramAsk = { ask, answers, done: new Set(), tokens: new Set() };
    pendingAsks.set(chatId, pending);
    if (turnLifecycle !== undefined) scheduleUpdates(turnLifecycle.signal);
    return pending;
  };

  const authorized = (chatId: string): boolean => context.config.allowAllChats || context.config.allowedChatIds.includes(chatId);

  const releaseActiveUpdate = (): void => {
    active -= 1;
    if (active === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  };

  const processUpdate = async (
    update: TelegramUpdate,
    signal: AbortSignal,
    controlOnly = false,
  ): Promise<void> => {
    if (update.kind === "ignored") return;
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
          const consumeCallback = recordAskAnswer(pending, answer);
          if (consumeCallback) {
            callbackAnswers.delete(update.data);
            pending.tokens.delete(update.data);
          }
          if (await maybeAnswerAsk(context, update.chatId, pending, signal)) {
            clearPendingAsk(update.chatId, pending);
          }
        }
      }
      await client.answerCallback?.(update.callbackId, signal).catch(() => undefined);
      return;
    } else {
      await react(client, context.config.reactions.working, update, "👀", signal);
      const pendingAsk = pendingAsks.get(update.chatId);
      if (pendingAsk !== undefined && context.host.answerAsk !== undefined) {
        const question = pendingAsk.ask.questions.find((candidate) => !pendingAsk.done.has(candidate.id));
        if (question !== undefined && question.allowFreeText && update.text.trim().length > 0) {
          recordAskFreeText(pendingAsk, question.id, update.text);
          if (await maybeAnswerAsk(context, update.chatId, pendingAsk, signal)) {
            clearPendingAsk(update.chatId, pendingAsk);
          }
          return;
        }
      }
      if (update.text.trim() === "/cancel" && context.host.cancel !== undefined) {
        const cancelled = await context.host.cancel({
          conversationId: `telegram:${update.chatId}`,
          reason: "Telegram user requested cancellation.",
          signal,
        });
        if (controlOnly && cancelled.status === "idle") throw RETRY_CONTROL_UPDATE;
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
        if (controlOnly && offered.status === "unavailable") throw RETRY_CONTROL_UPDATE;
        if (controlOnly) throw RUN_AS_PRIMARY_UPDATE;
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
      const toolNames = new Map<string, string>();
      const presentActivity = async (activity: string): Promise<void> => {
        const text = boundedTelegramText(activity);
        if (activityMessageId !== undefined && client.editMessage !== undefined) {
          await client.editMessage({ chatId: update.chatId, messageId: activityMessageId, text, signal });
        } else {
          activityMessageId = (await client.sendMessage({
            chatId: update.chatId,
            text,
            replyToMessageId: update.messageId,
            signal,
          })).messageId;
        }
      };
      const reply: ChannelReplySink = {
        async emit(event: ChannelReplyEvent): Promise<void> {
          if (event.type === "text-delta") replyText += event.delta;
          else if (event.type === "text-replace") replyText = event.text;
          else if (event.type === "activity" && event.text.length > 0) {
            await presentActivity(event.text);
          } else if (event.type === "tool-call") {
            await presentActivity(toolCallActivity(toolNames, event.call.id, event.call.name));
          } else if (event.type === "tool-result") {
            await presentActivity(toolResultActivity(toolNames, event.result.callId, event.result.isError === true));
          } else if (event.type === "attachment") {
            await client.sendAttachment({ chatId: update.chatId, attachment: event.attachment, signal });
          } else if (event.type === "ask-user" && context.host.answerAsk !== undefined) {
            const pending = rememberAsk(update.chatId, event.ask);
            try {
              for (const question of event.ask.questions) {
                const buttons = (question.choices ?? []).slice(0, MAX_ASK_BUTTONS_PER_QUESTION).map((choice) => {
                  const token = `ask:${randomUUID().slice(0, 12)}`;
                  rememberCallback(token, { chatId: update.chatId, interactionId: event.ask.interactionId, questionId: question.id, value: choice.value, done: false }, pending);
                  return { label: choice.label, data: token };
                });
                if (question.multiple) {
                  const token = `ask:${randomUUID().slice(0, 12)}`;
                  rememberCallback(token, { chatId: update.chatId, interactionId: event.ask.interactionId, questionId: question.id, done: true }, pending);
                  buttons.push({ label: "Done", data: token });
                }
                await sendChunkedTelegramMessage(client, {
                  chatId: update.chatId,
                  replyToMessageId: update.messageId,
                  signal,
                }, question.prompt, buttons);
              }
            } catch (error) {
              clearPendingAsk(update.chatId, pending);
              throw error;
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
      const dispatched = context.host.dispatch(request, reply);
      if (!controlOnly && primaryUpdate?.update.updateId === update.updateId) {
        primaryControlsReady = true;
        scheduleUpdates(signal);
      }
      const result = await dispatched;
      const final = result.text ?? replyText;
      if (result.status === "completed" && final.length > 0) {
        await sendChunkedTelegramMessage(client, {
          chatId: update.chatId,
          replyToMessageId: update.messageId,
          signal,
        }, final);
        await react(client, context.config.reactions.done, update, "👍", signal);
      } else if (result.status === "rejected") {
        await react(client, context.config.reactions.error, update, "👎", signal);
      }
    }
  };

  function isControlUpdate(entry: TrackedTelegramUpdate): boolean {
    const update = entry.update;
    if (update.kind === "ignored") return false;
    if (update.kind === "callback") {
      const answer = callbackAnswers.get(update.data);
      const pending = pendingAsks.get(update.chatId);
      return answer !== undefined
        && answer.chatId === update.chatId
        && pending?.ask.interactionId === answer.interactionId;
    }
    const pending = pendingAsks.get(update.chatId);
    const question = pending?.ask.questions.find((candidate) => !pending.done.has(candidate.id));
    if (question?.allowFreeText === true && update.text.trim().length > 0) return true;
    if (
      update.text.trim() === "/cancel"
      && context.host.cancel !== undefined
      && entry.controlDisposition === "eligible"
      && primaryControlsReady
      && primaryChatId === update.chatId
    ) return true;
    if (
      runtimeCommand(update.text) !== undefined
      || /^\/help(?:@\S+)?\s*$/u.test(update.text.trim())
    ) return false;
    return entry.controlDisposition === "eligible"
      && primaryUpdate !== undefined
      && primaryControlsReady
      && primaryChatId === update.chatId
      && context.host.offerLiveInput !== undefined
      && update.text.length > 0
      && update.attachments.length === 0;
  }

  function hasEarlierControlBarrier(candidate: TrackedTelegramUpdate): boolean {
    return receivedUpdateIds.some((updateId) => {
      if (updateId >= candidate.update.updateId) return false;
      const entry = trackedUpdates.get(updateId);
      return entry?.state === "control"
        || (entry?.state === "queued" && isControlUpdate(entry));
    });
  }

  function scheduleUpdates(signal: AbortSignal): void {
    if (signal.aborted || forceStopped) return;
    if (!stopped && primaryUpdate === undefined) {
      const nextPrimary = receivedUpdateIds
        .map((updateId) => trackedUpdates.get(updateId))
        .find((entry): entry is TrackedTelegramUpdate =>
          entry?.state === "queued" && !isControlUpdate(entry));
      if (
        nextPrimary !== undefined
        && !hasEarlierControlBarrier(nextPrimary)
      ) startTrackedUpdate(nextPrimary, "primary", signal);
    }
    if (controlUpdate === undefined) {
      const nextControl = receivedUpdateIds
        .map((updateId) => trackedUpdates.get(updateId))
        .find((entry): entry is TrackedTelegramUpdate =>
          entry?.state === "queued" && isControlUpdate(entry));
      if (nextControl !== undefined) startTrackedUpdate(nextControl, "control", signal);
    }
  }

  function startTrackedUpdate(
    entry: TrackedTelegramUpdate,
    lane: "primary" | "control",
    signal: AbortSignal,
  ): void {
    entry.state = lane;
    active += 1;
    if (lane === "primary") {
      primaryUpdate = entry;
      primaryChatId = entry.update.kind === "ignored" ? undefined : entry.update.chatId;
      primaryControlsReady = false;
    } else {
      controlUpdate = entry;
    }
    void (async () => {
      let settled = true;
      try {
        await processUpdate(entry.update, signal, lane === "control");
      } catch (error) {
        if (error === RETRY_CONTROL_UPDATE) {
          entry.controlDisposition = "deferred";
          settled = false;
        } else if (error === RUN_AS_PRIMARY_UPDATE) {
          entry.controlDisposition = "primary";
          settled = false;
        } else if (signal.aborted) {
          settled = false;
        } else {
          processingFailureObserved = true;
          lastError = "Telegram update processing is degraded.";
          context.logger.warn(lastError, {
            instanceId: context.instanceId,
            updateId: entry.update.updateId,
            ...(entry.update.kind === "ignored" ? {} : { chatId: entry.update.chatId }),
          });
          if (entry.update.kind !== "ignored") {
            await react(client, context.config.reactions.error, entry.update, "👎", signal);
          }
        }
      } finally {
        entry.state = settled ? "settled" : "queued";
        if (lane === "primary" && primaryUpdate === entry) {
          primaryUpdate = undefined;
          primaryChatId = undefined;
          primaryControlsReady = false;
        }
        if (lane === "control" && controlUpdate === entry) controlUpdate = undefined;
        advanceConsumedFrontier();
        scheduleUpdates(signal);
        if (entry.state === "queued" && entry.controlDisposition === "deferred") {
          scheduleDeferredControlRetry(signal);
        } else if (lane === "control" && settled) {
          controlRetryMs = 100;
        }
        releaseActiveUpdate();
      }
    })();
  }

  function advanceConsumedFrontier(): boolean {
    const previousOffset = offset;
    let lastSettledUpdateId: number | undefined;
    while (receivedUpdateIds.length > 0) {
      const updateId = receivedUpdateIds[0]!;
      const entry = trackedUpdates.get(updateId);
      if (entry?.state !== "settled") break;
      receivedUpdateIds.shift();
      trackedUpdates.delete(updateId);
      lastSettledUpdateId = updateId;
    }
    const firstUnsettledId = receivedUpdateIds[0];
    if (firstUnsettledId !== undefined) {
      offset = Math.max(offset, firstUnsettledId);
    } else if (lastSettledUpdateId !== undefined) {
      offset = Math.max(offset, lastSettledUpdateId + 1);
    }
    const moved = offset !== previousOffset;
    if (moved) {
      pollProgressVersion += 1;
      wakePollBackoff?.();
      if (activePollRequest !== undefined && !activePollRequest.controller.signal.aborted) {
        activePollRequest.frontierInterrupted = true;
        activePollRequest.controller.abort(new Error("Telegram update frontier advanced."));
      }
    }
    return moved;
  }

  function ingestUpdates(
    updates: readonly TelegramUpdate[],
    signal: AbortSignal,
  ): { readonly added: number; readonly saturated: boolean; readonly frontierMoved: boolean } {
    const batchIds = new Set<number>();
    const additions = [...updates]
      .sort((left, right) => left.updateId - right.updateId)
      .filter((update) => {
        if (update.updateId < offset || trackedUpdates.has(update.updateId) || batchIds.has(update.updateId)) {
          return false;
        }
        batchIds.add(update.updateId);
        return true;
      });
    const fullDuplicateWindow = updates.length >= MAX_TRACKED_UPDATES
      && additions.length === 0
      && trackedUpdates.size >= MAX_TRACKED_UPDATES;
    if (trackedUpdates.size + additions.length > MAX_TRACKED_UPDATES || fullDuplicateWindow) {
      const summary = "Telegram update ledger capacity is exhausted.";
      if (lastError !== summary) {
        lastError = summary;
        context.logger.warn(summary, {
          instanceId: context.instanceId,
          returnedUpdates: updates.length,
          trackedUpdates: trackedUpdates.size,
        });
      }
      scheduleUpdates(signal);
      return { added: 0, saturated: true, frontierMoved: false };
    }
    for (const update of additions) {
      trackedUpdates.set(update.updateId, {
        update,
        state: "queued",
        controlDisposition: "eligible",
      });
      receivedUpdateIds.push(update.updateId);
    }
    receivedUpdateIds.sort((left, right) => left - right);
    const frontierMoved = advanceConsumedFrontier();
    scheduleUpdates(signal);
    return { added: additions.length, saturated: false, frontierMoved };
  }

  function rearmDeferredControls(): boolean {
    if (primaryUpdate === undefined || !primaryControlsReady) return false;
    let rearmed = false;
    for (const entry of trackedUpdates.values()) {
      if (entry.state === "queued" && entry.controlDisposition === "deferred") {
        entry.controlDisposition = "eligible";
        rearmed = true;
      }
    }
    return rearmed;
  }

  function scheduleDeferredControlRetry(signal: AbortSignal): void {
    if (controlRetryTimer !== undefined || signal.aborted || forceStopped) return;
    const timeoutMs = controlRetryMs;
    controlRetryMs = Math.min(controlRetryMs * 2, MAX_POLL_BACKOFF_MS);
    controlRetryTimer = setTimeout(() => {
      controlRetryTimer = undefined;
      if (signal.aborted || forceStopped) return;
      if (rearmDeferredControls()) scheduleUpdates(signal);
    }, timeoutMs);
    controlRetryTimer.unref();
  }

  function clearDeferredControlRetry(): void {
    if (controlRetryTimer === undefined) return;
    clearTimeout(controlRetryTimer);
    controlRetryTimer = undefined;
  }

  const poll = async (pollSignal: AbortSignal, turnSignal: AbortSignal): Promise<void> => {
    let backoffMs = 100;
    let previousRequestedOffset: number | undefined;
    while (!pollSignal.aborted) {
      try {
        const requestedOffset = offset;
        const requestedOffsetAdvanced = previousRequestedOffset !== undefined
          && requestedOffset !== previousRequestedOffset;
        previousRequestedOffset = requestedOffset;
        const request: ActiveTelegramPoll = {
          controller: new AbortController(),
          frontierInterrupted: false,
        };
        activePollRequest = request;
        const abortRequest = (): void => {
          request.controller.abort(pollSignal.reason ?? new Error("Telegram polling stopped."));
        };
        pollSignal.addEventListener("abort", abortRequest, { once: true });
        let updates: readonly TelegramUpdate[];
        try {
          updates = await client.poll(
            requestedOffset,
            context.config.pollSeconds,
            request.controller.signal,
          );
        } catch (error) {
          if (pollSignal.aborted) break;
          if (request.frontierInterrupted) {
            backoffMs = 100;
            continue;
          }
          throw error;
        } finally {
          pollSignal.removeEventListener("abort", abortRequest);
          if (activePollRequest === request) activePollRequest = undefined;
        }
        if (pollSignal.aborted) break;
        if (request.frontierInterrupted) {
          backoffMs = 100;
          continue;
        }
        confirmedOffset = Math.max(confirmedOffset, requestedOffset);
        if (rearmDeferredControls()) clearDeferredControlRetry();
        const ingested = ingestUpdates(updates, turnSignal);
        if (ingested.added > 0) await yieldToUpdateTasks();
        if (!ingested.saturated) {
          if (processingFailureObserved) {
            processingFailureObserved = false;
            lastError = "Telegram update processing is degraded.";
          } else if (
            lastError === "Telegram update ledger capacity is exhausted."
            || lastError === "Telegram update processing is degraded."
            || lastError === "Telegram polling is degraded."
          ) {
            lastError = undefined;
          }
        }
        const progressed = ingested.added > 0
          || ingested.frontierMoved
          || requestedOffsetAdvanced
          || offset !== requestedOffset;
        if (progressed) {
          backoffMs = 100;
        } else {
          const version = pollProgressVersion;
          await waitForPollBackoff(backoffMs, pollSignal);
          backoffMs = pollProgressVersion === version
            ? Math.min(backoffMs * 2, MAX_POLL_BACKOFF_MS)
            : 100;
        }
      } catch {
        if (pollSignal.aborted) break;
        lastError = "Telegram polling is degraded.";
        context.logger.warn(lastError, { instanceId: context.instanceId });
        const version = pollProgressVersion;
        await waitForPollBackoff(backoffMs, pollSignal);
        backoffMs = pollProgressVersion === version
          ? Math.min(backoffMs * 2, MAX_POLL_BACKOFF_MS)
          : 100;
      }
    }
  };

  return {
    capabilities: Object.freeze({ attachments: true, liveInput: context.host.offerLiveInput !== undefined, askUser: context.host.answerAsk !== undefined, approvals: false, proactive: true, runtimeControl: true, verbatim: true, cancellation: context.host.cancel !== undefined }),
    sendTools,
    resolveDefaultDeliveryConversationId() {
      return context.config.defaultDestination === undefined
        ? undefined
        : telegramConversationId(context.config.defaultDestination);
    },
    resolveDeliveryHistory(message) {
      const chatId = resolveTelegramChatId(message.conversationId, undefined);
      if (chatId === undefined) throw new TypeError("Telegram delivery history destination is invalid.");
      return { conversationId: telegramConversationId(chatId) };
    },
    get running() { return running; },
    async start(startContext) {
      if (running) return;
      if (stopped) throw new Error("Telegram channel cannot restart after stop.");
      throwIfAborted(startContext.signal);
      startAttempted = true;
      pollLifecycle = new AbortController();
      turnLifecycle = new AbortController();
      running = true;
      polling = poll(pollLifecycle.signal, turnLifecycle.signal).finally(() => { running = false; });
    },
    async drain(drainContext) {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }
      stopped = true;
      pollLifecycle?.abort(new Error("Telegram channel is draining."));
      shutdownPromise = (async () => {
        try {
          const idle = await waitForIdle(
            drainContext.deadline,
            drainContext.signal,
            turnLifecycle?.signal,
          );
          if (!idle) turnLifecycle?.abort(new Error("Telegram channel drain grace ended."));
          const pollingStopped = await waitForPolling(
            drainContext.deadline,
            drainContext.signal,
          );
          if (idle && pollingStopped) {
            await confirmProcessedOffset(drainContext.deadline, drainContext.signal);
          } else {
            failProcessedOffsetConfirmation(offset);
          }
        } finally {
          await finishShutdown(drainContext.deadline, drainContext.signal);
        }
      })();
      await shutdownPromise;
    },
    async stop() {
      stopped = true;
      forceStopped = true;
      pollLifecycle?.abort(new Error("Telegram channel stopped."));
      turnLifecycle?.abort(new Error("Telegram channel stopped."));
      confirmationLifecycle?.abort(new Error("Telegram offset confirmation stopped."));
      shutdownPromise ??= finishShutdown();
      await shutdownPromise;
    },
    async health(): Promise<ModuleHealth> {
      const deliveryDegraded = delivery.degraded;
      const deliveryReceiptCapacityExhausted = delivery.receiptCapacityExhausted;
      const deliveryAmbiguousOutcome = delivery.hasAmbiguousOutcome;
      return {
        // A channel whose start-up poll threw was reported as "unknown", making
        // it indistinguishable from one that was never started at all — while
        // the channel was completely dead.
        status: lastError !== undefined || deliveryDegraded
          ? "degraded"
          : running
            ? "healthy"
            : startAttempted && !stopped ? "unhealthy" : "unknown",
        checkedAt: new Date().toISOString(),
        ...(lastError !== undefined
          ? { summary: lastError }
          : !running && startAttempted && !stopped
            ? { summary: "Telegram polling stopped unexpectedly after start." }
          : deliveryDegraded
            ? { summary: deliveryReceiptCapacityExhausted
                ? "Telegram delivery receipt capacity is exhausted."
                : "Telegram delivery has an unresolved ambiguous outcome." }
            : {}),
        details: {
          activeUpdates: active,
          deliveryReceiptCapacityExhausted,
          deliveryAmbiguousOutcome,
        },
      };
    },
    deliver(message, signal) { return delivery.deliver(message, signal); },
  };

  async function waitForIdle(
    deadline: string | undefined,
    signal: AbortSignal,
    forceSignal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (active === 0) return true;
    const timeoutMs = drainTimeoutMs(deadline);
    if (timeoutMs === 0 || signal.aborted || forceSignal?.aborted === true) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        idleWaiters.delete(onIdle);
        signal.removeEventListener("abort", onAbort);
        forceSignal?.removeEventListener("abort", onAbort);
        resolve(idle);
      };
      const onIdle = (): void => { finish(true); };
      const onAbort = (): void => { finish(false); };
      const timer = setTimeout(() => { finish(false); }, timeoutMs);
      idleWaiters.add(onIdle);
      signal.addEventListener("abort", onAbort, { once: true });
      forceSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function finishShutdown(
    deadline?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const pollingTimeoutMs = drainTimeoutMs(deadline);
    if (polling !== undefined && pollingTimeoutMs > 0 && !signal.aborted) {
      await Promise.race([
        polling.catch(() => undefined),
        delay(pollingTimeoutMs, signal),
      ]);
    }
    if (active > 0) {
      await waitForIdle(deadline, signal, undefined);
    }
    for (const chatId of [...pendingAsks.keys()]) clearPendingAsk(chatId);
    callbackAnswers.clear();
    runtimeSelections.clear();
    clearDeferredControlRetry();
    trackedUpdates.clear();
    receivedUpdateIds.length = 0;
    await client.close?.().catch(() => undefined);
    running = false;
  }

  async function waitForPolling(deadline: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (polling === undefined) return true;
    const timeoutMs = drainTimeoutMs(deadline);
    if (timeoutMs === 0 || signal.aborted) return false;
    return await settlesWithin(polling, timeoutMs, signal);
  }

  async function confirmProcessedOffset(deadline: string | undefined, signal: AbortSignal): Promise<void> {
    const targetOffset = offset;
    if (targetOffset <= confirmedOffset) return;
    const timeoutMs = drainTimeoutMs(deadline);
    if (timeoutMs === 0 || signal.aborted || forceStopped) {
      failProcessedOffsetConfirmation(targetOffset);
    }
    const expiresAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    confirmationLifecycle = controller;
    const abortFromParent = (): void => {
      controller.abort(signal.reason ?? new Error("Telegram offset confirmation aborted."));
    };
    const timer = setTimeout(() => {
      controller.abort(new Error("Telegram offset confirmation timed out."));
    }, timeoutMs);
    signal.addEventListener("abort", abortFromParent, { once: true });
    let resolveAborted!: (result: "aborted") => void;
    const aborted = new Promise<"aborted">((resolve) => {
      resolveAborted = resolve;
    });
    const abortConfirmation = (): void => { resolveAborted("aborted"); };
    controller.signal.addEventListener("abort", abortConfirmation, { once: true });
    const attempt = Promise.resolve()
      .then(async () => await client.poll(targetOffset, 0, controller.signal))
      .then(() => "confirmed" as const, () => "failed" as const);
    try {
      const result = await Promise.race([attempt, aborted]);
      if (
        result !== "confirmed"
        || controller.signal.aborted
        || signal.aborted
        || forceStopped
        || Date.now() >= expiresAt
      ) {
        failProcessedOffsetConfirmation(targetOffset);
      }
      confirmedOffset = Math.max(confirmedOffset, targetOffset);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromParent);
      controller.signal.removeEventListener("abort", abortConfirmation);
      if (confirmationLifecycle === controller) confirmationLifecycle = undefined;
    }
  }

  function failProcessedOffsetConfirmation(targetOffset: number): never {
    lastError = "Telegram update confirmation is degraded.";
    context.logger.warn(lastError, { instanceId: context.instanceId, offset: targetOffset });
    throw new Error(lastError);
  }

  async function waitForPollBackoff(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (wakePollBackoff === finish) wakePollBackoff = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref();
      wakePollBackoff = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

async function maybeAnswerAsk(
  context: ChannelModuleCreateContext<TelegramConfig>,
  chatId: string,
  pending: Pick<PendingTelegramAsk, "ask" | "answers" | "done">,
  signal: AbortSignal,
): Promise<boolean> {
  if (!pending.ask.questions.every((question) => pending.done.has(question.id))) return false;
  const answer = parseAskUserAnswer({
    interactionId: pending.ask.interactionId,
    answers: pending.answers,
    answeredAt: new Date().toISOString(),
  }, pending.ask);
  const result = await context.host.answerAsk?.(`telegram:${chatId}`, answer, signal);
  return result?.status === "accepted" || result?.status === "expired" || result?.status === "mismatch";
}

function recordAskAnswer(
  pending: Pick<PendingTelegramAsk, "ask" | "answers" | "done">,
  answer: TelegramCallbackAnswer,
): boolean {
  const question = pending.ask.questions.find((candidate) => candidate.id === answer.questionId);
  if (question === undefined) return true;
  if (answer.value !== undefined) {
    recordAskValue(pending, answer.questionId, answer.value, question.multiple);
  }
  if (answer.done) {
    if ((pending.answers[answer.questionId]?.length ?? 0) === 0) return false;
    pending.done.add(answer.questionId);
  } else if (!question.multiple) {
    pending.done.add(answer.questionId);
  }
  return true;
}

function recordAskFreeText(
  pending: Pick<PendingTelegramAsk, "ask" | "answers" | "done">,
  questionId: string,
  value: string,
): void {
  const question = pending.ask.questions.find((candidate) => candidate.id === questionId);
  if (question === undefined || !validAskAnswerValue(value)) return;
  recordAskValue(pending, questionId, value, question.multiple);
  if (!question.multiple) pending.done.add(questionId);
}

function recordAskValue(
  pending: Pick<PendingTelegramAsk, "answers">,
  questionId: string,
  value: string,
  multiple: boolean,
): void {
  if (!multiple) {
    pending.answers[questionId] = [value];
    return;
  }
  const current = pending.answers[questionId] ?? [];
  if (
    current.length >= AGENT_INTERACTION_LIMITS.askAnswerValuesPerQuestion
    || current.includes(value)
  ) return;
  pending.answers[questionId] = [...current, value];
}

function validAskAnswerValue(value: string): boolean {
  return value.trim().length > 0
    && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= ASK_USER_MAX_ANSWER_BYTES;
}

function askCallbackCount(ask: AskUserRequest): number {
  return ask.questions.reduce(
    (count, question) => count
      + Math.min(question.choices?.length ?? 0, MAX_ASK_BUTTONS_PER_QUESTION)
      + (question.multiple ? 1 : 0),
    0,
  );
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
    ...(selection?.model === undefined ? {} : { model: selection.model }),
    ...(selection?.effort === undefined ? {} : { effort: selection.effort }),
    signal,
    metadata: { channel: "telegram", instanceId, chatId: update.chatId },
  };
}

async function react(
  client: TelegramBotClient,
  enabled: boolean,
  update: Pick<TelegramMessageUpdate, "chatId" | "messageId">,
  emoji: string,
  signal: AbortSignal,
): Promise<void> {
  if (enabled) await client.setReaction?.(update.chatId, update.messageId, emoji, signal).catch(() => undefined);
}

async function sendChunkedTelegramMessage(
  client: TelegramBotClient,
  request: Omit<TelegramSendMessageRequest, "text" | "buttons">,
  text: string,
  buttons: readonly { readonly label: string; readonly data: string }[] = [],
): Promise<{ readonly messageId: string }> {
  const chunks = telegramTextChunks(text);
  if (chunks.length === 0) throw new Error("Telegram messages require non-empty text.");
  let result: { readonly messageId: string } | undefined;
  for (const [index, chunk] of chunks.entries()) {
    result = await client.sendMessage({
      ...request,
      text: chunk,
      ...(index === chunks.length - 1 && buttons.length > 0 ? { buttons } : {}),
    });
  }
  return result!;
}

function telegramTextChunks(text: string): readonly string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TELEGRAM_TEXT_LIMIT, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function boundedTelegramText(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  let end = TELEGRAM_TEXT_LIMIT - 1;
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

function toolCallActivity(
  toolNames: Map<string, string>,
  callId: string,
  name: string,
): string {
  rememberToolName(toolNames, callId, displayToolName(name));
  return `Running ${toolNames.get(callId) ?? "tool"}…`;
}

function toolResultActivity(
  toolNames: Map<string, string>,
  callId: string,
  failed: boolean,
): string {
  const name = toolNames.get(callId);
  toolNames.delete(callId);
  return `${name ?? "Tool"} ${failed ? "failed" : "completed"}.`;
}

function rememberToolName(
  toolNames: Map<string, string>,
  callId: string,
  name: string,
): void {
  if (!toolNames.has(callId) && toolNames.size >= MAX_TRACKED_TOOL_CALLS) {
    const oldest = toolNames.keys().next().value as string | undefined;
    if (oldest !== undefined) toolNames.delete(oldest);
  }
  toolNames.set(callId, name);
}

function displayToolName(name: string): string {
  const normalized = name.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.length === 0 ? "tool" : normalized;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function drainTimeoutMs(deadline: string | undefined): number {
  if (deadline === undefined) return STOP_TIMEOUT_MS;
  const parsed = Date.parse(deadline);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
}

async function yieldToUpdateTasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => { finish(false); };
    const timer = setTimeout(() => { finish(false); }, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => { finish(true); }, () => { finish(true); });
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

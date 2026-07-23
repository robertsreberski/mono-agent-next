import { randomUUID } from "node:crypto";

import { MODULE_API_VERSION, defineChannelModule, type AskUserRequest, type Channel, type ChannelAttachment, type ChannelInboundRequest, type ChannelModuleCreateContext, type ChannelReplyEvent, type ChannelReplySink, type ChannelSendTool, type ModuleHealth } from "@mono-agent/module-sdk";

import { createSlackWebApiClient, type SlackApiClientFactory } from "./client.js";
import {
  type SlackConfig,
  type SlackConfiguredAction,
  type SlackHomeButtonConfig,
  slackConfigSchema,
} from "./config.js";
import { SlackDelivery } from "./delivery.js";
import { parseSlackDestination, slackConversationId } from "./destination.js";
import { SlackInbox } from "./inbox.js";
import {
  createSlackSendTools,
} from "./send-tools.js";
import {
  createSlackSocketModeTransport,
  type SlackHomeActionEvent,
  type SlackMessageEvent,
  type SlackShortcutEvent,
  type SlackSocketEvent,
  type SlackSocketFailure,
  type SlackSocketTransportFactory,
} from "./socket.js";

const PACKAGE_NAME = "@mono-agent/channel-slack";
const PACKAGE_VERSION = "0.15.0";
const STOP_TIMEOUT_MS = 1_000;
const MAX_PENDING_ASKS = 1_000;
const MAX_ACTION_ANSWERS = 10_000;
const MAX_RUNTIME_SELECTIONS = 1_000;
const MAX_ACTIVITY_CONVERSATIONS = 100;
const MAX_ACTIVITY_ENTRIES = 32;

interface PendingSlackAsk {
  readonly ask: AskUserRequest;
  readonly answers: Record<string, readonly string[]>;
  readonly done: Set<string>;
  readonly tokens: Set<string>;
}

interface SlackActionAnswer {
  readonly conversationId: string;
  readonly interactionId: string;
  readonly questionId: string;
  readonly value?: string;
  readonly done: boolean;
}

interface SlackRuntimeSelection {
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface SlackChannel extends Channel {
  readonly running: boolean;
  readonly sendTools: readonly ChannelSendTool[];
}
export interface CreateSlackChannelOptions { readonly context: ChannelModuleCreateContext<SlackConfig>; readonly socketFactory?: SlackSocketTransportFactory; readonly clientFactory?: SlackApiClientFactory; }

export const monoAgentModule = defineChannelModule({
  manifest: { packageName: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, apiVersion: MODULE_API_VERSION, kind: "channel", responsibility: "Maps Slack Socket Mode interactions and Web API deliveries onto normalized channel turns.", capabilities: [] },
  schema: slackConfigSchema,
  create(context) { return createSlackChannel({ context }); },
});

export function createSlackChannel(options: CreateSlackChannelOptions): SlackChannel {
  const { context } = options;
  const socket = (options.socketFactory ?? ((config) => createSlackSocketModeTransport(config)))(context.config);
  const client = (options.clientFactory ?? ((config) => createSlackWebApiClient(config)))(context.config);
  const delivery = new SlackDelivery(context.config, client);
  const sendTools = createSlackSendTools();
  let lifecycle: AbortController | undefined;
  let inbox: SlackInbox | undefined;
  let worker: Promise<void> | undefined;
  let workerRequested = false;
  let stopping = false;
  let running = false;
  let active = 0;
  let failureSummary: string | undefined;
  const pendingAsks = new Map<string, PendingSlackAsk>();
  const actionAnswers = new Map<string, SlackActionAnswer>();
  const runtimeSelections = new Map<string, SlackRuntimeSelection>();
  const activityLedger = new Map<string, string[]>();
  const assistantStatusUnavailable = new Set<string>();
  const reacted = new Set<string>();
  const destinationAuthorized = (channelId: string): boolean =>
    context.config.allowAllChannels || context.config.allowedChannelIds.includes(channelId);
  const authorized = (event: SlackSocketEvent): boolean => {
    if (!context.config.allowedTeamIds.includes(event.teamId)) return false;
    return event.kind === "message" || event.kind === "action"
      ? destinationAuthorized(event.channelId)
      : true;
  };

  const clearPendingAsk = (conversationId: string): void => {
    const pending = pendingAsks.get(conversationId);
    if (pending !== undefined) for (const token of pending.tokens) actionAnswers.delete(token);
    pendingAsks.delete(conversationId);
  };

  const rememberAction = (token: string, answer: SlackActionAnswer, pending: PendingSlackAsk): void => {
    actionAnswers.set(token, answer);
    pending.tokens.add(token);
    while (actionAnswers.size > MAX_ACTION_ANSWERS) {
      const oldest = actionAnswers.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      actionAnswers.delete(oldest);
    }
  };

  const rememberAsk = (conversationId: string, ask: AskUserRequest): PendingSlackAsk => {
    clearPendingAsk(conversationId);
    const pending: PendingSlackAsk = { ask, answers: {}, done: new Set(), tokens: new Set() };
    pendingAsks.set(conversationId, pending);
    while (pendingAsks.size > MAX_PENDING_ASKS) {
      const oldest = pendingAsks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      clearPendingAsk(oldest);
    }
    return pending;
  };

  const renderAsk = async (
    conversationId: string,
    channelId: string,
    threadId: string,
    ask: AskUserRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const pending = rememberAsk(conversationId, ask);
    for (const question of ask.questions) {
      const buttons = (question.choices ?? []).slice(0, 4).map((choice) => {
        const token = `ask-${randomUUID().slice(0, 12)}`;
        rememberAction(token, {
          conversationId,
          interactionId: ask.interactionId,
          questionId: question.id,
          value: choice.value,
          done: false,
        }, pending);
        return { label: choice.label, value: token };
      });
      if (question.multiple) {
        const token = `ask-${randomUUID().slice(0, 12)}`;
        rememberAction(token, {
          conversationId,
          interactionId: ask.interactionId,
          questionId: question.id,
          done: true,
        }, pending);
        buttons.push({ label: "Done", value: token });
      }
      await client.postMessage({
        channelId,
        threadId,
        text: question.prompt,
        ...(buttons.length === 0 ? {} : { buttons }),
        signal,
      });
    }
  };

  const processConfiguredAction = async (
    event: SlackShortcutEvent | SlackHomeActionEvent,
    configured: SlackConfiguredAction,
    signal: AbortSignal,
  ): Promise<void> => {
    const sourceChannelId = event.kind === "shortcut" ? event.sourceChannelId : undefined;
    const configuredDefault = context.config.defaultDestination?.split(":", 1)[0];
    const channelId = configured.channelId
      ?? sourceChannelId
      ?? configuredDefault
      ?? context.config.allowedChannelIds[0];
    if (channelId === undefined || !destinationAuthorized(channelId)) return;
    const sourceThreadId = event.kind === "shortcut"
      && configured.channelId === undefined
      && sourceChannelId === channelId
      ? event.sourceThreadId
      : undefined;
    let threadId = sourceThreadId;
    let messageId = event.kind === "shortcut" ? event.sourceMessageId : undefined;
    if (configured.ackText !== undefined) {
      try {
        const acknowledged = await client.postMessage({
          channelId,
          ...(sourceThreadId === undefined ? {} : { threadId: sourceThreadId }),
          text: configured.ackText,
          signal,
        });
        messageId ??= acknowledged.messageId;
        if (configured.threadReply && threadId === undefined) threadId = acknowledged.messageId;
      } catch {
        context.logger.warn("Slack configured action acknowledgement failed.", {
          instanceId: context.instanceId,
          actionKind: event.kind,
        });
      }
    }
    const conversationTail = threadId ?? `action-${event.envelopeId}`;
    const conversationId = `slack:${channelId}:${conversationTail}`;
    let replyText = "";
    const reply: ChannelReplySink = {
      async emit(replyEvent: ChannelReplyEvent): Promise<void> {
        if (replyEvent.type === "text-delta") replyText += replyEvent.delta;
        else if (replyEvent.type === "text-replace") replyText = replyEvent.text;
        else if (replyEvent.type === "activity" && threadId !== undefined && client.setAssistantStatus !== undefined) {
          await client.setAssistantStatus(channelId, threadId, statusText(replyEvent.text), signal).catch(() => undefined);
        } else if (replyEvent.type === "attachment") {
          await client.postFile({
            channelId,
            ...(threadId === undefined ? {} : { threadId }),
            attachment: replyEvent.attachment,
            signal,
          });
        } else if (replyEvent.type === "ask-user" && context.host.answerAsk !== undefined) {
          if (threadId === undefined) {
            throw new Error("Slack configured actions require a source or acknowledgement thread for AskUser.");
          }
          await renderAsk(conversationId, channelId, threadId, replyEvent.ask, signal);
        }
      },
    };
    const result = await context.host.dispatch({
      requestId: event.envelopeId,
      conversationId,
      messageId: messageId ?? event.envelopeId,
      sender: { id: event.userId },
      text: configured.prompt,
      attachments: [],
      receivedAt: event.receivedAt,
      signal,
      metadata: {
        channel: "slack",
        instanceId: context.instanceId,
        teamId: event.teamId,
        channelId,
        source: event.kind,
      },
    }, reply);
    const final = result.text ?? replyText;
    if (result.status === "completed" && final.length > 0) {
      await client.postMessage({
        channelId,
        ...(threadId === undefined ? {} : { threadId }),
        text: final,
        signal,
      });
    }
  };

  const processEvent = async (event: SlackSocketEvent): Promise<void> => {
    if (event.kind === "home-opened") {
      if (context.config.homeTab.enabled && client.publishHome !== undefined) {
        try {
          await client.publishHome(event.userId, homeView(context.config), lifecycle!.signal);
        } catch {
          context.logger.warn("Slack App Home publishing failed.", {
            instanceId: context.instanceId,
            userId: event.userId,
          });
        }
      }
      return;
    }
    if (event.kind === "shortcut") {
      const shortcut = context.config.shortcuts.find((candidate) => candidate.callbackId === event.callbackId);
      if (shortcut !== undefined) await processConfiguredAction(event, shortcut, lifecycle!.signal);
      return;
    }
    if (event.kind === "home-action") {
      const button = context.config.homeTab.buttons.find((candidate) => candidate.actionId === event.actionId);
      if (context.config.homeTab.enabled && button !== undefined) {
        await processConfiguredAction(event, button, lifecycle!.signal);
      }
      return;
    }
    const conversationId = `slack:${event.channelId}:${event.threadId}`;
    if (event.kind === "action") {
      const answer = actionAnswers.get(event.value);
      const pending = pendingAsks.get(conversationId);
      if (answer !== undefined && pending !== undefined && answer.conversationId === conversationId && answer.interactionId === pending.ask.interactionId && context.host.answerAsk !== undefined) {
        actionAnswers.delete(event.value);
        pending.tokens.delete(event.value);
        if (answer.value !== undefined) pending.answers[answer.questionId] = pending.ask.questions.find((question) => question.id === answer.questionId)?.multiple === true ? [...(pending.answers[answer.questionId] ?? []), answer.value] : [answer.value];
        if (answer.done || pending.ask.questions.find((question) => question.id === answer.questionId)?.multiple !== true) pending.done.add(answer.questionId);
        if (await maybeAnswer(context, conversationId, pending, lifecycle!.signal)) clearPendingAsk(conversationId);
      }
      return;
    }
    active += 1;
    const signal = lifecycle!.signal;
    try {
      await indicateActivity(client, assistantStatusUnavailable, reacted, conversationId, event, "is thinking…", signal);
      const pending = pendingAsks.get(conversationId);
      if (pending !== undefined && context.host.answerAsk !== undefined) {
        const question = pending.ask.questions.find((candidate) => !pending.done.has(candidate.id));
        if (question !== undefined && question.allowFreeText && event.text.trim().length > 0) {
          pending.answers[question.id] = [event.text];
          pending.done.add(question.id);
          if (await maybeAnswer(context, conversationId, pending, signal)) clearPendingAsk(conversationId);
          return;
        }
      }
      if (event.text.trim() === "/cancel" && context.host.cancel !== undefined) {
        await context.host.cancel({ conversationId, reason: "Slack user requested cancellation.", signal });
        return;
      }
      const command = runtimeCommand(event.text);
      if (command !== undefined) {
        const selection = updateRuntimeSelection(runtimeSelections.get(conversationId), command);
        rememberRuntimeSelection(runtimeSelections, conversationId, selection);
        await client.postMessage({
          channelId: event.channelId,
          threadId: event.threadId,
          text: runtimeConfirmation(command, selection),
          signal,
        });
        return;
      }
      if (/^\/help\s*$/u.test(event.text.trim())) {
        await client.postMessage({
          channelId: event.channelId,
          threadId: event.threadId,
          text: "Commands: /model <id|default>, /effort <level|default>, /cancel, /help",
          signal,
        });
        return;
      }
      if (context.host.offerLiveInput !== undefined && event.text.length > 0 && event.files.length === 0) {
        const offered = await context.host.offerLiveInput({ conversationId, id: event.envelopeId, text: event.text, receivedAt: event.receivedAt, signal });
        if (offered.status === "applied" || offered.status === "discarded") return;
      }
      const attachments: ChannelAttachment[] = [];
      for (const file of event.files) attachments.push(await client.download(file, context.config.maxAttachmentBytes, signal));
      let replyText = "";
      const reply: ChannelReplySink = { async emit(replyEvent: ChannelReplyEvent) {
        if (replyEvent.type === "text-delta") replyText += replyEvent.delta;
        else if (replyEvent.type === "text-replace") replyText = replyEvent.text;
        else if (replyEvent.type === "activity" && replyEvent.text.length > 0) {
          rememberActivity(activityLedger, conversationId, replyEvent.text);
          await indicateActivity(
            client,
            assistantStatusUnavailable,
            reacted,
            conversationId,
            event,
            statusText(replyEvent.text),
            signal,
          );
        }
        else if (replyEvent.type === "attachment") await client.postFile({ channelId: event.channelId, threadId: event.threadId, attachment: replyEvent.attachment, signal });
        else if (replyEvent.type === "ask-user" && context.host.answerAsk !== undefined) {
          await renderAsk(conversationId, event.channelId, event.threadId, replyEvent.ask, signal);
        }
      } };
      const result = await context.host.dispatch(inbound(
        context.instanceId,
        event,
        attachments,
        runtimeSelections.get(conversationId),
        signal,
      ), reply);
      const final = result.text ?? replyText;
      if (result.status === "completed" && final.length > 0) await client.postMessage({ channelId: event.channelId, threadId: event.threadId, text: final, signal });
      else if (result.status === "rejected") await client.addReaction?.(event.channelId, event.messageId, "warning", signal).catch(() => undefined);
    } finally {
      activityLedger.delete(conversationId);
      reacted.delete(conversationId);
      active -= 1;
    }
  };

  const failClosed = (summary: string, abort = true): void => {
    if (failureSummary === undefined) {
      failureSummary = summary;
      context.logger.error(summary, { instanceId: context.instanceId });
    }
    running = false;
    if (abort) lifecycle?.abort(new Error(summary));
    void socket.stop().catch(() => undefined);
  };

  const runWorker = async (): Promise<void> => {
    const currentInbox = inbox;
    const signal = lifecycle?.signal;
    if (currentInbox === undefined || signal === undefined || signal.aborted) return;
    while (!signal.aborted) {
      const event = await currentInbox.claimNext(signal);
      if (event === undefined) return;
      try {
        await processEvent(event);
        await currentInbox.complete(event.envelopeId, signal);
      } catch {
        try { await currentInbox.fail(event.envelopeId); } catch { /* The channel is failed closed either way. */ }
        failClosed("Slack durable inbox processing failed; operator recovery is required.");
        return;
      }
    }
  };

  const scheduleWorker = (): void => {
    if (worker !== undefined) {
      workerRequested = true;
      return;
    }
    worker = runWorker().catch(() => {
      failClosed("Slack durable inbox processing failed; operator recovery is required.");
    }).finally(() => {
      worker = undefined;
      if (workerRequested) {
        workerRequested = false;
        scheduleWorker();
      }
    });
  };

  const admit = async (event: SlackSocketEvent): Promise<void> => {
    const signal = lifecycle?.signal;
    if (!running || stopping || signal === undefined || signal.aborted || inbox === undefined) {
      throw new Error("Slack channel is not accepting envelopes.");
    }
    if (!authorized(event)) return;
    try {
      const result = await inbox.enqueue(event, signal);
      if (result === "enqueued") scheduleWorker();
    } catch (error) {
      failClosed("Slack durable inbox admission failed; the envelope was not acknowledged.");
      throw error;
    }
  };

  const transportFailed = (failure: SlackSocketFailure): void => {
    failClosed(failure.summary, false);
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await Promise.race([socket.stop().catch(() => undefined), delay(STOP_TIMEOUT_MS)]);
    if (worker !== undefined) await Promise.race([worker.catch(() => undefined), delay(STOP_TIMEOUT_MS)]);
    lifecycle?.abort(new Error("Slack channel stopped."));
    await inbox?.close().catch(() => undefined);
    inbox = undefined;
    for (const conversationId of [...pendingAsks.keys()]) clearPendingAsk(conversationId);
    actionAnswers.clear();
    runtimeSelections.clear();
    activityLedger.clear();
    assistantStatusUnavailable.clear();
    reacted.clear();
    running = false;
  };

  return {
    capabilities: Object.freeze({ attachments: true, liveInput: context.host.offerLiveInput !== undefined, askUser: context.host.answerAsk !== undefined, approvals: false, proactive: true, runtimeControl: true, verbatim: false, cancellation: context.host.cancel !== undefined }),
    sendTools,
    resolveDefaultDeliveryConversationId() {
      return context.config.defaultDestination === undefined
        ? undefined
        : slackConversationId(parseSlackDestination(
          context.config.defaultDestination,
          "Slack default destination",
        ));
    },
    get running() { return running; },
    async start(startContext) {
      if (running) return;
      if (inbox !== undefined) throw new Error("Slack channel must be stopped before restart.");
      throwIfAborted(startContext.signal);
      lifecycle = new AbortController();
      stopping = false;
      failureSummary = undefined;
      try {
        inbox = await SlackInbox.open(context.dataDirectory, lifecycle.signal);
        const snapshot = inbox.snapshot();
        if (snapshot.blocked !== undefined) throw new Error(snapshot.blocked);
        running = true;
        await socket.start(admit, lifecycle.signal, transportFailed);
        scheduleWorker();
      } catch (error) {
        running = false;
        failureSummary = "Slack channel startup failed closed.";
        lifecycle.abort(error);
        await socket.stop().catch(() => undefined);
        await inbox?.close().catch(() => undefined);
        throw error;
      }
    },
    async drain() { await stop(); },
    async stop() { await stop(); },
    async health(): Promise<ModuleHealth> {
      const snapshot = inbox?.snapshot();
      const deliveryDegraded = delivery.degraded;
      return {
        status: failureSummary !== undefined
          ? "unhealthy"
          : deliveryDegraded
            ? "degraded"
            : running ? "healthy" : "unknown",
        checkedAt: new Date().toISOString(),
        ...(failureSummary !== undefined
          ? { summary: failureSummary }
          : deliveryDegraded
            ? { summary: "Slack delivery receipt capacity is exhausted." }
            : {}),
        details: {
          activeEvents: active,
          pendingEvents: snapshot?.pending ?? 0,
          processingEvents: snapshot?.processing ?? 0,
          failedEvents: snapshot?.failed ?? 0,
          completedReceipts: snapshot?.completed ?? 0,
          transientActivityEntries: [...activityLedger.values()].reduce((total, entries) => total + entries.length, 0),
          deliveryMode: "final-only",
          deliveryReceiptCapacityExhausted: deliveryDegraded,
        },
      };
    },
    deliver(message, signal) { return delivery.deliver(message, signal); },
  };
}

async function maybeAnswer(context: ChannelModuleCreateContext<SlackConfig>, conversationId: string, pending: Pick<PendingSlackAsk, "ask" | "answers" | "done">, signal: AbortSignal): Promise<boolean> {
  if (!pending.ask.questions.every((question) => pending.done.has(question.id))) return false;
  const result = await context.host.answerAsk?.(conversationId, { interactionId: pending.ask.interactionId, answers: pending.answers, answeredAt: new Date().toISOString() }, signal);
  return result?.status === "accepted" || result?.status === "expired" || result?.status === "mismatch";
}

function inbound(
  instanceId: string,
  event: SlackMessageEvent,
  attachments: readonly ChannelAttachment[],
  selection: SlackRuntimeSelection | undefined,
  signal: AbortSignal,
): ChannelInboundRequest {
  return {
    requestId: event.envelopeId,
    conversationId: `slack:${event.channelId}:${event.threadId}`,
    messageId: event.messageId,
    sender: { id: event.userId },
    text: event.text,
    attachments,
    receivedAt: event.receivedAt,
    ...(selection?.runtime === undefined ? {} : { runtime: selection.runtime }),
    ...(selection?.model === undefined ? {} : { model: selection.model }),
    ...(selection?.effort === undefined ? {} : { effort: selection.effort }),
    signal,
    metadata: { channel: "slack", instanceId, teamId: event.teamId, channelId: event.channelId, threadId: event.threadId },
  };
}
async function delay(ms: number): Promise<void> { await new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); }); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Slack channel start aborted."); }

async function indicateActivity(
  client: ReturnType<SlackApiClientFactory>,
  unavailable: Set<string>,
  reacted: Set<string>,
  conversationId: string,
  event: SlackMessageEvent,
  status: string,
  signal: AbortSignal,
): Promise<void> {
  if (!unavailable.has(conversationId) && client.setAssistantStatus !== undefined) {
    try {
      await client.setAssistantStatus(event.channelId, event.threadId, status, signal);
      return;
    } catch {
      unavailable.add(conversationId);
      while (unavailable.size > MAX_ACTIVITY_CONVERSATIONS) {
        const oldest = unavailable.values().next().value as string | undefined;
        if (oldest === undefined) break;
        unavailable.delete(oldest);
      }
    }
  }
  if (!reacted.has(conversationId) && client.addReaction !== undefined) {
    reacted.add(conversationId);
    await client.addReaction(event.channelId, event.messageId, "eyes", signal).catch(() => undefined);
  }
}

function rememberActivity(ledger: Map<string, string[]>, conversationId: string, text: string): void {
  let entries = ledger.get(conversationId);
  if (entries === undefined) {
    entries = [];
    ledger.set(conversationId, entries);
  }
  entries.push(text.slice(0, 1_024));
  if (entries.length > MAX_ACTIVITY_ENTRIES) entries.splice(0, entries.length - MAX_ACTIVITY_ENTRIES);
  while (ledger.size > MAX_ACTIVITY_CONVERSATIONS) {
    const oldest = ledger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

function statusText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return (normalized.length === 0 ? "is working…" : normalized).slice(0, 100);
}

function homeView(config: SlackConfig): {
  readonly type: "home";
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
} {
  const blocks: Readonly<Record<string, unknown>>[] = [];
  if (config.homeTab.headerText !== undefined) {
    blocks.push(Object.freeze({
      type: "section",
      text: Object.freeze({ type: "mrkdwn", text: config.homeTab.headerText }),
    }));
  }
  for (let offset = 0; offset < config.homeTab.buttons.length; offset += 5) {
    const buttons: readonly SlackHomeButtonConfig[] = config.homeTab.buttons.slice(offset, offset + 5);
    blocks.push(Object.freeze({
      type: "actions",
      elements: Object.freeze(buttons.map((button) => Object.freeze({
        type: "button",
        action_id: button.actionId,
        text: Object.freeze({ type: "plain_text", text: button.label, emoji: false }),
      }))),
    }));
  }
  return Object.freeze({ type: "home", blocks: Object.freeze(blocks) });
}

function runtimeCommand(text: string): { readonly field: "model" | "effort"; readonly value?: string } | undefined {
  const match = /^(?:<@[A-Z0-9]+>\s+)?\/(model|effort)(?:\s+(\S+))?\s*$/u.exec(text.trim());
  if (match === null) return undefined;
  const value = match[2];
  if (value !== undefined && (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))) return undefined;
  return { field: match[1] as "model" | "effort", ...(value === undefined ? {} : { value }) };
}

function updateRuntimeSelection(
  current: SlackRuntimeSelection | undefined,
  command: { readonly field: "model" | "effort"; readonly value?: string },
): SlackRuntimeSelection {
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
  selections: Map<string, SlackRuntimeSelection>,
  conversationId: string,
  selection: SlackRuntimeSelection,
): void {
  selections.delete(conversationId);
  if (Object.keys(selection).length > 0) selections.set(conversationId, selection);
  while (selections.size > MAX_RUNTIME_SELECTIONS) {
    const oldest = selections.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    selections.delete(oldest);
  }
}

function runtimeConfirmation(
  command: { readonly field: "model" | "effort"; readonly value?: string },
  selection: SlackRuntimeSelection,
): string {
  if (command.value === undefined) return `${command.field}: ${selection[command.field] ?? "default"}`;
  const suffix = command.field === "model" ? " (effort reset)" : "";
  return `${command.field} set to ${selection[command.field] ?? "default"}.${suffix}`;
}

export * from "./client.js";
export * from "./config.js";
export * from "./delivery.js";
export * from "./socket.js";

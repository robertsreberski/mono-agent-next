import { randomUUID } from "node:crypto";

import { MODULE_API_VERSION, defineChannelModule, type AskUserRequest, type Channel, type ChannelAttachment, type ChannelInboundRequest, type ChannelModuleCreateContext, type ChannelReplyEvent, type ChannelReplySink, type ModuleHealth } from "@mono-agent/module-sdk";

import { createSlackWebApiClient, type SlackApiClientFactory } from "./client.js";
import { type SlackConfig, slackConfigSchema } from "./config.js";
import { SlackDelivery } from "./delivery.js";
import { SlackInbox } from "./inbox.js";
import { createSlackSocketModeTransport, type SlackMessageEvent, type SlackSocketEvent, type SlackSocketFailure, type SlackSocketTransportFactory } from "./socket.js";

const PACKAGE_NAME = "@mono-agent/channel-slack";
const PACKAGE_VERSION = "0.15.0";
const STOP_TIMEOUT_MS = 1_000;
const MAX_PENDING_ASKS = 1_000;
const MAX_ACTION_ANSWERS = 10_000;

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

export interface SlackChannel extends Channel { readonly running: boolean; }
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
  const authorized = (event: SlackSocketEvent): boolean => context.config.allowedTeamIds.includes(event.teamId) && (context.config.allowAllChannels || context.config.allowedChannelIds.includes(event.channelId));

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

  const processEvent = async (event: SlackSocketEvent): Promise<void> => {
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
      await client.addReaction?.(event.channelId, event.messageId, "eyes", signal).catch(() => undefined);
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
        else if (replyEvent.type === "attachment") await client.postFile({ channelId: event.channelId, threadId: event.threadId, attachment: replyEvent.attachment, signal });
        else if (replyEvent.type === "ask-user" && context.host.answerAsk !== undefined) {
          const pending = rememberAsk(conversationId, replyEvent.ask);
          for (const question of replyEvent.ask.questions) {
            const buttons = (question.choices ?? []).slice(0, 4).map((choice) => {
              const token = `ask-${randomUUID().slice(0, 12)}`;
              rememberAction(token, { conversationId, interactionId: replyEvent.ask.interactionId, questionId: question.id, value: choice.value, done: false }, pending);
              return { label: choice.label, value: token };
            });
            if (question.multiple) {
              const token = `ask-${randomUUID().slice(0, 12)}`;
              rememberAction(token, { conversationId, interactionId: replyEvent.ask.interactionId, questionId: question.id, done: true }, pending);
              buttons.push({ label: "Done", value: token });
            }
            await client.postMessage({ channelId: event.channelId, threadId: event.threadId, text: question.prompt, ...(buttons.length === 0 ? {} : { buttons }), signal });
          }
        }
      } };
      const result = await context.host.dispatch(inbound(context.instanceId, event, attachments, signal), reply);
      const final = result.text ?? replyText;
      if (result.status === "completed" && final.length > 0) await client.postMessage({ channelId: event.channelId, threadId: event.threadId, text: final, signal });
      else if (result.status === "rejected") await client.addReaction?.(event.channelId, event.messageId, "warning", signal).catch(() => undefined);
    } finally { active -= 1; }
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
    running = false;
  };

  return {
    capabilities: Object.freeze({ attachments: true, liveInput: context.host.offerLiveInput !== undefined, askUser: context.host.answerAsk !== undefined, approvals: false, proactive: true, runtimeControl: false, verbatim: false, cancellation: context.host.cancel !== undefined }),
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
      return {
        status: failureSummary === undefined ? running ? "healthy" : "unknown" : "unhealthy",
        checkedAt: new Date().toISOString(),
        ...(failureSummary === undefined ? {} : { summary: failureSummary }),
        details: {
          activeEvents: active,
          pendingEvents: snapshot?.pending ?? 0,
          processingEvents: snapshot?.processing ?? 0,
          failedEvents: snapshot?.failed ?? 0,
          completedReceipts: snapshot?.completed ?? 0,
          deliveryMode: "final-only",
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

function inbound(instanceId: string, event: SlackMessageEvent, attachments: readonly ChannelAttachment[], signal: AbortSignal): ChannelInboundRequest {
  return { requestId: event.envelopeId, conversationId: `slack:${event.channelId}:${event.threadId}`, messageId: event.messageId, sender: { id: event.userId }, text: event.text, attachments, receivedAt: event.receivedAt, signal, metadata: { channel: "slack", instanceId, teamId: event.teamId, channelId: event.channelId, threadId: event.threadId } };
}
async function delay(ms: number): Promise<void> { await new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); }); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Slack channel start aborted."); }

export * from "./client.js";
export * from "./config.js";
export * from "./delivery.js";
export * from "./socket.js";

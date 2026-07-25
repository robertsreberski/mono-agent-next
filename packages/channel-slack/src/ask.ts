// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import type {
  AskUserRequest,
  ChannelModuleCreateContext,
} from "@mono-agent/module-sdk";

import type { SlackApiClient } from "./client.js";
import type { SlackConfig } from "./config.js";
import type {
  SlackActionEvent,
  SlackMessageEvent,
} from "./socket.js";

const MAX_PENDING_ASKS = 1_000;
const MAX_ACTION_ANSWERS = 10_000;

interface PendingSlackAsk {
  readonly ask: AskUserRequest;
  readonly answers: Record<string, readonly string[]>;
  readonly done: Set<string>;
  readonly tokens: Set<string>;
  answerAfterOrder: number;
  rendered: boolean;
}

interface SlackActionAnswer {
  readonly conversationId: string;
  readonly interactionId: string;
  readonly questionId: string;
  readonly value?: string;
  readonly done: boolean;
}

type AskResolution = "incomplete" | "resolved" | "retry";

export class SlackAskController {
  private readonly pending = new Map<string, PendingSlackAsk>();
  private readonly actions = new Map<string, SlackActionAnswer>();
  private readonly aliases = new Map<string, string>();
  private readonly retainedConversations = new Set<string>();

  constructor(
    private readonly context: ChannelModuleCreateContext<SlackConfig>,
    private readonly client: SlackApiClient,
    private readonly scheduleControl: () => void,
    private readonly currentAdmissionOrder: () => number,
    private readonly admissionOrderFor: (envelopeId: string) => number,
  ) {}

  hasFreeTextAnswer(event: SlackMessageEvent): boolean {
    if (event.text.trim().length === 0) return false;
    const pending = this.pending.get(this.conversationFor(event));
    const question = pending?.ask.questions.find(
      (candidate) => !pending.done.has(candidate.id),
    );
    return pending?.rendered === true
      && this.admissionOrderFor(event.envelopeId) > pending.answerAfterOrder
      && question?.allowFreeText === true;
  }

  async render(
    conversation: string,
    channelId: string,
    threadId: string | undefined,
    ask: AskUserRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = this.remember(conversation, ask);
    try {
      for (const question of ask.questions) {
        const buttons = (question.choices ?? []).map((choice) => {
          const token = this.rememberAction(pending, {
            conversationId: conversation,
            interactionId: ask.interactionId,
            questionId: question.id,
            value: choice.value,
            done: false,
          });
          return { label: choice.label, value: token };
        });
        if (question.multiple) {
          const token = this.rememberAction(pending, {
            conversationId: conversation,
            interactionId: ask.interactionId,
            questionId: question.id,
            done: true,
          });
          buttons.push({ label: "Done", value: token });
        }
        const posted = await this.client.postMessage({
          channelId,
          ...(threadId === undefined ? {} : { threadId }),
          text: question.prompt,
          ...(buttons.length === 0 ? {} : { buttons }),
          signal,
        });
        if (this.pending.get(conversation) !== pending) return;
        if (threadId === undefined) {
          this.aliases.set(
            `slack:${channelId}:${posted.messageId}`,
            conversation,
          );
        }
      }
      if (this.pending.get(conversation) === pending) {
        pending.answerAfterOrder = this.currentAdmissionOrder();
        pending.rendered = true;
        this.scheduleControl();
      }
    } catch (error) {
      this.clear(conversation, pending);
      throw error;
    }
  }

  async answerAction(event: SlackActionEvent, signal: AbortSignal): Promise<void> {
    const answer = this.actions.get(event.value);
    if (answer === undefined || this.context.host.answerAsk === undefined) return;
    const pending = this.pending.get(answer.conversationId);
    if (pending === undefined || pending.ask.interactionId !== answer.interactionId) {
      this.actions.delete(event.value);
      return;
    }
    const question = pending.ask.questions.find(
      (candidate) => candidate.id === answer.questionId,
    );
    if (question === undefined) {
      this.actions.delete(event.value);
      pending.tokens.delete(event.value);
      return;
    }
    const previousAnswers = pending.answers[answer.questionId];
    const wasDone = pending.done.has(answer.questionId);
    if (answer.value !== undefined) {
      pending.answers[answer.questionId] = question.multiple
        ? [...(previousAnswers ?? []), answer.value]
        : [answer.value];
    }
    if (answer.done || !question.multiple) pending.done.add(answer.questionId);
    const resolution = await resolveAsk(
      this.context,
      answer.conversationId,
      pending,
      signal,
    );
    if (resolution === "retry") {
      restoreQuestion(pending, answer.questionId, previousAnswers, wasDone);
    } else if (resolution === "resolved") {
      this.clear(answer.conversationId, pending);
    } else {
      this.actions.delete(event.value);
      pending.tokens.delete(event.value);
    }
  }

  async answerFreeText(
    event: SlackMessageEvent,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.context.host.answerAsk === undefined || event.text.trim().length === 0) {
      return false;
    }
    const conversation = this.conversationFor(event);
    const pending = this.pending.get(conversation);
    const question = pending?.ask.questions.find(
      (candidate) => !pending.done.has(candidate.id),
    );
    if (pending === undefined
      || !pending.rendered
      || this.admissionOrderFor(event.envelopeId) <= pending.answerAfterOrder
      || question === undefined
      || !question.allowFreeText) {
      return false;
    }
    const previousAnswers = pending.answers[question.id];
    pending.answers[question.id] = [event.text];
    pending.done.add(question.id);
    const resolution = await resolveAsk(
      this.context,
      conversation,
      pending,
      signal,
    );
    if (resolution === "retry") {
      restoreQuestion(pending, question.id, previousAnswers, false);
    } else if (resolution === "resolved") {
      this.clear(conversation, pending);
    }
    return true;
  }

  clearAll(): void {
    for (const conversation of [...this.pending.keys()]) this.clear(conversation);
    this.actions.clear();
    this.aliases.clear();
    this.retainedConversations.clear();
  }

  conversationFor(event: SlackMessageEvent): string {
    const direct = conversationId(event);
    return this.aliases.get(direct) ?? direct;
  }

  retainConversation(conversation: string): void {
    this.retainedConversations.add(conversation);
  }

  releaseConversation(conversation: string): void {
    this.retainedConversations.delete(conversation);
    if (!this.pending.has(conversation)) this.clearAliases(conversation);
  }

  private remember(conversation: string, ask: AskUserRequest): PendingSlackAsk {
    if (!this.retainedConversations.has(conversation)) {
      this.clearAliases(conversation);
    }
    this.clear(conversation);
    const pending: PendingSlackAsk = {
      ask,
      answers: {},
      done: new Set(),
      tokens: new Set(),
      answerAfterOrder: this.currentAdmissionOrder(),
      rendered: false,
    };
    this.pending.set(conversation, pending);
    while (this.pending.size > MAX_PENDING_ASKS) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.clear(oldest);
    }
    return pending;
  }

  private rememberAction(
    pending: PendingSlackAsk,
    answer: SlackActionAnswer,
  ): string {
    const token = `ask-${randomUUID().slice(0, 12)}`;
    this.actions.set(token, answer);
    pending.tokens.add(token);
    while (this.actions.size > MAX_ACTION_ANSWERS) {
      const oldest = this.actions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.actions.delete(oldest);
    }
    return token;
  }

  private clear(conversation: string, expected?: PendingSlackAsk): void {
    const pending = this.pending.get(conversation);
    if (pending === undefined || (expected !== undefined && pending !== expected)) return;
    for (const token of pending.tokens) this.actions.delete(token);
    this.pending.delete(conversation);
    if (!this.retainedConversations.has(conversation)) {
      this.clearAliases(conversation);
    }
  }

  private clearAliases(conversation: string): void {
    for (const [alias, target] of this.aliases) {
      if (target === conversation) this.aliases.delete(alias);
    }
  }
}

async function resolveAsk(
  context: ChannelModuleCreateContext<SlackConfig>,
  conversationId: string,
  pending: Pick<PendingSlackAsk, "ask" | "answers" | "done">,
  signal: AbortSignal,
): Promise<AskResolution> {
  if (!pending.ask.questions.every((question) => pending.done.has(question.id))) {
    return "incomplete";
  }
  const result = await context.host.answerAsk?.(conversationId, {
    interactionId: pending.ask.interactionId,
    answers: pending.answers,
    answeredAt: new Date().toISOString(),
  }, signal);
  return result?.status === "accepted" || result?.status === "expired"
    ? "resolved"
    : "retry";
}

function restoreQuestion(
  pending: PendingSlackAsk,
  questionId: string,
  previousAnswers: readonly string[] | undefined,
  wasDone: boolean,
): void {
  if (previousAnswers === undefined) delete pending.answers[questionId];
  else pending.answers[questionId] = previousAnswers;
  if (!wasDone) pending.done.delete(questionId);
}

function conversationId(event: SlackMessageEvent): string {
  return `slack:${event.channelId}:${event.threadId}`;
}

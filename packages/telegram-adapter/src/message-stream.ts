import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
  ChannelMessageContentKind,
  ChannelSendOutcome,
  ChannelTransport,
  MessageRef,
} from "@mono-agent/agent-contracts";
import {
  ChannelDeliveryError,
  DEFAULT_MAX_MESSAGE_CHARS,
  ResilientMessageStream,
  normalizeTrailing,
  splitTextByCodePoints,
} from "@mono-agent/agent-contracts";
import { redactTelegramErrorMessage } from "./log-redaction.js";
import { TelegramApiError } from "./telegram-error.js";
import { renderTelegramMarkdown } from "./telegram-markdown.js";
import type {
  TelegramChatId,
  TelegramEditMessageTextParams,
  TelegramMessageSender,
  TelegramSendMessageParams,
} from "./types.js";

export interface AgentMessageStream extends AgentMessageStreamBase {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  event(event: AgentStreamEvent): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export interface TelegramMessageStreamOptions {
  api: TelegramMessageSender;
  chatId: TelegramChatId;
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  replyToMessageId?: number;
  /** Maximum retries for a *final* delivery before giving up. Default 3. */
  maxSendRetries?: number;
  /** Upper bound on any honored `retry_after`/backoff wait, in ms. Default 60000. */
  retryCapMs?: number;
  /** Base delay for exponential backoff between final-delivery retries. Default 500. */
  retryBaseDelayMs?: number;
  /**
   * Show lightweight, friendly activity hints (e.g. "Searching the web…") while
   * the agent works, before any answer text has arrived. Default true.
   */
  showHints?: boolean;
  /** Render the final answer as Telegram MarkdownV2 (plain fallback). Default true. */
  formatMarkdown?: boolean;
  /**
   * Deliver only the final answer: suppress streaming interim edits and show a
   * "typing…" chat action while the agent works. Default false.
   */
  finalOnly?: boolean;
  /**
   * Post messages silently — `disable_notification` is set so the message arrives
   * without a push sound. Used by proactive notify during quiet hours. Default false.
   */
  silent?: boolean;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  logger?: TelegramMessageStreamLogger;
}

export interface TelegramMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Raised only when a *final* delivery cannot reach Telegram after retries and
 * the last-resort fresh send. The AI request itself already succeeded, so the
 * adapter treats this as a degraded delivery — never as an agent failure.
 *
 * A thin specialization of the shared {@link ChannelDeliveryError}: the substrate
 * throws the shared base type, and the wrapper's `finish()` normalizes it to this
 * Telegram type (preserving `{ cause, attempts }`) so callers catching
 * `TelegramDeliveryError` keep working and the base type never escapes — parity
 * with how the Slack adapter wraps delivery failures.
 */
export class TelegramDeliveryError extends ChannelDeliveryError {
  constructor(message: string, details: { cause: unknown; attempts: number }) {
    super(message, details);
    this.name = "TelegramDeliveryError";
  }
}

/** How a failed Telegram send/edit should be handled. */
export type TelegramSendOutcome =
  | { kind: "not_modified" }
  | { kind: "recreate" }
  | { kind: "reformat_plain" }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "fatal" };

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";

/** Sentinel raised by the transport when a rendered MarkdownV2 chunk overflows. */
const MARKDOWN_OVERFLOW = Symbol("telegram-markdown-overflow");

interface TelegramMarkdownOverflowError {
  readonly [MARKDOWN_OVERFLOW]: true;
}

function isMarkdownOverflowError(error: unknown): error is TelegramMarkdownOverflowError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<PropertyKey, unknown>)[MARKDOWN_OVERFLOW] === true
  );
}

/**
 * Telegram-specific {@link ChannelTransport}. Wraps the {@link TelegramMessageSender}
 * (sendMessage / editMessageText), renders MarkdownV2, and maps Telegram failures
 * onto {@link ChannelSendOutcome}. Markdown rendering and `parse_mode` are gated by
 * a mutable `markdownEnabled` flag so the wrapper can deliver fixed system copy
 * (e.g. "Cancelled.") as plain text without re-rendering it.
 */
class TelegramChannelTransport implements ChannelTransport {
  readonly maxMessageChars: number;
  /** Gates MarkdownV2 rendering + `parse_mode`. Toggled per finish() call. */
  markdownEnabled: boolean;

  private readonly api: TelegramMessageSender;
  private readonly chatId: TelegramChatId;
  private readonly replyToMessageId: number | undefined;
  private readonly silent: boolean;
  private readonly logger: TelegramMessageStreamLogger | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private transientStatusMessage: MessageRef | undefined;
  private postFinalAnswerSeparately = false;

  constructor(options: {
    api: TelegramMessageSender;
    chatId: TelegramChatId;
    maxMessageChars: number;
    replyToMessageId: number | undefined;
    markdownEnabled: boolean;
    silent: boolean;
    logger: TelegramMessageStreamLogger | undefined;
    abortSignal: AbortSignal | undefined;
  }) {
    this.api = options.api;
    this.chatId = options.chatId;
    this.maxMessageChars = options.maxMessageChars;
    this.replyToMessageId = options.replyToMessageId;
    this.markdownEnabled = options.markdownEnabled;
    this.silent = options.silent;
    this.logger = options.logger;
    this.abortSignal = options.abortSignal;
  }

  /**
   * Keep a visible tool ledger transient: once finish begins, post the answer as
   * a new Telegram message and remove the previously posted status message.
   * Streaming-mode answer edits never use this path.
   */
  beginSeparateFinalAnswer(): void {
    this.postFinalAnswerSeparately = true;
  }

  renderMarkdown(text: string): string {
    if (!this.markdownEnabled) {
      return text;
    }
    return renderTelegramMarkdown(text);
  }

  async post(
    text: string,
    options: { markdown: boolean; contentKind?: ChannelMessageContentKind },
  ): Promise<MessageRef> {
    const useMarkdown = options.markdown && this.markdownEnabled;
    this.assertWithinLimit(text, useMarkdown);
    const sent = await this.api.sendMessage(this.buildSendParams(text, useMarkdown, options.contentKind));
    const ref = { id: String(sent.message_id), message_id: sent.message_id };
    if (options.contentKind === "status") {
      this.transientStatusMessage = ref;
    } else if (options.contentKind === "answer" && this.postFinalAnswerSeparately) {
      await this.dismissTransientStatus();
    }
    return ref;
  }

  async edit(
    ref: MessageRef,
    text: string,
    options: { markdown: boolean; contentKind?: ChannelMessageContentKind },
  ): Promise<void> {
    if (
      options.contentKind === "answer"
      && this.postFinalAnswerSeparately
      && this.abortSignal?.aborted !== true
    ) {
      await this.post(text, options);
      return;
    }
    const useMarkdown = options.markdown && this.markdownEnabled;
    this.assertWithinLimit(text, useMarkdown);
    await this.api.editMessageText(this.buildEditParams(ref, text, useMarkdown));
  }

  async delete(ref: MessageRef): Promise<void> {
    if (this.api.deleteMessage === undefined) {
      throw new Error("Telegram deleteMessage is unavailable on this client.");
    }
    await this.api.deleteMessage({
      chat_id: this.chatId,
      message_id: messageIdOf(ref),
    });
    if (this.transientStatusMessage?.id === ref.id) {
      this.transientStatusMessage = undefined;
    }
  }

  classifyError(error: unknown): ChannelSendOutcome {
    if (isMarkdownOverflowError(error)) {
      return { kind: "reformat_plain" };
    }
    return classifyTelegramError(error);
  }

  async indicateActivity(): Promise<void> {
    // Telegram "typing…" chat action; expires after ~5s so the substrate
    // refreshes it while the agent works. No-op if the sender lacks the method.
    await this.api.sendChatAction?.({ chat_id: this.chatId, action: "typing" });
  }

  /**
   * MarkdownV2 escaping can expand a chunk past Telegram's size limit even though
   * the plain source is within it (chunks are split on the source length). Rather
   * than send and fail with "message is too long", we signal a reformat-to-plain
   * recovery; the substrate then re-delivers the plain source within the limit.
   * (We never test renderedText === source to decide this: telegramify renders
   * inline code / links back to identical bytes that still need parse_mode, so
   * equality is not a plain-text signal.)
   */
  private assertWithinLimit(text: string, useMarkdown: boolean): void {
    if (useMarkdown && countCodePoints(text) > this.maxMessageChars) {
      const overflow: TelegramMarkdownOverflowError = { [MARKDOWN_OVERFLOW]: true };
      throw overflow;
    }
  }

  private buildEditParams(
    ref: MessageRef,
    text: string,
    useMarkdown: boolean,
  ): TelegramEditMessageTextParams {
    const params: TelegramEditMessageTextParams = {
      chat_id: this.chatId,
      message_id: messageIdOf(ref),
      text,
    };
    if (useMarkdown) {
      params.parse_mode = "MarkdownV2";
    }
    return params;
  }

  private buildSendParams(
    text: string,
    useMarkdown: boolean,
    contentKind?: ChannelMessageContentKind,
  ): TelegramSendMessageParams {
    const params: TelegramSendMessageParams = { chat_id: this.chatId, text };
    if (useMarkdown) {
      params.parse_mode = "MarkdownV2";
    }
    if (this.replyToMessageId !== undefined) {
      params.reply_to_message_id = this.replyToMessageId;
      if (contentKind === "answer" && this.postFinalAnswerSeparately) {
        params.allow_sending_without_reply = true;
      }
    }
    if (this.silent) {
      params.disable_notification = true;
    }
    return params;
  }

  private async dismissTransientStatus(): Promise<void> {
    const ref = this.transientStatusMessage;
    this.transientStatusMessage = undefined;
    if (ref === undefined || this.api.deleteMessage === undefined) {
      return;
    }
    try {
      await this.api.deleteMessage({
        chat_id: this.chatId,
        message_id: messageIdOf(ref),
      });
    } catch (error) {
      // The answer has already landed. A stale progress bubble is preferable to
      // retrying the answer and risking a duplicate final response.
      this.logger?.debug?.("Telegram transient progress deletion failed after final delivery (ignored).", {
        error: redactTelegramErrorMessage(error),
      });
    }
  }
}

function messageIdOf(ref: MessageRef): number {
  const raw = (ref as { message_id?: unknown }).message_id;
  return typeof raw === "number" ? raw : Number(ref.id);
}

/**
 * Thin wrapper over the shared {@link ResilientMessageStream}: builds a Telegram
 * {@link ChannelTransport} and delegates all streaming/finish behavior to the
 * substrate, preserving this adapter's public API and no-labels + activity-hints
 * behavior. Telegram additionally keeps final-only tool ledgers transient by
 * posting the completed answer separately and deleting the ledger. The per-call
 * `finish(text, { format })` toggle lets fixed system copy bypass MarkdownV2.
 */
export class TelegramMessageStream implements AgentMessageStream {
  private readonly transport: TelegramChannelTransport;
  private readonly inner: ResilientMessageStream;
  private readonly formatMarkdown: boolean;
  private readonly finalOnly: boolean;

  constructor(options: TelegramMessageStreamOptions) {
    const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    if (!Number.isInteger(maxMessageChars) || maxMessageChars < 32) {
      throw new RangeError("maxMessageChars must be an integer of at least 32.");
    }
    this.formatMarkdown = options.formatMarkdown ?? true;
    this.finalOnly = options.finalOnly ?? false;

    this.transport = new TelegramChannelTransport({
      api: options.api,
      chatId: options.chatId,
      maxMessageChars,
      replyToMessageId: options.replyToMessageId,
      // Streaming begins with the configured formatting; finish() may override it.
      markdownEnabled: this.formatMarkdown,
      silent: options.silent ?? false,
      logger: options.logger,
      abortSignal: options.abortSignal,
    });

    const innerOptions: ConstructorParameters<typeof ResilientMessageStream>[0] = {
      transport: this.transport,
      maxMessageChars,
      // The transport gates MarkdownV2 via `markdownEnabled`; the substrate always
      // attempts the final render so its render() hook reaches our transport.
      formatMarkdown: true,
    };
    if (options.initialStatusText !== undefined) {
      innerOptions.initialStatusText = normalizeTelegramText(options.initialStatusText);
    } else {
      innerOptions.initialStatusText = DEFAULT_INITIAL_STATUS_TEXT;
    }
    if (options.editDebounceMs !== undefined) {
      innerOptions.editDebounceMs = options.editDebounceMs;
    }
    if (options.maxSendRetries !== undefined) {
      innerOptions.maxSendRetries = options.maxSendRetries;
    }
    if (options.retryCapMs !== undefined) {
      innerOptions.retryCapMs = options.retryCapMs;
    }
    if (options.retryBaseDelayMs !== undefined) {
      innerOptions.retryBaseDelayMs = options.retryBaseDelayMs;
    }
    if (options.showHints !== undefined) {
      innerOptions.showHints = options.showHints;
    }
    if (options.finalOnly !== undefined) {
      innerOptions.finalOnly = options.finalOnly;
    }
    if (options.abortSignal !== undefined) {
      innerOptions.abortSignal = options.abortSignal;
    }
    if (options.logger !== undefined) {
      innerOptions.logger = options.logger;
    }

    this.inner = new ResilientMessageStream(innerOptions);
  }

  async status(text: string): Promise<void> {
    await this.inner.status(text);
  }

  async append(delta: string): Promise<void> {
    await this.inner.append(delta);
  }

  async replace(text: string): Promise<void> {
    await this.inner.replace(text);
  }

  async event(event: AgentStreamEvent): Promise<void> {
    await this.inner.event(event);
  }

  async dismissTransient(): Promise<void> {
    await this.inner.dismissTransient();
  }

  async finish(finalText?: string, options?: { format?: boolean }): Promise<void> {
    // Fixed system copy (e.g. "Cancelled.") is delivered as plain text — the
    // transport's markdown gate is toggled for this finish so the answer is not
    // re-rendered as MarkdownV2.
    this.transport.markdownEnabled = this.formatMarkdown && (options?.format ?? true);
    if (this.finalOnly) {
      this.transport.beginSeparateFinalAnswer();
    }
    try {
      await this.inner.finish(finalText);
    } catch (error) {
      // The substrate throws the shared ChannelDeliveryError. Normalize it to
      // TelegramDeliveryError so callers that catch the Telegram type keep
      // working and the base type never escapes the adapter (parity with Slack).
      if (error instanceof ChannelDeliveryError && !(error instanceof TelegramDeliveryError)) {
        throw new TelegramDeliveryError("Telegram final delivery failed.", {
          cause: error.cause,
          attempts: error.attempts,
        });
      }
      throw error;
    }
  }
}

/**
 * Classify a Telegram send/edit failure into a recovery strategy. Pure and
 * exported so the recovery policy can be unit-tested directly.
 */
export function classifyTelegramError(error: unknown): TelegramSendOutcome {
  if (error instanceof TelegramApiError) {
    const description = (error.telegramDescription ?? "").toLowerCase();
    if (description.includes("message is not modified")) {
      return { kind: "not_modified" };
    }
    if (
      description.includes("message to edit not found") ||
      description.includes("message to be edited not found") ||
      description.includes("message can't be edited") ||
      description.includes("message_id_invalid")
    ) {
      return { kind: "recreate" };
    }
    if (
      description.includes("can't parse entities") ||
      description.includes("can't find end of the entity") ||
      description.includes("unsupported start tag") ||
      description.includes("unclosed")
    ) {
      return { kind: "reformat_plain" };
    }
    if (
      error.retryAfterMs !== undefined ||
      error.errorCode === 429 ||
      error.status === 429 ||
      description.includes("too many requests")
    ) {
      if (error.retryAfterMs !== undefined) {
        return { kind: "retry", retryAfterMs: error.retryAfterMs };
      }
      return { kind: "retry" };
    }
    if (error.kind === "network") {
      return { kind: "retry" };
    }
    if (error.kind === "aborted") {
      return { kind: "fatal" };
    }
    if (error.status !== undefined && error.status >= 500) {
      return { kind: "retry" };
    }
    return { kind: "fatal" };
  }

  // Non-TelegramApiError (e.g. a transient transport error or a test stub):
  // retry conservatively rather than surfacing it as a hard failure.
  return { kind: "retry" };
}

export function splitTelegramText(text: string, maxChars: number): string[] {
  return splitTextByCodePoints(normalizeTrailing(text, ""), maxChars);
}

function normalizeTelegramText(text: string): string {
  return text.trimEnd();
}

/** Count Unicode code points — Telegram's message length is measured in them. */
function countCodePoints(text: string): number {
  return [...text].length;
}

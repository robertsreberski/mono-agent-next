/**
 * Transport-agnostic resilient message stream.
 *
 * Generalizes the battle-tested finite-state machine that multiple chat channel
 * adapters had each hand-rolled: lazy first send, debounced interim edits,
 * overflow chunking, and a final delivery that classifies failures into a
 * recovery strategy (retry-with-backoff / recreate / reformat-plain /
 * not-modified / last-resort fresh send) with abort-aware sleeps and an
 * idempotent finish.
 *
 * A {@link ChannelTransport} supplies the channel API (post / edit / classify /
 * render-markdown) so this class never references a concrete chat platform. It
 * streams text as-is — there are no "answer" / "thinking" / "final-answer"
 * labels, and reasoning (assistant_thought) is never rendered as prose.
 */

import { types as nodeUtilTypes } from "node:util";

import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
} from "./index.js";
import {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
} from "./stream-text.js";
import { formatToolActivityLine, toolHintFor } from "./tool-hints.js";

/** Opaque handle to a posted message, returned by {@link ChannelTransport.post}. */
export interface MessageRef {
  readonly id: string;
  readonly [key: string]: unknown;
}

/** Semantic content carried by a confirmed channel write. */
export type ChannelMessageContentKind = "status" | "answer";

/** Whether a failed native call is known not to have landed or may have landed. */
export type ChannelFailureCertainty = "not_delivered" | "unknown";

/** Durable routing decision after the stream has exhausted its own recovery. */
export type ChannelDeliveryDisposition = "retryable" | "permanent" | "unknown";

/** How a failed post/edit should be handled by {@link ResilientMessageStream}. */
export type ChannelSendOutcome =
  | { kind: "not_modified"; failureCertainty?: ChannelFailureCertainty }
  | { kind: "recreate"; failureCertainty?: ChannelFailureCertainty }
  | { kind: "reformat_plain"; failureCertainty?: ChannelFailureCertainty }
  | { kind: "retry"; retryAfterMs?: number; failureCertainty?: ChannelFailureCertainty }
  | { kind: "fatal"; failureCertainty?: ChannelFailureCertainty };

/**
 * Abstracts a chat channel's API so the resilience FSM is transport-agnostic.
 * Implementations wrap a concrete chat channel API client.
 */
export interface ChannelTransport {
  /** Per-message character budget for this channel. */
  readonly maxMessageChars: number;
  /** Post a new message and return a ref usable by {@link edit}. */
  post(text: string, options: { markdown: boolean; contentKind?: ChannelMessageContentKind }): Promise<MessageRef>;
  /** Edit a previously posted message in place. */
  edit(
    ref: MessageRef,
    text: string,
    options: { markdown: boolean; contentKind?: ChannelMessageContentKind },
  ): Promise<void>;
  /** Delete a transient message, when the channel supports it. Best-effort. */
  delete?(ref: MessageRef): Promise<void>;
  /** Classify a post/edit failure into a recovery strategy. */
  classifyError(error: unknown): ChannelSendOutcome;
  /** Render markdown to the channel's wire format. Defaults to identity. */
  renderMarkdown?(text: string): string;
  /**
   * Show a lightweight "working" affordance without posting a chat message —
   * e.g. a "typing…" activity indicator or a "seen" acknowledgement. Used in
   * `finalOnly` mode in place of interim message edits. Best-effort; the stream
   * swallows failures.
   */
  indicateActivity?(): Promise<void>;
}

export interface ResilientMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface ResilientMessageStreamOptions {
  transport: ChannelTransport;
  initialStatusText?: string;
  editDebounceMs?: number;
  /** Overrides `transport.maxMessageChars` when provided. */
  maxMessageChars?: number;
  /** Maximum retries for a *final* delivery before giving up. Default 3. */
  maxSendRetries?: number;
  /** Upper bound on any honored `retryAfterMs`/backoff wait, in ms. Default 60000. */
  retryCapMs?: number;
  /** Base delay for exponential backoff between final-delivery retries. Default 500. */
  retryBaseDelayMs?: number;
  /**
   * Show lightweight, friendly activity hints (e.g. "Searching the web…") while
   * the agent works, before any answer text has arrived. Default true.
   */
  showHints?: boolean;
  /** Render the final answer with `transport.renderMarkdown`. Default true. */
  formatMarkdown?: boolean;
  /**
   * Deliver answer text only at finish. When hints are enabled, tool starts use
   * one transient cumulative status message that the final answer replaces;
   * other activity uses `transport.indicateActivity()` (typing/seen). Default
   * false.
   */
  finalOnly?: boolean;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  /** Injectable sleep so tests need not wait on real timers. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: ResilientMessageStreamLogger;
}

/**
 * Raised only when a *final* delivery cannot reach the channel after retries and
 * the last-resort fresh send. The AI request itself already succeeded, so a
 * caller should treat this as a degraded delivery — never as an agent failure.
 */
export class ChannelDeliveryError extends Error {
  override readonly cause: unknown;
  readonly attempts: number;
  readonly disposition: ChannelDeliveryDisposition;

  constructor(
    message: string,
    details: { cause: unknown; attempts: number; disposition?: ChannelDeliveryDisposition },
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
    this.cause = details.cause;
    this.attempts = details.attempts;
    this.disposition = details.disposition ?? "unknown";
  }
}

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";
const DEFAULT_EDIT_DEBOUNCE_MS = 750;
// Minimum gap between activity indicators (typing/seen) in final-only mode.
// A typical channel "typing" indicator lasts ~5s, so refreshing under that keeps
// it continuous without spamming the API.
const ACTIVITY_INDICATE_THROTTLE_MS = 4_000;
const DEFAULT_MAX_SEND_RETRIES = 3;
const DEFAULT_RETRY_CAP_MS = 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const EMPTY_FINAL_TEXT = DEFAULT_EMPTY_FINAL_TEXT;

export interface ResilientAgentMessageStream extends AgentMessageStreamBase {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  event(event: AgentStreamEvent): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export class ResilientMessageStream implements ResilientAgentMessageStream {
  private readonly transport: ChannelTransport;
  private readonly initialStatusText: string;
  private readonly editDebounceMs: number;
  private readonly maxMessageChars: number;
  private readonly maxSendRetries: number;
  private readonly retryCapMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly showHints: boolean;
  private readonly formatMarkdown: boolean;
  private readonly finalOnly: boolean;
  private lastActivityIndicatedAt = 0;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly logger: ResilientMessageStreamLogger | undefined;

  private currentText = "";
  private hasAnswerText = false;
  private statusText: string;
  private sentMessage: MessageRef | undefined;
  private sendMessagePromise: Promise<MessageRef> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightEdit: Promise<void> | undefined;
  private lastFlushedText: string | undefined;
  private lastFlushedMarkdown = false;
  private lastFlushedContentKind: ChannelMessageContentKind | undefined;
  private answerDeliveryAttempted = false;
  private readonly toolActivityEntries: Array<{ line: string; count: number }> = [];
  private dismissPromise: Promise<void> | undefined;
  private finished = false;

  constructor(options: ResilientMessageStreamOptions) {
    this.transport = options.transport;
    this.initialStatusText = normalizeTrailing(
      options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
      EMPTY_FINAL_TEXT,
    );
    this.statusText = this.initialStatusText;
    this.editDebounceMs = options.editDebounceMs ?? DEFAULT_EDIT_DEBOUNCE_MS;
    this.maxMessageChars = options.maxMessageChars ?? options.transport.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.maxSendRetries = options.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
    this.retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.showHints = options.showHints ?? true;
    this.formatMarkdown = options.formatMarkdown ?? true;
    this.finalOnly = options.finalOnly ?? false;
    this.abortSignal = options.abortSignal;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.logger = options.logger;

    if (!Number.isInteger(this.maxMessageChars) || this.maxMessageChars < 32) {
      throw new RangeError("maxMessageChars must be an integer of at least 32.");
    }
    if (!Number.isFinite(this.editDebounceMs) || this.editDebounceMs < 0) {
      throw new RangeError("editDebounceMs must be a non-negative number.");
    }
    if (!Number.isInteger(this.maxSendRetries) || this.maxSendRetries < 0) {
      throw new RangeError("maxSendRetries must be a non-negative integer.");
    }
    if (!Number.isFinite(this.retryCapMs) || this.retryCapMs < 0) {
      throw new RangeError("retryCapMs must be a non-negative number.");
    }
    if (!Number.isFinite(this.retryBaseDelayMs) || this.retryBaseDelayMs < 0) {
      throw new RangeError("retryBaseDelayMs must be a non-negative number.");
    }
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    if (this.toolActivityEntries.length === 0) {
      this.statusText = normalizeTrailing(text, EMPTY_FINAL_TEXT);
    }
    if (this.finalOnly) {
      if (this.toolActivityEntries.length === 0) {
        await this.maybeIndicateActivity();
      }
      return;
    }
    await this.awaitInFlightEdit();
    const hadMessage = this.sentMessage !== undefined;
    await this.ensureMessage();
    if (hadMessage && !this.hasAnswerText) {
      await this.deliverText(this.statusText, { final: false, contentKind: "status" });
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    if (delta.length === 0) {
      return;
    }
    this.currentText += delta;
    if (!this.hasAnswerText && delta.trim().length > 0) {
      this.hasAnswerText = true;
    }
    if (this.finalOnly) {
      // Accumulate the answer but do not post/edit until finish(); just keep the
      // working indicator alive until a visible tool ledger takes over.
      if (this.toolActivityEntries.length === 0) {
        await this.maybeIndicateActivity();
      }
      return;
    }
    await this.awaitInFlightEdit();
    await this.ensureMessage();
    this.scheduleEdit();
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
    if (text.trim().length > 0) {
      this.hasAnswerText = true;
    }
    if (this.finalOnly) {
      if (this.toolActivityEntries.length === 0) {
        await this.maybeIndicateActivity();
      }
      return;
    }
    await this.awaitInFlightEdit();
    await this.ensureMessage();
    this.scheduleEdit();
  }

  async event(event: AgentStreamEvent): Promise<void> {
    this.assertOpen();

    if (this.finalOnly) {
      if (event.type === "runtime_warning") {
        this.logger?.warn?.("Resilient stream received runtime warning.", {
          warningKind: event.warningKind,
          message: event.message,
        });
        return;
      }
      if (event.type === "tool_call_started") {
        this.logger?.debug?.("Resilient stream received tool start event.", {
          id: event.id,
          name: event.name,
        });
        if (!this.showHints) {
          await this.maybeIndicateActivity();
          return;
        }

        const liveInputActivity = isLiveInputActivity(event);
        if (liveInputActivity) {
          await this.relocateTransientForLiveInput();
        } else {
          await this.awaitInFlightEdit();
        }
        this.appendToolActivity(
          liveInputActivity ? event.name : formatToolActivityLine(event.name, event.arguments),
        );
        const hadMessage = this.sentMessage !== undefined;
        try {
          await this.ensureMessage();
          if (hadMessage) {
            this.scheduleEdit();
          }
        } catch (error) {
          // Progress is best-effort. A failed transient post must never abort a
          // successful model run or poison the later classified final send.
          this.logger?.warn?.("Resilient stream transient activity post failed (ignored).", {
            error: errorMessage(error),
          });
          await this.maybeIndicateActivity();
        }
        return;
      }
      if (event.type === "tool_call_completed") {
        this.logger?.debug?.("Resilient stream received tool completion event.", {
          id: event.id,
          name: event.name,
          isError: event.isError === true,
        });
      }
      if (this.toolActivityEntries.length === 0) {
        await this.maybeIndicateActivity();
      }
      return;
    }

    await this.awaitInFlightEdit();

    if (event.type === "assistant_thought") {
      // Reasoning prose is never rendered to the user — not as a labelled
      // "Thinking" message, not inline. It is dropped entirely.
      return;
    }

    if (event.type === "runtime_warning") {
      this.logger?.warn?.("Resilient stream received runtime warning.", {
        warningKind: event.warningKind,
        message: event.message,
      });
      return;
    }

    if (event.type === "tool_call_started") {
      this.logger?.debug?.("Resilient stream received tool start event.", {
        id: event.id,
        name: event.name,
      });
      // Surface a lightweight, friendly activity hint while we work. Hints only
      // refresh the message until answer text starts arriving, at which point
      // the streamed answer takes over and is never clobbered by a later hint.
      if (!this.showHints || this.hasAnswerText) {
        return;
      }
      this.statusText = normalizeTrailing(
        isLiveInputActivity(event) ? event.name : toolHintFor(event.name),
        EMPTY_FINAL_TEXT,
      );
      const hadMessage = this.sentMessage !== undefined;
      await this.ensureMessage();
      if (hadMessage) {
        await this.deliverText(this.statusText, { final: false, contentKind: "status" });
      } else {
        this.scheduleEdit();
      }
      return;
    }

    if (event.type === "tool_call_completed") {
      this.logger?.debug?.("Resilient stream received tool completion event.", {
        id: event.id,
        name: event.name,
        isError: event.isError === true,
      });
    }
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
      if (finalText.trim().length > 0) {
        this.hasAnswerText = true;
      }
    }

    this.cancelScheduledEdit();
    await this.awaitInFlightEdit();

    const finalMessageText = normalizeTrailing(this.currentText, EMPTY_FINAL_TEXT);
    const chunks = splitTextByCodePoints(finalMessageText, this.maxMessageChars);
    const [firstChunk, ...remainingChunks] = chunks;

    // Final-only mode posts the answer for the first time at finish(): deliver it
    // as a fresh post THROUGH the classified retry path (`post: true`) so the
    // single send still gets retry, markdown→plain fallback, and lastResortSend —
    // never a bare unprotected post. (Streaming mode keeps its placeholder+edit
    // sequence: ensureMessage runs inside deliverText's retry loop.)
    const post = this.finalOnly && this.sentMessage === undefined;
    try {
      await this.deliverText(firstChunk ?? EMPTY_FINAL_TEXT, { final: true, post, contentKind: "answer" });
    } catch (error) {
      if (this.abortSignal?.aborted === true) {
        // Cancelled: deliver in place if we can, but never post a brand-new
        // message carrying content the user has already asked us to drop.
        this.logger?.warn?.("Resilient final delivery skipped after cancellation.", {
          error: errorMessage(error),
        });
        return;
      }
      await this.lastResortSend(firstChunk ?? EMPTY_FINAL_TEXT, error);
    }
    if (this.abortSignal?.aborted === true) {
      // Do not spray overflow continuation messages onto a cancelled run.
      return;
    }
    for (const chunk of remainingChunks) {
      await this.sendOverflowChunk(chunk);
    }
  }

  /** Remove a confirmed status bubble without ever deleting an answer. */
  async dismissTransient(): Promise<void> {
    if (this.dismissPromise === undefined) {
      this.dismissPromise = this.performDismissTransient();
    }
    await this.dismissPromise;
  }

  private interimDisplayText(): string {
    if (this.finalOnly && this.toolActivityEntries.length > 0) {
      return buildStreamingTailPreview(
        normalizeTrailing(this.statusText, EMPTY_FINAL_TEXT),
        this.maxMessageChars,
        "…\n",
      );
    }
    if (this.hasAnswerText || this.currentText.length > 0) {
      // The answer streams directly — no label.
      return buildStreamingTailPreview(
        normalizeTrailing(this.currentText, EMPTY_FINAL_TEXT),
        this.maxMessageChars,
        "…\n",
      );
    }
    // No answer yet: show the current status/activity hint as-is.
    return buildStreamingTailPreview(
      normalizeTrailing(this.statusText, EMPTY_FINAL_TEXT),
      this.maxMessageChars,
      "…\n",
    );
  }

  private render(text: string, markdown: boolean): string {
    if (!markdown) {
      return text;
    }
    return this.transport.renderMarkdown ? this.transport.renderMarkdown(text) : text;
  }

  /**
   * Surface a "working" affordance (typing/seen) via the transport, throttled so
   * frequent reasoning/tool events do not spam the channel. Best-effort: failures
   * are logged and swallowed so an indicator hiccup never affects the run.
   */
  private async maybeIndicateActivity(): Promise<void> {
    if (this.transport.indicateActivity === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.lastActivityIndicatedAt < ACTIVITY_INDICATE_THROTTLE_MS) {
      return;
    }
    this.lastActivityIndicatedAt = now;
    try {
      await this.transport.indicateActivity();
    } catch (error) {
      this.logger?.debug?.("Resilient stream activity indicator failed (ignored).", {
        error: errorMessage(error),
      });
    }
  }

  private async ensureMessage(): Promise<MessageRef> {
    if (this.sentMessage !== undefined) {
      return this.sentMessage;
    }

    if (this.sendMessagePromise === undefined) {
      const initialText = this.statusText;
      this.sendMessagePromise = this.transport
        .post(initialText, { markdown: false, contentKind: "status" })
        .then((message) => {
          this.lastFlushedText = initialText;
          this.lastFlushedMarkdown = false;
          this.lastFlushedContentKind = "status";
          return message;
        });
    }

    try {
      this.sentMessage = await this.sendMessagePromise;
    } catch (error) {
      // Do not poison future sends with a rejected promise.
      this.sendMessagePromise = undefined;
      throw error;
    }
    return this.sentMessage;
  }

  private scheduleEdit(): void {
    this.cancelScheduledEdit();

    if (this.editDebounceMs === 0) {
      this.startInFlightEdit();
      return;
    }

    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      this.startInFlightEdit();
    }, this.editDebounceMs);
  }

  private startInFlightEdit(): void {
    const text = this.interimDisplayText();
    this.inFlightEdit = this.deliverText(text, {
      final: false,
      contentKind: this.finalOnly && this.toolActivityEntries.length > 0
        ? "status"
        : this.hasAnswerText || this.currentText.length > 0
          ? "answer"
          : "status",
    }).catch((error: unknown) => {
      // Interim edits are best-effort; deliverText already swallows, but guard
      // against an abort rejection so a streaming hiccup never aborts the run.
      this.logger?.warn?.("Resilient stream interim edit failed (ignored).", {
        error: errorMessage(error),
      });
    });
    void this.inFlightEdit;
  }

  /**
   * Send `sourceText` to the channel, classifying failures and recovering where
   * possible. Interim edits (`final: false`) are best-effort and never throw;
   * final delivery retries transient failures and throws ChannelDeliveryError
   * only when every path is exhausted.
   */
  private async deliverText(
    sourceText: string,
    options: { final: boolean; post?: boolean; contentKind: ChannelMessageContentKind },
  ): Promise<void> {
    if (options.contentKind === "answer") {
      // Once an answer write is attempted, deletion is unsafe even if the
      // channel returns an ambiguous failure: the edit may have landed.
      this.answerDeliveryAttempted = true;
    }
    const normalizedSource = normalizeTrailing(sourceText, EMPTY_FINAL_TEXT);
    let useMarkdown = options.final && this.formatMarkdown;
    let renderedText = this.render(normalizedSource, useMarkdown);

    if (
      renderedText === this.lastFlushedText
      && useMarkdown === this.lastFlushedMarkdown
      && options.contentKind === this.lastFlushedContentKind
    ) {
      return;
    }

    const maxAttempts = options.final ? this.maxSendRetries + 1 : 1;
    // `post: true` delivers via a fresh transport.post() inside the classified
    // retry loop (used for the final-only first send) instead of edit-in-place.
    let recreate = options.post === true;
    let lastError: unknown;
    let sawUnknownFailure = false;
    let lastOutcome: ChannelSendOutcome | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (recreate) {
          const sent = await this.transport.post(renderedText, {
            markdown: useMarkdown,
            contentKind: options.contentKind,
          });
          this.sentMessage = sent;
        } else {
          const message = await this.ensureMessage();
          await this.transport.edit(message, renderedText, {
            markdown: useMarkdown,
            contentKind: options.contentKind,
          });
        }
        this.lastFlushedText = renderedText;
        this.lastFlushedMarkdown = useMarkdown;
        this.lastFlushedContentKind = options.contentKind;
        return;
      } catch (error) {
        lastError = error;
        const outcome = this.transport.classifyError(error);
        lastOutcome = outcome;
        sawUnknownFailure ||= outcome.failureCertainty !== "not_delivered";
        if (outcome.kind === "not_modified") {
          this.lastFlushedText = renderedText;
          this.lastFlushedMarkdown = useMarkdown;
          this.lastFlushedContentKind = options.contentKind;
          return;
        }
        if (outcome.kind === "reformat_plain" && useMarkdown) {
          useMarkdown = false;
          renderedText = normalizedSource;
          continue;
        }
        if (outcome.kind === "recreate" && this.abortSignal?.aborted !== true) {
          recreate = true;
          this.sentMessage = undefined;
          // Also drop the resolved first-send promise: otherwise a later
          // ensureMessage() reuses it and revives the deleted message ref
          // instead of posting a fresh message.
          this.sendMessagePromise = undefined;
          this.lastFlushedText = undefined;
          continue;
        }
        if (outcome.kind === "retry" && options.final && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            break;
          }
          continue;
        }
        break;
      }
    }

    if (options.final) {
      throw new ChannelDeliveryError("Channel final delivery failed.", {
        cause: lastError,
        attempts: maxAttempts,
        disposition: deliveryDisposition(lastOutcome, sawUnknownFailure),
      });
    }
    this.logger?.warn?.("Resilient stream interim edit failed (ignored).", {
      error: errorMessage(lastError),
    });
  }

  /**
   * The streamed message could not be edited or recreated in place. Post the
   * final answer as a brand-new plain message so the user still receives it.
   */
  private async lastResortSend(text: string, cause: unknown): Promise<void> {
    const normalized = normalizeTrailing(text, EMPTY_FINAL_TEXT);
    const maxAttempts = this.maxSendRetries + 1;
    let lastError: unknown = cause;
    let sawUnknownFailure = cause instanceof ChannelDeliveryError && cause.disposition === "unknown";
    let lastOutcome: ChannelSendOutcome | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sent = await this.transport.post(normalized, { markdown: false, contentKind: "answer" });
        this.sentMessage = sent;
        this.lastFlushedText = normalized;
        this.lastFlushedMarkdown = false;
        this.lastFlushedContentKind = "answer";
        return;
      } catch (error) {
        lastError = error;
        const outcome = this.transport.classifyError(error);
        lastOutcome = outcome;
        sawUnknownFailure ||= outcome.failureCertainty !== "not_delivered";
        if (outcome.kind === "retry" && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            break;
          }
          continue;
        }
        break;
      }
    }

    throw new ChannelDeliveryError("Channel delivery failed after fallback send.", {
      cause: lastError,
      attempts: maxAttempts,
      disposition: deliveryDisposition(lastOutcome, sawUnknownFailure),
    });
  }

  /**
   * Deliver every overflow chunk or fail the final delivery. Once the primary
   * chunk has landed a later failure is necessarily ambiguous to the caller;
   * silently accepting it would falsely acknowledge a truncated answer.
   */
  private async sendOverflowChunk(chunk: string): Promise<void> {
    const normalized = normalizeTrailing(chunk, EMPTY_FINAL_TEXT);
    const maxAttempts = this.maxSendRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.transport.post(normalized, { markdown: false, contentKind: "answer" });
        return;
      } catch (error) {
        lastError = error;
        const outcome = this.transport.classifyError(error);
        if (outcome.kind === "retry" && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(outcome.retryAfterMs, attempt));
          if (this.abortSignal?.aborted === true) {
            break;
          }
          continue;
        }
        break;
      }
    }

    throw new ChannelDeliveryError("Channel overflow delivery failed after the primary chunk was posted.", {
      cause: lastError,
      attempts: maxAttempts,
      disposition: "unknown",
    });
  }

  private retryDelayMs(retryAfterMs: number | undefined, attempt: number): number {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const chosen = retryAfterMs ?? backoff;
    return Math.min(chosen, this.retryCapMs);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.abortSignal?.aborted === true) {
      return;
    }
    await this.sleepFn(ms, this.abortSignal);
  }

  private cancelScheduledEdit(): void {
    if (this.editTimer !== undefined) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  private appendToolActivity(line: string): void {
    const last = this.toolActivityEntries.at(-1);
    if (last?.line === line) {
      last.count += 1;
    } else {
      this.toolActivityEntries.push({ line, count: 1 });
      // Runtime turn limits normally keep this far smaller. The cap prevents a
      // pathological tool loop from growing a user-visible transient ledger
      // without bound; the channel tail preview still preserves newest work.
      if (this.toolActivityEntries.length > 512) {
        this.toolActivityEntries.shift();
      }
    }
    this.statusText = this.toolActivityEntries
      .map((entry) => entry.count === 1 ? entry.line : `${entry.line} (×${entry.count})`)
      .join("\n");
  }

  /**
   * Move a confirmed final-only status behind the human follow-up that just
   * steered the run. Deletion is best-effort: an ambiguous/failed delete keeps
   * the existing reference so the cumulative ledger is edited in place and the
   * final answer remains deliverable.
   */
  private async relocateTransientForLiveInput(): Promise<void> {
    this.cancelScheduledEdit();
    await this.awaitInFlightEdit();

    if (this.sentMessage === undefined && this.sendMessagePromise !== undefined) {
      try {
        this.sentMessage = await this.sendMessagePromise;
      } catch {
        // The status never landed. ensureMessage() below will post the current
        // cumulative ledger after the live-input entry is appended.
        this.sendMessagePromise = undefined;
      }
    }
    if (
      this.sentMessage === undefined
      || this.transport.delete === undefined
      || this.lastFlushedContentKind !== "status"
      || this.answerDeliveryAttempted
    ) {
      return;
    }

    try {
      await this.transport.delete(this.sentMessage);
      this.sentMessage = undefined;
      this.sendMessagePromise = undefined;
      this.lastFlushedText = undefined;
      this.lastFlushedMarkdown = false;
      this.lastFlushedContentKind = undefined;
    } catch (error) {
      this.logger?.debug?.(
        "Resilient stream live-input activity relocation failed (editing in place).",
        { error: errorMessage(error) },
      );
    }
  }

  private async performDismissTransient(): Promise<void> {
    this.finished = true;
    this.cancelScheduledEdit();
    await this.awaitInFlightEdit();

    if (this.sentMessage === undefined && this.sendMessagePromise !== undefined) {
      try {
        this.sentMessage = await this.sendMessagePromise;
      } catch {
        // The transient never landed, so there is nothing to dismiss.
      }
    }
    if (
      this.sentMessage === undefined
      || this.transport.delete === undefined
      || this.lastFlushedContentKind !== "status"
      || this.answerDeliveryAttempted
    ) {
      return;
    }
    try {
      await this.transport.delete(this.sentMessage);
      this.sentMessage = undefined;
      this.sendMessagePromise = undefined;
      this.lastFlushedText = undefined;
      this.lastFlushedContentKind = undefined;
    } catch (error) {
      this.logger?.debug?.("Resilient stream transient activity deletion failed (ignored).", {
        error: errorMessage(error),
      });
    }
  }

  private async awaitInFlightEdit(): Promise<void> {
    if (this.inFlightEdit !== undefined) {
      await this.inFlightEdit;
      this.inFlightEdit = undefined;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished ResilientMessageStream.");
    }
  }
}

/** Default abort-aware sleep used when no `sleep` is injected. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error === null
    || error === undefined
    || typeof error === "number"
    || typeof error === "boolean"
  ) {
    return String(error);
  }
  if (typeof error === "bigint") return "[BigInt]";
  if (typeof error === "symbol") return "[Symbol]";
  if (typeof error !== "object" && typeof error !== "function") {
    return "[Error details unavailable]";
  }
  if (nodeUtilTypes.isProxy(error)) return "[Error details unavailable]";

  const visited = new Set<object>();
  let current: object | null = error;
  while (current !== null && !visited.has(current) && visited.size < 16) {
    if (nodeUtilTypes.isProxy(current)) return "[Error details unavailable]";
    visited.add(current);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, "message");
      if (descriptor !== undefined) {
        return "value" in descriptor && typeof descriptor.value === "string"
          ? descriptor.value
          : "[Error details unavailable]";
      }
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return "[Error details unavailable]";
    }
  }
  return "[Error details unavailable]";
}

function deliveryDisposition(
  outcome: ChannelSendOutcome | undefined,
  sawUnknownFailure: boolean,
): ChannelDeliveryDisposition {
  if (sawUnknownFailure || outcome === undefined) return "unknown";
  return outcome.kind === "retry" ? "retryable" : "permanent";
}

function isLiveInputActivity(
  event: Extract<AgentStreamEvent, { type: "tool_call_started" }>,
): boolean {
  return event.metadata?.liveInput === true && event.metadata.synthetic === true;
}

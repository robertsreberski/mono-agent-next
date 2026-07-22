import {
  ChannelDeliveryError,
  ResilientMessageStream,
} from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";
import type {
  AgentMessageStream as AgentMessageStreamBase,
  AgentStreamEvent,
  ChannelDeliveryDisposition,
  ChannelMessageContentKind,
  ChannelSendOutcome,
  ChannelTransport,
  MessageRef,
  ResilientMessageStreamLogger,
} from "@mono-agent/agent-contracts";

import {
  isSafeSlackPrototypeInstance,
  readSafeSlackDataProperty,
  redactSlackErrorMessage,
} from "./log-redaction.js";
import { SlackApiError } from "./slack-client.js";
import type {
  SlackChannelId,
  SlackChatPostMessageResult,
  SlackMessageTs,
  SlackWebApi,
} from "./types.js";
import { formatMarkdownForSlack } from "./slack-markdown.js";

export interface AgentMessageStream extends AgentMessageStreamBase {
  status(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace(text: string): Promise<void>;
  event(event: AgentStreamEvent): Promise<void>;
  finish(finalText?: string): Promise<void>;
}

export type SlackMessageStreamLogger = ResilientMessageStreamLogger;

export interface SlackMessageStreamOptions {
  api: SlackWebApi;
  channelId: SlackChannelId;
  threadTs?: SlackMessageTs;
  /** Stable UUID forwarded to chat.postMessage for duplicate suppression. */
  clientMsgId?: string;
  /**
   * Compatibility request for notification-suppressed delivery. Slack's
   * `chat.postMessage` API has no bot-controlled suppression field, so this
   * stream posts normally and, when a logger is configured, emits one explicit
   * warning before its first post.
   */
  silent?: boolean;
  /** Message ts to react to (👀 "seen") in final-only mode. */
  reactToTs?: SlackMessageTs;
  /**
   * Deliver only the final answer: suppress interim edits and react 👀 ("seen")
   * while the agent works. Default false.
   */
  finalOnly?: boolean;
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  /** Maximum retries for a *final* delivery before giving up. Default 3. */
  maxSendRetries?: number;
  /** Upper bound on any honored `retry-after`/backoff wait, in ms. Default 60000. */
  retryCapMs?: number;
  /** Base delay for exponential backoff between final-delivery retries. Default 500. */
  retryBaseDelayMs?: number;
  /** Render lightweight tool activity hints as the live status. Default true. */
  showHints?: boolean;
  /**
   * Status shown via `assistant.threads.setStatus` ("App is <status>") while the
   * agent works, when this is a Slack AI-assistant thread. Falls back to the 👀
   * reaction in regular channels/DMs. Default "is thinking…".
   */
  assistantStatusText?: string;
  /** Aborts in-flight retry waits (e.g. on /cancel). */
  abortSignal?: AbortSignal;
  logger?: SlackMessageStreamLogger;
  /**
   * Notified with each message this stream posts. Used to link a posted message
   * back to the conversation that produced it, so a later in-thread reply can
   * resume that conversation (see `posted-message-index` in agent-app).
   */
  onPosted?: SlackPostedMessageListener;
  /** Notified after a status or answer post/edit has a native Slack receipt. */
  onDeliveryReceipt?: SlackDeliveryReceiptListener;
}

/** Notified with the channel + ts of a message a stream posted. */
export type SlackPostedMessageListener = (ref: { ts: SlackMessageTs; channel: SlackChannelId }) => void;

export interface SlackDeliveryReceipt {
  readonly ts: SlackMessageTs;
  readonly channel: SlackChannelId;
  readonly contentKind: ChannelMessageContentKind;
  readonly operation: "post" | "edit";
}

export type SlackDeliveryReceiptListener = (receipt: SlackDeliveryReceipt) => void;

/**
 * Raised only when a *final* delivery cannot reach Slack after retries and the
 * last-resort fresh post. The AI request itself already succeeded, so the
 * adapter treats this as a degraded delivery — never as an agent failure.
 *
 * Retained as the adapter's public error type; the shared substrate raises a
 * {@link ChannelDeliveryError}, which this class normalizes so callers continue
 * to catch `SlackDeliveryError`.
 */
export class SlackDeliveryError extends Error {
  override readonly cause: unknown;
  readonly attempts: number;
  readonly disposition: ChannelDeliveryDisposition;

  constructor(message: string, details: {
    cause: unknown;
    attempts: number;
    disposition?: ChannelDeliveryDisposition;
  }) {
    super(message);
    this.name = "SlackDeliveryError";
    this.cause = details.cause;
    this.attempts = details.attempts;
    this.disposition = details.disposition ?? "unknown";
  }
}

/** How a failed Slack post/update should be handled. */
export type SlackSendOutcome =
  | { kind: "recreate"; failureCertainty: "not_delivered" | "unknown" }
  | { kind: "reformat_plain"; failureCertainty: "not_delivered" | "unknown" }
  | { kind: "retry"; retryAfterMs?: number; failureCertainty: "not_delivered" | "unknown" }
  | { kind: "fatal"; failureCertainty: "not_delivered" | "unknown" };

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking...";
const DEFAULT_ASSISTANT_STATUS_TEXT = "is thinking…";
export const SLACK_MAX_MESSAGE_CHARS = 40_000;

/**
 * Adapts a {@link SlackWebApi} to the transport-agnostic {@link ChannelTransport}
 * the shared {@link ResilientMessageStream} drives. Posts/edits map to
 * chat.postMessage / chat.update (preserving `thread_ts`), failures are mapped
 * through {@link classifySlackError}, and markdown renders via
 * {@link formatMarkdownForSlack}. `mrkdwn` mirrors the substrate's markdown flag
 * so a `reformat_plain` retry drops to plain text.
 */
class SlackChannelTransport implements ChannelTransport {
  readonly maxMessageChars: number;
  private readonly api: SlackWebApi;
  private readonly channelId: SlackChannelId;
  private readonly threadTs: SlackMessageTs | undefined;
  private readonly clientMsgId: string | undefined;
  private readonly silentRequested: boolean;
  private readonly reactToTs: SlackMessageTs | undefined;
  private readonly assistantStatusText: string;
  private readonly onPosted: SlackPostedMessageListener | undefined;
  private readonly onDeliveryReceipt: SlackDeliveryReceiptListener | undefined;
  private readonly logger: SlackMessageStreamLogger | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private transientStatusMessage: MessageRef | undefined;
  private postFinalAnswerSeparately = false;
  /**
   * Logical post number for this stream. It advances only after Slack returns a
   * receipt, so a classified retry reuses the same client_msg_id while an
   * overflow chunk gets a different one.
   */
  private postIndex = 0;
  private reacted = false;
  private assistantStatusUnavailable = false;
  private silentWarningEmitted = false;

  constructor(options: {
    api: SlackWebApi;
    channelId: SlackChannelId;
    threadTs?: SlackMessageTs;
    clientMsgId?: string;
    silent: boolean;
    reactToTs?: SlackMessageTs;
    assistantStatusText: string;
    maxMessageChars: number;
    onPosted?: SlackPostedMessageListener;
    onDeliveryReceipt?: SlackDeliveryReceiptListener;
    logger?: SlackMessageStreamLogger;
    abortSignal?: AbortSignal;
  }) {
    this.api = options.api;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.clientMsgId = options.clientMsgId;
    this.silentRequested = options.silent;
    this.reactToTs = options.reactToTs;
    this.assistantStatusText = options.assistantStatusText;
    this.maxMessageChars = options.maxMessageChars;
    this.onPosted = options.onPosted;
    this.onDeliveryReceipt = options.onDeliveryReceipt;
    this.logger = options.logger;
    this.abortSignal = options.abortSignal;
  }

  /** Keep a final-only tool ledger transient and post the completed answer fresh. */
  beginSeparateFinalAnswer(): void {
    this.postFinalAnswerSeparately = true;
  }

  async indicateActivity(): Promise<void> {
    // Prefer Slack's official assistant-thread status ("App is <status>"), which
    // Slack auto-clears when the app posts its next message to the thread. It only
    // works inside an AI-assistant thread (needs the assistant:write scope), so if
    // it is unavailable or errors we stop trying for this stream and fall back to
    // the 👀 reaction used in regular channels/DMs.
    if (
      !this.assistantStatusUnavailable &&
      this.threadTs !== undefined &&
      this.api.setAssistantStatus !== undefined
    ) {
      try {
        await this.api.setAssistantStatus({
          channelId: this.channelId,
          threadTs: this.threadTs,
          status: this.assistantStatusText,
        });
        return;
      } catch {
        // Not an assistant thread (or missing scope): don't retry it this stream.
        this.assistantStatusUnavailable = true;
      }
    }
    // Slack has no bot "typing" indicator, so signal "seen" with a 👀 reaction on
    // the triggering message — added once (Slack rejects duplicates).
    if (this.reacted || this.reactToTs === undefined || this.api.reactionsAdd === undefined) {
      return;
    }
    this.reacted = true;
    await this.api.reactionsAdd({ channel: this.channelId, timestamp: this.reactToTs, name: "eyes" });
  }

  async post(
    text: string,
    options: { markdown: boolean; contentKind?: ChannelMessageContentKind },
  ): Promise<MessageRef> {
    this.warnIfSilentDeliveryIsUnsupported();
    const clientMsgId = this.clientMsgId === undefined
      ? undefined
      : slackPostClientMessageId(this.clientMsgId, this.postIndex);
    const sent = await this.api.chatPostMessage(
      this.withThread({
        channel: this.channelId,
        text,
        mrkdwn: options.markdown,
        ...(clientMsgId === undefined ? {} : { client_msg_id: clientMsgId }),
      }),
    );
    this.postIndex += 1;
    // Use `sent` (typed SlackChatPostMessageResult) rather than the transport-agnostic
    // MessageRef, whose `channel` widens to `unknown`.
    try {
      this.onPosted?.({ ts: sent.ts, channel: sent.channel });
    } catch (error) {
      // Slack already returned a receipt. Observer/index failures must never
      // turn a confirmed post into a transport retry and duplicate the message.
      this.logger?.warn?.("Slack post observer failed after confirmed delivery.", {
        reason: redactSlackErrorMessage(error),
      });
    }
    this.observeDelivery({
      ts: sent.ts,
      channel: sent.channel,
      contentKind: options.contentKind ?? "answer",
      operation: "post",
    });
    const ref = slackMessageRef(sent);
    if (options.contentKind === "status") {
      this.transientStatusMessage = ref;
    } else if (options.contentKind === "answer" && this.postFinalAnswerSeparately) {
      await this.dismissTransientStatus();
    }
    return ref;
  }

  private warnIfSilentDeliveryIsUnsupported(): void {
    if (!this.silentRequested || this.silentWarningEmitted) {
      return;
    }
    this.silentWarningEmitted = true;
    try {
      this.logger?.warn?.(
        "Slack chat.postMessage has no bot-controlled silent-delivery option; posting with normal Slack notification behavior.",
        { silentRequested: true, silentApplied: false },
      );
    } catch {
      // Diagnostics are best-effort. A broken logger must not prevent or retry
      // the normal Slack delivery this warning describes.
    }
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
    await this.api.chatUpdate({
      channel: this.channelId,
      ts: ref.id,
      text,
      mrkdwn: options.markdown,
    });
    this.observeDelivery({
      ts: ref.id,
      channel: this.channelId,
      contentKind: options.contentKind ?? "answer",
      operation: "edit",
    });
  }

  async delete(ref: MessageRef): Promise<void> {
    if (this.api.chatDelete === undefined) {
      throw new Error("Slack chat.delete is unavailable on this client.");
    }
    await this.api.chatDelete({ channel: this.channelId, ts: ref.id });
    if (this.transientStatusMessage?.id === ref.id) {
      this.transientStatusMessage = undefined;
    }
  }

  classifyError(error: unknown): ChannelSendOutcome {
    return classifySlackError(error);
  }

  renderMarkdown(text: string): string {
    return formatMarkdownForSlack(text);
  }

  private observeDelivery(receipt: SlackDeliveryReceipt): void {
    try {
      this.onDeliveryReceipt?.(receipt);
    } catch (error) {
      // As with posted-message indexing, an observer runs only after Slack has
      // confirmed the write and must never turn that receipt into a retry.
      this.logger?.warn?.("Slack delivery observer failed after confirmed delivery.", {
        reason: redactSlackErrorMessage(error),
      });
    }
  }

  private withThread<T extends { thread_ts?: SlackMessageTs }>(
    params: Omit<T, "thread_ts">,
  ): T {
    if (this.threadTs === undefined) {
      return params as T;
    }
    return { ...params, thread_ts: this.threadTs } as T;
  }

  private async dismissTransientStatus(): Promise<void> {
    const ref = this.transientStatusMessage;
    this.transientStatusMessage = undefined;
    if (ref === undefined || this.api.chatDelete === undefined) {
      return;
    }
    try {
      await this.api.chatDelete({ channel: this.channelId, ts: ref.id });
    } catch (error) {
      // The answer already landed. Keep it authoritative and never risk a
      // duplicate final merely because transient cleanup failed.
      this.logger?.debug?.("Slack transient progress deletion failed after final delivery (ignored).", {
        error: redactSlackErrorMessage(error),
      });
    }
  }
}

/** Stable UUID per logical Slack post, including overflow chunks. */
function slackPostClientMessageId(baseId: string, postIndex: number): string {
  const bytes = createHash("sha256")
    .update(`mono-agent-slack-post\0${baseId}\0${String(postIndex)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function slackMessageRef(message: SlackChatPostMessageResult): MessageRef {
  return { id: message.ts, channel: message.channel };
}

/**
 * Thin wrapper over the shared {@link ResilientMessageStream}. It builds a
 * {@link SlackChannelTransport} and delegates the streaming/resilience FSM,
 * preserving the adapter's public surface: the `status/append/replace/event/
 * finish` API, friendly tool hints, abort-aware retries, and a Slack-shaped
 * delivery error.
 */
export class SlackMessageStream implements AgentMessageStream {
  private readonly transport: SlackChannelTransport;
  private readonly inner: ResilientMessageStream;
  private readonly finalOnly: boolean;

  constructor(options: SlackMessageStreamOptions) {
    const maxMessageChars = options.maxMessageChars ?? SLACK_MAX_MESSAGE_CHARS;
    this.finalOnly = options.finalOnly ?? false;
    this.transport = new SlackChannelTransport({
      api: options.api,
      channelId: options.channelId,
      ...(options.threadTs === undefined ? {} : { threadTs: options.threadTs }),
      ...(options.clientMsgId === undefined ? {} : { clientMsgId: options.clientMsgId }),
      silent: options.silent ?? false,
      ...(options.reactToTs === undefined ? {} : { reactToTs: options.reactToTs }),
      assistantStatusText: options.assistantStatusText ?? DEFAULT_ASSISTANT_STATUS_TEXT,
      maxMessageChars,
      ...(options.onPosted === undefined ? {} : { onPosted: options.onPosted }),
      ...(options.onDeliveryReceipt === undefined ? {} : { onDeliveryReceipt: options.onDeliveryReceipt }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });

    this.inner = new ResilientMessageStream({
      transport: this.transport,
      initialStatusText: options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
      maxMessageChars,
      formatMarkdown: true,
      ...(options.finalOnly === undefined ? {} : { finalOnly: options.finalOnly }),
      ...(options.editDebounceMs === undefined ? {} : { editDebounceMs: options.editDebounceMs }),
      ...(options.maxSendRetries === undefined ? {} : { maxSendRetries: options.maxSendRetries }),
      ...(options.retryCapMs === undefined ? {} : { retryCapMs: options.retryCapMs }),
      ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
      ...(options.showHints === undefined ? {} : { showHints: options.showHints }),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  status(text: string): Promise<void> {
    return this.inner.status(text);
  }

  append(delta: string): Promise<void> {
    return this.inner.append(delta);
  }

  replace(text: string): Promise<void> {
    return this.inner.replace(text);
  }

  event(event: AgentStreamEvent): Promise<void> {
    return this.inner.event(event);
  }

  dismissTransient(): Promise<void> {
    return this.inner.dismissTransient();
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finalOnly) {
      this.transport.beginSeparateFinalAnswer();
    }
    try {
      await this.inner.finish(finalText);
    } catch (error) {
      if (isChannelDeliveryError(error)) {
        const attempts = readSafeSlackDataProperty(error, "attempts");
        throw new SlackDeliveryError("Slack final delivery failed.", {
          cause: readSafeSlackDataProperty(error, "cause"),
          attempts: typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts >= 0
            ? attempts
            : 0,
          disposition: safeDeliveryDisposition(
            readSafeSlackDataProperty(error, "disposition"),
          ),
        });
      }
      throw error;
    }
  }
}

/**
 * Classify a Slack post/update failure into a recovery strategy. Pure and
 * exported so the recovery policy can be unit-tested directly.
 */
export function classifySlackError(error: unknown): SlackSendOutcome {
  if (isSlackApiError(error)) {
    const rawSlackError = readSafeSlackDataProperty(error, "slackError");
    const slackError = typeof rawSlackError === "string" ? rawSlackError.toLowerCase() : "";
    const rawRetryAfterMs = readSafeSlackDataProperty(error, "retryAfterMs");
    const retryAfterMs = typeof rawRetryAfterMs === "number" ? rawRetryAfterMs : undefined;
    const rawStatus = readSafeSlackDataProperty(error, "status");
    const status = typeof rawStatus === "number" ? rawStatus : undefined;
    const kind = readSafeSlackDataProperty(error, "kind");
    if (
      slackError === "message_not_found" ||
      slackError === "cant_update_message" ||
      slackError === "edit_window_closed"
    ) {
      return { kind: "recreate", failureCertainty: "not_delivered" };
    }
    if (
      slackError === "invalid_blocks" ||
      slackError === "invalid_block_id" ||
      slackError === "msg_blocks_too_long" ||
      slackError === "as_user_not_supported"
    ) {
      return { kind: "reformat_plain", failureCertainty: "not_delivered" };
    }
    if (
      retryAfterMs !== undefined ||
      status === 429 ||
      slackError === "ratelimited" ||
      slackError === "rate_limited"
    ) {
      if (retryAfterMs !== undefined) {
        return { kind: "retry", retryAfterMs, failureCertainty: "not_delivered" };
      }
      return { kind: "retry", failureCertainty: "not_delivered" };
    }
    if (kind === "network") {
      return { kind: "retry", failureCertainty: "unknown" };
    }
    if (kind === "aborted") {
      return { kind: "fatal", failureCertainty: "unknown" };
    }
    if (status !== undefined && status >= 500) {
      return { kind: "retry", failureCertainty: "unknown" };
    }
    if (rawSlackError !== undefined || (status !== undefined && status >= 400)) {
      return { kind: "fatal", failureCertainty: "not_delivered" };
    }
    return { kind: "fatal", failureCertainty: "unknown" };
  }

  // Non-SlackApiError (e.g. a transient transport error or a test stub): retry
  // conservatively rather than surfacing it as a hard failure.
  return { kind: "retry", failureCertainty: "unknown" };
}

function isChannelDeliveryError(error: unknown): error is ChannelDeliveryError {
  return isSafeSlackPrototypeInstance(error, ChannelDeliveryError.prototype);
}

function isSlackApiError(error: unknown): error is SlackApiError {
  return isSafeSlackPrototypeInstance(error, SlackApiError.prototype);
}

function safeDeliveryDisposition(value: unknown): ChannelDeliveryDisposition {
  return value === "retryable" || value === "permanent" || value === "unknown"
    ? value
    : "unknown";
}

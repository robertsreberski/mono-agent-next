export type AgentRequestMetadata = Record<string, unknown>;
export type AgentResponseMetadata = Record<string, unknown>;
export type {
  MemoryBlock,
  MemoryCompletedTurn,
  MemoryCompletedTurnAdmissionStatus,
  MemoryCompletedTurnResult,
  MemoryLoadOptions,
  MemoryStore,
  MemoryWriteResult,
} from "./memory.js";

/**
 * Reserved final-text token a notify-enabled cron/webhook turn emits to suppress
 * its own notification ("nothing worth reporting"). Single source of truth shared
 * by the harness (which instructs the agent) and the app (which matches it before
 * delivery). Matched trimmed + case-insensitively; never substring-matched.
 */
export const NOTHING_TO_REPORT_SENTINEL = "NOTHING_TO_REPORT";

/**
 * A multimodal attachment that accompanies a request — an image to be fed to a
 * vision model, or a document whose bytes (and/or extracted text) can be inlined
 * into the prompt. Transport-agnostic: channels populate it; runtimes consume it.
 */
export interface AgentAttachment {
  readonly kind: "image" | "document";
  /** MIME type, e.g. "image/png" or "application/pdf". */
  readonly mimeType: string;
  /** Raw attachment bytes, base64-encoded. */
  readonly data: string;
  /** Original file name, when known. */
  readonly name?: string;
  /** Size of the decoded bytes, when known. */
  readonly sizeBytes?: number;
  /** Extracted text for documents, when available. */
  readonly text?: string;
  /** Media duration in seconds (audio/video), when the transport reports it. */
  readonly durationSeconds?: number;
}

/** Default decoded-byte ceiling shared by transports that ingest attachments. */
export const DEFAULT_AGENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Transport-neutral MIME types accepted by the built-in attachment flows.
 * Keeping this list beside {@link AgentAttachment} prevents browser and chat
 * adapters from drifting into subtly different upload behavior.
 */
export const DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
];

/** Classify an allowed MIME type into the runtime's two attachment kinds. */
export function agentAttachmentKindFromMimeType(mimeType: string): AgentAttachment["kind"] {
  return mimeType.trim().toLowerCase().startsWith("image/") ? "image" : "document";
}

/**
 * Decode the text payloads transports inline for the model. Binary and
 * application/* documents deliberately return undefined, matching the
 * established Telegram behavior.
 */
export function decodeAgentAttachmentText(
  mimeType: string,
  bytes: Uint8Array,
): string | undefined {
  if (!mimeType.trim().toLowerCase().startsWith("text/")) {
    return undefined;
  }
  // `ignoreBOM: true` means treat a leading BOM as ordinary decoded text,
  // matching Node Buffer's established Telegram UTF-8 behavior exactly.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Host-owned destination for a later reply.  This is deliberately separate
 * from {@link AgentRequestBase.conversationId}: the latter may be rewritten for
 * session rollover, while this value identifies the channel conversation that
 * can actually receive a reply.  Hosts must not copy it into model prompts,
 * tool arguments, or run artifacts.
 */
export interface AgentReplyTarget {
  readonly conversationId: string;
}

/** One host-owned message in a pinned continuation origin snapshot. */
export interface AgentContinuationContextMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly timestamp?: string;
  readonly runId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Exact bounded conversation context committed by the origin run. The host
 * pins this snapshot before returning a successful answer; continuation
 * synthesis consumes these bytes instead of consulting mutable/latest history.
 */
export interface AgentContinuationOriginContext {
  readonly schemaVersion: 1;
  /** Exact history identity, including an explicit rollover bucket. */
  readonly conversationId: string;
  readonly originRunId: string;
  readonly historyBoundary: string;
  readonly capturedAt: string;
  readonly messages: readonly AgentContinuationContextMessage[];
}

export const AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES = 64;
export const AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES = 64 * 1024;
export const AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES = 256 * 1024;

/** Deep host-boundary validation shared by harness and durable continuation storage. */
export function assertAgentContinuationOriginContext(
  value: unknown,
): asserts value is AgentContinuationOriginContext {
  if (!isPlainRecord(value)
    || !hasOnlyContinuationKeys(value, ["schemaVersion", "conversationId", "originRunId", "historyBoundary", "capturedAt", "messages"])
    || value.schemaVersion !== 1
    || !boundedContinuationString(value.conversationId, 2_048)
    || !boundedContinuationString(value.originRunId, 512)
    || !boundedContinuationString(value.historyBoundary, 512)
    || value.historyBoundary !== value.originRunId
    || !validContinuationDate(value.capturedAt)
    || !Array.isArray(value.messages)
    || value.messages.length < 2
    || value.messages.length > AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES) {
    throw new TypeError("Continuation origin context has an invalid envelope.");
  }
  for (const message of value.messages) {
    if (!isPlainRecord(message)
      || !hasOnlyContinuationKeys(message, ["role", "content", "name", "timestamp", "runId", "idempotencyKey"])
      || (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool")
      || typeof message.content !== "string"
      || continuationUtf8Bytes(message.content) > AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES
      || !optionalBoundedContinuationString(message.name, 512)
      || (message.timestamp !== undefined && !validContinuationDate(message.timestamp))
      || !optionalBoundedContinuationString(message.runId, 512)
      || !optionalBoundedContinuationString(message.idempotencyKey, 512)) {
      throw new TypeError("Continuation origin context contains an invalid message.");
    }
  }
  const user = value.messages.at(-2);
  const assistant = value.messages.at(-1);
  if (user?.role !== "user"
    || assistant?.role !== "assistant"
    || user.runId !== value.originRunId
    || assistant.runId !== value.originRunId
    || user.timestamp !== value.capturedAt
    || assistant.timestamp !== value.capturedAt) {
    throw new TypeError("Continuation origin context does not end with its completed origin turn.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Continuation origin context is not serializable.");
  }
  if (continuationUtf8Bytes(serialized) > AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES) {
    throw new TypeError("Continuation origin context exceeds its byte limit.");
  }
}

function continuationUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyContinuationKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function boundedContinuationString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && continuationUtf8Bytes(value) <= maxBytes;
}

function optionalBoundedContinuationString(value: unknown, maxBytes: number): boolean {
  return value === undefined || (typeof value === "string" && continuationUtf8Bytes(value) <= maxBytes);
}

function validContinuationDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/**
 * Host-only controls for a framework-owned continuation synthesis turn.
 *
 * A continuation turn is an isolated, tool-free reconstruction from a pinned
 * origin snapshot. Legacy/detached callers may omit `originContext`; an
 * interactive durable continuation must provide it. `originRunId` is trace
 * correlation, not an implicit history boundary. Its synthetic prompt and
 * generated answer are not committed to conversation history; the continuation
 * service commits the answer only after native channel delivery succeeds.
 */
interface AgentContinuationTurnBase {
  readonly continuationId: string;
  readonly originRunId: string;
  readonly toolsDisabled: true;
  readonly deferHistoryCommit: true;
}

/** Host-only continuation controls with impossible context states excluded at compile time. */
export type AgentContinuationTurn = AgentContinuationTurnBase & (
  | {
      readonly originContextPolicy: "pinned";
      readonly historyBoundary: string;
      readonly originContext: AgentContinuationOriginContext;
    }
  | {
      readonly originContextPolicy: "detached_latest";
      readonly historyBoundary?: never;
      readonly originContext?: never;
    }
);

export interface AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: AgentRequestMetadata;
  readonly attachments?: readonly AgentAttachment[];
  /** Host-only physical reply destination; never model-visible. */
  readonly replyTo?: AgentReplyTarget;
  /** Host-only continuation synthesis controls; never model-visible. */
  readonly continuation?: AgentContinuationTurn;
}

export interface AgentResponse {
  readonly text?: string;
  readonly metadata?: AgentResponseMetadata;
}

export type AgentStreamEvent =
  | {
      readonly type: "assistant_thought";
      readonly text: string;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_started";
      readonly id: string;
      readonly name: string;
      readonly arguments?: unknown;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_completed";
      readonly id: string;
      readonly name?: string;
      readonly arguments?: unknown;
      readonly content?: unknown;
      readonly isError?: boolean;
      /** Wall-clock tool execution time, when the runtime reported it. */
      readonly executionMs?: number;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_progress";
      readonly id: string;
      readonly name?: string;
      /** Partial tool output captured while the tool is still running. */
      readonly partialResult?: unknown;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "usage_update";
      readonly model?: string;
      /** Cumulative run cost in USD, when the runtime prices the model. */
      readonly cumulativeUsd?: number;
      readonly tokens?: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheCreation: number;
      };
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "provider_status";
      readonly kind:
        | "request_started"
        | "request_completed"
        | "failover_started"
        | "failover_completed";
      readonly model?: string;
      readonly from?: string;
      readonly to?: string;
      readonly attemptIndex?: number;
      readonly durationMs?: number;
      readonly cancelled?: boolean;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "memory_recalled";
      readonly source?: string;
      readonly bytes?: number;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      /**
       * Catch-all for low-frequency runtime telemetry (cache_hit/cache_miss,
       * capabilities_resolved, provider_bridge_latency, …) so new kinds ride
       * through without further union growth. Consumers render or ignore by
       * `kind`; `data` is the raw event payload minus its `type`.
       */
      readonly type: "runtime_telemetry";
      readonly kind: string;
      readonly data?: Record<string, unknown>;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "runtime_warning";
      readonly message: string;
      readonly warningKind?: string;
      readonly metadata?: AgentResponseMetadata;
    };

export interface AgentMessageStream {
  status?(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace?(text: string): Promise<void>;
  event?(event: AgentStreamEvent): Promise<void>;
  finish?(finalText?: string): Promise<void>;
}

/** Maximum characters accepted by the in-flight steering mailbox. */
export const AGENT_LIVE_INPUT_MAX_CHARACTERS = 8_000;

/** Maximum live messages retained by one active logical turn. */
export const AGENT_LIVE_INPUT_MAX_MESSAGES = 100;

/** One transport-neutral follow-up offered to the currently running turn. */
export interface AgentLiveInputRequest {
  readonly conversationId: string;
  /** Stable transport message id, used to make duplicate delivery idempotent. */
  readonly id: string;
  readonly text: string;
  /** ISO-8601 transport receipt time, preserved in canonical history. */
  readonly receivedAt: string;
}

export type AgentLiveInputUnavailableReason =
  | "inactive"
  | "unsupported"
  | "too_large"
  | "full"
  | "invalid";

export type AgentLiveInputSettlement =
  | { readonly status: "applied"; readonly runId: string }
  | { readonly status: "requeue"; readonly reason: "unsupported" | "closed" | "failed" }
  | { readonly status: "discarded"; readonly reason: "cancelled" };

/**
 * Immediate ownership result for a live follow-up. An accepted offer remains
 * represented by the caller's reserved normal-turn queue slot until `settled`
 * says whether that reservation should become a no-op or run normally.
 */
export type AgentLiveInputOffer =
  | { readonly status: "unavailable"; readonly reason: AgentLiveInputUnavailableReason }
  | { readonly status: "accepted"; readonly settled: Promise<AgentLiveInputSettlement> };

export interface AgentResponder<
  Request extends AgentRequestBase = AgentRequestBase,
  Stream extends AgentMessageStream = AgentMessageStream,
  Response extends AgentResponse = AgentResponse,
> {
  respond(request: Request, stream: Stream): Promise<Response>;
  /**
   * Optional: offer a text follow-up to the active turn without starting a
   * parallel response. Callers reserve their ordinary queue position first so
   * an unsupported or end-of-turn race can deterministically requeue it.
   */
  offerLiveInput?(request: AgentLiveInputRequest): AgentLiveInputOffer;
  /**
   * Optional: abort the in-flight turn for a conversation and clear any queued
   * follow-ups. Channels call this on an explicit user cancel (e.g. /cancel).
   */
  cancel?(conversationId: string, reason?: unknown): void;
  /**
   * Optional: record a message that a channel posted VERBATIM to `conversationId`
   * without running a turn (native cron/webhook notification delivery). The text
   * is appended to the conversation's durable history — and any warm provider
   * session for it is retired — so a later user reply resumes with the delivered
   * message in context. No model call happens here; the text was already posted.
   */
  deliverVerbatim?(
    conversationId: string,
    text: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
}

export interface AgentResponseCancelledErrorOptions {
  readonly reason?: unknown;
}

/**
 * Stable abort reason for an explicit channel-user cancellation such as
 * `/cancel`. Adapters use this to distinguish a command they already
 * acknowledged from provider, transport, or shutdown cancellation, whose
 * existing terminal delivery behavior must remain unchanged.
 */
export class ChannelUserCancelReason extends Error {
  readonly channel: string;
  /** Cross-package brand; survives duplicate package identities. */
  readonly channelUserCancel = true as const;

  constructor(channel: string) {
    const normalizedChannel = channel.trim();
    if (normalizedChannel.length === 0) {
      throw new TypeError("Channel user cancel reason requires a channel name.");
    }
    super(`Cancelled by ${normalizedChannel} user.`);
    this.name = "ChannelUserCancelReason";
    this.channel = normalizedChannel;
  }
}

/** Create the branded reason passed to responder and adapter abort controllers. */
export function createChannelUserCancelReason(channel: string): ChannelUserCancelReason {
  return new ChannelUserCancelReason(channel);
}

/** Recognize a channel-user cancellation across duplicate package identities. */
export function isChannelUserCancelReason(
  reason: unknown,
): reason is ChannelUserCancelReason {
  if (reason instanceof ChannelUserCancelReason) {
    return true;
  }
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { channelUserCancel?: unknown }).channelUserCancel === true
  );
}

export class AgentResponseCancelledError extends Error {
  readonly reason?: unknown;
  /**
   * Stable brand so the guard recognizes cancellation even across duplicate
   * class identities (e.g. two copies of this package in a dependency graph),
   * without string-matching subclass `name`s.
   */
  readonly agentResponseCancelled = true as const;

  constructor(
    message = "Agent response was cancelled.",
    options: AgentResponseCancelledErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentResponseCancelledError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export function isAgentResponseCancelledError(
  error: unknown,
): error is AgentResponseCancelledError {
  if (error instanceof AgentResponseCancelledError) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { agentResponseCancelled?: unknown }).agentResponseCancelled === true
  );
}

export { CodedError, isCodedError } from "./coded-error.js";
export {
  serializeAgentStreamFrame,
  parseAgentStreamFrame,
  frameFeedingMessageStream,
} from "./stream-wire.js";
export type { AgentStreamWireFrame } from "./stream-wire.js";
export {
  BufferedMessageStream,
} from "./buffered-message-stream.js";
export type {
  BufferedMessageStreamOptions,
} from "./buffered-message-stream.js";
export {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
} from "./stream-text.js";
export { formatLiveInputActivityLine, toolHintFor } from "./tool-hints.js";
export {
  ResilientMessageStream,
  ChannelDeliveryError,
} from "./resilient-message-stream.js";
export type {
  ChannelTransport,
  ChannelDeliveryDisposition,
  ChannelFailureCertainty,
  ChannelMessageContentKind,
  ChannelSendOutcome,
  MessageRef,
  ResilientMessageStreamOptions,
  ResilientMessageStreamLogger,
  ResilientAgentMessageStream,
} from "./resilient-message-stream.js";
export type {
  ChannelConfigInput,
  ChannelConfigViewField,
  ChannelConfigViewFieldSource,
  ChannelConfigViewSection,
  ChannelDriver,
  ChannelId,
  ChannelAskAnswer,
  ChannelAskOption,
  ChannelAskQuestion,
  ChannelAskSnapshot,
  ChannelAskStatus,
  ChannelAskSubmission,
  ChannelAskSubmissionResult,
  ChannelInteractionHub,
  ChannelInteractionSink,
  ChannelLogger,
  ChannelStartInput,
  ChannelStatus,
  NotifyDeliveryResult,
  NotifyDestination,
  RunningChannel,
} from "./channel.js";
export { isDeliverableConversation } from "./channel.js";
export {
  encodeJsonEnvValue,
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
  readRequired,
  readString,
  redactedSecret,
} from "./config-loader.js";
export type {
  ConfigErrorFactory,
  EnvEncodeKind,
  JsonEnvFieldSpec,
  JsonEnvMapping,
  RedactedSecretValue,
} from "./config-loader.js";
export {
  assertSafeBind,
  BoundedHttpResponseWriter,
  close,
  closeServerBounded,
  hostForUrl,
  isLoopbackHost,
  isWildcardHost,
  listen,
  normalizeHostForBind,
} from "./host-safety.js";
export type { BoundedHttpResponseWriterOptions, ListenErrorFactories } from "./host-safety.js";
export {
  bearerTokensEqual,
  generateBearerToken,
  readAuthorizationBearer,
} from "./bearer.js";
export { sanitizeInboundHttpHeaders } from "./http-headers.js";
export type { InboundHttpHeaders } from "./http-headers.js";
export {
  SettingsJsonError,
  readSettingsJson,
  writeSettingsJson,
} from "./json-source.js";
export type {
  ReadSettingsJsonResult,
  SettingsJsonErrorCode,
  SettingsJsonErrorDetails,
} from "./json-source.js";
export type {
  SettingsJson,
  SettingsJsonValue,
  SettingsPrimitive,
} from "./types.js";

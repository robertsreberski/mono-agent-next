import type { AgentHarness, AgentHarnessFailure, AgentHarnessSessionBoundary } from "./types.js";
import type {
  AgentLiveInputRequest,
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
  AgentStreamEvent,
} from "@mono-agent/agent-contracts";
import {
  AgentResponseCancelledError,
  formatLiveInputActivityLine,
} from "@mono-agent/agent-contracts";

interface PendingLiveInputActivity {
  readonly text: string;
  readonly receivedAt: string;
}

export class AgentHarnessFailureError extends Error {
  readonly failure: AgentHarnessFailure;

  constructor(failure: AgentHarnessFailure) {
    super(failure.message);
    this.name = "AgentHarnessFailureError";
    this.failure = failure;
  }
}

export type SessionRollover = "none" | "daily";

export function createAgentResponder(options: {
  readonly harness: AgentHarness;
  /**
   * Session rollover policy applied centrally to EVERY channel (cron, telegram,
   * slack, whatsapp, …) that routes through this responder. "daily" appends a
   * local-date bucket to the conversationId so a new calendar day starts a fresh
   * session (queue/warm-session/durable transcript/history all key off
   * conversationId), bounding unbounded growth. Default "none" = unchanged.
   */
  readonly rollover?: SessionRollover;
  readonly rolloverTimezone?: string;
  readonly rolloverNotice?: boolean;
  /** Injectable clock for the rollover date; defaults to the system clock. */
  readonly now?: () => Date;
}): AgentResponder & {
  dispose(): Promise<void>;
  cancel(conversationId: string, reason?: unknown): void;
  startNewSession(conversationId: string): Promise<void>;
} {
  if (typeof options.harness?.run !== "function") {
    throw new TypeError("createAgentResponder requires a harness with run().");
  }

  // Prefer submit() (queue-after-turn: a mid-run follow-up is answered on the
  // warm session after the current turn) and fall back to run() for harnesses
  // that do not implement it.
  const invoke = typeof options.harness.submit === "function"
    ? options.harness.submit.bind(options.harness)
    : options.harness.run.bind(options.harness);

  const now = options.now ?? ((): Date => new Date());
  const bucket = (conversationId: string): string =>
    bucketConversationId(conversationId, options.rollover, options.rolloverTimezone, now);
  const lastBucketByBaseConversation = new Map<string, string>();
  const responseTailsByBaseConversation = new Map<string, Promise<void>>();
  const cancellationGenerationByBaseConversation = new Map<string, number>();
  const cancellationReasonByBaseConversation = new Map<string, { generation: number; reason?: unknown }>();
  const activeBucketByBaseConversation = new Map<string, string>();
  const pendingLiveInputByBaseConversation = new Map<string, Map<string, PendingLiveInputActivity>>();

  return {
    async dispose(): Promise<void> {
      pendingLiveInputByBaseConversation.clear();
      await options.harness.dispose?.();
    },
    ...(options.harness.offerLiveInput === undefined
      ? {}
      : {
        offerLiveInput(request: AgentLiveInputRequest) {
          const serializationKey = responseSerializationKey(request.conversationId, options.rollover);
          const activeBucket = activeBucketByBaseConversation.get(serializationKey);
          if (activeBucket === undefined) {
            return { status: "unavailable" as const, reason: "inactive" as const };
          }
          const offer = options.harness.offerLiveInput?.({ ...request, conversationId: activeBucket })
            ?? { status: "unavailable" as const, reason: "unsupported" as const };
          if (offer.status === "accepted") {
            let pending = pendingLiveInputByBaseConversation.get(serializationKey);
            if (pending === undefined) {
              pending = new Map();
              pendingLiveInputByBaseConversation.set(serializationKey, pending);
            }
            const activity = pending.get(request.id) ?? {
              text: request.text,
              receivedAt: request.receivedAt,
            };
            pending.set(request.id, activity);
            const remove = (): void => {
              const current = pendingLiveInputByBaseConversation.get(serializationKey);
              if (current?.get(request.id) !== activity) return;
              current.delete(request.id);
              if (current.size === 0) pendingLiveInputByBaseConversation.delete(serializationKey);
            };
            void offer.settled.then((settlement) => {
              // An applied settlement and the runtime acknowledgement event
              // describe the same provider boundary. Keep the preview until
              // that event is correlated; all non-applied outcomes can be
              // discarded immediately.
              if (settlement.status !== "applied") remove();
            }, remove);
          }
          return offer;
        },
      }),
    cancel(conversationId: string, reason?: unknown): void {
      const serializationKey = responseSerializationKey(conversationId, options.rollover);
      // Prefer the bucket captured when the active turn started. Recomputing a
      // daily bucket after midnight would otherwise leave yesterday's run alive.
      options.harness.cancel?.(
        activeBucketByBaseConversation.get(serializationKey) ?? bucket(conversationId),
        reason,
      );
      if (responseTailsByBaseConversation.has(serializationKey)) {
        const generation = (cancellationGenerationByBaseConversation.get(serializationKey) ?? 0) + 1;
        cancellationGenerationByBaseConversation.set(serializationKey, generation);
        cancellationReasonByBaseConversation.set(serializationKey, { generation, reason });
      }
    },
    async startNewSession(conversationId: string): Promise<void> {
      const serializationKey = responseSerializationKey(conversationId, options.rollover);
      const reason = new Error("Conversation session reset requested by the user.");
      options.harness.cancel?.(
        activeBucketByBaseConversation.get(serializationKey) ?? bucket(conversationId),
        reason,
      );
      if (responseTailsByBaseConversation.has(serializationKey)) {
        const generation = (cancellationGenerationByBaseConversation.get(serializationKey) ?? 0) + 1;
        cancellationGenerationByBaseConversation.set(serializationKey, generation);
        cancellationReasonByBaseConversation.set(serializationKey, { generation, reason });
      }
      await serializeByKey(responseTailsByBaseConversation, serializationKey, async () => {
        if (options.harness.resetConversation === undefined) {
          throw new Error("The configured agent harness does not support conversation reset.");
        }
        await options.harness.resetConversation(bucket(conversationId));
      });
      if (!responseTailsByBaseConversation.has(serializationKey)) {
        cancellationGenerationByBaseConversation.delete(serializationKey);
        cancellationReasonByBaseConversation.delete(serializationKey);
      }
    },
    async deliverVerbatim(
      conversationId: string,
      text: string,
      deliveryOptions?: { readonly idempotencyKey?: string },
    ): Promise<void> {
      const serializationKey = responseSerializationKey(conversationId, options.rollover);
      await serializeByKey(responseTailsByBaseConversation, serializationKey, async () => {
        // Bucket identically to respond() so the verbatim post lands under the same
        // history/session key a later reply on this conversation will resume.
        await options.harness.appendVerbatimTurn?.(bucket(conversationId), text, deliveryOptions);
      });
    },
    async respond(request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> {
      const serializationKey = responseSerializationKey(request.conversationId, options.rollover);
      const admittedGeneration = cancellationGenerationByBaseConversation.get(serializationKey) ?? 0;
      try {
        return await serializeByKey(
          responseTailsByBaseConversation,
          serializationKey,
          async () => {
            const currentGeneration = cancellationGenerationByBaseConversation.get(serializationKey) ?? 0;
            if (currentGeneration !== admittedGeneration) {
              const cancellation = cancellationReasonByBaseConversation.get(serializationKey);
              throw new AgentResponseCancelledError("Cancelled while queued before the harness.", {
                ...(cancellation?.generation === currentGeneration && cancellation.reason !== undefined
                  ? { reason: cancellation.reason }
                  : {}),
              });
            }
            // A continuation carries an immutable origin history identity. If
            // that identity already has an explicit daily bucket, preserve it
            // even when synthesis runs on a later calendar day.
            const activeBucket = request.continuation !== undefined && hasDailyBucket(request.conversationId)
              ? request.conversationId
              : bucket(request.conversationId);
            activeBucketByBaseConversation.set(serializationKey, activeBucket);
            try {
              return await respondOnce(request, stream, activeBucket, serializationKey);
            } finally {
              if (activeBucketByBaseConversation.get(serializationKey) === activeBucket) {
                activeBucketByBaseConversation.delete(serializationKey);
              }
              pendingLiveInputByBaseConversation.delete(serializationKey);
            }
          },
        );
      } finally {
        if (!responseTailsByBaseConversation.has(serializationKey)) {
          cancellationGenerationByBaseConversation.delete(serializationKey);
          cancellationReasonByBaseConversation.delete(serializationKey);
        }
      }
    },
  };

  async function respondOnce(
    request: AgentRequestBase,
    stream: AgentMessageStream,
    bucketed: string,
    serializationKey: string,
  ): Promise<AgentResponse> {
    const runtimeEventStream = createRuntimeEventStream(stream);
    const boundary = request.continuation === undefined ? rolloverBoundaryForRequest({
      conversationId: request.conversationId,
      bucketedConversationId: bucketed,
      rollover: options.rollover,
      lastBucketByBaseConversation,
      now,
    }) : undefined;
    const notice = boundary !== undefined && options.rolloverNotice === true
      ? `${sessionRolloverNotice(boundary)}\n\n`
      : undefined;
    if (notice !== undefined) {
      runtimeEventStream.enqueueText(notice);
    }
    // Per-turn scratch: tool_timing arrives strictly before its tool_result and
    // is folded into that tool_call_completed rather than emitted on its own.
    const eventContext: StreamEventContext = { toolTimings: new Map() };
    const emittedLiveInputIds = new Set<string>();
    const response = await invoke({
      conversationId: bucketed,
      userMessage: request.text,
      abortSignal: request.abortSignal,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      ...(request.continuation === undefined ? {} : { continuation: request.continuation }),
      ...(boundary === undefined ? {} : { sessionBoundary: boundary }),
      onEvent: (event) => {
        const liveInputEvents = liveInputActivityFromRuntimeEvent(
          event,
          pendingLiveInputByBaseConversation.get(serializationKey),
          emittedLiveInputIds,
        );
        if (liveInputEvents !== undefined) {
          for (const streamEvent of liveInputEvents) {
            runtimeEventStream.enqueueEvent(streamEvent);
          }
          return;
        }
        const streamEvent = streamEventFromRuntimeEvent(event, eventContext);
        if (streamEvent !== undefined) {
          runtimeEventStream.enqueueEvent(streamEvent);
        }
        const delta = assistantTextFromRuntimeEvent(event);
        if (delta.length > 0) {
          runtimeEventStream.enqueueText(delta);
        }
        // Commentary-phase narration appears in neither thinking nor the
        // answer; surface it transiently on the ephemeral status line.
        const commentary = commentaryTextFromRuntimeEvent(event);
        if (commentary.length > 0) {
          runtimeEventStream.enqueueStatus(commentary);
        }
      },
    });
    await runtimeEventStream.flush();

    if (response.failure !== undefined) {
      throw new AgentHarnessFailureError(response.failure);
    }

    return {
      ...(response.text === undefined ? {} : { text: notice === undefined ? response.text : `${notice}${response.text}` }),
      metadata: { ...response.metadata },
    };
  }
}

function liveInputActivityFromRuntimeEvent(
  event: unknown,
  pending: ReadonlyMap<string, PendingLiveInputActivity> | undefined,
  emittedInputIds: Set<string>,
): readonly [
  Extract<AgentStreamEvent, { type: "tool_call_started" }>,
  Extract<AgentStreamEvent, { type: "tool_call_completed" }>,
] | undefined {
  if (!isRecord(event) || event.type !== "live_input_applied") return undefined;
  const inputId = stringField(event, "inputId");
  if (inputId === undefined || emittedInputIds.has(inputId)) return undefined;
  emittedInputIds.add(inputId);

  const activity = pending?.get(inputId);
  const receivedAt = stringField(event, "receivedAt") ?? activity?.receivedAt;
  const name = formatLiveInputActivityLine(activity?.text ?? "");
  const id = `live-input:${inputId}`;
  const metadata = {
    liveInput: true,
    synthetic: true,
    inputId,
    ...(receivedAt === undefined ? {} : { receivedAt }),
  };
  return [
    { type: "tool_call_started", id, name, metadata },
    {
      type: "tool_call_completed",
      id,
      name,
      content: "Applied to current run",
      metadata,
    },
  ];
}

export function assistantTextFromRuntimeEvent(event: unknown): string {
  if (!isRecord(event) || event.type !== "assistant") {
    return "";
  }
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  let text = "";
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && stringField(block, "phase") !== "commentary" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

async function serializeByKey<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  tails.set(key, next);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (tails.get(key) === next) {
      tails.delete(key);
    }
  }
}

/**
 * Per-turn state threaded through the mapper. `toolTimings` collects
 * tool_timing events (tool_use_id → execution_ms) so the duration can be
 * stamped onto the matching tool_call_completed instead of surfacing as a
 * separate event; entries are consumed on use.
 */
export interface StreamEventContext {
  readonly toolTimings?: Map<string, number>;
}

/**
 * Raw runtime event kinds that ride through as the generic runtime_telemetry
 * variant. Deliberately an allowlist, not a catch-all: other unmapped runtime
 * events (bridge-specific `system`/`result` payloads, …) stay off the channel
 * stream as before.
 */
const RUNTIME_TELEMETRY_KINDS = new Set([
  "cache_hit",
  "cache_miss",
  "capabilities_resolved",
  "context_compaction",
  "context_usage",
  "provider_bridge_latency",
  "run_config",
  "session_boundary",
]);

export function streamEventFromRuntimeEvent(
  event: unknown,
  context?: StreamEventContext,
): AgentStreamEvent | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  if (event.type === "runtime_warning") {
    const message = stringField(event, "message");
    if (message === undefined) {
      return undefined;
    }
    const warningKind = stringField(event, "warning_kind");
    return {
      type: "runtime_warning",
      message,
      ...(warningKind === undefined ? {} : { warningKind }),
    };
  }
  if (event.type === "tool_update") {
    const id = stringField(event, "tool_use_id");
    if (id === undefined) {
      return undefined;
    }
    const name = stringField(event, "name");
    return {
      type: "tool_call_progress",
      id,
      ...(name === undefined ? {} : { name }),
      ...(hasOwn(event, "partial_result") ? { partialResult: event.partial_result } : {}),
    };
  }
  if (event.type === "tool_timing") {
    const id = stringField(event, "tool_use_id");
    if (id !== undefined && typeof event.execution_ms === "number") {
      context?.toolTimings?.set(id, event.execution_ms);
    }
    return undefined;
  }
  if (event.type === "cost_accumulated") {
    const model = stringField(event, "model");
    const tokens = isRecord(event.tokens)
      ? {
          input: numberOrZero(event.tokens.input),
          output: numberOrZero(event.tokens.output),
          cacheRead: numberOrZero(event.tokens.cacheReadTokens),
          cacheCreation: numberOrZero(event.tokens.cacheCreationTokens),
        }
      : undefined;
    return {
      type: "usage_update",
      ...(model === undefined ? {} : { model }),
      ...(typeof event.cumulativeUsd === "number" ? { cumulativeUsd: event.cumulativeUsd } : {}),
      ...(tokens === undefined ? {} : { tokens }),
    };
  }
  if (
    event.type === "provider_request_started" ||
    event.type === "provider_request_completed" ||
    event.type === "provider_failover_started" ||
    event.type === "provider_failover_completed"
  ) {
    const kind = event.type.replace("provider_", "") as
      | "request_started"
      | "request_completed"
      | "failover_started"
      | "failover_completed";
    const model = stringField(event, "model");
    const from = stringField(event, "from");
    const to = stringField(event, "to");
    return {
      type: "provider_status",
      kind,
      ...(model === undefined ? {} : { model }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(typeof event.attemptIndex === "number" ? { attemptIndex: event.attemptIndex } : {}),
      ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
      ...(typeof event.cancelled === "boolean" ? { cancelled: event.cancelled } : {}),
    };
  }
  if (event.type === "memory_recalled") {
    const source = stringField(event, "source");
    return {
      type: "memory_recalled",
      ...(source === undefined ? {} : { source }),
      ...(typeof event.bytes === "number" ? { bytes: event.bytes } : {}),
    };
  }
  if (typeof event.type === "string" && RUNTIME_TELEMETRY_KINDS.has(event.type)) {
    const { type, ...data } = event;
    return { type: "runtime_telemetry", kind: type, data };
  }
  if (event.type !== "assistant" && event.type !== "user") {
    return undefined;
  }
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (event.type === "assistant") {
      const thought = thoughtTextFromBlock(block);
      if (thought !== undefined) {
        return { type: "assistant_thought", text: thought };
      }
      if (block.type === "tool_use") {
        const id = stringField(block, "id");
        const name = stringField(block, "name");
        if (id !== undefined && name !== undefined) {
          return {
            type: "tool_call_started",
            id,
            name,
            ...(hasOwn(block, "input") ? { arguments: block.input } : {}),
          };
        }
      }
    }
    if (event.type === "user" && block.type === "tool_result") {
      const id = stringField(block, "tool_use_id") ?? stringField(block, "tool_call_id");
      if (id !== undefined) {
        const executionMs = context?.toolTimings?.get(id);
        if (executionMs !== undefined) {
          context?.toolTimings?.delete(id);
        }
        return {
          type: "tool_call_completed",
          id,
          ...(hasOwn(block, "content") ? { content: block.content } : {}),
          ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
          ...(executionMs === undefined ? {} : { executionMs }),
        };
      }
    }
  }
  return undefined;
}

function createRuntimeEventStream(stream: AgentMessageStream): {
  enqueueText(delta: string): void;
  enqueueEvent(event: AgentStreamEvent): void;
  enqueueStatus(text: string): void;
  flush(): Promise<void>;
} {
  // A serialized promise chain preserves the order of text deltas and events
  // while letting the runtime's onEvent stay synchronous. Each delta is appended
  // immediately (no microtask batching) so SSE consumers like Open WebUI receive
  // tokens as they are produced rather than in coalesced bursts; the SSE adapter
  // itself disables Nagle so each chunk leaves the socket promptly.
  let chain = Promise.resolve();
  let firstError: unknown;
  function enqueue(operation: () => Promise<void>): void {
    chain = chain
      .then(async () => {
        if (firstError !== undefined) {
          return;
        }
        await operation();
      })
      .catch((error: unknown) => {
        if (firstError === undefined) {
          firstError = error;
        }
      });
  }
  return {
    enqueueText(delta: string): void {
      if (delta.length === 0) {
        return;
      }
      enqueue(async () => {
        await stream.append(delta);
      });
    },
    enqueueEvent(event: AgentStreamEvent): void {
      enqueue(async () => {
        if (typeof stream.event === "function") {
          await stream.event(event);
          return;
        }
        if (event.type === "assistant_thought" && typeof stream.status === "function") {
          await stream.status(event.text);
        }
      });
    },
    enqueueStatus(text: string): void {
      if (typeof stream.status !== "function") {
        return;
      }
      enqueue(async () => {
        await stream.status?.(text);
      });
    },
    async flush(): Promise<void> {
      await chain;
      if (firstError !== undefined) {
        throw firstError;
      }
    },
  };
}

/**
 * Only genuine `thinking`-typed blocks are model reasoning. A `text` block
 * tagged `phase:"commentary"` (tool-preamble narration like "inspecting glob
 * results") is deliberately NOT a thought — it goes to the ephemeral status
 * line instead (see {@link commentaryTextFromRuntimeEvent}) so the thinking
 * cell (and its chars/duration stats) reflects pure reasoning. This also
 * matches replay, where classifyAssistantContent counts only thinking-typed
 * blocks as the thinking category.
 */
function thoughtTextFromBlock(block: Record<string, unknown>): string | undefined {
  if (block.type === "thinking") {
    return stringField(block, "text") ?? stringField(block, "thinking") ?? stringField(block, "content");
  }
  return undefined;
}

/**
 * Commentary-phase text out of an assistant runtime event: tool-preamble
 * narration that belongs in neither the thinking stream nor the answer text
 * ({@link assistantTextFromRuntimeEvent} already excludes it there). Routed
 * to the stream's ephemeral `status` callback so the operator still sees the
 * progress transiently.
 */
export function commentaryTextFromRuntimeEvent(event: unknown): string {
  if (!isRecord(event) || event.type !== "assistant") {
    return "";
  }
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  let text = "";
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && stringField(block, "phase") === "commentary" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Append a local-date bucket (`#YYYY-MM-DD`) to a conversationId under the
 * "daily" rollover policy. Idempotent — re-bucketing within the same day is a
 * no-op — and a passthrough when rollover is off. Exported for unit testing.
 */
export function bucketConversationId(
  conversationId: string,
  rollover: SessionRollover | undefined,
  timezone: string | undefined,
  now: () => Date,
): string {
  if (rollover !== "daily") {
    return conversationId;
  }
  const baseConversationId = stripDailyBucket(conversationId);
  const suffix = `#${formatRolloverDay(now(), timezone)}`;
  return baseConversationId.endsWith(suffix) ? baseConversationId : `${baseConversationId}${suffix}`;
}

const DAILY_BUCKET_SUFFIX_RE = /#\d{4}-\d{2}-\d{2}$/u;

function stripDailyBucket(conversationId: string): string {
  return conversationId.replace(DAILY_BUCKET_SUFFIX_RE, "");
}

function hasDailyBucket(conversationId: string): boolean {
  return DAILY_BUCKET_SUFFIX_RE.test(conversationId);
}

function responseSerializationKey(conversationId: string, rollover: SessionRollover | undefined): string {
  return rollover === "daily" ? stripDailyBucket(conversationId) : conversationId;
}

function rolloverBoundaryForRequest(input: {
  readonly conversationId: string;
  readonly bucketedConversationId: string;
  readonly rollover: SessionRollover | undefined;
  readonly lastBucketByBaseConversation: Map<string, string>;
  readonly now: () => Date;
}): AgentHarnessSessionBoundary | undefined {
  if (input.rollover !== "daily") {
    return undefined;
  }
  const baseConversationId = stripDailyBucket(input.conversationId);
  const previousConversationId = input.lastBucketByBaseConversation.get(baseConversationId);
  input.lastBucketByBaseConversation.set(baseConversationId, input.bucketedConversationId);
  if (previousConversationId === undefined || previousConversationId === input.bucketedConversationId) {
    return undefined;
  }
  return {
    type: "session_boundary",
    kind: "rollover",
    conversationId: input.bucketedConversationId,
    baseConversationId,
    previousConversationId,
    timestamp: input.now().toISOString(),
  };
}

function sessionRolloverNotice(boundary: AgentHarnessSessionBoundary): string {
  return `New session bucket started: ${boundary.conversationId}.`;
}

function formatRolloverDay(date: Date, timezone: string | undefined): string {
  // en-CA renders as YYYY-MM-DD. Fall back to the system-local date when the
  // configured timezone is invalid rather than throwing on a hot path.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

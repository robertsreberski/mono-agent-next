import {
  buildEventSpans,
  buildRootSpanAttributes,
  composeFailureDetail,
  countRuntimeWarnings,
  spanKindHint,
  spanStatusFor,
} from "../run-export-mapping.js";
import type { SpanAttributes } from "../run-export-mapping.js";
import { DEFAULT_MAX_STRING_BYTES } from "../guards.js";
import { redactJsonValue, truncateString } from "../redaction.js";
import type {
  RecordedRunEventCategory,
  RunExportContext,
  RunSummary,
  RuntimeEventLike,
} from "../types.js";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { idToHex } from "./ids.js";
import type { DeterministicIdFactory } from "./ids.js";

// Keep the original instrumentation scope stable for existing Phoenix dashboards.
const SCOPE_NAME = "@mono-agent/observability-otel";

// JS SDK SpanKind values (NOT proto values): INTERNAL=0, CLIENT=2. The protobuf
// serializer emits `kind + 1`, mapping these to proto INTERNAL(1)/CLIENT(3).
const SPAN_KIND_INTERNAL = 0;
const SPAN_KIND_CLIENT = 2;

// OTel StatusCode: 0=UNSET, 2=ERROR.
const STATUS_CODE_UNSET = 0;
const STATUS_CODE_ERROR = 2;

const MIME_TEXT = "text/plain";
const SYSTEM_PROMPT_MAX_BYTES = 32_000;

function scanRetainedContent(value: string, context: RunExportContext, maxStringBytes: number): string {
  if (context.contentPatternRedaction !== true) {
    return value;
  }
  return redactJsonValue(value, maxStringBytes, { contentPatternRedaction: true }) as string;
}

export interface BuildRunReadableSpansInput {
  readonly summary: RunSummary;
  readonly events: readonly RuntimeEventLike[];
  readonly context: RunExportContext;
  /** Phoenix project name (resource attr `openinference.project.name`). */
  readonly projectName: string;
  /** Run start time in nanoseconds since the Unix epoch. */
  readonly startTimeUnixNanos: bigint;
  /** Run end time in nanoseconds since the Unix epoch. */
  readonly endTimeUnixNanos: bigint;
  readonly idFactory: DeterministicIdFactory;
}

type HrTime = [number, number];

function nanosToHrTime(nanos: bigint): HrTime {
  return [Number(nanos / 1_000_000_000n), Number(nanos % 1_000_000_000n)];
}

function hrDuration(start: HrTime, end: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [seconds < 0 ? 0 : seconds, nanos < 0 ? 0 : nanos];
}

/** OTel transport SpanKind for a category: external calls -> CLIENT, else INTERNAL. */
function otelKind(category: RecordedRunEventCategory): number {
  return spanKindHint(category) === "INTERNAL" ? SPAN_KIND_INTERNAL : SPAN_KIND_CLIENT;
}

interface SpanInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTime: HrTime;
  readonly endTime: HrTime;
  readonly attributes: SpanAttributes;
  readonly statusError: boolean;
  readonly statusMessage?: string;
  readonly resource: { readonly attributes: SpanAttributes; readonly schemaUrl: undefined };
  readonly scope: { readonly name: string; readonly version: undefined };
}

/**
 * Build a minimal plain object that satisfies the fields the OTLP protobuf
 * serializer reads from a `ReadableSpan` (spanContext()/parentSpanContext, name,
 * kind, times, status, attributes, resource, instrumentationScope, the dropped
 * counters). Cast to `ReadableSpan`; we deliberately do NOT construct the SDK
 * Span/Resource classes.
 */
function makeSpan(input: SpanInput): ReadableSpan {
  const span = {
    name: input.name,
    kind: input.kind,
    spanContext: () => ({ traceId: input.traceId, spanId: input.spanId, traceFlags: 1 }),
    parentSpanContext:
      input.parentSpanId === undefined
        ? undefined
        : { traceId: input.traceId, spanId: input.parentSpanId, traceFlags: 1 },
    startTime: input.startTime,
    endTime: input.endTime,
    status: {
      code: input.statusError ? STATUS_CODE_ERROR : STATUS_CODE_UNSET,
      ...(input.statusError && input.statusMessage !== undefined
        ? { message: input.statusMessage }
        : {}),
    },
    attributes: input.attributes,
    links: [],
    events: [],
    duration: hrDuration(input.startTime, input.endTime),
    ended: true,
    resource: input.resource,
    instrumentationScope: input.scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  return span as unknown as ReadableSpan;
}

/**
 * Map one run (root span) plus its buffered events (child spans) into OTLP
 * `ReadableSpan[]`, enriched with OpenInference semantics (`openinference.span.kind`,
 * `input.value`/`output.value`) so Phoenix renders LLM/Tool/Chain/Agent spans
 * rather than bare INTERNAL spans, and routed to a named project via the
 * resource attribute `openinference.project.name`. Live export threads the
 * request prompt through `context.userInput`; backfill forwards persisted
 * `summary.userInput` when present. The shared mapper bounds either source at
 * this UTF-8-aware export boundary without mutating the recorder summary or
 * rewriting a canonical recorder truncation marker. Free text is not
 * content-scanned by default; `contentPatternRedaction` enables the closed
 * high-confidence scan over retained outbound values.
 */
export function buildRunReadableSpans(input: BuildRunReadableSpansInput): ReadableSpan[] {
  const { summary, events, context, projectName, startTimeUnixNanos, endTimeUnixNanos, idFactory } =
    input;

  const traceId = idToHex(idFactory.traceId());
  const rootSpanId = idToHex(idFactory.spanId(0));
  const start = nanosToHrTime(startTimeUnixNanos);
  const end = nanosToHrTime(endTimeUnixNanos);

  // Shared resource/scope objects reused across every span: the serializer keys
  // resources and scopes by object identity, so one trace must reuse the refs.
  const resource = {
    attributes: {
      "service.name": "mono-agent",
      "openinference.project.name": projectName,
    } as SpanAttributes,
    schemaUrl: undefined,
  };
  const scope = { name: SCOPE_NAME, version: undefined };

  // buildEventSpans returns a semantic timeline (coalesced assistant turns, tool
  // lifecycles merged into one TOOL span) with OpenInference attributes already set.
  const eventSpans = buildEventSpans(events, context);

  // Root span input/output = the actual conversation: the user's prompt and the
  // final assistant reply (the last coalesced message span), so the trace shows
  // "what was asked" and "what was answered". Both are conversation content, so
  // they fall back to ids/status when sensitive export is off. Live export
  // threads the request through context.userInput; backfill forwards persisted
  // summary.userInput when the artifact carries it. Bound either source here so
  // callers cannot place an unbounded free-text attribute on the outbound span;
  // the truncator idempotently preserves an existing canonical recorder marker.
  // Failure detail = the collapsed failure kind PLUS the per-attempt failover
  // summary (which models were tried, how each failed) and the capped underlying
  // provider message — so a failed trace reads "failed (provider_unavailable_exhausted:
  // gpt-5.5 → timeout, kimi-k2.6 → server_error; last error: 503 …)" instead of a
  // bare kind. Undefined for a clean run.
  const failureDetailRaw = composeFailureDetail(summary, { maxErrorChars: 300 });
  const failureDetail = failureDetailRaw === undefined
    ? undefined
    : scanRetainedContent(failureDetailRaw, context, DEFAULT_MAX_STRING_BYTES);
  const statusText =
    failureDetail === undefined ? summary.status : `${summary.status} (${failureDetail})`;
  const lastMessage = [...eventSpans].reverse().find((mapping) => mapping.category === "message");
  const finalReply = lastMessage === undefined ? "" : String(lastMessage.attributes["output.value"] ?? "");
  const rootInput =
    context.includeSensitiveData && context.userInput !== undefined && context.userInput.length > 0
      ? scanRetainedContent(
          truncateString(context.userInput, DEFAULT_MAX_STRING_BYTES),
          context,
          DEFAULT_MAX_STRING_BYTES,
        )
      : `run ${summary.runId} · ${summary.conversationId}`;
  const rootOutput = scanRetainedContent(
    context.includeSensitiveData && finalReply.length > 0 ? finalReply : statusText,
    context,
    DEFAULT_MAX_STRING_BYTES,
  );

  // System instructions are run content, so they ride the same sensitive gate as
  // the conversation input/output. The retained free-text string is already
  // capped at persist time (the recorder's dedicated system-prompt cap). It is
  // not content-scanned by default; the exporter opt-in applies here.
  const systemPrompt =
    context.includeSensitiveData && typeof summary.systemPrompt === "string" && summary.systemPrompt.length > 0
      ? scanRetainedContent(summary.systemPrompt, context, SYSTEM_PROMPT_MAX_BYTES)
      : undefined;

  const warningsCount = countRuntimeWarnings(events);
  const rootAttributes: SpanAttributes = {
    ...buildRootSpanAttributes(summary, context, warningsCount),
    // Memory runs render with a dedicated "memory" kind so Phoenix's Kind column
    // distinguishes them; channel runs keep the standard OpenInference "AGENT".
    "openinference.span.kind": context.runKind === "memory" ? "memory" : "AGENT",
    "input.value": rootInput,
    "input.mime_type": MIME_TEXT,
    "output.value": rootOutput,
    "output.mime_type": MIME_TEXT,
    ...(systemPrompt === undefined
      ? {}
      : {
          // OpenInference models the system instruction as the first input message
          // (Phoenix renders it in the LLM messages panel); the flat mirrors stay
          // queryable in our namespace.
          "llm.input_messages.0.message.role": "system",
          "llm.input_messages.0.message.content": systemPrompt,
          "llm.system": systemPrompt,
          "mono.agent.system_prompt": systemPrompt,
        }),
  };
  const rootError = spanStatusFor(summary.status, "runtime") === "ERROR";

  const spans: ReadableSpan[] = [
    makeSpan({
      traceId,
      spanId: rootSpanId,
      name: `mono-agent run ${summary.runId}`,
      kind: SPAN_KIND_INTERNAL,
      startTime: start,
      endTime: end,
      attributes: rootAttributes,
      statusError: rootError,
      ...(rootError && failureDetail !== undefined ? { statusMessage: failureDetail } : {}),
      resource,
      scope,
    }),
  ];

  // The child loop just shapes each mapping into an OTLP span.
  eventSpans.forEach((mapping, ordinal) => {
    const attributes: SpanAttributes = { ...mapping.attributes };
    if (mapping.payload !== undefined) {
      attributes["mono.agent.event.payload"] = JSON.stringify(mapping.payload);
    }
    spans.push(
      makeSpan({
        traceId,
        spanId: idToHex(idFactory.spanId(ordinal + 1)),
        parentSpanId: rootSpanId,
        name: mapping.name,
        kind: otelKind(mapping.category),
        startTime: start,
        endTime: end,
        attributes,
        statusError: spanStatusFor(summary.status, mapping.category) === "ERROR",
        resource,
        scope,
      }),
    );
  });

  return spans;
}

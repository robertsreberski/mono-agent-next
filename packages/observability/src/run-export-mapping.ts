import { compactString } from "./content.js";
import { buildEventDescriptors } from "./event-classify.js";
import { DEFAULT_MAX_STRING_BYTES, isRecord, stringField } from "./guards.js";
import { redactJsonValue } from "./redaction.js";
import type {
  FailoverAttempt,
  RecordedRunEventCategory,
  RunExportContext,
  RunSummary,
  RunSummaryStatus,
  RuntimeEventLike,
} from "./types.js";

/**
 * Pure, node-free event -> span attribute mapping for the Phoenix/OTLP export
 * surface. Imports ONLY node-free modules (event-classify/guards/redaction/
 * types) so the built `dist/run-export-mapping.js` stays browser-safe and can be
 * imported through the './run-export' subpath without dragging node:fs/node:path
 * into a browser graph. The concrete network transport lives behind the
 * './otel' subpath; this module only shapes attribute bags.
 */

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export type SpanKindHint = "TOOL" | "LLM" | "INTERNAL";
export type SpanStatusHint = "ERROR" | "UNSET";

export interface EventSpanMapping {
  readonly name: string;
  readonly category: RecordedRunEventCategory;
  readonly attributes: SpanAttributes;
  /**
   * Only set when sensitive export is opt-in (includeSensitiveData=true). The
   * payload is still passed through `redactJsonValue` before it is attached:
   * non-numeric values under sensitive-looking object keys are redacted;
   * numeric values under matched keys are retained; free text is not
   * content-scanned by default; `RunExportContext.contentPatternRedaction`
   * enables the closed high-confidence scan. Payload strings are byte-bounded
   * by the export limit.
   */
  readonly payload?: unknown;
}

function redactExportString(
  value: string,
  ctx: RunExportContext,
  maxStringBytes: number = DEFAULT_MAX_STRING_BYTES,
): string {
  if (ctx.contentPatternRedaction !== true) {
    return value;
  }
  return redactJsonValue(value, maxStringBytes, { contentPatternRedaction: true }) as string;
}

// Concise cap for the underlying error message woven into a failure status line.
const DEFAULT_FAILURE_ERROR_CHARS = 300;
// Wider cap for the standalone `mono.agent.error.message` attribute (its own field,
// not a status line, so it can hold a bit more before truncation).
const ERROR_ATTRIBUTE_CHARS = 500;

function failoverModel(model: unknown): string | undefined {
  if (typeof model === "string" && model.trim().length > 0) return model.trim();
  if (isRecord(model)) return stringField(model, "reference") ?? stringField(model, "model");
  return undefined;
}

/**
 * Canonicalize the router's loosely-typed `failoverHistory` (ModelRef objects +
 * `retryableSubkind`) into the stable {@link FailoverAttempt} shape persisted in
 * the summary. Idempotent on already-normalized data, so it is safe to call again
 * at read/export time. Returns undefined when there is nothing recordable.
 */
export function normalizeFailoverHistory(value: unknown): FailoverAttempt[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const attempts: FailoverAttempt[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const model = failoverModel(entry.model);
    const failureKind = stringField(entry, "failureKind");
    // `retryableSubkind` is the router's field name; `subkind` keeps the helper
    // idempotent when fed already-normalized attempts.
    const subkind = stringField(entry, "retryableSubkind") ?? stringField(entry, "subkind");
    const requestId = stringField(entry, "requestId");
    if (model === undefined && failureKind === undefined && subkind === undefined && requestId === undefined) {
      continue;
    }
    attempts.push({
      ...(model === undefined ? {} : { model }),
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(subkind === undefined ? {} : { subkind }),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  return attempts.length === 0 ? undefined : attempts;
}

/**
 * Render a failover history into a compact, single-line `model → reason (req id)`
 * list (e.g. "pi:openai-codex:gpt-5.5 → timeout, pi:opencode-go:kimi-k2.6 →
 * server_error (req abc123)"). `reason` prefers the retryable subkind, then the
 * raw failure kind.
 */
export function renderFailoverHistory(history: readonly FailoverAttempt[] | undefined): string | undefined {
  if (history === undefined || history.length === 0) return undefined;
  return history
    .map((attempt) => {
      const label = attempt.model ?? "(unknown model)";
      const reason = attempt.subkind ?? attempt.failureKind ?? "failed";
      const req = attempt.requestId === undefined ? "" : ` (req ${attempt.requestId})`;
      return `${label} → ${reason}${req}`;
    })
    .join(", ");
}

/**
 * Compose the human-facing failure detail for a failed run: the taxonomy kind,
 * the per-attempt failover summary, and the capped underlying provider message.
 * Returns undefined when the run carries no failure signal (a clean run). This is
 * the descriptive string Phoenix shows in place of the bare `failureKind`.
 */
export function composeFailureDetail(
  summary: RunSummary,
  options: { readonly maxErrorChars?: number } = {},
): string | undefined {
  const failover = renderFailoverHistory(summary.failoverHistory);
  const hasError = typeof summary.error === "string" && summary.error.trim().length > 0;
  if (summary.failureKind === undefined && failover === undefined && !hasError) {
    return undefined;
  }
  let detail = summary.failureKind ?? "error";
  if (failover !== undefined) detail += `: ${failover}`;
  if (hasError) {
    detail += `; last error: ${compactString(summary.error as string, options.maxErrorChars ?? DEFAULT_FAILURE_ERROR_CHARS)}`;
  }
  return detail;
}

/** Always-on operational attributes describing a run's failure (never gated content). */
function failureDetailAttributes(summary: RunSummary, ctx: RunExportContext): SpanAttributes {
  const attrs: SpanAttributes = {};
  if (typeof summary.error === "string" && summary.error.trim().length > 0) {
    attrs["mono.agent.error.message"] = redactExportString(
      compactString(summary.error, ERROR_ATTRIBUTE_CHARS),
      ctx,
    );
  }
  const failover = summary.failoverHistory;
  if (failover !== undefined && failover.length > 0) {
    attrs["mono.agent.failover.count"] = failover.length;
    const detail = renderFailoverHistory(failover);
    if (detail !== undefined) attrs["mono.agent.failover.detail"] = redactExportString(detail, ctx);
  }
  return attrs;
}

/**
 * Build the root run span attribute bag (spec section 7 root keys). Optional
 * context fields are omitted entirely when absent (conditional spreads, never
 * `key: undefined`). `artifact_dir` is gated behind `includeSensitiveData`
 * because it discloses a local filesystem path ("only when explicitly allowed
 * for local debug").
 *
 * `warningsCount` is supplied by the caller via {@link countRuntimeWarnings};
 * it is intentionally EVENT-DERIVED (counting `type === 'runtime_warning'`)
 * rather than read from `summary.runtimeWarnings`, so the exported integer stays
 * stable regardless of the loosely-typed `runtimeWarnings` payload shape.
 */
export function buildRootSpanAttributes(
  summary: RunSummary,
  ctx: RunExportContext,
  warningsCount: number,
): SpanAttributes {
  return {
    "service.name": "mono-agent",
    "mono.agent.run_id": summary.runId,
    "mono.agent.conversation_id": summary.conversationId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
    ...(ctx.sourceLabel === undefined ? {} : { "mono.agent.source_label": ctx.sourceLabel }),
    ...(ctx.configPath === undefined ? {} : { "mono.agent.config_path": ctx.configPath }),
    "mono.agent.status": summary.status,
    ...(summary.failureKind === undefined ? {} : { "mono.agent.failure_kind": summary.failureKind }),
    // The underlying provider message + per-attempt failover detail (which models
    // were tried and how each failed) — operational metadata, always surfaced so a
    // failed trace shows the "why", not only the collapsed failure kind.
    ...failureDetailAttributes(summary, ctx),
    ...(summary.providerSessionId === undefined || summary.providerSessionId === null
      ? {}
      : { "mono.agent.provider_session_id": summary.providerSessionId }),
    "mono.agent.events.count": summary.eventCount,
    "mono.agent.warnings.count": warningsCount,
    ...(ctx.includeSensitiveData && ctx.artifactDir !== undefined
      ? { "mono.agent.artifact_dir": ctx.artifactDir }
      : {}),
    // Run classification (memory vs channel) + memory sub-operation. Threaded via
    // the export context, so memory runs are filterable (and the root span kind is
    // adjusted in the OTLP builder) without sniffing the run-id prefix.
    ...(ctx.runKind === undefined ? {} : { "mono.agent.run.kind": ctx.runKind }),
    ...(ctx.memoryOperation === undefined ? {} : { "mono.agent.memory.operation": ctx.memoryOperation }),
    // Model: `llm.model_name` lights up Phoenix's model column; the `mono.agent.*`
    // mirror stays in our stable namespace for filtering.
    ...(summary.model === undefined
      ? {}
      : { "llm.model_name": summary.model, "mono.agent.model": summary.model }),
    // Latency, tokens and cost are metadata (never content) so they are always
    // exported, like `events.count`. Token keys use OpenInference conventions so
    // Phoenix renders them in its token columns.
    "mono.agent.duration_ms": summary.durationMs,
    ...tokenAttributes(summary.usage),
    ...costAttributes(summary.cost, summary.usage),
  };
}

/** Read a finite number, else undefined (drops nulls/strings/NaN from loosely-typed payloads). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Map the run's token usage record onto OpenInference `llm.token_count.*` keys.
 * Field names match the provider bridges' enriched usage (input_tokens /
 * output_tokens / cache_read_tokens / cache_creation_tokens). Only finite numbers
 * are emitted; `total` is derived when either prompt or completion is present.
 */
function tokenAttributes(usage: unknown): SpanAttributes {
  if (!isRecord(usage)) {
    return {};
  }
  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  const cacheRead = finiteNumber(usage.cache_read_tokens);
  const cacheWrite = finiteNumber(usage.cache_creation_tokens);
  return {
    ...(input === undefined ? {} : { "llm.token_count.prompt": input }),
    ...(output === undefined ? {} : { "llm.token_count.completion": output }),
    ...(input === undefined && output === undefined ? {} : { "llm.token_count.total": (input ?? 0) + (output ?? 0) }),
    ...(cacheRead === undefined ? {} : { "llm.token_count.prompt_details.cache_read": cacheRead }),
    ...(cacheWrite === undefined ? {} : { "llm.token_count.prompt_details.cache_write": cacheWrite }),
  };
}

/**
 * Resolve run cost (USD). Prefer the observer aggregate `cost.cumulativeUsd`
 * (correct across multi-turn channel runs) and fall back to `usage.cost_usd`
 * (populated on single-turn memory runs). Phoenix can't price the local/codex
 * models from its built-in table, so this is the authoritative surfaced cost.
 */
function costAttributes(cost: unknown, usage: unknown): SpanAttributes {
  const fromCost = isRecord(cost) ? finiteNumber(cost.cumulativeUsd) : undefined;
  const fromUsage = isRecord(usage) ? finiteNumber(usage.cost_usd) : undefined;
  const usd = fromCost ?? fromUsage;
  return usd === undefined ? {} : { "mono.agent.cost_usd": usd };
}

function fileChangeExportAttributes(event: RuntimeEventLike, ctx: RunExportContext): SpanAttributes {
  if (event.type !== "file_change") {
    return {};
  }
  const summary = isRecord(event.summary) ? event.summary : undefined;
  const changes = Array.isArray(event.changes) ? event.changes.filter(isRecord) : [];
  const paths = changes.map((change) => stringField(change, "path")).filter((path): path is string => path !== undefined);
  const status = stringField(event, "status") ?? (event.is_error === true || event.error !== undefined ? "failed" : undefined);
  const files = finiteNumber(summary?.files) ?? (changes.length > 0 ? changes.length : undefined);
  const addedLines = finiteNumber(summary?.added_lines);
  const removedLines = finiteNumber(summary?.removed_lines);
  const changedLines = finiteNumber(summary?.changed_lines);
  const unavailableCount = finiteNumber(summary?.unavailable_count);
  return {
    ...(status === undefined ? {} : { "mono.agent.file_change.status": status }),
    ...(files === undefined ? {} : { "mono.agent.file_change.files": files }),
    ...(addedLines === undefined ? {} : { "mono.agent.file_change.added_lines": addedLines }),
    ...(removedLines === undefined ? {} : { "mono.agent.file_change.removed_lines": removedLines }),
    ...(changedLines === undefined ? {} : { "mono.agent.file_change.changed_lines": changedLines }),
    ...(unavailableCount === undefined ? {} : { "mono.agent.file_change.unavailable_count": unavailableCount }),
    ...(ctx.includeSensitiveData && paths.length > 0
      ? { "mono.agent.file_change.paths": redactExportString(paths.join(", "), ctx) }
      : {}),
  };
}

/**
 * Build a per-event child span mapping. Category/label/summary are derived via
 * {@link buildEventDescriptors} (the single source of truth shared with the
 * recorded-run reader) so the export never re-derives classification logic.
 *
 * Provider/model latency events (e.g. `provider_bridge_latency`, `tool_timing`)
 * ride this generic per-event span path: they classify as `runtime` and become
 * ordinary child spans rather than a bespoke model span, satisfying spec 6.4's
 * "root span event" option without inventing a dedicated latency mapping.
 */
export function buildEventSpanAttributes(
  event: RuntimeEventLike,
  index: number,
  ctx: RunExportContext,
  maxStringBytes: number = DEFAULT_MAX_STRING_BYTES,
): EventSpanMapping {
  const { category, label, summary } = buildEventDescriptors(event, maxStringBytes);
  const redactedSummary = redactExportString(summary, ctx, maxStringBytes);
  const eventType = typeof event.type === "string" ? event.type : "";
  const attributes: SpanAttributes = {
    "mono.agent.event.index": index,
    "mono.agent.event.type": eventType,
    "mono.agent.event.category": category,
    // `label` is structural (e.g. "Tool: Read", "Message: assistant") and safe
    // to always export. `summary` is content-derived (assistant text, tool-result
    // JSON, error text, delta), so it is gated behind includeSensitiveData — in
    // metadata-only mode it would otherwise leak run content the same way the raw
    // payload does. The structural `label` remains for navigation.
    "mono.agent.event.label": label,
    ...(ctx.includeSensitiveData ? { "mono.agent.event.summary": redactedSummary } : {}),
    "mono.agent.run_id": ctx.runId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
    ...fileChangeExportAttributes(event, ctx),
  };
  return {
    name: label,
    category,
    attributes,
    // Metadata-only by default: omit the raw payload entirely. When sensitive
    // export is opted in, STILL redact before attaching (spec section 7).
    ...(ctx.includeSensitiveData
      ? {
          payload: redactJsonValue(event, maxStringBytes, {
            contentPatternRedaction: ctx.contentPatternRedaction === true,
          }),
        }
      : {}),
  };
}

const EXPORT_CONTENT_MAX_CHARS = 4_000;
const MIME_TEXT = "text/plain";
const MIME_JSON = "application/json";

/** OpenInference span kind for Phoenix rendering (LLM/TOOL/CHAIN) from a category. */
function openInferenceKind(category: RecordedRunEventCategory): string {
  switch (spanKindHint(category)) {
    case "TOOL":
      return "TOOL";
    case "LLM":
      return "LLM";
    case "INTERNAL":
      return "CHAIN";
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Serialize tool args/results to a bounded display string. Structured input
 * uses shared key-based redaction: non-numeric values under sensitive-looking
 * object keys are redacted; numeric values under matched keys are retained;
 * free text is not content-scanned by default. Raw string input is retained
 * free text and capped for display. `contentPatternRedaction` enables the same
 * closed high-confidence scan for structured and raw string input.
 */
function toContentString(value: unknown, maxStringBytes: number, ctx: RunExportContext): string {
  const options = { contentPatternRedaction: ctx.contentPatternRedaction === true } as const;
  const raw = typeof value === "string"
    ? redactExportString(value, ctx, maxStringBytes)
    : JSON.stringify(redactJsonValue(value, maxStringBytes, options));
  return compactString(raw ?? "", EXPORT_CONTENT_MAX_CHARS);
}

function blockText(block: Record<string, unknown>): string {
  return asString(block.text) ?? asString(block.thinking) ?? asString(block.content) ?? "";
}

function toolResultFileChange(block: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(block.file_change)) {
    return block.file_change;
  }
  const rawResult = isRecord(block.raw_result) ? block.raw_result : undefined;
  const details = isRecord(rawResult?.details) ? rawResult.details : undefined;
  return isRecord(details?.file_change) ? details.file_change : undefined;
}

function toolFileChangeAttributes(tool: ToolDraft, ctx: RunExportContext): SpanAttributes {
  if (tool.name !== "Write") {
    return {};
  }
  const fileChange = tool.fileChange;
  if (fileChange === undefined) {
    return { "mono.agent.tool.file_change.available": false };
  }
  const summary = isRecord(fileChange.summary) ? fileChange.summary : undefined;
  const changes = Array.isArray(fileChange.changes) ? fileChange.changes.filter(isRecord) : [];
  const paths = changes.map((change) => stringField(change, "path")).filter((path): path is string => path !== undefined);
  const status = stringField(fileChange, "status") ?? "completed";
  const files = finiteNumber(summary?.files) ?? changes.length;
  const addedLines = finiteNumber(summary?.added_lines);
  const removedLines = finiteNumber(summary?.removed_lines);
  const changedLines = finiteNumber(summary?.changed_lines);
  const unavailableCount = finiteNumber(summary?.unavailable_count);
  return {
    "mono.agent.tool.file_change.available": true,
    "mono.agent.tool.file_change.status": status,
    "mono.agent.tool.file_change.files": files,
    ...(addedLines === undefined ? {} : { "mono.agent.tool.file_change.added_lines": addedLines }),
    ...(removedLines === undefined ? {} : { "mono.agent.tool.file_change.removed_lines": removedLines }),
    ...(changedLines === undefined ? {} : { "mono.agent.tool.file_change.changed_lines": changedLines }),
    ...(unavailableCount === undefined ? {} : { "mono.agent.tool.file_change.unavailable_count": unavailableCount }),
    ...(ctx.includeSensitiveData && paths.length > 0
      ? { "mono.agent.tool.file_change.paths": redactExportString(paths.join(", "), ctx) }
      : {}),
  };
}

interface SpanDraft {
  readonly orderIndex: number;
  readonly mapping: EventSpanMapping;
}

interface ToolDraft {
  orderIndex: number;
  name: string;
  input: unknown;
  output?: unknown;
  executionMs?: number;
  isError?: boolean;
  toolUseId: string;
  fileChange?: Record<string, unknown>;
}

/**
 * Build child-span mappings for a run as a SEMANTIC timeline rather than one span
 * per raw event. Three things make the trace render nicely in Phoenix:
 *  - Streaming assistant deltas of the same kind are coalesced into one
 *    "Assistant thoughts" / "Assistant message" span carrying the full text.
 *  - A tool invocation's four raw events (assistant `tool_use`, `tool_timing`,
 *    and the `user` `tool_result`) are merged by `tool_use_id` into ONE TOOL
 *    span whose input is the tool args and output is the tool result.
 *  - Everything else (provider lifecycle, errors) passes through as a single
 *    CHAIN span via the shared classifier.
 * Each span carries OpenInference attributes (`openinference.span.kind`,
 * `input.value`/`output.value`) so Phoenix shows LLM/Tool/Chain blocks with real
 * content. Content is gated behind `includeSensitiveData`; structural labels are
 * always present. Output order follows each unit's first contributing event.
 */
export function buildEventSpans(
  events: readonly RuntimeEventLike[],
  ctx: RunExportContext,
  maxStringBytes: number = DEFAULT_MAX_STRING_BYTES,
): readonly EventSpanMapping[] {
  const drafts: SpanDraft[] = [];
  const tools = new Map<string, ToolDraft>();
  let buffer: { kind: "thinking" | "text"; orderIndex: number; texts: string[] } | undefined;

  const flushBuffer = (): void => {
    if (buffer === undefined) {
      return;
    }
    const isThinking = buffer.kind === "thinking";
    const category: RecordedRunEventCategory = isThinking ? "thinking" : "message";
    const label = isThinking ? "Assistant thoughts" : "Assistant message";
    const text = redactExportString(
      compactString(buffer.texts.join(""), EXPORT_CONTENT_MAX_CHARS),
      ctx,
      maxStringBytes,
    );
    const sourceCount = buffer.texts.length;
    drafts.push({
      orderIndex: buffer.orderIndex,
      mapping: {
        name: label,
        category,
        attributes: {
          ...baseAttrs(ctx, buffer.orderIndex, isThinking ? "thinking" : "message", category, label),
          ...(sourceCount > 1 ? { "mono.agent.event.source_count": sourceCount } : {}),
          ...openInferenceAttrs(category, label, ctx.includeSensitiveData ? text : label, MIME_TEXT),
          ...(ctx.includeSensitiveData ? { "mono.agent.event.summary": text } : {}),
        },
      },
    });
    buffer = undefined;
  };

  const appendChunk = (kind: "thinking" | "text", orderIndex: number, text: string): void => {
    if (buffer !== undefined && buffer.kind !== kind) {
      flushBuffer();
    }
    if (buffer === undefined) {
      buffer = { kind, orderIndex, texts: [] };
    }
    buffer.texts.push(text);
  };

  const emitTool = (tool: ToolDraft): void => {
    const label = `Tool: ${tool.name}`;
    const inputValue = ctx.includeSensitiveData ? toContentString(tool.input, maxStringBytes, ctx) : label;
    const outputValue = ctx.includeSensitiveData
      ? toContentString(tool.output, maxStringBytes, ctx)
      : tool.isError === true
        ? "error"
        : "ok";
    drafts.push({
      orderIndex: tool.orderIndex,
      mapping: {
        name: label,
        category: "tool",
        attributes: {
          ...baseAttrs(ctx, tool.orderIndex, "tool", "tool", label),
          "mono.agent.tool.name": tool.name,
          "mono.agent.tool.use_id": tool.toolUseId,
          ...(tool.executionMs === undefined ? {} : { "mono.agent.tool.execution_ms": tool.executionMs }),
          ...(tool.isError === undefined ? {} : { "mono.agent.tool.is_error": tool.isError }),
          ...toolFileChangeAttributes(tool, ctx),
          "tool.name": tool.name,
          ...openInferenceAttrs("tool", inputValue, outputValue, ctx.includeSensitiveData ? MIME_JSON : MIME_TEXT),
        },
      },
    });
  };

  events.forEach((event, index) => {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "tool_timing") {
      const id = stringField(event, "tool_use_id");
      const tool = id === undefined ? undefined : tools.get(id);
      if (tool !== undefined) {
        const ms = event.execution_ms;
        if (typeof ms === "number") {
          tool.executionMs = ms;
        }
        if (typeof event.is_error === "boolean") {
          tool.isError = event.is_error;
        }
      }
      return; // folds into the tool span; no standalone span
    }

    const message = isRecord(event.message) ? event.message : undefined;
    const content = message !== undefined && Array.isArray(message.content) ? message.content : undefined;
    if (content !== undefined) {
      let handled = false;
      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === "thinking") {
          appendChunk("thinking", index, blockText(block));
          handled = true;
        } else if (block.type === "text") {
          appendChunk("text", index, blockText(block));
          handled = true;
        } else if (block.type === "tool_use") {
          flushBuffer();
          const id = asString(block.id) ?? `tool-${index}`;
          tools.set(id, {
            orderIndex: index,
            name: asString(block.name) ?? "tool",
            input: block.input,
            toolUseId: id,
          });
          handled = true;
        } else if (block.type === "tool_result") {
          flushBuffer();
          const id = asString(block.tool_use_id);
          const tool = id === undefined ? undefined : tools.get(id);
          if (tool !== undefined) {
            tool.output = block.content;
            const fileChange = toolResultFileChange(block);
            if (fileChange !== undefined) {
              tool.fileChange = fileChange;
            }
            emitTool(tool);
            tools.delete(id!);
            handled = true;
          }
        }
      }
      if (handled) {
        return;
      }
    }

    // Generic event (provider lifecycle, errors, plain messages): one span.
    flushBuffer();
    const { category, label, summary } = buildEventDescriptors(event, maxStringBytes);
    const redactedSummary = redactExportString(summary, ctx, maxStringBytes);
    drafts.push({
      orderIndex: index,
      mapping: {
        name: label,
        category,
        attributes: {
          ...baseAttrs(ctx, index, type, category, label),
          ...fileChangeExportAttributes(event, ctx),
          ...openInferenceAttrs(category, label, ctx.includeSensitiveData ? redactedSummary : label, MIME_TEXT),
          ...(ctx.includeSensitiveData ? { "mono.agent.event.summary": redactedSummary } : {}),
        },
        ...(ctx.includeSensitiveData
          ? {
              payload: redactJsonValue(event, maxStringBytes, {
                contentPatternRedaction: ctx.contentPatternRedaction === true,
              }),
            }
          : {}),
      },
    });
  });

  flushBuffer();
  // Tools whose result never arrived still get a span (with what we captured).
  for (const tool of tools.values()) {
    emitTool(tool);
  }

  return drafts.sort((a, b) => a.orderIndex - b.orderIndex).map((draft) => draft.mapping);
}

function baseAttrs(
  ctx: RunExportContext,
  index: number,
  type: string,
  category: RecordedRunEventCategory,
  label: string,
): SpanAttributes {
  return {
    "mono.agent.event.index": index,
    "mono.agent.event.type": type,
    "mono.agent.event.category": category,
    "mono.agent.event.label": label,
    "mono.agent.run_id": ctx.runId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
  };
}

function openInferenceAttrs(
  category: RecordedRunEventCategory,
  inputValue: string,
  outputValue: string,
  inputMime: string = MIME_TEXT,
): SpanAttributes {
  return {
    "openinference.span.kind": openInferenceKind(category),
    "input.value": inputValue,
    "input.mime_type": inputMime,
    "output.value": outputValue,
    "output.mime_type": MIME_TEXT,
  };
}

/**
 * Count runtime warnings from the buffered event stream. Intentionally
 * event-derived (`type === 'runtime_warning'`) so the integer is stable and does
 * not depend on the loosely-typed `RunSummary.runtimeWarnings` payload shape.
 */
export function countRuntimeWarnings(events: readonly RuntimeEventLike[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "runtime_warning") {
      count += 1;
    }
  }
  return count;
}

/** Suggest an OTel span kind for a recorded-event category. */
export function spanKindHint(category: RecordedRunEventCategory): SpanKindHint {
  switch (category) {
    case "tool":
      return "TOOL";
    case "message":
    case "thinking":
      return "LLM";
    case "runtime":
    case "error":
      return "INTERNAL";
  }
}

/**
 * Derive a span status. A failed/cancelled run, or an `error`-category event,
 * maps to ERROR; everything else is UNSET. A `runtime_warning` event (which
 * classifies as `runtime`) on a succeeded run therefore never forces ERROR.
 */
export function spanStatusFor(
  status: RunSummaryStatus,
  category: RecordedRunEventCategory,
): SpanStatusHint {
  if (status === "failed" || status === "cancelled" || status === "interrupted" || category === "error") {
    return "ERROR";
  }
  return "UNSET";
}

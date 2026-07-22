import type { Component } from "@earendil-works/pi-tui";
import { deriveRunSource, type RecordedRunEvent } from "@mono-agent/observability";

import type { ReplayRunDetail, ReplayTimelineItem } from "../../data/replay.js";
import { categoryStyle } from "../components/event-list.js";
import { AssistantCell, NoticeCell, ThinkingCell, UserCell } from "../components/transcript-cells.js";
import { ToolPanel } from "../components/tool-panel.js";
import { extractUsage, formatClock, formatDurationMs, formatTokens, formatUsd } from "../format.js";
import { sessionBoundaryNotice } from "../session-boundary.js";
import { escapeTerminalControls } from "../terminal-text.js";
import { styles } from "../theme.js";

/** Canonical (not alphabetical) filter-category order matching the t/o/m/y/e keymap. */
export const CATEGORY_ORDER: readonly string[] = ["thinking", "tool", "message", "runtime", "error"];

/** Single-key toggles for the detail-mode category filter (see task brief's keybinding map). */
export const CATEGORY_KEYS: Readonly<Record<string, string>> = {
  t: "thinking",
  o: "tool",
  m: "message",
  y: "runtime",
  e: "error",
};

export const KEY_HINT =
  "↑↓/pgup/pgdn/g/G step · [ ] turn · t/o/m/y/e/a filter · / search · n/N match · enter raw json · esc back";

const PAYLOAD_MAX_LINES_COLLAPSED = 12;
const PAYLOAD_MAX_LINES_EXPANDED = 40;

/** Headline text (multi-line): run id/source, conversation/status, clock/model/effort, usage, errors, turn stats. */
export function buildHeadline(replay: ReplayRunDetail): string {
  const summary = replay.detail.summary;
  const resolvedSource = summary.source ?? deriveRunSource(summary.conversationId);
  const badge = `[${resolvedSource}]${summary.sourceDetail === undefined ? "" : ` · ${summary.sourceDetail}`}`;
  const lines = [
    `${styles.bold(styles.accent(`run ${summary.runId}`))} ${styles.muted(badge)}`,
    styles.muted(`${summary.conversationId} · ${summary.status}`),
  ];

  const model = summary.model ?? replay.runConfig?.model;
  const effort = replay.effort;
  // Gate the "(override)" marker on the run_config's own `overridden` flag
  // alone -- NOT on whether the displayed model/effort happened to come from
  // the run_config fallback. A newer artifact carries model/effort directly
  // on `summary` (no fallback needed) but can still be an overridden run, and
  // should still show the marker.
  const overridden = replay.runConfig?.overridden === true;

  const line3: string[] = [];
  const clock = formatClock(summary.startedAt);
  if (clock.length > 0) {
    line3.push(clock);
  }
  line3.push(formatDurationMs(summary.durationMs), `${summary.eventCount} events`);
  if (model !== undefined) {
    line3.push(`${model}${overridden ? " (override)" : ""}`);
  }
  if (effort !== undefined) {
    line3.push(`effort:${effort}${overridden ? " (override)" : ""}`);
  }
  lines.push(styles.muted(line3.join(" · ")));

  const usage = usageLine(summary.usage, summary.cost);
  if (usage !== undefined) {
    lines.push(styles.muted(usage));
  }
  if (summary.error !== undefined) {
    lines.push(styles.error(`error: ${summary.error}`));
  }
  for (const attempt of summary.failoverHistory ?? []) {
    lines.push(styles.warning(`failover: ${attempt.model} → ${attempt.failureKind ?? "?"}`));
  }
  if (replay.turns.length > 0) {
    const totalThinkingChars = replay.turns.reduce((sum, turn) => sum + turn.thinkingChars, 0);
    lines.push(styles.muted(`turns: ${replay.turns.length} · thinking: ${formatTokens(totalThinkingChars)}`));
  }
  return lines.join("\n");
}

export interface StatusLineState {
  /** 1-based rank among VISIBLE (post-filter) items; undefined when nothing is visible/selected. */
  readonly ordinal: number | undefined;
  readonly visibleCount: number;
  readonly turnIndex: number | undefined;
  readonly turnCount: number;
  readonly categoryFilter: ReadonlySet<string>;
  readonly searchInputOpen: boolean;
  readonly searchInputBuffer: string;
  readonly committedSearch: string | undefined;
  readonly matchCount: number;
}

/** Filter/status line + a dim key-hint line underneath it. */
export function buildStatusLine(state: StatusLineState): string {
  const segments: string[] = [];
  if (state.ordinal !== undefined) {
    segments.push(`event ${state.ordinal}/${state.visibleCount}`);
  }
  if (state.turnIndex !== undefined && state.turnCount > 0) {
    segments.push(`turn ${state.turnIndex + 1}/${state.turnCount}`);
  }
  if (state.categoryFilter.size > 0) {
    const active = CATEGORY_ORDER.filter((category) => state.categoryFilter.has(category));
    const colored = active.map((category) => categoryStyle(category)(category));
    segments.push(`filters: ${colored.join(",")}`);
  }
  if (state.searchInputOpen) {
    segments.push(`search: "${state.searchInputBuffer}█"`);
  } else if (state.committedSearch !== undefined) {
    segments.push(`search: "${state.committedSearch}" (${state.matchCount} matches)`);
  }
  return `${styles.muted(segments.join(" · "))}\n${styles.dim(KEY_HINT)}`;
}

/**
 * Header line for the selected-event pane (index/label/timing/group span,
 * plus a thinking item's own char/duration stats). Unchanged by the Part B
 * cell redesign below -- only the BODY under it now varies by category.
 */
export function buildPayloadHeader(item: ReplayTimelineItem): string {
  let header = `#${item.index} ${escapeTerminalControls(item.label)}`;
  const timing: string[] = [];
  if (item.timestamp !== undefined) {
    timing.push(escapeTerminalControls(item.timestamp));
  }
  if (item.deltaMs !== undefined) {
    timing.push(`+${formatDurationMs(item.deltaMs)}`);
  }
  if (timing.length > 0) {
    header += ` · ${timing.join(" · ")}`;
  }
  if (item.sourceEventCount > 1) {
    header += ` · events #${item.sourceEventStartIndex}–#${item.sourceEventEndIndex}`;
  }
  if (item.category === "thinking" && item.contentChars !== undefined) {
    header += ` ${thinkingStatsSuffix(item.contentChars, item.timestamp, item.endTimestamp)}`;
  }
  return header;
}

/**
 * Pretty-printed raw JSON body for the selected event, capped at today's
 * established line counts (12 collapsed / 40 expanded) with a
 * `… (+N more lines)` trailer when truncated. Used both as the WHOLE body for
 * generic runtime/telemetry items (session boundaries and runtime warnings
 * have notice cells) and as the optional strip appended below a chat-style
 * cell once the pane is expanded.
 */
export function buildRawPayloadBody(item: ReplayTimelineItem, expanded: boolean): string {
  const maxLines = expanded ? PAYLOAD_MAX_LINES_EXPANDED : PAYLOAD_MAX_LINES_COLLAPSED;
  const allLines = formatPayloadRaw(item.payload).split("\n");
  const shown = allLines.slice(0, maxLines);
  const remaining = allLines.length - shown.length;
  return (remaining > 0 ? [...shown, styles.dim(`… (+${remaining} more lines)`)] : shown).join("\n");
}

/**
 * The chat-style transcript cell for the selected event, reusing live chat's
 * OWN components (ThinkingCell/AssistantCell/UserCell/NoticeCell/ToolPanel) so
 * replay and live chat read as one interface. Returns `undefined` for
 * generic runtime/telemetry items (provider_request_*, run_config, cost,
 * capabilities…; session boundaries and runtime warnings are exceptions) and
 * for a "tool" category item that -- despite the category -- carries neither
 * a `tool_use` nor a `tool_result` content block (e.g. a
 * `tool_update`/`tool_timing` progress event, classified "tool" purely by its
 * `type` string containing "tool"): callers fall back to
 * {@link buildRawPayloadBody} for both cases, exactly as before Part B.
 *
 * `timeline` (the run's coalesced persisted-event item list) is used to look AHEAD from
 * a `tool_use` item for its matching `tool_result` (by `tool_use_id`) so a
 * call+result pair renders as ONE unified panel, like a live tool call
 * settling. `rawEvents` contains the run reader's bounded, uncoalesced event
 * projections and is used to reconstruct the joined text retained in a
 * coalesced thinking/text group. The reader's key-pattern pass ensures
 * non-numeric values under sensitive-looking object keys are redacted; numeric
 * values under matched keys are retained; retained free text is not
 * content-scanned. The combiner's own synthetic payload for a multi-event
 * group carries only the compacted (220-char) `summary`, not the full text
 * (see `combinedEventItem` in event-timeline.ts).
 */
export function buildDetailCell(
  item: ReplayTimelineItem,
  timeline: readonly ReplayTimelineItem[],
  rawEvents: readonly RecordedRunEvent[],
): Component | undefined {
  if (item.category === "thinking") {
    const cell = new ThinkingCell();
    cell.append(extractFullText(item, rawEvents, "thinking"));
    cell.setExpanded(true);
    cell.active = false;
    const durationMs = parseSpanMs(item.timestamp, item.endTimestamp);
    if (durationMs !== undefined) {
      cell.setDurationMs(durationMs);
    }
    return cell;
  }
  if (item.category === "error") {
    return new NoticeCell(item.summary, "error");
  }
  if (item.category === "runtime") {
    const boundaryNotice = sessionBoundaryNotice(item.payload);
    if (boundaryNotice !== undefined) {
      return new NoticeCell(boundaryNotice, "info");
    }
    return item.type === "runtime_warning" ? new NoticeCell(item.summary, "warning") : undefined;
  }
  if (item.category === "tool") {
    return buildToolCell(item, timeline);
  }
  if (item.category === "message") {
    if (item.type === "user") {
      return new UserCell(extractFullText(item, rawEvents, "text"));
    }
    const cell = new AssistantCell();
    cell.setText(extractFullText(item, rawEvents, "text"));
    return cell;
  }
  return undefined;
}

/** `tool_use` -> a fresh ToolPanel, completed with its matching `tool_result` when one is found later in the timeline (header-only otherwise). `tool_result` (selected directly, without its call) -> a standalone ToolPanel labeled "tool result" when the name isn't known. Neither block present -> undefined (raw JSON fallback). */
function buildToolCell(item: ReplayTimelineItem, timeline: readonly ReplayTimelineItem[]): Component | undefined {
  const toolUse = firstBlock(item.payload, "tool_use");
  if (toolUse !== undefined) {
    const id = stringOrUndefined(toolUse.id) ?? `item-${item.index}`;
    const name = stringOrUndefined(toolUse.name) ?? "tool";
    const panel = new ToolPanel(id, name, toolUse.input);
    const result = findToolResult(timeline, id, item.index);
    panel.complete(
      result === undefined
        ? { content: undefined }
        : { isError: result.is_error === true, content: result.content },
    );
    return panel;
  }
  const toolResult = firstBlock(item.payload, "tool_result");
  if (toolResult !== undefined) {
    const id = stringOrUndefined(toolResult.tool_use_id) ?? `item-${item.index}`;
    const name = stringOrUndefined(toolResult.name) ?? "tool result";
    const panel = new ToolPanel(id, name);
    panel.complete({ isError: toolResult.is_error === true, content: toolResult.content });
    return panel;
  }
  return undefined;
}

/**
 * First `tool_result` content block at or after `afterIndex` (exclusive)
 * whose `tool_use_id` matches, or undefined. Scans EVERY `tool_result` block
 * in a candidate item, not just the first -- a real pi-runtime parallel tool
 * batch can deliver several results on one `user` event (see
 * `countToolResultBlocks`'s doc comment in event-classify.ts), and the call
 * we're matching may not be the first one.
 */
function findToolResult(
  timeline: readonly ReplayTimelineItem[],
  toolUseId: string,
  afterIndex: number,
): Record<string, unknown> | undefined {
  for (const candidate of timeline) {
    if (candidate.index <= afterIndex || candidate.category !== "tool") {
      continue;
    }
    const match = blocksOfType(candidate.payload, "tool_result").find(
      (block) => stringOrUndefined(block.tool_use_id) === toolUseId,
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

/** First content block of `blockType` on a reader-projected event's `message.content` array, if any. */
function firstBlock(payload: unknown, blockType: "tool_use" | "tool_result"): Record<string, unknown> | undefined {
  return blocksOfType(payload, blockType)[0];
}

/** Every content block of `blockType` on a reader-projected event's `message.content` array. */
function blocksOfType(payload: unknown, blockType: "tool_use" | "tool_result"): readonly Record<string, unknown>[] {
  if (!isRecord(payload)) {
    return [];
  }
  const message = payload.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter(
    (block): block is Record<string, unknown> => isRecord(block) && block.type === blockType,
  );
}

/**
 * Joined thinking/text content retained by the run reader's bounded event
 * projection, without the replay coalescer's additional summary compaction.
 * The reader's key-pattern pass ensures non-numeric values under
 * sensitive-looking object keys are redacted; numeric values under matched
 * keys are retained; retained free text is not content-scanned. A single-event
 * item's `payload` is that bounded projection (walk it directly); a coalesced
 * group's synthetic payload carries only the compacted `summary`, so walk the
 * group's projected events (via
 * `sourceEventStartIndex`/`sourceEventEndIndex`, which index into
 * `rawEvents` 1:1 -- see `toRecordedEvent`'s `index` in recorded-runs.ts)
 * instead. Falls back to `item.summary` when no block of `kind` is found
 * anywhere (defensive -- shouldn't happen for a well-formed thinking/message
 * item).
 */
function extractFullText(
  item: ReplayTimelineItem,
  rawEvents: readonly RecordedRunEvent[],
  kind: "thinking" | "text",
): string {
  if (item.sourceEventCount <= 1) {
    return extractEventText(item.payload, kind) ?? item.summary;
  }
  const texts: string[] = [];
  for (let index = item.sourceEventStartIndex; index <= item.sourceEventEndIndex; index += 1) {
    const text = extractEventText(rawEvents[index]?.payload, kind);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("") : item.summary;
}

/** Joined `kind`-typed block text from a single raw event's payload, or undefined when the shape doesn't match. */
function extractEventText(payload: unknown, kind: "thinking" | "text"): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const message = payload.message;
  if (typeof message === "string") {
    return kind === "text" ? message : undefined;
  }
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== kind) {
      continue;
    }
    const text =
      kind === "thinking"
        ? (stringOrUndefined(block.thinking) ?? stringOrUndefined(block.text) ?? stringOrUndefined(block.content))
        : (stringOrUndefined(block.text) ?? stringOrUndefined(block.content));
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `endTimestamp - timestamp` in ms when both parse as dates, else undefined. Clamped to >= 0 (clock skew). */
function parseSpanMs(timestamp: string | undefined, endTimestamp: string | undefined): number | undefined {
  if (timestamp === undefined || endTimestamp === undefined) {
    return undefined;
  }
  const start = Date.parse(timestamp);
  const end = Date.parse(endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return Math.max(0, end - start);
}

function thinkingStatsSuffix(contentChars: number, timestamp: string | undefined, endTimestamp: string | undefined): string {
  const chars = formatTokens(contentChars);
  const span = parseSpanMs(timestamp, endTimestamp);
  return span === undefined ? `(${chars})` : `(${chars} · ${formatDurationMs(span)})`;
}

function formatPayloadRaw(payload: unknown): string {
  if (typeof payload === "string") {
    return escapeTerminalControls(payload);
  }
  try {
    const json = JSON.stringify(payload, null, 2);
    return json === undefined
      ? escapeTerminalControls(String(payload))
      : escapeTerminalControls(json, { allowLineFeed: true });
  } catch {
    try {
      return escapeTerminalControls(String(payload));
    } catch {
      return "[unrenderable payload]";
    }
  }
}

function usageLine(usage: unknown, cost: unknown): string | undefined {
  const extracted = extractUsage(usage, cost);
  if (extracted === undefined) {
    return undefined;
  }
  return `tokens ↑${formatTokens(extracted.input ?? 0)} ↓${formatTokens(extracted.output ?? 0)}${
    extracted.usd === undefined ? "" : ` · ${formatUsd(extracted.usd)}`
  }`;
}

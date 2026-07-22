import { countToolResultBlocks, firstToolResultBlock } from "./event-classify.js";
import { isRecord } from "./guards.js";
import type { RecordedRunTimelineItem, TimelineTurn } from "./types.js";

/**
 * Split a run's timeline into agent-loop turns. One recorded run corresponds
 * to one user request; within that run, each turn is delimited by a round
 * trip through one or more tools.
 *
 * The real pi-runtime shape per tool call is: a streamed `assistant`-typed
 * item carrying the `tool_use` block, then a `tool_timing`-typed item (also
 * category "tool"), then a `user`-typed item carrying the `tool_result`
 * block. A PARALLEL batch of N tool calls streams all N `tool_use` items
 * first, then delivers the `tool_timing`+`tool_result` pairs one at a time —
 * so a naive "boundary right after every tool_result" rule would fragment one
 * turn's tail into N-1 pseudo-turns containing only timing+result debris.
 *
 * The boundary rule here instead is: turn 0 starts at the first item, and
 * once one or more `user` `tool_result` items have been seen in the current
 * turn, the turn ends immediately BEFORE the next item whose `type` is
 * `"assistant"` (thinking, tool, or message — any category). Non-assistant
 * items (more tool_results, tool_timing, runtime/telemetry events) stay in
 * the current turn regardless of how many tool_results have been seen.
 * Degrades gracefully — no tool_result seen means no boundary, so no
 * boundaries found yields exactly one turn covering every item; empty input
 * yields an empty array; and malformed/foreign event shapes are simply not
 * treated as tool_results (never thrown).
 */
export function segmentTimelineTurns(items: readonly RecordedRunTimelineItem[]): readonly TimelineTurn[] {
  if (items.length === 0) {
    return [];
  }

  const startIndices: number[] = [0];
  let sawToolResult = false;
  for (const [index, item] of items.entries()) {
    if (sawToolResult && item.type === "assistant") {
      startIndices.push(index);
      sawToolResult = false;
    }
    if (isToolResultItem(item)) {
      sawToolResult = true;
    }
  }

  return startIndices.map((startItemIndex, turnIndex) => {
    const endItemIndex = (startIndices[turnIndex + 1] ?? items.length) - 1;
    const turnItems = items.slice(startItemIndex, endItemIndex + 1);
    return buildTurn(turnIndex, startItemIndex, endItemIndex, turnItems);
  });
}

function buildTurn(
  turnIndex: number,
  startItemIndex: number,
  endItemIndex: number,
  turnItems: readonly RecordedRunTimelineItem[],
): TimelineTurn {
  const startedAt = firstTimestamp(turnItems);
  const durationMs = computeDurationMs(startedAt, turnItems);
  const thinkingChars = turnItems.reduce(
    (sum, item) => sum + (item.category === "thinking" ? item.contentChars ?? 0 : 0),
    0,
  );
  const toolCalls = turnItems.reduce((sum, item) => sum + completedToolCallCount(item), 0);
  return {
    turnIndex,
    startItemIndex,
    endItemIndex,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    thinkingChars,
    toolCalls,
  };
}

function firstTimestamp(items: readonly RecordedRunTimelineItem[]): string | undefined {
  for (const item of items) {
    if (item.timestamp !== undefined) {
      return item.timestamp;
    }
  }
  return undefined;
}

function computeDurationMs(startedAt: string | undefined, items: readonly RecordedRunTimelineItem[]): number | undefined {
  if (startedAt === undefined) {
    return undefined;
  }
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) {
    return undefined;
  }
  const last = items[items.length - 1];
  const endTimestamp = last?.endTimestamp ?? last?.timestamp;
  if (endTimestamp === undefined) {
    return undefined;
  }
  const endMs = Date.parse(endTimestamp);
  return Number.isFinite(endMs) ? endMs - startMs : undefined;
}

/**
 * A turn boundary trigger: a `user` event whose message content carries a
 * `tool_result` block. Reuses {@link firstToolResultBlock} (the shared
 * block-detection helper) against the item's underlying payload rather than
 * re-walking content blocks here. Any non-record/foreign payload shape simply
 * fails the check instead of throwing.
 */
function isToolResultItem(item: RecordedRunTimelineItem): boolean {
  if (item.type !== "user" || !isRecord(item.payload)) {
    return false;
  }
  return firstToolResultBlock(item.payload) !== undefined;
}

/**
 * Completed tool calls represented by one timeline item, for the turn's
 * `toolCalls` count: the number of `tool_result` content BLOCKS on a `user`
 * event (a single `user` event can carry more than one), rather than a flat
 * 1-per-item count. Non-tool-result items (assistant tool_use, tool_timing,
 * runtime events, etc.) contribute 0 — a call only counts once it has
 * completed. Reuses {@link countToolResultBlocks} (shared with
 * {@link isToolResultItem}'s block-detection helper) rather than re-walking
 * content blocks here; falls back to 1 for a non-record payload so an
 * odd-shaped completed-tool-result item still counts as one call.
 */
function completedToolCallCount(item: RecordedRunTimelineItem): number {
  if (item.category !== "tool" || item.type !== "user") {
    return 0;
  }
  return isRecord(item.payload) ? countToolResultBlocks(item.payload) : 1;
}

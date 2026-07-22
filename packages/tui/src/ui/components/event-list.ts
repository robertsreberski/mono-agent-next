import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import type { ReplayTimelineItem, TimelineTurn } from "../../data/replay.js";
import { formatClock, formatDurationMs, formatTokens } from "../format.js";
import { escapeTerminalControls } from "../terminal-text.js";
import { styles } from "../theme.js";

export interface EventTimelineListOptions {
  /** Max item rows shown at once (marker rows render in addition, uncapped). Default 16. */
  readonly maxVisible?: number;
}

/** Color a category label the same way replay's detail view does. Exported so callers besides this component (e.g. the replay detail pane) can reuse the mapping instead of duplicating it. */
export function categoryStyle(category: string): (text: string) => string {
  switch (category) {
    case "thinking":
      return styles.thinking;
    case "tool":
      return styles.accent;
    case "error":
      return styles.error;
    case "runtime":
      return styles.dim;
    default:
      return (text: string): string => text;
  }
}

/**
 * Additive glyph prefixed onto a row's label, drawn from live chat's own
 * vocabulary (∴ thinking, ✓/✗ tool results, ⚠ errors, green "you" for user
 * messages) so the replay timeline and the live transcript read as one
 * interface. Tool rows distinguish CALL vs RESULT via `item.type` (`"assistant"`
 * carries the `tool_use` block, `"user"` carries `tool_result` -- see
 * event-classify.ts's `firstToolUseBlock`/`firstToolResultBlock`): calls get a
 * neutral `→`, results get `✓`/`✗` keyed off the `"error: "` summary prefix
 * `nestedToolBlockSummary` stamps on an errored tool_result. Assistant text
 * rows (category "message", type "assistant") get no glyph -- only the four
 * categories above are additive. Returns "" for rows with no glyph.
 */
function rowGlyph(item: ReplayTimelineItem): string {
  switch (item.category) {
    case "thinking":
      return styles.thinking("∴");
    case "error":
      return styles.error("⚠");
    case "tool":
      if (item.type === "user") {
        return item.summary.startsWith("error: ") ? styles.error("✗") : styles.success("✓");
      }
      return styles.accent("→");
    case "message":
      return item.type === "user" ? styles.bold(styles.user("you")) : "";
    default:
      return "";
  }
}

/**
 * Debugger-style scrollable/filterable event timeline against the stable
 * pi-tui `Component` contract (no `SelectList`, no private-field casts).
 * Selection is an index into the FULL (unfiltered) items array passed to
 * {@link setItems}; `windowStart` (a rank within the visible rows) is nudged
 * the minimum amount to keep the selection inside the render window.
 */
export class EventTimelineList implements Component {
  onSelectionChange: ((item: ReplayTimelineItem | undefined) => void) | undefined;

  private readonly maxVisible: number;
  private items: readonly ReplayTimelineItem[] = [];
  private turns: readonly TimelineTurn[] = [];
  private turnByStartPosition = new Map<number, TimelineTurn>();
  private hasTimestamps = false;
  private categoryFilter: ReadonlySet<string> | undefined;
  private searchQuery: string | undefined;
  private selectedIndex = -1;
  /** Rank (0-based) within the current visible-rows list the render window starts at. */
  private windowStart = 0;

  constructor(options: EventTimelineListOptions = {}) {
    this.maxVisible = options.maxVisible ?? 16;
  }

  setItems(items: readonly ReplayTimelineItem[], turns: readonly TimelineTurn[]): void {
    this.items = items;
    this.turns = turns;
    this.turnByStartPosition = new Map(turns.map((turn) => [turn.startItemIndex, turn] as const));
    this.hasTimestamps = items.some((item) => item.timestampMs !== undefined);
    this.windowStart = 0;
    this.selectedIndex = items.length === 0 ? -1 : (this.nearestVisiblePosition(0) ?? 0);
    this.onSelectionChange?.(this.selectedItem());
    this.invalidate();
  }

  setCategoryFilter(categories: ReadonlySet<string> | undefined): void {
    this.categoryFilter = categories;
    if (this.items.length > 0) {
      const nearest = this.nearestVisiblePosition(this.selectedIndex);
      if (nearest !== undefined) {
        this.applySelection(nearest);
      }
    }
    this.invalidate();
  }

  setSearch(query: string | undefined): void {
    this.searchQuery = query === undefined || query.length === 0 ? undefined : query;
    this.invalidate();
  }

  selectedItem(): ReplayTimelineItem | undefined {
    return this.items[this.selectedIndex];
  }

  setSelectedIndex(index: number): void {
    if (this.items.length > 0) {
      const clamped = Math.min(Math.max(index, 0), this.items.length - 1);
      this.applySelection(this.nearestVisiblePosition(clamped) ?? clamped);
    }
    this.invalidate();
  }

  moveSelection(delta: number): void {
    const visible = this.visiblePositions();
    if (visible.length > 0) {
      const currentRank = visible.indexOf(this.selectedIndex);
      const nextRank = Math.min(Math.max((currentRank === -1 ? 0 : currentRank) + delta, 0), visible.length - 1);
      this.applySelection(visible[nextRank]!);
    }
    this.invalidate();
  }

  moveToFirst(): void {
    const visible = this.visiblePositions();
    if (visible.length > 0) {
      this.applySelection(visible[0]!);
    }
    this.invalidate();
  }

  moveToLast(): void {
    const visible = this.visiblePositions();
    if (visible.length > 0) {
      this.applySelection(visible[visible.length - 1]!);
    }
    this.invalidate();
  }

  moveToTurn(direction: 1 | -1): void {
    if (this.turns.length > 0) {
      const currentTurn = this.turnOfSelection();
      let candidate = currentTurn !== undefined ? currentTurn + direction : direction === 1 ? 0 : this.turns.length - 1;
      while (candidate >= 0 && candidate < this.turns.length) {
        const turn = this.turns[candidate]!;
        const firstVisible = this.firstVisiblePositionInRange(turn.startItemIndex, turn.endItemIndex);
        if (firstVisible !== undefined) {
          this.applySelection(firstVisible);
          break;
        }
        candidate += direction;
      }
    }
    this.invalidate();
  }

  moveToMatch(direction: 1 | -1): void {
    const matches = this.matchPositions();
    if (matches.length > 0) {
      const current = this.selectedIndex;
      const forward = direction === 1;
      let target = forward ? matches.find((p) => p > current) : [...matches].reverse().find((p) => p < current);
      target ??= forward ? matches[0] : matches[matches.length - 1];
      this.applySelection(target!);
    }
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
    } else if (matchesKey(data, "down")) {
      this.moveSelection(1);
    } else if (matchesKey(data, "pageUp")) {
      this.moveSelection(-this.maxVisible);
    } else if (matchesKey(data, "pageDown")) {
      this.moveSelection(this.maxVisible);
    } else if (matchesKey(data, "home")) {
      this.moveToFirst();
    } else if (matchesKey(data, "end")) {
      this.moveToLast();
    }
    // Everything else is ignored -- the host view routes remaining keys.
  }

  visibleCount(): number {
    return this.visiblePositions().length;
  }

  totalCount(): number {
    return this.items.length;
  }

  matchCount(): number {
    return this.matchPositions().length;
  }

  selectedVisibleOrdinal(): number | undefined {
    const rank = this.visiblePositions().indexOf(this.selectedIndex);
    return rank === -1 ? undefined : rank + 1;
  }

  turnOfSelection(): number | undefined {
    return this.items[this.selectedIndex]?.turnIndex;
  }

  render(width: number): string[] {
    if (this.items.length === 0) {
      return [styles.dim("no events")];
    }
    const visible = this.visiblePositions();
    if (visible.length === 0) {
      const hint =
        this.categoryFilter === undefined ? "" : ` (filter: ${[...this.categoryFilter].sort().join(", ")})`;
      return [styles.dim(`no events match${hint}`)];
    }
    this.syncWindow(visible);
    const windowPositions = visible.slice(this.windowStart, this.windowStart + this.maxVisible);
    const startPos = windowPositions[0]!;
    const endPos = windowPositions[windowPositions.length - 1]!;
    const showMarkers = this.turns.length >= 2;

    const lines: string[] = [];
    for (let position = startPos; position <= endPos; position += 1) {
      const turn = showMarkers ? this.turnByStartPosition.get(position) : undefined;
      // A turn whose items are ALL filtered out is an orphan marker -- skip it
      // rather than printing a "── turn N/M ──" separator with nothing under it.
      if (turn !== undefined && this.firstVisiblePositionInRange(turn.startItemIndex, turn.endItemIndex) !== undefined) {
        lines.push(truncateToWidth(this.renderMarker(turn), width));
      }
      if (this.isVisible(position)) {
        lines.push(truncateToWidth(this.renderRow(this.items[position]!, position === this.selectedIndex), width));
      }
    }
    return lines;
  }

  invalidate(): void {
    // Renders from plain state each call; nothing cached.
  }

  private applySelection(position: number): void {
    if (position === this.selectedIndex) {
      return;
    }
    this.selectedIndex = position;
    this.onSelectionChange?.(this.selectedItem());
  }

  /** Nudge `windowStart` (a rank within `visible`) the minimum amount to keep the selection's rank inside the window. */
  private syncWindow(visible: readonly number[]): void {
    const rank = visible.indexOf(this.selectedIndex);
    const effectiveRank = rank === -1 ? 0 : rank;
    const maxStart = Math.max(0, visible.length - this.maxVisible);
    if (effectiveRank < this.windowStart) {
      this.windowStart = effectiveRank;
    } else if (effectiveRank > this.windowStart + this.maxVisible - 1) {
      this.windowStart = effectiveRank - this.maxVisible + 1;
    }
    this.windowStart = Math.min(Math.max(this.windowStart, 0), maxStart);
  }

  private isVisible(position: number): boolean {
    const item = this.items[position];
    return item !== undefined && (this.categoryFilter === undefined || this.categoryFilter.has(item.category));
  }

  private visiblePositions(): number[] {
    const positions: number[] = [];
    for (let i = 0; i < this.items.length; i += 1) {
      if (this.isVisible(i)) {
        positions.push(i);
      }
    }
    return positions;
  }

  private firstVisiblePositionInRange(start: number, end: number): number | undefined {
    for (let position = start; position <= end; position += 1) {
      if (this.isVisible(position)) {
        return position;
      }
    }
    return undefined;
  }

  /** Nearest visible position to `position` (itself first, then out-and-out alternating, forward-tie-broken). */
  private nearestVisiblePosition(position: number): number | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    if (this.isVisible(position)) {
      return position;
    }
    for (let radius = 1; radius < this.items.length; radius += 1) {
      const forward = position + radius;
      if (forward < this.items.length && this.isVisible(forward)) {
        return forward;
      }
      const backward = position - radius;
      if (backward >= 0 && this.isVisible(backward)) {
        return backward;
      }
    }
    return undefined;
  }

  private itemMatchesQuery(item: ReplayTimelineItem): boolean {
    if (this.searchQuery === undefined) {
      return false;
    }
    const query = this.searchQuery.toLowerCase();
    return escapeTerminalControls(item.label).toLowerCase().includes(query)
      || escapeTerminalControls(item.summary).toLowerCase().includes(query);
  }

  private matchPositions(): number[] {
    if (this.searchQuery === undefined) {
      return [];
    }
    return this.visiblePositions().filter((position) => this.itemMatchesQuery(this.items[position]!));
  }

  private renderRow(item: ReplayTimelineItem, selected: boolean): string {
    const segments: string[] = [styles.dim(`#${String(item.index).padStart(3, "0")}`)];
    if (this.hasTimestamps) {
      const clock = formatClock(item.timestamp);
      if (clock.length > 0) {
        segments.push(styles.muted(clock));
      }
      if (item.deltaMs !== undefined) {
        segments.push(styles.dim(`+${formatDurationMs(item.deltaMs)}`));
      }
    }

    const color = categoryStyle(item.category);
    let labelPart = color(highlightMatches(escapeTerminalControls(item.label), this.searchQuery));
    if (selected) {
      labelPart = styles.bold(labelPart);
    }
    const glyph = rowGlyph(item);
    const glyphPart = glyph.length > 0 ? `${glyph} ` : "";

    const thinkingSuffix =
      item.category === "thinking" && item.contentChars !== undefined
        ? styles.dim(` (${formatThinkingStats(item.contentChars, item.timestamp, item.endTimestamp)})`)
        : "";
    const summaryPart = item.summary.length > 0
      ? ` — ${styles.muted(highlightMatches(escapeTerminalControls(item.summary), this.searchQuery))}`
      : "";

    const prefix = selected ? styles.accent("❯ ") : "  ";
    return `${prefix}${segments.join(" ")} ${glyphPart}${labelPart}${thinkingSuffix}${summaryPart}`;
  }

  private renderMarker(turn: TimelineTurn): string {
    const parts = [`turn ${turn.turnIndex + 1}/${this.turns.length}`];
    const clock = formatClock(turn.startedAt);
    if (clock.length > 0) {
      parts.push(clock);
    }
    if (turn.durationMs !== undefined) {
      parts.push(formatDurationMs(turn.durationMs));
    }
    parts.push(`∴ ${formatTokens(turn.thinkingChars)}`, `${turn.toolCalls} tools`);
    return styles.dim(`── ${parts.join(" · ")} ──`);
  }
}

/** `contentChars` formatted, plus ` · <duration>` when the item's own (endTimestamp - timestamp) span parses. */
function formatThinkingStats(contentChars: number, timestamp: string | undefined, endTimestamp: string | undefined): string {
  const chars = formatTokens(contentChars);
  if (timestamp === undefined || endTimestamp === undefined) {
    return chars;
  }
  const start = Date.parse(timestamp);
  const end = Date.parse(endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return chars;
  }
  return `${chars} · ${formatDurationMs(Math.max(0, end - start))}`;
}

/** Wrap case-insensitive `query` occurrences in `text` with an inverse-video style; applied BEFORE truncation so `truncateToWidth`'s ANSI-aware slicing handles the rest. */
function highlightMatches(text: string, query: string | undefined): string {
  if (query === undefined || query.length === 0) {
    return text;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerText.includes(lowerQuery)) {
    return text;
  }
  let result = "";
  let cursor = 0;
  for (;;) {
    const index = lowerText.indexOf(lowerQuery, cursor);
    if (index === -1) {
      result += text.slice(cursor);
      return result;
    }
    result += text.slice(cursor, index) + styles.inverse(text.slice(index, index + query.length));
    cursor = index + query.length;
  }
}

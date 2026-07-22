import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { SelectItem, TUI } from "@earendil-works/pi-tui";

import {
  listReplayRuns,
  readReplayRun,
  type ReplayRunDetail,
  type ReplayRunListItem,
  type ReplayTimelineItem,
} from "../../data/replay.js";
import { extractUsage, formatDateClock, formatDurationMs, formatTokens, formatUsd, previewValue } from "../format.js";
import { selectListTheme, styles } from "../theme.js";
import { EventTimelineList } from "../components/event-list.js";
import {
  buildDetailCell,
  buildHeadline,
  buildPayloadHeader,
  buildRawPayloadBody,
  buildStatusLine,
  CATEGORY_KEYS,
} from "./replay-detail.js";

export interface ReplayViewOptions {
  readonly tui: TUI;
}

/** `all` means "no source filter" -- see the `s` key cycle in `handleInput`. */
const ALL_SOURCE_FILTER = "all";
const SOURCE_FILTER_CYCLE: readonly string[] = [
  ALL_SOURCE_FILTER,
  "tui",
  "telegram",
  "slack",
  "cron",
  "webhook",
  "memory",
  "other",
];

type StatusFilter = "all" | "failed" | "succeeded";
const STATUS_FILTER_CYCLE: readonly StatusFilter[] = ["all", "failed", "succeeded"];

const LIST_HINT = "enter open · r refresh · s source · x status · esc back";

/** Preview length for a compacted `userInput` label (see {@link runLabelText}). */
const USER_INPUT_PREVIEW_MAX_CHARS = 40;

// Content-first labels (source-detail/userInput previews) run longer than the
// old `<conversationId>`-only label this column was originally tuned for (a
// fixed 46). Give SelectList a floor/ceiling instead of a fixed width so it
// shrinks to fit short labels (leaving the description room) and only grows
// toward the ceiling for genuinely long ones.
const LIST_PRIMARY_COLUMN_MIN_WIDTH = 20;
const LIST_PRIMARY_COLUMN_MAX_WIDTH = 72;

function nextInCycle<T>(cycle: readonly T[], current: T): T {
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length] ?? cycle[0]!;
}

function statusGlyph(status: ReplayRunListItem["status"]): string {
  if (status === "succeeded") {
    return styles.success("✓");
  }
  if (status === "cancelled" || status === "running") {
    return styles.warning("◌");
  }
  return styles.error("✗");
}

/**
 * Content-first label text (precedence: `sourceDetail` -- cron job id /
 * webhook endpoint name -- then a compacted `userInput` preview, then
 * `conversationId` as a last resort for old, pre-`source` artifacts).
 */
function runLabelText(run: ReplayRunListItem): string {
  if (run.sourceDetail !== undefined && run.sourceDetail.trim().length > 0) {
    return run.sourceDetail;
  }
  if (run.userInput !== undefined && run.userInput.trim().length > 0) {
    const compacted = previewValue(run.userInput.replace(/\s+/gu, " ").trim(), USER_INPUT_PREVIEW_MAX_CHARS);
    return `"${compacted}"`;
  }
  return run.conversationId;
}

/** Model shortened to its last path/colon segment, e.g. `pi:openai:gpt-5.5` -> `gpt-5.5`. */
function shortenModel(model: string): string {
  const segments = model.split(/[/:]/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? model;
}

function modelEffortSegment(run: ReplayRunListItem): string | undefined {
  const model = run.model === undefined ? undefined : shortenModel(run.model);
  if (model === undefined) {
    return run.effort === undefined ? undefined : `@${run.effort}`;
  }
  return run.effort === undefined ? model : `${model}@${run.effort}`;
}

function buildRunDescription(run: ReplayRunListItem): string {
  const segments: string[] = [formatDurationMs(run.durationMs), `${run.eventCount} ev`];
  const modelEffort = modelEffortSegment(run);
  if (modelEffort !== undefined) {
    segments.push(modelEffort);
  }
  const usage = extractUsage(run.usage, run.cost);
  if (usage !== undefined) {
    segments.push(`↑${formatTokens(usage.input ?? 0)} ↓${formatTokens(usage.output ?? 0)}`);
    if (usage.usd !== undefined) {
      segments.push(formatUsd(usage.usd));
    }
  }
  if (run.failureKind !== undefined) {
    segments.push(run.failureKind);
  }
  return segments.join(" · ");
}

/**
 * Recorded-run replay straight from the agent's artifact dir: run list →
 * debugger-style step-through of bounded event projections (thinking, tools,
 * telemetry, failover) from any channel. The reader's key-pattern pass ensures
 * non-numeric values under sensitive-looking object keys are redacted; numeric
 * values under matched keys are retained; retained free text is not
 * content-scanned.
 * Recorder-capped payload tails and RAM-buffered events lost to a crash cannot
 * be reconstructed here.
 */
export class ReplayView extends Container {
  readonly list: SelectList;
  private readonly options: ReplayViewOptions;
  private readonly header = new Text("", 1, 0);
  private readonly detail = new Container();
  private readonly detailHeadline = new Text("", 1, 0);
  private readonly detailStatus = new Text("", 1, 0);
  private readonly eventList = new EventTimelineList({ maxVisible: 16 });
  /** Selected-event pane: header + chat-style cell (+ raw JSON strip when expanded), rebuilt by {@link rebuildDetailPane}. */
  private readonly detailPane = new Container();
  private mode: "list" | "detail" = "list";
  private artifactDir: string | undefined;
  private runs: readonly ReplayRunListItem[] = [];
  private totalRuns = 0;
  private warnings: readonly string[] = [];
  private sourceFilter: string = ALL_SOURCE_FILTER;
  private statusFilter: StatusFilter = "all";

  // Detail-mode state. `categoryFilter` empty means "no filter" (all visible)
  // -- see setCategoryFilter/toggleCategory below for how that maps onto the
  // component's undefined-means-unfiltered convention.
  private currentReplay: ReplayRunDetail | undefined;
  private readonly categoryFilter = new Set<string>();
  private committedSearch: string | undefined;
  private searchInputOpen = false;
  private searchInputBuffer = "";
  private payloadExpanded = false;
  private selectedItem: ReplayTimelineItem | undefined;

  constructor(options: ReplayViewOptions) {
    super();
    this.options = options;
    this.list = new SelectList([], 14, selectListTheme, {
      minPrimaryColumnWidth: LIST_PRIMARY_COLUMN_MIN_WIDTH,
      maxPrimaryColumnWidth: LIST_PRIMARY_COLUMN_MAX_WIDTH,
    });
    this.list.onSelect = (item: SelectItem) => {
      void this.openRun(item.value);
    };
    this.detail.addChild(this.detailHeadline);
    this.detail.addChild(this.detailStatus);
    this.detail.addChild(this.eventList);
    this.detail.addChild(this.detailPane);
    this.eventList.onSelectionChange = (item) => {
      this.selectedItem = item;
      this.refreshPanes();
    };
    this.showList();
    // Self-initialize the empty-state header (no artifact dir until an
    // instance is selected).
    void this.refresh();
  }

  isInDetail(): boolean {
    return this.mode === "detail";
  }

  /**
   * Esc layering in detail mode: an open search input closes+clears first;
   * else a committed search clears; else an expanded payload pane collapses;
   * else return to the run list. Returns false only when already at the list
   * (so app-level esc fallthrough, e.g. switching views, still works).
   */
  back(): boolean {
    if (this.mode !== "detail") {
      return false;
    }
    if (this.searchInputOpen) {
      this.searchInputOpen = false;
      this.searchInputBuffer = "";
    } else if (this.committedSearch !== undefined) {
      this.committedSearch = undefined;
      this.eventList.setSearch(undefined);
    } else if (this.payloadExpanded) {
      this.payloadExpanded = false;
    } else {
      this.showList();
      this.options.tui.requestRender();
      return true;
    }
    this.refreshPanes();
    this.options.tui.requestRender();
    return true;
  }

  handleInput(data: string): void {
    if (this.mode === "list") {
      if (data === "r" || data === "R") {
        void this.refresh();
        return;
      }
      if (data === "s") {
        this.cycleSourceFilter();
        return;
      }
      if (data === "x") {
        this.cycleStatusFilter();
        return;
      }
      this.list.handleInput(data);
      return;
    }
    this.handleDetailInput(data);
  }

  setArtifactDir(artifactDir: string | undefined): void {
    this.artifactDir = artifactDir;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    // Snapshot: a rapid agent switch mid-read must not paint the previous
    // agent's runs into the new agent's list.
    const requestedDir = this.artifactDir;
    if (requestedDir === undefined) {
      this.runs = [];
      this.totalRuns = 0;
      this.warnings = [];
      this.header.setText(
        `${styles.bold("Run replay unavailable")}\n${styles.muted("The selected agent's manifest has no artifact dir.")}`,
      );
      this.syncListItems();
      this.showList();
      this.options.tui.requestRender();
      return;
    }
    try {
      const { runs, warnings, totalRuns } = await listReplayRuns(requestedDir, {
        ...(this.sourceFilter === ALL_SOURCE_FILTER ? {} : { sourceFilter: this.sourceFilter }),
      });
      if (this.artifactDir !== requestedDir) {
        return; // Superseded by a newer agent selection.
      }
      this.runs = runs;
      this.totalRuns = totalRuns;
      this.warnings = warnings;
      this.updateHeader();
    } catch (error) {
      if (this.artifactDir !== requestedDir) {
        return;
      }
      this.runs = [];
      this.totalRuns = 0;
      this.warnings = [];
      this.header.setText(styles.error(`Failed to read runs: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.syncListItems();
    if (this.mode === "list") {
      this.showList();
    }
    this.options.tui.requestRender();
  }

  /** Runs after the client-side status filter (source filtering already happened server-side, see `refresh`). */
  private filteredRuns(): readonly ReplayRunListItem[] {
    if (this.statusFilter === "all") {
      return this.runs;
    }
    // Strict match on the bucket's own status -- NOT "everything that isn't
    // succeeded" -- so a `running`/`cancelled` run lands in neither bucket
    // rather than being swept into "failed".
    return this.runs.filter((run) => run.status === this.statusFilter);
  }

  private updateHeader(): void {
    const shown = this.filteredRuns().length;
    const filterParts: string[] = [];
    if (this.sourceFilter !== ALL_SOURCE_FILTER) {
      filterParts.push(`source: ${this.sourceFilter}`);
    }
    if (this.statusFilter !== "all") {
      filterParts.push(`status: ${this.statusFilter}`);
    }
    const filterText = filterParts.length > 0 ? ` ${styles.dim(`· ${filterParts.join(" · ")}`)}` : "";
    const warningText = this.warnings.length > 0 ? `\n${styles.warning(this.warnings[0] ?? "")}` : "";
    this.header.setText(
      `${styles.bold(`Recorded runs (${shown}/${this.totalRuns})`)}${filterText} ${styles.dim(LIST_HINT)}${warningText}`,
    );
  }

  private cycleSourceFilter(): void {
    this.sourceFilter = nextInCycle(SOURCE_FILTER_CYCLE, this.sourceFilter);
    void this.refresh();
  }

  private cycleStatusFilter(): void {
    this.statusFilter = nextInCycle(STATUS_FILTER_CYCLE, this.statusFilter);
    this.updateHeader();
    this.syncListItems();
    this.options.tui.requestRender();
  }

  private syncListItems(): void {
    const items = this.filteredRuns().map((run): SelectItem => {
      const labelParts = [statusGlyph(run.status), formatDateClock(run.startedAt), `[${run.resolvedSource}]`, runLabelText(run)];
      return {
        value: run.runId,
        label: labelParts.filter((part) => part.length > 0).join(" "),
        description: buildRunDescription(run),
      };
    });
    (this.list as unknown as { items: SelectItem[] }).items = items;
    this.list.setFilter("");
    this.list.setSelectedIndex(0);
    this.list.invalidate();
  }

  private showList(): void {
    this.mode = "list";
    this.clear();
    this.addChild(this.header);
    this.addChild(this.list);
  }

  private async openRun(runId: string): Promise<void> {
    const requestedDir = this.artifactDir;
    if (requestedDir === undefined) {
      return;
    }
    const replay = await readReplayRun(requestedDir, runId, {
      ...(this.sourceFilter === "memory" ? { scope: "memory" } : {}),
    });
    if (this.artifactDir !== requestedDir) {
      return; // Superseded by a newer agent selection.
    }
    if (replay === undefined) {
      this.header.setText(styles.error(`Run ${runId} not found.`));
      this.options.tui.requestRender();
      return;
    }
    this.mode = "detail";
    this.clear();
    this.openDetail(replay);
    this.addChild(this.detail);
    this.options.tui.requestRender();
  }

  /** Reset all detail-mode state for a freshly opened run and populate the panes. */
  private openDetail(replay: ReplayRunDetail): void {
    this.currentReplay = replay;
    this.categoryFilter.clear();
    this.committedSearch = undefined;
    this.searchInputOpen = false;
    this.searchInputBuffer = "";
    this.payloadExpanded = false;
    this.detailHeadline.setText(buildHeadline(replay));
    this.eventList.setCategoryFilter(undefined);
    this.eventList.setSearch(undefined);
    // Triggers onSelectionChange synchronously, which calls refreshPanes().
    this.eventList.setItems(replay.timeline, replay.turns);
  }

  private handleDetailInput(data: string): void {
    if (this.searchInputOpen) {
      this.handleSearchInputKey(data);
      this.refreshPanes();
      this.options.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.eventList.handleInput(data);
    } else if (data === "g") {
      this.eventList.moveToFirst();
    } else if (data === "G") {
      this.eventList.moveToLast();
    } else if (data === "[") {
      this.eventList.moveToTurn(-1);
    } else if (data === "]") {
      this.eventList.moveToTurn(1);
    } else if (data === "a") {
      this.categoryFilter.clear();
      this.eventList.setCategoryFilter(undefined);
    } else if (CATEGORY_KEYS[data] !== undefined) {
      this.toggleCategory(CATEGORY_KEYS[data]!);
    } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.payloadExpanded = !this.payloadExpanded;
    } else if (data === "/") {
      this.searchInputOpen = true;
      this.searchInputBuffer = "";
    } else if (data === "n") {
      this.eventList.moveToMatch(1);
    } else if (data === "N") {
      this.eventList.moveToMatch(-1);
    } else {
      return;
    }
    this.refreshPanes();
    this.options.tui.requestRender();
  }

  private toggleCategory(category: string): void {
    if (this.categoryFilter.has(category)) {
      this.categoryFilter.delete(category);
    } else {
      this.categoryFilter.add(category);
    }
    this.eventList.setCategoryFilter(this.categoryFilter.size === 0 ? undefined : new Set(this.categoryFilter));
  }

  private handleSearchInputKey(data: string): void {
    if (matchesKey(data, "enter")) {
      this.commitSearch(this.searchInputBuffer);
    } else if (matchesKey(data, "backspace")) {
      this.searchInputBuffer = this.searchInputBuffer.slice(0, -1);
    } else {
      // Esc never reaches here: app.ts's global input listener intercepts it
      // first and calls back() (which closes the search input as its first
      // layer) before the key would otherwise be forwarded to this view.
      const printable = data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined;
      if (printable !== undefined) {
        this.searchInputBuffer += printable;
      }
    }
  }

  private commitSearch(query: string): void {
    this.searchInputOpen = false;
    const trimmed = query.trim();
    this.committedSearch = trimmed.length > 0 ? trimmed : undefined;
    this.eventList.setSearch(this.committedSearch);
    if (this.committedSearch !== undefined) {
      this.eventList.moveToMatch(1);
    }
  }

  /** Recompute the status line + selected-event payload pane from current state. */
  private refreshPanes(): void {
    const turns = this.currentReplay?.turns ?? [];
    this.detailStatus.setText(
      buildStatusLine({
        ordinal: this.eventList.selectedVisibleOrdinal(),
        visibleCount: this.eventList.visibleCount(),
        turnIndex: this.eventList.turnOfSelection(),
        turnCount: turns.length,
        categoryFilter: this.categoryFilter,
        searchInputOpen: this.searchInputOpen,
        searchInputBuffer: this.searchInputBuffer,
        committedSearch: this.committedSearch,
        matchCount: this.eventList.matchCount(),
      }),
    );
    // A category filter can leave zero rows visible while `this.selectedItem`
    // still holds the last (now hidden) selection -- eventList remembers that
    // index so widening the filter again snaps back to it, but the payload
    // pane must not show a stale item's content while nothing is visible.
    const visibleSelection = this.eventList.visibleCount() === 0 ? undefined : this.selectedItem;
    this.rebuildDetailPane(visibleSelection);
  }

  /**
   * Rebuild the selected-event pane from scratch: header, then EITHER a
   * chat-style cell (thinking/tool/message/error/notice -- reusing live
   * chat's own components, see buildDetailCell) OR, for generic
   * runtime/telemetry items and tool-shaped-but-blockless items, the unchanged
   * raw-JSON body. Session boundaries and runtime warnings use notice cells.
   * Expanding (`enter`) appends the raw JSON below a chat-style cell too, so
   * the underlying event is always one keystroke away.
   */
  private rebuildDetailPane(item: ReplayTimelineItem | undefined): void {
    this.detailPane.clear();
    if (item === undefined) {
      return;
    }
    this.detailPane.addChild(new Text(buildPayloadHeader(item), 1, 0));
    this.detailPane.addChild(new Text("", 1, 0));
    const cell = buildDetailCell(item, this.currentReplay?.timeline ?? [], this.currentReplay?.detail.events ?? []);
    if (cell === undefined) {
      this.detailPane.addChild(new Text(buildRawPayloadBody(item, this.payloadExpanded), 1, 0));
      return;
    }
    this.detailPane.addChild(cell);
    if (this.payloadExpanded) {
      this.detailPane.addChild(new Text(buildRawPayloadBody(item, true), 1, 0));
    }
  }
}

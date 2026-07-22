import { Container } from "@earendil-works/pi-tui";
import type { AgentMessageStream, AgentStreamEvent } from "@mono-agent/agent-contracts";

import { AssistantCell, NoticeCell, ThinkingCell } from "./components/transcript-cells.js";
import { ToolPanel } from "./components/tool-panel.js";
import type { StatusBar } from "./components/status-bar.js";
import { sessionBoundaryNotice } from "./session-boundary.js";

export interface TurnPresenterOptions {
  /** The transcript container this turn appends its cells into. */
  readonly transcript: Container;
  readonly statusBar: StatusBar;
  readonly requestRender: () => void;
  /** Coalescing window for streamed markdown re-parses; 0 disables (tests). */
  readonly flushIntervalMs?: number;
  /** New thinking cells start expanded when the app-level toggle is on. */
  readonly thinkingExpanded?: () => boolean;
  /** Injectable clock for thinking-duration assertions; defaults to Date.now. */
  readonly now?: () => number;
  /**
   * The model override the operator requested for this turn (via `/model`), if
   * any. Used only to notice when a run reports `overridden: false` despite a
   * requested override — i.e. the override was ignored (old agent) or invalid.
   */
  readonly requestedModelOverride?: string;
}

const DEFAULT_FLUSH_MS = 50;

/**
 * Implements AgentMessageStream against pi-tui components: every stream
 * callback mutates transcript cells and requests a coalesced redraw. Identical
 * for in-process and remote responders — the wire protocol replays the same
 * callbacks.
 *
 * Cell ordering mirrors the model's own block order: thinking and tool cells
 * are appended as they arrive; the assistant text cell is (re)opened after
 * each tool call so interleaved text→tool→text turns read chronologically.
 */
export class TurnPresenter implements AgentMessageStream {
  private readonly options: TurnPresenterOptions;
  private assistantCell: AssistantCell | undefined;
  /** Every assistant cell this turn opened, oldest first (segments split at tool calls). */
  private readonly assistantCells: AssistantCell[] = [];
  /** Concatenated text of sealed segments (everything before the live buffer). */
  private sealedText = "";
  private thinkingCell: ThinkingCell | undefined;
  /** Running total across the whole turn, even across multiple thinking cells. */
  private thinkingChars = 0;
  /** Wall-clock time of this turn's first thought; undefined until then. */
  private firstThoughtTime: number | undefined;
  private readonly toolPanels = new Map<string, ToolPanel>();
  private buffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;

  constructor(options: TurnPresenterOptions) {
    this.options = options;
  }

  async append(delta: string): Promise<void> {
    this.buffer += delta;
    this.scheduleFlush();
  }

  async replace(text: string): Promise<void> {
    // Contract: replaces the whole message so far — collapse to one cell.
    this.reconcileTo(text);
    this.options.requestRender();
  }

  async status(text: string): Promise<void> {
    this.options.statusBar.setEphemeral(text);
    this.options.requestRender();
  }

  async event(event: AgentStreamEvent): Promise<void> {
    switch (event.type) {
      case "assistant_thought": {
        this.thinkingCellFor().append(event.text);
        this.thinkingChars += event.text.length;
        if (this.firstThoughtTime === undefined) {
          this.firstThoughtTime = this.nowMs();
        }
        this.options.statusBar.setThinking({ chars: this.thinkingChars, active: true });
        break;
      }
      case "tool_call_started": {
        this.sealStreamingCells();
        const panel = new ToolPanel(event.id, event.name, event.arguments);
        this.toolPanels.set(event.id, panel);
        this.options.transcript.addChild(panel);
        break;
      }
      case "tool_call_progress": {
        this.toolPanels.get(event.id)?.setProgress(event.partialResult);
        break;
      }
      case "tool_call_completed": {
        const panel = this.toolPanels.get(event.id);
        if (panel !== undefined) {
          panel.complete({
            ...(event.isError === undefined ? {} : { isError: event.isError }),
            ...(event.content === undefined ? {} : { content: event.content }),
            ...(event.executionMs === undefined ? {} : { executionMs: event.executionMs }),
            ...(event.metadata?.truncated === true ? { truncated: true } : {}),
          });
        }
        break;
      }
      case "usage_update": {
        this.options.statusBar.setUsage(event.tokens, event.cumulativeUsd, event.model);
        break;
      }
      case "provider_status": {
        if (event.kind === "request_started") {
          // No ephemeral status here (removed per user feedback: "too long and
          // awkward, no need for that") — the ChatView loader already
          // indicates in-flight activity.
        } else if (event.kind === "request_completed") {
          this.options.statusBar.setEphemeral("");
        } else if (event.kind === "failover_started") {
          const note = `failover ${event.from ?? "?"} → ${event.to ?? "?"}`;
          this.options.statusBar.setProviderNote(note);
          this.options.transcript.addChild(new NoticeCell(note, "warning"));
        } else {
          this.options.statusBar.setProviderNote(
            event.model === undefined ? "" : `answered by ${event.model} (failover)`,
          );
        }
        break;
      }
      case "runtime_warning": {
        this.options.transcript.addChild(new NoticeCell(event.message, "warning"));
        break;
      }
      case "memory_recalled": {
        const size = event.bytes === undefined ? "" : ` ${(event.bytes / 1024).toFixed(1)}KB`;
        this.options.statusBar.setEphemeral(`⌁ memory recalled${size}`);
        break;
      }
      case "runtime_telemetry": {
        // Cache/capability/latency details stay off the live transcript; the
        // replay view shows them from run artifacts. run_config is the one
        // exception: it feeds the persistent status-bar model/effort chrome.
        const sessionBoundary = sessionBoundaryNotice(event);
        if (sessionBoundary !== undefined) {
          this.sealStreamingCells();
          this.options.transcript.addChild(new NoticeCell(sessionBoundary, "info"));
        } else if (event.kind === "run_config") {
          const data = event.data;
          if (typeof data?.effort === "string") {
            this.options.statusBar.setEffort(data.effort);
          }
          if (typeof data?.model === "string") {
            this.options.statusBar.setModel(data.model);
          }
          // `overridden` is the harness's authoritative "an override was actually
          // applied" — reconcile the status-bar tag with it so the marker never
          // lies (e.g. an ignored or invalid override falling back to the default).
          if (typeof data?.overridden === "boolean") {
            this.options.statusBar.setModelOverridden(data.overridden);
            if (!data.overridden && this.options.requestedModelOverride !== undefined) {
              const ranOn = typeof data.model === "string" ? ` — ran on ${data.model}` : "";
              this.options.transcript.addChild(
                new NoticeCell(`model override not applied${ranOn}`, "warning"),
              );
            }
          }
        }
        break;
      }
      default: {
        // Unknown event from a newer agent: ignore (forward compatibility).
        break;
      }
    }
    this.options.requestRender();
  }

  async finish(finalText?: string): Promise<void> {
    this.finished = true;
    // Deliberate: an EMPTY finalText keeps whatever streamed, same as absent.
    // This is an operator console — the streamed deltas are real model output,
    // and blanking them on an empty-normalized final answer would hide exactly
    // what the operator came to see. Channels render a placeholder instead
    // (DEFAULT_EMPTY_FINAL_TEXT); here the transcript already tells the story.
    if (finalText === undefined || finalText.length === 0) {
      this.flushText();
      return;
    }
    // finalText is the WHOLE answer; streamed segments may already cover it.
    const streamedTotal = this.sealedText + this.buffer;
    if (normalizeForCompare(finalText) === normalizeForCompare(streamedTotal)) {
      this.flushText();
    } else if (finalText.startsWith(this.sealedText) && this.sealedText.length > 0) {
      // Streamed prefix matches: only the live tail needs correcting.
      this.buffer = finalText.slice(this.sealedText.length);
      this.flushText();
    } else {
      // Divergence (or nothing streamed): show finalText once, not twice.
      this.reconcileTo(finalText);
    }
    this.options.requestRender();
  }

  /** The turn is over (success, error, or cancel): stop timers, seal cells. */
  settle(): void {
    this.finished = true;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushText();
    this.sealThinking();
  }

  assistantText(): string {
    return this.sealedText + this.buffer;
  }

  /** Collapse all assistant segments into the last cell holding exactly `text`. */
  private reconcileTo(text: string): void {
    const last = this.assistantCellFor();
    for (const cell of this.assistantCells) {
      if (cell !== last) {
        this.options.transcript.removeChild(cell);
      }
    }
    this.assistantCells.length = 0;
    this.assistantCells.push(last);
    this.sealedText = "";
    this.buffer = text;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    last.setText(text);
  }

  private scheduleFlush(): void {
    const interval = this.options.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    if (interval <= 0 || this.finished) {
      this.flushText();
      return;
    }
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushText();
    }, interval);
    // Never hold the process open for a pending redraw.
    this.flushTimer.unref?.();
  }

  private flushText(): void {
    if (this.buffer.length > 0) {
      this.assistantCellFor().setText(this.buffer);
    }
    this.options.requestRender();
  }

  private assistantCellFor(): AssistantCell {
    if (this.assistantCell === undefined) {
      this.sealThinking();
      this.assistantCell = new AssistantCell();
      this.assistantCells.push(this.assistantCell);
      this.options.transcript.addChild(this.assistantCell);
    }
    return this.assistantCell;
  }

  private thinkingCellFor(): ThinkingCell {
    if (this.thinkingCell === undefined) {
      this.thinkingCell = new ThinkingCell(this.options.thinkingExpanded?.() ?? false);
      this.options.transcript.addChild(this.thinkingCell);
    }
    return this.thinkingCell;
  }

  /**
   * A tool call interrupts the streaming text/thinking cells: whatever comes
   * next starts fresh cells so the transcript stays chronological.
   */
  private sealStreamingCells(): void {
    this.flushTextImmediate();
    this.sealThinking();
    this.assistantCell = undefined;
    this.sealedText += this.buffer;
    this.buffer = "";
  }

  private flushTextImmediate(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.buffer.length > 0) {
      this.assistantCellFor().setText(this.buffer);
    }
  }

  private sealThinking(): void {
    if (this.thinkingCell !== undefined) {
      this.thinkingCell.active = false;
      if (this.firstThoughtTime !== undefined) {
        const durationMs = this.nowMs() - this.firstThoughtTime;
        this.thinkingCell.setDurationMs(durationMs);
        this.options.statusBar.setThinking({ chars: this.thinkingChars, durationMs, active: false });
      }
      this.thinkingCell = undefined;
    }
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

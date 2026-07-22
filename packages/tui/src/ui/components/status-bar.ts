import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { formatDurationMs, formatTokens, formatUsd } from "../format.js";
import { styles } from "../theme.js";

export interface StatusBarUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export interface StatusBarThinkingStats {
  readonly chars: number;
  readonly durationMs?: number;
  readonly active: boolean;
}

/**
 * Bottom chrome: connection identity on the left, live turn telemetry on the
 * right. Ephemeral text (stream status/hints) overrides the telemetry segment
 * until the next update.
 */
export class StatusBar implements Component {
  private identity = "";
  private model: string | undefined;
  private modelOverridden = false;
  private effort: string | undefined;
  private effortOverridden = false;
  private usage: StatusBarUsage | undefined;
  private cumulativeUsd: number | undefined;
  private thinking: StatusBarThinkingStats | undefined;
  private providerNote = "";
  private ephemeral = "";
  private hint = "tab views · esc cancel · ctrl+c quit · /help";

  setIdentity(identity: string): void {
    this.identity = identity;
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  /**
   * Marks the model segment as a session override (renders a trailing
   * `(override)` tag). Additive to {@link setModel} — the model string itself is
   * unchanged; this only toggles the annotation.
   */
  setModelOverridden(overridden: boolean): void {
    this.modelOverridden = overridden;
  }

  /** Persists across turns; only replaced by another setEffort call. */
  setEffort(effort: string | undefined): void {
    this.effort = effort;
  }

  /**
   * Marks the effort segment as a session override (renders a trailing
   * `(override)` tag). Additive to {@link setEffort} — the effort string itself
   * is unchanged; this only toggles the annotation. Unlike the model override
   * (reconciled against the harness's authoritative `run_config.overridden`),
   * this is driven by local intent alone: the model-aware picker already
   * prevents choosing an unsupported level, and `run_config.overridden` is a
   * combined model-or-effort flag that can't be split back out for effort.
   */
  setEffortOverridden(overridden: boolean): void {
    this.effortOverridden = overridden;
  }

  /**
   * Per-turn thinking telemetry. Stays visible after the turn ends (`active:
   * false`) until the next turn's first thought replaces it; `undefined`
   * clears the segment entirely.
   */
  setThinking(stats: StatusBarThinkingStats | undefined): void {
    this.thinking = stats;
  }

  setUsage(usage: StatusBarUsage | undefined, cumulativeUsd: number | undefined, model?: string): void {
    if (usage !== undefined) {
      this.usage = usage;
    }
    if (cumulativeUsd !== undefined) {
      this.cumulativeUsd = cumulativeUsd;
    }
    if (model !== undefined) {
      this.model = model;
    }
  }

  setProviderNote(note: string): void {
    this.providerNote = note;
  }

  setEphemeral(text: string): void {
    this.ephemeral = text;
  }

  setHint(hint: string): void {
    this.hint = hint;
  }

  resetTurn(): void {
    this.providerNote = "";
    this.ephemeral = "";
  }

  render(width: number): string[] {
    const segments: string[] = [];
    if (this.identity.length > 0) {
      segments.push(styles.accent(this.identity));
    }
    if (this.model !== undefined && this.model.length > 0) {
      segments.push(styles.muted(this.modelOverridden ? `${this.model} (override)` : this.model));
    }
    if (this.effort !== undefined && this.effort.length > 0) {
      segments.push(styles.muted(this.effortOverridden ? `effort:${this.effort} (override)` : `effort:${this.effort}`));
    }
    if (this.usage !== undefined) {
      const cache = this.usage.cacheRead > 0 ? ` (cache ${formatTokens(this.usage.cacheRead)})` : "";
      segments.push(styles.muted(`↑${formatTokens(this.usage.input)} ↓${formatTokens(this.usage.output)}${cache}`));
    }
    if (this.cumulativeUsd !== undefined && this.cumulativeUsd > 0) {
      segments.push(styles.muted(formatUsd(this.cumulativeUsd)));
    }
    if (this.thinking !== undefined) {
      segments.push(this.renderThinkingSegment(this.thinking));
    }
    if (this.providerNote.length > 0) {
      segments.push(styles.warning(this.providerNote));
    }
    if (this.ephemeral.length > 0) {
      segments.push(styles.dim(this.ephemeral));
    }
    segments.push(styles.dim(this.hint));
    return ["", ...new Text(segments.join(styles.dim(" · ")), 1, 0).render(width)];
  }

  invalidate(): void {
    // Stateless render.
  }

  private renderThinkingSegment(stats: StatusBarThinkingStats): string {
    if (stats.active) {
      return styles.thinking(`∴ thinking ${formatTokens(stats.chars)}`);
    }
    // Negative durations (clock skew, injected test clocks) are omitted rather
    // than rendered as a nonsensical negative time.
    const durationPart =
      stats.durationMs !== undefined && stats.durationMs >= 0 ? ` · ${formatDurationMs(stats.durationMs)}` : "";
    return styles.thinking(`∴ ${formatTokens(stats.chars)} chars${durationPart}`);
  }
}

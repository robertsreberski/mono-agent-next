import { Markdown, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { formatDurationMs, formatTokens } from "../format.js";
import { dimMarkdownTheme, markdownTheme, styles } from "../theme.js";

/** A user-authored message. */
export class UserCell implements Component {
  private readonly text: Text;

  constructor(text: string) {
    this.text = new Text(`${styles.bold(styles.user("you"))} ${text}`, 1, 0);
  }

  render(width: number): string[] {
    return ["", ...this.text.render(width)];
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

/** Streaming assistant markdown. */
export class AssistantCell implements Component {
  private readonly markdown = new Markdown("", 1, 0, markdownTheme);
  private textValue = "";

  setText(text: string): void {
    this.textValue = text;
    this.markdown.setText(text);
  }

  getText(): string {
    return this.textValue;
  }

  isEmpty(): boolean {
    return this.textValue.length === 0;
  }

  render(width: number): string[] {
    if (this.isEmpty()) {
      return [];
    }
    return ["", ...this.markdown.render(width)];
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

/**
 * Reasoning block. Collapsed by default to a one-line summary; Ctrl+T (or
 * replay's expand) shows the full text, dim-italic so it never reads as the
 * answer.
 */
export class ThinkingCell implements Component {
  private textValue = "";
  private expandedValue: boolean;
  private durationMsValue: number | undefined;
  private readonly body = new Markdown("", 3, 0, dimMarkdownTheme, { color: styles.muted, italic: true });
  /** Set while the turn is still streaming into this cell. */
  active = true;

  constructor(expanded = false) {
    this.expandedValue = expanded;
  }

  append(delta: string): void {
    this.textValue += delta;
    this.body.setText(this.textValue);
  }

  getText(): string {
    return this.textValue;
  }

  isEmpty(): boolean {
    return this.textValue.trim().length === 0;
  }

  setExpanded(expanded: boolean): void {
    this.expandedValue = expanded;
  }

  isExpanded(): boolean {
    return this.expandedValue;
  }

  /** Stamped once this cell is sealed (turn's first thought → this seal). */
  setDurationMs(ms: number): void {
    this.durationMsValue = ms;
  }

  render(width: number): string[] {
    if (this.isEmpty()) {
      return [];
    }
    const chars = this.textValue.length;
    const marker = this.active ? "∴ thinking…" : "∴ thought";
    const durationPart =
      this.durationMsValue !== undefined && this.durationMsValue >= 0
        ? ` · ${formatDurationMs(this.durationMsValue)}`
        : "";
    const header = new Text(
      styles.thinking(
        `${marker} (${formatTokens(chars)} chars${durationPart}${this.expandedValue ? "" : " — ctrl+t expands"})`,
      ),
      1,
      0,
    );
    if (!this.expandedValue) {
      return ["", ...header.render(width)];
    }
    return ["", ...header.render(width), ...this.body.render(width)];
  }

  invalidate(): void {
    this.body.invalidate();
  }
}

/** Runtime warning / failover / neutral notice. */
export class NoticeCell implements Component {
  private readonly text: Text;

  constructor(message: string, kind: "info" | "warning" | "error" = "warning") {
    const style = kind === "error" ? styles.error : kind === "warning" ? styles.warning : styles.info;
    const prefix = kind === "info" ? "i" : "⚠";
    this.text = new Text(style(`${prefix} ${message}`), 1, 0);
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

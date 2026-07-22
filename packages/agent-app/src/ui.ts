import process from "node:process";

import type { ValidationStatus } from "./doctor.js";

/**
 * Tiny zero-dependency terminal styling layer for the CLI. Every helper returns
 * a plain string, so callers can keep writing through `process.stdout.write` or
 * the injected `deps.stdout`/`deps.stderr` sinks in background.ts. Color is a
 * single global decision keyed on the REAL process stdout (see
 * {@link computeColorEnabled}); when it is off — piped output, `NO_COLOR`, or a
 * non-TTY test harness — every styling helper degrades to plain ASCII so logs
 * and test assertions stay greppable.
 */

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
  gray: "[90m",
} as const;

/**
 * Decide whether ANSI color should be emitted. `NO_COLOR` (any value) always
 * wins per the no-color.org convention; `FORCE_COLOR` forces the decision when
 * set to a recognized truthy/falsy value; otherwise color follows the TTY-ness
 * of the stream. Pure and env-injected so it is trivially testable.
 */
export function computeColorEnabled(
  env: Record<string, string | undefined>,
  isTty: boolean | undefined,
): boolean {
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  const force = env.FORCE_COLOR;
  if (force === "1" || force === "true") {
    return true;
  }
  if (force === "0" || force === "false") {
    return false;
  }
  return Boolean(isTty);
}

const colorEnabled = computeColorEnabled(process.env, process.stdout.isTTY);

export function isColorEnabled(): boolean {
  return colorEnabled;
}

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${ANSI.reset}` : text;
}

/** Color/weight helpers. Each is the identity function when color is disabled. */
export const style = {
  bold: (text: string): string => paint(ANSI.bold, text),
  dim: (text: string): string => paint(ANSI.dim, text),
  red: (text: string): string => paint(ANSI.red, text),
  green: (text: string): string => paint(ANSI.green, text),
  yellow: (text: string): string => paint(ANSI.yellow, text),
  cyan: (text: string): string => paint(ANSI.cyan, text),
  gray: (text: string): string => paint(ANSI.gray, text),
} as const;

interface BadgeSpec {
  readonly glyph: string;
  readonly paint: (text: string) => string;
  /** Stable, width-equal ASCII tag used when color is disabled. */
  readonly plain: string;
}

const BADGES: Record<ValidationStatus, BadgeSpec> = {
  ok: { glyph: "✓", paint: style.green, plain: "[ok]   " },
  waiting: { glyph: "⚠", paint: style.yellow, plain: "[wait] " },
  disabled: { glyph: "○", paint: style.dim, plain: "[off]  " },
  error: { glyph: "✗", paint: style.red, plain: "[error]" },
};

/**
 * Render a status badge as a fixed-width prefix (badge + trailing space). With
 * color on it is a green/yellow/dim/red glyph; with color off it falls back to
 * an equal-width ASCII tag so columns still line up in plain output.
 */
export function badge(status: ValidationStatus): string {
  const spec = BADGES[status];
  return colorEnabled ? `${spec.paint(spec.glyph)} ` : `${spec.plain} `;
}

/**
 * Render aligned `label  value` rows: labels are padded to the widest label so
 * values line up, replacing the hand-tuned `padEnd` blocks. `indent` prefixes
 * every row with that many spaces (used to nest rows under a section rule).
 * Returns one string with a trailing newline per row (empty when there are no
 * rows).
 */
export function keyValue(
  rows: ReadonlyArray<readonly [label: string, value: string]>,
  indent = 0,
): string {
  if (rows.length === 0) {
    return "";
  }
  const pad = " ".repeat(indent);
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows
    .map(([label, value]) => `${pad}${style.gray(label.padEnd(width))}  ${value}\n`)
    .join("");
}

const RULE_FALLBACK_WIDTH = 44;
const RULE_MAX_WIDTH = 72;

/**
 * A horizontal section divider, optionally labeled — `── instance ────────`.
 * Width tracks the terminal (read at call time so resizes are honored), capped
 * for readability and falling back to a fixed width when stdout is not a TTY.
 * Rendered dim/gray (identity when color is off); the label appears verbatim so
 * it stays greppable. Always ends with a newline.
 */
export function rule(label?: string): string {
  const width = Math.min(process.stdout.columns ?? RULE_FALLBACK_WIDTH, RULE_MAX_WIDTH);
  if (label === undefined) {
    return `${style.gray("─".repeat(width))}\n`;
  }
  const prefix = `── ${label} `;
  const fill = Math.max(0, width - prefix.length);
  return `${style.gray(`${prefix}${"─".repeat(fill)}`)}\n`;
}

/** Badge for a channel status *kind* string (running/waiting…/disabled/error). */
export function channelBadge(kind: string): string {
  if (kind === "running") {
    return badge("ok");
  }
  if (kind.startsWith("waiting")) {
    return badge("waiting");
  }
  if (kind === "disabled" || kind === "stopped") {
    return badge("disabled");
  }
  if (kind === "degraded") {
    // Still serving, transport self-recovering — a warning, not an error.
    return badge("waiting");
  }
  if (/error|fail|crash/u.test(kind)) {
    return badge("error");
  }
  return badge("waiting");
}

/** Badge for a trace-source health word (running/stale/stopped/…). */
export function healthBadge(health: string): string {
  switch (health) {
    case "running":
      return badge("ok");
    case "stale":
      return badge("waiting");
    case "stopped":
      return badge("disabled");
    default:
      return badge("error");
  }
}

/** A bold/cyan section heading with a trailing newline. */
export function heading(text: string): string {
  return `${style.bold(style.cyan(text))}\n`;
}

/** The CLI title block: bold title plus an optional dim subtitle. */
export function banner(title: string, subtitle?: string): string {
  const head = style.bold(style.cyan(title));
  return subtitle === undefined ? `${head}\n` : `${head} ${style.dim(`— ${subtitle}`)}\n`;
}

/** A red error line (✗ prefix) with a trailing newline — write to stderr. */
export function errorLine(message: string): string {
  return `${style.red(`✗ ${message}`)}\n`;
}

/** A dim hint line (→ prefix) with a trailing newline. */
export function hint(message: string): string {
  return `${style.dim(`→ ${message}`)}\n`;
}

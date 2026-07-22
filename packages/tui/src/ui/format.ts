/** Small pure formatters shared by the chat, replay, and status-bar surfaces. */

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

export function formatUsd(usd: number): string {
  return usd >= 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function formatDurationMs(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    // Floor, not round: rounding 59.8s would render an impossible "1m 60s".
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  }
  if (ms >= 1_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/** Render an unknown payload (tool args/results) as compact single-or-multi-line text. */
export function previewValue(value: unknown, maxChars = 600): string {
  if (value === undefined) {
    return "";
  }
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, value !== null && typeof value === "object" ? 1 : undefined) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.trimEnd();
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}…`;
  }
  return text;
}

export function lastLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(lines.length - maxLines).join("\n");
}

export function formatClock(iso: string | undefined): string {
  if (iso === undefined) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

/**
 * `MM-DD HH:MM` in local time -- unlike {@link formatClock} (time only), this
 * carries the date too: a run list spans days, and a bare clock reading is
 * ambiguous once results run past midnight.
 */
export function formatDateClock(iso: string | undefined): string {
  if (iso === undefined) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Token/cost numbers pulled out of a run summary's opaque `usage`/`cost` fields. */
export interface ExtractedUsage {
  readonly input?: number;
  readonly output?: number;
  readonly usd?: number;
}

/**
 * Provider-shape-agnostic extraction shared by the replay detail headline
 * (`usageLine`) and the run list description: `usage`/`cost` are recorded
 * verbatim from whatever the runtime/provider handed back, so field names
 * vary (`input` vs `inputTokens` vs `input_tokens`, `totalUsd` vs `usd`).
 * Returns undefined when no token counts are present at all.
 */
export function extractUsage(usage: unknown, cost: unknown): ExtractedUsage | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const input = numberOrUndefined(record.input ?? record.inputTokens ?? record.input_tokens);
  const output = numberOrUndefined(record.output ?? record.outputTokens ?? record.output_tokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  const usd = numberOrUndefined(
    typeof cost === "object" && cost !== null
      ? ((cost as Record<string, unknown>).totalUsd ?? (cost as Record<string, unknown>).usd)
      : cost,
  );
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(usd === undefined ? {} : { usd }),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CONVERSATION_ID_PREFIX_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["telegram:", "telegram"],
  ["slack:", "slack"],
  ["cron:", "cron"],
  ["webhook:", "webhook"],
  ["memory:", "memory"],
  ["a2a:", "a2a"],
  ["openai-api:", "openai-api"],
  ["openai:", "openai-api"],
  ["tui:", "tui"],
];

/**
 * Fallback derivation of a run's `source` from its `conversationId` prefix, for
 * summaries recorded before {@link JsonlRunRecorderOptions.source} existed (or
 * from any recorder that didn't supply it). Callers (e.g. the TUI run list)
 * should prefer a persisted `RunSummary.source`/`RecordedRunListItem.source`
 * and only fall back to this when it is absent — this helper is NOT applied
 * automatically by the reader.
 */
export function deriveRunSource(conversationId: string): string {
  if (conversationId === "tui-local") {
    return "tui";
  }
  for (const [prefix, source] of CONVERSATION_ID_PREFIX_SOURCES) {
    if (conversationId.startsWith(prefix)) {
      return source;
    }
  }
  return "other";
}

/**
 * Render one channel-status summary value for a human-readable status line.
 *
 * Channel summaries are open `Record<string, unknown>` maps whose values may be
 * nested objects/arrays (e.g. the webhook summary's `invokeUrls` map). A bare
 * `String()` renders those as the useless `[object Object]` — the E4 bug that
 * surfaced on the `status` line AND, independently, on the backgrounded `start`
 * instance summary. Every code path that interpolates a channel fact must route
 * through this one formatter so no output path can regress to `[object Object]`.
 */
export function formatChannelFactValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatChannelFactValue).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return "{}";
  }
  return `{${entries.map(([key, inner]) => `${key}: ${formatChannelFactValue(inner)}`).join(", ")}}`;
}

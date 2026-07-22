/**
 * Code-point-safe text helpers shared by chat-style communication adapters,
 * which had each copied the same chunker, tail preview, and trailing
 * normalizer. Pure and transport-agnostic.
 */

/** Default per-message character budget for chat transports. */
export const DEFAULT_MAX_MESSAGE_CHARS = 3_800;

/** Default placeholder used when a finished response has no text. */
export const DEFAULT_EMPTY_FINAL_TEXT = "No response text was returned.";

/** Trim trailing whitespace, falling back to a placeholder when empty. */
export function normalizeTrailing(text: string, fallback: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Split text into chunks of at most `maxChars` Unicode code points, so
 * multi-byte characters are never cut in half.
 */
export function splitTextByCodePoints(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer.");
  }
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += maxChars) {
    chunks.push(characters.slice(index, index + maxChars).join(""));
  }
  return chunks;
}

/**
 * Build a bounded "tail" preview for streaming edits: when text exceeds
 * `maxChars`, show a `prefix` marker followed by the most recent code points.
 */
export function buildStreamingTailPreview(
  text: string,
  maxChars: number,
  prefix = "...\n",
): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return text;
  }
  const available = Math.max(1, maxChars - Array.from(prefix).length);
  return `${prefix}${characters.slice(-available).join("")}`;
}

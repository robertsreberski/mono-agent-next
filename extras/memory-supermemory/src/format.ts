import type { MemoryBlock } from "@mono-agent/agent-contracts";

import type { SupermemoryHit } from "./client.js";

export const SUPERMEMORY_SOURCE = "supermemory";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a character boundary. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * Render ranked Supermemory hits into a markdown {@link MemoryBlock}, capped at `maxBytes`. Each hit
 * is one bullet `- (score) text` with whitespace collapsed. The block is truncated on a byte boundary
 * (with `truncated: true`) so it never blows the per-turn recall budget.
 */
export function formatHitsAsBlock(hits: readonly SupermemoryHit[], maxBytes: number): MemoryBlock {
  const full = hits
    .map((hit) => `- (${hit.score.toFixed(3)}) ${hit.text.replace(/\s+/gu, " ").trim()}`)
    .join("\n");
  const truncated = byteLength(full) > maxBytes;
  return {
    kind: "markdown",
    content: truncated ? truncateToBytes(full, maxBytes) : full,
    source: SUPERMEMORY_SOURCE,
    truncated,
  };
}

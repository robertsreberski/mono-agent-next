import type { MemoryBlock } from "@mono-agent/agent-contracts";
import type { MemoryDb } from "../store/index.js";

import { MARKER_FOR } from "./grammar.js";
import { selectAnswerBearingRecallHits } from "./recall-evidence.js";

/** Confidence floor for automatic prompt injection. Deliberate tool recall may inspect lower scores. */
export const AUTO_RECALL_MIN_SCORE = 0.65;
/** Additional hits must remain close to the strongest result; raw embedding scores are not calibrated probabilities. */
export const AUTO_RECALL_RELATIVE_SCORE = 0.77;
export const AUTO_RECALL_MAX_HITS = 5;
export const AUTO_RECALL_MAX_BYTES = 8_000;
/** One lookup can satisfy automatic context and the explicit tool's maximum request. */
export const AUTO_RECALL_BACKEND_HITS = 50;

/** Select confidence-gated automatic hits from an already relevance-sorted result set. */
export function selectAutomaticRecallHits<T extends {
  readonly score: number;
  readonly record?: { readonly text: string };
}>(
  hits: readonly T[],
  options: { readonly maxHits?: number; readonly query?: string } = {},
): readonly T[] {
  const topScore = hits[0]?.score;
  if (topScore === undefined) return [];
  const maxHits = Math.max(1, Math.min(options.maxHits ?? AUTO_RECALL_MAX_HITS, AUTO_RECALL_MAX_HITS));
  const floor = Math.max(AUTO_RECALL_MIN_SCORE, topScore * AUTO_RECALL_RELATIVE_SCORE);
  const selected = topScore < AUTO_RECALL_MIN_SCORE
    ? []
    : hits.filter((hit) => hit.score >= floor).slice(0, maxHits);
  if (options.query === undefined) return selected;
  const evidenceHits = selected.filter((hit): hit is T & { readonly record: { readonly text: string } } =>
    hit.record !== undefined);
  if (evidenceHits.length !== selected.length) return [];
  const scoreSupported = selectAnswerBearingRecallHits(options.query, evidenceHits);
  if (scoreSupported.length > 0) return scoreSupported.slice(0, maxHits);

  // Raw backend scores are not calibrated across providers. A true paraphrase
  // can sit just below the score floor, so inspect the bounded top-eight text
  // window with the stricter single-clause answer-evidence gate before
  // abstaining. This adds no retrieval/model call.
  const evidenceWindow = hits.slice(0, Math.max(8, maxHits)).filter(
    (hit): hit is T & { readonly record: { readonly text: string } } => hit.record !== undefined,
  );
  return selectAnswerBearingRecallHits(options.query, evidenceWindow).slice(0, maxHits);
}

export async function composeRecallBlock(
  db: MemoryDb,
  query: string,
  options: { topK?: number; maxBytes?: number; trackAccess?: boolean; abortSignal?: AbortSignal } = {},
): Promise<MemoryBlock | undefined> {
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? AUTO_RECALL_MAX_BYTES, AUTO_RECALL_MAX_BYTES));
  const topK = Math.max(1, Math.min(options.topK ?? AUTO_RECALL_MAX_HITS, AUTO_RECALL_MAX_HITS));
  const backendHits = await db.recall(query, {
    topK: Math.max(topK, 8),
    trackAccess: false,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
  options.abortSignal?.throwIfAborted();
  const hits = selectAutomaticRecallHits(
    backendHits,
    { maxHits: topK, query },
  );
  // No hits → no block. A header-only block carries no signal and only adds
  // noise/tokens to whatever surface injects it; returning undefined lets
  // callers skip injection via their existing `block === undefined` guard.
  if (hits.length === 0) {
    return undefined;
  }
  if (options.trackAccess !== false) db.recordAccess(hits.map((hit) => hit.record.id));
  const lines = ["## Memory (recalled)", ""];
  for (const hit of hits) {
    const star = hit.record.isInsight ? " *" : "";
    // Marker reflects type *and* status (e.g. a done task renders `- [x]`, not `- [ ]`); recall
    // surfaces done/scheduled/migrated records, so a type-only marker would misrepresent their state.
    lines.push(`- ${MARKER_FOR(hit.record.type, hit.record.status)} ${hit.record.text}${star}`);
  }
  let content = lines.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = clampToBytes(content, maxBytes);
    truncated = true;
  }
  return { kind: "markdown", content, source: "memory-bujo", truncated };
}

function clampToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  // Cut on a UTF-8 boundary by decoding a sliced buffer leniently.
  return new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes)).replace(/�+$/u, "");
}

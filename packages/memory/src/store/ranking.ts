import type { RecallWeights } from "./types.js";

export interface FusedItem {
  readonly id: string;
  readonly rrfScore: number;
}

/** Reciprocal Rank Fusion across any number of ranked id lists (best-first). */
export function rrfFuse(lists: readonly (readonly string[])[], k: number): FusedItem[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

export interface ReScoreInput {
  readonly rrfScore: number;
  readonly salience: number;
  readonly isInsight: boolean;
}

/** Final relevance: rank/evidence first, with small salience/insight tie-breakers. */
export function reScore(input: ReScoreInput, weights: RecallWeights, _decayGamma: number, _now: Date): number {
  return (
    weights.rrf * input.rrfScore +
    weights.salience * input.salience +
    weights.insight * (input.isInsight ? 1 : 0)
  );
}

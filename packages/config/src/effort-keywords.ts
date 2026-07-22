import { EFFORT_LEVELS } from "./enums.js";
import type { EffortLevel } from "./types.js";

/**
 * Per-turn effort trigger phrases ("think" → high, "extra think" → xhigh,
 * "ultra think" → max), matched case-insensitively on word boundaries anywhere
 * in a message. Escalation-only: a matched phrase raises the turn's effort but
 * never lowers it, so the comparison against the otherwise-resolved effort must
 * use `effortRank`/`maxEffortLevel` with strict-increase semantics.
 *
 * The `\s*` between the modifier and "think" makes the fused forms
 * ("ultrathink"/"extrathink") hit their own trigger instead of degrading to the
 * bare `\bthink\b` one, which is why the triggers must stay in descending
 * effort order — every stronger phrase also contains a standalone "think".
 */
export interface EffortKeywordTrigger {
  /** Effort the phrase escalates to. Triggers never emit `ultra`; Pi uses LOW only with reasoning, otherwise OFF. */
  readonly effort: Extract<EffortLevel, "high" | "xhigh" | "max">;
  readonly pattern: RegExp;
  /** Canonical phrase for docs and log lines. */
  readonly label: string;
}

export const EFFORT_KEYWORD_TRIGGERS: readonly EffortKeywordTrigger[] = [
  { effort: "max", pattern: /\bultra\s*think\b/i, label: "ultra think" },
  { effort: "xhigh", pattern: /\bextra\s*think\b/i, label: "extra think" },
  { effort: "high", pattern: /\bthink\b/i, label: "think" },
];

export interface EffortKeywordMatch {
  readonly effort: EffortLevel;
  /** The exact substring that matched, for log lines. */
  readonly keyword: string;
}

/** First trigger (descending effort) whose phrase appears in the text, or undefined. */
export function detectEffortKeyword(text: string): EffortKeywordMatch | undefined {
  for (const trigger of EFFORT_KEYWORD_TRIGGERS) {
    const match = trigger.pattern.exec(text);
    if (match !== null) {
      return { effort: trigger.effort, keyword: match[0] };
    }
  }
  return undefined;
}

/**
 * Position of a level in `EFFORT_LEVELS` (`none` 0 … `max` 6, `ultra` 7);
 * unknown or missing values rank -1, below every real level. NOTE the `ultra`
 * trap: the enum ranks it ABOVE `max` so escalation never touches an
 * explicitly configured `ultra`, but nothing should ever EMIT it — the pi
 * runtime maps `ultra` to low only for reasoning-capable models and returns
 * off before effort mapping for models without reasoning (`thinkingLevelForEffort`).
 */
export function effortRank(level: string | undefined): number {
  if (typeof level !== "string") return -1;
  return EFFORT_LEVELS.indexOf(level as EffortLevel);
}

/** `candidate` only on a STRICT rank increase over `current`, else `current` — escalation, never a downgrade or a same-level rewrite. */
export function maxEffortLevel(current: string | undefined, candidate: EffortLevel): string {
  if (current === undefined) return candidate;
  return effortRank(candidate) > effortRank(current) ? candidate : current;
}

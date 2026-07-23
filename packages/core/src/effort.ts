const EFFORT_LEVELS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const);

interface EffortKeywordTrigger {
  readonly effort: "high" | "xhigh" | "max";
  readonly pattern: RegExp;
}

const EFFORT_KEYWORD_TRIGGERS: readonly EffortKeywordTrigger[] = Object.freeze([
  Object.freeze({ effort: "max", pattern: /\bultra\s*think\b/iu }),
  Object.freeze({ effort: "xhigh", pattern: /\bextra\s*think\b/iu }),
  Object.freeze({ effort: "high", pattern: /\bthink\b/iu }),
]);

function effortRank(effort: string | undefined): number {
  if (effort === undefined) return -1;
  return EFFORT_LEVELS.indexOf(effort as (typeof EFFORT_LEVELS)[number]);
}

/**
 * Apply the always-on message keyword contract without changing the message.
 * A keyword may only raise the otherwise selected effort; equal, stronger, or
 * unknown provider-specific values are left to the selected runtime.
 */
export function escalateMessageEffort(
  text: string,
  current: string | undefined,
): string | undefined {
  for (const trigger of EFFORT_KEYWORD_TRIGGERS) {
    if (!trigger.pattern.test(text)) continue;
    const currentRank = effortRank(current);
    // Preserve an unknown explicit provider-specific value rather than
    // silently replacing runtime-owned configuration.
    if (current !== undefined && currentRank < 0) return current;
    return effortRank(trigger.effort) > currentRank ? trigger.effort : current;
  }
  return current;
}

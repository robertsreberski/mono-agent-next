// SPDX-License-Identifier: MIT
import type { AgentEffortKeywordConfig } from "./types.js";
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

export type EffortKeyword = "ultraThink" | "extraThink" | "think";

interface EffortKeywordTrigger {
  readonly keyword: EffortKeyword;
  readonly effort: "high" | "xhigh" | "max";
  readonly pattern: RegExp;
  /**
   * `ultra think` and `extra think` are deliberate operator idioms, so they stay
   * on. A bare `think` is ordinary English -- "what do you think?" -- and raised
   * effort, latency, and provider cost on every such turn with no signal in the
   * response, the run record, or the logs, so it is off unless asked for.
   */
  readonly enabledByDefault: boolean;
}

const EFFORT_KEYWORD_TRIGGERS: readonly EffortKeywordTrigger[] = Object.freeze([
  Object.freeze({ keyword: "ultraThink", effort: "max", pattern: /\bultra\s*think\b/iu, enabledByDefault: true }),
  Object.freeze({ keyword: "extraThink", effort: "xhigh", pattern: /\bextra\s*think\b/iu, enabledByDefault: true }),
  Object.freeze({ keyword: "think", effort: "high", pattern: /\bthink\b/iu, enabledByDefault: false }),
] as const);

/** Records that a keyword raised this turn's effort, and from what. */
export interface EffortEscalation {
  readonly keyword: EffortKeyword;
  readonly from?: string;
  readonly to: string;
}

export interface EffortDecision {
  readonly effort: string | undefined;
  readonly escalation?: EffortEscalation;
}

function effortRank(effort: string | undefined): number {
  if (effort === undefined) return -1;
  return EFFORT_LEVELS.indexOf(effort as (typeof EFFORT_LEVELS)[number]);
}

export function effortKeywordEnabled(
  keyword: EffortKeyword,
  settings: AgentEffortKeywordConfig | undefined,
): boolean {
  const trigger = EFFORT_KEYWORD_TRIGGERS.find((candidate) => candidate.keyword === keyword);
  return settings?.[keyword] ?? trigger?.enabledByDefault ?? false;
}

/**
 * Apply the configured message keyword contract without changing the message.
 * A keyword may only raise the otherwise selected effort; equal, stronger, or
 * unknown provider-specific values are left to the selected runtime.
 */
export function escalateMessageEffort(
  text: string,
  current: string | undefined,
  settings?: AgentEffortKeywordConfig,
): EffortDecision {
  for (const trigger of EFFORT_KEYWORD_TRIGGERS) {
    if (!effortKeywordEnabled(trigger.keyword, settings)) continue;
    if (!trigger.pattern.test(text)) continue;
    const currentRank = effortRank(current);
    // Preserve an unknown explicit provider-specific value rather than
    // silently replacing runtime-owned configuration.
    if (current !== undefined && currentRank < 0) return { effort: current };
    if (effortRank(trigger.effort) <= currentRank) return { effort: current };
    return {
      effort: trigger.effort,
      escalation: {
        keyword: trigger.keyword,
        ...(current === undefined ? {} : { from: current }),
        to: trigger.effort,
      },
    };
  }
  return { effort: current };
}

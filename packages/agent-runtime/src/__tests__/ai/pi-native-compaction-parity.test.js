import { describe, expect, it } from "vitest";
import { shouldCompact } from "@earendil-works/pi-agent-core";
import { resolveAgentCompactionPolicy } from "../../agent/compaction.js";
import { piCompactionSettings } from "../../ai/providers/pi-native/compaction-driver.js";

// PARITY PROOF (Phase 5): the proactive compaction trigger was moved off the
// hand-rolled `est.tokens >= policy.triggerTokens` comparison onto pi's native
// shouldCompact(). This asserts the two decide IDENTICALLY across the boundary.
//
// OLD decision: est >= triggerTokens
// NEW decision: shouldCompact(est, contextWindow, piCompactionSettings(policy))
//   where piCompactionSettings sets reserveTokens = contextWindow - triggerTokens + 1
//   and shouldCompact fires iff `est > contextWindow - reserveTokens`.
//
// pi's shouldCompact uses a STRICT `>`; the kernel used `>=`. They coincide only
// because every input is an integer: pi's estimateTokens/calculateContextTokens
// return integers and resolveAgentCompactionPolicy floors triggerTokens, so
// `est >= t` iff `est > t - 1`, and reserveTokens = window - t + 1 makes
// `window - reserveTokens = t - 1`. The exactly-at-trigger row is the one that
// would break under the off-by-one `reserveTokens = window - triggerTokens`.

/** The pre-Phase-5 decision, kept verbatim as the parity oracle. */
function oldDecision(est, policy) {
  return est >= policy.triggerTokens;
}

/** The Phase-5 decision, exactly as runProactiveCompaction now evaluates it. */
function newDecision(est, policy) {
  return shouldCompact(est, policy.contextWindow, piCompactionSettings(policy));
}

describe("proactive compaction trigger — old (>=) vs new (shouldCompact) parity", () => {
  // Each scenario resolves a real policy so triggerTokens/contextWindow are the
  // production values, then probes the boundary. `modelWindow` feeds
  // resolveAgentCompactionPolicy's model.contextWindow (clamped to [32k, 10M]).
  const scenarios = [
    // 128k: ratioTrigger=89.6k is below the 96k headroom trigger.
    { name: "ratio-dominant window (128k)", modelWindow: 128_000, settings: {}, expectTrigger: 89_600 },
    // 1M: safety headroom caps at 96k, while the 0.70 ratio fires at 700k.
    { name: "ratio-dominant window (1M)", modelWindow: 1_000_000, settings: {}, expectTrigger: 700_000 },
    // tiny: clamps to the 32k floor; 16k minimum headroom wins over 70%.
    { name: "tiny window (32k floor)", modelWindow: 1_000, settings: {}, expectTrigger: 16_000 },
    // huge: clamps to the 10M ceiling and the 0.70 ratio remains dominant.
    { name: "huge window (10M clamp)", modelWindow: 50_000_000, settings: {}, expectTrigger: 7_000_000 },
    // custom ratio still resolves to an integer trigger via Math.floor.
    { name: "custom ratio 0.5 on 200k", modelWindow: 200_000, settings: { agent_compaction_trigger_ratio: 0.5 }, expectTrigger: 100_000 },
  ];

  for (const sc of scenarios) {
    describe(sc.name, () => {
      const policy = resolveAgentCompactionPolicy(sc.settings, { contextWindow: sc.modelWindow });

      it(`resolves the expected integer triggerTokens (${sc.expectTrigger})`, () => {
        expect(policy.triggerTokens).toBe(sc.expectTrigger);
        expect(Number.isInteger(policy.triggerTokens)).toBe(true);
        // reserveTokens must stay strictly positive (never degenerate).
        expect(piCompactionSettings(policy).reserveTokens).toBeGreaterThan(0);
      });

      // The three boundary rows the brief requires: one-below, exactly-at, one-above.
      const t = policy.triggerTokens;
      const rows = [
        { label: "one below trigger", est: t - 1, expected: false },
        { label: "exactly at trigger", est: t, expected: true },
        { label: "one above trigger", est: t + 1, expected: true },
        { label: "far below (0)", est: 0, expected: false },
        { label: "far above (2x window)", est: policy.contextWindow * 2, expected: true },
      ];

      for (const row of rows) {
        it(`${row.label}: est=${row.est} fires=${row.expected}, old===new`, () => {
          const oldFires = oldDecision(row.est, policy);
          const newFires = newDecision(row.est, policy);
          expect(oldFires).toBe(row.expected);
          expect(newFires).toBe(row.expected);
          expect(newFires).toBe(oldFires);
        });
      }

      // Exhaustive agreement across the whole boundary neighbourhood: every
      // integer estimate in [trigger-3, trigger+3] must decide identically.
      it("old and new agree for every integer estimate around the trigger", () => {
        for (let est = t - 3; est <= t + 3; est += 1) {
          expect(newDecision(est, policy)).toBe(oldDecision(est, policy));
        }
      });
    });
  }

  describe("compaction disabled", () => {
    const policy = resolveAgentCompactionPolicy({ agent_compaction_enabled: false }, { contextWindow: 128_000 });

    it("never fires regardless of estimate (both branches)", () => {
      expect(policy.enabled).toBe(false);
      // The kernel short-circuits on !policy.enabled before evaluating the estimate;
      // pi's shouldCompact independently returns false when settings.enabled is false.
      for (const est of [0, policy.triggerTokens, policy.triggerTokens + 1, policy.contextWindow * 2]) {
        expect(newDecision(est, policy)).toBe(false);
      }
    });
  });
});

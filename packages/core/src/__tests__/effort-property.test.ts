// SPDX-License-Identifier: MIT

// Properties of the always-on effort keyword contract (src/effort.ts).
//
// This contract silently raises the provider effort — and therefore latency and
// cost — based on words in the operator's message. `effort.test.ts` already
// pins a dozen hand-picked strings; what it cannot do is establish that the
// invariants hold for arbitrary prose. These properties do, over generated
// text, and they shrink to a minimal counterexample when one does not.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { escalateMessageEffort } from "../effort.js";

/** Ordered weakest to strongest, mirroring `EFFORT_LEVELS`. */
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const rank = (value: string | undefined): number =>
  value === undefined ? -1 : LEVELS.indexOf(value as (typeof LEVELS)[number]);

/** Any word that does not itself carry a trigger. */
const innocuousWord = fc.stringMatching(/^[a-z]{1,12}$/u)
  .filter((word) => !/think/iu.test(word));

const innocuousText = fc.array(innocuousWord, { maxLength: 12 })
  .map((words) => words.join(" "));

const knownLevel = fc.constantFrom(...LEVELS);

describe("effort keyword contract", () => {
  it("never lowers an already selected effort", () => {
    fc.assert(fc.property(fc.string(), knownLevel, (text, current) => {
      expect(rank(escalateMessageEffort(text, current))).toBeGreaterThanOrEqual(rank(current));
    }));
  });

  it("actually escalates to the trigger level whenever the current one is weaker", () => {
    // Stronger than "never lowers": that invariant is satisfied by doing
    // nothing at all, so it cannot see a guard that suppresses escalation for
    // the weakest levels.
    const weakerThanHigh = fc.constantFrom(...LEVELS.filter((level) => rank(level) < rank("high")));
    fc.assert(fc.property(innocuousText, weakerThanHigh, (filler, current) => {
      expect(escalateMessageEffort(`${filler} think`, current)).toBe("high");
    }));
  });

  it("only ever returns a known level or the caller's own value", () => {
    fc.assert(fc.property(fc.string(), fc.option(knownLevel, { nil: undefined }), (text, current) => {
      const result = escalateMessageEffort(text, current);
      expect(result === current || LEVELS.includes(result as (typeof LEVELS)[number])).toBe(true);
    }));
  });

  it("leaves text without a trigger word completely untouched", () => {
    fc.assert(fc.property(innocuousText, fc.option(knownLevel, { nil: undefined }), (text, current) => {
      expect(escalateMessageEffort(text, current)).toBe(current);
    }));
  });

  it("preserves a provider-specific value it does not understand", () => {
    const unknownLevel = fc.string({ minLength: 1 })
      .filter((value) => rank(value) < 0);
    fc.assert(fc.property(fc.string(), unknownLevel, (text, current) => {
      // Runtime-owned configuration is never silently replaced, even when the
      // message would otherwise escalate.
      expect(escalateMessageEffort(text, current)).toBe(current);
    }));
  });

  it("matches whole words only, wherever the trigger sits in the message", () => {
    fc.assert(fc.property(innocuousText, innocuousText, (before, after) => {
      const embedded = `${before} think ${after}`.trim();
      expect(escalateMessageEffort(embedded, undefined)).toBe("high");
      // The same letters inside a larger word must not trigger.
      expect(escalateMessageEffort(`${before} rethinking ${after}`, undefined)).toBeUndefined();
    }));
  });

  it("resolves the strongest matching trigger regardless of order", () => {
    fc.assert(fc.property(innocuousText, (filler) => {
      expect(escalateMessageEffort(`think ${filler} ultra think`, undefined)).toBe("max");
      expect(escalateMessageEffort(`ultra think ${filler} think`, undefined)).toBe("max");
    }));
  });
});

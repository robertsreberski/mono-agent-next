// Pricing precedence for ai/cost.js:
//   custom (resolveCustomPricing) -> pi catalog (getBuiltinModel) -> static
//   CLAUDE_PRICING fallback -> unknown.
//
// getBuiltinModel is mocked with a vi.fn that DEFAULTS to pi-ai's real catalog
// (so the pi-catalog level is exercised against real data) but can be forced to
// return undefined per-test to deterministically drive the static-table fallback
// and unknown levels — pi's catalog currently prices every Claude id in the
// static table, so the fallback is otherwise unreachable through real data.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/providers/all", () => ({ getBuiltinModel: vi.fn() }));

// The REAL catalog fn (importActual bypasses the mock above). Used as the mock's
// default so the pi-catalog level runs against real data; individual tests force
// undefined to drive the static-table fallback / unknown levels.
const { getBuiltinModel: realGetBuiltinModel } = await vi.importActual("@earendil-works/pi-ai/providers/all");
const { getBuiltinModel } = await import("@earendil-works/pi-ai/providers/all");
const { resolvePricing, estimateCost } = await import("../../ai/cost.js");

beforeEach(() => {
  getBuiltinModel.mockReset();
  getBuiltinModel.mockImplementation(realGetBuiltinModel);
});

describe("resolvePricing precedence", () => {
  it("1) custom pricing (resolveCustomPricing) wins over everything", () => {
    const custom = { input: 42, cacheRead: 1, cacheWrite: 2, output: 84, source: "custom", priced: true };
    const pricing = resolvePricing({
      model: "claude:claude-sonnet-4-5",
      resolveCustomPricing: () => custom,
    });
    expect(pricing).toEqual(custom);
    // Custom short-circuits before the catalog is ever consulted.
    expect(getBuiltinModel).not.toHaveBeenCalled();
  });

  it("2) pi catalog prices a Claude model via the anthropic provider (source pi-catalog)", () => {
    const pricing = resolvePricing({ model: "claude:claude-sonnet-4-5" });
    expect(getBuiltinModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
    expect(pricing.source).toBe("pi-catalog");
    expect(pricing.priced).toBe(true);
    expect(pricing.input).toBe(3);
    expect(pricing.output).toBe(15);
  });

  it("2b) pi catalog prices openai references (codex/openai route through sdk pi)", () => {
    const openai = resolvePricing({ model: "openai:gpt-4o" });
    expect(openai.source).toBe("pi-catalog");
    expect(openai.priced).toBe(true);
    // A codex model id pi's catalog does not carry falls through to unknown.
    const codex = resolvePricing({ model: "codex:gpt-5-codex" });
    expect(getBuiltinModel).toHaveBeenCalledWith("openai-codex", "gpt-5-codex");
    expect(codex.source).toBe("unknown");
    expect(codex.priced).toBe(false);
  });

  it("3) falls back to the static CLAUDE_PRICING table when the catalog lacks the model", () => {
    getBuiltinModel.mockReturnValue(undefined);
    const pricing = resolvePricing({ model: "claude:claude-sonnet-4-5" });
    expect(pricing.source).toBe("claude-table");
    expect(pricing.priced).toBe(true);
    expect(pricing.input).toBe(3);
    expect(pricing.output).toBe(15);
  });

  it("4) returns unknown when no source can price the model", () => {
    getBuiltinModel.mockReturnValue(undefined);
    const claudeUnknown = resolvePricing({ model: "claude:claude-does-not-exist-9" });
    expect(claudeUnknown.source).toBe("unknown");
    expect(claudeUnknown.priced).toBe(false);
    const bareUnknown = resolvePricing({ model: "mystery:model-x" });
    expect(bareUnknown.source).toBe("unknown");
    expect(bareUnknown.priced).toBe(false);
  });

  it("returns unknown for an unparseable reference", () => {
    expect(resolvePricing({ model: "" }).source).toBe("unknown");
    expect(resolvePricing({}).source).toBe("unknown");
  });
});

describe("estimateCost", () => {
  it("returns null for an unpriced (unknown) model", () => {
    getBuiltinModel.mockReturnValue(undefined);
    expect(estimateCost({ model: "mystery:model-x", inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it("computes cost from the resolved per-million rates", () => {
    // claude-sonnet-4-5 via pi catalog: input 3/M, output 15/M.
    const cost = estimateCost({ model: "claude:claude-sonnet-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it("delegates Pi request-wide tier selection at the catalog threshold", () => {
    const atThreshold = estimateCost({
      model: "codex:gpt-5.6-sol",
      inputTokens: 272_000,
      outputTokens: 1_000_000,
    });
    const aboveThreshold = estimateCost({
      model: "codex:gpt-5.6-sol",
      inputTokens: 272_001,
      outputTokens: 1_000_000,
    });

    expect(atThreshold).toBeCloseTo(1.36 + 30, 6);
    expect(aboveThreshold).toBeCloseTo(2.72001 + 45, 6);
  });

  it("uses Pi's cache-write rate in the native catalog estimate", () => {
    expect(estimateCost({
      model: "codex:gpt-5.6-terra",
      cacheWriteTokens: 100_000,
    })).toBeCloseTo(0.3125, 6);
  });
});

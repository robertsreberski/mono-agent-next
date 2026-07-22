// resolvePiRuntimeModel's builtin-catalog-miss guard.
//
// getPiModel (Pi's getBuiltinModel) returns `undefined` on an unknown
// provider/model instead of throwing, so a raw `!!model.reasoning` read used
// to throw an unguarded TypeError ("Cannot read properties of undefined") —
// a message that doesn't match any classifyFailure/retryableProviderFailureInfo
// pattern, so it fell through to a misleading provider_unavailable classification
// instead of failing cleanly as a non-retryable, unambiguous "model not found".
import { describe, expect, it } from "vitest";
import { reasoningLevelsForPiModel, resolvePiRuntimeModel } from "../../ai/providers/pi-models.js";
import { retryableProviderFailureInfo } from "../../ai/failure.js";
import { thinkingLevelForEffort } from "../../ai/providers/pi-native/turn-runner.js";

describe("resolvePiRuntimeModel — unknown builtin model guard", () => {
  it("throws a clean 'pi model not found' error instead of a raw TypeError on a catalog miss", () => {
    expect(() => resolvePiRuntimeModel({ sdk: "pi", provider: "ollama", model: "nope" }, {}))
      .toThrow("pi model not found: ollama:nope");
  });

  it("rejects a non-pi sdk before reaching the catalog lookup", () => {
    expect(() => resolvePiRuntimeModel({ sdk: "claude", provider: "anthropic", model: "claude-sonnet-4-6" }, {}))
      .toThrow("unsupported pi sdk: claude");
  });
});

describe("retryableProviderFailureInfo — 'pi model not found' classifies as non-retryable", () => {
  it("matches NON_RETRYABLE_PROVIDER_RE's model[_ ]not[_ ]found alternation", () => {
    expect(retryableProviderFailureInfo({
      errorText: "pi model not found: ollama:nope",
      failureKind: "provider_unavailable",
    })).toMatchObject({ retryable: false, subkind: "non_retryable" });
  });
});

describe("resolvePiRuntimeModel — OpenAI Codex GPT-5.6 metadata", () => {
  const expected = {
    "gpt-5.6-sol": {
      name: "GPT-5.6 Sol",
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tiers: [{
          inputTokensAbove: 272_000,
          input: 10,
          output: 45,
          cacheRead: 1,
          cacheWrite: 12.5,
        }],
      },
    },
    "gpt-5.6-terra": {
      name: "GPT-5.6 Terra",
      cost: {
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 3.125,
        tiers: [{
          inputTokensAbove: 272_000,
          input: 5,
          output: 22.5,
          cacheRead: 0.5,
          cacheWrite: 6.25,
        }],
      },
    },
  };

  for (const [model, metadata] of Object.entries(expected)) {
    it(`resolves ${model} context, pricing tiers, and native max`, () => {
      const resolved = resolvePiRuntimeModel({
        sdk: "pi",
        provider: "openai-codex",
        model,
      }, {});

      expect(resolved.model).toMatchObject({
        id: model,
        name: metadata.name,
        api: "openai-codex-responses",
        provider: "openai-codex",
        reasoning: true,
        contextWindow: 372_000,
        maxTokens: 128_000,
        cost: metadata.cost,
      });
      expect(resolved.capabilities).toMatchObject({
        reasoning: true,
        reasoning_mode: "effort",
        reasoning_levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        vision: true,
      });
      expect(thinkingLevelForEffort("max", resolved.capabilities)).toBe("max");
    });
  }

  it("retains the xhigh compatibility ceiling when older model metadata omits max", () => {
    expect(thinkingLevelForEffort("max", {
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: ["none", "low", "medium", "high", "xhigh"],
    })).toBe("xhigh");
  });

  it("preserves minimal for sparse upstream maps instead of letting Pi clamp low upward", () => {
    const capabilities = {
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: reasoningLevelsForPiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "MINIMAL",
          low: null,
          medium: null,
          high: "HIGH",
        },
      }),
    };

    expect(capabilities.reasoning_levels).toEqual(["minimal", "high"]);
    expect(thinkingLevelForEffort("minimal", capabilities)).toBe("minimal");
  });
});

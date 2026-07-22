import { describe, expect, it } from "vitest";

import { evaluateOperatorRuntimeOverride, type OperatorInfo } from "../index.js";
import { VALID_OPERATOR_INFO } from "../testing.js";

function info(overrides: Partial<OperatorInfo> = {}): OperatorInfo {
  return { ...VALID_OPERATOR_INFO, ...overrides };
}

describe("evaluateOperatorRuntimeOverride", () => {
  it("allows an empty intent without requiring override capability", () => {
    const disabled = info({
      capabilities: { ...VALID_OPERATOR_INFO.capabilities, runtimeOverrides: false },
    });
    expect(evaluateOperatorRuntimeOverride(disabled, {})).toEqual({ allowed: true, intent: {} });
  });

  it("rejects every authored override when the capability is disabled", () => {
    const disabled = info({
      capabilities: { ...VALID_OPERATOR_INFO.capabilities, runtimeOverrides: false },
    });
    for (const intent of [{ runtime: "pi" }, { model: "fixture:model" }, { effort: "medium" }]) {
      expect(evaluateOperatorRuntimeOverride(disabled, intent)).toMatchObject({
        allowed: false,
        reason: "runtime_overrides_unsupported",
      });
    }
    expect(evaluateOperatorRuntimeOverride(disabled, { model: " invalid" })).toMatchObject({
      allowed: false,
      reason: "runtime_overrides_unsupported",
    });
  });

  it("rejects protocol-invalid values deterministically", () => {
    expect(evaluateOperatorRuntimeOverride(VALID_OPERATOR_INFO, { model: " leading-space" })).toEqual({
      allowed: false,
      reason: "invalid_override",
      message: "Runtime override is invalid: turn.model contains unsupported characters.",
    });
  });

  it("enforces advertised model identifiers", () => {
    expect(evaluateOperatorRuntimeOverride(VALID_OPERATOR_INFO, { model: "missing:model" })).toEqual({
      allowed: false,
      reason: "unknown_model",
      message: 'Model "missing:model" is not advertised by this agent.',
    });
    expect(evaluateOperatorRuntimeOverride(VALID_OPERATOR_INFO, { model: "fixture:model" })).toEqual({
      allowed: true,
      intent: { model: "fixture:model" },
    });
  });

  it("enforces efforts advertised by the selected or default model", () => {
    expect(evaluateOperatorRuntimeOverride(VALID_OPERATOR_INFO, { model: "fixture:model", effort: "extreme" })).toMatchObject({
      allowed: false,
      reason: "unsupported_effort",
      message: 'Effort "extreme" is not advertised for model "fixture:model".',
    });
    expect(evaluateOperatorRuntimeOverride(VALID_OPERATOR_INFO, { effort: "extreme" })).toMatchObject({
      allowed: false,
      reason: "unsupported_effort",
    });
    expect(evaluateOperatorRuntimeOverride(VALID_OPERATOR_INFO, { effort: "high" })).toEqual({
      allowed: true,
      intent: { effort: "high" },
    });
  });

  it("treats absent model and effort catalogs as hints absent", () => {
    const { models: _models, ...withoutModels } = VALID_OPERATOR_INFO;
    expect(evaluateOperatorRuntimeOverride(withoutModels, {
      runtime: "custom-runtime",
      model: "custom:model",
      effort: "custom-effort",
    })).toEqual({
      allowed: true,
      intent: { runtime: "custom-runtime", model: "custom:model", effort: "custom-effort" },
    });

    const withoutEfforts = info({ models: [{ id: "fixture:model" }] });
    expect(evaluateOperatorRuntimeOverride(withoutEfforts, { model: "fixture:model", effort: "custom-effort" })).toEqual({
      allowed: true,
      intent: { model: "fixture:model", effort: "custom-effort" },
    });
  });
});

import { OperatorProtocolError, parseTurnRequest } from "./protocol.js";
import type { OperatorInfo } from "./types.js";

export interface OperatorRuntimeOverrideIntent {
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
}

export type OperatorRuntimeOverrideRejectionReason =
  | "invalid_override"
  | "runtime_overrides_unsupported"
  | "unknown_model"
  | "unsupported_effort";

export type OperatorRuntimeOverrideDecision =
  | {
      readonly allowed: true;
      readonly intent: OperatorRuntimeOverrideIntent;
    }
  | {
      readonly allowed: false;
      readonly reason: OperatorRuntimeOverrideRejectionReason;
      readonly message: string;
    };

function parseIntent(intent: OperatorRuntimeOverrideIntent): OperatorRuntimeOverrideIntent {
  const parsed = parseTurnRequest({
    conversationId: "operator-override-validation",
    input: { text: "." },
    ...intent,
  });
  return {
    ...(parsed.runtime === undefined ? {} : { runtime: parsed.runtime }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
  };
}

/**
 * Evaluate renderer-authored per-turn overrides against authoritative operator
 * capability and model hints. Core and the selected runtime remain the final
 * validators whenever the operator endpoint does not advertise a catalog.
 */
export function evaluateOperatorRuntimeOverride(
  info: OperatorInfo,
  intent: OperatorRuntimeOverrideIntent,
): OperatorRuntimeOverrideDecision {
  const hasAuthoredOverride = intent.runtime !== undefined || intent.model !== undefined || intent.effort !== undefined;
  if (hasAuthoredOverride && !info.capabilities.runtimeOverrides) {
    return {
      allowed: false,
      reason: "runtime_overrides_unsupported",
      message: "This agent does not allow per-turn runtime, model, or effort overrides.",
    };
  }

  let parsed: OperatorRuntimeOverrideIntent;
  try {
    parsed = parseIntent(intent);
  } catch (error) {
    const detail = error instanceof OperatorProtocolError ? error.message : "override fields are invalid";
    return {
      allowed: false,
      reason: "invalid_override",
      message: `Runtime override is invalid: ${detail}.`,
    };
  }

  if (!hasAuthoredOverride) return { allowed: true, intent: parsed };

  const effectiveRuntime = parsed.runtime ?? info.defaults?.runtime;
  const effectiveModelId = parsed.model ?? info.defaults?.model;
  let selectedModel = effectiveRuntime === undefined || effectiveModelId === undefined
    ? undefined
    : info.models?.find((model) =>
        model.runtime === effectiveRuntime && model.id === effectiveModelId);
  if (selectedModel === undefined && effectiveRuntime === undefined && effectiveModelId !== undefined) {
    const matches = info.models?.filter((model) => model.id === effectiveModelId);
    if (matches?.length === 1) selectedModel = matches[0];
  }
  if (
    info.models !== undefined
    && (parsed.runtime !== undefined || parsed.model !== undefined)
    && selectedModel === undefined
  ) {
    return {
      allowed: false,
      reason: "unknown_model",
      message: `Runtime/model route ${JSON.stringify({
        runtime: effectiveRuntime,
        model: effectiveModelId,
      })} is not advertised by this agent.`,
    };
  }

  if (parsed.effort !== undefined) {
    if (selectedModel?.efforts !== undefined && !selectedModel.efforts.includes(parsed.effort)) {
      return {
        allowed: false,
        reason: "unsupported_effort",
        message: `Effort ${JSON.stringify(parsed.effort)} is not advertised for model ${JSON.stringify(selectedModel.id)}.`,
      };
    }
  }

  return { allowed: true, intent: parsed };
}

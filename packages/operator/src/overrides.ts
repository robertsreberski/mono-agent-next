import { OperatorProtocolError, parseTurnRequest } from "./protocol.js";
import type { OperatorInfo, OperatorModel } from "./types.js";

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

  // `{ runtime, id }` is one atomic route. Resolving either half against the
  // other's default would accept a model the named runtime cannot serve.
  const authoredRuntime = parsed.runtime ?? info.defaults?.runtime;
  const findRoute = (id: string): OperatorModel | undefined =>
    info.models?.find((model) =>
      model.id === id && (authoredRuntime === undefined || model.runtime === authoredRuntime));

  let selectedModel = parsed.model === undefined ? undefined : findRoute(parsed.model);
  if (parsed.model !== undefined && info.models !== undefined && selectedModel === undefined) {
    return {
      allowed: false,
      reason: "unknown_model",
      message: authoredRuntime === undefined
        ? `Model ${JSON.stringify(parsed.model)} is not advertised by this agent.`
        : `Model ${JSON.stringify(parsed.model)} is not advertised for runtime ${JSON.stringify(authoredRuntime)}.`,
    };
  }

  if (parsed.effort !== undefined) {
    const effectiveModelId = parsed.model ?? info.defaults?.model;
    if (selectedModel === undefined && effectiveModelId !== undefined) {
      selectedModel = findRoute(effectiveModelId);
    }
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

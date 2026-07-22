// @ts-check
// Structured-output enforcement for the pi-native bridge.
//
// Pure moves out of pi-native.js: the system-prompt instruction append, the
// finalization re-prompt text, the retry predicate, the retry diagnostics, and
// the single-re-prompt finalization executor. No session or run state lives
// here — the executor takes its harness/tool/warnings deps explicitly and the
// caller owns the `structuredResult` closure the tool populates.

/**
 * Append the StructuredOutput usage instruction to the system prompt when an
 * output schema is active. No schema → the prompt is returned unchanged. A host
 * or run `prompts.structuredOutputInstruction(systemPrompt)` override, when
 * supplied, replaces the default instruction text (it receives the raw system
 * prompt and returns the augmented one); otherwise the default below is used.
 * @param {string} systemPrompt
 * @param {unknown} outputSchema
 * @param {import('../../types.js').RuntimePromptOverrides} [prompts]
 * @returns {string}
 */
export function appendStructuredOutputInstruction(systemPrompt, outputSchema, prompts) {
  if (!outputSchema) return systemPrompt;
  if (typeof prompts?.structuredOutputInstruction === "function") {
    return prompts.structuredOutputInstruction(systemPrompt);
  }
  return [
    systemPrompt,
    "",
    "Structured output is available through the `StructuredOutput` tool.",
    "When the final result is ready, call `StructuredOutput` with the complete JSON object matching the requested schema.",
    "Do not also print the same JSON as prose unless tool calling is unavailable.",
  ].join("\n");
}

/**
 * The finalization re-prompt issued when a turn ended without submitting the
 * required structured result. A `prompts.structuredOutputFinalization()`
 * override, when supplied, replaces the default text.
 * @param {import('../../types.js').RuntimePromptOverrides} [prompts]
 * @returns {string}
 */
export function structuredOutputFinalizationPrompt(prompts) {
  if (typeof prompts?.structuredOutputFinalization === "function") {
    return prompts.structuredOutputFinalization();
  }
  return [
    "The previous assistant turn ended without submitting the required structured result.",
    "Do not run tools, inspect files, or redo work.",
    "Call only `StructuredOutput` once with the final object matching the requested schema, based on the completed transcript above.",
    "Do not print prose before or after the tool call.",
  ].join("\n");
}

/**
 * Whether the run should re-prompt once for structured-output finalization: a
 * schema is active, no structured result was produced, the turn ended with no
 * text, the run was not aborted / did not hit max turns, and the stop reason is
 * not an error/abort.
 * @param {{outputSchema: unknown, structuredResult: unknown, finalText: unknown, stopReason: unknown, externalAbort: boolean, maxTurnsHit: boolean}} params
 * @returns {boolean}
 */
export function shouldRetryStructuredOutputFinalization({
  outputSchema,
  structuredResult,
  finalText,
  stopReason,
  externalAbort,
  maxTurnsHit,
}) {
  if (!outputSchema) return false;
  if (structuredResult !== null && structuredResult !== undefined) return false;
  if (String(finalText || "").trim()) return false;
  if (externalAbort || maxTurnsHit) return false;
  return stopReason !== "error" && stopReason !== "aborted";
}

/**
 * The structured-output finalization diagnostics spread into the run's
 * diagnostics/errorDetails. Empty when no retry was attempted.
 * @param {number} attempts
 * @param {string|null} reason
 * @param {boolean} failed
 * @returns {Record<string, unknown>}
 */
export function structuredOutputRetryDiagnostics(attempts, reason, failed) {
  if (!attempts) return {};
  return {
    structured_output_finalization_retry_attempts: attempts,
    structured_output_finalization_retry_reason: reason,
    structured_output_finalization_retry_failed: !!failed,
  };
}

/**
 * Run the single structured-output finalization re-prompt in the same session.
 *
 * The harness is idle after waitForIdle(), so re-prompt (not followUp, which
 * only queues onto an active run) with only StructuredOutput active. This
 * re-prompts ONCE in the same session, matching the legacy single
 * agent.continue() finalization re-prompt. Tools are restored in finally.
 *
 * Returns the retry bookkeeping ({attempts, reason}); the caller computes
 * `failed` from the (closure-owned) structuredResult after re-capturing state.
 * @param {{harness: any, structuredTool: {name: string}|null, runtimeWarnings: Array<Record<string, unknown>>, prompts?: import('../../types.js').RuntimePromptOverrides}} deps
 * @returns {Promise<{attempts: number, reason: string}>}
 */
export async function runStructuredOutputFinalizationRetry({ harness, structuredTool, runtimeWarnings, prompts }) {
  const reason = "empty_final_output";
  runtimeWarnings.push({
    warning_kind: "structured_output_finalization_retry",
    source: "pi",
    reason,
    message: "Pi stopped without text or structured output; retrying once in the same session with only StructuredOutput enabled.",
  });
  const previousActive = harness.getActiveTools().map((/** @type {{name: string}} */ toolDef) => toolDef.name);
  try {
    await harness.setActiveTools(structuredTool ? [structuredTool.name] : []);
    await harness.prompt(structuredOutputFinalizationPrompt(prompts));
    await harness.waitForIdle();
  } catch (err) {
    runtimeWarnings.push({
      warning_kind: "structured_output_finalization_retry_failed",
      source: "pi",
      message: (/** @type {any} */ (err))?.message || String(err),
    });
  } finally {
    try { await harness.setActiveTools(previousActive); } catch { /* best-effort */ }
  }
  return { attempts: 1, reason };
}

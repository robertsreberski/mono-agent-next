// @ts-check
// Result assembly for the pi-native bridge.
//
// Pure moves out of pi-native.js: usage aggregation, the usage/cost/capabilities
// event emission, the failure-kind classifier, and the success / error / aborted
// result-object factories. No session or run state lives here — every builder
// takes its inputs explicitly and returns the verbatim runtime-result contract
// (diagnostics key spellings, error fields, and shape unchanged — I9).

import { calculateContextTokens } from "@earendil-works/pi-agent-core";
import { isContextLimitError } from "../pi-errors.js";
import { isLikelyContextTermination } from "../../../agent/compaction.js";
import { isProviderAuthFailureText } from "../../failure.js";
import { structuredOutputRetryDiagnostics } from "./structured-output.js";

/**
 * Sum assistant-message usage across a transcript slice.
 * @param {Array<any>} [messages]
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number, cost: number}}
 */
export function usageFromMessages(messages = []) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const next = message.usage || {};
    usage.input += Number(next.input) || 0;
    usage.output += Number(next.output) || 0;
    usage.cacheRead += Number(next.cacheRead) || 0;
    usage.cacheWrite += Number(next.cacheWrite) || 0;
    usage.cost += Number(next.cost?.total) || 0;
  }
  return usage;
}

/**
 * Normalize one provider request's usage into an exact context snapshot.
 * Unlike usageFromMessages(), this deliberately does not aggregate earlier
 * requests in the run: the last assistant usage is the same provider-counted
 * value Pi's compaction logic trusts, so it can decrease after compaction.
 * @param {any} assistantMessage
 * @returns {{input: number, output: number, cacheRead: number, cacheCreation: number, total: number}|null}
 */
export function contextUsageFromAssistantMessage(assistantMessage) {
  if (assistantMessage?.role !== "assistant" || !assistantMessage.usage) return null;
  if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") return null;
  const total = Number(calculateContextTokens(assistantMessage.usage)) || 0;
  if (total <= 0) return null;
  return {
    input: Number(assistantMessage.usage.input) || 0,
    output: Number(assistantMessage.usage.output) || 0,
    cacheRead: Number(assistantMessage.usage.cacheRead) || 0,
    cacheCreation: Number(assistantMessage.usage.cacheWrite) || 0,
    total,
  };
}

/**
 * Classify a pi error message into a runtime failure kind. Context-window
 * overflows map to context_limit so the router can try the configured fallback;
 * max-turns terminations remain usage_limit. Credential/config auth failures
 * map to provider_auth; everything else to provider_unavailable. Null message → null.
 * @param {string|null} message
 * @param {Record<string, unknown>} diagnostics
 * @param {{maxTurnsHit?: boolean}} [opts]
 * @returns {string|null}
 */
export function failureKindForPiError(message, diagnostics, { maxTurnsHit = false } = {}) {
  if (!message) return null;
  if (maxTurnsHit) return "usage_limit";
  if (isContextLimitError(message) || isLikelyContextTermination(message, diagnostics)) return "context_limit";
  if (isProviderAuthFailureText(message)) return "provider_auth";
  return "provider_unavailable";
}

/**
 * Emit the per-run cache / cost / provider-completed events.
 * @param {{onEvent: (event: any) => void, resolved: any, reference: string, usage: {input: number, output: number, cacheRead: number, cacheWrite: number, cost: number}, estimatedCost: number, start: number, externalAbort: boolean}} params
 */
export function emitUsageCostEvents({
  onEvent,
  resolved,
  reference,
  usage,
  estimatedCost,
  start,
  externalAbort,
}) {
  if (usage.cacheRead > 0) {
    onEvent({ type: "cache_hit", sdk: resolved.sdk, model: reference, tokens: usage.cacheRead, source: "prompt_cache" });
  }
  if (usage.cacheWrite > 0) {
    onEvent({ type: "cache_miss", sdk: resolved.sdk, model: reference, tokens: usage.cacheWrite, source: "prompt_cache" });
  }
  onEvent({
    type: "cost_accumulated",
    sdk: resolved.sdk,
    model: reference,
    cumulativeUsd: Number(usage.cost) || Number(estimatedCost) || 0,
    tokens: {
      input: Number(usage.input) || 0,
      output: Number(usage.output) || 0,
      cacheReadTokens: Number(usage.cacheRead) || 0,
      cacheCreationTokens: Number(usage.cacheWrite) || 0,
    },
  });
  onEvent({
    type: "provider_request_completed",
    sdk: resolved.sdk,
    model: reference,
    runtime: "pi",
    timestamp: Date.now(),
    durationMs: Date.now() - start,
    cancelled: externalAbort,
  });
}

/**
 * Emit the capabilities_resolved event.
 * @param {(event: any) => void} onEvent
 * @param {{sdk: string, model: string, capabilitiesUsed: any}} payload
 */
export function emitCapabilitiesResolved(onEvent, { sdk, model, capabilitiesUsed }) {
  onEvent({ type: "capabilities_resolved", sdk, model, capabilitiesUsed });
}

/**
 * The aborted-run result (entry pre-check / pre-request abort). Pure factory.
 * @param {{resolved: any, options: any, events: any[], runtimeWarnings: any[], start: number, providerSessionId: string, piTransport: string}} params
 */
export function abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId, piTransport }) {
  return {
    text: null,
    thinking: "",
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: resolved?.reference || resolved?.model || null,
    effort: options.effort || null,
    sdk: resolved?.sdk || "pi",
    cancelled: true,
    error: null,
    failureKind: null,
    providerSessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: providerSessionId,
      pi_stop_reason: "aborted",
      pi_engine: "native",
      pi_transport_requested: piTransport,
      external_abort: true,
    },
  };
}

/**
 * The verbatim success-path result object (also carries a run-level error when
 * a turn ended in an error/max-turns/abort without throwing). Pure assembly.
 * @param {object} params
 */
export function buildSuccessResult(params) {
  const {
    finalText,
    finalThinking,
    events,
    usage,
    estimatedCost,
    start,
    turnCount,
    runAssistantCount,
    resolved,
    options,
    externalAbort,
    errorMessage,
    errorDetails,
    diagnostics,
    maxTurnsHit,
    providerSessionId,
    runtimeWarnings,
    capabilitiesUsed,
    structuredResult,
  } = params;
  return {
    text: finalText,
    thinking: finalThinking,
    events,
    usage: {
      input_tokens: usage.input || null,
      output_tokens: usage.output || null,
      cache_read_tokens: usage.cacheRead || null,
      cache_creation_tokens: usage.cacheWrite || null,
      cache_write_tokens: usage.cacheWrite || null,
      cost_usd: usage.cost || estimatedCost,
    },
    durationMs: Date.now() - start,
    numTurns: turnCount || runAssistantCount,
    model: resolved.reference || `pi:${resolved.provider}:${resolved.model}`,
    effort: options.effort || null,
    sdk: resolved.sdk,
    cancelled: externalAbort,
    error: errorMessage,
    errorDetails,
    failureKind: errorMessage
      ? failureKindForPiError(errorMessage, diagnostics, { maxTurnsHit })
      : null,
    providerSessionId,
    runtimeWarnings,
    diagnostics,
    capabilitiesUsed,
    ...(structuredResult !== null && structuredResult !== undefined
      ? { structuredResult, structuredResultSource: "StructuredOutput" }
      : { structuredResult: undefined, structuredResultSource: null }),
  };
}

/**
 * The verbatim outer-catch error result. Pure assembly.
 * @param {object} params
 */
export function buildErrorResult(params) {
  const {
    assistantTexts,
    events,
    start,
    turnCount,
    resolved,
    options,
    externalAbort,
    errorMessage,
    lastToolName,
    toolResultsSeen,
    maxTurnsHit,
    providerSessionId,
    runtimeWarnings,
    isRetryable,
    piTransport,
  } = params;
  return {
    text: assistantTexts.join("") || null,
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: turnCount,
    model: resolved?.reference || resolved?.model || null,
    effort: options.effort || null,
    sdk: resolved?.sdk || "pi",
    cancelled: externalAbort,
    error: externalAbort ? null : errorMessage,
    errorDetails: externalAbort ? null : {
      pi_stop_reason: "error",
      last_tool_name: lastToolName,
      tool_results_seen: toolResultsSeen,
      turn_count: turnCount,
      max_turns_hit: maxTurnsHit,
      provider_session_id: providerSessionId,
      pi_engine: "native",
      pi_transport_requested: piTransport,
      pi_error_retryable: isRetryable,
    },
    failureKind: externalAbort ? null : failureKindForPiError(errorMessage, {}, { maxTurnsHit }),
    providerSessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: providerSessionId,
      pi_stop_reason: externalAbort ? "aborted" : "error",
      pi_engine: "native",
      pi_transport_requested: piTransport,
      max_turns_hit: maxTurnsHit,
      turn_count: turnCount,
      external_abort: externalAbort,
    },
  };
}

/**
 * Assemble the success-path diagnostics object. Pure.
 * @param {object} params
 * @returns {Record<string, unknown>}
 */
export function buildDiagnostics(params) {
  const {
    providerSessionId,
    stopReason,
    maxTurnsHit,
    maxTurns,
    turnCount,
    runAssistantCount,
    externalAbort,
    maxRetries,
    piTransport,
    lastToolName,
    structuredRetry,
    contextCompactionDiagnostics,
  } = params;
  return {
    provider_session_id: providerSessionId,
    pi_stop_reason: stopReason,
    pi_engine: "native",
    max_turns_hit: maxTurnsHit,
    max_turns: Number.isFinite(Number(maxTurns)) ? Number(maxTurns) : null,
    turn_count: turnCount || runAssistantCount,
    external_abort: externalAbort,
    pi_max_retries: maxRetries,
    pi_transport_requested: piTransport,
    ...(lastToolName ? { last_tool_name: lastToolName } : {}),
    ...structuredOutputRetryDiagnostics(
      structuredRetry.attempts,
      structuredRetry.reason,
      structuredRetry.failed,
    ),
    ...contextCompactionDiagnostics,
  };
}

/**
 * Assemble the success-path errorDetails object (or null when no error). Pure.
 * @param {object} params
 * @returns {Record<string, unknown>|null}
 */
export function buildErrorDetails(params) {
  const {
    errorMessage,
    stopReason,
    lastToolName,
    toolResultsSeen,
    turnCount,
    runAssistantCount,
    maxTurnsHit,
    providerSessionId,
    structuredRetry,
    contextCompactionDiagnostics,
  } = params;
  if (!errorMessage) return null;
  return {
    pi_stop_reason: stopReason || "error",
    last_tool_name: lastToolName,
    tool_results_seen: toolResultsSeen,
    turn_count: turnCount || runAssistantCount,
    max_turns_hit: maxTurnsHit,
    provider_session_id: providerSessionId,
    pi_engine: "native",
    ...structuredOutputRetryDiagnostics(
      structuredRetry.attempts,
      structuredRetry.reason,
      structuredRetry.failed,
    ),
    ...contextCompactionDiagnostics,
  };
}

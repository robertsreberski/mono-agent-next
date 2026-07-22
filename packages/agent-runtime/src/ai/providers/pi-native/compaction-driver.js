// @ts-check
// Context auto-compaction for the pi-native bridge.
//
// AUTO-COMPACTION. pi-agent-core performs NO automatic in-loop compaction
// (shouldCompact/compact are exported helpers its loop never calls), so this
// bridge DRIVES it: proactively before a turn when the running model's context
// is near the window, and reactively (compact + single re-prompt) if a turn
// still overflows. The window auto-tracks the model actually serving the request
// and learns lower effective ceilings from numeric or generic overflow errors.
//
// DELEGATED to pi where pi provides the primitive: the proactive trigger
// DECISION runs through pi's shouldCompact() (via piCompactionSettings) and the
// context-size ESTIMATE runs through pi's estimateContextTokens(). Only the
// pieces pi does not model stay hand-rolled here: the DRIVING (pi never invokes
// compaction itself), the discovered-window ceiling learning, and the fixed
// per-request overhead (system prompt + tool schemas) that estimateContextTokens
// omits.
//
// Pure moves out of pi-native.js: the discovered-window cache (kept at MODULE
// scope, matching its bridge-level scope before the split), context estimation,
// the guarded tryCompact, the reactive candidate test, the live compaction
// policy resolution, and the proactive+reactive hooks. Per-run compaction state
// (applied / reactiveAttempted / compactedThisRun / policy / diagnostics) lives
// on the caller-owned runState.compaction.

import {
  buildSessionContext,
  calculateContextTokens,
  compact as compactPreparedContext,
  estimateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
  estimateFixedOverheadTokens,
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "../../../agent/compaction.js";
import {
  isContextLimitError,
  normalizePiErrorMessage,
  parseContextLimitFromError,
} from "../pi-errors.js";
import { appendStructuredOutputInstruction } from "./structured-output.js";
import { runHarnessPrompt } from "./turn-runner.js";

// Per-process cache of real context-window ceilings discovered from overflow
// errors, keyed by model reference/id. The long-running host re-learns quickly
// after a restart; this just spares repeated first-overflow round-trips.
const discoveredContextWindows = new Map();

function modelWindowKey(harness, runtime, resolved) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  return resolved?.reference || runtime?.model?.id || live?.id || "unknown";
}

// The window of the model that ACTUALLY serves this request: prefer the harness's
// live model (authoritative for native pi models), fall back to the resolved
// runtime model. Returns 0 when unknown so callers can skip the proactive trigger.
function liveModelContextWindow(harness, runtime) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  const win = Number(live?.contextWindow) || Number(runtime?.model?.contextWindow) || 0;
  return win > 0 ? win : 0;
}

function effectiveContextWindow(harness, runtime, resolved, contextWindowOverride) {
  const override = Number(contextWindowOverride);
  const declared = Number.isFinite(override) && override > 0
    ? override
    : liveModelContextWindow(harness, runtime);
  const discovered = discoveredContextWindows.get(modelWindowKey(harness, runtime, resolved));
  if (Number.isFinite(discovered) && discovered > 0) {
    return declared > 0 ? Math.min(declared, discovered) : discovered;
  }
  return declared;
}

function recordDiscoveredContextWindow(harness, runtime, resolved, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = modelWindowKey(harness, runtime, resolved);
  const existing = discoveredContextWindows.get(key);
  discoveredContextWindows.set(key, Number.isFinite(existing) && existing > 0 ? Math.min(existing, n) : n);
}

// Best-effort estimate of the current session's context size. The last assistant
// usage is authoritative (it reflects what the provider actually counted,
// including cache reads), but it can be stale/zero (e.g. seeded history), so we
// take the MAX of the usage-based count and pi's estimateContextTokens() over the
// transcript. Either being large is a reason to compact; overcounting only
// compacts slightly early.
//
// The transcript branch is DELEGATED to pi's estimateContextTokens(): it sums
// pi's own per-message estimateTokens across session.buildContext().messages,
// and when a message carries a VALID last-assistant usage it uses usage +
// trailing-message estimate instead of re-summing the whole transcript. Seeded /
// faux histories carry no valid usage (faux usage totals 0 tokens, which pi
// rejects), so it reduces to the pure per-message sum the bridge summed by hand
// before — a behaviour-neutral swap there, and a more provider-accurate estimate
// once real usage is present.
//
// `fixedOverheadTokens` is the system-prompt + tool-schema + per-turn user
// message overhead the provider meters but the transcript estimate (which covers
// only session.buildContext().messages) excludes. It is added to the ESTIMATE
// branch. The usage-based count already includes the prior request's system/tool
// overhead, but a proactive check runs before the current user turn is appended;
// `usageIncrementTokens` adds that new turn without double-counting the stable
// system/tool portion. With stale/0 usage and a seeded session the estimate
// branch wins, and without this the trigger under-counts the real request.
export async function estimateCurrentContextTokens(session, fixedOverheadTokens = 0, usageIncrementTokens = 0) {
  let usageTokens = 0;
  let rawTokens = 0;
  try {
    const usage = getLastAssistantUsage(await session.getEntries());
    if (usage) usageTokens = Number(calculateContextTokens(usage)) || 0;
  } catch { /* ignore — fall back to the transcript estimate */ }
  try {
    const context = await session.buildContext();
    const messages = context?.messages || [];
    const piEstimate = estimateContextTokens(messages);
    // When a valid provider usage record exists, Pi adds estimates for messages
    // trailing that record. Prefer that request-shaped count over the bare entry
    // usage gathered above.
    if (Number(piEstimate.usageTokens) > 0) {
      usageTokens = Number(piEstimate.tokens) || usageTokens;
    }
    // Keep the independent transcript branch genuinely usage-free. Calling
    // estimateContextTokens() here would fold provider usage in a second time,
    // then adding fixed overhead would double-count prior system/tool tokens.
    rawTokens = messages.reduce((total, message) => total + (Number(estimateTokens(message)) || 0), 0);
  } catch { /* ignore — usage-based estimate stands */ }
  // Apply the fixed overhead to the transcript estimate only (see note above).
  rawTokens += Number(fixedOverheadTokens) || 0;
  const currentUsageTokens = usageTokens > 0 ? usageTokens + (Number(usageIncrementTokens) || 0) : 0;
  if (currentUsageTokens === 0 && rawTokens === 0) return { tokens: 0, source: "unavailable" };
  return currentUsageTokens >= rawTokens
    ? { tokens: currentUsageTokens, source: "usage" }
    : { tokens: rawTokens, source: "estimate" };
}

// Compaction effectiveness must be measured independently of the provider's
// last-assistant usage. That usage can describe the pre-compaction request and
// remain attached to a retained message, making estimateContextTokens() report
// the old large value even after the transcript prefix was summarized. Summing
// pi's per-message estimator gives a stable before/after comparison over the
// actual context the session will build next.
async function estimateSessionMessageTokens(session) {
  if (!session || typeof session.buildContext !== "function") return null;
  try {
    const context = await session.buildContext();
    return (context?.messages || []).reduce((total, message) => total + (Number(estimateTokens(message)) || 0), 0);
  } catch {
    return null;
  }
}

function estimateBuiltContextTokens(branchEntries) {
  try {
    return buildSessionContext(branchEntries).messages.reduce(
      (total, message) => total + (Number(estimateTokens(message)) || 0),
      0,
    );
  } catch {
    return null;
  }
}

function piSummaryGenerationLimit(reserveTokens, isSplitTurn) {
  return Math.floor(0.8 * reserveTokens) + (isSplitTurn ? Math.floor(0.5 * reserveTokens) : 0);
}

/**
 * Pi derives its summary output limit from reserveTokens. A normal compaction
 * uses floor(0.8 * reserve); a split-turn compaction may generate both that
 * history summary and floor(0.5 * reserve) for the turn prefix. Return the
 * largest reserve whose derived generation budget does not exceed the public
 * summaryMaxTokens setting.
 * @param {number} summaryMaxTokens
 * @param {boolean} isSplitTurn
 */
export function piSummaryReserveTokens(summaryMaxTokens, isSplitTurn) {
  const budget = Math.max(1, Math.floor(Number(summaryMaxTokens) || 1));
  const factor = isSplitTurn ? 1.3 : 0.8;
  let reserve = Math.max(1, Math.floor(budget / factor));
  while (piSummaryGenerationLimit(reserve + 1, isSplitTurn) <= budget) reserve += 1;
  while (reserve > 1 && piSummaryGenerationLimit(reserve, isSplitTurn) > budget) reserve -= 1;
  return reserve;
}

function previewCompactedContext(branchEntries, result) {
  const previewEntry = {
    type: "compaction",
    id: "mono-agent-compaction-preview",
    parentId: branchEntries.at(-1)?.id || null,
    timestamp: new Date().toISOString(),
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    details: result.details,
    fromHook: true,
  };
  return estimateBuiltContextTokens([...branchEntries, previewEntry]);
}

function canonicalCompactionTrigger(trigger) {
  return trigger === "reactive_overflow" ? "overflow" : trigger;
}

function finiteTokenCount(value) {
  if (value === null || value === undefined) return undefined;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

/**
 * @param {((event: any) => void)|undefined} onEvent
 * @param {{operationId: string, status: string, trigger: string, model?: string, tokensBefore?: number|null, tokensAfter?: number|null, reason?: string, message?: string}} event
 */
function emitCompactionEvent(onEvent, {
  operationId,
  status,
  trigger,
  model,
  tokensBefore,
  tokensAfter,
  reason,
  message,
}) {
  const before = finiteTokenCount(tokensBefore);
  const after = finiteTokenCount(tokensAfter);
  try {
    onEvent?.({
      type: "context_compaction",
      operationId,
      status,
      sdk: "pi",
      trigger: canonicalCompactionTrigger(trigger),
      timestamp: Date.now(),
      ...(model ? { model } : {}),
      ...(before === undefined ? {} : { tokensBefore: before }),
      ...(after === undefined ? {} : { tokensAfter: after }),
      ...(before === undefined && after === undefined ? {} : { tokenCountsExact: false }),
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    });
  } catch {
    // Observability must never change whether compaction itself succeeds.
  }
}

// Run a single guarded compaction. Requires the harness idle (callers
// waitForIdle first). Never throws — classifies AgentHarnessError into a warning
// and reports back whether anything was compacted. Fires onCompactionRecorded on
// success so a host can persist the compaction row.
export async function tryCompact(harness, {
  trigger,
  onEvent,
  runtimeWarnings,
  onCompactionRecorded,
  runId,
  model,
  session,
  policy,
}) {
  const operationId = randomUUID();
  emitCompactionEvent(onEvent, {
    operationId,
    status: "running",
    trigger,
    model,
  });
  let effectivePolicy = policy || {};
  /** @type {null | {kind: string, tokensBefore?: number|null, tokensAfter?: number|null, savings?: number|null, error?: any}} */
  let hookDecision = null;
  let removeHook = null;
  try {
    const adaptivePolicy = resolveAgentCompactionPolicy({}, {
      contextWindow: typeof harness?.getModel === "function" ? harness.getModel()?.contextWindow : undefined,
    });
    effectivePolicy = { ...adaptivePolicy, ...(policy || {}) };
    if (typeof harness?.on !== "function") {
      throw new Error("Pi AgentHarness does not expose session_before_compact hooks");
    }
    removeHook = harness.on("session_before_compact", async (event) => {
      try {
        let settings = {
          enabled: true,
          reserveTokens: piSummaryReserveTokens(effectivePolicy.summaryMaxTokens, false),
          keepRecentTokens: effectivePolicy.keepRecentTokens,
        };
        let prepared = prepareCompaction(event.branchEntries, settings);
        if (prepared.ok === false) {
          hookDecision = { kind: "failed", error: prepared.error };
          return { cancel: true };
        }
        if (!prepared.value) {
          hookDecision = { kind: "nothing_to_compact" };
          return { cancel: true };
        }
        if (prepared.value.isSplitTurn) {
          settings = {
            ...settings,
            reserveTokens: piSummaryReserveTokens(effectivePolicy.summaryMaxTokens, true),
          };
          prepared = prepareCompaction(event.branchEntries, settings);
          if (prepared.ok === false) {
            hookDecision = { kind: "failed", error: prepared.error };
            return { cancel: true };
          }
          if (!prepared.value) {
            hookDecision = { kind: "nothing_to_compact" };
            return { cancel: true };
          }
        }
        const compacted = await compactPreparedContext(
          prepared.value,
          harness.models,
          harness.getModel(),
          event.customInstructions,
          event.signal,
          typeof harness.getThinkingLevel === "function" ? harness.getThinkingLevel() : undefined,
        );
        if (compacted.ok === false) {
          hookDecision = { kind: "failed", error: compacted.error };
          return { cancel: true };
        }
        const tokensBefore = estimateBuiltContextTokens(event.branchEntries);
        const tokensAfter = previewCompactedContext(event.branchEntries, compacted.value);
        const savings = tokensBefore === null || tokensAfter === null ? null : tokensBefore - tokensAfter;
        if (savings === null || savings <= 0) {
          hookDecision = { kind: "not_reducible", tokensBefore, tokensAfter, savings };
          return { cancel: true };
        }
        if (trigger === "proactive" && savings < effectivePolicy.compactionMinSavingsTokens) {
          hookDecision = { kind: "insufficient_savings", tokensBefore, tokensAfter, savings };
          return { cancel: true };
        }
        hookDecision = { kind: "accepted", tokensBefore, tokensAfter, savings };
        return { compaction: compacted.value };
      } catch (error) {
        hookDecision = { kind: "failed", error };
        return { cancel: true };
      }
    });
    const result = await harness.compact();
    const measuredTokensBefore = hookDecision?.tokensBefore ?? null;
    const tokensBefore = Number(result?.tokensBefore) || null;
    const measuredTokensAfter = await estimateSessionMessageTokens(session);
    const tokensAfter = measuredTokensAfter ?? hookDecision?.tokensAfter ?? null;
    const reduced = measuredTokensBefore === null || tokensAfter === null
      ? null
      : tokensAfter < measuredTokensBefore;
    emitCompactionEvent(onEvent, {
      operationId,
      status: "succeeded",
      trigger,
      model,
      tokensBefore,
      tokensAfter,
    });
    if (reduced === false) {
      runtimeWarnings?.push({
        warning_kind: "context_compaction_not_reducible",
        source: "pi",
        trigger,
        tokens_before: measuredTokensBefore,
        tokens_after: tokensAfter,
      });
    }
    if (typeof onCompactionRecorded === "function") {
      try {
        onCompactionRecorded({
          task_run_id: runId || null,
          trigger,
          provider_kind: "pi",
          model: model || null,
          tokens_before: tokensBefore,
          summary: result?.summary || "",
          first_kept_entry_id: result?.firstKeptEntryId || null,
          status: "succeeded",
          created_at: Date.now(),
        });
      } catch (err) {
        runtimeWarnings?.push({
          warning_kind: "context_compaction_record_failed",
          source: "pi",
          message: err?.message || String(err),
        });
      }
    }
    return { applied: true, tokensBefore, tokensAfter, reduced, nothingToCompact: false };
  } catch (err) {
    if (hookDecision?.kind === "not_reducible" || hookDecision?.kind === "insufficient_savings") {
      const warningKind = hookDecision.kind === "not_reducible"
        ? "context_compaction_not_reducible"
        : "context_compaction_insufficient_savings";
      runtimeWarnings?.push({
        warning_kind: warningKind,
        source: "pi",
        trigger,
        tokens_before: hookDecision.tokensBefore ?? null,
        tokens_after: hookDecision.tokensAfter ?? null,
        savings_tokens: hookDecision.savings ?? null,
        ...(hookDecision.kind === "insufficient_savings"
          ? { minimum_savings_tokens: effectivePolicy.compactionMinSavingsTokens }
          : {}),
      });
      emitCompactionEvent(onEvent, {
        operationId,
        status: "skipped",
        trigger,
        model,
        tokensBefore: hookDecision.tokensBefore,
        tokensAfter: hookDecision.tokensAfter,
        reason: hookDecision.kind,
      });
      return {
        applied: false,
        tokensBefore: hookDecision.tokensBefore ?? null,
        tokensAfter: hookDecision.tokensAfter ?? null,
        reduced: false,
        nothingToCompact: false,
      };
    }
    if (hookDecision?.kind === "nothing_to_compact") {
      runtimeWarnings?.push({
        warning_kind: "context_compaction_nothing_to_compact",
        source: "pi",
        trigger,
        message: "Nothing to compact",
      });
      emitCompactionEvent(onEvent, {
        operationId,
        status: "skipped",
        trigger,
        model,
        reason: "nothing_to_compact",
      });
      return { applied: false, tokensBefore: null, tokensAfter: null, reduced: null, nothingToCompact: true };
    }
    const effectiveError = hookDecision?.kind === "failed" && hookDecision.error
      ? hookDecision.error
      : err;
    const message = effectiveError?.message || String(effectiveError);
    const code = effectiveError?.code;
    const nothingToCompact = code === "compaction" && /nothing to compact/i.test(message);
    const warningKind = nothingToCompact
      ? "context_compaction_nothing_to_compact"
      : code === "auth"
        ? "context_compaction_auth_failed"
        : code === "busy"
          ? "context_compaction_busy"
          : "context_compaction_failed";
    runtimeWarnings?.push({ warning_kind: warningKind, source: "pi", trigger, message });
    emitCompactionEvent(onEvent, {
      operationId,
      status: nothingToCompact ? "skipped" : "failed",
      trigger,
      model,
      reason: nothingToCompact
        ? "nothing_to_compact"
        : code === "auth"
          ? "authentication"
          : code === "busy"
            ? "busy"
            : code === "aborted"
              ? "cancelled"
              : "provider_error",
      ...(nothingToCompact
        ? {}
        : {
          message: code === "auth"
            ? "Compaction authentication failed."
            : code === "busy"
              ? "Context was busy and could not be compacted."
              : code === "aborted"
                ? "Compaction was cancelled."
                : "Compaction failed.",
        }),
    });
    return { applied: false, tokensBefore: null, tokensAfter: null, reduced: null, nothingToCompact };
  } finally {
    removeHook?.();
  }
}

function isReactiveCompactionCandidate(errorMessage, diagnostics) {
  if (!errorMessage) return false;
  return isContextLimitError(errorMessage) || isLikelyContextTermination(errorMessage, diagnostics);
}

/**
 * Express the kernel's compaction policy as a pi `CompactionSettings` so the
 * proactive trigger runs through pi's own `shouldCompact()`.
 *
 * EQUIVALENCE (exact, proven by pi-native-compaction-parity.test.js): pi fires
 * when `contextTokens > contextWindow - reserveTokens` (STRICT `>`), while the
 * kernel policy fires when `estimate >= triggerTokens` (`>=`). Both `estimate`
 * and `triggerTokens` are non-negative INTEGERS — pi's `estimateTokens` /
 * `calculateContextTokens` return `Math.ceil(...)`/summed provider counts, and
 * `resolveAgentCompactionPolicy` builds `triggerTokens` with `Math.floor` — so
 * for integers `x >= t` iff `x > t - 1`. Setting
 *   `reserveTokens = contextWindow - triggerTokens + 1`
 * gives `contextWindow - reserveTokens = triggerTokens - 1`, hence
 *   `shouldCompact(x, window, s)` == `x > triggerTokens - 1` == `x >= triggerTokens`.
 * `triggerTokens < contextWindow` always (it is `min(floor(window*ratio),
 * window - reserve)` with `ratio <= 0.95`), so `reserveTokens >= 2` — never
 * degenerate. `keepRecentTokens` is carried through for a faithful settings
 * object even though `shouldCompact` ignores it.
 * @param {{enabled: boolean, contextWindow: number, triggerTokens: number, keepRecentTokens: number}} policy
 * @returns {{enabled: boolean, reserveTokens: number, keepRecentTokens: number}}
 */
export function piCompactionSettings(policy) {
  return {
    enabled: !!policy.enabled,
    reserveTokens: policy.contextWindow - policy.triggerTokens + 1,
    keepRecentTokens: policy.keepRecentTokens,
  };
}

/**
 * Resolve the compaction policy against the LIVE model's context window
 * (auto-recognized from the model actually serving the request, lowered by any
 * ceiling learned from a prior overflow). A positive `contextWindowOverride`
 * (from the typed `compaction` policy object) replaces provider metadata, but
 * process-local overflow evidence can still lower it. It is not a legacy
 * `settings` key, so it is applied here directly rather than through the
 * settings shim. Drives the proactive trigger + reactive recovery.
 * @param {{harness: any, runtime: any, resolved: any, settings: any, contextWindowOverride?: number}} params
 */
export function resolveLiveCompactionPolicy({ harness, runtime, resolved, settings, contextWindowOverride }) {
  const contextWindow = effectiveContextWindow(harness, runtime, resolved, contextWindowOverride);
  return resolveAgentCompactionPolicy(settings || {}, { contextWindow });
}

/**
 * Proactive compaction: if the session is already near the window, compact
 * BEFORE issuing the request so a long-lived session never overflows. Mutates
 * runState.compaction (applied / compactedThisRun / diagnostics) and re-anchors
 * runState.sessionBaselineCount when it fires.
 * @param {any} runState
 * @param {any} params
 */
export async function runProactiveCompaction(runState, {
  harness,
  systemPrompt,
  options,
  tools,
  promptText,
  promptImages,
  reference,
  onEvent,
  runtimeWarnings,
}) {
  const policy = runState.compaction.policy;
  if (!(policy.enabled && policy.contextWindow > 0 && !options.abortSignal?.aborted)) return;
  // Fixed per-request overhead the provider meters but the raw transcript
  // estimate excludes (system prompt + tool/MCP schemas + per-turn user
  // message + memory). Computed ONCE here from the same inputs the harness
  // sends to the provider, then folded into the raw estimate so the trigger
  // reflects the real request size. ON by default (this corrects a real
  // undercount that lets seeded sessions overflow); set
  // compaction.fixedOverheadEnabled:false to restore the prior transcript-only
  // trigger (overhead = 0). The flag is already resolved onto
  // policy.fixedOverheadEnabled, so read it there rather than re-sniffing the
  // raw settings bag. See estimateFixedOverheadTokens.
  //
  // Only the TRAILING per-turn user message is passed here, NOT
  // options.messages. The prior transcript is already summed by the raw
  // branch via session.buildContext().messages (priorMessages were seeded
  // into the session above), so passing the whole history would double-count
  // it. promptText/promptImages (from splitPromptMessages at the run head)
  // ARE the per-turn turn, so reconstruct that single message for the
  // estimate — matching estimateFixedOverheadTokens' "per-turn user
  // message(s)" contract.
  const perTurnContent = Array.isArray(promptImages) && promptImages.length > 0
    ? [{ type: "text", text: promptText }, ...promptImages]
    : promptText;
  const fixedOverhead = policy.fixedOverheadEnabled !== false
    ? estimateFixedOverheadTokens({
      systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema, options.prompts),
      tools,
      messages: [{ role: "user", content: perTurnContent }],
    })
    : { systemPromptTokens: 0, toolSchemaTokens: 0, userMessageTokens: 0, fixedOverheadTokens: 0 };
  const est = await estimateCurrentContextTokens(
    runState.session,
    fixedOverhead.fixedOverheadTokens,
    fixedOverhead.userMessageTokens,
  );
  // Record the complete request estimate on every proactive check, including
  // below-threshold runs. This is also the failed-request baseline used when a
  // provider reports a generic overflow without a numeric ceiling.
  Object.assign(runState.compaction.diagnostics, {
    context_compaction_estimate_source: est.source,
    context_window: policy.contextWindow,
    context_fixed_overhead_tokens: fixedOverhead.fixedOverheadTokens,
    context_system_prompt_tokens: fixedOverhead.systemPromptTokens,
    context_tool_schema_tokens: fixedOverhead.toolSchemaTokens,
    context_user_message_tokens: fixedOverhead.userMessageTokens,
    context_compaction_trigger_tokens: policy.triggerTokens,
    context_request_estimate_tokens: est.tokens,
    // Retained for compatibility with the diagnostics introduced in PR #489.
    context_transcript_estimate: est.tokens,
  });
  // DELEGATED trigger decision: pi's shouldCompact() with the policy mapped to
  // pi CompactionSettings (see piCompactionSettings — exact `>=`-preserving
  // mapping). Equivalent to the prior `est.tokens >= policy.triggerTokens`.
  if (shouldCompact(est.tokens, policy.contextWindow, piCompactionSettings(policy))) {
    await harness.waitForIdle();
    if (!options.abortSignal?.aborted) {
      const res = await tryCompact(harness, {
        trigger: "proactive",
        onEvent,
        runtimeWarnings,
        onCompactionRecorded: options.onCompactionRecorded,
        runId: options.runId,
        model: reference,
        session: runState.session,
        policy,
      });
      Object.assign(runState.compaction.diagnostics, {
        context_compaction_tokens_before: res.tokensBefore,
        context_compaction_tokens_after: res.tokensAfter,
        context_compaction_reduced: res.reduced,
      });
      if (res.applied) {
        runState.compaction.applied = true;
        runState.compaction.compactedThisRun = true;
        Object.assign(runState.compaction.diagnostics, {
          context_compaction_proactive: true,
        });
        // Compaction collapses the transcript prefix, so the pre-run baseline
        // no longer aligns. Re-anchor it to the compacted length so the run's
        // own turns (issued next) slice out correctly in captureState.
        runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
      }
    }
  }
}

/**
 * Reactive recovery: if the turn ended in a context overflow and we have not
 * already compacted-and-retried this run, compact once and re-prompt once.
 * Learns the real ceiling from the overflow error. Returns the (possibly
 * re-captured) state + runError.
 * @param {any} runState
 * @param {any} params
 * @returns {Promise<{state: any, runError: any}>}
 */
export async function runReactiveCompaction(runState, {
  harness,
  runtime,
  resolved,
  options,
  promptText,
  promptImages,
  reference,
  onEvent,
  runtimeWarnings,
  state,
  runError,
  captureState,
}) {
  const c = runState.compaction;
  if (!(
    c.policy?.enabled
    && !c.reactiveAttempted
    && !runState.externalAbort
    && !runState.maxTurnsHit
    && !options.abortSignal?.aborted
  )) {
    return { state, runError };
  }
  const provisionalRaw = state.stopReason === "error" || state.stopReason === "aborted"
    ? state.lastAssistant?.errorMessage || runError?.message || null
    : (runError ? runError.message || String(runError) : null);
  const provisionalError = normalizePiErrorMessage(provisionalRaw);
  if (provisionalError && isReactiveCompactionCandidate(provisionalError, c.diagnostics)) {
    c.reactiveAttempted = true;
    c.diagnostics.context_compaction_reactive_attempted = true;
    // Learn the real ceiling from the error so future runs trigger proactively
    // even when provider metadata was wrong. Numeric limits are authoritative;
    // a generic overflow lowers the process-local ceiling to 90% of the failed
    // request estimate so the next run creates meaningful headroom.
    const statedLimit = parseContextLimitFromError(provisionalError);
    const failedEstimate = await estimateCurrentContextTokens(
      runState.session,
      Number(c.diagnostics.context_fixed_overhead_tokens) || 0,
    );
    const learnedLimit = statedLimit
      || (failedEstimate.tokens > 0 ? Math.floor(failedEstimate.tokens * 0.90) : null);
    recordDiscoveredContextWindow(harness, runtime, resolved, learnedLimit);
    Object.assign(c.diagnostics, {
      context_failed_request_estimate_tokens: failedEstimate.tokens,
      context_learned_window: learnedLimit,
      context_learned_window_source: statedLimit ? "provider" : (learnedLimit ? "generic_overflow" : "unavailable"),
    });
    // A second compaction immediately after a fresh proactive one is almost
    // always "nothing to compact"; skip it and surface the original error.
    if (!c.compactedThisRun) {
      await harness.waitForIdle();
      const res = await tryCompact(harness, {
        trigger: "reactive_overflow",
        onEvent,
        runtimeWarnings,
        onCompactionRecorded: options.onCompactionRecorded,
        runId: options.runId,
        model: reference,
        session: runState.session,
        policy: c.policy,
      });
      Object.assign(c.diagnostics, {
        context_compaction_tokens_before: res.tokensBefore,
        context_compaction_tokens_after: res.tokensAfter,
        context_compaction_reduced: res.reduced,
      });
      if (res.applied) {
        c.applied = true;
        c.compactedThisRun = true;
        Object.assign(c.diagnostics, {
          context_compaction_reactive: true,
        });
        // Re-anchor the transcript baseline to the compacted length so the
        // re-prompt's turn (and its stopReason/usage) slices out correctly.
        runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
        // Re-prompt ONCE only after a verified positive reduction. Re-sending
        // an unchanged or unmeasurable oversized request only repeats the same
        // provider error.
        if (res.reduced === true) {
          const rerun = await runHarnessPrompt(harness, promptText, promptImages);
          runError = rerun.runError;
          state = await captureState();
        }
      }
    }
  }
  return { state, runError };
}

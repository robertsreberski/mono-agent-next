// Pi-NATIVE runtime bridge.
//
// This is the SOLE pi runtime path: the hand-rolled pi bridge (formerly
// pi-sdk.js, driving the low-level `Agent` with manual MCP init, transcript
// handling, compaction, a hand-rolled stream-retry loop, and session
// bookkeeping) was removed once this bridge reached parity. This bridge builds
// on pi-agent-core's high-level AgentHarness plus native primitives:
//
//   * AgentHarness OWNS a session and performs durable writes itself, so resume
//     is "open the session from a repo and hand it to a new harness". There is
//     no separate live-session registry here.
//   * The provider transport (pi-ai streamSimple) is invoked by the harness;
//     retry/backoff is delegated to pi-ai via streamOptions.maxRetries instead
//     of the legacy manual loop.
//   * Tool sandboxing, approval gates, allowlist/bloat filtering, and the MCP
//     tool bridge are reused shared pieces — they are wired into the harness
//     via its `tools` option, never reimplemented.
//
// The result/event contract is the package's unified runtime-result shape, so
// callers and the test suite see the same artifact the retired bridge produced.

import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { randomUUID } from "node:crypto";
import { estimateCost } from "../cost.js";
import { retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import {
  deprecatedSettingsWarning,
  resolveAgentCompactionPolicy,
  resolveRuntimePolicyInputs,
} from "../../agent/compaction.js";
import { closePiMcpClients } from "../../agent/tools/pi-bridge.js";
import { createApprovalManager } from "../../agent/approval.js";
import { buildCapabilitiesUsed, toolCompactionAppliedFromWarnings } from "../runtime/capabilities-used.js";
import { reasoningLevelsForPiModel, resolvePiRuntimeModel } from "./pi-models.js";
import {
  textFromContent,
  thinkingFromContent,
  toAgentMessages,
} from "./pi-messages.js";
import { emitCaptured } from "./pi-events.js";
import { normalizePiErrorMessage } from "./pi-errors.js";
import {
  runStructuredOutputFinalizationRetry,
  shouldRetryStructuredOutputFinalization,
} from "./pi-native/structured-output.js";
import {
  abortedResult,
  buildDiagnostics,
  buildErrorDetails,
  buildErrorResult,
  buildSuccessResult,
  emitCapabilitiesResolved,
  emitUsageCostEvents,
  usageFromMessages,
} from "./pi-native/result-builder.js";
import {
  cleanupSessionOnThrow,
  commitSession,
  discardUncommittedSession,
  resolveDurableNativeSessionRepo,
  resolveSession,
  rollbackAbortedTurn,
} from "./pi-native/session-lifecycle.js";
import {
  resolveLiveCompactionPolicy,
  runProactiveCompaction,
  runReactiveCompaction,
} from "./pi-native/compaction-driver.js";
import {
  buildTurnHarness,
  buildTurnTools,
  runHarnessPrompt,
  startLiveInput,
  thinkingLevelForEffort,
} from "./pi-native/turn-runner.js";
import { resolvePiTransport } from "./pi-native/transport.js";

async function resolveApiKey(provider, { apiKeys, resolvePiApiKey, runtimeWarnings }) {
  if (apiKeys?.has(provider)) return apiKeys.get(provider);
  if (typeof resolvePiApiKey !== "function") return undefined;
  try {
    return await resolvePiApiKey(provider);
  } catch (err) {
    runtimeWarnings.push({
      warning_kind: "pi_auth_failed",
      provider,
      message: err?.message || String(err),
    });
    return undefined;
  }
}

async function readCredential(provider, { apiKeys, resolvePiApiKey, runtimeWarnings }) {
  if (apiKeys?.has(provider)) {
    const key = apiKeys.get(provider);
    return typeof key === "string" && key.length > 0 ? { type: "api_key", key } : undefined;
  }
  if (typeof resolvePiApiKey?.readCredential === "function") {
    const credential = await resolvePiApiKey.readCredential(provider);
    return isCredential(credential) ? credential : undefined;
  }
  const key = await resolveApiKey(provider, { apiKeys, resolvePiApiKey, runtimeWarnings });
  return typeof key === "string" && key.length > 0 ? { type: "api_key", key } : undefined;
}

function isCredential(credential) {
  return credential
    && typeof credential === "object"
    && (credential.type === "api_key" || credential.type === "oauth");
}

// pi 0.80 removed the harness `getApiKeyAndHeaders` hook: request auth now
// resolves through a `Models` collection's `CredentialStore`. This store keeps
// the bridge's per-run key-resolution contract intact — an `apiKeys` map entry
// wins, else an enhanced host resolver's credential-store methods are used, else
// the legacy `resolvePiApiKey(provider)` callback is consulted. Legacy callback
// failures remain soft (`pi_auth_failed` warning + keyless env fallback);
// credential-store read/modify failures reject so Pi can surface them as auth
// storage failures instead of silently treating a corrupt store as no credential.
export function createDynamicCredentialStore(apiKeys, resolvePiApiKey, runtimeWarnings) {
  const read = async (providerId) => readCredential(providerId, { apiKeys, resolvePiApiKey, runtimeWarnings });
  return /** @type {any} */ ({
    read,
    async modify(providerId, fn) {
      if (!apiKeys?.has(providerId) && typeof resolvePiApiKey?.modifyCredential === "function") {
        return resolvePiApiKey.modifyCredential(providerId, fn);
      }
      const current = await read(providerId);
      const next = await fn(current);
      if (apiKeys?.has(providerId) && next?.type === "api_key" && typeof next.key === "string") {
        apiKeys.set(providerId, next.key);
      }
      return next ?? current;
    },
    async delete(providerId) {
      if (apiKeys?.has(providerId)) {
        apiKeys.delete(providerId);
        return;
      }
      if (typeof resolvePiApiKey?.deleteCredential === "function") {
        await resolvePiApiKey.deleteCredential(providerId);
      }
    },
  });
}

// Assemble the pi 0.80 `Models` collection serving this run. Builtin models
// reuse pi's own provider factories (correct per-provider baseUrl/headers and
// env-var fallback); a custom OpenAI-completions provider is registered from the
// resolved model. `piResolvedModels` is an advanced/test seam mirroring
// `piResolvedModel`: when supplied it is used verbatim (the model dispatched via
// `piResolvedModel` may live outside pi's builtin catalog, e.g. a faux model).
function buildRunModels(runtime, options, runtimeWarnings) {
  if (options.piResolvedModels) return options.piResolvedModels;
  const credentials = createDynamicCredentialStore(runtime.apiKeys, options.resolvePiApiKey, runtimeWarnings);
  if (options.customProvider) {
    const model = runtime.model;
    const models = createModels({ credentials });
    models.setProvider(createProvider({
      id: model.provider,
      name: model.name || model.provider,
      baseUrl: model.baseUrl,
      auth: { apiKey: envApiKeyAuth(model.name || model.provider, []) },
      models: [model],
      api: openAICompletionsApi(),
    }));
    return models;
  }
  return builtinModels({ credentials });
}

// Normalize the incoming runtime messages into AgentMessages the harness can
// seed/prompt. Returns the prior messages (appended to the session before the
// run) and the final user text used to drive `harness.prompt`.
export function splitPromptMessages(messages, model) {
  const source = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: "" }];
  // The harness `prompt` takes the trailing user turn; everything before it is
  // seeded as transcript context.
  let lastUserIndex = -1;
  for (let i = source.length - 1; i >= 0; i -= 1) {
    if (source[i]?.role === "user") { lastUserIndex = i; break; }
  }
  if (lastUserIndex === -1) {
    // No user turn: seed everything (structure preserved), nothing to prompt.
    return { priorMessages: toAgentMessages(source, model), promptText: "", promptImages: [] };
  }
  // Prior turns: preserve structure (incl. image blocks) via toAgentMessages
  // instead of stringifying — this is the format the harness seeds from.
  const priorMessages = lastUserIndex > 0 ? toAgentMessages(source.slice(0, lastUserIndex), model) : [];
  // Final user turn: split into plain text + structured images so harness.prompt
  // can receive them as ImageContent[] rather than a JSON-stringified blob.
  const { text, images } = splitUserContent(source[lastUserIndex].content);
  return { priorMessages, promptText: text, promptImages: images };
}

// Split a user message's content into joined text and ImageContent[] image
// parts ({ type, data, mimeType }), preserving multimodal input for the runtime.
function splitUserContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ""), images: [] };
  const texts = [];
  const images = [];
  for (const part of content) {
    if (typeof part === "string") { texts.push(part); continue; }
    if (part?.type === "text" && typeof part.text === "string") { texts.push(part.text); continue; }
    if (part?.type === "image" && part.data) {
      images.push({ type: "image", data: part.data, mimeType: part.mimeType || part.mime_type || "image/png" });
      continue;
    }
    texts.push(JSON.stringify(part ?? ""));
  }
  return { text: texts.join("\n"), images };
}

export async function generatePiNativeResponse(systemPrompt, options = {}) {
  const resolved = options.model;
  const start = Date.now();
  const events = [];
  const runtimeWarnings = [];
  let mcpClients = [];
  let closeRunTools = async () => {};
  let harness = null;
  // The ONE explicit runState the extracted modules (stream subscriber, session
  // lifecycle, compaction driver, turn runner, result builder) read/write.
  // Reassignable scalars/refs live here so a module can rebind them (an
  // orchestrator local cannot be reassigned from a module). `events` /
  // `runtimeWarnings` stay as consts shared by reference. `toolStartTimes` maps
  // toolCallId -> start timestamp so per-tool execution latency can be emitted.
  const runState = {
    assistantTexts: [],
    assistantThinking: [],
    textDeltaIndexes: new Set(),
    thinkingDeltaIndexes: new Set(),
    toolStartTimes: new Map(),
    turnCount: 0,
    toolResultsSeen: 0,
    lastToolName: null,
    maxTurnsHit: false,
    // Populated by the StructuredOutput tool callback (built in the turn runner);
    // read by the finalization retry predicate and the result assembly.
    structuredResult: null,
    // Set by the turn-runner abort handler; the OUTER catch and lifecycle
    // decisions re-check it (`externalAbort ||= aborted`). removeAbortHandler is
    // installed by the turn runner and cleared in finally; harness is set there
    // too.
    externalAbort: false,
    removeAbortHandler: null,
    harness: null,
    // Auto-compaction sub-state. The policy is (re)computed at the decision
    // point against the model actually serving the request; these flags track
    // whether a compaction fired so the run reports context_compaction_applied
    // honestly and never double-compacts.
    compaction: {
      applied: false,
      reactiveAttempted: false,
      compactedThisRun: false,
      policy: null,
      diagnostics: {},
    },
    session: null,
    sessionEntry: null,
    // True when a requestedSessionId had no live entry AND no durable transcript,
    // so a fresh durable session was created under that id (cross-restart resume,
    // first turn for the conversation). Distinct from a true resume (sessionEntry
    // set): the on-disk transcript is empty, so prior messages must still be
    // seeded — unlike a resume, where the session already holds them.
    createdOnMiss: false,
    // The create-on-miss BUSY reservation handle (R8 concurrent-first-turn
    // reservation) when the create path inserted its placeholder; null
    // otherwise. Its release()/commit() clean the placeholder on the
    // drop/error/abort/keep-alive paths, since createdOnMiss leaves sessionEntry
    // null so the finally's busy-clear does not cover it.
    reservation: null,
    sessionBaselineCount: 0,
    // Leaf captured before a resumed turn runs, so a failed resume can be rolled
    // back to the last good transcript via moveTo. On runState so the OUTER catch
    // (host/runtime-side throws after the session mutated) can roll back too, not
    // just the success path.
    baselineLeafId: null,
  };

  const providerSessionId = options.sessionId
    || options.providerSessionId
    || options.runId
    || randomUUID();
  // Prefer the explicit sessionId, but fall back to providerSessionId so a caller
  // that only supplies providerSessionId still resumes the prior session instead
  // of being treated as a fresh run (which would drop prior context).
  const requestedSessionId = typeof options.sessionId === "string" && options.sessionId.trim()
    ? options.sessionId
    : (typeof options.providerSessionId === "string" && options.providerSessionId.trim()
      ? options.providerSessionId
      : null);
  // Bridge TTL is a backstop behind the host's session policy; the grace
  // keeps host-side lazy expiry firing first.
  const sessionTtlMs = Number.isFinite(Number(options.sessionIdleTimeoutMs))
    ? Number(options.sessionIdleTimeoutMs) + 60_000
    : undefined;
  let structuredOutputFinalizationRetryAttempts = 0;
  let structuredOutputFinalizationRetryReason = null;
  let structuredOutputFinalizationRetryFailed = false;
  const piTransport = resolvePiTransport(options.piTransport);

  const onEvent = (event) => emitCaptured(events, options.onEvent, event);
  const approvalManager = options.onToolApprovalRequest
    ? createApprovalManager({
      onToolApprovalRequest: options.onToolApprovalRequest,
      defaultRiskTier: options.approvalDefaultRiskTier,
      timeoutMs: options.approvalTimeoutMs,
      onEvent,
      riskTiersByTool: options.toolRiskTiers,
      alwaysAllowTools: options.approvalAlwaysAllowTools,
    })
    : null;

  if (options.abortSignal?.aborted) {
    return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId, piTransport });
  }

  const durableRepo = resolveDurableNativeSessionRepo(options.piSessionsRoot);

  try {
    // Resume the session (warm registry hit, durable cold reopen, or
    // create-on-miss for a durable cross-restart first turn) or create a fresh
    // one. resolveSession mutates runState.session / sessionEntry / createdOnMiss
    // / reservation, and returns an early fast-fail result (session_not_found /
    // session_busy) to return verbatim. Its liveness claims (I1 busy-claim, R8
    // reservation, F4 cold-reopen re-read) are await-free by construction. A
    // session miss stays cheap: no tool/MCP/harness init runs before this
    // fast-fail.
    const resolvedSession = await resolveSession(runState, {
      requestedSessionId,
      providerSessionId,
      durableRepo,
      sessionTtlMs,
      cwd: options.cwd,
      resolved,
      options,
      events,
      runtimeWarnings,
      start,
      piTransport,
    });
    if (resolvedSession.done) return resolvedSession.result;

    // `piResolvedModel` is an advanced/test seam: when supplied it provides a
    // ready pi-ai Model (e.g. a registered faux provider model) plus optional
    // capabilities, bypassing the static model-registry lookup. Production
    // callers leave it undefined and resolve through pi-ai's registry.
    const runtime = options.piResolvedModel
      ? {
        model: options.piResolvedModel,
        capabilities: options.piResolvedCapabilities || {
          tool_use: true,
          reasoning: !!options.piResolvedModel.reasoning,
          reasoning_mode: options.piResolvedModel.reasoning ? "effort" : "none",
          reasoning_levels: options.piResolvedModel.reasoning
            ? reasoningLevelsForPiModel(options.piResolvedModel)
            : undefined,
          json_mode: true,
        },
        apiKeys: new Map(),
      }
      : resolvePiRuntimeModel(resolved, options);
    const capabilities = runtime.capabilities || {};
    const effectiveThinkingLevel = thinkingLevelForEffort(options.effort || "medium", capabilities);
    const reference = resolved.reference
      || (resolved.sdk === "pi" ? `pi:${resolved.provider}:${resolved.model}` : `${resolved.sdk}:${resolved.model}`);

    // Resolve the typed `toolLimits` / `compaction` policy objects against the
    // deprecated `settings` fallback (per-group precedence: a present typed
    // object wins and its group's legacy keys are ignored; an absent object
    // falls back to `settings`). Consuming any legacy key emits exactly one
    // deprecation warning per run. mono-agent never passes `settings`, so this
    // is a no-op there; the shim exists for worklab's day-one port.
    const { settingsLike, consumedSettingsKeys } = resolveRuntimePolicyInputs({
      toolLimits: options.toolLimits,
      compaction: options.compaction,
      settings: options.settings,
    });
    if (consumedSettingsKeys.length > 0) {
      const warning = deprecatedSettingsWarning(consumedSettingsKeys);
      runtimeWarnings.push(warning);
      onEvent({ type: "runtime_warning", ...warning });
    }

    // Tool-output limits (clamps for tool/MCP payloads). The legacy pi-sdk bridge
    // wired these via the compaction manager's `.policy`; resolveAgentCompactionPolicy
    // is pure (no manager/Agent), so we compute the same policy directly from the
    // resolved settings-like inputs and pass it into the tool builders + display
    // normalization. Restores configurable clamping (toolTextLimitChars,
    // searchResultLimit, ...) on top of the 256KB hard ceiling.
    const toolLimits = resolveAgentCompactionPolicy(settingsLike, runtime.model);

    // Build the turn's tools (builtins + MCP bridge + StructuredOutput). The
    // StructuredOutput callback writes runState.structuredResult; the MCP clients
    // are closed in the finally.
    const {
      tools,
      structuredTool,
      mcpClients: builtMcpClients,
      closeRunTools: builtCloseRunTools,
    } = await buildTurnTools(runState, {
      options,
      capabilities,
      toolLimits,
      approvalManager,
      runtime,
      resolved,
      onEvent,
      runtimeWarnings,
    });
    mcpClients = builtMcpClients;
    closeRunTools = builtCloseRunTools;

    // Provider retry/backoff is delegated to pi-ai via streamOptions, replacing
    // the legacy hand-rolled stream-retry loop.
    const maxRetries = Number.isFinite(Number(options.piMaxRetries))
      ? Math.max(0, Math.min(8, Number(options.piMaxRetries)))
      : 2;
    const maxRetryDelayMs = Number.isFinite(Number(options.maxRetryDelayMs))
      ? Number(options.maxRetryDelayMs)
      : 60_000;
    // Tool steering: default "one-at-a-time" (safe, deterministic ordering).
    // Opt-in "all" lets pi-agent-core run a model step's tool calls concurrently
    // (QueueMode). Only enable when tools in a step are independent.
    const toolSteeringMode = options.piToolParallelismMode === "all" ? "all" : "one-at-a-time";

    const piModels = buildRunModels(runtime, options, runtimeWarnings);

    // Construct the harness, subscribe the stream normalizer, and wire the
    // external abort handler (which sets runState.externalAbort and aborts the
    // harness). Sets runState.harness + runState.removeAbortHandler.
    harness = buildTurnHarness(runState, {
      cwd: options.cwd,
      session: runState.session,
      piModels,
      model: runtime.model,
      thinkingLevel: effectiveThinkingLevel,
      systemPrompt,
      outputSchema: options.outputSchema,
      tools,
      transport: piTransport,
      maxRetries,
      maxRetryDelayMs,
      steeringMode: toolSteeringMode,
      onEvent,
      options,
      toolLimits,
      sdk: resolved.sdk,
      reference,
    });

    // Seed prior transcript (everything before the trailing user turn) into the
    // harness-owned session. On a true resume the session already holds the
    // transcript, so prior messages are skipped; a fresh run AND a create-on-miss
    // (requestedSessionId set but the durable session was just created empty)
    // both seed, since their on-disk transcript is empty.
    const { priorMessages, promptText, promptImages } = splitPromptMessages(options.messages, runtime.model);
    runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
    if (!requestedSessionId || runState.createdOnMiss) {
      for (const message of priorMessages) {
        await harness.appendMessage(message);
        runState.sessionBaselineCount += 1;
      }
    }
    // The harness persists each turn INLINE into the live session. To preserve
    // the legacy "a failed resumed turn does not corrupt the session" contract,
    // remember the leaf before the run so a failed resume can be rolled back to
    // the last good transcript via the session tree's moveTo primitive. Only a
    // TRUE resume needs this: a create-on-miss session is fresh, so a failure
    // drops it entirely via the fresh-run path (no leaf to roll back to).
    if (requestedSessionId && !runState.createdOnMiss) {
      try { runState.baselineLeafId = await runState.session.getLeafId(); } catch { /* best-effort */ }
    }

    // Live steering: consume follow-up messages and steer the harness mid-run.
    // The consumer is tied to run completion so it stops steering once the run
    // finishes and does not swallow messages meant for a later turn.
    const liveInput = startLiveInput({ harness, options, onEvent });

    // Re-check abort right before issuing the provider request. The abort
    // handler is only installed at ~:639, AFTER a long stretch of awaited setup
    // (reopen, create, MCP init, buildContext, appendMessage, getLeafId). If
    // abort fired DURING any of those awaits the listener was not yet attached,
    // so the event was dropped and no run is active for harness.abort() to
    // target. Without this re-check a full provider/LLM request would be issued
    // for a run the caller already aborted (mirrors the entry pre-check at ~:356).
    if (options.abortSignal?.aborted) {
      // Drop a freshly-created non-keep-alive session (and any create-on-miss
      // reservation) so an aborted-before-run turn does not leave an orphan
      // jsonl / leaked busy placeholder. discardUncommittedSession guards
      // `session && !sessionEntry` so a resumed (user-owned) session is NEVER
      // deleted; the finally clears sessionEntry.busy, removes the abort handler,
      // and closes MCP clients. For a resume no transcript was appended yet
      // (prompt never ran), so the live session needs no rollback.
      await discardUncommittedSession(runState, { durableRepo });
      return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId, piTransport });
    }

    // Compaction policy against the LIVE model's context window, then proactive
    // compaction: if the session is already near the window, compact BEFORE
    // issuing the request so a long-lived session never overflows.
    runState.compaction.policy = resolveLiveCompactionPolicy({
      harness,
      runtime,
      resolved,
      settings: settingsLike,
      contextWindowOverride: options.compaction?.contextWindowOverride,
    });
    await runProactiveCompaction(runState, {
      harness,
      systemPrompt,
      options,
      tools,
      promptText,
      promptImages,
      reference,
      onEvent,
      runtimeWarnings,
    });

    onEvent({
      type: "provider_request_started",
      sdk: resolved.sdk,
      model: reference,
      runtime: "pi",
      timestamp: Date.now(),
    });

    let { runError } = await runHarnessPrompt(harness, promptText, promptImages);

    // The run is done: stop the live-steering consumer so it cannot steer a
    // finished harness or swallow a follow-up meant for the next turn.
    await liveInput.stop();

    runState.externalAbort ||= !!options.abortSignal?.aborted;

    const captureState = async () => {
      const context = await runState.session.buildContext();
      const transcript = context.messages || [];
      const runTranscript = transcript.slice(runState.sessionBaselineCount);
      const assistantMessages = runTranscript.filter((message) => message?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      return {
        transcript,
        runTranscript,
        assistantMessages,
        lastAssistant,
        stopReason: lastAssistant?.stopReason || null,
        finalText: textFromContent(lastAssistant?.content) || runState.assistantTexts.join(""),
        finalThinking: thinkingFromContent(lastAssistant?.content) || runState.assistantThinking.join(""),
      };
    };

    let state = await captureState();

    // Structured-output finalization retry: if the turn ended with neither
    // text nor a StructuredOutput call, re-prompt ONCE in the same session with
    // only StructuredOutput active so the model can submit the required result.
    // This replicates the legacy bridge's single re-prompt via the harness's
    // followUp + setActiveTools instead of the low-level agent.continue() loop.
    if (!runError && shouldRetryStructuredOutputFinalization({
      outputSchema: options.outputSchema,
      structuredResult: runState.structuredResult,
      finalText: state.finalText,
      stopReason: state.stopReason,
      externalAbort: runState.externalAbort,
      maxTurnsHit: runState.maxTurnsHit,
    })) {
      const retry = await runStructuredOutputFinalizationRetry({ harness, structuredTool, runtimeWarnings, prompts: options.prompts });
      structuredOutputFinalizationRetryAttempts = retry.attempts;
      structuredOutputFinalizationRetryReason = retry.reason;
      structuredOutputFinalizationRetryFailed = runState.structuredResult === null || runState.structuredResult === undefined;
      state = await captureState();
    }

    // Reactive recovery: if the turn ended in a context overflow and we have not
    // already compacted-and-retried this run, compact once and re-prompt once
    // (and re-capture state). Learns the real window ceiling from the error.
    ({ state, runError } = await runReactiveCompaction(runState, {
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
    }));

    const { runTranscript, lastAssistant, stopReason, finalText, finalThinking } = state;
    const runAssistantCount = state.assistantMessages.length;

    const usage = usageFromMessages(runTranscript);
    const estimatedCost = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    });
    emitUsageCostEvents({
      onEvent,
      resolved,
      reference,
      usage,
      estimatedCost,
      start,
      externalAbort: runState.externalAbort,
    });

    const rawErrorMessage = runState.externalAbort
      ? null
      : runState.maxTurnsHit
        ? "Pi agent stopped before final output: max turns reached"
        : (stopReason === "error" || stopReason === "aborted"
          ? lastAssistant?.errorMessage || runError?.message || "Pi agent aborted before final output"
          : (runError ? runError.message || String(runError) : null));
    const errorMessage = normalizePiErrorMessage(rawErrorMessage);

    const structuredRetry = {
      attempts: structuredOutputFinalizationRetryAttempts,
      reason: structuredOutputFinalizationRetryReason,
      failed: structuredOutputFinalizationRetryFailed,
    };
    const diagnostics = buildDiagnostics({
      providerSessionId,
      stopReason,
      maxTurnsHit: runState.maxTurnsHit,
      maxTurns: options.maxTurns,
      turnCount: runState.turnCount,
      runAssistantCount,
      externalAbort: runState.externalAbort,
      maxRetries,
      piTransport,
      lastToolName: runState.lastToolName,
      structuredRetry,
      contextCompactionDiagnostics: runState.compaction.diagnostics,
    });
    const errorDetails = buildErrorDetails({
      errorMessage,
      stopReason,
      lastToolName: runState.lastToolName,
      toolResultsSeen: runState.toolResultsSeen,
      turnCount: runState.turnCount,
      runAssistantCount,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      structuredRetry,
      contextCompactionDiagnostics: runState.compaction.diagnostics,
    });

    const capabilitiesUsed = buildCapabilitiesUsed({
      promptCacheActive: usage.cacheRead > 0 || usage.cacheWrite > 0,
      thinkingEnabled: effectiveThinkingLevel !== "off" && effectiveThinkingLevel !== "low",
      structuredOutputEnforced: !!options.outputSchema,
      subagentInvoked: false,
      mcpServersUsed: mcpClients.map((entry) => entry?.name).filter(Boolean),
      nativeSubagentsUsed: [],
      toolCompactionApplied: toolCompactionAppliedFromWarnings(runtimeWarnings),
      // Tristate: true = a compaction fired this run (proactive or reactive),
      // false = the path is enabled but did not need to fire, null = disabled via
      // runtime.compaction.enabled. See docs/reference/feature-registry.md runtime.context-compaction.
      contextCompactionApplied: runState.compaction.policy?.enabled ? runState.compaction.applied : null,
    });
    emitCapabilitiesResolved(onEvent, { sdk: resolved.sdk, model: reference, capabilitiesUsed });

    // Re-check the abort signal: a cancel can land during the post-run work above
    // (live-input teardown, structured-output finalization retry) after the line
    // ~780 check. Pick it up here so the lifecycle decision below rolls back the
    // cancelled turn instead of committing it into a durable transcript a later
    // resume would replay.
    runState.externalAbort ||= !!options.abortSignal?.aborted;

    // Session lifecycle parity with the legacy bridge. The harness already
    // durably persisted the transcript into its session object (in-memory for
    // the default repo, jsonl on disk when piSessionsRoot is set); commitSession
    // tracks LIVENESS so disposeProviderSession / idle-TTL eviction can reach
    // native sessions, keep-alive registers the session, and a failed/aborted
    // resumed turn rolls back to its pre-turn leaf.
    await commitSession(runState, {
      options,
      requestedSessionId,
      providerSessionId,
      durableRepo,
      sessionTtlMs,
      externalAbort: runState.externalAbort,
      errorMessage,
      onEvent,
    });

    // Final abort guard (durable cancel TOCTOU): if a cancel raced the lifecycle
    // commit above — landing AFTER the keep-alive/!externalAbort decision but
    // before this return — the cancelled turn is still in the durable transcript
    // and (for keep-alive) the live registry. Roll it back so the next resume sees
    // the pre-turn state (rollbackAbortedTurn: a resumed session moves to its
    // baseline leaf and drops its live entry; a fresh durable session deletes its
    // jsonl). The abort re-check + return stay inline with NO await between the
    // false-branch check and the return, so an external cancel cannot newly fire
    // past it (I10).
    if (!runState.externalAbort && options.abortSignal?.aborted) {
      runState.externalAbort = true;
      await rollbackAbortedTurn(runState, { requestedSessionId, providerSessionId, durableRepo });
    }

    return buildSuccessResult({
      finalText,
      finalThinking,
      events,
      usage,
      estimatedCost,
      start,
      turnCount: runState.turnCount,
      runAssistantCount,
      resolved,
      options,
      externalAbort: runState.externalAbort,
      errorMessage,
      errorDetails,
      diagnostics,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      runtimeWarnings,
      capabilitiesUsed,
      structuredResult: runState.structuredResult,
    });
  } catch (err) {
    runState.externalAbort ||= !!options.abortSignal?.aborted;
    // Drop a just-created fresh durable session, release a create-on-miss
    // reservation placeholder, and roll a resumed session back to its pre-turn
    // leaf for host/runtime-side throws that landed after the harness already
    // mutated the live session (guards preserved in cleanupSessionOnThrow).
    await cleanupSessionOnThrow(runState, { durableRepo });
    const errorMessage = normalizePiErrorMessage(err?.message || String(err));
    const isRetryable = retryableProviderFailureInfo({
      errorText: errorMessage,
      failureKind: "provider_unavailable",
    }).retryable;
    return buildErrorResult({
      assistantTexts: runState.assistantTexts,
      events,
      start,
      turnCount: runState.turnCount,
      resolved,
      options,
      externalAbort: runState.externalAbort,
      errorMessage,
      lastToolName: runState.lastToolName,
      toolResultsSeen: runState.toolResultsSeen,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      runtimeWarnings,
      isRetryable,
      piTransport,
    });
  } finally {
    if (runState.sessionEntry) runState.sessionEntry.busy = false;
    runState.removeAbortHandler?.();
    try {
      await closeRunTools();
    } finally {
      await closePiMcpClients(mcpClients);
    }
  }
}

export const piNativeRuntimeBridge = {
  id: "pi",
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  supports: (ref) => ref?.sdk === "pi",
  execute: generatePiNativeResponse,
};

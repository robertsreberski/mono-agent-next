import type { RunRecorder, RuntimeEventLike } from "@mono-agent/observability";
import {
  modelReferenceKey,
  monoRuntimeSupportsLiveInput,
  sandboxPolicyToRuntimeOptions,
  type RuntimeExecutionMode,
  type RuntimeMessage,
  type RuntimeResult,
  type RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import type { BuiltAgentContext, ContextBlockInput, HistoryMessage } from "../context/index.js";
import type { Semaphore } from "../semaphore.js";
import type {
  AgentHarnessContinuationClaimCapability,
  AgentHarnessOptions,
  AgentHarnessProgressCapability,
  AgentHarnessRequest,
  AgentHarnessRuntimeOptionsExtension,
} from "../types.js";
import type { LiveInputMailbox } from "../live-input.js";
import { failClosedToolPolicy, toolPolicyToRuntimeOptions } from "../tool-policy/index.js";
import type { AttachmentRequestContext } from "./attachments.js";
import { AgentHarnessError } from "./error.js";
import { injectMcpContinuationContext, injectMcpRequestContext } from "./mcp-context.js";
import {
  executionModeForOverride,
  isRuntimeModelReference,
  mergeRuntimeOptions,
  sameRuntimeModel,
  withoutToolPolicyOptions,
} from "./runtime-options.js";
import { buildTurnContextEvent, composeUserMessageWithMemory } from "./turn-context.js";

export async function runHarnessRuntime(
  options: AgentHarnessOptions,
  runLimiter: Semaphore | undefined,
  sessionsEnabled: boolean,
  request: AgentHarnessRequest,
  recorder: RunRecorder,
  context: BuiltAgentContext,
  memory: ContextBlockInput | undefined,
  runId: string,
  resumeSessionId: string | undefined,
  durablePiSessionsRoot: string | undefined,
  sessionIsolated: boolean,
  skillDisclosureNames: readonly string[],
  history: readonly HistoryMessage[],
  historyOmitted: boolean,
  historyAsMessages: boolean,
  attachmentContext: AttachmentRequestContext,
  continuationCapabilities: AgentHarnessContinuationClaimCapability[],
  liveInputMailbox?: LiveInputMailbox,
  onProviderStart?: () => void,
): Promise<RuntimeResult> {
    const hostOnEvent = request.onEvent;
    let requestExtension: AgentHarnessRuntimeOptionsExtension | undefined;
    let requestExtensionCleanup: Promise<void> | undefined;
    let mcpProgressCapability: AgentHarnessProgressCapability | undefined;
    let mcpContinuationCapabilities: readonly AgentHarnessContinuationClaimCapability[] = [];
    let mcpRunOutputCleanup: (() => Promise<void>) | undefined;
    let settlementCleanup: Promise<void> | undefined;
    // Admission precedes per-request extension setup. Extensions may allocate
    // loopback MCP listeners or other bounded resources, so queued runs must
    // hold none of them while waiting for a provider slot.
    let acquired = false;
    // Release-on-abort (R10): once a slot is held, an abort frees it after its
    // request-scoped resources close, even if the provider ignores cancellation.
    // Keeping cleanup inside the permit lifetime prevents repeated cancel/new-run
    // cycles from accumulating loopback MCP listeners beyond concurrency.
    let released = false;
    const releaseSlot = (): void => {
      if (acquired && !released) {
        released = true;
        runLimiter?.release();
      }
    };
    const cleanupRequestExtension = (): Promise<void> => {
      requestExtensionCleanup ??= Promise.resolve()
        .then(async () => {
          const failures: unknown[] = [];
          try {
            await requestExtension?.cleanup?.();
          } catch (error) {
            failures.push(error);
          }
          try {
            await mcpProgressCapability?.release();
          } catch (error) {
            failures.push(error);
          }
          for (const capability of mcpContinuationCapabilities) {
            try {
              await capability.release();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) {
            throw failures[0];
          }
        })
        .then(() => undefined);
      return requestExtensionCleanup;
    };
    const cleanupAfterSettlement = (): Promise<void> => {
      settlementCleanup ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        try {
          await requestExtension?.settleCleanup?.();
        } catch (error) {
          failures.push(error);
        }
        try {
          await mcpRunOutputCleanup?.();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) throw failures[0];
      });
      return settlementCleanup;
    };
    const onAbortCleanupAndRelease = (): void => {
      void cleanupRequestExtension().catch(() => undefined).finally(releaseSlot);
    };
    try {
      if (runLimiter !== undefined) {
        await runLimiter.acquire(request.abortSignal);
        acquired = true;
      }
      requestExtension = await options.runtimeOptionsForRequest?.({ request, runId, context });
      const policyOptions = toolPolicyToRuntimeOptions(
        requestExtension?.toolPolicyOverride
        ?? options.toolPolicy
        ?? failClosedToolPolicy(),
      );
      const sandboxOptions = options.sandboxPolicy === undefined
        ? {}
        : sandboxPolicyToRuntimeOptions(options.sandboxPolicy);
      const staticRuntimeOptions = requestExtension?.toolPolicyOverride === undefined
        ? options.runtimeOptions
        : withoutToolPolicyOptions(options.runtimeOptions);
      const requestRuntimeOptions = requestExtension?.toolPolicyOverride === undefined
        ? requestExtension?.runtimeOptions
        : withoutToolPolicyOptions(requestExtension.runtimeOptions);
      const merged = mergeRuntimeOptions(
        policyOptions,
        sandboxOptions,
        staticRuntimeOptions,
        requestRuntimeOptions,
      );
      // Provider-session identity and durable storage are host-owned. Strip all
      // extension/static values unconditionally, then add only the decisions
      // made by the coordinated harness below. Conditional object spreads do
      // not remove pre-existing keys when their guard is false.
      delete merged.piSessionsRoot;
      delete merged.sessionKeepAlive;
      delete merged.sessionIdleTimeoutMs;
      delete merged.sessionId;
      delete merged.providerSessionId;
      // Provider transport is a host reliability policy. A trigger/request
      // extension may supply it only when the host left it unset; it cannot
      // switch an explicitly configured host away from its selected transport.
      if (options.runtimeOptions?.piTransport !== undefined) {
        merged.piTransport = options.runtimeOptions.piTransport;
      }
      if (request.continuation?.toolsDisabled === true) {
        // Host-authoritative continuation synthesis is side-effect free. This
        // final override runs after every static/request policy layer so neither
        // a model nor an app extension can re-enable built-ins or MCP tools.
        merged.allowedTools = [];
        merged.disallowedTools = ["*"];
        merged.mcpServers = {};
        delete merged.mcpConfigPath;
      }
      const requestContext = await injectMcpRequestContext({
        options: options.mcpRequestContext,
        mcpServers: merged.mcpServers,
        conversationId: request.conversationId,
        runId,
        attachmentsRoot: attachmentContext.root,
        allowedAttachmentPaths: attachmentContext.allowedPaths,
        allowedAttachmentIdentities: attachmentContext.allowedIdentities,
      });
      if (requestContext !== undefined) {
        merged.mcpServers = requestContext.mcpServers;
        mcpProgressCapability = requestContext.progressCapability;
        mcpRunOutputCleanup = requestContext.cleanup;
      }
      const continuationContext = await injectMcpContinuationContext({
        options: options.continuationContext,
        mcpServers: merged.mcpServers,
        conversationId: request.conversationId,
        replyTo: request.replyTo,
        runId,
      });
      if (continuationContext !== undefined) {
        merged.mcpServers = continuationContext.mcpServers;
        mcpContinuationCapabilities = continuationContext.capabilities;
        continuationCapabilities.push(...continuationContext.capabilities);
      }
      // Register abort cleanup only after every run-scoped resource is assigned;
      // otherwise an abort racing capability issuance could memoize cleanup before
      // the token exists and leave that token live.
      request.abortSignal.addEventListener("abort", onAbortCleanupAndRelease, { once: true });
      if (request.abortSignal.aborted) {
        onAbortCleanupAndRelease();
        await cleanupRequestExtension();
        throw request.abortSignal.reason ?? new Error("Agent request was cancelled before provider start.");
      }
      // Per-request overrides (cron job / webhook per-trigger model + effort) win
      // over the harness defaults. These are applied AFTER the `...merged` spread so
      // the precedence is explicit. Non-override turns are byte-for-byte unchanged.
      const overrideModel = isRuntimeModelReference(merged.model) ? merged.model : undefined;
      const effectiveModel = overrideModel ?? options.model;
      if (
        !sessionIsolated
        && sessionsEnabled
        && overrideModel !== undefined
        && !sameRuntimeModel(overrideModel, options.model)
      ) {
        // Context/session isolation must be decided before history assembly. A
        // model-changing extension that was not declared by the request's
        // cron/webhook/TUI metadata arrives too late: a warm turn may already
        // have omitted canonical history. Fail before provider execution rather
        // than mixing model lineage or saving an id owned by another runtime.
        throw new AgentHarnessError(
          "undeclared_model_override",
          "A model-changing runtimeOptionsForRequest result must be declared in request metadata before context assembly.",
        );
      }
      // executionMode for an override turn: keep the host's configured mode when the
      // override model supports it (so a host running e.g. claude in cli mode is not
      // silently flipped to sdk for a same-family override), else fall back to that
      // model's default mode (so a codex override under an sdk host correctly runs
      // cli). executionMode is harness/runtime-owned — extensions cannot set it.
      const effectiveExecutionMode = overrideModel === undefined
        ? options.executionMode
        : executionModeForOverride(overrideModel, options.executionMode);
      const overrideEffort = typeof merged.effort === "string" ? merged.effort : undefined;
      const effectiveEffort = overrideEffort ?? options.effort;
      const useManagedLiveInput = liveInputMailbox !== undefined && merged.liveInput === undefined;
      let supportsLiveInput = false;
      if (liveInputMailbox !== undefined) {
        if (useManagedLiveInput) {
          try {
            supportsLiveInput = monoRuntimeSupportsLiveInput(
              effectiveModel,
              effectiveExecutionMode as RuntimeExecutionMode | undefined,
            );
          } catch {
            supportsLiveInput = false;
          }
        }
        if (!useManagedLiveInput || !supportsLiveInput) liveInputMailbox.markUnsupported();
      }
      // When the override names a DIFFERENT model, run it on a runtime built for
      // that model (override as the fallback-chain primary, configured backups
      // after) so failover is preserved. Falls back to the shared runtime when no
      // factory is wired (the app wires it only when fallbacks exist; a plain
      // runtime honors the per-run model) or the model is unchanged.
      const runtime =
        overrideModel !== undefined &&
        options.runtimeForModel !== undefined &&
        !sameRuntimeModel(overrideModel, options.model)
          ? options.runtimeForModel(effectiveModel, effectiveExecutionMode)
          : options.runtime;
      const currentUserMessage: RuntimeMessage = {
        role: "user",
        content: composeUserMessageWithMemory(request.userMessage, memory),
      };
      const runtimeOptions: RuntimeRunOptions = {
        ...merged,
        model: effectiveModel,
        // Recalled memory is appended to the user message (NOT the system prompt) so
        // it reaches the model on every turn, including resumed turns. See
        // prepareContext for why.
        messages: [
          ...(historyAsMessages ? structuredHistoryMessages(history) : []),
          currentUserMessage,
        ],
        abortSignal: request.abortSignal,
        ...(useManagedLiveInput && supportsLiveInput && liveInputMailbox !== undefined
          ? { liveInput: liveInputMailbox }
          : {}),
        ...(effectiveExecutionMode === undefined ? {} : { executionMode: effectiveExecutionMode }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        // Durable provider-session root is forwarded only for a host-history
        // coordinated turn. Custom stores and isolated runs cannot safely make
        // provider JSONL authoritative across a crash, so they stay in-memory.
        ...(durablePiSessionsRoot === undefined || runtime !== options.runtime
          ? {}
          : { piSessionsRoot: durablePiSessionsRoot }),
        // Progressive skill disclosure (index mode): pass the discovered skill names
        // and the skills root so pi-native's getPiBuiltinTools creates the on-demand
        // `ReadSkill` tool. These live after the merge so request extensions cannot
        // clobber them. Empty in 'full' mode / when no skillsRoot is set, so the
        // tool is not created and behavior matches the legacy path.
        ...(skillDisclosureNames.length > 0 && options.skillsRoot !== undefined
          ? {
            skills: skillDisclosureNames.map((name) => ({ name })),
            skillsRoot: options.skillsRoot,
          }
          : {}),
        // Session keys live after the merge so request extensions cannot
        // clobber the harness's session decision — including forcing the keys
        // back to undefined on fresh runs.
        //
        // Omitted entirely when running on a per-turn OVERRIDE runtime (a model
        // override built via runtimeForModel): that runtime is not the one the
        // shared session store / disposal is keyed to, so keeping a session alive
        // on it would leak (the store disposes against the base runtime). An
        // override turn is one-shot, so it runs stateless. Non-override turns
        // (runtime === options.runtime) are byte-for-byte unchanged.
        ...(sessionsEnabled && runtime === options.runtime
          ? {
            sessionKeepAlive: true,
            sessionIdleTimeoutMs: options.session?.idleTimeoutMs,
            sessionId: resumeSessionId,
            providerSessionId: resumeSessionId,
          }
          : {}),
        onEvent: (event: RuntimeEventLike) => {
          recorder.onEvent(event);
          hostOnEvent?.(event);
        },
      };
      // The provider call is starting: this run has left the admission-pending
      // tier (it now holds a provider slot rather than waiting for one), so
      // release its maxPendingRuns slot. Idempotent at the run() scope, so the
      // resume-retry's second runRuntime does not double-release.
      onProviderStart?.();
      // Synthetic run_config event: tells live/recorded consumers (TUI, replay)
      // the per-run RESOLVED model/effort/executionMode — including per-request
      // overrides (cron job / webhook per-trigger model+effort) — so they never
      // have to re-derive it from scattered runtime_telemetry fields. Delivered
      // to both sinks the same way as the provider_bridge_latency event below.
      const runConfigEvent: RuntimeEventLike = {
        type: "run_config",
        model: modelReferenceKey(effectiveModel),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        ...(effectiveExecutionMode === undefined ? {} : { executionMode: effectiveExecutionMode }),
        overridden: overrideModel !== undefined || overrideEffort !== undefined,
        timestamp: new Date().toISOString(),
      };
      recorder.onEvent(runConfigEvent);
      hostOnEvent?.(runConfigEvent);
      // Synthetic turn_context event: describes the context this specific turn was
      // driven with — the loaded conversation history (or the fact it was omitted
      // because the provider session carries the transcript) and the recalled
      // long-term memory block. The user message is intentionally omitted (it is
      // already the run's userInput). Emitted right after run_config and delivered
      // to both sinks identically. Like run_config it double-fires on the
      // resume-replay retry (the second carries the replayed history); consumers are
      // last-wins.
      //
      // `historyOmitted` is true only for a confirmed live warm mapping. A cold
      // epoch-owned reopen may create its JSONL on miss, so an empty canonical
      // history must remain distinguishable from intentionally omitted history.
      const turnContextEvent = buildTurnContextEvent(history, historyOmitted, memory);
      recorder.onEvent(turnContextEvent);
      hostOnEvent?.(turnContextEvent);
      // Bracket the provider call so observability can separate provider+tool+IO
      // time (this event's durationMs) from harness overhead (context build,
      // attachment persistence, compaction, admission wait).
      const bridgeStartMs = Date.now();
      try {
        return await runtime.run(context.prompt, runtimeOptions);
      } finally {
        const latencyEvent: RuntimeEventLike = {
          type: "provider_bridge_latency",
          durationMs: Date.now() - bridgeStartMs,
          timestamp: new Date(bridgeStartMs).toISOString(),
        };
        recorder.onEvent(latencyEvent);
        hostOnEvent?.(latencyEvent);
      }
    } finally {
      // Remove the abort listener to avoid leaking it on the signal, then run
      // the (idempotent) release so the slot frees exactly once whether the run
      // settled normally or an abort already released it.
      request.abortSignal.removeEventListener("abort", onAbortCleanupAndRelease);
      try {
        await cleanupRequestExtension();
      } finally {
        try {
          await cleanupAfterSettlement();
        } finally {
          releaseSlot();
        }
      }
    }
}

function structuredHistoryMessages(history: readonly HistoryMessage[]): RuntimeMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
  }));
}

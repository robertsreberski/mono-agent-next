// Top-level runtime factory.
//
// `createRuntime(host)` is the ergonomic entry point for hosts. It binds the
// host integration callbacks (pricing, persistence, credentials), builds a
// per-instance `ToolContext` (agent/tools/shared/tool-context.js) that this
// runtime instance threads to every bridge call via `options.toolContext`
// instead of a process-global, and returns a `.run(systemPrompt, options)`
// method that resolves the right provider bridge based on `options.model` +
// `options.executionMode`.
//
// The runtime registry contains a static table for the five built-in bridges
// (claude-sdk, claude-cli, pi-native, codex-app, opencode-app) and lazily imports
// the matching implementation only when a run selects it. Hosts that need finer
// control can keep using the named exports (resolveRuntimeBridge,
// generateClaudeResponse, etc.) directly.
//
// Return shape from `.run()`:
//   { text, structuredResult, structuredResultSource, events, usage,
//     durationMs, numTurns, model, effort, sdk, cancelled, error,
//     errorDetails, failureKind, providerSessionId, runtimeWarnings,
//     diagnostics }
//
// `text` is the raw assistant text. `structuredResult` is whatever JSON the
// agent returned via the configured outputSchema (undefined when no schema
// was supplied). Hosts that want a domain-specific contract (for example,
// a product-specific result object,
// task envelopes, etc.) parse it themselves.

// @ts-check

import { resolveRuntimeBridge } from "./ai/runtime/registry.js";
import { createObserverHub } from "./ai/observer.js";
import {
  disposeAllProviderSessions,
  disposeProviderSession,
  invalidateProviderSession,
  refreshProviderSession,
  syncProviderSession,
} from "./ai/runtime/sessions.js";
import { createToolContext, updateToolContext } from "./agent/tools/shared/tool-context.js";
import { resolveRuntimeBrand } from "./runtime-brand.js";
import { retireDurableNativeSession } from "./ai/providers/pi-native/session-lifecycle.js";
import { instrumentLiveInputAppliedEvents } from "./ai/runtime/live-input-events.js";

/**
 * @typedef {import('./ai/types.js').AgentRuntimeHostOptions} AgentRuntimeHostOptions
 * @typedef {import('./ai/types.js').AgentRuntimeToolOptions} AgentRuntimeToolOptions
 * @typedef {import('./ai/types.js').AgentRuntimeInstance} AgentRuntimeInstance
 * @typedef {import('./ai/types.js').RuntimeRunOptions} RuntimeRunOptions
 * @typedef {import('./ai/types.js').RuntimeResult} RuntimeResult
 */

const HOST_KEYS = [
  "resolveCustomPricing",
  "resolvePiApiKey",
  "persistArtifact",
  "onCompactionRecorded",
  "onToolApprovalRequest",
  "toolRiskTiers",
  "approvalDefaultRiskTier",
  "approvalTimeoutMs",
  "approvalAlwaysAllowTools",
];

const TOOL_RUNTIME_KEYS = [
  "workspace",
  "repoRoot",
  "ripgrepPath",
  "qaOutputDir",
  "sandboxPolicy",
  "sandboxEngine",
  "sandbox",
];

/**
 * @param {Object<string, *>} source
 * @param {Array<string>} keys
 * @returns {Object<string, *>}
 */
function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Select recognized keys that are present even when their value is undefined.
 * `configureTools` uses this variant so callers can explicitly clear state
 * held by the long-lived per-instance ToolContext.
 * @param {Object<string, *>} source
 * @param {Array<string>} keys
 * @returns {Object<string, *>}
 */
function pickPresent(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && key in source) out[key] = source[key];
  }
  return out;
}

const PROMPT_OVERRIDE_KEYS = ["structuredOutputInstruction", "structuredOutputFinalization", "liveInputGuidance"];

/**
 * Per-field merge of the prompt overrides: a run-level override wins over the
 * host-level default wins over the bridge's built-in default (an absent field
 * leaves the bridge on its built-in string). Kept out of the `...hostDefaults,
 * ...options` spread so a run that overrides ONE prompt does not drop the host's
 * other prompt defaults (an object-replacing spread would).
 * @param {import('./ai/types.js').RuntimePromptOverrides} [hostPrompts]
 * @param {import('./ai/types.js').RuntimePromptOverrides} [runPrompts]
 * @returns {import('./ai/types.js').RuntimePromptOverrides|undefined}
 */
function resolvePrompts(hostPrompts, runPrompts) {
  if (!hostPrompts && !runPrompts) return undefined;
  /** @type {Record<string, *>} */
  const merged = {};
  for (const key of PROMPT_OVERRIDE_KEYS) {
    const value = /** @type {any} */ (runPrompts)?.[key] ?? /** @type {any} */ (hostPrompts)?.[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * @param {AgentRuntimeHostOptions} [host]
 * @returns {AgentRuntimeInstance}
 */
export function createRuntime(host = {}) {
  const hostDefaults = pickDefined(host, HOST_KEYS);
  const toolRuntime = pickDefined(host, TOOL_RUNTIME_KEYS);
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);
  const hostObservers = Array.isArray(host.observers) ? host.observers.slice() : [];
  // Per-instance tool context, built once and threaded to every bridge via
  // `options.toolContext` (below). It replaces the former global side effect:
  // two runtimes in one process now keep independent workspace/brand/sandbox
  // config instead of clobbering a shared singleton. `configureTools` mutates
  // THIS object so later runs of this instance observe the update.
  const toolContext = createToolContext({ ...toolRuntime, runtimeBrand });

  return {
    /**
     * @param {string} systemPrompt
     * @param {Partial<RuntimeRunOptions>} [options] Optional only so the
     *   `options.model` guard below can throw a descriptive error; every
     *   real caller must supply a model (see AgentRuntimeInstance.run).
     * @returns {Promise<RuntimeResult>}
     */
    async run(systemPrompt, options = {}) {
      if (!options.model) throw new Error("createRuntime.run requires options.model");
      const executionMode = typeof options.executionMode === "string" ? options.executionMode : "sdk";
      const bridge = await resolveRuntimeBridge(options.model, {
        liveInput: !!options.liveInput,
        executionMode,
      });
      const callObservers = Array.isArray(options.observers) ? options.observers : [];
      const hub = createObserverHub({
        observers: [...hostObservers, ...callObservers],
        onEvent: options.onEvent,
      });
      const liveInput = instrumentLiveInputAppliedEvents(options.liveInput, hub.emit);
      const prompts = resolvePrompts(host.prompts, options.prompts);
      const result = await bridge.execute(systemPrompt, {
        ...hostDefaults,
        ...options,
        // `...options` alone doesn't carry the `options.model` narrowing above
        // (spread reads the parameter's declared — Partial — type); re-assert
        // the already-validated model so the request satisfies RuntimeRequest.
        model: options.model,
        executionMode,
        runtimeBrand,
        toolContext,
        observerHub: hub,
        onEvent: hub.emit,
        ...(liveInput === undefined ? {} : { liveInput }),
        // Merged AFTER the spreads so the per-field run>host>default precedence
        // wins over either bag's whole-object `prompts`.
        ...(prompts === undefined ? {} : { prompts }),
      });
      await hub.flush();
      return result;
    },
    configureTools(next = {}) {
      updateToolContext(toolContext, pickPresent(next, TOOL_RUNTIME_KEYS));
    },
    async syncSession(providerSessionId) {
      return syncProviderSession(providerSessionId);
    },
    async refreshSession(providerSessionId) {
      return refreshProviderSession(providerSessionId);
    },
    async retireDurableSession(providerSessionId, sessionsRoot) {
      return retireDurableNativeSession(providerSessionId, sessionsRoot);
    },
    async disposeSession(providerSessionId) {
      return disposeProviderSession(providerSessionId);
    },
    async invalidateSession(providerSessionId) {
      return invalidateProviderSession(providerSessionId);
    },
    async disposeAllSessions() {
      return disposeAllProviderSessions();
    },
  };
}

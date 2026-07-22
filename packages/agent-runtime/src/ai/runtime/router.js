// Provider fallback router.
//
// Wraps `createRuntime` with an ordered chain of model references. If a run
// fails with a retryable provider error (per `retryableProviderFailureInfo`),
// the router retries the same logical run with the next chain entry,
// prepending the transcript-tail snapshot of the previous attempt to the
// system prompt so the next provider can continue rather than restart.
//
// Inspired by zeroclaw's RouterProvider hint-resolution pattern, but goes
// further: zeroclaw's router resolves a hint to one provider and never
// falls back automatically. This router does, using the failure-kind
// taxonomy and capability matrix we already maintain.
//
// API:
//   createRouterRuntime({ host, chain })
//     returns { run(systemPrompt, options) } plus configureTools /
//     syncSession / refreshSession / retireDurableSession / disposeSession /
//     invalidateSession / disposeAllSessions
//     delegated to the inner runtime,
//     so the router is a drop-in replacement for createRuntime(host).
//
//   chain entries:
//     { model: ModelRef, executionMode?: "sdk" | "cli", effort?: string|null,
//       requires?: Capabilities }
//   shorthand: a bare ModelRef is also accepted (no requirements).
//   effort string = fixed for that route, undefined = inherit the legacy run
//   effort, null = omit effort so the provider chooses its default.
//
// Result:
//   The success run's result, with `failoverHistory` appended describing every
//   prior attempt: [{ model, failureKind, requestId, retryableSubkind }].
//   If every eligible retryable/auth entry in the chain fails, returns the last
//   result with `failureKind: "provider_unavailable_exhausted"`. Terminal
//   non-retryable failures are returned as-is with their failover history.

// @ts-check

import { createRuntime } from "../../runtime.js";
import { isProviderAuthFailureText, retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "./capabilities.js";
import { buildTranscriptTailSnapshot, renderResumeSnapshot } from "../../agent/transcript.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { resolveRuntimeBrand } from "../../runtime-brand.js";
import { createObserverHub } from "../observer.js";
import { instrumentLiveInputAppliedEvents } from "./live-input-events.js";

/**
 * @typedef {import('../types.js').RuntimeModelRef} RuntimeModelRef
 * @typedef {import('../types.js').AgentRuntimeHostOptions} AgentRuntimeHostOptions
 * @typedef {import('../types.js').AgentRuntimeInstance} AgentRuntimeInstance
 * @typedef {import('../types.js').RuntimeRunOptions} RuntimeRunOptions
 * @typedef {import('../types.js').RuntimeResult} RuntimeResult
 */

/**
 * @typedef {Object} RouterChainEntryInput
 * A chain entry as accepted by createRouterRuntime: either the shorthand bare
 * RuntimeModelRef, or the full `{model, executionMode?, effort?, requires?}` form.
 * @property {RuntimeModelRef} model
 * @property {string} [executionMode]
 * @property {string|null} [effort]
 * @property {Object<string, *>} [requires]
 */

/**
 * @typedef {Object} RouterChainEntry
 * @property {RuntimeModelRef} model
 * @property {string|null} executionMode
 * @property {string|null|undefined} effort
 * @property {Object<string, *>|null} requires
 */

/**
 * @typedef {Object} RouterAttemptResolution
 * Private host seam for route-specific provider options/runtime ownership.
 * Returned options are never copied into router telemetry.
 * @property {AgentRuntimeInstance} [runtime]
 * @property {Object<string, *>} [options]
 * @property {() => (void|Promise<void>)} [cleanup]
 */

const ROUTE_SAFETY_MODES = new Set(["uniform", "per-route-native"]);
const ATTEMPT_SCOPED_OPTION_KEYS = ["customProvider", "customModel", "modelCapabilities", "isPrivateProvider"];
const ROUTER_TOOL_CONTEXT_KEYS = [
  "workspace", "repoRoot", "ripgrepPath", "qaOutputDir", "sandboxPolicy", "sandboxEngine",
];
const RESOLVER_PROTECTED_OPTION_KEYS = new Set([
  "model", "executionMode", "effort", "messages", "abortSignal", "onEvent",
  "sessionId", "providerSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs",
  "diagnosticsSeed", "systemPromptPrefix", "sandboxPolicy", "sandboxEngine", "sandbox",
  "allowedTools", "disallowedTools", "permissionMode", "mcpServers", "skills",
  "outputSchema", "nativeSubagents", "liveInput", "fastMode",
]);

/**
 * @param {Object} [options]
 * @param {AgentRuntimeHostOptions} [options.host]
 * @param {ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>} [options.chain]
 * @param {"uniform"|"per-route-native"} [options.routeSafety]
 * @param {(input: {model: RuntimeModelRef, executionMode: string|null, attemptIndex: number, routeSafety: "uniform"|"per-route-native"}) => (RouterAttemptResolution|Promise<RouterAttemptResolution>)} [options.resolveAttempt]
 * @returns {AgentRuntimeInstance & {chain: () => Array<RouterChainEntry>}}
 */
export function createRouterRuntime({ host = {}, chain = [], routeSafety = "uniform", resolveAttempt } = {}) {
  if (!ROUTE_SAFETY_MODES.has(routeSafety)) {
    throw new Error("createRouterRuntime routeSafety must be uniform or per-route-native");
  }
  const entries = normaliseChain(chain);
  if (entries.length === 0) {
    throw new Error("createRouterRuntime requires a non-empty chain");
  }
  assertUniqueEntries(entries);
  const inner = createRuntime(host);
  /** @type {Map<string, AgentRuntimeInstance>} */
  const routeRuntimes = new Map();
  /** @type {import('../types.js').AgentRuntimeToolOptions|undefined} */
  let configuredTools;
  // The router builds transcript-tail snapshots outside the inner runtime's
  // bridge call (which is where the per-instance toolContext lives), so resolve
  // the host brand here to stamp the snapshot schema id with the same brand the
  // inner runtime uses — createRuntime no longer publishes it to a process global.
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);

  return {
    /**
     * @param {string} systemPrompt
     * @param {Partial<RuntimeRunOptions>} [options] Optional so a bare `{}` call
     *   is legal; the router always overrides `model`/`executionMode` per chain
     *   entry (see AgentRuntimeInstance.run for the public, model-required contract).
     * @returns {Promise<RuntimeResult>}
     */
    async run(systemPrompt, options = {}) {
      const liveInputHub = options.liveInput === undefined
        ? undefined
        : createObserverHub({
            observers: [
              ...(Array.isArray(host.observers) ? host.observers : []),
              ...(Array.isArray(options.observers) ? options.observers : []),
            ],
            onEvent: options.onEvent,
          });
      if (options.liveInput !== undefined && liveInputHub !== undefined) {
        options = {
          ...options,
          liveInput: instrumentLiveInputAppliedEvents(options.liveInput, liveInputHub.emit),
        };
      }
      try {
      /** @type {Array<{model: RuntimeModelRef, failureKind: (string|null), requestId?: (string|null|undefined), retryableSubkind?: (string|null|undefined), requirements?: (Object<string,*>|null), routeSafety?: import('../types.js').RuntimeRouteSafetyMode, safetyContract?: import('../types.js').RuntimeRouteSafetyContract}>} */
      const failoverHistory = [];
      /** @type {RuntimeResult|null} */
      let lastResult = null;
      /** @type {RuntimeResult|null} */
      let lastRouteSkip = null;
      const promptBase = systemPrompt;
      /** @type {*} */
      let pendingSnapshot = null;
      /** @type {Array<{attemptIndex: number, model: RuntimeModelRef, routeSafety: import('../types.js').RuntimeRouteSafetyMode, safetyContract: import('../types.js').RuntimeRouteSafetyContract, status: string}>} */
      const routeSafetyHistory = [];

      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const effectiveToolOptions = effectiveRouterToolOptions(host, configuredTools);
        let safetyContract = routeSafetyContract(
          routeSafety,
          entry,
          effectivePiSandboxPolicy(effectiveToolOptions, options),
        );
        if (!entrySatisfiesRequirements(entry, options)) {
          lastRouteSkip = {
            text: null,
            error: `Route ${modelKey(entry.model)} does not satisfy the logical run's required capabilities.`,
            failureKind: "skipped_capability_mismatch",
            events: [],
            cancelled: false,
            usage: {},
          };
          failoverHistory.push({
            model: entry.model,
            failureKind: "skipped_capability_mismatch",
            requirements: entry.requires,
            routeSafety,
            safetyContract,
          });
          const skippedRecord = routeSafetyRecord(i, entry, safetyContract, "skipped_capability_mismatch");
          routeSafetyHistory.push(skippedRecord);
          emit(options, { type: "provider_route_safety", ...skippedRecord });
          continue;
        }

        /** @type {*} */
        let callOptions = {
          ...options,
          model: entry.model,
          executionMode: entry.executionMode || options.executionMode,
        };
        // The legacy run-level custom-provider bag describes the primary
        // route. Without a route resolver there is no authoritative metadata
        // for a different fallback, so never let the primary's credentials or
        // model capabilities contaminate later attempts.
        if (resolveAttempt === undefined && i > 0) {
          callOptions = withoutAttemptScopedOptions(callOptions);
        }
        /** @type {AgentRuntimeInstance} */
        let attemptRuntime = inner;
        /** @type {(() => (void|Promise<void>))|undefined} */
        let attemptCleanup;
        try {
          const resolved = resolveAttempt === undefined
            ? undefined
            : await resolveAttempt({
                model: entry.model,
                executionMode: entry.executionMode,
                attemptIndex: i,
                routeSafety,
              });
          const resolution = normalizeAttemptResolution(resolved);
          attemptCleanup = resolution?.cleanup;
          if (resolveAttempt !== undefined) {
            callOptions = mergeAttemptOptions(callOptions, resolution?.options);
          }
          if (routeSafety === "per-route-native") {
            callOptions = projectPerRouteNativeOptions(entry, callOptions);
            const key = routeRuntimeKey(entry, i);
            const resolvedRuntime = resolution?.runtime;
            if (resolvedRuntime !== undefined) {
              assertRuntimeLike(resolvedRuntime);
              const previousRuntime = routeRuntimes.get(key);
              if (previousRuntime !== undefined && previousRuntime !== resolvedRuntime) {
                try { await previousRuntime.disposeAllSessions?.(); } catch { /* best-effort replacement */ }
              }
              routeRuntimes.set(key, resolvedRuntime);
              if (entry.model.sdk !== "pi") {
                resolvedRuntime.configureTools?.(projectPerRouteNativeToolOptions(entry, configuredTools));
              }
            }
            attemptRuntime = routeRuntimes.get(key) ?? createRouteRuntime(key, entry, host, routeRuntimes, configuredTools);
            if (entry.model.sdk === "pi") {
              projectPiRuntimeToolContext(attemptRuntime, effectiveToolOptions);
              // Derive the attestation from the same complete base context and
              // request-scoped inputs that the supplied/runtime-owned Pi
              // bridge will actually receive. Resolver options cannot alter
              // these protected fields.
              safetyContract = routeSafetyContract(
                routeSafety,
                entry,
                effectivePiSandboxPolicy(effectiveToolOptions, callOptions),
              );
            }
          } else if (resolution?.runtime !== undefined && resolution.runtime !== inner) {
            throw new Error("uniform route safety cannot replace the shared monotonic runtime");
          }
        } catch (error) {
          try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
          const failure = safetyUnavailableResult(error);
          lastRouteSkip = failure;
          failoverHistory.push({
            model: entry.model,
            failureKind: "safety_unavailable",
            routeSafety,
            safetyContract,
          });
          const unavailableRecord = routeSafetyRecord(i, entry, safetyContract, "safety_unavailable");
          routeSafetyHistory.push(unavailableRecord);
          emit(callOptions, { type: "provider_route_safety", ...unavailableRecord });
          continue;
        }

        applyEntryEffort(callOptions, entry.effort);
        // A provider session belongs to the route that created it. The entire
        // chain is stateless whenever a fallback exists, keeping the full
        // logical run replayable regardless of which route is attempted.
        if (entries.length > 1 || i > 0 || !entrySupportsSessionResume(entry)) {
          delete callOptions.sessionId;
          delete callOptions.providerSessionId;
          delete callOptions.sessionKeepAlive;
          delete callOptions.sessionIdleTimeoutMs;
        }
        let attemptSystemPrompt = promptBase;
        if (pendingSnapshot) {
          callOptions.diagnosticsSeed = {
            ...(callOptions.diagnosticsSeed || {}),
            resume_snapshot: pendingSnapshot,
          };
          // Also prepend the rendered snapshot to the system prompt so SDK
          // backends that don't read diagnosticsSeed still continue from the
          const rendered = renderResumeSnapshot(pendingSnapshot);
          if (rendered) {
            callOptions.systemPromptPrefix = rendered;
            attemptSystemPrompt = `${rendered}\n\n${promptBase}`;
          }
        }

        const safetyRecord = routeSafetyRecord(i, entry, safetyContract, "attempted");
        routeSafetyHistory.push(safetyRecord);
        emit(callOptions, { type: "provider_route_safety", ...safetyRecord });

        if (failoverHistory.length > 0) {
          emit(callOptions, {
            type: "provider_failover_started",
            from: failoverHistory[failoverHistory.length - 1]?.model,
            to: entry.model,
            attemptIndex: i,
          });
        }

        let result;
        try {
          result = await attemptRuntime.run(attemptSystemPrompt, callOptions);
        } catch (err) {
          // The inner runtime usually surfaces errors as structured result
          // fields, but a bridge can still throw synchronously (e.g. spawn
          // failures). Convert to a result-like shape so the chain logic
          // is uniform.
          result = {
            text: null,
            error: err?.message || String(err),
            failureKind: "provider_unavailable",
            events: [],
            cancelled: false,
            usage: {},
          };
        } finally {
          try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
        }

        result = normalizeProviderAuthFailure(result);

        const retryability = retryableProviderFailureInfo({
          errorText: result.error || "",
          stderrTail: result.stderrTail || "",
          failureKind: result.failureKind,
        });

        const successful = !result.error && !result.failureKind && !result.cancelled;
        if (successful) {
          if (failoverHistory.length > 0) {
            emit(callOptions, {
              type: "provider_failover_completed",
              attemptIndex: i,
              model: entry.model,
            });
          }
          return { ...result, failoverHistory, routeSafetyHistory };
        }

        failoverHistory.push({
          model: entry.model,
          failureKind: result.failureKind || null,
          requestId: retryability.requestId,
          retryableSubkind: retryability.subkind,
          routeSafety,
          safetyContract,
        });
        if (result.failureKind === "skipped_capability_mismatch") {
          lastRouteSkip = result;
          // A bridge-level mismatch is about this route, not the logical run.
          // Try the next entry and do not derive a transcript snapshot from it.
          continue;
        }
        lastResult = result;

        // Provider auth is terminal for one provider, but chain-retryable: a
        // fallback provider may have working credentials. Other non-retryable
        // provider/request errors remain terminal.
        const shouldFallback = (retryability.retryable || result.failureKind === "provider_auth")
          && !result.cancelled
          && !isMidTurnSafetyFailure(result.failureKind);
        if (!shouldFallback) {
          return { ...result, failoverHistory, routeSafetyHistory };
        }

        // Build a transcript-tail snapshot from this run's events so the
        // next provider can continue. If the run produced no usable events,
        // skip the snapshot (the next attempt starts fresh).
        const snapshot = buildTranscriptTailSnapshot(result.events, { runtimeBrand });
        // Keep one bounded snapshot object across the logical run instead of
        // nesting a new <resume_context> block on every provider transition.
        pendingSnapshot = mergeResumeSnapshots(pendingSnapshot, snapshot);
      }

      const exhaustedResult = lastResult || lastRouteSkip || {
        text: null,
        events: [],
        error: "router chain exhausted with no executions",
        failureKind: "skipped_capability_mismatch",
        cancelled: false,
        usage: {},
      };
      return {
        ...exhaustedResult,
        failureKind: lastResult ? "provider_unavailable_exhausted" : exhaustedResult.failureKind,
        failoverHistory,
        routeSafetyHistory,
      };
      } finally {
        await liveInputHub?.flush();
      }
    },
    chain: () => entries.slice(),
    configureTools(next = {}) {
      configuredTools = { ...(configuredTools || {}), ...next };
      if (routeSafety === "uniform") {
        inner.configureTools?.(next);
        return;
      }
      entries.forEach((entry, index) => {
        const runtime = routeRuntimes.get(routeRuntimeKey(entry, index));
        runtime?.configureTools?.(projectPerRouteNativeToolOptions(entry, next));
      });
      // `inner` is deliberately not configured in per-route-native mode: all
      // attempts use their isolated route runtime, and applying one route's
      // policy to this shared standby would defeat that isolation.
    },
    async syncSession(providerSessionId) {
      let synced = false;
      for (const runtime of allRuntimes(inner, routeRuntimes)) {
        synced = Boolean(await runtime.syncSession?.(providerSessionId)) || synced;
      }
      return synced;
    },
    async refreshSession(providerSessionId) {
      for (const runtime of allRuntimes(inner, routeRuntimes)) {
        if (typeof runtime.refreshSession !== "function") {
          throw new Error("A routed runtime cannot guarantee a cold provider-session reopen");
        }
        await runtime.refreshSession(providerSessionId);
      }
    },
    async retireDurableSession(providerSessionId, sessionsRoot) {
      for (const runtime of allRuntimes(inner, routeRuntimes)) {
        if (typeof runtime.retireDurableSession !== "function") {
          throw new Error("A routed runtime cannot retire durable provider-session state");
        }
        await runtime.retireDurableSession(providerSessionId, sessionsRoot);
      }
    },
    async disposeSession(providerSessionId) {
      let disposed = false;
      for (const runtime of allRuntimes(inner, routeRuntimes)) {
        disposed = Boolean(await runtime.disposeSession?.(providerSessionId)) || disposed;
      }
      return disposed;
    },
    async invalidateSession(providerSessionId) {
      let invalidated = false;
      for (const runtime of allRuntimes(inner, routeRuntimes)) {
        invalidated = Boolean(await runtime.invalidateSession?.(providerSessionId)) || invalidated;
      }
      return invalidated;
    },
    async disposeAllSessions() {
      await Promise.all(allRuntimes(inner, routeRuntimes).map(async (runtime) => runtime.disposeAllSessions?.()));
    },
  };
}

/**
 * @param {ReadonlyArray<*>} chain ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>, loosened
 *   here because distinguishing the two shapes is a runtime duck-type check
 *   (`entry.sdk && entry.model`), not something a union type narrows cleanly.
 * @returns {Array<RouterChainEntry>}
 */
function normaliseChain(chain) {
  if (!Array.isArray(chain)) return [];
  return /** @type {Array<RouterChainEntry>} */ (chain
    .map((entry) => {
      if (!entry) return null;
      if (entry.sdk && entry.model) {
        // ModelRef shorthand: { sdk, model, ... }
        return { model: entry, executionMode: null, effort: undefined, requires: null };
      }
      if (entry.model) {
        return {
          model: entry.model,
          executionMode: typeof entry.executionMode === "string" ? entry.executionMode : null,
          effort: normalizeChainEffort(entry.effort),
          requires: entry.requires && typeof entry.requires === "object" ? entry.requires : null,
        };
      }
      return null;
    })
    .filter(Boolean));
}

/** @param {*} effort @returns {string|null|undefined} */
function normalizeChainEffort(effort) {
  if (effort === undefined || effort === null) return effort;
  if (typeof effort !== "string" || effort.length === 0 || effort.trim() !== effort) {
    throw new Error("createRouterRuntime chain effort must be a non-empty trimmed string, null, or omitted");
  }
  return effort;
}

/** @param {Array<RouterChainEntry>} entries */
function assertUniqueEntries(entries) {
  const seen = new Map();
  entries.forEach((entry, index) => {
    const key = modelKey(entry.model);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(`createRouterRuntime duplicate model ${key} at chain entries ${first} and ${index}`);
    }
    seen.set(key, index);
  });
}

/** @param {RuntimeModelRef} model */
function modelKey(model) {
  const provider = typeof model.provider === "string" && model.provider.length > 0 ? `${model.provider}:` : "";
  return `${model.sdk}:${provider}${model.model}`;
}

/**
 * A small fixed vocabulary keeps safety telemetry bounded and prevents route
 * credentials/options from accidentally entering events or persisted results.
 * @param {"uniform"|"per-route-native"} mode
 * @param {RouterChainEntry} entry
 * @param {Object<string, *>|undefined} piSandboxPolicy
 * @returns {import('../types.js').RuntimeRouteSafetyContract}
 */
function routeSafetyContract(mode, entry, piSandboxPolicy) {
  if (mode === "uniform") {
    return {
      mode,
      sandbox: "mono-agent-monotonic",
      tools: "mono-agent-monotonic",
    };
  }
  switch (entry.model.sdk) {
    case "pi":
      return {
        mode,
        sandbox: piSandboxContract(piSandboxPolicy),
        tools: "mono-agent-policy",
      };
    case "claude":
      return { mode, sandbox: "provider-native", tools: "provider-representable" };
    case "codex":
      return { mode, sandbox: "codex-native", tools: "exact-allow-all" };
    case "opencode":
      return { mode, sandbox: "provider-native", tools: "exact-allow-all" };
    default:
      return { mode, sandbox: "unsupported", tools: "unsupported" };
  }
}

/**
 * Describe the Pi sandbox posture without claiming that SRT is enforced when
 * the effective policy explicitly permits an unavailable engine to fall back
 * to an unsandboxed host process. Both fields are required because the runtime
 * adapter treats an unsafe fallback without its explicit opt-in as fail-closed.
 *
 * @param {Object<string, *>|undefined} policy
 * @returns {import('../types.js').RuntimeRouteSandboxContract}
 */
function piSandboxContract(policy) {
  if (policy === undefined) return "disabled";
  if (policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess === true) {
    return "mono-agent-srt-unsafe-host-fallback";
  }
  return "mono-agent-srt";
}

/**
 * Describe the policy Pi tools actually receive after host/configure/run
 * precedence. A request-scoped `off` policy cannot weaken an active host
 * policy, while an active request policy can tighten an absent/off host.
 * `configureTools({ sandboxPolicy: undefined })` explicitly clears the host
 * tool-context policy and must therefore be distinguished from an omitted key.
 *
 * @param {import('../types.js').AgentRuntimeToolOptions} toolOptions
 * @param {Object<string, *>} runOptions
 * @returns {Object<string, *>|undefined}
 */
function effectivePiSandboxPolicy(toolOptions, runOptions) {
  // Match the Pi turn runner's implementation precedence: a run-scoped
  // RuntimeSandbox wins, followed by configureTools/host, then the kernel's
  // fail-closed passthrough. Delegating the merge is essential here: the real
  // adapter makes fail-closed dominate unsafe-host-process, so inspecting only
  // the first non-off policy would produce false safety telemetry.
  const sandbox = runOptions.sandbox
    ?? toolOptions.sandbox
    ?? passthroughSandbox;
  const policy = sandbox.mergePolicies(toolOptions.sandboxPolicy, runOptions.sandboxPolicy);
  return policy && typeof policy === "object" && policy.mode !== "off"
    ? policy
    : undefined;
}

/**
 * Resolve the router-owned base ToolContext exactly as createRuntime(host)
 * followed by the router's configureTools calls would. Every data key is
 * present so projecting into a resolver-supplied runtime also clears hidden
 * state. RuntimeSandbox is special: configureTools intentionally ignores an
 * undefined implementation, so the configured value only replaces the host
 * seam when it is concrete.
 *
 * @param {AgentRuntimeHostOptions} host
 * @param {import('../types.js').AgentRuntimeToolOptions|undefined} configuredTools
 * @returns {import('../types.js').AgentRuntimeToolOptions}
 */
function effectiveRouterToolOptions(host, configuredTools) {
  /** @type {Object<string, *>} */
  const effective = {};
  for (const key of ROUTER_TOOL_CONTEXT_KEYS) {
    effective[key] = configuredTools !== undefined && Object.hasOwn(configuredTools, key)
      ? configuredTools[key]
      : host[key];
  }
  effective.sandbox = configuredTools?.sandbox
    ?? host.sandbox
    ?? passthroughSandbox;
  return effective;
}

/**
 * A resolver-supplied Pi runtime is allowed to own credentials/provider
 * lifecycle, never the route's safety posture. Replace its complete mutable
 * ToolContext before every execution so a blank, stale, or weaker runtime
 * cannot diverge from the router's host/configured/run policy or telemetry.
 *
 * @param {AgentRuntimeInstance} runtime
 * @param {import('../types.js').AgentRuntimeToolOptions} toolOptions
 */
function projectPiRuntimeToolContext(runtime, toolOptions) {
  if (typeof runtime.configureTools !== "function") {
    throw new Error("per-route-native Pi runtime must expose configureTools() for safety projection");
  }
  runtime.configureTools(toolOptions);
}

/**
 * @param {number} attemptIndex
 * @param {RouterChainEntry} entry
 * @param {import('../types.js').RuntimeRouteSafetyContract} contract
 * @param {string} status
 * @returns {{attemptIndex: number, model: RuntimeModelRef, routeSafety: import('../types.js').RuntimeRouteSafetyMode, safetyContract: import('../types.js').RuntimeRouteSafetyContract, status: string}}
 */
function routeSafetyRecord(attemptIndex, entry, contract, status) {
  return {
    attemptIndex,
    model: entry.model,
    routeSafety: contract.mode,
    safetyContract: contract,
    status,
  };
}

/** @param {RouterAttemptResolution|undefined} value */
function normalizeAttemptResolution(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("route attempt resolver must return an object or undefined");
  }
  if (value.options !== undefined && (value.options === null || typeof value.options !== "object" || Array.isArray(value.options))) {
    throw new Error("route attempt resolver options must be an object");
  }
  if (value.cleanup !== undefined && typeof value.cleanup !== "function") {
    throw new Error("route attempt resolver cleanup must be a function");
  }
  return value;
}

/**
 * Removes credentials and model metadata belonging to the previous route,
 * then applies the current route's private options. Logical request, safety,
 * effort, and session fields remain router-owned.
 * @param {Object<string, *>} base
 * @param {Object<string, *>|undefined} resolved
 */
function mergeAttemptOptions(base, resolved) {
  const merged = withoutAttemptScopedOptions(base);
  if (resolved === undefined) return merged;
  for (const [key, value] of Object.entries(resolved)) {
    if (RESOLVER_PROTECTED_OPTION_KEYS.has(key)) {
      throw new Error(`route attempt resolver cannot override ${key}`);
    }
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * @param {Object<string, *>} options
 * @returns {Object<string, *>}
 */
function withoutAttemptScopedOptions(options) {
  const projected = { ...options };
  for (const key of ATTEMPT_SCOPED_OPTION_KEYS) delete projected[key];
  return projected;
}

/**
 * Explicit mixed-route projection. Capability-bearing inputs (MCP, skills,
 * schema, live input, native subagents) are never removed here; the capability
 * gate either proves support or skips the route before execution.
 * @param {RouterChainEntry} entry
 * @param {Object<string, *>} options
 */
function projectPerRouteNativeOptions(entry, options) {
  const projected = { ...options };
  switch (entry.model.sdk) {
    case "pi":
      return projected;
    case "claude":
      delete projected.sandboxPolicy;
      delete projected.sandboxEngine;
      return projected;
    case "codex":
    case "opencode":
      delete projected.sandboxPolicy;
      delete projected.sandboxEngine;
      projected.allowedTools = ["*"];
      projected.disallowedTools = [];
      return projected;
    default:
      throw new Error(`per-route-native safety has no contract for sdk ${entry.model.sdk}`);
  }
}

/**
 * @param {string} key
 * @param {RouterChainEntry} entry
 * @param {AgentRuntimeHostOptions} host
 * @param {Map<string, AgentRuntimeInstance>} runtimes
 * @param {import('../types.js').AgentRuntimeToolOptions|undefined} configuredTools
 */
function createRouteRuntime(key, entry, host, runtimes, configuredTools) {
  const runtime = createRuntime(projectPerRouteNativeHost(entry, host));
  if (configuredTools !== undefined) {
    runtime.configureTools?.(projectPerRouteNativeToolOptions(entry, configuredTools));
  }
  runtimes.set(key, runtime);
  return runtime;
}

/**
 * Provider-native routes retain the injected sandbox implementation seam, but
 * must never inherit mono-agent policy data or a concrete srt engine. Assigning
 * explicit `undefined` values (rather than deleting the keys) also clears a
 * previously configured runtime when configureTools is called again.
 * @param {RouterChainEntry} entry
 * @param {import('../types.js').AgentRuntimeToolOptions|undefined} configuredTools
 * @returns {import('../types.js').AgentRuntimeToolOptions}
 */
function projectPerRouteNativeToolOptions(entry, configuredTools = {}) {
  const projected = { ...configuredTools };
  if (entry.model.sdk !== "pi") {
    projected.sandboxPolicy = undefined;
    projected.sandboxEngine = undefined;
  }
  return projected;
}

/**
 * Host-level policy must be isolated alongside request-level policy. The
 * sandbox implementation itself remains available; only enforcing policy data
 * and its route-specific engine are removed for provider-native bridges.
 * @param {RouterChainEntry} entry
 * @param {AgentRuntimeHostOptions} host
 */
function projectPerRouteNativeHost(entry, host) {
  if (entry.model.sdk === "pi") return host;
  const projected = { ...host };
  delete projected.sandboxPolicy;
  delete projected.sandboxEngine;
  return projected;
}

/** @param {RouterChainEntry} entry @param {number} index */
function routeRuntimeKey(entry, index) {
  return `${index}:${modelKey(entry.model)}:${entry.executionMode ?? "default"}`;
}

/** @param {AgentRuntimeInstance} runtime */
function assertRuntimeLike(runtime) {
  if (runtime === null || typeof runtime !== "object" || typeof runtime.run !== "function") {
    throw new Error("route attempt resolver runtime must expose run()");
  }
}

/** @param {Object<string, *>} options @param {string|null|undefined} effort */
function applyEntryEffort(options, effort) {
  if (effort === null) {
    delete options.effort;
  } else if (typeof effort === "string") {
    options.effort = effort;
  }
}

/** @param {unknown} error @returns {RuntimeResult} */
function safetyUnavailableResult(error) {
  // Host resolvers may handle credentials. Never echo their exception text
  // into persisted results or route telemetry.
  void error;
  return {
    text: null,
    error: "The route safety contract could not be established before execution.",
    failureKind: "safety_unavailable",
    events: [],
    cancelled: false,
    usage: {},
  };
}

/** @param {string|null|undefined} failureKind */
function isMidTurnSafetyFailure(failureKind) {
  return typeof failureKind === "string"
    && (failureKind.startsWith("sandbox_") || failureKind.startsWith("safety_"));
}

/**
 * @param {AgentRuntimeInstance} inner
 * @param {Map<string, AgentRuntimeInstance>} routeRuntimes
 */
function allRuntimes(inner, routeRuntimes) {
  return [...new Set([inner, ...routeRuntimes.values()])];
}

/**
 * Merge progress into one bounded snapshot so prompts never accumulate nested
 * resume blocks across a long provider chain.
 * @param {*} previous
 * @param {*} next
 */
function mergeResumeSnapshots(previous, next) {
  if (!next) return previous || null;
  if (!previous) return next;
  const previousTurns = Array.isArray(previous.turns) ? previous.turns : [];
  const nextTurns = Array.isArray(next.turns) ? next.turns : [];
  const allTurns = [...previousTurns, ...nextTurns];
  const turns = allTurns.slice(-3);
  const dropped = allTurns.slice(0, Math.max(0, allTurns.length - turns.length));
  const existingSummaries = [
    ...(Array.isArray(previous.earlier_turn_summaries) ? previous.earlier_turn_summaries : []),
    ...(Array.isArray(next.earlier_turn_summaries) ? next.earlier_turn_summaries : []),
  ].map((entry) => String(entry?.summary ?? "").slice(0, 320)).filter(Boolean);
  const droppedSummaries = dropped.map(summarizeSnapshotTurn);
  const summaries = [...existingSummaries, ...droppedSummaries].slice(-9);
  const turnCount = Math.max(
    turns.length + summaries.length,
    Number(previous.turn_count || 0) + Number(next.turn_count || 0),
  );
  return {
    ...next,
    turn_count: turnCount,
    earlier_turn_summaries: summaries.map((summary, index) => ({
      turn_index: Math.max(1, turnCount - turns.length - summaries.length + index + 1),
      summary,
    })),
    turns,
  };
}

/** @param {*} turn */
function summarizeSnapshotTurn(turn) {
  const assistant = typeof turn?.assistant_text === "string" ? turn.assistant_text.trim() : "";
  const tools = Array.isArray(turn?.tool_uses)
    ? turn.tool_uses.map((tool) => tool?.name).filter(Boolean).slice(0, 5)
    : [];
  const pieces = [];
  if (assistant) pieces.push(assistant.split(/\r?\n/u)[0].slice(0, 220));
  if (tools.length > 0) pieces.push(`tools: ${tools.join(", ")}`);
  return (pieces.join("; ") || "provider attempt made progress").slice(0, 320);
}

/**
 * @param {RouterChainEntry} entry
 * @param {Partial<RuntimeRunOptions>} options
 * @returns {boolean}
 */
function entrySatisfiesRequirements(entry, options) {
  const requires = entry.requires;
  // Synthesize effective requirements: merge the entry's own `requires` with
  // requirements inferred from per-run options, so a chain entry that carries
  // no explicit `requires` (the agent-host + runtime-adapter paths cannot carry
  // one today) still respects option-implied capability needs. Each option
  // inference defers to an explicit entry pin, never overriding it.
  const effectiveRequires = { ...(requires || null) };
  // Infer required capabilities from request-time options. These requirements
  // override a contradictory entry pin (`requires: false`): the caller's actual
  // request cannot be silently weakened. Empty JSON Schema `{}` still counts.
  if (
    options.outputSchema !== undefined
    && options.outputSchema !== null
  ) {
    effectiveRequires.structured_output = true;
  }
  if (
    options.mcpServers !== undefined
    && options.mcpServers !== null
    && Object.keys(options.mcpServers).length > 0
  ) {
    effectiveRequires.supports_mcp = true;
  }
  if (
    Array.isArray(options.skills)
    && options.skills.length > 0
  ) {
    effectiveRequires.supports_skills = true;
  }
  if (options.liveInput) {
    effectiveRequires.supports_live_input = true;
  }
  if (options.fastMode === true) {
    effectiveRequires.supports_fast_mode = true;
  }
  // Native teammates likewise require a capable route; Pi/OpenCode must skip
  // rather than silently dropping them.
  if (
    Array.isArray(options.nativeSubagents?.teammates)
    && options.nativeSubagents.teammates.length > 0
  ) {
    effectiveRequires.supports_native_subagents = true;
  }
  if (Object.keys(effectiveRequires).length === 0) return true;
  let caps;
  try {
    caps = runtimeCapabilities(entry.model);
  } catch {
    return false;
  }
  for (const [key, expected] of Object.entries(effectiveRequires)) {
    if (caps[key] !== expected) return false;
  }
  return true;
}

/**
 * Session identifiers belong to the bridge that created them. Never forward
 * one into a bridge that declares no resume support (notably isolated
 * per-run OpenCode), including when that bridge is reached through fallback.
 * Unknown SDKs retain the existing fail-later behavior.
 * @param {RouterChainEntry} entry
 * @returns {boolean}
 */
function entrySupportsSessionResume(entry) {
  try {
    return runtimeCapabilities(entry.model).supports_session_resume === true;
  } catch {
    return true;
  }
}

/**
 * @param {Partial<RuntimeRunOptions>} callOptions
 * @param {import('../types.js').RuntimeEvent} event
 * @returns {void}
 */
function emit(callOptions, event) {
  try { callOptions.onEvent?.(event); } catch { /* swallow */ }
}

/**
 * @param {RuntimeResult} result
 * @returns {RuntimeResult}
 */
function normalizeProviderAuthFailure(result) {
  if (result.cancelled) return result;
  const failureKind = result.failureKind || null;
  if (failureKind && failureKind !== "provider_unavailable") return result;
  const haystack = `${result.error || ""}\n${result.stderrTail || ""}`;
  if (!isProviderAuthFailureText(haystack)) return result;
  return { ...result, failureKind: "provider_auth" };
}

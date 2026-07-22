import { createPiOAuthApiKeyResolver, createRouterRuntime, createRuntime } from "@mono-agent/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@mono-agent/agent-runtime/ai/runtime/registry.js";
import { monoSandboxImpl } from "./sandbox-impl.js";

import type {
  MonoRuntimeBackendCapabilities,
  MonoRuntimeBackendDescriptor,
  MonoRuntimeBackendId,
  MonoRuntimeHostOptions,
  MonoRuntimeLike,
  MonoRuntimeSelectionEntry,
  MonoRuntimeSupportDescription,
  RuntimeExecutionMode,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeToolOptions,
} from "./types.js";

type KernelRuntimeInstance = ReturnType<typeof createRuntime>;
type KernelHostOptions = NonNullable<Parameters<typeof createRuntime>[0]>;
type KernelRouterOptions = NonNullable<Parameters<typeof createRouterRuntime>[0]>;
type KernelRunOptions = Parameters<KernelRuntimeInstance["run"]>[1];
type KernelToolOptions = Parameters<KernelRuntimeInstance["configureTools"]>[0];

export type RuntimeAdapterErrorCode =
  | "invalid_model_reference"
  | "invalid_execution_mode"
  | "incompatible_execution_mode"
  | "runtime_backend_unavailable"
  | "invalid_runtime_options"
  | "invalid_local_provider";

export interface RuntimeAdapterErrorDetails {
  readonly code?: RuntimeAdapterErrorCode;
  readonly [key: string]: unknown;
}

export class RuntimeAdapterError extends Error {
  readonly code: RuntimeAdapterErrorCode;
  readonly details: RuntimeAdapterErrorDetails;

  constructor(code: RuntimeAdapterErrorCode, message: string, details: RuntimeAdapterErrorDetails = {}) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export function parseMonoRuntimeModelReference(value: string): RuntimeModelReference {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_model_reference", "Model reference must be a non-empty trimmed string.");
  }

  try {
    return normalizeRuntimeModelReference(parseRuntimeModelReference(value));
  } catch (error) {
    throw new RuntimeAdapterError("invalid_model_reference", "Invalid runtime model reference.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function isRuntimeExecutionMode(value: unknown): value is RuntimeExecutionMode {
  return value === "sdk" || value === "cli";
}

export function defaultExecutionModeForModel(model: RuntimeModelReference): RuntimeExecutionMode {
  assertParsedRuntimeModelReference(model);
  return model.sdk === "codex" || model.sdk === "opencode" ? "cli" : "sdk";
}

/**
 * Stable canonical string for a model reference — its authored `reference` when
 * present, else `sdk[:provider]:model`. The one place this format lives, so
 * callers comparing/caching/keying by model (harness override selection, app
 * runtime cache, host/doctor display ids) stay in agreement.
 */
export function modelReferenceKey(model: RuntimeModelReference): string {
  return model.reference ?? `${model.sdk}:${model.provider === undefined ? "" : `${model.provider}:`}${model.model}`;
}

export function listMonoRuntimeBackends(): readonly MonoRuntimeBackendDescriptor[] {
  return RUNTIME_BACKEND_DEFINITIONS.map((definition) => buildBackendDescriptor(definition));
}

export function runtimeBackendForModel(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): MonoRuntimeBackendDescriptor {
  assertParsedRuntimeModelReference(model);
  const resolvedExecutionMode = executionMode ?? defaultExecutionModeForModel(model);
  assertExecutionModeCompatible(model, resolvedExecutionMode);
  return backendById(backendIdForModel(model, resolvedExecutionMode));
}

export function monoRuntimeSupportsSessionResume(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): boolean {
  return runtimeBackendForModel(model, executionMode).capabilities.supports_session_resume === true;
}

export function monoRuntimeSupportsLiveInput(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): boolean {
  return runtimeBackendForModel(model, executionMode).capabilities.supports_live_input === true;
}

export function describeMonoRuntimeSupport(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): MonoRuntimeSupportDescription {
  assertParsedRuntimeModelReference(model);
  const resolvedExecutionMode = executionMode ?? defaultExecutionModeForModel(model);
  if (!isRuntimeExecutionMode(resolvedExecutionMode)) {
    return {
      model,
      executionMode: resolvedExecutionMode,
      compatible: false,
      incompatibilityReason: "Execution mode must be sdk or cli.",
    };
  }

  const incompatibilityReason = executionModeIncompatibilityReason(model, resolvedExecutionMode);
  if (typeof incompatibilityReason === "string" && incompatibilityReason.length > 0) {
    return {
      model,
      executionMode: resolvedExecutionMode,
      compatible: false,
      incompatibilityReason,
    };
  }

  return {
    model,
    executionMode: resolvedExecutionMode,
    compatible: true,
    backend: runtimeBackendForModel(model, resolvedExecutionMode),
  };
}

export function assertExecutionModeCompatible(
  model: RuntimeModelReference,
  executionMode: string,
): void {
  assertParsedRuntimeModelReference(model);
  if (!isRuntimeExecutionMode(executionMode)) {
    throw new RuntimeAdapterError("invalid_execution_mode", "Execution mode must be sdk or cli.", {
      executionMode,
    });
  }

  const reason = executionModeIncompatibilityReason(model, executionMode);
  if (typeof reason === "string" && reason.length > 0) {
    throw new RuntimeAdapterError("incompatible_execution_mode", reason, {
      executionMode,
      model: redactedModelReference(model),
    });
  }
}

export interface MonoRuntimeFallbackChainEntry {
  readonly model: RuntimeModelReference;
  readonly executionMode?: RuntimeExecutionMode;
  /** String pins this route, `null` selects the provider default, omitted inherits the run effort. */
  readonly effort?: string | null;
}

export type MonoRuntimeRouteSafetyMode = "uniform" | "per-route-native";

export interface MonoRuntimeAttemptContext {
  readonly model: RuntimeModelReference;
  readonly executionMode: string | null;
  readonly attemptIndex: number;
  readonly routeSafety: MonoRuntimeRouteSafetyMode;
}

export interface MonoRuntimeAttemptResolution {
  /** Optional isolated runtime for this route. */
  readonly runtime?: MonoRuntimeLike;
  /** Private per-attempt provider options. These are never copied into router telemetry. */
  readonly options?: Readonly<Record<string, unknown>> & {
    /** The sandbox implementation is owned by createMonoRuntime. */
    readonly sandbox?: never;
  };
  readonly cleanup?: () => void | Promise<void>;
}

export type MonoRuntimeAttemptResolver = (
  context: MonoRuntimeAttemptContext,
) => MonoRuntimeAttemptResolution | undefined | Promise<MonoRuntimeAttemptResolution | undefined>;

export interface CreateMonoRuntimeOptions extends MonoRuntimeHostOptions {
  /** The sandbox implementation is owned and injected by runtime-adapter. */
  readonly sandbox?: never;
  /**
   * Ordered model chain for provider failover. When present, runs are served by
   * the agent-runtime fallback router: the first entry is attempted first and
   * each retryable provider failure advances to the next entry, so callers
   * should put the primary model at index 0. The router overrides the per-run
   * `model`/`executionMode` with chain entries; failover details are reported
   * on the result as `failoverHistory`.
   */
  readonly fallbackChain?: readonly MonoRuntimeFallbackChainEntry[];
  /** Compatibility-preserving uniform safety, or explicit isolated provider-native route contracts. */
  readonly routeSafety?: MonoRuntimeRouteSafetyMode;
  /** Private host seam for actual-model provider options and route-owned runtimes. */
  readonly resolveAttempt?: MonoRuntimeAttemptResolver;
}

export function createMonoRuntime(options: CreateMonoRuntimeOptions = {}): MonoRuntimeLike {
  const { fallbackChain, routeSafety = "uniform", resolveAttempt, ...hostOptions } = options;
  if (routeSafety !== "uniform" && routeSafety !== "per-route-native") {
    throw new RuntimeAdapterError(
      "invalid_runtime_options",
      "Runtime route safety must be uniform or per-route-native.",
      { routeSafety },
    );
  }
  const chain = normalizeFallbackChain(fallbackChain);
  // agent-runtime's kernel ships only a fail-closed passthrough sandbox (see
  // agent/sandbox-seam.js) — this is the ONE place the real sandbox
  // implementation gets injected, so every mono-agent host's sandbox policy is
  // actually enforced without the kernel depending on this package itself.
  const hostWithSandbox = {
    ...withoutCallerSandbox(hostOptions),
    sandbox: monoSandboxImpl,
  } as unknown as KernelHostOptions;
  const protectedResolveAttempt = resolveAttempt === undefined
    ? undefined
    : protectAttemptResolver(resolveAttempt);
  const runtime = chain === undefined
    ? createRuntime(hostWithSandbox)
    : createRouterRuntime({
        host: hostWithSandbox,
        chain,
        routeSafety,
        ...(protectedResolveAttempt === undefined
          ? {}
          : {
              resolveAttempt: protectedResolveAttempt as unknown as NonNullable<KernelRouterOptions["resolveAttempt"]>,
            }),
      });

  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
        throw new RuntimeAdapterError("invalid_runtime_options", "Runtime system prompt must be a non-empty string.");
      }
      if (runOptions === undefined || runOptions === null || typeof runOptions !== "object") {
        throw new RuntimeAdapterError("invalid_runtime_options", "Runtime run options must be an object.");
      }

      assertParsedRuntimeModelReference(runOptions.model);
      const executionMode = runOptions.executionMode ?? defaultExecutionModeForModel(runOptions.model);
      assertExecutionModeCompatible(runOptions.model, executionMode);

      const result = await runtime.run(systemPrompt, {
        ...withoutCallerSandbox(runOptions),
        executionMode,
      } as unknown as KernelRunOptions);
      return result as RuntimeResult;
    },
    configureTools(next?: RuntimeToolOptions): void {
      runtime.configureTools?.(
        next === undefined
          ? undefined
          : (withoutCallerSandbox(next) as unknown as KernelToolOptions),
      );
    },
    async syncSession(providerSessionId: string): Promise<boolean> {
      return await runtime.syncSession?.(providerSessionId) === true;
    },
    async refreshSession(providerSessionId: string): Promise<void> {
      if (typeof runtime.refreshSession !== "function") {
        throw new RuntimeAdapterError(
          "runtime_backend_unavailable",
          "The runtime cannot guarantee a cold provider-session reopen.",
        );
      }
      await runtime.refreshSession(providerSessionId);
    },
    async retireDurableSession(providerSessionId: string, sessionsRoot: string): Promise<void> {
      if (typeof runtime.retireDurableSession !== "function") {
        throw new RuntimeAdapterError(
          "runtime_backend_unavailable",
          "The runtime cannot retire durable provider-session state.",
        );
      }
      await runtime.retireDurableSession(providerSessionId, sessionsRoot);
    },
    async disposeSession(providerSessionId: string): Promise<boolean> {
      return Boolean(await runtime.disposeSession?.(providerSessionId));
    },
    async invalidateSession(providerSessionId: string): Promise<boolean> {
      return Boolean(await runtime.invalidateSession?.(providerSessionId));
    },
    async disposeAllSessions(): Promise<void> {
      await runtime.disposeAllSessions?.();
    },
  };
}

/**
 * The kernel intentionally supports request/configure-time sandbox implementation
 * replacement for non-mono hosts. The mono facade does not: it owns one concrete
 * implementation and accepts only policy/engine data from callers and plugins.
 * Always return a fresh object so rejecting that implementation never mutates a
 * caller-owned (possibly frozen) option bag.
 */
function withoutCallerSandbox<T extends Readonly<Record<string, unknown>>>(
  input: T,
): Omit<T, "sandbox"> {
  const { sandbox: _callerSandbox, ...rest } = input;
  return rest;
}

function protectAttemptResolver(
  resolveAttempt: MonoRuntimeAttemptResolver,
): MonoRuntimeAttemptResolver {
  return async (context) => {
    const resolution = await resolveAttempt(context);
    if (resolution === undefined) {
      return undefined;
    }
    return {
      ...resolution,
      ...(resolution.options === undefined
        ? {}
        : { options: withoutCallerSandbox(resolution.options) }),
    };
  };
}

export { createPiOAuthApiKeyResolver };

function normalizeFallbackChain(
  fallbackChain: readonly MonoRuntimeFallbackChainEntry[] | undefined,
): readonly {
  model: RuntimeModelReference;
  executionMode: RuntimeExecutionMode;
  effort?: string | null;
}[] | undefined {
  if (fallbackChain === undefined) {
    return undefined;
  }
  if (!Array.isArray(fallbackChain) || fallbackChain.length === 0) {
    throw new RuntimeAdapterError("invalid_runtime_options", "Runtime fallback chain must be a non-empty array.");
  }
  const normalized = fallbackChain.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RuntimeAdapterError(
        "invalid_runtime_options",
        "Each runtime fallback chain entry must be an object with a model reference.",
      );
    }
    assertParsedRuntimeModelReference(entry.model);
    const executionMode = entry.executionMode ?? defaultExecutionModeForModel(entry.model);
    assertExecutionModeCompatible(entry.model, executionMode);
    if (
      entry.effort !== undefined
      && entry.effort !== null
      && (typeof entry.effort !== "string" || entry.effort.trim().length === 0 || entry.effort !== entry.effort.trim())
    ) {
      throw new RuntimeAdapterError(
        "invalid_runtime_options",
        "Runtime fallback effort must be a non-empty trimmed string, null, or omitted.",
      );
    }
    return {
      model: entry.model,
      executionMode,
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    };
  });
  return normalized;
}

export function assertParsedRuntimeModelReference(value: unknown): asserts value is RuntimeModelReference {
  normalizeRuntimeModelReference(value);
}

function normalizeRuntimeModelReference(value: unknown): RuntimeModelReference {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new RuntimeAdapterError(
      "invalid_model_reference",
      "Runtime model reference must be a parsed object with sdk and model.",
    );
  }

  const sdk = normalizedRequiredString(value.sdk, "sdk");
  const model = normalizedRequiredString(value.model, "model");
  const normalized: { sdk: string; model: string; provider?: string; reference?: string } = { sdk, model };

  if (value.provider !== undefined) {
    normalized.provider = normalizedRequiredString(value.provider, "provider");
  }
  if (value.reference !== undefined) {
    normalized.reference = normalizedRequiredString(value.reference, "reference");
  }

  return normalized;
}

interface RuntimeBackendDefinition {
  readonly id: MonoRuntimeBackendId;
  /** Agent-runtime bridge id whose capabilities back this descriptor. */
  readonly runtimeBridgeId: string;
  readonly label: string;
  readonly sdk: RuntimeModelReference["sdk"];
  readonly executionMode: RuntimeExecutionMode;
  readonly transport: "sdk" | "cli";
  readonly providerBoundary: string;
  readonly modelReferenceExamples: readonly string[];
  readonly acceptsProviderIds: boolean;
}

const RUNTIME_BACKEND_DEFINITIONS: readonly RuntimeBackendDefinition[] = [
  {
    id: "claude-sdk",
    runtimeBridgeId: "claude",
    label: "Claude SDK",
    sdk: "claude",
    executionMode: "sdk",
    transport: "sdk",
    providerBoundary: "@anthropic-ai/claude-agent-sdk via @mono-agent/agent-runtime",
    modelReferenceExamples: ["claude:claude-sonnet-4-6"],
    acceptsProviderIds: false,
  },
  {
    id: "claude-code-cli",
    runtimeBridgeId: "claude-code",
    label: "Claude Code CLI",
    sdk: "claude",
    executionMode: "cli",
    transport: "cli",
    providerBoundary: "Claude Code CLI bridge via @mono-agent/agent-runtime",
    modelReferenceExamples: ["claude:claude-sonnet-4-6"],
    acceptsProviderIds: false,
  },
  {
    id: "codex-app-cli",
    runtimeBridgeId: "codex-app",
    label: "Codex app CLI",
    sdk: "codex",
    executionMode: "cli",
    transport: "cli",
    providerBoundary: "Codex app-server bridge via @mono-agent/agent-runtime",
    modelReferenceExamples: ["codex:gpt-5.5"],
    acceptsProviderIds: false,
  },
  {
    id: "opencode-app-cli",
    runtimeBridgeId: "opencode-app",
    label: "OpenCode app CLI",
    sdk: "opencode",
    executionMode: "cli",
    transport: "cli",
    providerBoundary: "OpenCode app-server bridge via @mono-agent/agent-runtime",
    modelReferenceExamples: ["opencode:github-copilot:gpt-4.1"],
    acceptsProviderIds: true,
  },
  {
    id: "pi-sdk",
    runtimeBridgeId: "pi",
    label: "Pi SDK provider",
    sdk: "pi",
    executionMode: "sdk",
    transport: "sdk",
    providerBoundary: "Pi SDK provider gateway via @mono-agent/agent-runtime",
    modelReferenceExamples: ["pi:openai-codex:gpt-5.5", "pi:github-copilot:gpt-4.1"],
    acceptsProviderIds: true,
  },
];

/**
 * The additive (sdk, executionMode) -> backend selection table. This is a
 * internal routing table: it states which backend serves a given sdk under a
 * given execution mode. `sdkAliases[0]` is the canonical sdk id used by the
 * backend descriptor; later entries may be accepted legacy spellings.
 */
const RUNTIME_SELECTION_TABLE: readonly MonoRuntimeSelectionEntry[] = [
  { sdk: "claude", sdkAliases: ["claude"], executionMode: "sdk", backendId: "claude-sdk" },
  { sdk: "claude", sdkAliases: ["claude"], executionMode: "cli", backendId: "claude-code-cli" },
  { sdk: "codex", sdkAliases: ["codex"], executionMode: "cli", backendId: "codex-app-cli" },
  { sdk: "opencode", sdkAliases: ["opencode"], executionMode: "cli", backendId: "opencode-app-cli" },
  { sdk: "pi", sdkAliases: ["pi"], executionMode: "sdk", backendId: "pi-sdk" },
];

/**
 * Resolves a backend id from the selection table by sdk (canonical or alias) and
 * execution mode. Returns undefined when no row matches, leaving the caller to
 * decide how to fail.
 */
export function selectMonoRuntimeBackendId(
  sdk: string,
  executionMode: RuntimeExecutionMode,
): MonoRuntimeBackendId | undefined {
  const entry = RUNTIME_SELECTION_TABLE.find(
    (candidate) => candidate.executionMode === executionMode && candidate.sdkAliases.includes(sdk),
  );
  return entry?.backendId;
}

function buildBackendDescriptor(
  definition: RuntimeBackendDefinition,
): MonoRuntimeBackendDescriptor {
  const { runtimeBridgeId, ...rest } = definition;
  return {
    ...rest,
    runtimeBridgeId,
    capabilities: capabilitiesForRuntimeBridge(runtimeBridgeId),
  };
}

function backendById(id: MonoRuntimeBackendId): MonoRuntimeBackendDescriptor {
  const definition = RUNTIME_BACKEND_DEFINITIONS.find((candidate) => candidate.id === id);
  if (definition === undefined) {
    throw new RuntimeAdapterError("runtime_backend_unavailable", "Runtime backend is not registered.", { id });
  }
  return buildBackendDescriptor(definition);
}

function backendIdForModel(
  model: RuntimeModelReference,
  executionMode: RuntimeExecutionMode,
): MonoRuntimeBackendId {
  if (model.sdk === "claude" && executionMode === "cli") {
    return "claude-code-cli";
  }
  if (model.sdk === "claude" && executionMode === "sdk") {
    return "claude-sdk";
  }
  if (model.sdk === "codex" && executionMode === "cli") {
    return "codex-app-cli";
  }
  if (model.sdk === "opencode" && executionMode === "cli") {
    return "opencode-app-cli";
  }
  if (model.sdk === "pi" && executionMode === "sdk") {
    return "pi-sdk";
  }
  throw new RuntimeAdapterError("runtime_backend_unavailable", "No runtime backend matches this model and execution mode.", {
    model: redactedModelReference(model),
    executionMode,
  });
}

function capabilitiesForRuntimeBridge(
  runtimeBridgeId: string,
): MonoRuntimeBackendCapabilities {
  const bridge = listRuntimeBridges().find((candidate) => candidate.id === runtimeBridgeId);
  if (bridge === undefined) {
    throw new RuntimeAdapterError("runtime_backend_unavailable", "Agent runtime bridge is not registered.", {
      runtimeBridgeId,
    });
  }
  const capabilities = bridge.capabilities();
  if (!isRecord(capabilities) || Array.isArray(capabilities)) {
    throw new RuntimeAdapterError("runtime_backend_unavailable", "Agent runtime bridge returned invalid capabilities.", {
      runtimeBridgeId,
    });
  }
  return { ...capabilities };
}

function normalizedRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_model_reference", `Runtime model reference ${field} must be a non-empty trimmed string.`, {
      field,
    });
  }
  return value;
}

function redactedModelReference(model: RuntimeModelReference): Record<string, string | undefined> {
  return {
    sdk: model.sdk,
    provider: model.provider,
    model: model.model,
    reference: model.reference,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import {
  createAgentHarness,
  createAgentResponder,
  createDurableHistoryStore,
  createToolPolicy,
  loadToolPolicyFromJsonFileSync,
} from "@mono-agent/agent-harness";
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
  ConversationHistoryStore,
} from "@mono-agent/agent-harness";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import { resolve as resolvePath } from "node:path";

import type { AgentResponder, MemoryStore } from "@mono-agent/agent-contracts";
import { resolveSupermemoryContainer } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { LlmComplete } from "@mono-agent/memory/bujo";
import { createCompositeRunRecorder, createJsonlRunRecorder } from "@mono-agent/observability";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunRecorder,
  RunSummary,
  RuntimeResultLike,
} from "@mono-agent/observability";
import { createPhoenixRunExporter } from "@mono-agent/observability/otel";
import {
  assertExecutionModeCompatible,
  createMonoRuntime,
  createPiOAuthApiKeyResolver,
  defaultExecutionModeForModel,
  modelReferenceKey,
  monoRuntimeSupportsSessionResume,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
} from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeFallbackChainEntry,
  MonoRuntimeLike,
  RuntimeExecutionMode,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import { resolveMemoryRecallSettings } from "./memory-recall.js";
import {
  createSharedMemoryRecallRuntimeExtension,
  isSharedRecallStore,
  MemoryRetrievalService,
} from "./memory-retrieval.js";
import { composeRuntimeOptionExtensions } from "./runtime-option-extensions.js";
import { loadSupermemoryPlugin } from "./supermemory-plugin.js";

type StaticRuntimeOptions = NonNullable<AgentHarnessOptions["runtimeOptions"]>;

export interface ConfiguredAgentRuntimeOptions {
  readonly config: MonoAgentConfig;
  readonly model?: RuntimeModelReference;
  readonly executionMode?: string;
  readonly sandboxEngine?: SandboxEngine;
}

export type ConfiguredAgentSessionEventKind = "acquired" | "released" | "saved" | "evicted" | "isolated" | "cold";

export interface ConfiguredAgentSessionSnapshot {
  readonly conversationId: string;
  readonly providerSessionId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly busy: boolean;
}

export interface ConfiguredAgentSessionEvent {
  readonly kind: ConfiguredAgentSessionEventKind;
  readonly conversationId: string;
  readonly providerSessionId?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly snapshot?: readonly ConfiguredAgentSessionSnapshot[];
}

type ConfiguredAgentSessionEventHandler = (event: ConfiguredAgentSessionEvent) => void | Promise<void>;
type AgentHarnessSessionOptionsWithEvents = NonNullable<AgentHarnessOptions["session"]> & {
  readonly onSessionEvent?: ConfiguredAgentSessionEventHandler;
};

export interface ConfiguredAgentHarnessOptions {
  readonly config: MonoAgentConfig;
  /** Agent config folder used to resolve explicitly installed optional plugins. */
  readonly cwd?: string;
  readonly runtime?: MonoRuntimeLike;
  readonly model?: RuntimeModelReference;
  readonly executionMode?: string;
  readonly memory?: MemoryStore;
  readonly historyStore?: ConversationHistoryStore;
  /** App-owned run-scoped interaction details to add only to replay history. */
  readonly turnHistoryEnricher?: AgentHarnessOptions["turnHistoryEnricher"];
  /** App-owned issuer for request-scoped project-MCP progress credentials. */
  readonly progressCapabilityIssuer?: NonNullable<AgentHarnessOptions["mcpRequestContext"]>["progressCapabilityIssuer"];
  /** App-owned issuer for destination-bound asynchronous continuation claims. */
  readonly continuationCapabilityIssuer?: NonNullable<AgentHarnessOptions["continuationContext"]>["capabilityIssuer"];
  readonly createRunId?: AgentHarnessOptions["createRunId"];
  readonly now?: AgentHarnessOptions["now"];
  readonly runtimeOptions?: AgentHarnessOptions["runtimeOptions"];
  readonly sandboxEngine?: SandboxEngine;
  readonly runtimeOptionsForRequest?: (
    input: AgentHarnessRuntimeOptionsInput,
  ) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;
  /** Best-effort diagnostic when the default MemoryRecall endpoint cannot start. */
  readonly onMemoryRecallUnavailable?: (error: unknown) => void;
  /** Best-effort host diagnostic for post-provider memory write failures. */
  readonly onMemoryWarning?: (message: string) => void;
  readonly onSessionEvent?: ConfiguredAgentSessionEventHandler;
  /**
   * Factory for a runtime bound to a per-request override model (cron/webhook
   * per-trigger model). Wired by the app so override runtimes share the
   * configured fallback chain and participate in config-reload disposal.
   */
  readonly runtimeForModel?: AgentHarnessOptions["runtimeForModel"];
  /**
   * Exporter-context fields the factory input cannot supply. Surfaced on the
   * exported root span so Phoenix traces map back to the running host and its
   * local artifacts.
   */
  readonly observabilityContext?: {
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  };
  /** Best-effort exporter warnings (timeouts, transport failures). */
  readonly exporterWarn?: (warning: { phase: string; message: string }) => void;
  /** Injection seam (tests); defaults to createPhoenixRunExporter. */
  readonly exporterFactory?: (config: PhoenixExporterConfig) => RunExporter;
}

export interface ConfiguredAgentResponderOptions extends ConfiguredAgentHarnessOptions {}

interface RunArtifactCommitEvent {
  readonly phase: "started" | "finished";
  readonly runId: string;
  readonly conversationId: string;
}

type RunArtifactCommitHook = (event: RunArtifactCommitEvent) => void | Promise<void>;

interface ConfiguredAgentInternalHooks {
  /**
   * App-owned hook invoked after the local JSONL running/terminal summary is
   * committed. Invocation runs before best-effort exporter work; a returned
   * promise is not awaited and all hook failures are ignored.
   */
  readonly onRunArtifactCommitted?: RunArtifactCommitHook;
  /** App-only read decoration around the configured canonical history store. */
  readonly wrapHistoryStore?: (store: ConversationHistoryStore) => ConversationHistoryStore;
}

/**
 * Inputs the recorder composition needs that are stable across a run: the
 * artifact directory, the configured exporters, and the per-host export
 * context. Shared by the channel-run `recorderFactory` and the memory LLM so
 * both produce identical JSONL artifacts + Phoenix spans.
 */
interface RecorderCompositionDeps {
  readonly artifactDir: string;
  readonly exporters: readonly PhoenixExporterConfig[];
  readonly observabilityContext?: ConfiguredAgentHarnessOptions["observabilityContext"];
  readonly exporterWarn?: ConfiguredAgentHarnessOptions["exporterWarn"];
  readonly exporterFactory?: ConfiguredAgentHarnessOptions["exporterFactory"];
  readonly onRunArtifactCommitted?: RunArtifactCommitHook;
}

/**
 * Build a recorder for one run. The JSONL recorder is always built first and is
 * returned unchanged when neither an artifact hook nor exporter is configured.
 * The optional artifact hook wraps only its commit boundary. When an exporter is
 * present the result is wrapped again so export is best-effort and additive —
 * exporter failures only surface as warnings and never change the run outcome.
 */
function composeRunRecorder(
  deps: RecorderCompositionDeps,
  args: {
    readonly runId: string;
    readonly conversationId: string;
    readonly userInput?: string;
    readonly systemPrompt?: string;
    readonly runKind?: "memory" | "channel";
    readonly memoryOperation?: string;
    readonly isolated?: boolean;
    /** Originating channel/trigger kind, e.g. "tui" | "cron" | "webhook" | "memory". */
    readonly source?: string;
    /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
    readonly sourceDetail?: string;
  },
): RunRecorder {
  const jsonl = withArtifactCommitHook(createJsonlRunRecorder({
    runId: args.runId,
    conversationId: args.conversationId,
    artifactDir: deps.artifactDir,
    ...(args.runKind === "memory" ? { artifactKind: "memory" as const } : {}),
    ...(args.isolated === undefined ? {} : { isolated: args.isolated }),
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.sourceDetail === undefined ? {} : { sourceDetail: args.sourceDetail }),
  }), deps.onRunArtifactCommitted, args);
  const exporterCfg = deps.exporters[0];
  if (exporterCfg === undefined) {
    return jsonl;
  }
  const exporter = (deps.exporterFactory ?? createPhoenixRunExporter)(exporterCfg);
  const context: RunExportContext = {
    runId: args.runId,
    conversationId: args.conversationId,
    ...(deps.observabilityContext?.sourceId === undefined
      ? {}
      : { sourceId: deps.observabilityContext.sourceId }),
    ...(deps.observabilityContext?.sourceLabel === undefined
      ? {}
      : { sourceLabel: deps.observabilityContext.sourceLabel }),
    ...(deps.observabilityContext?.configPath === undefined
      ? {}
      : { configPath: deps.observabilityContext.configPath }),
    artifactDir: deps.artifactDir,
    includeSensitiveData: exporterCfg.includeSensitiveData ?? false,
    contentPatternRedaction: exporterCfg.contentPatternRedaction ?? false,
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.runKind === undefined ? {} : { runKind: args.runKind }),
    ...(args.memoryOperation === undefined ? {} : { memoryOperation: args.memoryOperation }),
  };
  const composite = createCompositeRunRecorder({
    recorder: jsonl,
    exporter,
    context,
    timeoutMs: exporterCfg.timeoutMs ?? 5000,
    ...(deps.exporterWarn === undefined ? {} : { onWarning: deps.exporterWarn }),
  });
  return composite;
}

/**
 * Notify the app at the exact local-artifact boundary. This wrapper sits inside
 * the exporter composite, so slow exporter start/finish
 * work cannot leave artifact-derived caches stale after JSONL has committed.
 */
function withArtifactCommitHook(
  recorder: RunRecorder,
  onCommitted: RunArtifactCommitHook | undefined,
  args: { readonly runId: string; readonly conversationId: string },
): RunRecorder {
  if (onCommitted === undefined) {
    return recorder;
  }
  let terminalPromise: Promise<RunSummary> | undefined;
  const notify = (phase: "started" | "finished"): void => {
    try {
      // The cache invalidation used by the app is synchronous. Promise.resolve
      // also contains an async implementation without delaying
      // the JSONL/export pipeline or leaking an unhandled rejection.
      void Promise.resolve(onCommitted({ phase, runId: args.runId, conversationId: args.conversationId }))
        .catch(() => undefined);
    } catch {
      // Best-effort host bookkeeping must never alter the recorded run outcome.
    }
  };
  const commitTerminal = (operation: () => Promise<RunSummary>): Promise<RunSummary> => {
    terminalPromise ??= operation().then((summary) => {
      notify("finished");
      return summary;
    });
    return terminalPromise;
  };
  const wrapped: RunRecorder = {
    onEvent(event): void {
      recorder.onEvent(event);
    },
    async prepareFinish(result: RuntimeResultLike): Promise<void> {
      await recorder.prepareFinish?.(result);
    },
    async commitFinish(result: RuntimeResultLike): Promise<RunSummary> {
      return await commitTerminal(async () => recorder.commitFinish === undefined
        ? await recorder.finish(result)
        : await recorder.commitFinish(result));
    },
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      await wrapped.prepareFinish?.(result);
      return await wrapped.commitFinish!(result);
    },
    async fail(error: unknown): Promise<RunSummary> {
      return await commitTerminal(async () => await recorder.fail(error));
    },
  };
  if (recorder.start !== undefined) {
    wrapped.start = async (): Promise<RunSummary> => {
      const summary = await recorder.start!();
      notify("started");
      return summary;
    };
  }
  return wrapped;
}

/** Collect the recorder-composition deps from the host config + harness options. */
function recorderCompositionDeps(
  config: MonoAgentConfig,
  options: Pick<
    ConfiguredAgentHarnessOptions,
    "observabilityContext" | "exporterWarn" | "exporterFactory"
  >,
  internalHooks: ConfiguredAgentInternalHooks = {},
): RecorderCompositionDeps {
  const sourceLabel = options.observabilityContext?.sourceLabel ?? config.agent?.name;
  const observabilityContext = options.observabilityContext === undefined && sourceLabel === undefined
    ? undefined
    : {
        ...options.observabilityContext,
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
      };
  return {
    artifactDir: config.artifacts.dir,
    exporters: config.observability?.exporters ?? [],
    ...(observabilityContext === undefined
      ? {}
      : { observabilityContext }),
    ...(options.exporterWarn === undefined ? {} : { exporterWarn: options.exporterWarn }),
    ...(options.exporterFactory === undefined ? {} : { exporterFactory: options.exporterFactory }),
    ...(internalHooks.onRunArtifactCommitted === undefined
      ? {}
      : { onRunArtifactCommitted: internalHooks.onRunArtifactCommitted }),
  };
}

export function createConfiguredAgentRuntime(config: MonoAgentConfig): MonoRuntimeLike;
export function createConfiguredAgentRuntime(options: ConfiguredAgentRuntimeOptions): MonoRuntimeLike;
export function createConfiguredAgentRuntime(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  const options = isRuntimeOptions(input) ? input : undefined;
  const fallback = fallbackChainForConfig(config, options);
  const runtimeOptions: Parameters<typeof createMonoRuntime>[0] = {
    ...runtimeHostOptionsForConfig(config),
    ...(options?.sandboxEngine === undefined ? {} : { sandboxEngine: options.sandboxEngine }),
    ...fallback,
    ...(fallback.fallbackChain === undefined
      ? {}
      : {
          routeSafety: config.runtime.routeSafety ?? "uniform",
          // Resolve custom/local Pi options from the ACTUAL route selected by
          // the fallback router. Secrets stay inside this private return value
          // and are never copied into route metadata or events.
          resolveAttempt: ({ model }) => ({
            options: runtimeOptionsForLocalProvider(model, config.providers?.local),
          }),
        }),
  };
  return createMonoRuntime(runtimeOptions);
}

/**
 * When backup models are configured, runs go through the agent-runtime fallback
 * router with the effective primary model first. Fallback entries use their
 * default execution mode.
 */
function fallbackChainForConfig(
  config: MonoAgentConfig,
  options: ConfiguredAgentRuntimeOptions | undefined,
): { fallbackChain?: readonly MonoRuntimeFallbackChainEntry[] } {
  const canonicalFallbacks = config.runtime.fallbacks;
  const legacyFallbackModels = config.runtime.fallbackModels;
  if ((canonicalFallbacks?.length ?? 0) === 0 && (legacyFallbackModels?.length ?? 0) === 0) {
    return {};
  }
  const primaryModel = options?.model ?? config.runtime.model;
  const primaryExecutionMode = options?.executionMode ?? config.runtime.executionMode;
  // Drop any fallback equal to the primary so a per-trigger override that happens
  // to match a configured backup is not retried against itself before advancing.
  const primaryKey = modelReferenceKey(primaryModel);
  const canonicalFallbackEntries = canonicalFallbacks ?? [];
  const fallbackEntries: readonly MonoRuntimeFallbackChainEntry[] = canonicalFallbackEntries.length > 0
    ? canonicalFallbackEntries
        .filter((entry) => modelReferenceKey(entry.model) !== primaryKey)
        .map((entry) => ({
          model: entry.model,
          // Canonical omission means provider default. Legacy fallbackModels
          // omit this field and therefore continue inheriting runtime.effort.
          effort: entry.effort ?? null,
        }))
    : (legacyFallbackModels ?? [])
        .filter((model) => modelReferenceKey(model) !== primaryKey)
        .map((model) => ({ model }));
  return {
    fallbackChain: [
      { model: primaryModel, executionMode: primaryExecutionMode as RuntimeExecutionMode },
      ...fallbackEntries,
    ],
  };
}

/**
 * Memory backends load lazily: the SQLite/BuJo stack (better-sqlite3,
 * sqlite-vec) and the Supermemory REST client are imported only when
 * `config.memory` selects them, so a memory-less or supermemory-only agent
 * never pays for the other backend. This is what makes the configured
 * composition functions async.
 */
type MemoryBujoModule = typeof import("@mono-agent/memory/bujo");
type MemorySearchModule = typeof import("@mono-agent/memory/search");

let memoryBujoModule: MemoryBujoModule | undefined;
let memorySearchModule: MemorySearchModule | undefined;

const loadMemoryBujoModule = async (): Promise<MemoryBujoModule> =>
  (memoryBujoModule ??= await import("@mono-agent/memory/bujo"));
const loadMemorySearchModule = async (): Promise<MemorySearchModule> =>
  (memorySearchModule ??= await import("@mono-agent/memory/search"));

export async function createConfiguredAgentHarness(options: ConfiguredAgentHarnessOptions): Promise<AgentHarness> {
  return await createConfiguredAgentHarnessInternal(options);
}

async function createConfiguredAgentHarnessInternal(
  options: ConfiguredAgentHarnessOptions,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<AgentHarness> {
  const config = options.config;
  const model = options.model ?? config.runtime.model;
  const executionMode = options.executionMode ?? config.runtime.executionMode;
  const runtime = options.runtime ?? createConfiguredAgentRuntime({
    config,
    model,
    executionMode,
    ...(options.sandboxEngine === undefined ? {} : { sandboxEngine: options.sandboxEngine }),
  });
  // The memory LLM must NOT ride the channel `runtime`: that runtime carries the
  // channel fallback chain whose primary is `config.runtime.model`, and the
  // fallback router overrides each run's per-call `model` — so reusing it would
  // execute memory capture on `config.runtime.model` instead of
  // `config.memory.llm.model`. createConfiguredMemory builds the memory LLM its own
  // fallback-free runtime when no `memoryRuntime` is injected.
  const configuredMemory = options.memory ?? (await createConfiguredMemory(config, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }));
  const memory = configuredMemoryForHarness(config, configuredMemory);
  const memoryRecall = resolveMemoryRecallSettings(config) === undefined
    || !(memory instanceof MemoryRetrievalService)
    ? undefined
    : createSharedMemoryRecallRuntimeExtension(memory, {
        ...(options.onMemoryRecallUnavailable === undefined
          ? {}
          : { onUnavailable: options.onMemoryRecallUnavailable }),
      });
  const runtimeOptionsForRequest = composeRuntimeOptionExtensions([
    memoryRecall,
    options.runtimeOptionsForRequest,
  ], {
    // The app-owned, read-only MemoryRecall endpoint is part of every configured
    // memory tier. Preserve only this exact extension under an authenticated
    // request override; arbitrary caller/action MCP extensions remain excluded.
    preserveMcpServersUnderOverride: memoryRecall === undefined ? [] : [memoryRecall],
  });
  const runtimeOptions = mergeStaticRuntimeOptions(
    runtimeOptionsForLocalProvider(model, config.providers?.local),
    configRuntimeFlags(config),
    options.sandboxEngine === undefined ? undefined : { sandboxEngine: options.sandboxEngine },
    options.runtimeOptions,
  );
  const sessionOptions: AgentHarnessSessionOptionsWithEvents = {
    mode: config.runtime.session.mode,
    idleTimeoutMs: config.runtime.session.idleTimeoutMs,
    // Any fallback makes the logical run stateless. A provider-owned session
    // cannot safely cross the route boundary, even when both bridges happen to
    // expose resume support. History replay remains available to every attempt.
    supportsResume: hasConfiguredFallback(config)
      ? false
      : supportsSessionResume(model, executionMode),
    ...(config.runtime.session.isolateProactive === undefined
      ? {}
      : { isolateProactive: config.runtime.session.isolateProactive }),
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
  };
  const piSessionsRoot = config.providers?.piNative?.piSessionsRoot;
  const retireDurableSession = runtime.retireDurableSession?.bind(runtime);
  const baseHistoryStore = options.historyStore ?? createDurableHistoryStore({
    root: resolvePath(config.artifacts.dir, "..", "history"),
    maxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    ...(piSessionsRoot === undefined || retireDurableSession === undefined
      ? {}
      : {
          retireProviderSession: async (providerSessionId: string): Promise<void> => {
            await retireDurableSession(providerSessionId, piSessionsRoot);
          },
        }),
  });
  const historyStore = internalHooks.wrapHistoryStore?.(baseHistoryStore) ?? baseHistoryStore;

  return createAgentHarness({
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    ...(config.context.skillMaxBytes === undefined ? {} : { skillMaxBytes: config.context.skillMaxBytes }),
    ...(config.context.skillDisclosure === undefined ? {} : { skillDisclosure: config.context.skillDisclosure }),
    selectedSkills: config.context.selectedSkills,
    runtime,
    model,
    executionMode,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    ...(config.runtime.maxTurns === undefined ? {} : { maxTurns: config.runtime.maxTurns }),
    ...(config.providers?.piNative?.piSessionsRoot === undefined
      ? {}
      : { piSessionsRoot: config.providers.piNative.piSessionsRoot }),
    session: sessionOptions,
    ...(config.concurrency?.maxConcurrentRuns === undefined && config.concurrency?.maxPendingRuns === undefined
      ? {}
      : {
          concurrency: {
            ...(config.concurrency?.maxConcurrentRuns === undefined
              ? {}
              : { maxConcurrentRuns: config.concurrency.maxConcurrentRuns }),
            ...(config.concurrency?.maxPendingRuns === undefined
              ? {}
              : { maxPendingRuns: config.concurrency.maxPendingRuns }),
          },
        }),
    runtimeOptions,
    ...(runtimeOptionsForRequest === undefined
      ? {}
      : { runtimeOptionsForRequest }),
    ...(config.tools.mcpRequestContextServers === undefined
      ? {}
      : {
          mcpRequestContext: {
            serverNames: config.tools.mcpRequestContextServers,
            runOutputRoot: resolvePath(config.artifacts.dir, "outbound"),
            ...(options.progressCapabilityIssuer === undefined
              ? {}
              : { progressCapabilityIssuer: options.progressCapabilityIssuer }),
          },
        }),
    ...(config.tools.continuationServers === undefined || options.continuationCapabilityIssuer === undefined
      ? {}
      : {
          continuationContext: {
            serverNames: config.tools.continuationServers,
            capabilityIssuer: options.continuationCapabilityIssuer,
          },
        }),
    ...(options.runtimeForModel === undefined ? {} : { runtimeForModel: options.runtimeForModel }),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    ...(options.onMemoryWarning === undefined ? {} : { onMemoryWarning: options.onMemoryWarning }),
    historyStore,
    ...(options.turnHistoryEnricher === undefined ? {} : { turnHistoryEnricher: options.turnHistoryEnricher }),
    // Inbound channel attachments are saved here (under the artifacts dir, which
    // sits inside a sandbox-readable root) so the agent can open them by path.
    attachmentsDir: resolvePath(config.artifacts.dir, "attachments"),
    toolPolicy: createToolPolicy(toolPolicyInput(config)),
    ...(config.sandbox === undefined ? {} : { sandboxPolicy: config.sandbox }),
    recorderFactory: ({ runId, conversationId, userInput, source, sourceDetail, isolated }) =>
      composeRunRecorder(recorderCompositionDeps(config, options, internalHooks), {
        runId,
        conversationId,
        runKind: "channel",
        ...(isolated === undefined ? {} : { isolated }),
        ...(userInput === undefined ? {} : { userInput }),
        ...(source === undefined ? {} : { source }),
        ...(sourceDetail === undefined ? {} : { sourceDetail }),
      }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function configuredMemoryForHarness(
  config: MonoAgentConfig,
  memory: MemoryStore | undefined,
): MemoryStore | undefined {
  if (memory instanceof MemoryRetrievalService || config.memory === undefined || !isSharedRecallStore(memory)) {
    return memory;
  }
  return new MemoryRetrievalService(memory, {
    maxBytes: config.memory.maxBytes,
    source: (config.memory.backend ?? "bujo") === "supermemory" ? "supermemory" : "memory-bujo",
  });
}

export async function createConfiguredAgentResponder(options: ConfiguredAgentResponderOptions): Promise<AgentResponder> {
  return await createConfiguredAgentResponderInternal(options);
}

/**
 * @internal Application-composition seam. This is deliberately absent from the
 * package root so cache bookkeeping does not enlarge the supported harness API.
 */
export async function createConfiguredAgentResponderForApp(
  options: ConfiguredAgentResponderOptions,
  internalHooks: ConfiguredAgentInternalHooks,
): Promise<AgentResponder> {
  return await createConfiguredAgentResponderInternal(options, internalHooks);
}

async function createConfiguredAgentResponderInternal(
  options: ConfiguredAgentResponderOptions,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<AgentResponder> {
  const session = options.config.runtime.session;
  return createAgentResponder({
    harness: await createConfiguredAgentHarnessInternal(options, internalHooks),
    ...(session.rollover === undefined ? {} : { rollover: session.rollover }),
    ...(session.rolloverTimezone === undefined ? {} : { rolloverTimezone: session.rolloverTimezone }),
    ...(session.rolloverNotice === undefined ? {} : { rolloverNotice: session.rolloverNotice }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }) as AgentResponder;
}

/** @internal Shared only with app-local history decorators; absent from the package root. */
export const DEFAULT_HISTORY_MAX_MESSAGES = 64;

function hasConfiguredFallback(config: MonoAgentConfig): boolean {
  return (config.runtime.fallbacks?.length ?? 0) > 0
    || (config.runtime.fallbackModels?.length ?? 0) > 0;
}

function supportsSessionResume(model: RuntimeModelReference, executionMode: string): boolean {
  try {
    return monoRuntimeSupportsSessionResume(model, executionMode as RuntimeExecutionMode);
  } catch {
    return false;
  }
}

// Bound embeddings calls so a slow/cold backend cannot stall a turn for the
// provider default (30s). The harness degrades recall to empty on timeout.
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 10_000;

export async function createConfiguredMemory(
  config: MonoAgentConfig,
  deps: {
    /** Agent config folder used to resolve explicitly installed optional plugins. */
    cwd?: string;
    /** Managed workers must use the plugin frozen into their app-side runtime closure. */
    preferAppPluginInstall?: boolean;
    logger?: { warn(message: string): void };
    /**
     * Injection seam for the bujo memory LLM's runtime (tests). This runtime MUST
     * NOT carry the channel runtime's fallback chain: the agent-runtime fallback
     * router overrides each run's per-call `model` with the chain's primary entry,
     * so a memory LLM riding the channel runtime would silently execute on
     * `config.runtime.model` instead of `config.memory.llm.model`. When omitted the
     * memory LLM builds its OWN fallback-free runtime from
     * `runtimeHostOptionsForConfig(config)` (preserving the pi auth resolver) so the
     * per-call `config.memory.llm.model` is the sole, effective primary.
     */
    memoryRuntime?: MonoRuntimeLike;
    /**
     * When supplied, the bujo memory LLM records each `complete()` as a run via
     * the same JSONL + Phoenix pipeline as channel runs (subject to the
     * `memory.llm.trace` toggle). Omitted → memory LLM runs unrecorded.
     */
    observability?: Pick<
      ConfiguredAgentHarnessOptions,
      "observabilityContext" | "exporterWarn" | "exporterFactory"
    >;
  } = {},
): Promise<MemoryStore | undefined> {
  if (config.memory === undefined) {
    return undefined;
  }
  const backend = config.memory.backend ?? "bujo";
  if (backend === "supermemory") {
    const sm = config.memory.supermemory;
    if (sm === undefined) {
      // Defensive: the loader already rejects this combination.
      throw new Error("memory.backend 'supermemory' requires a memory.supermemory block.");
    }
    const { createSupermemoryStore } = await loadSupermemoryPlugin({
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      ...(deps.preferAppPluginInstall === undefined
        ? {}
        : { preferAppInstall: deps.preferAppPluginInstall }),
    });
    // External backend: `mode`/`embeddings`/`llm` are bujo-only and intentionally ignored. Recall +
    // capture both go over the REST client; Supermemory extracts/consolidates server-side.
    return createSupermemoryStore({
      baseUrl: sm.baseUrl,
      container: resolveSupermemoryContainer(config),
      ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
      ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
      ...(config.memory.maxBytes === undefined ? {} : { maxBytes: config.memory.maxBytes }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
  }
  const { mode, path: root, maxBytes, embeddings: embeddingsConfig, llm: llmConfig } = config.memory;
  const bujo = await loadMemoryBujoModule();

  if (mode === "lite") {
    if (embeddingsConfig !== undefined || llmConfig !== undefined || config.memory.consolidation !== undefined) {
      throw new Error("memory.mode 'lite' is lexical-only and rejects embeddings, memory.llm, and consolidation.");
    }
    // Lite tier: FTS-only recall, no external deps.
    return bujo.createBujoMemoryStore({
      root,
      tier: "lite",
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // journal and bujo tiers both need embeddings for hybrid recall. A bounded
  // timeout keeps a slow backend (e.g. Ollama loading the model) from stalling
  // the request, and the circuit breaker fast-fails after repeated failures so
  // a sustained outage stops blocking recall entirely. The harness degrades
  // recall to empty (with a memory_degraded warning) when this errors.
  const search = await loadMemorySearchModule();
  if (embeddingsConfig?.apiKeyEnv !== undefined && embeddingsConfig.apiKey === undefined) {
    throw new Error(
      `memory.embeddings.apiKeyEnv ${embeddingsConfig.apiKeyEnv} is declared but has no resolved value; ` +
      `set ${embeddingsConfig.apiKeyEnv} before starting managed memory.`,
    );
  }
  const embeddings = search.createCircuitBreakerEmbeddingProvider(
    search.createEmbeddingProvider({
      provider: embeddingsConfig?.provider ?? "ollama",
      model: embeddingsConfig?.model ?? "nomic-embed-text:v1.5",
      ...(embeddingsConfig?.endpoint !== undefined && { endpoint: embeddingsConfig.endpoint }),
      ...(embeddingsConfig?.apiKey !== undefined && { apiKey: embeddingsConfig.apiKey }),
      timeoutMs: embeddingsConfig?.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS,
    }),
    {
      ...(embeddingsConfig?.circuitBreaker?.failureThreshold !== undefined && {
        failureThreshold: embeddingsConfig.circuitBreaker.failureThreshold,
      }),
      ...(embeddingsConfig?.circuitBreaker?.cooldownMs !== undefined && {
        cooldownMs: embeddingsConfig.circuitBreaker.cooldownMs,
      }),
    },
  );
  const dim = embeddingsConfig?.dim ?? 768;

  if (mode === "journal") {
    if (embeddingsConfig === undefined) {
      throw new Error("memory.mode 'journal' requires memory.embeddings; configuration must not downshift tiers.");
    }
    if (llmConfig !== undefined || config.memory.consolidation !== undefined) {
      throw new Error("memory.mode 'journal' rejects memory.llm and consolidation; select bujo for curated capture.");
    }
    // Journal tier: hybrid recall + static, non-decaying salience; no chat LLM.
    return bujo.createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings,
      dim,
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // BuJo is a strict full-stack tier. The config loader enforces both
  // prerequisites; keep the composition boundary defensive for programmatic
  // callers that may construct MonoAgentConfig directly.
  if (embeddingsConfig === undefined || llmConfig === undefined) {
    throw new Error("memory.mode 'bujo' requires memory.embeddings and memory.llm; configuration must not downshift tiers.");
  }
  const recording =
    deps.observability === undefined
      ? undefined
      : recorderCompositionDeps(config, deps.observability);
  const llm = configuredMemoryLlm(bujo, config, llmConfig, deps.memoryRuntime, recording);
  if (llm === undefined) {
    throw new Error("memory.mode 'bujo' could not construct the required memory.llm.");
  }
  return bujo.createBujoMemoryStore({
    root,
    tier: "bujo",
    embeddings,
    dim,
    ...(maxBytes !== undefined && { maxBytes }),
    llm,
    ...(deps.logger !== undefined && { logger: deps.logger }),
  });
}

function runtimeHostOptionsForConfig(config: MonoAgentConfig): Parameters<typeof createMonoRuntime>[0] {
  return {
    workspace: config.runtime.workspace,
    qaOutputDir: config.artifacts.dir,
    ...(config.providers?.piAuthPath === undefined
      ? {}
      : { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: config.providers.piAuthPath }) }),
  };
}

function configuredMemoryLlm(
  bujo: MemoryBujoModule,
  config: MonoAgentConfig,
  llmConfig: NonNullable<MonoAgentConfig["memory"]>["llm"],
  // Explicit memory-LLM runtime (tests). MUST be fallback-chain-free — see the
  // `memoryRuntime` doc on createConfiguredMemory. When undefined the memory LLM
  // builds its own fallback-free runtime so the per-call memory model is primary.
  memoryRuntimeOverride: MonoRuntimeLike | undefined,
  recording: RecorderCompositionDeps | undefined,
): LlmComplete | undefined {
  if (llmConfig === undefined) {
    return undefined;
  }
  if (llmConfig.provider === "ollama") {
    // The ollama memory LLM does not ride `runtime.run`, so it is not recorded.
    return bujo.createOllamaLlm({
      model: llmConfig.model,
      ...(llmConfig.endpoint !== undefined && { endpoint: llmConfig.endpoint }),
    });
  }
  const model = parseMonoRuntimeModelReference(llmConfig.model);
  const executionMode = llmConfig.executionMode ?? defaultExecutionModeForModel(model);
  assertExecutionModeCompatible(model, executionMode);
  if (executionMode !== "sdk") {
    throw new Error("memory.llm provider agent-host supports SDK execution mode only.");
  }
  // NOTE: createMonoRuntime is called WITHOUT a fallbackChain here on purpose, so
  // the per-call `model: config.memory.llm.model` is the sole/primary model. The
  // channel runtime (which carries the fallback chain whose primary is
  // `config.runtime.model`) is intentionally NOT reused — see the `memoryRuntime`
  // doc on createConfiguredMemory.
  const runtime = memoryRuntimeOverride ?? createMonoRuntime(runtimeHostOptionsForConfig(config));
  return createAgentHostMemoryLlm({
    runtime,
    model,
    executionMode,
    cwd: config.runtime.workspace,
    runtimeOptions: mergeStaticRuntimeOptions(
      runtimeOptionsForLocalProvider(model, config.providers?.local),
      configRuntimeFlags(config),
    ),
    // Per-call timeout; default 60s. Configurable so a slow local model can be
    // given room on the heavier reconcile/entities steps.
    ...(llmConfig.timeoutMs === undefined ? {} : { timeoutMs: llmConfig.timeoutMs }),
    // `memory.llm.trace` (default on) gates recording; it only takes effect when
    // the app threaded observability deps into createConfiguredMemory.
    ...(recording !== undefined && llmConfig.trace !== false
      ? { recording: { deps: recording, baseConversationId: MEMORY_CONVERSATION_ID } }
      : {}),
  });
}

const MEMORY_LLM_SYSTEM_PROMPT = [
  "You are the private memory maintenance LLM for mono-agent.",
  "Return only the requested JSON or plain text.",
  "Do not use tools, inspect files, or perform external actions.",
].join(" ");

/** Fallback conversation id for recorded memory LLM runs that carry no ritual label. */
const MEMORY_CONVERSATION_ID = "memory:bujo";

function createAgentHostMemoryLlm(options: {
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly executionMode: RuntimeExecutionMode;
  readonly cwd: string;
  readonly runtimeOptions?: StaticRuntimeOptions;
  readonly timeoutMs?: number;
  /**
   * When set, each `complete()` is recorded as one run through the shared
   * JSONL + Phoenix pipeline. The per-call `label` (e.g. "capture:extract")
   * selects the run's conversation id and id slug. Omitted → bare, unrecorded run.
   */
  readonly recording?: {
    readonly deps: RecorderCompositionDeps;
    readonly baseConversationId?: string;
  };
}): LlmComplete {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: `agent-host:${referenceOf(options.model)}`,
    async complete(prompt: string, opts?: { readonly label?: string; readonly abortSignal?: AbortSignal }): Promise<string> {
      const ctrl = new AbortController();
      const abort = (): void => ctrl.abort(opts?.abortSignal?.reason);
      if (opts?.abortSignal?.aborted === true) abort();
      else opts?.abortSignal?.addEventListener("abort", abort, { once: true });
      // Track whether OUR timeout fired vs an external abort. A provider that is slow or
      // misconfigured (e.g. a dead OAuth token whose refresh hangs) trips this timeout and the
      // runtime reports `cancelled` — without this flag the failure is mislabeled as a generic
      // "run was cancelled", which is exactly what made a 10-day memory outage hard to diagnose.
      let timedOut = false;
      const timer = setTimeout(() => {
        if (ctrl.signal.aborted) return;
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      const memoryOperation = memoryOperationFromLabel(opts?.label);
      const recorder =
        options.recording === undefined
          ? undefined
          : composeRunRecorder(options.recording.deps, {
              runId: createMemoryRunId(opts?.label),
              conversationId: memoryConversationId(options.recording.baseConversationId, opts?.label),
              userInput: prompt,
              systemPrompt: MEMORY_LLM_SYSTEM_PROMPT,
              runKind: "memory",
              source: "memory",
              ...(memoryOperation === undefined ? {} : { memoryOperation }),
              ...(memoryOperation === undefined ? {} : { sourceDetail: memoryOperation }),
            });
      try {
        await safeRecorderCall(() => recorder?.start?.());
        let result: RuntimeResult;
        try {
          result = await options.runtime.run(MEMORY_LLM_SYSTEM_PROMPT, {
            ...options.runtimeOptions,
            model: options.model,
            messages: [{ role: "user", content: prompt }],
            abortSignal: ctrl.signal,
            executionMode: options.executionMode,
            cwd: options.cwd,
            maxTurns: 1,
            allowedTools: [],
            disallowedTools: [],
            mcpServers: {},
            ...(recorder === undefined ? {} : { onEvent: (event) => { recorder.onEvent(event); } }),
          } satisfies RuntimeRunOptions);
        } catch (error) {
          // `runtime.run` itself threw (e.g. the abort/timeout above) — record the
          // failure, then surface a timeout distinctly from an external abort.
          await safeRecorderCall(() => recorder?.fail(error));
          if (timedOut) {
            throw new Error(`agent-host memory LLM timed out after ${timeoutMs}ms (provider too slow or unavailable).`);
          }
          throw error;
        }
        // Record with the real outcome BEFORE textFromMemoryRuntimeResult, which throws
        // on failureKind/error; recorder.finish() classifies failed/succeeded/cancelled itself.
        await safeRecorderCall(() => recorder?.finish(result));
        return textFromMemoryRuntimeResult(result, { timedOut, timeoutMs });
      } finally {
        clearTimeout(timer);
        opts?.abortSignal?.removeEventListener("abort", abort);
      }
    },
  };
}

/**
 * Run a recorder lifecycle call best-effort. Recording is additive: a recorder
 * or artifact-write failure must never mask the memory LLM's real result or error.
 */
async function safeRecorderCall(fn: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // Swallow: recording failures are non-fatal by design.
  }
}

/** Build a `mem-`-prefixed run id (distinct from channel `run-` ids) with the ritual slug. */
function createMemoryRunId(label: string | undefined): string {
  return `mem-${memorySlug(label)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Conversation id for a recorded memory run: `memory:<label>` (per-ritual), else the base. */
function memoryConversationId(base: string | undefined, label: string | undefined): string {
  if (label !== undefined && label.length > 0) {
    return `memory:${label}`;
  }
  return base ?? MEMORY_CONVERSATION_ID;
}

function memorySlug(label: string | undefined): string {
  const slug = (label ?? "bujo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "bujo";
}

/**
 * Memory sub-operation for the `mono.agent.memory.operation` trace attribute.
 * The capture ritual labels are `capture:extract` / `capture:reconcile-batch`
 * (take the part after the colon) and the bare `reflect` / `migrate` (verbatim).
 */
function memoryOperationFromLabel(label: string | undefined): string | undefined {
  if (label === undefined || label.length === 0) {
    return undefined;
  }
  const op = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  return op.length > 0 ? op : undefined;
}

function textFromMemoryRuntimeResult(
  result: RuntimeResult,
  opts?: { readonly timedOut?: boolean; readonly timeoutMs?: number },
): string {
  if (result.cancelled === true) {
    if (opts?.timedOut === true) {
      throw new Error(`agent-host memory LLM timed out after ${opts.timeoutMs ?? "?"}ms (provider too slow or unavailable).`);
    }
    throw new Error("agent-host memory LLM run was cancelled.");
  }
  if (typeof result.failureKind === "string" && result.failureKind.length > 0) {
    throw new Error(`agent-host memory LLM failed (${result.failureKind}): ${result.error ?? "unknown error"}`);
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`agent-host memory LLM failed: ${result.error}`);
  }
  return typeof result.text === "string" ? result.text : "";
}

function referenceOf(model: RuntimeModelReference): string {
  return modelReferenceKey(model);
}

function mergeStaticRuntimeOptions(
  ...optionsList: readonly (StaticRuntimeOptions | undefined)[]
): StaticRuntimeOptions {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolPolicyInput(config: MonoAgentConfig): ToolPolicyInput {
  if (config.tools.mcpConfigPath === undefined) {
    return {
      allowedTools: config.tools.allowedTools,
      disallowedTools: config.tools.disallowedTools,
    };
  }
  // SDK runtimes only consume inline mcpServers, so the referenced mcp.json is
  // resolved here; the path is still forwarded for CLI runtimes that take it.
  const filePolicy = loadToolPolicyFromJsonFileSync(config.tools.mcpConfigPath);
  return {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    mcpConfigPath: config.tools.mcpConfigPath,
    ...(filePolicy.mcpServers === undefined ? {} : { mcpServers: filePolicy.mcpServers }),
  };
}

function configRuntimeFlags(config: MonoAgentConfig): StaticRuntimeOptions | undefined {
  const { permissionMode, compaction } = config.runtime;
  // NOTE: there is intentionally no reasoning-summary runtime option. The sole pi
  // runtime (pi-native) derives reasoning from `effort` and does not consume an
  // explicit summary level, and the codex/claude CLIs emit summaries
  // unconditionally — so the former `piReasoningSummary` runtime option was dead
  // plumbing and the `runtime.reasoningSummary` config field was removed.
  const piNative = config.providers?.piNative;
  // MCP call timeouts ride the runtime's `settings` bag (the same channel the
  // agent loop reads via resolveAgentCompactionPolicy) — only when configured, so
  // the runtime defaults (120s inactivity / 45 min total) stay authoritative.
  const { mcpCallTimeoutMs, mcpCallMaxTotalTimeoutMs } = config.tools;
  const settings = mcpCallTimeoutMs === undefined && mcpCallMaxTotalTimeoutMs === undefined
    ? undefined
    : {
        ...(mcpCallTimeoutMs === undefined ? {} : { agent_mcp_call_timeout_ms: mcpCallTimeoutMs }),
        ...(mcpCallMaxTotalTimeoutMs === undefined
          ? {}
          : { agent_mcp_call_max_total_timeout_ms: mcpCallMaxTotalTimeoutMs }),
      };
  if (
    permissionMode === undefined
    && piNative?.transport === undefined
    && piNative?.piMaxRetries === undefined
    && piNative?.maxRetryDelayMs === undefined
    && compaction === undefined
    && settings === undefined
  ) {
    return undefined;
  }
  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(piNative?.transport === undefined ? {} : { piTransport: piNative.transport }),
    ...(piNative?.piMaxRetries === undefined ? {} : { piMaxRetries: piNative.piMaxRetries }),
    ...(piNative?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: piNative.maxRetryDelayMs }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(settings === undefined ? {} : { settings }),
  };
}

function isRuntimeOptions(value: MonoAgentConfig | ConfiguredAgentRuntimeOptions): value is ConfiguredAgentRuntimeOptions {
  return "config" in value;
}

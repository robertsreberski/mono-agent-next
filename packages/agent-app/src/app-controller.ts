// Internal host implementation; `app.ts` remains the stable public facade.
import { resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { TraceSourceHandle, TraceSourceMemoryHealth } from "@mono-agent/observability";
import type { MonoRuntimeLike, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import { createSrtSandboxEngine } from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import type { AppTraceDefaults, ResolvedExporter } from "./app-config.js";
import type { createConfiguredMemory } from "./configured-agent.js";
import type { ConfiguredAgentSessionEvent } from "./configured-agent.js";
import { resolveChannelDrivers } from "./channels.js";
import type {
  ChannelDriver,
  ChannelId,
  ChannelStatus,
  MonoAgentAppLogger,
  RunningChannel,
} from "./channels.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import type { InteractionBridgeHandle } from "./interaction-bridge.js";
import type { ContinuationServiceHandle } from "./continuation-service.js";
import type {
  ContinuationHealthSnapshot,
  ContinuationHistoryRecordResult,
  ContinuationNativeDeliveryResult,
  ContinuationStatusSnapshot,
  ContinuationSynthesisInput,
} from "./continuations.js";
import type { RunningRituals } from "./memory-rituals.js";
import type { RunningArtifactRetentionScheduler } from "./artifact-retention.js";
import type { MemoryRetrievalService } from "./memory-retrieval.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import type { NotifyDestination } from "./notify-destinations.js";
import { createSeenNotifyDestinationCache } from "./seen-conversations.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import type { ManagedRuntimeLaunchVerification } from "./background-runtime.js";
import { sandboxStatusFromState } from "./app-controller-utils.js";
import * as lifecycleOperations from "./app-controller-lifecycle.js";
import * as traceabilityOperations from "./app-controller-traceability.js";
import * as memory_healthOperations from "./app-controller-memory-health.js";
import * as continuationOperations from "./app-controller-continuation.js";
import * as maintenanceOperations from "./app-controller-maintenance.js";
import * as channelsOperations from "./app-controller-channels.js";
import * as responderOperations from "./app-controller-responder.js";
import * as memoryOperations from "./app-controller-memory.js";
import type {
  ConfigApplyResult,
  ExporterStatus,
  SandboxStatus,
  SessionTraceMetadata,
  TraceabilityStatus,
} from "./app-controller-types.js";

export type {
  ConfigApplyResult,
  ExporterStatus,
  SandboxStatus,
  TraceabilityStatus,
} from "./app-controller-types.js";

/**
 * Outcome of a live config re-apply (`applyConfigChange`). Consumed by callers
 * that trigger a reload and by demos that surface the result.
 */
export interface MonoAgentAppOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  /** Path to mono-agent.config.json; defaults to <cwd>/mono-agent.config.json. */
  readonly configPath?: string;
  /**
   * Optional immutable read source for managed workers. The public app and
   * trace metadata continue to identify `configPath`; every runtime/channel
   * config loader reads this path instead.
   */
  readonly configReadPath?: string;
  readonly logger?: MonoAgentAppLogger;
  /** Channel drivers to run. Defaults to every built-in channel. */
  readonly drivers?: readonly ChannelDriver[];
  /** Shared runtime override (testing / advanced composition). */
  readonly runtime?: MonoRuntimeLike;
  /** Sandbox engine override (testing / advanced composition). */
  readonly sandboxEngine?: SandboxEngine;
  readonly traceDefaults?: AppTraceDefaults;
  /** Secret-free proof of the durable files/environment observed by this worker. */
  readonly backgroundSnapshot?: BackgroundSnapshot;
}

/**
 * Best-effort observability exporter status. `configured` does not assert
 * reachability (Phoenix may start later — only `validate` probes); export
 * failures during runs surface as `lastWarning`/`lastError` without changing the
 * run outcome.
 */
export interface MonoAgentApp {
  readonly configPath: string;
  readonly traceabilityStatus: TraceabilityStatus;
  readonly exporterStatus: ExporterStatus;
  readonly sandboxStatus: SandboxStatus;
  readonly memoryHealth?: TraceSourceMemoryHealth;
  readonly selectedSkills: readonly string[] | undefined;
  channelStatus(id: ChannelId): ChannelStatus;
  channelStatuses(): ReadonlyMap<ChannelId, ChannelStatus>;
  continuationHealth?(): Promise<ContinuationHealthSnapshot | undefined>;
  listContinuations?(): Promise<readonly ContinuationStatusSnapshot[]>;
  capturedContinuationText?(id: string): Promise<string | undefined>;
  retryContinuation?(id: string, options?: { readonly allowUnknown?: boolean }): Promise<ContinuationStatusSnapshot>;
  cancelContinuation?(id: string): Promise<ContinuationStatusSnapshot>;
  resolveContinuationDelivery?(
    id: string,
    outcome: { readonly kind: "delivered"; readonly deliveryId?: string } | { readonly kind: "not_delivered" } | { readonly kind: "dead_lettered" },
  ): Promise<ContinuationStatusSnapshot>;
  startChannelIfConfigured(id: ChannelId, reason: string): Promise<ChannelStatus>;
  applyConfigChange(reason: string): Promise<ConfigApplyResult>;
  stop(): Promise<void>;
}

/**
 * Starts a config-first mono-agent host in `cwd`: traceability first, then every
 * configured channel in parallel. Channels with incomplete config report
 * `waiting_for_config` instead of blocking the rest. The host runs headless;
 * config changes take effect on the next restart.
 */
export async function startMonoAgentApp(options: MonoAgentAppOptions = {}): Promise<MonoAgentApp> {
  return await startMonoAgentAppInternal(options, []);
}

/** Internal managed-worker entrypoint; deliberately not re-exported by app.ts. */
export async function startVerifiedManagedMonoAgentApp(
  options: MonoAgentAppOptions,
  verification: ManagedRuntimeLaunchVerification,
): Promise<MonoAgentApp> {
  return await startMonoAgentAppInternal(options, [verification.installRoot]);
}

async function startMonoAgentAppInternal(
  options: MonoAgentAppOptions,
  trustedRuntimeReadRoots: readonly string[],
): Promise<MonoAgentApp> {
  const startupStartedAt = performance.now();
  const startupPhases: Record<string, number> = {};
  const measure = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      startupPhases[phase] = roundedMilliseconds(performance.now() - startedAt);
    }
  };
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? "mono-agent.config.json");
  const configReadPath = resolve(cwd, options.configReadPath ?? configPath);
  const env = options.env ?? process.env;
  const drivers = options.drivers ?? await measure(
    "driverResolution",
    () => resolveChannelDrivers({ env, cwd, configPath: configReadPath }),
  );
  if (options.drivers !== undefined) startupPhases.driverResolution = 0;

  const controller = new MonoAgentAppController({
    cwd,
    configPath,
    configReadPath,
    env,
    drivers,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.sandboxEngine === undefined ? {} : { sandboxEngine: options.sandboxEngine }),
    ...(options.traceDefaults === undefined ? {} : { traceDefaults: options.traceDefaults }),
    ...(options.backgroundSnapshot === undefined ? {} : { backgroundSnapshot: options.backgroundSnapshot }),
    trustedRuntimeReadRoots,
  });

  await measure("sandbox", () => controller.refreshSandboxStatus("startup"));
  await measure("traceability", () => controller.startTraceability("startup"));
  await measure("services", async () => {
    await controller.startExporters("startup");
    await controller.startContinuationServiceIfConfigured("startup");
  });
  await measure(
    "channels",
    () => Promise.all(drivers.map((driver) => controller.startChannelIfConfigured(driver.id, "startup"))),
  );
  await measure("memoryRituals", () => controller.startMemoryRitualsIfConfigured("startup"));
  const memoryHealthStartedAt = performance.now();
  await controller.refreshMemoryHealthAfterLifecycle("startup-complete", () => {
    startupPhases.memoryHealth = roundedMilliseconds(performance.now() - memoryHealthStartedAt);
    controller.startupTimingValue = {
      durationMs: roundedMilliseconds(performance.now() - startupStartedAt),
      phases: { ...startupPhases },
    };
  });
  return controller;
}

function roundedMilliseconds(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

interface MonoAgentAppControllerInput {
  readonly cwd: string;
  readonly configPath: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly drivers: readonly ChannelDriver[];
  readonly logger?: MonoAgentAppLogger;
  readonly runtime?: MonoRuntimeLike;
  readonly sandboxEngine?: SandboxEngine;
  readonly traceDefaults?: AppTraceDefaults;
  readonly backgroundSnapshot?: BackgroundSnapshot;
  readonly trustedRuntimeReadRoots: readonly string[];
}

const DEFAULT_SANDBOX_STATUS: SandboxStatus = sandboxStatusFromState({
  configured: false,
  configuredMode: undefined,
  effective: "off",
  engine: undefined,
  engineAvailable: undefined,
  fallback: undefined,
  fallbackActive: false,
  unsafeAllowHostProcess: false,
});

/** Strict memory audits scan durable state; never run them at sub-second trace-heartbeat cadence. */
const MIN_MEMORY_HEALTH_REFRESH_INTERVAL_MS = 30_000;

export class MonoAgentAppController implements MonoAgentApp {
  readonly configPath: string;
  readonly cwd: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly drivers: readonly ChannelDriver[];
  readonly driversById: ReadonlyMap<ChannelId, ChannelDriver>;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly runtime: MonoRuntimeLike | undefined;
  readonly sandboxEngine: SandboxEngine | undefined;
  readonly traceDefaults: AppTraceDefaults | undefined;
  readonly backgroundSnapshot: BackgroundSnapshot | undefined;
  readonly trustedRuntimeReadRoots: readonly string[];
  private trustedSrtSandboxEngine: SandboxEngine | undefined;
  readonly activeRuntimes: MonoRuntimeLike[] = [];
  readonly statuses = new Map<ChannelId, ChannelStatus>();
  readonly running = new Map<ChannelId, RunningChannel>();
  readonly startsInFlight = new Map<ChannelId, Promise<ChannelStatus>>();
  /** Captured at construction (~process start): the cutoff for reclaiming orphaned "running" runs. */
  readonly processStartMs = Date.now();
  staleRunsReconciled = false;
  traceabilityStatusValue: TraceabilityStatus = {
    kind: "disabled",
    reason: "Traceability has not started yet.",
  };
  exporterStatusValue: ExporterStatus = {
    kind: "disabled",
    reason: "No observability exporter configured.",
  };
  sandboxStatusValue: SandboxStatus = DEFAULT_SANDBOX_STATUS;
  memoryHealthValue: TraceSourceMemoryHealth = {
    backend: "none",
    status: "unknown",
    checkedAt: new Date().toISOString(),
  };
  memoryHealthRefreshInFlight: Promise<TraceSourceMemoryHealth> | undefined;
  memoryHealthRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  memoryHealthRefreshLoopActive = false;
  memoryHealthRefreshIntervalMs = MIN_MEMORY_HEALTH_REFRESH_INTERVAL_MS;
  /** Monotonic completion time for the current generation's cached full audit. */
  memoryHealthLastCompletedAtMs: number | undefined;
  /** One bounded forced refresh reserved by a due timer tick. */
  memoryHealthRefreshDue = false;
  memoryHealthGeneration = 0;
  /** Durable trace fact published only after the full current lifecycle completes. */
  startupCompleted = false;
  startupTimingValue: {
    readonly durationMs: number;
    readonly phases: Readonly<Record<string, number>>;
  } | undefined;
  selectedSkillsValue: readonly string[] | undefined;
  sessionMetadataValue: SessionTraceMetadata | undefined;
  /** The exporter the responder threads into agent-host (first configured exporter). */
  resolvedExporter: ResolvedExporter | undefined;
  traceSource: TraceSourceHandle | undefined;
  /**
   * Whole-publication single flight. A slow health probe must not let periodic
   * heartbeat ticks build an unbounded promise tail behind it.
   */
  traceRefreshInFlight: Promise<void> | undefined;
  traceRefreshDirty = false;
  traceRefreshLatestReason: string | undefined;
  // Best-effort mirror of `traceSource` into the machine-wide global registry,
  // present only when `shouldMirrorTraceSourceGlobally` gates it on (see
  // `startTraceability`). Kept in lockstep with `traceSource` on every
  // refresh/stop so both manifests describe the same instance identically.
  globalTraceSource: TraceSourceHandle | undefined;
  artifactRetentionScheduler: RunningArtifactRetentionScheduler | undefined;
  artifactRetentionGeneration = 0;
  memoryRituals: RunningRituals | undefined;
  // One shared memory store across all channel responders + the ritual scheduler, so there is a single
  // memory.db handle (not one per channel plus one for rituals). Rebuilt on config reload, closed on stop.
  sharedMemory: Awaited<ReturnType<typeof createConfiguredMemory>> = undefined;
  sharedMemoryRetrieval: MemoryRetrievalService | undefined;
  sharedMemoryBuilt = false;
  sharedMemoryBuild: Promise<Awaited<ReturnType<typeof createConfiguredMemory>>> | undefined;
  configApplyTail: Promise<void> = Promise.resolve();
  stopped = false;
  // Interaction bridge (AskUser + tool progress): lazily started once and shared
  // by every channel. Its master bearer stays app-owned and is never exported
  // through the generic host/process environment.
  interactionBridge: InteractionBridgeHandle | undefined;
  interactionBridgeStart: Promise<InteractionBridgeHandle | undefined> | undefined;
  continuationService: ContinuationServiceHandle | undefined;
  continuationServiceStart: Promise<ContinuationServiceHandle | undefined> | undefined;
  /** One bounded scan cache for artifact-derived native-notify destinations. */
  readonly seenNotifyDestinations = createSeenNotifyDestinationCache();

  constructor(input: MonoAgentAppControllerInput) {
    this.cwd = input.cwd;
    this.configPath = input.configPath;
    this.configReadPath = input.configReadPath;
    this.env = input.env;
    this.drivers = input.drivers;
    this.driversById = new Map(input.drivers.map((driver) => [driver.id, driver]));
    this.logger = input.logger;
    this.runtime = input.runtime;
    this.sandboxEngine = input.sandboxEngine;
    this.traceDefaults = input.traceDefaults;
    this.backgroundSnapshot = input.backgroundSnapshot;
    this.trustedRuntimeReadRoots = [...input.trustedRuntimeReadRoots];
    for (const driver of input.drivers) {
      this.statuses.set(driver.id, {
        kind: "waiting_for_config",
        reason: `${driver.label} has not been configured yet.`,
      });
    }
  }

  get traceabilityStatus(): TraceabilityStatus {
    return this.traceabilityStatusValue;
  }

  get exporterStatus(): ExporterStatus {
    return this.exporterStatusValue;
  }

  get sandboxStatus(): SandboxStatus {
    return this.sandboxStatusValue;
  }

  get memoryHealth(): TraceSourceMemoryHealth {
    return this.memoryHealthValue;
  }

  get selectedSkills(): readonly string[] | undefined {
    return this.selectedSkillsValue;
  }

  sandboxEngineFor(coreConfig: MonoAgentConfig): SandboxEngine | undefined {
    if (this.sandboxEngine !== undefined) return this.sandboxEngine;
    if (this.trustedRuntimeReadRoots.length === 0 || coreConfig.sandbox?.engine !== "srt") return undefined;
    this.trustedSrtSandboxEngine ??= createSrtSandboxEngine({
      trustedReadRoots: this.trustedRuntimeReadRoots,
    });
    return this.trustedSrtSandboxEngine;
  }

  channelStatus(id: ChannelId): ChannelStatus {
    const status = this.statuses.get(id);
    if (status === undefined) {
      return { kind: "disabled", reason: `Channel ${id} is not registered with this app.` };
    }
    return status;
  }

  channelStatuses(): ReadonlyMap<ChannelId, ChannelStatus> {
    return new Map(this.statuses);
  }

  async continuationHealth(): Promise<ContinuationHealthSnapshot | undefined> {
    return await this.continuationService?.health();
  }

  async listContinuations(): Promise<readonly ContinuationStatusSnapshot[]> {
    return await this.continuationService?.list() ?? [];
  }

  async capturedContinuationText(id: string): Promise<string | undefined> {
    return await this.requireContinuationService().capturedText(id);
  }

  async retryContinuation(
    id: string,
    options?: { readonly allowUnknown?: boolean },
  ): Promise<ContinuationStatusSnapshot> {
    return await this.requireContinuationService().retry(id, options);
  }

  async cancelContinuation(id: string): Promise<ContinuationStatusSnapshot> {
    return await this.requireContinuationService().cancel(id);
  }

  async resolveContinuationDelivery(
    id: string,
    outcome: { readonly kind: "delivered"; readonly deliveryId?: string } | { readonly kind: "not_delivered" } | { readonly kind: "dead_lettered" },
  ): Promise<ContinuationStatusSnapshot> {
    return await this.requireContinuationService().resolveUnknown(id, outcome);
  }

  async applyConfigChange(reason: string): Promise<ConfigApplyResult> { return lifecycleOperations.applyConfigChange(this, reason); }

  async startChannelIfConfigured(id: ChannelId, reason: string): Promise<ChannelStatus> { return lifecycleOperations.startChannelIfConfigured(this, id, reason); }

  async startTraceability(reason: string): Promise<TraceabilityStatus> { return traceabilityOperations.startTraceability(this, reason); }

  async refreshSandboxStatus(reason: string): Promise<SandboxStatus> { return traceabilityOperations.refreshSandboxStatus(this, reason); }

  /**
   * One-shot at startup: a process that crashed mid-run leaves its summary stuck at "running"
   * forever (a ghost run in `status`/observability). Reclaim those — any "running" summary that
   * began before THIS process started — by rewriting them to "interrupted". Gated so a config
   * reload (which re-runs startTraceability) does not repeat the scan. Best-effort: never fatal.
   */
  async reconcileStaleRunsOnce(artifactDir: string): Promise<void> { return traceabilityOperations.reconcileStaleRunsOnce(this, artifactDir); }

  /**
   * Resolve the configured observability exporter(s) and publish the export
   * status. No reachability probe runs here — Phoenix may start after the agent,
   * so an unreachable endpoint must not block startup (that probe runs in
   * `validate`). A present-but-invalid exporter config surfaces as `failed`.
   */
  async startExporters(reason: string): Promise<ExporterStatus> { return traceabilityOperations.startExporters(this, reason); }

  /** Record a best-effort export warning so `status` can surface it without failing the run. */
  recordExporterWarning(warning: { phase: string; message: string }): void { return traceabilityOperations.recordExporterWarning(this, warning); }

  refreshTraceSource(reason: string): Promise<void> { return traceabilityOperations.refreshTraceSource(this, reason); }

  /**
   * Refresh the content-free memory snapshot once for all concurrent trace
   * publishers. The cached value is the only memory state read by synchronous
   * manifest composition; provider/native errors collapse to a closed unknown
   * shape and never escape into registry metadata.
   */
  refreshMemoryHealthSnapshot(reason: string, lifecycleForce = false): Promise<TraceSourceMemoryHealth> { return memory_healthOperations.refreshMemoryHealthSnapshot(this, reason, lifecycleForce); }

  async computeMemoryHealth(): Promise<TraceSourceMemoryHealth> { return memory_healthOperations.computeMemoryHealth(this); }

  startMemoryHealthRefreshLoop(intervalMs: number): void { return memory_healthOperations.startMemoryHealthRefreshLoop(this, intervalMs); }

  scheduleMemoryHealthRefresh(delayOverrideMs?: number): void { return memory_healthOperations.scheduleMemoryHealthRefresh(this, delayOverrideMs); }

  recordMemoryHealthCompletion(generation: number): void { return memory_healthOperations.recordMemoryHealthCompletion(this, generation); }

  refreshMemoryHealthOnTimer(): void { return memory_healthOperations.refreshMemoryHealthOnTimer(this); }

  /**
   * Re-audit after channel responders and the shared memory store have started.
   * The trace source is registered first, so its registration audit can only
   * observe the previous/stopped runtime snapshot. This one lifecycle force is
   * generation-fenced and uses the same health/trace single-flights as timer
   * work; ordinary session and trace events continue to reuse the 30s cache.
   */
  async refreshMemoryHealthAfterLifecycle(reason: string, beforePublish?: () => void): Promise<void> {
    return memory_healthOperations.refreshMemoryHealthAfterLifecycle(this, reason, beforePublish);
  }

  clearMemoryHealthRefreshTimer(): void { return memory_healthOperations.clearMemoryHealthRefreshTimer(this); }

  invalidateMemoryHealthRefresh(): void { return memory_healthOperations.invalidateMemoryHealthRefresh(this); }

  /**
   * Start the interaction bridge once, when a blocking ask tool is allowed by
   * the tool policy, a request-context MCP needs scoped progress, or the operator
   * configured the `interaction` block. The master bearer remains app-owned.
   */
  ensureInteractionBridge(coreConfig: MonoAgentConfig): Promise<InteractionBridgeHandle | undefined> { return continuationOperations.ensureInteractionBridge(this, coreConfig); }

  async stopInteractionBridge(): Promise<void> { return continuationOperations.stopInteractionBridge(this); }

  /** Start one durable continuation service shared by all channel responders. */
  ensureContinuationService(coreConfig: MonoAgentConfig): Promise<ContinuationServiceHandle | undefined> { return continuationOperations.ensureContinuationService(this, coreConfig); }

  async startContinuationServiceIfConfigured(reason: string): Promise<void> { return continuationOperations.startContinuationServiceIfConfigured(this, reason); }

  async stopContinuationService(): Promise<void> { return continuationOperations.stopContinuationService(this); }

  requireContinuationService(): ContinuationServiceHandle { return continuationOperations.requireContinuationService(this); }

  async synthesizeContinuation(input: ContinuationSynthesisInput): Promise<{ readonly text: string; readonly actionable?: boolean }> { return continuationOperations.synthesizeContinuation(this, input); }

  continuationSynthesisAvailability(input: ContinuationSynthesisInput):
    | { readonly ready: true }
    | { readonly ready: false; readonly code: string; readonly reason: string; readonly retryAfterMs: number } { return continuationOperations.continuationSynthesisAvailability(this, input); }

  async deliverContinuation(
    conversationId: string,
    text: string,
    deliveryKey: string,
  ): Promise<ContinuationNativeDeliveryResult> { return continuationOperations.deliverContinuation(this, conversationId, text, deliveryKey); }

  async recordContinuationHistory(
    conversationId: string,
    text: string,
    deliveryKey: string,
  ): Promise<ContinuationHistoryRecordResult> { return continuationOperations.recordContinuationHistory(this, conversationId, text, deliveryKey); }

  async stop(): Promise<void> { return lifecycleOperations.stop(this); }

  async startMemoryRitualsIfConfigured(reason: string): Promise<void> { return maintenanceOperations.startMemoryRitualsIfConfigured(this, reason); }

  stopMemoryRituals(): void { return maintenanceOperations.stopMemoryRituals(this); }

  restartArtifactRetentionScheduler(artifactDir: string, reason: string): void { return maintenanceOperations.restartArtifactRetentionScheduler(this, artifactDir, reason); }

  stopArtifactRetentionScheduler(): void { return maintenanceOperations.stopArtifactRetentionScheduler(this); }

  /**
   * Deliver a native cron/webhook notification to whichever running channel owns
   * the destination conversationId. With `verbatim`, the channel posts `text`
   * unchanged (no model call) and records it to history; otherwise it runs `text`
   * as a turn. Best-effort: an unavailable/unsupported destination is warned and
   * skipped, never thrown back to the cron/webhook trigger.
   */
  async notifyDestination(
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean; readonly deliveryKey?: string },
  ): Promise<NotifyDeliveryResult> { return maintenanceOperations.notifyDestination(this, conversationId, text, options); }

  /**
   * Candidate destinations for native cron/webhook notification delivery, used to
   * infer a target when a job/endpoint sets no explicit `notifyConversationId`.
   */
  async listNotifyDestinations(): Promise<readonly NotifyDestination[]> { return maintenanceOperations.listNotifyDestinations(this); }

  async startChannel(driver: ChannelDriver, reason: string): Promise<ChannelStatus> { return channelsOperations.startChannel(this, driver, reason); }

  async stopChannel(id: ChannelId, reason: string): Promise<void> { return channelsOperations.stopChannel(this, id, reason); }

  async buildResponder(coreConfig: MonoAgentConfig): Promise<AgentResponder> { return responderOperations.buildResponder(this, coreConfig); }

  /**
   * Per-request extension that applies a cron/webhook/tui per-trigger model +
   * effort override (validated, warn-and-ignore on bad input). Threads the
   * configured local providers so a LOCAL-model override recomputes its endpoint
   * block for the OVERRIDE model (see request-model-override doc). Composed
   * alongside the memory/adapter extensions.
   */
  requestModelOverrideRuntimeOptions(
    coreConfig: MonoAgentConfig,
    compatibility: { readonly mcpSources: readonly string[]; readonly indexSkillsActive: boolean },
  ): {
    readonly extension: RuntimeOptionsExtension;
    readonly targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean;
  } { return responderOperations.requestModelOverrideRuntimeOptions(this, coreConfig, compatibility); }

  /**
   * Memoized factory for runtimes bound to a per-request override model. Reuses
   * createConfiguredAgentRuntime so the override becomes the fallback-chain
   * primary with the configured backups after it (override + keep fallbacks).
   * Built runtimes register in `activeRuntimes`, which is disposed on `stop()`
   * (config reload rebuilds the responder but does not drain prior runtimes —
   * same lifetime as the base runtime built in `buildResponder`).
   */
  buildRuntimeForModel(
    coreConfig: MonoAgentConfig,
  ): (model: RuntimeModelReference, executionMode?: string) => MonoRuntimeLike { return responderOperations.buildRuntimeForModel(this, coreConfig); }

  /**
   * Run-identifying context threaded onto exported spans (Phoenix shows the same
   * source/run identifiers as the local trace-source registry, so local artifact
   * lookup stays possible). Resolved with the same source-id/label resolvers the
   * trace source uses.
   */
  async observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }> { return traceabilityOperations.observabilityContext(this); }

  reportMemoryRecallStatus(
    coreConfig: MonoAgentConfig,
    service: MemoryRetrievalService | undefined,
  ): boolean { return traceabilityOperations.reportMemoryRecallStatus(this, coreConfig, service); }

  /**
   * Optional CLOUD-ONLY escape hatch: when `memory.supermemory.exposeMcpServer` is on, ALSO inject
   * Supermemory's hosted MCP server alongside the in-app `MemoryRecall` tool. The hosted MCP cannot
   * point at a self-hosted instance, so self-hosters rely on the in-app recall tool; this just adds
   * the cloud server's richer tools for cloud deployments. Requires an apiKey (skipped + warned if
   * absent).
   */
  supermemoryMcpRuntimeOptions(coreConfig: MonoAgentConfig): RuntimeOptionsExtension | undefined { return responderOperations.supermemoryMcpRuntimeOptions(this, coreConfig); }

  async adapterSendToolsRuntimeOptions(coreConfig: MonoAgentConfig): Promise<{
    readonly createExtension?: (
      targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
    ) => RuntimeOptionsExtension;
    readonly blockingToolNames: readonly string[];
  }> { return responderOperations.adapterSendToolsRuntimeOptions(this, coreConfig); }

  /** Build the configured memory store once and share it across responders + the ritual scheduler. */
  async memoryStore(
    coreConfig: MonoAgentConfig,
  ): Promise<Awaited<ReturnType<typeof createConfiguredMemory>>> { return memoryOperations.memoryStore(this, coreConfig); }

  /** Close + clear the shared memory store (on config reload or stop) so the next build is fresh. */
  async resetSharedMemory(): Promise<void> { return memoryOperations.resetSharedMemory(this); }

  /** @internal Test-only seam: seed the shared memory store without going through config. */
  __setSharedMemoryForTest(store: Awaited<ReturnType<typeof createConfiguredMemory>>): void { return memoryOperations.__setSharedMemoryForTest(this, store); }

  ensureSharedMemoryRetrieval(
    coreConfig: MonoAgentConfig,
    store: Awaited<ReturnType<typeof createConfiguredMemory>>,
  ): MemoryRetrievalService | undefined { return memoryOperations.ensureSharedMemoryRetrieval(this, coreConfig, store); }

  setStatus(id: ChannelId, status: ChannelStatus): ChannelStatus { return channelsOperations.setStatus(this, id, status); }

  applyResult(): ConfigApplyResult { return channelsOperations.applyResult(this); }

  async stopTraceSource(reason: string): Promise<void> { return traceabilityOperations.stopTraceSource(this, reason); }

  activeTransports(): readonly string[] { return channelsOperations.activeTransports(this); }

  async refreshSelectedSkillsSnapshot(reason: string): Promise<void> { return traceabilityOperations.refreshSelectedSkillsSnapshot(this, reason); }

  rememberSelectedSkills(coreConfig: MonoAgentConfig): void { return traceabilityOperations.rememberSelectedSkills(this, coreConfig); }

  recordSessionEvent(event: ConfiguredAgentSessionEvent, coreConfig: MonoAgentConfig): void { return traceabilityOperations.recordSessionEvent(this, event, coreConfig); }

  traceMetadata(reason: string): Record<string, unknown> { return traceabilityOperations.traceMetadata(this, reason); }
}

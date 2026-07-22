import type { MonoAgentConfig } from "@mono-agent/config";
import {
  pruneTraceSources,
  reconcileStaleRunArtifacts,
  registerTraceSource,
} from "@mono-agent/observability";
import type { TraceSourceHandle, TraceSourceMemoryHealth } from "@mono-agent/observability";
import { resolveSandboxEffectiveState } from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  loadAppCoreConfig,
  resolveAppArtifactDir,
  resolveAppObservabilityExporters,
  resolveAppTraceGlobalDiscovery,
  resolveAppTraceHeartbeatMs,
  resolveAppTraceRegistryDir,
  resolveAppTraceSourceId,
  resolveAppTraceSourceLabel,
  resolveGlobalTraceRegistryDir,
  resolveTraceTmpdirRoot,
  shouldMirrorTraceSourceGlobally,
} from "./app-config.js";
import type { AppTraceDefaults, MonoAgentAppConfigInput, ResolvedExporter } from "./app-config.js";
import type { ConfiguredAgentSessionEvent } from "./configured-agent.js";
import { resolveMemoryRecallSettings } from "./memory-recall.js";
import type { MemoryRetrievalService } from "./memory-retrieval.js";
import {
  nextDailyRolloverAt,
  reasonOf,
  sandboxStatusFromState,
} from "./app-controller-utils.js";
import type {
  ExporterStatus,
  SandboxStatus,
  SessionTraceMetadata,
  TraceabilityStatus,
} from "./app-controller-types.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import type { ChannelDriver, ChannelId, ChannelStatus, MonoAgentAppLogger } from "./channels.js";

export interface TraceabilityControllerPort {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
  readonly configReadPath: string;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly traceDefaults: AppTraceDefaults | undefined;
  readonly backgroundSnapshot: BackgroundSnapshot | undefined;
  readonly drivers: readonly ChannelDriver[];
  readonly statuses: Map<ChannelId, ChannelStatus>;
  readonly processStartMs: number;
  stopped: boolean;
  staleRunsReconciled: boolean;
  traceabilityStatusValue: TraceabilityStatus;
  exporterStatusValue: ExporterStatus;
  sandboxStatusValue: SandboxStatus;
  memoryHealthValue: TraceSourceMemoryHealth;
  memoryHealthRefreshDue: boolean;
  memoryHealthGeneration: number;
  startupCompleted: boolean;
  startupTimingValue: {
    readonly durationMs: number;
    readonly phases: Readonly<Record<string, number>>;
  } | undefined;
  selectedSkillsValue: readonly string[] | undefined;
  sessionMetadataValue: SessionTraceMetadata | undefined;
  resolvedExporter: ResolvedExporter | undefined;
  traceSource: TraceSourceHandle | undefined;
  globalTraceSource: TraceSourceHandle | undefined;
  traceRefreshInFlight: Promise<void> | undefined;
  traceRefreshDirty: boolean;
  traceRefreshLatestReason: string | undefined;
  activeTransports(): readonly string[];
  traceMetadata(reason: string): Record<string, unknown>;
  refreshSelectedSkillsSnapshot(reason: string): Promise<void>;
  refreshMemoryHealthSnapshot(reason: string, lifecycleForce?: boolean): Promise<TraceSourceMemoryHealth>;
  startMemoryHealthRefreshLoop(intervalMs: number): void;
  clearMemoryHealthRefreshTimer(): void;
  restartArtifactRetentionScheduler(artifactDir: string, reason: string): void;
  sandboxEngineFor(coreConfig: MonoAgentConfig): SandboxEngine | undefined;
  refreshTraceSource(reason: string): Promise<void>;
  invalidateMemoryHealthRefresh(): void;
  rememberSelectedSkills(coreConfig: MonoAgentConfig): void;
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

export async function startTraceability(controller: TraceabilityControllerPort, reason: string): Promise<TraceabilityStatus> {
  if (controller.stopped) {
    return controller.traceabilityStatusValue;
  }
  let artifactDirForRetention: string | undefined;
  try {
    const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
    await controller.refreshSelectedSkillsSnapshot(reason);
    await controller.refreshMemoryHealthSnapshot(reason);
    const [registryDir, artifactDir, sourceId, label, heartbeatMs, globalDiscovery] = await Promise.all([
      resolveAppTraceRegistryDir(input),
      resolveAppArtifactDir(input),
      resolveAppTraceSourceId(input, controller.traceDefaults, controller.configPath),
      resolveAppTraceSourceLabel(input, controller.traceDefaults),
      resolveAppTraceHeartbeatMs(input),
      resolveAppTraceGlobalDiscovery(input),
    ]);
    artifactDirForRetention = artifactDir;
    const registerOptions = {
      registryDir,
      sourceId,
      label,
      artifactDir,
      pid: process.pid,
      transports: controller.activeTransports(),
      configPath: controller.configPath,
      metadata: controller.traceMetadata(reason),
      memoryHealth: controller.memoryHealthValue,
      heartbeatMs,
    };
    controller.traceSource = await registerTraceSource(registerOptions);
    controller.traceabilityStatusValue = { kind: "running", sourceId, registryDir, artifactDir };
    controller.logger?.info?.("Traceability source registered.", { reason, sourceId, registryDir, artifactDir });
    void pruneTraceSources({ registryDir });

    // Best-effort global mirror: makes this agent discoverable by `mono-agent
    // tui` run anywhere on the machine, even when its own registryDir is a
    // config-local override (e.g. `mono-agent init`'s scaffold). A mirror
    // failure must never affect the primary registration above.
    const globalRegistryDir = resolveGlobalTraceRegistryDir(controller.env);
    const tmpdirRoot = resolveTraceTmpdirRoot(controller.env);
    if (shouldMirrorTraceSourceGlobally({ registryDir, globalRegistryDir, globalDiscovery, tmpdirRoot })) {
      try {
        controller.globalTraceSource = await registerTraceSource({ ...registerOptions, registryDir: globalRegistryDir });
        void pruneTraceSources({ registryDir: globalRegistryDir });
      } catch (error) {
        controller.globalTraceSource = undefined;
        controller.logger?.warn?.("Global trace-source mirror registration failed.", { reason: reasonOf(error) });
      }
    } else {
      controller.globalTraceSource = undefined;
    }
    controller.startMemoryHealthRefreshLoop(MIN_MEMORY_HEALTH_REFRESH_INTERVAL_MS);

  } catch (error) {
    controller.clearMemoryHealthRefreshTimer();
    const failure = reasonOf(error);
    controller.traceabilityStatusValue = { kind: "failed", reason: failure };
    controller.logger?.error?.("Traceability source registration failed.", { reason: failure });
  } finally {
    if (artifactDirForRetention !== undefined) {
      // Fire-and-forget: orphan reclamation and retention are best-effort cleanup
      // and must not gate startup readiness. Keep them independent from trace
      // source registration; a broken registry should not disable artifact GC.
      controller.restartArtifactRetentionScheduler(artifactDirForRetention, reason);
    }
  }
  return controller.traceabilityStatusValue;
}

export async function refreshSandboxStatus(controller: TraceabilityControllerPort, reason: string): Promise<SandboxStatus> {
  try {
    const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
    const coreConfig = await loadAppCoreConfig(input);
    const sandboxEngine = controller.sandboxEngineFor(coreConfig);
    const state = await resolveSandboxEffectiveState({
      ...(coreConfig.sandbox === undefined ? {} : { policy: coreConfig.sandbox }),
      ...(sandboxEngine === undefined ? {} : { engine: sandboxEngine }),
    });
    const status = sandboxStatusFromState(state);
    controller.sandboxStatusValue = status;
    if (status.warning !== undefined) {
      controller.logger?.warn?.(status.warning, { reason, detail: status.detail });
    }
    return status;
  } catch (error) {
    const resolutionError = reasonOf(error);
    const status = {
      ...DEFAULT_SANDBOX_STATUS,
      detail: `Sandbox status unavailable until agent config loads: ${resolutionError}`,
      resolutionError,
    };
    controller.sandboxStatusValue = status;
    controller.logger?.info?.("Sandbox status unavailable until agent config loads.", { reason, detail: resolutionError });
    return status;
  }
}

export async function reconcileStaleRunsOnce(controller: TraceabilityControllerPort, artifactDir: string): Promise<void> {
  if (controller.staleRunsReconciled) {
    return;
  }
  controller.staleRunsReconciled = true;
  try {
    const { reconciled, warnings } = await reconcileStaleRunArtifacts(artifactDir, {
      startedBeforeMs: controller.processStartMs,
    });
    for (const warning of warnings) {
      controller.logger?.warn?.(`Stale-run reconciliation: ${warning}`);
    }
    if (reconciled.length > 0) {
      controller.logger?.info?.('Reclaimed orphaned runs left as "running" by a prior process.', {
        count: reconciled.length,
        runIds: reconciled.slice(0, 20),
      });
    }
  } catch (error) {
    controller.logger?.warn?.("Stale-run reconciliation failed.", { reason: reasonOf(error) });
  }
}

export async function startExporters(controller: TraceabilityControllerPort, reason: string): Promise<ExporterStatus> {
  if (controller.stopped) {
    return controller.exporterStatusValue;
  }
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
  let exporters: readonly ResolvedExporter[];
  try {
    exporters = await resolveAppObservabilityExporters(input);
  } catch (error) {
    controller.resolvedExporter = undefined;
    controller.exporterStatusValue = { kind: "failed", reason: reasonOf(error) };
    controller.logger?.error?.("Observability exporter config is invalid.", { reason: reasonOf(error) });
    return controller.exporterStatusValue;
  }

  const exporter = exporters[0];
  if (exporter === undefined) {
    controller.resolvedExporter = undefined;
    controller.exporterStatusValue = { kind: "disabled", reason: "No observability exporter configured." };
    return controller.exporterStatusValue;
  }

  controller.resolvedExporter = exporter;
  controller.exporterStatusValue = {
    kind: "configured",
    endpoint: exporter.endpoint,
    includeSensitiveData: exporter.includeSensitiveData ?? false,
  };
  controller.logger?.info?.("Observability exporter configured.", {
    reason,
    endpoint: exporter.endpoint,
    includeSensitiveData: exporter.includeSensitiveData ?? false,
  });
  return controller.exporterStatusValue;
}

export function recordExporterWarning(controller: TraceabilityControllerPort, warning: { phase: string; message: string }): void {
  const current = controller.exporterStatusValue;
  if (current.kind !== "configured") {
    return;
  }
  const message = `${warning.phase}: ${warning.message}`;
  // The "fail" phase fires only when export fails on the run-failure path;
  // surface it as lastError so operators can tell it apart from a transient
  // best-effort warning. The run outcome is unchanged either way.
  controller.exporterStatusValue =
    warning.phase === "fail" ? { ...current, lastError: message } : { ...current, lastWarning: message };
  controller.logger?.warn?.("Observability export warning.", { phase: warning.phase, message: warning.message });
  // Persist to the trace-source manifest so the detached `mono-agent status`
  // (which reads the manifest, not this live object) can surface it too.
  void controller.refreshTraceSource("exporter-warning").catch(() => undefined);
}

export function refreshTraceSource(controller: TraceabilityControllerPort, reason: string): Promise<void> {
  const existing = controller.traceRefreshInFlight;
  if (existing !== undefined) {
    // Keep one bounded replay slot. Concurrent explicit callers share the
    // exact owner promise; the owner publishes the latest state/reason once
    // more after its current write. Requests arriving during that replay set
    // the same bit again, without growing a callback queue.
    controller.traceRefreshDirty = true;
    controller.traceRefreshLatestReason = reason;
    return existing;
  }
  const traceSource = controller.traceSource;
  const globalTraceSource = controller.globalTraceSource;
  if (traceSource === undefined) {
    return Promise.resolve();
  }
  const generation = controller.memoryHealthGeneration;
  let pending!: Promise<void>;
  pending = (async (): Promise<void> => {
    let publishReason = reason;
    for (;;) {
      controller.traceRefreshDirty = false;
      controller.traceRefreshLatestReason = undefined;
      const health = await controller.refreshMemoryHealthSnapshot(publishReason);
      if (generation !== controller.memoryHealthGeneration || controller.traceSource !== traceSource) {
        return;
      }
      const patch = {
        transports: controller.activeTransports(),
        metadata: controller.traceMetadata(publishReason),
        memoryHealth: health,
      };
      try {
        await traceSource.update(patch);
      } catch (error) {
        controller.logger?.warn?.("Traceability source update failed.", { reason: reasonOf(error) });
      }
      if (globalTraceSource !== undefined && generation === controller.memoryHealthGeneration
        && controller.globalTraceSource === globalTraceSource) {
        try {
          await globalTraceSource.update(patch);
        } catch (error) {
          controller.logger?.warn?.("Global trace-source mirror update failed.", { reason: reasonOf(error) });
        }
      }
      if (!controller.traceRefreshDirty || generation !== controller.memoryHealthGeneration
        || controller.traceSource !== traceSource) {
        return;
      }
      publishReason = controller.traceRefreshLatestReason ?? publishReason;
    }
  })().catch(() => {
    // Health computation and trace handles already sanitize/log their own
    // failures. Keep this final boundary closed so background refreshes never
    // become unhandled rejections or leak raw provider/native errors.
  }).finally(() => {
    if (controller.traceRefreshInFlight === pending) {
      controller.traceRefreshInFlight = undefined;
      const replayDue = controller.memoryHealthRefreshDue
        && !controller.stopped
        && generation === controller.memoryHealthGeneration
        && controller.traceSource === traceSource;
      controller.traceRefreshDirty = false;
      controller.traceRefreshLatestReason = undefined;
      // A timer can fire after the loop's final dirty check but before this
      // owner settles. Preserve exactly one due replay across that seam.
      if (replayDue) {
        void controller.refreshTraceSource("memory-health-periodic").catch(() => undefined);
      }
    }
  });
  controller.traceRefreshInFlight = pending;
  return pending;
}

export async function observabilityContext(controller: TraceabilityControllerPort): Promise<{
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly configPath?: string;
}> {
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
  const [sourceId, sourceLabel] = await Promise.all([
    resolveAppTraceSourceId(input, controller.traceDefaults, controller.configPath),
    resolveAppTraceSourceLabel(input, controller.traceDefaults),
  ]);
  return { sourceId, sourceLabel, configPath: controller.configPath };
}

export function reportMemoryRecallStatus(
  controller: TraceabilityControllerPort,
  coreConfig: MonoAgentConfig,
  service: MemoryRetrievalService | undefined,
): boolean {
  const settings = resolveMemoryRecallSettings(coreConfig);
  if (settings === undefined) {
    return false;
  }
  if (service === undefined) {
    controller.logger?.warn?.("MemoryRecall could not be enabled because the configured store has no recall surface.");
    return false;
  }
  controller.logger?.info?.("Read-only MemoryRecall tool enabled.", {
    provider: "supermemory" in settings ? "supermemory" : settings.embeddings?.provider ?? "fts-only",
  });
  return true;
}

export async function stopTraceSource(controller: TraceabilityControllerPort, reason: string): Promise<void> {
  controller.invalidateMemoryHealthRefresh();
  const traceSource = controller.traceSource;
  const globalTraceSource = controller.globalTraceSource;
  // Detach before stopping. A health probe may be stalled indefinitely; its
  // generation/handle checks fence any late result, while a reload is free to
  // register and refresh a new source without waiting for the old probe.
  controller.traceSource = undefined;
  controller.globalTraceSource = undefined;
  controller.traceRefreshInFlight = undefined;
  controller.traceRefreshDirty = false;
  controller.traceRefreshLatestReason = undefined;
  if (traceSource === undefined && globalTraceSource === undefined) {
    return;
  }
  const patch = {
    metadata: controller.traceMetadata(reason),
    transports: controller.activeTransports(),
    memoryHealth: controller.memoryHealthValue,
  };
  await traceSource?.stop(patch).catch((error: unknown) => {
    controller.logger?.warn?.("Traceability source stop update failed.", { reason: reasonOf(error) });
  });
  await globalTraceSource?.stop(patch).catch((error: unknown) => {
    controller.logger?.warn?.("Global trace-source mirror stop update failed.", { reason: reasonOf(error) });
  });
  if (!controller.stopped) {
    controller.traceabilityStatusValue = { kind: "disabled", reason: "Traceability source stopped while applying config." };
  }
}

export async function refreshSelectedSkillsSnapshot(controller: TraceabilityControllerPort, reason: string): Promise<void> {
  try {
    const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
    controller.rememberSelectedSkills(await loadAppCoreConfig(input));
  } catch (error) {
    controller.selectedSkillsValue = undefined;
    controller.logger?.info?.("Selected skills unavailable until agent config loads.", { reason, detail: reasonOf(error) });
  }
}

export function rememberSelectedSkills(controller: TraceabilityControllerPort, coreConfig: MonoAgentConfig): void {
  controller.selectedSkillsValue = [...coreConfig.context.selectedSkills];
}

export function recordSessionEvent(controller: TraceabilityControllerPort, event: ConfiguredAgentSessionEvent, coreConfig: MonoAgentConfig): void {
  const now = new Date();
  const nextRolloverAt = coreConfig.runtime.session.rollover === "daily"
    ? nextDailyRolloverAt(now, coreConfig.runtime.session.rolloverTimezone)
    : undefined;
  const snapshot = event.snapshot ?? [];
  const current = snapshot.find((entry) => entry.conversationId === event.conversationId);
  const providerSessionId = current?.providerSessionId ?? event.providerSessionId;
  controller.sessionMetadataValue = {
    currentBucketId: event.conversationId,
    state: current === undefined ? "cold" : "warm",
    event: event.kind,
    updatedAt: now.toISOString(),
    ...(snapshot.length === 0 ? {} : { snapshot }),
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(current?.createdAt === undefined ? {} : { createdAt: current.createdAt }),
    ...(current?.lastActivityAt === undefined ? {} : { lastActivityAt: current.lastActivityAt }),
    ...(current?.busy === undefined ? {} : { busy: current.busy }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(nextRolloverAt === undefined ? {} : { nextRolloverAt }),
  };
  if (event.kind === "evicted") {
    controller.logger?.info?.("Provider session evicted.", {
      conversationId: event.conversationId,
      providerSessionId: event.providerSessionId,
      reason: event.reason,
    });
  }
  void controller.refreshTraceSource(`session-${event.kind}`).catch(() => undefined);
}

export function traceMetadata(controller: TraceabilityControllerPort, reason: string): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  for (const driver of controller.drivers) {
    const status = controller.statuses.get(driver.id);
    if (status === undefined) {
      continue;
    }
    channels[driver.id] = status.kind === "running"
      ? { kind: "running", ...status.summary }
      : { kind: status.kind, reason: status.reason };
  }
  return {
    reason,
    ...(controller.startupCompleted
      ? {
          lifecycle: {
            startupCompleted: true,
            ...(controller.startupTimingValue === undefined
              ? {}
              : {
                  startupDurationMs: controller.startupTimingValue.durationMs,
                  startupPhasesMs: controller.startupTimingValue.phases,
                }),
          },
        }
      : {}),
    ...(controller.backgroundSnapshot === undefined ? {} : { backgroundSnapshot: controller.backgroundSnapshot }),
    ...(controller.exporterStatusValue.kind === "configured"
      ? {
          observability: {
            // Persist only the endpoint + warning/error strings (never headers
            // or secrets) so the detached `status` reader can surface exporter
            // state. JSONL artifacts always remain local.
            endpoint: controller.exporterStatusValue.endpoint,
            includeSensitiveData: controller.exporterStatusValue.includeSensitiveData,
            jsonlArtifactsLocal: true,
            ...(controller.exporterStatusValue.lastWarning === undefined
              ? {}
              : { lastWarning: controller.exporterStatusValue.lastWarning }),
            ...(controller.exporterStatusValue.lastError === undefined
              ? {}
              : { lastError: controller.exporterStatusValue.lastError }),
          },
        }
      : {}),
    sandbox: {
      configured: controller.sandboxStatusValue.configured,
      configuredMode: controller.sandboxStatusValue.configuredMode,
      effective: controller.sandboxStatusValue.effective,
      engine: controller.sandboxStatusValue.engine,
      engineAvailable: controller.sandboxStatusValue.engineAvailable,
      fallback: controller.sandboxStatusValue.fallback,
      fallbackActive: controller.sandboxStatusValue.fallbackActive,
      unsafeAllowHostProcess: controller.sandboxStatusValue.unsafeAllowHostProcess,
      detail: controller.sandboxStatusValue.detail,
      ...(controller.sandboxStatusValue.warning === undefined ? {} : { warning: controller.sandboxStatusValue.warning }),
      ...(controller.sandboxStatusValue.resolutionError === undefined
        ? {}
        : { resolutionError: controller.sandboxStatusValue.resolutionError }),
    },
    ...(controller.selectedSkillsValue === undefined
      ? {}
      : {
          context: {
            selectedSkills: [...controller.selectedSkillsValue],
          },
        }),
    ...(controller.sessionMetadataValue === undefined ? {} : { session: controller.sessionMetadataValue }),
    channels,
  };
}

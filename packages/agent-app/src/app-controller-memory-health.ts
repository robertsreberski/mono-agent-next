import type { MonoAgentConfig } from "@mono-agent/config";
import type { TraceSourceMemoryHealth } from "@mono-agent/observability";

import { loadAppCoreConfig } from "./app-config.js";
import {
  traceMemoryHealthFromBujo,
  unknownBujoMemoryHealth,
  unknownNoMemoryHealth,
} from "./app-controller-utils.js";
import type { MonoAgentAppLogger } from "./channels.js";
import type { TraceSourceHandle } from "@mono-agent/observability";

export interface MemoryHealthControllerPort {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configReadPath: string;
  readonly logger: MonoAgentAppLogger | undefined;
  stopped: boolean;
  traceSource: TraceSourceHandle | undefined;
  memoryHealthValue: TraceSourceMemoryHealth;
  memoryHealthRefreshInFlight: Promise<TraceSourceMemoryHealth> | undefined;
  memoryHealthRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  memoryHealthRefreshLoopActive: boolean;
  memoryHealthRefreshIntervalMs: number;
  memoryHealthLastCompletedAtMs: number | undefined;
  memoryHealthRefreshDue: boolean;
  memoryHealthGeneration: number;
  startupCompleted: boolean;
  startupTimingValue: {
    readonly durationMs: number;
    readonly phases: Readonly<Record<string, number>>;
  } | undefined;
  computeMemoryHealth(): Promise<TraceSourceMemoryHealth>;
  recordMemoryHealthCompletion(generation: number): void;
  scheduleMemoryHealthRefresh(delayOverrideMs?: number): void;
  clearMemoryHealthRefreshTimer(): void;
  refreshMemoryHealthOnTimer(): void;
  refreshMemoryHealthSnapshot(reason: string, lifecycleForce?: boolean): Promise<TraceSourceMemoryHealth>;
  refreshTraceSource(reason: string): Promise<void>;
}

const MIN_MEMORY_HEALTH_REFRESH_INTERVAL_MS = 30_000;

export function refreshMemoryHealthSnapshot(controller: MemoryHealthControllerPort, reason: string, lifecycleForce = false): Promise<TraceSourceMemoryHealth> {
  if (controller.stopped) {
    return Promise.resolve(controller.memoryHealthValue);
  }
  if (controller.memoryHealthRefreshInFlight !== undefined) {
    return controller.memoryHealthRefreshInFlight;
  }
  const forced = lifecycleForce || controller.memoryHealthRefreshDue;
  if (!forced && controller.memoryHealthLastCompletedAtMs !== undefined
    && performance.now() - controller.memoryHealthLastCompletedAtMs < MIN_MEMORY_HEALTH_REFRESH_INTERVAL_MS) {
    return Promise.resolve(controller.memoryHealthValue);
  }
  const generation = controller.memoryHealthGeneration;
  let pending!: Promise<TraceSourceMemoryHealth>;
  pending = controller.computeMemoryHealth().then((health) => {
    if (!controller.stopped && generation === controller.memoryHealthGeneration) {
      controller.memoryHealthValue = health;
      controller.recordMemoryHealthCompletion(generation);
      return health;
    }
    return controller.memoryHealthValue;
  }).catch(() => {
    const health = controller.memoryHealthValue.backend === "bujo"
      ? unknownBujoMemoryHealth(controller.memoryHealthValue.mode)
      : controller.memoryHealthValue.backend === "supermemory"
        ? {
            backend: "supermemory" as const,
            status: "unknown" as const,
            checkedAt: new Date().toISOString(),
          }
        : unknownNoMemoryHealth();
    if (!controller.stopped && generation === controller.memoryHealthGeneration) {
      controller.memoryHealthValue = health;
      controller.recordMemoryHealthCompletion(generation);
    }
    controller.logger?.warn?.("Memory health refresh failed; publishing sanitized unknown health.", { reason });
    return health;
  }).finally(() => {
    if (controller.memoryHealthRefreshInFlight === pending) {
      controller.memoryHealthRefreshInFlight = undefined;
    }
  });
  controller.memoryHealthRefreshInFlight = pending;
  return pending;
}

export async function computeMemoryHealth(controller: MemoryHealthControllerPort): Promise<TraceSourceMemoryHealth> {
  let config: MonoAgentConfig;
  try {
    config = await loadAppCoreConfig({ env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath });
  } catch {
    return unknownNoMemoryHealth();
  }
  const memory = config.memory;
  if (memory === undefined) {
    return {
      backend: "none",
      status: "not_configured",
      checkedAt: new Date().toISOString(),
    };
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    return {
      backend: "supermemory",
      status: "unknown",
      checkedAt: new Date().toISOString(),
    };
  }
  try {
    const { auditBujoMemoryHealth } = await import("@mono-agent/memory/bujo");
    return traceMemoryHealthFromBujo(auditBujoMemoryHealth({
      root: memory.path,
      mode: memory.mode,
      ...(memory.embeddings === undefined
        ? {}
        : {
            configuredEmbeddingModel: `${memory.embeddings.provider}:${memory.embeddings.model}`,
            configuredDimension: memory.embeddings.dim ?? 768,
          }),
    }));
  } catch {
    return unknownBujoMemoryHealth(memory.mode);
  }
}

export function startMemoryHealthRefreshLoop(controller: MemoryHealthControllerPort, intervalMs: number): void {
  controller.memoryHealthRefreshLoopActive = true;
  controller.memoryHealthRefreshIntervalMs = intervalMs;
  controller.scheduleMemoryHealthRefresh();
}

export function scheduleMemoryHealthRefresh(controller: MemoryHealthControllerPort, delayOverrideMs?: number): void {
  controller.clearMemoryHealthRefreshTimer();
  if (!controller.memoryHealthRefreshLoopActive || controller.stopped || controller.traceSource === undefined) return;
  const elapsed = controller.memoryHealthLastCompletedAtMs === undefined
    ? controller.memoryHealthRefreshIntervalMs
    : Math.max(0, performance.now() - controller.memoryHealthLastCompletedAtMs);
  const delay = delayOverrideMs ?? Math.max(0, controller.memoryHealthRefreshIntervalMs - elapsed);
  controller.memoryHealthRefreshTimer = setTimeout(() => {
    controller.memoryHealthRefreshTimer = undefined;
    controller.refreshMemoryHealthOnTimer();
  }, delay);
  controller.memoryHealthRefreshTimer.unref?.();
}

export function recordMemoryHealthCompletion(controller: MemoryHealthControllerPort, generation: number): void {
  if (controller.stopped || generation !== controller.memoryHealthGeneration) return;
  controller.memoryHealthLastCompletedAtMs = performance.now();
  // Any full audit that was already running when the timer became due
  // satisfies that due tick; never queue an immediate second audit.
  controller.memoryHealthRefreshDue = false;
  controller.scheduleMemoryHealthRefresh(controller.memoryHealthRefreshIntervalMs);
}

export function refreshMemoryHealthOnTimer(controller: MemoryHealthControllerPort): void {
  if (controller.stopped) return;
  if (controller.memoryHealthLastCompletedAtMs !== undefined) {
    const elapsed = performance.now() - controller.memoryHealthLastCompletedAtMs;
    if (elapsed < controller.memoryHealthRefreshIntervalMs) {
      controller.scheduleMemoryHealthRefresh();
      return;
    }
  }
  // Set the due bit before joining the trace single-flight. If a publication
  // is already active it consumes one bounded trailing replay rather than
  // dropping this tick and waiting another full interval.
  controller.memoryHealthRefreshDue = true;
  void controller.refreshTraceSource("memory-health-periodic").catch(() => undefined);
}

export async function refreshMemoryHealthAfterLifecycle(
  controller: MemoryHealthControllerPort,
  reason: string,
  beforePublish?: () => void,
): Promise<void> {
  if (controller.stopped) return;
  const generation = controller.memoryHealthGeneration;
  const joinedExistingAudit = controller.memoryHealthRefreshInFlight !== undefined;
  await controller.refreshMemoryHealthSnapshot(reason, true);
  if (joinedExistingAudit && !controller.stopped && generation === controller.memoryHealthGeneration) {
    await controller.refreshMemoryHealthSnapshot(reason, true);
  }
  if (controller.stopped || generation !== controller.memoryHealthGeneration) return;
  beforePublish?.();
  controller.startupCompleted = true;
  await controller.refreshTraceSource(reason);
}

export function clearMemoryHealthRefreshTimer(controller: MemoryHealthControllerPort): void {
  if (controller.memoryHealthRefreshTimer !== undefined) {
    clearTimeout(controller.memoryHealthRefreshTimer);
    controller.memoryHealthRefreshTimer = undefined;
  }
}

export function invalidateMemoryHealthRefresh(controller: MemoryHealthControllerPort): void {
  controller.startupCompleted = false;
  controller.startupTimingValue = undefined;
  controller.memoryHealthRefreshLoopActive = false;
  controller.clearMemoryHealthRefreshTimer();
  controller.memoryHealthGeneration += 1;
  controller.memoryHealthRefreshInFlight = undefined;
  controller.memoryHealthLastCompletedAtMs = undefined;
  controller.memoryHealthRefreshDue = false;
}

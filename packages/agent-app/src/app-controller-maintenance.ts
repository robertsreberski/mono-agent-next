import type { MonoAgentConfig } from "@mono-agent/config";
import type { MonoRuntimeLike, SandboxEngine } from "@mono-agent/runtime-adapter";
import {
  DEFAULT_MEMORY_FORGET_BACKUP_MAX_AGE_DAYS,
  DEFAULT_MEMORY_FORGET_BACKUP_MAX_COUNT,
} from "@mono-agent/memory/bujo";
import { deliverWebNotification } from "@mono-agent/web";

import { loadAppCoreConfig, resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { createConfiguredAgentRuntime } from "./configured-agent.js";
import type { createConfiguredMemory } from "./configured-agent.js";
import { routeProactiveNotification } from "./proactive-notify.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import { startMemoryRituals } from "./memory-rituals.js";
import type { RunningRituals } from "./memory-rituals.js";
import { startArtifactRetentionScheduler } from "./artifact-retention.js";
import type { RunningArtifactRetentionScheduler } from "./artifact-retention.js";
import { resolveNotifyDestinations } from "./notify-destinations.js";
import type { NotifyDestination } from "./notify-destinations.js";
import { reasonOf } from "./app-controller-utils.js";
import type { ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";
import type { SeenNotifyDestinationCache } from "./seen-conversations.js";

type ConfiguredMemory = Awaited<ReturnType<typeof createConfiguredMemory>>;

interface NotifyControllerPort {
  readonly logger: MonoAgentAppLogger | undefined;
  readonly running: Map<ChannelId, RunningChannel>;
  observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }>;
}

interface DestinationsControllerPort {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configReadPath: string;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly running: Map<ChannelId, RunningChannel>;
  readonly seenNotifyDestinations: SeenNotifyDestinationCache;
}

export interface MaintenanceControllerPort extends NotifyControllerPort, DestinationsControllerPort {
  readonly runtime: MonoRuntimeLike | undefined;
  readonly activeRuntimes: MonoRuntimeLike[];
  stopped: boolean;
  memoryRituals: RunningRituals | undefined;
  artifactRetentionScheduler: RunningArtifactRetentionScheduler | undefined;
  artifactRetentionGeneration: number;
  rememberSelectedSkills(coreConfig: MonoAgentConfig): void;
  sandboxEngineFor(coreConfig: MonoAgentConfig): SandboxEngine | undefined;
  memoryStore(coreConfig: MonoAgentConfig): Promise<ConfiguredMemory>;
  stopArtifactRetentionScheduler(): void;
  reconcileStaleRunsOnce(artifactDir: string): Promise<void>;
}

export async function startMemoryRitualsIfConfigured(controller: MaintenanceControllerPort, reason: string): Promise<void> {
  if (controller.stopped) {
    return;
  }
  let coreConfig: MonoAgentConfig;
  try {
    const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
    coreConfig = await loadAppCoreConfig(input);
    controller.rememberSelectedSkills(coreConfig);
  } catch {
    // Config not ready yet — consolidation will start on the next applyConfigChange.
    return;
  }

  if (coreConfig.memory?.mode !== "bujo") {
    return;
  }

  const sandboxEngine = controller.sandboxEngineFor(coreConfig);
  const runtime = controller.runtime ?? createConfiguredAgentRuntime({
    config: coreConfig,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
  });
  if (!controller.activeRuntimes.includes(runtime)) {
    controller.activeRuntimes.push(runtime);
  }
  const store = await controller.memoryStore(coreConfig);
  // Duck-type: only bujo-tier BujoMemoryStore has consolidate().
  // Cast through unknown to bypass the MemoryStore contract's type mismatch.
  const storeAsAny = store as unknown as Record<string, unknown>;
  if (
    store === undefined ||
    typeof storeAsAny["consolidate"] !== "function" ||
    typeof storeAsAny["tier"] !== "function"
  ) {
    controller.logger?.info?.("Memory consolidation scheduler skipped — store does not support consolidate().", { reason });
    return;
  }

  const bujoStore = store as unknown as {
    tier(): string;
    consolidate(): Promise<unknown>;
  };

  // `memory.mode` is "bujo", but the store derives the runtime tier from its options: without a
  // `memory.llm` it downgrades to "journal", where startMemoryRituals is a no-op. Don't claim the
  // scheduler started in that case — log an accurate skip instead.
  const tier = bujoStore.tier();
  if (tier !== "bujo") {
    controller.logger?.info?.(
      "Memory consolidation scheduler skipped — configured bujo mode resolved to the journal tier because memory.llm is missing.",
      { reason, tier },
    );
    return;
  }

  controller.memoryRituals = startMemoryRituals({
    store: bujoStore,
    ...(coreConfig.memory.consolidation !== undefined && { consolidation: coreConfig.memory.consolidation }),
    ...(controller.logger !== undefined && {
      logger: {
        info: (m: string) => controller.logger?.info?.(m),
        warn: (m: string) => controller.logger?.warn?.(m),
      },
    }),
  });

  controller.logger?.info?.("Memory consolidation scheduler started.", { reason, mode: "bujo" });
}

export function stopMemoryRituals(controller: MaintenanceControllerPort): void {
  const rituals = controller.memoryRituals;
  if (rituals === undefined) {
    return;
  }
  controller.memoryRituals = undefined;
  try {
    rituals.stop();
  } catch (error) {
    controller.logger?.warn?.("Memory consolidation scheduler did not stop cleanly.", {
      reason: reasonOf(error),
    });
    return;
  }
  controller.logger?.info?.("Memory consolidation scheduler stopped.");
}

export function restartArtifactRetentionScheduler(controller: MaintenanceControllerPort, artifactDir: string, reason: string): void {
  controller.stopArtifactRetentionScheduler();
  const generation = ++controller.artifactRetentionGeneration;
  void (async () => {
    let coreConfig: MonoAgentConfig;
    try {
      const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
      coreConfig = await loadAppCoreConfig(input);
      controller.rememberSelectedSkills(coreConfig);
    } catch (error) {
      controller.logger?.warn?.("Artifact retention scheduler skipped until core config loads.", { reason: reasonOf(error) });
      void controller.reconcileStaleRunsOnce(artifactDir);
      return;
    }
    if (controller.stopped || generation !== controller.artifactRetentionGeneration) {
      return;
    }
    controller.artifactRetentionScheduler = startArtifactRetentionScheduler({
      artifactDir,
      retention: coreConfig.artifacts.retention,
      memoryRetention: coreConfig.artifacts.memoryRetention,
      ...(coreConfig.memory === undefined || coreConfig.memory.backend === "supermemory"
        ? {}
        : { memoryRoot: coreConfig.memory.path }),
      ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      beforeFirstRun: () => controller.reconcileStaleRunsOnce(artifactDir),
    });
    controller.logger?.info?.("Artifact retention scheduler started.", {
      reason,
      artifactDir,
      agent: {
        maxAgeDays: coreConfig.artifacts.retention.maxAgeDays,
        maxCount: coreConfig.artifacts.retention.maxCount,
        dryRun: coreConfig.artifacts.retention.dryRun,
      },
      memory: {
        maxAgeDays: coreConfig.artifacts.memoryRetention.maxAgeDays,
        maxCount: coreConfig.artifacts.memoryRetention.maxCount,
        dryRun: coreConfig.artifacts.memoryRetention.dryRun,
      },
      forgetBackups: coreConfig.memory === undefined || coreConfig.memory.backend === "supermemory"
        ? { enabled: false }
        : {
            enabled: true,
            memoryRoot: coreConfig.memory.path,
            maxAgeDays: DEFAULT_MEMORY_FORGET_BACKUP_MAX_AGE_DAYS,
            maxCount: DEFAULT_MEMORY_FORGET_BACKUP_MAX_COUNT,
            dryRun: coreConfig.artifacts.memoryRetention.dryRun,
          },
    });
  })();
}

export function stopArtifactRetentionScheduler(controller: MaintenanceControllerPort): void {
  controller.artifactRetentionGeneration += 1;
  const scheduler = controller.artifactRetentionScheduler;
  if (scheduler === undefined) {
    return;
  }
  controller.artifactRetentionScheduler = undefined;
  try {
    scheduler.stop();
  } catch (error) {
    controller.logger?.warn?.("Artifact retention scheduler did not stop cleanly.", {
      reason: reasonOf(error),
    });
    return;
  }
  controller.logger?.info?.("Artifact retention scheduler stopped.");
}

export async function notifyDestination(
  controller: NotifyControllerPort,
  conversationId: string,
  text: string,
  options?: { readonly verbatim?: boolean; readonly deliveryKey?: string },
  sourceChannelId?: ChannelId,
): Promise<NotifyDeliveryResult> {
  if (conversationId === "web:new") {
    if (sourceChannelId !== "cron" && sourceChannelId !== "webhook") {
      return {
        delivered: false,
        code: "unsupported_web_notification_source",
        reason: "web:new is available only to cron and webhook notification channels.",
        retryable: false,
      };
    }
    if (options?.verbatim !== true || options.deliveryKey === undefined) {
      return {
        delivered: false,
        code: "invalid_web_notification",
        reason: "web:new requires verbatim delivery with a stable delivery key.",
        retryable: false,
      };
    }
    try {
      const { sourceId } = await controller.observabilityContext();
      if (sourceId === undefined) {
        return {
          delivered: false,
          code: "missing_source_id",
          reason: "The agent has no stable source id for web notification delivery.",
          retryable: false,
        };
      }
      const delivered = await deliverWebNotification({
        sourceId,
        triggerKind: sourceChannelId,
        deliveryKey: options.deliveryKey,
        text,
      });
      controller.logger?.info?.("Web notification conversation delivered.", {
        sourceId,
        triggerKind: sourceChannelId,
        threadId: delivered.threadId,
        duplicate: delivered.duplicate,
      });
      return { delivered: true, code: delivered.duplicate ? "duplicate" : "delivered" };
    } catch (error) {
      const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "web_notification_failed";
      const reason = reasonOf(error);
      controller.logger?.warn?.("Web notification conversation was not delivered.", {
        triggerKind: sourceChannelId,
        code,
        reason,
      });
      return { delivered: false, code, reason, retryable: false };
    }
  }
  if (conversationId.startsWith("web:")) {
    return {
      delivered: false,
      code: "unsupported_web_destination",
      reason: "The only supported web notification destination is web:new.",
      retryable: false,
    };
  }
  const result = await routeProactiveNotification({
    conversationId,
    text,
    running: controller.running,
    ...(options?.verbatim === undefined ? {} : { verbatim: options.verbatim }),
    ...(options?.deliveryKey === undefined ? {} : { deliveryKey: options.deliveryKey }),
    ...(controller.logger === undefined ? {} : { logger: controller.logger }),
  });
  // Make the delivery outcome inspectable (the failure cases already warn inside
  // the router / channel hooks; log the success path too so a notify is auditable).
  if (result.delivered) {
    controller.logger?.info?.("Proactive notification delivered.", { conversationId });
  }
  return result;
}

export async function listNotifyDestinations(controller: DestinationsControllerPort): Promise<readonly NotifyDestination[]> {
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
  const artifactDir = await resolveAppArtifactDir(input);
  const seenDestinations = await controller.seenNotifyDestinations.list(artifactDir);
  return await resolveNotifyDestinations({
    input,
    artifactDir,
    seenDestinations,
    isRunning: (id) => controller.running.has(id),
    ...(controller.logger === undefined ? {} : { logger: controller.logger }),
  });
}

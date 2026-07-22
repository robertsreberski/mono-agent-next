import type { MonoAgentConfig } from "@mono-agent/config";
import type { ChannelLogger } from "@mono-agent/agent-contracts";

import { createConfiguredMemory } from "./configured-agent.js";
import { isSharedRecallStore, MemoryRetrievalService } from "./memory-retrieval.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";

type ConfiguredMemory = Awaited<ReturnType<typeof createConfiguredMemory>>;

export interface MemoryControllerPort {
  readonly cwd: string;
  readonly logger: ChannelLogger | undefined;
  readonly backgroundSnapshot: BackgroundSnapshot | undefined;
  sharedMemory: ConfiguredMemory;
  sharedMemoryRetrieval: MemoryRetrievalService | undefined;
  sharedMemoryBuilt: boolean;
  sharedMemoryBuild: Promise<ConfiguredMemory> | undefined;
  observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }>;
  recordExporterWarning(warning: { readonly phase: string; readonly message: string }): void;
  ensureSharedMemoryRetrieval(
    coreConfig: MonoAgentConfig,
    store: ConfiguredMemory,
  ): MemoryRetrievalService | undefined;
}

export async function memoryStore(
  controller: MemoryControllerPort,
  coreConfig: MonoAgentConfig,
): Promise<Awaited<ReturnType<typeof createConfiguredMemory>>> {
  if (controller.sharedMemoryBuilt) {
    return controller.sharedMemory;
  }
  if (controller.sharedMemoryBuild !== undefined) {
    return await controller.sharedMemoryBuild;
  }
  controller.sharedMemoryBuild = (async () => {
    const appLogger = controller.logger;
    const logger = appLogger?.warn !== undefined
      ? { warn: (message: string) => { appLogger.warn?.(message); } }
      : undefined;
    // Thread the per-app observability context so the bujo memory LLM records
    // capture and consolidation runs through the same JSONL + Phoenix pipeline
    // as channel runs (gated by `memory.llm.trace`, default on). The context is
    // per-app (not per-request), so caching it into the shared store is correct.
    //
    // The channel runtime is intentionally NOT passed: the memory LLM must run
    // on `config.memory.llm.model`, but the channel runtime carries the channel
    // fallback chain whose primary is `config.runtime.model` and the fallback
    // router overrides each run's per-call model. createConfiguredMemory builds
    // the memory LLM its own fallback-free runtime when no `memoryRuntime` is set.
    const observabilityContext = await controller.observabilityContext();
    const observability = {
      observabilityContext,
      exporterWarn: (warning: { readonly phase: string; readonly message: string }) => controller.recordExporterWarning(warning),
    };
    controller.sharedMemory = await createConfiguredMemory(coreConfig, {
      cwd: controller.cwd,
      // A managed worker receives a launch-attested snapshot and an exact
      // plugin closure beside agent-app. Never let mutable agent-local
      // node_modules replace that copied closure after launch.
      preferAppPluginInstall: controller.backgroundSnapshot !== undefined,
      ...(logger === undefined ? {} : { logger }),
      observability,
    });
    controller.ensureSharedMemoryRetrieval(coreConfig, controller.sharedMemory);
    controller.sharedMemoryBuilt = true;
    return controller.sharedMemory;
  })();
  try {
    return await controller.sharedMemoryBuild;
  } finally {
    controller.sharedMemoryBuild = undefined;
  }
}

export async function resetSharedMemory(controller: MemoryControllerPort): Promise<void> {
  const mem = controller.sharedMemory as
    | { flush?: () => Promise<void>; close?: () => Promise<void> | void }
    | undefined;
  controller.sharedMemory = undefined;
  controller.sharedMemoryRetrieval?.releaseAllTurns();
  controller.sharedMemoryRetrieval = undefined;
  controller.sharedMemoryBuilt = false;
  controller.sharedMemoryBuild = undefined;
  if (mem?.close !== undefined) {
    await Promise.resolve(mem.close()).catch(() => undefined);
  } else if (mem?.flush !== undefined) {
    // Stores without a lifecycle-aware close retain the legacy best-effort
    // drain. BuJo close owns its bounded shutdown deadline itself.
    await Promise.resolve(mem.flush()).catch(() => undefined);
  }
}

export function __setSharedMemoryForTest(controller: MemoryControllerPort, store: ConfiguredMemory): void {
  controller.sharedMemory = store;
  controller.sharedMemoryRetrieval = undefined;
  controller.sharedMemoryBuilt = true;
}

export function ensureSharedMemoryRetrieval(
  controller: MemoryControllerPort,
  coreConfig: MonoAgentConfig,
  store: Awaited<ReturnType<typeof createConfiguredMemory>>,
): MemoryRetrievalService | undefined {
  if (controller.sharedMemoryRetrieval !== undefined) return controller.sharedMemoryRetrieval;
  if (coreConfig.memory === undefined || !isSharedRecallStore(store)) return undefined;
  controller.sharedMemoryRetrieval = new MemoryRetrievalService(store, {
    maxBytes: coreConfig.memory.maxBytes,
    source: (coreConfig.memory.backend ?? "bujo") === "supermemory" ? "supermemory" : "memory-bujo",
  });
  return controller.sharedMemoryRetrieval;
}

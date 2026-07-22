import { resolve } from "node:path";

import { loadToolPolicyFromJsonFileSync } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { modelReferenceKey } from "@mono-agent/runtime-adapter";
import type { MonoRuntimeLike, RuntimeModelReference, SandboxEngine } from "@mono-agent/runtime-adapter";

import { resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import {
  createConfiguredAgentResponderForApp,
  createConfiguredAgentRuntime,
  DEFAULT_HISTORY_MAX_MESSAGES,
} from "./configured-agent.js";
import type { ConfiguredAgentSessionEvent, createConfiguredMemory } from "./configured-agent.js";
import {
  adapterSendToolNames,
  createAdapterSendToolsRuntimeExtension,
  resolveAdapterSendToolsSettings,
} from "./adapter-send-tools.js";
import { composeRuntimeOptionExtensions, type RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import { createLocalConfigurationRuntimeExtension } from "./local-configuration.js";
import { createRunHistoryRuntimeExtension, isRunHistoryToolAllowed } from "./run-history.js";
import {
  createRequestModelOverrideRuntimeExtension,
  requestModelOverrideTargetsDirectOpenCode,
} from "./request-model-override.js";
import { resolvePostedMessageIndexPath } from "./posted-message-index.js";
import { configuredRuntimeFallbackModels, hasConfiguredRuntimeFallbacks } from "./runtime-routes.js";
import { isNotifyDestinationConversationId } from "./notify-destinations.js";
import { createSlackPostedReplyHistory } from "./posted-reply-history.js";
import {
  isInteractionToolName,
  reasonOf,
  runtimeRouteContainsDirectOpenCode,
} from "./app-controller-utils.js";
import type { MonoAgentAppLogger } from "./channels.js";
import type { InteractionBridgeHandle } from "./interaction-bridge.js";
import type { ContinuationServiceHandle } from "./continuation-service.js";
import type { MemoryRetrievalService } from "./memory-retrieval.js";
import type { SeenNotifyDestinationCache } from "./seen-conversations.js";

type ConfiguredMemory = Awaited<ReturnType<typeof createConfiguredMemory>>;

export interface ResponderControllerPort {
  readonly cwd: string;
  readonly configPath: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly runtime: MonoRuntimeLike | undefined;
  readonly activeRuntimes: MonoRuntimeLike[];
  readonly interactionBridge: InteractionBridgeHandle | undefined;
  readonly continuationService: ContinuationServiceHandle | undefined;
  readonly seenNotifyDestinations: SeenNotifyDestinationCache;
  sandboxEngineFor(coreConfig: MonoAgentConfig): SandboxEngine | undefined;
  memoryStore(coreConfig: MonoAgentConfig): Promise<ConfiguredMemory>;
  ensureSharedMemoryRetrieval(
    coreConfig: MonoAgentConfig,
    store: ConfiguredMemory,
  ): MemoryRetrievalService | undefined;
  reportMemoryRecallStatus(coreConfig: MonoAgentConfig, service: MemoryRetrievalService | undefined): boolean;
  supermemoryMcpRuntimeOptions(coreConfig: MonoAgentConfig): RuntimeOptionsExtension | undefined;
  adapterSendToolsRuntimeOptions(coreConfig: MonoAgentConfig): Promise<{
    readonly createExtension?: (
      targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
    ) => RuntimeOptionsExtension;
    readonly blockingToolNames: readonly string[];
  }>;
  requestModelOverrideRuntimeOptions(
    coreConfig: MonoAgentConfig,
    compatibility: { readonly mcpSources: readonly string[]; readonly indexSkillsActive: boolean },
  ): {
    readonly extension: RuntimeOptionsExtension;
    readonly targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean;
  };
  buildRuntimeForModel(
    coreConfig: MonoAgentConfig,
  ): (model: RuntimeModelReference, executionMode?: string) => MonoRuntimeLike;
  observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }>;
  recordExporterWarning(warning: { readonly phase: string; readonly message: string }): void;
  recordSessionEvent(event: ConfiguredAgentSessionEvent, coreConfig: MonoAgentConfig): void;
}

export async function buildResponder(controller: ResponderControllerPort, coreConfig: MonoAgentConfig): Promise<AgentResponder> {
  const sandboxEngine = controller.sandboxEngineFor(coreConfig);
  const runtime = controller.runtime ?? createConfiguredAgentRuntime({
    config: coreConfig,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
  });
  if (!controller.activeRuntimes.includes(runtime)) {
    controller.activeRuntimes.push(runtime);
  }
  const memoryBackend = await controller.memoryStore(coreConfig);
  const memoryRetrieval = controller.ensureSharedMemoryRetrieval(coreConfig, memoryBackend);
  const memory = memoryRetrieval ?? memoryBackend;
  const memoryRecallEnabled = controller.reportMemoryRecallStatus(coreConfig, memoryRetrieval);
  const supermemoryMcp = controller.supermemoryMcpRuntimeOptions(coreConfig);
  const adapterSendTools = await controller.adapterSendToolsRuntimeOptions(coreConfig);
  const runHistoryBase = isRunHistoryToolAllowed(coreConfig.tools)
    && !runtimeRouteContainsDirectOpenCode(coreConfig)
    ? createRunHistoryRuntimeExtension({
        artifactDir: coreConfig.artifacts.dir,
        ...(coreConfig.runtime.session.rollover === undefined
          ? {}
          : { rollover: coreConfig.runtime.session.rollover }),
        onUnavailable: (error) => {
          controller.logger?.warn?.("RunHistory tool endpoint could not start; continuing without prior-run inspection.", {
            reason: reasonOf(error),
          });
        },
      })
    : undefined;
  // Always active: a no-op for interactive turns (which carry no cron/webhook
  // metadata), it applies the per-trigger model/effort override otherwise.
  const mcpSources: string[] = [];
  if (coreConfig.tools.mcpConfigPath !== undefined) {
    try {
      const names = Object.keys(loadToolPolicyFromJsonFileSync(coreConfig.tools.mcpConfigPath).mcpServers ?? {});
      if (names.length > 0) mcpSources.push(`tools.mcpConfigPath (${names.join(", ")})`);
    } catch {
      // Responder construction owns the missing/malformed policy error.
    }
  }
  if (memoryRecallEnabled) mcpSources.push("memory.recallTool");
  if (supermemoryMcp !== undefined) mcpSources.push("memory.supermemory.exposeMcpServer");
  if (adapterSendTools.blockingToolNames.length > 0) {
    mcpSources.push(`adapter send tools (${adapterSendTools.blockingToolNames.join(", ")})`);
  }
  const requestModelOverride = controller.requestModelOverrideRuntimeOptions(coreConfig, {
    mcpSources,
    indexSkillsActive: coreConfig.context.skillDisclosure === "index"
      && coreConfig.context.skillsRoot !== undefined,
  });
  const adapterSendToolsExtension = adapterSendTools.createExtension?.(
    requestModelOverride.targetsDirectOpenCode,
  );
  const runHistoryExtension: RuntimeOptionsExtension | undefined = runHistoryBase === undefined
    ? undefined
    : async (requestInput) => requestModelOverride.targetsDirectOpenCode(requestInput.request.metadata)
      ? { runtimeOptions: {}, cleanup: async () => {} }
      : await runHistoryBase(requestInput);
  const localConfigurationExtension = createLocalConfigurationRuntimeExtension({
    cwd: controller.cwd,
    configPath: controller.configPath,
    configReadPath: controller.configReadPath,
    env: controller.env,
  });
  const runtimeOptionsForRequest = composeRuntimeOptionExtensions([
    supermemoryMcp,
    runHistoryExtension,
    adapterSendToolsExtension,
    requestModelOverride.extension,
    // Last and authoritative: only an opaque owner-created configuration
    // session can replace the daemon's ordinary action/MCP surface.
    localConfigurationExtension,
  ]);
  // The override factory is only needed when fallbacks are configured: the
  // fallback router freezes the model chain, so an override must run on a runtime
  // whose chain has it as primary. With no fallbacks the shared (plain) runtime
  // honors the per-run model directly, so building a separate runtime would be
  // redundant. Omit the factory there and the harness uses the shared runtime.
  const runtimeForModel = hasConfiguredRuntimeFallbacks(coreConfig.runtime)
    ? controller.buildRuntimeForModel(coreConfig)
    : undefined;
  const observabilityContext = await controller.observabilityContext();
  const postedReplyHistory = createSlackPostedReplyHistory({
    maxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    ...(coreConfig.runtime.session.rollover === undefined
      ? {}
      : { rollover: coreConfig.runtime.session.rollover }),
    ...(coreConfig.runtime.session.rolloverTimezone === undefined
      ? {}
      : { rolloverTimezone: coreConfig.runtime.session.rolloverTimezone }),
  });
  const responder = await createConfiguredAgentResponderForApp({
    config: coreConfig,
    cwd: controller.cwd,
    runtime,
    ...(runtimeForModel === undefined ? {} : { runtimeForModel }),
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    ...(memory !== undefined && { memory }),
    ...(controller.interactionBridge === undefined ? {} : { turnHistoryEnricher: controller.interactionBridge }),
    ...(controller.interactionBridge === undefined ? {} : { progressCapabilityIssuer: controller.interactionBridge }),
    ...(controller.continuationService === undefined
      ? {}
      : { continuationCapabilityIssuer: controller.continuationService }),
    ...(runtimeOptionsForRequest === undefined ? {} : { runtimeOptionsForRequest }),
    onMemoryRecallUnavailable: (error) => {
      controller.logger?.warn?.(
        "MemoryRecall tool endpoint could not start; continuing without the explicit tool.",
        { error: reasonOf(error) },
      );
    },
    onMemoryWarning: (message) => {
      controller.logger?.warn?.(message);
    },
    // Thread run-identifying context onto exported spans and surface per-run
    // export warnings to `exporterStatus` (agent-host only builds the exporter
    // when config.observability.exporters is non-empty).
    observabilityContext,
    exporterWarn: (warning) => controller.recordExporterWarning(warning),
    onSessionEvent: (event) => controller.recordSessionEvent(event, coreConfig),
  }, {
    wrapHistoryStore: postedReplyHistory.wrapHistoryStore,
    // Follow the local JSONL source of truth, not outer exporter work:
    // exporter start/finish may still be pending after the summary commits.
    onRunArtifactCommitted: ({ conversationId }) => {
      if (isNotifyDestinationConversationId(conversationId)) {
        controller.seenNotifyDestinations.invalidate();
      }
    },
  });
  return postedReplyHistory.wrapResponder(responder);
}

export function requestModelOverrideRuntimeOptions(
  controller: ResponderControllerPort,
  coreConfig: MonoAgentConfig,
  compatibility: { readonly mcpSources: readonly string[]; readonly indexSkillsActive: boolean },
): {
  readonly extension: RuntimeOptionsExtension;
  readonly targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean;
} {
  const options = {
    ...(controller.logger === undefined ? {} : { logger: controller.logger }),
    baseModel: coreConfig.runtime.model,
    ...(configuredRuntimeFallbackModels(coreConfig.runtime).length === 0
      ? {}
      : { fallbackModels: configuredRuntimeFallbackModels(coreConfig.runtime) }),
    ...(coreConfig.runtime.effort === undefined ? {} : { baseEffort: coreConfig.runtime.effort }),
    ...(coreConfig.runtime.maxTurns === undefined ? {} : { baseMaxTurns: coreConfig.runtime.maxTurns }),
    ...(compatibility.mcpSources.length === 0 ? {} : { mcpSources: compatibility.mcpSources }),
    ...(compatibility.indexSkillsActive ? { indexSkillsActive: true } : {}),
    ...(coreConfig.sandbox === undefined ? {} : { sandboxPolicy: coreConfig.sandbox }),
    toolPolicy: coreConfig.tools,
    ...(coreConfig.providers?.local === undefined ? {} : { localProviders: coreConfig.providers.local }),
  };
  const extension = createRequestModelOverrideRuntimeExtension(options);
  return {
    extension: async (input) => extension({ request: input.request }),
    targetsDirectOpenCode: (metadata) => requestModelOverrideTargetsDirectOpenCode(metadata, options),
  };
}

export function buildRuntimeForModel(
  controller: ResponderControllerPort,
  coreConfig: MonoAgentConfig,
): (model: RuntimeModelReference, executionMode?: string) => MonoRuntimeLike {
  const cache = new Map<string, MonoRuntimeLike>();
  const sandboxEngine = controller.sandboxEngineFor(coreConfig);
  return (model, executionMode) => {
    const key = `${modelReferenceKey(model)}|${executionMode ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const runtime = createConfiguredAgentRuntime({
      config: coreConfig,
      model,
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    });
    cache.set(key, runtime);
    controller.activeRuntimes.push(runtime);
    return runtime;
  };
}

export function supermemoryMcpRuntimeOptions(controller: ResponderControllerPort, coreConfig: MonoAgentConfig): RuntimeOptionsExtension | undefined {
  const memory = coreConfig.memory;
  if (memory?.backend !== "supermemory" || memory.supermemory?.exposeMcpServer !== true) {
    return undefined;
  }
  const apiKey = memory.supermemory.apiKey;
  if (apiKey === undefined) {
    controller.logger?.warn?.(
      "memory.supermemory.exposeMcpServer is on but no apiKey is set; the hosted Supermemory MCP server (cloud-only) was not injected.",
    );
    return undefined;
  }
  controller.logger?.info?.("Supermemory hosted MCP server injected (cloud-only).");
  const entry = {
    supermemory: {
      type: "http",
      url: "https://mcp.supermemory.ai/mcp",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  };
  return async () => ({ runtimeOptions: { mcpServers: entry }, cleanup: async () => {} });
}

export async function adapterSendToolsRuntimeOptions(controller: ResponderControllerPort, coreConfig: MonoAgentConfig): Promise<{
  readonly createExtension?: (
    targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
  ) => RuntimeOptionsExtension;
  readonly blockingToolNames: readonly string[];
}> {
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
  const bridgeEnv = controller.interactionBridge?.env();
  const appOwnedInteraction = controller.interactionBridge === undefined || bridgeEnv === undefined
    ? undefined
    : {
        bridgeUrl: controller.interactionBridge.url,
        bridgeToken: controller.interactionBridge.token,
        timeoutMs: Number(bridgeEnv.MONO_AGENT_ASK_USER_TIMEOUT_MS),
      };
  const settings = await resolveAdapterSendToolsSettings(input, {
    allowedTools: coreConfig.tools.allowedTools,
    disallowedTools: coreConfig.tools.disallowedTools,
    logger: controller.logger,
    suppressInteractionTools: runtimeRouteContainsDirectOpenCode(coreConfig),
    ...(appOwnedInteraction === undefined ? {} : { interaction: appOwnedInteraction }),
  });
  if (settings === undefined) {
    return { blockingToolNames: [] };
  }
  const toolNames = adapterSendToolNames(settings);
  const blockingToolNames = toolNames.filter((name) => !isInteractionToolName(name));
  controller.logger?.info?.("Adapter send tools enabled.", { tools: toolNames });
  // Forward the posted-message index path so `SlackSendMessage` links each post
  // back to the producing conversation (so a later in-thread reply resumes it).
  const indexPath = resolvePostedMessageIndexPath(await resolveAppArtifactDir(input));
  const interactionForChild = settings.askUser;
  const runOutputRoot = settings.telegram?.sendTools?.pathScope === "run-output"
    ? resolve(coreConfig.artifacts.dir, "outbound")
    : undefined;
  const createExtension = (
    targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
  ): RuntimeOptionsExtension => async (requestInput) => {
    const effectiveToolNames = targetsDirectOpenCode(requestInput.request.metadata)
      ? toolNames.filter((name) => !isInteractionToolName(name))
      : toolNames;
    if (effectiveToolNames.length === 0) {
      return { runtimeOptions: {}, cleanup: async () => {} };
    }
    const effectiveInteraction = effectiveToolNames.some(isInteractionToolName)
      ? interactionForChild
      : undefined;
    return await createAdapterSendToolsRuntimeExtension(
      controller.configReadPath,
      controller.cwd,
      effectiveToolNames,
      indexPath,
      effectiveInteraction,
      runOutputRoot,
      controller.interactionBridge,
    )(requestInput);
  };
  return { createExtension, blockingToolNames };
}

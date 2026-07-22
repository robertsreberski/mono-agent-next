import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  TuiAdapterConfig,
  TuiAdapterInfo,
  TuiAdapterOptions,
  TuiAdapterStartResult,
} from "@mono-agent/operator-adapter";
import {
  discoverLocalProviderModels,
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  resolveModelEffortLevels,
} from "@mono-agent/runtime-adapter";
import type {
  DiscoveredLocalModel,
  LocalProviderDefinition,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

import { buildChannelConfigView } from "../channel-config-view.js";
import type { ChannelDriver } from "../channels.js";
import { configuredRuntimeModels } from "../runtime-routes.js";

type TuiAdapterModule = typeof import("@mono-agent/operator-adapter");

let tuiModule: TuiAdapterModule | undefined;
const loadTuiModule = async (): Promise<TuiAdapterModule> =>
  (tuiModule ??= await import("@mono-agent/operator-adapter"));

/** `/v1/info` local-provider discovery cache lifetime. */
const LOCAL_MODEL_DISCOVERY_TTL_MS = 30_000;

const builtinModelCatalog = builtinModels();

function positiveContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function resolveContextWindow(
  ref: RuntimeModelReference,
  providers: readonly LocalProviderDefinition[] | undefined,
): number | undefined {
  if (ref.sdk === "codex") {
    return positiveContextWindow(
      builtinModelCatalog.getModel("openai-codex", ref.model)?.contextWindow,
    );
  }
  if (ref.sdk !== "pi" || ref.provider === undefined) return undefined;

  const configuredProvider = providers?.find((provider) => provider.id === ref.provider);
  if (configuredProvider !== undefined) {
    const configuredModel = configuredProvider.models
      ?.find((model) => model.name === ref.model || model.alias === ref.model);
    return positiveContextWindow(configuredModel?.capabilities?.context_window)
      ?? positiveContextWindow(configuredModel?.capabilities?.num_ctx);
  }

  return positiveContextWindow(
    builtinModelCatalog.getModel(ref.provider, ref.model)?.contextWindow,
  );
}

export interface TuiChannelOverrides {
  readonly adapterFactory?: (options: TuiAdapterOptions) => Promise<TuiAdapterStartResult>;
  /** Test seam: replaces the real local-provider model discovery call. */
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
}

/**
 * The TUI stream endpoint deviates from the channels-off convention: with no
 * `tui` section it is enabled on loopback with an ephemeral port. An explicit
 * `"tui": {"enabled": false}` opts out.
 */
export function createTuiChannelDriver(
  overrides: TuiChannelOverrides = {},
): ChannelDriver<TuiAdapterConfig> {
  return {
    id: "tui",
    label: "TUI",
    async configView(input) {
      const adapter = await loadTuiModule();
      return await buildChannelConfigView(this, adapter.TUI_CONFIG_FIELDS, input, { jsonKey: "tui" });
    },
    async loadConfig(input) {
      const adapter = await loadTuiModule();
      return await adapter.loadTuiAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return tuiModule !== undefined && error instanceof tuiModule.TuiAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "TUI stream endpoint is disabled.";
    },
    async start(input) {
      const adapterModule = await loadTuiModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startTuiAdapter;
      const discoverModels = overrides.discoverModels ?? discoverLocalProviderModels;
      const localProviders = input.coreConfig.providers?.local;

      const configModelKeys: string[] = [];
      for (const ref of configuredRuntimeModels(input.coreConfig.runtime)) {
        const key = modelReferenceKey(ref);
        if (!configModelKeys.includes(key)) {
          configModelKeys.push(key);
        }
      }

      let discoveryCache: { readonly expiresAt: number; readonly models: readonly DiscoveredLocalModel[] } | undefined;
      const discoverModelsCached = async (): Promise<readonly DiscoveredLocalModel[]> => {
        const now = Date.now();
        if (discoveryCache !== undefined && now < discoveryCache.expiresAt) {
          return discoveryCache.models;
        }
        const models = await discoverModels(localProviders);
        discoveryCache = { expiresAt: now + LOCAL_MODEL_DISCOVERY_TTL_MS, models };
        return models;
      };

      const buildInfo = async (): Promise<TuiAdapterInfo> => {
        const discovered = await discoverModelsCached();
        const labelByRef = new Map(discovered.map((model) => [model.ref, model.label]));
        const models = [...configModelKeys];
        for (const model of discovered) {
          if (!models.includes(model.ref)) {
            models.push(model.ref);
          }
        }

        const modelOptions: Record<string, {
          effortLevels?: readonly string[];
          reasoning?: boolean;
          reasoningMode?: string;
          label?: string;
          contextWindow?: number;
        }> = {};
        for (const ref of models) {
          let parsedRef;
          try {
            parsedRef = parseMonoRuntimeModelReference(ref);
          } catch {
            continue;
          }
          const resolved = resolveModelEffortLevels(parsedRef, localProviders);
          const contextWindow = resolveContextWindow(parsedRef, localProviders);
          const label = labelByRef.get(ref);
          const entry = {
            ...(resolved.effortLevels === undefined ? {} : { effortLevels: resolved.effortLevels }),
            reasoning: resolved.reasoning,
            ...(resolved.reasoningMode === undefined ? {} : { reasoningMode: resolved.reasoningMode }),
            ...(label === undefined ? {} : { label }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
          };
          if (Object.keys(entry).length > 0) {
            modelOptions[ref] = entry;
          }
        }

        return {
          model: modelReferenceKey(input.coreConfig.runtime.model),
          ...(input.coreConfig.runtime.effort === undefined ? {} : { effort: input.coreConfig.runtime.effort }),
          models,
          ...(Object.keys(modelOptions).length === 0 ? {} : { modelOptions }),
        };
      };

      if (input.interaction !== undefined) {
        input.interaction.registerSink("web", {
          presentAsk: async () => undefined,
          updateAsk: async () => undefined,
          postStatus: async () => undefined,
        });
      }
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        responder: input.responder,
        ...(input.interaction === undefined ? {} : { interaction: input.interaction }),
        info: buildInfo,
        onServerError: (reason) => input.onFailure(reason),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { baseUrl: adapter.baseUrl },
        stop: () => adapter.stop(),
      };
    },
  };
}

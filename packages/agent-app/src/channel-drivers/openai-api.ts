import type {
  OpenAIApiAdapterConfig,
  OpenAIApiAdapterOptions,
  OpenAIApiAdapterStartResult,
} from "@mono-agent/openai-api-adapter";

import { buildChannelConfigView } from "../channel-config-view.js";
import { isChannelConfigured } from "../channel-gate.js";
import type { ChannelGateSpec } from "../channel-gate.js";
import type { ChannelDriver } from "../channels.js";
import { unconfiguredChannelView } from "./shared.js";

type OpenAIApiAdapterModule = typeof import("@mono-agent/openai-api-adapter");

let openaiApiModule: OpenAIApiAdapterModule | undefined;
const loadOpenAIApiModule = async (): Promise<OpenAIApiAdapterModule> =>
  (openaiApiModule ??= await import("@mono-agent/openai-api-adapter"));

const OPENAI_API_GATE: ChannelGateSpec = { jsonKey: "openaiApi", envPrefix: "MONO_AGENT_OPENAI_API_" };
const UNCONFIGURED_OPENAI_API_CONFIG: OpenAIApiAdapterConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 0,
  basePath: "/v1",
  allowNonLoopback: false,
  modelId: "agent",
};

export interface OpenAIApiChannelOverrides {
  readonly adapterFactory?: (options: OpenAIApiAdapterOptions) => Promise<OpenAIApiAdapterStartResult>;
}

export function createOpenAIApiChannelDriver(
  overrides: OpenAIApiChannelOverrides = {},
): ChannelDriver<OpenAIApiAdapterConfig> {
  return {
    id: "openai-api",
    label: "OpenAI API",
    async configView(input) {
      if (!(await isChannelConfigured(input, OPENAI_API_GATE))) {
        return unconfiguredChannelView("openai-api", "OpenAI API");
      }
      const adapter = await loadOpenAIApiModule();
      return await buildChannelConfigView(this, adapter.OPENAI_API_CONFIG_FIELDS, input, { jsonKey: "openaiApi" });
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, OPENAI_API_GATE))) {
        return UNCONFIGURED_OPENAI_API_CONFIG;
      }
      const adapter = await loadOpenAIApiModule();
      return await adapter.loadOpenAIApiAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return openaiApiModule !== undefined && error instanceof openaiApiModule.OpenAIApiAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "OpenAI API adapter is disabled.";
    },
    async start(input) {
      const adapterModule = await loadOpenAIApiModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startOpenAIApiAdapter;
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        modelId: input.config.modelId,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      const baseUrls = adapter.baseUrls ?? [adapter.baseUrl];
      return {
        summary: {
          baseUrl: adapter.baseUrl,
          ...(baseUrls.length > 1 ? { baseUrls } : {}),
        },
        stop: () => adapter.stop(),
      };
    },
  };
}

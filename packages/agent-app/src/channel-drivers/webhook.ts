import type {
  WebhookAdapterConfig,
  WebhookAdapterOptions,
  WebhookAdapterStartResult,
} from "@mono-agent/webhook-adapter";

import { buildChannelConfigView } from "../channel-config-view.js";
import { isChannelConfigured } from "../channel-gate.js";
import type { ChannelGateSpec } from "../channel-gate.js";
import type { ChannelDriver } from "../channels.js";
import { findTriggerOverrideIssues } from "../trigger-overrides.js";
import { deliverNativeWebhookNotification, inferUniqueNotifyDestination } from "./native-notify.js";
import { unconfiguredChannelView } from "./shared.js";

type WebhookAdapterModule = typeof import("@mono-agent/webhook-adapter");

let webhookModule: WebhookAdapterModule | undefined;
const loadWebhookModule = async (): Promise<WebhookAdapterModule> =>
  (webhookModule ??= await import("@mono-agent/webhook-adapter"));

const WEBHOOK_GATE: ChannelGateSpec = { jsonKey: "webhook", envPrefix: "MONO_AGENT_WEBHOOK_", dir: "webhook" };
const UNCONFIGURED_WEBHOOK_CONFIG: WebhookAdapterConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 0,
  allowNonLoopback: false,
  retentionMs: 300_000,
  maxStoredRequests: 100,
  endpoints: [{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }],
  path: "/webhook/invoke",
  defaultMode: "sync",
};

export interface WebhookChannelOverrides {
  readonly adapterFactory?: (options: WebhookAdapterOptions) => Promise<WebhookAdapterStartResult>;
}

const DEFAULT_WEBHOOK_MAX_RUN_MS = 20 * 60 * 1000;

export function createWebhookChannelDriver(
  overrides: WebhookChannelOverrides = {},
): ChannelDriver<WebhookAdapterConfig> {
  return {
    id: "webhook",
    label: "Webhook",
    async configView(input) {
      if (!(await isChannelConfigured(input, WEBHOOK_GATE))) {
        return unconfiguredChannelView("webhook", "Webhook");
      }
      const adapter = await loadWebhookModule();
      return await buildChannelConfigView(this, adapter.WEBHOOK_CONFIG_FIELDS, input);
    },
    configIssues(config) {
      return findTriggerOverrideIssues(
        config.endpoints
          .filter((endpoint) => endpoint.enabled)
          .map((endpoint) => ({
            name: `webhook endpoint "${endpoint.name}"`,
            ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
            ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
          })),
      );
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, WEBHOOK_GATE))) {
        return UNCONFIGURED_WEBHOOK_CONFIG;
      }
      const adapter = await loadWebhookModule();
      return await adapter.loadWebhookAdapterConfig({ env: input.env, jsonPath: input.configPath, cwd: input.cwd });
    },
    isConfigError(error) {
      return webhookModule !== undefined && error instanceof webhookModule.WebhookAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Webhook adapter is disabled.";
    },
    waitingReason(config) {
      return config.endpoints.some((endpoint) => endpoint.enabled)
        ? undefined
        : "Webhook adapter has no enabled endpoints.";
    },
    async start(input) {
      const endpoints = input.config.endpoints.filter((endpoint) => endpoint.enabled);
      const endpointByName = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint]));
      const listNotifyDestinations = input.listNotifyDestinations;
      const resolveNotifyFallbackConversationId = listNotifyDestinations === undefined
        ? undefined
        : async (abortSignal?: AbortSignal) => await inferUniqueNotifyDestination({
            listNotifyDestinations,
            ...(abortSignal === undefined ? {} : { abortSignal }),
          });
      const adapterModule = await loadWebhookModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startWebhookAdapter;
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        defaultMode: input.config.defaultMode,
        retentionMs: input.config.retentionMs,
        maxStoredRequests: input.config.maxStoredRequests,
        maxRunMs: input.config.maxRunMs ?? DEFAULT_WEBHOOK_MAX_RUN_MS,
        endpoints: endpoints.map((endpoint) => ({
          name: endpoint.name,
          path: endpoint.path,
          mode: endpoint.mode,
          ...(endpoint.prompt === undefined ? {} : { prompt: endpoint.prompt }),
          ...(endpoint.notify === undefined ? {} : { notify: endpoint.notify }),
          ...(endpoint.notifyConversationId === undefined ? {} : { notifyConversationId: endpoint.notifyConversationId }),
          ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
          ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
          ...(endpoint.maxRunMs === undefined ? {} : { maxRunMs: endpoint.maxRunMs }),
        })),
        responder: input.responder,
        ...(resolveNotifyFallbackConversationId === undefined ? {} : { resolveNotifyFallbackConversationId }),
        onResult: (status, request) => {
          void deliverNativeWebhookNotification({
            endpoint: endpointByName.get(request.metadata.webhook.endpointName),
            status,
            request,
            ...(input.notifyDestination === undefined ? {} : { notifyDestination: input.notifyDestination }),
            ...(input.logger === undefined ? {} : { logger: input.logger }),
          });
        },
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: {
          invokeUrl: adapter.invokeUrl,
          port: adapter.port,
          invokeUrls: Object.fromEntries((adapter.endpoints ?? []).map((endpoint) => [endpoint.name, endpoint.invokeUrl])),
        },
        stop: () => adapter.stop(),
      };
    },
  };
}

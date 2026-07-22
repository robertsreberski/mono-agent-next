import type { AgentContinuationOriginContext, ChannelInteractionSink } from "@mono-agent/agent-contracts";
import { AgentHarnessFailureError } from "@mono-agent/agent-harness";
import type {
  SlackAdapterConfig,
  SlackAdapterStartOptions,
  SlackAdapterStartResult,
  SlackRuntimeControls,
} from "@mono-agent/slack-adapter";

import { buildChannelConfigView } from "../channel-config-view.js";
import { buildChannelRuntimeControls } from "../channel-runtime-controls.js";
import { isChannelConfigured } from "../channel-gate.js";
import type { ChannelGateSpec } from "../channel-gate.js";
import type { ChannelDriver, ContinuationChannelSynthesisResult } from "../channels.js";
import {
  appendPostedMessage,
  compactPostedMessageIndex,
  lookupProducingConversation,
} from "../posted-message-index.js";
import { unconfiguredChannelView } from "./shared.js";

type SlackAdapterModule = typeof import("@mono-agent/slack-adapter");

let slackModule: SlackAdapterModule | undefined;
const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/slack-adapter"));

const SLACK_GATE: ChannelGateSpec = { jsonKey: "slack", envPrefix: "MONO_AGENT_SLACK_" };
const UNCONFIGURED_SLACK_CONFIG: SlackAdapterConfig = {
  enabled: false,
  botToken: "",
  appToken: "",
  allowedChannelIds: [],
  allowAllChannels: false,
  botUserIds: [],
  mentionTextAliases: [],
  stripMentionText: false,
  shortcuts: [],
  homeTab: { enabled: false, buttons: [] },
};

export interface SlackChannelOverrides {
  readonly createApi?: SlackAdapterStartOptions["createApi"];
  readonly webSocketFactory?: SlackAdapterStartOptions["webSocketFactory"];
  readonly startAdapter?: (options: SlackAdapterStartOptions) => Promise<SlackAdapterStartResult>;
}

export function createSlackChannelDriver(
  overrides: SlackChannelOverrides = {},
): ChannelDriver<SlackAdapterConfig> {
  return {
    id: "slack",
    label: "Slack",
    async configView(input) {
      if (!(await isChannelConfigured(input, SLACK_GATE))) {
        return unconfiguredChannelView("slack", "Slack");
      }
      const adapter = await loadSlackModule();
      return await buildChannelConfigView(this, adapter.SLACK_CONFIG_FIELDS, input);
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, SLACK_GATE))) {
        return UNCONFIGURED_SLACK_CONFIG;
      }
      const adapter = await loadSlackModule();
      return await adapter.loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return slackModule !== undefined && error instanceof slackModule.SlackAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Slack is disabled.";
    },
    async start(input) {
      const adapter = await loadSlackModule();
      const startAdapter = overrides.startAdapter ?? adapter.startSlackAdapter;
      const indexPath = input.postedMessageIndexPath;
      // Run the exported maintenance path at the real Slack-driver lifecycle seam.
      // This is local, best-effort filesystem work and completes before the
      // adapter opens any remote transport.
      if (indexPath !== undefined) {
        await compactPostedMessageIndex(indexPath);
      }
      const reconnect: {
        initialMs?: number;
        maxMs?: number;
        stabilityMs?: number;
        startupGraceMs?: number;
        drainDeadlineMs?: number;
      } = {};
      if (input.config.reconnectInitialBackoffMs !== undefined) reconnect.initialMs = input.config.reconnectInitialBackoffMs;
      if (input.config.reconnectMaxBackoffMs !== undefined) reconnect.maxMs = input.config.reconnectMaxBackoffMs;
      if (input.config.reconnectStabilityMs !== undefined) reconnect.stabilityMs = input.config.reconnectStabilityMs;
      if (input.config.reconnectStartupGraceMs !== undefined) reconnect.startupGraceMs = input.config.reconnectStartupGraceMs;
      if (input.config.drainDeadlineMs !== undefined) reconnect.drainDeadlineMs = input.config.drainDeadlineMs;
      const heartbeat: { intervalMs?: number; timeoutMs?: number } = {};
      if (input.config.heartbeatIntervalMs !== undefined) heartbeat.intervalMs = input.config.heartbeatIntervalMs;
      if (input.config.heartbeatTimeoutMs !== undefined) heartbeat.timeoutMs = input.config.heartbeatTimeoutMs;
      const result = await startAdapter({
        botToken: input.config.botToken,
        appToken: input.config.appToken,
        allowedChannelIds: input.config.allowedChannelIds,
        allowAllChannels: input.config.allowAllChannels,
        botUserIds: input.config.botUserIds,
        mentionTextAliases: input.config.mentionTextAliases,
        stripMentionText: input.config.stripMentionText,
        shortcuts: input.config.shortcuts,
        homeTab: input.config.homeTab,
        ...(input.coreConfig?.runtime === undefined
          ? {}
          : {
              runtimeControls:
                buildChannelRuntimeControls(input.coreConfig) satisfies SlackRuntimeControls,
            }),
        responder: input.responder,
        onConnectionLost: (reason) => input.onDegraded?.(reason),
        onConnectionRestored: () => input.onRecovered?.(),
        ...(Object.keys(reconnect).length === 0 ? {} : { reconnect }),
        ...(Object.keys(heartbeat).length === 0 ? {} : { heartbeat }),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        ...(input.interaction === undefined
          ? {}
          : {
              pendingAsks: {
                getPendingAsk: (conversationId: string) => input.interaction!.getPendingAsk(conversationId),
                submitAskAnswers: (submission) => input.interaction!.submitAskAnswers(submission),
                cancel: (conversationId: string) => input.interaction!.cancelAsks(conversationId),
              },
            }),
        ...(indexPath === undefined
          ? {}
          : {
              resolvePostIndex: (channelId: string, ts: string) =>
                lookupProducingConversation(indexPath, channelId, ts),
              recordPostedMessage: (channelId: string, ts: string, conversationId: string) => {
                void appendPostedMessage(indexPath, { channelId, ts, conversationId });
              },
            }),
        ...(overrides.createApi === undefined ? {} : { createApi: overrides.createApi }),
        ...(overrides.webSocketFactory === undefined ? {} : { webSocketFactory: overrides.webSocketFactory }),
      });
      const statusMessages = new Map<string, { readonly channelId: string; readonly ts: string }>();
      const interactionSink: ChannelInteractionSink = {
        presentAsk: async (conversationId, snapshot) => {
          const target = requireAllowedSlackTarget(conversationId, input.config);
          await result.adapter.presentAsk(target.channelId, target.threadTs, snapshot);
        },
        updateAsk: async (conversationId, snapshot) => {
          const target = requireAllowedSlackTarget(conversationId, input.config);
          await result.adapter.updateAsk(target.channelId, snapshot);
        },
        postStatus: async (conversationId, text, statusOptions) => {
          const target = requireAllowedSlackTarget(conversationId, input.config);
          const key = `${conversationId}:${statusOptions.key}`;
          const existing = statusMessages.get(key);
          if (existing === undefined) {
            const sent = await result.api.chatPostMessage({
              channel: target.channelId,
              text,
              ...(target.threadTs === undefined ? {} : { thread_ts: target.threadTs }),
            });
            statusMessages.set(key, { channelId: sent.channel, ts: sent.ts });
          } else {
            await result.api.chatUpdate({ channel: existing.channelId, ts: existing.ts, text });
          }
          if (statusOptions.state !== "working") statusMessages.delete(key);
        },
      };
      input.interaction?.registerSink("slack", interactionSink);
      return {
        summary: {},
        stop: () => result.stop(),
        notify: async (request) => {
          const { conversationId, text, verbatim, deliveryKey } = request;
          const target = slackTargetFromConversation(conversationId);
          if (target === undefined) {
            input.logger?.warn?.("Slack proactive notify skipped: unparseable destination.", { conversationId });
            return { delivered: false, reason: "unparseable slack destination" };
          }
          const normalized = target.channelId.trim().toLowerCase();
          const allowed = input.config.allowAllChannels
            || input.config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized);
          if (!allowed) {
            input.logger?.warn?.("Slack proactive notify skipped: destination not in allowlist.", { conversationId });
            return { delivered: false, reason: "slack channel is not in the adapter allowlist" };
          }
          return await result.adapter.notify(
            target.channelId,
            target.threadTs,
            text,
            verbatim === undefined && deliveryKey === undefined
              ? undefined
              : {
                  ...(verbatim === undefined ? {} : { verbatim }),
                  ...(deliveryKey === undefined ? {} : { deliveryKey }),
                },
          );
        },
        synthesizeContinuation: async (continuationInput: {
          readonly continuationId: string;
          readonly originRunId: string;
          readonly historyBoundary?: string;
          readonly originContextPolicy: "pinned" | "detached_latest";
          readonly originContext?: AgentContinuationOriginContext;
          readonly originConversationId: string;
          readonly replyToConversationId: string;
          readonly prompt: string;
        }) => {
          const target = slackTargetFromConversation(continuationInput.replyToConversationId);
          if (target === undefined) throw new Error("Unparseable Slack continuation destination.");
          const normalized = target.channelId.trim().toLowerCase();
          const allowed = input.config.allowAllChannels
            || input.config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized);
          if (!allowed) throw new Error("Slack continuation destination is not in the adapter allowlist.");
          try {
            const continuation = continuationInput.originContextPolicy === "pinned"
              ? (() => {
                  if (continuationInput.historyBoundary === undefined || continuationInput.originContext === undefined) {
                    throw new Error("Pinned Slack continuation input is missing its immutable origin context.");
                  }
                  return {
                    continuationId: continuationInput.continuationId,
                    originRunId: continuationInput.originRunId,
                    historyBoundary: continuationInput.historyBoundary,
                    originContextPolicy: "pinned" as const,
                    originContext: continuationInput.originContext,
                    toolsDisabled: true as const,
                    deferHistoryCommit: true as const,
                  };
                })()
              : {
                  continuationId: continuationInput.continuationId,
                  originRunId: continuationInput.originRunId,
                  originContextPolicy: "detached_latest" as const,
                  toolsDisabled: true as const,
                  deferHistoryCommit: true as const,
                };
            const text = await result.adapter.synthesizeContinuation({
              conversationId: continuationInput.originConversationId,
              replyToConversationId: continuationInput.replyToConversationId,
              channelId: target.channelId,
              ...(target.threadTs === undefined ? {} : { threadTs: target.threadTs }),
              prompt: continuationInput.prompt,
              continuation,
            });
            return { kind: "synthesized", text } satisfies ContinuationChannelSynthesisResult;
          } catch (error) {
            if (error instanceof adapter.SerialQueueFullError) {
              return {
                kind: "unavailable",
                code: "destination_queue_full",
                reason: error.message,
                retryAfterMs: 1_000,
              } satisfies ContinuationChannelSynthesisResult;
            }
            if (error instanceof AgentHarnessFailureError && error.failure.kind === "history_boundary_not_found") {
              return {
                kind: "unavailable",
                code: "origin_history_not_ready",
                reason: "The originating run has not committed its continuation history boundary yet.",
                retryAfterMs: 1_000,
              } satisfies ContinuationChannelSynthesisResult;
            }
            throw error;
          }
        },
        recordContinuationHistory: async (continuationInput: {
          readonly conversationId: string;
          readonly text: string;
          readonly deliveryKey: string;
        }) => {
          const target = slackTargetFromConversation(continuationInput.conversationId);
          if (target === undefined) return { recorded: false as const, code: "unparseable_slack_destination" };
          const normalized = target.channelId.trim().toLowerCase();
          const allowed = input.config.allowAllChannels
            || input.config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized);
          if (!allowed) return { recorded: false as const, code: "slack_destination_not_allowlisted" };
          return await result.adapter.recordContinuationHistory(
            continuationInput.conversationId,
            continuationInput.text,
            continuationInput.deliveryKey,
          );
        },
      };
    },
  };
}

/** Extract `{channelId, threadTs?}` from a `slack:<ch>[:<thread>]` conversation id. */
export function slackTargetFromConversation(
  conversationId: string,
): { readonly channelId: string; readonly threadTs?: string } | undefined {
  const prefix = "slack:";
  if (!conversationId.startsWith(prefix)) {
    return undefined;
  }
  const rest = conversationId.slice(prefix.length).split("#", 1)[0];
  if (rest === undefined || rest.length === 0) {
    return undefined;
  }
  const colon = rest.indexOf(":");
  if (colon < 0) {
    const channelId = rest.trim();
    return channelId.length === 0 ? undefined : { channelId };
  }
  const channelId = rest.slice(0, colon).trim();
  const threadTs = rest.slice(colon + 1).trim();
  if (channelId.length === 0) {
    return undefined;
  }
  if (threadTs.length === 0) {
    return { channelId };
  }
  if (threadTs.includes(":")) {
    return undefined;
  }
  return { channelId, threadTs };
}

function requireAllowedSlackTarget(
  conversationId: string,
  config: SlackAdapterConfig,
): { readonly channelId: string; readonly threadTs?: string } {
  const target = slackTargetFromConversation(conversationId);
  if (target === undefined) throw new Error(`unparseable Slack destination: ${conversationId}`);
  const normalized = target.channelId.trim().toLowerCase();
  if (!config.allowAllChannels && !config.allowedChannelIds.some((id) => id.trim().toLowerCase() === normalized)) {
    throw new Error("Slack channel is not in the adapter allowlist.");
  }
  return target;
}

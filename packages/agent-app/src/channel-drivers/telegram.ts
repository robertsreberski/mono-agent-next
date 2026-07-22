import type { ChannelInteractionSink } from "@mono-agent/agent-contracts";
import { describeRunFailureKind } from "@mono-agent/observability";
import type {
  TelegramAdapterConfig,
  TelegramAdapterErrorTextInput,
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
  TelegramChatId,
  TelegramTranscriptionConfig,
  TelegramRuntimeControls,
} from "@mono-agent/telegram-adapter";

import { buildChannelRuntimeControls } from "../channel-runtime-controls.js";
import { buildChannelConfigView } from "../channel-config-view.js";
import { isChannelConfigured } from "../channel-gate.js";
import type { ChannelGateSpec } from "../channel-gate.js";
import type { ChannelDriver, ChannelStartInput } from "../channels.js";
import { unconfiguredChannelView } from "./shared.js";

type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");

let telegramModule: TelegramAdapterModule | undefined;
const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));

const TELEGRAM_GATE: ChannelGateSpec = { jsonKey: "telegram", envPrefix: "MONO_AGENT_TELEGRAM_" };
const UNCONFIGURED_TELEGRAM_CONFIG: TelegramAdapterConfig = {
  enabled: false,
  botToken: "",
  allowedChatIds: [],
  allowAllChats: false,
};

export interface TelegramChannelOverrides {
  readonly botFactory?: TelegramAdapterStartOptions["botFactory"];
  readonly runnerFactory?: TelegramAdapterStartOptions["runnerFactory"];
  readonly startAdapter?: (options: TelegramAdapterStartOptions) => Promise<TelegramAdapterStartResult>;
}

export function createTelegramChannelDriver(
  overrides: TelegramChannelOverrides = {},
): ChannelDriver<TelegramAdapterConfig> {
  return {
    id: "telegram",
    label: "Telegram",
    async configView(input) {
      if (!(await isChannelConfigured(input, TELEGRAM_GATE))) {
        return unconfiguredChannelView("telegram", "Telegram");
      }
      const adapter = await loadTelegramModule();
      return await buildChannelConfigView(this, adapter.TELEGRAM_CONFIG_FIELDS, input);
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, TELEGRAM_GATE))) {
        return UNCONFIGURED_TELEGRAM_CONFIG;
      }
      const adapter = await loadTelegramModule();
      return await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return telegramModule !== undefined && error instanceof telegramModule.TelegramAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Telegram is disabled.";
    },
    async start(input) {
      const adapter = await loadTelegramModule();
      const startAdapter = overrides.startAdapter ?? adapter.startTelegramAdapter;
      const result = await startAdapter(telegramStartOptions(input, overrides));
      const interactionSink: ChannelInteractionSink = {
        presentAsk: async (conversationId, snapshot) => {
          await result.presentAsk(requireAllowedTelegramChat(conversationId, input), snapshot);
        },
        updateAsk: async (conversationId, snapshot) => {
          await result.updateAsk(requireAllowedTelegramChat(conversationId, input), snapshot);
        },
        postStatus: async (conversationId, text, statusOptions) => {
          await result.postStatus(requireAllowedTelegramChat(conversationId, input), text, statusOptions);
        },
      };
      input.interaction?.registerSink("telegram", interactionSink);
      return {
        summary: {},
        stop: () => result.stop(),
        notify: async (request) => {
          const { conversationId, text, verbatim } = request;
          const chatId = telegramChatIdFromConversation(conversationId);
          if (chatId === undefined) {
            input.logger?.warn?.("Telegram proactive notify skipped: unparseable destination.", { conversationId });
            return { delivered: false, reason: "unparseable telegram destination" };
          }
          if (!input.config.allowAllChats && !input.config.allowedChatIds.includes(String(chatId))) {
            input.logger?.warn?.("Telegram proactive notify skipped: destination not in allowlist.", { conversationId });
            return { delivered: false, reason: "telegram chat is not in the adapter allowlist" };
          }
          const silent = input.config.quietHours !== undefined
            && adapter.isWithinQuietHours(new Date(), input.config.quietHours);
          const notifyOptions = verbatim === undefined && !silent
            ? undefined
            : {
                ...(verbatim === undefined ? {} : { verbatim }),
                ...(silent ? { silent: true } : {}),
              };
          return await result.notify(chatId, text, notifyOptions);
        },
        recordContinuationHistory: async (historyInput: {
          readonly conversationId: string;
          readonly text: string;
          readonly deliveryKey: string;
        }) => {
          try {
            requireAllowedTelegramChat(historyInput.conversationId, input);
          } catch {
            return { recorded: false as const, code: "telegram_destination_not_allowlisted" };
          }
          if (input.responder.deliverVerbatim === undefined) {
            return { recorded: false as const, code: "history_record_unavailable" };
          }
          try {
            await input.responder.deliverVerbatim(
              historyInput.conversationId,
              historyInput.text,
              { idempotencyKey: historyInput.deliveryKey },
            );
            return { recorded: true as const };
          } catch (error) {
            input.logger?.warn?.("Telegram destination history commit failed after delivery.", {
              conversationId: historyInput.conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            return { recorded: false as const, code: "history_record_failed" };
          }
        },
      };
    },
  };
}

function telegramAttachmentOptions(
  config: TelegramAdapterConfig,
): {
  maxBytes?: number;
  downloadTimeoutMs?: number;
  transcription?: TelegramTranscriptionConfig;
} | undefined {
  const attachments = config.attachments;
  const transcription = config.transcription;
  if (
    attachments?.maxBytes === undefined
    && attachments?.downloadTimeoutMs === undefined
    && transcription === undefined
  ) {
    return undefined;
  }
  return {
    ...(attachments?.maxBytes === undefined ? {} : { maxBytes: attachments.maxBytes }),
    ...(attachments?.downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs: attachments.downloadTimeoutMs }),
    ...(transcription === undefined ? {} : { transcription }),
  };
}

function requireAllowedTelegramChat(
  conversationId: string,
  input: ChannelStartInput<TelegramAdapterConfig>,
): TelegramChatId {
  const chatId = telegramChatIdFromConversation(conversationId);
  if (chatId === undefined) {
    throw new Error(`unparseable telegram destination: ${conversationId}`);
  }
  if (!input.config.allowAllChats && !input.config.allowedChatIds.includes(String(chatId))) {
    throw new Error("telegram chat is not in the adapter allowlist.");
  }
  return chatId;
}

/** Extract a Telegram chat id from a `telegram:<chat>` conversation id. */
export function telegramChatIdFromConversation(conversationId: string): TelegramChatId | undefined {
  const prefix = "telegram:";
  if (!conversationId.startsWith(prefix)) {
    return undefined;
  }
  const raw = conversationId.slice(prefix.length).split("#", 1)[0]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return /^-?\d+$/u.test(raw) ? Number(raw) : raw;
}

function telegramStartOptions(
  input: ChannelStartInput<TelegramAdapterConfig>,
  overrides: TelegramChannelOverrides,
): TelegramAdapterStartOptions {
  const runtimeControls: TelegramRuntimeControls = buildChannelRuntimeControls(input.coreConfig);
  const resetter = input.responder as typeof input.responder & {
    startNewSession?: (conversationId: string) => Promise<void>;
  };
  let pollingDegraded = false;
  return {
    botToken: input.config.botToken,
    allowedChatIds: [...input.config.allowedChatIds],
    allowAllChats: input.config.allowAllChats,
    responder: input.responder,
    allowedUpdates: ["message", "callback_query"],
    runtimeControls,
    deleteWebhookOnStart: true,
    stream: {
      initialStatusText: "Agent is thinking...",
      editDebounceMs: 350,
      maxSendRetries: 3,
      retryCapMs: 60_000,
      formatMarkdown: true,
    },
    messages: {
      welcomeText: "Agent is online. Send a message to run the configured runtime.",
      helpText: "Send a message to talk to the agent. Use /new for a fresh conversation, /model and /effort for this chat, or /cancel to stop an in-flight response.",
      unauthorizedText: "This chat is not allowlisted for this agent.",
      errorText: telegramErrorText,
    },
    onPollingError: (error) => {
      if (pollingDegraded) return;
      pollingDegraded = true;
      input.onDegraded?.(error instanceof Error ? error.message : String(error));
    },
    onPollingRecovered: () => {
      if (!pollingDegraded) return;
      pollingDegraded = false;
      input.onRecovered?.();
    },
    ...(input.config.apiRoot === undefined ? {} : { apiRoot: input.config.apiRoot }),
    ...(telegramAttachmentOptions(input.config) === undefined
      ? {}
      : { attachments: telegramAttachmentOptions(input.config)! }),
    ...(input.interaction === undefined
      ? {}
      : {
          pendingAsks: {
            getPendingAsk: (conversationId: string) => input.interaction!.getPendingAsk(conversationId),
            submitAskAnswers: (submission) => input.interaction!.submitAskAnswers(submission),
            cancel: (conversationId: string) => {
              input.interaction!.cancelAsks(conversationId);
            },
          },
        }),
    ...(resetter.startNewSession === undefined
      ? {}
      : { startNewSession: (conversationId: string) => resetter.startNewSession!(conversationId) }),
    ...(input.config.ipFamily === undefined ? {} : { transport: { ipFamily: input.config.ipFamily } }),
    ...(input.config.pollWatchdogMs === undefined ? {} : { pollWatchdogMs: input.config.pollWatchdogMs }),
    ...(input.config.commands === undefined ? {} : { commands: [...input.config.commands] }),
    ...(input.config.reactions === undefined ? {} : { reactions: input.config.reactions }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(overrides.botFactory === undefined ? {} : { botFactory: overrides.botFactory }),
    ...(overrides.runnerFactory === undefined ? {} : { runnerFactory: overrides.runnerFactory }),
  };
}

function telegramErrorText(input: TelegramAdapterErrorTextInput): string {
  const failure = failureFromUnknown(input.error);
  if (failure?.kind !== undefined) {
    const description = describeRunFailureKind({ failureKind: failure.kind });
    if (description.known || failure.message === undefined || failure.message.trim().length === 0) {
      const explanation = failure.kind === "usage_limit"
        ? usageLimitExplanation(description.explanation, failure.details)
        : description.explanation;
      return `${explanation} ${description.nextStep}`;
    }
  }
  if (failure?.message !== undefined && failure.message.trim().length > 0) {
    return `I could not complete that message: ${failure.message}`;
  }
  return "I could not complete that message. Check the local artifact summary for details.";
}

function usageLimitExplanation(explanation: string, details: unknown): string {
  const maxTurns = nestedNumber(details, ["diagnostics", "max_turns"]);
  return maxTurns === undefined ? explanation : `${explanation} Configured turn cap: ${maxTurns} turns.`;
}

function failureFromUnknown(error: unknown): {
  readonly kind?: string;
  readonly message?: string;
  readonly details?: unknown;
} | undefined {
  if (!isRecord(error) || !isRecord(error.failure)) {
    return undefined;
  }
  const failure = error.failure;
  return {
    ...(typeof failure.kind === "string" ? { kind: failure.kind } : {}),
    ...(typeof failure.message === "string" ? { message: failure.message } : {}),
    ...(Object.prototype.hasOwnProperty.call(failure, "details") ? { details: failure.details } : {}),
  };
}

function nestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

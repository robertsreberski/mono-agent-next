import type {
  ChannelDriver as ContractChannelDriver,
  ChannelId as ContractChannelId,
  ChannelLogger,
  ChannelStartInput as ContractChannelStartInput,
} from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { createCronChannelDriver } from "./channel-drivers/cron.js";
import type { CronChannelOverrides } from "./channel-drivers/cron.js";
import { createOpenAIApiChannelDriver } from "./channel-drivers/openai-api.js";
import type { OpenAIApiChannelOverrides } from "./channel-drivers/openai-api.js";
import { createSlackChannelDriver, slackTargetFromConversation } from "./channel-drivers/slack.js";
import type { SlackChannelOverrides } from "./channel-drivers/slack.js";
import { createTelegramChannelDriver, telegramChatIdFromConversation } from "./channel-drivers/telegram.js";
import type { TelegramChannelOverrides } from "./channel-drivers/telegram.js";
import { createTuiChannelDriver } from "./channel-drivers/tui.js";
import type { TuiChannelOverrides } from "./channel-drivers/tui.js";
import { createWebhookChannelDriver } from "./channel-drivers/webhook.js";
import type { WebhookChannelOverrides } from "./channel-drivers/webhook.js";
import { resolveConfiguredChannelPlugins } from "./channel-plugins.js";

/**
 * The channel contract lives in @mono-agent/agent-contracts so third-party
 * drivers depend on the neutral contracts package rather than this host.
 */
export type ChannelId = ContractChannelId;
export type MonoAgentAppLogger = ChannelLogger;
export type {
  ChannelLogger,
  ChannelStatus,
  NotifyDeliveryResult,
  NotifyDestination,
  RunningChannel,
} from "@mono-agent/agent-contracts";
export type ChannelStartInput<TConfig> = ContractChannelStartInput<TConfig, MonoAgentConfig>;
export type ChannelDriver<TConfig = unknown> = ContractChannelDriver<TConfig, MonoAgentConfig>;

/** Host-neutral pre-model outcome returned by a channel continuation adapter. */
export type ContinuationChannelSynthesisResult =
  | { readonly kind: "synthesized"; readonly text: string }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly reason: string;
      readonly retryAfterMs?: number;
    };

/** Built-in channel ids in startup and status-display order. */
export const BUILTIN_CHANNEL_IDS = [
  "telegram",
  "slack",
  "webhook",
  "openai-api",
  "cron",
  "tui",
] as const;
export type BuiltinChannelId = (typeof BUILTIN_CHANNEL_IDS)[number];

export {
  createCronChannelDriver,
  createOpenAIApiChannelDriver,
  createSlackChannelDriver,
  createTelegramChannelDriver,
  createTuiChannelDriver,
  createWebhookChannelDriver,
  slackTargetFromConversation,
  telegramChatIdFromConversation,
};
export type {
  CronChannelOverrides,
  OpenAIApiChannelOverrides,
  SlackChannelOverrides,
  TelegramChannelOverrides,
  TuiChannelOverrides,
  WebhookChannelOverrides,
};

export interface ChannelDriverOverrides {
  readonly telegram?: TelegramChannelOverrides;
  readonly slack?: SlackChannelOverrides;
  readonly webhook?: WebhookChannelOverrides;
  readonly openaiApi?: OpenAIApiChannelOverrides;
  readonly cron?: CronChannelOverrides;
  readonly tui?: TuiChannelOverrides;
  /** Host-only dependency injection keyed by configured plugin package name. */
  readonly pluginFactoryOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Every built-in channel driver, in startup/status display order. */
export function defaultChannelDrivers(overrides: ChannelDriverOverrides = {}): readonly ChannelDriver[] {
  return [
    createTelegramChannelDriver(overrides.telegram),
    createSlackChannelDriver(overrides.slack),
    createWebhookChannelDriver(overrides.webhook),
    createOpenAIApiChannelDriver(overrides.openaiApi),
    createCronChannelDriver(overrides.cron),
    createTuiChannelDriver(overrides.tui),
  ] as readonly ChannelDriver[];
}

export async function resolveChannelDrivers(
  input: MonoAgentAppConfigInput,
  overrides: ChannelDriverOverrides = {},
): Promise<readonly ChannelDriver[]> {
  const drivers = [...defaultChannelDrivers(overrides)];
  const plugins = await resolveConfiguredChannelPlugins(input, {
    reservedIds: BUILTIN_CHANNEL_IDS,
    ...(overrides.pluginFactoryOptions === undefined
      ? {}
      : { factoryOptionsByPackage: overrides.pluginFactoryOptions }),
  });
  for (const plugin of plugins) {
    const existing = drivers.findIndex((driver) => driver.id === plugin.id);
    if (existing >= 0) {
      drivers[existing] = plugin;
    } else {
      drivers.push(plugin);
    }
  }
  return drivers;
}

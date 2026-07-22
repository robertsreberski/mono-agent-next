import {
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type {
  MonoAgentConfig,
  RedactedMonoAgentConfig,
} from "@mono-agent/config";
import {
  resolveAppArtifactDir,
  resolveAppTraceHeartbeatMs,
  resolveAppTraceRegistryDir,
  resolveAppTraceSourceId,
  resolveAppTraceSourceLabel,
  resolveAppTraceStaleAfterMs,
} from "@mono-agent/agent-app";
import type { AppTraceDefaults, MonoAgentAppConfigInput } from "@mono-agent/agent-app";
import { redactA2AAdapterConfig } from "@mono-agent/a2a-adapter";
import type { A2AAdapterConfig, RedactedA2AAdapterConfig } from "@mono-agent/a2a-adapter";
import { redactTelegramAdapterConfig } from "@mono-agent/telegram-adapter";
import type { RedactedTelegramAdapterConfig, TelegramAdapterConfig } from "@mono-agent/telegram-adapter";
import { redactWebhookAdapterConfig } from "@mono-agent/webhook-adapter";
import type { RedactedWebhookAdapterConfig, WebhookAdapterConfig } from "@mono-agent/webhook-adapter";
import { redactOpenAIApiAdapterConfig } from "@mono-agent/openai-api-adapter";
import type { OpenAIApiAdapterConfig, RedactedOpenAIApiAdapterConfig } from "@mono-agent/openai-api-adapter";
import { redactCronAdapterConfig } from "@mono-agent/cron-adapter";
import type { CronAdapterConfig, RedactedCronAdapterConfig } from "@mono-agent/cron-adapter";

export const FINAL_DEMO_TRACE_DEFAULTS: AppTraceDefaults = {
  sourceIdPrefix: "final-agent",
  sourceLabel: "Final Agent Demo",
};

export type FinalAgentDemoConfigInput = MonoAgentAppConfigInput;

export interface LoadedFinalAgentDemoConfig {
  readonly coreConfig: MonoAgentConfig;
  readonly telegramConfig?: TelegramAdapterConfig;
  readonly a2aConfig?: A2AAdapterConfig;
  readonly webhookConfig?: WebhookAdapterConfig;
  readonly openAIApiConfig?: OpenAIApiAdapterConfig;
  readonly cronConfig?: CronAdapterConfig;
}

export interface RedactedFinalAgentDemoConfig {
  readonly core: RedactedMonoAgentConfig;
  readonly telegram?: RedactedTelegramAdapterConfig;
  readonly a2a?: RedactedA2AAdapterConfig;
  readonly webhook?: RedactedWebhookAdapterConfig;
  readonly openaiApi?: RedactedOpenAIApiAdapterConfig;
  readonly cron?: RedactedCronAdapterConfig;
}

export function redactFinalAgentDemoConfig(
  config: LoadedFinalAgentDemoConfig,
): RedactedFinalAgentDemoConfig {
  return {
    core: redactMonoAgentConfig(config.coreConfig),
    ...(config.telegramConfig === undefined ? {} : { telegram: redactTelegramAdapterConfig(config.telegramConfig) }),
    ...(config.a2aConfig === undefined ? {} : { a2a: redactA2AAdapterConfig(config.a2aConfig) }),
    ...(config.webhookConfig === undefined ? {} : { webhook: redactWebhookAdapterConfig(config.webhookConfig) }),
    ...(config.openAIApiConfig === undefined ? {} : { openaiApi: redactOpenAIApiAdapterConfig(config.openAIApiConfig) }),
    ...(config.cronConfig === undefined ? {} : { cron: redactCronAdapterConfig(config.cronConfig) }),
  };
}

export async function resolveFinalDemoArtifactDir(input: FinalAgentDemoConfigInput): Promise<string> {
  return await resolveAppArtifactDir(input);
}

export async function resolveFinalDemoTraceRegistryDir(input: FinalAgentDemoConfigInput): Promise<string> {
  return await resolveAppTraceRegistryDir(input);
}

export async function resolveFinalDemoTraceSourceId(input: FinalAgentDemoConfigInput): Promise<string> {
  return await resolveAppTraceSourceId(input, FINAL_DEMO_TRACE_DEFAULTS);
}

export async function resolveFinalDemoTraceSourceLabel(input: FinalAgentDemoConfigInput): Promise<string> {
  return await resolveAppTraceSourceLabel(input, FINAL_DEMO_TRACE_DEFAULTS);
}

export async function resolveFinalDemoTraceHeartbeatMs(input: FinalAgentDemoConfigInput): Promise<number> {
  return await resolveAppTraceHeartbeatMs(input);
}

export async function resolveFinalDemoTraceStaleAfterMs(input: FinalAgentDemoConfigInput): Promise<number> {
  return await resolveAppTraceStaleAfterMs(input);
}

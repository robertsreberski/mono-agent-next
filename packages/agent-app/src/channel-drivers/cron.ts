import type {
  CronAdapterConfig,
  CronAdapterOptions,
  CronAdapterStartResult,
  CronJobConfig,
  CronJobResult,
} from "@mono-agent/cron-adapter";

import { buildChannelConfigView } from "../channel-config-view.js";
import { isChannelConfigured } from "../channel-gate.js";
import type { ChannelGateSpec } from "../channel-gate.js";
import type { ChannelDriver, MonoAgentAppLogger } from "../channels.js";
import type { NotifyDeliveryResult } from "../proactive-notify.js";
import { findTriggerOverrideIssues } from "../trigger-overrides.js";
import { deliverNativeCronNotification, inferUniqueNotifyDestination } from "./native-notify.js";
import { unconfiguredChannelView } from "./shared.js";

type CronAdapterModule = typeof import("@mono-agent/cron-adapter");

let cronModule: CronAdapterModule | undefined;
const loadCronModule = async (): Promise<CronAdapterModule> =>
  (cronModule ??= await import("@mono-agent/cron-adapter"));

const CRON_GATE: ChannelGateSpec = { jsonKey: "cron", envPrefix: "MONO_AGENT_CRON_", dir: "cron" };
const UNCONFIGURED_CRON_CONFIG: CronAdapterConfig = { jobs: [] };
const DEFAULT_CRON_MAX_RUN_MS = 20 * 60 * 1000;
const DEFAULT_CRON_FAILURE_NOTICE_COOLDOWN_HOURS = 6;
const MAX_CRON_FAILURE_NOTICE_ERROR_CHARS = 180;

export interface CronChannelOverrides {
  readonly adapterFactory?: (options: CronAdapterOptions) => CronAdapterStartResult;
  /** Test seam for cooldown decisions; production uses the system clock. */
  readonly now?: () => Date;
  /** Maximum wall-clock time before a hung run is aborted and its slot reclaimed. */
  readonly maxRunMs?: number;
}

export function createCronChannelDriver(
  overrides: CronChannelOverrides = {},
): ChannelDriver<CronAdapterConfig> {
  const failureNoticeLastSentMsByJobId = new Map<string, number>();
  return {
    id: "cron",
    label: "Cron",
    async configView(input) {
      if (!(await isChannelConfigured(input, CRON_GATE))) {
        return unconfiguredChannelView("cron", "Cron");
      }
      const adapter = await loadCronModule();
      return await buildChannelConfigView(this, adapter.CRON_CONFIG_FIELDS, input);
    },
    configIssues(config) {
      return findTriggerOverrideIssues(
        config.jobs
          .filter((job) => job.enabled)
          .map((job) => ({
            name: `cron job "${job.id}"`,
            ...(job.model === undefined ? {} : { model: job.model }),
            ...(job.effort === undefined ? {} : { effort: job.effort }),
          })),
      );
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, CRON_GATE))) {
        return UNCONFIGURED_CRON_CONFIG;
      }
      const adapter = await loadCronModule();
      return await adapter.loadCronAdapterConfig({ env: input.env, jsonPath: input.configPath, cwd: input.cwd });
    },
    isConfigError(error) {
      return cronModule !== undefined && error instanceof cronModule.CronAdapterError;
    },
    disabledReason(config) {
      const enabledJobs = config.jobs.filter((job) => job.enabled);
      return enabledJobs.length > 0 ? undefined : "Cron adapter has no enabled jobs.";
    },
    async start(input) {
      const jobs = input.config.jobs.filter((job) => job.enabled);
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      const listNotifyDestinations = input.listNotifyDestinations;
      const resolveNotifyFallbackConversationId = listNotifyDestinations === undefined
        ? undefined
        : async (abortSignal?: AbortSignal) => await inferUniqueNotifyDestination({
            listNotifyDestinations,
            ...(abortSignal === undefined ? {} : { abortSignal }),
          });
      const adapterModule = await loadCronModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startCronAdapter;
      const adapter = adapterFactory({
        responder: input.responder,
        overlap: "skip",
        maxRunMs: overrides.maxRunMs ?? DEFAULT_CRON_MAX_RUN_MS,
        jobs: jobs.map((job) => ({
          id: job.id,
          expression: job.expression,
          timezone: job.timezone,
          prompt: job.prompt,
          ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
          ...(job.maxRunMs === undefined ? {} : { maxRunMs: job.maxRunMs }),
          ...(job.notify === undefined ? {} : { notify: job.notify }),
          ...(job.notifyConversationId === undefined ? {} : { notifyConversationId: job.notifyConversationId }),
          ...(job.model === undefined ? {} : { model: job.model }),
          ...(job.effort === undefined ? {} : { effort: job.effort }),
        })),
        ...(resolveNotifyFallbackConversationId === undefined ? {} : { resolveNotifyFallbackConversationId }),
        onResult: (result) => {
          const level = result.kind === "failed" ? "error" : result.kind === "skipped" ? "warn" : "info";
          input.logger?.[level]?.("Cron job finished.", { result });
          void deliverCronModelExhaustionFailureNotice({
            job: jobById.get(result.jobId),
            result,
            cooldowns: failureNoticeLastSentMsByJobId,
            now: overrides.now ?? (() => new Date()),
            ...(input.notifyDestination === undefined ? {} : { notifyDestination: input.notifyDestination }),
            ...(input.logger === undefined ? {} : { logger: input.logger }),
          });
          void deliverNativeCronNotification({
            job: jobById.get(result.jobId),
            result,
            ...(input.notifyDestination === undefined ? {} : { notifyDestination: input.notifyDestination }),
            ...(input.logger === undefined ? {} : { logger: input.logger }),
          });
        },
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { jobs: adapter.jobs.length },
        async stop() {
          adapter.stop();
        },
      };
    },
  };
}

async function deliverCronModelExhaustionFailureNotice(input: {
  readonly job: CronJobConfig | undefined;
  readonly result: CronJobResult;
  readonly cooldowns: Map<string, number>;
  readonly now: () => Date;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean; readonly deliveryKey?: string },
  ) => Promise<NotifyDeliveryResult>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const job = input.job;
  if (
    job?.notify !== true ||
    input.result.kind !== "failed" ||
    input.result.failureKind !== "provider_unavailable_exhausted"
  ) {
    return;
  }
  if (job.notifyConversationId === undefined) {
    input.logger?.warn?.("Cron failure notice skipped: notifyConversationId is required.", { jobId: job.id });
    return;
  }
  if (input.notifyDestination === undefined) {
    input.logger?.warn?.("Cron failure notice skipped: no delivery hook is available.", { jobId: job.id });
    return;
  }

  const nowMs = input.now().getTime();
  const cooldownHours = job.notifyFailureCooldownHours ?? DEFAULT_CRON_FAILURE_NOTICE_COOLDOWN_HOURS;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const lastSentMs = input.cooldowns.get(job.id);
  if (lastSentMs !== undefined && nowMs - lastSentMs < cooldownMs) {
    input.logger?.info?.("Cron failure notice skipped: cooldown is active.", { jobId: job.id, cooldownHours });
    return;
  }

  const destination = job.notifyConversationId;
  const text = buildCronModelExhaustionFailureNotice(job, input.result);
  try {
    const delivery = await input.notifyDestination(destination, text, {
      verbatim: true,
      ...(destination === "web:new"
        ? {
            deliveryKey: `cron:${encodeURIComponent(job.id)}:${input.result.scheduledAt}:failure:${input.result.failureKind}`,
          }
        : {}),
    });
    if (!delivery.delivered) {
      input.logger?.warn?.("Cron failure notice was not delivered.", {
        jobId: job.id,
        conversationId: destination,
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      });
      return;
    }
    input.cooldowns.set(job.id, nowMs);
    input.logger?.info?.("Cron failure notice delivered.", { jobId: job.id, conversationId: destination });
  } catch (error) {
    input.logger?.warn?.("Cron failure notice failed.", {
      jobId: job.id,
      conversationId: destination,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildCronModelExhaustionFailureNotice(job: CronJobConfig, result: { readonly error: string }): string {
  const jobId = oneLine(job.id);
  const latestError = truncateOneLine(result.error, MAX_CRON_FAILURE_NOTICE_ERROR_CHARS);
  const prefix = `Cron job "${jobId}" failed: all configured models failed.`;
  return latestError.length === 0 ? prefix : `${prefix} Latest error: ${latestError}`;
}

function truncateOneLine(value: string, maxChars: number): string {
  const collapsed = oneLine(value);
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

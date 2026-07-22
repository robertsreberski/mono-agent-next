import { resolve } from "node:path";

import { MODULE_API_VERSION } from "@mono-agent/module-sdk";
import {
  defineTriggerModule,
  type TriggerModuleCreateContext,
} from "@mono-agent/module-sdk/internal";

import {
  triggerCronConfigSchema,
  type TriggerCronConfig,
} from "./config.js";
import { loadCronJobsFromDirectory } from "./jobs.js";
import { createCronTrigger } from "./scheduler.js";

const PACKAGE_NAME = "@mono-agent/trigger-cron";
const PACKAGE_VERSION = "0.15.0";

export const monoAgentModule = defineTriggerModule({
  manifest: {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "trigger",
    responsibility: "Discovers scheduled Markdown jobs and emits deterministic idempotent trigger events.",
    capabilities: [],
  },
  schema: triggerCronConfigSchema,
  async create(context: TriggerModuleCreateContext<TriggerCronConfig>) {
    const directory = resolve(context.configDirectory, context.config.jobsDirectory);
    const jobs = await loadCronJobsFromDirectory(directory, context.config.timezone);
    return createCronTrigger({
      instanceId: context.instanceId,
      jobs,
      host: context.host,
      signal: context.signal,
    });
  },
});

export {
  DEFAULT_CRON_TIMEZONE,
  TriggerCronConfigError,
  assertValidTimezone,
  parseTriggerCronConfig,
  triggerCronConfigSchema,
} from "./config.js";
export type { TriggerCronConfig } from "./config.js";
export {
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_MAX_RUN_MS,
  MAX_CRON_JOBS,
  MAX_CRON_JOB_BYTES,
  loadCronJobsFromDirectory,
  nextCronOccurrence,
  parseCronJobMarkdown,
} from "./jobs.js";
export type {
  CronJob,
  CronNotifyDestination,
  CronOverflowPolicy,
  CronOverlapMode,
} from "./jobs.js";
export {
  createCronTrigger,
  cronIdempotencyKey,
  systemCronClock,
} from "./scheduler.js";
export type {
  CreateCronTriggerOptions,
  CronClock,
  CronInvocationResult,
  CronInvocationSource,
  CronTimerHandle,
  CronTrigger,
} from "./scheduler.js";

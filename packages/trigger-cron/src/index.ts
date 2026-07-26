// SPDX-License-Identifier: MIT

import { resolve } from "node:path";

import {
  HOST_CAPABILITY_RUNTIME_ROUTE_VALIDATION,
  MODULE_API_VERSION,
  type RuntimeRouteValidationGrant,
} from "@mono-agent/module-sdk";
import {
  type TriggerModuleCreateContext,
  type TriggerModuleDefinition,
} from "@mono-agent/module-sdk/internal";

import {
  TriggerCronConfigError,
  triggerCronConfigSchema,
  type TriggerCronConfig,
} from "./config.js";
import {
  loadCronJobsFromDirectory,
  type CronJob,
} from "./jobs.js";
import {
  HOST_CAPABILITY_CRON_DURABLE_STATE,
  createCronTrigger,
} from "./scheduler.js";

const PACKAGE_NAME = "@mono-agent/trigger-cron";
const PACKAGE_VERSION = "0.15.0";

export const monoAgentModule = Object.freeze({
  manifest: Object.freeze({
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "trigger",
    responsibility: "Discovers scheduled Markdown jobs and emits deterministic idempotent trigger events.",
    capabilities: Object.freeze([
      HOST_CAPABILITY_CRON_DURABLE_STATE,
      HOST_CAPABILITY_RUNTIME_ROUTE_VALIDATION,
    ]),
  }),
  schema: triggerCronConfigSchema,
  async create(context: TriggerModuleCreateContext<TriggerCronConfig>) {
    const routeValidation = context.host.getCapability<RuntimeRouteValidationGrant>(
      HOST_CAPABILITY_RUNTIME_ROUTE_VALIDATION,
    );
    const directory = resolve(context.configDirectory, context.config.jobsDirectory);
    const jobs = await loadCronJobsFromDirectory(directory, context.config.timezone);
    assertConfiguredCronJobs(jobs, routeValidation);
    return createCronTrigger({
      instanceId: context.instanceId,
      jobs,
      host: context.host,
      signal: context.signal,
    });
  },
}) satisfies TriggerModuleDefinition<TriggerCronConfig>;

function assertConfiguredCronJobs(
  jobs: readonly CronJob[],
  validation: RuntimeRouteValidationGrant | undefined,
): void {
  if (
    validation === undefined
    && jobs.some((job) => job.runtime !== undefined || job.model !== undefined)
  ) {
    throw new Error(
      `Runtime-selected cron jobs require the declared ${
        HOST_CAPABILITY_RUNTIME_ROUTE_VALIDATION
      } host grant.`,
    );
  }
  if (validation === undefined) return;
  const rejected = jobs.flatMap((job) => {
    if (job.runtime === undefined && job.model === undefined) return [];
    const result = validation.validate(job.runtime, job.model);
    return result.configured
      ? []
      : [`${job.source}: ${result.runtime}:${result.model} is not a configured runtime route.`];
  });
  if (rejected.length === 0) return;
  throw new TriggerCronConfigError(rejected.length === 1
    ? rejected[0]!
    : `${String(rejected.length)} cron jobs select unconfigured runtime routes:\n${
      rejected.map((entry) => `- ${entry}`).join("\n")
    }`);
}

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
  MAX_CRON_CATCH_UP,
  createCronTrigger,
  cronIdempotencyKey,
  systemCronClock,
} from "./scheduler.js";
export type {
  CreateCronTriggerOptions,
  CronClock,
  CronInvocationResult,
  CronInvocationSource,
  CronInvocationStatus,
  CronTimerHandle,
  CronTrigger,
} from "./scheduler.js";

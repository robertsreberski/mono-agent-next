import { resolve } from "node:path";

import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readInteger,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec, SettingsJson } from "@mono-agent/agent-contracts";

import { loadCronJobsFromDirectory } from "./jobs-dir.js";
import { CronAdapterError, type CronJob } from "./scheduler.js";

export interface CronJobConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly expression: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly conversationId?: string;
  readonly maxRunMs?: number;
  readonly notify?: boolean;
  readonly notifyConversationId?: string;
  /** Cooldown in hours for provider-exhaustion failure notices on notify jobs. */
  readonly notifyFailureCooldownHours?: number;
  /** Per-job runtime model override (e.g. `claude:claude-opus-4-8`). Validated by the app. */
  readonly model?: string;
  /** Per-job reasoning effort override (e.g. `high`). Validated by the app. */
  readonly effort?: string;
}

export interface CronAdapterConfig {
  readonly jobs: readonly CronJobConfig[];
}

export type RedactedCronAdapterConfig = CronAdapterConfig;

export interface LoadCronAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
  /** Base directory the cron jobs folder resolves against (usually the app cwd). */
  readonly cwd?: string;
  /** Overrides the cron jobs folder; defaults to `cron.dir` / `MONO_AGENT_CRON_DIR` / `cron`. */
  readonly dir?: string;
}

const DEFAULT_JOB_ID = "default";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_CRON_DIR = "cron";

const invalidConfig = (message: string, details?: Record<string, unknown>): CronAdapterError =>
  new CronAdapterError("invalid_config", message, details);

export async function loadCronAdapterConfig(input: LoadCronAdapterConfigInput): Promise<CronAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const configJobs = loadConfigJobs(json, input.env);
  const directoryJobs = await loadDirectoryJobs(json, input);
  return { jobs: mergeJobs(configJobs, directoryJobs) };
}

/**
 * Jobs defined inline in config: `MONO_AGENT_CRON_JOBS_JSON` (highest), then the
 * `cron.jobs` array, then the single-job `MONO_AGENT_CRON_*` fields. Returns an
 * empty list when nothing is configured (the cron folder may still add jobs).
 */
function loadConfigJobs(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): CronJobConfig[] {
  const jobsJson = normalizeOptionalString(env.MONO_AGENT_CRON_JOBS_JSON);
  if (jobsJson !== undefined) {
    return [...readJobsJson(jobsJson)];
  }
  const section = readJsonSection(json, "cron");
  if (section.jobs !== undefined) {
    if (!Array.isArray(section.jobs)) {
      throw invalidConfig("cron.jobs must be an array of job objects.");
    }
    return section.jobs.map((entry, index) => normalizeJobConfig(entry, index));
  }
  const layered = layerCronJsonOntoEnv(json, env);
  const enabled = readBoolean(layered.MONO_AGENT_CRON_ENABLED, "MONO_AGENT_CRON_ENABLED", false, invalidConfig);
  const expression = normalizeOptionalString(layered.MONO_AGENT_CRON_EXPRESSION);
  const prompt = normalizeOptionalString(layered.MONO_AGENT_CRON_PROMPT);
  if (!enabled && expression === undefined && prompt === undefined) {
    return [];
  }
  if (expression === undefined) {
    throw invalidConfig("Cron expression is required when cron is configured.");
  }
  if (prompt === undefined) {
    throw invalidConfig("Cron prompt is required when cron is configured.");
  }
  const conversationId = normalizeOptionalString(layered.MONO_AGENT_CRON_CONVERSATION_ID);
  const notify = readBoolean(layered.MONO_AGENT_CRON_NOTIFY, "MONO_AGENT_CRON_NOTIFY", false, invalidConfig);
  const notifyConversationId = normalizeOptionalString(layered.MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID);
  const notifyFailureCooldownHours = readOptionalPositiveIntegerEnv(
    layered.MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS,
    "MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS",
  );
  const model = normalizeOptionalString(layered.MONO_AGENT_CRON_MODEL);
  const effort = normalizeOptionalString(layered.MONO_AGENT_CRON_EFFORT);
  return [{
    id: DEFAULT_JOB_ID,
    enabled,
    expression,
    timezone: normalizeOptionalString(layered.MONO_AGENT_CRON_TIMEZONE) ?? DEFAULT_TIMEZONE,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(notify ? { notify } : {}),
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(notifyFailureCooldownHours === undefined ? {} : { notifyFailureCooldownHours }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }];
}

/**
 * Jobs authored as `*.md` files in the cron folder. Skipped unless a base
 * directory (`input.cwd`) is known, so a loader called without a host (e.g. a
 * unit test) never scans the process working directory implicitly.
 */
async function loadDirectoryJobs(
  json: SettingsJson,
  input: LoadCronAdapterConfigInput,
): Promise<CronJobConfig[]> {
  if (input.cwd === undefined) {
    return [];
  }
  const section = readJsonSection(json, "cron");
  if (section.dir !== undefined && typeof section.dir !== "string") {
    throw invalidConfig("cron.dir must be a string.");
  }
  const dirName =
    normalizeOptionalString(input.dir) ??
    normalizeOptionalString(input.env.MONO_AGENT_CRON_DIR) ??
    asOptionalString(section.dir) ??
    DEFAULT_CRON_DIR;
  return await loadCronJobsFromDirectory(resolve(input.cwd, dirName));
}

/** Combine inline-config jobs with cron-folder jobs; a duplicate id is a hard error. */
function mergeJobs(configJobs: CronJobConfig[], directoryJobs: CronJobConfig[]): CronJobConfig[] {
  const merged: CronJobConfig[] = [];
  const sourceById = new Map<string, string>();
  const append = (job: CronJobConfig, source: string): void => {
    const prior = sourceById.get(job.id);
    if (prior !== undefined) {
      throw invalidConfig(`Duplicate cron job id "${job.id}" from ${prior} and ${source}.`, { id: job.id });
    }
    sourceById.set(job.id, source);
    merged.push(job);
  };
  for (const job of configJobs) {
    append(job, "config");
  }
  for (const job of directoryJobs) {
    append(job, "cron folder");
  }
  return merged;
}

/**
 * Project the loaded config down to the runtime {@link CronJob} shape consumed
 * by {@link import("./scheduler.js").startCronAdapter}, dropping disabled jobs.
 * Hosts must route config jobs through this rather than spreading them directly,
 * otherwise the `enabled` flag is silently ignored and disabled jobs would run.
 */
export function toCronJobs(config: CronAdapterConfig): CronJob[] {
  return config.jobs
    .filter((job) => job.enabled)
    .map((job) => ({
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
    }));
}

export function redactCronAdapterConfig(config: CronAdapterConfig): RedactedCronAdapterConfig {
  // Cron config holds no secrets (the prompt is not treated as one), so
  // redaction is the identity transform; we only clone to preserve immutability.
  return {
    jobs: config.jobs.map((job) => ({ ...job })),
  };
}

function readJobsJson(value: string): readonly CronJobConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidConfig("MONO_AGENT_CRON_JOBS_JSON must contain valid JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw invalidConfig("MONO_AGENT_CRON_JOBS_JSON must be an array.");
  }
  return parsed.map((entry, index) => normalizeJobConfig(entry, index));
}

function normalizeJobConfig(entry: unknown, index: number): CronJobConfig {
  if (!isRecord(entry)) {
    throw invalidConfig("Cron job entries must be objects.", { index });
  }
  const id = asOptionalString(entry.id);
  const expression = asOptionalString(entry.expression);
  const prompt = asOptionalString(entry.prompt);
  if (id === undefined || expression === undefined || prompt === undefined) {
    throw invalidConfig("Cron jobs require id, expression, and prompt.", { index });
  }
  const conversationId = asOptionalString(entry.conversationId);
  const maxRunMs = asOptionalPositiveInteger(entry.maxRunMs, "cron.jobs[].maxRunMs", { index });
  const notify = asOptionalBoolean(entry.notify, "cron.jobs[].notify", { index });
  const notifyConversationId = asOptionalString(entry.notifyConversationId);
  const notifyFailureCooldownHours = asOptionalPositiveInteger(
    entry.notifyFailureCooldownHours,
    "cron.jobs[].notifyFailureCooldownHours",
    { index },
    "hours",
  );
  const model = asOptionalString(entry.model);
  const effort = asOptionalString(entry.effort);
  return {
    id,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    expression,
    timezone: asOptionalString(entry.timezone) ?? DEFAULT_TIMEZONE,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(maxRunMs === undefined ? {} : { maxRunMs }),
    ...(notify === undefined ? {} : { notify }),
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(notifyFailureCooldownHours === undefined ? {} : { notifyFailureCooldownHours }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * The `cron` section's field registry: the single source of truth both the
 * JSON→env layering below and the app's config provenance view derive from.
 * Covers the single-job env form (multi-job `jobs[]` and the `cron/` directory
 * are read straight from JSON / the filesystem).
 */
export const CRON_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "cron.enabled", env: "MONO_AGENT_CRON_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "cron.dir", env: "MONO_AGENT_CRON_DIR", fromJson: (s) => s.dir },
  { id: "cron.expression", env: "MONO_AGENT_CRON_EXPRESSION", fromJson: (s) => s.expression },
  { id: "cron.timezone", env: "MONO_AGENT_CRON_TIMEZONE", fromJson: (s) => s.timezone },
  { id: "cron.prompt", env: "MONO_AGENT_CRON_PROMPT", fromJson: (s) => s.prompt },
  { id: "cron.conversationId", env: "MONO_AGENT_CRON_CONVERSATION_ID", fromJson: (s) => s.conversationId },
  { id: "cron.notify", env: "MONO_AGENT_CRON_NOTIFY", kind: "boolean", fromJson: (s) => s.notify },
  { id: "cron.notifyConversationId", env: "MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID", fromJson: (s) => s.notifyConversationId },
  { id: "cron.notifyFailureCooldownHours", env: "MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS", kind: "integer", fromJson: (s) => s.notifyFailureCooldownHours },
  { id: "cron.model", env: "MONO_AGENT_CRON_MODEL", fromJson: (s) => s.model },
  { id: "cron.effort", env: "MONO_AGENT_CRON_EFFORT", fromJson: (s) => s.effort },
];

function layerCronJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "cron"), CRON_CONFIG_FIELDS));
}

/** Trim a JSON value to a non-empty string, treating non-strings as absent. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function asOptionalPositiveInteger(
  value: unknown,
  field: string,
  details: Record<string, unknown>,
  unit = "milliseconds",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidConfig(`${field} must be a positive integer number of ${unit}.`, { ...details, value });
  }
  return value;
}

function readOptionalPositiveIntegerEnv(value: string | undefined, env: string): number | undefined {
  if (normalizeOptionalString(value) === undefined) {
    return undefined;
  }
  return readInteger(value, env, 0, invalidConfig, { min: 1, max: Number.MAX_SAFE_INTEGER });
}

function asOptionalBoolean(
  value: unknown,
  field: string,
  details: Record<string, unknown>,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invalidConfig(`${field} must be a boolean.`, { ...details, value });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

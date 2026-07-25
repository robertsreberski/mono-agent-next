// SPDX-License-Identifier: MIT

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { CronExpressionParser } from "cron-parser";
import { parseDocument } from "yaml";

import {
  DEFAULT_CRON_TIMEZONE,
  TriggerCronConfigError,
  assertValidTimezone,
  readRecord,
  readString,
  rejectUnknownKeys,
} from "./config.js";

export const DEFAULT_MAX_RUN_MS = 20 * 60 * 1_000;
export const DEFAULT_MAX_QUEUE_DEPTH = 16;
export const MAX_CRON_JOB_BYTES = 1_048_576;
export const MAX_CRON_JOBS = 1_000;

export type CronOverlapMode = "skip" | "queue" | "replace";
export type CronOverflowPolicy = "drop-newest" | "drop-oldest" | "coalesce";

export interface CronNotifyDestination {
  readonly channel: string;
  readonly destination: string;
}

export interface CronJob {
  readonly id: string;
  readonly expression: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly notify?: string | CronNotifyDestination;
  readonly overlap: CronOverlapMode;
  readonly maxQueueDepth: number;
  readonly overflow: CronOverflowPolicy;
  readonly maxRunMs: number;
  readonly source: string;
}

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;
const JOB_KEYS = new Set([
  "id",
  "expression",
  "timezone",
  "runtime",
  "model",
  "effort",
  "notify",
  "overlap",
  "maxQueueDepth",
  "overflow",
  "maxRunMs",
]);

export async function loadCronJobsFromDirectory(
  directory: string,
  defaultTimezone = DEFAULT_CRON_TIMEZONE,
): Promise<readonly CronJob[]> {
  assertValidTimezone(defaultTimezone, "default timezone");
  const directoryStats = await lstat(directory).catch((error: unknown) => {
    throw new TriggerCronConfigError(`Unable to inspect cron jobs directory ${directory}: ${errorMessage(error)}`);
  });
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new TriggerCronConfigError(`${directory} must be a real directory, not a symlink.`);
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new TriggerCronConfigError(`Unable to read cron jobs directory ${directory}: ${errorMessage(error)}`);
  }
  const markdownEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".md"));
  const unsafe = markdownEntries.find((entry) => !entry.isFile() && !entry.isSymbolicLink());
  if (unsafe !== undefined) {
    throw new TriggerCronConfigError(`${join(directory, unsafe.name)} must be a regular Markdown file.`);
  }
  const names = markdownEntries
    .map((entry) => entry.name)
    .sort();
  if (names.length > MAX_CRON_JOBS) {
    throw new TriggerCronConfigError(`Cron jobs directory exceeds the ${String(MAX_CRON_JOBS)} job limit.`);
  }
  const jobs: CronJob[] = [];
  const ids = new Map<string, string>();
  for (const name of names) {
    const path = join(directory, name);
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > MAX_CRON_JOB_BYTES) {
          throw new TriggerCronConfigError(`${path} must be a regular file no larger than ${String(MAX_CRON_JOB_BYTES)} bytes.`);
        }
        const content = await file.readFile("utf8");
        const job = parseCronJobMarkdown(name, content, defaultTimezone);
        const prior = ids.get(job.id);
        if (prior !== undefined) {
          throw new TriggerCronConfigError(`Duplicate cron job id "${job.id}" in ${prior} and ${name}.`);
        }
        ids.set(job.id, name);
        jobs.push(Object.freeze({ ...job, source: path }));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof TriggerCronConfigError) throw error;
      throw new TriggerCronConfigError(`Unable to load cron job ${path}: ${errorMessage(error)}`);
    }
  }
  return Object.freeze(jobs);
}

export function parseCronJobMarkdown(
  fileName: string,
  content: string,
  defaultTimezone = DEFAULT_CRON_TIMEZONE,
): CronJob {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (match === null) {
    throw new TriggerCronConfigError(`${fileName} must begin with a YAML frontmatter block.`);
  }
  let metadataValue: unknown;
  try {
    const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new TriggerCronConfigError(
        `${fileName} frontmatter is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`,
      );
    }
    metadataValue = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    if (error instanceof TriggerCronConfigError) throw error;
    throw new TriggerCronConfigError(`${fileName} frontmatter is invalid YAML: ${errorMessage(error)}`);
  }
  const metadata = readRecord(metadataValue, `${fileName} frontmatter`);
  rejectUnknownKeys(metadata, JOB_KEYS, `${fileName} frontmatter`);
  const prompt = normalized.slice(match[0].length).trim();
  if (prompt.length === 0 || Buffer.byteLength(prompt, "utf8") > MAX_CRON_JOB_BYTES) {
    throw new TriggerCronConfigError(`${fileName} must contain a non-empty bounded Markdown prompt body.`);
  }
  const id = metadata.id === undefined
    ? derivedJobId(fileName)
    : readString(metadata.id, `${fileName} id`);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) {
    throw new TriggerCronConfigError(`${fileName} id must match ^[a-z0-9][a-z0-9._-]{0,127}$.`);
  }
  const expression = readString(metadata.expression, `${fileName} expression`);
  const timezone = metadata.timezone === undefined
    ? defaultTimezone
    : readString(metadata.timezone, `${fileName} timezone`);
  validateCronExpression(expression, timezone, id);
  const runtime = optionalString(metadata.runtime, `${fileName} runtime`);
  const model = optionalString(metadata.model, `${fileName} model`);
  const effort = optionalString(metadata.effort, `${fileName} effort`);
  const notify = parseNotify(metadata.notify, fileName);
  const overlap = enumValue(metadata.overlap, ["skip", "queue", "replace"] as const, "skip", `${fileName} overlap`);
  const maxQueueDepth = positiveInteger(metadata.maxQueueDepth, DEFAULT_MAX_QUEUE_DEPTH, `${fileName} maxQueueDepth`, 1_000);
  const overflow = enumValue(
    metadata.overflow,
    ["drop-newest", "drop-oldest", "coalesce"] as const,
    "drop-newest",
    `${fileName} overflow`,
  );
  const maxRunMs = positiveInteger(metadata.maxRunMs, DEFAULT_MAX_RUN_MS, `${fileName} maxRunMs`, 86_400_000);
  return Object.freeze({
    id,
    expression,
    timezone,
    prompt,
    ...(runtime === undefined ? {} : { runtime }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(notify === undefined ? {} : { notify }),
    overlap,
    maxQueueDepth,
    overflow,
    maxRunMs,
    source: fileName,
  });
}

export function nextCronOccurrence(job: CronJob, currentDate: Date): Date {
  return CronExpressionParser.parse(job.expression, {
    currentDate,
    strict: false,
    tz: job.timezone,
    hashSeed: job.id,
  }).next().toDate();
}

export function previousCronOccurrence(job: CronJob, currentDate: Date): Date {
  return CronExpressionParser.parse(job.expression, {
    currentDate,
    strict: false,
    tz: job.timezone,
    hashSeed: job.id,
  }).prev().toDate();
}

function validateCronExpression(expression: string, timezone: string, hashSeed: string): void {
  if (expression.split(/\s+/u).length !== 5) {
    throw new TriggerCronConfigError("Cron expressions must contain exactly five fields.");
  }
  assertValidTimezone(timezone);
  try {
    CronExpressionParser.parse(expression, {
      currentDate: new Date(0),
      strict: false,
      tz: timezone,
      hashSeed,
    }).next();
  } catch (error) {
    throw new TriggerCronConfigError(`Invalid cron expression: ${errorMessage(error)}`);
  }
}

function derivedJobId(fileName: string): string {
  const name = basename(fileName);
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3).toLowerCase() : name;
}

function parseNotify(value: unknown, fileName: string): string | CronNotifyDestination | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return readString(value, `${fileName} notify`);
  const input = readRecord(value, `${fileName} notify`);
  rejectUnknownKeys(input, new Set(["channel", "destination"]), `${fileName} notify`);
  return Object.freeze({
    channel: readString(input.channel, `${fileName} notify.channel`),
    destination: readString(input.destination, `${fileName} notify.destination`),
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : readString(value, field);
}

function positiveInteger(value: unknown, fallback: number, field: string, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TriggerCronConfigError(`${field} must be a positive integer no greater than ${String(maximum)}.`);
  }
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TriggerCronConfigError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

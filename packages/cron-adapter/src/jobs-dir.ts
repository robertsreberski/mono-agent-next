import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeOptionalString, readBoolean } from "@mono-agent/agent-contracts";

import { CronAdapterError } from "./scheduler.js";
import type { CronJobConfig } from "./config.js";

const DEFAULT_TIMEZONE = "UTC";

// Matches a leading YAML-style frontmatter block (`---` … `---`). Mirrors the
// shape used by the skill index, but cron-adapter must not depend on host or
// other-package code, so the parser is self-contained here. Cron frontmatter is
// flat scalars only, so a tiny line parser is enough — no YAML dependency.
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;

const invalidConfig = (message: string, details?: Record<string, unknown>): CronAdapterError =>
  new CronAdapterError("invalid_config", message, details);

/**
 * Load every `*.md` cron job in {@link dir}. A missing directory is not an
 * error (returns `[]`); files are read in sorted filename order for a stable
 * job list. Two files that resolve to the same job `id` are a hard error.
 */
export async function loadCronJobsFromDirectory(dir: string): Promise<CronJobConfig[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw invalidConfig("Unable to read cron jobs directory.", { dir, reason: errorToMessage(error) });
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  const jobs: CronJobConfig[] = [];
  const seenIds = new Map<string, string>();
  for (const name of files) {
    const filePath = join(dir, name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      throw invalidConfig("Unable to read cron job file.", { file: name, reason: errorToMessage(error) });
    }
    const job = parseCronJobMarkdown(name, content);
    const prior = seenIds.get(job.id);
    if (prior !== undefined) {
      throw invalidConfig(`Duplicate cron job id "${job.id}" defined by ${prior} and ${name}.`, {
        id: job.id,
        file: name,
      });
    }
    seenIds.set(job.id, name);
    jobs.push(job);
  }
  return jobs;
}

/**
 * Parse one cron job markdown file: frontmatter holds the schedule metadata and
 * the markdown body is the prompt. `id` defaults to the filename stem, timezone
 * to UTC, and enabled to true (an authored file is presumed live).
 */
export function parseCronJobMarkdown(fileName: string, content: string): CronJobConfig {
  const normalized = content.replace(/\r\n?/g, "\n");
  const match = FRONTMATTER_PATTERN.exec(normalized);
  const frontmatter = match === null ? "" : (match[1] ?? "");
  const body = match === null ? normalized : normalized.slice(match[0].length);
  const meta = parseFrontmatter(frontmatter);

  const expression = normalizeOptionalString(meta.expression);
  if (expression === undefined) {
    throw invalidConfig("Cron job markdown requires an `expression` in its frontmatter.", { file: fileName });
  }
  const prompt = body.trim();
  if (prompt.length === 0) {
    throw invalidConfig("Cron job markdown requires a non-empty prompt body.", { file: fileName });
  }

  const id = normalizeOptionalString(meta.id) ?? stripMarkdownExtension(fileName);
  const timezone = normalizeOptionalString(meta.timezone) ?? DEFAULT_TIMEZONE;
  const enabled = readBoolean(meta.enabled, `${fileName} frontmatter \`enabled\``, true, invalidConfig);
  const conversationId = normalizeOptionalString(meta.conversationId);
  const maxRunMs = readOptionalPositiveInteger(meta.maxRunMs, `${fileName} frontmatter \`maxRunMs\``, fileName);
  const notify = readBoolean(meta.notify, `${fileName} frontmatter \`notify\``, false, invalidConfig);
  const notifyConversationId = normalizeOptionalString(meta.notifyConversationId);
  const notifyFailureCooldownHours = readOptionalPositiveInteger(
    meta.notifyFailureCooldownHours,
    `${fileName} frontmatter \`notifyFailureCooldownHours\``,
    fileName,
    "hours",
  );
  const model = normalizeOptionalString(meta.model);
  const effort = normalizeOptionalString(meta.effort);

  return {
    id,
    enabled,
    expression,
    timezone,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(maxRunMs === undefined ? {} : { maxRunMs }),
    ...(notify ? { notify } : {}),
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(notifyFailureCooldownHours === undefined ? {} : { notifyFailureCooldownHours }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * Parse flat `key: value` frontmatter lines. The value is everything after the
 * first colon, so a stepped cron expression (every five minutes, written with a
 * slash) survives unquoted, with one layer of surrounding quotes stripped. Blank
 * and `#` comment lines are ignored, as are lines without a colon.
 */
function parseFrontmatter(frontmatter: string): Record<string, string | undefined> {
  // Null-prototype so a `__proto__` (or `constructor`) key is stored as plain
  // data and can never pollute the prototype or shadow a real reader like
  // `meta.expression`.
  const meta: Record<string, string | undefined> = Object.create(null);
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (key.length === 0) {
      continue;
    }
    meta[key] = stripQuotes(line.slice(colon + 1).trim());
  }
  return meta;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripMarkdownExtension(fileName: string): string {
  return fileName.replace(/\.md$/iu, "");
}

function readOptionalPositiveInteger(
  value: string | undefined,
  field: string,
  fileName: string,
  unit = "milliseconds",
): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw invalidConfig(`${field} must be a positive integer number of ${unit}.`, { file: fileName, value });
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidConfig(`${field} must be a positive integer number of ${unit}.`, { file: fileName, value });
  }
  return parsed;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

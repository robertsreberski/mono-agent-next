import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeOptionalString, readBoolean } from "@mono-agent/agent-contracts";

import type { WebhookEndpointConfig } from "./config.js";
import { normalizePath, WebhookAdapterError, type WebhookInvocationMode } from "./server.js";

// Matches a leading YAML-style frontmatter block (`---` … `---`). Mirrors the
// shape used by cron-adapter's job files; webhook-adapter keeps a self-contained
// parser so it takes on no extra dependency. Frontmatter is flat scalars only.
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;
const MAX_RUN_MS = 86_400_000;

const invalidConfig = (message: string, details?: Record<string, unknown>): WebhookAdapterError =>
  new WebhookAdapterError("invalid_config", message, details);

/**
 * Load every `*.md` webhook endpoint in {@link dir}. A missing directory is not
 * an error (returns `[]`); files are read in sorted filename order for a stable
 * endpoint list. Two files that resolve to the same `name` are a hard error.
 */
export async function loadWebhookEndpointsFromDirectory(
  dir: string,
  defaultMode: WebhookInvocationMode,
): Promise<WebhookEndpointConfig[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw invalidConfig("Unable to read webhook endpoints directory.", { dir, reason: errorToMessage(error) });
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  const endpoints: WebhookEndpointConfig[] = [];
  const seenNames = new Map<string, string>();
  for (const name of files) {
    const filePath = join(dir, name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      throw invalidConfig("Unable to read webhook endpoint file.", { file: name, reason: errorToMessage(error) });
    }
    const endpoint = parseWebhookEndpointMarkdown(name, content, defaultMode);
    const prior = seenNames.get(endpoint.name);
    if (prior !== undefined) {
      throw invalidConfig(`Duplicate webhook endpoint name "${endpoint.name}" defined by ${prior} and ${name}.`, {
        name: endpoint.name,
        file: name,
      });
    }
    seenNames.set(endpoint.name, name);
    endpoints.push(endpoint);
  }
  return endpoints;
}

/**
 * Parse one webhook endpoint markdown file: frontmatter holds the routing
 * metadata and the markdown body is the `prompt` (pre-instructions). `name`
 * defaults to the filename stem, `mode` to the shared default, and `enabled` to
 * true. Unlike cron jobs, the body may be empty — an endpoint with no prompt
 * just forwards the posted text unchanged.
 */
export function parseWebhookEndpointMarkdown(
  fileName: string,
  content: string,
  defaultMode: WebhookInvocationMode,
): WebhookEndpointConfig {
  const normalized = content.replace(/\r\n?/g, "\n");
  const match = FRONTMATTER_PATTERN.exec(normalized);
  const frontmatter = match === null ? "" : (match[1] ?? "");
  const body = match === null ? normalized : normalized.slice(match[0].length);
  const meta = parseFrontmatter(frontmatter);

  const rawPath = normalizeOptionalString(meta.path);
  if (rawPath === undefined) {
    throw invalidConfig("Webhook endpoint markdown requires a `path` in its frontmatter.", { file: fileName });
  }
  const path = normalizePath(rawPath);
  const name = normalizeOptionalString(meta.name) ?? stripMarkdownExtension(fileName);
  const mode = normalizeMode(meta.mode, fileName) ?? defaultMode;
  const enabled = readBoolean(meta.enabled, `${fileName} frontmatter \`enabled\``, true, invalidConfig);
  const notify = readBoolean(meta.notify, `${fileName} frontmatter \`notify\``, false, invalidConfig);
  const notifyConversationId = normalizeOptionalString(meta.notifyConversationId);
  const model = normalizeOptionalString(meta.model);
  const effort = normalizeOptionalString(meta.effort);
  const maxRunMs = readOptionalMaxRunMs(meta.maxRunMs, fileName);
  const prompt = body.trim().length === 0 ? undefined : body.trim();

  return {
    name,
    path,
    mode,
    enabled,
    ...(notify ? { notify } : {}),
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(maxRunMs === undefined ? {} : { maxRunMs }),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

function normalizeMode(value: string | undefined, fileName: string): WebhookInvocationMode | undefined {
  const mode = normalizeOptionalString(value);
  if (mode === undefined) {
    return undefined;
  }
  if (mode !== "sync" && mode !== "async") {
    throw invalidConfig("Webhook endpoint `mode` must be sync or async.", { file: fileName, mode });
  }
  return mode;
}

/**
 * Parse flat `key: value` frontmatter lines, one layer of surrounding quotes
 * stripped. Blank and `#` comment lines are ignored, as are lines without a
 * colon. Null-prototype map so a `__proto__` key is inert data.
 */
function parseFrontmatter(frontmatter: string): Record<string, string | undefined> {
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

function readOptionalMaxRunMs(value: string | undefined, fileName: string): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw invalidConfig(`${fileName} frontmatter \`maxRunMs\` must be an integer from 0 to ${String(MAX_RUN_MS)} milliseconds.`, {
      file: fileName,
      value,
    });
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_RUN_MS) {
    throw invalidConfig(`${fileName} frontmatter \`maxRunMs\` must be an integer from 0 to ${String(MAX_RUN_MS)} milliseconds.`, {
      file: fileName,
      value,
    });
  }
  return parsed;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

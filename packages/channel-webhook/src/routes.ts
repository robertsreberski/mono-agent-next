import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseDocument } from "yaml";
import type { ChannelCompletionDelivery } from "@mono-agent/module-sdk";

import {
  MAX_RUN_MS,
  WebhookConfigError,
  parseWebhookMode,
  parseWebhookPath,
  type WebhookMode,
} from "./config.js";
import { MAX_WEBHOOK_ROUTE_PROMPT_LENGTH } from "./limits.js";

export const MAX_WEBHOOK_ROUTE_BYTES = 1024 * 1024;
export const MAX_WEBHOOK_ROUTES = 1_000;

export interface WebhookRoute {
  readonly name: string;
  readonly path: string;
  readonly mode: WebhookMode;
  readonly prompt: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly notify?: ChannelCompletionDelivery;
  readonly maxRunMs?: number;
  readonly source: string;
}

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;
const ROUTE_KEYS = new Set([
  "name",
  "path",
  "mode",
  "enabled",
  "runtime",
  "model",
  "effort",
  "notify",
  "maxRunMs",
]);

export async function loadWebhookRoutesFromDirectory(
  directory: string,
  defaultMode: WebhookMode,
): Promise<readonly WebhookRoute[]> {
  const directoryStats = await lstat(directory).catch((error: unknown) => {
    throw new WebhookConfigError(`Unable to inspect webhook routes directory ${directory}: ${errorMessage(error)}`);
  });
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new WebhookConfigError(`${directory} must be a real directory, not a symlink.`);
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    throw new WebhookConfigError(`Unable to read webhook routes directory ${directory}: ${errorMessage(error)}`);
  });
  const markdown = entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const unsafe = markdown.find((entry) => !entry.isFile());
  if (unsafe !== undefined) {
    throw new WebhookConfigError(`${join(directory, unsafe.name)} must be a regular Markdown file.`);
  }
  if (markdown.length === 0) {
    throw new WebhookConfigError(`${directory} must contain at least one enabled Markdown webhook route.`);
  }
  if (markdown.length > MAX_WEBHOOK_ROUTES) {
    throw new WebhookConfigError(`Webhook routes directory exceeds the ${String(MAX_WEBHOOK_ROUTES)} route limit.`);
  }
  const routes: WebhookRoute[] = [];
  for (const entry of markdown) {
    const path = join(directory, entry.name);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      throw new WebhookConfigError(`Unable to open webhook route ${path}: ${errorMessage(error)}`);
    });
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > MAX_WEBHOOK_ROUTE_BYTES) {
        throw new WebhookConfigError(`${path} must be a regular file no larger than ${String(MAX_WEBHOOK_ROUTE_BYTES)} bytes.`);
      }
      const route = parseWebhookRouteMarkdown(entry.name, await file.readFile("utf8"), defaultMode);
      if (route !== undefined) routes.push(Object.freeze({ ...route, source: path }));
    } finally {
      await file.close();
    }
  }
  if (routes.length === 0) {
    throw new WebhookConfigError(`${directory} must contain at least one enabled Markdown webhook route.`);
  }
  assertRoutesUnique(routes);
  return Object.freeze(routes);
}

export function parseWebhookRouteMarkdown(
  fileName: string,
  content: string,
  defaultMode: WebhookMode,
): WebhookRoute | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (match === null) {
    throw new WebhookConfigError(`${fileName} must begin with a YAML frontmatter block.`);
  }
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new WebhookConfigError(`${fileName} frontmatter is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  const metadata = record(document.toJS({ maxAliasCount: 0 }) as unknown, `${fileName} frontmatter`);
  exact(metadata, ROUTE_KEYS, `${fileName} frontmatter`);
  const enabled = optionalBoolean(metadata.enabled, true, `${fileName} enabled`);
  const name = metadata.name === undefined
    ? basename(fileName, ".md")
    : string(metadata.name, `${fileName} name`, 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) {
    throw new WebhookConfigError(`${fileName} name must match ^[a-z0-9][a-z0-9._-]{0,127}$.`);
  }
  if (metadata.path === undefined) {
    throw new WebhookConfigError(`${fileName} path is required.`);
  }
  const path = parseWebhookPath(metadata.path);
  const mode = metadata.mode === undefined ? defaultMode : parseWebhookMode(metadata.mode);
  const prompt = normalized.slice(match[0].length).trim();
  if (
    prompt.length > MAX_WEBHOOK_ROUTE_PROMPT_LENGTH
    || Buffer.byteLength(prompt, "utf8") > MAX_WEBHOOK_ROUTE_BYTES
  ) {
    throw new WebhookConfigError(`${fileName} prompt exceeds the route prompt limit.`);
  }
  const runtime = optionalString(metadata.runtime, `${fileName} runtime`);
  const model = optionalString(metadata.model, `${fileName} model`);
  const effort = optionalString(metadata.effort, `${fileName} effort`);
  const notify = parseWebhookNotify(metadata.notify, `${fileName} notify`);
  const maxRunMs = optionalInteger(metadata.maxRunMs, `${fileName} maxRunMs`, 1, MAX_RUN_MS);
  if (!enabled) return undefined;
  return Object.freeze({
    name,
    path,
    mode,
    prompt,
    ...(runtime === undefined ? {} : { runtime }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(notify === undefined ? {} : { notify }),
    ...(maxRunMs === undefined ? {} : { maxRunMs }),
    source: fileName,
  });
}

export function parseWebhookNotify(
  value: unknown,
  label = "notify",
): ChannelCompletionDelivery | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return Object.freeze({ channel: string(value, label) });
  const input = record(value, label);
  exact(input, new Set(["channel", "destination"]), label);
  const destination = input.destination === undefined
    ? undefined
    : string(input.destination, `${label}.destination`, 4_096);
  return Object.freeze({
    channel: string(input.channel, `${label}.channel`),
    ...(destination === undefined ? {} : { destination }),
  });
}

export function assertRoutesUnique(routes: readonly WebhookRoute[]): void {
  const names = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const route of routes) {
    const priorName = names.get(route.name);
    if (priorName !== undefined) {
      throw new WebhookConfigError(`Duplicate webhook route name "${route.name}" in ${priorName} and ${route.source}.`);
    }
    const priorPath = paths.get(route.path);
    if (priorPath !== undefined) {
      throw new WebhookConfigError(`Duplicate webhook route path "${route.path}" in ${priorPath} and ${route.source}.`);
    }
    names.set(route.name, route.source);
    paths.set(route.path, route.source);
  }
  for (const route of routes) {
    for (const other of routes) {
      if (route === other) continue;
      if (other.path === `${route.path}/requests` || other.path.startsWith(`${route.path}/requests/`)) {
        throw new WebhookConfigError(`Webhook route path "${other.path}" conflicts with the status namespace for "${route.path}".`);
      }
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebhookConfigError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WebhookConfigError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.has(key)).sort();
  if (unknown.length > 0) throw new WebhookConfigError(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
}

function string(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > max
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WebhookConfigError(`${label} must be a non-empty bounded string without surrounding whitespace.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new WebhookConfigError(`${label} must be a boolean.`);
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WebhookConfigError(`${label} must be an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return value as number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

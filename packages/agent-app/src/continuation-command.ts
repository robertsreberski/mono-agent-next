import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadAppCoreConfig } from "./app-config.js";
import { loadContinuationSettings } from "./continuation-config.js";
import { continuationOperatorToken } from "./continuation-service.js";
import type { ContinuationHealthSnapshot, ContinuationStatusSnapshot } from "./continuations.js";

export interface RunContinuationCommandOptions {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly positionals: readonly string[];
  readonly json?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly fetchImpl?: typeof fetch;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

/** Authenticated operator client. It never opens or rewrites the state ledger directly. */
export async function runContinuationCommand(options: RunContinuationCommandOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let settings;
  let continuationServers: readonly string[] | undefined;
  try {
    const [resolvedSettings, coreConfig] = await Promise.all([
      loadContinuationSettings({
        cwd: options.cwd,
        configPath: options.configPath,
        env: options.env,
      }),
      loadAppCoreConfig({
        cwd: options.cwd,
        configPath: options.configPath,
        env: options.env,
      }),
    ]);
    settings = resolvedSettings;
    continuationServers = coreConfig.tools.continuationServers;
  } catch (error) {
    stderr(`Continuation configuration error: ${reasonOf(error)}\n`);
    return 1;
  }
  if (!settings.configured && (continuationServers?.length ?? 0) === 0) {
    stderr("Continuations are not configured in mono-agent.config.json.\n");
    return 1;
  }
  let token: string;
  try {
    token = continuationOperatorToken(await readOwnerSecret(join(settings.stateDir, "continuation-secret")));
  } catch (error) {
    stderr(`Continuation operator credentials are unavailable: ${reasonOf(error)}\n`);
    return 1;
  }
  const [action = "list", id, resolution, deliveryId, ...extra] = options.positionals;
  const invalidPage = (options.limit !== undefined || options.cursor !== undefined) && action !== "list";
  const invalidLimit = options.limit !== undefined
    && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500);
  const invalidCursor = options.cursor !== undefined
    && (options.cursor.length === 0 || options.cursor.length > 512);
  if (extra.length > 0 || invalidPage || invalidLimit || invalidCursor || !validUsage(action, id, resolution)) {
    stderr("Usage: mono-agent continuations [list [--limit <n>] [--cursor <opaque>]|health|retry <id>|cancel <id>|resolve <id> delivered|not-delivered|dead-lettered [delivery-id]] [--json]\n");
    return 2;
  }
  const baseUrl = `http://${formatHost(settings.host)}:${String(settings.port)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await request(
      fetchImpl,
      baseUrl,
      token,
      action,
      id,
      resolution,
      deliveryId,
      options.limit,
      options.cursor,
    );
    const body = await response.json() as unknown;
    if (!response.ok) {
      stderr(`Continuation command failed (${String(response.status)}): ${errorMessage(body)}\n`);
      return 1;
    }
    if (options.json === true) {
      stdout(`${JSON.stringify(body, null, 2)}\n`);
      return 0;
    }
    stdout(renderHuman(action, body));
    return 0;
  } catch (error) {
    stderr(`Continuation service is unavailable at ${baseUrl}: ${reasonOf(error)}\n`);
    return 1;
  }
}

async function request(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  action: string,
  id?: string,
  resolution?: string,
  deliveryId?: string,
  limit?: number,
  cursor?: string,
): Promise<Response> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (action === "list") {
    const url = new URL(`${baseUrl}/v1/operator/continuations`);
    if (limit !== undefined) url.searchParams.set("limit", String(limit));
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    return await fetchImpl(url, { headers });
  }
  if (action === "health") return await fetchImpl(`${baseUrl}/v1/operator/health`, { headers });
  if (action === "retry" || action === "cancel") {
    return await fetchImpl(`${baseUrl}/v1/operator/continuations/${encodeURIComponent(id as string)}/${action}`, {
      method: "POST",
      headers,
      body: "{}",
    });
  }
  const kind = resolution === "not-delivered"
    ? "not_delivered"
    : resolution === "dead-lettered"
      ? "dead_lettered"
      : "delivered";
  return await fetchImpl(`${baseUrl}/v1/operator/continuations/${encodeURIComponent(id as string)}/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind, ...(kind === "delivered" && deliveryId !== undefined ? { deliveryId } : {}) }),
  });
}

function validUsage(action: string, id: string | undefined, resolution: string | undefined): boolean {
  if (action === "list" || action === "health") return id === undefined && resolution === undefined;
  if (action === "retry" || action === "cancel") return id !== undefined && resolution === undefined;
  if (action !== "resolve" || id === undefined) return false;
  return resolution === "delivered" || resolution === "not-delivered" || resolution === "dead-lettered";
}

function renderHuman(action: string, body: unknown): string {
  if (action === "list") {
    const continuations = isObject(body) && Array.isArray(body.continuations)
      ? body.continuations as ContinuationStatusSnapshot[]
      : [];
    if (continuations.length === 0) return "No continuations recorded.\n";
    const nextCursor = isObject(body) && typeof body.nextCursor === "string" ? body.nextCursor : undefined;
    return [
      "CONTINUATION                           STATE               MODE                  UPDATED",
      ...continuations.map((item) => [
        item.continuationId.padEnd(38),
        item.state.padEnd(19),
        item.mode.padEnd(21),
        item.updatedAt,
      ].join(" ")),
      ...(nextCursor === undefined
        ? []
        : [`More records are available. Continue with: mono-agent continuations list --cursor ${nextCursor}`]),
      "",
    ].join("\n");
  }
  if (action === "health") {
    const health = body as ContinuationHealthSnapshot;
    return `Continuation health: ${health.status}; pending=${String(health.pending)} due=${String(health.due)} delivery_unknown=${String(health.counts?.delivery_unknown ?? 0)} dead_lettered=${String(health.counts?.dead_lettered ?? 0)} history_degraded=${String(health.storage?.historyDegraded ?? 0)}\n`;
  }
  const status = body as ContinuationStatusSnapshot;
  return `${status.continuationId}: ${status.state}${status.receipt?.deliveryId === undefined ? "" : ` (${status.receipt.deliveryId})`}\n`;
}

async function readOwnerSecret(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("secret path is not a regular file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("secret is not owned by the current user");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("secret permissions are not owner-only");
  const secret = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
  if (secret.length !== 32) throw new Error("secret contents are invalid");
  return secret;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function errorMessage(body: unknown): string {
  if (!isObject(body) || !isObject(body.error) || typeof body.error.message !== "string") return "unknown error";
  return body.error.message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

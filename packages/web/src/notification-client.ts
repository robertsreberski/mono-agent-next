import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { WebNotificationTriggerKind } from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import { resolveWebStatePaths, type WebStatePathOptions } from "./state-paths.js";

const NOTIFICATION_INGRESS_SCHEMA = 1;
const NOTIFICATION_INGRESS_PATH = "/internal/v1/notifications";
const MAX_INGRESS_RECORD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface DeliverWebNotificationInput {
  readonly sourceId: string;
  readonly triggerKind: WebNotificationTriggerKind;
  readonly deliveryKey: string;
  readonly text: string;
}

export interface DeliverWebNotificationOptions extends WebStatePathOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface DeliverWebNotificationResult {
  readonly threadId: string;
  readonly duplicate: boolean;
}

interface NotificationIngressRecord {
  readonly schema: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly url: string;
  readonly token: string;
  readonly updatedAt: string;
}

/** Deliver once to the active local web console. There is intentionally no retry or outbox. */
export async function deliverWebNotification(
  input: DeliverWebNotificationInput,
  options: DeliverWebNotificationOptions = {},
): Promise<DeliverWebNotificationResult> {
  const path = resolveWebStatePaths(options).notificationIngress;
  const ingress = await readIngressRecord(path);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(ingress.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${ingress.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new WebConsoleError(
      "notification_ingress_unavailable",
      `The web notification ingress is unavailable (${errorMessage(error)}).`,
      503,
    );
  }
  const bodyText = await readBoundedResponse(response);
  if (!response.ok) {
    throw new WebConsoleError(
      "notification_delivery_failed",
      `The web notification ingress responded ${String(response.status)}${bodyText.length === 0 ? "." : `: ${bodyText.slice(0, 300)}`}`,
      502,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new WebConsoleError("invalid_notification_response", "The web notification ingress returned invalid JSON.", 502);
  }
  const result = asRecord(parsed);
  if (result === undefined || typeof result.threadId !== "string" || typeof result.duplicate !== "boolean") {
    throw new WebConsoleError("invalid_notification_response", "The web notification ingress returned an invalid result.", 502);
  }
  return { threadId: result.threadId, duplicate: result.duplicate };
}

async function readIngressRecord(path: string): Promise<NotificationIngressRecord> {
  const info = await lstat(path).catch(() => undefined);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (info === undefined || !info.isFile() || info.isSymbolicLink()
    || info.size <= 0 || info.size > MAX_INGRESS_RECORD_BYTES
    || (currentUid !== undefined && info.uid !== currentUid)
    || (info.mode & 0o077) !== 0) {
    throw new WebConsoleError(
      "notification_ingress_unavailable",
      "The owner-private web notification ingress record is unavailable.",
      503,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress record changed while opening.", 503);
    }
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress record is invalid.", 503);
  }
  const record = asRecord(parsed);
  if (record === undefined
    || record.schema !== NOTIFICATION_INGRESS_SCHEMA
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.instanceId !== "string" || record.instanceId.length === 0 || record.instanceId.length > 128
    || typeof record.url !== "string"
    || typeof record.token !== "string" || record.token.length < 32 || record.token.length > 256
    || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress record is invalid.", 503);
  }
  assertTrustedIngressUrl(record.url);
  return record as unknown as NotificationIngressRecord;
}

function assertTrustedIngressUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress URL is invalid.", 503);
  }
  if (url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.port.length === 0
    || url.pathname !== NOTIFICATION_INGRESS_PATH
    || url.search.length > 0
    || url.hash.length > 0
    || url.username.length > 0
    || url.password.length > 0) {
    throw new WebConsoleError("notification_ingress_unavailable", "The web notification ingress URL is not trusted.", 503);
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new WebConsoleError("invalid_notification_response", "The web notification response is too large.", 502);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";

import {
  bearerTokensEqual,
  close,
  listen,
  readAuthorizationBearer,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import { WEB_MAX_TURN_TEXT_CHARACTERS, type WebNotificationTriggerKind } from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import type { WebService, WebServiceLogger } from "./service.js";

const INGRESS_SCHEMA = 1;
const INGRESS_HOST = "127.0.0.1";
const INGRESS_PATH = "/internal/v1/notifications";
const MAX_INGRESS_BODY_BYTES = 2 * 1024 * 1024;
const MAX_INGRESS_RECORD_BYTES = 64 * 1024;

export interface WebNotificationIngressRecord {
  readonly schema: typeof INGRESS_SCHEMA;
  readonly pid: number;
  readonly instanceId: string;
  readonly url: string;
  readonly token: string;
  readonly updatedAt: string;
}

export interface WebNotificationIngressHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startWebNotificationIngress(
  service: WebService,
  logger?: WebServiceLogger,
): Promise<WebNotificationIngressHandle> {
  const token = randomBytes(32).toString("base64url");
  const instanceId = randomUUID();
  const app = express();
  const server = createServer(app);
  const active = new Set<Promise<unknown>>();
  let stopPromise: Promise<void> | undefined;

  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  app.disable("x-powered-by");

  app.post(INGRESS_PATH, express.json({ limit: MAX_INGRESS_BODY_BYTES, strict: true }), (req, res, next) => {
    const presented = readAuthorizationBearer(req.header("authorization"));
    if (presented === undefined || !bearerTokensEqual(presented, token)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } });
      return;
    }
    let input: ReturnType<typeof parseNotificationRequest>;
    try {
      input = parseNotificationRequest(req.body);
    } catch (error) {
      next(error);
      return;
    }
    const delivery = service.deliverNotification(input);
    active.add(delivery);
    void delivery.finally(() => active.delete(delivery)).catch(() => undefined);
    void delivery.then((result) => {
      res.status(result.duplicate ? 200 : 201).json({
        threadId: result.thread.id,
        duplicate: result.duplicate,
      });
    }).catch(next);
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const known = error instanceof WebConsoleError;
    const syntax = error instanceof SyntaxError && (error as { status?: unknown }).status === 400;
    const tooLarge = typeof error === "object" && error !== null
      && ((error as { status?: unknown }).status === 413 || (error as { type?: unknown }).type === "entity.too.large");
    const status = known ? error.status : tooLarge ? 413 : syntax ? 400 : 500;
    const code = known ? error.code : tooLarge ? "request_too_large" : syntax ? "invalid_json" : "internal_error";
    if (status >= 500) logger?.error?.("Web notification ingress failed.", { error: errorMessage(error) });
    res.status(status).json({
      error: {
        code,
        message: known || syntax ? errorMessage(error) : "Internal server error.",
      },
    });
  });

  const address = await listen(server, 0, INGRESS_HOST, {
    listenFailed: (reason) => new WebConsoleError(
      "notification_ingress_start_failed",
      `Web notification ingress failed to listen: ${reason}`,
      500,
    ),
    noAddress: () => new WebConsoleError(
      "notification_ingress_start_failed",
      "Web notification ingress did not receive a TCP address.",
      500,
    ),
  });
  const url = `http://${INGRESS_HOST}:${address.port}${INGRESS_PATH}`;
  const record: WebNotificationIngressRecord = {
    schema: INGRESS_SCHEMA,
    pid: process.pid,
    instanceId,
    url,
    token,
    updatedAt: new Date().toISOString(),
  };
  try {
    await publishIngressRecord(service.store.paths.notificationIngress, record);
  } catch (error) {
    await close(server);
    throw error;
  }

  return {
    url,
    stop() {
      stopPromise ??= (async () => {
        try {
          await close(server);
          await Promise.allSettled([...active]);
        } finally {
          await removeOwnIngressRecord(service.store.paths.notificationIngress, instanceId);
        }
      })();
      return stopPromise;
    },
  };
}

function parseNotificationRequest(body: unknown): {
  readonly sourceId: string;
  readonly triggerKind: WebNotificationTriggerKind;
  readonly deliveryKey: string;
  readonly text: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebConsoleError("invalid_notification", "Notification body must be a JSON object.", 400);
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["sourceId", "triggerKind", "deliveryKey", "text"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new WebConsoleError("invalid_notification", "Notification body contains unsupported fields.", 400);
  }
  const sourceId = normalizedField(record.sourceId, "sourceId", 512);
  const deliveryKey = normalizedField(record.deliveryKey, "deliveryKey", 1_024);
  if (record.triggerKind !== "cron" && record.triggerKind !== "webhook") {
    throw new WebConsoleError("invalid_notification", "triggerKind must be 'cron' or 'webhook'.", 400);
  }
  if (typeof record.text !== "string" || record.text.trim().length === 0) {
    throw new WebConsoleError("invalid_notification", "text is required.", 400);
  }
  if (record.text.length > WEB_MAX_TURN_TEXT_CHARACTERS) {
    throw new WebConsoleError("invalid_notification", "Notification text exceeds the web text limit.", 413);
  }
  return { sourceId, triggerKind: record.triggerKind, deliveryKey, text: record.text };
}

function normalizedField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new WebConsoleError("invalid_notification", `${name} is required.`, 400);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new WebConsoleError(
      "invalid_notification",
      `${name} must contain 1 to ${String(maxLength)} characters.`,
      400,
    );
  }
  return normalized;
}

async function publishIngressRecord(path: string, record: WebNotificationIngressRecord): Promise<void> {
  const temporary = `${path}.${record.instanceId}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeOwnIngressRecord(path: string, instanceId: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.size > MAX_INGRESS_RECORD_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return;
  }
  const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  if (record?.instanceId === instanceId) await unlink(path).catch(() => undefined);
}

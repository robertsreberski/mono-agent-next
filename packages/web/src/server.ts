import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { hostname as systemHostname } from "node:os";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  closeServerBounded,
  hostForUrl,
  listen,
  normalizeHostForBind,
  type ChannelAskAnswer,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  WEB_API_VERSION,
  WEB_MAX_TURN_TEXT_CHARACTERS,
  type CreateWebThreadInput,
  type CreateWebUploadInput,
  type PatchWebAgentInput,
  type PatchWebThreadInput,
  type StartWebLiveInputInput,
  type StartWebTurnInput,
  type WebEvent,
} from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import {
  startWebNotificationIngress,
  type WebNotificationIngressHandle,
} from "./notification-ingress.js";
import { WebService, type CreateWebServiceOptions } from "./service.js";

export const DEFAULT_WEB_HOST = "0.0.0.0";
export const DEFAULT_WEB_PORT = 5050;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_SSE_CLIENTS = 64;

export interface StartWebServerOptions extends CreateWebServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly staticDir?: string;
  /** Exact additional DNS hostnames accepted at the browser boundary (for example this node's Tailscale DNSName). */
  readonly allowedHosts?: readonly string[];
}

export interface WebServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly boundAddress: string;
  readonly stateDir: string;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function startWebServer(options: StartWebServerOptions = {}): Promise<WebServerHandle> {
  const host = normalizeHostForBind(options.host ?? DEFAULT_WEB_HOST);
  const port = normalizePort(options.port ?? DEFAULT_WEB_PORT);
  const staticDir = options.staticDir ?? defaultStaticDir();
  const logger = options.logger;
  // Validate all synchronous startup inputs before acquiring the persistent
  // service lease so an embedding typo cannot strand SQLite ownership.
  const allowedHosts = resolveAllowedHosts(options.allowedHosts, options.env ?? process.env);
  const service = await WebService.create(options);
  const app = express();
  const server = createServer(app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 5 * 60_000;
  server.keepAliveTimeout = 5_000;
  const activeStreams = new Set<() => void>();
  const activeOperations = new Set<Promise<unknown>>();
  let notificationIngress: WebNotificationIngressHandle | undefined;
  let stopPromise: Promise<void> | undefined;

  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(validateLocalRequest(host, allowedHosts));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    next();
  });
  app.use("/api/v1", express.json({ limit: "256kb", strict: true }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", version: WEB_API_VERSION });
  });

  app.get("/api/v1/bootstrap", (_req, res, next) => {
    void service.bootstrap().then((bootstrap) => res.status(200).json(bootstrap)).catch(next);
  });

  app.patch("/api/v1/agents/:id", (req, res, next) => {
    try {
      const input = parsePatchAgent(req.body);
      res.status(200).json({ agent: service.patchAgent(pathParam(req.params.id), input) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/threads", (req, res, next) => {
    try {
      const input = parseCreateThread(req.body);
      res.status(201).json({ thread: service.createThread(input.sourceId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:id", (req, res, next) => {
    try {
      res.status(200).json(service.thread(pathParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/v1/threads/:id", (req, res, next) => {
    try {
      const input = parsePatchThread(req.body);
      res.status(200).json({ thread: service.patchThread(pathParam(req.params.id), input) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/threads/:id", (req, res, next) => {
    void trackOperation(service.deleteThread(pathParam(req.params.id)), activeOperations)
      .then(() => res.status(204).end())
      .catch(next);
  });

  app.post("/api/v1/threads/:id/turns", (req, res, next) => {
    let input: StartWebTurnInput;
    let threadId: string;
    try {
      input = parseTurn(req.body);
      threadId = pathParam(req.params.id);
    } catch (error) {
      next(error);
      return;
    }
    void trackOperation(service.startTurn(threadId, input), activeOperations)
      .then((started) => res.status(202).json(started))
      .catch(next);
  });

  app.post("/api/v1/threads/:id/live-input", (req, res, next) => {
    try {
      const input = parseLiveInput(req.body);
      res.status(202).json(service.submitLiveInput(pathParam(req.params.id), input.text));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/threads/:id/cancel", (req, res, next) => {
    const threadId = pathParam(req.params.id);
    void trackOperation(service.cancelTurn(threadId), activeOperations)
      .then((thread) => res.status(202).json({ cancelled: true, thread }))
      .catch(next);
  });

  app.get("/api/v1/threads/:id/ask", (req, res, next) => {
    void trackOperation(service.pendingAsk(pathParam(req.params.id)), activeOperations)
      .then((ask) => res.status(200).json({ ask: ask ?? null }))
      .catch(next);
  });

  app.post("/api/v1/threads/:id/ask", (req, res, next) => {
    const body = typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : {};
    if (typeof body.interactionId !== "string" || !Array.isArray(body.answers)) {
      next(new WebConsoleError("invalid_ask_answer", "interactionId and answers are required.", 400));
      return;
    }
    void trackOperation(
      service.submitAsk(
        pathParam(req.params.id),
        body.interactionId,
        body.answers as readonly ChannelAskAnswer[],
      ),
      activeOperations,
    ).then((result) => res.status(200).json(result)).catch(next);
  });

  app.post("/api/v1/uploads", (req, res, next) => {
    try {
      const input = parseCreateUpload(req.body);
      res.status(201).json({ attachment: service.createUpload(input) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/v1/uploads/:id/content", (req, res, next) => {
    void trackOperation(handleUploadContent(req, res, service), activeOperations).catch(next);
  });

  app.delete("/api/v1/uploads/:id", (req, res, next) => {
    void trackOperation(service.removeUpload(pathParam(req.params.id)), activeOperations)
      .then(() => res.status(204).end())
      .catch(next);
  });

  app.get("/api/v1/uploads/:id/content", (req, res, next) => {
    void trackOperation(handleDownloadContent(pathParam(req.params.id), res, service), activeOperations).catch(next);
  });

  app.get("/api/v1/events", (_req, res) => {
    if (activeStreams.size >= MAX_SSE_CLIENTS) {
      res.status(503).json({ error: { code: "sse_capacity", message: "Too many event streams are connected." } });
      return;
    }
    let closed = false;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      activeStreams.delete(closeStream);
      res.end();
    };
    const send = (event: WebEvent): boolean => {
      if (closed || res.writableEnded) return false;
      const writable = res.write(formatSse(event));
      if (!writable) {
        // Events are state-invalidation hints, not an unbounded replay log. A
        // client that cannot drain one frame must reconnect and bootstrap.
        closeStream();
        return false;
      }
      return true;
    };
    const unsubscribe = service.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.write(`: heartbeat ${Date.now()}\n\n`)) closeStream();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    activeStreams.add(closeStream);
    res.once("close", closeStream);
    send(service.readyEvent());
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
  });

  app.use(express.static(staticDir, { fallthrough: true, index: false, redirect: false }));
  app.get("/{*splat}", (_req, res, next) => {
    // Keep the managed runtime's hidden ~/.mono-agent parent out of the
    // request-relative path. Express otherwise applies its dotfile policy to
    // the absolute path and rejects an existing index.html as Not Found.
    res.sendFile("index.html", { root: staticDir }, (error) => {
      if (error !== undefined && error !== null) next(error);
    });
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
    if (status >= 500) logger?.error?.("Web console request failed.", { error: errorMessage(error) });
    res.status(status).json({
      error: {
        code,
        message: known || syntax ? errorMessage(error) : "Internal server error.",
        ...(known && error.details !== undefined ? { details: error.details } : {}),
      },
    });
  });

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      let ingressFailure: unknown;
      try {
        await notificationIngress?.stop();
      } catch (error) {
        ingressFailure = error;
      }
      for (const closeStream of [...activeStreams]) closeStream();
      try {
        await closeServerBounded(server, 500);
        await Promise.allSettled([...activeOperations]);
      } finally {
        await service.stop();
      }
      if (ingressFailure !== undefined) throw ingressFailure;
    })();
    return stopPromise;
  };

  try {
    const address = await listen(server, port, host, {
      listenFailed: (reason) => new WebConsoleError("listen_failed", `Web console failed to listen: ${reason}`, 500),
      noAddress: () => new WebConsoleError("listen_failed", "Web console did not receive a TCP address.", 500),
    });
    notificationIngress = await startWebNotificationIngress(service, logger);
    const url = `http://${hostForUrl(host)}:${address.port}/`;
    return {
      url,
      host,
      port: address.port,
      boundAddress: address.address,
      stateDir: service.store.paths.root,
      stop,
      close: stop,
    };
  } catch (error) {
    await notificationIngress?.stop().catch(() => undefined);
    if (server.listening) await closeServerBounded(server, 500).catch(() => undefined);
    await service.stop();
    throw error;
  }
}

function trackOperation<T>(operation: Promise<T>, active: Set<Promise<unknown>>): Promise<T> {
  active.add(operation);
  void operation.finally(() => active.delete(operation)).catch(() => undefined);
  return operation;
}

async function handleUploadContent(req: Request, res: Response, service: WebService): Promise<void> {
  const contentEncoding = req.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    throw new WebConsoleError("unsupported_content_encoding", "Compressed upload bodies are not accepted.", 415);
  }
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
    throw new WebConsoleError("invalid_upload_content_type", "Upload bytes with Content-Type: application/octet-stream.", 415);
  }
  const declaredLength = parseContentLength(req.headers["content-length"]);
  const reservation = service.reserveUpload(pathParam(req.params.id));
  if (declaredLength !== undefined && declaredLength > reservation.maxBytes) {
    reservation.release();
    throw new WebConsoleError("attachment_too_large", "Attachment exceeds the 20 MiB file limit.", 413);
  }
  if (declaredLength !== undefined && reservation.attachment.sizeBytes > 0 && declaredLength !== reservation.attachment.sizeBytes) {
    reservation.release();
    throw new WebConsoleError("attachment_size_mismatch", "Upload size does not match the declared file size.", 400);
  }
  const destination = service.store.attachmentPath(reservation.attachment);
  const temporary = `${destination}.partial-${randomUUID()}`;
  let moved = false;
  try {
    const sizeBytes = await writeBoundedRequest(req, temporary, reservation.maxBytes);
    if (reservation.attachment.sizeBytes > 0 && sizeBytes !== reservation.attachment.sizeBytes) {
      throw new WebConsoleError("attachment_size_mismatch", "Upload size does not match the declared file size.", 400);
    }
    await rename(temporary, destination);
    moved = true;
    await chmod(destination, 0o600);
    const attachment = service.completeUpload(reservation.attachment.id, sizeBytes);
    res.status(200).json({ attachment });
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (moved) await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    reservation.release();
  }
}

async function writeBoundedRequest(req: Request, path: string, maxBytes: number): Promise<number> {
  const handle = await open(path, "wx", 0o600);
  let total = 0;
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new WebConsoleError("attachment_too_large", "Attachment exceeds the 20 MiB file limit.", 413);
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new WebConsoleError("upload_write_failed", "Upload storage made no write progress.", 500);
        offset += bytesWritten;
      }
    }
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.size !== total) {
      throw new WebConsoleError("upload_write_failed", "Stored upload size did not match the received bytes.", 500);
    }
    return total;
  } finally {
    await handle.close();
  }
}

async function handleDownloadContent(id: string, res: Response, service: WebService): Promise<void> {
  const attachment = service.storedAttachment(id);
  if (!attachment.uploaded) throw new WebConsoleError("attachment_not_ready", "Attachment upload is incomplete.", 409);
  const path = service.store.attachmentPath(attachment);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new WebConsoleError("attachment_integrity", `Attachment content is unavailable (${errorMessage(error)}).`, 409);
  }
  const info = await handle.stat();
  if (!info.isFile() || info.size !== attachment.sizeBytes) {
    await handle.close();
    throw new WebConsoleError("attachment_integrity", "Attachment content is unavailable.", 409);
  }
  const image = attachment.kind === "image";
  res.status(200);
  res.setHeader("Content-Type", image ? attachment.contentType : "application/octet-stream");
  res.setHeader("Content-Length", String(info.size));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", contentDisposition(attachment.name, image ? "inline" : "attachment"));
  const stream = handle.createReadStream({ autoClose: false });
  await pipeline(stream, res).finally(async () => handle.close());
}

function validateLocalRequest(
  configuredHost: string,
  additionalHosts: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next): void => {
    try {
      const host = normalizedAuthority(req.headers.host);
      if (!isAllowedWebHostname(host.hostname, configuredHost, systemHostname(), additionalHosts)) {
        throw new WebConsoleError("untrusted_host", "This Host is not allowed for the local web console.", 421);
      }
      if (isMutation(req.method)) {
        if (req.headers["sec-fetch-site"] === "cross-site") {
          throw new WebConsoleError("cross_site_request", "Cross-site mutations are not allowed.", 403);
        }
        const rawOrigin = req.headers.origin;
        if (rawOrigin !== undefined) {
          let origin: URL;
          try {
            origin = new URL(rawOrigin);
          } catch {
            throw new WebConsoleError("invalid_origin", "Request Origin is invalid.", 403);
          }
          if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.host.toLowerCase() !== host.authority) {
            throw new WebConsoleError("origin_mismatch", "Cross-origin mutations are not allowed.", 403);
          }
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function isAllowedWebHostname(
  hostname: string,
  configuredHost: string,
  machineHostname = systemHostname(),
  additionalHosts: readonly string[] = [],
): boolean {
  const normalizedMachine = normalizeAllowedHostname(machineHostname);
  const allowedConfiguredNames = new Set<string>([
    normalizedMachine,
    `${normalizedMachine}.local`,
    ...additionalHosts.map(normalizeAllowedHostname),
  ]);
  const normalizedConfigured = configuredHost.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(normalizedConfigured) === 0 && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu.test(normalizedConfigured)) {
    allowedConfiguredNames.add(normalizedConfigured);
  }
  return isAllowedLocalHostname(hostname, allowedConfiguredNames);
}

function normalizedAuthority(value: string | undefined): { readonly authority: string; readonly hostname: string } {
  if (value === undefined || value.trim().length === 0 || /[\s/@\\]/u.test(value)) {
    throw new WebConsoleError("invalid_host", "Request Host is invalid.", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new WebConsoleError("invalid_host", "Request Host is invalid.", 400);
  }
  return {
    authority: parsed.host.toLowerCase(),
    hostname: parsed.hostname.toLowerCase().replace(/\.$/u, ""),
  };
}

function isAllowedLocalHostname(hostname: string, allowedConfiguredNames: ReadonlySet<string>): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const ipKind = isIP(unwrapped);
  if (ipKind === 4) return isPrivateIpv4(unwrapped);
  if (ipKind === 6) {
    const normalized = unwrapped.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return unwrapped === "localhost"
    || unwrapped.endsWith(".localhost")
    || allowedConfiguredNames.has(unwrapped);
}

function resolveAllowedHosts(
  configured: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const fromEnv = env?.MONO_AGENT_WEB_ALLOWED_HOSTS?.split(",") ?? [];
  return [...new Set([...(configured ?? []), ...fromEnv]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(normalizeAllowedHostname))];
}

function normalizeAllowedHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  if (normalized.length === 0
    || normalized.includes(":")
    || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(normalized)) {
    throw new WebConsoleError("invalid_allowed_host", `Invalid allowed web hostname: ${value}`, 400);
  }
  return normalized;
}

function isPrivateIpv4(value: string): boolean {
  const [first = -1, second = -1] = value.split(".").map(Number);
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
}

function parseCreateThread(value: unknown): CreateWebThreadInput {
  const body = requireRecord(value);
  return { sourceId: requireString(body.sourceId, "sourceId", 256) };
}

function parsePatchAgent(value: unknown): PatchWebAgentInput {
  const body = requireRecord(value);
  if (typeof body.pinned !== "boolean") throw invalidBody("pinned must be boolean.");
  return { pinned: body.pinned };
}

function parsePatchThread(value: unknown): PatchWebThreadInput {
  const body = requireRecord(value);
  const title = optionalString(body.title, "title", 120);
  const archived = body.archived;
  if (archived !== undefined && typeof archived !== "boolean") throw invalidBody("archived must be boolean.");
  if (title === undefined && archived === undefined) throw invalidBody("Provide title or archived.");
  return { ...(title === undefined ? {} : { title }), ...(archived === undefined ? {} : { archived }) };
}

function parseTurn(value: unknown): StartWebTurnInput {
  const body = requireRecord(value);
  const text = body.text === undefined
    ? undefined
    : requireString(body.text, "text", WEB_MAX_TURN_TEXT_CHARACTERS, true);
  const quoteBody = body.quote === undefined ? undefined : requireRecord(body.quote);
  const quote = quoteBody === undefined
    ? undefined
    : {
        text: requireString(
          quoteBody.text,
          "quote.text",
          WEB_MAX_TURN_TEXT_CHARACTERS,
        ),
        messageId: requireString(quoteBody.messageId, "quote.messageId", 256),
      };
  const attachmentIds = body.attachmentIds;
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || !attachmentIds.every((id) => typeof id === "string" && id.length > 0))) {
    throw invalidBody("attachmentIds must be an array of ids.");
  }
  const model = optionalString(body.model, "model", 512);
  const effort = optionalString(body.effort, "effort", 128);
  return {
    ...(text === undefined ? {} : { text }),
    ...(quote === undefined ? {} : { quote }),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function parseLiveInput(value: unknown): StartWebLiveInputInput {
  const body = requireRecord(value);
  return {
    text: requireString(body.text, "text", AGENT_LIVE_INPUT_MAX_CHARACTERS),
  };
}

function parseCreateUpload(value: unknown): CreateWebUploadInput {
  const body = requireRecord(value);
  const sizeBytes = body.sizeBytes;
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)) {
    throw invalidBody("sizeBytes must be a non-negative integer.");
  }
  return {
    name: requireString(body.name, "name", 1_024),
    contentType: requireString(body.contentType, "contentType", 256),
    ...(sizeBytes === undefined ? {} : { sizeBytes: sizeBytes as number }),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidBody("JSON body must be an object.");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    throw invalidBody(`${field} must be a${allowEmpty ? "" : " non-empty"} string of at most ${max} characters.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : requireString(value, field, max);
}

function invalidBody(message: string): WebConsoleError {
  return new WebConsoleError("invalid_request", message, 400);
}

function pathParam(value: string | readonly string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (typeof id !== "string" || id.length === 0 || id.length > 512) throw invalidBody("Path id is invalid.");
  return id;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw invalidBody("Content-Length is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidBody("Content-Length is invalid.");
  return parsed;
}

function contentDisposition(name: string, disposition: "inline" | "attachment"): string {
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_").slice(0, 150) || "attachment";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function formatSse(event: WebEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new WebConsoleError("invalid_port", "Web port must be an integer from 0 to 65535.", 400);
  return value;
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../webapp/dist");
}

import { createHash, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo, type Socket } from "node:net";
import { hostname as systemHostname } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPERATOR_LIMITS,
  parseAskAnswerRequest,
  parseTurnRequest,
} from "@mono-agent/operator";

import type { WebConfig } from "./config.js";
import { loadWebConfig } from "./config.js";
import type {
  AnswerWebAskInput,
  CreateWebThreadInput,
  OfferWebLiveInput,
  PatchWebAgentInput,
  PatchWebThreadInput,
  StartWebTurnInput,
  WebEvent,
} from "./contracts.js";
import { WebProductError } from "./errors.js";
import { createOperatorGateway } from "./operator-gateway.js";
import { WebService, type WebOperatorGateway } from "./service.js";
import { DurableWebStore } from "./store.js";

const MAX_BODY_BYTES = OPERATOR_LIMITS.requestBytes;
const MAX_INLINE_ATTACHMENT_BYTES = 512 * 1_024;
const MAX_STATIC_ASSET_BYTES = 16 * 1_024 * 1_024;
const MAX_SSE_CLIENTS = 32;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL("../webapp/dist/", import.meta.url));

export interface StartWebServerOptions {
  readonly config?: WebConfig;
  readonly configPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly shutdownTimeoutMs?: number;
  /** Prebuilt browser application root. Defaults to the packaged `webapp/dist`. */
  readonly staticDirectory?: string;
  /** Deterministic embedding/test seam; normal products use the shared operator directory. */
  readonly operatorGateway?: WebOperatorGateway;
}

export interface WebServerHandle {
  readonly url: string;
  readonly address: string;
  readonly port: number;
  readonly dataDirectory: string;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function startWebServer(options: StartWebServerOptions = {}): Promise<WebServerHandle> {
  if (options.config !== undefined && options.configPath !== undefined) {
    throw new WebProductError("invalid_start_options", "Provide config or configPath, not both.");
  }
  const config = options.config ?? await loadWebConfig(resolve(options.configPath ?? "web.config.json"), {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  validateRuntimeConfig(config);
  const store = await DurableWebStore.open(config.dataDirectory);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_000;
  let service: WebService;
  try {
    const gateway = options.operatorGateway ?? createOperatorGateway({
      registryDirectories: config.agentRegistries,
      environment: options.environment ?? process.env,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    service = new WebService(store, gateway, { shutdownTimeoutMs });
  } catch (error) {
    await store.close();
    throw error;
  }
  const sockets = new Set<Socket>();
  const eventStreams = new Set<() => void>();
  const staticDirectory = resolve(options.staticDirectory ?? DEFAULT_STATIC_DIRECTORY);
  const browserAuth = config.auth;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    void handleRequest(request, response, browserAuth, service, staticDirectory, eventStreams).catch((error) => {
      sendError(response, error);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await listen(server, config.listen.port, config.listen.host);
  } catch (error) {
    await service.stop();
    throw new WebProductError("listen_failed", `Web product failed to listen: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await service.stop();
    throw new WebProductError("listen_failed", "Web product did not receive a TCP address.", 500);
  }
  if (
    !isLiteralLoopbackAddress((address as AddressInfo).address)
    && isLoopback(config.listen.host)
  ) {
    await Promise.allSettled([closeServer(server), service.stop()]);
    throw new WebProductError(
      "unsafe_loopback_bind",
      "A listener configured as loopback must resolve and bind to a literal loopback address.",
    );
  }
  const advertisedHost = wildcard(config.listen.host) ? "127.0.0.1" : bracket(config.listen.host);
  const url = `http://${advertisedHost}:${address.port}/`;

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const close of [...eventStreams]) close();
      const closing = closeServer(server);
      server.closeIdleConnections?.();
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, shutdownTimeoutMs);
      timer.unref();
      try {
        const [serviceResult, closeResult] = await Promise.allSettled([
          service.stop(),
          closing,
        ]);
        if (serviceResult.status === "rejected") throw serviceResult.reason;
        if (closeResult.status === "rejected") throw closeResult.reason;
      } finally {
        clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
      }
    })();
    return stopPromise;
  };

  return {
    url,
    address: (address as AddressInfo).address,
    port: address.port,
    dataDirectory: config.dataDirectory,
    stop,
    close: stop,
  };

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: WebConfig["auth"],
    web: WebService,
    assetsRoot: string,
    streams: Set<() => void>,
  ): Promise<void> {
    if (stopping) throw new WebProductError("web_stopping", "Web product is stopping.", 503);
    const url = new URL(request.url ?? "/", "http://web.invalid");
    validateRequestAuthority(
      request,
      config.listen.host,
      listeningPort(server),
      config.externalOrigins,
    );
    if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "healthy" });
    if (
      url.pathname === "/healthz/"
      || url.pathname.startsWith("/healthz/")
      || url.pathname === "/api"
      || (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/v1/"))
    ) {
      throw new WebProductError("not_found", "Not found.", 404);
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new WebProductError("not_found", "Not found.", 404);
      }
      return serveWebAsset(request, response, assetsRoot, url.pathname);
    }

    authenticate(request, auth);
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && url.pathname === "/api/v1/events") {
      return openEventStream(request, response, web, streams);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
      return sendJson(response, 200, await web.bootstrap());
    }
    if (request.method === "POST" && url.pathname === "/api/v1/threads") {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      const input = parseCreateThread(await readJsonBody(request));
      return sendJson(response, 201, await web.createThread(input.agentId, input.title));
    }
    const agentMatch = /^\/api\/v1\/agents\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "PATCH" && agentMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      return sendJson(
        response,
        200,
        await web.patchAgent(decodePath(agentMatch[1]!), parsePatchAgent(await readJsonBody(request))),
      );
    }
    const detailMatch = /^\/api\/v1\/threads\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && detailMatch !== null) {
      return sendJson(response, 200, web.thread(decodePath(detailMatch[1]!)));
    }
    if (request.method === "PATCH" && detailMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      return sendJson(
        response,
        200,
        await web.patchThread(decodePath(detailMatch[1]!), parsePatchThread(await readJsonBody(request))),
      );
    }
    if (request.method === "DELETE" && detailMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      await readJsonBody(request);
      await web.deleteThread(decodePath(detailMatch[1]!));
      return sendJson(response, 200, { deleted: true });
    }
    const turnMatch = /^\/api\/v1\/threads\/([^/]+)\/turns$/u.exec(url.pathname);
    if (request.method === "POST" && turnMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      const input = parseStartTurn(await readJsonBody(request));
      const threadId = decodePath(turnMatch[1]!);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      let disconnected = false;
      response.once("close", () => {
        if (!response.writableEnded) disconnected = true;
      });
      try {
        const detail = await web.runTurn(threadId, input, async (next) => {
          if (disconnected || response.destroyed) return;
          await writeLine(response, { type: "state", detail: next });
        });
        if (!response.destroyed) await writeLine(response, { type: "done", detail });
      } catch (error) {
        if (!response.destroyed) await writeLine(response, {
          type: "error",
          error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) },
          detail: web.thread(threadId),
        });
      }
      if (!response.destroyed) response.end();
      return;
    }
    const cancelMatch = /^\/api\/v1\/threads\/([^/]+)\/cancel$/u.exec(url.pathname);
    if (request.method === "POST" && cancelMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      await readJsonBody(request);
      return sendJson(response, 200, await web.cancel(decodePath(cancelMatch[1]!)));
    }
    const askMatch = /^\/api\/v1\/threads\/([^/]+)\/ask$/u.exec(url.pathname);
    if (request.method === "POST" && askMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      const input = parseAnswerAsk(await readJsonBody(request, OPERATOR_LIMITS.askAnswerRequestBytes));
      return sendJson(response, 200, await web.answerAsk(decodePath(askMatch[1]!), input));
    }
    const liveInputMatch = /^\/api\/v1\/threads\/([^/]+)\/live-input$/u.exec(url.pathname);
    if (request.method === "POST" && liveInputMatch !== null) {
      requireMutationSafety(request, config.listen.host, listeningPort(server), config.externalOrigins);
      const input = parseOfferLiveInput(await readJsonBody(request));
      return sendJson(response, 200, await web.offerLiveInput(decodePath(liveInputMatch[1]!), input.text));
    }
    const replayMatch = /^\/api\/v1\/threads\/([^/]+)\/replay$/u.exec(url.pathname);
    if (request.method === "GET" && replayMatch !== null) {
      return sendJson(response, 200, await web.replay(decodePath(replayMatch[1]!)));
    }
    const agentViewMatch = /^\/api\/v1\/agents\/([^/]+)\/(config|health)$/u.exec(url.pathname);
    if (request.method === "GET" && agentViewMatch !== null) {
      const agentId = decodePath(agentViewMatch[1]!);
      return sendJson(
        response,
        200,
        agentViewMatch[2] === "config" ? await web.config(agentId) : await web.health(agentId),
      );
    }
    throw new WebProductError("not_found", "Not found.", 404);
  }
}

function validateRuntimeConfig(config: WebConfig): void {
  if (typeof config.auth !== "object" || config.auth === null) {
    throw new WebProductError("missing_auth_token", "Web browser authentication requires an explicit auth configuration.");
  }
  if (
    !Array.isArray(config.externalOrigins)
    || config.externalOrigins.some((origin) => !isCanonicalHttpsOrigin(origin))
    || new Set(config.externalOrigins).size !== config.externalOrigins.length
  ) {
    throw new WebProductError(
      "invalid_external_origin",
      "External proxy origins must be unique canonical HTTPS origins.",
    );
  }
  if ("mode" in config.auth) {
    if (config.auth.mode !== "none" || "token" in config.auth) {
      throw new WebProductError("invalid_auth_config", 'Browser auth mode must be exactly "none".');
    }
    return;
  }
  const nonLoopback = !isLoopback(normalizeHostname(config.listen.host));
  if (typeof config.auth.token !== "string" || config.auth.token.length < 16) {
    throw new WebProductError("missing_auth_token", "Web browser authentication requires a token of at least 16 characters.");
  }
  if (nonLoopback && config.auth.token.length < 24) {
    throw new WebProductError("unsafe_non_loopback_bind", "A non-loopback listener requires an authentication token of at least 24 characters.");
  }
  if (nonLoopback && config.allowInsecureHttp !== true) {
    throw new WebProductError(
      "insecure_http_opt_in_required",
      "A non-loopback plaintext HTTP listener requires explicit allowInsecureHttp: true.",
    );
  }
}

function authenticate(request: IncomingMessage, auth: WebConfig["auth"]): void {
  if ("mode" in auth) return;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || !secretEqual(header.slice(7), auth.token)) {
    throw new WebProductError("unauthorized", "Unauthorized.", 401);
  }
}

function requireMutationSafety(
  request: IncomingMessage,
  configuredHost: string,
  port: number,
  externalOrigins: readonly string[],
): void {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new WebProductError("unsupported_media_type", "Mutations require Content-Type: application/json.", 415);
  }
  const trustedExternalOrigin = externalOriginForAuthority(request, externalOrigins);
  const origin = request.headers.origin;
  if (trustedExternalOrigin !== undefined) {
    if (origin !== trustedExternalOrigin) rejectOrigin();
    return;
  }
  if (origin === undefined) {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") rejectOrigin();
    return;
  }
  const host = request.headers.host;
  if (host === undefined) rejectOrigin();
  let parsed: URL;
  let requestAuthority: URL;
  try {
    parsed = new URL(origin);
    requestAuthority = new URL(`http://${host}`);
  } catch { return rejectOrigin(); }
  if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") rejectOrigin();
  if (requestAuthority.username !== "" || requestAuthority.password !== "" || requestAuthority.pathname !== "/" || requestAuthority.search !== "" || requestAuthority.hash !== "") rejectOrigin();
  if (effectivePort(parsed) !== port || effectivePort(requestAuthority) !== port) rejectOrigin();
  const originHost = normalizeHostname(parsed.hostname);
  if (normalizeHostname(requestAuthority.hostname) !== originHost) rejectOrigin();
  if (!isAllowedProductHost(originHost, configuredHost)) rejectOrigin();
}

function validateRequestAuthority(
  request: IncomingMessage,
  configuredHost: string,
  port: number,
  externalOrigins: readonly string[],
): void {
  if (externalOriginForAuthority(request, externalOrigins) !== undefined) return;
  const host = request.headers.host;
  if (host === undefined) rejectAuthority();
  let authority: URL;
  try { authority = new URL(`http://${host}`); } catch { return rejectAuthority(); }
  if (authority.username !== "" || authority.password !== "" || authority.pathname !== "/" || authority.search !== "" || authority.hash !== "") rejectAuthority();
  if (effectivePort(authority) !== port) rejectAuthority();
  if (!isAllowedProductHost(normalizeHostname(authority.hostname), configuredHost)) rejectAuthority();
}

function externalOriginForAuthority(
  request: IncomingMessage,
  externalOrigins: readonly string[],
): string | undefined {
  if (!isLoopbackPeer(request.socket.remoteAddress)) return undefined;
  const host = request.headers.host;
  if (host === undefined) return undefined;
  let authority: URL;
  try {
    authority = new URL(`https://${host}`);
  } catch {
    return undefined;
  }
  if (
    authority.username !== ""
    || authority.password !== ""
    || authority.pathname !== "/"
    || authority.search !== ""
    || authority.hash !== ""
  ) {
    return undefined;
  }
  return externalOrigins.find((origin) => new URL(origin).host === authority.host);
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");
  return normalized === "::1" || /^127(?:\.|$)/u.test(normalized);
}

function isAllowedProductHost(originHost: string, configuredHost: string): boolean {
  const configured = normalizeHostname(configuredHost);
  if (wildcard(configured)) return isValidatedLocalHost(originHost);
  if (isLoopback(configured)) return isLoopback(originHost);
  return originHost === configured;
}

function isValidatedLocalHost(host: string): boolean {
  if (isLoopback(host)) return true;
  const machine = systemHostname().toLowerCase();
  if (host === machine || host === `${machine}.local`) return true;
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    const [a = -1, b = -1] = parts;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    return /^(?:fc|fd)/u.test(host) || /^fe[89ab]/u.test(host);
  }
  return false;
}

function effectivePort(url: URL): number {
  return url.port === "" ? 80 : Number(url.port);
}

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/gu, "");
}

function rejectOrigin(): never {
  throw new WebProductError("cross_origin", "Cross-origin mutation rejected.", 403);
}

function rejectAuthority(): never {
  throw new WebProductError("invalid_authority", "Request authority is not accepted by this web listener.", 421);
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    throw new WebProductError("body_too_large", `Request body exceeds ${String(maximumBytes)} bytes.`, 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maximumBytes) {
      throw new WebProductError("body_too_large", `Request body exceeds ${String(maximumBytes)} bytes.`, 413);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new WebProductError("invalid_json", "Request body is not valid JSON.");
  }
}

function parseCreateThread(raw: unknown): CreateWebThreadInput {
  const value = strictObject(raw, ["agentId", "title"]);
  if (typeof value.agentId !== "string" || value.agentId.length === 0 || value.agentId.length > 256) throw new WebProductError("invalid_request", "agentId is required.");
  if (
    value.title !== undefined
    && (
      typeof value.title !== "string"
      || value.title.trim().length === 0
      || value.title.trim().length > 120
    )
  ) {
    throw new WebProductError("invalid_request", "title is invalid.");
  }
  return {
    agentId: value.agentId,
    ...(value.title === undefined ? {} : { title: (value.title as string).trim() }),
  };
}

function parsePatchAgent(raw: unknown): PatchWebAgentInput {
  const value = strictObject(raw, ["pinned"]);
  if (!Object.hasOwn(value, "pinned") || typeof value.pinned !== "boolean") {
    throw new WebProductError("invalid_request", "pinned must be a boolean.");
  }
  return { pinned: value.pinned };
}

function parsePatchThread(raw: unknown): PatchWebThreadInput {
  const value = strictObject(raw, ["title", "archived"]);
  if (!Object.hasOwn(value, "title") && !Object.hasOwn(value, "archived")) {
    throw new WebProductError("invalid_request", "Thread patch requires title or archived.");
  }
  if (
    value.title !== undefined
    && (
      typeof value.title !== "string"
      || value.title.trim().length === 0
      || value.title.trim().length > 120
    )
  ) {
    throw new WebProductError("invalid_request", "title is invalid.");
  }
  if (value.archived !== undefined && typeof value.archived !== "boolean") {
    throw new WebProductError("invalid_request", "archived must be a boolean.");
  }
  return {
    ...(value.title === undefined ? {} : { title: (value.title as string).trim() }),
    ...(value.archived === undefined ? {} : { archived: value.archived as boolean }),
  };
}

function parseStartTurn(raw: unknown): StartWebTurnInput {
  const value = strictObject(raw, ["text", "attachments", "quote", "runtime", "model", "effort"]);
  try {
    const parsed = parseTurnRequest({
      conversationId: "web-browser-request",
      input: {
        ...(value.text === undefined ? {} : { text: value.text }),
        ...(value.attachments === undefined ? {} : { attachments: value.attachments }),
        ...(value.quote === undefined ? {} : { quote: value.quote }),
      },
      ...(value.runtime === undefined ? {} : { runtime: value.runtime }),
      ...(value.model === undefined ? {} : { model: value.model }),
      ...(value.effort === undefined ? {} : { effort: value.effort }),
    });
    parsed.input.attachments?.forEach(validateWebAttachment);
    return {
      text: parsed.input.text ?? "",
      ...(parsed.input.attachments === undefined ? {} : { attachments: parsed.input.attachments }),
      ...(parsed.input.quote === undefined ? {} : { quote: parsed.input.quote }),
      ...(parsed.runtime === undefined ? {} : { runtime: parsed.runtime }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
    };
  } catch (error) {
    if (error instanceof WebProductError) throw error;
    throw new WebProductError("invalid_request", "Turn input does not satisfy the operator contract.");
  }
}

function validateWebAttachment(attachment: NonNullable<StartWebTurnInput["attachments"]>[number]): void {
  if (
    attachment.name === "."
    || attachment.name === ".."
    || /[\\/\u0000-\u001f\u007f]/u.test(attachment.name)
  ) {
    throw new WebProductError("invalid_request", "Attachment filename is not safe.");
  }
  const match = attachment.url === undefined
    ? null
    : /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(attachment.url);
  if (match === null || match[1] !== attachment.mediaType) {
    throw new WebProductError("invalid_request", "Web attachments require a matching inline base64 data URL.");
  }
  const size = Buffer.from(match[2]!, "base64").byteLength;
  if (size > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new WebProductError("attachment_too_large", "Web attachments must not exceed 512 KiB.", 413);
  }
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== size) {
    throw new WebProductError("invalid_request", "Attachment size does not match its inline data.");
  }
}

function parseAnswerAsk(raw: unknown): AnswerWebAskInput {
  try {
    return parseAskAnswerRequest(raw);
  } catch {
    throw new WebProductError("invalid_request", "AskUser answer does not satisfy the operator contract.");
  }
}

function parseOfferLiveInput(raw: unknown): OfferWebLiveInput {
  const value = strictObject(raw, ["text"]);
  if (
    typeof value.text !== "string"
    || value.text.trim().length === 0
    || value.text.length > OPERATOR_LIMITS.liveInputCharacters
  ) {
    throw new WebProductError(
      "invalid_request",
      `Live input must contain 1 through ${String(OPERATOR_LIMITS.liveInputCharacters)} characters.`,
    );
  }
  return { text: value.text };
}

function strictObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new WebProductError("invalid_request", "Request body must be an object.");
  const value = raw as Record<string, unknown>;
  for (const field of Object.keys(value)) if (!fields.includes(field)) throw new WebProductError("invalid_request", `Unknown request field ${field}.`);
  return value;
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  service: WebService,
  streams: Set<() => void>,
): void {
  if (streams.size >= MAX_SSE_CLIENTS) {
    throw new WebProductError("event_capacity", "Too many live event subscribers.", 503);
  }
  const afterRevision = parseLastEventId(request.headers["last-event-id"]);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let unsubscribe = (): void => undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    streams.delete(close);
    if (!response.destroyed && !response.writableEnded) response.end();
  };
  streams.add(close);
  request.once("aborted", close);
  response.once("close", close);
  unsubscribe = service.openEventStream(afterRevision, (event) => {
    if (closed || response.destroyed || response.writableEnded) return false;
    const accepted = response.write(formatEvent(event));
    if (!accepted) queueMicrotask(close);
    return accepted;
  });
  if (closed) {
    unsubscribe();
    return;
  }
  heartbeat = setInterval(() => {
    if (closed || response.destroyed || response.writableEnded || !response.write(": keep-alive\n\n")) {
      close();
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
}

function parseLastEventId(header: string | string[] | undefined): number | undefined {
  if (header === undefined || header === "") return undefined;
  if (
    typeof header !== "string"
    || !/^(?:0|[1-9]\d*)$/u.test(header)
    || !Number.isSafeInteger(Number(header))
  ) {
    throw new WebProductError("invalid_event_cursor", "Last-Event-ID must be a non-negative safe integer.");
  }
  return Number(header);
}

function formatEvent(event: WebEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function serveWebAsset(
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  pathname: string,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new WebProductError("invalid_path", "Invalid URL path.");
  }
  if (decoded.includes("\0")) throw new WebProductError("invalid_path", "Invalid URL path.");
  const directRelative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const direct = safeStaticPath(staticDirectory, directRelative);
  let asset = await readStaticAsset(staticDirectory, direct);
  if (asset === undefined && extname(directRelative) === "") {
    const index = safeStaticPath(staticDirectory, "index.html");
    asset = await readStaticAsset(staticDirectory, index);
  }
  if (asset === undefined) throw new WebProductError("not_found", "Not found.", 404);
  const cacheControl = asset.path.endsWith(`${sep}index.html`)
    || asset.path.endsWith(`${sep}service-worker.js`)
    || asset.path.endsWith(`${sep}manifest.webmanifest`)
    ? "no-store"
    : decoded.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
  response.writeHead(200, {
    "content-type": contentType(asset.path),
    "content-length": asset.body.byteLength,
    "cache-control": cacheControl,
  });
  if (request.method === "HEAD") response.end();
  else response.end(asset.body);
}

function safeStaticPath(root: string, relative: string): string {
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new WebProductError("invalid_path", "Invalid URL path.");
  }
  return target;
}

interface StaticAsset {
  readonly path: string;
  readonly body: Buffer;
}

/**
 * Read a static asset only after every component below the configured root has
 * been proven link-free. The final file is opened with O_NOFOLLOW and bytes are
 * withheld until the descriptor and pathname chain still identify the same
 * stable regular file.
 */
async function readStaticAsset(root: string, path: string): Promise<StaticAsset | undefined> {
  if (typeof constants.O_NOFOLLOW !== "number") return undefined;
  let beforePath: readonly BigIntStats[];
  let handle: FileHandle | undefined;
  try {
    beforePath = await inspectStaticPath(root, path);
    handle = await open(
      path,
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const before = await handle.stat({ bigint: true });
    const expected = beforePath.at(-1);
    if (
      expected === undefined
      || !before.isFile()
      || !sameIdentity(expected, before)
      || before.size > BigInt(MAX_STATIC_ASSET_BYTES)
    ) {
      return undefined;
    }
    const body = await readBoundedStaticFile(handle);
    if (body === undefined) return undefined;
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile()
      || !sameFileSnapshot(before, after)
      || after.size !== BigInt(body.byteLength)
    ) {
      return undefined;
    }
    const afterPath = await inspectStaticPath(root, path);
    if (!samePathChain(beforePath, afterPath) || !sameIdentity(after, afterPath.at(-1)!)) {
      return undefined;
    }
    return { path, body };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectStaticPath(root: string, path: string): Promise<readonly BigIntStats[]> {
  const relativePath = relative(root, path);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || resolve(root, relativePath) !== path
  ) {
    throw new Error("Static asset is outside its configured root.");
  }
  const segments = relativePath.split(sep).filter((segment) => segment.length > 0);
  const snapshots: BigIntStats[] = [];
  let cursor = root;
  const rootInfo = await lstat(cursor, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Static root must be a directory, not a link.");
  }
  snapshots.push(rootInfo);
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor, { bigint: true });
    const final = index === segments.length - 1;
    if (
      info.isSymbolicLink()
      || (final ? !info.isFile() : !info.isDirectory())
    ) {
      throw new Error("Static path components must not be links.");
    }
    snapshots.push(info);
  }
  return snapshots;
}

async function readBoundedStaticFile(handle: FileHandle): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_STATIC_ASSET_BYTES) {
    const requested = Math.min(64 * 1_024, MAX_STATIC_ASSET_BYTES + 1 - total);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return total > MAX_STATIC_ASSET_BYTES ? undefined : Buffer.concat(chunks, total);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function samePathChain(left: readonly BigIntStats[], right: readonly BigIntStats[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => sameIdentity(entry, right[index]!));
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json":
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".ico": return "image/x-icon";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  const status = error instanceof WebProductError ? error.status : 500;
  const code = errorCode(error);
  const message = status >= 500 ? "Internal server error." : error instanceof Error ? error.message : String(error);
  if (response.headersSent) {
    if (!response.destroyed) response.end(`${JSON.stringify({ type: "error", error: { code, message } })}\n`);
    return;
  }
  if (status === 401) response.setHeader("www-authenticate", 'Bearer realm="mono-agent-web"');
  sendJson(response, status, { error: { code, message } });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function writeLine(response: ServerResponse, value: unknown): Promise<void> {
  if (response.write(`${JSON.stringify(value)}\n`)) return;
  if (response.destroyed) return;
  await new Promise<void>((resolveWrite) => {
    const settle = (): void => {
      response.off("drain", settle);
      response.off("close", settle);
      resolveWrite();
    };
    response.once("drain", settle);
    response.once("close", settle);
  });
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function secretEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new WebProductError("invalid_path", "Invalid URL path."); }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "internal_error";
}

function isLoopback(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "localhost" || isLiteralLoopbackAddress(normalized);
}
function isLiteralLoopbackAddress(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127";
}
function isCanonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.hostname.length > 0
    && value === parsed.origin;
}
function wildcard(host: string): boolean { return host === "0.0.0.0" || host === "::"; }
function bracket(host: string): string { return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; }

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new WebProductError("web_not_listening", "Web product is not listening.", 503);
  return address.port;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
}

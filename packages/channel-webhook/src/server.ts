// SPDX-License-Identifier: MIT
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, type Socket } from "node:net";

import type { ChannelCompletionDelivery } from "@mono-agent/module-sdk";

import {
  assertWebhookStartSafety,
  isWebhookAuthorityAllowed,
  webhookHostForUrl,
} from "./authority.js";
import {
  isLoopbackHost,
  type WebhookConfig,
  type WebhookMode,
} from "./config.js";
import {
  MAX_WEBHOOK_TEXT_BYTES,
  MAX_WEBHOOK_TEXT_LENGTH,
} from "./limits.js";
import { normalizeWebhookRoutes } from "./route-normalization.js";
import type { WebhookRoute } from "./routes.js";

const SHUTDOWN_DRAIN_MS = 1_000;
const MAX_IDENTIFIER_LENGTH = 512;

export type WebhookJsonValue =
  | string
  | number
  | boolean
  | null
  | WebhookJsonObject
  | readonly WebhookJsonValue[];
export type WebhookJsonObject = Readonly<{ [key: string]: WebhookJsonValue }>;

export interface WebhookInboundRequest {
  readonly requestId: string;
  readonly conversationId: string;
  readonly receivedAt: string;
  readonly text: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly completionDelivery?: ChannelCompletionDelivery;
  readonly routeName?: string;
  /** Lowercase SHA-256 of the exact authenticated request bytes. */
  readonly bodySha256: string;
  readonly metadata?: WebhookJsonObject;
  readonly abortSignal: AbortSignal;
}

export interface WebhookTurnResult {
  readonly text: string;
}

export type WebhookSubmit = (request: WebhookInboundRequest) => Promise<WebhookTurnResult>;

export type WebhookRequestStatus =
  | {
      readonly status: "accepted" | "running";
      readonly requestId: string;
      readonly conversationId: string;
      readonly statusUrl: string;
      readonly receivedAt: string;
      readonly startedAt?: string;
    }
  | {
      readonly status: "succeeded";
      readonly requestId: string;
      readonly conversationId: string;
      readonly statusUrl: string;
      readonly receivedAt: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly text: string;
    }
  | {
      readonly status: "failed" | "cancelled";
      readonly requestId: string;
      readonly conversationId: string;
      readonly statusUrl: string;
      readonly receivedAt: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly error: {
        readonly code:
          | "request_failed"
          | "idempotency_conflict"
          | "timeout"
          | "cancelled"
          | "rejected";
        readonly message: string;
      };
    };

export type WebhookTerminalStatus = Extract<
  WebhookRequestStatus,
  { readonly status: "succeeded" | "failed" | "cancelled" }
>;

export interface WebhookChannelHealth {
  readonly status: "stopped" | "healthy" | "degraded";
  readonly activeRequests: number;
  readonly storedRequests: number;
  readonly message?: string;
}

export interface WebhookChannelStartInfo {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly invokeUrl: string;
  readonly statusBaseUrl: string;
  readonly routes: readonly {
    readonly name: string;
    readonly invokeUrl: string;
    readonly statusBaseUrl: string;
  }[];
  readonly authRequired: boolean;
}

export interface WebhookChannel {
  start(): Promise<WebhookChannelStartInfo>;
  health(): WebhookChannelHealth;
  getStatus(requestId: string): WebhookRequestStatus | undefined;
  stop(): Promise<void>;
}

export interface CreateWebhookChannelOptions {
  readonly config: WebhookConfig;
  readonly submit: WebhookSubmit;
  readonly routes?: readonly WebhookRoute[];
  readonly requestIdNamespace?: string;
}

interface ParsedInvocation {
  readonly text: string;
  readonly conversationId?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: WebhookMode;
  readonly metadata?: WebhookJsonObject;
}

interface StoredStatus {
  status: WebhookRequestStatus;
  readonly updatedAtMs: number;
  readonly terminal: boolean;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly completion: Promise<WebhookTerminalStatus>;
}
interface IdempotentRequest {
  readonly fingerprint: string;
  readonly requestId: string;
  readonly conversationId: string;
  readonly statusUrl: string;
  readonly receivedAt: string;
  readonly mode: WebhookMode;
  readonly completion: Promise<WebhookTerminalStatus>;
  terminal: boolean;
  updatedAtMs: number;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class WebhookSubmissionError extends Error {
  constructor(readonly code: "idempotency_conflict" | "cancelled" | "rejected") {
    super(code);
    this.name = "WebhookSubmissionError";
  }
}

class ExecutionError extends Error {
  constructor(
    readonly code:
      | "request_failed"
      | "idempotency_conflict"
      | "timeout"
      | "cancelled"
      | "rejected",
  ) {
    super(code);
    this.name = "ExecutionError";
  }
}

export function createWebhookChannel(options: CreateWebhookChannelOptions): WebhookChannel {
  assertWebhookStartSafety(options.config);
  const routes = normalizeWebhookRoutes(options.config, options.routes);
  const requestIdNamespace = options.requestIdNamespace ?? "standalone";
  if (!validRouteString(requestIdNamespace)) {
    throw new Error("Webhook request id namespace is invalid.");
  }
  const routesByPath = new Map(routes.map((route) => [route.path, route]));

  let server: Server | undefined;
  let startPromise: Promise<WebhookChannelStartInfo> | undefined;
  let startInfo: WebhookChannelStartInfo | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let degradedMessage: string | undefined;
  const statuses = new Map<string, StoredStatus>();
  const active = new Map<string, ActiveRequest>();
  const idempotentRequests = new Map<string, IdempotentRequest>();
  const sockets = new Set<Socket>();

  const health = (): WebhookChannelHealth => {
    pruneStatuses(statuses, options.config.retentionMs);
    pruneIdempotentRequests(idempotentRequests, options.config.retentionMs);
    if (degradedMessage !== undefined) {
      return {
        status: "degraded",
        activeRequests: active.size,
        storedRequests: statuses.size,
        message: degradedMessage,
      };
    }
    return {
      status: startInfo === undefined || stopping ? "stopped" : "healthy",
      activeRequests: active.size,
      storedRequests: statuses.size,
    };
  };

  const getStatus = (requestId: string): WebhookRequestStatus | undefined => {
    pruneStatuses(statuses, options.config.retentionMs);
    pruneIdempotentRequests(idempotentRequests, options.config.retentionMs);
    return statuses.get(requestId)?.status;
  };

  const start = async (): Promise<WebhookChannelStartInfo> => {
    if (startPromise !== undefined) {
      return startPromise;
    }
    if (stopping) {
      throw new Error("Webhook channel cannot be started after stop().");
    }

    startPromise = new Promise<WebhookChannelStartInfo>((resolve, reject) => {
      const nextServer = createServer((request, response) => {
        void handleRequest(request, response).catch((error: unknown) => {
          if (!response.headersSent && !response.destroyed) {
            const failure = error instanceof HttpError
              ? error
              : new HttpError(500, "request_failed", "The request failed.");
            sendJson(response, failure.statusCode, safeErrorBody(failure.code, failure.statusCode >= 500 ? "The request failed." : failure.message));
          } else if (!response.writableEnded) {
            response.destroy();
          }
        });
      });
      nextServer.requestTimeout = 30_000;
      nextServer.headersTimeout = 10_000;
      nextServer.keepAliveTimeout = 5_000;
      nextServer.maxHeadersCount = 100;
      server = nextServer;
      nextServer.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      nextServer.on("error", () => {
        degradedMessage = "Webhook HTTP listener failed.";
      });
      nextServer.on("clientError", (_error, socket) => {
        if (socket.writable) {
          socket.end(
            "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        }
      });
      const onError = (): void => {
        degradedMessage = "Webhook HTTP listener failed.";
        reject(new Error(degradedMessage));
      };
      nextServer.once("error", onError);
      nextServer.listen(
        options.config.listen.port,
        options.config.listen.host,
        () => {
          nextServer.off("error", onError);
          if (stopping) {
            const stoppedError = new Error("Webhook channel stopped while starting.");
            nextServer.close((error) => {
              reject(error ?? stoppedError);
            });
            nextServer.closeIdleConnections();
            for (const socket of sockets) socket.destroy();
            nextServer.closeAllConnections();
            return;
          }
          const address = nextServer.address();
          if (address === null || typeof address === "string") {
            degradedMessage = "Webhook HTTP listener returned an invalid address.";
            reject(new Error(degradedMessage));
            return;
          }
          const port = (address as AddressInfo).port;
          const host = options.config.listen.host;
          if (isLoopbackHost(host) && !isLoopbackHost((address as AddressInfo).address)) {
            degradedMessage = "Webhook loopback listener resolved to a non-loopback address.";
            nextServer.close();
            reject(new Error(degradedMessage));
            return;
          }
          const baseUrl = `http://${webhookHostForUrl(host)}:${String(port)}`;
          const routeUrls = routes.map((route) => Object.freeze({
            name: route.name,
            invokeUrl: `${baseUrl}${route.path}`,
            statusBaseUrl: `${baseUrl}${statusBasePath(route.path)}`,
          }));
          const primary = routeUrls[0]!;
          startInfo = Object.freeze({
            host,
            port,
            baseUrl,
            invokeUrl: primary.invokeUrl,
            statusBaseUrl: primary.statusBaseUrl,
            routes: Object.freeze(routeUrls),
            authRequired: true,
          });
          resolve(startInfo);
        },
      );
    });
    return startPromise;
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (startInfo === undefined) {
      sendJson(response, 503, safeErrorBody("not_started", "The webhook channel is not started."));
      return;
    }
    if (!isWebhookAuthorityAllowed(
      request.headers.host,
      options.config.listen.host,
      startInfo.port,
    )) {
      throw new HttpError(421, "invalid_authority", "Request authority is not accepted.");
    }
    const requestUrl = parseRequestUrl(request.url);
    if (requestUrl.search.length > 0) {
      sendJson(response, 404, safeErrorBody("not_found", "Route not found."));
      return;
    }

    const route = routesByPath.get(requestUrl.pathname);
    if (route !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, safeErrorBody("method_not_allowed", "Method not allowed."), {
          allow: "POST",
        });
        return;
      }
      if (!authenticate(request, response, options.config.apiKey)) {
        return;
      }
      if (!hasApplicationJsonContentType(request.headers["content-type"])) {
        sendJson(
          response,
          415,
          safeErrorBody("unsupported_media_type", "Content-Type must be application/json."),
        );
        return;
      }
      await handleInvocation(request, response, route);
      return;
    }

    const statusRoute = matchStatusRoute(requestUrl.pathname, routes);
    if (statusRoute !== undefined) {
      if (request.method !== "GET") {
        sendJson(response, 405, safeErrorBody("method_not_allowed", "Method not allowed."), {
          allow: "GET",
        });
        return;
      }
      if (!authenticate(request, response, options.config.apiKey)) {
        return;
      }
      const requestId = matchStatusRequestId(requestUrl.pathname, statusBasePath(statusRoute.path));
      if (requestId === undefined) {
        sendJson(response, 404, safeErrorBody("not_found", "Request status not found."));
        return;
      }
      const status = getStatus(requestId);
      if (status === undefined) {
        sendJson(response, 404, { status: "not_found", requestId });
        return;
      }
      sendJson(response, 200, status);
      return;
    }

    sendJson(response, 404, safeErrorBody("not_found", "Route not found."));
  };

  const handleInvocation = async (
    request: IncomingMessage,
    response: ServerResponse,
    route: WebhookRoute,
  ): Promise<void> => {
    if (stopping) {
      sendJson(response, 503, safeErrorBody("shutting_down", "The webhook channel is stopping."));
      return;
    }

    let invocation: ParsedInvocation;
    let idempotencyKey: string | undefined;
    let bodyFingerprint = "";
    try {
      const body = await readBoundedJsonBody(request, options.config.maxBodyBytes);
      if (options.config.signatureSecret !== undefined && !verifySignature(request.headers["x-mono-agent-signature"], body.raw, options.config.signatureSecret)) {
        throw new HttpError(401, "invalid_signature", "Unauthorized.");
      }
      idempotencyKey = readIdempotencyKey(
        request.headers["idempotency-key"],
        request.headersDistinct["idempotency-key"],
      );
      bodyFingerprint = createHash("sha256").update(body.raw).digest("hex");
      invocation = applyRoute(parseInvocation(body.value), route);
    } catch (error) {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(400, "invalid_json", "Request body must be valid JSON.");
      if (failure.statusCode === 413) {
        response.setHeader("connection", "close");
      }
      sendJson(response, failure.statusCode, safeErrorBody(failure.code, failure.message));
      if (failure.statusCode === 413) {
        response.once("finish", () => request.destroy());
      }
      return;
    }

    const identity = idempotencyKey === undefined ? undefined : `${route.name}\0${idempotencyKey}`;
    pruneIdempotentRequests(idempotentRequests, options.config.retentionMs);
    const prior = identity === undefined ? undefined : idempotentRequests.get(identity);
    if (prior !== undefined) {
      if (prior.fingerprint !== bodyFingerprint) {
        sendJson(response, 409, safeErrorBody("idempotency_conflict",
          "Idempotency-Key was already used with a different request body."));
        return;
      }
      if (prior.mode === "async") {
        sendJson(response, 202, acceptedStatus(prior));
        return;
      }
      sendTerminalStatus(response, await prior.completion);
      return;
    }
    if (identity !== undefined) {
      if (!reserveIdempotentCapacity(idempotentRequests, options.config.maxStoredRequests)) {
        sendJson(response, 503, safeErrorBody("request_capacity",
          "The idempotent request capacity is full."));
        return;
      }
    }
    const requestId = idempotencyKey === undefined
      ? randomUUID()
      : stableWebhookRequestId(requestIdNamespace, route.path, idempotencyKey);
    const conversationId = invocation.conversationId ?? `webhook:${route.name}:${requestId}`;
    const receivedAt = new Date().toISOString();
    const requestStatusUrl = `${statusBasePath(route.path)}/${encodeURIComponent(requestId)}`;
    const mode = invocation.mode ?? route.mode;

    if (mode === "async") {
      pruneStatuses(statuses, options.config.retentionMs);
      if (!reserveStatusCapacity(statuses, options.config.maxStoredRequests)) {
        sendJson(
          response,
          503,
          safeErrorBody("request_capacity", "The async request status capacity is full."),
        );
        return;
      }
      const accepted: WebhookRequestStatus = {
        status: "accepted",
        requestId,
        conversationId,
        statusUrl: requestStatusUrl,
        receivedAt,
      };
      setStatus(statuses, accepted, false);
      const execution = beginSubmission({
        requestId,
        conversationId,
        receivedAt,
        statusUrl: requestStatusUrl,
        mode,
        route,
        invocation,
        bodySha256: bodyFingerprint,
      });
      setStatus(statuses, {
        status: "running",
        requestId,
        conversationId,
        statusUrl: requestStatusUrl,
        receivedAt,
        startedAt: new Date().toISOString(),
      }, false);
      void execution.completion.then((status) => {
        setStatus(statuses, status, isTerminalStatus(status));
      });
      if (identity !== undefined) rememberIdempotentRequest(
        idempotentRequests, identity, bodyFingerprint, mode, accepted, execution.completion);
      sendJson(response, 202, accepted);
      return;
    }

    const execution = beginSubmission({
      requestId,
      conversationId,
      receivedAt,
      statusUrl: requestStatusUrl,
      mode,
      route,
      invocation,
      bodySha256: bodyFingerprint,
    });
    if (identity !== undefined) rememberIdempotentRequest(idempotentRequests, identity,
      bodyFingerprint, mode, {
        status: "accepted", requestId, conversationId,
        statusUrl: requestStatusUrl, receivedAt,
      }, execution.completion);
    const onClose = (): void => {
      if (!response.writableEnded) {
        execution.controller.abort(new ExecutionError("cancelled"));
      }
    };
    response.once("close", onClose);
    const status = await execution.completion;
    response.off("close", onClose);
    if (response.destroyed) {
      return;
    }
    sendTerminalStatus(response, status);
  };

  const beginSubmission = (input: {
    readonly requestId: string;
    readonly conversationId: string;
    readonly receivedAt: string;
    readonly statusUrl: string;
    readonly mode: WebhookMode;
    readonly route: WebhookRoute;
    readonly invocation: ParsedInvocation;
    readonly bodySha256: string;
  }): ActiveRequest => {
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const inbound: WebhookInboundRequest = {
      requestId: input.requestId,
      conversationId: input.conversationId,
      receivedAt: input.receivedAt,
      text: input.invocation.text,
      ...(input.invocation.runtime === undefined ? {} : { runtime: input.invocation.runtime }),
      ...(input.invocation.model === undefined ? {} : { model: input.invocation.model }),
      ...(input.invocation.effort === undefined ? {} : { effort: input.invocation.effort }),
      ...(input.route.notify === undefined ? {} : { completionDelivery: input.route.notify }),
      routeName: input.route.name,
      bodySha256: input.bodySha256,
      ...(input.invocation.metadata === undefined ? {} : { metadata: input.invocation.metadata }),
      abortSignal: controller.signal,
    };

    const completion = executeSubmission(
      options.submit,
      inbound,
      controller,
      input.route.maxRunMs ?? options.config.maxRunMs,
    )
      .then<WebhookTerminalStatus>((result) => ({
        status: "succeeded",
        requestId: input.requestId,
        conversationId: input.conversationId,
        statusUrl: input.statusUrl,
        receivedAt: input.receivedAt,
        startedAt,
        completedAt: new Date().toISOString(),
        text: result.text,
      }))
      .catch<WebhookTerminalStatus>((error: unknown) => {
        const code = error instanceof ExecutionError ? error.code : "request_failed";
        return {
          status: code === "cancelled" ? "cancelled" : "failed",
          requestId: input.requestId,
          conversationId: input.conversationId,
          statusUrl: input.statusUrl,
          receivedAt: input.receivedAt,
          startedAt,
          completedAt: new Date().toISOString(),
          error: safeExecutionError(code),
        };
      })
      .finally(() => {
        active.delete(input.requestId);
      });
    const entry: ActiveRequest = { controller, completion };
    active.set(input.requestId, entry);
    return entry;
  };

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    stopping = true;
    stopPromise = (async () => {
      for (const entry of active.values()) {
        entry.controller.abort(new ExecutionError("cancelled"));
      }

      const activeAtStop = [...active.values()].map((entry) => entry.completion);
      await settleWithin(activeAtStop, SHUTDOWN_DRAIN_MS);

      let startupSettled = true;
      if (startPromise !== undefined && startInfo === undefined) {
        startupSettled = await settleOneWithin(startPromise, SHUTDOWN_DRAIN_MS);
      }

      const currentServer = server;
      if (currentServer !== undefined && currentServer.listening) {
        const closePromise = new Promise<void>((resolve, reject) => {
          currentServer.close((error) => error === undefined ? resolve() : reject(error));
        });
        currentServer.closeIdleConnections();
        for (const socket of sockets) socket.destroy();
        currentServer.closeAllConnections();
        const closed = await settleOneWithin(closePromise, SHUTDOWN_DRAIN_MS);
        if (!closed) {
          currentServer.unref();
          throw new Error("Webhook HTTP listener did not close within the shutdown bound.");
        }
      }
      sockets.clear();
      startInfo = undefined;
      if (!startupSettled) {
        currentServer?.unref();
        throw new Error("Webhook HTTP listener startup did not settle within the shutdown bound.");
      }
    })();
    return stopPromise;
  };

  return Object.freeze({ start, health, getStatus, stop });
}

function validRouteString(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function matchStatusRoute(pathname: string, routes: readonly WebhookRoute[]): WebhookRoute | undefined {
  return routes.find((route) => {
    const base = statusBasePath(route.path);
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

function applyRoute(invocation: ParsedInvocation, route: WebhookRoute): ParsedInvocation {
  const text = route.prompt.length === 0
    ? invocation.text
    : `${route.prompt}\n\n${invocation.text}`;
  if (
    text.length > MAX_WEBHOOK_TEXT_LENGTH
    || Buffer.byteLength(text, "utf8") > MAX_WEBHOOK_TEXT_BYTES
  ) {
    throw new HttpError(400, "invalid_request", "The route prompt and request text exceed the request bound.");
  }
  return Object.freeze({
    ...invocation,
    text,
    ...(invocation.runtime !== undefined || route.runtime === undefined ? {} : { runtime: route.runtime }),
    ...(invocation.model !== undefined || route.model === undefined ? {} : { model: route.model }),
    ...(invocation.effort !== undefined || route.effort === undefined ? {} : { effort: route.effort }),
  });
}

async function executeSubmission(
  submit: WebhookSubmit,
  request: WebhookInboundRequest,
  controller: AbortController,
  maxRunMs: number,
): Promise<WebhookTurnResult> {
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = (): void => {
      const reason = controller.signal.reason;
      reject(reason instanceof ExecutionError ? reason : new ExecutionError("cancelled"));
    };
    if (controller.signal.aborted) {
      rejectForAbort();
      return;
    }
    controller.signal.addEventListener("abort", rejectForAbort, { once: true });
  });
  const timeout = setTimeout(() => {
    controller.abort(new ExecutionError("timeout"));
  }, maxRunMs);
  timeout.unref();

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => submit(request)),
      abortPromise,
    ]);
    if (typeof result !== "object" || result === null || typeof result.text !== "string") {
      throw new ExecutionError("request_failed");
    }
    if (
      result.text.length > MAX_WEBHOOK_TEXT_LENGTH
      || Buffer.byteLength(result.text, "utf8") > MAX_WEBHOOK_TEXT_BYTES
    ) {
      throw new ExecutionError("request_failed");
    }
    return result;
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    if (error instanceof WebhookSubmissionError) throw new ExecutionError(error.code);
    throw new ExecutionError("request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function parseInvocation(value: unknown): ParsedInvocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["text", "conversationId", "runtime", "model", "effort", "mode", "metadata"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new HttpError(400, "invalid_request", "Request body contains unknown fields.");
  }

  const text = readInvocationString(input.text, "text", MAX_WEBHOOK_TEXT_LENGTH, true);
  const conversationId = readInvocationString(
    input.conversationId,
    "conversationId",
    MAX_IDENTIFIER_LENGTH,
    false,
  );
  const runtime = readInvocationString(input.runtime, "runtime", MAX_IDENTIFIER_LENGTH, false);
  const model = readInvocationString(input.model, "model", MAX_IDENTIFIER_LENGTH, false);
  const effort = readInvocationString(input.effort, "effort", MAX_IDENTIFIER_LENGTH, false);
  const mode = input.mode === undefined ? undefined : requestMode(input.mode);
  const metadata = parseMetadata(input.metadata);
  return {
    text: text as string,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(mode === undefined ? {} : { mode }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function requestMode(value: unknown): WebhookMode {
  if (value !== "sync" && value !== "async") {
    throw new HttpError(400, "invalid_request", 'mode must be either "sync" or "async".');
  }
  return value;
}

function readInvocationString(
  value: unknown,
  field: string,
  maximumLength: number,
  required: boolean,
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    (field !== "text" && value !== value.trim()) ||
    /\u0000/u.test(value)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} must be a non-empty string no longer than ${String(maximumLength)} characters.`,
    );
  }
  return value;
}

function parseMetadata(value: unknown): WebhookJsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "metadata must be a JSON object.");
  }
  assertJsonValue(value, "metadata", 0);
  return structuredClone(value) as WebhookJsonObject;
}

function assertJsonValue(value: unknown, path: string, depth: number): void {
  if (depth > 20) throw new HttpError(400, "invalid_request", `${path} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new HttpError(400, "invalid_request", `${path} is too large.`);
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${String(index)}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new HttpError(400, "invalid_request", `${path} contains an unsafe key.`);
      assertJsonValue(entry, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new HttpError(400, "invalid_request", `${path} must contain only JSON values.`);
}

function readBoundedJsonBody(request: IncomingMessage, maxBytes: number): Promise<{ readonly raw: Buffer; readonly value: unknown }> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return Promise.reject(new HttpError(400, "invalid_request", "Content-Length is invalid."));
    }
    if (declaredBytes > maxBytes) {
      request.pause();
      return Promise.reject(new HttpError(413, "body_too_large", "Request body is too large."));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: HttpError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        fail(new HttpError(413, "body_too_large", "Request body is too large."));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (totalBytes === 0) {
        reject(new HttpError(400, "invalid_json", "Request body must be valid JSON."));
        return;
      }
      try {
        const raw = Buffer.concat(chunks, totalBytes);
        resolve({ raw, value: JSON.parse(raw.toString("utf8")) as unknown });
      } catch {
        reject(new HttpError(400, "invalid_json", "Request body must be valid JSON."));
      }
    };
    const onError = (): void => fail(new HttpError(400, "invalid_request", "Request body could not be read."));
    const onAborted = (): void => fail(new HttpError(400, "invalid_request", "Request body was aborted."));

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function authenticate(
  request: IncomingMessage,
  response: ServerResponse,
  apiKey: string,
): boolean {
  const candidate = readBearerToken(request.headers.authorization);
  if (candidate !== undefined && constantTimeTokenEqual(candidate, apiKey)) {
    return true;
  }
  response.setHeader("connection", "close");
  sendJson(response, 401, safeErrorBody("unauthorized", "Unauthorized."), {
    "www-authenticate": 'Bearer realm="mono-agent-webhook"',
  });
  response.once("finish", () => request.destroy());
  return false;
}

function hasApplicationJsonContentType(value: string | undefined): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function readBearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer ([^\s]+)$/iu.exec(value);
  return match?.[1];
}

function constantTimeTokenEqual(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function verifySignature(value: string | string[] | undefined, body: Buffer, secret: string): boolean {
  if (typeof value !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(value);
  if (match === null) return false;
  const actual = Buffer.from(match[1]!, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readIdempotencyKey(
  value: string | string[] | undefined,
  distinct: readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (distinct?.length !== 1 || typeof value !== "string"
    || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, "invalid_idempotency_key",
      "Idempotency-Key must be one non-empty bounded value without control characters.");
  }
  return value;
}

function stableWebhookRequestId(namespace: string, route: string, key: string): string {
  const bytes = createHash("sha256").update(
    `mono-agent:webhook-request:v1\0${namespace}\0${route}\0${key}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeExecutionError(
  code:
    | "request_failed"
    | "idempotency_conflict"
    | "timeout"
    | "cancelled"
    | "rejected",
): { readonly code: typeof code; readonly message: string } {
  switch (code) {
    case "idempotency_conflict":
      return { code, message: "The request identity conflicts with prior input." };
    case "timeout":
      return { code, message: "The request timed out." };
    case "cancelled":
      return { code, message: "The request was cancelled." };
    case "rejected":
      return { code, message: "The request was rejected." };
    default:
      return { code, message: "The request failed." };
  }
}

function safeErrorBody(code: string, message: string): {
  readonly status: "error";
  readonly error: { readonly code: string; readonly message: string };
} {
  return { status: "error", error: { code, message } };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent || response.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(payload);
}

function parseRequestUrl(rawUrl: string | undefined): URL {
  try {
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return new URL("/", "http://localhost");
  }
}

function statusBasePath(invokePath: string): string {
  return `${invokePath}/requests`;
}

function matchStatusRequestId(pathname: string, basePath: string): string | undefined {
  const prefix = `${basePath}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  try {
    const decoded = decodeURIComponent(encoded);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded)
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function setStatus(
  statuses: Map<string, StoredStatus>,
  status: WebhookRequestStatus,
  terminal: boolean,
): void {
  statuses.set(status.requestId, {
    status: Object.freeze(status),
    updatedAtMs: Date.now(),
    terminal,
  });
}

function rememberIdempotentRequest(
  requests: Map<string, IdempotentRequest>,
  identity: string,
  fingerprint: string,
  mode: WebhookMode,
  accepted: Extract<WebhookRequestStatus, { readonly status: "accepted" | "running" }>,
  completion: Promise<WebhookTerminalStatus>,
): void {
  const entry: IdempotentRequest = {
    fingerprint, requestId: accepted.requestId, conversationId: accepted.conversationId,
    statusUrl: accepted.statusUrl, receivedAt: accepted.receivedAt, mode, completion,
    terminal: false, updatedAtMs: Date.now(),
  };
  requests.set(identity, entry);
  void completion.then(() => { entry.terminal = true; entry.updatedAtMs = Date.now(); });
}

function acceptedStatus(entry: IdempotentRequest): WebhookRequestStatus {
  return {
    status: "accepted", requestId: entry.requestId, conversationId: entry.conversationId,
    statusUrl: entry.statusUrl, receivedAt: entry.receivedAt,
  };
}

function sendTerminalStatus(response: ServerResponse, status: WebhookTerminalStatus): void {
  const code = status.status === "succeeded" ? 200
    : status.error.code === "idempotency_conflict" ? 409
    : status.error.code === "timeout" ? 504 : status.error.code === "cancelled" ? 503 : 500;
  sendJson(response, code, status);
}

function isTerminalStatus(status: WebhookRequestStatus): boolean {
  return status.status === "succeeded" || status.status === "failed" || status.status === "cancelled";
}

function pruneStatuses(statuses: Map<string, StoredStatus>, retentionMs: number): void {
  const cutoff = Date.now() - retentionMs;
  for (const [requestId, entry] of statuses) {
    if (entry.terminal && entry.updatedAtMs <= cutoff) {
      statuses.delete(requestId);
    }
  }
}

function pruneIdempotentRequests(
  requests: Map<string, IdempotentRequest>,
  retentionMs: number,
): void {
  const cutoff = Date.now() - retentionMs;
  for (const [identity, entry] of requests) {
    if (entry.terminal && entry.updatedAtMs <= cutoff) requests.delete(identity);
  }
}

function reserveIdempotentCapacity(
  requests: Map<string, IdempotentRequest>,
  maximum: number,
): boolean {
  if (requests.size < maximum) return true;
  const terminal = [...requests.entries()].filter(([, entry]) => entry.terminal)
    .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
  for (const [identity] of terminal) {
    requests.delete(identity);
    if (requests.size < maximum) return true;
  }
  return false;
}

function reserveStatusCapacity(
  statuses: Map<string, StoredStatus>,
  maxStoredRequests: number,
): boolean {
  if (statuses.size < maxStoredRequests) return true;
  const terminal = [...statuses.entries()]
    .filter(([, entry]) => entry.terminal)
    .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
  for (const [requestId] of terminal) {
    statuses.delete(requestId);
    if (statuses.size < maxStoredRequests) return true;
  }
  return false;
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  await settleOneWithin(Promise.allSettled(promises).then(() => undefined), timeoutMs);
}

async function settleOneWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

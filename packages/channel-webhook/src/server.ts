import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo, type Socket } from "node:net";
import { hostname as systemHostname } from "node:os";

import {
  isLoopbackHost,
  type WebhookConfig,
  type WebhookMode,
} from "./config.js";

const SHUTDOWN_DRAIN_MS = 1_000;
const MAX_TEXT_LENGTH = 1_000_000;
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
  readonly metadata?: WebhookJsonObject;
  readonly abortSignal: AbortSignal;
}

export interface WebhookTurnResult {
  readonly text: string;
  readonly route?: unknown;
  readonly metadata?: WebhookJsonObject;
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
        readonly code: "request_failed" | "timeout" | "cancelled";
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
}

interface ParsedInvocation {
  readonly text: string;
  readonly conversationId?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
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

class ExecutionError extends Error {
  constructor(readonly code: "request_failed" | "timeout" | "cancelled") {
    super(code);
    this.name = "ExecutionError";
  }
}

export function createWebhookChannel(options: CreateWebhookChannelOptions): WebhookChannel {
  assertStartSafety(options.config);

  let server: Server | undefined;
  let startPromise: Promise<WebhookChannelStartInfo> | undefined;
  let startInfo: WebhookChannelStartInfo | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let degradedMessage: string | undefined;
  const statuses = new Map<string, StoredStatus>();
  const active = new Map<string, ActiveRequest>();
  const sockets = new Set<Socket>();

  const health = (): WebhookChannelHealth => {
    pruneStatuses(statuses, options.config.retentionMs);
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
          const baseUrl = `http://${hostForUrl(host)}:${String(port)}`;
          startInfo = Object.freeze({
            host,
            port,
            baseUrl,
            invokeUrl: `${baseUrl}${options.config.path}`,
            statusBaseUrl: `${baseUrl}${statusBasePath(options.config.path)}`,
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
    validateAuthority(request, options.config.listen.host, startInfo.port);
    const requestUrl = parseRequestUrl(request.url);
    const invokePath = options.config.path;
    const requestStatusBasePath = statusBasePath(invokePath);
    if (requestUrl.search.length > 0) {
      sendJson(response, 404, safeErrorBody("not_found", "Route not found."));
      return;
    }

    if (requestUrl.pathname === invokePath) {
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
      await handleInvocation(request, response);
      return;
    }

    if (
      requestUrl.pathname === requestStatusBasePath ||
      requestUrl.pathname.startsWith(`${requestStatusBasePath}/`)
    ) {
      if (request.method !== "GET") {
        sendJson(response, 405, safeErrorBody("method_not_allowed", "Method not allowed."), {
          allow: "GET",
        });
        return;
      }
      if (!authenticate(request, response, options.config.apiKey)) {
        return;
      }
      const requestId = matchStatusRequestId(requestUrl.pathname, requestStatusBasePath);
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
  ): Promise<void> => {
    if (stopping) {
      sendJson(response, 503, safeErrorBody("shutting_down", "The webhook channel is stopping."));
      return;
    }

    let invocation: ParsedInvocation;
    try {
      const body = await readBoundedJsonBody(request, options.config.maxBodyBytes);
      if (options.config.signatureSecret !== undefined && !verifySignature(request.headers["x-mono-agent-signature"], body.raw, options.config.signatureSecret)) {
        throw new HttpError(401, "invalid_signature", "Unauthorized.");
      }
      invocation = parseInvocation(body.value);
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

    const requestId = randomUUID();
    const conversationId = invocation.conversationId ?? `webhook:${requestId}`;
    const receivedAt = new Date().toISOString();
    const requestStatusUrl = `${statusBasePath(options.config.path)}/${encodeURIComponent(requestId)}`;

    if (options.config.mode === "async") {
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
        mode: options.config.mode,
        invocation,
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
      sendJson(response, 202, accepted);
      return;
    }

    const execution = beginSubmission({
      requestId,
      conversationId,
      receivedAt,
      statusUrl: requestStatusUrl,
      mode: options.config.mode,
      invocation,
    });
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
    if (status.status === "succeeded") {
      sendJson(response, 200, status);
      return;
    }
    const statusCode = status.error.code === "timeout"
      ? 504
      : status.error.code === "cancelled"
        ? 503
        : 500;
    sendJson(response, statusCode, status);
  };

  const beginSubmission = (input: {
    readonly requestId: string;
    readonly conversationId: string;
    readonly receivedAt: string;
    readonly statusUrl: string;
    readonly mode: WebhookMode;
    readonly invocation: ParsedInvocation;
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
      ...(input.invocation.metadata === undefined ? {} : { metadata: input.invocation.metadata }),
      abortSignal: controller.signal,
    };

    const completion = executeSubmission(
      options.submit,
      inbound,
      controller,
      options.config.maxRunMs,
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

      if (startPromise !== undefined && startInfo === undefined) {
        await settleOneWithin(startPromise, SHUTDOWN_DRAIN_MS);
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
    })();
    return stopPromise;
  };

  return Object.freeze({ start, health, getStatus, stop });
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
    if (result.text.length > MAX_TEXT_LENGTH || Buffer.byteLength(result.text, "utf8") > MAX_TEXT_LENGTH * 4) {
      throw new ExecutionError("request_failed");
    }
    return result;
  } catch (error) {
    if (error instanceof ExecutionError) {
      throw error;
    }
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
  const allowed = new Set(["text", "conversationId", "runtime", "model", "effort", "metadata"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new HttpError(400, "invalid_request", "Request body contains unknown fields.");
  }

  const text = readInvocationString(input.text, "text", MAX_TEXT_LENGTH, true);
  const conversationId = readInvocationString(
    input.conversationId,
    "conversationId",
    MAX_IDENTIFIER_LENGTH,
    false,
  );
  const runtime = readInvocationString(input.runtime, "runtime", MAX_IDENTIFIER_LENGTH, false);
  const model = readInvocationString(input.model, "model", MAX_IDENTIFIER_LENGTH, false);
  const effort = readInvocationString(input.effort, "effort", MAX_IDENTIFIER_LENGTH, false);
  const metadata = parseMetadata(input.metadata);
  return {
    text: text as string,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(metadata === undefined ? {} : { metadata }),
  };
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

function safeExecutionError(
  code: "request_failed" | "timeout" | "cancelled",
): { readonly code: "request_failed" | "timeout" | "cancelled"; readonly message: string } {
  switch (code) {
    case "timeout":
      return { code, message: "The request timed out." };
    case "cancelled":
      return { code, message: "The request was cancelled." };
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
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded)
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

function assertStartSafety(config: WebhookConfig): void {
  if (!isLoopbackHost(config.listen.host) && config.allowNonLoopback !== true) {
    throw new Error("The HTTP webhook channel may bind outside loopback only with explicit allowNonLoopback.");
  }
  if (
    typeof config.apiKey !== "string" ||
    config.apiKey.length === 0 ||
    config.apiKey.length > 4_096 ||
    /\s/u.test(config.apiKey)
  ) {
    throw new Error("Webhook API key is required and must be a non-empty bearer token.");
  }
  if (
    !isLoopbackHost(config.listen.host)
    && (
      config.apiKey.length < 32
      || typeof config.signatureSecret !== "string"
      || config.signatureSecret.length < 32
      || config.signatureSecret.length > 4_096
      || /\s/u.test(config.signatureSecret)
    )
  ) {
    throw new Error("A non-loopback webhook listener requires bearer and signature secrets of at least 32 characters.");
  }
}

function validateAuthority(request: IncomingMessage, configuredHost: string, port: number): void {
  const host = request.headers.host;
  if (host === undefined) throw new HttpError(421, "invalid_authority", "Request authority is not accepted.");
  let authority: URL;
  try { authority = new URL(`http://${host}`); } catch { throw new HttpError(421, "invalid_authority", "Request authority is not accepted."); }
  if (authority.username !== "" || authority.password !== "" || authority.pathname !== "/" || authority.search !== "" || authority.hash !== "" || Number(authority.port || "80") !== port) {
    throw new HttpError(421, "invalid_authority", "Request authority is not accepted.");
  }
  const candidate = authority.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const configured = configuredHost.toLowerCase().replace(/^\[|\]$/gu, "");
  const wildcard = configured === "0.0.0.0" || configured === "::";
  const allowed = wildcard ? isLocalNetworkHost(candidate) : isLoopbackHost(configured) ? isLoopbackHost(candidate) : candidate === configured;
  if (!allowed) throw new HttpError(421, "invalid_authority", "Request authority is not accepted.");
}

function isLocalNetworkHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  const machine = systemHostname().toLowerCase();
  if (host === machine || host === `${machine}.local`) return true;
  if (isIP(host) === 4) {
    const [a = -1, b = -1] = host.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && (/^(?:fc|fd)/u.test(host) || /^fe[89ab]/u.test(host));
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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

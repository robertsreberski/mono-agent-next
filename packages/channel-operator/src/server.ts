import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type {
  ChannelAttachment,
  ChannelInboundRequest,
  ChannelReplyEvent,
  ChannelReplySink,
  ChannelTurnResult,
  JsonObject,
} from "@mono-agent/module-sdk";
import {
  OPERATOR_LIMITS,
  OPERATOR_PROTOCOL,
  OPERATOR_ROUTES,
  parseCancelRequest,
  parseOperatorHealth,
  parseOperatorInfo,
  parseTurnRequest,
  serializeOperatorFrame,
  type OperatorCancelResponse,
  type OperatorCapabilities,
  type OperatorCompletedFrame,
  type OperatorErrorFrame,
  type OperatorFrame,
  type OperatorHealth,
  type OperatorInfo,
  type OperatorTurnRequest,
} from "@mono-agent/operator";

import {
  isLoopbackHost,
  parseOperatorChannelConfig,
  type OperatorChannelConfig,
} from "./config.js";

const SHUTDOWN_BOUND_MS = 1_000;
const TERMINAL_FRAME_RESERVE_BYTES = 1_024;
const CANCELLATION_MESSAGE = "The operator turn was cancelled.";

export interface OperatorChannelStartInfo {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly infoUrl: string;
  readonly turnsUrl: string;
  readonly healthUrl: string;
  readonly authRequired: true;
  readonly protocol: typeof OPERATOR_PROTOCOL;
}

export interface OperatorChannelHealth {
  readonly status: "stopped" | "healthy" | "degraded";
  readonly activeTurns: number;
  readonly message?: string;
}

export interface OperatorChannel {
  readonly endpoint: string | undefined;
  readonly startInfo: OperatorChannelStartInfo | undefined;
  start(): Promise<OperatorChannelStartInfo>;
  health(): OperatorChannelHealth;
  stop(): Promise<void>;
}

export type OperatorDispatch = (
  request: ChannelInboundRequest,
  reply: ChannelReplySink,
) => Promise<ChannelTurnResult>;

export interface CreateOperatorChannelOptions {
  readonly config: OperatorChannelConfig;
  readonly instanceId: string;
  readonly dispatch: OperatorDispatch;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly conversationId: string;
  readonly controller: AbortController;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperatorHttpError";
  }
}

class StreamClosedError extends Error {
  constructor() {
    super("Operator stream closed.");
    this.name = "StreamClosedError";
  }
}

export function createOperatorChannel(options: CreateOperatorChannelOptions): OperatorChannel {
  const config = parseOperatorChannelConfig(options.config);
  if (typeof options.dispatch !== "function") {
    throw new TypeError("createOperatorChannel requires a dispatch function.");
  }
  if (options.instanceId.length === 0 || options.instanceId !== options.instanceId.trim()) {
    throw new TypeError("createOperatorChannel requires a non-empty instanceId.");
  }

  let server: Server | undefined;
  let currentStartInfo: OperatorChannelStartInfo | undefined;
  let startPromise: Promise<OperatorChannelStartInfo> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let degradedMessage: string | undefined;
  let serverStartedAt: string | undefined;
  const sockets = new Set<Socket>();
  const activeByConversation = new Map<string, Set<ActiveTurn>>();

  const start = async (): Promise<OperatorChannelStartInfo> => {
    if (startPromise !== undefined) return startPromise;
    if (stopping) throw new Error("Operator channel cannot start after stop().");

    startPromise = new Promise<OperatorChannelStartInfo>((resolve, reject) => {
      const nextServer = createServer((request, response) => {
        void handleRequest(request, response).catch(() => {
          if (!response.headersSent && !response.destroyed) {
            sendJson(response, 500, errorBody("internal_error", "The operator request failed."));
          } else if (!response.writableEnded) {
            response.destroy();
          }
        });
      });
      server = nextServer;
      nextServer.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      nextServer.on("clientError", (_error, socket) => {
        if (socket.writable) {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
      });
      const onInitialError = (): void => {
        degradedMessage = "Operator HTTP listener failed.";
        reject(new Error(degradedMessage));
      };
      nextServer.once("error", onInitialError);
      nextServer.listen(config.listen.port, config.listen.host, () => {
        nextServer.off("error", onInitialError);
        if (stopping) {
          nextServer.close();
          reject(new Error("Operator channel stopped while starting."));
          return;
        }
        const address = nextServer.address();
        if (address === null || typeof address === "string") {
          degradedMessage = "Operator HTTP listener returned an invalid address.";
          reject(new Error(degradedMessage));
          return;
        }
        if (!isLoopbackHost((address as AddressInfo).address)) {
          degradedMessage = "Operator loopback name resolved to a non-loopback address.";
          nextServer.close();
          reject(new Error(degradedMessage));
          return;
        }
        const boundAddress = (address as AddressInfo).address;
        const port = (address as AddressInfo).port;
        const baseUrl = `http://${hostForUrl(boundAddress)}:${String(port)}`;
        serverStartedAt = new Date().toISOString();
        currentStartInfo = Object.freeze({
          host: boundAddress,
          port,
          baseUrl,
          endpoint: baseUrl,
          infoUrl: `${baseUrl}${OPERATOR_ROUTES.info}`,
          turnsUrl: `${baseUrl}${OPERATOR_ROUTES.turns}`,
          healthUrl: `${baseUrl}${OPERATOR_ROUTES.health}`,
          authRequired: true,
          protocol: OPERATOR_PROTOCOL,
        });
        nextServer.on("error", () => {
          degradedMessage = "Operator HTTP listener failed after startup.";
        });
        resolve(currentStartInfo);
      });
    });
    return startPromise;
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const info = currentStartInfo;
    const startedAt = serverStartedAt;
    if (info === undefined || startedAt === undefined || stopping) {
      sendJson(response, 503, errorBody("unavailable", "The operator endpoint is unavailable."));
      return;
    }
    if (!validateRequestBoundary(request, response, info)) return;
    if (!authenticate(request, response, config.auth.token)) return;

    const requestUrl = parseRequestUrl(request.url);
    if (requestUrl.search.length > 0) {
      sendJson(response, 404, errorBody("not_found", "Operator route not found."));
      return;
    }

    if (requestUrl.pathname === OPERATOR_ROUTES.info) {
      if (!requireMethod(request, response, "GET")) return;
      sendJson(response, 200, operatorInfo(options.instanceId, config, startedAt));
      return;
    }
    if (requestUrl.pathname === OPERATOR_ROUTES.health) {
      if (!requireMethod(request, response, "GET")) return;
      sendJson(response, 200, operatorHealth(degradedMessage));
      return;
    }
    if (requestUrl.pathname === OPERATOR_ROUTES.turns) {
      if (!requireMethod(request, response, "POST")) return;
      if (!requireJsonContentType(request, response)) return;
      await handleTurn(request, response);
      return;
    }

    const conversationId = matchConversationMutation(requestUrl.pathname, "cancel");
    if (conversationId !== undefined) {
      if (!requireMethod(request, response, "POST")) return;
      if (!requireJsonContentType(request, response)) return;
      await handleCancel(request, response, conversationId);
      return;
    }

    sendJson(response, 404, errorBody("not_found", "Operator route not found."));
  };

  const handleTurn = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let turnRequest: OperatorTurnRequest;
    try {
      turnRequest = parseTurnRequest(await readBoundedJsonBody(request, OPERATOR_LIMITS.requestBytes));
      if ((turnRequest.input.attachments?.length ?? 0) > 0) {
        throw new HttpError(422, "unsupported_capability", "This operator endpoint does not accept attachments.");
      }
      if (turnRequest.input.quote !== undefined) {
        throw new HttpError(422, "unsupported_capability", "This operator endpoint does not accept quotes.");
      }
    } catch (error) {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(400, "invalid_request", "The operator turn request is invalid.");
      closeAfterOversize(request, response, failure);
      return;
    }

    const turnId = randomUUID();
    const startedAt = new Date().toISOString();
    const active: ActiveTurn = {
      turnId,
      conversationId: turnRequest.conversationId,
      controller: new AbortController(),
    };
    addActiveTurn(activeByConversation, active);

    response.writeHead(200, streamHeaders());
    response.socket?.setNoDelay(true);
    response.flushHeaders();
    const writer = new OperatorFrameWriter(response, active.controller);
    const abortForDisconnect = (): void => {
      if (!response.writableEnded) active.controller.abort(new StreamClosedError());
    };
    response.once("close", abortForDisconnect);
    request.once("aborted", abortForDisconnect);

    let text = "";
    let unsupportedAttachment = false;
    const reply: ChannelReplySink = {
      async emit(event: ChannelReplyEvent): Promise<void> {
        switch (event.type) {
          case "text-delta":
            text += event.delta;
            await writer.write({ type: "delta", turnId, target: "assistant", text: event.delta, mode: "append" });
            break;
          case "text-replace":
            text = event.text;
            await writer.write({ type: "delta", turnId, target: "assistant", text: event.text, mode: "replace" });
            break;
          case "activity":
            await writer.write({ type: "activity", turnId, text: event.text });
            break;
          case "attachment":
            unsupportedAttachment = true;
            break;
        }
      },
    };

    try {
      await writer.write({
        type: "accepted",
        turnId,
        conversationId: turnRequest.conversationId,
        startedAt,
      });
      const result = await options.dispatch(
        toInboundRequest(options.instanceId, turnId, startedAt, turnRequest, active.controller.signal),
        reply,
      );
      if (active.controller.signal.aborted || result.status === "cancelled") {
        await writer.write(errorFrame(turnId, "cancelled", CANCELLATION_MESSAGE, true));
      } else if (result.status === "rejected") {
        await writer.write(errorFrame(turnId, "turn_rejected", "The operator turn was rejected.", false));
      } else if (unsupportedAttachment) {
        await writer.write(errorFrame(
          turnId,
          "unsupported_output",
          "The operator endpoint cannot represent the attachment returned by this turn.",
          false,
        ));
      } else {
        const completed: OperatorCompletedFrame = {
          type: "completed",
          turnId,
          finalMessage: {
            role: "assistant",
            text: result.text ?? text,
          },
          finishedAt: new Date().toISOString(),
          stopReason: "completed",
        };
        await writer.write(completed);
      }
    } catch (error) {
      if (!(error instanceof StreamClosedError) && !response.destroyed && !response.writableEnded) {
        const cancelled = active.controller.signal.aborted;
        await writer.write(errorFrame(
          turnId,
          cancelled ? "cancelled" : "dispatch_failed",
          cancelled ? CANCELLATION_MESSAGE : "The operator turn failed.",
          cancelled,
        )).catch(() => undefined);
      }
    } finally {
      response.off("close", abortForDisconnect);
      request.off("aborted", abortForDisconnect);
      removeActiveTurn(activeByConversation, active);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  };

  const handleCancel = async (
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> => {
    try {
      parseCancelRequest(await readBoundedJsonBody(request, OPERATOR_LIMITS.requestBytes));
    } catch (error) {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(400, "invalid_request", "The operator cancellation request is invalid.");
      closeAfterOversize(request, response, failure);
      return;
    }
    const turns = activeByConversation.get(conversationId);
    if (turns === undefined || turns.size === 0) {
      const idle: OperatorCancelResponse = { status: "idle" };
      sendJson(response, 200, idle);
      return;
    }
    for (const turn of turns) {
      turn.controller.abort(new Error("Operator cancellation requested."));
    }
    const accepted: OperatorCancelResponse = { status: "accepted" };
    sendJson(response, 202, accepted);
  };

  const health = (): OperatorChannelHealth => Object.freeze({
    status: currentStartInfo === undefined || stopping
      ? "stopped"
      : degradedMessage === undefined
        ? "healthy"
        : "degraded",
    activeTurns: activeCount(activeByConversation),
    ...(degradedMessage === undefined ? {} : { message: degradedMessage }),
  });

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const turns of activeByConversation.values()) {
        for (const turn of turns) turn.controller.abort(new Error("Operator channel stopped."));
      }
      if (startPromise !== undefined && currentStartInfo === undefined) {
        await settleWithin(startPromise, SHUTDOWN_BOUND_MS);
      }
      const nextServer = server;
      if (nextServer !== undefined && nextServer.listening) {
        const closed = new Promise<void>((resolve) => {
          nextServer.close(() => resolve());
        });
        nextServer.closeIdleConnections();
        for (const socket of sockets) socket.destroy();
        nextServer.closeAllConnections();
        if (!await settleWithin(closed, SHUTDOWN_BOUND_MS)) {
          nextServer.unref();
          throw new Error("Operator HTTP listener did not close within the shutdown bound.");
        }
      }
      sockets.clear();
      currentStartInfo = undefined;
      serverStartedAt = undefined;
    })();
    return stopPromise;
  };

  return Object.freeze({
    get endpoint(): string | undefined {
      return currentStartInfo?.endpoint;
    },
    get startInfo(): OperatorChannelStartInfo | undefined {
      return currentStartInfo;
    },
    start,
    health,
    stop,
  });
}

function operatorInfo(
  instanceId: string,
  config: OperatorChannelConfig,
  startedAt: string,
): OperatorInfo {
  return parseOperatorInfo({
    protocol: OPERATOR_PROTOCOL,
    agent: {
      id: instanceId,
      label: config.label ?? instanceId,
    },
    process: {
      pid: process.pid,
      startedAt,
    },
    capabilities: operatorCapabilities(),
  });
}

function operatorHealth(degradedMessage: string | undefined): OperatorHealth {
  const status = degradedMessage === undefined ? "healthy" : "degraded";
  return parseOperatorHealth({
    status,
    checkedAt: new Date().toISOString(),
    details: [{
      id: "channel-operator",
      status,
      ...(degradedMessage === undefined ? {} : { message: degradedMessage }),
    }],
  });
}

function operatorCapabilities(): OperatorCapabilities {
  return Object.freeze({
    attachments: false,
    liveInput: false,
    askUser: false,
    cancellation: true,
    quotes: false,
    runtimeOverrides: true,
    proactive: false,
    configView: false,
    replay: false,
    health: true,
  });
}

function toInboundRequest(
  instanceId: string,
  turnId: string,
  receivedAt: string,
  request: OperatorTurnRequest,
  signal: AbortSignal,
): ChannelInboundRequest {
  return {
    requestId: turnId,
    conversationId: request.conversationId,
    sender: { id: "operator", displayName: instanceId },
    text: request.input.text ?? "",
    attachments: [] satisfies readonly ChannelAttachment[],
    receivedAt,
    ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    signal,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata as JsonObject }),
  };
}

function errorFrame(
  turnId: string,
  code: string,
  message: string,
  cancelled: boolean,
): OperatorErrorFrame {
  return {
    type: "error",
    turnId,
    error: { code, message, retryable: false },
    cancelled,
    finishedAt: new Date().toISOString(),
  };
}

class OperatorFrameWriter {
  #writtenBytes = 0;

  constructor(
    private readonly response: ServerResponse,
    private readonly controller: AbortController,
  ) {}

  async write(frame: OperatorFrame): Promise<void> {
    if (this.response.destroyed || this.response.writableEnded) {
      this.controller.abort(new StreamClosedError());
      throw new StreamClosedError();
    }
    const line = serializeOperatorFrame(frame);
    const bytes = Buffer.byteLength(line, "utf8");
    const isTerminal = frame.type === "completed" || frame.type === "error";
    const limit = isTerminal
      ? OPERATOR_LIMITS.streamBytes
      : OPERATOR_LIMITS.streamBytes - TERMINAL_FRAME_RESERVE_BYTES;
    if (this.#writtenBytes + bytes > limit) {
      this.controller.abort(new Error("Operator stream exceeded its byte limit."));
      throw new HttpError(500, "stream_limit", "The operator stream exceeded its byte limit.");
    }
    this.#writtenBytes += bytes;
    if (this.response.write(line)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.response.off("drain", onDrain);
        this.response.off("close", onClose);
        this.response.off("error", onError);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        this.controller.abort(new StreamClosedError());
        reject(new StreamClosedError());
      };
      const onError = (): void => {
        cleanup();
        this.controller.abort(new StreamClosedError());
        reject(new StreamClosedError());
      };
      this.response.once("drain", onDrain);
      this.response.once("close", onClose);
      this.response.once("error", onError);
    });
  }
}

function validateRequestBoundary(
  request: IncomingMessage,
  response: ServerResponse,
  info: OperatorChannelStartInfo,
): boolean {
  const expectedHost = new URL(info.baseUrl).host.toLowerCase();
  if (request.headers.host?.toLowerCase() !== expectedHost) {
    sendJson(response, 421, errorBody("invalid_host", "The request Host is not accepted."));
    return false;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    sendJson(response, 403, errorBody("cross_origin", "Cross-origin operator requests are not accepted."));
    return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      sendJson(response, 403, errorBody("cross_origin", "Cross-origin operator requests are not accepted."));
      return false;
    }
    if (normalized !== info.baseUrl) {
      sendJson(response, 403, errorBody("cross_origin", "Cross-origin operator requests are not accepted."));
      return false;
    }
  }
  return true;
}

function authenticate(request: IncomingMessage, response: ServerResponse, token: string): boolean {
  const candidate = readBearerToken(request.headers.authorization);
  if (candidate !== undefined && constantTimeEqual(candidate, token)) return true;
  response.setHeader("connection", "close");
  sendJson(response, 401, errorBody("unauthorized", "Unauthorized."), {
    "www-authenticate": 'Bearer realm="mono-agent-operator"',
  });
  response.once("finish", () => request.destroy());
  return false;
}

function requireMethod(request: IncomingMessage, response: ServerResponse, method: "GET" | "POST"): boolean {
  if (request.method === method) return true;
  sendJson(response, 405, errorBody("method_not_allowed", "Method not allowed."), { allow: method });
  return false;
}

function requireJsonContentType(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
    return true;
  }
  sendJson(response, 415, errorBody("unsupported_media_type", "Content-Type must be application/json."));
  return false;
}

function readBoundedJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return Promise.reject(new HttpError(400, "invalid_request", "Content-Length is invalid."));
    }
    if (declared > maxBytes) {
      request.pause();
      return Promise.reject(new HttpError(413, "body_too_large", "Request body is too large."));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
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
      total += buffer.byteLength;
      if (total > maxBytes) {
        fail(new HttpError(413, "body_too_large", "Request body is too large."));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (total === 0) {
        reject(new HttpError(400, "invalid_json", "Request body must contain JSON."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown);
      } catch {
        reject(new HttpError(400, "invalid_json", "Request body must contain valid JSON."));
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

function closeAfterOversize(request: IncomingMessage, response: ServerResponse, error: HttpError): void {
  if (error.statusCode === 413) response.setHeader("connection", "close");
  sendJson(response, error.statusCode, errorBody(error.code, error.message));
  if (error.statusCode === 413) response.once("finish", () => request.destroy());
}

function matchConversationMutation(pathname: string, action: "cancel"): string | undefined {
  const prefix = `${OPERATOR_ROUTES.conversations}/`;
  const suffix = `/${action}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  try {
    const decoded = decodeURIComponent(encoded);
    if (
      decoded.length === 0
      || decoded.length > OPERATOR_LIMITS.identifierCharacters
      || decoded !== decoded.trim()
      || /\u0000/u.test(decoded)
    ) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function addActiveTurn(active: Map<string, Set<ActiveTurn>>, turn: ActiveTurn): void {
  const turns = active.get(turn.conversationId) ?? new Set<ActiveTurn>();
  turns.add(turn);
  active.set(turn.conversationId, turns);
}

function removeActiveTurn(active: Map<string, Set<ActiveTurn>>, turn: ActiveTurn): void {
  const turns = active.get(turn.conversationId);
  turns?.delete(turn);
  if (turns?.size === 0) active.delete(turn.conversationId);
}

function activeCount(active: Map<string, Set<ActiveTurn>>): number {
  let count = 0;
  for (const turns of active.values()) count += turns.size;
  return count;
}

function readBearerToken(value: string | undefined): string | undefined {
  return /^Bearer ([^\s]+)$/iu.exec(value ?? "")?.[1];
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function parseRequestUrl(rawUrl: string | undefined): URL {
  try {
    return new URL(rawUrl ?? "/", "http://operator.invalid");
  } catch {
    return new URL("/", "http://operator.invalid");
  }
}

function hostForUrl(host: string): string {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function streamHeaders(): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-store",
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

function errorBody(code: string, message: string): {
  readonly error: { readonly code: string; readonly message: string };
} {
  return { error: { code, message } };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent || response.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(payload);
}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

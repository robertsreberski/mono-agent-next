import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type {
  AskUserRequest,
  ChannelAttachment,
  ChannelHost,
  ChannelInboundRequest,
  ChannelReplyEvent,
  ChannelReplySink,
  ChannelTurnResult,
} from "@mono-agent/module-sdk";
import {
  OPERATOR_LIMITS,
  OPERATOR_PROTOCOL,
  OPERATOR_ROUTES,
  parseCancelRequest,
  parseAskAnswerRequest,
  parseLiveInputRequest,
  parseTurnRequest,
  type OperatorCancelResponse,
  type OperatorAskSnapshot,
  type OperatorAskAnswerResponse,
  type OperatorConversationList,
  type OperatorReplayResponse,
  type OperatorConfigView,
  type OperatorLiveInputResponse,
  type OperatorUsage,
  type OperatorTurnRequest,
} from "@mono-agent/operator";

import {
  isLoopbackHost,
  parseOperatorChannelConfig,
  type OperatorChannelConfig,
} from "./config.js";
import { HttpError, StreamClosedError, StreamLimitError } from "./errors.js";
import { OperatorFrameWriter } from "./frame-writer.js";
import { settleWithin, untilAborted } from "./lifecycle.js";
import {
  asConfigObject,
  errorFrame,
  mergeOperatorUsage,
  operatorHealth,
  operatorInfo,
  operatorToolCall,
  operatorToolResult,
  operatorTriggerKind,
  operatorUsage,
  projectActivityFrame,
  projectCompletedFrame,
  projectDeltaFrame,
  resolveOperatorQuote,
  toChannelAttachment,
  toInboundRequest,
  toOperatorMessage,
  validateIdentityGrant,
  type OperatorIdentityGrant,
  type ResolvedOperatorQuote,
} from "./projection.js";

export { deriveOperatorCapabilities } from "./projection.js";
export type { OperatorIdentityGrant } from "./projection.js";

const SHUTDOWN_BOUND_MS = 1_000;
const CANCELLATION_MESSAGE = "The operator turn was cancelled.";
const MAX_PENDING_ASKS = 1_000;
const CORE_REPLAY_PAGE_LIMIT = 10_000;

export interface OperatorChannelStartInfo {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly infoUrl: string;
  readonly turnsUrl: string;
  readonly healthUrl: string;
  readonly startedAt: string;
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
  readonly identity: OperatorIdentityGrant;
  readonly dispatch: OperatorDispatch;
  readonly host?: Pick<ChannelHost,
    | "cancel"
    | "offerLiveInput"
    | "answerAsk"
    | "listConversations"
    | "readReplay"
    | "readConfig"
    | "readHealth"
    | "openConversation"
  >;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly conversationId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export function createOperatorChannel(options: CreateOperatorChannelOptions): OperatorChannel {
  const config = parseOperatorChannelConfig(options.config);
  const identity = validateIdentityGrant(options.identity);
  if (typeof options.dispatch !== "function") {
    throw new TypeError("createOperatorChannel requires a dispatch function.");
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
  const pendingAsks = new Map<string, AskUserRequest>();

  const rememberAsk = (conversationId: string, ask: AskUserRequest): void => {
    pendingAsks.delete(conversationId);
    pendingAsks.set(conversationId, ask);
    while (pendingAsks.size > MAX_PENDING_ASKS) {
      const oldest = pendingAsks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingAsks.delete(oldest);
    }
  };

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
          startedAt: serverStartedAt,
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
      sendJson(response, 200, operatorInfo(identity, startedAt, options.host));
      return;
    }
    if (requestUrl.pathname === OPERATOR_ROUTES.health) {
      if (!requireMethod(request, response, "GET")) return;
      sendJson(response, 200, await operatorHealth(degradedMessage, options.host?.readHealth));
      return;
    }
    if (requestUrl.pathname === OPERATOR_ROUTES.config) {
      if (!requireMethod(request, response, "GET")) return;
      await handleConfig(response);
      return;
    }
    if (requestUrl.pathname === OPERATOR_ROUTES.conversations) {
      if (!requireMethod(request, response, "GET")) return;
      await handleConversations(response);
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

    const liveInputConversation = matchConversationMutation(requestUrl.pathname, "live-input");
    if (liveInputConversation !== undefined) {
      if (!requireMethod(request, response, "POST")) return;
      if (!requireJsonContentType(request, response)) return;
      await handleLiveInput(request, response, liveInputConversation);
      return;
    }

    const askConversation = matchConversationMutation(requestUrl.pathname, "ask");
    if (askConversation !== undefined) {
      if (request.method === "GET") {
        const snapshot: OperatorAskSnapshot = { ask: pendingAsks.get(askConversation) ?? null };
        sendJson(response, 200, snapshot);
        return;
      }
      if (!requireMethod(request, response, "POST")) return;
      if (!requireJsonContentType(request, response)) return;
      await handleAskAnswer(request, response, askConversation);
      return;
    }

    const replayConversation = matchConversationMutation(requestUrl.pathname, "replay");
    if (replayConversation !== undefined) {
      if (!requireMethod(request, response, "GET")) return;
      await handleReplay(response, replayConversation);
      return;
    }

    sendJson(response, 404, errorBody("not_found", "Operator route not found."));
  };

  const handleTurn = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let turnRequest: OperatorTurnRequest;
    let attachments: readonly ChannelAttachment[];
    let quote: ResolvedOperatorQuote | undefined;
    try {
      turnRequest = parseTurnRequest(await readBoundedJsonBody(request, OPERATOR_LIMITS.requestBytes));
      if (turnRequest.input.quote !== undefined) {
        if (options.host?.readReplay === undefined) {
          throw new HttpError(422, "unsupported_capability", "This operator endpoint does not accept quotes.");
        }
        quote = await resolveOperatorQuote(
          options.host.readReplay,
          turnRequest,
          new AbortController().signal,
        );
      }
      attachments = (turnRequest.input.attachments ?? []).map(toChannelAttachment);
    } catch (error) {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(400, "invalid_request", "The operator turn request is invalid.");
      closeAfterOversize(request, response, failure);
      return;
    }

    const turnId = randomUUID();
    const startedAt = new Date().toISOString();
    let settleActive!: () => void;
    const active: ActiveTurn = {
      turnId,
      conversationId: turnRequest.conversationId,
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settleActive = resolve;
      }),
      settle: () => settleActive(),
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
    let projectedUsage: OperatorUsage | undefined;
    const reply: ChannelReplySink = {
      async emit(event: ChannelReplyEvent): Promise<void> {
        switch (event.type) {
          case "text-delta":
            text += event.delta;
            await writer.write(
              projectDeltaFrame(turnId, "assistant", event.delta, "append").frame,
            );
            break;
          case "thinking-delta":
            await writer.write(
              projectDeltaFrame(turnId, "thought", event.delta, "append").frame,
            );
            break;
          case "text-replace":
            text = event.text;
            await writer.write(
              projectDeltaFrame(turnId, "assistant", event.text, "replace").frame,
            );
            break;
          case "activity":
            await writer.write(projectActivityFrame(turnId, event.text));
            break;
          case "tool-call":
            await writer.write({ type: "tool_call", turnId, call: operatorToolCall(event.call) });
            break;
          case "tool-result":
            await writer.write({ type: "tool_result", turnId, result: operatorToolResult(event.result) });
            break;
          case "attachment":
            unsupportedAttachment = true;
            break;
          case "ask-user":
            rememberAsk(turnRequest.conversationId, event.ask);
            await writer.write({ type: "ask_user", turnId, ask: event.ask });
            break;
          case "usage":
            projectedUsage = mergeOperatorUsage(
              projectedUsage,
              operatorUsage(event.usage),
            );
            await writer.write({ type: "usage", turnId, usage: projectedUsage });
            break;
          case "compaction":
            projectedUsage = mergeOperatorUsage(
              projectedUsage,
              {
                inputTokens: projectedUsage?.inputTokens ?? 0,
                outputTokens: projectedUsage?.outputTokens ?? 0,
                compacted: event.compaction.compacted,
                sessionEvicted: false,
              },
            );
            await writer.write({ type: "compaction", turnId, compaction: event.compaction });
            await writer.write({ type: "usage", turnId, usage: projectedUsage });
            break;
          case "session-evicted":
            projectedUsage = mergeOperatorUsage(
              projectedUsage,
              {
                inputTokens: projectedUsage?.inputTokens ?? 0,
                outputTokens: projectedUsage?.outputTokens ?? 0,
                compacted: false,
                sessionEvicted: true,
              },
            );
            await writer.write({ type: "usage", turnId, usage: projectedUsage });
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
      const result = await untilAborted(
        options.dispatch(
          toInboundRequest(
            identity,
            turnId,
            startedAt,
            turnRequest,
            attachments,
            quote,
            active.controller.signal,
          ),
          reply,
        ),
        active.controller.signal,
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
        await writer.write(projectCompletedFrame(
          turnId,
          result.text ?? text,
          result.messageId,
        ));
      }
    } catch (error) {
      if (
        !(error instanceof StreamClosedError)
        && !(error instanceof StreamLimitError)
        && !response.destroyed
        && !response.writableEnded
      ) {
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
      active.settle();
      if (active.controller.signal.aborted) pendingAsks.delete(turnRequest.conversationId);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  };

  const handleCancel = async (
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> => {
    let cancelRequest;
    try {
      cancelRequest = parseCancelRequest(await readBoundedJsonBody(request, OPERATOR_LIMITS.requestBytes));
    } catch (error) {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(400, "invalid_request", "The operator cancellation request is invalid.");
      closeAfterOversize(request, response, failure);
      return;
    }
    const turns = activeByConversation.get(conversationId);
    const hostResult = options.host?.cancel === undefined
      ? undefined
      : await options.host.cancel({ conversationId, ...(cancelRequest.reason === undefined ? {} : { reason: cancelRequest.reason }), signal: new AbortController().signal });
    if ((turns === undefined || turns.size === 0) && hostResult?.status !== "accepted") {
      const idle: OperatorCancelResponse = { status: "idle" };
      sendJson(response, 200, idle);
      return;
    }
    for (const turn of turns ?? []) {
      turn.controller.abort(new Error("Operator cancellation requested."));
    }
    const accepted: OperatorCancelResponse = { status: "accepted" };
    sendJson(response, 202, accepted);
  };

  const handleLiveInput = async (
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> => {
    let input;
    try { input = parseLiveInputRequest(await readBoundedJsonBody(request, OPERATOR_LIMITS.requestBytes)); }
    catch (error) { closeAfterOversize(request, response, error instanceof HttpError ? error : new HttpError(400, "invalid_request", "The live input request is invalid.")); return; }
    if (options.host?.offerLiveInput === undefined) {
      const unavailable: OperatorLiveInputResponse = { status: "unavailable" };
      sendJson(response, 501, unavailable);
      return;
    }
    const result = await options.host.offerLiveInput({ conversationId, ...input, signal: new AbortController().signal });
    const mapped: OperatorLiveInputResponse = { status: result.status };
    sendJson(response, result.status === "unavailable" ? 409 : 200, mapped);
  };

  const handleAskAnswer = async (
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> => {
    let input;
    try { input = parseAskAnswerRequest(await readBoundedJsonBody(request, OPERATOR_LIMITS.askAnswerRequestBytes)); }
    catch (error) { closeAfterOversize(request, response, error instanceof HttpError ? error : new HttpError(400, "invalid_request", "The AskUser answer is invalid.")); return; }
    const pending = pendingAsks.get(conversationId);
    if (pending === undefined || pending.interactionId !== input.interactionId || options.host?.answerAsk === undefined) {
      const mismatch: OperatorAskAnswerResponse = { status: "mismatch" };
      sendJson(response, 409, mismatch);
      return;
    }
    const result = await options.host.answerAsk(conversationId, { interactionId: input.interactionId, answers: input.answers, answeredAt: new Date().toISOString() }, new AbortController().signal);
    const mapped: OperatorAskAnswerResponse = { status: result.status === "unsupported" ? "mismatch" : result.status };
    if (mapped.status === "accepted" || mapped.status === "expired") pendingAsks.delete(conversationId);
    sendJson(response, mapped.status === "accepted" ? 200 : 409, mapped);
  };

  const handleConversations = async (response: ServerResponse): Promise<void> => {
    if (options.host?.listConversations === undefined) {
      sendJson(response, 501, errorBody("unsupported", "Conversation listing is unsupported."));
      return;
    }
    const result = await options.host.listConversations({ limit: 10_000, signal: new AbortController().signal });
    const body: OperatorConversationList = {
      conversations: result.conversations.map((conversation) => {
        const activeTurnId = [...(activeByConversation.get(conversation.conversationId) ?? [])][0]?.turnId;
        const triggerKind = operatorTriggerKind(conversation.metadata);
        return {
          id: conversation.conversationId,
          ...(conversation.title === undefined ? {} : { title: conversation.title }),
          updatedAt: conversation.updatedAt,
          ...(activeTurnId === undefined ? {} : { activeTurnId }),
          ...(triggerKind === undefined ? {} : { triggerKind }),
        };
      }),
    };
    sendJson(response, 200, body);
  };

  const handleReplay = async (response: ServerResponse, conversationId: string): Promise<void> => {
    if (options.host?.readReplay === undefined) {
      sendJson(response, 501, errorBody("unsupported", "Conversation replay is unsupported."));
      return;
    }
    const result = await options.host.readReplay({ conversationId, limit: CORE_REPLAY_PAGE_LIMIT, signal: new AbortController().signal });
    const activeTurnId = [...(activeByConversation.get(conversationId) ?? [])][0]?.turnId;
    const body: OperatorReplayResponse = {
      conversationId,
      messages: result.entries.map((entry) =>
        toOperatorMessage(entry.message, entry.createdAt, entry.turnId)),
      ...(activeTurnId === undefined ? {} : { activeTurnId }),
    };
    sendJson(response, 200, body);
  };

  const handleConfig = async (response: ServerResponse): Promise<void> => {
    if (options.host?.readConfig === undefined) {
      sendJson(response, 501, errorBody("unsupported", "Config view is unsupported."));
      return;
    }
    const value = await options.host.readConfig(new AbortController().signal);
    const generatedAt = new Date().toISOString();
    const body: OperatorConfigView = {
      revision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      generatedAt,
      value: asConfigObject(value),
      redacted: true,
    };
    sendJson(response, 200, body);
  };

  const health = (): OperatorChannelHealth => Object.freeze({
    status: currentStartInfo === undefined || stopping
      ? "stopped"
      : degradedMessage === undefined
        ? "healthy"
        : "degraded",
    activeTurns: [...activeByConversation.values()].reduce((count, turns) => count + turns.size, 0),
    ...(degradedMessage === undefined ? {} : { message: degradedMessage }),
  });

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const activeSettlements = [...activeByConversation.values()].flatMap((turns) =>
        [...turns].map((turn) => turn.settled));
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
      if (!await settleWithin(Promise.allSettled(activeSettlements), SHUTDOWN_BOUND_MS)) {
        throw new Error("Operator turns did not stop within the shutdown bound.");
      }
      sockets.clear();
      pendingAsks.clear();
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

function matchConversationMutation(pathname: string, action: "cancel" | "live-input" | "ask" | "replay"): string | undefined {
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
  let resolvedStatus = statusCode;
  let payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.byteLength > OPERATOR_LIMITS.jsonResponseBytes) {
    resolvedStatus = 507;
    payload = Buffer.from(JSON.stringify(errorBody("response_too_large", "The operator response exceeds its byte limit.")), "utf8");
  }
  response.writeHead(resolvedStatus, {
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

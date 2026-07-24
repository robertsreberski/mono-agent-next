import { isIP } from "node:net";

import {
  parseAskAnswerRequest,
  parseAskAnswerResponse,
  parseAskSnapshot,
  parseCancelRequest,
  parseCancelResponse,
  parseConfigView,
  parseConversationList,
  parseHealth,
  parseLiveInputRequest,
  parseLiveInputResponse,
  parseOperatorFrame,
  parseOperatorInfo,
  parseReplayResponse,
  parseTurnRequest,
} from "./protocol.js";
import {
  OPERATOR_IDENTIFIER_PATTERN,
  OPERATOR_LIMITS,
  OPERATOR_ROUTES,
  type OperatorAskAnswerRequest,
  type OperatorAskAnswerResponse,
  type OperatorAskSnapshot,
  type OperatorCancelRequest,
  type OperatorCancelResponse,
  type OperatorConfigView,
  type OperatorConversationList,
  type OperatorFrame,
  type OperatorHealth,
  type OperatorInfo,
  type OperatorLiveInputRequest,
  type OperatorLiveInputResponse,
  type OperatorReplayResponse,
  type OperatorTurnRequest,
} from "./types.js";

export interface OperatorClientLimits {
  readonly requestBytes: number;
  readonly askAnswerRequestBytes: number;
  readonly jsonResponseBytes: number;
  readonly frameBytes: number;
  readonly streamBytes: number;
}

export interface OperatorClientOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly limits?: Partial<OperatorClientLimits>;
}

export interface OperatorStreamOptions {
  readonly signal?: AbortSignal;
}

export class OperatorClientError extends Error {
  readonly code:
    | "INVALID_ENDPOINT"
    | "INVALID_VALUE"
    | "REQUEST_TOO_LARGE"
    | "HTTP_ERROR"
    | "INVALID_CONTENT_TYPE"
    | "RESPONSE_TOO_LARGE"
    | "INVALID_JSON"
    | "INVALID_STREAM"
    | "TIMEOUT";
  readonly status?: number;

  constructor(code: OperatorClientError["code"], message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OperatorClientError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OperatorClientError("INVALID_ENDPOINT", `${name} must be a positive safe integer`);
  }
  return value;
}

export function normalizeOperatorEndpoint(authored: string): string {
  let url: URL;
  try {
    url = new URL(authored);
  } catch (cause) {
    throw new OperatorClientError("INVALID_ENDPOINT", "operator endpoint must be an absolute URL", { cause });
  }
  if (url.protocol !== "http:") {
    throw new OperatorClientError("INVALID_ENDPOINT", "operator endpoint must use HTTP on loopback");
  }
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literalIpv4Loopback = isIP(hostname) === 4 && hostname.split(".", 1)[0] === "127";
  if (!literalIpv4Loopback && hostname !== "::1") {
    throw new OperatorClientError("INVALID_ENDPOINT", "operator endpoint must use a literal 127/8 or ::1 loopback address");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OperatorClientError("INVALID_ENDPOINT", "operator endpoint must not contain user information");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new OperatorClientError("INVALID_ENDPOINT", "operator endpoint must not contain a query or fragment");
  }
  if (url.pathname.includes("..")) {
    throw new OperatorClientError("INVALID_ENDPOINT", "operator endpoint path must not contain parent traversal");
  }
  url.pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function responseContentType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Release the socket before rejecting. An undici response whose body is never
 * read or cancelled keeps its connection checked out for the agent's lifetime,
 * so every early return from a response path has to drain it first.
 */
async function discardBody(
  response: Response,
  error: OperatorClientError,
): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw error;
}

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    return await discardBody(
      response,
      new OperatorClientError("RESPONSE_TOO_LARGE", `operator response exceeds ${limit} bytes`),
    );
  }
  if (response.body === null) throw new OperatorClientError("INVALID_JSON", "operator response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new OperatorClientError("RESPONSE_TOO_LARGE", `operator response exceeds ${limit} bytes`);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Conversation routes interpolate this id, and `encodeURIComponent` does not
 * encode dots, so an unvalidated `..` would silently retarget the request at a
 * sibling route. Reject it here, before any route string exists.
 */
function conversationRoute(
  conversationId: string,
  route: (conversationId: string) => string,
): string {
  if (
    typeof conversationId !== "string"
    || conversationId.length === 0
    || conversationId.length > OPERATOR_LIMITS.identifierCharacters
    || !OPERATOR_IDENTIFIER_PATTERN.test(conversationId)
  ) {
    throw new OperatorClientError("INVALID_VALUE", "operator conversationId is not a valid identifier");
  }
  return route(conversationId);
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (responseContentType(response) !== "application/json") {
    return await discardBody(
      response,
      new OperatorClientError("INVALID_CONTENT_TYPE", "operator response must use application/json"),
    );
  }
  const bytes = await readBoundedBytes(response, limit);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new OperatorClientError("INVALID_JSON", "operator response contains invalid JSON", { cause });
  }
}

function requestBody(value: unknown, limit: number): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch (cause) {
    throw new OperatorClientError("INVALID_JSON", "operator request is not JSON serializable", { cause });
  }
  if (new TextEncoder().encode(body).byteLength > limit) {
    throw new OperatorClientError("REQUEST_TOO_LARGE", `operator request exceeds ${limit} bytes`);
  }
  return body;
}

function createDeadline(timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("operator request deadline exceeded")), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export class OperatorClient {
  readonly endpoint: string;
  readonly limits: OperatorClientLimits;
  readonly requestTimeoutMs: number;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OperatorClientOptions) {
    this.endpoint = normalizeOperatorEndpoint(options.endpoint);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = positiveLimit(options.requestTimeoutMs ?? 15_000, "requestTimeoutMs");
    this.limits = {
      requestBytes: positiveLimit(options.limits?.requestBytes ?? OPERATOR_LIMITS.requestBytes, "limits.requestBytes"),
      askAnswerRequestBytes: positiveLimit(options.limits?.askAnswerRequestBytes ?? OPERATOR_LIMITS.askAnswerRequestBytes, "limits.askAnswerRequestBytes"),
      jsonResponseBytes: positiveLimit(options.limits?.jsonResponseBytes ?? OPERATOR_LIMITS.jsonResponseBytes, "limits.jsonResponseBytes"),
      frameBytes: positiveLimit(options.limits?.frameBytes ?? OPERATOR_LIMITS.frameBytes, "limits.frameBytes"),
      streamBytes: positiveLimit(options.limits?.streamBytes ?? OPERATOR_LIMITS.streamBytes, "limits.streamBytes"),
    };
  }

  #url(route: string): string {
    return `${this.endpoint}${route}`;
  }

  #headers(jsonBody = false): Headers {
    const headers = new Headers({ accept: "application/json" });
    if (jsonBody) headers.set("content-type", "application/json");
    if (this.#token !== undefined) headers.set("authorization", `Bearer ${this.#token}`);
    return headers;
  }

  async #fetchResponse(route: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const deadline = createDeadline(this.requestTimeoutMs);
    const requestSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    try {
      return await this.#fetch(this.#url(route), { ...init, redirect: "error", signal: requestSignal });
    } catch (cause) {
      if (signal?.aborted === true) throw signal.reason;
      if (deadline.signal.aborted) throw new OperatorClientError("TIMEOUT", `operator request timed out after ${this.requestTimeoutMs}ms`);
      throw new OperatorClientError("HTTP_ERROR", "operator request failed", { cause });
    } finally {
      // The request timeout bounds response headers only here. JSON calls add a
      // second deadline around body consumption; turn streams remain live until
      // the caller aborts, consumes the terminal frame, or disconnects.
      deadline.dispose();
    }
  }

  async #json(
    route: string,
    init: RequestInit,
    parser: (value: unknown) => unknown,
    signal?: AbortSignal,
    acceptedStatuses: readonly number[] = [],
  ): Promise<unknown> {
    const deadline = createDeadline(this.requestTimeoutMs);
    const requestSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    try {
      const response = await this.#fetchResponse(route, init, requestSignal);
      if (!response.ok && !acceptedStatuses.includes(response.status)) {
        await response.body?.cancel();
        throw new OperatorClientError("HTTP_ERROR", `operator request failed with HTTP ${response.status}`, { status: response.status });
      }
      return parser(await readBoundedJson(response, this.limits.jsonResponseBytes));
    } catch (cause) {
      if (signal?.aborted === true) throw signal.reason;
      if (deadline.signal.aborted) throw new OperatorClientError("TIMEOUT", `operator request timed out after ${this.requestTimeoutMs}ms`);
      throw cause;
    } finally {
      deadline.dispose();
    }
  }

  async getInfo(signal?: AbortSignal): Promise<OperatorInfo> {
    return await this.#json(OPERATOR_ROUTES.info, { method: "GET", headers: this.#headers() }, parseOperatorInfo, signal) as OperatorInfo;
  }

  async getConversations(signal?: AbortSignal): Promise<OperatorConversationList> {
    return await this.#json(OPERATOR_ROUTES.conversations, { method: "GET", headers: this.#headers() }, parseConversationList, signal) as OperatorConversationList;
  }

  async getPendingAsk(conversationId: string, signal?: AbortSignal): Promise<OperatorAskSnapshot> {
    return await this.#json(conversationRoute(conversationId, OPERATOR_ROUTES.ask), { method: "GET", headers: this.#headers() }, parseAskSnapshot, signal) as OperatorAskSnapshot;
  }

  async answerAsk(conversationId: string, request: OperatorAskAnswerRequest, signal?: AbortSignal): Promise<OperatorAskAnswerResponse> {
    const parsed = parseAskAnswerRequest(request);
    return await this.#json(conversationRoute(conversationId, OPERATOR_ROUTES.ask), { method: "POST", headers: this.#headers(true), body: requestBody(parsed, this.limits.askAnswerRequestBytes) }, parseAskAnswerResponse, signal, [409]) as OperatorAskAnswerResponse;
  }

  async cancelConversation(conversationId: string, request: OperatorCancelRequest = {}, signal?: AbortSignal): Promise<OperatorCancelResponse> {
    const parsed = parseCancelRequest(request);
    return await this.#json(conversationRoute(conversationId, OPERATOR_ROUTES.cancel), { method: "POST", headers: this.#headers(true), body: requestBody(parsed, this.limits.requestBytes) }, parseCancelResponse, signal, [409, 501]) as OperatorCancelResponse;
  }

  async offerLiveInput(conversationId: string, request: OperatorLiveInputRequest, signal?: AbortSignal): Promise<OperatorLiveInputResponse> {
    const parsed = parseLiveInputRequest(request);
    return await this.#json(conversationRoute(conversationId, OPERATOR_ROUTES.liveInput), { method: "POST", headers: this.#headers(true), body: requestBody(parsed, this.limits.requestBytes) }, parseLiveInputResponse, signal, [409, 501]) as OperatorLiveInputResponse;
  }

  async getReplay(conversationId: string, signal?: AbortSignal): Promise<OperatorReplayResponse> {
    return await this.#json(conversationRoute(conversationId, OPERATOR_ROUTES.replay), { method: "GET", headers: this.#headers() }, parseReplayResponse, signal) as OperatorReplayResponse;
  }

  async getConfig(signal?: AbortSignal): Promise<OperatorConfigView> {
    return await this.#json(OPERATOR_ROUTES.config, { method: "GET", headers: this.#headers() }, parseConfigView, signal) as OperatorConfigView;
  }

  async getHealth(signal?: AbortSignal): Promise<OperatorHealth> {
    return await this.#json(OPERATOR_ROUTES.health, { method: "GET", headers: this.#headers() }, parseHealth, signal) as OperatorHealth;
  }

  async *streamTurn(request: OperatorTurnRequest, options: OperatorStreamOptions = {}): AsyncGenerator<OperatorFrame, void, void> {
    const parsedRequest = parseTurnRequest(request);
    const controller = new AbortController();
    const fetchSignal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    let response: Response;
    try {
      response = await this.#fetchResponse(OPERATOR_ROUTES.turns, {
        method: "POST",
        headers: new Headers({ ...Object.fromEntries(this.#headers(true)), accept: "application/x-ndjson" }),
        body: requestBody(parsedRequest, this.limits.requestBytes),
      }, fetchSignal);
    } catch (error) {
      controller.abort();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      controller.abort();
      throw new OperatorClientError("HTTP_ERROR", `operator turn failed with HTTP ${response.status}`, { status: response.status });
    }
    if (responseContentType(response) !== "application/x-ndjson") {
      await response.body?.cancel();
      controller.abort();
      throw new OperatorClientError("INVALID_CONTENT_TYPE", "operator turn response must use application/x-ndjson");
    }
    if (response.body === null) {
      controller.abort();
      throw new OperatorClientError("INVALID_STREAM", "operator turn response has no body");
    }

    const reader = response.body.getReader();
    let buffered = new Uint8Array(0);
    let totalBytes = 0;
    let acceptedTurnId: string | undefined;
    let terminal = false;
    const decodeLine = (line: Uint8Array): OperatorFrame => {
      if (line.byteLength === 0) throw new OperatorClientError("INVALID_STREAM", "operator stream contains an empty frame");
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch (cause) {
        throw new OperatorClientError("INVALID_STREAM", "operator stream contains malformed JSON", { cause });
      }
      try {
        return parseOperatorFrame(parsed);
      } catch (cause) {
        throw new OperatorClientError("INVALID_STREAM", "operator stream contains an invalid frame", { cause });
      }
    };

    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        totalBytes += item.value.byteLength;
        if (totalBytes > this.limits.streamBytes) {
          throw new OperatorClientError("RESPONSE_TOO_LARGE", `operator stream exceeds ${this.limits.streamBytes} bytes`);
        }
        const next = new Uint8Array(buffered.byteLength + item.value.byteLength);
        next.set(buffered);
        next.set(item.value, buffered.byteLength);
        buffered = next;

        let newline = buffered.indexOf(10);
        while (newline >= 0) {
          const frameBytes = buffered.subarray(0, newline > 0 && buffered[newline - 1] === 13 ? newline - 1 : newline);
          if (newline + 1 > this.limits.frameBytes) {
            throw new OperatorClientError("RESPONSE_TOO_LARGE", `operator frame exceeds ${this.limits.frameBytes} bytes`);
          }
          buffered = buffered.slice(newline + 1);
          const frame = decodeLine(frameBytes);
          if (terminal) throw new OperatorClientError("INVALID_STREAM", "operator stream contains a frame after its terminal frame");
          if (acceptedTurnId === undefined) {
            if (frame.type === "accepted") acceptedTurnId = frame.turnId;
            else if (frame.type !== "error") throw new OperatorClientError("INVALID_STREAM", "operator stream must begin with an accepted or error frame");
          } else if (frame.type !== "error" || frame.turnId !== undefined) {
            if (frame.type === "accepted" || frame.turnId !== acceptedTurnId) {
              throw new OperatorClientError("INVALID_STREAM", "operator stream frame turnId does not match its accepted frame");
            }
          }
          terminal = frame.type === "completed" || frame.type === "error";
          yield frame;
          newline = buffered.indexOf(10);
        }
        if (buffered.byteLength > this.limits.frameBytes) {
          throw new OperatorClientError("RESPONSE_TOO_LARGE", `operator frame exceeds ${this.limits.frameBytes} bytes`);
        }
      }
      if (buffered.byteLength !== 0) throw new OperatorClientError("INVALID_STREAM", "operator stream ended with an incomplete frame");
      if (!terminal) throw new OperatorClientError("INVALID_STREAM", "operator stream ended without a terminal frame");
    } finally {
      controller.abort(new Error("operator stream consumer disconnected"));
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or errored.
      }
      reader.releaseLock();
    }
  }
}

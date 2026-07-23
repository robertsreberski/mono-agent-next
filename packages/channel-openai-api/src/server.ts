import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isIP } from "node:net";
import { hostname as systemHostname, networkInterfaces } from "node:os";

import type {
  ChannelInboundRequest,
  ChannelReplyEvent,
  ChannelReplySink,
  ChannelTurnResult,
  RuntimeToolCall,
  RuntimeUsage,
} from "@mono-agent/module-sdk";

import { isLoopbackHost, type OpenAiApiConfig } from "./config.js";
import { renderOpenWebUiToolDetail } from "./tool-details.js";
import { OpenAiRequestError, parseOpenAiChatRequest, toChannelRequest } from "./translation.js";

const SHUTDOWN_MS = 1_000;
const SSE_TERMINAL_RESERVE_BYTES = 2_048;
const MAX_TOOL_CALLS_PER_TURN = 256;

export type OpenAiDispatch = (request: ChannelInboundRequest, reply: ChannelReplySink) => Promise<ChannelTurnResult>;
export interface OpenAiApiStartInfo { readonly host: string; readonly port: number; readonly baseUrl: string; readonly modelsUrl: string; readonly chatCompletionsUrl: string; }
export interface OpenAiApiHealth { readonly status: "stopped" | "healthy" | "degraded"; readonly activeRequests: number; readonly message?: string; }
export interface OpenAiApiServer { readonly startInfo: OpenAiApiStartInfo | undefined; start(): Promise<OpenAiApiStartInfo>; stop(): Promise<void>; health(): OpenAiApiHealth; }
export interface CreateOpenAiApiServerOptions { readonly config: OpenAiApiConfig; readonly dispatch: OpenAiDispatch; }

interface OutputBudget { remaining: number; }
interface OpenAiUsage { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number; }
interface ToolDetailPlacement { readonly textOffset: number; readonly rendered: string; }

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function createOpenAiApiServer(options: CreateOpenAiApiServerOptions): OpenAiApiServer {
  assertStartSafety(options.config);
  let server: Server | undefined;
  let info: OpenAiApiStartInfo | undefined;
  let startPromise: Promise<OpenAiApiStartInfo> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let degraded: string | undefined;
  const sockets = new Set<Socket>();
  const active = new Set<AbortController>();

  const start = (): Promise<OpenAiApiStartInfo> => {
    if (startPromise !== undefined) return startPromise;
    if (stopping) return Promise.reject(new Error("OpenAI API channel cannot restart after stop."));
    startPromise = new Promise((resolve, reject) => {
      const next = createServer((request, response) => {
        securityHeaders(response);
        void route(request, response).catch((error) => sendError(response, error));
      });
      next.requestTimeout = 30_000;
      next.headersTimeout = 10_000;
      next.keepAliveTimeout = 5_000;
      next.maxHeadersCount = 100;
      server = next;
      next.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      next.on("clientError", (_error, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      const onError = (error: Error): void => {
        degraded = "OpenAI API listener failed.";
        reject(error);
      };
      next.once("error", onError);
      next.listen(options.config.listen.port, options.config.listen.host, () => {
        next.off("error", onError);
        if (stopping) {
          void closeServer(next);
          reject(new Error("OpenAI API channel stopped while starting."));
          return;
        }
        const address = next.address();
        if (
          address === null
          || typeof address === "string"
          || (!isLoopbackHost(address.address) && options.config.allowNonLoopback !== true)
          || (!isLoopbackHost(address.address) && options.config.apiKey.length < 32)
        ) {
          reject(new Error("OpenAI API listener resolved to an unauthorized non-loopback address."));
          void closeServer(next);
          return;
        }
        const host = bracket(advertisedHost(options.config.listen.host));
        const baseUrl = `http://${host}:${address.port}${options.config.basePath}`;
        info = Object.freeze({
          host: options.config.listen.host,
          port: address.port,
          baseUrl,
          modelsUrl: `${baseUrl}/models`,
          chatCompletionsUrl: `${baseUrl}/chat/completions`,
        });
        next.on("error", () => { degraded = "OpenAI API listener failed after startup."; });
        resolve(info);
      });
    });
    return startPromise;
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const controller of active) controller.abort(new HttpError(503, "shutting_down", "The channel is stopping."));
      const closing = server === undefined ? Promise.resolve() : closeServer(server);
      server?.closeIdleConnections?.();
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, SHUTDOWN_MS);
      timer.unref();
      try {
        await Promise.race([closing, delay(SHUTDOWN_MS)]);
      } finally {
        clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        info = undefined;
      }
    })();
    return stopPromise;
  };

  return {
    get startInfo() { return info; },
    start,
    stop,
    health() {
      return {
        status: degraded === undefined ? info === undefined || stopping ? "stopped" : "healthy" : "degraded",
        activeRequests: active.size,
        ...(degraded === undefined ? {} : { message: degraded }),
      };
    },
  };

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (stopping) throw new HttpError(503, "shutting_down", "The channel is stopping.");
    if (info === undefined) throw new HttpError(503, "not_started", "The channel is not started.");
    const authority = validateAuthority(request, options.config.listen.host, info.port);
    const target = request.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) throw new HttpError(400, "invalid_target", "Request target must be origin-form.");
    const url = new URL(target, "http://openai.invalid");
    authenticate(request, options.config.apiKey);
    if (target.includes("?") || target.includes("#") || url.search !== "" || url.hash !== "") {
      throw new HttpError(400, "invalid_query", "Query strings and fragments are not accepted.");
    }
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && url.pathname === `${options.config.basePath}/models`) {
      sendJson(response, 200, { object: "list", data: [{ id: options.config.modelId, object: "model", created: 0, owned_by: "mono-agent" }] });
      return;
    }
    if (request.method === "POST" && url.pathname === `${options.config.basePath}/chat/completions`) {
      mutationSafety(request, authority);
      const parsed = parseOpenAiChatRequest(
        await readJson(request, options.config.maxBodyBytes),
        options.config,
        conversationHeader(request),
      );
      if (parsed.warnings.length > 0) response.setHeader("x-mono-agent-warnings", parsed.warnings.join(","));
      await completion(parsed, response);
      return;
    }
    throw new HttpError(404, "not_found", "Not found.");
  }

  async function completion(parsed: ReturnType<typeof parseOpenAiChatRequest>, response: ServerResponse): Promise<void> {
    const id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1_000);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new HttpError(504, "turn_timeout", "The Core dispatch exceeded maxRunMs.")),
      options.config.maxRunMs,
    );
    timeout.unref();
    active.add(controller);
    const budget: OutputBudget = { remaining: options.config.maxResponseBytes };
    let text = "";
    let textBytes = 0;
    let streamedText = "";
    let streamStarted = false;
    let acceptingReplies = true;
    let replyFailure: unknown;
    let usage: OpenAiUsage | undefined;
    let toolDetailBytes = 0;
    const seenToolCallIds = new Set<string>();
    const pendingToolCalls = new Map<string, RuntimeToolCall>();
    const toolDetails: ToolDetailPlacement[] = [];
    const abortForDisconnect = (): void => {
      if (!response.writableEnded) controller.abort(new HttpError(499, "client_closed", "The client disconnected."));
    };
    response.once("close", abortForDisconnect);

    const startStream = async (): Promise<void> => {
      if (streamStarted) return;
      beginSse(response);
      streamStarted = true;
      await writeSse(response, chunk(id, created, parsed.model, { role: "assistant" }), budget, SSE_TERMINAL_RESERVE_BYTES);
    };
    const streamContent = async (value: string): Promise<void> => {
      if (value.length === 0) return;
      await startStream();
      await writeSse(response, chunk(id, created, parsed.model, { content: value }), budget, SSE_TERMINAL_RESERVE_BYTES);
      streamedText += value;
    };
    const streamToolDetail = async (value: string): Promise<void> => {
      await startStream();
      await writeSse(response, chunk(id, created, parsed.model, { content: value }), budget, SSE_TERMINAL_RESERVE_BYTES);
    };
    const reply: ChannelReplySink = {
      async emit(event: ChannelReplyEvent): Promise<void> {
        if (!acceptingReplies) throw new HttpError(502, "late_reply_event", "Core emitted a reply event after dispatch settled.");
        try {
          switch (event.type) {
            case "text-delta": {
              const nextBytes = textBytes + Buffer.byteLength(event.delta);
              assertResponseTextSize(nextBytes, options.config.maxResponseBytes);
              text += event.delta;
              textBytes = nextBytes;
              if (parsed.stream) await streamContent(event.delta);
              return;
            }
            case "text-replace": {
              const nextBytes = Buffer.byteLength(event.text);
              assertResponseTextSize(nextBytes, options.config.maxResponseBytes);
              if (parsed.stream) {
                if (!event.text.startsWith(streamedText)) {
                  throw new HttpError(502, "non_append_text_replace", "Core emitted a text replacement that cannot be represented truthfully in an append-only SSE stream.");
                }
                await streamContent(event.text.slice(streamedText.length));
              }
              text = event.text;
              textBytes = nextBytes;
              return;
            }
            case "usage":
              usage = toOpenAiUsage(event.usage);
              return;
            case "tool-call":
              if (
                seenToolCallIds.has(event.call.id)
                || seenToolCallIds.size >= MAX_TOOL_CALLS_PER_TURN
              ) {
                throw new HttpError(502, "invalid_tool_event", "Core emitted an invalid tool-call sequence.");
              }
              seenToolCallIds.add(event.call.id);
              pendingToolCalls.set(event.call.id, event.call);
              return;
            case "tool-result": {
              const call = pendingToolCalls.get(event.result.callId);
              if (call === undefined) {
                throw new HttpError(502, "invalid_tool_event", "Core emitted an unmatched tool result.");
              }
              pendingToolCalls.delete(event.result.callId);
              const rendered = renderOpenWebUiToolDetail(call, event.result);
              toolDetailBytes += Buffer.byteLength(rendered);
              assertResponseTextSize(toolDetailBytes, options.config.maxResponseBytes);
              if (parsed.stream) {
                await streamToolDetail(rendered);
              } else {
                toolDetails.push({ textOffset: text.length, rendered });
              }
              return;
            }
            case "compaction":
            case "session-evicted":
              return;
            case "activity":
            case "attachment":
            case "ask-user":
            case "approval":
              throw new HttpError(502, "unsupported_reply_event", `OpenAI Chat Completions cannot represent the ${event.type} reply event.`);
            default:
              rejectUnknownReplyEvent(event);
          }
        } catch (error) {
          replyFailure ??= error;
          throw error;
        }
      },
    };

    try {
      const dispatch = Promise.resolve().then(() => options.dispatch(toChannelRequest(parsed, id, controller.signal), reply));
      const result = await raceAbort(dispatch, controller.signal);
      acceptingReplies = false;
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (replyFailure !== undefined) throw replyFailure;
      if (result.status !== "completed") {
        throw new HttpError(result.status === "cancelled" ? 499 : 422, result.status, `Turn ${result.status}.`);
      }
      if (pendingToolCalls.size > 0) {
        throw new HttpError(502, "incomplete_tool_event", "Core completed with an unfinished tool call.");
      }
      const final = result.text ?? text;
      assertResponseTextSize(Buffer.byteLength(final), options.config.maxResponseBytes);
      if (parsed.stream) {
        if (!final.startsWith(streamedText)) {
          throw new HttpError(502, "non_append_final_text", "Core returned final text that cannot be represented truthfully in the active SSE stream.");
        }
        await streamContent(final.slice(streamedText.length));
        await startStream();
        const terminal = [
          sseLine(chunk(id, created, parsed.model, {}, "stop")),
          ...(parsed.includeUsage ? [sseLine(usageChunk(id, created, parsed.model, usage ?? emptyUsage()))] : []),
          "data: [DONE]\n\n",
        ].join("");
        await writeBudgeted(response, terminal, budget, 0);
        response.end();
      } else {
        if (toolDetails.length > 0 && text.length > 0 && !final.startsWith(text)) {
          throw new HttpError(502, "non_append_final_text", "Core returned final text that cannot preserve completed tool ordering.");
        }
        sendJsonBounded(response, 200, {
          id,
          object: "chat.completion",
          created,
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: insertToolDetails(final, toolDetails),
            },
            finish_reason: "stop",
          }],
          usage: usage ?? emptyUsage(),
        }, options.config.maxResponseBytes);
      }
    } catch (error) {
      acceptingReplies = false;
      if (parsed.stream && response.headersSent && !response.destroyed) {
        const terminal = `${sseLine(errorPayload(error))}data: [DONE]\n\n`;
        try {
          await writeBudgeted(response, terminal, budget, 0);
        } catch {
          // The configured output budget is authoritative even for terminal framing.
        }
        response.end();
        return;
      }
      throw error;
    } finally {
      acceptingReplies = false;
      response.off("close", abortForDisconnect);
      clearTimeout(timeout);
      active.delete(controller);
    }
  }
}

function conversationHeader(request: IncomingMessage): string | undefined {
  for (const name of ["x-openwebui-chat-id", "x-conversation-id"] as const) {
    const value = request.headers[name];
    if (value === undefined) continue;
    if (Array.isArray(value) || value.length === 0 || value.length > 256) {
      throw new HttpError(400, "invalid_conversation_id", `${name} must contain one bounded identifier.`);
    }
    return value;
  }
  return undefined;
}

function authenticate(request: IncomingMessage, secret: string): void {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || !sameSecret(header.slice(7), secret)) {
    throw new HttpError(401, "unauthorized", "Unauthorized.");
  }
}

function validateAuthority(request: IncomingMessage, configuredHost: string, port: number): URL {
  const host = request.headers.host;
  if (host === undefined) throw new HttpError(421, "invalid_authority", "Invalid request authority.");
  let authority: URL;
  try {
    authority = new URL(`http://${host}`);
  } catch {
    throw new HttpError(421, "invalid_authority", "Invalid request authority.");
  }
  if (
    effectivePort(authority) !== port
    || authority.username !== ""
    || authority.password !== ""
    || authority.pathname !== "/"
    || authority.search !== ""
    || authority.hash !== ""
  ) throw new HttpError(421, "invalid_authority", "Invalid request authority.");
  const candidate = canonicalHost(authority.hostname);
  const configured = canonicalHost(configuredHost);
  const allowed = isLoopbackHost(configuredHost)
    ? isLoopbackHost(candidate)
    : isWildcardHost(configured)
      ? isAllowedWildcardAuthority(candidate)
      : candidate === configured;
  if (!allowed) throw new HttpError(421, "invalid_authority", "Invalid request authority.");
  return authority;
}

function mutationSafety(request: IncomingMessage, authority: URL): void {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const origin = request.headers.origin;
  if (origin === undefined) {
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      throw new HttpError(403, "cross_origin", "Cross-origin request rejected.");
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "cross_origin", "Cross-origin request rejected.");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.origin !== authority.origin
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new HttpError(403, "cross_origin", "Cross-origin request rejected.");
}

async function readJson(request: IncomingMessage, max: number): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    if (!/^\d+$/u.test(declared)) throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
    if (Number(declared) > max) throw new HttpError(413, "body_too_large", "Request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > max) throw new HttpError(413, "body_too_large", "Request body is too large.");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return;
  const { status, payload } = publicError(error);
  if (status === 401) response.setHeader("www-authenticate", 'Bearer realm="mono-agent-openai-api"');
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, status, payload);
}

function publicError(error: unknown): { readonly status: number; readonly payload: Readonly<Record<string, unknown>> } {
  const known = classifyError(error);
  const status = known?.status ?? 500;
  const message = status >= 500 ? "Internal server error." : known?.message ?? "Request failed.";
  return {
    status,
    payload: {
      error: {
        message,
        type: status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error",
        code: known?.code ?? "internal_error",
      },
    },
  };
}

function errorPayload(error: unknown): Readonly<Record<string, unknown>> {
  return publicError(error).payload;
}

function classifyError(
  error: unknown,
): { readonly status: number; readonly code: string; readonly message: string } | undefined {
  try {
    if (!(error instanceof HttpError) && !(error instanceof OpenAiRequestError)) return undefined;
    const code = /^[a-z0-9_]{1,64}$/u.test(error.code) ? error.code : "internal_error";
    const message = error.message.length <= 512
      ? error.message
      : `${error.message.slice(0, 509)}...`;
    return { status: error.status, code, message };
  } catch {
    return undefined;
  }
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function chunk(id: string, created: number, model: string, delta: Readonly<Record<string, unknown>>, finishReason: string | null = null): unknown {
  return { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function usageChunk(id: string, created: number, model: string, usage: OpenAiUsage): unknown {
  return { id, object: "chat.completion.chunk", created, model, choices: [], usage };
}

function sseLine(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function writeSse(response: ServerResponse, value: unknown, budget: OutputBudget, reserve: number): Promise<void> {
  await writeBudgeted(response, sseLine(value), budget, reserve);
}

async function writeBudgeted(response: ServerResponse, value: string, budget: OutputBudget, reserve: number): Promise<void> {
  const bytes = Buffer.byteLength(value);
  if (bytes > budget.remaining - reserve) throw new HttpError(502, "response_too_large", "Core response exceeds maxResponseBytes.");
  budget.remaining -= bytes;
  await write(response, value);
}

async function write(response: ServerResponse, value: string): Promise<void> {
  if (response.destroyed || response.writableEnded) throw new HttpError(499, "client_closed", "The client disconnected.");
  if (response.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new HttpError(499, "client_closed", "The client disconnected."));
    };
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

function sendJsonBounded(response: ServerResponse, status: number, value: unknown, maxBytes: number): void {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > maxBytes) throw new HttpError(502, "response_too_large", "Core response exceeds maxResponseBytes.");
  sendSerializedJson(response, status, body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendSerializedJson(response, status, `${JSON.stringify(value)}\n`);
}

function sendSerializedJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function assertResponseTextSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) throw new HttpError(502, "response_too_large", "Core response exceeds maxResponseBytes.");
}

function rejectUnknownReplyEvent(event: never): never {
  const type: unknown = Reflect.get(event as object, "type");
  const label = typeof type === "string" && type.length <= 64 ? type : "unknown";
  throw new HttpError(502, "unsupported_reply_event", `OpenAI Chat Completions cannot represent the ${label} reply event.`);
}

function toOpenAiUsage(usage: RuntimeUsage): OpenAiUsage {
  const input = tokenCount(usage.inputTokens, "inputTokens");
  const output = tokenCount(usage.outputTokens, "outputTokens");
  const total = usage.totalTokens === undefined ? input + output : tokenCount(usage.totalTokens, "totalTokens");
  if (!Number.isSafeInteger(total)) throw new HttpError(502, "invalid_usage", "Core emitted invalid usage.");
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

function tokenCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(502, "invalid_usage", `Core emitted invalid ${field}.`);
  return value;
}

function emptyUsage(): OpenAiUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function insertToolDetails(text: string, details: readonly ToolDetailPlacement[]): string {
  let output = "";
  let cursor = 0;
  for (const detail of details) {
    const position = Math.max(cursor, Math.min(detail.textOffset, text.length));
    output += text.slice(cursor, position);
    output += detail.rendered;
    cursor = position;
  }
  return output + text.slice(cursor);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new HttpError(499, "cancelled", "The request was cancelled.");
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
}

function assertStartSafety(config: OpenAiApiConfig): void {
  if (!isLoopbackHost(config.listen.host) && config.allowNonLoopback !== true) {
    throw new Error("OpenAI API channel may bind outside loopback only with explicit allowNonLoopback.");
  }
  if (
    typeof config.apiKey !== "string"
    || config.apiKey.length < 20
    || config.apiKey.length > 4_096
    || /\s/u.test(config.apiKey)
  ) {
    throw new Error("OpenAI API channel requires a resolved 20-4096 character apiKey.");
  }
  if (!isLoopbackHost(config.listen.host) && config.apiKey.length < 32) {
    throw new Error("A non-loopback OpenAI API listener requires an apiKey of at least 32 characters.");
  }
}

function advertisedHost(configuredHost: string): string {
  const canonical = canonicalHost(configuredHost);
  if (!isWildcardHost(canonical)) return configuredHost;
  return canonical === "0.0.0.0" || canonical === "::ffff:0:0" ? "127.0.0.1" : "::1";
}

function isAllowedWildcardAuthority(host: string): boolean {
  if (isWildcardHost(host) || isLoopbackHost(host)) return true;
  const machine = canonicalHost(systemHostname());
  if (host === machine || host === `${machine}.local`) return true;
  if (isIP(host) === 0) return false;
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (canonicalHost(entry.address) === host) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function isWildcardHost(host: string): boolean {
  const canonical = canonicalHost(host);
  return canonical === "0.0.0.0" || canonical === "::" || canonical === "::ffff:0:0";
}

function canonicalHost(host: string): string {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (isIP(normalized) !== 6) return normalized;
  try {
    return new URL(`http://[${normalized}]/`).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  } catch {
    return normalized;
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function effectivePort(url: URL): number {
  return url.port === "" ? url.protocol === "https:" ? 443 : 80 : Number(url.port);
}

function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

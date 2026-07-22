import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

import {
  BufferedMessageStream,
  BoundedHttpResponseWriter,
  closeServerBounded,
  isAgentResponseCancelledError,
  type AgentAttachment,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  hostForUrl,
  isLoopbackHost,
  isWildcardHost,
  listen,
  normalizeHostForBind,
  readAuthorizationBearer,
  sanitizeInboundHttpHeaders,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  DEFAULT_BASE_PATH,
  DEFAULT_HOST,
  DEFAULT_MAX_TOOL_PAYLOAD_BYTES,
  DEFAULT_MODEL_ID,
  DEFAULT_PORT,
  MAX_TOOL_SSE_FRAME_BYTES,
} from "./constants.js";
import { OpenAIApiAdapterError } from "./errors.js";

export interface OpenAIApiRequestMetadata {
  readonly requestId: string;
  readonly model: string;
  readonly stream: boolean;
  readonly method: string;
  readonly path: string;
  readonly receivedAt: string;
  readonly remoteAddress?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly parameters: Record<string, unknown>;
  readonly attachments?: OpenAIApiAttachmentMetadata;
}

export type OpenAIApiAttachmentUrlKind = "data" | "remote" | "file" | "other";
export type OpenAIApiImageDetail = "auto" | "low" | "high";

export interface OpenAIApiImageAttachment {
  readonly type: "image";
  readonly source: "image_url";
  readonly url: string;
  readonly urlKind: OpenAIApiAttachmentUrlKind;
  readonly mediaType?: string;
  readonly detail?: OpenAIApiImageDetail;
  readonly messageRole: string;
  readonly messageIndex: number;
  readonly contentPartIndex: number;
}

export type OpenAIApiAttachment = OpenAIApiImageAttachment;

export interface OpenAIApiImageAttachmentMetadata {
  readonly type: "image";
  readonly source: "image_url";
  readonly urlKind: OpenAIApiAttachmentUrlKind;
  readonly mediaType?: string;
  readonly detail?: OpenAIApiImageDetail;
  readonly messageRole: string;
  readonly messageIndex: number;
  readonly contentPartIndex: number;
}

export interface OpenAIApiAttachmentMetadata {
  readonly count: number;
  readonly images: readonly OpenAIApiImageAttachmentMetadata[];
}

export interface OpenAIApiChatRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
  readonly abortSignal: AbortSignal;
  readonly metadata: {
    readonly openaiApi: OpenAIApiRequestMetadata;
    readonly [key: string]: unknown;
  };
}

export interface OpenAIApiAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface OpenAIApiAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  readonly apiKey?: string;
  readonly modelId?: string;
  /**
   * Per-field UTF-8 preview upper bound for tool arguments/results rendered
   * into SSE. The adapter may lower it to satisfy the complete frame cap;
   * callers may lower, but never raise, the hard default boundary.
   */
  readonly maxToolPayloadBytes?: number;
  readonly responder: AgentResponder<OpenAIApiChatRequest, AgentMessageStream, AgentResponse>;
  readonly logger?: OpenAIApiAdapterLogger;
}

export interface OpenAIApiAdapterStartResult {
  /** Primary usable origin (loopback for wildcard binds), never an unspecified address. */
  readonly url: string;
  readonly baseUrl: string;
  /** Every concrete loopback/private-LAN/Tailscale base URL discovered for this bind. */
  readonly baseUrls: readonly string[];
  readonly modelsUrl: string;
  readonly chatCompletionsUrl: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

interface NormalizedChatBody {
  readonly model: string;
  readonly text: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
  readonly stream: boolean;
  readonly conversationId: string;
  readonly parameters: Record<string, unknown>;
}

interface ChatCompletionChunkInput {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

const OPENAI_OWNED_BY = "host";
const UNSUPPORTED_CHAT_REQUEST_FIELDS = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "audio",
  "modalities",
] as const;
const OPENAI_CHAT_PARAMETER_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "seed",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
] as const;
type OpenAIChatParameterKey = (typeof OPENAI_CHAT_PARAMETER_KEYS)[number];
type RuntimeWarningEvent = Extract<AgentStreamEvent, { readonly type: "runtime_warning" }>;
const OPENAI_CHAT_PARAMETER_DEFAULTS: Readonly<Record<OpenAIChatParameterKey, unknown>> = {
  temperature: 1,
  top_p: 1,
  max_tokens: null,
  max_completion_tokens: null,
  stop: null,
  seed: null,
  logit_bias: null,
  presence_penalty: 0,
  frequency_penalty: 0,
};
const UNSUPPORTED_SAMPLING_WARNING_KIND = "openai_api_sampling_parameters_ignored";

export async function startOpenAIApiAdapter(
  options: OpenAIApiAdapterOptions,
): Promise<OpenAIApiAdapterStartResult> {
  validateOptions(options);
  const host = normalizeHostForBind(options.host ?? DEFAULT_HOST);
  const port = options.port ?? DEFAULT_PORT;
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const modelId = normalizeOptionalString(options.modelId) ?? DEFAULT_MODEL_ID;
  const apiKey = normalizeOptionalString(options.apiKey);
  const maxToolPayloadBytes = normalizeMaxToolPayloadBytes(options.maxToolPayloadBytes);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new OpenAIApiAdapterError(
      "unsafe_host",
      "OpenAI API adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));
  if (!isLoopbackHost(host) && apiKey === undefined) {
    throw new OpenAIApiAdapterError(
      "missing_required_config",
      "OpenAI API adapter requires an API key for every non-loopback bind.",
      { host },
    );
  }

  const app = express();
  const server = createServer(app);
  const activeRequests = new Set<AbortController>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const modelsPath = `${basePath}/models`;
  const chatCompletionsPath = `${basePath}/chat/completions`;
  const basePostPath = basePath.length === 0 ? "/" : basePath;

  app.use(express.json({ limit: "1mb" }));
  app.get(modelsPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    res.status(200).json({
      object: "list",
      data: [
        {
          id: modelId,
          object: "model",
          created: 0,
          owned_by: OPENAI_OWNED_BY,
        },
      ],
    });
  });
  const chatCompletionHandler = (req: Request, res: Response): void => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    void handleChatCompletion(req, res).catch((error: unknown) => {
      const isClientError = error instanceof OpenAIApiAdapterError && error.code === "invalid_request";
      options.logger?.[isClientError ? "warn" : "error"]?.("OpenAI API chat completion failed before response.", {
        error: errorToMessage(error),
      });
      if (!res.headersSent) {
        sendOpenAIError(
          res,
          isClientError ? 400 : 500,
          errorToMessage(error),
          isClientError ? "invalid_request" : "server_error",
        );
      }
    });
  };
  app.post(chatCompletionsPath, chatCompletionHandler);
  app.post(basePostPath, chatCompletionHandler);
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    sendOpenAIError(res, 400, errorToMessage(error), "invalid_request_error");
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new OpenAIApiAdapterError("start_failed", "OpenAI API adapter failed to listen.", { reason }),
    noAddress: () =>
      new OpenAIApiAdapterError("start_failed", "OpenAI API adapter did not receive a TCP address."),
  });
  const boundPort = address.port;

  async function handleChatCompletion(req: Request, res: Response): Promise<void> {
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const body = normalizeChatBody(req.body, req.headers, requestId, modelId);
    const controller = new AbortController();
    activeRequests.add(controller);
    // Inline base64 data: image_url parts into the shared attachments contract so
    // they reach the agent through the generic responder/harness path (the
    // imageAttachments field alone is not forwarded). Remote/file URL images are
    // not downloaded here; they remain in metadata only.
    const agentAttachments = agentAttachmentsFromImages(body.imageAttachments);
    const request: OpenAIApiChatRequest = {
      conversationId: body.conversationId,
      text: body.text,
      imageAttachments: body.imageAttachments,
      ...(agentAttachments.length === 0 ? {} : { attachments: agentAttachments }),
      abortSignal: controller.signal,
      metadata: {
        openaiApi: {
          requestId,
          model: body.model,
          stream: body.stream,
          method: req.method,
          path: req.path,
          receivedAt,
          ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
          headers: sanitizeInboundHttpHeaders(req.headers),
          parameters: body.parameters,
          ...(body.imageAttachments.length === 0 ? {} : { attachments: summarizeAttachments(body.imageAttachments) }),
        },
      },
    };

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("OpenAI API client disconnected."));
      }
    });

    try {
      if (stopping) {
        controller.abort(new Error("OpenAI API adapter is stopping."));
      }
      if (body.stream) {
        await runStreamingResponder({
          request,
          response: res,
          requestId,
          model: body.model,
          maxToolPayloadBytes,
          controller,
          options,
        });
        return;
      }

      await runJsonResponder({ request, response: res, requestId, model: body.model, options });
    } finally {
      activeRequests.delete(controller);
    }
  }

  async function closeRejectedServer(): Promise<void> {
    stopping = true;
    for (const controller of activeRequests) {
      controller.abort(new Error("OpenAI API adapter rejected its actual bound address."));
    }
    await closeServerBounded(server);
    activeRequests.clear();
  }

  const boundNonLoopback = !isLoopbackHost(address.address);
  if (boundNonLoopback && options.allowNonLoopback !== true) {
    await closeRejectedServer();
    throw new OpenAIApiAdapterError(
      "unsafe_host",
      "OpenAI API adapter resolved a loopback host to a non-loopback bind address.",
      { host, boundAddress: address.address },
    );
  }
  if (boundNonLoopback && apiKey === undefined) {
    await closeRejectedServer();
    throw new OpenAIApiAdapterError(
      "missing_required_config",
      "OpenAI API adapter requires an API key when the actual bound address is non-loopback.",
      { host, boundAddress: address.address },
    );
  }

  const origins = advertisedOrigins(host, address.address, boundPort);
  const url = origins[0] ?? `http://${hostForUrl(host)}:${boundPort}`;
  const baseUrls = origins.map((origin) => `${origin}${basePath}`);

  return {
    url,
    baseUrl: `${url}${basePath}`,
    baseUrls,
    modelsUrl: `${url}${modelsPath}`,
    chatCompletionsUrl: `${url}${chatCompletionsPath}`,
    host,
    port: boundPort,
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        for (const controller of activeRequests) {
          controller.abort(new Error("OpenAI API adapter stopped."));
        }
        await closeServerBounded(server);
        activeRequests.clear();
      })();
      return stopPromise;
    },
  };
}

function advertisedOrigins(host: string, boundAddress: string, port: number): readonly string[] {
  const wildcardHost = isWildcardHost(host)
    ? host
    : isWildcardHost(boundAddress)
      ? boundAddress
      : undefined;
  const hosts = wildcardHost !== undefined
    ? [loopbackForWildcardHost(wildcardHost), ...discoverPrivateIpv4Addresses()]
    : [host];
  return [...new Set(hosts)].map((entry) => `http://${hostForUrl(entry)}:${port}`);
}

function loopbackForWildcardHost(host: string): "127.0.0.1" | "::1" {
  const normalized = normalizeHostForBind(host).toLowerCase();
  if (normalized === "0.0.0.0") {
    return "127.0.0.1";
  }
  try {
    const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    if (canonical === "::ffff:0:0") {
      return "127.0.0.1";
    }
  } catch {
    // isWildcardHost already validated the caller; fall through defensively.
  }
  return "::1";
}

function discoverPrivateIpv4Addresses(): readonly string[] {
  const addresses: string[] = [];
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && entry.family === "IPv4" && isLanOrTailscaleIpv4(entry.address)) {
          addresses.push(entry.address);
        }
      }
    }
  } catch {
    return [];
  }
  return addresses.sort((left, right) => left.localeCompare(right));
}

function isLanOrTailscaleIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

async function runJsonResponder(input: {
  readonly request: OpenAIApiChatRequest;
  readonly response: Response;
  readonly requestId: string;
  readonly model: string;
  readonly options: OpenAIApiAdapterOptions;
}): Promise<void> {
  const stream = new BufferedMessageStream({
    onClosed: () =>
      new OpenAIApiAdapterError("invalid_config", "Cannot write to a finished OpenAI API stream."),
  });
  try {
    const samplingWarning = await emitUnsupportedSamplingWarning(input.request, stream, input.options.logger);
    const response = await input.options.responder.respond(input.request, stream);
    await stream.finish(response.text);
    input.response.status(200).json(chatCompletion({
      id: `chatcmpl-${input.requestId}`,
      model: input.model,
      content: stream.text,
      ...(samplingWarning === undefined ? {} : { events: [samplingWarning] }),
    }));
  } catch (error) {
    const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
    input.options.logger?.[cancelled ? "warn" : "error"]?.("OpenAI API responder failed.", {
      requestId: input.requestId,
      conversationId: input.request.conversationId,
      error: errorToMessage(error),
    });
    sendOpenAIError(
      input.response,
      cancelled ? 499 : 500,
      errorToMessage(error),
      cancelled ? "request_cancelled" : "server_error",
    );
  }
}

async function runStreamingResponder(input: {
  readonly request: OpenAIApiChatRequest;
  readonly response: Response;
  readonly requestId: string;
  readonly model: string;
  readonly maxToolPayloadBytes: number;
  readonly controller: AbortController;
  readonly options: OpenAIApiAdapterOptions;
}): Promise<void> {
  input.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Disable Nagle's algorithm on the underlying socket. SSE writes are many tiny
  // chunks (often a single token); with Nagle on, the kernel coalesces them into
  // larger TCP segments, so the client receives the reply in bursts that look
  // "all at once" instead of streaming token-by-token. setNoDelay flushes each
  // chunk immediately.
  input.response.socket?.setNoDelay(true);
  // Flush the response headers before awaiting the (potentially slow) responder
  // so the client sees the stream open promptly. We deliberately do NOT write a
  // leading SSE comment (": open") here: some OpenAI-compatible clients
  // (e.g. Open WebUI) mishandle a comment that precedes the first data chunk,
  // and real OpenAI streams never send one. The first `data:` chunk (the
  // assistant-role delta) is the stream's opening signal.
  input.response.flushHeaders();

  const chunkInput = {
    id: `chatcmpl-${input.requestId}`,
    created: Math.floor(Date.now() / 1000),
    model: input.model,
  };
  const stream = new SseChatMessageStream(
    input.response,
    chunkInput,
    input.maxToolPayloadBytes,
    (error) => input.controller.abort(error),
  );

  try {
    await stream.start();
    await emitUnsupportedSamplingWarning(input.request, stream, input.options.logger);
    const response = await input.options.responder.respond(input.request, stream);
    await stream.finish(response.text);
  } catch (error) {
    const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
    input.options.logger?.[cancelled ? "warn" : "error"]?.("OpenAI API streaming responder failed.", {
      requestId: input.requestId,
      conversationId: input.request.conversationId,
      error: errorToMessage(error),
    });
    await stream.error(errorToMessage(error), cancelled ? "request_cancelled" : "server_error").catch(() => undefined);
  }
}

class SseChatMessageStream implements AgentMessageStream {
  private currentText = "";
  private done = false;
  private started = false;
  private readonly writer: BoundedHttpResponseWriter;
  private readonly activeTools = new Map<string, {
    readonly name: string;
    readonly arguments?: unknown;
  }>();

  constructor(
    private readonly response: Response,
    private readonly chunkInput: ChatCompletionChunkInput,
    private readonly maxToolPayloadBytes: number,
    onWriteFailure: (error: Error) => void,
  ) {
    this.writer = new BoundedHttpResponseWriter(response, { onFailure: onWriteFailure });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.writeChunk({ role: "assistant" }, null);
  }

  async status(_text: string): Promise<void> {}

  async event(event: AgentStreamEvent): Promise<void> {
    this.assertOpen();
    if (event.type === "assistant_thought") {
      if (event.text.length > 0) {
        await this.writeChunk({ reasoning_content: event.text }, null);
      }
      return;
    }
    if (event.type === "tool_call_started") {
      this.activeTools.set(event.id, {
        name: event.name,
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
      });
      return;
    }
    if (event.type === "tool_call_completed") {
      const started = this.activeTools.get(event.id);
      const name = event.name ?? started?.name ?? "tool";
      const args = event.arguments ?? started?.arguments ?? {};
      this.activeTools.delete(event.id);
      await this.writeToolDetailsChunk({
        id: event.id,
        name,
        arguments: args,
        result: event.content,
        isError: event.isError === true,
      });
      return;
    }
    if (event.type === "runtime_warning") {
      await this.writeChunk({ reasoning_content: `Warning: ${event.message}` }, null);
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    if (delta.length === 0) {
      return;
    }
    this.currentText += delta;
    await this.writeChunk({ content: delta }, null);
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    const delta = text.startsWith(this.currentText) ? text.slice(this.currentText.length) : text;
    this.currentText = text;
    if (delta.length > 0) {
      await this.writeChunk({ content: delta }, null);
    }
  }

  async finish(finalText?: string): Promise<void> {
    if (this.done) {
      return;
    }
    if (finalText !== undefined) {
      await this.finishFinalText(finalText);
    }
    this.done = true;
    await this.writeChunk({}, "stop");
    await this.writer.write("data: [DONE]\n\n");
    this.response.end();
  }

  private async finishFinalText(finalText: string): Promise<void> {
    if (finalText.length === 0 || finalText === this.currentText) {
      return;
    }
    if (this.currentText.length === 0) {
      await this.append(finalText);
      return;
    }
    if (finalText.startsWith(this.currentText)) {
      await this.append(finalText.slice(this.currentText.length));
    }
  }

  async error(message: string, code: "request_cancelled" | "server_error"): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    try {
      await this.writer.write(`data: ${JSON.stringify({ error: openAIError(message, code) })}\n\n`);
      await this.writer.write("data: [DONE]\n\n");
    } finally {
      this.response.end();
    }
  }

  private async writeChunk(
    delta: Record<string, unknown>,
    finishReason: "stop" | null,
  ): Promise<void> {
    await this.writer.write(this.serializeChunk(delta, finishReason));
  }

  private async writeToolDetailsChunk(input: OpenWebUIToolDetailsInput): Promise<void> {
    const frame = boundedOpenWebUIToolDetailsFrame(
      input,
      this.maxToolPayloadBytes,
      (content) => this.serializeChunk({ content }, null),
    );
    await this.writer.write(frame);
  }

  private serializeChunk(
    delta: Record<string, unknown>,
    finishReason: "stop" | null,
  ): string {
    return `data: ${JSON.stringify({
      id: this.chunkInput.id,
      object: "chat.completion.chunk",
      created: this.chunkInput.created,
      model: this.chunkInput.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    })}\n\n`;
  }

  private assertOpen(): void {
    if (this.done) {
      throw new OpenAIApiAdapterError("invalid_config", "Cannot write to a finished OpenAI API stream.");
    }
  }
}

function normalizeChatBody(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  requestId: string,
  expectedModel: string,
): NormalizedChatBody {
  if (!isRecord(body)) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion body must be a JSON object.");
  }
  const model = normalizeOptionalString(body.model);
  if (model === undefined) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion body requires a non-empty model.");
  }
  if (model !== expectedModel) {
    throw new OpenAIApiAdapterError("invalid_request", `Chat completion model must be ${expectedModel}.`);
  }
  assertNoUnsupportedChatRequestFields(body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion body requires at least one message.");
  }
  const messages = body.messages.map(parseChatMessage);
  const conversationId = readConversationId(body, headers);
  // A stable conversation id means the harness already carries the
  // transcript (history store + provider sessions), so only the trailing
  // user turn is sent; resending the full transcript would double the
  // context. body.user is excluded below: it identifies a user, not a
  // chat, so user-keyed transcripts keep full-flatten semantics.
  const input = (conversationId === undefined ? undefined : latestUserTurn(messages))
    ?? flattenTranscript(messages);
  if (input.text.length === 0 && input.imageAttachments.length === 0) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages must include text or image content.");
  }
  return {
    model,
    text: input.text,
    imageAttachments: input.imageAttachments,
    stream: body.stream === true,
    conversationId: conversationId ?? normalizeOptionalString(body.user) ?? `openai-api:${requestId}`,
    parameters: readParameters(body),
  };
}

interface ParsedChatMessage {
  readonly role: string;
  readonly content: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
}

interface NormalizedChatInput {
  readonly text: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
}

function parseChatMessage(value: unknown, messageIndex: number): ParsedChatMessage {
  if (!isRecord(value)) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages must be JSON objects.");
  }
  const role = normalizeOptionalString(value.role);
  if (role === undefined) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages require a role.");
  }
  if (hasOwn(value, "tool_calls") || hasOwn(value, "function_call")) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion message tool/function calls are not supported.");
  }
  const content = normalizeContent(value.content, { messageIndex, messageRole: role });
  return { role, content: content.text, imageAttachments: content.imageAttachments };
}

function flattenTranscript(messages: readonly ParsedChatMessage[]): NormalizedChatInput {
  const text = messages
    .filter((message) => message.content.length > 0)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return {
    text,
    imageAttachments: messages.flatMap((message) => message.imageAttachments),
  };
}

function latestUserTurn(messages: readonly ParsedChatMessage[]): NormalizedChatInput | undefined {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant === -1) {
    // First turn: no assistant reply yet, so the transcript (including any
    // client system prompt) has never been delivered — send it whole once.
    return undefined;
  }
  const trailing = messages
    .slice(lastAssistant + 1)
    .filter((message) => message.role === "user" && (message.content.length > 0 || message.imageAttachments.length > 0));
  if (trailing.length === 0) {
    return undefined;
  }
  return {
    text: trailing
      .map((message) => message.content)
      .filter((content) => content.length > 0)
      .join("\n"),
    imageAttachments: trailing.flatMap((message) => message.imageAttachments),
  };
}

function normalizeContent(
  value: unknown,
  context: { readonly messageIndex: number; readonly messageRole: string },
): { readonly text: string; readonly imageAttachments: readonly OpenAIApiAttachment[] } {
  if (typeof value === "string") {
    return { text: value, imageAttachments: [] };
  }
  if (value === null || value === undefined) {
    return { text: "", imageAttachments: [] };
  }
  if (Array.isArray(value)) {
    const textParts: string[] = [];
    const imageAttachments: OpenAIApiAttachment[] = [];
    value.forEach((part, contentPartIndex) => {
      if (!isRecord(part)) {
        throw new OpenAIApiAdapterError("invalid_request", "Chat completion message content parts must be JSON objects.");
      }
      const type = normalizeOptionalString(part.type);
      if (type === "text") {
        if (typeof part.text !== "string") {
          throw new OpenAIApiAdapterError("invalid_request", "Chat completion text content parts require string text.");
        }
        if (part.text.length > 0) {
          textParts.push(part.text);
        }
        return;
      }
      if (type === "image_url") {
        imageAttachments.push(normalizeImageAttachment(part, { ...context, contentPartIndex }));
        return;
      }
      throw new OpenAIApiAdapterError("invalid_request", `Chat completion message content part type ${String(part.type)} is not supported.`);
    });
    return {
      text: textParts.join("\n"),
      imageAttachments,
    };
  }
  throw new OpenAIApiAdapterError("invalid_request", "Chat completion message content must be a string or text/image content parts.");
}

function normalizeImageAttachment(
  part: Record<string, unknown>,
  context: {
    readonly messageIndex: number;
    readonly messageRole: string;
    readonly contentPartIndex: number;
  },
): OpenAIApiImageAttachment {
  if (!isRecord(part.image_url)) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion image_url content parts require an image_url object.");
  }
  const url = normalizeOptionalString(part.image_url.url);
  if (url === undefined) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion image_url content parts require a non-empty image_url.url.");
  }
  const detail = normalizeImageDetail(part.image_url.detail);
  const mediaType = mediaTypeFromDataUrl(url);
  return {
    type: "image",
    source: "image_url",
    url,
    urlKind: classifyAttachmentUrl(url),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(detail === undefined ? {} : { detail }),
    messageRole: context.messageRole,
    messageIndex: context.messageIndex,
    contentPartIndex: context.contentPartIndex,
  };
}

function normalizeImageDetail(value: unknown): OpenAIApiImageDetail | undefined {
  if (value === undefined) {
    return undefined;
  }
  const detail = normalizeOptionalString(value);
  if (detail === "auto" || detail === "low" || detail === "high") {
    return detail;
  }
  throw new OpenAIApiAdapterError("invalid_request", "Chat completion image_url.detail must be auto, low, or high.");
}

function classifyAttachmentUrl(url: string): OpenAIApiAttachmentUrlKind {
  if (url.startsWith("data:")) {
    return "data";
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return "remote";
  }
  if (url.startsWith("file-")) {
    return "file";
  }
  return "other";
}

function mediaTypeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/iu.exec(url);
  return match?.[1]?.toLowerCase();
}

/**
 * Convert base64 `data:` image_url parts into the shared {@link AgentAttachment}
 * contract so they flow to the agent through the generic responder. Non-base64
 * and remote/file URL images are skipped (no download is performed here).
 */
function agentAttachmentsFromImages(images: readonly OpenAIApiAttachment[]): AgentAttachment[] {
  const attachments: AgentAttachment[] = [];
  for (const image of images) {
    if (image.urlKind !== "data") {
      continue;
    }
    const parsed = parseBase64DataUrl(image.url);
    if (parsed === undefined) {
      continue;
    }
    attachments.push({ kind: "image", mimeType: parsed.mediaType, data: parsed.base64 });
  }
  return attachments;
}

function parseBase64DataUrl(url: string): { mediaType: string; base64: string } | undefined {
  // data:[<mediaType>][;<param>=<value>]*[;base64],<data>. Split on the FIRST
  // comma so parameterized media types (e.g. image/png;charset=utf-8;base64) are
  // handled the same way mediaTypeFromDataUrl reads them. Only base64-encoded
  // payloads become attachments (raw/url-encoded data is not inlined).
  const match = /^data:([^,]*),([\s\S]*)$/iu.exec(url);
  if (match === null) {
    return undefined;
  }
  const meta = match[1] ?? "";
  if (!/;base64$/iu.test(meta)) {
    return undefined;
  }
  const base64 = (match[2] ?? "").trim();
  if (base64.length === 0) {
    return undefined;
  }
  const mediaType = (meta.split(";")[0] || "application/octet-stream").toLowerCase();
  return { mediaType, base64 };
}

function summarizeAttachments(attachments: readonly OpenAIApiAttachment[]): OpenAIApiAttachmentMetadata {
  const images = attachments.map((attachment) => ({
    type: attachment.type,
    source: attachment.source,
    urlKind: attachment.urlKind,
    ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
    ...(attachment.detail === undefined ? {} : { detail: attachment.detail }),
    messageRole: attachment.messageRole,
    messageIndex: attachment.messageIndex,
    contentPartIndex: attachment.contentPartIndex,
  }));
  return {
    count: attachments.length,
    images,
  };
}

function assertNoUnsupportedChatRequestFields(body: Record<string, unknown>): void {
  for (const field of UNSUPPORTED_CHAT_REQUEST_FIELDS) {
    if (hasOwn(body, field)) {
      throw new OpenAIApiAdapterError("invalid_request", `Chat completion request field ${field} is not supported.`);
    }
  }
}

// Open WebUI strips metadata from bodies it sends to OpenAI-compatible
// backends, but forwards the chat id as a header when
// ENABLE_FORWARD_USER_INFO_HEADERS is enabled. x-conversation-id is the
// generic equivalent for other proxies. Node lowercases incoming names.
const CONVERSATION_ID_HEADERS = ["x-openwebui-chat-id", "x-conversation-id"] as const;

function readConversationId(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const candidates = [
    metadata.conversation_id,
    metadata.conversationId,
    metadata.chat_id,
    metadata.chatId,
    body.conversation_id,
    body.conversationId,
    ...CONVERSATION_ID_HEADERS.map((name) => firstHeaderValue(headers[name])),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readParameters(body: Record<string, unknown>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const key of OPENAI_CHAT_PARAMETER_KEYS) {
    if (body[key] !== undefined) {
      parameters[key] = body[key];
    }
  }
  return parameters;
}

async function emitUnsupportedSamplingWarning(
  request: OpenAIApiChatRequest,
  stream: AgentMessageStream,
  logger: OpenAIApiAdapterLogger | undefined,
): Promise<RuntimeWarningEvent | undefined> {
  const ignoredParameters = OPENAI_CHAT_PARAMETER_KEYS.filter((key) =>
    hasOwn(request.metadata.openaiApi.parameters, key)
    && request.metadata.openaiApi.parameters[key] !== OPENAI_CHAT_PARAMETER_DEFAULTS[key]);
  if (ignoredParameters.length === 0) {
    return;
  }

  const event: AgentStreamEvent = {
    type: "runtime_warning",
    warningKind: UNSUPPORTED_SAMPLING_WARNING_KIND,
    message: `OpenAI API sampling parameters are currently unsupported and were not applied: ${ignoredParameters.join(", ")}.`,
    metadata: {
      openaiApi: {
        ignoredParameters,
      },
    },
  };
  logger?.warn?.("OpenAI API sampling parameters were ignored.", {
    requestId: request.metadata.openaiApi.requestId,
    conversationId: request.conversationId,
    warningKind: event.warningKind,
    ignoredParameters,
  });
  await stream.event?.(event);
  return event;
}

function chatCompletion(input: {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly events?: readonly RuntimeWarningEvent[];
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.content,
        },
        finish_reason: "stop",
      },
    ],
    ...(input.events === undefined || input.events.length === 0
      ? {}
      : {
          mono_agent: {
            events: input.events,
          },
        }),
  };
}

function authorize(req: Request, res: Response, apiKey: string | undefined): boolean {
  if (apiKey === undefined) {
    return true;
  }
  const presented = readAuthorizationBearer(req.header("authorization"));
  if (presented !== undefined && bearerTokensEqual(presented, apiKey)) {
    return true;
  }
  sendOpenAIError(res, 401, "Invalid API key.", "invalid_api_key");
  return false;
}

function sendOpenAIError(
  res: Response,
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error",
): void {
  res.status(status).json({ error: openAIError(message, code, type) });
}

function openAIError(
  message: string,
  code: string,
  type = "invalid_request_error",
): Record<string, unknown> {
  return {
    message,
    type,
    param: null,
    code,
  };
}

interface OpenWebUIToolDetailsInput {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly isError: boolean;
}

interface RenderedToolPayload {
  readonly text: string;
  readonly originalBytes: number;
}

interface ProjectedToolPayload {
  readonly text: string;
  readonly retainedBytes: number;
}

interface ToolDetailsFrameCandidate {
  readonly appliedMaxBytes: number;
  readonly frame: string;
  readonly frameBytes: number;
  readonly retainedPayloadBytes: number;
}

interface ToolPayloadSearchInterval {
  readonly start: number;
  readonly end: number;
}

type ToolDetailsFrameSerializer = (content: string) => string;

function boundedOpenWebUIToolDetailsFrame(
  input: OpenWebUIToolDetailsInput,
  configuredMaxPayloadBytes: number,
  serializeFrame: ToolDetailsFrameSerializer,
): string {
  const argumentsPayload = renderToolPayload(input.arguments);
  const resultPayload = renderToolPayload(input.result ?? null);
  const candidateAt = (appliedMaxBytes: number): ToolDetailsFrameCandidate => {
    const argumentsProjection = projectToolPayload(argumentsPayload, appliedMaxBytes);
    const resultProjection = projectToolPayload(resultPayload, appliedMaxBytes);
    const frame = serializeFrame(openWebUIToolDetails(
      input,
      argumentsProjection.text,
      resultProjection.text,
    ));
    return {
      appliedMaxBytes,
      frame,
      frameBytes: utf8ByteLength(frame),
      retainedPayloadBytes: argumentsProjection.retainedBytes + resultProjection.retainedBytes,
    };
  };

  const configuredCandidate = candidateAt(configuredMaxPayloadBytes);
  if (configuredCandidate.frameBytes <= MAX_TOOL_SSE_FRAME_BYTES) {
    return configuredCandidate.frame;
  }

  // Search every interval on which serialized frame size is monotone. A raw
  // payload replaces its truncation wrapper at originalBytes, which is the only
  // possible downward discontinuity. Within a projected representation, each
  // added scalar contributes at least one serialized byte while omittedBytes
  // can lose at most one decimal digit; all other metadata lengths stay equal
  // or grow. Splitting at each raw transition therefore makes binary search
  // valid, while the global comparison maximizes retained useful payload.
  let bestCandidate: ToolDetailsFrameCandidate | undefined;
  for (const interval of toolPayloadSearchIntervals(
    [argumentsPayload, resultPayload],
    configuredMaxPayloadBytes,
  )) {
    const intervalCandidate = highestFittingToolPayloadCandidate(interval, candidateAt);
    if (
      intervalCandidate !== undefined
      && (
        bestCandidate === undefined
        || isBetterToolPayloadCandidate(intervalCandidate, bestCandidate)
      )
    ) {
      bestCandidate = intervalCandidate;
    }
  }
  if (bestCandidate === undefined) {
    throw new Error(
      `OpenAI API tool details frame cannot fit within ${String(MAX_TOOL_SSE_FRAME_BYTES)} bytes.`,
    );
  }
  return bestCandidate.frame;
}

function toolPayloadSearchIntervals(
  payloads: readonly RenderedToolPayload[],
  configuredMaxPayloadBytes: number,
): readonly ToolPayloadSearchInterval[] {
  const starts = new Set<number>([0]);
  const addStart = (value: number): void => {
    if (Number.isSafeInteger(value) && value >= 0 && value <= configuredMaxPayloadBytes) {
      starts.add(value);
    }
  };

  for (const payload of payloads) {
    // At this exact budget projectToolPayload changes from a metadata wrapper
    // to the raw payload, which can sharply reduce the serialized frame.
    addStart(payload.originalBytes);
  }

  const orderedStarts = [...starts].sort((left, right) => left - right);
  return orderedStarts.map((start, index) => ({
    start,
    end: (orderedStarts[index + 1] ?? configuredMaxPayloadBytes + 1) - 1,
  }));
}

function highestFittingToolPayloadCandidate(
  interval: ToolPayloadSearchInterval,
  candidateAt: (appliedMaxBytes: number) => ToolDetailsFrameCandidate,
): ToolDetailsFrameCandidate | undefined {
  const endCandidate = candidateAt(interval.end);
  if (endCandidate.frameBytes <= MAX_TOOL_SSE_FRAME_BYTES) {
    return endCandidate;
  }

  const startCandidate = candidateAt(interval.start);
  if (startCandidate.frameBytes > MAX_TOOL_SSE_FRAME_BYTES) {
    return undefined;
  }

  let bestCandidate = startCandidate;
  let lowerBound = interval.start + 1;
  let upperBound = interval.end - 1;
  while (lowerBound <= upperBound) {
    const appliedMaxBytes = lowerBound + Math.floor((upperBound - lowerBound) / 2);
    const candidate = candidateAt(appliedMaxBytes);
    if (candidate.frameBytes <= MAX_TOOL_SSE_FRAME_BYTES) {
      bestCandidate = candidate;
      lowerBound = appliedMaxBytes + 1;
    } else {
      upperBound = appliedMaxBytes - 1;
    }
  }
  return bestCandidate;
}

function isBetterToolPayloadCandidate(
  candidate: ToolDetailsFrameCandidate,
  current: ToolDetailsFrameCandidate,
): boolean {
  if (candidate.retainedPayloadBytes !== current.retainedPayloadBytes) {
    return candidate.retainedPayloadBytes > current.retainedPayloadBytes;
  }
  if (candidate.frameBytes !== current.frameBytes) {
    return candidate.frameBytes < current.frameBytes;
  }
  return candidate.appliedMaxBytes < current.appliedMaxBytes;
}

function openWebUIToolDetails(
  input: OpenWebUIToolDetailsInput,
  argumentsJson: string,
  resultJson: string,
): string {
  const summary = input.isError ? "Tool Error" : "Tool Executed";
  return [
    `<details type="tool_calls" done="true" id="${escapeHtmlAttribute(input.id)}" name="${escapeHtmlAttribute(input.name)}" arguments="${escapeHtmlAttribute(argumentsJson)}">`,
    `<summary>${summary}</summary>`,
    escapeHtmlText(resultJson),
    "</details>",
    "",
  ].join("\n");
}

interface ToolPayloadTruncation {
  readonly truncated: true;
  readonly maxBytes: number;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
}

const TOOL_PAYLOAD_ENCODER = new TextEncoder();
const TOOL_PAYLOAD_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/**
 * Produce a valid-JSON replacement when a rendered tool field exceeds its
 * applied UTF-8 preview budget. Projection operates on the already-rendered
 * text and never replaces fields on the source event object.
 */
function projectToolPayload(payload: RenderedToolPayload, maxBytes: number): ProjectedToolPayload {
  if (payload.originalBytes <= maxBytes) {
    return {
      text: payload.text,
      retainedBytes: payload.originalBytes,
    };
  }
  const preview = utf8Prefix(payload.text, maxBytes);
  const retainedBytes = utf8ByteLength(preview);
  const truncation: ToolPayloadTruncation = {
    truncated: true,
    maxBytes,
    originalBytes: payload.originalBytes,
    retainedBytes,
    omittedBytes: payload.originalBytes - retainedBytes,
  };
  return {
    text: JSON.stringify({
      __monoAgentTruncation: truncation,
      preview,
    }),
    retainedBytes,
  };
}

function renderToolPayload(value: unknown): RenderedToolPayload {
  const text = stableJson(value);
  return {
    text,
    originalBytes: utf8ByteLength(text),
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  // At most maxBytes + 1 UTF-16 code units are needed to cover maxBytes of
  // UTF-8 while still including the low surrogate when the boundary follows a
  // high surrogate. Repeated frame-fit probes therefore stay bounded even when
  // the source value is much larger than the wire limit.
  const sourcePrefix = value.slice(0, Math.min(value.length, maxBytes + 1));
  const encoded = TOOL_PAYLOAD_ENCODER.encode(sourcePrefix);
  let end = Math.min(encoded.length, maxBytes);
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return TOOL_PAYLOAD_DECODER.decode(encoded.subarray(0, end));
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stableJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeMaxToolPayloadBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_TOOL_PAYLOAD_BYTES;
  }
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > DEFAULT_MAX_TOOL_PAYLOAD_BYTES
  ) {
    throw new OpenAIApiAdapterError(
      "invalid_config",
      `OpenAI API maxToolPayloadBytes must be an integer from 0 to ${String(DEFAULT_MAX_TOOL_PAYLOAD_BYTES)}.`,
    );
  }
  return value;
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, "&quot;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function validateOptions(options: OpenAIApiAdapterOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new OpenAIApiAdapterError("missing_required_config", "OpenAI API adapter requires a responder.");
  }
  if (!Number.isInteger(options.port ?? DEFAULT_PORT) || (options.port ?? DEFAULT_PORT) < 0 || (options.port ?? DEFAULT_PORT) > 65535) {
    throw new OpenAIApiAdapterError("invalid_config", "OpenAI API adapter port must be an integer from 0 to 65535.");
  }
  normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const modelId = normalizeOptionalString(options.modelId) ?? DEFAULT_MODEL_ID;
  if (modelId.length === 0) {
    throw new OpenAIApiAdapterError("invalid_config", "OpenAI API adapter modelId must be non-empty.");
  }
}

function normalizeBasePath(path: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) {
    throw new OpenAIApiAdapterError("invalid_config", "OpenAI API basePath must be an absolute path without query or hash.");
  }
  return normalized.length === 1 ? "" : normalized.replace(/\/+$/u, "");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

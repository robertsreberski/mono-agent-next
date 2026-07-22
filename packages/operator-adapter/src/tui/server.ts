import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  BoundedHttpResponseWriter,
  agentAttachmentKindFromMimeType,
  closeServerBounded,
  createChannelUserCancelReason,
  decodeAgentAttachmentText,
  isAgentResponseCancelledError,
  serializeAgentStreamFrame,
  type AgentAttachment,
  type AgentMessageStream,
  type AgentLiveInputOffer,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
  type ChannelAskAnswer,
  type ChannelInteractionHub,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  hostForUrl,
  isLoopbackHost,
  listen,
  normalizeOptionalString,
  readAuthorizationBearer,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import { DEFAULT_BASE_PATH, DEFAULT_HOST, DEFAULT_PORT, MAX_FRAME_BYTES, TUI_WIRE_SCHEMA } from "./constants.js";
import { TuiAdapterError } from "./errors.js";

export interface TuiAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/** Static facts surfaced by GET /v1/info so the TUI can label the session. */
export interface TuiAdapterInfo {
  readonly label?: string;
  readonly model?: string;
  /**
   * The statically configured reasoning-effort level. Per-run overrides
   * (e.g. a per-trigger effort override on a given turn) do NOT flow through
   * here — those arrive via the `run_config` runtime_telemetry event instead.
   */
  readonly effort?: string;
  /**
   * The candidate models a TUI session may switch to — the host's primary model
   * first, then each configured fallback, as canonical reference strings. Absent
   * on older agents; the TUI tolerates that and offers no model picker.
   */
  readonly models?: readonly string[];
  /**
   * Per-model reasoning/effort metadata, keyed by the same canonical ref
   * strings that appear in `models`. Local-provider models resolve a precise
   * `reasoningMode` (`"effort"` with graded `effortLevels`, `"toggle"` for
   * binary thinking, or `"none"`); cloud models degrade to `{ reasoning: true }`
   * with no mode/levels so the TUI falls back to the global effort enum. Absent
   * on older agents; the TUI tolerates that and offers no model-aware picker.
   */
  readonly modelOptions?: Record<string, {
    readonly effortLevels?: readonly string[];
    readonly reasoning?: boolean;
    readonly reasoningMode?: string;
    readonly label?: string;
    /** Known model context capacity, in tokens. Omitted when unknown. */
    readonly contextWindow?: number;
  }>;
}

export interface TuiAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  readonly apiKey?: string;
  readonly responder: AgentResponder;
  readonly logger?: TuiAdapterLogger;
  /**
   * Static info, OR a provider invoked fresh on every GET /v1/info. Discovery
   * of local-provider models can change after the adapter starts (an endpoint
   * started later, or restarted); a provider lets `/v1/info` reflect that
   * without a restart. The channel composition layer is responsible for
   * caching/rate-limiting any expensive work the provider does — this adapter
   * just calls it (and awaits it) on every request.
   */
  readonly info?: TuiAdapterInfo | (() => TuiAdapterInfo | Promise<TuiAdapterInfo>);
  /**
   * Invoked when the already-listening HTTP server dies (e.g. EADDRINUSE
   * appearing later, socket-level failure). The hosting channel driver maps
   * this to its onFailure hook so the channel flips to "failed" instead of
   * silently serving nothing.
   */
  readonly onServerError?: (reason: string) => void;
  /** In-process bridge state used by the web console's structured AskUser form. */
  readonly interaction?: ChannelInteractionHub;
}

export interface TuiAdapterStartResult {
  readonly url: string;
  readonly baseUrl: string;
  readonly infoUrl: string;
  readonly turnsUrl: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

const MAX_TURN_BODY_BYTES = 96 * 1024 * 1024;
const MAX_VERBATIM_BODY_BYTES = 2 * 1024 * 1024;
const MAX_VERBATIM_TEXT_CHARACTERS = 200_000;
const MAX_VERBATIM_TEXT_BYTES = 1024 * 1024;
const MAX_LIVE_INPUT_BODY_BYTES = 32 * 1024;
const MAX_WEB_ATTACHMENTS = 10;
const MAX_WEB_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set(
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST.map((mimeType) => mimeType.toLowerCase()),
);

export async function startTuiAdapter(options: TuiAdapterOptions): Promise<TuiAdapterStartResult> {
  if (typeof options.responder?.respond !== "function") {
    throw new TuiAdapterError("invalid_config", "startTuiAdapter requires a responder with respond().");
  }
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const apiKey = normalizeOptionalString(options.apiKey);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new TuiAdapterError(
      "unsafe_host",
      "TUI adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));

  const app = express();
  const server = createServer(app);
  const activeTurns = new Set<AbortController>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const infoPath = `${basePath}/v1/info`;
  const turnsPath = `${basePath}/v1/turns`;
  const cancelPath = `${basePath}/v1/conversations/:conversationId/cancel`;
  const verbatimPath = `${basePath}/v1/conversations/:conversationId/verbatim`;
  const liveInputPath = `${basePath}/v1/conversations/:conversationId/live-input`;
  const askPath = `${basePath}/v1/conversations/:conversationId/ask`;

  app.get(infoPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    void resolveInfo(options.info)
      .then((info) => {
        res.status(200).json({
          schema: TUI_WIRE_SCHEMA,
          pid: process.pid,
          capabilities: {
            attachments: true,
            ...(typeof options.responder.offerLiveInput === "function" ? { liveInput: true } : {}),
            ...(typeof options.responder.deliverVerbatim === "function" ? { historyAppend: true } : {}),
            ...(options.interaction === undefined ? {} : { askUser: true }),
          },
          ...(info?.label === undefined ? {} : { label: info.label }),
          ...(info?.model === undefined ? {} : { model: info.model }),
          ...(info?.effort === undefined ? {} : { effort: info.effort }),
          ...(info?.models === undefined || info.models.length === 0 ? {} : { models: info.models }),
          ...(info?.modelOptions === undefined || Object.keys(info.modelOptions).length === 0
            ? {}
            : { modelOptions: info.modelOptions }),
        });
      })
      .catch((error: unknown) => {
        options.logger?.error?.("TUI info provider failed.", { error: errorToMessage(error) });
        sendJsonError(res, 500, error);
      });
  });

  // Keep the enlarged parser scoped to turn submission. 64 MiB of decoded
  // files expands to about 85.4 MiB in base64, while info/cancel stay bodyless.
  app.post(turnsPath, express.json({ limit: MAX_TURN_BODY_BYTES }), (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    void handleTurn(req, res).catch((error: unknown) => {
      options.logger?.error?.("TUI turn failed before response.", { error: errorToMessage(error) });
      if (!res.headersSent) {
        sendJsonError(res, error instanceof TuiAdapterError && error.code === "invalid_request" ? 400 : 500, error);
      }
    });
  });

  app.post(cancelPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    const rawConversationId = req.params.conversationId;
    const conversationId = normalizeOptionalString(
      typeof rawConversationId === "string" ? rawConversationId : undefined,
    );
    if (conversationId === undefined) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "conversationId is required."));
      return;
    }
    if (typeof options.responder.cancel !== "function") {
      sendJsonError(res, 501, new TuiAdapterError("invalid_request", "This responder does not support cancel."));
      return;
    }
    options.responder.cancel(conversationId, createChannelUserCancelReason("TUI"));
    options.interaction?.cancelAsks(conversationId);
    res.status(202).json({ cancelled: conversationId });
  });

  app.post(verbatimPath, express.json({ limit: MAX_VERBATIM_BODY_BYTES, strict: true }), (req, res, next) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    let body: NormalizedVerbatimBody;
    try {
      body = normalizeVerbatimBody(req.params.conversationId, req.body);
    } catch (error) {
      next(error);
      return;
    }
    if (typeof options.responder.deliverVerbatim !== "function") {
      sendJsonError(
        res,
        501,
        new TuiAdapterError("invalid_request", "This responder does not support history append."),
      );
      return;
    }
    void options.responder.deliverVerbatim(body.conversationId, body.text, {
      idempotencyKey: body.idempotencyKey,
    }).then(() => {
      res.status(200).json({ recorded: true, conversationId: body.conversationId });
    }).catch(next);
  });

  app.post(liveInputPath, express.json({ limit: MAX_LIVE_INPUT_BODY_BYTES, strict: true }), (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    const body = typeof req.body === "object" && req.body !== null
      ? req.body as Record<string, unknown>
      : {};
    if (
      conversationId === undefined
      || typeof body.id !== "string"
      || body.id.trim().length === 0
      || typeof body.text !== "string"
      || body.text.trim().length === 0
      || body.text.length > AGENT_LIVE_INPUT_MAX_CHARACTERS
      || typeof body.receivedAt !== "string"
      || Number.isNaN(Date.parse(body.receivedAt))
    ) {
      next(new TuiAdapterError(
        "invalid_request",
        `Live input requires id, receivedAt, and 1-${String(AGENT_LIVE_INPUT_MAX_CHARACTERS)} text characters.`,
      ));
      return;
    }
    if (typeof options.responder.offerLiveInput !== "function") {
      res.status(200).json({ status: "unavailable", reason: "unsupported" });
      return;
    }
    let offer: AgentLiveInputOffer;
    try {
      offer = options.responder.offerLiveInput({
        conversationId,
        id: body.id,
        text: body.text,
        receivedAt: body.receivedAt,
      });
    } catch (error) {
      next(error);
      return;
    }
    if (offer.status === "unavailable") {
      res.status(200).json(offer);
      return;
    }
    void offer.settled.then((settlement) => {
      res.status(200).json(settlement);
    }).catch(next);
  });

  app.get(askPath, (req, res) => {
    if (!authorize(req, res, apiKey)) return;
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    if (conversationId === undefined) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "conversationId is required."));
      return;
    }
    void Promise.resolve(options.interaction?.getPendingAsk(conversationId))
      .then((ask) => res.status(200).json({ ask: ask ?? null }))
      .catch((error: unknown) => sendJsonError(res, 500, error));
  });

  app.post(askPath, express.json({ limit: "64kb" }), (req, res) => {
    if (!authorize(req, res, apiKey)) return;
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    const body = typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : {};
    if (
      conversationId === undefined
      || typeof body.interactionId !== "string"
      || !Array.isArray(body.answers)
      || options.interaction === undefined
    ) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "A supported interactionId and answers are required."));
      return;
    }
    void Promise.resolve(options.interaction.submitAskAnswers({
      conversationId,
      interactionId: body.interactionId,
      answers: body.answers as readonly ChannelAskAnswer[],
    })).then((result) => {
      res.status(200).json(result);
    }).catch((error: unknown) => sendJsonError(res, 500, error));
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const parserStatus = (error as { status?: unknown } | null)?.status;
    const parserType = (error as { type?: unknown } | null)?.type;
    if (parserStatus === 413 || parserType === "entity.too.large") {
      sendJsonError(res, 413, error);
      return;
    }
    // 400 only for client mistakes (invalid_request, body-parse SyntaxError);
    // anything else is a server-side failure and must read as one.
    const isClientError =
      codeOf(error) === "invalid_request" ||
      (error instanceof SyntaxError && (error as { status?: unknown }).status === 400);
    sendJsonError(res, isClientError ? 400 : 500, error);
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new TuiAdapterError("start_failed", "TUI adapter failed to listen.", { reason }),
    noAddress: () => new TuiAdapterError("start_failed", "TUI adapter did not receive a TCP address."),
  });

  async function closeRejectedServer(): Promise<void> {
    stopping = true;
    for (const controller of activeTurns) controller.abort(new Error("TUI adapter rejected its actual bound address."));
    await closeServerBounded(server);
    activeTurns.clear();
  }

  const boundNonLoopback = !isLoopbackHost(address.address);
  if (boundNonLoopback && options.allowNonLoopback !== true) {
    await closeRejectedServer();
    throw new TuiAdapterError(
      "unsafe_host",
      "TUI adapter resolved a loopback host to a non-loopback bind address.",
      { host, boundAddress: address.address, boundPort: address.port },
    );
  }

  server.on("error", (error) => {
    options.onServerError?.(errorToMessage(error));
  });
  const boundPort = address.port;
  const url = `http://${hostForUrl(host)}:${boundPort}`;

  async function handleTurn(req: Request, res: Response): Promise<void> {
    const body = normalizeTurnBody(req.body);
    const controller = new AbortController();
    activeTurns.add(controller);
    if (stopping) controller.abort(new Error("TUI adapter is stopping."));
    const requestId = randomUUID();
    const request: AgentRequestBase = {
      conversationId: body.conversationId,
      text: body.text,
      abortSignal: controller.signal,
      metadata: requestMetadata(body, requestId),
      ...(body.attachments === undefined || body.attachments.length === 0
        ? {}
        : { attachments: body.attachments }),
    };

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("TUI client disconnected."));
      }
    });

    const stream = new NdjsonMessageStream(res, (error) => controller.abort(error));
    try {
      const response: AgentResponse = await options.responder.respond(request, stream);
      await stream.writeFrame({
        kind: "finish",
        ...(response.text === undefined ? {} : { finalText: response.text }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
      });
    } catch (error) {
      const cancelled = isAgentResponseCancelledError(error) || controller.signal.aborted;
      const code = codeOf(error);
      await stream.writeFrame({
        kind: "error",
        message: errorToMessage(error),
        ...(code === undefined ? {} : { code }),
        cancelled,
      }).catch(() => undefined);
    } finally {
      activeTurns.delete(controller);
      res.end();
    }
  }

  return {
    url,
    baseUrl: `${url}${basePath}`,
    infoUrl: `${url}${infoPath}`,
    turnsUrl: `${url}${turnsPath}`,
    host,
    port: boundPort,
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        for (const controller of activeTurns) controller.abort(new Error("TUI adapter stopped."));
        await closeServerBounded(server);
        activeTurns.clear();
      })();
      return stopPromise;
    },
  };
}

/**
 * Serializes each AgentMessageStream callback as one NDJSON frame. Writes honor
 * the response's backpressure signal and carry a bounded pending-byte budget,
 * so a slow client cannot grow the process heap without limit. Oversized event
 * frames are reduced or replaced with a marker to meet the exported UTF-8 byte
 * cap; non-event frames retain their existing behavior.
 */
class NdjsonMessageStream implements AgentMessageStream {
  private readonly writer: BoundedHttpResponseWriter;

  constructor(private readonly res: Response, onWriteFailure: (error: Error) => void) {
    this.writer = new BoundedHttpResponseWriter(res, { onFailure: onWriteFailure });
  }

  async writeFrame(frame: AgentStreamWireFrame): Promise<void> {
    if (this.res.writableEnded) {
      return;
    }
    let line = serializeAgentStreamFrame(frame);
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES && frame.kind === "event") {
      line = serializeCappedEventFrame(frame.event, line);
    }
    await this.writer.write(line);
  }

  async status(text: string): Promise<void> {
    await this.writeFrame({ kind: "status", text });
  }

  async append(delta: string): Promise<void> {
    await this.writeFrame({ kind: "append", delta });
  }

  async replace(text: string): Promise<void> {
    await this.writeFrame({ kind: "replace", text });
  }

  async event(event: AgentStreamEvent): Promise<void> {
    await this.writeFrame({ kind: "event", event });
  }

  async finish(): Promise<void> {
    // The terminal "finish" frame is written by handleTurn from the responder's
    // AgentResponse (which carries metadata); mid-stream finish() is a no-op.
  }
}

/**
 * Prepare a stable reducer for the payload-bearing event variants whose shape
 * the operator adapter preserves under truncation. The input is the parsed
 * snapshot of the already serialized frame, so getters/toJSON hooks from the
 * provider event cannot run again on every size probe. Other event variants
 * use the bounded oversized-event marker directly.
 */
function prepareEventReducer(
  event: AgentStreamEvent,
): ((maxPayloadChars: number) => AgentStreamEvent) | undefined {
  if (!isPayloadReducibleEventType(event.type)) {
    return undefined;
  }
  const metadata = { ...event.metadata, truncated: true };
  if (event.type === "tool_call_progress") {
    const partialResult = serializeUnknown(event.partialResult);
    return (maxPayloadChars) => ({
      ...event,
      partialResult: truncatePreparedText(partialResult, maxPayloadChars),
      metadata,
    });
  }
  if (event.type === "tool_call_completed") {
    const content = serializeUnknown(event.content);
    const argumentsText = event.arguments === undefined
      ? undefined
      : serializeUnknown(event.arguments);
    return (maxPayloadChars) => ({
      ...event,
      content: truncatePreparedText(content, maxPayloadChars),
      ...(argumentsText === undefined
        ? {}
        : { arguments: truncatePreparedText(argumentsText, maxPayloadChars) }),
      metadata,
    });
  }
  if (event.type === "tool_call_started") {
    const argumentsText = serializeUnknown(event.arguments);
    return (maxPayloadChars) => ({
      ...event,
      arguments: truncatePreparedText(argumentsText, maxPayloadChars),
      metadata,
    });
  }
  if (event.type === "assistant_thought") {
    return (maxPayloadChars) => ({
      ...event,
      text: event.text.slice(0, maxPayloadChars),
      metadata,
    });
  }
  return undefined;
}

function isPayloadReducibleEventType(type: string): boolean {
  return type === "assistant_thought"
    || type === "tool_call_started"
    || type === "tool_call_progress"
    || type === "tool_call_completed";
}

/**
 * Reject non-reducible variants before parsing their oversized payload, then
 * stabilize reducible variants from the already serialized frame and probe the
 * minimal candidate before binary search. The search never reserializes the
 * original unbounded provider object, and an oversized invariant field/metadata
 * object falls back after one minimal probe. Measuring each bounded candidate
 * keeps multibyte text, JSON escaping, metadata, and the trailing newline inside
 * the byte contract.
 */
function serializeCappedEventFrame(
  originalEvent: AgentStreamEvent,
  serializedFrame: string,
): string {
  if (!isPayloadReducibleEventType(originalEvent.type)) {
    return serializeOversizedEventMarker(originalEvent.type);
  }
  const event = (JSON.parse(serializedFrame) as Extract<
    AgentStreamWireFrame,
    { kind: "event" }
  >).event;
  const reduceEvent = prepareEventReducer(event);
  if (reduceEvent === undefined) {
    return serializeOversizedEventMarker(event.type);
  }

  const minimal = serializeAgentStreamFrame({ kind: "event", event: reduceEvent(0) });
  if (Buffer.byteLength(minimal, "utf8") > MAX_FRAME_BYTES) {
    return serializeOversizedEventMarker(event.type);
  }

  let lower = 1;
  let upper = MAX_FRAME_BYTES;
  let best = minimal;

  while (lower <= upper) {
    const maxPayloadChars = Math.floor((lower + upper) / 2);
    const candidate = serializeAgentStreamFrame({
      kind: "event",
      event: reduceEvent(maxPayloadChars),
    });
    if (Buffer.byteLength(candidate, "utf8") <= MAX_FRAME_BYTES) {
      best = candidate;
      lower = maxPayloadChars + 1;
    } else {
      upper = maxPayloadChars - 1;
    }
  }

  return best;
}

function serializeOversizedEventMarker(originalType: string): string {
  return serializeAgentStreamFrame({
    kind: "event",
    event: {
      type: "runtime_telemetry",
      kind: "oversized_event",
      data: { originalType: originalType.slice(0, 128) },
      metadata: { truncated: true },
    },
  });
}

function serializeUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function truncatePreparedText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… [truncated]` : text;
}

interface NormalizedTurnBody {
  readonly conversationId: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly client: "tui" | "web";
  readonly attachments?: readonly AgentAttachment[];
}

interface NormalizedVerbatimBody {
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

function normalizeVerbatimBody(rawConversationId: string | string[] | undefined, body: unknown): NormalizedVerbatimBody {
  const conversationId = normalizeOptionalString(
    typeof rawConversationId === "string" ? rawConversationId : undefined,
  );
  if (conversationId === undefined) {
    throw new TuiAdapterError("invalid_request", "conversationId is required.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TuiAdapterError("invalid_request", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : undefined;
  const idempotencyKey = normalizeOptionalString(
    typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined,
  );
  if (text === undefined || text.trim().length === 0) {
    throw new TuiAdapterError("invalid_request", "text is required.");
  }
  if (text.length > MAX_VERBATIM_TEXT_CHARACTERS || Buffer.byteLength(text, "utf8") > MAX_VERBATIM_TEXT_BYTES) {
    throw new TuiAdapterError("invalid_request", "text exceeds the history append limit.");
  }
  if (idempotencyKey === undefined || idempotencyKey.length > 512) {
    throw new TuiAdapterError("invalid_request", "idempotencyKey is required and must be at most 512 characters.");
  }
  return { conversationId, text, idempotencyKey };
}

function normalizeTurnBody(body: unknown): NormalizedTurnBody {
  if (typeof body !== "object" || body === null) {
    throw new TuiAdapterError("invalid_request", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const conversationId = normalizeOptionalString(
    typeof record.conversationId === "string" ? record.conversationId : undefined,
  );
  if (conversationId === undefined) {
    throw new TuiAdapterError("invalid_request", "conversationId is required.");
  }
  if (record.text !== undefined && typeof record.text !== "string") {
    throw new TuiAdapterError("invalid_request", "text must be a string when provided.");
  }
  const text = typeof record.text === "string" ? record.text : "";
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  if (record.client !== undefined && record.client !== "tui" && record.client !== "web") {
    throw new TuiAdapterError("invalid_request", "client must be 'tui' or 'web' when provided.");
  }
  const client = record.client === "web" || (record.client === undefined && metadata.source === "web")
    ? "web"
    : "tui";
  const attachments = normalizeTurnAttachments(record.attachments, client);
  if (text.length === 0 && (attachments === undefined || attachments.length === 0)) {
    throw new TuiAdapterError("invalid_request", "text or at least one attachment is required.");
  }
  return {
    conversationId,
    text,
    metadata,
    client,
    ...(attachments === undefined ? {} : { attachments }),
  };
}

function requestMetadata(body: NormalizedTurnBody, requestId: string): Record<string, unknown> {
  if (body.client === "tui") {
    return { ...body.metadata, source: "tui", tuiRequestId: requestId };
  }

  const web = isRecord(body.metadata.web) ? body.metadata.web : undefined;
  const existingTui = isRecord(body.metadata.tui) ? body.metadata.tui : undefined;
  const overrideMirror = web === undefined
    ? undefined
    : {
        ...(typeof web.model === "string" ? { model: web.model } : {}),
        ...(typeof web.effort === "string" ? { effort: web.effort } : {}),
      };
  const tui = existingTui === undefined && (overrideMirror === undefined || Object.keys(overrideMirror).length === 0)
    ? undefined
    : { ...existingTui, ...overrideMirror };

  return {
    ...body.metadata,
    web: web ?? {},
    ...(tui === undefined ? {} : { tui }),
    source: "web",
    webRequestId: requestId,
  };
}

function normalizeTurnAttachments(
  value: unknown,
  client: NormalizedTurnBody["client"],
): readonly AgentAttachment[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TuiAdapterError("invalid_request", "attachments must be an array when provided.");
  }
  if (client === "web" && value.length > MAX_WEB_ATTACHMENTS) {
    throw new TuiAdapterError(
      "invalid_request",
      `A web turn supports at most ${String(MAX_WEB_ATTACHMENTS)} attachments.`,
    );
  }

  let totalBytes = 0;
  const attachments = value.map((entry, index) => {
    const attachment = normalizeTurnAttachment(entry, index, client);
    totalBytes += attachment.sizeBytes ?? 0;
    return attachment;
  });
  if (client === "web" && totalBytes > MAX_WEB_ATTACHMENT_BYTES) {
    throw new TuiAdapterError(
      "invalid_request",
      `Web turn attachments exceed the ${String(MAX_WEB_ATTACHMENT_BYTES)}-byte aggregate limit.`,
    );
  }
  return attachments;
}

function normalizeTurnAttachment(
  value: unknown,
  index: number,
  client: NormalizedTurnBody["client"],
): AgentAttachment {
  if (!isRecord(value)) {
    throw invalidAttachment(index, "must be a JSON object");
  }
  if (value.kind !== "image" && value.kind !== "document") {
    throw invalidAttachment(index, "kind must be 'image' or 'document'");
  }
  const mimeType = normalizeOptionalString(typeof value.mimeType === "string" ? value.mimeType : undefined);
  if (mimeType === undefined) {
    throw invalidAttachment(index, "mimeType is required");
  }
  const normalizedMimeType = mimeType.toLowerCase();
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    throw invalidAttachment(index, `MIME type '${mimeType}' is not allowed`);
  }
  if (value.kind !== agentAttachmentKindFromMimeType(normalizedMimeType)) {
    throw invalidAttachment(index, `kind does not match MIME type '${mimeType}'`);
  }
  if (typeof value.data !== "string" || !isCanonicalBase64(value.data)) {
    throw invalidAttachment(index, "data must be canonical base64");
  }
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.byteLength > DEFAULT_AGENT_ATTACHMENT_MAX_BYTES) {
    throw invalidAttachment(
      index,
      `decoded data exceeds the ${String(DEFAULT_AGENT_ATTACHMENT_MAX_BYTES)}-byte limit`,
    );
  }
  const name = optionalAttachmentString(value.name, index, "name");
  // Web uploads intentionally carry the bytes only. Reconstruct text after
  // decoding so a valid 64 MiB turn remains bounded by the 96 MiB JSON parser
  // and browser-supplied text can never disagree with the attachment bytes.
  // Legacy TUI callers retain their explicit extracted-text behavior.
  const text = client === "web"
    ? decodeAgentAttachmentText(normalizedMimeType, decoded)
    : optionalAttachmentString(value.text, index, "text");
  const declaredSizeBytes = optionalAttachmentNumber(value.sizeBytes, index, "sizeBytes");
  if (declaredSizeBytes !== undefined && declaredSizeBytes !== decoded.byteLength) {
    throw invalidAttachment(index, "sizeBytes does not match decoded data");
  }
  const durationSeconds = optionalAttachmentNumber(value.durationSeconds, index, "durationSeconds");

  return {
    kind: value.kind,
    mimeType,
    data: value.data,
    sizeBytes: decoded.byteLength,
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

function optionalAttachmentString(
  value: unknown,
  index: number,
  field: "name" | "text",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidAttachment(index, `${field} must be a string when provided`);
  }
  return value;
}

function optionalAttachmentNumber(
  value: unknown,
  index: number,
  field: "sizeBytes" | "durationSeconds",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidAttachment(index, `${field} must be a non-negative finite number when provided`);
  }
  return value;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  if (value.length === 0) {
    return true;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const payloadLength = value.length - padding;
  for (let index = 0; index < payloadLength; index += 1) {
    if (base64Value(value.charCodeAt(index)) === undefined) {
      return false;
    }
  }
  // Padding is only legal in the final quartet, and its unused bits must be
  // zero for the spelling to be canonical rather than merely decodable.
  if (padding === 2) {
    const tail = base64Value(value.charCodeAt(payloadLength - 1));
    return payloadLength >= 2 && tail !== undefined && (tail & 0b1111) === 0;
  }
  if (padding === 1) {
    const tail = base64Value(value.charCodeAt(payloadLength - 1));
    return payloadLength >= 3 && tail !== undefined && (tail & 0b11) === 0;
  }
  return true;
}

function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
}

function invalidAttachment(index: number, reason: string): TuiAdapterError {
  return new TuiAdapterError("invalid_request", `attachments[${String(index)}] ${reason}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveInfo(info: TuiAdapterOptions["info"]): Promise<TuiAdapterInfo | undefined> {
  if (typeof info === "function") {
    return await info();
  }
  return info;
}

function authorize(req: Request, res: Response, apiKey: string | undefined): boolean {
  if (apiKey === undefined) {
    return true;
  }
  const presented = readAuthorizationBearer(req.header("authorization"));
  if (presented !== undefined && bearerTokensEqual(presented, apiKey)) {
    return true;
  }
  res.status(401).json({ error: { message: "Invalid API key.", code: "invalid_api_key" } });
  return false;
}

function sendJsonError(res: Response, status: number, error: unknown): void {
  res.status(status).json({
    error: {
      message: errorToMessage(error),
      ...(codeOf(error) === undefined ? {} : { code: codeOf(error) }),
    },
  });
}

function codeOf(error: unknown): string | undefined {
  const candidate = (error as { code?: unknown } | null)?.code;
  return typeof candidate === "string" ? candidate : undefined;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith("/")) {
    throw new TuiAdapterError("invalid_config", "basePath must start with '/'.");
  }
  return basePath.length === 1 ? "" : basePath.replace(/\/+$/u, "");
}

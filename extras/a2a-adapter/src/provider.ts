import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  AgentEvent,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  RequestMalformedError,
  type A2ARequestHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type Task,
  type TaskStatus,
} from "@a2a-js/sdk";
import {
  AgentResponseCancelledError,
  closeServerBounded,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  hostForUrl,
  isLoopbackHost,
  listen,
  readAuthorizationBearer,
} from "@mono-agent/agent-contracts";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import {
  type A2AAgentCardOptions,
  type A2AAgentSkillOptions,
  createA2AAgentCard,
} from "./card.js";
import { A2AProviderError } from "./errors.js";
import {
  createIdempotentA2ARequestHandler,
  guardUnsupportedA2AIdempotency,
  type A2AProviderIdempotencyOptions,
  validateA2AProviderIdempotencyOptions,
} from "./idempotency.js";

export interface A2ARequestMetadata {
  readonly tenant?: string;
  readonly contextId: string;
  readonly taskId: string;
  readonly messageId: string;
  readonly inputModes: readonly string[];
  readonly sourceUrl?: string;
}

export interface A2AAgentRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata: {
    readonly a2a: A2ARequestMetadata;
    readonly [key: string]: unknown;
  };
}

export interface A2AProviderLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface A2AProviderOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicBaseUrl?: string;
  readonly allowNonLoopback?: boolean;
  readonly requireBearer?: boolean;
  readonly bearerToken?: string;
  /** Optional request-body ceiling. Omit to preserve the A2A SDK's default. */
  readonly maxRequestBytes?: number;
  /** Enables the advertised mono-agent extension only with durable state. */
  readonly idempotency?: A2AProviderIdempotencyOptions;
  readonly responder: AgentResponder<A2AAgentRequest, AgentMessageStream, AgentResponse>;
  readonly agent: Omit<A2AAgentCardOptions, "publicBaseUrl" | "skill" | "requireBearer">;
  readonly skill: A2AAgentSkillOptions;
  readonly logger?: A2AProviderLogger;
}

export interface A2AProviderStartResult {
  readonly url: string;
  readonly agentCardUrl: string;
  readonly jsonRpcUrl: string;
  readonly restUrl: string;
  readonly host: string;
  readonly port: number;
  readonly agentCard: AgentCard;
  stop(): Promise<void>;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly taskId: string;
  readonly contextId: string;
  readonly eventBus: ExecutionEventBus;
  cancellationPublished: boolean;
}

export async function startA2AProvider(
  options: A2AProviderOptions,
): Promise<A2AProviderStartResult> {
  validateProviderOptions(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new A2AProviderError(
      "unsafe_host",
      "A2A provider refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));
  const requireBearer = options.requireBearer === true;
  if (requireBearer && normalizeOptionalString(options.bearerToken) === undefined) {
    throw new A2AProviderError(
      "missing_required_config",
      "A2A provider requires bearerToken when requireBearer is true.",
    );
  }

  const app = express();
  const server = createServer(app);
  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new A2AProviderError("start_failed", "A2A provider failed to listen.", { reason }),
    noAddress: () =>
      new A2AProviderError("start_failed", "A2A provider did not receive a TCP address."),
  });
  const boundHost = hostForUrl(host);
  const boundPort = address.port;
  const publicBaseUrl = options.publicBaseUrl === undefined
    ? `http://${boundHost}:${boundPort}`
    : options.publicBaseUrl;
  assertSafePublicBaseUrl(publicBaseUrl, options.allowNonLoopback === true);

  const agentCard = createA2AAgentCard({
    ...options.agent,
    publicBaseUrl,
    requireBearer,
    durableIdempotency: options.idempotency !== undefined,
    skill: options.skill,
  });
  const executor = new MonoA2AExecutor(options.responder, {
    sourceUrl: publicBaseUrl,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const taskStore = new InMemoryTaskStore();
  const baseRequestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
    new DefaultExecutionEventBusManager(),
  );
  let requestHandler: A2ARequestHandler = guardUnsupportedA2AIdempotency(baseRequestHandler);
  let stopPromise: Promise<void> | undefined;
  if (options.idempotency !== undefined) {
    try {
      requestHandler = await createIdempotentA2ARequestHandler({
        delegate: baseRequestHandler,
        taskStore,
        options: options.idempotency,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    } catch (error) {
      executor.stop("A2A provider initialization failed.");
      await closeServerBounded(server).catch(() => undefined);
      throw error;
    }
  }
  const auth = requireBearer
    ? bearerAuthMiddleware(options.bearerToken as string)
    : (_req: Request, _res: Response, next: NextFunction) => next();

  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  const jsonRpc = jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  });
  const rest = restHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  });
  if (options.maxRequestBytes === undefined) {
    app.use("/a2a/json-rpc", auth, jsonRpc);
    app.use("/a2a/rest", auth, rest);
  } else {
    app.use(
      "/a2a/json-rpc",
      auth,
      configuredJsonParser(options.maxRequestBytes),
      requestBodyErrorHandler("json-rpc"),
      jsonRpc,
    );
    app.use(
      "/a2a/rest",
      auth,
      configuredJsonParser(options.maxRequestBytes),
      requestBodyErrorHandler("rest"),
      rest,
    );
  }

  const url = publicBaseUrl.replace(/\/+$/u, "");
  return {
    url,
    agentCardUrl: `${url}/.well-known/agent-card.json`,
    jsonRpcUrl: `${url}/a2a/json-rpc`,
    restUrl: `${url}/a2a/rest`,
    host,
    port: boundPort,
    agentCard,
    stop() {
      stopPromise ??= (async () => {
        executor.stop("A2A provider stopped.");
        await closeServerBounded(server);
      })();
      return stopPromise;
    },
  };
}

class MonoA2AExecutor implements AgentExecutor {
  private readonly responder: AgentResponder<A2AAgentRequest, AgentMessageStream, AgentResponse>;
  private readonly sourceUrl: string | undefined;
  private readonly logger: A2AProviderLogger | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private stopping = false;

  constructor(
    responder: AgentResponder<A2AAgentRequest, AgentMessageStream, AgentResponse>,
    options: {
      readonly sourceUrl?: string;
      readonly logger?: A2AProviderLogger;
    } = {},
  ) {
    this.responder = responder;
    this.sourceUrl = options.sourceUrl;
    this.logger = options.logger;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      eventBus,
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      cancellationPublished: false,
    };
    this.activeRuns.set(requestContext.taskId, active);

    eventBus.publish(AgentEvent.task(createTask({
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      state: TaskState.TASK_STATE_SUBMITTED,
      history: [requestContext.userMessage],
      statusText: "Task submitted.",
    })));

    if (this.stopping) {
      controller.abort(new AgentResponseCancelledError("A2A provider is stopping."));
      publishCanceled(active, "Task canceled because the provider is stopping.");
      this.activeRuns.delete(requestContext.taskId);
      return;
    }

    try {
      const normalized = textFromMessage(requestContext.userMessage);
      const stream = new A2AProviderMessageStream(eventBus, {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
      });
      eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        state: TaskState.TASK_STATE_WORKING,
        text: "Task is running.",
      })));

      const response = await this.responder.respond({
        conversationId: conversationIdFor(requestContext),
        text: normalized.text,
        abortSignal: controller.signal,
        metadata: {
          a2a: {
            ...(requestContext.context.tenant === undefined ? {} : { tenant: requestContext.context.tenant }),
            contextId: requestContext.contextId,
            taskId: requestContext.taskId,
            messageId: requestContext.userMessage.messageId,
            inputModes: normalized.inputModes,
            ...(this.sourceUrl === undefined ? {} : { sourceUrl: this.sourceUrl }),
          },
        },
      }, stream);

      if (active.cancellationPublished || controller.signal.aborted) {
        return;
      }

      await stream.finish(response.text);
      const finalText = stream.text;
      if (finalText.length > 0) {
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          artifact: {
            artifactId: "final-text",
            name: "Final text response",
            description: "Text response returned by the responder.",
            parts: [textPart(finalText)],
            metadata: {},
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: {},
        }));
      }

      eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        state: TaskState.TASK_STATE_COMPLETED,
        ...(finalText.length === 0 ? {} : { text: finalText }),
      })));
    } catch (error) {
      if (active.cancellationPublished) {
        return;
      }
      if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
        publishCanceled(active, "Task canceled.");
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.error?.("A2A responder failed.", { reason });
      eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        state: error instanceof A2AProviderError && error.code === "unsupported_input"
          ? TaskState.TASK_STATE_REJECTED
          : TaskState.TASK_STATE_FAILED,
        text: reason,
      })));
    } finally {
      this.activeRuns.delete(requestContext.taskId);
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.activeRuns.get(taskId);
    if (active === undefined) {
      eventBus.finished();
      return;
    }
    if (!active.cancellationPublished) {
      active.controller.abort(new AgentResponseCancelledError("A2A task cancellation requested."));
      publishCanceled(active, "Task cancellation requested by user.");
    }
  }

  stop(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const active of this.activeRuns.values()) {
      if (active.cancellationPublished) continue;
      active.controller.abort(new AgentResponseCancelledError(reason));
      publishCanceled(active, reason);
    }
  }
}

class A2AProviderMessageStream implements AgentMessageStream {
  private readonly eventBus: ExecutionEventBus;
  private readonly taskId: string;
  private readonly contextId: string;
  private currentText = "";
  private finished = false;

  constructor(
    eventBus: ExecutionEventBus,
    context: {
      readonly taskId: string;
      readonly contextId: string;
    },
  ) {
    this.eventBus = eventBus;
    this.taskId = context.taskId;
    this.contextId = context.contextId;
  }

  get text(): string {
    return this.currentText.trim();
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }
    this.eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
      taskId: this.taskId,
      contextId: this.contextId,
      state: TaskState.TASK_STATE_WORKING,
      text: normalized,
    })));
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    this.currentText += delta;
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new A2AProviderError("invalid_config", "Cannot write to a finished A2A stream.");
    }
  }
}

function validateProviderOptions(options: A2AProviderOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new A2AProviderError("missing_required_config", "A2A provider requires a responder.");
  }
  if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) {
    throw new A2AProviderError("invalid_config", "A2A provider port must be an integer from 0 to 65535.");
  }
  if (
    options.maxRequestBytes !== undefined
    && (
      !Number.isInteger(options.maxRequestBytes)
      || options.maxRequestBytes < 1_024
      || options.maxRequestBytes > 100_000_000
    )
  ) {
    throw new A2AProviderError(
      "invalid_config",
      "A2A provider maxRequestBytes must be an integer from 1024 to 100000000.",
      { field: "maxRequestBytes" },
    );
  }
  if (options.idempotency !== undefined) {
    validateA2AProviderIdempotencyOptions(options.idempotency);
  }
}

function configuredJsonParser(maxRequestBytes: number) {
  return express.json({
    limit: maxRequestBytes,
    type: ["application/json", "application/a2a+json"],
  });
}

function requestBodyErrorHandler(binding: "json-rpc" | "rest"): ErrorRequestHandler {
  return (error, _request, response, next): void => {
    if (isPayloadTooLargeError(error)) {
      sendRequestBodyError(response, binding, 413, "Request body exceeds the configured limit.");
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      sendRequestBodyError(response, binding, 400, "Invalid JSON payload.");
      return;
    }
    next(error);
  };
}

function isPayloadTooLargeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const shaped = error as Error & { readonly status?: unknown; readonly type?: unknown };
  return shaped.status === 413 || shaped.type === "entity.too.large";
}

function sendRequestBodyError(
  response: Response,
  binding: "json-rpc" | "rest",
  status: 400 | 413,
  message: string,
): void {
  if (binding === "json-rpc") {
    response.status(status).json({
      jsonrpc: "2.0",
      id: null,
      error: JsonRpcTransportHandler.mapToJSONRPCError(new RequestMalformedError(message)),
    });
    return;
  }
  response.status(status).json({
    error: {
      code: status,
      status: status === 413 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
      message,
      details: [],
    },
  });
}

function assertSafePublicBaseUrl(publicBaseUrl: string, allowNonLoopback: boolean): void {
  const parsed = new URL(publicBaseUrl);
  if (allowNonLoopback || isLoopbackHost(parsed.hostname)) {
    return;
  }
  throw new A2AProviderError(
    "unsafe_host",
    "A2A provider refuses a non-loopback publicBaseUrl unless allowNonLoopback is true.",
    { publicBaseUrl },
  );
}

function bearerAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = readAuthorizationBearer(req.header("authorization"));
    if (presented !== undefined && bearerTokensEqual(presented, token)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", 'Bearer realm="a2a"');
    res.status(401).json({ error: "Unauthorized" });
  };
}

function textFromMessage(message: Message): {
  readonly text: string;
  readonly inputModes: readonly string[];
} {
  const inputModes: string[] = [];
  const textParts: string[] = [];
  for (const part of message.parts) {
    inputModes.push(part.mediaType.length > 0 ? part.mediaType : "application/octet-stream");
    if (part.content?.$case !== "text") {
      throw new A2AProviderError(
        "unsupported_input",
        "A2A provider supports text/plain parts only.",
      );
    }
    textParts.push(part.content.value);
  }
  const text = textParts.join("\n").trim();
  if (text.length === 0) {
    throw new A2AProviderError(
      "unsupported_input",
      "A2A provider requires non-empty text input.",
    );
  }
  return { text, inputModes };
}

function conversationIdFor(requestContext: RequestContext): string {
  if (requestContext.contextId.length > 0) {
    return requestContext.contextId;
  }
  if (requestContext.taskId.length > 0) {
    return requestContext.taskId;
  }
  return `a2a:${requestContext.userMessage.messageId}`;
}

function createTask(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly state: TaskState;
  readonly history?: readonly Message[];
  readonly statusText?: string;
}): Task {
  return {
    id: input.taskId,
    contextId: input.contextId,
    status: createStatus({
      taskId: input.taskId,
      contextId: input.contextId,
      state: input.state,
      ...(input.statusText === undefined ? {} : { text: input.statusText }),
    }),
    artifacts: [],
    history: [...(input.history ?? [])],
    metadata: {},
  };
}

function createStatus(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly state: TaskState;
  readonly text?: string;
}): TaskStatus {
  return {
    state: input.state,
    message: input.text === undefined
      ? undefined
      : agentMessage({
          taskId: input.taskId,
          contextId: input.contextId,
          text: input.text,
        }),
    timestamp: new Date().toISOString(),
  };
}

function createStatusUpdate(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly state: TaskState;
  readonly text?: string;
}) {
  return {
    taskId: input.taskId,
    contextId: input.contextId,
    status: createStatus(input),
    metadata: {},
  };
}

function agentMessage(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly text: string;
}): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: randomUUID(),
    taskId: input.taskId,
    contextId: input.contextId,
    parts: [textPart(input.text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

function publishCanceled(active: ActiveRun, text: string): void {
  active.cancellationPublished = true;
  active.eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
    taskId: active.taskId,
    contextId: active.contextId,
    state: TaskState.TASK_STATE_CANCELED,
    text,
  })));
  active.eventBus.finished();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

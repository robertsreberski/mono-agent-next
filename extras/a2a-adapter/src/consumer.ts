import { randomUUID } from "node:crypto";

import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  Client,
  ClientFactory,
  JsonRpcTransportFactory,
  RestTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";

import { A2AConsumerError } from "./errors.js";
import {
  A2A_IDEMPOTENCY_EXTENSION_URI,
  A2A_IDEMPOTENCY_METADATA_KEY,
  A2A_IDEMPOTENCY_SCHEMA_VERSION,
  a2aIdempotencyEnvelope,
  classifyA2AIdempotencyTransportError,
  stableA2AMessageId,
} from "./idempotency.js";

export interface A2AConsumerOptions {
  readonly agentUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly preferredTransports?: readonly ("HTTP+JSON" | "JSONRPC")[];
}

export interface A2AConsumerSendMessageInput {
  readonly text?: string;
  readonly message?: Message;
  readonly contextId?: string;
  readonly taskId?: string;
  /**
   * Stable identity for one logical dispatch. The remote Agent Card must
   * advertise the mono-agent idempotency extension or the consumer fails
   * before sending.
   */
  readonly idempotencyKey?: string;
  readonly returnImmediately?: boolean;
  /** Per-caller history projection; it is not part of logical workload identity. */
  readonly historyLength?: number;
  readonly stream?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type A2AConsumerDispatchMessageInput = Omit<
  A2AConsumerSendMessageInput,
  "idempotencyKey" | "returnImmediately" | "stream"
> & {
  /** Stable identity is mandatory for a durable dispatch lifecycle. */
  readonly idempotencyKey: string;
};

export interface A2AConsumerDispatchObservationOptions {
  readonly signal?: AbortSignal;
  /** Observation-only timeout. It does not cancel or bound remote work. */
  readonly timeoutMs?: number;
}

export interface A2AConsumerDispatchCancelOptions {
  readonly signal?: AbortSignal;
}

export interface A2AConsumerResponseMetadata {
  readonly a2a: {
    readonly remoteAgentUrl: string;
    readonly protocolVersion: string;
    readonly messageId?: string;
    readonly taskId?: string;
    readonly contextId?: string;
    readonly state?: string;
  };
  readonly [key: string]: unknown;
}

export interface A2AConsumerResponse extends AgentResponse {
  readonly text?: string;
  readonly metadata: A2AConsumerResponseMetadata;
}

export type A2AConsumerTerminalOutcome =
  | {
      readonly status: "completed";
      readonly response: A2AConsumerResponse;
    }
  | {
      readonly status: "failed" | "canceled" | "rejected" | "auth_required" | "input_required";
      readonly response: A2AConsumerResponse;
      readonly error: A2AConsumerError;
    };

export interface A2AConsumerDispatch {
  /** Latest authoritative snapshot observed by this handle. */
  readonly current: A2AConsumerResponse;
  /**
   * Join the admitted execution and wait for a protocol terminal state.
   * Aborting or timing out this observer never cancels the remote task.
   */
  observeTerminal(
    options?: A2AConsumerDispatchObservationOptions,
  ): Promise<A2AConsumerTerminalOutcome>;
  /** Explicitly cancel the admitted task and return its terminal outcome. */
  cancel(options?: A2AConsumerDispatchCancelOptions): Promise<A2AConsumerTerminalOutcome>;
}

export interface A2AConsumerResponderOptions extends A2AConsumerOptions {
  readonly streamRemote?: boolean;
  /** Resolve a stable logical key from the local request; undefined disables it. */
  readonly idempotencyKeyForRequest?: (request: AgentRequestBase) => string | undefined;
}

export class A2AConsumer {
  readonly agentCard: AgentCard;
  private readonly client: Client;
  private readonly agentUrl: string;
  private readonly timeoutMs: number | undefined;
  private readonly refreshConnection: ((signal?: AbortSignal) => Promise<{
    readonly agentCard: AgentCard;
    readonly client: Client;
  }>) | undefined;

  constructor(input: {
    readonly client: Client;
    readonly agentCard: AgentCard;
    readonly agentUrl: string;
    readonly timeoutMs?: number;
    readonly refreshConnection?: (signal?: AbortSignal) => Promise<{
      readonly agentCard: AgentCard;
      readonly client: Client;
    }>;
  }) {
    this.client = input.client;
    this.agentCard = input.agentCard;
    this.agentUrl = input.agentUrl;
    this.timeoutMs = input.timeoutMs;
    this.refreshConnection = input.refreshConnection;
  }

  async sendMessage(input: A2AConsumerSendMessageInput): Promise<A2AConsumerResponse> {
    const request = buildSendMessageRequest(input);
    const timeoutContext = signalWithTimeout(input.signal, input.timeoutMs ?? this.timeoutMs);
    const options = requestOptionsFor(input, timeoutContext.signal);

    try {
      let agentCard = this.agentCard;
      let client = this.client;
      if (input.idempotencyKey !== undefined) {
        if (this.refreshConnection !== undefined) {
          const refreshed = await this.refreshConnection(timeoutContext.signal);
          assertIdempotencySupported(refreshed.agentCard);
          agentCard = refreshed.agentCard;
          client = refreshed.client;
        } else {
          assertIdempotencySupported(agentCard);
        }
      }
      if (input.stream === true && agentCard.capabilities?.streaming === true) {
        return await this.sendStreaming(client, request, options);
      }
      const result = await client.sendMessage(request, options);
      return responseFromResult(result, {
        agentUrl: this.agentUrl,
        protocolVersion: client.protocolVersion,
        allowPending: input.returnImmediately === true,
      });
    } catch (error) {
      throw normalizeConsumerError(error, {
        agentUrl: this.agentUrl,
        timeoutContext,
      });
    } finally {
      timeoutContext.cleanup();
    }
  }

  async dispatchMessage(
    input: A2AConsumerDispatchMessageInput,
  ): Promise<A2AConsumerDispatch> {
    if (typeof input.idempotencyKey !== "string") {
      throw new A2AConsumerError(
        "invalid_idempotency_key",
        "A2A dispatchMessage requires an idempotencyKey.",
        { field: "idempotencyKey" },
      );
    }
    const request = cloneDispatchRequest(buildSendMessageRequest({
      ...input,
      returnImmediately: true,
      stream: false,
    }));
    const current = await this.sendDispatchProjection(request, {
      returnImmediately: true,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

    return new A2AConsumerDispatchHandle({
      current,
      observe: async (options) => await this.sendDispatchProjection(request, {
        returnImmediately: false,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
      cancel: async (taskId, signal) => await this.cancelDispatchTask(taskId, signal),
    });
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<A2AConsumerResponse> {
    const options = signal === undefined ? undefined : { signal } satisfies RequestOptions;
    try {
      const task = await this.client.cancelTask({ id: taskId, tenant: "", metadata: {} }, options);
      return responseFromResult(task, {
        agentUrl: this.agentUrl,
        protocolVersion: this.client.protocolVersion,
        allowPending: true,
        allowCanceled: true,
      });
    } catch (error) {
      throw normalizeConsumerError(error);
    }
  }

  private async sendDispatchProjection(
    request: SendMessageRequest,
    projection: {
      readonly returnImmediately: boolean;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<A2AConsumerResponse> {
    const timeoutContext = signalWithTimeout(
      projection.signal,
      projection.timeoutMs ?? this.timeoutMs,
    );
    const options = requestOptionsForIdempotency(true, timeoutContext.signal);

    try {
      let agentCard = this.agentCard;
      let client = this.client;
      if (this.refreshConnection !== undefined) {
        const refreshed = await this.refreshConnection(timeoutContext.signal);
        agentCard = refreshed.agentCard;
        client = refreshed.client;
      }
      assertIdempotencySupported(agentCard);
      const result = await client.sendMessage(
        projectSendMessageRequest(request, projection.returnImmediately),
        options,
      );
      return responseFromResult(result, {
        agentUrl: this.agentUrl,
        protocolVersion: client.protocolVersion,
        allowPending: true,
        allowTerminalFailures: true,
        allowEmptyResponse: true,
      });
    } catch (error) {
      throw normalizeConsumerError(error, {
        agentUrl: this.agentUrl,
        timeoutContext,
      });
    } finally {
      timeoutContext.cleanup();
    }
  }

  private async cancelDispatchTask(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<A2AConsumerResponse> {
    const options = signal === undefined ? undefined : { signal } satisfies RequestOptions;
    try {
      const client = this.refreshConnection === undefined
        ? this.client
        : (await this.refreshConnection(signal)).client;
      const task = await client.cancelTask({ id: taskId, tenant: "", metadata: {} }, options);
      return responseFromResult(task, {
        agentUrl: this.agentUrl,
        protocolVersion: client.protocolVersion,
        allowPending: true,
        allowTerminalFailures: true,
        allowEmptyResponse: true,
      });
    } catch (error) {
      throw normalizeConsumerError(error);
    }
  }

  private async sendStreaming(
    client: Client,
    request: SendMessageRequest,
    options: RequestOptions | undefined,
  ): Promise<A2AConsumerResponse> {
    let latest: SendMessageResult | undefined;
    for await (const event of client.sendMessageStream(request, options)) {
      latest = resultFromStreamEvent(event) ?? latest;
    }
    if (latest === undefined) {
      throw new A2AConsumerError(
        "empty_a2a_response",
        "Remote A2A stream ended without a message or task.",
      );
    }
    return responseFromResult(latest, {
      agentUrl: this.agentUrl,
      protocolVersion: client.protocolVersion,
      allowPending: false,
    });
  }
}

export async function createA2AConsumer(
  options: A2AConsumerOptions,
): Promise<A2AConsumer> {
  const fetchImpl = bearerFetch(options.fetchImpl ?? fetch, options.bearerToken);
  const agentCard = await discoverA2AAgent({
    agentUrl: options.agentUrl,
    fetchImpl,
  });
  const factory = new ClientFactory({
    transports: [
      new RestTransportFactory({ fetchImpl }),
      new JsonRpcTransportFactory({ fetchImpl }),
    ],
    preferredTransports: [...(options.preferredTransports ?? ["HTTP+JSON", "JSONRPC"])],
    clientConfig: {
      acceptedOutputModes: ["text/plain"],
    },
  });
  const client = await factory.createFromAgentCard(agentCard);
  return new A2AConsumer({
    client,
    agentCard,
    agentUrl: options.agentUrl,
    refreshConnection: async (signal) => {
      const refreshedCard = await discoverA2AAgent({
        agentUrl: options.agentUrl,
        fetchImpl,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        agentCard: refreshedCard,
        client: await factory.createFromAgentCard(refreshedCard),
      };
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export async function discoverA2AAgent(input: {
  readonly agentUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<AgentCard> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cardUrl = agentCardUrlFor(input.agentUrl);
  let response: Response;
  try {
    response = await fetchImpl(cardUrl, input.signal === undefined ? undefined : { signal: input.signal });
  } catch (error) {
    throw new A2AConsumerError("discovery_failed", "Failed to fetch A2A Agent Card.", {
      reason: error instanceof Error ? error.message : String(error),
      agentUrl: input.agentUrl,
    });
  }
  if (!response.ok) {
    throw new A2AConsumerError("discovery_failed", "Failed to fetch A2A Agent Card.", {
      status: response.status,
      agentUrl: input.agentUrl,
    });
  }
  const card = await response.json() as unknown;
  assertAgentCard(card, input.agentUrl);
  return card;
}

export async function sendA2AMessage(
  input: A2AConsumerOptions & A2AConsumerSendMessageInput,
): Promise<A2AConsumerResponse> {
  const consumer = await createA2AConsumer(input);
  return await consumer.sendMessage(input);
}

export async function dispatchA2AMessage(
  input: A2AConsumerOptions & A2AConsumerDispatchMessageInput,
): Promise<A2AConsumerDispatch> {
  const consumer = await createA2AConsumer({
    agentUrl: input.agentUrl,
    ...(input.bearerToken === undefined ? {} : { bearerToken: input.bearerToken }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.preferredTransports === undefined
      ? {}
      : { preferredTransports: input.preferredTransports }),
  });
  return await consumer.dispatchMessage(input);
}

export function createA2AConsumerResponder(
  options: A2AConsumerResponderOptions,
): AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse> {
  let consumerPromise: Promise<A2AConsumer> | undefined;
  const getConsumer = (): Promise<A2AConsumer> => {
    consumerPromise ??= createA2AConsumer(options);
    return consumerPromise;
  };
  return {
    async respond(request, stream): Promise<AgentResponse> {
      const consumer = await getConsumer();
      const idempotencyKey = options.idempotencyKeyForRequest?.(request);
      const response = await consumer.sendMessage({
        text: request.text,
        contextId: request.conversationId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        signal: request.abortSignal,
        stream: options.streamRemote === true,
      });
      if (response.text !== undefined) {
        await stream.append(response.text);
      }
      return response;
    },
  };
}

function buildSendMessageRequest(input: A2AConsumerSendMessageInput): SendMessageRequest {
  const idempotencyKey = normalizeConsumerIdempotencyKey(input.idempotencyKey);
  const message = input.message ?? textMessage({
    text: requireText(input.text),
    contextId: input.contextId ?? "",
    taskId: input.taskId ?? "",
    ...(idempotencyKey === undefined ? {} : { messageId: stableA2AMessageId(idempotencyKey) }),
  });
  const metadata = { ...(input.metadata ?? {}) };
  if (idempotencyKey !== undefined) {
    if (Object.prototype.hasOwnProperty.call(metadata, A2A_IDEMPOTENCY_METADATA_KEY)) {
      throw new A2AConsumerError(
        "invalid_idempotency_key",
        `A2A request metadata key ${A2A_IDEMPOTENCY_METADATA_KEY} is reserved; pass idempotencyKey instead.`,
      );
    }
    metadata[A2A_IDEMPOTENCY_METADATA_KEY] = a2aIdempotencyEnvelope(idempotencyKey);
  }
  return {
    tenant: "",
    message,
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: normalizeHistoryLength(input.historyLength),
      returnImmediately: input.returnImmediately === true,
    },
    metadata,
  };
}

function cloneDispatchRequest(request: SendMessageRequest): SendMessageRequest {
  try {
    return structuredClone(request);
  } catch (error) {
    throw new A2AConsumerError(
      "send_failed",
      "A2A dispatch payload must be structured-cloneable so it can be observed safely.",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

function projectSendMessageRequest(
  request: SendMessageRequest,
  returnImmediately: boolean,
): SendMessageRequest {
  if (request.configuration === undefined) {
    throw new A2AConsumerError(
      "send_failed",
      "A2A dispatch request is missing its response projection configuration.",
    );
  }
  return {
    ...request,
    configuration: {
      ...request.configuration,
      returnImmediately,
    },
  };
}

function textMessage(input: {
  readonly text: string;
  readonly contextId: string;
  readonly taskId: string;
  readonly messageId?: string;
}): Message {
  return {
    messageId: input.messageId ?? randomUUID(),
    contextId: input.contextId,
    taskId: input.taskId,
    role: Role.ROLE_USER,
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

function requireText(text: string | undefined): string {
  const normalized = text?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new A2AConsumerError("send_failed", "A2A consumer requires non-empty text.");
  }
  return normalized;
}

function responseFromResult(
  result: SendMessageResult,
  context: {
    readonly agentUrl: string;
    readonly protocolVersion: string;
    readonly allowPending: boolean;
    readonly allowCanceled?: boolean;
    readonly allowTerminalFailures?: boolean;
    readonly allowEmptyResponse?: boolean;
  },
): A2AConsumerResponse {
  if (isTask(result)) {
    const failure = context.allowTerminalFailures === true
      ? undefined
      : failureForTask(result, context.allowCanceled === true);
    if (failure !== undefined) {
      throw failure;
    }
    const text = textFromTask(result);
    if (
      text === undefined
      && context.allowEmptyResponse !== true
      && !context.allowPending
      && result.status?.state === TaskState.TASK_STATE_COMPLETED
    ) {
      throw new A2AConsumerError(
        "empty_a2a_response",
        "Remote A2A task completed without text output.",
        { taskId: result.id },
      );
    }
    return {
      ...(text === undefined ? {} : { text }),
      metadata: {
        a2a: {
          remoteAgentUrl: context.agentUrl,
          protocolVersion: context.protocolVersion,
          taskId: result.id,
          contextId: result.contextId,
          ...(result.status?.state === undefined ? {} : { state: TaskState[result.status.state] }),
        },
      },
    };
  }

  const text = textFromMessage(result);
  if (text === undefined && context.allowEmptyResponse !== true) {
    throw new A2AConsumerError(
      "empty_a2a_response",
      "Remote A2A message did not contain text output.",
      { messageId: result.messageId },
    );
  }
  return {
    ...(text === undefined ? {} : { text }),
    metadata: {
      a2a: {
        remoteAgentUrl: context.agentUrl,
        protocolVersion: context.protocolVersion,
        messageId: result.messageId,
        contextId: result.contextId,
        taskId: result.taskId,
      },
    },
  };
}

function textFromTask(task: Task): string | undefined {
  return textFromMessage(task.status?.message) ?? textFromArtifacts(task);
}

function textFromArtifacts(task: Task): string | undefined {
  const texts = task.artifacts.flatMap((artifact) => textFromParts(artifact.parts));
  return joinedText(texts);
}

function textFromMessage(message: Message | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  return joinedText(textFromParts(message.parts));
}

function textFromParts(parts: readonly Part[]): string[] {
  return parts.flatMap((part) => {
    if (part.content?.$case === "text") {
      const text = part.content.value.trim();
      return text.length === 0 ? [] : [text];
    }
    return [];
  });
}

function joinedText(texts: readonly string[]): string | undefined {
  if (texts.length === 0) {
    return undefined;
  }
  const text = texts.join("\n").trim();
  return text.length === 0 ? undefined : text;
}

function failureForTask(task: Task, allowCanceled: boolean): A2AConsumerError | undefined {
  const state = task.status?.state;
  const text = textFromMessage(task.status?.message);
  if (state === TaskState.TASK_STATE_FAILED) {
    return new A2AConsumerError("remote_failed", text ?? "Remote A2A task failed.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_CANCELED && !allowCanceled) {
    return new A2AConsumerError("remote_canceled", text ?? "Remote A2A task was canceled.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_REJECTED) {
    return new A2AConsumerError("remote_rejected", text ?? "Remote A2A task was rejected.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    return new A2AConsumerError("remote_auth_required", text ?? "Remote A2A task requires authentication.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    return new A2AConsumerError("remote_input_required", text ?? "Remote A2A task requires input.", { taskId: task.id });
  }
  return undefined;
}

class A2AConsumerDispatchHandle implements A2AConsumerDispatch {
  private currentResponse: A2AConsumerResponse;
  private readonly observe: (
    options: A2AConsumerDispatchObservationOptions | undefined,
  ) => Promise<A2AConsumerResponse>;
  private readonly cancelTask: (
    taskId: string,
    signal: AbortSignal | undefined,
  ) => Promise<A2AConsumerResponse>;

  constructor(input: {
    readonly current: A2AConsumerResponse;
    readonly observe: (
      options: A2AConsumerDispatchObservationOptions | undefined,
    ) => Promise<A2AConsumerResponse>;
    readonly cancel: (
      taskId: string,
      signal: AbortSignal | undefined,
    ) => Promise<A2AConsumerResponse>;
  }) {
    this.currentResponse = input.current;
    this.observe = input.observe;
    this.cancelTask = input.cancel;
  }

  get current(): A2AConsumerResponse {
    return this.currentResponse;
  }

  async observeTerminal(
    options?: A2AConsumerDispatchObservationOptions,
  ): Promise<A2AConsumerTerminalOutcome> {
    const currentOutcome = terminalOutcomeFromResponse(this.currentResponse);
    if (currentOutcome !== undefined) {
      return currentOutcome;
    }
    const response = await this.observe(options);
    this.currentResponse = response;
    return requireTerminalOutcome(response);
  }

  async cancel(
    options?: A2AConsumerDispatchCancelOptions,
  ): Promise<A2AConsumerTerminalOutcome> {
    const currentOutcome = terminalOutcomeFromResponse(this.currentResponse);
    if (currentOutcome !== undefined) {
      return currentOutcome;
    }
    const taskId = this.currentResponse.metadata.a2a.taskId;
    if (taskId === undefined || taskId.length === 0) {
      throw new A2AConsumerError(
        "send_failed",
        "The admitted A2A dispatch has no task id and cannot be canceled.",
      );
    }
    const response = await this.cancelTask(taskId, options?.signal);
    this.currentResponse = response;
    const canceledOutcome = terminalOutcomeFromResponse(response);
    if (canceledOutcome !== undefined) {
      return canceledOutcome;
    }
    return await this.observeTerminal(
      options?.signal === undefined ? undefined : { signal: options.signal },
    );
  }
}

function terminalOutcomeFromResponse(
  response: A2AConsumerResponse,
): A2AConsumerTerminalOutcome | undefined {
  const state = response.metadata.a2a.state;
  if (state === undefined) {
    return response.metadata.a2a.messageId === undefined
      ? undefined
      : { status: "completed", response };
  }
  if (state === "TASK_STATE_COMPLETED") {
    return { status: "completed", response };
  }
  const terminalFailure = terminalFailureForState(state);
  if (terminalFailure === undefined) {
    return undefined;
  }
  return {
    status: terminalFailure.status,
    response,
    error: new A2AConsumerError(
      terminalFailure.code,
      response.text ?? terminalFailure.message,
      {
        ...(response.metadata.a2a.taskId === undefined
          ? {}
          : { taskId: response.metadata.a2a.taskId }),
        state,
      },
    ),
  };
}

function requireTerminalOutcome(response: A2AConsumerResponse): A2AConsumerTerminalOutcome {
  const outcome = terminalOutcomeFromResponse(response);
  if (outcome !== undefined) {
    return outcome;
  }
  throw new A2AConsumerError(
    "send_failed",
    "A2A terminal observation returned a non-terminal response.",
    {
      ...(response.metadata.a2a.taskId === undefined
        ? {}
        : { taskId: response.metadata.a2a.taskId }),
      ...(response.metadata.a2a.state === undefined
        ? {}
        : { state: response.metadata.a2a.state }),
    },
  );
}

function terminalFailureForState(state: string): {
  readonly status: "failed" | "canceled" | "rejected" | "auth_required" | "input_required";
  readonly code: "remote_failed" | "remote_canceled" | "remote_rejected" | "remote_auth_required" | "remote_input_required";
  readonly message: string;
} | undefined {
  if (state === "TASK_STATE_FAILED") {
    return { status: "failed", code: "remote_failed", message: "Remote A2A task failed." };
  }
  if (state === "TASK_STATE_CANCELED") {
    return { status: "canceled", code: "remote_canceled", message: "Remote A2A task was canceled." };
  }
  if (state === "TASK_STATE_REJECTED") {
    return { status: "rejected", code: "remote_rejected", message: "Remote A2A task was rejected." };
  }
  if (state === "TASK_STATE_AUTH_REQUIRED") {
    return { status: "auth_required", code: "remote_auth_required", message: "Remote A2A task requires authentication." };
  }
  if (state === "TASK_STATE_INPUT_REQUIRED") {
    return { status: "input_required", code: "remote_input_required", message: "Remote A2A task requires input." };
  }
  return undefined;
}

function resultFromStreamEvent(event: StreamResponse): SendMessageResult | undefined {
  if (event.payload?.$case === "message" || event.payload?.$case === "task") {
    return event.payload.value;
  }
  if (event.payload?.$case === "statusUpdate") {
    return {
      id: event.payload.value.taskId,
      contextId: event.payload.value.contextId,
      status: event.payload.value.status,
      artifacts: [],
      history: [],
      metadata: {},
    };
  }
  if (event.payload?.$case === "artifactUpdate") {
    return {
      id: event.payload.value.taskId,
      contextId: event.payload.value.contextId,
      status: undefined,
      artifacts: event.payload.value.artifact === undefined ? [] : [event.payload.value.artifact],
      history: [],
      metadata: {},
    };
  }
  return undefined;
}

function isTask(result: SendMessageResult): result is Task {
  return "status" in result;
}

function normalizeConsumerError(
  error: unknown,
  context: {
    readonly agentUrl?: string;
    readonly timeoutContext?: TimeoutSignalContext;
  } = {},
): A2AConsumerError {
  if (context.timeoutContext?.timedOut() === true) {
    const timeoutMs = context.timeoutContext.timeoutMs;
    return new A2AConsumerError("timeout", timeoutMessage(timeoutMs), {
      timeoutMs,
      ...(context.agentUrl === undefined ? {} : { agentUrl: context.agentUrl }),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (error instanceof A2AConsumerError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  const idempotencyFailure = classifyA2AIdempotencyTransportError(reason);
  if (idempotencyFailure === "capacity_exhausted") {
    return new A2AConsumerError(
      "idempotency_capacity_exhausted",
      "The A2A provider's durable idempotency admission capacity is exhausted; automatic execution was refused.",
      { reason },
    );
  }
  if (idempotencyFailure === "conflict") {
    return new A2AConsumerError(
      "idempotency_conflict",
      "The A2A idempotency key is already bound to a different canonical request.",
      { reason },
    );
  }
  if (idempotencyFailure === "in_doubt") {
    return new A2AConsumerError(
      "idempotency_in_doubt",
      "The A2A provider has a non-terminal durable admission from a prior process and refuses automatic re-execution.",
      { reason },
    );
  }
  if (idempotencyFailure === "result_expired") {
    return new A2AConsumerError(
      "idempotency_result_expired",
      "The A2A provider compacted the terminal result after retention; the logical key remains bound and was not re-executed.",
      { reason },
    );
  }
  if (idempotencyFailure === "unsupported") {
    return new A2AConsumerError(
      "idempotency_unsupported",
      "The A2A provider refused the reserved key envelope because durable idempotency is not configured.",
      { reason },
    );
  }
  if (idempotencyFailure === "invalid_key") {
    return new A2AConsumerError("invalid_idempotency_key", "The A2A idempotency key was rejected by the provider.", { reason });
  }
  if (/\b(401|403|UNAUTHENTICATED|Unauthorized|auth)/iu.test(reason)) {
    return new A2AConsumerError("remote_auth_required", "Remote A2A agent requires authentication.", { reason });
  }
  return new A2AConsumerError("send_failed", "A2A message send failed.", { reason });
}

function normalizeConsumerIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return a2aIdempotencyEnvelope(value).key;
  } catch {
    throw new A2AConsumerError(
      "invalid_idempotency_key",
      "A2A idempotencyKey must be 1-200 ASCII letters, digits, or . _ : @ - and start with a letter or digit.",
      { field: "idempotencyKey" },
    );
  }
}

function normalizeHistoryLength(value: number | undefined): number {
  const historyLength = value ?? 10;
  if (!Number.isSafeInteger(historyLength) || historyLength < 0) {
    throw new A2AConsumerError(
      "send_failed",
      "A2A historyLength must be a non-negative safe integer.",
      { field: "historyLength" },
    );
  }
  return historyLength;
}

function requestOptionsFor(
  input: A2AConsumerSendMessageInput,
  signal: AbortSignal | undefined,
): RequestOptions | undefined {
  return requestOptionsForIdempotency(input.idempotencyKey !== undefined, signal);
}

function requestOptionsForIdempotency(
  keyed: boolean,
  signal: AbortSignal | undefined,
): RequestOptions | undefined {
  const serviceParameters = !keyed
    ? undefined
    : ServiceParameters.create(withA2AExtensions(A2A_IDEMPOTENCY_EXTENSION_URI));
  if (signal === undefined && serviceParameters === undefined) {
    return undefined;
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(serviceParameters === undefined ? {} : { serviceParameters }),
  };
}

function assertIdempotencySupported(card: AgentCard): void {
  const extensions = card.capabilities?.extensions;
  const extension = Array.isArray(extensions)
    ? extensions.find((candidate) =>
        isRecord(candidate) && candidate.uri === A2A_IDEMPOTENCY_EXTENSION_URI)
    : undefined;
  if (
    extension?.params?.schemaVersion !== A2A_IDEMPOTENCY_SCHEMA_VERSION
    || extension.params.metadataKey !== A2A_IDEMPOTENCY_METADATA_KEY
  ) {
    throw new A2AConsumerError(
      "idempotency_unsupported",
      "Remote A2A Agent Card does not advertise the mono-agent logical dispatch idempotency extension; refusing a keyed send.",
      { extensionUri: A2A_IDEMPOTENCY_EXTENSION_URI },
    );
  }
}

function assertAgentCard(card: unknown, agentUrl: string): asserts card is AgentCard {
  if (!isRecord(card) || typeof card.name !== "string" || !Array.isArray(card.supportedInterfaces)) {
    throw new A2AConsumerError("invalid_agent_card", "A2A discovery returned an invalid Agent Card.", {
      agentUrl,
    });
  }
}

function agentCardUrlFor(agentUrl: string): string {
  const parsed = new URL(agentUrl);
  if (parsed.pathname.endsWith("/.well-known/agent-card.json")) {
    return parsed.toString();
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/.well-known/agent-card.json`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function bearerFetch(fetchImpl: typeof fetch, bearerToken: string | undefined): typeof fetch {
  const token = bearerToken?.trim();
  if (token === undefined || token.length === 0) {
    return fetchImpl;
  }
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return await fetchImpl(input, {
      ...init,
      headers,
    });
  };
}

interface TimeoutSignalContext {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  timedOut(): boolean;
  cleanup(): void;
}

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): TimeoutSignalContext {
  if (timeoutMs === undefined) {
    return {
      signal,
      timeoutMs,
      timedOut: () => false,
      cleanup: () => undefined,
    };
  }
  const controller = new AbortController();
  let didTimeOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timeout = undefined;
    didTimeOut = true;
    controller.abort(new Error(`A2A request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const clear = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const abortFromInput = (): void => {
    clear();
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) {
    abortFromInput();
  } else {
    signal?.addEventListener("abort", abortFromInput, { once: true });
  }
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clear();
      signal?.removeEventListener("abort", abortFromInput);
    },
  };
}

function timeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? "A2A request timed out."
    : `A2A request timed out after ${timeoutMs}ms.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

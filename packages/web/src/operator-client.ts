import {
  parseAgentStreamFrame,
  type AgentLiveInputSettlement,
  type AgentLiveInputUnavailableReason,
  type AgentAttachment,
  type AgentStreamWireFrame,
  type ChannelAskAnswer,
  type ChannelAskSnapshot,
  type ChannelAskSubmissionResult,
} from "@mono-agent/agent-contracts";

import type { WebModelOption } from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import { isTrustedOperatorBaseUrl } from "./discovery.js";

const OPERATOR_WIRE_SCHEMA = 1;
const MAX_INFO_BODY_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_NDJSON_FRAME_BYTES = 8 * 1024 * 1024;
const CANCEL_TIMEOUT_MS = 2_000;
const HISTORY_APPEND_TIMEOUT_MS = 5_000;

export interface OperatorConnection {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export interface OperatorInfo {
  readonly schema: number;
  readonly label?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly models?: readonly string[];
  readonly modelOptions?: Readonly<Record<string, WebModelOption>>;
  readonly supportsAttachments: boolean;
  readonly supportsHistoryAppend: boolean;
  readonly supportsAskUser: boolean;
  readonly supportsLiveInput: boolean;
}

export type OperatorLiveInputResult =
  | AgentLiveInputSettlement
  | { readonly status: "unavailable"; readonly reason: AgentLiveInputUnavailableReason };

export interface OperatorLiveInputInput {
  readonly conversationId: string;
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly signal?: AbortSignal;
}

export interface OperatorTurnInput {
  readonly conversationId: string;
  readonly text: string;
  readonly attachments: readonly AgentAttachment[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly onFrame: (frame: AgentStreamWireFrame) => void | Promise<void>;
}

export interface OperatorTurnResult {
  readonly finalText?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OperatorClientOptions extends OperatorConnection {
  readonly fetchImpl?: typeof fetch;
}

export class OperatorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OperatorClientOptions) {
    if (!isTrustedOperatorBaseUrl(options.baseUrl)) {
      throw new WebConsoleError("untrusted_operator_url", "Refusing to connect to a non-loopback operator endpoint.", 400);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async info(signal?: AbortSignal): Promise<OperatorInfo> {
    const response = await this.request(`${this.baseUrl}/v1/info`, {
      headers: this.headers(false),
      ...(signal === undefined ? {} : { signal }),
    });
    let raw: unknown;
    try {
      raw = JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_info_too_large")) as unknown;
    } catch (error) {
      if (error instanceof WebConsoleError) throw error;
      throw new WebConsoleError("invalid_operator_info", "The agent returned invalid operator metadata JSON.", 502);
    }
    const body = record(raw);
    if (body === undefined || typeof body.schema !== "number") {
      throw new WebConsoleError("invalid_operator_info", "The agent returned invalid operator metadata.", 502);
    }
    if (body.schema !== OPERATOR_WIRE_SCHEMA) {
      throw new WebConsoleError("unsupported_operator_schema", `Agent operator schema ${body.schema} is not supported.`, 502);
    }
    const models = stringArray(body.models);
    const modelOptions = parseModelOptions(body.modelOptions);
    const capabilities = record(body.capabilities);
    return {
      schema: body.schema,
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
      ...(models === undefined ? {} : { models }),
      ...(modelOptions === undefined ? {} : { modelOptions }),
      supportsAttachments: capabilities?.attachments === true,
      supportsHistoryAppend: capabilities?.historyAppend === true,
      supportsAskUser: capabilities?.askUser === true,
      supportsLiveInput: capabilities?.liveInput === true,
    };
  }

  async turn(input: OperatorTurnInput): Promise<OperatorTurnResult> {
    const response = await this.request(`${this.baseUrl}/v1/turns`, {
      method: "POST",
      headers: this.headers(true),
      signal: input.signal,
      body: JSON.stringify({
        conversationId: input.conversationId,
        text: input.text,
        client: "web",
        metadata: input.metadata,
        ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
      }),
    });
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson")) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebConsoleError("invalid_operator_content_type", "The agent turn endpoint did not return NDJSON.", 502);
    }
    if (response.body === null) {
      throw new WebConsoleError("empty_operator_stream", "The agent returned an empty response stream.", 502);
    }
    try {
      for await (const line of readBoundedNdjsonLines(response.body, MAX_NDJSON_FRAME_BYTES)) {
        if (line.trim().length === 0) continue;
        const frame = parseAgentStreamFrame(line);
        if (frame.kind === "finish") {
          return {
            ...(frame.finalText === undefined ? {} : { finalText: frame.finalText }),
            ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
          };
        }
        if (frame.kind === "error") {
          const error = new WebConsoleError(
            frame.code ?? (frame.cancelled === true ? "cancelled" : "agent_error"),
            frame.message,
            frame.cancelled === true ? 409 : 502,
          ) as WebConsoleError & { cancelled?: boolean };
          error.cancelled = frame.cancelled === true;
          throw error;
        }
        await input.onFrame(frame);
      }
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
    throw new WebConsoleError("incomplete_operator_stream", "The agent stream ended without a terminal frame.", 502);
  }

  async cancel(conversationId: string): Promise<void> {
    await this.request(`${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/cancel`, {
      method: "POST",
      headers: this.headers(false),
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    }).then(async (response) => {
      await response.body?.cancel().catch(() => undefined);
    });
  }

  async liveInput(input: OperatorLiveInputInput): Promise<OperatorLiveInputResult> {
    const response = await this.request(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(input.conversationId)}/live-input`,
      {
        method: "POST",
        headers: this.headers(true),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        body: JSON.stringify({ id: input.id, text: input.text, receivedAt: input.receivedAt }),
      },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_live_input_too_large")));
    if (body === undefined || typeof body.status !== "string") {
      throw new WebConsoleError("invalid_operator_live_input", "The agent returned an invalid live-input response.", 502);
    }
    if (body.status === "applied" && typeof body.runId === "string") {
      return { status: "applied", runId: body.runId };
    }
    if (body.status === "discarded" && body.reason === "cancelled") {
      return { status: "discarded", reason: "cancelled" };
    }
    if (
      body.status === "requeue"
      && (body.reason === "unsupported" || body.reason === "closed" || body.reason === "failed")
    ) {
      return { status: "requeue", reason: body.reason };
    }
    if (
      body.status === "unavailable"
      && (body.reason === "inactive" || body.reason === "unsupported" || body.reason === "too_large" || body.reason === "full" || body.reason === "invalid")
    ) {
      return { status: "unavailable", reason: body.reason };
    }
    throw new WebConsoleError("invalid_operator_live_input", "The agent returned an invalid live-input settlement.", 502);
  }

  async recordVerbatim(conversationId: string, text: string, idempotencyKey: string): Promise<void> {
    await this.request(`${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/verbatim`, {
      method: "POST",
      headers: this.headers(true),
      signal: AbortSignal.timeout(HISTORY_APPEND_TIMEOUT_MS),
      body: JSON.stringify({ text, idempotencyKey }),
    }).then(async (response) => {
      await response.body?.cancel().catch(() => undefined);
    });
  }

  async pendingAsk(conversationId: string): Promise<ChannelAskSnapshot | undefined> {
    const response = await this.request(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/ask`,
      { headers: this.headers(false) },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_ask_too_large")));
    return body?.ask === null ? undefined : body?.ask as ChannelAskSnapshot | undefined;
  }

  async submitAsk(
    conversationId: string,
    interactionId: string,
    answers: readonly ChannelAskAnswer[],
  ): Promise<ChannelAskSubmissionResult> {
    const response = await this.request(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/ask`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ interactionId, answers }),
      },
    );
    const body = record(JSON.parse(await readBoundedBody(response, MAX_INFO_BODY_BYTES, "operator_ask_too_large")));
    if (body === undefined || typeof body.accepted !== "boolean") {
      throw new WebConsoleError("invalid_operator_ask", "The agent returned an invalid AskUser response.", 502);
    }
    return body as unknown as ChannelAskSubmissionResult;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, redirect: "error" });
    } catch (error) {
      if (init.signal?.aborted === true) throw error;
      throw new WebConsoleError("agent_unreachable", `Agent is unreachable (${errorMessage(error)}).`, 502);
    }
    if (!response.ok && !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      const detail = await readBodyPrefix(response, MAX_ERROR_BODY_BYTES).catch(() => "");
      throw new WebConsoleError(
        response.status === 401 ? "agent_unauthorized" : "agent_http_error",
        `Agent responded ${response.status}${detail.length === 0 ? "." : `: ${detail.slice(0, 300)}`}`,
        502,
      );
    }
    return response;
  }
}

async function readBoundedBody(response: Response, maxBytes: number, code: string): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new WebConsoleError(code, "Agent response exceeded its size limit.", 502);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

async function readBodyPrefix(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return `${Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")}${truncated ? "…" : ""}`;
}

async function* readBoundedNdjsonLines(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncGenerator<string> {
  const reader = body.getReader();
  let segments: Uint8Array[] = [];
  let pendingBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        const segment = value.subarray(start, index);
        if (pendingBytes + segment.byteLength > maxFrameBytes) {
          throw new WebConsoleError("operator_frame_too_large", "Agent stream frame exceeded its size limit.", 502);
        }
        yield decodeSegments(segments, segment, pendingBytes + segment.byteLength);
        segments = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const remainder = value.subarray(start);
      if (pendingBytes + remainder.byteLength > maxFrameBytes) {
        throw new WebConsoleError("operator_frame_too_large", "Agent stream frame exceeded its size limit.", 502);
      }
      if (remainder.byteLength > 0) {
        segments.push(remainder);
        pendingBytes += remainder.byteLength;
      }
    }
    if (pendingBytes > 0) yield decodeSegments(segments, undefined, pendingBytes);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function decodeSegments(segments: readonly Uint8Array[], tail: Uint8Array | undefined, total: number): string {
  const buffers = segments.map((segment) => Buffer.from(segment));
  if (tail !== undefined && tail.byteLength > 0) buffers.push(Buffer.from(tail));
  return Buffer.concat(buffers, total).toString("utf8");
}

function parseModelOptions(value: unknown): Record<string, WebModelOption> | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const result: Record<string, WebModelOption> = {};
  for (const [model, raw] of Object.entries(input)) {
    const option = record(raw);
    if (option === undefined) continue;
    const effortLevels = stringArray(option.effortLevels);
    result[model] = {
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(typeof option.reasoning === "boolean" ? { reasoning: option.reasoning } : {}),
      ...(typeof option.reasoningMode === "string" ? { reasoningMode: option.reasoningMode } : {}),
      ...(typeof option.label === "string" ? { label: option.label } : {}),
      ...(Number.isSafeInteger(option.contextWindow) && Number(option.contextWindow) > 0
        ? { contextWindow: option.contextWindow as number }
        : {}),
    };
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

import { createHash } from "node:crypto";

import type {
  ChannelAttachment,
  ChannelHost,
  ChannelInboundRequest,
  JsonObject,
  JsonValue,
  RuntimeToolCall,
  RuntimeToolResult,
  RuntimeUsage,
  TurnMessage,
} from "@mono-agent/module-sdk";
import {
  OPERATOR_LIMITS,
  OPERATOR_PROTOCOL,
  parseOperatorFrame,
  parseOperatorHealth,
  parseOperatorInfo,
  serializeOperatorFrame,
  type OperatorActivityFrame,
  type OperatorCapabilities,
  type OperatorCompletedFrame,
  type OperatorDeltaFrame,
  type OperatorErrorFrame,
  type OperatorHealth,
  type OperatorInfo,
  type OperatorMessage,
  type OperatorModel,
  type OperatorToolCall,
  type OperatorToolResult,
  type OperatorTurnRequest,
  type OperatorUsage,
} from "@mono-agent/operator";

import { HttpError } from "./errors.js";

const CORE_REPLAY_PAGE_LIMIT = 10_000;
const CORE_ASSISTANT_MESSAGE_ID_MAX_BYTES = 522;
// `OperatorMessage.text` is bounded here without changing the shared protocol.
const OPERATOR_MESSAGE_CHARACTERS = 1_048_576;

type OperatorProjectionHost = Pick<
  ChannelHost,
  | "offerLiveInput"
  | "answerAsk"
  | "readReplay"
  | "readConfig"
  | "readHealth"
  | "openConversation"
>;

export interface OperatorIdentityGrant {
  readonly agent: { readonly id: string; readonly label: string };
  readonly process: { readonly pid: number };
  readonly defaults: { readonly runtime: string; readonly model: string; readonly effort?: string };
  readonly models?: readonly OperatorModel[];
  readonly configPath: string;
  readonly projectRoot: string;
}

export interface ResolvedOperatorQuote {
  readonly conversationId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface TextProjection<T> {
  readonly frame: T;
  readonly truncated: boolean;
}

export function deriveOperatorCapabilities(
  host: OperatorProjectionHost | undefined,
): OperatorCapabilities {
  return Object.freeze({
    attachments: true,
    liveInput: host?.offerLiveInput !== undefined,
    askUser: host?.answerAsk !== undefined,
    cancellation: true,
    quotes: host?.readReplay !== undefined,
    runtimeOverrides: true,
    proactive: host?.openConversation !== undefined,
    configView: host?.readConfig !== undefined,
    replay: host?.readReplay !== undefined,
    health: true,
  });
}

export function operatorInfo(
  identity: OperatorIdentityGrant,
  startedAt: string,
  host: OperatorProjectionHost | undefined,
): OperatorInfo {
  return parseOperatorInfo({
    protocol: OPERATOR_PROTOCOL,
    agent: {
      id: identity.agent.id,
      label: identity.agent.label,
    },
    process: {
      pid: identity.process.pid,
      startedAt,
    },
    capabilities: deriveOperatorCapabilities(host),
    defaults: identity.defaults,
    ...(identity.models === undefined ? {} : { models: identity.models }),
  });
}

export async function operatorHealth(
  degradedMessage: string | undefined,
  readHealth: NonNullable<ChannelHost["readHealth"]> | undefined,
): Promise<OperatorHealth> {
  let hostHealth;
  try {
    hostHealth = await readHealth?.(new AbortController().signal);
  } catch {
    hostHealth = { status: "degraded" as const, summary: "Core health read failed." };
  }
  const status =
    degradedMessage !== undefined
    || hostHealth?.status === "degraded"
    || hostHealth?.status === "unknown"
      ? "degraded"
      : hostHealth?.status === "unhealthy"
        ? "unhealthy"
        : "healthy";
  const channelStatus = degradedMessage === undefined ? "healthy" : "degraded";
  return parseOperatorHealth({
    status,
    checkedAt: new Date().toISOString(),
    details: [
      {
        id: "channel-operator",
        status: channelStatus,
        ...(degradedMessage === undefined ? {} : { message: degradedMessage }),
      },
      ...(hostHealth === undefined
        ? []
        : [{
            id: "core",
            status: hostHealth.status === "unknown" ? "degraded" : hostHealth.status,
            ...(hostHealth.summary === undefined ? {} : { message: hostHealth.summary }),
          }]),
    ],
  });
}

export function toInboundRequest(
  identity: OperatorIdentityGrant,
  turnId: string,
  receivedAt: string,
  request: OperatorTurnRequest,
  attachments: readonly ChannelAttachment[],
  quote: ResolvedOperatorQuote | undefined,
  signal: AbortSignal,
): ChannelInboundRequest {
  const text = projectOperatorInput(request.input.text ?? "", quote);
  const metadata = {
    ...(request.metadata ?? {}),
    ...(quote === undefined
      ? {}
      : {
          operatorQuote: {
            conversationId: quote.conversationId,
            messageId: quote.messageId,
            role: quote.role,
          },
        }),
  } as JsonObject;
  return {
    requestId: turnId,
    conversationId: request.conversationId,
    sender: { id: "operator", displayName: identity.agent.label },
    text,
    attachments,
    receivedAt,
    ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    signal,
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

export async function resolveOperatorQuote(
  readReplay: NonNullable<ChannelHost["readReplay"]>,
  request: OperatorTurnRequest,
  signal: AbortSignal,
): Promise<ResolvedOperatorQuote> {
  const quote = request.input.quote!;
  if (quote.conversationId !== request.conversationId) {
    throw new HttpError(422, "foreign_quote", "Operator quotes must reference the active conversation.");
  }
  let replay: Awaited<ReturnType<typeof readReplay>>;
  try {
    replay = await readReplay({
      conversationId: request.conversationId,
      limit: CORE_REPLAY_PAGE_LIMIT,
      signal,
    });
  } catch {
    throw new HttpError(503, "replay_unavailable", "Conversation replay is temporarily unavailable.");
  }
  const entry = replay.entries.find((candidate) =>
    operatorMessageId(candidate.message.id ?? candidate.turnId) === quote.messageId);
  if (
    entry === undefined
    || (entry.message.role !== "user" && entry.message.role !== "assistant")
  ) {
    throw new HttpError(
      422,
      "quote_not_found",
      "The quoted operator message does not exist in this conversation.",
    );
  }
  const text = entry.message.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("");
  if (text.length > OPERATOR_LIMITS.quoteCharacters) {
    throw new HttpError(422, "quote_too_large", "The quoted operator message exceeds the quote bound.");
  }
  if (quote.text !== undefined && quote.text !== text) {
    throw new HttpError(
      422,
      "quote_mismatch",
      "The supplied quote text does not match conversation replay.",
    );
  }
  return Object.freeze({
    conversationId: request.conversationId,
    messageId: quote.messageId,
    role: entry.message.role,
    text,
  });
}

export function projectDeltaFrame(
  turnId: string,
  target: OperatorDeltaFrame["target"],
  text: string,
  mode?: OperatorDeltaFrame["mode"],
): TextProjection<OperatorDeltaFrame> {
  return fitTextToFrame(
    text,
    OPERATOR_LIMITS.frameBytes,
    (fittedText): OperatorDeltaFrame => ({
      type: "delta",
      turnId,
      target,
      text: fittedText,
      ...(mode === undefined ? {} : { mode }),
    }),
  );
}

export function projectActivityFrame(turnId: string, text: string): OperatorActivityFrame {
  return {
    type: "activity",
    turnId,
    text: text.slice(0, OPERATOR_LIMITS.activityCharacters),
  };
}

export function projectCompletedFrame(
  turnId: string,
  text: string,
  messageId?: string,
): OperatorCompletedFrame {
  const id = messageId === undefined ? undefined : operatorMessageId(messageId);
  const finishedAt = new Date().toISOString();
  const projection = fitTextToFrame(
    text,
    OPERATOR_MESSAGE_CHARACTERS,
    (fittedText): OperatorCompletedFrame => ({
      type: "completed",
      turnId,
      finalMessage: {
        ...(id === undefined ? {} : { id }),
        role: "assistant",
        text: fittedText,
      },
      finishedAt,
      stopReason: "completed",
    }),
  );
  return projection.truncated
    ? { ...projection.frame, stopReason: "length" }
    : projection.frame;
}

export function validateIdentityGrant(value: OperatorIdentityGrant): OperatorIdentityGrant {
  if (
    typeof value !== "object"
    || value === null
    || !validGrantText(value.agent?.id, 256)
    || !validGrantText(value.agent.label, 1_024)
    || !Number.isSafeInteger(value.process?.pid)
    || value.process.pid <= 0
    || !validGrantText(value.defaults?.runtime, 256)
    || !validGrantText(value.defaults.model, 256)
    || (value.defaults.effort !== undefined && !validGrantText(value.defaults.effort, 256))
    || (value.models !== undefined && !validGrantModels(value.models))
    || !validGrantText(value.configPath, 4_096)
    || !validGrantText(value.projectRoot, 4_096)
  ) {
    throw new TypeError("createOperatorChannel requires a valid operator.identity.v1 host grant.");
  }
  return value;
}

export function operatorTriggerKind(
  metadata: JsonObject | undefined,
): "cron" | "webhook" | undefined {
  if (metadata?.source !== "operator-proactive") return undefined;
  const kind = metadata?.triggerKind;
  return kind === "cron" || kind === "webhook" ? kind : undefined;
}

export function toChannelAttachment(
  attachment: NonNullable<OperatorTurnRequest["input"]["attachments"]>[number],
): ChannelAttachment {
  if (attachment.url === undefined || !attachment.url.startsWith("data:")) {
    throw new HttpError(
      422,
      "unsupported_attachment",
      "Operator attachments must use bounded inline data URLs.",
    );
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(attachment.url);
  if (match === null) {
    throw new HttpError(
      422,
      "unsupported_attachment",
      "Operator attachment data URL is invalid.",
    );
  }
  const encoded = match[2]!;
  const data = Buffer.from(encoded, "base64");
  if (encoded.length % 4 !== 0 || data.toString("base64") !== encoded) {
    throw new HttpError(
      422,
      "unsupported_attachment",
      "Operator attachment data URL is not canonical base64.",
    );
  }
  if (match[1] !== attachment.mediaType) {
    throw new HttpError(
      422,
      "invalid_attachment",
      "Operator attachment media type does not match its data URL.",
    );
  }
  if (data.byteLength > OPERATOR_LIMITS.requestBytes) {
    throw new HttpError(
      413,
      "attachment_too_large",
      "Operator attachment exceeds the request byte bound.",
    );
  }
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== data.byteLength) {
    throw new HttpError(
      422,
      "invalid_attachment",
      "Operator attachment size does not match its data URL.",
    );
  }
  return {
    id: attachment.id,
    kind: match[1]!.startsWith("image/")
      ? "image"
      : match[1]!.startsWith("audio/")
        ? "audio"
        : "file",
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: data.byteLength,
    data: new Uint8Array(data),
  };
}

export function toOperatorMessage(
  message: TurnMessage,
  createdAt: string,
  fallbackId?: string,
): OperatorMessage {
  const text = message.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("");
  const id = message.id ?? fallbackId;
  const attachments = message.content.flatMap((part) =>
    part.type === "attachment"
      ? [{
          id: part.attachment.id,
          name: part.attachment.name,
          mediaType: part.attachment.mediaType,
          sizeBytes: part.attachment.sizeBytes,
        }]
      : []);
  return {
    ...(id === undefined ? {} : { id: operatorMessageId(id) }),
    role: message.role === "assistant" ? "assistant" : "user",
    text,
    ...(attachments.length === 0 ? {} : { attachments }),
    createdAt: message.createdAt ?? createdAt,
  };
}

export function operatorUsage(usage: RuntimeUsage): OperatorUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
    ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
    compacted: usage.compaction?.compacted ?? false,
    sessionEvicted: usage.sessionEvicted ?? false,
  };
}

export function operatorToolCall(call: RuntimeToolCall): OperatorToolCall {
  const id = boundedToolIdentifier(call.id, "call");
  const name = boundedToolIdentifier(call.name, "tool");
  const candidate = {
    type: "tool_call",
    turnId: "projection",
    call: { id, name, input: call.input, inputOmitted: false },
  } as const;
  try {
    const frame = parseOperatorFrame(candidate);
    if (frame.type === "tool_call") return frame.call;
  } catch {
    // The runtime payload can exceed the product protocol's replay boundary.
  }
  return { id, name, inputOmitted: true };
}

export function operatorToolResult(result: RuntimeToolResult): OperatorToolResult {
  const callId = boundedToolIdentifier(result.callId, "call");
  const content = result.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : part.type === "json"
        ? { type: "json" as const, value: part.value }
        : {
            type: "text" as const,
            text: part.type === "file"
              ? "[file result omitted]"
              : "[artifact result omitted]",
          });
  const candidate = {
    type: "tool_result",
    turnId: "projection",
    result: {
      callId,
      content,
      contentOmitted: false,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    },
  } as const;
  try {
    const frame = parseOperatorFrame(candidate);
    if (frame.type === "tool_result") return frame.result;
  } catch {
    // Keep correlation and outcome visible while omitting an unsafe payload.
  }
  return {
    callId,
    contentOmitted: true,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

export function mergeOperatorUsage(
  previous: OperatorUsage | undefined,
  next: OperatorUsage,
): OperatorUsage {
  return {
    inputTokens: next.inputTokens,
    outputTokens: next.outputTokens,
    ...(next.contextWindow !== undefined
      ? { contextWindow: next.contextWindow }
      : previous?.contextWindow === undefined
        ? {}
        : { contextWindow: previous.contextWindow }),
    ...(next.contextUsed !== undefined
      ? { contextUsed: next.contextUsed }
      : previous?.contextUsed === undefined
        ? {}
        : { contextUsed: previous.contextUsed }),
    compacted: previous?.compacted === true || next.compacted,
    sessionEvicted: previous?.sessionEvicted === true || next.sessionEvicted,
  };
}

export function asConfigObject(value: JsonValue): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : { value };
}

export function errorFrame(
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

function projectOperatorInput(
  text: string,
  quote: ResolvedOperatorQuote | undefined,
): string {
  if (quote === undefined) return text;
  const quoted = JSON.stringify({
    conversationId: quote.conversationId,
    messageId: quote.messageId,
    role: quote.role,
    text: quote.text,
  });
  return text.length === 0
    ? `Quoted message (verified from conversation replay):\n${quoted}`
    : `Quoted message (verified from conversation replay):\n${quoted}\n\nUser message:\n${text}`;
}

function validGrantModels(value: unknown): value is readonly OperatorModel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) return false;
  const routes = new Set<string>();
  return value.every((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    const model = candidate as Record<string, unknown>;
    if (
      Object.keys(model).some((field) =>
        !["runtime", "id", "label", "efforts", "contextWindow"].includes(field))
    ) {
      return false;
    }
    if (!validGrantText(model.runtime, 256) || !validGrantText(model.id, 256)) return false;
    const route = `${model.runtime}\0${model.id}`;
    if (routes.has(route)) return false;
    routes.add(route);
    if (model.label !== undefined && !validGrantText(model.label, 1_024)) return false;
    if (
      model.contextWindow !== undefined
      && (!Number.isSafeInteger(model.contextWindow) || Number(model.contextWindow) < 1)
    ) {
      return false;
    }
    if (model.efforts !== undefined) {
      if (!Array.isArray(model.efforts) || model.efforts.length > 50) return false;
      const efforts = new Set<string>();
      for (const effort of model.efforts) {
        if (!validGrantText(effort, 256) || efforts.has(effort)) return false;
        efforts.add(effort);
      }
    }
    return true;
  });
}

function validGrantText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function operatorMessageId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > CORE_ASSISTANT_MESSAGE_ID_MAX_BYTES
  ) {
    throw new TypeError("channel turn result messageId is invalid");
  }
  if (
    value.length <= OPERATOR_LIMITS.identifierCharacters
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    return value;
  }
  const encoded = `message~u16:${Buffer.from(value, "utf16le").toString("base64url")}`;
  if (encoded.length > OPERATOR_LIMITS.messageIdentifierCharacters) {
    throw new TypeError("channel turn result messageId is invalid");
  }
  return encoded;
}

function boundedToolIdentifier(value: string, prefix: "call" | "tool"): string {
  return value.length > 0
    && value.trim().length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= OPERATOR_LIMITS.toolIdentifierBytes
    ? value
    : `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

function fitTextToFrame<T extends OperatorDeltaFrame | OperatorCompletedFrame>(
  text: string,
  maxCharacters: number,
  createFrame: (text: string) => T,
): TextProjection<T> {
  const emptyFrameBytes = Buffer.byteLength(serializeOperatorFrame(createFrame("")), "utf8");
  const textByteBudget = OPERATOR_LIMITS.frameBytes - emptyFrameBytes;
  const completeBytes = text.length <= maxCharacters
    ? jsonStringContentBytes(text)
    : Number.POSITIVE_INFINITY;
  if (completeBytes <= textByteBudget) {
    return { frame: createFrame(text), truncated: false };
  }

  let consumedCharacters = 0;
  let consumedBytes = 0;
  for (const character of text) {
    if (consumedCharacters + character.length > maxCharacters) break;
    const characterBytes = jsonStringCharacterBytes(character);
    if (consumedBytes + characterBytes > textByteBudget) break;
    consumedCharacters += character.length;
    consumedBytes += characterBytes;
  }
  const fitted = text.slice(0, consumedCharacters);
  const frame = createFrame(fitted);
  serializeOperatorFrame(frame);
  return { frame, truncated: fitted.length !== text.length };
}

function jsonStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function jsonStringCharacterBytes(character: string): number {
  if (character.length === 2) return 4;
  const code = character.charCodeAt(0);
  if (
    character === "\""
    || character === "\\"
    || character === "\b"
    || character === "\t"
    || character === "\n"
    || character === "\f"
    || character === "\r"
  ) {
    return 2;
  }
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return 6;
  return Buffer.byteLength(character, "utf8");
}

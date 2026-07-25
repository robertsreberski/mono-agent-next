// SPDX-License-Identifier: MIT
import {
  RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES,
  parseArtifactRef,
  parseRuntimeNativeToolDescriptor,
  type ArtifactRef,
  type ChannelCapabilities,
  type JsonObject,
  type JsonValue,
  type ModuleDiagnostic,
  type NormalizedAttachment,
  type RouteIdentity,
  type RuntimeCapabilities,
  type RuntimeCompaction,
  type RuntimeModelDescriptor,
  type RuntimeModelValidation,
  type RuntimeNativeToolDescriptor,
  type RuntimeSession,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeToolResultPart,
  type RuntimeTurnEvent,
  type RuntimeTurnResult,
  type RuntimeUsage,
  type RuntimeUsageCost,
  type TurnContentPart,
  type TurnMessage,
} from "@mono-agent/module-sdk";

import {
  assertOwnKeys,
  denseOwnDataArray,
  ownDataRecord,
  snapshotBoundedValue,
  utf8Bytes,
} from "./bounded-value.js";

export const RUNTIME_RESULT_MAX_BYTES = 64 * 1024 * 1024;
export const RUNTIME_RESULT_MAX_ITEMS = 20_000;
export const RUNTIME_RESULT_MAX_MESSAGE_PARTS = 256;
export const RUNTIME_RESULT_MAX_TOOL_RESULT_PARTS = 128;
export const RUNTIME_RESULT_MAX_JSON_DEPTH = 32;
export const RUNTIME_RESULT_MAX_JSON_ITEMS = 10_000;
export const RUNTIME_RESULT_MAX_TEXT_BYTES = 1024 * 1024;
export const RUNTIME_RESULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
export const RUNTIME_RESULT_MAX_METADATA_BYTES = 256 * 1024;
export const RUNTIME_RESULT_MAX_STRUCTURED_OUTPUT_BYTES = 4 * 1024 * 1024;
export const RUNTIME_EVENT_MAX_BYTES = 32 * 1024 * 1024;
export const RUNTIME_EVENT_STREAM_MAX_BYTES = 64 * 1024 * 1024;
export const RUNTIME_EVENT_STREAM_MAX_EVENTS = 20_000;
export const RUNTIME_MODEL_VALIDATION_MAX_BYTES = 1024 * 1024;
export const RUNTIME_MODEL_VALIDATION_MAX_ITEMS = 128;
export const RUNTIME_TOOL_CALL_MAX_BYTES = 512 * 1024;
export const RUNTIME_CAPABILITIES_MAX_BYTES = 1024;

const MAX_IDENTIFIER_BYTES = 4_096;
const MAX_MODEL_LABEL_BYTES = 256;
const MAX_MODEL_EFFORTS = 16;
const MAX_MEDIA_TYPE_BYTES = 255;
const MAX_FILE_NAME_BYTES = 255;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 16 * 1024;
const MAX_ACTIVITY_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_PATH_SEGMENTS = 64;
const RUNTIME_GRAPH_MAX_DEPTH = 64;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu;

interface FileBudget {
  fileBytes: number;
}

export interface RuntimeTurnEventBoundary {
  bytes: number;
  events: number;
  violation: Error | undefined;
}

export interface RuntimeSessionBoundaryAuthority {
  readonly conversationId: string;
  readonly route: RouteIdentity;
}

export function createRuntimeTurnEventBoundary(): RuntimeTurnEventBoundary {
  return { bytes: 0, events: 0, violation: undefined };
}

export function normalizeRuntimeTurnResult(
  value: unknown,
  authority: RuntimeSessionBoundaryAuthority,
): RuntimeTurnResult {
  const detached = runtimeSnapshot(value, "runtime turn result", RUNTIME_RESULT_MAX_BYTES);
  const input = shape(
    detached.value,
    "runtime turn result",
    ["status", "message", "structuredOutput", "usage", "session", "metadata"],
  );
  const status = oneOf(
    input.status,
    ["completed", "cancelled", "max-turns"] as const,
    "runtime turn result.status",
  );
  const files = { fileBytes: 0 };
  const message = optional(input.message, (message) =>
    turnMessage(message, files, "runtime turn result.message"));
  if (status === "completed" && message === undefined) {
    fail("runtime turn result.message", "is required for a completed result");
  }
  if (status !== "completed" && input.structuredOutput !== undefined) {
    fail("runtime turn result.structuredOutput", "is only valid for a completed result");
  }
  const structuredOutput = optional(input.structuredOutput, (output) =>
    boundedJson(
      output,
      "runtime turn result.structuredOutput",
      RUNTIME_RESULT_MAX_STRUCTURED_OUTPUT_BYTES,
    ));
  const usage = optional(input.usage, usageValue);
  const session = optional(input.session, (session) => sessionValue(session, authority));
  if (usage?.sessionEvicted === true && session !== undefined) {
    fail("runtime turn result.session", "must be absent when usage.sessionEvicted is true");
  }
  const metadata = optional(input.metadata, (metadata) =>
    boundedJsonObject(
      metadata,
      "runtime turn result.metadata",
      RUNTIME_RESULT_MAX_METADATA_BYTES,
    ));
  const common = compact({ message, usage, session, metadata });
  if (status === "completed") {
    return compact({
      status,
      ...common,
      message: message!,
      structuredOutput,
    }) as RuntimeTurnResult;
  }
  return { status, ...common } as RuntimeTurnResult;
}

export function normalizeRuntimeTurnEvent(
  value: unknown,
  boundary: RuntimeTurnEventBoundary,
  authority: RuntimeSessionBoundaryAuthority,
): RuntimeTurnEvent {
  if (boundary.violation !== undefined) {
    throw new TypeError("runtime event stream boundary was already violated", {
      cause: boundary.violation,
    });
  }
  if (boundary.events >= RUNTIME_EVENT_STREAM_MAX_EVENTS) {
    const error = new RangeError(
      `runtime event stream exceeds the ${String(RUNTIME_EVENT_STREAM_MAX_EVENTS)}-event boundary`,
    );
    boundary.violation = error;
    throw error;
  }
  try {
    const detached = runtimeSnapshot(value, "runtime turn event", RUNTIME_EVENT_MAX_BYTES);
    const event = turnEvent(detached.value, { fileBytes: 0 }, authority);
    if (boundary.bytes + detached.bytes > RUNTIME_EVENT_STREAM_MAX_BYTES) {
      throw new RangeError(
        `runtime event stream exceeds the ${String(RUNTIME_EVENT_STREAM_MAX_BYTES)}-byte cumulative boundary`,
      );
    }
    boundary.events += 1;
    boundary.bytes += detached.bytes;
    return event;
  } catch (error) {
    const violation = error instanceof Error
      ? error
      : new TypeError("runtime event stream boundary was violated");
    boundary.violation = violation;
    throw violation;
  }
}

export function assertRuntimeTurnEventBoundaryHealthy(
  boundary: RuntimeTurnEventBoundary,
): void {
  if (boundary.violation !== undefined) {
    throw new TypeError("runtime event stream boundary was violated", {
      cause: boundary.violation,
    });
  }
}

export function normalizeRuntimeToolCall(value: unknown): RuntimeToolCall {
  return toolCall(
    runtimeSnapshot(value, "runtime tool call", RUNTIME_TOOL_CALL_MAX_BYTES).value,
    "runtime tool call",
  );
}

export function normalizeRuntimeCapabilities(
  value: unknown,
  path = "runtime capabilities",
): RuntimeCapabilities {
  return runtimeCapabilities(
    runtimeSnapshot(value, path, RUNTIME_CAPABILITIES_MAX_BYTES).value,
    path,
  );
}

export function normalizeChannelCapabilities(
  value: unknown,
  path = "channel capabilities",
): ChannelCapabilities {
  const required = [
    "attachments",
    "liveInput",
    "askUser",
    "proactive",
    "runtimeControl",
    "verbatim",
    "cancellation",
  ] as const;
  const values = booleanFields(
    runtimeSnapshot(value, path, RUNTIME_CAPABILITIES_MAX_BYTES).value,
    path,
    required,
    ["approvals"] as const,
  );
  return {
    attachments: values.attachments!,
    liveInput: values.liveInput!,
    askUser: values.askUser!,
    approvals: values.approvals === true,
    proactive: values.proactive!,
    runtimeControl: values.runtimeControl!,
    verbatim: values.verbatim!,
    cancellation: values.cancellation!,
  };
}

export function normalizeRuntimeModelValidation(
  value: unknown,
  path = "runtime model validation",
): RuntimeModelValidation {
  const input = shape(
    runtimeSnapshot(value, path, RUNTIME_MODEL_VALIDATION_MAX_BYTES).value,
    path,
    ["supported", "capabilities", "nativeTools", "model", "diagnostics"],
  );
  if (typeof input.supported !== "boolean") fail(`${path}.supported`, "must be boolean");
  const capabilities = optional(input.capabilities, (capabilities) =>
    runtimeCapabilities(capabilities, `${path}.capabilities`));
  const model = optional(input.model, (model) =>
    modelDescriptor(model, `${path}.model`));
  const nativeTools = optional(input.nativeTools, (nativeTools) =>
    denseOwnDataArray(
      nativeTools,
      `${path}.nativeTools`,
      RUNTIME_MODEL_VALIDATION_MAX_ITEMS,
    ).map((descriptor, index) =>
      nativeTool(descriptor, `${path}.nativeTools[${String(index)}]`)));
  const diagnostics = optional(input.diagnostics, (diagnostics) =>
    denseOwnDataArray(
      diagnostics,
      `${path}.diagnostics`,
      RUNTIME_MODEL_VALIDATION_MAX_ITEMS,
    ).map((diagnostic, index) =>
      diagnosticValue(diagnostic, `${path}.diagnostics[${String(index)}]`)));
  return compact({
    supported: input.supported,
    capabilities,
    nativeTools,
    model,
    diagnostics,
  }) as RuntimeModelValidation;
}

function modelDescriptor(value: unknown, path: string): RuntimeModelDescriptor {
  const input = shape(value, path, ["label", "efforts", "contextWindow"]);
  const label = optional(input.label, (label) =>
    boundedText(label, `${path}.label`, MAX_MODEL_LABEL_BYTES));
  const efforts = optional(input.efforts, (efforts) => {
    const levels = denseOwnDataArray(efforts, `${path}.efforts`, MAX_MODEL_EFFORTS)
      .map((level, index) =>
        boundedText(level, `${path}.efforts[${String(index)}]`, MAX_IDENTIFIER_BYTES));
    if (levels.length === 0) fail(`${path}.efforts`, "must not be empty when advertised");
    if (new Set(levels).size !== levels.length) fail(`${path}.efforts`, "must not repeat a level");
    return levels;
  });
  const contextWindow = optional(input.contextWindow, (tokens) => {
    const window = nonNegativeInteger(tokens, `${path}.contextWindow`);
    if (window === 0) fail(`${path}.contextWindow`, "must be positive when advertised");
    return window;
  });
  return compact({ label, efforts, contextWindow }) as RuntimeModelDescriptor;
}

/** Descriptor-safe parser for host health, lifecycle, and module diagnostics. */
export function normalizeModuleDiagnostic(
  value: unknown,
  path = "module diagnostic",
): ModuleDiagnostic {
  return diagnosticValue(
    runtimeSnapshot(value, path, RUNTIME_MODEL_VALIDATION_MAX_BYTES).value,
    path,
  );
}

function turnEvent(
  value: unknown,
  files: FileBudget,
  authority: RuntimeSessionBoundaryAuthority,
): RuntimeTurnEvent {
  const path = "runtime turn event";
  const input = ownDataRecord(value, path);
  const type = oneOf(
    input.type,
    [
      "text-delta",
      "thinking-delta",
      "activity",
      "tool-call",
      "tool-result",
      "usage",
      "diagnostic",
      "session",
      "compaction",
    ] as const,
    `${path}.type`,
  );
  if (type === "text-delta" || type === "thinking-delta") {
    assertOwnKeys(input, ["type", "delta"], path);
    return { type, delta: boundedText(input.delta, `${path}.delta`, RUNTIME_RESULT_MAX_TEXT_BYTES, true) };
  }
  if (type === "activity") {
    assertOwnKeys(input, ["type", "text"], path);
    return { type, text: boundedText(input.text, `${path}.text`, MAX_ACTIVITY_BYTES) };
  }
  const key = type === "tool-call" ? "call"
    : type === "tool-result" ? "result"
      : type === "usage" ? "usage"
        : type === "diagnostic" ? "diagnostic"
          : type === "session" ? "session"
            : "compaction";
  assertOwnKeys(input, ["type", key], path);
  switch (type) {
    case "tool-call": return { type, call: toolCall(input.call, `${path}.call`) };
    case "tool-result": return { type, result: toolResult(input.result, files, `${path}.result`) };
    case "usage": return { type, usage: usageValue(input.usage, `${path}.usage`) };
    case "diagnostic": return { type, diagnostic: diagnosticValue(input.diagnostic, `${path}.diagnostic`) };
    case "session": return { type, session: sessionValue(input.session, authority, `${path}.session`) };
    case "compaction": return { type, compaction: compactionValue(input.compaction, `${path}.compaction`) };
  }
}

function runtimeCapabilities(value: unknown, path: string): RuntimeCapabilities {
  const required = [
    "tools",
    "mcp",
    "attachments",
    "approvals",
    "structuredOutput",
    "sandbox",
    "sessions",
  ] as const;
  const values = booleanFields(
    value,
    path,
    required,
    ["artifactResults", "liveInput", "maxTurns", "maxOutputTokens"] as const,
  );
  return compact({
    tools: values.tools!,
    mcp: values.mcp!,
    attachments: values.attachments!,
    approvals: values.approvals!,
    structuredOutput: values.structuredOutput!,
    sandbox: values.sandbox!,
    sessions: values.sessions!,
    artifactResults: values.artifactResults === true,
    liveInput: values.liveInput,
    maxTurns: values.maxTurns === true,
    maxOutputTokens: values.maxOutputTokens === true,
  }) as RuntimeCapabilities;
}

function booleanFields<
  const R extends readonly string[],
  const O extends readonly string[],
>(
  value: unknown,
  path: string,
  required: R,
  optional: O,
): Record<R[number], boolean> & Partial<Record<O[number], boolean>> {
  const input = shape(value, path, [...required, ...optional]);
  const output: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
  for (const key of required) {
    if (!Object.hasOwn(input, key)) fail(`${path}.${key}`, "is required");
    if (typeof input[key] !== "boolean") fail(`${path}.${key}`, "must be boolean");
    output[key] = input[key];
  }
  for (const key of optional) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      fail(`${path}.${key}`, "must be boolean when present");
    }
    if (typeof input[key] === "boolean") output[key] = input[key];
  }
  return output as Record<R[number], boolean> & Partial<Record<O[number], boolean>>;
}

function diagnosticValue(value: unknown, path: string): ModuleDiagnostic {
  const input = shape(value, path, ["code", "severity", "message", "path", "hint"]);
  const diagnosticPath = optional(input.path, (segments) =>
    denseOwnDataArray(segments, `${path}.path`, MAX_DIAGNOSTIC_PATH_SEGMENTS)
      .map((segment, index) => {
        if (typeof segment === "string") {
          return boundedText(segment, `${path}.path[${String(index)}]`, MAX_IDENTIFIER_BYTES);
        }
        if (typeof segment === "number" && Number.isSafeInteger(segment)) return segment;
        return fail(`${path}.path[${String(index)}]`, "must be a string or safe integer");
      }));
  return compact({
    code: boundedText(input.code, `${path}.code`, MAX_IDENTIFIER_BYTES),
    severity: oneOf(input.severity, ["info", "warning", "error"] as const, `${path}.severity`),
    message: boundedText(input.message, `${path}.message`, MAX_DIAGNOSTIC_MESSAGE_BYTES),
    path: diagnosticPath,
    hint: optional(input.hint, (hint) =>
      boundedText(hint, `${path}.hint`, MAX_DIAGNOSTIC_MESSAGE_BYTES, true)),
  }) as ModuleDiagnostic;
}

function turnMessage(value: unknown, files: FileBudget, path: string): TurnMessage {
  const input = shape(value, path, ["id", "role", "content", "name", "createdAt"]);
  const content = denseOwnDataArray(
    input.content,
    `${path}.content`,
    RUNTIME_RESULT_MAX_MESSAGE_PARTS,
  ).map((part, index) => contentPart(part, files, `${path}.content[${String(index)}]`));
  return compact({
    id: optional(input.id, (id) => boundedText(id, `${path}.id`, MAX_IDENTIFIER_BYTES, true)),
    role: oneOf(input.role, ["system", "user", "assistant", "tool"] as const, `${path}.role`),
    content,
    name: optional(input.name, (name) =>
      boundedText(name, `${path}.name`, MAX_IDENTIFIER_BYTES, true)),
    createdAt: optional(input.createdAt, (createdAt) =>
      boundedText(createdAt, `${path}.createdAt`, MAX_IDENTIFIER_BYTES, true)),
  }) as TurnMessage;
}

function contentPart(value: unknown, files: FileBudget, path: string): TurnContentPart {
  const input = ownDataRecord(value, path);
  if (input.type === "text") {
    assertOwnKeys(input, ["type", "text"], path);
    return { type: "text", text: boundedText(input.text, `${path}.text`, RUNTIME_RESULT_MAX_TEXT_BYTES) };
  }
  if (input.type === "image" || input.type === "file") {
    const type = input.type;
    assertOwnKeys(input, ["type", "mediaType", "data", "name"], path);
    if (type === "file" && input.name === undefined) fail(`${path}.name`, "is required for a file part");
    const name = optional(input.name, (name) => displayFileName(name, `${path}.name`));
    const common = {
      mediaType: mediaType(input.mediaType, `${path}.mediaType`),
      data: fileData(input.data, `${path}.data`, files),
    };
    return type === "file"
      ? { type, ...common, name: name! }
      : compact({ type, ...common, name }) as TurnContentPart;
  }
  if (input.type === "attachment") {
    assertOwnKeys(input, ["type", "attachment"], path);
    return { type: "attachment", attachment: attachment(input.attachment, files, `${path}.attachment`) };
  }
  if (input.type === "tool-call") {
    assertOwnKeys(input, ["type", "call"], path);
    return { type: "tool-call", call: toolCall(input.call, `${path}.call`) };
  }
  if (input.type === "tool-result") {
    assertOwnKeys(input, ["type", "result"], path);
    return { type: "tool-result", result: toolResult(input.result, files, `${path}.result`) };
  }
  return fail(`${path}.type`, "is not a supported turn content type");
}

function attachment(value: unknown, files: FileBudget, path: string): NormalizedAttachment {
  const input = shape(value, path, ["id", "kind", "name", "mediaType", "sizeBytes", "data"]);
  const data = fileData(input.data, `${path}.data`, files, true);
  const sizeBytes = nonNegativeInteger(input.sizeBytes, `${path}.sizeBytes`);
  if (sizeBytes !== data.byteLength) fail(`${path}.sizeBytes`, "must equal the attachment byte length");
  return {
    id: boundedText(input.id, `${path}.id`, 512),
    kind: oneOf(input.kind, ["image", "audio", "file"] as const, `${path}.kind`),
    name: displayFileName(input.name, `${path}.name`),
    mediaType: mediaType(input.mediaType, `${path}.mediaType`),
    sizeBytes,
    data,
  };
}

function toolCall(value: unknown, path: string): RuntimeToolCall {
  const input = shape(value, path, ["id", "name", "input"]);
  return {
    id: boundedText(input.id, `${path}.id`, MAX_IDENTIFIER_BYTES),
    name: boundedText(input.name, `${path}.name`, MAX_IDENTIFIER_BYTES),
    input: boundedJson(input.input, `${path}.input`, RUNTIME_RESULT_MAX_METADATA_BYTES),
  };
}

function toolResult(value: unknown, files: FileBudget, path: string): RuntimeToolResult {
  const input = shape(value, path, ["callId", "content", "isError"]);
  const content = denseOwnDataArray(
    input.content,
    `${path}.content`,
    RUNTIME_RESULT_MAX_TOOL_RESULT_PARTS,
  ).map((part, index) => toolResultPart(part, files, `${path}.content[${String(index)}]`));
  if (input.isError !== undefined && typeof input.isError !== "boolean") {
    fail(`${path}.isError`, "must be boolean when present");
  }
  return compact({
    callId: boundedText(input.callId, `${path}.callId`, MAX_IDENTIFIER_BYTES),
    content,
    isError: input.isError,
  }) as RuntimeToolResult;
}

function toolResultPart(
  value: unknown,
  files: FileBudget,
  path: string,
): RuntimeToolResultPart {
  const input = ownDataRecord(value, path);
  if (input.type === "text") {
    assertOwnKeys(input, ["type", "text"], path);
    return { type: "text", text: boundedText(input.text, `${path}.text`, RUNTIME_RESULT_MAX_TEXT_BYTES) };
  }
  if (input.type === "json") {
    assertOwnKeys(input, ["type", "value"], path);
    if (!Object.hasOwn(input, "value")) fail(`${path}.value`, "is required");
    return {
      type: "json",
      value: boundedJson(input.value, `${path}.value`, RUNTIME_RESULT_MAX_STRUCTURED_OUTPUT_BYTES),
    };
  }
  if (input.type === "file") {
    assertOwnKeys(input, ["type", "mediaType", "data", "name"], path);
    const name = optional(input.name, (name) => displayFileName(name, `${path}.name`));
    return compact({
      type: "file",
      mediaType: mediaType(input.mediaType, `${path}.mediaType`),
      data: fileData(input.data, `${path}.data`, files),
      name,
    }) as RuntimeToolResultPart;
  }
  if (input.type === "artifact") {
    assertOwnKeys(input, ["type", "ref", "preview"], path);
    let ref: ArtifactRef;
    try {
      ref = parseArtifactRef(input.ref);
    } catch (error) {
      throw new TypeError(`${path}.ref is invalid`, { cause: error });
    }
    const preview = optional(input.preview, (preview) =>
      boundedText(
        preview,
        `${path}.preview`,
        RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES,
        true,
      ));
    return compact({ type: "artifact", ref, preview }) as RuntimeToolResultPart;
  }
  return fail(`${path}.type`, "is not a supported tool-result content type");
}

function sessionValue(
  value: unknown,
  authority: RuntimeSessionBoundaryAuthority,
  path = "runtime turn result.session",
): RuntimeSession {
  const input = shape(
    value,
    path,
    ["id", "conversationId", "route", "createdAt", "expiresAt", "metadata"],
  );
  for (const key of ["id", "conversationId", "route"] as const) {
    if (!Object.hasOwn(input, key)) fail(`${path}.${key}`, "is required");
  }
  const conversationId = boundedText(
    input.conversationId,
    `${path}.conversationId`,
    MAX_IDENTIFIER_BYTES,
  );
  const route = routeValue(input.route, `${path}.route`);
  if (conversationId !== authority.conversationId) {
    fail(`${path}.conversationId`, "does not match the active conversation");
  }
  if (
    route.runtimeInstanceId !== authority.route.runtimeInstanceId
    || route.model !== authority.route.model
  ) {
    fail(`${path}.route`, "does not match the active runtime route");
  }
  const createdAt = optional(input.createdAt, (createdAt) =>
    canonicalTimestamp(createdAt, `${path}.createdAt`));
  const expiresAt = optional(input.expiresAt, (expiresAt) =>
    canonicalTimestamp(expiresAt, `${path}.expiresAt`));
  if (
    createdAt !== undefined
    && expiresAt !== undefined
    && Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    fail(`${path}.expiresAt`, "must be later than createdAt");
  }
  const metadata = optional(input.metadata, (metadata) =>
    boundedJsonObject(metadata, `${path}.metadata`, RUNTIME_RESULT_MAX_METADATA_BYTES));
  return compact({
    id: boundedText(input.id, `${path}.id`, 512),
    conversationId,
    route,
    createdAt,
    expiresAt,
    metadata,
  }) as RuntimeSession;
}

function routeValue(
  value: unknown,
  path: string,
): { readonly runtimeInstanceId: string; readonly model: string } {
  const input = shape(value, path, ["runtimeInstanceId", "model"]);
  return {
    runtimeInstanceId: boundedText(
      input.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
      MAX_IDENTIFIER_BYTES,
    ),
    model: boundedText(input.model, `${path}.model`, MAX_IDENTIFIER_BYTES),
  };
}

function usageValue(value: unknown, path = "runtime turn result.usage"): RuntimeUsage {
  const optional = [
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "contextWindow",
    "contextUsed",
  ] as const;
  const input = shape(
    value,
    path,
    ["inputTokens", "outputTokens", ...optional, "cost", "compaction", "sessionEvicted"],
  );
  const output: Record<string, unknown> = {
    inputTokens: nonNegativeNumber(input.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeNumber(input.outputTokens, `${path}.outputTokens`),
  };
  for (const key of optional) {
    if (input[key] !== undefined) output[key] = nonNegativeNumber(input[key], `${path}.${key}`);
  }
  if (input.sessionEvicted !== undefined) {
    if (typeof input.sessionEvicted !== "boolean") {
      fail(`${path}.sessionEvicted`, "must be boolean when present");
    }
    output.sessionEvicted = input.sessionEvicted;
  }
  if (input.cost !== undefined) output.cost = usageCost(input.cost, `${path}.cost`);
  if (input.compaction !== undefined) {
    output.compaction = compactionValue(input.compaction, `${path}.compaction`);
  }
  return output as unknown as RuntimeUsage;
}

function usageCost(value: unknown, path: string): RuntimeUsageCost {
  const optional = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const input = shape(value, path, ["currency", ...optional, "total"]);
  if (input.currency !== "USD") fail(`${path}.currency`, "must be USD");
  const output: Record<string, unknown> = {
    currency: "USD",
    total: nonNegativeNumber(input.total, `${path}.total`),
  };
  for (const key of optional) {
    if (input[key] !== undefined) output[key] = nonNegativeNumber(input[key], `${path}.${key}`);
  }
  return output as unknown as RuntimeUsageCost;
}

function compactionValue(
  value: unknown,
  path = "runtime turn result.usage.compaction",
): RuntimeCompaction {
  const optional = ["tokensBefore", "tokensAfter", "summaryTokens"] as const;
  const input = shape(value, path, ["compacted", ...optional, "firstRetainedMessageId"]);
  if (typeof input.compacted !== "boolean") fail(`${path}.compacted`, "must be boolean");
  const output: Record<string, unknown> = { compacted: input.compacted };
  for (const key of optional) {
    if (input[key] !== undefined) output[key] = nonNegativeNumber(input[key], `${path}.${key}`);
  }
  if (input.firstRetainedMessageId !== undefined) {
    output.firstRetainedMessageId = boundedText(
      input.firstRetainedMessageId,
      `${path}.firstRetainedMessageId`,
      MAX_IDENTIFIER_BYTES,
    );
  }
  return output as unknown as RuntimeCompaction;
}

function nativeTool(value: unknown, path: string): RuntimeNativeToolDescriptor {
  const detached = shape(value, path, ["id", "displayName", "effects", "approval", "sandbox"]);
  detached.effects = denseOwnDataArray(detached.effects, `${path}.effects`, 4);
  try {
    return parseRuntimeNativeToolDescriptor(detached);
  } catch (error) {
    throw new TypeError(`${path} is invalid`, { cause: error });
  }
}

function boundedJsonObject(value: unknown, path: string, maxBytes: number): JsonObject {
  const normalized = boundedJson(value, path, maxBytes);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    fail(path, "must be a JSON object");
  }
  return normalized as JsonObject;
}

function boundedJson(value: unknown, path: string, maxBytes: number): JsonValue {
  return snapshotBoundedValue<JsonValue>(value, {
    path,
    maxBytes,
    maxItems: RUNTIME_RESULT_MAX_JSON_ITEMS,
    maxDepth: RUNTIME_RESULT_MAX_JSON_DEPTH,
    label: "JSON",
    countRoot: false,
  }).value;
}

function fileData(value: unknown, path: string, budget: FileBudget, requireBytes: true): Uint8Array;
function fileData(value: unknown, path: string, budget: FileBudget, requireBytes?: false): Uint8Array | string;
function fileData(
  value: unknown,
  path: string,
  budget: FileBudget,
  requireBytes = false,
): Uint8Array | string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    fail(path, requireBytes ? "must be a Uint8Array" : "must be a string or Uint8Array");
  }
  if (requireBytes && typeof value === "string") fail(path, "must be a Uint8Array");
  const bytes = typeof value === "string" ? utf8Bytes(value) : value.byteLength;
  if (bytes > RUNTIME_RESULT_MAX_FILE_BYTES) {
    fail(path, `exceeds the ${String(RUNTIME_RESULT_MAX_FILE_BYTES)}-byte boundary`);
  }
  budget.fileBytes += bytes;
  if (budget.fileBytes > RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES) {
    fail(path, `exceeds the ${String(RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES)}-byte total file boundary`);
  }
  return value;
}

function shape(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  const input = ownDataRecord(value, path);
  assertOwnKeys(input, keys, path);
  return input;
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function runtimeSnapshot(value: unknown, path: string, maxBytes: number) {
  const label = path.includes("event") ? "event" : path.includes("tool call")
    ? "tool-call"
    : path.includes("capabilit") ? "capabilities"
      : path.includes("validation") ? "model-validation"
        : "result";
  return snapshotBoundedValue(value, {
    path,
    maxBytes,
    maxItems: RUNTIME_RESULT_MAX_ITEMS,
    maxDepth: RUNTIME_GRAPH_MAX_DEPTH,
    label,
    byteLabel: label,
    allowUndefined: true,
    allowCycles: true,
    cloneBytes: true,
    countRoot: false,
  });
}

function mediaType(value: unknown, path: string): string {
  const normalized = boundedText(value, path, MAX_MEDIA_TYPE_BYTES);
  if (!MEDIA_TYPE_PATTERN.test(normalized)) fail(path, "must be a bounded IANA media type");
  return normalized;
}

function displayFileName(value: unknown, path: string): string {
  const name = boundedText(value, path, MAX_FILE_NAME_BYTES);
  if (name === "." || name === ".." || /[/\\\u0000-\u001f\u007f]/u.test(name)) {
    fail(path, "must be a path-free display name");
  }
  return name;
}

function boundedText(
  value: unknown,
  path: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (!allowEmpty && value.length === 0) fail(path, "must not be empty");
  if (utf8Bytes(value) > maxBytes) fail(path, `exceeds the ${String(maxBytes)}-byte boundary`);
  return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
  const timestamp = boundedText(value, path, MAX_IDENTIFIER_BYTES);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    fail(path, "must be a canonical ISO timestamp");
  }
  return timestamp;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(path, "must be a non-negative finite number");
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value;
}

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}

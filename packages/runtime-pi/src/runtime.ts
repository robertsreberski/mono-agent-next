import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  AgentHarness,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type TSchema,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  parseApprovalDecision,
  parseApprovalRequest,
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  RuntimeTurnError,
} from "@mono-agent/module-sdk";
import type {
  JsonValue,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleDrainContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStartContext,
  ModuleStopContext,
  Runtime,
  RuntimeCapabilities,
  RuntimeNativeToolDescriptor,
  RuntimeSession,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  RuntimeToolResultPart,
  RuntimeTurnContext,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  RuntimeUsage,
  TurnContentPart,
  TurnMessage,
} from "@mono-agent/module-sdk";

import { createRuntimePiAuthCommands } from "./auth-command.js";
import type { RuntimePiConfig } from "./config.js";
import { parsePiModelReference } from "./config.js";
import { ReadOnlyPiCredentialStore, redactRuntimePiText, resolveRuntimePiPath } from "./credentials.js";
import {
  runtimePiEditTool,
  runtimePiNativeTools,
  runtimePiNodeReplTool,
  runtimePiWebSearchTool,
} from "./model.js";
import {
  createRuntimePiModelRegistry,
  RuntimePiModelDiscoveryError,
  type RuntimePiModelRegistry,
} from "./models.js";
import {
  editLiteralFile,
  EDIT_MAX_PATH_BYTES,
  EDIT_MAX_STRING_BYTES,
  type LiteralEditInput,
  validateLiteralEditInput,
} from "./edit.js";
import {
  createNodeReplController,
  NODE_REPL_MAX_CODE_BYTES,
  type NodeReplController,
} from "./node-repl.js";
import {
  RuntimePiSessionManager,
  RuntimePiSessionUnavailableError,
  type RuntimePiSessionAttemptResult,
} from "./sessions.js";
import {
  formatWebSearchResults,
  searchWeb,
  validateWebSearchInput,
  WEB_SEARCH_MAX_QUERY_BYTES,
  WEB_SEARCH_MAX_RESULTS,
  type WebSearchInput,
} from "./web-search.js";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const NODE_REPL_APPROVAL_PREVIEW_MAX_BYTES = 1_024;
const NATIVE_APPROVAL_PREVIEW_MAX_BYTES = 1_024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const STRUCTURED_OUTPUT_TOOL_NAME = "mono_agent_structured_output";

type RuntimeState = "created" | "running" | "draining" | "stopped";

export interface CreateRuntimePiOptions {
  readonly config: RuntimePiConfig;
  readonly instanceId: string;
  readonly configDirectory: string;
  readonly workspaceDirectory: string;
  readonly models?: RuntimePiModelRegistry["models"];
}

export class RuntimePiError extends RuntimeTurnError {
  declare readonly code:
    | "RUNTIME_NOT_RUNNING"
    | "MODEL_INVALID"
    | "PROVIDER_FAILED"
    | "SESSION_INVALID"
    | typeof RUNTIME_SESSION_UNAVAILABLE_CODE
    | "UNSUPPORTED";
  readonly committedSideEffects: boolean;
  readonly retryable: boolean;

  constructor(
    code: RuntimePiError["code"],
    message: string,
    options: {
      readonly committedSideEffects?: boolean;
      readonly retryable?: boolean;
      readonly cause?: unknown;
      readonly secrets?: readonly string[];
    } = {},
  ) {
    const retryable = options.retryable ?? false;
    const committedSideEffects = options.committedSideEffects ?? false;
    const safeCause = options.cause === undefined
      ? undefined
      : Object.freeze(Object.assign(
        new Error(redactRuntimePiText(options.cause, options.secrets ?? [])),
        { name: "RuntimePiCause" },
      ));
    super({
      code,
      message,
      retryability: retryable ? "retryable" : "not-retryable",
      sideEffects: committedSideEffects ? "committed" : "none",
      ...(safeCause === undefined ? {} : { cause: safeCause }),
    });
    this.name = "RuntimePiError";
    this.committedSideEffects = committedSideEffects;
    this.retryable = retryable;
  }
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
  } catch {
    return String(value);
  }
}

function runtimeUsage(usage: Usage): RuntimeUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cost: {
      currency: "USD",
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function imagePart(part: Extract<TurnContentPart, { type: "image" }>): ImageContent {
  return {
    type: "image",
    data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
    mimeType: part.mediaType,
  };
}

function filePartText(part: Extract<TurnContentPart, { type: "file" }>): string {
  if (part.mediaType.startsWith("text/") && typeof part.data === "string") return part.data;
  return `[Attached file ${JSON.stringify(part.name)} (${part.mediaType})]`;
}

function textAndImages(parts: readonly TurnContentPart[]): { text: string; images: ImageContent[] } {
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const part of parts) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image") images.push(imagePart(part));
    else if (part.type === "file") {
      if (part.mediaType.startsWith("image/")) {
        images.push({
          type: "image",
          data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
          mimeType: part.mediaType,
        });
      } else text.push(filePartText(part));
    } else if (part.type === "attachment") {
      text.push(`[Attached file attachment_id=${JSON.stringify(part.attachment.id)} `
        + `name=${JSON.stringify(part.attachment.name)} media_type=${JSON.stringify(part.attachment.mediaType)}]`);
      if (part.attachment.kind === "image") {
        images.push({
          type: "image",
          data: Buffer.from(part.attachment.data).toString("base64"),
          mimeType: part.attachment.mediaType,
        });
      }
    }
  }
  return { text: text.join("\n"), images };
}

function piContent(parts: readonly TurnContentPart[]): string | (TextContent | ImageContent)[] {
  const { text, images } = textAndImages(parts);
  if (images.length === 0) return text;
  return [...(text === "" ? [] : [{ type: "text" as const, text }]), ...images];
}

function objectArguments(input: JsonValue): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input };
}

function collectToolNames(messages: readonly TurnMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") names.set(part.call.id, part.call.name);
    }
  }
  return names;
}

function seedMessages(messages: readonly TurnMessage[], model: Model<string>): AgentMessage[] {
  const toolNames = collectToolNames(messages);
  const seeded: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      seeded.push({ role: "user", content: piContent(message.content), timestamp: timestamp(message.createdAt) });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "tool-call") {
          content.push({ type: "toolCall", id: part.call.id, name: part.call.name, arguments: objectArguments(part.call.input) });
        }
      }
      seeded.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: timestamp(message.createdAt),
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const result = part.result;
      const content = runtimeToolResultToPiContent(result.content);
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: result.callId,
        toolName: toolNames.get(result.callId) ?? "tool",
        content,
        details: { runtimeResult: result },
        isError: result.isError ?? false,
        timestamp: timestamp(message.createdAt),
      };
      seeded.push(toolResult);
    }
  }
  return seeded;
}

function runtimeToolResultToPiContent(content: readonly RuntimeToolResultPart[]): (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (part.type === "text") result.push({ type: "text", text: part.text });
    else if (part.type === "json") result.push({ type: "text", text: JSON.stringify(part.value) });
    else if (part.type === "artifact") {
      const reference = [
        `[Tool artifact ${JSON.stringify(part.ref.id)}`,
        `(${part.ref.mediaType}, ${String(part.ref.sizeBytes)} bytes, ${part.ref.sha256})]`,
      ].join(" ");
      result.push({
        type: "text",
        text: part.preview === undefined ? reference : `${part.preview}\n${reference}`,
      });
    } else if (part.mediaType.startsWith("image/")) {
      result.push({
        type: "image",
        data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
        mimeType: part.mediaType,
      });
    } else {
      const body = part.mediaType.startsWith("text/") && typeof part.data === "string"
        ? part.data
        : `[Tool file${part.name === undefined ? "" : ` ${JSON.stringify(part.name)}`} (${part.mediaType})]`;
      result.push({ type: "text", text: body });
    }
  }
  return result.length === 0 ? [{ type: "text", text: "" }] : result;
}

function piTools(
  definitions: readonly RuntimeToolDefinition[],
  context: RuntimeTurnContext,
  results: Map<string, RuntimeToolResult>,
  errors: Set<string>,
  turnSignal: AbortSignal,
  onToolAttempt: () => void,
): AgentTool[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as TSchema,
    async execute(toolCallId, params, signal) {
      const call: RuntimeToolCall = { id: toolCallId, name: definition.name, input: jsonValue(params) };
      onToolAttempt();
      const toolSignal = signal === undefined ? turnSignal : AbortSignal.any([turnSignal, signal]);
      const result = await context.executeTool(call, toolSignal);
      if (result.callId !== toolCallId) {
        throw new Error(`Tool ${definition.name} returned a mismatched call id`);
      }
      results.set(toolCallId, result);
      if (result.isError === true) errors.add(toolCallId);
      return { content: runtimeToolResultToPiContent(result.content), details: { runtimeResult: result } };
    },
  }));
}

function structuredOutputTool(
  schema: Readonly<Record<string, unknown>>,
  accept: (value: JsonValue) => void,
): AgentTool {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    label: "Structured output",
    description:
      "Return the final response by calling this tool exactly once with an object matching its schema.",
    parameters: schema as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      accept(jsonValue(params));
      return {
        content: [{ type: "text", text: "Structured output accepted." }],
        details: {},
        terminate: true,
      };
    },
  };
}

function boundedUtf8Prefix(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly totalBytes: number } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return {
      text: value,
      bytes: encoded.byteLength,
      totalBytes: encoded.byteLength,
    };
  }
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: UTF8_DECODER.decode(encoded.subarray(0, end)),
        bytes: end,
        totalBytes: encoded.byteLength,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", bytes: 0, totalBytes: encoded.byteLength };
}

function nodeReplApprovalSummary(code: string): string {
  const preview = boundedUtf8Prefix(code, NODE_REPL_APPROVAL_PREVIEW_MAX_BYTES);
  const digest = createHash("sha256").update(code, "utf8").digest("hex");
  const state = preview.bytes < preview.totalBytes ? "truncated" : "complete";
  return [
    "Allow Node REPL to evaluate this JavaScript with unsandboxed access to the inherited process environment, filesystem, subprocess execution, and network?",
    `Code evidence: ${String(preview.totalBytes)} UTF-8 bytes; sha256:${digest}.`,
    `Escaped preview (${String(preview.bytes)}/${String(preview.totalBytes)} bytes, ${state}): ${JSON.stringify(preview.text)}`,
  ].join("\n");
}

function stringEvidence(label: string, value: string): string {
  const preview = boundedUtf8Prefix(value, NATIVE_APPROVAL_PREVIEW_MAX_BYTES);
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const state = preview.bytes < preview.totalBytes ? "truncated" : "complete";
  return [
    `${label} evidence: ${String(preview.totalBytes)} UTF-8 bytes; sha256:${digest}.`,
    `${label} escaped preview (${String(preview.bytes)}/${String(preview.totalBytes)} bytes, ${state}): ${JSON.stringify(preview.text)}`,
  ].join("\n");
}

function editApprovalSummary(input: LiteralEditInput): string {
  return [
    "Allow runtime-pi to atomically replace literal text in this unsandboxed workspace file?",
    `file_path: ${JSON.stringify(input.filePath)}`,
    `replace_all: ${String(input.replaceAll)}`,
    stringEvidence("file_path", input.filePath),
    stringEvidence("old_string", input.oldString),
    stringEvidence("new_string", input.newString),
  ].join("\n");
}

function webSearchApprovalSummary(input: WebSearchInput): string {
  return [
    "Allow runtime-pi to send this search query to the configured HTTPS search endpoint?",
    `query: ${JSON.stringify(input.query)}`,
    `limit: ${String(input.limit)}`,
    stringEvidence("query", input.query),
  ].join("\n");
}

function combinedToolSignal(
  turnSignal: AbortSignal,
  signal: AbortSignal | undefined,
): AbortSignal {
  return signal === undefined
    ? turnSignal
    : AbortSignal.any([turnSignal, signal]);
}

async function requireNativeApproval(
  context: RuntimeTurnContext,
  descriptor: RuntimeNativeToolDescriptor,
  toolCallId: string,
  summary: string,
  signal: AbortSignal,
): Promise<void> {
  const requestApproval = context.requestApproval;
  if (requestApproval === undefined) {
    throw new RuntimePiError(
      "UNSUPPORTED",
      `runtime-pi requires Core's approval callback for its native ${descriptor.id} tool`,
      { retryable: false },
    );
  }
  const approval = parseApprovalRequest({
    interactionId: randomUUID(),
    callId: toolCallId,
    toolId: descriptor.id,
    displayName: descriptor.displayName,
    effects: descriptor.effects,
    summary,
    requestedAt: new Date().toISOString(),
  });
  const decision = parseApprovalDecision(
    await requestApproval(approval, signal),
    approval,
  );
  if (decision.decision !== "allow_once") {
    throw new Error(`${descriptor.displayName} execution was denied.`);
  }
}

function nativeTextResult(
  toolCallId: string,
  text: string,
  results: Map<string, RuntimeToolResult>,
): {
  readonly content: (TextContent | ImageContent)[];
  readonly details: { readonly runtimeResult: RuntimeToolResult };
} {
  const result: RuntimeToolResult = {
    callId: toolCallId,
    content: [{ type: "text", text }],
  };
  results.set(toolCallId, result);
  return {
    content: runtimeToolResultToPiContent(result.content),
    details: { runtimeResult: result },
  };
}

function nodeReplTool(
  context: RuntimeTurnContext,
  controller: NodeReplController,
  results: Map<string, RuntimeToolResult>,
  turnSignal: AbortSignal,
  onToolAttempt: () => void,
): AgentTool {
  const requestApproval = context.requestApproval;
  if (requestApproval === undefined) {
    throw new RuntimePiError(
      "UNSUPPORTED",
      "runtime-pi requires Core's approval callback for its native NodeRepl tool",
      { retryable: false },
    );
  }
  return {
    name: runtimePiNodeReplTool.id,
    label: runtimePiNodeReplTool.displayName,
    description:
      "Evaluate JavaScript in a run-scoped Node.js REPL. Variables persist across NodeRepl calls in this run.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: {
          type: "string",
          minLength: 1,
          maxLength: 262_144,
          description: "JavaScript to evaluate in the run-scoped Node.js REPL.",
        },
      },
    } as TSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      if (params === null || typeof params !== "object") {
        throw new Error("Node REPL parameters must be an object.");
      }
      const code = Reflect.get(params, "code");
      if (typeof code !== "string") throw new Error("Node REPL code must be a string.");
      if (Buffer.byteLength(code, "utf8") > NODE_REPL_MAX_CODE_BYTES) {
        throw new Error(
          `Node REPL code exceeds ${String(NODE_REPL_MAX_CODE_BYTES)} bytes.`,
        );
      }
      const approvalSignal = combinedToolSignal(turnSignal, signal);
      await requireNativeApproval(
        context,
        runtimePiNodeReplTool,
        toolCallId,
        nodeReplApprovalSummary(code),
        approvalSignal,
      );
      onToolAttempt();
      const output = await controller.execute({ code }, { signal: approvalSignal });
      return nativeTextResult(toolCallId, output, results);
    },
  };
}

function editTool(
  context: RuntimeTurnContext,
  workspaceDirectory: string,
  results: Map<string, RuntimeToolResult>,
  turnSignal: AbortSignal,
  onToolAttempt: () => void,
): AgentTool {
  return {
    name: runtimePiEditTool.id,
    label: runtimePiEditTool.displayName,
    description:
      "Replace one exact literal string in an existing UTF-8 workspace file, or every exact match when replace_all is true.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: {
          type: "string",
          minLength: 1,
          maxLength: EDIT_MAX_PATH_BYTES,
          description: "Workspace-relative or in-workspace absolute file path.",
        },
        old_string: {
          type: "string",
          minLength: 1,
          maxLength: EDIT_MAX_STRING_BYTES,
          description: "Exact literal text to replace.",
        },
        new_string: {
          type: "string",
          maxLength: EDIT_MAX_STRING_BYTES,
          description: "Literal replacement text.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace every exact match. Defaults to false.",
        },
      },
    } as TSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      if (params === null || typeof params !== "object") {
        throw new Error("Edit parameters must be an object.");
      }
      const input: LiteralEditInput = {
        filePath: Reflect.get(params, "file_path"),
        oldString: Reflect.get(params, "old_string"),
        newString: Reflect.get(params, "new_string"),
        replaceAll: Reflect.get(params, "replace_all") ?? false,
      } as LiteralEditInput;
      validateLiteralEditInput(input);
      const approvalSignal = combinedToolSignal(turnSignal, signal);
      await requireNativeApproval(
        context,
        runtimePiEditTool,
        toolCallId,
        editApprovalSummary(input),
        approvalSignal,
      );
      onToolAttempt();
      const edited = await editLiteralFile(
        workspaceDirectory,
        input,
        { signal: approvalSignal },
      );
      return nativeTextResult(
        toolCallId,
        [
          `Edited ${JSON.stringify(edited.path)} with ${String(edited.replacements)} literal replacement${edited.replacements === 1 ? "" : "s"}.`,
          `Bytes: ${String(edited.bytesBefore)} -> ${String(edited.bytesAfter)}.`,
          `SHA-256: ${edited.sha256Before} -> ${edited.sha256After}.`,
        ].join("\n"),
        results,
      );
    },
  };
}

function webSearchTool(
  context: RuntimeTurnContext,
  results: Map<string, RuntimeToolResult>,
  turnSignal: AbortSignal,
  onToolAttempt: () => void,
): AgentTool {
  return {
    name: runtimePiWebSearchTool.id,
    label: runtimePiWebSearchTool.displayName,
    description:
      "Search the web through a bounded, redirect-checked HTTPS endpoint and return result summaries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: WEB_SEARCH_MAX_QUERY_BYTES,
          description: "Search query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: WEB_SEARCH_MAX_RESULTS,
          description: "Maximum result count. Defaults to 5.",
        },
      },
    } as TSchema,
    async execute(toolCallId, params, signal) {
      if (params === null || typeof params !== "object") {
        throw new Error("WebSearch parameters must be an object.");
      }
      const input: WebSearchInput = {
        query: Reflect.get(params, "query"),
        limit: Reflect.get(params, "limit") ?? 5,
      } as WebSearchInput;
      validateWebSearchInput(input);
      const approvalSignal = combinedToolSignal(turnSignal, signal);
      await requireNativeApproval(
        context,
        runtimePiWebSearchTool,
        toolCallId,
        webSearchApprovalSummary(input),
        approvalSignal,
      );
      onToolAttempt();
      const searchResults = await searchWeb(input, { signal: approvalSignal });
      return nativeTextResult(
        toolCallId,
        formatWebSearchResults(searchResults),
        results,
      );
    },
  };
}

function nativeToolExecutionResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): RuntimeToolResult {
  const content = result !== null
    && typeof result === "object"
    && Array.isArray(Reflect.get(result, "content"))
    ? Reflect.get(result, "content") as unknown[]
    : [];
  const text = content.flatMap((part) =>
    part !== null
    && typeof part === "object"
    && Reflect.get(part, "type") === "text"
    && typeof Reflect.get(part, "text") === "string"
      ? [Reflect.get(part, "text") as string]
      : []);
  return {
    callId: toolCallId,
    content: [{ type: "text", text: text.join("\n") || `${toolName} execution failed.` }],
    ...(isError ? { isError: true } : {}),
  };
}

function systemPrompt(messages: readonly TurnMessage[]): string | undefined {
  const values = messages
    .filter((message) => message.role === "system")
    .map((message) => textAndImages(message.content).text)
    .filter((value) => value !== "");
  return values.length === 0 ? undefined : values.join("\n\n");
}

function finalUser(messages: readonly TurnMessage[]): { index: number; text: string; images: ImageContent[] } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return { index, ...textAndImages(message.content) };
  }
  throw new TypeError("runtime-pi turn requires a user message");
}

function assertSessionLinkage(
  request: RuntimeTurnRequest,
  instanceId: string,
): void {
  if (request.session === undefined) return;
  if (request.session.route?.runtimeInstanceId !== instanceId) {
    throw new RuntimePiError(
      "SESSION_INVALID",
      "runtime-pi session belongs to another runtime instance",
      { retryable: false },
    );
  }
  if (request.session.route.model !== request.model) {
    throw new RuntimePiError(
      "SESSION_INVALID",
      "runtime-pi session belongs to another model route",
      { retryable: false },
    );
  }
  if (request.session.conversationId !== request.conversationId) {
    throw new RuntimePiError(
      "SESSION_INVALID",
      "runtime-pi session belongs to another conversation",
      { retryable: false },
    );
  }
}

function assistantTurnMessage(message: AssistantMessage): TurnMessage {
  const content: TurnContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "toolCall") {
      content.push({ type: "tool-call", call: { id: part.id, name: part.name, input: jsonValue(part.arguments) } });
    }
  }
  return {
    role: "assistant",
    content,
    createdAt: new Date(message.timestamp).toISOString(),
  };
}

function thinkingLevel(effort: string | undefined, model: Model<string>): { level: ThinkingLevel; clamped: boolean } {
  const requested = effort === undefined || effort === "none" ? "off" : effort;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(requested)) {
    throw new TypeError(`runtime-pi effort is unsupported: ${JSON.stringify(effort)}`);
  }
  const level = clampThinkingLevel(model, requested as ThinkingLevel) as ThinkingLevel;
  return { level, clamped: level !== requested };
}

function exactCapabilities(attachments: boolean): RuntimeCapabilities {
  return {
    tools: true,
    mcp: true,
    attachments,
    approvals: true,
    structuredOutput: true,
    sandbox: false,
    sessions: true,
    maxTurns: true,
    maxOutputTokens: true,
    artifactResults: true,
    liveInput: true,
  };
}

function withCommittedEffects(error: RuntimePiError, committedSideEffects: boolean): RuntimePiError {
  if (!committedSideEffects || error.committedSideEffects) return error;
  return new RuntimePiError(error.code, error.message, {
    committedSideEffects: true,
    retryable: error.retryable,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

const TRANSIENT_PROVIDER_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_PROVIDER_CODE = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function ownDataValue(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Retry only failures carrying an explicit own transient status/code. */
export function isCheckedTransientProviderFailure(error: unknown): boolean {
  const status = ownDataValue(error, "status")
    ?? ownDataValue(error, "statusCode");
  if (typeof status === "number"
    && Number.isSafeInteger(status)
    && TRANSIENT_PROVIDER_STATUS.has(status)) {
    return true;
  }
  const code = ownDataValue(error, "code");
  return typeof code === "string" && TRANSIENT_PROVIDER_CODE.has(code);
}

async function waitForSettled(
  promises: readonly Promise<unknown>[],
  signal: AbortSignal,
  message: string,
): Promise<void> {
  if (promises.length === 0) return;
  const settled = Promise.allSettled(promises);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let results: PromiseSettledResult<unknown>[];
  try {
    results = await Promise.race([settled, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, message);
}

export function createRuntimePi(options: CreateRuntimePiOptions): Runtime {
  const cwd = options.workspaceDirectory;
  const authPath = resolveRuntimePiPath(options.config.auth.path, options.configDirectory);
  const sessionsRoot = options.config.sessions?.root === undefined
    ? undefined
    : resolveRuntimePiPath(options.config.sessions.root, options.configDirectory);
  const credentialStore = new ReadOnlyPiCredentialStore(authPath);
  const registry = createRuntimePiModelRegistry(options.config, credentialStore, options.models);
  const commands = createRuntimePiAuthCommands(credentialStore, registry.models);
  const sessions = new RuntimePiSessionManager({
    cwd,
    namespace: options.instanceId,
    ...(sessionsRoot === undefined ? {} : { sessionsRoot }),
  });
  let state: RuntimeState = "created";
  const active = new Set<AgentHarness>();

  const diagnostic = (code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic => ({
    code,
    severity,
    message,
  });

  return {
    commands,
    capabilities: {
      tools: true,
      mcp: true,
      attachments: false,
      approvals: true,
      structuredOutput: true,
      sandbox: false,
      sessions: true,
      maxTurns: true,
      maxOutputTokens: true,
      artifactResults: true,
      liveInput: true,
    },

    async start(_context: ModuleStartContext) {
      if (state === "stopped") throw new RuntimePiError("RUNTIME_NOT_RUNNING", "runtime-pi cannot restart after stop");
      await sessions.initialize();
      state = "running";
    },

    async drain(context: ModuleDrainContext) {
      if (state === "stopped") return;
      state = "draining";
      await sessions.drain(context.signal);
    },

    async stop(context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      const failures: unknown[] = [];
      try {
        await waitForSettled(
          [...active].map((harness) => harness.abort()),
          context.signal,
          "runtime-pi harnesses failed to abort",
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await sessions.stop(context.signal);
      } catch (error) {
        failures.push(error);
      } finally {
        state = "stopped";
      }
      if (failures.length > 0) throw new AggregateError(failures, "runtime-pi failed to stop cleanly");
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      const status = state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown";
      return {
        status,
        checkedAt: new Date().toISOString(),
        summary: `runtime-pi is ${state}`,
        details: { state, activeTurns: active.size },
      };
    },

    async diagnostics(context: ModuleDiagnosticsContext): Promise<readonly ModuleDiagnostic[]> {
      const diagnostics: ModuleDiagnostic[] = [diagnostic("runtime-pi.lifecycle", "info", `Runtime state: ${state}`)];
      if (context.verbose) {
        try {
          const credentials = await credentialStore.list();
          diagnostics.push(diagnostic(
            "runtime-pi.auth",
            "info",
            `Explicit auth store contains ${credentials.length} provider credential${credentials.length === 1 ? "" : "s"}`,
          ));
        } catch (error) {
          diagnostics.push(diagnostic("runtime-pi.auth", "error", redactRuntimePiText(error, [])));
        }
      }
      return diagnostics;
    },

    async preflightModel({ model, signal }) {
      signal.throwIfAborted();
      try {
        const capabilities = await registry.capabilities(model, signal);
        return {
          supported: true,
          capabilities: exactCapabilities(capabilities.attachments),
          nativeTools: runtimePiNativeTools,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return {
          supported: false,
          diagnostics: [diagnostic("runtime-pi.model", "error", redactRuntimePiText(error, registry.configuredSecrets))],
        };
      }
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimePiError("RUNTIME_NOT_RUNNING", `runtime-pi is ${state}`);
      if (request.signal.aborted) return { status: "cancelled" };
      assertSessionLinkage(request, options.instanceId);
      if (
        request.options?.responseSchema === undefined
        && context.requestApproval === undefined
      ) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          "runtime-pi requires Core's approval callback for its native tools",
          { retryable: false },
        );
      }
      const nativeToolNames = new Set(runtimePiNativeTools.map((tool) => tool.id));
      const conflict = request.tools.find((tool) =>
        nativeToolNames.has(tool.name)
        || tool.name === STRUCTURED_OUTPUT_TOOL_NAME);
      if (conflict !== undefined) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          `runtime-pi request tools conflict with the native ${conflict.name} tool`,
          { retryable: false },
        );
      }

      let model: Model<string>;
      try {
        model = await registry.resolve(request.model, request.signal);
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled" };
        const discoveryFailure = error instanceof RuntimePiModelDiscoveryError;
        const retryable = discoveryFailure && isCheckedTransientProviderFailure(error);
        throw new RuntimePiError(
          discoveryFailure ? "PROVIDER_FAILED" : "MODEL_INVALID",
          redactRuntimePiText(error, registry.configuredSecrets),
          {
            cause: error,
            retryable,
            secrets: registry.configuredSecrets,
          },
        );
      }
      const requestedMaxOutputTokens = request.options?.maxOutputTokens;
      if (
        requestedMaxOutputTokens !== undefined
        && (!Number.isSafeInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0)
      ) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          "runtime-pi maxOutputTokens must be a positive safe integer",
          { retryable: false },
        );
      }
      if (requestedMaxOutputTokens !== undefined) {
        model = {
          ...model,
          maxTokens: Math.min(model.maxTokens, requestedMaxOutputTokens),
        };
      }
      const reference = parsePiModelReference(request.model);
      const prompt = finalUser(request.messages);
      const secretValues = [...registry.configuredSecrets];
      if (!options.config.localProviders.some((provider) => provider.id === reference.provider)) {
        try { secretValues.push(...await credentialStore.redactionValues()); } catch { /* request auth reports the safe failure */ }
      }
      const currentFailureSecrets = async (): Promise<readonly string[]> => {
        const values = [...secretValues];
        try {
          values.push(...await credentialStore.redactionValues());
        } catch {
          // Preserve the already validated snapshot if the rotated store is unavailable.
        }
        return [...new Set(values)];
      };
      let committedSideEffects = false;
      try {
        const turnResult = await sessions.withAttempt(
          {
            conversationId: request.conversationId,
            modelKey: request.model,
            turnId: request.turnId,
            signal: request.signal,
            ...(request.session === undefined ? {} : { resumeSessionId: request.session.id }),
          },
          async (attempt): Promise<RuntimePiSessionAttemptResult<RuntimeTurnResult>> => {
            if (request.signal.aborted) return { completed: false, value: { status: "cancelled" } };
            if (request.session === undefined) {
              for (const message of seedMessages(request.messages.slice(0, prompt.index), model)) {
                await attempt.session.appendMessage(message);
                if (request.signal.aborted) return { completed: false, value: { status: "cancelled" } };
              }
            }

            const toolResults = new Map<string, RuntimeToolResult>();
            const toolErrors = new Set<string>();
            let structuredOutput: JsonValue | undefined;
            const responseSchema = request.options?.responseSchema;
            const effort = thinkingLevel(request.options?.effort, model);
            const authoredSystemPrompt = systemPrompt(request.messages);
            const nodeRepl = createNodeReplController(cwd);
            const codingTools = responseSchema === undefined
              ? (await import("./coding-tools.js")).createRuntimePiCodingTools({
                  workspaceDirectory: cwd,
                  turnSignal: request.signal,
                  authorize: (descriptor, toolCallId, summary, signal) =>
                    requireNativeApproval(
                      context,
                      descriptor,
                      toolCallId,
                      summary,
                      signal,
                    ),
                  record: (result) => {
                    toolResults.set(result.callId, result);
                  },
                  onToolAttempt: () => {
                    committedSideEffects = true;
                  },
                })
              : [];
            const harness = new AgentHarness({
              env: sessions.env,
              session: attempt.session,
              models: registry.models,
              model,
              thinkingLevel: effort.level,
              ...(authoredSystemPrompt === undefined ? {} : { systemPrompt: authoredSystemPrompt }),
              tools: responseSchema === undefined ? [
                ...piTools(
                  request.tools,
                  context,
                  toolResults,
                  toolErrors,
                  request.signal,
                  () => { committedSideEffects = true; },
                ),
                nodeReplTool(
                  context,
                  nodeRepl,
                  toolResults,
                  request.signal,
                  () => { committedSideEffects = true; },
                ),
                ...codingTools.slice(0, 2),
                editTool(
                  context,
                  cwd,
                  toolResults,
                  request.signal,
                  () => { committedSideEffects = true; },
                ),
                ...codingTools.slice(2),
                webSearchTool(
                  context,
                  toolResults,
                  request.signal,
                  () => { committedSideEffects = true; },
                ),
              ] : [
                ...piTools(
                  request.tools,
                  context,
                  toolResults,
                  toolErrors,
                  request.signal,
                  () => { committedSideEffects = true; },
                ),
                structuredOutputTool(responseSchema, (value) => {
                  if (structuredOutput !== undefined) {
                    throw new Error("Structured output was submitted more than once.");
                  }
                  structuredOutput = value;
                }),
              ],
              streamOptions: {
                timeoutMs: options.config.retry.timeoutMs,
                maxRetries: options.config.retry.maxRetries,
                maxRetryDelayMs: options.config.retry.maxDelayMs,
              },
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
            });
            const removeToolResultHandler = harness.on(
              "tool_result",
              (event) => toolErrors.has(event.toolCallId) ? { isError: true } : undefined,
            );
            active.add(harness);
            const linkedSession: RuntimeSession = {
              id: attempt.id,
              conversationId: request.conversationId,
              route: {
                runtimeInstanceId: options.instanceId,
                model: request.model,
              },
              createdAt: new Date().toISOString(),
              metadata: {
                provider: "pi",
                nativeProvider: reference.provider,
                nativeModel: reference.model,
              },
            };
            let maxTurnsHit = false;
            let turnCount = 0;
            let abortPromise: Promise<unknown> | undefined;
            const maxTurns = request.options?.maxTurns;
            const abortHarness = (): void => {
              abortPromise ??= harness.abort();
              void abortPromise.catch(() => undefined);
            };
            request.signal.addEventListener("abort", abortHarness, { once: true });
            if (request.signal.aborted) abortHarness();
            const unregisterLiveInput = context.registerLiveInput?.(async (input) => {
              if (request.signal.aborted) return "requeue";
              try {
                await harness.steer(input.text);
                return "applied";
              } catch {
                return "requeue";
              }
            });
            const unsubscribe = harness.subscribe(async (event) => {
              if (event.type === "message_update") {
                const update = event.assistantMessageEvent;
                if (update.type === "text_delta") await context.emit({ type: "text-delta", delta: update.delta });
                else if (update.type === "thinking_delta") await context.emit({ type: "thinking-delta", delta: update.delta });
              } else if (event.type === "tool_execution_start") {
                if (event.toolName === STRUCTURED_OUTPUT_TOOL_NAME) return;
                await context.emit({
                  type: "tool-call",
                  call: { id: event.toolCallId, name: event.toolName, input: jsonValue(event.args) },
                });
              } else if (event.type === "tool_execution_end") {
                if (event.toolName === STRUCTURED_OUTPUT_TOOL_NAME) return;
                const result = toolResults.get(event.toolCallId)
                  ?? (nativeToolNames.has(event.toolName)
                    ? nativeToolExecutionResult(
                      event.toolCallId,
                      event.toolName,
                      event.result,
                      event.isError,
                    )
                    : undefined);
                if (result !== undefined) {
                  toolResults.set(event.toolCallId, result);
                  await context.emit({ type: "tool-result", result });
                }
              } else if (event.type === "turn_end") {
                turnCount += 1;
                if (maxTurns !== undefined && turnCount >= maxTurns && event.message.role === "assistant"
                  && event.message.stopReason === "toolUse") {
                  maxTurnsHit = true;
                  abortHarness();
                }
              } else if (event.type === "session_compact") {
                await context.emit({
                  type: "compaction",
                  compaction: {
                    compacted: true,
                    tokensBefore: event.compactionEntry.tokensBefore,
                    ...(event.compactionEntry.firstKeptEntryId === undefined
                      ? {}
                      : { firstRetainedMessageId: event.compactionEntry.firstKeptEntryId }),
                  },
                });
              } else if (event.type === "retry_scheduled") {
                await context.emit({
                  type: "diagnostic",
                  diagnostic: diagnostic(
                    "runtime-pi.retry",
                    "warning",
                    `Pi ${event.operation} retry ${event.attempt}/${event.maxAttempts} scheduled after ${event.delayMs}ms`,
                  ),
                });
              }
            });

            try {
              if (effort.clamped) {
                await context.emit({
                  type: "diagnostic",
                  diagnostic: diagnostic(
                    "runtime-pi.effort-clamped",
                    "warning",
                    `Requested effort ${JSON.stringify(request.options?.effort)} was clamped to ${effort.level}`,
                  ),
                });
              }
              if (request.signal.aborted) return { completed: false, value: { status: "cancelled" } };
              const result = await harness.prompt(
                prompt.text,
                prompt.images.length === 0 ? undefined : { images: prompt.images },
              );
              await harness.waitForIdle();
              if (abortPromise !== undefined) await abortPromise;
              const usage = runtimeUsage(result.usage);
              await context.emit({ type: "usage", usage });
              const message = assistantTurnMessage(result);
              if (maxTurnsHit) {
                return { completed: false, value: { status: "max-turns", message, usage } };
              }
              if (result.stopReason === "aborted" || request.signal.aborted) {
                return { completed: false, value: { status: "cancelled", message, usage } };
              }
              if (result.stopReason === "error") {
                const failureSecrets = await currentFailureSecrets();
                throw new RuntimePiError(
                  "PROVIDER_FAILED",
                  redactRuntimePiText(result.errorMessage ?? "Pi provider request failed", failureSecrets),
                  {
                    committedSideEffects,
                    cause: result.errorMessage ?? "Pi provider request failed",
                    secrets: failureSecrets,
                  },
                );
              }
              if (responseSchema !== undefined && structuredOutput === undefined) {
                throw new RuntimePiError(
                  "PROVIDER_FAILED",
                  "Pi completed without the required structured output.",
                  { committedSideEffects, retryable: false },
                );
              }
              return {
                completed: true,
                value: {
                  status: "completed",
                  message,
                  ...(structuredOutput === undefined ? {} : { structuredOutput }),
                  usage,
                  session: linkedSession,
                  metadata: { provider: reference.provider, model: reference.model, stopReason: result.stopReason },
                },
              };
            } catch (error) {
              if (request.signal.aborted || maxTurnsHit
                || (state !== "running" && error instanceof Error && error.name === "AbortError")) {
                return { completed: false, value: { status: maxTurnsHit ? "max-turns" : "cancelled" } };
              }
              if (error instanceof RuntimePiError) throw withCommittedEffects(error, committedSideEffects);
              const failureSecrets = await currentFailureSecrets();
              throw new RuntimePiError(
                "PROVIDER_FAILED",
                redactRuntimePiText(error, failureSecrets),
                {
                  committedSideEffects,
                  retryable: isCheckedTransientProviderFailure(error),
                  cause: error,
                  secrets: failureSecrets,
                },
              );
            } finally {
              request.signal.removeEventListener("abort", abortHarness);
              unregisterLiveInput?.();
              unsubscribe();
              removeToolResultHandler();
              active.delete(harness);
              await nodeRepl.close();
            }
          },
        );
        if (turnResult.status === "completed" && turnResult.session !== undefined) {
          await context.emit({ type: "session", session: turnResult.session });
        }
        return turnResult;
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled" };
        if (error instanceof RuntimePiError) throw withCommittedEffects(error, committedSideEffects);
        if (error instanceof RuntimePiSessionUnavailableError) {
          throw new RuntimePiError(
            RUNTIME_SESSION_UNAVAILABLE_CODE,
            error.message,
            { cause: error },
          );
        }
        const failureSecrets = await currentFailureSecrets();
        throw new RuntimePiError(
          "SESSION_INVALID",
          redactRuntimePiText(error, failureSecrets),
          {
            committedSideEffects,
            retryable: false,
            cause: error,
            secrets: failureSecrets,
          },
        );
      }
    },
  };
}

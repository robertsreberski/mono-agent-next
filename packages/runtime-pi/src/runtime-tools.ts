// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ImageContent,
  TextContent,
  TSchema,
} from "@earendil-works/pi-ai";
import {
  AGENT_INTERACTION_LIMITS,
  parseApprovalDecision,
  parseApprovalRequest,
} from "@mono-agent/module-sdk";
import type {
  JsonValue,
  RuntimeNativeToolDescriptor,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  RuntimeTurnContext,
} from "@mono-agent/module-sdk";

import {
  editLiteralFile,
  EDIT_MAX_PATH_BYTES,
  EDIT_MAX_STRING_BYTES,
  type LiteralEditInput,
  validateLiteralEditInput,
} from "./edit.js";
import {
  runtimePiEditTool,
  runtimePiNodeReplTool,
  runtimePiWebSearchTool,
} from "./model.js";
import {
  NODE_REPL_MAX_CODE_BYTES,
  type NodeReplController,
} from "./node-repl.js";
import { RuntimePiError } from "./runtime-errors.js";
import {
  jsonValue,
  runtimeToolResultToPiContent,
} from "./runtime-messages.js";
import {
  formatWebSearchResults,
  searchWeb,
  validateWebSearchInput,
  WEB_SEARCH_MAX_QUERY_BYTES,
  WEB_SEARCH_MAX_RESULTS,
  type WebSearchInput,
} from "./web-search.js";

const APPROVAL_CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const APPROVAL_CALL_ID_ALIAS_PREFIX = "pi-call-";
const APPROVAL_CALL_ID_DOMAIN = "runtime-pi:approval-call-id:v1\0";
const APPROVAL_CALL_ID_ESCAPE_DOMAIN = "runtime-pi:approval-call-id:escaped:v1\0";
const NODE_REPL_APPROVAL_PREVIEW_MAX_BYTES = 1_024;
const NATIVE_APPROVAL_PREVIEW_MAX_BYTES = 1_024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const STRUCTURED_OUTPUT_TOOL_NAME = "mono_agent_structured_output";

export function piTools(
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
      const call: RuntimeToolCall = {
        id: toolCallId,
        name: definition.name,
        input: jsonValue(params),
      };
      onToolAttempt();
      const toolSignal = signal === undefined
        ? turnSignal
        : AbortSignal.any([turnSignal, signal]);
      const result = await context.executeTool(call, toolSignal);
      if (result.callId !== toolCallId) {
        throw new Error(`Tool ${definition.name} returned a mismatched call id`);
      }
      results.set(toolCallId, result);
      if (result.isError === true) errors.add(toolCallId);
      return {
        content: runtimeToolResultToPiContent(result.content),
        details: { runtimeResult: result },
      };
    },
  }));
}

export function structuredOutputTool(
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

function approvalCallId(toolCallId: string): string {
  const isValid =
    toolCallId.length > 0
    && toolCallId.length <= AGENT_INTERACTION_LIMITS.identifierCharacters
    && APPROVAL_CALL_ID_PATTERN.test(toolCallId);
  if (isValid && !toolCallId.startsWith(APPROVAL_CALL_ID_ALIAS_PREFIX)) {
    return toolCallId;
  }
  const prefix = isValid
    ? `${APPROVAL_CALL_ID_ALIAS_PREFIX}escaped-`
    : APPROVAL_CALL_ID_ALIAS_PREFIX;
  const domain = isValid ? APPROVAL_CALL_ID_ESCAPE_DOMAIN : APPROVAL_CALL_ID_DOMAIN;
  return `${prefix}${createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from(toolCallId, "utf16le"))
    .digest("hex")}`;
}

export async function requireNativeApproval(
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
    callId: approvalCallId(toolCallId),
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

export function nodeReplTool(
  context: RuntimeTurnContext,
  controller: NodeReplController,
  results: Map<string, RuntimeToolResult>,
  turnSignal: AbortSignal,
  onToolAttempt: () => void,
): AgentTool {
  if (context.requestApproval === undefined) {
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

export function editTool(
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

export function webSearchTool(
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

export function nativeToolExecutionResult(
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

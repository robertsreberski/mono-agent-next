import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type {
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type {
  ImageContent,
  TextContent,
  TSchema,
} from "@earendil-works/pi-ai";
import type {
  RuntimeNativeToolDescriptor,
  RuntimeToolResult,
  RuntimeToolResultPart,
} from "@mono-agent/module-sdk";

import {
  WEB_FETCH_MAX_OUTPUT_BYTES,
  type WebFetchOptions,
} from "./web-fetch.js";

export const PATH_MAX_BYTES = 4 * 1024;
const STRING_PREVIEW_MAX_BYTES = 1_024;
// Pi 0.81.1 resizes images below a 4.5 MiB encoded payload. Keep the same
// explicit ceiling locally so a future upstream regression cannot place an
// unbounded image in the provider context or the recorded runtime result.
export const RUNTIME_PI_MAX_IMAGE_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);

export interface RuntimePiCodingToolsOptions {
  readonly workspaceDirectory: string;
  readonly turnSignal: AbortSignal;
  readonly authorize: (
    descriptor: RuntimeNativeToolDescriptor,
    toolCallId: string,
    summary: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly record: (result: RuntimeToolResult) => void;
  readonly onToolAttempt: () => void;
  readonly glob?: {
    readonly maxVisitedEntries?: number;
    readonly timeoutMs?: number;
  };
  readonly webFetch?: Omit<WebFetchOptions, "signal">;
}

export function toolError(name: string, message: string): Error {
  return new Error(`${name} failed: ${message}`);
}

export function ownRecord(
  value: unknown,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw toolError(name, "parameters must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw toolError(name, "parameters must be a plain object.");
  }
  const allowedNames = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedNames.has(key)) {
      throw toolError(name, `parameter ${JSON.stringify(String(key))} is not supported.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw toolError(name, `parameter ${JSON.stringify(key)} must be an own data property.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
  name: string,
  maxBytes: number,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string"
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw toolError(
      name,
      `${key} must be a string of at most ${String(maxBytes)} UTF-8 bytes without NUL bytes.`,
    );
  }
  return value;
}

export function requiredString(
  input: Record<string, unknown>,
  key: string,
  name: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  const value = optionalString(input, key, name, maxBytes);
  if (value === undefined || (!allowEmpty && value.length === 0)) {
    throw toolError(name, `${key} must be ${allowEmpty ? "a" : "a non-empty"} string.`);
  }
  return value;
}

export function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  name: string,
  bounds: { readonly minimum?: number; readonly maximum?: number } = {},
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)
    || (bounds.minimum !== undefined && (value as number) < bounds.minimum)
    || (bounds.maximum !== undefined && (value as number) > bounds.maximum)) {
    throw toolError(name, `${key} must be a bounded safe integer.`);
  }
  return value as number;
}

export function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
  name: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw toolError(name, `${key} must be a boolean.`);
  return value;
}

export function aliasedString(
  input: Record<string, unknown>,
  left: string,
  right: string,
  name: string,
  maxBytes: number,
): string {
  const leftValue = optionalString(input, left, name, maxBytes);
  const rightValue = optionalString(input, right, name, maxBytes);
  if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
    throw toolError(name, `${left} and ${right} conflict.`);
  }
  const value = leftValue ?? rightValue;
  if (value === undefined || value.length === 0) {
    throw toolError(name, `one of ${left} or ${right} must be a non-empty string.`);
  }
  return value;
}

export function outputLimit(input: Record<string, unknown>, name: string): number {
  return optionalInteger(input, "max_output_chars", name, {
    minimum: 1,
    maximum: WEB_FETCH_MAX_OUTPUT_BYTES,
  }) ?? WEB_FETCH_MAX_OUTPUT_BYTES;
}

export function effectiveWorkdir(
  input: Record<string, unknown>,
  name: string,
  workspaceDirectory: string,
): string {
  const authored = optionalString(input, "workdir", name, PATH_MAX_BYTES);
  if (authored === undefined || authored === "") return resolve(workspaceDirectory);
  if (authored === "~") return homedir();
  if (authored.startsWith("~/")) return resolve(homedir(), authored.slice(2));
  return isAbsolute(authored)
    ? resolve(authored)
    : resolve(workspaceDirectory, authored);
}

export function displayPath(path: string, workdir: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(workdir, path);
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const notice = `\n\n[Tool output truncated to ${String(maxBytes)} UTF-8 bytes.]`;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  const includeNotice = noticeBytes <= maxBytes;
  const bodyLimit = includeNotice ? maxBytes - noticeBytes : maxBytes;
  let end = bodyLimit;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}${includeNotice ? notice : ""}`;
}

export function capRuntimePiAgentResult<T>(
  result: AgentToolResult<T>,
  maxBytes: number,
): AgentToolResult<T> {
  let remainingTextBytes = maxBytes;
  let remainingImageBytes = RUNTIME_PI_MAX_IMAGE_BASE64_BYTES;
  const boundedText = (text: string): TextContent => {
    if (remainingTextBytes <= 0) return { type: "text", text: "" };
    const bounded = boundedUtf8(text, remainingTextBytes);
    remainingTextBytes -= Buffer.byteLength(bounded, "utf8");
    return { type: "text", text: bounded };
  };
  const content = result.content.map((part): TextContent | ImageContent => {
    if (part.type === "text") return boundedText(part.text);
    const encodedBytes = Buffer.byteLength(part.data, "utf8");
    if (encodedBytes > remainingImageBytes) {
      return boundedText(
        `[Image omitted: encoded payload exceeds the ${
          String(RUNTIME_PI_MAX_IMAGE_BASE64_BYTES)
        }-byte runtime limit.]`,
      );
    }
    remainingImageBytes -= encodedBytes;
    return part;
  });
  return { ...result, content };
}

function runtimeResult(
  toolCallId: string,
  result: AgentToolResult<unknown>,
): RuntimeToolResult {
  const content: RuntimeToolResultPart[] = result.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "file",
          mediaType: part.mimeType,
          data: part.data,
        });
  return {
    callId: toolCallId,
    content: content.length === 0 ? [{ type: "text", text: "" }] : content,
  };
}

function recordedResult<T>(
  toolCallId: string,
  result: AgentToolResult<T>,
  record: RuntimePiCodingToolsOptions["record"],
): AgentToolResult<{ readonly runtimeResult: RuntimeToolResult }> {
  const normalized = runtimeResult(toolCallId, result as AgentToolResult<unknown>);
  record(normalized);
  return {
    content: result.content,
    details: { runtimeResult: normalized },
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.addedToolNames === undefined ? {} : { addedToolNames: result.addedToolNames }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  };
}

export function evidence(label: string, value: string): string {
  const encoded = Buffer.from(value, "utf8");
  const preview = boundedUtf8(value, STRING_PREVIEW_MAX_BYTES);
  return [
    `${label}: ${String(encoded.byteLength)} UTF-8 bytes; sha256:${
      createHash("sha256").update(encoded).digest("hex")
    }.`,
    `${label} escaped preview: ${JSON.stringify(preview)}`,
  ].join("\n");
}

export function combinedSignal(
  turnSignal: AbortSignal,
  signal: AbortSignal | undefined,
): AbortSignal {
  return signal === undefined ? turnSignal : AbortSignal.any([turnSignal, signal]);
}

export async function approvedExecution<T>(
  options: RuntimePiCodingToolsOptions,
  descriptor: RuntimeNativeToolDescriptor,
  toolCallId: string,
  summary: string,
  signal: AbortSignal,
  execute: () => Promise<AgentToolResult<T>>,
): Promise<AgentToolResult<{ readonly runtimeResult: RuntimeToolResult }>> {
  await options.authorize(descriptor, toolCallId, summary, signal);
  options.onToolAttempt();
  return recordedResult(toolCallId, await execute(), options.record);
}

export function renamedTool(
  upstream: Pick<AgentTool, "description" | "executionMode">,
  descriptor: RuntimeNativeToolDescriptor,
  parameters: TSchema,
  execute: AgentTool["execute"],
): AgentTool {
  return {
    name: descriptor.id,
    label: descriptor.displayName,
    description: upstream.description,
    parameters,
    ...(upstream.executionMode === undefined ? {} : { executionMode: upstream.executionMode }),
    execute,
  };
}

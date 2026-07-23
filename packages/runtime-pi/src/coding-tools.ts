import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, glob as globFiles, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  createBashTool,
  createFindTool,
  createGrepTool,
  createLocalBashOperations,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
  type ReadOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
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
  runtimePiBashTool,
  runtimePiGlobTool,
  runtimePiGrepTool,
  runtimePiReadTool,
  runtimePiWebFetchTool,
  runtimePiWriteTool,
} from "./coding-tool-descriptors.js";
import {
  fetchPublicWeb,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_PROMPT_BYTES,
  WEB_FETCH_MAX_URL_BYTES,
  type WebFetchInput,
  type WebFetchOptions,
} from "./web-fetch.js";

const PATH_MAX_BYTES = 4 * 1024;
const STRING_PREVIEW_MAX_BYTES = 1_024;
const WRITE_MAX_CONTENT_BYTES = 256 * 1024;
const BASH_MAX_TIMEOUT_SECONDS = 600;
const SEARCH_MAX_RESULTS = 1_000;
export const RUNTIME_PI_MAX_READ_SOURCE_BYTES = 16 * 1024 * 1024;
export const RUNTIME_PI_MAX_BASH_CAPTURE_BYTES = 1024 * 1024;
const BASH_FORWARD_MAX_BYTES = DEFAULT_MAX_BYTES - 1024;
const BASH_FORWARD_MAX_NEWLINES = DEFAULT_MAX_LINES - 3;
// Pi 0.81.1 resizes images below a 4.5 MiB encoded payload. Keep the same
// explicit ceiling locally so a future upstream regression cannot place an
// unbounded image in the provider context or the recorded runtime result.
export const RUNTIME_PI_MAX_IMAGE_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);
const WEB_FETCH_SAFE_HEADERS = new Set(["accept", "accept-language", "user-agent"]);
const WEB_FETCH_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export {
  runtimePiBashTool,
  runtimePiCodingNativeTools,
  runtimePiGlobTool,
  runtimePiGrepTool,
  runtimePiReadTool,
  runtimePiWebFetchTool,
  runtimePiWriteTool,
} from "./coding-tool-descriptors.js";

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
  readonly webFetch?: Omit<WebFetchOptions, "signal">;
}

function toolError(name: string, message: string): Error {
  return new Error(`${name} failed: ${message}`);
}

function ownRecord(
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

function optionalString(
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

function requiredString(
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

function optionalInteger(
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

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
  name: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw toolError(name, `${key} must be a boolean.`);
  return value;
}

function aliasedString(
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

function outputLimit(input: Record<string, unknown>, name: string): number {
  return optionalInteger(input, "max_output_chars", name, {
    minimum: 1,
    maximum: WEB_FETCH_MAX_OUTPUT_BYTES,
  }) ?? WEB_FETCH_MAX_OUTPUT_BYTES;
}

function effectiveWorkdir(
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

function displayPath(path: string, workdir: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(workdir, path);
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const notice = `\n\n[Tool output truncated to ${String(maxBytes)} UTF-8 bytes.]`;
  const bodyLimit = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
  let end = bodyLimit;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}${notice}`;
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

function evidence(label: string, value: string): string {
  const encoded = Buffer.from(value, "utf8");
  const preview = boundedUtf8(value, STRING_PREVIEW_MAX_BYTES);
  return [
    `${label}: ${String(encoded.byteLength)} UTF-8 bytes; sha256:${
      createHash("sha256").update(encoded).digest("hex")
    }.`,
    `${label} escaped preview: ${JSON.stringify(preview)}`,
  ].join("\n");
}

function combinedSignal(turnSignal: AbortSignal, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? turnSignal : AbortSignal.any([turnSignal, signal]);
}

async function approvedExecution<T>(
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

function renamedTool(
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

function boundedBashOperations(): BashOperations {
  const local = createLocalBashOperations();
  return {
    async exec(command, cwd, input) {
      const overflowController = new AbortController();
      const executionSignal = input.signal === undefined
        ? overflowController.signal
        : AbortSignal.any([input.signal, overflowController.signal]);
      let capturedBytes = 0;
      let forwardedBytes = 0;
      let forwardedNewlines = 0;
      let truncated = false;
      let overflowed = false;
      const onData = (data: Buffer): void => {
        if (overflowed) return;
        capturedBytes += data.byteLength;

        let end = Math.min(
          data.byteLength,
          Math.max(0, BASH_FORWARD_MAX_BYTES - forwardedBytes),
        );
        let newlines = 0;
        const remainingNewlines = Math.max(
          0,
          BASH_FORWARD_MAX_NEWLINES - forwardedNewlines,
        );
        for (let index = 0; index < end; index += 1) {
          if (data[index] !== 0x0a) continue;
          if (newlines >= remainingNewlines) {
            end = index;
            break;
          }
          newlines += 1;
        }
        if (end > 0) {
          input.onData(data.subarray(0, end));
          forwardedBytes += end;
          forwardedNewlines += newlines;
        }
        if (end < data.byteLength) truncated = true;
        if (capturedBytes > RUNTIME_PI_MAX_BASH_CAPTURE_BYTES) {
          overflowed = true;
          overflowController.abort(new Error("Bash output capture limit exceeded."));
        }
      };

      try {
        const result = await local.exec(command, cwd, {
          ...input,
          onData,
          signal: executionSignal,
        });
        if (overflowed) {
          throw toolError(
            "Bash",
            `command output exceeded the ${
              String(RUNTIME_PI_MAX_BASH_CAPTURE_BYTES)
            }-byte hard capture limit.`,
          );
        }
        if (truncated) {
          input.onData(Buffer.from(
            `\n\n[Bash output preview bounded to ${
              String(BASH_FORWARD_MAX_BYTES)
            } bytes; execution produced more output.]`,
            "utf8",
          ));
        }
        return result;
      } catch (error) {
        if (overflowed) {
          throw toolError(
            "Bash",
            `command output exceeded the ${
              String(RUNTIME_PI_MAX_BASH_CAPTURE_BYTES)
            }-byte hard capture limit.`,
          );
        }
        throw error;
      }
    },
  };
}

function supportedImageMimeType(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  const six = header.subarray(0, 6).toString("ascii");
  if (six === "GIF87a" || six === "GIF89a") return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF"
    && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (header[0] === 0x42 && header[1] === 0x4d) return "image/bmp";
  return undefined;
}

const boundedReadOperations: ReadOperations = {
  async access(path) {
    await access(path, constants.R_OK);
  },
  async detectImageMimeType(path) {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
      return supportedImageMimeType(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  },
  async readFile(path) {
    const handle = await open(path, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()
        || !Number.isSafeInteger(metadata.size)
        || metadata.size > RUNTIME_PI_MAX_READ_SOURCE_BYTES) {
        throw toolError(
          "Read",
          `source must be a regular file no larger than ${
            String(RUNTIME_PI_MAX_READ_SOURCE_BYTES)
          } bytes.`,
        );
      }
      const content = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < content.byteLength) {
        const { bytesRead } = await handle.read(
          content,
          offset,
          content.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return content.subarray(0, offset);
    } finally {
      await handle.close();
    }
  },
};

function normalizeBashTimeout(value: number | undefined): number {
  if (value === undefined) return BASH_MAX_TIMEOUT_SECONDS;
  const seconds = value <= BASH_MAX_TIMEOUT_SECONDS ? value : value / 1_000;
  return Math.max(1, Math.min(BASH_MAX_TIMEOUT_SECONDS, seconds));
}

function bashTool(options: RuntimePiCodingToolsOptions): AgentTool {
  const upstream = createBashTool(options.workspaceDirectory);
  const template = {
    ...upstream,
    description:
      "Execute a shell command with a 600-second timeout ceiling, bounded preview, "
      + "and a 1-MiB hard output-capture limit.",
  };
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1 },
      timeout: { type: "integer", minimum: 1 },
      workdir: { type: "string" },
      description: { type: "string" },
      max_output_chars: { type: "integer", minimum: 1, maximum: WEB_FETCH_MAX_OUTPUT_BYTES },
    },
  } as TSchema;
  return renamedTool(template, runtimePiBashTool, parameters, async (
    toolCallId,
    params,
    signal,
    onUpdate,
  ) => {
    const input = ownRecord(params, "Bash", [
      "command", "timeout", "workdir", "description", "max_output_chars",
    ]);
    const command = requiredString(input, "command", "Bash", 256 * 1024);
    const timeout = normalizeBashTimeout(optionalInteger(input, "timeout", "Bash", {
      minimum: 1,
      maximum: 3_600_000,
    }));
    const workdir = effectiveWorkdir(input, "Bash", options.workspaceDirectory);
    const description = optionalString(input, "description", "Bash", 4 * 1024);
    const maxOutputBytes = outputLimit(input, "Bash");
    const tool = createBashTool(workdir, { operations: boundedBashOperations() });
    const executionSignal = combinedSignal(options.turnSignal, signal);
    const summary = [
      "Allow this unsandboxed shell command with inherited process authority?",
      `workdir: ${JSON.stringify(workdir)}`,
      `timeout_seconds: ${String(timeout)}`,
      evidence("command", command),
      ...(description === undefined ? [] : [evidence("description", description)]),
    ].join("\n");
    return approvedExecution(
      options,
      runtimePiBashTool,
      toolCallId,
      summary,
      executionSignal,
      async () => capRuntimePiAgentResult(
        await tool.execute(
          toolCallId,
          { command, timeout },
          executionSignal,
          onUpdate as AgentToolUpdateCallback<unknown> | undefined,
        ),
        maxOutputBytes,
      ),
    );
  });
}

function readTool(options: RuntimePiCodingToolsOptions): AgentTool {
  const upstream = createReadTool(options.workspaceDirectory);
  const template = {
    ...upstream,
    description:
      "Read a text or image file up to 16 MiB, with bounded text and encoded-image results.",
  };
  const parameters = {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      file_path: { type: "string" },
      offset: { type: "integer" },
      start_line: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
      workdir: { type: "string" },
      max_output_chars: { type: "integer", minimum: 1, maximum: WEB_FETCH_MAX_OUTPUT_BYTES },
    },
  } as TSchema;
  return renamedTool(template, runtimePiReadTool, parameters, async (
    toolCallId,
    params,
    signal,
    onUpdate,
  ) => {
    const input = ownRecord(params, "Read", [
      "path", "file_path", "offset", "start_line", "limit", "workdir", "max_output_chars",
    ]);
    const path = aliasedString(input, "path", "file_path", "Read", PATH_MAX_BYTES);
    const workdir = effectiveWorkdir(input, "Read", options.workspaceDirectory);
    const authoredLegacyOffset = optionalInteger(input, "offset", "Read");
    const legacyOffset = authoredLegacyOffset === undefined
      ? undefined
      : Math.max(0, authoredLegacyOffset);
    const startLine = optionalInteger(input, "start_line", "Read", { minimum: 1 });
    const offsetLine = legacyOffset === undefined ? undefined : Math.max(1, legacyOffset + 1);
    if (startLine !== undefined && offsetLine !== undefined && startLine !== offsetLine) {
      throw toolError("Read", "offset and start_line conflict.");
    }
    const upstreamOffset = startLine ?? offsetLine;
    const limit = optionalInteger(input, "limit", "Read", { minimum: 1, maximum: 100_000 });
    const maxOutputBytes = outputLimit(input, "Read");
    const tool = createReadTool(workdir, { operations: boundedReadOperations });
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiReadTool,
      toolCallId,
      [
        "Allow this unsandboxed file read?",
        `path: ${JSON.stringify(displayPath(path, workdir))}`,
        `start_line: ${String(upstreamOffset ?? 1)}`,
        `limit: ${limit === undefined ? "<default>" : String(limit)}`,
      ].join("\n"),
      executionSignal,
      async () => capRuntimePiAgentResult(
        await tool.execute(
          toolCallId,
          {
            path,
            ...(upstreamOffset === undefined ? {} : { offset: upstreamOffset }),
            ...(limit === undefined ? {} : { limit }),
          },
          executionSignal,
          onUpdate as AgentToolUpdateCallback<unknown> | undefined,
        ),
        maxOutputBytes,
      ),
    );
  });
}

function writeTool(options: RuntimePiCodingToolsOptions): AgentTool {
  const template = createWriteTool(options.workspaceDirectory);
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["content"],
    properties: {
      path: { type: "string" },
      file_path: { type: "string" },
      content: { type: "string" },
      workdir: { type: "string" },
    },
  } as TSchema;
  return renamedTool(template, runtimePiWriteTool, parameters, async (
    toolCallId,
    params,
    signal,
    onUpdate,
  ) => {
    const input = ownRecord(params, "Write", ["path", "file_path", "content", "workdir"]);
    const path = aliasedString(input, "path", "file_path", "Write", PATH_MAX_BYTES);
    const content = requiredString(
      input,
      "content",
      "Write",
      WRITE_MAX_CONTENT_BYTES,
      true,
    );
    const workdir = effectiveWorkdir(input, "Write", options.workspaceDirectory);
    const tool = createWriteTool(workdir);
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiWriteTool,
      toolCallId,
      [
        "Allow this unsandboxed file creation or complete overwrite?",
        `path: ${JSON.stringify(displayPath(path, workdir))}`,
        evidence("content", content),
      ].join("\n"),
      executionSignal,
      () => tool.execute(
        toolCallId,
        { path, content },
        executionSignal,
        onUpdate as AgentToolUpdateCallback<unknown> | undefined,
      ),
    );
  });
}

async function localGlob(
  pattern: string,
  cwd: string,
  input: { readonly ignore: string[]; readonly limit: number },
): Promise<string[]> {
  const results: string[] = [];
  for await (const match of globFiles(pattern, {
    cwd,
    exclude: input.ignore,
    withFileTypes: false,
  })) {
    results.push(resolve(cwd, match));
    if (results.length >= input.limit) break;
  }
  return results;
}

function globTool(options: RuntimePiCodingToolsOptions): AgentTool {
  const findOptions = {
    operations: {
      async exists(path: string) {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      glob: localGlob,
    },
  };
  const template = createFindTool(options.workspaceDirectory, findOptions);
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_RESULTS },
      workdir: { type: "string" },
      max_output_chars: { type: "integer", minimum: 1, maximum: WEB_FETCH_MAX_OUTPUT_BYTES },
    },
  } as TSchema;
  return renamedTool(template, runtimePiGlobTool, parameters, async (
    toolCallId,
    params,
    signal,
    onUpdate,
  ) => {
    const input = ownRecord(params, "Glob", [
      "pattern", "path", "limit", "workdir", "max_output_chars",
    ]);
    const pattern = requiredString(input, "pattern", "Glob", 4 * 1024);
    const path = optionalString(input, "path", "Glob", PATH_MAX_BYTES);
    const limit = optionalInteger(input, "limit", "Glob", {
      minimum: 1,
      maximum: SEARCH_MAX_RESULTS,
    }) ?? 100;
    const workdir = effectiveWorkdir(input, "Glob", options.workspaceDirectory);
    const maxOutputBytes = outputLimit(input, "Glob");
    const tool = createFindTool(workdir, findOptions);
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiGlobTool,
      toolCallId,
      [
        "Allow this unsandboxed filesystem glob?",
        `path: ${JSON.stringify(displayPath(path ?? ".", workdir))}`,
        `limit: ${String(limit)}`,
        evidence("pattern", pattern),
      ].join("\n"),
      executionSignal,
      async () => capRuntimePiAgentResult(
        await tool.execute(
          toolCallId,
          { pattern, ...(path === undefined ? {} : { path }), limit },
          executionSignal,
          onUpdate as AgentToolUpdateCallback<unknown> | undefined,
        ),
        maxOutputBytes,
      ),
    );
  });
}

function matchedLines(text: string): { readonly path: string; readonly line: string }[] {
  return text.split("\n").flatMap((line) => {
    const match = /^(.*):(\d+): /u.exec(line);
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [{ path: match[1], line: match[2] }];
  });
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function grepPartialNotice(result: AgentToolResult<unknown>): string | undefined {
  const matchLimit = dataProperty(result.details, "matchLimitReached");
  const truncation = dataProperty(result.details, "truncation");
  const reasons: string[] = [];
  if (Number.isSafeInteger(matchLimit) && (matchLimit as number) > 0) {
    reasons.push(`upstream stopped at its ${String(matchLimit)}-match limit`);
  }
  if (dataProperty(truncation, "truncated") === true) {
    reasons.push("upstream output reached its byte limit");
  }
  return reasons.length === 0
    ? undefined
    : `[PARTIAL Grep projection: ${reasons.join(
      " and ",
    )}; files and counts below are incomplete. Refine the pattern or increase head_limit.]`;
}

function grepOutputMode(
  result: AgentToolResult<unknown>,
  mode: "content" | "files_with_matches" | "count",
): AgentToolResult<unknown> {
  if (mode === "content") return result;
  const text = result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const matches = matchedLines(text);
  if (matches.length === 0) {
    return { ...result, content: [{ type: "text", text: "No matches found." }] };
  }
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  const sortedCounts = [...counts].sort(([left], [right]) => left.localeCompare(right));
  const projection = mode === "files_with_matches"
    ? sortedCounts.map(([path]) => path).join("\n")
    : sortedCounts.map(([path, count]) => `${path}:${String(count)}`).join("\n");
  const partialNotice = grepPartialNotice(result);
  const output = partialNotice === undefined
    ? projection
    : `${partialNotice}\n${projection}`;
  return { ...result, content: [{ type: "text", text: output }] };
}

function grepTool(options: RuntimePiCodingToolsOptions): AgentTool {
  const template = createGrepTool(options.workspaceDirectory);
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string" },
      glob: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      context: { type: "integer", minimum: 0 },
      case_insensitive: { type: "boolean" },
      ignoreCase: { type: "boolean" },
      head_limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_RESULTS },
      limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_RESULTS },
      workdir: { type: "string" },
      max_output_chars: { type: "integer", minimum: 1, maximum: WEB_FETCH_MAX_OUTPUT_BYTES },
    },
  } as TSchema;
  return renamedTool(template, runtimePiGrepTool, parameters, async (
    toolCallId,
    params,
    signal,
    onUpdate,
  ) => {
    const input = ownRecord(params, "Grep", [
      "pattern", "path", "glob", "output_mode", "context", "case_insensitive",
      "ignoreCase", "head_limit", "limit", "workdir", "max_output_chars",
    ]);
    const pattern = requiredString(input, "pattern", "Grep", 4 * 1024);
    const path = optionalString(input, "path", "Grep", PATH_MAX_BYTES);
    const glob = optionalString(input, "glob", "Grep", 4 * 1024);
    const outputModeValue = optionalString(input, "output_mode", "Grep", 64)
      ?? "files_with_matches";
    if (!["files_with_matches", "content", "count"].includes(outputModeValue)) {
      throw toolError("Grep", "output_mode is unsupported.");
    }
    const outputMode = outputModeValue as "content" | "files_with_matches" | "count";
    const context = optionalInteger(input, "context", "Grep", { minimum: 0, maximum: 1_000 });
    const legacyIgnoreCase = optionalBoolean(input, "case_insensitive", "Grep");
    const nativeIgnoreCase = optionalBoolean(input, "ignoreCase", "Grep");
    if (legacyIgnoreCase !== undefined
      && nativeIgnoreCase !== undefined
      && legacyIgnoreCase !== nativeIgnoreCase) {
      throw toolError("Grep", "case_insensitive and ignoreCase conflict.");
    }
    const ignoreCase = legacyIgnoreCase ?? nativeIgnoreCase;
    const headLimit = optionalInteger(input, "head_limit", "Grep", {
      minimum: 1,
      maximum: SEARCH_MAX_RESULTS,
    });
    const nativeLimit = optionalInteger(input, "limit", "Grep", {
      minimum: 1,
      maximum: SEARCH_MAX_RESULTS,
    });
    if (headLimit !== undefined && nativeLimit !== undefined && headLimit !== nativeLimit) {
      throw toolError("Grep", "head_limit and limit conflict.");
    }
    const limit = headLimit ?? nativeLimit ?? 100;
    const workdir = effectiveWorkdir(input, "Grep", options.workspaceDirectory);
    const maxOutputBytes = outputLimit(input, "Grep");
    const tool = createGrepTool(workdir);
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiGrepTool,
      toolCallId,
      [
        "Allow this unsandboxed ripgrep search?",
        `path: ${JSON.stringify(displayPath(path ?? ".", workdir))}`,
        `glob: ${JSON.stringify(glob ?? "<none>")}`,
        `output_mode: ${outputMode}`,
        `limit: ${String(limit)}`,
        evidence("pattern", pattern),
      ].join("\n"),
      executionSignal,
      async () => capRuntimePiAgentResult(
        grepOutputMode(
          await tool.execute(
            toolCallId,
            {
              pattern,
              ...(path === undefined ? {} : { path }),
              ...(glob === undefined ? {} : { glob }),
              ...(ignoreCase === undefined ? {} : { ignoreCase }),
              ...(context === undefined || outputMode !== "content" ? {} : { context }),
              limit,
            },
            executionSignal,
            onUpdate as AgentToolUpdateCallback<unknown> | undefined,
          ),
          outputMode,
        ),
        maxOutputBytes,
      ),
    );
  });
}

function headersRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw toolError("WebFetch", "headers must be an object.");
  }
  const record = ownRecord(
    value,
    "WebFetch headers",
    Reflect.ownKeys(value).flatMap((key) => typeof key === "string" ? [key] : []),
  );
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [key, headerValue] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) {
      throw toolError("WebFetch", `header ${JSON.stringify(key)} is duplicated.`);
    }
    seen.add(normalized);
    if (WEB_FETCH_CREDENTIAL_HEADERS.has(normalized)) {
      throw toolError("WebFetch", `credential header ${JSON.stringify(key)} is forbidden.`);
    }
    if (!WEB_FETCH_SAFE_HEADERS.has(normalized)) {
      throw toolError("WebFetch", `header ${JSON.stringify(key)} is not allowed.`);
    }
    if (typeof headerValue !== "string"
      || headerValue.includes("\r")
      || headerValue.includes("\n")
      || Buffer.byteLength(headerValue, "utf8") > 4 * 1024) {
      throw toolError("WebFetch", `header ${JSON.stringify(key)} must be a string.`);
    }
    output[key] = headerValue;
  }
  return Object.freeze(output);
}

function webFetchTool(options: RuntimePiCodingToolsOptions): AgentTool {
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1, maxLength: WEB_FETCH_MAX_URL_BYTES },
      prompt: { type: "string", maxLength: WEB_FETCH_MAX_PROMPT_BYTES },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      max_output_chars: { type: "integer", minimum: 1, maximum: WEB_FETCH_MAX_OUTPUT_BYTES },
    },
  } as TSchema;
  const template: AgentTool = {
    name: "WebFetch",
    label: "Web Fetch",
    description:
      "Fetch bounded UTF-8 text from a public HTTPS URL with DNS-pinned SSRF protection.",
    parameters,
    async execute() {
      throw new Error("unreachable");
    },
  };
  return renamedTool(template, runtimePiWebFetchTool, parameters, async (
    toolCallId,
    params,
    signal,
  ) => {
    const input = ownRecord(params, "WebFetch", [
      "url", "prompt", "headers", "max_output_chars",
    ]);
    const url = requiredString(input, "url", "WebFetch", WEB_FETCH_MAX_URL_BYTES);
    const prompt = optionalString(input, "prompt", "WebFetch", WEB_FETCH_MAX_PROMPT_BYTES);
    const headers = headersRecord(input.headers);
    const maxOutputBytes = outputLimit(input, "WebFetch");
    const fetchInput: WebFetchInput = {
      url,
      ...(prompt === undefined ? {} : { prompt }),
      headers,
      maxOutputBytes,
    };
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiWebFetchTool,
      toolCallId,
      [
        "Allow this DNS-pinned public HTTPS request?",
        evidence("url", url),
        `header_names: ${JSON.stringify(Object.keys(headers).map((name) => name.toLowerCase()).sort())}`,
        ...(prompt === undefined ? [] : [evidence("prompt", prompt)]),
      ].join("\n"),
      executionSignal,
      async () => ({
        content: [{
          type: "text",
          text: await fetchPublicWeb(fetchInput, {
            ...options.webFetch,
            signal: executionSignal,
          }),
        }],
        details: undefined,
      }),
    );
  });
}

export function createRuntimePiCodingTools(
  options: RuntimePiCodingToolsOptions,
): AgentTool[] {
  return [
    readTool(options),
    writeTool(options),
    globTool(options),
    grepTool(options),
    bashTool(options),
    webFetchTool(options),
  ];
}

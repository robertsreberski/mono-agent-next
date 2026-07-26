// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import { createRuntimePiCodingTools } from "./coding-tools.js";
import {
  editLiteralFile,
  type LiteralEditInput,
  validateLiteralEditInput,
} from "./edit.js";
import {
  formatWebSearchResults,
  searchWeb,
  type WebSearchInput,
  validateWebSearchInput,
} from "./web-search.js";

const REQUEST_MAX_BYTES = 1024 * 1024;
const TOOL_IDS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
]);

interface WorkerRequest {
  readonly toolId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly workspaceDirectory: string;
}

const execution = new AbortController();
let terminationExitCode: number | undefined;

function terminate(signal: NodeJS.Signals, exitCode: number): void {
  terminationExitCode ??= exitCode;
  process.exitCode = terminationExitCode;
  execution.abort(new DOMException(
    `Sandbox tool worker received ${signal}.`,
    "AbortError",
  ));
}

process.once("SIGINT", () => terminate("SIGINT", 130));
process.once("SIGTERM", () => terminate("SIGTERM", 143));

async function readRequest(): Promise<WorkerRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > REQUEST_MAX_BYTES) throw new Error("Sandbox tool request is too large.");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Sandbox tool request is malformed.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandbox tool request must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3
    || keys[0] !== "params"
    || keys[1] !== "toolId"
    || keys[2] !== "workspaceDirectory"
  ) {
    throw new Error("Sandbox tool request has unknown fields.");
  }
  const toolId = Reflect.get(value, "toolId");
  const params = Reflect.get(value, "params");
  const workspaceDirectory = Reflect.get(value, "workspaceDirectory");
  if (
    typeof toolId !== "string"
    || !TOOL_IDS.has(toolId)
    || params === null
    || typeof params !== "object"
    || Array.isArray(params)
    || typeof workspaceDirectory !== "string"
    || workspaceDirectory.length === 0
  ) {
    throw new Error("Sandbox tool request is invalid.");
  }
  return {
    toolId,
    params: params as Readonly<Record<string, unknown>>,
    workspaceDirectory,
  };
}

async function executeCodingTool(
  request: WorkerRequest,
  signal: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const tools = createRuntimePiCodingTools({
    workspaceDirectory: request.workspaceDirectory,
    turnSignal: signal,
    async authorize() {},
    record() {},
    onToolAttempt() {},
  });
  const tool = tools.find(({ name }) => name === request.toolId);
  if (tool === undefined) throw new Error("Sandbox tool is unavailable.");
  return await (tool as AgentTool).execute(
    "sandbox-worker",
    request.params,
    signal,
    undefined,
  );
}

async function executeEdit(
  request: WorkerRequest,
  signal: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  signal.throwIfAborted();
  const input: LiteralEditInput = {
    filePath: Reflect.get(request.params, "file_path"),
    oldString: Reflect.get(request.params, "old_string"),
    newString: Reflect.get(request.params, "new_string"),
    replaceAll: Reflect.get(request.params, "replace_all") ?? false,
  } as LiteralEditInput;
  validateLiteralEditInput(input);
  const edited = await editLiteralFile(
    request.workspaceDirectory,
    input,
    { signal },
  );
  signal.throwIfAborted();
  return {
    content: [{
      type: "text",
      text: [
        `Edited ${JSON.stringify(edited.path)} with `
        + `${String(edited.replacements)} literal replacement`
        + `${edited.replacements === 1 ? "" : "s"}.`,
        `Bytes: ${String(edited.bytesBefore)} -> ${String(edited.bytesAfter)}.`,
        `SHA-256: ${edited.sha256Before} -> ${edited.sha256After}.`,
      ].join("\n"),
    }],
    details: undefined,
  };
}

async function executeWebSearch(
  request: WorkerRequest,
  signal: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const input: WebSearchInput = {
    query: Reflect.get(request.params, "query"),
    limit: Reflect.get(request.params, "limit") ?? 5,
  } as WebSearchInput;
  validateWebSearchInput(input);
  const results = await searchWeb(input, { signal });
  return {
    content: [{ type: "text", text: formatWebSearchResults(results) }],
    details: undefined,
  };
}

async function main(signal: AbortSignal): Promise<void> {
  const request = await readRequest();
  signal.throwIfAborted();
  const result = request.toolId === "Edit"
    ? await executeEdit(request, signal)
    : request.toolId === "WebSearch"
      ? await executeWebSearch(request, signal)
      : await executeCodingTool(request, signal);
  signal.throwIfAborted();
  // The parent reconstructs a transport-neutral result from model-visible
  // content. Do not duplicate that content through Pi's runtimeResult details
  // or forward other worker-local metadata into the sandbox envelope.
  process.stdout.write(JSON.stringify({
    ok: true,
    result: { content: result.content },
  }));
}

void main(execution.signal).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Sandbox tool failed.";
  process.stdout.write(JSON.stringify({ ok: false, error: message.slice(0, 4_096) }));
  if (terminationExitCode !== undefined) process.exitCode = terminationExitCode;
});

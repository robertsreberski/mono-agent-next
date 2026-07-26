// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  truncateHead,
  truncateLine,
  type AgentTool,
  type AgentToolResult,
  type TruncationResult,
} from "@earendil-works/pi-agent-core";
import type { TextContent, TSchema } from "@earendil-works/pi-ai";

import { runtimePiGrepTool } from "./coding-tool-descriptors.js";
import {
  approvedExecution,
  capRuntimePiAgentResult,
  combinedSignal,
  displayPath,
  effectiveWorkdir,
  evidence,
  executionBoundarySummary,
  optionalBoolean,
  optionalInteger,
  optionalString,
  outputLimit,
  ownRecord,
  PATH_MAX_BYTES,
  renamedTool,
  requiredString,
  toolError,
  type RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";
import { WEB_FETCH_MAX_OUTPUT_BYTES } from "./web-fetch.js";

const SEARCH_MAX_RESULTS = 1_000;
const GREP_MAX_FILE_BYTES = 16 * 1024 * 1024;
const GREP_MAX_STDERR_BYTES = 64 * 1024;
const GREP_MAX_MATCH_COLUMNS = 4_096;
const GREP_MAX_JSON_LINE_BYTES = 256 * 1024;
const GREP_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

interface GrepMatch {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
}

interface GrepDetails {
  readonly matchLimitReached?: number;
  readonly streamTruncated?: boolean;
  readonly truncation?: TruncationResult;
  readonly linesTruncated?: boolean;
}

function grepPath(searchPath: string, isDirectory: boolean, filePath: string): string {
  return (isDirectory ? relative(searchPath, filePath) : basename(filePath))
    .split(sep)
    .join("/");
}

function absoluteGrepMatchPath(
  searchPath: string,
  searchIsDirectory: boolean,
  filePath: string,
): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return resolve(searchIsDirectory ? searchPath : dirname(searchPath), filePath);
}

async function grepFileLines(path: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    signal.throwIfAborted();
    if (!metadata.isFile()
      || !Number.isSafeInteger(metadata.size)
      || metadata.size > GREP_MAX_FILE_BYTES) {
      return [];
    }
    const content = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < content.byteLength) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return content.subarray(0, offset)
      .toString("utf8")
      .replace(/\r\n/gu, "\n")
      .replace(/\r/gu, "\n")
      .split("\n");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function formatGrepMatches(
  matches: readonly GrepMatch[],
  searchPath: string,
  searchIsDirectory: boolean,
  context: number,
  signal: AbortSignal,
): Promise<{ readonly lines: string[]; readonly truncated: boolean }> {
  const output: string[] = [];
  let outputBytes = 0;
  let loadedPath: string | undefined;
  let loadedLines: string[] = [];
  let truncated = false;
  const append = (line: string): boolean => {
    outputBytes += Buffer.byteLength(line, "utf8") + (output.length === 0 ? 0 : 1);
    output.push(line);
    return outputBytes <= DEFAULT_MAX_BYTES;
  };
  matchLoop:
  for (const match of matches) {
    signal.throwIfAborted();
    const path = grepPath(searchPath, searchIsDirectory, match.filePath);
    if (context === 0) {
      const normalized = match.lineText
        .replace(/\r\n/gu, "\n")
        .replace(/\r/gu, "")
        .replace(/\n$/u, "");
      const line = truncateLine(normalized);
      truncated ||= line.wasTruncated;
      if (!append(`${path}:${String(match.lineNumber)}: ${line.text}`)) break;
      continue;
    }
    if (loadedPath !== match.filePath) {
      try {
        loadedLines = await grepFileLines(match.filePath, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        loadedLines = [];
      }
      loadedPath = match.filePath;
    }
    if (loadedLines.length === 0) {
      if (!append(`${path}:${String(match.lineNumber)}: (unable to read file)`)) break;
      continue;
    }
    const start = Math.max(1, match.lineNumber - context);
    const end = Math.min(loadedLines.length, match.lineNumber + context);
    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      const line = truncateLine((loadedLines[lineNumber - 1] ?? "").replace(/\r/gu, ""));
      truncated ||= line.wasTruncated;
      if (!append(
        lineNumber === match.lineNumber
          ? `${path}:${String(lineNumber)}: ${line.text}`
          : `${path}-${String(lineNumber)}- ${line.text}`,
      )) break matchLoop;
    }
  }
  return { lines: output, truncated };
}

async function runRipgrep(input: {
  readonly context: number;
  readonly glob?: string;
  readonly ignoreCase: boolean;
  readonly limit: number;
  readonly pattern: string;
  readonly searchPath: string;
  readonly signal: AbortSignal;
}): Promise<AgentToolResult<GrepDetails | undefined>> {
  input.signal.throwIfAborted();
  const metadata = await stat(input.searchPath);
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw toolError("Grep", "path must be a regular file or directory.");
  }
  input.signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const args = [
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--max-columns",
      String(GREP_MAX_MATCH_COLUMNS),
      "--max-columns-preview",
      ...(input.ignoreCase ? ["--ignore-case"] : []),
      ...(input.glob === undefined ? [] : ["--glob", input.glob]),
      "--",
      input.pattern,
      input.searchPath,
    ];
    const child = spawn("rg", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const matches: GrepMatch[] = [];
    let pendingStdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let killedForLimit = false;
    let killedForStreamLimit = false;
    const cleanup = (): void => {
      input.signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const stop = (): void => {
      if (!child.killed) child.kill();
    };
    const onAbort = (): void => {
      stop();
      settle(() => reject(input.signal.reason ?? toolError("Grep", "operation aborted.")));
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") >= GREP_MAX_STDERR_BYTES) return;
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > GREP_MAX_STDERR_BYTES) {
        stderr = Buffer.from(stderr, "utf8")
          .subarray(0, GREP_MAX_STDERR_BYTES)
          .toString("utf8");
      }
    });
    const acceptJsonLine = (line: string): void => {
      if (matches.length >= input.limit) return;
      try {
        const event = JSON.parse(line) as {
          readonly type?: string;
          readonly data?: {
            readonly path?: { readonly text?: string };
            readonly line_number?: number;
            readonly lines?: { readonly text?: string };
          };
        };
        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const lineText = event.data?.lines?.text;
        if (event.type !== "match"
          || typeof filePath !== "string"
          || !Number.isSafeInteger(lineNumber)
          || typeof lineText !== "string") return;
        matches.push({
          filePath: absoluteGrepMatchPath(
            input.searchPath,
            metadata.isDirectory(),
            filePath,
          ),
          lineNumber: lineNumber as number,
          lineText,
        });
        if (matches.length >= input.limit) {
          killedForLimit = true;
          stop();
        }
      } catch {
        // Ignore non-JSON diagnostic lines; a non-zero exit still fails below.
      }
    };
    const stopForStreamLimit = (): void => {
      if (killedForStreamLimit) return;
      killedForStreamLimit = true;
      pendingStdout = "";
      stop();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (killedForLimit || killedForStreamLimit) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > GREP_MAX_STDOUT_BYTES) {
        stopForStreamLimit();
        return;
      }
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline < 0) break;
        const line = `${pendingStdout}${chunk.slice(start, newline)}`.replace(/\r$/u, "");
        pendingStdout = "";
        if (Buffer.byteLength(line, "utf8") > GREP_MAX_JSON_LINE_BYTES) {
          stopForStreamLimit();
          return;
        }
        acceptJsonLine(line);
        if (killedForLimit) return;
        start = newline + 1;
      }
      pendingStdout += chunk.slice(start);
      if (Buffer.byteLength(pendingStdout, "utf8") > GREP_MAX_JSON_LINE_BYTES) {
        stopForStreamLimit();
      }
    });
    child.once("error", (error) => {
      settle(() => reject(
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? toolError("Grep", "ripgrep (rg) is required but was not found on PATH.")
          : toolError("Grep", error.message),
      ));
    });
    child.once("close", (code) => {
      void (async () => {
        if (!killedForLimit && !killedForStreamLimit && pendingStdout.length > 0) {
          acceptJsonLine(pendingStdout.replace(/\r$/u, ""));
        }
        pendingStdout = "";
        if (!killedForLimit && !killedForStreamLimit && code !== 0 && code !== 1) {
          throw toolError(
            "Grep",
            stderr.trim() || `ripgrep exited with code ${String(code)}.`,
          );
        }
        if (matches.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: killedForStreamLimit
                ? "No complete matches available\n\n"
                  + "[Ripgrep output exceeded the bounded stream limit; results are partial]"
                : "No matches found",
            }],
            details: killedForStreamLimit ? { streamTruncated: true } : undefined,
          };
        }
        const formatted = await formatGrepMatches(
          matches,
          input.searchPath,
          metadata.isDirectory(),
          input.context,
          input.signal,
        );
        const truncation = truncateHead(formatted.lines.join("\n"), {
          maxLines: Number.MAX_SAFE_INTEGER,
        });
        const details: {
          matchLimitReached?: number;
          streamTruncated?: boolean;
          truncation?: TruncationResult;
          linesTruncated?: boolean;
        } = {};
        const notices: string[] = [];
        if (killedForLimit) {
          details.matchLimitReached = input.limit;
          notices.push(`${String(input.limit)} matches limit reached`);
        }
        if (killedForStreamLimit) {
          details.streamTruncated = true;
          notices.push("ripgrep output exceeded the bounded stream limit");
        }
        if (truncation.truncated) {
          details.truncation = truncation;
          notices.push(`${String(DEFAULT_MAX_BYTES)}-byte output limit reached`);
        }
        if (formatted.truncated) {
          details.linesTruncated = true;
          notices.push("some matching lines were truncated");
        }
        const text = notices.length === 0
          ? truncation.content
          : `${truncation.content}\n\n[${notices.join(". ")}]`;
        return {
          content: [{ type: "text" as const, text }],
          details: Object.keys(details).length === 0 ? undefined : details,
        };
      })().then(
        (result) => settle(() => resolvePromise(result)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
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
  const streamTruncated = dataProperty(result.details, "streamTruncated");
  const truncation = dataProperty(result.details, "truncation");
  const reasons: string[] = [];
  if (Number.isSafeInteger(matchLimit) && (matchLimit as number) > 0) {
    reasons.push(`upstream stopped at its ${String(matchLimit)}-match limit`);
  }
  if (dataProperty(truncation, "truncated") === true) {
    reasons.push("upstream output reached its byte limit");
  }
  if (streamTruncated === true) {
    reasons.push("ripgrep output reached its stream limit");
  }
  return reasons.length === 0
    ? undefined
    : `[PARTIAL Grep projection: ${reasons.join(
      " and ",
    )}; files and counts below are incomplete. Refine the pattern or increase head_limit.]`;
}

export function grepOutputMode(
  result: AgentToolResult<unknown>,
  mode: "content" | "files_with_matches" | "count",
): AgentToolResult<unknown> {
  if (mode === "content") return result;
  const text = result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const matches = matchedLines(text);
  const partialNotice = grepPartialNotice(result);
  if (matches.length === 0) {
    const output = partialNotice === undefined
      ? "No matches found."
      : `${partialNotice}\nNo complete match records were available in the bounded output.`;
    return { ...result, content: [{ type: "text", text: output }] };
  }
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  const sortedCounts = [...counts].sort(([left], [right]) => left.localeCompare(right));
  const projection = mode === "files_with_matches"
    ? sortedCounts.map(([path]) => path).join("\n")
    : sortedCounts.map(([path, count]) => `${path}:${String(count)}`).join("\n");
  const output = partialNotice === undefined
    ? projection
    : `${partialNotice}\n${projection}`;
  return { ...result, content: [{ type: "text", text: output }] };
}

export function createRuntimePiGrepAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const template = {
    description:
      "Search file contents with ripgrep. Returns bounded matching lines with file paths "
      + "and line numbers while respecting ignore files.",
  };
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
    const searchPath = displayPath(path ?? ".", workdir);
    const executionContext = context === undefined || outputMode !== "content"
      ? 0
      : context;
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiGrepTool,
      toolCallId,
      [
        executionBoundarySummary(
          options,
          "Allow this ripgrep search through the selected Core sandbox?",
          "Allow this unsandboxed ripgrep search?",
        ),
        `path: ${JSON.stringify(searchPath)}`,
        `glob: ${JSON.stringify(glob ?? "<none>")}`,
        `output_mode: ${outputMode}`,
        `limit: ${String(limit)}`,
        evidence("pattern", pattern),
      ].join("\n"),
      executionSignal,
      async () => {
        if (options.sandboxTools !== undefined) {
          return capRuntimePiAgentResult(
            await options.sandboxTools.execute(
              runtimePiGrepTool.id,
              {
                pattern,
                path: searchPath,
                ...(glob === undefined ? {} : { glob }),
                output_mode: outputMode,
                context: executionContext,
                ignoreCase: ignoreCase ?? false,
                limit,
                max_output_chars: maxOutputBytes,
              },
              executionSignal,
            ),
            maxOutputBytes,
          );
        }
        return capRuntimePiAgentResult(
          grepOutputMode(
            await runRipgrep({
              pattern,
              searchPath,
              ...(glob === undefined ? {} : { glob }),
              ignoreCase: ignoreCase ?? false,
              context: executionContext,
              limit,
              signal: executionSignal,
            }),
            outputMode,
          ),
          maxOutputBytes,
        );
      },
    );
  });
}

// SPDX-License-Identifier: MIT
import type { Dir, Dirent } from "node:fs";
import { access, opendir } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  truncateHead,
  type AgentTool,
  type TruncationResult,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

import { runtimePiGlobTool } from "./coding-tool-descriptors.js";
import {
  approvedExecution,
  capRuntimePiAgentResult,
  combinedSignal,
  displayPath,
  effectiveWorkdir,
  evidence,
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
export const RUNTIME_PI_GLOB_MAX_VISITED_ENTRIES = 100_000;
export const RUNTIME_PI_GLOB_TIMEOUT_MS = 15_000;

function checkedGlobBound(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
    throw toolError(
      "Glob",
      `${label} must be a positive safe integer no greater than ${String(fallback)}.`,
    );
  }
  return value;
}

async function openGlobDirectory(path: string, signal: AbortSignal): Promise<Dir> {
  signal.throwIfAborted();
  return new Promise<Dir>((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(signal.reason ?? toolError("Glob", "operation aborted.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void opendir(path).then(
      (directory) => {
        if (settled) {
          void directory.close().catch(() => undefined);
          return;
        }
        finish(() => resolvePromise(directory));
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function readGlobDirectory(
  directory: Dir,
  signal: AbortSignal,
): Promise<Dirent | null> {
  signal.throwIfAborted();
  return new Promise<Dirent | null>((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(signal.reason ?? toolError("Glob", "operation aborted.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void directory.read().then(
      (entry) => {
        if (settled) {
          if (signal.aborted) void directory.close().catch(() => undefined);
          return;
        }
        finish(() => resolvePromise(entry));
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function posixRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function ignoredGlobPath(
  relativePath: string,
  isDirectory: boolean,
  patterns: readonly string[],
): boolean {
  const candidate = isDirectory ? `${relativePath}/` : relativePath;
  return patterns.some((pattern) =>
    matchesGlob(relativePath, pattern) || matchesGlob(candidate, pattern));
}

function compareGlobPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function retainLexicographicallySmallest(
  results: string[],
  candidate: string,
  limit: number,
): void {
  let lower = 0;
  let upper = results.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (compareGlobPaths(results[middle] ?? "", candidate) < 0) lower = middle + 1;
    else upper = middle;
  }
  if (lower >= limit) return;
  results.splice(lower, 0, candidate);
  if (results.length > limit) results.pop();
}

export async function runRuntimePiGlobTraversal(
  pattern: string,
  cwd: string,
  input: {
    readonly ignore: string[];
    readonly limit: number;
    readonly maxVisitedEntries: number;
    readonly signal: AbortSignal;
  },
): Promise<string[]> {
  const results: string[] = [];
  const directories = [resolve(cwd)];
  let visitedEntries = 0;
  while (directories.length > 0) {
    input.signal.throwIfAborted();
    const directoryPath = directories.pop();
    if (directoryPath === undefined) break;
    const directory = await openGlobDirectory(directoryPath, input.signal);
    try {
      for (;;) {
        const entry = await readGlobDirectory(directory, input.signal);
        if (entry === null) break;
        visitedEntries += 1;
        if (visitedEntries > input.maxVisitedEntries) {
          throw toolError(
            "Glob",
            `traversal exceeded the ${String(input.maxVisitedEntries)}-entry limit.`,
          );
        }
        const absolutePath = resolve(directoryPath, entry.name);
        const relativePath = posixRelativePath(cwd, absolutePath);
        if (ignoredGlobPath(relativePath, entry.isDirectory(), input.ignore)) continue;
        if (entry.isDirectory()) {
          directories.push(absolutePath);
          continue;
        }
        const candidate = isAbsolute(pattern) ? absolutePath : relativePath;
        if (matchesGlob(candidate, pattern)) {
          retainLexicographicallySmallest(results, absolutePath, input.limit);
        }
      }
    } finally {
      const closing = directory.close().catch(() => undefined);
      if (input.signal.aborted) void closing;
      else await closing;
    }
  }
  return results;
}

export function createRuntimePiGlobAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const template = {
    description:
      "Search for files by glob pattern without following directory symlinks. "
      + "Excludes node_modules and .git, caps traversal at 100,000 entries and 15 seconds, "
      + "and returns at most the requested result limit.",
  };
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
    const executionSignal = combinedSignal(options.turnSignal, signal);
    const maxVisitedEntries = checkedGlobBound(
      options.glob?.maxVisitedEntries,
      RUNTIME_PI_GLOB_MAX_VISITED_ENTRIES,
      "maxVisitedEntries",
    );
    const timeoutMs = checkedGlobBound(
      options.glob?.timeoutMs,
      RUNTIME_PI_GLOB_TIMEOUT_MS,
      "timeoutMs",
    );
    return approvedExecution(
      options,
      runtimePiGlobTool,
      toolCallId,
      [
        "Allow this unsandboxed filesystem glob?",
        `path: ${JSON.stringify(displayPath(path ?? ".", workdir))}`,
        `limit: ${String(limit)}`,
        `traversal_entry_limit: ${String(maxVisitedEntries)}`,
        `traversal_deadline_ms: ${String(timeoutMs)}`,
        evidence("pattern", pattern),
      ].join("\n"),
      executionSignal,
      async () => {
        const deadlineSignal = AbortSignal.timeout(timeoutMs);
        const traversalSignal = AbortSignal.any([executionSignal, deadlineSignal]);
        const searchPath = displayPath(path ?? ".", workdir);
        try {
          traversalSignal.throwIfAborted();
          await access(searchPath);
          const results = await runRuntimePiGlobTraversal(pattern, searchPath, {
            ignore: ["**/node_modules/**", "**/.git/**"],
            limit,
            maxVisitedEntries,
            signal: traversalSignal,
          });
          const relativized = results.map((result) =>
            relative(searchPath, result).split(sep).join("/"));
          if (relativized.length === 0) {
            return {
              content: [{ type: "text", text: "No files found matching pattern" }],
              details: undefined,
            };
          }
          const limitReached = relativized.length >= limit;
          const truncation = truncateHead(relativized.join("\n"), {
            maxLines: Number.MAX_SAFE_INTEGER,
          });
          const notices: string[] = [];
          const details: {
            resultLimitReached?: number;
            truncation?: TruncationResult;
          } = {};
          if (limitReached) {
            details.resultLimitReached = limit;
            notices.push(`${String(limit)} results limit reached`);
          }
          if (truncation.truncated) {
            details.truncation = truncation;
            notices.push(`${String(DEFAULT_MAX_BYTES)}-byte output limit reached`);
          }
          const text = notices.length === 0
            ? truncation.content
            : `${truncation.content}\n\n[${notices.join(". ")}]`;
          return capRuntimePiAgentResult({
            content: [{ type: "text", text }],
            details: Object.keys(details).length === 0 ? undefined : details,
          }, maxOutputBytes);
        } catch (error) {
          if (deadlineSignal.aborted && !executionSignal.aborted) {
            throw toolError(
              "Glob",
              `traversal exceeded the ${String(timeoutMs)}-millisecond deadline.`,
            );
          }
          throw error;
        }
      },
    );
  });
}

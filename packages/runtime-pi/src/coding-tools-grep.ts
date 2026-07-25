import { createGrepTool } from "@earendil-works/pi-coding-agent";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
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

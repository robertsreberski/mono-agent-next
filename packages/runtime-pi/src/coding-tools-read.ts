import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";

import {
  createReadTool,
  err,
  FileError,
  ok,
  type AgentTool,
  type AgentToolUpdateCallback,
  type Result,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "@earendil-works/pi-ai";

import { runtimePiReadTool } from "./coding-tool-descriptors.js";
import {
  aliasedString,
  approvedExecution,
  capRuntimePiAgentResult,
  combinedSignal,
  displayPath,
  effectiveWorkdir,
  optionalInteger,
  outputLimit,
  ownRecord,
  PATH_MAX_BYTES,
  renamedTool,
  toolError,
  type RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";
import { WEB_FETCH_MAX_OUTPUT_BYTES } from "./web-fetch.js";

export const RUNTIME_PI_MAX_READ_SOURCE_BYTES = 16 * 1024 * 1024;

class BoundedReadExecutionEnv extends NodeExecutionEnv {
  override async readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const aborted = (): boolean => abortSignal?.aborted === true;
    if (aborted()) {
      return err(new FileError("aborted", "aborted", path));
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const metadata = await handle.stat();
      if (aborted()) {
        return err(new FileError("aborted", "aborted", path));
      }
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
        if (aborted()) {
          return err(new FileError("aborted", "aborted", path));
        }
        const { bytesRead } = await handle.read(
          content,
          offset,
          content.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return ok(content.subarray(0, offset));
    } catch (error) {
      return err(error instanceof FileError
        ? error
        : new FileError(
            "unknown",
            error instanceof Error ? error.message : "Read failed.",
            path,
            error instanceof Error ? error : undefined,
          ));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function createRuntimePiReadAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const upstream = createReadTool();
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
    const tool = createReadTool();
    const env = new BoundedReadExecutionEnv({ cwd: workdir });
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
      async () => {
        try {
          return capRuntimePiAgentResult(
            await tool.execute(
              toolCallId,
              {
                path,
                ...(upstreamOffset === undefined ? {} : { offset: upstreamOffset }),
                ...(limit === undefined ? {} : { limit }),
              },
              executionSignal,
              onUpdate as AgentToolUpdateCallback<unknown> | undefined,
              { env },
            ),
            maxOutputBytes,
          );
        } finally {
          await env.cleanup();
        }
      },
    );
  });
}

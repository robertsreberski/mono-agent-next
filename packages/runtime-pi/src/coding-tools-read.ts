import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";

import {
  createReadTool,
  type ReadOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentTool,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
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

export function createRuntimePiReadAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
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

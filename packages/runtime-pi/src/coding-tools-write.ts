// SPDX-License-Identifier: MIT
import {
  createWriteTool,
  type AgentTool,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "@earendil-works/pi-ai";

import { runtimePiWriteTool } from "./coding-tool-descriptors.js";
import {
  aliasedString,
  approvedExecution,
  combinedSignal,
  displayPath,
  effectiveWorkdir,
  evidence,
  executionBoundarySummary,
  ownRecord,
  PATH_MAX_BYTES,
  renamedTool,
  requiredString,
  type RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";

const WRITE_MAX_CONTENT_BYTES = 256 * 1024;
// Pi 0.82 serializes mutations by execution-environment identity. Reuse one
// headless environment and pass absolute paths so writes remain ordered across
// concurrent tools and turns without retaining per-workspace resources.
const writeExecutionEnv = new NodeExecutionEnv({ cwd: process.cwd() });

export function createRuntimePiWriteAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const template = createWriteTool();
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
    const tool = createWriteTool();
    const absolutePath = displayPath(path, workdir);
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiWriteTool,
      toolCallId,
      [
        executionBoundarySummary(
          options,
          "Allow this file creation or complete overwrite through the selected Core sandbox?",
          "Allow this unsandboxed file creation or complete overwrite?",
        ),
        `path: ${JSON.stringify(absolutePath)}`,
        evidence("content", content),
      ].join("\n"),
      executionSignal,
      () => options.sandboxTools === undefined
        ? tool.execute(
            toolCallId,
            { path: absolutePath, content },
            executionSignal,
            onUpdate as AgentToolUpdateCallback<unknown> | undefined,
            { env: writeExecutionEnv },
          )
        : options.sandboxTools.execute(
            runtimePiWriteTool.id,
            { path: absolutePath, content },
            executionSignal,
          ),
    );
  });
}

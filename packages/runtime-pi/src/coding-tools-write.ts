import { createWriteTool } from "@earendil-works/pi-coding-agent";
import type {
  AgentTool,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

import { runtimePiWriteTool } from "./coding-tool-descriptors.js";
import {
  aliasedString,
  approvedExecution,
  combinedSignal,
  displayPath,
  effectiveWorkdir,
  evidence,
  ownRecord,
  PATH_MAX_BYTES,
  renamedTool,
  requiredString,
  type RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";

const WRITE_MAX_CONTENT_BYTES = 256 * 1024;

export function createRuntimePiWriteAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
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

// SPDX-License-Identifier: MIT
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { createRuntimePiBashAgentTool } from "./coding-tools-bash.js";
import { createRuntimePiGlobAgentTool } from "./coding-tools-glob.js";
import { createRuntimePiGrepAgentTool } from "./coding-tools-grep.js";
import { createRuntimePiReadAgentTool } from "./coding-tools-read.js";
import type { RuntimePiCodingToolsOptions } from "./coding-tools-shared.js";
import { createRuntimePiWebFetchAgentTool } from "./coding-tools-web-fetch.js";
import { createRuntimePiWriteAgentTool } from "./coding-tools-write.js";

export {
  runtimePiBashTool,
  runtimePiCodingNativeTools,
  runtimePiGlobTool,
  runtimePiGrepTool,
  runtimePiReadTool,
  runtimePiWebFetchTool,
  runtimePiWriteTool,
} from "./coding-tool-descriptors.js";
export {
  RUNTIME_PI_MAX_BASH_CAPTURE_BYTES,
} from "./coding-tools-bash.js";
export {
  RUNTIME_PI_GLOB_MAX_VISITED_ENTRIES,
  RUNTIME_PI_GLOB_TIMEOUT_MS,
  runRuntimePiGlobTraversal,
} from "./coding-tools-glob.js";
export {
  grepOutputMode,
} from "./coding-tools-grep.js";
export {
  RUNTIME_PI_MAX_READ_SOURCE_BYTES,
} from "./coding-tools-read.js";
export {
  capRuntimePiAgentResult,
  RUNTIME_PI_MAX_IMAGE_BASE64_BYTES,
} from "./coding-tools-shared.js";
export type {
  RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";

export function createRuntimePiCodingTools(
  options: RuntimePiCodingToolsOptions,
): AgentTool[] {
  return [
    createRuntimePiReadAgentTool(options),
    createRuntimePiWriteAgentTool(options),
    createRuntimePiGlobAgentTool(options),
    createRuntimePiGrepAgentTool(options),
    createRuntimePiBashAgentTool(options),
    createRuntimePiWebFetchAgentTool(options),
  ];
}

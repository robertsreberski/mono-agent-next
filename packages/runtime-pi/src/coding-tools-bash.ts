import { Buffer } from "node:buffer";

import {
  createBashTool,
  err,
  ExecutionError,
  type AgentTool,
  type AgentToolUpdateCallback,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "@earendil-works/pi-ai";

import { runtimePiBashTool } from "./coding-tool-descriptors.js";
import {
  approvedExecution,
  capRuntimePiAgentResult,
  combinedSignal,
  effectiveWorkdir,
  evidence,
  optionalInteger,
  optionalString,
  outputLimit,
  ownRecord,
  renamedTool,
  requiredString,
  toolError,
  type RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";
import { WEB_FETCH_MAX_OUTPUT_BYTES } from "./web-fetch.js";

const BASH_MAX_TIMEOUT_SECONDS = 600;
export const RUNTIME_PI_MAX_BASH_CAPTURE_BYTES = 1024 * 1024;

class BoundedBashExecutionEnv extends NodeExecutionEnv {
  override async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const overflowController = new AbortController();
    const executionSignal = options?.abortSignal === undefined
      ? overflowController.signal
      : AbortSignal.any([options.abortSignal, overflowController.signal]);
    let capturedBytes = 0;
    let overflowed = false;
    const forward = (
      callback: ((chunk: string) => void) | undefined,
      chunk: string,
    ): void => {
      capturedBytes += Buffer.byteLength(chunk, "utf8");
      if (capturedBytes > RUNTIME_PI_MAX_BASH_CAPTURE_BYTES) {
        overflowed = true;
        overflowController.abort();
        return;
      }
      callback?.(chunk);
    };
    const result = await super.exec(command, {
      ...options,
      abortSignal: executionSignal,
      onStdout: (chunk) => forward(options?.onStdout, chunk),
      onStderr: (chunk) => forward(options?.onStderr, chunk),
    });
    if (!overflowed) return result;
    return err(new ExecutionError(
      "callback_error",
      toolError(
        "Bash",
        `command output exceeded the ${
          String(RUNTIME_PI_MAX_BASH_CAPTURE_BYTES)
        }-byte hard capture limit.`,
      ).message,
    ));
  }
}

function normalizeBashTimeout(value: number | undefined): number {
  if (value === undefined) return BASH_MAX_TIMEOUT_SECONDS;
  const seconds = value <= BASH_MAX_TIMEOUT_SECONDS ? value : value / 1_000;
  return Math.max(1, Math.min(BASH_MAX_TIMEOUT_SECONDS, seconds));
}

export function createRuntimePiBashAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const upstream = createBashTool();
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
    const tool = createBashTool();
    const env = new BoundedBashExecutionEnv({ cwd: workdir });
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
      async () => {
        try {
          return capRuntimePiAgentResult(
            await tool.execute(
              toolCallId,
              { command, timeout },
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

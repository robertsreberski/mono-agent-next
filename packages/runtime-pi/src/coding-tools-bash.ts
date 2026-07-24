import { Buffer } from "node:buffer";

import {
  createBashTool,
  createLocalBashOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentTool,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
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
const BASH_FORWARD_MAX_BYTES = DEFAULT_MAX_BYTES - 1024;
const BASH_FORWARD_MAX_NEWLINES = DEFAULT_MAX_LINES - 3;

function boundedBashOperations(): BashOperations {
  const local = createLocalBashOperations();
  return {
    async exec(command, cwd, input) {
      const overflowController = new AbortController();
      const executionSignal = input.signal === undefined
        ? overflowController.signal
        : AbortSignal.any([input.signal, overflowController.signal]);
      let capturedBytes = 0;
      let forwardedBytes = 0;
      let forwardedNewlines = 0;
      let truncated = false;
      let overflowed = false;
      const onData = (data: Buffer): void => {
        if (overflowed) return;
        capturedBytes += data.byteLength;

        let end = Math.min(
          data.byteLength,
          Math.max(0, BASH_FORWARD_MAX_BYTES - forwardedBytes),
        );
        let newlines = 0;
        const remainingNewlines = Math.max(
          0,
          BASH_FORWARD_MAX_NEWLINES - forwardedNewlines,
        );
        for (let index = 0; index < end; index += 1) {
          if (data[index] !== 0x0a) continue;
          if (newlines >= remainingNewlines) {
            end = index;
            break;
          }
          newlines += 1;
        }
        if (end > 0) {
          input.onData(data.subarray(0, end));
          forwardedBytes += end;
          forwardedNewlines += newlines;
        }
        if (end < data.byteLength) truncated = true;
        if (capturedBytes > RUNTIME_PI_MAX_BASH_CAPTURE_BYTES) {
          overflowed = true;
          overflowController.abort(new Error("Bash output capture limit exceeded."));
        }
      };

      try {
        const result = await local.exec(command, cwd, {
          ...input,
          onData,
          signal: executionSignal,
        });
        if (overflowed) {
          throw toolError(
            "Bash",
            `command output exceeded the ${
              String(RUNTIME_PI_MAX_BASH_CAPTURE_BYTES)
            }-byte hard capture limit.`,
          );
        }
        if (truncated) {
          input.onData(Buffer.from(
            `\n\n[Bash output preview bounded to ${
              String(BASH_FORWARD_MAX_BYTES)
            } bytes; execution produced more output.]`,
            "utf8",
          ));
        }
        return result;
      } catch (error) {
        if (overflowed) {
          throw toolError(
            "Bash",
            `command output exceeded the ${
              String(RUNTIME_PI_MAX_BASH_CAPTURE_BYTES)
            }-byte hard capture limit.`,
          );
        }
        throw error;
      }
    },
  };
}

function normalizeBashTimeout(value: number | undefined): number {
  if (value === undefined) return BASH_MAX_TIMEOUT_SECONDS;
  const seconds = value <= BASH_MAX_TIMEOUT_SECONDS ? value : value / 1_000;
  return Math.max(1, Math.min(BASH_MAX_TIMEOUT_SECONDS, seconds));
}

export function createRuntimePiBashAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const upstream = createBashTool(options.workspaceDirectory);
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
    const tool = createBashTool(workdir, { operations: boundedBashOperations() });
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
      async () => capRuntimePiAgentResult(
        await tool.execute(
          toolCallId,
          { command, timeout },
          executionSignal,
          onUpdate as AgentToolUpdateCallback<unknown> | undefined,
        ),
        maxOutputBytes,
      ),
    );
  });
}

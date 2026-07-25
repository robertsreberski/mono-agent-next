import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type {
  ModuleDiagnostic,
  RuntimeToolResult,
  RuntimeTurnContext,
} from "@mono-agent/module-sdk";

import { jsonValue } from "./runtime-messages.js";
import {
  nativeToolExecutionResult,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "./runtime-tools.js";

export function runtimePiDiagnostic(
  code: string,
  severity: ModuleDiagnostic["severity"],
  message: string,
): ModuleDiagnostic {
  return { code, severity, message };
}

export interface RuntimePiTurnEventState {
  maxTurnsHit: boolean;
  turnCount: number;
}

export function subscribeRuntimePiTurnEvents(options: {
  readonly harness: AgentHarness;
  readonly context: RuntimeTurnContext;
  readonly toolResults: Map<string, RuntimeToolResult>;
  readonly nativeToolNames: ReadonlySet<string>;
  readonly maxTurns?: number;
  readonly state: RuntimePiTurnEventState;
  readonly abortHarness: () => void;
}): () => void {
  return options.harness.subscribe(async (event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        await options.context.emit({ type: "text-delta", delta: update.delta });
      } else if (update.type === "thinking_delta") {
        await options.context.emit({ type: "thinking-delta", delta: update.delta });
      }
    } else if (event.type === "tool_execution_start") {
      if (event.toolName === STRUCTURED_OUTPUT_TOOL_NAME) return;
      await options.context.emit({
        type: "tool-call",
        call: {
          id: event.toolCallId,
          name: event.toolName,
          input: jsonValue(event.args),
        },
      });
    } else if (event.type === "tool_execution_end") {
      if (event.toolName === STRUCTURED_OUTPUT_TOOL_NAME) return;
      const result = options.toolResults.get(event.toolCallId)
        ?? (options.nativeToolNames.has(event.toolName)
          ? nativeToolExecutionResult(
            event.toolCallId,
            event.toolName,
            event.result,
            event.isError,
          )
          : undefined);
      if (result !== undefined) {
        options.toolResults.set(event.toolCallId, result);
        await options.context.emit({ type: "tool-result", result });
      }
    } else if (event.type === "turn_end") {
      options.state.turnCount += 1;
      if (options.maxTurns !== undefined
        && options.state.turnCount >= options.maxTurns
        && event.message.role === "assistant"
        && event.message.stopReason === "toolUse") {
        options.state.maxTurnsHit = true;
        options.abortHarness();
      }
    } else if (event.type === "session_compact") {
      await options.context.emit({
        type: "compaction",
        compaction: {
          compacted: true,
          tokensBefore: event.compactionEntry.tokensBefore,
          ...(event.compactionEntry.firstKeptEntryId === undefined
            ? {}
            : { firstRetainedMessageId: event.compactionEntry.firstKeptEntryId }),
        },
      });
    } else if (event.type === "retry_scheduled") {
      await options.context.emit({
        type: "diagnostic",
        diagnostic: runtimePiDiagnostic(
          "runtime-pi.retry",
          "warning",
          `Pi ${event.operation} retry ${event.attempt}/${event.maxAttempts} scheduled after ${event.delayMs}ms`,
        ),
      });
    }
  });
}

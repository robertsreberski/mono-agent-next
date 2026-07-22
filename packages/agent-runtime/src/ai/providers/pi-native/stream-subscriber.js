// @ts-check
// Harness event → runtime-event normalization for the pi-native bridge.
//
// Pure move of the `harness.subscribe` handler out of pi-native.js: text /
// thinking delta+end dedup, tool start / update / end / timing events, and the
// turn-counting + maxTurns stop. All mutable counters and dedup keys live on the
// caller-owned `runState`; no module-level mutable state here.

import { toolResultContent } from "../pi-messages.js";
import {
  compactToolRawResult,
  eventToolArgs,
  jsonSerializable,
  streamContentKey,
} from "../pi-events.js";
import { contextUsageFromAssistantMessage } from "./result-builder.js";

function toolResultFileChange(result) {
  const fileChange = result?.details?.file_change;
  return fileChange && typeof fileChange === "object" && !Array.isArray(fileChange)
    ? jsonSerializable(fileChange, null)
    : null;
}

/**
 * The slice of run state the stream subscriber reads and mutates. A structural
 * subset of the orchestrator's runState.
 * @typedef {object} StreamSubscriberState
 * @property {string[]} assistantTexts
 * @property {string[]} assistantThinking
 * @property {Set<unknown>} textDeltaIndexes
 * @property {Set<unknown>} thinkingDeltaIndexes
 * @property {Map<string, number>} toolStartTimes
 * @property {number} turnCount
 * @property {number} toolResultsSeen
 * @property {string|null} lastToolName
 * @property {boolean} maxTurnsHit
 */

/**
 * Build the harness subscribe handler. `harness` is passed for the maxTurns
 * abort; it is already constructed when this is wired (subscribe follows the
 * AgentHarness constructor).
 * @param {StreamSubscriberState} runState
 * @param {{onEvent: (event: any) => void, options: any, toolLimits: any, harness: any, sdk: string, model: string}} deps
 * @returns {(event: any) => void}
 */
export function createStreamSubscriber(runState, { onEvent, options, toolLimits, harness, sdk, model }) {
  return (event) => {
    if (event.type === "message_update") {
      const streamEvent = event.assistantMessageEvent;
      if (streamEvent?.type === "text_delta" && streamEvent.delta) {
        runState.textDeltaIndexes.add(streamContentKey(streamEvent, "text"));
        runState.assistantTexts.push(streamEvent.delta);
        onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.delta }] } });
      } else if (streamEvent?.type === "text_end" && streamEvent.content) {
        const key = streamContentKey(streamEvent, "text");
        if (!runState.textDeltaIndexes.has(key)) {
          runState.assistantTexts.push(streamEvent.content);
          onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.content }] } });
        }
      } else if (streamEvent?.type === "thinking_delta" && streamEvent.delta) {
        runState.thinkingDeltaIndexes.add(streamContentKey(streamEvent, "thinking"));
        runState.assistantThinking.push(streamEvent.delta);
        onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.delta }] } });
      } else if (streamEvent?.type === "thinking_end" && streamEvent.content) {
        const key = streamContentKey(streamEvent, "thinking");
        if (!runState.thinkingDeltaIndexes.has(key)) {
          runState.assistantThinking.push(streamEvent.content);
          onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.content }] } });
        }
      }
    } else if (event.type === "message_end") {
      const contextUsage = contextUsageFromAssistantMessage(event.message);
      if (contextUsage) {
        const contextWindow = Number(harness?.getModel?.()?.contextWindow) || 0;
        const measurementId = typeof event.message?.id === "string" && event.message.id.trim().length > 0
          ? event.message.id
          : undefined;
        onEvent({
          type: "context_usage",
          sdk,
          model,
          timestamp: Date.now(),
          ...(measurementId === undefined ? {} : { measurementId }),
          ...(contextWindow > 0 ? { contextWindow } : {}),
          tokens: contextUsage,
        });
      }
    } else if (event.type === "tool_execution_start") {
      if (event.toolName) runState.lastToolName = event.toolName;
      if (event.toolCallId) runState.toolStartTimes.set(event.toolCallId, Date.now());
      const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
      onEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input }] },
      });
    } else if (event.type === "tool_execution_update") {
      const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
      onEvent({
        type: "tool_update",
        tool_use_id: event.toolCallId,
        name: event.toolName,
        input,
        partial_result: jsonSerializable(event.partialResult, String(event.partialResult ?? "")),
      });
    } else if (event.type === "tool_execution_end") {
      const resultContent = toolResultContent(event.result);
      const fileChange = toolResultFileChange(event.result);
      if (!event.isError) runState.toolResultsSeen += 1;
      const startedAt = runState.toolStartTimes.get(event.toolCallId);
      if (startedAt !== undefined) {
        runState.toolStartTimes.delete(event.toolCallId);
        onEvent({
          type: "tool_timing",
          tool_use_id: event.toolCallId,
          name: event.toolName,
          execution_ms: Date.now() - startedAt,
          is_error: !!event.isError,
        });
      }
      onEvent({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content: resultContent,
            raw_result: compactToolRawResult(jsonSerializable(event.result, resultContent), resultContent),
            ...(fileChange === null ? {} : { file_change: fileChange }),
            is_error: !!event.isError,
          }],
        },
      });
    } else if (event.type === "turn_end") {
      runState.turnCount += 1;
      // NON-DELEGABLE (verified against @earendil-works/pi-agent-core 0.80.3).
      // pi's only after-turn stop hook is `shouldStopAfterTurn` on the LOW-LEVEL
      // `AgentLoopConfig` (dist/types.d.ts) — the config passed to the raw
      // `agentLoop`. It is NOT surfaced on `AgentHarnessOptions`
      // (dist/harness/types.d.ts) and `AgentHarness` (dist/harness/agent-harness.d.ts)
      // exposes no maxTurns / maxSteps / loop-config passthrough. This bridge is
      // built on AgentHarness (for its session tree, compaction, steering, and
      // event stream); reaching `shouldStopAfterTurn` would mean abandoning the
      // harness for the low-level loop and reimplementing all of that. So the
      // maxTurns ceiling stays enforced HERE: we count `turn_end`s and abort on
      // the one that crosses the ceiling, but only when the turn ended to run
      // MORE tools (stopReason "toolUse") — a turn that already produced a final
      // answer must not be clipped. Delegate to a harness-native option only if
      // pi lifts shouldStopAfterTurn (or an equivalent) onto AgentHarnessOptions.
      if (Number.isFinite(Number(options.maxTurns))
        && Number(options.maxTurns) > 0
        && runState.turnCount >= Number(options.maxTurns)
        && event.message?.stopReason === "toolUse") {
        runState.maxTurnsHit = true;
        harness.abort();
      }
    }
  };
}

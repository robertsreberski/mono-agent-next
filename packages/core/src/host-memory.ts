// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import type {
  Memory, MemoryRecord, MemoryRuntimeCaptureRequest, MemoryRuntimeCaptureResult, Runtime,
} from "@mono-agent/module-sdk";
import { errorMessage } from "./errors.js";
import { snapshotMemoryRecallRecords, textFromMessage } from "./host-transcript.js";
import { DEFAULT_INSTRUCTION_BYTES, DEFAULT_MESSAGE_BYTES } from "./host-types.js";
import { assertBoundedText, assertRouteText } from "./host-values.js";
import {
  assertRuntimeTurnEventBoundaryHealthy, createRuntimeTurnEventBoundary,
  normalizeRuntimeModelValidation, normalizeRuntimeToolCall, normalizeRuntimeTurnEvent,
  normalizeRuntimeTurnResult,
} from "./runtime-result-normalizer.js";
import type { AgentSubmitInput } from "./types.js";

interface MemoryContext {
  readonly hostSignal: AbortSignal;
  memory(): Memory | undefined;
  runtimes(): ReadonlyMap<string, Runtime>;
  runtimeCapabilities(): ReadonlyMap<string, Readonly<Runtime["capabilities"]>>;
  recordFailure(message: string): void;
}

/**
 * Owns optional memory: automatic per-turn recall, capture after settlement, and
 * the granted runtime-capture capability. A memory failure degrades the turn and
 * is recorded; it never fails the turn.
 */
export class HostMemory {
  constructor(private readonly context: MemoryContext) {}
  async recall(input: AgentSubmitInput, signal: AbortSignal): Promise<readonly MemoryRecord[]> {
    const memory = this.context.memory();
    if (memory === undefined) return [];
    try {
      const result = await memory.recall({
        query: input.text,
        limit: 8,
        conversationId: input.conversationId,
        signal,
      });
      return snapshotMemoryRecallRecords(result, 8, "automatic memory recall");
    } catch (error) {
      this.context.recordFailure(`memory recall: ${errorMessage(error)}`);
      return [];
    }
  }
  async capture(record: MemoryRecord, signal: AbortSignal): Promise<void> {
    const capture = this.context.memory()?.capture;
    if (capture === undefined) return;
    try {
      await capture({ record, signal });
    } catch (error) {
      this.context.recordFailure(`memory capture: ${errorMessage(error)}`);
    }
  }
  async completeCapture(request: MemoryRuntimeCaptureRequest): Promise<MemoryRuntimeCaptureResult> {
    assertBoundedText(request.instructions, "memory capture instructions", DEFAULT_INSTRUCTION_BYTES);
    assertBoundedText(request.input, "memory capture input", DEFAULT_MESSAGE_BYTES);
    assertRouteText(request.runtime, "memory capture runtime", 256);
    assertRouteText(request.model, "memory capture model", 512);
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > 16_384) {
      throw new RangeError("memory capture maxOutputTokens must be between 1 and 16384");
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3_600_000) {
      throw new RangeError("memory capture timeoutMs must be between 1 and 3600000");
    }
    const runtime = this.context.runtimes().get(request.runtime);
    const configuredCapabilities = this.context.runtimeCapabilities().get(request.runtime);
    if (runtime === undefined || configuredCapabilities === undefined) {
      throw new Error(`memory capture runtime ${request.runtime} is unavailable`);
    }
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([this.context.hostSignal, request.signal, timeout]);
    let routeCapabilities = configuredCapabilities;
    if (runtime.preflightModel !== undefined || runtime.validateModel !== undefined) {
      const rawValidation = runtime.preflightModel !== undefined
        ? await runtime.preflightModel({ model: request.model, signal })
        : await runtime.validateModel!(request.model, signal);
      const validation = normalizeRuntimeModelValidation(
        rawValidation,
        `${request.runtime}:${request.model} memory capture model validation result`,
      );
      if (!validation.supported) {
        throw new Error(`memory capture runtime ${request.runtime} does not support the selected model`);
      }
      routeCapabilities = validation.capabilities ?? routeCapabilities;
    }
    if (!routeCapabilities.structuredOutput) {
      throw new Error("memory capture route does not support structured output");
    }
    const eventBoundary = createRuntimeTurnEventBoundary();
    const captureConversationId = `memory-capture:${randomUUID()}`;
    const captureAuthority = {
      conversationId: captureConversationId,
      route: {
        runtimeInstanceId: request.runtime,
        model: request.model,
      },
    } as const;
    const rawResult = await runtime.runTurn({
      turnId: randomUUID(),
      conversationId: captureConversationId,
      model: request.model,
      messages: [
        { role: "system", content: [{ type: "text", text: request.instructions }] },
        { role: "user", content: [{ type: "text", text: request.input }] },
      ],
      tools: [],
      signal,
      options: {
        maxOutputTokens: request.maxOutputTokens,
        ...(request.responseSchema === undefined ? {} : { responseSchema: request.responseSchema }),
      },
    }, {
      emit: async (event) => {
        normalizeRuntimeTurnEvent(event, eventBoundary, captureAuthority);
      },
      executeTool: async (call) => {
        normalizeRuntimeToolCall(call);
        throw new Error("tools are disabled for memory capture");
      },
    });
    assertRuntimeTurnEventBoundaryHealthy(eventBoundary);
    const result = normalizeRuntimeTurnResult(rawResult, captureAuthority);
    if (result.status !== "completed") throw new Error(`memory capture runtime ended with ${result.status}`);
    return {
      text: textFromMessage(result.message),
      ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
}

import { Buffer } from "node:buffer";

import {
  AgentHarness,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type TSchema,
  type Usage,
} from "@earendil-works/pi-ai";
import { RuntimeTurnError } from "@mono-agent/module-sdk";
import type {
  JsonValue,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleDrainContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStartContext,
  ModuleStopContext,
  Runtime,
  RuntimeCapabilities,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  RuntimeToolResultPart,
  RuntimeTurnContext,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  RuntimeUsage,
  TurnContentPart,
  TurnMessage,
} from "@mono-agent/module-sdk";

import type { RuntimePiConfig } from "./config.js";
import { parsePiModelReference } from "./config.js";
import { ReadOnlyPiCredentialStore, redactRuntimePiText, resolveRuntimePiPath } from "./credentials.js";
import { createRuntimePiModelRegistry, type RuntimePiModelRegistry } from "./models.js";
import {
  RuntimePiSessionManager,
  type RuntimePiSessionAttemptResult,
} from "./sessions.js";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type RuntimeState = "created" | "running" | "draining" | "stopped";

export interface CreateRuntimePiOptions {
  readonly config: RuntimePiConfig;
  readonly instanceId: string;
  readonly configDirectory: string;
  readonly workspaceDirectory: string;
  readonly models?: RuntimePiModelRegistry["models"];
}

export class RuntimePiError extends RuntimeTurnError {
  declare readonly code: "RUNTIME_NOT_RUNNING" | "MODEL_INVALID" | "PROVIDER_FAILED" | "SESSION_INVALID" | "UNSUPPORTED";
  readonly committedSideEffects: boolean;
  readonly retryable: boolean;

  constructor(
    code: RuntimePiError["code"],
    message: string,
    options: { readonly committedSideEffects?: boolean; readonly retryable?: boolean } = {},
  ) {
    const retryable = options.retryable ?? code === "PROVIDER_FAILED";
    const committedSideEffects = options.committedSideEffects ?? false;
    super({
      code,
      message,
      retryability: retryable ? "retryable" : "not-retryable",
      sideEffects: committedSideEffects ? "committed" : "none",
    });
    this.name = "RuntimePiError";
    this.committedSideEffects = committedSideEffects;
    this.retryable = retryable;
  }
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
  } catch {
    return String(value);
  }
}

function runtimeUsage(usage: Usage): RuntimeUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cost: {
      currency: "USD",
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function imagePart(part: Extract<TurnContentPart, { type: "image" }>): ImageContent {
  return {
    type: "image",
    data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
    mimeType: part.mediaType,
  };
}

function filePartText(part: Extract<TurnContentPart, { type: "file" }>): string {
  if (part.mediaType.startsWith("text/") && typeof part.data === "string") return part.data;
  return `[Attached file ${JSON.stringify(part.name)} (${part.mediaType})]`;
}

function textAndImages(parts: readonly TurnContentPart[]): { text: string; images: ImageContent[] } {
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const part of parts) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image") images.push(imagePart(part));
    else if (part.type === "file") {
      if (part.mediaType.startsWith("image/")) {
        images.push({
          type: "image",
          data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
          mimeType: part.mediaType,
        });
      } else text.push(filePartText(part));
    } else if (part.type === "attachment") {
      if (part.attachment.kind === "image") {
        images.push({
          type: "image",
          data: Buffer.from(part.attachment.data).toString("base64"),
          mimeType: part.attachment.mediaType,
        });
      } else {
        text.push(`[Attached file ${JSON.stringify(part.attachment.name)} (${part.attachment.mediaType})]`);
      }
    }
  }
  return { text: text.join("\n"), images };
}

function piContent(parts: readonly TurnContentPart[]): string | (TextContent | ImageContent)[] {
  const { text, images } = textAndImages(parts);
  if (images.length === 0) return text;
  return [...(text === "" ? [] : [{ type: "text" as const, text }]), ...images];
}

function objectArguments(input: JsonValue): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input };
}

function collectToolNames(messages: readonly TurnMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") names.set(part.call.id, part.call.name);
    }
  }
  return names;
}

function seedMessages(messages: readonly TurnMessage[], model: Model<string>): AgentMessage[] {
  const toolNames = collectToolNames(messages);
  const seeded: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      seeded.push({ role: "user", content: piContent(message.content), timestamp: timestamp(message.createdAt) });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "tool-call") {
          content.push({ type: "toolCall", id: part.call.id, name: part.call.name, arguments: objectArguments(part.call.input) });
        }
      }
      seeded.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: timestamp(message.createdAt),
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const result = part.result;
      const content = runtimeToolResultToPiContent(result.content);
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: result.callId,
        toolName: toolNames.get(result.callId) ?? "tool",
        content,
        details: { runtimeResult: result },
        isError: result.isError ?? false,
        timestamp: timestamp(message.createdAt),
      };
      seeded.push(toolResult);
    }
  }
  return seeded;
}

function runtimeToolResultToPiContent(content: readonly RuntimeToolResultPart[]): (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (part.type === "text") result.push({ type: "text", text: part.text });
    else if (part.type === "json") result.push({ type: "text", text: JSON.stringify(part.value) });
    else if (part.mediaType.startsWith("image/")) {
      result.push({
        type: "image",
        data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
        mimeType: part.mediaType,
      });
    } else {
      const body = part.mediaType.startsWith("text/") && typeof part.data === "string"
        ? part.data
        : `[Tool file${part.name === undefined ? "" : ` ${JSON.stringify(part.name)}`} (${part.mediaType})]`;
      result.push({ type: "text", text: body });
    }
  }
  return result.length === 0 ? [{ type: "text", text: "" }] : result;
}

function piTools(
  definitions: readonly RuntimeToolDefinition[],
  context: RuntimeTurnContext,
  results: Map<string, RuntimeToolResult>,
  errors: Set<string>,
  turnSignal: AbortSignal,
  onToolAttempt: () => void,
): AgentTool[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as TSchema,
    async execute(toolCallId, params, signal) {
      const call: RuntimeToolCall = { id: toolCallId, name: definition.name, input: jsonValue(params) };
      onToolAttempt();
      const toolSignal = signal === undefined ? turnSignal : AbortSignal.any([turnSignal, signal]);
      const result = await context.executeTool(call, toolSignal);
      if (result.callId !== toolCallId) {
        throw new Error(`Tool ${definition.name} returned a mismatched call id`);
      }
      results.set(toolCallId, result);
      if (result.isError === true) errors.add(toolCallId);
      return { content: runtimeToolResultToPiContent(result.content), details: { runtimeResult: result } };
    },
  }));
}

function systemPrompt(messages: readonly TurnMessage[]): string | undefined {
  const values = messages
    .filter((message) => message.role === "system")
    .map((message) => textAndImages(message.content).text)
    .filter((value) => value !== "");
  return values.length === 0 ? undefined : values.join("\n\n");
}

function finalUser(messages: readonly TurnMessage[]): { index: number; text: string; images: ImageContent[] } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return { index, ...textAndImages(message.content) };
  }
  throw new TypeError("runtime-pi turn requires a user message");
}

function assistantTurnMessage(message: AssistantMessage): TurnMessage {
  const content: TurnContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "toolCall") {
      content.push({ type: "tool-call", call: { id: part.id, name: part.name, input: jsonValue(part.arguments) } });
    }
  }
  return {
    role: "assistant",
    content,
    createdAt: new Date(message.timestamp).toISOString(),
  };
}

function thinkingLevel(effort: string | undefined, model: Model<string>): { level: ThinkingLevel; clamped: boolean } {
  const requested = effort === undefined || effort === "none" ? "off" : effort;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(requested)) {
    throw new TypeError(`runtime-pi effort is unsupported: ${JSON.stringify(effort)}`);
  }
  const level = clampThinkingLevel(model, requested as ThinkingLevel) as ThinkingLevel;
  return { level, clamped: level !== requested };
}

function exactCapabilities(attachments: boolean): RuntimeCapabilities {
  return {
    tools: true,
    mcp: true,
    attachments,
    approvals: false,
    structuredOutput: false,
    sandbox: false,
    sessions: true,
    liveInput: true,
  };
}

function withCommittedEffects(error: RuntimePiError, committedSideEffects: boolean): RuntimePiError {
  if (!committedSideEffects || error.committedSideEffects) return error;
  return new RuntimePiError(error.code, error.message, {
    committedSideEffects: true,
    retryable: error.retryable,
  });
}

async function waitForSettled(
  promises: readonly Promise<unknown>[],
  signal: AbortSignal,
  message: string,
): Promise<void> {
  if (promises.length === 0) return;
  const settled = Promise.allSettled(promises);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let results: PromiseSettledResult<unknown>[];
  try {
    results = await Promise.race([settled, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, message);
}

export function createRuntimePi(options: CreateRuntimePiOptions): Runtime {
  const cwd = options.workspaceDirectory;
  const authPath = resolveRuntimePiPath(options.config.auth.path, options.configDirectory);
  const sessionsRoot = options.config.sessions?.root === undefined
    ? undefined
    : resolveRuntimePiPath(options.config.sessions.root, options.configDirectory);
  const credentialStore = new ReadOnlyPiCredentialStore(authPath);
  const registry = createRuntimePiModelRegistry(options.config, credentialStore, options.models);
  const sessions = new RuntimePiSessionManager({
    cwd,
    namespace: options.instanceId,
    ...(sessionsRoot === undefined ? {} : { sessionsRoot }),
  });
  let state: RuntimeState = "created";
  const active = new Set<AgentHarness>();

  const diagnostic = (code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic => ({
    code,
    severity,
    message,
  });

  return {
    capabilities: {
      tools: true,
      mcp: true,
      attachments: false,
      approvals: false,
      structuredOutput: false,
      sandbox: false,
      sessions: true,
      liveInput: true,
    },

    async start(_context: ModuleStartContext) {
      if (state === "stopped") throw new RuntimePiError("RUNTIME_NOT_RUNNING", "runtime-pi cannot restart after stop");
      state = "running";
    },

    async drain(context: ModuleDrainContext) {
      if (state === "stopped") return;
      state = "draining";
      await sessions.drain(context.signal);
    },

    async stop(context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      const failures: unknown[] = [];
      try {
        await waitForSettled(
          [...active].map((harness) => harness.abort()),
          context.signal,
          "runtime-pi harnesses failed to abort",
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await sessions.stop(context.signal);
      } catch (error) {
        failures.push(error);
      } finally {
        state = "stopped";
      }
      if (failures.length > 0) throw new AggregateError(failures, "runtime-pi failed to stop cleanly");
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      const status = state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown";
      return {
        status,
        checkedAt: new Date().toISOString(),
        summary: `runtime-pi is ${state}`,
        details: { state, activeTurns: active.size },
      };
    },

    async diagnostics(context: ModuleDiagnosticsContext): Promise<readonly ModuleDiagnostic[]> {
      const diagnostics: ModuleDiagnostic[] = [diagnostic("runtime-pi.lifecycle", "info", `Runtime state: ${state}`)];
      if (context.verbose) {
        try {
          const credentials = await credentialStore.list();
          diagnostics.push(diagnostic(
            "runtime-pi.auth",
            "info",
            `Explicit auth store contains ${credentials.length} provider credential${credentials.length === 1 ? "" : "s"}`,
          ));
        } catch (error) {
          diagnostics.push(diagnostic("runtime-pi.auth", "error", redactRuntimePiText(error, [])));
        }
      }
      return diagnostics;
    },

    async validateModel(model, signal) {
      try {
        const capabilities = await registry.capabilities(model, signal);
        return { supported: true, capabilities: exactCapabilities(capabilities.attachments) };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return {
          supported: false,
          diagnostics: [diagnostic("runtime-pi.model", "error", redactRuntimePiText(error, registry.configuredSecrets))],
        };
      }
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimePiError("RUNTIME_NOT_RUNNING", `runtime-pi is ${state}`);
      if (request.signal.aborted) return { status: "cancelled" };
      if (request.options?.responseSchema !== undefined) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          "runtime-pi does not support structured response schemas",
          { retryable: false },
        );
      }
      if (request.session?.runtimeInstanceId !== undefined && request.session.runtimeInstanceId !== options.instanceId) {
        throw new RuntimePiError("SESSION_INVALID", "runtime-pi session belongs to another runtime instance", { retryable: false });
      }
      if (request.session?.provider !== undefined && request.session.provider !== "pi") {
        throw new RuntimePiError("SESSION_INVALID", "runtime-pi session has an incompatible provider", { retryable: false });
      }
      if (request.session?.model !== undefined && request.session.model !== request.model) {
        throw new RuntimePiError("SESSION_INVALID", "runtime-pi session model does not match the requested model", { retryable: false });
      }

      let model: Model<string>;
      try {
        model = await registry.resolve(request.model, request.signal);
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled" };
        throw new RuntimePiError("MODEL_INVALID", redactRuntimePiText(error, registry.configuredSecrets));
      }
      const reference = parsePiModelReference(request.model);
      const prompt = finalUser(request.messages);
      const secretValues = [...registry.configuredSecrets];
      if (!options.config.localProviders.some((provider) => provider.id === reference.provider)) {
        try { secretValues.push(...await credentialStore.redactionValues()); } catch { /* request auth reports the safe failure */ }
      }
      let committedSideEffects = false;
      try {
        return await sessions.withAttempt(
          {
            conversationId: request.conversationId,
            modelKey: request.model,
            turnId: request.turnId,
            signal: request.signal,
            ...(request.session === undefined ? {} : { resumeSessionId: request.session.id }),
          },
          async (attempt): Promise<RuntimePiSessionAttemptResult<RuntimeTurnResult>> => {
            if (request.signal.aborted) return { completed: false, value: { status: "cancelled" } };
            if (request.session === undefined) {
              for (const message of seedMessages(request.messages.slice(0, prompt.index), model)) {
                await attempt.session.appendMessage(message);
                if (request.signal.aborted) return { completed: false, value: { status: "cancelled" } };
              }
            }

            const toolResults = new Map<string, RuntimeToolResult>();
            const toolErrors = new Set<string>();
            const effort = thinkingLevel(request.options?.effort, model);
            const authoredSystemPrompt = systemPrompt(request.messages);
            const harness = new AgentHarness({
              env: sessions.env,
              session: attempt.session,
              models: registry.models,
              model,
              thinkingLevel: effort.level,
              ...(authoredSystemPrompt === undefined ? {} : { systemPrompt: authoredSystemPrompt }),
              tools: piTools(
                request.tools,
                context,
                toolResults,
                toolErrors,
                request.signal,
                () => { committedSideEffects = true; },
              ),
              streamOptions: {
                timeoutMs: options.config.retry.timeoutMs,
                maxRetries: options.config.retry.maxRetries,
                maxRetryDelayMs: options.config.retry.maxDelayMs,
              },
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
            });
            const removeToolResultHandler = harness.on(
              "tool_result",
              (event) => toolErrors.has(event.toolCallId) ? { isError: true } : undefined,
            );
            active.add(harness);
            const linkedSession = {
              id: attempt.id,
              runtimeInstanceId: options.instanceId,
              provider: "pi",
              model: request.model,
              createdAt: new Date().toISOString(),
              metadata: { provider: reference.provider, nativeModel: reference.model },
            } as const;
            let maxTurnsHit = false;
            let turnCount = 0;
            let abortPromise: Promise<unknown> | undefined;
            const maxTurns = request.options?.maxTurns;
            const abortHarness = (): void => {
              abortPromise ??= harness.abort();
              void abortPromise.catch(() => undefined);
            };
            request.signal.addEventListener("abort", abortHarness, { once: true });
            if (request.signal.aborted) abortHarness();
            const unregisterLiveInput = context.registerLiveInput?.(async (input) => {
              if (request.signal.aborted) return "requeue";
              try {
                await harness.steer(input.text);
                return "applied";
              } catch {
                return "requeue";
              }
            });
            const unsubscribe = harness.subscribe(async (event) => {
              if (event.type === "message_update") {
                const update = event.assistantMessageEvent;
                if (update.type === "text_delta") await context.emit({ type: "text-delta", delta: update.delta });
                else if (update.type === "thinking_delta") await context.emit({ type: "thinking-delta", delta: update.delta });
              } else if (event.type === "tool_execution_start") {
                await context.emit({
                  type: "tool-call",
                  call: { id: event.toolCallId, name: event.toolName, input: jsonValue(event.args) },
                });
              } else if (event.type === "tool_execution_end") {
                const result = toolResults.get(event.toolCallId);
                if (result !== undefined) await context.emit({ type: "tool-result", result });
              } else if (event.type === "turn_end") {
                turnCount += 1;
                if (maxTurns !== undefined && turnCount >= maxTurns && event.message.role === "assistant"
                  && event.message.stopReason === "toolUse") {
                  maxTurnsHit = true;
                  abortHarness();
                }
              } else if (event.type === "session_compact") {
                await context.emit({
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
                await context.emit({
                  type: "diagnostic",
                  diagnostic: diagnostic(
                    "runtime-pi.retry",
                    "warning",
                    `Pi ${event.operation} retry ${event.attempt}/${event.maxAttempts} scheduled after ${event.delayMs}ms`,
                  ),
                });
              }
            });

            try {
              if (effort.clamped) {
                await context.emit({
                  type: "diagnostic",
                  diagnostic: diagnostic(
                    "runtime-pi.effort-clamped",
                    "warning",
                    `Requested effort ${JSON.stringify(request.options?.effort)} was clamped to ${effort.level}`,
                  ),
                });
              }
              if (request.signal.aborted) return { completed: false, value: { status: "cancelled" } };
              const result = await harness.prompt(
                prompt.text,
                prompt.images.length === 0 ? undefined : { images: prompt.images },
              );
              await harness.waitForIdle();
              if (abortPromise !== undefined) await abortPromise;
              const usage = runtimeUsage(result.usage);
              await context.emit({ type: "usage", usage });
              const message = assistantTurnMessage(result);
              if (maxTurnsHit) {
                return { completed: false, value: { status: "max-turns", message, usage } };
              }
              if (result.stopReason === "aborted" || request.signal.aborted) {
                return { completed: false, value: { status: "cancelled", message, usage } };
              }
              if (result.stopReason === "error") {
                throw new RuntimePiError(
                  "PROVIDER_FAILED",
                  redactRuntimePiText(result.errorMessage ?? "Pi provider request failed", secretValues),
                  { committedSideEffects },
                );
              }
              await context.emit({ type: "session", session: linkedSession });
              return {
                completed: true,
                value: {
                  status: "completed",
                  message,
                  usage,
                  session: linkedSession,
                  metadata: { provider: reference.provider, model: reference.model, stopReason: result.stopReason },
                },
              };
            } catch (error) {
              if (request.signal.aborted || maxTurnsHit
                || (state !== "running" && error instanceof Error && error.name === "AbortError")) {
                return { completed: false, value: { status: maxTurnsHit ? "max-turns" : "cancelled" } };
              }
              if (error instanceof RuntimePiError) throw withCommittedEffects(error, committedSideEffects);
              throw new RuntimePiError(
                "PROVIDER_FAILED",
                redactRuntimePiText(error, secretValues),
                { committedSideEffects },
              );
            } finally {
              request.signal.removeEventListener("abort", abortHarness);
              unregisterLiveInput?.();
              unsubscribe();
              removeToolResultHandler();
              active.delete(harness);
            }
          },
        );
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled" };
        if (error instanceof RuntimePiError) throw withCommittedEffects(error, committedSideEffects);
        throw new RuntimePiError(
          "SESSION_INVALID",
          redactRuntimePiText(error, secretValues),
          { committedSideEffects, retryable: false },
        );
      }
    },
  };
}

// SPDX-License-Identifier: MIT
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { RUNTIME_SESSION_UNAVAILABLE_CODE } from "@mono-agent/module-sdk";
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
  RuntimeSession,
  RuntimeToolResult,
  RuntimeTurnContext,
  RuntimeTurnRequest,
  RuntimeTurnResult,
} from "@mono-agent/module-sdk";

import { createRuntimePiAuthCommands } from "./auth-command.js";
import type { RuntimePiConfig } from "./config.js";
import { parsePiModelReference } from "./config.js";
import {
  PiCredentialStore,
  redactRuntimePiText,
  resolveRuntimePiPath,
} from "./credentials.js";
import {
  runtimePiNativeTools,
} from "./model.js";
import {
  createRuntimePiModelRegistry,
  RuntimePiModelDiscoveryError,
  type RuntimePiModelRegistry,
} from "./models.js";
import { createNodeReplController } from "./node-repl.js";
import {
  runtimePiDiagnostic,
  subscribeRuntimePiTurnEvents,
  type RuntimePiTurnEventState,
} from "./runtime-events.js";
import {
  RuntimePiError,
  withCommittedEffects,
} from "./runtime-errors.js";
import {
  assistantTurnMessage,
  exactCapabilities,
  finalUser,
  runtimeUsage,
  seedMessages,
  systemPrompt,
  thinkingLevel,
} from "./runtime-messages.js";
import {
  editTool,
  nodeReplTool,
  piTools,
  requireNativeApproval,
  STRUCTURED_OUTPUT_TOOL_NAME,
  structuredOutputTool,
  webSearchTool,
} from "./runtime-tools.js";
import {
  RuntimePiSessionManager,
  RuntimePiSessionUnavailableError,
  type RuntimePiSessionAttemptResult,
} from "./sessions.js";

type RuntimeState = "created" | "running" | "draining" | "stopped";

export interface CreateRuntimePiOptions {
  readonly config: RuntimePiConfig;
  readonly instanceId: string;
  readonly configDirectory: string;
  readonly workspaceDirectory: string;
  readonly models?: RuntimePiModelRegistry["models"];
}

export { RuntimePiError } from "./runtime-errors.js";

function assertSessionLinkage(
  request: RuntimeTurnRequest,
  instanceId: string,
): void {
  if (request.session === undefined) return;
  if (request.session.route?.runtimeInstanceId !== instanceId) {
    throw new RuntimePiError(
      "SESSION_INVALID",
      "runtime-pi session belongs to another runtime instance",
      { retryable: false },
    );
  }
  if (request.session.route.model !== request.model) {
    throw new RuntimePiError(
      "SESSION_INVALID",
      "runtime-pi session belongs to another model route",
      { retryable: false },
    );
  }
  if (request.session.conversationId !== request.conversationId) {
    throw new RuntimePiError(
      "SESSION_INVALID",
      "runtime-pi session belongs to another conversation",
      { retryable: false },
    );
  }
}

const TRANSIENT_PROVIDER_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_PROVIDER_CODE = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function ownDataValue(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Retry classification accepts only structured own status/code evidence.
 * Provider text is never parsed for transient-looking numbers.
 */
export function isCheckedTransientProviderFailure(error: unknown): boolean {
  const status = ownDataValue(error, "status") ?? ownDataValue(error, "statusCode");
  if (typeof status === "number"
    && Number.isSafeInteger(status)
    && TRANSIENT_PROVIDER_STATUS.has(status)) {
    return true;
  }
  const code = ownDataValue(error, "code");
  return typeof code === "string" && TRANSIENT_PROVIDER_CODE.has(code);
}

async function waitForSettled(
  promises: readonly Promise<unknown>[],
  signal: AbortSignal,
  message: string,
): Promise<void> {
  if (promises.length === 0) return;
  let onAbort: (() => void) | undefined;
  const settled = Promise.allSettled(promises);
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    onAbort = () =>
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let results: PromiseSettledResult<unknown>[];
  try {
    results = await Promise.race([settled, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, message);
}

function runBestEffortCleanup(cleanup: (() => void) | undefined): void {
  try {
    cleanup?.();
  } catch {
    // Host and harness cleanup callbacks must not mask a settled turn or
    // prevent the remaining mandatory cleanup from running.
  }
}

export function createRuntimePi(options: CreateRuntimePiOptions): Runtime {
  const cwd = options.workspaceDirectory;
  const authPath = resolveRuntimePiPath(
    options.config.auth.path,
    options.configDirectory,
  );
  const sessionsRoot = options.config.sessions?.root === undefined
    ? undefined
    : resolveRuntimePiPath(options.config.sessions.root, options.configDirectory);
  const credentialStore = new PiCredentialStore(authPath);
  const registry = createRuntimePiModelRegistry(
    options.config,
    credentialStore,
    options.models,
  );
  const commands = createRuntimePiAuthCommands(credentialStore, registry.models);
  const sessions = new RuntimePiSessionManager({
    cwd,
    namespace: options.instanceId,
    ...(sessionsRoot === undefined ? {} : { sessionsRoot }),
  });
  let state: RuntimeState = "created";
  let stopRequested = false;
  const active = new Set<AgentHarness>();
  const credentialSecrets = async (): Promise<readonly string[]> => {
    try {
      return await credentialStore.redactionValues();
    } catch {
      return [];
    }
  };

  return {
    commands,
    capabilities: {
      tools: true,
      mcp: true,
      attachments: false,
      approvals: true,
      structuredOutput: true,
      sandbox: false,
      sessions: true,
      maxTurns: true,
      maxOutputTokens: true,
      artifactResults: true,
      liveInput: true,
    },

    async start(_context: ModuleStartContext) {
      if (state === "stopped") {
        throw new RuntimePiError(
          "RUNTIME_NOT_RUNNING",
          "runtime-pi cannot restart after stop",
        );
      }
      await sessions.initialize();
      state = "running";
    },

    async drain(context: ModuleDrainContext) {
      if (state === "stopped") return;
      state = "draining";
      await sessions.drain(context.signal);
    },

    async stop(context: ModuleStopContext) {
      if (state === "stopped") return;
      stopRequested = true;
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
      if (failures.length > 0) {
        throw new AggregateError(failures, "runtime-pi failed to stop cleanly");
      }
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      const status = state === "running"
        ? "healthy"
        : state === "draining"
          ? "degraded"
          : "unknown";
      return {
        status,
        checkedAt: new Date().toISOString(),
        summary: `runtime-pi is ${state}`,
        details: { state, activeTurns: active.size },
      };
    },

    async diagnostics(
      context: ModuleDiagnosticsContext,
    ): Promise<readonly ModuleDiagnostic[]> {
      const diagnostics: ModuleDiagnostic[] = [
        runtimePiDiagnostic(
          "runtime-pi.lifecycle",
          "info",
          `Runtime state: ${state}`,
        ),
      ];
      if (context.verbose) {
        try {
          const credentials = await credentialStore.list();
          diagnostics.push(runtimePiDiagnostic(
            "runtime-pi.auth",
            "info",
            `Explicit auth store contains ${credentials.length} provider credential${credentials.length === 1 ? "" : "s"}`,
          ));
        } catch (error) {
          diagnostics.push(runtimePiDiagnostic(
            "runtime-pi.auth",
            "error",
            redactRuntimePiText(error, []),
          ));
        }
      }
      return diagnostics;
    },

    async preflightModel({ model, signal }) {
      signal.throwIfAborted();
      try {
        const capabilities = await registry.capabilities(model, signal);
        return {
          supported: true,
          capabilities: exactCapabilities(capabilities.attachments),
          nativeTools: runtimePiNativeTools,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        const secrets = await credentialSecrets();
        return {
          supported: false,
          diagnostics: [runtimePiDiagnostic(
            "runtime-pi.model",
            "error",
            redactRuntimePiText(error, secrets),
          )],
        };
      }
    },

    async runTurn(
      request: RuntimeTurnRequest,
      context: RuntimeTurnContext,
    ): Promise<RuntimeTurnResult> {
      if (state !== "running") {
        throw new RuntimePiError(
          "RUNTIME_NOT_RUNNING",
          `runtime-pi is ${state}`,
        );
      }
      if (request.signal.aborted) return { status: "cancelled" };
      assertSessionLinkage(request, options.instanceId);
      if (request.options?.responseSchema === undefined
        && context.requestApproval === undefined) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          "runtime-pi requires Core's approval callback for its native tools",
          { retryable: false },
        );
      }
      const nativeToolNames = new Set(runtimePiNativeTools.map((tool) => tool.id));
      const conflict = request.tools.find((tool) =>
        nativeToolNames.has(tool.name)
        || tool.name === STRUCTURED_OUTPUT_TOOL_NAME);
      if (conflict !== undefined) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          `runtime-pi request tools conflict with the native ${conflict.name} tool`,
          { retryable: false },
        );
      }

      let model: Model<string>;
      try {
        model = await registry.resolve(request.model, request.signal);
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled" };
        const discoveryFailure = error instanceof RuntimePiModelDiscoveryError;
        const retryable = discoveryFailure
          && isCheckedTransientProviderFailure(error);
        const secrets = await credentialSecrets();
        throw new RuntimePiError(
          discoveryFailure ? "PROVIDER_FAILED" : "MODEL_INVALID",
          redactRuntimePiText(error, secrets),
          { cause: error, retryable, secrets },
        );
      }

      const requestedMaxOutputTokens = request.options?.maxOutputTokens;
      if (requestedMaxOutputTokens !== undefined
        && (!Number.isSafeInteger(requestedMaxOutputTokens)
          || requestedMaxOutputTokens <= 0)) {
        throw new RuntimePiError(
          "UNSUPPORTED",
          "runtime-pi maxOutputTokens must be a positive safe integer",
          { retryable: false },
        );
      }
      if (requestedMaxOutputTokens !== undefined) {
        model = {
          ...model,
          maxTokens: Math.min(model.maxTokens, requestedMaxOutputTokens),
        };
      }

      // Request validation is complete before a session attempt is reserved.
      const effort = thinkingLevel(request.options?.effort, model);
      const reference = parsePiModelReference(request.model);
      const prompt = finalUser(request.messages);
      const secretValues = [...await credentialSecrets()];
      const currentFailureSecrets = async (): Promise<readonly string[]> => {
        const values = [...secretValues, ...await credentialSecrets()];
        return [...new Set(values)];
      };

      if (stopRequested || request.signal.aborted) {
        return { status: "cancelled" };
      }
      let committedSideEffects = false;
      try {
        const turnResult = await sessions.withAttempt(
          {
            conversationId: request.conversationId,
            modelKey: request.model,
            turnId: request.turnId,
            signal: request.signal,
            ...(request.session === undefined
              ? {}
              : { resumeSessionId: request.session.id }),
          },
          async (
            attempt,
          ): Promise<RuntimePiSessionAttemptResult<RuntimeTurnResult>> => {
            if (stopRequested || request.signal.aborted) {
              return { completed: false, value: { status: "cancelled" } };
            }
            if (request.session === undefined) {
              for (const message of seedMessages(
                request.messages.slice(0, prompt.index),
                model,
              )) {
                await attempt.session.appendMessage(message);
                if (stopRequested || request.signal.aborted) {
                  return { completed: false, value: { status: "cancelled" } };
                }
              }
            }

            const toolResults = new Map<string, RuntimeToolResult>();
            const toolErrors = new Set<string>();
            let structuredOutput: JsonValue | undefined;
            const responseSchema = request.options?.responseSchema;
            const authoredSystemPrompt = systemPrompt(request.messages);
            const nodeRepl = createNodeReplController(cwd);
            try {
              const codingTools = responseSchema === undefined
                ? (await import("./coding-tools.js")).createRuntimePiCodingTools({
                    workspaceDirectory: cwd,
                    turnSignal: request.signal,
                    authorize: (
                      descriptor,
                      toolCallId,
                      summary,
                      signal,
                    ) => requireNativeApproval(
                      context,
                      descriptor,
                      toolCallId,
                      summary,
                      signal,
                    ),
                    record: (result) => {
                      toolResults.set(result.callId, result);
                    },
                    onToolAttempt: () => {
                      committedSideEffects = true;
                    },
                  })
                : [];
              if (stopRequested || request.signal.aborted) {
                return { completed: false, value: { status: "cancelled" } };
              }
              const harness = new AgentHarness({
                session: attempt.session,
                models: registry.models,
                model,
                thinkingLevel: effort.level,
                ...(authoredSystemPrompt === undefined
                  ? {}
                  : { systemPrompt: authoredSystemPrompt }),
                tools: responseSchema === undefined
                  ? [
                      ...piTools(
                        request.tools,
                        context,
                        toolResults,
                        toolErrors,
                        request.signal,
                        () => { committedSideEffects = true; },
                      ),
                      nodeReplTool(
                        context,
                        nodeRepl,
                        toolResults,
                        request.signal,
                        () => { committedSideEffects = true; },
                      ),
                      ...codingTools.slice(0, 2),
                      editTool(
                        context,
                        cwd,
                        toolResults,
                        request.signal,
                        () => { committedSideEffects = true; },
                      ),
                      ...codingTools.slice(2),
                      webSearchTool(
                        context,
                        toolResults,
                        request.signal,
                        () => { committedSideEffects = true; },
                      ),
                    ]
                  : [
                      ...piTools(
                        request.tools,
                        context,
                        toolResults,
                        toolErrors,
                        request.signal,
                        () => { committedSideEffects = true; },
                      ),
                      structuredOutputTool(responseSchema, (value) => {
                        if (structuredOutput !== undefined) {
                          throw new Error(
                            "Structured output was submitted more than once.",
                          );
                        }
                        structuredOutput = value;
                      }),
                    ],
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
                (event) => toolErrors.has(event.toolCallId)
                  ? { isError: true }
                  : undefined,
              );
              const linkedSession: RuntimeSession = {
                id: attempt.id,
                conversationId: request.conversationId,
                route: {
                  runtimeInstanceId: options.instanceId,
                  model: request.model,
                },
                createdAt: new Date().toISOString(),
                metadata: {
                  provider: "pi",
                  nativeProvider: reference.provider,
                  nativeModel: reference.model,
                },
              };
              const eventState: RuntimePiTurnEventState = {
                maxTurnsHit: false,
                turnCount: 0,
              };
              let abortPromise: Promise<unknown> | undefined;
              const abortHarness = (): void => {
                abortPromise ??= harness.abort();
                void abortPromise.catch(() => undefined);
              };
              let unregisterLiveInput: (() => void) | undefined;
              let unsubscribe: (() => void) | undefined;

              active.add(harness);
              try {
                request.signal.addEventListener("abort", abortHarness, {
                  once: true,
                });
                if (request.signal.aborted) abortHarness();
                unregisterLiveInput = context.registerLiveInput?.(async (input) => {
                  if (request.signal.aborted) return "requeue";
                  try {
                    await harness.steer(input.text);
                    return "applied";
                  } catch {
                    return "requeue";
                  }
                });
                unsubscribe = subscribeRuntimePiTurnEvents({
                  harness,
                  context,
                  toolResults,
                  nativeToolNames,
                  ...(request.options?.maxTurns === undefined
                    ? {}
                    : { maxTurns: request.options.maxTurns }),
                  state: eventState,
                  abortHarness,
                });

                let providerSettled = false;
                try {
                  if (effort.clamped) {
                    await context.emit({
                      type: "diagnostic",
                      diagnostic: runtimePiDiagnostic(
                        "runtime-pi.effort-clamped",
                        "warning",
                        `Requested effort ${JSON.stringify(request.options?.effort)} was clamped to ${effort.level}`,
                      ),
                    });
                  }
                  if (stopRequested || request.signal.aborted) {
                    return {
                      completed: false,
                      value: { status: "cancelled" },
                    };
                  }
                  const result = await harness.prompt(
                    prompt.text,
                    prompt.images.length === 0
                      ? undefined
                      : { images: prompt.images },
                  );
                  await harness.waitForIdle();
                  if (abortPromise !== undefined) await abortPromise;
                  providerSettled = result.stopReason !== "aborted";
                  const usage = runtimeUsage(result.usage);
                  await context.emit({ type: "usage", usage });
                  const message = assistantTurnMessage(result);
                  if (eventState.maxTurnsHit) {
                    return {
                      completed: false,
                      value: { status: "max-turns", message, usage },
                    };
                  }
                  if (result.stopReason === "aborted") {
                    return {
                      completed: false,
                      value: { status: "cancelled", message, usage },
                    };
                  }
                  if (result.stopReason === "error") {
                    const failureSecrets = await currentFailureSecrets();
                    throw new RuntimePiError(
                      "PROVIDER_FAILED",
                      redactRuntimePiText(
                        result.errorMessage ?? "Pi provider request failed",
                        failureSecrets,
                      ),
                      {
                        committedSideEffects,
                        cause:
                          result.errorMessage ?? "Pi provider request failed",
                        secrets: failureSecrets,
                      },
                    );
                  }
                  if (responseSchema !== undefined
                    && structuredOutput === undefined) {
                    throw new RuntimePiError(
                      "PROVIDER_FAILED",
                      "Pi completed without the required structured output.",
                      { committedSideEffects, retryable: false },
                    );
                  }
                  return {
                    completed: true,
                    value: {
                      status: "completed",
                      message,
                      ...(structuredOutput === undefined
                        ? {}
                        : { structuredOutput }),
                      usage,
                      session: linkedSession,
                      metadata: {
                        provider: reference.provider,
                        model: reference.model,
                        stopReason: result.stopReason,
                      },
                    },
                  };
                } catch (error) {
                  if (eventState.maxTurnsHit
                    || (!providerSettled
                      && (request.signal.aborted
                        || (state !== "running"
                          && error instanceof Error
                          && error.name === "AbortError")))) {
                    return {
                      completed: false,
                      value: {
                        status: eventState.maxTurnsHit
                          ? "max-turns"
                          : "cancelled",
                      },
                    };
                  }
                  if (error instanceof RuntimePiError) {
                    throw withCommittedEffects(error, committedSideEffects);
                  }
                  const failureSecrets = await currentFailureSecrets();
                  throw new RuntimePiError(
                    "PROVIDER_FAILED",
                    redactRuntimePiText(error, failureSecrets),
                    {
                      committedSideEffects,
                      retryable: isCheckedTransientProviderFailure(error),
                      cause: error,
                      secrets: failureSecrets,
                    },
                  );
                }
              } finally {
                request.signal.removeEventListener("abort", abortHarness);
                runBestEffortCleanup(unregisterLiveInput);
                runBestEffortCleanup(unsubscribe);
                runBestEffortCleanup(removeToolResultHandler);
                active.delete(harness);
              }
            } finally {
              await nodeRepl.close();
            }
          },
        );
        if (turnResult.status === "completed"
          && turnResult.session !== undefined) {
          await context.emit({ type: "session", session: turnResult.session });
        }
        return turnResult;
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled" };
        if (error instanceof RuntimePiError) {
          throw withCommittedEffects(error, committedSideEffects);
        }
        if (error instanceof RuntimePiSessionUnavailableError) {
          throw new RuntimePiError(
            RUNTIME_SESSION_UNAVAILABLE_CODE,
            error.message,
            { cause: error },
          );
        }
        const failureSecrets = await currentFailureSecrets();
        throw new RuntimePiError(
          "SESSION_INVALID",
          redactRuntimePiText(error, failureSecrets),
          {
            committedSideEffects,
            retryable: false,
            cause: error,
            secrets: failureSecrets,
          },
        );
      }
    },
  };
}

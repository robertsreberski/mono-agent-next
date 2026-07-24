import {
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  RuntimeTurnError,
} from "@mono-agent/module-sdk";
import type {
  JsonObject,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleDrainContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStartContext,
  ModuleStopContext,
  Runtime,
  RuntimeRetryability,
  RuntimeSession,
  RuntimeSideEffectStatus,
  RuntimeTurnContext,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  TurnMessage,
} from "@mono-agent/module-sdk";

import { createClaudeCliTransport, type SpawnProcess } from "./cli.js";
import type { RuntimeClaudeConfig } from "./config.js";
import {
  claudeRuntimeCapabilities,
  isClaudeModelIdentifier,
  validateClaudeModel,
} from "./model.js";
import { createClaudeSdkTransport } from "./sdk.js";
import {
  ClaudeSessionUnavailableError,
  claudeEnvironment,
  ownDataValue,
  type ClaudeTransport,
  type ClaudeTransportControl,
} from "./transport.js";

type RuntimeState = "created" | "running" | "draining" | "stopped";
const SAFE_CAUSE_MESSAGE_CHARS = 4_096;
const SAFE_CAUSE_IDENTITY_CHARS = 128;

interface ActiveTurn {
  readonly abortController: AbortController;
  readonly settled: Promise<void>;
  resolveSettled(): void;
  control: ClaudeTransportControl | undefined;
  interruption: Promise<void> | undefined;
}

function activeTurn(): ActiveTurn {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    abortController: new AbortController(),
    settled,
    resolveSettled,
    control: undefined,
    interruption: undefined,
  };
}

function interruptTurn(turn: ActiveTurn): Promise<void> {
  if (turn.interruption === undefined && turn.control !== undefined) {
    const control = turn.control;
    turn.interruption = Promise.resolve().then(async () => control.interrupt());
  }
  return turn.interruption ?? Promise.resolve();
}

function failureMessage(value: unknown): string {
  const ownMessage = ownDataValue(value, "message");
  if (typeof ownMessage === "string") return ownMessage;
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
    || typeof value === "symbol"
  ) return String(value);
  return "Claude provider failure";
}

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "… [truncated]";
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

export class RuntimeClaudeError extends RuntimeTurnError {
  constructor(
    code: string,
    message: string,
    options: {
      readonly retryability?: RuntimeRetryability;
      readonly sideEffects?: RuntimeSideEffectStatus;
      readonly cause?: unknown;
    } = {},
  ) {
    const cause = safeCause(options.cause);
    super({
      code,
      message,
      retryability: options.retryability ?? "unknown",
      sideEffects: options.sideEffects ?? "none",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "RuntimeClaudeError";
  }
}

export interface CreateRuntimeClaudeOptions {
  readonly config: RuntimeClaudeConfig;
  readonly instanceId: string;
  readonly workspaceDirectory: string;
  readonly sdkTransport?: ClaudeTransport;
  readonly cliTransport?: ClaudeTransport;
  readonly spawnProcess?: SpawnProcess;
}

function diagnostic(code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic {
  return { code, severity, message };
}

function redact(value: unknown, secret: string | undefined): string {
  let message = failureMessage(value);
  if (secret !== undefined && secret.length > 0) message = message.split(secret).join("[REDACTED]");
  return bounded(
    message
      .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]"),
    SAFE_CAUSE_MESSAGE_CHARS,
  );
}

function safeCause(value: unknown, secret?: string): Error | undefined {
  if (value === undefined) return undefined;
  const snapshot = new Error(redact(value, secret));
  const rawName = ownDataValue(value, "name");
  snapshot.name = bounded(
    redact(typeof rawName === "string" ? rawName : "Error", secret),
    SAFE_CAUSE_IDENTITY_CHARS,
  );
  const rawCode = ownDataValue(value, "code");
  if (typeof rawCode === "string" || typeof rawCode === "number") {
    Object.defineProperty(snapshot, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: bounded(
        redact(String(rawCode), secret),
        SAFE_CAUSE_IDENTITY_CHARS,
      ),
    });
  }
  delete snapshot.stack;
  return Object.freeze(snapshot);
}

function messageText(message: TurnMessage): string {
  const chunks: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") chunks.push(part.text);
    else if (part.type === "tool-call") chunks.push(`[tool call ${part.call.name}: ${JSON.stringify(part.call.input)}]`);
    else if (part.type === "tool-result") chunks.push(`[tool result ${part.result.callId}: ${JSON.stringify(part.result.content)}]`);
    else throw new RuntimeClaudeError("ATTACHMENT_UNSUPPORTED", "runtime-claude does not accept in-memory attachments", { retryability: "not-retryable" });
  }
  return chunks.join("\n");
}

function systemPrompt(messages: readonly TurnMessage[]): string | undefined {
  const values = messages.filter((message) => message.role === "system").map(messageText).filter(Boolean);
  return values.length === 0 ? undefined : values.join("\n\n");
}

function prompt(messages: readonly TurnMessage[], resumed: boolean): string {
  if (resumed) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") return messageText(message);
    }
  }
  return messages.filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${messageText(message)}`).join("\n\n");
}

function linkedSession(
  instanceId: string,
  id: string,
  conversationId: string,
  model: string,
  mode: string,
): RuntimeSession {
  return {
    id,
    conversationId,
    route: { runtimeInstanceId: instanceId, model },
    createdAt: new Date().toISOString(),
    metadata: { provider: "claude", transport: mode },
  };
}

function assertSessionLinkage(
  request: RuntimeTurnRequest,
  instanceId: string,
): void {
  if (request.session === undefined) return;
  if (request.session.route?.runtimeInstanceId !== instanceId) {
    throw new RuntimeClaudeError(
      "SESSION_INVALID",
      "Claude session belongs to another runtime instance",
      { retryability: "not-retryable" },
    );
  }
  if (request.session.route.model !== request.model) {
    throw new RuntimeClaudeError(
      "SESSION_INVALID",
      "Claude session belongs to another model route",
      { retryability: "not-retryable" },
    );
  }
  if (request.session.conversationId !== request.conversationId) {
    throw new RuntimeClaudeError(
      "SESSION_INVALID",
      "Claude session belongs to another conversation",
      { retryability: "not-retryable" },
    );
  }
}

export function createRuntimeClaude(options: CreateRuntimeClaudeOptions): Runtime {
  let state: RuntimeState = "created";
  let stopPromise: Promise<void> | undefined;
  const active = new Set<ActiveTurn>();
  const transport = options.config.mode === "sdk"
    ? options.sdkTransport ?? createClaudeSdkTransport()
    : options.cliTransport ?? createClaudeCliTransport({
        binary: options.config.binary,
        timeoutMs: options.config.timeoutMs,
        maxLineBytes: options.config.maxLineBytes,
        maxStderrBytes: options.config.maxStderrBytes,
        ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      });

  return {
    capabilities: claudeRuntimeCapabilities(options.config),

    async start(_context: ModuleStartContext) {
      if (state === "stopped") throw new RuntimeClaudeError("RUNTIME_NOT_RUNNING", "runtime-claude cannot restart after stop", { retryability: "not-retryable" });
      state = "running";
    },

    async drain(_context: ModuleDrainContext) {
      if (state !== "stopped") state = "draining";
    },

    stop(_context: ModuleStopContext) {
      stopPromise ??= (async () => {
        if (state === "stopped") return;
        state = "draining";
        const turns = [...active];
        for (const turn of turns) {
          turn.abortController.abort(
            new DOMException("runtime-claude stopped", "AbortError"),
          );
        }
        await Promise.allSettled(turns.map(async (turn) => {
          await Promise.allSettled([interruptTurn(turn), turn.settled]);
          await interruptTurn(turn).catch(() => undefined);
        }));
        state = "stopped";
      })();
      return stopPromise;
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      return {
        status: state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown",
        checkedAt: new Date().toISOString(),
        summary: `runtime-claude is ${state}`,
        details: { state, mode: options.config.mode, activeTurns: active.size },
      };
    },

    diagnostics(_context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
      return [diagnostic("runtime-claude.lifecycle", "info", `Runtime state: ${state}; transport: ${options.config.mode}`)];
    },

    preflightModel({ model, signal }) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      return validateClaudeModel({ model, config: options.config });
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimeClaudeError("RUNTIME_NOT_RUNNING", `runtime-claude is ${state}`, { retryability: "not-retryable" });
      if (!isClaudeModelIdentifier(request.model)) throw new RuntimeClaudeError("MODEL_INVALID", "Claude model identifier is invalid", { retryability: "not-retryable" });
      if (request.tools.length > 0) throw new RuntimeClaudeError("TOOLS_UNSUPPORTED", "runtime-claude does not expose Core tools", { retryability: "not-retryable" });
      assertSessionLinkage(request, options.instanceId);
      if (request.signal.aborted) return { status: "cancelled" };

      let control: ClaudeTransportControl | undefined;
      let nativeSessionId = request.session?.id;
      let unregisterLiveInput: (() => void) | undefined;
      const currentTurn = activeTurn();
      const turnSignal = AbortSignal.any([
        request.signal,
        currentTurn.abortController.signal,
      ]);
      active.add(currentTurn);
      try {
        if (turnSignal.aborted) return { status: "cancelled" };
        const authoredSystemPrompt = systemPrompt(request.messages);
        const result = await transport.run({
          model: request.model,
          prompt: prompt(request.messages, request.session !== undefined),
          ...(authoredSystemPrompt === undefined ? {} : { systemPrompt: authoredSystemPrompt }),
          ...(request.session === undefined ? {} : { sessionId: request.session.id }),
          ...(request.options?.effort === undefined ? {} : { effort: request.options.effort }),
          ...(request.options?.maxTurns === undefined ? {} : { maxTurns: request.options.maxTurns }),
          ...(request.options?.responseSchema === undefined ? {} : { responseSchema: request.options.responseSchema }),
          cwd: options.workspaceDirectory,
          env: claudeEnvironment(options.config.auth),
          signal: turnSignal,
        }, {
          async text(delta) { await context.emit({ type: "text-delta", delta }); },
          async thinking(delta) { await context.emit({ type: "thinking-delta", delta }); },
          async session(id) {
            nativeSessionId = id;
            await context.emit({
              type: "session",
              session: linkedSession(
                options.instanceId,
                id,
                request.conversationId,
                request.model,
                options.config.mode,
              ),
            });
          },
          async usage(value) { await context.emit({ type: "usage", usage: value }); },
          control(value) {
            control = value;
            currentTurn.control = value;
            if (currentTurn.abortController.signal.aborted) {
              void interruptTurn(currentTurn).catch(() => undefined);
            }
            if (
              !turnSignal.aborted
              && state === "running"
              && context.registerLiveInput !== undefined
              && value.sendInput !== undefined
            ) {
              unregisterLiveInput = context.registerLiveInput(async (input) => {
                if (turnSignal.aborted || control?.sendInput === undefined) return "requeue";
                return await control.sendInput(input.text, input.receivedAt) ? "applied" : "requeue";
              });
            }
          },
        });
        nativeSessionId = result.sessionId;
        if (turnSignal.aborted) {
          return {
            status: "cancelled",
            session: linkedSession(
              options.instanceId,
              result.sessionId,
              request.conversationId,
              request.model,
              options.config.mode,
            ),
          };
        }
        return {
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text: result.text }] },
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          session: linkedSession(
            options.instanceId,
            result.sessionId,
            request.conversationId,
            request.model,
            options.config.mode,
          ),
          ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
          metadata: {
            provider: "claude",
            model: request.model,
            transport: options.config.mode,
            ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
          } as JsonObject,
        };
      } catch (error) {
        if (turnSignal.aborted) {
          return {
            status: "cancelled",
            ...(nativeSessionId === undefined
              ? {}
              : {
                  session: linkedSession(
                    options.instanceId,
                    nativeSessionId,
                    request.conversationId,
                    request.model,
                    options.config.mode,
                  ),
                }),
          };
        }
        if (error instanceof RuntimeClaudeError) throw error;
        if (error instanceof ClaudeSessionUnavailableError) {
          throw new RuntimeClaudeError(
            RUNTIME_SESSION_UNAVAILABLE_CODE,
            "Claude provider session is unavailable",
            {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: safeCause(error, options.config.auth?.token),
            },
          );
        }
        throw new RuntimeClaudeError("PROVIDER_FAILED", redact(error, options.config.auth?.token), {
          retryability: "unknown",
          sideEffects: "none",
          cause: safeCause(error, options.config.auth?.token),
        });
      } finally {
        try {
          unregisterLiveInput?.();
        } finally {
          active.delete(currentTurn);
          currentTurn.resolveSettled();
        }
      }
    },
  };
}

import { RuntimeTurnError } from "@mono-agent/module-sdk";
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
import { claudeEnvironment, type ClaudeTransport, type ClaudeTransportControl } from "./transport.js";

type RuntimeState = "created" | "running" | "draining" | "stopped";

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
    super({
      code,
      message,
      retryability: options.retryability ?? "unknown",
      sideEffects: options.sideEffects ?? "none",
      ...(options.cause === undefined ? {} : { cause: options.cause }),
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
  let message = value instanceof Error ? value.message : String(value);
  if (secret !== undefined && secret.length > 0) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
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

function linkedSession(instanceId: string, id: string, model: string, mode: string): RuntimeSession {
  return {
    id,
    runtimeInstanceId: instanceId,
    provider: "claude",
    model,
    createdAt: new Date().toISOString(),
    metadata: { transport: mode },
  };
}

export function createRuntimeClaude(options: CreateRuntimeClaudeOptions): Runtime {
  let state: RuntimeState = "created";
  const active = new Set<ClaudeTransportControl>();
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

    async stop(_context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      await Promise.allSettled([...active].map(async (control) => control.interrupt()));
      active.clear();
      state = "stopped";
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
      if (request.session?.runtimeInstanceId !== undefined && request.session.runtimeInstanceId !== options.instanceId) {
        throw new RuntimeClaudeError("SESSION_INVALID", "Claude session belongs to another runtime instance", { retryability: "not-retryable" });
      }
      if (request.signal.aborted) return { status: "cancelled" };

      let control: ClaudeTransportControl | undefined;
      let nativeSessionId = request.session?.id;
      let unregisterLiveInput: (() => void) | undefined;
      try {
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
          signal: request.signal,
        }, {
          async text(delta) { await context.emit({ type: "text-delta", delta }); },
          async thinking(delta) { await context.emit({ type: "thinking-delta", delta }); },
          async session(id) {
            nativeSessionId = id;
            await context.emit({ type: "session", session: linkedSession(options.instanceId, id, request.model, options.config.mode) });
          },
          async usage(value) { await context.emit({ type: "usage", usage: value }); },
          control(value) {
            control = value;
            active.add(value);
            if (context.registerLiveInput !== undefined && value.sendInput !== undefined) {
              unregisterLiveInput = context.registerLiveInput(async (input) => {
                if (request.signal.aborted || control?.sendInput === undefined) return "requeue";
                return await control.sendInput(input.text, input.receivedAt) ? "applied" : "requeue";
              });
            }
          },
        });
        nativeSessionId = result.sessionId;
        if (request.signal.aborted) return { status: "cancelled", session: linkedSession(options.instanceId, result.sessionId, request.model, options.config.mode) };
        return {
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text: result.text }] },
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          session: linkedSession(options.instanceId, result.sessionId, request.model, options.config.mode),
          ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
          metadata: {
            provider: "claude",
            model: request.model,
            transport: options.config.mode,
            ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
          } as JsonObject,
        };
      } catch (error) {
        if (request.signal.aborted) {
          return { status: "cancelled", ...(nativeSessionId === undefined ? {} : { session: linkedSession(options.instanceId, nativeSessionId, request.model, options.config.mode) }) };
        }
        if (error instanceof RuntimeClaudeError) throw error;
        throw new RuntimeClaudeError("PROVIDER_FAILED", redact(error, options.config.auth?.token), {
          retryability: "unknown",
          sideEffects: "none",
          cause: error,
        });
      } finally {
        unregisterLiveInput?.();
        if (control !== undefined) active.delete(control);
      }
    },
  };
}

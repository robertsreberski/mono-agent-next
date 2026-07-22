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
  RuntimeUsage,
  TurnMessage,
} from "@mono-agent/module-sdk";

import type { RuntimeOpenCodeConfig } from "./config.js";
import { openCodeProcessEnvironment } from "./environment.js";
import {
  capturePlainText,
  OpenCodeProcessTerminationError,
  runJsonl,
  type SpawnProcess,
} from "./process.js";

type RuntimeState = "created" | "starting" | "running" | "draining" | "stopped";

interface ActiveProcess {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

export class RuntimeOpenCodeError extends RuntimeTurnError {
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
    this.name = "RuntimeOpenCodeError";
  }
}

export interface CreateRuntimeOpenCodeOptions {
  readonly config: RuntimeOpenCodeConfig;
  readonly instanceId: string;
  readonly workspaceDirectory: string;
  readonly spawnProcess?: SpawnProcess;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function diagnostic(code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic {
  return { code, severity, message };
}

function redact(value: unknown, secrets: readonly string[]): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.split(secret).join("[REDACTED]");
  }
  return message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}

function modelValid(model: string): boolean {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1 && model.length <= 512
    && model.trim() === model && !/[\u0000-\u001f\u007f]/.test(model);
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: [number, number, number], minimum: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if ((actual[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((actual[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

function textOf(message: TurnMessage): string {
  const chunks: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") chunks.push(part.text);
    else if (part.type === "tool-call") chunks.push(`[tool call ${part.call.name}: ${JSON.stringify(part.call.input)}]`);
    else if (part.type === "tool-result") chunks.push(`[tool result ${part.result.callId}: ${JSON.stringify(part.result.content)}]`);
    else throw new RuntimeOpenCodeError("ATTACHMENT_UNSUPPORTED", "runtime-opencode does not accept in-memory attachments", { retryability: "not-retryable" });
  }
  return chunks.join("\n");
}

function prompt(messages: readonly TurnMessage[], resumed: boolean): string {
  if (resumed) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") return textOf(message);
    }
  }
  return messages.map((message) => `${message.role.toUpperCase()}:\n${textOf(message)}`).join("\n\n");
}

function linkedSession(instanceId: string, id: string, model: string): RuntimeSession {
  return {
    id,
    runtimeInstanceId: instanceId,
    provider: "opencode",
    model,
    createdAt: new Date().toISOString(),
    metadata: { protocol: "opencode-run-json-v1" },
  };
}

function errorMessage(value: Record<string, unknown>): string {
  const error = record(value.error);
  const data = record(error.data);
  if (typeof data.message === "string") return data.message;
  if (typeof error.message === "string") return error.message;
  return "OpenCode turn failed";
}

export function createRuntimeOpenCode(options: CreateRuntimeOpenCodeOptions): Runtime {
  let state: RuntimeState = "created";
  let version: string | undefined;
  let terminationFailure: OpenCodeProcessTerminationError | undefined;
  const active = new Set<ActiveProcess>();
  const secrets = Object.values(options.config.environment);
  const processOptions = (signal: AbortSignal) => ({
    command: options.config.binary,
    cwd: options.workspaceDirectory,
    env: openCodeProcessEnvironment(options.config.environment),
    signal,
    timeoutMs: options.config.timeoutMs,
    maxLineBytes: options.config.maxLineBytes,
    maxStderrBytes: options.config.maxStderrBytes,
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
  });

  return {
    capabilities: {
      tools: false,
      mcp: false,
      attachments: false,
      approvals: false,
      structuredOutput: false,
      sandbox: false,
      sessions: true,
      liveInput: false,
    },

    async start(context: ModuleStartContext) {
      if (state !== "created") throw new RuntimeOpenCodeError("RUNTIME_NOT_RUNNING", `runtime-opencode cannot start while ${state}`, { retryability: "not-retryable" });
      state = "starting";
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let settleActive!: () => void;
      const activeProcess: ActiveProcess = {
        controller,
        settled: new Promise<void>((resolve) => { settleActive = resolve; }),
      };
      active.add(activeProcess);
      try {
        const output = await capturePlainText({ ...processOptions(signal), args: ["--version"] });
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        if (state !== "starting") throw new DOMException("Runtime lifecycle changed during startup", "AbortError");
        const actual = parseVersion(output);
        const minimum = parseVersion(options.config.minimumVersion) as [number, number, number];
        if (actual === undefined || !atLeast(actual, minimum)) {
          throw new RuntimeOpenCodeError(
            "VERSION_UNSUPPORTED",
            `runtime-opencode requires stable OpenCode >=${options.config.minimumVersion}; found ${output || "unknown"}`,
            { retryability: "not-retryable" },
          );
        }
        version = actual.join(".");
        state = "running";
      } catch (error) {
        if (error instanceof OpenCodeProcessTerminationError) {
          terminationFailure ??= error;
          state = "draining";
          throw new RuntimeOpenCodeError("PROCESS_TERMINATION_FAILED", error.message, {
            retryability: "not-retryable",
            sideEffects: "none",
            cause: error,
          });
        } else if (state === "starting") {
          state = "created";
        }
        if (error instanceof RuntimeOpenCodeError) throw error;
        throw new RuntimeOpenCodeError("VERSION_CHECK_FAILED", redact(error, secrets), {
          retryability: "unknown",
          sideEffects: "none",
          cause: error,
        });
      } finally {
        active.delete(activeProcess);
        settleActive();
      }
    },

    async drain(_context: ModuleDrainContext) {
      if (state !== "stopped") state = "draining";
    },

    async stop(_context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      const turns = [...active];
      for (const turn of turns) turn.controller.abort(new DOMException("Runtime stopped", "AbortError"));
      await Promise.all(turns.map((turn) => turn.settled));
      if (terminationFailure !== undefined) {
        throw new RuntimeOpenCodeError("PROCESS_TERMINATION_FAILED", terminationFailure.message, {
          retryability: "not-retryable",
          sideEffects: "unknown",
          cause: terminationFailure,
        });
      }
      state = "stopped";
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      return {
        status: state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown",
        checkedAt: new Date().toISOString(),
        summary: `runtime-opencode is ${state}`,
        details: { state, activeTurns: active.size, ...(version === undefined ? {} : { version }) },
      };
    },

    diagnostics(_context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
      return [diagnostic("runtime-opencode.lifecycle", "info", `Runtime state: ${state}${version === undefined ? "" : ` (${version})`}`)];
    },

    validateModel(model) {
      if (!modelValid(model)) return { supported: false, diagnostics: [diagnostic("runtime-opencode.model", "error", "OpenCode model must use provider/model")] };
      return { supported: true, capabilities: this.capabilities };
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimeOpenCodeError("RUNTIME_NOT_RUNNING", `runtime-opencode is ${state}`, { retryability: "not-retryable" });
      if (!modelValid(request.model)) throw new RuntimeOpenCodeError("MODEL_INVALID", "OpenCode model must use provider/model", { retryability: "not-retryable" });
      if (request.tools.length > 0) throw new RuntimeOpenCodeError("TOOLS_UNSUPPORTED", "runtime-opencode does not expose Core tools", { retryability: "not-retryable" });
      if (request.options?.responseSchema !== undefined) throw new RuntimeOpenCodeError("STRUCTURED_OUTPUT_UNSUPPORTED", "runtime-opencode does not support response schemas", { retryability: "not-retryable" });
      if (request.session?.runtimeInstanceId !== undefined && request.session.runtimeInstanceId !== options.instanceId) {
        throw new RuntimeOpenCodeError("SESSION_INVALID", "OpenCode session belongs to another runtime instance", { retryability: "not-retryable" });
      }
      if (request.signal.aborted) return { status: "cancelled" };

      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      let settleActive!: () => void;
      const activeTurn: ActiveProcess = {
        controller,
        settled: new Promise<void>((resolve) => { settleActive = resolve; }),
      };
      active.add(activeTurn);
      let nativeSessionId = request.session?.id;
      let output = "";
      let usage: RuntimeUsage | undefined;
      let providerError: string | undefined;
      const args = [
        "run",
        "--format", "json",
        ...(options.config.pure ? ["--pure"] : []),
        "--dir", options.workspaceDirectory,
        "--model", request.model,
        ...(request.options?.effort === undefined ? [] : ["--variant", request.options.effort]),
        ...(request.session === undefined ? [] : ["--session", request.session.id]),
      ];

      try {
        const result = await runJsonl({
          ...processOptions(signal),
          args,
          input: prompt(request.messages, request.session !== undefined),
          async onJson(value) {
            const event = record(value);
            if (typeof event.sessionID === "string" && event.sessionID !== nativeSessionId) {
              nativeSessionId = event.sessionID;
              await context.emit({ type: "session", session: linkedSession(options.instanceId, nativeSessionId, request.model) });
            }
            const part = record(event.part);
            if (event.type === "text") {
              const delta = typeof part.text === "string" ? part.text : typeof event.text === "string" ? event.text : "";
              if (delta !== "") { output += delta; await context.emit({ type: "text-delta", delta }); }
            } else if (event.type === "reasoning") {
              const delta = typeof part.text === "string" ? part.text : typeof event.text === "string" ? event.text : "";
              if (delta !== "") await context.emit({ type: "thinking-delta", delta });
            } else if (event.type === "step_finish") {
              const tokens = record(part.tokens ?? event.tokens);
              const inputTokens = Number(tokens.input ?? 0);
              const outputTokens = Number(tokens.output ?? 0);
              usage = {
                inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
                outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
                totalTokens: (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0),
              };
              await context.emit({ type: "usage", usage });
            } else if (event.type === "error") {
              providerError = redact(errorMessage(event), secrets);
              await context.emit({ type: "diagnostic", diagnostic: diagnostic("runtime-opencode.provider", "error", providerError) });
            } else if (event.type === "tool_use") {
              await context.emit({
                type: "diagnostic",
                diagnostic: diagnostic("runtime-opencode.native-tool", "info", "OpenCode native tool activity observed"),
              });
            }
          },
        });
        if (signal.aborted) return { status: "cancelled", ...(nativeSessionId === undefined ? {} : { session: linkedSession(options.instanceId, nativeSessionId, request.model) }) };
        if (result.code !== 0 || providerError !== undefined) {
          throw new RuntimeOpenCodeError(
            "PROVIDER_FAILED",
            providerError ?? redact(result.stderr === "" ? `OpenCode exited ${result.code}` : result.stderr, secrets),
            { retryability: "unknown", sideEffects: "unknown" },
          );
        }
        if (nativeSessionId === undefined) throw new RuntimeOpenCodeError("PROTOCOL_INVALID", "OpenCode completed without a session id", { retryability: "unknown", sideEffects: "unknown" });
        const session = linkedSession(options.instanceId, nativeSessionId, request.model);
        return {
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text: output }] },
          ...(usage === undefined ? {} : { usage }),
          session,
          metadata: { provider: "opencode", model: request.model, version: version ?? "unknown" } as JsonObject,
        };
      } catch (error) {
        if (error instanceof OpenCodeProcessTerminationError) {
          terminationFailure ??= error;
          state = "draining";
          throw new RuntimeOpenCodeError("PROCESS_TERMINATION_FAILED", error.message, {
            retryability: "not-retryable",
            sideEffects: "unknown",
            cause: error,
          });
        }
        if (signal.aborted) return { status: "cancelled", ...(nativeSessionId === undefined ? {} : { session: linkedSession(options.instanceId, nativeSessionId, request.model) }) };
        if (error instanceof RuntimeOpenCodeError) throw error;
        throw new RuntimeOpenCodeError("PROVIDER_FAILED", redact(error, secrets), {
          retryability: "unknown",
          sideEffects: "unknown",
          cause: error,
        });
      } finally {
        controller.abort();
        active.delete(activeTurn);
        settleActive();
      }
    },
  };
}

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
  RuntimeSession,
  RuntimeSideEffectStatus,
  RuntimeRetryability,
  RuntimeTurnContext,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  TurnMessage,
} from "@mono-agent/module-sdk";

import type { RuntimeCodexConfig } from "./config.js";
import { codexProcessEnvironment } from "./environment.js";
import { JsonRpcProcess, type JsonRpcMessage, type SpawnProcess } from "./json-rpc.js";

type RuntimeState = "created" | "running" | "draining" | "stopped";

export class RuntimeCodexError extends RuntimeTurnError {
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
    this.name = "RuntimeCodexError";
  }
}

export interface CreateRuntimeCodexOptions {
  readonly config: RuntimeCodexConfig;
  readonly instanceId: string;
  readonly workspaceDirectory: string;
  readonly spawnProcess?: SpawnProcess;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return record(record(value)[key]);
}

function safeModel(model: string): boolean {
  return model.length > 0 && model.length <= 256 && model.trim() === model && !/[\u0000-\u001f\u007f]/.test(model);
}

function messageText(message: TurnMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "tool-call") parts.push(`[tool call ${part.call.name}: ${JSON.stringify(part.call.input)}]`);
    else if (part.type === "tool-result") parts.push(`[tool result ${part.result.callId}: ${JSON.stringify(part.result.content)}]`);
    else throw new RuntimeCodexError("ATTACHMENT_UNSUPPORTED", "runtime-codex does not accept binary attachments", { retryability: "not-retryable" });
  }
  return parts.join("\n");
}

function authoredSystem(messages: readonly TurnMessage[]): string | undefined {
  const text = messages.filter((message) => message.role === "system").map(messageText).filter(Boolean);
  return text.length === 0 ? undefined : text.join("\n\n");
}

function prompt(messages: readonly TurnMessage[], resumed: boolean): string {
  if (resumed) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") return messageText(message);
    }
  }
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${messageText(message)}`)
    .join("\n\n");
}

function session(instanceId: string, id: string, model: string): RuntimeSession {
  return {
    id,
    runtimeInstanceId: instanceId,
    provider: "codex",
    model,
    createdAt: new Date().toISOString(),
    metadata: { protocol: "codex-app-server-v2" },
  };
}

function diagnostic(code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic {
  return { code, severity, message };
}

function redact(value: unknown, secret: string | undefined): string {
  let message = value instanceof Error ? value.message : String(value);
  if (secret !== undefined && secret.length > 0) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}

function resultThreadId(value: unknown): string | undefined {
  const thread = nestedRecord(value, "thread");
  return typeof thread.id === "string" ? thread.id : undefined;
}

function resultTurnId(value: unknown): string | undefined {
  const turn = nestedRecord(value, "turn");
  return typeof turn.id === "string" ? turn.id : undefined;
}

function notificationMatches(params: Record<string, unknown>, threadId: string, turnId: string | undefined): boolean {
  if (params.threadId !== undefined && params.threadId !== threadId) return false;
  return turnId === undefined || params.turnId === undefined || params.turnId === turnId
    || record(params.turn).id === turnId;
}

export function createRuntimeCodex(options: CreateRuntimeCodexOptions): Runtime {
  let state: RuntimeState = "created";
  const active = new Set<JsonRpcProcess>();

  const newClient = (): JsonRpcProcess => new JsonRpcProcess({
    command: options.config.binary,
    args: ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"],
    cwd: options.workspaceDirectory,
    env: codexProcessEnvironment(options.config.auth === undefined ? {} : { OPENAI_API_KEY: options.config.auth.apiKey }),
    timeoutMs: options.config.requestTimeoutMs,
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
      structuredOutput: true,
      sandbox: false,
      sessions: true,
      liveInput: true,
    },

    async start(_context: ModuleStartContext) {
      if (state === "stopped") throw new RuntimeCodexError("RUNTIME_NOT_RUNNING", "runtime-codex cannot restart after stop", { retryability: "not-retryable" });
      state = "running";
    },

    async drain(_context: ModuleDrainContext) {
      if (state !== "stopped") state = "draining";
    },

    async stop(_context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      await Promise.allSettled([...active].map(async (client) => client.close()));
      active.clear();
      state = "stopped";
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      return {
        status: state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown",
        checkedAt: new Date().toISOString(),
        summary: `runtime-codex is ${state}`,
        details: { state, activeTurns: active.size },
      };
    },

    diagnostics(_context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
      return [diagnostic("runtime-codex.lifecycle", "info", `Runtime state: ${state}`)];
    },

    validateModel(model) {
      if (!safeModel(model)) {
        return { supported: false, diagnostics: [diagnostic("runtime-codex.model", "error", "Codex model identifier is invalid")] };
      }
      return { supported: true, capabilities: this.capabilities };
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimeCodexError("RUNTIME_NOT_RUNNING", `runtime-codex is ${state}`, { retryability: "not-retryable" });
      if (!safeModel(request.model)) throw new RuntimeCodexError("MODEL_INVALID", "Codex model identifier is invalid", { retryability: "not-retryable" });
      if (request.tools.length > 0) throw new RuntimeCodexError("TOOLS_UNSUPPORTED", "runtime-codex does not expose Core tools", { retryability: "not-retryable" });
      if (request.session?.runtimeInstanceId !== undefined && request.session.runtimeInstanceId !== options.instanceId) {
        throw new RuntimeCodexError("SESSION_INVALID", "Codex session belongs to another runtime instance", { retryability: "not-retryable" });
      }
      if (request.signal.aborted) return { status: "cancelled" };

      const client = newClient();
      active.add(client);
      let threadId: string | undefined;
      let turnId: string | undefined;
      let output = "";
      const streamedItemIds = new Set<string>();
      let terminalResolve!: (message: JsonRpcMessage) => void;
      let terminalReject!: (error: Error) => void;
      const terminal = new Promise<JsonRpcMessage>((resolve, reject) => {
        terminalResolve = resolve;
        terminalReject = reject;
      });
      const unsubscribe = client.subscribe((message) => {
        if (message.method === undefined || threadId === undefined) return;
        const params = record(message.params);
        if (!notificationMatches(params, threadId, turnId)) return;
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
          if (typeof params.itemId === "string") streamedItemIds.add(params.itemId);
          output += params.delta;
          void context.emit({ type: "text-delta", delta: params.delta });
        } else if (message.method === "item/completed") {
          const item = record(params.item);
          if (item.type === "agentMessage" && typeof item.text === "string"
            && (typeof item.id !== "string" || !streamedItemIds.has(item.id))) {
            output += item.text;
            void context.emit({ type: "text-delta", delta: item.text });
          }
        } else if ((message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") && typeof params.delta === "string") {
          void context.emit({ type: "thinking-delta", delta: params.delta });
        } else if (message.method === "turn/completed") terminalResolve(message);
        else if (message.method === "error" || message.method === "$transport/closed") {
          terminalReject(new Error(redact(
            typeof params.message === "string" ? params.message : "Codex turn failed",
            options.config.auth?.apiKey,
          )));
        }
      });

      const onAbort = (): void => {
        if (threadId !== undefined && turnId !== undefined) void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        terminalResolve({ method: "cancelled" });
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      let unregisterLiveInput: (() => void) | undefined;
      try {
        await client.request("initialize", {
          clientInfo: { name: "mono-agent", title: "mono-agent runtime-codex", version: "0.15.0" },
          capabilities: { experimentalApi: false },
        });
        await client.notify("initialized", {});

        const system = authoredSystem(request.messages);
        const threadResult = request.session === undefined
          ? await client.request("thread/start", {
              cwd: options.workspaceDirectory,
              model: request.model,
              approvalPolicy: "never",
              sandbox: "read-only",
              ephemeral: false,
              ...(system === undefined ? {} : { developerInstructions: system }),
            })
          : await client.request("thread/resume", {
              threadId: request.session.id,
              cwd: options.workspaceDirectory,
              model: request.model,
              approvalPolicy: "never",
              sandbox: "read-only",
              ...(system === undefined ? {} : { developerInstructions: system }),
            });
        threadId = resultThreadId(threadResult);
        if (threadId === undefined) throw new Error("Codex app-server did not return a thread id");
        const linked = session(options.instanceId, threadId, request.model);
        await context.emit({ type: "session", session: linked });

        if (context.registerLiveInput !== undefined) {
          unregisterLiveInput = context.registerLiveInput(async (input) => {
            if (threadId === undefined || turnId === undefined || request.signal.aborted) return "requeue";
            try {
              await client.request("turn/steer", {
                threadId,
                expectedTurnId: turnId,
                input: [{ type: "text", text: input.text }],
              });
              return "applied";
            } catch {
              return "requeue";
            }
          });
        }

        const turnResult = await client.request("turn/start", {
          threadId,
          model: request.model,
          input: [{ type: "text", text: prompt(request.messages, request.session !== undefined) }],
          ...(request.options?.effort === undefined ? {} : { effort: request.options.effort }),
          ...(request.options?.responseSchema === undefined ? {} : { outputSchema: request.options.responseSchema }),
        });
        turnId = resultTurnId(turnResult);
        if (turnId === undefined) throw new Error("Codex app-server did not return a turn id");
        if (request.signal.aborted) onAbort();
        const completed = await terminal;
        const linkedSession = session(options.instanceId, threadId, request.model);
        if (request.signal.aborted || completed.method === "cancelled") {
          return { status: "cancelled", session: linkedSession };
        }
        const turn = nestedRecord(completed.params, "turn");
        if (turn.status !== "completed") {
          const error = record(turn.error);
          throw new RuntimeCodexError(
            "PROVIDER_FAILED",
            redact(typeof error.message === "string" ? error.message : "Codex turn failed", options.config.auth?.apiKey),
            { retryability: "unknown", sideEffects: "unknown" },
          );
        }
        if (output === "" && Array.isArray(turn.items)) {
          output = turn.items.map((candidate) => {
            const item = record(candidate);
            return item.type === "agentMessage" && typeof item.text === "string" ? item.text : "";
          }).join("");
          if (output !== "") await context.emit({ type: "text-delta", delta: output });
        }
        let structuredOutput;
        if (request.options?.responseSchema !== undefined) {
          try { structuredOutput = JSON.parse(output); }
          catch (error) {
            throw new RuntimeCodexError("PROTOCOL_INVALID", "Codex structured response was not valid JSON", {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: error,
            });
          }
        }
        return {
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text: output }] },
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          session: linkedSession,
          metadata: { provider: "codex", model: request.model, nativeTurnId: turnId } as JsonObject,
        };
      } catch (error) {
        if (request.signal.aborted) return { status: "cancelled", ...(threadId === undefined ? {} : { session: session(options.instanceId, threadId, request.model) }) };
        if (error instanceof RuntimeCodexError) throw error;
        throw new RuntimeCodexError("PROVIDER_FAILED", redact(error, options.config.auth?.apiKey), {
          retryability: "unknown",
          sideEffects: turnId === undefined ? "none" : "unknown",
          cause: error,
        });
      } finally {
        unregisterLiveInput?.();
        request.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        await client.close();
        active.delete(client);
      }
    },
  };
}

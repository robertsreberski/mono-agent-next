// SPDX-License-Identifier: MIT
import { isAbsolute } from "node:path";

import { RUNTIME_SESSION_UNAVAILABLE_CODE, RuntimeTurnError } from "@mono-agent/module-sdk";
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
import type { SandboxExecutor } from "@mono-agent/module-sdk/internal";

import { captureApprovalEvidence, handleCodexServerRequest, type CodexItemEvidence } from "./approvals.js";
import type { RuntimeCodexConfig } from "./config.js";
import { approvalPolicy, containedCodexConfig, type EffectiveCodexMcpServer } from "./containment.js";
import { codexProcessEnvironment } from "./environment.js";
import {
  JsonRpcProcess,
  JsonRpcProcessTerminationError,
  JsonRpcRequestError,
  type JsonRpcMessage,
  type SpawnProcess,
} from "./json-rpc.js";
import { isRuntimeCodexModel, runtimeCodexCapabilities, validateRuntimeCodexModel } from "./model.js";
import {
  assertFrozenAppServerMcpConfig,
  cancellationError,
  CodexPreflightTerminationError,
  codexAppServerArguments,
  createProcessWorkingDirectory,
  preflightCodexProcess,
  preparePersistentCodexHome,
  prepareSandboxDataDirectory,
  resolveNativeCodexHome,
} from "./preflight.js";
import { codexSandboxSpawn } from "./sandbox.js";

type RuntimeState = "created" | "running" | "draining" | "stopped";

interface ActiveTurnAttempt {
  client?: JsonRpcProcess;
  readonly settled: Promise<void>;
  cancel(): void;
}

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
  readonly dataDirectory: string;
  readonly spawnProcess?: SpawnProcess;
  readonly sandboxExecutor?: SandboxExecutor;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return record(record(value)[key]);
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

function session(instanceId: string, id: string, conversationId: string, model: string): RuntimeSession {
  return {
    id,
    conversationId,
    route: { runtimeInstanceId: instanceId, model },
    createdAt: new Date().toISOString(),
    metadata: { provider: "codex", protocol: "codex-app-server-v2" },
  };
}

function assertSessionLinkage(request: RuntimeTurnRequest, instanceId: string): void {
  if (request.session === undefined) return;
  if (request.session.route?.runtimeInstanceId !== instanceId) {
    throw new RuntimeCodexError(
      "SESSION_INVALID",
      "Codex session belongs to another runtime instance",
      { retryability: "not-retryable" },
    );
  }
  if (request.session.route.model !== request.model) {
    throw new RuntimeCodexError(
      "SESSION_INVALID",
      "Codex session belongs to another model route",
      { retryability: "not-retryable" },
    );
  }
  if (request.session.conversationId !== request.conversationId) {
    throw new RuntimeCodexError(
      "SESSION_INVALID",
      "Codex session belongs to another conversation",
      { retryability: "not-retryable" },
    );
  }
}

function diagnostic(code: string, severity: ModuleDiagnostic["severity"], message: string): ModuleDiagnostic {
  return { code, severity, message };
}

function redact(value: unknown, secret: string | undefined): string {
  let message = "Codex provider operation failed";
  if (typeof value === "string") {
    message = value;
  } else if (value instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    if (
      descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string"
    ) {
      message = descriptor.value;
    }
  }
  if (secret !== undefined && secret.length > 0) message = message.split(secret).join("[REDACTED]");
  message = message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  return message.length <= 4_096 ? message : `${message.slice(0, 4_095)}…`;
}

function safeErrorCause(value: unknown, secret: string | undefined): Error {
  const cause = new Error(redact(value, secret));
  cause.name = "RuntimeCodexCause";
  return cause;
}

function resultThreadId(value: unknown): string | undefined {
  const thread = nestedRecord(value, "thread");
  return typeof thread.id === "string" ? thread.id : undefined;
}

function resultTurnId(value: unknown): string | undefined {
  const turn = nestedRecord(value, "turn");
  return typeof turn.id === "string" ? turn.id : undefined;
}

function isMissingCodexSession(error: unknown, threadId: string): boolean {
  if (!(error instanceof JsonRpcRequestError)) return false;
  return error.rpcMessage === `no rollout found for thread id ${threadId}`
    || error.rpcMessage === `thread not found: ${threadId}`;
}

function notificationMatches(params: Record<string, unknown>, threadId: string, turnId: string | undefined): boolean {
  if (params.threadId !== undefined && params.threadId !== threadId) return false;
  return turnId === undefined || params.turnId === undefined || params.turnId === turnId
    || record(params.turn).id === turnId;
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancellationError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

function emitIsolated(context: RuntimeTurnContext, event: Parameters<RuntimeTurnContext["emit"]>[0]): void {
  try {
    void Promise.resolve(context.emit(event)).catch(() => undefined);
  } catch {
    // Streaming consumers cannot take down the provider transport.
  }
}

export function createRuntimeCodex(options: CreateRuntimeCodexOptions): Runtime {
  if (
    options.sandboxExecutor !== undefined
    && !isAbsolute(options.config.binary)
  ) {
    throw new TypeError(
      "runtime-codex config.binary must be an absolute path when a Core sandbox is selected",
    );
  }
  let state: RuntimeState = "created";
  const active = new Set<ActiveTurnAttempt>();
  let codexHome: string | undefined;
  let sandboxDataDirectory: string | undefined;
  let startMcpServers: readonly EffectiveCodexMcpServer[] | undefined;
  let terminationFailure: JsonRpcProcessTerminationError | undefined;
  const spawnProcess = options.sandboxExecutor === undefined
    ? options.spawnProcess
    : codexSandboxSpawn(options.sandboxExecutor);

  const processEnvironment = (home: string): NodeJS.ProcessEnv => ({
    ...codexProcessEnvironment(
      options.config.auth === undefined
        ? {}
        : { OPENAI_API_KEY: options.config.auth.apiKey },
      options.sandboxExecutor === undefined ? process.env : {},
    ),
    CODEX_HOME: home,
  });

  const captureTerminationFailure = (error: unknown): void => {
    terminationFailure ??= error instanceof JsonRpcProcessTerminationError
      ? error
      : new JsonRpcProcessTerminationError(
          redact(error, options.config.auth?.apiKey),
          { cause: safeErrorCause(error, options.config.auth?.apiKey) },
        );
    if (state !== "stopped") state = "draining";
  };

  const lifecycleTerminationError = (
    sideEffects: RuntimeSideEffectStatus,
  ): RuntimeCodexError => new RuntimeCodexError(
    "PROCESS_TERMINATION_FAILED",
    redact(terminationFailure, options.config.auth?.apiKey),
    {
      retryability: "not-retryable",
      sideEffects,
      cause: safeErrorCause(terminationFailure, options.config.auth?.apiKey),
    },
  );

  const cleanupAfterClose = (
    closed: Promise<unknown>,
    cleanup: () => Promise<void>,
  ): void => {
    void closed.then(cleanup).catch(() => undefined);
  };

  const newClient = (processDirectory: string, home: string,
    mcpServers: readonly EffectiveCodexMcpServer[]): JsonRpcProcess => new JsonRpcProcess({
    command: options.config.binary,
    args: codexAppServerArguments(mcpServers),
    cwd: processDirectory,
    env: processEnvironment(home),
    timeoutMs: options.config.requestTimeoutMs,
    maxLineBytes: options.config.maxLineBytes,
    maxStderrBytes: options.config.maxStderrBytes,
    ...(spawnProcess === undefined ? {} : { spawnProcess }),
  });

  return {
    capabilities: Object.freeze({
      ...runtimeCodexCapabilities,
      sandbox: options.sandboxExecutor !== undefined,
    }),

    async start(context: ModuleStartContext) {
      if (terminationFailure !== undefined) {
        throw lifecycleTerminationError("none");
      }
      if (state === "stopped") throw new RuntimeCodexError("RUNTIME_NOT_RUNNING", "runtime-codex cannot restart after stop", { retryability: "not-retryable" });
      if (state === "running") return;
      let processDirectory:
        | Awaited<ReturnType<typeof createProcessWorkingDirectory>>
        | undefined;
      let retainProcessDirectory = false;
      try {
        const preparedSandboxDataDirectory = options.sandboxExecutor === undefined
          ? undefined
          : await prepareSandboxDataDirectory(options.dataDirectory);
        const preparedHome = options.config.auth === undefined
          ? await resolveNativeCodexHome()
          : await preparePersistentCodexHome(options.dataDirectory);
        processDirectory = await createProcessWorkingDirectory(
          preparedSandboxDataDirectory,
        );
        startMcpServers = await preflightCodexProcess({
          command: options.config.binary,
          cwd: processDirectory.directory,
          env: processEnvironment(preparedHome),
          timeoutMs: Math.min(options.config.requestTimeoutMs, 15_000),
          signal: context.signal,
          ...(spawnProcess === undefined
            ? {}
            : { spawnProcess }),
          probeStrictConfig: true,
        });
        codexHome = preparedHome;
        sandboxDataDirectory = preparedSandboxDataDirectory;
      } catch (error) {
        if (error instanceof CodexPreflightTerminationError) {
          captureTerminationFailure(error);
          if (processDirectory !== undefined) {
            retainProcessDirectory = true;
            const retainedDirectory = processDirectory;
            cleanupAfterClose(
              error.closed,
              async () => retainedDirectory.cleanup(),
            );
          }
          throw lifecycleTerminationError("none");
        }
        throw new RuntimeCodexError(
          "RUNTIME_PREFLIGHT_FAILED",
          redact(error, options.config.auth?.apiKey),
          {
            retryability: "not-retryable",
            sideEffects: "none",
            cause: safeErrorCause(error, options.config.auth?.apiKey),
          },
        );
      } finally {
        if (!retainProcessDirectory) await processDirectory?.cleanup();
      }
      state = "running";
    },

    async drain(_context: ModuleDrainContext) {
      if (state !== "stopped") state = "draining";
    },

    async stop(_context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      const turns = [...active];
      for (const turn of turns) turn.cancel();
      const shutdownResults = await Promise.allSettled(turns.flatMap(
        (turn) => [
          ...(turn.client === undefined ? [] : [turn.client.close()]),
          turn.settled,
        ],
      ));
      for (const result of shutdownResults) {
        if (result.status === "rejected") {
          captureTerminationFailure(result.reason);
        }
      }
      active.clear();
      if (terminationFailure !== undefined) {
        state = "draining";
        throw lifecycleTerminationError("unknown");
      }
      state = "stopped";
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      return {
        status: terminationFailure !== undefined
          ? "unhealthy"
          : state === "running"
            ? "healthy"
            : state === "draining"
              ? "degraded"
              : "unknown",
        checkedAt: new Date().toISOString(),
        summary: `runtime-codex is ${state}`,
        details: {
          state,
          activeTurns: active.size,
          ...(terminationFailure === undefined
            ? {}
            : { quarantineCode: "PROCESS_TERMINATION_FAILED" }),
        },
      };
    },

    diagnostics(_context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
      return [diagnostic(
        "runtime-codex.lifecycle",
        terminationFailure === undefined ? "info" : "error",
        `Runtime state: ${state}`
        + (terminationFailure === undefined ? "" : "; process termination failed"),
      )];
    },

    preflightModel(request) {
      request.signal.throwIfAborted();
      const validation = validateRuntimeCodexModel({
        model: request.model,
        config: options.config,
      });
      return validation.capabilities === undefined
        ? validation
        : {
            ...validation,
            capabilities: Object.freeze({
              ...validation.capabilities,
              sandbox: options.sandboxExecutor !== undefined,
            }),
          };
    },

    async runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult> {
      if (state !== "running") throw new RuntimeCodexError("RUNTIME_NOT_RUNNING", `runtime-codex is ${state}`, { retryability: "not-retryable" });
      if (!isRuntimeCodexModel(request.model)) throw new RuntimeCodexError("MODEL_INVALID", "Codex model identifier is invalid", { retryability: "not-retryable" });
      if (request.tools.length > 0) throw new RuntimeCodexError("TOOLS_UNSUPPORTED", "runtime-codex does not expose Core tools", { retryability: "not-retryable" });
      assertSessionLinkage(request, options.instanceId);
      if (request.signal.aborted) return { status: "cancelled" };

      const stopController = new AbortController();
      const turnSignal = AbortSignal.any([request.signal, stopController.signal]);
      let resolveSettled!: () => void;
      const attempt: ActiveTurnAttempt = {
        cancel() { stopController.abort(); },
        settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
      };
      const settleAttempt = (): void => {
        active.delete(attempt);
        resolveSettled();
      };
      active.add(attempt);

      const preparedHome = codexHome;
      if (preparedHome === undefined || startMcpServers === undefined) {
        settleAttempt();
        throw new RuntimeCodexError(
          "RUNTIME_NOT_RUNNING",
          "runtime-codex has no preflighted process home",
          { retryability: "not-retryable" },
        );
      }
      let turnMcpServers: readonly EffectiveCodexMcpServer[];
      let processDirectory:
        | Awaited<ReturnType<typeof createProcessWorkingDirectory>>
        | undefined;
      try {
        processDirectory = await createProcessWorkingDirectory(
          sandboxDataDirectory,
        );
        turnMcpServers = await preflightCodexProcess({
          command: options.config.binary,
          cwd: processDirectory.directory,
          env: processEnvironment(preparedHome),
          timeoutMs: Math.min(options.config.requestTimeoutMs, 15_000),
          signal: turnSignal,
          ...(spawnProcess === undefined
            ? {}
            : { spawnProcess }),
          probeStrictConfig: false,
        });
      } catch (error) {
        if (error instanceof CodexPreflightTerminationError) {
          const retainedDirectory = processDirectory;
          captureTerminationFailure(error);
          if (retainedDirectory !== undefined) {
            cleanupAfterClose(
              error.closed,
              async () => retainedDirectory.cleanup(),
            );
          }
          settleAttempt();
          throw lifecycleTerminationError("none");
        }
        await processDirectory?.cleanup().catch(() => undefined);
        settleAttempt();
        if (turnSignal.aborted) return { status: "cancelled" };
        throw new RuntimeCodexError(
          "PROVIDER_FAILED",
          "runtime-codex could not preflight its isolated provider process",
          {
            retryability: "unknown",
            sideEffects: "none",
            cause: safeErrorCause(error, options.config.auth?.apiKey),
          },
        );
      }
      if (turnSignal.aborted) {
        await processDirectory.cleanup().catch(() => undefined);
        settleAttempt();
        return { status: "cancelled" };
      }
      let client: JsonRpcProcess;
      try {
        client = newClient(
          processDirectory.directory,
          preparedHome,
          turnMcpServers,
        );
      } catch (error) {
        await processDirectory.cleanup().catch(() => undefined);
        settleAttempt();
        if (turnSignal.aborted) return { status: "cancelled" };
        throw new RuntimeCodexError(
          "PROVIDER_FAILED",
          redact(error, options.config.auth?.apiKey),
          {
            retryability: "unknown",
            sideEffects: "none",
            cause: safeErrorCause(error, options.config.auth?.apiKey),
          },
        );
      }
      attempt.client = client;
      const clientRequest = async (method: string, params: unknown): Promise<unknown> =>
        abortable(async () => client.request(method, params), turnSignal);
      const clientNotify = async (method: string, params: unknown): Promise<void> =>
        abortable(async () => client.notify(method, params), turnSignal);
      let threadId: string | undefined;
      let turnId: string | undefined;
      let turnStartPending = false;
      let resolveTurnIdentity!: () => void;
      let turnIdentitySettled = false;
      const turnIdentityReady = new Promise<void>((resolve) => {
        resolveTurnIdentity = () => {
          if (turnIdentitySettled) return;
          turnIdentitySettled = true;
          resolve();
        };
      });
      let output = "";
      const nativeApprovalPolicy = approvalPolicy(context);
      const streamedItemIds = new Set<string>();
      const approvalEvidence = new Map<string, CodexItemEvidence>();
      let terminalResolve!: (message: JsonRpcMessage) => void;
      let terminalReject!: (error: Error) => void;
      const terminal = new Promise<JsonRpcMessage>((resolve, reject) => {
        terminalResolve = resolve;
        terminalReject = reject;
      });
      void terminal.catch(() => undefined);
      const unsubscribe = client.subscribe((message) => {
        if (message.method === undefined || threadId === undefined) return;
        const params = record(message.params);
        if (!notificationMatches(params, threadId, turnId)) return;
        captureApprovalEvidence(message, approvalEvidence);
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
          if (typeof params.itemId === "string") streamedItemIds.add(params.itemId);
          output += params.delta;
          emitIsolated(context, { type: "text-delta", delta: params.delta });
        } else if (message.method === "item/completed") {
          const item = record(params.item);
          if (item.type === "agentMessage" && typeof item.text === "string"
            && (typeof item.id !== "string" || !streamedItemIds.has(item.id))) {
            output += item.text;
            emitIsolated(context, { type: "text-delta", delta: item.text });
          }
        } else if ((message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") && typeof params.delta === "string") {
          emitIsolated(context, { type: "thinking-delta", delta: params.delta });
        } else if (message.method === "turn/completed") terminalResolve(message);
        else if (message.method === "error" || message.method === "$transport/closed") {
          terminalReject(new Error(redact(
            typeof params.message === "string" ? params.message : "Codex turn failed",
            options.config.auth?.apiKey,
          )));
        }
      });
      const unregisterServerRequests = client.handleServerRequests(
        async (message) => {
          if (
            turnStartPending
            && turnId === undefined
            && (
              message.method === "item/commandExecution/requestApproval"
              || message.method === "item/fileChange/requestApproval"
              || message.method === "item/permissions/requestApproval"
            )
          ) {
            await turnIdentityReady;
          }
          return handleCodexServerRequest(
            message,
            context,
            turnSignal,
            threadId,
            turnId,
            approvalEvidence,
            options.config.auth?.apiKey,
            options.config.requestTimeoutMs,
          );
        },
      );

      let cancellationSettled = false;
      const settleCancellation = (): void => {
        if (cancellationSettled) return;
        cancellationSettled = true;
        resolveTurnIdentity();
        if (threadId !== undefined && turnId !== undefined) void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        terminalResolve({ method: "cancelled" });
      };
      const onAbort = (): void => {
        settleCancellation();
        void client.close().catch(captureTerminationFailure);
      };
      turnSignal.addEventListener("abort", onAbort, { once: true });
      if (turnSignal.aborted) onAbort();

      let unregisterLiveInput: (() => void) | undefined;
      try {
        await clientRequest("initialize", {
          clientInfo: { name: "mono-agent", title: "mono-agent runtime-codex", version: "0.15.0" },
          capabilities: { experimentalApi: false },
        });
        await clientNotify("initialized", {});
        const effectiveConfig = await clientRequest("config/read", {
          includeLayers: false,
          cwd: processDirectory.directory,
        });
        assertFrozenAppServerMcpConfig(effectiveConfig, turnMcpServers);
        const workspaceConfig = await clientRequest("config/read", {
          includeLayers: false,
          cwd: options.workspaceDirectory,
        });
        assertFrozenAppServerMcpConfig(workspaceConfig, turnMcpServers);

        const system = authoredSystem(request.messages);
        const threadResult = request.session === undefined
          ? await clientRequest("thread/start", {
              cwd: options.workspaceDirectory,
              model: request.model,
              approvalPolicy: nativeApprovalPolicy,
              approvalsReviewer: "user",
              sandbox: "read-only",
              ephemeral: false,
              config: containedCodexConfig(turnMcpServers),
              ...(system === undefined ? {} : { developerInstructions: system }),
            })
          : await clientRequest("thread/resume", {
              threadId: request.session.id,
              cwd: options.workspaceDirectory,
              model: request.model,
              approvalPolicy: nativeApprovalPolicy,
              approvalsReviewer: "user",
              sandbox: "read-only",
              config: containedCodexConfig(turnMcpServers),
              ...(system === undefined ? {} : { developerInstructions: system }),
            });
        threadId = resultThreadId(threadResult);
        if (threadId === undefined) throw new Error("Codex app-server did not return a thread id");
        const linked = session(
          options.instanceId,
          threadId,
          request.conversationId,
          request.model,
        );
        await context.emit({ type: "session", session: linked });

        if (context.registerLiveInput !== undefined) {
          unregisterLiveInput = context.registerLiveInput(async (input) => {
            if (threadId === undefined || turnId === undefined || turnSignal.aborted) return "requeue";
            try {
              await abortable(
                async () => client.request("turn/steer", {
                  threadId,
                  expectedTurnId: turnId,
                  input: [{ type: "text", text: input.text }],
                }),
                turnSignal,
              );
              return "applied";
            } catch {
              return "requeue";
            }
          });
        }

        let turnResult: unknown;
        turnStartPending = true;
        try {
          turnResult = await clientRequest("turn/start", {
            threadId,
            model: request.model,
            approvalPolicy: nativeApprovalPolicy,
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            input: [{ type: "text", text: prompt(request.messages, request.session !== undefined) }],
            ...(request.options?.effort === undefined ? {} : { effort: request.options.effort }),
            ...(request.options?.responseSchema === undefined ? {} : { outputSchema: request.options.responseSchema }),
          });
          turnId = resultTurnId(turnResult);
          if (turnId === undefined) throw new Error("Codex app-server did not return a turn id");
        } finally {
          turnStartPending = false;
          resolveTurnIdentity();
        }
        if (turnSignal.aborted) onAbort();
        const completed = await terminal;
        const linkedSession = session(
          options.instanceId,
          threadId,
          request.conversationId,
          request.model,
        );
        if (turnSignal.aborted || completed.method === "cancelled") {
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
          if (output !== "") emitIsolated(context, { type: "text-delta", delta: output });
        }
        let structuredOutput;
        if (request.options?.responseSchema !== undefined) {
          try { structuredOutput = JSON.parse(output); }
          catch (error) {
            throw new RuntimeCodexError("PROTOCOL_INVALID", "Codex structured response was not valid JSON", {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: safeErrorCause(error, options.config.auth?.apiKey),
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
        if (turnSignal.aborted) {
          return {
            status: "cancelled",
            ...(threadId === undefined
              ? {}
              : {
                  session: session(
                    options.instanceId,
                    threadId,
                    request.conversationId,
                    request.model,
                  ),
            }),
          };
        }
        if (
          request.session !== undefined
          && isMissingCodexSession(error, request.session.id)
        ) {
          throw new RuntimeCodexError(
            RUNTIME_SESSION_UNAVAILABLE_CODE,
            "The Codex session is no longer available for resume",
            { retryability: "not-retryable", sideEffects: "none" },
          );
        }
        if (error instanceof RuntimeCodexError) throw error;
        throw new RuntimeCodexError("PROVIDER_FAILED", redact(error, options.config.auth?.apiKey), {
          retryability: "unknown",
          sideEffects: turnId === undefined ? "none" : "unknown",
          cause: safeErrorCause(error, options.config.auth?.apiKey),
        });
      } finally {
        resolveTurnIdentity();
        try {
          unregisterLiveInput?.();
        } catch {
          // Cleanup is best effort and must not replace the turn result.
        }
        turnSignal.removeEventListener("abort", onAbort);
        try {
          unregisterServerRequests();
        } catch {
          // Cleanup is best effort and must not replace the turn result.
        }
        try {
          unsubscribe();
        } catch {
          // Cleanup is best effort and must not replace the turn result.
        }
        let retainProcessDirectory = false;
        try {
          await client.close();
        } catch (error) {
          retainProcessDirectory = true;
          captureTerminationFailure(error);
          const retainedDirectory = processDirectory;
          cleanupAfterClose(
            client.closed,
            async () => retainedDirectory.cleanup(),
          );
        }
        if (!retainProcessDirectory) {
          await processDirectory.cleanup().catch(() => undefined);
        }
        settleAttempt();
      }
    },
  };
}

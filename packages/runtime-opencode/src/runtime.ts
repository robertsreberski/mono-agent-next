import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  RuntimeUsage,
  TurnMessage,
} from "@mono-agent/module-sdk";

import {
  OPEN_CODE_SECURE_SERVER_VERSION,
  type RuntimeOpenCodeConfig,
} from "./config.js";
import {
  OPEN_CODE_TOOL_FREE_AGENT,
  openCodeProcessEnvironment,
  type OpenCodeIsolatedDirectories,
} from "./environment.js";
import {
  isRuntimeOpenCodeModel,
  runtimeOpenCodeCapabilities,
  validateRuntimeOpenCodeModel,
} from "./model.js";
import {
  capturePlainText,
  OpenCodeProcessTerminationError,
  startOpenCodeServerProcess,
  type OpenCodeServerProcess,
  type SpawnProcess,
} from "./process.js";
import {
  OpenCodeServerClient,
  OpenCodeServerHttpError,
  type OpenCodeEventSubscription,
  type OpenCodeServerEvent,
} from "./server.js";

type RuntimeState = "created" | "starting" | "running" | "draining" | "stopped";
const SAFE_CAUSE_MESSAGE_CHARS = 4_096;
const SAFE_CAUSE_IDENTITY_CHARS = 128;

interface ActiveOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  sessionId?: string;
}

interface Isolation {
  readonly root: string;
  readonly directories: OpenCodeIsolatedDirectories;
}

interface PartState {
  readonly type: "text" | "reasoning";
  text: string;
  emitted: string;
  readonly messageId: string;
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
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
  return "OpenCode provider failure";
}

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "… [truncated]";
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
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
    const cause = safeCause(options.cause, []);
    super({
      code,
      message,
      retryability: options.retryability ?? "unknown",
      sideEffects: options.sideEffects ?? "none",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "RuntimeOpenCodeError";
  }
}

export interface CreateRuntimeOpenCodeOptions {
  readonly config: RuntimeOpenCodeConfig;
  readonly instanceId: string;
  readonly workspaceDirectory: string;
  readonly spawnProcess?: SpawnProcess;
  readonly fetch?: typeof globalThis.fetch;
  readonly terminationGraceMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function diagnostic(
  code: string,
  severity: ModuleDiagnostic["severity"],
  message: string,
): ModuleDiagnostic {
  return { code, severity, message };
}

function redact(value: unknown, secrets: readonly string[]): string {
  let message = failureMessage(value);
  for (const secret of [...new Set(secrets)].filter(Boolean).sort(
    (left, right) => right.length - left.length,
  )) {
    message = message.split(secret).join("[REDACTED]");
  }
  return bounded(
    message
      .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
      .replace(/\bBasic\s+[A-Za-z0-9+/=]+/giu, "Basic [REDACTED]"),
    SAFE_CAUSE_MESSAGE_CHARS,
  );
}

function safeCause(
  value: unknown,
  secrets: readonly string[],
): Error | undefined {
  if (value === undefined) return undefined;
  const snapshot = new Error(redact(value, secrets));
  const rawName = ownDataValue(value, "name");
  snapshot.name = bounded(
    redact(typeof rawName === "string" ? rawName : "Error", secrets),
    SAFE_CAUSE_IDENTITY_CHARS,
  );
  const rawCode = ownDataValue(value, "code");
  if (typeof rawCode === "string" || typeof rawCode === "number") {
    Object.defineProperty(snapshot, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: bounded(
        redact(String(rawCode), secrets),
        SAFE_CAUSE_IDENTITY_CHARS,
      ),
    });
  }
  delete snapshot.stack;
  return Object.freeze(snapshot);
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(value);
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
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
    else if (part.type === "tool-call") {
      chunks.push(`[tool call ${part.call.name}: ${JSON.stringify(part.call.input)}]`);
    } else if (part.type === "tool-result") {
      chunks.push(`[tool result ${part.result.callId}: ${JSON.stringify(part.result.content)}]`);
    } else {
      throw new RuntimeOpenCodeError(
        "ATTACHMENT_UNSUPPORTED",
        "runtime-opencode does not accept in-memory attachments",
        { retryability: "not-retryable" },
      );
    }
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
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${textOf(message)}`)
    .join("\n\n");
}

function linkedSession(
  instanceId: string,
  id: string,
  conversationId: string,
  model: string,
): RuntimeSession {
  return {
    id,
    conversationId,
    route: { runtimeInstanceId: instanceId, model },
    createdAt: new Date().toISOString(),
    metadata: {
      provider: "opencode",
      protocol: "opencode-authenticated-server-v1",
    },
  };
}

function providerErrorMessage(value: unknown): string {
  const candidate = record(value);
  const data = record(candidate.data);
  if (typeof data.message === "string") return data.message;
  if (typeof candidate.message === "string") return candidate.message;
  if (typeof candidate.name === "string") return candidate.name;
  return "OpenCode turn failed";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usageOf(value: unknown): RuntimeUsage | undefined {
  const tokens = record(value);
  const inputTokens = number(tokens.input);
  const outputTokens = number(tokens.output);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cache = record(tokens.cache);
  const total = number(tokens.total);
  const reasoning = number(tokens.reasoning);
  const cacheRead = number(cache.read);
  const cacheWrite = number(cache.write);
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

function eventSessionId(event: OpenCodeServerEvent): string | undefined {
  if (typeof event.properties.sessionID === "string") {
    return event.properties.sessionID;
  }
  const part = record(event.properties.part);
  if (typeof part.sessionID === "string") return part.sessionID;
  const info = record(event.properties.info);
  return typeof info.sessionID === "string" ? info.sessionID : undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function waitAbortable(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitBounded(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function createIsolation(): Promise<Isolation> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-opencode-"));
  await chmod(root, 0o700);
  const directories: OpenCodeIsolatedDirectories = {
    home: join(root, "home"),
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    state: join(root, "state"),
  };
  await Promise.all(
    Object.values(directories).map((directory) => mkdir(directory, {
      recursive: true,
      mode: 0o700,
    })),
  );
  return { root, directories };
}

function nativeToolViolation(): RuntimeOpenCodeError {
  return new RuntimeOpenCodeError(
    "NATIVE_TOOL_PROTOCOL_VIOLATION",
    "OpenCode emitted native tool activity despite the enforced deny-all tool policy",
    { retryability: "not-retryable", sideEffects: "unknown" },
  );
}

export function createRuntimeOpenCode(options: CreateRuntimeOpenCodeOptions): Runtime {
  let state: RuntimeState = "created";
  let version: string | undefined;
  let server: OpenCodeServerProcess | undefined;
  let client: OpenCodeServerClient | undefined;
  let isolation: Isolation | undefined;
  let serverPassword: string | undefined;
  let agentName: string | undefined;
  let terminationFailure: OpenCodeProcessTerminationError | undefined;
  let quarantineFailure: RuntimeOpenCodeError | undefined;
  const active = new Set<ActiveOperation>();
  const sessionTails = new Map<string, Promise<void>>();

  const configuredSecrets = Object.values(options.config.environment);
  const secrets = (): readonly string[] => [
    ...configuredSecrets,
    ...(serverPassword === undefined ? [] : [serverPassword]),
  ];

  const acquireSession = async (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<() => void> => {
    const previous = sessionTails.get(sessionId) ?? Promise.resolve();
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => held);
    sessionTails.set(sessionId, tail);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseHeld();
      void tail.then(() => {
        if (sessionTails.get(sessionId) === tail) sessionTails.delete(sessionId);
      });
    };
    try {
      await waitAbortable(previous, signal);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  };

  const beginServerClose = (): void => {
    const owned = server;
    if (owned === undefined) return;
    void owned.close().catch((error: unknown) => {
      terminationFailure ??= error instanceof OpenCodeProcessTerminationError
        ? error
        : new OpenCodeProcessTerminationError(redact(error, secrets()));
      state = "draining";
    });
  };

  const quarantine = (failure: RuntimeOpenCodeError): RuntimeOpenCodeError => {
    quarantineFailure ??= failure;
    state = "draining";
    for (const operation of active) {
      operation.controller.abort(quarantineFailure);
    }
    beginServerClose();
    return quarantineFailure;
  };

  const processOptions = (
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv,
  ) => ({
    command: options.config.binary,
    cwd: options.workspaceDirectory,
    env: environment,
    signal,
    timeoutMs: options.config.timeoutMs,
    maxLineBytes: options.config.maxLineBytes,
    maxStderrBytes: options.config.maxStderrBytes,
    ...(options.spawnProcess === undefined ? {} : {
      spawnProcess: options.spawnProcess,
    }),
  });

  return {
    capabilities: runtimeOpenCodeCapabilities,

    async start(context: ModuleStartContext) {
      if (state !== "created") {
        throw new RuntimeOpenCodeError(
          "RUNTIME_NOT_RUNNING",
          `runtime-opencode cannot start while ${state}`,
          { retryability: "not-retryable" },
        );
      }
      state = "starting";
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let settleActive!: () => void;
      const operation: ActiveOperation = {
        controller,
        settled: new Promise<void>((resolve) => {
          settleActive = resolve;
        }),
      };
      active.add(operation);
      let localServer: OpenCodeServerProcess | undefined;
      let localIsolation: Isolation | undefined;
      try {
        const versionEnvironment = openCodeProcessEnvironment(
          options.config.environment,
        );
        const output = await capturePlainText({
          ...processOptions(signal, versionEnvironment),
          args: ["--version"],
        });
        const actual = parseVersion(output);
        const minimum = parseVersion(options.config.minimumVersion);
        if (
          actual === undefined
          || minimum === undefined
          || !atLeast(actual, minimum)
        ) {
          throw new RuntimeOpenCodeError(
            "VERSION_UNSUPPORTED",
            `runtime-opencode requires stable OpenCode >=${options.config.minimumVersion}; `
            + `found ${output || "unknown"}`,
            { retryability: "not-retryable" },
          );
        }
        if (signal.aborted) throw abortReason(signal);

        localIsolation = await createIsolation();
        isolation = localIsolation;
        serverPassword = randomBytes(32).toString("base64url");
        agentName = `${OPEN_CODE_TOOL_FREE_AGENT}-${randomBytes(8).toString("hex")}`;
        const username = "opencode";
        const environment = openCodeProcessEnvironment(
          options.config.environment,
          process.env,
          {
            directories: localIsolation.directories,
            agentName,
            serverUsername: username,
            serverPassword,
          },
        );
        localServer = await startOpenCodeServerProcess({
          ...processOptions(signal, environment),
          args: ["serve", "--hostname", "127.0.0.1", "--port", "0", "--pure"],
          ...(options.terminationGraceMs === undefined ? {} : {
            terminationGraceMs: options.terminationGraceMs,
          }),
        });
        server = localServer;
        const localClient = new OpenCodeServerClient({
          baseUrl: localServer.url,
          username,
          password: serverPassword,
          directory: options.workspaceDirectory,
          requestTimeoutMs: options.config.timeoutMs,
          maxFrameBytes: options.config.maxLineBytes,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        client = localClient;
        const healthVersion = await localClient.health(signal);
        const healthTuple = parseVersion(healthVersion);
        if (
          healthTuple === undefined
          || !atLeast(healthTuple, minimum)
          || healthVersion !== actual.join(".")
        ) {
          throw new RuntimeOpenCodeError(
            "VERSION_UNSUPPORTED",
            "OpenCode server health returned an unsupported or inconsistent version",
            { retryability: "not-retryable" },
          );
        }
        if (signal.aborted || state !== "starting") throw abortReason(signal);
        version = healthVersion;
        state = "running";
        void localServer.closed.then((exit) => {
          if (localServer?.isClosing() || state === "stopped") return;
          quarantine(new RuntimeOpenCodeError(
            "SERVER_EXITED",
            `OpenCode server exited unexpectedly`
            + (exit.code === null ? "" : ` with code ${exit.code}`),
            {
              retryability: "unknown",
              sideEffects: "unknown",
              cause: safeCause(exit.error, secrets()),
            },
          ));
        });
      } catch (error) {
        if (error instanceof OpenCodeProcessTerminationError) {
          terminationFailure ??= error;
        }
        if (localServer !== undefined) {
          try {
            await localServer.close();
          } catch (closeError) {
            terminationFailure ??= closeError instanceof OpenCodeProcessTerminationError
              ? closeError
              : new OpenCodeProcessTerminationError(redact(closeError, secrets()));
            state = "draining";
          }
        }
        if (localIsolation !== undefined && terminationFailure === undefined) {
          await rm(localIsolation.root, { recursive: true, force: true });
          if (isolation === localIsolation) isolation = undefined;
        }
        server = undefined;
        client = undefined;
        if (error instanceof OpenCodeProcessTerminationError) {
          state = "draining";
          throw new RuntimeOpenCodeError(
            "PROCESS_TERMINATION_FAILED",
            redact(error, secrets()),
            {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: safeCause(error, secrets()),
            },
          );
        }
        if (state === "starting") state = "created";
        if (error instanceof RuntimeOpenCodeError) throw error;
        throw new RuntimeOpenCodeError(
          "START_FAILED",
          redact(error, secrets()),
          {
            retryability: "unknown",
            sideEffects: "none",
            cause: safeCause(error, secrets()),
          },
        );
      } finally {
        active.delete(operation);
        settleActive();
      }
    },

    async drain(_context: ModuleDrainContext) {
      if (state !== "stopped") state = "draining";
    },

    async stop(_context: ModuleStopContext) {
      if (state === "stopped") return;
      state = "draining";
      const operations = [...active];
      const stopReason = new DOMException("Runtime stopped", "AbortError");
      for (const operation of operations) operation.controller.abort(stopReason);

      let shutdownFailure: unknown;
      try {
        await waitBounded(
          Promise.all(operations.map((operation) => operation.settled)).then(
            () => undefined,
          ),
          Math.min(options.config.timeoutMs, 10_000),
          "OpenCode turns did not settle during bounded shutdown",
        );
      } catch (error) {
        shutdownFailure = error;
      }

      if (server !== undefined) {
        try {
          await server.close();
        } catch (error) {
          terminationFailure ??= error instanceof OpenCodeProcessTerminationError
            ? error
            : new OpenCodeProcessTerminationError(redact(error, secrets()));
        }
      }
      if (terminationFailure === undefined && isolation !== undefined) {
        await rm(isolation.root, { recursive: true, force: true });
        isolation = undefined;
      }
      if (terminationFailure !== undefined) {
        state = "draining";
        throw new RuntimeOpenCodeError(
          "PROCESS_TERMINATION_FAILED",
          redact(terminationFailure, secrets()),
          {
            retryability: "not-retryable",
            sideEffects: "unknown",
            cause: safeCause(terminationFailure, secrets()),
          },
        );
      }
      if (shutdownFailure !== undefined) {
        state = "draining";
        throw new RuntimeOpenCodeError(
          "SHUTDOWN_TIMEOUT",
          redact(shutdownFailure, secrets()),
          {
            retryability: "not-retryable",
            sideEffects: "unknown",
            cause: safeCause(shutdownFailure, secrets()),
          },
        );
      }
      state = "stopped";
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      return {
        status: state === "running"
          ? "healthy"
          : state === "draining"
            ? "degraded"
            : "unknown",
        checkedAt: new Date().toISOString(),
        summary: `runtime-opencode is ${state}`,
        details: {
          state,
          activeTurns: active.size,
          ...(version === undefined ? {} : { version }),
          ...(quarantineFailure === undefined ? {} : {
            quarantineCode: quarantineFailure.code,
          }),
        },
      };
    },

    diagnostics(_context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
      return [
        diagnostic(
          "runtime-opencode.lifecycle",
          quarantineFailure === undefined ? "info" : "error",
          `Runtime state: ${state}`
          + (version === undefined ? "" : ` (${version})`)
          + (quarantineFailure === undefined
            ? ""
            : `; quarantined by ${quarantineFailure.code}`),
        ),
      ];
    },

    preflightModel(request) {
      request.signal.throwIfAborted();
      return validateRuntimeOpenCodeModel({
        model: request.model,
        config: options.config,
      });
    },

    async runTurn(
      request: RuntimeTurnRequest,
      context: RuntimeTurnContext,
    ): Promise<RuntimeTurnResult> {
      if (state !== "running" || client === undefined || agentName === undefined) {
        throw new RuntimeOpenCodeError(
          "RUNTIME_NOT_RUNNING",
          `runtime-opencode is ${state}`,
          { retryability: "not-retryable" },
        );
      }
      if (!isRuntimeOpenCodeModel(request.model)) {
        throw new RuntimeOpenCodeError(
          "MODEL_INVALID",
          "OpenCode model must use provider/model",
          { retryability: "not-retryable" },
        );
      }
      if (request.tools.length > 0) {
        throw new RuntimeOpenCodeError(
          "TOOLS_UNSUPPORTED",
          "runtime-opencode does not expose Core tools",
          { retryability: "not-retryable" },
        );
      }
      if (request.options?.responseSchema !== undefined) {
        throw new RuntimeOpenCodeError(
          "STRUCTURED_OUTPUT_UNSUPPORTED",
          "runtime-opencode does not support response schemas",
          { retryability: "not-retryable" },
        );
      }
      const sessionRoute = request.session?.route;
      if (
        request.session !== undefined
        && sessionRoute?.runtimeInstanceId !== options.instanceId
      ) {
        throw new RuntimeOpenCodeError(
          "SESSION_INVALID",
          "OpenCode session belongs to another runtime instance",
          { retryability: "not-retryable" },
        );
      }
      if (
        request.session !== undefined
        && sessionRoute?.model !== request.model
      ) {
        throw new RuntimeOpenCodeError(
          "SESSION_INVALID",
          "OpenCode session belongs to another model route",
          { retryability: "not-retryable" },
        );
      }
      if (
        request.session !== undefined
        && request.session.conversationId !== request.conversationId
      ) {
        throw new RuntimeOpenCodeError(
          "SESSION_INVALID",
          "OpenCode session belongs to another conversation",
          { retryability: "not-retryable" },
        );
      }
      if (request.signal.aborted) return { status: "cancelled" };

      const turnController = new AbortController();
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        const error = new Error(
          `OpenCode turn timed out after ${options.config.timeoutMs}ms`,
        );
        error.name = "TimeoutError";
        timeoutController.abort(error);
      }, options.config.timeoutMs);
      timeout.unref?.();
      const signal = AbortSignal.any([
        request.signal,
        turnController.signal,
        timeoutController.signal,
      ]);
      let settleActive!: () => void;
      const operation: ActiveOperation = {
        controller: turnController,
        settled: new Promise<void>((resolve) => {
          settleActive = resolve;
        }),
      };
      active.add(operation);

      const localClient = client;
      let sessionId = request.session?.id;
      let releaseSession: (() => void) | undefined;
      let subscription: OpenCodeEventSubscription | undefined;
      let output = "";
      let usage: RuntimeUsage | undefined;
      let providerFailure: string | undefined;
      let assistantMessageId: string | undefined;
      let completedAssistantMessageId: string | undefined;
      let promptDispatchAttempted = false;
      let turnCompletedSafely = false;
      let completionSettled = false;
      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const parts = new Map<string, PartState>();
      const partOrder: string[] = [];

      const complete = (): void => {
        if (completionSettled) return;
        completionSettled = true;
        resolveCompletion();
      };
      const fail = (error: unknown): void => {
        if (completionSettled) return;
        completionSettled = true;
        rejectCompletion(error);
      };
      const emitRemaining = async (): Promise<void> => {
        for (const id of partOrder) {
          const part = parts.get(id);
          if (part === undefined || part.messageId !== assistantMessageId) continue;
          if (!part.text.startsWith(part.emitted)) continue;
          const delta = part.text.slice(part.emitted.length);
          if (delta === "") continue;
          part.emitted += delta;
          if (part.type === "text") {
            await context.emit({ type: "text-delta", delta });
          } else {
            await context.emit({ type: "thinking-delta", delta });
          }
        }
      };
      const onEvent = async (event: OpenCodeServerEvent): Promise<void> => {
        const observedSessionId = eventSessionId(event);
        const part = record(event.properties.part);
        const isNativeToolPart = event.type === "message.part.updated"
          && part.type === "tool";
        const isNativePermission = event.type === "permission.asked";
        const nativeActivityApplies = observedSessionId === undefined
          || observedSessionId === sessionId;
        if ((isNativeToolPart || isNativePermission) && nativeActivityApplies) {
          const failure = quarantine(nativeToolViolation());
          fail(failure);
          throw failure;
        }
        if (
          observedSessionId !== undefined
          && observedSessionId !== sessionId
        ) return;

        if (event.type === "message.updated") {
          const info = record(event.properties.info);
          if (info.role !== "assistant") return;
          if (typeof info.id === "string") assistantMessageId = info.id;
          const time = record(info.time);
          if (time.completed === undefined) return;
          completedAssistantMessageId = assistantMessageId;
          if (info.error !== undefined) {
            providerFailure = redact(providerErrorMessage(info.error), secrets());
          }
          const finalUsage = usageOf(info.tokens);
          if (finalUsage !== undefined) {
            usage = finalUsage;
          }
          await emitRemaining();
          if (finalUsage !== undefined) {
            await context.emit({ type: "usage", usage: finalUsage });
          }
          return;
        }
        if (event.type === "message.part.updated") {
          if (part.type === "step-finish") {
            const stepUsage = usageOf(part.tokens);
            if (stepUsage !== undefined) usage = stepUsage;
            return;
          }
          if (
            (part.type !== "text" && part.type !== "reasoning")
            || typeof part.id !== "string"
            || typeof part.messageID !== "string"
          ) return;
          const existing = parts.get(part.id);
          if (existing === undefined) {
            parts.set(part.id, {
              type: part.type,
              text: typeof part.text === "string" ? part.text : "",
              emitted: "",
              messageId: part.messageID,
            });
            partOrder.push(part.id);
          } else if (typeof part.text === "string") {
            existing.text = part.text;
          }
          return;
        }
        if (event.type === "message.part.delta") {
          if (
            typeof event.properties.partID !== "string"
            || event.properties.field !== "text"
            || typeof event.properties.delta !== "string"
          ) return;
          const current = parts.get(event.properties.partID);
          if (current === undefined || current.messageId !== assistantMessageId) return;
          const delta = event.properties.delta;
          current.text += delta;
          current.emitted += delta;
          if (current.type === "text") {
            output += delta;
            await context.emit({ type: "text-delta", delta });
          } else {
            await context.emit({ type: "thinking-delta", delta });
          }
          return;
        }
        if (event.type === "session.error") {
          providerFailure = redact(
            providerErrorMessage(event.properties.error),
            secrets(),
          );
          await context.emit({
            type: "diagnostic",
            diagnostic: diagnostic(
              "runtime-opencode.provider",
              "error",
              providerFailure,
            ),
          });
          return;
        }
        if (event.type === "session.status") {
          const status = record(event.properties.status);
          if (
            status.type === "idle"
            && (
              providerFailure !== undefined
              || (
                completedAssistantMessageId !== undefined
                && completedAssistantMessageId === assistantMessageId
              )
            )
          ) complete();
        }
      };

      try {
        if (sessionId === undefined) {
          const created = await localClient.createSession(
            agentName,
            request.model,
            signal,
          );
          sessionId = created.id;
          operation.sessionId = sessionId;
          releaseSession = await acquireSession(sessionId, signal);
          await context.emit({
            type: "session",
            session: linkedSession(
              options.instanceId,
              sessionId,
              request.conversationId,
              request.model,
            ),
          });
        } else {
          operation.sessionId = sessionId;
          releaseSession = await acquireSession(sessionId, signal);
          await localClient.secureSession(sessionId, signal);
        }

        subscription = localClient.subscribe(signal, onEvent);
        void subscription.done.catch((error: unknown) => {
          if (completionSettled || signal.aborted) return;
          const failure = error instanceof RuntimeOpenCodeError
            ? error
            : new RuntimeOpenCodeError(
                "SSE_FAILED",
                redact(error, secrets()),
                {
                  retryability: "unknown",
                  sideEffects: promptDispatchAttempted ? "unknown" : "none",
                  cause: safeCause(error, secrets()),
                },
              );
          turnController.abort(failure);
          fail(failure);
        });
        await subscription.connected;
        if (signal.aborted) throw abortReason(signal);
        promptDispatchAttempted = true;
        await localClient.promptAsync(sessionId, {
          model: request.model,
          text: prompt(request.messages, request.session !== undefined),
          agent: agentName,
          ...(request.options?.effort === undefined ? {} : {
            variant: request.options.effort,
          }),
        }, signal);
        await waitAbortable(completion, signal);
        if (providerFailure !== undefined) {
          throw new RuntimeOpenCodeError(
            "PROVIDER_FAILED",
            providerFailure,
            { retryability: "unknown", sideEffects: "unknown" },
          );
        }
        await emitRemaining();
        output = partOrder
          .map((id) => parts.get(id))
          .filter((part): part is PartState => (
            part !== undefined
            && part.type === "text"
            && part.messageId === assistantMessageId
          ))
          .map((part) => part.text)
          .join("");
        const linked = linkedSession(
          options.instanceId,
          sessionId,
          request.conversationId,
          request.model,
        );
        turnCompletedSafely = true;
        return {
          status: "completed",
          message: {
            role: "assistant",
            content: [{ type: "text", text: output }],
          },
          ...(usage === undefined ? {} : { usage }),
          session: linked,
          metadata: {
            provider: "opencode",
            model: request.model,
            version: version ?? OPEN_CODE_SECURE_SERVER_VERSION,
          } as JsonObject,
        };
      } catch (error) {
        if (turnController.signal.reason instanceof RuntimeOpenCodeError) {
          throw turnController.signal.reason;
        }
        if (error instanceof RuntimeOpenCodeError) throw error;
        if (request.signal.aborted) {
          return {
            status: "cancelled",
            ...(sessionId === undefined ? {} : {
              session: linkedSession(
                options.instanceId,
                sessionId,
                request.conversationId,
                request.model,
              ),
            }),
          };
        }
        if (timeoutController.signal.aborted) {
          throw new RuntimeOpenCodeError(
            "TURN_TIMEOUT",
            redact(abortReason(timeoutController.signal), secrets()),
            {
              retryability: "unknown",
              sideEffects: "unknown",
              cause: safeCause(error, secrets()),
            },
          );
        }
        if (
          error instanceof OpenCodeServerHttpError
          && error.status === 404
          && request.session !== undefined
        ) {
          throw new RuntimeOpenCodeError(
            RUNTIME_SESSION_UNAVAILABLE_CODE,
            "OpenCode session no longer exists",
            {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: safeCause(error, secrets()),
            },
          );
        }
        if (quarantineFailure !== undefined) {
          throw quarantineFailure;
        }
        if (signal.aborted) {
          return {
            status: "cancelled",
            ...(sessionId === undefined ? {} : {
              session: linkedSession(
                options.instanceId,
                sessionId,
                request.conversationId,
                request.model,
              ),
            }),
          };
        }
        throw new RuntimeOpenCodeError(
          "PROVIDER_FAILED",
          redact(error, secrets()),
          {
            retryability: "unknown",
            sideEffects: "unknown",
            cause: safeCause(error, secrets()),
          },
        );
      } finally {
        clearTimeout(timeout);
        let cleanupFailure: RuntimeOpenCodeError | undefined;
        if (subscription !== undefined) {
          subscription.close(new DOMException("Turn settled", "AbortError"));
          try {
            await waitBounded(
              subscription.done.catch(() => undefined),
              Math.min(options.config.timeoutMs, 10_000),
              "OpenCode event subscription did not close",
            );
          } catch (error) {
            cleanupFailure = new RuntimeOpenCodeError(
              "SSE_SHUTDOWN_FAILED",
              redact(error, secrets()),
              {
                retryability: "not-retryable",
                sideEffects: "unknown",
                cause: safeCause(error, secrets()),
              },
            );
            state = "draining";
            beginServerClose();
          }
        }
        if (
          sessionId !== undefined
          && promptDispatchAttempted
          && !turnCompletedSafely
          && quarantineFailure === undefined
        ) {
          try {
            await localClient.abortSession(sessionId);
          } catch (error) {
            cleanupFailure ??= new RuntimeOpenCodeError(
              "SESSION_ABORT_FAILED",
              redact(error, secrets()),
              {
                retryability: "not-retryable",
                sideEffects: "unknown",
                cause: safeCause(error, secrets()),
              },
            );
            state = "draining";
            beginServerClose();
          }
        }
        releaseSession?.();
        turnController.abort();
        active.delete(operation);
        settleActive();
        if (cleanupFailure !== undefined && quarantineFailure === undefined) {
          throw cleanupFailure;
        }
      }
    },
  };
}

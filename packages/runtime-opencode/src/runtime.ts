// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
import type { SandboxExecutor } from "@mono-agent/module-sdk/internal";

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
import { openCodeSandboxSpawn } from "./sandbox.js";
import {
  OpenCodeServerClient,
  OpenCodeServerHttpError,
  type OpenCodeEventSubscription,
  type OpenCodeServerEvent,
} from "./server.js";
import {
  extractVersion,
  parseStableVersion,
  versionAtLeast,
} from "./version.js";

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

interface TurnResources {
  sessionId?: string;
  releaseSession?: () => void;
  subscription?: OpenCodeEventSubscription;
  promptDispatchAttempted: boolean;
  completedSafely: boolean;
}

interface TurnStreamState {
  assistantMessageId?: string;
  completedAssistantMessageId?: string;
  providerFailure?: string;
  usage?: RuntimeUsage;
  readonly parts: Map<string, PartState>;
  readonly partOrder: string[];
  readonly completion: Promise<void>;
  isSettled(): boolean;
  complete(): void;
  fail(error: unknown): void;
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
  readonly dataDirectory?: string;
  readonly spawnProcess?: SpawnProcess;
  readonly sandboxExecutor?: SandboxExecutor;
  readonly fetch?: typeof globalThis.fetch;
  readonly terminationGraceMs?: number;
  readonly removeIsolation?: (root: string) => Promise<void>;
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

function assertOwnedDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
  path: string,
  exactPrivate: boolean,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${path} must be a canonical directory`);
  }
  if (typeof process.getuid !== "function" || info.uid !== process.getuid()) {
    throw new Error(`${path} must be owned by the current user`);
  }
  const mode = Number(info.mode) & 0o777;
  if (exactPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) {
    throw new Error(exactPrivate
      ? `${path} must have mode 0700`
      : `${path} must not be group/world writable`);
  }
}

async function prepareSandboxDataDirectory(
  authoredPath: string | undefined,
): Promise<string> {
  if (authoredPath === undefined) {
    throw new Error(
      "runtime-opencode requires a data directory when a Core sandbox is selected",
    );
  }
  if (!isAbsolute(authoredPath) || resolve(authoredPath) !== authoredPath) {
    throw new Error(
      "runtime-opencode sandbox data directory must be an absolute canonical path",
    );
  }
  const root = authoredPath;
  const missing: string[] = [];
  let cursor = root;
  let info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  while (info === undefined) {
    missing.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(
        "runtime-opencode sandbox data directory has no existing parent",
      );
    }
    cursor = parent;
    info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }
  assertOwnedDirectory(info, cursor, missing.length === 0);
  if (await realpath(cursor) !== cursor) {
    throw new Error(
      "runtime-opencode sandbox data directory ancestors must be canonical",
    );
  }
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 });
    const created = await lstat(path);
    assertOwnedDirectory(created, path, true);
    if (await realpath(path) !== path) {
      throw new Error(
        "runtime-opencode sandbox data directory creation crossed a symbolic link",
      );
    }
  }
  assertOwnedDirectory(await lstat(root), root, true);
  return root;
}

async function createIsolation(dataDirectory?: string): Promise<Isolation> {
  const base = dataDirectory === undefined
    ? tmpdir()
    : await prepareSandboxDataDirectory(dataDirectory);
  const prefix = dataDirectory === undefined
    ? "mono-agent-opencode-"
    : "isolation-";
  const root = await mkdtemp(join(base, prefix));
  try {
    await chmod(root, 0o700);
    if (
      dataDirectory !== undefined
      && dirname(await realpath(root)) !== base
    ) {
      throw new Error(
        "runtime-opencode isolation escaped the sandbox data directory",
      );
    }
    const directories: OpenCodeIsolatedDirectories = {
      home: join(root, "home"),
      config: join(root, "config"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      state: join(root, "state"),
    };
    await Promise.all(
      Object.values(directories).map(async (directory) => {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }),
    );
    return { root, directories };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function nativeToolViolation(): RuntimeOpenCodeError {
  return new RuntimeOpenCodeError(
    "NATIVE_TOOL_PROTOCOL_VIOLATION",
    "OpenCode emitted native tool activity despite the enforced deny-all tool policy",
    { retryability: "not-retryable", sideEffects: "unknown" },
  );
}

function validateTurnRequest(
  request: RuntimeTurnRequest,
  instanceId: string,
): void {
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
    && sessionRoute?.runtimeInstanceId !== instanceId
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
}

function cancelledTurnResult(
  request: RuntimeTurnRequest,
  sessionId: string | undefined,
  instanceId: string,
): RuntimeTurnResult {
  return {
    status: "cancelled",
    ...(sessionId === undefined ? {} : {
      session: linkedSession(
        instanceId,
        sessionId,
        request.conversationId,
        request.model,
      ),
    }),
  };
}

function createTurnStreamState(): TurnStreamState {
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  return {
    parts: new Map<string, PartState>(),
    partOrder: [],
    completion,
    isSettled: () => settled,
    complete() {
      if (settled) return;
      settled = true;
      resolveCompletion();
    },
    fail(error) {
      if (settled) return;
      settled = true;
      rejectCompletion(error);
    },
  };
}

async function emitRemaining(
  stream: TurnStreamState,
  context: RuntimeTurnContext,
): Promise<void> {
  for (const id of stream.partOrder) {
    const part = stream.parts.get(id);
    if (
      part === undefined
      || part.messageId !== stream.assistantMessageId
      || !part.text.startsWith(part.emitted)
    ) continue;
    const delta = part.text.slice(part.emitted.length);
    if (delta === "") continue;
    part.emitted += delta;
    await context.emit({
      type: part.type === "text" ? "text-delta" : "thinking-delta",
      delta,
    });
  }
}

async function handleTurnEvent(
  event: OpenCodeServerEvent,
  options: {
    readonly sessionId: string;
    readonly stream: TurnStreamState;
    readonly context: RuntimeTurnContext;
    readonly quarantine: (failure: RuntimeOpenCodeError) => RuntimeOpenCodeError;
    readonly secrets: () => readonly string[];
  },
): Promise<void> {
  const { stream } = options;
  const observedSessionId = eventSessionId(event);
  const part = record(event.properties.part);
  const nativeActivity = (
    event.type === "message.part.updated" && part.type === "tool"
  ) || event.type === "permission.asked";
  if (
    nativeActivity
    && (observedSessionId === undefined || observedSessionId === options.sessionId)
  ) {
    const failure = options.quarantine(nativeToolViolation());
    stream.fail(failure);
    throw failure;
  }
  if (
    observedSessionId !== undefined
    && observedSessionId !== options.sessionId
  ) return;

  if (event.type === "message.updated") {
    const info = record(event.properties.info);
    if (info.role !== "assistant") return;
    if (typeof info.id === "string") stream.assistantMessageId = info.id;
    if (record(info.time).completed === undefined) return;
    if (stream.assistantMessageId !== undefined) {
      stream.completedAssistantMessageId = stream.assistantMessageId;
    }
    if (info.error !== undefined) {
      stream.providerFailure = redact(
        providerErrorMessage(info.error),
        options.secrets(),
      );
    }
    const finalUsage = usageOf(info.tokens);
    if (finalUsage !== undefined) stream.usage = finalUsage;
    await emitRemaining(stream, options.context);
    if (finalUsage !== undefined) {
      await options.context.emit({ type: "usage", usage: finalUsage });
    }
    return;
  }
  if (event.type === "message.part.updated") {
    if (part.type === "step-finish") {
      const stepUsage = usageOf(part.tokens);
      if (stepUsage !== undefined) stream.usage = stepUsage;
      return;
    }
    if (
      (part.type !== "text" && part.type !== "reasoning")
      || typeof part.id !== "string"
      || typeof part.messageID !== "string"
    ) return;
    const existing = stream.parts.get(part.id);
    if (existing === undefined) {
      stream.parts.set(part.id, {
        type: part.type,
        text: typeof part.text === "string" ? part.text : "",
        emitted: "",
        messageId: part.messageID,
      });
      stream.partOrder.push(part.id);
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
    const current = stream.parts.get(event.properties.partID);
    if (
      current === undefined
      || current.messageId !== stream.assistantMessageId
    ) return;
    current.text += event.properties.delta;
    current.emitted += event.properties.delta;
    await options.context.emit({
      type: current.type === "text" ? "text-delta" : "thinking-delta",
      delta: event.properties.delta,
    });
    return;
  }
  if (event.type === "session.error") {
    stream.providerFailure = redact(
      providerErrorMessage(event.properties.error),
      options.secrets(),
    );
    await options.context.emit({
      type: "diagnostic",
      diagnostic: diagnostic(
        "runtime-opencode.provider",
        "error",
        stream.providerFailure,
      ),
    });
    return;
  }
  if (event.type === "session.status") {
    const status = record(event.properties.status);
    if (
      status.type === "idle"
      && (
        stream.providerFailure !== undefined
        || (
          stream.completedAssistantMessageId !== undefined
          && stream.completedAssistantMessageId === stream.assistantMessageId
        )
      )
    ) stream.complete();
  }
}

async function prepareTurnSession(options: {
  readonly client: OpenCodeServerClient;
  readonly agentName: string;
  readonly request: RuntimeTurnRequest;
  readonly signal: AbortSignal;
  readonly operation: ActiveOperation;
  readonly resources: TurnResources;
  readonly acquireSession: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<() => void>;
  readonly context: RuntimeTurnContext;
  readonly instanceId: string;
}): Promise<string> {
  if (options.resources.sessionId === undefined) {
    const created = await options.client.createSession(
      options.agentName,
      options.request.model,
      options.signal,
    );
    options.resources.sessionId = created.id;
    options.operation.sessionId = created.id;
    options.resources.releaseSession = await options.acquireSession(
      created.id,
      options.signal,
    );
    await options.context.emit({
      type: "session",
      session: linkedSession(
        options.instanceId,
        created.id,
        options.request.conversationId,
        options.request.model,
      ),
    });
    return created.id;
  }
  const sessionId = options.resources.sessionId;
  options.operation.sessionId = sessionId;
  options.resources.releaseSession = await options.acquireSession(
    sessionId,
    options.signal,
  );
  await options.client.secureSession(sessionId, options.signal);
  return sessionId;
}

function classifyTurnFailure(
  error: unknown,
  options: {
    readonly request: RuntimeTurnRequest;
    readonly sessionId: string | undefined;
    readonly instanceId: string;
    readonly turnSignal: AbortSignal;
    readonly timeoutSignal: AbortSignal;
    readonly combinedSignal: AbortSignal;
    readonly quarantineFailure: RuntimeOpenCodeError | undefined;
    readonly secrets: readonly string[];
  },
): RuntimeTurnResult {
  if (options.turnSignal.reason instanceof RuntimeOpenCodeError) {
    throw options.turnSignal.reason;
  }
  if (error instanceof RuntimeOpenCodeError) throw error;
  if (options.request.signal.aborted) {
    return cancelledTurnResult(
      options.request,
      options.sessionId,
      options.instanceId,
    );
  }
  if (options.timeoutSignal.aborted) {
    throw new RuntimeOpenCodeError(
      "TURN_TIMEOUT",
      redact(abortReason(options.timeoutSignal), options.secrets),
      {
        retryability: "unknown",
        sideEffects: "unknown",
        cause: safeCause(error, options.secrets),
      },
    );
  }
  if (
    error instanceof OpenCodeServerHttpError
    && error.status === 404
    && options.request.session !== undefined
  ) {
    throw new RuntimeOpenCodeError(
      RUNTIME_SESSION_UNAVAILABLE_CODE,
      "OpenCode session no longer exists",
      {
        retryability: "not-retryable",
        sideEffects: "none",
        cause: safeCause(error, options.secrets),
      },
    );
  }
  if (options.quarantineFailure !== undefined) {
    throw options.quarantineFailure;
  }
  if (options.combinedSignal.aborted) {
    return cancelledTurnResult(
      options.request,
      options.sessionId,
      options.instanceId,
    );
  }
  throw new RuntimeOpenCodeError(
    "PROVIDER_FAILED",
    redact(error, options.secrets),
    {
      retryability: "unknown",
      sideEffects: "unknown",
      cause: safeCause(error, options.secrets),
    },
  );
}

async function cleanupTurn(options: {
  readonly resources: TurnResources;
  readonly client: OpenCodeServerClient;
  readonly turnController: AbortController;
  readonly operation: ActiveOperation;
  readonly active: Set<ActiveOperation>;
  readonly settleActive: () => void;
  readonly timeoutMs: number;
  readonly quarantineFailure: () => RuntimeOpenCodeError | undefined;
  readonly secrets: () => readonly string[];
  readonly degrade: () => void;
}): Promise<RuntimeOpenCodeError | undefined> {
  let cleanupFailure: RuntimeOpenCodeError | undefined;
  try {
    if (options.resources.subscription !== undefined) {
      try {
        options.resources.subscription.close(
          new DOMException("Turn settled", "AbortError"),
        );
        await waitBounded(
          options.resources.subscription.done.catch(() => undefined),
          Math.min(options.timeoutMs, 10_000),
          "OpenCode event subscription did not close",
        );
      } catch (error) {
        cleanupFailure = new RuntimeOpenCodeError(
          "SSE_SHUTDOWN_FAILED",
          redact(error, options.secrets()),
          {
            retryability: "not-retryable",
            sideEffects: "unknown",
            cause: safeCause(error, options.secrets()),
          },
        );
        options.degrade();
      }
    }
    if (
      options.resources.sessionId !== undefined
      && options.resources.promptDispatchAttempted
      && !options.resources.completedSafely
      && options.quarantineFailure() === undefined
    ) {
      try {
        await options.client.abortSession(options.resources.sessionId);
      } catch (error) {
        cleanupFailure ??= new RuntimeOpenCodeError(
          "SESSION_ABORT_FAILED",
          redact(error, options.secrets()),
          {
            retryability: "not-retryable",
            sideEffects: "unknown",
            cause: safeCause(error, options.secrets()),
          },
        );
        options.degrade();
      }
    }
  } finally {
    options.resources.releaseSession?.();
    options.turnController.abort();
    options.active.delete(options.operation);
    options.settleActive();
  }
  return options.quarantineFailure() === undefined
    ? cleanupFailure
    : undefined;
}

async function drainActiveOperations(
  operations: readonly ActiveOperation[],
  context: ModuleDrainContext,
  secrets: readonly string[],
): Promise<void> {
  const deadlineController = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  if (context.deadline !== undefined) {
    const deadline = Date.parse(context.deadline);
    if (!Number.isFinite(deadline)) {
      throw new RuntimeOpenCodeError(
        "DRAIN_DEADLINE_INVALID",
        "runtime-opencode received an invalid drain deadline",
        { retryability: "not-retryable", sideEffects: "none" },
      );
    }
    const timeout = (): void => {
      const error = new Error("OpenCode drain deadline reached");
      error.name = "TimeoutError";
      deadlineController.abort(error);
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) timeout();
    else {
      timer = setTimeout(timeout, remaining);
      timer.unref?.();
    }
  }
  const signal = context.deadline === undefined
    ? context.signal
    : AbortSignal.any([context.signal, deadlineController.signal]);
  try {
    await waitAbortable(
      Promise.all(operations.map((operation) => operation.settled)).then(
        () => undefined,
      ),
      signal,
    );
  } catch (error) {
    throw new RuntimeOpenCodeError(
      deadlineController.signal.aborted ? "DRAIN_TIMEOUT" : "DRAIN_ABORTED",
      redact(error, secrets),
      {
        retryability: "not-retryable",
        sideEffects: "unknown",
        cause: safeCause(error, secrets),
      },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRuntimeOpenCode(options: CreateRuntimeOpenCodeOptions): Runtime {
  if (
    options.sandboxExecutor !== undefined
    && !isAbsolute(options.config.binary)
  ) {
    throw new TypeError(
      "runtime-opencode config.binary must be an absolute path when a Core sandbox is selected",
    );
  }
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
  const spawnProcess = options.sandboxExecutor === undefined
    ? options.spawnProcess
    : openCodeSandboxSpawn(options.sandboxExecutor);
  const removeIsolation = options.removeIsolation
    ?? ((root: string) => rm(root, { recursive: true, force: true }));
  const isolationCleanupPromises = new WeakMap<Isolation, Promise<void>>();

  const cleanupIsolation = (owned: Isolation): Promise<void> => {
    let cleanup = isolationCleanupPromises.get(owned);
    if (cleanup !== undefined) return cleanup;
    cleanup = (async () => {
      await removeIsolation(owned.root);
      if (isolation === owned) isolation = undefined;
    })();
    isolationCleanupPromises.set(owned, cleanup);
    void cleanup.catch(() => {
      if (isolationCleanupPromises.get(owned) === cleanup) {
        isolationCleanupPromises.delete(owned);
      }
    });
    return cleanup;
  };

  const cleanupIsolationAfterClose = (
    closed: Promise<unknown> | undefined,
    owned: Isolation | undefined,
  ): void => {
    if (closed === undefined || owned === undefined) return;
    void closed.then(async () => cleanupIsolation(owned)).catch(() => undefined);
  };

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
    const ownedIsolation = isolation;
    if (owned === undefined) return;
    void owned.close().catch((error: unknown) => {
      terminationFailure ??= error instanceof OpenCodeProcessTerminationError
        ? error
        : new OpenCodeProcessTerminationError(redact(error, secrets()));
      cleanupIsolationAfterClose(
        owned.closed ?? terminationFailure.closed,
        ownedIsolation,
      );
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
    ...(spawnProcess === undefined ? {} : {
      spawnProcess,
    }),
  });

  return {
    capabilities: Object.freeze({
      ...runtimeOpenCodeCapabilities,
      sandbox: options.sandboxExecutor !== undefined,
    }),

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
        const sandboxDataDirectory = options.sandboxExecutor === undefined
          ? undefined
          : await prepareSandboxDataDirectory(options.dataDirectory);
        localIsolation = await createIsolation(sandboxDataDirectory);
        isolation = localIsolation;
        const versionEnvironment = openCodeProcessEnvironment(
          options.config.environment,
          options.sandboxExecutor === undefined ? process.env : {},
          { directories: localIsolation.directories },
        );
        const output = await capturePlainText({
          ...processOptions(signal, versionEnvironment),
          args: ["--version"],
        });
        const actual = extractVersion(output);
        const minimum = parseStableVersion(options.config.minimumVersion);
        if (
          actual === undefined
          || minimum === undefined
          || !versionAtLeast(actual, minimum)
        ) {
          throw new RuntimeOpenCodeError(
            "VERSION_UNSUPPORTED",
            `runtime-opencode requires stable OpenCode >=${options.config.minimumVersion}; `
            + `found ${output || "unknown"}`,
            { retryability: "not-retryable" },
          );
        }
        if (signal.aborted) throw abortReason(signal);

        serverPassword = randomBytes(32).toString("base64url");
        agentName = `${OPEN_CODE_TOOL_FREE_AGENT}-${randomBytes(8).toString("hex")}`;
        const username = "opencode";
        const environment = openCodeProcessEnvironment(
          options.config.environment,
          options.sandboxExecutor === undefined ? process.env : {},
          {
            directories: localIsolation.directories,
            agentName,
            serverUsername: username,
            serverPassword,
          },
        );
        localServer = await startOpenCodeServerProcess({
          ...processOptions(signal, environment),
          args: [
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            "0",
            ...(options.config.pure ? ["--pure"] : []),
          ],
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
        const healthTuple = extractVersion(healthVersion);
        if (
          healthTuple === undefined
          || !versionAtLeast(healthTuple, minimum)
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
        void localServer.terminationFailed.then((error) => {
          if (localServer?.isClosing() || state === "stopped") return;
          terminationFailure ??= error;
          cleanupIsolationAfterClose(localServer?.closed, localIsolation);
          quarantine(new RuntimeOpenCodeError(
            "PROCESS_TERMINATION_FAILED",
            redact(error, secrets()),
            {
              retryability: "not-retryable",
              sideEffects: "unknown",
              cause: safeCause(error, secrets()),
            },
          ));
        });
      } catch (error) {
        let isolationCleanupFailed = false;
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
          try {
            await cleanupIsolation(localIsolation);
          } catch {
            isolationCleanupFailed = true;
          }
        } else if (terminationFailure !== undefined) {
          cleanupIsolationAfterClose(
            localServer?.closed ?? terminationFailure.closed,
            localIsolation,
          );
        }
        server = undefined;
        client = undefined;
        if (terminationFailure !== undefined) {
          state = "draining";
          throw new RuntimeOpenCodeError(
            "PROCESS_TERMINATION_FAILED",
            redact(terminationFailure, secrets()),
            {
              retryability: "not-retryable",
              sideEffects: "none",
              cause: safeCause(terminationFailure, secrets()),
            },
          );
        }
        if (state === "starting") {
          state = isolationCleanupFailed ? "draining" : "created";
        }
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

    async drain(context: ModuleDrainContext) {
      if (state === "stopped") return;
      state = "draining";
      await drainActiveOperations([...active], context, secrets());
    },

    async stop(_context: ModuleStopContext) {
      if (state === "stopped" && isolation === undefined) return;
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

      const ownedServer = server;
      if (ownedServer !== undefined) {
        try {
          await ownedServer.close();
        } catch (error) {
          terminationFailure ??= error instanceof OpenCodeProcessTerminationError
            ? error
            : new OpenCodeProcessTerminationError(redact(error, secrets()));
        }
      }
      let isolationFailure: RuntimeOpenCodeError | undefined;
      if (terminationFailure === undefined && isolation !== undefined) {
        try {
          await cleanupIsolation(isolation);
        } catch (error) {
          isolationFailure = new RuntimeOpenCodeError(
            "ISOLATION_CLEANUP_FAILED",
            redact(error, secrets()),
            {
              retryability: "not-retryable",
              sideEffects: "unknown",
              cause: safeCause(error, secrets()),
            },
          );
        }
      } else if (terminationFailure !== undefined) {
        cleanupIsolationAfterClose(
          ownedServer?.closed ?? terminationFailure.closed,
          isolation,
        );
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
      if (isolationFailure !== undefined) throw isolationFailure;
    },

    health(_context: ModuleHealthContext): ModuleHealth {
      const unhealthy = quarantineFailure !== undefined
        || terminationFailure !== undefined;
      return {
        status: unhealthy
          ? "unhealthy"
          : state === "running"
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
      const lifecycleFailure = quarantineFailure !== undefined
        || terminationFailure !== undefined;
      return [
        diagnostic(
          "runtime-opencode.lifecycle",
          lifecycleFailure ? "error" : "info",
          `Runtime state: ${state}`
          + (version === undefined ? "" : ` (${version})`)
          + (quarantineFailure === undefined
            ? terminationFailure === undefined
              ? ""
              : "; process termination failed"
            : `; quarantined by ${quarantineFailure.code}`),
        ),
      ];
    },

    preflightModel(request) {
      request.signal.throwIfAborted();
      const validation = validateRuntimeOpenCodeModel({
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

    async runTurn(
      request: RuntimeTurnRequest,
      context: RuntimeTurnContext,
    ): Promise<RuntimeTurnResult> {
      if (quarantineFailure !== undefined) throw quarantineFailure;
      if (state !== "running" || client === undefined || agentName === undefined) {
        throw new RuntimeOpenCodeError(
          "RUNTIME_NOT_RUNNING",
          `runtime-opencode is ${state}`,
          { retryability: "not-retryable" },
        );
      }
      validateTurnRequest(request, options.instanceId);
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
      const resources: TurnResources = {
        ...(request.session === undefined ? {} : {
          sessionId: request.session.id,
        }),
        promptDispatchAttempted: false,
        completedSafely: false,
      };
      const stream = createTurnStreamState();
      let primaryFailure: unknown;

      try {
        const sessionId = await prepareTurnSession({
          client: localClient,
          agentName,
          request,
          signal,
          operation,
          resources,
          acquireSession,
          context,
          instanceId: options.instanceId,
        });
        resources.subscription = localClient.subscribe(
          signal,
          (event) => handleTurnEvent(event, {
            sessionId,
            stream,
            context,
            quarantine,
            secrets,
          }),
        );
        const subscription = resources.subscription;
        void subscription.done.catch((error: unknown) => {
          if (stream.isSettled() || signal.aborted) return;
          const failure = error instanceof RuntimeOpenCodeError
            ? error
            : new RuntimeOpenCodeError(
                "SSE_FAILED",
                redact(error, secrets()),
                {
                  retryability: "unknown",
                  sideEffects: resources.promptDispatchAttempted
                    ? "unknown"
                    : "none",
                  cause: safeCause(error, secrets()),
                },
              );
          turnController.abort(failure);
          stream.fail(failure);
        });
        await subscription.connected;
        if (signal.aborted) throw abortReason(signal);
        resources.promptDispatchAttempted = true;
        await localClient.promptAsync(sessionId, {
          model: request.model,
          text: prompt(request.messages, request.session !== undefined),
          agent: agentName,
          ...(request.options?.effort === undefined ? {} : {
            variant: request.options.effort,
          }),
        }, signal);
        await waitAbortable(stream.completion, signal);
        if (stream.providerFailure !== undefined) {
          throw new RuntimeOpenCodeError(
            "PROVIDER_FAILED",
            stream.providerFailure,
            { retryability: "unknown", sideEffects: "unknown" },
          );
        }
        await emitRemaining(stream, context);
        const output = stream.partOrder
          .map((id) => stream.parts.get(id))
          .filter((part): part is PartState => (
            part !== undefined
            && part.type === "text"
            && part.messageId === stream.assistantMessageId
          ))
          .map((part) => part.text)
          .join("");
        const linked = linkedSession(
          options.instanceId,
          sessionId,
          request.conversationId,
          request.model,
        );
        resources.completedSafely = true;
        return {
          status: "completed",
          message: {
            role: "assistant",
            content: [{ type: "text", text: output }],
          },
          ...(stream.usage === undefined ? {} : { usage: stream.usage }),
          session: linked,
          metadata: {
            provider: "opencode",
            model: request.model,
            version: version ?? OPEN_CODE_SECURE_SERVER_VERSION,
          } as JsonObject,
        };
      } catch (error) {
        try {
          return classifyTurnFailure(error, {
            request,
            sessionId: resources.sessionId,
            instanceId: options.instanceId,
            turnSignal: turnController.signal,
            timeoutSignal: timeoutController.signal,
            combinedSignal: signal,
            quarantineFailure,
            secrets: secrets(),
          });
        } catch (classifiedFailure) {
          primaryFailure = classifiedFailure;
          throw classifiedFailure;
        }
      } finally {
        clearTimeout(timeout);
        const cleanupFailure = await cleanupTurn({
          resources,
          client: localClient,
          turnController,
          operation,
          active,
          settleActive,
          timeoutMs: options.config.timeoutMs,
          quarantineFailure: () => quarantineFailure,
          secrets,
          degrade() {
            state = "draining";
            beginServerClose();
          },
        });
        if (cleanupFailure !== undefined && primaryFailure === undefined) {
          throw cleanupFailure;
        }
      }
    },
  };
}

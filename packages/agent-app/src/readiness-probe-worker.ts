import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { createMonoRuntime, createPiOAuthApiKeyResolver, PI_TRANSPORTS } from "@mono-agent/runtime-adapter";
import type {
  CreateMonoRuntimeOptions,
  MonoRuntimeLike,
  PiTransport,
  RuntimeEventLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import { redactSecrets } from "./redact-secrets.js";

const TOOL_EVENT_TYPES = new Set([
  "bash",
  "collab_agent_tool_call",
  "command_execution",
  "dynamic_tool_call",
  "file_change",
  "image_generation",
  "image_view",
  "mcp_tool_call",
  "sleep",
  "subagent_activity",
  "tool_call",
  "tool_result",
  "tool_use",
  "web_search",
]);

/** @internal Clone-safe input accepted from the readiness parent. */
export interface ReadinessWorkerData {
  readonly cwd: string;
  readonly runtime: {
    readonly model: RuntimeModelReference;
    readonly executionMode?: string;
    readonly effort?: string;
    readonly workspace: string;
    readonly artifactDir: string;
    readonly piAuthPath?: string;
    readonly piTransport?: PiTransport;
  };
}

/** @internal Bounded, clone-safe messages emitted across the worker boundary. */
export type ReadinessWorkerOutput =
  | {
      readonly type: "result";
      readonly hasText: boolean;
      readonly cancelled: boolean;
      readonly failureKind?: string;
      readonly errorMessage?: string;
    }
  | { readonly type: "tool"; readonly action: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "disposed" };

type PiCredentialResolver = ReturnType<typeof createPiOAuthApiKeyResolver>;

/** @internal Narrow worker-thread port surface used by the production entrypoint and unit tests. */
export interface ReadinessWorkerPort {
  on(event: "message", listener: (message: unknown) => void): unknown;
  postMessage(message: ReadinessWorkerOutput): void;
  close(): void;
}

/** @internal Runtime constructors injected only by tests; production uses the real adapter. */
export interface ReadinessWorkerDependencies {
  readonly createRuntime: (options: CreateMonoRuntimeOptions) => MonoRuntimeLike;
  readonly createPiApiKeyResolver: typeof createPiOAuthApiKeyResolver;
}

/**
 * Add readiness redaction tracking without erasing the credential-store
 * methods Pi uses to distinguish OAuth credentials from API keys.
 *
 * @internal Exported as a narrow regression-test seam. Credentials remain in
 * the worker and are never included in ReadinessWorkerOutput.
 */
export function trackPiCredentialResolverSecrets(
  resolver: PiCredentialResolver,
  secrets: Set<string>,
): PiCredentialResolver {
  const tracked = (async (provider: string) => {
    const secret = await resolver(provider);
    if (typeof secret === "string" && secret.length > 0) secrets.add(secret);
    return secret;
  }) as PiCredentialResolver;
  if (typeof resolver.readCredential === "function") {
    tracked.readCredential = resolver.readCredential.bind(resolver);
  }
  if (typeof resolver.modifyCredential === "function") {
    tracked.modifyCredential = resolver.modifyCredential.bind(resolver);
  }
  if (typeof resolver.deleteCredential === "function") {
    tracked.deleteCredential = resolver.deleteCredential.bind(resolver);
  }
  return tracked;
}

/** @internal Exported so clone-boundary validation cannot regress unnoticed. */
export function readWorkerData(value: unknown): ReadinessWorkerData | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.cwd !== "string" || !isRecord(record.runtime)) {
    return undefined;
  }
  const runtime = record.runtime;
  if (
    !isRuntimeModelReference(runtime.model)
    || (runtime.executionMode !== undefined && typeof runtime.executionMode !== "string")
    || (runtime.effort !== undefined && typeof runtime.effort !== "string")
    || typeof runtime.workspace !== "string"
    || typeof runtime.artifactDir !== "string"
    || (runtime.piAuthPath !== undefined && typeof runtime.piAuthPath !== "string")
    || (runtime.piTransport !== undefined && !PI_TRANSPORTS.includes(runtime.piTransport as PiTransport))
  ) {
    return undefined;
  }
  return {
    cwd: record.cwd,
    runtime: {
      model: runtime.model,
      ...(runtime.executionMode === undefined ? {} : { executionMode: runtime.executionMode }),
      ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
      workspace: runtime.workspace,
      artifactDir: runtime.artifactDir,
      ...(runtime.piAuthPath === undefined ? {} : { piAuthPath: runtime.piAuthPath }),
      ...(runtime.piTransport === undefined ? {} : { piTransport: runtime.piTransport as PiTransport }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeModelReference(value: unknown): value is RuntimeModelReference {
  if (!isRecord(value) || typeof value.sdk !== "string" || typeof value.model !== "string") {
    return false;
  }
  return (value.provider === undefined || typeof value.provider === "string")
    && (value.reference === undefined || typeof value.reference === "string");
}

function exactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ));
}

/** @internal Worker-side credential redaction applied before IPC. */
export function safeWorkerMessage(
  value: unknown,
  fallback: string,
  additionalSecrets: ReadonlySet<string> = new Set(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return redactSecrets(value, {
    fallback,
    secrets: additionalSecrets,
    environment,
  });
}

function normalizedEventType(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[./-]+/gu, "_").toLowerCase()
    : "";
}

/** @internal Fail-closed no-tool event detector used by the live readiness worker. */
export function toolActionInEvent(event: RuntimeEventLike): string | undefined {
  const eventType = normalizedEventType(event.type);
  if (TOOL_EVENT_TYPES.has(eventType)) {
    return eventType;
  }
  const item = event.item;
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const itemType = normalizedEventType((item as Record<string, unknown>).type);
    if (TOOL_EVENT_TYPES.has(itemType)) {
      return itemType;
    }
  }
  const message = event.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      continue;
    }
    const blockType = normalizedEventType((block as Record<string, unknown>).type);
    if (blockType === "tool_use" || blockType === "tool_call" || blockType === "tool_result") {
      return blockType;
    }
  }
  return undefined;
}

function post(port: ReadinessWorkerPort | null, message: ReadinessWorkerOutput): void {
  try {
    port?.postMessage(message);
  } catch {
    // The parent has already completed bounded shutdown.
  }
}

/**
 * Execute the worker-owned readiness probe against one validated runtime route.
 *
 * @internal Production passes the real worker-thread values and runtime
 * constructors below. The dependency seam exists only so tests execute this
 * exact orchestration without contacting a provider.
 */
export async function runReadinessProbeWorker(input: {
  readonly port: ReadinessWorkerPort | null;
  readonly workerData: unknown;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dependencies?: ReadinessWorkerDependencies;
}): Promise<void> {
  const { port } = input;
  const data = readWorkerData(input.workerData);
  if (port === null || data === undefined) {
    post(port, { type: "error", message: "The isolated readiness worker received invalid startup data." });
    return;
  }

  const dependencies = input.dependencies ?? {
    createRuntime: createMonoRuntime,
    createPiApiKeyResolver: createPiOAuthApiKeyResolver,
  };

  const controller = new AbortController();
  const runtimeSecrets = new Set<string>();
  let runtime: MonoRuntimeLike | undefined;
  let disposePromise: Promise<void> | undefined;
  const disposeRuntime = (): Promise<void> => {
    disposePromise ??= Promise.resolve()
      .then(() => runtime?.disposeAllSessions?.())
      .then(() => undefined, () => undefined);
    return disposePromise;
  };
  const abortAndDispose = (): void => {
    controller.abort();
    // A runtime may ignore abort while still honoring explicit session cleanup.
    // Do not wait for run() to settle before giving disposal its bounded chance.
    void disposeRuntime();
  };
  port.on("message", (message: unknown) => {
    if (
      typeof message === "object"
      && message !== null
      && !Array.isArray(message)
      && (message as Record<string, unknown>).type === "abort"
    ) {
      abortAndDispose();
    }
  });

  try {
    const env = exactEnvironment(input.environment);
    if (controller.signal.aborted) {
      post(port, { type: "result", hasText: false, cancelled: true });
      return;
    }
    // No fallback chain is supplied: this worker exercises only the validated
    // primary model. All config loading and validation stayed in the parent.
    const piApiKeyResolver = data.runtime.piAuthPath === undefined
      ? undefined
      : dependencies.createPiApiKeyResolver({ path: data.runtime.piAuthPath });
    const trackedPiApiKeyResolver = piApiKeyResolver === undefined
      ? undefined
      : trackPiCredentialResolverSecrets(piApiKeyResolver, runtimeSecrets);
    runtime = dependencies.createRuntime({
      workspace: data.runtime.workspace,
      qaOutputDir: data.runtime.artifactDir,
      ...(trackedPiApiKeyResolver === undefined
        ? {}
        : { resolvePiApiKey: trackedPiApiKeyResolver }),
    });
    let firstToolAction: string | undefined;
    const runOptions: RuntimeRunOptions = {
      model: data.runtime.model,
      ...(data.runtime.executionMode === undefined ? {} : { executionMode: data.runtime.executionMode }),
      ...(data.runtime.effort === undefined ? {} : { effort: data.runtime.effort }),
      messages: [{ role: "user", content: "Reply with a short readiness acknowledgement." }],
      abortSignal: controller.signal,
      cwd: data.cwd,
      maxTurns: 1,
      ...(data.runtime.piTransport === undefined ? {} : { piTransport: data.runtime.piTransport }),
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      codexNoToolsProbe: true,
      onEvent: (event) => {
        const action = toolActionInEvent(event);
        if (action !== undefined && firstToolAction === undefined) {
          firstToolAction = action;
          post(port, { type: "tool", action });
          abortAndDispose();
        }
      },
      sessionKeepAlive: false,
      providerEnv: env,
    };
    const result: RuntimeResult = await runtime.run("Reply concisely. Do not use tools.", runOptions);
    for (const event of result.events ?? []) {
      firstToolAction ??= toolActionInEvent(event);
    }
    if (firstToolAction !== undefined) {
      post(port, { type: "tool", action: firstToolAction });
      return;
    }
    const failureKind = result.failureKind === undefined || result.failureKind === null
      ? undefined
      : safeWorkerMessage(result.failureKind, "provider_failure", runtimeSecrets, input.environment);
    const errorMessage = result.error === undefined || result.error === null
      ? undefined
      : safeWorkerMessage(result.error, "The selected provider reported an error.", runtimeSecrets, input.environment);
    post(port, {
      type: "result",
      hasText: (result.text ?? "").trim().length > 0,
      cancelled: result.cancelled === true,
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  } catch (error) {
    post(port, {
      type: "error",
      message: safeWorkerMessage(
        error,
        "The isolated readiness worker failed unexpectedly.",
        runtimeSecrets,
        input.environment,
      ),
    });
  } finally {
    await disposeRuntime();
    post(port, { type: "disposed" });
    port.close();
  }
}

if (!isMainThread) {
  await runReadinessProbeWorker({
    port: parentPort,
    workerData,
    environment: process.env,
  });
}

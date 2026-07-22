import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { loadAppCoreConfig } from "./app-config.js";
import { validateMonoAgentFolder } from "./doctor.js";
import {
  isSensitiveEnvironmentName,
  REDACTED_DIAGNOSTIC_MAX_CHARS,
  redactSecrets,
} from "./redact-secrets.js";
import type { WizardPlan } from "./wizard/answers.js";
import type {
  PiTransport,
  RuntimeEventLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

const CLOUD_READINESS_TIMEOUT_MS = 90_000;
const LOCAL_READINESS_TIMEOUT_MS = 240_000;
const WORKER_SHUTDOWN_GRACE_MS = 1_000;
const LOCAL_PI_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp"]);
const SENSITIVE_FINGERPRINT_KEY = /(api.?key|authorization|cookie|credential|password|secret|token)/iu;

type ReadinessRuntimeRunOptions = RuntimeRunOptions & {
  /** Exact provider environment supplied to the injected test seam. */
  readonly providerEnv: Readonly<Record<string, string>>;
};

export interface ReadinessProbeOptions {
  readonly plan: WizardPlan;
  /** Caller cancellation for an interactive readiness check. */
  readonly abortSignal?: AbortSignal;
  /** The selected required module secrets, held only for this process. */
  readonly secretValues?: Readonly<Record<string, string>>;
  /**
   * The already-resolved Pi auth path selected by CLI/config precedence. This
   * is the sole MONO_AGENT_* value intentionally restored after isolation.
   */
  readonly resolvedPiAuthPath?: string;
  /** Test seam; production preserves its non-mono-agent host environment. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Override the provider-class deadline; production uses 90s cloud / 240s local. */
  readonly timeoutMs?: number;
  /** Test seam; production calls the selected primary runtime in an isolated worker. */
  readonly run?: (input: {
    readonly config: Awaited<ReturnType<typeof loadAppCoreConfig>>;
    readonly options: ReadinessRuntimeRunOptions;
  }) => Promise<RuntimeResult>;
  /** Test seam for proving timeout/process cleanup. */
  readonly dispose?: () => Promise<void> | void;
  /** Test seam for exercising the isolated-worker transport without a real provider. */
  readonly workerUrl?: URL;
  /**
   * Resume only routes that already completed successfully under the exact
   * immutable route plan. A mismatched fingerprint is ignored fail-closed.
   */
  readonly resume?: Readonly<{
    planFingerprint: string;
    successfulRouteKeys: readonly string[];
  }>;
  /** Non-secret progress hooks for app-owned preflight rendering. */
  readonly onRouteStart?: (route: ReadinessRouteStart) => void | Promise<void>;
  readonly onRouteComplete?: (result: ReadinessRouteResult) => void | Promise<void>;
}

export type ReadinessProbeFailureKind =
  | "invalid_plan"
  | "unsupported_guided_probe"
  | "timeout"
  | "cancelled"
  | "tool_used"
  | "provider_failed"
  | "empty_response"
  | "probe_failed";

export interface ReadinessRouteResult {
  readonly key: string;
  readonly index: number;
  readonly model: string;
  /** Omitted means the provider's own default; legacy fallbacks inherit. */
  readonly effort?: string;
  readonly status: "verified" | "failed" | "skipped_verified" | "interrupted";
  readonly kind?: ReadinessProbeFailureKind;
  readonly message?: string;
}

export interface ReadinessRouteStart {
  readonly key: string;
  readonly index: number;
  readonly total: number;
  readonly model: string;
  readonly effort?: string;
}

export type ReadinessProbeResult =
  | {
      readonly ok: true;
      readonly planFingerprint?: string;
      readonly routes?: readonly ReadinessRouteResult[];
    }
  | {
      readonly ok: false;
      readonly kind: ReadinessProbeFailureKind;
      readonly message: string;
      readonly planFingerprint?: string;
      readonly routes?: readonly ReadinessRouteResult[];
      readonly interrupted?: boolean;
    };

interface ReadinessRoutePlan {
  readonly index: number;
  readonly model: string;
  readonly effort?: string;
  readonly key: string;
}

/** Provider-aware hard deadline for the one-turn primary-model probe. */
export function readinessProbeTimeoutMs(model: RuntimeModelReference): number {
  return model.sdk === "pi" && model.provider !== undefined && LOCAL_PI_PROVIDERS.has(model.provider)
    ? LOCAL_READINESS_TIMEOUT_MS
    : CLOUD_READINESS_TIMEOUT_MS;
}

/** Source-derived operator wording for the per-route readiness deadlines. */
export function readinessProbeTimeoutDescription(): string {
  return `${CLOUD_READINESS_TIMEOUT_MS / 1_000}s for each cloud route and ${LOCAL_READINESS_TIMEOUT_MS / 1_000}s for each local route`;
}

/**
 * The probe must not inherit a configured agent from the shell it happens to
 * run in. Provider auth/runtime variables remain available, while every
 * ambient MONO_AGENT_* override is excluded before layered config loading.
 * Selected wizard secrets are an in-memory overlay and are intentionally added
 * afterwards; they are never written to the disposable workspace.
 */
export function readinessProbeEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>,
  secretValues: Readonly<Record<string, string>> = {},
  options: { readonly resolvedPiAuthPath?: string } = {},
): Record<string, string> {
  const sanitized = Object.fromEntries(
    Object.entries(hostEnv).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("MONO_AGENT_") && typeof entry[1] === "string",
    ),
  );
  const piAuthPath = options.resolvedPiAuthPath?.trim();
  return {
    ...sanitized,
    ...secretValues,
    ...(piAuthPath === undefined || piAuthPath.length === 0
      ? {}
      : { MONO_AGENT_PI_AUTH_PATH: piAuthPath }),
  };
}

const DIRECT_TOOL_EVENT_TYPES = new Set([
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

function normalizedEventType(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[./-]+/gu, "_").toLowerCase()
    : "";
}

function toolActionInEvent(event: RuntimeEventLike): string | undefined {
  const eventType = normalizedEventType(event.type);
  if (DIRECT_TOOL_EVENT_TYPES.has(eventType)) {
    return eventType;
  }
  const item = event.item;
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const itemType = normalizedEventType((item as Record<string, unknown>).type);
    if (DIRECT_TOOL_EVENT_TYPES.has(itemType)) {
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

function positiveTimeout(value: number | undefined, model: RuntimeModelReference): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : readinessProbeTimeoutMs(model);
}

type ProbeOutcome =
  | { readonly type: "result"; readonly result: RuntimeResult }
  | { readonly type: "error"; readonly error: unknown }
  | { readonly type: "timeout" }
  | { readonly type: "cancelled" }
  | { readonly type: "tool"; readonly action: string };

type ReadinessWorkerMessage =
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

interface ReadinessWorkerHandle {
  readonly outcome: Promise<ProbeOutcome>;
  readonly abort: () => void;
  readonly shutdown: () => Promise<void>;
}

interface ReadinessWorkerRuntimeSpec {
  readonly model: RuntimeModelReference;
  readonly executionMode?: string;
  readonly effort?: string;
  readonly workspace: string;
  readonly artifactDir: string;
  readonly piAuthPath?: string;
  readonly piTransport?: PiTransport;
}

function isReadinessWorkerMessage(value: unknown): value is ReadinessWorkerMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type === "disposed") {
    return true;
  }
  if (message.type === "error") {
    return typeof message.message === "string" && message.message.length <= REDACTED_DIAGNOSTIC_MAX_CHARS;
  }
  if (message.type === "tool") {
    return typeof message.action === "string" && DIRECT_TOOL_EVENT_TYPES.has(message.action);
  }
  return message.type === "result"
    && typeof message.hasText === "boolean"
    && typeof message.cancelled === "boolean"
    && (message.failureKind === undefined
      || (typeof message.failureKind === "string" && message.failureKind.length <= REDACTED_DIAGNOSTIC_MAX_CHARS))
    && (message.errorMessage === undefined
      || (typeof message.errorMessage === "string" && message.errorMessage.length <= REDACTED_DIAGNOSTIC_MAX_CHARS));
}

function workerResult(message: Extract<ReadinessWorkerMessage, { readonly type: "result" }>): RuntimeResult {
  return {
    text: message.hasText ? "ready" : "",
    ...(message.cancelled ? { cancelled: true } : {}),
    ...(message.failureKind === undefined ? {} : { failureKind: message.failureKind }),
    ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
  };
}

function startReadinessWorker(input: {
  readonly cwd: string;
  readonly runtime: ReadinessWorkerRuntimeSpec;
  readonly env: Readonly<Record<string, string>>;
  readonly workerUrl?: URL;
}): ReadinessWorkerHandle {
  const model = input.runtime.model;
  const worker = new Worker(input.workerUrl ?? new URL("./readiness-probe-worker.js", import.meta.url), {
    // The parent has already loaded and validated the disposable config. Only
    // this clone-safe, credential-free execution spec crosses workerData.
    workerData: {
      cwd: input.cwd,
      runtime: {
        model: {
          sdk: model.sdk,
          model: model.model,
          ...(model.provider === undefined ? {} : { provider: model.provider }),
          ...(model.reference === undefined ? {} : { reference: model.reference }),
        },
        ...(input.runtime.executionMode === undefined
          ? {}
          : { executionMode: input.runtime.executionMode }),
        ...(input.runtime.effort === undefined ? {} : { effort: input.runtime.effort }),
        workspace: input.runtime.workspace,
        artifactDir: input.runtime.artifactDir,
        ...(input.runtime.piAuthPath === undefined ? {} : { piAuthPath: input.runtime.piAuthPath }),
        ...(input.runtime.piTransport === undefined ? {} : { piTransport: input.runtime.piTransport }),
      },
    },
    env: { ...input.env },
    // Provider SDKs must not be able to leak credentials through inherited
    // worker stdout/stderr. The streams are deliberately drained below.
    stdout: true,
    stderr: true,
  });
  worker.stdout?.resume();
  worker.stderr?.resume();

  let exited = false;
  let outcomeSettled = false;
  let resolveOutcome: ((outcome: ProbeOutcome) => void) | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const outcome = new Promise<ProbeOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const settleOutcome = (next: ProbeOutcome): void => {
    if (!outcomeSettled) {
      outcomeSettled = true;
      resolveOutcome?.(next);
    }
  };
  const abort = (): void => {
    if (exited) {
      return;
    }
    try {
      worker.postMessage({ type: "abort" });
    } catch {
      // The worker exited between the state check and postMessage.
    }
  };

  worker.on("message", (value: unknown) => {
    if (!isReadinessWorkerMessage(value)) {
      settleOutcome({ type: "error", error: new Error("The isolated readiness worker returned an invalid response.") });
      abort();
      return;
    }
    if (value.type === "disposed") {
      resolveStopped?.();
      return;
    }
    if (value.type === "error") {
      settleOutcome({ type: "error", error: new Error(value.message) });
      return;
    }
    if (value.type === "tool") {
      settleOutcome({ type: "tool", action: value.action });
      abort();
      return;
    }
    settleOutcome({ type: "result", result: workerResult(value) });
  });
  worker.once("error", () => {
    // Deliberately discard the worker error object: a provider SDK may include
    // credential-bearing request details in it.
    settleOutcome({ type: "error", error: new Error("The isolated readiness worker failed.") });
    resolveStopped?.();
  });
  worker.once("exit", () => {
    exited = true;
    settleOutcome({ type: "error", error: new Error("The isolated readiness worker exited before returning a result.") });
    resolveStopped?.();
  });

  return {
    outcome,
    abort,
    async shutdown() {
      abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, WORKER_SHUTDOWN_GRACE_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (!exited) {
          // disposeAllSessions in the worker is best-effort and bounded. A
          // provider that ignores both abort and disposal cannot keep worker JS
          // alive. Any SDK-spawned orphan still has only the worker's exact env.
          await worker.terminate().catch(() => undefined);
        }
      }
    },
  };
}

function selectedReadinessRoutes(
  plan: WizardPlan,
  options: Pick<
    ReadinessProbeOptions,
    "hostEnv" | "resolvedPiAuthPath" | "secretValues" | "timeoutMs"
  > = {},
): {
  readonly routes: readonly ReadinessRoutePlan[];
  readonly fingerprint: string;
} {
  const runtime = (plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const primary = typeof runtime.model === "string" ? runtime.model : "";
  const inheritedEffort = typeof runtime.effort === "string" ? runtime.effort : undefined;
  const authored: Array<{ model: string; effort?: string }> = [];
  if (primary.length > 0) {
    authored.push({ model: primary, ...(inheritedEffort === undefined ? {} : { effort: inheritedEffort }) });
  }

  // Canonical fallbacks have independent effort semantics: omission means the
  // provider default, not inheritance from the primary route.
  if (Array.isArray(runtime.fallbacks)) {
    for (const raw of runtime.fallbacks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.model !== "string" || entry.model.length === 0) continue;
      authored.push({
        model: entry.model,
        ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
      });
    }
  } else if (Array.isArray(runtime.fallbackModels)) {
    // Legacy fallbackModels intentionally retain their historical inheritance.
    for (const model of runtime.fallbackModels) {
      if (typeof model !== "string" || model.length === 0) continue;
      authored.push({ model, ...(inheritedEffort === undefined ? {} : { effort: inheritedEffort }) });
    }
  }

  const immutableRoutes = authored.map((route, index) => ({ index, model: route.model, effort: route.effort ?? null }));
  const executionRuntime = { ...runtime };
  delete executionRuntime.model;
  delete executionRuntime.effort;
  delete executionRuntime.fallbacks;
  delete executionRuntime.fallbackModels;
  delete executionRuntime.session;
  delete executionRuntime.workspace;
  const nonSecretEnvironment = Object.fromEntries(
    Object.entries(options.hostEnv ?? process.env)
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
        && !isSensitiveEnvironmentName(entry[0])
        && !entry[0].startsWith("MONO_AGENT_")
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const immutable = canonicalFingerprintValue({
    version: 2,
    routes: immutableRoutes,
    runtime: executionRuntime,
    providers: (plan.configJson as Record<string, unknown>).providers ?? null,
    resolvedPiAuthPath: options.resolvedPiAuthPath ?? null,
    nonSecretEnvironment,
    selectedSecretNames: Object.keys(options.secretValues ?? {}).sort(),
    timeoutMs: options.timeoutMs ?? null,
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(immutable))
    .digest("hex");
  return {
    fingerprint,
    routes: authored.map((route, index) => ({
      index,
      ...route,
      key: createHash("sha256")
        .update(JSON.stringify({ version: 1, index, model: route.model, effort: route.effort ?? null }))
        .digest("hex"),
    })),
  };
}

function canonicalFingerprintValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_FINGERPRINT_KEY.test(key)) return "[secret-redacted]";
  if (Array.isArray(value)) return value.map((entry) => canonicalFingerprintValue(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => [entryKey, canonicalFingerprintValue(entryValue, entryKey)]),
  );
}

function singleRouteWizardPlan(plan: WizardPlan, route: ReadinessRoutePlan): WizardPlan {
  const configJson = structuredClone(plan.configJson) as Record<string, unknown>;
  const runtime: Record<string, unknown> = {
    ...((configJson.runtime ?? {}) as Record<string, unknown>),
    model: route.model,
  };
  delete runtime.fallbacks;
  delete runtime.fallbackModels;
  delete runtime.session;
  if (route.effort === undefined) delete runtime.effort;
  else runtime.effort = route.effort;
  configJson.runtime = runtime;
  return { ...plan, configJson: configJson as WizardPlan["configJson"] };
}

/**
 * Make one real, sequential no-tool turn for every selected persistent runtime
 * route and return the ordered route ledger, including for a primary-only plan.
 * A route is never allowed to invoke its configured fallback chain. Ordinary
 * failures are collected so the operator gets one complete summary; caller
 * cancellation stops the current route and records interruption state.
 */
export async function runAllRouteReadinessProbe(
  options: ReadinessProbeOptions,
): Promise<ReadinessProbeResult> {
  return runSelectedReadinessRoutes(options, selectedReadinessRoutes(options.plan, options));
}

async function runSelectedReadinessRoutes(
  options: ReadinessProbeOptions,
  selected: ReturnType<typeof selectedReadinessRoutes>,
): Promise<ReadinessProbeResult> {
  if (selected.routes.length === 0) {
    return {
      ok: false,
      kind: "invalid_plan",
      message: "The readiness plan does not contain a selected runtime model.",
      planFingerprint: selected.fingerprint,
      routes: [],
    };
  }

  const mayResume = options.resume?.planFingerprint === selected.fingerprint;
  const successful = mayResume
    ? new Set(options.resume?.successfulRouteKeys ?? [])
    : new Set<string>();
  const results: ReadinessRouteResult[] = [];
  for (const route of selected.routes) {
    const displayRoute = {
      ...route,
      model: boundedRouteField(route.model, 200),
      ...(route.effort === undefined ? {} : { effort: boundedRouteField(route.effort, 32) }),
    };
    await notifyReadinessProgress(options.onRouteStart, {
      ...displayRoute,
      total: selected.routes.length,
    });
    if (options.abortSignal?.aborted === true) {
      const completed: ReadinessRouteResult = {
        ...displayRoute,
        status: "interrupted",
        kind: "cancelled",
        message: "The route check was interrupted before it started.",
      };
      results.push(completed);
      await notifyReadinessProgress(options.onRouteComplete, completed);
      return {
        ok: false,
        kind: "cancelled",
        message: `Readiness was interrupted after ${results.filter((entry) => entry.status === "verified" || entry.status === "skipped_verified").length} of ${selected.routes.length} routes were verified.`,
        planFingerprint: selected.fingerprint,
        routes: results,
        interrupted: true,
      };
    }
    if (successful.has(route.key)) {
      const completed: ReadinessRouteResult = { ...displayRoute, status: "skipped_verified" };
      results.push(completed);
      await notifyReadinessProgress(options.onRouteComplete, completed);
      continue;
    }

    const { resume: _resume, ...singleOptions } = options;
    const result = await runSingleReadinessProbe({
      ...singleOptions,
      plan: singleRouteWizardPlan(options.plan, route),
    });
    if (result.ok) {
      const completed: ReadinessRouteResult = { ...displayRoute, status: "verified" };
      results.push(completed);
      await notifyReadinessProgress(options.onRouteComplete, completed);
      continue;
    }
    const interrupted = result.kind === "cancelled";
    const completed: ReadinessRouteResult = {
      ...displayRoute,
      status: interrupted ? "interrupted" : "failed",
      kind: result.kind,
      message: result.message,
    };
    results.push(completed);
    await notifyReadinessProgress(options.onRouteComplete, completed);
    if (interrupted) {
      return {
        ok: false,
        kind: "cancelled",
        message: `Readiness was interrupted while checking route ${route.index + 1} of ${selected.routes.length}.`,
        planFingerprint: selected.fingerprint,
        routes: results,
        interrupted: true,
      };
    }
  }

  const failures = results.filter((entry) => entry.status === "failed");
  if (failures.length > 0) {
    const first = failures[0];
    return {
      ok: false,
      kind: first?.kind ?? "provider_failed",
      message: `${failures.length} of ${selected.routes.length} runtime route checks failed. ${first?.model ?? "Selected route"}: ${first?.message ?? "provider failure"}`,
      planFingerprint: selected.fingerprint,
      routes: results,
    };
  }
  return { ok: true, planFingerprint: selected.fingerprint, routes: results };
}

async function notifyReadinessProgress<T>(
  callback: ((value: T) => void | Promise<void>) | undefined,
  value: T,
): Promise<void> {
  try {
    await callback?.(value);
  } catch {
    // Rendering/progress observers never alter readiness semantics.
  }
}

function boundedRouteField(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

/** Run exactly one route with no fallback chain. */
async function runSingleReadinessProbe(options: ReadinessProbeOptions): Promise<ReadinessProbeResult> {
  const selectedModel = options.plan.configJson.runtime?.model;
  if (typeof selectedModel === "string" && selectedModel.startsWith("opencode:")) {
    return {
      ok: false,
      kind: "unsupported_guided_probe",
      message:
        "Direct opencode:* is an advanced config-only backend and cannot run the guided no-tool readiness probe. " +
        "Choose pi:opencode-go:<model>, or use non-interactive --model opencode:<provider>:<model> scaffolding and validate the explicit runtime.permissionMode configuration.",
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-readiness-"));
  const secrets = options.secretValues ?? {};
  const redact = (value: unknown, fallback: string): string => redactSecrets(value, {
    fallback,
    secrets: Object.values(secrets),
    environment: options.hostEnv ?? process.env,
  });
  try {
    const config = structuredClone(options.plan.configJson) as Record<string, unknown>;
    config.tools = { allowedTools: [], disallowedTools: [] };
    const runtime = config.runtime as Record<string, unknown>;
    config.runtime = { ...runtime, workspace: ".mono-agent/workspace" };
    delete (config.runtime as Record<string, unknown>).fallbackModels;
    delete (config.runtime as Record<string, unknown>).fallbacks;
    delete (config.runtime as Record<string, unknown>).session;
    delete config.memory;
    delete config.artifacts;
    delete config.traceability;
    delete config.observability;
    const providers = config.providers as Record<string, unknown> | undefined;
    if (providers?.piNative !== undefined && typeof providers.piNative === "object" && providers.piNative !== null) {
      const piNative = { ...(providers.piNative as Record<string, unknown>) };
      delete piNative.piSessionsRoot;
      config.providers = { ...providers, piNative };
    }
    delete config.webhook;
    delete config.telegram;
    delete config.slack;
    delete config.openaiApi;
    delete config.cron;
    // The target's context can point to files outside this ephemeral workspace.
    // A probe validates a known-good, self-contained identity instead.
    config.context = { identityPath: "./IDENTITY.md", selectedSkills: [] };
    await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "IDENTITY.md"),
      "# Readiness probe identity\n\nYou are checking that the selected model can produce one concise response.\n",
      { mode: 0o600 },
    );
    await mkdir(join(dir, ".mono-agent", "workspace"), { recursive: true });
    await mkdir(join(dir, ".mono-agent", "artifacts"), { recursive: true });
    const overlay = readinessProbeEnvironment(options.hostEnv ?? process.env, secrets, {
      ...(options.resolvedPiAuthPath === undefined ? {} : { resolvedPiAuthPath: options.resolvedPiAuthPath }),
    });
    const loaded = await loadAppCoreConfig({
      cwd: dir,
      configPath: join(dir, "mono-agent.config.json"),
      env: overlay,
    });
    // This checks the generated config plus its IDENTITY.md before contacting a
    // provider. No channel driver is loaded, no liveness probe runs, and writes
    // are disabled; the disposable probe remains side-effect free.
    const validation = await validateMonoAgentFolder({
      cwd: dir,
      configPath: join(dir, "mono-agent.config.json"),
      env: overlay,
      drivers: [],
      liveness: false,
      allowFilesystemWrites: false,
      codexNoToolsProbe: true,
    });
    if (!validation.ok) {
      return {
        ok: false,
        kind: "invalid_plan",
        message: redact(
          validation.sections.flatMap((section) => section.details).join(" "),
          "The generated primary-model probe configuration is invalid.",
        ),
      };
    }

    let firstToolAction: string | undefined;
    const timeoutMs = positiveTimeout(options.timeoutMs, loaded.runtime.model);
    const controller = new AbortController();
    let resolveToolOutcome: ((outcome: ProbeOutcome) => void) | undefined;
    const toolOutcome = new Promise<ProbeOutcome>((resolve) => {
      resolveToolOutcome = resolve;
    });
    let callerAbortListener: (() => void) | undefined;
    const callerCancellation = new Promise<ProbeOutcome>((resolve) => {
      if (options.abortSignal === undefined) {
        return;
      }
      callerAbortListener = () => {
        // Settle this race branch before aborting the provider. A runtime may
        // synchronously reject on abort; the caller's cancellation must remain
        // the reported reason.
        resolve({ type: "cancelled" });
        controller.abort();
      };
      if (options.abortSignal.aborted) {
        callerAbortListener();
      } else {
        options.abortSignal.addEventListener("abort", callerAbortListener, { once: true });
      }
    });
    const runOptions: ReadinessRuntimeRunOptions = {
      model: loaded.runtime.model,
      ...(loaded.runtime.executionMode === undefined ? {} : { executionMode: loaded.runtime.executionMode }),
      ...(loaded.runtime.effort === undefined ? {} : { effort: loaded.runtime.effort }),
      messages: [{ role: "user", content: "Reply with a short readiness acknowledgement." }],
      abortSignal: controller.signal,
      cwd: dir,
      maxTurns: 1,
      ...(loaded.providers?.piNative?.transport === undefined
        ? {}
        : { piTransport: loaded.providers.piNative.transport }),
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      // Codex app-server has no general allowlist. This dedicated mode uses a
      // read-only/never-approve payload and fails on the first tool action.
      codexNoToolsProbe: true,
      onEvent: (event) => {
        const action = toolActionInEvent(event);
        if (action !== undefined && firstToolAction === undefined) {
          firstToolAction = action;
          // As with caller cancellation, publish the policy failure before
          // aborting so an abort-triggered provider rejection cannot mask it.
          resolveToolOutcome?.({ type: "tool", action });
          controller.abort();
        }
      },
      sessionKeepAlive: false,
      // The production runtime receives this environment through worker
      // isolation. The explicit immutable copy gives injected runs the same
      // deterministic contract without replacing the host process environment.
      providerEnv: Object.freeze({ ...overlay }),
    };
    let workerHandle: ReadinessWorkerHandle | undefined;
    let workerAbortListener: (() => void) | undefined;
    let providerOutcome: Promise<ProbeOutcome>;
    if (options.abortSignal?.aborted === true) {
      providerOutcome = new Promise<ProbeOutcome>(() => {});
    } else if (options.run !== undefined) {
      const injectedRun = options.run;
      const runPromise = Promise.resolve().then(() => injectedRun({ config: loaded, options: runOptions }));
      // The timeout wins independently of provider abort support. Keep an explicit
      // rejection consumer because an ignored abort may settle after we return.
      void runPromise.catch(() => {});
      providerOutcome = runPromise.then<ProbeOutcome, ProbeOutcome>(
        (result) => ({ type: "result", result }),
        (error: unknown) => ({ type: "error", error }),
      );
    } else {
      try {
        workerHandle = startReadinessWorker({
          cwd: dir,
          runtime: {
            model: loaded.runtime.model,
            ...(loaded.runtime.executionMode === undefined
              ? {}
              : { executionMode: loaded.runtime.executionMode }),
            ...(loaded.runtime.effort === undefined ? {} : { effort: loaded.runtime.effort }),
            workspace: loaded.runtime.workspace,
            artifactDir: loaded.artifacts.dir,
            ...(loaded.providers?.piAuthPath === undefined
              ? {}
              : { piAuthPath: loaded.providers.piAuthPath }),
            ...(loaded.providers?.piNative?.transport === undefined
              ? {}
              : { piTransport: loaded.providers.piNative.transport }),
          },
          env: overlay,
          ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
        });
        workerAbortListener = () => workerHandle?.abort();
        controller.signal.addEventListener("abort", workerAbortListener, { once: true });
        providerOutcome = workerHandle.outcome;
      } catch {
        // Worker constructor details are not surfaced: exec arguments or a
        // provider loader may have included sensitive values.
        providerOutcome = Promise.resolve({
          type: "error",
          error: new Error("The isolated readiness worker could not be started."),
        });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProbeOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ type: "timeout" });
        controller.abort();
      }, timeoutMs);
    });
    let outcome: ProbeOutcome;
    try {
      outcome = await Promise.race([
        providerOutcome,
        timeout,
        callerCancellation,
        toolOutcome,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (callerAbortListener !== undefined) {
        options.abortSignal?.removeEventListener("abort", callerAbortListener);
      }
      if (workerAbortListener !== undefined) {
        controller.signal.removeEventListener("abort", workerAbortListener);
      }
      if (workerHandle !== undefined) {
        await workerHandle.shutdown();
      } else {
        await options.dispose?.();
      }
    }
    if (outcome.type === "cancelled") {
      return {
        ok: false,
        kind: "cancelled",
        message: "The primary-model check was cancelled before completion.",
      };
    }
    if (outcome.type === "tool") {
      return {
        ok: false,
        kind: "tool_used",
        message: `The selected model attempted a tool action (${outcome.action}) during the no-tool primary-model check.`,
      };
    }
    if (outcome.type === "timeout") {
      return {
        ok: false,
        kind: "timeout",
        message: `The selected model did not finish the primary-model check within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
      };
    }
    if (outcome.type === "error") {
      return {
        ok: false,
        kind: "probe_failed",
        message: redact(outcome.error, "The primary-model check failed unexpectedly."),
      };
    }
    const result = outcome.result;
    for (const event of result.events ?? []) {
      firstToolAction ??= toolActionInEvent(event);
    }
    if (firstToolAction !== undefined || result.failureKind === "tool_policy_violation") {
      return {
        ok: false,
        kind: "tool_used",
        message: `The selected model attempted a tool action (${firstToolAction ?? "provider tool"}) during the no-tool primary-model check.`,
      };
    }
    if (result.cancelled === true) {
      return {
        ok: false,
        kind: "cancelled",
        message: "The selected model cancelled before completing the primary-model check.",
      };
    }
    if (result.failureKind !== undefined && result.failureKind !== null) {
      return {
        ok: false,
        kind: "provider_failed",
        message: redact(
          result.error,
          `The selected model reported ${redact(result.failureKind, "a provider failure")}.`,
        ),
      };
    }
    if (result.error !== undefined && result.error !== null) {
      return {
        ok: false,
        kind: "provider_failed",
        message: redact(result.error, "The selected model reported an error."),
      };
    }
    if ((result.text ?? "").trim().length === 0) {
      return {
        ok: false,
        kind: "empty_response",
        message: "The selected model returned an empty primary-model response.",
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      kind: "probe_failed",
      message: redact(error, "The primary-model check failed unexpectedly."),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

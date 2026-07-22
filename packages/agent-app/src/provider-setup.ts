import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import { inspectPiAuthStore } from "./pi-auth-store-inspection.js";

export type ProviderSetupKind = "auth" | "preflight";

export interface ProviderSetupCommandAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiLoginAction extends ProviderSetupCommandAction {
  readonly id: `pi-login:${string}`;
  readonly piAuthPath: string;
}

export type CodexLoginMode = "browser" | "device";

export interface ProviderSetupCodexLoginAction extends ProviderSetupCommandAction {
  readonly id: "codex-login";
  readonly authMode: CodexLoginMode;
}

export interface ProviderSetupHttpAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly url: string;
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiApiKeyAction {
  readonly id: string;
  readonly kind: "auth";
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly provider: string;
  readonly envVar: string;
  readonly persistence: "secure-store" | "environment";
  readonly piAuthPath: string;
  readonly cwd: string;
  readonly detail: string;
}

export type ProviderSetupAction =
  | ProviderSetupPiLoginAction
  | ProviderSetupCodexLoginAction
  | ProviderSetupCommandAction
  | ProviderSetupHttpAction
  | ProviderSetupPiApiKeyAction;

export interface ProviderSetupPlan {
  readonly actions: readonly ProviderSetupAction[];
  /** Auth actions omitted because a credential/sign-in was detected. */
  readonly detectedModelRefs: readonly string[];
}

export type ProviderCredentialState = "auth_required" | "credential_detected" | "verified";

export interface DetectProviderCredentialStatesOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly piAuthPath?: string;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly execFile?: (
    file: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly timeout: number;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly abortSignal?: AbortSignal;
    },
  ) => Promise<unknown>;
}

export type ProviderSetupStatus = "ok" | "failed" | "skipped";
export type ProviderSetupFailureKind = "child_exit_unconfirmed" | "cleanup_failed";

export interface ProviderSetupResult {
  readonly action: ProviderSetupAction;
  readonly status: ProviderSetupStatus;
  readonly detail: string;
  readonly failureKind?: ProviderSetupFailureKind;
}

export interface PlanProviderSetupOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly piAuthPath?: string;
  /** Internal test seam for verifying bundled Pi CLI resolution in packed layouts. */
  readonly piCliPath?: string;
  /** Credential/status observations keyed by `claude`, `codex`, `pi:<provider>`, or provider id. */
  readonly credentialStates?: Readonly<Record<string, ProviderCredentialState | undefined>>;
  /** Explicit repair path: rerun authentication even when a credential was detected. */
  readonly forceAuthentication?: boolean;
  /** Direct Codex never guesses headless mode; callers select this explicitly. */
  readonly codexAuthMode?: CodexLoginMode;
  /** Select OAuth or API-key setup for Pi providers that support both. */
  readonly piAuthMethods?: Readonly<Record<string, "oauth" | "api-key" | undefined>>;
  /** API keys can be used from env without being copied into Pi's secure store. */
  readonly piApiKeyPersistence?: "secure-store" | "environment";
  /** Per-provider wizard selections override the global API-key persistence mode. */
  readonly piApiKeyPersistenceByProvider?: Readonly<Record<string, "secure-store" | "environment" | undefined>>;
}

export interface ExecuteProviderSetupOptions {
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Bounded only for non-interactive local-provider preflight probes. */
  readonly preflightTimeoutMs?: number;
  /** Test seam; automatic credential persistence fails closed on Windows. */
  readonly platform?: NodeJS.Platform;
  /** Test seam immediately before the target pathname is claimed. */
  readonly beforePiAuthPromotion?: (targetPath: string, stagedPath: string) => void | Promise<void>;
  /** Test seam after exclusive link installation and before immutable-byte verification. */
  readonly afterPiAuthLink?: (targetPath: string, stagedPath: string) => void | Promise<void>;
  /** Test seam immediately before stale-lock identity/liveness is rechecked. */
  readonly beforeStalePiAuthLockRemoval?: (lockPath: string) => void | Promise<void>;
  /** Test seam after a stale lock is unlinked but before directory sync. */
  readonly afterStalePiAuthLockRemoval?: (lockPath: string) => void | Promise<void>;
  /** Test seam immediately before a staged Pi OAuth directory is removed. */
  readonly beforePiAuthCleanup?: (stagingDir: string) => void | Promise<void>;
  /** Test seam after a new lock is durable but before setup begins. */
  readonly afterPiAuthLockCreated?: (lockPath: string) => void | Promise<void>;
  /** Test seam before confirming an already-absent owned lock is durable. */
  readonly beforePiAuthMissingLockSync?: (lockPath: string) => void | Promise<void>;
  /** Test seam immediately before an API-key transaction directory is removed. */
  readonly beforePiAuthTempCleanup?: (tempDir: string) => void | Promise<void>;
  /** Test seam immediately before an old credential backup is removed. */
  readonly beforePiAuthBackupCleanup?: (backupPath: string) => void | Promise<void>;
  /** Test seam after credentials are installed but before parent-directory sync. */
  readonly beforePiAuthPostMutationSync?: (authPath: string) => void | Promise<void>;
  /** Stop before launching the next independent action after user interruption. */
  readonly abortSignal?: AbortSignal;
}

type PiAuthPromotionHooks = Pick<
  ExecuteProviderSetupOptions,
  | "beforePiAuthPromotion"
  | "afterPiAuthLink"
  | "beforeStalePiAuthLockRemoval"
  | "afterStalePiAuthLockRemoval"
  | "beforePiAuthCleanup"
  | "afterPiAuthLockCreated"
  | "beforePiAuthMissingLockSync"
  | "beforePiAuthTempCleanup"
  | "beforePiAuthBackupCleanup"
  | "beforePiAuthPostMutationSync"
>;

const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const PI_API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};
const DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS = {
  codex: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
} as const;
const PROVIDER_STATUS_SECRET_ENV_KEYS = [
  ...DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS.codex,
  ...DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS.claude,
  ...Object.values(PI_API_KEY_PROVIDERS),
] as const;
const PROVIDER_STATUS_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOMEDRIVE",
  "HOME",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "USERNAME",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS = 5_000;
const PROVIDER_AUTH_TERM_GRACE_MS = 1_000;
const PROVIDER_AUTH_KILL_SETTLE_MS = 1_000;
const PROVIDER_PREFLIGHT_TERM_GRACE_MS = 250;
const PROVIDER_PREFLIGHT_KILL_SETTLE_MS = 250;
const PROVIDER_DISCOVERY_TERM_GRACE_MS = 250;
const PROVIDER_DISCOVERY_KILL_SETTLE_MS = 250;
const MAX_PROVIDER_DISCOVERY_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_API_KEY_CREDENTIAL_STRING_LENGTH = 65_536;

export function resolvePiCliPath(): string {
  // App-owned wrapper, provider-owned OAuth: unlike Pi's generic CLI this
  // supplies onManualCodeInput, so a full redirect URL pasted into the terminal
  // reaches Anthropic's state-validating parser.
  return fileURLToPath(new URL("./pi-oauth-login-main.js", import.meta.url));
}

export function piLoginCommand(provider: string, piCliPath = resolvePiCliPath()): readonly [string, ...string[]] {
  return [process.execPath, piCliPath, provider];
}

export function piAuthRecoveryCommand(provider: string, piAuthPath?: string): string {
  return piAuthPath === undefined
    ? `mono-agent auth login ${shellQuote(provider)}`
    : `mono-agent auth login ${shellQuote(provider)} --pi-auth-path ${shellQuote(piAuthPath)}`;
}

export function piAuthWorkingDirectory(piAuthPath: string | undefined, cwd = process.cwd()): string {
  return dirname(piAuthPathForSetup(piAuthPath, cwd));
}

export function piAuthPathForSetup(piAuthPath: string | undefined, cwd = process.cwd()): string {
  if (piAuthPath === undefined || piAuthPath.trim().length === 0) {
    return DEFAULT_PI_AUTH_PATH;
  }
  const normalized = piAuthPath.trim();
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return resolve(homedir(), normalized.slice(2));
  }
  return resolve(cwd, normalized);
}

/**
 * Detect credential/sign-in postconditions without authenticating or claiming
 * provider readiness. Only an exact live route probe may promote these states
 * to `verified`.
 */
export async function detectProviderCredentialStates(
  options: DetectProviderCredentialStatesOptions,
): Promise<Readonly<Record<string, ProviderCredentialState>>> {
  const states: Record<string, ProviderCredentialState> = {};
  const refs = options.modelRefs.flatMap((raw) => {
    try {
      return [parseMonoRuntimeModelReference(raw)];
    } catch {
      return [];
    }
  });
  const timeout = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 2_000;
  const run = options.execFile ?? runProviderStatusCommand;
  const persistedEnv = options.persistedEnv ?? {};
  const statusEnv = credentialNeutralProviderStatusEnvironment(process.env, persistedEnv);
  const checks: Promise<void>[] = [];
  if (refs.some((ref) => ref.sdk === "codex")) {
    if (hasAnyNonEmptyPersistedValue(persistedEnv, DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS.codex)) {
      states.codex = "credential_detected";
    } else {
      checks.push(run("codex", ["login", "status"], {
        cwd: options.cwd,
        timeout,
        env: statusEnv,
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      }).then(
        () => { states.codex = "credential_detected"; },
        () => { states.codex = "auth_required"; },
      ));
    }
  }
  if (refs.some((ref) => ref.sdk === "claude")) {
    if (hasAnyNonEmptyPersistedValue(persistedEnv, DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS.claude)) {
      states.claude = "credential_detected";
    } else {
      checks.push(run("claude", ["auth", "status", "--json"], {
        cwd: options.cwd,
        timeout,
        env: statusEnv,
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      }).then(
        () => { states.claude = "credential_detected"; },
        () => { states.claude = "auth_required"; },
      ));
    }
  }

  const piProviders = new Set(
    refs.filter((ref) => ref.sdk === "pi" && typeof ref.provider === "string")
      .map((ref) => ref.provider as string),
  );
  if (piProviders.size > 0) {
    const detected = await safelyDetectedPiCredentialProviders(
      piAuthPathForSetup(options.piAuthPath, options.cwd),
    );
    for (const provider of piProviders) {
      const apiKeyEnv = PI_API_KEY_PROVIDERS[provider];
      states[`pi:${provider}`] = detected.has(provider)
        || (apiKeyEnv !== undefined && hasNonEmptyPersistedValue(persistedEnv[apiKeyEnv]))
        ? "credential_detected"
        : "auth_required";
    }
  }
  await Promise.all(checks);
  return states;
}

/** Whether a selected route has a credential in the destination agent's durable environment. */
export function hasDurableProviderEnvironmentCredential(
  rawModelRef: string,
  persistedEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  let ref;
  try {
    ref = parseMonoRuntimeModelReference(rawModelRef);
  } catch {
    return false;
  }
  if (ref.sdk === "codex") {
    return hasAnyNonEmptyPersistedValue(persistedEnv, DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS.codex);
  }
  if (ref.sdk === "claude") {
    return hasAnyNonEmptyPersistedValue(persistedEnv, DIRECT_PROVIDER_CREDENTIAL_ENV_KEYS.claude);
  }
  if (ref.sdk !== "pi" || typeof ref.provider !== "string") return false;
  const apiKeyEnv = PI_API_KEY_PROVIDERS[ref.provider];
  return apiKeyEnv !== undefined && hasNonEmptyPersistedValue(persistedEnv[apiKeyEnv]);
}

function hasAnyNonEmptyPersistedValue(
  persistedEnv: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): boolean {
  return names.some((name) => hasNonEmptyPersistedValue(persistedEnv[name]));
}

function hasNonEmptyPersistedValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Build the minimal operational environment needed to inspect durable CLI login
 * state. A positive allowlist prevents unrelated shell credentials from being
 * inherited by Codex or Claude while retaining their standard config roots.
 */
export function credentialNeutralProviderStatusEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  durableEnvironment: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (
      PROVIDER_STATUS_ENV_ALLOWLIST.has(normalizedName)
      || normalizedName.startsWith("LC_")
    ) {
      sanitized[name] = value;
    }
  }
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) {
    const value = durableEnvironment[name];
    if (hasNonEmptyPersistedValue(value)) sanitized[name] = value;
  }
  for (const name of PROVIDER_STATUS_SECRET_ENV_KEYS) delete sanitized[name];
  return sanitized;
}

function runProviderStatusCommand(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeout: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly abortSignal?: AbortSignal;
  },
): Promise<void> {
  return runBoundedProviderCommand(file, args, options).then(() => undefined);
}

export interface BoundedProviderCommandResult {
  readonly stdout: string;
}

/**
 * Run a non-interactive provider probe with a hard process-lifecycle bound.
 * Node's execFile timeout sends only SIGTERM and can wait forever when a CLI
 * traps it, so discovery uses explicit TERM-to-KILL escalation and detaches a
 * process whose exit still cannot be confirmed.
 */
export function runBoundedProviderCommand(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeout: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly abortSignal?: AbortSignal;
    readonly spawn?: typeof spawn;
  },
): Promise<BoundedProviderCommandResult> {
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0
    ? Math.max(1, Math.trunc(options.timeout))
    : 1;
  return new Promise((resolveCommand, rejectCommand) => {
    const spawnImpl = options.spawn ?? spawn;
    const child = spawnImpl(file, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let terminationReason: Error | undefined;
    let childError: Error | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let killSettlementTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (killSettlementTimer !== undefined) clearTimeout(killSettlementTimer);
      options.abortSignal?.removeEventListener("abort", abort);
      child.stdout?.off("data", onStdout);
      if (error === undefined) resolveCommand({ stdout: Buffer.concat(chunks).toString("utf8") });
      else rejectCommand(error);
    };
    const terminate = (reason: Error): void => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = reason;
      try { child.kill("SIGTERM"); } catch { /* escalation remains authoritative */ }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* settlement deadline remains authoritative */ }
        killSettlementTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.unref?.();
          finish(reason);
        }, PROVIDER_DISCOVERY_KILL_SETTLE_MS);
        killSettlementTimer.unref?.();
      }, PROVIDER_DISCOVERY_TERM_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const abort = (): void => {
      const error = new Error(`${file} provider probe was interrupted.`);
      error.name = "AbortError";
      terminate(error);
    };
    const onStdout = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_PROVIDER_DISCOVERY_STDOUT_BYTES) {
        terminate(new Error(`${file} provider probe exceeded the ${MAX_PROVIDER_DISCOVERY_STDOUT_BYTES}-byte output limit.`));
        return;
      }
      chunks.push(bytes);
    };

    child.stdout?.on("data", onStdout);
    child.once("error", (error) => {
      childError = error;
      if (child.pid === undefined && terminationReason === undefined) finish(error);
    });
    child.once("close", (code, signal) => {
      if (terminationReason !== undefined) {
        finish(terminationReason);
      } else if (code === 0) {
        finish();
      } else {
        finish(childError ?? new Error(
          signal === null
            ? `${file} provider probe exited ${code ?? "unknown"}.`
            : `${file} provider probe terminated by ${signal}.`,
        ));
      }
    });
    timeoutTimer = setTimeout(
      () => terminate(new Error(`${file} provider probe timed out after ${timeout}ms.`)),
      timeout,
    );
    timeoutTimer.unref?.();
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    if (options.abortSignal?.aborted === true) abort();
  });
}

async function safelyDetectedPiCredentialProviders(path: string): Promise<Set<string>> {
  const inspection = await inspectPiAuthStore(path);
  if (inspection.status !== "ok") return new Set();
  const nested = isRecord(inspection.auth.providers) ? inspection.auth.providers : {};
  const entries = Object.entries({
    ...nested,
    ...Object.fromEntries(Object.entries(inspection.auth).filter(([key]) => key !== "providers")),
  });
  return new Set(entries
    .filter(([provider, credential]) => isUsableStoredPiCredential(provider, credential))
    .map(([provider]) => provider));
}

export function planProviderSetup(options: PlanProviderSetupOptions): ProviderSetupPlan {
  const piAuthPath = options.piAuthPath ?? DEFAULT_PI_AUTH_PATH;
  const actionsById = new Map<string, ProviderSetupAction>();
  const detectedModelRefs = new Set<string>();
  const piOAuthProviders = new Set(getOAuthProviders().map((provider) => provider.id));
  const piProviders = builtinModels();
  const authAlreadyDetected = (keys: readonly string[]): boolean =>
    options.forceAuthentication !== true && keys.some((key) => {
      const state = options.credentialStates?.[key];
      return state === "credential_detected" || state === "verified";
    });

  for (const raw of options.modelRefs) {
    let ref;
    try {
      ref = parseMonoRuntimeModelReference(raw);
    } catch {
      continue;
    }

    const refKey = modelReferenceKey(ref);
    const add = (action: ProviderSetupAction) => {
      const existing = actionsById.get(action.id);
      if (existing === undefined) {
        actionsById.set(action.id, action);
        return;
      }
      actionsById.set(action.id, {
        ...existing,
        modelRefs: [...new Set([...existing.modelRefs, ...action.modelRefs])],
      } as ProviderSetupAction);
    };

    if (ref.sdk === "claude") {
      if (authAlreadyDetected(["claude", refKey])) {
        detectedModelRefs.add(refKey);
        continue;
      }
      add({
        id: "claude-login",
        kind: "auth",
        label: "Claude login",
        modelRefs: [refKey],
        command: ["claude", "/login"],
        cwd: options.cwd,
        detail: "Runs the Claude Code login flow for Claude model references.",
      });
      continue;
    }

    if (ref.sdk === "codex") {
      if (authAlreadyDetected(["codex", refKey])) {
        detectedModelRefs.add(refKey);
        continue;
      }
      const authMode = options.codexAuthMode ?? "browser";
      add({
        id: "codex-login",
        kind: "auth",
        label: "Codex login",
        modelRefs: [refKey],
        command: authMode === "device" ? ["codex", "login", "--device-auth"] : ["codex", "login"],
        authMode,
        cwd: options.cwd,
        detail: authMode === "device"
          ? "Runs Codex device-code login for a remote or headless machine."
          : "Runs Codex browser login with a localhost callback server.",
      });
      continue;
    }

    if (ref.sdk !== "pi" || typeof ref.provider !== "string") {
      continue;
    }

    if (authAlreadyDetected([`pi:${ref.provider}`, ref.provider, refKey])) {
      detectedModelRefs.add(refKey);
      continue;
    }

    if (ref.provider === "ollama") {
      add({
        id: "ollama-list",
        kind: "preflight",
        label: "Ollama model preflight",
        modelRefs: [refKey],
        command: ["ollama", "list"],
        cwd: options.cwd,
        detail: "Checks that the local Ollama server and CLI can list installed models.",
      });
      continue;
    }

    if (ref.provider === "lmstudio") {
      add({
        id: "lmstudio-models",
        kind: "preflight",
        label: "LM Studio model preflight",
        modelRefs: [refKey],
        url: "http://localhost:1234/v1/models",
        cwd: options.cwd,
        detail: "Checks that LM Studio's OpenAI-compatible local server exposes models.",
      });
      continue;
    }

    const provider = piProviders.getProvider(ref.provider);
    const supportsOAuth = piOAuthProviders.has(ref.provider);
    const supportsApiKeyLogin = typeof provider?.auth.apiKey?.login === "function";
    const selectedMethod = options.piAuthMethods?.[ref.provider]
      ?? (supportsOAuth ? "oauth" : supportsApiKeyLogin ? "api-key" : undefined);

    if (selectedMethod === "api-key" && supportsApiKeyLogin) {
      const envVar = PI_API_KEY_PROVIDERS[ref.provider];
      // Complex or ambient providers may require multiple values. Never invent
      // an environment name or persist an incomplete credential; their normal
      // provider environment remains available as the explicit manual path.
      if (envVar === undefined) continue;
      const persistence = options.piApiKeyPersistenceByProvider?.[ref.provider]
        ?? options.piApiKeyPersistence
        ?? "secure-store";
      add({
        id: `pi-api-key:${ref.provider}`,
        kind: "auth",
        label: `${provider?.auth.apiKey?.name ?? ref.provider} (${persistence === "secure-store" ? "secure store" : "environment"})`,
        modelRefs: [refKey],
        provider: ref.provider,
        envVar,
        persistence,
        piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
        cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
        detail: persistence === "secure-store"
          ? `Stores ${envVar} in the owner-only Pi auth store used by providers.piAuthPath.`
          : `Uses ${envVar} from the durable agent environment without copying it into Pi auth.json.`,
      });
      continue;
    }

    if (selectedMethod !== "oauth" || !supportsOAuth) {
      continue;
    }

    add({
      id: `pi-login:${ref.provider}`,
      kind: "auth",
      label: `Pi login for ${ref.provider}`,
      modelRefs: [refKey],
      command: piLoginCommand(ref.provider, options.piCliPath),
      piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
      cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
      detail: `Runs bundled Pi auth for provider \`${ref.provider}\` and securely replaces providers.piAuthPath.`,
    });
  }

  return { actions: [...actionsById.values()], detectedModelRefs: [...detectedModelRefs] };
}

export function providerSetupActionCommandLine(action: ProviderSetupAction): string {
  if ("command" in action) {
    if (isProviderSetupPiLoginAction(action)) {
      return piAuthRecoveryCommand(action.id.slice("pi-login:".length), action.piAuthPath);
    }
    return action.command.map(shellQuote).join(" ");
  }
  if (isProviderSetupPiApiKeyAction(action)) {
    return `${action.envVar} -> ${action.piAuthPath}`;
  }
  return `GET ${action.url}`;
}

export function isProviderSetupPiApiKeyAction(action: ProviderSetupAction): action is ProviderSetupPiApiKeyAction {
  return "provider" in action && "piAuthPath" in action && "envVar" in action;
}

export function isProviderSetupPiLoginAction(action: ProviderSetupAction): action is ProviderSetupPiLoginAction {
  return action.id.startsWith("pi-login:") && "piAuthPath" in action && "command" in action;
}

export async function executeProviderSetupPlan(
  plan: ProviderSetupPlan,
  options: ExecuteProviderSetupOptions = {},
): Promise<ProviderSetupResult[]> {
  const preflightTimeoutMs = positivePreflightTimeout(options.preflightTimeoutMs);
  const results: ProviderSetupResult[] = [];
  for (const action of plan.actions) {
    if (options.abortSignal?.aborted === true) break;
    const result = isProviderSetupPiApiKeyAction(action)
      ? await runPiApiKeyAction(action, options.apiKeys ?? {}, options.platform ?? process.platform, options)
      : "command" in action
      ? await runCommandAction(
          action,
          options.spawn ?? spawn,
          options.platform ?? process.platform,
          options,
          preflightTimeoutMs,
          options.abortSignal,
        )
      : await runHttpAction(action, options.fetch ?? fetch, preflightTimeoutMs, options.abortSignal);
    results.push(result);
    if (result.failureKind !== undefined) break;
  }
  return results;
}

async function runPiApiKeyAction(
  action: ProviderSetupPiApiKeyAction,
  apiKeys: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
): Promise<ProviderSetupResult> {
  // Secure-store is an explicit mutation and therefore consumes only a value
  // intentionally handed to this action. Merely exporting an environment
  // variable must never cause mono-agent to copy it into auth.json.
  const raw = apiKeys[action.id]
    ?? apiKeys[action.provider]
    ?? (action.persistence === "environment" ? process.env[action.envVar] : undefined);
  const key = raw?.trim();
  if (key === undefined || key.length === 0) {
    return {
      action,
      status: "skipped",
      detail: `${action.envVar} was not provided; skipped saving credentials for ${action.provider}.`,
    };
  }

  if (action.persistence === "environment") {
    return {
      action,
      status: "ok",
      detail: `${action.envVar} is available in the durable environment; the value was not copied into Pi auth.json.`,
    };
  }

  try {
    assertOwnerOnlyPersistenceSupported(platform);
    await withPiAuthFileLock(action.piAuthPath, async (authPath, ownerUid, assertLockHeld) => {
      const original = await readPiAuthStore(authPath, piAuthSingleLinkPolicy(ownerUid));
      const next = {
        ...original.auth,
        [action.provider]: { type: "api_key", key },
      };
      await writePiAuthStoreAtomically(authPath, next, original, ownerUid, assertLockHeld, hooks);
    }, hooks);
    return {
      action,
      status: "ok",
      detail: `Saved API key credentials for ${action.provider} to the Pi auth store.`,
    };
  } catch (error) {
    return {
      action,
      status: "failed",
      ...(error instanceof PiAuthCleanupError ? { failureKind: "cleanup_failed" as const } : {}),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function isBoundedCredentialString(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_API_KEY_CREDENTIAL_STRING_LENGTH
    && !value.includes("\0");
}

function isUsableStoredPiCredential(_provider: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "oauth") {
    return isBoundedCredentialString(value.access) || isBoundedCredentialString(value.refresh);
  }
  return value.type === "api_key" && isBoundedCredentialString(value.key);
}

async function runCommandAction(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
  preflightTimeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  if (isProviderSetupPiLoginAction(action)) {
    return await runPiLoginAction(action, spawnImpl, platform, hooks, abortSignal);
  }
  return await runSpawnedCommand(action, spawnImpl, action.cwd, preflightTimeoutMs, abortSignal);
}

async function runPiLoginAction(
  action: ProviderSetupPiLoginAction,
  spawnImpl: typeof spawn,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  let dominantFailure: ProviderSetupResult | undefined;
  let cleanupError: unknown;
  let stagingPath: string | undefined;
  let stagingCleanupCompleted = false;
  let piTaskCompleted = false;
  try {
    assertOwnerOnlyPersistenceSupported(platform);
    return await withPiAuthFileLock(action.piAuthPath, async (authPath, ownerUid, assertLockHeld) => {
      let stagingDir: string | undefined;
      let operationError: unknown;
      try {
        const original = await readPiAuthStore(authPath, piAuthSingleLinkPolicy(ownerUid));
        stagingDir = await mkdtemp(join(dirname(authPath), ".mono-agent-pi-auth-"));
        stagingPath = stagingDir;
        const stagedAuthPath = join(stagingDir, "auth.json");
        if (original.exists) {
          await writeFile(stagedAuthPath, original.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
        const result = await runSpawnedCommand(
          action,
          spawnImpl,
          stagingDir,
          DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS,
          abortSignal,
        );
        if (result.status !== "ok") {
          dominantFailure = result;
          piTaskCompleted = true;
          return result;
        }

        const staged = await readPiAuthStore(stagedAuthPath, piAuthSingleLinkPolicy(ownerUid));
        if (!staged.exists) {
          throw new Error("Bundled Pi login exited successfully without producing auth.json; the configured store was not changed.");
        }
        const provider = action.id.slice("pi-login:".length);
        assertOAuthCredential(staged.auth[provider], provider);
        assertUnchangedSiblingCredentials(original.auth, staged.auth, provider);
        await assertPiAuthStoreUnchanged(authPath, original, ownerUid);
        await chmod(stagedAuthPath, 0o600);
        await syncFile(stagedAuthPath);
        const hardenedStaged = await readPiAuthStore(stagedAuthPath, piAuthSingleLinkPolicy(ownerUid));
        if (
          !hardenedStaged.exists ||
          hardenedStaged.dev !== staged.dev ||
          hardenedStaged.ino !== staged.ino ||
          hardenedStaged.contents !== staged.contents ||
          ((hardenedStaged.mode ?? 0) & 0o777) !== 0o600
        ) {
          throw new Error("Bundled Pi login output changed while owner-only permissions were applied; the configured store was not changed.");
        }
        await promotePiAuthStoreWithoutClobber(
          stagedAuthPath,
          authPath,
          original,
          ownerUid,
          assertLockHeld,
          hardenedStaged,
          hooks,
        );
        piTaskCompleted = true;
        try {
          await hooks.beforePiAuthPostMutationSync?.(authPath);
          await syncDirectory(dirname(authPath));
        } catch (error) {
          throw new PiAuthCleanupError(
            authPath,
            `credentials were installed but parent-directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return {
          action,
          status: "ok",
          detail: `${providerSetupActionCommandLine(action)} saved credentials to ${action.piAuthPath}.`,
        };
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        if (stagingDir !== undefined) {
          try {
            await hooks.beforePiAuthCleanup?.(stagingDir);
            await rm(stagingDir, { recursive: true, force: true });
            stagingCleanupCompleted = true;
          } catch (error) {
            const stagingCleanupError = new PiAuthCleanupError(
              stagingDir,
              `the credential-bearing OAuth staging directory could not be removed: ${error instanceof Error ? error.message : String(error)}`,
            );
            cleanupError = stagingCleanupError;
            throw combinePiAuthCleanupError(operationError, stagingCleanupError);
          }
        }
      }
    }, hooks);
  } catch (error) {
    if (dominantFailure?.failureKind === "child_exit_unconfirmed") {
      return {
        ...dominantFailure,
        detail: `${dominantFailure.detail} Cleanup also failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (cleanupError !== undefined || piTaskCompleted || error instanceof PiAuthCleanupError) {
      const cleanupPath = error instanceof PiAuthCleanupError
        ? error.path
        : !stagingCleanupCompleted && stagingPath !== undefined
          ? stagingPath
          : `${action.piAuthPath}.mono-agent.lock`;
      return {
        action,
        status: "failed",
        failureKind: "cleanup_failed",
        detail:
          `${dominantFailure?.detail === undefined ? "Provider authentication stopped." : dominantFailure.detail} ` +
          `Temporary credential cleanup for ${cleanupPath} failed: ${error instanceof Error ? error.message : String(error)} ` +
          "Inspect and remove the residue manually before retrying authentication.",
      };
    }
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

interface PiAuthStoreSnapshot {
  readonly exists: boolean;
  readonly contents: string;
  readonly auth: Readonly<Record<string, unknown>>;
  readonly dev?: number;
  readonly ino?: number;
  readonly uid?: number;
  readonly nlink?: number;
  readonly mode?: number;
  readonly size?: number;
}

interface PiAuthStoreReadPolicy {
  readonly ownerUid: number;
  readonly allowedLinkCounts: readonly number[];
}

interface PiAuthLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly ownerUid: number;
  readonly dev: number;
  readonly ino: number;
  readonly token: string;
  readonly contents: Buffer;
}

class PiAuthCleanupError extends Error {
  readonly paths: readonly string[];
  readonly path: string;
  readonly detail: string;

  constructor(path: string | readonly string[], detail: string) {
    const paths = [...new Set(typeof path === "string" ? [path] : path)];
    const primaryPath = paths[0] ?? "unknown credential artifact";
    super(`Pi credential${paths.length === 1 && primaryPath.endsWith(".mono-agent.lock") ? " lock" : ""} cleanup for ${paths.join(", ")} is uncertain: ${detail}`);
    this.name = "PiAuthCleanupError";
    this.paths = paths;
    this.path = primaryPath;
    this.detail = detail;
  }
}

function combinePiAuthCleanupError(
  earlier: unknown,
  cleanup: PiAuthCleanupError,
): PiAuthCleanupError {
  if (earlier instanceof PiAuthCleanupError) {
    return new PiAuthCleanupError(
      [...earlier.paths, ...cleanup.paths],
      `${earlier.detail}; additionally, ${cleanup.detail}`,
    );
  }
  if (earlier === undefined) return cleanup;
  return new PiAuthCleanupError(
    cleanup.paths,
    `${cleanup.detail}; the preceding provider operation also failed: ${earlier instanceof Error ? earlier.message : String(earlier)}`,
  );
}

type AssertPiAuthLockHeld = () => Promise<void>;

function assertOwnerOnlyPersistenceSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "Automatic Pi credential persistence is unavailable because owner-only file permissions cannot be verified on Windows. Complete authentication manually and rerun validation.",
    );
  }
}

async function withPiAuthFileLock<T>(
  authPath: string,
  task: (
    canonicalAuthPath: string,
    ownerUid: number,
    assertLockHeld: AssertPiAuthLockHeld,
  ) => Promise<T>,
  hooks: PiAuthPromotionHooks = {},
  staleRepairAttempted = false,
): Promise<T> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(dirname(authPath));
  const ownerUid = currentProcessUidForPi(canonicalParent);
  await assertSafePiAuthParent(canonicalParent, ownerUid);
  const canonicalAuthPath = join(canonicalParent, basename(authPath));
  await assertPiAuthPathOutsideGitWorktree(canonicalAuthPath);
  const lockPath = `${canonicalAuthPath}.mono-agent.lock`;
  const token = randomUUID();
  const contents = Buffer.from(`${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerUid,
    token,
  })}\n`, "utf8");
  let handle: FileHandle | undefined;
  let identity: Pick<PiAuthLock, "dev" | "ino" | "ownerUid"> | undefined;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const initialStat = await handle.stat();
    identity = { dev: initialStat.dev, ino: initialStat.ino, ownerUid };
    assertPiAuthLockStat(lockPath, initialStat, ownerUid);
    await handle.writeFile(contents);
    await handle.sync();
    const writtenStat = await handle.stat();
    assertPiAuthLockStat(lockPath, writtenStat, ownerUid);
    if (
      writtenStat.dev !== initialStat.dev ||
      writtenStat.ino !== initialStat.ino ||
      writtenStat.size !== contents.length
    ) {
      throw new Error(`Pi credential lock ${lockPath} changed while its owner record was written.`);
    }
    await syncDirectory(canonicalParent);
    await hooks.afterPiAuthLockCreated?.(lockPath);
  } catch (error) {
    let rollbackError: unknown;
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        rollbackError = new PiAuthCleanupError(
          lockPath,
          `the failed lock-creation handle could not be confirmed closed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
      }
      if (identity !== undefined) {
        try {
          await removePiAuthLockIfIdentity(lockPath, identity, hooks);
        } catch (removeError) {
          rollbackError ??= removeError;
        }
      } else {
        rollbackError ??= new PiAuthCleanupError(
          lockPath,
          "the failed lock-creation artifact could not be identified for safe removal",
        );
      }
    }
    if (rollbackError !== undefined) {
      throw combinePiAuthCleanupError(
        error,
        rollbackError instanceof PiAuthCleanupError
          ? rollbackError
          : new PiAuthCleanupError(lockPath, String(rollbackError)),
      );
    }
    if (isAlreadyExistsError(error)) {
      if (!staleRepairAttempted) {
        const repair = await repairStalePiAuthLock(lockPath, ownerUid, {
          ...(hooks.beforeStalePiAuthLockRemoval === undefined
            ? {}
            : { beforeRemoval: hooks.beforeStalePiAuthLockRemoval }),
          ...(hooks.afterStalePiAuthLockRemoval === undefined
            ? {}
            : { afterRemoval: hooks.afterStalePiAuthLockRemoval }),
        });
        if (repair === "removed") {
          return await withPiAuthFileLock(authPath, task, hooks, true);
        }
        if (repair === "active") {
          throw new Error(`Pi credential lock ${lockPath} already exists and belongs to an active authentication process. Wait for it to finish, then retry.`);
        }
      }
      throw new Error(
        `Pi credential lock ${lockPath} already exists and could not be proven stale. It was left untouched; inspect its owner and retry after the active authentication exits.`,
      );
    }
    throw error;
  }
  if (handle === undefined || identity === undefined) {
    throw new Error(`Pi credential lock ${lockPath} could not be established.`);
  }
  const lock: PiAuthLock = {
    path: lockPath,
    handle,
    ownerUid,
    dev: identity.dev,
    ino: identity.ino,
    token,
    contents,
  };
  let taskError: unknown;
  try {
    return await task(canonicalAuthPath, ownerUid, () => assertPiAuthLockHeld(lock));
  } catch (error) {
    taskError = error;
    throw error;
  } finally {
    let lifecycleError: PiAuthCleanupError | undefined;
    try {
      await lock.handle.close();
    } catch (error) {
      lifecycleError = new PiAuthCleanupError(
        lock.path,
        `the lock handle could not be confirmed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await releasePiAuthLock(lock, hooks);
    } catch (error) {
      const releaseError = error instanceof PiAuthCleanupError
        ? error
        : new PiAuthCleanupError(lock.path, error instanceof Error ? error.message : String(error));
      lifecycleError = combinePiAuthCleanupError(lifecycleError, releaseError);
    }
    if (lifecycleError !== undefined) {
      throw combinePiAuthCleanupError(taskError, lifecycleError);
    }
  }
}

function currentProcessUidForPi(path: string): number {
  if (typeof process.getuid !== "function") {
    throw new Error(`Automatic Pi credential persistence cannot verify the current user for ${path}.`);
  }
  return process.getuid();
}

async function assertSafePiAuthParent(path: string, ownerUid: number): Promise<void> {
  const pathStat = await lstat(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const handleStat = await handle.stat();
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !handleStat.isDirectory() ||
      pathStat.dev !== handleStat.dev ||
      pathStat.ino !== handleStat.ino ||
      handleStat.uid !== ownerUid ||
      (handleStat.mode & 0o022) !== 0
    ) {
      throw new Error(
        `Refusing automatic Pi credential persistence because parent directory ${path} must be owned by the current user and not group/world-writable.`,
      );
    }
  } finally {
    await handle?.close();
  }
}

function assertPiAuthLockStat(path: string, value: Stats, ownerUid: number): void {
  if (
    !value.isFile() ||
    value.uid !== ownerUid ||
    (value.mode & 0o777) !== 0o600 ||
    value.nlink !== 1
  ) {
    throw new Error(
      `Refusing to use Pi credential lock ${path} because it is not a current-user, owner-only regular file with one link.`,
    );
  }
}

async function readPiAuthLockPath(
  path: string,
  ownerUid: number,
): Promise<{ readonly dev: number; readonly ino: number; readonly contents: Buffer } | undefined> {
  let pathStat: Stats;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  assertPiAuthLockStat(path, pathStat, ownerUid);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const handleStat = await handle.stat();
    assertPiAuthLockStat(path, handleStat, ownerUid);
    if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
      throw new Error(`Pi credential lock ${path} changed identity while it was opened.`);
    }
    const contents = await handle.readFile();
    if (contents.length !== handleStat.size) {
      throw new Error(`Pi credential lock ${path} changed while its contents were read.`);
    }
    if (contents.length > 4096) {
      throw new Error(`Pi credential lock ${path} exceeds the 4096-byte safety limit.`);
    }
    return { dev: handleStat.dev, ino: handleStat.ino, contents };
  } finally {
    await handle?.close();
  }
}

interface StalePiAuthLockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly ownerUid: number;
  readonly token: string;
}

export type StalePiAuthLockRepairResult = "removed" | "active" | "unverifiable";

/**
 * Remove only a secure, identity-stable lock whose recorded process is proven
 * gone with ESRCH. Active, EPERM, malformed and racing locks are untouched.
 *
 * @internal Exported as a narrow deterministic test seam.
 */
export async function repairStalePiAuthLock(
  path: string,
  ownerUid: number,
  options: {
    readonly kill?: (pid: number, signal: 0) => true;
    readonly beforeRemoval?: (lockPath: string) => void | Promise<void>;
    readonly afterRemoval?: (lockPath: string) => void | Promise<void>;
  } = {},
): Promise<StalePiAuthLockRepairResult> {
  const kill = options.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  let initial;
  try {
    initial = await readPiAuthLockPath(path, ownerUid);
  } catch {
    return "unverifiable";
  }
  if (initial === undefined) return "unverifiable";
  const record = parseStalePiAuthLockRecord(initial.contents, ownerUid);
  if (record === undefined) return "unverifiable";
  const liveness = piLockProcessLiveness(record.pid, kill);
  if (liveness !== "stale") return liveness;

  await options.beforeRemoval?.(path);

  let current;
  try {
    current = await readPiAuthLockPath(path, ownerUid);
  } catch {
    return "unverifiable";
  }
  if (
    current === undefined
    || current.dev !== initial.dev
    || current.ino !== initial.ino
    || !current.contents.equals(initial.contents)
  ) {
    return "unverifiable";
  }
  const currentRecord = parseStalePiAuthLockRecord(current.contents, ownerUid);
  if (
    currentRecord === undefined
    || currentRecord.pid !== record.pid
    || currentRecord.token !== record.token
    || piLockProcessLiveness(currentRecord.pid, kill) !== "stale"
  ) {
    return "unverifiable";
  }
  try {
    await rm(path);
  } catch {
    return "unverifiable";
  }
  try {
    await options.afterRemoval?.(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new PiAuthCleanupError(
      path,
      `the proven-stale lock was removed but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return "removed";
}

function parseStalePiAuthLockRecord(contents: Buffer, ownerUid: number): StalePiAuthLockRecord | undefined {
  if (contents.length === 0 || contents.length > 4096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || value.ownerUid !== ownerUid
    || typeof value.token !== "string"
    || value.token.length < 8
    || value.token.length > 200
  ) {
    return undefined;
  }
  return {
    version: 1,
    pid: value.pid as number,
    ownerUid,
    token: value.token,
  };
}

function piLockProcessLiveness(
  pid: number,
  kill: (pid: number, signal: 0) => true,
): "active" | "stale" | "unverifiable" {
  try {
    kill(pid, 0);
    return "active";
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ESRCH") return "stale";
    if (code === "EPERM") return "active";
    return "unverifiable";
  }
}

async function assertPiAuthLockHeld(lock: PiAuthLock): Promise<void> {
  const handleStat = await lock.handle.stat();
  assertPiAuthLockStat(lock.path, handleStat, lock.ownerUid);
  const current = await readPiAuthLockPath(lock.path, lock.ownerUid);
  if (
    current === undefined ||
    handleStat.dev !== lock.dev ||
    handleStat.ino !== lock.ino ||
    current.dev !== lock.dev ||
    current.ino !== lock.ino ||
    !current.contents.equals(lock.contents)
  ) {
    throw new Error(
      `Pi credential lock ${lock.path} changed during credential setup; its replacement was left untouched.`,
    );
  }
}

async function releasePiAuthLock(lock: PiAuthLock, hooks: PiAuthPromotionHooks): Promise<void> {
  let current;
  try {
    current = await readPiAuthLockPath(lock.path, lock.ownerUid);
  } catch (error) {
    throw new PiAuthCleanupError(
      lock.path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (current === undefined) {
    await confirmMissingPiAuthLockDurable(lock.path, hooks);
    return;
  }
  if (
    current.dev !== lock.dev ||
    current.ino !== lock.ino ||
    !current.contents.equals(lock.contents)
  ) {
    throw new PiAuthCleanupError(
      lock.path,
      "the lock identity changed; its replacement was left untouched",
    );
  }
  try {
    await rm(lock.path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new PiAuthCleanupError(
        lock.path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    await syncDirectory(dirname(lock.path));
  } catch (error) {
    throw new PiAuthCleanupError(
      lock.path,
      `the lock was removed but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function removePiAuthLockIfIdentity(
  path: string,
  expected: Pick<PiAuthLock, "dev" | "ino" | "ownerUid">,
  hooks: PiAuthPromotionHooks,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      await confirmMissingPiAuthLockDurable(path, hooks);
      return;
    }
    throw new PiAuthCleanupError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !current.isFile() ||
    current.uid !== expected.ownerUid ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600
  ) {
    throw new PiAuthCleanupError(
      path,
      "the failed lock-creation artifact changed identity; its replacement was left untouched",
    );
  }
  try {
    await rm(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new PiAuthCleanupError(
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new PiAuthCleanupError(
      path,
      `the failed lock-creation artifact was removed but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function confirmMissingPiAuthLockDurable(
  path: string,
  hooks: PiAuthPromotionHooks,
): Promise<void> {
  try {
    await hooks.beforePiAuthMissingLockSync?.(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new PiAuthCleanupError(
      path,
      `the lock path is absent but parent-directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readPiAuthStore(
  path: string,
  policy: PiAuthStoreReadPolicy,
): Promise<PiAuthStoreSnapshot> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, contents: "", auth: {} };
    }
    if (isSymlinkOpenError(error)) {
      throw new Error(`Refusing to use Pi auth path ${path} because the final path is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    assertPiAuthStoreStat(path, fileStat, policy);
    const contents = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Unable to parse Pi auth file ${path}; the original file was left unchanged.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Pi auth file ${path} must contain a JSON object; the original file was left unchanged.`);
    }
    const pathStat = await lstat(path);
    assertPiAuthStoreStat(path, pathStat, policy);
    if (pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino) {
      throw new Error(`Pi auth file ${path} changed while it was being read; the newer path was preserved.`);
    }
    return {
      exists: true,
      contents,
      auth: parsed as Record<string, unknown>,
      dev: fileStat.dev,
      ino: fileStat.ino,
      uid: fileStat.uid,
      nlink: fileStat.nlink,
      mode: fileStat.mode,
      size: fileStat.size,
    };
  } finally {
    await handle.close();
  }
}

function assertPiAuthStoreStat(
  path: string,
  value: Stats,
  policy: PiAuthStoreReadPolicy,
): void {
  if (!value.isFile()) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is not a regular file.`);
  }
  if (value.uid !== policy.ownerUid) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is not owned by the current user.`);
  }
  if ((value.mode & 0o022) !== 0) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is writable by another user.`);
  }
  if (!policy.allowedLinkCounts.includes(value.nlink)) {
    throw new Error(`Refusing to use Pi auth path ${path} because its hard-link identity is unsafe.`);
  }
}

async function writePiAuthStoreAtomically(
  path: string,
  auth: Readonly<Record<string, unknown>>,
  original: PiAuthStoreSnapshot,
  ownerUid: number,
  assertLockHeld: AssertPiAuthLockHeld,
  hooks: PiAuthPromotionHooks,
): Promise<void> {
  await assertPiAuthStoreUnchanged(path, original, ownerUid);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(dir, ".mono-agent-pi-auth-write-"));
  const tempPath = join(tempDir, "auth.json");
  let promotionInstalled = false;
  let operationError: unknown;
  try {
    await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await syncFile(tempPath);
    await assertPiAuthStoreUnchanged(path, original, ownerUid);
    await promotePiAuthStoreWithoutClobber(
      tempPath,
      path,
      original,
      ownerUid,
      assertLockHeld,
      undefined,
      hooks,
    );
    promotionInstalled = true;
    try {
      await hooks.beforePiAuthPostMutationSync?.(path);
      await syncDirectory(dir);
    } catch (error) {
      throw new PiAuthCleanupError(
        path,
        `credentials were installed but parent-directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await hooks.beforePiAuthTempCleanup?.(tempDir);
      await rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      throw combinePiAuthCleanupError(operationError, new PiAuthCleanupError(
        tempDir,
        `${promotionInstalled ? "credentials were installed, and " : ""}the credential-bearing transaction directory could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }
}

async function assertPiAuthStoreUnchanged(
  path: string,
  original: PiAuthStoreSnapshot,
  ownerUid: number,
): Promise<void> {
  const current = await readPiAuthStore(path, piAuthSingleLinkPolicy(ownerUid));
  if (!samePiAuthStoreSnapshot(current, original)) {
    throw new Error(`Pi auth file ${path} changed during credential setup; the newer file was preserved.`);
  }
}

function samePiAuthStoreSnapshot(left: PiAuthStoreSnapshot, right: PiAuthStoreSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.contents === right.contents;
}

async function promotePiAuthStoreWithoutClobber(
  stagedPath: string,
  targetPath: string,
  expected: PiAuthStoreSnapshot,
  ownerUid: number,
  assertLockHeld: AssertPiAuthLockHeld,
  intendedInput?: PiAuthStoreSnapshot,
  hooks: PiAuthPromotionHooks = {},
): Promise<void> {
  const intended = intendedInput ?? await readPiAuthStore(stagedPath, piAuthSingleLinkPolicy(ownerUid));
  if (!intended.exists) {
    throw new Error(`Pi auth staging file ${stagedPath} disappeared before promotion.`);
  }
  if (!expected.exists) {
    let installed = false;
    try {
      await hooks.beforePiAuthPromotion?.(targetPath, stagedPath);
      await assertLockHeld();
      installed = await linkPiFileIfAbsent(stagedPath, targetPath);
      if (!installed) {
        throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
      }
      await hooks.afterPiAuthLink?.(targetPath, stagedPath);
      await assertPromotedPiAuthStore(intended, stagedPath, targetPath, ownerUid);
      return;
    } catch (error) {
      if (installed && !(error instanceof PiAuthCleanupError)) {
        throw new PiAuthCleanupError(
          targetPath,
          `new credentials were linked but their final state could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.mono-agent-${randomUUID()}.backup`);
  let preserveConcurrentBackup = true;
  let backupCreated = false;
  let targetMutationStarted = false;
  let promotionError: unknown;
  try {
    await hooks.beforePiAuthPromotion?.(targetPath, stagedPath);
    await assertLockHeld();
    try {
      await rename(targetPath, backupPath);
      backupCreated = true;
      targetMutationStarted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
      }
      throw error;
    }

    let moved: PiAuthStoreSnapshot;
    try {
      moved = await readPiAuthStore(backupPath, piAuthSingleLinkPolicy(ownerUid));
    } catch {
      if (await linkPiFileIfAbsent(backupPath, targetPath)) {
        await rm(backupPath, { force: true });
        preserveConcurrentBackup = false;
      } else {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      }
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    if (!samePiAuthStoreSnapshotAfterMove(moved, expected)) {
      if (await linkPiFileIfAbsent(backupPath, targetPath)) {
        await rm(backupPath, { force: true });
        preserveConcurrentBackup = false;
      } else {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      }
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }

    if (!await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid)) {
      try {
        if (await linkPiFileIfAbsent(backupPath, targetPath)) {
          preserveConcurrentBackup = false;
        } else {
          await tightenPiFileOwnerOnlyBestEffort(backupPath);
        }
      } catch {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
        throw new Error(`Pi auth promotion failed; credentials were retained at ${backupPath}.`);
      }
      throw new Error(preserveConcurrentBackup
        ? `Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`
        : `Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }

    let installed: boolean;
    try {
      installed = await linkPiFileIfAbsent(stagedPath, targetPath);
    } catch {
      await tightenPiFileOwnerOnlyBestEffort(backupPath);
      throw new Error(`Pi auth promotion failed; the original credentials were retained at ${backupPath}.`);
    }
    if (!installed) {
      preserveConcurrentBackup = false;
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    try {
      await hooks.afterPiAuthLink?.(targetPath, stagedPath);
      await assertPromotedPiAuthStore(intended, stagedPath, targetPath, ownerUid);
    } catch {
      const backupStillExpected = await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid);
      try {
        const restored = await linkPiFileIfAbsent(backupPath, targetPath);
        if (restored || backupStillExpected) {
          preserveConcurrentBackup = false;
        } else {
          await tightenPiFileOwnerOnlyBestEffort(backupPath);
        }
      } catch {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
        throw new Error(`Pi auth promotion failed; credentials were retained at ${backupPath}.`);
      }
      throw new Error(preserveConcurrentBackup
        ? `Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`
        : `Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    if (!await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid)) {
      await tightenPiFileOwnerOnlyBestEffort(backupPath);
      throw new Error(`Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`);
    }
    preserveConcurrentBackup = false;
  } catch (error) {
    promotionError = targetMutationStarted && !(error instanceof PiAuthCleanupError)
      ? new PiAuthCleanupError(
        preserveConcurrentBackup ? backupPath : targetPath,
        `credential promotion changed filesystem state but did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`,
      )
      : error;
    throw promotionError;
  } finally {
    if (backupCreated && preserveConcurrentBackup) {
      try {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      } catch {
        // The fatal result below remains authoritative and names the residue.
      }
      throw combinePiAuthCleanupError(promotionError, new PiAuthCleanupError(
        backupPath,
        `concurrent credentials were retained at ${backupPath} for manual recovery`,
      ));
    }
    if (backupCreated) {
      try {
        await hooks.beforePiAuthBackupCleanup?.(backupPath);
        await rm(backupPath, { force: true });
      } catch (error) {
        throw combinePiAuthCleanupError(promotionError, new PiAuthCleanupError(
          backupPath,
          `credential backup could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }
}

async function claimedPiAuthBackupStillMatches(
  backupPath: string,
  expected: PiAuthStoreSnapshot,
  ownerUid: number,
): Promise<boolean> {
  try {
    const current = await readPiAuthStore(backupPath, piAuthSingleLinkPolicy(ownerUid));
    return samePiAuthStoreSnapshotAfterMove(current, expected);
  } catch {
    return false;
  }
}

function samePiAuthStoreSnapshotAfterMove(
  current: PiAuthStoreSnapshot,
  expected: PiAuthStoreSnapshot,
): boolean {
  return current.exists && expected.exists &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.uid === expected.uid &&
    current.nlink === expected.nlink &&
    current.mode === expected.mode &&
    current.size === expected.size &&
    current.contents === expected.contents;
}

async function linkPiFileIfAbsent(source: string, target: string): Promise<boolean> {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function assertPromotedPiAuthStore(
  intended: PiAuthStoreSnapshot,
  stagedPath: string,
  targetPath: string,
  ownerUid: number,
): Promise<void> {
  // Exclusive-link installation deliberately gives the same inode two names
  // until the private staging directory is removed. Exactly two links prove
  // that no third alias can retain or mutate credential bytes after cleanup.
  const twoLinkPolicy: PiAuthStoreReadPolicy = { ownerUid, allowedLinkCounts: [2] };
  const staged = await readPiAuthStore(stagedPath, twoLinkPolicy);
  const promoted = await readPiAuthStore(targetPath, twoLinkPolicy);
  if (
    !intended.exists ||
    !staged.exists ||
    !promoted.exists ||
    intended.uid !== ownerUid ||
    intended.nlink !== 1 ||
    staged.dev !== intended.dev ||
    staged.ino !== intended.ino ||
    promoted.dev !== intended.dev ||
    promoted.ino !== intended.ino ||
    staged.contents !== intended.contents ||
    intended.contents !== promoted.contents ||
    ((promoted.mode ?? 0) & 0o777) !== 0o600
  ) {
    throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
  }
}

function piAuthSingleLinkPolicy(ownerUid: number): PiAuthStoreReadPolicy {
  return { ownerUid, allowedLinkCounts: [1] };
}

async function tightenPiFileOwnerOnlyBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if ((await handle.stat()).isFile()) await handle.chmod(0o600);
  } catch {
    // Preserve recovery bytes even if their metadata cannot be tightened.
  } finally {
    await handle?.close();
  }
}

async function assertPiAuthPathOutsideGitWorktree(path: string): Promise<void> {
  const result = await runGitForPi(["-C", dirname(path), "rev-parse", "--show-toplevel"]);
  if (result.ok) {
    throw new Error(
      `Refusing automatic Pi credential persistence inside Git worktree ${result.stdout.trim()}. Choose providers.piAuthPath outside the repository.`,
    );
  }
  if (await hasGitMetadataForPi(dirname(path))) {
    throw new Error(`Cannot prove Git safety for Pi auth path ${path}; choose a credential path outside the repository.`);
  }
}

function runGitForPi(args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { encoding: "utf8" }, (error, stdout) => {
      resolveResult({ ok: error === null, stdout });
    });
  });
}

async function hasGitMetadataForPi(start: string): Promise<boolean> {
  let current = resolve(start);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertOAuthCredential(value: unknown, provider: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Bundled Pi login did not produce credentials for ${provider}; the configured store was not changed.`);
  }
  const credential = value as Record<string, unknown>;
  const access = typeof credential.access === "string" ? credential.access.trim() : "";
  const refresh = typeof credential.refresh === "string" ? credential.refresh.trim() : "";
  if (credential.type !== "oauth" || (access.length === 0 && refresh.length === 0)) {
    throw new Error(`Bundled Pi login produced invalid OAuth credentials for ${provider}; the configured store was not changed.`);
  }
}

function assertUnchangedSiblingCredentials(
  original: Readonly<Record<string, unknown>>,
  staged: Readonly<Record<string, unknown>>,
  provider: string,
): void {
  for (const [name, credential] of Object.entries(original)) {
    if (name !== provider && !isDeepStrictEqual(staged[name], credential)) {
      throw new Error(`Bundled Pi login unexpectedly changed sibling provider ${name}; the configured store was not changed.`);
    }
  }
  for (const name of Object.keys(staged)) {
    if (name !== provider && !Object.hasOwn(original, name)) {
      throw new Error(`Bundled Pi login unexpectedly added sibling provider ${name}; the configured store was not changed.`);
    }
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymlinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runSpawnedCommand(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  cwd: string,
  preflightTimeoutMs = DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  const [file, ...args] = action.command;
  return new Promise((resolve) => {
    const child = spawnImpl(file, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let killSettlementTimer: NodeJS.Timeout | undefined;
    let childError: Error | undefined;
    let terminationResult: ProviderSetupResult | undefined;
    const interruptedDetail = `${providerSetupActionCommandLine(action)} was interrupted.`;
    const finish = (result: ProviderSetupResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (killSettlementTimer !== undefined) clearTimeout(killSettlementTimer);
      abortSignal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = (result: ProviderSetupResult) => {
      if (settled || terminationResult !== undefined) return;
      terminationResult = result;
      try { child.kill("SIGTERM"); } catch { /* close/error remains authoritative */ }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* close/error remains authoritative */ }
        killSettlementTimer = setTimeout(() => {
          child.unref?.();
          finish({
            action,
            status: "failed",
            failureKind: "child_exit_unconfirmed",
            detail:
              `${result.detail.replace(/[.]$/u, "")}; child exit could not be confirmed after SIGKILL. ` +
              "Stop the provider process manually before retrying provider setup.",
          });
        }, action.kind === "preflight" ? PROVIDER_PREFLIGHT_KILL_SETTLE_MS : PROVIDER_AUTH_KILL_SETTLE_MS);
        killSettlementTimer.unref?.();
      }, action.kind === "preflight" ? PROVIDER_PREFLIGHT_TERM_GRACE_MS : PROVIDER_AUTH_TERM_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const abort = () => terminate({ action, status: "failed", detail: interruptedDetail });
    child.once("error", (error) => {
      childError = error;
      // A ChildProcess can emit `error` because signaling an already-running
      // process failed (for example EPERM). That is not proof of exit: retain
      // the TERM→KILL escalation and wait for `close`. A true spawn failure has
      // no pid and can settle immediately when no cancellation is in flight.
      if (terminationResult === undefined && child.pid === undefined) {
        finish({ action, status: "failed", detail: error.message });
      }
    });
    child.once("close", (code, signal) => {
      if (terminationResult !== undefined) {
        finish(terminationResult);
        return;
      }
      if (code === 0) {
        finish({ action, status: "ok", detail: `${providerSetupActionCommandLine(action)} exited 0.` });
        return;
      }
      finish({
        action,
        status: "failed",
        detail: childError?.message ?? (signal === null
          ? `${providerSetupActionCommandLine(action)} exited ${code ?? "unknown"}.`
          : `${providerSetupActionCommandLine(action)} terminated by ${signal}.`),
      });
    });
    if (action.kind === "preflight") {
      timer = setTimeout(() => {
        const detail = `${providerSetupActionCommandLine(action)} timed out after ${preflightTimeoutMs}ms.`;
        terminate({ action, status: "failed", detail });
      }, preflightTimeoutMs);
      timer.unref?.();
    }
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted === true) abort();
  });
}

async function runHttpAction(
  action: Extract<ProviderSetupAction, { readonly url: string }>,
  fetchImpl: typeof fetch,
  preflightTimeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const interrupted = Symbol("provider-preflight-interrupted");
  let resolveInterrupted: ((value: typeof interrupted) => void) | undefined;
  const interruptedPromise = new Promise<typeof interrupted>((resolve) => {
    resolveInterrupted = resolve;
  });
  const onAbort = () => {
    resolveInterrupted?.(interrupted);
    controller.abort();
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (abortSignal?.aborted === true) onAbort();
    const request = Promise.resolve(fetchImpl(action.url, { signal: controller.signal }));
    // An injected/custom fetch may ignore AbortSignal, so the race itself is the
    // bounded contract. Observe the original promise to avoid late rejections.
    void request.catch(() => undefined);
    const timedOut = Symbol("provider-preflight-timeout");
    const response = action.kind === "preflight"
      ? await Promise.race([
          request,
          interruptedPromise,
          new Promise<typeof timedOut>((resolveTimeout) => {
            timer = setTimeout(() => {
              resolveTimeout(timedOut);
              controller.abort();
            }, preflightTimeoutMs);
            timer.unref?.();
          }),
        ])
      : await Promise.race([request, interruptedPromise]);
    if (response === interrupted) {
      return {
        action,
        status: "failed",
        detail: `${providerSetupActionCommandLine(action)} was interrupted.`,
      };
    }
    if (response === timedOut) {
      return {
        action,
        status: "failed",
        detail: `GET ${action.url} timed out after ${preflightTimeoutMs}ms.`,
      };
    }
    if (response.ok) {
      return { action, status: "ok", detail: `GET ${action.url} returned ${response.status}.` };
    }
    return { action, status: "failed", detail: `GET ${action.url} returned ${response.status}.` };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

function positivePreflightTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS;
}

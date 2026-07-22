import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { EffortLevel } from "@mono-agent/config";
import { discoverClaudeSdkModels } from "@mono-agent/runtime-adapter";

import {
  inspectPiAuthStore as inspectDefaultPiAuthStore,
  type PiAuthStoreInspection,
} from "../pi-auth-store-inspection.js";
import {
  credentialNeutralProviderStatusEnvironment,
  hasDurableProviderEnvironmentCredential,
  runBoundedProviderCommand,
} from "../provider-setup.js";

export type WizardModelSource = "claude" | "pi" | "codex" | "opencode" | "ollama" | "lmstudio" | "custom";
export type WizardModelAvailability = "catalog_available";
export type WizardModelAuthState = "auth_required" | "credential_detected" | "verified" | "not_required";

/** Cloud Pi providers that guided onboarding can authenticate and prove end to end. */
export const GUIDED_PI_PROVIDER_IDS = [
  "anthropic",
  "github-copilot",
  "openai-codex",
  "opencode-go",
] as const;

const GUIDED_PI_PROVIDERS = new Set<string>(GUIDED_PI_PROVIDER_IDS);
const GUIDED_LOCAL_PI_PROVIDERS = new Set(["ollama", "lmstudio"]);

/** Reject known unsupported remote Pi integrations while leaving custom local ids available. */
export function guidedPiProviderProblem(provider: string): string | undefined {
  if (GUIDED_PI_PROVIDERS.has(provider) || GUIDED_LOCAL_PI_PROVIDERS.has(provider)) {
    return undefined;
  }
  return builtinModels().getProvider(provider) === undefined
    ? "Custom Pi providers require a hand-authored providers.local[] entry. Guided init supports discovered Ollama and LM Studio routes."
    : "Guided init supports Pi Anthropic, GitHub Copilot, OpenAI Codex, OpenCode-Go, Ollama, and LM Studio. Configure other Pi providers manually.";
}

export interface WizardModelCandidate {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly source: WizardModelSource;
  readonly discovered?: boolean;
  readonly setupRequired?: boolean;
  readonly availability?: WizardModelAvailability;
  readonly authState?: WizardModelAuthState;
  readonly supportedEfforts?: readonly EffortLevel[];
  readonly defaultEffort?: EffortLevel;
  /** Provider-declared default model; curated offline Codex fallback uses Terra. */
  readonly providerDefault?: boolean;
}

export interface ModelDiscoveryStatus {
  readonly provider: "Claude" | "Codex" | "Pi" | "OpenCode-Go" | "Ollama" | "LM Studio";
  readonly status: "detected" | "setup_available" | "unavailable";
  readonly detail: string;
}

export interface ModelDiscoveryResult {
  readonly candidates: readonly WizardModelCandidate[];
  readonly statuses: readonly ModelDiscoveryStatus[];
}

interface ExecResult {
  readonly stdout: string;
}

type DiscoveryCommandRunner = NonNullable<DiscoverWizardModelsOptions["execFile"]>;

export interface DiscoverWizardModelsOptions {
  readonly execFile?: (file: string, args: readonly string[], opts: {
    readonly timeout: number;
    readonly env?: Record<string, string | undefined>;
    readonly abortSignal?: AbortSignal;
  }) => Promise<ExecResult>;
  readonly fetch?: typeof fetch;
  /** Deterministic inspection seam for tests; production uses the hardened filesystem inspector. */
  readonly inspectPiAuthStore?: (path: string) => Promise<PiAuthStoreInspection>;
  readonly piAuthPath?: string;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly verifiedModelRefs?: readonly string[];
  readonly codexModelList?: () => Promise<readonly CodexCatalogModel[]>;
  readonly claudeModelList?: () => ReturnType<typeof discoverClaudeSdkModels>;
}

function providerDiscoveryCommand(opts: DiscoverWizardModelsOptions): DiscoveryCommandRunner {
  if (opts.execFile !== undefined) {
    return (file, args, commandOptions) => opts.execFile!(file, args, {
      ...commandOptions,
      env: commandOptions.env ?? safeDiscoveryProcessEnv(),
      ...(opts.abortSignal === undefined ? {} : { abortSignal: opts.abortSignal }),
    });
  }
  return (file, args, commandOptions) => runBoundedProviderCommand(file, args, {
    ...commandOptions,
    cwd: process.cwd(),
    env: commandOptions.env ?? safeDiscoveryProcessEnv(),
    ...(opts.abortSignal === undefined ? {} : { abortSignal: opts.abortSignal }),
  });
}

interface DiscoveredModelEntry {
  readonly id: string;
  readonly reasoning?: boolean;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200;
const DEFAULT_OPENCODE_DISCOVERY_TIMEOUT_MS = 5000;
const PI_OPENAI_CODEX_PROVIDER = "openai-codex";

interface CuratedOpenAiCodexModel {
  readonly id: string;
  readonly name: string;
  readonly minimumCodexCliVersion?: readonly [major: number, minor: number, patch: number];
}

export interface CodexCatalogModel {
  readonly id: string;
  readonly displayName: string;
  readonly supportedEfforts: readonly EffortLevel[];
  readonly defaultEffort?: EffortLevel;
  readonly isDefault?: boolean;
}

const OPENAI_CODEX_MODELS: readonly CuratedOpenAiCodexModel[] = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", minimumCodexCliVersion: [0, 144, 0] },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", minimumCodexCliVersion: [0, 144, 0] },
];

export const STATIC_MODEL_CANDIDATES: readonly WizardModelCandidate[] = [
  ...OPENAI_CODEX_MODELS.map(staticDirectCodexCandidate),
  ...[
    ["claude-sonnet-5", "Claude Sonnet 5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-4-8[1m]", "Claude Opus 4.8 (1M context)", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", []],
  ].map(([model, label, efforts]) => ({
    value: `claude:${model as string}`,
    label: label as string,
    hint: "SDK-versioned cached catalog; sign-in required",
    source: "claude" as const,
    availability: "catalog_available" as const,
    authState: "auth_required" as const,
    supportedEfforts: efforts as EffortLevel[],
    setupRequired: true,
  })),
];

export async function discoverWizardModelCandidates(
  opts: DiscoverWizardModelsOptions = {},
): Promise<ModelDiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const [codex, pi, claude, opencode, ollama, lmstudio] = await Promise.all([
    discoverDirectCodex({ ...opts, timeoutMs }),
    discoverPiModels({ ...opts, timeoutMs }),
    discoverClaudeModels({ ...opts, timeoutMs }),
    discoverOpenCodeModels({
      ...opts,
      timeoutMs: opts.timeoutMs ?? DEFAULT_OPENCODE_DISCOVERY_TIMEOUT_MS,
    }),
    discoverOllamaModels({ ...opts, timeoutMs }),
    discoverLmStudioModels({ ...opts, timeoutMs }),
  ]);

  return {
    candidates: rankWizardModelCandidates([
      ...codex.candidates,
      ...pi.candidates,
      ...claude.candidates,
      ...opencode.candidates,
      ...ollama.candidates,
      ...lmstudio.candidates,
    ]),
    statuses: [codex.status, pi.status, claude.status, opencode.status, ollama.status, lmstudio.status],
  };
}

export function rankWizardModelCandidates(
  candidates: readonly WizardModelCandidate[],
): WizardModelCandidate[] {
  const byValue = new Map<string, WizardModelCandidate>();
  for (const candidate of candidates) {
    const existing = byValue.get(candidate.value);
    byValue.set(candidate.value, existing === undefined ? candidate : mergeCandidate(existing, candidate));
  }
  return [...byValue.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

export function formatModelDiscoveryStatus(statuses: readonly ModelDiscoveryStatus[]): string {
  return statuses.map((status) => `${status.provider}: ${status.detail}`).join("\n");
}

export function defaultEffortForModelRef(modelRef: string, reasoning?: boolean): EffortLevel | undefined {
  if (reasoning === true) {
    return "medium";
  }
  if (reasoning === false) {
    return "none";
  }

  if (!modelRef.startsWith("pi:")) {
    return undefined;
  }

  const [, provider, ...modelParts] = modelRef.split(":");
  const model = modelParts.join(":");
  if (provider === "opencode-go" || provider === "ollama" || provider === "lmstudio") {
    return localModelDefaultEffort(model);
  }

  return undefined;
}

/** Detect the direct Codex CLI and its account catalog without claiming readiness. */
async function discoverDirectCodex(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = providerDiscoveryCommand(opts);
  const verified = new Set(opts.verifiedModelRefs ?? []);
  let version = "";
  try {
    const result = await run("codex", ["--version"], { timeout: opts.timeoutMs });
    version = firstOutputLine(result.stdout);
  } catch {
    return {
      candidates: directCodexCandidates(curatedCodexCatalog(), "install-required", "", verified),
      status: {
        provider: "Codex",
        status: "setup_available",
        detail: "CLI not found; install Codex and sign in before the readiness check",
      },
    };
  }

  let catalog = curatedCodexCatalog();
  try {
    // Injected command runners are normally deterministic unit-test seams; do
    // not escape them by starting a real app-server unless a model-list seam
    // was also supplied.
    const discoveredCatalog = opts.codexModelList !== undefined
      ? [...await opts.codexModelList()]
      : opts.execFile === undefined
        ? await requestCodexModelList(
            opts.timeoutMs,
            codexModelDiscoveryEnvironment(opts.persistedEnv),
            opts.abortSignal,
          )
        : catalog;
    if (discoveredCatalog.length > 0) catalog = discoveredCatalog;
  } catch {
    // The exact curated Sol/Terra fallback remains selectable offline.
  }

  const durableCredential = hasDurableProviderEnvironmentCredential(
    "codex:gpt-5.6-terra",
    opts.persistedEnv ?? {},
  );
  const shellOnlyCredential = !durableCredential
    && hasDurableProviderEnvironmentCredential("codex:gpt-5.6-terra", process.env);
  try {
    if (!durableCredential) {
      await run("codex", ["login", "status"], {
        timeout: opts.timeoutMs,
        env: credentialNeutralProviderStatusEnvironment(process.env, opts.persistedEnv),
      });
    }
    const candidates = directCodexCandidates(catalog, "credential-detected", version, verified);
    const setupModels = candidates.filter((candidate) => candidate.setupRequired === true);
    const setupDetails = [...new Set(setupModels.map((candidate) => candidate.hint ?? `${candidate.label} setup required`))];
    return {
      candidates,
      status: {
        provider: "Codex",
        status: setupModels.length === 0 ? "detected" : "setup_available",
        detail: `${version.length > 0 ? `${version}; ` : ""}${
          durableCredential ? "durable OPENAI_API_KEY detected" : "sign-in detected"
        } (live readiness not yet verified)${
          setupModels.length === 0
            ? ""
            : `; ${setupDetails.join("; ")}`
        }`,
      },
    };
  } catch {
    return {
      candidates: directCodexCandidates(catalog, "login-required", version, verified),
      status: {
        provider: "Codex",
        status: "setup_available",
        detail: `${version.length > 0 ? `${version}; ` : "CLI installed; "}${
          shellOnlyCredential
            ? "durable sign-in required; shell-only OPENAI_API_KEY ignored"
            : "sign-in required"
        }`,
      },
    };
  }
}

async function discoverPiModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const inspectAuthStore = opts.inspectPiAuthStore ?? inspectDefaultPiAuthStore;
  const authPath = opts.piAuthPath ?? join(homedir(), ".pi", "agent", "auth.json");
  let credentialProviders = new Set<string>();
  let status: ModelDiscoveryStatus;
  try {
    const inspection = await inspectAuthStore(authPath);
    if (inspection.status === "missing") {
      status = { provider: "Pi", status: "setup_available", detail: "auth store not found; provider setup is available" };
    } else if (inspection.status === "unsafe") {
      status = {
        provider: "Pi",
        status: "unavailable",
        detail: `auth store rejected as unsafe (${inspection.reason}); catalog remains available`,
      };
    } else {
      const providers = readPiAuthProviderMap(inspection.auth);
      credentialProviders = new Set(Object.entries(providers)
        .filter(([provider, credential]) => GUIDED_PI_PROVIDERS.has(provider) && hasUsablePiCredential(credential))
        .map(([provider]) => provider));
      status = credentialProviders.size > 0
        ? {
            provider: "Pi",
            status: "detected",
            detail: `${credentialProviders.size} provider credential entr${credentialProviders.size === 1 ? "y" : "ies"} detected (not yet verified)`,
          }
        : { provider: "Pi", status: "setup_available", detail: "credential store is empty; setup is available" };
    }
  } catch {
    status = { provider: "Pi", status: "unavailable", detail: "auth store unreadable; catalog remains available" };
  }

  const preEnvironmentStatus = status;
  for (const provider of GUIDED_PI_PROVIDER_IDS) {
    if (hasDurableProviderEnvironmentCredential(`pi:${provider}:credential-check`, opts.persistedEnv ?? {})) {
      credentialProviders.add(provider);
    }
  }
  if (credentialProviders.size > 0 && preEnvironmentStatus.status !== "detected") {
    status = {
      provider: "Pi",
      status: "detected",
      detail: `${credentialProviders.size} provider credential source${credentialProviders.size === 1 ? "" : "s"} detected (not yet verified); ${preEnvironmentStatus.detail}`,
    };
  } else if (
    credentialProviders.size === 0
    && hasDurableProviderEnvironmentCredential("pi:opencode-go:credential-check", process.env)
  ) {
    status = {
      provider: "Pi",
      status: "setup_available",
      detail: `${preEnvironmentStatus.detail}; shell-only OPENCODE_API_KEY ignored until persisted in the agent .env or Pi auth store`,
    };
  }

  const verified = new Set(opts.verifiedModelRefs ?? []);
  const oauthProviders = new Set(getOAuthProviders().map((provider) => provider.id));
  const models = builtinModels();
  const providerNames = new Map(models.getProviders().map((provider) => [provider.id, provider.name]));
  const candidates = models.getModels()
    .filter((model) => GUIDED_PI_PROVIDERS.has(model.provider))
    .map((model): WizardModelCandidate => {
      const value = `pi:${model.provider}:${model.id}`;
      const supportedEfforts = normalizeEfforts(getSupportedThinkingLevels(model));
      const authState: WizardModelAuthState = verified.has(value)
        ? "verified"
        : credentialProviders.has(model.provider)
          ? "credential_detected"
          : "auth_required";
      const defaultEffort = exactDefaultEffortWhenUnambiguous(supportedEfforts);
      const shellOnlyCredential = authState === "auth_required"
        && hasDurableProviderEnvironmentCredential(value, process.env);
      const providerLabel = model.provider === "opencode-go"
        ? "OpenCode-Go"
        : providerNames.get(model.provider) ?? model.provider;
      return {
        value,
        label: `Pi ${providerLabel} · ${model.name || model.id}`,
        hint: authState === "verified"
          ? "verified by live readiness"
          : authState === "credential_detected"
            ? "credential detected; live readiness pending"
            : shellOnlyCredential
              ? "shell-only credential ignored; persist it in the agent .env or provider store"
              : oauthProviders.has(model.provider)
                ? "OAuth setup available"
                : "API key or provider environment required",
        source: "pi",
        availability: "catalog_available",
        authState,
        supportedEfforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(authState === "verified" ? { discovered: true } : {}),
        ...(authState === "auth_required" ? { setupRequired: true } : {}),
      };
    });
  return { candidates, status };
}

function readPiAuthProviderMap(auth: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const nestedProviders = auth.providers === undefined ? {} : parseJsonObject(auth.providers);
  const { providers: _providers, ...topLevelProviders } = auth;
  return { ...nestedProviders, ...topLevelProviders };
}

function hasUsablePiCredential(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "oauth") {
    return isCredentialString(value.access) || isCredentialString(value.refresh);
  }
  return value.type === "api_key" && isCredentialString(value.key);
}

function isCredentialString(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 65_536
    && !value.includes("\0");
}

async function discoverClaudeModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = providerDiscoveryCommand(opts);
  const verified = new Set(opts.verifiedModelRefs ?? []);
  let credentialDetected = hasDurableProviderEnvironmentCredential(
    "claude:claude-sonnet-5",
    opts.persistedEnv ?? {},
  );
  const durableCredential = credentialDetected;
  const shellOnlyCredential = !durableCredential
    && hasDurableProviderEnvironmentCredential("claude:claude-sonnet-5", process.env);
  if (!credentialDetected) {
    try {
      await run("claude", ["auth", "status", "--json"], {
        timeout: opts.timeoutMs,
        env: credentialNeutralProviderStatusEnvironment(process.env, opts.persistedEnv),
      });
      credentialDetected = true;
    } catch {
      // Catalog discovery is deliberately independent from account state.
    }
  }
  let catalog: Awaited<ReturnType<typeof discoverClaudeSdkModels>> = [];
  try {
    catalog = opts.claudeModelList !== undefined
      ? await opts.claudeModelList()
      : opts.execFile === undefined
        ? await discoverClaudeSdkModels({ timeoutMs: Math.max(opts.timeoutMs, 2_000) })
        : await discoverClaudeSdkModels({ timeoutMs: 1 });
  } catch {
    // Static SDK-versioned rows remain available through STATIC_MODEL_CANDIDATES.
  }
  const candidates = catalog.map((model): WizardModelCandidate => {
    const value = model.reference;
    const authState: WizardModelAuthState = verified.has(value)
      ? "verified"
      : credentialDetected
        ? "credential_detected"
        : "auth_required";
    const supportedEfforts = normalizeEfforts(model.supportedEfforts);
    return {
      value,
      label: model.displayName,
      hint: `${model.source === "discovered" ? "discovered from Claude SDK" : "SDK-versioned cached catalog"}; ${
        authState === "verified" ? "verified" : authState === "credential_detected" ? "credential detected; live readiness pending" : "sign-in required"
      }`,
      source: "claude",
      availability: "catalog_available",
      authState,
      supportedEfforts,
      ...(authState === "verified" ? { discovered: true } : {}),
      ...(authState === "auth_required" ? { setupRequired: true } : {}),
    };
  });
  return {
    candidates,
    status: credentialDetected
      ? {
          provider: "Claude",
          status: "detected",
          detail: `${durableCredential ? "durable provider credential" : "sign-in"} detected (live readiness not yet verified)`,
        }
      : {
          provider: "Claude",
          status: "setup_available",
          detail: `${
            shellOnlyCredential
              ? "durable sign-in required; shell-only Claude credential ignored"
              : "sign-in required"
          }; catalog remains available`,
        },
  };
}

async function discoverOpenCodeModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = providerDiscoveryCommand(opts);
  let isolation: Awaited<ReturnType<typeof createOpenCodeDiscoveryIsolation>> | undefined;
  try {
    isolation = await createOpenCodeDiscoveryIsolation();
    const { stdout } = await run("opencode", ["models", "opencode-go", "--pure"], {
      timeout: opts.timeoutMs,
      env: isolation.env,
    });
    const bundledModelIds = new Set(
      builtinModels().getModels()
        .filter((model) => model.provider === "opencode-go")
        .map((model) => model.id),
    );
    const parsedModels = parseOpenCodeGoModels(stdout);
    const models = parsedModels.filter((model) => bundledModelIds.has(model));
    const unsupportedCount = parsedModels.length - models.length;
    return {
      candidates: models.map((model) => {
        const value = `pi:opencode-go:${model}`;
        return {
          value,
          label: `OpenCode-Go ${displayModelName(model)}`,
          hint: "discovered from opencode; OpenCode-Go API key required",
          source: "opencode",
          discovered: true,
          availability: "catalog_available",
          authState: "auth_required",
          setupRequired: true,
          supportedEfforts: [],
        };
      }),
      status: models.length > 0
        ? {
            provider: "OpenCode-Go",
            status: "detected",
            detail: `${models.length} runtime-supported model${models.length === 1 ? "" : "s"} found${
              unsupportedCount === 0
                ? ""
                : `; ${unsupportedCount} unsupported CLI row${unsupportedCount === 1 ? "" : "s"} ignored`
            }`,
          }
        : parsedModels.length > 0
          ? {
              provider: "OpenCode-Go",
              status: "unavailable",
              detail: `no runtime-supported models; ${parsedModels.length} unsupported CLI row${parsedModels.length === 1 ? "" : "s"} ignored`,
            }
          : { provider: "OpenCode-Go", status: "unavailable", detail: "no models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "OpenCode-Go", status: "unavailable", detail: "`opencode models opencode-go --pure` unavailable" } };
  } finally {
    await isolation?.cleanup();
  }
}

async function createOpenCodeDiscoveryIsolation(): Promise<{
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-opencode-discovery-"));
  try {
    await chmod(root, 0o700);
    const home = await createPrivateDirectory(root, "home");
    const config = await createPrivateDirectory(root, "config");
    const opencodeConfig = await createPrivateDirectory(config, "opencode");
    if (process.platform !== "win32") await chmod(opencodeConfig, 0o500);
    const data = await createPrivateDirectory(root, "data");
    const state = await createPrivateDirectory(root, "state");
    const cache = await createPrivateDirectory(root, "cache");
    const opencodeData = await createPrivateDirectory(data, "opencode");
    const database = join(opencodeData, "opencode.db");
    const handle = await open(database, "wx", 0o600);
    await handle.close();
    await chmod(database, 0o600);
    const env = safeDiscoveryProcessEnv();
    Object.assign(env, {
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CONFIG_DIRS: config,
      XDG_DATA_HOME: data,
      XDG_DATA_DIRS: data,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: cache,
      OPENCODE_DB: database,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled", autoshare: false }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_SHARE: "true",
      OPENCODE_AUTO_SHARE: "false",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    });
    return {
      env,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function safeDiscoveryProcessEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Exact non-secret environment used by live Codex model/list discovery. */
export function codexModelDiscoveryEnvironment(
  persistedEnv: Readonly<Record<string, string | undefined>> = {},
  shellEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const neutral = credentialNeutralProviderStatusEnvironment(shellEnv, persistedEnv);
  return {
    ...safeDiscoveryProcessEnv(shellEnv),
    HOME: neutral.HOME ?? homedir(),
    ...(neutral.CODEX_HOME === undefined ? {} : { CODEX_HOME: neutral.CODEX_HOME }),
  };
}

async function createPrivateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function discoverOllamaModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = providerDiscoveryCommand(opts);
  try {
    const { stdout } = await run("ollama", ["list"], { timeout: opts.timeoutMs });
    const models = parseOllamaList(stdout);
    return {
      candidates: models.map((model) => {
        const value = `pi:ollama:${model}`;
        return {
          value,
          label: `Ollama ${model}`,
          hint: "discovered locally",
          source: "ollama",
          discovered: true,
          availability: "catalog_available",
          authState: "not_required",
          supportedEfforts: [],
        };
      }),
      status: models.length > 0
        ? { provider: "Ollama", status: "detected", detail: `${models.length} model(s) found` }
        : { provider: "Ollama", status: "unavailable", detail: "no local models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "Ollama", status: "unavailable", detail: "`ollama list` unavailable" } };
  }
}

async function discoverLmStudioModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const fetchImpl = opts.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onAbort = () => controller.abort();
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl("http://localhost:1234/v1/models", { signal: controller.signal });
    if (!response.ok) {
      return { candidates: [], status: { provider: "LM Studio", status: "unavailable", detail: "server did not return models" } };
    }
    const body: unknown = await response.json();
    const models = parseOpenAiModelEntriesBody(body);
    return {
      candidates: models.map((model) => {
        const value = `pi:lmstudio:${model.id}`;
        return {
          value,
          label: `LM Studio ${model.id}`,
          hint: "discovered locally",
          source: "lmstudio",
          discovered: true,
          availability: "catalog_available",
          authState: "not_required",
          supportedEfforts: model.reasoning === false ? ["none"] : [],
          ...(model.reasoning === false ? { defaultEffort: "none" as const } : {}),
        };
      }),
      status: models.length > 0
        ? { provider: "LM Studio", status: "detected", detail: `${models.length} model(s) found` }
        : { provider: "LM Studio", status: "unavailable", detail: "no models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "LM Studio", status: "unavailable", detail: "local server unavailable" } };
  } finally {
    clearTimeout(timer);
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function mergeCandidate(left: WizardModelCandidate, right: WizardModelCandidate): WizardModelCandidate {
  const {
    setupRequired: leftSetupRequired,
    defaultEffort: leftDefaultEffort,
    supportedEfforts: leftSupportedEfforts,
    ...leftRest
  } = left;
  const {
    setupRequired: rightSetupRequired,
    defaultEffort: rightDefaultEffort,
    supportedEfforts: rightSupportedEfforts,
    ...rightRest
  } = right;
  const rightHasDiscoveryState = right.discovered === true
    || right.setupRequired === true
    || right.availability !== undefined
    || right.authState !== undefined;
  const preserveBuiltinPiMetadata = left.source === "pi"
    && (right.source === "opencode" || right.source === "ollama" || right.source === "lmstudio");
  const hint = preserveBuiltinPiMetadata
    ? left.hint
    : rightHasDiscoveryState ? right.hint ?? left.hint : left.hint ?? right.hint;
  const discovered = left.discovered === true || right.discovered === true;
  const rightReplacesCatalogMetadata = right.availability === "catalog_available"
    && left.source === right.source;
  const defaultEffort = preserveBuiltinPiMetadata
    ? leftDefaultEffort
    : rightReplacesCatalogMetadata
      ? rightDefaultEffort
      : rightDefaultEffort ?? leftDefaultEffort;
  const authState = preserveBuiltinPiMetadata
    ? left.authState
    : strongerAuthState(left.authState, right.authState);
  const setupRequired = preserveBuiltinPiMetadata
    ? leftSetupRequired === true || authState === "auth_required"
    : rightSetupRequired === true || authState === "auth_required"
      || (right.authState === undefined && !discovered && leftSetupRequired === true);
  return {
    ...leftRest,
    ...rightRest,
    ...(preserveBuiltinPiMetadata ? { source: left.source } : {}),
    ...(authState === undefined ? {} : { authState }),
    supportedEfforts: preserveBuiltinPiMetadata
      ? [...(leftSupportedEfforts ?? [])]
      : [...(rightSupportedEfforts ?? leftSupportedEfforts ?? [])],
    ...(hint === undefined ? {} : { hint }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    discovered,
    ...(setupRequired ? { setupRequired: true } : {}),
  };
}

function rank(candidate: WizardModelCandidate): number {
  const authRank = candidate.authState === "verified"
    ? 0
    : candidate.authState === "credential_detected" || candidate.authState === "not_required"
      ? 1
      : 2;
  return authRank * 1_000 + modelRank(candidate);
}

function modelRank(candidate: WizardModelCandidate): number {
  if (candidate.providerDefault === true) return -100;
  const directCodexRank = OPENAI_CODEX_MODELS.findIndex((model) => candidate.value === directCodexRef(model));
  if (directCodexRank >= 0) return directCodexRank;
  const piOpenAiCodexRank = OPENAI_CODEX_MODELS.findIndex((model) => candidate.value === piOpenAiCodexRef(model));
  if (piOpenAiCodexRank >= 0) return 10 + piOpenAiCodexRank;
  if (candidate.source === "claude") {
    return 20;
  }
  if (candidate.source === "opencode") {
    return 30;
  }
  if (candidate.source === "ollama") {
    return candidate.discovered === true ? 40 : 45;
  }
  if (candidate.source === "lmstudio") {
    return 50;
  }
  return 90;
}

function directCodexRef(model: CuratedOpenAiCodexModel): string {
  return `codex:${model.id}`;
}

function piOpenAiCodexRef(model: CuratedOpenAiCodexModel): string {
  return `pi:${PI_OPENAI_CODEX_PROVIDER}:${model.id}`;
}

function staticDirectCodexCandidate(model: CuratedOpenAiCodexModel): WizardModelCandidate {
  return {
    value: directCodexRef(model),
    label: `Codex ${model.name}`,
    ...(model.minimumCodexCliVersion === undefined
      ? {}
      : { hint: `requires Codex CLI ${formatVersion(model.minimumCodexCliVersion)}+` }),
    source: "codex",
    availability: "catalog_available",
    authState: "auth_required",
    // Exact effort support/defaults come from Codex app-server model/list.
    // Do not fabricate provider metadata when the live catalog is unavailable.
    supportedEfforts: [],
    providerDefault: model.id === "gpt-5.6-terra",
  };
}

function directCodexCandidates(
  catalog: readonly CodexCatalogModel[],
  state: "credential-detected" | "install-required" | "login-required",
  version = "",
  verified: ReadonlySet<string> = new Set(),
): WizardModelCandidate[] {
  return catalog.map((model) => directCodexCandidate(model, state, version, verified));
}

function directCodexCandidate(
  model: CodexCatalogModel,
  state: "credential-detected" | "install-required" | "login-required",
  version = "",
  verified: ReadonlySet<string> = new Set(),
): WizardModelCandidate {
  const reference = `codex:${model.id}`;
  const curated = OPENAI_CODEX_MODELS.find((entry) => entry.id === model.id);
  const authState: WizardModelAuthState = verified.has(reference)
    ? "verified"
    : state === "credential-detected"
      ? "credential_detected"
      : "auth_required";
  if (state === "install-required") {
    const minimum = curated?.minimumCodexCliVersion;
    return {
      value: reference,
      label: `Codex ${model.displayName}`,
      hint: minimum === undefined
        ? "install Codex CLI and sign in"
        : `install Codex CLI ${formatVersion(minimum)}+ and sign in`,
      source: "codex",
      setupRequired: true,
      availability: "catalog_available",
      authState,
      supportedEfforts: model.supportedEfforts,
      ...(model.isDefault === undefined ? {} : { providerDefault: model.isDefault }),
      ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    };
  }

  const prerequisites: string[] = [];
  const minimum = curated?.minimumCodexCliVersion;
  if (minimum !== undefined && !codexVersionMeetsMinimum(version, minimum)) {
    prerequisites.push(
      parseCodexVersion(version) === undefined
        ? `Codex CLI ${formatVersion(minimum)}+ required; installed version could not be verified`
        : `update Codex CLI to ${formatVersion(minimum)}+ (found ${version})`,
    );
  }
  if (state === "login-required") prerequisites.push("Codex sign-in required");

  if (prerequisites.length === 0) {
    return {
      value: reference,
      label: `Codex ${model.displayName}`,
      hint: authState === "verified"
        ? `${version.length > 0 ? `${version}; ` : ""}verified by live readiness`
        : `${version.length > 0 ? `${version}; ` : ""}sign-in detected; live readiness pending`,
      source: "codex",
      discovered: true,
      availability: "catalog_available",
      authState,
      supportedEfforts: model.supportedEfforts,
      ...(model.isDefault === undefined ? {} : { providerDefault: model.isDefault }),
      ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    };
  }

  return {
    value: reference,
    label: `Codex ${model.displayName}`,
    hint: prerequisites.join("; "),
    source: "codex",
    setupRequired: true,
    availability: "catalog_available",
    authState,
    supportedEfforts: model.supportedEfforts,
    ...(model.isDefault === undefined ? {} : { providerDefault: model.isDefault }),
    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
  };
}

function curatedCodexCatalog(): CodexCatalogModel[] {
  return OPENAI_CODEX_MODELS.map((model) => ({
    id: model.id,
    displayName: model.name,
    supportedEfforts: [],
    // Offline product fallback only; live model/list replaces this flag.
    isDefault: model.id === "gpt-5.6-terra",
  }));
}

function strongerAuthState(
  left: WizardModelAuthState | undefined,
  right: WizardModelAuthState | undefined,
): WizardModelAuthState {
  const order: Record<WizardModelAuthState, number> = {
    auth_required: 0,
    not_required: 1,
    credential_detected: 2,
    verified: 3,
  };
  if (left === undefined) return right ?? "auth_required";
  if (right === undefined) return left;
  return order[right] > order[left] ? right : left;
}

async function requestCodexModelList(
  timeoutMs: number,
  environment: Readonly<Record<string, string | undefined>>,
  abortSignal?: AbortSignal,
): Promise<CodexCatalogModel[]> {
  const child = spawn(
    "codex",
    ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...environment },
    },
  );
  const lines = createInterface({ input: child.stdout });
  return await new Promise<CodexCatalogModel[]>((resolveResult, rejectResult) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const ignoreStdinError = () => undefined;
    child.stdin.on("error", ignoreStdinError);
    const childClosedWithin = async (milliseconds: number): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      return await new Promise<boolean>((resolveClosed) => {
        const onClose = () => {
          clearTimeout(closeTimer);
          resolveClosed(true);
        };
        const closeTimer = setTimeout(() => {
          child.off("close", onClose);
          resolveClosed(false);
        }, milliseconds);
        closeTimer.unref?.();
        child.once("close", onClose);
      });
    };
    const stopChild = async () => {
      lines.removeAllListeners("line");
      lines.close();
      try { child.stdin.end(); } catch { /* best effort */ }
      if (await childClosedWithin(25)) return;
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
      if (await childClosedWithin(250)) return;
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      if (!await childClosedWithin(250)) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
      }
    };
    let settle!: (error: Error | undefined, models?: CodexCatalogModel[]) => Promise<void>;
    const onChildError = () => void settle(new Error("Codex app-server is unavailable."));
    const onChildClose = () => void settle(new Error("Codex app-server closed before returning models."));
    const onAbort = () => {
      const error = new Error("Codex model catalog discovery was interrupted.");
      error.name = "AbortError";
      void settle(error);
    };
    settle = async (error: Error | undefined, models: CodexCatalogModel[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onChildError);
      child.off("close", onChildClose);
      abortSignal?.removeEventListener("abort", onAbort);
      await stopChild();
      child.stdin.off("error", ignoreStdinError);
      if (error === undefined) resolveResult(models);
      else rejectResult(error);
    };
    const writeMessage = (message: unknown) => {
      if (settled || child.stdin.destroyed || child.stdin.writableEnded) return;
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* bounded shutdown handles the process */ }
    };
    timer = setTimeout(
      () => void settle(new Error("Codex model catalog discovery timed out.")),
      Math.max(250, Math.min(10_000, timeoutMs)),
    );
    timer.unref?.();
    child.once("error", onChildError);
    child.once("close", onChildClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
        writeMessage({
          id: message.id,
          error: { code: -32601, message: "Model catalog discovery does not support server requests." },
        });
        return;
      }
      if (message.id === 1 && isRecord(message.result)) {
        writeMessage({
          id: 2,
          method: "model/list",
          params: { includeHidden: false, limit: 1_000 },
        });
        return;
      }
      if (message.id !== 2) return;
      if (!isRecord(message.result) || !Array.isArray(message.result.data)) {
        void settle(new Error("Codex app-server returned an invalid model catalog."));
        return;
      }
      void settle(undefined, normalizeCodexCatalog(message.result.data));
    });
    writeMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "mono-agent", title: "mono-agent", version: "0" },
        capabilities: { experimentalApi: true },
      },
    });
    if (abortSignal?.aborted === true) onAbort();
  });
}

function normalizeCodexCatalog(rows: readonly unknown[]): CodexCatalogModel[] {
  const result: CodexCatalogModel[] = [];
  const seen = new Set<string>();
  for (const raw of rows.slice(0, 1_000)) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (id.length === 0 || id.length > 160 || seen.has(id)) continue;
    const supportedRows = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts.map((entry) => isRecord(entry) ? entry.reasoningEffort : entry)
      : [];
    const supportedEfforts = normalizeEfforts(supportedRows);
    const normalizedDefault = normalizeEffort(raw.defaultReasoningEffort);
    seen.add(id);
    result.push({
      id,
      displayName: boundedCatalogText(raw.displayName, 160) || id,
      supportedEfforts,
      ...(normalizedDefault === undefined ? {} : { defaultEffort: normalizedDefault }),
      ...(typeof raw.isDefault === "boolean" ? { isDefault: raw.isDefault } : {}),
    });
  }
  return result;
}

const SUPPORTED_EFFORTS = new Set<EffortLevel>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function normalizeEffort(value: unknown): EffortLevel | undefined {
  const normalized = value === "off" ? "none" : typeof value === "string" ? value : "";
  return SUPPORTED_EFFORTS.has(normalized as EffortLevel) ? normalized as EffortLevel : undefined;
}

function normalizeEfforts(values: readonly unknown[]): EffortLevel[] {
  return [...new Set(values.map(normalizeEffort).filter((value): value is EffortLevel => value !== undefined))];
}

function exactDefaultEffortWhenUnambiguous(
  supportedEfforts: readonly EffortLevel[],
): EffortLevel | undefined {
  return supportedEfforts.length === 1 ? supportedEfforts[0] : undefined;
}

function boundedCatalogText(value: unknown, limit: number): string {
  const normalized = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()
    : "";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function parseCodexVersion(version: string): readonly [major: number, minor: number, patch: number] | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/u.exec(version);
  if (match === null) return undefined;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return undefined;
  return [parts[0] as number, parts[1] as number, parts[2] as number];
}

function codexVersionMeetsMinimum(
  version: string,
  minimum: readonly [major: number, minor: number, patch: number],
): boolean {
  const parsed = parseCodexVersion(version);
  if (parsed === undefined) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const installedPart = parsed[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (installedPart !== minimumPart) return installedPart > minimumPart;
  }
  return true;
}

function formatVersion(version: readonly [major: number, minor: number, patch: number]): string {
  return version.join(".");
}

function parseOllamaList(stdout: string): string[] {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }
  return lines
    .slice(lines[0]?.toLowerCase().startsWith("name") ? 1 : 0)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name): name is string => name !== undefined && name.length > 0);
}

function parseOpenCodeGoModels(stdout: string): string[] {
  const prefix = "opencode-go/";
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix) && line.length > prefix.length)
    .map((line) => line.slice(prefix.length));
}

function parseOpenAiModelEntriesBody(body: unknown): DiscoveredModelEntry[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return [];
  }
  return body.data.map(modelEntryFromUnknown).filter(isModelEntry);
}

function modelEntryFromUnknown(value: unknown): DiscoveredModelEntry | undefined {
  if (typeof value === "string") {
    return { id: value };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value.id ?? value.name ?? value.model;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  const reasoning = readReasoningCapability(value);
  return {
    id: raw,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function displayModelName(model: string): string {
  return model.startsWith("pi:") ? model.split(":").slice(2).join(":") : model;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}

function firstOutputLine(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 120) ?? "";
}

function readReasoningCapability(value: Record<string, unknown>): boolean | undefined {
  for (const field of ["reasoning", "supportsReasoning", "supports_reasoning", "thinking", "supportsThinking", "supports_thinking"]) {
    const result = booleanCapability(value[field]);
    if (result !== undefined) {
      return result;
    }
  }
  for (const field of ["capabilities", "features"]) {
    const nested = value[field];
    const result = Array.isArray(nested) ? arrayCapability(nested) : isRecord(nested) ? readReasoningCapability(nested) : undefined;
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

function booleanCapability(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayCapability(value: readonly unknown[]): boolean | undefined {
  return value.some((entry) => typeof entry === "string" && /^(reasoning|thinking)$/iu.test(entry)) ? true : undefined;
}

function localModelDefaultEffort(model: string): EffortLevel {
  const normalized = model.toLowerCase();
  return ["gpt-oss", "qwen3", "qwq", "deepseek-r1", "reasoning", "thinking"].some((token) => normalized.includes(token))
    || /(?:^|[-_:/.\s])o[1345](?:$|[-_:/.\s])/u.test(normalized)
    ? "medium"
    : "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelEntry(value: DiscoveredModelEntry | undefined): value is DiscoveredModelEntry {
  return value !== undefined;
}

import { execFile } from "node:child_process";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CodedError } from "@mono-agent/agent-contracts";

import {
  ManagedSrtCorruptError,
  type ResolveSrtLaunchOptions,
  type SrtFileIdentity,
  type SrtLaunch,
  resolveSrtLaunch,
  resolveTrustedFile,
} from "./sandbox-managed.js";

const execFileAsync = promisify(execFile);

export const SANDBOX_MODES = ["native", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const SANDBOX_NETWORK_MODES = ["none", "localhost", "allowlist", "all"] as const;
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

export const SANDBOX_FALLBACKS = ["fail-closed", "unsafe-host-process"] as const;
export type SandboxFallback = (typeof SANDBOX_FALLBACKS)[number];

export type SandboxEngineId = string;

export const DEFAULT_DENY_WRITE = [".env", ".env.*", ".git/config", ".git/hooks/**"] as const;

// SRT read policy is deny-then-allow. Deny `/` and re-open only the configured
// roots plus this reviewed set of OS/runtime paths needed to start ordinary
// Bash and Node processes. Deliberately omit user-managed prefixes such as
// /usr/local, /opt, home directories, and temporary directories; callers must
// name those explicitly in readableRoots when their toolchain needs them.
const SRT_IMMUTABLE_RUNTIME_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/lib64",
  "/usr/libexec",
  "/usr/share/locale",
  "/usr/share/zoneinfo",
  "/System",
  "/Library/Apple",
  "/Library/Frameworks",
  "/etc/ca-certificates",
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/resolv.conf",
  "/etc/ssl",
  "/private/etc/hosts",
  "/private/etc/localtime",
  "/private/etc/passwd",
  "/private/etc/group",
  "/private/etc/resolv.conf",
  "/private/etc/ssl",
  "/private/var/db/dyld",
  "/private/var/db/timezone",
  "/dev/null",
  "/dev/random",
  "/dev/tty",
  "/dev/urandom",
  "/dev/zero",
  "/proc/self",
  "/proc/thread-self",
  "/sys/devices/system/cpu",
] as const;

const runtimeReadExpansionCache = new Map<string, Promise<readonly string[]>>();
const MAX_RUNTIME_READ_EXPANSIONS = 64;

export interface SandboxNetworkPolicyInput {
  readonly mode?: SandboxNetworkMode;
  readonly allowlist?: readonly string[];
}

export interface SandboxPolicyInput {
  readonly mode?: SandboxMode;
  readonly engine?: SandboxEngineId;
  readonly root?: string;
  readonly readableRoots?: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly denyWrite?: readonly string[];
  readonly tempRoot?: string;
  readonly network?: SandboxNetworkPolicyInput;
  readonly fallback?: SandboxFallback;
  readonly unsafeAllowHostProcess?: boolean;
}

export interface SandboxNetworkPolicy {
  readonly mode: SandboxNetworkMode;
  readonly allowlist: readonly string[];
}

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly engine: SandboxEngineId;
  readonly root: string;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly denyWrite: readonly string[];
  readonly tempRoot: string;
  readonly network: SandboxNetworkPolicy;
  readonly fallback: SandboxFallback;
  readonly unsafeAllowHostProcess: boolean;
}

export type SandboxErrorCode =
  | "invalid_sandbox_policy"
  | "sandbox_unavailable";

export class SandboxPolicyError extends CodedError<SandboxErrorCode> {}

export class SandboxUnavailableError extends SandboxPolicyError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("sandbox_unavailable", message, details);
  }
}

export interface SandboxCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** Trusted per-command capability; never derived from model/user tool input. */
  readonly allowLocalBinding?: boolean;
}

export interface PreparedSandboxCommand extends SandboxCommandSpec {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sandboxed: boolean;
  readonly sandboxSettingsPath?: string;
  readonly cleanup?: () => Promise<void>;
}

export interface SandboxEngine {
  readonly id: SandboxEngineId;
  isAvailable(): Promise<boolean>;
  prepareCommand(command: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand>;
}

export type SandboxEffectiveMode =
  | "off"
  | "native"
  | "blocked"
  | "unsafe-host-process";

export interface SandboxEffectiveState {
  readonly configured: boolean;
  readonly configuredMode: SandboxMode | undefined;
  readonly effective: SandboxEffectiveMode;
  readonly engine: SandboxEngineId | undefined;
  readonly engineAvailable: boolean | undefined;
  readonly fallback: SandboxFallback | undefined;
  readonly fallbackActive: boolean;
  readonly unsafeAllowHostProcess: boolean;
}

export interface PrepareSandboxedCommandInput {
  readonly policy?: SandboxPolicy;
  readonly command: SandboxCommandSpec;
  readonly engine?: SandboxEngine;
}

export interface SandboxPolicyRuntimeOptions {
  readonly sandboxPolicy: SandboxPolicy;
}

export interface SrtNetworkSettings {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly strictAllowlist: true;
  readonly allowLocalBinding: boolean;
  readonly allowAllUnixSockets: boolean;
}

export interface SrtFilesystemSettings {
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

export interface SrtSettings {
  /**
   * Absent under all-network mode: SRT starts its proxy and domain filter
   * whenever `network.allowedDomains` is defined, so unrestricted networking
   * with enforced filesystem scopes is spelled by omitting the block.
   */
  readonly network?: SrtNetworkSettings;
  readonly filesystem: SrtFilesystemSettings;
}

export interface SrtSandboxEngineOptions extends ResolveSrtLaunchOptions {
  /**
   * Host-owned runtime roots that must remain readable after request-policy
   * intersection. These roots are always denied for writes and are not widened
   * to their parent directories.
   */
  readonly trustedReadRoots?: readonly string[];
}

export function createSandboxPolicy(input: SandboxPolicyInput = {}): SandboxPolicy {
  const mode = input.mode ?? "native";
  const root = normalizePath(input.root ?? process.cwd(), "root");
  const fallback = input.fallback ?? "fail-closed";
  const unsafeAllowHostProcess = input.unsafeAllowHostProcess === true;
  if (fallback === "unsafe-host-process" && !unsafeAllowHostProcess) {
    throw new SandboxPolicyError(
      "invalid_sandbox_policy",
      "unsafe-host-process fallback requires unsafeAllowHostProcess: true.",
      { field: "unsafeAllowHostProcess" },
    );
  }

  const readableRoots = normalizePathList(input.readableRoots ?? [root], root, "readableRoots");
  const writableRoots = normalizePathList(input.writableRoots ?? [root], root, "writableRoots");
  const denyWrite = normalizeStringList(input.denyWrite ?? DEFAULT_DENY_WRITE, "denyWrite");
  const tempRoot = normalizePath(input.tempRoot ?? resolve(root, ".mono-agent", "tmp"), "tempRoot");
  const network = normalizeNetworkPolicy(input.network);

  return {
    mode,
    engine: normalizeNonEmptyString(input.engine ?? "srt", "engine"),
    root,
    readableRoots,
    writableRoots,
    denyWrite,
    tempRoot,
    network,
    fallback,
    unsafeAllowHostProcess,
  };
}

export function failClosedSandboxPolicy(input: Omit<SandboxPolicyInput, "mode" | "fallback" | "unsafeAllowHostProcess"> = {}): SandboxPolicy {
  return createSandboxPolicy({
    ...input,
    mode: "native",
    fallback: "fail-closed",
    unsafeAllowHostProcess: false,
    network: input.network ?? { mode: "none" },
  });
}

export function sandboxRequired(policy: SandboxPolicy): boolean {
  return policy.mode !== "off" && policy.fallback === "fail-closed";
}

export function sandboxPolicyToRuntimeOptions(policy: SandboxPolicy): SandboxPolicyRuntimeOptions {
  return { sandboxPolicy: policy };
}

/**
 * Monotonic merge: the result is never more permissive than `configured`.
 * A request-scoped policy can only tighten roots, network access, and the
 * fallback; it can never re-enable host execution or widen filesystem access.
 */
export function mergeSandboxPolicies(
  configured: SandboxPolicy | undefined,
  request: SandboxPolicy | undefined,
): SandboxPolicy | undefined {
  if (configured === undefined) {
    return request;
  }
  if (request === undefined) {
    return configured;
  }
  if (configured.mode === "off") {
    return request.mode === "native" ? request : configured;
  }
  if (request.mode === "off") {
    return configured;
  }
  return {
    ...configured,
    readableRoots: intersectRoots(configured.readableRoots, request.readableRoots),
    writableRoots: intersectRoots(configured.writableRoots, request.writableRoots),
    denyWrite: [...new Set([...(configured.denyWrite ?? []), ...(request.denyWrite ?? [])])],
    network: mergeNetworkPolicies(configured.network, request.network),
    fallback: configured.fallback === "fail-closed" || request.fallback === "fail-closed"
      ? "fail-closed"
      : configured.fallback,
    unsafeAllowHostProcess: configured.unsafeAllowHostProcess && request.unsafeAllowHostProcess,
  };
}

export function createSrtSandboxEngine(options: SrtSandboxEngineOptions = {}): SandboxEngine {
  const trustedReadRoots = normalizeTrustedReadRoots(options.trustedReadRoots ?? []);
  // Cache only a successful functional proof. Failed probes are deliberately
  // retried so a user can install/repair SRT without restarting mono-agent.
  let provenLaunch: SrtLaunch | undefined;
  let pinnedLaunch: SrtLaunch | undefined;
  let activeProbe: Promise<boolean> | undefined;
  // The all-network embed path carries its own enforcement proof: it drives
  // SRT through its library entry instead of the CLI, so proving the CLI
  // launch says nothing about it.
  let provenEmbedEntry: SrtFileIdentity | undefined;
  let activeEmbedProbe: Promise<void> | undefined;

  async function resolveEmbedEntry(launch: SrtLaunch): Promise<SrtFileIdentity> {
    const cliPath = launch.prefixArgs.length === 1 ? launch.prefixArgs[0] : undefined;
    if (cliPath === undefined) {
      throw new SandboxUnavailableError(
        "All-network sandboxing drives SRT through its library entry, which only a managed or explicit node+cli SRT launch can host; a bare srt binary cannot.",
        { engine: "srt", source: launch.source },
      );
    }
    let entry: SrtFileIdentity;
    try {
      entry = await resolveTrustedFile(
        resolve(dirname(cliPath), "index.js"),
        true,
        "SRT library entry",
        launch.installRoot,
      );
    } catch (error) {
      throw new SandboxUnavailableError(
        `SRT library entry could not be resolved securely: ${errorMessage(error)}`,
        { engine: "srt" },
      );
    }
    if (provenEmbedEntry !== undefined && !sameFileIdentity(provenEmbedEntry, entry)) {
      throw new SandboxUnavailableError(
        "SRT library entry identity or content changed after its enforcement proof.",
        { engine: "srt" },
      );
    }
    return entry;
  }

  async function proveEmbedOnce(launch: SrtLaunch, entry: SrtFileIdentity, runnerPath: string): Promise<void> {
    if (provenEmbedEntry !== undefined && sameFileIdentity(provenEmbedEntry, entry)) {
      return;
    }
    activeEmbedProbe ??= proveSrtEmbedEnforcement(launch, entry, runnerPath)
      .then(() => {
        provenEmbedEntry = entry;
      })
      .finally(() => {
        activeEmbedProbe = undefined;
      });
    try {
      await activeEmbedProbe;
    } catch (error) {
      throw new SandboxUnavailableError(
        `SRT library entry failed its all-network enforcement proof: ${errorMessage(error)}`,
        { engine: "srt" },
      );
    }
  }

  async function prepareEmbedCommand(
    spec: SandboxCommandSpec,
    policy: SandboxPolicy,
    launch: SrtLaunch,
    cwd: string,
  ): Promise<PreparedSandboxCommand> {
    const entry = await resolveEmbedEntry(launch);
    const runnerPath = srtEmbedRunnerPath();
    await proveEmbedOnce(launch, entry, runnerPath);
    const runtimeReadRoots = await runtimeReadRootsForCommand(spec, cwd);
    const settings = await writeSrtSettingsFile(
      policy,
      runtimeReadRoots,
      spec.allowLocalBinding === true,
      trustedReadRoots,
    );
    return {
      ...spec,
      command: launch.command,
      args: [runnerPath, entry.path, "--settings", settings.path, "--", spec.command, ...(spec.args ?? [])],
      cwd,
      sandboxed: true,
      sandboxSettingsPath: settings.path,
      cleanup: settings.cleanup,
    };
  }

  return {
    id: "srt",
    isAvailable(): Promise<boolean> {
      if (provenLaunch !== undefined) {
        const expected = provenLaunch;
        // Re-resolve and compare path, filesystem identity, and content on every
        // status check. This catches managed corruption and external PATH/file
        // replacement without trusting the result of an earlier proof.
        return resolveSrtLaunch(options).then(
          (launch) => sameSrtLaunch(expected, launch),
          () => false,
        );
      }
      activeProbe ??= resolveSrtLaunch(options)
        .then(async (launch) => {
          await proveSrtEnforcement(launch);
          const revalidated = await resolveSrtLaunch(options);
          if (!sameSrtLaunch(launch, revalidated) || (pinnedLaunch !== undefined && !sameSrtLaunch(pinnedLaunch, revalidated))) {
            throw new Error("SRT executable identity or content changed during its functional proof");
          }
          pinnedLaunch = revalidated;
          provenLaunch = revalidated;
          return true;
        })
        .catch(() => false)
        .finally(() => {
          activeProbe = undefined;
        });
      return activeProbe;
    },
    async prepareCommand(spec: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand> {
      const cwd = resolve(spec.cwd ?? policy.root);
      let launch: SrtLaunch;
      try {
        // Re-resolve on every command and require the exact executable identity
        // that passed the functional proof (or the first direct preparation).
        launch = await resolveSrtLaunch(options);
        const expected = provenLaunch ?? pinnedLaunch;
        if (expected !== undefined && !sameSrtLaunch(expected, launch)) {
          throw new Error("SRT executable identity or content changed after validation");
        }
        pinnedLaunch ??= launch;
        await assertLaunchOutsideWritableRoots(launch, policy.writableRoots);
      } catch (error) {
        throw new SandboxUnavailableError(
          error instanceof ManagedSrtCorruptError
            ? error.message
            : `SRT could not be resolved securely: ${errorMessage(error)}`,
          { engine: "srt" },
        );
      }
      if (policy.network.mode === "all") {
        return await prepareEmbedCommand(spec, policy, launch, cwd);
      }
      const runtimeReadRoots = await runtimeReadRootsForCommand(spec, cwd);
      const settings = await writeSrtSettingsFile(
        policy,
        runtimeReadRoots,
        spec.allowLocalBinding === true,
        trustedReadRoots,
      );
      return {
        ...spec,
        command: launch.command,
        args: [...launch.prefixArgs, "--settings", settings.path, spec.command, ...(spec.args ?? [])],
        cwd,
        sandboxed: true,
        sandboxSettingsPath: settings.path,
        cleanup: settings.cleanup,
      };
    },
  };
}

const defaultEngines = new Map<SandboxEngineId, SandboxEngine>();

function resolveDefaultEngine(policy: SandboxPolicy): SandboxEngine | undefined {
  if (policy.engine !== "srt") {
    return undefined;
  }
  let engine = defaultEngines.get(policy.engine);
  if (engine === undefined) {
    engine = createSrtSandboxEngine();
    defaultEngines.set(policy.engine, engine);
  }
  return engine;
}

export async function resolveSandboxEffectiveState(input: {
  readonly policy?: SandboxPolicy;
  readonly engine?: SandboxEngine;
}): Promise<SandboxEffectiveState> {
  const policy = input.policy;
  if (policy == null || policy.mode === "off") {
    return {
      configured: false,
      configuredMode: policy?.mode,
      effective: "off",
      engine: policy?.engine,
      engineAvailable: undefined,
      fallback: policy?.fallback,
      fallbackActive: false,
      unsafeAllowHostProcess: policy?.unsafeAllowHostProcess ?? false,
    };
  }

  const engine = input.engine ?? resolveDefaultEngine(policy);
  const engineAvailable = engine === undefined ? false : await engine.isAvailable();
  if (engine !== undefined && engineAvailable) {
    return {
      configured: true,
      configuredMode: policy.mode,
      effective: "native",
      engine: engine.id,
      engineAvailable,
      fallback: policy.fallback,
      fallbackActive: false,
      unsafeAllowHostProcess: policy.unsafeAllowHostProcess,
    };
  }

  const fallbackActive = policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess;
  return {
    configured: true,
    configuredMode: policy.mode,
    effective: fallbackActive ? "unsafe-host-process" : "blocked",
    engine: engine?.id ?? policy.engine,
    engineAvailable,
    fallback: policy.fallback,
    fallbackActive,
    unsafeAllowHostProcess: policy.unsafeAllowHostProcess,
  };
}

export function sandboxEffectiveStateWarning(state: SandboxEffectiveState): string | undefined {
  if (state.fallbackActive && state.effective === "unsafe-host-process") {
    return `WARNING: Unsafe sandbox fallback is active: ${UNSAFE_HOST_PROCESS_CONSEQUENCE}.`;
  }
  return undefined;
}

export function describeSandboxEffectiveState(state: SandboxEffectiveState): string {
  if (!state.configured || state.effective === "off") {
    return "Sandbox is off; commands run without mono-agent sandbox wrapping.";
  }
  if (state.effective === "native") {
    return `Sandbox is effective with native engine "${state.engine ?? "unknown"}"; commands run sandboxed.`;
  }
  if (state.effective === "blocked") {
    return `Sandbox engine "${state.engine ?? "unknown"}" is unavailable; commands fail closed with sandbox_unavailable.`;
  }
  return `Sandbox unsafe-host-process fallback is active because engine "${state.engine ?? "unknown"}" is unavailable; ${UNSAFE_HOST_PROCESS_CONSEQUENCE}.`;
}

export async function prepareSandboxedCommand(input: PrepareSandboxedCommandInput): Promise<PreparedSandboxCommand> {
  const policy = input.policy;
  const command = normalizeCommandSpec(input.command, policy?.root);
  if (policy == null || policy.mode === "off") {
    return { ...command, sandboxed: false };
  }

  const engine = input.engine ?? resolveDefaultEngine(policy);
  if (engine === undefined || !(await engine.isAvailable())) {
    if (policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess) {
      return { ...command, sandboxed: false };
    }
    throw new SandboxUnavailableError(
      engine === undefined
        ? `No sandbox engine is registered for "${policy.engine}" and policy is fail-closed.`
        : "Sandbox engine is unavailable and policy is fail-closed.",
      {
        engine: engine?.id ?? policy.engine,
        command: command.command,
      },
    );
  }
  return engine.prepareCommand(command, policy);
}

const UNSAFE_HOST_PROCESS_CONSEQUENCE = "all sandbox roots/denyWrite entries are inert; commands run unsandboxed";

export function srtSettingsForPolicy(
  policy: SandboxPolicy,
  protectedSettingsPath?: string,
  runtimeReadRoots: readonly string[] = [],
  commandCapabilities: { readonly allowLocalBinding?: boolean } = {},
  trustedReadOnlyRoots: readonly string[] = [],
): SrtSettings {
  const filesystem: SrtFilesystemSettings = {
    denyRead: ["/"],
    allowRead: allowReadRootsForPolicy(policy, [...runtimeReadRoots, ...trustedReadOnlyRoots]),
    allowWrite: removeCoveredRoots(policy.writableRoots.map(canonicalPolicyPath).sort()),
    denyWrite: [
      ...serializeDenyWrite(policy),
      ...(protectedSettingsPath === undefined ? [] : [protectedSettingsPath]),
      ...trustedReadOnlyRoots,
    ],
  };
  if (policy.network.mode === "all") {
    return {
      filesystem: {
        ...filesystem,
        // With egress open, name resolution must work inside the sandbox.
        // getaddrinfo runs over mDNSResponder (reopened by the embed runner's
        // profile rules); res_*/Go-style resolvers read resolv.conf directly.
        // These must flow through SRT's own read-rule section — profile-level
        // file allows are overridden by its later deny-read block.
        allowRead: removeCoveredRoots([
          ...filesystem.allowRead,
          "/private/var/run/resolv.conf",
          "/var/run/resolv.conf",
        ].sort()),
      },
    };
  }
  return {
    network: {
      allowedDomains: domainsForNetworkPolicy(policy.network),
      deniedDomains: policy.network.mode === "none" ? ["*"] : [],
      strictAllowlist: true,
      allowLocalBinding: policy.network.mode === "localhost" || commandCapabilities.allowLocalBinding === true,
      allowAllUnixSockets: false,
    },
    filesystem,
  };
}

export function networkPolicyAllowsUrl(policy: SandboxPolicy | undefined, url: string): boolean {
  if (policy == null || policy.mode === "off") {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // URL.hostname keeps IPv6 hosts bracketed ("[::1]"); match on the bare host.
  const host = stripIpv6Brackets(parsed.hostname.toLowerCase());
  if (policy.network.mode === "all") {
    return true;
  }
  if (policy.network.mode === "none") {
    return false;
  }
  if (policy.network.mode === "localhost") {
    return isLocalhost(host);
  }
  return policy.network.allowlist.some((domain) => domainMatches(host, domain));
}

function normalizeCommandSpec(spec: SandboxCommandSpec, fallbackCwd: string | undefined): PreparedSandboxCommand {
  const command = normalizeNonEmptyString(spec.command, "command");
  const cwd = resolve(spec.cwd ?? fallbackCwd ?? process.cwd());
  return {
    command,
    args: normalizeArgs(spec.args ?? []),
    cwd,
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    ...(spec.allowLocalBinding === true ? { allowLocalBinding: true } : {}),
    sandboxed: false,
  };
}

// argv entries may legitimately be empty (e.g. `--prefix ""`) and whitespace is
// significant, so unlike policy fields they are only type-checked.
function normalizeArgs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "args must be an array.", { field: "args" });
  }
  return values.map((value, index) => {
    if (typeof value !== "string") {
      throw new SandboxPolicyError("invalid_sandbox_policy", `args[${index}] must be a string.`, { field: `args[${index}]` });
    }
    return value;
  });
}

function normalizeNetworkPolicy(input: SandboxNetworkPolicyInput | undefined): SandboxNetworkPolicy {
  const mode = input?.mode ?? "none";
  if (!SANDBOX_NETWORK_MODES.includes(mode)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "Invalid sandbox network mode.", { mode });
  }
  const allowlist = normalizeStringList(input?.allowlist ?? [], "network.allowlist")
    .map((domain) => domain.toLowerCase());
  if (mode === "allowlist" && allowlist.length === 0) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "allowlist network mode requires at least one domain.", {
      field: "network.allowlist",
    });
  }
  for (const [index, domain] of allowlist.entries()) {
    if (!isValidSrtDomainPattern(domain)) {
      throw new SandboxPolicyError(
        "invalid_sandbox_policy",
        `network.allowlist[${index}] is not a valid SRT domain pattern.`,
        { field: `network.allowlist[${index}]`, domain },
      );
    }
  }
  return {
    mode,
    allowlist: mode === "allowlist" ? allowlist : [],
  };
}

/**
 * Intersection semantics: the merged policy allows a host only if both
 * policies allow it. Incomparable modes (localhost vs allowlist) reduce to the
 * allowlist entries that are loopback hosts; an empty intersection is "none",
 * never an invalid empty allowlist.
 */
function mergeNetworkPolicies(
  configured: SandboxNetworkPolicy,
  request: SandboxNetworkPolicy | undefined,
): SandboxNetworkPolicy {
  if (request === undefined) {
    return configured;
  }
  if (configured.mode === "none" || request.mode === "none") {
    return { mode: "none", allowlist: [] };
  }
  if (configured.mode === "all") {
    return { mode: request.mode, allowlist: [...request.allowlist] };
  }
  if (request.mode === "all") {
    return { mode: configured.mode, allowlist: [...configured.allowlist] };
  }
  if (configured.mode === "localhost" && request.mode === "localhost") {
    return { mode: "localhost", allowlist: [] };
  }
  if (configured.mode === "allowlist" && request.mode === "allowlist") {
    const requestDomains = new Set(request.allowlist);
    const allowlist = configured.allowlist.filter((domain) => requestDomains.has(domain)).sort();
    return allowlist.length === 0 ? { mode: "none", allowlist: [] } : { mode: "allowlist", allowlist };
  }
  const loopbackEntries = (configured.mode === "allowlist" ? configured.allowlist : request.allowlist)
    .filter((domain) => isLocalhost(domain))
    .sort();
  return loopbackEntries.length === 0
    ? { mode: "none", allowlist: [] }
    : { mode: "allowlist", allowlist: loopbackEntries };
}

function intersectRoots(configured: readonly string[], request: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const configuredRoot of configured) {
    for (const requestRoot of request) {
      if (pathContains(configuredRoot, requestRoot)) {
        out.add(requestRoot);
      } else if (pathContains(requestRoot, configuredRoot)) {
        out.add(configuredRoot);
      }
    }
  }
  return removeCoveredRoots([...out].sort());
}

function domainsForNetworkPolicy(policy: SandboxNetworkPolicy): readonly string[] {
  if (policy.mode === "all") {
    throw new SandboxPolicyError(
      "invalid_sandbox_policy",
      "SRT allowedDomains does not accept a bare wildcard.",
      { field: "network.mode", mode: policy.mode },
    );
  }
  if (policy.mode === "localhost") {
    // SRT 0.0.64 rejects IPv6 literals in allowedDomains. allowLocalBinding
    // supplies the native loopback rule; the two valid host patterns keep
    // proxy-layer filtering strict and deterministic.
    return ["localhost", "127.0.0.1"];
  }
  if (policy.mode === "allowlist") {
    return [...policy.allowlist];
  }
  return [];
}

function allowReadRootsForPolicy(policy: SandboxPolicy, runtimeReadRoots: readonly string[]): readonly string[] {
  return removeCoveredRoots([
    ...SRT_IMMUTABLE_RUNTIME_READ_ROOTS,
    ...policy.readableRoots.flatMap(readPathAliases),
    ...runtimeReadRoots.map((root) => resolve(root)),
  ].sort());
}

function serializeDenyWrite(policy: SandboxPolicy): readonly string[] {
  const roots = [canonicalPolicyPath(policy.root)];
  return [...new Set((policy.denyWrite ?? DEFAULT_DENY_WRITE).flatMap((entry) => (
    isAbsolute(entry) ? [entry] : roots.map((root) => resolve(root, entry))
  )))];
}

function canonicalPolicyPath(path: string): string {
  const absolute = resolve(path);
  let ancestor = absolute;
  for (;;) {
    try {
      const canonicalAncestor = realpathSync.native(ancestor);
      const unresolvedTail = relative(ancestor, absolute);
      return unresolvedTail.length === 0 ? canonicalAncestor : resolve(canonicalAncestor, unresolvedTail);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      ancestor = parent;
    }
  }
}

function readPathAliases(path: string): readonly string[] {
  const absolute = resolve(path);
  return [...new Set([canonicalPolicyPath(absolute), ...symlinkAncestorsSync(absolute)])];
}

function normalizeTrustedReadRoots(roots: readonly string[]): readonly string[] {
  if (!Array.isArray(roots)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "trustedReadRoots must be an array.", {
      field: "trustedReadRoots",
    });
  }
  const normalized = roots.flatMap((root, index) => {
    if (typeof root !== "string" || root.trim().length === 0 || !isAbsolute(root)) {
      throw new SandboxPolicyError(
        "invalid_sandbox_policy",
        `trustedReadRoots[${index}] must be a non-empty absolute path.`,
        { field: `trustedReadRoots[${index}]` },
      );
    }
    const absolute = resolve(root);
    return [absolute, canonicalPolicyPath(absolute)];
  });
  return removeCoveredRoots([...new Set(normalized)].sort());
}

function symlinkAncestorsSync(path: string): readonly string[] {
  if (sep !== "/") return [];
  const links: string[] = [];
  let current = "/";
  for (const part of resolve(path).split("/").filter(Boolean)) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) links.push(current);
    } catch {
      break;
    }
  }
  return links;
}

async function writeSrtSettingsFile(
  policy: SandboxPolicy,
  runtimeReadRoots: readonly string[] = [],
  allowLocalBinding = false,
  trustedReadOnlyRoots: readonly string[] = [],
): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> {
  const directory = await createSettingsDirectoryOutsideWritableRoots(policy.writableRoots);
  const settingsPath = resolve(directory, "settings.json");
  const shellReadRoots = await runtimeShellReadRoots();
  const expandedRuntimeReadRoots = await expandRuntimeReadRoots([...runtimeReadRoots, ...shellReadRoots]);
  const content = `${JSON.stringify(srtSettingsForPolicy(
    policy,
    settingsPath,
    expandedRuntimeReadRoots,
    { allowLocalBinding },
    trustedReadOnlyRoots,
  ), null, 2)}\n`;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(
      settingsPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new SandboxUnavailableError(
      `Could not create a private one-use SRT settings file: ${errorMessage(error)}`,
      { engine: "srt" },
    );
  }
  await handle.close();

  let cleaned = false;
  return {
    path: settingsPath,
    async cleanup(): Promise<void> {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function normalizePath(value: string, field: string): string {
  return resolve(normalizeNonEmptyString(value, field));
}

function normalizePathList(values: readonly string[], root: string, field: string): readonly string[] {
  const paths = normalizeStringList(values, field).map((value) => resolve(root, value));
  return [...new Set(paths)];
}

function normalizeStringList(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", `${field} must be an array.`, { field });
  }
  return values.map((value, index) => normalizeNonEmptyString(value, `${field}[${index}]`));
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SandboxPolicyError("invalid_sandbox_policy", `${field} must be a string.`, { field });
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SandboxPolicyError("invalid_sandbox_policy", `${field} must not be empty.`, { field });
  }
  return normalized;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
}

function domainMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function isValidSrtDomainPattern(pattern: string): boolean {
  if (pattern === "*" || /[\s/:\[\]]/u.test(pattern)) {
    return false;
  }
  const host = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  if (host.length === 0 || host.length > 253 || host.startsWith(".") || host.endsWith(".")) {
    return false;
  }
  if (/^\d+(?:\.\d+){3}$/u.test(host)) {
    return host.split(".").every((part) => {
      const value = Number(part);
      return part.length > 0 && value >= 0 && value <= 255 && String(value) === String(Number(part));
    });
  }
  return host.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ));
}

function pathContains(root: string, target: string): boolean {
  return target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
}

function removeCoveredRoots(paths: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (out.some((root) => pathContains(root, path))) {
      continue;
    }
    out.push(path);
  }
  return out;
}

function sameSrtLaunch(expected: SrtLaunch, actual: SrtLaunch): boolean {
  return expected.source === actual.source
    && expected.command === actual.command
    && expected.installRoot === actual.installRoot
    && expected.prefixArgs.length === actual.prefixArgs.length
    && expected.prefixArgs.every((value, index) => value === actual.prefixArgs[index])
    && expected.files.length === actual.files.length
    && expected.files.every((file, index) => {
      const current = actual.files[index];
      return current !== undefined
        && file.path === current.path
        && file.sha256 === current.sha256
        && file.dev === current.dev
        && file.ino === current.ino
        && file.size === current.size;
    });
}

async function assertLaunchOutsideWritableRoots(launch: SrtLaunch, writableRoots: readonly string[]): Promise<void> {
  const canonicalWritableRoots = await Promise.all(writableRoots.map(canonicalizePotentialPath));
  if (launch.installRoot !== undefined) {
    const canonicalInstallRoot = await canonicalizePotentialPath(launch.installRoot);
    const overlap = canonicalWritableRoots.find((root) => pathsOverlap(root, canonicalInstallRoot));
    if (overlap !== undefined) {
      throw new Error(`managed SRT install root ${canonicalInstallRoot} overlaps writable root ${overlap}`);
    }
  }
  for (const file of launch.files) {
    const overlap = canonicalWritableRoots.find((root) => pathContains(root, file.path));
    if (overlap !== undefined) {
      throw new Error(`SRT executable file ${file.path} is inside writable root ${overlap}`);
    }
  }
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

async function runtimeReadRootsForCommand(spec: SandboxCommandSpec, cwd: string): Promise<readonly string[]> {
  return await firstExecutablePaths(runtimeCommandCandidates(spec.command, cwd, spec.env));
}

async function runtimeShellReadRoots(): Promise<readonly string[]> {
  const roots = new Set<string>();
  for (const path of await firstExecutablePaths(runtimeCommandCandidates("bash", process.cwd(), undefined))) {
    roots.add(path);
  }
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell !== undefined && configuredShell.length > 0) {
    for (const path of await firstExecutablePaths(runtimeCommandCandidates(configuredShell, process.cwd(), undefined))) {
      roots.add(path);
    }
  }
  return [...roots];
}

async function firstExecutablePaths(candidates: readonly string[]): Promise<readonly string[]> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const commandStat = await stat(canonical);
      if (commandStat.isFile()) {
        return [...new Set([resolve(candidate), canonical])];
      }
    } catch {
      // The wrapped command owns ordinary command-not-found reporting. Failure
      // to resolve it here must never widen the read policy.
    }
  }
  return [];
}

async function expandRuntimeReadRoots(roots: readonly string[]): Promise<readonly string[]> {
  const key = await runtimeReadExpansionKey(roots);
  const cached = runtimeReadExpansionCache.get(key);
  if (cached !== undefined) {
    return await cached;
  }
  const expansion = expandRuntimeReadRootsUncached(roots).catch((error) => {
    runtimeReadExpansionCache.delete(key);
    throw error;
  });
  runtimeReadExpansionCache.set(key, expansion);
  if (runtimeReadExpansionCache.size > MAX_RUNTIME_READ_EXPANSIONS) {
    const oldest = runtimeReadExpansionCache.keys().next().value;
    if (oldest !== undefined && oldest !== key) {
      runtimeReadExpansionCache.delete(oldest);
    }
  }
  return await expansion;
}

async function runtimeReadExpansionKey(roots: readonly string[]): Promise<string> {
  return (await Promise.all([...new Set(roots.map((root) => resolve(root)))].sort().map(async (root) => {
    try {
      const canonical = await realpath(root);
      const fileStat = await stat(canonical);
      return `${root}\0${canonical}\0${fileStat.dev}\0${fileStat.ino}\0${fileStat.size}\0${fileStat.mtimeMs}`;
    } catch {
      return `${root}\0missing`;
    }
  }))).join("\0");
}

async function expandRuntimeReadRootsUncached(roots: readonly string[]): Promise<readonly string[]> {
  const expanded = new Set(roots.flatMap((root) => {
    const absolute = resolve(root);
    return [absolute, dirname(absolute)];
  }));
  if (process.platform !== "darwin") {
    return [...expanded];
  }

  // Homebrew and other user-local runtimes commonly link libraries outside
  // the immutable OS roots. Derive narrow executable/library directories,
  // symlink traversal points, and OpenSSL config roots from the explicitly
  // selected runtime rather than unconditionally opening a package prefix.
  const queue = [...expanded];
  const inspected = new Set<string>();
  while (queue.length > 0 && inspected.size < 256) {
    const candidate = queue.shift();
    if (candidate === undefined) {
      break;
    }
    let canonical: string;
    try {
      canonical = await realpath(candidate);
      if (inspected.has(canonical) || isCoveredByImmutableRuntimeRoot(canonical)) {
        continue;
      }
      inspected.add(canonical);
      const { stdout } = await execFileAsync("/usr/bin/otool", ["-L", canonical], {
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      for (const line of stdout.split("\n").slice(1)) {
        const dependency = /^\s+(\S+)\s+\(/u.exec(line)?.[1];
        if (dependency === undefined) {
          continue;
        }
        const resolvedDependency = dependency.startsWith("@loader_path/")
          ? resolve(dirname(canonical), dependency.slice("@loader_path/".length))
          : dependency.startsWith("@executable_path/")
            ? resolve(dirname(canonical), dependency.slice("@executable_path/".length))
            : isAbsolute(dependency)
              ? dependency
              : undefined;
        if (resolvedDependency === undefined) {
          continue;
        }
        try {
          const canonicalDependency = await realpath(resolvedDependency);
          for (const path of [
            resolve(resolvedDependency),
            dirname(resolve(resolvedDependency)),
            canonicalDependency,
            dirname(canonicalDependency),
          ]) {
            if (!expanded.has(path)) {
              expanded.add(path);
              queue.push(path);
            }
          }
          const homebrewOpenSsl = /^(.*)\/opt\/(openssl(?:@[^/]+)?)\//u.exec(resolvedDependency);
          if (homebrewOpenSsl !== null) {
            const configRoot = resolve(homebrewOpenSsl[1] ?? "/", "etc", homebrewOpenSsl[2] ?? "openssl");
            try {
              const canonicalConfigRoot = await realpath(configRoot);
              expanded.add(configRoot);
              expanded.add(canonicalConfigRoot);
            } catch {
              // An absent optional OpenSSL config directory needs no grant.
            }
          }
        } catch {
          // The loader will report a missing dependency itself. Never widen to
          // a parent directory when an exact referenced file cannot be proven.
        }
      }
    } catch {
      // Static scripts and unsupported binaries have no dylib inventory. Their
      // exact file paths remain allowed; no broader fallback is introduced.
    }
  }
  for (const path of [...expanded]) {
    for (const symlink of await symlinkAncestors(path)) {
      expanded.add(symlink);
    }
  }
  return [...expanded];
}

async function symlinkAncestors(path: string): Promise<readonly string[]> {
  const links: string[] = [];
  const parts = resolve(path).split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        links.push(current);
      }
    } catch {
      break;
    }
  }
  return links;
}

function isCoveredByImmutableRuntimeRoot(path: string): boolean {
  return SRT_IMMUTABLE_RUNTIME_READ_ROOTS.some((root) => pathContains(root, path));
}

function runtimeCommandCandidates(
  command: string,
  cwd: string,
  env: Record<string, string | undefined> | undefined,
): readonly string[] {
  if (isAbsolute(command)) {
    return [resolve(command)];
  }
  if (command.includes(sep) || (sep === "\\" && command.includes("/"))) {
    return [resolve(cwd, command)];
  }
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (env?.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => extensions.map((extension) => resolve(entry, `${command}${extension}`)));
}

async function createSettingsDirectoryOutsideWritableRoots(writableRoots: readonly string[]): Promise<string> {
  const bases = [...new Set([tmpdir(), resolve(homedir(), ".cache")])];
  const canonicalWritableRoots = await Promise.all(writableRoots.map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return resolve(root);
    }
  }));
  for (const base of bases) {
    let directory: string | undefined;
    try {
      await mkdir(base, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(resolve(base, "mono-agent-srt-settings-"));
      await chmod(directory, 0o700);
      const canonicalDirectory = await realpath(directory);
      const directoryStat = await stat(canonicalDirectory);
      if (
        !directoryStat.isDirectory()
        || (process.getuid !== undefined && directoryStat.uid !== process.getuid())
        || (directoryStat.mode & 0o077) !== 0
      ) {
        throw new Error("settings directory is not private and owner-only");
      }
      if (canonicalWritableRoots.some((root) => pathContains(root, canonicalDirectory))) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      return canonicalDirectory;
    } catch {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
  throw new SandboxUnavailableError(
    "No private settings location exists outside the sandbox writable roots; refusing to expose mutable SRT policy.",
    { engine: "srt", writableRoots },
  );
}

function srtEmbedRunnerPath(): string {
  return fileURLToPath(new URL("./srt-embed-runner.mjs", import.meta.url));
}

function sameFileIdentity(expected: SrtFileIdentity, actual: SrtFileIdentity): boolean {
  return expected.path === actual.path
    && expected.sha256 === actual.sha256
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size;
}

/**
 * Functional proof for the all-network embed path: the SRT library entry must
 * still enforce every filesystem rule while a loopback connection — denied
 * under every CLI-launched policy this engine emits — succeeds, proving the
 * network side is genuinely unrestricted rather than silently blocked.
 */
async function proveSrtEmbedEnforcement(
  launch: SrtLaunch,
  entry: SrtFileIdentity,
  runnerPath: string,
): Promise<void> {
  const stagedBase = await mkdtemp(resolve(tmpdir(), "mono-agent-srt-embed-proof-"));
  const base = await realpath(stagedBase);
  const workspace = resolve(base, "workspace");
  const siblingSecret = resolve(base, "sibling-secret.txt");
  const allowedInput = resolve(workspace, "allowed.txt");
  const allowedOutput = resolve(workspace, "allowed-output.txt");
  const deniedOutput = resolve(base, "denied-output.txt");
  const deniedEnv = resolve(workspace, ".env");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("mono-agent-embed-ok");
  });
  let settings: Awaited<ReturnType<typeof writeSrtSettingsFile>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      writeFile(allowedInput, "allowed\n", { mode: 0o600 }),
      writeFile(siblingSecret, "secret\n", { mode: 0o600 }),
      writeFile(deniedEnv, "KEEP=true\n", { mode: 0o600 }),
    ]);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("embed proof loopback server did not expose a TCP port");
    }
    const policy = createSandboxPolicy({
      mode: "native",
      root: workspace,
      readableRoots: [workspace],
      writableRoots: [workspace],
      network: { mode: "all" },
      fallback: "fail-closed",
    });
    settings = await writeSrtSettingsFile(policy, [await realpath(process.execPath)]);
    const proofScript = [
      "const fs=require('node:fs');",
      "const [allowedInput,siblingSecret,allowedOutput,deniedOutput,deniedEnv,settingsPath,port]=process.argv.slice(1);",
      "if(fs.readFileSync(allowedInput,'utf8').trim()!=='allowed')process.exit(41);",
      "fs.writeFileSync(allowedOutput,'ok');",
      "try{fs.readFileSync(siblingSecret);process.exit(42)}catch{}",
      "try{fs.writeFileSync(deniedOutput,'bad');process.exit(43)}catch{}",
      "try{fs.writeFileSync(deniedEnv,'bad');process.exit(44)}catch{}",
      "try{fs.writeFileSync(settingsPath,'{}');process.exit(45)}catch{}",
      // System DNS must work under the unrestricted profile: resolver config
      // through the /etc symlink chain and the mDNSResponder socket (both
      // local and deterministic; no external lookup).
      "if(process.platform==='darwin'){",
      "try{fs.readFileSync('/etc/resolv.conf')}catch{process.exit(48)}",
      "const s=require('node:net').connect('/var/run/mDNSResponder');",
      "s.on('error',()=>process.exit(49));",
      "s.on('connect',()=>{s.destroy();run()});",
      "}else{run()}",
      "function run(){fetch('http://127.0.0.1:'+port+'/').then((r)=>r.text()).then((t)=>{process.exit(t==='mono-agent-embed-ok'?0:46)},()=>process.exit(47));}",
    ].join("");
    await execFileAsync(
      launch.command,
      [
        runnerPath,
        entry.path,
        "--settings",
        settings.path,
        "--",
        process.execPath,
        "-e",
        proofScript,
        allowedInput,
        siblingSecret,
        allowedOutput,
        deniedOutput,
        deniedEnv,
        settings.path,
        String(address.port),
      ],
      { cwd: workspace, timeout: 30_000, maxBuffer: 1_000_000 },
    );
    const [output, envContent] = await Promise.all([
      readFile(allowedOutput, "utf8"),
      readFile(deniedEnv, "utf8"),
    ]);
    if (output !== "ok" || envContent !== "KEEP=true\n") {
      throw new Error("SRT embed proof did not preserve filesystem restrictions");
    }
  } finally {
    server.close();
    await settings?.cleanup().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

async function proveSrtEnforcement(launch: SrtLaunch): Promise<void> {
  const stagedBase = await mkdtemp(resolve(tmpdir(), "mono-agent-srt-proof-"));
  const base = await realpath(stagedBase);
  const workspace = resolve(base, "workspace");
  const siblingSecret = resolve(base, "sibling-secret.txt");
  const allowedInput = resolve(workspace, "allowed.txt");
  const allowedOutput = resolve(workspace, "allowed-output.txt");
  const deniedOutput = resolve(base, "denied-output.txt");
  const deniedEnv = resolve(workspace, ".env");
  let settings: Awaited<ReturnType<typeof writeSrtSettingsFile>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      writeFile(allowedInput, "allowed\n", { mode: 0o600 }),
      writeFile(siblingSecret, "secret\n", { mode: 0o600 }),
      writeFile(deniedEnv, "KEEP=true\n", { mode: 0o600 }),
    ]);
    const policy = failClosedSandboxPolicy({
      root: workspace,
      readableRoots: [workspace],
      writableRoots: [workspace],
      network: { mode: "none" },
    });
    settings = await writeSrtSettingsFile(policy, [await realpath(process.execPath)]);
    const proofScript = [
      "const fs=require('node:fs');",
      "const [allowedInput,siblingSecret,allowedOutput,deniedOutput,deniedEnv,settingsPath]=process.argv.slice(1);",
      "if(fs.readFileSync(allowedInput,'utf8').trim()!=='allowed')process.exit(41);",
      "fs.writeFileSync(allowedOutput,'ok');",
      "try{fs.readFileSync(siblingSecret);process.exit(42)}catch{}",
      "try{fs.writeFileSync(deniedOutput,'bad');process.exit(43)}catch{}",
      "try{fs.writeFileSync(deniedEnv,'bad');process.exit(44)}catch{}",
      "try{fs.writeFileSync(settingsPath,'{}');process.exit(45)}catch{}",
    ].join("");
    await execFileAsync(
      launch.command,
      [
        ...launch.prefixArgs,
        "--settings",
        settings.path,
        process.execPath,
        "-e",
        proofScript,
        allowedInput,
        siblingSecret,
        allowedOutput,
        deniedOutput,
        deniedEnv,
        settings.path,
      ],
      { cwd: workspace, timeout: 15_000, maxBuffer: 1_000_000 },
    );
    const [output, envContent] = await Promise.all([
      readFile(allowedOutput, "utf8"),
      readFile(deniedEnv, "utf8"),
    ]);
    if (output !== "ok" || envContent !== "KEEP=true\n") {
      throw new Error("SRT functional proof did not preserve filesystem restrictions");
    }
  } finally {
    await settings?.cleanup().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

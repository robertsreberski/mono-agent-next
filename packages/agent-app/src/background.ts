import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { listRecordedRuns, listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

import {
  describeSensitiveDataExportWarning,
  phoenixAppBaseUrl,
  resolveAppTraceRegistryDir,
  resolveAppTraceStaleAfterMs,
} from "./app-config.js";
import { formatChannelFactValue } from "./channel-fact-format.js";
import { formatHumanChannelSections } from "./channel-status-display.js";
import { hasCompletedManagedStartup } from "./managed-startup.js";
import {
  bootout,
  bootstrap,
  buildLaunchdMaintenancePlistXml,
  buildPlistXml,
  defaultPathEnv,
  deriveLaunchdLabel,
  deriveLaunchdMaintenanceLabel,
  isLoaded,
  launchdManagedWorkerInfo,
  launchdServiceInfo,
  launchdPathsFor,
  MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV,
  makeLaunchctlRunner,
} from "./launchd.js";
import type {
  LaunchctlResult,
  LaunchctlRunner,
  LaunchdManagedWorkerDefinition,
  LaunchdPaths,
} from "./launchd.js";
import { selectBackgroundOperationalEnvironment } from "./background-environment.js";
import {
  beginLaunchdLogMaintenanceIntent,
  clearLaunchdLogMaintenanceIntent,
  inspectLaunchdLogs,
  LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS,
  markLaunchdLogMaintenanceRestoring,
  markLaunchdLogMaintenanceStopped,
  markLaunchdLogMaintenanceStopping,
  readLaunchdLogMaintenanceIntent,
  rotateStoppedLaunchdLogs,
} from "./launchd-logs.js";
import type { LaunchdLogInspection, LaunchdLogMaintenanceIntent } from "./launchd-logs.js";
import {
  ensureManagedBackgroundRuntime,
  inspectManagedRuntimeSourceIdentity,
  MANAGED_BACKGROUND_WORKER_ENV,
  verifyManagedRuntimeLaunch,
} from "./background-runtime.js";
import type {
  ManagedBackgroundRuntime,
  ManagedBackgroundRuntimeInput,
  ManagedRuntimeAdditionalPackage,
  ManagedRuntimeLaunchVerification,
  ManagedRuntimeSourceIdentity,
} from "./background-runtime.js";
import {
  backgroundSnapshotFromMetadata,
  captureBackgroundSnapshot,
  encodeBackgroundSnapshot,
  sameBackgroundSnapshot,
} from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { resolveConfiguredManagedRuntimePackages } from "./managed-runtime-packages.js";
import { acquireManagedRuntimePublicationBarrier } from "./managed-runtime-publication.js";
import {
  processIncarnationFromJson,
} from "./process-incarnation.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";
import { acquireOwnerPrivateLock, validateOwnerPrivateLockInputs } from "./owner-private-lock.js";
import type { OwnerPrivateLock } from "./owner-private-lock.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import {
  lifecycleFailure,
  maintenanceErrorMessage,
  pollUntil,
  uniquePids,
  unloadLaunchdService,
} from "./background-lifecycle-utils.js";
import type { PollOptions } from "./background-lifecycle-utils.js";
import {
  maintainLaunchdLogsOperation,
  reportMaintenanceFailure,
} from "./background-log-maintenance.js";
import * as ui from "./ui.js";

export type { PollOptions } from "./background-lifecycle-utils.js";

export {
  acquireBackgroundWorkerLease,
  backgroundWorkerLeasePath,
} from "./background-worker-lease.js";
export type {
  BackgroundWorkerLease,
  BackgroundWorkerLeaseOptions,
} from "./background-worker-lease.js";
export {
  LAUNCHD_LOG_MAX_BYTES,
  LAUNCHD_LOG_ROTATION_COUNT,
} from "./launchd-logs.js";

/**
 * Background-service orchestration for the mono-agent CLI. The interactive
 * control commands never talk to the worker directly: they derive a stable
 * launchd label + the trace-source registry location from the resolved config
 * path, drive `launchctl`, and read the worker's published manifest to learn
 * when it is up and what to print.
 */

export interface BackgroundCliArgs {
  readonly configPath?: string;
  readonly envFile?: string;
}

export interface InstanceTarget {
  readonly cwd: string;
  readonly configPath: string;
  readonly label: string;
  readonly registryDir: string;
  readonly staleAfterMs: number;
  readonly paths: LaunchdPaths;
  readonly nodePath: string;
  readonly cliPath: string;
  /** Mutable controller CLI retained only as inert runtime-installation input. */
  readonly controllerCliPath?: string;
  readonly envFile?: string;
  /**
   * Transient effective config environment reconstructed by the controller.
   * It may contain secrets: never serialize, log, or materialize it in launchd.
   */
  readonly configurationEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<Record<string, string>>;
  /** Exact wizard/approval snapshot this launch is allowed to claim ready. */
  readonly expectedSnapshot?: BackgroundSnapshot;
  /** Opaque proof that the selected managed runtime was finalized and verified. */
  readonly managedRuntimeLaunchProof?: string;
  /** Guided/configuration handoffs additionally require a usable TUI endpoint. */
  readonly requireTui?: boolean;
}

export interface BackgroundLifecycleTarget {
  readonly label: string;
  readonly paths: LaunchdPaths;
}

export interface ResolveInstanceTargetInput {
  readonly args: BackgroundCliArgs;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** Absolute path to the running cli.js, baked into the plist. */
  readonly cliPath: string;
  readonly requireTui?: boolean;
}

/** Exact non-secret environment materialised into a managed LaunchAgent. */
export function managedBackgroundEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return {
    ...selectBackgroundOperationalEnvironment(env),
    PATH: defaultPathEnv({ ...env }),
    // This is a lifecycle marker, not a config override. It tells cli.ts to
    // discard launchd's ambient environment before loading the chosen dotenv.
    [MANAGED_BACKGROUND_WORKER_ENV]: "1",
  };
}

/** Exact non-secret environment for the scheduled one-shot log maintainer. */
export function managedLaunchdLogMaintenanceEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return {
    ...selectBackgroundOperationalEnvironment(env),
    // This unattended helper needs only pinned system tools. Do not persist a
    // caller-controlled PATH that could shadow launchctl on a later run.
    PATH: "/usr/bin:/bin",
    [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1",
  };
}

/**
 * Resolve everything the control commands need from CLI args. The registry dir
 * and config path are resolved exactly as the worker will resolve them, so the
 * detached launcher can find the worker's manifest without any IPC.
 */
export async function resolveInstanceTarget(input: ResolveInstanceTargetInput): Promise<InstanceTarget> {
  const lexicalCwd = resolve(input.cwd);
  const [cwd, configPath] = await Promise.all([
    realpath(lexicalCwd),
    canonicalBackgroundConfigPath(lexicalCwd, input.args.configPath),
  ]);
  const configInput = { env: input.env, cwd, configPath };
  const [registryDir, staleAfterMs] = await Promise.all([
    resolveAppTraceRegistryDir(configInput),
    resolveAppTraceStaleAfterMs(configInput),
  ]);
  const label = deriveLaunchdLabel(configPath);
  return {
    cwd,
    configPath,
    label,
    registryDir,
    staleAfterMs,
    paths: launchdPathsFor(label),
    nodePath: process.execPath,
    cliPath: input.cliPath,
    controllerCliPath: input.cliPath,
    // Bake an explicit --env-file (resolved absolute) into the plist so the
    // launchd worker loads the same env file the launcher did.
    ...(input.args.envFile === undefined ? {} : { envFile: resolve(cwd, input.args.envFile) }),
    configurationEnvironment: { ...input.env },
    environment: managedBackgroundEnvironment(input.env),
    ...(input.requireTui === true ? { requireTui: true } : {}),
  };
}

/**
 * Collapse symlinked parent aliases without following the config's final path
 * component. The final component is separately required to be a regular,
 * non-symlink file before start; keeping it unresolved preserves that check.
 * Missing parents remain addressable so stop/status/logs can still operate on
 * a previously installed label after an agent folder is damaged or removed.
 */
export async function canonicalBackgroundConfigPath(
  cwd: string,
  configuredPath?: string,
): Promise<string> {
  const lexical = resolve(cwd, configuredPath ?? "mono-agent.config.json");
  try {
    const candidate = join(await realpath(dirname(lexical)), basename(lexical));
    try {
      const details = await lstat(candidate);
      // Preserve the final-component symlink so the start-time regular-file
      // check can reject it. For a real file, realpath also canonicalises the
      // stored filename casing on the default case-insensitive macOS volume.
      return details.isSymbolicLink() ? candidate : await realpath(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return candidate;
      throw error;
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return lexical;
    throw error;
  }
}

export interface BackgroundDeps {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly currentPid: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly listRecordedRuns: typeof listRecordedRuns;
  readonly listTraceSources: typeof listTraceSources;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly inspectLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogInspection>;
  readonly rotateStoppedLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<void>;
  readonly readLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogMaintenanceIntent | undefined>;
  readonly beginLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    intent: LaunchdLogMaintenanceIntent,
  ) => Promise<void>;
  readonly markLaunchdLogMaintenanceStopped: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly markLaunchdLogMaintenanceRestoring: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly markLaunchdLogMaintenanceStopping: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly clearLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected?: LaunchdLogMaintenanceIntent,
  ) => Promise<void>;
  /** Read and fingerprint the exact owner-private plist without mutating it. */
  readonly verifyLaunchdPlist: (path: string) => Promise<string>;
  /** True when a pid is still alive (or alive but owned by another user). */
  readonly isAlive: (pid: number) => boolean;
  /** Install/verify an immutable CLI outside npm/npx's disposable cache. */
  readonly ensureManagedRuntime: (input: ManagedBackgroundRuntimeInput) => Promise<ManagedBackgroundRuntime>;
  /** Inspect mutable source as inert bytes; never execute it. */
  readonly inspectManagedRuntimeSourceIdentity: (cliPath: string) => Promise<ManagedRuntimeSourceIdentity>;
  /** Verify the exact private closure and proof persisted in the loaded worker. */
  readonly verifyManagedRuntimeLaunch: (
    input: { readonly currentCliPath: string; readonly launchProof: string },
  ) => Promise<ManagedRuntimeLaunchVerification>;
  /** Resolve config-selected plugin-tier packages before the disposable source can disappear. */
  readonly resolveManagedRuntimePackages?: (
    target: InstanceTarget,
  ) => Promise<readonly ManagedRuntimeAdditionalPackage[]>;
  /** Fail closed when another lifecycle command owns this config label. */
  readonly acquireLifecycleLock: (target: BackgroundLifecycleTarget) => Promise<(() => Promise<void>) | undefined>;
  /** Hold KeepAlive respawns until the replacement runtime and plist are committed. */
  readonly acquireRuntimePublicationBarrier?: (target: BackgroundLifecycleTarget) => Promise<OwnerPrivateLock | undefined>;
  /** Prove a metadata-advertised TUI endpoint is actually reachable. */
  readonly probeTui: (source: TraceSourceListItem) => Promise<boolean>;
  readonly captureSnapshot?: (target: InstanceTarget) => Promise<BackgroundSnapshot>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Run `tail` with inherited stdio; resolves with its exit code. */
  readonly spawnTail: (args: readonly string[]) => Promise<number>;
}

export function defaultBackgroundDeps(): BackgroundDeps {
  return {
    runner: makeLaunchctlRunner(),
    getuid: () => process.getuid?.() ?? 0,
    currentPid: () => process.pid,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    listRecordedRuns,
    listTraceSources,
    writeFile: writeOwnerPrivateLaunchdFile,
    mkdir: ensureOwnerPrivateLaunchdDirectory,
    rm: (path) => rm(path, { force: true }),
    inspectLaunchdLogs: async (paths) => await inspectLaunchdLogs(paths),
    rotateStoppedLaunchdLogs: async (paths) => {
      await rotateStoppedLaunchdLogs(paths);
    },
    readLaunchdLogMaintenanceIntent: async (paths) => await readLaunchdLogMaintenanceIntent(paths),
    beginLaunchdLogMaintenanceIntent: async (paths, intent) => {
      await beginLaunchdLogMaintenanceIntent(paths, intent);
    },
    markLaunchdLogMaintenanceStopped: async (paths, expected) =>
      await markLaunchdLogMaintenanceStopped(paths, expected),
    markLaunchdLogMaintenanceRestoring: async (paths, expected) =>
      await markLaunchdLogMaintenanceRestoring(paths, expected),
    markLaunchdLogMaintenanceStopping: async (paths, expected) =>
      await markLaunchdLogMaintenanceStopping(paths, expected),
    clearLaunchdLogMaintenanceIntent: async (paths, expected) => {
      await clearLaunchdLogMaintenanceIntent(paths, expected);
    },
    verifyLaunchdPlist: inspectOwnerPrivateLaunchdPlist,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process exists but is owned by someone else.
        return isErrno(error, "EPERM");
      }
    },
    ensureManagedRuntime: (input) => ensureManagedBackgroundRuntime(input),
    inspectManagedRuntimeSourceIdentity,
    verifyManagedRuntimeLaunch,
    resolveManagedRuntimePackages: (target) => resolveConfiguredManagedRuntimePackages({
      cwd: target.cwd,
      configPath: target.configPath,
      env: target.configurationEnvironment,
    }),
    acquireLifecycleLock: acquireFilesystemLifecycleLock,
    acquireRuntimePublicationBarrier: (target) => acquireManagedRuntimePublicationBarrier({
      label: target.label,
      managedRoot: dirname(target.paths.logDir),
    }),
    probeTui: probeTuiEndpoint,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    spawnTail: (args) =>
      new Promise<number>((resolvePromise) => {
        const child = spawn("tail", [...args], { stdio: "inherit" });
        child.on("error", () => resolvePromise(127));
        child.on("close", (code) => resolvePromise(code ?? 0));
      }),
  };
}

export interface ReadyPollOptions extends PollOptions {
  /** Only accept a worker that started at or after this time (restart safety). */
  readonly sinceMs: number;
  readonly requireTui?: boolean;
}

const DEFAULT_CONTROL_POLL: PollOptions = { timeoutMs: 18_000, intervalMs: 400 };
const DEFAULT_READINESS_POLL: PollOptions = { timeoutMs: 60_000, intervalMs: 400 };

export type BackgroundLaunchAction = "started" | "restarted";

export type BackgroundLaunchResult =
  | {
      readonly ok: true;
      readonly action: BackgroundLaunchAction;
      /** The fresh, authoritative worker trace that proved startup complete. */
      readonly source: TraceSourceListItem;
    }
  | {
      readonly ok: false;
      readonly action: "start" | "restart";
      readonly reason: "runtime" | "snapshot" | "preparation" | "ownership" | "launchctl" | "readiness" | "timeout";
    };

export async function startBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll?: PollOptions,
): Promise<number> {
  return (await ensureBackgroundReady(target, deps, poll)).ok ? 0 : 1;
}

/** Restart is behaviourally identical: ensure a single fresh running instance. */
export async function restartBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll?: PollOptions,
): Promise<number> {
  return (await ensureBackgroundReady(target, deps, poll)).ok ? 0 : 1;
}

export interface LaunchdControllerOptions {
  /** False only when the originally installed controller checkout disappeared. */
  readonly sourceAvailable: boolean;
  readonly controlPoll?: PollOptions;
  readonly readinessPoll?: PollOptions;
}

/**
 * Private one-shot recovery controller invoked by the maintenance LaunchAgent.
 * It authenticates the exact helper PID launchd owns, compares the inert source
 * CLI identity with the strictly parsed loaded worker definition, and repairs
 * only when the worker, snapshot, definition, or available source closure has
 * drifted. A healthy worker remains serving while a replacement runtime is
 * materialized.
 */
export async function maintainLaunchdController(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: LaunchdControllerOptions,
): Promise<number> {
  const helper = maintenancePathsForTarget(target);
  const uid = deps.getuid();
  const helperService = await launchdServiceInfo(deps.runner, helper.label, uid);
  const helperPid = deps.currentPid();
  if (!helperService.loaded || helperService.pid !== helperPid || !deps.isAlive(helperPid)) {
    reportMaintenanceFailure(
      target,
      deps,
      "authenticate the launchd-owned recovery controller",
      new Error(`launchd does not own this helper pid ${helperPid}`),
    );
    return 1;
  }

  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    // A manual lifecycle command owns the label. The helper exits cleanly so
    // that command can boot it out; StartInterval supplies the next retry.
    return 0;
  }
  let maintainLogsOnly = false;
  let resultCode = 1;
  try {
    const [worker, sources, desiredIdentity] = await Promise.all([
      launchdManagedWorkerInfo(deps.runner, target.label, uid),
      findInstances(target, deps),
      deps.inspectManagedRuntimeSourceIdentity(target.cliPath),
    ]);
    let loadedIdentity: ManagedRuntimeLaunchVerification | undefined;
    if (worker.definition !== undefined) {
      try {
        loadedIdentity = await deps.verifyManagedRuntimeLaunch({
          currentCliPath: worker.definition.cliPath,
          launchProof: worker.definition.expectedManagedRuntimeLaunch,
        });
      } catch {
        // A malformed/unverified loaded closure is a recovery condition. Do not
        // trust any identity or execute its advertised CLI.
      }
    }
    const source = worker.pid === undefined
      ? undefined
      : sources.find((candidate) => candidate.pid === worker.pid);
    const durableSnapshotStillMatches = await snapshotStillMatches(target, deps);
    const workerHealthy = worker.loaded
      && worker.pid !== undefined
      && deps.isAlive(worker.pid)
      && source !== undefined
      && isReady(source, false)
      && snapshotMetadataMatches(source, target.expectedSnapshot)
      && durableSnapshotStillMatches;
    const definitionMatches = worker.definition !== undefined
      && managedWorkerDefinitionMatchesTarget(worker.definition, target);
    const runtimeMatches = loadedIdentity !== undefined
      && sameManagedRuntimeIdentity(loadedIdentity, desiredIdentity);
    const needsRecovery = !workerHealthy
      || !definitionMatches
      || loadedIdentity === undefined
      || (options.sourceAvailable && !runtimeMatches);
    if (!needsRecovery) {
      maintainLogsOnly = true;
      resultCode = 0;
    } else {
      if (!options.sourceAvailable) {
        deps.stderr(ui.style.dim(
          `The original controller CLI is unavailable; recovering ${target.label} from the helper's private closure without claiming an upgrade.`,
        ) + "\n");
      }
      const recovered = await ensureBackgroundReadyUnlocked(
        target,
        deps,
        options.controlPoll ?? DEFAULT_CONTROL_POLL,
        options.readinessPoll ?? DEFAULT_READINESS_POLL,
        { preserveMaintenanceService: true, preserveDefinitionsOnFailure: true },
      );
      resultCode = recovered.ok ? 0 : 1;
    }
  } catch (error) {
    reportMaintenanceFailure(target, deps, "reconcile the managed worker", error);
    resultCode = 1;
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
  return maintainLogsOnly
    ? await maintainLaunchdLogs(target, deps, options.controlPoll ?? DEFAULT_CONTROL_POLL)
    : resultCode;
}

function managedWorkerDefinitionMatchesTarget(
  definition: LaunchdManagedWorkerDefinition,
  target: InstanceTarget,
): boolean {
  return target.expectedSnapshot !== undefined
    && definition.plistPath === target.paths.plistPath
    && definition.nodePath === target.nodePath
    && definition.configPath === target.configPath
    && definition.cwd === target.cwd
    && definition.envFile === target.envFile
    && definition.stdoutPath === target.paths.stdoutPath
    && definition.stderrPath === target.paths.stderrPath
    && definition.expectedBackgroundSnapshot === encodeBackgroundSnapshot(target.expectedSnapshot)
    && sameStringRecord(definition.environment, target.environment);
}

function sameManagedRuntimeIdentity(
  loaded: Pick<ManagedRuntimeLaunchVerification, "packageVersion" | "cliSha256">,
  desired: ManagedRuntimeSourceIdentity,
): boolean {
  return loaded.packageVersion === desired.packageVersion && loaded.cliSha256 === desired.cliSha256;
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const rightEntries = Object.entries(right).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([name, value], index) => {
      const other = rightEntries[index];
      return other?.[0] === name && other[1] === value;
    });
}

/**
 * Stop, perform the caller's stopped-worker mutation, and start again while
 * retaining one lifecycle lock. This closes the force-restart gap in which a
 * concurrent start could previously enter while the session store was purged.
 */
export async function forceRestartBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  whileStopped: () => Promise<void>,
  poll?: PollOptions,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("No LaunchAgent or session changes were made. Wait for that command to finish, then retry."));
    return 1;
  }
  try {
    const controlPoll = poll ?? DEFAULT_CONTROL_POLL;
    const stopCode = await stopBackgroundUnlocked(target, deps, controlPoll);
    if (stopCode !== 0) return stopCode;
    await whileStopped();
    return (await ensureBackgroundReadyUnlocked(
      target,
      deps,
      controlPoll,
      poll ?? DEFAULT_READINESS_POLL,
    )).ok ? 0 : 1;
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

/**
 * Private one-shot invoked only by the scheduled maintenance LaunchAgent. It
 * never creates or rewrites a service definition. It does not resurrect an
 * intentionally stopped service; the sole exception is recovery authorized by
 * its own durable lifecycle intent after a prior maintainer died post-bootout.
 */
export async function maintainLaunchdLogs(
  target: BackgroundLifecycleTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_CONTROL_POLL,
): Promise<number> {
  return await maintainLaunchdLogsOperation(target, deps, poll);
}

/**
 * Ensure the canonical per-config LaunchAgent is running and return the fresh
 * trace source that proved it completed the full startup lifecycle. This is the shared
 * lifecycle boundary for CLI start/restart and remote configuration handoffs;
 * callers must not open a console when the result is not ok.
 */
export async function ensureBackgroundReady(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll?: PollOptions,
): Promise<BackgroundLaunchResult> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("No LaunchAgent changes were made. Wait for that command to finish, then retry."));
    return { ok: false, action: "start", reason: "ownership" };
  }
  try {
    return await ensureBackgroundReadyUnlocked(
      target,
      deps,
      poll ?? DEFAULT_CONTROL_POLL,
      poll ?? DEFAULT_READINESS_POLL,
    );
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

async function ensureBackgroundReadyUnlocked(
  target: InstanceTarget,
  deps: BackgroundDeps,
  controlPoll: PollOptions,
  readinessPoll: PollOptions,
  options: BackgroundReadyInternalOptions = {},
): Promise<BackgroundLaunchResult> {
  if (target.expectedSnapshot === undefined) {
    deps.stderr(ui.errorLine("Refusing to launch a managed worker without an approved background snapshot."));
    deps.stderr(ui.hint("No LaunchAgent changes were made. Retry from the wizard or `mono-agent start`."));
    return { ok: false, action: "start", reason: "snapshot" };
  }
  if (!(await snapshotStillMatches(target, deps))) {
    reportSnapshotDrift(target, deps);
    return { ok: false, action: "start", reason: "snapshot" };
  }
  let publicationBarrier: OwnerPrivateLock | undefined;
  try {
    publicationBarrier = await (deps.acquireRuntimePublicationBarrier
      ?? ((input: BackgroundLifecycleTarget) => acquireManagedRuntimePublicationBarrier({
        label: input.label,
        managedRoot: dirname(input.paths.logDir),
      })))(target);
  } catch (error) {
    reportLifecycleException(target, deps, "establish the managed runtime publication barrier", error);
    return { ok: false, action: "start", reason: "ownership" };
  }
  if (publicationBarrier === undefined) {
    deps.stderr(ui.errorLine(`Another runtime publication is already active for ${target.label}.`));
    return { ok: false, action: "start", reason: "ownership" };
  }
  return await ensureBackgroundReadyWithPublicationBarrier(
    target,
    deps,
    controlPoll,
    readinessPoll,
    publicationBarrier,
    options,
  );
}

interface BackgroundReadyInternalOptions {
  /** Recovery helpers cannot boot out and wait for their own launchd process. */
  readonly preserveMaintenanceService?: boolean;
  /** Scheduled recovery keeps both definitions so StartInterval can retry. */
  readonly preserveDefinitionsOnFailure?: boolean;
}

async function ensureBackgroundReadyWithPublicationBarrier(
  target: InstanceTarget,
  deps: BackgroundDeps,
  controlPoll: PollOptions,
  readinessPoll: PollOptions,
  publicationBarrier: OwnerPrivateLock,
  options: BackgroundReadyInternalOptions,
): Promise<BackgroundLaunchResult> {
  let barrierReleased = false;
  const releaseBarrier = async (): Promise<void> => {
    if (barrierReleased) return;
    await publicationBarrier.release();
    barrierReleased = true;
  };
  try {
    return await ensureBackgroundReadyAfterPublicationBarrier(
      target,
      deps,
      controlPoll,
      readinessPoll,
      releaseBarrier,
      options,
    );
  } finally {
    if (!barrierReleased) {
      await releaseBarrier().catch((error: unknown) => {
        deps.stderr(ui.errorLine(
          `Could not release runtime publication barrier for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      });
    }
  }
}

async function ensureBackgroundReadyAfterPublicationBarrier(
  target: InstanceTarget,
  deps: BackgroundDeps,
  controlPoll: PollOptions,
  readinessPoll: PollOptions,
  releaseBarrier: () => Promise<void>,
  options: BackgroundReadyInternalOptions,
): Promise<BackgroundLaunchResult> {
  const uid = deps.getuid();
  let launchTarget: InstanceTarget;
  const runtimeStartedAt = deps.now();
  deps.stdout(ui.hint("Verifying the durable managed runtime…"));
  try {
    const additionalPackages = await deps.resolveManagedRuntimePackages?.(target) ?? [];
    const runtime = await deps.ensureManagedRuntime({
      currentCliPath: target.cliPath,
      nodePath: target.nodePath,
      additionalPackages,
    });
    launchTarget = {
      ...target,
      cliPath: runtime.cliPath,
      nodePath: runtime.nodePath,
      managedRuntimeLaunchProof: runtime.launchProof,
    };
    deps.stdout(ui.hint(
      `Managed runtime ready (${runtimeVerificationLabel(runtime.verificationMode)}, `
      + `${formatLifecycleDuration(deps.now() - runtimeStartedAt)}).`,
    ));
  } catch (error) {
    reportLifecycleException(target, deps, "install and verify the durable managed runtime", error);
    return { ok: false, action: "start", reason: "runtime" };
  }

  // Runtime materialisation can involve npm/native installation. Recheck the
  // approved files after that unbounded external work and before writing any
  // LaunchAgent state.
  if (!(await snapshotStillMatches(launchTarget, deps))) {
    reportSnapshotDrift(launchTarget, deps);
    return { ok: false, action: "start", reason: "snapshot" };
  }

  try {
    const conflict = await findOwnershipConflict(launchTarget, deps, uid);
    if (conflict !== undefined) {
      reportOwnershipConflict(launchTarget, deps, conflict);
      return { ok: false, action: "start", reason: "ownership" };
    }
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "verify the existing background worker ownership", error);
    return { ok: false, action: "start", reason: "ownership" };
  }

  let sinceMs = deps.now();
  try {
    await prepareLaunchdDirectories(launchTarget, deps);
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "prepare the LaunchAgent directories", error);
    return { ok: false, action: "start", reason: "preparation" };
  }
  let outcome: LaunchOutcome;
  let prepared = false;
  deps.stdout(ui.hint("Replacing the managed worker…"));
  try {
    let interruptedMaintenance = await deps.readLaunchdLogMaintenanceIntent(launchTarget.paths);
    if (interruptedMaintenance?.phase === "stopping" || interruptedMaintenance?.phase === "restoring") {
      const current = await launchdServiceInfo(deps.runner, launchTarget.label, uid);
      if (!current.loaded) {
        throw new Error(
          "Interrupted launchd-log maintenance lost its writer PID before durable stopped-writer proof; refusing restart.",
        );
      }
    }
    outcome = await bootstrapOrRestart(launchTarget, deps, uid, controlPoll, async () => {
      const stoppedIntent = interruptedMaintenance;
      if (stoppedIntent?.phase === "stopped") {
        interruptedMaintenance = await deps.markLaunchdLogMaintenanceStopping(
          launchTarget.paths,
          stoppedIntent,
        );
      }
    }, async (mainStopProven) => {
      const stoppingIntent = interruptedMaintenance;
      if (stoppingIntent?.phase === "stopping" || stoppingIntent?.phase === "restoring") {
        if (!mainStopProven) {
          throw new Error("The controller could not renew stopped-writer proof for interrupted log maintenance.");
        }
        interruptedMaintenance = await deps.markLaunchdLogMaintenanceStopped(
          launchTarget.paths,
          stoppingIntent,
        );
      }
      await deps.rotateStoppedLaunchdLogs(launchTarget.paths);
      // A controller may be completing a maintainer that died after bootout.
      // Once journal recovery finishes under the stopped-writer proof, cancel
      // its old restore authority before replacing either plist.
      await deps.clearLaunchdLogMaintenanceIntent(launchTarget.paths, interruptedMaintenance);
      await writePlists(launchTarget, deps);
      sinceMs = deps.now();
      prepared = true;
      // The replacement plist now contains the finalized-runtime proof. Let
      // launchd respawn only after the stopped-window commit is complete.
      await releaseBarrier();
    }, { preserveMaintenanceService: options.preserveMaintenanceService === true });
  } catch (error) {
    reportLifecycleException(
      launchTarget,
      deps,
      prepared ? "start the LaunchAgent" : "prepare the stopped LaunchAgent",
      error,
    );
    return { ok: false, action: "start", reason: prepared ? "launchctl" : "preparation" };
  }
  const action = outcome.restarted ? "restart" as const : "start" as const;
  if (!outcome.ok) {
    reportLaunchFailure(launchTarget, deps, action, outcome.failure);
    return { ok: false, action, reason: "launchctl" };
  }
  deps.stdout(ui.hint("Waiting for the worker to report ready…"));
  let ready: TraceSourceListItem | undefined;
  try {
    ready = await pollInstanceReady(launchTarget, deps, {
      ...readinessPoll,
      sinceMs,
      ...(launchTarget.requireTui === true ? { requireTui: true } : {}),
    });
  } catch (error) {
    reportReadinessException(deps, error);
    const stopped = await cleanUpUnreadyBackground(launchTarget, deps, controlPoll, options);
    reportReadinessCleanup(launchTarget, deps, stopped, options);
    return { ok: false, action, reason: "readiness" };
  }
  if (ready === undefined) {
    if (!(await snapshotStillMatches(launchTarget, deps))) {
      const stopped = await cleanUpUnreadyBackground(launchTarget, deps, controlPoll, options) ? 0 : 1;
      reportSnapshotDrift(launchTarget, deps);
      if (stopped === 0) {
        deps.stderr(ui.style.dim("The drifted LaunchAgent was stopped before returning control.") + "\n");
      } else {
        deps.stderr(ui.style.yellow("The drifted LaunchAgent could not be proven stopped; follow the recovery commands above.") + "\n");
      }
      return { ok: false, action, reason: "snapshot" };
    }
    reportTimeout(deps);
    const stopped = await cleanUpUnreadyBackground(launchTarget, deps, controlPoll, options);
    reportReadinessCleanup(launchTarget, deps, stopped, options);
    return { ok: false, action, reason: "timeout" };
  }
  const completedAction = outcome.restarted ? "restarted" as const : "started" as const;
  printInstanceInfo(ready, launchTarget, deps, completedAction);
  return { ok: true, action: completedAction, source: ready };
}

function runtimeVerificationLabel(mode: ManagedBackgroundRuntime["verificationMode"]): string {
  switch (mode) {
    case "fast-reuse": return "warm reuse";
    case "full-reuse": return "full verification";
    case "installed": return "installed";
    case "repaired": return "repaired";
  }
}

function formatLifecycleDuration(milliseconds: number): string {
  const safe = Math.max(0, milliseconds);
  return safe < 1_000 ? `${Math.round(safe)} ms` : `${(safe / 1_000).toFixed(1)} s`;
}

async function prepareLaunchdDirectories(target: InstanceTarget, deps: BackgroundDeps): Promise<void> {
  // launchd will not create the log file's parent directory, so make both dirs
  // before writing the plist that references them.
  await deps.mkdir(dirname(target.paths.logDir));
  await deps.mkdir(target.paths.logDir);
  await deps.mkdir(target.paths.launchAgentsDir);
}

async function writePlists(target: InstanceTarget, deps: BackgroundDeps): Promise<void> {
  if (target.expectedSnapshot === undefined) {
    throw new Error("A managed LaunchAgent requires an approved background snapshot.");
  }
  if (target.managedRuntimeLaunchProof === undefined) {
    throw new Error("A managed LaunchAgent requires a finalized runtime launch proof.");
  }
  const agentPath = target.environment.PATH;
  if (agentPath === undefined || agentPath.length === 0) {
    throw new Error("A managed LaunchAgent recovery controller requires the durable worker PATH.");
  }
  const maintenance = maintenancePathsForTarget(target);
  const mainXml = buildPlistXml({
    label: target.label,
    nodePath: target.nodePath,
    cliPath: target.cliPath,
    configPath: target.configPath,
    cwd: target.cwd,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    expectedBackgroundSnapshot: encodeBackgroundSnapshot(target.expectedSnapshot),
    expectedManagedRuntimeLaunch: target.managedRuntimeLaunchProof,
    stdoutPath: target.paths.stdoutPath,
    stderrPath: target.paths.stderrPath,
    environment: target.environment,
  });
  const maintenanceXml = buildLaunchdMaintenancePlistXml({
    label: maintenance.label,
    nodePath: target.nodePath,
    cliPath: target.cliPath,
    configPath: target.configPath,
    controllerCliPath: target.controllerCliPath ?? target.cliPath,
    agentCwd: target.cwd,
    agentPath,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    // The agent folder may be renamed or removed while its already-running
    // worker still owns log descriptors. Keep the scheduler's cwd in the
    // durable account state tree; its config argument is already absolute.
    cwd: dirname(target.paths.logDir),
    environment: managedLaunchdLogMaintenanceEnvironment(target.environment),
    intervalSeconds: LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS,
  });
  await deps.writeFile(target.paths.plistPath, mainXml);
  await deps.writeFile(maintenance.plistPath, maintenanceXml);
}

export async function ensureOwnerPrivateLaunchdDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  const parentDetails = await lstat(parent);
  assertOwnerDirectory(parentDetails, parent, "LaunchAgent parent");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const parentAfter = await lstat(parent);
  assertOwnerDirectory(parentAfter, parent, "LaunchAgent parent");
  if (!sameFilesystemIdentity(parentDetails, parentAfter)) {
    throw new Error(`LaunchAgent parent ${parent} changed while ${path} was created.`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    assertOwnerDirectory(before, path, "LaunchAgent directory");
    await handle.chmod(0o700);
    const secured = await handle.stat();
    if (!sameFilesystemIdentity(before, secured)) {
      throw new Error(`LaunchAgent directory ${path} changed while it was secured.`);
    }
    assertOwnerDirectory(secured, path, "LaunchAgent directory");
    if ((secured.mode & 0o077) !== 0) {
      throw new Error(`LaunchAgent directory ${path} must be owner-only.`);
    }
    const current = await lstat(path);
    if (!sameFilesystemIdentity(secured, current)) {
      throw new Error(`LaunchAgent directory ${path} changed while it was secured.`);
    }
  } finally {
    await handle.close();
  }
}

export async function writeOwnerPrivateLaunchdFile(path: string, data: string): Promise<void> {
  let existing: Stats | undefined;
  try {
    existing = await lstat(path);
    assertOwnerRegularFile(existing, path, "LaunchAgent plist");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporary = await lstat(temporaryPath);
    assertOwnerRegularFile(temporary, temporaryPath, "temporary LaunchAgent plist");
    if ((temporary.mode & 0o777) !== 0o600) {
      throw new Error(`Temporary LaunchAgent plist ${temporaryPath} must be owner-readable and owner-writable only.`);
    }

    let current: Stats | undefined;
    try {
      current = await lstat(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (
      (existing === undefined) !== (current === undefined)
      || (existing !== undefined && current !== undefined && !sameFilesystemIdentity(existing, current))
    ) {
      throw new Error(`LaunchAgent plist ${path} changed before the new definition was committed.`);
    }

    await rename(temporaryPath, path);
    const committed = await lstat(path);
    assertOwnerRegularFile(committed, path, "LaunchAgent plist");
    if (!sameFilesystemIdentity(temporary, committed)) {
      throw new Error(`LaunchAgent plist ${path} changed while the new definition was committed.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function inspectOwnerPrivateLaunchdPlist(path: string): Promise<string> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    assertOwnerRegularFile(before, path, "LaunchAgent plist");
    if ((before.mode & 0o777) !== 0o600) {
      throw new Error(`LaunchAgent plist ${path} must be owner-only.`);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > 1024 * 1024) {
      throw new Error(`LaunchAgent plist ${path} has an unsafe size.`);
    }
    const contents = await readExactFileHandle(handle, before.size, "LaunchAgent plist");
    const after = await handle.stat();
    assertOwnerRegularFile(after, path, "LaunchAgent plist");
    if ((after.mode & 0o777) !== 0o600
      || !sameFileSnapshot(before, after)
      || contents.length !== before.size) {
      throw new Error(`LaunchAgent plist ${path} changed while it was read.`);
    }
    const current = await lstat(path);
    assertOwnerRegularFile(current, path, "LaunchAgent plist");
    if ((current.mode & 0o777) !== 0o600 || !sameFileSnapshot(after, current)) {
      throw new Error(`LaunchAgent plist ${path} changed while it was inspected.`);
    }
    return [
      String(after.dev),
      String(after.ino),
      String(after.size),
      createHash("sha256").update(contents).digest("hex"),
    ].join(":");
  } finally {
    await handle.close();
  }
}

async function readExactFileHandle(handle: FileHandle, size: number, description: string): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${description} has an unsafe size.`);
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(contents, offset, size - offset, offset);
    if (result.bytesRead === 0) throw new Error(`${description} ended while its bounded contents were read.`);
    offset += result.bytesRead;
  }
  return contents;
}

function assertOwnerDirectory(details: Stats, path: string, description: string): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${description} ${path} must be a real directory.`);
  }
  assertCurrentUserOwns(details, path, description);
}

function assertOwnerRegularFile(details: Stats, path: string, description: string): void {
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${description} ${path} must be a regular non-symbolic-link file.`);
  }
  if (details.nlink !== 1) {
    throw new Error(`${description} ${path} must have exactly one filesystem link.`);
  }
  assertCurrentUserOwns(details, path, description);
}

function assertCurrentUserOwns(details: Stats, path: string, description: string): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${description} ${path} is not owned by the current user.`);
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFilesystemIdentity(left, right)
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

type LaunchOutcome =
  | { readonly ok: true; readonly restarted: boolean }
  | { readonly ok: false; readonly restarted: boolean; readonly failure: LaunchctlResult };

/**
 * Idempotent: bootstrap when not loaded. A loaded job is always fully removed
 * before bootstrap so launchd cannot retain stale ProgramArguments or env from
 * the previous plist.
 */
async function bootstrapOrRestart(
  target: InstanceTarget,
  deps: BackgroundDeps,
  uid: number,
  poll: PollOptions,
  beforeMainBootout: () => Promise<void>,
  whileStopped: (mainStopProven: boolean) => Promise<void>,
  options: { readonly preserveMaintenanceService?: boolean } = {},
): Promise<LaunchOutcome> {
  const maintenance = maintenancePathsForTarget(target);
  const [service, maintenanceService] = await Promise.all([
    launchdServiceInfo(deps.runner, target.label, uid),
    launchdServiceInfo(deps.runner, maintenance.label, uid),
  ]);
  const restarted = service.loaded;

  // Stop the scheduler first. A helper that is already running either holds
  // this lifecycle lock (so the controller could not enter) or is waiting to
  // acquire it; bootout plus PID death prevents a post-stop resurrection.
  if (options.preserveMaintenanceService !== true) {
    const maintenanceStopped = await unloadLaunchdService(
      maintenance.label,
      maintenanceService,
      uniquePids([maintenanceService.pid]),
      deps,
      uid,
      poll,
    );
    if (!maintenanceStopped.ok) {
      return { ok: false, restarted, failure: maintenanceStopped.failure };
    }
  }

  let mainStopProven = false;
  if (service.loaded) {
    const oldSources = await findInstances(target, deps);
    const oldPids = uniquePids([
      service.pid,
      // A cleanly stopped manifest can outlive its process long enough for the OS
      // to reuse that pid for unrelated work. It is historical evidence, not an
      // ownership claim, so never wait for its recycled pid during restart.
      ...oldSources
        .filter((source) => source.health !== "stopped")
        .map((source) => source.pid),
    ]);
    const mainStopped = await unloadLaunchdService(
      target.label,
      service,
      oldPids,
      deps,
      uid,
      poll,
      beforeMainBootout,
    );
    if (!mainStopped.ok) {
      const restoreFailure = options.preserveMaintenanceService === true
        ? undefined
        : await restoreMaintenanceDefinition(
            maintenanceService.loaded,
            maintenance,
            deps,
            uid,
            poll,
          );
      return {
        ok: false,
        restarted: true,
        failure: restoreFailure === undefined
          ? mainStopped.failure
          : lifecycleFailure(
              mainStopped.failure,
              `scheduled maintenance restoration failed: ${maintenanceErrorMessage(restoreFailure)}`,
            ),
      };
    }
    mainStopProven = true;
  }

  await whileStopped(mainStopProven);

  if (options.preserveMaintenanceService !== true) {
    const maintenanceBooted = await bootstrap(deps.runner, maintenance.plistPath, uid);
    const maintenanceLoaded = await pollUntil(
      deps,
      poll,
      async () => await isLoaded(deps.runner, maintenance.label, uid),
    );
    if (!maintenanceLoaded) {
      return {
        ok: false,
        restarted,
        failure: lifecycleFailure(maintenanceBooted, "scheduled recovery controller did not report loaded"),
      };
    }
  }

  const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
  if (booted.code === 0 || (await isLoaded(deps.runner, target.label, uid))) {
    return { ok: true, restarted };
  }
  if (options.preserveMaintenanceService === true) {
    return {
      ok: false,
      restarted,
      failure: lifecycleFailure(booted, "main service did not load; scheduled recovery remains loaded for retry"),
    };
  }
  const maintenanceServiceAfterFailure = await launchdServiceInfo(deps.runner, maintenance.label, uid);
  const maintenanceRemoval = await unloadLaunchdService(
    maintenance.label,
    maintenanceServiceAfterFailure,
    uniquePids([maintenanceServiceAfterFailure.pid]),
    deps,
    uid,
    poll,
  );
  return {
    ok: false,
    restarted,
    failure: lifecycleFailure(
      booted,
      maintenanceRemoval.ok
        ? "main service did not load; scheduled maintenance was unloaded"
        : `main service did not load; scheduled maintenance cleanup failed: ${maintenanceErrorMessage(maintenanceRemoval.failure)}`,
    ),
  };
}

function maintenancePathsForTarget(target: BackgroundLifecycleTarget): {
  readonly label: string;
  readonly plistPath: string;
} {
  const label = deriveLaunchdMaintenanceLabel(target.label);
  return { label, plistPath: resolve(target.paths.launchAgentsDir, `${label}.plist`) };
}

async function restoreMaintenanceDefinition(
  wasLoaded: boolean,
  maintenance: { readonly label: string; readonly plistPath: string },
  deps: BackgroundDeps,
  uid: number,
  poll: PollOptions,
): Promise<LaunchctlResult | undefined> {
  if (!wasLoaded) return undefined;
  const restored = await bootstrap(deps.runner, maintenance.plistPath, uid);
  const returned = await pollUntil(
    deps,
    poll,
    async () => await isLoaded(deps.runner, maintenance.label, uid),
  );
  if (returned) return undefined;
  return lifecycleFailure(restored, "scheduled maintenance did not return after the main stop failed");
}

async function findOwnershipConflict(
  target: InstanceTarget,
  deps: BackgroundDeps,
  uid: number,
): Promise<string | undefined> {
  const [service, sources] = await Promise.all([
    launchdServiceInfo(deps.runner, target.label, uid),
    findInstances(target, deps),
  ]);
  const live = sources.filter(
    (source) => source.health !== "stopped" && source.pid !== undefined && deps.isAlive(source.pid),
  );
  if (live.length === 0) return undefined;
  if (!service.loaded || service.pid === undefined || !deps.isAlive(service.pid)) {
    return `live matching trace pid(s) ${live.map((source) => source.pid).join(", ")} are not owned by a live ${target.label} launchd job`;
  }
  const foreign = live.filter((source) => source.pid !== service.pid);
  if (foreign.length > 0) {
    return `live matching trace pid(s) ${foreign.map((source) => source.pid).join(", ")} differ from launchd pid ${service.pid}`;
  }
  return undefined;
}

export async function stopBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_CONTROL_POLL,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("The LaunchAgent plist was preserved. Wait for that command to finish, then retry."));
    return 1;
  }
  try {
    return await stopBackgroundUnlocked(target, deps, poll);
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

async function stopBackgroundUnlocked(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
): Promise<number> {
  const uid = deps.getuid();
  const maintenance = maintenancePathsForTarget(target);
  const existing = await findInstances(target, deps);
  const [service, maintenanceService] = await Promise.all([
    launchdServiceInfo(deps.runner, target.label, uid),
    launchdServiceInfo(deps.runner, maintenance.label, uid),
  ]);
  let maintenanceIntent: LaunchdLogMaintenanceIntent | undefined;
  try {
    maintenanceIntent = await deps.readLaunchdLogMaintenanceIntent(target.paths);
  } catch (error) {
    deps.stderr(ui.errorLine(`Failed to inspect pending launchd-log maintenance for ${target.label}.`));
    deps.stderr(ui.style.dim(error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
  if ((maintenanceIntent?.phase === "stopping" || maintenanceIntent?.phase === "restoring") && !service.loaded) {
    deps.stderr(ui.errorLine(
      `Refusing to erase interrupted launchd-log maintenance for ${target.label} without stopped-writer proof.`,
    ));
    deps.stderr(ui.hint("Confirm the prior worker is gone, then restore or remove the owner-private maintenance marker explicitly."));
    return 1;
  }
  const liveTracePids = uniquePids(existing
    .filter((source) => source.health !== "stopped" && source.pid !== undefined && deps.isAlive(source.pid))
    .map((source) => source.pid));
  if (liveTracePids.some((pid) => pid !== service.pid)) {
    deps.stderr(ui.errorLine(
      `Refusing to stop ${target.label}: matching live trace pid(s) ${liveTracePids.join(", ")} are not owned by that launchd job.`,
    ));
    deps.stderr(ui.hint("The LaunchAgent plist was preserved. Stop the unmanaged process explicitly, then retry."));
    return 1;
  }

  const maintenanceStopped = await unloadLaunchdService(
    maintenance.label,
    maintenanceService,
    uniquePids([maintenanceService.pid]),
    deps,
    uid,
    poll,
  );
  if (!maintenanceStopped.ok) {
    deps.stderr(ui.errorLine(`Failed to stop scheduled log maintenance for ${target.label}.`));
    const detail = (maintenanceStopped.failure.stderr || maintenanceStopped.failure.stdout).trim();
    if (detail.length > 0) deps.stderr(ui.style.dim(detail) + "\n");
    deps.stderr(ui.hint("Both LaunchAgent plists were preserved. Retry stop after the maintenance helper exits."));
    return 1;
  }

  const ownedPids = uniquePids([service.pid, ...liveTracePids]);
  const mainStopped = await unloadLaunchdService(
    target.label,
    service,
    ownedPids,
    deps,
    uid,
    poll,
    async () => {
      const stoppedIntent = maintenanceIntent;
      if (stoppedIntent?.phase === "stopped") {
        maintenanceIntent = await deps.markLaunchdLogMaintenanceStopping(target.paths, stoppedIntent);
      }
    },
  );
  if (!mainStopped.ok) {
    const result = mainStopped.failure;
    const maintenanceRestoreFailure = await restoreMaintenanceDefinition(
      maintenanceService.loaded,
      maintenance,
      deps,
      uid,
      poll,
    );
    deps.stderr(ui.errorLine(
      `Failed to prove ${target.label} stopped${result?.code === undefined || result.code === 0 ? "" : ` (launchctl bootout exited ${result.code})`}.`,
    ));
    const detail = (result?.stderr || result?.stdout || "").trim();
    if (detail.length > 0) {
      deps.stderr(ui.style.dim(detail) + "\n");
    }
    if (maintenanceRestoreFailure !== undefined) {
      deps.stderr(ui.style.yellow(
        `Scheduled log maintenance also could not be restored: ${maintenanceErrorMessage(maintenanceRestoreFailure)}`,
      ) + "\n");
    }
    deps.stderr(ui.hint("Both LaunchAgent plists were preserved so the service remains recoverable. Inspect status/logs and retry."));
    return 1;
  }

  try {
    // Explicit stop cancels any interrupted maintainer's restore authority
    // only after both jobs and every observed pid are proven gone.
    if (maintenanceIntent?.phase === "stopping" || maintenanceIntent?.phase === "restoring") {
      maintenanceIntent = await deps.markLaunchdLogMaintenanceStopped(target.paths, maintenanceIntent);
    }
    await deps.clearLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
  } catch (error) {
    deps.stderr(ui.errorLine(`Failed to clear pending launchd-log maintenance for ${target.label}.`));
    deps.stderr(ui.style.dim(error instanceof Error ? error.message : String(error)) + "\n");
    deps.stderr(ui.hint("Both LaunchAgent plists were preserved; retry stop after the owner-private marker is inspectable."));
    return 1;
  }

  // Remove both definitions only after the helper and worker are unloaded and
  // every observed PID is dead. The helper can never resurrect a stopped job.
  await deps.rm(maintenance.plistPath);
  await deps.rm(target.paths.plistPath);
  for (const source of existing) await maybeUnlinkDeadManifest(target, deps, source);

  deps.stdout(
    service.loaded
      ? `${ui.badge("ok")}${ui.style.bold(`Stopped ${target.label}`)} and removed its LaunchAgent.\n`
      : `${ui.style.dim(`${target.label} was not running; removed its LaunchAgent if present.`)}\n`,
  );
  deps.stdout(ui.keyValue([["config", target.configPath]]));
  return 0;
}

export interface StatusBackgroundOptions {
  readonly json?: boolean;
}

export async function statusBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: StatusBackgroundOptions = {},
): Promise<number> {
  const [result, service] = await Promise.all([
    deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs }),
    launchdServiceInfo(deps.runner, target.label, deps.getuid()),
  ]);
  const classified = await Promise.all(result.sources.map(async (source) => ({
    source,
    matches: await matchesConfig(source, target.configPath),
  })));
  const matchingSources = classified.filter((entry) => entry.matches).map((entry) => entry.source);
  const recorded = service.pid === undefined
    ? matchingSources[0]
    : matchingSources.find((source) => source.pid === service.pid) ?? matchingSources[0];
  const active = service.loaded
    && service.pid !== undefined
    && deps.isAlive(service.pid)
    && recorded?.pid === service.pid
    && recorded.health === "running";
  const current = recorded === undefined || active ? recorded : inactiveStatusSource(recorded);
  // Only surface other instances that are live or crashed — cleanly stopped
  // manifests linger in the registry and would just be noise.
  const others = classified
    .filter((entry) => !entry.matches && entry.source.health !== "stopped")
    .map((entry) => entry.source);

  if (options.json === true) {
    const instance = current === undefined ? null : await assembleInstanceStatus(current, target, deps);
    deps.stdout(`${JSON.stringify({
      ok: active,
      instance,
      others: others.map(assembleOtherInstanceStatus),
    })}\n`);
    return active ? 0 : 1;
  }

  if (current === undefined) {
    deps.stdout(ui.style.dim(`No running mono-agent instance for ${target.configPath}.`) + "\n");
    deps.stdout(ui.hint(`Start it with: mono-agent start${commandFlags(target)}`));
  } else {
    writeInstanceDetail(current, target, deps);
    await writeRunsHealthDetail(current, deps);
  }

  if (others.length > 0) {
    deps.stdout("\n" + ui.rule("Other mono-agent instances"));
    for (const source of others) {
      deps.stdout(`${formatOtherInstance(source)}\n`);
    }
  }

  return active ? 0 : 1;
}

function inactiveStatusSource(source: TraceSourceListItem): TraceSourceListItem {
  const {
    transports: _staleTransports,
    pid: _stalePid,
    ...withoutLiveProcessFacts
  } = source;
  const metadata = source.metadata;
  const channels = metadata?.channels;
  const stoppedChannels = isPlainRecord(channels)
    ? Object.fromEntries(Object.entries(channels).map(([id, value]) => {
        if (!isPlainRecord(value) || value.kind !== "running") return [id, value];
        return [id, { kind: "stopped", reason: "instance is not running" }];
      }))
    : undefined;
  return {
    ...withoutLiveProcessFacts,
    health: "stopped",
    status: "stopped",
    ...(metadata === undefined
      ? {}
      : {
          metadata: {
            ...metadata,
            ...(stoppedChannels === undefined ? {} : { channels: stoppedChannels }),
          },
        }),
  } as TraceSourceListItem;
}

/**
 * The machine-readable instance record for `status --json`. It mirrors the
 * fields the human `writeInstanceDetail`/`writeRunsHealthDetail` render, reading
 * only the already-computed trace-source manifest (content-free, safe to publish)
 * and the same runs-health probe the human path performs — no extra probes.
 */
async function assembleInstanceStatus(
  source: TraceSourceListItem,
  target: InstanceTarget,
  deps: BackgroundDeps,
): Promise<Record<string, unknown>> {
  const metadata = source.metadata ?? {};
  const observability = metadata.observability;
  const sandbox = metadata.sandbox;
  const session = metadata.session;
  const channels = metadata.channels;
  return {
    sourceId: source.sourceId,
    label: source.label,
    launchdLabel: target.label,
    pid: source.pid ?? null,
    health: source.health,
    status: source.status,
    configPath: target.configPath,
    startedAt: source.startedAt,
    updatedAt: source.updatedAt,
    ...(source.artifactDir === undefined ? {} : { artifactDir: source.artifactDir }),
    ...(source.transports === undefined ? {} : { transports: source.transports }),
    logs: { stdout: target.paths.stdoutPath, stderr: target.paths.stderrPath },
    ...(isPlainRecord(observability) ? { observability } : {}),
    ...(isPlainRecord(sandbox) ? { sandbox } : {}),
    ...(isPlainRecord(session) ? { session } : {}),
    ...(isPlainRecord(channels) ? { channels } : {}),
    ...(source.memoryHealth === undefined ? {} : { memoryHealth: source.memoryHealth }),
    runsHealth: await assembleRunsHealthStatus(source, deps),
  };
}

async function assembleRunsHealthStatus(
  source: TraceSourceListItem,
  deps: BackgroundDeps,
): Promise<{ readonly totalRuns: number; readonly warnings: readonly string[] } | null> {
  if (source.artifactDir === undefined || source.artifactDir.trim().length === 0) {
    return null;
  }
  const { totalRuns, warnings } = await deps.listRecordedRuns({
    artifactDir: source.artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  return { totalRuns, warnings };
}

function assembleOtherInstanceStatus(source: TraceSourceListItem): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    label: source.label,
    health: source.health,
    pid: source.pid ?? null,
    ...(source.configPath === undefined ? {} : { configPath: source.configPath }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface LogOptions {
  readonly follow: boolean;
  readonly lines: number;
}

export async function tailLogs(target: InstanceTarget, deps: BackgroundDeps, options: LogOptions): Promise<number> {
  const args = [
    "-n",
    String(options.lines),
    ...(options.follow ? ["-F"] : []),
    target.paths.stderrPath,
    target.paths.stdoutPath,
  ];
  return await deps.spawnTail(args);
}

export async function pollInstanceReady(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: ReadyPollOptions,
): Promise<TraceSourceListItem | undefined> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    const service = await launchdServiceInfo(deps.runner, target.label, deps.getuid());
    if (service.loaded && service.pid !== undefined && deps.isAlive(service.pid)) {
      const matches = await findInstances(target, deps);
      const match = matches.find((source) => source.pid === service.pid);
      if (match !== undefined
        && isReady(match, options.requireTui === true)
        && startedAtMs(match) >= options.sinceMs
        && snapshotMetadataMatches(match, target.expectedSnapshot)
        && await snapshotStillMatches(target, deps)
        && (options.requireTui !== true || await deps.probeTui(match))) {
        return match;
      }
    }
    if (deps.now() >= deadline) {
      return undefined;
    }
    await deps.sleep(options.intervalMs);
  }
}

async function snapshotStillMatches(target: InstanceTarget, deps: BackgroundDeps): Promise<boolean> {
  if (target.expectedSnapshot === undefined) return true;
  const capture = deps.captureSnapshot ?? captureTargetSnapshot;
  try {
    return sameBackgroundSnapshot(await capture(target), target.expectedSnapshot);
  } catch {
    return false;
  }
}

async function captureTargetSnapshot(target: InstanceTarget): Promise<BackgroundSnapshot> {
  return await captureBackgroundSnapshot({
    cwd: target.cwd,
    configPath: target.configPath,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    env: target.configurationEnvironment,
  });
}

function snapshotMetadataMatches(
  source: TraceSourceListItem,
  expected: BackgroundSnapshot | undefined,
): boolean {
  if (expected === undefined) return true;
  const actual = backgroundSnapshotFromMetadata(source.metadata);
  return actual !== undefined && sameBackgroundSnapshot(actual, expected);
}

function reportSnapshotDrift(target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stderr(ui.errorLine("The committed config, dotenv, Identity, Soul, MCP config, or durable environment changed before background readiness."));
  deps.stderr(ui.style.dim("No readiness claim was made for a different snapshot.") + "\n");
  reportLaunchRecovery(target, deps);
}

export function printInstanceInfo(
  source: TraceSourceListItem,
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
): void {
  const flag = commandFlags(target);
  deps.stdout(`${ui.badge("ok")}${ui.style.bold(`mono-agent ${verb} in the background.`)}\n\n`);
  writeInstanceDetail(source, target, deps);
  deps.stdout("\n" + ui.hint(`Stop with: mono-agent stop${flag}   ·   Logs: mono-agent logs${flag} --follow`));
}

async function findInstances(target: InstanceTarget, deps: BackgroundDeps): Promise<readonly TraceSourceListItem[]> {
  const result = await deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
  const matches = await Promise.all(result.sources.map(async (source) => ({
    source,
    matches: await matchesConfig(source, target.configPath),
  })));
  return matches.filter((entry) => entry.matches).map((entry) => entry.source);
}

async function maybeUnlinkDeadManifest(
  target: InstanceTarget,
  deps: BackgroundDeps,
  existing: TraceSourceListItem | undefined,
): Promise<void> {
  // Only clean up a manifest whose process is already gone; a worker that is
  // still shutting down will mark its own manifest stopped.
  if (existing?.pid === undefined || deps.isAlive(existing.pid)) {
    return;
  }
  await deps.rm(resolve(target.registryDir, `${existing.sourceId}.json`));
}

function reportLaunchFailure(
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
  result: LaunchctlResult | undefined,
): void {
  deps.stderr(ui.errorLine(`Failed to ${verb} ${target.label} via launchctl${result === undefined ? "" : ` (exit ${result.code})`}.`));
  const detail = (result?.stderr || result?.stdout || "").trim();
  if (detail.length > 0) {
    deps.stderr(ui.style.dim(detail) + "\n");
  }
  reportLaunchRecovery(target, deps);
}

function reportOwnershipConflict(target: InstanceTarget, deps: BackgroundDeps, detail: string): void {
  deps.stderr(ui.errorLine(`Refusing to launch a second worker for ${target.configPath}.`));
  deps.stderr(ui.style.dim(`${detail}.\n`));
  deps.stderr(ui.hint("No LaunchAgent changes were made. Stop the unmanaged process or reconcile launchd ownership, then retry."));
  reportLaunchRecovery(target, deps);
}

function reportLifecycleException(
  target: InstanceTarget,
  deps: BackgroundDeps,
  operation: string,
  error: unknown,
): void {
  deps.stderr(ui.errorLine(`Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
  reportLaunchRecovery(target, deps);
}

function reportReadinessException(deps: BackgroundDeps, error: unknown): void {
  deps.stderr(ui.errorLine(
    `Failed to read the worker readiness trace: ${error instanceof Error ? error.message : String(error)}`,
  ));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
}

function reportTimeout(deps: BackgroundDeps): void {
  deps.stderr(ui.errorLine("mono-agent did not report ready within the timeout."));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
}

async function cleanUpUnreadyBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
  options: BackgroundReadyInternalOptions = {},
): Promise<boolean> {
  try {
    if (options.preserveDefinitionsOnFailure === true) {
      const uid = deps.getuid();
      const [service, sources] = await Promise.all([
        launchdServiceInfo(deps.runner, target.label, uid),
        findInstances(target, deps),
      ]);
      const liveTracePids = uniquePids(sources
        .filter((source) => source.health !== "stopped"
          && source.pid !== undefined
          && deps.isAlive(source.pid))
        .map((source) => source.pid));
      if (liveTracePids.some((pid) => pid !== service.pid)) return false;
      const stopped = await unloadLaunchdService(
        target.label,
        service,
        uniquePids([service.pid, ...liveTracePids]),
        deps,
        uid,
        poll,
      );
      return stopped.ok;
    }
    return await stopBackgroundUnlocked(target, { ...deps, stdout: () => undefined }, poll) === 0;
  } catch (error) {
    deps.stderr(ui.errorLine(
      `Failed while trying to stop the unready LaunchAgent: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return false;
  }
}

function reportReadinessCleanup(
  target: InstanceTarget,
  deps: BackgroundDeps,
  stopped: boolean,
  options: BackgroundReadyInternalOptions = {},
): void {
  deps.stderr(stopped
    ? options.preserveDefinitionsOnFailure === true
      ? ui.style.dim("The unready main LaunchAgent was stopped; both definitions and the scheduled recovery controller remain for retry.") + "\n"
      : ui.style.dim("The unready LaunchAgent and scheduled maintenance were stopped and their definitions removed before returning control.") + "\n"
    : ui.style.yellow("The unready LaunchAgent could not be proven stopped; a worker or maintenance helper may still be running.") + "\n");
  reportLaunchRecovery(target, deps);
}

function reportLaunchRecovery(target: InstanceTarget, deps: BackgroundDeps): void {
  const flags = commandFlags(target);
  deps.stderr(ui.style.dim("Retry or inspect with:") + "\n");
  deps.stderr(
    `  ${ui.style.gray("logs:  ")} ${target.paths.stderrPath}\n` +
      `          ${target.paths.stdoutPath}\n` +
      `  ${ui.style.gray("retry: ")} mono-agent start${flags}\n` +
      `  ${ui.style.gray("status:")} mono-agent status${flags}\n` +
      `  ${ui.style.gray("follow:")} mono-agent logs${flags} --follow\n`,
  );
}

function writeInstanceDetail(source: TraceSourceListItem, target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stdout(ui.rule("instance"));
  deps.stdout(
    ui.keyValue(
      [
        ["pid", String(source.pid ?? "unknown")],
        ["health", `${ui.healthBadge(source.health)}${source.health}`],
        ["config", target.configPath],
        ["label", target.label],
        ["started", source.startedAt],
        ["logs", target.paths.stdoutPath],
        ["", target.paths.stderrPath],
      ],
      2,
    ),
  );
  const observability = describeObservabilityMetadata(source);
  if (observability !== undefined) {
    deps.stdout(ui.rule("observability"));
    deps.stdout(`  ${observability}\n`);
  }
  const sandboxLines = describeSandboxMetadata(source);
  if (sandboxLines.length > 0) {
    deps.stdout(ui.rule("sandbox"));
    for (const line of sandboxLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const sessionLines = describeSessionMetadata(source, deps.now());
  if (sessionLines.length > 0) {
    deps.stdout(ui.rule("session"));
    for (const line of sessionLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const channelSections = formatChannels(source);
  for (const section of channelSections) {
    deps.stdout(ui.rule(section.title));
    for (const line of section.lines) {
      deps.stdout(`${line}\n`);
    }
  }
}

async function writeRunsHealthDetail(source: TraceSourceListItem, deps: BackgroundDeps): Promise<void> {
  if (source.artifactDir === undefined || source.artifactDir.trim().length === 0) {
    return;
  }
  const { totalRuns, runs, warnings } = await deps.listRecordedRuns({
    artifactDir: source.artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  const selectedSkills = selectedSkillsFromMetadata(source.metadata);
  const runOwnerAlive = source.pid === undefined ? undefined : deps.isAlive(source.pid);
  const display = buildRunsHealthDisplay({
    artifactDir: source.artifactDir,
    totalRuns,
    runs,
    warnings,
    includeSelectedSkills: true,
    nowMs: deps.now(),
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    ...(selectedSkills === undefined ? {} : { selectedSkills }),
    ...(runOwnerAlive === undefined ? {} : { runOwnerAlive }),
  });
  deps.stdout(ui.rule("runs health"));
  for (const detail of display.details) {
    deps.stdout(`  ${detail}\n`);
  }
}

function selectedSkillsFromMetadata(metadata: Record<string, unknown> | undefined): readonly string[] | undefined {
  const context = metadata?.context;
  if (context === null || typeof context !== "object") {
    return undefined;
  }
  const selectedSkills = (context as Record<string, unknown>).selectedSkills;
  if (!Array.isArray(selectedSkills)) {
    return undefined;
  }
  return selectedSkills.flatMap((skill) => typeof skill === "string" ? [skill] : []);
}

function formatOtherInstance(source: TraceSourceListItem): string {
  const pid = source.pid === undefined ? "?" : String(source.pid);
  const config = source.configPath ?? "(unknown config)";
  return `  ${ui.healthBadge(source.health)}${source.health.padEnd(8)} pid ${pid.padEnd(7)} ${source.sourceId}  ${config}`;
}

async function matchesConfig(source: TraceSourceListItem, configPath: string): Promise<boolean> {
  if (source.configPath === undefined) return false;
  return await canonicalBackgroundConfigPath(process.cwd(), source.configPath) === configPath;
}

function isReady(source: TraceSourceListItem, requireTui: boolean): boolean {
  if (source.health !== "running" || !hasCompletedManagedStartup(source)) return false;
  if (source.memoryHealth?.status === "unhealthy") return false;
  const channels = channelRecords(source);
  if (channels.some((channel) => channel.kind === "failed")) return false;
  if (!requireTui) return true;
  if (channels.some((channel) => typeof channel.kind === "string"
    && ["failed", "degraded", "waiting_for_config"].includes(channel.kind))) return false;
  return tuiEndpoint(source) !== undefined;
}

function channelRecords(source: TraceSourceListItem): readonly Record<string, unknown>[] {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") return [];
  return Object.values(channels as Record<string, unknown>)
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
}

function startedAtMs(source: TraceSourceListItem): number {
  const parsed = Date.parse(source.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Format the persisted observability exporter metadata for the detached
 * `status` reader. Reads defensively (the worker persists only endpoint +
 * warning/error strings, never headers/secrets) and always notes that JSONL
 * artifacts remain local.
 */
function describeObservabilityMetadata(source: TraceSourceListItem): string | undefined {
  const observability = source.metadata?.observability;
  if (observability === null || typeof observability !== "object") {
    return undefined;
  }
  const record = observability as Record<string, unknown>;
  const endpoint = record.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return undefined;
  }
  const parts = [`phoenix ${endpoint}`];
  const appUrl = phoenixAppBaseUrl(endpoint);
  if (appUrl !== undefined) {
    parts.push(`app ${appUrl}`);
  }
  if (record.includeSensitiveData === true) {
    parts.push(ui.style.yellow(describeSensitiveDataExportWarning(endpoint)));
  }
  if (typeof record.lastWarning === "string" && record.lastWarning.length > 0) {
    parts.push(`last warning: ${record.lastWarning}`);
  }
  if (typeof record.lastError === "string" && record.lastError.length > 0) {
    parts.push(`last error: ${record.lastError}`);
  }
  parts.push("JSONL artifacts remain local");
  return parts.join("; ");
}

function describeSandboxMetadata(source: TraceSourceListItem): string[] {
  const sandbox = source.metadata?.sandbox;
  if (sandbox === null || typeof sandbox !== "object") {
    return [];
  }
  const record = sandbox as Record<string, unknown>;
  const effective = stringField(record, "effective") ?? "unknown";
  const engine = stringField(record, "engine") ?? "none";
  const engineAvailability = record.engineAvailable === true
    ? "present"
    : record.engineAvailable === false
      ? "absent"
      : "not checked";
  const fallback = stringField(record, "fallback");
  const fallbackActive = record.fallbackActive === true ? "yes" : "no";
  const summary = [
    `effective: ${effective}`,
    `engine: ${engine} (${engineAvailability})`,
    ...(fallback === undefined ? [] : [`fallback: ${fallback}`]),
    `fallback active: ${fallbackActive}`,
  ].join("; ");
  return [
    summary,
    ...stringFieldAsList(record, "detail"),
    ...stringFieldAsList(record, "warning").map((warning) => ui.style.yellow(warning)),
  ];
}

function describeSessionMetadata(source: TraceSourceListItem, nowMs: number): string[] {
  const session = source.metadata?.session;
  if (session === null || typeof session !== "object") {
    return [];
  }
  const record = session as Record<string, unknown>;
  const bucket = stringField(record, "currentBucketId");
  if (bucket === undefined) {
    return [];
  }
  const current = sessionSnapshotRecord(record, bucket);
  const hasSnapshot = Array.isArray(record.snapshot);
  const state = current === undefined
    ? hasSnapshot ? "cold" : stringField(record, "state") ?? stringField(record, "status") ?? "cold"
    : "warm";
  const event = stringField(record, "event");
  const providerSessionId = current?.providerSessionId ?? stringField(record, "providerSessionId");
  const nextRolloverAt = stringField(record, "nextRolloverAt");
  const reason = stringField(record, "reason");
  const createdAt = current?.createdAt ?? numberField(record, "createdAt");
  const summary = [
    `bucket: ${bucket}`,
    `state: ${state}`,
    `age: ${formatSessionAge(createdAt, nowMs)}`,
    ...(event === undefined ? [] : [`event: ${event}`]),
    ...(providerSessionId === undefined ? [] : [`provider: ${providerSessionId}`]),
    ...(nextRolloverAt === undefined ? [] : [`next rollover: ${nextRolloverAt}`]),
    ...(reason === undefined ? [] : [`reason: ${reason}`]),
  ];
  return [summary.join("; ")];
}

function sessionSnapshotRecord(
  record: Record<string, unknown>,
  bucket: string,
): { providerSessionId: string; createdAt: number } | undefined {
  const snapshot = record.snapshot;
  if (!Array.isArray(snapshot)) {
    return undefined;
  }
  for (const item of snapshot) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (stringField(entry, "conversationId") !== bucket) {
      continue;
    }
    const providerSessionId = stringField(entry, "providerSessionId");
    const createdAt = numberField(entry, "createdAt");
    if (providerSessionId !== undefined && createdAt !== undefined) {
      return { providerSessionId, createdAt };
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatSessionAge(createdAt: number | undefined, nowMs: number): string {
  if (createdAt === undefined) {
    return "unknown";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - createdAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }
  return `${Math.floor(elapsedHours / 24)}d`;
}

function stringFieldAsList(record: Record<string, unknown>, key: string): string[] {
  const value = stringField(record, key);
  return value === undefined ? [] : [value];
}

/** ` --config <path>` when a non-default config is in play, else empty. */
function configFlag(target: InstanceTarget): string {
  const defaultPath = resolve(target.cwd, "mono-agent.config.json");
  return target.configPath === defaultPath ? "" : ` --config ${shellCommandArgument(target.configPath)}`;
}

function commandFlags(target: InstanceTarget): string {
  return `${configFlag(target)}${target.envFile === undefined ? "" : ` --env-file ${shellCommandArgument(target.envFile)}`}`;
}

function shellCommandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface FilesystemLifecycleLockOptions {
  readonly pid?: number;
  readonly now?: () => number;
  /**
   * Permanent pre-v0.9.0 owner-record compatibility. v0.9.0 and later write
   * process incarnation identity into every lifecycle-lock owner record.
   */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIncarnation?: ProcessIncarnation;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly ownerlessGraceMs?: number;
  readonly randomToken?: () => string;
  /** Deterministic seam immediately after the final identity check. */
  readonly beforeStaleLockRename?: () => Promise<void>;
}

export async function acquireFilesystemLifecycleLock(
  target: BackgroundLifecycleTarget,
  options: FilesystemLifecycleLockOptions = {},
): Promise<(() => Promise<void>) | undefined> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? 5 * 60_000;
  const randomToken = options.randomToken ?? randomUUID;
  validateOwnerPrivateLockInputs("Lifecycle lock", pid, ownerlessGraceMs);
  const managedRoot = dirname(target.paths.logDir);
  const locksDir = resolve(managedRoot, "locks");
  for (const path of [managedRoot, locksDir]) {
    await ensureOwnerPrivateLaunchdDirectory(path);
  }

  const lockDir = resolve(locksDir, `${target.label}.lock`);
  const held = await acquireOwnerPrivateLock({
    path: lockDir,
    label: "Lifecycle lock",
    schemaTag: "mono-agent.filesystem-lifecycle-lock.v1",
    ownerlessGraceMs,
    maxAcquireAttempts: 4,
    pid,
    now,
    randomToken,
    ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
    ...(options.isSameProcessIncarnation === undefined
      ? {}
      : { isSameProcessIncarnation: options.isSameProcessIncarnation }),
    parseLegacyOwner: (record) => {
      if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
      const incarnation = processIncarnationFromJson(record.incarnation);
      return {
        pid: record.pid,
        ...(incarnation === undefined ? {} : { incarnation }),
      };
    },
    // Permanent pre-v0.9.0 compatibility: a skipped-version upgrade can
    // encounter crash debris without incarnation identity indefinitely.
    // All owner records written since v0.9.0 use the stronger shared schema.
    allowCurrentUserLegacyOwnerMode: true,
    isLegacyProcessAlive: isProcessAlive,
    invalidOwner: "ownerless",
    livenessError: () => "assume-live",
    ...(options.beforeStaleLockRename === undefined
      ? {}
      : { beforeStaleRename: options.beforeStaleLockRename }),
    staleRace: "return",
    stalePath: ({ now: staleAt, pid: stalePid, token }) =>
      resolve(locksDir, `${target.label}.stale-${staleAt}-${stalePid}-${token}`),
    releasedPath: ({ now: releasedAt, pid: ownerPid, token }) =>
      resolve(locksDir, `${target.label}.released-${releasedAt}-${ownerPid}-${token}`),
    abandonedPath: ({ now: abandonedAt, pid: ownerPid, token }) =>
      resolve(locksDir, `${target.label}.abandoned-${abandonedAt}-${ownerPid}-${token}`),
  });
  return held === undefined ? undefined : () => held.release();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function probeTuiEndpoint(source: TraceSourceListItem): Promise<boolean> {
  const baseUrl = tuiEndpoint(source);
  if (baseUrl === undefined) return false;
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/+$/u, "")}/v1/info`);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    // Authenticated adapters return 401/403 without the secret. That still
    // proves the advertised loopback listener is reachable; an open endpoint
    // additionally proves it belongs to the expected worker pid.
    if (response.status === 401 || response.status === 403) return true;
    if (!response.ok) return false;
    const body = await response.json() as { pid?: unknown };
    return typeof source.pid === "number" && body.pid === source.pid;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function tuiEndpoint(source: TraceSourceListItem): string | undefined {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") return undefined;
  const tui = (channels as Record<string, unknown>).tui;
  if (tui === null || typeof tui !== "object") return undefined;
  const record = tui as Record<string, unknown>;
  return record.kind === "running" && typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0
    ? record.baseUrl
    : undefined;
}

function formatChannels(source: TraceSourceListItem): ReturnType<typeof formatHumanChannelSections> {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") {
    return [];
  }
  return formatHumanChannelSections(Object.entries(channels as Record<string, unknown>).map(([id, value]) => {
    const { kind, text } = describeChannel(value);
    return { id, kind, text };
  }));
}

export function describeChannel(value: unknown): { kind: string; text: string } {
  if (value === null || typeof value !== "object") {
    return { kind: "unknown", text: formatChannelFactValue(value) };
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  if (kind === "running") {
    // Route every fact through the shared recursive formatter so a nested object
    // (e.g. the webhook `invokeUrls` map) never renders as `[object Object]` —
    // the E4 bug that persisted on this backgrounded-start summary path after the
    // `status`-line render was fixed.
    const facts = Object.entries(record)
      .filter(([key]) => key !== "kind")
      .map(([key, fact]) => `${key}=${formatChannelFactValue(fact)}`)
      .join(" ");
    return { kind, text: facts.length === 0 ? "running" : `running (${facts})` };
  }
  const reason = typeof record.reason === "string" ? record.reason : "";
  return { kind, text: reason.length === 0 ? kind : `${kind}: ${reason}` };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

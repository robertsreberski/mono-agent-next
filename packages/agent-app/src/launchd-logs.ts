import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { deriveLaunchdLabel, launchdPathsFor } from "./launchd.js";
import type { LaunchdPaths } from "./launchd.js";

export const LAUNCHD_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LAUNCHD_LOG_ROTATION_COUNT = 3;
export const LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS = 5 * 60;

export interface LaunchdLogPolicy {
  readonly maxBytes: number;
  readonly rotationCount: number;
}

export const DEFAULT_LAUNCHD_LOG_POLICY: LaunchdLogPolicy = Object.freeze({
  maxBytes: LAUNCHD_LOG_MAX_BYTES,
  rotationCount: LAUNCHD_LOG_ROTATION_COUNT,
});

export type LaunchdLogFileState = "missing" | "ok" | "repairable" | "unsafe" | "unreadable";

export interface LaunchdLogFileInspection {
  readonly generation: number;
  readonly state: LaunchdLogFileState;
  readonly bytes: number;
  readonly issue?: string;
}

export interface LaunchdLogStreamInspection {
  readonly activeBytes: number;
  readonly retainedBytes: number;
  readonly totalBytes: number;
  /** False when any path could not be inspected safely; numeric totals are then incomplete. */
  readonly byteAccountingComplete: boolean;
  readonly files: readonly LaunchdLogFileInspection[];
}

export interface LaunchdLogInspection {
  readonly stdout: LaunchdLogStreamInspection;
  readonly stderr: LaunchdLogStreamInspection;
  readonly present: boolean;
  /** True only when every present path is safe for stopped-writer maintenance. */
  readonly canMaintain: boolean;
  /** Oversized files or repairable owner-only permissions require a maintenance pass. */
  readonly needsMaintenance: boolean;
  /** A durable journal proves a stopped-writer rotation began and must resume. */
  readonly pendingTransaction: boolean;
  /** A lifecycle marker exists; its authenticated phase decides whether rotation or restore recovery is safe. */
  readonly pendingMaintenance: boolean;
  readonly issues: readonly string[];
}

export interface LaunchdLogMaintenanceIntent {
  readonly version: 1;
  readonly phase: "stopping" | "stopped" | "restoring";
  readonly label: string;
  readonly plistFingerprint: string;
}

export interface LaunchdLogRotationResult {
  readonly changed: boolean;
  readonly replacedFiles: number;
}

export interface LaunchdLogDependencies {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly open: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly currentUid: () => number | undefined;
  readonly syncHandle: (handle: FileHandle) => Promise<void>;
  readonly readTail: (handle: FileHandle, size: number, maxBytes: number) => Promise<Buffer>;
  /** Deterministic adversarial seam immediately before a destination identity check. */
  readonly beforeCommit?: (path: string) => Promise<void>;
}

export function defaultLaunchdLogDependencies(): LaunchdLogDependencies {
  return {
    lstat,
    realpath,
    open,
    rename,
    rm: async (path) => await rm(path, { force: true }),
    currentUid: () => process.getuid?.(),
    syncHandle: async (handle) => await handle.sync(),
    readTail: readFileTail,
  };
}

/**
 * Derive the same per-config launchd paths as the background controller without
 * following a final-component symlink. Doctor and the private maintenance
 * command use this read-only helper; neither accepts a caller-supplied log path.
 */
export async function launchdLogPathsForConfig(
  configPath: string,
  home?: string,
): Promise<LaunchdPaths> {
  const lexical = resolve(configPath);
  try {
    const candidate = join(await realpath(dirname(lexical)), basename(lexical));
    try {
      const initial = await lstat(candidate);
      if (initial.isSymbolicLink()) return launchdPathsFor(deriveLaunchdLabel(candidate), home);
      if (!initial.isFile()) return launchdPathsFor(deriveLaunchdLabel(candidate), home);
      const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      try {
        const observed = await handle.stat();
        if (!sameFileSnapshot(initial, observed)) {
          throw new Error("Background config identity changed while launchd log paths were derived.");
        }
        const canonical = await realpath(candidate);
        const [candidateAfter, canonicalAfter] = await Promise.all([lstat(candidate), lstat(canonical)]);
        if (!sameFileSnapshot(observed, candidateAfter)
          || !sameFilesystemIdentity(observed, canonicalAfter)) {
          throw new Error("Background config identity changed while launchd log paths were derived.");
        }
        return launchdPathsFor(deriveLaunchdLabel(canonical), home);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
        return launchdPathsFor(deriveLaunchdLabel(candidate), home);
      }
      throw error;
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return launchdPathsFor(deriveLaunchdLabel(lexical), home);
    }
    throw error;
  }
}

/** Read and authenticate the durable lifecycle intent without changing it. */
export async function readLaunchdLogMaintenanceIntent(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<LaunchdLogMaintenanceIntent | undefined> {
  assertCanonicalLogPaths(paths);
  const directory = await inspectDirectoryChain(paths.logDir, deps);
  if (directory.state === "missing") return undefined;
  if (directory.state === "unsafe" || directory.state === "unreadable") {
    throw new Error("LaunchAgent log maintenance intent requires a safe canonical directory chain.");
  }
  return (await loadMaintenanceIntent(paths, deps))?.intent;
}

/** Publish pre-stop intent atomically before bootout; an unproven unloaded phase fails closed. */
export async function beginLaunchdLogMaintenanceIntent(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  intent: LaunchdLogMaintenanceIntent,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<void> {
  assertCanonicalLogPaths(paths);
  validateMaintenanceIntent(intent);
  if (intent.phase !== "stopping") {
    throw new Error("LaunchAgent log maintenance must begin in the stopping phase.");
  }
  const existing = await readLaunchdLogMaintenanceIntent(paths, deps);
  if (existing !== undefined) {
    if (sameMaintenanceIntent(existing, intent)) return;
    throw new Error("A different launchd log maintenance intent is already pending.");
  }
  const directories = await openValidatedDirectoryChain(paths.logDir, deps);
  if (directories === undefined) throw new Error("LaunchAgent log directory does not exist.");
  try {
    for (const directory of directories) await secureDirectory(directory, deps);
    await assertDirectoryChainIdentity(directories, deps);
    const data = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
    if (data.length > MAX_MAINTENANCE_INTENT_BYTES) {
      throw new Error("LaunchAgent log maintenance intent exceeds its fixed size bound.");
    }
    const nextPath = maintenanceIntentNextPath(paths);
    await removeKnownArtifact(nextPath, directories, deps, MAX_MAINTENANCE_INTENT_BYTES);
    await assertPathMissing(maintenanceIntentPath(paths), deps);
    const nextStats = await writeOwnerPrivateArtifact(nextPath, data, directories, deps);
    try {
      await assertDirectoryChainIdentity(directories, deps);
      await assertPathMissing(maintenanceIntentPath(paths), deps);
      await assertKnownPath(nextPath, nextStats, deps);
      await deps.rename(nextPath, maintenanceIntentPath(paths));
      const published = await deps.lstat(maintenanceIntentPath(paths));
      if (!matchesCommittedFingerprint(published, fingerprintFor(nextStats))) {
        throw new Error("LaunchAgent log maintenance intent changed while it was published.");
      }
      await deps.syncHandle(directories.at(-1)!.handle);
    } catch (error) {
      await removeKnownPath(nextPath, nextStats, directories, deps).catch(() => undefined);
      throw error;
    }
  } finally {
    await Promise.all(directories.map(async (entry) => await entry.handle.close().catch(() => undefined)));
  }
}

/** Durably record that launchd is unloaded and every writer PID observed by this maintainer is dead. */
export async function markLaunchdLogMaintenanceStopped(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  expected: LaunchdLogMaintenanceIntent,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<LaunchdLogMaintenanceIntent> {
  if (expected.phase !== "stopping" && expected.phase !== "restoring") {
    throw new Error("LaunchAgent log maintenance can mark only an invalidated intent as stopped.");
  }
  return await replaceMaintenanceIntentPhase(paths, expected, "stopped", deps);
}

/** Invalidate stopped-writer proof before bootstrap can create a replacement writer. */
export async function markLaunchdLogMaintenanceRestoring(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  expected: LaunchdLogMaintenanceIntent,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<LaunchdLogMaintenanceIntent> {
  if (expected.phase !== "stopped") {
    throw new Error("LaunchAgent log maintenance can restore only from a stopped intent.");
  }
  return await replaceMaintenanceIntentPhase(paths, expected, "restoring", deps);
}

/** Invalidate old stopped-writer proof before booting out any newly loaded writer. */
export async function markLaunchdLogMaintenanceStopping(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  expected: LaunchdLogMaintenanceIntent,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<LaunchdLogMaintenanceIntent> {
  if (expected.phase !== "stopped") {
    throw new Error("LaunchAgent log maintenance can invalidate only a stopped intent.");
  }
  return await replaceMaintenanceIntentPhase(paths, expected, "stopping", deps);
}

async function replaceMaintenanceIntentPhase(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  expected: LaunchdLogMaintenanceIntent,
  phase: LaunchdLogMaintenanceIntent["phase"],
  deps: LaunchdLogDependencies,
): Promise<LaunchdLogMaintenanceIntent> {
  assertCanonicalLogPaths(paths);
  validateMaintenanceIntent(expected);
  const observed = await readLaunchdLogMaintenanceIntent(paths, deps);
  if (observed === undefined || !sameMaintenanceIntent(observed, expected)) {
    throw new Error("LaunchAgent log maintenance intent changed before its lifecycle phase was recorded.");
  }
  const updated: LaunchdLogMaintenanceIntent = { ...expected, phase };
  const data = Buffer.from(`${JSON.stringify(updated)}\n`, "utf8");
  if (data.length > MAX_MAINTENANCE_INTENT_BYTES) {
    throw new Error("LaunchAgent log maintenance intent exceeds its fixed size bound.");
  }
  const directories = await openValidatedDirectoryChain(paths.logDir, deps);
  if (directories === undefined) throw new Error("LaunchAgent log directory disappeared before lifecycle proof update.");
  try {
    for (const directory of directories) await secureDirectory(directory, deps);
    await assertDirectoryChainIdentity(directories, deps);
    const current = await loadMaintenanceIntent(paths, deps);
    if (current === undefined || !sameMaintenanceIntent(current.intent, expected)) {
      throw new Error("LaunchAgent log maintenance intent changed before its lifecycle phase was recorded.");
    }
    const nextPath = maintenanceIntentNextPath(paths);
    await removeKnownArtifact(nextPath, directories, deps, MAX_MAINTENANCE_INTENT_BYTES);
    const nextStats = await writeOwnerPrivateArtifact(nextPath, data, directories, deps);
    try {
      await assertDirectoryChainIdentity(directories, deps);
      const currentIntent = await loadMaintenanceIntent(paths, deps);
      if (currentIntent === undefined || !sameFileSnapshot(currentIntent.stats, current.stats)
        || !sameMaintenanceIntent(currentIntent.intent, expected)) {
        throw new Error("LaunchAgent log maintenance intent changed before its lifecycle phase was committed.");
      }
      await assertKnownPath(nextPath, nextStats, deps);
      await deps.rename(nextPath, maintenanceIntentPath(paths));
      const published = await deps.lstat(maintenanceIntentPath(paths));
      if (!matchesCommittedFingerprint(published, fingerprintFor(nextStats))) {
        throw new Error("LaunchAgent log lifecycle phase changed while it was published.");
      }
      await deps.syncHandle(directories.at(-1)!.handle);
      return updated;
    } catch (error) {
      await removeKnownPath(nextPath, nextStats, directories, deps).catch(() => undefined);
      throw error;
    }
  } finally {
    await Promise.all(directories.map(async (entry) => await entry.handle.close().catch(() => undefined)));
  }
}

/** Remove only the exact authenticated intent after recovery or explicit stop. */
export async function clearLaunchdLogMaintenanceIntent(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  expected?: LaunchdLogMaintenanceIntent,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<void> {
  assertCanonicalLogPaths(paths);
  const observed = await readLaunchdLogMaintenanceIntent(paths, deps);
  if (expected !== undefined && observed === undefined) {
    throw new Error("LaunchAgent log maintenance intent disappeared before cleanup.");
  }
  if (observed !== undefined && expected === undefined) {
    throw new Error("LaunchAgent log maintenance intent requires its exact authenticated value for cleanup.");
  }
  if (observed?.phase === "stopping" && expected !== undefined) {
    throw new Error("Refusing to clear launchd log maintenance intent before durable stopped-writer proof.");
  }
  if (observed !== undefined && expected !== undefined && !sameMaintenanceIntent(observed, expected)) {
    throw new Error("LaunchAgent log maintenance intent changed before cleanup.");
  }
  const directories = await openValidatedDirectoryChain(paths.logDir, deps);
  if (directories === undefined) {
    if (observed === undefined) return;
    throw new Error("LaunchAgent log directory disappeared before intent cleanup.");
  }
  try {
    for (const directory of directories) await secureDirectory(directory, deps);
    await assertDirectoryChainIdentity(directories, deps);
    let changed = await removeKnownArtifact(
      maintenanceIntentNextPath(paths),
      directories,
      deps,
      MAX_MAINTENANCE_INTENT_BYTES,
    );
    if (observed !== undefined) {
      const current = await loadMaintenanceIntent(paths, deps);
      if (current === undefined || !sameMaintenanceIntent(current.intent, observed)) {
        throw new Error("LaunchAgent log maintenance intent changed before cleanup.");
      }
      await deps.beforeCommit?.(maintenanceIntentPath(paths));
      await removeExpectedPath(maintenanceIntentPath(paths), current.stats, directories, deps);
      await assertPathMissing(maintenanceIntentPath(paths), deps);
      changed = true;
    }
    if (changed) await deps.syncHandle(directories.at(-1)!.handle);
  } finally {
    await Promise.all(directories.map(async (entry) => await entry.handle.close().catch(() => undefined)));
  }
}

/** Read only: opens and stats metadata but never chmods, creates, or reads bytes. */
export async function inspectLaunchdLogs(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy = DEFAULT_LAUNCHD_LOG_POLICY,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<LaunchdLogInspection> {
  assertPolicy(policy);
  assertCanonicalLogPaths(paths);

  const directory = await inspectDirectoryChain(paths.logDir, deps);
  if (directory.state === "missing") {
    return emptyInspection();
  }
  if (directory.state === "unsafe" || directory.state === "unreadable") {
    const issue = `log directory: ${directory.issue ?? directory.state}`;
    return {
      ...emptyInspection(false),
      canMaintain: false,
      issues: [issue],
    };
  }

  const [stdout, stderr] = await Promise.all([
    inspectStream(paths.stdoutPath, policy, deps),
    inspectStream(paths.stderrPath, policy, deps),
  ]);
  const artifacts = await inspectRotationArtifacts(paths, policy, deps);
  const files = [...stdout.files, ...stderr.files];
  const issues = [
    ...(directory.issue === undefined ? [] : [`log directory: ${directory.issue}`]),
    ...streamIssues("stdout", stdout),
    ...streamIssues("stderr", stderr),
    ...artifacts.issues,
  ];
  const unsafe = files.some((file) => file.state === "unsafe" || file.state === "unreadable");
  const repairable = directory.state === "repairable"
    || files.some((file) => file.state === "repairable");
  const oversized = files.some((file) => file.bytes > policy.maxBytes);

  return {
    stdout,
    stderr,
    present: artifacts.present || files.some((file) => file.state !== "missing"),
    canMaintain: !unsafe && artifacts.canMaintain,
    needsMaintenance: artifacts.present || repairable || oversized,
    pendingTransaction: artifacts.pendingTransaction,
    pendingMaintenance: artifacts.pendingMaintenance,
    issues,
  };
}

/**
 * Rotate only after the caller has proven every possible writer dead. All
 * source bytes are read through validated handles, all replacements are capped,
 * fsynced owner-only temporaries, and each destination identity is rechecked
 * immediately before its atomic replacement.
 */
export async function rotateStoppedLaunchdLogs(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy = DEFAULT_LAUNCHD_LOG_POLICY,
  deps: LaunchdLogDependencies = defaultLaunchdLogDependencies(),
): Promise<LaunchdLogRotationResult> {
  assertPolicy(policy);
  assertCanonicalLogPaths(paths);

  // Establish a complete read-only safety inventory before chmod, cleanup,
  // journal recovery, or replacement. Every mutating step revalidates the
  // identities it relies on, but an unsafe peer must prevent all repair.
  const preflight = await inspectLaunchdLogs(paths, policy, deps);
  if (!preflight.canMaintain) {
    throw new Error(`LaunchAgent log maintenance refused unsafe inventory: ${preflight.issues.join("; ")}`);
  }
  if (preflight.pendingTransaction) {
    // Metadata safety alone is insufficient: authenticate the bounded journal
    // schema and canonical target set before repairing directory permissions.
    if (await loadRotationJournal(paths, policy, deps) === undefined) {
      throw new Error("Pending LaunchAgent log rotation journal disappeared after preflight.");
    }
  }

  const directories = await openValidatedDirectoryChain(paths.logDir, deps);
  if (directories === undefined) return { changed: false, replacedFiles: 0 };
  const directory = directories.at(-1)!;

  const opened: OpenedLogFile[] = [];
  const preparedReplacements: PreparedReplacement[] = [];
  let journalPublished = false;
  try {
    for (const currentDirectory of directories) {
      await secureDirectory(currentDirectory, deps);
    }
    const recovered = await recoverOrCleanRotation(paths, policy, directories, deps);

    for (const path of streamPaths(paths.stdoutPath, policy.rotationCount)) {
      const file = await openValidatedLogFile(path, deps);
      if (file !== undefined) opened.push(file);
    }
    for (const path of streamPaths(paths.stderrPath, policy.rotationCount)) {
      const file = await openValidatedLogFile(path, deps);
      if (file !== undefined) opened.push(file);
    }

    // Do not mutate permissions until every present path has passed ownership,
    // link-count, type, and identity validation.
    for (const file of opened) await secureLogFile(file, deps);

    const byPath = new Map(opened.map((file) => [file.path, file] as const));
    const expectedInventory = new Map(opened.map((file) => [file.path, file.stats] as const));
    await assertOpenedInventory(paths, policy.rotationCount, expectedInventory, deps);
    const plans = [
      ...await buildStreamPlans(paths.stdoutPath, byPath, policy, deps),
      ...await buildStreamPlans(paths.stderrPath, byPath, policy, deps),
    ];
    if (plans.length === 0) {
      await assertDirectoryChainIdentity(directories, deps);
      await assertOpenedInventory(paths, policy.rotationCount, expectedInventory, deps);
      await deps.syncHandle(directory.handle);
      return {
        changed: recovered.changed
          || opened.some((file) => file.permissionsRepaired)
          || directories.some((entry) => entry.permissionsRepaired),
        replacedFiles: recovered.replacedFiles,
      };
    }

    await assertDirectoryChainIdentity(directories, deps);
    await assertOpenedInventory(paths, policy.rotationCount, expectedInventory, deps);
    for (const plan of plans) {
      const replacement = await prepareReplacement(plan, directories, deps);
      preparedReplacements.push(replacement);
    }

    await deps.syncHandle(directory.handle);
    try {
      await publishRotationJournal(paths, policy, preparedReplacements, directories, deps);
    } catch (error) {
      journalPublished = await lstatIfPresent(rotationJournalPath(paths), deps) !== undefined;
      throw error;
    }
    journalPublished = true;
    const committed = await recoverPublishedRotation(paths, policy, directories, deps);
    journalPublished = false;
    return {
      changed: true,
      replacedFiles: recovered.replacedFiles + committed.replacedFiles,
    };
  } finally {
    await Promise.all(opened.map(async (file) => await file.handle.close().catch(() => undefined)));
    if (!journalPublished) {
      await Promise.all(preparedReplacements.map(async (replacement) => {
        await removeKnownTemporary(replacement, directories, deps).catch(() => undefined);
      }));
      await removeKnownArtifact(rotationJournalNextPath(paths), directories, deps).catch(() => undefined);
    }
    await Promise.all(directories.map(async (entry) => await entry.handle.close().catch(() => undefined)));
  }
}

interface DirectoryInspection {
  readonly state: "missing" | "ok" | "repairable" | "unsafe" | "unreadable";
  readonly issue?: string;
}

interface RotationArtifactInspection {
  readonly present: boolean;
  readonly canMaintain: boolean;
  readonly pendingTransaction: boolean;
  readonly pendingMaintenance: boolean;
  readonly issues: readonly string[];
}

interface OpenedDirectory {
  readonly path: string;
  readonly requireOwnerPrivate: boolean;
  readonly handle: FileHandle;
  stats: Stats;
  permissionsRepaired: boolean;
}

interface OpenedLogFile {
  readonly path: string;
  readonly handle: FileHandle;
  stats: Stats;
  permissionsRepaired: boolean;
}

interface ReplacementPlan {
  readonly targetPath: string;
  readonly expectedTarget?: OpenedLogFile;
  readonly bytes: Buffer;
}

interface PreparedReplacement extends ReplacementPlan {
  readonly temporaryPath: string;
  readonly temporaryStats: Stats;
}

interface RotationFileFingerprint {
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface RotationJournalRecord {
  readonly target: string;
  readonly stage: string;
  readonly original: RotationFileFingerprint | null;
  readonly prepared: RotationFileFingerprint;
  readonly preparedSha256: string;
}

interface RotationJournalV1 {
  readonly version: 1;
  readonly policy: LaunchdLogPolicy;
  readonly records: readonly RotationJournalRecord[];
}

interface LoadedRotationJournal {
  readonly journal: RotationJournalV1;
  readonly stats: Stats;
}

interface LoadedMaintenanceIntent {
  readonly intent: LaunchdLogMaintenanceIntent;
  readonly stats: Stats;
}

const TRANSACTION_ARTIFACT_PREFIX = ".mono-agent-launchd-log-";
const ROTATION_JOURNAL_SUFFIX = "-rotation.v1.json";
const ROTATION_JOURNAL_NEXT_SUFFIX = "-rotation.v1.next";
const MAX_ROTATION_JOURNAL_BYTES = 64 * 1024;
const MAINTENANCE_INTENT_SUFFIX = "-maintenance.v1.json";
const MAINTENANCE_INTENT_NEXT_SUFFIX = "-maintenance.v1.next";
const MAX_MAINTENANCE_INTENT_BYTES = 4 * 1024;

async function inspectDirectoryChain(
  logDir: string,
  deps: LaunchdLogDependencies,
): Promise<DirectoryInspection> {
  let repairableIssue: string | undefined;
  for (const entry of canonicalDirectoryChain(logDir)) {
    const inspection = await inspectDirectory(entry.path, entry.requireOwnerPrivate, deps);
    if (inspection.state === "missing") return inspection;
    if (inspection.state === "unsafe" || inspection.state === "unreadable") {
      return {
        ...inspection,
        issue: `${entry.path === logDir ? "log directory" : "log parent"}: ${inspection.issue ?? inspection.state}`,
      };
    }
    if (inspection.state === "repairable") {
      repairableIssue = `${entry.path === logDir ? "log directory" : "log parent"}: ${inspection.issue ?? "permissions require repair"}`;
    }
  }
  try {
    await assertCanonicalDirectoryRealpath(logDir, deps);
  } catch (error) {
    return { state: "unsafe", issue: safeReason(error, logDir) };
  }
  return repairableIssue === undefined
    ? { state: "ok" }
    : { state: "repairable", issue: repairableIssue };
}

async function inspectRotationArtifacts(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  deps: LaunchdLogDependencies,
): Promise<RotationArtifactInspection> {
  const candidates = [
    { path: rotationJournalPath(paths), maxBytes: MAX_ROTATION_JOURNAL_BYTES, kind: "rotation" as const },
    { path: rotationJournalNextPath(paths), maxBytes: MAX_ROTATION_JOURNAL_BYTES, kind: "preparation" as const },
    { path: maintenanceIntentPath(paths), maxBytes: MAX_MAINTENANCE_INTENT_BYTES, kind: "maintenance" as const },
    { path: maintenanceIntentNextPath(paths), maxBytes: MAX_MAINTENANCE_INTENT_BYTES, kind: "preparation" as const },
    ...rotationStagePaths(paths, policy.rotationCount).map((path) => ({
      path,
      maxBytes: policy.maxBytes,
      kind: "preparation" as const,
    })),
  ];
  let present = false;
  let canMaintain = true;
  let pendingTransaction = false;
  let pendingMaintenance = false;
  const issues: string[] = [];
  for (const candidate of candidates) {
    const state = await inspectRotationArtifact(candidate.path, candidate.maxBytes, deps);
    if (state === undefined) continue;
    present = true;
    if (candidate.kind === "rotation") pendingTransaction = true;
    if (candidate.kind === "maintenance") pendingMaintenance = true;
    if (state !== "ok") {
      canMaintain = false;
      issues.push(`rotation transaction artifact: ${state}`);
    }
  }
  if (issues.length === 0) {
    if (pendingMaintenance) issues.push("pending launchd-log maintenance lifecycle requires recovery");
    if (pendingTransaction) issues.push("pending launchd-log rotation transaction requires recovery");
    if (present && !pendingMaintenance && !pendingTransaction) {
      issues.push("interrupted launchd-log rotation preparation requires cleanup");
    }
  }
  return { present, canMaintain, pendingTransaction, pendingMaintenance, issues };
}

async function inspectRotationArtifact(
  path: string,
  maxBytes: number,
  deps: LaunchdLogDependencies,
): Promise<"ok" | "unsafe" | "unreadable" | undefined> {
  let initial: Stats;
  try {
    initial = await deps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return undefined;
    return "unreadable";
  }
  try {
    assertOwnerRegularFile(initial, path, deps.currentUid(), "LaunchAgent log transaction artifact");
    if ((initial.mode & 0o777) !== 0o600 || initial.size > maxBytes) return "unsafe";
    const handle = await deps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const current = await deps.lstat(path);
      return sameFileSnapshot(initial, opened) && sameFileSnapshot(opened, current) ? "ok" : "unsafe";
    } finally {
      await handle.close();
    }
  } catch {
    return "unsafe";
  }
}

async function inspectDirectory(
  path: string,
  requireOwnerPrivate: boolean,
  deps: LaunchdLogDependencies,
): Promise<DirectoryInspection> {
  let initial: Stats;
  try {
    initial = await deps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return { state: "missing" };
    return { state: "unreadable", issue: errnoDescription(error) };
  }
  try {
    assertOwnerDirectory(initial, path, deps.currentUid(), "LaunchAgent log directory");
    const handle = await deps.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const observed = await handle.stat();
      assertOwnerDirectory(observed, path, deps.currentUid(), "LaunchAgent log directory");
      if (!sameFilesystemIdentity(initial, observed)) {
        throw new Error("directory identity changed during inspection");
      }
      const current = await deps.lstat(path);
      if (!sameFilesystemIdentity(observed, current)) {
        throw new Error("directory identity changed during inspection");
      }
      return !requireOwnerPrivate || (observed.mode & 0o777) === 0o700
        ? { state: "ok" }
        : { state: "repairable", issue: "permissions are not owner-only read/write/search" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { state: "unsafe", issue: safeReason(error, path) };
  }
}

async function inspectStream(
  activePath: string,
  policy: LaunchdLogPolicy,
  deps: LaunchdLogDependencies,
): Promise<LaunchdLogStreamInspection> {
  const files = await Promise.all(streamPaths(activePath, policy.rotationCount).map(async (path, generation) =>
    await inspectLogFile(path, generation, deps)));
  const activeBytes = files[0]?.bytes ?? 0;
  const retainedBytes = files.slice(1).reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(retainedBytes) || !Number.isSafeInteger(activeBytes + retainedBytes)) {
    throw new Error("LaunchAgent log inventory exceeds safe byte accounting.");
  }
  return {
    activeBytes,
    retainedBytes,
    totalBytes: activeBytes + retainedBytes,
    byteAccountingComplete: files.every((file) => file.state !== "unsafe" && file.state !== "unreadable"),
    files,
  };
}

async function inspectLogFile(
  path: string,
  generation: number,
  deps: LaunchdLogDependencies,
): Promise<LaunchdLogFileInspection> {
  let initial: Stats;
  try {
    initial = await deps.lstat(path);
  } catch (error) {
    return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")
      ? { generation, state: "missing", bytes: 0 }
      : { generation, state: "unreadable", bytes: 0, issue: errnoDescription(error) };
  }
  try {
    assertOwnerRegularFile(initial, path, deps.currentUid(), "LaunchAgent log");
    const handle = await deps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const observed = await handle.stat();
      assertOwnerRegularFile(observed, path, deps.currentUid(), "LaunchAgent log");
      if (!sameFileSnapshot(initial, observed)) throw new Error("identity changed during inspection");
      const current = await deps.lstat(path);
      if (!sameFileSnapshot(observed, current)) throw new Error("identity changed during inspection");
      return (observed.mode & 0o777) === 0o600
        ? { generation, state: "ok", bytes: observed.size }
        : { generation, state: "repairable", bytes: observed.size, issue: "permissions are not owner-only read/write" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      generation,
      state: "unsafe",
      bytes: Number.isSafeInteger(initial.size) && initial.size >= 0 ? initial.size : 0,
      issue: safeReason(error, path),
    };
  }
}

async function openValidatedDirectoryChain(
  logDir: string,
  deps: LaunchdLogDependencies,
): Promise<OpenedDirectory[] | undefined> {
  const opened: OpenedDirectory[] = [];
  try {
    for (const entry of canonicalDirectoryChain(logDir)) {
      const directory = await openValidatedDirectory(entry.path, entry.requireOwnerPrivate, deps);
      if (directory === undefined) {
        await Promise.all(opened.map(async (item) => await item.handle.close().catch(() => undefined)));
        return undefined;
      }
      opened.push(directory);
    }
    await assertDirectoryChainIdentity(opened, deps, false);
    return opened;
  } catch (error) {
    await Promise.all(opened.map(async (item) => await item.handle.close().catch(() => undefined)));
    throw error;
  }
}

async function openValidatedDirectory(
  path: string,
  requireOwnerPrivate: boolean,
  deps: LaunchdLogDependencies,
): Promise<OpenedDirectory | undefined> {
  let initial: Stats;
  try {
    initial = await deps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return undefined;
    throw error;
  }
  assertOwnerDirectory(initial, path, deps.currentUid(), "LaunchAgent log directory");
  const handle = await deps.open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const observed = await handle.stat();
    assertOwnerDirectory(observed, path, deps.currentUid(), "LaunchAgent log directory");
    if (!sameFilesystemIdentity(initial, observed)) throw new Error(`LaunchAgent log directory ${path} changed while opened.`);
    await assertDirectoryIdentity(path, observed, false, deps);
    return { path, requireOwnerPrivate, handle, stats: observed, permissionsRepaired: false };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openValidatedLogFile(
  path: string,
  deps: LaunchdLogDependencies,
): Promise<OpenedLogFile | undefined> {
  let initial: Stats;
  try {
    initial = await deps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return undefined;
    throw error;
  }
  assertOwnerRegularFile(initial, path, deps.currentUid(), "LaunchAgent log");
  const handle = await deps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const observed = await handle.stat();
    assertOwnerRegularFile(observed, path, deps.currentUid(), "LaunchAgent log");
    if (!sameFileSnapshot(initial, observed)) throw new Error(`LaunchAgent log ${path} changed while opened.`);
    const current = await deps.lstat(path);
    if (!sameFileSnapshot(observed, current)) throw new Error(`LaunchAgent log ${path} changed while opened.`);
    return { path, handle, stats: observed, permissionsRepaired: false };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function secureDirectory(
  directory: OpenedDirectory,
  deps: LaunchdLogDependencies,
): Promise<void> {
  if (directory.requireOwnerPrivate && (directory.stats.mode & 0o777) !== 0o700) {
    await directory.handle.chmod(0o700);
    directory.permissionsRepaired = true;
  }
  const secured = await directory.handle.stat();
  assertOwnerDirectory(secured, directory.path, deps.currentUid(), "LaunchAgent log directory");
  if (!sameFilesystemIdentity(directory.stats, secured)
    || (directory.requireOwnerPrivate && (secured.mode & 0o777) !== 0o700)) {
    throw new Error(`LaunchAgent log directory ${directory.path} changed or remained broadly accessible while secured.`);
  }
  await assertDirectoryIdentity(directory.path, secured, directory.requireOwnerPrivate, deps);
  directory.stats = secured;
}

async function secureLogFile(file: OpenedLogFile, deps: LaunchdLogDependencies): Promise<void> {
  if ((file.stats.mode & 0o777) !== 0o600) {
    await file.handle.chmod(0o600);
    file.permissionsRepaired = true;
  }
  const secured = await file.handle.stat();
  assertOwnerRegularFile(secured, file.path, deps.currentUid(), "LaunchAgent log");
  if (!sameFilesystemIdentity(file.stats, secured) || (secured.mode & 0o777) !== 0o600) {
    throw new Error(`LaunchAgent log ${file.path} changed or remained broadly accessible while secured.`);
  }
  const current = await deps.lstat(file.path);
  if (!sameFilesystemIdentity(secured, current)) throw new Error(`LaunchAgent log ${file.path} changed while secured.`);
  if (file.permissionsRepaired) await deps.syncHandle(file.handle);
  file.stats = secured;
}

async function buildStreamPlans(
  activePath: string,
  files: ReadonlyMap<string, OpenedLogFile>,
  policy: LaunchdLogPolicy,
  deps: LaunchdLogDependencies,
): Promise<ReplacementPlan[]> {
  const paths = streamPaths(activePath, policy.rotationCount);
  const active = files.get(activePath);
  if (active !== undefined && active.stats.size > policy.maxBytes) {
    const plans: ReplacementPlan[] = [];
    for (let generation = policy.rotationCount; generation >= 1; generation -= 1) {
      const targetPath = paths[generation]!;
      const source = files.get(paths[generation - 1]!);
      const expectedTarget = files.get(targetPath);
      if (source === undefined && expectedTarget === undefined) continue;
      plans.push({
        targetPath,
        ...(expectedTarget === undefined ? {} : { expectedTarget }),
        bytes: source === undefined ? Buffer.alloc(0) : await stableTail(source, policy.maxBytes, deps),
      });
    }
    plans.push({
      targetPath: activePath,
      expectedTarget: active,
      bytes: Buffer.alloc(0),
    });
    return plans;
  }

  const plans: ReplacementPlan[] = [];
  for (const path of paths) {
    const file = files.get(path);
    if (file === undefined || file.stats.size <= policy.maxBytes) continue;
    plans.push({
      targetPath: path,
      expectedTarget: file,
      bytes: await stableTail(file, policy.maxBytes, deps),
    });
  }
  return plans;
}

async function stableTail(
  file: OpenedLogFile,
  maxBytes: number,
  deps: LaunchdLogDependencies,
): Promise<Buffer> {
  const bytes = await deps.readTail(file.handle, file.stats.size, maxBytes);
  if (bytes.length > maxBytes) {
    throw new Error(`LaunchAgent log ${file.path} produced an oversized bounded tail.`);
  }
  const after = await file.handle.stat();
  if (!sameFileSnapshot(file.stats, after)) {
    throw new Error(`LaunchAgent log ${file.path} changed while its bounded tail was copied.`);
  }
  const current = await deps.lstat(file.path);
  if (!sameFileSnapshot(after, current)) {
    throw new Error(`LaunchAgent log ${file.path} changed while its bounded tail was copied.`);
  }
  return bytes;
}

async function prepareReplacement(
  plan: ReplacementPlan,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<PreparedReplacement> {
  const temporaryPath = rotationStagePath(plan.targetPath);
  await assertDirectoryChainIdentity(directories, deps);
  let handle: FileHandle | undefined;
  let openedStats: Stats | undefined;
  try {
    handle = await deps.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    openedStats = await handle.stat();
    assertOwnerRegularFile(openedStats, temporaryPath, deps.currentUid(), "temporary LaunchAgent log");
    await assertDirectoryChainIdentity(directories, deps);
    await handle.writeFile(plan.bytes);
    await handle.chmod(0o600);
    await deps.syncHandle(handle);
    const writtenStats = await handle.stat();
    assertOwnerRegularFile(writtenStats, temporaryPath, deps.currentUid(), "temporary LaunchAgent log");
    if ((writtenStats.mode & 0o777) !== 0o600 || writtenStats.size !== plan.bytes.length) {
      throw new Error(`Temporary LaunchAgent log ${temporaryPath} does not match its owner-only bounded payload.`);
    }
    await handle.close();
    handle = undefined;
    const temporaryStats = await deps.lstat(temporaryPath);
    assertOwnerRegularFile(temporaryStats, temporaryPath, deps.currentUid(), "temporary LaunchAgent log");
    if (!sameFileSnapshot(writtenStats, temporaryStats) || (temporaryStats.mode & 0o777) !== 0o600) {
      throw new Error(`Temporary LaunchAgent log ${temporaryPath} changed after its bounded payload was synced.`);
    }
    return { ...plan, temporaryPath, temporaryStats };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (openedStats !== undefined) {
      await removeKnownPath(temporaryPath, openedStats, directories, deps).catch(() => undefined);
    }
    throw error;
  }
}

async function assertPreparedReplacement(
  replacement: PreparedReplacement,
  deps: LaunchdLogDependencies,
): Promise<void> {
  const current = await deps.lstat(replacement.temporaryPath);
  assertOwnerRegularFile(current, replacement.temporaryPath, deps.currentUid(), "temporary LaunchAgent log");
  if (!sameFileSnapshot(current, replacement.temporaryStats)) {
    throw new Error(`Temporary LaunchAgent log ${replacement.temporaryPath} changed before commit.`);
  }
  if (await hashValidatedFile(replacement.temporaryPath, replacement.bytes.length, deps) !== sha256(replacement.bytes)) {
    throw new Error(`Temporary LaunchAgent log ${replacement.temporaryPath} payload changed before commit.`);
  }
}

async function recoverOrCleanRotation(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<LaunchdLogRotationResult> {
  const loaded = await loadRotationJournal(paths, policy, deps);
  if (loaded !== undefined) {
    await removeKnownArtifact(
      rotationJournalNextPath(paths),
      directories,
      deps,
      MAX_ROTATION_JOURNAL_BYTES,
    );
    await assertNoUnexpectedRotationStages(paths, policy, loaded.journal, deps);
    return await commitLoadedRotation(paths, policy, loaded, directories, deps);
  }

  let changed = await removeKnownArtifact(
    rotationJournalNextPath(paths),
    directories,
    deps,
    MAX_ROTATION_JOURNAL_BYTES,
  );
  // A stage can exist without a journal only when the process stopped before
  // publishing durable intent. Its deterministic reserved name bounds debris,
  // and no canonical destination can have been changed yet.
  for (const stagePath of rotationStagePaths(paths, policy.rotationCount)) {
    changed = await removeKnownArtifact(stagePath, directories, deps, policy.maxBytes) || changed;
  }
  return { changed, replacedFiles: 0 };
}

async function publishRotationJournal(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  replacements: readonly PreparedReplacement[],
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<void> {
  if (replacements.length < 1) throw new Error("LaunchAgent log rotation journal requires a replacement.");
  const journal: RotationJournalV1 = {
    version: 1,
    policy: { maxBytes: policy.maxBytes, rotationCount: policy.rotationCount },
    records: replacements.map((replacement) => ({
      target: basename(replacement.targetPath),
      stage: basename(replacement.temporaryPath),
      original: replacement.expectedTarget === undefined
        ? null
        : fingerprintFor(replacement.expectedTarget.stats),
      prepared: fingerprintFor(replacement.temporaryStats),
      preparedSha256: sha256(replacement.bytes),
    })),
  };
  validateRotationJournal(journal, paths, policy);
  const data = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
  if (data.length > MAX_ROTATION_JOURNAL_BYTES) {
    throw new Error("LaunchAgent log rotation journal exceeds its fixed size bound.");
  }

  await assertDirectoryChainIdentity(directories, deps);
  for (const replacement of replacements) await assertPreparedReplacement(replacement, deps);
  const nextPath = rotationJournalNextPath(paths);
  const nextStats = await writeOwnerPrivateArtifact(nextPath, data, directories, deps);
  try {
    await assertDirectoryChainIdentity(directories, deps);
    for (const replacement of replacements) {
      await assertPreparedReplacement(replacement, deps);
      await assertExpectedDestination(replacement, deps);
    }
    await assertPathMissing(rotationJournalPath(paths), deps);
    const currentNext = await deps.lstat(nextPath);
    if (!sameFileSnapshot(currentNext, nextStats)) {
      throw new Error("LaunchAgent log rotation journal changed before publication.");
    }
    await deps.rename(nextPath, rotationJournalPath(paths));
    const published = await deps.lstat(rotationJournalPath(paths));
    if (!matchesCommittedFingerprint(published, fingerprintFor(nextStats))) {
      throw new Error("LaunchAgent log rotation journal changed while it was published.");
    }
    await deps.syncHandle(directories.at(-1)!.handle);
  } catch (error) {
    await removeKnownPath(nextPath, nextStats, directories, deps).catch(() => undefined);
    throw error;
  }
}

async function recoverPublishedRotation(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<LaunchdLogRotationResult> {
  const loaded = await loadRotationJournal(paths, policy, deps);
  if (loaded === undefined) throw new Error("Published LaunchAgent log rotation journal disappeared.");
  await assertNoUnexpectedRotationStages(paths, policy, loaded.journal, deps);
  return await commitLoadedRotation(paths, policy, loaded, directories, deps);
}

async function commitLoadedRotation(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  loaded: LoadedRotationJournal,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<LaunchdLogRotationResult> {
  let replacedFiles = 0;
  for (const record of loaded.journal.records) {
    const targetPath = join(paths.logDir, record.target);
    const stagePath = join(paths.logDir, record.stage);
    const stage = await lstatIfPresent(stagePath, deps);
    const target = await lstatIfPresent(targetPath, deps);

    if (stage === undefined) {
      if (target === undefined || !matchesCommittedFingerprint(target, record.prepared)) {
        throw new Error(`LaunchAgent log ${targetPath} does not match its committed rotation record.`);
      }
      if (await hashValidatedFile(targetPath, record.prepared.size, deps) !== record.preparedSha256) {
        throw new Error(`LaunchAgent log ${targetPath} payload does not match its committed rotation record.`);
      }
      continue;
    }

    assertOwnerRegularFile(stage, stagePath, deps.currentUid(), "staged LaunchAgent log");
    if ((stage.mode & 0o777) !== 0o600 || stage.size > policy.maxBytes
      || !matchesFingerprint(stage, record.prepared)) {
      throw new Error(`Staged LaunchAgent log ${stagePath} changed before recovery.`);
    }
    if (await hashValidatedFile(stagePath, record.prepared.size, deps) !== record.preparedSha256) {
      throw new Error(`Staged LaunchAgent log ${stagePath} payload changed before recovery.`);
    }
    if (record.original === null ? target !== undefined : target === undefined || !matchesFingerprint(target, record.original)) {
      throw new Error(`LaunchAgent log ${targetPath} changed before its journaled replacement.`);
    }

    await deps.beforeCommit?.(targetPath);
    await assertDirectoryChainIdentity(directories, deps);
    await assertKnownPath(rotationJournalPath(paths), loaded.stats, deps);
    const currentStage = await deps.lstat(stagePath);
    if (!sameFileSnapshot(currentStage, stage)) {
      throw new Error(`Staged LaunchAgent log ${stagePath} changed before commit.`);
    }
    if (await hashValidatedFile(stagePath, record.prepared.size, deps) !== record.preparedSha256) {
      throw new Error(`Staged LaunchAgent log ${stagePath} payload changed before commit.`);
    }
    const currentTarget = await lstatIfPresent(targetPath, deps);
    if (record.original === null
      ? currentTarget !== undefined
      : currentTarget === undefined || !matchesFingerprint(currentTarget, record.original)) {
      throw new Error(`LaunchAgent log ${targetPath} changed before commit.`);
    }
    await deps.rename(stagePath, targetPath);
    const committed = await deps.lstat(targetPath);
    assertOwnerRegularFile(committed, targetPath, deps.currentUid(), "committed LaunchAgent log");
    if ((committed.mode & 0o777) !== 0o600 || committed.size > policy.maxBytes
      || !matchesCommittedFingerprint(committed, record.prepared)) {
      throw new Error(`Committed LaunchAgent log ${targetPath} violates its journaled owner-only size policy.`);
    }
    if (await hashValidatedFile(targetPath, record.prepared.size, deps) !== record.preparedSha256) {
      throw new Error(`Committed LaunchAgent log ${targetPath} payload differs from its journaled value.`);
    }
    await deps.syncHandle(directories.at(-1)!.handle);
    replacedFiles += 1;
  }

  await assertDirectoryChainIdentity(directories, deps);
  for (const record of loaded.journal.records) {
    const target = await deps.lstat(join(paths.logDir, record.target));
    if (!matchesCommittedFingerprint(target, record.prepared)) {
      throw new Error("LaunchAgent log rotation did not reach its complete journaled state.");
    }
    if (await hashValidatedFile(join(paths.logDir, record.target), record.prepared.size, deps) !== record.preparedSha256) {
      throw new Error("LaunchAgent log rotation payload did not reach its complete journaled state.");
    }
    await assertPathMissing(join(paths.logDir, record.stage), deps);
  }
  await removeExpectedPath(rotationJournalPath(paths), loaded.stats, directories, deps);
  await assertPathMissing(rotationJournalPath(paths), deps);
  await deps.syncHandle(directories.at(-1)!.handle);
  return { changed: true, replacedFiles };
}

async function loadRotationJournal(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  deps: LaunchdLogDependencies,
): Promise<LoadedRotationJournal | undefined> {
  const path = rotationJournalPath(paths);
  const initial = await lstatIfPresent(path, deps);
  if (initial === undefined) return undefined;
  assertOwnerRegularFile(initial, path, deps.currentUid(), "LaunchAgent log rotation journal");
  if ((initial.mode & 0o777) !== 0o600 || initial.size < 1 || initial.size > MAX_ROTATION_JOURNAL_BYTES) {
    throw new Error("LaunchAgent log rotation journal violates its owner-only size bound.");
  }
  const handle = await deps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!sameFileSnapshot(initial, opened)) throw new Error("LaunchAgent log rotation journal changed while opened.");
    const data = await readExactFile(handle, opened.size, "LaunchAgent log rotation journal");
    const after = await handle.stat();
    const current = await deps.lstat(path);
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, current) || data.length !== after.size) {
      throw new Error("LaunchAgent log rotation journal changed while read.");
    }
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    const journal = parseRotationJournal(parsed);
    validateRotationJournal(journal, paths, policy);
    return { journal, stats: after };
  } finally {
    await handle.close();
  }
}

async function loadMaintenanceIntent(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  deps: LaunchdLogDependencies,
): Promise<LoadedMaintenanceIntent | undefined> {
  const path = maintenanceIntentPath(paths);
  const initial = await lstatIfPresent(path, deps);
  if (initial === undefined) return undefined;
  assertOwnerRegularFile(initial, path, deps.currentUid(), "LaunchAgent log maintenance intent");
  if ((initial.mode & 0o777) !== 0o600 || initial.size < 1 || initial.size > MAX_MAINTENANCE_INTENT_BYTES) {
    throw new Error("LaunchAgent log maintenance intent violates its owner-only size bound.");
  }
  const handle = await deps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!sameFileSnapshot(initial, opened)) throw new Error("LaunchAgent log maintenance intent changed while opened.");
    const data = await readExactFile(handle, opened.size, "LaunchAgent log maintenance intent");
    const after = await handle.stat();
    const current = await deps.lstat(path);
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, current) || data.length !== after.size) {
      throw new Error("LaunchAgent log maintenance intent changed while read.");
    }
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    if (!isPlainRecord(parsed) || parsed.version !== 1
      || (parsed.phase !== "stopping" && parsed.phase !== "stopped" && parsed.phase !== "restoring")
      || typeof parsed.label !== "string" || typeof parsed.plistFingerprint !== "string") {
      throw new Error("LaunchAgent log maintenance intent has an invalid schema.");
    }
    const intent: LaunchdLogMaintenanceIntent = {
      version: 1,
      phase: parsed.phase,
      label: parsed.label,
      plistFingerprint: parsed.plistFingerprint,
    };
    validateMaintenanceIntent(intent);
    return { intent, stats: after };
  } finally {
    await handle.close();
  }
}

function validateMaintenanceIntent(intent: LaunchdLogMaintenanceIntent): void {
  if (intent.phase !== "stopping" && intent.phase !== "stopped" && intent.phase !== "restoring") {
    throw new Error("LaunchAgent log maintenance intent has an invalid lifecycle phase.");
  }
  if (!/^com\.mono-agent\.[a-z0-9][a-z0-9-]*$/u.test(intent.label)) {
    throw new Error("LaunchAgent log maintenance intent has an invalid label.");
  }
  if (!/^[A-Za-z0-9._:-]{1,1024}$/u.test(intent.plistFingerprint)) {
    throw new Error("LaunchAgent log maintenance intent has an invalid plist fingerprint.");
  }
}

function sameMaintenanceIntent(
  left: LaunchdLogMaintenanceIntent,
  right: LaunchdLogMaintenanceIntent,
): boolean {
  return left.version === right.version
    && left.phase === right.phase
    && left.label === right.label
    && left.plistFingerprint === right.plistFingerprint;
}

function parseRotationJournal(value: unknown): RotationJournalV1 {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.policy)
    || !Array.isArray(value.records)) {
    throw new Error("LaunchAgent log rotation journal has an invalid schema.");
  }
  const policy = value.policy;
  const maxBytes = policy.maxBytes;
  const rotationCount = policy.rotationCount;
  if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(rotationCount)) {
    throw new Error("LaunchAgent log rotation journal has an invalid policy.");
  }
  return {
    version: 1,
    policy: { maxBytes: maxBytes as number, rotationCount: rotationCount as number },
    records: value.records.map((record) => parseRotationJournalRecord(record)),
  };
}

function parseRotationJournalRecord(value: unknown): RotationJournalRecord {
  if (!isPlainRecord(value) || typeof value.target !== "string" || typeof value.stage !== "string"
    || typeof value.preparedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.preparedSha256)) {
    throw new Error("LaunchAgent log rotation journal has an invalid record.");
  }
  return {
    target: value.target,
    stage: value.stage,
    original: value.original === null ? null : parseRotationFingerprint(value.original),
    prepared: parseRotationFingerprint(value.prepared),
    preparedSha256: value.preparedSha256,
  };
}

function parseRotationFingerprint(value: unknown): RotationFileFingerprint {
  if (!isPlainRecord(value) || typeof value.dev !== "string" || typeof value.ino !== "string") {
    throw new Error("LaunchAgent log rotation journal has an invalid fingerprint.");
  }
  for (const key of ["uid", "nlink", "mode", "size"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new Error("LaunchAgent log rotation journal has an invalid fingerprint.");
    }
  }
  for (const key of ["mtimeMs", "ctimeMs"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error("LaunchAgent log rotation journal has an invalid fingerprint.");
    }
  }
  return {
    dev: value.dev,
    ino: value.ino,
    uid: value.uid as number,
    nlink: value.nlink as number,
    mode: value.mode as number,
    size: value.size as number,
    mtimeMs: value.mtimeMs as number,
    ctimeMs: value.ctimeMs as number,
  };
}

function validateRotationJournal(
  journal: RotationJournalV1,
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
): void {
  if (journal.policy.maxBytes !== policy.maxBytes || journal.policy.rotationCount !== policy.rotationCount) {
    throw new Error("LaunchAgent log rotation journal policy does not match the fixed active policy.");
  }
  const allowedTargets = new Set([
    ...streamPaths(paths.stdoutPath, policy.rotationCount),
    ...streamPaths(paths.stderrPath, policy.rotationCount),
  ].map((path) => basename(path)));
  if (journal.records.length < 1 || journal.records.length > allowedTargets.size) {
    throw new Error("LaunchAgent log rotation journal has an invalid record count.");
  }
  const targets = new Set<string>();
  const stages = new Set<string>();
  for (const record of journal.records) {
    if (!allowedTargets.has(record.target) || basename(record.target) !== record.target) {
      throw new Error("LaunchAgent log rotation journal names a non-canonical target.");
    }
    const expectedStage = basename(rotationStagePath(join(paths.logDir, record.target)));
    if (record.stage !== expectedStage || basename(record.stage) !== record.stage) {
      throw new Error("LaunchAgent log rotation journal names a non-canonical stage.");
    }
    if (targets.has(record.target) || stages.has(record.stage)) {
      throw new Error("LaunchAgent log rotation journal contains duplicate records.");
    }
    if (record.prepared.size > policy.maxBytes || (record.prepared.mode & 0o777) !== 0o600
      || record.prepared.nlink !== 1) {
      throw new Error("LaunchAgent log rotation journal contains an unsafe prepared file.");
    }
    targets.add(record.target);
    stages.add(record.stage);
  }
}

async function assertNoUnexpectedRotationStages(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  policy: LaunchdLogPolicy,
  journal: RotationJournalV1,
  deps: LaunchdLogDependencies,
): Promise<void> {
  const expected = new Set(journal.records.map((record) => join(paths.logDir, record.stage)));
  for (const stagePath of rotationStagePaths(paths, policy.rotationCount)) {
    if (!expected.has(stagePath) && await lstatIfPresent(stagePath, deps) !== undefined) {
      throw new Error(`Unexpected staged LaunchAgent log ${stagePath} exists beside a pending transaction.`);
    }
  }
}

async function writeOwnerPrivateArtifact(
  path: string,
  data: Buffer,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<Stats> {
  await assertDirectoryChainIdentity(directories, deps);
  await assertPathMissing(path, deps);
  let handle: FileHandle | undefined;
  let identity: Stats | undefined;
  try {
    handle = await deps.open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    identity = await handle.stat();
    assertOwnerRegularFile(identity, path, deps.currentUid(), "temporary LaunchAgent log artifact");
    await assertDirectoryChainIdentity(directories, deps);
    await handle.writeFile(data);
    await handle.chmod(0o600);
    await deps.syncHandle(handle);
    const written = await handle.stat();
    if ((written.mode & 0o777) !== 0o600 || written.size !== data.length) {
      throw new Error("Temporary LaunchAgent log artifact violates its owner-only payload.");
    }
    await handle.close();
    handle = undefined;
    const current = await deps.lstat(path);
    if (!sameFileSnapshot(written, current)) {
      throw new Error("Temporary LaunchAgent log artifact changed after it was synced.");
    }
    return current;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (identity !== undefined) await removeKnownPath(path, identity, directories, deps).catch(() => undefined);
    throw error;
  }
}

async function removeKnownArtifact(
  path: string,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
  maxBytes = MAX_ROTATION_JOURNAL_BYTES,
): Promise<boolean> {
  const current = await lstatIfPresent(path, deps);
  if (current === undefined) return false;
  assertOwnerRegularFile(current, path, deps.currentUid(), "LaunchAgent log transaction artifact");
  if ((current.mode & 0o777) !== 0o600 || current.size > maxBytes) {
    throw new Error(`LaunchAgent log transaction artifact ${path} violates its owner-only size bound.`);
  }
  await assertDirectoryChainIdentity(directories, deps);
  const confirmed = await deps.lstat(path);
  if (!sameFileSnapshot(current, confirmed)) {
    throw new Error(`LaunchAgent log transaction artifact ${path} changed before cleanup.`);
  }
  await deps.rm(path);
  return true;
}

async function assertKnownPath(path: string, expected: Stats, deps: LaunchdLogDependencies): Promise<void> {
  const current = await deps.lstat(path);
  if (!sameFileSnapshot(current, expected)) throw new Error(`LaunchAgent log transaction artifact ${path} changed.`);
}

async function assertPathMissing(path: string, deps: LaunchdLogDependencies): Promise<void> {
  if (await lstatIfPresent(path, deps) !== undefined) {
    throw new Error(`LaunchAgent log transaction artifact ${path} already exists.`);
  }
}

async function lstatIfPresent(path: string, deps: LaunchdLogDependencies): Promise<Stats | undefined> {
  try {
    return await deps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function hashValidatedFile(
  path: string,
  expectedSize: number,
  deps: LaunchdLogDependencies,
): Promise<string> {
  const initial = await deps.lstat(path);
  assertOwnerRegularFile(initial, path, deps.currentUid(), "LaunchAgent log transaction file");
  if (initial.size !== expectedSize) {
    throw new Error(`LaunchAgent log transaction file ${path} changed size before hashing.`);
  }
  const handle = await deps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!sameFileSnapshot(initial, opened)) {
      throw new Error(`LaunchAgent log transaction file ${path} changed while opened.`);
    }
    const data = await readExactFile(handle, expectedSize, "LaunchAgent log transaction file");
    const after = await handle.stat();
    const current = await deps.lstat(path);
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, current) || data.length !== after.size) {
      throw new Error(`LaunchAgent log transaction file ${path} changed while hashed.`);
    }
    return sha256(data);
  } finally {
    await handle.close();
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function fingerprintFor(stats: Stats): RotationFileFingerprint {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    uid: stats.uid,
    nlink: stats.nlink,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function matchesFingerprint(stats: Stats, fingerprint: RotationFileFingerprint): boolean {
  return String(stats.dev) === fingerprint.dev
    && String(stats.ino) === fingerprint.ino
    && stats.uid === fingerprint.uid
    && stats.nlink === fingerprint.nlink
    && stats.mode === fingerprint.mode
    && stats.size === fingerprint.size
    && stats.mtimeMs === fingerprint.mtimeMs
    && stats.ctimeMs === fingerprint.ctimeMs;
}

function matchesCommittedFingerprint(stats: Stats, fingerprint: RotationFileFingerprint): boolean {
  // An atomic rename may update ctime while preserving the staged inode and
  // payload. Identity, ownership, links, mode, size, and content mtime remain
  // the durable proof that this is the published stage.
  return String(stats.dev) === fingerprint.dev
    && String(stats.ino) === fingerprint.ino
    && stats.uid === fingerprint.uid
    && stats.nlink === fingerprint.nlink
    && stats.mode === fingerprint.mode
    && stats.size === fingerprint.size
    && stats.mtimeMs === fingerprint.mtimeMs;
}

function rotationJournalPath(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
): string {
  return join(
    paths.logDir,
    `${TRANSACTION_ARTIFACT_PREFIX}${transactionArtifactKey(paths)}${ROTATION_JOURNAL_SUFFIX}`,
  );
}

function maintenanceIntentPath(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
): string {
  return join(
    paths.logDir,
    `${TRANSACTION_ARTIFACT_PREFIX}${transactionArtifactKey(paths)}${MAINTENANCE_INTENT_SUFFIX}`,
  );
}

function maintenanceIntentNextPath(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
): string {
  return join(
    paths.logDir,
    `${TRANSACTION_ARTIFACT_PREFIX}${transactionArtifactKey(paths)}${MAINTENANCE_INTENT_NEXT_SUFFIX}`,
  );
}

function rotationJournalNextPath(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
): string {
  return join(
    paths.logDir,
    `${TRANSACTION_ARTIFACT_PREFIX}${transactionArtifactKey(paths)}${ROTATION_JOURNAL_NEXT_SUFFIX}`,
  );
}

function transactionArtifactKey(
  paths: Pick<LaunchdPaths, "stdoutPath" | "stderrPath">,
): string {
  return createHash("sha256")
    .update(paths.stdoutPath)
    .update("\0")
    .update(paths.stderrPath)
    .digest("hex")
    .slice(0, 24);
}

function rotationStagePath(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.rotate.stage`);
}

function rotationStagePaths(
  paths: Pick<LaunchdPaths, "stdoutPath" | "stderrPath">,
  rotationCount: number,
): string[] {
  return [
    ...streamPaths(paths.stdoutPath, rotationCount),
    ...streamPaths(paths.stderrPath, rotationCount),
  ].map((path) => rotationStagePath(path));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertExpectedDestination(
  replacement: PreparedReplacement,
  deps: LaunchdLogDependencies,
): Promise<void> {
  let current: Stats | undefined;
  try {
    current = await deps.lstat(replacement.targetPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  if (replacement.expectedTarget === undefined) {
    if (current !== undefined) throw new Error(`LaunchAgent log ${replacement.targetPath} appeared before commit.`);
    return;
  }
  if (current === undefined || !sameFileSnapshot(current, replacement.expectedTarget.stats)) {
    throw new Error(`LaunchAgent log ${replacement.targetPath} changed before commit.`);
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: Stats,
  requireOwnerPrivate: boolean,
  deps: LaunchdLogDependencies,
): Promise<void> {
  const current = await deps.lstat(path);
  assertOwnerDirectory(current, path, deps.currentUid(), "LaunchAgent log directory");
  if (!sameFilesystemIdentity(expected, current)) throw new Error(`LaunchAgent log directory ${path} changed.`);
  if (requireOwnerPrivate && (current.mode & 0o777) !== 0o700) {
    throw new Error(`LaunchAgent log directory ${path} is not owner-private.`);
  }
}

async function assertDirectoryChainIdentity(
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
  enforcePrivateModes = true,
): Promise<void> {
  for (const directory of directories) {
    await assertDirectoryIdentity(
      directory.path,
      directory.stats,
      enforcePrivateModes && directory.requireOwnerPrivate,
      deps,
    );
  }
  const logDir = directories.at(-1)?.path;
  if (logDir !== undefined) await assertCanonicalDirectoryRealpath(logDir, deps);
}

async function assertCanonicalDirectoryRealpath(logDir: string, deps: LaunchdLogDependencies): Promise<void> {
  const canonical = await deps.realpath(logDir);
  if (canonical !== logDir) {
    throw new Error(`LaunchAgent log directory ${logDir} traverses a symbolic-link or non-canonical parent.`);
  }
}

async function assertOpenedInventory(
  paths: Pick<LaunchdPaths, "stdoutPath" | "stderrPath">,
  rotationCount: number,
  opened: ReadonlyMap<string, Stats>,
  deps: LaunchdLogDependencies,
): Promise<void> {
  for (const path of [
    ...streamPaths(paths.stdoutPath, rotationCount),
    ...streamPaths(paths.stderrPath, rotationCount),
  ]) {
    const expected = opened.get(path);
    let current: Stats | undefined;
    try {
      current = await deps.lstat(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (expected === undefined) {
      if (current !== undefined) throw new Error(`LaunchAgent log ${path} appeared after inventory.`);
    } else if (current === undefined || !sameFileSnapshot(current, expected)) {
      throw new Error(`LaunchAgent log ${path} changed after inventory.`);
    }
  }
}

async function removeKnownTemporary(
  replacement: PreparedReplacement,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<void> {
  await removeKnownPath(replacement.temporaryPath, replacement.temporaryStats, directories, deps);
}

async function removeKnownPath(
  path: string,
  expected: Stats,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<void> {
  await assertDirectoryChainIdentity(directories, deps);
  let current: Stats;
  try {
    current = await deps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!sameFilesystemIdentity(current, expected)) return;
  await deps.rm(path);
}

async function removeExpectedPath(
  path: string,
  expected: Stats,
  directories: readonly OpenedDirectory[],
  deps: LaunchdLogDependencies,
): Promise<void> {
  await assertDirectoryChainIdentity(directories, deps);
  const current = await deps.lstat(path);
  if (!sameFileSnapshot(current, expected)) {
    throw new Error(`LaunchAgent log transaction artifact ${path} changed before required cleanup.`);
  }
  await deps.rm(path);
}

async function readFileTail(handle: FileHandle, size: number, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("LaunchAgent log size is not a safe integer.");
  const length = Math.min(size, maxBytes);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, size - length + offset);
    if (result.bytesRead === 0) throw new Error("LaunchAgent log ended while its bounded tail was copied.");
    offset += result.bytesRead;
  }
  return bytes;
}

async function readExactFile(handle: FileHandle, size: number, description: string): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${description} has an unsafe size.`);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) throw new Error(`${description} ended while its bounded contents were read.`);
    offset += result.bytesRead;
  }
  return bytes;
}

function streamPaths(activePath: string, rotationCount: number): string[] {
  return [activePath, ...Array.from({ length: rotationCount }, (_, index) => `${activePath}.${index + 1}`)];
}

function streamIssues(label: string, stream: LaunchdLogStreamInspection): string[] {
  return stream.files.flatMap((file) => file.issue === undefined
    ? []
    : [`${label}${file.generation === 0 ? "" : `.${file.generation}`}: ${file.issue}`]);
}

function emptyStream(byteAccountingComplete = true): LaunchdLogStreamInspection {
  return { activeBytes: 0, retainedBytes: 0, totalBytes: 0, byteAccountingComplete, files: [] };
}

function emptyInspection(byteAccountingComplete = true): LaunchdLogInspection {
  return {
    stdout: emptyStream(byteAccountingComplete),
    stderr: emptyStream(byteAccountingComplete),
    present: false,
    canMaintain: true,
    needsMaintenance: false,
    pendingTransaction: false,
    pendingMaintenance: false,
    issues: [],
  };
}

function assertCanonicalLogPaths(
  paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
): void {
  for (const [label, path] of [
    ["log directory", paths.logDir],
    ["stdout", paths.stdoutPath],
    ["stderr", paths.stderrPath],
  ] as const) {
    if (path !== resolve(path)) throw new Error(`LaunchAgent ${label} path must be normalized and absolute.`);
  }
  const logDir = resolve(paths.logDir);
  canonicalDirectoryChain(logDir);
  if (resolve(paths.stdoutPath) === resolve(paths.stderrPath)) {
    throw new Error("LaunchAgent stdout and stderr logs must be distinct canonical files.");
  }
  for (const [label, path] of [["stdout", paths.stdoutPath], ["stderr", paths.stderrPath]] as const) {
    if (dirname(resolve(path)) !== logDir) {
      throw new Error(`LaunchAgent ${label} log must be a direct child of its canonical log directory.`);
    }
  }
  const canonicalTargets = [
    ...streamPaths(paths.stdoutPath, 32),
    ...streamPaths(paths.stderrPath, 32),
  ];
  if (new Set(canonicalTargets).size !== canonicalTargets.length) {
    throw new Error("LaunchAgent stdout and stderr rotation generations must not overlap.");
  }
  if (canonicalTargets.some((path) => basename(path).startsWith(TRANSACTION_ARTIFACT_PREFIX)
    || basename(path).endsWith(".rotate.stage"))) {
    throw new Error("LaunchAgent log filenames must not collide with reserved maintenance artifacts.");
  }
}

function canonicalDirectoryChain(logDir: string): readonly {
  readonly path: string;
  readonly requireOwnerPrivate: boolean;
}[] {
  const stateDir = dirname(logDir);
  const homeDir = dirname(stateDir);
  if (basename(logDir) !== "logs" || basename(stateDir) !== ".mono-agent" || homeDir === stateDir) {
    throw new Error("LaunchAgent log directory must be the canonical <account-home>/.mono-agent/logs path.");
  }
  return [
    { path: homeDir, requireOwnerPrivate: false },
    { path: stateDir, requireOwnerPrivate: true },
    { path: logDir, requireOwnerPrivate: true },
  ];
}

function assertPolicy(policy: LaunchdLogPolicy): void {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1) {
    throw new Error("LaunchAgent log maxBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(policy.rotationCount) || policy.rotationCount < 1 || policy.rotationCount > 32) {
    throw new Error("LaunchAgent log rotationCount must be an integer between 1 and 32.");
  }
}

function assertOwnerDirectory(details: Stats, path: string, uid: number | undefined, description: string): void {
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${description} ${path} must be a real directory.`);
  assertOwner(details, path, uid, description);
}

function assertOwnerRegularFile(details: Stats, path: string, uid: number | undefined, description: string): void {
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${description} ${path} must be a regular non-symbolic-link file.`);
  if (details.nlink !== 1) throw new Error(`${description} ${path} must have exactly one filesystem link.`);
  if (!Number.isSafeInteger(details.size) || details.size < 0) throw new Error(`${description} ${path} has an unsafe size.`);
  assertOwner(details, path, uid, description);
}

function assertOwner(details: Stats, path: string, uid: number | undefined, description: string): void {
  if (uid !== undefined && details.uid !== uid) throw new Error(`${description} ${path} is not owned by the current user.`);
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

function safeReason(error: unknown, path: string): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(path, "<path>");
}

function errnoDescription(error: unknown): string {
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "unreadable";
  return code;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

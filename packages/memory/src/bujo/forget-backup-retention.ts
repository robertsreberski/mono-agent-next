import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  assertExplicitMemoryForgetBackupDirectoryInfo,
  assertExplicitMemoryForgetPrivateArtifactInfo,
  assertSameExplicitMemoryForgetFile,
  assertSameExplicitMemoryForgetSnapshot,
  parseExplicitMemoryForgetBackupManifest,
  type ExplicitMemoryForgetBackupManifest,
} from "./explicit-forget.js";
import { acquireMemoryMaintenanceLease } from "./maintenance.js";

export const DEFAULT_MEMORY_FORGET_BACKUP_MAX_AGE_DAYS = 30;
export const DEFAULT_MEMORY_FORGET_BACKUP_MAX_COUNT = 3;

const DAY_MS = 24 * 60 * 60 * 1_000;

interface CandidateHookInput {
  readonly path: string;
  readonly relativePath: string;
  readonly claimedPath?: string;
}

export interface MemoryForgetBackupRetentionOptions {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly clock?: () => number;
  readonly shouldContinue?: () => boolean;
  /** Deterministic race/cancellation seams; production leaves these unset. */
  readonly hooks?: {
    readonly beforeClaim?: (candidate: CandidateHookInput) => void | Promise<void>;
    readonly afterClaim?: (candidate: CandidateHookInput & { readonly claimedPath: string }) => void | Promise<void>;
  };
}

export interface MemoryForgetBackupRetentionResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly candidateCount: number;
  readonly retainedCount: number;
  readonly prunedCount: number;
  readonly prunedPaths: readonly string[];
  readonly warnings: readonly string[];
  readonly skippedForActiveMaintenance: boolean;
}

interface Candidate {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly parentPath: string;
  readonly updatedAtMs: number;
  readonly policy: "bounded" | "staging" | "discardable";
  readonly requirePrivate: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly managedClaimPrefix?: string;
}

interface RetentionRoot {
  readonly root: string;
  readonly parent: string;
  readonly parentInfo: Stats;
  readonly rootName: string;
}

/** Bound package-owned and conventional operator forget snapshots for one built-in memory root. */
export async function pruneExplicitMemoryForgetBackups(
  options: MemoryForgetBackupRetentionOptions,
): Promise<MemoryForgetBackupRetentionResult> {
  const dryRun = options.dryRun ?? false;
  const warnings: string[] = [];
  const retentionRoot = await resolveRetentionRoot(options.root, warnings);
  if (retentionRoot === undefined) {
    return emptyResult(resolve(options.root), dryRun, warnings);
  }

  let maintenance: ReturnType<typeof acquireMemoryMaintenanceLease>;
  try {
    maintenance = acquireMemoryMaintenanceLease(retentionRoot.root);
  } catch (error) {
    warnings.push(`sweep skipped because memory maintenance is active: ${reasonOf(error)}`);
    return emptyResult(retentionRoot.root, dryRun, warnings, true);
  }

  try {
    if (await entryExists(maintenance.transactionPath)) {
      warnings.push("sweep skipped because a durable memory-maintenance transaction requires recovery");
      return emptyResult(retentionRoot.root, dryRun, warnings, true);
    }
    if (!shouldContinue(options)) return emptyResult(retentionRoot.root, dryRun, warnings);

    const candidates = await collectCandidates(retentionRoot, options, warnings);
    const now = options.clock?.() ?? Date.now();
    const cutoff = now - DEFAULT_MEMORY_FORGET_BACKUP_MAX_AGE_DAYS * DAY_MS;
    const selected = new Set<Candidate>();
    for (const policy of ["bounded", "staging"] as const) {
      candidates
        .filter((candidate) => candidate.policy === policy)
        .sort(compareNewestFirst)
        .forEach((candidate, index) => {
          if (index >= DEFAULT_MEMORY_FORGET_BACKUP_MAX_COUNT || candidate.updatedAtMs < cutoff) {
            selected.add(candidate);
          }
        });
    }
    for (const candidate of candidates) {
      if (candidate.policy === "discardable") selected.add(candidate);
    }

    const prunedPaths: string[] = [];
    for (const candidate of [...selected].sort(compareNewestFirst).reverse()) {
      if (!shouldContinue(options)) break;
      if (dryRun) {
        prunedPaths.push(candidate.relativePath);
        continue;
      }
      if (await claimAndRemoveCandidate(candidate, options, warnings)) {
        prunedPaths.push(candidate.relativePath);
      }
    }

    return {
      root: retentionRoot.root,
      dryRun,
      candidateCount: candidates.length,
      retainedCount: candidates.length - prunedPaths.length,
      prunedCount: prunedPaths.length,
      prunedPaths,
      warnings,
      skippedForActiveMaintenance: false,
    };
  } finally {
    maintenance.release();
  }
}

async function resolveRetentionRoot(rawRoot: string, warnings: string[]): Promise<RetentionRoot | undefined> {
  const absoluteRoot = resolve(rawRoot);
  const rootName = basename(absoluteRoot);
  let parent: string;
  try {
    parent = await realpath(dirname(absoluteRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warnings.push(`memory parent is unavailable: ${reasonOf(error)}`);
    return undefined;
  }
  const parentInfo = await lstat(parent);
  if (!isOwnedNonWritableDirectory(parentInfo)) {
    warnings.push("memory parent is not an owner-controlled real directory");
    return undefined;
  }

  const root = join(parent, rootName);
  try {
    const info = await lstat(absoluteRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absoluteRoot) !== root) {
      warnings.push("memory root is not a canonical real directory");
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root, parent, parentInfo, rootName };
}

async function collectCandidates(
  retentionRoot: RetentionRoot,
  options: MemoryForgetBackupRetentionOptions,
  warnings: string[],
): Promise<Candidate[]> {
  const escapedRootName = escapeRegExp(retentionRoot.rootName);
  const managedPrefix = `.${retentionRoot.rootName}-forget-backup-`;
  const managedPattern = new RegExp(`^\\.${escapedRootName}-forget-backup-([a-f0-9]{24})$`, "u");
  const stagingPattern = new RegExp(
    `^\\.${escapedRootName}-forget-backup-([a-f0-9]{24})\\.tmp-[1-9][0-9]*-`
      + "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    "u",
  );
  const candidates: Candidate[] = [];

  await scanDirectory(retentionRoot.parent, warnings, ".", async (name) => {
    if (!shouldContinue(options)) return false;
    const absolutePath = join(retentionRoot.parent, name);
    const managedMatch = managedPattern.exec(name);
    if (managedMatch !== null) {
      const candidate = await inspectManagedCandidate(
        absolutePath,
        name,
        managedMatch[1]!,
        retentionRoot,
        warnings,
      );
      if (candidate !== undefined) candidates.push(candidate);
      return true;
    }
    const stagingMatch = stagingPattern.exec(name);
    if (name.startsWith(managedPrefix) && stagingMatch !== null) {
      const candidate = await inspectDirectoryCandidate(
        absolutePath,
        name,
        "staging",
        true,
        retentionRoot.parentInfo,
        warnings,
        `.${retentionRoot.rootName}-forget-backup-${stagingMatch[1]!}`,
      );
      if (candidate !== undefined) candidates.push(candidate);
    }
    return true;
  });

  if (shouldContinue(options)
    && retentionRoot.rootName === "memory" && basename(retentionRoot.parent) === ".mono-agent") {
    const operatorRoot = join(retentionRoot.parent, "operator");
    try {
      const operatorInfo = await lstat(operatorRoot);
      if (!isOwnedNonWritableDirectory(operatorInfo)) {
        warnings.push("operator: directory is not owner-controlled; operator forget backups were preserved");
      } else {
        await scanDirectory(operatorRoot, warnings, "operator", async (name) => {
          if (!shouldContinue(options)) return false;
          if (!name.startsWith("forget-") || name.length === "forget-".length) return true;
          const candidate = await inspectDirectoryCandidate(
            join(operatorRoot, name),
            `operator/${name}`,
            "bounded",
            false,
            operatorInfo,
            warnings,
          );
          if (candidate !== undefined) candidates.push(candidate);
          return true;
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`operator: directory scan failed: ${reasonOf(error)}`);
      }
    }
  }
  return candidates;
}

async function inspectManagedCandidate(
  absolutePath: string,
  relativePath: string,
  nameDigest: string,
  retentionRoot: RetentionRoot,
  warnings: string[],
): Promise<Candidate | undefined> {
  try {
    const directoryInfo = await lstat(absolutePath);
    assertExplicitMemoryForgetBackupDirectoryInfo(directoryInfo);
    const manifest = await readManagedManifest(join(absolutePath, "manifest.json"));
    if (manifest.rootFingerprint !== rootFingerprint(retentionRoot.root)
      || !manifest.planDigest.startsWith(nameDigest)) {
      throw new Error("invalid or foreign manifest");
    }
    const createdAtMs = Date.parse(manifest.createdAt);
    if (!Number.isFinite(createdAtMs)) throw new Error("invalid backup creation time");
    if (manifest.status === "applying") {
      warnings.push(`${relativePath}: applying backup was preserved`);
      return undefined;
    }
    return candidateOf(
      absolutePath,
      relativePath,
      createdAtMs,
      manifest.status === "recovered" ? "discardable" : "bounded",
      true,
      directoryInfo,
      retentionRoot.parentInfo,
      `.${retentionRoot.rootName}-forget-backup-${nameDigest}`,
    );
  } catch (error) {
    warnings.push(`${relativePath}: ${reasonOf(error)}; preserved`);
    return undefined;
  }
}

async function readManagedManifest(manifestPath: string): Promise<ExplicitMemoryForgetBackupManifest> {
  const before = await lstat(manifestPath);
  assertExplicitMemoryForgetPrivateArtifactInfo(before);
  const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertExplicitMemoryForgetPrivateArtifactInfo(opened);
    assertSameExplicitMemoryForgetFile(before, opened, manifestPath);
    const data = await handle.readFile();
    if (data.length !== opened.size) throw new Error("memory-forget: short artifact read");
    assertSameExplicitMemoryForgetSnapshot(opened, await handle.stat(), manifestPath);
    assertSameExplicitMemoryForgetFile(opened, await lstat(manifestPath), manifestPath);
    return parseExplicitMemoryForgetBackupManifest(JSON.parse(data.toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}

async function inspectDirectoryCandidate(
  absolutePath: string,
  relativePath: string,
  policy: Candidate["policy"],
  requirePrivate: boolean,
  parentInfo: Stats,
  warnings: string[],
  managedClaimPrefix?: string,
): Promise<Candidate | undefined> {
  try {
    const info = await lstat(absolutePath);
    if (requirePrivate) assertExplicitMemoryForgetBackupDirectoryInfo(info);
    else if (!isOwnedNonWritableDirectory(info)) throw new Error("unsafe directory");
    return candidateOf(
      absolutePath,
      relativePath,
      info.mtimeMs,
      policy,
      requirePrivate,
      info,
      parentInfo,
      managedClaimPrefix,
    );
  } catch (error) {
    warnings.push(`${relativePath}: ${reasonOf(error)}; preserved`);
    return undefined;
  }
}

function candidateOf(
  absolutePath: string,
  relativePath: string,
  updatedAtMs: number,
  policy: Candidate["policy"],
  requirePrivate: boolean,
  info: Stats,
  parentInfo: Stats,
  managedClaimPrefix?: string,
): Candidate {
  return {
    absolutePath,
    relativePath,
    parentPath: dirname(absolutePath),
    updatedAtMs,
    policy,
    requirePrivate,
    dev: info.dev,
    ino: info.ino,
    parentDev: parentInfo.dev,
    parentIno: parentInfo.ino,
    ...(managedClaimPrefix === undefined ? {} : { managedClaimPrefix }),
  };
}

async function claimAndRemoveCandidate(
  candidate: Candidate,
  options: MemoryForgetBackupRetentionOptions,
  warnings: string[],
): Promise<boolean> {
  if (!shouldContinue(options)) return false;
  if (!await sameSafeParent(candidate) || !await sameSafeCandidateDirectory(candidate, candidate.absolutePath)) {
    warnings.push(`${candidate.relativePath}: changed before retention claim; preserved`);
    return false;
  }
  await options.hooks?.beforeClaim?.({ path: candidate.absolutePath, relativePath: candidate.relativePath });
  if (!shouldContinue(options)) return false;

  const claimedName = candidate.managedClaimPrefix === undefined
    ? `forget-retention-${randomUUID()}`
    : `${candidate.managedClaimPrefix}.tmp-${process.pid}-${randomUUID()}`;
  const claimedPath = join(candidate.parentPath, claimedName);
  try {
    await rename(candidate.absolutePath, claimedPath);
  } catch (error) {
    warnings.push(`${candidate.relativePath}: retention claim failed: ${reasonOf(error)}`);
    return false;
  }

  try {
    if (!await sameSafeParent(candidate) || !await sameSafeCandidateDirectory(candidate, claimedPath)) {
      warnings.push(`${candidate.relativePath}: claimed directory identity changed; preserved`);
      await restoreClaimedCandidate(candidate, claimedPath, warnings);
      return false;
    }
    await options.hooks?.afterClaim?.({
      path: candidate.absolutePath,
      relativePath: candidate.relativePath,
      claimedPath,
    });
    if (!shouldContinue(options)) {
      await restoreClaimedCandidate(candidate, claimedPath, warnings);
      return false;
    }
    if (!await sameSafeParent(candidate) || !await sameSafeCandidateDirectory(candidate, claimedPath)) {
      warnings.push(`${candidate.relativePath}: claimed directory changed before removal; preserved`);
      await restoreClaimedCandidate(candidate, claimedPath, warnings);
      return false;
    }
    if (!shouldContinue(options)) {
      await restoreClaimedCandidate(candidate, claimedPath, warnings);
      return false;
    }
    await rm(claimedPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    warnings.push(`${candidate.relativePath}: removal failed after claim: ${reasonOf(error)}`);
    return false;
  }
}

async function restoreClaimedCandidate(
  candidate: Candidate,
  claimedPath: string,
  warnings: string[],
): Promise<void> {
  if (!await sameSafeParent(candidate) || !await entryExists(claimedPath)) return;
  if (await entryExists(candidate.absolutePath)) {
    warnings.push(`${candidate.relativePath}: claimed candidate retained at ${basename(claimedPath)}`);
    return;
  }
  try {
    await rename(claimedPath, candidate.absolutePath);
  } catch (error) {
    warnings.push(`${candidate.relativePath}: claimed candidate could not be restored: ${reasonOf(error)}`);
  }
}

async function sameSafeCandidateDirectory(candidate: Candidate, candidatePath: string): Promise<boolean> {
  try {
    const info = await lstat(candidatePath);
    if (candidate.requirePrivate) assertExplicitMemoryForgetBackupDirectoryInfo(info);
    else if (!isOwnedNonWritableDirectory(info)) return false;
    return info.dev === candidate.dev && info.ino === candidate.ino;
  } catch {
    return false;
  }
}

async function sameSafeParent(candidate: Candidate): Promise<boolean> {
  try {
    const info = await lstat(candidate.parentPath);
    return isOwnedNonWritableDirectory(info)
      && info.dev === candidate.parentDev && info.ino === candidate.parentIno;
  } catch {
    return false;
  }
}

async function scanDirectory(
  directory: string,
  warnings: string[],
  label: string,
  visit: (name: string) => Promise<boolean>,
): Promise<void> {
  try {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (!await visit(entry.name)) break;
    }
  } catch (error) {
    warnings.push(`${label}: directory scan failed: ${reasonOf(error)}`);
  }
}

async function entryExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isOwnedNonWritableDirectory(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && isOwned(info) && (info.mode & 0o022) === 0;
}

function isOwned(info: Stats): boolean {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function shouldContinue(options: MemoryForgetBackupRetentionOptions): boolean {
  return options.shouldContinue?.() ?? true;
}

function compareNewestFirst(left: Candidate, right: Candidate): number {
  return right.updatedAtMs - left.updatedAtMs || left.relativePath.localeCompare(right.relativePath);
}

function rootFingerprint(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function emptyResult(
  root: string,
  dryRun: boolean,
  warnings: readonly string[],
  skippedForActiveMaintenance = false,
): MemoryForgetBackupRetentionResult {
  return {
    root,
    dryRun,
    candidateCount: 0,
    retainedCount: 0,
    prunedCount: 0,
    prunedPaths: [],
    warnings,
    skippedForActiveMaintenance,
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

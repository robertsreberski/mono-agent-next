import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";

import { writeMonoAgentConfigJson } from "@mono-agent/config";

import { composeWizardPlan, defaultAnswers, humanizeAgentName } from "./wizard/answers.js";
import type { ComposeContext, WizardAnswers, WizardPlan } from "./wizard/answers.js";
import {
  initializeFirstRunManagedMemory,
  preflightFirstRunManagedMemory,
} from "./first-run-managed-memory.js";
import type { FirstRunManagedMemoryHooks } from "./first-run-managed-memory.js";
import { assertManagedProjectSkillInitSafe } from "./project-skills.js";
import { readVerifiedFile, secureFileReplace } from "./secure-file-replace.js";

export interface InitMonoAgentFolderOptions {
  /** Folder the agent is constructed in. Defaults to process.cwd(). */
  readonly dir?: string;
  /** The composed capability selection; omitted → {@link defaultAnswers} (the silent default scaffold). */
  readonly answers?: WizardAnswers;
  /** Plan the scaffold and report it without writing anything. */
  readonly dryRun?: boolean;
  /** Required capability secrets held only for this init run; never written to config JSON. */
  readonly secretValues?: Readonly<Record<string, string>>;
  /** Recheck and harden an existing credential-bearing `.env` even when no new value is written. */
  readonly secureExistingDotenv?: boolean;
  /** Guided-first-run guard: atomically create config and fail if another writer won the path. */
  readonly requireConfigCreation?: boolean;
  /** Effective CLI environment used only to reject identity-changing memory overrides. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** @internal Test-only fault/race seams for first-run managed-memory publication. */
  readonly firstRunManagedMemoryHooks?: FirstRunManagedMemoryHooks;
}

export interface InitMonoAgentFolderResult {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  /** Exact outcome for the wizard Role's one canonical destination. */
  readonly identityRole: {
    readonly path: string;
    readonly section: "## Role";
    /** `preserved` means the entered Role was not written anywhere. */
    readonly status: "created" | "preserved" | "planned-create";
  };
  /** Files and directories created (or, with dryRun, that would be created). */
  readonly created: readonly string[];
  /** Files that already existed and were left untouched (absolute paths). */
  readonly skipped: readonly string[];
  /** Existing knowledge files the generated identity references. */
  readonly knowledgeFiles: readonly string[];
  /** True when nothing was written because dryRun was set. */
  readonly dryRun: boolean;
  /** True when this init securely merged in-run required secrets into `.env`. */
  readonly secretsPersisted: boolean;
  /** Precise per-path outcomes, including updates that the legacy arrays cannot represent. */
  readonly changes: readonly InitFileChange[];
  /** The outcome of the optional secure `.env` persistence operation. */
  readonly secretPersistence: SecretPersistenceOutcome;
  /** The composed plan (config, secrets, env example, files, validate expectations). */
  readonly plan: WizardPlan;
}

export type InitFileChangeKind =
  | "created"
  | "updated"
  | "unchanged"
  | "planned-create"
  | "planned-update";

export interface InitFileChange {
  readonly path: string;
  readonly kind: InitFileChangeKind;
  /** Marks a path whose contents must never be printed as part of init reporting. */
  readonly sensitive?: boolean;
}

export type SecretPersistenceStatus = "not-requested" | "planned" | "persisted" | "refused";

export interface SecretPersistenceOutcome {
  readonly status: SecretPersistenceStatus;
  readonly path?: string;
  /** Whether at least one supplied value would be or was written. */
  readonly changed: boolean;
  /** Stable refusal code suitable for programmatic recovery handling. */
  readonly reason?: SecretEnvRefusalCode;
  /** Non-secret operator guidance, including an external lock/recovery path when relevant. */
  readonly detail?: string;
}

export type SecretEnvRefusalCode =
  | "git-safety-unavailable"
  | "invalid-secret-name"
  | "malformed-env"
  | "malformed-gitignore"
  | "owner-only-permissions-unsupported"
  | "tracked-env"
  | "unrepresentable-secret-value"
  | "unsafe-env-path"
  | "unsafe-gitignore-path"
  | "unsafe-lock-path";

export class SecretEnvPersistenceRefusedError extends Error {
  readonly code: SecretEnvRefusalCode;

  constructor(code: SecretEnvRefusalCode, message: string) {
    super(message);
    this.name = "SecretEnvPersistenceRefusedError";
    this.code = code;
  }
}

export class SecretEnvConcurrentModificationError extends Error {
  readonly ownerPid: number | undefined;
  readonly ownerCreatedAt: string | undefined;
  readonly recoveryPath: string | undefined;

  constructor(
    path: string,
    owner?: { readonly pid: number; readonly createdAt: string },
    recoveryPath?: string,
  ) {
    super(recoveryPath !== undefined
      ? `Secret persistence detected a concurrent or interrupted change to ${path}; bytes were retained at ${recoveryPath}. Inspect both paths before retrying.`
      : owner === undefined
        ? `Refusing to replace ${path} because it changed during secret persistence.`
        : `Secret persistence for ${path} is already held by live PID ${owner.pid} since ${owner.createdAt}; retry after that process exits.`);
    this.name = "SecretEnvConcurrentModificationError";
    this.ownerPid = owner?.pid;
    this.ownerCreatedAt = owner?.createdAt;
    this.recoveryPath = recoveryPath;
  }
}

/** Recover the typed concurrency cause through bounded cleanup-error wrapping. */
export function secretEnvConcurrentModificationCause(
  error: unknown,
): SecretEnvConcurrentModificationError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 16 && current !== undefined && !seen.has(current); depth += 1) {
    if (current instanceof SecretEnvConcurrentModificationError) return current;
    seen.add(current);
    try {
      current = current instanceof Error ? current.cause : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface SecretEnvPersistenceOptions {
  /** Preview the exact safety checks and changes without writing. */
  readonly dryRun?: boolean;
  /** Platform seam used to enforce the Windows fail-closed policy. */
  readonly platform?: NodeJS.Platform;
  /** Filesystem capability seam; defaults to false on Windows and true elsewhere. */
  readonly ownerOnlyPermissionsSupported?: boolean;
  /** Test seam invoked after a temporary file is durable and before optimistic verification. */
  readonly beforeCommit?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /** Apply git/path/mode hardening to an existing file even when no values need merging. */
  readonly secureExistingFile?: boolean;
  /** Test seam after all optimistic checks and immediately before identity-bound promotion. */
  readonly beforePromotion?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /** Test seam after target claim and immediately before exclusive replacement link. */
  readonly beforeInstallLink?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /** Test seam after exclusive replacement link and before claimed-inode cleanup. */
  readonly afterInstallLink?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
}

export interface SecretEnvMergeResult {
  readonly changes: readonly InitFileChange[];
  /** Number of supplied values that would be or were written. */
  readonly valuesChanged: number;
}

const KNOWLEDGE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md", "SOUL.md"];

/**
 * Non-destructively scaffolds a config-first mono-agent folder: a
 * `mono-agent.config.json` composed from the wizard answers (default scaffold when
 * none are supplied), an `IDENTITY.md` seeded from any knowledge files already in
 * the folder, the `.mono-agent/` working directories, and — when the composed plan
 * carries them — a `.env.example` and any capability files. Existing
 * scaffold/config files are never overwritten; reviewed secret persistence is
 * the deliberate exception that can transactionally replace `.env` and update
 * `.gitignore`. With `dryRun`, nothing is written and `created` reports what would
 * have been.
 */
export async function initMonoAgentFolder(
  options: InitMonoAgentFolderOptions = {},
): Promise<InitMonoAgentFolderResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const dryRun = options.dryRun === true;
  const answers = options.answers ?? defaultAnswers();
  const created: string[] = [];
  const skipped: string[] = [];
  const changes: InitFileChange[] = [];

  await assertManagedProjectSkillInitSafe(dir);

  const ctx: ComposeContext = {
    dirBasename: basename(dir),
    skillsRootExists: await pathExists(join(dir, "skills")),
  };
  const plan = composeWizardPlan(answers, ctx);
  const configPath = join(dir, "mono-agent.config.json");
  await assertSafeScaffoldTarget(configPath, "config");
  const configAlreadyExists = await pathExists(configPath);
  if (options.requireConfigCreation === true && configAlreadyExists) {
    const error = new Error(`Refusing guided init because ${configPath} already exists.`) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  if (!configAlreadyExists) {
    await preflightFirstRunManagedMemory({
      agentRoot: dir,
      plan,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  const knowledgeFiles: string[] = [];
  for (const candidate of KNOWLEDGE_FILE_CANDIDATES) {
    if (await pathExists(join(dir, candidate))) {
      knowledgeFiles.push(candidate);
    }
  }

  async function planFile(path: string, write: () => Promise<unknown>): Promise<boolean> {
    if (await pathExists(path)) {
      skipped.push(path);
      changes.push({ path, kind: "unchanged" });
      return false;
    }
    if (!dryRun) {
      await write();
    }
    created.push(path);
    changes.push({ path, kind: dryRun ? "planned-create" : "created" });
    return true;
  }

  const identityPath = join(dir, "IDENTITY.md");
  await assertSafeScaffoldTarget(identityPath, "identity");
  const identityCreated = await planFile(identityPath, () => writeFile(
    identityPath,
    identityTemplate(
      dir,
      answers.name?.trim() || humanizeAgentName(basename(dir)),
      answers.purpose?.trim() || "Help the operator work effectively in this folder.",
      knowledgeFiles,
    ),
    { flag: "wx" },
  ));

  for (const subdir of [join(dir, ".mono-agent", "artifacts"), join(dir, ".mono-agent", "workspace")]) {
    await assertSafeScaffoldTarget(subdir, "working directory");
    await ensureSafeScaffoldParent(dir, subdir, !dryRun);
    await planFile(subdir, async () => {
      await ensureSafeScaffoldParent(dir, subdir, true);
      await createSafeScaffoldDirectory(subdir);
    });
  }

  let configCreatedByThisInit = false;
  let configCreatedIdentity: { readonly dev: number; readonly ino: number } | undefined;
  if (options.requireConfigCreation === true) {
    if (dryRun) {
      if (await pathExists(configPath)) {
        throw new Error(`Refusing guided init because ${configPath} already exists.`);
      }
    } else {
      await createMonoAgentConfigExclusively(configPath, plan.configJson);
    }
    created.push(configPath);
    changes.push({ path: configPath, kind: dryRun ? "planned-create" : "created" });
    configCreatedByThisInit = !dryRun;
  } else {
    const configPlanned = await planFile(
      configPath,
      () => writeMonoAgentConfigJson({ path: configPath, patch: plan.configJson }),
    );
    configCreatedByThisInit = !dryRun && configPlanned;
  }
  if (configCreatedByThisInit) {
    const configStat = await lstat(configPath);
    configCreatedIdentity = { dev: configStat.dev, ino: configStat.ino };
  }

  const envExample = plan.envExample;
  if (typeof envExample === "string" && envExample.length > 0) {
    const envExamplePath = join(dir, ".env.example");
    await assertSafeScaffoldTarget(envExamplePath, "environment example");
    await planFile(envExamplePath, () => writeFile(envExamplePath, envExample, { flag: "wx" }));
  }

  const requestedSecrets = options.secretValues !== undefined && Object.keys(options.secretValues).length > 0;
  const requestedEnvSecurity = requestedSecrets || options.secureExistingDotenv === true;
  let secretPersistence: SecretPersistenceOutcome = { status: "not-requested", changed: false };
  if (requestedEnvSecurity) {
    const envPath = join(dir, ".env");
    try {
      const result = await mergeSecretEnvFile(envPath, options.secretValues ?? {}, {
        dryRun,
        secureExistingFile: options.secureExistingDotenv === true,
      });
      changes.push(...result.changes);
      for (const change of result.changes) {
        if (change.kind === "created" || change.kind === "planned-create") created.push(change.path);
        if (change.kind === "unchanged") skipped.push(change.path);
      }
      secretPersistence = {
        status: dryRun ? "planned" : "persisted",
        path: envPath,
        changed: result.valuesChanged > 0,
      };
    } catch (error) {
      if (!(error instanceof SecretEnvPersistenceRefusedError)) throw error;
      secretPersistence = {
        status: "refused",
        path: envPath,
        changed: false,
        reason: error.code,
        detail: error.message,
      };
    }
  }

  for (const file of plan.files) {
    const filePath = resolve(dir, file.path);
    await ensureSafeScaffoldParent(dir, filePath, !dryRun);
    await assertSafeScaffoldTarget(filePath, `generated capability file ${file.path}`);
    await planFile(filePath, async () => {
      await ensureSafeScaffoldParent(dir, filePath, true);
      await writeFile(filePath, file.contents, { flag: "wx" });
    });
  }

  if (configCreatedByThisInit) {
    try {
      const initializedMemory = await initializeFirstRunManagedMemory({
        agentRoot: dir,
        plan,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.firstRunManagedMemoryHooks === undefined
          ? {}
          : { hooks: options.firstRunManagedMemoryHooks }),
      });
      if (initializedMemory.initialized && initializedMemory.root !== undefined) {
        created.push(initializedMemory.root);
        changes.push({ path: initializedMemory.root, kind: "created" });
      }
    } catch (error) {
      if (configCreatedIdentity !== undefined) {
        await removeCreatedConfigIfUnchanged(configPath, configCreatedIdentity, `${JSON.stringify(plan.configJson, null, 2)}\n`);
      }
      throw error;
    }
  }

  return {
    dir,
    configPath,
    identityPath,
    identityRole: {
      path: identityPath,
      section: "## Role",
      status: identityCreated ? (dryRun ? "planned-create" : "created") : "preserved",
    },
    created,
    skipped,
    knowledgeFiles,
    dryRun,
    secretsPersisted: !dryRun && secretPersistence.status === "persisted" && secretPersistence.changed,
    changes,
    secretPersistence,
    plan,
  };
}

/**
 * Securely merge required secrets into `.env` without replacing non-empty
 * operator values. The destination and its git-ignore guard are preflighted,
 * then each changed file is committed through an exclusive same-directory
 * temporary file. The `.env` commit is always mode 0600 on supported systems.
 */
export async function mergeSecretEnvFile(
  path: string,
  secretValues: Readonly<Record<string, string>>,
  options: SecretEnvPersistenceOptions = {},
): Promise<SecretEnvMergeResult> {
  const secretEntries = Object.entries(secretValues);
  if (secretEntries.length === 0 && options.secureExistingFile !== true) {
    return { changes: [], valuesChanged: 0 };
  }
  const platform = options.platform ?? process.platform;
  const ownerOnlyPermissionsSupported = options.ownerOnlyPermissionsSupported ?? platform !== "win32";
  if (!ownerOnlyPermissionsSupported) {
    throw new SecretEnvPersistenceRefusedError(
      "owner-only-permissions-unsupported",
      "Automatic secret persistence requires verifiable owner-only file permissions.",
    );
  }

  const renderedValues = new Map<string, string>();
  for (const [name, value] of secretEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new SecretEnvPersistenceRefusedError(
        "invalid-secret-name",
        `Automatic secret persistence refused an invalid environment variable name: ${name}.`,
      );
    }
    renderedValues.set(name, renderDotenvValue(name, value));
  }

  const target = await resolveSafeSecretEnvTarget(path);

  // A dry run has no commit to serialize and must remain write-free. Real
  // persistence holds one same-directory lock across both snapshots, the git
  // safety check, the ignore-file commit, and the env-file commit. Without this
  // boundary two writers can read the same old .env, both pass the optimistic
  // comparison, then rename over one another and silently lose one update.
  return options.dryRun === true
    ? await mergeSecretEnvFileLocked(target.path, path, renderedValues, target.ownerUid, options)
    : await withSecretEnvFileLock(
        target.path,
        target.ownerUid,
        () => mergeSecretEnvFileLocked(target.path, path, renderedValues, target.ownerUid, options),
      );
}

async function mergeSecretEnvFileLocked(
  path: string,
  reportedPath: string,
  renderedValues: ReadonlyMap<string, string>,
  ownerUid: number,
  options: SecretEnvPersistenceOptions,
): Promise<SecretEnvMergeResult> {
  const envSnapshot = await readSafeFile(
    path,
    "unsafe-env-path",
    "malformed-env",
    ownerUid,
    [1],
    reportedPath,
  );
  if (await isGitTracked(path)) {
    throw new SecretEnvPersistenceRefusedError(
      "tracked-env",
      `Automatic secret persistence refused because ${path} is tracked by git.`,
    );
  }

  const existingEnv = snapshotText(envSnapshot);
  const merged = mergeDotenvContents(existingEnv, renderedValues);
  const envContents = Buffer.from(merged.contents, "utf8");
  const envNeedsWrite = !envSnapshot.exists || !envSnapshot.contents.equals(envContents) || fileMode(envSnapshot) !== 0o600;

  const gitIgnorePath = join(dirname(path), ".gitignore");
  const reportedGitIgnorePath = join(dirname(reportedPath), ".gitignore");
  const gitIgnoreSnapshot = await readSafeFile(
    gitIgnorePath,
    "unsafe-gitignore-path",
    "malformed-gitignore",
    ownerUid,
    [1],
    reportedGitIgnorePath,
  );
  const gitIgnoreContents = Buffer.from(ensureExactEnvIgnore(snapshotText(gitIgnoreSnapshot)), "utf8");
  const gitIgnoreMode = gitIgnoreSnapshot.exists
    ? (fileMode(gitIgnoreSnapshot) || 0o644) & ~0o022
    : 0o644;
  const gitIgnoreNeedsWrite = !gitIgnoreSnapshot.exists ||
    !gitIgnoreSnapshot.contents.equals(gitIgnoreContents) ||
    fileMode(gitIgnoreSnapshot) !== gitIgnoreMode;

  const changes: InitFileChange[] = [
    changeFor(reportedGitIgnorePath, gitIgnoreSnapshot.exists, gitIgnoreNeedsWrite, options.dryRun === true),
    { ...changeFor(reportedPath, envSnapshot.exists, envNeedsWrite, options.dryRun === true), sensitive: true },
  ];

  if (options.dryRun === true) {
    return { changes, valuesChanged: merged.valuesChanged };
  }

  if (gitIgnoreNeedsWrite) {
    await atomicReplaceFile({
      path: gitIgnorePath,
      reportedPath: reportedGitIgnorePath,
      contents: gitIgnoreContents,
      expected: gitIgnoreSnapshot,
      ownerUid,
      mode: gitIgnoreMode,
      beforeCommit: options.beforeCommit,
      beforePromotion: options.beforePromotion,
      beforeInstallLink: options.beforeInstallLink,
      afterInstallLink: options.afterInstallLink,
    });
  }
  const committedGitIgnoreSnapshot = gitIgnoreNeedsWrite
    ? await readSafeFile(
        gitIgnorePath,
        "unsafe-gitignore-path",
        "malformed-gitignore",
        ownerUid,
        [1],
        reportedGitIgnorePath,
      )
    : gitIgnoreSnapshot;
  if (
    !committedGitIgnoreSnapshot.exists ||
    !committedGitIgnoreSnapshot.contents.equals(gitIgnoreContents)
  ) {
    throw new SecretEnvConcurrentModificationError(gitIgnorePath);
  }
  if (envNeedsWrite) {
    await atomicReplaceFile({
      path,
      reportedPath,
      contents: envContents,
      expected: envSnapshot,
      ownerUid,
      mode: 0o600,
      verifyOwnerOnly: true,
      beforeCommit: options.beforeCommit,
      beforeRename: async () => {
        if (await isGitTracked(path)) {
          throw new SecretEnvPersistenceRefusedError(
            "tracked-env",
            `Automatic secret persistence refused because ${path} became tracked by git before commit.`,
          );
        }
        await assertSnapshotUnchanged(
          gitIgnorePath,
          reportedGitIgnorePath,
          committedGitIgnoreSnapshot,
          ownerUid,
        );
      },
      beforePromotion: options.beforePromotion,
      beforeInstallLink: options.beforeInstallLink,
      afterInstallLink: options.afterInstallLink,
    });
  }

  return { changes, valuesChanged: merged.valuesChanged };
}

async function withSecretEnvFileLock<T>(
  path: string,
  ownerUid: number,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = await secretEnvLockPathForCanonical(path, ownerUid);
  const owner: SecretEnvLockOwner = {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerUid,
    token: randomUUID(),
  };
  const lock = await acquireSecretEnvLock(path, lockPath, owner);
  try {
    return await task();
  } finally {
    try {
      await lock.handle.close();
    } finally {
      await releaseSecretEnvLock(lockPath, lock);
    }
  }
}

interface SecretEnvLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly createdAt: string;
  readonly ownerUid: number;
  readonly token: string;
}

interface SecretEnvLockSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly contents: Buffer;
  readonly owner: SecretEnvLockOwner;
}

interface AcquiredSecretEnvLock extends SecretEnvLockSnapshot {
  readonly handle: FileHandle;
}

const MAX_SECRET_ENV_LOCK_BYTES = 4096;
const MAX_SECRET_ENV_LOCK_ACQUIRE_ATTEMPTS = 4;

async function acquireSecretEnvLock(
  envPath: string,
  lockPath: string,
  owner: SecretEnvLockOwner,
): Promise<AcquiredSecretEnvLock> {
  for (let attempt = 0; attempt < MAX_SECRET_ENV_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ELOOP") throw error;
      let existing: SecretEnvLockSnapshot | undefined;
      try {
        existing = await readSecretEnvLockSnapshot(lockPath, owner.ownerUid);
      } catch (readError) {
        // O_EXCL publishes the directory entry just before its owner record is
        // written. Give that tiny creation window a bounded retry so a real
        // concurrent owner is reported as live instead of as malformed.
        if (
          readError instanceof SecretEnvPersistenceRefusedError &&
          readError.code === "unsafe-lock-path" &&
          attempt + 1 < MAX_SECRET_ENV_LOCK_ACQUIRE_ATTEMPTS
        ) {
          await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 10));
          continue;
        }
        throw readError;
      }
      if (existing === undefined) continue;
      const ownerState = secretEnvLockOwnerState(existing.owner.pid);
      if (ownerState === "live") {
        throw new SecretEnvConcurrentModificationError(envPath, existing.owner);
      }
      if (ownerState === "unknown") {
        throw unsafeSecretEnvLockError(
          lockPath,
          `the owner process state for PID ${existing.owner.pid} could not be verified`,
        );
      }
      throw unsafeSecretEnvLockError(
        lockPath,
        `the recorded owner PID ${existing.owner.pid} is no longer running`,
      );
    }

    const contents = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    let identity: { readonly dev: number; readonly ino: number } | undefined;
    try {
      const initialStat = await handle.stat();
      identity = { dev: initialStat.dev, ino: initialStat.ino };
      assertSecretEnvLockFileStat(lockPath, initialStat, owner.ownerUid);
      await handle.writeFile(contents);
      await handle.sync();
      const writtenStat = await handle.stat();
      assertSecretEnvLockFileStat(lockPath, writtenStat, owner.ownerUid);
      if (
        writtenStat.dev !== initialStat.dev ||
        writtenStat.ino !== initialStat.ino ||
        writtenStat.size !== contents.length
      ) {
        throw unsafeSecretEnvLockError(lockPath, "the durable owner record changed while it was being created");
      }
      await syncDirectoryBestEffort(dirname(lockPath));
      return {
        handle,
        dev: writtenStat.dev,
        ino: writtenStat.ino,
        contents,
        owner,
      };
    } catch (error) {
      try {
        await handle.close();
      } finally {
        if (identity !== undefined) {
          await removeSecretEnvLockWithIdentity(lockPath, identity);
        }
      }
      throw error;
    }
  }
  throw new SecretEnvConcurrentModificationError(envPath);
}

function currentProcessUid(lockPath: string): number {
  if (typeof process.getuid !== "function") {
    throw unsafeSecretEnvLockError(lockPath, "the current operating-system user id is unavailable");
  }
  return process.getuid();
}

function assertSecretEnvLockFileStat(
  lockPath: string,
  lockStat: Stats,
  ownerUid: number,
): void {
  if (
    !lockStat.isFile() ||
    lockStat.uid !== ownerUid ||
    (lockStat.mode & 0o777) !== 0o600 ||
    lockStat.nlink !== 1
  ) {
    throw unsafeSecretEnvLockError(lockPath, "it is not a same-user, owner-only regular file with one link");
  }
}

async function readSecretEnvLockSnapshot(
  lockPath: string,
  ownerUid: number,
): Promise<SecretEnvLockSnapshot | undefined> {
  let pathStat;
  try {
    pathStat = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.uid !== ownerUid ||
    (pathStat.mode & 0o777) !== 0o600 ||
    pathStat.nlink !== 1
  ) {
    throw unsafeSecretEnvLockError(lockPath, "same-user ownership and owner-only regular-file identity could not be proven");
  }
  if (pathStat.size <= 0 || pathStat.size > MAX_SECRET_ENV_LOCK_BYTES) {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record has an invalid size");
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handleStat = await handle.stat();
    assertSecretEnvLockFileStat(lockPath, handleStat, ownerUid);
    if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) return undefined;
    const contents = await handle.readFile();
    if (contents.length !== handleStat.size) return undefined;
    const owner = parseSecretEnvLockOwner(lockPath, contents, ownerUid);
    return { dev: handleStat.dev, ino: handleStat.ino, contents, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw unsafeSecretEnvLockError(lockPath, "the lock path became a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseSecretEnvLockOwner(
  lockPath: string,
  contents: Buffer,
  ownerUid: number,
): SecretEnvLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  } catch {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record is not valid UTF-8 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
  if (
    record.version !== 1 ||
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.createdAt !== "string" ||
    record.createdAt.length > 64 ||
    !Number.isFinite(createdAtMs) ||
    record.ownerUid !== ownerUid ||
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    record.token.length > 128
  ) {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record is malformed or belongs to another user");
  }
  return {
    version: 1,
    pid: record.pid as number,
    createdAt: record.createdAt,
    ownerUid,
    token: record.token,
  };
}

function secretEnvLockOwnerState(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

async function releaseSecretEnvLock(
  lockPath: string,
  expected: SecretEnvLockSnapshot,
): Promise<void> {
  let current: SecretEnvLockSnapshot | undefined;
  try {
    current = await readSecretEnvLockSnapshot(lockPath, expected.owner.ownerUid);
  } catch {
    // Never remove a path whose ownership changed while this process held the
    // original descriptor; it may now be another process's live lock.
    return;
  }
  if (current === undefined || !sameSecretEnvLockSnapshot(current, expected)) return;
  try {
    await rm(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await syncDirectoryBestEffort(dirname(lockPath));
}

async function resolveSafeSecretEnvTarget(
  path: string,
): Promise<{ readonly path: string; readonly ownerUid: number }> {
  const canonicalParent = await realpath(dirname(path));
  const ownerUid = currentProcessUid(canonicalParent);
  const pathStat = await lstat(canonicalParent);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      canonicalParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
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
      throw new SecretEnvPersistenceRefusedError(
        "unsafe-env-path",
        `Automatic secret persistence requires parent directory ${canonicalParent} to be owned by the current user and not group/world-writable.`,
      );
    }
  } finally {
    await handle?.close();
  }
  return { path: join(canonicalParent, basename(path)), ownerUid };
}

/** Stable, repository-external lock path for one canonical dotenv target. */
export async function secretEnvLockPathFor(path: string): Promise<string> {
  const target = await resolveSafeSecretEnvTarget(path);
  return await secretEnvLockPathForCanonical(target.path, target.ownerUid);
}

async function secretEnvLockPathForCanonical(path: string, ownerUid: number): Promise<string> {
  const root = join(tmpdir(), `mono-agent-secret-env-locks-${ownerUid}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.uid !== ownerUid ||
    (rootStat.mode & 0o077) !== 0
  ) {
    throw unsafeSecretEnvLockError(root, "the repository-external lock directory is not private to the current user");
  }
  const key = createHash("sha256")
    .update(dirname(path))
    .update("\0")
    .update(basename(path))
    .digest("hex");
  return join(root, `${key}.lock`);
}

function sameSecretEnvLockSnapshot(
  left: SecretEnvLockSnapshot,
  right: SecretEnvLockSnapshot,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.owner.token === right.owner.token &&
    left.contents.equals(right.contents);
}

async function removeSecretEnvLockWithIdentity(
  lockPath: string,
  expected: { readonly dev: number; readonly ino: number },
): Promise<void> {
  try {
    const current = await lstat(lockPath);
    if (current.dev !== expected.dev || current.ino !== expected.ino) return;
    await rm(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unsafeSecretEnvLockError(lockPath: string, detail: string): SecretEnvPersistenceRefusedError {
  return new SecretEnvPersistenceRefusedError(
    "unsafe-lock-path",
    `Automatic secret persistence cannot safely use lock ${lockPath}: ${detail}. Verify no mono-agent init is running, then remove the stale lock manually and retry.`,
  );
}

interface MissingFileSnapshot {
  readonly exists: false;
}

interface ExistingFileSnapshot {
  readonly exists: true;
  readonly contents: Buffer;
  readonly mode: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type SafeFileSnapshot = MissingFileSnapshot | ExistingFileSnapshot;

interface AtomicReplaceOptions {
  readonly path: string;
  readonly reportedPath: string;
  readonly contents: Buffer;
  readonly expected: SafeFileSnapshot;
  readonly ownerUid: number;
  readonly mode: number;
  readonly verifyOwnerOnly?: boolean;
  readonly beforeCommit?: SecretEnvPersistenceOptions["beforeCommit"];
  /** Final cross-file safety check before the shared target-claim sequence. */
  readonly beforeRename?: () => void | Promise<void>;
  readonly beforePromotion?: SecretEnvPersistenceOptions["beforePromotion"];
  readonly beforeInstallLink?: SecretEnvPersistenceOptions["beforeInstallLink"];
  readonly afterInstallLink?: SecretEnvPersistenceOptions["afterInstallLink"];
}

async function readSafeFile(
  path: string,
  unsafeCode: Extract<SecretEnvRefusalCode, "unsafe-env-path" | "unsafe-gitignore-path">,
  malformedCode: Extract<SecretEnvRefusalCode, "malformed-env" | "malformed-gitignore">,
  ownerUid: number,
  allowedLinkCounts: readonly number[] = [1],
  reportedPath: string = path,
): Promise<SafeFileSnapshot> {
  try {
    const snapshot = await readVerifiedFile(path, {
      validate: (details) => assertSafeSecretFileStat(
        reportedPath,
        details,
        unsafeCode,
        ownerUid,
        allowedLinkCounts,
      ),
      changedError: () => new SecretEnvConcurrentModificationError(reportedPath),
    });
    if (snapshot === undefined) return { exists: false };
    decodeUtf8(snapshot.contents, reportedPath, malformedCode);
    return {
      exists: true,
      contents: snapshot.contents,
      mode: snapshot.details.mode,
      dev: snapshot.details.dev,
      ino: snapshot.details.ino,
      uid: snapshot.details.uid,
      nlink: snapshot.details.nlink,
      size: snapshot.details.size,
      mtimeNs: snapshot.details.mtimeNs,
      ctimeNs: snapshot.details.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SecretEnvPersistenceRefusedError(unsafeCode, `Automatic secret persistence refused unsafe path ${reportedPath}.`);
    }
    throw error;
  }
}

function assertSafeSecretFileStat(
  path: string,
  value: BigIntStats,
  unsafeCode: Extract<SecretEnvRefusalCode, "unsafe-env-path" | "unsafe-gitignore-path">,
  ownerUid: number,
  allowedLinkCounts: readonly number[],
): void {
  if (value.isSymbolicLink() || !value.isFile()) {
    throw new SecretEnvPersistenceRefusedError(
      unsafeCode,
      `Automatic secret persistence refused unsafe path ${path}.`,
    );
  }
  if (value.uid !== BigInt(ownerUid)) {
    throw new SecretEnvPersistenceRefusedError(
      unsafeCode,
      `Automatic secret persistence refused ${path} because it is not owned by the current user.`,
    );
  }
  if (!allowedLinkCounts.some((linkCount) => value.nlink === BigInt(linkCount))) {
    throw new SecretEnvPersistenceRefusedError(
      unsafeCode,
      `Automatic secret persistence refused ${path} because its hard-link identity is unsafe.`,
    );
  }
}

function snapshotText(snapshot: SafeFileSnapshot): string {
  if (!snapshot.exists) return "";
  return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.contents);
}

function decodeUtf8(contents: Buffer, path: string, code: SecretEnvRefusalCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new SecretEnvPersistenceRefusedError(code, `Automatic secret persistence requires UTF-8 text at ${path}.`);
  }
}

function fileMode(snapshot: ExistingFileSnapshot): number;
function fileMode(snapshot: MissingFileSnapshot): 0;
function fileMode(snapshot: SafeFileSnapshot): number {
  return snapshot.exists ? Number(snapshot.mode & 0o777n) : 0;
}

function changeFor(path: string, exists: boolean, needsWrite: boolean, dryRun: boolean): InitFileChange {
  if (!needsWrite) return { path, kind: "unchanged" };
  if (dryRun) return { path, kind: exists ? "planned-update" : "planned-create" };
  return { path, kind: exists ? "updated" : "created" };
}

function renderDotenvValue(name: string, value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new SecretEnvPersistenceRefusedError(
      "unrepresentable-secret-value",
      `Automatic secret persistence requires a non-empty dotenv-safe value for ${name}.`,
    );
  }
  const candidates = [
    ...(value.includes("'") ? [] : [`'${value}'`]),
    ...(value.includes('"') ? [] : [`"${value}"`]),
    value,
  ];
  for (const candidate of candidates) {
    try {
      if (parseEnv(`${name}=${candidate}\n`)[name] === value) return candidate;
    } catch {
      // Try the next representation. Some values have no lossless dotenv form.
    }
  }
  throw new SecretEnvPersistenceRefusedError(
    "unrepresentable-secret-value",
    `Automatic secret persistence cannot represent the supplied value for ${name} losslessly.`,
  );
}

function mergeDotenvContents(
  existing: string,
  renderedValues: ReadonlyMap<string, string>,
): { readonly contents: string; readonly valuesChanged: number } {
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(existing);
  } catch {
    throw new SecretEnvPersistenceRefusedError(
      "malformed-env",
      "Automatic secret persistence refused a malformed .env file.",
    );
  }

  const lines = splitLinesPreservingEndings(existing);
  const preferredNewline = lines.find((line) => line.ending.length > 0)?.ending ?? "\n";
  let valuesChanged = 0;

  for (const [name, renderedValue] of renderedValues) {
    if ((parsed[name] ?? "").length > 0) continue;
    const matcher = new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=)(.*)$`, "u");
    let index = -1;
    for (let candidate = lines.length - 1; candidate >= 0; candidate -= 1) {
      const body = lines[candidate]?.body ?? "";
      const assignment = matcher.exec(body);
      if (assignment === null) continue;
      const placeholder = /^\s*(?:''|"")?\s*(#.*)?$/u.exec(assignment[2] ?? "");
      if (placeholder === null) continue;
      const marker = `__MONO_AGENT_EMPTY_${name}__`;
      const markedLines = lines.map((line, lineIndex) => lineIndex === candidate
        ? { ...line, body: `${assignment[1]}'${marker}'${placeholder[1] === undefined ? "" : ` ${placeholder[1]}`}` }
        : line);
      try {
        if (parseEnv(joinPreservedLines(markedLines))[name] === marker) {
          index = candidate;
          break;
        }
      } catch {
        // The full file validation below reports malformed input without writing.
      }
    }
    if (index === -1) {
      if (parsed[name] !== undefined) {
        throw new SecretEnvPersistenceRefusedError(
          "malformed-env",
          `Automatic secret persistence could not safely replace the empty placeholder for ${name}.`,
        );
      }
      const last = lines[lines.length - 1];
      if (last !== undefined && last.ending.length === 0) last.ending = preferredNewline;
      lines.push({ body: `${name}=${renderedValue}`, ending: preferredNewline });
      valuesChanged += 1;
      continue;
    }

    const currentLine = lines[index];
    const assignment = matcher.exec(currentLine?.body ?? "");
    const placeholder = /^\s*(?:''|"")?\s*(#.*)?$/u.exec(assignment?.[2] ?? "");
    if (currentLine === undefined || assignment === null || placeholder === null) {
      throw new SecretEnvPersistenceRefusedError(
        "malformed-env",
        `Automatic secret persistence could not safely replace the empty placeholder for ${name}.`,
      );
    }
    const comment = placeholder[1];
    currentLine.body = `${assignment[1]}${renderedValue}${comment === undefined ? "" : ` ${comment}`}`;
    valuesChanged += 1;
  }

  return { contents: joinPreservedLines(lines), valuesChanged };
}

interface PreservedLine {
  body: string;
  ending: string;
}

function splitLinesPreservingEndings(value: string): PreservedLine[] {
  if (value.length === 0) return [];
  const lines: PreservedLine[] = [];
  const endings = /\r\n|\n|\r/gu;
  let cursor = 0;
  for (const match of value.matchAll(endings)) {
    const index = match.index;
    lines.push({ body: value.slice(cursor, index), ending: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) lines.push({ body: value.slice(cursor), ending: "" });
  return lines;
}

function joinPreservedLines(lines: readonly PreservedLine[]): string {
  return lines.map((line) => `${line.body}${line.ending}`).join("");
}

const SECRET_ENV_IGNORE_RULES = [
  "/.env",
  "/..env.mono-agent-*.tmp",
  "/.env.mono-agent-*.backup",
] as const;

function ensureExactEnvIgnore(existing: string): string {
  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/u);
  // Keep the whole secret-file transaction block as the final effective rules.
  // An earlier rule can be cancelled by a later negation, while the temporary
  // and rollback names can contain the same secret bytes as the final .env.
  const meaningful: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    meaningful.push(trimmed);
  }
  if (
    meaningful.length >= SECRET_ENV_IGNORE_RULES.length &&
    SECRET_ENV_IGNORE_RULES.every(
      (rule, index) => meaningful[meaningful.length - SECRET_ENV_IGNORE_RULES.length + index] === rule,
    )
  ) return existing;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  return `${existing}${existing.length > 0 && !existing.endsWith("\n") ? newline : ""}` +
    `${SECRET_ENV_IGNORE_RULES.join(newline)}${newline}`;
}

async function atomicReplaceFile(options: AtomicReplaceOptions): Promise<void> {
  const temporaryPath = join(dirname(options.path), `.${basename(options.path)}.mono-agent-${randomUUID()}.tmp`);
  const backupPath = join(dirname(options.path), `${basename(options.path)}.mono-agent-${randomUUID()}.backup`);
  const expected = options.expected;
  const unsafeCode = basename(options.path) === ".gitignore" ? "unsafe-gitignore-path" : "unsafe-env-path";
  const malformedCode = basename(options.path) === ".gitignore" ? "malformed-gitignore" : "malformed-env";
  await secureFileReplace({
    path: options.path,
    temporaryPath,
    contents: options.contents,
    mode: options.mode,
    validateTemporary: (details) => {
      if (options.verifyOwnerOnly === true && (details.mode & 0o777n) !== 0o600n) {
        throw new SecretEnvPersistenceRefusedError(
          "owner-only-permissions-unsupported",
          "Automatic secret persistence could not verify owner-only permissions.",
        );
      }
    },
    beforeCommit: async (temporary) => {
      await options.beforeCommit?.(options.reportedPath, temporary);
      await assertSnapshotUnchanged(options.path, options.reportedPath, options.expected, options.ownerUid);
      await options.beforeRename?.();
      // beforeRename may perform async Git and cross-file checks. Re-read the
      // target afterwards so an editor cannot win that widened window silently.
      await assertSnapshotUnchanged(options.path, options.reportedPath, options.expected, options.ownerUid);
    },
    target: {
      expected: expected.exists
        ? {
            kind: "present",
            claimPath: backupPath,
            validate: async (candidate, moved) => {
              const current = await readSafeFile(
                candidate,
                unsafeCode,
                malformedCode,
                options.ownerUid,
              );
              return current.exists && sameExpectedFileSnapshot(current, expected, moved);
            },
            invalidError: () => new SecretEnvConcurrentModificationError(options.reportedPath),
            mismatchRecovery: (phase) => phase === "claimed" || phase === "pre-publish"
              ? "restore-previous"
              : "preserve-current",
          }
        : { kind: "missing" },
      recovery: "preserve-current",
      beforeClaim: (_target, temporary) => options.beforePromotion?.(options.reportedPath, temporary),
      ...(expected.exists ? {
        beforePublish: (_target: string, temporary: string) => options.beforeInstallLink?.(options.reportedPath, temporary),
        afterPublish: (_target: string, temporary: string) => options.afterInstallLink?.(options.reportedPath, temporary),
      } : {}),
      protectRecovery: tightenFileOwnerOnlyBestEffort,
      makeError: ({ cause, recoveryPaths }) => recoveryPaths.length === 0
        && (cause instanceof SecretEnvConcurrentModificationError
          || cause instanceof SecretEnvPersistenceRefusedError)
        ? cause
        : new SecretEnvConcurrentModificationError(options.reportedPath, undefined, recoveryPaths[0]),
    },
  });
  await syncDirectoryBestEffort(dirname(options.path));
}

function sameExpectedFileSnapshot(
  current: ExistingFileSnapshot,
  expected: ExistingFileSnapshot,
  moved = false,
): boolean {
  return current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.uid === expected.uid &&
    current.nlink === expected.nlink &&
    current.size === expected.size &&
    current.mode === expected.mode &&
    (moved || current.mtimeNs === expected.mtimeNs) &&
    (moved || current.ctimeNs === expected.ctimeNs) &&
    current.contents.equals(expected.contents);
}

async function tightenFileOwnerOnlyBestEffort(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if ((await handle.stat()).isFile()) await handle.chmod(0o600);
  } catch {
    // The recovery copy is already fail-closed and ignored; preserve bytes.
  } finally {
    await handle?.close();
  }
}

async function createMonoAgentConfigExclusively(
  path: string,
  config: WizardPlan["configJson"],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.mono-agent-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link is an atomic create-if-absent operation. Unlike rename it cannot
    // replace a config another process created while the wizard was running.
    await link(temporaryPath, path);
    await syncDirectoryBestEffort(dirname(path));
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

async function removeCreatedConfigIfUnchanged(
  path: string,
  expectedIdentity: { readonly dev: number; readonly ino: number },
  expectedContents: string,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(opened, expectedIdentity)) return false;
    if (await handle.readFile({ encoding: "utf8" }) !== expectedContents) return false;
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameFileIdentity(named, expectedIdentity)) {
      return false;
    }
    await unlink(path);
    await syncDirectoryBestEffort(dirname(path));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(
  value: { readonly dev: number; readonly ino: number },
  expected: { readonly dev: number; readonly ino: number },
): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}

async function assertSnapshotUnchanged(
  path: string,
  reportedPath: string,
  expected: SafeFileSnapshot,
  ownerUid: number,
): Promise<void> {
  let current: SafeFileSnapshot;
  try {
    current = await readSafeFile(
      path,
      basename(path) === ".gitignore" ? "unsafe-gitignore-path" : "unsafe-env-path",
      basename(path) === ".gitignore" ? "malformed-gitignore" : "malformed-env",
      ownerUid,
      [1],
      reportedPath,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!expected.exists) return;
      throw new SecretEnvConcurrentModificationError(reportedPath);
    }
    throw error;
  }
  if (current.exists !== expected.exists) throw new SecretEnvConcurrentModificationError(reportedPath);
  if (!current.exists || !expected.exists) return;
  if (!sameExpectedFileSnapshot(current, expected)) {
    throw new SecretEnvConcurrentModificationError(reportedPath);
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // The file itself is already fsynced; some platforms/filesystems reject directory fsync.
  } finally {
    await handle?.close();
  }
}

async function isGitTracked(path: string): Promise<boolean> {
  const directory = dirname(path);
  const repository = await runGit(["-C", directory, "rev-parse", "--show-toplevel"]);
  if (!repository.ok) {
    if (await hasGitMetadata(directory)) {
      throw new SecretEnvPersistenceRefusedError(
        "git-safety-unavailable",
        `Automatic secret persistence could not verify git tracking for ${path}.`,
      );
    }
    return false;
  }
  const root = repository.stdout.replace(/\r?\n$/u, "");
  const canonicalPath = join(await realpath(directory), basename(path));
  const tracked = await runGit(["-C", root, "ls-files", "--error-unmatch", "--", relative(root, canonicalPath)]);
  if (tracked.ok) return true;
  if (Number(tracked.code) === 1) return false;
  throw new SecretEnvPersistenceRefusedError(
    "git-safety-unavailable",
    `Automatic secret persistence could not verify git tracking for ${path}.`,
  );
}

/** Recheck the complete durable dotenv guard without changing either file. */
export async function verifySecretEnvPersistenceGuard(path: string): Promise<boolean> {
  const target = await resolveSafeSecretEnvTarget(path);
  const envSnapshot = await readSafeFile(
    target.path,
    "unsafe-env-path",
    "malformed-env",
    target.ownerUid,
  );
  if (!envSnapshot.exists || fileMode(envSnapshot) !== 0o600 || await isGitTracked(target.path)) {
    return false;
  }
  const gitIgnorePath = join(dirname(target.path), ".gitignore");
  const gitIgnoreSnapshot = await readSafeFile(
    gitIgnorePath,
    "unsafe-gitignore-path",
    "malformed-gitignore",
    target.ownerUid,
  );
  return gitIgnoreSnapshot.exists && ensureExactEnvIgnore(snapshotText(gitIgnoreSnapshot)) === snapshotText(gitIgnoreSnapshot);
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly code?: number | string;
}

function runGit(args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error === null) {
        resolveResult({ ok: true, stdout });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number }).code;
      resolveResult({ ok: false, stdout, ...(code === undefined ? {} : { code }) });
    });
  });
}

async function hasGitMetadata(start: string): Promise<boolean> {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function identityTemplate(
  dir: string,
  agentName: string,
  purpose: string,
  knowledgeFiles: readonly string[],
): string {
  const knowledgeSection = knowledgeFiles.length === 0
    ? "No existing project knowledge files were detected. Add references to authoritative knowledge here when available."
    : [
        "This folder already carries knowledge the agent must read and respect:",
        "",
        ...knowledgeFiles.map((file) => `- \`${file}\``),
      ].join("\n");

  return `# Identity

You are ${agentName}, a mono agent constructed in \`${basename(dir)}\`.

## Role

${purpose}

## Knowledge

${knowledgeSection}

## Boundaries

- Work inside this folder unless the user explicitly widens the workspace.
- Confirm before destructive changes.
- Fail honestly: report runtime or tool errors instead of inventing results.
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function scaffoldPathEscapesRoot(pathRelative: string): boolean {
  return pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative);
}

/**
 * Refuse generated scaffold artifacts whose parent chain escapes through a
 * symlink. This protects ordinary and save-incomplete init alike; staging is a
 * validation boundary, not authorization to weaken the eventual write path.
 */
async function ensureSafeScaffoldParent(
  root: string,
  filePath: string,
  createMissing: boolean,
): Promise<void> {
  const pathRelative = relative(root, filePath);
  if (pathRelative.length === 0 || scaffoldPathEscapesRoot(pathRelative)) {
    throw new Error(`Refusing to create scaffold artifact outside the agent directory: ${filePath}`);
  }
  const parentRelative = dirname(pathRelative);
  if (parentRelative === ".") return;

  let current = root;
  for (const segment of parentRelative.split(sep).filter((part) => part.length > 0)) {
    const next = join(current, segment);
    let entry;
    try {
      entry = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createMissing) return;
      try {
        await mkdir(next);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      entry = await lstat(next);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to create scaffold artifact through symbolic-link parent: ${next}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`Refusing to create scaffold artifact through non-directory parent: ${next}`);
    }
    current = next;
  }
}

async function assertSafeScaffoldTarget(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic-link scaffold ${label}: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function createSafeScaffoldDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Refusing non-directory scaffold working path: ${path}`);
  }
}

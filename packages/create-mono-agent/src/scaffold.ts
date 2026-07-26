// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

import {
  assertNpmPackageName,
  normalizeNpmName,
} from "./npm-name.js";
import {
  acquireScaffoldLock,
  assertScaffoldTargetParkingReady,
  assertScaffoldStage,
  commitScaffoldJournal,
  createScaffoldStage,
  prepareScaffoldTargetParking,
  recordScaffoldPublished,
  recordScaffoldTargetParked,
  releaseScaffoldLock,
  removeOrRetainParkedScaffoldTarget,
  removeScaffoldStage,
  retainScaffoldLockForRecovery,
  restoreParkedScaffoldTarget,
  type ParkedDirectoryRemover,
  type ScaffoldLock,
  type ScaffoldLockRecoveryHooks,
  type ScaffoldStage,
} from "./scaffold-lock.js";
import {
  isProjectTemplate,
  renderProject,
  type ProjectTemplate,
} from "./templates.js";

export type InstallPackageManager = "npm" | "pnpm";

export type PackageInstaller = (
  packageManager: InstallPackageManager,
  directory: string,
) => Promise<void>;

export interface ScaffoldAgentOptions {
  targetDirectory: string;
  cwd?: string;
  projectName?: string;
  displayName?: string;
  template?: ProjectTemplate;
  install?: boolean;
  packageManager?: InstallPackageManager;
  installer?: PackageInstaller;
}

export interface ScaffoldResult {
  directory: string;
  projectName: string;
  template: ProjectTemplate;
  installed: boolean;
  packageManager?: InstallPackageManager;
  files: readonly string[];
  retainedRecoveryPaths: readonly string[];
}

interface ScaffoldPublicationContext {
  readonly lockPath: string;
  readonly targetPath: string;
  readonly stagePath: string;
  readonly parkedPath: string;
}

export interface ScaffoldAgentTestHooks extends ScaffoldLockRecoveryHooks {
  readonly afterParkIntent?: (
    context: ScaffoldPublicationContext,
  ) => Promise<void>;
  readonly afterParkedBeforePublish?: (
    context: ScaffoldPublicationContext,
  ) => Promise<void>;
  readonly afterPublishBeforeJournal?: (
    context: ScaffoldPublicationContext,
  ) => Promise<void>;
  readonly afterPublishedBeforeParkedCleanup?: (
    context: ScaffoldPublicationContext,
  ) => Promise<void>;
  readonly removeParkedDirectory?: ParkedDirectoryRemover;
}

export class ScaffoldError extends Error {
  override readonly name = "ScaffoldError";
}

class RetainedScaffoldJournalError extends Error {
  override readonly name = "RetainedScaffoldJournalError";

  constructor(
    readonly journalPath: string,
    readonly stagePath: string,
    readonly parkedPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${detail}; retained scaffold recovery journal=${journalPath}; stage=${stagePath}; parked=${parkedPath}`,
      { cause },
    );
  }
}

export async function scaffoldAgent(options: ScaffoldAgentOptions): Promise<ScaffoldResult> {
  return scaffoldAgentWithHooks(options, {});
}

/**
 * Package-internal fault-injection seam. The package root does not export it.
 */
export async function scaffoldAgentForTesting(
  options: ScaffoldAgentOptions,
  hooks: ScaffoldAgentTestHooks,
): Promise<ScaffoldResult> {
  return scaffoldAgentWithHooks(options, hooks);
}

async function scaffoldAgentWithHooks(
  options: ScaffoldAgentOptions,
  hooks: ScaffoldAgentTestHooks,
): Promise<ScaffoldResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const target = resolve(cwd, options.targetDirectory);
  if (target === parse(target).root) {
    throw new ScaffoldError("Refusing to scaffold into a filesystem root");
  }

  const parent = dirname(target);
  const projectName = options.projectName ?? normalizeProjectName(basename(target));
  assertNpmPackageName(projectName, (message) => new ScaffoldError(message));
  const template = options.template ?? "minimal";
  if (!isProjectTemplate(template)) {
    throw new ScaffoldError(`Unknown project template: ${String(template)}`);
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });

  const lockPath = lockPathFor(parent, target);
  const lock = await acquireScaffoldLock(parent, basename(target), hooks).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        detail.startsWith("Another scaffold operation owns")
      ) {
        throw new ScaffoldError(
          `Another scaffold operation owns ${target}; lock: ${lockPath}`,
        );
      }
      throw new ScaffoldError(`${detail}; lock: ${lockPath}`);
    },
  );

  let stage: ScaffoldStage | undefined;
  let primaryFailure: unknown;
  let retainJournal = false;
  try {
    if (lock.publishedTargetRecovered) {
      const retained = lock.retainedRecoveryPaths.length === 0
        ? ""
        : `; retained recovery paths: ${lock.retainedRecoveryPaths.join(", ")}`;
      throw new ScaffoldError(
        `Recovered a previously published scaffold at ${target}; refusing to overwrite it${retained}`,
      );
    }
    await assertTargetAbsentOrEmpty(target);
    stage = await createScaffoldStage(lock);
    const files = renderProject({
      projectName,
      template,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    });
    await writeRenderedProject(stage.path, files);

    if (options.install === true) {
      const packageManager = options.packageManager ?? "pnpm";
      await (options.installer ?? installDependencies)(packageManager, stage.path);
    }

    const publicationRecoveryPaths = await publishStage(
      lock,
      stage,
      target,
      hooks,
    );
    stage = undefined;

    return {
      directory: target,
      projectName,
      template,
      installed: options.install === true,
      ...(options.install === true ? { packageManager: options.packageManager ?? "pnpm" } : {}),
      files: files.map((file) => file.path),
      retainedRecoveryPaths: Object.freeze([
        ...lock.retainedRecoveryPaths,
        ...publicationRecoveryPaths,
      ]),
    };
  } catch (error) {
    if (error instanceof RetainedScaffoldJournalError) {
      retainJournal = true;
    }
    if (stage !== undefined && retainJournal) {
      stage = undefined;
    }
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (stage !== undefined && !retainJournal) {
      try {
        await removeScaffoldStage(lock, stage);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      if (retainJournal) {
        await retainScaffoldLockForRecovery(lock);
      } else {
        await releaseScaffoldLock(lock);
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      if (primaryFailure === undefined && cleanupFailures.length === 1) {
        throw cleanupFailures[0];
      }
      throw new AggregateError(
        primaryFailure === undefined
          ? cleanupFailures
          : [primaryFailure, ...cleanupFailures],
        primaryFailure === undefined
          ? "Scaffold operation cleanup failed"
          : `Scaffold operation cleanup failed after: ${
              primaryFailure instanceof Error
                ? primaryFailure.message
                : String(primaryFailure)
            }`,
      );
    }
  }
}

function lockPathFor(parent: string, target: string): string {
  return join(parent, `.${basename(target)}.mono-agent-scaffold.lock`);
}

async function writeRenderedProject(
  stagePath: string,
  files: ReturnType<typeof renderProject>,
): Promise<void> {
  const directoryPaths = new Set(files.map((file) => dirname(file.path)).filter((path) => path !== "."));
  for (const relativePath of [...directoryPaths].sort()) {
    await mkdir(join(stagePath, relativePath), { recursive: true, mode: 0o700 });
  }
  for (const file of files) {
    await writeFile(join(stagePath, file.path), file.contents, {
      encoding: "utf8",
      flag: "wx",
      mode: file.mode,
    });
  }
}

async function publishStage(
  lock: ScaffoldLock,
  stage: ScaffoldStage,
  target: string,
  hooks: ScaffoldAgentTestHooks,
): Promise<readonly string[]> {
  const context = Object.freeze({
    lockPath: lock.path,
    targetPath: target,
    stagePath: stage.path,
    parkedPath: lock.parkedPath,
  });
  const state = await targetState(target);
  if (state === "absent") {
    let publicationRenameCompleted = false;
    try {
      await assertScaffoldStage(lock, stage);
      await rename(stage.path, target);
      publicationRenameCompleted = true;
      await recordScaffoldPublished(
        lock,
        stage,
        hooks.afterPublishBeforeJournal === undefined
          ? undefined
          : () => hooks.afterPublishBeforeJournal!(context),
      );
      await commitScaffoldJournal(lock);
      return Object.freeze([]);
    } catch (error) {
      if (publicationRenameCompleted) {
        throw retainJournalError(lock, error);
      }
      if (isAlreadyExists(error) || isDirectoryNotEmpty(error)) {
        throw new ScaffoldError(`Target changed while scaffolding: ${target}`);
      }
      throw error;
    }
  }
  if (state !== "empty-directory") {
    throw targetStateError(target, state);
  }

  let parkedIdentity: Awaited<ReturnType<
    typeof prepareScaffoldTargetParking
  >> | undefined;
  let targetParked = false;
  let publicationRenameCompleted = false;
  try {
    parkedIdentity = await prepareScaffoldTargetParking(lock);
    await hooks.afterParkIntent?.(context);
    await assertScaffoldTargetParkingReady(lock, parkedIdentity);
    await rename(target, lock.parkedPath);
    targetParked = true;
    await recordScaffoldTargetParked(lock, parkedIdentity);
    await hooks.afterParkedBeforePublish?.(context);
    await assertScaffoldStage(lock, stage);
    await rename(stage.path, target);
    publicationRenameCompleted = true;
    await recordScaffoldPublished(
      lock,
      stage,
      hooks.afterPublishBeforeJournal === undefined
        ? undefined
          : () => hooks.afterPublishBeforeJournal!(context),
    );
    await hooks.afterPublishedBeforeParkedCleanup?.(context);
    const retainedRecoveryPaths = await removeOrRetainParkedScaffoldTarget(
      lock,
      parkedIdentity,
      hooks.removeParkedDirectory,
    );
    await commitScaffoldJournal(lock);
    return retainedRecoveryPaths;
  } catch (error) {
    if (publicationRenameCompleted) {
      throw retainJournalError(lock, error);
    }
    if (targetParked && parkedIdentity !== undefined) {
      try {
        await restoreParkedScaffoldTarget(lock, parkedIdentity);
      } catch (restoreError) {
        throw retainJournalError(
          lock,
          new AggregateError(
            [error, restoreError],
            `Scaffold publication and exact target restoration failed; parked=${lock.parkedPath}`,
          ),
        );
      }
    }
    throw error;
  }
}

function retainJournalError(
  lock: ScaffoldLock,
  cause: unknown,
): RetainedScaffoldJournalError {
  if (cause instanceof RetainedScaffoldJournalError) return cause;
  return new RetainedScaffoldJournalError(
    lock.path,
    lock.stagePath,
    lock.parkedPath,
    cause,
  );
}

async function assertTargetAbsentOrEmpty(target: string): Promise<void> {
  const state = await targetState(target);
  if (state !== "absent" && state !== "empty-directory") {
    throw targetStateError(target, state);
  }
}

type TargetState = "absent" | "empty-directory" | "nonempty-directory" | "symlink" | "other";

async function targetState(target: string): Promise<TargetState> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }

  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isDirectory()) return "other";
  return (await readdir(target)).length === 0 ? "empty-directory" : "nonempty-directory";
}

function targetStateError(target: string, state: Exclude<TargetState, "absent" | "empty-directory">): ScaffoldError {
  if (state === "symlink") return new ScaffoldError(`Target must not be a symbolic link: ${target}`);
  if (state === "nonempty-directory") return new ScaffoldError(`Target directory is not empty: ${target}`);
  return new ScaffoldError(`Target is not a directory: ${target}`);
}

async function installDependencies(packageManager: InstallPackageManager, directory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const invocation = packageManagerInvocation(packageManager);
    const child = spawn(invocation.command, invocation.args, {
      cwd: directory,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new ScaffoldError(
        signal === null
          ? `${packageManager} install exited with code ${String(code)}`
          : `${packageManager} install was terminated by ${signal}`,
      ));
    });
  });
}

interface PackageManagerInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

function packageManagerInvocation(
  packageManager: InstallPackageManager,
  platform = process.platform,
  windowsCommandInterpreter = process.env.ComSpec ?? "cmd.exe",
): PackageManagerInvocation {
  return platform === "win32"
    ? {
        command: windowsCommandInterpreter,
        args: ["/d", "/s", "/c", `${packageManager}.cmd install`],
      }
    : {
        command: packageManager,
        args: ["install"],
      };
}

/**
 * Package-internal test seam. The package root deliberately does not export it.
 */
export function packageManagerInvocationForTesting(
  packageManager: InstallPackageManager,
  platform: NodeJS.Platform,
): PackageManagerInvocation {
  return packageManagerInvocation(packageManager, platform, "cmd.exe");
}

function normalizeProjectName(value: string): string {
  const normalized = normalizeNpmName(value);
  if (normalized.length === 0) {
    throw new ScaffoldError("Could not derive a package name from the target directory");
  }
  return normalized;
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return hasCode(error, "ENOTEMPTY");
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

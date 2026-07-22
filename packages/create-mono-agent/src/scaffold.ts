import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

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
}

export class ScaffoldError extends Error {
  override readonly name = "ScaffoldError";
}

export async function scaffoldAgent(options: ScaffoldAgentOptions): Promise<ScaffoldResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const target = resolve(cwd, options.targetDirectory);
  if (target === parse(target).root) {
    throw new ScaffoldError("Refusing to scaffold into a filesystem root");
  }

  const parent = dirname(target);
  const projectName = options.projectName ?? normalizeProjectName(basename(target));
  assertPackageName(projectName);
  const template = options.template ?? "minimal";
  if (!isProjectTemplate(template)) {
    throw new ScaffoldError(`Unknown project template: ${String(template)}`);
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });

  const lockPath = join(parent, `.${basename(target)}.mono-agent-scaffold.lock`);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new ScaffoldError(`Another scaffold operation owns ${target}`);
    }
    throw error;
  }

  let stagePath: string | undefined;
  try {
    await assertTargetAbsentOrEmpty(target);
    stagePath = await mkdtemp(join(parent, `.${basename(target)}.mono-agent-stage-`));
    const files = renderProject({
      projectName,
      template,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    });
    await writeRenderedProject(stagePath, files);

    if (options.install === true) {
      const packageManager = options.packageManager ?? "pnpm";
      await (options.installer ?? installDependencies)(packageManager, stagePath);
    }

    await publishStage(stagePath, target);
    stagePath = undefined;

    return {
      directory: target,
      projectName,
      template,
      installed: options.install === true,
      ...(options.install === true ? { packageManager: options.packageManager ?? "pnpm" } : {}),
      files: files.map((file) => file.path),
    };
  } finally {
    if (stagePath !== undefined) {
      await rm(stagePath, { recursive: true, force: true });
    }
    await rmdir(lockPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
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

async function publishStage(stagePath: string, target: string): Promise<void> {
  const state = await targetState(target);
  if (state === "absent") {
    try {
      await rename(stagePath, target);
      return;
    } catch (error) {
      if (isAlreadyExists(error) || isDirectoryNotEmpty(error)) {
        throw new ScaffoldError(`Target changed while scaffolding: ${target}`);
      }
      throw error;
    }
  }
  if (state !== "empty-directory") {
    throw targetStateError(target, state);
  }

  const parkedPath = join(dirname(target), `.${basename(target)}.mono-agent-empty-${randomUUID()}`);
  await rename(target, parkedPath);
  let targetParked = true;
  try {
    const parkedState = await targetState(parkedPath);
    if (parkedState !== "empty-directory") {
      throw new ScaffoldError(`Target changed while scaffolding: ${target}`);
    }
    await rename(stagePath, target);
    await rmdir(parkedPath);
    targetParked = false;
  } catch (error) {
    if (targetParked) {
      await rename(parkedPath, target).catch(() => undefined);
    }
    throw error;
  }
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
    const child = spawn(packageManager, ["install"], {
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

function normalizeProjectName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  if (normalized.length === 0) {
    throw new ScaffoldError("Could not derive a package name from the target directory");
  }
  return normalized;
}

function assertPackageName(value: string): void {
  if (value.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value)) {
    throw new ScaffoldError(`Invalid npm package name: ${JSON.stringify(value)}`);
  }
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

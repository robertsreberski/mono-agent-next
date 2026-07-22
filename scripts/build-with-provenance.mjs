#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_LOCK_FILENAME,
  BUILD_MARKER_FILENAME,
  acquireBuildLock,
  clearBuildMarker,
  computeBuildOutputDigest,
  computeDeploymentStateFingerprint,
  computeRuntimeDependencyDigest,
  publishBuildMarker,
  releaseBuildLock,
} from "./lib/build-provenance.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
const MAX_EXECUTABLE_PATH_LENGTH = 4096;
const MAX_PATH_ENV_LENGTH = 128 * 1024;
const MAX_PATH_ENTRIES = 1024;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/iu;
const BUILD_COMMANDS = Object.freeze([
  ["pnpm", ["-r", "--sort", "run", "build"]],
  ["pnpm", ["run", "build:demo"]],
]);
const WINDOWS_PNPM_ARGUMENTS = new Set([
  JSON.stringify(["-r", "--sort", "run", "build"]),
  JSON.stringify(["run", "build:demo"]),
]);
const REQUIRED_EXECUTABLES = Object.freeze([
  "packages/agent-app/dist/cli.js",
  "packages/tui/dist/bin/mono-agent-tui.js",
]);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function finalizeRequiredExecutables(repo) {
  const expectedUid = BigInt(process.getuid());
  const executableBits = (0o111 & ~process.umask()) | 0o100;
  for (const relativePath of REQUIRED_EXECUTABLES) {
    const path = resolve(repo, relativePath);
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
      const before = fstatSync(fd, { bigint: true });
      const currentBefore = lstatSync(path, { bigint: true });
      if (!before.isFile()
        || before.nlink !== 1n
        || before.uid !== expectedUid
        || (before.mode & 0o7022n) !== 0n
        || !currentBefore.isFile()
        || !sameFileIdentity(before, currentBefore)) {
        throw new Error("unsafe required executable");
      }
      const executableMode = Number(before.mode & 0o666n) | executableBits;
      fchmodSync(fd, executableMode);
      fsyncSync(fd);
      const after = fstatSync(fd, { bigint: true });
      const currentAfter = lstatSync(path, { bigint: true });
      if (!after.isFile()
        || after.nlink !== 1n
        || after.uid !== expectedUid
        || (after.mode & 0o7777n) !== BigInt(executableMode)
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || !currentAfter.isFile()
        || !sameFileIdentity(before, after)
        || !sameFileIdentity(after, currentAfter)
        || (currentAfter.mode & 0o7777n) !== BigInt(executableMode)) {
        throw new Error("required executable changed during mode finalization");
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

export function prependNodeToPath(nodeBin, currentPath, platform = process.platform) {
  const separator = platform === "win32" ? ";" : delimiter;
  return typeof currentPath === "string" && currentPath.length > 0
    ? `${nodeBin}${separator}${currentPath}`
    : nodeBin;
}

function isSafeWindowsDrivePath(path) {
  if (typeof path !== "string"
    || path.length === 0
    || path.length > MAX_EXECUTABLE_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(path)
    || !win32.isAbsolute(path)
    || !/^[a-z]:[\\/]$/iu.test(win32.parse(path).root)
    || path.slice(2).includes(":")) {
    return false;
  }
  const segments = path.slice(win32.parse(path).root.length).split(/[\\/]/u).filter(Boolean);
  return segments.every((segment) => segment !== "."
    && segment !== ".."
    && !/[. ]$/u.test(segment)
    && !WINDOWS_RESERVED_BASENAME.test(segment.split(".", 1)[0]));
}

function isSafeWindowsExecutable(path, basenamePattern) {
  return isSafeWindowsDrivePath(path) && basenamePattern.test(win32.basename(path));
}

function isSafeWindowsTrustRoot(path) {
  return isSafeWindowsDrivePath(path) && win32.normalize(path) !== win32.parse(path).root;
}

function isWindowsDescendant(parent, candidate) {
  const relativePath = win32.relative(parent, candidate);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${win32.sep}`)
    && !win32.isAbsolute(relativePath);
}

/**
 * Resolve only the two fixed internal pnpm build commands. Windows executes
 * the exact pnpm JS entrypoint beneath the current Node installation or an
 * explicit PNPM_HOME, without a shell or PATH lookup. All other environment
 * claims fail closed instead of selecting an ambient pnpm.cmd/cmd.exe.
 */
export function selectBuildInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || command !== "pnpm") {
    return { command, args: [...args] };
  }

  if (!WINDOWS_PNPM_ARGUMENTS.has(JSON.stringify(args))) {
    throw new Error("unsafe Windows pnpm build command");
  }

  const nodePath = options.nodePath ?? process.execPath;
  const npmExecPath = Object.hasOwn(options, "npmExecPath")
    ? options.npmExecPath
    : process.env.npm_execpath;
  const environment = options.env ?? process.env;
  const pnpmHome = Object.hasOwn(options, "pnpmHome")
    ? options.pnpmHome
    : environment.PNPM_HOME;
  const nodePathIsSafe = isSafeWindowsExecutable(nodePath, /^node\.exe$/iu);
  const nodeInstallRoot = nodePathIsSafe ? win32.dirname(nodePath) : undefined;
  const trustedRoots = isSafeWindowsTrustRoot(nodeInstallRoot) ? [nodeInstallRoot] : [];
  if (isSafeWindowsTrustRoot(pnpmHome)) trustedRoots.push(pnpmHome);
  if (nodePathIsSafe
    && isSafeWindowsExecutable(npmExecPath, /^pnpm\.(?:cjs|mjs|js)$/iu)
    && trustedRoots.some((root) => isWindowsDescendant(root, npmExecPath))) {
    return { command: nodePath, args: [npmExecPath, ...args] };
  }
  throw new Error("trusted Windows pnpm entrypoint unavailable");
}

function normalizeSafePosixAbsolutePath(path) {
  if (typeof path !== "string"
    || path.length === 0
    || path.length > MAX_EXECUTABLE_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(path)
    || !posix.isAbsolute(path)
    || path.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const normalized = posix.normalize(path);
  const withoutTrailingSeparators = path.length === 1 ? path : path.replace(/\/+$/u, "");
  return normalized === withoutTrailingSeparators ? normalized : null;
}

function isPosixDescendantOrSelf(parent, candidate) {
  const relativePath = posix.relative(parent, candidate);
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${posix.sep}`)
      && !posix.isAbsolute(relativePath));
}

function hasTrustedDirectoryChain(path, currentUid) {
  let directory = posix.dirname(path);
  for (let depth = 0; depth < 128; depth += 1) {
    const details = statSync(directory);
    const writableByOthers = (details.mode & 0o022) !== 0;
    const stickyProtected = (details.mode & 0o1000) !== 0;
    if (!details.isDirectory()
      || !Number.isInteger(details.mode)
      || (writableByOthers && !stickyProtected)
      || !Number.isInteger(details.uid)
      || (details.uid !== 0 && details.uid !== currentUid)) {
      return false;
    }
    const parent = posix.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
  return false;
}

function inspectGitExecutable(path, currentUid) {
  try {
    const canonicalPath = realpathSync.native(path);
    accessSync(canonicalPath, constants.X_OK);
    const details = statSync(canonicalPath);
    return {
      canonicalPath,
      isFile: details.isFile(),
      mode: details.mode,
      uid: details.uid,
      directoryChainTrusted: hasTrustedDirectoryChain(canonicalPath, currentUid),
    };
  } catch {
    return null;
  }
}

function isTrustedGitInspection(value, currentUid) {
  const canonicalPath = normalizeSafePosixAbsolutePath(value?.canonicalPath);
  return canonicalPath !== null
    && posix.basename(canonicalPath) === "git"
    && value?.isFile === true
    && Number.isInteger(value.mode)
    && (value.mode & 0o111) !== 0
    && (value.mode & 0o022) === 0
    && (value.mode & 0o6000) === 0
    && Number.isInteger(value.uid)
    && (value.uid === 0 || value.uid === currentUid)
    && value.directoryChainTrusted === true;
}

/**
 * Resolve Git once from a closed set of absolute PATH directories, then use
 * its canonical absolute path for every source probe. Profile symlinks (for
 * example Nix profiles) are accepted only when their final executable has a
 * trusted owner and mode. Relative/empty PATH entries never imply cwd lookup.
 */
export function resolveTrustedGitExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!supportsStrictBuildProvenance(platform)) return null;

  const pathEnv = Object.hasOwn(options, "pathEnv")
    ? options.pathEnv
    : platform === "darwin" ? "/usr/bin" : process.env.PATH;
  const currentUid = options.currentUid
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const inspectExecutable = options.inspectExecutable ?? inspectGitExecutable;
  const hasForbiddenRoot = Object.hasOwn(options, "forbiddenRoot");
  const forbiddenRoot = hasForbiddenRoot
    ? normalizeSafePosixAbsolutePath(options.forbiddenRoot)
    : null;
  if (typeof pathEnv !== "string"
    || pathEnv.length === 0
    || pathEnv.length > MAX_PATH_ENV_LENGTH
    || !Number.isInteger(currentUid)
    || (hasForbiddenRoot && forbiddenRoot === null)) {
    return null;
  }

  const entries = pathEnv.split(":");
  if (entries.length === 0 || entries.length > MAX_PATH_ENTRIES) return null;
  const directories = entries.map(normalizeSafePosixAbsolutePath);
  if (directories.some((directory) => directory === null)) return null;

  for (const directory of directories) {
    const candidate = posix.join(directory, "git");
    if (forbiddenRoot !== null && isPosixDescendantOrSelf(forbiddenRoot, candidate)) continue;
    let inspection;
    try {
      inspection = inspectExecutable(candidate, currentUid);
    } catch {
      inspection = null;
    }
    if (isTrustedGitInspection(inspection, currentUid)) {
      const canonicalPath = normalizeSafePosixAbsolutePath(inspection.canonicalPath);
      if (forbiddenRoot === null || !isPosixDescendantOrSelf(forbiddenRoot, canonicalPath)) {
        return canonicalPath;
      }
    }
  }
  return null;
}

function run(command, args, options = {}) {
  const nodeBin = dirname(process.execPath);
  let invocation;
  let result;
  try {
    invocation = selectBuildInvocation(command, args);
    result = spawnSync(invocation.command, invocation.args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: options.stdio ?? "pipe",
      env: options.env ?? {
        ...process.env,
        // Keep every package build on the exact Node that will be recorded in
        // the marker, even if the invoking shell resolves another Node first.
        PATH: prependNodeToPath(nodeBin, process.env.PATH),
      },
    });
  } catch {
    return { status: 127, stdout: "" };
  }
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
  };
}

function runTrustedGit(repo, args, runCommand, gitExecutable) {
  return runCommand(gitExecutable, ["-C", repo, ...args], { cwd: repo, env: GIT_ENV });
}

function readSourceState(repo, runCommand, gitExecutable) {
  const shaResult = runTrustedGit(repo, ["rev-parse", "HEAD"], runCommand, gitExecutable);
  const gitSha = shaResult.status === 0 ? shaResult.stdout.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/u.test(gitSha)) return null;

  const statusResult = runTrustedGit(
    repo,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    runCommand,
    gitExecutable,
  );
  if (statusResult.status !== 0) return null;
  return { gitSha, sourceState: statusResult.stdout.length === 0 ? "clean" : "dirty" };
}

function markerFilesAreIgnored(repo, runCommand, gitExecutable) {
  for (const filename of [
    BUILD_MARKER_FILENAME,
    `${BUILD_MARKER_FILENAME}.tmp-probe`,
    BUILD_LOCK_FILENAME,
  ]) {
    const result = runTrustedGit(
      repo,
      ["check-ignore", "-q", "--", filename],
      runCommand,
      gitExecutable,
    );
    if (result.status !== 0) return false;
  }
  return true;
}

function runBuildCommands(repo, runCommand, commands) {
  for (const [command, args] of commands) {
    const result = runCommand(command, args, { cwd: repo, stdio: "inherit" });
    if (result.status !== 0) {
      return { exitCode: result.status, error: "workspace build failed" };
    }
  }
  return { exitCode: 0 };
}

export function supportsStrictBuildProvenance(platform) {
  return platform === "darwin" || platform === "linux";
}

function runPortableBuild(repo, runCommand, commands) {
  // A build on an unsupported host cannot retain a prior POSIX durability
  // claim after changing outputs. It deliberately publishes no replacement.
  try {
    clearBuildMarker(repo, { syncDirectory: false });
  } catch {
    return { exitCode: 1, error: "stale build marker could not be cleared" };
  }
  return runBuildCommands(repo, runCommand, commands);
}

export function runBuildWithProvenance(options = {}) {
  let repo = options.repo ?? REPO;
  const runCommand = options.runCommand ?? run;
  const commands = options.commands ?? BUILD_COMMANDS;
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;

  if (!supportsStrictBuildProvenance(platform)) {
    return runPortableBuild(repo, runCommand, commands);
  }

  const resolveGitExecutable = options.resolveGitExecutable ?? resolveTrustedGitExecutable;
  let canonicalRepo;
  try {
    canonicalRepo = normalizeSafePosixAbsolutePath(realpathSync.native(repo));
  } catch {
    canonicalRepo = null;
  }
  if (canonicalRepo === null) {
    return { exitCode: 1, error: "trusted Git executable unavailable" };
  }
  repo = canonicalRepo;
  let gitExecutable;
  try {
    const resolverOptions = { platform, forbiddenRoot: canonicalRepo };
    if (Object.hasOwn(options, "pathEnv")) resolverOptions.pathEnv = options.pathEnv;
    gitExecutable = resolveGitExecutable(resolverOptions);
  } catch {
    gitExecutable = null;
  }
  gitExecutable = normalizeSafePosixAbsolutePath(gitExecutable);
  if (gitExecutable === null || posix.basename(gitExecutable) !== "git") {
    return { exitCode: 1, error: "trusted Git executable unavailable" };
  }

  let lock;
  try {
    // The lock is acquired before invalidating any prior marker and remains
    // held through output synchronization and marker publication.
    lock = acquireBuildLock(repo);
  } catch {
    return { exitCode: 1, error: "build already in progress or lock is unsafe" };
  }

  let result;
  try {
    clearBuildMarker(repo);
    if (!markerFilesAreIgnored(repo, runCommand, gitExecutable)) {
      result = { exitCode: 1, error: "build provenance files are not ignored" };
    } else {
      const before = readSourceState(repo, runCommand, gitExecutable);
      if (before === null) {
        result = { exitCode: 1, error: "build source state unavailable" };
      } else {
        result = runBuildCommands(repo, runCommand, commands);
        if (result.exitCode === 0) {
          try {
            // The executable modes are part of the dependency/workspace
            // digest. Finalize them while the build lock is held and before
            // any terminal source or deployment-state attestation.
            finalizeRequiredExecutables(repo);
          } catch {
            result = { exitCode: 1, error: "required build entrypoints unavailable or unsafe" };
          }
          if (result.exitCode === 0) {
            const after = readSourceState(repo, runCommand, gitExecutable);
            if (after === null
              || after.gitSha !== before.gitSha
              || after.sourceState !== before.sourceState) {
              result = { exitCode: 1, error: "build source changed during build" };
            } else {
              let outputDigest;
              let dependencyDigest;
              let deploymentStateBefore;
              try {
                deploymentStateBefore = computeDeploymentStateFingerprint(repo);
                outputDigest = computeBuildOutputDigest(repo, { sync: true });
                dependencyDigest = computeRuntimeDependencyDigest(repo);
                options.afterDeploymentDigests?.();
              } catch {
                result = { exitCode: 1, error: "build outputs or runtime dependencies unavailable or unstable" };
              }
              if (result.exitCode === 0
                && deploymentStateBefore !== undefined
                && outputDigest !== undefined
                && dependencyDigest !== undefined) {
                const finalSource = readSourceState(repo, runCommand, gitExecutable);
                if (finalSource === null
                  || finalSource.gitSha !== before.gitSha
                  || finalSource.sourceState !== before.sourceState) {
                  result = { exitCode: 1, error: "build source changed during build" };
                } else {
                  let marker;
                  try {
                    marker = {
                      schemaVersion: 2,
                      gitSha: finalSource.gitSha,
                      completedAt: now().toISOString(),
                      nodeVersion: process.versions.node,
                      nodeAbi: process.versions.modules,
                      sourceState: finalSource.sourceState,
                      outputDigest,
                      dependencyDigest,
                    };
                  } catch {
                    result = { exitCode: 1, error: "build marker publication failed" };
                  }
                  if (marker !== undefined) {
                    let deploymentStateAfter;
                    try {
                      deploymentStateAfter = computeDeploymentStateFingerprint(repo);
                    } catch {
                      result = {
                        exitCode: 1,
                        error: "build outputs or runtime dependencies unavailable or unstable",
                      };
                    }
                    if (deploymentStateAfter !== undefined) {
                      if (deploymentStateAfter !== deploymentStateBefore) {
                        result = {
                          exitCode: 1,
                          error: "build deployment state changed during attestation",
                        };
                      } else {
                        try {
                          publishBuildMarker(repo, marker);
                          result = { exitCode: 0 };
                        } catch {
                          result = { exitCode: 1, error: "build marker publication failed" };
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    result = { exitCode: 1, error: "build provenance lifecycle failed" };
  }

  try {
    releaseBuildLock(repo, lock);
  } catch {
    try {
      clearBuildMarker(repo);
    } catch {
      // The lock remains a fail-closed probe signal if cleanup itself failed.
    }
    return { exitCode: 1, error: "build lock cleanup failed" };
  }
  return result;
}

function main() {
  const result = runBuildWithProvenance();
  if (result.error !== undefined) {
    process.stderr.write(`Build provenance failed: ${result.error}.\n`);
  }
  process.exitCode = result.exitCode;
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) main();

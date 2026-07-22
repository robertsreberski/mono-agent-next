import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, opendir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const MANAGED_SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const MANAGED_SRT_VERSION = "0.0.64";
export const MANAGED_SRT_LOCK_SHA256 = "0f34561ddc700ad43c31f254beb0e1e4b87bae61795acac5d7fa890dd5890924";
export const MANAGED_SRT_TREE_SHA256 = "a6302340f9754fbb4fab32e3bc636a6d05e389ad338a7bc6b98c71a9f3609649";
export const MANAGED_SRT_MARKER = ".mono-agent-srt.json";

export interface ManagedSrtMarker {
  readonly schemaVersion: 2;
  readonly package: typeof MANAGED_SRT_PACKAGE;
  readonly version: typeof MANAGED_SRT_VERSION;
  readonly lockSha256: typeof MANAGED_SRT_LOCK_SHA256;
  readonly cliSha256: string;
  readonly packageJsonSha256: string;
  readonly treeSha256: typeof MANAGED_SRT_TREE_SHA256;
}

export interface SrtFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

export interface SrtLaunch {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly source: "managed" | "external" | "explicit";
  readonly installRoot?: string;
  readonly files: readonly SrtFileIdentity[];
}

export interface ResolveSrtLaunchOptions {
  readonly command?: string;
  readonly nodePath?: string;
  readonly cliPath?: string;
  /** Node executable used to launch an integrity-verified managed SRT tree. */
  readonly managedNodePath?: string;
  readonly cacheRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export class ManagedSrtCorruptError extends Error {
  readonly installRoot: string;

  constructor(installRoot: string, message: string) {
    super(`Managed SRT install at ${installRoot} is unsafe or corrupt: ${message}`);
    this.name = "ManagedSrtCorruptError";
    this.installRoot = installRoot;
  }
}

export function managedSrtInstallRoot(input: {
  readonly cacheRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
} = {}): string {
  const cacheRoot = input.cacheRoot ?? defaultCacheRoot(
    input.platform ?? process.platform,
    input.env ?? process.env,
    input.homeDir ?? homedir(),
  );
  return resolve(cacheRoot, "mono-agent", "tools", "srt", MANAGED_SRT_VERSION, MANAGED_SRT_LOCK_SHA256);
}

export async function resolveSrtLaunch(options: ResolveSrtLaunchOptions = {}): Promise<SrtLaunch> {
  const platform = options.platform ?? process.platform;
  if (options.nodePath !== undefined || options.cliPath !== undefined) {
    if (options.nodePath === undefined || options.cliPath === undefined) {
      throw new Error("SRT nodePath and cliPath must be provided together.");
    }
    assertAbsolutePath(options.nodePath, "nodePath");
    assertAbsolutePath(options.cliPath, "cliPath");
    assertVerifiableNodeOwnership(platform);
    const node = await resolveTrustedFile(options.nodePath, false, "Node executable", undefined, true);
    const cli = await resolveTrustedFile(options.cliPath, true, "SRT CLI");
    return {
      command: node.path,
      prefixArgs: [cli.path],
      source: "explicit",
      files: [node, cli],
    };
  }

  if (options.command !== undefined) {
    const command = await resolveTrustedExecutable(options.command, options.env ?? process.env);
    return { command: command.path, prefixArgs: [], source: "explicit", files: [command] };
  }

  if (platform === "darwin") {
    const installRoot = managedSrtInstallRoot(options);
    const present = await pathExists(installRoot);
    if (present) {
      const cliPath = await verifyManagedSrtInstall(installRoot);
      const managedNodePath = options.managedNodePath ?? process.execPath;
      assertAbsolutePath(managedNodePath, "managedNodePath");
      assertVerifiableNodeOwnership(platform);
      assertSupportedNodeVersion(process.versions.node);
      const node = await resolveTrustedFile(managedNodePath, false, "Node executable", installRoot, true);
      const cli = await resolveTrustedFile(cliPath, true, "SRT CLI", installRoot);
      return {
        command: node.path,
        prefixArgs: [cli.path],
        source: "managed",
        installRoot,
        files: [node, cli],
      };
    }
  }

  // Compatibility for users who installed SRT themselves. This path is used
  // only when the exact managed location is absent. A present-but-corrupt
  // managed install throws above and can never silently downgrade to PATH.
  const command = await resolveTrustedExecutable("srt", options.env ?? process.env);
  return { command: command.path, prefixArgs: [], source: "external", files: [command] };
}

export async function verifyManagedSrtInstall(installRoot: string): Promise<string> {
  assertAbsolutePath(installRoot, "installRoot");
  await assertSecureDirectory(installRoot, "install root", installRoot);
  let ancestor = dirname(installRoot);
  for (const label of ["version root", "SRT root", "tools root", "mono-agent cache root"] as const) {
    await assertSecureDirectory(ancestor, label, installRoot);
    ancestor = dirname(ancestor);
  }

  const markerPath = resolve(installRoot, MANAGED_SRT_MARKER);
  const lockPath = resolve(installRoot, "package-lock.json");
  const cliPath = resolve(installRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js");
  const packageJsonPath = resolve(installRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "package.json");

  await assertSecureRegularFile(markerPath, true, "managed marker", installRoot);
  await assertSecureRegularFile(lockPath, true, "managed lockfile", installRoot);
  await assertSecureRegularFile(cliPath, true, "SRT CLI", installRoot);
  await assertSecureRegularFile(packageJsonPath, true, "SRT package manifest", installRoot);

  let marker: ManagedSrtMarker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as ManagedSrtMarker;
  } catch (error) {
    throw corrupt(installRoot, `marker is unreadable or invalid JSON (${errorMessage(error)})`);
  }
  if (
    marker.schemaVersion !== 2
    || marker.package !== MANAGED_SRT_PACKAGE
    || marker.version !== MANAGED_SRT_VERSION
    || marker.lockSha256 !== MANAGED_SRT_LOCK_SHA256
    || !isSha256(marker.cliSha256)
    || !isSha256(marker.packageJsonSha256)
    || marker.treeSha256 !== MANAGED_SRT_TREE_SHA256
  ) {
    throw corrupt(installRoot, "marker identity does not match the pinned SRT package");
  }

  const [lockHash, cliHash, packageJsonHash, treeHash] = await Promise.all([
    sha256File(lockPath),
    sha256File(cliPath),
    sha256File(packageJsonPath),
    hashPrivateManagedTree(installRoot),
  ]);
  if (lockHash !== MANAGED_SRT_LOCK_SHA256) {
    throw corrupt(installRoot, "package-lock.json does not match the checked-in lock hash");
  }
  if (cliHash !== marker.cliSha256) {
    throw corrupt(installRoot, "SRT CLI content does not match its install marker");
  }
  if (packageJsonHash !== marker.packageJsonSha256) {
    throw corrupt(installRoot, "SRT package manifest does not match its install marker");
  }
  if (treeHash !== MANAGED_SRT_TREE_SHA256) {
    throw corrupt(installRoot, "managed dependency tree does not match the independently pinned tree hash");
  }

  let packageJson: { name?: unknown; version?: unknown };
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
  } catch (error) {
    throw corrupt(installRoot, `SRT package manifest is invalid (${errorMessage(error)})`);
  }
  if (packageJson.name !== MANAGED_SRT_PACKAGE || packageJson.version !== MANAGED_SRT_VERSION) {
    throw corrupt(installRoot, "installed SRT package name or version is not pinned");
  }
  return cliPath;
}

export function assertSupportedNodeVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) {
    throw new Error(`Cannot determine whether Node ${version} satisfies SRT's >=20.11.0 requirement.`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 20 || (major === 20 && minor < 11)) {
    throw new Error(`Managed SRT requires Node >=20.11.0; current Node is ${version}.`);
  }
}

function defaultCacheRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return resolve(xdg);
  }
  return platform === "darwin"
    ? resolve(homeDir, "Library", "Caches")
    : resolve(homeDir, ".cache");
}

async function assertSecureDirectory(path: string, label: string, installRoot: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    throw corrupt(installRoot, `${label} is unavailable (${errorMessage(error)})`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw corrupt(installRoot, `${label} is not a real directory`);
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    throw corrupt(installRoot, `${label} is not owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw corrupt(installRoot, `${label} grants access to group or other users`);
  }
}

async function assertSecureRegularFile(
  path: string,
  requirePrivate: boolean,
  label: string,
  installRoot = path,
  requireExecutable = false,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    throw corrupt(installRoot, `${label} is unavailable (${errorMessage(error)})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw corrupt(installRoot, `${label} is not a regular non-symbolic file`);
  }
  // The launcher path is checked against sandbox writable roots later, but a
  // second hardlink could name the same owner-writable inode from inside one of
  // those roots. There is no portable way to enumerate every alias, so retain
  // the single-link invariant for launchers as well as private managed files.
  if (stat.nlink !== 1) {
    throw corrupt(
      installRoot,
      `${label} has ${stat.nlink} hard links; expected exactly one so no writable-root alias can modify it`,
    );
  }
  if (requireExecutable && process.getuid === undefined) {
    throw corrupt(installRoot, `${label} ownership cannot be verified on this platform`);
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid() && stat.uid !== 0) {
    throw corrupt(installRoot, `${label} has an unexpected owner`);
  }
  if (requirePrivate && (stat.mode & 0o077) !== 0) {
    throw corrupt(installRoot, `${label} grants access to group or other users`);
  }
  if (!requirePrivate && (stat.mode & 0o022) !== 0) {
    throw corrupt(installRoot, `${label} is writable by group or other users`);
  }
  if (requireExecutable && (stat.mode & 0o6000) !== 0) {
    throw corrupt(installRoot, `${label} has setuid or setgid privilege bits`);
  }
  if (requireExecutable) {
    try {
      await access(path, fsConstants.X_OK);
    } catch (error) {
      throw corrupt(installRoot, `${label} is not executable by the current user (${errorMessage(error)})`);
    }
  }
}

function assertVerifiableNodeOwnership(platform: NodeJS.Platform): void {
  if (platform === "win32" || process.getuid === undefined) {
    throw new Error(
      `Node executable ownership cannot be verified on ${platform}; managed or explicit SRT Node launch requires POSIX uid ownership checks.`,
    );
  }
}

async function resolveTrustedExecutable(command: string, env: NodeJS.ProcessEnv): Promise<SrtFileIdentity> {
  const normalized = command.trim();
  if (normalized.length === 0) {
    throw new Error("SRT command must not be empty.");
  }
  const candidates = commandCandidates(normalized, env);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await resolveTrustedFile(candidate, false, "SRT executable");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`SRT executable "${normalized}" could not be resolved to a trusted absolute file (${errorMessage(lastError)}).`);
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (isAbsolute(command) || command.includes(sep) || (sep === "\\" && command.includes("/"))) {
    return [resolve(command)];
  }
  const pathValue = env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => extensions.map((extension) => resolve(entry, `${command}${extension}`)));
}

export async function resolveTrustedFile(
  inputPath: string,
  requirePrivate: boolean,
  label: string,
  installRoot = inputPath,
  requireExecutable = false,
): Promise<SrtFileIdentity> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(inputPath);
  } catch (error) {
    throw corrupt(installRoot, `${label} cannot be resolved canonically (${errorMessage(error)})`);
  }
  assertAbsolutePath(canonicalPath, label);
  await assertSecureRegularFile(canonicalPath, requirePrivate, label, installRoot, requireExecutable);
  const fileStat = await lstat(canonicalPath);
  return {
    path: canonicalPath,
    sha256: await sha256File(canonicalPath),
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
  };
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function hashPrivateManagedTree(installRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directoryPath: string): Promise<void> {
    const directory = await opendir(directoryPath);
    const entries = [];
    for await (const entry of directory) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      const relativePath = relative(installRoot, path);
      if (relativePath === MANAGED_SRT_MARKER || relativePath === "node_modules/.package-lock.json") {
        continue;
      }
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) {
        throw corrupt(installRoot, `managed dependency tree contains a symbolic link: ${relativePath}`);
      }
      if (process.getuid !== undefined && entryStat.uid !== process.getuid()) {
        throw corrupt(installRoot, `managed dependency tree has an unexpected owner: ${relativePath}`);
      }
      if ((entryStat.mode & 0o077) !== 0) {
        throw corrupt(installRoot, `managed dependency tree is not owner-only: ${relativePath}`);
      }
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(path);
      } else if (entryStat.isFile() && entryStat.nlink === 1) {
        hash.update(`F\0${relativePath}\0${entryStat.size}\0`);
        hash.update(await readFile(path));
      } else {
        throw corrupt(installRoot, `managed dependency tree contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  await walk(installRoot);
  return hash.digest("hex");
}

function assertAbsolutePath(path: string, field: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function corrupt(installRoot: string, reason: string): ManagedSrtCorruptError {
  return new ManagedSrtCorruptError(installRoot, reason);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

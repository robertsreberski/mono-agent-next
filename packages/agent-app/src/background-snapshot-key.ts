import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { accountHomeDirectory } from "./account-home.js";
import { deriveLaunchdLabel } from "./launchd.js";

const BACKGROUND_SNAPSHOT_KEY_BYTES = 32;
const execFileAsync = promisify(execFile);

export interface BackgroundSnapshotKeyOptions {
  /** Test seam; production keys always live below the OS account home. */
  readonly homeDir?: string;
}

/**
 * Load the stable owner-only HMAC key for one canonical config, creating it
 * exactly once when a controller first approves a managed snapshot.
 */
export async function loadOrCreateBackgroundSnapshotKey(
  configPath: string,
  options: BackgroundSnapshotKeyOptions = {},
): Promise<Buffer> {
  const keyPath = await backgroundSnapshotKeyPath(configPath, options);
  try {
    return await readBackgroundSnapshotKey(keyPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const key = randomBytes(BACKGROUND_SNAPSHOT_KEY_BYTES);
  let handle;
  let created = false;
  try {
    handle = await open(
      keyPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(key);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      await rm(keyPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (created) {
    try {
      await assertPrivateKeyBeforeRead(keyPath);
    } catch (error) {
      await rm(keyPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return await readBackgroundSnapshotKey(keyPath);
}

/** Load an already-created key. Workers never create a replacement implicitly. */
export async function loadBackgroundSnapshotKey(
  configPath: string,
  options: BackgroundSnapshotKeyOptions = {},
): Promise<Buffer> {
  return await readBackgroundSnapshotKey(await existingBackgroundSnapshotKeyPath(configPath, options));
}

/** Resolve an existing proof key without creating or repairing any ancestor. */
export async function existingBackgroundSnapshotKeyPath(
  configPath: string,
  options: BackgroundSnapshotKeyOptions = {},
): Promise<string> {
  const home = await realpath(resolve(options.homeDir ?? accountHomeDirectory()));
  let root = home;
  for (const segment of [".mono-agent", "background-snapshot-keys"]) {
    root = join(root, segment);
    await verifyOwnerDirectory(root, segment === "background-snapshot-keys");
  }
  return join(root, `${deriveLaunchdLabel(configPath)}.key`);
}

export async function backgroundSnapshotKeyPath(
  configPath: string,
  options: BackgroundSnapshotKeyOptions = {},
): Promise<string> {
  const home = await realpath(resolve(options.homeDir ?? accountHomeDirectory()));
  let root = home;
  for (const segment of [".mono-agent", "background-snapshot-keys"]) {
    root = join(root, segment);
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    await secureOwnerDirectory(root, segment === "background-snapshot-keys");
  }
  return join(root, `${deriveLaunchdLabel(configPath)}.key`);
}

async function readBackgroundSnapshotKey(path: string): Promise<Buffer> {
  const securedIdentity = await assertPrivateKeyBeforeRead(path);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Background snapshot key ${path} must not be a symbolic link.`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    assertOwnerKeyFile(before, path);
    const key = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    assertOwnerKeyFile(afterHandle, path);
    assertOwnerKeyFile(afterPath, path);
    if (
      !sameFilesystemIdentity(securedIdentity, before)
      || !sameFilesystemIdentity(before, afterHandle)
      || !sameFilesystemIdentity(before, afterPath)
    ) {
      throw new Error(`Background snapshot key ${path} changed while it was read.`);
    }
    if (key.length !== BACKGROUND_SNAPSHOT_KEY_BYTES) {
      throw new Error(
        `Background snapshot key ${path} is invalid; remove it while the agent is stopped, then retry.`,
      );
    }
    await verifyNoMacAcl(path, "Background snapshot key");
    return Buffer.from(key);
  } finally {
    await handle.close();
  }
}

async function secureOwnerDirectory(path: string, stripAcl: boolean): Promise<void> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Background snapshot key directory ${path} must be a real directory.`);
  }
  assertCurrentUserOwns(before, path, "Background snapshot key directory");
  await chmod(path, 0o700);
  if (stripAcl) {
    await stripAndVerifyMacAcl(path, "Background snapshot key directory");
  }
  const after = await lstat(path);
  if (!sameFilesystemIdentity(before, after) || !after.isDirectory() || (after.mode & 0o077) !== 0) {
    throw new Error(`Background snapshot key directory ${path} changed while it was secured.`);
  }
  assertCurrentUserOwns(after, path, "Background snapshot key directory");
}

async function verifyOwnerDirectory(path: string, verifyAcl: boolean): Promise<void> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Background snapshot key directory ${path} must be a real directory.`);
  }
  assertCurrentUserOwns(before, path, "Background snapshot key directory");
  if ((before.mode & 0o077) !== 0) {
    throw new Error(`Background snapshot key directory ${path} must be owner-private.`);
  }
  if (verifyAcl) {
    await verifyNoMacAcl(path, "Background snapshot key directory");
  }
  const after = await lstat(path);
  if (!sameFilesystemIdentity(before, after)
    || !after.isDirectory()
    || after.isSymbolicLink()
    || (after.mode & 0o077) !== 0) {
    throw new Error(`Background snapshot key directory ${path} changed while it was verified.`);
  }
  assertCurrentUserOwns(after, path, "Background snapshot key directory");
}

async function assertPrivateKeyBeforeRead(path: string): Promise<Stats> {
  const before = await lstat(path);
  try {
    assertOwnerKeyFile(before, path);
    await verifyNoMacAcl(path, "Background snapshot key");
  } catch (error) {
    throw new Error(
      `${reasonOf(error)} The stable proof key may have been exposed; stop the agent, remove ${path}, and restart to rotate it.`,
    );
  }
  const after = await lstat(path);
  if (!sameFilesystemIdentity(before, after)) {
    throw new Error(`Background snapshot key ${path} changed while its privacy was verified.`);
  }
  assertOwnerKeyFile(after, path);
  return after;
}

function assertOwnerKeyFile(details: Stats, path: string): void {
  assertOwnerKeyStructure(details, path);
  if ((details.mode & 0o777) !== 0o600) {
    throw new Error(`Background snapshot key ${path} must have mode 0600.`);
  }
}

function assertOwnerKeyStructure(details: Stats, path: string): void {
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error(`Background snapshot key ${path} must be one regular non-symbolic-link file.`);
  }
  assertCurrentUserOwns(details, path, "Background snapshot key");
}

async function stripAndVerifyMacAcl(path: string, label: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("/bin/chmod", ["-N", path], { encoding: "utf8" });
  } catch (error) {
    throw new Error(`${label} ${path} ACL could not be removed: ${reasonOf(error)}`);
  }
  await verifyNoMacAcl(path, label);
}

async function verifyNoMacAcl(path: string, label: string): Promise<void> {
  if (process.platform !== "darwin") return;
  let stdout: string;
  try {
    const result = await execFileAsync("/bin/ls", ["-lde", path], { encoding: "utf8" });
    stdout = String(result.stdout);
  } catch (error) {
    throw new Error(`${label} ${path} ACL could not be verified: ${reasonOf(error)}`);
  }
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const mode = lines[0]?.trimStart().split(/\s+/u)[0] ?? "";
  if (mode.includes("+") || lines.slice(1).some((line) => /^\s*\d+:/u.test(line))) {
    throw new Error(`${label} ${path} must not have an access-control list.`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertCurrentUserOwns(details: Stats, path: string, label: string): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} ${path} is not owned by the current user.`);
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException).code === code;
}

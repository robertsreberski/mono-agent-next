import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StateLocalError } from "./errors.js";

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface SecureDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

export interface AtomicReplaceHooks {
  readonly beforeRename?: (target: string) => void | Promise<void>;
  readonly afterRename?: (target: string) => void | Promise<void>;
}

export interface LeaseHooks {
  readonly afterInspect?: (target: string) => void | Promise<void>;
}

export interface ProcessLease {
  readonly identity: FileIdentity;
  readonly path: string;
  verify(): Promise<void>;
  release(): void;
}

export async function ensureSecureDirectory(path: string): Promise<SecureDirectory> {
  if (!isAbsolute(path)) {
    throw new StateLocalError("STATE_PATH_INSECURE", "Secure directory paths must be absolute.");
  }

  const requested = resolve(path);
  const requestedBefore = await lstatOrUndefined(requested);
  if (requestedBefore?.isSymbolicLink()) {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      `Secure state directory ${requested} must not be a symbolic link.`,
    );
  }
  const target = await canonicalizeParent(requested);
  const targetBefore = await lstatOrUndefined(target);
  const root = parse(target).root;
  const parts = target.slice(root.length).split(/[/\\]+/u).filter(Boolean);
  let current = root;

  for (const part of parts) {
    current = join(current, part);
    let info = await lstatOrUndefined(current);
    if (info === undefined) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      info = await lstatOrUndefined(current);
    }
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
      throw new StateLocalError(
        "STATE_PATH_INSECURE",
        `State path component ${current} must be a real directory, not a link.`,
      );
    }
  }

  if (targetBefore === undefined) await chmod(target, 0o700);
  const info = await lstat(target);
  verifyDirectory(info, target);
  return { path: target, identity: identityOf(info) };
}

export async function inspectSecureFile(path: string): Promise<FileIdentity | undefined> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) return undefined;
  verifyFile(info, path);
  return identityOf(info);
}

export async function verifySecureDirectoryIdentity(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) {
    throw new StateLocalError("STATE_PATH_CHANGED", `Secure directory ${path} disappeared.`);
  }
  verifyDirectory(info, path);
  assertSameIdentity(identityOf(info), expected, path);
}

export async function verifySecureFileIdentity(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) {
    throw new StateLocalError("STATE_PATH_CHANGED", `Secure file ${path} disappeared.`);
  }
  verifyFile(info, path);
  assertSameIdentity(identityOf(info), expected, path);
}

export async function readSecureFile(
  path: string,
  maximumBytes: number,
): Promise<{ readonly bytes: Buffer; readonly identity: FileIdentity }> {
  const handle = await openNoFollow(path, constants.O_RDONLY, 0o600);
  try {
    const before = await handle.stat();
    verifyFile(before, path);
    if (before.size > maximumBytes) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `State file ${path} exceeds its configured size bound.`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSameIdentity(identityOf(after), identityOf(before), path);
    const current = await lstat(path);
    verifyFile(current, path);
    assertSameIdentity(identityOf(current), identityOf(before), path);
    return { bytes, identity: identityOf(before) };
  } catch (error) {
    if (error instanceof StateLocalError) throw error;
    throw new StateLocalError("STATE_CORRUPT", `Could not safely read state file ${path}.`, error);
  } finally {
    await handle.close();
  }
}

export async function createSecureFile(path: string, bytes: Uint8Array): Promise<FileIdentity> {
  const handle = await openNoFollow(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await lstat(path);
  verifyFile(info, path);
  return identityOf(info);
}

export async function replaceSecureFileAtomic(
  target: string,
  bytes: Uint8Array,
  hooks: AtomicReplaceHooks = {},
): Promise<FileIdentity> {
  const parent = dirname(target);
  const parentInfo = await lstat(parent);
  verifyDirectory(parentInfo, parent);
  const parentIdentity = identityOf(parentInfo);
  const expected = await inspectSecureFile(target);
  const temp = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await openNoFollow(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let closed = false;
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;

    await hooks.beforeRename?.(target);
    await verifySecureDirectoryIdentity(parent, parentIdentity);
    const current = await inspectSecureFile(target);
    if (!sameOptionalIdentity(current, expected)) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `State target ${target} changed before atomic replacement.`,
      );
    }

    await rename(temp, target);
    renamed = true;
    const committed = await inspectSecureFile(target);
    if (committed === undefined) {
      throw new StateLocalError("STATE_PATH_CHANGED", `State target ${target} disappeared after rename.`);
    }
    await hooks.afterRename?.(target);
    await verifySecureDirectoryIdentity(parent, parentIdentity);
    await verifySecureFileIdentity(target, committed);
    await syncDirectory(parent);
    return committed;
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function acquireProcessLease(
  path: string,
  hooks: LeaseHooks = {},
): Promise<ProcessLease> {
  let identity = await inspectSecureFile(path);
  if (identity === undefined) {
    try {
      identity = await createSecureFile(path, new Uint8Array());
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      identity = await inspectSecureFile(path);
    }
  }
  if (identity === undefined) {
    throw new StateLocalError("STATE_PATH_CHANGED", `Lease file ${path} could not be established.`);
  }

  await hooks.afterInspect?.(path);
  let database: DatabaseSync | undefined;
  let locked = false;
  try {
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
    locked = true;
    await verifySecureFileIdentity(path, identity);
  } catch (error) {
    database?.close();
    if (error instanceof StateLocalError) throw error;
    if (isSqliteBusy(error)) {
      throw new StateLocalError(
        "STATE_ALREADY_OPEN",
        "This state directory already has a live writer.",
        error,
      );
    }
    throw new StateLocalError("STATE_CORRUPT", "The local state process lease is corrupt.", error);
  }

  const acquired = database;
  if (acquired === undefined) {
    throw new StateLocalError("STATE_CORRUPT", "The local state process lease could not be opened.");
  }

  let released = false;
  return {
    identity,
    path,
    verify: async () => {
      if (released || !locked) {
        throw new StateLocalError("STATE_CLOSED", "The state process lease is no longer held.");
      }
      await verifySecureFileIdentity(path, identity);
    },
    release: () => {
      if (released) return;
      released = true;
      try {
        acquired.exec("ROLLBACK");
      } finally {
        acquired.close();
      }
    },
  };
}

async function syncDirectory(path: string): Promise<void> {
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function openNoFollow(path: string, flags: number, mode: number) {
  return open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
}

function verifyDirectory(info: Stats, path: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      `Secure state directory ${path} must be a real directory.`,
    );
  }
  verifyOwnerAndMode(info, 0o700, path);
}

function verifyFile(info: Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      `Secure state file ${path} must be a single-link regular file.`,
    );
  }
  verifyOwnerAndMode(info, 0o600, path);
}

function verifyOwnerAndMode(info: Stats, expectedMode: number, path: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new StateLocalError("STATE_PATH_INSECURE", `Secure state path ${path} has another owner.`);
  }
  if ((info.mode & 0o777) !== expectedMode) {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      `Secure state path ${path} must use mode ${expectedMode.toString(8)}.`,
    );
  }
}

function identityOf(info: Stats): FileIdentity {
  return { device: info.dev, inode: info.ino };
}

function assertSameIdentity(actual: FileIdentity, expected: FileIdentity, path: string): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new StateLocalError("STATE_PATH_CHANGED", `Secure state path ${path} changed identity.`);
  }
}

function sameOptionalIdentity(
  left: FileIdentity | undefined,
  right: FileIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.device === right.device && left.inode === right.inode;
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function canonicalizeParent(target: string): Promise<string> {
  const finalName = basename(target);
  let probe = dirname(target);
  const missing: string[] = [];
  while ((await lstatOrUndefined(probe)) === undefined) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  const canonicalParent = await realpath(probe);
  return join(canonicalParent, ...missing, finalName);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:busy|locked)/iu.test(error.message);
}

import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  type FileHandle,
  realpath,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MemoryLocalError } from "./errors.js";

export interface FileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly links: number;
  readonly owner: number;
  readonly size: number;
}

export interface SecureRoot {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export async function openSecureRoot(authoredPath: string): Promise<SecureRoot> {
  requirePosixOwnership();
  const root = resolve(authoredPath);
  const missing: string[] = [];
  let cursor = root;
  let existing: Stats | undefined;
  while (existing === undefined) {
    existing = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) {
      const parent = dirname(cursor);
      if (parent === cursor) unsafe("No canonical parent exists for the memory directory.");
      missing.unshift(cursor);
      cursor = parent;
    }
  }
  assertDirectory(existing, cursor, false);
  if (await realpath(cursor) !== cursor) unsafe("Memory directory ancestors must not traverse symlinks.");

  for (const path of missing) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const created = await lstat(path);
    assertDirectory(created, path, true);
    if (await realpath(path) !== path) unsafe("Memory directory creation crossed a symlink.");
  }

  const stat = await lstat(root);
  assertDirectory(stat, root, true);
  if (await realpath(root) !== root) unsafe("Memory directory must be a canonical non-symlink path.");
  const handle = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertDirectory(opened, root, true);
    if (!sameIdentity(stat, opened)) unsafe("Memory directory changed while opening.");
    return { path: root, handle, identity: identity(opened) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function verifySecureRoot(root: SecureRoot): Promise<void> {
  const pathStat = await lstat(root.path).catch(() => unsafe("Memory directory disappeared."));
  const openStat = await root.handle.stat();
  assertDirectory(pathStat, root.path, true);
  assertDirectory(openStat, root.path, true);
  if (!sameIdentity(pathStat, openStat) || !sameRootIdentity(root.identity, identity(openStat))) {
    unsafe("Memory directory identity changed after opening.");
  }
}

export async function inspectSecureFile(
  path: string,
  expectedMode = 0o600,
): Promise<FileIdentity> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) unsafe("Required memory store file is missing.");
  assertFile(before, path, expectedMode);
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertFile(opened, path, expectedMode);
    if (!sameIdentity(before, opened)) unsafe("Memory store file changed while opening.");
    const after = await lstat(path);
    assertFile(after, path, expectedMode);
    if (!sameIdentity(opened, after)) unsafe("Memory store file changed while inspecting.");
    return identity(opened);
  } finally {
    await handle.close();
  }
}

export async function readSecureFile(path: string, maxBytes: number): Promise<{
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) unsafe("Required memory store file is missing.");
  assertFile(before, path, 0o600);
  if (before.size > maxBytes) unsafe("Memory marker exceeds its byte limit.");
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertFile(opened, path, 0o600);
    if (!sameIdentity(before, opened)) unsafe("Memory store file changed while opening.");
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) unsafe("Memory marker exceeds its byte limit.");
    const after = await lstat(path);
    assertFile(after, path, 0o600);
    if (!sameIdentity(opened, after)) unsafe("Memory store file changed while reading.");
    return { bytes, identity: identity(opened) };
  } finally {
    await handle.close();
  }
}

export async function createSecureFile(path: string): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      unsafe("A memory initialization file appeared concurrently.");
    }
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.links === right.links
    && left.owner === right.owner;
}

function sameRootIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.owner === right.owner;
}

export function identity(stat: Stats): FileIdentity {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: stat.mode & 0o7777,
    links: stat.nlink,
    owner: stat.uid,
    size: stat.size,
  });
}

function assertDirectory(stat: Stats, path: string, privateRoot: boolean): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe(`Memory path is not a regular directory: ${path}`);
  const uid = currentUid();
  if (stat.uid !== uid) unsafe("Memory directory is not owned by the current user.");
  const mode = stat.mode & 0o777;
  if (privateRoot ? mode !== 0o700 : (mode & 0o022) !== 0) {
    unsafe(privateRoot
      ? "Memory directory mode must be exactly 0700."
      : "Memory directory ancestor must not be group/world writable.");
  }
}

function assertFile(stat: Stats, path: string, expectedMode: number): void {
  if (!stat.isFile() || stat.isSymbolicLink()) unsafe(`Memory store path is not a regular file: ${path}`);
  if (stat.uid !== currentUid()) unsafe("Memory store files must be owned by the current user.");
  if ((stat.mode & 0o777) !== expectedMode) unsafe(`Memory store file mode must be exactly ${expectedMode.toString(8)}.`);
  if (stat.nlink !== 1) unsafe("Memory store files must have exactly one hard link.");
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requirePosixOwnership(): void {
  if (typeof process.getuid !== "function") unsafe("memory-local requires POSIX ownership checks.");
}

function currentUid(): number {
  if (typeof process.getuid !== "function") unsafe("memory-local requires POSIX ownership checks.");
  return process.getuid();
}

function unsafe(message: string): never {
  throw new MemoryLocalError("unsafe_store", message);
}

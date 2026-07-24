import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { MemoryLocalError } from "./errors.js";
import {
  createSecureFile,
  identity,
  pathExists,
  sameFileIdentity,
  syncDirectory,
  type BoundSecureDatabaseFile,
  type FileIdentity,
  type SecureRoot,
} from "./security.js";
import {
  MEMORY_LOCAL_MARKER_FILENAME,
} from "./store.js";
import { MEMORY_LOCAL_WRITER_LEASE_FILENAME } from "./writer-lease.js";

export const MAX_TREE_ENTRIES = 100_000;
export const MAX_TREE_BYTES = 64 * 1024 * 1024 * 1024;
export const COPY_BUFFER_BYTES = 1024 * 1024;
export const SQLITE_SIDECARS = ["-journal", "-shm", "-wal"] as const;

const TRANSIENT_V0_PATHS = new Set([
  ".index/runtime.json",
  ".index/writer.lock",
]);

export interface MemoryLocalMigrationTestHooks {
  readonly beforeSnapshotTargetCreate?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotTargetOpen?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotTargetCleanupRename?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotTargetCleanupParentSync?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotFailureCleanupRename?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotFailureCleanupParentSync?: (
    targetRoot: string,
  ) => void | Promise<void>;
  readonly beforeSnapshotSourceRecheck?: (
    sourceRoot: string,
    targetRoot: string,
  ) => void | Promise<void>;
  readonly afterSnapshotDirectorySync?: (
    targetDirectory: string,
  ) => void | Promise<void>;
  readonly beforeAdoptionDatabaseBind?: (path: string) => void | Promise<void>;
  readonly beforeAdoptionCommit?: (path: string) => void | Promise<void>;
}

export interface ProtectedSourceRoot {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

export interface BoundAdoptionTree {
  readonly databaseRelativePath: string;
  readonly bindingRelativePath: string;
  readonly authorityRelativePath: string;
  readonly database: BoundSecureDatabaseFile;
}

export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const before = await lstat(path, { bigint: true });
  assertTargetFile(before);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableIdentity(before, opened)) {
      throw migrationFailure("Snapshot file changed while opening for hashing.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < Number(opened.size)) {
      if (signal !== undefined) throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, Number(opened.size) - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset !== Number(opened.size)) {
      throw migrationFailure("Snapshot file changed size while hashing.");
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameStableIdentity(opened, after) || !sameStableIdentity(after, current)) {
      throw migrationFailure("Snapshot file changed while hashing.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function openProtectedSourceRoot(path: string): Promise<ProtectedSourceRoot> {
  const before = await lstat(path);
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || before.uid !== currentUid()
    || (before.mode & 0o022) !== 0
    || await realpath(path) !== path
  ) {
    throw migrationFailure(
      "Migration source root must be canonical, user-owned, and not group/world writable.",
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== currentUid()
      || (opened.mode & 0o022) !== 0
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw migrationFailure("Migration source root changed while opening.");
    }
    return Object.freeze({ path, handle, identity: identity(opened) });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function verifyProtectedSourceRoot(root: ProtectedSourceRoot): Promise<void> {
  const pathStats = await lstat(root.path);
  const descriptorStats = await root.handle.stat();
  if (
    !pathStats.isDirectory()
    || pathStats.isSymbolicLink()
    || pathStats.uid !== currentUid()
    || (pathStats.mode & 0o022) !== 0
    || !descriptorStats.isDirectory()
    || descriptorStats.uid !== currentUid()
    || (descriptorStats.mode & 0o022) !== 0
    || !sameFileIdentity(identity(pathStats), root.identity)
    || !sameFileIdentity(identity(descriptorStats), root.identity)
  ) {
    throw migrationFailure("Migration source root identity changed.");
  }
}

export async function createPrivateTargetRoot(
  path: string,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<SecureRoot> {
  const parent = dirname(path);
  const parentReal = await realpath(parent).catch(() => undefined);
  if (parentReal !== parent) {
    throw migrationFailure("Snapshot target parent must be an existing canonical directory.");
  }
  const parentStats = await lstat(parent);
  if (
    !parentStats.isDirectory()
    || parentStats.isSymbolicLink()
    || (parentStats.mode & 0o022) !== 0
  ) {
    throw migrationFailure("Snapshot target parent is not protected.");
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw migrationFailure("Snapshot target must not already exist.");
    }
    throw error;
  }
  let observed: BigIntStats | undefined;
  let handle: FileHandle | undefined;
  let target: SecureRoot | undefined;
  try {
    observed = await lstat(path, { bigint: true });
    assertFreshSnapshotTarget(observed);
    // Portable Node does not expose mkdir-with-fd or openat. Within this
    // owner-private migration boundary, a same-UID swap before the first
    // observation is excluded because that principal can already inspect and
    // mutate this process's private data. From this observation onward, bind
    // and recheck the exact directory identity before copying.
    await hooks.beforeSnapshotTargetOpen?.(path);
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameObservedSnapshotDirectory(observed, opened)) {
      throw migrationFailure("Snapshot target identity changed while binding its created directory.");
    }
    target = Object.freeze({
      path,
      handle,
      identity: snapshotDirectoryIdentity(opened),
    });
    await assertPinnedSnapshotDirectory(path, target.identity, target);
    return target;
  } catch (error) {
    let removed = false;
    try {
      removed = observed !== undefined
        && await removeObservedEmptySnapshotTarget(path, observed, target, hooks);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (!removed) {
      throw migrationFailure(
        "Snapshot target identity changed during creation; preserving it as unusable.",
      );
    }
    throw error;
  }
}

async function removeObservedEmptySnapshotTarget(
  path: string,
  expected: BigIntStats,
  pinned: SecureRoot | undefined,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<boolean> {
  const current = await lstat(path, { bigint: true }).catch(() => undefined);
  if (
    current === undefined
    || !sameObservedSnapshotDirectory(expected, current)
    || (await readdir(path).catch(() => ["unsafe"])).length !== 0
  ) {
    return false;
  }
  const quarantine = join(
    dirname(path),
    `.${basename(path)}.snapshot-creation-cleanup-${randomUUID()}`,
  );
  let moved = false;
  try {
    if (pinned !== undefined) {
      await assertPinnedSnapshotDirectory(path, pinned.identity, pinned);
    }
    await hooks.beforeSnapshotTargetCleanupRename?.(path);
    await rename(path, quarantine);
    moved = true;
    const movedStats = await lstat(quarantine, { bigint: true });
    if (
      !sameObservedSnapshotDirectoryObject(expected, movedStats)
      || (await readdir(quarantine)).length !== 0
    ) {
      await restoreQuarantinedSnapshotTarget(path, quarantine);
      return false;
    }
    if (pinned !== undefined) {
      try {
        await assertPinnedSnapshotDirectory(quarantine, pinned.identity, pinned);
      } catch {
        await restoreQuarantinedSnapshotTarget(path, quarantine);
        return false;
      }
    }
    await rmdir(quarantine);
    moved = false;
  } catch {
    if (moved) await restoreQuarantinedSnapshotTarget(path, quarantine);
    return false;
  }
  try {
    await hooks.beforeSnapshotTargetCleanupParentSync?.(path);
    await syncDirectory(dirname(path));
  } catch {
    throw migrationFailure(
      "Snapshot target was removed, but parent-directory durability could not be confirmed.",
    );
  }
  return true;
}

async function restoreQuarantinedSnapshotTarget(
  path: string,
  quarantine: string,
): Promise<void> {
  const occupied = await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isErrno(error, "ENOENT")) return false;
      return true;
    },
  );
  if (occupied) return;
  // Portable Node has no no-replace directory rename. This best-effort restore
  // avoids overwriting an observed pathname; the remaining same-UID race is the
  // same explicitly excluded threat boundary as target creation.
  try {
    await rename(quarantine, path);
    await syncDirectory(dirname(path));
  } catch {
    // Restored or quarantined ambiguous data remains for operator remediation.
  }
}

export async function cleanupFailedSnapshotTarget(
  path: string,
  expected: FileIdentity,
  pinned: SecureRoot | undefined,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<void> {
  if (pinned === undefined) {
    throw migrationFailure(
      "Failed snapshot target identity changed; preserving it as unusable.",
    );
  }
  const quarantine = join(
    dirname(path),
    `.${basename(path)}.snapshot-cleanup-${randomUUID()}`,
  );
  try {
    await assertPinnedSnapshotDirectory(path, expected, pinned);
  } catch {
    throw migrationFailure(
      "Failed snapshot target identity changed; preserving it as unusable.",
    );
  }
  let moved = false;
  try {
    await hooks.beforeSnapshotFailureCleanupRename?.(path);
    await rename(path, quarantine);
    moved = true;
    await assertPinnedSnapshotDirectory(quarantine, expected, pinned);
    await rm(quarantine, { recursive: true });
    moved = false;
  } catch {
    if (moved) await restoreQuarantinedSnapshotTarget(path, quarantine);
    throw migrationFailure(
      "Failed snapshot target could not be safely removed and remains unusable.",
    );
  }
  try {
    await hooks.beforeSnapshotFailureCleanupParentSync?.(path);
    await syncDirectory(dirname(path));
  } catch {
    throw migrationFailure(
      "Failed snapshot target was removed, but parent-directory durability could not be confirmed.",
    );
  }
}

function assertFreshSnapshotTarget(stats: BigIntStats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw migrationFailure("Exclusively created snapshot target is not owner-private.");
  }
}

function sameObservedSnapshotDirectory(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return sameObservedSnapshotDirectoryObject(left, right)
    && left.ctimeNs === right.ctimeNs;
}

function sameObservedSnapshotDirectoryObject(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function snapshotDirectoryIdentity(stats: BigIntStats): FileIdentity {
  return Object.freeze({
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: Number(stats.mode & 0o7777n),
    links: Number(stats.nlink),
    owner: Number(stats.uid),
    size: Number(stats.size),
  });
}

async function assertPinnedSnapshotDirectory(
  path: string,
  expected: FileIdentity,
  pinned: SecureRoot,
): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  const descriptor = await pinned.handle.stat().catch(() => undefined);
  if (
    current === undefined
    || descriptor === undefined
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !descriptor.isDirectory()
    || String(current.dev) !== expected.device
    || String(current.ino) !== expected.inode
    || String(descriptor.dev) !== expected.device
    || String(descriptor.ino) !== expected.inode
    || current.uid !== expected.owner
    || descriptor.uid !== expected.owner
    || (current.mode & 0o777) !== 0o700
    || (descriptor.mode & 0o777) !== 0o700
  ) {
    throw migrationFailure("Snapshot target directory identity changed.");
  }
}

export async function syncSnapshotDirectory(
  path: string,
  hooks: MemoryLocalMigrationTestHooks,
): Promise<void> {
  await syncDirectory(path);
  await hooks.afterSnapshotDirectorySync?.(path);
}

export async function createPrivateFile(path: string): Promise<void> {
  const handle = await createSecureFile(path);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertBoundedActiveDatabase(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_TREE_BYTES) {
    throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
  }
}

export async function sourceDatabaseFootprint(path: string): Promise<number> {
  let bytes = 0;
  for (const suffix of ["", ...SQLITE_SIDECARS]) {
    const sidecarPath = `${path}${suffix}`;
    const stats = await lstat(sidecarPath, { bigint: true }).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (stats === undefined) continue;
    assertBoundedActiveDatabase(Number(stats.size));
    assertSourceFile(sidecarPath, stats);
    bytes += Number(stats.size);
    assertBoundedActiveDatabase(bytes);
  }
  return bytes;
}

export function logicalDatabaseBytes(database: DatabaseSync): number {
  const pageCount = pragmaInteger(database, "page_count");
  const pageSize = pragmaInteger(database, "page_size");
  const bytes = pageCount * pageSize;
  if (pageCount < 1n || pageSize < 1n || bytes > BigInt(MAX_TREE_BYTES)) {
    throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
  }
  return Number(bytes);
}

function pragmaInteger(database: DatabaseSync, name: "page_count" | "page_size"): bigint {
  const row = database.prepare(`PRAGMA ${name}`).get() as
    | Record<string, number | bigint>
    | undefined;
  const value = row?.[name];
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value))
    && typeof value !== "bigint"
  ) {
    throw migrationFailure("Memory database size metadata is invalid.");
  }
  return BigInt(value);
}

export async function inspectSourceFile(path: string, exactPrivate = false): Promise<FileIdentity> {
  const stats = await lstat(path);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== currentUid()
    || stats.nlink !== 1
    || (exactPrivate ? (stats.mode & 0o777) !== 0o600 : (stats.mode & 0o022) !== 0)
  ) {
    throw migrationFailure("Migration source contains an unsafe file.");
  }
  return identity(stats);
}

export async function assertDistinctTarget(
  source: { readonly path: string; readonly identity: FileIdentity },
  targetPath: string,
): Promise<void> {
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing === undefined) return;
  if (
    String(existing.dev) === source.identity.device
    && String(existing.ino) === source.identity.inode
  ) {
    throw migrationFailure("Snapshot target aliases the source root.");
  }
  throw migrationFailure("Snapshot target must not already exist.");
}

export async function rejectAdoptionTransients(root: string): Promise<void> {
  const paths = [
    ...TRANSIENT_V0_PATHS,
    MEMORY_LOCAL_WRITER_LEASE_FILENAME,
  ];
  for (const relativePath of paths) {
    if (await pathExists(join(root, relativePath))) {
      throw migrationFailure("Adoption target contains transient writer state.");
    }
  }
}

export function skipSnapshotPath(path: string, activeDatabase: string): boolean {
  if (
    path === activeDatabase
    || path === MEMORY_LOCAL_MARKER_FILENAME
    || TRANSIENT_V0_PATHS.has(path)
    || path === MEMORY_LOCAL_WRITER_LEASE_FILENAME
  ) {
    return true;
  }
  return SQLITE_SIDECARS.some((suffix) =>
    path.endsWith(`.db${suffix}`)
    || path === `${MEMORY_LOCAL_WRITER_LEASE_FILENAME}${suffix}`);
}

export function skipDigestPath(path: string, bound?: BoundAdoptionTree): boolean {
  if (
    bound !== undefined
    && (
      path === bound.bindingRelativePath
      || path === bound.authorityRelativePath
    )
  ) {
    return true;
  }
  return path === MEMORY_LOCAL_MARKER_FILENAME
    || path === MEMORY_LOCAL_WRITER_LEASE_FILENAME;
}

export function assertSourceDirectory(_path: string, stats: BigIntStats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || (stats.mode & 0o022n) !== 0n
  ) {
    throw migrationFailure("Snapshot source contains an unsafe directory.");
  }
}

export function assertSourceFile(_path: string, stats: BigIntStats): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || stats.nlink !== 1n
    || (stats.mode & 0o022n) !== 0n
    || stats.size > BigInt(MAX_TREE_BYTES)
  ) {
    throw migrationFailure("Snapshot source contains an unsafe file.");
  }
}

export function assertTargetDirectory(stats: BigIntStats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(currentUid())
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw migrationFailure("Snapshot target contains an unsafe directory.");
  }
}

export function assertTargetFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw migrationFailure("Snapshot target contains a non-regular file.");
  }
  if (stats.uid !== BigInt(currentUid())) {
    throw migrationFailure("Snapshot target contains a file owned by another user.");
  }
  if (stats.nlink !== 1n) {
    throw migrationFailure("Snapshot target contains a hard-linked file.");
  }
  if ((stats.mode & 0o777n) !== 0o600n) {
    throw migrationFailure("Snapshot target contains a file with unsafe permissions.");
  }
  if (stats.size > BigInt(MAX_TREE_BYTES)) {
    throw migrationFailure("Snapshot target contains an oversized file.");
  }
}

export function sameRoot(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameMutableFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.links === right.links
    && left.owner === right.owner;
}

export function pathsOverlap(left: string, right: string): boolean {
  return isNested(left, right) || isNested(right, left);
}

function isNested(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ""
    && path !== ".."
    && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(path);
}

export function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

export function sameStableDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

export function comparePathNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function absolutePath(value: string, field: string): string {
  const canonical = typeof value === "string" ? resolve(value) : "";
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || value.includes("\0")
    || value !== value.trim()
    || value !== canonical
  ) {
    throw migrationFailure(`${field} must be an absolute canonical path.`);
  }
  return canonical;
}

export function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw migrationFailure("Memory migration requires POSIX ownership checks.");
  }
  return uid;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export function migrationFailure(message: string): MemoryLocalError {
  return new MemoryLocalError("maintenance_failed", message);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { readonly code?: unknown }).code === code;
}

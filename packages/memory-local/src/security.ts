// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

export interface PinnedSecureFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface BoundSecureDatabaseFile extends PinnedSecureFile {
  /** Stable package-owned pathname supplied to SQLite while the store is open. */
  readonly openPath: string;
  /** Exact package-owned directory that authorizes this reserved binding. */
  readonly authorityPath: string;
  /** Existing binding plus exact authority permits validated WAL recovery. */
  readonly recovering: boolean;
}

export interface SecureSqliteSidecars {
  /**
   * Admit sidecars created by one immediately preceding trusted SQLite call,
   * while retaining descriptor identity for every admitted pathname.
   */
  captureNew(): Promise<void>;
  /** Fail when an admitted sidecar changes or a new pathname appears. */
  verify(): Promise<void>;
  /**
   * Preserve unexpected pathnames and descriptor-backed originals before
   * DatabaseSync.close() is allowed to unlink SQLite sidecar names.
   */
  prepareForDatabaseClose(): Promise<MemoryLocalError | undefined>;
  close(): Promise<void>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SQLITE_BINDING_SUFFIX = ".sqlite-binding";
const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

type SqliteSidecarSuffix = typeof SQLITE_SIDECAR_SUFFIXES[number];

interface PinnedSqliteSidecar {
  readonly path: string;
  readonly suffix: SqliteSidecarSuffix;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

interface PinnedSecureDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
  verify(): Promise<void>;
  close(): Promise<void>;
}

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

export async function openPinnedSecureFile(
  path: string,
  flags = constants.O_RDONLY,
  expectedMode = 0o600,
  expectedLinks = 1,
): Promise<PinnedSecureFile> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) unsafe("Required memory store file is missing.");
  assertFile(before, path, expectedMode, expectedLinks);
  const handle = await open(path, flags | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertFile(opened, path, expectedMode, expectedLinks);
    if (!sameIdentity(before, opened)) unsafe("Memory store file changed while opening.");
    const expected = identity(opened);
    const verify = async (): Promise<void> => {
      const descriptor = await handle.stat();
      assertFile(descriptor, path, expectedMode, expectedLinks);
      if (!sameFileIdentity(expected, identity(descriptor))) {
        unsafe("Pinned memory store descriptor identity changed.");
      }
      const current = await lstat(path).catch(() => unsafe("Pinned memory store path disappeared."));
      assertFile(current, path, expectedMode, expectedLinks);
      if (!sameIdentity(descriptor, current)) unsafe("Pinned memory store pathname identity changed.");
    };
    await verify();
    let closed = false;
    return {
      path,
      handle,
      identity: expected,
      verify: async () => {
        if (closed) unsafe("Pinned memory store descriptor is closed.");
        await verify();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Give path-only SQLite a stable, verified inode authority.
 *
 * The second owner-private hard link is a reserved package binding. It also
 * gives a restarted writer the exact pathname needed to recover a committed
 * WAL after a process crash. Pre-existing links are accepted only when the
 * canonical path and reserved binding prove the same two-link inode.
 */
export async function bindSecureDatabaseFile(
  path: string,
  beforeLink?: () => void | Promise<void>,
): Promise<BoundSecureDatabaseFile> {
  const bindingPath = join(dirname(path), `.${basename(path)}${SQLITE_BINDING_SUFFIX}`);
  const observed = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (observed === undefined) unsafe("Required memory store file is missing.");
  assertFileShape(observed, path, 0o600);
  const expected = identity(observed);
  const authorityPath = bindingAuthorityPath(bindingPath, expected);
  const existingBinding = await lstat(bindingPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let initial: PinnedSecureFile | undefined;
  let authority: PinnedSecureDirectory | undefined;
  let createdBinding: FileIdentity | undefined;
  let createdAuthority = false;
  let canonical: PinnedSecureFile | undefined;
  let binding: PinnedSecureFile | undefined;
  let beforeLinkCalled = false;
  try {
    if (existingBinding === undefined) {
      if (observed.nlink !== 1) unsafe("Memory database has an unrecognized hard link.");
      initial = await openPinnedSecureFile(path);
      const openedAuthority = await openBindingAuthority(authorityPath, true);
      authority = openedAuthority.directory;
      createdAuthority = openedAuthority.created;
      await initial.verify();
      await beforeLink?.();
      beforeLinkCalled = true;
      try {
        await link(path, bindingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          unsafe("Memory database binding appeared concurrently.");
        }
        throw error;
      }
      createdBinding = identity(await lstat(bindingPath));
      await syncDirectory(dirname(path));
    } else {
      assertFile(existingBinding, bindingPath, 0o600, 2);
      if (observed.nlink !== 2 || !sameIdentity(observed, existingBinding)) {
        unsafe("Memory database has an unrecognized hard link.");
      }
      authority = (await openBindingAuthority(authorityPath, false)).directory;
    }

    canonical = await openPinnedSecureFile(path, constants.O_RDONLY, 0o600, 2);
    binding = await openPinnedSecureFile(bindingPath, constants.O_RDONLY, 0o600, 2);
    if (
      !sameFileObjectIdentity(expected, canonical.identity)
      || !sameFileIdentity(canonical.identity, binding.identity)
    ) {
      unsafe("Memory database identity changed while binding SQLite.");
    }
    await initial?.close();
    initial = undefined;
    if (!beforeLinkCalled) await beforeLink?.();
    let closed = false;
    const verify = async (): Promise<void> => {
      if (closed) unsafe("Bound memory database descriptor is closed.");
      await canonical!.verify();
      await binding!.verify();
      await authority!.verify();
      if (!sameFileIdentity(canonical!.identity, binding!.identity)) {
        unsafe("Memory database binding identity changed.");
      }
    };
    await verify();
    return {
      path,
      openPath: bindingPath,
      authorityPath,
      recovering: existingBinding !== undefined,
      handle: canonical.handle,
      identity: canonical.identity,
      verify,
      close: async () => {
        if (closed) return;
        closed = true;
        await binding!.close();
        await canonical!.close();
        await authority!.close();
        const current = await lstat(path).catch(() => undefined);
        const bound = await lstat(bindingPath).catch(() => undefined);
        if (current === undefined || bound === undefined) return;
        try {
          assertFile(current, path, 0o600, 2);
          assertFile(bound, bindingPath, 0o600, 2);
        } catch {
          // Preserve every ambiguous pathname for operator inspection.
          return;
        }
        if (!sameIdentity(current, bound)
          || !sameFileIdentity(identity(current), canonical!.identity)) return;
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          if (await pathExists(`${bindingPath}${suffix}`)) return;
        }
        const authorityCurrent = await lstat(authorityPath).catch(() => undefined);
        if (
          authorityCurrent === undefined
          || !sameFileIdentity(identity(authorityCurrent), authority!.identity)
        ) return;
        await unlink(bindingPath);
        await syncDirectory(dirname(path));
        await rmdir(authorityPath);
        await syncDirectory(dirname(path));
        await inspectSecureFile(path);
      },
    };
  } catch (error) {
    await binding?.close().catch(() => undefined);
    await canonical?.close().catch(() => undefined);
    await initial?.close().catch(() => undefined);
    await authority?.close().catch(() => undefined);
    await unlinkCreatedFile(bindingPath, createdBinding);
    await syncDirectory(dirname(path)).catch(() => undefined);
    if (createdAuthority) {
      await removeCreatedDirectory(authorityPath, authority?.identity);
    }
    await syncDirectory(dirname(path)).catch(() => undefined);
    throw error;
  }
}

export async function verifySecureSqliteSidecars(
  databasePath: string,
  allowRecovery: boolean,
): Promise<void> {
  const sidecars = await openSecureSqliteSidecars(databasePath, allowRecovery);
  await sidecars.close();
}

/**
 * Pin every accepted SQLite recovery file across the complete DatabaseSync
 * lifetime. SQLite's API accepts only a pathname and may unlink that pathname
 * during close, so a shape-only recheck is insufficient: an exact-byte,
 * single-link replacement must never be mistaken for the admitted inode.
 */
export async function openSecureSqliteSidecars(
  databasePath: string,
  allowRecovery: boolean,
): Promise<SecureSqliteSidecars> {
  const pinned = new Map<SqliteSidecarSuffix, PinnedSqliteSidecar>();
  let closed = false;

  await rejectSqliteSidecarQuarantines(databasePath);
  try {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const path = `${databasePath}${suffix}`;
      if (!(await pathExists(path))) continue;
      if (!allowRecovery) {
        unsafe("Memory database has SQLite recovery state without binding authority.");
      }
      pinned.set(suffix, await openPinnedSqliteSidecar(path, suffix));
    }

    const verify = async (allowNew: boolean): Promise<void> => {
      if (closed) unsafe("Memory database SQLite sidecar descriptors are closed.");
      await rejectSqliteSidecarQuarantines(databasePath);
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        const expected = pinned.get(suffix);
        const path = `${databasePath}${suffix}`;
        if (expected !== undefined) {
          await verifyPinnedSqliteSidecar(expected);
          continue;
        }
        if (!(await pathExists(path))) continue;
        if (!allowNew) {
          unsafe(`Memory database SQLite sidecar ${suffix} appeared outside a trusted SQLite operation.`);
        }
        pinned.set(suffix, await openPinnedSqliteSidecar(path, suffix));
      }
    };

    await verify(false);
    return {
      captureNew: async () => await verify(true),
      verify: async () => await verify(false),
      prepareForDatabaseClose: async () => {
        if (closed) unsafe("Memory database SQLite sidecar descriptors are closed.");
        return await preserveDriftedSqliteSidecars(databasePath, pinned);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([...pinned.values()].map(async (sidecar) => {
          await sidecar.handle.close();
        }));
      },
    };
  } catch (error) {
    closed = true;
    await Promise.allSettled([...pinned.values()].map(async (sidecar) => {
      await sidecar.handle.close();
    }));
    throw error;
  }
}

async function openPinnedSqliteSidecar(
  path: string,
  suffix: SqliteSidecarSuffix,
): Promise<PinnedSqliteSidecar> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) unsafe("Memory database SQLite sidecar disappeared while opening.");
  assertSqliteSidecar(before, path, suffix);
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertSqliteSidecar(opened, path, suffix);
    if (!sameIdentity(before, opened)) {
      unsafe("Memory database SQLite sidecar changed while opening.");
    }
    const pinned = Object.freeze({
      path,
      suffix,
      handle,
      identity: identity(opened),
    });
    await verifyPinnedSqliteSidecar(pinned);
    return pinned;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyPinnedSqliteSidecar(sidecar: PinnedSqliteSidecar): Promise<void> {
  const descriptor = await sidecar.handle.stat();
  assertSqliteSidecar(descriptor, sidecar.path, sidecar.suffix);
  if (!sameFileObjectIdentity(sidecar.identity, identity(descriptor))) {
    unsafe("Pinned memory database SQLite sidecar descriptor identity changed.");
  }
  const current = await lstat(sidecar.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined) {
    unsafe("Pinned memory database SQLite sidecar pathname disappeared.");
  }
  assertSqliteSidecar(current, sidecar.path, sidecar.suffix);
  if (!sameIdentity(descriptor, current)) {
    unsafe("Pinned memory database SQLite sidecar pathname identity changed.");
  }
}

async function preserveDriftedSqliteSidecars(
  databasePath: string,
  pinned: ReadonlyMap<SqliteSidecarSuffix, PinnedSqliteSidecar>,
): Promise<MemoryLocalError | undefined> {
  const drifted: Array<{
    readonly suffix: SqliteSidecarSuffix;
    readonly expected?: PinnedSqliteSidecar;
    readonly current?: Stats;
  }> = [];
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const expected = pinned.get(suffix);
    const current = await lstat(`${databasePath}${suffix}`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (expected === undefined) {
      if (current !== undefined) drifted.push({ suffix, current });
      continue;
    }
    const descriptor = await expected.handle.stat();
    const descriptorSafe = sqliteSidecarCanBeSnapshotted(descriptor, expected.suffix)
      && sameFileObjectIdentity(expected.identity, identity(descriptor));
    const currentMatches = current !== undefined
      && sqliteSidecarShapeIsSafe(current, expected.suffix)
      && sameIdentity(descriptor, current);
    if (!descriptorSafe || !currentMatches) {
      if (!descriptorSafe) {
        unsafe("Pinned memory database SQLite sidecar cannot be preserved safely.");
      }
      drifted.push(current === undefined
        ? { suffix, expected }
        : { suffix, expected, current });
    }
  }
  if (drifted.length === 0) return undefined;

  const quarantine = await createSqliteSidecarQuarantine(databasePath);
  try {
    for (const entry of drifted) {
      if (entry.expected !== undefined) {
        await snapshotPinnedSqliteSidecar(
          entry.expected,
          join(quarantine, `admitted${entry.suffix}.snapshot`),
        );
      }
      if (entry.current !== undefined) {
        const source = `${databasePath}${entry.suffix}`;
        const target = join(quarantine, `unexpected${entry.suffix}`);
        await rename(source, target);
        const moved = await lstat(target);
        if (!sameIdentity(entry.current, moved)) {
          unsafe("Memory database SQLite sidecar changed while being quarantined.");
        }
      }
    }
    await syncDirectory(quarantine);
    await syncDirectory(dirname(databasePath));
  } catch (error) {
    throw new MemoryLocalError(
      "unsafe_store",
      "Memory database SQLite sidecar drift could not be preserved safely; SQLite remains open.",
      { cause: error },
    );
  }

  return new MemoryLocalError(
    "unsafe_store",
    `Memory database SQLite sidecar identity drift was preserved for inspection in ${basename(quarantine)}.`,
  );
}

async function snapshotPinnedSqliteSidecar(
  sidecar: PinnedSqliteSidecar,
  target: string,
): Promise<void> {
  const before = await sidecar.handle.stat();
  if (
    !sqliteSidecarCanBeSnapshotted(before, sidecar.suffix)
    || !sameFileObjectIdentity(sidecar.identity, identity(before))
  ) {
    unsafe("Pinned memory database SQLite sidecar cannot be snapshotted safely.");
  }
  const output = await createSecureFile(target);
  try {
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.byteLength, before.size - offset);
      const { bytesRead } = await sidecar.handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      await output.write(buffer, 0, bytesRead, offset);
      offset += bytesRead;
    }
    if (offset !== before.size) {
      unsafe("Pinned memory database SQLite sidecar changed while being preserved.");
    }
    await output.sync();
    const after = await sidecar.handle.stat();
    if (
      after.size !== before.size
      || !sameFileObjectIdentity(identity(before), identity(after))
    ) {
      unsafe("Pinned memory database SQLite sidecar changed while being preserved.");
    }
  } finally {
    await output.close();
  }
  await inspectSecureFile(target);
}

async function createSqliteSidecarQuarantine(databasePath: string): Promise<string> {
  const quarantine = `${databasePath}.sidecar-quarantine-${randomUUID()}`;
  await mkdir(quarantine, { mode: 0o700 });
  const created = await lstat(quarantine);
  assertDirectory(created, quarantine, true);
  await syncDirectory(dirname(databasePath));
  return quarantine;
}

async function rejectSqliteSidecarQuarantines(databasePath: string): Promise<void> {
  const prefix = `${basename(databasePath)}.sidecar-quarantine-`;
  if ((await readdir(dirname(databasePath))).some((name) => name.startsWith(prefix))) {
    unsafe("Memory database has quarantined SQLite sidecar identity drift.");
  }
}

function assertSqliteSidecar(
  stat: Stats,
  path: string,
  suffix: SqliteSidecarSuffix,
): void {
  assertFile(stat, path, 0o600);
  if (stat.size > sqliteSidecarMaximum(suffix)) {
    unsafe("Memory database SQLite recovery state exceeds its byte bound.");
  }
}

function sqliteSidecarShapeIsSafe(stat: Stats, suffix: SqliteSidecarSuffix): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === currentUid()
    && (stat.mode & 0o777) === 0o600
    && stat.nlink === 1
    && stat.size <= sqliteSidecarMaximum(suffix);
}

function sqliteSidecarCanBeSnapshotted(stat: Stats, suffix: SqliteSidecarSuffix): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === currentUid()
    && stat.size <= sqliteSidecarMaximum(suffix);
}

function sqliteSidecarMaximum(suffix: SqliteSidecarSuffix): number {
  return suffix === "-shm" ? 16 * 1024 * 1024 : 256 * 1024 * 1024;
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

export async function hardenNewFile(
  path: string,
  expectedIdentity?: FileIdentity,
): Promise<FileIdentity> {
  const handle = await open(path, constants.O_RDWR | NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== currentUid() || before.nlink !== 1) {
      unsafe("New memory file could not be proven safe before hardening.");
    }
    if (expectedIdentity !== undefined
      && (String(before.dev) !== expectedIdentity.device || String(before.ino) !== expectedIdentity.inode)) {
      unsafe("New memory file identity changed before hardening.");
    }
    await handle.chmod(0o600);
    await handle.sync();
    const after = await handle.stat();
    assertFile(after, path, 0o600);
    const current = await lstat(path);
    assertFile(current, path, 0o600);
    if (!sameIdentity(after, current)) unsafe("New memory file changed while hardening.");
    return identity(after);
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function rejectLegacyMarkerArtifacts(root: SecureRoot): Promise<void> {
  await verifySecureRoot(root);
  const names = await readdir(root.path);
  if (names.some((name) => name.startsWith(".first-run-memory-initializing.released-"))) {
    throw new MemoryLocalError(
      "incomplete_initialization",
      "Legacy released first-run marker artifacts require explicit operator remediation.",
    );
  }
  await verifySecureRoot(root);
}

export async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function bindingAuthorityPath(bindingPath: string, file: FileIdentity): string {
  const digest = createHash("sha256")
    .update("mono-agent.memory-sqlite-binding.v1\0")
    .update(file.device)
    .update("\0")
    .update(file.inode)
    .update("\0")
    .update(String(file.mode))
    .update("\0")
    .update(String(file.owner))
    .digest("hex");
  return `${bindingPath}.authority-${digest}`;
}

async function openBindingAuthority(
  path: string,
  create: boolean,
): Promise<{ readonly directory: PinnedSecureDirectory; readonly created: boolean }> {
  let created = false;
  if (!(await pathExists(path))) {
    if (!create) unsafe("Memory database binding has no matching authority.");
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
      await syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const before = await lstat(path);
  assertDirectory(before, path, true);
  if (await realpath(path) !== path) unsafe("Memory database binding authority traverses a symlink.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertDirectory(opened, path, true);
    if (!sameIdentity(before, opened)) unsafe("Memory database binding authority changed while opening.");
    const expected = identity(opened);
    let closed = false;
    const verify = async (): Promise<void> => {
      if (closed) unsafe("Memory database binding authority is closed.");
      const descriptor = await handle.stat();
      const current = await lstat(path).catch(() =>
        unsafe("Memory database binding authority disappeared."));
      assertDirectory(descriptor, path, true);
      assertDirectory(current, path, true);
      if (
        !sameIdentity(descriptor, current)
        || !sameRootIdentity(expected, identity(descriptor))
        || (await readdir(path)).length !== 0
      ) {
        unsafe("Memory database binding authority changed after opening.");
      }
    };
    await verify();
    return {
      created,
      directory: {
        path,
        identity: expected,
        verify,
        close: async () => {
          if (closed) return;
          closed = true;
          await handle.close();
        },
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function unlinkCreatedFile(
  path: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  const current = await lstat(path).catch(() => undefined);
  if (current === undefined || !sameFileIdentity(identity(current), expected)) return;
  await unlink(path).catch(() => undefined);
}

async function removeCreatedDirectory(
  path: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  const current = await lstat(path).catch(() => undefined);
  if (
    current === undefined
    || !sameRootIdentity(identity(current), expected)
    || (await readdir(path).catch(() => ["unsafe"])).length !== 0
  ) return;
  await rmdir(path).catch(() => undefined);
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

function assertFile(
  stat: Stats,
  path: string,
  expectedMode: number,
  expectedLinks = 1,
): void {
  assertFileShape(stat, path, expectedMode);
  if (stat.nlink !== expectedLinks) {
    unsafe(`Memory store files must have exactly ${String(expectedLinks)} hard link(s).`);
  }
}

function assertFileShape(stat: Stats, path: string, expectedMode: number): void {
  if (!stat.isFile() || stat.isSymbolicLink()) unsafe(`Memory store path is not a regular file: ${path}`);
  if (stat.uid !== currentUid()) unsafe("Memory store files must be owned by the current user.");
  if ((stat.mode & 0o777) !== expectedMode) unsafe(`Memory store file mode must be exactly ${expectedMode.toString(8)}.`);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileObjectIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.owner === right.owner;
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

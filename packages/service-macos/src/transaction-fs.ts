// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { ServiceMacosDriftError } from "./errors.js";
import {
  digest,
  isErrno,
  isRecord,
  processIsAlive,
} from "./internal-fs.js";
import {
  assertUnchangedJournalFileIdentity,
  sameExactFile,
  sameFileObject,
  sameRenamedFile,
} from "./journal-guards.js";
import { observeOwnerPrivatePlist } from "./plist-observation.js";
import type { ServiceMacosTarget } from "./plist.js";
import type { ServiceFileObservation } from "./service-types.js";
import { runServiceMacosTransactionTestHook } from "./transaction-test-hooks.js";

const TRANSACTION_DIRECTORY_SUFFIX = ".mono-agent-transaction";

export interface TransactionPaths {
  readonly root: string;
  readonly lock: string;
  readonly journal: string;
  readonly nextJournal: string;
  readonly previousJournal: string;
  readonly prior: string;
  readonly desired: string;
  readonly displaced: string;
  readonly parent: string;
}

export interface TransactionGuard {
  readonly parent: string;
  readonly expectedUid: number;
  readonly expectedIdentity: string;
  root: { readonly path: string; readonly identity: string } | undefined;
}

export async function restoreNoClobber(
  source: string,
  target: string,
  sourceObservation: ServiceFileObservation,
  guard: TransactionGuard,
): Promise<boolean> {
  return await moveNoClobber(
    source,
    target,
    sourceObservation,
    guard,
    true,
  ) !== undefined;
}

export async function moveNoClobber(
  source: string,
  target: string,
  sourceObservation: ServiceFileObservation,
  guard: TransactionGuard,
  runRestoreHook = false,
): Promise<ServiceFileObservation | undefined> {
  const expectedUid = guard.expectedUid;
  try {
    await mutateWithStableParent(
      guard,
      async () => await link(source, target),
    );
  } catch (error) {
    if (isErrno(error, "EEXIST")) return undefined;
    throw error;
  }
  await fsyncDirectory(dirname(target));
  const sourceLinked = await observeOwnerPrivatePlist(
    source,
    expectedUid,
    { allowTwoLinks: true },
  );
  const targetLinked = await observeOwnerPrivatePlist(
    target,
    expectedUid,
    { allowTwoLinks: true },
  );
  if (
    !sameFileObject(sourceObservation, sourceLinked)
    || !sameFileObject(sourceLinked, targetLinked)
    || sourceLinked.identity?.links !== 2
    || targetLinked.identity?.links !== 2
  ) {
    throw new ServiceMacosDriftError(
      `No-clobber move identity proof failed for ${target}.`,
    );
  }
  if (runRestoreHook) {
    await runServiceMacosTransactionTestHook("after-restore-linked");
  }
  await unlinkInternal(source, sourceLinked, guard, true);
  await fsyncDirectory(dirname(source));
  await fsyncDirectory(dirname(target));
  const moved = await observeOwnerPrivatePlist(target, expectedUid);
  if (!sameFileObject(sourceObservation, moved)) {
    throw new ServiceMacosDriftError(
      `No-clobber move final identity proof failed for ${target}.`,
    );
  }
  return moved;
}

export async function unlinkInternal(
  path: string,
  expected: ServiceFileObservation,
  guard: TransactionGuard,
  allowTwoLinks: boolean,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const current = await observeOwnerPrivatePlist(
    path,
    expectedUid,
    allowTwoLinks ? { allowTwoLinks: true } : {},
  );
  if (!sameExactFile(expected, current)) {
    throw new ServiceMacosDriftError(
      `Refusing to delete transaction artifact whose identity changed: ${path}.`,
    );
  }
  const quarantine = join(
    dirname(path),
    `.mono-agent-delete-${randomUUID()}`,
  );
  await mutateWithStableParent(
    guard,
    async () => await rename(path, quarantine),
  );
  await fsyncDirectory(dirname(path));
  const moved = await observeOwnerPrivatePlist(
    quarantine,
    expectedUid,
    allowTwoLinks ? { allowTwoLinks: true } : {},
  );
  if (!sameRenamedFile(current, moved)) {
    const restored = await restoreNoClobber(
      quarantine,
      path,
      moved,
      guard,
    );
    throw new ServiceMacosDriftError(
      `Deletion target changed during quarantine for ${path}; moved bytes were `
      + `${restored ? "restored" : `retained at ${quarantine}`}.`,
    );
  }
  await mutateWithStableParent(
    guard,
    async () => await unlink(quarantine),
  );
  await fsyncDirectory(dirname(path));
}

export async function acquireTransactionLock(
  paths: TransactionPaths,
  guard: TransactionGuard,
): Promise<() => Promise<void>> {
  const expectedUid = guard.expectedUid;
  for (;;) {
    const owner = Object.freeze({
      schemaVersion: 1,
      pid: process.pid,
      token: randomUUID(),
    });
    const temporary = `${paths.lock}.${owner.token}.tmp`;
    await writeExclusiveFile(
      temporary,
      `${JSON.stringify(owner)}\n`,
      guard,
    );
    const temporaryObservation = await observeOwnerPrivatePlist(
      temporary,
      expectedUid,
    );
    try {
      await mutateWithStableParent(
        guard,
        async () => await link(temporary, paths.lock),
      );
      await fsyncDirectory(paths.parent);
      const linkedTemporary = await observeOwnerPrivatePlist(
        temporary,
        expectedUid,
        { allowTwoLinks: true },
      );
      const linkedLock = await observeOwnerPrivatePlist(
        paths.lock,
        expectedUid,
        { allowTwoLinks: true },
      );
      if (
        !sameFileObject(temporaryObservation, linkedTemporary)
        || !sameFileObject(linkedTemporary, linkedLock)
      ) {
        throw new ServiceMacosDriftError(
          `Service transaction lock publication changed identity `
          + `for ${paths.root}.`,
        );
      }
      await unlinkInternal(temporary, linkedTemporary, guard, true);
      await fsyncDirectory(paths.parent);
      const acquiredLock = await observeOwnerPrivatePlist(
        paths.lock,
        expectedUid,
      );
      return async () => {
        await assertTransactionParent(guard);
        const current = await readLockOwner(paths.lock, expectedUid);
        if (
          current.pid !== process.pid
          || current.token !== owner.token
        ) {
          throw new ServiceMacosDriftError(
            `Service transaction lock ownership changed for ${paths.root}.`,
          );
        }
        const released = `${paths.lock}.released-${owner.token}`;
        await mutateWithStableParent(
          guard,
          async () => await rename(paths.lock, released),
        );
        await fsyncDirectory(paths.parent);
        const releasedObservation = await observeOwnerPrivatePlist(
          released,
          expectedUid,
          { allowTwoLinks: true },
        );
        if (!sameRenamedFile(acquiredLock, releasedObservation)) {
          await restoreNoClobber(
            released,
            paths.lock,
            releasedObservation,
            guard,
          );
          throw new ServiceMacosDriftError(
            `Service transaction lock changed before release for ${paths.root}.`,
          );
        }
        await unlinkInternal(
          released,
          releasedObservation,
          guard,
          true,
        );
        await fsyncDirectory(paths.parent);
      };
    } catch (error) {
      await unlinkInternal(
        temporary,
        temporaryObservation,
        guard,
        true,
      ).catch(() => undefined);
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readLockOwner(paths.lock, expectedUid);
      if (processIsAlive(existing.pid)) {
        throw new ServiceMacosDriftError(
          `Another service-macos mutation is active for ${paths.root}.`,
        );
      }
      await runServiceMacosTransactionTestHook(
        "before-stale-lock-quarantine",
      );
      const stale = `${paths.lock}.stale-${randomUUID()}`;
      await mutateWithStableParent(
        guard,
        async () => await rename(paths.lock, stale),
      );
      await fsyncDirectory(paths.parent);
      const moved = await observeOwnerPrivatePlist(
        stale,
        expectedUid,
        { allowTwoLinks: true },
      );
      if (!sameRenamedFile(existing.observation, moved)) {
        await restoreNoClobber(stale, paths.lock, moved, guard);
        throw new ServiceMacosDriftError(
          `Service transaction lock changed during stale-lock recovery `
          + `for ${paths.root}.`,
        );
      }
      await unlinkInternal(stale, moved, guard, true);
      await fsyncDirectory(paths.parent);
    }
  }
}

async function readLockOwner(
  path: string,
  expectedUid: number,
): Promise<{
  readonly pid: number;
  readonly token: string;
  readonly observation: ServiceFileObservation;
}> {
  const before = await observeOwnerPrivatePlist(
    path,
    expectedUid,
    { allowTwoLinks: true },
  );
  const source = await readOwnerPrivateBounded(
    path,
    4_096,
    expectedUid,
    true,
  );
  const after = await observeOwnerPrivatePlist(
    path,
    expectedUid,
    { allowTwoLinks: true },
  );
  if (!sameExactFile(before, after) || digest(source) !== before.digest) {
    throw new ServiceMacosDriftError(
      `Transaction lock changed while it was read: ${path}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new ServiceMacosDriftError(
      `Transaction lock owner record is corrupt: ${path}.`,
    );
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.token !== "string"
    || !/^[a-f0-9-]{36}$/u.test(value.token)
  ) {
    throw new ServiceMacosDriftError(
      `Transaction lock owner record is invalid: ${path}.`,
    );
  }
  return {
    pid: value.pid as number,
    token: value.token,
    observation: after,
  };
}

export async function writeExclusiveFile(
  path: string,
  value: string | Uint8Array,
  guard: TransactionGuard,
): Promise<void> {
  await mutateWithStableParent(guard, async () => {
    const handle = await open(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

export async function readOwnerPrivateBounded(
  path: string,
  maximumBytes: number,
  expectedUid: number,
  allowTwoLinks = false,
): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== BigInt(expectedUid)
    || (before.mode & 0o777n) !== 0o600n
    || before.nlink < 1n
    || before.nlink > (allowTwoLinks ? 2n : 1n)
    || before.size > BigInt(maximumBytes)
  ) {
    throw new ServiceMacosDriftError(
      `${path} must be an owner-private single-linked bounded file.`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assertUnchangedJournalFileIdentity(path, before, opened);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertUnchangedJournalFileIdentity(path, opened, after);
    if (
      source.byteLength > maximumBytes
      || after.size !== BigInt(source.byteLength)
    ) {
      throw new ServiceMacosDriftError(
        `${path} changed or exceeded its byte limit while read.`,
      );
    }
    return source;
  } finally {
    await handle.close();
  }
}

export async function assertOwnedTransactionDirectory(
  path: string,
  expectedUid: number,
): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(expectedUid)
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw new ServiceMacosDriftError(
      `${path} must be an owner-private transaction directory (mode 0700).`,
    );
  }
}

export function transactionGuard(
  paths: TransactionPaths,
  expectedUid: number,
  expectedIdentity: string,
): TransactionGuard {
  return {
    parent: paths.parent,
    expectedUid,
    expectedIdentity,
    root: undefined,
  };
}

export async function bindTransactionRoot(
  guard: TransactionGuard,
  path: string,
): Promise<void> {
  guard.root = {
    path,
    identity: await protectedDirectoryIdentity(
      path,
      guard.expectedUid,
      true,
    ),
  };
}

export async function assertTransactionParent(
  guard: TransactionGuard,
): Promise<void> {
  const parentIdentity = await protectedDirectoryIdentity(
    guard.parent,
    guard.expectedUid,
    false,
  );
  if (parentIdentity !== guard.expectedIdentity) {
    throw new ServiceMacosDriftError(
      `Transaction parent directory changed identity: ${guard.parent}.`,
    );
  }
  if (guard.root !== undefined) {
    const rootIdentity = await protectedDirectoryIdentity(
      guard.root.path,
      guard.expectedUid,
      true,
    );
    if (rootIdentity !== guard.root.identity) {
      throw new ServiceMacosDriftError(
        `Transaction root directory changed identity: ${guard.root.path}.`,
      );
    }
  }
}

async function protectedDirectoryIdentity(
  path: string,
  expectedUid: number,
  exactPrivate: boolean,
): Promise<string> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(expectedUid)
    || (
      exactPrivate
        ? (stats.mode & 0o777n) !== 0o700n
        : (stats.mode & 0o022n) !== 0n
    )
  ) {
    throw new ServiceMacosDriftError(
      `Transaction directory is unsafe or changed: ${path}.`,
    );
  }
  return [
    stats.dev,
    stats.ino,
    stats.uid,
    stats.mode & 0o777n,
  ].join(":");
}

export async function mutateWithStableParent<T>(
  guard: TransactionGuard,
  operation: () => Promise<T>,
  rootMayDisappear = false,
): Promise<T> {
  await assertTransactionParent(guard);
  try {
    const result = await operation();
    if (rootMayDisappear) guard.root = undefined;
    return result;
  } finally {
    await assertTransactionParent(guard);
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function transactionPaths(
  target: ServiceMacosTarget,
): TransactionPaths {
  const parent = dirname(target.plistPath);
  const root = join(
    parent,
    `.${target.label}${TRANSACTION_DIRECTORY_SUFFIX}`,
  );
  const lock = `${root}.lock`;
  return Object.freeze({
    root,
    lock,
    journal: join(root, "journal.json"),
    nextJournal: join(root, "journal.next"),
    previousJournal: join(root, "journal.previous"),
    prior: join(root, "prior.plist"),
    desired: join(root, "desired.plist"),
    displaced: join(root, "displaced.plist"),
    parent,
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

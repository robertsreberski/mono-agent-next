// SPDX-License-Identifier: MIT
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  OwnerPrivatePathError,
  createOwnerPrivateFile,
  inspectOwnerPrivateDirectory,
  inspectOwnerPrivateFile,
  type OwnerPrivatePathIdentity,
} from "@mono-agent/module-sdk";

import {
  sameIdentity,
  SLACK_INBOX_LEASE_FILE,
  throwIfAborted,
} from "./inbox-values.js";

const LEASE_APPLICATION_ID = 0x4d41534c;
const SQLITE_RESERVED_SUFFIXES = ["-journal", "-shm", "-wal"] as const;
const ACTIVE_DIRECTORY_LEASES = processGlobalLeaseRegistry();

export interface SlackInboxLease {
  release(): Promise<void>;
}

export interface SlackInboxLeaseBinding {
  readonly identity: OwnerPrivatePathIdentity;
  readonly leaseIdentity?: OwnerPrivatePathIdentity;
  readonly createIfMissing?: boolean;
}

export interface SlackInboxLeaseTestHooks {
  readonly afterAnchorOpen?: () => Promise<void>;
  readonly afterDescriptorLock?: () => Promise<void>;
}

export async function inspectSlackInboxLeaseMetadata(
  path: string,
  signal?: AbortSignal,
): Promise<OwnerPrivatePathIdentity | undefined> {
  throwIfAborted(signal);
  const stat = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Slack durable inbox lease is not a regular no-follow file.");
  }
  const identity = identityFromStat(path, stat);
  if (typeof process.getuid !== "function" || identity.uid !== process.getuid()) {
    throw new Error("Slack durable inbox lease is not owned by the current user.");
  }
  if (identity.mode !== 0o600) {
    throw new Error("Slack durable inbox lease mode must be exactly 600.");
  }
  if (identity.links !== 1) {
    throw new Error("Slack durable inbox lease must have exactly one hard link.");
  }
  throwIfAborted(signal);
  return identity;
}

export async function acquireSlackInboxLease(
  directory: string,
  signal?: AbortSignal,
  binding?: SlackInboxLeaseBinding,
  testHooks?: SlackInboxLeaseTestHooks,
): Promise<SlackInboxLease> {
  throwIfAborted(signal);
  const directoryIdentity = await bindDirectoryIdentity(
    directory,
    binding?.identity,
    signal,
  );
  const releaseReservation = reserveDirectoryLease(directoryIdentity);
  try {
    return await acquireReservedSlackInboxLease(
      directory,
      directoryIdentity,
      releaseReservation,
      signal,
      binding,
      testHooks,
    );
  } catch (error) {
    releaseReservation();
    throw error;
  }
}

async function acquireReservedSlackInboxLease(
  directory: string,
  directoryIdentity: OwnerPrivatePathIdentity,
  releaseReservation: () => void,
  signal?: AbortSignal,
  binding?: SlackInboxLeaseBinding,
  testHooks?: SlackInboxLeaseTestHooks,
): Promise<SlackInboxLease> {
  const path = join(directory, SLACK_INBOX_LEASE_FILE);
  await rejectSqliteSidecars(path);
  let identity: OwnerPrivatePathIdentity;
  if (binding?.leaseIdentity !== undefined) {
    identity = binding.leaseIdentity;
  } else {
    if (binding !== undefined && binding.createIfMissing !== true) {
      throw leaseError("Slack durable inbox lease was missing during discovery.");
    }
    try {
      identity = await inspectOwnerPrivateFile(
        path,
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      if (!(error instanceof OwnerPrivatePathError) || error.code !== "missing") {
        throw leaseError("Slack durable inbox lease path validation failed.", error);
      }
      try {
        identity = await createOwnerPrivateFile(
          path,
          createLeaseDatabase(),
          signal === undefined ? {} : { signal },
        );
      } catch (createError) {
        if (!(createError instanceof OwnerPrivatePathError)
          || createError.code !== "already_exists") {
          throw leaseError("Slack durable inbox lease could not be created.", createError);
        }
        identity = await inspectOwnerPrivateFile(
          path,
          signal === undefined ? {} : { signal },
        );
      }
    }
  }

  let database: DatabaseSync | undefined;
  let anchor: FileHandle | undefined;
  let locked = false;
  try {
    throwIfAborted(signal);
    await bindDirectoryIdentity(directory, directoryIdentity, signal);
    await rejectSqliteSidecars(path);
    anchor = await openLeaseAnchor(identity);
    await testHooks?.afterAnchorOpen?.();
    database = new DatabaseSync(descriptorPath(anchor.fd), { timeout: 0 });
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA query_only = ON;");
    locked = true;
    const application = database.prepare("PRAGMA application_id").get() as
      | { readonly application_id?: unknown }
      | undefined;
    if (application?.application_id !== LEASE_APPLICATION_ID) {
      throw new Error("Slack durable inbox lease has an invalid application identity.");
    }
    await validateLeaseAnchor(anchor, identity);
    await testHooks?.afterDescriptorLock?.();
    const verified = await inspectLeasePathMetadata(path, signal);
    if (!sameIdentity(identity, verified)) {
      throw new Error("Slack durable inbox lease identity changed while locking.");
    }
    await bindDirectoryIdentity(directory, directoryIdentity, signal);
    await rejectSqliteSidecars(path);
    throwIfAborted(signal);
  } catch (error) {
    try {
      if (database !== undefined) {
        if (locked) {
          try {
            database.exec("ROLLBACK;");
          } catch {
            // The database is being closed after a failed lease acquisition.
          }
        }
        database.close();
      }
    } finally {
      await anchor?.close();
    }
    if (isSqliteBusy(error)) {
      throw leaseError(
        "Slack durable inbox is in use by a serving channel or maintenance process.",
        error,
      );
    }
    throw leaseError("Slack durable inbox lease validation failed.", error);
  }

  const acquired = database;
  const acquiredAnchor = anchor;
  if (acquired === undefined || acquiredAnchor === undefined) {
    throw leaseError("Slack durable inbox lease could not be acquired.");
  }
  let released = false;
  return Object.freeze({
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        try {
          acquired.exec("ROLLBACK;");
        } finally {
          try {
            acquired.close();
          } finally {
            await acquiredAnchor.close();
          }
        }
        await bindDirectoryIdentity(directory, directoryIdentity);
        await rejectSqliteSidecars(path);
      } finally {
        releaseReservation();
      }
    },
  });
}

function reserveDirectoryLease(identity: OwnerPrivatePathIdentity): () => void {
  const key = `${identity.device}:${identity.inode}`;
  if (ACTIVE_DIRECTORY_LEASES.has(key)) {
    throw leaseError(
      "Slack durable inbox is in use by a serving channel or maintenance process.",
    );
  }
  ACTIVE_DIRECTORY_LEASES.add(key);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ACTIVE_DIRECTORY_LEASES.delete(key);
  };
}

function processGlobalLeaseRegistry(): Set<string> {
  const key = Symbol.for("mono-agent.channel-slack.active-directory-leases.v1");
  const existing = Reflect.get(globalThis, key) as unknown;
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  Reflect.set(globalThis, key, created);
  return created;
}

async function inspectLeasePathMetadata(
  path: string,
  signal?: AbortSignal,
): Promise<OwnerPrivatePathIdentity> {
  const identity = await inspectSlackInboxLeaseMetadata(path, signal);
  if (identity === undefined) {
    throw new Error("Slack durable inbox lease disappeared while locking.");
  }
  return identity;
}

async function bindDirectoryIdentity(
  directory: string,
  expected: OwnerPrivatePathIdentity | undefined,
  signal?: AbortSignal,
): Promise<OwnerPrivatePathIdentity> {
  try {
    const actual = await inspectOwnerPrivateDirectory(
      directory,
      signal === undefined ? {} : { signal },
    );
    if (expected !== undefined && !sameIdentity(actual, expected)) {
      throw new Error("Slack durable inbox directory identity changed.");
    }
    return actual;
  } catch (error) {
    throw leaseError("Slack durable inbox directory path validation failed.", error);
  }
}

async function openLeaseAnchor(
  expected: OwnerPrivatePathIdentity,
): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Slack durable inbox lease requires O_NOFOLLOW.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      expected.path,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    await validateLeaseAnchor(handle, expected);
    return handle;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function validateLeaseAnchor(
  handle: FileHandle,
  expected: OwnerPrivatePathIdentity,
): Promise<void> {
  const actual = identityFromStat(expected.path, await handle.stat());
  if (!sameFileSnapshot(actual, expected)) {
    throw new Error("Slack durable inbox lease identity changed before locking.");
  }
}

function descriptorPath(fileDescriptor: number): string {
  if (process.platform === "darwin") return `/dev/fd/${fileDescriptor}`;
  if (process.platform === "linux") return `/proc/self/fd/${fileDescriptor}`;
  throw new Error(
    "Slack durable inbox descriptor-anchored leases require macOS or Linux.",
  );
}

function identityFromStat(path: string, stat: Stats): OwnerPrivatePathIdentity {
  if (!stat.isFile()) {
    throw new Error("Slack durable inbox lease is not a regular file.");
  }
  return Object.freeze({
    path,
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
    links: stat.nlink,
    size: stat.size,
  });
}

function sameFileSnapshot(
  left: OwnerPrivatePathIdentity,
  right: OwnerPrivatePathIdentity,
): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode
    && left.links === right.links
    && left.size === right.size;
}

function createLeaseDatabase(): Uint8Array {
  const pageBytes = 4_096;
  const database = Buffer.alloc(pageBytes);
  database.write("SQLite format 3\0", 0, "binary");
  database.writeUInt16BE(pageBytes, 16);
  database[18] = 1;
  database[19] = 1;
  database[21] = 64;
  database[22] = 32;
  database[23] = 32;
  database.writeUInt32BE(1, 28);
  database.writeUInt32BE(LEASE_APPLICATION_ID, 68);
  database[100] = 0x0d;
  database.writeUInt16BE(pageBytes, 105);
  return database;
}

async function rejectSqliteSidecars(path: string): Promise<void> {
  for (const suffix of SQLITE_RESERVED_SUFFIXES) {
    const reserved = `${path}${suffix}`;
    const info = await lstat(reserved).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (info !== undefined) {
      throw new Error(
        "Slack durable inbox lease has an unexpected SQLite sidecar.",
      );
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}

function isSqliteBusy(error: unknown): boolean {
  return hasCode(error, "ERR_SQLITE_ERROR")
    && /(?:busy|locked)/iu.test(
      error instanceof Error ? error.message : String(error),
    );
}

function leaseError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

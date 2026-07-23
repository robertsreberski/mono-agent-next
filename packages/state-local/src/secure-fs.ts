import { createHash } from "node:crypto";
import {
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readSync,
  type Stats,
  writeSync,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StateLocalError } from "./errors.js";

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface SecureFileDetails {
  readonly identity: FileIdentity;
  readonly size: number;
}

export interface SecureDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

export interface AtomicReplaceHooks {
  readonly beforeRename?: (target: string) => void | Promise<void>;
  /** Adversarial seam after the final path check but before descriptor-bound mutation. */
  readonly afterCheck?: (target: string) => void | Promise<void>;
  readonly afterRename?: (target: string) => void | Promise<void>;
  /** Adversarial seam after a transactional publication commit but before final witnesses. */
  readonly afterCommit?: (target: string) => void | Promise<void>;
}

export interface LeaseHooks {
  readonly afterInspect?: (target: string) => void | Promise<void>;
}

export interface ProcessLease {
  readonly identity: FileIdentity;
  readonly path: string;
  verify(): Promise<void>;
  readIndex(key: string, maximumBytes: number): Buffer | undefined;
  writeIndex(key: string, value: Uint8Array): void;
  writeIndexIfAbsent(key: string, value: Uint8Array): boolean;
  listIndexKeys(prefix: string, maximumEntries: number): readonly string[];
  listIndex(
    prefix: string,
    limits: {
      readonly maximumEntries: number;
      readonly maximumValueBytes: number;
      readonly maximumTotalBytes: number;
    },
  ): readonly { readonly key: string; readonly value: Buffer }[];
  release(): Promise<void>;
}

export interface PinnedSecureFile {
  readonly identity: FileIdentity;
  readonly path: string;
  read(maximumBytes: number): Promise<Buffer>;
  readAt(position: number, length: number): Buffer;
  size(): number;
  appendDurable(chunks: readonly Uint8Array[]): number;
  truncateDurable(size: number): void;
  replace(bytes: Uint8Array, hooks?: AtomicReplaceHooks): Promise<void>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

const STATE_INDEX_APPLICATION_ID = 0x4d415331;
const STATE_INDEX_LOG_HEADER = Buffer.from("mono-agent-state-index-v2\n", "utf8");
const STATE_INDEX_FRAME_COMMIT_MAGIC = Buffer.from("mas-commit-v2\n", "utf8");
const STATE_INDEX_FRAME_HEADER_BYTES = 8;
const STATE_INDEX_FRAME_FOOTER_BYTES = STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength + 8;
const STATE_INDEX_FRAME_METADATA_BYTES = 7;
const STATE_INDEX_DIGEST_BYTES = 32;
const STATE_INDEX_LOG_MAX_BYTES = 2_147_483_647;
const STATE_INDEX_LOG_MAX_ENTRIES = 100_000;
const STATE_INDEX_LOG_MAX_FRAMES = 1_000_000;
const SQLITE_RESERVED_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

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
  return (await inspectSecureFileDetails(path))?.identity;
}

export async function inspectSecureFileDetails(
  path: string,
  expectedLinks = 1,
): Promise<SecureFileDetails | undefined> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) return undefined;
  verifyFile(info, path, expectedLinks);
  return { identity: identityOf(info), size: info.size };
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
  expectedLinks = 1,
): Promise<void> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) {
      throw new StateLocalError("STATE_PATH_CHANGED", `Secure file ${path} disappeared.`);
  }
  assertSameIdentity(identityOf(info), expected, path);
  verifyFile(info, path, expectedLinks);
}

export async function readSecureFile(
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Buffer; readonly identity: FileIdentity }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 2_147_483_647) {
    throw new StateLocalError(
      "STATE_LIMIT_EXCEEDED",
      "Secure file read bounds must be an integer from 0 through 2147483647 bytes.",
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY, 0o600);
  } catch (error) {
    if (isSymbolicLinkLoop(error)) {
      throw new StateLocalError(
        "STATE_PATH_INSECURE",
        `Secure state file ${path} must not be a symbolic link.`,
        error,
      );
    }
    throw new StateLocalError("STATE_CORRUPT", `Could not safely open state file ${path}.`, error);
  }
  try {
    throwIfReadAborted(signal);
    const before = await handle.stat();
    verifyFile(before, path);
    if (before.size > maximumBytes) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `State file ${path} exceeds its configured size bound.`,
      );
    }
    const bytes = await readHandleBounded(handle, maximumBytes, signal);
    const after = await handle.stat();
    assertSameIdentity(identityOf(after), identityOf(before), path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Secure state file ${path} changed while it was being read.`,
      );
    }
    const current = await lstat(path);
    verifyFile(current, path);
    assertSameIdentity(identityOf(current), identityOf(before), path);
    if (
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    ) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Secure state file ${path} changed while it was being read.`,
      );
    }
    return { bytes, identity: identityOf(before) };
  } catch (error) {
    if (error instanceof StateLocalError) throw error;
    throw new StateLocalError("STATE_CORRUPT", `Could not safely read state file ${path}.`, error);
  } finally {
    await handle.close();
  }
}

export async function createSecureFile(path: string, bytes: Uint8Array): Promise<FileIdentity> {
  const parent = dirname(path);
  const parentInfo = await lstat(parent);
  verifyDirectory(parentInfo, parent);
  const parentIdentity = identityOf(parentInfo);
  const handle = await openNoFollow(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let createdIdentity: FileIdentity;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    verifyFile(written, path);
    createdIdentity = identityOf(written);
  } finally {
    await handle.close();
  }
  const info = await lstat(path);
  verifyFile(info, path);
  assertSameIdentity(identityOf(info), createdIdentity, path);
  await verifySecureDirectoryIdentity(parent, parentIdentity);
  await syncSecureDirectory(parent);
  await verifySecureFileIdentity(path, createdIdentity);
  return createdIdentity;
}

/**
 * Create or reopen a private two-link file backed by one retained witness.
 * This is reserved for internal state whose readers understand the witness.
 */
export async function openOrCreatePinnedSecureFile(
  target: string,
  witness: string,
  initialBytes: Uint8Array,
): Promise<PinnedSecureFile> {
  const parent = dirname(target);
  const parentInfo = await lstat(parent);
  verifyDirectory(parentInfo, parent);
  const parentIdentity = identityOf(parentInfo);
  if (dirname(witness) !== parent || witness === target) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      "Pinned state targets and witnesses must be distinct files in one directory.",
    );
  }

  let targetDetails = await inspectSecureFileDetails(target, 2);
  let witnessDetails = await inspectSecureFileDetails(witness, 2);
  if (targetDetails === undefined && witnessDetails === undefined) {
    const created = await createSecureFile(witness, initialBytes);
    await verifySecureDirectoryIdentity(parent, parentIdentity);
    try {
      await link(witness, target);
    } catch (error) {
      await verifySecureDirectoryIdentity(parent, parentIdentity);
      if (isAlreadyExists(error)) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          `Pinned state target ${target} appeared during publication; it was left untouched.`,
          error,
        );
      }
      throw error;
    }
    await syncSecureDirectory(parent);
    targetDetails = await inspectSecureFileDetails(target, 2);
    witnessDetails = await inspectSecureFileDetails(witness, 2);
    if (
      targetDetails === undefined ||
      witnessDetails === undefined ||
      !sameIdentity(targetDetails.identity, created) ||
      !sameIdentity(witnessDetails.identity, created)
    ) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Pinned state target ${target} changed during publication.`,
      );
    }
  } else if (
    targetDetails === undefined ||
    witnessDetails === undefined ||
    !sameIdentity(targetDetails.identity, witnessDetails.identity)
  ) {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      `Pinned state target ${target} must have its exact retained witness.`,
    );
  }

  return openPinnedSecureFile(
    target,
    targetDetails.identity,
    parent,
    parentIdentity,
    2,
    witness,
  );
}

/**
 * Create or reopen an owner-private single-link public file and pin its open
 * descriptor. Descriptor-bound replacement cannot mutate a pathname inserted
 * after verification.
 */
export async function openOrCreateSingleLinkPinnedSecureFile(
  target: string,
  initialBytes: Uint8Array,
): Promise<PinnedSecureFile> {
  const parent = dirname(target);
  const parentInfo = await lstat(parent);
  verifyDirectory(parentInfo, parent);
  const parentIdentity = identityOf(parentInfo);
  let details = await inspectSecureFileDetails(target);
  if (details === undefined) {
    let created: FileIdentity;
    try {
      created = await createSecureFile(target, initialBytes);
    } catch (error) {
      await verifySecureDirectoryIdentity(parent, parentIdentity);
      if (isAlreadyExists(error)) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          `Pinned state target ${target} appeared during publication; it was left untouched.`,
          error,
        );
      }
      throw error;
    }
    details = await inspectSecureFileDetails(target);
    if (details === undefined || !sameIdentity(details.identity, created)) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Pinned state target ${target} changed during publication.`,
      );
    }
  }
  return openPinnedSecureFile(
    target,
    details.identity,
    parent,
    parentIdentity,
    1,
  );
}

async function openPinnedSecureFile(
  target: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  expectedLinks: 1 | 2,
  witness?: string,
): Promise<PinnedSecureFile> {
  const handle = await openNoFollow(target, constants.O_RDWR, 0o600);
  try {
    const opened = await handle.stat();
    verifyFile(opened, target, expectedLinks);
    assertSameIdentity(identityOf(opened), identity, target);
  } catch (error) {
    await handle.close();
    throw error;
  }

  let closed = false;
  const assertPinnedOpen = (): void => {
    if (closed) throw new StateLocalError("STATE_CLOSED", `Pinned state file ${target} is closed.`);
  };
  const verify = async (): Promise<void> => {
    assertPinnedOpen();
    await verifySecureDirectoryIdentity(parent, parentIdentity);
    await verifySecureFileIdentity(target, identity, expectedLinks);
    if (witness !== undefined) {
      await verifySecureFileIdentity(witness, identity, 2);
    }
    const opened = await handle.stat();
    verifyFile(opened, target, expectedLinks);
    assertSameIdentity(identityOf(opened), identity, target);
  };

  return {
    identity,
    path: target,
    read: async (maximumBytes) => {
      await verify();
      const before = await handle.stat();
      if (before.size > maximumBytes) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Pinned state file ${target} exceeds its configured size bound.`,
        );
      }
      const bytes = await readHandleBounded(handle, maximumBytes, undefined, 0);
      const after = await handle.stat();
      assertStableFile(before, after, bytes.byteLength, target);
      await verify();
      return bytes;
    },
    readAt: (position, length) => {
      assertPinnedOpen();
      assertFileRange(position, length);
      return readFdExact(handle.fd, position, length, target);
    },
    size: () => {
      assertPinnedOpen();
      const info = fstatSync(handle.fd);
      verifyFile(info, target, expectedLinks);
      assertSameIdentity(identityOf(info), identity, target);
      return info.size;
    },
    appendDurable: (chunks) => {
      assertPinnedOpen();
      const info = fstatSync(handle.fd);
      verifyFile(info, target, expectedLinks);
      assertSameIdentity(identityOf(info), identity, target);
      let position = info.size;
      for (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) {
          throw new StateLocalError("STATE_CORRUPT", "Pinned append chunks must be bytes.");
        }
        if (position + chunk.byteLength > STATE_INDEX_LOG_MAX_BYTES) {
          throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Pinned state file is full.");
        }
        writeFdFully(handle.fd, chunk, position);
        position += chunk.byteLength;
      }
      fsyncSync(handle.fd);
      return info.size;
    },
    truncateDurable: (size) => {
      assertPinnedOpen();
      if (!Number.isSafeInteger(size) || size < 0 || size > STATE_INDEX_LOG_MAX_BYTES) {
        throw new StateLocalError("STATE_CORRUPT", "Pinned truncate size is invalid.");
      }
      const info = fstatSync(handle.fd);
      verifyFile(info, target, expectedLinks);
      assertSameIdentity(identityOf(info), identity, target);
      ftruncateSync(handle.fd, size);
      fsyncSync(handle.fd);
    },
    replace: async (bytes, hooks = {}) => {
      await hooks.beforeRename?.(target);
      await verify();
      await hooks.afterCheck?.(target);
      const opened = await handle.stat();
      verifyFile(opened, target, expectedLinks);
      assertSameIdentity(identityOf(opened), identity, target);
      // Descriptor-bound truncate cannot touch a pathname inserted after the
      // check. It also lets startup repair a torn shorter/longer cache from the
      // authoritative transactional record.
      if (opened.size !== bytes.byteLength) await handle.truncate(bytes.byteLength);
      await writeHandleFully(handle, bytes, 0);
      await handle.sync();
      await hooks.afterRename?.(target);
      await verify();
    },
    verify,
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

export async function acquireProcessLease(
  path: string,
  hooks: LeaseHooks = {},
): Promise<ProcessLease> {
  await rejectSqliteSidecars(path);
  let identity = await inspectSecureFile(path);
  let created = false;
  if (identity === undefined) {
    try {
      identity = await createSecureFile(path, createLeaseDatabase());
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      identity = await inspectSecureFile(path);
    }
  }
  if (identity === undefined) {
    throw new StateLocalError("STATE_PATH_CHANGED", `Lease file ${path} could not be established.`);
  }

  const indexPath = `${path}.index`;
  const indexWitnessPath = `${path}.index.witness`;
  const indexBefore = await inspectSecureFileDetails(indexPath, 2);
  const witnessBefore = await inspectSecureFileDetails(indexWitnessPath, 2);
  if (
    !created &&
    indexBefore === undefined &&
    witnessBefore === undefined
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      `State lease ${path} is missing its descriptor-bound index.`,
    );
  }
  const indexLog = await openOrCreatePinnedSecureFile(
    indexPath,
    indexWitnessPath,
    STATE_INDEX_LOG_HEADER,
  );
  let index: Map<string, IndexEntry>;
  let frameCount: number;
  try {
    const loaded = loadIndexLog(indexLog);
    index = loaded.index;
    frameCount = loaded.frameCount;
    await indexLog.verify();
  } catch (error) {
    await indexLog.close();
    throw error;
  }

  await hooks.afterInspect?.(path);
  let database: DatabaseSync | undefined;
  let locked = false;
  try {
    await rejectSqliteSidecars(path);
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA query_only = ON;");
    await verifySecureFileIdentity(path, identity);
    await indexLog.verify();
    await rejectSqliteSidecars(path);
    const applicationId = database.prepare("PRAGMA application_id").get() as
      | { application_id?: unknown }
      | undefined;
    if (applicationId?.application_id !== STATE_INDEX_APPLICATION_ID) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `State lease ${path} is not a recognized mono-agent process lock.`,
      );
    }
    locked = true;
    await verifySecureFileIdentity(path, identity);
    await indexLog.verify();
    await rejectSqliteSidecars(path);
  } catch (error) {
    if (database !== undefined) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // The exclusive transaction may not have started.
      }
      database.close();
    }
    await indexLog.close();
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
  let failed: StateLocalError | undefined;
  const assertOpen = (): void => {
    if (released || !locked) {
      throw new StateLocalError("STATE_CLOSED", "The state process lease is no longer held.");
    }
    if (failed !== undefined) throw failed;
  };
  const append = (key: string, value: Uint8Array): IndexEntry => {
    assertOpen();
    if (frameCount >= STATE_INDEX_LOG_MAX_FRAMES) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Descriptor-bound state index has too many frames.");
    }
    if (!index.has(key) && index.size >= STATE_INDEX_LOG_MAX_ENTRIES) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Descriptor-bound state index has too many entries.");
    }
    const bytes = Buffer.from(value);
    const keyBytes = Buffer.from(key, "utf8");
    const payloadBytes = STATE_INDEX_FRAME_METADATA_BYTES + keyBytes.byteLength + bytes.byteLength;
    if (payloadBytes > 0xffff_ffff) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", `State index entry ${key} is too large.`);
    }
    const frameHeader = encodeFrameLengths(payloadBytes);
    const metadata = Buffer.allocUnsafe(STATE_INDEX_FRAME_METADATA_BYTES);
    metadata.writeUInt8(2, 0);
    metadata.writeUInt16BE(keyBytes.byteLength, 1);
    metadata.writeUInt32BE(bytes.byteLength, 3);
    const digest = createHash("sha256")
      .update(frameHeader)
      .update(metadata)
      .update(keyBytes)
      .update(bytes)
      .digest();
    const frameBytes =
      frameHeader.byteLength +
      metadata.byteLength +
      keyBytes.byteLength +
      bytes.byteLength +
      digest.byteLength +
      STATE_INDEX_FRAME_FOOTER_BYTES;
    if (indexLog.size() + frameBytes > STATE_INDEX_LOG_MAX_BYTES) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Descriptor-bound state index is full.");
    }
    try {
      const frameOffset = indexLog.appendDurable([
        frameHeader,
        metadata,
        keyBytes,
        bytes,
        digest,
      ]);
      indexLog.appendDurable([encodeFrameFooter(payloadBytes)]);
      frameCount += 1;
      return {
        valueOffset:
          frameOffset +
          frameHeader.byteLength +
          metadata.byteLength +
          keyBytes.byteLength,
        valueBytes: bytes.byteLength,
      };
    } catch (error) {
      failed = new StateLocalError(
        "STATE_POISONED",
        "The descriptor-bound state index append did not complete safely; reopen before retrying.",
        error,
      );
      throw error;
    }
  };
  const readEntry = (key: string, entry: IndexEntry, maximumBytes: number): Buffer => {
    if (entry.valueBytes > maximumBytes) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `State index entry ${key} exceeds its configured size bound.`,
      );
    }
    return indexLog.readAt(entry.valueOffset, entry.valueBytes);
  };
  return {
    identity,
    path,
    verify: async () => {
      assertOpen();
      await verifySecureFileIdentity(path, identity);
      await indexLog.verify();
      await rejectSqliteSidecars(path);
    },
    readIndex: (key, maximumBytes) => {
      assertIndexKey(key);
      assertIndexByteLimit(maximumBytes, "maximumBytes");
      assertOpen();
      const entry = index.get(key);
      return entry === undefined ? undefined : readEntry(key, entry, maximumBytes);
    },
    writeIndex: (key, value) => {
      assertIndexKey(key);
      const entry = append(key, value);
      index.set(key, entry);
    },
    writeIndexIfAbsent: (key, value) => {
      assertIndexKey(key);
      assertOpen();
      if (index.has(key)) return false;
      const entry = append(key, value);
      index.set(key, entry);
      return true;
    },
    listIndexKeys: (prefix, maximumEntries) => {
      assertIndexKeyPrefix(prefix);
      assertIndexEntryLimit(maximumEntries);
      assertOpen();
      const keys = [...index.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      if (keys.length > maximumEntries) {
        throw new StateLocalError("STATE_CORRUPT", "State index contains too many entries.");
      }
      return keys;
    },
    listIndex: (prefix, limits) => {
      assertIndexKeyPrefix(prefix);
      assertIndexEntryLimit(limits.maximumEntries);
      assertIndexByteLimit(limits.maximumValueBytes, "maximumValueBytes");
      assertIndexByteLimit(limits.maximumTotalBytes, "maximumTotalBytes");
      assertOpen();
      const entries = [...index.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      if (entries.length > limits.maximumEntries) {
        throw new StateLocalError("STATE_CORRUPT", "State index contains too many entries.");
      }
      let totalBytes = 0;
      for (const [key, entry] of entries) {
        if (entry.valueBytes > limits.maximumValueBytes) {
          throw new StateLocalError(
            "STATE_CORRUPT",
            `State index entry ${key} exceeds its configured size bound.`,
          );
        }
        totalBytes += Buffer.byteLength(key, "utf8") + entry.valueBytes;
        if (totalBytes > limits.maximumTotalBytes) {
          throw new StateLocalError("STATE_CORRUPT", "State index exceeds its total size bound.");
        }
      }
      return entries.map(([key, entry]) => ({
        key,
        value: readEntry(key, entry, limits.maximumValueBytes),
      }));
    },
    release: async () => {
      if (released) return;
      released = true;
      try {
        acquired.exec("ROLLBACK;");
      } finally {
        acquired.close();
        try {
          await rejectSqliteSidecars(path);
        } finally {
          await indexLog.close();
        }
      }
    },
  };
}

interface IndexEntry {
  readonly valueOffset: number;
  readonly valueBytes: number;
}

function createLeaseDatabase(): Buffer {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`PRAGMA application_id = ${String(STATE_INDEX_APPLICATION_ID)};`);
    return Buffer.from(
      (database as DatabaseSync & { serialize(): Uint8Array }).serialize(),
    );
  } finally {
    database.close();
  }
}

async function rejectSqliteSidecars(path: string): Promise<void> {
  for (const suffix of SQLITE_RESERVED_SUFFIXES) {
    const reserved = `${path}${suffix}`;
    if ((await lstatOrUndefined(reserved)) !== undefined) {
      throw new StateLocalError(
        "STATE_PATH_INSECURE",
        `Reserved SQLite sidecar ${reserved} must not exist and was left untouched.`,
      );
    }
  }
}

function encodeFrameLengths(payloadBytes: number): Buffer {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > 0xffff_ffff) {
    throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index length is invalid.");
  }
  const encoded = Buffer.allocUnsafe(STATE_INDEX_FRAME_HEADER_BYTES);
  encoded.writeUInt32BE(payloadBytes, 0);
  encoded.writeUInt32BE((~payloadBytes) >>> 0, 4);
  return encoded;
}

function decodeFrameLengths(bytes: Buffer, location: string): number {
  if (bytes.byteLength !== STATE_INDEX_FRAME_HEADER_BYTES) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      `Descriptor-bound state index ${location} length is invalid.`,
    );
  }
  const length = bytes.readUInt32BE(0);
  const complement = bytes.readUInt32BE(4);
  if (complement !== ((~length) >>> 0)) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      `Descriptor-bound state index ${location} length complement is invalid.`,
    );
  }
  return length;
}

function encodeFrameFooter(payloadBytes: number): Buffer {
  return Buffer.concat([
    STATE_INDEX_FRAME_COMMIT_MAGIC,
    encodeFrameLengths(payloadBytes),
  ], STATE_INDEX_FRAME_FOOTER_BYTES);
}

function validateFrameFooter(footer: Buffer, payloadBytes: number): void {
  if (
    footer.byteLength !== STATE_INDEX_FRAME_FOOTER_BYTES ||
    !footer.subarray(0, STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength)
      .equals(STATE_INDEX_FRAME_COMMIT_MAGIC)
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index footer is invalid.");
  }
  const repeated = decodeFrameLengths(
    footer.subarray(STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength),
    "footer",
  );
  if (repeated !== payloadBytes) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index header and footer lengths differ.",
    );
  }
}

function hasCommittedFooterAtEnd(
  log: PinnedSecureFile,
  frameOffset: number,
  size: number,
): boolean {
  if (size - frameOffset < STATE_INDEX_FRAME_FOOTER_BYTES) return false;
  const footer = log.readAt(
    size - STATE_INDEX_FRAME_FOOTER_BYTES,
    STATE_INDEX_FRAME_FOOTER_BYTES,
  );
  return footer.subarray(0, STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength)
    .equals(STATE_INDEX_FRAME_COMMIT_MAGIC);
}

function loadIndexLog(
  log: PinnedSecureFile,
): { readonly index: Map<string, IndexEntry>; readonly frameCount: number } {
  const size = log.size();
  if (size < STATE_INDEX_LOG_HEADER.byteLength || size > STATE_INDEX_LOG_MAX_BYTES) {
    throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index has an invalid size.");
  }
  if (!log.readAt(0, STATE_INDEX_LOG_HEADER.byteLength).equals(STATE_INDEX_LOG_HEADER)) {
    throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index header is invalid.");
  }

  const index = new Map<string, IndexEntry>();
  let frameCount = 0;
  let offset = STATE_INDEX_LOG_HEADER.byteLength;
  while (offset < size) {
    const remaining = size - offset;
    if (remaining < STATE_INDEX_FRAME_HEADER_BYTES) {
      log.truncateDurable(offset);
      break;
    }
    const frameHeader = log.readAt(offset, STATE_INDEX_FRAME_HEADER_BYTES);
    const payloadBytes = decodeFrameLengths(frameHeader, "header");
    if (
      payloadBytes < STATE_INDEX_FRAME_METADATA_BYTES ||
      payloadBytes > STATE_INDEX_LOG_MAX_BYTES
    ) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index frame is invalid.");
    }
    const totalFrameBytes =
      frameHeader.byteLength +
      payloadBytes +
      STATE_INDEX_DIGEST_BYTES +
      STATE_INDEX_FRAME_FOOTER_BYTES;
    if (remaining < totalFrameBytes) {
      if (hasCommittedFooterAtEnd(log, offset, size)) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Descriptor-bound state index header contradicts its committed footer.",
        );
      }
      log.truncateDurable(offset);
      break;
    }

    const metadataOffset = offset + frameHeader.byteLength;
    const metadata = log.readAt(metadataOffset, STATE_INDEX_FRAME_METADATA_BYTES);
    const version = metadata.readUInt8(0);
    const keyBytesLength = metadata.readUInt16BE(1);
    const valueBytes = metadata.readUInt32BE(3);
    if (
      version !== 2 ||
      keyBytesLength < 1 ||
      keyBytesLength > 512 ||
      payloadBytes !== STATE_INDEX_FRAME_METADATA_BYTES + keyBytesLength + valueBytes
    ) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index frame is invalid.");
    }
    const keyOffset = metadataOffset + metadata.byteLength;
    const keyBytes = log.readAt(keyOffset, keyBytesLength);
    const key = keyBytes.toString("utf8");
    if (!Buffer.from(key, "utf8").equals(keyBytes)) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index key is invalid.");
    }
    assertIndexKey(key);
    const valueOffset = keyOffset + keyBytes.byteLength;
    const digestOffset = valueOffset + valueBytes;
    const expectedDigest = log.readAt(digestOffset, STATE_INDEX_DIGEST_BYTES);
    const footerOffset = digestOffset + expectedDigest.byteLength;
    const footer = log.readAt(footerOffset, STATE_INDEX_FRAME_FOOTER_BYTES);
    validateFrameFooter(footer, payloadBytes);

    const hash = createHash("sha256").update(frameHeader).update(metadata).update(keyBytes);
    let valuePosition = valueOffset;
    let valueRemaining = valueBytes;
    while (valueRemaining > 0) {
      const length = Math.min(valueRemaining, 64 * 1024);
      hash.update(log.readAt(valuePosition, length));
      valuePosition += length;
      valueRemaining -= length;
    }
    if (!hash.digest().equals(expectedDigest)) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index digest is invalid.");
    }
    frameCount += 1;
    if (frameCount > STATE_INDEX_LOG_MAX_FRAMES) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index has too many frames.");
    }
    if (!index.has(key) && index.size >= STATE_INDEX_LOG_MAX_ENTRIES) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index has too many entries.");
    }
    index.set(key, { valueOffset, valueBytes });
    offset += totalFrameBytes;
  }
  return { index, frameCount };
}

export async function syncSecureDirectory(path: string): Promise<void> {
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag();
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function openNoFollow(path: string, flags: number, mode: number) {
  return open(path, flags | noFollowFlag(), mode);
}

function noFollowFlag(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      "Secure local state requires O_NOFOLLOW support.",
    );
  }
  return constants.O_NOFOLLOW;
}

function assertFileRange(position: number, length: number): void {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position + length > STATE_INDEX_LOG_MAX_BYTES
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Pinned state file range is invalid.");
  }
}

function readFdExact(fd: number, position: number, length: number, path: string): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, bytes, read, length - read, position + read);
    if (count <= 0) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Pinned state file ${path} ended during a descriptor-bound read.`,
      );
    }
    read += count;
  }
  return bytes;
}

function writeFdFully(fd: number, bytes: Uint8Array, position: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(
      fd,
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    );
    if (count <= 0) {
      throw new StateLocalError("STATE_CORRUPT", "Pinned state file write made no progress.");
    }
    written += count;
  }
}

async function readHandleBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  startPosition: number | null = null,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    throwIfReadAborted(signal);
    const remainingWithSentinel = maximumBytes - total + 1;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingWithSentinel));
    const position = startPosition === null ? null : startPosition + total;
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Secure state file exceeded its configured size bound while being read.",
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function writeHandleFully(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  startPosition: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      startPosition + written,
    );
    if (result.bytesWritten <= 0) {
      throw new StateLocalError("STATE_CORRUPT", "Pinned state file write made no progress.");
    }
    written += result.bytesWritten;
  }
}

function throwIfReadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new StateLocalError("STATE_ABORTED", "The secure file read was aborted.", signal.reason);
  }
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

function verifyFile(info: Stats, path: string, expectedLinks = 1): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== expectedLinks) {
    throw new StateLocalError(
      "STATE_PATH_INSECURE",
      `Secure state file ${path} must be a ${String(expectedLinks)}-link regular file.`,
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

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertStableFile(
  before: Stats,
  after: Stats,
  bytesRead: number,
  path: string,
): void {
  assertSameIdentity(identityOf(after), identityOf(before), path);
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytesRead !== before.size
  ) {
    throw new StateLocalError(
      "STATE_PATH_CHANGED",
      `Secure state file ${path} changed while it was being read.`,
    );
  }
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

function isSymbolicLinkLoop(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:busy|locked)/iu.test(error.message);
}

function assertIndexKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(key)
  ) {
    throw new StateLocalError("STATE_CORRUPT", "State index key is invalid.");
  }
}

function assertIndexKeyPrefix(prefix: string): void {
  if (
    typeof prefix !== "string" ||
    prefix.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(prefix)
  ) {
    throw new StateLocalError("STATE_CORRUPT", "State index prefix is invalid.");
  }
}

function assertIndexEntryLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new StateLocalError("STATE_CORRUPT", "State index entry bound is invalid.");
  }
}

function assertIndexByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new StateLocalError("STATE_CORRUPT", `State index ${name} is invalid.`);
  }
}

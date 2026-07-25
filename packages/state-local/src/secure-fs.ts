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
import { indexCompactionStagingByteLimit, resolveIndexLogLimits, STATE_INDEX_LOG_MAX_BYTES, type IndexLogLimits } from "./index-log-limits.js";

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
  /** Low-threshold seam for bounded compaction and ceiling tests. */
  readonly indexLimits?: Partial<IndexLogLimits>;
  readonly afterIndexCompactionBody?: (target: string) => void;
  readonly afterIndexCompactionPrepared?: (target: string) => void;
  readonly afterIndexCompactionCopyChunk?: (
    target: string,
    copiedBytes: number,
    totalBytes: number,
  ) => void;
  readonly afterIndexCompactionRewritten?: (target: string) => void;
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
  appendDurable(chunks: Iterable<Uint8Array>, maximumBytes?: number): number;
  copyRangeDurable(
    sourcePosition: number,
    targetPosition: number,
    length: number,
    afterChunk?: (copiedBytes: number, totalBytes: number) => void,
  ): void;
  truncateDurable(size: number): void;
  replace(bytes: Uint8Array, hooks?: AtomicReplaceHooks): Promise<void>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

const STATE_INDEX_APPLICATION_ID = 0x4d415331;
const STATE_INDEX_LOG_HEADER = Buffer.from("mono-agent-state-index-v2\n", "utf8");
const STATE_INDEX_FRAME_COMMIT_MAGIC = Buffer.from("mas-commit-v2\n", "utf8");
const STATE_INDEX_COMPACTION_MAGIC = Buffer.from("mas-compact-v1\n", "utf8");
const STATE_INDEX_FRAME_HEADER_BYTES = 8;
const STATE_INDEX_FRAME_FOOTER_BYTES = STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength + 8;
const STATE_INDEX_FRAME_METADATA_BYTES = 7;
const STATE_INDEX_COMPACTION_CONTROL_BYTES = 96;
const STATE_INDEX_DIGEST_BYTES = 32;
const STATE_INDEX_LOG_MAX_ENTRIES = 100_000;
const STATE_INDEX_COMPACTION_FRAME_OVERHEAD =
  STATE_INDEX_FRAME_HEADER_BYTES
  + STATE_INDEX_FRAME_METADATA_BYTES
  + STATE_INDEX_COMPACTION_CONTROL_BYTES
  + STATE_INDEX_DIGEST_BYTES
  + STATE_INDEX_FRAME_FOOTER_BYTES;
const STATE_INDEX_COMPACTION_MAX_BYTES =
  STATE_INDEX_LOG_MAX_BYTES * 2 + STATE_INDEX_COMPACTION_FRAME_OVERHEAD;
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
    appendDurable: (chunks, maximumBytes = STATE_INDEX_LOG_MAX_BYTES) => {
      assertPinnedOpen();
      if (
        !Number.isSafeInteger(maximumBytes)
        || maximumBytes < 0
        || maximumBytes > STATE_INDEX_COMPACTION_MAX_BYTES
      ) {
        throw new StateLocalError("STATE_CORRUPT", "Pinned append bound is invalid.");
      }
      const info = fstatSync(handle.fd);
      verifyFile(info, target, expectedLinks);
      assertSameIdentity(identityOf(info), identity, target);
      let position = info.size;
      for (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) {
          throw new StateLocalError("STATE_CORRUPT", "Pinned append chunks must be bytes.");
        }
        if (position + chunk.byteLength > maximumBytes) {
          throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Pinned state file is full.");
        }
        writeFdFully(handle.fd, chunk, position);
        position += chunk.byteLength;
      }
      fsyncSync(handle.fd);
      return info.size;
    },
    copyRangeDurable: (sourcePosition, targetPosition, length, afterChunk) => {
      assertPinnedOpen();
      assertFileRange(sourcePosition, length);
      assertFileRange(targetPosition, length);
      if (targetPosition + length > sourcePosition) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Pinned durable copy ranges must not overlap.",
        );
      }
      const info = fstatSync(handle.fd);
      verifyFile(info, target, expectedLinks);
      assertSameIdentity(identityOf(info), identity, target);
      if (sourcePosition + length > info.size) {
        throw new StateLocalError("STATE_PATH_CHANGED", "Pinned durable copy source is incomplete.");
      }
      let copied = 0;
      while (copied < length) {
        const chunkBytes = Math.min(length - copied, 64 * 1024);
        const chunk = readFdExact(
          handle.fd,
          sourcePosition + copied,
          chunkBytes,
          target,
        );
        writeFdFully(handle.fd, chunk, targetPosition + copied);
        copied += chunkBytes;
        afterChunk?.(copied, length);
      }
      fsyncSync(handle.fd);
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
      identity = await createSecureFile(path, await createLeaseDatabase());
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
  const indexLimits = resolveIndexLogLimits(hooks.indexLimits);
  let index: Map<string, IndexEntry> = new Map();
  let frameCount = 0;
  let liveFrameBytes = 0;

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
    recoverPreparedIndexCompaction(indexLog, indexLimits);
    const loaded = loadIndexLog(indexLog, indexLimits);
    index = loaded.index;
    frameCount = loaded.frameCount;
    liveFrameBytes = [...index.values()]
      .reduce((total, entry) => total + entry.frameBytes, 0);
    await indexLog.verify();
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
    if (!index.has(key) && index.size >= STATE_INDEX_LOG_MAX_ENTRIES) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Descriptor-bound state index has too many entries.");
    }
    const frame = encodeIndexFrame(key, value);
    const liveBytes = STATE_INDEX_LOG_HEADER.byteLength + liveFrameBytes;
    const obsoleteFrames = frameCount - index.size;
    const reclaimableBytes = indexLog.size() - liveBytes;
    const hardLimitPending =
      frameCount >= indexLimits.maximumFrames
      || indexLog.size() + frame.totalBytes > indexLimits.maximumBytes;
    if (
      (
        obsoleteFrames > 0
        && (
          hardLimitPending
          || obsoleteFrames >= indexLimits.compactAfterObsoleteFrames
          || reclaimableBytes >= indexLimits.compactAfterReclaimableBytes
        )
      )
      || (hardLimitPending && index.has(key))
    ) {
      try {
        const compacted = compactIndexLog(
          indexLog,
          index,
          frameCount,
          indexLimits,
          hooks,
          { key, frame },
        );
        index = compacted.index;
        frameCount = compacted.frameCount;
        liveFrameBytes = [...index.values()]
          .reduce((total, entry) => total + entry.frameBytes, 0);
        const committed = index.get(key);
        if (committed === undefined) {
          throw new StateLocalError(
            "STATE_CORRUPT",
            "Compacted state index omitted the pending entry.",
          );
        }
        return committed;
      } catch (error) {
        const appendStillFits =
          frameCount < indexLimits.maximumFrames
          && indexLog.size() + frame.totalBytes <= indexLimits.maximumBytes;
        if (error instanceof StateLocalError && error.code === "STATE_LIMIT_EXCEEDED") {
          if (!appendStillFits) throw error;
          // A threshold-triggered pass may have no recovery-safe compact image.
          // The ordinary pending append still fits below the durable ceiling.
        } else {
          failed = new StateLocalError(
            "STATE_POISONED",
            "Descriptor-bound state index compaction did not complete safely; reopen before retrying.",
            error,
          );
          throw error;
        }
      }
    }
    if (frameCount >= indexLimits.maximumFrames) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Descriptor-bound state index has too many frames.");
    }
    if (indexLog.size() + frame.totalBytes > indexLimits.maximumBytes) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Descriptor-bound state index is full.");
    }
    try {
      const frameOffset = indexLog.appendDurable([
        frame.frameHeader,
        frame.metadata,
        frame.keyBytes,
        frame.value,
        frame.digest,
      ], indexLimits.maximumBytes);
      indexLog.appendDurable([frame.footer], indexLimits.maximumBytes);
      frameCount += 1;
      const entry = {
        valueOffset:
          frameOffset +
          frame.frameHeader.byteLength +
          frame.metadata.byteLength +
          frame.keyBytes.byteLength,
        valueBytes: frame.value.byteLength,
        frameBytes: frame.totalBytes,
      };
      liveFrameBytes =
        liveFrameBytes
        - (index.get(key)?.frameBytes ?? 0)
        + entry.frameBytes;
      return entry;
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
  readonly frameBytes: number;
}

function createLeaseDatabase(): Buffer {
  // `DatabaseSync.serialize()` is not available on the minimum supported
  // Node 22 runtime. An empty SQLite database is a single, stable format-3
  // leaf page, so construct that canonical page directly instead of creating
  // a less-safe pathname-backed staging database.
  const pageBytes = 4_096;
  const database = Buffer.alloc(pageBytes);
  database.write("SQLite format 3\0", 0, "binary");
  database.writeUInt16BE(pageBytes, 16);
  database[18] = 1; // legacy rollback-journal write format
  database[19] = 1; // legacy rollback-journal read format
  database[21] = 64;
  database[22] = 32;
  database[23] = 32;
  database.writeUInt32BE(1, 28); // one database page
  database.writeUInt32BE(STATE_INDEX_APPLICATION_ID, 68);
  database[100] = 0x0d; // empty sqlite_schema leaf-table page
  database.writeUInt16BE(pageBytes, 105);
  return database;
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

interface EncodedIndexFrame {
  readonly frameHeader: Buffer;
  readonly metadata: Buffer;
  readonly keyBytes: Buffer;
  readonly value: Buffer;
  readonly digest: Buffer;
  readonly footer: Buffer;
  readonly totalBytes: number;
}

function encodeIndexFrame(key: string, value: Uint8Array): EncodedIndexFrame {
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
  const footer = encodeFrameFooter(payloadBytes);
  return {
    frameHeader,
    metadata,
    keyBytes,
    value: bytes,
    digest,
    footer,
    totalBytes:
      frameHeader.byteLength
      + payloadBytes
      + digest.byteLength
      + footer.byteLength,
  };
}

interface CompactIndexFramePlan {
  readonly frameHeader: Buffer;
  readonly metadata: Buffer;
  readonly keyBytes: Buffer;
  readonly digest: Buffer;
  readonly footer: Buffer;
  readonly source:
    | { readonly kind: "log"; readonly entry: IndexEntry }
    | { readonly kind: "bytes"; readonly value: Buffer };
  readonly totalBytes: number;
}

interface CompactIndexPlan {
  readonly compactBytes: number;
  readonly compactDigest: Buffer;
  readonly compactFrames: number;
  readonly frames: readonly CompactIndexFramePlan[];
  readonly sourceBytes: number;
  readonly sourceDigest: Buffer;
  readonly sourceFrames: number;
}

interface PendingIndexCompaction {
  readonly key: string;
  readonly frame: EncodedIndexFrame;
}

function planIndexCompaction(
  log: PinnedSecureFile,
  index: ReadonlyMap<string, IndexEntry>,
  frameCount: number,
  maximumBytes: number,
  pending: PendingIndexCompaction,
): CompactIndexPlan {
  const sourceBytes = log.size();
  const sourceDigest = hashLogRange(log, 0, sourceBytes);
  const compactHash = createHash("sha256").update(STATE_INDEX_LOG_HEADER);
  const frames: CompactIndexFramePlan[] = [];
  let compactBytes = STATE_INDEX_LOG_HEADER.byteLength;
  const keys = new Set(index.keys());
  keys.add(pending.key);
  for (const key of [...keys].sort()) {
    let frame: CompactIndexFramePlan;
    if (key === pending.key) {
      frame = {
        frameHeader: pending.frame.frameHeader,
        metadata: pending.frame.metadata,
        keyBytes: pending.frame.keyBytes,
        digest: pending.frame.digest,
        footer: pending.frame.footer,
        source: { kind: "bytes", value: pending.frame.value },
        totalBytes: pending.frame.totalBytes,
      };
    } else {
      const entry = index.get(key);
      if (entry === undefined) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Descriptor-bound compaction plan lost an indexed key.",
        );
      }
      const keyBytes = Buffer.from(key, "utf8");
      const payloadBytes =
        STATE_INDEX_FRAME_METADATA_BYTES + keyBytes.byteLength + entry.valueBytes;
      const frameHeader = encodeFrameLengths(payloadBytes);
      const metadata = Buffer.allocUnsafe(STATE_INDEX_FRAME_METADATA_BYTES);
      metadata.writeUInt8(2, 0);
      metadata.writeUInt16BE(keyBytes.byteLength, 1);
      metadata.writeUInt32BE(entry.valueBytes, 3);
      const frameHash = createHash("sha256")
        .update(frameHeader)
        .update(metadata)
        .update(keyBytes);
      for (const chunk of logRangeChunks(log, entry.valueOffset, entry.valueBytes)) {
        frameHash.update(chunk);
      }
      const digest = frameHash.digest();
      const footer = encodeFrameFooter(payloadBytes);
      frame = {
        frameHeader,
        metadata,
        keyBytes,
        digest,
        footer,
        source: { kind: "log", entry },
        totalBytes:
          frameHeader.byteLength
          + payloadBytes
          + digest.byteLength
          + footer.byteLength,
      };
    }
    compactHash.update(frame.frameHeader).update(frame.metadata).update(frame.keyBytes);
    for (const chunk of compactIndexValueChunks(log, frame)) compactHash.update(chunk);
    compactHash.update(frame.digest).update(frame.footer);
    compactBytes += frame.totalBytes;
    frames.push(frame);
  }
  if (
    compactBytes > sourceBytes
    || compactBytes > maximumBytes
    || frames.length > frameCount
  ) {
    throw new StateLocalError(
      "STATE_LIMIT_EXCEEDED",
      "Descriptor-bound state index has no reclaimable compaction image.",
    );
  }
  return {
    compactBytes,
    compactDigest: compactHash.digest(),
    compactFrames: frames.length,
    frames,
    sourceBytes,
    sourceDigest,
    sourceFrames: frameCount,
  };
}

function* compactIndexChunks(
  log: PinnedSecureFile,
  plan: CompactIndexPlan,
): Generator<Buffer> {
  yield STATE_INDEX_LOG_HEADER;
  for (const frame of plan.frames) {
    yield frame.frameHeader;
    yield frame.metadata;
    yield frame.keyBytes;
    yield* compactIndexValueChunks(log, frame);
    yield frame.digest;
    yield frame.footer;
  }
}

function* compactIndexValueChunks(
  log: PinnedSecureFile,
  frame: CompactIndexFramePlan,
): Generator<Buffer> {
  if (frame.source.kind === "bytes") {
    yield frame.source.value;
    return;
  }
  yield* logRangeChunks(
    log,
    frame.source.entry.valueOffset,
    frame.source.entry.valueBytes,
  );
}

function* logRangeChunks(
  log: PinnedSecureFile,
  position: number,
  length: number,
): Generator<Buffer> {
  let offset = 0;
  while (offset < length) {
    const chunkBytes = Math.min(length - offset, 64 * 1024);
    yield log.readAt(position + offset, chunkBytes);
    offset += chunkBytes;
  }
}

function hashLogRange(log: PinnedSecureFile, position: number, length: number): Buffer {
  const hash = createHash("sha256");
  for (const chunk of logRangeChunks(log, position, length)) hash.update(chunk);
  return hash.digest();
}

function encodeCompactionControl(plan: CompactIndexPlan): Buffer {
  const control = Buffer.alloc(STATE_INDEX_COMPACTION_CONTROL_BYTES);
  STATE_INDEX_COMPACTION_MAGIC.copy(control, 0);
  control.writeUInt8(0, STATE_INDEX_COMPACTION_MAGIC.byteLength);
  control.writeUInt32BE(plan.sourceBytes, 16);
  control.writeUInt32BE(plan.compactBytes, 20);
  control.writeUInt32BE(plan.sourceFrames, 24);
  control.writeUInt32BE(plan.compactFrames, 28);
  plan.sourceDigest.copy(control, 32);
  plan.compactDigest.copy(control, 64);
  return control;
}

interface PreparedIndexCompaction {
  readonly compactBytes: number;
  readonly compactDigest: Buffer;
  readonly compactFrames: number;
  readonly imageOffset: number;
  readonly sourceBytes: number;
  readonly sourceDigest: Buffer;
  readonly sourceFrames: number;
}

function decodeCompactionControl(
  control: Buffer,
  outerOffset: number,
): PreparedIndexCompaction {
  if (
    control.byteLength !== STATE_INDEX_COMPACTION_CONTROL_BYTES
    || !control.subarray(0, STATE_INDEX_COMPACTION_MAGIC.byteLength)
      .equals(STATE_INDEX_COMPACTION_MAGIC)
    || control.readUInt8(STATE_INDEX_COMPACTION_MAGIC.byteLength) !== 0
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction control is invalid.",
    );
  }
  const sourceBytes = control.readUInt32BE(16);
  const compactBytes = control.readUInt32BE(20);
  const sourceFrames = control.readUInt32BE(24);
  const compactFrames = control.readUInt32BE(28);
  if (
    sourceBytes !== outerOffset
    || compactBytes < STATE_INDEX_LOG_HEADER.byteLength
    || compactBytes > sourceBytes
    || compactFrames > sourceFrames
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction bounds are invalid.",
    );
  }
  return {
    compactBytes,
    compactDigest: Buffer.from(control.subarray(64, 96)),
    compactFrames,
    imageOffset:
      outerOffset
      + STATE_INDEX_FRAME_HEADER_BYTES
      + STATE_INDEX_FRAME_METADATA_BYTES
      + STATE_INDEX_COMPACTION_CONTROL_BYTES,
    sourceBytes,
    sourceDigest: Buffer.from(control.subarray(32, 64)),
    sourceFrames,
  };
}

function compactIndexLog(
  log: PinnedSecureFile,
  index: ReadonlyMap<string, IndexEntry>,
  frameCount: number,
  limits: IndexLogLimits,
  hooks: LeaseHooks,
  pending: PendingIndexCompaction,
): { readonly index: Map<string, IndexEntry>; readonly frameCount: number } {
  const sourceDigestBeforeValidation = hashLogRange(log, 0, log.size());
  const verified = loadIndexLog(log, limits);
  assertIndexLogMatchesMemory(verified, index, frameCount);
  const plan = planIndexCompaction(
    log,
    verified.index,
    frameCount,
    limits.maximumBytes,
    pending,
  );
  if (
    !plan.sourceDigest.equals(sourceDigestBeforeValidation)
    || !hashLogRange(log, 0, plan.sourceBytes).equals(plan.sourceDigest)
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index changed while compaction was planned.",
    );
  }
  const control = encodeCompactionControl(plan);
  const valueBytes = control.byteLength + plan.compactBytes;
  const payloadBytes = STATE_INDEX_FRAME_METADATA_BYTES + valueBytes;
  const frameHeader = encodeFrameLengths(payloadBytes);
  const metadata = Buffer.allocUnsafe(STATE_INDEX_FRAME_METADATA_BYTES);
  metadata.writeUInt8(3, 0);
  metadata.writeUInt16BE(0, 1);
  metadata.writeUInt32BE(valueBytes, 3);
  const outerHash = createHash("sha256")
    .update(frameHeader)
    .update(metadata)
    .update(control);
  for (const chunk of compactIndexChunks(log, plan)) outerHash.update(chunk);
  const digest = outerHash.digest();
  const footer = encodeFrameFooter(payloadBytes);
  const stageBytes =
    frameHeader.byteLength
    + payloadBytes
    + digest.byteLength
    + footer.byteLength;
  const stagingByteLimit =
    indexCompactionStagingByteLimit(limits.maximumBytes, STATE_INDEX_COMPACTION_FRAME_OVERHEAD);
  if (plan.sourceBytes + stageBytes > stagingByteLimit) {
    throw new StateLocalError(
      "STATE_LIMIT_EXCEEDED",
      "Descriptor-bound state index lacks compaction staging headroom.",
    );
  }
  function* stageBodyChunks(): Generator<Buffer> {
    yield frameHeader;
    yield metadata;
    yield control;
    yield* compactIndexChunks(log, plan);
    yield digest;
  }
  log.appendDurable(stageBodyChunks(), stagingByteLimit);
  hooks.afterIndexCompactionBody?.(log.path);
  log.appendDurable([footer], stagingByteLimit);
  hooks.afterIndexCompactionPrepared?.(log.path);
  if (!recoverPreparedIndexCompaction(
    log,
    limits,
    hooks.afterIndexCompactionRewritten,
    hooks.afterIndexCompactionCopyChunk,
  )) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Prepared descriptor-bound state index compaction was not recoverable.",
    );
  }
  return loadIndexLog(log, limits);
}

function assertIndexLogMatchesMemory(
  loaded: { readonly index: ReadonlyMap<string, IndexEntry>; readonly frameCount: number },
  expected: ReadonlyMap<string, IndexEntry>,
  expectedFrameCount: number,
): void {
  if (
    loaded.frameCount !== expectedFrameCount
    || loaded.index.size !== expected.size
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index changed before compaction.",
    );
  }
  for (const [key, entry] of expected) {
    const actual = loaded.index.get(key);
    if (
      actual === undefined
      || actual.valueOffset !== entry.valueOffset
      || actual.valueBytes !== entry.valueBytes
      || actual.frameBytes !== entry.frameBytes
    ) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Descriptor-bound state index changed before compaction.",
      );
    }
  }
}

function recoverPreparedIndexCompaction(
  log: PinnedSecureFile,
  limits: IndexLogLimits,
  afterRewrite?: (target: string) => void,
  afterCopyChunk?: (
    target: string,
    copiedBytes: number,
    totalBytes: number,
  ) => void,
): boolean {
  const size = log.size();
  if (size < STATE_INDEX_FRAME_FOOTER_BYTES) return false;
  const footer = log.readAt(
    size - STATE_INDEX_FRAME_FOOTER_BYTES,
    STATE_INDEX_FRAME_FOOTER_BYTES,
  );
  if (
    !footer.subarray(0, STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength)
      .equals(STATE_INDEX_FRAME_COMMIT_MAGIC)
  ) {
    return false;
  }
  const payloadBytes = decodeFrameLengths(
    footer.subarray(STATE_INDEX_FRAME_COMMIT_MAGIC.byteLength),
    "compaction footer",
  );
  const totalFrameBytes =
    STATE_INDEX_FRAME_HEADER_BYTES
    + payloadBytes
    + STATE_INDEX_DIGEST_BYTES
    + STATE_INDEX_FRAME_FOOTER_BYTES;
  const frameOffset = size - totalFrameBytes;
  if (
    frameOffset < STATE_INDEX_LOG_HEADER.byteLength
    || payloadBytes
      < STATE_INDEX_FRAME_METADATA_BYTES + STATE_INDEX_COMPACTION_CONTROL_BYTES
  ) {
    return false;
  }
  const frameHeader = log.readAt(frameOffset, STATE_INDEX_FRAME_HEADER_BYTES);
  if (decodeFrameLengths(frameHeader, "compaction header") !== payloadBytes) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction lengths differ.",
    );
  }
  const metadataOffset = frameOffset + frameHeader.byteLength;
  const metadata = log.readAt(metadataOffset, STATE_INDEX_FRAME_METADATA_BYTES);
  if (metadata.readUInt8(0) !== 3) return false;
  const keyBytes = metadata.readUInt16BE(1);
  const valueBytes = metadata.readUInt32BE(3);
  if (
    keyBytes !== 0
    || payloadBytes !== STATE_INDEX_FRAME_METADATA_BYTES + valueBytes
    || valueBytes < STATE_INDEX_COMPACTION_CONTROL_BYTES
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction frame is invalid.",
    );
  }
  const controlOffset = metadataOffset + metadata.byteLength;
  const control = log.readAt(controlOffset, STATE_INDEX_COMPACTION_CONTROL_BYTES);
  const prepared = decodeCompactionControl(control, frameOffset);
  if (
    valueBytes !== STATE_INDEX_COMPACTION_CONTROL_BYTES + prepared.compactBytes
    || prepared.sourceBytes + totalFrameBytes !== size
    || prepared.sourceBytes > limits.maximumBytes
    || size > indexCompactionStagingByteLimit(
      limits.maximumBytes, STATE_INDEX_COMPACTION_FRAME_OVERHEAD,
    )
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction size is invalid.",
    );
  }
  const digestOffset = prepared.imageOffset + prepared.compactBytes;
  const expectedOuterDigest = log.readAt(digestOffset, STATE_INDEX_DIGEST_BYTES);
  const outerHash = createHash("sha256");
  for (const chunk of logRangeChunks(
    log,
    frameOffset,
    digestOffset - frameOffset,
  )) {
    outerHash.update(chunk);
  }
  if (!outerHash.digest().equals(expectedOuterDigest)) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction digest is invalid.",
    );
  }
  if (
    !hashLogRange(log, prepared.imageOffset, prepared.compactBytes)
      .equals(prepared.compactDigest)
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compact image digest is invalid.",
    );
  }
  const compacted = loadIndexLogRange(
    log,
    limits,
    prepared.imageOffset,
    prepared.compactBytes,
    false,
    true,
  );
  if (compacted.frameCount !== prepared.compactFrames) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compact frame count is invalid.",
    );
  }
  log.copyRangeDurable(
    prepared.imageOffset,
    0,
    prepared.compactBytes,
    (copiedBytes, totalBytes) => {
      afterCopyChunk?.(log.path, copiedBytes, totalBytes);
    },
  );
  afterRewrite?.(log.path);
  log.truncateDurable(prepared.compactBytes);
  return true;
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
  limits: IndexLogLimits,
): { readonly index: Map<string, IndexEntry>; readonly frameCount: number } {
  return loadIndexLogRange(log, limits, 0, log.size(), true, false);
}

function loadIndexLogRange(
  log: PinnedSecureFile,
  limits: IndexLogLimits,
  start: number,
  size: number,
  repairTail: boolean,
  requireCanonicalOrder: boolean,
): { readonly index: Map<string, IndexEntry>; readonly frameCount: number } {
  const maximumRangeBytes = repairTail && start === 0
    ? indexCompactionStagingByteLimit(
        limits.maximumBytes, STATE_INDEX_COMPACTION_FRAME_OVERHEAD,
      )
    : limits.maximumBytes;
  if (
    size < STATE_INDEX_LOG_HEADER.byteLength
    || size > maximumRangeBytes
    || start < 0
    || start + size > log.size()
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index has an invalid size.");
  }
  if (!log.readAt(start, STATE_INDEX_LOG_HEADER.byteLength).equals(STATE_INDEX_LOG_HEADER)) {
    throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index header is invalid.");
  }

  const index = new Map<string, IndexEntry>();
  let frameCount = 0;
  let previousKey: string | undefined;
  let offset = start + STATE_INDEX_LOG_HEADER.byteLength;
  const end = start + size;
  while (offset < end) {
    const remaining = end - offset;
    if (remaining < STATE_INDEX_FRAME_HEADER_BYTES) {
      if (!repairTail) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Descriptor-bound state index compact image is incomplete.",
        );
      }
      log.truncateDurable(offset);
      break;
    }
    const frameHeader = log.readAt(offset, STATE_INDEX_FRAME_HEADER_BYTES);
    const payloadBytes = decodeFrameLengths(frameHeader, "header");
    const maximumCompactionPayloadBytes =
      limits.maximumBytes
      + STATE_INDEX_FRAME_METADATA_BYTES
      + STATE_INDEX_COMPACTION_CONTROL_BYTES;
    if (
      payloadBytes < STATE_INDEX_FRAME_METADATA_BYTES ||
      payloadBytes > maximumCompactionPayloadBytes
    ) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index frame is invalid.");
    }
    const totalFrameBytes =
      frameHeader.byteLength +
      payloadBytes +
      STATE_INDEX_DIGEST_BYTES +
      STATE_INDEX_FRAME_FOOTER_BYTES;
    if (remaining < totalFrameBytes) {
      if (
        repairTail
        && isProvenIncompleteCompaction(
          log,
          offset,
          end,
          payloadBytes,
          frameCount,
          limits,
        )
      ) {
        log.truncateDurable(offset);
        break;
      }
      if (payloadBytes > limits.maximumBytes) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Descriptor-bound state index frame is invalid.",
        );
      }
      if (!repairTail) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Descriptor-bound state index compact image is incomplete.",
        );
      }
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
    if (version === 3) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Descriptor-bound state index contains an unrecovered compaction frame.",
      );
    }
    if (
      version !== 2 ||
      payloadBytes > limits.maximumBytes ||
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
    if (
      requireCanonicalOrder
      && previousKey !== undefined
      && key <= previousKey
    ) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Descriptor-bound compact state index keys are not canonical.",
      );
    }
    previousKey = key;
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
    if (frameCount > limits.maximumFrames) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index has too many frames.");
    }
    if (!index.has(key) && index.size >= STATE_INDEX_LOG_MAX_ENTRIES) {
      throw new StateLocalError("STATE_CORRUPT", "Descriptor-bound state index has too many entries.");
    }
    index.set(key, { valueOffset, valueBytes, frameBytes: totalFrameBytes });
    offset += totalFrameBytes;
  }
  if (requireCanonicalOrder && frameCount !== index.size) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound compact state index contains duplicate keys.",
    );
  }
  if (repairTail && log.size() > limits.maximumBytes) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index exceeds its durable byte ceiling.",
    );
  }
  return { index, frameCount };
}

function isProvenIncompleteCompaction(
  log: PinnedSecureFile,
  frameOffset: number,
  end: number,
  payloadBytes: number,
  frameCount: number,
  limits: IndexLogLimits,
): boolean {
  const metadataOffset = frameOffset + STATE_INDEX_FRAME_HEADER_BYTES;
  const controlOffset = metadataOffset + STATE_INDEX_FRAME_METADATA_BYTES;
  if (end - metadataOffset < STATE_INDEX_FRAME_METADATA_BYTES) return false;
  const metadata = log.readAt(metadataOffset, STATE_INDEX_FRAME_METADATA_BYTES);
  if (metadata.readUInt8(0) !== 3) return false;
  if (
    metadata.readUInt16BE(1) !== 0
    || metadata.readUInt32BE(3) < STATE_INDEX_COMPACTION_CONTROL_BYTES
    || payloadBytes
      !== STATE_INDEX_FRAME_METADATA_BYTES + metadata.readUInt32BE(3)
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction prefix is invalid.",
    );
  }
  if (end - controlOffset < STATE_INDEX_COMPACTION_CONTROL_BYTES) return true;
  const prepared = decodeCompactionControl(
    log.readAt(controlOffset, STATE_INDEX_COMPACTION_CONTROL_BYTES),
    frameOffset,
  );
  if (
    prepared.sourceFrames !== frameCount
    || prepared.sourceBytes > limits.maximumBytes
    || !hashLogRange(log, 0, prepared.sourceBytes).equals(prepared.sourceDigest)
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction source is invalid.",
    );
  }
  return true;
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
    position + length > STATE_INDEX_COMPACTION_MAX_BYTES
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

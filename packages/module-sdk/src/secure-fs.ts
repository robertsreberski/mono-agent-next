import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { boundedInteger } from "./bounded-integer.js";
const READ_CHUNK_BYTES = 64 * 1024;
export const OWNER_PRIVATE_DIRECTORY_MODE = 0o700;
export const OWNER_PRIVATE_FILE_MODE = 0o600;
export const DEFAULT_OWNER_PRIVATE_READ_MAX_BYTES = 1_048_576;
export type OwnerPrivatePathErrorCode =
  | "invalid_path"
  | "unsupported_platform"
  | "missing"
  | "wrong_type"
  | "wrong_owner"
  | "wrong_mode"
  | "multiple_links"
  | "identity_changed"
  | "already_exists"
  | "version_conflict"
  | "too_large"
  | "io_failed";
export interface OwnerPrivatePathIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly uid: number;
  readonly mode: number;
  readonly links: number;
  readonly size: number;
}
export class OwnerPrivatePathError extends Error {
  readonly code: OwnerPrivatePathErrorCode;
  readonly path: string;
  /** True when the destination was atomically published before a later operation failed. */
  readonly committed: boolean;
  constructor(options: {
    readonly code: OwnerPrivatePathErrorCode;
    readonly path: string;
    readonly message: string;
    readonly committed?: boolean;
    readonly cause?: unknown;
  }) {
    if (options.cause === undefined) super(options.message);
    else super(options.message, { cause: options.cause });
    this.name = "OwnerPrivatePathError";
    this.code = options.code;
    this.path = options.path;
    this.committed = options.committed ?? false;
  }
}
export interface OwnerPrivateOperationOptions {
  readonly signal?: AbortSignal;
}
export interface ReadOwnerPrivateFileOptions extends OwnerPrivateOperationOptions {
  readonly maxBytes?: number;
}
export interface AtomicReplaceOwnerPrivateFileOptions extends OwnerPrivateOperationOptions {
  /** Undefined accepts either state; null requires absence; an identity is compare-and-swap. */
  readonly expected?: OwnerPrivatePathIdentity | null;
}
/** Create one directory level or validate an existing exact owner-private directory. */
export async function ensureOwnerPrivateDirectory(
  path: string,
  options: OwnerPrivateOperationOptions = {},
): Promise<OwnerPrivatePathIdentity> {
  const absolutePath = checkedAbsolutePath(path);
  throwIfAborted(options.signal);
  await inspectOwnerPrivateDirectory(dirname(absolutePath), options);
  let created = false;
  try {
    await mkdir(absolutePath, { mode: OWNER_PRIVATE_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw ioError(absolutePath, "Unable to create owner-private directory", error);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, readOnlyNoFollowFlags(true));
    if (created) await handle.chmod(OWNER_PRIVATE_DIRECTORY_MODE);
    const identity = await validateHandleIdentity(handle, absolutePath, "directory");
    throwIfAborted(options.signal);
    return identity;
  } catch (error) {
    if (error instanceof OwnerPrivatePathError) throw error;
    throw ioError(absolutePath, "Unable to validate owner-private directory", error);
  } finally {
    await handle?.close();
  }
}
export async function inspectOwnerPrivateDirectory(
  path: string,
  options: OwnerPrivateOperationOptions = {},
): Promise<OwnerPrivatePathIdentity> {
  return inspectPath(path, "directory", options.signal);
}
export async function inspectOwnerPrivateFile(
  path: string,
  options: OwnerPrivateOperationOptions = {},
): Promise<OwnerPrivatePathIdentity> {
  return inspectPath(path, "file", options.signal);
}
export async function readOwnerPrivateFile(
  path: string,
  options: ReadOwnerPrivateFileOptions = {},
): Promise<Uint8Array> {
  const absolutePath = checkedAbsolutePath(path);
  const maxBytes = boundedInteger(
    options.maxBytes ?? DEFAULT_OWNER_PRIVATE_READ_MAX_BYTES,
    "maxBytes",
    1,
    1_073_741_824,
    (message) => new RangeError(message),
  );
  throwIfAborted(options.signal);
  await inspectOwnerPrivateDirectory(dirname(absolutePath), options);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, readOnlyNoFollowFlags(false));
    const before = await validateHandleIdentity(handle, absolutePath, "file");
    if (before.size > maxBytes) throw pathError("too_large", absolutePath, `File exceeds ${maxBytes} bytes`);
    const bytes = await readAtMost(handle, absolutePath, maxBytes, options.signal);
    const after = identityFromStat(absolutePath, await handle.stat());
    if (!sameFileSnapshot(before, after)) {
      throw pathError("identity_changed", absolutePath, "File changed while being read");
    }
    await assertPathMatches(after, "file");
    throwIfAborted(options.signal);
    return bytes;
  } catch (error) {
    if (error instanceof OwnerPrivatePathError) throw error;
    if (hasErrorCode(error, "ENOENT")) throw pathError("missing", absolutePath, "Owner-private file does not exist", error);
    throw ioError(absolutePath, "Unable to read owner-private file", error);
  } finally {
    await handle?.close();
  }
}
async function readAtMost(
  handle: FileHandle,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    throwIfAborted(signal);
    const capacity = Math.min(READ_CHUNK_BYTES, maxBytes - total + 1);
    const chunk = new Uint8Array(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw pathError("too_large", path, `File exceeds ${maxBytes} bytes`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
export async function createOwnerPrivateFile(
  path: string,
  data: string | Uint8Array,
  options: OwnerPrivateOperationOptions = {},
): Promise<OwnerPrivatePathIdentity> {
  const absolutePath = checkedAbsolutePath(path);
  throwIfAborted(options.signal);
  const parent = await inspectOwnerPrivateDirectory(dirname(absolutePath), options);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let handle: FileHandle | undefined;
  let createdIdentity: OwnerPrivatePathIdentity | undefined;
  try {
    handle = await open(absolutePath, writeExclusiveNoFollowFlags(), OWNER_PRIVATE_FILE_MODE);
    await handle.chmod(OWNER_PRIVATE_FILE_MODE);
    createdIdentity = await validateHandleIdentity(handle, absolutePath, "file");
    await handle.writeFile(bytes);
    await handle.sync();
    const finalIdentity = await validateHandleIdentity(handle, absolutePath, "file");
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
    throwIfAborted(options.signal);
    return finalIdentity;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw pathError("already_exists", absolutePath, "Owner-private file already exists", error);
    }
    if (createdIdentity !== undefined) await unlinkIfSameIdentity(createdIdentity);
    if (error instanceof OwnerPrivatePathError) throw error;
    throw ioError(absolutePath, "Unable to create owner-private file", error);
  } finally {
    await handle?.close();
  }
}
/**
 * Durably replace one file from a same-directory exclusive temporary file.
 * Existing targets are opened with O_NOFOLLOW and never path-chmodded.
 */
export async function atomicReplaceOwnerPrivateFile(
  path: string,
  data: string | Uint8Array,
  options: AtomicReplaceOwnerPrivateFileOptions = {},
): Promise<OwnerPrivatePathIdentity> {
  const absolutePath = checkedAbsolutePath(path);
  throwIfAborted(options.signal);
  const parentPath = dirname(absolutePath);
  const parent = await inspectOwnerPrivateDirectory(parentPath, options);
  const current = await inspectOptionalOwnerPrivateFile(absolutePath, options.signal);
  assertExpectedIdentity(absolutePath, current, options.expected);
  const temporaryPath = resolve(parentPath, `.${basename(absolutePath)}.${randomUUID()}.tmp`);
  let temporary: OwnerPrivatePathIdentity | undefined;
  let committed = false;
  try {
    temporary = await createOwnerPrivateFile(temporaryPath, data, options);
    throwIfAborted(options.signal);
    await assertPathMatches(parent, "directory");
    const latest = await inspectOptionalOwnerPrivateFile(absolutePath, options.signal);
    assertExpectedIdentity(absolutePath, latest, current ?? null);
    if (current === undefined) {
      try {
        // link(2), unlike rename(2), atomically refuses to replace a name that
        // appeared after the absence check. Remove the temporary name only
        // after the destination link exists.
        await link(temporaryPath, absolutePath);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          throw pathError("already_exists", absolutePath, "Atomic create target appeared before commit", error);
        }
        throw error;
      }
      committed = true;
      await unlinkCommittedTemporary(temporary);
    } else {
      await rename(temporaryPath, absolutePath);
      committed = true;
    }
    const result = await inspectOwnerPrivateFile(absolutePath, options);
    if (!sameIdentity(temporary, result)) {
      throw pathError("identity_changed", absolutePath, "Atomic replacement identity changed after rename");
    }
    await syncDirectory(parent);
    await assertPathMatches(parent, "directory");
    throwIfAborted(options.signal);
    return result;
  } catch (error) {
    if (temporary !== undefined) await unlinkIfSameIdentity(temporary);
    if (error instanceof OwnerPrivatePathError) {
      if (!committed || error.committed) throw error;
      throw new OwnerPrivatePathError({
        code: error.code,
        path: error.path,
        message: error.message,
        committed: true,
        cause: error,
      });
    }
    throw new OwnerPrivatePathError({
      code: "io_failed",
      path: absolutePath,
      message: committed
        ? "Atomic replacement committed but durability verification failed"
        : "Atomic replacement failed before commit",
      committed,
      cause: error,
    });
  }
}
async function inspectPath(
  path: string,
  type: "file" | "directory",
  signal: AbortSignal | undefined,
): Promise<OwnerPrivatePathIdentity> {
  const absolutePath = checkedAbsolutePath(path);
  throwIfAborted(signal);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, readOnlyNoFollowFlags(type === "directory"));
    const identity = await validateHandleIdentity(handle, absolutePath, type);
    throwIfAborted(signal);
    return identity;
  } catch (error) {
    if (error instanceof OwnerPrivatePathError) throw error;
    if (hasErrorCode(error, "ENOENT")) throw pathError("missing", absolutePath, `${type} does not exist`, error);
    if (hasErrorCode(error, "ELOOP")) throw pathError("wrong_type", absolutePath, `${type} must not be a symbolic link`, error);
    throw ioError(absolutePath, `Unable to inspect owner-private ${type}`, error);
  } finally {
    await handle?.close();
  }
}
async function inspectOptionalOwnerPrivateFile(
  path: string,
  signal: AbortSignal | undefined,
): Promise<OwnerPrivatePathIdentity | undefined> {
  try {
    return await inspectOwnerPrivateFile(path, { ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    if (error instanceof OwnerPrivatePathError && error.code === "missing") return undefined;
    throw error;
  }
}
async function validateHandleIdentity(
  handle: FileHandle,
  path: string,
  type: "file" | "directory",
): Promise<OwnerPrivatePathIdentity> {
  const stat = await handle.stat();
  const identity = identityFromStat(path, stat);
  if ((type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) {
    throw pathError("wrong_type", path, `Expected a regular ${type}`);
  }
  const uid = currentUid(path);
  if (identity.uid !== uid) throw pathError("wrong_owner", path, `${type} is not owned by the current user`);
  const expectedMode = type === "file" ? OWNER_PRIVATE_FILE_MODE : OWNER_PRIVATE_DIRECTORY_MODE;
  if (identity.mode !== expectedMode) {
    throw pathError("wrong_mode", path, `${type} mode must be exactly ${expectedMode.toString(8)}`);
  }
  if (type === "file" && identity.links !== 1) {
    throw pathError("multiple_links", path, "Owner-private files must have exactly one hard link");
  }
  await assertPathMatches(identity, type);
  return identity;
}
async function assertPathMatches(
  identity: OwnerPrivatePathIdentity,
  type: "file" | "directory",
): Promise<void> {
  let pathStat;
  try {
    pathStat = await lstat(identity.path);
  } catch (error) {
    throw pathError("identity_changed", identity.path, `${type} path disappeared`, error);
  }
  if (pathStat.isSymbolicLink()
    || (type === "file" && !pathStat.isFile())
    || (type === "directory" && !pathStat.isDirectory())
    || pathStat.dev !== identity.device
    || pathStat.ino !== identity.inode) {
    throw pathError("identity_changed", identity.path, `${type} path no longer names the opened object`);
  }
}
async function syncDirectory(identity: OwnerPrivatePathIdentity): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(identity.path, readOnlyNoFollowFlags(true));
    const current = await validateHandleIdentity(handle, identity.path, "directory");
    if (!sameIdentity(identity, current)) throw pathError("identity_changed", identity.path, "Parent directory changed");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
async function unlinkIfSameIdentity(identity: OwnerPrivatePathIdentity): Promise<void> {
  try {
    const current = await lstat(identity.path);
    if (!current.isSymbolicLink() && current.dev === identity.device && current.ino === identity.inode) {
      await unlink(identity.path);
    }
  } catch {
    // Cleanup is best-effort and must never unlink an identity we did not create.
  }
}
async function unlinkCommittedTemporary(identity: OwnerPrivatePathIdentity): Promise<void> {
  try {
    await unlink(identity.path);
  } catch (error) {
    await unlinkIfSameIdentity(identity);
    try {
      const remaining = await lstat(identity.path);
      if (!remaining.isSymbolicLink() && remaining.dev === identity.device
        && remaining.ino === identity.inode) throw error;
    } catch (inspectionError) {
      if (!hasErrorCode(inspectionError, "ENOENT")) throw inspectionError;
    }
  }
}
function assertExpectedIdentity(
  path: string,
  current: OwnerPrivatePathIdentity | undefined,
  expected: OwnerPrivatePathIdentity | null | undefined,
): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (current !== undefined) throw pathError("already_exists", path, "Atomic create expected the target to be absent");
    return;
  }
  if (current === undefined || !sameIdentity(current, expected)) {
    throw pathError("version_conflict", path, "Atomic replacement target changed before commit");
  }
}
function identityFromStat(path: string, stat: Stats): OwnerPrivatePathIdentity {
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
function sameIdentity(left: OwnerPrivatePathIdentity, right: OwnerPrivatePathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}
function sameFileSnapshot(left: OwnerPrivatePathIdentity, right: OwnerPrivatePathIdentity): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode
    && left.links === right.links
    && left.size === right.size;
}
function currentUid(path: string): number {
  if (typeof process.getuid !== "function") {
    throw pathError("unsupported_platform", path, "Owner validation requires process.getuid()");
  }
  return process.getuid();
}
function readOnlyNoFollowFlags(directory: boolean): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw pathError("unsupported_platform", "<platform>", "O_NOFOLLOW is unavailable");
  }
  if (directory && typeof constants.O_DIRECTORY !== "number") {
    throw pathError("unsupported_platform", "<platform>", "O_DIRECTORY is unavailable");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
}
function writeExclusiveNoFollowFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw pathError("unsupported_platform", "<platform>", "O_NOFOLLOW is unavailable");
  }
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
}
function checkedAbsolutePath(path: string): string {
  if (path.length === 0 || path.includes("\0")) throw pathError("invalid_path", path, "Path must not be empty or contain NUL");
  const absolutePath = resolve(path);
  if (basename(absolutePath) === "." || basename(absolutePath) === "..") {
    throw pathError("invalid_path", absolutePath, "Path must name a concrete entry");
  }
  return absolutePath;
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
function hasErrorCode(value: unknown, code: string): boolean {
  return value !== null && typeof value === "object" && Reflect.get(value, "code") === code;
}
function pathError(
  code: OwnerPrivatePathErrorCode,
  path: string,
  message: string,
  cause?: unknown,
): OwnerPrivatePathError {
  return new OwnerPrivatePathError({ code, path, message, ...(cause === undefined ? {} : { cause }) });
}
function ioError(path: string, message: string, cause: unknown): OwnerPrivatePathError {
  return pathError("io_failed", path, message, cause);
}

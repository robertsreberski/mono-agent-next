// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { LoadedAuthoritySource } from "./types.js";
export const DEFAULT_AUTHORITY_MAX_BYTES = 1_000_000;
const READ_CHUNK_BYTES = 64 * 1024;
export type AuthorityReadErrorCode =
  | "invalid_path"
  | "unsupported_platform"
  | "missing"
  | "wrong_type"
  | "multiple_links"
  | "too_large"
  | "identity_changed"
  | "invalid_utf8"
  | "io_failed";
export class AuthorityReadError extends Error {
  readonly code: AuthorityReadErrorCode;
  readonly path: string;
  constructor(options: {
    readonly code: AuthorityReadErrorCode;
    readonly path: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    if (options.cause === undefined) super(options.message);
    else super(options.message, { cause: options.cause });
    this.name = "AuthorityReadError";
    this.code = options.code;
    this.path = options.path;
  }
}
export interface ReadAuthorityFileOptions {
  readonly maxBytes?: number;
  readonly requireSingleLink?: boolean;
  readonly signal?: AbortSignal;
  /** Deterministic race seam for Core security tests. */
  readonly beforePathIdentityCheck?: () => void | Promise<void>;
}
export interface AuthorityFileSnapshot {
  readonly source: LoadedAuthoritySource;
  readonly bytes: Uint8Array;
}
/**
 * Read one authority-bearing file through the descriptor that was opened with
 * O_NOFOLLOW. Bytes are withheld until the descriptor and final pathname still
 * identify the same stable regular file.
 */
export async function readAuthorityFile(
  path: string,
  options: ReadAuthorityFileOptions = {},
): Promise<AuthorityFileSnapshot> {
  const absolutePath = checkedPath(path);
  const maxBytes = boundedMaxBytes(options.maxBytes ?? DEFAULT_AUTHORITY_MAX_BYTES);
  const requireSingleLink = options.requireSingleLink ?? true;
  throwIfAborted(options.signal);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, noFollowReadFlags());
    const before = await handle.stat({ bigint: true });
    validateRegularFile(absolutePath, before, requireSingleLink);
    const bytes = await readMaxPlusOne(handle, absolutePath, maxBytes, options.signal);
    const after = await handle.stat({ bigint: true });
    validateRegularFile(absolutePath, after, requireSingleLink);
    if (!sameSnapshot(before, after) || after.size !== BigInt(bytes.byteLength)) {
      throw authorityError(
        "identity_changed",
        absolutePath,
        "Authority file changed while it was being read",
      );
    }
    await options.beforePathIdentityCheck?.();
    throwIfAborted(options.signal);
    await assertPathIdentity(absolutePath, after, requireSingleLink);
    throwIfAborted(options.signal);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return Object.freeze({
      source: Object.freeze({
        path: absolutePath,
        sha256,
        sizeBytes: bytes.byteLength,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        modifiedAtNs: after.mtimeNs.toString(),
      }),
      bytes,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof AuthorityReadError) throw error;
    if (hasCode(error, "ENOENT")) {
      throw authorityError("missing", absolutePath, "Authority file does not exist", error);
    }
    if (hasCode(error, "ELOOP")) {
      throw authorityError("wrong_type", absolutePath, "Authority file must not be a symbolic link", error);
    }
    throw authorityError("io_failed", absolutePath, "Could not read authority file", error);
  } finally {
    await handle?.close();
  }
}
export function decodeAuthorityText(snapshot: AuthorityFileSnapshot): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch (error) {
    throw authorityError(
      "invalid_utf8",
      snapshot.source.path,
      "Authority file must contain valid UTF-8",
      error,
    );
  }
}
async function readMaxPlusOne(
  handle: FileHandle,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= maxBytes) {
    throwIfAborted(signal);
    const requested = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
    const buffer = new Uint8Array(requested);
    const { bytesRead } = await handle.read(buffer, 0, requested, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw authorityError("too_large", path, `Authority file exceeds ${maxBytes} bytes`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  throw error;
}
function validateRegularFile(
  path: string,
  stat: BigIntStats,
  requireSingleLink: boolean,
): void {
  if (!stat.isFile()) {
    throw authorityError("wrong_type", path, "Authority file must be a regular file");
  }
  if (requireSingleLink && stat.nlink !== 1n) {
    throw authorityError("multiple_links", path, "Authority file must have exactly one hard link");
  }
}
async function assertPathIdentity(
  path: string,
  expected: BigIntStats,
  requireSingleLink: boolean,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    throw authorityError("identity_changed", path, "Authority file path disappeared after reading", error);
  }
  validateRegularFile(path, current, requireSingleLink);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw authorityError(
      "identity_changed",
      path,
      "Authority file path no longer identifies the opened file",
    );
  }
}
function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}
function noFollowReadFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw authorityError(
      "unsupported_platform",
      "<platform>",
      "Secure authority reads require O_NOFOLLOW",
    );
  }
  return constants.O_RDONLY
    | constants.O_NOFOLLOW
    | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
}
function checkedPath(path: string): string {
  if (path.length === 0 || path.includes("\0")) {
    throw authorityError("invalid_path", path, "Authority path must not be empty or contain NUL");
  }
  return resolve(path);
}
function boundedMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new RangeError("maxBytes must be an integer from 1 through 1073741824");
  }
  return value;
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
function authorityError(
  code: AuthorityReadErrorCode,
  path: string,
  message: string,
  cause?: unknown,
): AuthorityReadError {
  return new AuthorityReadError({
    code,
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";

const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const EDIT_MAX_PATH_BYTES = 4 * 1024;
export const EDIT_MAX_STRING_BYTES = 256 * 1024;
export const EDIT_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface LiteralEditInput {
  readonly filePath: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

export interface LiteralEditResult {
  readonly path: string;
  readonly replacements: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly sha256Before: string;
  readonly sha256After: string;
}

export interface LiteralEditOptions {
  readonly signal?: AbortSignal;
  /** Test-only race seam before the exclusive temporary file is created. */
  readonly beforeTemporaryCreate?: () => void | Promise<void>;
  /** Test-only failure seam immediately after exclusive temporary creation. */
  readonly afterTemporaryCreate?: () => void | Promise<void>;
  /**
   * Test-only race seam. Production callers omit it. The implementation
   * revalidates the target identity and bytes after this hook and before rename.
   */
  readonly beforeCommit?: (
    context: { readonly temporaryPath: string },
  ) => void | Promise<void>;
  /** Test-only race seam followed by one last full target/temp/ancestor check. */
  readonly beforeRename?: () => void | Promise<void>;
}

interface FileSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
}

interface InspectedTarget {
  readonly rootPath: string;
  readonly root: FileSnapshot;
  readonly ancestors: readonly {
    readonly path: string;
    readonly snapshot: FileSnapshot;
  }[];
  readonly parentPath: string;
  readonly parent: FileSnapshot;
  readonly targetPath: string;
}

function editError(message: string): Error {
  return new Error(`Edit failed: ${message}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Edit aborted.", "AbortError");
}

function requireNoFollow(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw editError("this platform does not support O_NOFOLLOW.");
  }
  return constants.O_NOFOLLOW;
}

function requireDirectoryFlag(): number {
  if (typeof constants.O_DIRECTORY !== "number") {
    throw editError("this platform does not support O_DIRECTORY.");
  }
  return constants.O_DIRECTORY;
}

function snapshot(stat: BigIntStats): FileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    links: stat.nlink,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
  };
}

function sameIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode
    && left.links === right.links
    && left.size === right.size
    && left.modifiedAtNs === right.modifiedAtNs
    && left.changedAtNs === right.changedAtNs;
}

function sameCommittedSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode
    && left.links === right.links
    && left.size === right.size
    && left.modifiedAtNs === right.modifiedAtNs;
}

function sameDirectoryIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode;
}

function pathInside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder !== ""
    && !isAbsolute(remainder)
    && remainder !== ".."
    && !remainder.startsWith(`..${sep}`);
}

export function validateLiteralEditInput(input: LiteralEditInput): void {
  if (typeof input.filePath !== "string"
    || input.filePath.length === 0
    || input.filePath.includes("\0")) {
    throw editError("file_path must be a non-empty path without NUL bytes.");
  }
  if (Buffer.byteLength(input.filePath, "utf8") > EDIT_MAX_PATH_BYTES) {
    throw editError(`file_path exceeds ${String(EDIT_MAX_PATH_BYTES)} UTF-8 bytes.`);
  }
  if (typeof input.oldString !== "string" || input.oldString.length === 0) {
    throw editError("old_string must be a non-empty string.");
  }
  if (typeof input.newString !== "string") {
    throw editError("new_string must be a string.");
  }
  for (const [name, value] of [
    ["old_string", input.oldString],
    ["new_string", input.newString],
  ] as const) {
    if (Buffer.byteLength(value, "utf8") > EDIT_MAX_STRING_BYTES) {
      throw editError(`${name} exceeds ${String(EDIT_MAX_STRING_BYTES)} UTF-8 bytes.`);
    }
  }
  if (typeof input.replaceAll !== "boolean") {
    throw editError("replace_all must be a boolean.");
  }
}

function resolveWorkspaceTarget(
  workspaceDirectory: string,
  filePath: string,
): { readonly workspace: string; readonly target: string; readonly relativePath: string } {
  const workspace = resolve(workspaceDirectory);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath);
  if (!pathInside(workspace, target)) {
    throw editError("file_path must name a file within the runtime workspace.");
  }
  return { workspace, target, relativePath: relative(workspace, target) };
}

async function statNoFollow(path: string): Promise<{ readonly stat: BigIntStats; readonly snapshot: FileSnapshot }> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink()) throw editError(`${path} must not be a symbolic link.`);
  return { stat, snapshot: snapshot(stat) };
}

async function inspectTarget(
  workspace: string,
  relativePath: string,
): Promise<InspectedTarget> {
  const rootPath = await realpath(workspace);
  const rootEntry = await statNoFollow(rootPath);
  if (!rootEntry.stat.isDirectory()) {
    throw editError("runtime workspace must be a directory.");
  }

  const segments = relativePath.split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw editError("file_path must name a file.");
  let cursor = rootPath;
  let parentPath = rootPath;
  let parent = rootEntry.snapshot;
  const ancestors = [{ path: rootPath, snapshot: rootEntry.snapshot }];
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    const entry = await statNoFollow(cursor);
    const isTarget = index === segments.length - 1;
    if (!isTarget && !entry.stat.isDirectory()) {
      throw editError(`${cursor} must be a directory.`);
    }
    if (isTarget) {
      if (!entry.stat.isFile()) throw editError(`${cursor} must be a regular file.`);
      if (entry.stat.nlink !== 1n) {
        throw editError(`${cursor} must have exactly one hard link.`);
      }
      return {
        rootPath,
        root: rootEntry.snapshot,
        ancestors,
        parentPath,
        parent,
        targetPath: cursor,
      };
    }
    parentPath = cursor;
    parent = entry.snapshot;
    ancestors.push({ path: cursor, snapshot: entry.snapshot });
  }
  throw editError("file_path must name a file.");
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    throwIfAborted(signal);
    const capacity = Math.min(READ_CHUNK_BYTES, maxBytes - total + 1);
    const chunk = new Uint8Array(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw editError(`file exceeds ${String(maxBytes)} bytes.`);
    }
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

async function openCheckedFile(
  path: string,
  expected: FileSnapshot | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  readonly handle: FileHandle;
  readonly snapshot: FileSnapshot;
  readonly bytes: Uint8Array;
}> {
  throwIfAborted(signal);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | requireNoFollow());
    const beforeStat = await handle.stat({ bigint: true });
    if (!beforeStat.isFile() || beforeStat.isSymbolicLink() || beforeStat.nlink !== 1n) {
      throw editError(`${path} must remain a single-link regular file.`);
    }
    const before = snapshot(beforeStat);
    if (expected !== undefined && !sameSnapshot(before, expected)) {
      throw editError("target changed before commit.");
    }
    if (before.size > BigInt(EDIT_MAX_FILE_BYTES)) {
      throw editError(`file exceeds ${String(EDIT_MAX_FILE_BYTES)} bytes.`);
    }
    const pathEntry = await statNoFollow(path);
    if (!pathEntry.stat.isFile() || !sameIdentity(before, pathEntry.snapshot)) {
      throw editError("target path no longer names the opened file.");
    }
    const bytes = await readBounded(handle, EDIT_MAX_FILE_BYTES, signal);
    const after = snapshot(await handle.stat({ bigint: true }));
    if (!sameSnapshot(before, after)) {
      throw editError("target changed while it was being read.");
    }
    const finalPathEntry = await statNoFollow(path);
    if (!finalPathEntry.stat.isFile() || !sameSnapshot(after, finalPathEntry.snapshot)) {
      throw editError("target path changed while it was being read.");
    }
    return { handle, snapshot: after, bytes };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = content.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function replaceLiteral(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { readonly content: string; readonly count: number } {
  const count = countOccurrences(content, oldString);
  if (count === 0) throw editError("old_string was not found.");
  if (!replaceAll && count !== 1) {
    throw editError(`old_string was found ${String(count)} times; set replace_all to replace every match.`);
  }
  return {
    content: replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString),
    count: replaceAll ? count : 1,
  };
}

async function assertDirectorySnapshot(
  path: string,
  expected: FileSnapshot,
): Promise<void> {
  const entry = await statNoFollow(path);
  if (!entry.stat.isDirectory() || !sameDirectoryIdentity(entry.snapshot, expected)) {
    throw editError(`${path} changed before commit.`);
  }
}

async function assertAncestorSnapshots(inspected: InspectedTarget): Promise<void> {
  for (const ancestor of inspected.ancestors) {
    await assertDirectorySnapshot(ancestor.path, ancestor.snapshot);
  }
}

async function unlinkIfSameIdentity(
  path: string,
  expected: FileSnapshot,
): Promise<void> {
  try {
    const entry = await statNoFollow(path);
    if (sameIdentity(entry.snapshot, expected)) await unlink(path);
  } catch {
    // Cleanup must never unlink an entry whose identity we did not create.
  }
}

async function syncDirectory(path: string, expected: FileSnapshot): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | requireNoFollow() | requireDirectoryFlag(),
    );
    const current = snapshot(await handle.stat({ bigint: true }));
    if (!sameDirectoryIdentity(current, expected)) {
      throw editError("parent directory changed during commit.");
    }
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function verifyUnchangedTarget(
  inspected: InspectedTarget,
  expected: FileSnapshot,
  expectedSha256: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await assertAncestorSnapshots(inspected);
  const current = await openCheckedFile(inspected.targetPath, expected, signal);
  try {
    const digest = createHash("sha256").update(current.bytes).digest("hex");
    if (digest !== expectedSha256) {
      throw editError("target bytes changed before commit.");
    }
  } finally {
    await current.handle.close();
  }
}

async function verifyTemporaryFile(
  path: string,
  expected: FileSnapshot,
  expectedSha256: string,
  signal: AbortSignal | undefined,
): Promise<FileSnapshot> {
  const current = await openCheckedFile(path, expected, signal);
  try {
    const currentSha256 = createHash("sha256").update(current.bytes).digest("hex");
    if (currentSha256 !== expectedSha256) {
      throw editError("temporary edit bytes changed before commit.");
    }
    return current.snapshot;
  } finally {
    await current.handle.close();
  }
}

async function verifyCommittedFile(
  path: string,
  expected: FileSnapshot,
  expectedSha256: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const current = await openCheckedFile(path, undefined, signal);
  try {
    if (!sameCommittedSnapshot(current.snapshot, expected)
      || createHash("sha256").update(current.bytes).digest("hex") !== expectedSha256) {
      throw editError("atomic replacement identity changed after commit.");
    }
  } finally {
    await current.handle.close();
  }
}

/**
 * Replace literal text in one existing workspace file.
 *
 * The target is descriptor-opened without following links, must be a
 * single-link regular file, and is compared by identity, metadata, and digest
 * immediately before a same-directory atomic rename.
 */
export async function editLiteralFile(
  workspaceDirectory: string,
  input: LiteralEditInput,
  options: LiteralEditOptions = {},
): Promise<LiteralEditResult> {
  validateLiteralEditInput(input);
  throwIfAborted(options.signal);
  const resolved = resolveWorkspaceTarget(workspaceDirectory, input.filePath);
  const inspected = await inspectTarget(resolved.workspace, resolved.relativePath);
  const opened = await openCheckedFile(inspected.targetPath, undefined, options.signal);
  let sourceBytes: Uint8Array;
  let sourceSnapshot: FileSnapshot;
  try {
    sourceBytes = opened.bytes;
    sourceSnapshot = opened.snapshot;
  } finally {
    await opened.handle.close();
  }

  if (typeof process.getuid === "function"
    && sourceSnapshot.uid !== BigInt(process.getuid())) {
    throw editError("target must be owned by the current user.");
  }
  let sourceText: string;
  try {
    sourceText = UTF8_DECODER.decode(sourceBytes);
  } catch (error) {
    throw editError(`target is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  const replacement = replaceLiteral(
    sourceText,
    input.oldString,
    input.newString,
    input.replaceAll,
  );
  const replacementBytes = Buffer.from(replacement.content, "utf8");
  if (replacementBytes.byteLength > EDIT_MAX_FILE_BYTES) {
    throw editError(`replacement would exceed ${String(EDIT_MAX_FILE_BYTES)} bytes.`);
  }

  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const replacementSha256 = createHash("sha256").update(replacementBytes).digest("hex");
  const temporaryPath = join(
    inspected.parentPath,
    `.${randomUUID()}.mono-agent-edit.tmp`,
  );
  let temporaryHandle: FileHandle | undefined;
  let temporarySnapshot: FileSnapshot | undefined;
  let temporaryCreated = false;
  let committed = false;
  try {
    throwIfAborted(options.signal);
    await options.beforeTemporaryCreate?.();
    await assertAncestorSnapshots(inspected);
    await verifyUnchangedTarget(
      inspected,
      sourceSnapshot,
      sourceSha256,
      options.signal,
    );
    temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | requireNoFollow(),
      Number(sourceSnapshot.mode & 0o777n),
    );
    temporaryCreated = true;
    temporarySnapshot = snapshot(await temporaryHandle.stat({ bigint: true }));
    await options.afterTemporaryCreate?.();
    await temporaryHandle.chmod(Number(sourceSnapshot.mode & 0o777n));
    temporarySnapshot = snapshot(await temporaryHandle.stat({ bigint: true }));
    if (temporarySnapshot.links !== 1n) {
      throw editError("temporary edit file must have exactly one hard link.");
    }
    await temporaryHandle.writeFile(replacementBytes);
    await temporaryHandle.sync();
    temporarySnapshot = snapshot(await temporaryHandle.stat({ bigint: true }));
    if (temporarySnapshot.size !== BigInt(replacementBytes.byteLength)) {
      throw editError("temporary edit file size changed before commit.");
    }
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await options.beforeCommit?.({ temporaryPath });
    temporarySnapshot = await verifyTemporaryFile(
      temporaryPath,
      temporarySnapshot,
      replacementSha256,
      options.signal,
    );
    await verifyUnchangedTarget(
      inspected,
      sourceSnapshot,
      sourceSha256,
      options.signal,
    );
    await options.beforeRename?.();
    temporarySnapshot = await verifyTemporaryFile(
      temporaryPath,
      temporarySnapshot,
      replacementSha256,
      options.signal,
    );
    await verifyUnchangedTarget(
      inspected,
      sourceSnapshot,
      sourceSha256,
      options.signal,
    );
    throwIfAborted(options.signal);
    await rename(temporaryPath, inspected.targetPath);
    committed = true;

    await verifyCommittedFile(
      inspected.targetPath,
      temporarySnapshot,
      replacementSha256,
      options.signal,
    );
    await assertAncestorSnapshots(inspected);
    await syncDirectory(inspected.parentPath, inspected.parent);
    return {
      path: resolved.target,
      replacements: replacement.count,
      bytesBefore: sourceBytes.byteLength,
      bytesAfter: replacementBytes.byteLength,
      sha256Before: sourceSha256,
      sha256After: replacementSha256,
    };
  } catch (error) {
    if (!committed && temporaryCreated) {
      if (temporarySnapshot === undefined) {
        try {
          await unlink(temporaryPath);
        } catch {
          // The exclusive random path was never exposed to a callback before
          // this failure seam; cleanup remains best-effort if it vanished.
        }
      } else {
        await unlinkIfSameIdentity(temporaryPath, temporarySnapshot);
      }
    }
    throw error;
  } finally {
    await temporaryHandle?.close();
  }
}

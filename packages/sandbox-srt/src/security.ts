// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { SandboxSrtFileConfig } from "./config.js";
import { SandboxSrtError } from "./errors.js";

export interface TrustedFile {
  readonly path: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly owner: number;
  readonly links: number;
  readonly size: number;
}

export interface TrustedFileBinding {
  readonly descriptor: number;
  readonly firstLine?: string;
  close(): Promise<void>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_FIRST_LINE_BYTES = 256;

export async function resolveTrustedExecutable(config: SandboxSrtFileConfig): Promise<TrustedFile> {
  return await resolveTrustedFile(config, "executable", MAX_EXECUTABLE_BYTES);
}

export async function resolveTrustedSettings(config: SandboxSrtFileConfig): Promise<TrustedFile> {
  return await resolveTrustedFile(config, "settings", MAX_SETTINGS_BYTES);
}

export async function verifyTrustedExecutable(expected: TrustedFile): Promise<void> {
  const actual = await resolveTrustedFile({ path: expected.path, sha256: expected.sha256 }, "executable", MAX_EXECUTABLE_BYTES);
  if (!sameTrustedFile(expected, actual)) unavailable("SRT executable fingerprint changed after selection.");
}

export async function verifyTrustedSettings(expected: TrustedFile): Promise<void> {
  const actual = await resolveTrustedFile({ path: expected.path, sha256: expected.sha256 }, "settings", MAX_SETTINGS_BYTES);
  if (!sameTrustedFile(expected, actual)) unavailable("SRT settings fingerprint changed after selection.");
}

export async function bindTrustedExecutable(expected: TrustedFile): Promise<TrustedFileBinding> {
  return await bindTrustedFile(expected, "executable", MAX_EXECUTABLE_BYTES);
}

export async function bindTrustedSettings(expected: TrustedFile): Promise<TrustedFileBinding> {
  return await bindTrustedFile(expected, "settings", MAX_SETTINGS_BYTES);
}

export function sameTrustedFile(left: TrustedFile, right: TrustedFile): boolean {
  return left.path === right.path
    && left.sha256 === right.sha256
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.owner === right.owner
    && left.links === right.links
    && left.size === right.size;
}

async function resolveTrustedFile(
  config: SandboxSrtFileConfig,
  kind: "executable" | "settings",
  maxBytes: number,
): Promise<TrustedFile> {
  try {
    return await inspectTrustedFile(config, kind, maxBytes);
  } catch (error) {
    if (error instanceof SandboxSrtError) throw error;
    throw new SandboxSrtError(
      "sandbox_unavailable",
      `SRT ${kind} integrity could not be proven.`,
    );
  }
}

async function inspectTrustedFile(
  config: SandboxSrtFileConfig,
  kind: "executable" | "settings",
  maxBytes: number,
): Promise<TrustedFile> {
  const inspected = await openTrustedFile(config, kind, maxBytes);
  try {
    return inspected.file;
  } finally {
    await inspected.handle.close();
  }
}

async function bindTrustedFile(
  expected: TrustedFile,
  kind: "executable" | "settings",
  maxBytes: number,
): Promise<TrustedFileBinding> {
  let opened: OpenTrustedFile;
  try {
    opened = await openTrustedFile(
      { path: expected.path, sha256: expected.sha256 },
      kind,
      maxBytes,
    );
  } catch (error) {
    if (error instanceof SandboxSrtError) throw error;
    throw new SandboxSrtError(
      "sandbox_unavailable",
      `SRT ${kind} integrity could not be proven.`,
    );
  }
  if (!sameTrustedFile(expected, opened.file)) {
    await opened.handle.close();
    unavailable(`SRT ${kind} fingerprint changed after selection.`);
  }
  return Object.freeze({
    descriptor: opened.handle.fd,
    ...(opened.firstLine === undefined ? {} : { firstLine: opened.firstLine }),
    close: async () => {
      await opened.handle.close();
    },
  });
}

interface OpenTrustedFile {
  readonly file: TrustedFile;
  readonly handle: FileHandle;
  readonly firstLine?: string;
}

async function openTrustedFile(
  config: SandboxSrtFileConfig,
  kind: "executable" | "settings",
  maxBytes: number,
): Promise<OpenTrustedFile> {
  requirePosix();
  if (!isAbsolute(config.path)) unavailable(`SRT ${kind} path must be absolute.`);
  const path = resolve(config.path);
  const parent = dirname(path);
  const parentCanonical = await realpath(parent).catch(() => {
    throw new SandboxSrtError("sandbox_unavailable", `SRT ${kind} parent is absent or inaccessible.`);
  });
  if (parentCanonical !== parent) unavailable(`SRT ${kind} parent path must be canonical.`);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) unavailable(`SRT ${kind} parent must be a regular directory.`);
  if (parentStat.uid !== currentUid() && parentStat.uid !== 0) unavailable(`SRT ${kind} parent has an untrusted owner.`);
  if ((parentStat.mode & 0o022) !== 0) unavailable(`SRT ${kind} parent must not be group/world writable.`);
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new SandboxSrtError("sandbox_unavailable", `SRT ${kind} is absent or inaccessible.`);
  }
  if (canonical !== path) unavailable(`SRT ${kind} path must be canonical and must not traverse symlinks.`);
  const before = await lstat(path);
  assertTrustedStat(before, kind, maxBytes);
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertTrustedStat(opened, kind, maxBytes);
    if (!sameIdentity(before, opened)) unavailable(`SRT ${kind} changed while opening.`);
    const { sha256, firstLine } = await hashTrustedHandle(handle, opened.size, kind);
    if (sha256 !== config.sha256) unavailable(`SRT ${kind} content does not match its configured SHA-256 digest.`);
    const openedAfterHash = await handle.stat();
    assertTrustedStat(openedAfterHash, kind, maxBytes);
    if (!sameIdentity(opened, openedAfterHash)) unavailable(`SRT ${kind} changed while hashing.`);
    const after = await lstat(path);
    assertTrustedStat(after, kind, maxBytes);
    if (!sameIdentity(openedAfterHash, after)) unavailable(`SRT ${kind} changed while hashing.`);
    const file = Object.freeze({
      path,
      sha256,
      device: String(openedAfterHash.dev),
      inode: String(openedAfterHash.ino),
      mode: openedAfterHash.mode & 0o7777,
      owner: openedAfterHash.uid,
      links: openedAfterHash.nlink,
      size: openedAfterHash.size,
    });
    return Object.freeze({
      file,
      handle,
      ...(firstLine === undefined ? {} : { firstLine }),
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function hashTrustedHandle(
  handle: FileHandle,
  size: number,
  kind: "executable" | "settings",
): Promise<{ readonly sha256: string; readonly firstLine?: string }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, Math.max(size, 1)));
  let position = 0;
  let prefix = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead < 1) unavailable(`SRT ${kind} changed while hashing.`);
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (kind === "executable" && prefix.byteLength < MAX_FIRST_LINE_BYTES) {
      const remaining = MAX_FIRST_LINE_BYTES - prefix.byteLength;
      prefix = Buffer.concat([prefix, chunk.subarray(0, remaining)]);
    }
    position += bytesRead;
  }
  const newline = prefix.indexOf(0x0a);
  const firstLine = kind === "executable" && newline >= 0
    ? prefix.subarray(0, newline).toString("utf8").replace(/\r$/u, "")
    : undefined;
  return Object.freeze({
    sha256: hash.digest("hex"),
    ...(firstLine === undefined ? {} : { firstLine }),
  });
}

function assertTrustedStat(stat: Stats, kind: "executable" | "settings", maxBytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink()) unavailable(`SRT ${kind} must be a regular non-symlink file.`);
  if (stat.uid !== currentUid()) unavailable(`SRT ${kind} must be owned by the current user.`);
  if (stat.nlink !== 1) unavailable(`SRT ${kind} must have exactly one hard link.`);
  if (stat.size > maxBytes) unavailable(`SRT ${kind} exceeds its byte limit.`);
  const mode = stat.mode & 0o7777;
  if (kind === "settings") {
    if (mode !== 0o600) unavailable("SRT settings mode must be exactly 0600.");
    return;
  }
  if ((mode & 0o6000) !== 0) unavailable("SRT executable must not have setuid or setgid bits.");
  if ((mode & 0o022) !== 0) unavailable("SRT executable must not be group/world writable.");
  if ((mode & 0o100) === 0) unavailable("SRT executable must be executable by its owner.");
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size;
}

function requirePosix(): void {
  if (typeof process.getuid !== "function") unavailable("sandbox-srt requires POSIX ownership checks.");
}

function currentUid(): number {
  if (typeof process.getuid !== "function") unavailable("sandbox-srt requires POSIX ownership checks.");
  return process.getuid();
}

function unavailable(message: string): never {
  throw new SandboxSrtError("sandbox_unavailable", message);
}

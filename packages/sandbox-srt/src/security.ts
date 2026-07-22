import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
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

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;

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
  requirePosix();
  if (!isAbsolute(config.path)) unavailable(`SRT ${kind} path must be absolute.`);
  const path = resolve(config.path);
  const parent = dirname(path);
  const parentCanonical = await realpath(parent).catch((error) => {
    throw new SandboxSrtError("sandbox_unavailable", `SRT ${kind} parent is absent or inaccessible.`, { cause: error });
  });
  if (parentCanonical !== parent) unavailable(`SRT ${kind} parent path must be canonical.`);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) unavailable(`SRT ${kind} parent must be a regular directory.`);
  if (parentStat.uid !== currentUid() && parentStat.uid !== 0) unavailable(`SRT ${kind} parent has an untrusted owner.`);
  if ((parentStat.mode & 0o022) !== 0) unavailable(`SRT ${kind} parent must not be group/world writable.`);
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new SandboxSrtError("sandbox_unavailable", `SRT ${kind} is absent or inaccessible.`, { cause: error });
  }
  if (canonical !== path) unavailable(`SRT ${kind} path must be canonical and must not traverse symlinks.`);
  const before = await lstat(path);
  assertTrustedStat(before, kind, maxBytes);
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertTrustedStat(opened, kind, maxBytes);
    if (!sameIdentity(before, opened)) unavailable(`SRT ${kind} changed while opening.`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) unavailable(`SRT ${kind} exceeds its byte limit.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== config.sha256) unavailable(`SRT ${kind} content does not match its configured SHA-256 digest.`);
    const after = await lstat(path);
    assertTrustedStat(after, kind, maxBytes);
    if (!sameIdentity(opened, after)) unavailable(`SRT ${kind} changed while hashing.`);
    return Object.freeze({
      path,
      sha256,
      device: String(opened.dev),
      inode: String(opened.ino),
      mode: opened.mode & 0o7777,
      owner: opened.uid,
      links: opened.nlink,
      size: opened.size,
    });
  } finally {
    await handle.close();
  }
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

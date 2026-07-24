import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { join, posix } from "node:path";

export const SKILL_NAME = "mono-agent-composer";

export const JOURNAL_MAX_BYTES = 256 * 1024;

const SOURCE_MAX_FILES = 32;

const SOURCE_MAX_FILE_BYTES = 256 * 1024;

const SOURCE_MAX_TOTAL_BYTES = 1024 * 1024;

const SOURCE_MAX_PATH_BYTES = 512;

const SOURCE_MAX_DEPTH = 6;

export const NO_FOLLOW = constants.O_NOFOLLOW;

const OPEN_DIRECTORY = constants.O_DIRECTORY;

const LOCK_NAME = ".mono-agent-composer.install-lock-v1";

export const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export interface SourceDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

type DirectoryPrivacy = "authority" | "private";

interface InstallLock {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly nonce: string;
  readonly handle: FileHandle;
}

export function assertSecurePlatform(): void {
  if (
    typeof process.getuid !== "function"
    || typeof NO_FOLLOW !== "number"
    || typeof OPEN_DIRECTORY !== "number"
  ) {
    throw new Error(
      "Composer skill installation is unsupported on this platform because current-UID, O_NOFOLLOW, and O_DIRECTORY proofs are required.",
    );
  }
}

export async function validateExactTree(
  root: string,
  expectedRoot: FileIdentity,
  source: readonly SourceDescriptor[],
  ownerPrivate: boolean,
): Promise<void> {
  await assertDirectoryIdentity(root, expectedRoot, "skill tree");
  const expectedFiles = new Map(source.map((file) => [file.path, file]));
  const allowedDirectories = allowedSourceDirectories(source);
  const observed = await enumerateAndValidateTree(
    root,
    "",
    expectedFiles,
    allowedDirectories,
    ownerPrivate,
  );
  if (observed.size !== expectedFiles.size) {
    throw new Error("Skill tree does not match its exhaustive manifest.");
  }
  await assertDirectoryIdentity(root, expectedRoot, "skill tree");
}

async function enumerateAndValidateTree(
  root: string,
  relativeDirectory: string,
  expectedFiles: ReadonlyMap<string, SourceDescriptor>,
  allowedDirectories: ReadonlySet<string>,
  ownerPrivate: boolean,
): Promise<ReadonlySet<string>> {
  const directoryPath = relativeDirectory === ""
    ? root
    : join(root, ...relativeDirectory.split("/"));
  const directoryDetails = await lstat(directoryPath);
  assertRealDirectory(directoryDetails, "skill tree directory");
  if (ownerPrivate) assertOwnerPrivate(directoryDetails, "skill tree directory", true);
  const directoryIdentity = identityOf(directoryDetails);
  const directory = await opendir(directoryPath);
  const observed = new Set<string>();
  try {
    for await (const entry of directory) {
      const relativePath = safeRelativePath(
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`,
      );
      const path = join(root, ...relativePath.split("/"));
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        throw new Error(`Skill tree path ${relativePath} must not be a symbolic link.`);
      }
      if (details.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          throw new Error(`Skill tree contains undeclared directory ${relativePath}.`);
        }
        const nested = await enumerateAndValidateTree(
          root,
          relativePath,
          expectedFiles,
          allowedDirectories,
          ownerPrivate,
        );
        for (const value of nested) observed.add(value);
        continue;
      }
      if (!details.isFile()) {
        throw new Error(`Skill tree path ${relativePath} must be a regular file.`);
      }
      if (ownerPrivate) assertOwnerPrivate(details, `skill tree file ${relativePath}`, true);
      const expected = expectedFiles.get(relativePath);
      if (expected === undefined) {
        throw new Error(`Skill tree contains undeclared file ${relativePath}.`);
      }
      const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
      try {
        const bytes = await readExact(handle, expected.sizeBytes);
        const after = await handle.stat();
        if (!sameIdentity(details, after) || after.size !== expected.sizeBytes) {
          throw new Error(`Skill tree file ${relativePath} changed while it was read.`);
        }
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (digest !== expected.sha256) {
          throw new Error(`Skill tree file ${relativePath} does not match its manifest.`);
        }
      } finally {
        await handle.close();
      }
      observed.add(relativePath);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await assertDirectoryIdentity(directoryPath, directoryIdentity, "skill tree directory");
  return observed;
}

export function parseSourceDescriptors(
  value: unknown,
  label: string,
): readonly SourceDescriptor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SOURCE_MAX_FILES) {
    throw new Error(`${label} exceeds its file-count bound.`);
  }
  let totalBytes = 0;
  let previousPath = "";
  const descriptors = value.map((entry, index): SourceDescriptor => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "sha256", "sizeBytes"])) {
      throw new Error(`${label} file ${String(index)} has an invalid shape.`);
    }
    const path = safeRelativePath(entry.path);
    if (index > 0 && path <= previousPath) {
      throw new Error(`${label} paths must be unique and sorted.`);
    }
    previousPath = path;
    if (typeof entry.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error(`${label} file ${path} has an invalid digest.`);
    }
    if (
      !Number.isSafeInteger(entry.sizeBytes)
      || (entry.sizeBytes as number) < 0
      || (entry.sizeBytes as number) > SOURCE_MAX_FILE_BYTES
    ) {
      throw new Error(`${label} file ${path} exceeds its byte bound.`);
    }
    totalBytes += entry.sizeBytes as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SOURCE_MAX_TOTAL_BYTES) {
      throw new Error(`${label} exceeds its aggregate byte bound.`);
    }
    return Object.freeze({
      path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes as number,
    });
  });
  return Object.freeze(descriptors);
}

export async function acquireInstallLock(
  home: string,
  homeIdentity: FileIdentity,
): Promise<InstallLock> {
  const path = join(home, LOCK_NAME);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertDirectoryIdentity(
      home,
      homeIdentity,
      "home directory",
      "authority",
    );
    const nonce = randomUUID().toLowerCase();
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      const details = await handle.stat();
      const identity = identityOf(details);
      await writeFully(handle, Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        kind: "mono-agent.composer-skill-lock",
        nonce,
        ownerPid: process.pid,
      })}\n`, "utf8"));
      await handle.sync();
      await syncDirectory(home);
      return Object.freeze({ path, identity, nonce, handle });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readOwnerFile(path, "install lock");
      const ownerPid = ownerPidFromRecord(existing.value, "install lock");
      if (pidIsAlive(ownerPid)) {
        throw new Error(`Another composer skill installation is active at ${path}.`);
      }
      await archiveExactFile(
        path,
        existing.identity,
        home,
        `.${SKILL_NAME}.lock-stale-${randomUUID().toLowerCase()}`,
        "stale install lock",
      );
    }
  }
  throw new Error("Composer skill install lock acquisition did not converge.");
}

export async function releaseInstallLock(
  lock: InstallLock,
  home: string,
): Promise<void> {
  try {
    await lock.handle.close();
  } finally {
    await archiveExactFile(
      lock.path,
      lock.identity,
      home,
      `.${SKILL_NAME}.lock-released-${lock.nonce}`,
      "install lock",
    );
  }
}

export async function inferredReservationIdentity(
  path: string,
): Promise<FileIdentity | undefined> {
  const details = await lstatOrUndefined(path);
  if (
    details === undefined
    || details.isSymbolicLink()
    || !details.isDirectory()
  ) {
    return undefined;
  }
  try {
    assertOwnerPrivate(details, "inferred skill reservation", true);
    const identity = identityOf(details);
    await assertEmptyDirectory(path, identity, "inferred skill reservation");
    return identity;
  } catch {
    return undefined;
  }
}

export async function archiveExactFile(
  path: string,
  identity: FileIdentity,
  parent: string,
  archiveName: string,
  label: string,
): Promise<string> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} is no longer a regular file.`);
  }
  if (!sameFileIdentity(identityOf(details), identity)) {
    throw new Error(`${label} changed identity.`);
  }
  const archive = join(parent, archiveName);
  if (await lstatOrUndefined(archive) !== undefined) {
    throw new Error(`${label} archive already exists at ${archive}.`);
  }
  await rename(path, archive);
  const archived = await lstat(archive);
  if (!archived.isFile() || !sameFileIdentity(identityOf(archived), identity)) {
    throw new Error(`${label} archive changed identity.`);
  }
  await syncDirectory(parent);
  return archive;
}

export async function readOwnerFile(
  path: string,
  label: string,
): Promise<{ readonly identity: FileIdentity; readonly bytes: Uint8Array; readonly value: unknown }> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  assertOwnerPrivate(details, label, true);
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const bytes = await readBounded(handle, JOURNAL_MAX_BYTES);
    const after = await handle.stat();
    if (!sameIdentity(details, after) || after.size !== bytes.byteLength) {
      throw new Error(`${label} changed while it was read.`);
    }
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")[0]!;
    return Object.freeze({
      identity: identityOf(details),
      bytes,
      value: line.length === 0 ? undefined : JSON.parse(line) as unknown,
    });
  } finally {
    await handle.close();
  }
}

function ownerPidFromRecord(value: unknown, label: string): number {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "nonce",
      "ownerPid",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "mono-agent.composer-skill-lock"
    || typeof value.nonce !== "string"
    || !UUID_PATTERN.test(value.nonce)
    || !Number.isSafeInteger(value.ownerPid)
    || (value.ownerPid as number) < 1
  ) {
    throw new Error(`${label} has an invalid owner record.`);
  }
  return value.ownerPid as number;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

export async function assertEmptyDirectory(
  path: string,
  identity: FileIdentity,
  label: string,
): Promise<void> {
  await assertDirectoryIdentity(path, identity, label, "private");
  const directory = await opendir(path);
  try {
    if (await directory.read() !== null) throw new Error(`${label} is not empty.`);
  } finally {
    await directory.close();
  }
  await assertDirectoryIdentity(path, identity, label, "private");
}

export async function assertDirectoryIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
  privacy?: DirectoryPrivacy,
): Promise<void> {
  const details = await lstat(path);
  assertRealDirectory(details, label);
  if (privacy !== undefined) {
    assertOwnerPrivate(details, label, privacy === "private");
  }
  if (!sameFileIdentity(identityOf(details), expected)) {
    throw new Error(`${label} changed identity.`);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | OPEN_DIRECTORY | NO_FOLLOW);
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

export async function writeFully(
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) throw new Error("Secure file write made no progress.");
    offset += result.bytesWritten;
  }
}

export async function readBounded(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error("Secure file exceeds its byte bound.");
  return new Uint8Array(buffer.subarray(0, offset));
}

export async function readExact(
  handle: FileHandle,
  sizeBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const { bytesRead } = await handle.read(buffer, offset, sizeBytes - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== sizeBytes) throw new Error("Skill file is shorter than its manifest.");
  const sentinel = Buffer.alloc(1);
  if ((await handle.read(sentinel, 0, 1, sizeBytes)).bytesRead !== 0) {
    throw new Error("Skill file is longer than its manifest.");
  }
  return new Uint8Array(buffer);
}

export function allowedSourceDirectories(
  source: readonly SourceDescriptor[],
): ReadonlySet<string> {
  const directories = new Set<string>([""]);
  for (const file of source) {
    let parent = posix.dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  return directories;
}

export function safeRelativePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || Buffer.byteLength(value, "utf8") > SOURCE_MAX_PATH_BYTES
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
  ) {
    throw new Error("Skill source manifest contains an unsafe path.");
  }
  const segments = value.split("/");
  if (
    segments.length > SOURCE_MAX_DEPTH
    || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." || segment.includes("\0"))
  ) {
    throw new Error("Skill source manifest contains an unsafe path.");
  }
  return value;
}

export function parseIdentity(value: unknown, label: string): FileIdentity {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["device", "inode"])
    || !Number.isSafeInteger(value.device)
    || (value.device as number) < 0
    || !Number.isSafeInteger(value.inode)
    || (value.inode as number) < 1
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze({
    device: value.device as number,
    inode: value.inode as number,
  });
}

export function assertRealDirectory(details: Stats, label: string): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

export function assertOwnerPrivate(
  details: Stats,
  label: string,
  fullyPrivate: boolean,
): void {
  if (typeof process.getuid !== "function") {
    throw new Error(
      `${label} cannot be verified because current-UID proof is unavailable.`,
    );
  }
  if (details.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  const forbidden = fullyPrivate ? 0o077 : 0o022;
  if ((details.mode & forbidden) !== 0) {
    throw new Error(
      fullyPrivate
        ? `${label} must not grant group or other permissions.`
        : `${label} must not grant group or other write permissions.`,
    );
  }
}

export function identityOf(details: Stats): FileIdentity {
  return Object.freeze({ device: details.dev, inode: details.ino });
}

export function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function assertPathAbsent(
  path: string,
  label: string,
): Promise<void> {
  if (await lstatOrUndefined(path) !== undefined) {
    throw new Error(`${label} already exists at ${path}.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}

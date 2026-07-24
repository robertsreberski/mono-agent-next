import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";

const LOCK_MAX_BYTES = 16 * 1024;
const LOCK_KIND = "mono-agent.scaffold-lock";
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface ScaffoldLockRecord {
  readonly schemaVersion: 1;
  readonly kind: typeof LOCK_KIND;
  readonly nonce: string;
  readonly ownerPid: number;
  readonly stageName: string;
}

interface LockCandidate {
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

interface ExistingScaffoldLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly stagePath: string;
  readonly candidatePath: string;
  readonly record: ScaffoldLockRecord;
}

class RetryScaffoldLockAcquisition extends Error {}

export interface ScaffoldLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly stagePath: string;
}

export interface ScaffoldStage {
  readonly path: string;
  readonly identity: FileIdentity;
}

export async function acquireScaffoldLock(
  parent: string,
  targetName: string,
): Promise<ScaffoldLock> {
  const parentDetails = await lstat(parent);
  assertRealDirectory(parentDetails, "scaffold parent");
  const parentIdentity = identityOf(parentDetails);
  const path = join(parent, `.${targetName}.mono-agent-scaffold.lock`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertDirectoryIdentity(parent, parentIdentity, "scaffold parent");
    const nonce = randomUUID().toLowerCase();
    const stageName = `.${targetName}.mono-agent-stage-${nonce}`;
    const candidate = `${path}.candidate-${nonce}`;
    const lockCandidate = await createLockCandidate(
      candidate,
      {
        schemaVersion: 1,
        kind: LOCK_KIND,
        nonce,
        ownerPid: process.pid,
        stageName,
      },
      parent,
      parentIdentity,
    );
    try {
      await link(candidate, path);
    } catch (error) {
      try {
        await discardLockCandidate(
          candidate,
          lockCandidate,
          parent,
          parentIdentity,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Scaffold lock candidate cleanup failed",
        );
      }
      if (!hasCode(error, "EEXIST")) throw error;
      try {
        await inspectExistingScaffoldLock(
          path,
          parent,
          parentIdentity,
          targetName,
        );
      } catch (existingError) {
        if (
          hasCode(existingError, "ENOENT")
          || existingError instanceof RetryScaffoldLockAcquisition
        ) {
          continue;
        }
        throw existingError;
      }
      continue;
    }

    let candidateRemoved = false;
    try {
      const locked = await lstat(path);
      assertOwnerPrivateFile(locked, "scaffold lock");
      if (!sameFileIdentity(identityOf(locked), lockCandidate.identity)) {
        throw new Error("Scaffold lock changed identity while it was acquired.");
      }
      await removeExactFile(
        candidate,
        lockCandidate.identity,
        parent,
        parentIdentity,
        "scaffold lock candidate",
      );
      candidateRemoved = true;
      await syncDirectory(parent);
      return Object.freeze({
        path,
        handle: lockCandidate.handle,
        identity: lockCandidate.identity,
        parent,
        parentIdentity,
        stagePath: join(parent, stageName),
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (!candidateRemoved) {
        try {
          await removeExactFile(
            candidate,
            lockCandidate.identity,
            parent,
            parentIdentity,
            "scaffold lock candidate",
          );
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await removeExactFile(
          path,
          lockCandidate.identity,
          parent,
          parentIdentity,
          "scaffold lock",
        );
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        await lockCandidate.handle.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      throw cleanupFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupFailures],
            "Scaffold lock acquisition cleanup failed",
          );
    }
  }
  throw new Error(`Scaffold lock acquisition did not converge: ${path}`);
}

export async function createScaffoldStage(
  lock: ScaffoldLock,
): Promise<ScaffoldStage> {
  await assertScaffoldLock(lock);
  await mkdir(lock.stagePath, { mode: 0o700 });
  const details = await lstat(lock.stagePath);
  assertOwnerPrivateDirectory(details, "scaffold stage");
  await syncDirectory(lock.parent);
  return Object.freeze({
    path: lock.stagePath,
    identity: identityOf(details),
  });
}

export async function removeScaffoldStage(
  lock: ScaffoldLock,
  stage: ScaffoldStage,
): Promise<void> {
  await assertScaffoldLock(lock);
  await removeExactDirectory(
    stage.path,
    stage.identity,
    lock.parent,
    lock.parentIdentity,
    "scaffold stage",
  );
}

export async function assertScaffoldLock(
  lock: ScaffoldLock,
): Promise<void> {
  await assertDirectoryIdentity(
    lock.parent,
    lock.parentIdentity,
    "scaffold parent",
  );
  await assertScaffoldLockHandle(lock);
  const details = await lstat(lock.path);
  assertOwnerPrivateFile(details, "scaffold lock");
  if (!sameFileIdentity(identityOf(details), lock.identity)) {
    throw new Error("Scaffold lock changed identity.");
  }
}

export async function assertScaffoldStage(
  lock: ScaffoldLock,
  stage: ScaffoldStage,
  path = stage.path,
): Promise<void> {
  await assertScaffoldLock(lock);
  const details = await lstat(path);
  assertOwnerPrivateDirectory(details, "scaffold stage");
  if (!sameFileIdentity(identityOf(details), stage.identity)) {
    throw new Error("Scaffold stage changed identity.");
  }
}

export async function releaseScaffoldLock(lock: ScaffoldLock): Promise<void> {
  await withClosedFileHandle(
    lock.handle,
    async () => {
      await assertScaffoldLockHandle(lock);
      await removeExactFile(
        lock.path,
        lock.identity,
        lock.parent,
        lock.parentIdentity,
        "scaffold lock",
      );
    },
    "Scaffold lock release failed",
  );
}

async function createLockCandidate(
  path: string,
  record: ScaffoldLockRecord,
  parent: string,
  parentIdentity: FileIdentity,
): Promise<LockCandidate> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let candidate: LockCandidate | undefined;
  try {
    const details = await handle.stat();
    candidate = Object.freeze({
      handle,
      identity: identityOf(details),
    });
    assertOwnerPrivateFile(details, "scaffold lock candidate");
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    const after = await handle.stat();
    if (!sameFileIdentity(identityOf(after), candidate.identity)) {
      throw new Error("Scaffold lock candidate changed identity.");
    }
    return candidate;
  } catch (error) {
    if (candidate === undefined) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    try {
      await discardLockCandidate(
        path,
        candidate,
        parent,
        parentIdentity,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Scaffold lock candidate creation cleanup failed",
      );
    }
    throw error;
  }
}

async function discardLockCandidate(
  path: string,
  candidate: LockCandidate,
  parent: string,
  parentIdentity: FileIdentity,
): Promise<void> {
  await withClosedFileHandle(
    candidate.handle,
    () => removeExactFile(
      path,
      candidate.identity,
      parent,
      parentIdentity,
      "scaffold lock candidate",
    ),
    "Scaffold lock candidate disposal failed",
  );
}

async function assertScaffoldLockHandle(
  lock: ScaffoldLock,
): Promise<void> {
  const held = await lock.handle.stat();
  assertOwnerPrivateFile(held, "scaffold lock");
  if (!sameFileIdentity(identityOf(held), lock.identity)) {
    throw new Error("Scaffold lock handle changed identity.");
  }
}

async function inspectExistingScaffoldLock(
  path: string,
  parent: string,
  parentIdentity: FileIdentity,
  targetName: string,
): Promise<void> {
  const existing = await readScaffoldLock(
    path,
    parent,
    parentIdentity,
    targetName,
  );
  await withClosedFileHandle(
    existing.handle,
    async () => {
      if (pidIsAlive(existing.record.ownerPid)) {
        throw new Error(
          `Another scaffold operation owns the target; lock: ${path}`,
        );
      }
      await recoverStaleScaffoldLock(existing);
    },
    "Existing scaffold lock inspection failed",
  );
}

async function readScaffoldLock(
  path: string,
  parent: string,
  parentIdentity: FileIdentity,
  targetName: string,
): Promise<ExistingScaffoldLock> {
  await assertDirectoryIdentity(parent, parentIdentity, "scaffold parent");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    assertOwnerPrivateFile(before, `scaffold lock ${path}`);
    if (before.size < 1 || before.size > LOCK_MAX_BYTES) {
      throw new Error(`Scaffold lock has an invalid size: ${path}`);
    }
    const bytes = await readBounded(handle, LOCK_MAX_BYTES);
    const after = await handle.stat();
    const current = await lstat(path);
    assertOwnerPrivateFile(current, `scaffold lock ${path}`);
    if (
      !sameIdentity(before, after)
      || !sameIdentity(after, current)
      || after.size !== bytes.byteLength
    ) {
      throw new RetryScaffoldLockAcquisition(
        `Scaffold lock changed while it was read: ${path}`,
      );
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    const record = parseLockRecord(value, targetName);
    return Object.freeze({
      path,
      handle,
      identity: identityOf(after),
      parent,
      parentIdentity,
      stagePath: join(parent, record.stageName),
      candidatePath: `${path}.candidate-${record.nonce}`,
      record,
    });
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Scaffold lock read cleanup failed",
      );
    }
    throw error;
  }
}

function parseLockRecord(
  value: unknown,
  targetName: string,
): ScaffoldLockRecord {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "nonce",
      "ownerPid",
      "stageName",
    ])
    || value.schemaVersion !== 1
    || value.kind !== LOCK_KIND
    || typeof value.nonce !== "string"
    || !UUID_PATTERN.test(value.nonce)
    || !Number.isSafeInteger(value.ownerPid)
    || (value.ownerPid as number) < 1
    || value.stageName
      !== `.${targetName}.mono-agent-stage-${value.nonce}`
  ) {
    throw new Error("Scaffold lock has an invalid owner record.");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: LOCK_KIND,
    nonce: value.nonce,
    ownerPid: value.ownerPid as number,
    stageName: value.stageName as string,
  });
}

async function recoverStaleScaffoldLock(
  lock: Awaited<ReturnType<typeof readScaffoldLock>>,
): Promise<void> {
  const stageDetails = await lstatOrUndefined(lock.stagePath);
  if (stageDetails !== undefined) {
    assertOwnerPrivateDirectory(stageDetails, "stale scaffold stage");
    await quarantineExactDirectory(
      lock.stagePath,
      identityOf(stageDetails),
      lock.parent,
      lock.parentIdentity,
      "stale scaffold stage",
    );
  }
  const candidateDetails = await lstatOrUndefined(lock.candidatePath);
  if (candidateDetails !== undefined) {
    assertOwnerPrivateFile(candidateDetails, "stale scaffold lock candidate");
    if (!sameFileIdentity(identityOf(candidateDetails), lock.identity)) {
      throw new Error("Stale scaffold lock candidate has an unknown identity.");
    }
    await removeExactFile(
      lock.candidatePath,
      lock.identity,
      lock.parent,
      lock.parentIdentity,
      "stale scaffold lock candidate",
    );
  }
  await removeExactFile(
    lock.path,
    lock.identity,
    lock.parent,
    lock.parentIdentity,
    "stale scaffold lock",
  );
}

async function removeExactDirectory(
  path: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<void> {
  const quarantine = await quarantineExactDirectory(
    path,
    identity,
    parent,
    parentIdentity,
    label,
  );
  await rm(quarantine, { recursive: true, force: false });
  await syncDirectory(parent);
}

async function quarantineExactDirectory(
  path: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<string> {
  const details = await lstatOrUndefined(path);
  if (details === undefined) {
    throw new RetryScaffoldLockAcquisition(`${label} disappeared.`);
  }
  assertOwnerPrivateDirectory(details, label);
  if (!sameFileIdentity(identityOf(details), identity)) {
    throw new Error(`${label} changed identity.`);
  }
  await assertDirectoryIdentity(parent, parentIdentity, "scaffold parent");
  const quarantine = join(
    parent,
    `.${basename(path).replace(/^\./u, "")}.recovered-${randomUUID().toLowerCase()}`,
  );
  if (await lstatOrUndefined(quarantine) !== undefined) {
    throw new Error(`${label} recovery path already exists: ${quarantine}`);
  }
  await rename(path, quarantine);
  const moved = await lstat(quarantine);
  assertOwnerPrivateDirectory(moved, label);
  if (!sameFileIdentity(identityOf(moved), identity)) {
    throw new Error(`${label} changed identity during quarantine.`);
  }
  await syncDirectory(parent);
  return quarantine;
}

async function removeExactFile(
  path: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<void> {
  const details = await lstatOrUndefined(path);
  if (details === undefined) {
    throw new RetryScaffoldLockAcquisition(`${label} disappeared.`);
  }
  assertOwnerPrivateFile(details, label);
  if (!sameFileIdentity(identityOf(details), identity)) {
    throw new Error(`${label} changed identity.`);
  }
  await assertDirectoryIdentity(parent, parentIdentity, "scaffold parent");
  const archive = `${path}.released-${randomUUID().toLowerCase()}`;
  if (await lstatOrUndefined(archive) !== undefined) {
    throw new Error(`${label} release path already exists: ${archive}`);
  }
  await rename(path, archive);
  const moved = await lstat(archive);
  assertOwnerPrivateFile(moved, label);
  if (!sameFileIdentity(identityOf(moved), identity)) {
    throw new Error(`${label} changed identity during release.`);
  }
  await unlink(archive);
  await syncDirectory(parent);
}

async function withClosedFileHandle<T>(
  handle: FileHandle,
  operation: () => Promise<T>,
  cleanupMessage: string,
): Promise<T> {
  let operationFailed = false;
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, closeError],
          cleanupMessage,
        );
      }
      throw closeError;
    }
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maximumBytes) {
    throw new Error("Scaffold lock exceeds its byte bound.");
  }
  return new Uint8Array(buffer.subarray(0, offset));
}

async function assertDirectoryIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
): Promise<void> {
  const details = await lstat(path);
  assertRealDirectory(details, label);
  if (!sameFileIdentity(identityOf(details), expected)) {
    throw new Error(`${label} changed identity.`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

function assertRealDirectory(details: Stats, label: string): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function assertOwnerPrivateDirectory(details: Stats, label: string): void {
  assertRealDirectory(details, label);
  assertOwnerPrivate(details, label);
}

function assertOwnerPrivateFile(details: Stats, label: string): void {
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  assertOwnerPrivate(details, label);
}

function assertOwnerPrivate(details: Stats, label: string): void {
  if (typeof process.getuid !== "function") return;
  if (details.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other permissions.`);
  }
}

function identityOf(details: Stats): FileIdentity {
  return Object.freeze({ device: details.dev, inode: details.ino });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}

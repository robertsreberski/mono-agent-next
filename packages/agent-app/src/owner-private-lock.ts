import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  currentProcessIncarnation,
  isSameProcessIncarnation as matchesProcessIncarnation,
  processIncarnationFromJson,
} from "./process-incarnation.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";
import { secureFileReplace } from "./secure-file-replace.js";

const OWNER_MAX_BYTES = 4 * 1024;
const OWNER_PUBLICATION_TEMPORARY = ".owner.mono-agent-publication.tmp";
const OWNER_PUBLICATION_IN_PROGRESS = Symbol("owner-publication-in-progress");

interface Identity { readonly dev: bigint; readonly ino: bigint }
interface BaseOwner {
  readonly schema: string; readonly pid: number; readonly token: string;
  readonly createdAt: string; readonly incarnation: ProcessIncarnation;
}
interface Owner {
  readonly pid: number; readonly incarnation?: ProcessIncarnation;
  readonly content: string; readonly identity: Identity;
}
interface PublicationPin {
  readonly handle: FileHandle; readonly details: BigIntStats; readonly content: Buffer; closed: boolean;
}
interface OwnerPublication { readonly [OWNER_PUBLICATION_IN_PROGRESS]: PublicationPin }
type OwnerReadResult = Owner | OwnerPublication | undefined;
type Observed =
  | { readonly kind: "ownerless"; readonly identity: Identity; readonly mtimeMs: number;
      readonly [OWNER_PUBLICATION_IN_PROGRESS]?: PublicationPin }
  | { readonly kind: "owned"; readonly identity: Identity; readonly owner: Owner };
interface ArtifactInput { readonly path: string; readonly pid: number; readonly now: number; readonly token: string }

export interface OwnerPrivateLockOptions {
  readonly path: string;
  readonly label: string;
  readonly schemaTag: string;
  readonly ownerlessGraceMs: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxAcquireAttempts?: number;
  readonly pid?: number;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly processIncarnation?: ProcessIncarnation;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly isLegacyProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  /** Platform and directory-sync seams for filesystems which cannot fsync directories. */
  readonly platform?: NodeJS.Platform;
  readonly syncDirectoryHandle?: (handle: FileHandle) => Promise<void>;
  readonly ownerFields?: (base: BaseOwner) => Readonly<Record<string, unknown>>;
  readonly validateOwnerFields?: (record: Readonly<Record<string, unknown>>) => boolean;
  readonly parseLegacyOwner?: (record: Readonly<Record<string, unknown>>) =>
    { readonly pid: number; readonly incarnation?: ProcessIncarnation } | undefined;
  /** Transitional compatibility for an accepted legacy record written before owner-only mode was enforced. */
  readonly allowCurrentUserLegacyOwnerMode?: boolean;
  readonly invalidOwner?: "ownerless" | "error";
  readonly livenessError?: (error: unknown, owner: Owner) => "assume-live" | Error;
  readonly beforeIteration?: () => void;
  readonly afterDirectoryCreated?: (path: string) => void | Promise<void>;
  readonly afterInspected?: (observed: Observed) => void | Promise<void>;
  readonly beforeStaleRename?: (path: string) => void | Promise<void>;
  readonly isSatisfied?: () => boolean | Promise<boolean>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly stalePath?: (input: ArtifactInput) => string;
  readonly releasedPath?: (input: ArtifactInput) => string;
  readonly abandonedPath?: (input: ArtifactInput) => string;
  readonly staleRace?: "retry" | "return" | "error";
  readonly timeoutError?: (observed: Observed) => Error | undefined;
  readonly unsafeError?: (cause: string, details?: Readonly<Record<string, unknown>>) => Error;
}

export interface OwnerPrivateLock {
  readonly path: string;
  readonly ownerPid: number;
  release(options?: { readonly beforeRename?: (path: string) => void | Promise<void> }): Promise<void>;
}

export function validateOwnerPrivateLockInputs(label: string, pid: number, ownerlessGraceMs: number): void {
  if (!positivePid(pid)) throw new Error(`${label} pid must be a positive safe integer.`);
  if (!Number.isFinite(ownerlessGraceMs) || ownerlessGraceMs < 0) {
    throw new Error(`${label} ownerless grace must be non-negative and finite.`);
  }
}

/** Shared private-directory lock with atomic ownership, liveness, quarantine, and exact release. */
export async function acquireOwnerPrivateLock(options: OwnerPrivateLockOptions): Promise<OwnerPrivateLock | undefined> {
  validateOptions(options);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? randomUUID;
  const incarnation = options.processIncarnation ?? await currentProcessIncarnation();
  const sameProcess = options.isSameProcessIncarnation ?? matchesProcessIncarnation;
  const timeout = options.waitTimeoutMs ?? 0;
  const deadline = now() + timeout;
  let attempts = 0;
  let retriedMissingAtDeadline = false;

  for (;;) {
    if (options.maxAcquireAttempts !== undefined && attempts >= options.maxAcquireAttempts) return undefined;
    options.beforeIteration?.();
    attempts += 1;
    const token = checkedToken(randomToken(), options.label);
    let created: Identity | undefined;
    try {
      await mkdir(options.path, { mode: 0o700 });
      created = identity(await privateDirectory(options.path, options));
      await options.afterDirectoryCreated?.(options.path);
      await sameDirectoryRequired(options.path, created, options);
      const base: BaseOwner = {
        schema: options.schemaTag,
        pid,
        token,
        createdAt: new Date(now()).toISOString(),
        incarnation,
      };
      const record = { ...options.ownerFields?.(base), ...base };
      const owner = await publishOwner(options, created, record);
      await syncDirectory(options.path, created, options);
      return makeHeld(options, created, owner, pid, now, randomToken);
    } catch (error) {
      if (created !== undefined) {
        // An exclusive owner publication can lose to a same-user contender
        // inside the directory we just created. Preserve that record and let
        // normal inspection decide whether it is live, stale, or unsafe.
        if (!isErrno(error, "EEXIST")) {
          try {
            await abandon(options, created, pid, now, randomToken);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `${options.label} acquisition and failed-acquisition cleanup both failed.`,
            );
          }
        }
      }
      if (!isErrno(error, "EEXIST")) throw error;
    }

    if (await options.isSatisfied?.()) return undefined;
    const observed = await inspect(options.path, options);
    if (observed === undefined) {
      if (timeout > 0 && now() >= deadline) {
        if (retriedMissingAtDeadline) return undefined;
        retriedMissingAtDeadline = true;
      }
      continue;
    }
    try {
      await options.afterInspected?.(observed);
      let stale = observed.kind === "ownerless"
        && now() - observed.mtimeMs >= options.ownerlessGraceMs;
      if (observed.kind === "owned") {
        try {
          stale = !(observed.owner.incarnation === undefined
            ? await (options.isLegacyProcessAlive?.(observed.owner.pid) ?? true)
            : await sameProcess(observed.owner.pid, observed.owner.incarnation));
        } catch (error) {
          const decision = options.livenessError?.(error, observed.owner);
          if (decision instanceof Error) throw decision;
          if (decision !== "assume-live") throw error;
          stale = false;
        }
      }
      if (stale) {
        if (await quarantine(options, observed, pid, now, randomToken) === "retry") continue;
        return undefined;
      }
      if ((options.maxAcquireAttempts !== undefined && attempts >= options.maxAcquireAttempts)
        || timeout === 0 || now() >= deadline) {
        const error = options.timeoutError?.(observed);
        if (error !== undefined) throw error;
        return undefined;
      }
      // A fresh publication is only observed, never quarantined. Release its
      // inode pin before waiting so the publisher can finish on every platform.
      await closeObserved(observed);
      await (options.sleep ?? sleep)(Math.min(options.pollIntervalMs ?? 100, Math.max(0, deadline - now())));
    } finally {
      await closeObserved(observed);
    }
  }
}

function makeHeld(
  options: OwnerPrivateLockOptions,
  expectedIdentity: Identity,
  expectedOwner: Owner,
  pid: number,
  now: () => number,
  randomToken: () => string,
): OwnerPrivateLock {
  let released = false;
  return {
    path: options.path,
    ownerPid: expectedOwner.pid,
    async release(releaseOptions = {}) {
      if (released) return;
      const expected: Observed = { kind: "owned", identity: expectedIdentity, owner: expectedOwner };
      if (!await matchesObserved(options.path, options, expected)) {
        throw unsafe(options, `${options.label} identity or owner changed before release; the replacement was left untouched.`);
      }
      await releaseOptions.beforeRename?.(options.path);
      if (!await matchesObserved(options.path, options, expected)) {
        throw unsafe(options, `${options.label} changed at the release boundary; the replacement was left untouched.`);
      }
      const releasedPath = artifactPath(options, "released", pid, now, randomToken);
      try {
        await rename(options.path, releasedPath);
      } catch (error) {
        if (isErrno(error, "ENOENT")) throw unsafe(options, `${options.label} disappeared during release.`);
        throw error;
      }
      if (!await matchesObserved(releasedPath, options, expected)) {
        throw unsafe(options, `${options.label} changed across release and was retained at ${releasedPath}.`, { releasedPath });
      }
      released = true;
      await rm(releasedPath, { recursive: true, force: true });
    },
  };
}

async function publishOwner(
  options: OwnerPrivateLockOptions,
  directoryIdentity: Identity,
  record: Readonly<Record<string, unknown>>,
): Promise<Owner> {
  const ownerPath = join(options.path, "owner.json");
  const content = `${JSON.stringify(record)}\n`;
  await secureFileReplace({
    path: ownerPath,
    temporaryPath: join(options.path, OWNER_PUBLICATION_TEMPORARY),
    contents: content,
    mode: 0o600,
    beforeCommit: () => sameDirectoryRequired(options.path, directoryIdentity, options),
    // A contender in the mkdir-to-owner window must never be replaced.
    target: { expected: { kind: "missing" }, recovery: "preserve-current" },
  });
  await sameDirectoryRequired(options.path, directoryIdentity, options);
  const owner = await readOwner(ownerPath, options);
  if (owner !== undefined && isOwnerPublication(owner)) {
    await closePublication(owner[OWNER_PUBLICATION_IN_PROGRESS]);
    throw unsafe(options, `The atomically published ${options.label} owner record could not be verified.`);
  }
  if (owner === undefined || owner.content !== content) {
    throw unsafe(options, `The atomically published ${options.label} owner record could not be verified.`);
  }
  return owner;
}

async function inspect(path: string, options: OwnerPrivateLockOptions): Promise<Observed | undefined> {
  let details: BigIntStats;
  try {
    details = await privateDirectory(path, options);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const directoryIdentity = identity(details);
  const owner = await readOwner(join(path, "owner.json"), options);
  let transferred = false;
  try {
    if (!(await sameDirectory(path, directoryIdentity, options))) return undefined;
    if (owner === undefined) {
      return { kind: "ownerless", identity: directoryIdentity, mtimeMs: Number(details.mtimeMs) };
    }
    if (isOwnerPublication(owner)) {
      const publication = owner[OWNER_PUBLICATION_IN_PROGRESS];
      transferred = true;
      return {
        kind: "ownerless", identity: directoryIdentity, mtimeMs: Number(details.mtimeMs),
        [OWNER_PUBLICATION_IN_PROGRESS]: publication,
      };
    }
    return { kind: "owned", identity: directoryIdentity, owner };
  } finally {
    if (!transferred && owner !== undefined && isOwnerPublication(owner))
      await closePublication(owner[OWNER_PUBLICATION_IN_PROGRESS]);
  }
}

async function readOwner(path: string, options: OwnerPrivateLockOptions): Promise<OwnerReadResult> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK matters before fstat: a same-user pathname swap to a FIFO
    // must fail closed instead of hanging lock inspection.
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw unsafe(options, message(error));
  }
  let transferred = false;
  try {
    let before = await handle.stat({ bigint: true });
    if (before.nlink === 0n) return undefined;
    // The current publisher temporarily gives the staged owner inode one exact
    // second name. Never accept that state as an owner; normal grace and
    // quarantine policy treats a crashed publication like other ownerless state.
    if (before.nlink === 2n) {
      const publication = await pinOwnerPublication(handle, path, before, options);
      if (publication !== undefined) {
        transferred = true;
        return { [OWNER_PUBLICATION_IN_PROGRESS]: publication };
      }
      const settled = await settledOwnerDetails(handle, path, before);
      if (settled !== undefined) before = settled;
    }
    ownerFile(before, path, options);
    const fileIdentity = identity(before);
    const content = await boundedRead(handle, path, options);
    const after = await handle.stat({ bigint: true });
    if (after.nlink === 0n) return undefined;
    const named = await lstatExisting(path);
    if (named === undefined) return undefined;
    ownerFile(after, path, options);
    ownerFile(named, path, options);
    if (options.allowCurrentUserLegacyOwnerMode !== true) {
      privateOwnerModes(path, options, before, after, named);
    }
    if (!sameIdentity(after, fileIdentity) || !sameIdentity(named, fileIdentity)) {
      throw unsafe(options, `${options.label} owner record identity changed while it was read.`);
    }
    let record: Readonly<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      record = parsed as Readonly<Record<string, unknown>>;
    } catch (error) {
      if (options.invalidOwner === "ownerless") return undefined;
      throw unsafe(options, `${options.label} owner record JSON is malformed: ${message(error)}`);
    }
    const incarnation = processIncarnationFromJson(record.incarnation);
    if (record.schema === options.schemaTag && positivePid(record.pid)
      && typeof record.token === "string" && record.token.length > 0 && record.token.length <= 256
      && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
      && incarnation !== undefined && (options.validateOwnerFields?.(record) ?? true)) {
      if (options.allowCurrentUserLegacyOwnerMode === true) privateOwnerModes(path, options, before, after, named);
      return { pid: record.pid, incarnation, content, identity: fileIdentity };
    }
    const legacy = record.schema === undefined ? options.parseLegacyOwner?.(record) : undefined;
    if (legacy !== undefined) {
      return { ...legacy, content, identity: fileIdentity };
    }
    if (options.invalidOwner === "ownerless") return undefined;
    throw unsafe(options, `${options.label} owner record is malformed or has an unexpected schema.`);
  } finally {
    if (!transferred) await handle.close();
  }
}

async function boundedRead(handle: FileHandle, path: string, options: OwnerPrivateLockOptions): Promise<string> {
  return (await boundedReadBuffer(handle, path, options)).toString("utf8");
}

async function boundedReadBuffer(handle: FileHandle, path: string, options: OwnerPrivateLockOptions): Promise<Buffer> {
  const buffer = Buffer.alloc(OWNER_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > OWNER_MAX_BYTES) throw unsafe(options, `${options.label} owner record ${path} exceeds ${OWNER_MAX_BYTES} bytes.`);
  return buffer.subarray(0, offset);
}

async function pinOwnerPublication(handle: FileHandle, path: string, before: BigIntStats,
  options: OwnerPrivateLockOptions): Promise<PublicationPin | undefined> {
  if (!ownerPublicationFile(before, before, 2n)) return undefined;
  const content = await boundedReadBuffer(handle, path, options);
  const after = await handle.stat({ bigint: true });
  const named = await lstatExisting(path);
  const staged = await lstatExisting(join(dirname(path), OWNER_PUBLICATION_TEMPORARY));
  if (named === undefined || staged === undefined
    || ![after, named, staged].every((value) => samePublicationSnapshot(value, before))) return undefined;
  if (BigInt(content.length) !== before.size) return undefined;
  return { handle, details: before, content: Buffer.from(content), closed: false };
}

async function settledOwnerDetails(handle: FileHandle, path: string,
  expected: Identity): Promise<BigIntStats | undefined> {
  const settled = await handle.stat({ bigint: true });
  const named = await lstatExisting(path);
  if (named === undefined) return undefined;
  return ownerPublicationFile(settled, expected, 1n)
    && ownerPublicationFile(named, expected, 1n)
    ? settled
    : undefined;
}

function samePublicationSnapshot(value: BigIntStats, expected: BigIntStats): boolean {
  return ownerPublicationFile(value, expected, 2n)
    && value.size === expected.size
    && value.mtimeNs === expected.mtimeNs
    && value.ctimeNs === expected.ctimeNs;
}

function ownerPublicationFile(details: BigIntStats,
  expected: { readonly dev: bigint; readonly ino: bigint }, linkCount: bigint): boolean {
  return details.isFile()
    && !details.isSymbolicLink()
    && details.nlink === linkCount
    && sameIdentity(details, expected)
    && (typeof process.getuid !== "function" || details.uid === BigInt(process.getuid()))
    && (details.mode & 0o777n) === 0o600n;
}

function isOwnerPublication(value: Owner | OwnerPublication): value is OwnerPublication {
  return OWNER_PUBLICATION_IN_PROGRESS in value;
}

async function lstatExisting(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (isErrno(error, "ENOENT")) return undefined; throw error; }
}

async function quarantine(
  options: OwnerPrivateLockOptions,
  expected: Observed,
  pid: number,
  now: () => number,
  randomToken: () => string,
): Promise<"retry" | "return"> {
  await options.beforeStaleRename?.(options.path);
  const current = await compareObserved(options.path, options, expected);
  if (current === undefined) return "retry";
  if (!current) {
    return staleRace(options, `${options.label} changed during stale-lock verification; the replacement was left untouched.`);
  }
  const stalePath = artifactPath(options, "stale", pid, now, randomToken);
  try {
    await rename(options.path, stalePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      const current = await compareObserved(options.path, options, expected);
      if (current === undefined) return "retry";
      if (!current) {
        return staleRace(
          options,
          `${options.label} changed while stale-lock quarantine was attempted; the replacement was left untouched.`,
        );
      }
      throw unsafe(
        options,
        `${options.label} could not be quarantined at ${stalePath}; the source lock was left untouched.`,
        { stalePath },
      );
    }
    if (isErrno(error, "EEXIST")) {
      throw unsafe(
        options,
        `${options.label} quarantine destination already exists; both paths were left untouched.`,
        { stalePath },
      );
    }
    throw error;
  }
  if (await compareObserved(stalePath, options, expected) !== true) {
    return staleRace(options, `${options.label} changed across stale-lock quarantine and was retained at ${stalePath}.`, { stalePath });
  }
  await closeObserved(expected);
  await rm(stalePath, { recursive: true, force: true });
  return "retry";
}

function staleRace(options: OwnerPrivateLockOptions, cause: string, details = {}): "retry" | "return" {
  if (options.staleRace === "error") throw unsafe(options, cause, details);
  return options.staleRace === "retry" ? "retry" : "return";
}

async function abandon(
  options: OwnerPrivateLockOptions,
  expected: Identity,
  pid: number,
  now: () => number,
  randomToken: () => string,
): Promise<void> {
  if (!(await sameDirectory(options.path, expected, options))) return;
  const path = artifactPath(options, "abandoned", pid, now, randomToken);
  try {
    await rename(options.path, path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!sameIdentity(await lstat(path, { bigint: true }), expected)) {
    throw unsafe(options, `${options.label} changed across failed-acquisition cleanup and was retained at ${path}.`);
  }
  await rm(path, { recursive: true, force: true });
}

async function privateDirectory(path: string, options: OwnerPrivateLockOptions): Promise<BigIntStats> {
  const details = await lstat(path, { bigint: true });
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw unsafe(options, `${options.label} ${path} must be a real directory.`, { lockFailure: "not-directory" });
  }
  owned(details, path, options);
  if ((details.mode & 0o077n) !== 0n) throw unsafe(options, `${options.label} ${path} must be owner-only (mode 0700).`);
  return details;
}

function ownerFile(details: BigIntStats, path: string, options: OwnerPrivateLockOptions): void {
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1n) {
    throw unsafe(options, `${options.label} owner ${path} must be a single-link regular file.`);
  }
  owned(details, path, options);
}

function privateOwnerModes(
  path: string,
  options: OwnerPrivateLockOptions,
  ...details: BigIntStats[]
): void {
  if (details.some((value) => (value.mode & 0o077n) !== 0n)) {
    throw unsafe(options, `${options.label} owner ${path} must be owner-only (mode 0600).`);
  }
}

function owned(details: { readonly uid: bigint }, path: string, options: OwnerPrivateLockOptions): void {
  if (process.getuid !== undefined && details.uid !== BigInt(process.getuid())) {
    throw unsafe(options, `${options.label} ${path} is not owned by the current user.`);
  }
}

async function sameDirectoryRequired(path: string, expected: Identity, options: OwnerPrivateLockOptions): Promise<void> {
  if (!(await sameDirectory(path, expected, options))) throw unsafe(options, `${options.label} directory identity changed.`);
}

async function sameDirectory(path: string, expected: Identity, options: OwnerPrivateLockOptions): Promise<boolean> {
  try {
    return sameIdentity(await privateDirectory(path, options), expected);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectory(path: string, expected: Identity, options: OwnerPrivateLockOptions): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat({ bigint: true });
    if (!details.isDirectory() || !sameIdentity(details, expected)) {
      throw unsafe(options, `${options.label} changed before its owner publication was synced.`);
    }
    if (options.syncDirectoryHandle === undefined) await handle.sync();
    else await options.syncDirectoryHandle(handle);
  } catch (error) {
    if (!isUnsupportedWindowsDirectorySync(error, options.platform ?? process.platform)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await sameDirectoryRequired(path, expected, options);
}

async function matchesObserved(path: string, options: OwnerPrivateLockOptions,
  expected: Observed): Promise<boolean> {
  return await compareObserved(path, options, expected) === true;
}

async function compareObserved(path: string, options: OwnerPrivateLockOptions,
  expected: Observed): Promise<boolean | undefined> {
  const value = await inspect(path, options);
  try {
    return value === undefined ? undefined : sameObserved(value, expected);
  } finally {
    await closeObserved(value);
  }
}

function sameObserved(value: Observed, expected: Observed): boolean {
  if (value.kind !== expected.kind || !sameIdentity(value.identity, expected.identity)) return false;
  if (value.kind === "ownerless") {
    if (expected.kind !== "ownerless") return false;
    if (value.mtimeMs !== expected.mtimeMs) return false;
    const valuePin = value[OWNER_PUBLICATION_IN_PROGRESS];
    const expectedPin = expected[OWNER_PUBLICATION_IN_PROGRESS];
    if (valuePin === undefined || expectedPin === undefined) return valuePin === expectedPin;
    return !valuePin.closed && !expectedPin.closed
      && samePublicationSnapshot(valuePin.details, expectedPin.details)
      && valuePin.content.equals(expectedPin.content);
  }
  return expected.kind === "owned"
    && value.owner.content === expected.owner.content
    && sameIdentity(value.owner.identity, expected.owner.identity);
}

async function closeObserved(observed: Observed | undefined): Promise<void> {
  const publication = observed?.kind === "ownerless" ? observed[OWNER_PUBLICATION_IN_PROGRESS] : undefined;
  if (publication !== undefined) await closePublication(publication);
}

async function closePublication(publication: PublicationPin): Promise<void> {
  if (publication.closed) return;
  await publication.handle.close(); publication.closed = true;
}

function artifactPath(options: OwnerPrivateLockOptions, kind: "stale" | "released" | "abandoned", pid: number, now: () => number, randomToken: () => string): string {
  const input = { path: options.path, pid, now: now(), token: checkedToken(randomToken(), options.label) };
  const custom = kind === "stale" ? options.stalePath : kind === "released" ? options.releasedPath : options.abandonedPath;
  return custom?.(input) ?? `${options.path}.${kind}.${input.now}.${pid}.${input.token}`;
}

function validateOptions(options: OwnerPrivateLockOptions): void {
  validateOwnerPrivateLockInputs(options.label, options.pid ?? process.pid, options.ownerlessGraceMs);
  if (options.schemaTag.length === 0) throw new Error(`${options.label} schema tag must not be empty.`);
  for (const value of [options.waitTimeoutMs ?? 0, options.pollIntervalMs ?? 100]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${options.label} durations must be non-negative and finite.`);
  }
  if (options.maxAcquireAttempts !== undefined
    && (!Number.isSafeInteger(options.maxAcquireAttempts) || options.maxAcquireAttempts < 1)) {
    throw new Error(`${options.label} maxAcquireAttempts must be a positive safe integer.`);
  }
}

function positivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function identity(value: { readonly dev: bigint; readonly ino: bigint }): Identity { return { dev: value.dev, ino: value.ino }; }
function sameIdentity(value: { readonly dev: bigint; readonly ino: bigint }, expected: Identity): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}
function checkedToken(value: string, label: string): string {
  if (!/^[0-9A-Za-z._-]+$/u.test(value) || value.length === 0 || value.length > 256) throw new Error(`${label} token is invalid.`);
  return value;
}
function unsafe(options: OwnerPrivateLockOptions, cause: string, details: Readonly<Record<string, unknown>> = {}): Error {
  return options.unsafeError?.(cause, details) ?? new Error(cause);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
function isUnsupportedWindowsDirectorySync(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    && ["EISDIR", "EPERM", "EACCES", "EINVAL", "EBADF"].some((code) => isErrno(error, code));
}
async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

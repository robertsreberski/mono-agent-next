// SPDX-License-Identifier: MIT
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  OwnerPrivatePathError, createOwnerPrivateFile, inspectOwnerPrivateFile,
  type OwnerPrivatePathIdentity,
} from "@mono-agent/module-sdk";
import {
  CURRENT_RUN_ROOT_MAX_ENTRIES, boundedCurrentRunEntries,
  createCurrentRunFiles, ensureCurrentRunRoot, recoverCurrentRunRoot,
  type CreateCurrentRunFilesOptions, type CurrentRunFiles, type CurrentRunRoot,
} from "./current-run-output.js";
export const CURRENT_RUN_LEASE_FILENAME = ".mono-agent-current-run.lease.sqlite";
export const CURRENT_RUN_LEASE_APPLICATION_ID = 0x4d414352;
const LEASE_DATABASE_BYTES = 4_096, SQLITE_RESERVED_SUFFIXES = ["-journal", "-shm", "-wal"] as const;
const ACTIVE_ROOTS = processGlobalLeaseRegistry();
export type CurrentRunWorkspaceErrorCode = "busy" | "closed" | "legacy_residue" | "unsafe";
export class CurrentRunWorkspaceError extends Error {
  readonly code: CurrentRunWorkspaceErrorCode;
  constructor(code: CurrentRunWorkspaceErrorCode, message: string, cause?: unknown) {
    if (cause === undefined) super(message);
    else super(message, { cause });
    this.name = "CurrentRunWorkspaceError"; this.code = code;
  }
}
export interface OpenCurrentRunWorkspaceOptions {
  readonly projectRoot: string; readonly signal?: AbortSignal;
}
export interface CurrentRunWorkspace {
  readonly root: CurrentRunRoot;
  createRunFiles(options: Omit<CreateCurrentRunFilesOptions, "root">): Promise<CurrentRunFiles>;
  close(): Promise<void>;
}
export async function openCurrentRunWorkspace(options: OpenCurrentRunWorkspaceOptions): Promise<CurrentRunWorkspace> {
  options.signal?.throwIfAborted();
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw workspaceError("unsafe", "Core current-run descriptor-anchored leases require macOS or Linux.");
  const root = await ensureCurrentRunRoot(options.projectRoot, options.signal);
  const releaseReservation = reserveRoot(root); let lease: HeldLease | undefined;
  try {
    lease = await acquireLease(root, options.signal);
    await recoverCurrentRunRoot(root, CURRENT_RUN_LEASE_FILENAME, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await lease.validate();
    return workspace(root, lease, releaseReservation);
  } catch (error) {
    let releaseError: unknown;
    try { await lease?.release(false); } catch (failure) { releaseError = failure; }
    if (lease === undefined || releaseError === undefined) releaseReservation();
    options.signal?.throwIfAborted();
    if (releaseError !== undefined) throw workspaceError(
      "unsafe", "Core current-run workspace recovery and lease release failed.",
      new AggregateError([error, releaseError]),
    );
    if (error instanceof CurrentRunWorkspaceError) throw error;
    throw workspaceError("unsafe", "Core current-run workspace validation or recovery failed.", error);
  }
}
function workspace(root: CurrentRunRoot, lease: HeldLease, releaseReservation: () => void): CurrentRunWorkspace {
  const activeRuns = new Set<symbol>(); let closing = false; let closePromise: Promise<void> | undefined;
  let quiescent: (() => void) | undefined;
  const finishRun = (token: symbol): void => {
    activeRuns.delete(token);
    if (activeRuns.size === 0) { quiescent?.(); quiescent = undefined; }
  };
  return Object.freeze({
    root,
    async createRunFiles(options: Omit<CreateCurrentRunFilesOptions, "root">): Promise<CurrentRunFiles> {
      if (closing) throw workspaceError("closed", "Core current-run workspace is closing.");
      const token = Symbol("current-run"); activeRuns.add(token);
      let files: CurrentRunFiles;
      try { await lease.validate(); files = await createCurrentRunFiles({ ...options, root }); }
      catch (error) { finishRun(token); throw error; }
      let cleanupPromise: Promise<void> | undefined;
      return Object.freeze({
        runOutputDir: files.runOutputDir,
        requestContext: files.requestContext,
        readOutput: files.readOutput,
        cleanup(): Promise<void> {
          cleanupPromise ??= files.cleanup().finally(() => { finishRun(token); });
          return cleanupPromise;
        },
      });
    },
    close(): Promise<void> {
      closing = true;
      closePromise ??= (async () => {
        if (activeRuns.size > 0) await new Promise<void>((resolve) => { quiescent = resolve; });
        await lease.release(true);
        releaseReservation();
      })();
      return closePromise;
    },
  });
}
type HeldLease = { validate(): Promise<void>; release(removeWhenEmpty: boolean): Promise<void> };
async function acquireLease(root: CurrentRunRoot, signal?: AbortSignal): Promise<HeldLease> {
  const path = join(root.path, CURRENT_RUN_LEASE_FILENAME);
  await rejectSqliteSidecars(path);
  const entries = await boundedCurrentRunEntries(
    root.path, CURRENT_RUN_ROOT_MAX_ENTRIES, "Core current-run root exceeds the entry limit.",
  );
  let identity: OwnerPrivatePathIdentity;
  try {
    identity = await inspectOwnerPrivateFile(path, signal === undefined ? {} : { signal });
  } catch (error) {
    if (!(error instanceof OwnerPrivatePathError) || error.code !== "missing")
      throw workspaceError("unsafe", "Core current-run lease validation failed.", error);
    if (entries.length !== 0)
      throw workspaceError(
        "legacy_residue",
        "Core current-run workspace has residue without a lease; stop older hosts before adoption.",
      );
    try {
      identity = await createOwnerPrivateFile(path, createLeaseDatabase(), signal === undefined ? {} : { signal });
    } catch (createError) {
      if (!(createError instanceof OwnerPrivatePathError)
        || createError.code !== "already_exists")
        throw workspaceError("unsafe", "Core current-run lease creation failed.", createError);
      identity = await inspectOwnerPrivateFile(path, signal === undefined ? {} : { signal });
    }
  }
  validateLeaseMetadata(identity);
  let database: DatabaseSync | undefined; let anchor: FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    await bindRoot(root);
    await rejectSqliteSidecars(path);
    anchor = await openLeaseAnchor(identity);
    database = new DatabaseSync(descriptorPath(anchor.fd), { timeout: 0 });
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA query_only = ON;");
    const application = database.prepare("PRAGMA application_id").get() as
      { readonly application_id?: unknown } | undefined;
    if (application?.application_id !== CURRENT_RUN_LEASE_APPLICATION_ID)
      throw new Error("Core current-run lease has an invalid application identity.");
    await validateHeldLease(root, path, identity, anchor);
    signal?.throwIfAborted();
  } catch (error) {
    try {
      if (database !== undefined) {
        try { database.exec("ROLLBACK;"); } catch { /* Close remains the safety action. */ }
        database.close();
      }
    } finally { await anchor?.close(); }
    if (isSqliteBusy(error))
      throw workspaceError(
        "busy",
        "Core current-run workspace is already owned by another live host.",
        error,
      );
    throw workspaceError("unsafe", "Core current-run lease validation failed.", error);
  }
  const acquiredDatabase = database;
  const acquiredAnchor = anchor;
  if (acquiredDatabase === undefined || acquiredAnchor === undefined)
    throw workspaceError("unsafe", "Core current-run lease could not be acquired.");
  let released = false;
  return Object.freeze({
    validate: () => validateHeldLease(root, path, identity, acquiredAnchor),
    async release(removeWhenEmpty: boolean): Promise<void> {
      if (released) return; released = true;
      const failures: unknown[] = [];
      try {
        if (removeWhenEmpty) try { await removeLeaseWhenEmpty(root, identity, acquiredAnchor); }
        catch (error) { failures.push(error); }
        try { acquiredDatabase.exec("ROLLBACK;"); } catch (error) { failures.push(error); }
        try { acquiredDatabase.close(); } catch (error) { failures.push(error); }
      } finally {
        try { await acquiredAnchor.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw workspaceError(
        "unsafe", "Core current-run lease release failed.",
        new AggregateError(failures, "Core current-run workspace cleanup failed."),
      );
    },
  });
}
async function removeLeaseWhenEmpty(
  root: CurrentRunRoot, identity: OwnerPrivatePathIdentity, anchor: FileHandle,
): Promise<void> {
  await bindRoot(root);
  await rejectSqliteSidecars(identity.path);
  const crowded = "Core current-run root is not empty."; let entries: readonly string[];
  try { entries = await boundedCurrentRunEntries(root.path, 1, crowded); }
  catch (error) { if (error instanceof Error && error.message === crowded) return; throw error; }
  if (entries.length !== 1 || entries[0] !== CURRENT_RUN_LEASE_FILENAME) return;
  await validateLeaseAnchor(anchor, identity);
  assertLeaseStat(await lstat(identity.path), identity);
  await unlink(identity.path);
}
async function openLeaseAnchor(expected: OwnerPrivatePathIdentity): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== "number")
    throw new Error("Core current-run leases require O_NOFOLLOW.");
  let handle: FileHandle | undefined;
  try {
    handle = await open(expected.path, constants.O_RDWR | constants.O_NOFOLLOW);
    await validateLeaseAnchor(handle, expected);
    return handle;
  } catch (error) { await handle?.close(); throw error; }
}
async function validateLeaseAnchor(
  handle: FileHandle, expected: OwnerPrivatePathIdentity,
): Promise<void> {
  assertLeaseStat(await handle.stat(), expected);
}
async function validateHeldLease(root: CurrentRunRoot, path: string,
  identity: OwnerPrivatePathIdentity, anchor: FileHandle): Promise<void> {
  await validateLeaseAnchor(anchor, identity); assertLeaseStat(await lstat(path), identity);
  await bindRoot(root); await rejectSqliteSidecars(path);
}
function assertLeaseStat(actual: Stats, expected: OwnerPrivatePathIdentity): void {
  if (!actual.isFile()
    || actual.isSymbolicLink()
    || actual.dev !== expected.device || actual.ino !== expected.inode
    || actual.uid !== expected.uid || (actual.mode & 0o777) !== expected.mode
    || actual.nlink !== expected.links || actual.size !== expected.size)
    throw new Error("Core current-run lease identity changed before locking.");
}
function validateLeaseMetadata(identity: OwnerPrivatePathIdentity): void {
  if (identity.mode !== 0o600
    || identity.links !== 1 || identity.size !== LEASE_DATABASE_BYTES)
    throw new Error("Core current-run lease metadata is invalid.");
}
async function bindRoot(expected: CurrentRunRoot): Promise<void> {
  const stat = await lstat(expected.path, { bigint: true });
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== expected.dev
    || stat.ino !== expected.ino
    || (stat.mode & 0o777n) !== 0o700n
    || typeof process.geteuid !== "function" || stat.uid !== BigInt(process.geteuid()))
    throw new Error("Core current-run root identity changed.");
}
async function rejectSqliteSidecars(path: string): Promise<void> {
  for (const suffix of SQLITE_RESERVED_SUFFIXES) {
    const sidecar = await lstat(`${path}${suffix}`).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (sidecar !== undefined) throw workspaceError(
      "unsafe", "Core current-run lease has an unexpected SQLite sidecar.",
    );
  }
}
function reserveRoot(identity: CurrentRunRoot): () => void {
  const key = `${identity.dev}:${identity.ino}`;
  if (ACTIVE_ROOTS.has(key))
    throw workspaceError(
      "busy",
      "Core current-run workspace is already owned by another live host.",
    );
  ACTIVE_ROOTS.add(key);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ACTIVE_ROOTS.delete(key);
  };
}
function processGlobalLeaseRegistry(): Set<string> {
  const key = Symbol.for("mono-agent.core.active-current-run-roots.v1");
  const existing = Reflect.get(globalThis, key) as unknown;
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>(); Reflect.set(globalThis, key, created); return created;
}
function createLeaseDatabase(): Uint8Array {
  const database = Buffer.alloc(LEASE_DATABASE_BYTES);
  database.write("SQLite format 3\0", 0, "binary");
  database.writeUInt16BE(LEASE_DATABASE_BYTES, 16);
  database[18] = 1; database[19] = 1;
  database[21] = 64; database[22] = 32; database[23] = 32;
  database.writeUInt32BE(1, 28);
  database.writeUInt32BE(CURRENT_RUN_LEASE_APPLICATION_ID, 68);
  database[100] = 0x0d; database.writeUInt16BE(LEASE_DATABASE_BYTES, 105);
  return database;
}
function descriptorPath(fileDescriptor: number): string {
  if (process.platform === "darwin") return `/dev/fd/${fileDescriptor}`;
  if (process.platform === "linux") return `/proc/self/fd/${fileDescriptor}`;
  throw new Error("Core current-run descriptor-anchored leases require macOS or Linux.");
}
function isSqliteBusy(error: unknown): boolean {
  return hasCode(error, "ERR_SQLITE_ERROR")
    && /(?:busy|locked)/iu.test(error instanceof Error ? error.message : String(error));
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null && Reflect.get(error, "code") === code;
}
function workspaceError(
  code: CurrentRunWorkspaceErrorCode, message: string, cause?: unknown,
): CurrentRunWorkspaceError {
  return new CurrentRunWorkspaceError(code, message, cause);
}

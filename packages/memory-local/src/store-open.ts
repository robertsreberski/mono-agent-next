import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { MemoryHost } from "@mono-agent/module-sdk";

import {
  assertReadableMemoryRows,
  auditBujoDatabase,
  configureBujoDatabase,
  createBujoSchema,
  openBujoDatabase,
  quickCheck,
  verifyBujoSchema,
} from "./bujo-db.js";
import type { MemoryLocalConfig } from "./config.js";
import type { MemoryEmbeddingProvider } from "./embeddings.js";
import { MemoryLocalError } from "./errors.js";
import {
  assertInitializedMarkerBytes,
  assertMarkerBytes,
  parseMarker,
  readHandleBytes,
  readPinnedBytes,
  writeMarkerState,
  type StoreMarker,
} from "./store-marker.js";
import {
  bindSecureDatabaseFile,
  createSecureFile,
  openPinnedSecureFile,
  openSecureRoot,
  openSecureSqliteSidecars,
  pathExists,
  readSecureFile,
  rejectLegacyMarkerArtifacts,
  sameFileIdentity,
  syncDirectory,
  verifySecureRoot,
  type BoundSecureDatabaseFile,
  type FileIdentity,
  type PinnedSecureFile,
  type SecureRoot,
  type SecureSqliteSidecars,
} from "./security.js";
import {
  acquireMemoryWriterLease,
  type MemoryWriterLease,
  type MemoryWriterLeaseHooks,
} from "./writer-lease.js";

export const MEMORY_LOCAL_DATABASE_FILENAME = "memory.db";
export const MEMORY_LOCAL_MARKER_FILENAME = ".first-run-memory-initializing";

const MARKER_MAX_BYTES = 128;
const MANIFEST_MAX_BYTES = 256 * 1024;
const MANAGED_GENERATION = /^g-[0-9]{8}T[0-9]{9}Z-[a-f0-9-]{36}$/u;

export interface MemoryLocalOpenHooks {
  readonly writerLease?: MemoryWriterLeaseHooks;
  readonly beforeDatabaseOpen?: (path: string) => void | Promise<void>;
  readonly afterDatabaseOpen?: (path: string) => void | Promise<void>;
  readonly beforeMarkerCommit?: (path: string) => void | Promise<void>;
  readonly afterMarkerCommit?: (path: string) => void | Promise<void>;
  readonly beforeMarkerReopen?: (path: string) => void | Promise<void>;
  readonly beforeCaptureCommit?: () => void;
  readonly beforeConsolidationCommit?: () => void | Promise<void>;
}

export interface OpenMemoryLocalOptions {
  readonly config?: unknown;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly host?: MemoryHost;
  readonly embeddingProvider?: MemoryEmbeddingProvider;
  readonly clock?: () => Date;
}

export interface OpenMemoryLocalForTestingOptions extends OpenMemoryLocalOptions {
  readonly hooks?: MemoryLocalOpenHooks;
}

export interface StoreState {
  readonly root: SecureRoot;
  readonly databasePath: string;
  readonly markerPath: string;
  readonly databaseFile: BoundSecureDatabaseFile;
  readonly sidecars: SecureSqliteSidecars;
  readonly markerFile: PinnedSecureFile;
  readonly marker: StoreMarker;
  readonly markerBytes: Uint8Array;
  readonly database: DatabaseSync;
  readonly lease: MemoryWriterLease;
  readonly vectorDimensions: number;
}

export async function openStore(
  directory: string,
  config: MemoryLocalConfig,
  hooks: MemoryLocalOpenHooks,
): Promise<StoreState> {
  const root = await openSecureRoot(directory);
  let lease: MemoryWriterLease | undefined;
  try {
    await rejectLegacyMarkerArtifacts(root);
    const markerPath = join(root.path, MEMORY_LOCAL_MARKER_FILENAME);
    const databasePath = await resolveDatabasePath(root);
    const markerExists = await pathExists(markerPath);
    const databaseExists = databasePath !== undefined;
    if (!databaseExists && !markerExists) {
      if ((await readdir(root.path)).length !== 0) {
        throw new MemoryLocalError(
          "incomplete_initialization",
          "Memory directory is non-empty but has no permanent BuJo store identity.",
        );
      }
      lease = await acquireMemoryWriterLease(root, hooks.writerLease);
      return await initializeStore(
        root,
        join(root.path, MEMORY_LOCAL_DATABASE_FILENAME),
        markerPath,
        lease,
        config.embeddings?.dimensions ?? 768,
        hooks,
      );
    }
    if (!databaseExists || !markerExists || databasePath === undefined) {
      throw new MemoryLocalError(
        "incomplete_initialization",
        "Memory database and permanent marker must either both exist or both be absent.",
      );
    }
    await readSecureFile(markerPath, MARKER_MAX_BYTES);
    lease = await acquireMemoryWriterLease(root, hooks.writerLease);
    return await openExistingStore(root, databasePath, markerPath, lease, config, hooks);
  } catch (error) {
    await lease?.release().catch(() => undefined);
    await root.handle.close().catch(() => undefined);
    throw error;
  }
}

async function initializeStore(
  root: SecureRoot,
  databasePath: string,
  markerPath: string,
  lease: MemoryWriterLease,
  dimensions: number,
  hooks: MemoryLocalOpenHooks,
): Promise<StoreState> {
  const storeId = randomUUID();
  const markerHandle = await createSecureFile(markerPath);
  let database: DatabaseSync | undefined;
  let databaseFile: BoundSecureDatabaseFile | undefined;
  let sidecars: SecureSqliteSidecars | undefined;
  try {
    await writeMarkerState(markerHandle, "initializing", storeId);
    await syncDirectory(root.path);
    const databaseHandle = await createSecureFile(databasePath);
    try {
      await databaseHandle.sync();
    } finally {
      await databaseHandle.close();
    }
    databaseFile = await bindSecureDatabaseFile(
      databasePath,
      () => hooks.beforeDatabaseOpen?.(databasePath),
    );
    await databaseFile.verify();
    sidecars = await openSecureSqliteSidecars(
      databaseFile.openPath,
      databaseFile.recovering,
    );
    database = openBujoDatabase(databaseFile.openPath);
    await databaseFile.verify();
    await sidecars.captureNew();
    await hooks.afterDatabaseOpen?.(databasePath);
    await databaseFile.verify();
    await sidecars.verify();
    configureBujoDatabase(database);
    await sidecars.captureNew();
    createBujoSchema(database, dimensions);
    await sidecars.captureNew();
    quickCheck(database);
    checkpoint(database);
    await sidecars.captureNew();
    await databaseFile.verify();
    await verifySecureRoot(root);
    const markerIdentity = fileIdentity(await markerHandle.stat());
    const markerBefore = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(markerIdentity, markerBefore.identity)) {
      throw new MemoryLocalError("unsafe_store", "First-run marker identity changed before publication.");
    }
    assertMarkerBytes(markerBefore.bytes, "initializing", storeId);
    await hooks.beforeMarkerCommit?.(markerPath);
    await verifySecureRoot(root);
    await databaseFile.verify();
    const descriptorBytes = await readHandleBytes(markerHandle, MARKER_MAX_BYTES);
    assertMarkerBytes(descriptorBytes, "initializing", storeId);
    const pathBeforeCommit = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(markerIdentity, pathBeforeCommit.identity)) {
      throw new MemoryLocalError("unsafe_store", "First-run marker pathname changed before publication.");
    }
    assertMarkerBytes(pathBeforeCommit.bytes, "initializing", storeId);
    await writeMarkerState(markerHandle, "initialized", storeId);
    await syncDirectory(root.path);
    await hooks.afterMarkerCommit?.(markerPath);
    const markerAfter = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(markerIdentity, markerAfter.identity)) {
      throw new MemoryLocalError("unsafe_store", "First-run marker identity changed during publication.");
    }
    const marker = Object.freeze({ state: "initialized" as const, storeId });
    assertInitializedMarkerBytes(markerAfter.bytes, marker);
    await databaseFile.verify();
    await verifySecureRoot(root);
    await hooks.beforeMarkerReopen?.(markerPath);
    const markerFile = await openPinnedSecureFile(markerPath);
    if (!sameFileIdentity(markerIdentity, markerFile.identity)) {
      await markerFile.close();
      throw new MemoryLocalError("unsafe_store", "First-run marker identity changed before reopening.");
    }
    return {
      root,
      databasePath,
      markerPath,
      databaseFile,
      sidecars,
      markerFile,
      marker,
      markerBytes: Uint8Array.from(markerAfter.bytes),
      database,
      lease,
      vectorDimensions: dimensions,
    };
  } catch (error) {
    const closeFailure = await closeDatabaseSafely(database, sidecars);
    await databaseFile?.close().catch(() => undefined);
    const reported = closeFailure ?? error;
    throw new MemoryLocalError(
      reported instanceof MemoryLocalError ? reported.code : "corrupt_store",
      reported instanceof MemoryLocalError
        ? reported.message
        : "Memory store initialization failed and was left for inspection.",
      { cause: safeInitializationCause(reported) },
    );
  } finally {
    await markerHandle.close().catch(() => undefined);
  }
}

async function openExistingStore(
  root: SecureRoot,
  databasePath: string,
  markerPath: string,
  lease: MemoryWriterLease,
  config: MemoryLocalConfig,
  hooks: MemoryLocalOpenHooks,
): Promise<StoreState> {
  const markerFile = await openPinnedSecureFile(markerPath);
  let databaseFile: BoundSecureDatabaseFile | undefined;
  let database: DatabaseSync | undefined;
  let sidecars: SecureSqliteSidecars | undefined;
  try {
    databaseFile = await bindSecureDatabaseFile(
      databasePath,
      () => hooks.beforeDatabaseOpen?.(databasePath),
    );
    const markerBytes = await readPinnedBytes(markerFile, MARKER_MAX_BYTES);
    const marker = parseMarker(markerBytes);
    assertInitializedMarkerBytes(markerBytes, marker);
    await databaseFile.verify();
    sidecars = await openSecureSqliteSidecars(
      databaseFile.openPath,
      databaseFile.recovering,
    );
    database = openBujoDatabase(databaseFile.openPath);
    await databaseFile.verify();
    await sidecars.captureNew();
    await hooks.afterDatabaseOpen?.(databasePath);
    await databaseFile.verify();
    await sidecars.verify();
    configureBujoDatabase(database);
    await sidecars.captureNew();
    const snapshot = auditBujoDatabase(database);
    assertReadableMemoryRows(database, config, snapshot);
    const vectorDimensions = verifyBujoSchema(database);
    await sidecars.captureNew();
    await verifySecureRoot(root);
    await markerFile.verify();
    await databaseFile.verify();
    const finalMarker = await readPinnedBytes(markerFile, MARKER_MAX_BYTES);
    assertInitializedMarkerBytes(finalMarker, marker);
    return {
      root,
      databasePath,
      markerPath,
      databaseFile,
      sidecars,
      markerFile,
      marker,
      markerBytes: Uint8Array.from(markerBytes),
      database,
      lease,
      vectorDimensions,
    };
  } catch (error) {
    const closeFailure = await closeDatabaseSafely(database, sidecars);
    await markerFile.close().catch(() => undefined);
    await databaseFile?.close().catch(() => undefined);
    const reported = closeFailure ?? error;
    throw new MemoryLocalError(
      reported instanceof MemoryLocalError ? reported.code : "corrupt_store",
      reported instanceof MemoryLocalError
        ? reported.message
        : "Memory database is corrupt or incompatible; refusing to modify it.",
      { cause: safeInitializationCause(reported) },
    );
  }
}

async function resolveDatabasePath(root: SecureRoot): Promise<string | undefined> {
  const manifestPath = join(root.path, ".index", "manifest.json");
  if (await pathExists(manifestPath)) {
    const manifestRead = await readSecureFile(manifestPath, MANIFEST_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.bytes));
    } catch {
      throw new MemoryLocalError("corrupt_store", "Managed BuJo manifest is malformed.");
    }
    if (!isPlainObject(parsed) || parsed.schemaVersion !== 1 || !isPlainObject(parsed.active)) {
      throw new MemoryLocalError("corrupt_store", "Managed BuJo manifest has an unsupported identity.");
    }
    const name = parsed.active.name;
    if (typeof name !== "string" || !MANAGED_GENERATION.test(name)) {
      throw new MemoryLocalError("corrupt_store", "Managed BuJo manifest active generation is malformed.");
    }
    const generationDirectory = join(root.path, ".index", "generations", name);
    const canonical = await realpath(generationDirectory).catch(() => undefined);
    if (canonical !== generationDirectory) {
      throw new MemoryLocalError("unsafe_store", "Managed BuJo generation path is absent or traverses a link.");
    }
    const directoryStat = await lstat(generationDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || directoryStat.uid !== currentUid() || (directoryStat.mode & 0o777) !== 0o700) {
      throw new MemoryLocalError("unsafe_store", "Managed BuJo generation directory is unsafe.");
    }
    return join(generationDirectory, MEMORY_LOCAL_DATABASE_FILENAME);
  }
  const legacy = join(root.path, MEMORY_LOCAL_DATABASE_FILENAME);
  return await pathExists(legacy) ? legacy : undefined;
}

export async function closeDatabaseSafely(
  database: DatabaseSync | undefined,
  sidecars: SecureSqliteSidecars | undefined,
): Promise<unknown | undefined> {
  if (database === undefined) {
    try {
      await sidecars?.close();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  let failure: unknown;
  if (sidecars !== undefined) {
    try {
      failure = await sidecars.prepareForDatabaseClose();
    } catch (error) {
      // Do not allow pathname-only SQLite close to unlink an object that could
      // not first be retained under descriptor-backed quarantine authority.
      return error;
    }
  }
  try {
    database.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await sidecars?.close();
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new MemoryLocalError("unsafe_store", "memory-local requires POSIX ownership checks.");
  }
  return process.getuid();
}

function fileIdentity(stat: import("node:fs").Stats): FileIdentity {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: stat.mode & 0o7777,
    links: stat.nlink,
    owner: stat.uid,
    size: stat.size,
  });
}

function safeInitializationCause(error: unknown): Error | undefined {
  if (error instanceof MemoryLocalError) return undefined;
  const code = typeof error === "object" && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;
  return new Error(typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? `Memory initialization failed with ${code}`
    : "Memory initialization failed");
}

function checkpoint(database: DatabaseSync): void {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

// SPDX-License-Identifier: MIT
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { MemoryLocalError } from "./errors.js";
import {
  createSecureFile,
  inspectSecureFile,
  openPinnedSecureFile,
  pathExists,
  syncDirectory,
  type SecureRoot,
} from "./security.js";

export const MEMORY_LOCAL_WRITER_LEASE_FILENAME = ".memory-local-writer.sqlite";

const LEASE_APPLICATION_ID = 0x4d414c31;
const SIDECAR_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

export interface MemoryWriterLease {
  readonly path: string;
  verify(): Promise<void>;
  release(): Promise<void>;
}

export interface MemoryWriterLeaseHooks {
  readonly afterInspect?: (path: string) => void | Promise<void>;
}

export async function acquireMemoryWriterLease(
  root: SecureRoot,
  hooks: MemoryWriterLeaseHooks = {},
): Promise<MemoryWriterLease> {
  const path = join(root.path, MEMORY_LOCAL_WRITER_LEASE_FILENAME);
  await rejectSidecars(path);
  if (!(await pathExists(path))) {
    const handle = await createSecureFile(path);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await initializeLeaseDatabase(path);
    await syncDirectory(root.path);
  }
  await inspectSecureFile(path);
  await hooks.afterInspect?.(path);
  const pinned = await openPinnedSecureFile(path);
  let database: DatabaseSync | undefined;
  try {
    await pinned.verify();
    await rejectSidecars(path);
    database = new DatabaseSync(path, { timeout: 0 });
    await pinned.verify();
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA query_only = ON;");
    const row = database.prepare("PRAGMA application_id").get() as
      | { application_id?: unknown }
      | undefined;
    if (row?.application_id !== LEASE_APPLICATION_ID) {
      throw new MemoryLocalError("corrupt_store", "Memory writer lease has an invalid application identity.");
    }
    await pinned.verify();
    await rejectSidecars(path);
  } catch (error) {
    releaseDatabase(database);
    await pinned.close().catch(() => undefined);
    if (error instanceof MemoryLocalError) throw error;
    if (isSqliteBusy(error)) {
      throw new MemoryLocalError("writer_active", "This memory root already has a live writer.");
    }
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory writer lease could not be acquired.",
      { cause: safeLeaseCause(error) },
    );
  }

  const acquired = database;
  let released = false;
  return {
    path,
    verify: async () => {
      if (released) throw new MemoryLocalError("closed", "Memory writer lease is released.");
      await pinned.verify();
      await rejectSidecars(path);
      const row = acquired.prepare("PRAGMA application_id").get() as
        | { application_id?: unknown }
        | undefined;
      if (row?.application_id !== LEASE_APPLICATION_ID) {
        throw new MemoryLocalError("corrupt_store", "Memory writer lease identity changed.");
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      releaseDatabase(acquired);
      await pinned.close();
    },
  };
}

async function initializeLeaseDatabase(path: string): Promise<void> {
  const pinned = await openPinnedSecureFile(path);
  let database: DatabaseSync | undefined;
  try {
    await pinned.verify();
    database = new DatabaseSync(path, { timeout: 0 });
    await pinned.verify();
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA application_id = ${LEASE_APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE writer_lease_identity (
        schema_version INTEGER PRIMARY KEY CHECK (schema_version = 1)
      ) STRICT;
      INSERT INTO writer_lease_identity(schema_version) VALUES (1);
    `);
    database.close();
    database = undefined;
    await pinned.verify();
    await rejectSidecars(path);
  } catch (error) {
    releaseDatabase(database);
    throw new MemoryLocalError(
      "corrupt_store",
      "Memory writer lease could not be initialized.",
      { cause: safeLeaseCause(error) },
    );
  } finally {
    await pinned.close();
  }
}

async function rejectSidecars(path: string): Promise<void> {
  for (const suffix of SIDECAR_SUFFIXES) {
    if (await pathExists(`${path}${suffix}`)) {
      throw new MemoryLocalError(
        "unsafe_store",
        "Memory writer lease has an unexpected SQLite sidecar.",
      );
    }
  }
}

function releaseDatabase(database: DatabaseSync | undefined): void {
  if (database === undefined) return;
  try {
    database.exec("ROLLBACK");
  } catch {
    // The exclusive transaction may not have started.
  }
  try {
    database.close();
  } catch {
    // Release is best effort; the OS still releases locks on process exit.
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return code === "ERR_SQLITE_ERROR" && /(?:busy|locked)/iu.test(error.message);
}

function safeLeaseCause(error: unknown): Error {
  return new Error(isSqliteBusy(error) ? "SQLite lease is busy" : "SQLite lease validation failed");
}

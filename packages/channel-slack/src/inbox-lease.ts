// SPDX-License-Identifier: MIT
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  OwnerPrivatePathError,
  createOwnerPrivateFile,
  inspectOwnerPrivateFile,
  type OwnerPrivatePathIdentity,
} from "@mono-agent/module-sdk";

import { sameIdentity, throwIfAborted } from "./inbox-values.js";

const LEASE_FILE = ".mono-agent-slack-inbox.lease.sqlite";
const LEASE_APPLICATION_ID = 0x4d41534c;
const SQLITE_RESERVED_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

export interface SlackInboxLease {
  release(): Promise<void>;
}

export async function acquireSlackInboxLease(
  directory: string,
  signal?: AbortSignal,
): Promise<SlackInboxLease> {
  const path = join(directory, LEASE_FILE);
  throwIfAborted(signal);
  await rejectSqliteSidecars(path);
  let identity: OwnerPrivatePathIdentity;
  try {
    identity = await inspectOwnerPrivateFile(
      path,
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (!(error instanceof OwnerPrivatePathError) || error.code !== "missing") {
      throw leaseError("Slack durable inbox lease path validation failed.", error);
    }
    try {
      identity = await createOwnerPrivateFile(
        path,
        createLeaseDatabase(),
        signal === undefined ? {} : { signal },
      );
    } catch (createError) {
      if (!(createError instanceof OwnerPrivatePathError)
        || createError.code !== "already_exists") {
        throw leaseError("Slack durable inbox lease could not be created.", createError);
      }
      identity = await inspectOwnerPrivateFile(
        path,
        signal === undefined ? {} : { signal },
      );
    }
  }

  let database: DatabaseSync | undefined;
  let locked = false;
  try {
    throwIfAborted(signal);
    await rejectSqliteSidecars(path);
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA query_only = ON;");
    locked = true;
    const application = database.prepare("PRAGMA application_id").get() as
      | { readonly application_id?: unknown }
      | undefined;
    if (application?.application_id !== LEASE_APPLICATION_ID) {
      throw new Error("Slack durable inbox lease has an invalid application identity.");
    }
    const verified = await inspectOwnerPrivateFile(
      path,
      signal === undefined ? {} : { signal },
    );
    if (!sameIdentity(identity, verified)) {
      throw new Error("Slack durable inbox lease identity changed while locking.");
    }
    await rejectSqliteSidecars(path);
    throwIfAborted(signal);
  } catch (error) {
    if (database !== undefined) {
      if (locked) {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // The database is being closed after a failed lease acquisition.
        }
      }
      database.close();
    }
    if (isSqliteBusy(error)) {
      throw leaseError(
        "Slack durable inbox is in use by a serving channel or maintenance process.",
        error,
      );
    }
    throw leaseError("Slack durable inbox lease validation failed.", error);
  }

  const acquired = database;
  if (acquired === undefined) {
    throw leaseError("Slack durable inbox lease could not be acquired.");
  }
  let released = false;
  return Object.freeze({
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        acquired.exec("ROLLBACK;");
      } finally {
        acquired.close();
      }
      await rejectSqliteSidecars(path);
    },
  });
}

function createLeaseDatabase(): Uint8Array {
  const pageBytes = 4_096;
  const database = Buffer.alloc(pageBytes);
  database.write("SQLite format 3\0", 0, "binary");
  database.writeUInt16BE(pageBytes, 16);
  database[18] = 1;
  database[19] = 1;
  database[21] = 64;
  database[22] = 32;
  database[23] = 32;
  database.writeUInt32BE(1, 28);
  database.writeUInt32BE(LEASE_APPLICATION_ID, 68);
  database[100] = 0x0d;
  database.writeUInt16BE(pageBytes, 105);
  return database;
}

async function rejectSqliteSidecars(path: string): Promise<void> {
  for (const suffix of SQLITE_RESERVED_SUFFIXES) {
    const reserved = `${path}${suffix}`;
    const info = await lstat(reserved).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (info !== undefined) {
      throw new Error(
        "Slack durable inbox lease has an unexpected SQLite sidecar.",
      );
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}

function isSqliteBusy(error: unknown): boolean {
  return hasCode(error, "ERR_SQLITE_ERROR")
    && /(?:busy|locked)/iu.test(
      error instanceof Error ? error.message : String(error),
    );
}

function leaseError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

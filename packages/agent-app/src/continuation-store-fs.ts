import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { continuationDigest } from "./continuations.js";
import { isMissing, isObject } from "./continuation-store-policy.js";
import {
  OWNER_DATABASE_FILE,
  type ContinuationStoreLock,
} from "./continuation-store-types.js";

export async function acquireContinuationStoreLock(stateDir: string): Promise<ContinuationStoreLock> {
  await ensureOwnerOnlyDirectory(stateDir);
  const path = join(stateDir, OWNER_DATABASE_FILE);
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    if (await continuationPathExists(path)) {
      await assertOwnerOnlyRegularFile(path, "Continuation owner database");
    }
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(path, { timeout: 0 });
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assertOwnerOnlyRegularFile(path, "Continuation owner database");
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS ownership (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO ownership (id, pid, acquired_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at
    `).run(process.pid, new Date().toISOString());
    const journalPath = `${path}-journal`;
    if (process.platform !== "win32" && await continuationPathExists(journalPath)) {
      await chmod(journalPath, 0o600);
    }
  } catch (error) {
    try { database?.close(); } catch { /* best-effort close after failed acquisition */ }
    if (isObject(error)
      && error.code === "ERR_SQLITE_ERROR"
      && String(error.message).includes("database is locked")) {
      throw new Error(`Continuation state is already owned by another live process: ${stateDir}`, { cause: error });
    }
    throw error;
  }
  let released = false;
  const owner = database;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        if (owner.isTransaction) owner.exec("ROLLBACK");
      } finally {
        owner.close();
      }
    },
  };
}

export async function loadOrCreateContinuationSecret(stateDir: string): Promise<Buffer> {
  await ensureOwnerOnlyDirectory(stateDir);
  const path = join(stateDir, "continuation-secret");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Continuation secret is not a regular file: ${path}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`Continuation secret is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`Continuation secret permissions are not owner-only: ${path}`);
    }
    const encoded = (await readFile(path, "utf8")).trim();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length !== 32) throw new Error(`Continuation secret has invalid contents: ${path}`);
    return secret;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const secret = randomBytes(32);
  try {
    await writeFile(path, `${secret.toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if (!isObject(error) || error.code !== "EEXIST") throw error;
    return await loadOrCreateContinuationSecret(stateDir);
  }
}

export async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Continuation state path is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Continuation state directory is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
    const repaired = await lstat(path);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error(`Continuation state directory permissions are not owner-only: ${path}`);
    }
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  syncParent = true,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`Durable continuation file exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
  }
  const temporary = join(
    dirname(path),
    `.${continuationDigest(path).slice(0, 12)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    if (syncParent) await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeTextAtomic(path: string, body: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`Durable continuation file exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
  }
  const temporary = join(
    dirname(path),
    `.${continuationDigest(path).slice(0, 12)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function continuationPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function assertOwnerOnlyRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  assertOwnerOnlySingleLinkStats(info, path, label);
}

function assertOwnerOnlySingleLinkStats(info: Stats, path: string, label: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  if (info.nlink !== 1) throw new Error(`${label} must have exactly one filesystem link: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not owner-only: ${path}`);
  }
}

export async function readBoundedOwnerOnlyFile(path: string, maxBytes: number, label: string): Promise<string> {
  return (await readBoundedOwnerOnlyFileWithStats(path, maxBytes, label)).text;
}

export async function readBoundedOwnerOnlyFileWithStats(
  path: string,
  maxBytes: number,
  label: string,
): Promise<{ readonly text: string; readonly bytes: number }> {
  const pathInfo = await lstat(path);
  assertOwnerOnlySingleLinkStats(pathInfo, path, label);
  const flags = fsConstants.O_RDONLY
    | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, flags);
    const before = await handle.stat();
    assertOwnerOnlySingleLinkStats(before, path, label);
    if (before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
      throw new Error(`${label} changed identity while it was opened: ${path}`);
    }
    if (before.size > maxBytes) {
      throw new Error(`${label} exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    assertOwnerOnlySingleLinkStats(after, path, label);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || body.byteLength !== before.size) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return { text: body.toString("utf8"), bytes: body.byteLength };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (process.platform === "win32"
      && isObject(error)
      && (error.code === "EISDIR"
        || error.code === "EPERM"
        || error.code === "EACCES"
        || error.code === "EINVAL"
        || error.code === "EBADF")) {
      return;
    }
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import { parseDailyFile, serializeBullet, serializeDailyFile } from "./grammar.js";
import {
  appendCanonicalFile,
  assertCanonicalDailySourcePath,
  canonicalMemoryRootPath,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
import { withManagedRollbackRetirement } from "./generations.js";
import type { Bullet } from "./types.js";

export const JOURNAL_WRITE_LOCK_STALE_AFTER_MS = 30_000;

export type JournalWriteLockStatus = "clear" | "active" | "stale" | "unsafe";

export function dailyFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "daily", `${day}.md`);
}

export function auditFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "audit", `${day}.md`);
}

export function normalizedContentHash(text: string): string {
  const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Append a bullet to today's daily file (creating it with a heading if absent). Returns the bullet. */
export function appendBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const day = when.toISOString().slice(0, 10);
  // Validate the complete payload before retiring a still-valid rollback.
  const serialized = serializeBullet(bullet);
  withManagedRollbackRetirement(root, "daily", () => appendCanonicalFile(root, `daily/${day}.md`, (existingSize) => {
    const header = existingSize === 0 ? `# ${day}\n\n` : "";
    return `${header}${serialized}\n`;
  }));
  return bullet;
}

/** Append an immutable raw host observation outside the curated recall source. */
export function appendAuditBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const day = when.toISOString().slice(0, 10);
  appendCanonicalFile(root, `audit/${day}.md`, (existingSize) => {
    const header = existingSize === 0 ? `# ${day}\n\n` : "";
    return `${header}${serializeBullet(bullet)}\n`;
  });
  return bullet;
}

/**
 * Serialize Journal's markdown append + SQLite hash reservation across local
 * processes. A stale marker is recovered only when its owning pid is gone.
 */
export function withJournalWriteLock<T>(root: string, write: () => T): T {
  const canonicalRoot = canonicalMemoryRootPath(root, true);
  const lockPath = join(canonicalRoot, ".journal-write.lock");
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const opened = fstatSync(fd);
      if (!safeOwnedLock(opened)) throw new Error("memory-bujo: journal write lock has an unsafe identity.");
      const published = lstatSync(lockPath);
      if (published.dev !== opened.dev || published.ino !== opened.ino) {
        throw new Error("memory-bujo: journal write lock was replaced during acquisition.");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (fd !== undefined) {
          try {
            const opened = fstatSync(fd);
            const current = lstatSync(lockPath);
            if (current.dev === opened.dev && current.ino === opened.ino) unlinkSync(lockPath);
          } catch {
            // Never unlink an identity we cannot prove is the one just opened.
          }
          try { closeSync(fd); } catch { /* already closed */ }
          fd = undefined;
        }
        throw error;
      }
      const existing = classifyJournalWriteLock(canonicalRoot, Date.now());
      if (existing.status === "active") {
        if (existing.owner?.pid !== undefined) {
          throw new Error(`memory-bujo: journal write lock is held by pid ${existing.owner.pid}.`);
        }
        throw new Error("memory-bujo: journal write lock is held or has an unverified owner.");
      }
      // The same read-only classifier powers strict health. Mutation remains a
      // writer-only responsibility and requires the exact pinned identity.
      if (existing.status !== "stale" || existing.owner === undefined
        || !unlinkIfSame(canonicalRoot, existing.owner)) {
        throw new Error("memory-bujo: journal write lock is held or has an unverified owner.");
      }
    }
  }
  if (fd === undefined) throw new Error("memory-bujo: could not acquire journal write lock.");
  const identity = fstatSync(fd);
  try {
    writeSync(fd, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
      token: randomUUID(),
    })}\n`, null, "utf8");
    fsyncSync(fd);
    return write();
  } finally {
    try {
      const current = lstatSync(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) {
        unlinkSync(lockPath);
      }
    } catch {
      // A removed/replaced lock is not ours to clean up.
    }
    closeSync(fd);
  }
}

interface LockOwner {
  readonly pid?: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

interface JournalWriteLockClassification {
  readonly status: JournalWriteLockStatus;
  readonly owner?: LockOwner;
}

/** Read-only lock classifier shared by the writer and strict health audit. */
export function inspectJournalWriteLock(root: string, nowMs = Date.now()): JournalWriteLockStatus {
  return classifyJournalWriteLock(canonicalMemoryRootPath(root, false), nowMs).status;
}

function classifyJournalWriteLock(root: string, nowMs: number): JournalWriteLockClassification {
  try {
    const snapshot = readCanonicalFileSnapshot(root, ".journal-write.lock", {
      allowMissing: true,
      maxBytes: 4_096,
    });
    if (snapshot === undefined) return { status: "clear" };
    if ((snapshot.identity.mode & 0o777) !== 0o600
      || snapshot.identity.nlink !== 1
      || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
      return { status: "unsafe" };
    }
    let pid: number | undefined;
    let validOwner = false;
    try {
      const parsed = JSON.parse(snapshot.content) as {
        schemaVersion?: unknown;
        pid?: unknown;
        uid?: unknown;
        token?: unknown;
      };
      if (typeof process.getuid === "function"
        && parsed.uid !== undefined
        && parsed.uid !== process.getuid()) return { status: "unsafe" };
      const value = parsed.pid;
      if (parsed.schemaVersion === 1
        && typeof value === "number"
        && Number.isInteger(value)
        && value > 0
        && typeof parsed.token === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(parsed.token)) {
        pid = value;
        validOwner = true;
      }
    } catch {
      // Preserve stable identity/mtime so an abandoned malformed lock can be
      // reclaimed after the grace period without stealing a fresh publish.
    }
    const owner: LockOwner = {
      ...(pid === undefined ? {} : { pid }),
      dev: snapshot.identity.dev,
      ino: snapshot.identity.ino,
      mtimeMs: snapshot.identity.mtimeMs,
    };
    if (validOwner && pid !== undefined && processIsAlive(pid)) return { status: "active", owner };
    if (nowMs - snapshot.identity.mtimeMs < JOURNAL_WRITE_LOCK_STALE_AFTER_MS) {
      return { status: "active", owner };
    }
    return { status: "stale", owner };
  } catch {
    return { status: "unsafe" };
  }
}

function unlinkIfSame(root: string, owner: LockOwner): boolean {
  const lockPath = join(root, ".journal-write.lock");
  try {
    const current = lstatSync(lockPath);
    if (!safeOwnedLock(current) || current.dev !== owner.dev || current.ino !== owner.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function safeOwnedLock(stat: Stats): boolean {
  return !stat.isSymbolicLink()
    && stat.isFile()
    && stat.nlink === 1
    && (stat.mode & 0o777) === 0o600
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Rewrite a single bullet inside an existing daily file.
 *
 * Reads `<root>/<file>`, parses it, finds the line whose `bullet.id === id`,
 * applies `patch` onto that Bullet (object spread), serializes and writes back.
 *
 * Returns `true` if the bullet was found and the file was rewritten, `false` if
 * no bullet with `id` was found (file is not modified in that case).
 *
 * Non-bullet lines (prose, headings, blank lines) are preserved verbatim.
 */
export function rewriteBullet(
  root: string,
  file: string,
  id: string,
  patch: Partial<Pick<Bullet, "text" | "status" | "salience" | "isInsight" | "dueAt" | "refs">>,
): boolean {
  assertCanonicalDailySourcePath(file);
  const snapshot = readCanonicalFileSnapshot(root, file);
  if (snapshot === undefined) throw new Error(`memory-bujo: canonical rewrite source "${file}" is missing.`);
  const parsed = parseDailyFile(snapshot.content);

  let found = false;
  const newLines = parsed.lines.map((line) => {
    if (line.bullet === undefined || line.bullet.id !== id) return line;
    found = true;
    // Build the merged bullet by applying only the defined patch keys so that
    // exactOptionalPropertyTypes is satisfied (no undefined values injected).
    const merged: Bullet = { ...line.bullet, ...patch };
    return { raw: line.raw, lineNumber: line.lineNumber, bullet: merged };
  });

  if (!found) return false;

  const serialized = serializeDailyFile({ lines: newLines });
  if (serialized === snapshot.content) return true;
  withManagedRollbackRetirement(root, "daily", () => {
    writeCanonicalFileAtomic(root, file, serialized, snapshot.identity);
  });
  return true;
}

/** Read one exact canonical bullet without following links or accepting non-daily paths. */
export function readBullet(root: string, file: string, id: string): Bullet | undefined {
  assertCanonicalDailySourcePath(file);
  const snapshot = readCanonicalFileSnapshot(root, file);
  if (snapshot === undefined) throw new Error(`memory-bujo: canonical source "${file}" is missing.`);
  return parseDailyFile(snapshot.content).bullets.find((bullet) => bullet.id === id);
}

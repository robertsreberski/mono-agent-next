import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface MemoryMaintenanceLease {
  readonly transactionPath: string;
  release(): void;
}

const INCOMPLETE_LOCK_GRACE_MS = 1_000;

/** Stable sibling state survives a whole-root restore and blocks normal writers. */
export function memoryMaintenanceTransactionPath(root: string): string {
  const absolute = resolve(root);
  const parent = realpathSync(dirname(absolute));
  return join(parent, `.${basename(absolute)}.maintenance.json`);
}

export function assertNoMemoryMaintenanceTransaction(root: string): void {
  let path: string;
  try {
    path = memoryMaintenanceTransactionPath(root);
  } catch (error) {
    // No durable sibling marker can exist when the prospective root's parent
    // has not been created yet. The normal writer will create and validate the
    // full root chain after this check.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existsSync(path)) return;
  assertOwnerPrivateRegular(path, "memory maintenance transaction");
  throw new Error(
    "memory-maintenance: an explicit stopped-store transaction requires recovery; "
    + "keep the agent stopped and retry the operator command.",
  );
}

/** Serialize stopped-store operators independently of the root being replaced. */
export function acquireMemoryMaintenanceLease(root: string): MemoryMaintenanceLease {
  const absolute = resolve(root);
  const parent = dirname(absolute);
  const canonicalParent = realpathSync(parent);
  const lockPath = join(canonicalParent, `.${basename(absolute)}.maintenance.lock`);
  const transactionPath = join(canonicalParent, `.${basename(absolute)}.maintenance.json`);
  const token = randomUUID();
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    token,
    createdAt: new Date().toISOString(),
  })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    let createdIdentity: { readonly dev: number; readonly ino: number } | undefined;
    try {
      fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const created = fstatSync(fd);
      createdIdentity = { dev: created.dev, ino: created.ino };
      writeFileSync(fd, payload, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      fsyncDirectory(canonicalParent);
      const identity = safeIdentity(lockPath);
      if (identity === undefined || identity.dev !== createdIdentity.dev || identity.ino !== createdIdentity.ino) {
        throw new Error("memory-maintenance: maintenance lock changed during acquisition.");
      }
      let released = false;
      return {
        transactionPath,
        release: () => {
          if (released) return;
          released = true;
          const current = safeIdentity(lockPath);
          if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) return;
          const record = parseLock(readFileSync(lockPath, "utf8"));
          if (record.token !== token) return;
          unlinkSync(lockPath);
          fsyncDirectory(canonicalParent);
        },
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (createdIdentity !== undefined) {
        const current = safeIdentity(lockPath);
        if (current?.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
          unlinkSync(lockPath);
          fsyncDirectory(canonicalParent);
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || createdIdentity !== undefined) throw error;
      if (attempt === 0 && removeStaleLock(lockPath, canonicalParent)) continue;
      throw new Error("memory-maintenance: another stopped-store operator is active; retry later.");
    }
  }
  throw new Error("memory-maintenance: could not acquire the stopped-store lease.");
}

function removeStaleLock(path: string, parent: string): boolean {
  const identity = safeIdentity(path);
  if (identity === undefined) return false;
  let record: ReturnType<typeof parseLock>;
  try { record = parseLock(readFileSync(path, "utf8")); }
  catch {
    const info = lstatSync(path);
    if (Date.now() - info.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
    return removeOwnedLockIfUnchanged(path, parent, identity);
  }
  if (record.uid !== undefined && typeof process.getuid === "function" && record.uid !== process.getuid()) return false;
  const age = Date.now() - Date.parse(record.createdAt);
  if (age < -INCOMPLETE_LOCK_GRACE_MS) return false;
  // A complete lock owned by a live process is authoritative regardless of
  // age. Full-root backups and embedding rebuilds can legitimately outlive an
  // arbitrary wall-clock threshold; stealing their lease would admit a second
  // root-swap transaction. PID reuse is intentionally fail-closed as well.
  try { process.kill(record.pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  return removeOwnedLockIfUnchanged(path, parent, identity);
}

function removeOwnedLockIfUnchanged(
  path: string,
  parent: string,
  identity: { readonly dev: number; readonly ino: number },
): boolean {
  const current = safeIdentity(path);
  if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  unlinkSync(path);
  fsyncDirectory(parent);
  return true;
}

function assertOwnerPrivateRegular(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`memory-maintenance: ${label} is not an owner-private single-link file.`);
  }
}

function safeIdentity(path: string): { readonly dev: number; readonly ino: number } | undefined {
  try {
    assertOwnerPrivateRegular(path, "maintenance lock");
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function parseLock(raw: string): {
  readonly pid: number;
  readonly uid?: number;
  readonly token: string;
  readonly createdAt: string;
} {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.token !== "string" || value.token.length === 0
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(Date.parse(value.createdAt)).toISOString() !== value.createdAt
    || (value.uid !== undefined && !Number.isInteger(value.uid))) {
    throw new Error("memory-maintenance: malformed maintenance lock.");
  }
  return {
    pid: Number(value.pid),
    ...(value.uid === undefined ? {} : { uid: Number(value.uid) }),
    token: value.token,
    createdAt: value.createdAt,
  };
}

export function fsyncMaintenanceDirectory(path: string): void {
  fsyncDirectory(path);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

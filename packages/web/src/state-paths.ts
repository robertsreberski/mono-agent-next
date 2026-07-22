import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { WebConsoleError } from "./errors.js";

const STATE_MARKER = ".mono-agent-web-state";
const LEASE_DATABASE = "lease.sqlite";
const MARKER_SCHEMA = 1;

export interface WebStatePathOptions {
  /** Explicit test/embedding seam. Production callers should omit this fixed-root override. */
  readonly stateDir?: string;
  /** Accepted for API consistency; environment variables never redirect persistent state or reset targets. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface WebStatePaths {
  readonly root: string;
  readonly database: string;
  readonly uploads: string;
  readonly logs: string;
  readonly marker: string;
  readonly leaseDatabase: string;
  readonly notificationIngress: string;
}

export interface WebStateLease {
  release(): Promise<void>;
}

export function defaultWebStateDir(): string {
  return resolve(homedir(), ".mono-agent", "web");
}

export function resolveWebStatePaths(options: WebStatePathOptions = {}): WebStatePaths {
  // Deliberately do not consult MONO_AGENT_WEB_STATE_DIR: reset must never turn
  // an inherited environment variable into recursive-delete authority.
  const root = resolve(options.stateDir ?? defaultWebStateDir());
  return {
    root,
    database: resolve(root, "state.sqlite"),
    uploads: resolve(root, "uploads"),
    logs: resolve(root, "logs"),
    marker: resolve(root, STATE_MARKER),
    leaseDatabase: resolve(root, LEASE_DATABASE),
    notificationIngress: resolve(root, "notify-ingress.json"),
  };
}

export async function prepareWebStatePaths(options: WebStatePathOptions = {}): Promise<WebStatePaths> {
  const paths = resolveWebStatePaths(options);
  assertStructurallySafeTarget(paths.root);
  const existed = await pathExists(paths.root);
  if (existed) {
    await verifyDirectory(paths.root);
    await verifyMarker(paths);
  } else {
    const parent = dirname(paths.root);
    if (options.stateDir === undefined && parent === resolve(homedir(), ".mono-agent")) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
    } else {
      await verifyDirectory(parent);
    }
    await verifyCanonicalChain(parent);
    await mkdir(paths.root, { mode: 0o700 });
    await writeMarker(paths);
  }
  await verifyCanonicalChain(paths.root);
  await verifyOwnedDirectory(paths.root);
  await Promise.all([
    ensureOwnedChildDirectory(paths.uploads),
    ensureOwnedChildDirectory(paths.logs),
  ]);
  await prepareLeaseDatabase(paths);
  await chmod(paths.root, 0o700);
  return paths;
}

/** Initialize/verify the fixed web state root without acquiring the server lease. */
export async function prepareWebState(options: WebStatePathOptions = {}): Promise<void> {
  await prepareWebStatePaths(options);
}

export async function acquireWebStateLease(paths: WebStatePaths): Promise<WebStateLease> {
  await verifyMarker(paths);
  await verifyOwnedRegularFile(paths.leaseDatabase);
  const database = new DatabaseSync(paths.leaseDatabase, { timeout: 0 });
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch {
    database.close();
    throw new WebConsoleError("web_service_running", "The web service state is already in use.", 409);
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

export async function resetWebState(options: WebStatePathOptions = {}): Promise<void> {
  const paths = resolveWebStatePaths(options);
  assertStructurallySafeTarget(paths.root);
  await verifyCanonicalChain(paths.root);
  await verifyOwnedDirectory(paths.root);
  await verifyMarker(paths);
  const lease = await acquireWebStateLease(paths);
  try {
    // Preserve the root, ownership marker, worker.lock, and service lifecycle
    // artifacts. Reset only console-owned conversation/settings/upload data.
    await Promise.all([
      removeOwnedFile(paths.database),
      removeOwnedFile(`${paths.database}-wal`),
      removeOwnedFile(`${paths.database}-shm`),
      removeOwnedIngressFile(paths.notificationIngress),
    ]);
    await verifyDirectory(paths.uploads);
    await verifyCanonicalChain(paths.uploads);
    await verifyOwnedDirectory(paths.uploads);
    await rm(paths.uploads, { recursive: true, force: false });
    await mkdir(paths.uploads, { mode: 0o700 });
  } finally {
    await lease.release();
  }
}

async function removeOwnedIngressFile(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new WebConsoleError("invalid_state_root", `Refusing to remove invalid web ingress data: ${path}`, 409);
  }
  verifyOwner(info.uid, path);
  await unlink(path);
}

async function removeOwnedFile(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WebConsoleError("invalid_state_root", `Refusing to remove non-file web state data: ${path}`, 409);
  }
  verifyOwner(info.uid, path);
  await unlink(path);
}

async function writeMarker(paths: WebStatePaths): Promise<void> {
  const handle = await open(paths.marker, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schema: MARKER_SCHEMA, kind: "mono-agent-web-state" }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareLeaseDatabase(paths: WebStatePaths): Promise<void> {
  const existing = await lstat(paths.leaseDatabase).catch(() => undefined);
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new WebConsoleError("invalid_state_root", "Web lease database must be a regular file.", 409);
  }
  if (existing !== undefined) {
    verifyOwner(existing.uid, paths.leaseDatabase);
    await chmod(paths.leaseDatabase, 0o600);
    return;
  }
  const database = new DatabaseSync(paths.leaseDatabase, { timeout: 5_000 });
  try {
    database.exec("PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS lease_guard (id INTEGER PRIMARY KEY CHECK (id = 1));");
  } finally {
    database.close();
  }
  await chmod(paths.leaseDatabase, 0o600);
}

async function verifyOwnedRegularFile(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
    throw new WebConsoleError("invalid_state_root", `Expected an owner-private file at ${path}.`, 409);
  }
  verifyOwner(info.uid, path);
}

async function verifyMarker(paths: WebStatePaths): Promise<void> {
  const info = await lstat(paths.marker).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
    throw new WebConsoleError("invalid_state_root", `Web state marker is missing at ${paths.root}.`, 409);
  }
  verifyOwner(info.uid, paths.marker);
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(paths.marker, "utf8"));
  } catch {
    throw new WebConsoleError("invalid_state_root", `Web state marker is invalid at ${paths.root}.`, 409);
  }
  const record = typeof marker === "object" && marker !== null ? marker as Record<string, unknown> : undefined;
  if (record?.schema !== MARKER_SCHEMA || record.kind !== "mono-agent-web-state") {
    throw new WebConsoleError("invalid_state_root", `Web state marker is invalid at ${paths.root}.`, 409);
  }
}

async function ensureOwnedChildDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch(() => undefined);
  if (existing === undefined) await mkdir(path, { mode: 0o700 });
  else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new WebConsoleError("invalid_state_root", `Refusing non-directory web state path: ${path}`, 409);
  }
  await verifyOwnedDirectory(path);
  await chmod(path, 0o700);
}

async function verifyDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    throw new WebConsoleError("invalid_state_root", `Expected a real directory at ${path}.`, 409);
  }
}

async function verifyOwnedDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new WebConsoleError("invalid_state_root", `Expected a directory at ${path}.`, 409);
  verifyOwner(info.uid, path);
}

async function verifyCanonicalChain(path: string): Promise<void> {
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) {
    throw new WebConsoleError("invalid_state_root", `Web state path contains a symbolic-link hop: ${path}`, 409);
  }
}

function verifyOwner(uid: number, path: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && uid !== currentUid) {
    throw new WebConsoleError("invalid_state_owner", `Web state path is not owned by the current user: ${path}`, 409);
  }
}

function assertStructurallySafeTarget(target: string): void {
  const normalized = resolve(target);
  const home = resolve(homedir());
  if (!isAbsolute(normalized)
    || normalized === resolve("/")
    || normalized === home
    || dirname(normalized) === normalized
    || basename(normalized).length === 0) {
    throw new WebConsoleError("unsafe_reset_target", `Refusing unsafe web state path: ${normalized}`, 400);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

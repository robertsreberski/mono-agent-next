import { createHash, randomUUID } from "node:crypto";
import { type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  acquireOwnerPrivateLock,
  validateOwnerPrivateLockInputs,
} from "./owner-private-lock.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";

const LEASE_SCHEMA = "mono-agent.background-worker-lease.v2";
const DEFAULT_OWNERLESS_GRACE_MS = 5 * 60_000;
const MAX_ACQUIRE_ATTEMPTS = 4;

export interface BackgroundWorkerLease {
  readonly configPath: string;
  readonly path: string;
  readonly ownerPid: number;
  /** Idempotently release only this process's exact lease token. */
  release(): Promise<void>;
}

export interface BackgroundWorkerLeaseOptions {
  readonly homeDir?: string;
  readonly pid?: number;
  readonly now?: () => number;
  /** Test/embed seam for the owner record written by this acquisition. */
  readonly processIncarnation?: ProcessIncarnation;
  /** Test/embed seam; production checks boot session plus process birth. */
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly randomToken?: () => string;
  readonly ownerlessGraceMs?: number;
  /** Narrow deterministic seams for filesystem-race tests. */
  readonly hooks?: {
    readonly afterLeaseDirectoryCreated?: () => Promise<void>;
    readonly beforeStaleLeaseRename?: () => Promise<void>;
  };
}

/**
 * Stable owner-private lifetime-lease path for one exact resolved config.
 * The full path digest avoids relying on the shorter human-facing launchd hash.
 */
export function backgroundWorkerLeasePath(
  configPath: string,
  homeDir: string = effectiveUserHome(),
): string {
  const resolvedConfig = resolve(configPath);
  const digest = createHash("sha256").update(resolvedConfig).digest("hex");
  return join(resolve(homeDir), ".mono-agent", "worker-leases", `${digest}.lease`);
}

/**
 * Acquire the process-lifetime singleton for a config.
 *
 * `undefined` means either a live owner or a fresh ownerless directory (the
 * atomic mkdir -> owner.json initialization window) already holds the lease.
 * Dead owners and old ownerless crash debris are atomically quarantined before
 * one bounded retry. The returned lease must be held until worker shutdown.
 */
export async function acquireBackgroundWorkerLease(
  configPath: string,
  options: BackgroundWorkerLeaseOptions = {},
): Promise<BackgroundWorkerLease | undefined> {
  const resolvedConfig = await canonicalLeaseConfigPath(configPath);
  // The singleton location belongs to the effective OS account, not an
  // ambient HOME override. Tests and explicit embeddings retain a narrow
  // homeDir seam, while normal workers always converge on one lease root.
  const home = resolve(options.homeDir ?? effectiveUserHome());
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const randomToken = options.randomToken ?? randomUUID;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? DEFAULT_OWNERLESS_GRACE_MS;
  validateOwnerPrivateLockInputs("Background worker lease", pid, ownerlessGraceMs);

  const leasesRoot = await ensurePrivateLeaseRoot(home);
  const leasePath = backgroundWorkerLeasePath(resolvedConfig, home);
  const leaseId = basename(leasePath, ".lease");
  const held = await acquireOwnerPrivateLock({
    path: leasePath,
    label: "Background worker lease",
    schemaTag: LEASE_SCHEMA,
    ownerlessGraceMs,
    maxAcquireAttempts: MAX_ACQUIRE_ATTEMPTS,
    pid,
    now,
    randomToken,
    ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
    ...(options.isSameProcessIncarnation === undefined
      ? {}
      : { isSameProcessIncarnation: options.isSameProcessIncarnation }),
    ownerFields: () => ({ configPath: resolvedConfig }),
    validateOwnerFields: (record) => record.configPath === resolvedConfig,
    invalidOwner: "ownerless",
    livenessError: () => "assume-live",
    ...(options.hooks?.afterLeaseDirectoryCreated === undefined
      ? {}
      : { afterDirectoryCreated: options.hooks.afterLeaseDirectoryCreated }),
    ...(options.hooks?.beforeStaleLeaseRename === undefined
      ? {}
      : { beforeStaleRename: options.hooks.beforeStaleLeaseRename }),
    staleRace: "return",
    stalePath: ({ now: staleAt, pid: stalePid, token }) =>
      join(leasesRoot, `.${leaseId}-${staleAt}-${stalePid}-${token}.stale`),
    releasedPath: ({ pid: ownerPid, token }) =>
      join(leasesRoot, `.${leaseId}-${ownerPid}-${token}.released`),
    abandonedPath: ({ pid: ownerPid, token }) =>
      join(leasesRoot, `.${leaseId}-${ownerPid}-${token}.abandoned`),
  });
  if (held === undefined) return undefined;
  return {
    configPath: resolvedConfig,
    path: held.path,
    ownerPid: held.ownerPid,
    release: () => held.release(),
  };
}

async function canonicalLeaseConfigPath(configPath: string): Promise<string> {
  const lexical = resolve(configPath);
  try {
    const candidate = join(await realpath(dirname(lexical)), basename(lexical));
    try {
      const details = await lstat(candidate);
      return details.isSymbolicLink() ? candidate : await realpath(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return candidate;
      throw error;
    }
  } catch (error) {
    // The lease helper is also useful for fail-closed diagnostics/tests before
    // a config exists. Normal foreground startup has already required the
    // config and therefore always takes the canonical-parent branch.
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return lexical;
    throw error;
  }
}

function effectiveUserHome(): string {
  const home = userInfo().homedir;
  if (home.length === 0) {
    throw new Error("Cannot determine the effective OS user's home for the background worker lease.");
  }
  return home;
}

async function ensurePrivateLeaseRoot(home: string): Promise<string> {
  const homeDetails = await lstat(home);
  if (!homeDetails.isDirectory() || homeDetails.isSymbolicLink()) {
    throw new Error(`Background worker lease home ${home} must be a real directory.`);
  }
  assertOwned(homeDetails, home, "Background worker lease home");

  const managedRoot = join(home, ".mono-agent");
  const leasesRoot = join(managedRoot, "worker-leases");
  for (const path of [managedRoot, leasesRoot]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Background worker lease parent ${path} must be a real directory.`);
    }
    assertOwned(before, path, "Background worker lease parent");
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if (secured.dev !== before.dev || secured.ino !== before.ino) {
      throw new Error(`Background worker lease parent ${path} changed while it was secured.`);
    }
    assertPrivateDirectoryDetails(secured, path, "Background worker lease parent");
  }
  return leasesRoot;
}

function assertPrivateDirectoryDetails(
  details: Stats,
  path: string,
  label: string,
): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} ${path} must be a real directory.`);
  }
  assertOwned(details, path, label);
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`${label} ${path} must be owner-only (mode 0700).`);
  }
}

function assertOwned(
  details: { readonly uid: number },
  path: string,
  label: string,
): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} ${path} is not owned by the current user.`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

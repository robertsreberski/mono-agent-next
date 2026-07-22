import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { acquireOwnerPrivateLock } from "./owner-private-lock.js";
import type { OwnerPrivateLock } from "./owner-private-lock.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";

const BARRIER_SCHEMA = "mono-agent.managed-runtime-publication-barrier.v1";
const OWNERLESS_GRACE_MS = 5_000;
const WAIT_SLICE_MS = 2_000;
const POLL_INTERVAL_MS = 100;

export interface ManagedRuntimePublicationBarrierOptions {
  readonly label: string;
  /** Canonical ~/.mono-agent root that already owns the lifecycle locks tree. */
  readonly managedRoot: string;
  readonly pid?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly processIncarnation?: ProcessIncarnation;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
}

export function managedRuntimePublicationBarrierPath(
  label: string,
  managedRoot: string,
): string {
  assertLabel(label);
  return join(resolve(managedRoot), "locks", `${label}.runtime-install.lock`);
}

/** Controller-held barrier spanning closure installation through plist commit. */
export async function acquireManagedRuntimePublicationBarrier(
  options: ManagedRuntimePublicationBarrierOptions,
): Promise<OwnerPrivateLock | undefined> {
  return await acquireBarrier(options, { waitTimeoutMs: 0, maxAcquireAttempts: 4 });
}

/**
 * Managed workers call this before taking their lifetime lease. A live
 * controller is allowed to install for an unbounded amount of time; each wait
 * slice remains bounded so stale PID/incarnation ownership is re-evaluated.
 */
export async function waitForManagedRuntimePublication(
  options: ManagedRuntimePublicationBarrierOptions,
): Promise<void> {
  await assertBarrierParents(options.managedRoot);
  const path = managedRuntimePublicationBarrierPath(options.label, options.managedRoot);
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }

  for (;;) {
    const held = await acquireBarrier(options, { waitTimeoutMs: WAIT_SLICE_MS });
    if (held === undefined) continue;
    await held.release();
    return;
  }
}

async function acquireBarrier(
  options: ManagedRuntimePublicationBarrierOptions,
  acquisition: { readonly waitTimeoutMs: number; readonly maxAcquireAttempts?: number },
): Promise<OwnerPrivateLock | undefined> {
  await assertBarrierParents(options.managedRoot);
  const path = managedRuntimePublicationBarrierPath(options.label, options.managedRoot);
  const locksRoot = join(resolve(options.managedRoot), "locks");
  return await acquireOwnerPrivateLock({
    path,
    label: "Managed runtime publication barrier",
    schemaTag: BARRIER_SCHEMA,
    ownerlessGraceMs: OWNERLESS_GRACE_MS,
    waitTimeoutMs: acquisition.waitTimeoutMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    ...(acquisition.maxAcquireAttempts === undefined ? {} : { maxAcquireAttempts: acquisition.maxAcquireAttempts }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
    ...(options.isSameProcessIncarnation === undefined
      ? {}
      : { isSameProcessIncarnation: options.isSameProcessIncarnation }),
    ownerFields: () => ({ label: options.label }),
    validateOwnerFields: (record) => record.label === options.label,
    livenessError: () => "assume-live",
    staleRace: "retry",
    stalePath: ({ now, pid, token }) => join(locksRoot, `.${options.label}.runtime-install-${now}-${pid}-${token}.stale`),
    releasedPath: ({ pid, token }) => join(locksRoot, `.${options.label}.runtime-install-${pid}-${token}.released`),
    abandonedPath: ({ pid, token }) => join(locksRoot, `.${options.label}.runtime-install-${pid}-${token}.abandoned`),
  });
}

async function assertBarrierParents(managedRoot: string): Promise<void> {
  for (const path of [resolve(managedRoot), join(resolve(managedRoot), "locks")]) {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Managed runtime publication parent ${path} must be a real directory.`);
    }
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw new Error(`Managed runtime publication parent ${path} is not owned by the current user.`);
    }
    if ((details.mode & 0o077) !== 0) {
      throw new Error(`Managed runtime publication parent ${path} must be owner-only (mode 0700).`);
    }
  }
}

function assertLabel(label: string): void {
  if (!/^[0-9A-Za-z.-]+$/u.test(label) || label.length === 0 || label.length > 255) {
    throw new Error("Managed runtime publication barrier label is invalid.");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import process from "node:process";

import {
  LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS,
  LAUNCHD_LOG_MAX_BYTES,
  LAUNCHD_LOG_ROTATION_COUNT,
} from "./launchd-logs.js";

interface ManagedWebLogPaths {
  readonly launchd: {
    readonly stdoutPath: string;
    readonly stderrPath: string;
  };
}

export async function waitForManagedWebLogRollover(
  paths: ManagedWebLogPaths,
  signal: AbortSignal,
): Promise<"rollover" | "unsafe" | "cancelled"> {
  if (signal.aborted) return "cancelled";
  return await new Promise((resolvePromise) => {
    let checking = false;
    let settled = false;
    const finish = (outcome: "rollover" | "unsafe" | "cancelled"): void => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      signal.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    };
    const onAbort = (): void => finish("cancelled");
    const inspect = async (): Promise<void> => {
      if (checking || settled) return;
      checking = true;
      try {
        const sizes = await Promise.all([
          managedLogSize(paths.launchd.stdoutPath),
          managedLogSize(paths.launchd.stderrPath),
        ]);
        if (sizes.some((size) => size > LAUNCHD_LOG_MAX_BYTES)) finish("rollover");
      } catch {
        finish("unsafe");
      } finally {
        checking = false;
      }
    };
    const interval = setInterval(
      () => void inspect(),
      LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS * 1_000,
    );
    interval.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    void inspect();
  });
}

/**
 * Roll a managed web worker's active launchd logs after its HTTP service has
 * stopped. The current process still owns stdout/stderr, so each active file is
 * moved to a retiring name, a bounded tail is published as generation 1, and
 * the retiring inode is unlinked before launchd starts the replacement worker.
 */
export async function rolloverManagedWebLogs(paths: ManagedWebLogPaths): Promise<void> {
  await rolloverManagedWebLogStream(paths.launchd.stdoutPath);
  await rolloverManagedWebLogStream(paths.launchd.stderrPath);
}

async function rolloverManagedWebLogStream(activePath: string): Promise<void> {
  const active = await ownedManagedLogStats(activePath);
  if (active === undefined || active.size <= LAUNCHD_LOG_MAX_BYTES) return;
  const generations = Array.from(
    { length: LAUNCHD_LOG_ROTATION_COUNT },
    (_unused, index) => `${activePath}.${String(index + 1)}`,
  );
  await Promise.all(generations.map(async (path) => await ownedManagedLogStats(path)));

  const source = await open(activePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let temporaryPath: string | undefined;
  let retiringPath: string | undefined;
  try {
    const sourceStats = await source.stat();
    assertOwnedManagedLog(sourceStats, activePath);
    if (!sameManagedLogIdentity(active, sourceStats)) {
      throw new Error(`Managed web log ${activePath} changed before rollover.`);
    }
    const retainedBytes = Math.min(sourceStats.size, LAUNCHD_LOG_MAX_BYTES);
    const tail = Buffer.alloc(retainedBytes);
    const read = await source.read(tail, 0, retainedBytes, sourceStats.size - retainedBytes);
    if (read.bytesRead !== retainedBytes) {
      throw new Error(`Managed web log ${activePath} changed while its bounded tail was read.`);
    }
    const afterRead = await source.stat();
    if (!sameManagedLogIdentity(sourceStats, afterRead) || sourceStats.size !== afterRead.size) {
      throw new Error(`Managed web log ${activePath} changed while its bounded tail was prepared.`);
    }

    temporaryPath = `${activePath}.rollover-${randomUUID()}`;
    const temporary = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await temporary.writeFile(tail);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    const oldest = generations.at(-1);
    if (oldest !== undefined && await ownedManagedLogStats(oldest) !== undefined) {
      await rm(oldest);
    }
    for (let index = generations.length - 1; index > 0; index -= 1) {
      const from = generations[index - 1];
      const to = generations[index];
      if (from !== undefined && to !== undefined && await ownedManagedLogStats(from) !== undefined) {
        await rename(from, to);
      }
    }

    retiringPath = `${activePath}.retiring-${randomUUID()}`;
    await rename(activePath, retiringPath);
    try {
      await rename(temporaryPath, generations[0] as string);
      temporaryPath = undefined;
    } catch (error) {
      await rename(retiringPath, activePath).catch(() => undefined);
      retiringPath = undefined;
      throw error;
    }
    await rm(retiringPath);
    retiringPath = undefined;
  } finally {
    await source.close().catch(() => undefined);
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (retiringPath !== undefined) await rm(retiringPath, { force: true }).catch(() => undefined);
  }
}

async function managedLogSize(path: string): Promise<number> {
  return Number((await ownedManagedLogStats(path))?.size ?? 0);
}

async function ownedManagedLogStats(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const stats = await lstat(path);
    assertOwnedManagedLog(stats, path);
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwnedManagedLog(stats: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`Managed web log ${path} must be one regular, non-symbolic-link file.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Managed web log ${path} is not owned by the current user.`);
  }
}

function sameManagedLogIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

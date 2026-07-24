import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
export interface ServiceInputSnapshot {
  readonly source: Buffer;
  readonly digest: string;
  readonly identity: string;
}
export async function readServiceInput(
  path: string,
  maximumBytes: number,
  options: { readonly uid?: number; readonly mode?: number } = {},
): Promise<ServiceInputSnapshot> {
  const before = await lstat(path, { bigint: true });
  assertSafe(path, before, maximumBytes, options);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafe(path, opened, maximumBytes, options);
    assertSame(path, before, opened);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSafe(path, after, maximumBytes, options);
    assertSame(path, opened, after);
    const current = await lstat(path, { bigint: true });
    assertSame(path, after, current);
    if (after.size !== BigInt(source.byteLength)) throw new Error(`${path} changed size while it was read.`);
    const digest = createHash("sha256").update(source).digest("hex");
    const identity = [after.dev, after.ino, after.ctimeNs, after.uid, after.mode, after.nlink, after.size, digest].join(":");
    return Object.freeze({ source, digest, identity });
  } finally {
    await handle.close();
  }
}
function assertSafe(path: string, stats: BigIntStats, maximumBytes: number, options: { readonly uid?: number; readonly mode?: number }): void {
  const mode = stats.mode & 0o777n;
  if (
    !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size > BigInt(maximumBytes)
    || (mode & 0o022n) !== 0n || (options.uid !== undefined && stats.uid !== BigInt(options.uid))
    || (options.mode !== undefined && mode !== BigInt(options.mode))
  ) throw new Error(`${path} must be a protected single-linked regular file no larger than ${String(maximumBytes)} bytes.`);
}
function assertSame(path: string, left: BigIntStats, right: BigIntStats): void {
  if (
    left.dev !== right.dev || left.ino !== right.ino || left.ctimeNs !== right.ctimeNs
    || left.mtimeNs !== right.mtimeNs || left.uid !== right.uid || left.mode !== right.mode
    || left.nlink !== right.nlink || left.size !== right.size
  ) throw new Error(`${path} changed identity or metadata while it was read.`);
}

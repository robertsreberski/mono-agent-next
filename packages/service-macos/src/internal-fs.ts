import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === code;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

export function assertUnchangedServiceInput(
  path: string,
  left: BigIntStats,
  right: BigIntStats,
): void {
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.ctimeNs !== right.ctimeNs
    || left.mtimeNs !== right.mtimeNs
    || left.uid !== right.uid
    || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.size !== right.size
  ) {
    throw new Error(`${path} changed identity or metadata while it was read.`);
  }
}

export function sameManagedFileObject(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

export function assertUnchangedManagedFile(
  path: string,
  left: BigIntStats,
  right: BigIntStats,
): void {
  if (
    !sameManagedFileObject(left, right)
    || left.ctimeNs !== right.ctimeNs
    || left.mtimeNs !== right.mtimeNs
    || left.size !== right.size
  ) {
    throw new Error(`${path} changed during operation.`);
  }
}

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export const MAX_PI_AUTH_STORE_BYTES = 1_048_576;

export type PiAuthStoreUnsafeReason =
  | "owner-check-unavailable"
  | "symbolic-link"
  | "not-regular-file"
  | "multiple-hard-links"
  | "oversized"
  | "foreign-owner"
  | "not-owner-only"
  | "changed-during-read"
  | "malformed-json"
  | "unreadable";

export type PiAuthStoreInspection =
  | { readonly status: "ok"; readonly auth: Readonly<Record<string, unknown>> }
  | { readonly status: "missing" }
  | { readonly status: "unsafe"; readonly reason: PiAuthStoreUnsafeReason };

/**
 * Inspect an existing Pi credential store without following aliases or reading
 * unbounded input. Credential discovery is deliberately stricter than the
 * explicit, locked repair flow: discovery accepts only a current-user,
 * owner-only, single-link regular file. The repair flow may read a
 * current-user, non-writable 0644 file under its exclusive lock solely so it
 * can atomically replace that file with a hardened 0600 store.
 */
export async function inspectPiAuthStore(path: string): Promise<PiAuthStoreInspection> {
  if (typeof process.getuid !== "function") {
    return { status: "unsafe", reason: "owner-check-unavailable" };
  }

  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { status: "missing" };
      if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK")) {
        return { status: "unsafe", reason: "symbolic-link" };
      }
      return { status: "unsafe", reason: "unreadable" };
    }

    const before = await handle.stat();
    const unsafeBefore = unsafeStatReason(before, process.getuid());
    if (unsafeBefore !== undefined) return { status: "unsafe", reason: unsafeBefore };

    const contents = await readBounded(handle, MAX_PI_AUTH_STORE_BYTES);
    if (contents === undefined) return { status: "unsafe", reason: "oversized" };

    const after = await handle.stat();
    const unsafeAfter = unsafeStatReason(after, process.getuid());
    if (unsafeAfter !== undefined) return { status: "unsafe", reason: unsafeAfter };
    if (!sameOpenedFileSnapshot(before, after) || contents.byteLength !== after.size) {
      return { status: "unsafe", reason: "changed-during-read" };
    }

    let pathStat: Stats;
    try {
      pathStat = await lstat(path);
    } catch {
      return { status: "unsafe", reason: "changed-during-read" };
    }
    const unsafePath = unsafeStatReason(pathStat, process.getuid());
    if (unsafePath !== undefined) return { status: "unsafe", reason: unsafePath };
    if (pathStat.dev !== after.dev || pathStat.ino !== after.ino) {
      return { status: "unsafe", reason: "changed-during-read" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      return { status: "unsafe", reason: "malformed-json" };
    }
    if (!isRecord(parsed)) return { status: "unsafe", reason: "malformed-json" };
    return { status: "ok", auth: parsed };
  } catch {
    return { status: "unsafe", reason: "unreadable" };
  } finally {
    try {
      await handle?.close();
    } catch {
      // Inspection is read-only and already fails closed; a close failure must
      // not turn an unsafe credential store into an uncaught validation error.
    }
  }
}

function unsafeStatReason(value: Stats, ownerUid: number): PiAuthStoreUnsafeReason | undefined {
  if (!value.isFile()) return "not-regular-file";
  if (value.nlink !== 1) return "multiple-hard-links";
  if (value.size > MAX_PI_AUTH_STORE_BYTES) return "oversized";
  if (value.uid !== ownerUid) return "foreign-owner";
  if ((value.mode & 0o077) !== 0) return "not-owner-only";
  return undefined;
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer | undefined> {
  const output = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < output.byteLength) {
    const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, null);
    if (bytesRead === 0) return output.subarray(0, offset);
    offset += bytesRead;
  }
  return undefined;
}

function sameOpenedFileSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// SPDX-License-Identifier: MIT
import {
  constants,
  fstatSync,
  ftruncateSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertUnchangedManagedFile,
  digest,
  isErrno,
  sameManagedFileObject,
} from "./internal-fs.js";
import type { ServiceRunnerActivation } from "./plist.js";
type ActivationLogs = ServiceRunnerActivation["logs"];
type ReadinessRecord = { readonly event: "reset" } | {
  readonly event: "started" | "stopped"; readonly serviceMacosProof: string; readonly pid: number;
};
interface ServiceLogRotationTestHooks {
  readonly afterArchiveWrite?: (path: string) => void | Promise<void>;
}
export interface ServiceLogBinding { readonly stdout: string; readonly stderr: string }
export interface ManagedServiceLogSnapshot {
  readonly exists: boolean;
  readonly totalBytes: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  readonly digest?: string;
  readonly content: string;
}
const READINESS_MAX_BYTES = 4_096;
export async function bindServiceLogs(logs: ActivationLogs, uid: number): Promise<ServiceLogBinding> {
  await assertDirectory(logs, uid);
  await assertServiceLogRetention(logs, uid);
  return Object.freeze({
    stdout: await bindFile(logs, logs.stdoutPath, uid),
    stderr: await bindFile(logs, logs.stderrPath, uid),
  });
}
export async function assertServiceLogRetention(logs: ActivationLogs, uid: number): Promise<void> {
  for (const path of [logs.stdoutPath, logs.stderrPath]) {
    for (let index = logs.retainFiles; index < 100; index += 1) {
      const archive = `${path}.${String(index)}.mono-agent-log`;
      try {
        const stats = await lstat(archive, { bigint: true });
        assertSafe(archive, stats, uid);
        await assertDirectory(logs, uid);
        throw new Error(`Log retention decrease requires explicit removal of managed archive ${archive}.`);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }
}

export async function preflightServiceLogs(
  logs: ActivationLogs,
  uid: number,
): Promise<void> {
  await assertDirectory(logs, uid);
  await assertServiceLogRetention(logs, uid);
  for (const path of [logs.stdoutPath, logs.stderrPath]) {
    await inspectOptionalManagedFile(path, logs, uid);
    for (let index = 0; index < logs.retainFiles; index += 1) {
      await inspectOptionalManagedFile(
        `${path}.${String(index)}.mono-agent-log`,
        logs,
        uid,
      );
    }
  }
  const readiness = await readOptionalManagedFile(
    logs.readinessPath,
    logs,
    uid,
    READINESS_MAX_BYTES,
  );
  if (readiness !== undefined && parseReadiness(readiness) === undefined) {
    throw new Error(`${logs.readinessPath} is not a valid managed readiness proof.`);
  }
  await assertDirectory(logs, uid);
}

export async function resetServiceLogs(logs: ActivationLogs, uid: number): Promise<void> {
  await Promise.all([rotate(logs.stdoutPath, logs, uid, true), rotate(logs.stderrPath, logs, uid, true)]);
  await rewriteReadiness(logs, { event: "reset" }, uid, false);
}

async function inspectOptionalManagedFile(
  path: string,
  logs: ActivationLogs,
  uid: number,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (handle === undefined) return;
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafe(path, opened, uid);
    await assertBound(logs, path, opened, uid);
    const after = await handle.stat({ bigint: true });
    assertUnchangedManagedFile(path, opened, after);
    await assertBound(logs, path, after, uid);
  } finally {
    await handle.close();
  }
}

async function readOptionalManagedFile(
  path: string,
  logs: ActivationLogs,
  uid: number,
  maximum: number,
): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (handle === undefined) return undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafe(path, opened, uid, maximum);
    await assertBound(logs, path, opened, uid);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertUnchangedManagedFile(path, opened, after);
    await assertBound(logs, path, after, uid);
    if (source.byteLength !== Number(after.size)) {
      throw new Error(`${path} changed size during preflight.`);
    }
    return source;
  } finally {
    await handle.close();
  }
}
export async function maintainServiceLogs(
  logs: ActivationLogs, uid: number, binding?: ServiceLogBinding,
): Promise<void> {
  await maintainServiceLogsInternal(logs, uid, binding, {});
}
/** @internal Test-only adversarial hook surface; not exported by the package entrypoint. */
export async function maintainServiceLogsForTesting(
  logs: ActivationLogs,
  uid: number,
  hooks: ServiceLogRotationTestHooks,
  binding?: ServiceLogBinding,
): Promise<void> {
  await maintainServiceLogsInternal(logs, uid, binding, hooks);
}
async function maintainServiceLogsInternal(
  logs: ActivationLogs,
  uid: number,
  binding: ServiceLogBinding | undefined,
  hooks: ServiceLogRotationTestHooks,
): Promise<void> {
  await Promise.all([
    rotate(logs.stdoutPath, logs, uid, false, binding?.stdout, hooks),
    rotate(logs.stderrPath, logs, uid, false, binding?.stderr, hooks),
  ]);
}
export async function readManagedServiceLog(
  path: string,
  uid: number,
  maxBytes: number,
): Promise<ManagedServiceLogSnapshot> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return Object.freeze({
        exists: false,
        totalBytes: 0,
        returnedBytes: 0,
        truncated: false,
        content: "",
      });
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertSafe(path, before, uid);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${path} is too large for bounded log inspection.`);
    }
    const returnedBytes = Math.min(Number(before.size), maxBytes);
    const source = Buffer.alloc(returnedBytes);
    if (returnedBytes > 0) {
      await readExact(
        handle,
        source,
        Number(before.size) - returnedBytes,
        path,
      );
    }
    const after = await handle.stat({ bigint: true });
    assertUnchangedManagedFile(path, before, after);
    if (!sameManagedFileObject(after, await lstat(path, { bigint: true }))) {
      throw new Error(`${path} changed pathname identity during log inspection.`);
    }
    return Object.freeze({
      exists: true,
      totalBytes: Number(before.size),
      returnedBytes,
      truncated: before.size > BigInt(returnedBytes),
      digest: digest(source),
      content: source.toString("utf8"),
    });
  } finally {
    await handle.close();
  }
}
export async function readServiceReadiness(
  logs: ActivationLogs, token: string, pid: number, uid: number,
): Promise<boolean> {
  await assertDirectory(logs, uid);
  let handle;
  try {
    handle = await open(
      logs.readinessPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertSafe(logs.readinessPath, before, uid, READINESS_MAX_BYTES);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertUnchangedManagedFile(logs.readinessPath, before, after);
    await assertBound(logs, logs.readinessPath, after, uid);
    const record = parseReadiness(source);
    return record?.event === "started" && record.serviceMacosProof === token && record.pid === pid;
  } finally { await handle.close(); }
}
export async function writeServiceReadiness(
  logs: ActivationLogs, token: string, pid: number, uid: number,
): Promise<void> {
  await rewriteReadiness(logs, { event: "started", serviceMacosProof: token, pid }, uid, true);
}
export async function withdrawServiceReadiness(
  logs: ActivationLogs, token: string, pid: number, uid: number,
): Promise<void> {
  await rewriteReadiness(logs, { event: "stopped", serviceMacosProof: token, pid }, uid, false);
}
async function rewriteReadiness(
  logs: ActivationLogs, next: ReadinessRecord, uid: number, create: boolean,
): Promise<void> {
  await assertDirectory(logs, uid);
  let handle; let created = false;
  try {
    handle = await open(
      logs.readinessPath,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    if (!create) return;
    handle = await open(
      logs.readinessPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    created = true;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertSafe(logs.readinessPath, before, uid, READINESS_MAX_BYTES);
    const source = Buffer.alloc(Number(before.size));
    await handle.read(source, 0, source.length, 0);
    await assertBound(logs, logs.readinessPath, before, uid);
    const current = source.length === 0 && created ? undefined : parseReadiness(source);
    if ((!created && current === undefined)
      || (next.event === "started" && current !== undefined && current.event !== "reset"
        && current.serviceMacosProof !== next.serviceMacosProof)
      || (next.event === "stopped" && (current?.event !== "started"
        || current.serviceMacosProof !== next.serviceMacosProof || current.pid !== next.pid))) {
      throw new Error(`${logs.readinessPath} is not the expected managed readiness proof.`);
    }
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    assertSafe(logs.readinessPath, after, uid, READINESS_MAX_BYTES);
    await assertBound(logs, logs.readinessPath, after, uid);
  } finally { await handle.close(); }
}
async function rotate(
  path: string,
  logs: ActivationLogs,
  uid: number,
  force: boolean,
  expected?: string,
  hooks: ServiceLogRotationTestHooks = {},
): Promise<void> {
  await assertDirectory(logs, uid);
  let handle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ENOENT") && expected === undefined) return;
    if (isErrno(error, "ENOENT")) throw new Error(`${path} bound live log disappeared.`);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertSafe(path, before, uid);
    if (expected !== undefined && fileIdentity(before) !== expected) throw new Error(`${path} is not the bound live log.`);
    await assertBound(logs, path, before, uid);
    if (before.size === 0n || (!force && before.size <= BigInt(logs.maxBytes))) return;
    const bytes = Number(before.size > BigInt(logs.maxBytes) ? BigInt(logs.maxBytes) : before.size);
    const archive = Buffer.alloc(bytes);
    await readExact(handle, archive, Number(before.size) - bytes, path);
    const after = await handle.stat({ bigint: true });
    assertUnchangedManagedFile(path, before, after);
    await assertBound(logs, path, after, uid);
    await writeArchive(path, archive, logs, uid);
    await hooks.afterArchiveWrite?.(path);
    await assertBound(logs, path, after, uid);
    // The managed target shares this Node event loop. Keep the final descriptor
    // stability check and truncate synchronous so its writes cannot interleave.
    const preTruncate = fstatSync(handle.fd, { bigint: true });
    assertUnchangedManagedFile(path, after, preTruncate);
    ftruncateSync(handle.fd, 0);
    await handle.sync();
    const final = await handle.stat({ bigint: true });
    if (!sameManagedFileObject(after, final)) {
      throw new Error(`${path} changed during log rotation.`);
    }
    await assertBound(logs, path, final, uid);
  } finally { await handle.close(); }
}
async function writeArchive(path: string, bytes: Buffer, logs: ActivationLogs, uid: number): Promise<void> {
  await assertDirectory(logs, uid);
  let selected: { path: string; stats?: BigIntStats } | undefined;
  for (let index = 0; index < logs.retainFiles; index += 1) {
    const candidate = `${path}.${String(index)}.mono-agent-log`;
    try {
      const stats = await lstat(candidate, { bigint: true });
      assertSafe(candidate, stats, uid);
      if (selected === undefined || (selected.stats?.mtimeNs ?? 0n) > stats.mtimeNs) selected = { path: candidate, stats };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      selected = { path: candidate };
      break;
    }
  }
  if (selected === undefined) throw new Error("No managed log archive slot is available.");
  await assertDirectory(logs, uid);
  const flags = selected.stats === undefined
    ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
      | constants.O_NOFOLLOW | constants.O_NONBLOCK
    : constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(selected.path, flags, 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafe(selected.path, opened, uid);
    if (
      selected.stats !== undefined
      && !sameManagedFileObject(selected.stats, opened)
    ) {
      throw new Error(`${selected.path} changed before archive rotation.`);
    }
    await assertBound(logs, selected.path, opened, uid);
    await handle.truncate(0);
    await writeExact(handle, bytes, selected.path);
    await handle.sync();
    await assertBound(logs, selected.path, await handle.stat({ bigint: true }), uid);
  } finally { await handle.close(); }
}
async function readExact(
  handle: FileHandle,
  target: Buffer,
  position: number,
  path: string,
): Promise<void> {
  let offset = 0;
  while (offset < target.byteLength) {
    const { bytesRead } = await handle.read(
      target,
      offset,
      target.byteLength - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error(`${path} changed during log rotation.`);
    offset += bytesRead;
  }
}
async function writeExact(
  handle: FileHandle,
  source: Buffer,
  path: string,
): Promise<void> {
  let offset = 0;
  while (offset < source.byteLength) {
    const { bytesWritten } = await handle.write(
      source,
      offset,
      source.byteLength - offset,
      offset,
    );
    if (bytesWritten === 0) throw new Error(`${path} archive write was incomplete.`);
    offset += bytesWritten;
  }
}
async function bindFile(logs: ActivationLogs, path: string, uid: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat({ bigint: true });
    assertSafe(path, stats, uid);
    await assertBound(logs, path, stats, uid);
    return fileIdentity(stats);
  } finally { await handle.close(); }
}
async function assertDirectory(logs: ActivationLogs, uid: number): Promise<void> {
  if ([logs.stdoutPath, logs.stderrPath, logs.readinessPath].some((path) => dirname(path) !== logs.directory)) {
    throw new Error("Managed log paths must be direct children of the bound log directory.");
  }
  const stats = await lstat(logs.directory, { bigint: true });
  const identity = [stats.dev, stats.ino, stats.uid, stats.mode & 0o777n].join(":");
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== BigInt(uid)
    || (stats.mode & 0o022n) !== 0n || identity !== logs.directoryIdentity) {
    throw new Error(`${logs.directory} is not the planned protected log directory.`);
  }
}
async function assertBound(logs: ActivationLogs, path: string, stats: BigIntStats, uid: number): Promise<void> {
  await assertDirectory(logs, uid);
  if (!sameManagedFileObject(stats, await lstat(path, { bigint: true }))) {
    throw new Error(`${path} changed pathname identity.`);
  }
}
function parseReadiness(source: Uint8Array): ReadinessRecord | undefined {
  try {
    const value = JSON.parse(Buffer.from(source).toString("utf8")) as Record<string, unknown>;
    if (value.event === "reset" && Object.keys(value).length === 1) return { event: "reset" };
    if ((value.event !== "started" && value.event !== "stopped") || Object.keys(value).length !== 3
      || typeof value.serviceMacosProof !== "string" || !/^[a-f0-9]{64}$/u.test(value.serviceMacosProof)
      || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    return value as ReadinessRecord;
  } catch { return undefined; }
}
function assertSafe(path: string, stats: BigIntStats, uid: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== BigInt(uid)
    || (stats.mode & 0o777n) !== 0o600n || stats.nlink !== 1n || stats.size > BigInt(maximum)) {
    throw new Error(`${path} must be an owner-private single-linked managed file.`);
  }
}
function fileIdentity(stats: BigIntStats): string { return [stats.dev, stats.ino, stats.uid, stats.mode].join(":"); }

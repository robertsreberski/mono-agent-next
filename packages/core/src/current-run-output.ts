// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ChannelAttachment, NormalizedAttachment } from "@mono-agent/module-sdk";
import { readAuthorityFile } from "./authority-read.js";
export const CURRENT_RUN_OUTPUT_MAX_BYTES = 25_000_000;
export const CURRENT_RUN_ROOT_MAX_ENTRIES = 4_096;
export const CURRENT_RUN_RECOVERY_MAX_ENTRIES = 65_536;
export const CURRENT_RUN_RECOVERY_MAX_DEPTH = 8;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export type CurrentRunRoot = {
  readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly type: "directory";
};
type Identity = CurrentRunRoot | {
  readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly type: "file";
};
type StagedAttachment = {
  readonly id: string; readonly name: string; readonly mediaType: string;
  readonly path: string; readonly dev: string; readonly ino: string;
};
export interface McpRequestContextV1 {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly runId: string;
  readonly runOutputDir: string;
  readonly attachmentsRoot: string;
  readonly allowedAttachmentPaths: readonly string[];
  readonly allowedAttachmentIdentities: readonly {
    readonly path: string;
    readonly dev: string;
    readonly ino: string;
  }[];
  readonly attachments: readonly StagedAttachment[];
}
type CurrentRunHook = (phase: "directory" | "write" | "sync" | "stat" | "path" | "cleanup",
  path: string) => void | Promise<void>;
export interface CreateCurrentRunFilesOptions {
  readonly root: CurrentRunRoot; readonly runId: string; readonly conversationId: string;
  readonly attachments: readonly NormalizedAttachment[]; readonly signal: AbortSignal;
  /** Security-test seam. */
  readonly testHook?: CurrentRunHook;
}
export interface CurrentRunFiles {
  readonly runOutputDir: string;
  readonly requestContext: McpRequestContextV1;
  readOutput(name: string, options: ReadCurrentRunOutputOptions): Promise<ChannelAttachment>;
  cleanup(): Promise<void>;
}
export interface ReadCurrentRunOutputOptions {
  readonly maxBytes: number; readonly signal: AbortSignal;
  readonly beforePathIdentityCheck?: () => void | Promise<void>;
}
export interface RecoverCurrentRunRootOptions {
  readonly signal?: AbortSignal;
  /** Security-test seam invoked after discovery and before identity revalidation. */
  readonly afterPreflight?: () => void | Promise<void>;
  /** Security-test seam invoked after revalidation and before each removal claim. */
  readonly beforeDelete?: (path: string) => void | Promise<void>;
}
export async function ensureCurrentRunRoot(projectRootValue: string, signal?: AbortSignal): Promise<CurrentRunRoot> {
  const projectRoot = absolute(projectRootValue);
  signal?.throwIfAborted();
  let basePath = projectRoot;
  for (const name of [".mono-agent", "data", "core", "mcp-runs"]) {
    basePath = join(basePath, name);
    await ensureDirectory(basePath);
    signal?.throwIfAborted();
  }
  return directory(basePath, false);
}
export async function createCurrentRunFiles(options: CreateCurrentRunFilesOptions): Promise<CurrentRunFiles> {
  const runId = segment(options.runId);
  if (new Set(options.attachments.map((item) => item.id)).size !== options.attachments.length)
    throw new TypeError("Current-run attachment ids must be unique");
  options.signal.throwIfAborted();
  const base = await directory(options.root.path, false);
  assertSame(options.root, base);
  const runRoot = join(base.path, runId); const owned: Identity[] = [];
  const own = (identity: Identity): void => { owned.push(identity); };
  try {
    await createDirectory(runRoot, own, options.testHook); const attachmentsRoot = join(runRoot, "attachments");
    await createDirectory(attachmentsRoot, own, options.testHook);
    const runOutputDir = join(runRoot, "outbound"); const output = await createDirectory(runOutputDir, own, options.testHook);
    const staged: StagedAttachment[] = [];
    for (const [index, attachment] of options.attachments.entries()) {
      options.signal.throwIfAborted(); const name = `attachment-${String(index).padStart(3, "0")}${safeExtension(attachment.name)}`;
      const identity = await createFile(join(attachmentsRoot, name), new Uint8Array(attachment.data), own, options.testHook);
      staged.push(Object.freeze({ id: attachment.id, name: displayName(attachment.name, index),
        mediaType: attachment.mediaType, path: identity.path, dev: identity.dev.toString(), ino: identity.ino.toString() }));
    }
    assertSame(base, await directory(base.path, false)); const paths = Object.freeze(staged.map((item) => item.path));
    const identities = Object.freeze(staged.map(({ path, dev, ino }) => Object.freeze({ path, dev, ino })));
    const requestContext: McpRequestContextV1 = Object.freeze({ schemaVersion: 1,
      conversationId: options.conversationId, runId, runOutputDir, attachmentsRoot,
      allowedAttachmentPaths: paths, allowedAttachmentIdentities: identities, attachments: Object.freeze(staged) });
    let cleanupPromise: Promise<void> | undefined;
    return Object.freeze({ runOutputDir, requestContext,
      readOutput: (name: string, readOptions: ReadCurrentRunOutputOptions) =>
        readBoundOutput(output, name, readOptions),
      cleanup() { return cleanupPromise ??= cleanup(owned, output, options.testHook); } });
  } catch (error) { try { await cleanup(owned, owned[2], options.testHook); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Current-run setup failed and cleanup was incomplete");
    } throw error; }
}
type RecoveryDirectory = { readonly identity: CurrentRunRoot; readonly entries: readonly string[] };
type RecoveryInventory = {
  readonly nodes: Identity[]; readonly anchors: Identity[];
  readonly directories: RecoveryDirectory[]; entries: number;
};
type RecoveryShape = "root" | "run" | "payload";
export async function recoverCurrentRunRoot(
  root: CurrentRunRoot, leaseFilenameValue: string, options: RecoverCurrentRunRootOptions = {},
): Promise<void> {
  const leaseFilename = safeName(leaseFilenameValue);
  options.signal?.throwIfAborted();
  const boundRoot = await directory(root.path, false);
  assertSame(root, boundRoot);
  const inventory: RecoveryInventory = { nodes: [], anchors: [], directories: [], entries: 0 };
  await scanRecoveryDirectory(boundRoot, "root", 0, leaseFilename, inventory, options.signal);
  options.signal?.throwIfAborted();
  await options.afterPreflight?.();
  options.signal?.throwIfAborted();
  await revalidateRecoveryInventory(inventory);
  options.signal?.throwIfAborted();
  for (const node of [...inventory.nodes].reverse()) {
    options.signal?.throwIfAborted();
    await options.beforeDelete?.(node.path);
    await claimAndDelete(node);
  }
  assertSame(boundRoot, await directory(boundRoot.path, false));
  const remaining = await boundedCurrentRunEntries(
    boundRoot.path, 1, "Current-run recovery did not leave only the active lease");
  if (remaining[0] !== leaseFilename)
    throw new Error("Current-run recovery did not leave only the active lease");
}
async function scanRecoveryDirectory(
  identity: CurrentRunRoot, shape: RecoveryShape, depth: number,
  leaseFilename: string, inventory: RecoveryInventory, signal?: AbortSignal,
): Promise<void> {
  if (depth > CURRENT_RUN_RECOVERY_MAX_DEPTH)
    throw new Error("Current-run recovery exceeds the depth limit");
  signal?.throwIfAborted();
  assertSame(identity, await directory(identity.path, false));
  const remaining = CURRENT_RUN_RECOVERY_MAX_ENTRIES - inventory.entries;
  const maximum = shape === "root" ? Math.min(CURRENT_RUN_ROOT_MAX_ENTRIES, remaining) : remaining;
  const entries = await boundedCurrentRunEntries(identity.path, maximum,
    shape === "root" ? "Current-run recovery root exceeds the entry limit"
      : "Current-run recovery exceeds the total entry limit");
  inventory.directories.push({ identity, entries });
  for (const name of entries) {
    signal?.throwIfAborted();
    inventory.entries += 1;
    if (inventory.entries > CURRENT_RUN_RECOVERY_MAX_ENTRIES)
      throw new Error("Current-run recovery exceeds the total entry limit");
    const path = join(identity.path, name);
    const stat = await lstat(path, { bigint: true });
    if (shape === "root" && name === leaseFilename) {
      inventory.anchors.push(recoveryFile(path, stat));
      continue;
    }
    if (shape === "root") {
      if (cleanupSegment(name)) {
        await scanRecoveryClaim(path, stat, "run", depth + 1, leaseFilename, inventory, signal);
        continue;
      }
      if (!runSegment(name)) throw new Error("Current-run recovery found an unknown root entry");
      const child = await recoveryDirectory(path, stat);
      inventory.nodes.push(child);
      await scanRecoveryDirectory(child, "run", depth + 1, leaseFilename, inventory, signal);
      continue;
    }
    if (shape === "run") {
      if (cleanupSegment(name)) {
        await scanRecoveryClaim(path, stat, "payload", depth + 1, leaseFilename, inventory, signal);
        continue;
      }
      if (name !== "attachments" && name !== "outbound")
        throw new Error("Current-run recovery found an unknown run entry");
      const child = await recoveryDirectory(path, stat);
      inventory.nodes.push(child);
      await scanRecoveryDirectory(child, "payload", depth + 1, leaseFilename, inventory, signal);
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!cleanupSegment(name))
        throw new Error("Current-run recovery found an unknown payload directory");
      await scanRecoveryClaim(path, stat, "file", depth + 1, leaseFilename, inventory, signal);
      continue;
    }
    inventory.nodes.push(recoveryFile(path, stat));
  }
}
async function scanRecoveryClaim(
  path: string, stat: BigIntStats, entryShape: "run" | "payload" | "file",
  depth: number, leaseFilename: string, inventory: RecoveryInventory, signal?: AbortSignal,
): Promise<void> {
  const claim = await recoveryDirectory(path, stat);
  inventory.nodes.push(claim);
  if (depth > CURRENT_RUN_RECOVERY_MAX_DEPTH)
    throw new Error("Current-run recovery exceeds the depth limit");
  const entries = await boundedCurrentRunEntries(
    path, 1, "Current-run recovery found an invalid cleanup claim");
  inventory.directories.push({ identity: claim, entries });
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== "entry"))
    throw new Error("Current-run recovery found an invalid cleanup claim");
  if (entries.length === 0) return;
  signal?.throwIfAborted();
  inventory.entries += 1;
  if (inventory.entries > CURRENT_RUN_RECOVERY_MAX_ENTRIES)
    throw new Error("Current-run recovery exceeds the total entry limit");
  const entryPath = join(path, "entry");
  const entryStat = await lstat(entryPath, { bigint: true });
  if (entryShape === "file") {
    inventory.nodes.push(recoveryFile(entryPath, entryStat));
    return;
  }
  const entry = await recoveryDirectory(entryPath, entryStat);
  inventory.nodes.push(entry);
  await scanRecoveryDirectory(entry, entryShape, depth + 1, leaseFilename, inventory, signal);
}
async function revalidateRecoveryInventory(inventory: RecoveryInventory): Promise<void> {
  for (const snapshot of inventory.directories) {
    assertSame(snapshot.identity, await directory(snapshot.identity.path, false));
    const entries = await boundedCurrentRunEntries(snapshot.identity.path,
      snapshot.entries.length, "Current-run recovery tree changed after discovery");
    if (entries.length !== snapshot.entries.length
      || entries.some((entry, index) => entry !== snapshot.entries[index]))
      throw new Error("Current-run recovery tree changed after discovery");
  }
  for (const identity of [...inventory.anchors, ...inventory.nodes]) {
    assertIdentityStat(identity, await lstat(identity.path, { bigint: true }));
  }
}
async function recoveryDirectory(path: string, stat: BigIntStats): Promise<CurrentRunRoot> {
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Current-run recovery found an unsafe directory");
  assertOwned(stat);
  const identity: CurrentRunRoot = { path, dev: stat.dev, ino: stat.ino, type: "directory" };
  assertSame(identity, await directory(path, false));
  return identity;
}
function recoveryFile(path: string, stat: BigIntStats): Identity {
  assertOwned(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error("Current-run recovery found an unsafe file");
  return { path, dev: stat.dev, ino: stat.ino, type: "file" };
}
function cleanupSegment(value: string): boolean {
  return /^\.cleanup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(value);
}
function runSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
export async function boundedCurrentRunEntries(
  path: string, maximum: number, message: string): Promise<readonly string[]> {
  const handle = await opendir(path); const entries: string[] = [];
  try {
    while (true) {
      const entry = await handle.read();
      if (entry === null) return entries.sort();
      if (entries.length >= maximum) throw new Error(message);
      entries.push(entry.name);
    }
  } finally { await handle.close(); }
}
export async function readCurrentRunOutputAttachment(outputDirectory: string, outputName: string,
  options: ReadCurrentRunOutputOptions): Promise<ChannelAttachment> {
  return readBoundOutput(await directory(absolute(outputDirectory), false), outputName, options);
}
async function readBoundOutput(root: Identity, outputName: string, options: ReadCurrentRunOutputOptions): Promise<ChannelAttachment> {
  assertSame(root, await directory(root.path, false)); const name = safeName(outputName);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  const snapshot = await readAuthorityFile(join(root.path, name), {
    maxBytes: Math.min(options.maxBytes, CURRENT_RUN_OUTPUT_MAX_BYTES), signal: options.signal,
    ...(options.beforePathIdentityCheck === undefined ? {}
      : { beforePathIdentityCheck: options.beforePathIdentityCheck }),
  });
  const finalPath = await lstat(join(root.path, name), { bigint: true });
  assertIdentityStat({ path: snapshot.source.path, dev: BigInt(snapshot.source.device),
    ino: BigInt(snapshot.source.inode), type: "file" }, finalPath);
  assertSame(root, await directory(root.path, false)); options.signal.throwIfAborted();
  const data = new Uint8Array(snapshot.bytes); const digest = createHash("sha256").update(data).digest("hex");
  return Object.freeze({ id: `current-run-output:${digest.slice(0, 32)}`, kind: "file", name,
    mediaType: "application/octet-stream", sizeBytes: data.byteLength, data });
}
async function createDirectory(path: string, own: (identity: Identity) => void, hook?: CurrentRunHook): Promise<Identity> {
  await mkdir(path, { mode: DIR_MODE }); const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe current-run directory");
  const identity: Identity = { path, dev: stat.dev, ino: stat.ino, type: "directory" }; own(identity); await hook?.("directory", path);
  const verified = await directory(path, true); assertSame(identity, verified); return verified;
}
async function ensureDirectory(path: string): Promise<void> {
  let created = false;
  try { await mkdir(path, { mode: DIR_MODE }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  try { await directory(path, created); }
  catch (error) {
    throw new Error(
      "Current-run files root must be owned by the effective user, be owner-private, and must not traverse symbolic links",
      { cause: error },
    );
  }
}
async function directory(path: string, setPrivate: boolean): Promise<CurrentRunRoot> {
  let handle: FileHandle | undefined; try {
    const before = await lstat(path, { bigint: true });
    handle = await open(path, flags("directory"));
    const opened = await handle.stat({ bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Unsafe current-run directory");
    assertOwned(opened); if (setPrivate) await handle.chmod(DIR_MODE);
    const stat = setPrivate ? await handle.stat({ bigint: true }) : opened; assertOwned(stat);
    if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) throw new Error("Unsafe current-run directory");
    await assertPath(path, stat, "directory"); return { path, dev: stat.dev, ino: stat.ino, type: "directory" };
  } finally { await handle?.close(); }
}
async function createFile(path: string, data: Uint8Array, own: (identity: Identity) => void, hook?: CurrentRunHook): Promise<Identity> {
  let handle: FileHandle | undefined; try {
    handle = await open(path, flags("create"), FILE_MODE); const opened = await handle.stat({ bigint: true });
    const identity: Identity = { path, dev: opened.dev, ino: opened.ino, type: "file" };
    own(identity); assertOwned(opened); await handle.chmod(FILE_MODE);
    await hook?.("write", path); await handle.writeFile(data);
    await hook?.("sync", path); await handle.sync();
    await hook?.("stat", path); const stat = await handle.stat({ bigint: true }); assertOwned(stat);
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(data.byteLength)
      || (stat.mode & 0o777n) !== 0o600n)
      throw new Error("Unsafe staged current-run attachment");
    await hook?.("path", path); await assertPath(path, stat, "file");
    assertSame(identity, { path, dev: stat.dev, ino: stat.ino, type: "file" }); return identity;
  } finally { await handle?.close(); }
}
async function cleanup(owned: readonly Identity[], output?: Identity, hook?: CurrentRunHook): Promise<void> {
  const failures: unknown[] = [];
  if (output !== undefined) try { await purgeOutput(output, hook); }
  catch (error) { failures.push(error); }
  for (const item of [...owned].reverse()) try { await claimAndDelete(item, hook); }
  catch (error) { failures.push(error); }
  if (failures.length > 0)
    throw new AggregateError(failures, "Current-run cleanup retained one or more unverified paths");
}
async function purgeOutput(root: Identity, hook?: CurrentRunHook): Promise<void> {
  assertSame(root, await directory(root.path, false)); const entries = await readdir(root.path); const failures: unknown[] = [];
  if (entries.length > 256) throw new Error("Current-run output cleanup exceeds the entry limit");
  for (const name of entries) {
    const path = join(root.path, name);
    try {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
        throw new Error("Current-run output cleanup retained an unsafe entry");
      await claimAndDelete({ path, dev: stat.dev, ino: stat.ino, type: "file" }, hook);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Current-run output cleanup retained one or more entries");
}
async function claimAndDelete(expected: Identity, hook?: CurrentRunHook): Promise<void> {
  let stat: BigIntStats;
  try { stat = await lstat(expected.path, { bigint: true }); }
  catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  assertIdentityStat(expected, stat);
  if (expected.type === "directory" && (await readdir(expected.path)).length > 0)
    throw new Error("Current-run cleanup retained a non-empty directory");
  assertIdentityStat(expected, await lstat(expected.path, { bigint: true }));
  const claimRoot = join(dirname(expected.path), `.cleanup-${randomUUID()}`);
  await mkdir(claimRoot, { mode: DIR_MODE });
  const claimDirectory = await directory(claimRoot, true);
  const claimPath = join(claimRoot, "entry"); let moved = false; let failure: unknown;
  try {
    await hook?.("cleanup", expected.path); assertSame(claimDirectory, await directory(claimRoot, false));
    try { await rename(expected.path, claimPath); moved = true; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    if (moved) {
      assertSame(claimDirectory, await directory(claimRoot, false));
      const claimed = await lstat(claimPath, { bigint: true });
      assertIdentityStat(expected, claimed);
      if (expected.type === "file") await unlink(claimPath);
      else await rmdir(claimPath); moved = false;
    }
  } catch (error) {
    failure = error; if (moved) {
      try {
        if (await restoreClaim(claimPath, expected.path)) moved = false;
        else failure = new AggregateError(
          [error],
          `Current-run cleanup preserved an entry at ${claimPath} because its source could not be restored without overwrite`,
        );
      } catch (restoreError) {
        failure = new AggregateError(
          [error, restoreError],
          `Current-run cleanup preserved an entry at ${claimPath} after restoration failed`,
        );
      }
    }
  }
  try { await rmdir(claimRoot); }
  catch (error) {
    if (!hasCode(error, "ENOENT"))
      failure = failure === undefined
        ? error
        : new AggregateError([failure, error], "Current-run cleanup claim removal failed");
  }
  if (failure !== undefined) throw failure;
}
async function restoreClaim(claimPath: string, sourcePath: string): Promise<boolean> {
  try { await lstat(sourcePath, { bigint: true }); return false; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const claimed = await lstat(claimPath, { bigint: true });
  if (claimed.isFile() && !claimed.isSymbolicLink()) {
    try { await link(claimPath, sourcePath); } catch (error) { if (hasCode(error, "EEXIST")) return false; throw error; }
    const restored = await lstat(sourcePath, { bigint: true }); const current = await lstat(claimPath, { bigint: true });
    if (restored.dev !== claimed.dev || restored.ino !== claimed.ino
      || current.dev !== claimed.dev || current.ino !== claimed.ino)
      throw new Error("Current-run cleanup could not prove file restoration");
    await unlink(claimPath); return true;
  }
  if (claimed.isDirectory() && !claimed.isSymbolicLink()) {
    try { await rename(claimPath, sourcePath); }
    catch (error) {
      if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) return false;
      throw error;
    }
    return true; } return false;
}
function assertIdentityStat(expected: Identity, stat: BigIntStats): void {
  const matchesType = expected.type === "file" ? stat.isFile() : stat.isDirectory();
  assertOwned(stat);
  if (!matchesType || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino
    || (expected.type === "file" && stat.nlink !== 1n))
    throw new Error("Current-run path changed identity");
}
function assertOwned(stat: BigIntStats): void {
  if (typeof process.geteuid !== "function" || stat.uid !== BigInt(process.geteuid()))
    throw new Error("Current-run path must be owned by the effective user");
}
function hasCode(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code; }
async function assertPath(path: string, expected: BigIntStats, type: Identity["type"]): Promise<void> {
  const actual = await lstat(path, { bigint: true }); assertOwned(actual);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.isSymbolicLink()
    || (type === "file" ? !actual.isFile() : !actual.isDirectory()))
    throw new Error("Current-run path changed identity");
}
function assertSame(left: Identity, right: Identity): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.type !== right.type)
    throw new Error("Current-run root changed identity");
}
function flags(kind: "directory" | "file" | "create"): number {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Secure current-run files require O_NOFOLLOW");
  if (kind === "create") return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  if (kind === "directory") {
    if (typeof constants.O_DIRECTORY !== "number")
      throw new Error("Secure current-run directories require O_DIRECTORY");
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}
function absolute(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || resolve(value) !== value)
    throw new TypeError("Current-run root must be a normalized absolute path");
  return value;
}
function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new TypeError("Current-run id must be one safe path segment");
  return value;
}
function safeName(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 255 || value !== value.trim()
    || value === "." || value === ".." || value.includes("/") || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value))
    throw new TypeError("Current-run output name must be one safe basename");
  return value;
}
function safeExtension(name: string): string {
  const extension = extname(name).slice(1);
  return /^[A-Za-z0-9]{1,16}$/u.test(extension) ? `.${extension}` : "";
}
function displayName(name: string, index: number): string {
  const raw = name.split(/[\\/]/u).at(-1);
  const safe = raw?.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return raw === "." || raw === ".." || safe === undefined || safe.length === 0
    || safe === "." || safe === ".." ? `attachment-${String(index)}` : safe;
}

import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ChannelAttachment, NormalizedAttachment } from "@mono-agent/module-sdk";
import { readAuthorityFile } from "./authority-read.js";
export const CURRENT_RUN_OUTPUT_MAX_BYTES = 25_000_000; const DIR_MODE = 0o700; const FILE_MODE = 0o600;
type Identity = { readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly type: "file" | "directory" }; type StagedAttachment = { readonly id: string; readonly name: string; readonly mediaType: string; readonly path: string; readonly dev: string; readonly ino: string };
export interface McpRequestContextV1 { readonly schemaVersion: 1; readonly conversationId: string; readonly runId: string; readonly runOutputDir: string; readonly attachmentsRoot: string; readonly allowedAttachmentPaths: readonly string[]; readonly allowedAttachmentIdentities: readonly { readonly path: string; readonly dev: string; readonly ino: string }[]; readonly attachments: readonly StagedAttachment[] }
type CurrentRunHook = (phase: "directory" | "write" | "sync" | "stat" | "path" | "cleanup", path: string) => void | Promise<void>; export interface CreateCurrentRunFilesOptions { readonly projectRoot: string; readonly runId: string; readonly conversationId: string; readonly attachments: readonly NormalizedAttachment[]; readonly signal: AbortSignal; /** Security-test seam. */ readonly testHook?: CurrentRunHook }
export interface CurrentRunFiles { readonly runOutputDir: string; readonly requestContext: McpRequestContextV1; readOutput(name: string, options: ReadCurrentRunOutputOptions): Promise<ChannelAttachment>; cleanup(): Promise<void> } export interface ReadCurrentRunOutputOptions { readonly maxBytes: number; readonly signal: AbortSignal; readonly beforePathIdentityCheck?: () => void | Promise<void> }
export async function createCurrentRunFiles(options: CreateCurrentRunFilesOptions): Promise<CurrentRunFiles> {
  const projectRoot = absolute(options.projectRoot); const runId = segment(options.runId);
  if (new Set(options.attachments.map((item) => item.id)).size !== options.attachments.length) throw new TypeError("Current-run attachment ids must be unique");
  options.signal.throwIfAborted(); let basePath = projectRoot;
  for (const name of [".mono-agent", "data", "core", "mcp-runs"]) { basePath = join(basePath, name); await ensureDirectory(basePath); }
  const base = await directory(basePath, true); const runRoot = join(basePath, runId); const owned: Identity[] = [];
  const own = (identity: Identity): void => { owned.push(identity); };
  try {
    await createDirectory(runRoot, own, options.testHook); const attachmentsRoot = join(runRoot, "attachments"); await createDirectory(attachmentsRoot, own, options.testHook);
    const runOutputDir = join(runRoot, "outbound"); const output = await createDirectory(runOutputDir, own, options.testHook);
    const staged: StagedAttachment[] = [];
    for (const [index, attachment] of options.attachments.entries()) {
      options.signal.throwIfAborted(); const name = `attachment-${String(index).padStart(3, "0")}${safeExtension(attachment.name)}`;
      const identity = await createFile(join(attachmentsRoot, name), new Uint8Array(attachment.data), own, options.testHook);
      staged.push(Object.freeze({ id: attachment.id, name: displayName(attachment.name, index), mediaType: attachment.mediaType, path: identity.path, dev: identity.dev.toString(), ino: identity.ino.toString() }));
    }
    assertSame(base, await directory(basePath, false)); const paths = Object.freeze(staged.map((item) => item.path));
    const identities = Object.freeze(staged.map(({ path, dev, ino }) => Object.freeze({ path, dev, ino })));
    const requestContext: McpRequestContextV1 = Object.freeze({ schemaVersion: 1, conversationId: options.conversationId, runId, runOutputDir, attachmentsRoot, allowedAttachmentPaths: paths, allowedAttachmentIdentities: identities, attachments: Object.freeze(staged) });
    let cleanupPromise: Promise<void> | undefined;
    return Object.freeze({ runOutputDir, requestContext, readOutput: (name: string, readOptions: ReadCurrentRunOutputOptions) => readBoundOutput(output, name, readOptions), cleanup() { return cleanupPromise ??= cleanup(owned, output, options.testHook); } });
  } catch (error) { try { await cleanup(owned, owned[2], options.testHook); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Current-run setup failed and cleanup was incomplete"); } throw error; }
}
export async function readCurrentRunOutputAttachment(outputDirectory: string, outputName: string, options: ReadCurrentRunOutputOptions): Promise<ChannelAttachment> { return readBoundOutput(await directory(absolute(outputDirectory), false), outputName, options); }
async function readBoundOutput(root: Identity, outputName: string, options: ReadCurrentRunOutputOptions): Promise<ChannelAttachment> {
  assertSame(root, await directory(root.path, false)); const name = safeName(outputName);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  const snapshot = await readAuthorityFile(join(root.path, name), { maxBytes: Math.min(options.maxBytes, CURRENT_RUN_OUTPUT_MAX_BYTES), signal: options.signal, ...(options.beforePathIdentityCheck === undefined ? {} : { beforePathIdentityCheck: options.beforePathIdentityCheck }) });
  const finalPath = await lstat(join(root.path, name), { bigint: true }); assertIdentityStat({ path: snapshot.source.path, dev: BigInt(snapshot.source.device), ino: BigInt(snapshot.source.inode), type: "file" }, finalPath);
  assertSame(root, await directory(root.path, false)); options.signal.throwIfAborted();
  const data = new Uint8Array(snapshot.bytes); const digest = createHash("sha256").update(data).digest("hex");
  return Object.freeze({ id: `current-run-output:${digest.slice(0, 32)}`, kind: "file", name, mediaType: "application/octet-stream", sizeBytes: data.byteLength, data });
}
async function createDirectory(path: string, own: (identity: Identity) => void, hook?: CurrentRunHook): Promise<Identity> {
  await mkdir(path, { mode: DIR_MODE }); const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe current-run directory");
  const identity: Identity = { path, dev: stat.dev, ino: stat.ino, type: "directory" }; own(identity); await hook?.("directory", path);
  const verified = await directory(path, true); assertSame(identity, verified); return verified;
}
async function ensureDirectory(path: string): Promise<void> { try { await mkdir(path, { mode: DIR_MODE }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } try { await directory(path, true); } catch (error) { throw new Error("Current-run files root must be owned by the effective user, be owner-private, and must not traverse symbolic links", { cause: error }); } }
async function directory(path: string, setPrivate: boolean): Promise<Identity> {
  let handle: FileHandle | undefined; try {
    const before = await lstat(path, { bigint: true }); handle = await open(path, flags("directory")); const opened = await handle.stat({ bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Unsafe current-run directory");
    assertOwned(opened); if (setPrivate) await handle.chmod(DIR_MODE);
    const stat = setPrivate ? await handle.stat({ bigint: true }) : opened; assertOwned(stat);
    if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) throw new Error("Unsafe current-run directory");
    await assertPath(path, stat, "directory"); return { path, dev: stat.dev, ino: stat.ino, type: "directory" };
  } finally { await handle?.close(); }
}
async function createFile(path: string, data: Uint8Array, own: (identity: Identity) => void, hook?: CurrentRunHook): Promise<Identity> {
  let handle: FileHandle | undefined; try {
    handle = await open(path, flags("create"), FILE_MODE); const opened = await handle.stat({ bigint: true });
    const identity: Identity = { path, dev: opened.dev, ino: opened.ino, type: "file" }; own(identity); assertOwned(opened); await handle.chmod(FILE_MODE);
    await hook?.("write", path); await handle.writeFile(data);
    await hook?.("sync", path); await handle.sync();
    await hook?.("stat", path); const stat = await handle.stat({ bigint: true }); assertOwned(stat);
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(data.byteLength) || (stat.mode & 0o777n) !== 0o600n) throw new Error("Unsafe staged current-run attachment");
    await hook?.("path", path); await assertPath(path, stat, "file");
    assertSame(identity, { path, dev: stat.dev, ino: stat.ino, type: "file" }); return identity;
  } finally { await handle?.close(); }
}
async function cleanup(owned: readonly Identity[], output?: Identity, hook?: CurrentRunHook): Promise<void> { const failures: unknown[] = []; if (output !== undefined) try { await purgeOutput(output, hook); } catch (error) { failures.push(error); } for (const item of [...owned].reverse()) try { await claimAndDelete(item, hook); } catch (error) { failures.push(error); } if (failures.length > 0) throw new AggregateError(failures, "Current-run cleanup retained one or more unverified paths"); }
async function purgeOutput(root: Identity, hook?: CurrentRunHook): Promise<void> {
  assertSame(root, await directory(root.path, false)); const entries = await readdir(root.path); const failures: unknown[] = [];
  if (entries.length > 256) throw new Error("Current-run output cleanup exceeds the entry limit");
  for (const name of entries) {
    const path = join(root.path, name);
    try {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("Current-run output cleanup retained an unsafe entry");
      await claimAndDelete({ path, dev: stat.dev, ino: stat.ino, type: "file" }, hook);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Current-run output cleanup retained one or more entries");
}
async function claimAndDelete(expected: Identity, hook?: CurrentRunHook): Promise<void> {
  let stat: BigIntStats; try { stat = await lstat(expected.path, { bigint: true }); } catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  assertIdentityStat(expected, stat);
  if (expected.type === "directory" && (await readdir(expected.path)).length > 0) throw new Error("Current-run cleanup retained a non-empty directory");
  assertIdentityStat(expected, await lstat(expected.path, { bigint: true }));
  const claimRoot = join(dirname(expected.path), `.cleanup-${randomUUID()}`); await mkdir(claimRoot, { mode: DIR_MODE }); const claimDirectory = await directory(claimRoot, true);
  const claimPath = join(claimRoot, "entry"); let moved = false; let failure: unknown;
  try {
    await hook?.("cleanup", expected.path); assertSame(claimDirectory, await directory(claimRoot, false));
    try { await rename(expected.path, claimPath); moved = true; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    if (moved) {
      assertSame(claimDirectory, await directory(claimRoot, false)); const claimed = await lstat(claimPath, { bigint: true }); assertIdentityStat(expected, claimed);
      if (expected.type === "file") await unlink(claimPath);
      else await rmdir(claimPath); moved = false;
    }
  } catch (error) {
    failure = error; if (moved) {
      try {
        if (await restoreClaim(claimPath, expected.path)) moved = false;
        else failure = new AggregateError([error], `Current-run cleanup preserved an entry at ${claimPath} because its source could not be restored without overwrite`);
      } catch (restoreError) { failure = new AggregateError([error, restoreError], `Current-run cleanup preserved an entry at ${claimPath} after restoration failed`); }
    }
  }
  try { await rmdir(claimRoot); } catch (error) { if (!hasCode(error, "ENOENT")) failure = failure === undefined ? error : new AggregateError([failure, error], "Current-run cleanup claim removal failed"); }
  if (failure !== undefined) throw failure;
}
async function restoreClaim(claimPath: string, sourcePath: string): Promise<boolean> {
  try { await lstat(sourcePath, { bigint: true }); return false; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const claimed = await lstat(claimPath, { bigint: true });
  if (claimed.isFile() && !claimed.isSymbolicLink()) {
    try { await link(claimPath, sourcePath); } catch (error) { if (hasCode(error, "EEXIST")) return false; throw error; }
    const restored = await lstat(sourcePath, { bigint: true }); const current = await lstat(claimPath, { bigint: true });
    if (restored.dev !== claimed.dev || restored.ino !== claimed.ino || current.dev !== claimed.dev || current.ino !== claimed.ino) throw new Error("Current-run cleanup could not prove file restoration");
    await unlink(claimPath); return true;
  }
  if (claimed.isDirectory() && !claimed.isSymbolicLink()) {
    try { await rename(claimPath, sourcePath); } catch (error) { if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) return false; throw error; }
    return true; } return false;
}
function assertIdentityStat(expected: Identity, stat: BigIntStats): void { const matchesType = expected.type === "file" ? stat.isFile() : stat.isDirectory(); assertOwned(stat); if (!matchesType || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino || (expected.type === "file" && stat.nlink !== 1n)) throw new Error("Current-run path changed identity"); }
function assertOwned(stat: BigIntStats): void { if (typeof process.geteuid !== "function" || stat.uid !== BigInt(process.geteuid())) throw new Error("Current-run path must be owned by the effective user"); }
function hasCode(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code; }
async function assertPath(path: string, expected: BigIntStats, type: Identity["type"]): Promise<void> {
  const actual = await lstat(path, { bigint: true }); assertOwned(actual);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.isSymbolicLink() || (type === "file" ? !actual.isFile() : !actual.isDirectory())) throw new Error("Current-run path changed identity");
}
function assertSame(left: Identity, right: Identity): void { if (left.dev !== right.dev || left.ino !== right.ino || left.type !== right.type) throw new Error("Current-run root changed identity"); }
function flags(kind: "directory" | "file" | "create"): number {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Secure current-run files require O_NOFOLLOW");
  if (kind === "create") return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  if (kind === "directory") {
    if (typeof constants.O_DIRECTORY !== "number") throw new Error("Secure current-run directories require O_DIRECTORY"); return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}
function absolute(value: string): string { if (!isAbsolute(value) || value.includes("\0") || resolve(value) !== value) throw new TypeError("Current-run root must be a normalized absolute path"); return value; }
function segment(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new TypeError("Current-run id must be one safe path segment"); return value; }
function safeName(value: string): string { if (Buffer.byteLength(value, "utf8") > 255 || value !== value.trim() || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("Current-run output name must be one safe basename"); return value; }
function safeExtension(name: string): string { const extension = extname(name).slice(1); return /^[A-Za-z0-9]{1,16}$/u.test(extension) ? `.${extension}` : ""; }
function displayName(name: string, index: number): string {
  const raw = name.split(/[\\/]/u).at(-1); const safe = raw?.replace(/[\u0000-\u001f\u007f]/gu, "").trim(); return raw === "." || raw === ".." || safe === undefined || safe.length === 0 || safe === "." || safe === ".." ? `attachment-${String(index)}` : safe;
}

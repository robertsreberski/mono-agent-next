// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  COPY_BUFFER_BYTES,
  MAX_TREE_BYTES,
  MAX_TREE_ENTRIES,
  assertBoundedActiveDatabase,
  assertSourceDirectory,
  assertSourceFile,
  comparePathNames,
  migrationFailure,
  sameStableDirectoryIdentity,
  sameStableIdentity,
  skipSnapshotPath,
  syncSnapshotDirectory,
  throwIfAborted,
  type MemoryLocalMigrationTestHooks,
} from "./migration-fs.js";

interface SnapshotSourceFileEvidence {
  readonly stats: BigIntStats;
  readonly sha256: string;
}

interface SnapshotSourceDirectoryEvidence {
  readonly stats: BigIntStats;
  readonly children: readonly string[];
}

export class SnapshotCopier {
  readonly #sourceRoot: string;
  readonly #targetRoot: string;
  readonly #activeDatabase: string;
  readonly #signal: AbortSignal;
  readonly #hooks: MemoryLocalMigrationTestHooks;
  readonly #files = new Map<string, SnapshotSourceFileEvidence>();
  readonly #directories = new Map<string, SnapshotSourceDirectoryEvidence>();
  #activeDatabaseBytes: number;
  #entries = 0;
  #bytes = 0;

  constructor(
    sourceRoot: string,
    targetRoot: string,
    activeDatabase: string,
    activeDatabaseBytes: number,
    signal: AbortSignal,
    hooks: MemoryLocalMigrationTestHooks,
  ) {
    this.#sourceRoot = sourceRoot;
    this.#targetRoot = targetRoot;
    this.#activeDatabase = activeDatabase;
    this.#signal = signal;
    this.#hooks = hooks;
    this.#activeDatabaseBytes = activeDatabaseBytes;
    this.#count(activeDatabaseBytes);
  }

  assertActiveDatabaseBytes(bytes: number): void {
    assertBoundedActiveDatabase(bytes);
    this.#bytes += bytes - this.#activeDatabaseBytes;
    this.#activeDatabaseBytes = bytes;
    if (this.#bytes > MAX_TREE_BYTES) {
      throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
    }
  }

  async copyDirectory(relativePath: string): Promise<void> {
    throwIfAborted(this.#signal);
    const sourcePath = relativePath === "" ? this.#sourceRoot : join(this.#sourceRoot, relativePath);
    const before = await lstat(sourcePath, { bigint: true });
    assertSourceDirectory(sourcePath, before);
    if (relativePath !== "") {
      await mkdir(join(this.#targetRoot, relativePath), { mode: 0o700 });
    }
    this.#count(0);
    const entries = (await readdir(sourcePath, { withFileTypes: true }))
      .sort((left, right) => comparePathNames(left.name, right.name));
    const copiedChildren: string[] = [];
    for (const entry of entries) {
      const childRelative = relativePath === "" ? entry.name : join(relativePath, entry.name);
      if (skipSnapshotPath(childRelative, this.#activeDatabase)) continue;
      copiedChildren.push(entry.name);
      const sourceChild = join(this.#sourceRoot, childRelative);
      const stats = await lstat(sourceChild, { bigint: true });
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await this.copyDirectory(childRelative);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw migrationFailure("Snapshot source contains an unsupported filesystem entry.");
      }
      this.#count(Number(stats.size));
      this.#files.set(childRelative, await copyStableFile(
        sourceChild,
        join(this.#targetRoot, childRelative),
        this.#signal,
        stats,
      ));
    }
    const after = await lstat(sourcePath, { bigint: true });
    if (!sameStableDirectoryIdentity(before, after)) {
      throw migrationFailure("Snapshot source directory changed while it was copied.");
    }
    this.#directories.set(relativePath, Object.freeze({
      stats: after,
      children: Object.freeze(copiedChildren),
    }));
    await syncSnapshotDirectory(
      relativePath === "" ? this.#targetRoot : join(this.#targetRoot, relativePath),
      this.#hooks,
    );
  }

  async verifySourceTree(): Promise<void> {
    const seenFiles = new Set<string>();
    const seenDirectories = new Set<string>();
    const walk = async (relativePath: string): Promise<void> => {
      throwIfAborted(this.#signal);
      const expected = this.#directories.get(relativePath);
      if (expected === undefined) {
        throw migrationFailure("Snapshot source directory manifest is incomplete.");
      }
      const sourcePath = relativePath === ""
        ? this.#sourceRoot
        : join(this.#sourceRoot, relativePath);
      const current = await lstat(sourcePath, { bigint: true });
      assertSourceDirectory(sourcePath, current);
      if (!sameStableDirectoryIdentity(expected.stats, current)) {
        throw migrationFailure("Snapshot source directory changed after it was copied.");
      }
      const children = (await readdir(sourcePath))
        .sort(comparePathNames)
        .filter((name) => {
          const child = relativePath === "" ? name : join(relativePath, name);
          return !skipSnapshotPath(child, this.#activeDatabase);
        });
      if (
        children.length !== expected.children.length
        || children.some((name, index) => name !== expected.children[index])
      ) {
        throw migrationFailure("Snapshot source tree changed after it was copied.");
      }
      seenDirectories.add(relativePath);
      for (const name of children) {
        const child = relativePath === "" ? name : join(relativePath, name);
        const directory = this.#directories.get(child);
        if (directory !== undefined) {
          await walk(child);
          continue;
        }
        const file = this.#files.get(child);
        if (file === undefined) {
          throw migrationFailure("Snapshot source file manifest is incomplete.");
        }
        await verifyCopiedSourceFile(join(this.#sourceRoot, child), file, this.#signal);
        seenFiles.add(child);
      }
    };
    await walk("");
    if (
      seenFiles.size !== this.#files.size
      || seenDirectories.size !== this.#directories.size
    ) {
      throw migrationFailure("Snapshot source tree manifest no longer matches the source.");
    }
  }

  #count(bytes: number): void {
    this.#entries += 1;
    this.#bytes += bytes;
    if (this.#entries > MAX_TREE_ENTRIES || this.#bytes > MAX_TREE_BYTES) {
      throw migrationFailure("Snapshot source exceeds the bounded tree limits.");
    }
  }
}

async function copyStableFile(
  source: string,
  target: string,
  signal: AbortSignal,
  before: BigIntStats,
): Promise<SnapshotSourceFileEvidence> {
  assertSourceFile(source, before);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: FileHandle | undefined;
  try {
    const opened = await input.stat({ bigint: true });
    assertSourceFile(source, opened);
    if (!sameStableIdentity(before, opened)) {
      throw migrationFailure("Snapshot source file changed while opening.");
    }
    output = await open(
      target,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < Number(opened.size)) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, Number(opened.size) - offset);
      const { bytesRead } = await input.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      const { bytesWritten } = await output.write(buffer, 0, bytesRead, offset);
      if (bytesWritten !== bytesRead) {
        throw migrationFailure("Snapshot target file write was incomplete.");
      }
      offset += bytesRead;
    }
    if (offset !== Number(opened.size)) {
      throw migrationFailure("Snapshot source file changed size while reading.");
    }
    await output.sync();
    const after = await input.stat({ bigint: true });
    const current = await lstat(source, { bigint: true });
    if (!sameStableIdentity(opened, after) || !sameStableIdentity(after, current)) {
      throw migrationFailure("Snapshot source file changed while it was copied.");
    }
    return Object.freeze({ stats: after, sha256: hash.digest("hex") });
  } finally {
    await output?.close().catch(() => undefined);
    await input.close();
  }
}

async function verifyCopiedSourceFile(
  path: string,
  expected: SnapshotSourceFileEvidence,
  signal: AbortSignal,
): Promise<void> {
  const before = await lstat(path, { bigint: true });
  assertSourceFile(path, before);
  if (!sameStableIdentity(expected.stats, before)) {
    throw migrationFailure("Snapshot source file changed after it was copied.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableIdentity(before, opened)) {
      throw migrationFailure("Snapshot source file changed while it was re-opened.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < Number(opened.size)) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, Number(opened.size) - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset !== Number(opened.size) || hash.digest("hex") !== expected.sha256) {
      throw migrationFailure("Snapshot source file content changed after it was copied.");
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameStableIdentity(opened, after) || !sameStableIdentity(after, current)) {
      throw migrationFailure("Snapshot source file changed while it was rechecked.");
    }
  } finally {
    await handle.close();
  }
}

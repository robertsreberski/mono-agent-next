import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
} from "../index.js";
import { openMemoryLocalForTesting as openMemoryLocal } from "../store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local permanent marker and database identity", () => {
  it("publishes the exact initialized marker on the original inode without renaming or unlinking it", async () => {
    const fixture = await createFixture();
    let before: { readonly dev: bigint; readonly ino: bigint } | undefined;
    const memory = await openMemoryLocal({
      ...options(fixture),
      hooks: {
        async beforeMarkerCommit(path) {
          const current = await stat(path, { bigint: true });
          before = { dev: current.dev, ino: current.ino };
          expect(await readFile(path, "utf8")).toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
        },
      },
    });
    try {
      const markerPath = join(fixture.directory, MEMORY_LOCAL_MARKER_FILENAME);
      const after = await stat(markerPath, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }).toEqual(before);
      expect(after.mode & 0o777n).toBe(0o600n);
      expect(after.nlink).toBe(1n);
      expect(await readFile(markerPath, "utf8")).toMatch(/^initialized:[0-9a-f-]{36}\n$/u);
    } finally {
      await memory.stop();
    }
  });

  it("fails closed on pre-commit marker pathname replacement and leaves both targets inspectable", async () => {
    const fixture = await createFixture();
    const replacement = Buffer.from("initialized:00000000-0000-0000-0000-000000000000\n");
    let displaced = "";
    await expect(openMemoryLocal({
      ...options(fixture),
      hooks: {
        async beforeMarkerCommit(path) {
          displaced = `${path}.operator-original`;
          await rename(path, displaced);
          await writeFile(path, replacement, { flag: "wx", mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: "unsafe_store" });
    expect(await readFile(join(fixture.directory, MEMORY_LOCAL_MARKER_FILENAME))).toEqual(replacement);
    expect(await readFile(displaced, "utf8")).toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
  });

  it("fails closed on post-commit marker pathname replacement without modifying the replacement", async () => {
    const fixture = await createFixture();
    const replacement = Buffer.from("initialized:00000000-0000-0000-0000-000000000000\n");
    let displaced = "";
    await expect(openMemoryLocal({
      ...options(fixture),
      hooks: {
        async afterMarkerCommit(path) {
          displaced = `${path}.published-original`;
          await rename(path, displaced);
          await writeFile(path, replacement, { flag: "wx", mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: "unsafe_store" });
    expect(await readFile(join(fixture.directory, MEMORY_LOCAL_MARKER_FILENAME))).toEqual(replacement);
    expect(await readFile(displaced, "utf8")).toMatch(/^initialized:[0-9a-f-]{36}\n$/u);
  });

  it("rejects an exact-byte marker inode replacement before reopening the permanent descriptor", async () => {
    const fixture = await createFixture();
    let displaced = "";
    let replacement = Buffer.alloc(0);
    await expect(openMemoryLocal({
      ...options(fixture),
      hooks: {
        async beforeMarkerReopen(path) {
          replacement = await readFile(path);
          displaced = `${path}.verified-original`;
          await rename(path, displaced);
          await writeFile(path, replacement, { flag: "wx", mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: "unsafe_store" });
    const markerPath = join(fixture.directory, MEMORY_LOCAL_MARKER_FILENAME);
    expect(await readFile(markerPath)).toEqual(replacement);
    expect(await readFile(displaced)).toEqual(replacement);
    expect((await stat(markerPath, { bigint: true })).ino)
      .not.toBe((await stat(displaced, { bigint: true })).ino);
  });

  it("detects forged same-inode marker bytes before and after publication", async () => {
    const beforeFixture = await createFixture();
    let inodeBefore = 0n;
    await expect(openMemoryLocal({
      ...options(beforeFixture),
      hooks: {
        async beforeMarkerCommit(path) {
          inodeBefore = (await stat(path, { bigint: true })).ino;
          await writeFile(path, "initializing:00000000-0000-0000-0000-000000000000\n", { mode: 0o600 });
          expect((await stat(path, { bigint: true })).ino).toBe(inodeBefore);
        },
      },
    })).rejects.toMatchObject({ code: "corrupt_store" });

    const afterFixture = await createFixture();
    let inodeAfter = 0n;
    await expect(openMemoryLocal({
      ...options(afterFixture),
      hooks: {
        async afterMarkerCommit(path) {
          inodeAfter = (await stat(path, { bigint: true })).ino;
          await writeFile(path, "initialized:00000000-0000-0000-0000-000000000000\n", { mode: 0o600 });
          expect((await stat(path, { bigint: true })).ino).toBe(inodeAfter);
        },
      },
    })).rejects.toMatchObject({ code: "corrupt_store" });
  });

  it("rejects legacy released markers without mutating operator data", async () => {
    const fixture = await createFixture();
    const legacy = join(
      fixture.directory,
      ".first-run-memory-initializing.released-20260723T000000Z",
    );
    const bytes = Buffer.from("operator legacy marker");
    await writeFile(legacy, bytes, { flag: "wx", mode: 0o600 });
    await expect(openMemoryLocal(options(fixture)))
      .rejects.toMatchObject({ code: "incomplete_initialization" });
    expect(await readFile(legacy)).toEqual(bytes);
  });

  it("rejects a post-verification database swap before SQLite open without mutating the replacement", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture));
    await initialized.stop();
    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const replacement = Buffer.from("operator replacement database");
    const displaced = join(fixture.directory, "memory.original.db");
    await expect(openMemoryLocal({
      ...options(fixture),
      hooks: {
        async beforeDatabaseOpen(path) {
          await rename(path, displaced);
          await writeFile(path, replacement, { flag: "wx", mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: "unsafe_store" });
    expect(await readFile(databasePath)).toEqual(replacement);
    expect((await stat(displaced)).size).toBeGreaterThan(0);
    expect((await stat(databasePath)).nlink).toBe(1);
    expect((await stat(displaced)).nlink).toBe(1);
    await expect(stat(join(
      fixture.directory,
      `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixture.directory)).filter((name) =>
      name.startsWith(`.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding.authority-`)))
      .toEqual([]);
  });

  it("recovers a reserved crash binding and restores one canonical link on clean close", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture));
    await initialized.stop();
    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
    const database = await stat(databasePath);
    const authorityPath = bindingAuthorityPath(bindingPath, database);
    await mkdir(authorityPath, { mode: 0o700 });
    await link(databasePath, bindingPath);
    expect((await stat(databasePath)).nlink).toBe(2);

    const recovered = await openMemoryLocal(options(fixture));
    await expect(recovered.audit({ signal: new AbortController().signal, strict: true }))
      .resolves.toMatchObject({ status: "healthy", database: { links: 2 } });
    await recovered.stop();
    expect((await stat(databasePath)).nlink).toBe(1);
    await expect(stat(bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(authorityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hard-kill recovers both authority-before-link and authorized-link-before-sync boundaries", async () => {
    for (const createLink of [false, true]) {
      const fixture = await createFixture();
      const initialized = await openMemoryLocal(options(fixture));
      await initialized.stop();
      const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
      const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
      const authorityPath = bindingAuthorityPath(bindingPath, await stat(databasePath));
      await hardKill(`
        const fs = require("node:fs");
        fs.mkdirSync(process.argv[1], { mode: 0o700 });
        const parent = fs.openSync(process.argv[2], "r");
        fs.fsyncSync(parent);
        fs.closeSync(parent);
        if (process.argv[3] === "link") fs.linkSync(process.argv[4], process.argv[5]);
        process.kill(process.pid, "SIGKILL");
      `, [
        authorityPath,
        fixture.directory,
        createLink ? "link" : "authority-only",
        databasePath,
        bindingPath,
      ]);

      const recovered = await openMemoryLocal(options(fixture));
      await expect(recovered.audit({
        signal: new AbortController().signal,
        strict: true,
      })).resolves.toMatchObject({ status: "healthy" });
      await recovered.stop();
      expect((await stat(databasePath)).nlink).toBe(1);
      await expect(stat(bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(authorityPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("hard-kill recovers a committed WAL only through its authorized inode binding", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture));
    await initialized.stop();
    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
    const authorityPath = bindingAuthorityPath(bindingPath, await stat(databasePath));
    await mkdir(authorityPath, { mode: 0o700 });
    await link(databasePath, bindingPath);
    await hardKill(`
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(process.argv[1], { timeout: 0 });
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      database.prepare("INSERT INTO index_metadata(key, value) VALUES (?, ?)").run(
        "hard-kill-wal-proof",
        "committed",
      );
      database.exec("COMMIT");
      process.kill(process.pid, "SIGKILL");
    `, [bindingPath]);
    await expect(stat(`${bindingPath}-wal`)).resolves.toBeDefined();

    const recovered = await openMemoryLocal(options(fixture));
    await expect(recovered.audit({
      signal: new AbortController().signal,
      strict: true,
    })).resolves.toMatchObject({ status: "healthy" });
    await recovered.stop();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        "SELECT value FROM index_metadata WHERE key = ?",
      ).get("hard-kill-wal-proof")).toEqual({ value: "committed" });
    } finally {
      database.close();
    }
    expect((await stat(databasePath)).nlink).toBe(1);
    await expect(stat(bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(authorityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an exact-byte WAL replacement after SQLite open and quarantines it before close", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture));
    await initialized.stop();
    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
    const authorityPath = bindingAuthorityPath(bindingPath, await stat(databasePath));
    await mkdir(authorityPath, { mode: 0o700 });
    await link(databasePath, bindingPath);
    await hardKill(`
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(process.argv[1], { timeout: 0 });
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      database.prepare("INSERT INTO index_metadata(key, value) VALUES (?, ?)").run(
        "sidecar-swap-proof",
        "committed",
      );
      database.exec("COMMIT");
      process.kill(process.pid, "SIGKILL");
    `, [bindingPath]);

    const walPath = `${bindingPath}-wal`;
    const displaced = `${walPath}.admitted-original`;
    let legitimateBytes = Buffer.alloc(0);
    let replacementInode = 0n;
    await expect(openMemoryLocal({
      ...options(fixture),
      hooks: {
        async afterDatabaseOpen() {
          legitimateBytes = await readFile(walPath);
          await rename(walPath, displaced);
          await writeFile(walPath, legitimateBytes, { flag: "wx", mode: 0o600 });
          replacementInode = (await stat(walPath, { bigint: true })).ino;
        },
      },
    })).rejects.toMatchObject({ code: "unsafe_store" });

    expect(await readFile(displaced)).toEqual(legitimateBytes);
    const quarantines = (await readdir(fixture.directory)).filter((name) =>
      name.startsWith(`.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding.sidecar-quarantine-`));
    expect(quarantines).toHaveLength(1);
    const quarantine = join(fixture.directory, quarantines[0]!);
    const unexpected = join(quarantine, "unexpected-wal");
    const admitted = join(quarantine, "admitted-wal.snapshot");
    expect(await readFile(unexpected)).toEqual(legitimateBytes);
    expect(await readFile(admitted)).toEqual(legitimateBytes);
    expect((await stat(unexpected, { bigint: true })).ino).toBe(replacementInode);
    expect((await stat(displaced, { bigint: true })).ino)
      .not.toBe((await stat(unexpected, { bigint: true })).ino);
    await expect(openMemoryLocal(options(fixture)))
      .rejects.toMatchObject({ code: "unsafe_store" });
  });

  it("rejects a hard-linked authorized WAL before SQLite can mutate its external inode", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture));
    await initialized.stop();
    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
    const authorityPath = bindingAuthorityPath(bindingPath, await stat(databasePath));
    await mkdir(authorityPath, { mode: 0o700 });
    await link(databasePath, bindingPath);
    const external = join(fixture.root, "external-target");
    const bytes = Buffer.from("external bytes must remain unchanged");
    await writeFile(external, bytes, { flag: "wx", mode: 0o600 });
    await link(external, `${bindingPath}-wal`);

    await expect(openMemoryLocal(options(fixture)))
      .rejects.toMatchObject({ code: "unsafe_store" });
    expect(await readFile(external)).toEqual(bytes);
    expect((await stat(external)).nlink).toBe(2);
  });

  it("hard-kill cleanup ordering never strands canonical state", async () => {
    for (const boundary of [
      "before-binding-sync",
      "after-binding-sync",
      "after-authority-remove",
    ]) {
      const fixture = await createFixture();
      const initialized = await openMemoryLocal(options(fixture));
      await initialized.stop();
      const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
      const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
      const authorityPath = bindingAuthorityPath(bindingPath, await stat(databasePath));
      await mkdir(authorityPath, { mode: 0o700 });
      await link(databasePath, bindingPath);
      await hardKill(`
        const fs = require("node:fs");
        fs.unlinkSync(process.argv[1]);
        if (process.argv[3] === "before-binding-sync") process.kill(process.pid, "SIGKILL");
        const parent = fs.openSync(process.argv[2], "r");
        fs.fsyncSync(parent);
        fs.closeSync(parent);
        if (process.argv[3] === "after-binding-sync") process.kill(process.pid, "SIGKILL");
        fs.rmdirSync(process.argv[4]);
        process.kill(process.pid, "SIGKILL");
      `, [
        bindingPath,
        fixture.directory,
        boundary,
        authorityPath,
      ]);

      const recovered = await openMemoryLocal(options(fixture));
      await expect(recovered.audit({
        signal: new AbortController().signal,
        strict: true,
      })).resolves.toMatchObject({ status: "healthy" });
      await recovered.stop();
      expect((await stat(databasePath)).nlink).toBe(1);
    }
  });

  it("never accepts a hard-killed binding without exact inode-derived authority", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture));
    await initialized.stop();
    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const before = await readFile(databasePath);
    const bindingPath = join(fixture.directory, `.${MEMORY_LOCAL_DATABASE_FILENAME}.sqlite-binding`);
    await hardKill(`
      const fs = require("node:fs");
      fs.linkSync(process.argv[1], process.argv[2]);
      process.kill(process.pid, "SIGKILL");
    `, [databasePath, bindingPath]);

    await expect(openMemoryLocal(options(fixture)))
      .rejects.toMatchObject({ code: "unsafe_store" });
    expect(await readFile(databasePath)).toEqual(before);
    expect((await stat(databasePath)).nlink).toBe(2);
    expect((await readdir(fixture.directory)).filter((name) =>
      name.includes(".sqlite-binding.authority-"))).toEqual([]);
  });

  it("rejects non-regular and multi-link database files without repairing them", async () => {
    const directoryFixture = await createFixture();
    const initialized = await openMemoryLocal(options(directoryFixture));
    await initialized.stop();
    const databasePath = join(directoryFixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const displaced = join(directoryFixture.directory, "database-bytes");
    await rename(databasePath, displaced);
    await mkdir(databasePath, { mode: 0o700 });
    await expect(openMemoryLocal(options(directoryFixture)))
      .rejects.toMatchObject({ code: "unsafe_store" });
    expect((await stat(databasePath)).isDirectory()).toBe(true);

    const hardLinkFixture = await createFixture();
    const second = await openMemoryLocal(options(hardLinkFixture));
    await second.stop();
    const linkedDatabase = join(hardLinkFixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const externalLink = join(hardLinkFixture.root, "linked-memory.db");
    await link(linkedDatabase, externalLink);
    await expect(openMemoryLocal(options(hardLinkFixture)))
      .rejects.toMatchObject({ code: "unsafe_store" });
    expect((await stat(linkedDatabase)).nlink).toBe(2);
  });
});

function bindingAuthorityPath(
  bindingPath: string,
  database: Awaited<ReturnType<typeof stat>>,
): string {
  const digest = createHash("sha256")
    .update("mono-agent.memory-sqlite-binding.v1\0")
    .update(String(database.dev))
    .update("\0")
    .update(String(database.ino))
    .update("\0")
    .update(String(Number(database.mode) & 0o7777))
    .update("\0")
    .update(String(database.uid))
    .digest("hex");
  return `${bindingPath}.authority-${digest}`;
}

async function hardKill(script: string, args: readonly string[]): Promise<void> {
  const child = spawn(process.execPath, ["-e", script, ...args], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => {
      if (signal === "SIGKILL") resolve();
      else reject(new Error(`Expected hard-killed child, received ${String(signal)}.`));
    });
  });
}

async function createFixture(): Promise<{ readonly root: string; readonly directory: string }> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-security-"));
  const root = await realpath(authored);
  roots.push(root);
  const directory = join(root, "memory");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory };
}

function options(
  fixture: { readonly root: string; readonly directory: string },
): { readonly config: unknown; readonly configDirectory: string; readonly dataDirectory: string } {
  return {
    config: { capture: { enabled: false } },
    configDirectory: fixture.root,
    dataDirectory: fixture.directory,
  };
}

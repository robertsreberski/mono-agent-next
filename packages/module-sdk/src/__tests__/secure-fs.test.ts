// SPDX-License-Identifier: MIT
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OwnerPrivatePathError,
  atomicReplaceOwnerPrivateFile,
  createOwnerPrivateFile,
  ensureOwnerPrivateDirectory,
  inspectOwnerPrivateFile,
  readOwnerPrivateFile,
} from "../secure-fs.js";

const fsHooks = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string) => Promise<void>) | undefined,
  afterLink: undefined as ((source: string, destination: string) => Promise<void>) | undefined,
  afterRename: undefined as ((source: string, destination: string) => Promise<void>) | undefined,
  beforeUnlink: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...arguments_: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...arguments_);
      try {
        await fsHooks.afterOpen?.(String(arguments_[0]));
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
    link: async (...arguments_: Parameters<typeof actual.link>) => {
      await actual.link(...arguments_);
      await fsHooks.afterLink?.(String(arguments_[0]), String(arguments_[1]));
    },
    rename: async (...arguments_: Parameters<typeof actual.rename>) => {
      await actual.rename(...arguments_);
      await fsHooks.afterRename?.(String(arguments_[0]), String(arguments_[1]));
    },
    unlink: async (...arguments_: Parameters<typeof actual.unlink>) => {
      await fsHooks.beforeUnlink?.(String(arguments_[0]));
      await actual.unlink(...arguments_);
    },
  };
});

const roots: string[] = [];

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-sdk-fs-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

afterEach(async () => {
  fsHooks.afterOpen = undefined;
  fsHooks.afterLink = undefined;
  fsHooks.afterRename = undefined;
  fsHooks.beforeUnlink = undefined;
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("owner-private filesystem helpers", () => {
  it("creates exact owner-private paths and performs identity-checked atomic replacement", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    const path = join(directory, "agent.json");
    await ensureOwnerPrivateDirectory(directory);
    const first = await createOwnerPrivateFile(path, "one");

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(await readOwnerPrivateFile(path))).toBe("one");
    await expect(createOwnerPrivateFile(path, "clobber")).rejects.toMatchObject({
      code: "already_exists",
      committed: false,
    });

    const second = await atomicReplaceOwnerPrivateFile(path, "two", { expected: first });
    expect(second.inode).not.toBe(first.inode);
    expect(new TextDecoder().decode(await readOwnerPrivateFile(path))).toBe("two");

    await expect(atomicReplaceOwnerPrivateFile(path, "stale", { expected: first })).rejects.toMatchObject({
      code: "version_conflict",
      committed: false,
    });
    expect(new TextDecoder().decode(await readOwnerPrivateFile(path))).toBe("two");
  });

  it("fails closed on permissive pre-existing files without path chmod", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    await ensureOwnerPrivateDirectory(directory);
    const path = join(directory, "operator-data.json");
    await writeFile(path, "operator", { mode: 0o644 });
    await chmod(path, 0o644);

    await expect(inspectOwnerPrivateFile(path)).rejects.toMatchObject({ code: "wrong_mode" });
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    expect(await readFile(path, "utf8")).toBe("operator");
  });

  it("rejects symlinks and leaves their targets unchanged", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    await ensureOwnerPrivateDirectory(directory);
    const target = join(root, "target.txt");
    await writeFile(target, "protected", { mode: 0o600 });
    const link = join(directory, "state.json");
    await symlink(target, link);

    await expect(readOwnerPrivateFile(link)).rejects.toBeInstanceOf(OwnerPrivatePathError);
    await expect(atomicReplaceOwnerPrivateFile(link, "replacement")).rejects.toMatchObject({
      code: "wrong_type",
      committed: false,
    });
    expect(await readFile(target, "utf8")).toBe("protected");
  });

  it("supports no-clobber atomic creation", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    const path = join(directory, "new.json");
    await ensureOwnerPrivateDirectory(directory);

    await atomicReplaceOwnerPrivateFile(path, "created", { expected: null });
    await expect(atomicReplaceOwnerPrivateFile(path, "clobber", { expected: null })).rejects.toMatchObject({
      code: "already_exists",
      committed: false,
    });
    expect(new TextDecoder().decode(await readOwnerPrivateFile(path))).toBe("created");
  });

  it("rechecks create and replacement identities immediately before commit", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    await ensureOwnerPrivateDirectory(directory);

    const createPath = join(directory, "created.json");
    let createRaceInjected = false;
    fsHooks.afterOpen = async (openedPath) => {
      if (!createRaceInjected
        && openedPath.startsWith(join(directory, ".created.json."))
        && openedPath.endsWith(".tmp")) {
        createRaceInjected = true;
        await writeFile(createPath, "competitor", { mode: 0o600 });
      }
    };
    await expect(atomicReplaceOwnerPrivateFile(
      createPath,
      "ours",
      { expected: null },
    )).rejects.toMatchObject({
      code: "already_exists",
      committed: false,
    });
    expect(await readFile(createPath, "utf8")).toBe("competitor");

    fsHooks.afterOpen = undefined;
    const replacePath = join(directory, "replaced.json");
    const displacedPath = join(directory, "displaced.json");
    const initial = await createOwnerPrivateFile(replacePath, "initial");
    let replacementRaceInjected = false;
    fsHooks.afterOpen = async (openedPath) => {
      if (!replacementRaceInjected
        && openedPath.startsWith(join(directory, ".replaced.json."))
        && openedPath.endsWith(".tmp")) {
        replacementRaceInjected = true;
        await rename(replacePath, displacedPath);
        await writeFile(replacePath, "competitor", { mode: 0o600 });
      }
    };
    await expect(atomicReplaceOwnerPrivateFile(
      replacePath,
      "ours",
      { expected: initial },
    )).rejects.toMatchObject({
      code: "version_conflict",
      committed: false,
    });
    expect(await readFile(replacePath, "utf8")).toBe("competitor");
  });

  it("retries committed hardlink cleanup and leaves one readable target link", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    const path = join(directory, "created.json");
    await ensureOwnerPrivateDirectory(directory);

    let failedUnlinks = 0;
    fsHooks.afterLink = async (source, destination) => {
      if (destination !== path) return;
      fsHooks.beforeUnlink = async (candidate) => {
        if (candidate === source && failedUnlinks === 0) {
          failedUnlinks += 1;
          throw Object.assign(new Error("transient unlink failure"), { code: "EIO" });
        }
      };
    };

    await expect(atomicReplaceOwnerPrivateFile(
      path,
      "created",
      { expected: null },
    )).resolves.toMatchObject({ links: 1 });
    expect(failedUnlinks).toBe(1);
    expect((await lstat(path)).nlink).toBe(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(new TextDecoder().decode(await readOwnerPrivateFile(path))).toBe("created");
  });

  it("classifies post-commit durability failures as committed", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    const path = join(directory, "replaced.json");
    await ensureOwnerPrivateDirectory(directory);
    const initial = await createOwnerPrivateFile(path, "initial");

    fsHooks.afterRename = async (_source, destination) => {
      if (destination !== path) return;
      fsHooks.afterOpen = async (openedPath) => {
        if (openedPath === directory) {
          throw Object.assign(new Error("directory sync unavailable"), { code: "EIO" });
        }
      };
    };

    await expect(atomicReplaceOwnerPrivateFile(
      path,
      "committed",
      { expected: initial },
    )).rejects.toMatchObject({
      code: "io_failed",
      committed: true,
    });

    fsHooks.afterOpen = undefined;
    expect(new TextDecoder().decode(await readOwnerPrivateFile(path))).toBe("committed");
  });

  it("reads exactly the configured byte bound and rejects limit plus one", async () => {
    const root = await privateRoot();
    const directory = join(root, "state");
    await ensureOwnerPrivateDirectory(directory);
    const exactPath = join(directory, "exact.bin");
    const oversizedPath = join(directory, "oversized.bin");
    await createOwnerPrivateFile(exactPath, new Uint8Array(1024).fill(1));
    await createOwnerPrivateFile(oversizedPath, new Uint8Array(1025).fill(2));

    await expect(readOwnerPrivateFile(exactPath, { maxBytes: 1024 })).resolves.toHaveLength(1024);
    await expect(readOwnerPrivateFile(oversizedPath, { maxBytes: 1024 })).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

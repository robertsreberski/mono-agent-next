import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OwnerPrivatePathError,
  atomicReplaceOwnerPrivateFile,
  createOwnerPrivateFile,
  ensureOwnerPrivateDirectory,
  inspectOwnerPrivateFile,
  readOwnerPrivateFile,
} from "../secure-fs.js";

const roots: string[] = [];

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-sdk-fs-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

afterEach(async () => {
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

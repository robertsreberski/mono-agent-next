import {
  chmod,
  link,
  mkdir,
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

import { afterEach, describe, expect, it } from "vitest";

import {
  editLiteralFile,
  EDIT_MAX_FILE_BYTES,
} from "../edit.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runtime-pi-edit-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("literal Edit implementation", () => {
  it("replaces exact literal text and preserves non-matching metacharacters", async () => {
    const root = await workspace();
    const target = join(root, "literal.txt");
    await writeFile(target, "before a.*[x] after\n", "utf8");

    const result = await editLiteralFile(root, {
      filePath: "literal.txt",
      oldString: "a.*[x]",
      newString: "$1\\replacement",
      replaceAll: false,
    });

    expect(await readFile(target, "utf8")).toBe("before $1\\replacement after\n");
    expect(result).toMatchObject({
      path: target,
      replacements: 1,
      bytesBefore: 20,
      bytesAfter: 28,
    });
    expect(result.sha256Before).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.sha256After).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails on zero or ambiguous matches and replaces all only when explicit", async () => {
    const root = await workspace();
    const target = join(root, "matches.txt");
    await writeFile(target, "same / same / same", "utf8");

    await expect(editLiteralFile(root, {
      filePath: "matches.txt",
      oldString: "absent",
      newString: "replacement",
      replaceAll: false,
    })).rejects.toThrow("old_string was not found");
    await expect(editLiteralFile(root, {
      filePath: "matches.txt",
      oldString: "same",
      newString: "replacement",
      replaceAll: false,
    })).rejects.toThrow("old_string was found 3 times");
    expect(await readFile(target, "utf8")).toBe("same / same / same");

    await expect(editLiteralFile(root, {
      filePath: "matches.txt",
      oldString: "same",
      newString: "new",
      replaceAll: true,
    })).resolves.toMatchObject({ replacements: 3 });
    expect(await readFile(target, "utf8")).toBe("new / new / new");
  });

  it("rejects path escape, symlinks, symlinked ancestors, and hard links", async () => {
    const root = await workspace();
    const outside = await workspace();
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, "outside", "utf8");

    await expect(editLiteralFile(root, {
      filePath: outsideFile,
      oldString: "outside",
      newString: "changed",
      replaceAll: false,
    })).rejects.toThrow("within the runtime workspace");

    const linkedFile = join(root, "linked.txt");
    await symlink(outsideFile, linkedFile);
    await expect(editLiteralFile(root, {
      filePath: "linked.txt",
      oldString: "outside",
      newString: "changed",
      replaceAll: false,
    })).rejects.toThrow("symbolic link");

    const linkedDirectory = join(root, "linked-directory");
    await symlink(outside, linkedDirectory);
    await expect(editLiteralFile(root, {
      filePath: "linked-directory/outside.txt",
      oldString: "outside",
      newString: "changed",
      replaceAll: false,
    })).rejects.toThrow("symbolic link");

    const source = join(root, "hard-source.txt");
    const hardLink = join(root, "hard-link.txt");
    await writeFile(source, "source", "utf8");
    await link(source, hardLink);
    await expect(editLiteralFile(root, {
      filePath: "hard-source.txt",
      oldString: "source",
      newString: "changed",
      replaceAll: false,
    })).rejects.toThrow("exactly one hard link");
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
    expect(await readFile(source, "utf8")).toBe("source");
  });

  it("detects a target swap before atomic commit without overwriting the replacement", async () => {
    const root = await workspace();
    const target = join(root, "swap.txt");
    const original = join(root, "original.txt");
    await writeFile(target, "old value", "utf8");

    await expect(editLiteralFile(root, {
      filePath: "swap.txt",
      oldString: "old",
      newString: "new",
      replaceAll: false,
    }, {
      async beforeRename() {
        await rename(target, original);
        await writeFile(target, "attacker replacement", "utf8");
      },
    })).rejects.toThrow(/changed before commit/u);

    expect(await readFile(target, "utf8")).toBe("attacker replacement");
    expect(await readFile(original, "utf8")).toBe("old value");
  });

  it("rejects an ancestor swap before temporary creation without writing outside", async () => {
    const root = await workspace();
    const outside = await workspace();
    const sourceDirectory = join(root, "source");
    const movedDirectory = join(root, "moved-source");
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "target.txt"), "old value", "utf8");
    await writeFile(join(outside, "target.txt"), "outside value", "utf8");

    await expect(editLiteralFile(root, {
      filePath: "source/target.txt",
      oldString: "old",
      newString: "new",
      replaceAll: false,
    }, {
      async beforeTemporaryCreate() {
        await rename(sourceDirectory, movedDirectory);
        await symlink(outside, sourceDirectory);
      },
    })).rejects.toThrow("symbolic link");

    expect(await readFile(join(movedDirectory, "target.txt"), "utf8")).toBe("old value");
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside value");
    expect((await readdir(outside)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("rejects a hard-linked temporary file before commit", async () => {
    const root = await workspace();
    const target = join(root, "target.txt");
    const extraLink = join(root, "captured-temp.txt");
    await writeFile(target, "old value", "utf8");

    await expect(editLiteralFile(root, {
      filePath: "target.txt",
      oldString: "old",
      newString: "new",
      replaceAll: false,
    }, {
      async beforeCommit({ temporaryPath }) {
        await link(temporaryPath, extraLink);
      },
    })).rejects.toThrow("single-link regular file");

    expect(await readFile(target, "utf8")).toBe("old value");
  });

  it("removes an exclusive temporary file when setup fails after creation", async () => {
    const root = await workspace();
    const target = join(root, "target.txt");
    await writeFile(target, "old value", "utf8");

    await expect(editLiteralFile(root, {
      filePath: "target.txt",
      oldString: "old",
      newString: "new",
      replaceAll: false,
    }, {
      afterTemporaryCreate() {
        throw new Error("injected chmod/stat failure");
      },
    })).rejects.toThrow("injected chmod/stat failure");

    expect(await readFile(target, "utf8")).toBe("old value");
    expect((await readdir(root)).filter((entry) =>
      entry.endsWith(".mono-agent-edit.tmp"))).toEqual([]);
  });

  it("bounds invalid UTF-8 input, source files, and replacement output", async () => {
    const root = await workspace();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await expect(editLiteralFile(root, {
      filePath: "invalid.txt",
      oldString: "(",
      newString: "x",
      replaceAll: false,
    })).rejects.toThrow("not valid UTF-8");

    await writeFile(
      join(root, "too-large.txt"),
      Buffer.alloc(EDIT_MAX_FILE_BYTES + 1, 0x61),
    );
    await expect(editLiteralFile(root, {
      filePath: "too-large.txt",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    })).rejects.toThrow(`file exceeds ${String(EDIT_MAX_FILE_BYTES)} bytes`);

    await writeFile(join(root, "expands.txt"), "x".repeat(20), "utf8");
    await expect(editLiteralFile(root, {
      filePath: "expands.txt",
      oldString: "x",
      newString: "y".repeat(256 * 1024),
      replaceAll: true,
    })).rejects.toThrow(`replacement would exceed ${String(EDIT_MAX_FILE_BYTES)} bytes`);
    expect(await readFile(join(root, "expands.txt"), "utf8")).toBe("x".repeat(20));
  });
});

import { createHash } from "node:crypto";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuthorityReadError,
  decodeAuthorityText,
  readAuthorityFile,
} from "../authority-read.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authority file reads", () => {
  it("returns exact-limit bytes only after recording a stable descriptor identity", async () => {
    const root = await fixtureRoot();
    const path = join(root, "authority.json");
    const bytes = new TextEncoder().encode("x".repeat(64));
    await writeFile(path, bytes);

    const snapshot = await readAuthorityFile(path, { maxBytes: 64 });

    expect(snapshot.bytes).toEqual(bytes);
    expect(snapshot.source).toMatchObject({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: 64,
      device: expect.stringMatching(/^\d+$/u),
      inode: expect.stringMatching(/^\d+$/u),
      modifiedAtNs: expect.stringMatching(/^\d+$/u),
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.source)).toBe(true);
  });

  it("uses a max-plus-one read instead of trusting a pre-read file size", async () => {
    const root = await fixtureRoot();
    const path = join(root, "authority.json");
    await writeFile(path, "x".repeat(65));

    await expect(readAuthorityFile(path, { maxBytes: 64 })).rejects.toMatchObject({
      name: "AuthorityReadError",
      code: "too_large",
      path,
    });
  });

  it("rejects symbolic and hard-linked authority paths without returning target bytes", async () => {
    const root = await fixtureRoot();
    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    const hardLinked = join(root, "hard-linked.json");
    await writeFile(target, '{"secret":"must-not-be-returned"}\n');
    await symlink(target, linked);

    await expect(readAuthorityFile(linked)).rejects.toMatchObject({
      name: "AuthorityReadError",
      code: "wrong_type",
      path: linked,
    });

    await link(target, hardLinked);
    await expect(readAuthorityFile(hardLinked)).rejects.toMatchObject({
      name: "AuthorityReadError",
      code: "multiple_links",
      path: hardLinked,
    });
  });

  it("decodes authority text as fatal UTF-8", async () => {
    const root = await fixtureRoot();
    const path = join(root, "authority.json");
    await writeFile(path, Uint8Array.of(0xc3, 0x28));
    const snapshot = await readAuthorityFile(path);

    expect(() => decodeAuthorityText(snapshot)).toThrowError(AuthorityReadError);
    expect(() => decodeAuthorityText(snapshot)).toThrow(/valid UTF-8/u);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-authority-"));
  roots.push(root);
  return root;
}

// SPDX-License-Identifier: MIT
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const secureFsTestHooks = vi.hoisted(() => ({
  afterAtomicReplace: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("@mono-agent/module-sdk/secure-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/module-sdk/secure-fs")>();
  return {
    ...actual,
    atomicReplaceOwnerPrivateFile: async (
      ...arguments_: Parameters<typeof actual.atomicReplaceOwnerPrivateFile>
    ) => {
      const result = await actual.atomicReplaceOwnerPrivateFile(...arguments_);
      await secureFsTestHooks.afterAtomicReplace?.(arguments_[0]);
      return result;
    },
  };
});

import { PiCredentialStore, redactRuntimePiText } from "../credentials.js";

const roots: string[] = [];

afterEach(async () => {
  secureFsTestHooks.afterAtomicReplace = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(contents: unknown): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "runtime-pi-auth-"));
  roots.push(root);
  const path = join(root, "auth.json");
  await writeFile(path, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
  return { root, path };
}

async function writeAuthLock(path: string, pid: number): Promise<string> {
  const contents = `${JSON.stringify({
    owner: "@mono-agent/runtime-pi.auth-lock.v1",
    pid,
    token: "00000000-0000-4000-8000-000000000000",
  })}\n`;
  await writeFile(`${path}.lock`, contents, { mode: 0o600 });
  return contents;
}

describe("atomic Pi credential store", () => {
  it("reads and atomically persists API-key credentials", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "api-secret" } });
    const store = new PiCredentialStore(path);

    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "api-secret" });
    expect(await store.modify("anthropic", async () => ({ type: "api_key", key: "rotated-secret" })))
      .toEqual({ type: "api_key", key: "rotated-secret" });
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "rotated-secret" } });
  });

  it("accepts referenced OAuth credentials and atomically persists refresh rotation", async () => {
    const { path } = await fixture({
      "openai-codex": { type: "oauth", access: "old-access", refresh: "refresh-secret", expires: 1 },
    });
    const store = new PiCredentialStore(path);
    await expect(store.read("openai-codex")).resolves.toMatchObject({ type: "oauth", access: "old-access" });
    await store.modify("openai-codex", async (current) => ({
      ...(current as { type: "oauth"; access: string; refresh: string; expires: number }),
      access: "new-access",
      refresh: "new-refresh",
      expires: 2,
    }));
    expect(JSON.parse(await readFile(path, "utf8"))["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 2,
    });
  });

  it("requires exact 0600 files and never repairs pre-existing permissions", async () => {
    const permissive = await fixture({ anthropic: { type: "api_key", key: "secret" } });
    await chmod(permissive.path, 0o644);
    await expect(new PiCredentialStore(permissive.path).read("anthropic"))
      .rejects.toThrow("mode must be exactly 0600");
    expect((await lstat(permissive.path)).mode & 0o777).toBe(0o644);

    await chmod(permissive.path, 0o400);
    await expect(new PiCredentialStore(permissive.path).modify(
      "anthropic",
      async () => ({ type: "api_key", key: "rotated" }),
    )).rejects.toThrow("mode must be exactly 0600");
    expect((await lstat(permissive.path)).mode & 0o777).toBe(0o400);
    expect(JSON.parse(await readFile(permissive.path, "utf8")))
      .toEqual({ anthropic: { type: "api_key", key: "secret" } });
  });

  it("rejects symbolic links and multiple hard links", async () => {
    const source = await fixture({ anthropic: { type: "api_key", key: "secret" } });
    const linkRoot = await mkdtemp(join(tmpdir(), "runtime-pi-auth-link-"));
    roots.push(linkRoot);
    const linkPath = join(linkRoot, "auth.json");
    await symlink(source.path, linkPath);
    await expect(new PiCredentialStore(linkPath).read("anthropic"))
      .rejects.toThrow(/symbolic link|Unable to open/);
    expect((await readFile(source.path, "utf8"))).toContain("secret");

    const secondName = join(source.root, "auth-hardlink.json");
    await link(source.path, secondName);
    await expect(new PiCredentialStore(source.path).read("anthropic"))
      .rejects.toThrow("single-link regular file");
    expect((await lstat(source.path)).nlink).toBe(2);
  });

  it("rejects a swapped destination before commit without overwriting it", async () => {
    const { root, path } = await fixture({ anthropic: { type: "api_key", key: "old-secret" } });
    const displaced = join(root, "original-auth.json");
    const store = new PiCredentialStore(path);

    await expect(store.modify("anthropic", async () => {
      await rename(path, displaced);
      await writeFile(path, '{"adversarial":true}\n', { mode: 0o600 });
      return { type: "api_key", key: "rotated-secret" };
    })).rejects.toThrow("Atomic replacement target changed before commit");

    expect(await readFile(path, "utf8")).toBe('{"adversarial":true}\n');
    expect(JSON.parse(await readFile(displaced, "utf8")))
      .toEqual({ anthropic: { type: "api_key", key: "old-secret" } });
  });

  it("detects a post-rename symlink swap without chmodding its target", async () => {
    const { root, path } = await fixture({ anthropic: { type: "api_key", key: "old-secret" } });
    const displaced = join(root, "committed-auth.json");
    const adversarialTarget = join(root, "adversarial-target.txt");
    await writeFile(adversarialTarget, "protected\n", { mode: 0o644 });
    await chmod(adversarialTarget, 0o644);

    secureFsTestHooks.afterAtomicReplace = async (committedPath) => {
      await rename(committedPath, displaced);
      await symlink(adversarialTarget, committedPath);
    };

    await expect(new PiCredentialStore(path).modify(
      "anthropic",
      async () => ({ type: "api_key", key: "rotated-secret" }),
    )).rejects.toThrow(/symbolic link|regular file/);

    expect(await readFile(adversarialTarget, "utf8")).toBe("protected\n");
    expect((await lstat(adversarialTarget)).mode & 0o777).toBe(0o644);
    expect(JSON.parse(await readFile(displaced, "utf8")))
      .toEqual({ anthropic: { type: "api_key", key: "rotated-secret" } });
  });

  it("preserves a live owner lock and leaves prior credential bytes exact", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "old-secret" } });
    const before = await readFile(path);
    const lockContents = await writeAuthLock(path, process.pid);

    await expect(new PiCredentialStore(path).modify(
      "anthropic",
      async () => ({ type: "api_key", key: "rotated-secret" }),
    )).rejects.toThrow("locked by another process");

    expect(await readFile(path)).toEqual(before);
    expect(await readFile(`${path}.lock`, "utf8")).toBe(lockContents);
  });

  it("recovers a stable lock only after its recorded owner is proven dead", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "old-secret" } });
    const deadPid = 424_242;
    await writeAuthLock(path, deadPid);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(signal).toBe(0);
      if (pid === deadPid) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    });

    await expect(new PiCredentialStore(path).modify(
      "anthropic",
      async () => ({ type: "api_key", key: "rotated-secret" }),
    )).resolves.toEqual({ type: "api_key", key: "rotated-secret" });

    expect(JSON.parse(await readFile(path, "utf8")))
      .toEqual({ anthropic: { type: "api_key", key: "rotated-secret" } });
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed refresh results before replacing prior credential bytes", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "old-secret" } });
    const before = await readFile(path);

    await expect(new PiCredentialStore(path).modify(
      "anthropic",
      async () => ({
        type: "oauth",
        access: "new-access",
        expires: 2,
      }) as never,
    )).rejects.toThrow("invalid OAuth credential");

    expect(await readFile(path)).toEqual(before);
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized refresh results before replacing prior credential bytes", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "old-secret" } });
    const before = await readFile(path);

    await expect(new PiCredentialStore(path).modify(
      "anthropic",
      async () => ({ type: "api_key", key: "x".repeat(1_048_576) }),
    )).rejects.toThrow("exceeds 1048576 bytes");

    expect(await readFile(path)).toEqual(before);
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts configured credential values and bearer-shaped tokens", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "api-secret" } });
    const store = new PiCredentialStore(path);
    const redacted = redactRuntimePiText(
      "provider failed with api-secret and Bearer another-secret",
      await store.redactionValues(),
    );
    expect(redacted).not.toContain("api-secret");
    expect(redacted).not.toContain("another-secret");
    expect(redacted).toContain("[REDACTED]");
  });
});

import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReadOnlyPiCredentialStore, redactRuntimePiText } from "../credentials.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(contents: unknown): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "runtime-pi-auth-"));
  roots.push(root);
  const path = join(root, "auth.json");
  await writeFile(path, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
  return { root, path };
}

describe("read-only Pi credential store", () => {
  it("reads API-key credentials and keeps process-local modifications out of auth.json", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "api-secret" } });
    const store = new ReadOnlyPiCredentialStore(path);

    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "api-secret" });
    expect(await store.modify("anthropic", async (current) => current)).toEqual({ type: "api_key", key: "api-secret" });
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  });

  it("rejects OAuth credentials until refresh rotation has atomic persistence", async () => {
    const { path } = await fixture({
      "openai-codex": { type: "oauth", access: "old-access", refresh: "refresh-secret", expires: 1 },
    });
    const store = new ReadOnlyPiCredentialStore(path);
    await expect(store.read("openai-codex")).rejects.toThrow("requires atomic writable persistence");
  });

  it("fails closed on permissive files and symbolic links without repairing them", async () => {
    const permissive = await fixture({ anthropic: { type: "api_key", key: "secret" } });
    await chmod(permissive.path, 0o644);
    await expect(new ReadOnlyPiCredentialStore(permissive.path).read("anthropic"))
      .rejects.toThrow("must not grant group or other permissions");

    const linkRoot = await mkdtemp(join(tmpdir(), "runtime-pi-auth-link-"));
    roots.push(linkRoot);
    const linkPath = join(linkRoot, "auth.json");
    await symlink(permissive.path, linkPath);
    await expect(new ReadOnlyPiCredentialStore(linkPath).read("anthropic"))
      .rejects.toThrow(/symbolic link|Unable to open/);
    expect((await readFile(permissive.path, "utf8"))).toContain("secret");
  });

  it("redacts configured credential values and bearer-shaped tokens", async () => {
    const { path } = await fixture({ anthropic: { type: "api_key", key: "api-secret" } });
    const store = new ReadOnlyPiCredentialStore(path);
    const redacted = redactRuntimePiText(
      "provider failed with api-secret and Bearer another-secret",
      await store.redactionValues(),
    );
    expect(redacted).not.toContain("api-secret");
    expect(redacted).not.toContain("another-secret");
    expect(redacted).toContain("[REDACTED]");
  });
});

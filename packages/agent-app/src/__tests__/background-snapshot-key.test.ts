import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  backgroundSnapshotKeyPath,
  loadBackgroundSnapshotKey,
  loadOrCreateBackgroundSnapshotKey,
} from "../background-snapshot-key.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mono-agent-snapshot-key-"));
  roots.push(home);
  return home;
}

describe("background snapshot proof key", () => {
  it("creates one stable owner-only 256-bit key outside the agent folder", async () => {
    const home = await temporaryHome();
    const configPath = "/agents/example/mono-agent.config.json";
    const first = await loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home });
    const second = await loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home });
    const path = await backgroundSnapshotKeyPath(configPath, { homeDir: home });

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect(await readFile(path)).toEqual(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(path.startsWith(join(await realpath(home), ".mono-agent", "background-snapshot-keys"))).toBe(true);
  });

  it("never creates a replacement key on the worker load path", async () => {
    const home = await temporaryHome();
    await expect(loadBackgroundSnapshotKey("/agents/missing/mono-agent.config.json", { homeDir: home }))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(home, ".mono-agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked and malformed key files", async () => {
    const home = await temporaryHome();
    const configPath = "/agents/unsafe/mono-agent.config.json";
    const path = await backgroundSnapshotKeyPath(configPath, { homeDir: home });
    const target = join(home, "other-key");
    await writeFile(target, Buffer.alloc(32, 1), { mode: 0o600 });
    await symlink(target, path);
    await expect(loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home }))
      .rejects.toThrow(/symbolic-link|symbolic link/u);

    await rm(path);
    await writeFile(path, "too-short", { mode: 0o600 });
    await expect(loadBackgroundSnapshotKey(configPath, { homeDir: home }))
      .rejects.toThrow("is invalid");
  });

  it.skipIf(process.platform !== "darwin")("rejects a macOS ACL on the dedicated key root without modifying it", async () => {
    const home = await temporaryHome();
    const configPath = "/agents/acl/mono-agent.config.json";
    await loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home });
    const path = await backgroundSnapshotKeyPath(configPath, { homeDir: home });
    const root = dirname(path);
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", root]);
    expect(await hasMacAcl(root)).toBe(true);
    expect(await hasMacAcl(path)).toBe(false);

    await expect(loadBackgroundSnapshotKey(configPath, { homeDir: home }))
      .rejects.toThrow(/must not have an access-control list/iu);
    expect(await hasMacAcl(root)).toBe(true);
    expect(await hasMacAcl(path)).toBe(false);
  });

  it("rejects a permissive key ancestor without repairing it", async () => {
    const home = await temporaryHome();
    const configPath = "/agents/exposed-root/mono-agent.config.json";
    await loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home });
    const path = await backgroundSnapshotKeyPath(configPath, { homeDir: home });
    const root = dirname(path);
    await chmod(root, 0o755);

    await expect(loadBackgroundSnapshotKey(configPath, { homeDir: home }))
      .rejects.toThrow(/must be owner-private/iu);
    expect((await stat(root)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform !== "darwin")("rejects rather than reusing an existing key that may have leaked through an ACL", async () => {
    const home = await temporaryHome();
    const configPath = "/agents/exposed-acl/mono-agent.config.json";
    await loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home });
    const path = await backgroundSnapshotKeyPath(configPath, { homeDir: home });
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", path]);
    expect(await hasMacAcl(path)).toBe(true);

    await expect(loadBackgroundSnapshotKey(configPath, { homeDir: home }))
      .rejects.toThrow(/may have been exposed.*stop the agent.*rotate/isu);
    expect(await hasMacAcl(path)).toBe(true);
  });

  it("rejects rather than repairing an existing key with permissive mode bits", async () => {
    const home = await temporaryHome();
    const configPath = "/agents/exposed-mode/mono-agent.config.json";
    await loadOrCreateBackgroundSnapshotKey(configPath, { homeDir: home });
    const path = await backgroundSnapshotKeyPath(configPath, { homeDir: home });
    await chmod(path, 0o644);

    await expect(loadBackgroundSnapshotKey(configPath, { homeDir: home }))
      .rejects.toThrow(/may have been exposed.*stop the agent.*rotate/isu);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });
});

async function hasMacAcl(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync("/bin/ls", ["-lde", path], { encoding: "utf8" });
  const lines = String(stdout).split("\n").filter((line) => line.length > 0);
  const mode = lines[0]?.trimStart().split(/\s+/u)[0] ?? "";
  return mode.includes("+") || lines.slice(1).some((line) => /^\s*\d+:/u.test(line));
}

import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANAGED_SRT_LOCK_SHA256,
  MANAGED_SRT_MARKER,
  MANAGED_SRT_PACKAGE,
  MANAGED_SRT_TREE_SHA256,
  MANAGED_SRT_VERSION,
  ManagedSrtCorruptError,
  managedSrtInstallRoot,
  resolveSrtLaunch,
  verifyManagedSrtInstall,
} from "../sandbox-managed.js";

const lockResource = fileURLToPath(new URL("../../../agent-app/resources/srt/package-lock.json", import.meta.url));
const tempDirs: string[] = [];
const TRUSTED_NODE_INSTALL_LAYOUTS = [
  ["NVM", [".nvm", "versions", "node", "v24.15.0", "bin", "node"]],
  ["Homebrew", ["opt", "homebrew", "Cellar", "node@24", "24.15.0", "bin", "node"]],
  ["system", ["usr", "bin", "node"]],
  ["hosted toolcache", ["opt", "hostedtoolcache", "node", "24.15.0", "x64", "bin", "node"]],
] as const;

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runtime-managed-srt-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function createManagedFixture(
  cacheRoot: string,
  markerOverrides: Record<string, unknown> = {},
): Promise<{ installRoot: string; cliPath: string; actualTreeSha256: string }> {
  const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
  const cliPath = resolve(installRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js");
  const packageJsonPath = resolve(installRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "package.json");
  await mkdir(dirname(cliPath), { recursive: true, mode: 0o700 });
  let ancestor = installRoot;
  while (ancestor !== cacheRoot) {
    await chmod(ancestor, 0o700);
    ancestor = dirname(ancestor);
  }
  const lock = await readFile(lockResource);
  const cli = Buffer.from("// fixture cli\n");
  const packageJson = Buffer.from(`${JSON.stringify({ name: MANAGED_SRT_PACKAGE, version: MANAGED_SRT_VERSION })}\n`);
  await Promise.all([
    writeFile(resolve(installRoot, "package-lock.json"), lock, { mode: 0o600 }),
    writeFile(cliPath, cli, { mode: 0o600 }),
    writeFile(packageJsonPath, packageJson, { mode: 0o600 }),
  ]);
  const hash = (content: Buffer): string => createHash("sha256").update(content).digest("hex");
  const actualTreeSha256 = await hashTree(installRoot);
  await writeFile(resolve(installRoot, MANAGED_SRT_MARKER), `${JSON.stringify({
    schemaVersion: 2,
    package: MANAGED_SRT_PACKAGE,
    version: MANAGED_SRT_VERSION,
    lockSha256: MANAGED_SRT_LOCK_SHA256,
    cliSha256: hash(cli),
    packageJsonSha256: hash(packageJson),
    treeSha256: MANAGED_SRT_TREE_SHA256,
    ...markerOverrides,
  })}\n`, { mode: 0o600 });
  return { installRoot, cliPath, actualTreeSha256 };
}

async function hashTree(installRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directoryPath: string): Promise<void> {
    const directory = await opendir(directoryPath);
    const entries = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      const relativePath = relative(installRoot, path);
      if (relativePath === MANAGED_SRT_MARKER) continue;
      const entryStat = await lstat(path);
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(path);
      } else {
        hash.update(`F\0${relativePath}\0${entryStat.size}\0`);
        hash.update(await readFile(path));
      }
    }
  }
  await walk(installRoot);
  return hash.digest("hex");
}

describe("managed SRT runtime resolution", () => {
  it("pins the complete npm-ci tree independently of the install marker", async () => {
    expect(MANAGED_SRT_TREE_SHA256).toBe("a6302340f9754fbb4fab32e3bc636a6d05e389ad338a7bc6b98c71a9f3609649");
    const cacheRoot = await tempDir();
    const fixture = await createManagedFixture(cacheRoot);

    expect(fixture.actualTreeSha256).not.toBe(MANAGED_SRT_TREE_SHA256);
    await expect(verifyManagedSrtInstall(fixture.installRoot)).rejects.toThrow(/independently pinned tree hash/u);
  });

  it("rejects legacy self-signed schema-1 markers", async () => {
    const cacheRoot = await tempDir();
    const fixture = await createManagedFixture(cacheRoot);
    await writeFile(resolve(fixture.installRoot, MANAGED_SRT_MARKER), `${JSON.stringify({
      schemaVersion: 1,
      package: MANAGED_SRT_PACKAGE,
      version: MANAGED_SRT_VERSION,
      lockSha256: MANAGED_SRT_LOCK_SHA256,
      cliSha256: "0".repeat(64),
      packageJsonSha256: "0".repeat(64),
      treeSha256: fixture.actualTreeSha256,
    })}\n`, { mode: 0o600 });

    await expect(verifyManagedSrtInstall(fixture.installRoot)).rejects.toThrow(/marker identity/u);
  });

  it("honors only an absolute XDG cache root on macOS", () => {
    expect(managedSrtInstallRoot({
      platform: "darwin",
      homeDir: "/Users/example",
      env: { XDG_CACHE_HOME: "/private/cache" },
    })).toBe(resolve("/private/cache", "mono-agent", "tools", "srt", MANAGED_SRT_VERSION, MANAGED_SRT_LOCK_SHA256));
    expect(managedSrtInstallRoot({
      platform: "darwin",
      homeDir: "/Users/example",
      env: { XDG_CACHE_HOME: "relative-cache" },
    })).toBe(resolve("/Users/example/Library/Caches", "mono-agent", "tools", "srt", MANAGED_SRT_VERSION, MANAGED_SRT_LOCK_SHA256));
  });

  it("treats a modified managed CLI as corrupt instead of falling back to PATH", async () => {
    const cacheRoot = await tempDir();
    const fixture = await createManagedFixture(cacheRoot);
    await writeFile(fixture.cliPath, "// replaced\n", { mode: 0o600 });

    await expect(resolveSrtLaunch({ cacheRoot, platform: "darwin" })).rejects.toBeInstanceOf(ManagedSrtCorruptError);
  });

  it("rejects a symlink introduced into the managed cache ancestry", async () => {
    const cacheRoot = await tempDir();
    const fixture = await createManagedFixture(cacheRoot);
    const toolsRoot = resolve(cacheRoot, "mono-agent", "tools");
    const realToolsRoot = resolve(cacheRoot, "mono-agent", "tools-real");
    await rename(toolsRoot, realToolsRoot);
    await symlink("tools-real", toolsRoot);

    await expect(verifyManagedSrtInstall(fixture.installRoot)).rejects.toThrow(/not a real directory/u);
  });

  it.each(TRUSTED_NODE_INSTALL_LAYOUTS)(
    "accepts a trusted single-link %s Node launcher",
    async (_label, pathSegments) => {
      const installPrefix = await tempDir();
      const nodePath = resolve(installPrefix, ...pathSegments);
      const cliPath = resolve(installPrefix, "managed-srt", "cli.js");
      await Promise.all([
        mkdir(dirname(nodePath), { recursive: true }),
        mkdir(dirname(cliPath), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
        writeFile(cliPath, "// fixture cli\n", { mode: 0o600 }),
      ]);
      await Promise.all([chmod(nodePath, 0o700), chmod(cliPath, 0o600)]);

      const launch = await resolveSrtLaunch({ nodePath, cliPath });

      expect(launch).toMatchObject({
        command: await realpath(nodePath),
        prefixArgs: [await realpath(cliPath)],
        source: "explicit",
      });
    },
  );

  it("rejects a hard-linked Node launcher with the writable-root alias reason", async () => {
    const launchRoot = await tempDir();
    const writableRoot = await tempDir();
    const nodePath = resolve(launchRoot, "node");
    const cliPath = resolve(launchRoot, "cli.js");
    await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(cliPath, "// fixture cli\n", { mode: 0o600 });
    await chmod(nodePath, 0o700);
    await chmod(cliPath, 0o600);
    await link(nodePath, resolve(writableRoot, "node-alias"));

    await expect(resolveSrtLaunch({ nodePath, cliPath }))
      .rejects.toThrow(/Node executable has 2 hard links; expected exactly one so no writable-root alias can modify it/u);
  });

  it.each([
    ["setuid", 0o4700, /setuid or setgid privilege bits/u],
    ["non-executable", 0o600, /not executable by the current user/u],
  ] as const)("rejects a %s Node launcher", async (_label, mode, reason) => {
    const launchRoot = await tempDir();
    const nodePath = resolve(launchRoot, "node");
    const cliPath = resolve(launchRoot, "cli.js");
    await writeFile(nodePath, "fixture\n", { mode });
    await writeFile(cliPath, "// fixture cli\n", { mode: 0o600 });
    await chmod(nodePath, mode);
    await chmod(cliPath, 0o600);

    await expect(resolveSrtLaunch({ nodePath, cliPath })).rejects.toThrow(reason);
  });

  it("fails closed when the platform cannot verify Node ownership", async () => {
    const launchRoot = await tempDir();
    const nodePath = resolve(launchRoot, "node.exe");
    const cliPath = resolve(launchRoot, "cli.js");
    await writeFile(nodePath, "fixture\n", { mode: 0o700 });
    await writeFile(cliPath, "// fixture cli\n", { mode: 0o600 });

    await expect(resolveSrtLaunch({ platform: "win32", nodePath, cliPath }))
      .rejects.toThrow(/ownership cannot be verified on win32.*requires POSIX uid ownership checks/u);
  });

  it("keeps explicit and managed SRT CLI files single-link", async () => {
    const launchRoot = await tempDir();
    const aliasRoot = await tempDir();
    const nodePath = resolve(launchRoot, "node");
    const cliPath = resolve(launchRoot, "cli.js");
    await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(cliPath, "// fixture cli\n", { mode: 0o600 });
    await chmod(nodePath, 0o700);
    await chmod(cliPath, 0o600);
    await link(cliPath, resolve(aliasRoot, "cli-alias.js"));

    await expect(resolveSrtLaunch({ nodePath, cliPath }))
      .rejects.toThrow(/SRT CLI has 2 hard links; expected exactly one/u);

    const cacheRoot = await tempDir();
    const fixture = await createManagedFixture(cacheRoot);
    await link(fixture.cliPath, resolve(aliasRoot, "managed-cli-alias.js"));
    await expect(verifyManagedSrtInstall(fixture.installRoot))
      .rejects.toThrow(/SRT CLI has 2 hard links; expected exactly one/u);
  });

  it("keeps a standalone external SRT executable single-link", async () => {
    const binRoot = await tempDir();
    const aliasRoot = await tempDir();
    const commandPath = resolve(binRoot, "srt");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(commandPath, 0o700);
    await link(commandPath, resolve(aliasRoot, "srt-alias"));

    await expect(resolveSrtLaunch({ command: commandPath }))
      .rejects.toThrow(/SRT executable has 2 hard links; expected exactly one/u);
  });

  it("canonicalizes legacy PATH resolution when the managed target is absent", async () => {
    const cacheRoot = await tempDir();
    const binRoot = await tempDir();
    const commandPath = resolve(binRoot, "srt");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const launch = await resolveSrtLaunch({
      cacheRoot,
      platform: "darwin",
      env: { PATH: binRoot },
    });
    const canonicalCommandPath = await realpath(commandPath);
    expect(launch).toMatchObject({
      command: canonicalCommandPath,
      prefixArgs: [],
      source: "external",
      files: [{ path: canonicalCommandPath }],
    });
    expect(launch.command).not.toBe("srt");
  });
});

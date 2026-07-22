import { chmod, link, lstat, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  attestManagedBackgroundRuntime,
  defaultManagedBackgroundRuntimeDeps,
  ensureManagedBackgroundRuntime as ensureManagedBackgroundRuntimeImpl,
  inspectManagedRuntimeSourceIdentity,
  MANAGED_BACKGROUND_WORKER_ENV,
  sanitizeManagedBackgroundWorkerEnvironment,
  verifyManagedRuntimeLaunch,
} from "../background-runtime.js";
import type { ManagedBackgroundRuntimeDeps, ManagedRuntimeInstallInput } from "../background-runtime.js";
import type { ProcessIncarnation } from "../process-incarnation.js";

const roots: string[] = [];
const TEST_PROCESS_INCARNATION: ProcessIncarnation = {
  schema: "mono-agent.process-incarnation.v1",
  bootSessionId: "boot-current",
  processStartId: "start-current",
};

async function ensureManagedBackgroundRuntime(
  input: Parameters<typeof ensureManagedBackgroundRuntimeImpl>[0],
  deps?: Parameters<typeof ensureManagedBackgroundRuntimeImpl>[1],
) {
  if (deps !== undefined) return ensureManagedBackgroundRuntimeImpl(input, deps);
  let now = Date.now();
  const defaults = defaultManagedBackgroundRuntimeDeps();
  return ensureManagedBackgroundRuntimeImpl(input, {
    ...defaults,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
}

function incarnation(bootSessionId: string, processStartId: string): ProcessIncarnation {
  return { schema: "mono-agent.process-incarnation.v1", bootSessionId, processStartId };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("inspects source version and CLI digest without executing source bytes", async () => {
  const source = await fixturePackage("1.2.3");
  await expect(inspectManagedRuntimeSourceIdentity(source.cliPath)).resolves.toEqual({
    packageVersion: "1.2.3",
    cliSha256: createHash("sha256").update(source.bytes).digest("hex"),
  });
});

async function fixturePackage(version = "9.8.7"): Promise<{ root: string; cliPath: string; bytes: string }> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-runtime-source-"));
  roots.push(root);
  const cliPath = join(root, "dist", "cli.js");
  const bytes = "#!/usr/bin/env node\nconsole.log('managed fixture');\n";
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(cliPath, bytes, "utf8");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@mono-agent/agent-app",
    version,
    type: "module",
    bin: { "mono-agent": "./dist/cli.js" },
    files: ["dist"],
  })}\n`, "utf8");
  return { root, cliPath, bytes };
}

async function workspaceFixture(): Promise<{
  root: string;
  cliPath: string;
  dependencyPath: string;
  dependencyContents: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-runtime-workspace-"));
  roots.push(root);
  const appRoot = join(root, "packages", "agent-app");
  const dependencyRoot = join(root, "packages", "workspace-dependency");
  const cliPath = join(appRoot, "dist", "cli.js");
  const dependencyContents = "export const preserved = 'workspace-closure-preserved';\n";
  await mkdir(dirname(cliPath), { recursive: true });
  await mkdir(dependencyRoot, { recursive: true });
  await writeFile(cliPath, "import { preserved } from '@fixture/workspace-dependency';\nconsole.log(preserved);\n", "utf8");
  await writeFile(join(appRoot, "package.json"), `${JSON.stringify({
    name: "@mono-agent/agent-app",
    version: "9.8.7",
    type: "module",
    dependencies: { "@fixture/workspace-dependency": "workspace:1.0.0" },
  })}\n`, "utf8");
  await writeFile(join(dependencyRoot, "package.json"), `${JSON.stringify({
    name: "@fixture/workspace-dependency",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  })}\n`, "utf8");
  const dependencyPath = join(dependencyRoot, "index.js");
  await writeFile(dependencyPath, dependencyContents, "utf8");
  const dependencyLink = join(appRoot, "node_modules", "@fixture", "workspace-dependency");
  await mkdir(dirname(dependencyLink), { recursive: true });
  await symlink(dependencyRoot, dependencyLink, "dir");
  return { root, cliPath, dependencyPath, dependencyContents };
}

async function additionalPackageFixture(packageName = "@fixture/configured-plugin"): Promise<{
  root: string;
  entryPath: string;
  contents: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-runtime-plugin-"));
  roots.push(root);
  const entryPath = join(root, "dist", "index.js");
  const contents = "export const configuredPlugin = 'durable-plugin';\n";
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, contents, "utf8");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: packageName,
    version: "9.8.7",
    type: "module",
    exports: "./dist/index.js",
  })}\n`, "utf8");
  return { root, entryPath, contents };
}

async function homeFixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mono-agent-runtime-home-"));
  roots.push(home);
  return home;
}

describe("ensureManagedBackgroundRuntime", () => {
  it("copies an exact local package into a private immutable runtime that survives source deletion", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    expect(runtime.installRoot).toContain(join(homeDir, ".mono-agent", "runtimes", "agent-app", "9.8.7"));
    expect(runtime.cliPath).not.toContain(source.root);
    const packageRoot = dirname(dirname(runtime.cliPath));
    expect((await lstat(packageRoot)).isSymbolicLink()).toBe(false);
    expect((await lstat(runtime.installRoot)).mode & 0o077).toBe(0);
    const lock = JSON.parse(await readFile(join(runtime.installRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    expect(Object.entries(lock.packages).some(([path, value]) =>
      path.endsWith("node_modules/@mono-agent/agent-app") && value.version === "9.8.7")).toBe(true);

    await rm(source.root, { recursive: true, force: true });
    expect(await readFile(runtime.cliPath, "utf8")).toBe(source.bytes);
  }, 30_000);

  it("publishes a post-promotion launch boundary and waits past its whole-second precision", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    let now = 10_000;
    const deps: ManagedBackgroundRuntimeDeps = {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      randomId: () => "launch-boundary",
      installPackage: async (input) => {
        await materializeInstalledPackage(input, await readFile(source.cliPath));
      },
      currentProcessIncarnation: async () => TEST_PROCESS_INCARNATION,
      isSameProcessIncarnation: () => true,
    };

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps);
    const marker = JSON.parse(await readFile(join(runtime.installRoot, ".mono-agent-runtime.json"), "utf8")) as {
      installedAt: string;
    };

    expect(marker.installedAt).toBe("1970-01-01T00:00:10.000Z");
    expect(now).toBe(11_000);
  });

  it("keeps injected installer fixtures mode-faithful independently of the process umask", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    await chmod(source.root, 0o750);
    await chmod(join(source.root, "dist"), 0o751);
    await chmod(source.cliPath, 0o750);
    await chmod(join(source.root, "package.json"), 0o640);

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, fakeInstallerDeps(async (input) => {
      await materializeInstalledPackage(input, await readFile(source.cliPath));
    }));
    const packageRoot = dirname(dirname(runtime.cliPath));

    expect((await lstat(packageRoot)).mode & 0o777).toBe(0o750);
    expect((await lstat(join(packageRoot, "dist"))).mode & 0o777).toBe(0o751);
    expect((await lstat(runtime.cliPath)).mode & 0o777).toBe(0o750);
    expect((await lstat(join(packageRoot, "package.json"))).mode & 0o777).toBe(0o640);
  });

  it("publishes a path-free launch proof that verifies the exact finalized closure", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    const proofJson = Buffer.from(runtime.launchProof, "base64url").toString("utf8");
    expect(proofJson).not.toContain(homeDir);
    await expect(verifyManagedRuntimeLaunch({
      currentCliPath: runtime.cliPath,
      launchProof: runtime.launchProof,
      homeDir,
    })).resolves.toEqual({
      installRoot: runtime.installRoot,
      packageVersion: runtime.packageVersion,
      cliSha256: runtime.cliSha256,
      provenanceDetail: expect.stringContaining(`Runtime provenance: managed closure ${runtime.cliSha256}-`),
    });
  });

  it("rejects launch proof reuse after CLI or manifest corruption", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    await writeFile(runtime.cliPath, "console.log('tampered');\n", "utf8");
    await expect(verifyManagedRuntimeLaunch({
      currentCliPath: runtime.cliPath,
      launchProof: runtime.launchProof,
      homeDir,
    })).rejects.toThrow(/CLI or package identity/u);

    await writeFile(runtime.cliPath, source.bytes, "utf8");
    await writeFile(join(runtime.installRoot, ".mono-agent-closure.json"), "{}\n", { mode: 0o600 });
    await expect(verifyManagedRuntimeLaunch({
      currentCliPath: runtime.cliPath,
      launchProof: runtime.launchProof,
      homeDir,
    })).rejects.toThrow(/closure manifest fingerprint/u);
  });

  it("rejects a managed closure root replaced by a symlink after publication", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const movedRoot = `${runtime.installRoot}.moved`;
    await rename(runtime.installRoot, movedRoot);
    await symlink(movedRoot, runtime.installRoot, "dir");

    await expect(verifyManagedRuntimeLaunch({
      currentCliPath: runtime.cliPath,
      launchProof: runtime.launchProof,
      homeDir,
    })).rejects.toThrow(/not a real owner-private directory/u);
  });

  it("rejects provisional and mismatched managed runtime launch proofs", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const markerPath = join(runtime.installRoot, ".mono-agent-runtime.json");
    const originalMarker = await readFile(markerPath, "utf8");
    const marker = JSON.parse(originalMarker) as Record<string, unknown>;
    await writeFile(markerPath, `${JSON.stringify({
      ...marker,
      installedAt: "1970-01-01T00:00:00.000Z",
    }, undefined, 2)}\n`, { mode: 0o600 });

    await expect(verifyManagedRuntimeLaunch({
      currentCliPath: runtime.cliPath,
      launchProof: runtime.launchProof,
      homeDir,
    })).rejects.toThrow(/provisional or malformed/u);

    await writeFile(markerPath, originalMarker, { mode: 0o600 });
    const proof = JSON.parse(Buffer.from(runtime.launchProof, "base64url").toString("utf8")) as Record<string, unknown>;
    const mismatched = Buffer.from(JSON.stringify({ ...proof, markerSha256: "b".repeat(64) }), "utf8").toString("base64url");
    await expect(verifyManagedRuntimeLaunch({
      currentCliPath: runtime.cliPath,
      launchProof: mismatched,
      homeDir,
    })).rejects.toThrow(/does not match/u);
  });

  it("materializes a real workspace-linked dependency closure without asking npm to parse workspace ranges", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    await rm(source.root, { recursive: true, force: true });

    const managedPackageRoot = dirname(dirname(runtime.cliPath));
    const dependencyRoot = await realpath(join(
      managedPackageRoot,
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    expect(dependencyRoot.startsWith(await realpath(runtime.installRoot))).toBe(true);
    expect(await readFile(join(dependencyRoot, "index.js"), "utf8")).toBe(source.dependencyContents);
    const lock = JSON.parse(await readFile(join(runtime.installRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { name?: string; version?: string }>;
    };
    expect(Object.values(lock.packages)).toContainEqual(expect.objectContaining({
      name: "@fixture/workspace-dependency",
      version: "1.0.0",
    }));
  });

  it("binds reuse to the current dependency bytes even when CLI bytes and package version are unchanged", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const first = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    const updated = "export const preserved = 'updated-with-same-cli';\n";
    await writeFile(source.dependencyPath, updated, "utf8");
    const second = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    expect(second.installRoot).not.toBe(first.installRoot);
    const dependencyRoot = await realpath(join(
      dirname(dirname(second.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    expect(await readFile(join(dependencyRoot, "index.js"), "utf8")).toBe(updated);
    expect(await readFile(join(
      await realpath(join(dirname(dirname(first.cliPath)), "node_modules", "@fixture", "workspace-dependency")),
      "index.js",
    ), "utf8")).toBe(source.dependencyContents);
  });

  it("copies hardlinked source files into single-link managed closure files", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const externalSourceAlias = join(source.root, "external-source-alias.js");
    await link(source.dependencyPath, externalSourceAlias);

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const managedDependencyRoot = await realpath(join(
      dirname(dirname(runtime.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    const managedDependencyPath = join(managedDependencyRoot, "index.js");

    expect((await lstat(source.dependencyPath)).nlink).toBe(2);
    expect((await lstat(managedDependencyPath)).nlink).toBe(1);
    expect(await readFile(managedDependencyPath, "utf8")).toBe(source.dependencyContents);
  });

  it("read-only attestation binds the canonical cached closure to the exact deploy source", async () => {
    const source = await workspaceFixture();
    const plugin = await additionalPackageFixture();
    const homeDir = await homeFixture();
    const additionalPackages = [{ packageName: "@fixture/configured-plugin", packageSource: plugin.root }];
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
      additionalPackages,
    });

    const first = await attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
      additionalPackages,
    });
    const second = await attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
      additionalPackages,
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      schema: "mono-agent.managed-runtime-attestation.v1",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      installedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
  });

  it("rejects a promoted cache whose provisional marker was never finalized", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const markerPath = join(runtime.installRoot, ".mono-agent-runtime.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { installedAt: string };
    marker.installedAt = "1970-01-01T00:00:00.000Z";
    await writeFile(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    })).rejects.toThrow(/marker or closure manifest is invalid/u);
  });

  it("rejects a forged cache marker and manifest when cached dependency bytes differ from source", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const runtimeDependencyRoot = await realpath(join(
      dirname(dirname(runtime.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    const runtimeDependencyPath = join(runtimeDependencyRoot, "index.js");
    const tampered = "export const preserved = 'forged-cache';\n";
    await writeFile(runtimeDependencyPath, tampered, "utf8");

    const manifestPath = join(runtime.installRoot, ".mono-agent-closure.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ path: string; type: string; sha256?: string }>;
    };
    const dependencyEntry = manifest.entries.find((entry) =>
      entry.type === "file" && entry.path.endsWith("workspace-dependency-1.0.0/package/index.js"));
    expect(dependencyEntry).toBeDefined();
    dependencyEntry!.sha256 = createHash("sha256").update(tampered).digest("hex");
    const manifestContents = `${JSON.stringify(manifest, undefined, 2)}\n`;
    await writeFile(manifestPath, manifestContents, { encoding: "utf8", mode: 0o600 });
    const markerPath = join(runtime.installRoot, ".mono-agent-runtime.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { closureManifestSha256: string };
    marker.closureManifestSha256 = createHash("sha256").update(manifestContents).digest("hex");
    await writeFile(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    })).rejects.toThrow(/does not match the deploy source closure/u);
  });

  it("rejects an arbitrary cache path even when it ends in the managed CLI suffix", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: join(homeDir, ".mono-agent", "runtimes", "attacker", "node_modules", "@mono-agent", "agent-app", "dist", "cli.js"),
      homeDir,
    })).rejects.toThrow(/canonical execution-closure path/u);
  });

  it("rejects edit-and-restore source drift during attestation", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    }, {
      afterInitialCaptures: async () => {
        await writeFile(source.dependencyPath, "export const preserved = 'transient-source';\n", "utf8");
        await writeFile(source.dependencyPath, source.dependencyContents, "utf8");
      },
    })).rejects.toThrow(/deploy source execution closure changed while it was attested/u);
  });

  it("rejects edit-and-restore cached-runtime drift during attestation", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const runtimeDependencyRoot = await realpath(join(
      dirname(dirname(runtime.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    const runtimeDependencyPath = join(runtimeDependencyRoot, "index.js");

    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    }, {
      afterInitialCaptures: async () => {
        await writeFile(runtimeDependencyPath, "export const preserved = 'transient-cache';\n", "utf8");
        await writeFile(runtimeDependencyPath, source.dependencyContents, "utf8");
      },
    })).rejects.toThrow(/managed runtime execution closure changed while it was attested/u);
  });

  it("rejects a cached file changed and restored before the worker is inspected", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const runtimeDependencyRoot = await realpath(join(
      dirname(dirname(runtime.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    const runtimeDependencyPath = join(runtimeDependencyRoot, "index.js");
    await writeFile(runtimeDependencyPath, "export const preserved = 'loaded-tamper';\n", "utf8");
    await writeFile(runtimeDependencyPath, source.dependencyContents, "utf8");

    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    })).rejects.toThrow(/install-time proof/u);
  });

  it("rejects a cached dependency link replaced and restored before the worker is inspected", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const dependencyLink = join(
      dirname(dirname(runtime.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    );
    const originalTarget = await readlink(dependencyLink);
    await rm(dependencyLink);
    await symlink(originalTarget, dependencyLink, "dir");

    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    })).rejects.toThrow(/install-time proof/u);
  });

  it("rejects a runtime resolution directory swapped and restored before the worker is inspected", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const nodeModules = join(runtime.installRoot, "node_modules");
    const displaced = join(runtime.installRoot, ".node_modules-displaced");
    await rename(nodeModules, displaced);
    await mkdir(nodeModules);
    await rm(nodeModules, { recursive: true });
    await rename(displaced, nodeModules);

    await expect(attestManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      runtimeCliPath: runtime.cliPath,
      homeDir,
    })).rejects.toThrow(/install-time proof/u);
  });

  it("does not reuse a cached closure changed and restored after installation", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const first = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const runtimeDependencyRoot = await realpath(join(
      dirname(dirname(first.cliPath)),
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    const runtimeDependencyPath = join(runtimeDependencyRoot, "index.js");
    const before = await lstat(first.cliPath);
    await writeFile(runtimeDependencyPath, "export const preserved = 'transient-reuse';\n", "utf8");
    await writeFile(runtimeDependencyPath, source.dependencyContents, "utf8");

    const second = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const after = await lstat(second.cliPath);
    expect(second.installRoot).toBe(first.installRoot);
    expect(second.verificationMode).toBe("repaired");
    expect(after.ino).not.toBe(before.ino);
  });

  it("materializes and top-level-links config-selected additional packages", async () => {
    const source = await fixturePackage();
    const plugin = await additionalPackageFixture("@mono-agent/a2a-adapter");
    const supermemory = await additionalPackageFixture("@mono-agent/memory-supermemory");
    const homeDir = await homeFixture();

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
      additionalPackages: [
        { packageName: "@mono-agent/a2a-adapter", packageSource: plugin.root },
        { packageName: "@mono-agent/memory-supermemory", packageSource: supermemory.root },
      ],
    });
    await rm(source.root, { recursive: true, force: true });
    await rm(plugin.root, { recursive: true, force: true });
    await rm(supermemory.root, { recursive: true, force: true });

    const linkedPlugin = join(runtime.installRoot, "node_modules", "@mono-agent", "a2a-adapter");
    const pluginRoot = await realpath(linkedPlugin);
    expect(pluginRoot.startsWith(await realpath(runtime.installRoot))).toBe(true);
    expect(await readFile(join(pluginRoot, "dist", "index.js"), "utf8")).toBe(plugin.contents);
    const supermemoryRoot = await realpath(join(
      runtime.installRoot,
      "node_modules",
      "@mono-agent",
      "memory-supermemory",
    ));
    expect(supermemoryRoot.startsWith(await realpath(runtime.installRoot))).toBe(true);
    expect(await readFile(join(supermemoryRoot, "dist", "index.js"), "utf8")).toBe(supermemory.contents);
    const lock = JSON.parse(await readFile(join(runtime.installRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { link?: boolean }>;
    };
    expect(lock.packages["node_modules/@mono-agent/a2a-adapter"]?.link).toBe(true);
    expect(lock.packages["node_modules/@mono-agent/memory-supermemory"]?.link).toBe(true);
  });

  it("binds config-selected additional package bytes into runtime reuse identity", async () => {
    const source = await fixturePackage();
    const plugin = await additionalPackageFixture();
    const homeDir = await homeFixture();
    const input = {
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
      additionalPackages: [{ packageName: "@fixture/configured-plugin", packageSource: plugin.root }],
    } as const;

    const first = await ensureManagedBackgroundRuntime(input);
    const updated = "export const configuredPlugin = 'updated-plugin';\n";
    await writeFile(plugin.entryPath, updated, "utf8");
    const second = await ensureManagedBackgroundRuntime(input);

    expect(second.installRoot).not.toBe(first.installRoot);
    const secondPlugin = await realpath(join(
      second.installRoot,
      "node_modules",
      "@fixture",
      "configured-plugin",
    ));
    expect(await readFile(join(secondPlugin, "dist", "index.js"), "utf8")).toBe(updated);
  });

  it("rejects source-package symlinks that escape the copied package root", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const outside = await mkdtemp(join(tmpdir(), "mono-agent-runtime-outside-"));
    roots.push(outside);
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "must not be copied\n", "utf8");
    const linkPath = join(source.root, "dist", "escape.txt");
    await symlink(relative(dirname(linkPath), outsideFile), linkPath);

    await expect(ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    })).rejects.toThrow(/source symlink .* escapes its package root/u);
  });

  it("preserves a relative symlink whose target stays inside the source package", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    await symlink("cli.js", join(source.root, "dist", "cli-alias.js"));

    const runtime = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    await rm(source.root, { recursive: true, force: true });

    expect(await readFile(join(dirname(runtime.cliPath), "cli-alias.js"), "utf8")).toBe(source.bytes);
  });

  it("rejects edit-and-restore source drift while an injected installer is staging", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const deps = fakeInstallerDeps(async (input) => {
      await materializeInstalledPackage(input, await readFile(source.cliPath));
      await writeFile(source.dependencyPath, "export const preserved = 'transient';\n", "utf8");
      await writeFile(source.dependencyPath, source.dependencyContents, "utf8");
    });

    await expect(ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps)).rejects.toThrow(/package closure changed while staging/u);
  });

  it("rejects a staged closure file hardlinked outside the private runtime", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const externalAlias = join(homeDir, "external-runtime-alias.js");
    const defaults = defaultManagedBackgroundRuntimeDeps();
    const deps = fakeInstallerDeps(async (input) => {
      await defaults.installPackage(input);
      const lock = JSON.parse(await readFile(join(input.stagingDir, "package-lock.json"), "utf8")) as {
        packages: Record<string, { name?: string }>;
      };
      const dependencyRoot = Object.entries(lock.packages)
        .find(([, entry]) => entry.name === "@fixture/workspace-dependency")?.[0];
      if (dependencyRoot === undefined) throw new Error("staged dependency missing from fixture lockfile");
      await link(join(input.stagingDir, ...dependencyRoot.split("/"), "index.js"), externalAlias);
    });

    await expect(ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps)).rejects.toThrow(/must not have additional hard links/u);

    expect(await readFile(externalAlias, "utf8")).toBe(source.dependencyContents);
    const abiRoot = join(homeDir, ".mono-agent", "runtimes", "agent-app", "9.8.7");
    const descendants = await recursiveNames(abiRoot);
    expect(descendants.some((name) => name.includes(".staging-"))).toBe(false);
    expect(descendants.some((name) => name === ".mono-agent-runtime.json")).toBe(false);
  });

  it("repairs a corrupted managed runtime from itself after the disposable source has gone", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const first = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    await rm(source.root, { recursive: true, force: true });
    await writeFile(join(first.installRoot, ".mono-agent-runtime.json"), "{}\n", "utf8");

    const repaired = await ensureManagedBackgroundRuntime({
      currentCliPath: first.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    expect(await readFile(repaired.cliPath, "utf8")).toBe(source.bytes);
    const quarantineRoot = join(dirname(first.installRoot), "quarantine");
    const quarantined = await readdir(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(quarantineRoot, quarantined[0]!, ".mono-agent-runtime.json"), "utf8")).toBe("{}\n");
  });

  it("rejects and repairs a managed runtime whose copied dependency was tampered", async () => {
    const source = await workspaceFixture();
    const homeDir = await homeFixture();
    const first = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });
    const firstPackageRoot = dirname(dirname(first.cliPath));
    const firstDependencyRoot = await realpath(join(
      firstPackageRoot,
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    await writeFile(join(firstDependencyRoot, "index.js"), "export const preserved = 'tampered';\n", "utf8");

    const repaired = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    });

    const repairedPackageRoot = dirname(dirname(repaired.cliPath));
    const repairedDependencyRoot = await realpath(join(
      repairedPackageRoot,
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    expect(await readFile(join(repairedDependencyRoot, "index.js"), "utf8")).toBe(source.dependencyContents);
    const quarantineRoot = join(dirname(first.installRoot), "quarantine");
    const quarantined = await readdir(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    const quarantinedDependency = await realpath(join(
      quarantineRoot,
      quarantined[0]!,
      "node_modules",
      "@mono-agent",
      "agent-app",
      "node_modules",
      "@fixture",
      "workspace-dependency",
    ));
    expect(await readFile(join(quarantinedDependency, "index.js"), "utf8")).toContain("tampered");
  });

  it("reuses a verified runtime without running the installer again", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    let installs = 0;
    const deps = fakeInstallerDeps(async (input) => {
      installs += 1;
      await materializeInstalledPackage(input, await readFile(source.cliPath));
    });

    const first = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps);
    const second = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps);

    expect(first.verificationMode).toBe("installed");
    expect(second).toEqual({ ...first, verificationMode: "fast-reuse" });
    expect(installs).toBe(1);
  });

  it("upgrades a verified v4 marker once and then uses the warm stat proof", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const input = { currentCliPath: source.cliPath, nodePath: process.execPath, homeDir };
    const first = await ensureManagedBackgroundRuntime(input);
    const markerPath = join(first.installRoot, ".mono-agent-runtime.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    const { reuseProofSha256: _removed, ...v4Marker } = marker;
    await writeFile(markerPath, `${JSON.stringify({ ...v4Marker, schema: "mono-agent.managed-runtime.v4" }, undefined, 2)}\n`, {
      mode: 0o600,
    });

    const upgraded = await ensureManagedBackgroundRuntime(input);
    const warm = await ensureManagedBackgroundRuntime(input);
    const upgradedMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;

    expect(upgraded.verificationMode).toBe("full-reuse");
    expect(upgradedMarker.schema).toBe("mono-agent.managed-runtime.v5");
    expect(upgradedMarker.reuseProofSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(warm.verificationMode).toBe("fast-reuse");
  });

  it("falls back to full verification and republishes a tampered warm proof", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const input = { currentCliPath: source.cliPath, nodePath: process.execPath, homeDir };
    const first = await ensureManagedBackgroundRuntime(input);
    const proofPath = join(dirname(first.installRoot), ".reuse-proofs", `${basename(first.installRoot)}.json`);
    await writeFile(proofPath, "{}\n", { mode: 0o600 });

    const recovered = await ensureManagedBackgroundRuntime(input);
    const warm = await ensureManagedBackgroundRuntime(input);

    expect(recovered.installRoot).toBe(first.installRoot);
    expect(recovered.verificationMode).toBe("full-reuse");
    expect(warm.verificationMode).toBe("fast-reuse");
  });

  it("falls back to content verification after source edit-and-restore, then refreshes the warm proof", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const input = { currentCliPath: source.cliPath, nodePath: process.execPath, homeDir };
    const first = await ensureManagedBackgroundRuntime(input);
    const packageJsonPath = join(source.root, "package.json");
    const packageJson = await readFile(packageJsonPath, "utf8");
    await writeFile(packageJsonPath, `${packageJson.trimEnd()} \n`, "utf8");
    await writeFile(packageJsonPath, packageJson, "utf8");

    const recovered = await ensureManagedBackgroundRuntime(input);
    const warm = await ensureManagedBackgroundRuntime(input);

    expect(recovered.installRoot).toBe(first.installRoot);
    expect(recovered.verificationMode).toBe("full-reuse");
    expect(warm.verificationMode).toBe("fast-reuse");
  });

  it("fails closed and removes staging when installed CLI bytes do not match", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    const deps = fakeInstallerDeps(async (input) => {
      await materializeInstalledPackage(input, Buffer.from("different CLI"));
    });

    await expect(ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps)).rejects.toThrow("does not match the executing CLI SHA-256");

    const abiRoot = join(homeDir, ".mono-agent", "runtimes", "agent-app", "9.8.7");
    const descendants = await recursiveNames(abiRoot);
    expect(descendants.some((name) => name.includes(".staging-"))).toBe(false);
    expect(descendants.some((name) => name === ".mono-agent-runtime.json")).toBe(false);
  });

  it("quarantines an invalid prior root and atomically replaces it without deleting old evidence", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    let installs = 0;
    const deps = fakeInstallerDeps(async (input) => {
      installs += 1;
      await materializeInstalledPackage(input, await readFile(source.cliPath));
    });
    const first = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps);
    await writeFile(first.cliPath, "tampered", "utf8");

    const repaired = await ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, deps);

    expect(installs).toBe(2);
    expect(await readFile(repaired.cliPath, "utf8")).toBe(source.bytes);
    const quarantineRoot = join(dirname(first.installRoot), "quarantine");
    const quarantined = await readdir(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(
      quarantineRoot,
      quarantined[0]!,
      "node_modules",
      "@mono-agent",
      "agent-app",
      "dist",
      "cli.js",
    ), "utf8")).toBe("tampered");
  });

  it("does not steal an active install lock even after the stale-age threshold", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    let unblock!: () => void;
    let started!: () => void;
    const installStarted = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    const holdInstall = new Promise<void>((resolvePromise) => { unblock = resolvePromise; });
    const firstDeps = fakeInstallerDeps(async (input) => {
      started();
      await holdInstall;
      await materializeInstalledPackage(input, await readFile(source.cliPath));
    });
    const first = ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, firstDeps);
    await installStarted;
    let secondInstalls = 0;
    const secondDeps = fakeInstallerDeps(async () => { secondInstalls += 1; });

    await expect(ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, secondDeps)).rejects.toThrow("Timed out waiting for the managed runtime installation lock");
    expect(secondInstalls).toBe(0);

    unblock();
    await expect(first).resolves.toMatchObject({ packageVersion: "9.8.7" });
  });

  it("coalesces behind a shared installation that takes longer than the former 30 second wait", async () => {
    const source = await fixturePackage();
    const homeDir = await homeFixture();
    let unblock!: () => void;
    let started!: () => void;
    const installStarted = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    const holdInstall = new Promise<void>((resolvePromise) => { unblock = resolvePromise; });
    const first = ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, fakeInstallerDeps(async (input) => {
      started();
      await holdInstall;
      await materializeInstalledPackage(input, await readFile(source.cliPath));
    }));
    await installStarted;

    let elapsed = 0;
    let now = 1_000_000;
    let secondInstalls = 0;
    const secondBase = fakeInstallerDeps(async () => { secondInstalls += 1; });
    const second = ensureManagedBackgroundRuntime({
      currentCliPath: source.cliPath,
      nodePath: process.execPath,
      homeDir,
    }, {
      ...secondBase,
      now: () => now,
      sleep: async (ms) => {
        elapsed += ms;
        now += ms;
        if (elapsed >= 90_000) unblock();
        await Promise.resolve();
      },
    });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ verificationMode: "installed" }) },
      { status: "fulfilled", value: expect.objectContaining({ verificationMode: "fast-reuse" }) },
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(90_000);
    expect(secondInstalls).toBe(0);
  });

  it("repairs an install lock whose PID was reused by a different process incarnation", async () => {
    await expectRepairFromStaleRuntimeLock(incarnation("boot-current", "start-old"));
  });

  it("repairs an install lock left by a prior boot even when its PID is live again", async () => {
    await expectRepairFromStaleRuntimeLock(incarnation("boot-prior", "start-current"));
  });
});

describe("sanitizeManagedBackgroundWorkerEnvironment", () => {
  it("keeps only operational values and consumes the internal marker", () => {
    const env: Record<string, string | undefined> = {
      [MANAGED_BACKGROUND_WORKER_ENV]: "1",
      PATH: "/usr/bin",
      HOME: "/home/u",
      OPENAI_API_KEY: "secret",
      MONO_AGENT_MODEL: "hostile-override",
    };
    sanitizeManagedBackgroundWorkerEnvironment(env);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("does nothing without the internal marker", () => {
    const env = { PATH: "/usr/bin", OPENAI_API_KEY: "shell-value" };
    sanitizeManagedBackgroundWorkerEnvironment(env);
    expect(env.OPENAI_API_KEY).toBe("shell-value");
  });
});

function fakeInstallerDeps(
  installPackage: ManagedBackgroundRuntimeDeps["installPackage"],
): ManagedBackgroundRuntimeDeps {
  let now = 1_000_000;
  let id = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    randomId: () => `test-${id += 1}`,
    installPackage,
    currentProcessIncarnation: async () => TEST_PROCESS_INCARNATION,
    isSameProcessIncarnation: (_pid, expected) =>
      expected.bootSessionId === TEST_PROCESS_INCARNATION.bootSessionId
      && expected.processStartId === TEST_PROCESS_INCARNATION.processStartId,
  };
}

async function expectRepairFromStaleRuntimeLock(staleIncarnation: ProcessIncarnation): Promise<void> {
  const source = await fixturePackage();
  const homeDir = await homeFixture();
  const firstDeps = fakeInstallerDeps(async (input) => {
    await materializeInstalledPackage(input, await readFile(source.cliPath));
  });
  const first = await ensureManagedBackgroundRuntime({
    currentCliPath: source.cliPath,
    nodePath: process.execPath,
    homeDir,
  }, firstDeps);
  await writeFile(join(first.installRoot, ".mono-agent-runtime.json"), "{}\n", "utf8");

  const lockDir = join(dirname(first.installRoot), `.${basename(first.installRoot)}.lock`);
  await mkdir(lockDir, { mode: 0o700 });
  await writeFile(join(lockDir, "owner.json"), `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date(0).toISOString(),
    incarnation: staleIncarnation,
  })}\n`, { encoding: "utf8", mode: 0o600 });

  const repaired = await ensureManagedBackgroundRuntime({
    currentCliPath: source.cliPath,
    nodePath: process.execPath,
    homeDir,
  }, fakeInstallerDeps(async (input) => {
    await materializeInstalledPackage(input, await readFile(source.cliPath));
  }));

  expect(await readFile(repaired.cliPath, "utf8")).toBe(source.bytes);
  await expect(lstat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
}

async function materializeInstalledPackage(input: ManagedRuntimeInstallInput, cli: Buffer): Promise<void> {
  const packageRoot = join(input.stagingDir, "node_modules", "@mono-agent", "agent-app");
  const sourceDist = join(input.packageSource, "dist");
  const sourceCli = join(sourceDist, "cli.js");
  const sourcePackageJson = join(input.packageSource, "package.json");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await chmod(packageRoot, (await lstat(input.packageSource)).mode & 0o777);
  await chmod(join(packageRoot, "dist"), (await lstat(sourceDist)).mode & 0o777);
  await writeFile(join(packageRoot, "dist", "cli.js"), cli);
  await chmod(join(packageRoot, "dist", "cli.js"), (await lstat(sourceCli)).mode & 0o777);
  await writeFile(
    join(packageRoot, "package.json"),
    await readFile(sourcePackageJson),
  );
  await chmod(join(packageRoot, "package.json"), (await lstat(sourcePackageJson)).mode & 0o777);
  await writeFile(join(input.stagingDir, "package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/@mono-agent/agent-app": {
        name: "@mono-agent/agent-app",
        version: input.packageVersion,
      },
    },
  })}\n`, "utf8");
}

async function recursiveNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => [
      entry.name,
      ...(entry.isDirectory() ? await recursiveNames(join(path, entry.name)) : []),
    ]));
    return nested.flat();
  } catch {
    return [];
  }
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeAdapterMocks = vi.hoisted(() => ({
  createSrtSandboxEngine: vi.fn(),
}));

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  runtimeAdapterMocks.createSrtSandboxEngine.mockImplementation(actual.createSrtSandboxEngine);
  return { ...actual, createSrtSandboxEngine: runtimeAdapterMocks.createSrtSandboxEngine };
});

import {
  MANAGED_SRT_LOCK_SHA256,
  MANAGED_SRT_MARKER,
  MANAGED_SRT_PACKAGE,
  MANAGED_SRT_VERSION,
  checkSandboxRuntime,
  managedSrtInstallRoot,
  sandboxRuntimeStatus,
  setupManagedSrt,
  type ManagedSrtHooks,
  type SandboxManagerOptions,
} from "../sandbox-manager.js";
import type { ProcessIncarnation } from "../process-incarnation.js";

const resourceRoot = fileURLToPath(new URL("../../resources/srt", import.meta.url));
const tempDirs: string[] = [];
let trustedNodePath = "";
const TEST_PROCESS_INCARNATION: ProcessIncarnation = {
  schema: "mono-agent.process-incarnation.v1",
  bootSessionId: "managed-srt-test-boot",
  processStartId: "managed-srt-test-process",
};
const TRUSTED_NODE_INSTALL_LAYOUTS = [
  ["NVM", [".nvm", "versions", "node", "v24.15.0", "bin", "node"]],
  ["Homebrew", ["opt", "homebrew", "Cellar", "node@24", "24.15.0", "bin", "node"]],
  ["system", ["usr", "bin", "node"]],
  ["hosted toolcache", ["opt", "hostedtoolcache", "node", "24.15.0", "x64", "bin", "node"]],
] as const;

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "managed-srt-test-"));
  tempDirs.push(directory);
  return directory;
}

beforeEach(async () => {
  runtimeAdapterMocks.createSrtSandboxEngine.mockClear();
  const launchRoot = await tempDir();
  trustedNodePath = resolve(launchRoot, "node");
  // process.execPath permissions and hard-link count belong to the host (for
  // example, CI toolcaches), so setup tests use a test-owned trusted launcher.
  await writeFile(trustedNodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(trustedNodePath, 0o700);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeInstall(stagingRoot: string): Promise<void> {
  const packageRoot = resolve(stagingRoot, "node_modules", "@anthropic-ai", "sandbox-runtime");
  await mkdir(resolve(packageRoot, "dist"), { recursive: true });
  await writeFile(resolve(packageRoot, "dist", "cli.js"), "// fixture cli\n", { mode: 0o600 });
  await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify({
    name: MANAGED_SRT_PACKAGE,
    version: MANAGED_SRT_VERSION,
  })}\n`, { mode: 0o600 });
  await writeFile(resolve(stagingRoot, "node_modules", "fixture-dependency.js"), "export default true;\n", { mode: 0o600 });
}

async function hashFixtureTree(installRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directoryPath: string): Promise<void> {
    const directory = await opendir(directoryPath);
    const entries = [];
    for await (const entry of directory) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      const relativePath = relative(installRoot, path);
      if (relativePath === MANAGED_SRT_MARKER || relativePath === "node_modules/.package-lock.json") {
        continue;
      }
      const entryStat = await lstat(path);
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(path);
      } else if (entryStat.isFile()) {
        hash.update(`F\0${relativePath}\0${entryStat.size}\0`);
        hash.update(await readFile(path));
      } else {
        throw new Error(`Unsupported fixture entry: ${relativePath}`);
      }
    }
  }
  await walk(installRoot);
  return hash.digest("hex");
}

function options(cacheRoot: string, hooks: ManagedSrtHooks = {}): SandboxManagerOptions {
  return {
    cacheRoot,
    platform: "darwin",
    nodePath: trustedNodePath,
    externalCommand: false,
    hooks: {
      installDependencies: fakeInstall,
      expectedTreeSha256: hashFixtureTree,
      currentProcessIncarnation: async () => TEST_PROCESS_INCARNATION,
      isSameProcessIncarnation: (pid, expected) => pid === process.pid
        && expected.bootSessionId === TEST_PROCESS_INCARNATION.bootSessionId
        && expected.processStartId === TEST_PROCESS_INCARNATION.processStartId,
      ...hooks,
    },
  };
}

function installLockPath(cacheRoot: string): string {
  return resolve(dirname(managedSrtInstallRoot({ cacheRoot, platform: "darwin" })), ".install.lock");
}

function installGuardPath(cacheRoot: string): string {
  return resolve(dirname(managedSrtInstallRoot({ cacheRoot, platform: "darwin" })), ".install.guard");
}

function installLockOwner(input: {
  readonly token?: string;
  readonly pid?: number;
  readonly incarnation?: ProcessIncarnation;
} = {}) {
  return {
    schemaVersion: 2 as const,
    pid: input.pid ?? process.pid,
    uid: process.getuid?.() ?? null,
    token: input.token ?? randomUUID(),
    startedAt: new Date().toISOString(),
    incarnation: input.incarnation ?? TEST_PROCESS_INCARNATION,
  };
}

async function writeDirectoryInstallLock(
  lockPath: string,
  owner = installLockOwner(),
): Promise<void> {
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await chmod(lockPath, 0o700);
  await writeFile(resolve(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

async function settleSetups(
  setups: readonly Promise<Awaited<ReturnType<typeof setupManagedSrt>>>[],
): Promise<Awaited<ReturnType<typeof setupManagedSrt>>[]> {
  const settled = await Promise.allSettled(setups);
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof setupManagedSrt>>>).value);
}

describe("managed SRT setup", () => {
  it("installs the exact locked tree into the private content-addressed cache", async () => {
    const cacheRoot = await tempDir();

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result).toMatchObject({ installed: true, repaired: false, status: { state: "ready", source: "managed" } });
    expect(result.status.installRoot).toBe(managedSrtInstallRoot({ cacheRoot, platform: "darwin" }));
    expect(await readFile(resolve(result.status.installRoot, "package-lock.json"), "utf8"))
      .toBe(await readFile(resolve(resourceRoot, "package-lock.json"), "utf8"));
  });

  it.each(TRUSTED_NODE_INSTALL_LAYOUTS)(
    "accepts a trusted single-link %s Node launcher during setup and status",
    async (_label, pathSegments) => {
      const cacheRoot = await tempDir();
      const installPrefix = await tempDir();
      const nodePath = resolve(installPrefix, ...pathSegments);
      await mkdir(dirname(nodePath), { recursive: true });
      await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(nodePath, 0o700);

      const result = await setupManagedSrt({
        ...options(cacheRoot),
        nodePath,
        verify: false,
      });

      expect(result.status).toMatchObject({ state: "ready", source: "managed", nodePath });
      await expect(sandboxRuntimeStatus({ ...options(cacheRoot), nodePath }))
        .resolves.toMatchObject({ state: "ready", source: "managed", nodePath });
    },
  );

  it("rejects a hard-linked current-user Node launcher before creating managed cache state", async () => {
    const cacheRoot = await tempDir();
    const launchRoot = await tempDir();
    const writableRoot = await tempDir();
    const nodePath = resolve(launchRoot, ".nvm", "versions", "node", "v24.15.0", "bin", "node");
    const writableAlias = resolve(writableRoot, "node-alias");
    await mkdir(dirname(nodePath), { recursive: true });
    await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(nodePath, 0o700);
    await link(nodePath, writableAlias);
    expect((await lstat(nodePath)).nlink).toBe(2);

    await expect(setupManagedSrt({
      ...options(cacheRoot),
      nodePath,
      verify: false,
    })).rejects.toMatchObject({
      code: "managed_srt_corrupt",
      details: { cause: expect.stringContaining("no writable-root alias can modify it") },
    });
    expect(existsSync(resolve(cacheRoot, "mono-agent"))).toBe(false);
  });

  it("rejects a group-writable Node executable before creating managed cache state", async () => {
    const cacheRoot = await tempDir();
    const unsafeRoot = await tempDir();
    const unsafeNodePath = resolve(unsafeRoot, "node");
    await writeFile(unsafeNodePath, "#!/bin/sh\nexit 0\n", { mode: 0o770 });
    await chmod(unsafeNodePath, 0o770);

    await expect(setupManagedSrt({
      ...options(cacheRoot),
      nodePath: unsafeNodePath,
      verify: false,
    })).rejects.toMatchObject({
      code: "managed_srt_corrupt",
      details: { cause: expect.stringContaining("writable by group or other users") },
    });
    expect(existsSync(resolve(cacheRoot, "mono-agent"))).toBe(false);
  });

  it.each([
    ["setuid", 0o4700, "setuid or setgid privilege bits"],
    ["non-executable", 0o600, "not executable by the current user"],
  ] as const)("rejects a %s Node launcher before creating managed cache state", async (_label, mode, reason) => {
    const cacheRoot = await tempDir();
    const launchRoot = await tempDir();
    const nodePath = resolve(launchRoot, "node");
    await writeFile(nodePath, "fixture\n", { mode });
    await chmod(nodePath, mode);

    await expect(setupManagedSrt({
      ...options(cacheRoot),
      nodePath,
      verify: false,
    })).rejects.toMatchObject({
      code: "managed_srt_corrupt",
      details: { cause: expect.stringContaining(reason) },
    });
    expect(existsSync(resolve(cacheRoot, "mono-agent"))).toBe(false);
  });

  it("serializes concurrent installers and performs one dependency installation", async () => {
    const cacheRoot = await tempDir();
    let installs = 0;
    const hooks: ManagedSrtHooks = {
      async installDependencies(stagingRoot) {
        installs += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        await fakeInstall(stagingRoot);
      },
    };

    const results = await settleSetups([
      setupManagedSrt({ ...options(cacheRoot, hooks), verify: false }),
      setupManagedSrt({ ...options(cacheRoot, hooks), verify: false }),
      setupManagedSrt({ ...options(cacheRoot, hooks), verify: false }),
    ]);

    expect(installs).toBe(1);
    expect(results.every((result) => result.status.state === "ready")).toBe(true);
    expect(results.filter((result) => result.installed)).toHaveLength(1);
  });

  it("keeps the real OS guard locked after its helper exits until the holder handle closes", async () => {
    const cacheRoot = await tempDir();
    let guardHeldResolve!: () => void;
    const guardHeld = new Promise<void>((resolvePromise) => { guardHeldResolve = resolvePromise; });
    let closeHolderResolve!: () => void;
    const closeHolder = new Promise<void>((resolvePromise) => { closeHolderResolve = resolvePromise; });
    const holder = setupManagedSrt({
      ...options(cacheRoot, {
        async afterInstallGuardAcquired() {
          guardHeldResolve();
          await closeHolder;
        },
      }),
      verify: false,
    });
    await guardHeld;

    const [contenderOutcome] = await Promise.allSettled([
      setupManagedSrt({
        ...options(cacheRoot, { installGuardTimeoutMs: 0 }),
        verify: false,
      }),
    ]);
    closeHolderResolve();
    const [holderOutcome] = await Promise.allSettled([holder]);

    expect(contenderOutcome).toMatchObject({
      status: "rejected",
      reason: {
        code: "managed_srt_lock_unsafe",
        message: expect.stringContaining("Timed out waiting 0 milliseconds"),
      },
    });
    expect(holderOutcome).toMatchObject({ status: "fulfilled", value: { status: { state: "ready" } } });
    await expect(setupManagedSrt({ ...options(cacheRoot), verify: false }))
      .resolves.toMatchObject({ status: { state: "ready" } });
    const guard = await lstat(installGuardPath(cacheRoot));
    expect(guard.isFile()).toBe(true);
    expect(guard.nlink).toBe(1);
    expect(guard.mode & 0o077).toBe(0);
  });

  it("holds the OS guard across a paused post-mkdir publication and drains every contender", async () => {
    const cacheRoot = await tempDir();
    let createdResolve!: () => void;
    const created = new Promise<void>((resolvePromise) => { createdResolve = resolvePromise; });
    let secondAttemptResolve!: () => void;
    const secondAttempt = new Promise<void>((resolvePromise) => { secondAttemptResolve = resolvePromise; });
    let publishResolve!: () => void;
    const allowPublish = new Promise<void>((resolvePromise) => { publishResolve = resolvePromise; });
    let pauseFirstCreator = true;
    let installs = 0;
    let guardAttempts = 0;
    let guardAcquisitions = 0;
    let lockInspections = 0;
    const hooks: ManagedSrtHooks = {
      async beforeInstallGuardAcquire() {
        guardAttempts += 1;
        if (guardAttempts === 2) secondAttemptResolve();
      },
      async afterInstallGuardAcquired() {
        guardAcquisitions += 1;
      },
      async afterInstallLockDirectoryCreated() {
        if (!pauseFirstCreator) return;
        pauseFirstCreator = false;
        createdResolve();
        await allowPublish;
      },
      async afterInstallLockInspected() {
        lockInspections += 1;
      },
      async installDependencies(stagingRoot) {
        installs += 1;
        await fakeInstall(stagingRoot);
      },
    };

    const first = setupManagedSrt({ ...options(cacheRoot, hooks), verify: false });
    await created;
    const second = setupManagedSrt({ ...options(cacheRoot, hooks), verify: false });
    await secondAttempt;
    const installsBeforePublish = installs;
    const guardAcquisitionsBeforePublish = guardAcquisitions;
    publishResolve();

    const results = await settleSetups([first, second]);
    expect(installsBeforePublish).toBe(0);
    expect(guardAcquisitionsBeforePublish).toBe(1);
    expect(guardAcquisitions).toBe(2);
    expect(lockInspections).toBe(0);
    expect(installs).toBe(1);
    expect(results.every((result) => result.status.state === "ready")).toBe(true);
    expect((await readdir(dirname(managedSrtInstallRoot({ cacheRoot, platform: "darwin" }))))
      .filter((name) => name.startsWith(".install.lock"))).toEqual([]);
  });

  it("recovers an ownerless directory only after the five-minute crash grace", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await chmod(dirname(lockPath), 0o700);
    const stale = new Date(Date.now() - 6 * 60_000);
    await utimes(lockPath, stale, stale);

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result.status.state).toBe("ready");
    expect((await readdir(dirname(lockPath))).filter((name) => name.startsWith(".install.lock"))).toEqual([]);
  });

  it("does not steal a fresh ownerless directory during the 150-second acquisition wait", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await chmod(dirname(lockPath), 0o700);
    let now = (await lstat(lockPath)).mtimeMs;

    await expect(setupManagedSrt({
      ...options(cacheRoot, {
        now: () => now,
        sleep: async () => { now += 150_001; },
      }),
      verify: false,
    })).rejects.toMatchObject({
      code: "managed_srt_lock_unsafe",
      message: expect.stringContaining("fresh ownerless"),
    });
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
  });

  it("recovers a v2 lock when the PID belongs to a different process incarnation", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    await writeDirectoryInstallLock(lockPath, installLockOwner({
      incarnation: {
        schema: "mono-agent.process-incarnation.v1",
        bootSessionId: TEST_PROCESS_INCARNATION.bootSessionId,
        processStartId: "prior-use-of-the-same-pid",
      },
    }));

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result.status.state).toBe("ready");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps a contender outside inspection until the owner finishes install and release", async () => {
    const cacheRoot = await tempDir();
    let installStartedResolve!: () => void;
    const installStarted = new Promise<void>((resolvePromise) => { installStartedResolve = resolvePromise; });
    let finishInstallResolve!: () => void;
    const finishInstall = new Promise<void>((resolvePromise) => { finishInstallResolve = resolvePromise; });
    let secondAttemptResolve!: () => void;
    const secondAttempt = new Promise<void>((resolvePromise) => { secondAttemptResolve = resolvePromise; });
    let guardAttempts = 0;
    let guardAcquisitions = 0;
    let lockInspections = 0;
    let installs = 0;
    const hooks: ManagedSrtHooks = {
      async beforeInstallGuardAcquire() {
        guardAttempts += 1;
        if (guardAttempts === 2) secondAttemptResolve();
      },
      async afterInstallGuardAcquired() {
        guardAcquisitions += 1;
      },
      async installDependencies(stagingRoot) {
        installs += 1;
        installStartedResolve();
        await finishInstall;
        await fakeInstall(stagingRoot);
      },
      async afterInstallLockInspected() {
        lockInspections += 1;
      },
    };

    const owner = setupManagedSrt({ ...options(cacheRoot, hooks), verify: false });
    await installStarted;
    const contender = setupManagedSrt({ ...options(cacheRoot, hooks), verify: false });
    await secondAttempt;
    const acquisitionsWhileOwnerActive = guardAcquisitions;
    finishInstallResolve();
    const [ownerOutcome, contenderOutcome] = await Promise.allSettled([owner, contender]);

    expect(ownerOutcome).toMatchObject({ status: "fulfilled", value: { status: { state: "ready" } } });
    expect(contenderOutcome).toMatchObject({ status: "fulfilled", value: { status: { state: "ready" } } });
    expect(acquisitionsWhileOwnerActive).toBe(1);
    expect(guardAcquisitions).toBe(2);
    expect(lockInspections).toBe(0);
    expect(installs).toBe(1);
    expect(existsSync(installLockPath(cacheRoot))).toBe(false);
  });

  it("cleans staging and its owned lock when installation is interrupted", async () => {
    const cacheRoot = await tempDir();
    const controller = new AbortController();
    let entered = false;
    const install = setupManagedSrt({
      ...options(cacheRoot, {
        async installDependencies(_stagingRoot, signal) {
          entered = true;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
      verify: false,
      signal: controller.signal,
    });
    while (!entered) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    controller.abort(new Error("test interruption"));

    await expect(install).rejects.toMatchObject({ code: "managed_srt_install_failed" });
    const versionRoot = dirname(managedSrtInstallRoot({ cacheRoot, platform: "darwin" }));
    expect((await readdir(versionRoot)).filter((name) => name.includes("staging") || name === ".install.lock")).toEqual([]);
  });

  it("aggregates the primary install, install-lock release, and guard-close failures", async () => {
    const cacheRoot = await tempDir();
    let caught: unknown;
    try {
      await setupManagedSrt({
        ...options(cacheRoot, {
          async installDependencies() {
            throw new Error("dependency installation exploded");
          },
          async beforeInstallLockReleaseRename() {
            throw new Error("install lock release exploded");
          },
          async beforeInstallGuardClose() {
            throw new Error("install guard close exploded");
          },
        }),
        verify: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).message).toContain("dependency installation exploded");
    expect((caught as AggregateError).message).toContain("install lock release exploded");
    expect((caught as AggregateError).message).toContain("install guard close exploded");
    const failures = (caught as AggregateError).errors as unknown[];
    expect(failures).toHaveLength(3);
    expect(failures.map((error) => error instanceof Error ? error.message : String(error))).toEqual([
      expect.stringContaining("dependency installation exploded"),
      "install lock release exploded",
      "install guard close exploded",
    ]);
  });

  it("preserves both the primary install failure and a staging-cleanup failure", async () => {
    const cacheRoot = await tempDir();
    let caught: unknown;
    try {
      await setupManagedSrt({
        ...options(cacheRoot, {
          async installDependencies() {
            throw new Error("primary install failure");
          },
          async beforeInstallStagingCleanup() {
            throw new Error("staging cleanup failure");
          },
        }),
        verify: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).message).toContain("primary install failure");
    expect((caught as AggregateError).message).toContain("staging cleanup failure");
    expect((caught as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("primary install failure") }),
      expect.objectContaining({ message: "staging cleanup failure" }),
    ]);
  });

  it("rejects a modified bundled lock before starting installation", async () => {
    const cacheRoot = await tempDir();
    const resources = await tempDir();
    await Promise.all([
      copyFile(resolve(resourceRoot, "package.json"), resolve(resources, "package.json")),
      copyFile(resolve(resourceRoot, "package-lock.json"), resolve(resources, "package-lock.json")),
    ]);
    await writeFile(resolve(resources, "package-lock.json"), "{}\n");

    await expect(setupManagedSrt({
      ...options(cacheRoot),
      resourceRoot: resources,
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_corrupt" });
    expect(existsSync(resolve(cacheRoot, "mono-agent"))).toBe(false);
  });

  it("quarantines a target symlink without touching its destination, then repairs", async () => {
    const cacheRoot = await tempDir();
    const outside = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    await mkdir(dirname(installRoot), { recursive: true, mode: 0o700 });
    await chmod(dirname(installRoot), 0o700);
    await symlink(outside, installRoot);

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result).toMatchObject({ installed: true, repaired: true, status: { state: "ready" } });
    expect(existsSync(outside)).toBe(true);
    expect((await readdir(dirname(installRoot))).some((name) => name.includes(".corrupt."))).toBe(true);
  });

  it("rejects a symlinked managed cache ancestor", async () => {
    const cacheRoot = await tempDir();
    const outside = await tempDir();
    await symlink(outside, resolve(cacheRoot, "mono-agent"));

    await expect(setupManagedSrt({ ...options(cacheRoot), verify: false })).rejects.toThrow(/owner-only directory|symbolic/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("marks post-install CLI corruption and never falls through to external SRT", async () => {
    const cacheRoot = await tempDir();
    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await writeFile(result.status.cliPath as string, "// corrupt\n", { mode: 0o600 });

    const status = await sandboxRuntimeStatus({
      ...options(cacheRoot),
      externalCommand: "/bin/true",
    });

    expect(status).toMatchObject({ state: "corrupt", source: "managed" });
  });

  it("detects corruption anywhere in the installed dependency tree", async () => {
    const cacheRoot = await tempDir();
    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await writeFile(resolve(result.status.installRoot, "node_modules", "fixture-dependency.js"), "export default false;\n", { mode: 0o600 });

    await expect(sandboxRuntimeStatus(options(cacheRoot)))
      .resolves.toMatchObject({ state: "corrupt", source: "managed" });
  });

  it("uses the managed absolute path with a launchd-minimal PATH", async () => {
    const cacheRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });

    const status = await sandboxRuntimeStatus({
      ...options(cacheRoot),
      env: { PATH: "/usr/bin:/bin" },
      externalCommand: false,
    });

    expect(status).toMatchObject({ state: "ready", source: "managed", nodePath: trustedNodePath });
    expect(status.cliPath).toMatch(/node_modules\/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/u);
  });

  it("reports managed status as corrupt if its selected Node launcher loses trust", async () => {
    const cacheRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await chmod(trustedNodePath, 0o770);

    await expect(sandboxRuntimeStatus(options(cacheRoot))).resolves.toMatchObject({
      state: "corrupt",
      source: "managed",
      message: expect.stringContaining("writable by group or other users"),
    });
  });

  it("reports managed status as corrupt if its selected Node launcher gains a hardlink alias", async () => {
    const cacheRoot = await tempDir();
    const writableRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await link(trustedNodePath, resolve(writableRoot, "node-alias"));

    await expect(sandboxRuntimeStatus(options(cacheRoot))).resolves.toMatchObject({
      state: "corrupt",
      source: "managed",
      message: expect.stringContaining("no writable-root alias can modify it"),
    });
  });

  it("functionally checks the same trusted Node path reported by managed status", async () => {
    const cacheRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });
    runtimeAdapterMocks.createSrtSandboxEngine.mockReturnValueOnce({
      id: "srt",
      async isAvailable() {
        return false;
      },
      async prepareCommand() {
        throw new Error("unavailable engine must not prepare a command");
      },
    });

    await expect(checkSandboxRuntime(options(cacheRoot)))
      .rejects.toMatchObject({ code: "sandbox_check_failed" });
    expect(runtimeAdapterMocks.createSrtSandboxEngine).toHaveBeenCalledWith(expect.objectContaining({
      cacheRoot,
      managedNodePath: trustedNodePath,
      platform: "darwin",
    }));
  });

  it("removes only a proven-dead secure install lock before retrying", async () => {
    const cacheRoot = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    const versionRoot = dirname(installRoot);
    await mkdir(versionRoot, { recursive: true, mode: 0o700 });
    await chmod(versionRoot, 0o700);
    await writeFile(resolve(versionRoot, ".install.lock"), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999,
      uid: process.getuid?.() ?? null,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const result = await setupManagedSrt({
      ...options(cacheRoot, { processIsAlive: () => "dead" }),
      verify: false,
    });

    expect(result.status.state).toBe("ready");
    expect(existsSync(resolve(versionRoot, ".install.lock"))).toBe(false);
  });

  it("waits through a legacy create-before-write publication instead of parsing an empty file", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(lockPath), 0o700);
    await writeFile(lockPath, "", { mode: 0o600 });
    const legacy = {
      schemaVersion: 1,
      pid: process.pid,
      uid: process.getuid?.() ?? null,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    let sleeps = 0;

    const result = await setupManagedSrt({
      ...options(cacheRoot, {
        processIsAlive: () => "alive",
        async sleep() {
          sleeps += 1;
          if (sleeps === 1) {
            await writeFile(lockPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
          } else {
            await rm(lockPath, { force: true });
          }
        },
      }),
      verify: false,
    });

    expect(result.status.state).toBe("ready");
    expect(sleeps).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("never steals a legacy lock whose old writer did not publish its final newline", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(lockPath), 0o700);
    const partial = `{"schemaVersion":1,"pid":${process.pid}`;
    await writeFile(lockPath, partial, { mode: 0o600 });
    let now = 10_000;

    await expect(setupManagedSrt({
      ...options(cacheRoot, {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds + 150_000; },
      }),
      verify: false,
    })).rejects.toMatchObject({
      code: "managed_srt_lock_unsafe",
      message: expect.stringContaining("did not finish publishing"),
    });
    expect(await readFile(lockPath, "utf8")).toBe(partial);
  });

  it("rejects an oversized lock owner record before JSON parsing", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await chmod(dirname(lockPath), 0o700);
    await writeFile(resolve(lockPath, "owner.json"), `${"x".repeat(4 * 1024 + 1)}\n`, { mode: 0o600 });

    await expect(setupManagedSrt({ ...options(cacheRoot), verify: false })).rejects.toMatchObject({
      code: "managed_srt_lock_unsafe",
      message: expect.stringContaining("exceeds 4096 bytes"),
    });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("leaves permissive, hard-linked, and malformed completed legacy locks untouched", async () => {
    const fixtures: Array<{
      readonly label: string;
      readonly arrange: (lockPath: string) => Promise<void>;
    }> = [
      {
        label: "group-writable legacy file",
        async arrange(lockPath) {
          await writeFile(lockPath, `${JSON.stringify({
            schemaVersion: 1,
            pid: 999_999,
            uid: process.getuid?.() ?? null,
            token: randomUUID(),
            startedAt: new Date().toISOString(),
          })}\n`, { mode: 0o600 });
          await chmod(lockPath, 0o660);
        },
      },
      {
        label: "hard-linked legacy file",
        async arrange(lockPath) {
          await writeFile(lockPath, `${JSON.stringify({
            schemaVersion: 1,
            pid: 999_999,
            uid: process.getuid?.() ?? null,
            token: randomUUID(),
            startedAt: new Date().toISOString(),
          })}\n`, { mode: 0o600 });
          await link(lockPath, `${lockPath}.copy`);
        },
      },
      {
        label: "malformed completed legacy file",
        async arrange(lockPath) {
          await writeFile(lockPath, "not-json\n", { mode: 0o600 });
        },
      },
    ];

    for (const fixture of fixtures) {
      const cacheRoot = await tempDir();
      const lockPath = installLockPath(cacheRoot);
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(lockPath), 0o700);
      await fixture.arrange(lockPath);
      await expect(
        setupManagedSrt({ ...options(cacheRoot), verify: false }),
        fixture.label,
      ).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });
      expect(existsSync(lockPath), fixture.label).toBe(true);
    }
  });

  it("keeps a replacement v2 lock at the fixed path when stale quarantine loses the race", async () => {
    const cacheRoot = await tempDir();
    const lockPath = installLockPath(cacheRoot);
    const staleOwner = installLockOwner({
      incarnation: {
        schema: "mono-agent.process-incarnation.v1",
        bootSessionId: TEST_PROCESS_INCARNATION.bootSessionId,
        processStartId: "stale-process",
      },
    });
    const replacementOwner = installLockOwner();
    await writeDirectoryInstallLock(lockPath, staleOwner);
    let replaced = false;

    await expect(setupManagedSrt({
      ...options(cacheRoot, {
        async beforeStaleInstallLockRename(path) {
          if (replaced) return;
          replaced = true;
          await rm(path, { recursive: true, force: true });
          await writeDirectoryInstallLock(path, replacementOwner);
        },
      }),
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });

    expect(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8"))).toMatchObject({
      token: replacementOwner.token,
    });
  });

  it("keeps a replacement v2 lock at the fixed path when release loses the race", async () => {
    const cacheRoot = await tempDir();
    const replacementOwner = installLockOwner();
    let replaced = false;

    await expect(setupManagedSrt({
      ...options(cacheRoot, {
        async beforeInstallLockReleaseRename(path) {
          if (replaced) return;
          replaced = true;
          await rm(path, { recursive: true, force: true });
          await writeDirectoryInstallLock(path, replacementOwner);
        },
      }),
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });

    const lockPath = installLockPath(cacheRoot);
    expect(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8"))).toMatchObject({
      token: replacementOwner.token,
    });
  });

  it("rejects symlink, permissive-mode, hard-linked, and malformed v2 lock state", async () => {
    const fixtures: Array<{
      readonly label: string;
      readonly arrange: (cacheRoot: string, lockPath: string) => Promise<void>;
    }> = [
      {
        label: "symlinked lock path",
        async arrange(_cacheRoot, lockPath) {
          const outside = await tempDir();
          await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
          await chmod(dirname(lockPath), 0o700);
          await symlink(outside, lockPath);
        },
      },
      {
        label: "group-writable lock directory",
        async arrange(_cacheRoot, lockPath) {
          await writeDirectoryInstallLock(lockPath);
          await chmod(lockPath, 0o770);
        },
      },
      {
        label: "hard-linked owner record",
        async arrange(_cacheRoot, lockPath) {
          await writeDirectoryInstallLock(lockPath);
          await link(resolve(lockPath, "owner.json"), resolve(lockPath, "owner-copy.json"));
        },
      },
      {
        label: "malformed atomically published owner",
        async arrange(_cacheRoot, lockPath) {
          await mkdir(lockPath, { recursive: true, mode: 0o700 });
          await chmod(dirname(lockPath), 0o700);
          await writeFile(resolve(lockPath, "owner.json"), "{}\n", { mode: 0o600 });
        },
      },
    ];

    for (const fixture of fixtures) {
      const cacheRoot = await tempDir();
      const lockPath = installLockPath(cacheRoot);
      await fixture.arrange(cacheRoot, lockPath);
      await expect(
        setupManagedSrt({ ...options(cacheRoot), verify: false }),
        fixture.label,
      ).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });
      expect(existsSync(lockPath), fixture.label).toBe(true);
    }
  });

  it("leaves symlinked, permissive, and hard-linked permanent guards untouched", async () => {
    const fixtures: Array<{
      readonly label: string;
      readonly arrange: (guardPath: string) => Promise<void>;
    }> = [
      {
        label: "symlinked guard",
        async arrange(guardPath) {
          const outside = await tempDir();
          const target = resolve(outside, "guard-target");
          await writeFile(target, "", { mode: 0o600 });
          await symlink(target, guardPath);
        },
      },
      {
        label: "group-writable guard",
        async arrange(guardPath) {
          await writeFile(guardPath, "", { mode: 0o600 });
          await chmod(guardPath, 0o660);
        },
      },
      {
        label: "hard-linked guard",
        async arrange(guardPath) {
          await writeFile(guardPath, "", { mode: 0o600 });
          await link(guardPath, `${guardPath}.copy`);
        },
      },
    ];

    for (const fixture of fixtures) {
      const cacheRoot = await tempDir();
      const guardPath = installGuardPath(cacheRoot);
      await mkdir(dirname(guardPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(guardPath), 0o700);
      await fixture.arrange(guardPath);
      await expect(
        setupManagedSrt({ ...options(cacheRoot), verify: false }),
        fixture.label,
      ).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });
      expect(existsSync(guardPath), fixture.label).toBe(true);
    }
  });

  it("cleans a private staging directory left by a crashed installer after taking the lock", async () => {
    const cacheRoot = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    const versionRoot = dirname(installRoot);
    const staleStaging = resolve(versionRoot, `.${MANAGED_SRT_LOCK_SHA256}.staging.999999.${randomUUID()}`);
    await mkdir(staleStaging, { recursive: true, mode: 0o700 });
    await chmod(versionRoot, 0o700);
    await writeFile(resolve(staleStaging, "partial"), "partial", { mode: 0o600 });

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result.status.state).toBe("ready");
    expect(existsSync(staleStaging)).toBe(false);
  });

  it("leaves a stale lock untouched if its identity changes during the quarantine race", async () => {
    const cacheRoot = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    const versionRoot = dirname(installRoot);
    const lockPath = resolve(versionRoot, ".install.lock");
    await mkdir(versionRoot, { recursive: true, mode: 0o700 });
    await chmod(versionRoot, 0o700);
    const initial = {
      schemaVersion: 1,
      pid: 999_998,
      uid: process.getuid?.() ?? null,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(initial)}\n`, { mode: 0o600 });

    await expect(setupManagedSrt({
      ...options(cacheRoot, {
        processIsAlive() {
          writeFileSync(lockPath, `${JSON.stringify({ ...initial, token: randomUUID() })}\n`, { mode: 0o600 });
          return "dead";
        },
      }),
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("returns an actionable unsupported result without system automation off macOS", async () => {
    const cacheRoot = await tempDir();

    await expect(setupManagedSrt({
      cacheRoot,
      platform: "linux",
      externalCommand: false,
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_unsupported" });
    await expect(sandboxRuntimeStatus({ cacheRoot, platform: "linux", externalCommand: false }))
      .resolves.toMatchObject({ state: "unsupported", source: "none" });
  });

  it("keeps the resource lock identity stable", async () => {
    const lock = await readFile(resolve(resourceRoot, "package-lock.json"));
    expect(createHash("sha256").update(lock).digest("hex")).toBe(MANAGED_SRT_LOCK_SHA256);
  });
});

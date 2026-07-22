import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireBackgroundWorkerLease,
  backgroundWorkerLeasePath,
} from "../background-worker-lease.js";
import type { ProcessIncarnation } from "../process-incarnation.js";

const homes: string[] = [];
const CONFIG = "/work/lease-smoke/mono-agent.config.json";

function incarnation(bootSessionId: string, processStartId: string): ProcessIncarnation {
  return {
    schema: "mono-agent.process-incarnation.v1",
    bootSessionId,
    processStartId,
  };
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mono-agent-worker-lease-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async (home) => {
    await rm(home, { recursive: true, force: true });
  }));
});

describe("background worker lifetime lease", () => {
  it("derives the production lease root from the OS account rather than ambient HOME", () => {
    const originalHome = process.env.HOME;
    try {
      const before = backgroundWorkerLeasePath(CONFIG);
      process.env.HOME = "/tmp/ambient-home-must-not-select-worker-lease";
      expect(backgroundWorkerLeasePath(CONFIG)).toBe(before);
      expect(backgroundWorkerLeasePath(CONFIG)).not.toContain("ambient-home-must-not-select-worker-lease");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("holds one config for the worker lifetime and releases only its exact token", async () => {
    const home = await makeHome();
    const lease = await acquireBackgroundWorkerLease(CONFIG, { homeDir: home });

    expect(lease).toBeDefined();
    const leasePath = backgroundWorkerLeasePath(CONFIG, home);
    expect(lease?.path).toBe(leasePath);
    expect((await lstat(join(home, ".mono-agent"))).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(leasePath))).mode & 0o777).toBe(0o700);
    expect((await lstat(leasePath)).mode & 0o777).toBe(0o700);
    const ownerDetails = await lstat(join(leasePath, "owner.json"));
    expect(ownerDetails.isFile()).toBe(true);
    expect(ownerDetails.nlink).toBe(1);
    expect(ownerDetails.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(leasePath, "owner.json"), "utf8"))).toMatchObject({
      schema: "mono-agent.background-worker-lease.v2",
      configPath: CONFIG,
      pid: process.pid,
      incarnation: { schema: "mono-agent.process-incarnation.v1" },
    });

    expect(await acquireBackgroundWorkerLease(CONFIG, { homeDir: home })).toBeUndefined();

    await lease?.release();
    await lease?.release();
    await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });

    const reacquired = await acquireBackgroundWorkerLease(CONFIG, { homeDir: home });
    expect(reacquired).toBeDefined();
    await reacquired?.release();
  });

  it("repairs a stale lease when the PID was reused by a different process incarnation", async () => {
    const home = await makeHome();
    const oldOwner = incarnation("boot-current", "start-old");
    const reusedPidOwner = incarnation("boot-current", "start-reused");
    const abandoned = await acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 1111,
      processIncarnation: oldOwner,
      randomToken: () => "abandoned-owner",
    });
    expect(abandoned).toBeDefined();

    const replacement = await acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 2222,
      processIncarnation: incarnation("boot-current", "start-replacement"),
      isSameProcessIncarnation: (_pid, expected) =>
        expected.bootSessionId === reusedPidOwner.bootSessionId
        && expected.processStartId === reusedPidOwner.processStartId,
      randomToken: () => "replacement-owner",
    });

    expect(replacement).toBeDefined();
    expect(replacement?.ownerPid).toBe(2222);
    const owner = JSON.parse(await readFile(join(replacement!.path, "owner.json"), "utf8")) as {
      pid: number;
      token: string;
    };
    expect(owner).toMatchObject({ pid: 2222, token: "replacement-owner" });
    expect((await readdir(dirname(replacement!.path))).filter((name) => name.endsWith(".stale"))).toEqual([]);
    await replacement?.release();
  });

  it("repairs a stale lease from a prior boot even when its PID is live again", async () => {
    const home = await makeHome();
    const abandoned = await acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 1111,
      processIncarnation: incarnation("boot-prior", "start-same"),
      randomToken: () => "prior-boot-owner",
    });
    expect(abandoned).toBeDefined();

    const replacement = await acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 2222,
      processIncarnation: incarnation("boot-current", "start-replacement"),
      isSameProcessIncarnation: (_pid, expected) =>
        expected.bootSessionId === "boot-current" && expected.processStartId === "start-same",
      randomToken: () => "post-boot-owner",
    });

    expect(replacement?.ownerPid).toBe(2222);
    await replacement?.release();
  });

  it("does not steal a fresh ownerless lease during mkdir-to-owner initialization", async () => {
    const home = await makeHome();
    let markCreated!: () => void;
    let continueOwnerWrite!: () => void;
    const created = new Promise<void>((resolvePromise) => { markCreated = resolvePromise; });
    const ownerWriteGate = new Promise<void>((resolvePromise) => { continueOwnerWrite = resolvePromise; });

    const firstPromise = acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 3333,
      processIncarnation: incarnation("boot-current", "start-first"),
      hooks: {
        afterLeaseDirectoryCreated: async () => {
          markCreated();
          await ownerWriteGate;
        },
      },
    });
    await created;

    const contender = await acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 4444,
      processIncarnation: incarnation("boot-current", "start-contender"),
      isSameProcessIncarnation: () => false,
    });
    expect(contender).toBeUndefined();

    continueOwnerWrite();
    const first = await firstPromise;
    expect(first?.ownerPid).toBe(3333);
    await first?.release();
  });

  it("repairs old ownerless crash debris", async () => {
    const home = await makeHome();
    const leasePath = backgroundWorkerLeasePath(CONFIG, home);
    await mkdir(dirname(leasePath), { recursive: true, mode: 0o700 });
    await chmod(join(home, ".mono-agent"), 0o700);
    await chmod(dirname(leasePath), 0o700);
    await mkdir(leasePath, { mode: 0o700 });
    await utimes(leasePath, new Date(0), new Date(0));

    const lease = await acquireBackgroundWorkerLease(CONFIG, {
      homeDir: home,
      pid: 5555,
      processIncarnation: incarnation("boot-current", "start-ownerless-repair"),
      now: () => 10_000,
      ownerlessGraceMs: 1_000,
      randomToken: () => "ownerless-repair",
    });

    expect(lease?.ownerPid).toBe(5555);
    await lease?.release();
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked managed lease root", async () => {
    const home = await makeHome();
    const redirect = join(home, "redirect");
    await mkdir(redirect, { mode: 0o700 });
    await symlink(redirect, join(home, ".mono-agent"), "dir");

    await expect(acquireBackgroundWorkerLease(CONFIG, { homeDir: home }))
      .rejects.toThrow("must be a real directory");
  });

  it.skipIf(process.platform === "win32")("collapses symlinked parent aliases to one config lease", async () => {
    const home = await makeHome();
    const agent = join(home, "agent");
    const alias = join(home, "agent-alias");
    await mkdir(agent, { mode: 0o700 });
    await writeFile(join(agent, "mono-agent.config.json"), "{}\n", "utf8");
    await symlink(agent, alias, "dir");

    const first = await acquireBackgroundWorkerLease(join(agent, "mono-agent.config.json"), { homeDir: home });
    const duplicate = await acquireBackgroundWorkerLease(join(alias, "mono-agent.config.json"), { homeDir: home });

    expect(first?.configPath).toBe(join(await realpath(agent), "mono-agent.config.json"));
    expect(duplicate).toBeUndefined();
    await first?.release();
  });

  it.skipIf(process.platform === "win32")("collapses alternate final-component casing to one lease", async () => {
    const home = await makeHome();
    const stored = join(home, "MiXeD.Config.JSON");
    const alternate = join(home, "mixed.config.json");
    await writeFile(stored, "{}\n", "utf8");
    let alternateDetails;
    try {
      alternateDetails = await lstat(alternate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const storedDetails = await lstat(stored);
    if (alternateDetails.dev !== storedDetails.dev || alternateDetails.ino !== storedDetails.ino) return;

    const first = await acquireBackgroundWorkerLease(stored, { homeDir: home });
    const duplicate = await acquireBackgroundWorkerLease(alternate, { homeDir: home });

    expect(first?.configPath).toBe(await realpath(stored));
    expect(duplicate).toBeUndefined();
    await first?.release();
  });
});

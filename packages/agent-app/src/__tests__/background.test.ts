import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { RecordedRunListItem, TraceSourceListItem } from "@mono-agent/observability";

import {
  canonicalBackgroundConfigPath,
  acquireFilesystemLifecycleLock,
  ensureBackgroundReady,
  defaultBackgroundDeps,
  forceRestartBackground,
  maintainLaunchdController,
  maintainLaunchdLogs,
  managedLaunchdLogMaintenanceEnvironment,
  resolveInstanceTarget,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "../background.js";
import type { BackgroundDeps, InstanceTarget } from "../background.js";
import type { BackgroundSnapshot } from "../background-snapshot.js";
import { encodeBackgroundSnapshot } from "../background-snapshot.js";
import type { LaunchdLogInspection } from "../launchd-logs.js";
import { buildLaunchdProgramArguments } from "../launchd.js";
import type { LaunchctlRunner } from "../launchd.js";
import type { ProcessIncarnation } from "../process-incarnation.js";
import type { OwnerPrivateLock } from "../owner-private-lock.js";

const POLL = { timeoutMs: 5_000, intervalMs: 100 };
const CLOCK_START = 1_000_000;
const execFileAsync = promisify(execFile);

function processIncarnation(id: string): ProcessIncarnation {
  return {
    schema: "mono-agent.process-incarnation.v1",
    bootSessionId: "boot-test",
    processStartId: id,
  };
}

function makeTarget(
  overrides: Omit<Partial<InstanceTarget>, "expectedSnapshot"> & {
    readonly expectedSnapshot?: BackgroundSnapshot | undefined;
  } = {},
): InstanceTarget {
  const label = "com.mono-agent.demo-0a1b2c3d";
  const { expectedSnapshot, ...targetOverrides } = overrides;
  const target: InstanceTarget = {
    cwd: "/work/demo",
    configPath: "/work/demo/mono-agent.config.json",
    label,
    registryDir: "/home/u/.mono-agent/trace-sources",
    staleAfterMs: 30_000,
    paths: {
      launchAgentsDir: "/home/u/Library/LaunchAgents",
      logDir: "/home/u/.mono-agent/logs",
      plistPath: `/home/u/Library/LaunchAgents/${label}.plist`,
      stdoutPath: `/home/u/.mono-agent/logs/${label}.out.log`,
      stderrPath: `/home/u/.mono-agent/logs/${label}.err.log`,
    },
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/app/dist/cli.js",
    configurationEnvironment: { PATH: "/usr/bin:/bin" },
    environment: { PATH: "/usr/bin:/bin", MONO_AGENT_MANAGED_WORKER: "1" },
    ...targetOverrides,
    ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
  };
  return Object.prototype.hasOwnProperty.call(overrides, "expectedSnapshot")
    ? target
    : { ...target, expectedSnapshot: makeSnapshot(target) };
}

function makeSource(target: InstanceTarget, overrides: Partial<TraceSourceListItem> = {}): TraceSourceListItem {
  const metadata = {
    reason: "startup-complete",
    lifecycle: { startupCompleted: true },
    channels: {
      telegram: { kind: "running" },
      slack: { kind: "waiting_for_config", reason: "Missing appToken" },
    },
    ...(overrides.metadata ?? {}),
    ...(target.expectedSnapshot === undefined || overrides.metadata?.backgroundSnapshot !== undefined
      ? {}
      : { backgroundSnapshot: target.expectedSnapshot }),
  };
  return {
    schema: "agent-runtime.trace-source.v1",
    sourceId: "mono-agent-abcdef012345",
    label: "Mono Agent",
    artifactDir: "/work/demo/.mono-agent/artifacts",
    pid: 4321,
    status: "running",
    startedAt: new Date(CLOCK_START).toISOString(),
    updatedAt: new Date(CLOCK_START).toISOString(),
    configPath: target.configPath,
    health: "running",
    warnings: [],
    ...overrides,
    metadata,
  } as TraceSourceListItem;
}

function makeSnapshot(target: InstanceTarget, suffix = "approved"): BackgroundSnapshot {
  return {
    schema: "mono-agent.background-snapshot.v1",
    configPath: target.configPath,
    configFingerprint: `config-fingerprint-${suffix}`,
    dotenvPath: target.envFile ?? resolve(target.cwd, ".env"),
    dotenvFingerprint: `dotenv-fingerprint-${suffix}`,
    identityPath: resolve(target.cwd, "IDENTITY.md"),
    identityFingerprint: `identity-fingerprint-${suffix}`,
    operationalEnvironmentFingerprint: `environment-fingerprint-${suffix}`,
  };
}

function managedLaunchctlPrint(
  target: InstanceTarget,
  overrides: {
    readonly cliPath?: string;
    readonly launchProof?: string;
    readonly snapshot?: BackgroundSnapshot;
    readonly pid?: number;
  } = {},
): string {
  const args = buildLaunchdProgramArguments({
    label: target.label,
    nodePath: target.nodePath,
    cliPath: overrides.cliPath ?? "/home/u/.mono-agent/runtimes/agent-app/old/dist/cli.js",
    configPath: target.configPath,
    cwd: target.cwd,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    expectedBackgroundSnapshot: encodeBackgroundSnapshot(overrides.snapshot ?? target.expectedSnapshot!),
    expectedManagedRuntimeLaunch: overrides.launchProof ?? "old-runtime-proof",
    stdoutPath: target.paths.stdoutPath,
    stderrPath: target.paths.stderrPath,
    environment: target.environment,
  });
  return `gui/501/${target.label} = {\n`
    + `\tpath = ${target.paths.plistPath}\n`
    + "\tprogram = /usr/bin/env\n"
    + `\targuments = {\n${args.map((argument) => `\t\t${argument}`).join("\n")}\n\t}\n`
    + `\tworking directory = ${target.cwd}\n`
    + `\tstdout path = ${target.paths.stdoutPath}\n`
    + `\tstderr path = ${target.paths.stderrPath}\n`
    + `\tpid = ${String(overrides.pid ?? 4321)}\n}\n`;
}

interface RunnerOptions {
  readonly loaded: boolean;
  readonly initialPid?: number;
  readonly bootstrapPid?: number;
  readonly bootstrapCode?: number;
  readonly loadsAfterBootstrap?: boolean;
  readonly kickstartCode?: number;
  readonly bootoutCode?: number;
  /** Simulate a bootout that fails and leaves the service still loaded. */
  readonly bootoutKeepsLoaded?: boolean;
  readonly maintenanceLoaded?: boolean;
  readonly maintenancePid?: number;
  readonly maintenanceBootstrapCode?: number;
  readonly maintenanceLoadsAfterBootstrap?: boolean;
  readonly maintenanceBootoutCode?: number;
  readonly maintenanceBootoutKeepsLoaded?: boolean;
  readonly mainPrintOutput?: string;
}

type StatefulRunner = LaunchctlRunner & {
  readonly isAlive: (pid: number) => boolean;
  readonly isLoaded: (label: string) => boolean;
};

function makeRunner(opts: RunnerOptions): { runner: StatefulRunner; calls: string[][] } {
  const calls: string[][] = [];
  const maintenanceLabel = "com.mono-agent-maintenance.demo-0a1b2c3d";
  const main: { loaded: boolean; pid?: number } = {
    loaded: opts.loaded,
    ...(opts.loaded ? { pid: opts.initialPid ?? 4321 } : {}),
  };
  const maintenance: { loaded: boolean; pid?: number } = {
    loaded: opts.maintenanceLoaded ?? false,
    ...(opts.maintenancePid === undefined ? {} : { pid: opts.maintenancePid }),
  };
  const stateForLabel = (label: string | undefined): { loaded: boolean; pid?: number } =>
    label === maintenanceLabel ? maintenance : main;
  const labelFromTarget = (target: string | undefined): string | undefined => target?.split("/").at(-1);
  const runner = (async (args: readonly string[]) => {
    calls.push([...args]);
    switch (args[0]) {
      case "print": {
        const label = labelFromTarget(args[1]);
        const state = stateForLabel(label);
        const detailed = label === maintenanceLabel ? undefined : opts.mainPrintOutput;
        const stdout = detailed === undefined
          ? state.loaded && state.pid !== undefined ? `pid = ${state.pid}\n` : ""
          : detailed.replace(/^\s*pid\s*=\s*\d+\s*$/mu, `\tpid = ${String(state.pid ?? 0)}`);
        return {
          code: state.loaded ? 0 : 113,
          stdout: state.loaded ? stdout : "",
          stderr: "",
        };
      }
      case "bootstrap": {
        const isMaintenance = args[2]?.includes("com.mono-agent-maintenance.") === true;
        const state = isMaintenance ? maintenance : main;
        const code = isMaintenance ? opts.maintenanceBootstrapCode ?? 0 : opts.bootstrapCode ?? 0;
        if (isMaintenance
          ? (opts.maintenanceLoadsAfterBootstrap ?? code === 0)
          : (opts.loadsAfterBootstrap ?? code === 0)) {
          state.loaded = true;
          if (!isMaintenance) state.pid = opts.bootstrapPid ?? 4321;
        }
        return { code, stdout: "", stderr: "bootstrap detail" };
      }
      case "kickstart":
        return { code: opts.kickstartCode ?? 0, stdout: "", stderr: "" };
      case "bootout": {
        const label = labelFromTarget(args[1]);
        const isMaintenance = label === maintenanceLabel;
        const state = stateForLabel(label);
        const keepsLoaded = isMaintenance ? opts.maintenanceBootoutKeepsLoaded : opts.bootoutKeepsLoaded;
        if (!keepsLoaded) {
          state.loaded = false;
          delete state.pid;
        }
        return {
          code: isMaintenance ? opts.maintenanceBootoutCode ?? 0 : opts.bootoutCode ?? 0,
          stdout: "",
          stderr: "bootout detail",
        };
      }
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  }) as StatefulRunner;
  Object.defineProperties(runner, {
    isAlive: { value: (pid: number) => [main, maintenance].some((state) => state.loaded && state.pid === pid) },
    isLoaded: { value: (label: string) => stateForLabel(label).loaded },
  });
  return { runner, calls };
}

function listReturning(getSources: () => readonly TraceSourceListItem[]): BackgroundDeps["listTraceSources"] {
  return (async (options: { registryDir: string }) => ({
    registryDir: options.registryDir,
    sources: [...getSources()],
    warnings: [],
  })) as unknown as BackgroundDeps["listTraceSources"];
}

interface Harness {
  readonly deps: BackgroundDeps;
  readonly out: string[];
  readonly err: string[];
  readonly written: { path: string; data: string }[];
  readonly removed: string[];
  readonly mkdirs: string[];
  readonly tailCalls: string[][];
  readonly rotations: string[];
  readonly rotationLoadedStates: boolean[];
}

function makeHarness(opts: {
  runner: LaunchctlRunner;
  list: BackgroundDeps["listTraceSources"];
  listRecordedRuns?: BackgroundDeps["listRecordedRuns"];
  isAlive?: (pid: number) => boolean;
  currentPid?: () => number;
  inspectLaunchdLogs?: BackgroundDeps["inspectLaunchdLogs"];
  rotateStoppedLaunchdLogs?: BackgroundDeps["rotateStoppedLaunchdLogs"];
  readLaunchdLogMaintenanceIntent?: BackgroundDeps["readLaunchdLogMaintenanceIntent"];
  beginLaunchdLogMaintenanceIntent?: BackgroundDeps["beginLaunchdLogMaintenanceIntent"];
  markLaunchdLogMaintenanceStopped?: BackgroundDeps["markLaunchdLogMaintenanceStopped"];
  markLaunchdLogMaintenanceRestoring?: BackgroundDeps["markLaunchdLogMaintenanceRestoring"];
  markLaunchdLogMaintenanceStopping?: BackgroundDeps["markLaunchdLogMaintenanceStopping"];
  clearLaunchdLogMaintenanceIntent?: BackgroundDeps["clearLaunchdLogMaintenanceIntent"];
  verifyLaunchdPlist?: BackgroundDeps["verifyLaunchdPlist"];
  ensureManagedRuntime?: BackgroundDeps["ensureManagedRuntime"];
  inspectManagedRuntimeSourceIdentity?: BackgroundDeps["inspectManagedRuntimeSourceIdentity"];
  verifyManagedRuntimeLaunch?: BackgroundDeps["verifyManagedRuntimeLaunch"];
  resolveManagedRuntimePackages?: NonNullable<BackgroundDeps["resolveManagedRuntimePackages"]>;
  acquireLifecycleLock?: BackgroundDeps["acquireLifecycleLock"];
  acquireRuntimePublicationBarrier?: NonNullable<BackgroundDeps["acquireRuntimePublicationBarrier"]>;
  probeTui?: BackgroundDeps["probeTui"];
  captureSnapshot?: NonNullable<BackgroundDeps["captureSnapshot"]>;
  now?: BackgroundDeps["now"];
  sleep?: BackgroundDeps["sleep"];
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const written: { path: string; data: string }[] = [];
  const removed: string[] = [];
  const mkdirs: string[] = [];
  const tailCalls: string[][] = [];
  const rotations: string[] = [];
  const rotationLoadedStates: boolean[] = [];
  const isAlive = opts.isAlive ?? ("isAlive" in opts.runner
    ? (opts.runner as StatefulRunner).isAlive
    : () => false);
  let clock = CLOCK_START;
  const deps: BackgroundDeps = {
    runner: opts.runner,
    getuid: () => 501,
    currentPid: opts.currentPid ?? (() => 9001),
    now: opts.now ?? (() => clock),
    sleep: opts.sleep ?? (async (ms) => {
      clock += ms;
    }),
    listRecordedRuns: opts.listRecordedRuns ?? (async () => ({ totalRuns: 0, runs: [], warnings: [] })),
    listTraceSources: opts.list,
    writeFile: async (path, data) => {
      written.push({ path, data });
    },
    mkdir: async (path) => {
      mkdirs.push(path);
    },
    rm: async (path) => {
      removed.push(path);
    },
    inspectLaunchdLogs: opts.inspectLaunchdLogs ?? (async () => emptyLogInspection()),
    rotateStoppedLaunchdLogs: opts.rotateStoppedLaunchdLogs ?? (async (paths) => {
      rotations.push(paths.logDir);
      rotationLoadedStates.push("isLoaded" in opts.runner
        ? (opts.runner as StatefulRunner).isLoaded("com.mono-agent.demo-0a1b2c3d")
        : false);
    }),
    readLaunchdLogMaintenanceIntent: opts.readLaunchdLogMaintenanceIntent ?? (async () => undefined),
    beginLaunchdLogMaintenanceIntent: opts.beginLaunchdLogMaintenanceIntent ?? (async () => undefined),
    markLaunchdLogMaintenanceStopped: opts.markLaunchdLogMaintenanceStopped ?? (async (_paths, intent) => ({
      ...intent,
      phase: "stopped",
    })),
    markLaunchdLogMaintenanceRestoring: opts.markLaunchdLogMaintenanceRestoring ?? (async (_paths, intent) => ({
      ...intent,
      phase: "restoring",
    })),
    markLaunchdLogMaintenanceStopping: opts.markLaunchdLogMaintenanceStopping ?? (async (_paths, intent) => ({
      ...intent,
      phase: "stopping",
    })),
    clearLaunchdLogMaintenanceIntent: opts.clearLaunchdLogMaintenanceIntent ?? (async () => undefined),
    verifyLaunchdPlist: opts.verifyLaunchdPlist ?? (async () => "plist-identity"),
    isAlive,
    ensureManagedRuntime: opts.ensureManagedRuntime ?? (async (input) => ({
      cliPath: "/home/u/.mono-agent/runtimes/agent-app/verified/dist/cli.js",
      nodePath: input.nodePath,
      installRoot: "/home/u/.mono-agent/runtimes/agent-app/verified",
      packageVersion: "0.8.0",
      cliSha256: "a".repeat(64),
      nodeAbi: "137",
      verificationMode: "fast-reuse",
      launchProof: "verified-runtime-launch-proof",
    })),
    inspectManagedRuntimeSourceIdentity: opts.inspectManagedRuntimeSourceIdentity ?? (async () => ({
      packageVersion: "0.8.0",
      cliSha256: "a".repeat(64),
    })),
    verifyManagedRuntimeLaunch: opts.verifyManagedRuntimeLaunch ?? (async () => ({
      installRoot: "/home/u/.mono-agent/runtimes/agent-app/verified",
      packageVersion: "0.8.0",
      cliSha256: "a".repeat(64),
      provenanceDetail: "verified runtime",
    })),
    ...(opts.resolveManagedRuntimePackages === undefined
      ? {}
      : { resolveManagedRuntimePackages: opts.resolveManagedRuntimePackages }),
    acquireLifecycleLock: opts.acquireLifecycleLock ?? (async () => async () => undefined),
    acquireRuntimePublicationBarrier: opts.acquireRuntimePublicationBarrier ?? (async () => ({
      path: "/home/u/.mono-agent/locks/com.mono-agent.demo-0a1b2c3d.runtime-install.lock",
      ownerPid: 1234,
      release: async () => undefined,
    } satisfies OwnerPrivateLock)),
    probeTui: opts.probeTui ?? (async () => true),
    captureSnapshot: opts.captureSnapshot ?? (async (target) => target.expectedSnapshot ?? makeSnapshot(target)),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    spawnTail: async (args) => {
      tailCalls.push([...args]);
      return 0;
    },
  };
  return { deps, out, err, written, removed, mkdirs, tailCalls, rotations, rotationLoadedStates };
}

function emptyLogInspection(overrides: Partial<LaunchdLogInspection> = {}): LaunchdLogInspection {
  const stream = { activeBytes: 0, retainedBytes: 0, totalBytes: 0, byteAccountingComplete: true, files: [] };
  return {
    stdout: stream,
    stderr: stream,
    present: false,
    canMaintain: true,
    needsMaintenance: false,
    pendingTransaction: false,
    pendingMaintenance: false,
    issues: [],
    ...overrides,
  };
}

describe("background config identity", () => {
  it("pins the unattended log maintainer to the closed system PATH", () => {
    const environment = managedLaunchdLogMaintenanceEnvironment({
      HOME: "/home/u",
      PATH: "/tmp/shadow:/custom/bin",
    });

    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(Object.values(environment)).not.toContain("/tmp/shadow:/custom/bin");
  });

  it("uses the effective config environment for env-only managed plugin discovery without putting it in launchd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-background-env-plugin-"));
    try {
      const configPath = join(cwd, "mono-agent.config.json");
      await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n\nEnvironment plugin test.\n");
      await writeFile(configPath, `${JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
        context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
        tools: { allowedTools: [], disallowedTools: [] },
      }, null, 2)}\n`);
      const secret = "must-never-enter-the-plist";
      const target = await resolveInstanceTarget({
        args: { configPath },
        cwd,
        cliPath: "/opt/app/dist/cli.js",
        env: {
          PATH: "/usr/bin:/bin",
          MONO_AGENT_MEMORY_BACKEND: "supermemory",
          MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:8787",
          MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: secret,
        },
      });

      expect(target.configurationEnvironment.MONO_AGENT_MEMORY_BACKEND).toBe("supermemory");
      expect(target.environment.MONO_AGENT_MEMORY_BACKEND).toBeUndefined();
      expect(Object.values(target.environment)).not.toContain(secret);
      const packages = await defaultBackgroundDeps().resolveManagedRuntimePackages?.(target);
      expect(packages?.map((entry) => entry.packageName)).toContain("@mono-agent/memory-supermemory");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("canonicalizes symlinked parent aliases without following the final config name", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-config-identity-"));
    try {
      const agent = join(home, "agent");
      const alias = join(home, "agent-alias");
      await mkdir(agent, { mode: 0o700 });
      await writeFile(join(agent, "mono-agent.config.json"), "{}\n", "utf8");
      await symlink(agent, alias, "dir");

      await expect(canonicalBackgroundConfigPath(alias))
        .resolves.toBe(join(await realpath(agent), "mono-agent.config.json"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("persists a canonical working directory for a symlinked agent folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-working-directory-"));
    try {
      const agent = join(home, "agent");
      const alias = join(home, "agent-alias");
      await mkdir(agent, { mode: 0o700 });
      await writeFile(join(agent, "mono-agent.config.json"), "{}\n", "utf8");
      await symlink(agent, alias, "dir");

      const target = await resolveInstanceTarget({
        args: {},
        cwd: alias,
        cliPath: "/opt/app/dist/cli.js",
        env: { PATH: "/usr/bin:/bin" },
      });

      expect(target.cwd).toBe(await realpath(agent));
      expect(target.configPath).toBe(await realpath(join(agent, "mono-agent.config.json")));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("uses the stored final-component casing on case-insensitive filesystems", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-config-case-"));
    try {
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

      await expect(canonicalBackgroundConfigPath(home, "mixed.config.json"))
        .resolves.toBe(await realpath(stored));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("startBackground", () => {
  it("refuses a managed launch without an approved snapshot before any mutation", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget({ expectedSnapshot: undefined });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "snapshot" });
    expect(harness.written).toEqual([]);
    expect(calls).toEqual([]);
    expect(harness.err.join("")).toContain("without an approved background snapshot");
  });

  it("returns the fresh authoritative trace source from the structured readiness boundary", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const target = makeTarget();
    const source = makeSource(target, { sourceId: "mono-agent-ready-source", pid: 9876 });
    let clearedIntents = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => [source]),
      clearLaunchdLogMaintenanceIntent: async () => { clearedIntents += 1; },
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: true, action: "started", source });
    expect(clearedIntents).toBe(1);
  });

  it("allows a worker that completes after 35 seconds within the default 60-second readiness budget", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const target = makeTarget();
    const ready = makeSource(target, { sourceId: "mono-agent-slow-ready", pid: 9876 });
    let clock = CLOCK_START;
    const harness = makeHarness({
      runner,
      list: listReturning(() => clock - CLOCK_START >= 35_000 ? [ready] : []),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    await expect(ensureBackgroundReady(target, harness.deps))
      .resolves.toEqual({ ok: true, action: "started", source: ready });
    expect(clock - CLOCK_START).toBeGreaterThanOrEqual(35_000);
    expect(clock - CLOCK_START).toBeLessThan(60_000);
  });

  it("keeps durable startup readiness after the latest trace reason changes", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const source = makeSource(target, { metadata: { reason: "memory-health-periodic" } });
    const harness = makeHarness({ runner, list: listReturning(() => [source]) });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: true, action: "started", source });
  });

  it("requires the live worker metadata and current files to match the exact approved snapshot", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const base = makeTarget();
    const approved = makeSnapshot(base);
    const target = makeTarget({ expectedSnapshot: approved });
    const source = makeSource(target, {
      sourceId: "mono-agent-snapshot-source",
      pid: 9876,
      metadata: {
        reason: "startup-complete",
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/gui" } },
        backgroundSnapshot: approved,
      },
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [source]),
      captureSnapshot: async () => approved,
    });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: true, action: "started", source });
  });

  it("fails before runtime installation or plist creation when the approved snapshot drifted", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const base = makeTarget();
    const approved = makeSnapshot(base);
    const target = makeTarget({ expectedSnapshot: approved });
    let installs = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      captureSnapshot: async () => makeSnapshot(target, "changed"),
      ensureManagedRuntime: async (input) => {
        installs += 1;
        return {
          cliPath: input.currentCliPath,
          nodePath: input.nodePath,
          installRoot: "/unused",
          packageVersion: "0.8.0",
          cliSha256: "a".repeat(64),
          nodeAbi: "137",
          verificationMode: "fast-reuse",
          launchProof: "unused-runtime-launch-proof",
        };
      },
    });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "snapshot" });
    expect(installs).toBe(0);
    expect(harness.written).toEqual([]);
    expect(calls).toEqual([]);
    expect(harness.err.join(""))
      .toContain("No readiness claim was made for a different snapshot");
  });

  it("unloads a worker when inputs drift after plist commit but before readiness", async () => {
    const { runner, calls } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const target = makeTarget();
    const approved = target.expectedSnapshot!;
    let captures = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      captureSnapshot: async () => {
        captures += 1;
        return captures <= 2 ? approved : makeSnapshot(target, "post-plist-drift");
      },
    });

    await expect(ensureBackgroundReady(target, harness.deps, { timeoutMs: 300, intervalMs: 100 }))
      .resolves.toEqual({ ok: false, action: "start", reason: "snapshot" });

    expect(calls.map((call) => call[0])).toEqual(expect.arrayContaining(["bootstrap", "bootout"]));
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain("drifted LaunchAgent was stopped");
    expect(harness.written[0]?.data).toContain("--expected-background-snapshot");
  });

  it("bootstraps a fresh instance, writes the plist, and prints its info", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]) });

    const code = await startBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const verbs = calls.map((call) => call[0]);
    expect(verbs).toContain("bootstrap");
    expect(verbs).not.toContain("kickstart");
    expect(harness.mkdirs).toContain(target.paths.logDir);
    expect(harness.mkdirs).toContain(target.paths.launchAgentsDir);
    expect(harness.written[0]?.path).toBe(target.paths.plistPath);
    expect(harness.written[0]?.data).toContain(target.label);
    expect(harness.written[0]?.data).toContain("/home/u/.mono-agent/runtimes/agent-app/verified/dist/cli.js");
    expect(harness.written[0]?.data).not.toContain(target.cliPath);
    expect(harness.written[1]?.path).toContain("com.mono-agent-maintenance.demo-0a1b2c3d.plist");
    expect(harness.written[1]?.data).toContain("__launchd-log-maintenance");
    expect(harness.written[1]?.data).toContain("<key>StartInterval</key>");
    expect(harness.written[1]?.data).toContain("<string>/dev/null</string>");
    expect(harness.written[1]?.data).toContain("<string>/home/u/.mono-agent</string>");
    expect(harness.written[1]?.data).toContain("<string>--agent-cwd</string>");
    expect(harness.written[1]?.data).toContain("<string>/work/demo</string>");
    expect(harness.written[1]?.data).toContain("<string>--agent-path</string>");
    expect(harness.written[1]?.data).toContain("<string>/usr/bin:/bin</string>");
    expect(harness.written[1]?.data).not.toContain("--expected-background-snapshot");
    const bootstraps = calls.filter((call) => call[0] === "bootstrap").map((call) => call[2]);
    expect(bootstraps[0]).toContain("com.mono-agent-maintenance.");
    expect(bootstraps[1]).toBe(target.paths.plistPath);
    const stdout = harness.out.join("");
    expect(stdout).toContain("Verifying the durable managed runtime");
    expect(stdout).toContain("Managed runtime ready (warm reuse, 0 ms)");
    expect(stdout).toContain("Replacing the managed worker");
    expect(stdout).toContain("Waiting for the worker to report ready");
    expect(stdout).toContain("started in the background");
    expect(stdout).toContain("4321");
    expect(stdout).toContain(target.label);
  });

  it("keeps the current worker serving until runtime installation resolves, then releases the barrier after plist commit", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 4321 });
    const target = makeTarget();
    const oldSource = makeSource(target, { pid: 1111, startedAt: new Date(CLOCK_START - 1).toISOString() });
    const newSource = makeSource(target, { pid: 4321, startedAt: new Date(CLOCK_START + 1).toISOString() });
    let resolveInstall!: () => void;
    const installGate = new Promise<void>((resolvePromise) => { resolveInstall = resolvePromise; });
    let markInstallStarted!: () => void;
    const installStarted = new Promise<void>((resolvePromise) => { markInstallStarted = resolvePromise; });
    const events: string[] = [];
    let harness!: Harness;
    const barrier: OwnerPrivateLock = {
      path: "/home/u/.mono-agent/locks/runtime-install.lock",
      ownerPid: 1234,
      release: async () => {
        events.push(`barrier-released:writes=${harness.written.length}:bootstraps=${calls.filter((call) => call[0] === "bootstrap").length}`);
      },
    };
    harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath)
        ? [newSource]
        : [oldSource]),
      acquireRuntimePublicationBarrier: async () => {
        events.push("barrier-acquired");
        return barrier;
      },
      ensureManagedRuntime: async (input) => {
        events.push("runtime-install-started");
        markInstallStarted();
        await installGate;
        events.push("runtime-install-finished");
        return {
          cliPath: "/home/u/.mono-agent/runtimes/agent-app/verified/dist/cli.js",
          nodePath: input.nodePath,
          installRoot: "/home/u/.mono-agent/runtimes/agent-app/verified",
          packageVersion: "0.8.0",
          cliSha256: "a".repeat(64),
          nodeAbi: "137",
          verificationMode: "installed",
          launchProof: "deferred-runtime-launch-proof",
        };
      },
    });

    const starting = ensureBackgroundReady(target, harness.deps, POLL);
    await installStarted;

    expect(events).toEqual(["barrier-acquired", "runtime-install-started"]);
    expect(harness.written).toEqual([]);
    expect(calls.some((call) => call[0] === "bootout" || call[0] === "bootstrap")).toBe(false);

    resolveInstall();
    await expect(starting).resolves.toMatchObject({ ok: true, action: "restarted" });
    expect(events).toContain("barrier-released:writes=2:bootstraps=0");
    expect(harness.written[0]?.data).toContain("--expected-managed-runtime-launch");
    expect(harness.written[0]?.data).toContain("deferred-runtime-launch-proof");
  });

  it("binds config-selected plugin packages into the managed runtime request", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const additionalPackages = [{
      packageName: "@mono-agent/a2a-adapter",
      packageSource: "/resolved/a2a-adapter",
    }] as const;
    let runtimeInput: Parameters<BackgroundDeps["ensureManagedRuntime"]>[0] | undefined;
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target)]),
      resolveManagedRuntimePackages: async (resolvedTarget) => {
        expect(resolvedTarget).toBe(target);
        return additionalPackages;
      },
      ensureManagedRuntime: async (input) => {
        runtimeInput = input;
        return {
          cliPath: "/managed/agent-app/dist/cli.js",
          nodePath: input.nodePath,
          installRoot: "/managed",
          packageVersion: "0.8.0",
          cliSha256: "a".repeat(64),
          nodeAbi: "137",
          verificationMode: "full-reuse",
          launchProof: "plugin-runtime-launch-proof",
        };
      },
    });

    await expect(ensureBackgroundReady(target, harness.deps, POLL)).resolves.toMatchObject({ ok: true });
    expect(runtimeInput?.additionalPackages).toEqual(additionalPackages);
  });

  it("rotates launchd logs only after an existing writer is unloaded and before bootstrap", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 4321 });
    const target = makeTarget();
    const oldSource = makeSource(target, { pid: 1111, startedAt: new Date(CLOCK_START - 1).toISOString() });
    const newSource = makeSource(target, { pid: 4321, startedAt: new Date(CLOCK_START + 1).toISOString() });
    const harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath)
        ? [newSource]
        : [oldSource]),
    });

    const code = await startBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    expect(harness.rotations).toEqual([target.paths.logDir]);
    expect(harness.rotationLoadedStates).toEqual([false]);
    expect(calls.map((call) => call[0])).toEqual(expect.arrayContaining(["bootout", "bootstrap"]));
    expect(harness.written.some((entry) => entry.path.includes("com.mono-agent-maintenance."))).toBe(true);
  });

  it("invalidates stale stopped-writer proof before controller bootout and renews it before rotation", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 4321 });
    const target = makeTarget();
    const oldSource = makeSource(target, { pid: 1111, startedAt: new Date(CLOCK_START - 1).toISOString() });
    const newSource = makeSource(target, { pid: 4321, startedAt: new Date(CLOCK_START + 1).toISOString() });
    const stoppedIntent = {
      version: 1 as const,
      phase: "stopped" as const,
      label: target.label,
      plistFingerprint: "plist-identity",
    };
    const lifecycle: string[] = [];
    const harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath)
        ? [newSource]
        : [oldSource]),
      readLaunchdLogMaintenanceIntent: async () => stoppedIntent,
      markLaunchdLogMaintenanceStopping: async (_paths, expected) => {
        expect(runner.isLoaded(target.label)).toBe(true);
        lifecycle.push("stopping");
        return { ...expected, phase: "stopping" };
      },
      markLaunchdLogMaintenanceStopped: async (_paths, expected) => {
        expect(runner.isLoaded(target.label)).toBe(false);
        lifecycle.push("stopped");
        return { ...expected, phase: "stopped" };
      },
      rotateStoppedLaunchdLogs: async () => { lifecycle.push("rotate"); },
      clearLaunchdLogMaintenanceIntent: async (_paths, expected) => {
        expect(expected?.phase).toBe("stopped");
        lifecycle.push("clear");
      },
    });

    await expect(startBackground(target, harness.deps, POLL)).resolves.toBe(0);
    expect(lifecycle).toEqual(["stopping", "stopped", "rotate", "clear"]);
  });

  it("tolerates a bootstrap that reports already-loaded", async () => {
    const { runner, calls } = makeRunner({ loaded: false, bootstrapCode: 37, loadsAfterBootstrap: true });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]) });

    const code = await startBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    expect(calls.map((call) => call[0])).toContain("bootstrap");
  });

  it("returns non-zero and points at the logs when the worker never reports ready", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const code = await startBackground(target, harness.deps, { timeoutMs: 1_000, intervalMs: 200 });

    expect(code).toBe(1);
    const stderr = harness.err.join("");
    expect(stderr).toContain("did not report ready");
    expect(stderr).toContain(target.paths.stderrPath);
    expect(stderr).toContain("mono-agent start");
    expect(stderr).toContain("mono-agent status");
    expect(stderr).toContain("mono-agent logs --follow");
    expect(stderr).toContain("were stopped and their definitions removed");
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(false);
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.removed).toContain("/home/u/Library/LaunchAgents/com.mono-agent-maintenance.demo-0a1b2c3d.plist");
  });

  it("fails explicitly when readiness cleanup cannot prove the worker stopped", async () => {
    const { runner } = makeRunner({ loaded: false, bootoutKeepsLoaded: true });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const result = await ensureBackgroundReady(target, harness.deps, { timeoutMs: 300, intervalMs: 100 });

    expect(result).toEqual({ ok: false, action: "start", reason: "timeout" });
    expect(runner.isLoaded(target.label)).toBe(true);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(true);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    const stderr = harness.err.join("");
    expect(stderr).toContain("could not be proven stopped");
    expect(stderr).toContain("may still be running");
    expect(stderr).toContain("mono-agent status");
    expect(stderr).toContain("mono-agent logs --follow");
  });

  it("returns a structured launchctl failure and prints exact recovery commands", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapCode: 5, loadsAfterBootstrap: false });
    const target = makeTarget({
      configPath: "/work/My Agent/custom.json",
      envFile: "/work/My Agent/.env.agent",
    });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "launchctl" });
    const stderr = harness.err.join("");
    const flags = "--config '/work/My Agent/custom.json' --env-file '/work/My Agent/.env.agent'";
    expect(stderr).toContain(`mono-agent start ${flags}`);
    expect(stderr).toContain(`mono-agent status ${flags}`);
    expect(stderr).toContain(`mono-agent logs ${flags} --follow`);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(false);
  });

  it("never bootstraps the main service when scheduled maintenance cannot load", async () => {
    const { runner, calls } = makeRunner({ loaded: false, maintenanceBootstrapCode: 5 });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "launchctl" });
    const bootstraps = calls.filter((call) => call[0] === "bootstrap");
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.[2]).toContain("com.mono-agent-maintenance.");
    expect(runner.isLoaded(target.label)).toBe(false);
  });

  it("rejects a code-zero helper bootstrap that never becomes loaded", async () => {
    const { runner, calls } = makeRunner({
      loaded: false,
      maintenanceBootstrapCode: 0,
      maintenanceLoadsAfterBootstrap: false,
    });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "launchctl" });
    const bootstraps = calls.filter((call) => call[0] === "bootstrap");
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.[2]).toContain("com.mono-agent-maintenance.");
    expect(runner.isLoaded(target.label)).toBe(false);
  });

  it("does not rotate, rewrite, or touch the main service when the old helper cannot stop", async () => {
    const { runner, calls } = makeRunner({
      loaded: true,
      initialPid: 4321,
      maintenanceLoaded: true,
      maintenancePid: 7777,
      maintenanceBootoutKeepsLoaded: true,
    });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      isAlive: (pid) => pid === 4321 || pid === 7777,
    });

    await expect(ensureBackgroundReady(target, harness.deps, { timeoutMs: 300, intervalMs: 100 }))
      .resolves.toEqual({ ok: false, action: "restart", reason: "launchctl" });
    expect(harness.rotations).toEqual([]);
    expect(harness.written).toEqual([]);
    expect(calls.filter((call) => call[0] === "bootout" && call[1]?.endsWith(`/${target.label}`)))
      .toHaveLength(0);
  });

  it("restores the previously loaded helper when the main writer cannot be proven stopped", async () => {
    const { runner, calls } = makeRunner({
      loaded: true,
      maintenanceLoaded: true,
      maintenancePid: 7777,
      bootoutCode: 5,
      bootoutKeepsLoaded: true,
    });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
    });

    await expect(ensureBackgroundReady(target, harness.deps, { timeoutMs: 300, intervalMs: 100 }))
      .resolves.toEqual({ ok: false, action: "restart", reason: "launchctl" });
    const mutations = calls.filter((call) => call[0] === "bootout" || call[0] === "bootstrap");
    expect(mutations.map((call) => call[0])).toEqual(["bootout", "bootout", "bootstrap"]);
    expect(mutations[0]?.[1]).toContain("com.mono-agent-maintenance.");
    expect(mutations[1]?.[1]).toContain(target.label);
    expect(mutations[2]?.[2]).toContain("com.mono-agent-maintenance.");
    expect(harness.rotations).toEqual([]);
    expect(harness.written).toEqual([]);
    expect(runner.isLoaded(target.label)).toBe(true);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(true);
  });

  it.each([
    ["bootstrap error", { maintenanceBootstrapCode: 5 }],
    ["code-zero false success", { maintenanceBootstrapCode: 0, maintenanceLoadsAfterBootstrap: false }],
  ] as const)("reports helper restoration failure after main stop failure: %s", async (_name, restore) => {
    const { runner } = makeRunner({
      loaded: true,
      maintenanceLoaded: true,
      maintenancePid: 7777,
      bootoutKeepsLoaded: true,
      ...restore,
    });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
    });

    await expect(ensureBackgroundReady(target, harness.deps, { timeoutMs: 300, intervalMs: 100 }))
      .resolves.toEqual({ ok: false, action: "restart", reason: "launchctl" });
    expect(harness.rotations).toEqual([]);
    expect(harness.written).toEqual([]);
    expect(runner.isLoaded(target.label)).toBe(true);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(false);
    expect(harness.err.join(" ")).toContain("scheduled maintenance restoration failed");
  });

  it("converts plist preparation exceptions into a preserved-files recovery result", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });
    const deps: BackgroundDeps = {
      ...harness.deps,
      writeFile: async () => {
        throw new Error("plist destination is unavailable");
      },
    };

    const result = await ensureBackgroundReady(target, deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "preparation" });
    const stderr = harness.err.join("");
    expect(stderr).toContain("Failed to prepare the stopped LaunchAgent");
    expect(stderr).toContain("plist destination is unavailable");
    expect(stderr).toContain("committed agent files were preserved");
    expect(stderr).toContain("mono-agent start");
  });

  it("validates and rotates launchd log destinations before committing either plist", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });
    const deps: BackgroundDeps = {
      ...harness.deps,
      rotateStoppedLaunchdLogs: async () => {
        throw new Error("LaunchAgent log must be a regular non-symbolic-link file");
      },
    };

    await expect(ensureBackgroundReady(target, deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "preparation" });
    expect(harness.written).toEqual([]);
    expect(harness.err.join("")).toContain("non-symbolic-link");
  });

  it("converts readiness registry exceptions into a preserved-files recovery result", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    let calls = 0;
    const list = (async () => {
      calls += 1;
      if (calls === 2) throw new Error("trace registry is unreadable");
      return { registryDir: target.registryDir, sources: [], warnings: [] };
    }) as BackgroundDeps["listTraceSources"];
    const harness = makeHarness({ runner, list });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "readiness" });
    const stderr = harness.err.join("");
    expect(stderr).toContain("Failed to read the worker readiness trace");
    expect(stderr).toContain("trace registry is unreadable");
    expect(stderr).toContain("committed agent files were preserved");
    expect(stderr).toContain("mono-agent status");
    expect(stderr).toContain("were stopped and their definitions removed");
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(false);
    expect(harness.removed).toContain(target.paths.plistPath);
  });

  it("fails before writing a plist when the durable runtime cannot be verified", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    let barrierReleases = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      acquireRuntimePublicationBarrier: async () => ({
        path: "/home/u/.mono-agent/locks/runtime-install.lock",
        ownerPid: 1234,
        release: async () => { barrierReleases += 1; },
      }),
      ensureManagedRuntime: async () => { throw new Error("exact CLI SHA mismatch"); },
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "runtime" });
    expect(harness.written).toEqual([]);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join("")).toContain("exact CLI SHA mismatch");
    expect(barrierReleases).toBe(1);
  });

  it("fails closed when a live matching manifest is not owned by launchd", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const orphan = makeSource(target, { pid: 8765 });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [orphan]),
      isAlive: (pid) => pid === 8765,
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "ownership" });
    expect(harness.written).toEqual([]);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join("")).toContain("Refusing to launch a second worker");
  });

  it("requires trace pid ownership by the live launchd service", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 4321 });
    const target = makeTarget();
    const source = makeSource(target, { pid: 9876 });
    let lists = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => (lists += 1) === 1 ? [] : [source]),
      isAlive: (pid) => pid === 4321 || pid === 9876,
    });

    const code = await startBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 });

    expect(code).toBe(1);
    expect(harness.err.join("")).toContain("did not report ready");
  });

  it("requires a reachable TUI endpoint for guided/configuration handoffs", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget({ requireTui: true });
    const source = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/gui" } },
      },
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [source]),
      probeTui: async () => false,
    });

    const code = await startBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 });

    expect(code).toBe(1);
    expect(harness.err.join("")).toContain("did not report ready");
  });

  it("rejects startup-complete metadata when a configured channel failed", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const source = makeSource(target, {
      metadata: { reason: "startup-complete", channels: { telegram: { kind: "failed", reason: "bind failed" } } },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [source]) });

    expect(await startBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
  });

  it("rejects a concurrent lifecycle command before runtime or plist mutation", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    let runtimeCalls = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      acquireLifecycleLock: async () => undefined,
      ensureManagedRuntime: async () => {
        runtimeCalls += 1;
        throw new Error("must not run");
      },
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "ownership" });
    expect(runtimeCalls).toBe(0);
    expect(harness.written).toEqual([]);
  });
});

describe("filesystem lifecycle lock", () => {
  it("does not steal a fresh ownerless lock during the mkdir-to-owner write window", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-lifecycle-lock-"));
    const target = makeTarget({
      paths: {
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        logDir: join(home, ".mono-agent", "logs"),
        plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
        stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
        stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
      },
    });
    const lockDir = join(home, ".mono-agent", "locks", `${target.label}.lock`);
    try {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });

      const acquired = await defaultBackgroundDeps().acquireLifecycleLock(target);

      expect(acquired).toBeUndefined();
      expect((await lstat(lockDir)).isDirectory()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not remove a live contender swapped in at the stale-lock rename boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-lifecycle-lock-race-"));
    const target = makeTarget({
      paths: {
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        logDir: join(home, ".mono-agent", "logs"),
        plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
        stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
        stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
      },
    });
    const lockDir = join(home, ".mono-agent", "locks", `${target.label}.lock`);
    const displaced = join(home, ".mono-agent", "locks", "old-dead-lock");
    try {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(join(lockDir, "owner.json"), JSON.stringify({
        pid: 1111,
        token: "dead",
        incarnation: processIncarnation("dead-owner"),
      }), "utf8");

      const acquired = await acquireFilesystemLifecycleLock(target, {
        pid: 3333,
        processIncarnation: processIncarnation("acquirer"),
        isSameProcessIncarnation: async (pid) => pid === 2222,
        randomToken: () => "race-token",
        beforeStaleLockRename: async () => {
          await rename(lockDir, displaced);
          await mkdir(lockDir, { mode: 0o700 });
          await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 2222, token: "live" }), "utf8");
        },
      });

      expect(acquired).toBeUndefined();
      expect(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"))).toMatchObject({
        pid: 2222,
        token: "live",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("recovers a stale lifecycle lock when an unrelated process reused the owner pid", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-lifecycle-lock-incarnation-"));
    const target = makeTarget({
      paths: {
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        logDir: join(home, ".mono-agent", "logs"),
        plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
        stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
        stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
      },
    });
    try {
      const original = await acquireFilesystemLifecycleLock(target, {
        pid: 1111,
        processIncarnation: processIncarnation("original-owner"),
        randomToken: () => "original-token",
      });
      expect(original).toBeTypeOf("function");

      const replacement = await acquireFilesystemLifecycleLock(target, {
        pid: 2222,
        processIncarnation: processIncarnation("replacement-owner"),
        // PID-only liveness says the old number exists, but the OS birth
        // identity proves that process is not the lock creator.
        isProcessAlive: (pid) => pid === 1111,
        isSameProcessIncarnation: async () => false,
        randomToken: () => "replacement-token",
      });

      expect(replacement).toBeTypeOf("function");
      await replacement?.();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("LaunchAgent private filesystem boundary", () => {
  it.skipIf(process.platform === "win32")("rejects symlinked plist and log destinations without modifying their targets", async () => {
    // macOS exposes tmpdir() through the /var -> /private/var alias. Use its
    // canonical spelling so this fixture reaches the final-component symlink
    // assertion instead of correctly failing earlier on the parent alias.
    const home = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-launchd-paths-")));
    const outsidePlist = join(home, "outside.plist");
    const outsideLog = join(home, "outside.log");
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    const logDir = join(home, ".mono-agent", "logs");
    const plistPath = join(launchAgentsDir, "agent.plist");
    const logPath = join(logDir, "agent.out.log");
    try {
      await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      await writeFile(outsidePlist, "outside-plist\n", "utf8");
      await writeFile(outsideLog, "outside-log\n", "utf8");
      await symlink(outsidePlist, plistPath);
      await symlink(outsideLog, logPath);
      const deps = defaultBackgroundDeps();

      await expect(deps.writeFile(plistPath, "new-plist\n"))
        .rejects.toThrow("non-symbolic-link");
      await expect(deps.verifyLaunchdPlist(plistPath)).rejects.toBeDefined();
      const inspection = await deps.inspectLaunchdLogs({
        logDir,
        stdoutPath: logPath,
        stderrPath: join(logDir, "agent.err.log"),
      });
      expect(inspection.canMaintain).toBe(false);
      expect(inspection.issues.join(" ")).toContain("non-symbolic-link");
      await expect(readFile(outsidePlist, "utf8")).resolves.toBe("outside-plist\n");
      await expect(readFile(outsideLog, "utf8")).resolves.toBe("outside-log\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("fingerprints plist identity and content without accepting in-place drift", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-launchd-plist-identity-"));
    const plistPath = join(home, "agent.plist");
    try {
      await writeFile(plistPath, "first definition\n", { encoding: "utf8", mode: 0o600 });
      const deps = defaultBackgroundDeps();
      const first = await deps.verifyLaunchdPlist(plistPath);

      await writeFile(plistPath, "second definition\n", { encoding: "utf8", mode: 0o600 });
      const second = await deps.verifyLaunchdPlist(plistPath);

      expect(second).not.toBe(first);
      expect(await readFile(plistPath, "utf8")).toBe("second definition\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a fifo plist without blocking the maintainer", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-launchd-plist-fifo-"));
    const plistPath = join(home, "agent.plist");
    try {
      await execFileAsync("mkfifo", [plistPath]);
      await expect(defaultBackgroundDeps().verifyLaunchdPlist(plistPath))
        .rejects.toThrow(/regular non-symbolic-link file/u);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("maintainLaunchdController", () => {
  it("upgrades a drifted worker while the old PID serves and preserves the running helper", async () => {
    const target = makeTarget({ controllerCliPath: "/checkout/packages/agent-app/dist/cli.js" });
    const priorSnapshot = makeSnapshot(target, "prior");
    const { runner, calls } = makeRunner({
      loaded: true,
      initialPid: 4321,
      bootstrapPid: 5432,
      maintenanceLoaded: true,
      maintenancePid: 9001,
      mainPrintOutput: managedLaunchctlPrint(target, { snapshot: priorSnapshot }),
    });
    let installedWhileOldWorkerServed = false;
    const harness = makeHarness({
      runner,
      currentPid: () => 9001,
      list: listReturning(() => calls.some((call) =>
        call[0] === "bootstrap" && call[2] === target.paths.plistPath)
        ? [makeSource(target, { pid: 5432 })]
        : [makeSource(target, { pid: 4321, metadata: { backgroundSnapshot: priorSnapshot } })]),
      inspectManagedRuntimeSourceIdentity: async () => ({
        packageVersion: "0.14.0",
        cliSha256: "b".repeat(64),
      }),
      verifyManagedRuntimeLaunch: async () => ({
        installRoot: "/home/u/.mono-agent/runtimes/agent-app/old",
        packageVersion: "0.13.0",
        cliSha256: "a".repeat(64),
        provenanceDetail: "old runtime",
      }),
      ensureManagedRuntime: async (input) => {
        installedWhileOldWorkerServed = runner.isLoaded(target.label) && runner.isAlive(4321);
        return {
          cliPath: "/home/u/.mono-agent/runtimes/agent-app/new/dist/cli.js",
          nodePath: input.nodePath,
          installRoot: "/home/u/.mono-agent/runtimes/agent-app/new",
          packageVersion: "0.14.0",
          cliSha256: "b".repeat(64),
          nodeAbi: "137",
          verificationMode: "installed",
          launchProof: "new-runtime-proof",
        };
      },
    });

    expect(await maintainLaunchdController(target, harness.deps, {
      sourceAvailable: true,
      controlPoll: POLL,
      readinessPoll: POLL,
    })).toBe(0);
    expect(installedWhileOldWorkerServed).toBe(true);
    expect(harness.written.map(({ path }) => path)).toEqual([
      target.paths.plistPath,
      "/home/u/Library/LaunchAgents/com.mono-agent-maintenance.demo-0a1b2c3d.plist",
    ]);
    const mutations = calls.filter((call) => call[0] === "bootout" || call[0] === "bootstrap");
    expect(mutations.some((call) => call.join(" ").includes("com.mono-agent-maintenance"))).toBe(false);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(true);
    expect(runner.isLoaded(target.label)).toBe(true);
    expect(harness.written[1]?.data).toContain("/checkout/packages/agent-app/dist/cli.js");
  });

  it("keeps both definitions and the helper when recovered worker readiness fails", async () => {
    const target = makeTarget({ controllerCliPath: "/checkout/packages/agent-app/dist/cli.js" });
    const { runner, calls } = makeRunner({
      loaded: true,
      initialPid: 4321,
      bootstrapPid: 5432,
      maintenanceLoaded: true,
      maintenancePid: 9001,
      mainPrintOutput: managedLaunchctlPrint(target),
    });
    const harness = makeHarness({
      runner,
      currentPid: () => 9001,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      inspectManagedRuntimeSourceIdentity: async () => ({
        packageVersion: "0.14.0",
        cliSha256: "b".repeat(64),
      }),
      verifyManagedRuntimeLaunch: async () => ({
        installRoot: "/home/u/.mono-agent/runtimes/agent-app/old",
        packageVersion: "0.13.0",
        cliSha256: "a".repeat(64),
        provenanceDetail: "old runtime",
      }),
    });

    expect(await maintainLaunchdController(target, harness.deps, {
      sourceAvailable: true,
      controlPoll: { timeoutMs: 300, intervalMs: 100 },
      readinessPoll: { timeoutMs: 300, intervalMs: 100 },
    })).toBe(1);
    expect(harness.written).toHaveLength(2);
    expect(harness.removed).toEqual([]);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(true);
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(calls.filter((call) => call[0] === "bootout" && call[1]?.includes(target.label))).toHaveLength(2);
    expect(harness.err.join(" ")).toContain("scheduled recovery controller remain for retry");
  });

  it("refuses recovery unless launchd owns the exact helper PID", async () => {
    const target = makeTarget();
    const { runner } = makeRunner({
      loaded: false,
      maintenanceLoaded: true,
      maintenancePid: 7777,
    });
    let inspected = false;
    const harness = makeHarness({
      runner,
      currentPid: () => 9001,
      list: listReturning(() => []),
      inspectManagedRuntimeSourceIdentity: async () => {
        inspected = true;
        return { packageVersion: "0.14.0", cliSha256: "b".repeat(64) };
      },
    });

    expect(await maintainLaunchdController(target, harness.deps, { sourceAvailable: true })).toBe(1);
    expect(inspected).toBe(false);
    expect(harness.err.join(" ")).toContain("authenticate the launchd-owned recovery controller");
  });

  it("does not downgrade a healthy worker when the original source CLI is unavailable", async () => {
    const target = makeTarget({
      cliPath: "/home/u/.mono-agent/runtimes/agent-app/helper/dist/cli.js",
      controllerCliPath: "/home/u/.mono-agent/runtimes/agent-app/helper/dist/cli.js",
    });
    const { runner, calls } = makeRunner({
      loaded: true,
      initialPid: 4321,
      maintenanceLoaded: true,
      maintenancePid: 9001,
      mainPrintOutput: managedLaunchctlPrint(target),
    });
    let installs = 0;
    const harness = makeHarness({
      runner,
      currentPid: () => 9001,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      inspectManagedRuntimeSourceIdentity: async () => ({
        packageVersion: "0.12.0",
        cliSha256: "c".repeat(64),
      }),
      verifyManagedRuntimeLaunch: async () => ({
        installRoot: "/home/u/.mono-agent/runtimes/agent-app/current",
        packageVersion: "0.13.0",
        cliSha256: "a".repeat(64),
        provenanceDetail: "current runtime",
      }),
      ensureManagedRuntime: async (input) => {
        installs += 1;
        return await makeHarness({ runner, list: listReturning(() => []) }).deps.ensureManagedRuntime(input);
      },
    });

    expect(await maintainLaunchdController(target, harness.deps, { sourceAvailable: false })).toBe(0);
    expect(installs).toBe(0);
    expect(calls.some((call) => call[0] === "bootout" || call[0] === "bootstrap")).toBe(false);
  });

  it("recovers snapshot drift from the private helper closure when source disappeared", async () => {
    const helperCli = "/home/u/.mono-agent/runtimes/agent-app/helper/dist/cli.js";
    const originalControllerCli = "/work/source/packages/agent-app/dist/cli.js";
    const target = makeTarget({ cliPath: helperCli, controllerCliPath: originalControllerCli });
    const priorSnapshot = makeSnapshot(target, "prior");
    const { runner, calls } = makeRunner({
      loaded: true,
      initialPid: 4321,
      bootstrapPid: 5432,
      maintenanceLoaded: true,
      maintenancePid: 9001,
      mainPrintOutput: managedLaunchctlPrint(target, { snapshot: priorSnapshot }),
    });
    let installationInput: string | undefined;
    const harness = makeHarness({
      runner,
      currentPid: () => 9001,
      list: listReturning(() => calls.some((call) =>
        call[0] === "bootstrap" && call[2] === target.paths.plistPath)
        ? [makeSource(target, { pid: 5432 })]
        : [makeSource(target, { pid: 4321, metadata: { backgroundSnapshot: priorSnapshot } })]),
      inspectManagedRuntimeSourceIdentity: async () => ({
        packageVersion: "0.12.0",
        cliSha256: "c".repeat(64),
      }),
      verifyManagedRuntimeLaunch: async () => ({
        installRoot: "/home/u/.mono-agent/runtimes/agent-app/current",
        packageVersion: "0.13.0",
        cliSha256: "a".repeat(64),
        provenanceDetail: "current runtime",
      }),
      ensureManagedRuntime: async (input) => {
        installationInput = input.currentCliPath;
        return {
          cliPath: helperCli,
          nodePath: input.nodePath,
          installRoot: "/home/u/.mono-agent/runtimes/agent-app/helper",
          packageVersion: "0.12.0",
          cliSha256: "c".repeat(64),
          nodeAbi: "137",
          verificationMode: "fast-reuse",
          launchProof: "helper-runtime-proof",
        };
      },
    });

    expect(await maintainLaunchdController(target, harness.deps, {
      sourceAvailable: false,
      controlPoll: POLL,
      readinessPoll: POLL,
    })).toBe(0);
    expect(installationInput).toBe(helperCli);
    expect(harness.err.join(" ")).toContain("without claiming an upgrade");
    expect(harness.written[1]?.data).toContain(`<string>${originalControllerCli}</string>`);
    expect(runner.isLoaded(target.label)).toBe(true);
  });
});

describe("maintainLaunchdLogs", () => {
  it("does nothing and never resurrects a main service that was not loaded", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    let inspections = 0;
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => {
        inspections += 1;
        return emptyLogInspection({
          present: true,
          needsMaintenance: true,
          pendingTransaction: true,
        });
      },
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(0);
    expect(inspections).toBe(1);
    expect(rotations).toBe(0);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
  });

  it("recovers its durable pending transaction and restores the previously booted worker", async () => {
    const { runner, calls } = makeRunner({ loaded: false, bootstrapPid: 2222 });
    const target = makeTarget();
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        needsMaintenance: true,
        pendingTransaction: true,
        pendingMaintenance: true,
        issues: ["pending launchd-log rotation transaction requires recovery"],
      }),
      readLaunchdLogMaintenanceIntent: async () => ({
        version: 1,
        phase: "stopped",
        label: target.label,
        plistFingerprint: "plist-identity",
      }),
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(0);
    expect(rotations).toBe(1);
    expect(runner.isLoaded(target.label)).toBe(true);
    expect(calls.filter((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath))
      .toHaveLength(1);
  });

  it("retries a persisted stopping phase only while launchd still owns the writer", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    const intent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: target.label,
      plistFingerprint: "plist-identity",
    };
    const lifecycle: string[] = [];
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        needsMaintenance: true,
        pendingMaintenance: true,
      }),
      readLaunchdLogMaintenanceIntent: async () => intent,
      markLaunchdLogMaintenanceStopped: async (_paths, expected) => {
        expect(expected).toEqual(intent);
        expect(runner.isLoaded(target.label)).toBe(false);
        lifecycle.push("stopped");
        return { ...expected, phase: "stopped" };
      },
      rotateStoppedLaunchdLogs: async () => { lifecycle.push("rotate"); },
      markLaunchdLogMaintenanceRestoring: async (_paths, expected) => {
        lifecycle.push("restoring");
        return { ...expected, phase: "restoring" };
      },
      clearLaunchdLogMaintenanceIntent: async (_paths, expected) => {
        expect(expected?.phase).toBe("restoring");
        lifecycle.push("clear");
      },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(0);
    expect(lifecycle).toEqual(["stopped", "rotate", "restoring", "clear"]);
  });

  it("fails closed on a persisted stopping phase after launchd lost the writer pid", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    let marks = 0;
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        needsMaintenance: true,
        pendingMaintenance: true,
      }),
      readLaunchdLogMaintenanceIntent: async () => ({
        version: 1,
        phase: "stopping",
        label: target.label,
        plistFingerprint: "plist-identity",
      }),
      markLaunchdLogMaintenanceStopped: async (_paths, intent) => {
        marks += 1;
        return { ...intent, phase: "stopped" };
      },
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(marks).toBe(0);
    expect(rotations).toBe(0);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join(" ")).toContain("did not durably prove every old writer PID dead");
  });

  it("clears a restoring phase only after the exact replacement writer is live", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 2222 });
    const target = makeTarget();
    let rotations = 0;
    let clears = 0;
    const restoring = {
      version: 1 as const,
      phase: "restoring" as const,
      label: target.label,
      plistFingerprint: "plist-identity",
    };
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        needsMaintenance: true,
        pendingMaintenance: true,
      }),
      readLaunchdLogMaintenanceIntent: async () => restoring,
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
      clearLaunchdLogMaintenanceIntent: async (_paths, expected) => {
        expect(expected).toEqual(restoring);
        clears += 1;
      },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(0);
    expect(clears).toBe(1);
    expect(rotations).toBe(0);
    expect(calls.map((call) => call[0])).not.toContain("bootout");
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
  });

  it("refreshes launchd ownership before clearing a restoring phase", async () => {
    const target = makeTarget();
    let prints = 0;
    const runner: LaunchctlRunner = async (args) => {
      if (args[0] !== "print") return { code: 0, stdout: "", stderr: "" };
      prints += 1;
      return prints === 1
        ? { code: 0, stdout: "pid = 2222\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "" };
    };
    let clears = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      isAlive: (pid) => pid === 2222,
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        needsMaintenance: true,
        pendingMaintenance: true,
      }),
      readLaunchdLogMaintenanceIntent: async () => ({
        version: 1,
        phase: "restoring",
        label: target.label,
        plistFingerprint: "plist-identity",
      }),
      clearLaunchdLogMaintenanceIntent: async () => { clears += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(clears).toBe(0);
    expect(prints).toBe(2);
    expect(harness.err.join(" ")).toContain("replacement writer identity was lost");
  });

  it("fails closed when a restoring phase loses its replacement writer identity", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        needsMaintenance: true,
        pendingMaintenance: true,
      }),
      readLaunchdLogMaintenanceIntent: async () => ({
        version: 1,
        phase: "restoring",
        label: target.label,
        plistFingerprint: "plist-identity",
      }),
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(rotations).toBe(0);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join(" ")).toContain("replacement writer identity was lost");
  });

  it("skips safely when another lifecycle command owns the lock", async () => {
    const { runner, calls } = makeRunner({ loaded: true });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      acquireLifecycleLock: async () => undefined,
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("refuses unsafe inventory before bootout or mutation", async () => {
    const { runner, calls } = makeRunner({ loaded: true });
    const target = makeTarget();
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({
        present: true,
        canMaintain: false,
        needsMaintenance: true,
        issues: ["stdout: symbolic link"],
      }),
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(rotations).toBe(0);
    expect(calls.map((call) => call[0])).not.toContain("bootout");
    expect(harness.err.join(" ")).toContain("refused unsafe paths");
  });

  it("boots out the writer, rotates under the lock, revalidates the plist, and restores only that service", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    let verifies = 0;
    let rotations = 0;
    const lifecycle: string[] = [];
    let intentPublished = false;
    const guardedRunner: LaunchctlRunner = async (args) => {
      if (args[0] === "bootout" && args[1]?.endsWith(`/${target.label}`)) {
        expect(intentPublished).toBe(true);
      }
      return await runner(args);
    };
    const harness = makeHarness({
      runner: guardedRunner,
      list: listReturning(() => []),
      isAlive: runner.isAlive,
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      verifyLaunchdPlist: async (path) => {
        expect(path).toBe(target.paths.plistPath);
        verifies += 1;
        return "plist-identity";
      },
      rotateStoppedLaunchdLogs: async () => {
        expect(runner.isLoaded(target.label)).toBe(false);
        lifecycle.push("rotate");
        rotations += 1;
      },
      beginLaunchdLogMaintenanceIntent: async () => {
        intentPublished = true;
        lifecycle.push("intent");
      },
      markLaunchdLogMaintenanceStopped: async (_paths, intent) => {
        expect(runner.isLoaded(target.label)).toBe(false);
        lifecycle.push("stopped");
        return { ...intent, phase: "stopped" };
      },
      markLaunchdLogMaintenanceRestoring: async (_paths, intent) => {
        expect(runner.isLoaded(target.label)).toBe(false);
        lifecycle.push("restoring");
        return { ...intent, phase: "restoring" };
      },
      clearLaunchdLogMaintenanceIntent: async () => { lifecycle.push("clear"); },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(0);
    expect(verifies).toBe(3);
    expect(rotations).toBe(1);
    expect(lifecycle).toEqual(["intent", "stopped", "rotate", "restoring", "clear"]);
    expect(calls.filter((call) => call[0] === "bootout")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath)).toHaveLength(1);
  });

  it("collects KeepAlive replacement pids during bootout and refuses rotation until all are dead", async () => {
    const target = makeTarget();
    const calls: string[][] = [];
    let postBootoutPrints = 0;
    let bootedOut = false;
    const runner: LaunchctlRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "bootout") {
        bootedOut = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "print") {
        if (!bootedOut) return { code: 0, stdout: "pid = 1111\n", stderr: "" };
        postBootoutPrints += 1;
        if (postBootoutPrints === 1) return { code: 0, stdout: "pid = 2222\n", stderr: "" };
        return { code: 113, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      isAlive: (pid) => pid === 2222,
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(rotations).toBe(0);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join(" ")).toContain("2222");
  });

  it("refreshes a stale service snapshot immediately before bootout", async () => {
    const target = makeTarget();
    const calls: string[][] = [];
    let prints = 0;
    let bootedOut = false;
    const runner: LaunchctlRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "print") {
        prints += 1;
        if (bootedOut) return { code: 113, stdout: "", stderr: "" };
        return { code: 0, stdout: `pid = ${prints === 1 ? 1111 : 2222}\n`, stderr: "" };
      }
      if (args[0] === "bootout") {
        bootedOut = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    let rotations = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      isAlive: (pid) => pid === 2222,
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      rotateStoppedLaunchdLogs: async () => { rotations += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(rotations).toBe(0);
    expect(calls.filter((call) => call[0] === "bootout")).toHaveLength(1);
    expect(harness.err.join(" ")).toContain("2222");
  });

  it("leaves the main service stopped and reports a failed rotation instead of looping", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    let intents = 0;
    let clears = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      rotateStoppedLaunchdLogs: async () => { throw new Error("fsync failed"); },
      beginLaunchdLogMaintenanceIntent: async () => { intents += 1; },
      clearLaunchdLogMaintenanceIntent: async () => { clears += 1; },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(calls.filter((call) => call[0] === "bootstrap")).toHaveLength(0);
    expect(intents).toBe(1);
    expect(clears).toBe(0);
    expect(harness.err.join(" ")).toContain("fsync failed");
  });

  it("unloads a replacement that never exposes a live pid instead of leaving KeepAlive looping", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      isAlive: (pid) => pid === 1111 && runner.isAlive(pid),
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
    });

    expect(await maintainLaunchdLogs(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(calls.filter((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath))
      .toHaveLength(1);
    expect(calls.filter((call) => call[0] === "bootout" && call[1]?.endsWith(`/${target.label}`)))
      .toHaveLength(2);
    expect(harness.err.join(" ")).toContain("did not expose a live replacement worker");
  });

  it("leaves the main service stopped when its plist changes across the maintenance window", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    let verifies = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      verifyLaunchdPlist: async () => {
        verifies += 1;
        return verifies === 1 ? "original-plist" : "replaced-plist";
      },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(calls.filter((call) => call[0] === "bootstrap")).toHaveLength(0);
    expect(harness.err.join(" ")).toContain("plist changed during stopped-writer maintenance");
  });

  it("stops a restored worker when the plist changes at the bootstrap boundary", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    let verifies = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      verifyLaunchdPlist: async () => {
        verifies += 1;
        return verifies < 3 ? "original-plist" : "replaced-plist";
      },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, POLL)).toBe(1);
    expect(runner.isLoaded(target.label)).toBe(false);
    expect(calls.filter((call) => call[0] === "bootstrap" && call[2] === target.paths.plistPath))
      .toHaveLength(1);
    expect(calls.filter((call) => call[0] === "bootout" && call[1]?.endsWith(`/${target.label}`)))
      .toHaveLength(2);
    expect(harness.err.join(" ")).toContain("changed while launchd restored the worker");
  });

  it("retains every restore pid when cleaning up a changed-plist worker", async () => {
    const target = makeTarget();
    const calls: string[][] = [];
    let stage: "initial" | "stopped" | "restored" | "final-stopped" = "initial";
    let restoredPrints = 0;
    const runner: LaunchctlRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "print") {
        if (stage === "initial") return { code: 0, stdout: "pid = 1111\n", stderr: "" };
        if (stage === "restored") {
          restoredPrints += 1;
          return { code: 0, stdout: `pid = ${restoredPrints === 1 ? 2222 : 3333}\n`, stderr: "" };
        }
        return { code: 113, stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") {
        stage = stage === "initial" ? "stopped" : "final-stopped";
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        stage = "restored";
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    let verifies = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      isAlive: (pid) => pid === 2222 || (pid === 3333 && stage === "restored"),
      inspectLaunchdLogs: async () => emptyLogInspection({ present: true, needsMaintenance: true }),
      verifyLaunchdPlist: async () => {
        verifies += 1;
        return verifies < 3 ? "original-plist" : "replaced-plist";
      },
    });

    expect(await maintainLaunchdLogs(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(calls.filter((call) => call[0] === "bootout")).toHaveLength(2);
    expect(harness.err.join(" ")).toContain("2222");
    expect(harness.err.join(" ")).toContain("remained alive");
  });
});

describe("restartBackground", () => {
  it("keeps one lifecycle lock across stop, stopped-worker mutation, and start", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 4321, bootstrapPid: 4321 });
    const target = makeTarget();
    let lockAcquisitions = 0;
    let lockReleases = 0;
    let lockHeld = false;
    let mutationRan = false;
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target)]),
      acquireLifecycleLock: async () => {
        lockAcquisitions += 1;
        expect(lockHeld).toBe(false);
        lockHeld = true;
        return async () => {
          expect(lockHeld).toBe(true);
          lockHeld = false;
          lockReleases += 1;
        };
      },
    });

    const code = await forceRestartBackground(target, harness.deps, async () => {
      expect(lockHeld).toBe(true);
      mutationRan = true;
    }, POLL);

    expect(code).toBe(0);
    expect(mutationRan).toBe(true);
    expect(lockAcquisitions).toBe(1);
    expect(lockReleases).toBe(1);
    expect(lockHeld).toBe(false);
  });

  it("fully boots out and bootstraps an already-loaded service so the rewritten plist is loaded", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 4321 });
    const target = makeTarget();
    const oldSource = makeSource(target, { pid: 1111, startedAt: new Date(CLOCK_START - 1).toISOString() });
    const newSource = makeSource(target, { pid: 4321, startedAt: new Date(CLOCK_START + 1).toISOString() });
    const harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap") ? [newSource] : [oldSource]),
    });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const verbs = calls.map((call) => call[0]);
    expect(verbs).toContain("bootout");
    expect(verbs).toContain("bootstrap");
    expect(verbs).not.toContain("kickstart");
    expect(harness.out.join("")).toContain("restarted in the background");
  });

  it("waits for the new worker and ignores the previous instance's manifest", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    // Even a just-started previous process is not proof that this restart is ready.
    const oldSource = makeSource(target, { startedAt: new Date(CLOCK_START - 1).toISOString(), pid: 1111 });
    const newSource = makeSource(target, { startedAt: new Date(CLOCK_START + 50).toISOString(), pid: 2222 });
    let polls = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => {
        polls += 1;
        return polls < 2 ? [oldSource] : [newSource];
      }),
    });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const stdout = harness.out.join("");
    expect(stdout).toContain("2222");
    expect(stdout).not.toContain("1111");
  });

  it("does not wait on a recycled pid from a cleanly stopped trace manifest", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    const oldSource = makeSource(target, {
      pid: 1111,
      startedAt: new Date(CLOCK_START - 1).toISOString(),
    });
    const recycledStoppedSource = makeSource(target, {
      sourceId: "historical-stopped-source",
      pid: 9999,
      health: "stopped",
      status: "stopped",
      startedAt: new Date(CLOCK_START - 10_000).toISOString(),
    });
    const newSource = makeSource(target, {
      pid: 2222,
      startedAt: new Date(CLOCK_START + 1).toISOString(),
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap")
        ? [newSource, recycledStoppedSource]
        : [oldSource, recycledStoppedSource]),
      // PID 9999 now belongs to unrelated live work. Restart must not treat a
      // historical stopped trace as ownership of that recycled process.
      isAlive: (pid) => pid === 9999 || runner.isAlive(pid),
    });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    expect(calls.map((call) => call[0])).toContain("bootstrap");
    expect(harness.err.join("")).not.toContain("9999");
  });
});

describe("stopBackground", () => {
  it("boots maintenance out before the service and removes both plists", async () => {
    const { runner, calls } = makeRunner({ loaded: true, maintenanceLoaded: true, maintenancePid: 7777 });
    const target = makeTarget();
    const existing = makeSource(target, { pid: 4321 });
    let clearedIntents = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => [existing]),
      clearLaunchdLogMaintenanceIntent: async () => { clearedIntents += 1; },
    });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(0);
    const bootouts = calls.filter((call) => call[0] === "bootout").map((call) => call[1]);
    expect(bootouts[0]).toContain("com.mono-agent-maintenance.");
    expect(bootouts[1]).toContain(target.label);
    expect(harness.removed).toContain(
      resolve(target.paths.launchAgentsDir, "com.mono-agent-maintenance.demo-0a1b2c3d.plist"),
    );
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.removed).toContain(resolve(target.registryDir, `${existing.sourceId}.json`));
    expect(harness.out.join("")).toContain("Stopped");
    expect(clearedIntents).toBe(1);
  });

  it("fails closed on an invalidated maintenance phase whose launchd writer is already gone", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      readLaunchdLogMaintenanceIntent: async () => ({
        version: 1,
        phase: "stopping",
        label: target.label,
        plistFingerprint: "plist-identity",
      }),
    });

    expect(await stopBackground(target, harness.deps, POLL)).toBe(1);
    expect(calls.map((call) => call[0])).not.toContain("bootout");
    expect(harness.removed).toEqual([]);
    expect(harness.err.join(" ")).toContain("without stopped-writer proof");
  });

  it("invalidates and renews a stopped phase around explicit-stop PID proof", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 4321 });
    const target = makeTarget();
    const stoppedIntent = {
      version: 1 as const,
      phase: "stopped" as const,
      label: target.label,
      plistFingerprint: "plist-identity",
    };
    const lifecycle: string[] = [];
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      readLaunchdLogMaintenanceIntent: async () => stoppedIntent,
      markLaunchdLogMaintenanceStopping: async (_paths, expected) => {
        lifecycle.push("stopping");
        return { ...expected, phase: "stopping" };
      },
      markLaunchdLogMaintenanceStopped: async (_paths, expected) => {
        expect(runner.isLoaded(target.label)).toBe(false);
        lifecycle.push("stopped");
        return { ...expected, phase: "stopped" };
      },
      clearLaunchdLogMaintenanceIntent: async (_paths, expected) => {
        expect(expected?.phase).toBe("stopped");
        lifecycle.push("clear");
      },
    });

    expect(await stopBackground(target, harness.deps, POLL)).toBe(0);
    expect(lifecycle).toEqual(["stopping", "stopped", "clear"]);
  });

  it("preserves both definitions and never touches the main service when maintenance cannot stop", async () => {
    const { runner, calls } = makeRunner({
      loaded: true,
      maintenanceLoaded: true,
      maintenancePid: 7777,
      maintenanceBootoutKeepsLoaded: true,
    });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      isAlive: (pid) => pid === 4321 || pid === 7777,
    });

    expect(await stopBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(calls.filter((call) => call[0] === "bootout" && call[1]?.endsWith(`/${target.label}`))).toHaveLength(0);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    expect(harness.removed).not.toContain(
      resolve(target.paths.launchAgentsDir, "com.mono-agent-maintenance.demo-0a1b2c3d.plist"),
    );
    expect(harness.err.join(" ")).toContain("Failed to stop scheduled log maintenance");
  });

  it("tolerates a not-loaded bootout and unlinks a dead instance's manifest", async () => {
    const { runner } = makeRunner({ loaded: false, bootoutCode: 3 });
    const target = makeTarget();
    const existing = makeSource(target, { pid: 4321, health: "stale" });
    const harness = makeHarness({ runner, list: listReturning(() => [existing]), isAlive: () => false });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(0);
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.removed).toContain(resolve(target.registryDir, `${existing.sourceId}.json`));
    expect(harness.out.join("")).toContain("was not running");
  });

  it("reports failure when bootout errors and the service is still loaded", async () => {
    const { runner } = makeRunner({
      loaded: true,
      bootoutCode: 1,
      bootoutKeepsLoaded: true,
      maintenanceLoaded: true,
    });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]), isAlive: () => true });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(1);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain("Failed to prove");
    expect(harness.err.join("")).toContain("plists were preserved");
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(true);
  });

  it("preserves both definitions and reports when helper restoration also fails", async () => {
    const { runner, calls } = makeRunner({
      loaded: true,
      bootoutCode: 1,
      bootoutKeepsLoaded: true,
      maintenanceLoaded: true,
      maintenancePid: 7777,
      maintenanceBootstrapCode: 5,
    });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]) });

    expect(await stopBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    const mutations = calls.filter((call) => call[0] === "bootout" || call[0] === "bootstrap");
    expect(mutations.map((call) => call[0])).toEqual(["bootout", "bootout", "bootstrap"]);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    expect(harness.removed).not.toContain(
      resolve(target.paths.launchAgentsDir, "com.mono-agent-maintenance.demo-0a1b2c3d.plist"),
    );
    expect(runner.isLoaded(target.label)).toBe(true);
    expect(runner.isLoaded("com.mono-agent-maintenance.demo-0a1b2c3d")).toBe(false);
    expect(harness.err.join(" ")).toContain("Scheduled log maintenance also could not be restored");
  });

  it("preserves the plist when launchd unloads but the recorded worker pid remains alive", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 4321 });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      isAlive: () => true,
    });

    expect(await stopBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain(`${target.label} pid(s) 4321 remained alive`);
  });
});

describe("statusBackground", () => {
  it("prints this config's instance plus a brief list of others", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, { pid: 4321 });
    const other = makeSource(target, {
      configPath: "/work/other/mono-agent.config.json",
      sourceId: "mono-agent-999999999999",
      pid: 9999,
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current, other]) });

    const code = await statusBackground(target, harness.deps);

    expect(code).toBe(0);
    const stdout = harness.out.join("");
    expect(stdout).toContain(target.label);
    expect(stdout).toContain("4321");
    expect(stdout).toContain("Other mono-agent instances");
    expect(stdout).toContain("/work/other/mono-agent.config.json");
  });

  it("emits a flat JSON envelope with the instance record and others in --json mode", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      pid: 4321,
      metadata: {
        reason: "startup-complete",
        observability: { endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false },
        channels: { telegram: { kind: "running" } },
      },
    });
    const other = makeSource(target, {
      configPath: "/work/other/mono-agent.config.json",
      sourceId: "mono-agent-999999999999",
      pid: 9999,
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [current, other]),
      listRecordedRuns: async () => ({ totalRuns: 7, runs: [], warnings: [] }),
    });

    const code = await statusBackground(target, harness.deps, { json: true });

    expect(code).toBe(0);
    const stdout = harness.out.join("");
    // stdout is exactly one JSON object with no ANSI escape (ESC) sequences.
    expect(stdout).not.toContain(String.fromCharCode(27));
    const parsed = JSON.parse(stdout) as {
      readonly ok: boolean;
      readonly instance: {
        readonly pid: number;
        readonly health: string;
        readonly configPath: string;
        readonly logs: { readonly stdout: string; readonly stderr: string };
        readonly observability?: { readonly endpoint: string };
        readonly channels?: Record<string, unknown>;
        readonly runsHealth: { readonly totalRuns: number } | null;
      } | null;
      readonly others: readonly { readonly sourceId: string; readonly configPath?: string }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.instance?.pid).toBe(4321);
    expect(parsed.instance?.health).toBe("running");
    expect(parsed.instance?.configPath).toBe(target.configPath);
    expect(parsed.instance?.logs.stdout).toBe(target.paths.stdoutPath);
    expect(parsed.instance?.observability?.endpoint).toBe("http://127.0.0.1:6006/v1/traces");
    expect(parsed.instance?.channels).toMatchObject({ telegram: { kind: "running" } });
    expect(parsed.instance?.runsHealth?.totalRuns).toBe(7);
    expect(parsed.others.some((entry) => entry.sourceId === "mono-agent-999999999999")).toBe(true);
  });

  it("emits ok:false with instance:null and exit 1 when no instance is running in --json mode", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const code = await statusBackground(target, harness.deps, { json: true });

    expect(code).toBe(1);
    const parsed = JSON.parse(harness.out.join("")) as { readonly ok: boolean; readonly instance: unknown; readonly others: readonly unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.instance).toBeNull();
    expect(parsed.others).toEqual([]);
  });

  it("makes launchd authoritative and removes cached live channel facts when the worker is inactive", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const cached = makeSource(target, {
      pid: 4321,
      transports: ["http://127.0.0.1:9999"],
      metadata: {
        reason: "startup-complete",
        channels: {
          tui: { kind: "running", baseUrl: "http://127.0.0.1:9999" },
          webhook: { kind: "running", invokeUrls: { event: "http://127.0.0.1:9998/hook" } },
          slack: { kind: "waiting_for_config", reason: "Missing appToken" },
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [cached]) });

    expect(await statusBackground(target, harness.deps, { json: true })).toBe(1);
    const parsed = JSON.parse(harness.out.join("")) as {
      readonly ok: boolean;
      readonly instance: Record<string, unknown> & {
        readonly pid: number | null;
        readonly health: string;
        readonly channels: Record<string, unknown>;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.instance.pid).toBeNull();
    expect(parsed.instance.health).toBe("stopped");
    expect(parsed.instance).not.toHaveProperty("transports");
    expect(parsed.instance.channels).toEqual({
      tui: { kind: "stopped", reason: "instance is not running" },
      webhook: { kind: "stopped", reason: "instance is not running" },
      slack: { kind: "waiting_for_config", reason: "Missing appToken" },
    });
    expect(JSON.stringify(parsed)).not.toContain("127.0.0.1:9999");
    expect(JSON.stringify(parsed)).not.toContain("127.0.0.1:9998");
  });

  it.skipIf(process.platform === "win32")("recognizes a legacy trace source recorded through a symlinked config alias", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-status-alias-"));
    try {
      const agent = join(home, "agent");
      const alias = join(home, "agent-alias");
      await mkdir(agent, { mode: 0o700 });
      const canonicalConfig = join(agent, "mono-agent.config.json");
      await writeFile(canonicalConfig, "{}\n", "utf8");
      await symlink(agent, alias, "dir");

      const target = makeTarget({
        cwd: await realpath(agent),
        configPath: await realpath(canonicalConfig),
      });
      const legacy = makeSource(target, {
        configPath: join(alias, "mono-agent.config.json"),
      });
      const { runner } = makeRunner({ loaded: true });
      const harness = makeHarness({ runner, list: listReturning(() => [legacy]) });

      expect(await statusBackground(target, harness.deps)).toBe(0);
      const stdout = harness.out.join("");
      expect(stdout).toContain(target.label);
      expect(stdout).not.toContain("No running mono-agent instance");
      expect(stdout).not.toContain("Other mono-agent instances");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prints the observability exporter line with the local-artifacts note", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        observability: {
          endpoint: "http://127.0.0.1:6006/v1/traces",
          includeSensitiveData: false,
          jsonlArtifactsLocal: true,
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("observability");
    expect(stdout).toContain("http://127.0.0.1:6006/v1/traces");
    expect(stdout).toContain("JSONL artifacts remain local");
    expect(stdout).not.toContain("[WARN] includeSensitiveData=true");
  });

  it("prints a warning from persisted observability metadata when sensitive data export is enabled", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const endpoint = "http://127.0.0.1:6006/v1/traces";
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        observability: {
          endpoint,
          includeSensitiveData: true,
          jsonlArtifactsLocal: true,
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("[WARN] includeSensitiveData=true");
    expect(stdout).toContain(endpoint);
    expect(stdout).toContain("user input");
    expect(stdout).toContain("assistant replies");
    expect(stdout).toContain("tool args/results");
    expect(stdout).toContain("system prompt");
  });

  it("prints effective sandbox state from persisted metadata", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        sandbox: {
          configured: true,
          configuredMode: "native",
          effective: "unsafe-host-process",
          engine: "srt",
          engineAvailable: false,
          fallback: "unsafe-host-process",
          fallbackActive: true,
          unsafeAllowHostProcess: true,
          detail:
            "Sandbox unsafe-host-process fallback is active because engine \"srt\" is unavailable; all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
          warning:
            "WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("sandbox");
    expect(stdout).toContain("effective: unsafe-host-process");
    expect(stdout).toContain("engine: srt (absent)");
    expect(stdout).toContain("fallback active: yes");
    expect(stdout).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(stdout).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");
  });

  it("prints session status from persisted trace-source metadata", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "session-saved",
        session: {
          currentBucketId: "telegram:123#2026-07-06",
          state: "warm",
          event: "saved",
          providerSessionId: "ps-123",
          createdAt: CLOCK_START - 90_000,
          lastActivityAt: CLOCK_START - 1_000,
          snapshot: [{
            conversationId: "telegram:123#2026-07-06",
            providerSessionId: "ps-123",
            createdAt: CLOCK_START - 90_000,
            lastActivityAt: CLOCK_START - 1_000,
            busy: false,
          }],
          updatedAt: new Date(CLOCK_START).toISOString(),
          nextRolloverAt: "2026-07-07T00:00:00.000Z",
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("session");
    expect(stdout).toContain("bucket: telegram:123#2026-07-06");
    expect(stdout).toContain("state: warm");
    expect(stdout).toContain("age: 1m");
    expect(stdout).toContain("event: saved");
    expect(stdout).toContain("provider: ps-123");
    expect(stdout).toContain("next rollover: 2026-07-07T00:00:00.000Z");
  });

  it("derives cold status from an empty session snapshot while preserving eviction detail", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "session-evicted",
        session: {
          currentBucketId: "telegram:123#2026-07-06",
          state: "warm",
          event: "evicted",
          reason: "idle_timeout",
          providerSessionId: "ps-old",
          snapshot: [],
          updatedAt: new Date(CLOCK_START).toISOString(),
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("bucket: telegram:123#2026-07-06");
    expect(stdout).toContain("state: cold");
    expect(stdout).toContain("event: evicted");
    expect(stdout).toContain("reason: idle_timeout");
  });

  it("prints runs-health explanations from recent local summaries", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        context: {
          selectedSkills: ["context-example", "todoist-cli"],
        },
      },
    });
    const startedAt = new Date(CLOCK_START - 5 * 60_000).toISOString();
    const runs: RecordedRunListItem[] = [
      makeRun({ runId: "run-live", status: "running", startedAt, updatedAt: startedAt }),
      makeRun({ runId: "run-usage", status: "failed", failureKind: "usage_limit", startedAt }),
      makeRun({ runId: "run-process", status: "interrupted", failureKind: "process_death", startedAt }),
      makeRun({ runId: "run-cancelled", status: "cancelled", startedAt }),
      makeRun({ runId: "run-provider-error", status: "failed", failureKind: "provider_error", startedAt }),
    ];
    const harness = makeHarness({
      runner,
      list: listReturning(() => [current]),
      listRecordedRuns: async (options) => {
        expect(options.artifactDir).toBe(current.artifactDir);
        expect(options.maxRuns).toBe(50);
        expect(options.scope).toBe("agent");
        return { totalRuns: 12, runs, warnings: [] };
      },
      isAlive: () => false,
    });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("runs health");
    expect(stdout).toContain("Active skills: context-example, todoist-cli.");
    expect(stdout).toContain("Recorded runs: 12 total; showing 5 recent (max 50).");
    expect(stdout).toContain("Last runs: run-live running 5m ago");
    expect(stdout).toContain("Recent status counts: running=1, succeeded=0, failed=2, cancelled=1, interrupted=1.");
    expect(stdout).not.toContain("Running summaries while process is gone");
    expect(stdout).toContain("Usage limit [usage_limit, 1 recent]");
    expect(stdout).toContain("Process death [process_death, 1 recent]");
    expect(stdout).toContain("Cancelled [cancelled, 1 recent]");
    expect(stdout).toContain("Unclassified failure (provider_error) [provider_error (unclassified), 1 recent]");
    expect(stdout).toContain("The runtime hit a provider usage, quota, output-token, or turn limit");
    expect(stdout).toContain("not yet part of the documented display taxonomy");
  });

  it("returns non-zero when no instance is running for this config", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const code = await statusBackground(target, harness.deps);

    expect(code).toBe(1);
    expect(harness.out.join("")).toContain("No running mono-agent instance");
  });

  it("includes --config in the start hint for a non-default config", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget({ configPath: "/work/demo/custom.json" });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await statusBackground(target, harness.deps);

    expect(harness.out.join("")).toContain("mono-agent start --config /work/demo/custom.json");
  });

  it("preserves the explicit env file in a stopped-instance start hint", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget({ envFile: "/work/demo/.env.operator" });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await statusBackground(target, harness.deps);

    expect(harness.out.join("")).toContain("mono-agent start --env-file /work/demo/.env.operator");
  });
});

function makeRun(overrides: Partial<RecordedRunListItem>): RecordedRunListItem {
  return {
    runId: "run",
    conversationId: "chat",
    status: "succeeded",
    durationMs: 1000,
    eventCount: 1,
    updatedAt: new Date(CLOCK_START).toISOString(),
    ...overrides,
  };
}

describe("tailLogs", () => {
  it("tails the error then output log, following when asked", async () => {
    const target = makeTarget();
    const harness = makeHarness({ runner: makeRunner({ loaded: true }).runner, list: listReturning(() => []) });

    const code = await tailLogs(target, harness.deps, { follow: true, lines: 50 });

    expect(code).toBe(0);
    expect(harness.tailCalls[0]).toEqual(["-n", "50", "-F", target.paths.stderrPath, target.paths.stdoutPath]);
  });

  it("omits -F when not following", async () => {
    const target = makeTarget();
    const harness = makeHarness({ runner: makeRunner({ loaded: true }).runner, list: listReturning(() => []) });

    await tailLogs(target, harness.deps, { follow: false, lines: 200 });

    expect(harness.tailCalls[0]).toEqual(["-n", "200", target.paths.stderrPath, target.paths.stdoutPath]);
  });
});

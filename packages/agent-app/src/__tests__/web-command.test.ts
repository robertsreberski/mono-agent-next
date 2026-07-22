import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseTailscaleHttpsPort,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  ensureTailscaleServe,
  MANAGED_WEB_WORKER_ENV,
  removeOwnedTailscaleServe,
  rolloverManagedWebLogs,
  runWebCommand,
  tailscaleProxyTarget,
  webHealthcheck,
  webPaths,
  WEB_LAUNCHD_LABEL,
} from "../web-command.js";
import type { CommandRunner } from "../web-command.js";
import { LAUNCHD_LOG_MAX_BYTES } from "../launchd-logs.js";

let dir: string | undefined;

const prepareState = async (options: { readonly stateDir?: string }) => {
  if (options.stateDir !== undefined) await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function testHome(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-web-command-"));
  return dir;
}

describe("runWebCommand", () => {
  it("keeps bare web read-only while showing status and subcommand help", async () => {
    const home = await testHome();
    let output = "";
    const startServer = vi.fn();
    const resetState = vi.fn();
    const code = await runWebCommand(
      { positionals: [], env: {} },
      {
        platform: "linux",
        homeDir: home,
        discoverNetworkAddresses: () => [
          "203.0.113.9",
          "192.168.2.42",
          "100.64.0.7",
          "fd7a:115c:a1e0::7",
          "2001:4860:4860::8888",
          "fe80::7",
          "fe80::7%en0",
          "192.168.2.42",
        ],
        stdout: { write: (text) => { output += text; } },
        startServer,
        resetState,
      },
    );

    expect(code).toBe(0);
    expect(output).toContain("mono-agent web start");
    expect(output).toContain("service");
    expect(output).toContain("stopped");
    expect(output).toContain("http://127.0.0.1:5050/");
    expect(output).toContain("http://192.168.2.42:5050/");
    expect(output).toContain("http://100.64.0.7:5050/");
    expect(output).not.toContain("fd7a:115c:a1e0::7");
    expect(output.match(/http:\/\/192\.168\.2\.42:5050\//gu)).toHaveLength(1);
    expect(output).not.toContain("203.0.113.9");
    expect(output).not.toContain("2001:4860:4860::8888");
    expect(output).not.toContain("http://[fe80::7]:5050/");
    expect(output).not.toContain("fe80::7%25en0");
    expect(output).not.toContain("http://0.0.0.0:5050/");
    expect(startServer).not.toHaveBeenCalled();
    expect(resetState).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it("prints only reachable IPv6 URLs for an IPv6 wildcard bind", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    let output = "";
    const stop = vi.fn(async () => undefined);
    const startServer = vi.fn(async () => ({ url: "http://[::]:5050/", host: "::", port: 5050, stop }));

    const code = await runWebCommand(
      { positionals: ["run"], host: "::", env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir } },
      {
        homeDir: home,
        prepareState,
        startServer,
        waitForShutdown: async () => undefined,
        discoverNetworkAddresses: () => ["192.168.2.42", "100.64.0.7", "fd7a:115c:a1e0::7"],
        stdout: { write: (text) => { output += text; } },
      },
    );

    expect(code).toBe(0);
    expect(output).toContain("http://[::1]:5050/");
    expect(output).toContain("Tailscale  → http://[fd7a:115c:a1e0::7]:5050/");
    expect(output).not.toContain("192.168.2.42");
    expect(output).not.toContain("100.64.0.7");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("runs foreground on the LAN default without adding authentication", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    const stop = vi.fn(async () => undefined);
    const startServer = vi.fn(async (options) => ({
      url: "http://0.0.0.0:5050/",
      host: "0.0.0.0",
      port: 5050,
      stop,
      options,
    }));

    const code = await runWebCommand(
      {
        positionals: ["run"],
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
      },
      {
        homeDir: home,
        prepareState,
        startServer,
        waitForShutdown: async () => undefined,
        discoverNetworkAddresses: () => ["192.0.2.42"],
        stdout: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
      registryDirs: [registryDir],
    }));
    expect(startServer.mock.calls[0]?.[0]).not.toHaveProperty("authToken");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops with a restart exit when a managed worker requests log rollover", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    const stop = vi.fn(async () => undefined);
    const rolloverManagedLogs = vi.fn(async () => undefined);

    await expect(runWebCommand(
      {
        positionals: ["run"],
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir,
          [MANAGED_WEB_WORKER_ENV]: "1",
        },
      },
      {
        homeDir: home,
        prepareState,
        startServer: async () => ({ url: "http://127.0.0.1:5050/", stop }),
        waitForShutdown: async () => await new Promise<void>(() => undefined),
        waitForManagedLogRollover: async () => "rollover",
        rolloverManagedLogs,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(75);

    expect(stop).toHaveBeenCalledOnce();
    expect(rolloverManagedLogs).toHaveBeenCalledOnce();
  });

  it("retains a bounded tail and fixed generations for managed web logs", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.launchd.stdoutPath,
      Buffer.concat([Buffer.alloc(128, "a"), Buffer.alloc(LAUNCHD_LOG_MAX_BYTES, "b")]),
      { mode: 0o600 },
    );
    await writeFile(`${paths.launchd.stdoutPath}.1`, "older-one", { mode: 0o600 });
    await writeFile(`${paths.launchd.stdoutPath}.2`, "older-two", { mode: 0o600 });

    await rolloverManagedWebLogs(paths);

    await expect(stat(paths.launchd.stdoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(`${paths.launchd.stdoutPath}.1`)).size).toBe(LAUNCHD_LOG_MAX_BYTES);
    expect(await readFile(`${paths.launchd.stdoutPath}.1`, "utf8")).toMatch(/^b+$/u);
    expect(await readFile(`${paths.launchd.stdoutPath}.2`, "utf8")).toBe("older-one");
    expect(await readFile(`${paths.launchd.stdoutPath}.3`, "utf8")).toBe("older-two");
  });

  it("maps --loopback to 127.0.0.1 and rejects combining it with --host", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    const startServer = vi.fn(async () => ({
      url: "http://127.0.0.1:5050/",
      stop: async () => undefined,
    }));
    await expect(runWebCommand(
      { positionals: ["run"], env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir }, loopback: true },
      { homeDir: home, prepareState, startServer, waitForShutdown: async () => undefined, stdout: { write: () => undefined } },
    )).resolves.toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1" }));

    let errors = "";
    await expect(runWebCommand(
      { positionals: ["start"], env: {}, loopback: true, host: "0.0.0.0" },
      { stderr: { write: (text) => { errors += text; } }, stdout: { write: () => undefined } },
    )).resolves.toBe(2);
    expect(errors).toContain("either --loopback or --host");
  });

  it("requires explicit double confirmation before reset", async () => {
    const resetState = vi.fn();
    await expect(runWebCommand(
      { positionals: ["reset"], env: {}, all: true },
      { resetState, stdout: { write: () => undefined }, stderr: { write: () => undefined } },
    )).resolves.toBe(2);
    expect(resetState).not.toHaveBeenCalled();
  });

  it("boots out a running worker without preparing its contended state", async () => {
    const home = await testHome();
    let loaded = true;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") {
        return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const prepareContendedState = vi.fn(async () => {
      throw new Error("web state lease is already active");
    });

    await expect(runWebCommand(
      { positionals: ["stop"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        launchctl,
        prepareState: prepareContendedState,
        acquireLifecycleLock: async () => async () => undefined,
        isAlive: () => false,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(0);

    expect(prepareContendedState).not.toHaveBeenCalled();
    expect(calls.map((args) => args[0])).toContain("bootout");
  });

  it("surfaces the web package's shared-state lease for concurrent ports and reset", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    let finish: (() => void) | undefined;
    const waitForShutdown = () => new Promise<void>((resolvePromise) => { finish = resolvePromise; });
    let stateBusy = false;
    const startServer = vi.fn(async () => {
      if (stateBusy) throw new Error("web state lease is already active");
      stateBusy = true;
      return {
        url: "http://127.0.0.1:5050/",
        stop: async () => { stateBusy = false; },
      };
    });
    const first = runWebCommand(
      {
        positionals: ["run"],
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
        loopback: true,
      },
      { homeDir: home, prepareState, startServer, waitForShutdown, stdout: { write: () => undefined } },
    );
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledOnce());

    await expect(runWebCommand(
      {
        positionals: ["run"],
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
        host: "127.0.0.1",
        port: 5051,
      },
      { homeDir: home, prepareState, startServer, stderr: { write: () => undefined } },
    )).resolves.toBe(1);
    expect(startServer).toHaveBeenCalledTimes(2);

    const resetState = vi.fn(async () => {
      if (stateBusy) throw new Error("web state lease is already active");
    });
    await expect(runWebCommand(
      { positionals: ["reset"], env: {}, all: true, yes: true },
      {
        platform: "linux",
        homeDir: home,
        prepareState,
        resetState,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(1);
    expect(resetState).toHaveBeenCalledOnce();

    finish?.();
    await expect(first).resolves.toBe(0);
  });

  it("restores Tailscale ownership if a reset implementation tries to erase lifecycle metadata", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    const ownership = "{\"schema\":\"test-owned-route\"}\n";
    await writeFile(paths.tailscalePath, ownership, { mode: 0o600 });
    const code = await runWebCommand(
      { positionals: ["reset"], env: {}, all: true, yes: true },
      {
        platform: "linux",
        homeDir: home,
        prepareState,
        resetState: async () => { await rm(paths.tailscalePath); },
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );
    expect(code).toBe(1);
    expect(await readFile(paths.tailscalePath, "utf8")).toBe(ownership);
  });

  it("restores and reboots the previous worker when a restart replacement never becomes healthy", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { mode: 0o700 });
    const oldPlist = "old verified plist\n";
    const oldRecord = `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }, undefined, 2)}\n`;
    await writeFile(paths.launchd.plistPath, oldPlist, { mode: 0o600 });
    await writeFile(paths.recordPath, oldRecord, { mode: 0o600 });

    let loaded = true;
    let alive = true;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") {
        return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        alive = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        loaded = true;
        alive = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let clock = 0;
    let errors = "";
    const code = await runWebCommand(
      { positionals: ["restart"], env: {}, loopback: true, port: 5051 },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        healthcheck: async (url) => url.includes(":5050/"),
        isAlive: () => alive,
        now: () => { clock += 20_000; return clock; },
        sleep: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(oldPlist);
    expect(await readFile(paths.recordPath, "utf8")).toBe(oldRecord);
    expect(calls.filter((args) => args[0] === "bootstrap")).toHaveLength(2);
    expect(errors).toContain("previous web worker is running again");
  });

  it("refuses a malformed service record without overwriting it or launching", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await writeFile(paths.recordPath, "{broken\n", { mode: 0o600 });
    const ensureManagedRuntime = vi.fn();
    const launchctl = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not loaded" }));
    let errors = "";

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        ensureManagedRuntime,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(errors).toContain("service record is malformed");
    expect(await readFile(paths.recordPath, "utf8")).toBe("{broken\n");
    expect(ensureManagedRuntime).not.toHaveBeenCalled();
    expect(launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootstrap"]));
  });

  it("removes a partial first-start publication when the plist write fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let writes = 0;
    const writePrivateFile = async (path: string, contents: string) => {
      writes += 1;
      if (writes === 2) throw new Error("plist disk failure");
      await writeFile(path, contents, { mode: 0o600 });
    };
    const launchctl = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not loaded" }));

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        writePrivateFile,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(1);
    await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootstrap"]));
  });

  it("pins the node's exact Tailscale DNS hostname into the worker before claiming Serve", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let loaded = false;
    const launchctl = async (args: readonly string[]) => {
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const claimRunner = scriptedClaimRunner();
    let dnsReads = 0;
    const tailscale: CommandRunner = async (args) => {
      if (args[0] === "status" && dnsReads++ === 0) {
        return { code: 1, stdout: "", stderr: "transient LocalAPI failure" };
      }
      return claimRunner(args);
    };
    const sleep = vi.fn(async () => undefined);
    const code = await runWebCommand(
      { positionals: ["start"], env: { MONO_AGENT_WEB_ALLOWED_HOSTS: "console.home.arpa" } },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale,
        sleep,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        healthcheck: async () => true,
        isAlive: () => loaded,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(dnsReads).toBeGreaterThanOrEqual(2);
    const plist = await readFile(paths.launchd.plistPath, "utf8");
    expect(plist).toContain("<string>MONO_AGENT_WEB_ALLOWED_HOSTS=console.home.arpa,host.example.ts.net</string>");
  });

  it("retains an exact owned Tailscale hostname when LocalAPI status is transiently unavailable", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "Library"), { mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });

    let loaded = false;
    const launchctl = async (args: readonly string[]) => {
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const tailscale = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "status") return { code: 1, stdout: "", stderr: "LocalAPI unavailable" };
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
          }),
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    let output = "";

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale,
        sleep: async () => undefined,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        healthcheck: async () => true,
        isAlive: () => loaded,
        stdout: { write: (text) => { output += text; } },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(await readFile(paths.launchd.plistPath, "utf8"))
      .toContain("<string>MONO_AGENT_WEB_ALLOWED_HOSTS=host.example.ts.net</string>");
    expect(output).toContain("https://host.example.ts.net/ (existing owned handler)");
    expect(tailscale.mock.calls.filter(([args]) => args[0] === "status")).toHaveLength(3);
  });

  it("boots out a partially loaded first start and removes its artifacts after bootstrap failure", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let loaded = false;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 1, stdout: "", stderr: "bootstrap failed after load" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let errors = "";

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        isAlive: () => false,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(errors).toContain("launchctl could not start");
    expect(loaded).toBe(false);
    expect(calls.map((args) => args[0])).toContain("bootout");
    await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops a crash-looping first start and removes its artifacts after readiness timeout", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let loaded = false;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let clock = 0;

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        healthcheck: async () => false,
        isAlive: () => false,
        now: () => { clock += 20_000; return clock; },
        sleep: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(1);
    expect(loaded).toBe(false);
    expect(calls.some((args) => args[0] === "bootout")).toBe(true);
    await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls worker, service record, plist, and Tailnet route back to 5050 when a 5051 migration claim fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const oldPlist = "old 5050 plist\n";
    const oldRecord = `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "0.0.0.0",
      port: 5050,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }, undefined, 2)}\n`;
    await writeFile(paths.launchd.plistPath, oldPlist, { mode: 0o600 });
    await writeFile(paths.recordPath, oldRecord, { mode: 0o600 });

    let loaded = true;
    let currentTarget: string | undefined = "http://127.0.0.1:5050";
    const launchCalls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      launchCalls.push([...args]);
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const tailscale: CommandRunner = async (args) => {
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(currentTarget === undefined ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: currentTarget } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        if (args[3] === "http://127.0.0.1:5051") return { code: 1, stdout: "", stderr: "claim failed" };
        currentTarget = args[3];
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const code = await runWebCommand(
      { positionals: ["restart"], env: {}, port: 5051 },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/cli.js", nodePath: "/managed/node" }),
        healthcheck: async () => true,
        isAlive: () => loaded,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(1);
    expect(loaded).toBe(true);
    expect(currentTarget).toBe("http://127.0.0.1:5050");
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(oldPlist);
    expect(await readFile(paths.recordPath, "utf8")).toBe(oldRecord);
    expect(await readFile(paths.tailscalePath, "utf8")).toContain("http://127.0.0.1:5050");
    expect(launchCalls.filter((args) => args[0] === "bootstrap")).toHaveLength(2);
  });
});

describe("webHealthcheck", () => {
  it("accepts only the exact versioned JSON health contract", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(new Response("unrelated service", { status: 200, headers: { "content-type": "text/plain" } }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: 1, extra: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: 1 }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(true);
  });
});

describe("Tailscale Serve ownership", () => {
  it("prefers 443, then the first free port in 8443-8499", () => {
    expect(chooseTailscaleHttpsPort({ TCP: {} })).toBe(443);
    expect(chooseTailscaleHttpsPort({ TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } } })).toBe(8444);
    const full = Object.fromEntries([443, ...Array.from({ length: 57 }, (_, index) => 8443 + index)]
      .map((port) => [String(port), { HTTPS: true }]));
    expect(chooseTailscaleHttpsPort({ TCP: full })).toBeUndefined();
  });

  it("uses a loopback proxy only when the configured bind can receive it", async () => {
    expect(tailscaleProxyTarget("0.0.0.0", 5050)).toBe("http://127.0.0.1:5050");
    expect(tailscaleProxyTarget("127.0.0.1", 5050)).toBe("http://127.0.0.1:5050");
    expect(tailscaleProxyTarget("::", 5050)).toBe("http://[::1]:5050");
    expect(tailscaleProxyTarget("::1", 5050)).toBe("http://[::1]:5050");
    expect(tailscaleProxyTarget("localhost", 5050)).toBeUndefined();
    expect(tailscaleProxyTarget("192.0.2.42", 5050)).toBeUndefined();
    expect(tailscaleProxyTarget("2001:db8::42", 5050)).toBeUndefined();

    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    const runner = vi.fn<CommandRunner>();
    const result = await ensureTailscaleServe(paths, "192.0.2.42", 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("claims 8443 without overwriting an existing 443 handler", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let serveStatusReads = 0;
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: CommandRunner = vi.fn(async (args) => {
      mutableCalls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        serveStatusReads += 1;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(serveStatusReads === 1
            ? {
                TCP: { "443": { HTTPS: true } },
                Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4599" } } } },
              }
            : {
                TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
                Web: {
                  "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4599" } } },
                  "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } },
                },
              }),
        };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { tailscale: runner, homeDir: home });
    expect(result).toMatchObject({ kind: "active", reused: false, ownership: { httpsPort: 8443 } });
    expect(mutableCalls).toContainEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:5050"]);
    expect(mutableCalls).not.toContainEqual(expect.arrayContaining(["reset"]));
    expect(await readFile(paths.tailscalePath, "utf8")).toContain("host.example.ts.net:8443");
  });

  it("removes only an exact owned route and refuses a changed handler", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const off = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
          }),
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await removeOwnedTailscaleServe(paths, { homeDir: home, tailscale: off });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(off).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
    await expect(stat(paths.tailscalePath)).resolves.toBeDefined();
  });

  it("refuses post-claim ownership when a sibling handler appears in the immediate status", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let statusReads = 0;
    const runner = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        statusReads += 1;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(statusReads === 1 ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: {
              "host.example.ts.net:443": {
                Handlers: {
                  "/": { Proxy: "http://127.0.0.1:5050" },
                  "/user-added": { Proxy: "http://127.0.0.1:7000" },
                },
              },
            },
          }),
        };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("root Proxy-only shape");
    expect(runner).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a malformed ownership record without touching Tailscale", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.tailscalePath, "{not-json\n", { mode: 0o600 });
    const runner = vi.fn<CommandRunner>();

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("malformed");
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(paths.tailscalePath, "utf8")).toBe("{not-json\n");
  });

  it("clears an ownership record only after confirming its exact route is absent twice", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const runner = vi.fn<CommandRunner>(async (args) => args[0] === "serve" && args[1] === "status"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {}, Web: {} }) }
      : { code: 1, stderr: "unexpected mutation", stdout: "" });

    await expect(removeOwnedTailscaleServe(paths, { homeDir: home, tailscale: runner })).resolves.toEqual({ kind: "absent" });
    expect(runner.mock.calls.filter(([args]) => args[0] === "serve" && args[1] === "status")).toHaveLength(2);
    expect(runner).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to turn off a port when a sibling handler was added after ownership", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const runner = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: {
              "host.example.ts.net:443": {
                Handlers: {
                  "/": { Proxy: "http://127.0.0.1:5050" },
                  "/user-added": { Proxy: "http://127.0.0.1:7000" },
                },
              },
            },
          }),
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await removeOwnedTailscaleServe(paths, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(runner).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });

  it("removes the exact prior owned route before migrating to a changed app port", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });

    let currentTarget: string | undefined = "http://127.0.0.1:5050";
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(currentTarget === undefined ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: currentTarget } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        currentTarget = args[3];
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5051, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "active", ownership: { proxyTarget: "http://127.0.0.1:5051" } });
    const offIndex = calls.findIndex((args) => args.join(" ") === "serve --https=443 off");
    const claimIndex = calls.findIndex((args) => args.join(" ") === "serve --bg --https=443 http://127.0.0.1:5051");
    expect(offIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(offIndex);
    expect(await readFile(paths.tailscalePath, "utf8")).not.toContain("5050\"");
  });

  it("restores the prior exact route and ownership when a changed-port claim fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const priorContents = await readFile(paths.tailscalePath, "utf8");
    let currentTarget: string | undefined = "http://127.0.0.1:5050";
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(currentTarget === undefined ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: currentTarget } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        const requestedTarget = args[3];
        if (requestedTarget === "http://127.0.0.1:5051") {
          return { code: 1, stdout: "", stderr: "claim failed" };
        }
        currentTarget = requestedTarget;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5051, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("prior exact HTTPS route and ownership record were restored");
    expect(currentTarget).toBe("http://127.0.0.1:5050");
    expect(await readFile(paths.tailscalePath, "utf8")).toBe(priorContents);
    expect(calls).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:5051"]);
    expect(calls.filter((args) => args.join(" ") === "serve --bg --https=443 http://127.0.0.1:5050")).toHaveLength(1);
  });

  it("rolls back the exact new handler when durable ownership publication fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    const runner = vi.fn(scriptedClaimRunner());
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: runner,
      writePrivateFile: async () => { throw new Error("disk full"); },
    });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("rolled back");
    expect(runner).toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });

  it("re-verifies and rolls back an exact new handler after the first verification read fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let statusReads = 0;
    const runner: CommandRunner = vi.fn(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        statusReads += 1;
        if (statusReads === 1) return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
        if (statusReads === 2) return { code: 1, stderr: "transient status failure", stdout: "" };
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
          }),
        };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(runner).toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });
});

function scriptedClaimRunner(): CommandRunner {
  let reads = 0;
  return async (args) => {
    if (args[0] === "serve" && args[1] === "status") {
      reads += 1;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(reads === 1
          ? { TCP: {} }
          : {
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
            }),
      };
    }
    if (args[0] === "status") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function unavailableTailscaleRunner(): CommandRunner {
  return async () => ({ code: 1, stdout: "", stderr: "tailscale unavailable" });
}

describe("web service identity", () => {
  it("cannot be mistaken for a configured agent launchd label", () => {
    expect(WEB_LAUNCHD_LABEL).toBe("com.mono-agent-web");
    expect(WEB_LAUNCHD_LABEL).not.toMatch(/^com\.mono-agent\./u);
  });
});

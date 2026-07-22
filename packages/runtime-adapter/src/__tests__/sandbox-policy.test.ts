import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  SandboxUnavailableError,
  managedSrtInstallRoot,
  createSandboxPolicy,
  createSrtSandboxEngine,
  describeSandboxEffectiveState,
  failClosedSandboxPolicy,
  mergeSandboxPolicies,
  networkPolicyAllowsUrl,
  prepareSandboxedCommand,
  resolveSandboxEffectiveState,
  sandboxEffectiveStateWarning,
  sandboxPolicyToRuntimeOptions,
  sandboxRequired,
  srtSettingsForPolicy,
} from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
  tempDirs.push(dir);
  return dir;
}

async function fakeSrtExecutable(content = "#!/bin/sh\nexit 0\n"): Promise<string> {
  const root = await tempDir();
  const path = join(root, "srt");
  await writeFile(path, content, { mode: 0o700 });
  return path;
}

async function fakeProofSrtExecutable(suffix: string): Promise<{ root: string; path: string }> {
  const root = await tempDir();
  const path = join(root, "srt");
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const argv = process.argv.slice(2);",
    "const scriptIndex = argv.indexOf('-e');",
    "if (scriptIndex < 0) process.exit(91);",
    "const [allowedInput,,allowedOutput] = argv.slice(scriptIndex + 2);",
    "if (fs.readFileSync(allowedInput, 'utf8').trim() !== 'allowed') process.exit(92);",
    "fs.writeFileSync(allowedOutput, 'ok');",
    `// ${suffix}`,
  ].join("\n");
  await writeFile(path, `${script}\n`, { mode: 0o700 });
  return { root, path };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sandbox policy", () => {
  it("creates a fail-closed native sandbox with denied network by default", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });

    expect(policy).toMatchObject({
      mode: "native",
      engine: "srt",
      fallback: "fail-closed",
      root: "/repo/workspace",
      network: { mode: "none", allowlist: [] },
      readableRoots: ["/repo/workspace"],
      writableRoots: ["/repo/workspace"],
    });
    expect(sandboxRequired(policy)).toBe(true);

    expect(createSandboxPolicy({ root: "/repo/workspace" })).toMatchObject({
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
    });
  });

  it("requires an explicit unsafe host-process opt-in before fallback is allowed", () => {
    expect(() =>
      createSandboxPolicy({
        root: "/repo",
        fallback: "unsafe-host-process",
      }),
    ).toThrow(/unsafeAllowHostProcess/u);

    const policy = createSandboxPolicy({
      root: "/repo",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    expect(policy).toMatchObject({
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    expect(sandboxRequired(policy)).toBe(false);
  });

  it("serializes policy into runtime options without dropping the sandbox boundary", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    expect(sandboxPolicyToRuntimeOptions(policy)).toEqual({
      sandboxPolicy: policy,
    });
  });
});

describe("sandbox effective state", () => {
  it("reports no policy as off without a warning", async () => {
    const state = await resolveSandboxEffectiveState({});

    expect(state).toMatchObject({
      configured: false,
      configuredMode: undefined,
      effective: "off",
      engine: undefined,
      engineAvailable: undefined,
      fallback: undefined,
      fallbackActive: false,
      unsafeAllowHostProcess: false,
    });
    expect(sandboxEffectiveStateWarning(state)).toBeUndefined();
    expect(describeSandboxEffectiveState(state)).toContain("Sandbox is off");
  });

  it("reports mode off as configured false and effective off", async () => {
    const policy = createSandboxPolicy({ mode: "off", root: "/repo" });
    const state = await resolveSandboxEffectiveState({ policy });

    expect(state).toMatchObject({
      configured: false,
      configuredMode: "off",
      effective: "off",
      engine: "srt",
      engineAvailable: undefined,
      fallbackActive: false,
    });
    expect(sandboxEffectiveStateWarning(state)).toBeUndefined();
  });

  it("reports native as effective when the engine is available", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });
    const state = await resolveSandboxEffectiveState({
      policy,
      engine: {
        id: "fake",
        async isAvailable() {
          return true;
        },
        async prepareCommand() {
          throw new Error("should not prepare");
        },
      },
    });

    expect(state).toMatchObject({
      configured: true,
      configuredMode: "native",
      effective: "native",
      engine: "fake",
      engineAvailable: true,
      fallback: "fail-closed",
      fallbackActive: false,
      unsafeAllowHostProcess: false,
    });
    expect(sandboxEffectiveStateWarning(state)).toBeUndefined();
    expect(describeSandboxEffectiveState(state)).toContain("commands run sandboxed");
  });

  it("reports fail-closed native policies as blocked when the engine is unavailable", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });
    const state = await resolveSandboxEffectiveState({
      policy,
      engine: {
        id: "fake",
        async isAvailable() {
          return false;
        },
        async prepareCommand() {
          throw new Error("should not prepare");
        },
      },
    });

    expect(state).toMatchObject({
      configured: true,
      configuredMode: "native",
      effective: "blocked",
      engine: "fake",
      engineAvailable: false,
      fallback: "fail-closed",
      fallbackActive: false,
    });
    expect(sandboxEffectiveStateWarning(state)).toBeUndefined();
    expect(describeSandboxEffectiveState(state)).toContain("commands fail closed with sandbox_unavailable");
  });

  it("warns when unavailable native sandbox falls back to an unsafe host process", async () => {
    const policy = createSandboxPolicy({
      root: "/repo",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    const state = await resolveSandboxEffectiveState({
      policy,
      engine: {
        id: "fake",
        async isAvailable() {
          return false;
        },
        async prepareCommand() {
          throw new Error("should not prepare");
        },
      },
    });

    const consequence = "all sandbox roots/denyWrite entries are inert; commands run unsandboxed";
    expect(state).toMatchObject({
      configured: true,
      configuredMode: "native",
      effective: "unsafe-host-process",
      engine: "fake",
      engineAvailable: false,
      fallback: "unsafe-host-process",
      fallbackActive: true,
      unsafeAllowHostProcess: true,
    });
    expect(sandboxEffectiveStateWarning(state)).toBe(`WARNING: Unsafe sandbox fallback is active: ${consequence}.`);
    expect(describeSandboxEffectiveState(state)).toContain(consequence);
  });

  it("treats an unknown default engine as unavailable", async () => {
    const policy = createSandboxPolicy({ root: "/repo", engine: "bubblewrap" });
    const state = await resolveSandboxEffectiveState({ policy });

    expect(state).toMatchObject({
      configured: true,
      effective: "blocked",
      engine: "bubblewrap",
      engineAvailable: false,
      fallbackActive: false,
    });
    expect(sandboxEffectiveStateWarning(state)).toBeUndefined();
  });
});

describe("policy merging", () => {
  it("does not let request-level policy weaken a configured policy", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "none" },
    });
    const request = createSandboxPolicy({
      mode: "off",
      root: "/repo",
      network: { mode: "none" },
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });

    expect(mergeSandboxPolicies(configured, request)).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "none", allowlist: [] },
    });
  });

  it("intersects allowlists when both policies use allowlist networking", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com", "api.github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["api.github.com", "npmjs.org"] },
    });

    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "allowlist",
      allowlist: ["api.github.com"],
    });
  });

  it("keeps the configured allowlist when the request turns sandboxing off", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });
    const request = createSandboxPolicy({
      mode: "off",
      root: "/repo",
      network: { mode: "none" },
    });

    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "allowlist",
      allowlist: ["github.com"],
    });
  });

  it("reduces incomparable network modes to none instead of widening access", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "localhost" },
    });

    // localhost would grant loopback hosts the configured allowlist never allowed.
    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "none",
      allowlist: [],
    });
  });

  it("collapses disjoint allowlists to none rather than an invalid empty allowlist", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["npmjs.org"] },
    });

    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "none",
      allowlist: [],
    });
  });

  it("treats all-network as the weakest mode during merges", () => {
    const allPolicy = createSandboxPolicy({ root: "/repo", network: { mode: "all" } });
    const allowlistPolicy = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });

    expect(mergeSandboxPolicies(allPolicy, allowlistPolicy)?.network)
      .toEqual({ mode: "allowlist", allowlist: ["github.com"] });
    expect(mergeSandboxPolicies(allowlistPolicy, allPolicy)?.network)
      .toEqual({ mode: "allowlist", allowlist: ["github.com"] });
  });

  it("lets a request tighten filesystem roots but never widen them", () => {
    const configured = createSandboxPolicy({ root: "/repo" });
    const request = createSandboxPolicy({
      root: "/repo",
      readableRoots: ["/repo/packages"],
      writableRoots: ["/elsewhere"],
    });

    const merged = mergeSandboxPolicies(configured, request);
    expect(merged?.readableRoots).toEqual(["/repo/packages"]);
    expect(merged?.writableRoots).toEqual([]);
  });
});

describe("network policy URL checks", () => {
  it("rejects SRT-invalid allowlist patterns at policy creation", () => {
    expect(() => createSandboxPolicy({ root: "/repo", network: { mode: "allowlist", allowlist: ["*"] } })).toThrow(/domain pattern/u);
    expect(() => createSandboxPolicy({ root: "/repo", network: { mode: "allowlist", allowlist: ["::1"] } })).toThrow(/domain pattern/u);
  });

  it("allows every URL under native all-network mode", () => {
    const policy = createSandboxPolicy({ root: "/repo", network: { mode: "all" } });

    expect(policy.network).toEqual({ mode: "all", allowlist: [] });
    expect(networkPolicyAllowsUrl(policy, "https://example.com/")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "http://127.0.0.1:8080/health")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "https://api.github.com/")).toBe(true);
  });

  it("matches bracketed IPv6 loopback hosts under localhost mode", () => {
    const policy = createSandboxPolicy({ root: "/repo", network: { mode: "localhost" } });

    expect(networkPolicyAllowsUrl(policy, "http://[::1]:8080/health")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "http://127.0.0.1:8080/health")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "https://example.com/")).toBe(false);
  });

  it("matches exact hosts and wildcard subdomains in allowlist mode", () => {
    const policy = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com", "*.npmjs.org"] },
    });

    expect(networkPolicyAllowsUrl(policy, "https://github.com/owner/repo")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "https://api.github.com/")).toBe(false);
    expect(networkPolicyAllowsUrl(policy, "https://registry.npmjs.org/")).toBe(true);
  });

  it("keeps general allowlist URL checks exact instead of implying a scoped child capability", () => {
    const policy = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["localhost", "api.telegram.org"] },
    });

    expect(networkPolicyAllowsUrl(policy, "http://127.0.0.1:43123/v1/asks")).toBe(false);
    expect(networkPolicyAllowsUrl(policy, "http://127.8.9.10:43123/v1/asks")).toBe(false);
    expect(networkPolicyAllowsUrl(policy, "http://localhost:43123/v1/asks")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "https://api.telegram.org/bot")).toBe(true);
  });
});

describe("srt integration contract", () => {
  it("builds workspace-only srt settings with network denied", () => {
    const policy = failClosedSandboxPolicy({ root: "/Users/example/project" });

    expect(srtSettingsForPolicy(policy)).toMatchObject({
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: ["/"],
        allowRead: expect.arrayContaining(["/Users/example/project", "/bin", "/usr/bin"]),
        allowWrite: ["/Users/example/project"],
        denyWrite: [
          "/Users/example/project/.env",
          "/Users/example/project/.env.*",
          "/Users/example/project/.git/config",
          "/Users/example/project/.git/hooks/**",
        ],
      },
    });
  });

  it("denies the entire host filesystem before re-allowing reviewed roots", () => {
    const policy = failClosedSandboxPolicy({ root: "/workspace" });
    const filesystem = srtSettingsForPolicy(policy).filesystem;

    expect(filesystem.denyRead).toEqual(["/"]);
    expect(filesystem.allowRead).toContain("/workspace");
    expect(filesystem.allowRead).not.toContain(homedir());
  });

  it("accepts an all-network posture with the sandbox off or native", () => {
    expect(createSandboxPolicy({ mode: "off", network: { mode: "all" } }).network)
      .toEqual({ mode: "all", allowlist: [] });
    expect(createSandboxPolicy({ mode: "native", network: { mode: "all" } }).network)
      .toEqual({ mode: "all", allowlist: [] });
  });

  it("omits the network block from srt settings under all-network mode", () => {
    const policy = createSandboxPolicy({
      root: "/Users/example/project",
      network: { mode: "all" },
    });
    const settings = srtSettingsForPolicy(policy);

    // An absent network block is SRT's documented unrestricted-network mode:
    // filesystem rules stay enforced while no proxy or domain filter starts.
    expect(settings).not.toHaveProperty("network");
    expect(settings.filesystem).toMatchObject({
      denyRead: ["/"],
      allowRead: expect.arrayContaining([
        "/Users/example/project",
        // System resolver config must be readable when egress is open —
        // res_*/Go-style resolvers read it directly.
        "/private/var/run/resolv.conf",
        "/var/run/resolv.conf",
      ]),
      allowWrite: ["/Users/example/project"],
    });
    expect(JSON.parse(JSON.stringify(settings))).not.toHaveProperty("network");
  });

  it("fails closed for all-network mode when the launch is a bare srt binary", async () => {
    const engine = createSrtSandboxEngine({ command: await fakeSrtExecutable() });
    const policy = createSandboxPolicy({ root: "/repo", network: { mode: "all" } });

    await expect(engine.prepareCommand({ command: "/bin/echo", cwd: "/repo" }, policy))
      .rejects.toThrow(SandboxUnavailableError);
    await expect(engine.prepareCommand({ command: "/bin/echo", cwd: "/repo" }, policy))
      .rejects.toThrow(/library entry/u);
  });

  it("fails closed for all-network mode when the SRT library does not enforce the filesystem policy", { timeout: 60_000 }, async () => {
    const root = await tempDir();
    const distDir = join(root, "dist");
    const workspace = join(root, "workspace");
    await mkdir(distDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const cliPath = join(distDir, "cli.js");
    const entryPath = join(distDir, "index.js");
    await writeFile(cliPath, "process.exit(0);\n", { mode: 0o600 });
    // A stub SandboxManager that performs no sandboxing at all: the embed
    // enforcement proof must detect the missing filesystem boundary.
    await writeFile(entryPath, [
      "export const SandboxManager = {",
      "  async initialize() {},",
      "  async wrapWithSandbox(command) { return command; },",
      "  cleanupAfterCommand() {},",
      "};",
    ].join("\n"), { mode: 0o600 });
    const engine = createSrtSandboxEngine({ nodePath: process.execPath, cliPath });
    const policy = createSandboxPolicy({
      root: workspace,
      readableRoots: [workspace],
      writableRoots: [workspace],
      network: { mode: "all" },
    });

    await expect(engine.prepareCommand({ command: "/bin/echo", cwd: workspace }, policy))
      .rejects.toThrow(SandboxUnavailableError);
  });

  it.skipIf(process.platform !== "darwin" || !existsSync(managedSrtInstallRoot()))(
    "enforces filesystem scopes while leaving the network open under all-network mode",
    { timeout: 240_000 },
    async () => {
      const execFileAsync = promisify(execFile);
      const base = await realpath(await tempDir());
      const workspace = join(base, "workspace");
      const secret = join(base, "sibling-secret.txt");
      await mkdir(workspace, { recursive: true });
      await writeFile(secret, "secret\n", { mode: 0o600 });
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("embed-ok");
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => resolveListen());
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("loopback check server did not expose a TCP port");
        }
        const policy = createSandboxPolicy({
          root: workspace,
          readableRoots: [workspace],
          writableRoots: [workspace],
          network: { mode: "all" },
        });
        const engine = createSrtSandboxEngine();
        // The DNS assertions cover the macOS system-resolver paths the embed
        // profile must reopen: getaddrinfo needs the mDNSResponder unix
        // socket, and resolver-config readers need /etc/resolv.conf through
        // its /var symlink chain. Both are local and deterministic — no
        // external lookup is attempted.
        const script = [
          "const fs=require('node:fs');",
          "const [secretPath,outPath,port]=process.argv.slice(1);",
          "fs.writeFileSync(outPath,'written');",
          "try{fs.readFileSync(secretPath);process.exit(42)}catch{}",
          "if(process.platform==='darwin'){",
          "try{fs.readFileSync('/etc/resolv.conf')}catch{process.exit(45)}",
          "const s=require('node:net').connect('/var/run/mDNSResponder');",
          "s.on('error',()=>process.exit(46));",
          "s.on('connect',()=>{s.destroy();run()});",
          "}else{run()}",
          "function run(){fetch('http://127.0.0.1:'+port+'/').then(r=>r.text()).then(t=>{process.exit(t==='embed-ok'?0:43)},()=>process.exit(44));}",
        ].join("");
        const prepared = await engine.prepareCommand({
          command: process.execPath,
          args: ["-e", script, secret, join(workspace, "out.txt"), String(address.port)],
          cwd: workspace,
        }, policy);
        expect(prepared.sandboxed).toBe(true);
        try {
          await execFileAsync(prepared.command, [...prepared.args], { cwd: prepared.cwd, timeout: 120_000 });
        } finally {
          await prepared.cleanup?.();
        }
        expect(await readFile(join(workspace, "out.txt"), "utf8")).toBe("written");
      } finally {
        server.close();
      }
    },
  );

  it("canonicalizes policy roots so macOS /tmp and /var aliases remain usable", async () => {
    const root = await tempDir();
    const canonicalRoot = await realpath(root);
    const filesystem = srtSettingsForPolicy(failClosedSandboxPolicy({ root })).filesystem;

    expect(filesystem.allowRead).toContain(canonicalRoot);
    expect(filesystem.allowWrite).toEqual([canonicalRoot]);
    expect(filesystem.denyWrite).toContain(join(canonicalRoot, ".env"));
    if (canonicalRoot !== root) {
      expect(filesystem.allowRead).not.toContain(root);
      expect(filesystem.allowWrite).not.toContain(root);
    }
  });

  it("honors a custom denyWrite list", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo", denyWrite: ["credentials.json"] });

    expect(srtSettingsForPolicy(policy).filesystem.denyWrite).toEqual(["/repo/credentials.json"]);
  });

  it("anchors relative denyWrite globs to policy.root from nested command cwd", async () => {
    const policy = failClosedSandboxPolicy({
      root: "/repo",
      denyWrite: ["secrets/**", "/shared/immutable.json"],
    });
    const prepared = await createSrtSandboxEngine({ command: await fakeSrtExecutable() }).prepareCommand({
      command: "/bin/echo",
      cwd: "/repo/packages/nested",
    }, policy);
    const settings = JSON.parse(await readFile(prepared.sandboxSettingsPath as string, "utf8"));

    expect(settings.filesystem.denyWrite).toEqual([
      "/repo/secrets/**",
      "/shared/immutable.json",
      prepared.sandboxSettingsPath,
    ]);
    await prepared.cleanup?.();
  });

  it("emits only SRT 0.0.64-valid localhost domains with a strict allowlist", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo", network: { mode: "localhost" } });

    expect(srtSettingsForPolicy(policy).network).toEqual({
      allowedDomains: ["localhost", "127.0.0.1"],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: true,
      allowAllUnixSockets: false,
    });
  });

  it("does not enable local binding for an external-only network allowlist", () => {
    const policy = failClosedSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["api.telegram.org"] },
    });

    expect(srtSettingsForPolicy(policy).network).toEqual({
      allowedDomains: ["api.telegram.org"],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
      allowAllUnixSockets: false,
    });
  });

  it("does not confuse an external hostname beginning with 127 for a loopback address", () => {
    const policy = failClosedSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["127.example.com"] },
    });

    expect(srtSettingsForPolicy(policy).network).toMatchObject({
      allowedDomains: ["127.example.com"],
      allowLocalBinding: false,
    });
  });

  it.each(["127.0.0.1", "localhost", "127.8.9.10"])(
    "does not globally enable local binding for allowlist loopback host %s",
    (loopbackHost) => {
      const policy = failClosedSandboxPolicy({
        root: "/repo",
        network: { mode: "allowlist", allowlist: ["api.telegram.org", loopbackHost] },
      });

      expect(srtSettingsForPolicy(policy).network).toEqual({
        allowedDomains: ["api.telegram.org", loopbackHost],
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      });
    },
  );

  it("enables local binding only for an explicitly scoped trusted command capability", () => {
    const policy = failClosedSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["api.telegram.org", "127.0.0.1"] },
    });

    expect(srtSettingsForPolicy(policy, undefined, [], { allowLocalBinding: true }).network).toEqual({
      allowedDomains: ["api.telegram.org", "127.0.0.1"],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: true,
      allowAllUnixSockets: false,
    });
  });

  it("fails closed before process execution when the native engine is unavailable", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    await expect(
      prepareSandboxedCommand({
        policy,
        command: { command: "node", args: ["server.js"], cwd: "/repo" },
        engine: {
          id: "fake",
          async isAvailable() {
            return false;
          },
          async prepareCommand() {
            throw new Error("should not prepare");
          },
        },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("fails closed when the policy names an engine with no implementation", async () => {
    const policy = createSandboxPolicy({ root: "/repo", engine: "bubblewrap" });

    await expect(
      prepareSandboxedCommand({
        policy,
        command: { command: "node", args: ["server.js"], cwd: "/repo" },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("routes process execution through the sandbox engine when required", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    await expect(
      prepareSandboxedCommand({
        policy,
        command: { command: "node", args: ["server.js"], cwd: "/repo", env: { A: "1" } },
        engine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command, receivedPolicy) {
            return {
              ...command,
              command: "sandbox",
              args: [receivedPolicy.engine, command.command, ...(command.args ?? [])],
              cwd: command.cwd ?? receivedPolicy.root,
              sandboxed: true,
            };
          },
        },
      }),
    ).resolves.toMatchObject({
      command: "sandbox",
      args: ["srt", "node", "server.js"],
      cwd: "/repo",
      env: { A: "1" },
      sandboxed: true,
    });
  });

  it("passes through empty argv entries verbatim", async () => {
    const prepared = await prepareSandboxedCommand({
      command: { command: "node", args: ["server.js", "--prefix", ""], cwd: "/repo" },
    });

    expect(prepared.args).toEqual(["server.js", "--prefix", ""]);
    expect(prepared.sandboxed).toBe(false);
  });

  it("creates owner-only one-use settings outside writable roots and cleans each copy", async () => {
    const tempRoot = await tempDir();
    const policy = failClosedSandboxPolicy({ root: "/repo", tempRoot });
    const engine = createSrtSandboxEngine({ command: await fakeSrtExecutable() });

    const first = await engine.prepareCommand({ command: "node", args: ["a.js"] }, policy);
    const second = await engine.prepareCommand({ command: "node", args: ["b.js"] }, policy);

    expect(first.sandboxSettingsPath).not.toBe(second.sandboxSettingsPath);
    expect(first.sandboxSettingsPath?.startsWith(tempRoot)).toBe(false);
    const settings = JSON.parse(await readFile(first.sandboxSettingsPath as string, "utf8"));
    expect(settings.network).toEqual(srtSettingsForPolicy(policy).network);
    expect(settings.filesystem).toMatchObject({
      denyRead: ["/"],
      allowWrite: ["/repo"],
    });
    expect(settings.filesystem.allowRead).toContain(dirname(await realpath(process.execPath)));
    expect(settings.filesystem.denyWrite).toContain(first.sandboxSettingsPath);
    expect((await lstat(first.sandboxSettingsPath as string)).mode & 0o077).toBe(0);
    expect(first.args.slice(0, 2)).toEqual(["--settings", first.sandboxSettingsPath]);
    await first.cleanup?.();
    await second.cleanup?.();
    await expect(access(first.sandboxSettingsPath as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps host-trusted runtime roots readable, exact, and read-only after policy narrowing", async () => {
    const runtimeParent = await tempDir();
    const activeRoot = join(runtimeParent, "active-closure");
    const historicalRoot = join(runtimeParent, "historical-closure");
    await mkdir(activeRoot);
    await mkdir(historicalRoot);
    const engine = createSrtSandboxEngine({
      command: await fakeSrtExecutable(),
      trustedReadRoots: [activeRoot],
    });
    const narrowed = failClosedSandboxPolicy({
      root: "/narrow-request",
      readableRoots: ["/narrow-request"],
      // Even a broad configured write root must not make the host-owned
      // closure writable because trusted roots are added to denyWrite.
      writableRoots: [runtimeParent],
    });

    const prepared = await engine.prepareCommand({ command: "/bin/echo", args: ["ok"] }, narrowed);
    try {
      const settings = JSON.parse(await readFile(prepared.sandboxSettingsPath as string, "utf8")) as {
        filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
      };
      const canonicalActive = await realpath(activeRoot);
      expect(settings.filesystem.allowRead).toContain(canonicalActive);
      expect(settings.filesystem.allowRead).not.toContain(await realpath(runtimeParent));
      expect(settings.filesystem.allowRead).not.toContain(await realpath(historicalRoot));
      expect(settings.filesystem.allowWrite).not.toContain(canonicalActive);
      expect(settings.filesystem.denyWrite).toContain(canonicalActive);
    } finally {
      await prepared.cleanup?.();
    }
  });

  it("writes the local-binding capability only into the trusted command's one-use settings", async () => {
    const tempRoot = await tempDir();
    const policy = failClosedSandboxPolicy({
      root: "/repo",
      tempRoot,
      network: { mode: "allowlist", allowlist: ["api.telegram.org", "127.0.0.1"] },
    });
    const engine = createSrtSandboxEngine({ command: await fakeSrtExecutable() });

    const ordinary = await engine.prepareCommand({ command: "node", args: ["ordinary.js"] }, policy);
    const appOwned = await engine.prepareCommand({
      command: "node",
      args: ["adapter-send.js"],
      allowLocalBinding: true,
    }, policy);
    try {
      const ordinarySettings = JSON.parse(await readFile(ordinary.sandboxSettingsPath as string, "utf8"));
      const appOwnedSettings = JSON.parse(await readFile(appOwned.sandboxSettingsPath as string, "utf8"));
      expect(ordinarySettings.network.allowLocalBinding).toBe(false);
      expect(appOwnedSettings.network.allowLocalBinding).toBe(true);
    } finally {
      await ordinary.cleanup?.();
      await appOwned.cleanup?.();
    }
  });

  it("prepares distinct one-use settings for concurrent commands without staging collisions", async () => {
    const root = await tempDir();
    const policy = failClosedSandboxPolicy({
      root,
      tempRoot: join(root, "tmp"),
    });
    const engine = createSrtSandboxEngine({ command: await fakeSrtExecutable() });

    const settled = await Promise.allSettled(
      Array.from({ length: 64 }, (_, index) =>
        engine.prepareCommand({ command: "node", args: ["server.js", String(index)] }, policy),
      ),
    );

    const rejected = settled.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    expect(rejected).toEqual([]);
    const prepared = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
    expect(new Set(prepared.map((result) => result.sandboxSettingsPath)).size).toBe(64);
    await Promise.all(prepared.map(async (result) => result.cleanup?.()));
  });

  it("does not follow a settings-file symlink during cleanup", async () => {
    const root = await tempDir();
    const protectedFile = join(root, "keep.txt");
    await writeFile(protectedFile, "keep", "utf8");
    const policy = failClosedSandboxPolicy({ root });
    const prepared = await createSrtSandboxEngine({ command: await fakeSrtExecutable() })
      .prepareCommand({ command: "node" }, policy);

    await rm(prepared.sandboxSettingsPath as string);
    await symlink(protectedFile, prepared.sandboxSettingsPath as string);
    await prepared.cleanup?.();

    expect(await readFile(protectedFile, "utf8")).toBe("keep");
  });

  it("uses an absolute Node plus CLI launch when explicitly configured", async () => {
    const root = await tempDir();
    const launchRoot = await tempDir();
    const nodePath = join(launchRoot, "node");
    const cliPath = join(launchRoot, "cli.js");
    // process.execPath permissions belong to the host (for example, CI toolcaches
    // can be group-writable), so use a test-owned trusted launch pair here.
    await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(cliPath, "// fixture\n", { mode: 0o600 });
    await chmod(nodePath, 0o700);
    await chmod(cliPath, 0o600);
    const policy = failClosedSandboxPolicy({ root });
    const prepared = await createSrtSandboxEngine({
      nodePath,
      cliPath,
    }).prepareCommand({ command: "/bin/echo", args: ["ok"] }, policy);

    expect(prepared.command).toBe(await realpath(nodePath));
    expect(prepared.args.slice(0, 3)).toEqual([await realpath(cliPath), "--settings", prepared.sandboxSettingsPath]);
    await prepared.cleanup?.();
  });

  it("rejects an explicit SRT executable inside a writable root", async () => {
    const root = await tempDir();
    const command = join(root, "srt");
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const policy = failClosedSandboxPolicy({ root });

    await expect(createSrtSandboxEngine({ command }).prepareCommand({ command: "/bin/echo" }, policy))
      .rejects.toThrow(/inside writable root/u);
  });

  it("rejects external SRT content replaced after its first preparation", async () => {
    const command = await fakeSrtExecutable();
    const engine = createSrtSandboxEngine({ command });
    const policy = failClosedSandboxPolicy({ root: "/repo" });
    const first = await engine.prepareCommand({ command: "/bin/echo" }, policy);
    await first.cleanup?.();
    await writeFile(command, "#!/bin/sh\nexit 9\n", { mode: 0o700 });

    await expect(engine.prepareCommand({ command: "/bin/echo" }, policy))
      .rejects.toThrow(/identity or content changed/u);
  });

  it("rejects a PATH shadow introduced after the external SRT proof", async () => {
    const first = await fakeProofSrtExecutable("first");
    const shadow = await fakeProofSrtExecutable("shadow");
    const env: NodeJS.ProcessEnv = { PATH: first.root };
    const engine = createSrtSandboxEngine({ command: "srt", env });

    await expect(engine.isAvailable()).resolves.toBe(true);
    env.PATH = shadow.root;
    await expect(engine.isAvailable()).resolves.toBe(false);
    await expect(engine.prepareCommand(
      { command: "/bin/echo", args: ["ok"] },
      failClosedSandboxPolicy({ root: "/repo" }),
    )).rejects.toThrow(/identity or content changed/u);
  });
});

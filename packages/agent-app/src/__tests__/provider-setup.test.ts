import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  credentialNeutralProviderStatusEnvironment,
  detectProviderCredentialStates,
  executeProviderSetupPlan,
  piAuthPathForSetup,
  piAuthRecoveryCommand,
  planProviderSetup,
  repairStalePiAuthLock,
  runBoundedProviderCommand,
} from "../provider-setup.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi provider setup safety", () => {
  it("hard-kills a provider probe that traps SIGTERM", async () => {
    if (process.platform === "win32") return;
    const startedAt = Date.now();
    await expect(runBoundedProviderCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
    ], { timeout: 25 })).rejects.toThrow("timed out after 25ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 3_000);

  it("aborts a provider probe with the same bounded TERM-to-KILL lifecycle", async () => {
    if (process.platform === "win32") return;
    const controller = new AbortController();
    const pending = runBoundedProviderCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
    ], { timeout: 5_000, abortSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 3_000);

  it("terminates a provider probe whose stdout exceeds the bounded discovery limit", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 12_345,
      stdout,
      kill: vi.fn((signal: NodeJS.Signals) => {
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      }),
    });
    const pending = runBoundedProviderCommand("provider", ["models"], {
      timeout: 5_000,
      spawn: vi.fn(() => child) as never,
    });

    stdout.write(Buffer.alloc((4 * 1024 * 1024) + 1, 0x78));

    await expect(pending).rejects.toThrow("output limit");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses a minimal operational environment for provider login-status probes", () => {
    const statusEnv = credentialNeutralProviderStatusEnvironment({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/example",
      LC_CTYPE: "UTF-8",
      CODEX_HOME: "/tmp/shell-only-codex",
      CLAUDE_CONFIG_DIR: "/tmp/shell-only-claude",
      OPENAI_API_KEY: "shell-only-openai",
      CLAUDE_CODE_OAUTH_TOKEN: "shell-only-claude",
      OPENCODE_API_KEY: "shell-only-opencode",
      TODOIST_API_TOKEN: "unrelated-shell-secret",
      NODE_OPTIONS: "--require=/tmp/untrusted-hook.cjs",
    }, {
      CODEX_HOME: "/Users/example/.codex",
      CLAUDE_CONFIG_DIR: "/Users/example/.claude",
    });

    expect(statusEnv).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/example",
      LC_CTYPE: "UTF-8",
      CODEX_HOME: "/Users/example/.codex",
      CLAUDE_CONFIG_DIR: "/Users/example/.claude",
    });
  });

  it("represents browser and device-code Codex login explicitly", async () => {
    const dir = await tempDir();
    expect(planProviderSetup({ cwd: dir, modelRefs: ["codex:gpt-5.6-sol"] }).actions[0]).toMatchObject({
      id: "codex-login",
      authMode: "browser",
      command: ["codex", "login"],
    });
    expect(planProviderSetup({
      cwd: dir,
      modelRefs: ["codex:gpt-5.6-sol"],
      codexAuthMode: "device",
    }).actions[0]).toMatchObject({
      id: "codex-login",
      authMode: "device",
      command: ["codex", "login", "--device-auth"],
    });
  });

  it("skips detected credentials by default and reruns them for explicit repair", async () => {
    const dir = await tempDir();
    const detected = planProviderSetup({
      cwd: dir,
      modelRefs: ["codex:gpt-5.6-sol", "pi:openai-codex:gpt-5.6-sol"],
      credentialStates: { codex: "credential_detected", "pi:openai-codex": "verified" },
    });
    expect(detected.actions).toEqual([]);
    expect(detected.detectedModelRefs).toEqual(["codex:gpt-5.6-sol", "pi:openai-codex:gpt-5.6-sol"]);

    const repair = planProviderSetup({
      cwd: dir,
      modelRefs: ["codex:gpt-5.6-sol", "pi:openai-codex:gpt-5.6-sol"],
      credentialStates: { codex: "credential_detected", "pi:openai-codex": "verified" },
      forceAuthentication: true,
    });
    expect(repair.actions.map((action) => action.id)).toEqual(["codex-login", "pi-login:openai-codex"]);
  });

  it("detects Codex, Claude, and Pi credential postconditions without claiming verification", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      "openai-codex": { type: "oauth", access: "stored" },
    })}\n`, { mode: 0o600 });
    const states = await detectProviderCredentialStates({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: [
        "codex:gpt-5.6-sol",
        "claude:claude-sonnet-5",
        "pi:openai-codex:gpt-5.6-sol",
        "pi:openai:gpt-5.5",
      ],
      execFile: async (file) => {
        if (file === "codex") return {};
        throw new Error("Claude not signed in");
      },
    });
    expect(states).toEqual({
      codex: "credential_detected",
      claude: "auth_required",
      "pi:openai-codex": "credential_detected",
      "pi:openai": "auth_required",
    });
    expect(Object.values(states)).not.toContain("verified");
  });

  it.each([
    {
      label: "Codex OPENAI_API_KEY",
      modelRef: "codex:gpt-5.6-sol",
      persistedEnv: { OPENAI_API_KEY: "durable-openai-key" },
      expected: { codex: "credential_detected" },
    },
    {
      label: "Claude ANTHROPIC_API_KEY",
      modelRef: "claude:claude-sonnet-5",
      persistedEnv: { ANTHROPIC_API_KEY: "durable-anthropic-key" },
      expected: { claude: "credential_detected" },
    },
    {
      label: "Claude ANTHROPIC_AUTH_TOKEN",
      modelRef: "claude:claude-sonnet-5",
      persistedEnv: { ANTHROPIC_AUTH_TOKEN: "durable-anthropic-token" },
      expected: { claude: "credential_detected" },
    },
    {
      label: "Claude CLAUDE_CODE_OAUTH_TOKEN",
      modelRef: "claude:claude-sonnet-5",
      persistedEnv: { CLAUDE_CODE_OAUTH_TOKEN: "durable-claude-token" },
      expected: { claude: "credential_detected" },
    },
  ])("recognizes a durable $label without claiming live verification", async ({
    modelRef,
    persistedEnv,
    expected,
  }) => {
    const run = vi.fn(async () => {
      throw new Error("external login unavailable");
    });
    const states = await detectProviderCredentialStates({
      cwd: "/agent",
      modelRefs: [modelRef],
      persistedEnv,
      execFile: run,
    });

    expect(states).toEqual(expected);
    expect(Object.values(states)).not.toContain("verified");
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores direct-provider credentials that exist only in the ambient shell", async () => {
    const names = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `shell-only-${name}`;
    try {
      const states = await detectProviderCredentialStates({
        cwd: "/agent",
        modelRefs: ["codex:gpt-5.6-sol", "claude:claude-sonnet-5"],
        persistedEnv: {},
        execFile: async (_file, _args, options) => {
          for (const name of names) expect(options.env?.[name]).toBeUndefined();
          throw new Error("not signed in");
        },
      });
      expect(states).toEqual({ codex: "auth_required", claude: "auth_required" });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("does not report empty or malformed Pi credential records as authenticated", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      "opencode-go": {},
      "openai-codex": { type: "oauth", access: "", refresh: " " },
      openai: { type: "api_key", key: "usable" },
    })}\n`, { mode: 0o600 });

    const states = await detectProviderCredentialStates({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: [
        "pi:opencode-go:kimi-k2.6",
        "pi:openai-codex:gpt-5.6-terra",
        "pi:openai:gpt-5.5",
      ],
    });

    expect(states).toEqual({
      "pi:opencode-go": "auth_required",
      "pi:openai-codex": "auth_required",
      "pi:openai": "credential_detected",
    });
  });

  it("does not detect credentials from a group-readable Pi auth store", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      "openai-codex": { type: "oauth", access: "must-not-be-detected" },
    })}\n`, { mode: 0o600 });
    await chmod(authPath, 0o644);

    const states = await detectProviderCredentialStates({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:openai-codex:gpt-5.6-sol"],
    });

    expect(states).toEqual({ "pi:openai-codex": "auth_required" });
  });

  it("offers OpenCode-Go API keys through secure-store or environment setup", async () => {
    const dir = await tempDir();
    const secure = planProviderSetup({ cwd: dir, modelRefs: ["pi:opencode-go:kimi-k2.6"] });
    expect(secure.actions[0]).toMatchObject({
      id: "pi-api-key:opencode-go",
      envVar: "OPENCODE_API_KEY",
      persistence: "secure-store",
    });
    const environment = planProviderSetup({
      cwd: dir,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
      piApiKeyPersistence: "environment",
    });
    expect(environment.actions[0]).toMatchObject({ persistence: "environment" });
    const [result] = await executeProviderSetupPlan(environment, {
      apiKeys: { "pi-api-key:opencode-go": "not-persisted" },
    });
    expect(result).toMatchObject({ status: "ok" });
    await expect(readFile(join(dir, ".pi", "agent", "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never copies an ambient environment key into secure storage without explicit input", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const previous = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "ambient-must-not-persist";
    try {
      const plan = planProviderSetup({ cwd: dir, piAuthPath: authPath, modelRefs: ["pi:opencode-go:kimi-k2.6"] });
      const [result] = await executeProviderSetupPlan(plan, { apiKeys: {} });
      expect(result).toMatchObject({ status: "skipped" });
      await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
    }
  });

  it("removes only a proven-stale secure Pi lock", async () => {
    if (typeof process.getuid !== "function") throw new Error("POSIX uid required");
    const dir = await tempDir();
    const path = join(dir, "auth.json.mono-agent.lock");
    const ownerUid = process.getuid();
    await writeFile(path, `${JSON.stringify({ version: 1, pid: 999_991, ownerUid, token: "stale-token" })}\n`, { mode: 0o600 });
    const stale = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    await expect(repairStalePiAuthLock(path, ownerUid, { kill: stale })).resolves.toBe("removed");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a proven-stale Pi lock and retries credential setup once", async () => {
    if (typeof process.getuid !== "function") throw new Error("POSIX uid required");
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(`${authPath}.mono-agent.lock`, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      ownerUid: process.getuid(),
      token: "abandoned-lock-token",
    })}\n`, { mode: 0o600 });
    const plan = planProviderSetup({ cwd: dir, piAuthPath: authPath, modelRefs: ["pi:opencode-go:kimi-k2.6"] });
    const [result] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "replacement-key" },
    });
    expect(result).toMatchObject({ status: "ok" });
    expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
      "opencode-go": { type: "api_key", key: "replacement-key" },
    });
    await expect(readFile(`${authPath}.mono-agent.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats stale-lock unlink durability uncertainty as fatal", async () => {
    if (typeof process.getuid !== "function") throw new Error("This regression requires a POSIX uid.");
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 99_999_991,
      ownerUid: process.getuid(),
      token: "abandoned-lock-token",
    })}\n`, { mode: 0o600 });
    const spawn = vi.fn();
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      afterStalePiAuthLockRemoval: async () => {
        throw new Error("simulated stale-lock directory sync denial");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(lockPath);
    expect(results[0]?.detail).toContain("directory durability could not be confirmed");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats uncertain lock-creation rollback as fatal and starts no later action", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    const replacement = "replacement-lock-owner\n";
    const spawn = vi.fn();
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      afterPiAuthLockCreated: async () => {
        await rm(lockPath);
        await writeFile(lockPath, replacement, { mode: 0o600 });
        throw new Error("simulated setup failure after lock creation");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(lockPath);
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats an absent failed-creation lock with uncertain directory durability as fatal", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    const spawn = vi.fn();
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      afterPiAuthLockCreated: async () => {
        await rm(lockPath);
        throw new Error("simulated setup failure after external lock removal");
      },
      beforePiAuthMissingLockSync: async () => {
        throw new Error("simulated missing-lock directory sync denial");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(lockPath);
    expect(results[0]?.detail).toContain("parent-directory durability could not be confirmed");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats an oversized lock mutation discovered during release as fatal", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    const spawn = vi.fn();
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      afterPiAuthLockCreated: async () => {
        await writeFile(lockPath, "x".repeat(4_097), { mode: 0o600 });
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain("4096-byte safety limit");
    expect(await readFile(lockPath, "utf8")).toHaveLength(4_097);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats API-key transaction residue as fatal and starts no later action", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const spawn = vi.fn();
    let retainedTempDir = "";
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      beforePiAuthTempCleanup: async (tempDir) => {
        retainedTempDir = tempDir;
        throw new Error("simulated transaction cleanup denial");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(retainedTempDir);
    expect((await readdir(dir)).some((name) => name.startsWith(".mono-agent-pi-auth-write-"))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("names a retained old-credential backup and stops after backup cleanup failure", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`, { mode: 0o600 });
    const spawn = vi.fn();
    let retainedBackup = "";
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      beforePiAuthBackupCleanup: async (backupPath) => {
        retainedBackup = backupPath;
        throw new Error("simulated backup cleanup denial");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(retainedBackup);
    expect(await readFile(retainedBackup, "utf8")).toContain("anthropic");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports every credential residue when backup and transaction cleanup both fail", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`, { mode: 0o600 });
    const spawn = vi.fn();
    let retainedBackup = "";
    let retainedTempDir = "";
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      beforePiAuthBackupCleanup: async (backupPath) => {
        retainedBackup = backupPath;
        throw new Error("simulated backup cleanup denial");
      },
      beforePiAuthTempCleanup: async (tempDir) => {
        retainedTempDir = tempDir;
        throw new Error("simulated transaction cleanup denial");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(retainedBackup);
    expect(results[0]?.detail).toContain(retainedTempDir);
    expect(await readFile(retainedBackup, "utf8")).toContain("anthropic");
    expect((await readdir(retainedTempDir)).length).toBeGreaterThan(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats post-install directory durability uncertainty as fatal", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const spawn = vi.fn();
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6", "claude:claude-sonnet-5"],
    }), {
      apiKeys: { "pi-api-key:opencode-go": "entered-key" },
      spawn: spawn as never,
      beforePiAuthPostMutationSync: async () => {
        throw new Error("simulated directory sync denial");
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(results[0]?.detail).toContain(authPath);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("leaves active, EPERM, malformed, and racing Pi locks untouched", async () => {
    if (typeof process.getuid !== "function") throw new Error("POSIX uid required");
    const dir = await tempDir();
    const ownerUid = process.getuid();
    const activePath = join(dir, "active.lock");
    const record = { version: 1, pid: 999_992, ownerUid, token: "active-token" };
    await writeFile(activePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await expect(repairStalePiAuthLock(activePath, ownerUid, { kill: () => true })).resolves.toBe("active");
    expect(JSON.parse(await readFile(activePath, "utf8"))).toEqual(record);

    const eperm = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
    await expect(repairStalePiAuthLock(activePath, ownerUid, { kill: eperm })).resolves.toBe("active");
    const malformedPath = join(dir, "malformed.lock");
    await writeFile(malformedPath, "not-json\n", { mode: 0o600 });
    await expect(repairStalePiAuthLock(malformedPath, ownerUid, { kill: eperm })).resolves.toBe("unverifiable");

    const racePath = join(dir, "race.lock");
    await writeFile(racePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const stale = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    await expect(repairStalePiAuthLock(racePath, ownerUid, {
      kill: stale,
      beforeRemoval: async () => {
        await rm(racePath);
        await writeFile(racePath, `${JSON.stringify({ ...record, token: "replacement-token" })}\n`, { mode: 0o600 });
      },
    })).resolves.toBe("unverifiable");
    expect(JSON.parse(await readFile(racePath, "utf8"))).toMatchObject({ token: "replacement-token" });
  });

  it("expands home paths and shell-quotes recovery paths", () => {
    expect(piAuthPathForSetup("~/.pi/custom/auth.json", "/repo")).toBe(join(homedir(), ".pi", "custom", "auth.json"));
    expect(piAuthRecoveryCommand("openai-codex", "/tmp/auth stores/it's.json")).toBe(
      "mono-agent auth login openai-codex --pi-auth-path '/tmp/auth stores/it'\"'\"'s.json'",
    );
  });

  it("kills and fails a hung local CLI preflight at the configured deadline", async () => {
    const dir = await tempDir();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const kill = vi.fn(() => true);
    const spawn = vi.fn(() => ({
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
      },
      kill,
    }));
    const plan = planProviderSetup({
      cwd: dir,
      modelRefs: ["pi:ollama:qwen3.6:latest", "claude:claude-sonnet-5"],
    });

    const [result] = await executeProviderSetupPlan(plan, {
      spawn: spawn as never,
      preflightTimeoutMs: 10,
    });

    expect(result?.status).toBe("failed");
    expect(result?.failureKind).toBe("child_exit_unconfirmed");
    expect(result?.detail).toContain("ollama list timed out after 10ms");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports an ordinary timeout only after confirmed child close", async () => {
    const dir = await tempDir();
    let spawnCount = 0;
    const spawn = vi.fn(() => {
      spawnCount += 1;
      const listeners = new Map<string, (...args: unknown[]) => void>();
      if (spawnCount > 1) queueMicrotask(() => listeners.get("close")?.(0, null));
      return {
        pid: 12_345 + spawnCount,
        once(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, listener);
        },
        kill(signal: NodeJS.Signals) {
          queueMicrotask(() => listeners.get("close")?.(null, signal));
          return true;
        },
      };
    });
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      modelRefs: ["pi:ollama:qwen3.6:latest", "claude:claude-sonnet-5"],
    }), {
      spawn: spawn as never,
      preflightTimeoutMs: 10,
    });

    expect(results.map((result) => result.status)).toEqual(["failed", "ok"]);
    expect(results[0]?.failureKind).toBeUndefined();
    expect(results[0]?.detail).toContain("timed out after 10ms");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("aborts and fails a hung LM Studio preflight even when fetch never settles", async () => {
    const dir = await tempDir();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const plan = planProviderSetup({ cwd: dir, modelRefs: ["pi:lmstudio:qwen3-8b"] });

    const [result] = await executeProviderSetupPlan(plan, {
      fetch: fetch as never,
      preflightTimeoutMs: 10,
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toContain("GET http://localhost:1234/v1/models timed out after 10ms");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not apply the preflight deadline to interactive auth commands", async () => {
    const dir = await tempDir();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const kill = vi.fn(() => true);
    const spawn = vi.fn(() => ({
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
      },
      kill,
    }));
    const plan = planProviderSetup({ cwd: dir, modelRefs: ["codex:gpt-5.6-terra"] });
    const pending = executeProviderSetupPlan(plan, {
      spawn: spawn as never,
      preflightTimeoutMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(kill).not.toHaveBeenCalled();
    listeners.get("close")?.(0, null);
    const [result] = await pending;
    expect(result?.status).toBe("ok");
  });

  it("interrupts an active auth child with bounded TERM-to-KILL escalation and starts no later action", async () => {
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          queueMicrotask(() => listeners.get("error")?.(Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
        }
        return true;
      });
      const spawn = vi.fn(() => ({
        pid: 12_345,
        exitCode: null,
        signalCode: null,
        once(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, listener);
        },
        kill,
      }));
      const controller = new AbortController();
      const pending = executeProviderSetupPlan(planProviderSetup({
        cwd: dir,
        modelRefs: ["codex:gpt-5.6-sol", "claude:claude-sonnet-5"],
      }), {
        spawn: spawn as never,
        abortSignal: controller.signal,
      });

      controller.abort();
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      listeners.get("close")?.(null, "SIGKILL");

      const results = await pending;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ status: "failed" });
      expect(results[0]?.detail).toContain("was interrupted");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an interrupted auth action when the child never closes after SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const kill = vi.fn(() => false);
      const unref = vi.fn();
      const spawn = vi.fn(() => ({
        pid: 12_345,
        exitCode: null,
        signalCode: null,
        once: vi.fn(),
        kill,
        unref,
      }));
      const controller = new AbortController();
      const pending = executeProviderSetupPlan(planProviderSetup({
        cwd: dir,
        modelRefs: ["codex:gpt-5.6-sol", "claude:claude-sonnet-5"],
      }), {
        spawn: spawn as never,
        abortSignal: controller.signal,
      });

      controller.abort();
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          status: "failed",
          failureKind: "child_exit_unconfirmed",
          detail: expect.stringContaining("child exit could not be confirmed after SIGKILL"),
        }),
      ]);
      expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(unref).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes Pi OAuth staging credentials and the lock after interruption", async () => {
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const authPath = join(dir, "auth.json");
      const controller = new AbortController();
      let notifySpawned: ((cwd: string) => void) | undefined;
      const spawnedCwd = new Promise<string>((resolveSpawned) => {
        notifySpawned = resolveSpawned;
      });
      const unref = vi.fn();
      const spawn = vi.fn((_file: string, _args: readonly string[], options: { readonly cwd?: string }) => {
        queueMicrotask(() => notifySpawned?.(options.cwd!));
        return {
          pid: 12_345,
          exitCode: null,
          signalCode: null,
          once: vi.fn(),
          kill: vi.fn(() => false),
          unref,
        };
      });

      const pending = executeProviderSetupPlan(oauthPlan(dir, authPath), {
        spawn: spawn as never,
        abortSignal: controller.signal,
      });
      const stagingDir = await spawnedCwd;
      expect(stagingDir).toContain(".mono-agent-pi-auth-");
      expect(await readdir(dir)).toEqual(expect.arrayContaining([
        basename(stagingDir),
        "auth.json.mono-agent.lock",
      ]));

      controller.abort();
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({ status: "failed", failureKind: "child_exit_unconfirmed" }),
      ]);
      expect(unref).toHaveBeenCalledOnce();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats interrupted Pi credential cleanup failure as fatal and retains exact residue guidance", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const controller = new AbortController();
    let notifySpawned: ((cwd: string) => void) | undefined;
    const spawnedCwd = new Promise<string>((resolveSpawned) => {
      notifySpawned = resolveSpawned;
    });
    const spawn = vi.fn((_file: string, _args: readonly string[], options: { readonly cwd?: string }) => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      queueMicrotask(() => notifySpawned?.(options.cwd!));
      return {
        pid: 12_345,
        once(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, listener);
        },
        kill(signal: NodeJS.Signals) {
          queueMicrotask(() => listeners.get("close")?.(null, signal));
          return true;
        },
      };
    });
    const pending = executeProviderSetupPlan(oauthPlan(dir, authPath), {
      spawn: spawn as never,
      abortSignal: controller.signal,
      beforePiAuthCleanup: async () => { throw new Error("simulated cleanup denial"); },
    });
    const stagingDir = await spawnedCwd;

    controller.abort();

    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        failureKind: "cleanup_failed",
        detail: expect.stringContaining(stagingDir),
      }),
    ]);
    expect(await readdir(dir)).toContain(basename(stagingDir));
    expect(await readdir(dir)).not.toContain("auth.json.mono-agent.lock");
  });

  it("keeps child-exit fatality dominant when Pi cleanup also fails", async () => {
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const authPath = join(dir, "auth.json");
      const controller = new AbortController();
      let notifySpawned: (() => void) | undefined;
      const spawned = new Promise<void>((resolveSpawned) => { notifySpawned = resolveSpawned; });
      const spawn = vi.fn(() => {
        queueMicrotask(() => notifySpawned?.());
        return {
          pid: 12_345,
          once: vi.fn(),
          kill: vi.fn(() => false),
          unref: vi.fn(),
        };
      });
      const pending = executeProviderSetupPlan(oauthPlan(dir, authPath), {
        spawn: spawn as never,
        abortSignal: controller.signal,
        beforePiAuthCleanup: async () => { throw new Error("simulated cleanup denial"); },
      });
      await spawned;

      controller.abort();
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          status: "failed",
          failureKind: "child_exit_unconfirmed",
          detail: expect.stringContaining("simulated cleanup denial"),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the retained lock when staged credentials were removed but lock cleanup became uncertain", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    const replacement = "replacement-lock-owner\n";
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        "openai-codex": { type: "oauth", access: "new-access", refresh: "new-refresh" },
      }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), {
      spawn: spawn as never,
      beforePiAuthPromotion: async () => {
        await rm(lockPath);
        await writeFile(lockPath, replacement, { mode: 0o600 });
      },
    });

    expect(result).toMatchObject({ status: "failed", failureKind: "cleanup_failed" });
    expect(result?.detail).toContain(lockPath);
    expect(result?.detail).not.toContain(".mono-agent-pi-auth-");
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    expect((await readdir(dir)).some((name) => name.startsWith(".mono-agent-pi-auth-"))).toBe(false);
  });

  it("continues independent provider actions after an ordinary failure", async () => {
    const dir = await tempDir();
    const calls: string[] = [];
    const spawn = vi.fn((file: string, args: readonly string[]) => {
      calls.push([file, ...args].join(" "));
      const listeners = new Map<string, (...values: unknown[]) => void>();
      queueMicrotask(() => listeners.get("close")?.(calls.length === 1 ? 1 : 0, null));
      return {
        once(event: string, listener: (...values: unknown[]) => void) {
          listeners.set(event, listener);
        },
      };
    });
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      modelRefs: ["codex:gpt-5.6-sol", "claude:claude-sonnet-5"],
    }), { spawn: spawn as never });

    expect(calls).toEqual(["codex login", "claude /login"]);
    expect(results.map((result) => result.status)).toEqual(["failed", "ok"]);
  });

  it("starts no later provider action after a typed fatal cleanup failure", async () => {
    const dir = await tempDir();
    const spawn = vi.fn(() => {
      const listeners = new Map<string, (...values: unknown[]) => void>();
      queueMicrotask(() => listeners.get("close")?.(1, null));
      return {
        pid: 12_345,
        once(event: string, listener: (...values: unknown[]) => void) {
          listeners.set(event, listener);
        },
      };
    });
    const results = await executeProviderSetupPlan(planProviderSetup({
      cwd: dir,
      piAuthPath: join(dir, "auth.json"),
      modelRefs: ["pi:openai-codex:gpt-5.6-sol", "claude:claude-sonnet-5"],
    }), {
      spawn: spawn as never,
      beforePiAuthCleanup: async () => { throw new Error("simulated cleanup denial"); },
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "failed", failureKind: "cleanup_failed" }),
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed source JSON before spawning and preserves it byte-for-byte", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, "{recoverable-but-malformed", { mode: 0o600 });
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/Unable to parse Pi auth file/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe("{recoverable-but-malformed");
  });

  it("rejects an array-shaped auth store before spawning", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, '[{"type":"oauth","refresh":"keep"}]\n', { mode: 0o600 });
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/must contain a JSON object/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe('[{"type":"oauth","refresh":"keep"}]\n');
  });

  it("rejects a successful child that omits the requested provider", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }, null, 2)}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/did not produce credentials/u);
    expect(await readFile(authPath, "utf8")).toBe(original);
  });

  it("rejects a child that changes sibling providers", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } }, null, 2)}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        anthropic: { type: "oauth", refresh: "changed" },
        "openai-codex": { type: "oauth", access: "new" },
      }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/unexpectedly changed sibling provider anthropic/u);
    expect(await readFile(authPath, "utf8")).toBe(original);
  });

  it("preserves a credential store changed by another process during login", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`, { mode: 0o600 });
    const concurrent = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "concurrent" } }, null, 2)}\n`;
    const spawn = spawned(async (cwd) => {
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        anthropic: { type: "oauth", refresh: "old" },
        "openai-codex": { type: "oauth", access: "new" },
      }));
      await writeFile(authPath, concurrent, { mode: 0o600 });
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/changed during credential setup/u);
    expect(await readFile(authPath, "utf8")).toBe(concurrent);
  });

  it("explicit repair accepts a non-writable 0644 store, preserves siblings, and hardens it to 0600", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "nested", "credentials.json");
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, `${JSON.stringify({
      anthropic: { type: "oauth", refresh: "keep" },
      "openai-codex": { type: "oauth", refresh: "legacy-readable" },
    })}\n`, { mode: 0o600 });
    await chmod(authPath, 0o644);
    expect(await detectProviderCredentialStates({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:openai-codex:gpt-5.6-sol"],
    })).toEqual({ "pi:openai-codex": "auth_required" });
    const spawn = spawned(async (cwd) => {
      const current = JSON.parse(await readFile(join(cwd, "auth.json"), "utf8"));
      await writeFile(join(cwd, "auth.json"), JSON.stringify({
        ...current,
        "openai-codex": { type: "oauth", access: "new-access", refresh: "new-refresh" },
      }));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("ok");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      anthropic: { type: "oauth", refresh: "keep" },
      "openai-codex": { type: "oauth", access: "new-access", refresh: "new-refresh" },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(authPath))).toEqual(["credentials.json"]);
    expect(await detectProviderCredentialStates({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:openai-codex:gpt-5.6-sol"],
    })).toEqual({ "pi:openai-codex": "credential_detected" });
  });

  it("refuses an auth store that another user can write", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    await chmod(authPath, 0o666);
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/writable by another user/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect((await stat(authPath)).mode & 0o777).toBe(0o666);
  });

  it("refuses credential persistence in a group/world-writable parent", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await chmod(dir, 0o777);
    const plan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "secret" },
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/owned by the current user and not group\/world-writable/u);
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${authPath}.mono-agent.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a multiply-linked existing auth store without changing either alias", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const aliasPath = join(dir, "auth-alias.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    await link(authPath, aliasPath);
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/hard-link identity is unsafe/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect(await readFile(aliasPath, "utf8")).toBe(original);
  });

  it("rejects multiply-linked bundled Pi output before promotion", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const spawn = spawned(async (cwd) => {
      const stagedPath = join(cwd, "auth.json");
      await writeFile(stagedPath, JSON.stringify({
        anthropic: { type: "oauth", refresh: "keep" },
        "openai-codex": { type: "oauth", access: "new" },
      }));
      await link(stagedPath, join(cwd, "credential-alias.json"));
    });

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/hard-link identity is unsafe/u);
    expect(await readFile(authPath, "utf8")).toBe(original);
  });

  it("proves lock ownership before promotion and leaves a replacement lock untouched", async () => {
    if (typeof process.getuid !== "function") throw new Error("This regression requires a POSIX uid.");
    const ownerUid = process.getuid();
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const lockPath = `${authPath}.mono-agent.lock`;
    const replacement = "replacement-owner-lock\n";
    const plan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "secret" },
      beforePiAuthPromotion: async () => {
        const lockStat = await stat(lockPath);
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        expect(lockStat.uid).toBe(ownerUid);
        expect(lockStat.mode & 0o777).toBe(0o600);
        expect(lockStat.nlink).toBe(1);
        expect(owner.ownerUid).toBe(ownerUid);
        expect(typeof owner.token).toBe("string");
        await rm(lockPath);
        await writeFile(lockPath, replacement, { mode: 0o600 });
      },
    });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/credential lock/u);
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent Pi credential writers under the identity-bound lock", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const plan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayPromote = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "first-key" },
      beforePiAuthPromotion: async () => {
        markLocked();
        await firstMayPromote;
      },
    });
    await locked;
    const [contender] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "second-key" },
    });
    expect(contender?.status).toBe("failed");
    expect(contender?.detail).toMatch(/credential lock .* already exists/u);

    releaseFirst();
    const [firstResult] = await first;
    expect(firstResult?.status).toBe("ok");
    const [retry] = await executeProviderSetupPlan(plan, {
      apiKeys: { "pi-api-key:opencode-go": "second-key" },
    });
    expect(retry?.status).toBe("ok");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
      "opencode-go": { type: "api_key", key: "second-key" },
    });
    await expect(readFile(`${authPath}.mono-agent.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses symbolic-link auth stores without touching their targets", async () => {
    const dir = await tempDir();
    const target = join(dir, "target.json");
    const authPath = join(dir, "auth.json");
    await writeFile(target, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "keep" } })}\n`);
    await symlink(target, authPath);
    const spawn = vi.fn();

    const [result] = await executeProviderSetupPlan(oauthPlan(dir, authPath), { spawn: spawn as never });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/symbolic link/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ anthropic: { type: "oauth", refresh: "keep" } });
  });

  it("fails closed on Windows for OAuth and API-key persistence", async () => {
    const dir = await tempDir();
    const oauthSpawn = vi.fn();
    const [oauthResult] = await executeProviderSetupPlan(oauthPlan(dir, join(dir, "oauth.json")), {
      platform: "win32",
      spawn: oauthSpawn as never,
    });
    const apiPlan = planProviderSetup({ cwd: dir, piAuthPath: join(dir, "api.json"), modelRefs: ["pi:opencode-go:kimi-k2.6"] });
    const [apiResult] = await executeProviderSetupPlan(apiPlan, {
      platform: "win32",
      apiKeys: { "pi-api-key:opencode-go": "secret-value" },
    });

    expect(oauthResult?.status).toBe("failed");
    expect(apiResult?.status).toBe("failed");
    expect(oauthSpawn).not.toHaveBeenCalled();
    await expect(readFile(join(dir, "oauth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "api.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses automatic Pi credential persistence anywhere inside a Git worktree", async () => {
    const dir = await tempDir();
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    const authPath = join(dir, "credentials", "auth.json");
    const oauthSpawn = vi.fn();
    const [oauthResult] = await executeProviderSetupPlan(oauthPlan(dir, authPath), {
      spawn: oauthSpawn as never,
    });
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });
    const [apiResult] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "PI_SECRET_SENTINEL_185" },
    });

    expect(oauthResult?.status).toBe("failed");
    expect(apiResult?.status).toBe("failed");
    expect(oauthResult?.detail).toMatch(/inside Git worktree/u);
    expect(apiResult?.detail).toMatch(/inside Git worktree/u);
    expect(oauthSpawn).not.toHaveBeenCalled();
    expect(await readdir(join(dir, "credentials"))).toEqual([]);
  });

  it("rejects a FIFO Pi auth path without blocking", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await execFileAsync("mkfifo", [authPath]);
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const result = await Promise.race([
      executeProviderSetupPlan(apiPlan, {
        apiKeys: { "pi-api-key:opencode-go": "secret" },
      }),
      new Promise<"blocked">((resolveBlocked) => setTimeout(() => resolveBlocked("blocked"), 500)),
    ]);

    expect(result).not.toBe("blocked");
    if (result === "blocked") return;
    expect(result[0]?.status).toBe("failed");
    expect(result[0]?.detail).toMatch(/not a regular file/u);
  });

  it("preserves a Pi auth writer that wins immediately before pathname claim", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`, { mode: 0o600 });
    const concurrent = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "concurrent" }, sibling: { type: "api_key", key: "new" } })}\n`;
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "intended-key" },
      beforePiAuthPromotion: async () => writeFile(authPath, concurrent, { mode: 0o600 }),
    });

    expect(result?.status).toBe("failed");
    expect(await readFile(authPath, "utf8")).toBe(concurrent);
  });

  it("rejects a hard-link alias added before claim and restores the validated inode", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const aliasPath = join(dir, "concurrent-alias.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "intended-key" },
      beforePiAuthPromotion: async () => link(authPath, aliasPath),
    });

    expect(result?.status).toBe("failed");
    expect(await readFile(authPath, "utf8")).toBe(original);
    expect(await readFile(aliasPath, "utf8")).toBe(original);
    expect((await stat(authPath)).nlink).toBe(2);
    expect((await readdir(dir)).some((name) => name.endsWith(".backup"))).toBe(false);
  });

  it("detects an in-place write through the staged hard-link alias", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`, { mode: 0o600 });
    const attacker = `${JSON.stringify({ attacker: { type: "api_key", key: "CONCURRENT_ALIAS_WRITE" } })}\n`;
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const [result] = await executeProviderSetupPlan(apiPlan, {
      apiKeys: { "pi-api-key:opencode-go": "intended-key" },
      afterPiAuthLink: async (targetPath) => writeFile(targetPath, attacker, { mode: 0o600 }),
    });

    expect(result?.status).toBe("failed");
    expect(await readFile(authPath, "utf8")).toBe(attacker);
  });

  it("detects and preserves a writer using the claimed auth inode through an open descriptor", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const original = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } })}\n`;
    const concurrent = `${JSON.stringify({ anthropic: { type: "oauth", refresh: "OPEN_FD_CONCURRENT" } })}\n`;
    await writeFile(authPath, original, { mode: 0o600 });
    const held = await open(authPath, "r+");
    const apiPlan = planProviderSetup({
      cwd: dir,
      piAuthPath: authPath,
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    let result;
    try {
      [result] = await executeProviderSetupPlan(apiPlan, {
        apiKeys: { "pi-api-key:opencode-go": "intended-key" },
        afterPiAuthLink: async () => {
          await held.truncate(0);
          await held.write(concurrent, 0, "utf8");
          await held.sync();
        },
      });
    } finally {
      await held.close();
    }

    expect(result?.status).toBe("failed");
    expect(result?.detail).toMatch(/concurrent credentials were retained at/u);
    const backups = (await readdir(dir)).filter((name) => name.endsWith(".backup"));
    expect(backups).toHaveLength(1);
    const recoveryPath = join(dir, backups[0]!);
    expect(await readFile(recoveryPath, "utf8")).toBe(concurrent);
    expect((await stat(recoveryPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(authPath, "utf8")).toContain("intended-key");
  });

});

function oauthPlan(cwd: string, authPath: string) {
  return planProviderSetup({
    cwd,
    piAuthPath: authPath,
    modelRefs: ["pi:openai-codex:gpt-5.6-terra"],
  });
}

function spawned(update: (cwd: string) => Promise<void>) {
  return vi.fn((_file: string, _args: readonly string[], options: { cwd?: string }) => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    queueMicrotask(async () => {
      try {
        await update(options.cwd!);
        listeners.get("close")?.(0, null);
      } catch (error) {
        listeners.get("error")?.(error);
      }
    });
    return {
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener);
      },
    };
  });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-safe-"));
  tempDirs.push(dir);
  return dir;
}

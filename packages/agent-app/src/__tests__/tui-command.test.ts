import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../background-snapshot-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../background-snapshot-key.js")>();
  const key = Buffer.alloc(32, 0x45);
  return {
    ...actual,
    loadBackgroundSnapshotKey: async () => Buffer.from(key),
    loadOrCreateBackgroundSnapshotKey: async () => Buffer.from(key),
  };
});

import type { TraceSourceListItem, TraceSourceListResult } from "@mono-agent/observability";

import { parseCliArgs } from "../cli.js";
import {
  captureManagedConfigurationAttachSnapshot,
  resolveTuiLaunch,
  runTui,
  tuiEndpointOf,
} from "../tui-command.js";
import type { BackgroundSnapshot } from "../background-snapshot.js";

function backgroundSnapshot(): BackgroundSnapshot {
  return {
    schema: "mono-agent.background-snapshot.v1",
    configPath: "/agents/a/mono-agent.config.json",
    configFingerprint: "config-fingerprint",
    dotenvPath: "/agents/a/.env",
    dotenvFingerprint: "dotenv-fingerprint",
    identityPath: "/agents/a/IDENTITY.md",
    identityFingerprint: "identity-fingerprint",
    operationalEnvironmentFingerprint: "environment-fingerprint",
  };
}

function source(overrides: Partial<TraceSourceListItem> = {}): TraceSourceListItem {
  return {
    schema: "agent-runtime.trace-source.v1",
    sourceId: "agent-a",
    label: "agent-a",
    artifactDir: "/tmp/artifacts",
    pid: 123,
    status: "running",
    startedAt: "2026-07-01T00:00:00Z",
    updatedAt: new Date().toISOString(),
    transports: ["tui"],
    configPath: "/agents/a/mono-agent.config.json",
    metadata: {
      reason: "startup-complete",
      lifecycle: { startupCompleted: true },
      channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/gui" } },
    },
    health: "running",
    warnings: [],
    ...overrides,
  };
}

describe("parseCliArgs tui", () => {
  it("parses the tui command with --agent and --conversation", () => {
    const args = parseCliArgs(["tui", "--agent", "personal-agent", "--conversation", "ops"]);
    expect(args.command).toBe("tui");
    expect(args.agent).toBe("personal-agent");
    expect(args.conversation).toBe("ops");
  });

  it("keeps tui flag-free invocation valid", () => {
    expect(parseCliArgs(["tui"]).command).toBe("tui");
  });

  it("parses remote configuration and rejects combining it with local mode", () => {
    expect(parseCliArgs(["tui", "--configure"])).toMatchObject({
      command: "tui",
      configure: true,
    });
    expect(() => parseCliArgs(["tui", "--local", "--configure"])).toThrow(/omit --local/u);
  });
});

describe("resolveTuiLaunch", () => {
  it("returns none with a start hint when nothing is running", () => {
    const plan = resolveTuiLaunch([], ["/reg"], undefined);
    expect(plan.kind).toBe("none");
    expect((plan as { message: string }).message).toContain("mono-agent start");
    expect((plan as { message: string }).message).toContain("registry: /reg");
  });

  it("names both registries in the hint when merged and nothing is running", () => {
    const plan = resolveTuiLaunch([], ["/local", "/global"], undefined);
    expect(plan.kind).toBe("none");
    expect((plan as { message: string }).message).toContain("/local");
    expect((plan as { message: string }).message).toContain("/global");
  });

  it("auto-connects a single running agent", () => {
    const plan = resolveTuiLaunch([source()], ["/reg"], undefined);
    expect(plan).toEqual({ kind: "connect", source: source({ updatedAt: (plan as { source: TraceSourceListItem }).source.updatedAt }) });
  });

  it("opens the picker for several agents", () => {
    const sources = [source(), source({ sourceId: "agent-b", label: "agent-b" })];
    const plan = resolveTuiLaunch(sources, ["/reg"], undefined);
    expect(plan.kind).toBe("picker");
    expect((plan as { sources: readonly TraceSourceListItem[] }).sources).toHaveLength(2);
  });

  it("matches --agent by label or sourceId and errors with the available list", () => {
    const sources = [source(), source({ sourceId: "id-b", label: "beta" })];
    expect(resolveTuiLaunch(sources, ["/reg"], "beta").kind).toBe("connect");
    expect(resolveTuiLaunch(sources, ["/reg"], "id-b").kind).toBe("connect");

    const miss = resolveTuiLaunch(sources, ["/reg"], "nope");
    expect(miss.kind).toBe("error");
    expect((miss as { message: string }).message).toContain("beta");
  });

  it("ignores stopped sources everywhere", () => {
    const stopped = source({ status: "stopped", health: "stopped" });
    expect(resolveTuiLaunch([stopped], ["/reg"], undefined).kind).toBe("none");
    expect(resolveTuiLaunch([stopped], ["/reg"], "agent-a").kind).toBe("error");
  });
});

// mergeTraceSources itself lives in @mono-agent/observability (next to
// listTraceSources) and is unit-tested there; these tests cover runTui's use
// of it (the dual-registry union below).

describe("tuiEndpointOf", () => {
  it("reads a running tui channel's baseUrl and rejects non-running", () => {
    expect(tuiEndpointOf(source())).toBe("http://127.0.0.1:5151/gui");
    expect(tuiEndpointOf(source({ metadata: { channels: { tui: { kind: "disabled" } } } }))).toBeUndefined();
    expect(tuiEndpointOf(source({ metadata: {} }))).toBeUndefined();
  });

  it("treats a malformed empty baseUrl as no endpoint (discovery fallback)", () => {
    expect(
      tuiEndpointOf(source({ metadata: { channels: { tui: { kind: "running", baseUrl: "" } } } })),
    ).toBeUndefined();
  });
});

describe("runTui", () => {
  const baseOptions = {
    configPath: "/nowhere/mono-agent.config.json",
    cwd: "/nowhere",
    env: {},
  };

  it("rejects dotenv drift instead of adopting a second environment during attach verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-tui-attach-env-"));
    try {
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\nAttach test.\n");
      await writeFile(configPath, `${JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
        context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
        tools: { allowedTools: [], disallowedTools: [] },
        artifacts: { dir: "./artifacts" },
        traceability: { registryDir: "./trace-sources", sourceId: "attach-test" },
      }, null, 2)}\n`);
      await writeFile(join(dir, ".env"), "ATTACH_TEST_KEY=first-value\n", { mode: 0o600 });
      const reconstructedEnvironment = { ATTACH_TEST_KEY: "first-value" };

      await writeFile(join(dir, ".env"), "ATTACH_TEST_KEY=second-value\n", { mode: 0o600 });

      await expect(captureManagedConfigurationAttachSnapshot({ cwd: dir, configPath }, reconstructedEnvironment))
        .rejects.toThrow(/effective ATTACH_TEST_KEY value does not match/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds the current-folder responder in-process without registry discovery", async () => {
    const started: Record<string, unknown>[] = [];
    let disposed = 0;
    let listed = 0;
    const code = await runTui({ ...baseOptions, local: true }, {
      isTty: true,
      listSources: async () => {
        listed += 1;
        return { registryDir: "/reg", sources: [], warnings: [] };
      },
      createLocalSession: async () => ({
        responder: { respond: async () => ({ text: "ok" }) },
        title: "Local Agent",
        dispose: async () => { disposed += 1; },
      }),
      startTui: async (options) => {
        started.push(options);
        return { waitUntilExit: async () => {} };
      },
    });

    expect(code).toBe(0);
    expect(listed).toBe(0);
    expect(disposed).toBe(1);
    expect(started[0]).toMatchObject({
      title: "Local Agent",
      conversationId: "tui-local",
      config: { path: baseOptions.configPath, cwd: baseOptions.cwd },
    });
  });

  it("uses one durable environment for configuration discovery, verification, attach, and restart", async () => {
    const started: Record<string, unknown>[] = [];
    const out: string[] = [];
    const listedRegistryDirs: string[] = [];
    let disposed = 0;
    let restartSeen = false;
    let environmentLoads = 0;
    const shellEnvironment = {
      MONO_AGENT_TRACE_REGISTRY_DIR: "/shell-registry",
      MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/shell-global-registry",
      MONO_AGENT_TUI_API_KEY: "shell-key",
    };
    const durableEnvironment = {
      MONO_AGENT_TRACE_REGISTRY_DIR: "/durable-registry",
      MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/durable-registry",
      MONO_AGENT_TUI_API_KEY: "durable-worker-key",
    };
    const current = source({
      sourceId: "current",
      label: "current",
      configPath: baseOptions.configPath,
      metadata: {
        reason: "memory-health-periodic",
        lifecycle: { startupCompleted: true },
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/gui" } },
      },
    });
    const other = source({ sourceId: "other", label: "other", configPath: "/other/mono-agent.config.json" });
    const code = await runTui({ ...baseOptions, env: shellEnvironment, configure: true }, {
      isTty: true,
      platform: "darwin",
      listSources: async ({ registryDir }) => {
        listedRegistryDirs.push(registryDir);
        return { registryDir, sources: [other, current], warnings: [] };
      },
      verifyConfigurationSource: async (_source, environment) => {
        expect(environment).toEqual(durableEnvironment);
        return current;
      },
      loadConfigurationEnvironment: async () => {
        environmentLoads += 1;
        return durableEnvironment;
      },
      restartBackground: async (_snapshot, environment) => {
        restartSeen = true;
        expect(environment).toEqual(durableEnvironment);
        const apiKey = environment.MONO_AGENT_TUI_API_KEY;
        return {
          ok: true,
          connection: {
            baseUrl: "http://127.0.0.1:6161/gui",
            ...(apiKey === undefined ? {} : { apiKey }),
          },
        };
      },
      createRemoteConfigurationSession: async (options) => {
        expect(options.env).toEqual(durableEnvironment);
        const restarted = await options.restartBackground(backgroundSnapshot());
        expect(restarted).toMatchObject({
          ok: true,
          connection: { baseUrl: "http://127.0.0.1:6161/gui", apiKey: "durable-worker-key" },
        });
        return {
          configuration: { marker: "remote-controller" },
          dispose: async () => { disposed += 1; },
        };
      },
      startTui: async (options) => {
        started.push(options);
        return { waitUntilExit: async () => {} };
      },
      stdout: { write: (text) => void out.push(text) },
    });

    expect(code).toBe(0);
    expect(environmentLoads).toBe(1);
    expect(listedRegistryDirs).toEqual(["/durable-registry"]);
    expect(listedRegistryDirs).not.toContain("/shell-registry");
    expect(listedRegistryDirs).not.toContain("/shell-global-registry");
    expect(restartSeen).toBe(true);
    expect(disposed).toBe(1);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      connection: { baseUrl: "http://127.0.0.1:5151/gui", apiKey: "durable-worker-key" },
      configuration: { marker: "remote-controller" },
      instance: { label: "current" },
      conversationId: "tui-current",
    });
    expect(out.join("")).toContain("no background stop was requested");
    expect(out.join("")).toContain("before assuming the agent is running");
    expect(out.join("")).not.toContain("background agent keeps running");
  });

  it.skipIf(process.platform === "win32")("matches the authoritative config through a symlinked parent alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-tui-config-alias-"));
    try {
      const agentDir = join(root, "agent");
      const aliasDir = join(root, "agent-alias");
      await mkdir(agentDir);
      const configPath = join(agentDir, "mono-agent.config.json");
      const aliasConfigPath = join(aliasDir, "mono-agent.config.json");
      await writeFile(configPath, "{}\n");
      await symlink(agentDir, aliasDir, "dir");
      const canonicalConfigPath = join(await realpath(agentDir), "mono-agent.config.json");

      const durableEnvironment = {
        MONO_AGENT_TRACE_REGISTRY_DIR: join(root, "registry"),
        MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(root, "registry"),
      };
      const current = source({
        sourceId: "canonical-agent",
        label: "canonical-agent",
        configPath: canonicalConfigPath,
      });
      let attachedConfigPath: string | undefined;
      const code = await runTui({
        configPath: aliasConfigPath,
        cwd: root,
        env: {},
        configure: true,
      }, {
        isTty: true,
        platform: "darwin",
        loadConfigurationEnvironment: async () => durableEnvironment,
        listSources: async ({ registryDir }) => ({
          registryDir,
          sources: [current],
          warnings: [],
        }),
        verifyConfigurationSource: async (candidate) => {
          expect(candidate.sourceId).toBe("canonical-agent");
          return current;
        },
        createRemoteConfigurationSession: async (options) => {
          attachedConfigPath = options.configPath;
          return {
            configuration: { marker: "canonical-controller" },
            dispose: async () => undefined,
          };
        },
        startTui: async (options) => {
          expect(options).toMatchObject({
            connection: { baseUrl: "http://127.0.0.1:5151/gui" },
            configuration: { marker: "canonical-controller" },
          });
          return { waitUntilExit: async () => undefined };
        },
        stdout: { write: () => undefined },
      });

      expect(code).toBe(0);
      expect(attachedConfigPath).toBe(canonicalConfigPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicit configuration target owned by another config", async () => {
    const errors: string[] = [];
    const current = source({ sourceId: "current", configPath: baseOptions.configPath });
    const other = source({ sourceId: "other", label: "other", configPath: "/other/mono-agent.config.json" });
    const code = await runTui({ ...baseOptions, configure: true, agent: "other" }, {
      isTty: true,
      platform: "darwin",
      listSources: async () => ({ registryDir: "/reg", sources: [current, other], warnings: [] }),
      startTui: async () => { throw new Error("must not start"); },
      stderr: { write: (text) => void errors.push(text) },
    });

    expect(code).toBe(1);
    expect(errors.join("")).toContain("does not own this folder");
  });

  it("refuses configuration when the registry source cannot be proven against launchd and the live TUI", async () => {
    const errors: string[] = [];
    let sessionCreated = false;
    const current = source({ sourceId: "current", configPath: baseOptions.configPath });
    const code = await runTui({ ...baseOptions, configure: true }, {
      isTty: true,
      platform: "darwin",
      listSources: async () => ({ registryDir: "/reg", sources: [current], warnings: [] }),
      verifyConfigurationSource: async () => undefined,
      createRemoteConfigurationSession: async () => {
        sessionCreated = true;
        throw new Error("must not create");
      },
      startTui: async () => { throw new Error("must not start"); },
      stderr: { write: (text) => void errors.push(text) },
    });

    expect(code).toBe(1);
    expect(sessionCreated).toBe(false);
    expect(errors.join("")).toContain("one live launchd PID");
    expect(errors.join("")).toContain("exact durable-input snapshot");
    expect(errors.join("")).toContain("reachable TUI endpoint");
  });

  it("fails explicitly when self-configuration cannot use managed macOS lifecycle", async () => {
    const errors: string[] = [];
    const code = await runTui({ ...baseOptions, configure: true }, {
      isTty: true,
      platform: "linux",
      stderr: { write: (text) => void errors.push(text) },
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("managed macOS background lifecycle");
    expect(errors.join("")).toContain("IDENTITY.md");
  });

  it("rejects local configuration and a reason-only legacy trace without durable startup proof", async () => {
    const localErrors: string[] = [];
    expect(await runTui({ ...baseOptions, configure: true, local: true }, {
      isTty: true,
      platform: "darwin",
      stderr: { write: (text) => void localErrors.push(text) },
    })).toBe(1);
    expect(localErrors.join("")).toContain("remove `--local`");

    const readinessErrors: string[] = [];
    const stale = source({
      configPath: baseOptions.configPath,
      metadata: { reason: "startup-complete", channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/gui" } } },
    });
    expect(await runTui({ ...baseOptions, configure: true }, {
      isTty: true,
      platform: "darwin",
      listSources: async () => ({ registryDir: "/reg", sources: [stale], warnings: [] }),
      stderr: { write: (text) => void readinessErrors.push(text) },
      stdout: { write: () => {} },
    })).toBe(1);
    expect(readinessErrors.join("")).toContain("No ready background agent");
  });

  it("connects with connection + instance for a single running agent", async () => {
    const started: Record<string, unknown>[] = [];
    let configurationEnvironmentLoads = 0;
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async () => ({ registryDir: "/reg", sources: [source()], warnings: [] }),
      loadConfigurationEnvironment: async () => {
        configurationEnvironmentLoads += 1;
        throw new Error("ordinary remote TUI must stay lazy");
      },
      startTui: async (options) => {
        started.push(options);
        return { waitUntilExit: async () => {} };
      },
    });

    expect(code).toBe(0);
    expect(configurationEnvironmentLoads).toBe(0);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      connection: { baseUrl: "http://127.0.0.1:5151/gui" },
      instance: { label: "agent-a", artifactDir: "/tmp/artifacts" },
      conversationId: "tui-agent-a",
    });
  });

  it("passes discovery mode when several agents run", async () => {
    const started: Record<string, unknown>[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async () => ({
        registryDir: "/reg",
        sources: [source(), source({ sourceId: "agent-b", label: "agent-b" })],
        warnings: [],
      }),
      startTui: async (options) => {
        started.push(options);
        return { waitUntilExit: async () => {} };
      },
    });

    expect(code).toBe(0);
    expect(started[0]).toMatchObject({ discovery: { registryDirs: ["/reg"] } });
  });

  it("merges the configured and global registries by sourceId, opening the picker over the union with the fresher dupe winning", async () => {
    const started: Record<string, unknown>[] = [];
    const localOnly = source({ sourceId: "local-only", label: "local-only" });
    const globalOnly = source({ sourceId: "global-only", label: "global-only" });
    const staleDupe = source({ sourceId: "dupe", label: "stale-copy", updatedAt: "2026-07-01T00:00:00.000Z" });
    const freshDupe = source({ sourceId: "dupe", label: "fresh-copy", updatedAt: "2026-07-02T00:00:00.000Z" });

    const code = await runTui(
      {
        configPath: "/local-agent/mono-agent.config.json",
        cwd: "/local-agent",
        env: {
          MONO_AGENT_TRACE_REGISTRY_DIR: "/local-registry",
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/global-registry",
        },
      },
      {
        isTty: true,
        listSources: async (options): Promise<TraceSourceListResult> =>
          options.registryDir === "/global-registry"
            ? { registryDir: "/global-registry", sources: [globalOnly, freshDupe], warnings: [] }
            : { registryDir: "/local-registry", sources: [localOnly, staleDupe], warnings: [] },
        startTui: async (options) => {
          started.push(options);
          return { waitUntilExit: async () => {} };
        },
      },
    );

    expect(code).toBe(0);
    expect(started).toHaveLength(1);
    // The merge collapses the "dupe" sourceId to one entry (fresher wins) —
    // three total instances across both registries. The picker gets BOTH
    // registries: its in-TUI refresh must keep showing agents that exist only
    // in the local one (opt-outs, or agents on a pre-mirror build).
    const plan = started[0] as { discovery?: { registryDirs?: readonly string[] } };
    expect(plan.discovery?.registryDirs).toEqual(["/local-registry", "/global-registry"]);
  });

  it("hands the connect-path discovery fallback BOTH registries so an opt-out agent stays reachable", async () => {
    const started: Record<string, unknown>[] = [];
    // An opt-out agent (globalDiscovery:false) exists ONLY in its local
    // registry and has no tui stream endpoint: the discovery fallback's
    // registry union must include its local registry.
    const localOnly = source({ sourceId: "local-only", label: "local-only", metadata: {} });
    const globalOnly = source({ sourceId: "global-only", label: "global-only" });

    const code = await runTui(
      {
        configPath: "/local-agent/mono-agent.config.json",
        cwd: "/local-agent",
        env: {
          MONO_AGENT_TRACE_REGISTRY_DIR: "/local-registry",
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/global-registry",
        },
        agent: "local-only",
      },
      {
        isTty: true,
        listSources: async (options): Promise<TraceSourceListResult> =>
          options.registryDir === "/global-registry"
            ? { registryDir: "/global-registry", sources: [globalOnly], warnings: [] }
            : { registryDir: "/local-registry", sources: [localOnly], warnings: [] },
        startTui: async (options) => {
          started.push(options);
          return { waitUntilExit: async () => {} };
        },
        stdout: { write: () => {} },
      },
    );

    expect(code).toBe(0);
    expect(started[0]).toMatchObject({
      discovery: { registryDirs: ["/local-registry", "/global-registry"] },
    });
  });

  it("does not re-list the global registry when it is identical to the configured one", async () => {
    const calls: string[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async (options) => {
        calls.push(options.registryDir);
        return { registryDir: "/reg", sources: [source()], warnings: [] };
      },
      startTui: async () => ({ waitUntilExit: async () => {} }),
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("exits 1 with a hint when nothing is running", async () => {
    const out: string[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async () => ({ registryDir: "/reg", sources: [], warnings: [] }),
      startTui: async () => {
        throw new Error("must not start");
      },
      stdout: { write: (text) => void out.push(text) },
    });

    expect(code).toBe(1);
    expect(out.join("")).toContain("mono-agent start");
  });

  it("refuses without a TTY", async () => {
    const err: string[] = [];
    const code = await runTui(baseOptions, {
      isTty: false,
      stderr: { write: (text) => void err.push(text) },
    });

    expect(code).toBe(1);
    expect(err.join("")).toContain("TTY");
  });
});

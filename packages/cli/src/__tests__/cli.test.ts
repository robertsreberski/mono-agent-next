import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

const core = vi.hoisted(() => ({
  composeAgentConfigSchema: vi.fn(),
  createAgentHost: vi.fn(),
  diagnoseAgent: vi.fn(),
  explainAgentConfig: vi.fn(),
  inspectAgent: vi.fn(),
  runAgentModuleCommand: vi.fn(),
  validateAgentConfig: vi.fn(),
}));

vi.mock("@mono-agent/core", () => core);

import { runCli, type CliSignal, type CliSignalSource } from "../index.js";

const temporaryDirectories: string[] = [];
const expectedUsage = [
  "Usage:",
  "  mono-agent validate --config <file> [--json]",
  "  mono-agent doctor --config <file> [--json]",
  "  mono-agent config schema --config <file> [--write]",
  "  mono-agent config explain --config <file> [path] [--json]",
  "  mono-agent inspect --config <file> [--json]",
  "  mono-agent module command --config <file> --module <id> --name <command> [--input-json <json>]",
  "  mono-agent auth <command> --config <file> --module <runtime-id> [--input-json <json>]",
  "  mono-agent sandbox <command> --config <file> [--input-json <json>]",
  "  mono-agent runs <command> --config <file> [--input-json <json>]",
  "  mono-agent memory <command> --config <file> [--input-json <json>]",
  "  mono-agent start --config <file>",
  "  mono-agent --version",
  "",
].join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  core.validateAgentConfig.mockResolvedValue({
    ok: true,
    issues: [],
    loaded: { configPath: "/agent/config.json", immutable: true },
  });
  core.composeAgentConfigSchema.mockResolvedValue({ type: "object", additionalProperties: false });
  core.explainAgentConfig.mockResolvedValue({ path: "routing.primary", source: "config" });
  core.inspectAgent.mockResolvedValue({ agent: { id: "fixture" }, modules: [] });
  core.diagnoseAgent.mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runCli", () => {
  it("prints the package version exactly for both version flags", async () => {
    for (const flag of ["--version", "-v"]) {
      const output = captureOutput();

      await expect(runCli([flag], output.io)).resolves.toBe(0);

      expect(output.stdout).toEqual([`${packageJson.version}\n`]);
      expect(output.stderr).toEqual([]);
    }
  });

  it("prints exact usage for both help flags and bare invocation", async () => {
    for (const argv of [["--help"], ["-h"], []] as const) {
      const output = captureOutput();

      await expect(runCli(argv, output.io)).resolves.toBe(0);

      expect(output.stdout).toEqual([expectedUsage]);
      expect(output.stderr).toEqual([]);
    }
  });

  it("returns usage exit 2 for an invalid invocation", async () => {
    const output = captureOutput();
    await expect(runCli(["validate"], output.io)).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("--config is required");
  });

  it("preserves strict option, inline-config, positional, and JSON-value parsing", async () => {
    const inline = captureOutput("/agent");
    await expect(runCli(["validate", "--config=config.json", "--json"], inline.io)).resolves.toBe(0);
    expect(core.validateAgentConfig).toHaveBeenLastCalledWith("/agent/config.json");

    for (const [argv, message] of [
      [["validate", "-c", "/a", "--config", "/b"], "--config may be supplied only once"],
      [["validate", "-c", "/a", "--json", "--json"], "--json is not valid here"],
      [["validate", "--config", "--json"], "--config requires a path"],
      [["validate", "-"], "Unknown option: -"],
      [["config", "schema", "-c", "/a", "--json"], "--json is not valid here"],
      [["config", "explain", "-c", "/a", "routing", "extra"], "Unexpected argument: extra"],
      [["module", "command", "--config=/a"], "Unknown module command option: --config=/a"],
      [["module", "command", "-c", "/a", "extra"], "Unknown module command option: extra"],
      [["memory", "memory-local:audit", "--name", "memory-local:retry", "-c", "/a"],
        "--name requires one command name"],
    ] as const) {
      const output = captureOutput();
      await expect(runCli(argv, output.io)).resolves.toBe(2);
      expect(output.stderr.join("")).toContain(message);
    }

    core.runAgentModuleCommand.mockResolvedValue({ module: "cron", command: "cron:test", value: -1 });
    const negative = captureOutput();
    await expect(runCli([
      "module", "command", "-c", "/a", "--module", "cron",
      "--name", "cron:test", "--input-json", "-1",
    ], negative.io)).resolves.toBe(0);
    expect(core.runAgentModuleCommand).toHaveBeenCalledWith("/a", "cron", "cron:test", -1);
  });

  it("validates relative to the supplied working directory and emits JSON", async () => {
    const output = captureOutput("/tmp/example-agent");
    await expect(runCli(["validate", "--config", "mono-agent.config.json", "--json"], output.io)).resolves.toBe(0);

    expect(core.validateAgentConfig).toHaveBeenCalledWith("/tmp/example-agent/mono-agent.config.json");
    expect(JSON.parse(output.stdout.join(""))).toEqual({
      ok: true,
      configPath: "/tmp/example-agent/mono-agent.config.json",
      issues: [],
    });
  });

  it("maps strict validation failures to exit 1", async () => {
    core.validateAgentConfig.mockResolvedValue({
      ok: false,
      issues: [{ path: "channels.inbound.apiKey", message: "inline secrets are forbidden" }],
    });
    const output = captureOutput();

    await expect(runCli(["validate", "--config", "/agent/config.json"], output.io)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("channels.inbound.apiKey: inline secrets are forbidden");
  });

  it("runs selected-module diagnostics after validation and returns a stable doctor result", async () => {
    core.diagnoseAgent.mockResolvedValue([{
      kind: "runtime",
      instanceId: "primary",
      diagnostics: [{ code: "runtime.ready", severity: "info", message: "ready" }],
    }]);
    const output = captureOutput();

    await expect(runCli(["doctor", "--config", "/agent/config.json", "--json"], output.io)).resolves.toBe(0);

    expect(core.diagnoseAgent).toHaveBeenCalledWith(expect.objectContaining({ immutable: true }), true);
    expect(core.createAgentHost).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout.join(""))).toEqual({
      ok: true,
      configPath: "/agent/config.json",
      issues: [],
      diagnostics: [{
        kind: "runtime",
        instanceId: "primary",
        diagnostics: [{ code: "runtime.ready", severity: "info", message: "ready" }],
      }],
    });
  });

  it("maps validation and selected-module diagnostic errors to doctor exit 1", async () => {
    core.validateAgentConfig.mockResolvedValueOnce({
      ok: false,
      issues: [{ path: "memory", message: "invalid memory config" }],
    });
    const invalid = captureOutput();
    await expect(runCli(["doctor", "--config", "/agent/config.json", "--json"], invalid.io)).resolves.toBe(1);
    expect(JSON.parse(invalid.stdout.join(""))).toMatchObject({
      ok: false,
      diagnostics: [],
      issues: [{ path: "memory", message: "invalid memory config" }],
    });
    expect(core.createAgentHost).not.toHaveBeenCalled();

    core.diagnoseAgent.mockResolvedValue([{
      kind: "memory",
      instanceId: "memory",
      diagnostics: [{ code: "memory.unavailable", severity: "error", message: "unavailable" }],
    }]);
    const unhealthy = captureOutput();
    await expect(runCli(["doctor", "-c", "/agent/config.json", "--json"], unhealthy.io)).resolves.toBe(1);
    expect(JSON.parse(unhealthy.stdout.join(""))).toMatchObject({ ok: false });
  });

  it("removes startup signal listeners when host creation fails", async () => {
    const signals = new TestSignalSource();
    const existingListener = (): void => undefined;
    signals.once("SIGINT", existingListener);
    signals.once("SIGTERM", existingListener);
    const baseline = {
      SIGINT: signals.listenerCount("SIGINT"),
      SIGTERM: signals.listenerCount("SIGTERM"),
    };
    core.createAgentHost.mockImplementation(async () => {
      expect(signals.listenerCount("SIGINT")).toBe(baseline.SIGINT + 1);
      expect(signals.listenerCount("SIGTERM")).toBe(baseline.SIGTERM + 1);
      throw new Error("boot failed");
    });
    const output = captureOutput();

    await expect(runCli(["start", "--config", "/agent/mono-agent.config.json"], {
      ...output.io,
      signalSource: signals,
    })).resolves.toBe(1);

    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["mono-agent: boot failed\n"]);
    expect(signals.listenerCount("SIGINT")).toBe(baseline.SIGINT);
    expect(signals.listenerCount("SIGTERM")).toBe(baseline.SIGTERM);
  });

  it("drains then stops when SIGTERM arrives before host creation resolves", async () => {
    const calls: string[] = [];
    const host = {
      startInfo: {
        agentId: "minimal-example",
        configPath: "/agent/mono-agent.config.json",
        projectRoot: "/agent",
        channels: [],
      },
      start: vi.fn(async () => calls.push("start")),
      drain: vi.fn(async () => calls.push("drain")),
      stop: vi.fn(async () => calls.push("stop")),
    };
    let resolveHost: ((value: typeof host) => void) | undefined;
    core.createAgentHost.mockImplementation(() => new Promise<typeof host>((resolvePromise) => {
      resolveHost = resolvePromise;
    }));
    const signals = new TestSignalSource();
    const output = captureOutput();
    const result = runCli(["start", "--config", "/agent/mono-agent.config.json"], {
      ...output.io,
      signalSource: signals,
    });

    await vi.waitFor(() => expect(core.createAgentHost).toHaveBeenCalledOnce());
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    expect(calls).toEqual([]);
    expect(output.stdout).toEqual([]);

    expect(resolveHost).toBeDefined();
    resolveHost!(host);

    await expect(result).resolves.toBe(0);
    expect(calls).toEqual(["drain", "stop"]);
    expect(host.start).not.toHaveBeenCalled();
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ event: "started" });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("prints exactly one started event and drains before stopping on SIGTERM", async () => {
    const calls: string[] = [];
    const host = {
      startInfo: {
        agentId: "minimal-example",
        configPath: "/agent/mono-agent.config.json",
        projectRoot: "/agent",
        channels: [
          {
            instanceId: "inbound",
            kind: "channel",
            endpoint: "http://127.0.0.1:3210",
          },
        ],
      },
      start: vi.fn(async () => calls.push("start")),
      drain: vi.fn(async () => calls.push("drain")),
      stop: vi.fn(async () => calls.push("stop")),
    };
    core.createAgentHost.mockResolvedValue(host);
    const signals = new TestSignalSource();
    const output = captureOutput();
    const result = runCli(["start", "--config", "/agent/mono-agent.config.json"], {
      ...output.io,
      signalSource: signals,
    });

    await vi.waitFor(() => expect(output.stdout).toHaveLength(1));
    signals.emit("SIGTERM");

    await expect(result).resolves.toBe(0);
    expect(calls).toEqual(["drain", "stop"]);
    expect(host.start).not.toHaveBeenCalled();
    expect(core.createAgentHost).toHaveBeenCalledWith({
      configPath: "/agent/config.json",
      immutable: true,
    });
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      event: "started",
      channels: [{ endpoint: "http://127.0.0.1:3210" }],
    });
  });

  it("never reloads the config path after validation", async () => {
    const loaded = Object.freeze({
      configPath: "/agent/mono-agent.config.json",
      sourceDigest: "sha256:captured",
    });
    core.validateAgentConfig.mockResolvedValue({ ok: true, issues: [], loaded });
    const host = {
      startInfo: {
        agentId: "minimal-example",
        configPath: loaded.configPath,
        projectRoot: "/agent",
        channels: [],
      },
      start: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    core.createAgentHost.mockResolvedValue(host);
    const signals = new TestSignalSource();
    const output = captureOutput();
    const result = runCli(["start", "--config", loaded.configPath], {
      ...output.io,
      signalSource: signals,
    });

    await vi.waitFor(() => expect(output.stdout).toHaveLength(1));
    signals.emit("SIGTERM");
    await expect(result).resolves.toBe(0);
    expect(core.createAgentHost).toHaveBeenCalledWith(loaded);
    expect(core.createAgentHost).not.toHaveBeenCalledWith(loaded.configPath);
  });

  it("still stops the host when draining fails", async () => {
    const host = {
      startInfo: {
        agentId: "minimal-example",
        configPath: "/agent/mono-agent.config.json",
        projectRoot: "/agent",
        channels: [],
      },
      start: vi.fn(async () => undefined),
      drain: vi.fn(async () => {
        throw new Error("drain failed");
      }),
      stop: vi.fn(async () => undefined),
    };
    core.createAgentHost.mockResolvedValue(host);
    const signals = new TestSignalSource();
    const output = captureOutput();
    const result = runCli(["start", "--config", "/agent/mono-agent.config.json"], {
      ...output.io,
      signalSource: signals,
    });

    await vi.waitFor(() => expect(output.stdout).toHaveLength(1));
    signals.emit("SIGINT");

    await expect(result).resolves.toBe(1);
    expect(host.stop).toHaveBeenCalledOnce();
    expect(output.stderr.join("")).toContain("drain failed");
  });

  it("writes a schema atomically and refuses a symlinked schema directory", async () => {
    const root = await makeTemporaryDirectory();
    const agent = join(root, "agent");
    const external = join(root, "external");
    await mkdir(agent);
    await mkdir(external);
    await writeFile(join(agent, "mono-agent.config.json"), "{}\n", "utf8");
    await writeFile(join(external, "sentinel"), "unchanged", "utf8");
    await symlink(external, join(agent, ".mono-agent"));
    const output = captureOutput();

    await expect(runCli([
      "config",
      "schema",
      "--config",
      join(agent, "mono-agent.config.json"),
      "--write",
    ], output.io)).resolves.toBe(1);

    await expect(readFile(join(external, "sentinel"), "utf8")).resolves.toBe("unchanged");
    await expect(readFile(join(external, "mono-agent.config.schema.json"), "utf8")).rejects.toThrow();
  });

  it("prints the composed schema without creating a file unless --write is set", async () => {
    const root = await makeTemporaryDirectory();
    const configPath = join(root, "mono-agent.config.json");
    const schemaPath = join(root, ".mono-agent", "mono-agent.config.schema.json");
    await writeFile(configPath, "{}\n", "utf8");
    const output = captureOutput();

    await expect(runCli([
      "config",
      "schema",
      "--config",
      configPath,
    ], output.io)).resolves.toBe(0);

    expect(output.stdout).toEqual([`${JSON.stringify({
      type: "object",
      additionalProperties: false,
    }, null, 2)}\n`]);
    expect(output.stderr).toEqual([]);
    await expect(readFile(schemaPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes the composed schema beside the config", async () => {
    const root = await makeTemporaryDirectory();
    const configPath = join(root, "mono-agent.config.json");
    await writeFile(configPath, "{}\n", "utf8");
    const output = captureOutput();

    await expect(runCli([
      "config",
      "schema",
      "--config",
      configPath,
      "--write",
    ], output.io)).resolves.toBe(0);

    const schemaPath = join(root, ".mono-agent", "mono-agent.config.schema.json");
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual({
      type: "object",
      additionalProperties: false,
    });
    expect(JSON.parse(output.stdout.join(""))).toEqual({ ok: true, path: schemaPath });
  });

  it("passes an optional explain path without exposing any environment value", async () => {
    core.explainAgentConfig.mockResolvedValue({
      configPath: "/agent/config.json",
      entries: [{
        path: "channels.inbound.apiKey",
        owner: "@mono-agent/channel-webhook",
        schemaPointer: "/properties/channels/additionalProperties/properties/apiKey",
        source: "environment",
        env: "WEBHOOK_API_KEY",
        redacted: true,
        remediation: "Set WEBHOOK_API_KEY in the process environment.",
      }],
    });
    const output = captureOutput();
    await expect(runCli([
      "config",
      "explain",
      "--config",
      "/agent/config.json",
      "channels.inbound.apiKey",
      "--json",
    ], output.io)).resolves.toBe(0);

    expect(core.explainAgentConfig).toHaveBeenCalledWith("/agent/config.json");
    expect(output.stdout.join("")).not.toContain("secret-value");
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      entries: [{
        schemaPointer: "/properties/channels/additionalProperties/properties/apiKey",
        source: "environment",
        env: "WEBHOOK_API_KEY",
        redacted: true,
        remediation: "Set WEBHOOK_API_KEY in the process environment.",
      }],
    });
  });

  it("inspects without starting modules and runs one selected module command with bounded cleanup", async () => {
    const inspectOutput = captureOutput();
    await expect(runCli(["inspect", "--config", "/agent/config.json", "--json"], inspectOutput.io)).resolves.toBe(0);
    expect(core.inspectAgent).toHaveBeenCalledWith("/agent/config.json");
    expect(JSON.parse(inspectOutput.stdout.join(""))).toMatchObject({ agent: { id: "fixture" } });

    core.runAgentModuleCommand.mockResolvedValue({
      module: "cron",
      command: "cron:invoke",
      value: { accepted: true },
    });
    const commandOutput = captureOutput();
    await expect(runCli([
      "module", "command",
      "--config", "/agent/config.json",
      "--module", "cron",
      "--name", "cron:invoke",
      "--input-json", '{"jobId":"daily"}',
    ], commandOutput.io)).resolves.toBe(0);
    expect(core.runAgentModuleCommand).toHaveBeenCalledWith(
      "/agent/config.json",
      "cron",
      "cron:invoke",
      { jobId: "daily" },
    );
  });

  it("routes named maintenance and auth commands only to the configured slot", async () => {
    const loaded = {
      immutable: true,
      modules: [
        { slot: "runtime", instanceId: "primary" },
        { slot: "memory", instanceId: "memory" },
        { slot: "state", instanceId: "state" },
      ],
    };
    core.validateAgentConfig.mockResolvedValue({ ok: true, issues: [], loaded });
    core.runAgentModuleCommand.mockImplementation(
      async (_config: unknown, module: string, command: string) => ({ module, command }),
    );

    const memory = captureOutput();
    await expect(runCli([
      "memory", "memory-local:audit", "--config", "/agent/config.json",
    ], memory.io)).resolves.toBe(0);
    expect(core.runAgentModuleCommand).toHaveBeenLastCalledWith(
      loaded,
      "memory",
      "memory-local:audit",
      undefined,
    );
    expect(JSON.parse(memory.stdout.join(""))).toMatchObject({
      ok: true,
      route: "memory",
      module: "memory",
      command: "memory-local:audit",
    });

    const auth = captureOutput();
    await expect(runCli([
      "auth", "--config", "/agent/config.json", "--module", "primary",
      "--name", "pi:auth", "--input-json", '{"provider":"openai"}',
    ], auth.io)).resolves.toBe(0);
    expect(core.runAgentModuleCommand).toHaveBeenLastCalledWith(
      loaded,
      "primary",
      "pi:auth",
      { provider: "openai" },
    );
    expect(core.createAgentHost).not.toHaveBeenCalled();
  });

  it("reports absent and wrong-slot named command routes precisely without starting", async () => {
    core.validateAgentConfig.mockResolvedValue({
      ok: true,
      issues: [],
      loaded: {
        modules: [
          { slot: "state", instanceId: "state" },
          { slot: "memory", instanceId: "shared" },
        ],
      },
    });

    const absent = captureOutput();
    await expect(runCli([
      "sandbox", "sandbox-srt:status", "--config", "/agent/config.json",
    ], absent.io)).resolves.toBe(1);
    expect(absent.stderr.join("")).toContain("No sandbox module is configured; sandbox is unavailable");

    const wrong = captureOutput();
    await expect(runCli([
      "auth", "pi:auth", "--config", "/agent/config.json", "--module", "shared",
    ], wrong.io)).resolves.toBe(1);
    expect(wrong.stderr.join("")).toContain(
      'Selected module "shared" is configured in the memory slot; auth requires runtime',
    );
    expect(core.createAgentHost).not.toHaveBeenCalled();
    expect(core.runAgentModuleCommand).not.toHaveBeenCalled();
  });
});

class TestSignalSource implements CliSignalSource {
  readonly #events = new EventEmitter();

  once(signal: CliSignal, listener: () => void): this {
    this.#events.once(signal, listener);
    return this;
  }

  removeListener(signal: CliSignal, listener: () => void): this {
    this.#events.removeListener(signal, listener);
    return this;
  }

  emit(signal: CliSignal): void {
    this.#events.emit(signal);
  }

  listenerCount(signal: CliSignal): number {
    return this.#events.listenerCount(signal);
  }
}

function captureOutput(cwd = resolve("/tmp")): {
  io: { stdout: (text: string) => void; stderr: (text: string) => void; cwd: string };
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      cwd,
    },
    stdout,
    stderr,
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mono-agent-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}

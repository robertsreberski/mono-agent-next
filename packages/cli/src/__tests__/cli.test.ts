import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  composeAgentConfigSchema: vi.fn(),
  createAgentHost: vi.fn(),
  explainAgentConfig: vi.fn(),
  inspectAgent: vi.fn(),
  validateAgentConfig: vi.fn(),
}));

vi.mock("@mono-agent/core", () => core);

import { runCli, type CliSignal, type CliSignalSource } from "../index.js";

const temporaryDirectories: string[] = [];

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
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runCli", () => {
  it("returns usage exit 2 for an invalid invocation", async () => {
    const output = captureOutput();
    await expect(runCli(["validate"], output.io)).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("--config is required");
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
    expect(calls).toEqual(["start", "drain", "stop"]);
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

    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce());
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
        source: "env",
        env: "WEBHOOK_API_KEY",
        redacted: true,
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
      entries: [{ env: "WEBHOOK_API_KEY", redacted: true }],
    });
  });

  it("inspects without starting modules and runs one selected module command with bounded cleanup", async () => {
    const inspectOutput = captureOutput();
    await expect(runCli(["inspect", "--config", "/agent/config.json", "--json"], inspectOutput.io)).resolves.toBe(0);
    expect(core.inspectAgent).toHaveBeenCalledWith("/agent/config.json");
    expect(JSON.parse(inspectOutput.stdout.join(""))).toMatchObject({ agent: { id: "fixture" } });

    const host = {
      runModuleCommand: vi.fn(async () => ({ module: "cron", command: "cron:invoke", value: { accepted: true } })),
      stop: vi.fn(async () => undefined),
    };
    core.createAgentHost.mockResolvedValue(host);
    const commandOutput = captureOutput();
    await expect(runCli([
      "module", "command",
      "--config", "/agent/config.json",
      "--module", "cron",
      "--name", "cron:invoke",
      "--input-json", '{"jobId":"daily"}',
    ], commandOutput.io)).resolves.toBe(0);
    expect(host.runModuleCommand).toHaveBeenCalledWith("cron", "cron:invoke", { jobId: "daily" });
    expect(host.stop).toHaveBeenCalledOnce();
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

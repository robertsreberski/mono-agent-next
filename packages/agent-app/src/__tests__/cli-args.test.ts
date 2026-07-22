import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitForManagedRuntimePublication: vi.fn(async () => undefined),
}));

vi.mock("../managed-runtime-publication.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managed-runtime-publication.js")>();
  return { ...actual, waitForManagedRuntimePublication: mocks.waitForManagedRuntimePublication };
});

import { describeChannelStatus, loadCliEnvFile, monoAgentVersion, parseCliArgs, renderHelp, renderHelpTopic, runCli, shouldLoadCommandDotenv } from "../cli.js";

/** Resolve a help topic to its rendered detail text, failing if it is not a valid topic. */
function helpTopicText(topic: string): string {
  const result = renderHelpTopic(topic);
  if (!result.ok) {
    throw new Error(`expected help topic \`${topic}\` to resolve, got: ${result.message}`);
  }
  return result.text;
}
import { MANAGED_BACKGROUND_WORKER_ENV } from "../background-runtime.js";
import {
  INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND,
  MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV,
} from "../launchd.js";

const tempDirs: string[] = [];

afterEach(async () => {
  mocks.waitForManagedRuntimePublication.mockClear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cli-args-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseCliArgs", () => {
  it("parses init with model, fallbacks, effort, and memory", () => {
    expect(
      parseCliArgs([
        "init",
        "--model",
        "claude:claude-sonnet-4-6",
        "--fallback",
        "pi:ollama:gemma4:31b",
        "--fallback",
        "codex:gpt-5.6-terra",
        "--auth",
        "--effort",
        "high",
        "--memory",
        "journal",
      ]),
    ).toEqual({
      command: "init",
      model: "claude:claude-sonnet-4-6",
      fallbacks: [{ model: "pi:ollama:gemma4:31b" }, { model: "codex:gpt-5.6-terra" }],
      auth: true,
      effort: "high",
      memory: "journal",
      positionals: [],
      force: false,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
      includeMemory: false,
    });
  });

  it("rejects the removed --recipe and --fallback-models flags with a replacement hint", () => {
    expect(() => parseCliArgs(["init", "--recipe", "minimal-webhook"])).toThrow(/`--recipe` was removed; use `--preset/u);
    expect(() => parseCliArgs(["init", "--fallback-models", "codex:gpt-5.6-sol"]))
      .toThrow(/`--fallback-models` was removed; repeat `--fallback/u);
  });

  it("parses canonical named mixed-route init flags with exact per-route effort", () => {
    expect(parseCliArgs([
      "init",
      "--name", "Research Partner",
      "--fallback", "codex:gpt-5.6-sol",
      "--fallback-effort", "provider-default",
      "--fallback", "claude:claude-sonnet-5",
      "--fallback-effort", "max",
      "--route-safety", "per-route-native",
      "--codex-auth", "device",
    ])).toMatchObject({
      command: "init",
      name: "Research Partner",
      fallbacks: [
        { model: "codex:gpt-5.6-sol" },
        { model: "claude:claude-sonnet-5", effort: "max" },
      ],
      routeSafety: "per-route-native",
      codexAuthMode: "device",
    });
  });

  it("validates --name with the same Unicode and control-character contract as config", () => {
    const emojiName = "🧭".repeat(80);
    expect(parseCliArgs(["init", "--name", emojiName])).toMatchObject({ name: emojiName });
    expect(() => parseCliArgs(["init", "--name", "🧭".repeat(81)])).toThrow(/1-80/u);
    expect(() => parseCliArgs(["init", "--name", "agent\u0000name"])).toThrow(/one line/u);
  });

  it("rejects ambiguous canonical fallback flags", () => {
    expect(() => parseCliArgs(["init", "--fallback-effort", "high"])).toThrow(/immediately follow/u);
    expect(() => parseCliArgs(["init", "--fallback", "codex:gpt-5.6-sol", "--fallback", "codex:gpt-5.6-sol"]))
      .toThrow(/Duplicate/u);
    expect(() => parseCliArgs([
      "init", "--model", "codex:gpt-5.6-sol", "--fallback", "codex:gpt-5.6-sol",
    ])).toThrow(/cannot also be a fallback/u);
  });

  it("parses sandbox lifecycle commands", () => {
    expect(parseCliArgs(["sandbox", "status"])).toMatchObject({
      command: "sandbox",
      positionals: ["status"],
    });
  });

  it("parses explicit headless Codex authentication", () => {
    expect(parseCliArgs(["auth", "login", "codex", "--codex-auth", "device"])).toMatchObject({
      command: "auth",
      positionals: ["login", "codex"],
      codexAuthMode: "device",
    });
    expect(() => parseCliArgs(["auth", "login", "codex", "--codex-auth", "automatic"]))
      .toThrow(/browser or device/u);
  });

  it("normalizes setup to init and parses its preset/channel/dry-run flags", () => {
    expect(parseCliArgs(["setup", "--preset", "starter", "--with", "slack,cron", "--dry-run"])).toMatchObject({
      command: "init",
      preset: "starter",
      withChannels: ["slack", "cron"],
      dryRun: true,
    });
  });

  it("treats doctor as an alias of validate", () => {
    expect(parseCliArgs(["doctor"])).toMatchObject({ command: "validate" });
    expect(parseCliArgs(["doctor", "--consumer", "../agent-folder"])).toMatchObject({
      command: "validate",
      consumerPath: "../agent-folder",
    });
  });

  it("parses continuation operator commands without interpreting their positional contract", () => {
    expect(parseCliArgs(["continuations", "resolve", "continuation-1", "not-delivered", "--json"]))
      .toMatchObject({
        command: "continuations",
        positionals: ["resolve", "continuation-1", "not-delivered"],
        json: true,
      });
    expect(parseCliArgs(["continuations", "list", "--limit", "50", "--cursor", "opaque-page-two"]))
      .toMatchObject({
        command: "continuations",
        positionals: ["list"],
        limit: 50,
        cursor: "opaque-page-two",
      });
    expect(() => parseCliArgs(["continuations", "health", "--cursor", "invalid-here"]))
      .toThrow(/only supported for `mono-agent continuations list`/u);
  });

  it("parses start with config and env file", () => {
    expect(
      parseCliArgs(["start", "--config", "agent.json", "--env-file", ".env.local"]),
    ).toEqual({
      command: "start",
      configPath: "agent.json",
      envFile: ".env.local",
      positionals: [],
      force: false,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
      includeMemory: false,
    });
  });

  it("parses start --foreground and rejects the -f overload with a hint", () => {
    expect(parseCliArgs(["start", "--foreground"])).toMatchObject({ command: "start", foreground: true });
    expect(parseCliArgs(["start"])).toMatchObject({ command: "start", foreground: false });
    expect(() => parseCliArgs(["start", "-f"]))
      .toThrow(/`-f` means `--follow` on `logs`; use `--foreground` with `start`/u);
  });

  it("parses restart --clear-sessions and rejects the removed --force alias", () => {
    expect(parseCliArgs(["restart", "--clear-sessions"])).toMatchObject({ command: "restart", clearSessions: true });
    expect(() => parseCliArgs(["restart", "--force"]))
      .toThrow(/`restart --force` was removed; use `mono-agent restart --clear-sessions`/u);
    expect(parseCliArgs(["restart"]).clearSessions).toBeUndefined();
    expect(() => parseCliArgs(["stop", "--clear-sessions"]))
      .toThrow(/--clear-sessions is only supported for `mono-agent restart`/u);
  });

  it("parses the internal managed-worker snapshot transport without advertising it as public help", () => {
    expect(parseCliArgs([
      "start",
      "--foreground",
      "--expected-background-snapshot",
      "encoded-snapshot",
      "--expected-managed-runtime-launch",
      "encoded-runtime-proof",
    ])).toMatchObject({
      command: "start",
      foreground: true,
      expectedBackgroundSnapshot: "encoded-snapshot",
      expectedManagedRuntimeLaunch: "encoded-runtime-proof",
    });
    expect(renderHelp()).not.toContain("--expected-background-snapshot");
    expect(renderHelp()).not.toContain("--expected-managed-runtime-launch");
  });

  it("keeps the scheduled log-maintenance command narrow and out of public help and errors", async () => {
    expect(parseCliArgs([
      INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND,
      "--config",
      "/work/demo/mono-agent.config.json",
      "--controller-cli",
      "/checkout/packages/agent-app/dist/cli.js",
      "--agent-cwd",
      "/work/demo",
      "--agent-path",
      "/custom/bin:/usr/bin:/bin",
      "--env-file",
      "/work/demo/.env.production",
    ])).toMatchObject({
      command: INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND,
      configPath: "/work/demo/mono-agent.config.json",
      controllerCliPath: "/checkout/packages/agent-app/dist/cli.js",
      agentCwd: "/work/demo",
      agentPath: "/custom/bin:/usr/bin:/bin",
      envFile: "/work/demo/.env.production",
      positionals: [],
    });
    expect(() => parseCliArgs([INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND, "--config", "/work/demo/config.json"]))
      .toThrow(/requires its exact config/u);
    expect(renderHelp()).not.toContain(INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND);
    try {
      parseCliArgs(["not-a-command"]);
      throw new Error("expected parseCliArgs to reject the unknown command");
    } catch (error) {
      expect(String(error)).not.toContain(INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND);
    }

    const previous = process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV];
    delete process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV];
    try {
      const unauthorized = await captureCli(() => runCli([
        INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND,
        "--config",
        "/work/demo/mono-agent.config.json",
        "--controller-cli",
        "/checkout/packages/agent-app/dist/cli.js",
        "--agent-cwd",
        "/work/demo",
        "--agent-path",
        "/custom/bin:/usr/bin:/bin",
      ]));
      expect(unauthorized.code).toBe(2);
      expect(unauthorized.stderr).toContain("reserved for its managed LaunchAgent");
    } finally {
      if (previous !== undefined) process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] = previous;
    }
  });

  it("does not let the maintenance marker authorize a different command", async () => {
    const previous = process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV];
    process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] = "1";
    try {
      const result = await captureCli(() => runCli(["version"]));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("cannot authorize another CLI command");
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) delete process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV];
      else process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] = previous;
    }
  });

  it("rejects the internal snapshot outside launchd and makes a missing managed snapshot non-restarting", async () => {
    const ordinary = await captureCli(() => runCli([
      "start",
      "--foreground",
      "--expected-background-snapshot",
      "encoded-snapshot",
    ]));
    expect(ordinary.code).toBe(2);
    expect(ordinary.stderr).toContain("reserved for the managed LaunchAgent worker");

    const ordinaryRuntimeProof = await captureCli(() => runCli([
      "start",
      "--foreground",
      "--expected-managed-runtime-launch",
      "encoded-runtime-proof",
    ]));
    expect(ordinaryRuntimeProof.code).toBe(2);
    expect(ordinaryRuntimeProof.stderr).toContain("--expected-managed-runtime-launch is reserved");

    const previous = process.env[MANAGED_BACKGROUND_WORKER_ENV];
    process.env[MANAGED_BACKGROUND_WORKER_ENV] = "1";
    try {
      const managed = await captureCli(() => runCli(["start", "--foreground"]));
      expect(managed.code).toBe(0);
      expect(managed.stderr).toContain("missing its approved background snapshot");

      process.env[MANAGED_BACKGROUND_WORKER_ENV] = "1";
      const missingRuntimeProof = await captureCli(() => runCli([
        "start",
        "--foreground",
        "--expected-background-snapshot",
        "encoded-snapshot",
      ]));
      expect(missingRuntimeProof.code).toBe(0);
      expect(missingRuntimeProof.stderr).toContain("missing its finalized runtime proof");
      expect(mocks.waitForManagedRuntimePublication).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env[MANAGED_BACKGROUND_WORKER_ENV];
      else process.env[MANAGED_BACKGROUND_WORKER_ENV] = previous;
    }
  });

  it("parses the background control commands with --config", () => {
    for (const command of ["restart", "stop", "status"] as const) {
      expect(parseCliArgs([command, "--config", "agent.json"])).toMatchObject({ command, configPath: "agent.json" });
    }
  });

  it("parses logs follow and lines, with -f meaning follow", () => {
    expect(parseCliArgs(["logs", "--follow"])).toMatchObject({ command: "logs", follow: true });
    expect(parseCliArgs(["logs", "-f"])).toMatchObject({ command: "logs", follow: true });
    expect(parseCliArgs(["logs", "--lines", "200"])).toMatchObject({ command: "logs", lines: 200, follow: false });
    expect(parseCliArgs(["logs"])).toMatchObject({ command: "logs", follow: false });
    expect(parseCliArgs(["logs"]).lines).toBeUndefined();
    expect(() => parseCliArgs(["logs", "--lines", "x"])).toThrow(/--lines/u);
    expect(() => parseCliArgs(["logs", "--lines", "0"])).toThrow(/--lines/u);
  });

  it("parses install-skill with target and force", () => {
    expect(parseCliArgs(["install-skill", "--target", "codex", "--force"])).toEqual({
      command: "install-skill",
      target: "codex",
      positionals: [],
      force: true,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
      includeMemory: false,
    });
    expect(parseCliArgs(["install-skill"])).toMatchObject({ command: "install-skill", force: false });
    expect(parseCliArgs(["install-skill", "--no-docs-mcp"])).toMatchObject({
      command: "install-skill",
      noDocsMcp: true,
    });
    expect(() => parseCliArgs(["install-skill", "--target", "browser"])).toThrow(/--target/u);
    expect(() => parseCliArgs(["validate", "--no-docs-mcp"])).toThrow(/only supported.*install-skill/iu);
  });

  it("parses managed project skill checks and updates", () => {
    expect(parseCliArgs(["install-skill", "--project", "--check"])).toMatchObject({
      command: "install-skill",
      project: true,
      check: true,
    });
    expect(parseCliArgs(["install-skill", "--project", "--update"])).toMatchObject({
      project: true,
      update: true,
    });
    expect(() => parseCliArgs(["install-skill", "--update"])).toThrow(/require.*--project/u);
    expect(() => parseCliArgs(["install-skill", "--project", "--check", "--update"])).toThrow(/either/u);
  });

  it("accepts --json on the read/status surfaces", () => {
    for (const argv of [
      ["validate", "--json"],
      ["config", "--json"],
      ["presets", "list", "--json"],
      ["presets", "show", "starter", "--json"],
      ["status", "--json"],
      ["sandbox", "status", "--json"],
      ["install-skill", "--project", "--check", "--json"],
      ["runs", "report", "--json"],
      ["runs", "audit", "--json"],
      ["memory", "stats", "--json"],
      ["continuations", "list", "--json"],
    ] as const) {
      expect(parseCliArgs([...argv])).toMatchObject({ json: true });
    }
  });

  it("rejects --json on lifecycle/interactive commands with a usage error naming the JSON surfaces", () => {
    for (const command of ["init", "auth", "start", "stop", "restart", "logs", "tui", "web", "backfill"] as const) {
      expect(() => parseCliArgs([command, "--json"])).toThrow(/--json is not supported/u);
    }
    // The error names the supported surfaces so a caller knows where JSON lives.
    expect(() => parseCliArgs(["start", "--json"])).toThrow(/config, presets, status/u);
  });

  it("gates install-skill/sandbox --json to their read-only subcommands", () => {
    expect(() => parseCliArgs(["install-skill", "--json"])).toThrow(/install-skill --project --check/u);
    expect(() => parseCliArgs(["install-skill", "--project", "--json"])).toThrow(/install-skill --project --check/u);
    expect(() => parseCliArgs(["sandbox", "setup", "--json"])).toThrow(/sandbox status/u);
    expect(() => parseCliArgs(["sandbox", "check", "--json"])).toThrow(/sandbox status/u);
  });

  it("parses backfill flags (--run/--all/--since/--until/--include-memory/--dry-run)", () => {
    expect(parseCliArgs(["backfill", "--all", "--dry-run"])).toMatchObject({
      command: "backfill",
      all: true,
      dryRun: true,
      includeMemory: false,
    });
    expect(
      parseCliArgs(["backfill", "--run", "run-x", "--since", "2026-06-01", "--until", "2026-06-30", "--include-memory"]),
    ).toMatchObject({
      command: "backfill",
      run: "run-x",
      since: "2026-06-01",
      until: "2026-06-30",
      all: false,
      dryRun: false,
      includeMemory: true,
    });
  });

  it("parses the canonical `runs` command with report/audit modes and the merged flag surface", () => {
    expect(parseCliArgs(["runs"])).toMatchObject({ command: "runs", positionals: [] });
    expect(parseCliArgs(["runs", "report", "--by", "channel", "--since", "2026-06-01T00:00:00.000Z", "--json"]))
      .toMatchObject({
        command: "runs",
        positionals: ["report"],
        groupBy: "channel",
        since: "2026-06-01T00:00:00.000Z",
        json: true,
      });
    expect(parseCliArgs(["runs", "audit", "--artifacts", "./runs", "--consumer", "../agent", "--stale-after-ms", "500", "--include-memory"]))
      .toMatchObject({
        command: "runs",
        positionals: ["audit"],
        artifactDir: "./runs",
        consumerPath: "../agent",
        staleAfterMs: 500,
        includeMemory: true,
      });
    expect(parseCliArgs(["runs", "report", "--by", "failureKind"]))
      .toMatchObject({ command: "runs", positionals: ["report"], groupBy: "failureKind" });
    expect(() => parseCliArgs(["runs", "report", "--by", "status"])).toThrow(/--by/u);
    expect(() => parseCliArgs(["runs", "audit", "--artifact-dir", "./runs"]))
      .toThrow(/`--artifact-dir` was removed; use `--artifacts/u);
    // A mode positional the parser does not interpret is still forwarded to the dispatcher unchanged.
    expect(parseCliArgs(["runs", "bogus"])).toMatchObject({ command: "runs", positionals: ["bogus"] });
    // --consumer / --include-memory now accept `runs`; they still reject unrelated commands.
    expect(() => parseCliArgs(["start", "--consumer", "../agent"])).toThrow(/--consumer/u);
    expect(() => parseCliArgs(["start", "--include-memory"])).toThrow(/--include-memory/u);
  });

  it("parses validate --consumer and keeps it validate/runs scoped", () => {
    expect(parseCliArgs(["validate", "--consumer", "../local-agent-alpha"])).toMatchObject({
      command: "validate",
      consumerPath: "../local-agent-alpha",
    });
    expect(() => parseCliArgs(["validate", "--consumer"])).toThrow(/--consumer requires a value/u);
    expect(() => parseCliArgs(["start", "--consumer", "../local-agent-alpha"])).toThrow(/--consumer/u);
  });

  it("accepts --strict only for memory audit", () => {
    expect(parseCliArgs(["memory", "audit", "--strict", "--json"])).toMatchObject({
      command: "memory",
      positionals: ["audit"],
      strict: true,
      json: true,
    });
    expect(() => parseCliArgs(["memory", "stats", "--strict"])).toThrow(/only supported.*memory audit/iu);
    expect(() => parseCliArgs(["validate", "--strict"])).toThrow(/only supported.*memory audit/iu);
  });

  it("defaults to help and rejects unknown commands and flags", () => {
    expect(parseCliArgs([]).command).toBe("help");
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(() => parseCliArgs(["serve"])).toThrow(/Unknown command/u);
    expect(() => parseCliArgs(["start", "--what"])).toThrow(/Unknown flag/u);
    // `--port` is a recognized web/sessions flag; it is rejected elsewhere.
    expect(() => parseCliArgs(["start", "--port", "4100"])).toThrow(/only supported for/u);
    expect(() => parseCliArgs(["start", "--include-memory"])).toThrow(/--include-memory/u);
    expect(() => parseCliArgs(["validate", "--auth"])).toThrow(/--auth/u);
    expect(() => parseCliArgs(["init", "--memory", "vector"])).toThrow(/--memory/u);
    expect(() => parseCliArgs(["init", "--effort", "turbo"])).toThrow(/--effort/u);
    expect(() => parseCliArgs(["status", "--model", "codex:gpt-5.5"])).toThrow(/--model.*mono-agent init/u);
    expect(() => parseCliArgs(["presets", "list", "--config", "agent.json"])).toThrow(/--config/u);
    expect(() => parseCliArgs(["init", "--follow"])).toThrow(/--follow/u);
    expect(() => parseCliArgs(["web", "status", "--port", "5050"])).toThrow(/web start/u);
  });

  it("parses --version, -v, and the bare `version` command", () => {
    expect(parseCliArgs(["--version"]).command).toBe("version");
    expect(parseCliArgs(["-v"]).command).toBe("version");
    expect(parseCliArgs(["version"]).command).toBe("version");
  });

  it("rejects the removed `sessions` command with a tui/web pointer", () => {
    expect(() => parseCliArgs(["sessions"])).toThrow(/`sessions` was removed/u);
    expect(() => parseCliArgs(["sessions"])).toThrow(/mono-agent tui/u);
    expect(() => parseCliArgs(["sessions"])).toThrow(/mono-agent web/u);
    // Its former Session Recorder flags no longer exist on any command.
    expect(() => parseCliArgs(["web", "--no-open"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["web", "--allow-non-loopback"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["web", "--show-auth-url"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["web", "--max-runs", "500"])).toThrow(/Unknown flag/u);
  });

  it("parses the web service namespace and LAN/loopback bind flags", () => {
    expect(parseCliArgs(["web"])).toMatchObject({ command: "web", positionals: [] });
    expect(parseCliArgs(["web", "start", "--port", "5050"])).toMatchObject({
      command: "web",
      positionals: ["start"],
      port: 5050,
    });
    expect(parseCliArgs(["web", "run", "--loopback"])).toMatchObject({
      command: "web",
      positionals: ["run"],
      loopback: true,
    });
    expect(parseCliArgs(["web", "logs", "-f", "--lines", "25"])).toMatchObject({
      command: "web",
      positionals: ["logs"],
      follow: true,
      lines: 25,
    });
    expect(parseCliArgs(["web", "reset", "--all", "--yes"])).toMatchObject({
      command: "web",
      positionals: ["reset"],
      all: true,
      yes: true,
    });
    expect(() => parseCliArgs(["start", "--loopback"])).toThrow(/loopback/u);
    expect(() => parseCliArgs(["web", "run", "--env-file", ".env"])).toThrow(/does not load/u);
    expect(() => parseCliArgs(["web", "--config", "agent.json"])).toThrow(/does not load/u);
  });

  it("never loads an invoking folder dotenv for the machine-wide web console", () => {
    expect(shouldLoadCommandDotenv("web")).toBe(false);
    expect(shouldLoadCommandDotenv("start")).toBe(true);
  });

  it("renders a grouped, scannable summary with every public command once", () => {
    const help = renderHelp();
    const lines = help.split("\n");

    // Group headings appear in order; the Run group carries the launchd note.
    const groupOrder = ["Setup", "Check", "Run", "Console", "Observe", "Maintain"];
    const headingIndexes = groupOrder.map((group) =>
      lines.findIndex((line) => line.startsWith(group)),
    );
    expect(headingIndexes.every((index) => index >= 0)).toBe(true);
    expect([...headingIndexes]).toEqual([...headingIndexes].sort((a, b) => a - b));
    const runHeading = lines.find((line) => line.startsWith("Run")) ?? "";
    expect(runHeading).toContain("(background lifecycle is macOS/launchd; elsewhere use start --foreground)");

    // Short, one-line-per-command signatures — not the full flag detail.
    expect(help).toContain("runs [report|audit]");
    expect(help).toContain("web [start|stop|status|...]");
    expect(help).toContain("presets list|show <id>");
    expect(help).not.toContain("mono-agent init [--preset");
    expect(help).not.toContain("Effort levels:");
    expect(help).not.toContain("--fallback-effort");
    expect(help).not.toContain("--artifact-dir");
    expect(help).not.toContain("web reset --all --yes");

    // Exactly the nine PR3 JSON surfaces carry a [--json] marker.
    expect(help.split("[--json]").length - 1).toBe(9);
    const lineFor = (short: string): string => lines.find((line) => line.includes(short)) ?? "";
    expect(lineFor("runs [report|audit]")).toContain("[--json]");
    expect(lineFor("memory <subcommand>")).toContain("[--json]");
    expect(lineFor("web [start|stop|status|...]")).not.toContain("[--json]");
    expect(lineFor("backfill")).not.toContain("[--json]");

    // The removed `sessions` command never appears in the summary.
    expect(help).not.toContain("sessions");

    // Footer pointers to the detail and notes views.
    expect(help).toContain("Run `mono-agent help <command>` for full flags and behavior notes.");
    expect(help).toContain("Run `mono-agent help notes` for model references, fallback chains, and env-file rules.");
  });

  it("resolves `help <topic>` to detail views, aliases, notes, removed pointers, and errors", () => {
    // Command detail preserves the full signature and behavior lines.
    const initDetail = helpTopicText("init");
    expect(initDetail).toContain("mono-agent init [--preset");
    expect(initDetail).toContain("Effort levels: none, minimal, low, medium, high, xhigh, max, ultra");
    expect(initDetail).toContain("--fallback-effort <provider-default|level>");
    expect(initDetail).not.toContain("--fallback-models");

    const validateDetail = helpTopicText("validate");
    expect(validateDetail).toContain("mono-agent validate [--preset <id>]");
    expect(validateDetail).toContain("`mono-agent doctor` is an alias for this command.");

    const tuiDetail = helpTopicText("tui");
    expect(tuiDetail).toContain("live chat with structured");
    expect(tuiDetail).not.toContain("live chat with full");

    const webDetail = helpTopicText("web");
    expect(webDetail).toContain("web reset --all --yes");
    expect(webDetail).toContain("0.0.0.0:5050");

    // `start -f` was removed in PR1 (it errors); its help must never teach the
    // `-f` shorthand. The word-boundary match excludes `--foreground` (whose "f"
    // is followed by "o", so there is no boundary after "-f").
    const startDetail = helpTopicText("start");
    expect(startDetail).toContain("--foreground");
    expect(startDetail).not.toMatch(/-f\b/u);

    // `presets` help documents the PR3 --json surface its summary marks.
    expect(helpTopicText("presets")).toContain("--json");

    // Aliases resolve to the canonical entry, noting the alias.
    const doctorDetail = helpTopicText("doctor");
    expect(doctorDetail).toContain("`doctor` is an alias of `validate`.");
    expect(doctorDetail).toContain("mono-agent validate [--preset <id>]");
    const setupDetail = helpTopicText("setup");
    expect(setupDetail).toContain("`setup` is an alias of `init`.");
    expect(setupDetail).toContain("mono-agent init [--preset");

    // The notes block carries the model-reference guidance.
    const notes = helpTopicText("notes");
    expect(notes).toContain("Guided Pi authentication");
    expect(notes).toContain("Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go");
    expect(notes).toContain("direct opencode:<provider>:<model>");
    expect(notes).toContain("hand-authored runtime backend config");

    // Removed commands print their replacement pointer as an informational topic.
    const recipes = renderHelpTopic("recipes");
    expect(recipes.ok).toBe(true);
    if (recipes.ok) expect(recipes.text).toContain("`recipes` was removed; use `mono-agent presets`.");
    const sessions = renderHelpTopic("sessions");
    expect(sessions.ok).toBe(true);
    if (sessions.ok) {
      expect(sessions.text).toContain("mono-agent tui");
      expect(sessions.text).toContain("mono-agent web");
    }

    // An unknown topic is a usage error listing valid topics.
    const bogus = renderHelpTopic("bogus");
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) {
      expect(bogus.message).toContain("Unknown help topic `bogus`");
      expect(bogus.message).toContain("init");
      expect(bogus.message).toContain("notes");
    }
  });

  it("accepts --memory bujo and --memory lite, rejects --memory markdown", () => {
    const bujoResult = parseCliArgs(["init", "--memory", "bujo"]);
    expect(bujoResult.command).toBe("init");
    expect(bujoResult.memory).toBe("bujo");

    const liteResult = parseCliArgs(["init", "--memory", "lite"]);
    expect(liteResult.command).toBe("init");
    expect(liteResult.memory).toBe("lite");

    expect(() => parseCliArgs(["init", "--memory", "markdown"])).toThrow(/--memory must be lite, journal, or bujo/u);
  });
});

describe("runCli validate --json", () => {
  it("rejects a known-but-unsupported flag before loading dotenv", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env.invalid-command");
    await writeFile(envPath, "MONO_AGENT_CLI_SCOPE_SENTINEL=must-not-load\n", "utf8");
    delete process.env.MONO_AGENT_CLI_SCOPE_SENTINEL;

    try {
      const result = await captureCli(() => runCli([
        "status",
        "--model", "codex:gpt-5.5",
        "--env-file", envPath,
      ]));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--model is only supported for `mono-agent init`");
      expect(process.env.MONO_AGENT_CLI_SCOPE_SENTINEL).toBeUndefined();
    } finally {
      delete process.env.MONO_AGENT_CLI_SCOPE_SENTINEL;
    }
  });

  it("emits exactly one plain JSON object and exits according to its ok field", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
    }), "utf8");

    const result = await captureCli(() => withCwd(dir, () => runCli(["validate", "--json"])));

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/\u001b\[/u);
    const parsed = JSON.parse(result.stdout) as { readonly ok: boolean; readonly sections: readonly unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(result.code).toBe(parsed.ok ? 0 : 1);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("loadCliEnvFile", () => {
  it("loads vars from the file without overwriting exported ones, and ignores missing files", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      "MONO_AGENT_TEST_ENV_FILE_FRESH=from-file\nMONO_AGENT_TEST_ENV_FILE_PRESET=from-file\n",
      "utf8",
    );
    process.env.MONO_AGENT_TEST_ENV_FILE_PRESET = "from-shell";
    delete process.env.MONO_AGENT_TEST_ENV_FILE_FRESH;
    try {
      expect(loadCliEnvFile(envPath)).toBe(true);
      expect(process.env.MONO_AGENT_TEST_ENV_FILE_FRESH).toBe("from-file");
      expect(process.env.MONO_AGENT_TEST_ENV_FILE_PRESET).toBe("from-shell");
      expect(loadCliEnvFile(join(dir, "missing.env"))).toBe(false);
    } finally {
      delete process.env.MONO_AGENT_TEST_ENV_FILE_FRESH;
      delete process.env.MONO_AGENT_TEST_ENV_FILE_PRESET;
    }
  });
});

describe("monoAgentVersion", () => {
  it("reports this package's semver version", () => {
    expect(monoAgentVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});

describe("removed CLI surfaces", () => {
  it("exits with the usage-error code and a replacement hint for the removed recipes command", async () => {
    const recipes = await captureCli(() => runCli(["recipes", "list"]));
    expect(recipes.code).toBe(2);
    expect(recipes.stderr).toContain("`recipes` was removed; use `mono-agent presets`.");
    // The unknown-command enumeration must no longer advertise `recipes`.
    const unknown = await captureCli(() => runCli(["definitely-not-a-command"]));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).not.toContain("recipes");
  });

  it("exits with the usage-error code and a tui/web pointer for the removed sessions command", async () => {
    const sessions = await captureCli(() => runCli(["sessions"]));
    expect(sessions.code).toBe(2);
    expect(sessions.stderr).toContain("`sessions` was removed");
    expect(sessions.stderr).toContain("mono-agent tui");
    expect(sessions.stderr).toContain("mono-agent web");
    // The unknown-command enumeration must no longer advertise `sessions`.
    const unknown = await captureCli(() => runCli(["definitely-not-a-command"]));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).not.toContain("sessions");
  });

  it("routes help topics through runCli with the right output stream and exit code", async () => {
    const summary = await captureCli(() => runCli(["help"]));
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain("Run `mono-agent help <command>` for full flags and behavior notes.");

    const detail = await captureCli(() => runCli(["help", "init"]));
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain("mono-agent init [--preset");

    const bogus = await captureCli(() => runCli(["help", "bogus"]));
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("Unknown help topic `bogus`");
  });

  it("exits with the usage-error code for the removed --recipe and --fallback-models flags", async () => {
    const dir = await tempDir();
    const recipeFlag = await captureCli(() => withCwd(
      dir,
      () => runCli(["init", "--recipe", "minimal-webhook", "--dry-run"]),
    ));
    const fallbackModelsFlag = await captureCli(() => withCwd(
      dir,
      () => runCli(["init", "--fallback-models", "codex:gpt-5.6-sol", "--dry-run"]),
    ));

    expect(recipeFlag.code).toBe(2);
    expect(fallbackModelsFlag.code).toBe(2);
    expect(recipeFlag.stderr).toContain("`--recipe` was removed; use `--preset");
    expect(fallbackModelsFlag.stderr).toContain("`--fallback-models` was removed; repeat `--fallback");
  });

  it("exits with replacement hints for removed run aliases and restart --force", async () => {
    const dir = await tempDir();
    const metrics = await captureCli(() => runCli(["metrics", "--json"]));
    const auditRuns = await captureCli(() => runCli(["audit-runs", "--json"]));
    const forceRestart = await captureCli(() => withCwd(dir, () => runCli(["restart", "--force"])));
    expect(metrics.code).toBe(2);
    expect(auditRuns.code).toBe(2);
    expect(forceRestart.code).toBe(2);
    expect(metrics.stderr).toContain("`metrics` was removed; use `mono-agent runs`");
    expect(auditRuns.stderr).toContain("`audit-runs` was removed; use `mono-agent runs audit`");
    expect(forceRestart.stderr).toContain("`restart --force` was removed; use `mono-agent restart --clear-sessions`");

    const metricsHelp = await captureCli(() => runCli(["help", "metrics"]));
    const auditRunsHelp = await captureCli(() => runCli(["help", "audit-runs"]));
    expect(metricsHelp.code).toBe(0);
    expect(auditRunsHelp.code).toBe(0);
    expect(metricsHelp.stdout).toContain("`metrics` was removed");
    expect(auditRunsHelp.stdout).toContain("`audit-runs` was removed");
  });

  it("does not warn for canonical preset and fallback flags", async () => {
    const dir = await tempDir();
    const presets = await captureCli(() => runCli(["presets", "list"]));
    const fallbacks = await captureCli(() => withCwd(
      dir,
      () => runCli(["init", "--fallback", "codex:gpt-5.6-sol", "--dry-run"]),
    ));

    expect(presets.code).toBe(0);
    expect(fallbacks.code).toBe(0);
    expect(presets.stderr).not.toContain("deprecated");
    expect(fallbacks.stderr).not.toContain("deprecated");
  });
});

describe("runs command", () => {
  it("does not emit a deprecation hint for the canonical `runs` spelling", async () => {
    const dir = await tempDir();
    const report = await captureCli(() => runCli(["runs", "--artifacts", dir, "--json"]));
    const audit = await captureCli(() => runCli(["runs", "audit", "--artifacts", dir, "--json"]));
    expect(report.code).toBe(0);
    expect(audit.code).toBe(0);
    expect(report.stderr).not.toContain("deprecated");
    expect(report.stderr).not.toContain("will be removed");
    expect(audit.stderr).not.toContain("deprecated");
    expect(audit.stderr).not.toContain("will be removed");
  });

  it("rejects an unknown `runs` mode through the CLI with the usage-error code", async () => {
    const bogus = await captureCli(() => runCli(["runs", "bogus"]));
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("Unknown `runs` mode `bogus`");
  });
});

describe("describeChannelStatus", () => {
  it("expands an object summary value instead of printing [object Object]", () => {
    const rendered = describeChannelStatus({
      kind: "running",
      summary: {
        invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
        port: 9999,
        invokeUrls: { default: "http://127.0.0.1:9999/webhook/invoke" },
      },
    });
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toContain("invokeUrls={default: http://127.0.0.1:9999/webhook/invoke}");
    expect(rendered).toContain("port=9999");
  });

  it("renders a non-running channel as kind: reason", () => {
    expect(describeChannelStatus({ kind: "disabled", reason: "not enabled" })).toBe("disabled: not enabled");
  });
});

async function captureCli(run: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    return { code: await run(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    return await run();
  } finally {
    process.chdir(previous);
  }
}

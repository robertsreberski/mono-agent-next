import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCreateMonoAgentCli } from "../cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runCreateMonoAgentCli", () => {
  it("ships distinct create and mono-agent bins so invocation intent survives npm shims", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.bin).toEqual({
      "create-mono-agent": "./dist/bin/create-mono-agent.js",
      "mono-agent": "./dist/bin/mono-agent.js",
    });
    expect(manifest.files).toContain("skills");
    expect(manifest.license).toBe("GPL-3.0-only");
    expect(await readFile(new URL("../../LICENSE", import.meta.url), "utf8"))
      .toContain("GNU GENERAL PUBLIC LICENSE");
  });

  it("uses create-mono-agent as a no-wizard scaffolder", async () => {
    const root = await makeTemporaryDirectory();
    const stdout: string[] = [];

    await expect(runCreateMonoAgentCli(["my-agent"], {
      cwd: root,
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    }, { invocationName: "create-mono-agent" })).resolves.toBe(0);

    expect(JSON.parse(stdout.join(""))).toMatchObject({
      event: "scaffolded",
      template: "minimal",
      installed: false,
    });
    expect(JSON.parse(await readFile(join(root, "my-agent", "package.json"), "utf8")).name).toBe("my-agent");
  });

  it("keeps source-preview help off predecessor registry entry points", async () => {
    const stdout: string[] = [];

    await expect(runCreateMonoAgentCli(["--help"], {
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    }, { invocationName: "create-mono-agent" })).resolves.toBe(0);

    const usage = stdout.join("");
    expect(usage).toContain("create-mono-agent [directory]");
    expect(usage).toContain("built mono-agent-next checkout");
    expect(usage).toContain("predecessor repository");
    expect(usage).toContain("Do not use --install");
    expect(usage).not.toContain("npm create");
    expect(usage).not.toContain("@latest");
  });

  it.each(["init", "setup"])(
    "treats %s as a create target instead of a mono-agent subcommand",
    async (targetName) => {
      const root = await makeTemporaryDirectory();
      await expect(runCreateMonoAgentCli([targetName], {
        cwd: root,
        stdout: () => undefined,
        stderr: () => undefined,
      }, { invocationName: "create-mono-agent" })).resolves.toBe(0);
      expect(JSON.parse(
        await readFile(join(root, targetName, "package.json"), "utf8"),
      ).name).toBe(targetName);
    },
  );

  it("selects personal and multi-runtime templates explicitly", async () => {
    const root = await makeTemporaryDirectory();
    for (const template of ["personal", "multi-runtime"] as const) {
      const stdout: string[] = [];
      await expect(runCreateMonoAgentCli([
        `${template}-agent`,
        "--template",
        template,
      ], {
        cwd: root,
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      }, { invocationName: "create-mono-agent" })).resolves.toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({ template });
    }

    const personal = JSON.parse(
      await readFile(join(root, "personal-agent", "mono-agent.config.json"), "utf8"),
    );
    expect(personal.memory.$use).toBe("@mono-agent/memory-local");
    const multi = JSON.parse(
      await readFile(join(root, "multi-runtime-agent", "mono-agent.config.json"), "utf8"),
    );
    expect(multi.runtimes["claude-sdk"].$use).toBe("@mono-agent/runtime-claude");
  });

  it("preserves mono-agent init/setup and delegates every other command to @mono-agent/cli", async () => {
    const root = await makeTemporaryDirectory();
    const delegate = vi.fn(async () => 17);

    await expect(runCreateMonoAgentCli(["init", "initialized"], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined,
    }, { invocationName: "mono-agent", delegate })).resolves.toBe(0);
    expect(delegate).not.toHaveBeenCalled();

    await expect(runCreateMonoAgentCli(["validate", "--config", "config.json"], {}, {
      invocationName: "mono-agent",
      delegate,
    })).resolves.toBe(17);
    expect(delegate).toHaveBeenCalledWith(["validate", "--config", "config.json"], {});
  });

  it("intercepts install-skill with explicit target/force and defaults to both", async () => {
    const stdout: string[] = [];
    const delegate = vi.fn(async () => 17);
    const skillInstaller = vi.fn(async (input?: {
      readonly target?: "claude" | "codex" | "both";
      readonly force?: boolean;
    }) => ({
      skillName: "mono-agent-composer" as const,
      target: input?.target ?? "both",
      installations: [],
      retainedRecoveryPaths: [],
    }));

    await expect(runCreateMonoAgentCli([
      "install-skill",
      "--target",
      "codex",
      "--force",
    ], {
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    }, {
      invocationName: "mono-agent",
      delegate,
      skillInstaller,
    })).resolves.toBe(0);
    expect(skillInstaller).toHaveBeenCalledWith({
      target: "codex",
      force: true,
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      event: "skill-installed",
      skillName: "mono-agent-composer",
      target: "codex",
    });
    expect(delegate).not.toHaveBeenCalled();

    skillInstaller.mockClear();
    await expect(runCreateMonoAgentCli(["install-skill"], {
      stdout: () => undefined,
      stderr: () => undefined,
    }, {
      invocationName: "mono-agent",
      skillInstaller,
    })).resolves.toBe(0);
    expect(skillInstaller).toHaveBeenCalledWith({
      target: "both",
      force: false,
    });
  });

  it("rejects invalid or repeated install-skill options without delegation", async () => {
    for (const argv of [
      ["install-skill", "--target", "other"],
      ["install-skill", "--target", "codex", "--target", "claude"],
      ["install-skill", "--force", "--force"],
      ["install-skill", "unexpected"],
    ]) {
      const stderr: string[] = [];
      const delegate = vi.fn(async () => 17);
      await expect(runCreateMonoAgentCli(argv, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      }, {
        invocationName: "mono-agent",
        delegate,
      })).resolves.toBe(2);
      expect(stderr.join("")).toContain("mono-agent install-skill");
      expect(delegate).not.toHaveBeenCalled();
    }
  });

  it("prints nested recovery paths from aggregate installer failures", async () => {
    const stderr: string[] = [];
    const backup = "/Users/example/.codex/skills/.mono-agent-composer.backup-test";
    const skillInstaller = vi.fn(async () => {
      throw new AggregateError(
        [
          new Error("simulated install failure"),
          new Error(`backup=${backup}; destination=/Users/example/.codex/skills/mono-agent-composer`),
        ],
        "automatic recovery refused an unknown identity",
      );
    });

    await expect(runCreateMonoAgentCli(["install-skill", "--target", "codex"], {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    }, {
      invocationName: "mono-agent",
      skillInstaller,
    })).resolves.toBe(1);
    expect(stderr.join("")).toContain("automatic recovery refused");
    expect(stderr.join("")).toContain("simulated install failure");
    expect(stderr.join("")).toContain(backup);
  });

  it("returns usage exit 2 for unsupported package managers, including Yarn", async () => {
    for (const packageManager of ["bun", "yarn"]) {
      const stderr: string[] = [];
      await expect(runCreateMonoAgentCli(["setup", "--package-manager", packageManager], {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      }, { invocationName: "mono-agent" })).resolves.toBe(2);
      expect(stderr.join("")).toContain(`Unsupported package manager: ${packageManager}`);
      expect(stderr.join("")).toContain("--package-manager <pnpm|npm>");
    }
  });

  it("returns usage exit 2 for unknown or repeated templates", async () => {
    for (const argv of [
      ["setup", "--template", "maximal"],
      ["setup", "--template", "minimal", "--template", "personal"],
    ]) {
      const stderr: string[] = [];
      await expect(runCreateMonoAgentCli(argv, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      }, { invocationName: "mono-agent" })).resolves.toBe(2);
      expect(stderr.join("")).toContain("template");
      expect(stderr.join("")).toContain("minimal|personal|multi-runtime");
    }
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "create-mono-agent-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}

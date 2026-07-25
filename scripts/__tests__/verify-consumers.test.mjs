// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runVerifyConsumers } from "../verify-consumers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const templates = ["minimal", "personal", "multi-runtime"];

describe("verify-consumers", () => {
  it("is exposed as the source-consumer gate and packed smoke uses the current CLI", async () => {
    const [packageJsonText, verifier, packedSmoke] = await Promise.all([
      readFile(resolve(repoRoot, "package.json"), "utf8"),
      readFile(resolve(repoRoot, "scripts/verify-consumers.mjs"), "utf8"),
      readFile(resolve(repoRoot, "scripts/release/fixtures/packed-consumer/smoke.mjs"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText);

    expect(packageJson.scripts?.["verify:consumers"]).toBe("node scripts/verify-consumers.mjs");
    expect(verifier).toContain('importPackage("@mono-agent/cli")');
    expect(verifier).toContain('importPackage("@mono-agent/core")');
    expect(verifier).not.toContain('importPackage("@mono-agent/agent-app")');
    expect(verifier).not.toContain('importPackage("@mono-agent/observability")');
    expect(packedSmoke).toContain('{ packageName: "@mono-agent/cli", binName: "mono-agent"');
    expect(packedSmoke).not.toContain("@mono-agent/agent-app");
  });

  it("accepts every package-script form advertised by help and rejects a standalone separator", async () => {
    const { stdout: help } = await execFileAsync("pnpm", ["run", "verify:consumers", "--help"], {
      cwd: repoRoot,
    });
    const commandPrefix = "pnpm run verify:consumers";
    const advertisedForms = help
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(commandPrefix));

    expect(advertisedForms).toEqual([
      commandPrefix,
      `${commandPrefix} --skip-build`,
      `${commandPrefix} --consumer <path>`,
      `${commandPrefix} --consumer <path> --skip-build`,
    ]);

    for (const form of advertisedForms) {
      const argv = form
        .slice(commandPrefix.length)
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((arg) => arg === "<path>" ? "/tmp/downstream-agent" : arg);
      const result = await runVerifyConsumers({
        argv,
        cwd: "/repo",
        dependencies: fakeDependencies(),
        runCommand: async () => 0,
        verifySourceContract: passingSourceContract,
        verifyConsumerContract: passingConsumerContract,
        stdout: sink(),
        stderr: sink(),
      });

      expect(result.exitCode, `${form} should be accepted`).toBe(0);
    }

    const stderr = sink();
    const invalid = await runVerifyConsumers({
      argv: ["--", "--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies(),
      runCommand: async () => 0,
      verifySourceContract: passingSourceContract,
      stdout: sink(),
      stderr,
    });

    expect(invalid.exitCode).toBe(1);
    expect(stderr.text).toContain("Unknown argument: --");
    expect(help).not.toContain("pnpm run verify:consumers -- --");
  });

  it("prints all three v1 source contracts and an aggregate verdict", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies(),
      verifySourceContract: passingSourceContract,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    for (const template of templates) {
      expect(stdout.text).toContain(`PASS ${template} template contract`);
      expect(result.statusByLabel.get(`${template} template contract`)).toBe(true);
    }
    expect(stdout.text).toContain("PASS consumers");
    expect(result.statusByLabel.get("consumers")).toBe(true);
  });

  it("exits non-zero when one generated source contract fails", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies(),
      verifySourceContract: async (template) => template === "personal"
        ? { label: "personal template contract", ok: false, details: ["module graph drift"] }
        : passingSourceContract(template),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL personal template contract: module graph drift");
    expect(result.statusByLabel.get("personal template contract")).toBe(false);
    expect(result.statusByLabel.get("consumers")).toBe(false);
  });

  it("adds read-only downstream config validation when --consumer is supplied", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build", "--consumer", "/tmp/downstream-agent"],
      cwd: "/repo",
      dependencies: fakeDependencies(),
      verifySourceContract: passingSourceContract,
      verifyConsumerContract: async () => ({
        label: "downstream-agent config contract",
        ok: false,
        details: ["routing.primary.model: unsupported model"],
      }),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain(
      "FAIL downstream-agent config contract: routing.primary.model: unsupported model",
    );
    expect(result.statusByLabel.get("downstream-agent config contract")).toBe(false);
  });

  it("builds the complete current workspace unless --skip-build is supplied", async () => {
    const commands = [];
    const failed = await runVerifyConsumers({
      argv: [],
      cwd: "/repo",
      runCommand: async (command, args) => {
        commands.push([command, args]);
        return 1;
      },
      stdout: sink(),
      stderr: sink(),
    });

    expect(commands).toEqual([["pnpm", ["run", "build"]]]);
    expect(failed.exitCode).toBe(1);
    for (const template of templates) {
      expect(failed.statusByLabel.get(`${template} template contract`)).toBe(false);
    }
  });
});

function fakeDependencies() {
  return {
    projectTemplates: templates,
    scaffoldAgent: async () => undefined,
    validateAgentConfig: async () => ({ ok: true, issues: [], loaded: { modules: [] } }),
    runCli: async () => 0,
  };
}

async function passingSourceContract(template) {
  return {
    label: `${template} template contract`,
    ok: true,
    details: ["public APIs validated"],
  };
}

async function passingConsumerContract(consumerPath) {
  return {
    label: `${consumerPath.split("/").at(-1)} config contract`,
    ok: true,
    details: ["config validated"],
  };
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runVerifyConsumers } from "../verify-consumers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

describe("verify-consumers", () => {
  it("is wired exactly once after the CI build-time deep-import gate", async () => {
    const [workflow, packageJsonText] = await Promise.all([
      readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repoRoot, "package.json"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText);
    const verifyStart = workflow.indexOf("  verify:\n");
    const websiteStart = workflow.indexOf("\n  website:\n", verifyStart);

    expect(packageJson.scripts?.["verify:consumers"]).toBe("node scripts/verify-consumers.mjs");
    expect(verifyStart).toBeGreaterThanOrEqual(0);
    expect(websiteStart).toBeGreaterThan(verifyStart);

    const verifyJob = workflow.slice(verifyStart, websiteStart);
    const command = "pnpm run verify:consumers --skip-build";
    const expectedSequence = [
      "      - name: Build packages and demos",
      "        run: pnpm run build",
      "",
      "      - name: Typecheck marked documentation snippets",
      "        run: pnpm run check:doc-snippets",
      "",
      "      - name: Check agent-runtime deep imports",
      "        run: pnpm run check:deep-imports",
      "",
      "      - name: Verify consumer contracts",
      `        run: ${command}`,
    ].join("\n");

    expect(verifyJob).toContain(expectedSequence);
    expect(verifyJob.split(command)).toHaveLength(2);
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
      stdout: sink(),
      stderr,
    });

    expect(invalid.exitCode).toBe(1);
    expect(stderr.text).toContain("Unknown argument: --");
    expect(help).not.toContain("pnpm run verify:consumers -- --");
  });

  it("prints PASS lines and an ok summary when both golden consumers pass", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies(),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("PASS local-agent-alpha contract");
    expect(stdout.text).toContain("PASS local-agent-beta contract");
    expect(stdout.text).toContain("PASS consumers");
    expect(stdout.text).toContain("local-agent-alpha contract ok");
    expect(stdout.text).toContain("local-agent-beta contract ok");
    expect(stdout.text).toContain("consumers ok");
  });

  it("exits non-zero when one consumer contract fails", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build"],
      cwd: "/repo",
      dependencies: fakeDependencies({ failingContract: "local-agent-beta" }),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("PASS local-agent-alpha contract");
    expect(stdout.text).toContain("FAIL local-agent-beta contract: validation: fixture drift");
    expect(stdout.text).toContain("local-agent-beta contract fail");
    expect(stdout.text).toContain("consumers fail");
  });

  it("adds a read-only downstream artifact audit when --consumer is supplied", async () => {
    const stdout = sink();
    const result = await runVerifyConsumers({
      argv: ["--skip-build", "--consumer", "/tmp/downstream-agent"],
      cwd: "/repo",
      dependencies: fakeDependencies({
        auditReport: cleanAuditReport({ parseFailureCount: 1 }),
      }),
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL downstream-agent artifact audit: 1 parse failure(s)");
    expect(stdout.text).toContain("downstream-agent artifact audit fail");
    expect(stdout.text).toContain("consumers fail");
  });
});

function fakeDependencies(options = {}) {
  return {
    consumerContractNames: ["local-agent-alpha", "local-agent-beta"],
    validateConsumerContractFixture: async ({ name }) => ({
      name,
      ok: name !== options.failingContract,
      reportOk: name !== options.failingContract,
      networkCallCount: 0,
      sections: [],
      issues: name === options.failingContract ? [{ check: "validation", message: "fixture drift" }] : [],
    }),
    resolveAppArtifactDir: async () => "/tmp/artifacts",
    resolveAppTraceStaleAfterMs: async () => 30_000,
    auditRecordedRuns: async () => options.auditReport ?? cleanAuditReport(),
  };
}

function cleanAuditReport(overrides = {}) {
  return {
    artifactDir: "/tmp/artifacts",
    totalSummaryFiles: 2,
    parsedSummaryFiles: 2,
    parseFailureCount: 0,
    parseFailures: [],
    statusHistogram: {
      running: 0,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    },
    unrecognizedStatusCount: 0,
    unrecognizedStatuses: [],
    failureKindHistogram: {
      provider_unavailable: 0,
      provider_unavailable_exhausted: 0,
      usage_limit: 0,
      process_death: 0,
      runtime_error: 0,
      cancelled: 0,
    },
    summariesWithFailureKind: 0,
    unrecognizedFailureKindCount: 0,
    unrecognizedFailureKinds: [],
    staleRunningCount: 0,
    staleRunning: [],
    failureKindRates: [],
    rateDenominators: {
      parsedSummaries: 2,
      summariesWithFailureKind: 0,
    },
    warnings: [],
    ...overrides,
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

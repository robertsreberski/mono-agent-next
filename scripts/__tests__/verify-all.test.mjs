// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MINIMUM_NODE_VERSION } from "../node-version.mjs";
import {
  packageCatalog,
  packageRelativePath,
} from "../package-catalog.mjs";
import {
  createRepoGate,
  readReleaseSmokeTag,
  runVerifyAll,
} from "../verify-all.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("verify-all", () => {
  it("runs the successor gate in order without the deleted demo gate", async () => {
    const execution = [];
    const stdout = sink();
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.15.0",
      nodeVersion: MINIMUM_NODE_VERSION,
      stdout,
      stderr: sink(),
      runCommand: async (_command, _args, options) => {
        execution.push(options.label);
        return 0;
      },
      verifyConsumers: async () => {
        execution.push("verify:consumers");
        return greenConsumers();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(execution).toEqual([
      "check:node",
      "check:pnpm-policy",
      "check:secrets",
      "check:oss-hygiene",
      "check:licenses",
      "check:dependency-vulnerabilities",
      "check:codex-discoverability",
      "check:consumer-docs-consistency",
      "check:getting-started-version-pins",
      "check:source-line-length",
      "check:source-beta-budgets",
      "check:source-beta-docs",
      "check:docs",
      "release:test:unit",
      "release:validate",
      "check:architecture",
      "build",
      "check:doc-snippets",
      "check:deep-imports",
      "verify:v1-operator-products",
      "verify:consumers",
      "release:pack",
      "release:consumer",
      "typecheck",
      "scripts:test",
      "test",
      "git diff --check",
    ]);
    expect(execution).not.toContain("test:demo");
    expect(stdout.text).toContain("minimal template contract ok");
    expect(stdout.text).toContain("personal template contract ok");
    expect(stdout.text).toContain("multi-runtime template contract ok");
    expect(stdout.text).toContain("verification green");
  });

  it("keeps release unit tests in the bounded gate without repeating packed consumers", () => {
    const gate = createRepoGate({
      releaseTag: "v0.15.0",
      nodeVersion: MINIMUM_NODE_VERSION,
    });
    const labels = gate.map((entry) => entry.label);

    expect(labels.filter((label) => label === "release:test:unit")).toHaveLength(1);
    expect(labels.filter((label) => label === "release:consumer")).toHaveLength(1);
    expect(labels).not.toContain("release:test");
  });

  it("runs every local gate in CI, or names why it does not", () => {
    // A gate that is not itself executed by a gate is not a gate. The hand-picked
    // `.some()` assertions elsewhere in this file check individual gates; they are
    // why eight gates could sit in `verify:all` and never run on a pull request.
    // This asserts the whole set, so a new gate cannot be added to the local lane
    // without either reaching CI or being given a reason here.
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const releaseWorkflow = readFileSync(
      resolve(repoRoot, ".github/workflows/npm-release.yml"),
      "utf8",
    );
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

    /** Gates CI covers by another name or on another workflow. */
    const coveredElsewhere = new Map([
      ["check:pnpm-policy", () => manifest.scripts.preinstall.includes("pnpm-release-age-policy.mjs")],
      ["check:secrets", () => workflow.includes("ghcr.io/gitleaks/gitleaks")],
      ["check:dependency-vulnerabilities", () => workflow.includes("pnpm run check:v1-dependency-vulnerabilities")],
      ["release:validate", () => releaseWorkflow.includes("pnpm run release:validate")],
      ["release:pack", () => releaseWorkflow.includes("pnpm run release:pack")],
      ["release:consumer", () => releaseWorkflow.includes("pnpm run release:consumer")],
      ["git diff --check", () => workflow.includes("git diff --check")],
    ]);

    const gate = createRepoGate({ releaseTag: "v0.0.0", nodeVersion: MINIMUM_NODE_VERSION });
    const uncovered = gate
      .map((step) => step.label)
      .filter((label) => !workflow.includes(label))
      .filter((label) => {
        const covered = coveredElsewhere.get(label);
        return covered === undefined || !covered();
      });

    expect(uncovered).toEqual([]);
  });

  it("keeps provenance and release contract tests wired into automated verification", () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(manifest.scripts["scripts:test"]).toContain(
      "scripts/__tests__/build-provenance.test.mjs",
    );
    expect(manifest.scripts["release:test:unit"]).toContain(
      "scripts/release/__tests__/release.test.mjs",
    );
    expect(manifest.scripts["release:test:unit"]).toContain(
      "scripts/release/__tests__/package-count-drift.test.mjs",
    );
    expect(manifest.scripts["release:test:unit"]).not.toContain("packed-consumer");
    expect(manifest.scripts["release:test"]).toContain("pnpm run release:test:unit");
    expect(manifest.scripts["release:test"]).toContain("packed-consumer.test.mjs");
    expect(workflow).toContain("pnpm run release:test:unit");
  });

  it("stops before consumers when an earlier repo gate fails", async () => {
    const stderr = sink();
    let consumersCalled = false;
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.15.0",
      stdout: sink(),
      stderr,
      runCommand: async (_command, _args, options) =>
        options.label === "check:architecture" ? 1 : 0,
      verifyConsumers: async () => {
        consumersCalled = true;
        return greenConsumers();
      },
    });

    expect(result.exitCode).toBe(1);
    expect(consumersCalled).toBe(false);
    expect(stderr.text).toContain("Repo gate failed at check:architecture.");
    expect(stderr.text).toContain("Consumer verification skipped");
  });

  it("requires all three successor template contracts", async () => {
    const stdout = sink();
    const stderr = sink();
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.15.0",
      stdout,
      stderr,
      runCommand: async () => 0,
      verifyConsumers: async () => ({
        exitCode: 1,
        statusByLabel: new Map([
          ["minimal template contract", true],
          ["personal template contract", true],
          ["multi-runtime template contract", false],
        ]),
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("Consumer gate failed at verify:consumers");
    expect(stdout.text).toContain("minimal template contract ok");
    expect(stdout.text).toContain("personal template contract ok");
    expect(stdout.text).toContain("multi-runtime template contract fail");
    expect(stdout.text).toContain("verification failed");
  });

  it("keeps minimum-Node proof on the packed consumer only at the minimum", () => {
    const minimum = gateByLabel(
      createRepoGate({ releaseTag: "v0.15.0", nodeVersion: MINIMUM_NODE_VERSION }),
      "release:consumer",
    );
    const newer = gateByLabel(
      createRepoGate({ releaseTag: "v0.15.0", nodeVersion: "24.0.0" }),
      "release:consumer",
    );

    expect(minimum.args).toEqual([
      "run",
      "release:consumer",
      "--",
      "--tag",
      "v0.15.0",
      "--require-minimum",
    ]);
    expect(newer.args).toEqual([
      "run",
      "release:consumer",
      "--",
      "--tag",
      "v0.15.0",
    ]);
  });

  it("derives the smoke tag from the complete common publishable roster", () => {
    const calls = [];
    const manifests = new Map(
      packageCatalog
        .filter((entry) => entry.publishable === true)
        .map((entry) => [
          resolve("/repo", packageRelativePath(entry), "package.json"),
          { name: entry.name, version: "1.2.3-beta.1" },
        ]),
    );

    const tag = readReleaseSmokeTag("/repo", (path, encoding) => {
      calls.push({ path, encoding });
      return JSON.stringify(manifests.get(path));
    });

    expect(tag).toBe("v1.2.3-beta.1");
    expect(calls).toHaveLength(23);
    expect(calls).toContainEqual({
      path: "/repo/packages/module-sdk/package.json",
      encoding: "utf8",
    });
    expect(calls).toContainEqual({
      path: "/repo/extras/docs-mcp/package.json",
      encoding: "utf8",
    });
  });

  it("rejects lockstep version drift", () => {
    const catalog = [
      { dir: "one", name: "@mono-agent/one", publishable: true },
      { dir: "two", name: "@mono-agent/two", publishable: true },
    ];
    expect(() => readReleaseSmokeTag(
      "/repo",
      (path) => JSON.stringify({
        name: path.includes("/one/") ? "@mono-agent/one" : "@mono-agent/two",
        version: path.includes("/one/") ? "1.2.3" : "1.2.4",
      }),
      catalog,
    )).toThrow(
      /@mono-agent\/one@1\.2\.3 differs from @mono-agent\/two@1\.2\.4/u,
    );
  });

  it("keeps the built-export import-safety check in CI after build and before tests", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const build = workflow.indexOf("- name: Build and typecheck the complete v1 workspace");
    const exportsCheck = workflow.indexOf("- name: Check built package exports and import safety");
    const tests = workflow.indexOf("- name: Test the complete v1 workspace");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(exportsCheck).toBeGreaterThan(build);
    expect(tests).toBeGreaterThan(exportsCheck);
    expect(workflow).toContain("run: pnpm run check:deep-imports");
  });

  it("smokes the current CLI package in the release workflow", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".github/workflows/npm-release.yml"),
      "utf8",
    );
    const packedSmoke = readFileSync(
      resolve(repoRoot, "scripts/release/fixtures/packed-consumer/smoke.mjs"),
      "utf8",
    );

    expect(workflow).toContain('"@mono-agent/cli@${VERSION}"');
    expect(workflow).not.toContain("@mono-agent/agent-app");
    expect(packedSmoke).toContain('packageName: "@mono-agent/cli"');
    expect(packedSmoke).not.toContain("@mono-agent/agent-app");
  });
});

function greenConsumers() {
  return {
    exitCode: 0,
    statusByLabel: new Map([
      ["minimal template contract", true],
      ["personal template contract", true],
      ["multi-runtime template contract", true],
    ]),
  };
}

function gateByLabel(gates, label) {
  const gate = gates.find((entry) => entry.label === label);
  if (gate === undefined) throw new Error(`Missing gate ${label}`);
  return gate;
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

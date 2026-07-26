// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, test } from "vitest";

import { packageCatalog, packageRelativePath } from "../lib/package-catalog.mjs";
import { publicExportSpecifiers } from "../release/fixtures/packed-consumer/public-exports.mjs";
import {
  SYSTEM_PROOF_SCHEMA,
  assertArtifactSetEvidence,
  assertConfigSetEvidence,
  assertFreshPackageOutputs,
  assertLockfileArtifactIntegrities,
  assertProofNodeVersion,
  assertStableGitHead,
  assertTarballSnapshotsStable,
  assertV1PublicExportSpecifiers,
  assertV1SystemProofEvidence,
  buildArtifactSetEvidence,
  buildConfigSetEvidence,
  buildInstalledClosure,
  buildTemplateConfigRecord,
  buildV1SystemProofEvidence,
  captureCleanGitHead,
  createFreshProofWorkspace,
  removeFreshProofWorkspace,
  snapshotTarball,
  PUBLIC_EXPORT_SPECIFIERS,
} from "../lib/system-proof.mjs";

const temporaryDirectories = [];
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const VERSION = "0.15.0";
const PACKAGE_NAMES = [
  "@mono-agent/a",
  "@mono-agent/b",
  "create-mono-agent",
];
const SOURCE_BETA_PACKAGE_NAMES = packageCatalog.map((entry) => entry.name);
const TEMPLATES = ["minimal", "personal", "multi-runtime"];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("packed proof Node and source authority", () => {
  test("reuses the validated packed consumer for the docs-mcp functional smoke", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "verify", "system.mjs"),
      "utf8",
    );
    expect(source).toContain([
      "await proveDocsMcpPackedClient(",
      "      workspace.checkout,",
      "      consumerDirectory,",
      '      tarballs.get("@mono-agent/docs-mcp"),',
      "    );",
    ].join("\n"));
    expect(source).toContain(
      "MONO_AGENT_DOCS_MCP_INSTALL_ROOT: consumerDirectory,",
    );
    expect(source).toContain('proof.execution !== "package-bin"');
    expect(source).toContain('proof.installation !== "preinstalled"');
    expect(source).toContain('NPM_CONFIG_OFFLINE: "true"');
    expect(source).toContain('npm_config_offline: "true"');
  });

  test("pins the complete 28-code plus 3-JSON packed public export surface", () => {
    expect(PUBLIC_EXPORT_SPECIFIERS).toHaveLength(31);
    expect(PUBLIC_EXPORT_SPECIFIERS.filter((specifier) =>
      specifier.endsWith("/package.json"))).toHaveLength(3);
    expect(PUBLIC_EXPORT_SPECIFIERS).toContain("@mono-agent/module-sdk/http");
    expect(PUBLIC_EXPORT_SPECIFIERS).toContain("@mono-agent/module-sdk/internal");
    expect(PUBLIC_EXPORT_SPECIFIERS).toContain("@mono-agent/module-sdk/secure-fs");
    expect(PUBLIC_EXPORT_SPECIFIERS).toContain("@mono-agent/module-sdk/testing");
    expect(PUBLIC_EXPORT_SPECIFIERS).toContain("@mono-agent/operator/testing");
    expect(assertV1PublicExportSpecifiers(PUBLIC_EXPORT_SPECIFIERS))
      .toEqual(PUBLIC_EXPORT_SPECIFIERS);
    expect(() => assertV1PublicExportSpecifiers(PUBLIC_EXPORT_SPECIFIERS.slice(0, -1)))
      .toThrow(/exact ordered 31-specifier/u);
    expect(() => assertV1PublicExportSpecifiers([
      ...PUBLIC_EXPORT_SPECIFIERS,
      PUBLIC_EXPORT_SPECIFIERS[0],
    ])).toThrow(/duplicate/u);
    const derived = packageCatalog.flatMap((entry) => {
      const manifest = JSON.parse(readFileSync(
        join(process.cwd(), packageRelativePath(entry), "package.json"),
        "utf8",
      ));
      return publicExportSpecifiers(entry.name, manifest);
    });
    expect(assertV1PublicExportSpecifiers(derived)).toEqual(PUBLIC_EXPORT_SPECIFIERS);
  });

  test("accepts the supported Node floor and records the exact runtime", () => {
    expect(assertProofNodeVersion("22.19.0")).toMatchObject({
      nodeVersion: "22.19.0",
      nodeRequirement: ">=22.19.0",
      result: "passed",
    });
    expect(assertProofNodeVersion("24.0.0").result).toBe("passed");
    expect(() => assertProofNodeVersion("22.18.0")).toThrow(/requires Node\.js >=22\.19\.0/u);
    expect(() => assertProofNodeVersion("current")).toThrow(/Could not parse Node\.js version/u);
  });

  test("refuses dirty tracked source", () => {
    const repo = gitFixture();
    expect(captureCleanGitHead({ repo }).clean).toBe(true);
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    expect(() => captureCleanGitHead({ repo })).toThrow(/requires a clean Git HEAD/u);
  });

  test("refuses untracked source", () => {
    const repo = gitFixture();
    writeFileSync(join(repo, "untracked.txt"), "not committed\n");
    expect(() => captureCleanGitHead({ repo })).toThrow(/including no untracked files/u);
  });

  test("refuses staged source", () => {
    const repo = gitFixture();
    writeFileSync(join(repo, "staged.txt"), "not committed\n");
    git(repo, ["add", "staged.txt"]);
    expect(() => captureCleanGitHead({ repo })).toThrow(/requires a clean Git HEAD/u);
  });

  test("fails when HEAD changes during the proof", () => {
    const repo = gitFixture();
    const initial = captureCleanGitHead({ repo });
    writeFileSync(join(repo, "second.txt"), "second\n");
    git(repo, ["add", "second.txt"]);
    git(repo, ["-c", "user.name=Proof Test", "-c", "user.email=proof@example.invalid", "commit", "-m", "second"]);
    const observed = captureCleanGitHead({ repo });
    expect(() => assertStableGitHead(initial, observed, "build and pack")).toThrow(
      /Git HEAD changed during build and pack/u,
    );
  });

  test("requires full lowercase source SHAs", () => {
    expect(() => assertStableGitHead(
      { commitSha: "abc123", clean: true },
      { commitSha: "abc123", clean: true },
    )).toThrow(/full lowercase Git commit SHA/u);
    expect(() => assertStableGitHead(
      { commitSha: SHA.toUpperCase(), clean: true },
      { commitSha: SHA.toUpperCase(), clean: true },
    )).toThrow(/full lowercase Git commit SHA/u);
  });
});

describe("fresh exact-SHA proof workspace", () => {
  test("excludes ignored stale dist output by cloning the exact clean commit", () => {
    const repo = workspaceGitFixture();
    const source = captureCleanGitHead({ repo });
    const stale = join(repo, "packages", "a", "dist", "stale.js");
    mkdirSync(join(repo, "packages", "a", "dist"));
    writeFileSync(stale, "stale ignored output\n");
    expect(captureCleanGitHead({ repo })).toEqual(source);

    const temporaryParent = temporaryDirectory("mono-agent-proof-parent-");
    const workspace = createFreshProofWorkspace({
      repo,
      source,
      temporaryParent,
    });
    expect(captureCleanGitHead({ repo: workspace.checkout })).toEqual(source);
    expect(assertFreshPackageOutputs({
      workspace,
      catalog: [{ name: "@mono-agent/a", dir: "a", publishable: true }],
      expectedPackageNames: ["@mono-agent/a"],
    })).toEqual({ packageCount: 1, sourceSha: source.commitSha });
    expect(existsSync(join(workspace.checkout, "packages", "a", "dist"))).toBe(false);
    expect(readFileSync(stale, "utf8")).toBe("stale ignored output\n");

    const root = workspace.root;
    removeFreshProofWorkspace(workspace);
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(stale, "utf8")).toBe("stale ignored output\n");
  });

  test("refuses a stale source snapshot before creating a workspace", () => {
    const repo = workspaceGitFixture();
    const source = captureCleanGitHead({ repo });
    writeFileSync(join(repo, "second.txt"), "second\n");
    git(repo, ["add", "second.txt"]);
    git(repo, ["-c", "user.name=Proof Test", "-c", "user.email=proof@example.invalid", "commit", "-m", "second"]);
    const temporaryParent = temporaryDirectory("mono-agent-proof-parent-");
    expect(() => createFreshProofWorkspace({
      repo,
      source,
      temporaryParent,
    })).toThrow(/Git HEAD changed during fresh-workspace creation/u);
    expect(readFileSync(join(repo, "second.txt"), "utf8")).toBe("second\n");
  });

  test("rejects unsafe package roots without mutating the source checkout", () => {
    const repo = workspaceGitFixture();
    const source = captureCleanGitHead({ repo });
    const workspace = createFreshProofWorkspace({
      repo,
      source,
      temporaryParent: temporaryDirectory("mono-agent-proof-parent-"),
    });
    expect(() => assertFreshPackageOutputs({
      workspace,
      catalog: [{ name: "@mono-agent/escape", path: "../outside", publishable: true }],
      expectedPackageNames: ["@mono-agent/escape"],
    })).toThrow(/rejected package root/u);
    expect(captureCleanGitHead({ repo })).toEqual(source);
    removeFreshProofWorkspace(workspace);
  });

  test("cleanup refuses a replaced temporary root and preserves outside data", () => {
    const repo = workspaceGitFixture();
    const workspace = createFreshProofWorkspace({
      repo,
      source: captureCleanGitHead({ repo }),
      temporaryParent: temporaryDirectory("mono-agent-proof-parent-"),
    });
    const outside = temporaryDirectory("mono-agent-proof-outside-");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "keep\n");
    rmSync(workspace.root, { recursive: true });
    symlinkSync(outside, workspace.root);
    expect(() => removeFreshProofWorkspace(workspace)).toThrow(
      /owner-private temporary directory|identity changed/u,
    );
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
  });
});

describe("immutable tarball evidence", () => {
  test("covers the exact ordered 23-package source-beta roster", () => {
    expect(SOURCE_BETA_PACKAGE_NAMES).toHaveLength(23);
    const { snapshots } = artifactFixture(SOURCE_BETA_PACKAGE_NAMES);
    const evidence = buildArtifactSetEvidence(snapshots, {
      expectedPackageNames: SOURCE_BETA_PACKAGE_NAMES,
      expectedVersion: VERSION,
    });
    expect(evidence.packageCount).toBe(23);
    expect(evidence.packages.map((entry) => entry.name)).toEqual(SOURCE_BETA_PACKAGE_NAMES);
  });

  test("records SHA-256 and npm SHA-512 integrity for exact ordered artifacts", () => {
    const fixture = artifactFixture(PACKAGE_NAMES);
    const snapshots = fixture.snapshots;
    const evidence = buildArtifactSetEvidence(snapshots, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    });
    expect(evidence.packageCount).toBe(3);
    expect(evidence.aggregateSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.packages[0]).toMatchObject({
      name: PACKAGE_NAMES[0],
      version: VERSION,
      sha256: createHash("sha256").update("artifact-0\n").digest("hex"),
      integrity: `sha512-${createHash("sha512").update("artifact-0\n").digest("base64")}`,
    });
    expect(JSON.stringify(evidence)).not.toContain(fixture.root);
  });

  test("rejects missing, duplicated, or reordered artifact records", () => {
    const { snapshots } = artifactFixture(PACKAGE_NAMES);
    expect(() => buildArtifactSetEvidence(snapshots.slice(0, 2), {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    })).toThrow(/requires exactly 3 packages/u);
    expect(() => buildArtifactSetEvidence([...snapshots].reverse(), {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    })).toThrow(/order mismatch/u);
    expect(() => buildArtifactSetEvidence(
      [snapshots[0], { ...snapshots[1], filename: snapshots[0].filename }, snapshots[2]],
      {
        expectedPackageNames: PACKAGE_NAMES,
        expectedVersion: VERSION,
      },
    )).toThrow(/duplicate tarball filenames/u);
  });

  test("detects tarball tampering after packing", () => {
    const fixture = artifactFixture(PACKAGE_NAMES);
    writeFileSync(fixture.snapshots[1].tarballPath, "tampered\n");
    expect(() => assertTarballSnapshotsStable(fixture.snapshots, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    })).toThrow(/tarball changed after it was packed/u);
  });

  test("rejects a forged artifact aggregate or integrity", () => {
    const { snapshots } = artifactFixture(PACKAGE_NAMES);
    const evidence = buildArtifactSetEvidence(snapshots, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    });
    expect(() => assertArtifactSetEvidence({
      ...evidence,
      aggregateSha256: "0".repeat(64),
    }, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    })).toThrow(/aggregate digest/u);
    const forged = structuredClone(evidence);
    forged.packages[0].integrity = "sha512-not-base64";
    expect(() => assertArtifactSetEvidence(forged, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    })).toThrow(/npm-compatible SHA-512/u);
  });

  test("requires the installed lockfile to bind every tarball integrity", () => {
    const { snapshots } = artifactFixture(PACKAGE_NAMES);
    const evidence = buildArtifactSetEvidence(snapshots, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    });
    const lock = {
      packages: Object.fromEntries(evidence.packages.map((artifact) => [
        artifact.name,
        { resolution: { integrity: artifact.integrity } },
      ])),
    };
    expect(() => assertLockfileArtifactIntegrities(lock, evidence)).not.toThrow();
    delete lock.packages[PACKAGE_NAMES[1]];
    expect(() => assertLockfileArtifactIntegrities(lock, evidence)).toThrow(
      /does not bind @mono-agent\/b tarball integrity/u,
    );
  });
});

describe("closure and config digests", () => {
  test("normalizes dependency order and paths while binding package versions", () => {
    const first = buildInstalledClosure(pnpmListFixture(), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    });
    const reordered = buildInstalledClosure(pnpmListFixture({ reverse: true, alternatePaths: true }), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    });
    expect(reordered).toEqual(first);
    expect(first.packages).toContainEqual({ name: "external", version: "1.2.3" });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);

    const changed = buildInstalledClosure(pnpmListFixture({ externalVersion: "1.2.4" }), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    });
    expect(changed.sha256).not.toBe(first.sha256);
  });

  test("fails closed on first-party closure drift", () => {
    expect(() => buildInstalledClosure(pnpmListFixture({ packageVersion: "0.15.1" }), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    })).toThrow(/exact first-party package roster and version/u);
    expect(() => buildInstalledClosure(pnpmListFixture({ unexpectedFirstParty: true }), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    })).toThrow(/exact first-party package roster and version/u);
  });

  test("hashes exact config bytes and exact template order", () => {
    const records = configRecords();
    const evidence = buildConfigSetEvidence(records, { expectedTemplates: TEMPLATES });
    expect(evidence.templateCount).toBe(3);
    expect(evidence.aggregateSha256).toMatch(/^[0-9a-f]{64}$/u);
    const whitespaceChanged = buildTemplateConfigRecord({
      template: "minimal",
      configSource: '{ "configVersion": 1 }\n',
      dependencies: { "@mono-agent/a": VERSION },
      selectedPackages: ["@mono-agent/a"],
    });
    expect(whitespaceChanged.sha256).not.toBe(records[0].sha256);
    expect(() => buildConfigSetEvidence([...records].reverse(), {
      expectedTemplates: TEMPLATES,
    })).toThrow(/template order mismatch/u);
    expect(() => assertConfigSetEvidence({
      ...evidence,
      aggregateSha256: "0".repeat(64),
    }, { expectedTemplates: TEMPLATES })).toThrow(/aggregate digest/u);
  });
});

describe("complete machine evidence", () => {
  test("binds source, Node, artifacts, closure, and configs without local paths", () => {
    const fixture = artifactFixture(PACKAGE_NAMES);
    const artifacts = assertTarballSnapshotsStable(fixture.snapshots, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    });
    const closure = buildInstalledClosure(pnpmListFixture(), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    });
    const configs = buildConfigSetEvidence(configRecords(), { expectedTemplates: TEMPLATES });
    const evidence = buildV1SystemProofEvidence({
      sourceInitial: { commitSha: SHA, clean: true },
      sourceFinal: { commitSha: SHA, clean: true },
      nodeVersion: "22.19.0",
      platform: "linux",
      arch: "x64",
      artifacts,
      closure,
      configs,
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
      expectedTemplates: TEMPLATES,
    });
    expect(evidence).toMatchObject({
      schema: SYSTEM_PROOF_SCHEMA,
      result: "passed",
      source: { commitSha: SHA, clean: true, stable: true },
      runtime: {
        nodeVersion: "22.19.0",
        nodeRequirement: ">=22.19.0",
        platform: "linux",
        arch: "x64",
        result: "passed",
      },
    });
    expect(evidence.closureConfigSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain(fixture.root);
    expect(() => assertV1SystemProofEvidence(evidence, {
      expectedSourceSha: SHA,
      expectedNodeVersion: "22.19.0",
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
      expectedTemplates: TEMPLATES,
    })).not.toThrow();
  });

  test.each([
    ["result", (value) => { value.result = "failed"; }, /invalid schema or result/u],
    ["source", (value) => { value.source.commitSha = OTHER_SHA; }, /source SHA/u],
    ["node", (value) => { value.runtime.nodeVersion = "24.0.0"; }, /Node\.js version/u],
    ["artifacts", (value) => { value.artifacts.aggregateSha256 = "0".repeat(64); }, /Artifact-set aggregate/u],
    ["closure", (value) => { value.closure.sha256 = "0".repeat(64); }, /closure digest/u],
    ["configs", (value) => { value.configs.aggregateSha256 = "0".repeat(64); }, /Config-set aggregate/u],
    ["combined", (value) => { value.closureConfigSha256 = "0".repeat(64); }, /closure\/config digest/u],
  ])("rejects mutated %s evidence", (_label, mutate, pattern) => {
    const evidence = proofFixture();
    const changed = structuredClone(evidence);
    mutate(changed);
    expect(() => assertV1SystemProofEvidence(changed, {
      expectedSourceSha: SHA,
      expectedNodeVersion: "22.19.0",
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
      expectedTemplates: TEMPLATES,
    })).toThrow(pattern);
  });
});

function proofFixture() {
  const fixture = artifactFixture(PACKAGE_NAMES);
  return buildV1SystemProofEvidence({
    sourceInitial: { commitSha: SHA, clean: true },
    sourceFinal: { commitSha: SHA, clean: true },
    nodeVersion: "22.19.0",
    artifacts: buildArtifactSetEvidence(fixture.snapshots, {
      expectedPackageNames: PACKAGE_NAMES,
      expectedVersion: VERSION,
    }),
    closure: buildInstalledClosure(pnpmListFixture(), {
      expectedFirstPartyNames: PACKAGE_NAMES,
      expectedFirstPartyVersion: VERSION,
    }),
    configs: buildConfigSetEvidence(configRecords(), { expectedTemplates: TEMPLATES }),
    expectedPackageNames: PACKAGE_NAMES,
    expectedVersion: VERSION,
    expectedTemplates: TEMPLATES,
  });
}

function gitFixture() {
  const repo = temporaryDirectory("mono-agent-proof-git-");
  git(repo, ["init", "--quiet"]);
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, [
    "-c",
    "user.name=Proof Test",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  return repo;
}

function git(repo, args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function workspaceGitFixture() {
  const repo = temporaryDirectory("mono-agent-proof-workspace-");
  git(repo, ["init", "--quiet"]);
  mkdirSync(join(repo, "packages", "a", "src"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "packages/*/dist/\n");
  writeFileSync(join(repo, "packages", "a", "src", "index.ts"), "export const a = true;\n");
  writeJson(join(repo, "packages", "a", "package.json"), {
    name: "@mono-agent/a",
    version: VERSION,
  });
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Proof Test",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "workspace",
  ]);
  return repo;
}

function artifactFixture(packageNames) {
  const root = temporaryDirectory("mono-agent-proof-artifacts-");
  const snapshots = packageNames.map((name, index) => {
    const filename = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${VERSION}.tgz`;
    const tarballPath = join(root, filename);
    writeFileSync(tarballPath, `artifact-${index}\n`);
    return snapshotTarball({
      name,
      version: VERSION,
      tarballPath,
      expectedDirectory: root,
    });
  });
  return { root, snapshots };
}

function pnpmListFixture(options = {}) {
  const pathPrefix = options.alternatePaths ? "/different/root" : "/tmp/root";
  const rows = [
    ["@mono-agent/a", {
      version: options.packageVersion ?? VERSION,
      path: `${pathPrefix}/a`,
      dependencies: {
        external: {
          version: options.externalVersion ?? "1.2.3",
          path: `${pathPrefix}/external`,
        },
      },
    }],
    ["@mono-agent/b", { version: VERSION, path: `${pathPrefix}/b` }],
    ["create-mono-agent", { version: VERSION, path: `${pathPrefix}/create` }],
  ];
  if (options.unexpectedFirstParty) {
    rows.push(["@mono-agent/unexpected", { version: VERSION, path: `${pathPrefix}/unexpected` }]);
  }
  if (options.reverse) rows.reverse();
  return [{
    name: "consumer",
    version: "0.0.0",
    path: pathPrefix,
    dependencies: Object.fromEntries(rows),
  }];
}

function configRecords() {
  return TEMPLATES.map((template, index) => buildTemplateConfigRecord({
    template,
    configSource: `${JSON.stringify({ configVersion: 1, agent: { id: template } }, null, 2)}\n`,
    dependencies: {
      "@mono-agent/a": VERSION,
      ...(index > 0 ? { "@mono-agent/b": VERSION } : {}),
    },
    selectedPackages: index > 0
      ? ["@mono-agent/a", "@mono-agent/b"]
      : ["@mono-agent/a"],
  }));
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

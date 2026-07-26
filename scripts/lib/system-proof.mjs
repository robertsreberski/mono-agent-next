// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  SUPPORTED_NODE_ENGINE,
  assertSupportedNodeVersion,
} from "../check/node-version.mjs";

export const SYSTEM_PROOF_SCHEMA = "mono-agent.system-proof.v1";
export const ARTIFACT_SET_SCHEMA = "mono-agent.artifact-set.v1";
export const CLOSURE_SCHEMA = "mono-agent.installed-closure.v1";
export const CONFIG_SET_SCHEMA = "mono-agent.config-set.v1";
export const PUBLIC_EXPORT_SPECIFIERS = Object.freeze([
  "@mono-agent/module-sdk",
  "@mono-agent/module-sdk/http",
  "@mono-agent/module-sdk/internal",
  "@mono-agent/module-sdk/secure-fs",
  "@mono-agent/module-sdk/testing",
  "@mono-agent/core",
  "@mono-agent/cli",
  "@mono-agent/cli/package.json",
  "@mono-agent/runtime-pi",
  "@mono-agent/runtime-claude",
  "@mono-agent/runtime-codex",
  "@mono-agent/runtime-opencode",
  "@mono-agent/channel-telegram",
  "@mono-agent/channel-slack",
  "@mono-agent/channel-webhook",
  "@mono-agent/channel-openai-api",
  "@mono-agent/channel-operator",
  "@mono-agent/trigger-cron",
  "@mono-agent/memory-local",
  "@mono-agent/state-local",
  "@mono-agent/exporter-otlp",
  "@mono-agent/sandbox-srt",
  "@mono-agent/operator",
  "@mono-agent/operator/testing",
  "@mono-agent/tui",
  "@mono-agent/web",
  "create-mono-agent",
  "create-mono-agent/package.json",
  "@mono-agent/docs-mcp",
  "@mono-agent/docs-mcp/package.json",
  "@mono-agent/service-macos",
]);

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PACKAGE_ROOT = /^(?:packages|extras)\/[a-z0-9][a-z0-9-]*$/u;
const TARBALL = /^[0-9A-Za-z][0-9A-Za-z._+-]*\.tgz$/u;
const workspaces = new WeakSet();

export function assertV1PublicExportSpecifiers(specifiers) {
  invariant(Array.isArray(specifiers), "Packed public export proof must be an array.");
  const actual = [...specifiers];
  invariant(
    actual.every((specifier) => typeof specifier === "string"),
    "Packed public export proof contains a non-string specifier.",
  );
  invariant(
    new Set(actual).size === actual.length,
    "Packed public export proof contains duplicate specifiers.",
  );
  invariant(
    JSON.stringify(actual) === JSON.stringify(PUBLIC_EXPORT_SPECIFIERS),
    `Packed public export proof must cover the exact ordered ${String(PUBLIC_EXPORT_SPECIFIERS.length)}-specifier surface.`,
  );
  return Object.freeze(actual);
}

export function assertProofNodeVersion(nodeVersion = process.versions.node) {
  assertSupportedNodeVersion(nodeVersion);
  return {
    nodeVersion,
    nodeRequirement: SUPPORTED_NODE_ENGINE,
    platform: process.platform,
    arch: process.arch,
    result: "passed",
  };
}

export function captureCleanGitHead({ repo = process.cwd(), spawn = spawnSync } = {}) {
  const root = realpathSync(repo);
  const before = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], spawn).toLowerCase();
  validSha(before, "Git HEAD");
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], spawn);
  const after = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], spawn).toLowerCase();
  validSha(after, "Git HEAD");
  invariant(before === after, "Packed proof refused source because Git HEAD changed during inspection.");
  invariant(status === "", "Packed proof requires a clean Git HEAD, including no untracked files.");
  return Object.freeze({ commitSha: before, clean: true });
}

export function assertStableGitHead(initial, observed, stage = "proof") {
  validSource(initial, "Initial source");
  validSource(observed, `Source after ${stage}`);
  invariant(
    initial.commitSha === observed.commitSha,
    `Packed proof refused source because Git HEAD changed during ${stage}.`,
  );
  return Object.freeze({ commitSha: initial.commitSha, clean: true, stable: true });
}

export function createFreshProofWorkspace(options = {}) {
  const repo = realpathSync(options.repo ?? process.cwd());
  const spawn = options.spawn ?? spawnSync;
  const capturedSource = options.source ?? captureCleanGitHead({ repo, spawn });
  validSource(capturedSource, "Fresh-workspace source");
  const source = Object.freeze({ commitSha: capturedSource.commitSha, clean: true });
  assertStableGitHead(source, captureCleanGitHead({ repo, spawn }), "fresh-workspace creation");

  const parent = realpathSync(options.temporaryParent ?? tmpdir());
  const root = mkdtempSync(join(parent, "mono-agent-proof-"));
  const workspace = Object.freeze({
    root,
    checkout: join(root, "checkout"),
    source,
    identity: directoryIdentity(root),
  });
  workspaces.add(workspace);
  try {
    git(repo, ["clone", "--no-hardlinks", "--no-checkout", "--", repo, workspace.checkout], spawn);
    git(workspace.checkout, ["checkout", "--detach", "--force", source.commitSha], spawn);
    assertStableGitHead(
      source,
      captureCleanGitHead({ repo: workspace.checkout, spawn }),
      "fresh detached checkout",
    );
    validWorkspace(workspace);
    return workspace;
  } catch (error) {
    try {
      removeFreshProofWorkspace(workspace);
    } catch {
      // Do not mask the clone or checkout failure.
    }
    throw error;
  }
}

export function assertFreshPackageOutputs({ workspace, catalog, expectedPackageNames } = {}) {
  validWorkspace(workspace);
  invariant(
    Array.isArray(catalog)
      && Array.isArray(expectedPackageNames)
      && same(catalog.map((entry) => entry?.name), expectedPackageNames)
      && new Set(expectedPackageNames).size === expectedPackageNames.length,
    "Fresh-output proof package roster does not match the exact expected order.",
  );
  for (const entry of catalog) {
    invariant(entry?.publishable === true, `Fresh-output proof rejected ${String(entry?.name)} as non-publishable.`);
    const path = entry.path ?? `packages/${entry.dir}`;
    invariant(
      typeof path === "string" && !isAbsolute(path) && PACKAGE_ROOT.test(path),
      `Fresh-output proof rejected package root ${JSON.stringify(path)}.`,
    );
    const packageRoot = resolve(workspace.checkout, path);
    invariant(
      relative(workspace.checkout, packageRoot).replaceAll("\\", "/") === path,
      `Fresh-output proof rejected package root ${JSON.stringify(path)}.`,
    );
    const packageStat = lstatSync(packageRoot);
    invariant(
      packageStat.isDirectory()
        && !packageStat.isSymbolicLink()
        && realpathSync(packageRoot) === packageRoot,
      `Fresh-output proof rejected redirected package root ${path}.`,
    );
    const manifestPath = join(packageRoot, "package.json");
    const manifestStat = lstatSync(manifestPath);
    invariant(
      manifestStat.isFile()
        && !manifestStat.isSymbolicLink()
        && realpathSync(manifestPath) === manifestPath,
      `Fresh-output proof rejected unsafe package manifest for ${entry.name}.`,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    invariant(manifest.name === entry.name, `Fresh-output proof expected ${entry.name} at ${path}.`);
    invariant(
      statIfPresent(join(packageRoot, "dist")) === undefined,
      `${entry.name} fresh detached checkout unexpectedly contains dist output.`,
    );
  }
  return { packageCount: catalog.length, sourceSha: workspace.source.commitSha };
}

export function removeFreshProofWorkspace(workspace) {
  validWorkspace(workspace);
  rmSync(workspace.root, { recursive: true, force: false });
  invariant(
    statIfPresent(workspace.root) === undefined,
    "Proof workspace cleanup did not remove its exact temporary root.",
  );
  workspaces.delete(workspace);
}

export function assertLockfileArtifactIntegrities(lock, artifacts) {
  invariant(lock !== null && typeof lock === "object", "Artifact lockfile proof requires parsed lockfile data.");
  const packages = Array.isArray(artifacts) ? artifacts : artifacts?.packages;
  invariant(Array.isArray(packages) && packages.length > 0, "Artifact lockfile proof requires artifact records.");
  const integrities = new Set();
  walk(lock, (key, value) => {
    if (key === "integrity" && typeof value === "string") integrities.add(value);
  });
  for (const artifact of packages) {
    validIntegrity(artifact?.integrity, `${String(artifact?.name)} artifact integrity`);
    invariant(
      integrities.has(artifact.integrity),
      `Packed consumer lockfile does not bind ${artifact.name} tarball integrity.`,
    );
  }
}

export function snapshotTarball({ name, version, tarballPath, expectedDirectory } = {}) {
  validText(name, "package name");
  validText(version, `${name} version`);
  const authoredPath = resolve(tarballPath);
  invariant(!lstatSync(authoredPath).isSymbolicLink(), `${name} tarball path was redirected.`);
  const path = realpathSync(authoredPath);
  const directory = expectedDirectory === undefined ? dirname(path) : realpathSync(expectedDirectory);
  invariant(dirname(path) === directory, `${name} tarball escaped the expected pack directory.`);
  const filename = basename(path);
  invariant(TARBALL.test(filename), `${name} tarball has an unsafe filename.`);
  const stat = lstatSync(path);
  invariant(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0,
    `${name} tarball must be a non-empty single-link regular file.`,
  );
  const bytes = readFileSync(path);
  return {
    name,
    version,
    filename,
    size: bytes.byteLength,
    sha256: hash("sha256", bytes, "hex"),
    integrity: `sha512-${hash("sha512", bytes, "base64")}`,
    tarballPath: path,
  };
}

export function buildArtifactSetEvidence(snapshots, { expectedPackageNames, expectedVersion } = {}) {
  invariant(
    Array.isArray(snapshots)
      && Array.isArray(expectedPackageNames)
      && snapshots.length === expectedPackageNames.length,
    `Artifact evidence requires exactly ${expectedPackageNames?.length ?? 0} packages; found ${snapshots?.length ?? 0}.`,
  );
  const packages = snapshots.map((entry, index) => artifactRecord(
    entry,
    expectedPackageNames[index],
    expectedVersion,
  ));
  invariant(
    new Set(packages.map((entry) => entry.filename)).size === packages.length,
    "Artifact evidence contains duplicate tarball filenames.",
  );
  return {
    packageCount: packages.length,
    aggregateSha256: digest(ARTIFACT_SET_SCHEMA, packages),
    packages,
  };
}

export function assertTarballSnapshotsStable(snapshots, options = {}) {
  const observed = snapshots.map((entry) => snapshotTarball({
    name: entry.name,
    version: entry.version,
    tarballPath: entry.tarballPath,
    expectedDirectory: dirname(entry.tarballPath),
  }));
  snapshots.forEach((entry, index) => invariant(
    same(publicArtifact(entry), publicArtifact(observed[index])),
    `${entry.name} tarball changed after it was packed.`,
  ));
  return buildArtifactSetEvidence(observed, options);
}

export function assertArtifactSetEvidence(evidence, options = {}) {
  invariant(
    evidence && Array.isArray(evidence.packages) && evidence.packageCount === evidence.packages.length,
    "Artifact-set evidence is malformed.",
  );
  const rebuilt = buildArtifactSetEvidence(evidence.packages, {
    expectedPackageNames: options.expectedPackageNames ?? evidence.packages.map((entry) => entry.name),
    expectedVersion: options.expectedVersion,
  });
  invariant(
    evidence.aggregateSha256 === rebuilt.aggregateSha256,
    "Artifact-set aggregate digest does not match its package records.",
  );
  return evidence;
}

export function buildInstalledClosure(listOutput, options = {}) {
  const parsed = typeof listOutput === "string" ? JSON.parse(listOutput) : listOutput;
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  invariant(roots.length === 1 && roots[0] && typeof roots[0] === "object", "Installed closure proof requires exactly one pnpm list root.");
  const records = new Map();
  collectDependencies(roots[0].dependencies, records);
  const packages = [...records.values()].sort(comparePackage);
  invariant(packages.length > 0, "Installed closure proof found no production dependencies.");
  expectedFirstParty(packages, options);
  return {
    packageCount: packages.length,
    packages,
    sha256: digest(CLOSURE_SCHEMA, packages),
  };
}

export function assertClosureEvidence(evidence, options = {}) {
  invariant(
    evidence && Array.isArray(evidence.packages) && evidence.packageCount === evidence.packages.length,
    "Installed-closure evidence is malformed.",
  );
  const packages = evidence.packages.map(packageRecord).sort(comparePackage);
  invariant(
    same(packages, evidence.packages) && new Set(packages.map(keyOf)).size === packages.length,
    "Installed-closure package records must be unique and sorted.",
  );
  expectedFirstParty(packages, options);
  invariant(
    evidence.sha256 === digest(CLOSURE_SCHEMA, packages),
    "Installed-closure digest does not match its package records.",
  );
  return evidence;
}

export function buildTemplateConfigRecord({ template, configSource, dependencies, selectedPackages } = {}) {
  validText(template, "template name");
  const bytes = Buffer.isBuffer(configSource) ? configSource : Buffer.from(configSource, "utf8");
  const parsed = JSON.parse(bytes.toString("utf8"));
  invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${template} config must contain a JSON object.`);
  return {
    template,
    dependencies: normalizeDependencies(dependencies),
    selectedPackages: normalizeSelected(selectedPackages),
    sha256: hash("sha256", bytes, "hex"),
  };
}

export function buildConfigSetEvidence(records, { expectedTemplates } = {}) {
  invariant(
    Array.isArray(records)
      && Array.isArray(expectedTemplates)
      && records.length === expectedTemplates.length,
    `Config-set evidence requires exactly ${expectedTemplates?.length ?? 0} templates; found ${records?.length ?? 0}.`,
  );
  const templates = records.map((record, index) => templateRecord(record, expectedTemplates[index]));
  return {
    templateCount: templates.length,
    aggregateSha256: digest(CONFIG_SET_SCHEMA, templates),
    templates,
  };
}

export function assertConfigSetEvidence(evidence, options = {}) {
  invariant(
    evidence && Array.isArray(evidence.templates) && evidence.templateCount === evidence.templates.length,
    "Config-set evidence is malformed.",
  );
  const rebuilt = buildConfigSetEvidence(evidence.templates, {
    expectedTemplates: options.expectedTemplates ?? evidence.templates.map((entry) => entry.template),
  });
  invariant(
    evidence.aggregateSha256 === rebuilt.aggregateSha256,
    "Config-set aggregate digest does not match its template records.",
  );
  return evidence;
}

export function buildV1SystemProofEvidence(options = {}) {
  const source = assertStableGitHead(options.sourceInitial, options.sourceFinal, "the complete proof");
  const runtime = {
    ...assertProofNodeVersion(options.nodeVersion),
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
  };
  assertArtifactSetEvidence(options.artifacts, options);
  assertClosureEvidence(options.closure, {
    expectedFirstPartyNames: options.expectedPackageNames,
    expectedFirstPartyVersion: options.expectedVersion,
    forbiddenNames: options.forbiddenNames,
  });
  assertConfigSetEvidence(options.configs, { expectedTemplates: options.expectedTemplates });
  const evidence = {
    schema: SYSTEM_PROOF_SCHEMA,
    result: "passed",
    source,
    runtime,
    artifacts: options.artifacts,
    closure: options.closure,
    configs: options.configs,
    closureConfigSha256: combinedDigest(options.closure.sha256, options.configs.aggregateSha256),
  };
  return assertV1SystemProofEvidence(evidence, {
    ...options,
    expectedSourceSha: source.commitSha,
    expectedNodeVersion: options.nodeVersion,
  });
}

export function assertV1SystemProofEvidence(evidence, options = {}) {
  invariant(
    evidence?.schema === SYSTEM_PROOF_SCHEMA && evidence.result === "passed",
    "Packed system proof evidence has an invalid schema or result.",
  );
  validSource(evidence.source, "Proof source", true);
  invariant(
    options.expectedSourceSha === undefined || evidence.source.commitSha === options.expectedSourceSha,
    "Packed system proof source SHA does not match the expected candidate.",
  );
  invariant(
    evidence.runtime?.result === "passed"
      && evidence.runtime.nodeRequirement === SUPPORTED_NODE_ENGINE
      && typeof evidence.runtime.platform === "string"
      && evidence.runtime.platform.length > 0
      && typeof evidence.runtime.arch === "string"
      && evidence.runtime.arch.length > 0,
    "Packed system proof runtime evidence is malformed.",
  );
  assertSupportedNodeVersion(evidence.runtime.nodeVersion);
  invariant(
    options.expectedNodeVersion === undefined || evidence.runtime.nodeVersion === options.expectedNodeVersion,
    "Packed system proof Node.js version does not match the executing runtime.",
  );
  assertArtifactSetEvidence(evidence.artifacts, options);
  assertClosureEvidence(evidence.closure, {
    expectedFirstPartyNames: options.expectedPackageNames,
    expectedFirstPartyVersion: options.expectedVersion,
    forbiddenNames: options.forbiddenNames,
  });
  assertConfigSetEvidence(evidence.configs, { expectedTemplates: options.expectedTemplates });
  invariant(
    evidence.closureConfigSha256
      === combinedDigest(evidence.closure.sha256, evidence.configs.aggregateSha256),
    "Packed system proof closure/config digest does not match its evidence.",
  );
  return evidence;
}

function git(repo, args, spawn) {
  const result = spawn("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    shell: false,
  });
  invariant(
    result.error === undefined && result.status === 0,
    `Packed proof Git ${args[0]} failed.`,
  );
  return (result.stdout ?? "").trim();
}

function directoryIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  invariant(
    stat.isDirectory()
      && !stat.isSymbolicLink()
      && (stat.mode & 0o077n) === 0n
      && realpathSync(path) === path,
    "Proof workspace root must be a real owner-private temporary directory.",
  );
  return Object.freeze({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
}

function validWorkspace(workspace) {
  invariant(workspaces.has(workspace), "Proof workspace cleanup refused an unknown target.");
  const current = directoryIdentity(workspace.root);
  invariant(
    ["dev", "ino", "uid", "mode"].every((key) => current[key] === workspace.identity[key]),
    "Proof workspace root identity changed during verification.",
  );
  const checkout = statIfPresent(workspace.checkout);
  invariant(
    checkout === undefined
      || (checkout.isDirectory()
        && !checkout.isSymbolicLink()
        && realpathSync(workspace.checkout) === workspace.checkout),
    "Proof workspace checkout identity is unsafe.",
  );
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function artifactRecord(record, expectedName, expectedVersion) {
  invariant(record?.name === expectedName, `Artifact evidence order mismatch: expected ${expectedName}; found ${String(record?.name)}.`);
  invariant(expectedVersion === undefined || record.version === expectedVersion, `${record.name} artifact version must be ${expectedVersion}.`);
  validText(record.name, "artifact package name");
  validText(record.version, `${record.name} artifact version`);
  invariant(TARBALL.test(record.filename), `${record.name} artifact filename is unsafe.`);
  invariant(Number.isSafeInteger(record.size) && record.size > 0, `${record.name} artifact size must be a positive safe integer.`);
  validDigest(record.sha256, `${record.name} artifact SHA-256`);
  validIntegrity(record.integrity, `${record.name} artifact integrity`);
  return publicArtifact(record);
}

function publicArtifact(record) {
  return {
    name: record.name,
    version: record.version,
    filename: record.filename,
    size: record.size,
    sha256: record.sha256,
    integrity: record.integrity,
  };
}

function collectDependencies(dependencies, records) {
  if (dependencies === undefined) return;
  invariant(dependencies && typeof dependencies === "object" && !Array.isArray(dependencies), "Installed closure contains a malformed dependency map.");
  for (const name of Object.keys(dependencies).sort(compare)) {
    const node = dependencies[name];
    invariant(node && typeof node === "object" && !Array.isArray(node), `Installed closure contains a malformed record for ${name}.`);
    const record = packageRecord({ name, version: node.version });
    records.set(keyOf(record), record);
    collectDependencies(node.dependencies, records);
  }
}

function expectedFirstParty(packages, options) {
  if (options.expectedFirstPartyNames !== undefined) {
    const names = options.expectedFirstPartyNames;
    invariant(Array.isArray(names) && new Set(names).size === names.length, "Installed closure expected first-party roster is invalid.");
    const expectedSet = new Set(names);
    const actual = packages.filter((entry) => expectedSet.has(entry.name) || entry.name.startsWith("@mono-agent/"));
    const expected = names.map((name) => ({
      name,
      version: options.expectedFirstPartyVersion,
    })).sort(comparePackage);
    invariant(same(actual, expected), "Installed closure does not contain the exact first-party package roster and version.");
  }
  for (const name of options.forbiddenNames ?? []) {
    invariant(!packages.some((entry) => entry.name === name), `Installed closure contains forbidden predecessor package ${name}.`);
  }
}

function packageRecord(record) {
  validText(record?.name, "installed package name");
  validText(record?.version, `${record?.name} installed version`);
  invariant(same(Object.keys(record).sort(compare), ["name", "version"]), "Installed-closure package record contains unexpected fields.");
  return { name: record.name, version: record.version };
}

function normalizeDependencies(value) {
  const records = (Array.isArray(value)
    ? value
    : Object.entries(value ?? {}).map(([name, version]) => ({ name, version })))
    .map(packageRecord)
    .sort(comparePackage);
  invariant(new Set(records.map((entry) => entry.name)).size === records.length, "Template config dependencies contain duplicate package names.");
  return records;
}

function normalizeSelected(value) {
  invariant(Array.isArray(value), "Template config selectedPackages must be an array.");
  value.forEach((name) => validText(name, "selected package name"));
  const selected = [...value].sort(compare);
  invariant(new Set(selected).size === selected.length, "Template config selectedPackages contains duplicates.");
  return selected;
}

function templateRecord(record, expectedTemplate) {
  invariant(record?.template === expectedTemplate, `Config-set template order mismatch: expected ${expectedTemplate}; found ${String(record?.template)}.`);
  const dependencies = normalizeDependencies(record.dependencies);
  const selectedPackages = normalizeSelected(record.selectedPackages);
  invariant(same(dependencies, record.dependencies), `${record.template} config dependencies must be unique and sorted.`);
  invariant(same(selectedPackages, record.selectedPackages), `${record.template} selected packages must be unique and sorted.`);
  validDigest(record.sha256, `${record.template} config SHA-256`);
  return { template: record.template, dependencies, selectedPackages, sha256: record.sha256 };
}

function validSource(source, label, stable = false) {
  invariant(source?.clean === true && (!stable || source.stable === true), `${label} is not a clean${stable ? " stable" : ""} Git snapshot.`);
  validSha(source.commitSha, `${label} commit SHA`);
}

function validSha(value, label) {
  invariant(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full lowercase Git commit SHA.`);
}

function validDigest(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} must be 64 lowercase hexadecimal characters.`);
}

function validIntegrity(value, label) {
  invariant(typeof value === "string" && value.startsWith("sha512-"), `${label} must be an npm-compatible SHA-512 integrity.`);
  const encoded = value.slice(7);
  const bytes = Buffer.from(encoded, "base64");
  invariant(bytes.byteLength === 64 && bytes.toString("base64") === encoded, `${label} must be an npm-compatible SHA-512 integrity.`);
}

function validText(value, label) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && value.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(value),
    `${label} must be a bounded printable string.`,
  );
}

function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((child) => walk(child, visit));
  if (value === null || typeof value !== "object") return;
  Object.entries(value).forEach(([key, child]) => {
    visit(key, child);
    walk(child, visit);
  });
}

function hash(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function digest(schema, value) {
  return hash("sha256", Buffer.from(`${schema}\0${JSON.stringify(value)}`), "hex");
}

function combinedDigest(closure, configs) {
  validDigest(closure, "Installed-closure digest");
  validDigest(configs, "Config-set digest");
  return digest(`${SYSTEM_PROOF_SCHEMA}.closure-config`, {
    closureSha256: closure,
    configSha256: configs,
  });
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function keyOf(record) {
  return JSON.stringify([record.name, record.version]);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePackage(left, right) {
  return compare(left.name, right.name) || compare(left.version, right.version);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

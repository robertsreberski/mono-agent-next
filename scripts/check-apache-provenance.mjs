#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const APACHE_PROVENANCE_PATH = "licensing/apache-package-provenance.json";
export const APACHE_PROVENANCE_SCHEMA_VERSION = 1;
export const APACHE_PROVENANCE_SCOPES = Object.freeze([
  "packages/module-sdk",
  "packages/operator",
]);
export const AUDITED_PREDECESSOR_COMMIT = "79140866712145cb5cc3e2b742445db4fb1b4df8";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const AUTHORITY_DECLARATIONS = Object.freeze({
  "canonical-apache-2.0-license-text": Object.freeze({
    copyrightHolder: "The Apache Software Foundation",
    basis: "Verbatim canonical Apache License 2.0 text published for inclusion with Apache-licensed works.",
  }),
  "robert-sreberski-original-apache-2.0": Object.freeze({
    copyrightHolder: "Robert Sreberski",
    basis: "Original successor work authored for these extension surfaces and expressly offered under Apache-2.0.",
  }),
  "robert-sreberski-sole-holder-relicense-apache-2.0": Object.freeze({
    copyrightHolder: "Robert Sreberski",
    basis: "Sole-holder authorization to adapt the identified predecessor material and distribute the successor file under Apache-2.0, recorded in APACHE_PACKAGE_PROVENANCE.md.",
  }),
});

const STANDARD_LICENSE_PATHS = new Set([
  "packages/module-sdk/LICENSE",
  "packages/operator/LICENSE",
]);

const CANONICAL_APACHE2_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";

const OPERATOR_CLIENT_HISTORY = Object.freeze([
  "92ddcdaa915d8586bff96636169717bf91a7d1dc",
  "8450daa4fc56c7cadacf2fa0842ecbaae7fd3069",
  "7c89e063491de78959bf9baf0e7f974cc7801141",
  "b87f154b42b8a975c1d7966f851b7f29e2cd6962",
]);

export const REQUIRED_PREDECESSOR_PROVENANCE = Object.freeze({
  "packages/module-sdk/package.json": Object.freeze({
    path: "packages/agent-contracts/package.json",
    sha256: "e90493fe22e863549cf67bcdec0366a28e3f1cd28207e183edf2d6dd42a0d459",
  }),
  "packages/module-sdk/tsconfig.build.json": Object.freeze({
    path: "demos/final-agent/tsconfig.build.json",
    sha256: "25257d2dd7f34fc93e4d8d54ce27a3c927d810a89420dc762589284539b02c3b",
  }),
  "packages/module-sdk/tsconfig.json": Object.freeze({
    path: "demos/final-agent/tsconfig.json",
    sha256: "225981eeafafd467b56b2f0172463e4992b1b39bdc38fd82c35c676c1f8163ab",
  }),
  "packages/operator/package.json": Object.freeze({
    path: "packages/agent-contracts/package.json",
    sha256: "e90493fe22e863549cf67bcdec0366a28e3f1cd28207e183edf2d6dd42a0d459",
  }),
  "packages/operator/src/client.ts": Object.freeze({
    path: "packages/web/src/operator-client.ts",
    sha256: "d292e281c5cbd91fcb28bda03856b09535a5ae72c6203601d327975a51573364",
    materialCommits: OPERATOR_CLIENT_HISTORY,
  }),
  "packages/operator/tsconfig.build.json": Object.freeze({
    path: "packages/openai-api-adapter/tsconfig.build.json",
    sha256: "86d8cfcc7269c08261b84c895b2b7c498aab745837b9e376da51edfd405c97b1",
  }),
  "packages/operator/tsconfig.json": Object.freeze({
    path: "extras/a2a-adapter/tsconfig.json",
    sha256: "b7c1ac2823f73803939d6f8333ed8181c6380c443ce4662a88515b8286d00480",
  }),
});

export async function checkApacheProvenance(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const manifestPath = resolve(repoRoot, options.manifestPath ?? APACHE_PROVENANCE_PATH);
  const issues = [];
  let manifest;

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    issues.push(`${relativeLabel(repoRoot, manifestPath)} is missing or invalid JSON (${reasonOf(error)})`);
    return resultOf(issues, 0, 0);
  }

  validateManifestEnvelope(manifest, issues);

  let trackedFiles = [];
  let untrackedFiles = [];
  try {
    trackedFiles = options.trackedFiles
      ?? await gitPathList(repoRoot, ["ls-files", "-z", "--", ...APACHE_PROVENANCE_SCOPES]);
    untrackedFiles = options.untrackedFiles
      ?? await gitPathList(
        repoRoot,
        ["ls-files", "--others", "--exclude-standard", "-z", "--", ...APACHE_PROVENANCE_SCOPES],
      );
  } catch (error) {
    issues.push(`could not enumerate Apache package files from Git (${reasonOf(error)})`);
    return resultOf(issues, trackedFiles.length, Array.isArray(manifest?.files) ? manifest.files.length : 0);
  }

  trackedFiles = [...new Set(trackedFiles)].sort();
  untrackedFiles = [...new Set(untrackedFiles)].sort();
  const entries = Array.isArray(manifest?.files) ? manifest.files : [];
  const entriesByPath = new Map();

  for (const untrackedPath of untrackedFiles) {
    issues.push(`untracked file in Apache package scope is not covered: ${untrackedPath}`);
  }

  let previousPath;
  for (const [index, entry] of entries.entries()) {
    const label = `files[${String(index)}]`;
    validateExactKeys(
      entry,
      ["authorityBasis", "copyrightHolder", "origin", "path", "sha256"],
      label,
      issues,
    );
    if (!isRecord(entry) || typeof entry.path !== "string") {
      issues.push(`${label}.path must be a repository-relative string`);
      continue;
    }
    if (!isSafeScopedPath(entry.path)) {
      issues.push(`${entry.path} is outside the declared Apache package scopes or is not normalized`);
    }
    if (previousPath !== undefined && entry.path <= previousPath) {
      issues.push(`${entry.path} is out of order; provenance entries must be unique and bytewise sorted`);
    }
    previousPath = entry.path;
    if (entriesByPath.has(entry.path)) {
      issues.push(`${entry.path} has more than one provenance entry`);
      continue;
    }
    entriesByPath.set(entry.path, entry);
    validateEntry(entry, issues);
  }

  const trackedSet = new Set(trackedFiles);
  for (const path of trackedFiles) {
    if (!entriesByPath.has(path)) {
      issues.push(`tracked Apache package file is missing provenance: ${path}`);
    }
  }
  for (const path of [...entriesByPath.keys()].sort()) {
    if (!trackedSet.has(path)) {
      issues.push(`provenance entry does not name a tracked Apache package file: ${path}`);
    }
  }

  for (const [path, entry] of entriesByPath) {
    if (!trackedSet.has(path)) continue;
    await validateCurrentFile(repoRoot, path, entry, issues);
    if (entry.origin?.classification === "successor-original") {
      await validateSuccessorLineage(repoRoot, path, entry, issues);
    }
  }

  return resultOf(issues, trackedFiles.length, entries.length);
}

export function renderApacheProvenanceReport(result) {
  if (result.issues.length === 0) {
    return `Apache provenance check passed: ${String(result.trackedFileCount)} tracked files have exact hashes and reviewed authority.\n`;
  }
  return [
    "Apache provenance check failed",
    ...result.issues.map((issue) => `- ${issue}`),
    "",
  ].join("\n");
}

function validateManifestEnvelope(manifest, issues) {
  validateExactKeys(
    manifest,
    ["authorityDeclarations", "files", "hashAlgorithm", "license", "schemaVersion", "scopes"],
    "manifest",
    issues,
  );
  if (!isRecord(manifest)) return;
  if (manifest.schemaVersion !== APACHE_PROVENANCE_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${String(APACHE_PROVENANCE_SCHEMA_VERSION)}`);
  }
  if (manifest.license !== "Apache-2.0") {
    issues.push("license must be Apache-2.0");
  }
  if (manifest.hashAlgorithm !== "sha256") {
    issues.push("hashAlgorithm must be sha256");
  }
  if (
    !Array.isArray(manifest.scopes)
    || manifest.scopes.length !== APACHE_PROVENANCE_SCOPES.length
    || manifest.scopes.some((scope, index) => scope !== APACHE_PROVENANCE_SCOPES[index])
  ) {
    issues.push(`scopes must exactly equal ${JSON.stringify(APACHE_PROVENANCE_SCOPES)}`);
  }
  validateAuthorityDeclarations(manifest.authorityDeclarations, issues);
  if (!Array.isArray(manifest.files)) {
    issues.push("files must be an array");
  }
}

function validateAuthorityDeclarations(value, issues) {
  if (!Array.isArray(value)) {
    issues.push("authorityDeclarations must be an array");
    return;
  }
  const byId = new Map();
  for (const [index, declaration] of value.entries()) {
    const label = `authorityDeclarations[${String(index)}]`;
    validateExactKeys(declaration, ["basis", "copyrightHolder", "id"], label, issues);
    if (!isRecord(declaration) || typeof declaration.id !== "string") continue;
    if (byId.has(declaration.id)) {
      issues.push(`${label}.id duplicates ${declaration.id}`);
    }
    byId.set(declaration.id, declaration);
  }
  for (const [id, expected] of Object.entries(AUTHORITY_DECLARATIONS)) {
    const actual = byId.get(id);
    if (!isRecord(actual)) {
      issues.push(`authority declaration is missing: ${id}`);
      continue;
    }
    if (actual.copyrightHolder !== expected.copyrightHolder) {
      issues.push(`${id} copyrightHolder must be ${expected.copyrightHolder}`);
    }
    if (actual.basis !== expected.basis) {
      issues.push(`${id} basis does not match the reviewed authority declaration`);
    }
  }
  for (const id of byId.keys()) {
    if (!Object.hasOwn(AUTHORITY_DECLARATIONS, id)) {
      issues.push(`authority declaration is not reviewed: ${id}`);
    }
  }
}

function validateEntry(entry, issues) {
  if (!SHA256_PATTERN.test(entry.sha256 ?? "")) {
    issues.push(`${entry.path}.sha256 must be a lowercase SHA-256 digest`);
  }
  const declaration = Object.hasOwn(AUTHORITY_DECLARATIONS, entry.authorityBasis)
    ? AUTHORITY_DECLARATIONS[entry.authorityBasis]
    : undefined;
  if (declaration === undefined) {
    issues.push(`${entry.path}.authorityBasis is not a reviewed declaration`);
  } else if (entry.copyrightHolder !== declaration.copyrightHolder) {
    issues.push(`${entry.path}.copyrightHolder does not match ${entry.authorityBasis}`);
  }
  if (!isRecord(entry.origin) || typeof entry.origin.classification !== "string") {
    issues.push(`${entry.path}.origin must contain a reviewed classification`);
    return;
  }

  const requiredPredecessor = REQUIRED_PREDECESSOR_PROVENANCE[entry.path];
  if (requiredPredecessor !== undefined) {
    validatePredecessorOrigin(entry, requiredPredecessor, issues);
    return;
  }
  if (STANDARD_LICENSE_PATHS.has(entry.path)) {
    validateStandardLicenseOrigin(entry, issues);
    return;
  }
  validateSuccessorOrigin(entry, issues);
}

function validatePredecessorOrigin(entry, expected, issues) {
  const origin = entry.origin;
  const expectedKeys = expected.materialCommits === undefined
    ? ["classification", "commit", "path", "repository", "sha256"]
    : ["classification", "commit", "materialCommits", "path", "repository", "sha256"];
  validateExactKeys(origin, expectedKeys, `${entry.path}.origin`, issues);
  if (origin.classification !== "predecessor-authorized-adaptation") {
    issues.push(`${entry.path} must retain predecessor-authorized-adaptation provenance`);
  }
  if (origin.repository !== "mono-agent-predecessor") {
    issues.push(`${entry.path}.origin.repository must be mono-agent-predecessor`);
  }
  if (origin.commit !== AUDITED_PREDECESSOR_COMMIT) {
    issues.push(`${entry.path}.origin.commit must be the audited predecessor commit`);
  }
  if (origin.path !== expected.path) {
    issues.push(`${entry.path}.origin.path must be ${expected.path}`);
  }
  if (origin.sha256 !== expected.sha256) {
    issues.push(`${entry.path}.origin.sha256 does not match the audited predecessor source`);
  }
  if (entry.authorityBasis !== "robert-sreberski-sole-holder-relicense-apache-2.0") {
    issues.push(`${entry.path} must use the sole-holder relicensing authority`);
  }
  if (expected.materialCommits !== undefined && !sameStringArray(origin.materialCommits, expected.materialCommits)) {
    issues.push(`${entry.path}.origin.materialCommits must retain the complete reviewed predecessor history`);
  }
}

function validateStandardLicenseOrigin(entry, issues) {
  validateExactKeys(
    entry.origin,
    ["classification", "path", "repository", "sha256"],
    `${entry.path}.origin`,
    issues,
  );
  if (entry.origin.classification !== "standard-license-text") {
    issues.push(`${entry.path} must be classified as standard-license-text`);
  }
  if (entry.origin.repository !== "https://www.apache.org/licenses/") {
    issues.push(`${entry.path}.origin.repository must identify the Apache license publisher`);
  }
  if (entry.origin.path !== "LICENSE-2.0.txt") {
    issues.push(`${entry.path}.origin.path must be LICENSE-2.0.txt`);
  }
  if (entry.origin.sha256 !== CANONICAL_APACHE2_SHA256) {
    issues.push(`${entry.path}.origin.sha256 must match the canonical Apache-2.0 text`);
  }
  if (entry.authorityBasis !== "canonical-apache-2.0-license-text") {
    issues.push(`${entry.path} must use the canonical Apache license-text authority`);
  }
}

function validateSuccessorOrigin(entry, issues) {
  validateExactKeys(
    entry.origin,
    ["classification", "commit", "path", "repository"],
    `${entry.path}.origin`,
    issues,
  );
  if (entry.origin.classification !== "successor-original") {
    issues.push(`${entry.path} must be classified as successor-original unless the reviewed policy names another source`);
  }
  if (entry.origin.repository !== "mono-agent-next") {
    issues.push(`${entry.path}.origin.repository must be mono-agent-next`);
  }
  if (!COMMIT_PATTERN.test(entry.origin.commit ?? "")) {
    issues.push(`${entry.path}.origin.commit must be a full successor commit id`);
  }
  if (entry.origin.path !== entry.path) {
    issues.push(`${entry.path}.origin.path must match the successor file path`);
  }
  if (entry.authorityBasis !== "robert-sreberski-original-apache-2.0") {
    issues.push(`${entry.path} must use the original-work Apache authority`);
  }
}

async function validateCurrentFile(repoRoot, path, entry, issues) {
  const absolutePath = join(repoRoot, path);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    issues.push(`${path} is missing or unreadable (${reasonOf(error)})`);
    return;
  }
  if (!metadata.isFile()) {
    issues.push(`${path} must be a regular file; symlinks and other file types are not accepted`);
    return;
  }
  let contents;
  try {
    contents = await readFile(absolutePath);
  } catch (error) {
    issues.push(`${path} is missing or unreadable (${reasonOf(error)})`);
    return;
  }
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== entry.sha256) {
    issues.push(`${path} has stale provenance hash: expected ${entry.sha256}, found ${actual}`);
  }
}

async function validateSuccessorLineage(repoRoot, path, entry, issues) {
  const origin = entry.origin;
  if (!COMMIT_PATTERN.test(origin.commit ?? "")) return;
  try {
    await execFileAsync(
      "git",
      ["-C", repoRoot, "merge-base", "--is-ancestor", origin.commit, "HEAD"],
      { maxBuffer: 1024 * 1024 },
    );
  } catch {
    issues.push(`${path}.origin.commit is not reachable in successor history`);
  }
}

async function gitPathList(repoRoot, args) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

function validateExactKeys(value, expectedKeys, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return;
  }
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!sameStringArray(actualKeys, expected)) {
    issues.push(`${label} keys must exactly equal ${JSON.stringify(expected)}`);
  }
}

function isSafeScopedPath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || isAbsolute(path)
    || path.includes("\\")
    || normalize(path) !== path
    || posix.normalize(path) !== path
  ) {
    return false;
  }
  return APACHE_PROVENANCE_SCOPES.some((scope) => path.startsWith(`${scope}/`));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringArray(left, right) {
  return (
    Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
  );
}

function relativeLabel(repoRoot, path) {
  const prefix = `${repoRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function resultOf(issues, trackedFileCount, manifestFileCount) {
  return {
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
    trackedFileCount,
    manifestFileCount,
  };
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await checkApacheProvenance();
  process.stdout.write(renderApacheProvenanceReport(result));
  process.exitCode = result.exitCode;
}

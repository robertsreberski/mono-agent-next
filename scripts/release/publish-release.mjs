#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUILD_MARKER_SCHEMA_VERSION,
  acquireBuildLock,
  clearBuildMarker,
  computeBuildOutputDigest,
  computeDeploymentStateFingerprint,
  computeRuntimeDependencyDigest,
  preserveBuildLock,
  publishBuildMarker,
  readBuildMarker,
  releaseBuildLock,
} from "../lib/build-provenance.mjs";
import { assertPublishingAllowed } from "./check-publish-guard.mjs";
import { packReleasePackage } from "./pack-release.mjs";
import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const NULL_CONFIG = "/dev/null";
export const EMPTY_NPM_GLOBAL_CONFIG = path.join(REPO_ROOT, "scripts", "release", "empty.npmrc");
const EMPTY_NPM_GLOBAL_CONFIG_CONTENT = "; Intentionally empty neutral npm global configuration for release subprocesses.\n";
const REGISTRY_AUTH_ENV = "npm_config_//registry.npmjs.org/:_authToken";
const TRUSTED_GIT_CANDIDATES = Object.freeze(["/usr/bin/git", "/bin/git"]);
const CLOSED_GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});

export function assertNeutralNpmGlobalConfig(configPath = EMPTY_NPM_GLOBAL_CONFIG) {
  const configStat = fs.lstatSync(configPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (configStat.isSymbolicLink() || !configStat.isFile() || configStat.nlink !== 1
    || (configStat.mode & 0o022) !== 0
    || (currentUid !== undefined && configStat.uid !== currentUid)
    || fs.readFileSync(configPath, "utf8") !== EMPTY_NPM_GLOBAL_CONFIG_CONTENT) {
    throw new Error("refusing npm subprocess: neutral global npm config is unsafe or modified");
  }
}

function isNpmCredentialKey(key) {
  const normalized = key.toLowerCase();
  if (normalized === "actions_id_token_request_token"
    || normalized === "actions_id_token_request_url"
    || normalized === "node_auth_token"
    || normalized === "npm_auth_token"
    || normalized === "npm_id_token"
    || normalized === "npm_token"
    || normalized === "npm_dev_token"
    || normalized === "sigstore_id_token") {
    return true;
  }
  if (!normalized.startsWith("npm_config_")) return false;
  const configName = normalized.slice("npm_config_".length);
  return [
    "_auth",
    "_authtoken",
    "auth",
    "authtoken",
    "username",
    "_password",
    "password",
    "otp",
    "certfile",
    "keyfile",
    "token",
  ].some((credentialName) => configName === credentialName || configName.endsWith(`:${credentialName}`));
}

function environmentWithoutNpmCredentials(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (isNpmCredentialKey(key)) delete env[key];
  }
  return env;
}

function clearProcessNpmCredentials() {
  for (const key of Object.keys(process.env)) {
    if (isNpmCredentialKey(key)) delete process.env[key];
  }
}

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function commandOutput(result, description) {
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${description} failed${output ? `:\n${output}` : ""}`);
  }
  return (result.stdout || "").trim();
}

/**
 * Give npm an explicit public-registry configuration and discard ambient
 * user/global/scope registry overrides. Authentication remains in-memory.
 */
export function publicNpmEnvironment(source = process.env, options = {}) {
  assertNeutralNpmGlobalConfig();
  const token = source.NODE_AUTH_TOKEN || source.NPM_TOKEN;
  const env = environmentWithoutNpmCredentials(source);
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (normalized === "npm_config_registry"
      || normalized === "npm_config_force"
      || normalized === "npm_config_dry_run"
      || normalized === "npm_config_userconfig"
      || normalized === "npm_config_globalconfig"
      || (normalized.startsWith("npm_config_") && normalized.endsWith(":registry"))) {
      delete env[key];
    }
  }

  env.NPM_CONFIG_REGISTRY = PUBLIC_NPM_REGISTRY;
  env.NPM_CONFIG_USERCONFIG = NULL_CONFIG;
  env.NPM_CONFIG_GLOBALCONFIG = EMPTY_NPM_GLOBAL_CONFIG;
  env["npm_config_@mono-agent:registry"] = PUBLIC_NPM_REGISTRY;
  if (options.authenticated !== false && token) env[REGISTRY_AUTH_ENV] = token;
  return env;
}

function npmConfigArgs() {
  return [
    "--registry",
    PUBLIC_NPM_REGISTRY,
    "--userconfig",
    NULL_CONFIG,
    "--globalconfig",
    EMPTY_NPM_GLOBAL_CONFIG,
  ];
}

function canonicalRepository(repo) {
  const canonical = fs.realpathSync.native(repo);
  if (!path.isAbsolute(canonical) || !fs.statSync(canonical).isDirectory()) {
    throw new Error("refusing to publish: release repository is unavailable or unsafe");
  }
  return canonical;
}

export function resolveTrustedGitExecutable() {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const candidate of TRUSTED_GIT_CANDIDATES) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    try {
      const canonical = fs.realpathSync.native(candidate);
      const stat = fs.statSync(canonical);
      if (path.isAbsolute(canonical)
        && stat.isFile()
        && (stat.mode & 0o111) !== 0
        && (stat.mode & 0o6022) === 0
        && (currentUid === undefined || stat.uid === 0 || stat.uid === currentUid)) {
        return canonical;
      }
    } catch {
      // Try the next fixed system candidate.
    }
  }
  throw new Error("refusing to publish: trusted Git executable is unavailable");
}

function pathIsWithin(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath));
}

export function resolveTrustedPnpmEntrypoint(repo = REPO_ROOT) {
  const canonicalRepo = canonicalRepository(repo);
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDirectory, "pnpm"),
    process.env.npm_execpath,
    typeof process.env.PNPM_HOME === "string"
      ? path.join(process.env.PNPM_HOME, "pnpm")
      : undefined,
  ];
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    try {
      const canonical = fs.realpathSync.native(candidate);
      const stat = fs.statSync(canonical);
      if (/^pnpm(?:\.(?:cjs|mjs|js))?$/u.test(path.basename(canonical))
        && !pathIsWithin(canonicalRepo, canonical)
        && stat.isFile()
        && stat.nlink === 1
        && (stat.mode & 0o111) !== 0
        && (stat.mode & 0o022) === 0
        && (currentUid === undefined || stat.uid === 0 || stat.uid === currentUid)) {
        return canonical;
      }
    } catch {
      // Try the next process-owned package-manager authority.
    }
  }
  throw new Error("refusing to publish: trusted pnpm entrypoint is unavailable");
}

function trustedPnpmCommandDirectories(repo, pnpmEntrypoint) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const candidates = [
    path.dirname(pnpmEntrypoint),
    typeof process.env.npm_execpath === "string"
      ? path.dirname(process.env.npm_execpath)
      : undefined,
    process.env.PNPM_HOME,
  ];
  const directories = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    try {
      const directory = fs.realpathSync.native(candidate);
      const stat = fs.statSync(directory);
      const command = fs.realpathSync.native(path.join(directory, "pnpm"));
      if (command === pnpmEntrypoint
        && !pathIsWithin(repo, directory)
        && stat.isDirectory()
        && (stat.mode & 0o022) === 0
        && (currentUid === undefined || stat.uid === 0 || stat.uid === currentUid)) {
        directories.push(directory);
      }
    } catch {
      // Try the next directory that may expose the validated entrypoint.
    }
  }
  return [...new Set(directories)];
}

function gitResult(args, options) {
  const spawn = options.spawn ?? spawnSync;
  return spawn(options.gitExecutable, ["-C", options.repo, ...args], {
    cwd: options.repo,
    encoding: "utf8",
    env: { ...CLOSED_GIT_ENV },
  });
}

/** Require a clean HEAD whose commit is the exact target of the release tag. */
export function assertReleaseGitState(tag, options = {}) {
  const gitOptions = {
    ...options,
    repo: canonicalRepository(options.repo ?? REPO_ROOT),
    gitExecutable: resolveTrustedGitExecutable(),
  };
  const topLevel = commandOutput(
    gitResult(["rev-parse", "--show-toplevel"], gitOptions),
    "git rev-parse --show-toplevel",
  );
  if (canonicalRepository(topLevel) !== gitOptions.repo) {
    throw new Error("refusing to publish: Git top level does not match the release repository");
  }
  const status = commandOutput(
    gitResult(["status", "--porcelain=v1", "--untracked-files=all"], gitOptions),
    "git status",
  );
  if (status !== "") {
    throw new Error("refusing to publish: git HEAD is not clean");
  }

  const head = commandOutput(
    gitResult(["rev-parse", "HEAD"], gitOptions),
    "git rev-parse HEAD",
  ).toLowerCase();
  let taggedCommit;
  try {
    taggedCommit = commandOutput(
      gitResult(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], gitOptions),
      `git tag ${tag}`,
    ).toLowerCase();
  } catch {
    throw new Error(`refusing to publish: release tag ${tag} does not exist locally`);
  }
  if (taggedCommit !== head) {
    throw new Error(`refusing to publish: release tag ${tag} does not point at HEAD ${head}`);
  }
  return head;
}

/** Require the successful workspace build marker to attest the exact clean HEAD. */
export function assertBuildMarkerForHead(marker, head) {
  if (marker === null || marker === undefined) {
    throw new Error("refusing to publish: build provenance marker is missing or invalid");
  }
  if (marker.gitSha.toLowerCase() !== head.toLowerCase()) {
    throw new Error(
      `refusing to publish: build provenance is for ${marker.gitSha}, expected HEAD ${head}`,
    );
  }
  if (marker.sourceState !== "clean") {
    throw new Error(
      `refusing to publish: build provenance sourceState must be clean; found ${marker.sourceState}`,
    );
  }
}

/** Safely read the marker and prove its output and dependency digests are current. */
export function assertCurrentBuildProvenance(head, options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const readMarker = options.readMarker ?? readBuildMarker;
  const outputDigest = options.computeOutputDigest ?? computeBuildOutputDigest;
  const dependencyDigest = options.computeDependencyDigest ?? computeRuntimeDependencyDigest;
  const before = readMarker(repo);
  if (before.status !== "ok") {
    throw new Error(`refusing to publish: build provenance marker is ${before.status}`);
  }
  assertBuildMarkerForHead(before.marker, head);

  const currentOutputDigest = outputDigest(repo);
  if (currentOutputDigest !== before.marker.outputDigest) {
    throw new Error("refusing to publish: build output digest does not match build provenance");
  }
  const currentDependencyDigest = dependencyDigest(repo);
  if (currentDependencyDigest !== before.marker.dependencyDigest) {
    throw new Error("refusing to publish: dependency digest does not match build provenance");
  }

  const after = readMarker(repo);
  if (after.status !== "ok" || after.fingerprint !== before.fingerprint) {
    throw new Error("refusing to publish: build provenance marker changed during verification");
  }
  assertBuildMarkerForHead(after.marker, head);
}

export function runWorkspaceBuild(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const log = options.log ?? console.log;
  const repo = canonicalRepository(options.repo ?? REPO_ROOT);
  const resolvePnpmEntrypoint = options.resolvePnpmEntrypoint ?? resolveTrustedPnpmEntrypoint;
  const pnpmEntrypoint = resolvePnpmEntrypoint(repo);
  const env = publicNpmEnvironment(
    options.envSource ?? process.env,
    { authenticated: false },
  );
  const nodeDirectory = path.dirname(process.execPath);
  env.PATH = [
    ...new Set([
      nodeDirectory,
      ...trustedPnpmCommandDirectories(repo, pnpmEntrypoint),
    ]),
    "/usr/bin",
    "/bin",
  ].join(path.delimiter);
  log("$ pnpm run build");
  const result = spawn(pnpmEntrypoint, ["run", "build"], {
    cwd: repo,
    env,
    shell: false,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("workspace build failed before release packing");
  }
}

/**
 * Run the real release build under the provenance lock, then publish one
 * schema-v2 marker only after the source and complete deployment state remain
 * stable across attestation.
 */
export function runReleaseBuildWithProvenance(tag, options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const assertGitState = options.assertGitState
    ?? ((releaseTag) => assertReleaseGitState(releaseTag, {
      repo,
      envSource: options.envSource,
    }));
  const runBuild = options.runBuild
    ?? (() => runWorkspaceBuild({
      repo,
      envSource: options.envSource,
      log: options.log,
      spawn: options.spawn,
    }));
  const deploymentFingerprint = options.computeDeploymentFingerprint
    ?? computeDeploymentStateFingerprint;
  const outputDigest = options.computeOutputDigest ?? computeBuildOutputDigest;
  const dependencyDigest = options.computeDependencyDigest ?? computeRuntimeDependencyDigest;
  const acquireLock = options.acquireLock ?? acquireBuildLock;
  const clearMarker = options.clearMarker ?? clearBuildMarker;
  const preserveLock = options.preserveLock ?? preserveBuildLock;
  const publishMarker = options.publishMarker ?? publishBuildMarker;
  const releaseLock = options.releaseLock ?? releaseBuildLock;
  const now = options.now ?? (() => new Date());

  let lock;
  try {
    lock = acquireLock(repo);
  } catch (error) {
    throw new Error("refusing to publish: build provenance lock is unavailable", { cause: error });
  }

  let head;
  let failure;
  let releaseNormally = true;
  try {
    clearMarker(repo);
    head = assertGitState(tag);
    runBuild();
    const builtHead = assertGitState(tag);
    if (builtHead.toLowerCase() !== head.toLowerCase()) {
      throw new Error("refusing to publish: git HEAD changed during the release build");
    }

    const deploymentState = deploymentFingerprint(repo);
    const currentOutputDigest = outputDigest(repo, { sync: true });
    const currentDependencyDigest = dependencyDigest(repo);
    options.afterDeploymentDigests?.();

    const attestedHead = assertGitState(tag);
    if (attestedHead.toLowerCase() !== head.toLowerCase()) {
      throw new Error("refusing to publish: git HEAD changed during build attestation");
    }
    if (deploymentFingerprint(repo) !== deploymentState) {
      throw new Error("refusing to publish: deployment state changed during build attestation");
    }

    const marker = {
      schemaVersion: BUILD_MARKER_SCHEMA_VERSION,
      gitSha: head,
      completedAt: now().toISOString(),
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules,
      sourceState: "clean",
      outputDigest: currentOutputDigest,
      dependencyDigest: currentDependencyDigest,
    };
    publishMarker(repo, marker);

    const publishedHead = assertGitState(tag);
    if (publishedHead.toLowerCase() !== head.toLowerCase()) {
      throw new Error("refusing to publish: git HEAD changed during build provenance publication");
    }
    if (deploymentFingerprint(repo) !== deploymentState) {
      throw new Error("refusing to publish: deployment state changed during build provenance publication");
    }
  } catch (error) {
    failure = error;
    try {
      clearMarker(repo);
    } catch (cleanupError) {
      releaseNormally = false;
      failure = new Error("refusing to publish: failed to invalidate build provenance", {
        cause: new AggregateError([error, cleanupError]),
      });
      try {
        preserveLock(repo, lock);
      } catch (preserveError) {
        failure = new Error("refusing to publish: failed to preserve the build provenance lock", {
          cause: new AggregateError([error, cleanupError, preserveError]),
        });
      }
    }
  }

  if (!releaseNormally) throw failure;
  try {
    releaseLock(repo, lock);
  } catch (error) {
    let releaseFailure = new Error(
      "refusing to publish: build provenance lock cleanup failed",
      { cause: error },
    );
    try {
      clearMarker(repo);
    } catch (cleanupError) {
      try {
        preserveLock(repo, lock);
        releaseFailure = new Error(
          "refusing to publish: build provenance lock cleanup failed; marker invalidation failed closed",
          { cause: new AggregateError([error, cleanupError]) },
        );
      } catch (preserveError) {
        releaseFailure = new Error(
          "refusing to publish: build provenance lock and marker cleanup failed",
          { cause: new AggregateError([error, cleanupError, preserveError]) },
        );
      }
    }
    throw releaseFailure;
  }
  if (failure !== undefined) throw failure;
  return head;
}

export function computeTarballIntegrity(tarballPath) {
  return `sha512-${createHash("sha512").update(fs.readFileSync(tarballPath)).digest("base64")}`;
}

/** Pack the complete dependency-ordered release into one immutable tarball set. */
export function freezeReleaseTarballs(packages, packDestination, options = {}) {
  const pack = options.pack ?? packReleasePackage;
  const log = options.log ?? console.log;
  const packSpawn = options.packOptions?.spawn ?? options.spawn ?? spawnSync;
  const packOptions = {
    ...options.packOptions,
    log: options.packOptions?.log ?? log,
    spawn: (command, args, spawnOptions) => packSpawn(
      command,
      args,
      {
        ...spawnOptions,
        env: publicNpmEnvironment(
          spawnOptions.env ?? options.envSource ?? process.env,
          { authenticated: false },
        ),
      },
    ),
  };
  const frozen = packages.map((pkg) => {
    const details = pack(pkg, packDestination, packOptions);
    if (details.name !== pkg.name || details.version !== pkg.version) {
      throw new Error(
        `${pkg.name}@${pkg.version} pack identity mismatch: received ${details.name}@${details.version}`,
      );
    }
    const integrity = computeTarballIntegrity(details.tarballPath);
    fs.chmodSync(details.tarballPath, 0o444);
    log(`${pkg.name}@${pkg.version}: frozen ${integrity}`);
    return Object.freeze({
      ...pkg,
      tarballPath: details.tarballPath,
      integrity,
    });
  });
  return Object.freeze(frozen);
}

export function stagingDistTagForRelease(tag) {
  return `mono-agent-stage-${tag.slice(1).replace(/[^0-9A-Za-z]+/gu, "-")}`;
}

function validateDistTag(tag, description) {
  if (!/^[A-Za-z][0-9A-Za-z._-]*$/u.test(tag)) {
    throw new Error(`${description} must be a safe npm dist-tag; received ${tag || "(missing)"}`);
  }
}

function registryIntegrityOf(pkg) {
  const result = spawnSync(
    "npm",
    [
      "view",
      `${pkg.name}@${pkg.version}`,
      "dist.integrity",
      "--json",
      ...npmConfigArgs(),
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: publicNpmEnvironment(process.env, { authenticated: false }),
    },
  );
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (output.includes("E404")
      || output.includes("404 Not Found")
      || output.includes("could not be found")) {
      return null;
    }
    throw new Error(`npm view failed for ${pkg.name}@${pkg.version}:\n${output.trim()}`);
  }

  const output = (result.stdout || "").trim();
  if (output === "") return null;
  let integrity;
  try {
    integrity = JSON.parse(output);
  } catch {
    throw new Error(`npm returned invalid integrity metadata for ${pkg.name}@${pkg.version}`);
  }
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`npm returned missing integrity metadata for ${pkg.name}@${pkg.version}`);
  }
  return integrity;
}

function assertMatchingIntegrity(pkg, publishedIntegrity) {
  if (publishedIntegrity !== pkg.integrity) {
    throw new Error(
      `refusing to publish: ${pkg.name}@${pkg.version} exists with integrity `
      + `${publishedIntegrity}, but the frozen tarball is ${pkg.integrity}`,
    );
  }
}

export function publishFrozenTarball(pkg, {
  distTag,
  dryRun,
  npmEnvSource = process.env,
  spawn = spawnSync,
}) {
  const currentIntegrity = computeTarballIntegrity(pkg.tarballPath);
  if (currentIntegrity !== pkg.integrity) {
    throw new Error(`refusing to publish: frozen tarball changed for ${pkg.name}@${pkg.version}`);
  }
  const args = [
    "publish",
    pkg.tarballPath,
    "--access",
    pkg.publishConfig.access,
    "--tag",
    distTag,
    ...npmConfigArgs(),
  ];
  // npm 11 checks the public registry even for --dry-run and otherwise rejects
  // an already-published immutable version. --force suppresses only that local
  // dry-run guard; this branch receives no registry credential or npm config
  // file and remains non-mutating. A real publish never receives --force.
  if (dryRun) args.push("--dry-run", "--force");
  console.log(`$ npm publish ${path.basename(pkg.tarballPath)} --access ${pkg.publishConfig.access} --tag ${distTag}${dryRun ? " --dry-run --force" : ""}`);
  const result = spawn("npm", args, {
    // Publishing the absolute frozen tarball from its private temporary
    // directory prevents a repository-local .npmrc from contributing auth.
    cwd: path.dirname(pkg.tarballPath),
    env: publicNpmEnvironment(npmEnvSource, { authenticated: !dryRun }),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`npm publish failed for ${pkg.name}@${pkg.version}`);
  }
}

async function waitForPublishedIntegrity(pkg, options = {}) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 5_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const integrity = registryIntegrityOf(pkg);
    if (integrity !== null) return integrity;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `${pkg.name}@${pkg.version} did not become visible on ${PUBLIC_NPM_REGISTRY}`,
  );
}

function promoteDistTag(pkg, distTag, options = {}) {
  const args = [
    "dist-tag",
    "add",
    `${pkg.name}@${pkg.version}`,
    distTag,
    ...npmConfigArgs(),
  ];
  console.log(`$ npm dist-tag add ${pkg.name}@${pkg.version} ${distTag}`);
  const result = spawnSync("npm", args, {
    cwd: REPO_ROOT,
    env: publicNpmEnvironment(options.npmEnvSource ?? process.env),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`npm dist-tag promotion failed for ${pkg.name}@${pkg.version}`);
  }
}

/**
 * Execute a frozen publish in four ordered phases: inspect immutable versions,
 * stage missing versions, verify the complete set, then promote the final tag.
 */
export async function executeFrozenPublish({
  frozenPackages,
  dryRun,
  stagingTag,
  finalDistTag,
  readIntegrity = registryIntegrityOf,
  publishTarball = publishFrozenTarball,
  waitForIntegrity = waitForPublishedIntegrity,
  promote = promoteDistTag,
  log = console.log,
  npmEnvSource,
}) {
  if (dryRun) {
    for (const pkg of frozenPackages) {
      await publishTarball(pkg, {
        distTag: stagingTag,
        dryRun: true,
        ...(npmEnvSource === undefined ? {} : { npmEnvSource }),
      });
    }
    log(`Dry run complete; ${finalDistTag} was not promoted.`);
    return;
  }

  const missing = [];
  for (const pkg of frozenPackages) {
    const publishedIntegrity = await readIntegrity(pkg);
    if (publishedIntegrity === null) {
      missing.push(pkg);
      continue;
    }
    assertMatchingIntegrity(pkg, publishedIntegrity);
    log(`${pkg.name}@${pkg.version} already exists with matching integrity; skipping publish.`);
  }

  for (const pkg of missing) {
    await publishTarball(pkg, {
      distTag: stagingTag,
      dryRun: false,
      ...(npmEnvSource === undefined ? {} : { npmEnvSource }),
    });
  }

  for (const pkg of frozenPackages) {
    const publishedIntegrity = await waitForIntegrity(pkg);
    assertMatchingIntegrity(pkg, publishedIntegrity);
    log(`${pkg.name}@${pkg.version} verified at ${pkg.integrity}.`);
  }

  // No final dist-tag changes occur until every immutable version verifies.
  for (const pkg of frozenPackages) {
    await promote(
      pkg,
      finalDistTag,
      npmEnvSource === undefined ? {} : { npmEnvSource },
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = hasArg("--dry-run", argv);
  if (!dryRun) assertPublishingAllowed();
  const explicitTag = argValue("--tag", argv);
  if (!dryRun && explicitTag === null) {
    throw new Error("--tag is required for a real publish");
  }
  const tag = explicitTag || process.env.GITHUB_REF_NAME;
  const finalDistTag = argValue("--dist-tag", argv) || "latest";
  const { publishablePackages } = validateRelease({ tag, silent: true });
  const stagingTag = stagingDistTagForRelease(tag);
  validateDistTag(finalDistTag, "final dist-tag");
  validateDistTag(stagingTag, "staging dist-tag");
  if (finalDistTag === stagingTag) {
    throw new Error("final dist-tag must differ from the staging dist-tag");
  }

  const publishToken = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (!dryRun && !publishToken) {
    throw new Error("NODE_AUTH_TOKEN or NPM_TOKEN is required to publish");
  }
  // Keep the credential only in a narrow source object passed to npm mutation
  // children. Git, builds, pack lifecycles, and registry reads see no token.
  const npmEnvSource = {
    ...environmentWithoutNpmCredentials(process.env),
    ...(publishToken ? { NODE_AUTH_TOKEN: publishToken } : {}),
  };
  clearProcessNpmCredentials();

  let head;
  if (!dryRun) head = assertReleaseGitState(tag);
  if (dryRun) {
    runWorkspaceBuild();
  } else {
    head = runReleaseBuildWithProvenance(tag);
  }
  if (!dryRun) {
    head = assertReleaseGitState(tag);
    assertCurrentBuildProvenance(head);
  }

  const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-publish-"));
  try {
    const frozenPackages = freezeReleaseTarballs(publishablePackages, packDestination);
    if (!dryRun) {
      head = assertReleaseGitState(tag);
      assertCurrentBuildProvenance(head);
    }
    await executeFrozenPublish({
      frozenPackages,
      dryRun,
      stagingTag,
      finalDistTag,
      npmEnvSource,
    });
  } finally {
    fs.rmSync(packDestination, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

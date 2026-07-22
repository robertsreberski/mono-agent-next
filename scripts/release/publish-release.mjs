#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  computeBuildOutputDigest,
  computeRuntimeDependencyDigest,
  readBuildMarker,
} from "../lib/build-provenance.mjs";
import { assertPublishingAllowed } from "./check-publish-guard.mjs";
import { packReleasePackage } from "./pack-release.mjs";
import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const NULL_CONFIG = "/dev/null";
const REGISTRY_AUTH_ENV = "npm_config_//registry.npmjs.org/:_authToken";

function isNpmCredentialKey(key) {
  const normalized = key.toLowerCase();
  return normalized === "node_auth_token"
    || normalized === "npm_token"
    || normalized === "npm_dev_token"
    || (normalized.startsWith("npm_config_") && normalized.endsWith(":_authtoken"));
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
  const token = source.NODE_AUTH_TOKEN || source.NPM_TOKEN;
  const env = environmentWithoutNpmCredentials(source);
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (normalized === "npm_config_registry"
      || normalized === "npm_config_userconfig"
      || normalized === "npm_config_globalconfig"
      || (normalized.startsWith("npm_config_") && normalized.endsWith(":registry"))) {
      delete env[key];
    }
  }

  env.NPM_CONFIG_REGISTRY = PUBLIC_NPM_REGISTRY;
  env.NPM_CONFIG_USERCONFIG = NULL_CONFIG;
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
  ];
}

function gitResult(args, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  return spawn("git", args, {
    cwd: options.repo ?? REPO_ROOT,
    encoding: "utf8",
    env: {
      ...environmentWithoutNpmCredentials(options.envSource ?? process.env),
      LANG: "C",
      LC_ALL: "C",
    },
  });
}

/** Require a clean HEAD whose commit is the exact target of the release tag. */
export function assertReleaseGitState(tag, options = {}) {
  const status = commandOutput(
    gitResult(["status", "--porcelain=v1", "--untracked-files=all"], options),
    "git status",
  );
  if (status !== "") {
    throw new Error("refusing to publish: git HEAD is not clean");
  }

  const head = commandOutput(gitResult(["rev-parse", "HEAD"], options), "git rev-parse HEAD").toLowerCase();
  let taggedCommit;
  try {
    taggedCommit = commandOutput(
      gitResult(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], options),
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
  log("$ pnpm run build");
  const result = spawn("pnpm", ["run", "build"], {
    cwd: options.repo ?? REPO_ROOT,
    env: publicNpmEnvironment(
      options.envSource ?? process.env,
      { authenticated: false },
    ),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("workspace build failed before release packing");
  }
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

function publishFrozenTarball(pkg, { distTag, dryRun, npmEnvSource = process.env }) {
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
  if (dryRun) args.push("--dry-run");
  console.log(`$ npm publish ${path.basename(pkg.tarballPath)} --access ${pkg.publishConfig.access} --tag ${distTag}${dryRun ? " --dry-run" : ""}`);
  const result = spawnSync("npm", args, {
    cwd: REPO_ROOT,
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
  runWorkspaceBuild();
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

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MINIMUM_NODE_VERSION, SUPPORTED_NODE_ENGINE } from "../node-version.mjs";
import { assertPackedDependencyResolution } from "./dependency-policy.mjs";
import { packReleasePackage } from "./pack-release.mjs";
import { DEPENDENCY_SECTIONS, REPO_ROOT } from "./package-graph.mjs";
import { RELEASE_REPOSITORY, validateRelease } from "./validate-release.mjs";

const CONSUMER_FIXTURE = path.join(REPO_ROOT, "scripts", "release", "fixtures", "packed-consumer");

export function parsePackedConsumerArgs(argv) {
  let tag = process.env.GITHUB_REF_NAME ?? null;
  let requireMinimum = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--tag requires a value.");
      }
      tag = value;
      index += 1;
      continue;
    }
    if (arg === "--require-minimum") {
      requireMinimum = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { tag, requireMinimum };
}

export function assertMinimumNodeRuntime(actual = process.versions.node) {
  if (actual !== MINIMUM_NODE_VERSION) {
    throw new Error(
      `Minimum-version proof must run on Node.js ${MINIMUM_NODE_VERSION}; current Node.js is ${actual}.`,
    );
  }
}

export function buildPackedConsumerManifest(template, packedPackages) {
  if (template.engines?.node !== SUPPORTED_NODE_ENGINE) {
    throw new Error(`Packed consumer template engines.node must be ${SUPPORTED_NODE_ENGINE}.`);
  }
  return {
    ...template,
    dependencies: Object.fromEntries(
      [...packedPackages]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((pkg) => [pkg.name, `file:${pkg.tarballPath}`]),
    ),
  };
}

export function buildIsolatedConsumerManifest(template, targetPackage, packedPackages) {
  if (template.engines?.node !== SUPPORTED_NODE_ENGINE) {
    throw new Error(`Packed consumer template engines.node must be ${SUPPORTED_NODE_ENGINE}.`);
  }
  const packedByName = new Map(packedPackages.map((pkg) => [pkg.name, pkg]));
  if (!packedByName.has(targetPackage.name)) {
    throw new Error(`Packed tarball missing for isolated target ${targetPackage.name}.`);
  }

  return {
    ...template,
    name: `mono-agent-packed-isolated-${targetPackage.name.replace(/[^0-9A-Za-z]+/gu, "-")}`,
    dependencies: {
      [targetPackage.name]: `file:${packedByName.get(targetPackage.name).tarballPath}`,
    },
    // An override does not install a package by itself. It only ensures every
    // declared internal edge at any depth resolves to this frozen tarball set,
    // while an undeclared edge remains absent from the isolated consumer.
    overrides: Object.fromEntries(
      packedPackages
        .filter((pkg) => pkg.name !== targetPackage.name)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((pkg) => [pkg.name, `file:${pkg.tarballPath}`]),
    ),
  };
}

export function declaredInternalPackageNames(packedManifest, packedPackages) {
  const packedNames = new Set(packedPackages.map((pkg) => pkg.name));
  const declared = new Set();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const name of Object.keys(packedManifest[section] ?? {})) {
      if (packedNames.has(name)) declared.add(name);
    }
  }
  return [...declared].sort((a, b) => a.localeCompare(b));
}

export function declaredInternalPackageClosure(targetName, packedManifestsByName) {
  if (!packedManifestsByName.has(targetName)) {
    throw new Error(`Packed manifest missing for isolated target ${targetName}.`);
  }
  const packedPackages = [...packedManifestsByName.keys()].map((name) => ({ name }));
  const reachable = new Set([targetName]);
  const pending = [targetName];

  while (pending.length > 0) {
    const name = pending.pop();
    const manifest = packedManifestsByName.get(name);
    for (const dependencyName of declaredInternalPackageNames(manifest, packedPackages)) {
      if (reachable.has(dependencyName)) continue;
      reachable.add(dependencyName);
      pending.push(dependencyName);
    }
  }

  return [...reachable].sort((a, b) => a.localeCompare(b));
}

export function assertPackedReleaseMetadata(pkg, packedManifest) {
  if (packedManifest.name !== pkg.name || packedManifest.version !== pkg.version) {
    throw new Error(
      `Packed ${pkg.name} manifest identity must be ${pkg.name}@${pkg.version}; `
      + `found ${packedManifest.name ?? "(missing)"}@${packedManifest.version ?? "(missing)"}.`,
    );
  }
  const repository = packedManifest.repository;
  if (repository?.type !== RELEASE_REPOSITORY.type
    || repository?.url !== RELEASE_REPOSITORY.url
    || repository?.directory !== pkg.relativeDir) {
    throw new Error(
      `Packed ${pkg.name} repository must be ${RELEASE_REPOSITORY.type} `
      + `${RELEASE_REPOSITORY.url} at ${pkg.relativeDir}.`,
    );
  }
}

export function assertIsolatedInstallLayout(consumerDir, targetName, reachableNames, allPackageNames) {
  const reachable = new Set(reachableNames);
  const targetManifest = readInstalledManifest(consumerDir, targetName);
  if (targetManifest.name !== targetName) {
    throw new Error(`Isolated ${targetName} consumer installed ${targetManifest.name ?? "(missing name)"} at its target path.`);
  }
  const installedPaths = installedInternalPackagePaths(consumerDir, allPackageNames);

  for (const name of allPackageNames) {
    const locations = installedPaths.get(name) ?? [];
    if (!reachable.has(name) && locations.length > 0) {
      throw new Error(`Isolated ${targetName} consumer exposed undeclared internal package ${name}.`);
    }
    if (reachable.has(name) && locations.length === 0) {
      throw new Error(`Isolated ${targetName} consumer did not install declared internal package ${name}.`);
    }
  }
}

export function runPackedConsumerVerification(options = {}) {
  const parsed = options.parsed ?? parsePackedConsumerArgs(process.argv.slice(2));
  if (parsed.requireMinimum) assertMinimumNodeRuntime();

  const { publishablePackages, version } = validateRelease({ tag: parsed.tag, silent: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-packed-consumer-"));
  const tarballDir = path.join(temporaryRoot, "tarballs");
  const consumerDir = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(tarballDir);
  fs.cpSync(CONSUMER_FIXTURE, consumerDir, { recursive: true });

  try {
    const packedPackages = publishablePackages.map((pkg) =>
      packReleasePackage(pkg, tarballDir, options.packOptions));
    const templatePath = path.join(consumerDir, "package.json");
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const consumerManifest = buildPackedConsumerManifest(template, packedPackages);
    fs.writeFileSync(templatePath, `${JSON.stringify(consumerManifest, null, 2)}\n`);

    run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false"], consumerDir, options.spawn);
    assertPackedDependencyResolution(consumerDir, publishablePackages);
    for (const pkg of publishablePackages) {
      assertPackedReleaseMetadata(pkg, readInstalledManifest(consumerDir, pkg.name));
    }
    run("npm", ["run", "smoke"], consumerDir, options.spawn);
    runIsolatedPackedConsumers({
      packedPackages,
      publishablePackages,
      combinedConsumerDir: consumerDir,
      temporaryRoot,
      spawn: options.spawn,
    });
    console.log(
      `Packed consumer installed and isolated ${packedPackages.length} mono-agent ${version} tarballs on Node.js ${process.versions.node}.`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function runIsolatedPackedConsumers({
  packedPackages,
  publishablePackages,
  combinedConsumerDir,
  temporaryRoot,
  spawn,
}) {
  const template = JSON.parse(fs.readFileSync(path.join(CONSUMER_FIXTURE, "package.json"), "utf8"));
  const allPackageNames = packedPackages.map((pkg) => pkg.name);
  const packedManifestsByName = new Map(
    publishablePackages.map((pkg) => [pkg.name, readInstalledManifest(combinedConsumerDir, pkg.name)]),
  );
  const isolatedRoot = path.join(temporaryRoot, "isolated");
  fs.mkdirSync(isolatedRoot);

  for (const pkg of publishablePackages) {
    const isolatedDir = path.join(isolatedRoot, pkg.name.replace(/[^0-9A-Za-z]+/gu, "-"));
    fs.cpSync(CONSUMER_FIXTURE, isolatedDir, { recursive: true });
    const isolatedManifest = buildIsolatedConsumerManifest(
      template,
      pkg,
      packedPackages,
    );
    fs.writeFileSync(
      path.join(isolatedDir, "package.json"),
      `${JSON.stringify(isolatedManifest, null, 2)}\n`,
    );
    const reachableNames = declaredInternalPackageClosure(pkg.name, packedManifestsByName);
    run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false"], isolatedDir, spawn);
    assertIsolatedInstallLayout(isolatedDir, pkg.name, reachableNames, allPackageNames);
    run("npm", ["run", "smoke", "--", "--target", pkg.name], isolatedDir, spawn);
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
}

function installedPackageManifestPath(consumerDir, name) {
  return path.join(consumerDir, "node_modules", ...name.split("/"), "package.json");
}

function readInstalledManifest(consumerDir, name) {
  return JSON.parse(fs.readFileSync(installedPackageManifestPath(consumerDir, name), "utf8"));
}

function installedInternalPackagePaths(consumerDir, packageNames) {
  const found = new Map(packageNames.map((name) => [name, []]));
  const pending = [path.join(consumerDir, "node_modules")];
  const visited = new Set();

  while (pending.length > 0) {
    const modulesDir = pending.pop();
    if (visited.has(modulesDir) || !fs.existsSync(modulesDir)) continue;
    visited.add(modulesDir);

    for (const name of packageNames) {
      const manifestPath = path.join(modulesDir, ...name.split("/"), "package.json");
      if (fs.existsSync(manifestPath)) found.get(name).push(manifestPath);
    }

    for (const packageDir of installedPackageDirectories(modulesDir)) {
      const nestedModules = path.join(packageDir, "node_modules");
      if (fs.existsSync(nestedModules)) pending.push(nestedModules);
    }
  }

  return found;
}

function installedPackageDirectories(modulesDir) {
  const directories = [];
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const entryPath = path.join(modulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) directories.push(path.join(entryPath, scopedEntry.name));
      }
    } else {
      directories.push(entryPath);
    }
  }
  return directories;
}

function run(command, args, cwd, spawn = spawnSync) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawn(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_engine_strict: "true",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_USERCONFIG: "/dev/null",
      "npm_config_@mono-agent:registry": "https://registry.npmjs.org/",
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    runPackedConsumerVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.exitCode || 1;
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageCatalog, packageRelativePath } from "../package-catalog.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function packageRecord(catalogEntry) {
  const relativeDir = packageRelativePath(catalogEntry);
  const dir = path.join(REPO_ROOT, relativeDir);
  const manifestPath = path.join(dir, "package.json");
  const packageJson = readJson(manifestPath);

  return {
    dir,
    relativeDir,
    manifestPath,
    location: "workspace",
    catalogEntry,
    name: packageJson.name,
    version: packageJson.version,
    private: Boolean(packageJson.private),
    publishConfig: packageJson.publishConfig || null,
    packageJson,
  };
}

export function discoverPackages({ catalog = packageCatalog } = {}) {
  return catalog.map(packageRecord);
}

export function publishablePackages(packages = discoverPackages()) {
  const names = new Set();
  const publishable = packages.filter((pkg) => pkg.catalogEntry.publishable === true);

  for (const pkg of publishable) {
    if (names.has(pkg.name)) {
      throw new Error(`duplicate publishable package name: ${pkg.name}`);
    }
    names.add(pkg.name);
  }

  return publishable;
}

export function internalDependencies(pkg, packagesByName) {
  const deps = [];

  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(pkg.packageJson[section] || {})) {
      if (packagesByName.has(name)) {
        deps.push({ section, name, range, package: packagesByName.get(name) });
      }
    }
  }

  return deps;
}

export function sortForPublish(packages) {
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const sorted = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`cycle in publishable package dependencies at ${pkg.name}`);
    }

    visiting.add(pkg.name);
    for (const dep of internalDependencies(pkg, packagesByName)) {
      visit(dep.package);
    }
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    sorted.push(pkg);
  }

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(pkg);
  }

  return sorted;
}

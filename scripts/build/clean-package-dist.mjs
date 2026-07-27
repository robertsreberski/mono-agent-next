#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import {
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  packageCatalog,
  packageRelativePath,
} from "../lib/package-catalog.mjs";

const DEFAULT_REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEFAULT_PACKAGE_PATHS = new Set(
  packageCatalog.map((entry) => packageRelativePath(entry)),
);

export function cleanPackageDist(options = {}) {
  const repositoryRoot = realpathSync(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
  );
  const packageDirectory = realpathSync(
    options.packageDirectory ?? process.cwd(),
  );
  const packagePaths = options.packagePaths ?? DEFAULT_PACKAGE_PATHS;
  const packagePath = portableRelative(repositoryRoot, packageDirectory);

  if (
    packagePath === ""
    || packagePath === ".."
    || packagePath.startsWith("../")
    || !packagePaths.has(packagePath)
  ) {
    throw new Error("Build cleanup must run from a cataloged package directory.");
  }

  const expectedPackageDirectory = resolve(repositoryRoot, packagePath);
  if (expectedPackageDirectory !== packageDirectory) {
    throw new Error("Build cleanup package identity is unresolved.");
  }

  const packageIdentity = lstatSync(packageDirectory, { bigint: true });
  if (!packageIdentity.isDirectory() || packageIdentity.isSymbolicLink()) {
    throw new Error("Build cleanup package root must be a real directory.");
  }

  const target = join(packageDirectory, "dist");
  if (portableRelative(packageDirectory, target) !== "dist") {
    throw new Error("Build cleanup target escaped its package directory.");
  }

  let targetIdentity;
  try {
    targetIdentity = lstatSync(target, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (!targetIdentity.isDirectory() || targetIdentity.isSymbolicLink()) {
    throw new Error("Build cleanup target must be a real directory.");
  }

  assertSameDirectory(packageDirectory, packageIdentity);
  rmSync(target, { recursive: true, force: false, maxRetries: 0 });
  assertSameDirectory(packageDirectory, packageIdentity);
  return true;
}

function assertSameDirectory(path, expected) {
  const actual = lstatSync(path, { bigint: true });
  if (
    !actual.isDirectory()
    || actual.isSymbolicLink()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("Build cleanup package root changed identity.");
  }
}

function portableRelative(parent, child) {
  return relative(parent, child).split(sep).join("/");
}

function hasCode(error, code) {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}

if (
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Usage: node scripts/build/clean-package-dist.mjs");
    }
    cleanPackageDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

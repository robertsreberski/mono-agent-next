#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  packageCatalog,
  packageRelativePath,
} from "./package-catalog.mjs";

/**
 * Return every importable export in the cataloged publishable package roster.
 * Wildcards are rejected rather than skipped: a wildcard would let a missing or
 * accidentally exposed deep path hide behind a passing root import.
 *
 * @param {string} repoRoot
 * @param {{
 *   catalog?: readonly Record<string, unknown>[],
 *   readFile?: typeof readFileSync,
 * }} [options]
 * @returns {Array<{
 *   packageName: string,
 *   packageDirectory: string,
 *   manifestPath: string,
 *   key: string,
 *   specifier: string,
 *   defaultTarget: string,
 *   typesTarget: string|null,
 *   json: boolean,
 * }>}
 */
export function mappedEntries(
  repoRoot,
  {
    catalog = packageCatalog,
    readFile = readFileSync,
  } = {},
) {
  const entries = [];
  const names = new Set();
  const publishable = catalog.filter((entry) => entry.publishable === true);
  if (publishable.length === 0) {
    throw new Error("publishable package roster is empty");
  }

  for (const catalogEntry of publishable) {
    const relativeDirectory = packageRelativePath(catalogEntry);
    if (
      !(relativeDirectory.startsWith("packages/") || relativeDirectory.startsWith("extras/"))
    ) {
      throw new Error(
        `${String(catalogEntry.name)} publishable path must be under packages/ or extras/`,
      );
    }
    const packageDirectory = resolve(repoRoot, relativeDirectory);
    const manifestPath = resolve(packageDirectory, "package.json");
    const manifest = JSON.parse(readFile(manifestPath, "utf8"));
    if (manifest.name !== catalogEntry.name) {
      throw new Error(
        `${relativeDirectory}/package.json name must be ${String(catalogEntry.name)}; found ${String(manifest.name)}`,
      );
    }
    if (names.has(manifest.name)) {
      throw new Error(`duplicate publishable package name: ${manifest.name}`);
    }
    names.add(manifest.name);

    const packageEntries = manifestExportEntries({
      manifest,
      packageDirectory,
      manifestPath,
    });
    if (packageEntries.length === 0) {
      throw new Error(`${manifest.name} has no importable public export`);
    }
    entries.push(...packageEntries);
  }

  return entries;
}

/**
 * Verify every declared ESM default/import target loads and every declared
 * `types` target exists.
 *
 * @param {{
 *   repoRoot?: string,
 *   catalog?: readonly Record<string, unknown>[],
 *   readFile?: typeof readFileSync,
 *   importFn?: (
 *     specifier: string,
 *     entry: ReturnType<typeof mappedEntries>[number],
 *   ) => Promise<unknown>,
 *   fileExists?: (path: string) => boolean,
 *   stdout?: {write: (text: string) => unknown},
 *   stderr?: {write: (text: string) => unknown},
 * }} [options]
 */
export async function runVerifyDeepImports({
  repoRoot = defaultRepoRoot(),
  catalog = packageCatalog,
  readFile = readFileSync,
  importFn = realImporter,
  fileExists = existsSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let entries;
  try {
    entries = mappedEntries(repoRoot, { catalog, readFile });
  } catch (error) {
    stderr.write(`FAIL could not map publishable exports: ${reasonOf(error)}\n`);
    return { exitCode: 1, results: [] };
  }

  const results = [];
  for (const entry of entries) {
    let defaultOk = true;
    let defaultError;
    try {
      await importFn(entry.specifier, entry);
      stdout.write(`PASS ${entry.specifier} (default)\n`);
    } catch (error) {
      defaultOk = false;
      defaultError = reasonOf(error);
      stdout.write(`FAIL ${entry.specifier} (default): ${defaultError}\n`);
    }

    let typesOk = true;
    let typesError;
    if (entry.typesTarget !== null) {
      if (fileExists(entry.typesTarget)) {
        stdout.write(`PASS ${entry.specifier} (types)\n`);
      } else {
        typesOk = false;
        typesError = `declared types target missing on disk: ${entry.typesTarget}`;
        stdout.write(`FAIL ${entry.specifier} (types): ${typesError}\n`);
      }
    }

    results.push({
      packageName: entry.packageName,
      key: entry.key,
      specifier: entry.specifier,
      ok: defaultOk && typesOk,
      ...(defaultOk ? {} : { defaultError }),
      ...(typesOk ? {} : { typesError }),
    });
  }

  const failures = results.filter((result) => !result.ok);
  const packageCount = new Set(results.map((result) => result.packageName)).size;
  if (failures.length > 0) {
    stdout.write(
      `built-exports fail (${String(failures.length)}/${String(results.length)} exports unresolved across ${String(packageCount)} packages)\n`,
    );
    return { exitCode: 1, results };
  }
  stdout.write(
    `built-exports ok (${String(packageCount)} packages, ${String(results.length)} exports; default + declared types)\n`,
  );
  return { exitCode: 0, results };
}

async function realImporter(_specifier, entry) {
  const resolvedUrl = pathToFileURL(entry.defaultTarget).href;
  return entry.json
    ? import(resolvedUrl, { with: { type: "json" } })
    : import(resolvedUrl);
}

function manifestExportEntries({
  manifest,
  packageDirectory,
  manifestPath,
}) {
  const exportsField = manifest.exports;
  let exportsEntries;
  if (exportsField === undefined) {
    if (typeof manifest.main !== "string") return [];
    exportsEntries = [[".", manifest.main]];
  } else if (isSubpathMap(exportsField)) {
    exportsEntries = Object.entries(exportsField);
  } else {
    exportsEntries = [[".", exportsField]];
  }

  return exportsEntries.map(([key, target]) => {
    if (typeof key !== "string" || (key !== "." && !key.startsWith("./"))) {
      throw new Error(`${manifest.name} exports contains invalid subpath key ${String(key)}`);
    }
    if (containsWildcard(key) || targetContainsWildcard(target)) {
      throw new Error(`${manifest.name} export ${key} must not use wildcard mappings`);
    }
    const runtimeTarget = runtimeTargetOf(target);
    if (runtimeTarget === null) {
      throw new Error(`${manifest.name} export ${key} has no ESM default/import target`);
    }
    const declaredTypes = typesTargetOf(target)
      ?? (key === "." && typeof manifest.types === "string" ? manifest.types : null);
    const defaultTarget = resolvePackageTarget(
      packageDirectory,
      runtimeTarget,
      `${manifest.name} export ${key}`,
    );
    const typesTarget = declaredTypes === null
      ? null
      : resolvePackageTarget(
        packageDirectory,
        declaredTypes,
        `${manifest.name} export ${key} types`,
      );
    const specifier = key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
    return {
      packageName: manifest.name,
      packageDirectory,
      manifestPath,
      key,
      specifier,
      defaultTarget,
      typesTarget,
      json: runtimeTarget.endsWith(".json"),
    };
  });
}

function isSubpathMap(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length > 0 && subpathKeys.length !== keys.length) {
    throw new Error("exports must not mix subpath keys and condition keys");
  }
  return subpathKeys.length > 0;
}

function runtimeTargetOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = runtimeTargetOf(candidate);
      if (target !== null) return target;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const condition of ["import", "node", "default"]) {
    if (!Object.hasOwn(value, condition)) continue;
    const target = runtimeTargetOf(value[condition]);
    if (target !== null) return target;
  }
  return null;
}

function typesTargetOf(value) {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = typesTargetOf(candidate);
      if (target !== null) return target;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.types === "string") return value.types;
  for (const [condition, candidate] of Object.entries(value)) {
    if (condition === "types") continue;
    const target = typesTargetOf(candidate);
    if (target !== null) return target;
  }
  return null;
}

function targetContainsWildcard(value) {
  if (typeof value === "string") return containsWildcard(value);
  if (Array.isArray(value)) return value.some(targetContainsWildcard);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, target]) => containsWildcard(key) || targetContainsWildcard(target),
  );
}

function containsWildcard(value) {
  return value.includes("*");
}

function resolvePackageTarget(packageDirectory, target, label) {
  if (isAbsolute(target) || !target.startsWith("./")) {
    throw new Error(`${label} target must be package-relative; found ${target}`);
  }
  const resolved = resolve(packageDirectory, target);
  const fromPackage = relative(packageDirectory, resolved);
  if (
    fromPackage === ".."
    || fromPackage.startsWith(`..${sep}`)
    || isAbsolute(fromPackage)
  ) {
    throw new Error(`${label} target escapes its package: ${target}`);
  }
  return resolved;
}

function defaultRepoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invokedDirectly =
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const { exitCode } = await runVerifyDeepImports();
  process.exitCode = exitCode;
}

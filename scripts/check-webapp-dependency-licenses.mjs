#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webappRoot = resolve(repoRoot, "packages/web/webapp");
const REQUIRED_APP_LICENSE = "GPL-3.0-only";

// Every currently shipped browser dependency is permissively licensed. New
// license expressions fail closed until they receive an explicit review.
export const ALLOWED_WEBAPP_PRODUCTION_LICENSES = Object.freeze([
  "0BSD",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

export function evaluateWebappDependencyLicenses(report, manifest) {
  const issues = [];
  if (!isRecord(manifest) || manifest.license !== REQUIRED_APP_LICENSE) {
    issues.push(`webapp package license must be ${REQUIRED_APP_LICENSE}`);
  }
  if (!isRecord(report)) {
    return { issues: [...issues, "pnpm license report must be an object"], packageCount: 0 };
  }

  const allowed = new Set(ALLOWED_WEBAPP_PRODUCTION_LICENSES);
  const packageNames = new Set();
  let packageCount = 0;
  for (const [license, entries] of Object.entries(report)) {
    if (!allowed.has(license)) issues.push(`unreviewed production license: ${license}`);
    if (!Array.isArray(entries)) {
      issues.push(`license ${license} must contain a package array`);
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0
        || !Array.isArray(entry.versions) || entry.versions.length === 0) {
        issues.push(`license ${license} contains a malformed package entry`);
        continue;
      }
      packageNames.add(entry.name);
      packageCount += entry.versions.length;
    }
  }

  const dependencies = isRecord(manifest) && isRecord(manifest.dependencies)
    ? Object.keys(manifest.dependencies)
    : [];
  if (dependencies.length === 0) issues.push("webapp manifest has no production dependencies");
  for (const dependency of dependencies) {
    if (!packageNames.has(dependency)) {
      issues.push(`production dependency missing from license report: ${dependency}`);
    }
  }
  return { issues: [...new Set(issues)].sort(), packageCount };
}

export async function checkWebappDependencyLicenses(options = {}) {
  const appRoot = resolve(options.webappRoot ?? webappRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));
  } catch (error) {
    return {
      issues: [`webapp package.json could not be read: ${reasonOf(error)}`],
      packageCount: 0,
    };
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      options.pnpmCommand ?? "pnpm",
      ["--dir", appRoot, "licenses", "list", "--prod", "--json"],
      { cwd: options.repoRoot ?? repoRoot, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    return {
      issues: [`could not collect webapp production licenses: ${reasonOf(error)}`],
      packageCount: 0,
    };
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    return {
      issues: [`pnpm license report was not valid JSON: ${reasonOf(error)}`],
      packageCount: 0,
    };
  }
  return evaluateWebappDependencyLicenses(report, manifest);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  const result = await checkWebappDependencyLicenses();
  if (result.issues.length === 0) {
    process.stdout.write(
      `Webapp production dependency license check passed: ${result.packageCount} package versions use reviewed permissive licenses.\n`,
    );
  } else {
    process.stderr.write([
      "Webapp production dependency license check failed",
      ...result.issues.map((issue) => `- ${issue}`),
      "",
    ].join("\n"));
    process.exitCode = 1;
  }
}

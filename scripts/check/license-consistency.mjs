#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageCatalog, packageRelativePath } from "../lib/package-catalog.mjs";

export const REQUIRED_LICENSE = "MIT";
export const CANONICAL_MIT_SHA256 = "dd64c8ae63e0624cad201a3fa3465388dffaaf0079058b6871e40f4b1431e64a";
const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function checkLicenseConsistency(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const catalog = options.catalog ?? packageCatalog;
  const publishable = catalog.filter((entry) => entry.publishable === true);
  const issues = [];

  if (publishable.length === 0) {
    issues.push("package catalog has no publishable packages");
  }

  await checkManifestLicense({
    path: join(repoRoot, "package.json"),
    label: "root package.json",
    issues,
  });
  await checkCanonicalLicense(join(repoRoot, "LICENSE"), "LICENSE", issues);

  for (const entry of publishable) {
    if (entry.license !== undefined) {
      issues.push(`${entry.name} must not declare a catalog license override under the uniform MIT policy`);
    }
    const relativePath = `${packageRelativePath(entry)}/package.json`;
    await checkManifestLicense({
      path: join(repoRoot, relativePath),
      label: `${entry.name} (${relativePath})`,
      issues,
    });
    const licensePath = `${packageRelativePath(entry)}/LICENSE`;
    await checkCanonicalLicense(join(repoRoot, licensePath), licensePath, issues);
  }

  return {
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
    packageCount: publishable.length,
  };
}

export function renderLicenseConsistencyReport(result) {
  if (result.issues.length === 0) {
    return `License consistency check passed: root + ${result.packageCount} publishable packages match the uniform MIT policy.\n`;
  }

  return [
    "License consistency check failed",
    ...result.issues.map((issue) => `- ${issue}`),
    "",
  ].join("\n");
}

async function checkManifestLicense({ path, label, issues }) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    issues.push(`${label} could not be read as JSON (${reasonOf(error)})`);
    return;
  }

  if (manifest.license !== REQUIRED_LICENSE) {
    issues.push(`${label} license must be ${REQUIRED_LICENSE}; found ${JSON.stringify(manifest.license)}`);
  }
}

async function checkCanonicalLicense(path, label, issues) {
  let contents;
  try {
    contents = await readFile(path);
  } catch (error) {
    issues.push(`${label} is missing or unreadable (${reasonOf(error)})`);
    return;
  }

  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== CANONICAL_MIT_SHA256) {
    issues.push(
      `${label} must be the canonical MIT text (sha256 ${CANONICAL_MIT_SHA256}); found ${digest}`,
    );
  }
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await checkLicenseConsistency();
  process.stdout.write(renderLicenseConsistencyReport(result));
  process.exitCode = result.exitCode;
}

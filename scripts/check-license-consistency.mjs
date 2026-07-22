#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageCatalog, packageRelativePath } from "./package-catalog.mjs";

export const REQUIRED_LICENSE = "GPL-3.0-only";
export const CANONICAL_GPL3_SHA256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalLicensePaths = ["LICENSE", "packages/agent-runtime/LICENSE"];

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

  for (const entry of publishable) {
    const relativePath = `${packageRelativePath(entry)}/package.json`;
    await checkManifestLicense({
      path: join(repoRoot, relativePath),
      label: `${entry.name} (${relativePath})`,
      issues,
    });
  }

  for (const relativePath of canonicalLicensePaths) {
    await checkCanonicalLicense(join(repoRoot, relativePath), relativePath, issues);
  }

  return {
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
    packageCount: publishable.length,
  };
}

export function renderLicenseConsistencyReport(result) {
  if (result.issues.length === 0) {
    return `License consistency check passed: root + ${result.packageCount} publishable packages use ${REQUIRED_LICENSE}.\n`;
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
  if (digest !== CANONICAL_GPL3_SHA256) {
    issues.push(`${label} must be the canonical GPL-3.0 text (sha256 ${CANONICAL_GPL3_SHA256}); found ${digest}`);
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

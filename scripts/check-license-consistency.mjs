#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageCatalog, packageRelativePath } from "./package-catalog.mjs";

export const REQUIRED_LICENSE = "GPL-3.0-only";
export const DEFAULT_PACKAGE_LICENSE = REQUIRED_LICENSE;
export const CANONICAL_GPL3_SHA256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";
export const CANONICAL_APACHE2_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";
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
    expectedLicense: REQUIRED_LICENSE,
    issues,
  });

  for (const entry of publishable) {
    const relativePath = `${packageRelativePath(entry)}/package.json`;
    const expectedLicense = entry.license === "Apache-2.0"
      ? "Apache-2.0"
      : DEFAULT_PACKAGE_LICENSE;
    if (entry.license !== undefined && entry.license !== "Apache-2.0") {
      issues.push(`${entry.name} may not override the default ${DEFAULT_PACKAGE_LICENSE} package license`);
    }
    await checkManifestLicense({
      path: join(repoRoot, relativePath),
      label: `${entry.name} (${relativePath})`,
      expectedLicense,
      issues,
    });
    if (expectedLicense === "Apache-2.0") {
      const licensePath = `${packageRelativePath(entry)}/LICENSE`;
      await checkCanonicalLicense(
        join(repoRoot, licensePath),
        licensePath,
        "Apache-2.0",
        CANONICAL_APACHE2_SHA256,
        issues,
      );
    }
  }

  for (const relativePath of canonicalLicensePaths) {
    await checkCanonicalLicense(
      join(repoRoot, relativePath),
      relativePath,
      "GPL-3.0",
      CANONICAL_GPL3_SHA256,
      issues,
    );
  }

  return {
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
    packageCount: publishable.length,
  };
}

export function renderLicenseConsistencyReport(result) {
  if (result.issues.length === 0) {
    return `License consistency check passed: root + ${result.packageCount} publishable packages match the declared GPL/Apache split.\n`;
  }

  return [
    "License consistency check failed",
    ...result.issues.map((issue) => `- ${issue}`),
    "",
  ].join("\n");
}

async function checkManifestLicense({ path, label, expectedLicense, issues }) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    issues.push(`${label} could not be read as JSON (${reasonOf(error)})`);
    return;
  }

  if (manifest.license !== expectedLicense) {
    issues.push(`${label} license must be ${expectedLicense}; found ${JSON.stringify(manifest.license)}`);
  }
}

async function checkCanonicalLicense(path, label, licenseName, expectedDigest, issues) {
  let contents;
  try {
    contents = await readFile(path);
  } catch (error) {
    issues.push(`${label} is missing or unreadable (${reasonOf(error)})`);
    return;
  }

  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== expectedDigest) {
    issues.push(`${label} must be the canonical ${licenseName} text (sha256 ${expectedDigest}); found ${digest}`);
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

// SPDX-License-Identifier: MIT
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_PACKAGE_SCRIPTS = Object.freeze(["build", "typecheck", "test"]);

/**
 * Keep every publishable workspace package independently verifiable. The root
 * recursive commands are only trustworthy when a newly cataloged package cannot
 * omit a lane or turn its test lane into a successful no-op.
 */
const VITEST_CONFIG_FILES = Object.freeze([
  "vitest.config.ts", "vitest.config.mts", "vitest.config.mjs", "vitest.config.js",
]);

/**
 * `passWithNoTests` is equally disarming whether it arrives as a script flag or
 * as config. Banning only the flag left the config path open, which is exactly
 * where it was being used.
 */
function noTestEscapeHatchErrors(packagePath, repoRoot) {
  const errors = [];
  for (const file of VITEST_CONFIG_FILES) {
    const path = join(repoRoot ?? ".", packagePath, file);
    if (!existsSync(path)) continue;
    if (/passWithNoTests\s*:\s*true/u.test(readFileSync(path, "utf8"))) {
      errors.push(`${packagePath}/${file} must not set passWithNoTests: true.`);
    }
  }
  return errors;
}

export function findPackageVerificationErrors({ manifest, packagePath, repoRoot }) {
  const errors = [];
  if (!isRecord(manifest)) {
    return [`${packagePath}/package.json must contain a JSON object.`];
  }
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  for (const scriptName of REQUIRED_PACKAGE_SCRIPTS) {
    const command = scripts[scriptName];
    if (typeof command !== "string" || command.trim().length === 0) {
      errors.push(`${packagePath}/package.json must define a non-empty ${scriptName} script.`);
    }
  }
  const testCommand = scripts.test;
  if (typeof testCommand === "string" && /(?:^|\s)--passWithNoTests(?:\s|$)/u.test(testCommand)) {
    errors.push(`${packagePath}/package.json test script must fail when no tests are discovered.`);
  }
  if (typeof testCommand === "string" && !/--expect\.requireAssertions(?:\s|$)/u.test(testCommand)) {
    errors.push(`${packagePath}/package.json test script must pass --expect.requireAssertions.`);
  }
  errors.push(...noTestEscapeHatchErrors(packagePath, repoRoot));
  return errors;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

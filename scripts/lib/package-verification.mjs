// SPDX-License-Identifier: MIT
const REQUIRED_PACKAGE_SCRIPTS = Object.freeze(["build", "typecheck", "test"]);

/**
 * Keep every publishable workspace package independently verifiable. The root
 * recursive commands are only trustworthy when a newly cataloged package cannot
 * omit a lane or turn its test lane into a successful no-op.
 */
export function findPackageVerificationErrors({ manifest, packagePath }) {
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
  return errors;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

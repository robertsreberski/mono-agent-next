// SPDX-License-Identifier: MIT
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CANONICAL_MIT_SHA256,
  REQUIRED_LICENSE,
  checkLicenseConsistency,
  renderLicenseConsistencyReport,
} from "../check/license-consistency.mjs";

const tempDirs = [];
const catalog = [{
  name: "@mono-agent/example",
  path: "packages/example",
  publishable: true,
}];
let canonicalLicense;

beforeAll(async () => {
  canonicalLicense = await readFile(new URL("../../LICENSE", import.meta.url));
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-license-consistency", () => {
  it("accepts aligned root and publishable package metadata with canonical MIT texts", async () => {
    const repoRoot = await fixtureRepo();

    const result = await checkLicenseConsistency({ repoRoot, catalog });

    expect(result).toEqual({ exitCode: 0, issues: [], packageCount: 1 });
    expect(renderLicenseConsistencyReport(result))
      .toContain("root + 1 publishable packages match the uniform MIT policy");
  });

  it("rejects package-specific catalog license overrides", async () => {
    const repoRoot = await fixtureRepo();

    const result = await checkLicenseConsistency({
      repoRoot,
      catalog: [{ ...catalog[0], license: "Apache-2.0" }],
    });

    expect(result).toEqual({
      exitCode: 1,
      issues: [
        "@mono-agent/example must not declare a catalog license override under the uniform MIT policy",
      ],
      packageCount: 1,
    });
  });

  it("reports root and publishable-package metadata drift", async () => {
    const repoRoot = await fixtureRepo({
      rootLicense: "UNLICENSED",
      packageLicense: "Apache-2.0",
    });

    const result = await checkLicenseConsistency({ repoRoot, catalog });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toEqual([
      "root package.json license must be MIT; found \"UNLICENSED\"",
      "@mono-agent/example (packages/example/package.json) license must be MIT; found \"Apache-2.0\"",
    ]);
  });

  it("reports drift in both canonical MIT text copies", async () => {
    const repoRoot = await fixtureRepo();
    await writeFile(join(repoRoot, "LICENSE"), "not MIT\n", "utf8");
    await writeFile(join(repoRoot, "packages/example/LICENSE"), "also not MIT\n", "utf8");

    const result = await checkLicenseConsistency({ repoRoot, catalog });
    const report = renderLicenseConsistencyReport(result);

    expect(result.exitCode).toBe(1);
    expect(result.issues).toHaveLength(2);
    expect(report).toContain(`sha256 ${CANONICAL_MIT_SHA256}`);
    expect(report).toContain("LICENSE must be the canonical MIT text");
    expect(report).toContain("packages/example/LICENSE must be the canonical MIT text");
  });
});

async function fixtureRepo(options = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), "mono-agent-license-check-"));
  tempDirs.push(repoRoot);

  await writeJson(join(repoRoot, "package.json"), {
    name: "mono-agent",
    license: options.rootLicense ?? REQUIRED_LICENSE,
  });
  await writeJson(join(repoRoot, "packages/example/package.json"), {
    name: "@mono-agent/example",
    license: options.packageLicense ?? REQUIRED_LICENSE,
  });
  await writeFileAt(join(repoRoot, "LICENSE"), canonicalLicense);
  await writeFileAt(join(repoRoot, "packages/example/LICENSE"), canonicalLicense);
  return repoRoot;
}

async function writeJson(path, value) {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CANONICAL_APACHE2_SHA256,
  CANONICAL_GPL3_SHA256,
  REQUIRED_LICENSE,
  checkLicenseConsistency,
  renderLicenseConsistencyReport,
} from "../check-license-consistency.mjs";

const tempDirs = [];
const catalog = [{
  name: "@mono-agent/example",
  path: "packages/example",
  publishable: true,
}];
let canonicalLicense;
let canonicalApacheLicense;

beforeAll(async () => {
  canonicalLicense = await readFile(new URL("../../LICENSE", import.meta.url));
  canonicalApacheLicense = await readFile(new URL("../../packages/module-sdk/LICENSE", import.meta.url));
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-license-consistency", () => {
  it("accepts aligned root and publishable package metadata with canonical license texts", async () => {
    const repoRoot = await fixtureRepo();

    const result = await checkLicenseConsistency({ repoRoot, catalog });

    expect(result).toEqual({ exitCode: 0, issues: [], packageCount: 1 });
    expect(renderLicenseConsistencyReport(result)).toContain("root + 1 publishable packages match the declared GPL/Apache split");
  });

  it("accepts an explicitly catalogued Apache extension-surface package", async () => {
    const repoRoot = await fixtureRepo({ packageLicense: "Apache-2.0" });

    const result = await checkLicenseConsistency({
      repoRoot,
      catalog: [{ ...catalog[0], name: "@mono-agent/operator", license: "Apache-2.0" }],
    });

    expect(result).toEqual({ exitCode: 0, issues: [], packageCount: 1 });
  });

  it("reports drift in an Apache package's canonical license text", async () => {
    const repoRoot = await fixtureRepo({ packageLicense: "Apache-2.0" });
    await writeFile(join(repoRoot, "packages/example/LICENSE"), "not Apache\n", "utf8");

    const result = await checkLicenseConsistency({
      repoRoot,
      catalog: [{ ...catalog[0], name: "@mono-agent/operator", license: "Apache-2.0" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toEqual([
      `packages/example/LICENSE must be the canonical Apache-2.0 text (sha256 ${CANONICAL_APACHE2_SHA256}); found 0acf08a53ff940ebbe1bebc6b8373a3c82047fbe4c68cf0376b564e0af84495c`,
    ]);
  });

  it("rejects license overrides other than the catalogued Apache split", async () => {
    const repoRoot = await fixtureRepo({ packageLicense: "MIT" });

    const result = await checkLicenseConsistency({
      repoRoot,
      catalog: [{ ...catalog[0], license: "MIT" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toEqual([
      "@mono-agent/example may not override the default GPL-3.0-only package license",
      "@mono-agent/example (packages/example/package.json) license must be GPL-3.0-only; found \"MIT\"",
    ]);
  });

  it("reports root and publishable-package metadata drift", async () => {
    const repoRoot = await fixtureRepo({ rootLicense: "UNLICENSED", packageLicense: "MIT" });

    const result = await checkLicenseConsistency({ repoRoot, catalog });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toEqual([
      "root package.json license must be GPL-3.0-only; found \"UNLICENSED\"",
      "@mono-agent/example (packages/example/package.json) license must be GPL-3.0-only; found \"MIT\"",
    ]);
  });

  it("reports drift in both canonical GPL text copies", async () => {
    const repoRoot = await fixtureRepo();
    await writeFile(join(repoRoot, "LICENSE"), "not the GPL\n", "utf8");
    await writeFile(join(repoRoot, "packages/example/LICENSE"), "also not the GPL\n", "utf8");

    const result = await checkLicenseConsistency({ repoRoot, catalog });
    const report = renderLicenseConsistencyReport(result);

    expect(result.exitCode).toBe(1);
    expect(result.issues).toHaveLength(2);
    expect(report).toContain(`sha256 ${CANONICAL_GPL3_SHA256}`);
    expect(report).toContain("LICENSE must be the canonical GPL-3.0 text");
    expect(report).toContain("packages/example/LICENSE must be the canonical GPL-3.0 text");
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
  await writeFileAt(
    join(repoRoot, "packages/example/LICENSE"),
    options.packageLicense === "Apache-2.0" ? canonicalApacheLicense : canonicalLicense,
  );
  return repoRoot;
}

async function writeJson(path, value) {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

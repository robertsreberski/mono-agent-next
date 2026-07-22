import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
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

beforeAll(async () => {
  canonicalLicense = await readFile(new URL("../../packages/agent-runtime/LICENSE", import.meta.url));
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-license-consistency", () => {
  it("accepts aligned root and publishable package metadata with canonical license texts", async () => {
    const repoRoot = await fixtureRepo();

    const result = await checkLicenseConsistency({ repoRoot, catalog });

    expect(result).toEqual({ exitCode: 0, issues: [], packageCount: 1 });
    expect(renderLicenseConsistencyReport(result)).toContain(`root + 1 publishable packages use ${REQUIRED_LICENSE}`);
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
    await writeFile(join(repoRoot, "packages/agent-runtime/LICENSE"), "also not the GPL\n", "utf8");

    const result = await checkLicenseConsistency({ repoRoot, catalog });
    const report = renderLicenseConsistencyReport(result);

    expect(result.exitCode).toBe(1);
    expect(result.issues).toHaveLength(2);
    expect(report).toContain(`sha256 ${CANONICAL_GPL3_SHA256}`);
    expect(report).toContain("LICENSE must be the canonical GPL-3.0 text");
    expect(report).toContain("packages/agent-runtime/LICENSE must be the canonical GPL-3.0 text");
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
  await writeFileAt(join(repoRoot, "packages/agent-runtime/LICENSE"), canonicalLicense);
  return repoRoot;
}

async function writeJson(path, value) {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

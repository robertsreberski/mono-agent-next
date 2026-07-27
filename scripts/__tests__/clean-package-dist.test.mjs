// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cleanPackageDist } from "../build/clean-package-dist.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("package dist cleanup", () => {
  it("removes only an ordinary dist directory from a cataloged package", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.packageDirectory, "dist", "stale.js"), "stale\n");
    writeFileSync(join(fixture.packageDirectory, "source.ts"), "source\n");

    expect(clean(fixture)).toBe(true);
    expect(existsSync(join(fixture.packageDirectory, "dist"))).toBe(false);
    expect(readFileSync(join(fixture.packageDirectory, "source.ts"), "utf8")).toBe("source\n");
    expect(clean(fixture)).toBe(false);
  });

  it("rejects non-cataloged roots and linked build output without touching it", () => {
    const fixture = createFixture();
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    rmSync(join(fixture.packageDirectory, "dist"), { recursive: true });
    symlinkSync(outside, join(fixture.packageDirectory, "dist"));

    expect(() => clean(fixture)).toThrow(/real directory/u);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(() => cleanPackageDist({
      repositoryRoot: fixture.root,
      packageDirectory: outside,
      packagePaths: new Set(["packages/example"]),
    })).toThrow(/cataloged package/u);
  });

  it("keeps seeded orphan output out of a dry-run package", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.packageDirectory, "README.md"), "# Example\n");
    writeFileSync(join(fixture.packageDirectory, "LICENSE"), "MIT\n");
    writeFileSync(join(fixture.packageDirectory, "package.json"), JSON.stringify({
      name: "@mono-agent/example",
      version: "0.0.0",
      files: ["dist", "README.md", "LICENSE"],
    }));
    writeFileSync(join(fixture.packageDirectory, "dist", "run-history-tool.js"), "orphan\n");

    clean(fixture);
    mkdirSync(join(fixture.packageDirectory, "dist"));
    writeFileSync(join(fixture.packageDirectory, "dist", "index.js"), "export {};\n");

    const packed = spawnSync(
      "pnpm",
      ["--dir", fixture.packageDirectory, "pack", "--dry-run", "--json"],
      { encoding: "utf8" },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const result = JSON.parse(packed.stdout);
    const record = Array.isArray(result) ? result[0] : result;
    const files = record.files.map((entry) => entry.path);
    expect(files).toContain("dist/index.js");
    expect(files).not.toContain("dist/run-history-tool.js");
  });

  it("keeps the Core build wired through the cleaner", () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "packages/core/package.json"), "utf8"),
    );
    expect(manifest.scripts.build).toBe(
      "node ../../scripts/build/clean-package-dist.mjs && tsc -p tsconfig.build.json",
    );
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-clean-dist-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, "packages", "example");
  mkdirSync(join(packageDirectory, "dist"), { recursive: true });
  return { root, packageDirectory };
}

function clean(fixture) {
  return cleanPackageDist({
    repositoryRoot: fixture.root,
    packageDirectory: fixture.packageDirectory,
    packagePaths: new Set(["packages/example"]),
  });
}

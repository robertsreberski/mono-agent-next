import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { assertPackedDependencyResolution } from "../dependency-policy.mjs";
import {
  assertIsolatedInstallLayout,
  assertMinimumNodeRuntime,
  assertPackedReleaseMetadata,
  buildIsolatedConsumerManifest,
  buildPackedConsumerManifest,
  declaredInternalPackageClosure,
  declaredInternalPackageNames,
  parsePackedConsumerArgs,
} from "../verify-packed-consumer.mjs";
import {
  parsePackedSmokeArgs,
  publicExportSpecifiers,
} from "../fixtures/packed-consumer/public-exports.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("packed consumer verification", () => {
  test("parses the release tag and exact-minimum guard", () => {
    expect(parsePackedConsumerArgs(["--", "--tag", "v1.2.3", "--require-minimum"])).toEqual({
      tag: "v1.2.3",
      requireMinimum: true,
    });
    expect(() => parsePackedConsumerArgs(["--tag"])).toThrow(/--tag requires a value/u);
    expect(() => parsePackedConsumerArgs(["--unknown"])).toThrow(/Unknown argument/u);
  });

  test("requires the exact minimum when the proof flag is used", () => {
    expect(() => assertMinimumNodeRuntime("22.19.0")).not.toThrow();
    expect(() => assertMinimumNodeRuntime("22.18.0")).toThrow(/must run on Node\.js 22\.19\.0/u);
    expect(() => assertMinimumNodeRuntime("24.0.0")).toThrow(/current Node\.js is 24\.0\.0/u);
  });

  test("builds a deterministic all-tarball consumer manifest", () => {
    const manifest = buildPackedConsumerManifest(
      {
        name: "consumer",
        engines: { node: ">=22.19.0" },
      },
      [
        { name: "@mono-agent/z", tarballPath: "/tmp/z.tgz" },
        { name: "@mono-agent/a", tarballPath: "/tmp/a.tgz" },
      ],
    );

    expect(manifest.dependencies).toEqual({
      "@mono-agent/a": "file:/tmp/a.tgz",
      "@mono-agent/z": "file:/tmp/z.tgz",
    });
    expect(() => buildPackedConsumerManifest({ engines: { node: ">=20" } }, [])).toThrow(
      /template engines\.node must be >=22\.19\.0/u,
    );
  });

  test("derives every concrete runtime export from a packed manifest", () => {
    expect(publicExportSpecifiers("@mono-agent/example", {
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./feature": { types: "./dist/feature.d.ts", default: "./dist/feature.js" },
        "./package.json": "./package.json",
        "./blocked": null,
      },
    })).toEqual([
      "@mono-agent/example",
      "@mono-agent/example/feature",
      "@mono-agent/example/package.json",
    ]);
    expect(publicExportSpecifiers("create-example", { bin: { create: "./cli.js" } })).toEqual([]);
    expect(publicExportSpecifiers("legacy-example", { main: "./index.js" })).toEqual(["legacy-example"]);
    expect(() => publicExportSpecifiers("@mono-agent/example", {
      exports: { "./features/*": "./dist/features/*.js" },
    })).toThrow(/wildcard export/u);
    expect(parsePackedSmokeArgs(["--target", "@mono-agent/example"])).toEqual({
      target: "@mono-agent/example",
    });
    expect(() => parsePackedSmokeArgs(["--target"])).toThrow(/requires a package name/u);
  });

  test("builds an isolated manifest with only the target as a direct dependency", () => {
    const template = { name: "consumer", engines: { node: ">=22.19.0" } };
    const packedPackages = [
      { name: "@mono-agent/target", tarballPath: "/tmp/target.tgz" },
      { name: "@mono-agent/declared", tarballPath: "/tmp/declared.tgz" },
      { name: "@mono-agent/peer", tarballPath: "/tmp/peer.tgz" },
      { name: "@mono-agent/hidden", tarballPath: "/tmp/hidden.tgz" },
    ];

    const manifest = buildIsolatedConsumerManifest(
      template,
      { name: "@mono-agent/target" },
      packedPackages,
    );

    expect(manifest.dependencies).toEqual({
      "@mono-agent/target": "file:/tmp/target.tgz",
    });
    expect(manifest.overrides).toEqual({
      "@mono-agent/declared": "file:/tmp/declared.tgz",
      "@mono-agent/hidden": "file:/tmp/hidden.tgz",
      "@mono-agent/peer": "file:/tmp/peer.tgz",
    });
    expect(manifest.dependencies["@mono-agent/hidden"]).toBeUndefined();
    expect(declaredInternalPackageNames({
      dependencies: { "@mono-agent/declared": "1.2.3" },
      peerDependencies: { "@mono-agent/peer": "1.2.3" },
    }, packedPackages)).toEqual([
      "@mono-agent/declared",
      "@mono-agent/peer",
    ]);
  });

  test("derives the complete declared internal dependency closure", () => {
    const manifests = new Map([
      ["@mono-agent/target", { dependencies: { "@mono-agent/direct": "1.2.3" } }],
      ["@mono-agent/direct", { optionalDependencies: { "@mono-agent/transitive": "1.2.3" } }],
      ["@mono-agent/transitive", {}],
      ["@mono-agent/unrelated", {}],
    ]);

    expect(declaredInternalPackageClosure("@mono-agent/target", manifests)).toEqual([
      "@mono-agent/direct",
      "@mono-agent/target",
      "@mono-agent/transitive",
    ]);
    expect(() => declaredInternalPackageClosure("@mono-agent/missing", manifests)).toThrow(
      /Packed manifest missing/u,
    );
  });

  test("requires exact release repository metadata in the packed manifest", () => {
    const pkg = {
      name: "@mono-agent/example",
      version: "1.2.3",
      relativeDir: "packages/example",
    };
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      repository: {
        type: "git",
        url: "git+https://github.com/robertsreberski/mono-agent.git",
        directory: pkg.relativeDir,
      },
    };

    expect(() => assertPackedReleaseMetadata(pkg, manifest)).not.toThrow();
    expect(() => assertPackedReleaseMetadata(pkg, {
      ...manifest,
      repository: { ...manifest.repository, directory: "packages/wrong" },
    })).toThrow(/Packed @mono-agent\/example repository must be/u);
  });

  test("isolated packed install exposes an undeclared dependency masked by the combined consumer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packed-isolation-regression-"));
    temporaryDirectories.push(root);
    const target = packSyntheticPackage(root, {
      name: "@mono-agent/target",
      version: "1.2.3",
      type: "module",
      exports: { ".": "./index.js" },
    }, 'import { hidden } from "@mono-agent/hidden"; export { hidden };\n');
    const hidden = packSyntheticPackage(root, {
      name: "@mono-agent/hidden",
      version: "1.2.3",
      type: "module",
      exports: { ".": "./index.js" },
    }, "export const hidden = true;\n");
    const template = {
      name: "consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      engines: { node: ">=22.19.0" },
    };

    const combinedDir = path.join(root, "combined");
    fs.mkdirSync(combinedDir);
    writeJson(path.join(combinedDir, "package.json"), buildPackedConsumerManifest(
      template,
      [target, hidden],
    ));
    expect(runNpmInstall(combinedDir).status).toBe(0);
    expect(importPackage(combinedDir, target.name).status).toBe(0);

    const isolatedDir = path.join(root, "isolated");
    fs.mkdirSync(isolatedDir);
    const isolatedManifest = buildIsolatedConsumerManifest(
      template,
      target,
      [target, hidden],
    );
    writeJson(path.join(isolatedDir, "package.json"), isolatedManifest);
    expect(runNpmInstall(isolatedDir).status).toBe(0);
    expect(() => assertIsolatedInstallLayout(
      isolatedDir,
      target.name,
      declaredInternalPackageClosure(target.name, new Map([
        [target.name, target.packageJson],
        [hidden.name, hidden.packageJson],
      ])),
      [target.name, hidden.name],
    )).not.toThrow();
    const isolatedImport = importPackage(isolatedDir, target.name);
    expect(isolatedImport.status).not.toBe(0);
    expect(isolatedImport.stderr).toMatch(/Cannot find package '@mono-agent\/hidden'/u);
  });

  test("accepts exact packed Pi pins and their actual installed resolution", () => {
    const fixture = packedDependencyFixture();

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).not.toThrow();
  });

  test("rejects a packed manifest that can float to a newer Pi runtime", () => {
    const fixture = packedDependencyFixture({ appPiRange: "^0.80.6" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /Packed @mono-agent\/agent-app dependencies\.@earendil-works\/pi-ai must remain 0\.80\.6; found \^0\.80\.6/u,
    );
  });

  test("rejects an incompatible Pi AI nested under the pinned core", () => {
    const fixture = packedDependencyFixture({ nestedCorePiVersion: "0.80.8" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /resolved @earendil-works\/pi-ai@0\.80\.8 from @earendil-works\/pi-agent-core@0\.80\.6; expected 0\.80\.6/u,
    );
  });

  test("rejects a packed Pi TUI manifest that can float", () => {
    const fixture = packedDependencyFixture({ tuiPiRange: "^0.79.1" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /Packed @mono-agent\/tui dependencies\.@earendil-works\/pi-tui must remain 0\.79\.10; found \^0\.79\.1/u,
    );
  });

  test("rejects a different Pi TUI installed under the exact packed manifest", () => {
    const fixture = packedDependencyFixture({ installedTuiVersion: "0.79.11" });

    expect(() =>
      assertPackedDependencyResolution(fixture.consumerDir, fixture.packages),
    ).toThrow(
      /resolved @earendil-works\/pi-tui@0\.79\.11 from @mono-agent\/tui; expected 0\.79\.10/u,
    );
  });
});

function packedDependencyFixture({
  appPiRange = "0.80.6",
  installedTuiVersion = "0.79.10",
  nestedCorePiVersion,
  tuiPiRange = "0.79.10",
} = {}) {
  const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), "packed-dependency-policy-"));
  temporaryDirectories.push(consumerDir);
  const modulesDir = path.join(consumerDir, "node_modules");

  writePackage(modulesDir, {
    name: "@mono-agent/agent-app",
    version: "1.2.3",
    dependencies: { "@earendil-works/pi-ai": appPiRange },
  });
  writePackage(modulesDir, {
    name: "@mono-agent/agent-runtime",
    version: "1.2.3",
    dependencies: {
      "@earendil-works/pi-agent-core": "0.80.6",
      "@earendil-works/pi-ai": "0.80.6",
    },
  });
  writePackage(modulesDir, {
    name: "@mono-agent/tui",
    version: "1.2.3",
    dependencies: { "@earendil-works/pi-tui": tuiPiRange },
  });
  const coreDir = writePackage(modulesDir, {
    name: "@earendil-works/pi-agent-core",
    version: "0.80.6",
    dependencies: { "@earendil-works/pi-ai": "^0.80.6" },
  });
  writePackage(modulesDir, {
    name: "@earendil-works/pi-ai",
    version: "0.80.6",
  });
  writePackage(modulesDir, {
    name: "@earendil-works/pi-tui",
    version: installedTuiVersion,
  });
  if (nestedCorePiVersion !== undefined) {
    writePackage(path.join(coreDir, "node_modules"), {
      name: "@earendil-works/pi-ai",
      version: nestedCorePiVersion,
    });
  }

  return {
    consumerDir,
    packages: [
      {
        name: "@mono-agent/agent-app",
        packageJson: {
          dependencies: { "@earendil-works/pi-ai": "0.80.6" },
        },
      },
      {
        name: "@mono-agent/agent-runtime",
        packageJson: {
          dependencies: {
            "@earendil-works/pi-agent-core": "0.80.6",
            "@earendil-works/pi-ai": "0.80.6",
          },
        },
      },
      {
        name: "@mono-agent/tui",
        packageJson: {
          dependencies: { "@earendil-works/pi-tui": "0.79.10" },
        },
      },
    ],
  };
}

function writePackage(modulesDir, manifest) {
  const packageDir = path.join(modulesDir, ...manifest.name.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({
      type: "module",
      exports: { ".": { import: "./index.js" } },
      ...manifest,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), "export {};\n");
  return packageDir;
}

function packSyntheticPackage(root, packageJson, source) {
  const packageDir = path.join(root, packageJson.name.replace(/[^0-9A-Za-z]+/gu, "-"));
  const tarballDir = path.join(root, "tarballs");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(tarballDir, { recursive: true });
  writeJson(path.join(packageDir, "package.json"), packageJson);
  fs.writeFileSync(path.join(packageDir, "index.js"), source);
  fs.writeFileSync(path.join(packageDir, "README.md"), `${packageJson.name}\n`);
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
    cwd: packageDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`synthetic npm pack failed: ${result.stderr || result.stdout}`);
  }
  const [packed] = JSON.parse(result.stdout);
  return {
    name: packageJson.name,
    packageJson,
    tarballPath: path.join(tarballDir, packed.filename),
  };
}

function runNpmInstall(directory) {
  return spawnSync("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ], {
    cwd: directory,
    encoding: "utf8",
  });
}

function importPackage(directory, name) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(name)})`,
  ], {
    cwd: directory,
    encoding: "utf8",
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";
import { PINNED_RUNTIME_DEPENDENCIES } from "../dependency-policy.mjs";
import {
  discoverPackages,
  REPO_ROOT,
  sortForPublish,
} from "../package-graph.mjs";
import {
  assertPackResult,
  parsePnpmPackOutput,
} from "../pack-release.mjs";
import {
  RELEASE_REPOSITORY,
  SOURCE_BETA_RELEASE_PACKAGE_NAMES,
  releaseVersionFromTag,
  validateRelease,
} from "../validate-release.mjs";
import {
  EMPTY_NPM_GLOBAL_CONFIG,
  PUBLIC_NPM_REGISTRY,
  assertBuildMarkerForHead,
  assertCurrentBuildProvenance,
  assertNeutralNpmGlobalConfig,
  assertReleaseGitState,
  computeTarballIntegrity,
  executeFrozenPublish,
  freezeReleaseTarballs,
  publishFrozenTarball,
  publicNpmEnvironment,
  resolveTrustedGitExecutable,
  runReleaseBuildWithProvenance,
  runWorkspaceBuild,
  stagingDistTagForRelease,
} from "../publish-release.mjs";
import { assertPublishingAllowed } from "../check-publish-guard.mjs";
import { SUPPORTED_NODE_ENGINE } from "../../node-version.mjs";

const expectedPublishablePackages = packageCatalog.filter((entry) => entry.publishable === true);
const expectedPublishablePackageCount = expectedPublishablePackages.length;
const expectedPublishablePackageNames = expectedPublishablePackages.map((entry) => entry.name).sort();

describe("successor publish guard", () => {
  test("blocks publication until the bootstrap safety section is removed", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-guard-"));
    try {
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "# AGENTS.md\n\n## Successor bootstrap safety\n\nDo not publish.\n");
      expect(() => assertPublishingAllowed({ repo })).toThrow(/successor bootstrap safety guard/u);

      fs.writeFileSync(path.join(repo, "AGENTS.md"), "# AGENTS.md\n\n## Project\n");
      expect(() => assertPublishingAllowed({ repo })).not.toThrow();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("neutral npm config authority", () => {
  test("rejects a group/world-writable global config even when its bytes are canonical", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-neutral-npmrc-"));
    const configPath = path.join(directory, "empty.npmrc");
    try {
      fs.writeFileSync(
        configPath,
        "; Intentionally empty neutral npm global configuration for release subprocesses.\n",
        { mode: 0o600 },
      );
      expect(() => assertNeutralNpmGlobalConfig(configPath)).not.toThrow();
      fs.chmodSync(configPath, 0o666);
      expect(() => assertNeutralNpmGlobalConfig(configPath)).toThrow(/unsafe or modified/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function packageRecord({
  name,
  version = "1.2.3",
  publishable = true,
  privatePackage = false,
  publishConfig = { access: "public" },
  dependencies = {},
  optionalDependencies = {},
  peerDependencies = {},
  devDependencies = {},
  nodeEngine = SUPPORTED_NODE_ENGINE,
  repository,
}) {
  const relativeDir = `packages/${name.split("/").pop()}`;
  return {
    name,
    version,
    private: privatePackage,
    publishConfig,
    relativeDir,
    location: "workspace",
    catalogEntry: { publishable },
    packageJson: {
      name,
      version,
      private: privatePackage,
      publishConfig,
      repository: repository === undefined
        ? { ...RELEASE_REPOSITORY, directory: relativeDir }
        : repository,
      ...(nodeEngine === null ? {} : { engines: { node: nodeEngine } }),
      dependencies,
      optionalDependencies,
      peerDependencies,
      devDependencies,
    },
  };
}

function rootPackageRecord({
  dependencies = {},
  optionalDependencies = {},
  peerDependencies = {},
  devDependencies = {},
  nodeEngine = SUPPORTED_NODE_ENGINE,
} = {}) {
  return {
    engines: { node: nodeEngine },
    dependencies,
    optionalDependencies,
    peerDependencies,
    devDependencies,
  };
}

describe("release tag validation", () => {
  test("extracts semver release versions from v-prefixed tags", () => {
    expect(releaseVersionFromTag("v1.2.3")).toBe("1.2.3");
    expect(releaseVersionFromTag("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(() => releaseVersionFromTag("1.2.3")).toThrow(/must look like v1\.2\.3/);
  });
});

describe("release graph validation", () => {
  test("rejects drift from the exact source-beta package roster", () => {
    const packages = discoverPackages();
    const removed = packages.find((pkg) => pkg.name === "@mono-agent/cli");
    if (removed === undefined) throw new Error("fixture requires @mono-agent/cli");
    const unexpectedName = "@mono-agent/unexpected";
    const unexpected = {
      ...removed,
      name: unexpectedName,
      relativeDir: "packages/unexpected",
      catalogEntry: {
        ...removed.catalogEntry,
        name: unexpectedName,
        dir: "unexpected",
      },
      packageJson: {
        ...removed.packageJson,
        name: unexpectedName,
        repository: {
          ...RELEASE_REPOSITORY,
          directory: "packages/unexpected",
        },
        dependencies: {},
      },
    };

    try {
      validateRelease({
        tag: `v${removed.version}`,
        packages: [
          ...packages.filter((pkg) => pkg !== removed),
          unexpected,
        ],
        enforceSourceBetaRoster: true,
        silent: true,
      });
      throw new Error("validateRelease did not reject package roster drift");
    } catch (error) {
      expect(error.issues).toContain(
        "publishable package roster must contain exactly 23 source-beta packages; "
        + "missing: @mono-agent/cli; unexpected: @mono-agent/unexpected",
      );
    }
  });

  test("validates exact versions and returns dependency-first publish order", () => {
    const moduleSdk = packageRecord({ name: "@mono-agent/module-sdk" });
    const channel = packageRecord({
      name: "@mono-agent/channel-slack",
      dependencies: {
        "@mono-agent/module-sdk": "workspace:1.2.3",
      },
    });

    const result = validateRelease({
      tag: "v1.2.3",
      packages: [channel, moduleSdk],
      rootPackageJson: rootPackageRecord(),
      silent: true,
    });

    expect(result.version).toBe("1.2.3");
    expect(result.publishablePackages.map((pkg) => pkg.name)).toEqual([
      "@mono-agent/module-sdk",
      "@mono-agent/channel-slack",
    ]);
  });

  test("requires exact lockstep ranges in every root internal dependency section", () => {
    const moduleSdk = packageRecord({ name: "@mono-agent/module-sdk" });
    const exactRootPackageJson = rootPackageRecord({
      dependencies: { "@mono-agent/module-sdk": "workspace:1.2.3" },
      optionalDependencies: { "@mono-agent/module-sdk": "workspace:1.2.3" },
      peerDependencies: { "@mono-agent/module-sdk": "workspace:1.2.3" },
      devDependencies: {
        "@mono-agent/module-sdk": "workspace:1.2.3",
        vitest: "^3.1.4",
      },
    });

    expect(() => validateRelease({
      tag: "v1.2.3",
      packages: [moduleSdk],
      rootPackageJson: exactRootPackageJson,
      silent: true,
    })).not.toThrow();

    for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      const staleRootPackageJson = structuredClone(exactRootPackageJson);
      staleRootPackageJson[section]["@mono-agent/module-sdk"] = "workspace:1.2.2";

      try {
        validateRelease({
          tag: "v1.2.3",
          packages: [moduleSdk],
          rootPackageJson: staleRootPackageJson,
          silent: true,
        });
        throw new Error(`validateRelease did not reject the stale root ${section} reference`);
      } catch (error) {
        expect(error.issues).toEqual([
          `root package.json ${section}.@mono-agent/module-sdk must be workspace:1.2.3; found workspace:1.2.2`,
        ]);
      }
    }
  });

  test("requires exact lockstep ranges in package-local devDependencies", () => {
    const moduleSdk = packageRecord({ name: "@mono-agent/module-sdk" });
    const tui = packageRecord({
      name: "@mono-agent/tui",
      devDependencies: { "@mono-agent/module-sdk": "workspace:1.2.2" },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [moduleSdk, tui],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject the stale package devDependency");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/tui devDependencies.@mono-agent/module-sdk must be workspace:1.2.3; found workspace:1.2.2",
      ]);
    }
  });

  test("rejects packages that are not launch-ready", () => {
    const moduleSdk = packageRecord({
      name: "@mono-agent/module-sdk",
      publishConfig: null,
    });
    const channel = packageRecord({
      name: "@mono-agent/channel-slack",
      dependencies: {
        "@mono-agent/module-sdk": "workspace:*",
      },
    });
    const runtime = packageRecord({
      name: "@mono-agent/runtime-pi",
      version: "1.2.4",
    });

    expect(() =>
      validateRelease({
        tag: "v1.2.3",
        packages: [moduleSdk, channel, runtime],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      }),
    ).toThrow(
      /@mono-agent\/module-sdk publishConfig\.access must be public[\s\S]*@mono-agent\/runtime-pi version must be 1\.2\.3[\s\S]*@mono-agent\/channel-slack dependencies\.@mono-agent\/module-sdk must be workspace:1\.2\.3/,
    );
  });

  test("rejects root or publishable manifests outside the supported Node floor", () => {
    const missing = packageRecord({
      name: "@mono-agent/module-sdk",
      nodeEngine: null,
    });
    const stale = packageRecord({
      name: "@mono-agent/runtime-pi",
      nodeEngine: ">=20",
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [missing, stale],
        rootPackageJson: rootPackageRecord({ nodeEngine: ">=20" }),
        nodeVersionFile: "22.18.0",
        silent: true,
      });
      throw new Error("validateRelease did not reject stale Node engine metadata");
    } catch (error) {
      expect(error.issues).toEqual([
        "root package.json engines.node must be >=22.19.0; found >=20",
        ".nvmrc must be 22.19.0; found 22.18.0",
        "@mono-agent/module-sdk engines.node must be >=22.19.0; found (missing)",
        "@mono-agent/runtime-pi engines.node must be >=22.19.0; found >=20",
      ]);
    }
  });

  test("requires exact successor repository metadata for every publishable package", () => {
    const missing = packageRecord({
      name: "@mono-agent/module-sdk",
      repository: null,
    });
    const wrongDirectory = packageRecord({
      name: "@mono-agent/runtime-pi",
      repository: { ...RELEASE_REPOSITORY, directory: "packages/wrong" },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [missing, wrongDirectory],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject stale repository metadata");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/module-sdk repository must be git git+https://github.com/robertsreberski/mono-agent-next.git at packages/module-sdk",
        "@mono-agent/runtime-pi repository must be git git+https://github.com/robertsreberski/mono-agent-next.git at packages/runtime-pi",
      ]);
    }
  });

  test("rejects publishable packages that depend on nonpublishable workspace packages", () => {
    const privateDependency = packageRecord({
      name: "@mono-agent/private-dependency",
      publishable: false,
      privatePackage: true,
      publishConfig: null,
    });
    const privateOptional = packageRecord({
      name: "@mono-agent/private-optional",
      publishable: false,
      privatePackage: true,
      publishConfig: null,
    });
    const privatePeer = packageRecord({
      name: "@mono-agent/private-peer",
      publishable: false,
      privatePackage: true,
      publishConfig: null,
    });
    const core = packageRecord({
      name: "@mono-agent/core",
      dependencies: {
        "@mono-agent/private-dependency": "workspace:1.2.3",
      },
      optionalDependencies: {
        "@mono-agent/private-optional": "workspace:1.2.3",
      },
      peerDependencies: {
        "@mono-agent/private-peer": "workspace:1.2.3",
      },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [core, privateDependency, privateOptional, privatePeer],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject the nonpublishable workspace dependencies");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/core dependencies.@mono-agent/private-dependency points at nonpublishable workspace package @mono-agent/private-dependency",
        "@mono-agent/core optionalDependencies.@mono-agent/private-optional points at nonpublishable workspace package @mono-agent/private-optional",
        "@mono-agent/core peerDependencies.@mono-agent/private-peer points at nonpublishable workspace package @mono-agent/private-peer",
      ]);
    }
  });

  test("rejects floating Pi dependencies in every publishable consumer", () => {
    const runtime = packageRecord({
      name: "@mono-agent/runtime-pi",
      dependencies: {
        "@earendil-works/pi-agent-core": "~0.81.1",
        "@earendil-works/pi-ai": "0.81.2",
      },
    });
    const tui = packageRecord({
      name: "@mono-agent/tui",
      dependencies: { "@earendil-works/pi-tui": "^0.79.1" },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [runtime, tui],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject floating Pi dependencies");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/runtime-pi dependencies.@earendil-works/pi-agent-core must pin known-compatible version 0.81.1 exactly; found ~0.81.1",
        "@mono-agent/runtime-pi dependencies.@earendil-works/pi-ai must pin known-compatible version 0.81.1 exactly; found 0.81.2",
        "@mono-agent/tui dependencies.@earendil-works/pi-tui must pin known-compatible version 0.79.10 exactly; found ^0.79.1",
      ]);
    }
  });

  test("detects cycles before publishing", () => {
    const one = packageRecord({
      name: "@mono-agent/one",
      dependencies: { "@mono-agent/two": "workspace:1.2.3" },
    });
    const two = packageRecord({
      name: "@mono-agent/two",
      dependencies: { "@mono-agent/one": "workspace:1.2.3" },
    });

    expect(() => sortForPublish([one, two])).toThrow(/cycle in publishable package dependencies/);
  });
});

describe("release pack validation", () => {
  const pkg = packageRecord({ name: "@mono-agent/example" });

  test("parses pnpm pack JSON output", () => {
    expect(parsePnpmPackOutput(JSON.stringify({ name: pkg.name, filename: "example.tgz", files: [] }))).toEqual({
      name: pkg.name,
      filename: "example.tgz",
      files: [],
    });
  });

  test("parses pnpm 10 output with prepack lifecycle logs before the JSON document", () => {
    const json = JSON.stringify({ name: pkg.name, filename: "example.tgz", files: [] }, null, 2);
    const stdout = `\n> ${pkg.name}@1.2.3 prepack /tmp/example\n> pnpm run build\n\n${json}\n`;

    expect(parsePnpmPackOutput(stdout)).toEqual({
      name: pkg.name,
      filename: "example.tgz",
      files: [],
    });
  });

  test("asserts required files and a non-empty tarball", () => {
    const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-test-"));
    try {
      const tarballPath = path.join(packDestination, "mono-agent-example-1.2.3.tgz");
      fs.writeFileSync(tarballPath, "tgz");

      expect(
        assertPackResult(pkg, {
          name: pkg.name,
          version: "1.2.3",
          filename: tarballPath,
          files: [{ path: "package.json" }, { path: "README.md" }],
        }, packDestination),
      ).toEqual({
        fileCount: 2,
        tarballPath,
        tarballSize: 3,
      });
    } finally {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  });

  test("requires web to include its built standalone product entrypoint", () => {
    const packageName = "@mono-agent/web";
    const webPackage = packageRecord({ name: packageName });
    const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-test-"));
    try {
      const tarballPath = path.join(packDestination, `${packageName.replace("@mono-agent/", "mono-agent-")}-1.2.3.tgz`);
      fs.writeFileSync(tarballPath, "tgz");

      expect(() =>
        assertPackResult(webPackage, {
          name: webPackage.name,
          version: "1.2.3",
          filename: tarballPath,
          files: [{ path: "package.json" }, { path: "README.md" }],
        }, packDestination),
      ).toThrow(/dist\/index\.js/);
    } finally {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  });

  test("rejects pack output without a tarball", () => {
    const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-test-"));
    try {
      expect(() =>
        assertPackResult(pkg, {
          name: pkg.name,
          version: "1.2.3",
          filename: "missing.tgz",
          files: [{ path: "package.json" }, { path: "README.md" }],
        }, packDestination),
      ).toThrow(/did not create/);
    } finally {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  });
});

describe("current launch manifest", () => {
  test("discovers exactly the 23 source-beta packages and no retired v0 package", () => {
    const publishable = discoverPackages().filter((pkg) => pkg.catalogEntry.publishable);
    const publishableNames = publishable.map((pkg) => pkg.name);
    const retiredV0Names = [
      "@mono-agent/agent-app",
      "@mono-agent/agent-contracts",
      "@mono-agent/agent-harness",
      "@mono-agent/agent-runtime",
      "@mono-agent/channel-cron",
      "@mono-agent/config",
      "@mono-agent/observability",
      "@mono-agent/operator-adapter",
      "@mono-agent/runtime-adapter",
    ];

    expect(publishable).toHaveLength(23);
    expect(expectedPublishablePackageCount).toBe(23);
    expect([...publishableNames].sort()).toEqual([...SOURCE_BETA_RELEASE_PACKAGE_NAMES].sort());
    expect(expectedPublishablePackageNames).toEqual([...SOURCE_BETA_RELEASE_PACKAGE_NAMES].sort());
    for (const retiredName of retiredV0Names) {
      expect(publishableNames, retiredName).not.toContain(retiredName);
    }
  });

  test("keeps docs-mcp as the only explicitly paired plugin extra", () => {
    const plugins = packageCatalog.filter((entry) => entry.tier === "plugin");
    const plugin = plugins[0];
    expect(plugin).toMatchObject({
      name: "@mono-agent/docs-mcp",
      path: "extras/docs-mcp",
      publishable: true,
      tier: "plugin",
    });
    expect(plugins).toHaveLength(1);

    const core = JSON.parse(fs.readFileSync(
      new URL("../../../packages/core/package.json", import.meta.url),
      "utf8",
    ));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      expect(core[section]?.["@mono-agent/docs-mcp"]).toBeUndefined();
    }
  });

  test("validates the repository for its current release tag", async () => {
    // Derive the version from a workspace manifest so this test keeps
    // validating the real repository state across version bumps.
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(new URL("../../../packages/module-sdk/package.json", import.meta.url), "utf8"));

    const result = validateRelease({ tag: `v${version}`, silent: true });

    expect(result.publishablePackages).toHaveLength(expectedPublishablePackageCount);
    expect(result.publishablePackages.map((pkg) => pkg.name).sort()).toEqual(expectedPublishablePackageNames);
    expect(result.publishablePackages.every((pkg) => pkg.version === version)).toBe(true);
  });

  test("keeps runtime-pi and TUI manifests aligned with the enforced exact pins", () => {
    const runtimePi = JSON.parse(fs.readFileSync(
      new URL("../../../packages/runtime-pi/package.json", import.meta.url),
      "utf8",
    ));
    const tui = JSON.parse(fs.readFileSync(
      new URL("../../../packages/tui/package.json", import.meta.url),
      "utf8",
    ));
    const piAi = PINNED_RUNTIME_DEPENDENCIES["@earendil-works/pi-ai"];
    const piCore = PINNED_RUNTIME_DEPENDENCIES["@earendil-works/pi-agent-core"];
    const piTui = PINNED_RUNTIME_DEPENDENCIES["@earendil-works/pi-tui"];

    expect(piCore).toBe(piAi);
    expect(runtimePi.dependencies["@earendil-works/pi-ai"]).toBe(piAi);
    expect(runtimePi.dependencies["@earendil-works/pi-agent-core"]).toBe(piCore);
    expect(tui.dependencies["@earendil-works/pi-tui"]).toBe(piTui);
  });

  test("keeps the release workflow statically ready for npm OIDC without claiming tokenless promotion", () => {
    const workflow = fs.readFileSync(
      new URL("../../../.github/workflows/npm-release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("node scripts/release/check-publish-guard.mjs");
    expect(workflow).toContain("npm install --global npm@11.12.1");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("pnpm run release:publish -- --tag \"$GITHUB_REF_NAME\"");
  });
});

describe("hardened local release publish", () => {
  const head = "a".repeat(40);
  const other = "b".repeat(40);

  function fakeGit(responses, calls = []) {
    return (command, args, options) => {
      const gitArgs = args[0] === "-C" ? args.slice(2) : args;
      const key = gitArgs.join(" ");
      calls.push({ command, args, key, options });
      const response = responses[key];
      if (response === undefined) {
        return { status: 1, stdout: "", stderr: `unexpected git call: ${key}` };
      }
      return typeof response === "string"
        ? { status: 0, stdout: response, stderr: "" }
        : response;
    };
  }

  test("requires a clean HEAD at the exact requested release tag", () => {
    const cleanTagged = fakeGit({
      "rev-parse --show-toplevel": `${REPO_ROOT}\n`,
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": `${head}\n`,
      "rev-parse --verify refs/tags/v1.2.3^{commit}": `${head}\n`,
    });
    expect(assertReleaseGitState("v1.2.3", { spawn: cleanTagged, repo: REPO_ROOT })).toBe(head);

    const dirty = fakeGit({
      "rev-parse --show-toplevel": `${REPO_ROOT}\n`,
      "status --porcelain=v1 --untracked-files=all": " M package.json\n",
    });
    expect(() => assertReleaseGitState("v1.2.3", { spawn: dirty, repo: REPO_ROOT }))
      .toThrow(/HEAD is not clean/u);

    const wrongTag = fakeGit({
      "rev-parse --show-toplevel": `${REPO_ROOT}\n`,
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": `${head}\n`,
      "rev-parse --verify refs/tags/v1.2.3^{commit}": `${other}\n`,
    });
    expect(() => assertReleaseGitState("v1.2.3", { spawn: wrongTag, repo: REPO_ROOT }))
      .toThrow(/does not point at HEAD/u);
  });

  test("ignores PATH-shadow Git and ambient repository overrides", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-git-target-"));
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-git-decoy-"));
    const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-git-shadow-"));
    const sentinel = path.join(shadow, "invoked");
    const git = resolveTrustedGitExecutable();
    const runGit = (repo, args) => {
      const result = spawnSync(git, ["-C", repo, ...args], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
      if (result.status !== 0) {
        throw new Error(`test Git command failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    const initialize = (repo, contents) => {
      runGit(repo, ["init", "--quiet"]);
      fs.writeFileSync(path.join(repo, "proof.txt"), contents);
      runGit(repo, ["add", "proof.txt"]);
      runGit(repo, [
        "-c", "user.name=Release Test",
        "-c", "user.email=release-test@example.invalid",
        "commit", "--quiet", "-m", "proof",
      ]);
      runGit(repo, ["tag", "v1.2.3"]);
      return runGit(repo, ["rev-parse", "HEAD"]);
    };

    try {
      const targetHead = initialize(target, "target\n");
      initialize(decoy, "decoy\n");
      fs.writeFileSync(
        path.join(shadow, "git"),
        `#!/bin/sh\nprintf invoked > "${sentinel}"\nexit 97\n`,
        { mode: 0o700 },
      );

      expect(assertReleaseGitState("v1.2.3", {
        repo: target,
        envSource: {
          ...process.env,
          PATH: shadow,
          GIT_DIR: path.join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
        },
      })).toBe(targetHead);
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(decoy, { recursive: true, force: true });
      fs.rmSync(shadow, { recursive: true, force: true });
    }
  });

  test("requires build provenance for the exact clean HEAD", () => {
    expect(() => assertBuildMarkerForHead({ gitSha: other, sourceState: "clean" }, head))
      .toThrow(/build provenance is for/u);
    expect(() => assertBuildMarkerForHead({ gitSha: head, sourceState: "dirty" }, head))
      .toThrow(/sourceState must be clean/u);
    expect(() => assertBuildMarkerForHead({ gitSha: head, sourceState: "clean" }, head))
      .not.toThrow();
  });

  test("safely verifies current build output and dependency digests", () => {
    const marker = {
      gitSha: head,
      sourceState: "clean",
      outputDigest: "output-digest",
      dependencyDigest: "dependency-digest",
    };
    const report = { status: "ok", marker, fingerprint: "marker-fingerprint" };
    const valid = {
      repo: "/repo",
      readMarker: () => report,
      computeOutputDigest: () => "output-digest",
      computeDependencyDigest: () => "dependency-digest",
    };
    expect(() => assertCurrentBuildProvenance(head, valid)).not.toThrow();
    expect(() => assertCurrentBuildProvenance(head, {
      ...valid,
      readMarker: () => ({ status: "unsafe" }),
    })).toThrow(/marker is unsafe/u);
    expect(() => assertCurrentBuildProvenance(head, {
      ...valid,
      computeOutputDigest: () => "changed-after-pack",
    })).toThrow(/output digest does not match/u);
    expect(() => assertCurrentBuildProvenance(head, {
      ...valid,
      computeDependencyDigest: () => "changed-dependencies",
    })).toThrow(/dependency digest does not match/u);

    let reads = 0;
    expect(() => assertCurrentBuildProvenance(head, {
      ...valid,
      readMarker: () => ({
        ...report,
        fingerprint: reads++ === 0 ? "marker-fingerprint" : "replacement-fingerprint",
      }),
    })).toThrow(/marker changed during verification/u);
  });

  test("records schema-v2 provenance for the exact stable release build", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-provenance-"));
    const completedAt = "2026-07-25T12:34:56.000Z";
    const outputDigest = "c".repeat(64);
    const dependencyDigest = "d".repeat(64);
    const operations = [];
    try {
      expect(runReleaseBuildWithProvenance("v1.2.3", {
        repo: directory,
        now: () => new Date(completedAt),
        assertGitState: () => {
          operations.push("git");
          return head;
        },
        runBuild: () => operations.push("build"),
        computeDeploymentFingerprint: () => {
          operations.push("deployment");
          return "stable-deployment";
        },
        computeOutputDigest: (_repo, options) => {
          operations.push(`output:${options.sync}`);
          return outputDigest;
        },
        computeDependencyDigest: () => {
          operations.push("dependency");
          return dependencyDigest;
        },
      })).toBe(head);

      expect(JSON.parse(
        fs.readFileSync(path.join(directory, ".mono-agent-build.json"), "utf8"),
      )).toEqual({
        schemaVersion: 2,
        gitSha: head,
        completedAt,
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules,
        sourceState: "clean",
        outputDigest,
        dependencyDigest,
      });
      expect(operations).toEqual([
        "git",
        "build",
        "git",
        "deployment",
        "output:true",
        "dependency",
        "git",
        "deployment",
        "git",
        "deployment",
      ]);
      expect(fs.existsSync(path.join(directory, ".mono-agent-build.lock"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects deployment-state drift during release build attestation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-drift-"));
    let deploymentState = "before";
    try {
      expect(() => runReleaseBuildWithProvenance("v1.2.3", {
        repo: directory,
        assertGitState: () => head,
        runBuild: () => {},
        computeDeploymentFingerprint: () => deploymentState,
        computeOutputDigest: () => "c".repeat(64),
        computeDependencyDigest: () => "d".repeat(64),
        afterDeploymentDigests: () => {
          deploymentState = "after";
        },
      })).toThrow(/deployment state changed during build attestation/u);
      expect(fs.existsSync(path.join(directory, ".mono-agent-build.json"))).toBe(false);
      expect(fs.existsSync(path.join(directory, ".mono-agent-build.lock"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("invalidates provenance when the exact release HEAD races publication", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-source-race-"));
    let gitChecks = 0;
    try {
      expect(() => runReleaseBuildWithProvenance("v1.2.3", {
        repo: directory,
        assertGitState: () => {
          gitChecks += 1;
          return gitChecks === 4 ? other : head;
        },
        runBuild: () => {},
        computeDeploymentFingerprint: () => "stable-deployment",
        computeOutputDigest: () => "c".repeat(64),
        computeDependencyDigest: () => "d".repeat(64),
      })).toThrow(/HEAD changed during build provenance publication/u);
      expect(fs.existsSync(path.join(directory, ".mono-agent-build.json"))).toBe(false);
      expect(fs.existsSync(path.join(directory, ".mono-agent-build.lock"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves the lock when failure-path marker invalidation cannot be proven", () => {
    const lock = { id: "held-lock" };
    const operations = [];
    let clearCalls = 0;
    expect(() => runReleaseBuildWithProvenance("v1.2.3", {
      repo: "/repo",
      acquireLock: () => {
        operations.push("acquire");
        return lock;
      },
      clearMarker: () => {
        clearCalls += 1;
        operations.push(`clear:${clearCalls}`);
        if (clearCalls === 2) throw new Error("marker unlink failed");
      },
      preserveLock: (_repo, currentLock) => {
        operations.push(`preserve:${currentLock.id}`);
      },
      releaseLock: () => operations.push("release"),
      assertGitState: () => head,
      runBuild: () => {
        operations.push("build");
        throw new Error("build failed");
      },
    })).toThrow(/failed to invalidate build provenance/u);
    expect(operations).toEqual([
      "acquire",
      "clear:1",
      "build",
      "clear:2",
      "preserve:held-lock",
    ]);
  });

  test("restores a fail-closed lock when release and marker cleanup both fail", () => {
    const lock = { id: "release-failed-lock" };
    const operations = [];
    let clearCalls = 0;
    expect(() => runReleaseBuildWithProvenance("v1.2.3", {
      repo: "/repo",
      acquireLock: () => lock,
      clearMarker: () => {
        clearCalls += 1;
        operations.push(`clear:${clearCalls}`);
        if (clearCalls === 2) throw new Error("marker unlink failed");
      },
      preserveLock: (_repo, currentLock) => {
        operations.push(`preserve:${currentLock.id}`);
      },
      releaseLock: () => {
        operations.push("release");
        throw new Error("lock release failed");
      },
      assertGitState: () => head,
      runBuild: () => {},
      computeDeploymentFingerprint: () => "stable-deployment",
      computeOutputDigest: () => "c".repeat(64),
      computeDependencyDigest: () => "d".repeat(64),
      publishMarker: () => operations.push("publish"),
    })).toThrow(/marker invalidation failed closed/u);
    expect(operations).toEqual([
      "clear:1",
      "publish",
      "release",
      "clear:2",
      "preserve:release-failed-lock",
    ]);
  });

  test("computes npm-compatible SHA-512 tarball integrity", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-integrity-test-"));
    try {
      const tarball = path.join(directory, "package.tgz");
      fs.writeFileSync(tarball, "frozen release bytes");
      expect(computeTarballIntegrity(tarball)).toBe(
        "sha512-Rm9vf6vSGsnWmxOMBDQxmAB/WyIo6WnAERp7+O/ixVBit2plzZWpw2uzuFy6ZWhJGRdyfGe/c2prtLyvCT8hKw==",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("pins npm to the public registry and removes ambient proxy registry config", () => {
    const env = publicNpmEnvironment({
      PATH: "/bin",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9999/",
      npm_config_userconfig: "/home/user/.npmrc",
      "npm_config_@mono-agent:registry": "http://127.0.0.1:9999/",
      NODE_AUTH_TOKEN: "not-a-real-token",
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY,
      NPM_CONFIG_USERCONFIG: "/dev/null",
      "npm_config_@mono-agent:registry": PUBLIC_NPM_REGISTRY,
      "npm_config_//registry.npmjs.org/:_authToken": "not-a-real-token",
    });
    expect(env.npm_config_userconfig).toBeUndefined();
    expect(env.NODE_AUTH_TOKEN).toBeUndefined();
  });

  test("scrubs npm credentials from git, build, and pack subprocesses", () => {
    const authKey = "npm_config_//registry.npmjs.org/:_authToken";
    const envSource = {
      PATH: "/bin",
      NODE_AUTH_TOKEN: "not-a-real-token",
      NPM_TOKEN: "not-a-real-token",
      NPM_DEV_TOKEN: "not-a-real-token",
      [authKey]: "not-a-real-token",
    };
    const childEnvironments = [];
    const gitCalls = [];
    const cleanTagged = fakeGit({
      "rev-parse --show-toplevel": `${REPO_ROOT}\n`,
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": `${head}\n`,
      "rev-parse --verify refs/tags/v1.2.3^{commit}": `${head}\n`,
    }, gitCalls);
    assertReleaseGitState("v1.2.3", {
      spawn: cleanTagged,
      repo: REPO_ROOT,
      envSource,
    });
    childEnvironments.push(...gitCalls.map((call) => ({ kind: "git", env: call.options.env })));

    runWorkspaceBuild({
      repo: REPO_ROOT,
      envSource,
      log: () => {},
      spawn: (_command, _args, options) => {
        childEnvironments.push({ kind: "build", env: options.env });
        return { status: 0 };
      },
    });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-pack-env-test-"));
    try {
      freezeReleaseTarballs(
        [{ name: "@mono-agent/example", version: "1.2.3" }],
        directory,
        {
          envSource,
          log: () => {},
          spawn: (_command, _args, options) => {
            childEnvironments.push({ kind: "pack", env: options.env });
            return { status: 0, stdout: "", stderr: "" };
          },
          pack: (pkg, destination, packOptions) => {
            packOptions.spawn("pnpm", ["pack"], { encoding: "utf8" });
            const tarballPath = path.join(destination, "example.tgz");
            fs.writeFileSync(tarballPath, "tarball");
            return { name: pkg.name, version: pkg.version, tarballPath };
          },
        },
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(childEnvironments.length).toBeGreaterThan(0);
    for (const { env } of childEnvironments) {
      expect(env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(env.NPM_TOKEN).toBeUndefined();
      expect(env.NPM_DEV_TOKEN).toBeUndefined();
      expect(env[authKey]).toBeUndefined();
    }
    for (const { env } of childEnvironments.filter(({ kind }) => kind === "git")) {
      expect(env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
    }
    expect(childEnvironments.find(({ kind }) => kind === "build").env.PATH)
      .toBe([path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter));
    expect(childEnvironments.find(({ kind }) => kind === "pack").env.PATH).toBe("/bin");
  });

  test("ignores a shadow pnpm and invokes the validated entrypoint through current Node", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-pnpm-repo-"));
    const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-pnpm-shadow-"));
    const sentinel = path.join(shadow, "invoked");
    const proof = path.join(repo, "build-proof");
    try {
      fs.writeFileSync(
        path.join(repo, "package.json"),
        `${JSON.stringify({
          name: "release-pnpm-proof",
          version: "0.0.0",
          private: true,
          scripts: { build: "node build.mjs" },
        })}\n`,
      );
      fs.writeFileSync(
        path.join(repo, "build.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(proof)}, process.execPath);\n`,
      );
      fs.writeFileSync(
        path.join(shadow, "pnpm"),
        `#!/bin/sh\nprintf invoked > "${sentinel}"\nexit 0\n`,
        { mode: 0o700 },
      );
      runWorkspaceBuild({
        repo,
        envSource: { PATH: shadow },
        log: () => {},
      });
      expect(fs.realpathSync.native(fs.readFileSync(proof, "utf8")))
        .toBe(fs.realpathSync.native(process.execPath));
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(shadow, { recursive: true, force: true });
    }
  });

  test("resolves trusted pnpm authority under the direct Node release entrypoint", () => {
    const moduleUrl = new URL("../publish-release.mjs", import.meta.url).href;
    const script = [
      `process.argv[1] = ${JSON.stringify(path.join(REPO_ROOT, "direct-node-release-probe.mjs"))};`,
      `const { resolveTrustedPnpmEntrypoint } = await import(${JSON.stringify(moduleUrl)});`,
      `process.stdout.write(resolveTrustedPnpmEntrypoint(${JSON.stringify(REPO_ROOT)}));`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status, result.stderr).toBe(0);
    const entrypoint = fs.realpathSync.native(result.stdout.trim());
    expect(path.isAbsolute(entrypoint)).toBe(true);
    expect(path.relative(REPO_ROOT, entrypoint)).toMatch(/^\.\./u);
  });

  test("pins build shebang resolution to the marker-producing Node", () => {
    const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-node-shadow-"));
    const sentinel = path.join(shadow, "invoked");
    const probePath = path.join(shadow, "node-probe");
    let childNode;
    try {
      fs.writeFileSync(
        path.join(shadow, "node"),
        `#!/bin/sh\nprintf invoked > "${sentinel}"\nexit 97\n`,
        { mode: 0o700 },
      );
      fs.writeFileSync(
        probePath,
        "#!/usr/bin/env node\nprocess.stdout.write(process.execPath);\n",
        { mode: 0o700 },
      );
      runWorkspaceBuild({
        repo: REPO_ROOT,
        envSource: {
          PATH: shadow,
          NODE_AUTH_TOKEN: "not-a-real-token",
          NPM_TOKEN: "not-a-real-token",
        },
        log: () => {},
        spawn: (command, args, options) => {
          expect(command).toBe(process.execPath);
          expect(args.slice(1)).toEqual(["run", "build"]);
          const probe = spawnSync(probePath, [], {
            encoding: "utf8",
            env: options.env,
          });
          expect(probe.status).toBe(0);
          childNode = probe.stdout.trim();
          expect(options.env.NODE_AUTH_TOKEN).toBeUndefined();
          expect(options.env.NPM_TOKEN).toBeUndefined();
          return { status: 0 };
        },
      });
      expect(fs.realpathSync.native(childNode)).toBe(fs.realpathSync.native(process.execPath));
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(shadow, { recursive: true, force: true });
    }
  });

  test("fails a partial retry on integrity mismatch before any registry mutation", async () => {
    const frozenPackages = [
      { name: "@mono-agent/a", version: "1.2.3", integrity: "sha512-a" },
      { name: "@mono-agent/b", version: "1.2.3", integrity: "sha512-b" },
    ];
    const mutations = [];

    await expect(executeFrozenPublish({
      frozenPackages,
      dryRun: false,
      stagingTag: "mono-agent-stage-1-2-3",
      finalDistTag: "latest",
      readIntegrity: (pkg) => (pkg.name.endsWith("/a") ? "sha512-wrong" : null),
      publishTarball: (pkg) => mutations.push(`publish:${pkg.name}`),
      waitForIntegrity: (pkg) => pkg.integrity,
      promote: (pkg) => mutations.push(`promote:${pkg.name}`),
      log: () => {},
    })).rejects.toThrow(/exists with integrity sha512-wrong/u);
    expect(mutations).toEqual([]);
  });

  test("stages missing packages, verifies the complete set, then promotes", async () => {
    const frozenPackages = [
      { name: "@mono-agent/a", version: "1.2.3", integrity: "sha512-a" },
      { name: "@mono-agent/b", version: "1.2.3", integrity: "sha512-b" },
    ];
    const operations = [];

    await executeFrozenPublish({
      frozenPackages,
      dryRun: false,
      stagingTag: "mono-agent-stage-1-2-3",
      finalDistTag: "latest",
      readIntegrity: (pkg) => {
        operations.push(`inspect:${pkg.name}`);
        return pkg.name.endsWith("/a") ? pkg.integrity : null;
      },
      publishTarball: (pkg, options) => {
        operations.push(`publish:${pkg.name}:${options.distTag}`);
      },
      waitForIntegrity: (pkg) => {
        operations.push(`verify:${pkg.name}`);
        return pkg.integrity;
      },
      promote: (pkg, distTag) => {
        operations.push(`promote:${pkg.name}:${distTag}`);
      },
      log: () => {},
    });

    expect(operations).toEqual([
      "inspect:@mono-agent/a",
      "inspect:@mono-agent/b",
      "publish:@mono-agent/b:mono-agent-stage-1-2-3",
      "verify:@mono-agent/a",
      "verify:@mono-agent/b",
      "promote:@mono-agent/a:latest",
      "promote:@mono-agent/b:latest",
    ]);
    expect(stagingDistTagForRelease("v1.2.3-beta.1")).toBe("mono-agent-stage-1-2-3-beta-1");
  });

  test("keeps dry-run publication non-mutating and skips registry inspection", async () => {
    const frozenPackages = [
      { name: "@mono-agent/a", version: "1.2.3", integrity: "sha512-a" },
    ];
    const operations = [];

    await executeFrozenPublish({
      frozenPackages,
      dryRun: true,
      stagingTag: "mono-agent-stage-1-2-3",
      finalDistTag: "latest",
      readIntegrity: () => {
        throw new Error("dry run must not inspect npm");
      },
      publishTarball: (pkg, options) => operations.push({ name: pkg.name, ...options }),
      waitForIntegrity: () => {
        throw new Error("dry run must not wait for npm");
      },
      promote: () => {
        throw new Error("dry run must not promote");
      },
      log: () => {},
    });

    expect(operations).toEqual([{
      name: "@mono-agent/a",
      distTag: "mono-agent-stage-1-2-3",
      dryRun: true,
    }]);
  });

  test("uses force only for credential-free npm dry runs of immutable versions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mono-agent-release-dry-run-"));
    const tarballPath = path.join(directory, "package.tgz");
    fs.writeFileSync(tarballPath, "immutable tarball");
    const pkg = {
      name: "@mono-agent/example",
      version: "1.2.3",
      publishConfig: { access: "public" },
      tarballPath,
      integrity: computeTarballIntegrity(tarballPath),
    };
    const invocations = [];
    const spawn = (command, args, options) => {
      invocations.push({ command, args, cwd: options.cwd, env: options.env });
      return { status: 0 };
    };

    try {
      publishFrozenTarball(pkg, {
        distTag: "mono-agent-stage-1-2-3",
        dryRun: true,
        npmEnvSource: {
          NODE_AUTH_TOKEN: "not-a-real-node-token",
          NPM_TOKEN: "not-a-real-dry-run-token",
          NPM_DEV_TOKEN: "not-a-real-dev-token",
          NPM_AUTH_TOKEN: "not-a-real-auth-token",
          NPM_ID_TOKEN: "not-a-real-id-token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "not-a-real-oidc-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/",
          SIGSTORE_ID_TOKEN: "not-a-real-sigstore-token",
          NPM_CONFIG__AUTH: "not-a-real-basic-auth",
          NPM_CONFIG_OTP: "123456",
          "npm_config_//registry.npmjs.org/:_auth": "not-a-real-scoped-auth",
          "npm_config_//registry.npmjs.org/:username": "not-a-real-user",
          "npm_config_//registry.npmjs.org/:_password": "not-a-real-password",
          "npm_config_//registry.npmjs.org/:certfile": "/private/cert",
          "npm_config_//registry.npmjs.org/:keyfile": "/private/key",
        },
        spawn,
      });
      publishFrozenTarball(pkg, {
        distTag: "latest",
        dryRun: false,
        npmEnvSource: {
          NPM_TOKEN: "not-a-real-publish-token",
          NPM_CONFIG_FORCE: "true",
          npm_config_dry_run: "true",
        },
        spawn,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(invocations).toHaveLength(2);
    expect(invocations[0].command).toBe("npm");
    expect(invocations[0].args).toEqual(expect.arrayContaining(["--dry-run", "--force"]));
    expect(invocations[0].args).toEqual(expect.arrayContaining([
      "--userconfig", "/dev/null", "--globalconfig", EMPTY_NPM_GLOBAL_CONFIG,
    ]));
    expect(invocations[0].env).toMatchObject({
      NPM_CONFIG_USERCONFIG: "/dev/null",
      NPM_CONFIG_GLOBALCONFIG: EMPTY_NPM_GLOBAL_CONFIG,
    });
    for (const key of [
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
      "NPM_DEV_TOKEN",
      "NPM_AUTH_TOKEN",
      "NPM_ID_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "SIGSTORE_ID_TOKEN",
      "NPM_CONFIG__AUTH",
      "NPM_CONFIG_OTP",
      "npm_config_//registry.npmjs.org/:_auth",
      "npm_config_//registry.npmjs.org/:username",
      "npm_config_//registry.npmjs.org/:_password",
      "npm_config_//registry.npmjs.org/:certfile",
      "npm_config_//registry.npmjs.org/:keyfile",
    ]) {
      expect(invocations[0].env[key], key).toBeUndefined();
    }
    expect(invocations[0].cwd).toBe(directory);
    expect(invocations[1].args).not.toContain("--dry-run");
    expect(invocations[1].args).not.toContain("--force");
    expect(invocations[1].env.NPM_CONFIG_FORCE).toBeUndefined();
    expect(invocations[1].env.npm_config_force).toBeUndefined();
    expect(invocations[1].env.npm_config_dry_run).toBeUndefined();
    expect(invocations[1].env["npm_config_//registry.npmjs.org/:_authToken"])
      .toBe("not-a-real-publish-token");
  });
});

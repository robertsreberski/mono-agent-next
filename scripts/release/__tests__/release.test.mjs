import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";
import { PINNED_RUNTIME_DEPENDENCIES } from "../dependency-policy.mjs";
import {
  discoverPackages,
  sortForPublish,
} from "../package-graph.mjs";
import {
  assertPackResult,
  parsePnpmPackOutput,
} from "../pack-release.mjs";
import {
  RELEASE_REPOSITORY,
  releaseVersionFromTag,
  validateRelease,
} from "../validate-release.mjs";
import {
  PUBLIC_NPM_REGISTRY,
  assertBuildMarkerForHead,
  assertCurrentBuildProvenance,
  assertReleaseGitState,
  computeTarballIntegrity,
  executeFrozenPublish,
  freezeReleaseTarballs,
  publicNpmEnvironment,
  runWorkspaceBuild,
  stagingDistTagForRelease,
} from "../publish-release.mjs";
import { SUPPORTED_NODE_ENGINE } from "../../node-version.mjs";

const expectedPublishablePackages = packageCatalog.filter((entry) => entry.publishable === true);
const expectedPublishablePackageCount = expectedPublishablePackages.length;
const expectedPublishablePackageNames = expectedPublishablePackages.map((entry) => entry.name).sort();

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
  test("validates exact versions and returns dependency-first publish order", () => {
    const contracts = packageRecord({ name: "@mono-agent/agent-contracts" });
    const adapter = packageRecord({
      name: "@mono-agent/slack-adapter",
      dependencies: {
        "@mono-agent/agent-contracts": "workspace:1.2.3",
      },
    });

    const result = validateRelease({
      tag: "v1.2.3",
      packages: [adapter, contracts],
      rootPackageJson: rootPackageRecord(),
      silent: true,
    });

    expect(result.version).toBe("1.2.3");
    expect(result.publishablePackages.map((pkg) => pkg.name)).toEqual([
      "@mono-agent/agent-contracts",
      "@mono-agent/slack-adapter",
    ]);
  });

  test("requires exact lockstep ranges in every root internal dependency section", () => {
    const contracts = packageRecord({ name: "@mono-agent/agent-contracts" });
    const exactRootPackageJson = rootPackageRecord({
      dependencies: { "@mono-agent/agent-contracts": "workspace:1.2.3" },
      optionalDependencies: { "@mono-agent/agent-contracts": "workspace:1.2.3" },
      peerDependencies: { "@mono-agent/agent-contracts": "workspace:1.2.3" },
      devDependencies: {
        "@mono-agent/agent-contracts": "workspace:1.2.3",
        vitest: "^3.1.4",
      },
    });

    expect(() => validateRelease({
      tag: "v1.2.3",
      packages: [contracts],
      rootPackageJson: exactRootPackageJson,
      silent: true,
    })).not.toThrow();

    for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      const staleRootPackageJson = structuredClone(exactRootPackageJson);
      staleRootPackageJson[section]["@mono-agent/agent-contracts"] = "workspace:1.2.2";

      try {
        validateRelease({
          tag: "v1.2.3",
          packages: [contracts],
          rootPackageJson: staleRootPackageJson,
          silent: true,
        });
        throw new Error(`validateRelease did not reject the stale root ${section} reference`);
      } catch (error) {
        expect(error.issues).toEqual([
          `root package.json ${section}.@mono-agent/agent-contracts must be workspace:1.2.3; found workspace:1.2.2`,
        ]);
      }
    }
  });

  test("requires exact lockstep ranges in package-local devDependencies", () => {
    const contracts = packageRecord({ name: "@mono-agent/agent-contracts" });
    const tui = packageRecord({
      name: "@mono-agent/tui",
      devDependencies: { "@mono-agent/agent-contracts": "workspace:1.2.2" },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [contracts, tui],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject the stale package devDependency");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/tui devDependencies.@mono-agent/agent-contracts must be workspace:1.2.3; found workspace:1.2.2",
      ]);
    }
  });

  test("rejects packages that are not launch-ready", () => {
    const contracts = packageRecord({
      name: "@mono-agent/agent-contracts",
      publishConfig: null,
    });
    const adapter = packageRecord({
      name: "@mono-agent/slack-adapter",
      dependencies: {
        "@mono-agent/agent-contracts": "workspace:*",
      },
    });
    const runtime = packageRecord({
      name: "@mono-agent/agent-runtime",
      version: "1.2.4",
    });

    expect(() =>
      validateRelease({
        tag: "v1.2.3",
        packages: [contracts, adapter, runtime],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      }),
    ).toThrow(
      /@mono-agent\/agent-contracts publishConfig\.access must be public[\s\S]*@mono-agent\/agent-runtime version must be 1\.2\.3[\s\S]*@mono-agent\/slack-adapter dependencies\.@mono-agent\/agent-contracts must be workspace:1\.2\.3/,
    );
  });

  test("rejects root or publishable manifests outside the supported Node floor", () => {
    const missing = packageRecord({
      name: "@mono-agent/agent-contracts",
      nodeEngine: null,
    });
    const stale = packageRecord({
      name: "@mono-agent/agent-runtime",
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
        "@mono-agent/agent-contracts engines.node must be >=22.19.0; found (missing)",
        "@mono-agent/agent-runtime engines.node must be >=22.19.0; found >=20",
      ]);
    }
  });

  test("requires exact public repository metadata for every publishable package", () => {
    const missing = packageRecord({
      name: "@mono-agent/agent-contracts",
      repository: null,
    });
    const wrongDirectory = packageRecord({
      name: "@mono-agent/agent-runtime",
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
        "@mono-agent/agent-contracts repository must be git git+https://github.com/robertsreberski/mono-agent.git at packages/agent-contracts",
        "@mono-agent/agent-runtime repository must be git git+https://github.com/robertsreberski/mono-agent.git at packages/agent-runtime",
      ]);
    }
  });

  test("rejects publishable packages that depend on nonpublishable workspace packages", () => {
    const a2a = packageRecord({
      name: "@mono-agent/a2a-adapter",
      publishable: false,
      privatePackage: true,
      publishConfig: null,
    });
    const orchestrator = packageRecord({
      name: "@mono-agent/agent-orchestrator",
      publishable: false,
      privatePackage: true,
      publishConfig: null,
    });
    const whatsapp = packageRecord({
      name: "@mono-agent/whatsapp-adapter",
      publishable: false,
      privatePackage: true,
      publishConfig: null,
    });
    const app = packageRecord({
      name: "@mono-agent/agent-app",
      dependencies: {
        "@mono-agent/a2a-adapter": "workspace:1.2.3",
      },
      optionalDependencies: {
        "@mono-agent/agent-orchestrator": "workspace:1.2.3",
      },
      peerDependencies: {
        "@mono-agent/whatsapp-adapter": "workspace:1.2.3",
      },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [app, a2a, orchestrator, whatsapp],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject the nonpublishable workspace dependencies");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/agent-app dependencies.@mono-agent/a2a-adapter points at nonpublishable workspace package @mono-agent/a2a-adapter",
        "@mono-agent/agent-app optionalDependencies.@mono-agent/agent-orchestrator points at nonpublishable workspace package @mono-agent/agent-orchestrator",
        "@mono-agent/agent-app peerDependencies.@mono-agent/whatsapp-adapter points at nonpublishable workspace package @mono-agent/whatsapp-adapter",
      ]);
    }
  });

  test("rejects floating Pi dependencies in every publishable consumer", () => {
    const app = packageRecord({
      name: "@mono-agent/agent-app",
      dependencies: { "@earendil-works/pi-ai": "^0.80.6" },
    });
    const runtime = packageRecord({
      name: "@mono-agent/agent-runtime",
      dependencies: {
        "@earendil-works/pi-agent-core": "~0.80.6",
        "@earendil-works/pi-ai": "0.80.8",
      },
    });
    const tui = packageRecord({
      name: "@mono-agent/tui",
      dependencies: { "@earendil-works/pi-tui": "^0.79.1" },
    });

    try {
      validateRelease({
        tag: "v1.2.3",
        packages: [app, runtime, tui],
        rootPackageJson: rootPackageRecord(),
        silent: true,
      });
      throw new Error("validateRelease did not reject floating Pi dependencies");
    } catch (error) {
      expect(error.issues).toEqual([
        "@mono-agent/agent-app dependencies.@earendil-works/pi-ai must pin known-compatible version 0.80.6 exactly; found ^0.80.6",
        "@mono-agent/agent-runtime dependencies.@earendil-works/pi-agent-core must pin known-compatible version 0.80.6 exactly; found ~0.80.6",
        "@mono-agent/agent-runtime dependencies.@earendil-works/pi-ai must pin known-compatible version 0.80.6 exactly; found 0.80.8",
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

  test("requires web to include its built PWA assets", () => {
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
      ).toThrow(/webapp\/dist\/index\.html/);
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
  test("discovers all catalog-publishable packages", () => {
    const publishable = discoverPackages().filter((pkg) => pkg.catalogEntry.publishable);
    const publishableNames = publishable.map((pkg) => pkg.name);

    expect(publishable).toHaveLength(expectedPublishablePackageCount);
    expect([...publishableNames].sort()).toEqual(expectedPublishablePackageNames);
    expect(publishableNames).toContain("@mono-agent/tui");
    expect(publishableNames).toContain("@mono-agent/memory-supermemory");
    expect(publishableNames).not.toContain(`@mono-agent/${"agent"}-${"host"}`);
    // memory-mcp was retired: the BuJo recall tool is now auto-provisioned in-app
    // from the single config.memory block (no separate stdio MCP package).
    expect(publishableNames).not.toContain("@mono-agent/memory-mcp");
    // operator-console was retired: Phoenix export is exposed from
    // @mono-agent/observability/otel and config is JSON-first, applied on
    // `mono-agent restart`.
    expect(publishableNames).not.toContain("@mono-agent/operator-console");
    expect(publishableNames).not.toContain(`@mono-agent/${"sandbox"}`);
    expect(publishableNames).not.toContain(`@mono-agent/${"tui"}-${"adapter"}`);
    expect(publishableNames).not.toContain(`@mono-agent/${"live"}-${"adapter"}`);
    expect(publishableNames).toContain("@mono-agent/operator-adapter");
    expect(publishableNames).toContain("@mono-agent/agent-runtime");
    expect(publishableNames).toContain("@mono-agent/runtime-adapter");
    expect(publishableNames).toContain("@mono-agent/agent-app");
    expect(publishableNames).toContain("@mono-agent/observability");
  });

  test("keeps Supermemory publishable but outside the default app dependency closure", () => {
    const plugin = packageCatalog.find((entry) => entry.name === "@mono-agent/memory-supermemory");
    expect(plugin).toMatchObject({
      path: "extras/memory-supermemory",
      publishable: true,
      tier: "plugin",
    });

    const app = JSON.parse(fs.readFileSync(
      new URL("../../../packages/agent-app/package.json", import.meta.url),
      "utf8",
    ));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      expect(app[section]?.["@mono-agent/memory-supermemory"]).toBeUndefined();
    }
  });

  test("validates the repository for its current release tag", async () => {
    // Derive the version from a workspace manifest so this test keeps
    // validating the real repository state across version bumps.
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(new URL("../../../packages/agent-app/package.json", import.meta.url), "utf8"));

    const result = validateRelease({ tag: `v${version}`, silent: true });

    expect(result.publishablePackages).toHaveLength(expectedPublishablePackageCount);
    expect(result.publishablePackages.map((pkg) => pkg.name).sort()).toEqual(expectedPublishablePackageNames);
    expect(result.publishablePackages.every((pkg) => pkg.version === version)).toBe(true);
  });

  test("keeps canonical Pi guidance aligned with the enforced exact pins", () => {
    const guidance = fs.readFileSync(
      new URL("../../../skills/pi-upstream-recon/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/gu, " ");
    const migration = fs.readFileSync(
      new URL("../../../packages/agent-runtime/MIGRATION.md", import.meta.url),
      "utf8",
    ).replace(/\s+/gu, " ");
    const piAi = PINNED_RUNTIME_DEPENDENCIES["@earendil-works/pi-ai"];
    const piCore = PINNED_RUNTIME_DEPENDENCIES["@earendil-works/pi-agent-core"];
    const piTui = PINNED_RUNTIME_DEPENDENCIES["@earendil-works/pi-tui"];

    expect(piCore).toBe(piAi);
    expect(guidance).toContain(
      `packages/agent-runtime\`: \`@earendil-works/pi-ai\` + \`pi-agent-core\` at \`${piAi}\``,
    );
    expect(guidance).toContain(
      `packages/tui\`: \`@earendil-works/pi-tui\` at \`${piTui}\` — **intentionally behind**`,
    );
    expect(guidance).toContain("the 0.80 pi-tui API breaks the TUI");
    expect(migration).toContain(
      `@earendil-works/pi-ai\` and \`@earendil-works/pi-agent-core\` are now \`${piAi}\``,
    );
    expect(migration).toContain(
      `@earendil-works/pi-agent-core\` (\`${piAi}\`)`,
    );
    expect(migration).toContain(`Pi bump \`^0.74.0\` → \`${piAi}\` in lockstep`);
    expect(migration).not.toContain("`^0.80.x`");
  });

  test("keeps the release workflow statically ready for npm OIDC without claiming tokenless promotion", () => {
    const workflow = fs.readFileSync(
      new URL("../../../.github/workflows/npm-release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm install --global npm@11.12.1");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("pnpm run release:publish -- --tag \"$GITHUB_REF_NAME\"");
  });
});

describe("hardened local release publish", () => {
  const head = "a".repeat(40);
  const other = "b".repeat(40);

  function fakeGit(responses, calls = []) {
    return (_command, args, options) => {
      const key = args.join(" ");
      calls.push({ key, options });
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
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": `${head}\n`,
      "rev-parse --verify refs/tags/v1.2.3^{commit}": `${head}\n`,
    });
    expect(assertReleaseGitState("v1.2.3", { spawn: cleanTagged, repo: "/repo" })).toBe(head);

    const dirty = fakeGit({
      "status --porcelain=v1 --untracked-files=all": " M package.json\n",
    });
    expect(() => assertReleaseGitState("v1.2.3", { spawn: dirty, repo: "/repo" }))
      .toThrow(/HEAD is not clean/u);

    const wrongTag = fakeGit({
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": `${head}\n`,
      "rev-parse --verify refs/tags/v1.2.3^{commit}": `${other}\n`,
    });
    expect(() => assertReleaseGitState("v1.2.3", { spawn: wrongTag, repo: "/repo" }))
      .toThrow(/does not point at HEAD/u);
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
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": `${head}\n`,
      "rev-parse --verify refs/tags/v1.2.3^{commit}": `${head}\n`,
    }, gitCalls);
    assertReleaseGitState("v1.2.3", {
      spawn: cleanTagged,
      repo: "/repo",
      envSource,
    });
    childEnvironments.push(...gitCalls.map((call) => call.options.env));

    runWorkspaceBuild({
      repo: "/repo",
      envSource,
      log: () => {},
      spawn: (_command, _args, options) => {
        childEnvironments.push(options.env);
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
            childEnvironments.push(options.env);
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
    for (const env of childEnvironments) {
      expect(env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(env.NPM_TOKEN).toBeUndefined();
      expect(env.NPM_DEV_TOKEN).toBeUndefined();
      expect(env[authKey]).toBeUndefined();
      expect(env.PATH).toBe("/bin");
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
});

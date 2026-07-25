// SPDX-License-Identifier: MIT
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectProductionGraph,
  evaluateDependencyVulnerabilities,
  loadDependencyVulnerabilityDispositions,
  normalizeDispositions,
  parsePnpmProductionGraph,
  parsePnpmProductionInventory,
  parsePnpmWhyDependencyPaths,
  queryBulkAdvisories,
  runDependencyVulnerabilityCheck,
} from "../check/dependency-vulnerabilities.mjs";

const temporaryRoots = [];
const REVIEWED_AT = "2026-07-16";
const EXPIRES_AT = "2026-08-15";
const NOW = new Date("2026-07-16T12:00:00Z");

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dependency vulnerability gate", () => {
  it("escapes hostile unknown arguments before rendering usage", async () => {
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [`bad\n::error file=ci.yml::forged\u001b[31m\u202ertl\u202c${"x".repeat(10_000)}`],
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain(
      "Unknown argument: bad\\n::error file=ci.yml::forged\\u001b[31m\\u202ertl\\u202c",
    );
    expect(stderr.text).toContain("Usage:\n  pnpm run check:dependency-vulnerabilities");
    expect(stderr.text).not.toContain("\n::error file=ci.yml::forged");
    expect(stderr.text).not.toContain("\u001b");
    expect(stderr.text).not.toContain("\u202e");
    const [diagnostic] = stderr.text.split("\n\nUsage:");
    expect(diagnostic).toHaveLength(2_000);
    expect(diagnostic).toMatch(/…$/u);
    expect(stderr.text.length).toBeLessThan(2_500);
  });

  it("parses pnpm 10's compact cross-platform production inventory", () => {
    expect(parsePnpmProductionInventory([
      "/repo/packages/portable-fixture",
      "/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws",
      "/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws",
      "/repo/node_modules/.pnpm/constructor@1.0.0/node_modules/constructor",
      "/repo/node_modules/.pnpm/@img+sharp-win32-arm64@0.34.5/node_modules/@img/sharp-win32-arm64",
      "C:\\repo\\node_modules\\.pnpm\\@vscode+ripgrep-win32-x64@1.18.0\\node_modules\\@vscode\\ripgrep-win32-x64",
    ].join("\n"))).toEqual({
      "@img/sharp-win32-arm64": ["0.34.5"],
      "@vscode/ripgrep-win32-x64": ["1.18.0"],
      constructor: ["1.0.0"],
      ws: ["8.20.1"],
    });
  });

  it("routes pnpm 10 collection through the compact parseable inventory", async () => {
    const calls = [];
    const graph = await collectProductionGraph({
      pnpmCommand: "pnpm-fixture",
      cwd: "/repo",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        return args[0] === "--version"
          ? commandResult("10.28.2\n")
          : commandResult([
            "/repo/node_modules/.pnpm/prod-only@1.0.0/node_modules/prod-only",
            "/repo/node_modules/.pnpm/optional-win32@2.0.0/node_modules/optional-win32",
          ].join("\n"));
      },
    });

    expect(graph).toEqual({
      inventory: {
        "optional-win32": ["2.0.0"],
        "prod-only": ["1.0.0"],
      },
      dependencyPaths: {},
      pnpmMajor: 10,
    });
    expect(calls).toEqual([
      { command: "pnpm-fixture", args: ["--version"], options: { cwd: "/repo" } },
      {
        command: "pnpm-fixture",
        args: ["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"],
        options: { cwd: "/repo" },
      },
    ]);
  });

  it("hydrates pnpm 10 advisory paths between the bulk report and evaluation", async () => {
    const advisory = wsAdvisory();
    const dependencyPath = "portable-fixture -> provider@2.0.0 -> ws@8.20.1";
    const calls = [];
    const events = [];
    const stdout = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      cwd: "/repo",
      pnpmCommand: "pnpm-fixture",
      rootPackageNames: ["portable-fixture"],
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        events.push(args[0]);
        if (args[0] === "--version") {
          return commandResult("10.28.2\n");
        }
        if (args[0] === "list") {
          return commandResult("/repo/node_modules/.pnpm/ws@8.20.1/node_modules/ws\n");
        }
        if (args[0] === "why") {
          return commandResult(JSON.stringify([{
            name: "portable-fixture",
            path: "/repo/packages/portable-fixture",
            dependencies: {
              provider: {
                from: "provider",
                version: "2.0.0",
                dependencies: {
                  ws: { from: "ws", version: "8.20.1" },
                },
              },
            },
          }]));
        }
        throw new Error(`unexpected pnpm fixture arguments: ${args.join(" ")}`);
      },
      dispositions: dispositionFor("ws", "8.20.1", advisory, [dependencyPath]),
      fetchImpl: async (_url, request) => {
        events.push("bulk");
        expect(JSON.parse(request.body)).toEqual({ ws: ["8.20.1"] });
        return httpResponse({ ws: [advisory] });
      },
      now: NOW,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual(["--version", "list", "bulk", "why"]);
    expect(calls).toEqual([
      { command: "pnpm-fixture", args: ["--version"], options: { cwd: "/repo" } },
      {
        command: "pnpm-fixture",
        args: ["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"],
        options: { cwd: "/repo" },
      },
      {
        command: "pnpm-fixture",
        args: ["why", "ws", "--prod", "--recursive", "--json"],
        options: { cwd: "/repo" },
      },
    ]);
    expect(result.evaluation.productionGraph.dependencyPaths).toEqual({
      "ws@8.20.1": [dependencyPath],
    });
    expect(result.evaluation.active[0].dependencyPaths).toEqual([dependencyPath]);
    expect(stdout.text).toContain("all exactly dispositioned");
  });

  it("rejects unaudited pnpm majors and bounds malformed version output", async () => {
    const collectWithVersion = (version) => collectProductionGraph({
      pnpmCommand: "pnpm-fixture",
      cwd: "/repo",
      runCommand: async (_command, args) => {
        expect(args).toEqual(["--version"]);
        return commandResult(version);
      },
    });

    await expect(collectWithVersion("12.0.0\n"))
      .rejects.toThrow("supports audited pnpm majors 10 and 11; found 12.0.0");
    await expect(collectWithVersion("11.not-a-version\n"))
      .rejects.toThrow("pnpm returned an invalid version");
    await expect(collectWithVersion("11.13.1\nnoise\n"))
      .rejects.toThrow("pnpm returned an invalid version");

    const hugeError = await collectWithVersion(`${"x".repeat(10_000)}\n`).catch((error) => error);
    expect(hugeError).toBeInstanceOf(Error);
    expect(hugeError.message).toContain("pnpm returned an invalid version: ");
    expect(hugeError.message).toContain("…");
    expect(hugeError.message.length).toBeLessThan(550);
  });

  it("normalizes realistic pnpm 10 and pnpm 11 production JSON trees", () => {
    const expected = {
      inventory: {
        lodash: ["4.17.20"],
        "optional-win32": ["2.0.0"],
        "prod-only": ["1.0.0"],
        shared: ["7.0.0"],
        transitive: ["3.0.0"],
        "vulnerable-transitive": ["6.0.0"],
        "workspace-runtime": ["9.0.0"],
      },
      dependencyPaths: {
        "lodash@4.17.20": ["portable-fixture -> lodash@4.17.20"],
        "optional-win32@2.0.0": ["portable-fixture -> optional-win32@2.0.0"],
        "prod-only@1.0.0": ["portable-fixture -> prod-only@1.0.0"],
        "shared@7.0.0": [
          "portable-fixture -> shared@7.0.0",
          "workspace-only -> shared@7.0.0",
        ],
        "transitive@3.0.0": ["portable-fixture -> prod-only@1.0.0 -> transitive@3.0.0"],
        "vulnerable-transitive@6.0.0": [
          "workspace-only -> workspace-runtime@9.0.0 -> vulnerable-transitive@6.0.0",
        ],
        "workspace-runtime@9.0.0": ["workspace-only -> workspace-runtime@9.0.0"],
      },
    };

    expect(parsePnpmProductionGraph(pnpm10ListFixture(), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toEqual(expected);
    expect(parsePnpmProductionGraph(pnpm11ListFixture(), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toEqual(expected);
  });

  it("fails closed on unbound workspace links and contradictory pnpm 11 dedupe metadata", () => {
    const mismatchedName = JSON.parse(pnpm11ListFixture());
    mismatchedName[1].dependencies["workspace-only"].from = "outside-workspace";
    expect(() => parsePnpmProductionGraph(JSON.stringify(mismatchedName), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("workspace link workspace-only has inconsistent alias metadata");

    const mismatchedPath = JSON.parse(pnpm11ListFixture());
    mismatchedPath[1].dependencies["workspace-only"].path = "/outside/workspace-only";
    expect(() => parsePnpmProductionGraph(JSON.stringify(mismatchedPath), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("links non-publishable workspace path /outside/workspace-only");

    const crossBoundPath = JSON.parse(pnpm11ListFixture());
    crossBoundPath[1].dependencies["workspace-only"].path = "/repo/packages/portable-fixture";
    expect(() => parsePnpmProductionGraph(JSON.stringify(crossBoundPath), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("workspace link workspace-only is not bound to its publishable workspace root");

    const zeroCount = JSON.parse(pnpm11ListFixture());
    zeroCount[2].dependencies["workspace-runtime"].dedupedDependenciesCount = 0;
    expect(() => parsePnpmProductionGraph(JSON.stringify(zeroCount), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("must name a positive dependency count");

    const countWithoutDedupe = JSON.parse(pnpm11ListFixture());
    countWithoutDedupe[2].dependencies["workspace-runtime"].deduped = false;
    expect(() => parsePnpmProductionGraph(JSON.stringify(countWithoutDedupe), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("dependency count without deduped true");

    const orphan = JSON.parse(pnpm11ListFixture());
    orphan[2].dependencies["workspace-runtime"].path = "/repo/node_modules/orphan-runtime";
    expect(() => parsePnpmProductionGraph(JSON.stringify(orphan), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("has no expanded subtree");

    const recursiveCount = JSON.parse(pnpm11ListFixture());
    recursiveCount[1].dependencies["workspace-only"].dependencies["workspace-runtime"]
      .dependencies["vulnerable-transitive"].dependencies = {
        leaf: { from: "leaf", version: "1.0.0", path: "/repo/node_modules/leaf" },
      };
    recursiveCount[2].dependencies["workspace-runtime"].dedupedDependenciesCount = 2;
    expect(parsePnpmProductionGraph(JSON.stringify(recursiveCount), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    }).dependencyPaths["leaf@1.0.0"]).toEqual([
      "workspace-only -> workspace-runtime@9.0.0 -> vulnerable-transitive@6.0.0 -> leaf@1.0.0",
    ]);

    const positiveCountMismatch = structuredClone(recursiveCount);
    positiveCountMismatch[2].dependencies["workspace-runtime"].dedupedDependenciesCount = 1;
    expect(() => parsePnpmProductionGraph(JSON.stringify(positiveCountMismatch), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("reports 1 dependencies, but its expanded subtree contains 2");

    const childBearingDedupe = JSON.parse(pnpm11ListFixture());
    childBearingDedupe[2].dependencies["workspace-runtime"].dependencies = {
      hidden: { from: "hidden", version: "99.0.0", path: "/repo/node_modules/hidden" },
    };
    expect(() => parsePnpmProductionGraph(JSON.stringify(childBearingDedupe), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("deduped entry workspace-runtime must not include dependency children");

    const distinctPeerPath = JSON.parse(pnpm11ListFixture());
    distinctPeerPath[2].dependencies["workspace-runtime"].path = "/repo/node_modules/.pnpm/workspace-runtime_peer-b/node_modules/workspace-runtime";
    expect(() => parsePnpmProductionGraph(JSON.stringify(distinctPeerPath), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("has no expanded subtree");

    const inconsistentExpandedSubtrees = [{
      name: "root-a",
      path: "/repo/packages/root-a",
      dependencies: {
        shared: {
          from: "shared",
          version: "1.0.0",
          path: "/repo/node_modules/shared",
          dependencies: {
            left: {
              from: "left",
              version: "1.0.0",
              path: "/repo/node_modules/left",
            },
          },
        },
      },
    }, {
      name: "root-b",
      path: "/repo/packages/root-b",
      dependencies: {
        "shared-alias": {
          from: "shared",
          version: "1.0.0",
          path: "/repo/node_modules/shared",
          dependencies: {
            right: {
              from: "right",
              version: "1.0.0",
              path: "/repo/node_modules/right",
            },
          },
        },
      },
    }];
    expect(() => parsePnpmProductionGraph(JSON.stringify(inconsistentExpandedSubtrees), {
      rootPackageNames: ["root-a", "root-b"],
    })).toThrow("contains inconsistent expanded subtrees for path:/repo/node_modules/shared");

    const missingPath = JSON.parse(pnpm11ListFixture());
    delete missingPath[1].optionalDependencies["optional-win32"].path;
    expect(() => parsePnpmProductionGraph(JSON.stringify(missingPath), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("entry optional-win32 is missing its installed path");

    const missingOwner = JSON.parse(pnpm11ListFixture());
    delete missingOwner[1].optionalDependencies["optional-win32"].from;
    expect(() => parsePnpmProductionGraph(JSON.stringify(missingOwner), {
      rootPackageNames: ["portable-fixture", "workspace-only"],
    })).toThrow("entry optional-win32 is missing registry-owner metadata");

    const contradictoryWorkspaceClosure = [{
      name: "consumer",
      path: "/repo/packages/consumer",
      dependencies: {
        workspace: {
          from: "workspace",
          version: "link:../workspace",
          path: "/repo/packages/workspace",
          dependencies: {
            vulnerable: {
              from: "vulnerable",
              version: "1.0.0",
              path: "/repo/node_modules/vulnerable",
            },
          },
        },
      },
    }, {
      name: "workspace",
      path: "/repo/packages/workspace",
      dependencies: {
        safe: {
          from: "safe",
          version: "1.0.0",
          path: "/repo/node_modules/safe",
        },
      },
    }];
    expect(() => parsePnpmProductionGraph(JSON.stringify(contradictoryWorkspaceClosure), {
      rootPackageNames: ["consumer", "workspace"],
    })).toThrow("contains a production dependency that contradicts its publishable workspace root");

    const optionalWorkspaceClosure = structuredClone(contradictoryWorkspaceClosure);
    optionalWorkspaceClosure[0].dependencies.workspace.dependencies = {
      "optional-native": {
        from: "optional-native",
        version: "1.0.0",
        path: "/repo/node_modules/optional-native",
      },
    };
    delete optionalWorkspaceClosure[1].dependencies;
    optionalWorkspaceClosure[1].optionalDependencies = structuredClone(
      optionalWorkspaceClosure[0].dependencies.workspace.dependencies,
    );
    expect(parsePnpmProductionGraph(JSON.stringify(optionalWorkspaceClosure), {
      rootPackageNames: ["consumer", "workspace"],
    }).dependencyPaths["optional-native@1.0.0"]).toEqual([
      "workspace -> optional-native@1.0.0",
    ]);
  });

  it("uses installed paths for workspace roots, cycles, peer variants, and owner identity", () => {
    const workspaceRuntime = {
      from: "workspace-runtime",
      version: "9.0.0",
      path: "/repo/node_modules/workspace-runtime",
      dependencies: {
        leaf: { from: "leaf", version: "1.0.0", path: "/repo/node_modules/leaf" },
      },
    };
    const crossRootLinks = [{
      name: "consumer-a",
      path: "/repo/packages/consumer-a",
      dependencies: {
        "workspace-only": {
          from: "workspace-only",
          version: "link:../workspace-only",
          path: "/repo/packages/workspace-only",
          dependencies: { "workspace-runtime": workspaceRuntime },
        },
      },
    }, {
      name: "consumer-b",
      path: "/repo/packages/nested/consumer-b",
      dependencies: {
        "workspace-only": {
          from: "workspace-only",
          version: "link:../../workspace-only",
          path: "/repo/packages/workspace-only",
          deduped: true,
          dedupedDependenciesCount: 2,
        },
      },
    }, {
      name: "workspace-only",
      path: "/repo/packages/workspace-only",
      dependencies: {
        "workspace-runtime": {
          from: "workspace-runtime",
          version: "9.0.0",
          path: "/repo/node_modules/workspace-runtime",
          deduped: true,
          dedupedDependenciesCount: 1,
        },
      },
    }];
    expect(parsePnpmProductionGraph(JSON.stringify(crossRootLinks), {
      rootPackageNames: ["consumer-a", "consumer-b", "workspace-only"],
    }).dependencyPaths).toEqual({
      "leaf@1.0.0": ["workspace-only -> workspace-runtime@9.0.0 -> leaf@1.0.0"],
      "workspace-runtime@9.0.0": ["workspace-only -> workspace-runtime@9.0.0"],
    });

    const contradictoryWorkspaceCount = structuredClone(crossRootLinks);
    contradictoryWorkspaceCount[1].dependencies["workspace-only"].dedupedDependenciesCount = 999;
    expect(() => parsePnpmProductionGraph(JSON.stringify(contradictoryWorkspaceCount), {
      rootPackageNames: ["consumer-a", "consumer-b", "workspace-only"],
    })).toThrow("reports 999 dependencies, but expanded occurrences contain 2");

    const cyclic = [{
      name: "cycle-root",
      path: "/repo/packages/cycle-root",
      dependencies: {
        a: {
          from: "a",
          version: "1.0.0",
          path: "/repo/node_modules/a",
          dependencies: {
            b: {
              from: "b",
              version: "1.0.0",
              path: "/repo/node_modules/b",
              dependencies: {
                a: { from: "a", version: "1.0.0", path: "/repo/node_modules/a" },
              },
            },
          },
        },
      },
    }];
    expect(parsePnpmProductionGraph(JSON.stringify(cyclic), {
      rootPackageNames: ["cycle-root"],
    })).toEqual({
      inventory: { a: ["1.0.0"], b: ["1.0.0"] },
      dependencyPaths: {
        "a@1.0.0": ["cycle-root -> a@1.0.0"],
        "b@1.0.0": ["cycle-root -> a@1.0.0 -> b@1.0.0"],
      },
    });

    const ownerCollision = [{
      name: "owner-root",
      path: "/repo/packages/owner-root",
      dependencies: {
        a: { from: "a", version: "1.0.0", path: "/repo/node_modules/shared-path" },
        b: { from: "b", version: "2.0.0", path: "/repo/node_modules/shared-path" },
      },
    }];
    expect(() => parsePnpmProductionGraph(JSON.stringify(ownerCollision), {
      rootPackageNames: ["owner-root"],
    })).toThrow("has conflicting owners a@1.0.0 and b@2.0.0");

    const duplicateRootPath = structuredClone(crossRootLinks);
    duplicateRootPath[1].path = duplicateRootPath[0].path;
    expect(() => parsePnpmProductionGraph(JSON.stringify(duplicateRootPath), {
      rootPackageNames: ["consumer-a", "consumer-b", "workspace-only"],
    })).toThrow("maps multiple publishable workspace roots to /repo/packages/consumer-a");

    const reservedRootPath = structuredClone(ownerCollision);
    reservedRootPath[0].dependencies.a.path = reservedRootPath[0].path;
    expect(() => parsePnpmProductionGraph(JSON.stringify(reservedRootPath), {
      rootPackageNames: ["owner-root"],
    })).toThrow("registry package a@1.0.0 reuses publishable workspace root path");
  });

  it("normalizes one broad workspace root once across many expanded link occurrences", () => {
    const workspaceDependencies = Object.fromEntries(Array.from({ length: 600 }, (_, index) => {
      const name = `workspace-leaf-${index}`;
      return [name, {
        from: name,
        version: "1.0.0",
        path: `/repo/node_modules/${name}`,
      }];
    }));
    const consumerNames = Array.from({ length: 200 }, (_, index) => `consumer-${index}`);
    const consumers = consumerNames.map((name) => ({
      name,
      path: `/repo/packages/${name}`,
      dependencies: {
        workspace: {
          from: "workspace",
          version: "link:../workspace",
          path: "/repo/packages/workspace",
          dependencies: {
            "workspace-leaf-0": structuredClone(workspaceDependencies["workspace-leaf-0"]),
          },
        },
      },
    }));

    const manyLinkDocument = [
      ...consumers,
      {
        name: "workspace",
        path: "/repo/packages/workspace",
        dependencies: workspaceDependencies,
      },
    ];
    const graph = parsePnpmProductionGraph(JSON.stringify(manyLinkDocument), {
      rootPackageNames: [...consumerNames, "workspace"],
    });
    expect(Object.keys(graph.inventory)).toHaveLength(600);
    expect(graph.dependencyPaths["workspace-leaf-0@1.0.0"]).toEqual([
      "workspace -> workspace-leaf-0@1.0.0",
    ]);

    const lastLinkContradiction = structuredClone(manyLinkDocument);
    lastLinkContradiction[199].dependencies.workspace.dependencies.rogue = {
      from: "rogue",
      version: "1.0.0",
      path: "/repo/node_modules/rogue",
    };
    expect(() => parsePnpmProductionGraph(JSON.stringify(lastLinkContradiction), {
      rootPackageNames: [...consumerNames, "workspace"],
    })).toThrow("contains a production dependency that contradicts its publishable workspace root");
  });

  it("bounds forward-path hydration before a compact deduped diamond expands exponentially", () => {
    const expandedDependencies = {};
    const layers = [];
    let priorLayer = [];
    for (let layer = 0; layer < 15; layer += 1) {
      const currentLayer = ["left", "right"].map((side) => {
        const name = `${side}-${layer}`;
        const node = {
          from: name,
          version: "1.0.0",
          path: `/repo/node_modules/${name}`,
          dependencies: layer === 0
            ? {
              [`terminal-${side}`]: {
                from: `terminal-${side}`,
                version: "1.0.0",
                path: `/repo/node_modules/terminal-${side}`,
              },
            }
            : Object.fromEntries(priorLayer.map((prior) => [
              prior.name,
              {
                from: prior.name,
                version: prior.node.version,
                path: prior.node.path,
                deduped: true,
                dedupedDependenciesCount: layer === 1 ? 1 : 2,
              },
            ])),
        };
        expandedDependencies[name] = node;
        return { name, node };
      });
      layers.push(currentLayer);
      priorLayer = currentLayer;
    }

    const topLayer = layers.at(-1);
    expect(() => parsePnpmProductionGraph(JSON.stringify([
      {
        name: "expansion-fixture",
        path: "/repo/packages/expansion-fixture",
        dependencies: expandedDependencies,
      },
      {
        name: "audited-root",
        path: "/repo/packages/audited-root",
        dependencies: Object.fromEntries(topLayer.map(({ name, node }) => [
          name,
          {
            from: name,
            version: node.version,
            path: node.path,
            deduped: true,
            dedupedDependenciesCount: 2,
          },
        ])),
      },
    ]), {
      rootPackageNames: ["audited-root"],
    })).toThrow("exceeded 10000 production dependency paths");
  });

  it("memoizes repeated deduped subtree counts during pre-traversal validation", () => {
    const sharedDependencies = Object.fromEntries(Array.from({ length: 600 }, (_, index) => {
      const name = `shared-leaf-${index}`;
      return [name, {
        from: name,
        version: "1.0.0",
        path: `/repo/node_modules/${name}`,
      }];
    }));
    const sharedExpansion = {
      from: "shared",
      version: "1.0.0",
      path: "/repo/node_modules/shared",
      dependencies: sharedDependencies,
    };
    const repeatedDedupes = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
      `shared-alias-${index}`,
      {
        from: "shared",
        version: "1.0.0",
        path: "/repo/node_modules/shared",
        deduped: true,
        dedupedDependenciesCount: 600,
      },
    ]));

    expect(parsePnpmProductionGraph(JSON.stringify([
      {
        name: "unrequested-expansion-fixture",
        path: "/repo/packages/unrequested-expansion-fixture",
        dependencies: {
          "shared-expanded": sharedExpansion,
          ...repeatedDedupes,
        },
      },
      {
        name: "audited-root",
        path: "/repo/packages/audited-root",
        dependencies: {
          safe: {
            from: "safe",
            version: "1.0.0",
            path: "/repo/node_modules/safe",
          },
        },
      },
    ]), {
      rootPackageNames: ["audited-root"],
    })).toEqual({
      inventory: { safe: ["1.0.0"] },
      dependencyPaths: { "safe@1.0.0": ["audited-root -> safe@1.0.0"] },
    });
  });

  it("pins production/optional inclusion and dev/peer/workspace exclusion at the JSON boundary", async () => {
    const calls = [];
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      pnpmCommand: "pnpm-fixture",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "--version") {
          return commandResult("11.13.1\n");
        }
        return {
          exitCode: 0,
          stdout: pnpm11ListFixture(),
          stderr: "",
        };
      },
      rootPackageNames: ["portable-fixture", "workspace-only"],
      dispositions: emptyDispositions(),
      fetchImpl: async (_url, request) => {
        expect(JSON.parse(request.body)).toEqual({
          lodash: ["4.17.20"],
          "optional-win32": ["2.0.0"],
          "prod-only": ["1.0.0"],
          shared: ["7.0.0"],
          transitive: ["3.0.0"],
          "vulnerable-transitive": ["6.0.0"],
          "workspace-runtime": ["9.0.0"],
        });
        return httpResponse({});
      },
      now: NOW,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: "pnpm-fixture",
        args: ["--version"],
        options: { cwd: process.cwd() },
      },
      {
        command: "pnpm-fixture",
        args: ["list", "--prod", "--recursive", "--depth", "Infinity", "--json"],
        options: { cwd: process.cwd() },
      },
    ]);
  });

  it("parses pnpm 10 child trees and pnpm 11 dependents trees for why paths", () => {
    const options = {
      packageName: "ws",
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/core", "@mono-agent/channel-slack"],
    };
    const expected = {
      "ws@8.20.1": [
        "@mono-agent/channel-slack -> ws@8.20.1",
        "@mono-agent/core -> provider@2.0.0 -> ws@8.20.1",
      ],
    };

    expect(parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "@mono-agent/core",
        path: "/repo/packages/core",
        dependencies: {
          provider: {
            version: "2.0.0",
            dependencies: { ws: { version: "8.20.1" } },
          },
        },
      },
      {
        name: "@mono-agent/channel-slack",
        path: "/repo/packages/channel-slack",
        dependencies: { "socket-alias": { from: "ws", version: "8.20.1" } },
      },
    ]), { ...options, pnpmMajor: 10 })).toEqual(expected);

    expect(parsePnpmWhyDependencyPaths(JSON.stringify([
      { name: "@mono-agent/core", version: "0.11.2", path: "/repo/packages/core" },
      {
        name: "ws",
        version: "8.20.1",
        path: "/repo/node_modules/ws",
        dependents: [
          {
            name: "provider",
            version: "2.0.0",
            dependents: [{
              name: "@mono-agent/core",
              version: "0.11.2",
              depField: "dependencies",
            }],
          },
          {
            name: "@mono-agent/channel-slack",
            version: "0.11.2",
            depField: "dependencies",
          },
        ],
      },
    ]), { ...options, pnpmMajor: 11 })).toEqual(expected);

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [{
        name: "@mono-agent/core",
        version: "0.11.2",
        depField: "dependencies",
        dependencies: {},
      }],
    }]), {
      ...options,
      pnpmMajor: 11,
    })).toThrow("mixes child-tree and dependents-tree shapes");
  });

  it("requires every pnpm 10 workspace root and binds local links before suppressing paths", () => {
    const options = {
      packageName: "ws",
      pnpmMajor: 10,
      versions: ["8.20.1"],
      rootPackageNames: ["root-a", "root-b", "workspace"],
    };
    const document = [
      {
        name: "root-a",
        path: "/repo/packages/root-a",
        dependencies: { ws: { from: "ws", version: "8.20.1" } },
      },
      {
        name: "root-b",
        path: "/repo/packages/root-b",
        dependencies: {
          workspace: {
            from: "workspace",
            version: "link:../workspace",
            path: "/repo/packages/workspace",
            dependencies: { ws: { from: "ws", version: "8.20.1" } },
          },
        },
      },
      {
        name: "workspace",
        path: "/repo/packages/workspace",
        dependencies: { ws: { from: "ws", version: "8.20.1" } },
      },
    ];
    const expected = {
      "ws@8.20.1": [
        "root-a -> ws@8.20.1",
        "workspace -> ws@8.20.1",
      ],
    };

    for (const version of ["link:../workspace", "file:../workspace", "workspace:*"]) {
      const protocolVariant = structuredClone(document);
      protocolVariant[1].dependencies.workspace.version = version;
      expect(parsePnpmWhyDependencyPaths(JSON.stringify(protocolVariant), options)).toEqual(expected);
    }

    const missingRoot = document.filter((root) => root.name !== "root-b");
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(missingRoot), options))
      .toThrow("missing publishable workspace roots: root-b");

    const duplicateRoot = [...structuredClone(document), structuredClone(document[0])];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(duplicateRoot), options))
      .toThrow("duplicate workspace root root-a");

    const duplicateRootPath = structuredClone(document);
    duplicateRootPath[1].path = duplicateRootPath[0].path;
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(duplicateRootPath), options))
      .toThrow("maps multiple publishable workspace roots to /repo/packages/root-a");

    const unboundLink = structuredClone(document);
    unboundLink[1].dependencies.workspace.path = "/repo/packages/not-requested";
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(unboundLink), options))
      .toThrow("workspace link workspace is not bound to its publishable workspace root");

    const crossBoundLink = structuredClone(document);
    crossBoundLink[1].dependencies.workspace.path = "/repo/packages/root-a";
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(crossBoundLink), options))
      .toThrow("workspace link workspace is not bound to its publishable workspace root");

    const nestedReverseShape = structuredClone(document);
    nestedReverseShape[1].dependencies.workspace.dependents = [];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(nestedReverseShape), options))
      .toThrow("mixes child-tree and dependents-tree shapes");

    const mismatchedLinkOwner = structuredClone(document);
    mismatchedLinkOwner[1].dependencies.workspace.from = "workspace-alias";
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(mismatchedLinkOwner), options))
      .toThrow("workspace link workspace has inconsistent alias metadata");

    const mixedShapeBypass = [
      {
        name: "root-a",
        version: "1.0.0",
        path: "/repo/packages/root-a",
        dependencies: {
          workspace: {
            from: "wrong-owner",
            version: "link:../workspace",
            path: "/wrong/path",
          },
        },
      },
      {
        name: "ws",
        version: "8.20.1",
        dependents: [{
          name: "root-a",
          version: "1.0.0",
          depField: "dependencies",
        }],
      },
    ];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(mixedShapeBypass), {
      ...options,
      rootPackageNames: ["root-a", "root-b"],
    })).toThrow("mixes child-tree and dependents-tree shapes");

    const emptyRootShapeBypass = [
      {
        name: "root-a",
        version: "1.0.0",
        path: "/repo/packages/root-a",
      },
      {
        name: "ws",
        version: "8.20.1",
        dependents: [{
          name: "root-a",
          version: "1.0.0",
          depField: "dependencies",
        }],
      },
    ];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(emptyRootShapeBypass), {
      ...options,
      rootPackageNames: ["root-a", "root-b"],
    })).toThrow("mixes child-tree and dependents-tree shapes");
  });

  it("hydrates realistic pnpm 11 reverse deduped branches by peer-aware identity", () => {
    const options = {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/core"],
    };
    expect(parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "provider",
          version: "2.0.0",
          peersSuffixHash: "same",
          dependents: [{
            name: "@mono-agent/core",
            version: "0.11.3",
            depField: "dependencies",
          }],
        },
        {
          name: "wrapper",
          version: "3.0.0",
          dependents: [{
            name: "provider",
            version: "2.0.0",
            peersSuffixHash: "same",
            deduped: true,
          }],
        },
      ],
    }]), options)).toEqual({
      "ws@8.20.1": [
        "@mono-agent/core -> provider@2.0.0 -> wrapper@3.0.0 -> ws@8.20.1",
        "@mono-agent/core -> provider@2.0.0 -> ws@8.20.1",
      ],
    });
  });

  it("validates reverse cycles and prevents target or peer expansion cross-binding", () => {
    const options = {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/channel-slack"],
    };
    const rootDependent = {
      name: "@mono-agent/channel-slack",
      version: "0.11.3",
      depField: "dependencies",
    };
    const legitimateCycle = [{
      name: "ws",
      version: "8.20.1",
      dependents: [{
        name: "provider",
        version: "1.0.0",
        peersSuffixHash: "provider-peer-a",
        dependents: [
          rootDependent,
          {
            name: "wrapper",
            version: "1.0.0",
            dependents: [{ name: "provider", version: "1.0.0", circular: true }],
          },
        ],
      }],
    }];
    expect(parsePnpmWhyDependencyPaths(JSON.stringify(legitimateCycle), options)).toEqual({
      "ws@8.20.1": ["@mono-agent/channel-slack -> provider@1.0.0 -> ws@8.20.1"],
    });

    const hydratedCircular = [{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "a",
          version: "1.0.0",
          dependents: [{
            name: "provider",
            version: "1.0.0",
            dependents: [
              rootDependent,
              { name: "a", version: "1.0.0", circular: true },
            ],
          }],
        },
        {
          name: "z",
          version: "1.0.0",
          dependents: [{ name: "provider", version: "1.0.0", deduped: true }],
        },
      ],
    }];
    expect(parsePnpmWhyDependencyPaths(JSON.stringify(hydratedCircular), options)).toEqual({
      "ws@8.20.1": [
        "@mono-agent/channel-slack -> provider@1.0.0 -> a@1.0.0 -> ws@8.20.1",
        "@mono-agent/channel-slack -> provider@1.0.0 -> z@1.0.0 -> ws@8.20.1",
      ],
    });

    const hydrationCreatedCycle = [{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "a",
          version: "1.0.0",
          dependents: [{ name: "provider", version: "1.0.0", deduped: true }],
        },
        {
          name: "z",
          version: "1.0.0",
          dependents: [{
            name: "provider",
            version: "1.0.0",
            dependents: [
              { name: "a", version: "1.0.0", deduped: true },
              rootDependent,
            ],
          }],
        },
      ],
    }];
    expect(parsePnpmWhyDependencyPaths(JSON.stringify(hydrationCreatedCycle), options)).toEqual({
      "ws@8.20.1": [
        "@mono-agent/channel-slack -> provider@1.0.0 -> a@1.0.0 -> ws@8.20.1",
        "@mono-agent/channel-slack -> provider@1.0.0 -> z@1.0.0 -> ws@8.20.1",
      ],
    });

    const falseCircular = structuredClone(legitimateCycle);
    falseCircular[0].dependents.push({ name: "unrelated", version: "1.0.0", circular: true });
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(falseCircular), options))
      .toThrow("circular branch unrelated@1.0.0 does not reference an ancestor");

    const crossTarget = [
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "target-a",
        dependents: [{
          name: "provider",
          version: "1.0.0",
          peersSuffixHash: "provider-a",
          dependents: [rootDependent],
        }],
      },
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "target-b",
        dependents: [{
          name: "provider",
          version: "1.0.0",
          peersSuffixHash: "provider-a",
          deduped: true,
        }],
      },
    ];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(crossTarget), options))
      .toThrow("deduped branch provider@1.0.0#provider-a");

    const crossPeer = [{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "provider",
          version: "1.0.0",
          peersSuffixHash: "peer-a",
          dependents: [rootDependent],
        },
        {
          name: "wrapper",
          version: "1.0.0",
          dependents: [{
            name: "provider",
            version: "1.0.0",
            peersSuffixHash: "peer-b",
            deduped: true,
          }],
        },
      ],
    }];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(crossPeer), options))
      .toThrow("deduped branch provider@1.0.0#peer-b");

    const duplicateTarget = [legitimateCycle[0], structuredClone(legitimateCycle[0])];
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(duplicateTarget), options))
      .toThrow("duplicate target variant ws@8.20.1");

    const duplicateExpanded = structuredClone(legitimateCycle);
    duplicateExpanded[0].dependents.push({
      name: "provider",
      version: "1.0.0",
      peersSuffixHash: "provider-peer-a",
      dependents: [rootDependent],
    });
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(duplicateExpanded), options))
      .toThrow("duplicate expanded dependents trees for provider@1.0.0#provider-peer-a");
  });

  it("fails closed on incomplete or non-production pnpm 11 why branches", () => {
    const options = {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/channel-slack"],
    };
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [{ name: "provider", version: "1.0.0", deduped: true }],
    }]), options)).toThrow("deduped branch provider@1.0.0 above provider@1.0.0 -> ws@8.20.1 has no expanded dependents tree");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [{
        name: "@mono-agent/channel-slack",
        version: "0.11.3",
        depField: "devDependencies",
      }],
    }]), options)).toThrow("non-production devDependencies path");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      null,
      {
        name: "ws",
        version: "8.20.1",
        dependents: [{
          name: "@mono-agent/channel-slack",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("malformed top-level entry");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "incomplete",
      },
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "complete",
        dependents: [{
          name: "@mono-agent/channel-slack",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("target variant ws@8.20.1#incomplete has no dependents tree");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "empty",
        dependents: [],
      },
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "complete",
        dependents: [{
          name: "@mono-agent/channel-slack",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("target variant ws@8.20.1#empty has no complete production dependency path");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "provider",
          version: "1.0.0",
          dependents: [{
            name: "@mono-agent/channel-slack",
            version: "0.11.3",
            depField: "dependencies",
          }],
        },
        {
          name: "wrapper",
          version: "1.0.0",
          dependents: [{
            name: "provider",
            version: "1.0.0",
            deduped: true,
            dependents: [],
          }],
        },
      ],
    }]), options)).toThrow("deduped branch provider@1.0.0 must not include dependents");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        { name: "orphan", version: "1.0.0", dependents: [] },
        {
          name: "@mono-agent/channel-slack",
          version: "0.11.3",
          depField: "dependencies",
        },
      ],
    }]), options)).toThrow("incomplete branch orphan@1.0.0 has an empty dependents tree");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([
      {
        name: "ws",
        from: 0,
        version: "8.20.1",
        peersSuffixHash: "malformed-owner",
        dependents: [],
      },
      {
        name: "ws",
        version: "8.20.1",
        peersSuffixHash: "valid",
        dependents: [{
          name: "@mono-agent/channel-slack",
          version: "0.11.3",
          depField: "dependencies",
        }],
      },
    ]), options)).toThrow("target ws has an invalid registry package name");
  });

  it("bounds reverse-path hydration before a compact diamond can expand exponentially", () => {
    const rootDependent = {
      name: "@mono-agent/channel-slack",
      version: "0.11.3",
      depField: "dependencies",
    };
    const diamond = (layerCount) => {
      const expandedLayers = [];
      let priorLayer = [];
      for (let layer = 0; layer < layerCount; layer += 1) {
        const currentLayer = ["left", "right"].map((side) => ({
          name: `${side}-${layer}`,
          version: "1.0.0",
          dependents: layer === 0
            ? [rootDependent]
            : priorLayer.map((prior) => ({
              name: prior.name,
              version: prior.version,
              deduped: true,
            })),
        }));
        expandedLayers.push(...currentLayer);
        priorLayer = currentLayer;
      }
      return expandedLayers;
    };

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: diamond(20),
    }]), {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/channel-slack"],
    })).toThrow("exceeded 10000 complete production dependency paths");

    const peerVariants = ["peer-a", "peer-b"].map((peersSuffixHash) => ({
      name: "ws",
      version: "8.20.1",
      peersSuffixHash,
      // Each 12-layer variant yields 8,190 paths and stays below the cap;
      // together they must share the package-version budget and fail closed.
      dependents: diamond(12),
    }));
    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify(peerVariants), {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["@mono-agent/channel-slack"],
    })).toThrow("target ws@8.20.1 exceeded 10000 complete production dependency paths");
  });

  it("drives the real collector and HTTP parser for a deliberately vulnerable package", async () => {
    const root = temporaryProject({ lodash: "4.17.20" });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      cwd: root,
      rootPackageNames: [manifest.name],
      runCommand: async (_command, args) => {
        if (args[0] === "--version") {
          return commandResult("11.13.1\n");
        }
        expect(args).toEqual(["list", "--prod", "--recursive", "--depth", "Infinity", "--json"]);
        return commandResult(JSON.stringify([{
          name: manifest.name,
          path: root,
          dependencies: {
            lodash: {
              from: "lodash",
              version: manifest.dependencies.lodash,
              path: join(root, "node_modules/lodash"),
            },
          },
        }]));
      },
      dispositions: emptyDispositions(),
      fetchImpl: async (url, request) => {
        expect(url.href).toBe("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk");
        expect(request.method).toBe("POST");
        expect(request.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(request.body)).toEqual({ lodash: ["4.17.20"] });
        expect(request.signal).toBeInstanceOf(AbortSignal);
        return httpResponse({
          lodash: [lodashAdvisory()],
        });
      },
      now: NOW,
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("UNREVIEWED [high] lodash@4.17.20");
    expect(stderr.text).toContain("GHSA-35jh-r3h4-6jhm");
  });

  it("submits and trips on a non-runner-platform optional production package", async () => {
    const packageName = "@fixture/native-win32-arm64";
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      rootPackageNames: ["portable-fixture"],
      runCommand: async (_command, args) => {
        if (args[0] === "--version") {
          return commandResult("11.13.1\n");
        }
        expect(args).toEqual(["list", "--prod", "--recursive", "--depth", "Infinity", "--json"]);
        return commandResult(JSON.stringify([{
          name: "portable-fixture",
          path: "/repo/packages/portable-fixture",
          optionalDependencies: {
            [packageName]: {
              from: packageName,
              version: "1.2.3",
              path: `/repo/node_modules/.pnpm/${packageName.replace("/", "+")}@1.2.3/node_modules/${packageName}`,
            },
          },
        }]));
      },
      dispositions: emptyDispositions(),
      fetchImpl: async (_url, request) => {
        expect(JSON.parse(request.body)).toEqual({ [packageName]: ["1.2.3"] });
        return httpResponse({
          [packageName]: [{
            id: "GHSA-cross-platform",
            severity: "critical",
            title: "Cross-platform fixture advisory",
            url: "https://github.com/advisories/GHSA-cross-platform",
            vulnerable_versions: "<1.2.4",
          }],
        });
      },
      now: NOW,
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain(`UNREVIEWED [critical] ${packageName}@1.2.3`);
  });

  it("passes only when advisory metadata, exact versions, paths, and a live expiry match", async () => {
    const stdout = sink();
    const advisory = wsAdvisory();
    const graph = graphFor("ws", "8.20.1", "fixture -> ws@8.20.1");
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, graph.dependencyPaths["ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("1 high-or-critical advisories, all exactly dispositioned");
    expect(stdout.text).toContain("DISPOSITIONED [high] ws@8.20.1");
    expect(stdout.text).toContain("owner fixture-security-owner");
  });

  it("fails closed on invented paths, version drift, stale entries, and expiry", async () => {
    const advisory = wsAdvisory();
    const graph = graphFor("ws", "8.20.1", "fixture -> ws@8.20.1");

    const pathStderr = sink();
    const pathMismatch = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["invented -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout: sink(),
      stderr: pathStderr,
    });
    expect(pathMismatch.exitCode).toBe(1);
    expect(pathStderr.text).toContain("production dependency paths changed");

    const versionGraph = graphFor("ws", "8.20.2", "fixture -> ws@8.20.2");
    const versionStderr = sink();
    const versionMismatch = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: versionGraph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout: sink(),
      stderr: versionStderr,
    });
    expect(versionMismatch.exitCode).toBe(1);
    expect(versionStderr.text).toContain("exact versions changed");

    const hostileVersion = "8.20.2\n::error file=ci.yml::forged\u001b[31m";
    const hostileVersionStderr = sink();
    const hostileVersionMismatch = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graphFor("ws", hostileVersion, `fixture -> ws@${hostileVersion}`),
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: NOW,
      stdout: sink(),
      stderr: hostileVersionStderr,
    });
    expect(hostileVersionMismatch.exitCode).toBe(1);
    expect(hostileVersionStderr.text).toContain(
      "8.20.2\\n::error file=ci.yml::forged\\u001b[31m",
    );
    expect(hostileVersionStderr.text).not.toContain("\n::error file=ci.yml::forged");
    expect(hostileVersionStderr.text).not.toContain("\u001b");

    for (const { field, liveField, value } of [
      { field: "severity", liveField: "severity", value: "critical" },
      { field: "title", liveField: "title", value: "Changed advisory title" },
      { field: "url", liveField: "url", value: "https://github.com/advisories/GHSA-changed" },
      { field: "vulnerableVersions", liveField: "vulnerable_versions", value: ">=8 <9" },
    ]) {
      const metadataStderr = sink();
      const metadataMismatch = await runDependencyVulnerabilityCheck({
        argv: [],
        productionGraph: graph,
        dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
        queryAdvisories: async () => ({ ws: [{ ...advisory, [liveField]: value }] }),
        now: NOW,
        stdout: sink(),
        stderr: metadataStderr,
      });
      expect(metadataMismatch.exitCode).toBe(1);
      expect(metadataStderr.text).toContain(`${field} changed`);
    }

    const staleStderr = sink();
    const stale = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({}),
      now: NOW,
      stdout: sink(),
      stderr: staleStderr,
    });
    expect(stale.exitCode).toBe(1);
    expect(staleStderr.text).toContain("STALE [high] ws@8.20.1");

    const expiredStderr = sink();
    const expired = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graph,
      dispositions: dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]),
      queryAdvisories: async () => ({ ws: [advisory] }),
      now: new Date(`${EXPIRES_AT}T00:00:00Z`),
      stdout: sink(),
      stderr: expiredStderr,
    });
    expect(expired.exitCode).toBe(1);
    expect(expiredStderr.text).toContain(`temporary acceptance expired ${EXPIRES_AT}`);
  });

  it("strictly validates the temporary-disposition schema, ownership, and expiry", () => {
    const advisory = wsAdvisory();
    const valid = dispositionFor("ws", "8.20.1", advisory, ["fixture -> ws@8.20.1"]);
    const entry = valid.advisories[0];

    expect(() => normalizeDispositions({ ...valid, reviewedAt: "not-a-date" }))
      .toThrow("reviewedAt must be a valid YYYY-MM-DD date");
    expect(() => normalizeDispositions({ ...valid, reviewedAt: "2026-02-30" }))
      .toThrow("reviewedAt must be a valid YYYY-MM-DD date");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...valid.advisories[0], expiresAt: "2026-02-30" }],
    })).toThrow("expiresAt must be a valid YYYY-MM-DD date");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...valid.advisories[0], expiresAt: "2026-10-15" }],
    })).toThrow("within 90 days");

    for (const severity of ["constructor", "toString", "__proto__"]) {
      expect(() => normalizeDispositions({
        ...valid,
        advisories: [{ ...entry, severity }],
      })).toThrow("must be high or critical");
    }
    expect(() => normalizeDispositions({ ...valid, unexpectedPolicy: true }))
      .toThrow("dispositions contains unknown fields: unexpectedPolicy");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, unexpectedPolicy: true }],
    })).toThrow("contains unknown fields: unexpectedPolicy");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, owner: "   " }],
    })).toThrow("is missing owner");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, owner: "owner\n::warning::forged" }],
    })).toThrow("is missing owner");
    for (const owner of ["\u200B", "\uFE0F"]) {
      expect(() => normalizeDispositions({
        ...valid,
        advisories: [{ ...entry, owner }],
      })).toThrow("is missing owner");
    }
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, owner: "x".repeat(201) }],
    })).toThrow("owner exceeds 200 UTF-8 bytes");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, rationale: "\n" }],
    })).toThrow("is missing rationale");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, rationale: "\u2060" }],
    })).toThrow("is missing rationale");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, rationale: "x".repeat(4_097) }],
    })).toThrow("rationale exceeds 4096 UTF-8 bytes");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{ ...entry, versions: ["8.20.1", "8.20.1"] }],
    })).toThrow("contains duplicate exact versions");
    expect(() => normalizeDispositions({
      ...valid,
      advisories: [{
        ...entry,
        dependencyPaths: ["fixture -> ws@8.20.1", "fixture -> ws@8.20.1"],
      }],
    })).toThrow("contains duplicate production dependency paths");

    const inheritedTopLevel = { ...valid };
    delete inheritedTopLevel.reviewedAt;
    Object.setPrototypeOf(inheritedTopLevel, { reviewedAt: valid.reviewedAt });
    expect(() => normalizeDispositions(inheritedTopLevel))
      .toThrow("dispositions is missing required own fields: reviewedAt");

    const inheritedOwner = { ...entry };
    delete inheritedOwner.owner;
    Object.setPrototypeOf(inheritedOwner, { owner: entry.owner });
    expect(() => normalizeDispositions({ ...valid, advisories: [inheritedOwner] }))
      .toThrow("is missing required own fields: owner");

    const accessorEntry = { ...entry };
    Object.defineProperty(accessorEntry, "id", {
      enumerable: true,
      get() {
        return entry.id;
      },
    });
    expect(() => normalizeDispositions({ ...valid, advisories: [accessorEntry] }))
      .toThrow("must contain only enumerable string data fields");
    expect(normalizeDispositions(valid).advisories[0].owner).toBe("fixture-security-owner");
  });

  it("fails closed across the real bulk HTTP transport, size, shape, JSON, and timeout boundaries", async () => {
    const inventory = { ws: ["8.20.1"] };
    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    })).rejects.toThrow("bulk advisory request failed: connection refused");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => httpResponse("registry unavailable", { status: 503, raw: true }),
    })).rejects.toThrow("returned HTTP 503: registry unavailable");

    const credentialFetch = vi.fn();
    const credentialError = await queryBulkAdvisories(inventory, {
      registryUrl: "https://leaky-user:leaky-password@registry.example.invalid/private-token/",
      fetchImpl: credentialFetch,
    }).catch((error) => error);
    expect(credentialError).toBeInstanceOf(Error);
    expect(credentialError.message).toBe("bulk advisory registry URL must not include credentials.");
    expect(credentialError.message).not.toContain("leaky-user");
    expect(credentialError.message).not.toContain("leaky-password");
    expect(credentialFetch).not.toHaveBeenCalled();

    const hostileHttpError = await queryBulkAdvisories(inventory, {
      fetchImpl: async () => httpResponse(
        "registry unavailable\n::warning file=ci.yml::forged\u001b[31m",
        { status: 503, raw: true },
      ),
    }).catch((error) => error);
    expect(hostileHttpError).toBeInstanceOf(Error);
    expect(hostileHttpError.message).toContain(
      "registry unavailable\\n::warning file=ci.yml::forged\\u001b[31m",
    );
    expect(hostileHttpError.message).not.toContain("\n");
    expect(hostileHttpError.message).not.toContain("\u001b");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => httpResponse("{broken", { raw: true }),
    })).rejects.toThrow("bulk advisory response was not valid JSON");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => ({ ok: true, status: 200, text: "not-a-function" }),
    })).rejects.toThrow("bulk advisory endpoint returned a malformed HTTP response");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                return { done: false, value: "not bytes" };
              },
              cancel() {},
              releaseLock() {},
            };
          },
        },
      }),
    })).rejects.toThrow("bulk advisory endpoint returned a non-byte response chunk");

    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async () => httpResponse([]),
    })).rejects.toThrow("response root is not an object");

    const bodyChunks = [
      new Uint8Array(5 * 1024 * 1024),
      new Uint8Array(4 * 1024 * 1024),
    ];
    let bodyReadCount = 0;
    let bodyCancelled = false;
    let requestSignal;
    await expect(queryBulkAdvisories(inventory, {
      fetchImpl: async (_url, request) => {
        requestSignal = request.signal;
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                async read() {
                  bodyReadCount += 1;
                  if (bodyReadCount <= bodyChunks.length) {
                    return { done: false, value: bodyChunks[bodyReadCount - 1] };
                  }
                  throw new Error("late response chunk was consumed");
                },
                cancel() {
                  bodyCancelled = true;
                },
                releaseLock() {},
              };
            },
          },
        };
      },
    })).rejects.toThrow("bulk advisory response exceeded 8388608 bytes");
    expect(bodyReadCount).toBe(2);
    expect(bodyCancelled).toBe(true);
    expect(requestSignal.aborted).toBe(true);

    vi.useFakeTimers();
    let timeoutSignal;
    const pending = queryBulkAdvisories(inventory, {
      timeoutMs: 25,
      fetchImpl: async (_url, request) => {
        timeoutSignal = request.signal;
        return await new Promise(() => {});
      },
    });
    const rejection = expect(pending).rejects.toThrow("bulk advisory request timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(timeoutSignal.aborted).toBe(true);
  });

  it.each(["constructor", "toString", "__proto__", "unknown-severity"])(
    "fails closed on an unowned live severity key: %s",
    async (severity) => {
      const stderr = sink();
      const result = await runDependencyVulnerabilityCheck({
        argv: [],
        productionGraph: graphFor("ws", "8.20.1", "fixture -> ws@8.20.1"),
        dispositions: emptyDispositions(),
        fetchImpl: async () => httpResponse({
          ws: [{ ...wsAdvisory(), severity }],
        }),
        now: NOW,
        stdout: sink(),
        stderr,
      });

      expect(result.exitCode).toBe(1);
      expect(stderr.text).toContain("contains an unknown severity");
    },
  );

  it.each(["constructor", "toString", "__proto__"])(
    "fails closed on a prototype-key package absent from inventory: %s",
    async (packageName) => {
      const stderr = sink();
      const result = await runDependencyVulnerabilityCheck({
        argv: [],
        productionGraph: graphFor("ws", "8.20.1", "fixture -> ws@8.20.1"),
        dispositions: emptyDispositions(),
        fetchImpl: async () => httpResponse({ [packageName]: [] }),
        now: NOW,
        stdout: sink(),
        stderr,
      });

      expect(result.exitCode).toBe(1);
      expect(stderr.text).toContain(`package absent from inventory: ${packageName}`);
    },
  );

  it("rejects malformed, duplicate, and over-budget live advisory reports before expansion", () => {
    const graph = graphFor("ws", "8.20.1", "fixture -> ws@8.20.1");
    const advisory = wsAdvisory();

    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: { ws: {} },
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("bulk advisory report for ws is not an array");
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: { ws: [null] },
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("contains an unknown severity");
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: { ws: [{ ...advisory, title: "" }] },
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("is missing title");
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: { ws: [advisory, { ...advisory, id: String(advisory.id) }] },
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow(`duplicate advisory ws:${advisory.id}`);

    const accessorReport = {};
    Object.defineProperty(accessorReport, "ws", {
      enumerable: true,
      get() {
        return [advisory];
      },
    });
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: accessorReport,
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("must contain only enumerable string data fields");

    const accessorArray = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        return advisory;
      },
    });
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: { ws: accessorArray },
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("must be a dense data array");

    const tooMany = Array.from({ length: 1_001 }, (_, index) => ({
      id: `GHSA-fixture-${index}`,
      severity: "low",
      title: `Low fixture ${index}`,
      url: `https://github.com/advisories/GHSA-fixture-${index}`,
      vulnerable_versions: "*",
    }));
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report: { ws: tooMany },
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("exceeded 1000 advisory entries");

    const dependencyPaths = Array.from(
      { length: 1_001 },
      (_, index) => `fixture-${index} -> ws@8.20.1`,
    );
    const pathHeavyGraph = {
      inventory: { ws: ["8.20.1"] },
      dependencyPaths: { "ws@8.20.1": dependencyPaths },
    };
    const pathHeavyReport = {
      ws: Array.from({ length: 100 }, (_, index) => ({
        ...advisory,
        id: `GHSA-path-heavy-${index}`,
      })),
    };
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: pathHeavyGraph,
      report: pathHeavyReport,
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("exceeded 100000 dependency-path expansion steps");
  });

  it("rejects malformed high advisories before collecting dependency paths", async () => {
    const collectDependencyPaths = vi.fn(async () => {
      throw new Error("dependency-path collection must not run");
    });
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: { inventory: { ws: ["8.20.1"] }, dependencyPaths: {} },
      dispositions: emptyDispositions(),
      queryAdvisories: async () => ({ ws: [{ ...wsAdvisory(), title: "" }] }),
      collectDependencyPaths,
      now: NOW,
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("is missing title");
    expect(collectDependencyPaths).not.toHaveBeenCalled();
  });

  it("keeps package and advisory identities collision-free", () => {
    const live = { ...wsAdvisory(), id: "b:c" };
    const dispositionAdvisory = { ...live, id: "c" };
    const evaluation = evaluateDependencyVulnerabilities({
      productionGraph: {
        inventory: { a: ["1.0.0"], "a:b": ["1.0.0"] },
        dependencyPaths: { "a@1.0.0": ["fixture -> a@1.0.0"] },
      },
      report: { a: [live] },
      dispositions: dispositionFor(
        "a:b",
        "1.0.0",
        dispositionAdvisory,
        ["fixture -> a@1.0.0"],
      ),
      now: NOW,
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.unreviewed.map((entry) => entry.package)).toEqual(["a"]);
    expect(evaluation.stale.map((entry) => entry.package)).toEqual(["a:b"]);
  });

  it("rejects package-version tuples that collapse to the same display identity", () => {
    expect(() => evaluateDependencyVulnerabilities({
      productionGraph: {
        inventory: { a: ["b@c"], "a@b": ["c"] },
        dependencyPaths: { "a@b@c": ["fixture -> a@b@c"] },
      },
      report: {},
      dispositions: emptyDispositions(),
      now: NOW,
    })).toThrow("package/version identity cannot be represented unambiguously");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [{
        name: "a@b",
        version: "c",
        dependents: [{
          name: "root",
          version: "1.0.0",
          depField: "dependencies",
        }],
      }],
    }]), {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["root"],
    })).toThrow("package/version identity cannot be represented unambiguously");

    expect(() => parsePnpmWhyDependencyPaths(JSON.stringify([{
      name: "ws",
      version: "8.20.1",
      dependents: [
        {
          name: "provider",
          version: "1#peer",
          dependents: [{
            name: "root",
            version: "1.0.0",
            depField: "dependencies",
          }],
        },
        {
          name: "wrapper",
          version: "2.0.0",
          dependents: [{
            name: "provider",
            version: "1",
            peersSuffixHash: "peer",
            deduped: true,
          }],
        },
      ],
    }]), {
      packageName: "ws",
      pnpmMajor: 11,
      versions: ["8.20.1"],
      rootPackageNames: ["root"],
    })).toThrow("package/version identity cannot be represented unambiguously");
  });

  it("escapes and bounds remote advisory fields before CI rendering", async () => {
    const packageName = "ws\n::notice file=ci.yml::package";
    const version = "8.20.1\u001b[31m";
    const stderr = sink();
    const result = await runDependencyVulnerabilityCheck({
      argv: [],
      productionGraph: graphFor(
        packageName,
        version,
        `fixture -> ${packageName}@${version}`,
      ),
      dispositions: emptyDispositions(),
      queryAdvisories: async () => ({
        [packageName]: [{
          ...wsAdvisory(),
          title: "forged\n::error file=ci.yml::title\u001b[31m\u202ertl\u202c",
          url: `https://example.invalid/\n::warning::url\u001b[31m\u2066${"x".repeat(600)}`,
        }],
      }),
      now: NOW,
      stdout: sink(),
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("ws\\n::notice file=ci.yml::package@8.20.1\\u001b[31m");
    expect(stderr.text).toContain("forged\\n::error file=ci.yml::title\\u001b[31m\\u202ertl\\u202c");
    expect(stderr.text).toContain("https://example.invalid/\\n::warning::url\\u001b[31m\\u2066");
    expect(stderr.text).not.toContain("\u001b");
    expect(stderr.text).not.toContain("\u202e");
    expect(stderr.text).not.toContain("\n::warning::url");
    expect(stderr.text).not.toContain("\n::notice file=ci.yml::package");
    expect(stderr.text).toContain("…");
  });

  it("ignores low/moderate advisories while high/critical findings trip", () => {
    const graph = {
      inventory: {
        critical: ["1.0.0"],
        high: ["1.0.0"],
        low: ["1.0.0"],
        moderate: ["1.0.0"],
      },
      dependencyPaths: {
        "critical@1.0.0": ["fixture -> critical@1.0.0"],
        "high@1.0.0": ["fixture -> high@1.0.0"],
      },
    };
    const report = Object.fromEntries(["low", "moderate", "high", "critical"].map((severity) => [
      severity,
      [{
        id: `GHSA-${severity}`,
        severity,
        title: `${severity} fixture`,
        url: `https://github.com/advisories/GHSA-${severity}`,
        vulnerable_versions: "*",
      }],
    ]));
    const evaluation = evaluateDependencyVulnerabilities({
      productionGraph: graph,
      report,
      dispositions: emptyDispositions(),
      now: NOW,
    });

    expect(evaluation.active.map((entry) => entry.severity).sort()).toEqual(["critical", "high"]);
    expect(evaluation.unreviewed).toHaveLength(2);
    expect(evaluation.ok).toBe(false);
  });

  it("keeps the committed current-tree dispositions structurally valid and bounded", async () => {
    const dispositions = await loadDependencyVulnerabilityDispositions();
    expect(dispositions.minimumSeverity).toBe("high");
    expect(dispositions.advisories).toEqual([]);
  });
});

function pnpm10ListFixture() {
  const workspaceRuntime = {
    from: "workspace-runtime",
    version: "9.0.0",
    path: "/repo/node_modules/workspace-runtime",
    dependencies: {
      "vulnerable-transitive": {
        from: "vulnerable-transitive",
        version: "6.0.0",
        path: "/repo/node_modules/vulnerable-transitive",
      },
    },
  };
  return JSON.stringify([
    {
      name: "portable-fixture",
      version: "1.0.0",
      path: "/repo/packages/portable-fixture",
      dependencies: {
        "prod-only": {
          from: "prod-only",
          version: "1.0.0",
          path: "/repo/node_modules/prod-only",
          dependencies: {
            transitive: {
              from: "transitive",
              version: "3.0.0",
              path: "/repo/node_modules/transitive",
            },
          },
        },
        "safe-alias": {
          from: "lodash",
          version: "4.17.20",
          path: "/repo/node_modules/lodash",
        },
        shared: { from: "shared", version: "7.0.0", path: "/repo/node_modules/shared" },
        "workspace-only": {
          from: "workspace-only",
          version: "link:../workspace-only",
          path: "/repo/packages/workspace-only",
          dependencies: {
            "workspace-runtime": workspaceRuntime,
          },
        },
      },
      optionalDependencies: {
        "optional-win32": {
          from: "optional-win32",
          version: "2.0.0",
          path: "/repo/node_modules/optional-win32",
        },
      },
      devDependencies: {
        "dev-only": { version: "4.0.0", path: "/repo/node_modules/dev-only" },
      },
      peerDependencies: {
        "peer-only": { version: "5.0.0", path: "/repo/node_modules/peer-only" },
      },
    },
    {
      name: "workspace-only",
      version: "1.0.0",
      path: "/repo/packages/workspace-only",
      dependencies: {
        "workspace-runtime": workspaceRuntime,
        shared: { from: "shared", version: "7.0.0", path: "/repo/node_modules/shared" },
      },
      devDependencies: {
        "workspace-dev-only": {
          version: "10.0.0",
          path: "/repo/node_modules/workspace-dev-only",
        },
      },
    },
  ]);
}

function pnpm11ListFixture() {
  const pnpm10Roots = JSON.parse(pnpm10ListFixture());
  const workspaceRoot = structuredClone(pnpm10Roots[1]);
  workspaceRoot.dependencies["workspace-runtime"] = {
    from: "workspace-runtime",
    version: "9.0.0",
    path: "/repo/node_modules/workspace-runtime",
    deduped: true,
    dedupedDependenciesCount: 1,
  };
  return JSON.stringify([
    {
      name: "mono-agent",
      version: "0.0.0",
      path: "/repo",
      private: true,
      // pnpm 11.13.1 includes these root dev packages in `--parseable`
      // output under `--prod`; root filtering plus JSON sections excludes them.
      devDependencies: {
        "@types/node": { version: "22.19.19", path: "/repo/node_modules/@types/node" },
        "@vitest/coverage-v8": { version: "3.2.4", path: "/repo/node_modules/@vitest/coverage-v8" },
        vitest: { version: "3.2.4", path: "/repo/node_modules/vitest" },
      },
    },
    pnpm10Roots[0],
    workspaceRoot,
  ]);
}

function temporaryProject(dependencies) {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-vulnerable-dependency-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "ephemeral-vulnerability-fixture",
    private: true,
    dependencies,
  }, null, 2)}\n`);
  return root;
}

function graphFor(packageName, version, path) {
  return {
    inventory: { [packageName]: [version] },
    dependencyPaths: { [`${packageName}@${version}`]: [path] },
  };
}

function emptyDispositions() {
  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: REVIEWED_AT,
    advisories: [],
  };
}

function dispositionFor(packageName, version, advisory, dependencyPaths) {
  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: REVIEWED_AT,
    advisories: [{
      package: packageName,
      versions: [version],
      id: advisory.id,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
      vulnerableVersions: advisory.vulnerable_versions,
      disposition: "accepted-temporarily",
      expiresAt: EXPIRES_AT,
      dependencyPaths,
      owner: "fixture-security-owner",
      rationale: "Exact test-only disposition with a bounded expiry.",
    }],
  };
}

function wsAdvisory() {
  return {
    id: 1123259,
    severity: "high",
    title: "ws: Memory exhaustion DoS from tiny fragments and data chunks",
    url: "https://github.com/advisories/GHSA-96hv-2xvq-fx4p",
    vulnerable_versions: ">=8.0.0 <8.21.0",
  };
}

function lodashAdvisory() {
  return {
    id: 1106913,
    severity: "high",
    title: "Command Injection in lodash",
    url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
    vulnerable_versions: "<4.17.21",
  };
}

function commandResult(stdout) {
  return { exitCode: 0, stdout, stderr: "" };
}

function httpResponse(body, options = {}) {
  const status = options.status ?? 200;
  const source = options.raw ? String(body) : JSON.stringify(body);
  return new Response(source, { status });
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}

import { describe, expect, it } from "vitest";

import {
  parseNpmLockProductionGraph,
  resolveNpmLockNodePath,
  runIsolatedDependencyVulnerabilityChecks,
} from "../check-isolated-dependency-vulnerabilities.mjs";

describe("isolated dependency vulnerability gate", () => {
  it("parses hoisted and nested production paths from an npm v3 lockfile", () => {
    const graph = parseNpmLockProductionGraph(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture-root", dependencies: { alpha: "1.0.0" } },
        "node_modules/alpha": {
          version: "1.0.0",
          dependencies: { shared: "1.0.0", nested: "2.0.0" },
          optionalDependencies: { absent: "1.0.0" },
        },
        "node_modules/shared": { version: "1.0.0" },
        "node_modules/alpha/node_modules/nested": {
          name: "actual-nested",
          version: "2.0.0",
          dependencies: { shared: "1.0.0" },
        },
      },
    }));

    expect(graph).toEqual({
      inventory: {
        "actual-nested": ["2.0.0"],
        alpha: ["1.0.0"],
        shared: ["1.0.0"],
      },
      dependencyPaths: {
        "actual-nested@2.0.0": ["fixture-root -> alpha@1.0.0 -> actual-nested@2.0.0"],
        "alpha@1.0.0": ["fixture-root -> alpha@1.0.0"],
        "shared@1.0.0": [
          "fixture-root -> alpha@1.0.0 -> actual-nested@2.0.0 -> shared@1.0.0",
          "fixture-root -> alpha@1.0.0 -> shared@1.0.0",
        ],
      },
    });
  });

  it("resolves a dependency through package-local and ancestor node_modules folders", () => {
    const packages = {
      "node_modules/outer/node_modules/inner/node_modules/local": {},
      "node_modules/outer/node_modules/hoisted": {},
      "node_modules/root": {},
    };
    const parent = "node_modules/outer/node_modules/inner";
    expect(resolveNpmLockNodePath(packages, parent, "local"))
      .toBe("node_modules/outer/node_modules/inner/node_modules/local");
    expect(resolveNpmLockNodePath(packages, parent, "hoisted"))
      .toBe("node_modules/outer/node_modules/hoisted");
    expect(resolveNpmLockNodePath(packages, parent, "root")).toBe("node_modules/root");
    expect(resolveNpmLockNodePath(packages, parent, "missing")).toBeUndefined();
  });

  it("fails closed on malformed or unresolved production lock entries", () => {
    expect(() => parseNpmLockProductionGraph("not json")).toThrow(/not valid JSON/u);
    expect(() => parseNpmLockProductionGraph(JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "root", dependencies: { absent: "1" } } },
    }))).toThrow(/cannot resolve production dependency absent/u);
  });

  it("audits every isolated graph and returns one failed verdict", async () => {
    const calls = [];
    const stdout = sink();
    const result = await runIsolatedDependencyVulnerabilityChecks({
      repoRoot: "/repo",
      stdout,
      stderr: sink(),
      graphs: [
        { kind: "pnpm", label: "one", cwd: "one", rootPackageNames: ["one"], dispositions: "one.json" },
        { kind: "npm-lock", label: "two", cwd: "two", lockfile: "two/package-lock.json", dispositions: "two.json" },
      ],
      readFile: async () => JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "two", dependencies: { dep: "1" } },
          "node_modules/dep": { version: "1.0.0" },
        },
      }),
      runCheck: async (options) => {
        calls.push(options);
        return { exitCode: calls.length === 1 ? 1 : 0 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].rootPackageNames).toEqual(["one"]);
    expect(calls[1].productionGraph.inventory).toEqual({ dep: ["1.0.0"] });
    expect(stdout.text).toContain("isolated one");
    expect(stdout.text).toContain("isolated two");
  });
});

function sink() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
      return true;
    },
  };
}

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  mappedEntries,
  runVerifyDeepImports,
} from "../verify-deep-imports.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("verify-deep-imports", () => {
  it("maps every export in the exact 23-package publishable roster", () => {
    const entries = mappedEntries(repoRoot);
    const packageNames = [...new Set(entries.map((entry) => entry.packageName))];
    const specifiers = entries.map((entry) => entry.specifier);

    expect(packageNames).toHaveLength(23);
    expect(packageNames).toContain("@mono-agent/core");
    expect(packageNames).toContain("@mono-agent/docs-mcp");
    expect(packageNames).toContain("create-mono-agent");
    expect(packageNames).not.toContain("@mono-agent/agent-app");
    expect(packageNames).not.toContain("@mono-agent/agent-runtime");
    expect(specifiers).toContain("@mono-agent/module-sdk/http");
    expect(specifiers).toContain("@mono-agent/operator/testing");
    expect(specifiers).toContain("@mono-agent/cli/package.json");
    expect(specifiers).toContain("create-mono-agent/package.json");
    expect(entries.some((entry) => entry.specifier.includes("*"))).toBe(false);

    const roots = entries.filter((entry) => entry.key === ".");
    expect(roots).toHaveLength(23);
    expect(roots.every((entry) => entry.defaultTarget.endsWith("/dist/index.js"))).toBe(true);
    expect(roots.every((entry) => entry.typesTarget?.endsWith("/dist/index.d.ts"))).toBe(true);
  });

  it("rejects wildcard exports instead of silently skipping them", () => {
    expect(() => mappedEntries("/repo", {
      catalog: fixtureCatalog(),
      readFile: () => JSON.stringify({
        name: "@mono-agent/fixture",
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./*": { import: "./dist/*.js", types: "./dist/*.d.ts" },
        },
      }),
    })).toThrow(/must not use wildcard mappings/u);
  });

  it("verifies all mapped default imports and declared type targets through injectable boundaries", async () => {
    const imports = [];
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot,
      importFn: async (specifier, entry) => {
        imports.push({ specifier, json: entry.json });
        return {};
      },
      fileExists: () => true,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(imports).toHaveLength(mappedEntries(repoRoot).length);
    expect(imports).toContainEqual({
      specifier: "@mono-agent/cli/package.json",
      json: true,
    });
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(stdout.text).toContain("built-exports ok (23 packages");
    expect(stdout.text).toContain("(default)");
    expect(stdout.text).toContain("(types)");
  });

  it("fails when a declared types target is missing", async () => {
    const stdout = sink();
    const missing = resolve(repoRoot, "packages/module-sdk/dist/http.d.ts");
    const result = await runVerifyDeepImports({
      repoRoot,
      importFn: async () => ({}),
      fileExists: (path) => path !== missing,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain(
      "FAIL @mono-agent/module-sdk/http (types): declared types target missing on disk",
    );
    expect(result.results.find(
      (entry) => entry.specifier === "@mono-agent/module-sdk/http",
    )?.ok).toBe(false);
  });

  it("reports the exact default export that fails to load", async () => {
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot,
      importFn: async (specifier) => {
        if (specifier === "@mono-agent/operator/testing") throw new Error("boom");
        return {};
      },
      fileExists: () => true,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL @mono-agent/operator/testing (default): boom");
    expect(result.results.find(
      (entry) => entry.specifier === "@mono-agent/operator/testing",
    )?.ok).toBe(false);
  });

  it("resolves and imports every real built export", async () => {
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot,
      stdout,
      stderr: sink(),
    });
    if (result.exitCode !== 0) {
      throw new Error(`built export verification failed:\n${stdout.text}`);
    }

    expect(result.exitCode).toBe(0);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
  });
});

function fixtureCatalog() {
  return [{
    dir: "fixture",
    name: "@mono-agent/fixture",
    publishable: true,
  }];
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

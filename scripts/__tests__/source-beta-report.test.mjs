// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  KERNEL_FILE_MAXIMUM_LINES,
  SOURCE_BETA_LINE_BUDGETS,
  TEST_TO_PRODUCTION_MINIMUM_RATIO,
  assertSourceBetaBudgets,
  classifySourcePath,
  collectSourceBetaReport,
  collectExecutableConfigReference,
  collectSchemaFieldRows,
  discoverTypedModulePackages,
  listReportablePaths,
  minimumTestLines,
  renderSourceBetaConfigMarkdown,
} from "../lib/source-beta-report.mjs";
import { parseSourceBetaReportArgs } from "../source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("source-beta production budgets", () => {
  it("accepts every binding budget at exact equality", () => {
    expect(SOURCE_BETA_LINE_BUDGETS).toEqual([
      { id: "repository-production", maximumLines: 130_000 },
      { id: "kernel-production", maximumLines: 16_500 },
      { id: "durable-protocol-production", maximumLines: 9_500 },
    ]);
    const report = budgetReport({
      "repository-production": 130_000,
      "kernel-production": 16_500,
      "durable-protocol-production": 9_500,
    });

    expect(assertSourceBetaBudgets(report)).toBe(report);
  });

  it("caps any single kernel production file", () => {
    // A total-lines budget cannot stop one file becoming the place every kernel
    // change lands, which is exactly how host.ts reached 5,251 lines.
    const report = budgetReport({
      "repository-production": 1,
      "kernel-production": 1,
      "durable-protocol-production": 1,
    });
    report.kernelFiles = [
      { path: "packages/core/src/host.ts", lines: KERNEL_FILE_MAXIMUM_LINES },
    ];
    expect(assertSourceBetaBudgets(report)).toBe(report);

    report.kernelFiles = [
      { path: "packages/core/src/host.ts", lines: KERNEL_FILE_MAXIMUM_LINES + 1 },
    ];
    expect(() => assertSourceBetaBudgets(report)).toThrow(
      `packages/core/src/host.ts is ${String(KERNEL_FILE_MAXIMUM_LINES + 1)} lines; `
      + `no kernel production file may exceed ${String(KERNEL_FILE_MAXIMUM_LINES)}.`,
    );
  });

  it.each(SOURCE_BETA_LINE_BUDGETS)(
    "rejects $id at maximum plus one",
    (budget) => {
      const actualLines = Object.fromEntries(
        SOURCE_BETA_LINE_BUDGETS.map((entry) => [entry.id, entry.maximumLines]),
      );
      actualLines[budget.id] = budget.maximumLines + 1;

      expect(() => assertSourceBetaBudgets(budgetReport(actualLines))).toThrow(
        `${budget.id} exceeds ${String(budget.maximumLines)} lines by 1.`,
      );
    },
  );

  it("fails closed when a binding row is missing or its maximum is weakened", () => {
    expect(() => assertSourceBetaBudgets({ budgets: [] })).toThrow(
      "Expected exactly one repository-production budget row; found 0.",
    );

    const report = budgetReport({
      "repository-production": 130_000,
      "kernel-production": 16_500,
      "durable-protocol-production": 9_500,
    });
    report.budgets[1].maximumLines = 16_501;
    expect(() => assertSourceBetaBudgets(report)).toThrow(
      "kernel-production maximum must remain 16500 lines; found 16501.",
    );
  });

  it("holds the test-source floor at exact equality and rejects one line below", () => {
    const budgets = {
      "repository-production": 1,
      "kernel-production": 1,
      "durable-protocol-production": 1,
    };
    const production = 4_000;
    const floor = minimumTestLines(production);
    expect(floor).toBe(3_000);

    const atFloor = budgetReport(budgets, { production, test: floor });
    expect(assertSourceBetaBudgets(atFloor)).toBe(atFloor);

    expect(() => assertSourceBetaBudgets(
      budgetReport(budgets, { production, test: floor - 1 }),
    )).toThrow(
      `Test source is ${String(floor - 1)} lines against ${String(production)} production `
      + `lines; at least ${String(floor)} are required to hold the 0.75 floor (short by 1).`,
    );
  });

  it("fails closed when the totals a ratio needs are absent", () => {
    // A budget row can be forged; an absent measurement must not read as a pass.
    const report = budgetReport({
      "repository-production": 1,
      "kernel-production": 1,
      "durable-protocol-production": 1,
    });
    delete report.totals;

    expect(() => assertSourceBetaBudgets(report)).toThrow(
      "Production and test line totals are required to check the test-source ratio.",
    );
  });

  it("pins the floor so lowering it cannot pass unremarked", () => {
    // `check:source-beta-budgets` measures the real tree on every run, so this
    // does not restate that. It makes weakening the constant -- the cheapest way
    // to satisfy the gate without restoring a deleted test -- fail a test too.
    expect(TEST_TO_PRODUCTION_MINIMUM_RATIO).toBe(0.75);
    expect(minimumTestLines(0)).toBe(0);
    expect(minimumTestLines(3)).toBe(3);
    expect(minimumTestLines(1_000)).toBe(750);
  });

  it("accepts both direct and pnpm-separated JSON arguments", () => {
    expect(parseSourceBetaReportArgs(["--json"])).toBe(true);
    expect(parseSourceBetaReportArgs(["--", "--json"])).toBe(true);
    expect(() => parseSourceBetaReportArgs(["--", "--json", "extra"])).toThrow(
      "Usage: node --experimental-strip-types scripts/source-beta-report.mjs [--json]",
    );
  });

  it("counts generated-looking package source as production and rejects unclassified code", () => {
    expect(classifySourcePath("packages/core/src/generated/hidden.ts")).toBe("production");
    expect(classifySourcePath("packages/web/webapp/src/App.tsx")).toBe("production");
    expect(classifySourcePath("packages/web/webapp/public/notification-sw.js")).toBe("production");
    expect(classifySourcePath("packages/web/webapp/src/browser.test.tsx")).toBe("test");
    expect(classifySourcePath("packages/web/webapp/vite.config.ts")).toBe("tooling");
    expect(classifySourcePath("website/astro.config.mjs")).toBe("production");
    expect(classifySourcePath("packages/tui/vitest.config.ts")).toBe("test");
    expect(classifySourcePath("vitest.config.mjs")).toBe("test");
    expect(classifySourcePath("playwright.config.mjs")).toBe("test");
    expect(classifySourcePath("tests/browser/console-render.spec.mjs")).toBe("test");
    expect(classifySourcePath("tests/browser/fixture-server.mjs")).toBe("test");
    expect(classifySourcePath("extras/docs-mcp/scripts/generate-corpus.mjs")).toBe("tooling");
    expect(classifySourcePath("extras/docs-mcp/scripts/smoke-packed-contract.mjs"))
      .toBe("tooling");
    expect(classifySourcePath("website/scripts/check-links.mjs")).toBe("tooling");
    expect(classifySourcePath("eslint.config.mjs")).toBe("tooling");
    for (const path of [
      "packages/core/src/test/hidden.ts",
      "packages/core/src/tests/hidden.ts",
      "packages/core/src/hidden.spec.ts",
      "packages/core/src/nested/__tests__/hidden.ts",
      "packages/core/src/vitest.config.ts",
      "website/src/playwright.config.ts",
    ]) {
      expect(classifySourcePath(path)).toBe("production");
    }

    for (const path of [
      "packages/core/hidden.ts",
      "packages/core/dist/hidden.js",
      "rogue.ts",
    ]) {
      expect(() => classifySourcePath(path)).toThrow(
        `Unclassified executable source file ${path}`,
      );
    }
  });

  it("omits deleted tracked files but retains dangling tracked source symlinks to fail closed", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "source-beta-paths-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
      writeFileSync(join(fixtureRoot, "deleted.ts"), "export {};\n", "utf8");
      symlinkSync("missing-target.ts", join(fixtureRoot, "rogue.ts"));
      execFileSync("git", ["add", "--all"], { cwd: fixtureRoot });
      unlinkSync(join(fixtureRoot, "deleted.ts"));

      expect(listReportablePaths(fixtureRoot)).toEqual(["rogue.ts"]);
      expect(() => collectSourceBetaReport({
        root: fixtureRoot,
        renderProject: () => {
          throw new Error("renderProject must not be reached");
        },
      })).toThrow("Source file rogue.ts must be a stable regular file.");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects an existing external source symlink without reading its target", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "source-beta-external-link-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "source-beta-external-target-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
      mkdirSync(join(fixtureRoot, "scripts"));
      const externalTarget = join(externalRoot, "private.bin");
      writeFileSync(externalTarget, Buffer.from([0]));
      symlinkSync(externalTarget, join(fixtureRoot, "scripts", "rogue.mjs"));
      execFileSync("git", ["add", "--all"], { cwd: fixtureRoot });

      expect(() => collectSourceBetaReport({
        root: fixtureRoot,
        renderProject: () => {
          throw new Error("renderProject must not be reached");
        },
      })).toThrow("Source file scripts/rogue.mjs must be a stable regular file.");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

describe("executable config schema reference", () => {
  it("traverses required/default/constraint/security/cross-slot annotations", () => {
    const rows = collectSchemaFieldRows({
      type: "object",
      additionalProperties: false,
      required: ["mode", "credentials", "runtime"],
      properties: {
        mode: { enum: ["safe", "fast"], default: "safe" },
        credentials: {
          type: "object",
          "x-mono-agent-secret": true,
          required: ["token"],
          properties: {
            token: {
              type: "string",
              minLength: 20,
              maxLength: 4096,
              pattern: "^\\S+$",
              "x-mono-agent-env-eligible": true,
            },
          },
        },
        runtime: {
          type: "string",
          "x-mono-agent-slot-reference": {
            slot: "runtime",
            capability: "memory.runtime-capture",
          },
        },
        roots: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        auth: {
          oneOf: [
            {
              type: "object",
              required: ["method", "token"],
              properties: {
                method: { const: "token" },
                token: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["method", "path"],
              properties: {
                method: { const: "file" },
                path: { type: "string" },
              },
            },
          ],
        },
      },
    }, { prefix: "memory", rootRequired: "selected" });

    expect(row(rows, "memory")).toMatchObject({
      type: "object",
      required: "selected",
      constraints: "closed object",
    });
    expect(row(rows, "memory.mode")).toMatchObject({
      type: "string",
      required: "yes",
      default: "\"safe\"",
      constraints: "enum [\"safe\",\"fast\"]",
    });
    expect(row(rows, "memory.credentials.token")).toMatchObject({
      required: "yes",
      environmentEligible: "yes",
      secret: "yes",
      constraints: "maxLength 4096; minLength 20; pattern \"^\\\\S+$\"",
    });
    expect(row(rows, "memory.runtime")).toMatchObject({
      required: "yes",
      crossSlot: "runtime capability memory.runtime-capture",
    });
    expect(row(rows, "memory.roots")).toMatchObject({
      required: "no",
      constraints: "unique items",
    });
    expect(row(rows, "memory.roots[]")).toMatchObject({
      required: "item",
      constraints: "minLength 1",
    });
    expect(row(rows, "memory.auth")).toMatchObject({
      type: "object",
      required: "no",
    });
    expect(row(rows, "memory.auth.method").required).toBe("yes");
    expect(row(rows, "memory.auth.token").required).toBe("conditional");
    expect(row(rows, "memory.auth.path").required).toBe("conditional");
  });

  it("collapses selected Core subtrees and adds exact module selection rows", () => {
    const reference = collectExecutableConfigReference({
      coreSchema: {
        type: "object",
        required: ["runtimes"],
        properties: {
          runtimes: {
            type: "object",
            required: ["main"],
            properties: {
              main: {
                type: "object",
                required: ["$use"],
                properties: {
                  $use: { const: "@mono-agent/runtime-fixture" },
                  internal: { type: "string" },
                },
              },
            },
          },
        },
      },
      selectedModules: [{ configPath: "runtimes.main", kind: "runtime" }],
      typedModules: [{
        packageName: "@mono-agent/runtime-fixture",
        kind: "runtime",
        jsonSchema: {
          type: "object",
          properties: { model: { type: "string", default: "fixture" } },
        },
      }],
    });

    expect(reference.core.rows.map(({ path }) => path)).toEqual([
      "$",
      "runtimes",
      "runtimes.{id}",
    ]);
    expect(row(reference.core.rows, "runtimes.{id}").required).toBe("selected");
    expect(reference.modules[0].rows.map(({ path }) => path)).toEqual([
      "runtimes.{id}",
      "runtimes.{id}.$use",
      "runtimes.{id}.model",
    ]);
    expect(row(reference.modules[0].rows, "runtimes.{id}.$use").constraints).toBe(
      "const \"@mono-agent/runtime-fixture\"",
    );
  });

  it("covers every publishable typed module declared by the package catalog", () => {
    expect(discoverTypedModulePackages(root).map(({ packageName }) => packageName)).toEqual([
      "@mono-agent/channel-openai-api",
      "@mono-agent/channel-operator",
      "@mono-agent/channel-slack",
      "@mono-agent/channel-telegram",
      "@mono-agent/channel-webhook",
      "@mono-agent/exporter-otlp",
      "@mono-agent/memory-local",
      "@mono-agent/runtime-claude",
      "@mono-agent/runtime-codex",
      "@mono-agent/runtime-opencode",
      "@mono-agent/runtime-pi",
      "@mono-agent/sandbox-srt",
      "@mono-agent/state-local",
      "@mono-agent/trigger-cron",
    ]);
  });

  it("changes generated reference bytes when an executable module field changes", () => {
    const render = (properties) => {
      const configReference = collectExecutableConfigReference({
        coreSchema: { type: "object", properties: {} },
        selectedModules: [],
        typedModules: [{
          packageName: "@mono-agent/runtime-fixture",
          kind: "runtime",
          jsonSchema: { type: "object", properties },
        }],
      });
      return renderSourceBetaConfigMarkdown({
        templates: { rows: [], configPaths: [] },
      }, [], configReference);
    };

    const before = render({ model: { type: "string" } });
    const after = render({
      model: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, default: 1000 },
    });
    expect(after).not.toBe(before);
    expect(after).toContain("`runtimes.{id}.timeoutMs`");
  });
});

function budgetReport(actualLinesById, { production = 1_000, test = 1_000 } = {}) {
  return {
    budgets: SOURCE_BETA_LINE_BUDGETS.map((budget) => ({
      ...budget,
      actualLines: actualLinesById[budget.id],
      withinLimit: actualLinesById[budget.id] <= budget.maximumLines,
    })),
    totals: {
      byClassification: {
        production: { files: 1, lines: production },
        test: { files: 1, lines: test },
      },
    },
  };
}

function row(rows, path) {
  const match = rows.find((entry) => entry.path === path);
  expect(match, `missing schema row ${path}`).toBeDefined();
  return match;
}

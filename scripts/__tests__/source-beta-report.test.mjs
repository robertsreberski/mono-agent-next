import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SOURCE_BETA_LINE_BUDGETS,
  assertSourceBetaBudgets,
  classifySourcePath,
  collectExecutableConfigReference,
  collectSchemaFieldRows,
  discoverTypedModulePackages,
  renderSourceBetaConfigMarkdown,
} from "../lib/source-beta-report.mjs";
import { parseSourceBetaReportArgs } from "../source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("source-beta production budgets", () => {
  it("accepts both binding budgets at exact equality", () => {
    expect(SOURCE_BETA_LINE_BUDGETS).toEqual([
      { id: "repository-production", maximumLines: 130_000 },
      { id: "kernel-production", maximumLines: 15_500 },
    ]);
    const report = budgetReport({
      "repository-production": 130_000,
      "kernel-production": 15_500,
    });

    expect(assertSourceBetaBudgets(report)).toBe(report);
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
      "kernel-production": 15_500,
    });
    report.budgets[1].maximumLines = 15_501;
    expect(() => assertSourceBetaBudgets(report)).toThrow(
      "kernel-production maximum must remain 15500 lines; found 15501.",
    );
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
    expect(classifySourcePath("extras/docs-mcp/scripts/generate-corpus.mjs")).toBe("tooling");
    expect(classifySourcePath("website/scripts/check-links.mjs")).toBe("tooling");
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

function budgetReport(actualLinesById) {
  return {
    budgets: SOURCE_BETA_LINE_BUDGETS.map((budget) => ({
      ...budget,
      actualLines: actualLinesById[budget.id],
      withinLimit: actualLinesById[budget.id] <= budget.maximumLines,
    })),
  };
}

function row(rows, path) {
  const match = rows.find((entry) => entry.path === path);
  expect(match, `missing schema row ${path}`).toBeDefined();
  return match;
}

import { describe, expect, it } from "vitest";

import {
  SOURCE_BETA_LINE_BUDGETS,
  assertSourceBetaBudgets,
  classifySourcePath,
} from "../lib/source-beta-report.mjs";
import { parseSourceBetaReportArgs } from "../source-beta-report.mjs";

describe("source-beta production budgets", () => {
  it("accepts both binding budgets at exact equality", () => {
    expect(SOURCE_BETA_LINE_BUDGETS).toEqual([
      { id: "repository-production", maximumLines: 130_000 },
      { id: "kernel-production", maximumLines: 15_000 },
    ]);
    const report = budgetReport({
      "repository-production": 130_000,
      "kernel-production": 15_000,
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
      "kernel-production": 15_000,
    });
    report.budgets[1].maximumLines = 15_001;
    expect(() => assertSourceBetaBudgets(report)).toThrow(
      "kernel-production maximum must remain 15000 lines; found 15001.",
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

function budgetReport(actualLinesById) {
  return {
    budgets: SOURCE_BETA_LINE_BUDGETS.map((budget) => ({
      ...budget,
      actualLines: actualLinesById[budget.id],
      withinLimit: actualLinesById[budget.id] <= budget.maximumLines,
    })),
  };
}

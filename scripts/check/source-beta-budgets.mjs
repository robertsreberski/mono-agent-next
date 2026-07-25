#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertSourceBetaBudgets,
  collectSourceBetaReport,
  minimumTestLines,
} from "../lib/source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { renderProject } = await import(
  pathToFileURL(join(root, "packages/create-mono-agent/src/templates.ts")).href
);
const report = collectSourceBetaReport({ root, renderProject });
assertSourceBetaBudgets(report);

// The test-source floor is reported alongside the maxima; a budget the operator
// never sees on a passing run is one nobody notices the tree drifting toward.
const { production, test } = report.totals.byClassification;
process.stdout.write(
  `Source-beta production budgets passed: ${[
    ...report.budgets
      .map((budget) => `${budget.id} ${String(budget.actualLines)}/${String(budget.maximumLines)}`),
    `test-source floor ${String(test.lines)}/${String(minimumTestLines(production.lines))}`,
  ].join("; ")}.\n`,
);

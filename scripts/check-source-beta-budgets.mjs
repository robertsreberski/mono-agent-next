#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertSourceBetaBudgets,
  collectSourceBetaReport,
} from "./lib/source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { renderProject } = await import(
  pathToFileURL(join(root, "packages/create-mono-agent/src/templates.ts")).href
);
const report = collectSourceBetaReport({ root, renderProject });
assertSourceBetaBudgets(report);

process.stdout.write(
  `Source-beta production budgets passed: ${report.budgets
    .map((budget) => `${budget.id} ${String(budget.actualLines)}/${String(budget.maximumLines)}`)
    .join("; ")}.\n`,
);

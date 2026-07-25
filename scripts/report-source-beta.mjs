#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectSourceBetaReport,
  renderSourceBetaComplexityMarkdown,
} from "./lib/source-beta-report.mjs";

export function parseSourceBetaReportArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length === 0) return false;
  if (normalized.length === 1 && normalized[0] === "--json") return true;
  throw new Error("Usage: node --experimental-strip-types scripts/report-source-beta.mjs [--json]");
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { renderProject } = await import(
    pathToFileURL(join(root, "packages/create-mono-agent/src/templates.ts")).href
  );
  const json = parseSourceBetaReportArgs(process.argv.slice(2));
  const report = collectSourceBetaReport({ root, renderProject });
  process.stdout.write(json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderSourceBetaComplexityMarkdown(report));
}

const isCli =
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) await main();

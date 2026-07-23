#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectSourceBetaReport,
  renderSourceBetaComplexityMarkdown,
} from "./lib/source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { renderProject } = await import(
  pathToFileURL(join(root, "packages/create-mono-agent/src/templates.ts")).href
);
const json = parseArgs(process.argv.slice(2));
const report = collectSourceBetaReport({ root, renderProject });
process.stdout.write(json
  ? `${JSON.stringify(report, null, 2)}\n`
  : renderSourceBetaComplexityMarkdown(report));

function parseArgs(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--json") return true;
  throw new Error("Usage: node --experimental-strip-types scripts/source-beta-report.mjs [--json]");
}

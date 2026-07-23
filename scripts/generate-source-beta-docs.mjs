#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SOURCE_BETA_REPORT_OUTPUT,
  collectSourceBetaReport,
  renderSourceBetaComplexityMarkdown,
  renderSourceBetaConfigMarkdown,
  renderSourceBetaProductsMarkdown,
  renderSourceBetaPublicApiMarkdown,
} from "./lib/source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { renderProject } = await import(
  pathToFileURL(join(root, "packages/create-mono-agent/src/templates.ts")).href
);

const check = parseArgs(process.argv.slice(2));
const report = collectSourceBetaReport({ root, renderProject });
const renderedProjects = report.templates.rows.map(({ template }) => {
  const files = renderProject({ projectName: `${template}-source-beta`, template });
  const configSource = files.find((file) => file.path === "mono-agent.config.json")?.contents;
  if (configSource === undefined) throw new Error(`${template} did not render mono-agent.config.json.`);
  return Object.freeze({ template, config: JSON.parse(configSource) });
});
const outputs = new Map([
  ["docs/config/reference.md", renderSourceBetaConfigMarkdown(report, renderedProjects)],
  ["docs/products/index.md", renderSourceBetaProductsMarkdown(report)],
  ["docs/reference/public-api.md", renderSourceBetaPublicApiMarkdown(report)],
  [SOURCE_BETA_REPORT_OUTPUT, renderSourceBetaComplexityMarkdown(report)],
]);

let changed = 0;
for (const [relativePath, contents] of outputs) {
  const path = join(root, relativePath);
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (current === contents) continue;
  changed += 1;
  if (!check) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

if (check && changed > 0) {
  throw new Error(
    `${String(changed)} generated source-beta documentation file(s) are stale; run pnpm run generate:source-beta-docs.`,
  );
}
console.log(
  check
    ? `Source-beta documentation is current (${String(outputs.size)} files checked).`
    : `Source-beta documentation generated (${String(changed)} files updated).`,
);

function parseArgs(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--check") return true;
  throw new Error("Usage: node --experimental-strip-types scripts/generate-source-beta-docs.mjs [--check]");
}

function isMissing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}

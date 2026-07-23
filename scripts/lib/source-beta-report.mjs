import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join, posix } from "node:path";

import { packageCatalog, packageRelativePath } from "../package-catalog.mjs";
import { collectPackagePublicApiInventories } from "./public-api-docs.mjs";

export const SOURCE_BETA_REPORT_SCHEMA = "mono-agent.source-beta-report.v1";
export const SOURCE_BETA_REPORT_OUTPUT = "docs/reference/source-beta-complexity.md";
export const SOURCE_BETA_LINE_BUDGETS = Object.freeze([
  Object.freeze({
    id: "repository-production",
    maximumLines: 130_000,
  }),
  Object.freeze({
    id: "kernel-production",
    maximumLines: 15_000,
  }),
]);

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const GENERATED_REPORT_PATHS = new Set([
  "docs/config/reference.md",
  "docs/products/index.md",
  "docs/reference/public-api.md",
  SOURCE_BETA_REPORT_OUTPUT,
]);

export function collectSourceBetaReport({ root, renderProject }) {
  const trackedPaths = listReportablePaths(root);
  const files = trackedPaths
    .filter((path) => isSourcePath(path))
    .map((path) => sourceFileRecord(root, path));
  const source = summarizeSourceFiles(files);
  const packages = packageRows(root, files);
  const dependencyGraph = collectDependencyGraph(root);
  const publicApi = collectPublicApi(root);
  const templates = collectTemplateClosures(renderProject);
  const actualLinesByBudget = new Map([
    ["repository-production", source.byClassification.production.lines],
    [
      "kernel-production",
      packages
        .filter((row) => [
          "@mono-agent/cli",
          "@mono-agent/core",
          "@mono-agent/module-sdk",
        ].includes(row.name))
        .reduce((sum, row) => sum + row.productionLines, 0),
    ],
  ]);
  const budgets = SOURCE_BETA_LINE_BUDGETS.map((budget) => {
    const actualLines = actualLinesByBudget.get(budget.id);
    if (actualLines === undefined) {
      throw new Error(`No source measurement exists for binding budget ${budget.id}.`);
    }
    return Object.freeze({
      ...budget,
      actualLines,
      withinLimit: actualLines <= budget.maximumLines,
    });
  });
  const manifestDigest = digest(JSON.stringify(files.map((file) => ({
    path: file.path,
    classification: file.classification,
    owner: file.owner,
    lines: file.lines,
    sha256: file.sha256,
  }))));

  return Object.freeze({
    schema: SOURCE_BETA_REPORT_SCHEMA,
    sourceDigest: manifestDigest,
    files: Object.freeze(files),
    totals: source,
    budgets: Object.freeze(budgets),
    packages: Object.freeze(packages),
    dependencyGraph,
    publicApi,
    templates,
  });
}

export function assertSourceBetaBudgets(report) {
  if (report === null || typeof report !== "object" || !Array.isArray(report.budgets)) {
    throw new Error("Source-beta budget assertion requires a report with a budgets array.");
  }

  const issues = [];
  const rowsById = new Map();
  for (const row of report.budgets) {
    if (row === null || typeof row !== "object" || typeof row.id !== "string") {
      issues.push("Budget rows must be objects with string ids.");
      continue;
    }
    const rows = rowsById.get(row.id) ?? [];
    rows.push(row);
    rowsById.set(row.id, rows);
  }

  const expectedIds = new Set(SOURCE_BETA_LINE_BUDGETS.map((budget) => budget.id));
  for (const id of rowsById.keys()) {
    if (!expectedIds.has(id)) issues.push(`Unexpected source-beta budget ${id}.`);
  }

  for (const expected of SOURCE_BETA_LINE_BUDGETS) {
    const rows = rowsById.get(expected.id) ?? [];
    if (rows.length !== 1) {
      issues.push(
        `Expected exactly one ${expected.id} budget row; found ${String(rows.length)}.`,
      );
      continue;
    }
    const [row] = rows;
    if (row.maximumLines !== expected.maximumLines) {
      issues.push(
        `${expected.id} maximum must remain ${String(expected.maximumLines)} lines; `
        + `found ${String(row.maximumLines)}.`,
      );
    }
    if (!Number.isSafeInteger(row.actualLines) || row.actualLines < 0) {
      issues.push(`${expected.id} actual lines must be a non-negative safe integer.`);
      continue;
    }
    const withinLimit = row.actualLines <= expected.maximumLines;
    if (row.withinLimit !== withinLimit) {
      issues.push(
        `${expected.id} withinLimit must be ${String(withinLimit)} for `
        + `${String(row.actualLines)} lines.`,
      );
    }
    if (!withinLimit) {
      issues.push(
        `${expected.id} exceeds ${String(expected.maximumLines)} lines by `
        + `${String(row.actualLines - expected.maximumLines)}.`,
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(`Source-beta production budget assertion failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
  return report;
}

export function summarizeSourceFiles(files) {
  const byClassification = Object.create(null);
  for (const name of ["production", "test", "tooling", "generated"]) {
    byClassification[name] = { files: 0, lines: 0 };
  }
  for (const file of files) {
    const bucket = byClassification[file.classification];
    if (bucket === undefined) throw new Error(`Unknown source classification ${file.classification}.`);
    bucket.files += 1;
    bucket.lines += file.lines;
  }
  return Object.freeze({
    files: files.length,
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    byClassification: Object.freeze(Object.fromEntries(
      Object.entries(byClassification).map(([name, value]) => [name, Object.freeze(value)]),
    )),
  });
}

export function renderSourceBetaComplexityMarkdown(report) {
  const production = report.totals.byClassification.production;
  const test = report.totals.byClassification.test;
  const tooling = report.totals.byClassification.tooling;
  const generated = report.totals.byClassification.generated;
  const average = production.files === 0 ? 0 : production.lines / production.files;
  const largest = [...report.packages]
    .sort((left, right) => right.productionLines - left.productionLines || compareText(left.name, right.name))
    .slice(0, 8);
  return `---
title: "Source-beta complexity report"
description: "Reproducible production, test, tooling, package, dependency, public-API, and scaffold-closure measurements for mono-agent v1."
sidebar:
  order: 10
---

This report is generated from the current source tree. It counts reportable
source files returned by Git (\`--cached --others --exclude-standard\`), so a
clean checkout and a pre-commit worktree produce the same result for the same
files. Generated documentation outputs are excluded from their own input.

Reproduce it with:

\`\`\`bash
pnpm run report:source-beta
pnpm run generate:source-beta-docs
\`\`\`

Source manifest digest: \`${report.sourceDigest}\`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | ${production.files} | ${production.lines} |
| Tests | ${test.files} | ${test.lines} |
| Repository and product tooling | ${tooling.files} | ${tooling.lines} |
| Checked-in generated source | ${generated.files} | ${generated.lines} |
| **Total executable source** | **${report.totals.files}** | **${report.totals.lines}** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is ${average.toFixed(1)} lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
${report.budgets.map((budget) => `| ${budget.id} | ${budget.actualLines} | ${budget.maximumLines} | ${budget.withinLimit ? "within limit" : "over limit"} |`).join("\n")}

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
${largest.map((row) => `| \`${row.name}\` | ${row.productionFiles} | ${row.productionLines} | ${row.testLines} |`).join("\n")}

The complete package table is retained in the generated report model exposed by
\`pnpm --silent run report:source-beta -- --json\`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | ${report.packages.length} |
| First-party dependency edges | ${report.dependencyGraph.edgeCount} |
| First-party dependency cycles | ${report.dependencyGraph.cycles.length} |
| Public code entrypoints | ${report.publicApi.entrypointCount} |
| Public named exports | ${report.publicApi.symbolCount} |
| Distinct scaffold config paths | ${report.templates.configPathCount} |

${report.dependencyGraph.cycles.length === 0
    ? "The first-party package graph is acyclic."
    : `Detected cycles: ${report.dependencyGraph.cycles.map((cycle) => cycle.join(" -> ")).join("; ")}`}

## Scaffold closure

| Template | Direct production dependencies | Selected modules |
| --- | ---: | ---: |
${report.templates.rows.map((row) => `| \`${row.template}\` | ${row.dependencies.length} | ${row.selectedPackages.length} |`).join("\n")}

The generated [config reference](/config/reference/) records the exact package
names and seed configuration for each template. The packed system verification
installs all three closures and executes their first-turn fixtures.
`;
}

export function renderSourceBetaPublicApiMarkdown(report) {
  return `---
title: "Public API inventory"
description: "Generated package-by-package inventory of every public code entrypoint and named export in mono-agent v1."
sidebar:
  order: 3
---

This page is generated from each publishable package's \`exports\` map and
source entrypoint. Package READMEs contain the same generated symbol
inventories next to curated start-here guidance.

Regenerate both surfaces with:

\`\`\`bash
pnpm run generate:public-api-docs
pnpm run generate:source-beta-docs
\`\`\`

| Package | Public entrypoints | Named exports | Package API |
| --- | ---: | ---: | --- |
${report.publicApi.packages.map((row) => `| \`${row.name}\` | ${row.entrypoints.length} | ${row.symbolCount} | [README](${packageReadmeLink(row.path)}) |`).join("\n")}

## Entrypoints and symbols

${report.publicApi.packages.map((row) => {
    const sections = row.entrypoints.map((entrypoint) => {
      const label = entrypoint.subpath === "."
        ? row.name
        : `${row.name}/${entrypoint.subpath.slice(2)}`;
      return `### \`${label}\`

\`\`\`text
${entrypoint.exportNames.length === 0 ? "(no named exports)" : entrypoint.exportNames.join("\n")}
\`\`\``;
    }).join("\n\n");
    return `## \`${row.name}\`

${sections.length === 0 ? "This package has no public code entrypoint." : sections}`;
  }).join("\n\n")}
`;
}

export function renderSourceBetaConfigMarkdown(report, renderedProjects) {
  const templateRows = report.templates.rows.map((row) => `| \`${row.template}\` | ${row.dependencies.map(code).join(", ")} | ${row.selectedPackages.map(code).join(", ")} | ${row.environmentNames.map(code).join(", ")} |`).join("\n");
  const configPaths = report.templates.configPaths.map((path) => {
    const usedBy = report.templates.rows
      .filter((row) => row.configPaths.includes(path))
      .map((row) => `\`${row.template}\``)
      .join(", ");
    return `| \`${path}\` | ${usedBy} |`;
  }).join("\n");
  return `---
title: "Generated config reference"
description: "Exact v1 agent envelope, selected-module rules, scaffold dependency closures, environment references, and generated seed configurations."
sidebar:
  order: 2
---

Mono-agent v1 intentionally has no global mega-schema. Core owns one strict
agent envelope; each literal \`$use\` selection contributes its own schema.
Generate the exact installed project schema with:

\`\`\`bash
mono-agent config schema --config ./mono-agent.config.json --write
\`\`\`

That command first proves every selection is a matching direct production
dependency in the root lockfile. It then composes only the selected module
schemas. Package presence alone never activates a capability.

## Fixed envelope

Required top-level fields are \`configVersion\`, \`agent\`, \`runtimes\`,
\`routing\`, and \`policy\`. Optional fields are \`session\`, \`context\`,
\`channels\`, \`memory\`, \`state\`, \`triggers\`, and
\`observability.exporters\`.

Runtime, channel, trigger, and exporter slots are instance maps. Memory and
state are singletons. \`policy.sandbox\` is either \`{"mode":"off"}\` or one
selected sandbox object. Every selected object begins with an exact package
name in \`$use\`.

## Generated scaffold matrix

| Template | Exact direct dependencies | Selected modules | Referenced environment names |
| --- | --- | --- | --- |
${templateRows}

The three core packages are direct dependencies but are not selected modules:
\`@mono-agent/module-sdk\`, \`@mono-agent/core\`, and \`@mono-agent/cli\`.
Separate products such as TUI, web, service-macos, and docs-mcp never enter an
agent template because their lifecycle is independent.

## Seed config path inventory

This table is generated from the three current scaffolder outputs. Module
options not selected by a template remain discoverable through that module's
README and the exact composed schema.

| JSON path | Generated templates |
| --- | --- |
${configPaths}

## Generated seed configurations

${renderedProjects.map(({ template, config }) => `### \`${template}\`

\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\``).join("\n\n")}

## Environment and secret rules

Mono-agent does not implicitly load \`.env\` or \`.env.example\`. Only explicit
\`{"$env":"NAME"}\` references at schema-declared environment-eligible paths
are resolved. Secret-marked module fields reject inline values; missing or
empty values fail validation; explain and inspection output report the variable
name while redacting its value.

The scaffolder writes names-only \`.env.example\` files and never writes
credentials. Service-macos may read a separately protected environment file,
but it passes only the path to the runner and never expands secret values into a
LaunchAgent plist or plan.
`;
}

export function renderSourceBetaProductsMarkdown(report) {
  const products = [
    {
      packageName: "@mono-agent/cli",
      lifecycle: "Foreground agent frontend",
      config: "mono-agent.config.json",
      activation: "mono-agent start --config <file>",
    },
    {
      packageName: "create-mono-agent",
      lifecycle: "Pre-runtime project scaffolder",
      config: "Template arguments; writes a new project",
      activation: "create-mono-agent <directory>",
    },
    {
      packageName: "@mono-agent/service-macos",
      lifecycle: "Optional macOS boot integration",
      config: "Separate service-macos.json",
      activation: "inspect / plan / explicit apply or remove",
    },
    {
      packageName: "@mono-agent/tui",
      lifecycle: "Standalone terminal renderer",
      config: "Endpoint or owner-private discovery entry",
      activation: "mono-agent-tui",
    },
    {
      packageName: "@mono-agent/web",
      lifecycle: "Standalone browser product",
      config: "Separate web.config.json",
      activation: "mono-agent-web",
    },
    {
      packageName: "@mono-agent/docs-mcp",
      lifecycle: "Coding-client companion MCP",
      config: "Client mcpServers registration",
      activation: "mono-agent-docs-mcp over stdio",
    },
  ];
  const packageNames = new Set(report.packages.map((row) => row.name));
  for (const product of products) {
    if (!packageNames.has(product.packageName)) {
      throw new Error(`Product docs refer to missing package ${product.packageName}.`);
    }
  }
  return `---
title: "Products and companion lifecycle"
description: "Generated lifecycle and configuration boundaries for the mono-agent CLI, scaffolder, operator renderers, macOS service integration, and documentation companion."
sidebar:
  order: 0
---

These products are installed and operated independently. None is activated by
package presence, and none belongs in an agent's selected-module graph unless
the row explicitly names the agent config.

| Package | Lifecycle | Configuration authority | Normal entrypoint |
| --- | --- | --- | --- |
${products.map((product) => `| \`${product.packageName}\` | ${product.lifecycle} | ${product.config} | \`${product.activation}\` |`).join("\n")}

## Boundary rules

- Core remains foreground-runnable without service-macos, TUI, web, or docs-mcp.
- TUI and web consume the shared operator protocol; they do not load runtimes
  or own the agent process.
- Service-macos reads only its separate desired-state file. Inspect and plan
  are read-only. Apply and remove require an exact fingerprint plus explicit
  mutation authorization; drift fails before mutation, and bounded failures
  restore the prior plist and loaded state when that state can be proven.
- Removing service-macos disables the LaunchAgent and removes its managed plist;
  it does not rewrite agent config, remove data, or delete logs.
- Docs-mcp is registered in a coding client's \`mcpServers\` map and has no
  runtime dependency on Core.
- The scaffolder writes exact selected dependencies before the agent exists. It
  never authenticates a provider or initializes memory's permanent first-run
  marker.

## Source-beta phase

The source-beta proof builds, packs, clean-installs, imports, validates, and
executes bounded fixtures. It does not publish packages, change a live service,
migrate user data, deploy a consumer, run a soak, or retire the predecessor.
`;
}

function listReportablePaths(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split("\\").join("/"))
    .filter((path) => !GENERATED_REPORT_PATHS.has(path))
    .sort(compareText);
}

function isSourcePath(path) {
  return SOURCE_EXTENSIONS.has(extname(path));
}

function sourceFileRecord(root, path) {
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) throw new Error(`Source file ${path} contains a NUL byte.`);
  const source = bytes.toString("utf8");
  return Object.freeze({
    path,
    classification: classifySourcePath(path),
    owner: sourceOwner(path),
    lines: physicalLines(source),
    sha256: digest(bytes),
  });
}

export function classifySourcePath(path) {
  const packageSource = /^(?:packages|extras)\/[^/]+\/src\//u.test(path);
  if (packageSource) {
    if (
      /^(?:packages|extras)\/[^/]+\/src\/__tests__\//u.test(path)
      || /\.test\.ts$/u.test(path)
      || /^packages\/tui\/src\/.*\.test\.tsx$/u.test(path)
    ) return "test";
    return "production";
  }

  if (path.startsWith("website/src/") || path === "website/astro.config.mjs") {
    return "production";
  }
  if (/(?:^|\/)(?:playwright|vitest)\.config\.(?:mjs|ts)$/u.test(path)) return "test";
  if (
    /^scripts\/(?:.*\/)?__tests__\//u.test(path)
    || /^website\/(?:scripts\/__tests__|tests)\//u.test(path)
  ) return "test";
  if (
    path.startsWith("scripts/")
    || path.startsWith("website/scripts/")
    || /^extras\/docs-mcp\/scripts\/(?:generate-corpus|smoke-packed)\.mjs$/u.test(path)
  ) return "tooling";
  throw new Error(
    `Unclassified executable source file ${path}; add an explicit production, test, `
    + "tooling, or reproducible generated-source rule.",
  );
}

function sourceOwner(path) {
  for (const entry of packageCatalog) {
    const prefix = `${packageRelativePath(entry)}/`;
    if (path.startsWith(prefix)) return entry.name;
  }
  if (path.startsWith("website/")) return "documentation-website";
  return "repository-tooling";
}

function physicalLines(source) {
  if (source.length === 0) return 0;
  const newlineCount = source.match(/\n/gu)?.length ?? 0;
  return newlineCount + (source.endsWith("\n") ? 0 : 1);
}

function packageRows(root, files) {
  return packageCatalog.map((entry) => {
    const packagePath = packageRelativePath(entry);
    const manifest = JSON.parse(readFileSync(join(root, packagePath, "package.json"), "utf8"));
    if (manifest.name !== entry.name) throw new Error(`${packagePath} does not contain ${entry.name}.`);
    const owned = files.filter((file) => file.owner === entry.name);
    const production = owned.filter((file) => file.classification === "production");
    const tests = owned.filter((file) => file.classification === "test");
    const tooling = owned.filter((file) => file.classification === "tooling");
    return Object.freeze({
      name: entry.name,
      path: packagePath,
      productionFiles: production.length,
      productionLines: sumLines(production),
      testFiles: tests.length,
      testLines: sumLines(tests),
      toolingFiles: tooling.length,
      toolingLines: sumLines(tooling),
    });
  });
}

function collectDependencyGraph(root) {
  const names = new Set(packageCatalog.map((entry) => entry.name));
  const adjacency = new Map();
  const edges = [];
  for (const entry of packageCatalog) {
    const manifest = JSON.parse(readFileSync(join(root, packageRelativePath(entry), "package.json"), "utf8"));
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    const internal = Object.keys(dependencies ?? {}).filter((name) => names.has(name)).sort(compareText);
    adjacency.set(entry.name, internal);
    for (const dependency of internal) edges.push(Object.freeze([entry.name, dependency]));
  }
  const cycles = findCycles(adjacency);
  return Object.freeze({
    edgeCount: edges.length,
    edges: Object.freeze(edges),
    cycles: Object.freeze(cycles),
  });
}

function findCycles(adjacency) {
  const cycles = [];
  const active = [];
  const activeIndex = new Map();
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    const existing = activeIndex.get(name);
    if (existing !== undefined) {
      cycles.push(Object.freeze([...active.slice(existing), name]));
      return;
    }
    activeIndex.set(name, active.length);
    active.push(name);
    for (const dependency of adjacency.get(name) ?? []) visit(dependency);
    active.pop();
    activeIndex.delete(name);
    visited.add(name);
  };
  for (const name of [...adjacency.keys()].sort(compareText)) visit(name);
  return cycles;
}

function collectPublicApi(root) {
  const { inventories, errors } = collectPackagePublicApiInventories({
    root,
    catalog: packageCatalog,
  });
  if (errors.length > 0) {
    throw new Error(`Could not generate public API report:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  const packages = inventories.map((inventory) => {
    const symbolCount = inventory.entrypoints.reduce(
      (sum, entrypoint) => sum + entrypoint.exportNames.length,
      0,
    );
    return Object.freeze({
      name: inventory.packageName,
      path: inventory.packagePath,
      entrypoints: Object.freeze(inventory.entrypoints.map((entrypoint) => Object.freeze({
        subpath: entrypoint.subpath,
        exportNames: Object.freeze([...entrypoint.exportNames]),
      }))),
      symbolCount,
    });
  });
  return Object.freeze({
    packages: Object.freeze(packages),
    entrypointCount: packages.reduce((sum, row) => sum + row.entrypoints.length, 0),
    symbolCount: packages.reduce((sum, row) => sum + row.symbolCount, 0),
  });
}

function collectTemplateClosures(renderProject) {
  const rows = ["minimal", "personal", "multi-runtime"].map((template) => {
    const files = renderProject({ projectName: `${template}-source-beta`, template });
    const fileMap = new Map(files.map((file) => [file.path, file.contents]));
    const manifest = JSON.parse(requiredFile(fileMap, "package.json"));
    const config = JSON.parse(requiredFile(fileMap, "mono-agent.config.json"));
    const environment = requiredFile(fileMap, ".env.example");
    return Object.freeze({
      template,
      dependencies: Object.freeze(Object.keys(manifest.dependencies ?? {}).sort(compareText)),
      selectedPackages: Object.freeze([...collectSelectedPackages(config)].sort(compareText)),
      environmentNames: Object.freeze(
        environment.trim().split("\n").filter(Boolean).map((line) => line.slice(0, -1)).sort(compareText),
      ),
      configPaths: Object.freeze([...collectConfigPaths(config)].sort(compareText)),
    });
  });
  const configPaths = Object.freeze([
    ...new Set(rows.flatMap((row) => row.configPaths)),
  ].sort(compareText));
  return Object.freeze({
    rows: Object.freeze(rows),
    configPaths,
    configPathCount: configPaths.length,
  });
}

function collectSelectedPackages(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectSelectedPackages(child, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (typeof value.$use === "string") output.add(value.$use);
  for (const child of Object.values(value)) collectSelectedPackages(child, output);
  return output;
}

function collectConfigPaths(value, prefix = "", output = new Set()) {
  if (Array.isArray(value)) {
    if (prefix.length > 0) output.add(`${prefix}[]`);
    for (const child of value) collectConfigPaths(child, `${prefix}[]`, output);
    return output;
  }
  if (value === null || typeof value !== "object") {
    if (prefix.length > 0) output.add(prefix);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    collectConfigPaths(child, path, output);
  }
  return output;
}

function requiredFile(files, path) {
  const source = files.get(path);
  if (source === undefined) throw new Error(`Rendered template omitted ${path}.`);
  return source;
}

function packageReadmeLink(path) {
  return `https://github.com/robertsreberski/mono-agent-next/blob/main/${posix.join(path, "README.md")}`;
}

function sumLines(files) {
  return files.reduce((sum, file) => sum + file.lines, 0);
}

function code(value) {
  return `\`${value}\``;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

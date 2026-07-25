// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
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
    maximumLines: 16_500,
  }),
  /**
   * The reserved state module's execution protocol crosses Module SDK as
   * `perform(request): Promise<unknown>`, so durable logic pushed across that
   * boundary leaves the kernel packages and stops counting against
   * `kernel-production`. Honoring the letter of the kernel budget by moving
   * kernel work into an untyped escape hatch would defeat its purpose, so the
   * protocol's own surface is measured too.
   */
  Object.freeze({
    id: "durable-protocol-production",
    maximumLines: 9_500,
  }),
]);

/**
 * No single kernel production file may exceed this. A total-lines budget cannot
 * prevent one file becoming the place every kernel change lands; this can.
 *
 * This is a ratchet, not an aspiration: it is set just above the largest kernel
 * file as it actually stands, so the next change to that file has to extract
 * something rather than grow it. Lower it whenever a decomposition lands.
 */
export const KERNEL_FILE_MAXIMUM_LINES = 2_400;

const KERNEL_PACKAGES = Object.freeze([
  "@mono-agent/cli",
  "@mono-agent/core",
  "@mono-agent/module-sdk",
]);

const DURABLE_PROTOCOL_PATHS = Object.freeze([
  "packages/core/src/state-execution-client.ts",
  "packages/state-local/src/execution",
]);

function isDurableProtocolPath(path) {
  return DURABLE_PROTOCOL_PATHS.some((prefix) => path === prefix || path.startsWith(prefix));
}

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
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const MODULE_SCHEMA_ENV_ELIGIBLE = "x-mono-agent-env-eligible";
const MODULE_SCHEMA_SECRET = "x-mono-agent-secret";
const MODULE_SCHEMA_SLOT_REFERENCE = "x-mono-agent-slot-reference";
const MODULE_KINDS = new Set([
  "runtime",
  "channel",
  "memory",
  "state",
  "trigger",
  "exporter",
  "sandbox",
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
        .filter((row) => KERNEL_PACKAGES.includes(row.name))
        .reduce((sum, row) => sum + row.productionLines, 0),
    ],
    [
      "durable-protocol-production",
      files
        .filter((file) => file.classification === "production" && isDurableProtocolPath(file.path))
        .reduce((sum, file) => sum + file.lines, 0),
    ],
  ]);
  const kernelFiles = Object.freeze(files
    .filter((file) => file.classification === "production" && KERNEL_PACKAGES.includes(file.owner))
    .map((file) => Object.freeze({ path: file.path, lines: file.lines }))
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path)));
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
    kernelFiles,
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

  for (const file of Array.isArray(report.kernelFiles) ? report.kernelFiles : []) {
    if (file === null || typeof file !== "object") continue;
    if (!Number.isSafeInteger(file.lines) || file.lines <= KERNEL_FILE_MAXIMUM_LINES) continue;
    issues.push(
      `${String(file.path)} is ${String(file.lines)} lines; no kernel production file may `
      + `exceed ${String(KERNEL_FILE_MAXIMUM_LINES)}.`,
    );
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

export function renderSourceBetaConfigMarkdown(report, renderedProjects, configReference) {
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
node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js config schema --config ./mono-agent.config.json --write
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

## Executable schema inventory

This inventory is regenerated from the executable Core composition and the
executable schema exported by every publishable package whose manifest declares
a \`mono-agent\` module kind. The generator rebuilds those packages before
importing them, so a clean checkout does not rely on stale \`dist/\` output.
Adding, removing, or changing a typed module field makes
\`pnpm run check:source-beta-docs\` fail until this page is regenerated.

Required means required by the containing object. \`conditional\` means a field
is required only in a schema branch, \`item\` identifies an array item, and
\`selected\` identifies a module object after its \`$use\` selection is present.
Environment eligibility and secret handling come from the executable
\`x-mono-agent-*\` annotations, not field-name heuristics.

### Core composed envelope

The Core table is composed through the public \`loadAgentConfig\` and
\`composeAgentConfigSchema\` APIs using a hermetic reference config that selects
all shipped typed modules. Selected module subtrees are collapsed to canonical
slot placeholders and expanded in their owning package tables below. Route
runtime enums show the reference composition's deterministic instance ids
(\`claude\`, \`codex\`, \`opencode\`, and \`pi\`); an installed project's
composed schema instead locks those enums to that project's configured runtime
instance ids.

${renderSchemaFieldTable(configReference.core.rows)}

### Shipped typed module schemas

This build contains ${configReference.modules.length} typed modules. Paths use
\`{id}\` for a user-chosen instance id. The \`$use\` row is the Core-owned
selection discriminator; all remaining rows come from the package's executable
module schema.

${configReference.modules.map((module) => `#### \`${module.packageName}\`

Kind: \`${module.kind}\`. Canonical selected path: \`${module.prefix}\`.

${renderSchemaFieldTable(module.rows)}`).join("\n\n")}

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

export function discoverTypedModulePackages(root, catalog = packageCatalog) {
  const modules = [];
  for (const entry of catalog) {
    if (entry.publishable !== true) continue;
    const packagePath = packageRelativePath(entry);
    const manifest = JSON.parse(readFileSync(join(root, packagePath, "package.json"), "utf8"));
    const metadata = manifest["mono-agent"];
    if (metadata === undefined) continue;
    if (
      metadata === null
      || typeof metadata !== "object"
      || Array.isArray(metadata)
      || metadata.packageName !== manifest.name
      || metadata.apiVersion !== 1
      || !MODULE_KINDS.has(metadata.kind)
    ) {
      throw new Error(`${packagePath}/package.json has invalid mono-agent module metadata.`);
    }
    const importTarget = rootImportTarget(manifest);
    if (
      typeof importTarget !== "string"
      || !importTarget.startsWith("./")
      || importTarget.includes("\0")
      || importTarget.split("/").includes("..")
    ) {
      throw new Error(`${packagePath}/package.json has no safe relative ESM root import.`);
    }
    modules.push(Object.freeze({
      packageName: manifest.name,
      packagePath,
      importTarget,
      kind: metadata.kind,
      responsibility: metadata.responsibility,
    }));
  }
  return Object.freeze(modules.sort((left, right) => compareText(left.packageName, right.packageName)));
}

export function collectExecutableConfigReference({
  coreSchema,
  selectedModules,
  typedModules,
}) {
  if (!isRecord(coreSchema)) throw new Error("Core composed schema must be an object.");
  if (!Array.isArray(selectedModules)) throw new Error("Core selectedModules must be an array.");
  if (!Array.isArray(typedModules)) throw new Error("typedModules must be an array.");

  const stopPaths = new Set();
  const aliases = new Map();
  for (const module of selectedModules) {
    if (
      !isRecord(module)
      || typeof module.configPath !== "string"
      || !MODULE_KINDS.has(module.kind)
    ) {
      throw new Error("Core selected module metadata is invalid.");
    }
    stopPaths.add(module.configPath);
    aliases.set(module.configPath, modulePrefix(module.kind));
  }
  const coreRows = collectSchemaFieldRows(coreSchema, {
    stopPaths,
    aliases,
    rootRequired: "yes",
  });

  const seen = new Set();
  const modules = typedModules.map((module) => {
    if (
      !isRecord(module)
      || typeof module.packageName !== "string"
      || !MODULE_KINDS.has(module.kind)
      || !isRecord(module.jsonSchema)
    ) {
      throw new Error("Executable typed module metadata is invalid.");
    }
    if (seen.has(module.packageName)) {
      throw new Error(`Duplicate executable typed module ${module.packageName}.`);
    }
    seen.add(module.packageName);
    const prefix = modulePrefix(module.kind);
    const schemaRows = collectSchemaFieldRows(module.jsonSchema, {
      prefix,
      rootRequired: "selected",
    });
    const selectionRow = Object.freeze({
      path: `${prefix}.$use`,
      sourcePath: `${prefix}.$use`,
      type: "string",
      required: "yes",
      default: "—",
      constraints: `const ${stableJson(module.packageName)}`,
      environmentEligible: "no",
      secret: "no",
      crossSlot: "—",
    });
    return Object.freeze({
      packageName: module.packageName,
      kind: module.kind,
      prefix,
      rows: Object.freeze([
        ...schemaRows.filter((row) => row.path === prefix),
        selectionRow,
        ...schemaRows.filter((row) => row.path !== prefix),
      ]),
    });
  }).sort((left, right) =>
    compareText(left.kind, right.kind) || compareText(left.packageName, right.packageName));

  return Object.freeze({
    core: Object.freeze({ rows: Object.freeze(coreRows) }),
    modules: Object.freeze(modules),
  });
}

export function collectSchemaFieldRows(
  schema,
  {
    prefix = "",
    rootRequired = "selected",
    stopPaths = new Set(),
    aliases = new Map(),
  } = {},
) {
  if (!isRecord(schema)) throw new Error("Schema field traversal requires an object schema.");
  const observations = new Map();

  const visit = (
    node,
    sourcePath,
    required,
    conditional = false,
    inheritedSecret = false,
    unconditionalRequiredProperties = new Set(),
    enclosingConditional = conditional,
    preserveSelfRequired = false,
  ) => {
    if (!isRecord(node)) return;
    const path = aliases.get(sourcePath) ?? sourcePath;
    addSchemaObservation(observations, {
      path: path.length === 0 ? "$" : path,
      sourcePath: sourcePath.length === 0 ? "$" : sourcePath,
      node,
      required: aliases.has(sourcePath)
        ? "selected"
        : !preserveSelfRequired && conditional && required === "yes" ? "conditional" : required,
      secret: inheritedSecret || node[MODULE_SCHEMA_SECRET] === true,
    });
    if (stopPaths.has(sourcePath)) return;

    const secret = inheritedSecret || node[MODULE_SCHEMA_SECRET] === true;
    const requiredProperties = new Set(
      Array.isArray(node.required)
        ? node.required.filter((value) => typeof value === "string")
        : [],
    );
    if (isRecord(node.properties)) {
      for (const name of Object.keys(node.properties).sort(compareText)) {
        const child = node.properties[name];
        if (!isRecord(child)) continue;
        visit(
          child,
          appendSchemaPath(sourcePath, name),
          requiredProperties.has(name) ? "yes" : "no",
          unconditionalRequiredProperties.has(name) ? enclosingConditional : conditional,
          secret,
        );
      }
    }
    if (isRecord(node.items)) {
      visit(node.items, `${sourcePath}[]`, "item", conditional, secret);
    }
    if (isRecord(node.additionalProperties)) {
      visit(
        node.additionalProperties,
        appendSchemaPath(sourcePath, "{key}"),
        "conditional",
        true,
        secret,
      );
    }
    if (isRecord(node.patternProperties)) {
      for (const pattern of Object.keys(node.patternProperties).sort(compareText)) {
        const child = node.patternProperties[pattern];
        if (isRecord(child)) {
          visit(
            child,
            appendSchemaPath(sourcePath, `{key:${pattern}}`),
            "conditional",
            true,
            secret,
          );
        }
      }
    }
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      if (!Array.isArray(node[keyword])) continue;
      const branches = node[keyword].filter(isRecord);
      const commonRequired = keyword === "allOf"
        ? new Set()
        : intersectRequiredProperties(branches);
      for (const branch of branches) {
        if (isRecord(branch)) {
          visit(
            branch,
            sourcePath,
            required,
            conditional || keyword !== "allOf",
            secret,
            commonRequired,
            conditional,
            true,
          );
        }
      }
    }
    for (const keyword of ["if", "then", "else"]) {
      if (isRecord(node[keyword])) {
        visit(node[keyword], sourcePath, required, true, secret, new Set(), conditional, true);
      }
    }
  };

  visit(schema, prefix, rootRequired);
  return Object.freeze(
    [...observations.values()]
      .map(finalizeSchemaObservation)
      .sort((left, right) => compareText(left.path, right.path)),
  );
}

function intersectRequiredProperties(branches) {
  if (branches.length === 0) return new Set();
  const output = new Set(
    Array.isArray(branches[0].required)
      ? branches[0].required.filter((value) => typeof value === "string")
      : [],
  );
  for (const branch of branches.slice(1)) {
    const required = new Set(
      Array.isArray(branch.required)
        ? branch.required.filter((value) => typeof value === "string")
        : [],
    );
    for (const name of output) if (!required.has(name)) output.delete(name);
  }
  return output;
}

function addSchemaObservation(observations, observation) {
  const current = observations.get(observation.path) ?? {
    path: observation.path,
    sourcePaths: new Set(),
    types: new Set(),
    required: new Set(),
    defaults: new Set(),
    constraints: new Set(),
    environmentEligible: false,
    secret: false,
    crossSlots: new Set(),
  };
  current.sourcePaths.add(observation.sourcePath);
  for (const type of schemaTypes(observation.node)) current.types.add(type);
  current.required.add(observation.required);
  if (Object.hasOwn(observation.node, "default")) {
    current.defaults.add(stableJson(observation.node.default));
  }
  for (const constraint of schemaConstraints(observation.node)) {
    current.constraints.add(constraint);
  }
  current.environmentEligible ||= observation.node[MODULE_SCHEMA_ENV_ELIGIBLE] === true;
  current.secret ||= observation.secret;
  const reference = observation.node[MODULE_SCHEMA_SLOT_REFERENCE];
  if (
    isRecord(reference)
    && MODULE_KINDS.has(reference.slot)
    && (reference.capability === undefined || typeof reference.capability === "string")
  ) {
    current.crossSlots.add(
      reference.capability === undefined
        ? reference.slot
        : `${reference.slot} capability ${reference.capability}`,
    );
  }
  observations.set(observation.path, current);
}

function finalizeSchemaObservation(observation) {
  const types = [...observation.types].filter((type) =>
    type !== "unknown" || observation.types.size === 1);
  const requiredValues = [...observation.required];
  let required;
  if (requiredValues.includes("selected")) required = "selected";
  else if (requiredValues.length === 1) [required] = requiredValues;
  else if (requiredValues.every((value) => value === "item")) required = "item";
  else required = "conditional";
  return Object.freeze({
    path: observation.path,
    sourcePath: [...observation.sourcePaths].sort(compareText)[0],
    type: types.sort(compareText).join(" or "),
    required,
    default: observation.defaults.size === 0
      ? "—"
      : [...observation.defaults].sort(compareText).join(" / "),
    constraints: observation.constraints.size === 0
      ? "—"
      : [...observation.constraints].sort(compareText).join("; "),
    environmentEligible: observation.environmentEligible ? "yes" : "no",
    secret: observation.secret ? "yes" : "no",
    crossSlot: observation.crossSlots.size === 0
      ? "—"
      : [...observation.crossSlots].sort(compareText).join("; "),
  });
}

function schemaTypes(schema) {
  const types = new Set();
  const declared = schema.type;
  if (typeof declared === "string") types.add(declared);
  if (Array.isArray(declared)) {
    for (const type of declared) if (typeof type === "string") types.add(type);
  }
  if (types.size === 0 && (isRecord(schema.properties) || isRecord(schema.patternProperties))) {
    types.add("object");
  }
  if (types.size === 0 && isRecord(schema.items)) types.add("array");
  if (types.size === 0 && Object.hasOwn(schema, "const")) types.add(jsonValueType(schema.const));
  if (types.size === 0 && Array.isArray(schema.enum)) {
    for (const value of schema.enum) types.add(jsonValueType(value));
  }
  if (types.size === 0) {
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      if (!Array.isArray(schema[keyword])) continue;
      for (const branch of schema[keyword]) {
        if (isRecord(branch)) {
          for (const type of schemaTypes(branch)) types.add(type);
        }
      }
    }
  }
  if (types.size === 0) types.add("unknown");
  return types;
}

function jsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value === "object" ? "object" : typeof value;
}

function schemaConstraints(schema) {
  const output = [];
  if (Object.hasOwn(schema, "const")) output.push(`const ${stableJson(schema.const)}`);
  if (Array.isArray(schema.enum)) output.push(`enum ${stableJson(schema.enum)}`);
  for (const keyword of [
    "minimum",
    "exclusiveMinimum",
    "maximum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]) {
    if (typeof schema[keyword] === "number") output.push(`${keyword} ${String(schema[keyword])}`);
  }
  if (typeof schema.pattern === "string") output.push(`pattern ${stableJson(schema.pattern)}`);
  if (typeof schema.format === "string") output.push(`format ${schema.format}`);
  if (schema.uniqueItems === true) output.push("unique items");
  if (schema.additionalProperties === false) output.push("closed object");
  if (isRecord(schema.propertyNames) && typeof schema.propertyNames.pattern === "string") {
    output.push(`key pattern ${stableJson(schema.propertyNames.pattern)}`);
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(schema[keyword])) {
      output.push(`${keyword} ${String(schema[keyword].length)} branches`);
    }
  }
  if (isRecord(schema.if)) output.push("conditional schema");
  if (isRecord(schema.not)) output.push(`not ${stableJson(schema.not)}`);
  return output;
}

function renderSchemaFieldTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Executable schema table must contain at least one row.");
  }
  return `| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${inlineCode(row.path)} | ${inlineCode(row.type)} | ${escapeTableCell(row.required)} | ${row.default === "—" ? "—" : inlineCode(row.default)} | ${row.constraints === "—" ? "—" : inlineCode(row.constraints)} | ${row.environmentEligible} | ${row.secret} | ${row.crossSlot === "—" ? "—" : escapeTableCell(row.crossSlot)} |`).join("\n")}`;
}

function inlineCode(value) {
  return `\`${escapeTableCell(value).replaceAll("`", "&#96;")}\``;
}

function escapeTableCell(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function modulePrefix(kind) {
  switch (kind) {
    case "runtime": return "runtimes.{id}";
    case "channel": return "channels.{id}";
    case "memory": return "memory";
    case "state": return "state";
    case "trigger": return "triggers.{id}";
    case "exporter": return "observability.exporters.{id}";
    case "sandbox": return "policy.sandbox";
    default: throw new Error(`Unknown typed module kind ${String(kind)}.`);
  }
}

function appendSchemaPath(path, segment) {
  return path.length === 0 ? segment : `${path}.${segment}`;
}

function stableJson(value) {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort(compareText).map((key) => [key, stableJsonValue(value[key])]),
  );
}

function rootImportTarget(manifest) {
  const rootExport = isRecord(manifest.exports) && Object.hasOwn(manifest.exports, ".")
    ? manifest.exports["."]
    : manifest.exports;
  return conditionalImportTarget(rootExport) ?? manifest.main;
}

function conditionalImportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = conditionalImportTarget(entry);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, "import")) {
    const target = conditionalImportTarget(value.import);
    if (target !== undefined) return target;
  }
  if (Object.hasOwn(value, "default")) return conditionalImportTarget(value.default);
  return undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function listReportablePaths(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split("\\").join("/"))
    .filter((path) => hasDirectoryEntry(root, path))
    .filter((path) => !GENERATED_REPORT_PATHS.has(path))
    .sort(compareText);
}

function hasDirectoryEntry(root, path) {
  try {
    lstatSync(join(root, path));
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isSourcePath(path) {
  return SOURCE_EXTENSIONS.has(extname(path));
}

function sourceFileRecord(root, path) {
  const absolutePath = join(root, path);
  const listed = lstatSync(absolutePath, { bigint: true });
  if (!listed.isFile() || listed.isSymbolicLink()) {
    throw new Error(`Source file ${path} must be a stable regular file.`);
  }

  let descriptor;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(absolutePath, { bigint: true });
    if (!sameSourceFile(listed, opened) || !sameSourceFile(opened, current)) {
      throw new Error(`Source file ${path} changed before it could be read.`);
    }

    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const final = lstatSync(absolutePath, { bigint: true });
    if (!sameSourceFile(opened, after) || !sameSourceFile(after, final)) {
      throw new Error(`Source file ${path} changed while it was read.`);
    }
    if (bytes.includes(0)) throw new Error(`Source file ${path} contains a NUL byte.`);
    const source = bytes.toString("utf8");
    return Object.freeze({
      path,
      classification: classifySourcePath(path),
      owner: sourceOwner(path),
      lines: physicalLines(source),
      sha256: digest(bytes),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameSourceFile(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
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

  if (path.startsWith("packages/web/webapp/src/")) {
    if (/\.test\.(?:ts|tsx)$/u.test(path)) return "test";
    return "production";
  }
  if (path === "packages/web/webapp/public/notification-sw.js") return "production";
  if (path === "packages/web/webapp/vite.config.ts") return "tooling";

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
    || /^extras\/docs-mcp\/scripts\/(?:generate-corpus|smoke-packed(?:-contract)?)\.mjs$/u.test(path)
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

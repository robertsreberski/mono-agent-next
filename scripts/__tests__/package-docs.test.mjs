import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectPackageDocModel,
  findPackageDocGenerationErrors,
  findPackageReadmeStructureErrors,
  renderPackageDependencyGraph,
  renderPackageDirectory,
  renderPackageMetadata,
  updatePackageDirectoryPage,
  updatePackageReadmeMetadata,
} from "../lib/package-docs.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package documentation generation", () => {
  test("renders catalog metadata and replaces a legacy category line idempotently", () => {
    const entry = catalog()[0];
    const initial = [
      "# @mono-agent/example",
      "",
      "## Category",
      "",
      "Category: `core`",
      "",
      "## Responsibility",
      "",
      "Example prose.",
      "",
    ].join("\n");
    const rendered = renderPackageMetadata(entry);
    const updated = updatePackageReadmeMetadata(initial, rendered);

    expect(updated).toContain("Tier: `core`");
    expect(updated.match(/Category: `core`/gu)).toHaveLength(1);
    expect(updatePackageReadmeMetadata(updated, rendered)).toBe(updated);
  });

  test("ignores a Category heading inside a fenced example", () => {
    const entry = catalog()[0];
    const initial = [
      `# ${entry.name}`,
      "",
      "```md",
      "## Category",
      "```",
      "",
      "## Category",
      "",
      "Legacy category prose.",
      "",
      "## Responsibility",
      "",
    ].join("\n");

    const updated = updatePackageReadmeMetadata(initial, renderPackageMetadata(entry));
    expect(updated.indexOf("<!-- package-metadata:start -->")).toBeGreaterThan(updated.indexOf("```\n\n## Category"));
    expect(updated).toContain("```md\n## Category\n```");
  });

  test("rejects generated metadata already placed outside the real Category section", () => {
    const entry = catalog()[0];
    const rendered = renderPackageMetadata(entry);
    const misplaced = [
      `# ${entry.name}`,
      "",
      "```md",
      rendered,
      "```",
      "",
      "## Category",
      "",
      "Real category.",
      "",
    ].join("\n");

    expect(() => updatePackageReadmeMetadata(misplaced, rendered)).toThrow(
      "Generated package metadata must be inside the real ## Category section.",
    );
  });

  test("derives dependency edges from manifests and keeps runtime relationships out", async () => {
    const root = await fixtureRoot();
    const model = collectPackageDocModel({ root, catalog: catalog() });
    const graph = renderPackageDependencyGraph(model);

    expect(model[1].dependencyNames).toEqual(["@mono-agent/example"]);
    expect(graph).toContain("Current catalog: 2 core-tier packages, 0 plugin-tier extras, and 0 unscoped alias; all 2 publishable entries release in lockstep.");
    expect(graph).toContain("P_mono_agent_consumer --> P_mono_agent_example");
    expect(graph).toContain("Diagram summary:");
    expect(graph).toContain("Text dependency summary:");
    expect(graph).toContain("| `@mono-agent/consumer` | `@mono-agent/example` |");
    expect(graph).toContain("| `@mono-agent/example` | None |");
    const directory = renderPackageDirectory(model, { website: true });
    expect(directory).toContain(
      "https://github.com/robertsreberski/mono-agent-next/blob/main/packages/example/README.md",
    );
    expect(directory).toContain(
      "[README for @mono-agent/example](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/example/README.md)",
    );
    expect(directory).not.toContain("npmjs.com");
    expect(directory).not.toContain("npm for");
    expect(directory).not.toContain("[README](");
    expect(directory).not.toContain("[npm](");
    const page = updatePackageDirectoryPage(
      [
        "---",
        'title: "Packages"',
        'description: "Stale npm directory."',
        "---",
        "",
        "<!-- package-directory:start -->",
        "stale",
        "<!-- package-directory:end -->",
        "",
      ].join("\n"),
      directory,
    );
    expect(page).toContain(
      'description: "Directory of every mono-agent v1 source package, its ownership tier, responsibility, and authoritative README."',
    );
    expect(page).not.toContain("Stale npm directory.");
    expect(updatePackageDirectoryPage(page, directory)).toBe(page);
  });

  test("reports every stale generated surface", async () => {
    const root = await fixtureRoot();
    expect(findPackageDocGenerationErrors({ root, catalog: catalog() })).toEqual([
      "packages/example/README.md package metadata has drifted; run pnpm run generate:package-docs.",
      "packages/consumer/README.md package metadata has drifted; run pnpm run generate:package-docs.",
      "PACKAGES.md dependency graph has drifted; run pnpm run generate:package-docs.",
      "PACKAGES.md package directory has drifted; run pnpm run generate:package-docs.",
      "docs/reference/packages.md package directory has drifted; run pnpm run generate:package-docs.",
    ]);
  });

  test("enforces the layered package README contract", async () => {
    const root = await fixtureRoot();
    const entry = catalog()[0];
    const packagePath = `packages/${entry.dir}`;
    await writeFile(join(root, packagePath, "README.md"), validReadme(entry));

    expect(findPackageReadmeStructureErrors({ root, catalog: [entry] })).toEqual([]);

    await writeFile(join(root, packagePath, "README.md"), validReadme(entry).replace(
      "### Start here\n\nUse the main export.",
      "### Generated inventory\n\nUse the main export.",
    ));
    expect(findPackageReadmeStructureErrors({ root, catalog: [entry] })).toContain(
      "packages/example/README.md `## Public API` must begin with a curated `### Start here` map.",
    );
  });

  test("reports a missing package H1 without crashing", async () => {
    const root = await fixtureRoot();
    const entry = catalog()[0];
    await writeFile(join(root, "packages/example/README.md"), validReadme(entry).replace(`# ${entry.name}\n`, ""));

    expect(findPackageReadmeStructureErrors({ root, catalog: [entry] })).toEqual(expect.arrayContaining([
      "packages/example/README.md must have exactly one H1 named `@mono-agent/example`.",
    ]));
  });
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-package-docs-"));
  roots.push(root);
  for (const entry of catalog()) {
    const packagePath = entry.path ?? `packages/${entry.dir}`;
    await mkdir(join(root, packagePath), { recursive: true });
    await writeFile(join(root, packagePath, "package.json"), JSON.stringify({
      name: entry.name,
      dependencies: entry.name.endsWith("consumer") ? { "@mono-agent/example": "workspace:1.0.0" } : {},
    }));
    await writeFile(join(root, packagePath, "README.md"), "# Fixture\n\n## Category\n\nCategory: `core`\n");
  }
  await writeFile(join(root, "PACKAGES.md"), [
    "# Packages",
    "",
    "<!-- package-dependency-graph:start -->",
    "stale",
    "<!-- package-dependency-graph:end -->",
    "",
    "<!-- package-directory:start -->",
    "stale",
    "<!-- package-directory:end -->",
    "",
  ].join("\n"));
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await writeFile(join(root, "docs/reference/packages.md"), [
    "<!-- package-directory:start -->",
    "stale",
    "<!-- package-directory:end -->",
    "",
  ].join("\n"));
  return root;
}

function catalog() {
  return [
    {
      dir: "example",
      name: "@mono-agent/example",
      category: "core",
      responsibility: "Provides an example contract.",
      allowedDependencyCategories: [],
      publishable: true,
    },
    {
      dir: "consumer",
      name: "@mono-agent/consumer",
      category: "app",
      responsibility: "Consumes the example contract.",
      allowedDependencyCategories: ["core"],
      publishable: true,
    },
  ];
}

function validReadme(entry) {
  return [
    `# ${entry.name}`,
    "",
    "Use this package for a focused example.",
    "",
    "## Category",
    "",
    "Category details.",
    "",
    "## Responsibility",
    "",
    "One responsibility.",
    "",
    "## Install / Usage",
    "",
    `Install \`${entry.name}\`.`,
    "",
    "## Architecture",
    "",
    "### Data flow",
    "",
    "Input becomes output.",
    "",
    "### Package structure",
    "",
    "The source tree is small.",
    "",
    "## Public API",
    "",
    "### Start here",
    "",
    "Use the main export.",
    "",
    "## Dependency Boundary",
    "",
    "No workspace dependencies.",
    "",
    "## What This Package Does Not Own",
    "",
    "It does not own transport.",
    "",
    "## Related Documentation",
    "",
    "[Package map](../../PACKAGES.md)",
    "",
    "## Verification",
    "",
    "Run the focused test.",
    "",
  ].join("\n");
}

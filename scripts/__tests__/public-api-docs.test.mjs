// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectPackagePublicApiInventories,
  findPackagePublicApiDocErrors,
  renderJsSubpathInventory,
  renderPublicApiInventory,
  updateReadmePublicApiInventory,
} from "../lib/public-api-docs.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package Public API documentation", () => {
  it("derives root and subpath exports from the manifest and TypeScript barrels", async () => {
    const fixture = await createPackageFixture({
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./feature": { types: "./dist/feature.d.ts", import: "./dist/feature.js" },
        "./package.json": "./package.json",
      },
      sources: {
        "src/index.ts": [
          "export interface AlphaOptions { enabled: boolean }",
          "export const alpha = 1;",
          'export { shared } from "./shared.js";',
          "",
        ].join("\n"),
        "src/shared.ts": "export const shared = true;\n",
        "src/feature.ts": "export function feature(): string { return 'ok'; }\n",
      },
    });

    const { inventories, errors } = collectPackagePublicApiInventories(fixture);

    expect(errors).toEqual([]);
    expect(inventories[0].entrypoints).toEqual([
      { subpath: ".", exportNames: ["AlphaOptions", "alpha", "shared"] },
      { subpath: "./feature", exportNames: ["feature"] },
    ]);
  });

  it("unions direct JavaScript runtime exports with type-only declaration exports", async () => {
    const fixture = await createPackageFixture({
      exports: {
        ".": { types: "./types/index.d.ts", default: "./src/index.js" },
      },
      sources: {
        "src/index.js": "export function createRuntime() { return {}; }\n",
        "types/index.d.ts": "export interface RuntimeConfig { model: string }\n",
      },
    });

    const { inventories, errors } = collectPackagePublicApiInventories(fixture);

    expect(errors).toEqual([]);
    expect(inventories[0].entrypoints).toEqual([
      { subpath: ".", exportNames: ["RuntimeConfig", "createRuntime"] },
    ]);
  });

  it("detects both missing and invented names in a classified inventory", async () => {
    const fixture = await createPackageFixture({
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      sources: {
        "src/index.ts": "export const actualExport = true;\nexport interface ActualType { value: string }\n",
      },
    });
    const { inventories, errors } = collectPackagePublicApiInventories(fixture);
    expect(errors).toEqual([]);
    const generated = updateReadmePublicApiInventory(
      await readFile(join(fixture.root, "packages/example/README.md"), "utf8"),
      renderPublicApiInventory(inventories[0]),
    );
    const drifted = generated.replace("ActualType\n", "").replace("actualExport\n", "inventedExport\n");
    await writeFile(join(fixture.root, "packages/example/README.md"), drifted);

    expect(findPackagePublicApiDocErrors(fixture)).toEqual([
      "packages/example/README.md Public API inventory has drifted from package.json and source exports; run pnpm run generate:public-api-docs.",
    ]);
  });

  it("replaces only the old API list and preserves prose and examples outside it", async () => {
    const fixture = await createPackageFixture({
      exports: { ".": { import: "./dist/index.js" } },
      sources: { "src/index.ts": "export const currentName = true;\n" },
      readme: [
        "# Example",
        "",
        "## Public API",
        "",
        "- `removedName`",
        "- A wrapped API-list description",
        "  that must leave with the old list.",
        "",
        "This usage note must remain, including `memberName` that is not a package export.",
        "",
        "```ts",
        "const value = client.memberName;",
        "```",
        "",
        "## Dependency Boundary",
        "",
        "None.",
        "",
      ].join("\n"),
    });
    const { inventories } = collectPackagePublicApiInventories(fixture);
    const original = await readFile(join(fixture.root, "packages/example/README.md"), "utf8");

    const updated = updateReadmePublicApiInventory(original, renderPublicApiInventory(inventories[0]));

    expect(updated).not.toContain("removedName");
    expect(updated).not.toContain("wrapped API-list description");
    expect(updated).toContain("This usage note must remain, including `memberName`");
    expect(updated).toContain("const value = client.memberName;");
    expect(updated).toContain("```\n\n## Dependency Boundary");
  });

  it("documents a bin-only package without inventing a library entrypoint", async () => {
    const fixture = await createPackageFixture({ exports: undefined, sources: {} });
    const { inventories, errors } = collectPackagePublicApiInventories(fixture);
    expect(errors).toEqual([]);
    expect(inventories[0].entrypoints).toEqual([]);

    const readmePath = join(fixture.root, "packages/example/README.md");
    const updated = updateReadmePublicApiInventory(
      await readFile(readmePath, "utf8"),
      renderPublicApiInventory(inventories[0]),
    );
    await writeFile(readmePath, updated);

    expect(updated).toContain("Library exports: none (this package has no code export map).");
    expect(findPackagePublicApiDocErrors(fixture)).toEqual([]);
  });

  it("rejects stale FieldGroup identifiers even when they sit outside the generated list", async () => {
    const fixture = await createPackageFixture({
      exports: { ".": { import: "./dist/index.js" } },
      sources: { "src/index.ts": "export const CONFIG_FIELDS = [];\n" },
    });
    const { inventories } = collectPackagePublicApiInventories(fixture);
    const readmePath = join(fixture.root, "packages/example/README.md");
    const generated = updateReadmePublicApiInventory(
      await readFile(readmePath, "utf8"),
      renderPublicApiInventory(inventories[0]),
    ).replace("## Dependency Boundary", "Legacy example: `exampleFieldGroup`.\n\n## Dependency Boundary");
    await writeFile(readmePath, generated);

    expect(findPackagePublicApiDocErrors(fixture)).toEqual([
      "packages/example/README.md references stale FieldGroup identifier(s): exampleFieldGroup.",
    ]);
  });

  it("derives MIGRATION deep .js counts and paths from the export map", async () => {
    const fixture = await createPackageFixture({
      exports: {
        ".": { import: "./dist/index.js" },
        "./alpha.js": { import: "./dist/alpha.js" },
        "./nested/beta.js": { import: "./dist/nested/beta.js" },
      },
      sources: {
        "src/index.ts": "export const root = true;\n",
        "src/alpha.ts": "export const alpha = true;\n",
        "src/nested/beta.ts": "export const beta = true;\n",
      },
    });
    const { inventories } = collectPackagePublicApiInventories(fixture);
    const rendered = renderJsSubpathInventory(inventories[0]);

    expect(rendered).toContain("**2 named deep `.js` subpaths**");
    expect(rendered).toContain("@mono-agent/example/alpha.js");
    expect(rendered).toContain("@mono-agent/example/nested/beta.js");

    const readmePath = join(fixture.root, "packages/example/README.md");
    await writeFile(
      readmePath,
      updateReadmePublicApiInventory(await readFile(readmePath, "utf8"), renderPublicApiInventory(inventories[0])),
    );
    await writeFile(
      join(fixture.root, "packages/example/MIGRATION.md"),
      `# Migration\n\n${rendered}\n`,
    );
    expect(findPackagePublicApiDocErrors(fixture)).toEqual([]);

    await writeFixtureFile(fixture.root, "packages/example/src/gamma.ts", "export const gamma = true;\n");
    await writeFixtureFile(
      fixture.root,
      "packages/example/package.json",
      `${JSON.stringify({
        name: "@mono-agent/example",
        type: "module",
        exports: {
          ".": { import: "./dist/index.js" },
          "./alpha.js": { import: "./dist/alpha.js" },
          "./gamma.js": { import: "./dist/gamma.js" },
          "./nested/beta.js": { import: "./dist/nested/beta.js" },
        },
      }, null, 2)}\n`,
    );
    expect(findPackagePublicApiDocErrors(fixture)).toEqual([
      "packages/example/README.md Public API inventory has drifted from package.json and source exports; run pnpm run generate:public-api-docs.",
      "packages/example/MIGRATION.md deep .js subpath inventory has drifted from package.json; run pnpm run generate:public-api-docs.",
    ]);

    await writeFile(join(fixture.root, "packages/example/MIGRATION.md"), "# Migration\n\nInventory was deleted.\n");
    expect(findPackagePublicApiDocErrors(fixture)).toContain(
      "packages/example/MIGRATION.md is missing its generated deep .js subpath inventory.",
    );
  });
});

async function createPackageFixture({ exports, sources, readme }) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-public-api-docs-"));
  temporaryRoots.push(root);
  const packagePath = "packages/example";
  const manifest = {
    name: "@mono-agent/example",
    type: "module",
    ...(exports === undefined ? {} : { exports }),
  };
  await writeFixtureFile(root, `${packagePath}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFixtureFile(
    root,
    `${packagePath}/README.md`,
    readme ?? "# Example\n\n## Public API\n\nNone yet.\n\n## Dependency Boundary\n\nNone.\n",
  );
  for (const [path, contents] of Object.entries(sources)) {
    await writeFixtureFile(root, `${packagePath}/${path}`, contents);
  }
  return {
    root,
    catalog: [{ dir: "example", name: "@mono-agent/example" }],
  };
}

async function writeFixtureFile(root, path, contents) {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

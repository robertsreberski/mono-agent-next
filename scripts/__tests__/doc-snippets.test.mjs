// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { collectTypeScriptDocSnippets, TYPESCRIPT_SNIPPET_MARKER } from "../lib/doc-snippets.mjs";

const roots = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_FLAGSHIP_SNIPPET_FILES = [
  "docs/programmatic/index.md",
  "packages/core/README.md",
  "packages/module-sdk/README.md",
  "packages/operator/README.md",
  "packages/web/README.md",
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("documentation snippets", () => {
  test("extracts only explicitly marked TypeScript examples", async () => {
    const root = await fixtureRoot([
      "# Examples",
      "",
      "```ts",
      "const illustrative = missingName;",
      "```",
      "",
      TYPESCRIPT_SNIPPET_MARKER,
      "",
      "```typescript",
      "const checked: string = \"ready\";",
      "```",
      "",
    ]);

    expect(collectTypeScriptDocSnippets({ root })).toEqual({
      errors: [],
      snippets: [{
        file: "README.md",
        line: 10,
        source: "const checked: string = \"ready\";",
      }],
    });
  });

  test("reports a marker that does not introduce a TypeScript fence", async () => {
    const root = await fixtureRoot(["# Examples", "", TYPESCRIPT_SNIPPET_MARKER, "", "```json", "{}", "```", ""]);

    expect(collectTypeScriptDocSnippets({ root })).toEqual({
      snippets: [],
      errors: ["README.md:3 <!-- doc-test:typescript --> must be followed by a TypeScript fence."],
    });
  });

  test("keeps every flagship TypeScript example enrolled in the repository gate", () => {
    const collected = collectTypeScriptDocSnippets({ root: repositoryRoot });
    const enrolledFiles = [...new Set(collected.snippets.map((snippet) => snippet.file))].sort();

    expect(collected.errors).toEqual([]);
    expect(enrolledFiles).toEqual(expect.arrayContaining(REQUIRED_FLAGSHIP_SNIPPET_FILES));
  });

  test("runs the repository snippet gate after every public package is built", () => {
    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const build = workflow.indexOf("          pnpm run build");
    const snippets = workflow.indexOf("          pnpm run check:doc-snippets");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(snippets).toBeGreaterThan(build);
  });
});

async function fixtureRoot(lines) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-doc-snippets-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "README.md"), lines.join("\n"));
  return root;
}

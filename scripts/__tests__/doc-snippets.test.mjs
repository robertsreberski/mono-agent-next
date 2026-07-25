// SPDX-License-Identifier: MIT
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { collectTypeScriptDocSnippets, TYPESCRIPT_SNIPPET_MARKER } from "../lib/doc-snippets.mjs";

const roots = [];

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
});

async function fixtureRoot(lines) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-doc-snippets-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "README.md"), lines.join("\n"));
  return root;
}

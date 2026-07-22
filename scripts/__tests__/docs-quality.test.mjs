import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  checkMarkdownDocument,
  collectPublicMarkdownFiles,
  findDocumentationErrors,
} from "../lib/docs-quality.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("documentation quality", () => {
  test("accepts a frontmatter-titled canonical doc with accessible Markdown", () => {
    expect(checkMarkdownDocument({
      file: "docs/guide.md",
      text: [
        "---",
        "title: Guide",
        "description: A focused guide.",
        "---",
        "",
        "## Configure it",
        "",
        "[Read the package map](/reference/packages/).",
        "",
        "**Diagram summary:** Requests flow from the app to the runtime.",
        "",
        "```mermaid",
        "flowchart LR",
        "  App --> Runtime",
        "```",
        "",
      ].join("\n"),
    })).toEqual([]);
  });

  test("reports inaccessible structure, unlabeled fences, and weak link text", () => {
    const errors = checkMarkdownDocument({
      file: "README.md",
      text: [
        "# One",
        "",
        "### Skipped",
        "",
        "[here](./PACKAGES.md)",
        "",
        "![](image.png)",
        "",
        "```",
        "plain output",
        "```",
        "",
        "# Two",
      ].join("\n"),
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("expected exactly one H1"),
      expect.stringContaining("heading level skips"),
      expect.stringContaining("link text `here` is not descriptive"),
      expect.stringContaining("images must have meaningful alternative text"),
      expect.stringContaining("fenced code blocks must declare a language"),
    ]));
  });

  test("reports an unclosed typed fence instead of silently swallowing the rest of a page", () => {
    expect(checkMarkdownDocument({
      file: "README.md",
      text: "# Project\n\n```ts\nconst open = true;\n\n## Hidden by the fence\n",
    })).toContain("README.md:3 fenced code block is not closed.");
  });

  test("ignores links in inline code and comments while resolving reference links", () => {
    expect(checkMarkdownDocument({
      file: "README.md",
      text: [
        "# Project",
        "",
        "`[here](./missing.md)`",
        "<!-- [here](./also-missing.md) -->",
        "[Readable documentation][docs]",
        "",
        "[docs]: ./docs/index.md",
        "",
      ].join("\n"),
    })).toEqual([]);
  });

  test("reports unclosed HTML comments and undefined reference links", () => {
    expect(checkMarkdownDocument({
      file: "README.md",
      text: "# Project\n\n[Documentation][missing]\n\n<!-- never closed\n",
    })).toEqual(expect.arrayContaining([
      "README.md:3 reference link `missing` has no definition.",
      "README.md:5 HTML comment is not closed.",
    ]));
  });

  test("rejects links to the obsolete documentation hostname", () => {
    expect(checkMarkdownDocument({
      file: "README.md",
      text: "# Project\n\n[Runtime guide](https://mono-agent.dev/runtime/)\n",
    })).toContain(
      "README.md:3 documentation links must use `mono-agent-docs.vercel.app`, not obsolete host `mono-agent.dev`.",
    );
  });

  test("checks local targets and heading fragments across the public corpus", async () => {
    const root = await fixtureRoot();
    const errors = findDocumentationErrors({ root });

    expect(collectPublicMarkdownFiles(root)).toEqual(["docs/guide/index.md", "docs/index.md", "README.md"]);
    expect(errors).toEqual([
      "README.md:3 heading fragment `#missing` does not exist in docs/index.md.",
      "README.md:4 heading fragment `#also-missing` does not exist in docs/guide/index.md.",
    ]);
  });

  test("maps first-party GitHub source links and published documentation routes back to local targets", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "packages/demo/src"), { recursive: true });
    await writeFile(join(root, "packages/demo/src/index.ts"), "export const demo = true;\n");
    await writeFile(join(root, "README.md"), [
      "# Project",
      "",
      "[Source module](https://github.com/robertsreberski/mono-agent/blob/main/packages/demo/src/index.ts)",
      "[Missing source module](https://github.com/robertsreberski/mono-agent/blob/main/packages/demo/src/missing.ts)",
      "[Published guide](https://mono-agent-docs.vercel.app/guide/#present)",
      "[Missing published guide](https://mono-agent-docs.vercel.app/absent/)",
      "[Missing published heading](https://mono-agent-docs.vercel.app/guide/#missing)",
      "",
    ].join("\n"));

    expect(findDocumentationErrors({ root })).toEqual([
      "README.md:4 local link target does not exist: https://github.com/robertsreberski/mono-agent/blob/main/packages/demo/src/missing.ts",
      "README.md:6 local link target does not exist: https://mono-agent-docs.vercel.app/absent/",
      "README.md:7 heading fragment `#missing` does not exist in docs/guide/index.md.",
    ]);
  });
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-docs-quality-"));
  roots.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "README.md"), [
    "# Project",
    "",
    "[Documentation](./docs/index.md#missing)",
    "[Guide](/guide/#also-missing)",
    "",
  ].join("\n"));
  await writeFile(join(root, "docs/index.md"), [
    "---",
    "title: Home",
    "description: Fixture documentation.",
    "---",
    "",
    "## Available features",
    "",
  ].join("\n"));
  await mkdir(join(root, "docs/guide"), { recursive: true });
  await writeFile(join(root, "docs/guide/index.md"), [
    "---",
    "title: Guide",
    "description: Fixture guide.",
    "---",
    "",
    "## Present",
    "",
  ].join("\n"));
  return root;
}

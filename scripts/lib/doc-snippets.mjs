// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { collectPublicMarkdownFiles } from "./docs-quality.mjs";

export const TYPESCRIPT_SNIPPET_MARKER = "<!-- doc-test:typescript -->";

export function collectTypeScriptDocSnippets({ root, files = collectPublicMarkdownFiles(root) }) {
  const snippets = [];
  const errors = [];

  for (const file of files) {
    const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== TYPESCRIPT_SNIPPET_MARKER) continue;
      let fenceIndex = index + 1;
      while (fenceIndex < lines.length && lines[fenceIndex].trim().length === 0) fenceIndex += 1;
      if (!/^```(?:ts|typescript)\s*$/u.test(lines[fenceIndex] ?? "")) {
        errors.push(`${file}:${index + 1} ${TYPESCRIPT_SNIPPET_MARKER} must be followed by a TypeScript fence.`);
        continue;
      }
      const closingOffset = lines.slice(fenceIndex + 1).findIndex((line) => /^```\s*$/u.test(line));
      if (closingOffset === -1) {
        errors.push(`${file}:${fenceIndex + 1} marked TypeScript fence is not closed.`);
        continue;
      }
      const closingIndex = fenceIndex + 1 + closingOffset;
      snippets.push({
        file,
        line: fenceIndex + 2,
        source: lines.slice(fenceIndex + 1, closingIndex).join("\n"),
      });
      index = closingIndex;
    }
  }

  return { snippets, errors };
}

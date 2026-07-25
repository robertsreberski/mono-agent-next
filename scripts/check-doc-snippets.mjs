#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { collectTypeScriptDocSnippets } from "./lib/doc-snippets.mjs";

const root = process.cwd();
const collected = collectTypeScriptDocSnippets({ root });
let errors = collected.errors;
if (errors.length === 0 && collected.snippets.length === 0) {
  errors = ["No TypeScript documentation snippets are marked for checking."];
}

if (errors.length === 0) {
  const temporaryRoot = mkdtempSync(join(root, ".doc-snippets-"));
  try {
    const sourceByTemporaryFile = new Map();
    for (const [index, snippet] of collected.snippets.entries()) {
      const temporaryFile = join(temporaryRoot, `snippet-${index + 1}.ts`);
      writeFileSync(temporaryFile, `${snippet.source}\n\nexport {};\n`);
      sourceByTemporaryFile.set(temporaryFile, snippet);
    }

    const program = ts.createProgram({
      rootNames: [...sourceByTemporaryFile.keys()],
      options: {
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        module: ts.ModuleKind.NodeNext,
        moduleDetection: ts.ModuleDetectionKind.Force,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        types: ["node"],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
      return diagnostic.file === undefined || sourceByTemporaryFile.has(diagnostic.file.fileName);
    });
    errors = diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, sourceByTemporaryFile));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (errors.length > 0) {
  console.error("Documentation snippet check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Typechecked ${collected.snippets.length} marked TypeScript documentation snippets.`);
}

function formatDiagnostic(diagnostic, sourceByTemporaryFile) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
  const snippet = sourceByTemporaryFile.get(diagnostic.file.fileName);
  if (snippet === undefined) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${snippet.file}:${snippet.line + position.line}:${position.character + 1} ${message}`;
}

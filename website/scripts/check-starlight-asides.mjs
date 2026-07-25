#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS_ROOT = join(REPO_ROOT, 'docs');
const EMPTY_ASIDE = /^[ \t]*:::[A-Za-z][^\r\n]*\r?\n[ \t]*:::[ \t]*(?=\r?$)/gmu;

export function findEmptyStarlightAsides(source) {
  return [...source.matchAll(EMPTY_ASIDE)].map((match) => ({
    line: source.slice(0, match.index).split(/\r?\n/u).length,
    opening: match[0].split(/\r?\n/u, 1)[0].trim(),
  }));
}

export function runStarlightAsideCheck(options = {}) {
  const docsRoot = options.docsRoot ?? DOCS_ROOT;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const files = markdownFiles(docsRoot);
  const matches = files.flatMap((file) =>
    findEmptyStarlightAsides(readFileSync(file, 'utf8')).map((match) => ({
      ...match,
      file: relative(docsRoot, file).split(sep).join('/'),
    }))
  );

  if (matches.length > 0) {
    stderr.write(`check-starlight-asides: FAILED — ${matches.length} empty aside(s):\n`);
    for (const match of matches) {
      stderr.write(`  docs/${match.file}:${match.line} (${match.opening})\n`);
    }
    return { exitCode: 1, filesChecked: files.length, matches };
  }

  stdout.write(
    `check-starlight-asides: OK — ${files.length} Markdown file(s), 0 empty asides.\n`,
  );
  return { exitCode: 0, filesChecked: files.length, matches };
}

function markdownFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const result = runStarlightAsideCheck();
  process.exitCode = result.exitCode;
}

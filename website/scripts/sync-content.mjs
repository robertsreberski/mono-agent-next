// SPDX-License-Identifier: MIT
// Build/dev step: mirror the canonical docs (../docs) into Starlight's content
// directory (src/content/docs). Starlight only applies its markdown features —
// callout asides, heading links, code blocks — to files physically under
// src/content/docs (see @astrojs/starlight integrations/remark-rehype.ts), so we
// copy rather than point a loader at ../docs. docs/ stays the single source of
// truth (kept in git, browsable on github, referenced by the composer skill);
// src/content/docs is generated and gitignored. The mirror preserves the docs/
// tree exactly, so Starlight's editLink (baseUrl .../edit/main/docs/) resolves.
import { cpSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../docs/', import.meta.url));
const DEST = fileURLToPath(new URL('../src/content/docs/', import.meta.url));
// Internal-only folders, excluded from the published site (as on the old site).
// `skills` is intentional: docs/skills/README.md is a "skills moved" tombstone,
// not publishable content. `superpowers` holds gitignored working docs.
const EXCLUDE_TOP = new Set(['superpowers', 'skills']);

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

let count = 0;
cpSync(SRC, DEST, {
  recursive: true,
  filter(src) {
    const rel = relative(SRC, src);
    if (rel === '') return true;
    if (EXCLUDE_TOP.has(rel.split(sep)[0])) return false;
    if (statSync(src).isDirectory()) return true;
    const keep = src.endsWith('.md') || src.endsWith('.mdx');
    if (keep) count++;
    return keep;
  },
});

// Fail closed: an empty (or content-less) docs/ tree would otherwise mirror
// nothing, astro would build a near-empty site, and the whole pipeline would
// ship green — silently rotting the exact way this gate exists to prevent.
if (count === 0) {
  console.error(
    `sync-content: FAILED — mirrored 0 markdown file(s) from docs/ (${SRC}). ` +
      `Refusing to build a near-empty docs site (it would ship green and rot silently). ` +
      `Confirm ../docs exists and contains .md/.mdx files outside ${[...EXCLUDE_TOP].join(', ')}.`,
  );
  process.exit(1);
}

console.log(`sync-content: mirrored ${count} markdown file(s) docs/ -> src/content/docs/`);

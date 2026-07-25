// SPDX-License-Identifier: MIT
// Post-build: validate every internal link in the generated dist/ resolves to a
// real file. Processor-independent safety net for the docs migration — runs after
// `astro build` and exits non-zero on any broken link (so the Vercel build fails).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

if (!existsSync(DIST)) {
  console.error('check-links: dist/ not found — run `astro build` first.');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Map an internal href to the dist file it should resolve to.
function resolveTarget(href) {
  const path = href.split('#')[0].split('?')[0];
  if (!path.startsWith('/') || path.startsWith('//')) return null; // only site-absolute
  const rel = path.replace(/^\//, '');
  if (rel === '') return join(DIST, 'index.html');
  if (/\.[a-z0-9]+$/i.test(rel)) return join(DIST, rel); // asset with extension
  return join(DIST, rel.replace(/\/$/, ''), 'index.html'); // route → directory index
}

const ATTR = /(?:href|src)="([^"]+)"/g;
const broken = new Map(); // href -> sample source page
let checked = 0;

for (const file of walk(DIST)) {
  const html = readFileSync(file, 'utf8');
  let m;
  while ((m = ATTR.exec(html))) {
    const href = m[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(href)) continue;
    const target = resolveTarget(href);
    if (!target) continue;
    checked++;
    if (!existsSync(target) && !broken.has(href)) {
      broken.set(href, relative(DIST, file));
    }
  }
}

if (broken.size > 0) {
  console.error(`\ncheck-links: ${broken.size} broken internal link(s):`);
  for (const [href, src] of broken) console.error(`  ${href}  (e.g. in ${src})`);
  process.exit(1);
}

console.log(`check-links: OK — ${checked} internal link refs resolve across the built site.`);

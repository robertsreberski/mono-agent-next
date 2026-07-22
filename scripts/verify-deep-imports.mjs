#!/usr/bin/env node
// Verifies that every subpath declared in @mono-agent/agent-runtime's `exports`
// map actually resolves and loads. Phase 6 replaced the package's `./ai/*` /
// `./agent/*` wildcard exports with an EXPLICIT map (root, ./ai, ./agent, plus a
// fixed set of deep `.js` subpaths). A wildcard silently resolved anything under
// src/; the explicit map does not, so a mistyped key or a moved/renamed module
// would break a documented deep import with no other signal. This script is that
// signal: it reads the exports keys straight from package.json (single source of
// truth) and `import()`s each mapped specifier via Node's real package
// resolution, failing loudly on the first specifier that does not load.
//
// Runs standalone (`node scripts/verify-deep-imports.mjs`, part of the phase
// gate) and under vitest (scripts/__tests__/verify-deep-imports.test.mjs), which
// injects a fake `importFn` to exercise the failure path deterministically.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PACKAGE_NAME = "@mono-agent/agent-runtime";

function packageJsonUrl(repoRoot) {
  return pathToFileURL(join(repoRoot, "packages", "agent-runtime", "package.json")).href;
}

/**
 * Default import step: resolve each bare specifier through Node's exports
 * resolution (createRequire anchored at agent-runtime's OWN package.json, so the
 * package self-references its own name — this works whether or not the workspace
 * root has an `@mono-agent/agent-runtime` symlink, e.g. inside a git worktree),
 * then actually load the resolved module. Resolution exercises the exports map;
 * the import proves the target loads.
 */
function realImporter(repoRoot) {
  const require = createRequire(packageJsonUrl(repoRoot));
  return async (specifier) => {
    const resolved = require.resolve(specifier);
    return import(pathToFileURL(resolved).href);
  };
}

/**
 * Map an `exports` key to the bare specifier a consumer imports.
 *   "."      -> "@mono-agent/agent-runtime"
 *   "./ai"   -> "@mono-agent/agent-runtime/ai"
 *   "./x.js" -> "@mono-agent/agent-runtime/x.js"
 */
function specifierForExportKey(key) {
  if (key === ".") return PACKAGE_NAME;
  return `${PACKAGE_NAME}${key.slice(1)}`;
}

function packageDir(repoRoot) {
  return join(repoRoot, "packages", "agent-runtime");
}

/**
 * Read the mapped subpath entries from agent-runtime's package.json exports —
 * each carries the bare specifier a consumer imports (the `default`/`.js`
 * condition Node resolves) AND the absolute path of the `types` condition
 * target (the generated `.d.ts` a TS consumer resolves). Wildcard keys (should
 * be none after Phase 6) are skipped defensively; a conditionless string entry
 * (no `types`) yields `typesTarget: null` so it is reported but never fails the
 * types check.
 * @param {string} repoRoot
 * @returns {Array<{key: string, specifier: string, typesTarget: string|null}>}
 */
export function mappedEntries(repoRoot) {
  const manifestPath = join(packageDir(repoRoot), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exportsMap = manifest.exports || {};
  return Object.keys(exportsMap)
    .filter((key) => !key.includes("*"))
    .map((key) => {
      const condition = exportsMap[key];
      const typesRel = condition && typeof condition === "object" ? condition.types : null;
      const typesTarget = typeof typesRel === "string"
        ? (isAbsolute(typesRel) ? typesRel : resolve(packageDir(repoRoot), typesRel))
        : null;
      return { key, specifier: specifierForExportKey(key), typesTarget };
    });
}

function sink() {
  const lines = [];
  return { write: (text) => lines.push(text), get text() { return lines.join(""); } };
}

/**
 * @param {Object} [options]
 * @param {string} [options.repoRoot] Repo root holding packages/agent-runtime.
 * @param {(specifier: string) => Promise<unknown>} [options.importFn] Injectable for tests.
 * @param {(path: string) => boolean} [options.fileExists] Injectable for tests (types-target existence).
 * @param {{write: (text: string) => void}} [options.stdout]
 * @param {{write: (text: string) => void}} [options.stderr]
 * @returns {Promise<{exitCode: number, results: Array<{specifier: string, ok: boolean, error?: string}>}>}
 */
export async function runVerifyDeepImports({
  repoRoot = defaultRepoRoot(),
  importFn = realImporter(repoRoot),
  fileExists = existsSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let entries;
  try {
    entries = mappedEntries(repoRoot);
  } catch (err) {
    stderr.write(`FAIL could not read agent-runtime exports map: ${err?.message || String(err)}\n`);
    return { exitCode: 1, results: [] };
  }

  const results = [];
  for (const { specifier, typesTarget } of entries) {
    // (1) `default` condition: resolve + actually load the module.
    let ok = true;
    let error;
    try {
      await importFn(specifier);
      stdout.write(`PASS ${specifier}\n`);
    } catch (err) {
      ok = false;
      error = err?.message || String(err);
      stdout.write(`FAIL ${specifier}: ${error}\n`);
    }
    // (2) `types` condition: the generated .d.ts a TS consumer resolves must
    // exist on disk. A wildcard-free exports map with a `types` condition that
    // points at a missing/renamed .d.ts would silently break TS consumers with
    // no other signal — this is that signal. (A conditionless string entry has
    // no `types` target and is skipped.)
    let typesOk = true;
    let typesError;
    if (typesTarget !== null) {
      if (fileExists(typesTarget)) {
        stdout.write(`PASS ${specifier} (types)\n`);
      } else {
        typesOk = false;
        typesError = `types condition target missing on disk: ${typesTarget}`;
        stdout.write(`FAIL ${specifier} (types): ${typesError}\n`);
      }
    }
    results.push({
      specifier,
      ok: ok && typesOk,
      ...(ok ? {} : { error }),
      ...(typesOk ? {} : { typesError }),
    });
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    stdout.write(`deep-imports fail (${failures.length}/${results.length} unresolved)\n`);
    return { exitCode: 1, results };
  }
  stdout.write(`deep-imports ok (${results.length} mapped subpaths resolve, default + types)\n`);
  return { exitCode: 0, results };
}

function defaultRepoRoot() {
  // scripts/verify-deep-imports.mjs -> repo root is the parent of scripts/.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  runVerifyDeepImports()
    .then(({ exitCode }) => { process.exitCode = exitCode; })
    .catch((err) => {
      const out = sink();
      out.write(String(err?.stack || err));
      process.stderr.write(out.text + "\n");
      process.exitCode = 1;
    });
}

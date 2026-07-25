// SPDX-License-Identifier: MIT

// A gate that is not itself executed by a gate is not a gate.
//
// Both of the lists below are hand-maintained, and both had silently drifted:
// thirteen of thirty files in `scripts/__tests__/` had never executed, and eight
// checks ran only in the local `verify:all` and never in CI -- so the local gate
// was stronger than the blocking one. Neither drift is visible from reading
// either file. These assertions make adding a test or a check without wiring it
// up a failure rather than a silent no-op.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

/** Every `scripts/__tests__/*.test.mjs` on disk. */
function discoveredScriptTests() {
  return readdirSync(resolve(root, "scripts/__tests__"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `scripts/__tests__/${name}`)
    .sort();
}

/** Every `scripts/...` path named by the `scripts:test` allowlist. */
function allowlistedScriptTests() {
  return manifest.scripts["scripts:test"]
    .split(/\s+/u)
    .filter((token) => token.startsWith("scripts/"))
    .sort();
}

/** Every `pnpm run <name>` invoked by any step in the CI workflow. */
function checksRunByCi() {
  return new Set(
    [...workflow.matchAll(/pnpm run ([a-z0-9:-]+)/gu)].map((match) => match[1]),
  );
}

describe("gate coverage", () => {
  it("runs every script test that exists", () => {
    // `pnpm test` only recurses into workspace packages, and `scripts/` is not
    // one, so a file absent from this allowlist never executes anywhere.
    expect(allowlistedScriptTests()).toEqual(discoveredScriptTests());
  });

  it("runs in CI every contribution-quality check the local gate runs", () => {
    const ci = checksRunByCi();
    const missing = [
      "check:node",
      "check:oss-hygiene",
      "check:licenses",
      "check:codex-discoverability",
      "check:consumer-docs-consistency",
      "check:getting-started-version-pins",
      "check:source-line-length",
      "check:source-beta-budgets",
      "check:source-beta-docs",
      "check:docs",
      "check:doc-snippets",
      "check:architecture",
    ].filter((check) => !ci.has(check));

    expect(missing).toEqual([]);
  });

  it("names every allowlisted script test as a real file", () => {
    const discovered = new Set(discoveredScriptTests());
    const dangling = allowlistedScriptTests()
      .filter((path) => path.startsWith("scripts/__tests__/"))
      .filter((path) => !discovered.has(path));

    expect(dangling).toEqual([]);
  });

  it("keeps every top-level script an entrypoint and every library in lib/", () => {
    // `scripts/` is flat and holds two kinds of file that read identically: an
    // entrypoint some `package.json` script runs, and a module other scripts
    // import. Two libraries sat among twenty-six entrypoints, one of them
    // imported nineteen times, and nothing said which was which. This is the
    // rule that says it: if nothing runs it, it belongs in `lib/`.
    const invoked = Object.values(manifest.scripts).join(" ");
    const orphans = readdirSync(resolve(root, "scripts"))
      .filter((name) => name.endsWith(".mjs"))
      .filter((name) => !invoked.includes(`scripts/${name}`))
      .sort();

    expect(orphans).toEqual([]);
  });
});

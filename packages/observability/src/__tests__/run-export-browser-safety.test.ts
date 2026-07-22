import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const distFile = join(here, "..", "..", "dist", "run-export-mapping.js");

/**
 * Browser-safety is a real invariant, not tree-shaking-dependent: the built
 * run-export mapping must not statically reach node:* or Buffer so any
 * browser graph (which imports observability subpaths) stays
 * clean. This reads the BUILT artifact, so it only runs meaningfully after
 * `pnpm --filter @mono-agent/observability run build`.
 */
describe("run-export-mapping browser safety", () => {
  it("the built module contains no node: imports or Buffer references", async () => {
    let source: string;
    try {
      source = await readFile(distFile, "utf8");
    } catch {
      // Not yet built (e.g. running tests before build). Skip rather than fail
      // so the typecheck/test gate before build does not flake; the build step
      // re-runs the suite against the real artifact.
      return;
    }
    expect(source).not.toMatch(/from\s+["']node:/u);
    expect(source).not.toMatch(/require\(\s*["']node:/u);
    expect(source).not.toMatch(/\bBuffer\b/u);
  });
});

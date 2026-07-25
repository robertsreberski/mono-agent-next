// SPDX-License-Identifier: MIT
import { configDefaults, defineConfig } from "vitest/config";

// Root Vitest config. The repo runs several root-level Vitest invocations
// (`release:test`, `test:demo`) that pass bare relative paths, which Vitest
// treats as substring filters against *every* discovered test file. Various
// tools keep full repo copies under gitignored worktree directories
// (`.claude/worktrees/`, `.quests-wt/`, `.ultrawork/`, `.worklab-tmp/`), so without scoping
// discovery those copies are matched too — `release:test` would run the
// canonical `scripts/release/__tests__/release.test.mjs` plus a divergent copy
// per worktree, and `test:demo` would fail collecting demo copies whose packages
// are not built. Extend (do not replace) Vitest's default excludes so
// node_modules/dist/coverage stay excluded and worktree copies are never
// discovered by any root invocation.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.git/**",
      "**/.quests-wt/**",
      "**/.ultrawork/**",
      "**/.worklab-tmp/**",
    ],
  },
});

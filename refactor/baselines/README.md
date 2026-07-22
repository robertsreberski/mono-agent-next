# V1 complexity baseline

`v1-complexity-baseline.json` is the immutable normalized G0 snapshot used to
measure the v1 reduction. Generate reports with:

```console
pnpm run report:v1-complexity
```

Reproduce the frozen G0 count and digest from a clean checkout with:

```console
node scripts/v1-complexity-report.mjs --verify-baseline refactor/baselines/v1-complexity-baseline.json --gate G0
```

The classifier reads stage-0 Git blobs, normalizes line endings, and counts
physical lines. Every tracked executable source file appears in the manifest as
production, test, generated, vendored, or excluded with a policy reason. The
binding production budget covers source under `packages/` and `extras/`; test,
repository-tooling, demo, and documentation-site source remains visible but
does not reduce or consume that budget.

`manifestSha256` covers the canonical classified file rows, including normalized
content digests. `snapshotSha256` covers that manifest plus policy, totals,
budgets, ownership, and architecture inventory. The policy, package catalog,
package manifests, and config schema are all read from stage-0 blobs. Transient
worktree-cleanliness issues are reported and fail verification separately, so an
unstaged edit cannot rewrite either stage-0 measurement digest.

The PRD's provisional 182,118-line figure used the same shipped-source scope,
but counted two web test helpers and the TUI's package-local Vitest
configuration as production:

- `packages/web/webapp/src/test/fixtures.ts`: 75 lines
- `packages/web/webapp/src/test/setup.ts`: 8 lines
- `packages/tui/vitest.config.ts`: 9 lines

Classifying the test-only files correctly produces 182,026 production lines in
the original tree (`182,118 - 92`). The successor bootstrap removed one
meaningless terminal blank line from `packages/agent-app/src/package-version.ts`,
then added 192 production lines in reviewed seed security fixes: 30 in the
SQLite creation boundary, 160 in the permanent descriptor-bound first-run
marker and its post-read doctor snapshot revalidation, and 2 in doctor
integration. The exact normalized successor baseline is therefore 182,217
production lines. The final reviewed seed replaced one fixed-delay SSE test
assertion with a bounded capacity-release probe, adding nine test lines and no
production code. It therefore records 179,145 test lines and 17,659
excluded-with-reason lines, for 379,021 executable lines. The G8 budget of
130,000 lines requires a rounded 28.66% reduction from this checked-in baseline
(71.34% retained).

`packages/web/webapp/vite.config.ts` remains production. Although Vite consumes
the file as build configuration, it owns shipped PWA metadata, service-worker
behavior, chunking, and production output, so moving its 70 lines outside the
product budget would hide product behavior rather than isolate pure tooling.

Ordinary CI validates the classifier's behavior but does not require the current
tree to equal this frozen baseline; later v1 PRs are expected to change it.
Gate-exit checks require the baseline path explicitly and require the full
tracked tree to be clean across `HEAD`, the index, and the worktree. The report
records the measured `HEAD` commit and tree plus the baseline's Git blob ID,
content digest, manifest digest, policy digest, and snapshot digest as evidence.

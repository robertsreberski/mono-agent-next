# V1 complexity baseline

`v1-complexity-baseline.json` is the exact normalized G0 snapshot used to
measure the v1 reduction. Generate a comparison report with:

```console
pnpm run report:v1-complexity
```

Reproduce G0 from a clean checkout with:

```console
node scripts/v1-complexity-report.mjs --verify-baseline refactor/baselines/v1-complexity-baseline.json --gate G0
```

The algorithm reads stage-0 Git blobs and closes its candidate universe from
the package catalog, package manifests, packed-file declarations, TypeScript
build inputs, Vite/HTML entry points, and recursive relative import graphs.
Executable extensions, executable modes, shebang files, package source
directories, shipped text assets, and reachable binary assets are accounted
too. Production reachability overrides test-looking paths. Unknown source under
a package root, source without an exact catalog owner, invalid text, or an
unclassified candidate fails the gate instead of disappearing from the report.

The exact G0 snapshot is:

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 536 | 187,005 |
| Test | 472 | 180,248 |
| Generated | 0 | 0 |
| Vendored | 0 | 0 |
| Excluded with evidence | 169 | 36,728 |
| Unclassified | 0 | 0 |
| Total accounted | 1,177 | 403,981 |

Its snapshot digest is
`ff1cb5900de51f954d68133295f26af8bc7572a99dc5e883afc6c905c201c313`,
its classified-file manifest digest is
`7c29e9894e498248cd2bb7d75d4253fd7100319cc9a0e10144eb70c2c6b7343f`,
and the baseline-file digest is
`18e8a2461abebcadd079dd9ce6f3de11df47842528688d3978d94ba81495f4f6`.
The frozen classification-authority digest is
`fa674ebaa4e80165745d7dfa2f51f500772f314855ac20d4d140c04719d14e7b`;
the initial ratchetable inventory-policy digest is
`51dd60ebc86aafe25c0c03ee8071ad38f85045d22814dfd662d42c5fbef4d3cf`.

The earlier algorithm-v1 baseline counted only selected executable extensions.
Algorithm v2 adds 13 production files and 4,788 production lines: the config
schema (2,476), shipped composer and Supermemory skill resources (1,553), and
the web app's HTML, SVG, and CSS inputs (759). It also adds 33 test fixture
files / 556 lines and 107 package metadata, documentation, build-config, and
binary-asset files / 17,924 lines. The adversarial regression suite adds 547
test lines, while the algorithm and reporter hardening add 1,145 excluded
tooling lines. These are accounting corrections, not new product behavior:
`182,217 + 4,788 = 187,005` production lines.

The three previously reviewed helpers remain test-only because no shipped
entry, build input, packed declaration, or production import reaches them:

- `packages/web/webapp/src/test/fixtures.ts`: 75 lines
- `packages/web/webapp/src/test/setup.ts`: 8 lines
- `packages/tui/vitest.config.ts`: 9 lines

By contrast, `packages/web/webapp/index.html`, `src/styles.css`, and the Vite
configuration are production inputs. The first two are reachable from the Vite
application graph; the configuration owns shipped PWA metadata, service-worker
behavior, chunking, and production output.

`manifestSha256` covers path-sorted exact file rows, including mode, owner,
classification, line count, and normalized content digest. `snapshotSha256`
covers the manifest plus budgets and architecture inventory. Generated,
vendored, and discretionary excluded files require one exact path and content
digest per file. Generated evidence runs both the declared generator and its
reproducibility command with no shell and rejects any repository-tree change;
vendored evidence also binds the upstream version and license digest. A
production-reachable file cannot be downgraded to excluded.

Catalog ownership includes each package's exact path, npm name, category,
responsibility, allowed dependency categories, publishability, and tier.
Manifest names must match catalog identities and catalog roots may not overlap.
The operator-wire inventory discovers implementations from production content,
requires one registered canonical client at G8, and rejects zero, duplicate, or
unregistered implementations.

## Frozen authority

`v1-complexity-g0-authority.json` independently binds the exact baseline,
classification authority, initial inventory policy, Git blob identities,
canonical digests, and totals. G0 accepts that artifact only when all four files
are committed at the measured `HEAD` and the snapshot is exact. After the G0 PR
merges, every later gate requires the protected annotated tag
`refs/tags/authority/v1-complexity-g0`; later commits may ratchet inventory but
cannot replace the frozen classification rules or baseline evidence.

Create the tag once, after merge, on the merge commit containing the exact
bound blobs:

```console
G0_MERGE_SHA=<reviewed-merge-commit>
G0_AUTHORITY_SHA=addb66e245faf0d2e26fba90696bb262bdc985ecbc8b2d0ba892a723f226f9e1
git tag -a authority/v1-complexity-g0 "$G0_MERGE_SHA" \
  -m "Freeze V1 complexity G0 authority." \
  -m "Complexity-Authority-SHA256: $G0_AUTHORITY_SHA"
git push origin refs/tags/authority/v1-complexity-g0
```

Protect `refs/tags/authority/v1-complexity-g0` from update and deletion in the
repository ruleset. The authority tag deliberately lives under `authority/`;
it does not match the npm release workflow's `v*` trigger. This implementation
does not create the tag itself because its target must be the reviewed merge
commit.

The binding G8 cap remains 130,000 production lines. Against the corrected
187,005-line G0 baseline, the roadmap-rounded reduction is 30.48% and the
retained share is 69.52%. Reducing tests never satisfies that budget.

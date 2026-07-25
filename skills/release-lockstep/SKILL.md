---
name: release-lockstep
description: Cut and registry-verify a lockstep npm release of all @mono-agent packages. Use when asked to release, publish to npm, cut vX.Y.Z, or bump the version. A release never implies consumer deployment.
---

# Lockstep npm release

This workflow ends when the tag is published and the public registry is
verified. Consumer deployment or restart is separate work and happens only when
explicitly requested.

All catalog-publishable packages release in lockstep.
`scripts/release/validate-release.mjs` requires every publishable package
version to equal the tag and every internal dependency to use the exact matching
workspace range.

**Lockstep set:** all **23 `publishable: true` entries** in
`scripts/package-catalog.mjs` release together: 21 core-tier packages, the
unscoped `create-mono-agent` alias under `packages/*`, and the
`@mono-agent/docs-mcp` plugin-tier extra under `extras/*`. The plugin extra is
version-bumped and published alongside core.

## 0. Enforce repository release authority

Before changing versions or creating a tag, run:

```bash
pnpm run release:guard
```

If the successor bootstrap safety guard is present, this command fails. Stop:
do not bump, tag, publish, deploy, restart, or repoint a consumer from this
checkout. The guard is removed only by the reviewed canonical-repository
cutover. Never bypass it with raw `npm publish` or a local token.

## 1. Bump in a worktree

Set the version in every catalog-publishable manifest, exact internal workspace
range, and demo/consumer manifest, then refresh the lockfile:

```bash
pnpm install
```

Search hand-authored package-version constants once. Update only constants that
mirror their own package version:

```bash
rg -n "_VERSION\\s*[:=]\\s*[\"'][0-9]" packages/*/src extras/*/src \
  --glob '*.ts' --glob '!**/__tests__/**'
```

## 2. Run one preflight path

First check whether the exact parent SHA already has successful hosted CI.

When it does, run only the release-specific mechanical checks:

```bash
pnpm run release:test
pnpm run release:validate -- --tag vX.Y.Z
pnpm run check:architecture
pnpm run build
pnpm run release:pack -- --tag vX.Y.Z
pnpm run release:consumer -- --tag vX.Y.Z --require-minimum
git diff --check
```

When the base is not proven or Actions is unavailable, run the single broad
local gate instead:

```bash
pnpm run verify:all
```

`verify:all` already covers the release graph, architecture, build, tarballs,
and packed consumer. Do not rerun its overlapping commands at the same SHA.
Never tag a failed preflight.

## 3. Merge, tag, and watch once

Merge the version PR, confirm `main` is clean and at the intended release
commit, then:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
gh run list --workflow "npm release" --limit 1
gh run watch <run-id>
```

Use one watcher. If the run fails immediately for an account or billing
condition, inspect it once, stop polling, and report the external failure.

The supported publisher is the tag workflow. A local fallback is allowed only
when the user supplied or explicitly authorized `NPM_DEV_TOKEN`, the tag points
at the clean current `main` commit, the release build marker is valid, and
`pnpm run release:guard` passes:

```bash
test -n "${NPM_DEV_TOKEN:-}"
NPM_CONFIG_USERCONFIG=/dev/null \
  NODE_AUTH_TOKEN="$NPM_DEV_TOKEN" \
  pnpm run release:publish -- --tag vX.Y.Z
```

Never print the token, persist it in the repository, or retry publishing with a
different package set. The publisher freezes all tarballs, stages them, verifies
integrity, then promotes the complete set.

## 4. Verify the public registry once

The local proxy npm configuration can break npmjs reads. Use the pinned registry
or blank user config:

```bash
NPM_CONFIG_USERCONFIG=/dev/null pnpm run release:verify -- --tag vX.Y.Z
npm view @mono-agent/module-sdk version --registry https://registry.npmjs.org/
```

The release verifier covers the whole lockstep set; the single `npm view` is a
human-readable spot check. Fresh publication may take about a minute to become
visible, so let the verifier's bounded retry finish instead of starting parallel
poll loops.

## 5. Closeout

Report the release commit, tag, publish path (CI or authorized local fallback),
and registry verification. Then stop. Consumer adoption remains a separate,
explicitly authorized workflow and can begin only after
`pnpm run release:guard` passes.

Package deprecation is a separate, explicitly authorized registry action.
Remove due code, tests, and current documentation together when that scope is
approved.

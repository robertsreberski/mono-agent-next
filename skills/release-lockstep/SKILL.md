---
name: release-lockstep
description: Cut and registry-verify a lockstep npm release of all @mono-agent packages. Use when asked to release, publish to npm, cut vX.Y.Z, or bump the version. A release never implies consumer deployment.
---

# Lockstep npm release

This workflow ends when the tag is published and the public registry is
verified. Restarting Personal Agent, other mono-agent instances, A8C agents, or
the web console is separate work and happens only when explicitly requested.

All catalog-publishable packages release in lockstep.
`scripts/release/validate-release.mjs` requires every publishable package
version to equal the tag and every internal dependency to use the exact matching
workspace range.

**Lockstep set:** all **22 `publishable: true` packages** in
`scripts/package-catalog.mjs` release together: 16 core packages (entries without
a `tier`), 1 `tier: "alias"` package (`create-mono-agent` under `packages/*`), and
5 `tier: "plugin"` extras under `extras/*` (a2a-adapter, agent-orchestrator,
docs-mcp, memory-supermemory, and whatsapp-adapter). Plugin extras are version-bumped and
published alongside core.

## 1. Bump in a worktree

Set the version in every catalog-publishable manifest, exact internal workspace
range, and demo/consumer manifest, then refresh the lockfile:

```bash
pnpm install
```

Grep hand-authored package-version constants once. Update only constants that
mirror their own package version:

```bash
grep -rnE "_VERSION\s*[:=]\s*[\"'][0-9]" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__
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
at the clean current `main` commit, and the release build marker is valid:

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
npm view @mono-agent/agent-app version --registry https://registry.npmjs.org/
```

The release verifier covers the whole lockstep set; the single `npm view` is a
human-readable spot check. Fresh publication may take about a minute to become
visible, so let the verifier's bounded retry finish instead of starting parallel
poll loops.

## 5. Closeout

Report the release commit, tag, publish path (CI or authorized local fallback),
and registry verification. Then stop. If consumer adoption was also requested,
start a separate exact-target workflow with `fleet-deploy` or that consumer's
own runbook.

Package deprecations must retain an explicit removal version/date or permanent
retention decision in `docs/reference/deprecations.md`; remove due code, tests,
and documentation together during the target release.

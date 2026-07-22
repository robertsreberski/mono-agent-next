---
name: docs-sync
description: Update and verify only the documentation surfaces affected by a mono-agent change. Use when asked to update docs, sync docs, check the website, or when a user-facing contract actually changed.
---

# Docs sync

## Select the affected surface

Documentation work is diff-scoped:

- Changes only under `skills/`, `agents/`, or internal process instructions
  do not require package docs or an Astro build.
- Package behavior/API changes update the owning README and relevant canonical
  `docs/` pages.
- Config changes also update the feature registry and closest task playbook.
- Website-only presentation changes run the website gate.
- A PR-range audit is explicit work; never infer it from a single feature PR.

If no user-facing contract or published documentation input changed, record
"docs not affected" and stop this skill.

## Source-of-truth rule

`docs/` is canonical (in git, browsable on GitHub, source for the composer
skill). `website/src/content/docs` is **generated** by
`website/scripts/sync-content.mjs` — never edit it; a diff touching it is a bug.
Top-level `docs/superpowers/` and `docs/skills/` are excluded from the published
site.

## Doc surfaces checklist (when affected)

- `docs/<area>/*.md` (channels, config, runtime, memory, tools, observability, …)
- `docs/reference/feature-registry.md` — the feature→config map; every new config key lands here
- `docs/reference/feature-matrix.md`, `docs/reference/presets.md`
- `docs/playbooks/*` — task-shaped playbooks; extend the closest one
- Package READMEs — 9 required sections in a fixed order, enforced by
  `check:architecture`; `## Architecture` includes data flow and package
  structure, while `## Public API` starts with a curated entry-point map and
  keeps its generated inventory in parity with the real export map
- Root `README.md`, `PACKAGES.md`
- `demos/*/IDENTITY.example.md`, `demos/*/SOUL.example.md`, and any other
  `demos/*/*.example.md` — copy-paste seed templates that actively break a fresh
  agent when stale, and a `docs/`-only pass misses them. Add them to the checklist
  on every memory / tool-surface PR.
- `packages/agent-app/skills/mono-agent-composer/references/*.md` — the composer
  skill's knowledge base; fold it into the "after any user-facing feature lands"
  pass. It silently drifted out of the loop for ≥3 PRs (native-notify #98,
  per-trigger-model-effort, external-memory-backends #52), and because that
  `SKILL.md` tells composing agents never to read `feature-registry.md` or package
  source, these references are the single point of failure for "does the framework
  support X."
- Retired-surface mentions are policed by:

```bash
node scripts/check-consumer-docs-consistency.mjs
```

## Per-PR drift checks

Run these against the PR diff; each one caught a real doc regression.

**README `## Public API` ↔ package exports parity.** Public API inventories are
generated for every catalog package from its `package.json` export map and the
corresponding TypeScript/JavaScript source entrypoints. This covers root and
subpath exports, re-exports, and type-only exports without a hand-maintained
package or symbol list. Narrative prose and examples outside the classified
inventory markers remain hand-authored.

After changing an export map or source barrel, regenerate the inventories. A
second run must report zero changed files, and the architecture gate must pass:

```bash
pnpm run generate:public-api-docs
pnpm run generate:public-api-docs # must report 0 files updated
pnpm run check:architecture
```

Do not edit content between `public-api-inventory` or
`public-api-js-subpaths` markers by hand. The architecture gate rejects missing
or invented exports, stale `*FieldGroup` README identifiers, and drift between a
classified MIGRATION subpath inventory and its package export map.

This check caught the observability README drift, stale `*FieldGroup` names,
the missing `toCronJobs` export, the phantom `AgentMessageStreamResult`, and the
agent-runtime deep-subpath count drift.

**Catalog metadata and package navigation are generated.** After changing a
catalog entry, workspace dependency, or package README, refresh metadata,
`PACKAGES.md`, and the website package directory twice:

```bash
pnpm run generate:package-docs
pnpm run generate:package-docs # must report 0 files updated
pnpm run check:docs
pnpm run check:architecture
```

Do not edit content inside `package-metadata`, `package-dependency-graph`, or
`package-directory` markers by hand.

**Rename ⇒ grep the old name across docs.** When a PR renames/removes an exported
symbol, grep the old name before closing the pass — README samples and docs prose
don't move with the code:

```bash
grep -rn '<old-name>' packages/*/README.md docs/
```

`telegramFieldGroup`/`slackFieldGroup` → `TELEGRAM_CONFIG_FIELDS`/`SLACK_CONFIG_FIELDS`
left the README samples stale.

**Behavior-prose drift on a new opt-in mode.** When a PR adds a new opt-in
mode/enum, grep the package README prose for a stale absolute claim ("does not …
X", "always Y, never Z") the new code just falsified. cron-adapter README line 87
"does not … queue overlapping jobs" survived the arrival of the new
`overlap:"queue"`.

**Cross-cutting operator tables.** When a PR introduces a new durable store, grep
its new root/store name across `docs/**/*.md` and patch any table/matrix that
enumerates "what does X reset/purge/survive" — not just the prose.
`docs/runtime/sessions-concurrency.md`'s boundary-rules table went silent on
v0.11.0 durable conversation-history.

**`config-reference.ts` ⇒ `feature-registry.md` row + prose page.** If a PR
touches `packages/agent-app/src/config-reference.ts`, grep the new `jsonPath`
against the registry and its prose page before calling the PR doc-complete:

```bash
comm -23 \
  <(grep -oE '"[a-z]+\.[a-zA-Z]+"' packages/agent-app/src/config-reference.ts | sort -u) \
  <(grep -oE '`[a-z]+\.[a-zA-Z]+`' docs/reference/feature-registry.md | tr -d '`' | sort -u)
```

Any left-only line is a config key with no registry row (would have caught the
F2/F3 misses).

## Build + verify only when published inputs changed

`website/` is its own pnpm workspace. Run this gate only when `docs/`,
`website/`, or another published-site input changed. The root `pnpm build`
does not build it:

```bash
pnpm -C website install                    # first time or after dep changes
pnpm -C website run check:asides           # canonical docs: no empty Starlight asides
pnpm -C website build                      # check-asides + sync-content + astro build + check-links
pnpm -C website run test:a11y              # Playwright + axe over every built HTML route
node website/scripts/sync-content.mjs      # sync only
node website/scripts/check-links.mjs       # link check only (needs dist/)
pnpm -C website preview -- --port 4329     # manual review
```

## PR-range audit recipe (the PR #110 pattern)

1. List the range: `gh pr list --state merged --base main --json number,title,mergedAt --limit 40`
2. For each PR, classify **user-facing** vs **internal-only** (say so explicitly —
   the #110 audit found 11/30 internal; don't invent docs for internal work).
3. For user-facing PRs, walk the checklist above and patch `docs/` file-by-file.
4. `pnpm -C website build` green (includes the link checker).
5. Work in a worktree, branch `docs/<topic>`, PR with `gh pr create --base main`.

## Gotchas

- Keep `website/package.json` and `website/astro.config.mjs` in lockstep: Astro 7
  custom rehype plugins use `unified`, and current Starlight sidebar groups wrap
  `autogenerate` entries in `items`. Do not upgrade either dependency without
  rerunning both the website build and accessibility suite.
- In a worktree, website node_modules are absent: `pnpm -C website install` or
  `ln -sfn <main-repo>/website/node_modules website/node_modules`.
- Starlight only applies markdown features to files physically under
  `src/content/docs` — that's why sync copies instead of loading `../docs`.
- Keep the nine README section headings and order byte-exact: `## Category`,
  `## Responsibility`, `## Install / Usage`, `## Architecture`,
  `## Public API`, `## Dependency Boundary`,
  `## What This Package Does Not Own`, `## Related Documentation`, and
  `## Verification`.
- `website/scripts/check-starlight-asides.mjs` rejects an opening Starlight
  aside fence immediately followed by its closing fence; the website build and
  CI job both run it before syncing canonical docs.
- Mark runnable TypeScript examples with `<!-- doc-test:typescript -->`
  immediately before their fence. `pnpm run check:doc-snippets` typechecks only
  those complete examples after the package build; leave illustrative fragments
  unmarked and describe their omitted context.

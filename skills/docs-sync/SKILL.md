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
- Config changes also regenerate the config reference and update the closest
  conceptual or task page.
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
- `docs/config/reference.md` — generated selected-module schema and scaffold
  examples
- `docs/reference/architecture.md`, `docs/reference/packages.md`
- `docs/playbooks/*` — task-shaped playbooks; extend the closest one
- Package READMEs — 9 required sections in a fixed order, enforced by
  `check:architecture`; `## Architecture` includes data flow and package
  structure, while `## Public API` starts with a curated entry-point map and
  keeps its generated inventory in parity with the real export map
- Root `README.md`, `PACKAGES.md`
- `packages/create-mono-agent/skills/mono-agent-composer/references/*.md` — the
  bundled composer skill's source knowledge
- Retired-surface mentions are policed by:

```bash
node scripts/check/consumer-docs-consistency.mjs
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
or invented exports, stale README identifiers, and drift between generated
inventories and package export maps.

This check catches invented symbols, stale export names, and deep-subpath drift.

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

**Rename ⇒ search the old name across docs.** When a PR renames/removes an
exported symbol, search the old name before closing the pass — README samples and docs prose
don't move with the code:

```bash
rg -n '<old-name>' packages/*/README.md docs
```

Treat the old name reaching zero documentation matches as explicit rename proof.

**Behavior-prose drift on a new opt-in mode.** When a PR adds a new opt-in
mode/enum, grep the package README prose for a stale absolute claim ("does not …
X", "always Y, never Z") that the new code just falsified.

**Cross-cutting durable-state boundaries.** When a PR introduces a new durable
store, search its root/store name across `docs/` and patch every current page
that enumerates what reset, purge, or restart preserves.

**Scaffold/config source ⇒ regenerated reference + prose page.** If a PR changes
`packages/create-mono-agent/src/templates.ts`, a selected module schema, or the
source-doc generator, regenerate the source documentation twice and update the
closest hand-authored config/concept page:

```bash
pnpm run generate:source-beta-docs
pnpm run generate:source-beta-docs
pnpm run check:source-beta-docs
```

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

## Explicit PR-range audit

1. List the range: `gh pr list --state merged --base main --json number,title,mergedAt --limit 40`
2. For each PR, classify **user-facing** vs **internal-only**; do not invent
   documentation for internal-only work.
3. For user-facing PRs, walk the checklist above and patch `docs/` file-by-file.
4. `pnpm -C website build` green (includes the link checker).
5. Work in a worktree, branch `docs/<topic>`, PR with `gh pr create --base main`.

## Gotchas

- Keep `website/package.json` and `website/astro.config.mjs` in lockstep: Astro 7
  custom rehype plugins use `unified`, and current Starlight sidebar groups wrap
  `autogenerate` entries in `items`. Do not upgrade either dependency without
  rerunning both the website build and accessibility suite.
- In a worktree, website dependencies are independent: run
  `pnpm -C website install`.
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

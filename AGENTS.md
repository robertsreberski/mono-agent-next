# AGENTS.md

## Project

This repository currently contains the config-first v0 framework built from npm packages under the `@mono-agent` scope. The accepted v1 target replaces the `agent-app` / `agent-runtime` application plane with the smaller `core` / `module-sdk` architecture in [the v1 architecture decision](./docs/reference/v1-architecture.md).

## Successor bootstrap safety

This repository is the development-only successor. Until this section is
explicitly removed, the original private `mono-agent` repository remains the
live v0 source for the local CLI and Personal Agent, even if either repository
is renamed. Do not publish packages, deploy or restart consumers, or repoint
live services from this checkout. Remove this guard only during the reviewed
canonical-repository cutover after the final v0 release and archive evidence,
the exhaustive source-link inventory, every immutable consumer pin and rollback,
and retired/dormant-surface proof are verified. The required credential-free
`release:publish -- --dry-run` CI lane is non-mutating verification, not a
publication exception: it receives no npm/OIDC credential, performs no explicit
registry-integrity inspection or dist-tag promotion, and cannot authorize a
real publish. V1-005
may pin explicitly inventoried consumers from the predecessor-published
`0.16.0` registry artifact through each consumer's own lifecycle while this
guard remains; it never executes successor code or widens the named targets.

## V1 migration authority

- The accepted v1 architecture decision and `refactor/mono-agent-v1-prd.md`
  govern refactor branches. Descriptions of v0 packages below are current-state
  constraints, not reasons to retain a package or capability that the reviewed
  v1 ledger cuts.
- Each v1 task must pair replacement with deletion, update the requirement
  ledger and PRD when evidence changes scope, and preserve only the explicitly
  retained behavior and compatibility boundaries.
- Until the successor bootstrap guard is removed, v1 work is source-only: no
  package publishing, deployment, consumer restart, or live-service repointing
  from this checkout. Credential-free release dry runs and the separately
  bounded predecessor-registry pin workflow above do not weaken this rule.

## Repository shape

- Treat this repository as a pnpm workspace monorepo.
- Publishable packages live under `packages/<package-name>/`.
- In the current v0 seed, optional plugin-tier extras live under `extras/<package-name>/` when cataloged with `publishable: true` and `tier: "plugin"`; the accepted v1 ledger removes this generic plugin plane and dispositions each current extra independently.
- Published package names should use the `@mono-agent/<package-name>` scope.
- Package categories live in `scripts/package-catalog.mjs` and README docs; keep the physical workspace layout flat unless a task explicitly asks for a mechanical migration.
- Root instructions apply to every package unless a package-local `AGENTS.md` narrows them.
- Keep root workspace/package-manager scaffolding limited to the checked-in pnpm workspace setup unless a task explicitly asks to broaden it.

## Engineering discipline

- Read this file, the relevant package-local `AGENTS.md` if present, and package docs before editing.
- Keep changes small, typed, and reviewable.
- Prefer explicit contracts, narrow interfaces, deterministic validation, and thin runtime wrappers.
- Keep package boundaries clear; avoid circular dependencies and hidden cross-package coupling.
- Do not hide model/runtime/provider failures behind broad fallbacks or fake success states.
- Do not commit secrets, provider API keys, OAuth tokens, generated credentials, or local `.env*` files.

## Development workflow

- The user's request is the execution contract. Do not infer an issue workflow, post issue checkpoints, or expand the requested release/deployment targets unless the user explicitly asks.
- All changes land through a PR; never commit directly to `main`.
- After the canonical-repository cutover, the normal `main` checkout is the clean canonical development source. Consumers remain pinned to reviewed release installations; keep `main` usable and make tracked changes only in isolated worktrees (see `skills/worktree-feature`).
- Start with the single skill that best matches the requested outcome. Add another skill only when the requested scope crosses that skill's boundary; a release does not imply deployment, deployment does not imply a full-fleet audit, and docs do not imply a website build unless those surfaces changed.
- Select verification from the diff's risk, using `verify-green`: docs/skills/process changes use their focused contract checks; ordinary package changes use focused build/test/typecheck plus one broad CI gate; security, storage, lifecycle, provider-routing, delivery, and public-boundary changes add one local full gate and one matching smoke scenario.
- Release and restart only explicitly requested consumers. Prove the exact target's version, process, and bounded health evidence instead of automatically verifying unrelated agents.
- Give every external review finding an explicit disposition (fixed / follow-up issue / rejected-with-reason) before merge.
- `agents/` holds the subagent templates; each `agents/*.md` has a `.toml` companion kept in sync by `pnpm run check:codex-discoverability`.
- Canonical website pages under `docs/` use frontmatter `title` and `description` as their page heading; do not add a second Markdown H1. Run `pnpm run check:docs` for headings, code-fence labels, accessible link text, diagram summaries, and local links.

## Package expectations

- Each package should have one clear responsibility and a focused public API.
- Use `@mono-agent/*` package names consistently.
- Add or update focused tests with behavior changes.
- Use package-local scripts once package manifests exist; route repo-wide commands through the root pnpm recursive scripts.
- Keep runtime-facing artifacts structured and machine-validated where practical.
- Keep package READMEs in the standard nine-section order, with `Architecture` data-flow/source maps and a curated `Public API` start-here map. Catalog metadata, the package dependency graph, and package directories are generated by `pnpm run generate:package-docs`; generated public API inventories are maintained separately by `pnpm run generate:public-api-docs`.

## Framework boundaries

- Communication adapters, skills/MCP integration, harness/runtime orchestration, and memory should remain modular.
- Memory remains optional. First-party v1 retains only the BuJo-backed `memory-local` implementation; a simpler strategy belongs in an explicitly selected external memory module rather than a second first-party mode.
- Prefer real execution paths in verification. Fixtures are acceptable for tests, not as product-runtime substitutes.

## Capability ladder

Choose the lowest rung that satisfies the capability; see [docs/reference/capability-ladder.md](./docs/reference/capability-ladder.md) for the canonical reader page.

1. Existing package / existing public surface. Cost: lowest; no new ownership surface. Gate: use the current package responsibility and API without adding a new config or runtime concept.
2. Config field or selected skill. Cost: new user-facing option or loaded instruction surface. Gate: typed config/validation/docs for config; selected skills stay under `context.selectedSkills` without host glue.
3. New adapter/package in the correct package category. Cost: new package ownership, README, tests, and catalog metadata. Gate: add `category`, `responsibility`, and `allowedDependencyCategories` to `scripts/package-catalog.mjs`; `scripts/check-package-architecture.mjs` must pass.
4. MCP server / auto-provisioned MCP tool. Cost: runtime-visible tool lifecycle, policy/security/docs, and tool-result behavior. Gate: use when the model needs an explicit callable tool boundary; the canonical app-owned example is `MemoryRecall`.
5. Shared framework contract change. Cost: highest blast radius and likely semver/release coordination. Gate: while v0 survives, `@mono-agent/agent-contracts` remains its adapter-neutral boundary; v1 work instead follows the reviewed `module-sdk` / `core` ownership map and must not add new v0 coupling merely to preserve a retiring package.

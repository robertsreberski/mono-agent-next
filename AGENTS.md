# AGENTS.md

## Project

This repository contains the config-first v1 framework built from npm packages under the `@mono-agent` scope. `@mono-agent/core` loads strict typed modules defined by `@mono-agent/module-sdk`; providers, channels, durable capabilities, triggers, operator products, scaffolding, documentation search, and macOS service integration remain separate ownership surfaces.

## Successor bootstrap safety

This private repository is the development-only successor. The original private
`mono-agent` repository remains the live source for the local CLI and Personal
Agent. Do not publish packages, deploy or restart consumers, repoint services,
or retire the predecessor from this checkout. Release, soak, observation,
migration, cutover, and predecessor retirement are a separate explicitly
authorized phase.

## V1 migration authority

- The accepted v1 architecture decision and `refactor/mono-agent-v1-prd.md`
  define the product boundaries and 23-package roster.
- Implement coherent vertical outcomes. Do not recreate deleted v0 packages as
  aliases, compatibility shims, generic plugins, or hidden fallback paths.
- Keep this phase source-only. Critical checks cover security, data loss,
  public APIs, package closure, and migration safety; release operations remain
  outside this phase.

## Repository shape

- Treat this repository as a pnpm workspace monorepo.
- Publishable packages live under `packages/<package-name>/`.
- The only publishable package under `extras/` is the explicitly paired `@mono-agent/docs-mcp` companion. It is not selected by agent config and has no runtime dependency on Core.
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

- Communication channels, skills/MCP integration, runtime orchestration, state, memory, exporting, sandboxing, and triggers remain modular typed selections.
- Memory remains optional. First-party v1 retains only the owner-private SQLite `memory-local` implementation; another strategy belongs in an explicitly selected external memory module rather than a second first-party mode.
- Prefer real execution paths in verification. Fixtures are acceptable for tests, not as product-runtime substitutes.

## Capability ladder

Choose the lowest rung that satisfies the capability; see [docs/reference/capability-ladder.md](./docs/reference/capability-ladder.md) for the canonical reader page.

1. Existing package / existing public surface. Cost: lowest; no new ownership surface. Gate: use the current package responsibility and API without adding a new config or runtime concept.
2. Config field or selected skill. Cost: new user-facing option or loaded instruction surface. Gate: typed config/validation/docs for config; selected skills stay under `context.selectedSkills` without host glue.
3. New adapter/package in the correct package category. Cost: new package ownership, README, tests, and catalog metadata. Gate: add `category`, `responsibility`, and `allowedDependencyCategories` to `scripts/package-catalog.mjs`; `scripts/check-package-architecture.mjs` must pass.
4. MCP server / explicitly configured MCP tool. Cost: runtime-visible tool lifecycle, policy/security/docs, and tool-result behavior. Gate: use when the model needs an explicit callable tool boundary; project tools remain ordinary `.mcp.json` entries.
5. Shared contract change in `@mono-agent/module-sdk`. Cost: highest blast radius and likely semver/release coordination. Gate: last resort for provider- and channel-neutral framework semantics; `@mono-agent/core` must not expose implementation-specific contracts.

# AGENTS.md

## Project

This repository is a config-first agent framework built from npm packages under the `@mono-agent` scope. The v1 shape centers on `@mono-agent/agent-app` composing the consolidated `@mono-agent/agent-runtime`, modular built-in channel adapters, config-loaded extras, skills/MCP/harness integration, observability, and optional memory.

## Successor bootstrap safety

This repository is the development-only successor. Until this section is
explicitly removed, the original private `mono-agent` repository remains the
live v0 source for the local CLI and Personal Agent, even if either repository
is renamed. Do not publish packages, deploy or restart consumers, or repoint
live services from this checkout. Remove this guard only during the reviewed
canonical-repository cutover after the final v0 release and consumer pinning are
verified.

## Repository shape

- Treat this repository as a pnpm workspace monorepo.
- Publishable packages live under `packages/<package-name>/`.
- Optional plugin-tier extras live under `extras/<package-name>/` when cataloged with `publishable: true` and `tier: "plugin"` (published in the npm lockstep but outside the core `@mono-agent/agent-app` closure, loaded via `channels.plugins[]`, as a request-scoped runtime extension, through an explicitly selected plugin backend, or as an explicitly paired companion MCP server); the current extras are `@mono-agent/a2a-adapter`, `@mono-agent/agent-orchestrator`, `@mono-agent/docs-mcp`, `@mono-agent/memory-supermemory`, and `@mono-agent/whatsapp-adapter`.
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
- After the canonical-repository cutover, the normal `main` checkout is the clean live source for the local mono-agent CLI and Personal Agent. Keep it usable and make tracked changes only in isolated worktrees (see `skills/worktree-feature`).
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
- Memory should be optional; a simple `memory.md`-style implementation is acceptable until a stronger persistence adapter is required.
- Prefer real execution paths in verification. Fixtures are acceptable for tests, not as product-runtime substitutes.

## Capability ladder

Choose the lowest rung that satisfies the capability; see [docs/reference/capability-ladder.md](./docs/reference/capability-ladder.md) for the canonical reader page.

1. Existing package / existing public surface. Cost: lowest; no new ownership surface. Gate: use the current package responsibility and API without adding a new config or runtime concept.
2. Config field or selected skill. Cost: new user-facing option or loaded instruction surface. Gate: typed config/validation/docs for config; selected skills stay under `context.selectedSkills` without host glue.
3. New adapter/package in the correct package category. Cost: new package ownership, README, tests, and catalog metadata. Gate: add `category`, `responsibility`, and `allowedDependencyCategories` to `scripts/package-catalog.mjs`; `scripts/check-package-architecture.mjs` must pass.
4. MCP server / auto-provisioned MCP tool. Cost: runtime-visible tool lifecycle, policy/security/docs, and tool-result behavior. Gate: use when the model needs an explicit callable tool boundary; the canonical app-owned example is `MemoryRecall`.
5. Shared core contract change in `@mono-agent/agent-contracts`. Cost: highest blast radius and likely semver/release coordination. Gate: last resort for adapter-neutral shared structure; `scripts/check-package-architecture.mjs` enforces adapter-neutrality.

---
title: "Capability ladder"
description: "Choose the lowest-cost extension boundary for new mono-agent capabilities before adding packages or contracts."
sidebar:
  order: 5
---

Choose the lowest rung that satisfies the capability. Lower rungs keep ownership, runtime surface area, and release blast radius smaller; higher rungs need stronger gates because they create new boundaries for users, hosts, packages, or adapters.

Use this page before changing package boundaries, adding new runtime-visible tools, or moving adapter-specific ideas into shared contracts.

## Rungs

| Order | Rung | Cost | Gate |
| --- | --- | --- | --- |
| 1 | Existing package / existing public surface | Lowest; no new ownership surface. | Use the current package responsibility and API without adding a new config key, runtime concept, package, or shared contract. |
| 2 | Config field or selected skill | New user-facing option or loaded instruction surface. | For config, add typed config, validation, docs, and feature-registry coverage when it ships a capability. For skills, keep the behavior under `context.selectedSkills`; selected skills should not require host glue. |
| 3 | New adapter/package in the correct package category | New package ownership, README, tests, release discovery, and catalog metadata. | Add the package to `scripts/package-catalog.mjs` with the correct `category`, `responsibility`, and `allowedDependencyCategories`; `scripts/check-package-architecture.mjs` must pass. Channel adapters that should be loaded from config expose a package-root `createChannelDriver()` and are declared under `channels.plugins[]`; the seam is loading only, still returning a normal `ChannelDriver`. |
| 4 | MCP server / auto-provisioned MCP tool | Runtime-visible tool lifecycle, policy/security/docs, and tool-result behavior. | Use this when the model needs an explicit callable tool boundary. The canonical app-owned example is `MemoryRecall`; arbitrary user MCP servers still belong under `tools.mcpConfigPath`. |
| 5 | Shared core contract change in `@mono-agent/agent-contracts` | Highest blast radius; likely semver, release coordination, and migration work. | Last resort only for adapter-neutral shared structure. `scripts/check-package-architecture.mjs` enforces that `agent-contracts` stays adapter-neutral. |

## Enforcement points

- `scripts/package-catalog.mjs` is the source of truth for package categories, responsibilities, and allowed workspace dependency categories.
- `scripts/check-package-architecture.mjs` enforces catalog coverage, package dependency boundaries, and adapter-neutrality for core contracts.
- `docs/reference/feature-registry.md` is the source of truth for shipped framework capabilities and their coverage.

The [feature registry](/reference/feature-registry/) coverage legend explains whether a capability is reached through config, CLI, auto behavior, code, or development tooling. Its maintenance rules apply when a package ships a new capability or option; do not add a registry row for a docs-only decision rule like this ladder.

## How to choose

Start by asking whether an existing public surface can express the behavior. If it can, stay on rung 1 and document usage where needed. If users need to declare or select behavior, rung 2 is usually enough. If the behavior needs independent package ownership or adapter responsibility, use rung 3. If the model must decide to call a bounded tool at runtime, use rung 4. Only change `@mono-agent/agent-contracts` when multiple packages need the same adapter-neutral structure and the lower rungs would create hidden coupling.

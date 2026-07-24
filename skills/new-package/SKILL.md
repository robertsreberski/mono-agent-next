---
name: new-package
description: Add a new @mono-agent package that passes the architecture, README, catalog, dependency, and lockstep gates on the first try.
---

# New package

## Start at the capability ladder

A new package is rung 3. Confirm that an existing public surface or a typed
config/skill selection cannot own the capability first. A new MCP server is rung
4; a provider-neutral shared-contract change in `@mono-agent/module-sdk` is rung
5 and the last resort.

## Required shape

1. Add `packages/<name>/package.json` with the published name
   `@mono-agent/<name>`. Match the lockstep version in
   `packages/module-sdk/package.json`, use exact `workspace:<version>` internal
   dependencies, and point `types`/`exports` at `dist/`.
2. Add the package to `scripts/package-catalog.mjs` with one category, one
   responsibility, the narrowest allowed dependency categories, and
   `publishable: true`.
3. Use the standard README section order:
   `Category`, `Responsibility`, `Install / Usage`, `Architecture`, `Public API`,
   `Dependency Boundary`, `What This Package Does Not Own`,
   `Related Documentation`, and `Verification`. Architecture needs `Data flow`
   and `Package structure`; Public API starts with a curated `Start here` map.
4. Add focused behavior tests under `src/__tests__/` and package-local
   `build`, `test`, and `typecheck` scripts matching a current sibling in the
   same category.
5. Add the package to the root development dependency closure with the exact
   workspace version, then refresh `pnpm-lock.yaml`.

Valid catalog categories are defined by `PACKAGE_CATEGORIES` in
`scripts/package-catalog.mjs`; do not copy an older list into the manifest.

## Verify

```bash
pnpm install --frozen-lockfile=false
pnpm run generate:package-docs
pnpm run generate:package-docs
pnpm run generate:public-api-docs
pnpm run generate:public-api-docs
pnpm run check:docs
pnpm run check:architecture
pnpm run release:validate -- --tag v<version>
pnpm --filter @mono-agent/<name>... run build
pnpm --filter @mono-agent/<name> run test
pnpm --filter @mono-agent/<name> run typecheck
```

Both generators must report zero updates on their second run. Finish with the
risk-based `verify-green` lane.

## Boundary checks

- Keep one responsibility and a focused public API. Widening
  `allowedDependencyCategories` requires a concrete dependency and ownership
  reason.
- A selected module must use an admitted kind and its typed SDK factory. Do not
  add aliases, automatic discovery, hidden activation, or a second config
  registry.
- For a communication package, declare its `channelIds` in the catalog. The
  architecture gate derives the shipped ids and scans both
  `packages/module-sdk/src` and `packages/core/src` for hard-coded channel
  prefixes; run it rather than maintaining another literal list.
- Before adding a parser, lock, secure-filesystem choreography, retry loop, or
  transport primitive, search current production source for an implementation
  that already owns it.
- If the package creates durable state under `.mono-agent/`, document its
  boundary and prove the existing clear/reset/purge surface covers it.
- For an HTTP MCP server, register response-close cleanup before awaiting request
  handling, and prove close/error/abort paths with focused tests.

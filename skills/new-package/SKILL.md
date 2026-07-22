---
name: new-package
description: Add a new @mono-agent package/adapter that passes the architecture gate on the first try (catalog entry, README sections, dependency categories, lockstep version). Use when creating any new package, or when check:architecture fails on catalog/README/boundary errors.
---

# New package

## First: climb the capability ladder (AGENTS.md)

A new package is rung 3 of 5. Confirm the lower rungs don't satisfy the need:

1. Existing package / existing public surface
2. Config field or selected skill (typed config + validation + docs)
3. **New adapter/package in the correct category** ← this skill
4. MCP server / auto-provisioned MCP tool (canonical examples: `MemoryRecall`, the adapter tools such as `AskUser` and `TelegramSendFile`)
5. Shared contract change in `@mono-agent/agent-contracts` — last resort;
   adapter-neutrality is enforced by the arch checker

## Checklist

1. **Manifest** — `packages/<name>/package.json`: name `@mono-agent/<name>`,
   version = current lockstep version (match `packages/agent-app/package.json`),
   internal deps as `workspace:<version>`, `types`/`exports` pointing at `dist/`
   (NodeNext, no src aliases), and `build`/`test`/`typecheck` scripts matching a
   sibling package in the same category.
2. **Catalog** — register in `scripts/package-catalog.mjs`:

```js
{
  dir: "<name>",
  name: "@mono-agent/<name>",
  category: "communication",   // one of: runtime, core, context, execution,
                               // observability, evaluation, communication,
                               // operator-surface, app
  responsibility: "<one sentence>",
  allowedDependencyCategories: ["core"],
  publishable: true,
}
```

3. **README** — must contain these byte-exact section headings, once and in
   this order: `## Category`, `## Responsibility`, `## Install / Usage`,
   `## Architecture`, `## Public API`, `## Dependency Boundary`,
   `## What This Package Does Not Own`, `## Related Documentation`, and
   `## Verification`. Under Architecture add `### Data flow` and
   `### Package structure`; under Public API add a hand-authored
   `### Start here` before the generated inventory markers.
4. **Tests** — focused tests under `src/__tests__/`; behavior lives with tests
   from the first commit.
5. **Root wiring** — add to root `package.json` devDependencies as
   `workspace:<version>` (release:validate checks the root too), then `pnpm install`.

## Gate

```bash
pnpm run generate:package-docs
pnpm run generate:package-docs # must report 0 files updated
pnpm run check:docs
pnpm run check:architecture
pnpm run release:validate -- --tag v<version>
pnpm --filter @mono-agent/<name> run build && pnpm --filter @mono-agent/<name> test
```

Then the full `verify-green` gate. Common arch-check failures: package dir
missing from the catalog, unknown/disallowed dependency category, missing README
section, adapter-neutrality violation in agent-contracts.

## Boundaries to respect

- One clear responsibility, focused public API, no hidden cross-package coupling.
- Dependencies only on categories in `allowedDependencyCategories`; if you need
  more, that's a design smell — re-read the ladder before widening.
- User-facing packages need docs: run `generate:package-docs` for `PACKAGES.md`
  and the website directory, then add the feature-registry entry and, when
  useful, extend a playbook (hand off to the `docs-sync` skill).

## Adapter & channel checks (when the package is a channel driver)

When the new package is a channel driver, or adds a new `ChannelId`:

- **Adapter-neutrality — grep the ENTIRE core surface, not one package.** The
  mechanical arch guard only scans `packages/agent-contracts/src` for two literals
  (`telegram`, `whatsapp`), and that scope/word-list never grew as channels were
  added. Run a standing check of both the contracts AND the harness for a
  hardcoded reference to any shipped channel id, sourced from the channel catalog
  rather than fixed literals:

  ```bash
  grep -riE "\b(telegram|whatsapp|slack|discord)\b" \
    packages/agent-contracts/src packages/agent-harness/src --include=*.ts | grep -v __tests__
  ```

  `ChannelId` is `string`, open by design (third-party drivers pick their own id),
  so core code must branch on capability, never on a literal id.

- **Interactive-channel harness classification.** If the channel produces
  interactive (human-attended) conversations, confirm the harness's per-turn
  model-facing framing recognizes it — `sessionContextBlock` in
  `packages/agent-harness/src/harness.ts`, plus any sibling logic keyed off the
  `conversationId` shape. Do not assume a hardcoded string-prefix allowlist
  elsewhere already covers the new id.

## Design checks (prove it in the same diff)

- **Singleton lock? Reuse the shared choreography.** If the package needs a
  singleton lock, do not re-derive the mkdir / `owner.json` / incarnation /
  quarantine dance — reuse `packages/agent-app/src/process-incarnation.ts`, the
  shared liveness primitive. Four current copies (worker lease, CLI lifecycle
  lock, managed-runtime install lock, SRT install lock) already share it and only
  duplicate the directory/rename choreography; don't add a fifth.
- **New runtime-resolution surface ⇒ a `doctor`/`validate` line.** If the package
  adds a new place mono-agent decides "which physical package/closure is this" at
  runtime (like `managed-runtime-packages.ts`'s app-vs-cwd resolution), add a
  `doctor`/`validate` detail line naming what was resolved and from where —
  otherwise the resolution is invisible when it picks the wrong one.
- **Sibling test-shape parity.** When the package has two structurally-parallel
  sub-modules, diff their `__tests__/` listings and add any missing counterpart;
  a gap there is an untested path. `operator-adapter`'s `live/` was missing the
  `config.test.ts` that `tui/` has, so `live/config.ts`'s secret-redaction path
  went untested.

  ```bash
  diff <(ls packages/<pkg>/src/tui/__tests__) <(ls packages/<pkg>/src/live/__tests__)
  ```

- **MCP stateless-HTTP cleanup ordering.** For a rung-4 MCP server/tool using
  `@modelcontextprotocol/sdk`, register the response close listener **before**
  calling `handleRequest`, not after — the SDK examples show this order and
  `agent-orchestrator` (`extras/agent-orchestrator/src/index.ts`) got it backwards:

  ```js
  res.on("close", () => { transport.close(); server.close(); });  // wire cleanup first
  await transport.handleRequest(req, res, body);
  ```

## Gotchas

- **A `demos/` dir without a `package.json` is by design** — it is a seed/template
  agent, not a workspace package, so it won't appear in the catalog and shouldn't.
  Read its own README before flagging it as dead/incomplete (`demos/final-agent`
  is the canonical example).

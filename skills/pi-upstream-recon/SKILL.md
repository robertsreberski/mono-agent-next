---
name: pi-upstream-recon
description: Investigate the vendored pi packages' real API surface (pi-ai, pi-agent-core, pi-tui) before hand-rolling anything, and run pi version bumps safely. Use before implementing anything runtime/provider/TUI-shaped, when pi behavior is surprising, or when asked to "bump pi".
---

# pi upstream recon

Standing rule: **prefer native upstream implementations.** Before hand-rolling
runtime/provider/session/compaction/TUI machinery, check whether pi already
ships it — and check the LATEST version's API, never memory of an old one.

This rule is not pi-specific — it applies to **any** provider adapter. Before
hand-rolling output-shape recovery (JSON repair, retry-on-malformed,
`parseJsonLoose`/`parseJsonExact`-style scanners) for a provider, check that
provider's native structured-output / JSON mode first. The memory package
hand-rolled `parseJsonLoose`/`parseJsonExact` in `packages/memory/src/bujo/json.ts`
instead of setting Ollama's `format: "json"` on the `/api/generate` request in
`ollama-llm.ts` — the native flag constrains the model to valid JSON at the
source, which is strictly better than repairing malformed output after the fact.

## Locate the vendored source

```bash
cd "$(git rev-parse --show-toplevel)"
PIAI=$(ls -d node_modules/.pnpm/@earendil-works+pi-ai@*/node_modules/@earendil-works/pi-ai | head -1)
grep -m1 version "$PIAI/package.json"
sed -n '1,60p' "$PIAI/dist/types.d.ts"

D=$(dirname $(find node_modules/.pnpm -name "agent-harness.d.ts" -path "*pi-agent-core*" | head -1))
grep -rn "<symbol>" "$D"
# packages also nest their own copy:
grep -rn "<symbol>" packages/agent-runtime/node_modules/@earendil-works/pi-agent-core
```

Check what upstream has published:

```bash
npm view @earendil-works/pi-agent-core versions --json --registry https://registry.npmjs.org/ | tail -8
npm view @earendil-works/pi-ai@latest version exports --registry https://registry.npmjs.org/
```

## Version pins (do not "unify" them)

- `packages/agent-runtime`: `@earendil-works/pi-ai` + `pi-agent-core` at `0.80.6`.
  This exact pair retains the runtime OAuth exports used by mono-agent;
  `pi-ai@0.80.8` turns `./oauth` into a type-only entry point.
- `packages/tui`: `@earendil-works/pi-tui` at `0.79.10` — **intentionally behind**;
  the 0.80 pi-tui API breaks the TUI. Bumping it is its own project.

## Bump procedure

1. Edit the pins in the package manifests → `pnpm install`.
2. Read the new `.d.ts` diff for the surfaces we bridge (Session, AgentHarness,
   compaction, auth, provider registration) — pi minor bumps HAVE shipped
   behavior changes: 0.79.1 had no built-in compaction (bridge drives
   `harness.compact()`); 0.80 changed Models-auth and reports provider failures
   as a terse "Connection error." during failover.
3. Targeted tests first:

```bash
pnpm --filter @mono-agent/agent-runtime test -- src/__tests__/ai/pi-native.test.js \
  src/__tests__/pi-auth.test.js src/__tests__/ai/failure.test.js \
  src/__tests__/ai/router.test.js --runInBand
```

4. Full gate (`verify-green` skill), then live smoke (`live-smoke` skill) with a
   real pi model — pi regressions are exactly the class unit tests miss.

## Vendoring & pin guards

- **License consistency across the vendoring boundary.** `agent-runtime` is
  designed to be vendored-as-source into a second host (worklab). Mono-agent's
  root and all publishable workspace packages are deliberately aligned on
  `GPL-3.0-only`; keep that alignment explicit when auditing or porting across
  the boundary. Run the repository guard, then compare the target host's
  metadata before treating a copied kernel as license-compatible:

```bash
pnpm run check:licenses
grep -H '"license"' packages/agent-runtime/package.json packages/agent-app/package.json
# both => GPL-3.0-only
```

- **A release-age policy must be explicit across supported pnpm majors.** pnpm 10
  defaults `minimumReleaseAge` to 0 while pnpm 11 defaults it to 1440. The workspace
  therefore requires pnpm 10.16 or newer and commits `minimumReleaseAge: 0` to
  disable the cooldown consistently. It carries no `minimumReleaseAgeExclude`.
  Never infer the effective default from an
  `undefined` config read. If a future change enables a positive cooldown, commit any
  narrowly justified exclusions beside it and enforce the selector's pnpm floor:
  bare package names require 10.16, `*`/leading-`!` patterns require 10.17, and
  version-specific or disjunction selectors require 10.19. Either an exact
  `packageManager` pin or an
  adequate `engines.pnpm` lower bound can enforce that floor for local installs.
  Run the repository preflight rather than trusting raw config output:

```bash
node scripts/pnpm-release-age-policy.mjs
pnpm config get minimumReleaseAge          # explicit `0` while cooldown is disabled
pnpm config get minimumReleaseAgeExclude   # `undefined` while no exclusions are claimed
```

## Reading discipline

- Trust `dist/*.d.ts` + shipped JS in `node_modules/.pnpm`, not blog-level memory.
- When behavior differs from types, read the shipped implementation:

```bash
JS=$(find node_modules/.pnpm -name "agent-harness.js" -path "*pi-agent-core*" | head -1); sed -n '1,40p' "$JS"
```

- Record any new gotcha in a memory note; pi surprises recur.

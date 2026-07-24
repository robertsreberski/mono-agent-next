---
name: pi-upstream-recon
description: Inspect the installed pi-ai, pi-agent-core, pi-coding-agent, and pi-tui APIs before implementing runtime or TUI behavior, and verify pi bumps safely.
---

# Pi upstream recon

Prefer the installed upstream implementation over a local parser, provider
driver, session layer, compaction loop, or TUI primitive. Read both shipped
types and JavaScript; do not rely on remembered APIs.

## Locate the installed packages

Install the workspace first, then inspect the exact packages selected by the
current manifests:

```bash
node -e 'for (const file of ["packages/runtime-pi/package.json","packages/tui/package.json"]) { const value = require("./" + file); console.log(file, value.dependencies); }'
pnpm --filter @mono-agent/runtime-pi exec node --input-type=module \
  -e 'import { dirname } from "node:path"; import { fileURLToPath } from "node:url"; for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"]) console.log(name, dirname(fileURLToPath(import.meta.resolve(name))))'
pnpm --filter @mono-agent/tui exec node --input-type=module \
  -e 'import { dirname } from "node:path"; import { fileURLToPath } from "node:url"; const name = "@earendil-works/pi-tui"; console.log(name, dirname(fileURLToPath(import.meta.resolve(name))))'
```

Each command resolves from the owning workspace package, so the printed `dist`
directory belongs to its direct dependency rather than another transitive
version in pnpm's store. Run `rg` against those exact printed directories for
the symbol or behavior before designing a wrapper. When types and behavior
differ, the shipped JavaScript is the deciding runtime evidence.

## Check an available version only when bumping

```bash
npm view @earendil-works/pi-ai@latest version exports --registry https://registry.npmjs.org/
npm view @earendil-works/pi-agent-core@latest version exports --registry https://registry.npmjs.org/
npm view @earendil-works/pi-coding-agent@latest version exports --registry https://registry.npmjs.org/
npm view @earendil-works/pi-tui@latest version exports --registry https://registry.npmjs.org/
```

Do not unify runtime and TUI versions by assumption. Each manifest owns its
pin, and a bump must justify every changed export or behavior the corresponding
package bridges.

## Bump procedure

1. Change only the relevant dependency pins and refresh `pnpm-lock.yaml`.
2. Diff the old and new declarations/implementations for provider registration,
   authentication, sessions, compaction, tools, cancellation, and rendering
   surfaces used by the changed package.
3. Run the focused package lanes:

```bash
pnpm --filter @mono-agent/runtime-pi... run build
pnpm --filter @mono-agent/runtime-pi run test
pnpm --filter @mono-agent/runtime-pi run typecheck

pnpm --filter @mono-agent/tui... run build
pnpm --filter @mono-agent/tui run test
pnpm --filter @mono-agent/tui run typecheck
```

Run only the lane that changed. Then use `verify-green` and one matching
`live-smoke` scenario. A source-only bump never authorizes publication,
deployment, restart, or consumer adoption.

## Record the decision

In the PR evidence, name the exact installed versions, declarations and
implementation files inspected, the upstream primitive reused or the reason it
did not satisfy the contract, and the focused/live proof.

---
title: "Source-beta complexity report"
description: "Reproducible production, test, tooling, package, dependency, public-API, and scaffold-closure measurements for mono-agent v1."
sidebar:
  order: 10
---

This report is generated from the current source tree. It counts reportable
source files returned by Git (`--cached --others --exclude-standard`), so a
clean checkout and a pre-commit worktree produce the same result for the same
files. Generated documentation outputs are excluded from their own input.

Reproduce it with:

```bash
pnpm run report:source-beta
pnpm run generate:source-beta-docs
```

Source manifest digest: `edb838379ab2467a93eefed4433d82fceb0002a4633bd3e7220dfd2e2de595b3`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 191 | 75374 |
| Tests | 130 | 58365 |
| Repository and product tooling | 62 | 22463 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **383** | **156202** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 394.6 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 75374 | 130000 | within limit |
| kernel-production | 14974 | 15000 | within limit |

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 14 | 12164 | 4264 |
| `@mono-agent/core` | 18 | 11906 | 14133 |
| `@mono-agent/runtime-pi` | 15 | 7842 | 4188 |
| `@mono-agent/memory-local` | 11 | 5021 | 2507 |
| `create-mono-agent` | 7 | 3505 | 1289 |
| `@mono-agent/service-macos` | 13 | 3153 | 1196 |
| `@mono-agent/channel-webhook` | 5 | 2658 | 1366 |
| `@mono-agent/channel-slack` | 8 | 2649 | 1199 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 21 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 933 |
| Distinct scaffold config paths | 104 |

The first-party package graph is acyclic.

## Scaffold closure

| Template | Direct production dependencies | Selected modules |
| --- | ---: | ---: |
| `minimal` | 5 | 2 |
| `personal` | 12 | 9 |
| `multi-runtime` | 6 | 3 |

The generated [config reference](/config/reference/) records the exact package
names and seed configuration for each template. The packed system verification
installs all three closures and executes their first-turn fixtures.

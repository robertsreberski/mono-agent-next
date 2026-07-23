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

Source manifest digest: `bf4325978f228d53e39fdef7b62ccb223a0ef1675ddcee717db58131ca150192`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 159 | 53789 |
| Tests | 108 | 39822 |
| Repository and product tooling | 60 | 19636 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **327** | **113247** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 338.3 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 53789 | 130000 | within limit |
| kernel-production | 19610 | 15000 | over limit |

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/core` | 18 | 15790 | 11427 |
| `@mono-agent/runtime-pi` | 11 | 5539 | 2853 |
| `@mono-agent/state-local` | 8 | 4483 | 1565 |
| `@mono-agent/module-sdk` | 5 | 3360 | 1349 |
| `@mono-agent/runtime-opencode` | 7 | 2398 | 1097 |
| `@mono-agent/runtime-codex` | 6 | 2341 | 1451 |
| `@mono-agent/operator` | 9 | 2003 | 660 |
| `@mono-agent/channel-webhook` | 4 | 1628 | 506 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 21 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 847 |
| Distinct scaffold config paths | 84 |

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

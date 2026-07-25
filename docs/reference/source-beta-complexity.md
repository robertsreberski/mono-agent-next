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

Source manifest digest: `ddc6bda9e7f732250c4466ad47d06924aba856fbb30c9e991829a9f3ecd7ceca`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 290 | 93889 |
| Tests | 144 | 72121 |
| Repository and product tooling | 52 | 18208 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **486** | **184218** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 323.8 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 93889 | 130000 | within limit |
| kernel-production | 15390 | 15500 | within limit |

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 27 | 14300 | 5459 |
| `@mono-agent/core` | 18 | 12130 | 16840 |
| `@mono-agent/runtime-pi` | 28 | 8501 | 4796 |
| `@mono-agent/memory-local` | 19 | 7721 | 4133 |
| `@mono-agent/web` | 28 | 7147 | 2341 |
| `@mono-agent/service-macos` | 22 | 5749 | 2130 |
| `create-mono-agent` | 11 | 4466 | 1648 |
| `@mono-agent/channel-slack` | 15 | 3747 | 2189 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 22 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 990 |
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

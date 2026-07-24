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

Source manifest digest: `a0fef5cb2887942539243f6e1af8d86ba5a85160a4a028f62be0f07e1bebc7cd`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 229 | 87920 |
| Tests | 140 | 71226 |
| Repository and product tooling | 63 | 22966 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **432** | **182112** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 383.9 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 87920 | 130000 | within limit |
| kernel-production | 15368 | 15500 | within limit |

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 15 | 12475 | 4558 |
| `@mono-agent/core` | 18 | 12130 | 16840 |
| `@mono-agent/runtime-pi` | 15 | 7921 | 4473 |
| `@mono-agent/memory-local` | 14 | 7529 | 3932 |
| `@mono-agent/web` | 28 | 7132 | 2202 |
| `@mono-agent/service-macos` | 14 | 4336 | 1851 |
| `@mono-agent/channel-slack` | 15 | 3747 | 2189 |
| `create-mono-agent` | 7 | 3505 | 1289 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 22 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 989 |
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

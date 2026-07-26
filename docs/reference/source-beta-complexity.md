---
title: "Source-beta complexity report"
description: "Reproducible production, test, tooling, package, dependency, public-API, and scaffold-closure measurements for mono-agent."
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

Source manifest digest: `06759c537eb3db4e37eb4842d3db7ed38c77e0263110c2a55ee927a1ca866065`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 317 | 100461 |
| Tests | 167 | 80467 |
| Repository and product tooling | 56 | 18852 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **540** | **199780** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 316.9 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 100461 | 130000 | within limit |
| kernel-production | 16229 | 16500 | within limit |
| durable-protocol-production | 7626 | 9500 | within limit |

One budget binds from below rather than above. Test source may not fall under a
fixed multiple of production source, so a change cannot be made to fit by
deleting the test that objects to it.

| Floor | Actual | Minimum | Result |
| --- | ---: | ---: | --- |
| test source, at 0.75 of production | 80467 | 75346 | within limit |

The current ratio is 0.801.

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 27 | 14355 | 5466 |
| `@mono-agent/core` | 39 | 12902 | 18232 |
| `@mono-agent/web` | 31 | 8992 | 4666 |
| `@mono-agent/runtime-pi` | 28 | 8865 | 4978 |
| `@mono-agent/memory-local` | 19 | 8097 | 4767 |
| `@mono-agent/service-macos` | 22 | 5770 | 2131 |
| `create-mono-agent` | 12 | 5487 | 2199 |
| `@mono-agent/channel-slack` | 17 | 5148 | 3123 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 22 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 993 |
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

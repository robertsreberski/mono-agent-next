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

Source manifest digest: `0886d8252ada3ceadc84052693f259660d846549da4f8c7bbda22991623f8a70`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 326 | 103780 |
| Tests | 174 | 89462 |
| Repository and product tooling | 56 | 19463 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **556** | **212705** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 318.3 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 103780 | 130000 | within limit |
| kernel-production | 16477 | 16500 | within limit |
| durable-protocol-production | 7626 | 9500 | within limit |

One budget binds from below rather than above. Test source may not fall under a
fixed multiple of production source, so a change cannot be made to fit by
deleting the test that objects to it.

| Floor | Actual | Minimum | Result |
| --- | ---: | ---: | --- |
| test source, at 0.75 of production | 89462 | 77835 | within limit |

The current ratio is 0.862.

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 27 | 14355 | 7410 |
| `@mono-agent/core` | 39 | 12955 | 18559 |
| `@mono-agent/runtime-pi` | 31 | 9864 | 6204 |
| `@mono-agent/web` | 31 | 8992 | 4666 |
| `@mono-agent/memory-local` | 19 | 8097 | 4767 |
| `@mono-agent/service-macos` | 22 | 5770 | 2131 |
| `create-mono-agent` | 12 | 5486 | 2199 |
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
| Public named exports | 1011 |
| Distinct scaffold config paths | 103 |

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

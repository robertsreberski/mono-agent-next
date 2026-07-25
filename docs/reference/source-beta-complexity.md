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

Source manifest digest: `9e03724156e045c9c3a8444a985741f614235a5baa838fd1ed2c0ffcb9c58fff`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 311 | 95283 |
| Tests | 156 | 74592 |
| Repository and product tooling | 55 | 18662 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **522** | **188537** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 306.4 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 95283 | 130000 | within limit |
| kernel-production | 16160 | 16500 | within limit |
| durable-protocol-production | 7626 | 9500 | within limit |

One budget binds from below rather than above. Test source may not fall under a
fixed multiple of production source, so a change cannot be made to fit by
deleting the test that objects to it.

| Floor | Actual | Minimum | Result |
| --- | ---: | ---: | --- |
| test source, at 0.75 of production | 74592 | 71463 | within limit |

The current ratio is 0.783.

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 27 | 14355 | 5466 |
| `@mono-agent/core` | 39 | 12895 | 18189 |
| `@mono-agent/runtime-pi` | 28 | 8858 | 4978 |
| `@mono-agent/memory-local` | 19 | 7734 | 4140 |
| `@mono-agent/web` | 28 | 7169 | 2488 |
| `@mono-agent/service-macos` | 22 | 5770 | 2131 |
| `create-mono-agent` | 11 | 4477 | 1651 |
| `@mono-agent/channel-slack` | 15 | 3762 | 2191 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 22 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 992 |
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

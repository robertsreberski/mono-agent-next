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

Source manifest digest: `dd443b19ba4de1ef2ebb58c85ff0f0be9fb21847cc8694ff0a183d896fbb7767`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 206 | 82150 |
| Tests | 137 | 62941 |
| Repository and product tooling | 65 | 28008 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **408** | **173099** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 398.8 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 82150 | 130000 | within limit |
| kernel-production | 15023 | 15000 | over limit |

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 14 | 12164 | 4264 |
| `@mono-agent/core` | 19 | 12036 | 16010 |
| `@mono-agent/runtime-pi` | 15 | 7842 | 4319 |
| `@mono-agent/memory-local` | 14 | 7154 | 3374 |
| `@mono-agent/web` | 20 | 5409 | 1994 |
| `@mono-agent/service-macos` | 14 | 4336 | 1851 |
| `create-mono-agent` | 7 | 3505 | 1289 |
| `@mono-agent/channel-webhook` | 5 | 2659 | 1368 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 22 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 981 |
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

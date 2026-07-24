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

Source manifest digest: `acb3c522962c8639c074bb973e5992fb2dd04bf55dfdd0499a9dd142dbf0e7b8`

## Lines of code

| Classification | Files | Physical lines |
| --- | ---: | ---: |
| Production | 206 | 83114 |
| Tests | 138 | 64855 |
| Repository and product tooling | 63 | 22986 |
| Checked-in generated source | 0 | 0 |
| **Total executable source** | **407** | **170955** |

Blank lines and comments count as physical source lines. Markdown, JSON,
lockfiles, vendored dependencies, build output, and generated documentation do
not. Production means shipped package or website source; tests and authoring
tooling are reported separately and never reduce the production budget.

Average production file size is 403.5 lines.

## Binding budgets

| Budget | Actual | Maximum | Result |
| --- | ---: | ---: | --- |
| repository-production | 83114 | 130000 | within limit |
| kernel-production | 15277 | 15500 | within limit |

## Largest package ownership surfaces

| Package | Production files | Production lines | Test lines |
| --- | ---: | ---: | ---: |
| `@mono-agent/state-local` | 15 | 12475 | 4558 |
| `@mono-agent/core` | 18 | 12078 | 16769 |
| `@mono-agent/runtime-pi` | 15 | 7866 | 4429 |
| `@mono-agent/memory-local` | 14 | 7529 | 3932 |
| `@mono-agent/web` | 20 | 5409 | 1994 |
| `@mono-agent/service-macos` | 14 | 4336 | 1851 |
| `create-mono-agent` | 7 | 3505 | 1289 |
| `@mono-agent/module-sdk` | 5 | 2811 | 1633 |

The complete package table is retained in the generated report model exposed by
`pnpm --silent run report:source-beta -- --json`.

## Structural complexity

| Measure | Current value |
| --- | ---: |
| Publishable packages | 23 |
| First-party dependency edges | 22 |
| First-party dependency cycles | 0 |
| Public code entrypoints | 28 |
| Public named exports | 988 |
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

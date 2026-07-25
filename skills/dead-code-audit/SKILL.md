---
name: dead-code-audit
description: Prove-or-remove protocol for dead exports, orphaned wiring, and deprecated surfaces across the whole monorepo. Use for pre-freeze cleanup, post-refactor sweeps, deciding whether a deprecated surface is removable, or when asking "is this dead code?".
---

# Dead code audit

Tests prove behavior, not reachability. Before removing a symbol or helper,
prove its callers across the whole workspace and distinguish tests, generated
artifacts, documentation, and public contracts from live execution.

## 1. Establish the owned surface

Start at the repository root and identify the exact definition, exports, package
manifest, and binary entry points:

```bash
cd "$(git rev-parse --show-toplevel)"
rg -n '<symbol-or-file>' packages extras scripts .github package.json
rg -n '"bin"|"exports"' packages/*/package.json extras/*/package.json
```

An exported symbol or declared binary has a higher removal bar than an
unexported helper. Do not infer that package presence activates a capability.

## 2. Separate live callers from evidence-only references

Search source, scripts, and workflow wiring first:

```bash
rg -n '<symbol-or-file>' \
  packages/*/src extras/*/src scripts .github package.json \
  --glob '!**/__tests__/**' --glob '!**/*.test.*'
```

Then classify test and documentation references separately:

```bash
rg -n '<symbol-or-file>' \
  packages extras scripts docs README.md CONTRIBUTING.md AGENTS.md agents skills
```

A helper referenced only by its own tests is still a removal candidate. A
generated document or historical negative assertion is evidence to classify,
not a runtime caller.

## 3. Check lifecycle wiring

Maintenance functions such as `compact*`, `prune*`, `rotate*`, and `gc*` need a
non-test lifecycle call site. Shared, pooled, or cached replacements require an
explicit search for the mechanism they supersede:

```bash
rg -n 'function (compact|prune|rotate|gc)|const (compact|prune|rotate|gc)' \
  packages/*/src extras/*/src
rg -n '<old-mechanism>' packages/*/src extras/*/src \
  --glob '!**/__tests__/**' --glob '!**/*.test.*'
```

Wire an intended routine into the owning lifecycle or remove it; do not keep a
tested no-op surface.

## 4. Check configured usage only when supplied

If the task explicitly provides a fixture or consumer directory, inspect only
that exact path read-only. Do not discover consumer roots from a home directory
and do not mutate configured state:

```bash
rg -n '<symbol-or-file>' <exact-authorized-consumer-path>
```

Consumer compatibility outside the supplied scope is a separate decision.

## 5. Remove the complete orphan

When the evidence shows no live caller:

- remove the definition, export, wrapper, and tests that exist only for it;
- retain tests for shared code that still has live callers;
- update scripts, workflows, docs, and generated inventories that named it;
- preserve intentional negative assertions that prevent retired surfaces from
  returning.

Run the smallest relevant focused tests plus the architecture and documentation
gates selected by `verify-green`.

## Verdict

Record the exact search command and classify every hit. The valid outcomes are:

- **keep** — a live caller or current public contract requires it;
- **remove** — no live caller or retained contract remains;
- **follow-up** — removal needs an explicitly separate compatibility decision.

Never use test coverage alone as reachability proof.

# Contributing to mono-agent

## Before changing code

1. Read the root `AGENTS.md`, the affected package README, and any package-local instructions.
2. Use an isolated worktree and a feature branch. Never develop directly in the live `main` checkout.
3. Find the owning package in [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`PACKAGES.md`](./PACKAGES.md).
4. Keep the change typed, focused, and covered by behavior tests.

The workspace uses pnpm and requires Node.js 22.19.0 or newer:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Common commands

Run focused package commands while iterating:

```bash
pnpm --filter @mono-agent/core run typecheck
pnpm --filter @mono-agent/core run test
pnpm --filter @mono-agent/core run build
```

Replace the filter with the package that owns the change. Before opening a PR, run the risk-based lane documented in `skills/verify-green/SKILL.md`; `pnpm run verify:all` is the repository-wide verdict.

Useful repository checks:

```bash
pnpm run check:architecture
pnpm run check:licenses
pnpm run check:source-beta-budgets
pnpm run check:docs
pnpm run check:consumer-docs-consistency
pnpm run check:codex-discoverability
```

## Generated documentation

Run only the generator for the surface you changed:

```bash
pnpm run generate:package-docs
pnpm run generate:public-api-docs
pnpm run generate:source-beta-docs
```

Generated regions are marked in their files. Edit the catalog, exports, or config metadata that owns the content; do not patch the generated inventory by hand.

## Inspecting leftovers from an older checkout

A checkout that previously contained the retired v0 packages may still have
ignored `dist`, `types`, or `node_modules` directories under their old names.
They are not part of a fresh clone and do not need a repository cleanup script.
Inspect exactly those ignored paths without deleting anything:

```bash
git clean -ndX -- \
  packages/agent-app \
  packages/agent-contracts \
  packages/agent-harness \
  packages/agent-runtime \
  packages/config \
  packages/cron-adapter \
  packages/memory \
  packages/observability \
  packages/openai-api-adapter \
  packages/operator-adapter \
  packages/runtime-adapter \
  packages/slack-adapter \
  packages/telegram-adapter \
  packages/webhook-adapter \
  extras/a2a-adapter \
  extras/agent-orchestrator \
  extras/memory-supermemory \
  extras/whatsapp-adapter
```

The command is dry-run only. Review the output and preserve any local data; this
repository never auto-deletes ignored or untracked directories.

## Contribution licensing

Only submit material that you have the right and authority to contribute. By
intentionally submitting a contribution, you agree that it is licensed under
the repository's [MIT License](./LICENSE).

The root and every publishable package carry the same MIT license text. Keep
package manifests and `LICENSE` copies aligned, and use
`SPDX-License-Identifier: MIT` on source files covered by the SPDX gate.

## Pull requests

- All tracked changes land through a PR.
- Explain the behavior change, package boundary, verification, and any accepted risk.
- Give every review finding a disposition: fixed, follow-up issue, or rejected with a reason.
- Do not release, publish, deploy, or restart consumers unless the request explicitly includes that step.
- Never commit `.env` files, provider credentials, tokens, generated auth stores, or local `.mono-agent` state.

Security reports and the local-secret cleanup checklist are in [`SECURITY.md`](./SECURITY.md).

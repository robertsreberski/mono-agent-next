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

## Contribution licensing

Only submit material that you have the right and authority to contribute. By
intentionally submitting a contribution, you agree that it is licensed under
the license declared by the affected package or file.

Contributions to `packages/module-sdk` and `packages/operator` are submitted
under the Apache License 2.0, including its copyright and patent grants. You
represent that you are authorized to make those grants. Contributions to other
surfaces remain under their declared licenses unless the affected file
explicitly states otherwise.

## Pull requests

- All tracked changes land through a PR.
- Explain the behavior change, package boundary, verification, and any accepted risk.
- Give every review finding a disposition: fixed, follow-up issue, or rejected with a reason.
- Do not release, publish, deploy, or restart consumers unless the request explicitly includes that step.
- Never commit `.env` files, provider credentials, tokens, generated auth stores, or local `.mono-agent` state.

Security reports and the local-secret cleanup checklist are in [`SECURITY.md`](./SECURITY.md).

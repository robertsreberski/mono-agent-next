---
title: "Install & Prerequisites"
description: "Install and verify the public mono-agent source workspace without publishing packages or touching live consumers."
sidebar:
  order: 1
---

This page installs the public source workspace. Consumer installation from npm
is intentionally deferred until a separately authorized release phase.
Existing registry artifacts under the same package names belong to the
predecessor repository, not this source; do not install or execute them.

## Prerequisites

| Requirement | Minimum | Notes |
| --- | --- | --- |
| Node.js | 22.19.0 | Required by every package. |
| pnpm | 10.16.0 | The workspace pins pnpm 10.28.2 in `package.json`. |
| Git | Current | Required to clone `mono-agent-next`. |
| macOS | Optional | Required only for `@mono-agent/service-macos`; the foreground host and most modules are cross-platform Node.js packages. |

Provider credentials are not required for the hermetic packed minimal proof. A
real agent later needs the native authentication expected by its selected
runtime. Telegram, Slack, webhook, OpenAI-compatible API, operator, exporter,
and web secrets are required only when those surfaces are selected or started.

## Clone and install

```bash
git clone https://github.com/robertsreberski/mono-agent-next.git
cd mono-agent-next
corepack enable
pnpm install --frozen-lockfile
```

The install is a workspace operation. Do not substitute a generated agent
project yet: its manifest intentionally names release versions that are not
available until publication.

## Build and test

```bash
pnpm build
pnpm typecheck
pnpm test
```

For the smallest real package-boundary proof:

```bash
pnpm run verify:minimal
```

For the separate terminal and browser operator products:

```bash
pnpm run verify:operator-products
```

These scripts use temporary directories and local packed artifacts. They do not
publish packages, use production credentials, or mutate a live consumer.

## Inspect the built executables

Use the built files directly in this source worktree so an older globally
installed command cannot shadow them:

```bash
node packages/cli/dist/bin/mono-agent.js --help
node packages/create-mono-agent/dist/bin/create-mono-agent.js --help
node packages/tui/dist/bin/mono-agent-tui.js --help
```

The agent CLI exposes only validation, inspection, config authoring, module
commands, and foreground start. TUI, web, and macOS service management have
separate executables and lifecycles.

## Render a project without installing it

After `pnpm build`, the source scaffolder can render any closed template:

```bash
SCAFFOLD_PARENT="$(mktemp -d)"
SCAFFOLD_PARENT="$(cd "$SCAFFOLD_PARENT" && pwd -P)"
node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  "$SCAFFOLD_PARENT/mono-agent-minimal" \
  --template minimal

node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  "$SCAFFOLD_PARENT/mono-agent-multi" \
  --template multi-runtime
```

Accepted templates are `minimal`, `personal`, and `multi-runtime`; `minimal` is
the default. The target must be absent or an existing empty real directory;
symlinks, non-directories, and non-empty targets fail closed. Installation
never runs unless `--install` is explicit, so omit that flag during the
source-only preview.

Publication is protected by a fsynced append-only journal. If a process exits
while temporarily parking an existing empty target, the next invocation
restores or reconciles only the journaled device and inode identities. Safe
artifacts that could not be removed are listed in the JSON result's
`retainedRecoveryPaths` array for manual inspection.

Every template writes:

```text
.env.example
.gitignore
.mono-agent/mono-agent.config.schema.json
AGENTS.md
README.md
mono-agent.config.json
package.json
```

The Personal template additionally writes `.mcp.json`, `cron/.gitkeep`, and
`skills/.gitkeep`. No template writes `.env`, a credential file, a lockfile, or
`node_modules`; a lockfile is created only by a later explicit package-manager
install.

## Secret boundary

Mono-agent does not implicitly load `.env` or `.env.example`. Export variables
in the process environment or inject them through the eventual service product.
Config contains only explicit references:

```json
{
  "apiKey": { "$env": "WEBHOOK_API_KEY" }
}
```

Core resolves a reference only when the owning module schema marks that path as
environment-eligible. Secret-marked paths reject inline values, missing or empty
variables fail validation, and diagnostic/provenance output redacts resolved
values. Keep provider-native credential stores owner-private as required by the
selected runtime.

## Consumer installation is a later phase

This source rebuild exposes no supported registry installation path. A future
release procedure must first pack the exact candidate, verify package contents
and identities, publish under reviewed authority, and prove a clean registry
install. Only then should this page document registry-backed scaffolding or
adding packages to a real agent project.

Continue with the [first-agent proof](/getting-started/quickstart/).

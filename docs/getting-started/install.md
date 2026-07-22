---
title: "Install & Prerequisites"
description: "Install and verify the private mono-agent v1 source workspace without publishing packages or touching live consumers."
sidebar:
  order: 1
---

This page installs the private source workspace. Consumer installation from npm
is intentionally deferred until a separately authorized release phase.

## Prerequisites

| Requirement | Minimum | Notes |
| --- | --- | --- |
| Node.js | 22.19.0 | Required by every v1 package. |
| pnpm | 10.16.0 | The workspace pins pnpm 10.28.2 in `package.json`. |
| Git and private repository access | Current | Required to clone `mono-agent-next`. |
| macOS | Optional | Required only for `@mono-agent/service-macos`; the foreground host and most modules are cross-platform Node.js packages. |

Provider credentials are not required for the hermetic packed minimal proof. A
real agent later needs the native authentication expected by its selected
runtime. Telegram, Slack, webhook, OpenAI-compatible API, operator, exporter,
and web secrets are required only when those surfaces are selected or started.

## Clone and install

```bash
git clone git@github.com:robertsreberski/mono-agent-next.git
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
pnpm run verify:v1-minimal
```

For the separate terminal and browser operator products:

```bash
pnpm run verify:v1-operator-products
```

These scripts use temporary directories and local packed artifacts. They do not
publish packages, use production credentials, or mutate a live consumer.

## Inspect the built executables

Use the built files directly in this private worktree so an older globally
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

After `pnpm build`, the private source scaffolder can render any closed template:

```bash
node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  /tmp/mono-agent-minimal \
  --template minimal

node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  /tmp/mono-agent-multi \
  --template multi-runtime
```

Accepted templates are `minimal`, `personal`, and `multi-runtime`; `minimal` is
the default. The target must not already exist. Installation never runs unless
`--install` is explicit, so omit that flag during the private source phase.

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

The intended post-release consumer commands are exposed by
`create-mono-agent` and `@mono-agent/cli`, but this private rebuild does not
publish them. A future release procedure must first pack the exact candidate,
verify package contents and identities, publish under reviewed authority, and
prove a clean registry install. Only then should users run registry-backed
scaffolding or add v1 packages to a real agent project.

Continue with the [first-agent proof](/getting-started/quickstart/).

# mono-agent

Mono-agent is a config-first framework for building one agent from one strict,
reviewable `mono-agent.config.json`. Runtimes, channels, memory, state, triggers,
exporters, and sandboxing are explicit typed selections; installing a package
never activates it. `@mono-agent/core` validates the selected package identity,
lockfile evidence, schema, and cross-module references before startup.

The result is intentionally inspectable: every capability traces to config,
every implementation has one narrow package boundary, and runtime or provider
failures stay visible.

## Source quickstart

The public preview is source-only. The v1 packages are not published to npm yet.
Existing registry artifacts under the same package names belong to the
predecessor repository, not this v1 source; do not install or execute them.
Clone and build this workspace instead.

Prerequisites are Node.js 22.19.0 or newer and pnpm 10.16.0 or newer. The
workspace pins pnpm 10.28.2.

```bash
git clone https://github.com/robertsreberski/mono-agent-next.git
cd mono-agent-next
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Render a minimal agent folder directly from the built source:

```bash
SCAFFOLD_PARENT="$(mktemp -d)"
SCAFFOLD_PARENT="$(cd "$SCAFFOLD_PARENT" && pwd -P)"
node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  "$SCAFFOLD_PARENT/mono-agent-example" \
  --template minimal
```

The rendered project is ready to inspect, but its release-version dependencies
cannot be installed from npm during the source preview. Run the hermetic packed
proof to build those packages, install them into a temporary clean consumer,
start an authenticated loopback webhook, complete one deterministic turn, and
prove graceful shutdown:

```bash
pnpm run verify:v1-minimal
```

For contributor checks and the other bounded proofs:

```bash
pnpm typecheck
pnpm test
pnpm run verify:v1-operator-products
pnpm run verify:v1-system
```

`verify:v1-system` requires a clean committed checkout. It clones that exact SHA
into an owner-private temporary workspace, packs all 23 packages, installs the
three scaffold closures from those exact artifacts, and emits machine-readable
digest evidence. None of these commands publishes a package or touches a live
consumer.

## Architecture

The v1 roster contains exactly 23 publishable packages: 22 under `packages/`
and the paired `@mono-agent/docs-mcp` companion under `extras/`.

| Layer | Packages |
| --- | --- |
| Contracts and host | `@mono-agent/module-sdk`, `@mono-agent/core` |
| Runtime modules | `@mono-agent/runtime-pi`, `@mono-agent/runtime-claude`, `@mono-agent/runtime-codex`, `@mono-agent/runtime-opencode` |
| Channel modules | `@mono-agent/channel-telegram`, `@mono-agent/channel-slack`, `@mono-agent/channel-webhook`, `@mono-agent/channel-openai-api`, `@mono-agent/channel-operator` |
| Durable and execution modules | `@mono-agent/trigger-cron`, `@mono-agent/memory-local`, `@mono-agent/state-local`, `@mono-agent/exporter-otlp`, `@mono-agent/sandbox-srt` |
| Operator products | `@mono-agent/operator`, `@mono-agent/tui`, `@mono-agent/web` |
| Applications and companion | `@mono-agent/cli`, `create-mono-agent`, `@mono-agent/service-macos`, `@mono-agent/docs-mcp` |

The execution path is deliberately narrow:

```text
mono-agent.config.json + package.json + lockfile
  -> @mono-agent/core
  -> selected runtime, channel, memory, state, trigger, exporter, and sandbox modules
  -> normalized turns, explicit delivery, bounded lifecycle, and health

running agent + selected @mono-agent/channel-operator
  -> authenticated shared operator protocol
  -> standalone @mono-agent/tui or @mono-agent/web product
```

See the [maintainer architecture map](./ARCHITECTURE.md) for every package and
dependency boundary, or the [v1 architecture decision](./docs/reference/v1-architecture.md)
for the canonical reader-facing contract.

## Strict configuration

Every module selection uses a literal bare npm package name:

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "minimal-example",
    "name": "Minimal Example",
    "instructions": "./AGENTS.md",
    "workspace": "."
  },
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": { "path": "./.secrets/pi/auth.json" }
    }
  },
  "routing": {
    "primary": { "runtime": "pi", "model": "openai-codex:gpt-5.6-sol" },
    "fallbacks": [],
    "effort": "high"
  },
  "channels": {
    "inbound": {
      "$use": "@mono-agent/channel-webhook",
      "listen": { "host": "127.0.0.1", "port": 3210 },
      "apiKey": { "$env": "WEBHOOK_API_KEY" }
    }
  },
  "policy": {
    "tools": { "default": "deny", "allow": [] },
    "approvals": { "default": "ask" },
    "sandbox": { "mode": "off" }
  }
}
```

Selection is not discovery. Each `$use` package must be a direct production
dependency of the agent project, be present in the root importer of its npm or
pnpm lockfile, resolve inside its installed package root, and expose matching
v1 metadata. Core rejects unknown envelope fields, mismatched kinds or versions,
unsafe dependency specifications, unresolved cross-module references, and
invalid module options. Secret fields require an explicit `{"$env":"NAME"}`
reference; mono-agent does not implicitly load `.env` files.

## Scaffolding

`create-mono-agent` renders three deterministic templates and defaults to
`minimal`:

| Template | Selected stack |
| --- | --- |
| `minimal` | Pi runtime plus authenticated loopback webhook; exact five-package agent closure. |
| `personal` | Pi; Telegram, webhook, OpenAI-compatible API, and operator channels; local memory/state; cron; OTLP. TUI and web remain separate products. |
| `multi-runtime` | Pi primary, native Claude SDK fallback, and loopback webhook. |

After building this source tree, render a template without installing
unreleased dependencies:

```bash
SCAFFOLD_PARENT="$(mktemp -d)"
SCAFFOLD_PARENT="$(cd "$SCAFFOLD_PARENT" && pwd -P)"
node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  "$SCAFFOLD_PARENT/mono-agent-example" \
  --template minimal
```

The scaffolder does not run package installation unless `--install` is supplied,
does not overwrite an existing target, and never writes credential values.
Registry installation remains part of the later release phase.

## CLI contract

The v1 CLI is a thin foreground frontend over `@mono-agent/core`. A config path
is always explicit.

```bash
node packages/cli/dist/bin/mono-agent.js validate --config ./mono-agent.config.json [--json]
node packages/cli/dist/bin/mono-agent.js inspect --config ./mono-agent.config.json [--json]
node packages/cli/dist/bin/mono-agent.js config schema --config ./mono-agent.config.json [--write]
node packages/cli/dist/bin/mono-agent.js config explain --config ./mono-agent.config.json [path] [--json]
node packages/cli/dist/bin/mono-agent.js module command --config ./mono-agent.config.json \
  --module <instance-id> --name <command> [--input-json '<json>']
node packages/cli/dist/bin/mono-agent.js start --config ./mono-agent.config.json
```

`start` stays in the foreground, prints one JSON `started` event, and drains then
stops on `SIGINT` or `SIGTERM`. Background service ownership belongs to the
separate `@mono-agent/service-macos` product.

## Operator products

An agent exposes operator access only when it selects
`@mono-agent/channel-operator`. That channel serves one authenticated loopback
endpoint. `@mono-agent/operator` owns the shared protocol, strict client,
owner-private discovery, reducer, and action rules.

`@mono-agent/tui` and `@mono-agent/web` are separate processes that connect over
that protocol. They are never embedded by agent config. The TUI owns terminal
rendering only; closing it does not stop the agent. Web has its own
`web.config.json`, authentication, listener, and owner-private durable
conversation store.

When local-state discovery is configured, core publishes the started operator
endpoint, public token-environment name, process identity, and capabilities into
the owner-private state presence record. Operator products consume that record
through the shared directory; no secret value is written to discovery.

## Security and durability

- Secret-bearing module fields accept explicit environment references only and
  are redacted from explanation and validation errors.
- Operator access is authenticated and loopback-only. Remote exporter traffic
  requires HTTPS; HTTP is accepted only for literal loopback endpoints.
- Local state, memory, discovery, and web data use owner-private paths. Unsafe
  owners, modes, links, path swaps, corrupt data, and unknown formats fail closed
  rather than being repaired or overwritten.
- `@mono-agent/state-local` uses atomic commits, compare-and-swap versions,
  deterministic cursors, and an exclusive writer lease. `@mono-agent/memory-local`
  separately owns its SQLite memory lifecycle.
- `@mono-agent/sandbox-srt` executes only through an explicitly selected,
  fingerprinted Sandbox Runtime Tool boundary and has no unsafe host fallback.
- Queues, request bodies, streams, retries, lifecycle waits, and shutdown are
  bounded. Provider and delivery failures remain visible.

Security reporting and repository-wide policy live in [SECURITY.md](./SECURITY.md).

## Documentation

- [Getting started](./docs/getting-started/index.md)
- [Core concepts](./docs/getting-started/concepts.md)
- [Exact v1 architecture](./docs/reference/v1-architecture.md)
- [Generated package directory](./PACKAGES.md)
- [Generated config reference](./docs/config/reference.md)
- [Generated public API inventory](./docs/reference/public-api.md)
- [Generated source-beta complexity report](./docs/reference/source-beta-complexity.md)
- [Contribution guide](./CONTRIBUTING.md)

## Contributing and license

Contributions are welcome. Read the [contribution guide](./CONTRIBUTING.md) and
follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Mono-agent and all 23
publishable packages are available under the [MIT License](./LICENSE).

## Phase boundary

The current milestone ends at a buildable, tested, runnable public source tree
with clean packed proofs. Public visibility and hosted CI do not authorize
registry publication, live installation, service mutation, data adoption, or
consumer cutover. Those operations remain a later, explicitly authorized phase.

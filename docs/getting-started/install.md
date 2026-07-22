---
title: "Install & Prerequisites"
description: "Install the mono-agent CLI, confirm runtime prerequisites, or run an unreleased build from source."
sidebar:
  order: 1
---

This page covers how to install the `mono-agent` CLI (including the terminal and browser operator consoles), the runtime prerequisites you need, and how to run an unreleased build straight from a clone of the repo.

The shipped command line lives in `@mono-agent/agent-app` (the config-first host that reads one `mono-agent.config.json`), the terminal console lives in `@mono-agent/tui`, and the always-on browser console lives in `@mono-agent/web`. All publish under the `@mono-agent/*` scope on npm. For convenience there is also an unscoped **`create-mono-agent`** installer: run it with `npm create mono-agent@latest`, and a global install of it puts the natural `mono-agent` command on your `PATH`. Its bins just delegate to `@mono-agent/agent-app`.

:::note
The bare `mono-agent` npm name isn't ours — npm rejects it as too similar to an unrelated `monoagent` package — so the installer follows npm's `create-*` convention (`create-mono-agent`), which `npm create mono-agent` resolves natively.
:::

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `>=22.19.0` | Runtime for the CLI, host, and TUI. This matches the minimum required by the bundled Pi runtime. |
| pnpm | `>=10` | Only needed to build the workspace from source (the published packages install with plain `npm`/`npm exec`). |
| Codex CLI | Supported version; `>=0.144.0` for GPT-5.6 | Required for every direct `codex:*` route. |

The default `codex:gpt-5.6-terra` runtime also needs Codex CLI 0.144.0 or newer installed and signed in. The init wizard checks version and sign-in state but never installs software or starts an unrequested login flow. Follow only the [official Codex CLI instructions](https://developers.openai.com/codex/cli/): on macOS/Linux the standalone installer is:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex                    # first run prompts for sign-in
codex login status
```

:::note
You do **not** need pnpm to use the published packages — `npm i -g` and `npm exec` are enough. pnpm is only required for the "run an unreleased build" path below, which builds the workspace from source.

The repository includes `.nvmrc`, so source contributors using nvm can run `nvm use` to select the exact minimum version exercised in CI. Newer Node releases remain supported by the `>=22.19.0` package engine range.
:::

## Install the CLI

Install the `create-mono-agent` installer globally to get the `mono-agent` command on your `PATH`:

```bash
npm i -g create-mono-agent
```

`create-mono-agent` ships both a `create-mono-agent` and a `mono-agent` bin, each forwarding every command to `@mono-agent/agent-app` (installed alongside it); behaviour is identical. Prefer the scoped host directly? It also puts `mono-agent` on your `PATH` and additionally installs the `mono-agent-memory-recall` helper bin used by the memory recall tool:

```bash
npm i -g @mono-agent/agent-app
```

Not installing globally? Run any command through `npm exec` with either name:

```bash
npm exec --package create-mono-agent -- mono-agent --help
npm exec --package @mono-agent/agent-app -- mono-agent --help
```

## Scaffold without installing

If you only want to create an agent folder, run `init` with `npm create` (or the equivalent `npx`) — no global install needed:

```bash
npm create mono-agent@latest init
# equivalently:
npx create-mono-agent init
```

This downloads and runs the published CLI for that one scaffold command. It does not require a global install or the source-build workspace setup. The scoped equivalent is `npm exec --package @mono-agent/agent-app -- mono-agent init`.

## The TUI console

The operator console is built into the CLI — once an agent is running (`mono-agent start`), open it from **any directory**:

```bash
mono-agent tui
```

It discovers running agents on the machine and gives you live chat with structured thinking/tool/telemetry insight, bounded recorded-run replay, and a config view. The underlying `@mono-agent/tui` package also ships a low-level `mono-agent-tui` bin for custom hosts (`--responder` embedded mode, `--url` direct connect):

```bash
npm i -g @mono-agent/tui   # only needed for the standalone bin
```

See [TUI](/observability/tui/) for the console walkthrough.

## The always-on web console

Once one or more agents are running, start the managed browser console from any directory on macOS:

```bash
mono-agent web start
mono-agent web
```

On Linux and other supported non-macOS hosts, use the foreground `mono-agent web run` command under your preferred service manager.

It listens on `0.0.0.0:5050` by default for local, LAN, and tailnet use; bare `web` only reports status and exact URLs. There is no application login, so use it only on a trusted LAN/tailnet or pass `--loopback`. See the [web console guide](/observability/web-console/) for persistent threads, attachments, and service lifecycle.

## Verify the install

Confirm both binaries resolve and print their help:

```bash
mono-agent --help
mono-agent-tui --help
```

The CLI exposes these commands (more detail in the [CLI Reference](/observability/cli-reference/)):

| Command | Purpose |
| --- | --- |
| `init` | Non-destructive scaffold of a config, `IDENTITY.md`, and `.mono-agent/`. A fresh built-in Journal/BuJo selection also gets one empty provider-free managed generation; pre-existing memory roots are never changed. On a TTY with no flags it runs the step-by-step **wizard** (preset or custom; walks you through model, channels, memory, tools, sandbox, observability); any flag or a non-TTY writes the scaffold silently. `setup` is an alias. |
| `presets` | List the built-in setup presets (`list`) or show a preset's generated config, `.env.example`, and checklist (`show <id>`). Replaces the removed `recipes` command. |
| `validate` | Validate `mono-agent.config.json` and live checks that can be tested safely before starting. |
| `start` | Start the host for every configured channel (backgrounds on macOS; use `--foreground` elsewhere). |
| `restart` / `stop` / `status` / `logs` | Manage the backgrounded instance (macOS). |
| `tui` | Open the operator console and connect to any running agent. |
| `web` | Manage or run the always-on browser conversation console. |
| `sessions` (removed) | Removed — use `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console). |
| `install-skill` | Install the authoring composer and its documentation MCP companion, or maintain managed project skills. |
| `backfill` | Replay historical runs into observability. |

## Next: scaffold your first agent

Once the binaries are verified, scaffold a clean project folder:

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

On a terminal with no flags, `mono-agent init` is the **readiness-proven** step-by-step wizard: name the agent, enter the exact Role destined for `IDENTITY.md` → `## Role`, search the Pi/Codex/Claude catalogs, configure any number of fallbacks and their exact efforts, then choose capabilities and route safety. The review says whether that Role will be written or an existing identity preserved. Escape goes back. A concrete creation review precedes provider/SRT mutations. On macOS it proves every selected route sequentially, prepares the private managed runtime, starts or refreshes the single canonical per-config launchd agent, waits for a fresh exact-snapshot ready trace source, and only then opens the remote, persistent **SELF-CONFIG** workflow conversation. Interrupted preflight can resume fingerprint-matching successes or restart all checks. Pass `--yes` or any flag (or run in a non-TTY) for scaffold-only automation; that path never starts a process or makes a readiness claim. Off macOS, edit the preserved scaffold manually, validate, start with `--foreground`, and open ordinary `mono-agent tui`; conversational configuration requires the managed macOS lifecycle. See [Setup security and managed runtime](/reference/setup-security/) for the closure, environment, single-instance, and snapshot-integrity contracts behind the managed path.

```bash
mono-agent init --preset telegram-assistant --yes   # scaffold from a preset
mono-agent presets list                             # browse the built-in presets first
```

Then continue with the [Quickstart](/getting-started/quickstart/) to start the agent and send a webhook request. For the full key reference, see [Config Blueprint](/config/blueprint/) and [Environment Variables](/config/env-vars/).

## Updating

:::caution[One-time managed-SRT upgrade to 0.9]
When upgrading from 0.8 or earlier to 0.9 or later on macOS, treat the
managed-SRT lock-protocol transition as offline. Before replacing packages,
stop every background and foreground mono-agent process for this OS user and
wait for any older `mono-agent init` or `mono-agent sandbox setup` command to
exit. Keep old processes stopped until the new-version packages are installed
and the first new-version `mono-agent sandbox setup` completes. Versions 0.8
and earlier do not acquire the permanent OS-level guard introduced in 0.9, so
old and new setup or repair must never overlap.
:::

Update global installs with npm:

```bash
npm update -g create-mono-agent     # (or @mono-agent/agent-app)
npm update -g @mono-agent/tui
```

The `create-mono-agent` installer, `@mono-agent/agent-app`, `@mono-agent/tui`, `@mono-agent/web`, and every other `@mono-agent/*` package release in lockstep at one version — keep any pinned references (scoped or the `create-mono-agent` installer) on the same version.

For reproducible installs or one-shot scaffolds, pin the version explicitly to a published release — use the same version across every `@mono-agent/*` package (pick one from the [published npm versions](https://www.npmjs.com/package/@mono-agent/agent-app?activeTab=versions)):

```bash
version='0.13.0' # Replace with the published version you want to install.
npm i -g "@mono-agent/agent-app@$version" "@mono-agent/tui@$version"
npm exec --package "@mono-agent/agent-app@$version" -- mono-agent init
```

Source collaborators can review each version's notes in the repository
`CHANGELOG.md` and match them to its immutable source tag. Public installers can
confirm every published package version through npm metadata.
For the Product v1 line, first published to npm as 0.8.0, follow the complete [existing-agent cutover checklist](/memory/validation-and-cli/#enable-v1-on-an-existing-agent) after updating the binaries.

## Run an unreleased build

To run against unreleased changes (e.g. a feature branch), build the workspace from source and point `mono-agent` at the built CLI entry. This is the only path that needs pnpm `>=10`.

```bash
git clone https://github.com/robertsreberski/mono-agent.git
cd mono-agent
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm run build` builds every package (and the demos) in dependency order. On supported POSIX/macOS
hosts it first acquires the ignored exclusive `.mono-agent-build.lock`, removes the prior
`.mono-agent-build.json`, finalizes the required CLI/TUI executable modes, syncs the completed deploy
outputs, and atomically publishes a canonical
owner-only marker. The marker records the full source SHA and state, Node version and ABI, completion
time, a deterministic digest of the actual deploy outputs, and a separate digest of the installed root
and workspace `node_modules` topology, modes, and file bytes (including native addons). Fleet deployment checks
require the checkout to remain clean on both reads, recompute both digests, and bind every running
instance to the full expected SHA. The marker and lock are operational state, not files to commit or
copy between checkouts. A concurrent build fails closed; remove a stale lock only after proving no
root build is still active, then rerun the complete build. Windows and unsupported hosts still run the
normal build commands but do not publish this POSIX/macOS deploy proof. On a managed launchd fleet,
`--expect-labels <csv>` additionally pins the exact host topology; the checker revalidates each selected
canonical plist after its expensive probes, while auto-discovery alone cannot detect a plist that was
removed before the run began. Current managed plists execute an owner-private copied runtime under
`~/.mono-agent/runtimes`, so pass `--repo <deploy-checkout>` to select the source checkout whose build
marker and SHA are being proved. The checker also requires the copied CLI to occupy the canonical
content-addressed path and verifies its v4 marker, complete closure manifest, package bytes,
configured-plugin closure, and install-time execution-filesystem proof (including every resolution-path
directory inside the private install root) against that source checkout at both ends of the probe;
canonical ancestors above that root are separately required to remain owner-private. The running
process must start after the conservative finalized-runtime boundary. After the build, the source CLI entry point is
`packages/agent-app/dist/cli.js`. For a literal source-build smoke test from a clean folder, call that
entry directly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/agent-app/dist/cli.js" init --model pi:openai-codex:gpt-5.6-terra
node "$repo/packages/agent-app/dist/cli.js" validate
```

You can also alias `mono-agent` to the built entry so you can run the local build from anywhere:

```bash
alias mono-agent="node /absolute/path/to/mono-agent/packages/agent-app/dist/cli.js"
mono-agent --help
```

For the TUI bin from the same clone, alias `mono-agent-tui` to `packages/tui/dist/bin/mono-agent-tui.js`:

```bash
alias mono-agent-tui="node /absolute/path/to/mono-agent/packages/tui/dist/bin/mono-agent-tui.js"
```

:::caution
Rebuild (`pnpm run build`) after pulling new changes — the alias points at compiled output in `dist/`, not the TypeScript sources, so edits are not picked up until you rebuild. Cross-package types and tests resolve against built `dist/`, so a stale build can mask or surface errors that do not match `src`.
:::

:::tip
Editable global link instead of an alias? After `pnpm run build`, run `npm link` from `packages/agent-app` (and `packages/tui`) to put the local bins on your `PATH`. You still rebuild after each change.
:::

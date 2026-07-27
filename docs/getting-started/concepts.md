---
title: "Core Concepts"
description: "Understand strict agent projects, typed module selection, routing, operator products, durability, and fail-closed behavior in mono-agent."
sidebar:
  order: 3
---

Mono-agent separates the neutral agent host, selected agent-process modules,
and standalone operator or service products. This page is the mental model for
reading config and deciding where a change belongs.

## An agent is a project contract

An installed agent is more than one JSON file:

| Surface | Authority |
| --- | --- |
| `mono-agent.config.json` | Agent identity, runtime routes, policy, context, and explicit module selections. |
| `package.json` | Direct production dependency authority for every `$use`. |
| `pnpm-lock.yaml` or `package-lock.json` | Root-importer and installed-version proof; npm's lock records the source-preview tarball locator and integrity expectation. |
| `AGENTS.md` or another instruction file | Agent instructions selected by `agent.instructions`. |
| Process environment | Values named by explicit `$env` references. |
| `.mcp.json` | Optional ordinary project MCP server definitions. |
| Module-owned directories | State, memory, runtime sessions, discovery, jobs, or product data owned by one implementation. |

Core refuses to infer a selected package from what happens to be installed. The
config, manifest, lockfile, and installed package must agree.

## Config-first does not mean one mega-config

The agent config owns the agent process:

- identity, instructions, and workspace;
- selected runtime instances and ordered routes;
- session and project context assembly;
- selected channels, memory, state, triggers, exporters, and sandbox;
- tool and approval policy.

It does not own browser-product configuration, macOS service declarations, MCP
server bodies, cron job bodies, package installation, or release operations.
Those remain explicit adjacent surfaces.

Unknown core fields fail validation. Each selected module then validates only
its own options.

## `$use` is a verified selection

A selected module object begins with a literal package name:

```json
{
  "channels": {
    "automation": {
      "$use": "@mono-agent/channel-webhook",
      "listen": { "host": "127.0.0.1", "port": 3210 },
      "apiKey": { "$env": "WEBHOOK_API_KEY" }
    }
  }
}
```

Before import, core proves that the package:

1. is a direct `dependency` or `optionalDependency` of the project;
2. is present as the same direct installed version in the root npm or pnpm
   lockfile;
3. resolves to a real entry contained by its installed package root;
4. declares matching package identity, API version, module kind, and
   responsibility; and
5. exports a matching `monoAgentModule` whose strict schema accepts the selected
   options.

`$use` never accepts a path, URL, or package subpath. A selected package's
direct dependency may use the documented source-preview exception
`file:<project-relative-path>.tgz` when installed through npm; this changes
package provenance, not module identity. Its `package-lock.json` root entry must
record the same lexical archive locator, installed version, and a syntactically
valid canonical SHA-512 SRI. Core validates the installed package directory but
does not reopen the archive; the documented frozen install and packed verifier
check its bytes. Pnpm remains supported for registry dependencies, not this
source-preview exception. Local directories, parent or absolute paths, links,
workspaces, aliases, patches, Git or HTTP sources, bare archives, implicit
registration, and dynamic installation are not module mechanisms.
See the [local-tarball install](/getting-started/install/#install-a-retained-minimal-local-tarball-consumer)
for the exact boundary.

## Module slots

| Slot | Cardinality | Host purpose |
| --- | --- | --- |
| `runtimes` | One or more named instances | Execute provider-native turn attempts. |
| `channels` | Zero or more named instances | Receive normalized turns and optionally deliver proactive messages. |
| `memory` | Zero or one | Recall and capture long-lived agent context. |
| `state` | Zero or one | Durable conversations, run records, idempotency, CAS state, and presence. |
| `triggers` | Zero or more named instances | Emit scheduled or external proactive events. |
| `observability.exporters` | Zero or more named instances | Export normalized telemetry. |
| `policy.sandbox` | `off` or one selected module | Execute eligible commands through a verified isolation boundary. |

The package's manifest kind must match the slot. A module may reference another
selected instance only through a schema-declared cross-slot reference, and core
validates any required capability before startup.

An instance may offer a bounded model tool when that behavior is inseparable
from the selected module's private data and lifecycle. The list is static
instance data, not a `plugins` key or registry. Core exposes it only after that
instance starts, then owns final naming, policy, approval, sandbox eligibility,
timeouts, normalization, and turn-scoped disposal.

## Core coordinates; modules implement

`@mono-agent/core` owns strict loading, bounded admission, per-conversation
ordering, routing, policy, history coordination, host capabilities, health,
drain, and stop. It depends only on `@mono-agent/module-sdk`.

Implementations own native behavior:

- a runtime owns provider protocol, attempt lifecycle, and native session ids;
- a channel owns transport authentication, parsing, bounds, and delivery;
- state and memory each own their durable format and recovery;
- a trigger owns discovery, schedule, and deterministic event identity;
- an exporter owns batching, transport, retry, and flush;
- a sandbox owns verified command execution.

Core does not reach into implementation internals or hide an implementation
failure behind fake success.

## Routes and sessions

`routing.primary` and `routing.fallbacks` name selected runtime instance ids and
provider-native model strings. The order is explicit. A runtime attempt is
isolated, and its native session linkage remains with that runtime.

Fallback does not imply unsafe replay. If a failed attempt may have committed a
side effect, mono-agent does not blindly resubmit it elsewhere. Cancellation,
live input, AskUser answers, and normalized result events cross typed runtime
contracts.

Session policy controls conversation continuity, idle rollover, timezone, and
proactive-run isolation. Canonical transcript durability requires the selected
state module; provider-native session files are not a substitute for state.

## Channels and operator products

Telegram, Slack, webhook, OpenAI-compatible API, and operator access are channel
modules. Selecting one adds transport behavior to the agent process; installing
its package alone does nothing.

Operator access is intentionally split:

- `@mono-agent/channel-operator` is a selected authenticated loopback channel
  for one running agent.
- `@mono-agent/operator` is the shared protocol, strict client, directory,
  reducer, and action policy.
- `@mono-agent/tui` is a standalone terminal renderer.
- `@mono-agent/web` is a standalone browser product with separate config,
  authentication, listener, and durable web conversations.

TUI and web do not appear in agent config. They connect to a running operator
channel. Closing a renderer does not stop the agent, and a browser disconnect
does not automatically cancel the service-owned turn.

When state discovery is configured, core publishes the started operator
endpoint, process identity, capabilities, and token environment name into the
owner-private state-presence record. The shared directory validates that record;
the bearer-token value remains only in the process environment.

## Context, skills, and MCP

Core resolves the configured instruction file and optional skill roots relative
to the config. `context.skills.load` supports the honest `all` mode: every
direct `SKILL.md` under the configured roots is validated with no-follow reads
and bounded individually by `maxBytes`; the same setting bounds the instruction
file and combined rendered context. A size rejection reports the exact observed
byte count as a `size` issue rather than a security-read failure. The Personal
scaffold uses 256,000 bytes. `disclosure: "full"` places those bodies in the
system context; `disclosure: "index"` exposes only names and descriptions plus
Core's bounded `ReadSkill` tool, so indexed skills remain executable without
leaking filesystem paths. Duplicate skill names fail startup. Tool-name
collisions across selected modules, MCP, channels, and Core receive
deterministic source-qualified names; a tool policy cannot use an ambiguous raw
alias and reports the canonical alternatives.

Project MCP servers live in the explicitly named `.mcp.json`-style file. They
are ordinary tool servers, not module packages. `@mono-agent/docs-mcp` is a
separately configured companion and is never activated by package presence.
Tools inseparable from an already selected module may use its bounded
contribution seam; this does not move ordinary project/domain tools out of MCP.

## State, memory, and product data

These domains remain separate:

- `@mono-agent/state-local` owns versioned CAS records, durable agent
  conversations/runs, idempotency, presence publication, and its effect-free
  `RunHistory` contribution.
- `@mono-agent/memory-local` owns long-lived BuJo memory and its permanent
  first-run identity.
- `@mono-agent/web` owns browser-product threads and messages in its own data
  directory.
- Runtime modules may own provider-native session linkage under their own
  configured paths.

Resetting one domain does not authorize resetting another. Backup, restore,
migration, and retention follow the owning package's contract.

## Secrets and provenance

`{"$env":"NAME"}` is an explicit reference, not interpolation and not an env
file loader. Core resolves it only at schema-marked paths. Secret-marked fields
accept no inline alternative. Missing values fail validation; config explain
reports the variable name and owning package while redacting the value.

Provider-native credential stores remain owned by the selected runtime. Service
products may inject a protected environment, but core itself does not search
shell profiles or `.env` files.

## Fail closed, preserve evidence

The architecture treats security and durability failures as terminal for the affected
operation:

- unsafe package identity or lockfile drift prevents import;
- wrong-owner, permissive, linked, swapped, corrupt, or unknown local state is
  preserved and rejected rather than repaired;
- sandbox fingerprint or policy mismatch does not fall back to host execution;
- unsafe exporter endpoints or redirects do not receive queued data or secrets;
- oversized or malformed channel and provider traffic is rejected within
  bounded resource limits; and
- uncertain post-commit durability poisons the open writer until a clean reopen.

Health and terminal results expose degraded and failed states. "Best effort"
does not mean claiming success without evidence.

## Applications have separate lifecycles

The CLI runs an agent in the foreground. `create-mono-agent` renders projects.
The macOS service package explicitly inspects, plans, and applies service state.
TUI and web run independently. Core does not silently daemonize, install a
service, start a product, or publish packages.

## Source completion is not delivery completion

The public source milestone ends when the repository builds, tests, and runs
the packed minimal and operator-product proofs. Registry release, live consumer
migration, data audit, rollback rehearsal, deployment, soak, observation,
cutover, and predecessor retirement remain a later explicitly authorized phase.

See the [architecture](/reference/architecture/) for the exact package
roster and enforced dependency graph.

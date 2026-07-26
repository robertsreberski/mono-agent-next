# mono-agent architecture

This is the maintainer map for the public source target. The accepted
product contract is in the [architecture decision](./docs/reference/architecture.md),
and each package README owns its detailed public API and operational boundary.

## System shape

`@mono-agent/core` is the only agent composition host. It knows the neutral
module contracts from `@mono-agent/module-sdk`, but it does not import concrete
runtimes, channels, memory, state, exporters, triggers, or sandboxes.

```text
agent project
  mono-agent.config.json       explicit module selections and routing
  package.json                 direct production dependencies
  pnpm-lock.yaml/package-lock  installed selection proof
  AGENTS.md                    instructions
  .mcp.json                    optional ordinary MCP servers
        |
        v
  @mono-agent/core
        |
        +-- runtime attempts --> selected provider-native runtime module
        +-- inbound/outbound --> selected channel modules
        +-- durable context ---> optional memory and state modules
        +-- proactive work ----> optional trigger modules
        +-- telemetry ---------> optional exporter modules
        +-- command execution -> off or one selected sandbox module
```

Core grants narrow host capabilities, normalizes turns, preserves runtime-native
session linkage per route, applies tool and approval policy, coordinates bounded
startup/drain/stop, and reports real failures. It does not provide a generic
module registry, discover packages by installation side effects, or invent
fallback success.

## Exact 23-package roster

The catalog is closed: 22 packages live under `packages/`; the paired
documentation MCP companion is the one publishable package under `extras/`.

| Package | Category | Responsibility |
| --- | --- | --- |
| [`@mono-agent/module-sdk`](./packages/module-sdk/README.md) | core | Typed module contracts, schemas, compliance helpers, and bounded host primitives. |
| [`@mono-agent/core`](./packages/core/README.md) | core | Strict config loading and execution of explicitly selected modules. |
| [`@mono-agent/cli`](./packages/cli/README.md) | app | Validation, inspection, schema/explain, module-command, and foreground-start frontend. |
| [`@mono-agent/runtime-pi`](./packages/runtime-pi/README.md) | runtime | Pi-native attempts and native session linkage. |
| [`@mono-agent/runtime-claude`](./packages/runtime-claude/README.md) | runtime | Claude SDK or CLI native attempts. |
| [`@mono-agent/runtime-codex`](./packages/runtime-codex/README.md) | runtime | Codex app-server attempts with bounded process, approval, session, and cancellation handling. |
| [`@mono-agent/runtime-opencode`](./packages/runtime-opencode/README.md) | runtime | Version-preflighted OpenCode JSONL attempts and native sessions. |
| [`@mono-agent/channel-telegram`](./packages/channel-telegram/README.md) | communication | Telegram Bot API ingress and delivery as normalized channel turns. |
| [`@mono-agent/channel-slack`](./packages/channel-slack/README.md) | communication | Slack Socket Mode ingress and Web API delivery as normalized channel turns. |
| [`@mono-agent/channel-webhook`](./packages/channel-webhook/README.md) | communication | Bounded authenticated webhook ingress and explicit delivery. |
| [`@mono-agent/channel-openai-api`](./packages/channel-openai-api/README.md) | communication | Bounded authenticated OpenAI-compatible API for one selected agent. |
| [`@mono-agent/channel-operator`](./packages/channel-operator/README.md) | communication | Authenticated shared operator protocol endpoint for one selected agent. |
| [`@mono-agent/trigger-cron`](./packages/trigger-cron/README.md) | execution | Scheduled Markdown discovery and deterministic idempotent trigger emission. |
| [`@mono-agent/memory-local`](./packages/memory-local/README.md) | context | Owner-private SQLite recall, capture, forgetting, and permanent first-run identity. |
| [`@mono-agent/state-local`](./packages/state-local/README.md) | execution | Owner-private CAS state, durable conversation/run records, idempotency, and presence. |
| [`@mono-agent/exporter-otlp`](./packages/exporter-otlp/README.md) | observability | Bounded normalized OTLP HTTP export. |
| [`@mono-agent/sandbox-srt`](./packages/sandbox-srt/README.md) | execution | Fingerprinted fail-closed Sandbox Runtime Tool command execution. |
| [`@mono-agent/operator`](./packages/operator/README.md) | operator-surface | Shared protocol, strict client, directory, domain reducer, actions, and fixtures. |
| [`@mono-agent/tui`](./packages/tui/README.md) | operator-surface | Standalone pi-tui renderer over the shared operator client. |
| [`@mono-agent/web`](./packages/web/README.md) | operator-surface | Standalone authenticated browser product with owner-private durable conversations. |
| [`create-mono-agent`](./packages/create-mono-agent/README.md) | app | Transactional minimal, Personal, and multi-runtime project scaffolding. |
| [`@mono-agent/docs-mcp`](./extras/docs-mcp/README.md) | context | Offline search and guided reading over version-matched documentation. |
| [`@mono-agent/service-macos`](./packages/service-macos/README.md) | app | Explicit inspection, planning, and reconciliation of fingerprinted macOS services. |

## Dependency rules

The workspace dependency graph encodes ownership:

- `@mono-agent/module-sdk` and `@mono-agent/operator` have no production
  dependency on another workspace package.
- `@mono-agent/core` depends only on `@mono-agent/module-sdk`.
- Every selectable implementation depends on `@mono-agent/module-sdk`; the
  operator channel additionally depends on `@mono-agent/operator` for the one
  shared wire contract.
- TUI and web depend on `@mono-agent/operator`, not on core or a concrete agent
  implementation.
- CLI depends only on core. The scaffolder depends only on CLI.
- The documentation MCP companion is not selected by agent config and has no
  runtime dependency on core. Service management is also a separate application.

Architecture checks enforce category-level dependencies, public exports,
package metadata, README structure, license policy, and the exact closed roster.

## Strict selection and loading

The selectable slots are `runtime`, `channel`, `memory`, `state`, `trigger`,
`exporter`, and `sandbox`. Configuration maps each instance id to a literal
`$use` package. Memory and state are singletons; sandbox is either `off` or one
selected module.

Loading proceeds in a fail-closed order:

1. Parse strict JSON and reject unknown envelope fields, invalid ids, invalid
   routes, and unknown directives.
2. Require every `$use` package in project `dependencies` or
   `optionalDependencies`; `devDependencies` do not satisfy runtime selection.
3. Require the root lockfile importer to contain the same direct package and
   installed version. Reject aliases, paths, patches, Git URLs, and HTTP URLs.
4. Resolve the package from the project, keep its real entry inside the package
   root, and verify manifest identity, kind, API version, and responsibility.
5. Resolve `$env` only where the module schema explicitly permits it. Secret
   schema paths reject inline values.
6. Import `monoAgentModule`, verify its exported metadata again, parse its exact
   schema, and validate cross-slot references and required capabilities.
7. Only then instantiate each selected module and snapshot any bounded
   module-owned tool descriptors.
8. Start that instance and expose its descriptor snapshot only after startup
   succeeds.

There is no automatic package installation, path loading, hidden registry, or
compatibility fallback.

## Host and turn lifecycle

Core owns concurrency admission and lifecycle; implementations own their native
work inside granted contracts.

```text
validate -> preflight all selections -> create -> start
   -> channel/trigger submission -> runtime route attempts -> result/delivery
   -> drain pending work -> stop in reverse ownership order
```

Runtime fallbacks are explicit ordered routes. Each attempt has its own runtime
and native session context. A failure after a committed side effect is not
blindly replayed. Cancellation, live input, AskUser answers, health, delivery,
and module commands cross typed host interfaces rather than implementation
imports.

A non-channel instance may offer a model tool only through Module SDK's narrow
`toolContributions` seam when the behavior is inseparable from that selected
module's data and lifecycle. Channel instances retain their existing typed
`sendTools` contract. This is not discovery or registration: importing or
installing a package contributes nothing, and no new config key exists. Core
builds one deterministic catalog across Core, instruction, module, MCP, and
channel tools; it owns final names, policy, approval, sandbox eligibility,
timeouts, cancellation, normalization, and turn-level disposal. Ordinary
project and domain tools remain `.mcp.json` services.

## Operator boundary

Operator access has three layers:

1. `@mono-agent/channel-operator` is a selected agent channel. It binds one
   authenticated loopback endpoint and translates host events to the shared
   protocol.
2. `@mono-agent/operator` is a renderer-neutral library. It owns discovery,
   endpoint identity binding, strict decoding, conversation reduction, and
   action eligibility.
3. `@mono-agent/tui` and `@mono-agent/web` are standalone products. They connect
   to an already-running agent and have independent process lifecycles.

The TUI owns terminal input and rendering. Web owns its separate config,
listener, browser authentication, and durable conversation data. Neither reads
agent config, runs a provider, or stops the agent when a client disconnects.

If the selected state store supports host presence, core waits for the operator
channel's actual bound endpoint and then publishes a nested operator descriptor:
agent identity, endpoint, token environment name, process identity, and
capabilities. `@mono-agent/operator` reads that owner-private state-presence
schema and identity-binds it before use. The token value is never published.

## Security and durability boundaries

| Boundary | Fail-closed rule |
| --- | --- |
| Configuration | Unknown fields/directives, invalid references, inline secrets, and unresolved environment values fail before startup. |
| Installed code | Selection requires direct manifest and lockfile proof; package identity, real entry containment, kind, API version, and responsibility must agree. |
| Agent ingress | Channel implementations bound request size, authentication, origin/media type where relevant, concurrency, timeouts, and cancellation. |
| Operator transport | Agent endpoint is authenticated and loopback-only; discovery records are owner-private and identity-bound before use. |
| Local state | State and web stores reject permissive/wrong-owner/non-regular/linked/swapped paths, corrupt content, and unknown schema versions without rewriting them. Atomic replace plus directory synchronization makes complete snapshots visible. |
| Memory | The local memory module separately owns a protected SQLite database, mutation fencing, recovery, and permanent first-run identity. |
| Tools | Core snapshots static selected-module descriptors, assigns collision-safe identities, intersects policy, and revokes turn bindings; modules cannot claim Core authority. |
| Sandbox | SRT path/settings fingerprints, command paths, environment, input/output, timeout, and cancellation are checked; mismatch has no host fallback. |
| Export | Remote OTLP requires HTTPS, loopback HTTP is literal-only, redirects are checked, credentials are not forwarded cross-origin, queues are bounded, and sensitive body export is off by default. |
| Lifecycle | Queues, turns, retries, streams, flushes, drains, and stops have explicit bounds; ambiguous durability poisons the open writer until reopen. |

Durable domains are not interchangeable: agent state does not own memory, web
does not own agent transcripts, and renderer exit does not own agent shutdown.

## Application boundary

- `@mono-agent/cli` runs one config in the foreground and exposes validation,
  inspection, composed-schema, provenance, and module-command operations.
- `create-mono-agent` transactionally renders one of three closed templates.
  Package installation is opt-in; secret files and secret values are never
  generated.
- `@mono-agent/service-macos` owns explicit service inspect/plan/apply behavior.
  Core does not background itself.
- `@mono-agent/docs-mcp` is paired through ordinary project MCP configuration,
  not agent module selection.

## Delivery phase boundary

This source milestone proves architecture, build, tests, packed runtime behavior,
and standalone operator behavior. It does not publish packages, install a live
agent, migrate data, alter services, or establish production readiness.

Release candidate creation, registry verification, consumer migration,
rollback rehearsal, bounded live soak and observation, cutover, deprecation,
and predecessor retirement require a later explicit authorization and their own
evidence. The predecessor remains the live source until that phase completes.

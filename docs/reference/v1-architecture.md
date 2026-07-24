---
title: "Mono-agent v1 architecture"
description: "The accepted config-first architecture, exact 23-package roster, strict module boundary, operator split, and delivery-phase separation."
sidebar:
  order: 9
---

Status: Accepted architecture; implemented public source target

Decision date: 2026-07-22

The full implementation requirements remain in the repository's v1 product
requirements. This page is the concise contract for the resulting architecture.
It describes source behavior, not a release or production cutover.

## Decision

Mono-agent v1 has one neutral composition host and a closed set of typed modules.
Agent projects select implementations in strict JSON using literal `$use`
package names. Selection is proven against both the project's direct production
dependencies and its root lockfile before any module is imported.

Operator renderers, service management, scaffolding, and documentation search
are separate applications or products. Package presence never activates a
capability.

## Exact package architecture

V1 contains exactly 23 publishable packages. Twenty-two live under `packages/`;
the documentation MCP companion is the only publishable package under `extras/`.

| Package | Category | Contract |
| --- | --- | --- |
| `@mono-agent/module-sdk` | core | Apache-licensed typed module contracts, schemas, compliance helpers, and bounded host primitives. |
| `@mono-agent/core` | core | Strict config loading and execution without concrete implementation imports. |
| `@mono-agent/cli` | app | Validate, inspect, author schema/provenance, run module commands, and start in the foreground. |
| `@mono-agent/runtime-pi` | runtime | Pi-native provider attempts with native session linkage. |
| `@mono-agent/runtime-claude` | runtime | Claude SDK or Claude CLI native attempts. |
| `@mono-agent/runtime-codex` | runtime | Codex app-server attempts with bounded process, session, approval, and cancellation handling. |
| `@mono-agent/runtime-opencode` | runtime | Version-preflighted OpenCode JSONL attempts with native sessions. |
| `@mono-agent/channel-telegram` | communication | Telegram Bot API ingress and delivery as normalized turns. |
| `@mono-agent/channel-slack` | communication | Slack Socket Mode ingress and Web API delivery as normalized turns. |
| `@mono-agent/channel-webhook` | communication | Bounded authenticated webhook ingress and explicit delivery. |
| `@mono-agent/channel-openai-api` | communication | Bounded authenticated OpenAI-compatible API for one agent. |
| `@mono-agent/channel-operator` | communication | Authenticated shared operator protocol for one agent. |
| `@mono-agent/trigger-cron` | execution | Scheduled Markdown discovery and deterministic idempotent trigger events. |
| `@mono-agent/memory-local` | context | Owner-private SQLite recall, capture, forgetting, and permanent first-run identity. |
| `@mono-agent/state-local` | execution | Owner-private CAS state, durable conversation/run records, idempotency, and presence. |
| `@mono-agent/exporter-otlp` | observability | Bounded normalized OTLP HTTP export. |
| `@mono-agent/sandbox-srt` | execution | Fingerprinted fail-closed SRT command execution. |
| `@mono-agent/operator` | operator-surface | Apache-licensed protocol, strict client, directory, reducer, actions, and fixtures. |
| `@mono-agent/tui` | operator-surface | Standalone pi-tui renderer over the shared operator client. |
| `@mono-agent/web` | operator-surface | Standalone browser product with explicit auth policy and owner-private durable conversations. |
| `create-mono-agent` | app | Transactional minimal, Personal, and multi-runtime project scaffolding. |
| `@mono-agent/docs-mcp` | context | Offline search and guided reading over version-matched v1 docs. |
| `@mono-agent/service-macos` | app | Explicit inspection, planning, and reconciliation of fingerprinted macOS services. |

The generated [package directory](/reference/packages/) is the package-by-package
navigation surface.

## Composition model

The agent-process dependency direction is intentionally one-way:

```text
@mono-agent/module-sdk <- @mono-agent/core
@mono-agent/module-sdk <- selected runtime/channel/memory/state/trigger/exporter/sandbox modules
@mono-agent/operator   <- @mono-agent/channel-operator
@mono-agent/operator   <- @mono-agent/tui and @mono-agent/web
```

The arrows mean "is depended on by," not that core imports implementations.
Core depends only on the SDK. Selectable modules generally depend only on the
SDK; the operator channel also uses the shared operator contract. TUI and web
depend on the operator library and do not depend on core or any runtime.

CLI depends only on core. The scaffolder delegates non-scaffold commands to the
CLI. The docs MCP companion has no core runtime dependency, and macOS service
management remains a separate application over the core public API.

## Agent configuration

The fixed envelope is:

- `configVersion`, `agent`, `runtimes`, `routing`, and `policy`;
- optional `session` and `context`;
- optional `channels`, `memory`, `state`, `triggers`, and
  `observability.exporters`.

Selectable module kinds are `runtime`, `channel`, `memory`, `state`, `trigger`,
`exporter`, and `sandbox`. Runtime, channel, trigger, and exporter slots are
instance maps. Memory and state are singletons. `policy.sandbox` is either
`{"mode":"off"}` or one selected sandbox.

Every selected object starts with `$use`:

```json
{
  "runtimes": {
    "primary": {
      "$use": "@mono-agent/runtime-codex",
      "auth": { "apiKey": { "$env": "OPENAI_API_KEY" } }
    }
  }
}
```

The package name must be a literal bare npm name. Paths, subpaths, aliases,
links, patches, Git sources, and HTTP sources are rejected. A selected package
must be in `dependencies` or `optionalDependencies`, not only
`devDependencies`, and the npm or pnpm root lockfile must prove the same direct
installed version.

After safe path resolution, core verifies package manifest identity, entry
containment, API version, kind, responsibility, and the exported
`monoAgentModule` metadata. It resolves `$env` only at schema-declared eligible
paths, rejects inline secret values, parses the selected module's schema, and
checks typed cross-slot references before startup.

Unknown envelope fields and unknown core directives fail validation. A module
schema controls its own exact options; extensible maps exist only where that
schema declares them. There is no implicit `.env` loading.

## MCP request context and current-run output

Project tools remain ordinary `.mcp.json` servers. Most receive only their
configured stdio environment or HTTP headers. The admitted Personal
transcription consumer uses the sole narrow exception:
`context.mcp.requestContextServers` names an existing direct stdio transport that
may receive immutable per-call input/output/progress context. The field defaults
off and accepts at most 32 unique names; missing, duplicate, or HTTP server
references fail validation.

Core stages only current-request attachments into an owner-private run
directory and dispatches namespaced schema-versioned metadata with current
conversation/run identity, attachment ids, exact path/device/inode allowlists,
and one per-run output directory. Device and inode values are canonical
unsigned-decimal strings rather than JSON numbers. Model arguments cannot
override the reserved metadata. MCP progress is bounded, redacted, transient,
and subject to both an idle timeout and a non-resettable hard deadline.

Personal transcription uses `attachment_id`; `file_path` is default-deny.
Legacy local paths require a bounded static `TRANSCRIBE_LOCAL_PATH_ROOTS`
absolute-directory allowlist that cannot select the managed attachments root.

A producing MCP returns one safe output basename, never a path capability. A
channel send tool asks Core to read that basename through
`ChannelSendToolContext.readCurrentRunOutput`. Core performs the no-follow,
regular, single-link, identity-stable bounded read from the current run and
returns normalized attachment bytes. The producer may return bounded ids and
metadata with the basename, but never an absolute-path field. No HTTP-transport
MCP, arbitrary filesystem path, ambient channel capability, process-start
environment grant, continuation, or child-run spawn/observe/cancel authority
follows from this exception.
The exception narrows mono-agent-supplied context; it does not sandbox the
configured command or prove locality. That command may proxy remotely, use the
network, forward the grant, or exfiltrate it. A persistent selected process sees
all selected calls. Result/error/progress strings are redacted before model
delivery and artifact offload, but binary or encoded leakage is not detectable.
Identity-bound reads and private cleanup claims fail closed for trusted-code
mistakes and static replacement; they are not cryptographic provenance or
isolation from deliberate same-UID races. Unprovable cleanup is retained and
reported as degraded health, and safe source-path restoration can still be
impossible after an adversarial race.

Cleanup runs on normal, failed, and cancelled turns. `SIGKILL`, power loss, or
host crash can retain owner-only run residue. Restart intentionally avoids
unsafe PID/age staleness inference and automatic deletion until a
cross-process-lease-backed recovery path lands before GA. Interim maintenance
requires all project hosts proven stopped plus exact, explicitly selected run
ids and owner/non-symlink/directory verification; roots, globs, discovered
ranges, and age-based removal are forbidden.

## CLI and authoring boundary

The CLI is intentionally small:

```bash
mono-agent validate --config <file> [--json]
mono-agent inspect --config <file> [--json]
mono-agent config schema --config <file> [--write]
mono-agent config explain --config <file> [path] [--json]
mono-agent module command --config <file> \
  --module <instance-id> --name <command> [--input-json '<json>']
mono-agent start --config <file>
```

`validate` performs the full installed-selection preflight. `inspect` returns
resolved paths, modules, routes, and MCP server names. `config schema` composes
the exact selected-module schema; `config explain` reports field ownership and
redacted environment provenance. A module command starts the host, calls one
explicitly exposed command, then stops it. `start` is foreground-only and
drains before stopping on process signals.

## Scaffolder contract

`create-mono-agent` has a closed template enum:

| Template | Purpose | Agent-process package closure |
| --- | --- | --- |
| `minimal` | Smallest runnable authenticated webhook agent; default. | SDK, core, CLI, Pi runtime, webhook channel. |
| `personal` | Sanitized Personal Agent-shaped selection with durable local capabilities. | Core trio; Pi; Telegram, webhook, OpenAI API, operator; memory, state, cron, OTLP. |
| `multi-runtime` | Explicit cross-runtime fallback example. | Core trio; Pi, native Claude, webhook. |

Templates contain exact direct dependencies, one strict config, an initial
schema, instructions, a names-only `.env.example`, and no secret values.
Personal also creates empty skill/cron roots and `.mcp.json`. Rendering is
transactional, refuses existing targets and unsafe paths, and runs dependency
installation only after an explicit `--install`.

TUI, web, service management, and docs MCP are separate from the agent-process
template closure.

## Runtime and turn semantics

Routes name a selected runtime instance and a provider-native model. Primary and
fallback routes are ordered and explicit. Native session identifiers remain
attached to their originating runtime; a session is not assumed portable across
providers or runtimes.

Core owns bounded admission, per-conversation ordering, cancellation, live
input, AskUser answer routing, normalized history, tool policy, delivery,
health, drain, and stop. Runtime modules own native request construction,
protocol parsing, provider sessions, and attempt-local failure classification.
When the active direct or channel interaction surface supports it, Core adds a
reserved, policy-filtered `AskUser` request tool. The model supplies one to
three questions under the shared module-sdk bounds; Core supplies interaction
identity, routes and validates the answer with the exact attempt signal, and
returns the structured result so the runtime can continue. Because this is a
Core-mediated interaction rather than an external effect, it never creates a
second approval prompt. MCP and channel tools cannot claim the reserved name.

Failures are not converted to fake responses. An attempt that may have committed
a side effect is not blindly replayed on another route.

## Channel and proactive semantics

Channel modules translate one transport into normalized inbound turns and
explicit outbound delivery. Each module owns its authentication, transport
bounds, allowlists, parsing, and delivery status. Core owns neither Telegram nor
Slack clients, HTTP route implementations, nor operator wire encoding.

Cron is a trigger module, not a hidden scheduler in core. It discovers bounded
Markdown jobs, derives deterministic event ids, and emits through the trigger
host. Proactive delivery names a selected channel and uses an idempotency key;
failed or unsupported delivery remains explicit.

Core returns its canonical assistant transcript id with a channel-dispatched
completion. The operator channel carries a deterministic opaque wire identity
derived from that id in both replay and the terminal frame, so web can persist
an ordinary live reply as a replay-verifiable quote target.
Operator conversation discovery marks only external `cron`/`webhook`
conversations opened by proactive delivery; products do not infer provenance
from opaque ids or import Core's internal trigger execution thread.

## Operator protocol and products

The agent selects `@mono-agent/channel-operator` to expose one authenticated
loopback endpoint. The selected channel maps host conversations, turns,
cancellation, live input, AskUser, config view, and health onto the shared
versioned protocol.

`@mono-agent/operator` contains the only first-party decoder, client, discovery
directory, identity checks, reducer, and action-eligibility rules. Renderers do
not reinterpret raw frames.

`@mono-agent/tui` and `@mono-agent/web` are separately started products:

- TUI owns terminal layout, keyboard input, and rendering. It can connect to an
  explicit endpoint or a valid directory entry. Exiting closes the renderer,
  not the agent.
- Web reads a separate `web.config.json`, owns its listener and browser auth
  policy, and persists web threads in a separate owner-private store. Bearer
  remains the default; explicit no-auth treats network reachability as the
  authorization boundary. Browser disconnect does not implicitly cancel an
  agent turn.

Neither product is selected in `mono-agent.config.json`, loads a runtime, or
owns agent process lifecycle.

With a host-presence-capable state module, core publishes discovery only after
the selected operator channel reports its actual bound endpoint. The
owner-private state presence contains the agent id and label, endpoint, public
token-environment name, process identity, heartbeat, and negotiated
capabilities. The shared directory strictly parses and identity-binds that
record; it never receives the bearer-token value.

## Security properties

### Configuration and code identity

- Strict JSON, bounded identifiers and paths, known envelope keys, and exact
  selected-module schemas.
- Environment references only at declared paths; secret paths require them and
  diagnostics redact resolved values.
- Direct manifest plus lockfile proof, realpath-contained package entry, and
  matching package/export metadata before import.
- No dynamic install, path module, implicit self-registration, or arbitrary
  code fallback.

### Transport

- Ingress bodies, attachments, streams, concurrency, deadlines, redirects, and
  shutdown are bounded by the owning module.
- The opt-in selected-stdio MCP request-context grant is immutable per call,
  namespaced, current-run scoped, and never sent through remote transport or
  process-start environment.
- Operator transport is authenticated and literal-loopback only.
- Remote OTLP export requires HTTPS; HTTP is allowed only for literal loopback.
  Redirect targets are revalidated and configured credentials are stripped on
  cross-origin redirect.
- Sensitive telemetry content is excluded by default.

### Local data

- State, memory, discovery, and web roots are owner-private. Existing symlinks,
  hard links, wrong owners, permissive modes, non-regular files, device/inode
  swaps, corrupt payloads, and unknown versions are rejected without mutation.
- MCP request attachments and current-run outputs use owner-private directories,
  no-follow regular single-link files, exact device/inode checks, bounded reads,
  and replacement-safe cleanup. Channels receive normalized bytes rather than
  path authority.
- State records use atomic same-directory replacement, directory synchronization,
  compare-and-swap versions, deterministic listing, and a process writer lease.
  Ambiguous post-rename durability poisons the open store until reopen.
- Memory owns its separate SQLite lifecycle and recovery contract. Web owns its
  own durable product data. One subsystem never silently resets another.
- SRT executable and settings identity, command path, environment, input/output,
  timeout, and cancellation are checked before execution; verification failure
  has no unsandboxed fallback.

## Deliberate separation from delivery

The first v1 deliverable is a buildable, tested, runnable public repository with
packed minimal-agent and standalone operator-product proofs. That establishes a
source candidate, not a production release.

The following remain a separate phase:

1. release candidate packing and exact-artifact review;
2. registry authorization, publication, and clean-install verification;
3. per-consumer migration rehearsal, data audit, and rollback proof;
4. explicit live deployment and process adoption;
5. bounded soak, observation, and issue disposition;
6. cutover, deprecation window, and predecessor retirement.

No source build, test result, scaffold, or documentation update implicitly
performs or authorizes any of those steps.

## Related pages

- [Getting started](/getting-started/)
- [Install and prerequisites](/getting-started/install/)
- [First-agent proof](/getting-started/quickstart/)
- [Core concepts](/getting-started/concepts/)
- [Capability ladder](/reference/capability-ladder/)

---
title: "Mono-agent v1 architecture decision"
description: "Ratify the smaller config-first architecture, typed module boundaries, migration policy, and measurable release gates for mono-agent v1."
sidebar:
  order: 9
---

Status: Accepted for v1 implementation

Decision date: 2026-07-22

Decision task: V1-001

This decision defines the architecture that v1 implementation must converge
on. It does not describe the currently deployed v0 process, authorize a
release, or remove the successor repository's deployment guard. The original
private repository remains the live source until the final v0 release is cut,
every named consumer is pinned away from repository `main`, and the reviewed
canonical-repository cutover is complete.

## Context

The v0 packages contain sound runtime, channel, memory, and operator behavior,
but the application layer owns too many unrelated concerns. Configuration is
represented in several parallel forms, the default application closure includes
many integrations a project did not select, setup and diagnostics understand
concrete providers, and operator products duplicate protocol and state logic.
The authoritative stacked clean-successor G0 production-source baseline is
182,217 lines across 523 files. Its snapshot digest is
`3e5ffd9a140519f490f391f5f3dc470269e68711ab72e6189a1089004e770054`
and its classified-file manifest digest is
`ad3c3255dbd404ea51a5f52814968d6a8499a1224b6f3db71eca6b793aa92b65`.
The committed baseline-file digest is
`a984af137989d798c800202c37905c1a28deaf21d0d40da3961bbb4d888a441b`.
The preliminary counter reported 182,118; normalization reclassified 83
test-helper lines and the nine-line TUI Vitest config to produce an original-v0
baseline of 182,026. The bootstrap initially removed one meaningless terminal
blank line, then its reviewed security and portability fixes added 192 net
production lines: 30 in owner-only SQLite creation, 160 in permanent
descriptor-bound first-run managed-memory marker hardening, and 2 in doctor
integration for that marker contract. Thus `182,026 - 1 + 192 = 182,217` at the
exact stacked successor head measured by V1-002. The same snapshot classifies
179,145 test lines across 439 files and 17,659 excluded-with-reason lines across
62 files, for 379,021 executable lines across 1,024 files.

The v1 goal is not a package rename or an add-only replacement beside v0. It is
a smaller system with explicit ownership, direct dependency selection, preserved
production outcomes, reviewed cuts, and measurable deletion.

## Decision

Mono-agent v1 is one pnpm monorepo of lockstep-released first-party packages.
One agent is described by one strict `mono-agent.config.json`. Replaceable
framework semantics are selected through typed capability slots, each naming an
exact installed package with `$use`. Products, project tools, instructions,
schedules, and host services retain separate authoritative surfaces.

Implementation follows three rules:

1. **Reading rule:** every active behavior traces to one visible declaration in
   the owning file.
2. **Writing rule:** behavior changes in the order install, select, restart;
   none of those steps is implicit.
3. **Replacement rule:** a v1 mechanism and deletion of the v0 mechanism it
   replaces land in the same gate. Temporary entry points may call one converted
   implementation, but a forked second implementation is forbidden.

## Repository lineage and publication

The successor repository has a deliberately clean history:

- Its seed is the audited Git-tracked tree of predecessor commit
  `79140866712145cb5cc3e2b742445db4fb1b4df8`, plus the documented bootstrap
  sanitation and deployment guard.
- The final state of predecessor PR #542 was applied as one patch. Its ten
  historical commits were not replayed into the successor.
- The predecessor's complete Git history remains a separate private archive.
  It is not merged, grafted, or made reachable from successor refs. A needed
  maintenance change may cross the boundary only as an audited patch.
- Content-identical blobs or trees independently recreated by an audited patch
  may retain their deterministic Git object ids. Shared content ids do not
  establish lineage. Predecessor commits, tags, remote refs, merge ancestry,
  and predecessor-only history objects must not be imported or reachable.
- The successor is the public clean-history development repository. Public
  visibility does not authorize package publication, deployment, consumer
  restart, live-service repointing, or canonical-name cutover. Working-tree and
  reachable-history secret scans, OSS checks, branch protections, and release
  readiness remain G8 gates.
- `refs/tags/archive/v0-final-full` is an annotated successor archive tag whose
  peeled commit is the audited clean-history final-v0 archive SHA.
  `refs/heads/v0-maintenance` is a protected successor maintenance branch at the
  same commit. They are created together with an atomic ref update only after
  the reviewed archive-source PR merges. The successor never creates a
  `v0.16.0` tag. Neither archive ref is the private full-history archive.

Repository renames do not change these roles. Until the deployment guard is
removed in a reviewed cutover, the successor cannot publish packages, deploy or
restart consumers, or repoint live services.

V1-005 performs that repository-role cutover as two reviewed PRs because the
successor is squash-only. V1-005A records and performs every named consumer pin,
dormant-surface action, rollback rehearsal, source-URL transition, and sanitized
evidence update while the root bootstrap guard remains present. Only after A is
merged does V1-005B start from its exact main SHA, add the final repository
attestation, establish public clean-history `mono-agent-next` as canonical, and
remove the guard. B does not publish, deploy, restart, or repoint anything; its
parent proves the guard remained present through every prerequisite.

## Authoritative configuration surfaces

Each concern has one owner:

| Concern | Authoritative surface |
| --- | --- |
| Installed code | `package.json` and the project lockfile |
| One agent's behavior | `mono-agent.config.json` |
| Project-specific model tools | `.mcp.json` |
| Model instructions and workflows | `skills/` |
| Scheduled prompts | `cron/*.md` |
| TUI, web, service, and docs behavior | Product-specific config when needed |
| Independent collectors and watchdogs | Project or host operations |

Agent configuration is strict JSON with `configVersion: 1`. Unknown fields
fail. Paths resolve relative to the config file. `$schema` identifies the
schema composed for the exact locked dependency graph. `$env` is allowed only
at schema-approved scalar positions; missing values fail, secret fields reject
inline literals, and explain output reveals the variable name but never its
value.

JSON values are not implicitly overridden by the environment. There is no
interpolation, inheritance, profile overlay, alias mapping, package scan,
self-registration, local-path module, runtime installation, or hot reload.
Alternate profiles are separate config files.

## Typed module boundary

Agent configuration exposes seven typed slots:

| Slot | Cardinality | Stable identity |
| --- | --- | --- |
| `runtimes` | Zero or more | Map key |
| `channels` | Zero or more | Map key |
| `memory` | Zero or one | Slot |
| `state` | Zero or one | Slot |
| `triggers` | Zero or more | Map key |
| `observability.exporters` | Zero or more | Map key |
| `policy.sandbox` | Off or one | Slot |

Presence means selected; there is no redundant `enabled` flag or generic
`config` wrapper. A map key identifies a configured instance while
`$use` identifies its implementation. The loader resolves only the literal
package identities named by `$use`, requires direct project dependencies
pinned by the lockfile, checks capability kind and API version, and composes the
package-owned leaf schema. Import and validation are side-effect-free: they do
not read secrets, access the network, spawn processes, install code, start
lifecycle work, or mutate project or host state.

Runtime, channel, and memory are open slots. `module-sdk` publishes their
focused factories and compliance suites for third-party implementations. State,
trigger, exporter, and sandbox are reserved slots: they use the
same internal typed shape, but their factories remain private until a second
real implementation justifies promotion after v1.

Every module declares one package identity, version, `apiVersion: 1`,
capability kind, responsibility, executable schema, optional bounded
diagnostics, and optional namespaced maintenance or authentication commands. A
module receives only declared host capabilities and cannot contribute behavior
outside its kind.

## Dependency and ownership boundaries

```text
create-mono-agent -> package.json + lockfile + agent config

cli -> core -> module-sdk
configured modules -> module-sdk
core MCP client -> project MCP services

channel-operator -> operator protocol <- tui
                                      <- web

service-macos -> validated core runner
docs-mcp -> coding clients
```

Core owns config loading and provenance; request, turn, session, admission,
concurrency, cancellation, settlement, and backpressure; runtime selection and
fallback; context, skills, MCP, tools, approvals, and sandbox negotiation;
normalized events, health, startup, drain, and shutdown; and bounded grants to
the selected component that needs them.

Core does not own provider SDKs or authentication, transport mechanics, memory
algorithms, storage formats, exporters, renderer state,
documentation search, package installation, setup wizards, OS service
definitions, or arbitrary process supervision. It imports no concrete runtime,
channel, memory, state, trigger, exporter, sandbox, renderer,
documentation server, or service manager.

Ordinary domain integrations remain MCP servers. Know-how remains a skill.
Scheduled work is a trigger plus Markdown. Independent services and watchdogs
remain outside core. A typed module is appropriate only when replacing a
framework semantic; a UI is a product over the operator protocol.

## Runtime, delivery, and durable-state invariants

- Routing names a configured runtime instance and a runtime-owned model id.
  Core does not invent a universal provider field. Runtime modules own
  authentication, discovery, native sessions, retry, and model validation.
- Fallback crosses an attempt boundary, not a provider-private session.
  Canonical settled transcript supplies continuity. Eligibility checks required
  tools, MCP, attachments, approvals, structured output, and sandbox policy.
  Fallback never widens permissions or blindly repeats a committed
  non-idempotent effect.
- State commits user-visible input, settled output, AskUser evidence, verbatim
  appends, selected route, and provider-session linkage only after settlement.
  Provider-native sessions are an optimization, never the only history.
- Channels own transport authentication, normalization, reply streaming,
  advertised capabilities, delivery tools, allowlists, redaction, bounded
  health, and idempotent stop. Configuration, authentication, and structural
  errors fail closed. Transport loss is visible degradation with bounded
  recovery and cannot report healthy.
- Triggers initiate work but do not become communication channels. Cron owns
  job discovery and schedule, overlap, watchdog, and delivery intent; an
  explicitly referenced proactive channel performs delivery.
- v1 grants no privileged host capability to MCP servers. Project tools remain
  ordinary MCP calls within the originating turn. Durable detached work owns
  its lifecycle outside mono-agent and re-enters through an existing explicit
  channel or webhook boundary.
- Every durable module documents ownership, atomicity, idempotency, schema
  versioning, retention, backup and restore, reset and purge, corruption
  behavior, permissions, and redaction. Crash tests prove atomic completion or
  explicit recoverable state.
- `memory-local` creates a missing SQLite database exclusively through a
  no-follow descriptor and applies owner-only permissions to that new
  descriptor. It rejects a pre-existing database unless descriptor-based proof
  establishes a regular file, the expected owner and `0600` mode, and stable
  device/inode identity across path inspection and open. It never repairs or
  path-chmods pre-existing operator data. Symlink and path-swap adversarial
  tests must fail closed without modifying the target.
- A newly scaffolded BuJo root retains its canonical
  `.first-run-memory-initializing` marker for the root's lifetime. The marker is
  created exclusively as an owner-owned, `0600`, single-link regular file with
  `wx+`; its descriptor writes `initializing:<uuid>\n`, then commits
  `initialized:<same-uuid>\n` only after durable generation publication. No
  marker pathname is renamed, replaced, or unlinked. Before and after commit,
  the implementation proves exact token-bound bytes, descriptor/path
  device-inode identity, owner, mode, link count, and stable root identity.
  Failure retains the inspectable in-flight root. Doctor treats an in-flight,
  malformed, permissive, multi-link, swapped, missing-after-read, or legacy
  `.first-run-memory-initializing.released-*` marker as incomplete. V1-042 owns
  this durable memory contract and V1-045 consumes it for scaffolding.

## Product and operator boundaries

- `channel-operator` is an explicitly selected, bearer-authenticated loopback
  endpoint for the shared operator protocol. It owns HTTP lifecycle and maps a
  client disconnect, explicit cancel, drain, and stop to the exact Core
  dispatch signal. It does not publish discovery state or start a product.
- `operator` is the headless strict protocol, single bounded NDJSON client,
  owner-private directory reader, identity binding, capability negotiation,
  deterministic domain reducer/action eligibility, and golden fixtures. TUI
  and web may not implement a second decoder or action policy.
- TUI is a standalone pi-tui renderer. It accepts a direct authenticated
  loopback endpoint or an owner-private registry selection; it has no embedded
  responder, agent-config reader, local runtime, replay/config pane, or
  self-configuration authority.
- Web is a separately configured authenticated product. Its strict
  `web.config.json` owns listener, environment-referenced bearer,
  `allowInsecureHttp`, data directory, and registry roots. Loopback is the
  default. Plaintext non-loopback use requires an explicit risk opt-in and a
  stronger token, and HTTPS remains the recommended boundary.
- Web owns service turns and owner-private atomic JSON conversation state, so
  browser response disconnect/reload does not abort upstream work. Product
  stop or explicit cancel does. Its SQLite file is an exclusive process lease,
  not the conversation store.
- The first runnable operator slice implements text turns, streaming assistant
  deltas/activity, cancellation, runtime overrides, health, durable web
  conversations, and browser-disconnect survival. Attachments, quotes, live
  input, AskUser in the web renderer, proactive delivery, config/replay views,
  notifications, multi-user accounts, TLS, and product service management are
  not implied by the shared schema and remain outside this slice.
- `service-macos` is a separate desired-state product over launchd. It can
  inspect, plan, apply, and remove a validated runner, but it does not own agent
  turns, channels, memory, products, dependency installation, or agent config.
- The existing `create-mono-agent` package is refactored into the
  schema-derived scaffolder; it is not a newly invented package.
- The existing `docs-mcp` package is refactored into an ordinary companion
  MCP registered by coding clients; canonical `docs/` remain its source.

Loading or validating agent config never starts or reconciles a product.
Programmatic APIs are primary and CLI commands are optional frontends.

## Package and release model

The planned roster contains 23 publishable packages:

| Category | Packages |
| --- | --- |
| Kernel | `module-sdk`, `core`, `cli` |
| Runtimes | `runtime-pi`, `runtime-claude`, `runtime-codex`, `runtime-opencode` |
| Channels | `channel-telegram`, `channel-slack`, `channel-webhook`, `channel-openai-api`, `channel-operator` |
| Trigger | `trigger-cron` |
| Durable capabilities | `memory-local`, `state-local`, `exporter-otlp`, `sandbox-srt` |
| Operator | `operator`, `tui`, `web` |
| Project tooling | `create-mono-agent` |
| Host product | `service-macos` |
| Companion MCP | `docs-mcp` |

Package count is reported, not gated. Each package must represent one coherent
ownership and failure boundary. First-party packages remain on a lockstep
release. The name `plugin-sdk` appeared only in abandoned design work; no
publishable v0 `@mono-agent/plugin-sdk` package shipped, so it is not a
retired package or deletion target.

## Licensing decision and authority

Until V1-010 passes, the repository and every first-party package manifest
remain GPL-3.0-only. The intended post-gate package split is conditional on
V1-010's provenance and authority proof:

- `module-sdk` and `operator` may be marked Apache-2.0 extension seams only after
  V1-010 proves and commits the required authority.
- Every other first-party package remains GPL-3.0-only.
- Third-party modules and renderers choose their own license.

This decision does not itself relicense existing GPL code. The successor seed
is GPL-3.0-only. Apache-licensed seam code must be newly authored for that package
under Apache-2.0 or covered by explicit, documented permission from every
relevant copyright holder. Copying or adapting GPL code into an Apache package
and changing its manifest without that permission is forbidden.

Before V1-010 may mark either package Apache-2.0, it must commit a reviewed
file-level provenance and authority report, add package license files and
matching manifest fields, and make the inbound contribution terms explicit for
future changes to differently licensed packages. Any file with incomplete
authority remains GPL-3.0-only or is reimplemented without copying protected
expression. The G8 license gate verifies the report, package manifests, license
files, and generated third-party notices at the candidate SHA.

## Explicit cuts and retained proofs

First-party v1 does not include conversational self-configuration,
`tui --configure`, lite or journal memory, WhatsApp, Supermemory, the
generic orchestrator extra, A2A, continuations, `continuation.claim`, and every
continuation configuration, environment, schema, validation, CLI, and discovery
surface, historical backfill or resend, generic or path
plugins, package self-registration, runtime package installation, child-run
host grants, `context.soulPath`, user-facing compaction tuning,
`append-host-summary`, or one all-products config.

The self-configuration cut removes the generated
`mono-agent-configure` skill and its default selection, proposal authority,
transactions, configure-only UI, and the embedded/local TUI responder path.
Run the agent in the foreground when a supervisor is absent, select
`channel-operator`, and connect the separate `mono-agent-tui` product.

The historical-backfill cut removes only the backfill CLI/application.
`packages/observability/src/run-export-mapping.ts` and
`packages/observability/src/session-mapping.ts` remain live export and
public compatibility seams and are not V1-006 deletion targets.

`@anthropic-ai/sdk` is not presumed unused: the direct dependency currently
satisfies `@anthropic-ai/claude-agent-sdk`'s `>=0.93` peer while Pi
brings 0.91.1. V1-006 removes it only if packed-install peer and runtime proofs
pass; otherwise it is retained.

A2A and continuations are archive/revival candidates, not first-party v1
capabilities: none of the eight active consumer configs, environments, managed
runtime packages, or processes selects either. Their only production evidence
was the retired `~/a8c-agents` fleet, which must remain stopped.

Runtime-codex, runtime-opencode, and sandbox-srt are retained as explicit product proofs even
without a selected migration-fixture consumer. They must pass the same
compliance and live-smoke requirements as consumer-backed modules.

Deleted v0 source remains recoverable from the final clean-history v0 ref.
Revival uses the capability ladder and v1 contracts; it does not restore code
to core.

## Complexity and maintainability gates

V1-002 commits and reproduces the authoritative 182,217-line, 523-file
measurement with a tracked-file classifier, included-file manifest, snapshot
and manifest digests, and separate production/test reports. The complete
snapshot is 523 production files / 182,217 lines, 439 test files / 179,145
lines, and 62 excluded-with-reason files / 17,659 lines: 1,024 executable files
and 379,021 lines in total. Generated files are excluded only with a recorded
generator and reproducibility proof. Every executable source file is
classified; unknown files fail the gate report.

Binding gates are:

| Measure | Gate |
| --- | --- |
| `core` + `module-sdk` + `cli` production source | At most 15,000 lines |
| Repository production source at G8 | At most 130,000 lines from the 182,217 baseline; roadmap-rounded 28.66% reduction and 71.34% retained |
| Config representation | One authoritative schema field; projections generated |
| Operator implementation | One shared wire client and domain state |
| Minimal no-memory scaffold | Zero native modules |
| Minimal selected dependency closure | Measured at G1 and ratcheted |

The report also tracks exports, dependency edges, cycles, config fields,
selected closure, and duplicate protocol or config implementations. Reducing
tests never satisfies the production budget. A line target never justifies
weaker reliability, mixed lifecycles, removed required tests, or unreadable
compression.

The 130,000-line cap is binding. The 28.66% reduction and 71.34% retained share
are roadmap-rounded labels, not second gates; the report records the exact
reduction from the 182,217-line successor baseline.

## Migration, rollback, and release

G0 first accepts this ADR, then V1-002 commits the reproducible normalized
baseline artifact, then V1-003 classifies every behavior against it. No product
deletion starts before all three are complete.

Task completion and aggregate gate closure are separate at G0.25. V1-004's two
successor PRs run the default/G0 ledger checks and their dedicated archive
evidence checker; they do not run aggregate `--stage G0.25`, whose V1-005 live
consumer and canonical-transition evidence cannot exist yet. V1-004 completes
when both PRs and the archive evidence are green. Full G0.25 closes only after
V1-005 commits and validates every pin, rollback, retired/dormant-surface, and
canonical-transition artifact.

The predecessor remains the release authority for the final complete v0,
`v0.16.0`. Restored predecessor Actions billing or a separately approved and
authorized release path is a prerequisite because current predecessor release
jobs fail before their first step. The guarded successor's required
credential-free PR dry run is packaging verification, not a fallback publisher:
it builds every catalog-publishable tarball, confines `--force` to npm's
non-mutating `--dry-run` branch, strips npm and OIDC credentials plus ambient
force/dry-run configuration, uses exact neutral npm configuration from the
private tarball directory, and performs no explicit registry-integrity
inspection, publish, or dist-tag promotion. npm may read public metadata as part
of its own dry-run validation. A real publish remains guarded, authenticated,
and never receives `--force`.

V1-004 uses this exact sequence:

1. A predecessor release PR applies the reviewed final-seed payload and the
   lockstep `0.16.0` version, merges to predecessor `main`, creates predecessor
   tag `v0.16.0`, publishes, and verifies the public registry artifacts.
2. Successor PR A applies the equivalent final-v0 release-payload and version
   patch while the bootstrap guard remains present. Its squash merge defines
   `ARCHIVE_SHA`; predecessor commits and refs do not cross.
3. One atomic ref update creates annotated
   `refs/tags/archive/v0-final-full`, peeled to `ARCHIVE_SHA`, and protected
   `refs/heads/v0-maintenance` at `ARCHIVE_SHA`. No successor `v0.16.0` tag is
   created. Successor maintenance releases remain in the `0.16.x` line.
4. Successor PR B adds the validated
   `refactor/evidence/g0.25/v0-archive.json` without moving either archive ref.
   It records predecessor tag/main identity; the complete package set, versions,
   manifests, dependency/publish order, allowlisted release-source digests,
   packed tarball integrities and registry matches; `ARCHIVE_SHA`; archive tag
   object and peeled commit; protected maintenance branch; guard presence at
   both PR heads; absence of a successor `v0.16.0` tag; and clean-history
   separation. Whole-repository tree equality is not required because
   successor-only guard, governance, and G0 evidence remain outside the defined
   release payload.

Before any V1-005 mutation, a machine-validated inventory freezes the current
values for every execution or source-link surface in these categories:

- the eight managed agents: Personal Agent, Ambra Sleep, Therapy/Council, A8C
  Assistant, Test, Inner Child, Transcription, and Finances;
- shared controller and maintenance LaunchAgents, plus Personal Agent's watchdog
  and session-web services;
- the mono-agent web service on port 5050, including a coherent SQLite/WAL
  backup made through a database-safe snapshot boundary rather than independent
  pathname copies;
- Codex and Claude docs-MCP registrations;
- `~/.local/bin`, Personal and A8C bins, NVM/Homebrew links, memory-recall
  wrappers, and service wrappers;
- dormant `ai.mono-agent.final-demo-gemma4` and
  `ai.mono-agent.multi-agent-demo` plists, targeted stale Tailscale Serve
  handlers on ports 5417-5420, and retired `~/a8c-agents`, which remains stopped.

Every inventory row records the exact path, process/PID or service label,
configuration hash, package closure and CLI hashes, ports, source-repository
references, immutable `0.16.0` target, retained rollback target and command,
health proof, and explicit disposition. Values are captured immediately before
the first mutation rather than hard-coded in this ADR. Each explicitly
authorized consumer is then pinned through its own lifecycle to the exact
predecessor-published registry artifact, never to successor code, with bounded
startup, channel ownership, memory, process, and rollback proof. The final
inventory proves that no executable surface resolves either repository's
`main`; sandbox-readable historical paths are separately classified as
non-execution references.

V1-005A commits that evidence and every dormant-surface/revival record while the
guard is still present. After A merges, an immediate read-only re-probe from its
exact main SHA must show no drift. V1-005B then adds only the final repository
attestation and guard-removal/canonical metadata. Its parent proves the guard
remained present through every prerequisite and its reviewed SHA proves the
guard absent. B performs no publish, deployment, consumer restart, or
live-service repointing.

The predecessor's registry credentials do not transfer. V1-048 must then
establish and verify an explicitly approved successor `NPM_TOKEN` Actions
secret or a reviewed trusted-publishing replacement that supports the complete
publish and dist-tag workflow; no credential is assumed, copied, or committed.
Only after the exact packed candidate, guard-absent SHA, and redacted authority
preflight are green does V1-048 publish and registry-verify the beta. V1-049
installs that exact beta and revalidates the canonical repository and
guard-removal proof before any Personal Agent cutover; it does not publish
another version. Repository-role transition, package publication, and consumer
operations remain separately bounded actions.

The retired fleet and dormant jobs remain archive evidence only. V1-005 proves
the two dormant jobs unloaded, recoverably archives their KeepAlive plists, and
removes only the inventoried stale Tailscale Serve handlers after recording
rollback data; a global Serve reset is forbidden.

There is no v0 config parser or public API shim in v1. Each consumer receives an
explicit v1 config, exact selected dependency closure, migrated MCP/skills/jobs,
separate product config, and field-by-field disposition.

Only BuJo memory state is adopted as canonical v0 state. Old conversation
history, provider sessions, run artifacts, web
conversations, logs, and caches are not imported; required copies remain
read-only through the rollback window. Memory requires audited backup, clone
rehearsal, compatibility proof, and integrity checks.

Personal Agent migrates first at a session rollover boundary using isolated
services and disabled Telegram shadow delivery. The active A8C Assistant
migrates only after Personal Agent passes rollback proof and a 24-hour soak;
its acceptance matrix is Slack, webhook, cron, BuJo, auth, state, and exact
single-consumer identity. Duplicate channel consumers, memory corruption, hidden
auth failure, unprovable process identity, false health, missed schedules,
crash loops, or secret exposure trigger rollback.

Rollback stops and proves death of v1, audits memory, restores a complete
backup only when needed, restarts the retained v0
release, and proves version, config, process, channel, and health identity.

## Consequences and rejected alternatives

This decision makes project composition explicit, keeps the kernel small, and
lets third parties replace only stable framework semantics. It also requires
more visible package identities, separate product configuration, a deliberate
install/select/restart workflow, and migration rather than transparent v0
compatibility.

The following alternatives are rejected for v1:

- continuing to grow `agent-app`;
- a parallel greenfield implementation that leaves v0 machinery intact;
- a generic plugin registry or package discovery;
- independent first-party package versions;
- one agent-and-products mega-config;
- a universal provider abstraction or provider-session migration;
- an SSE operator rewrite;
- importing old conversational and run history;
- making the private predecessor history public or joining it to the successor;
- removing the deployment guard before final v0 release and consumer pinning.

Architecture questions cite this decision. Behavior disposition lives in the
generated requirement report, and delivery status remains in
`refactor/mono-agent-v1-prd.md`. Any change to these decisions requires a
reviewed ADR amendment; execution discoveries update the PRD in the same PR.

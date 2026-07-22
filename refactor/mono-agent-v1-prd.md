# Mono-Agent v1: Smaller by Design

Status: Accepted by `docs/reference/v1-architecture.md` (V1-001); execution in progress
Target release: 1.0 beta, followed by 1.0 stable
Last updated: 2026-07-22
Primary audience: maintainers, contributors, and individual agent builders
Decision scope: complete v1 architecture, configuration, deletion ledger, migration, and production rollout

## 1. Executive summary

Mono-agent v1 is a production-grade, config-first wrapper around independently selected agent runtimes. Its user-facing center is one strict `mono-agent.config.json` describing one portable agent. The host loads runtime, channel, memory, state, trigger, exporter, and sandbox implementations only through typed capability slots. Every replaceable implementation is visible at the point of use through an exact `"$use"` package reference.

There is no generic `plugins` registry, no hidden built-in-name-to-package mapping, no package self-registration, and no runtime package download. Stable instance ids are config keys; `$use` identifies the installed implementation. Project-specific model tools remain ordinary MCP servers in `.mcp.json`, instructions remain skills, scheduled work remains Markdown, and independent collectors or watchdogs remain project or host operations.

Config-first does not mean mega-config-first. TUI, web, service-macos, docs-mcp, and create-mono-agent have independent ownership and lifecycle. They are installed explicitly and use their own small configuration, if they need configuration at all. TUI and web consume one shared operator protocol exposed by an explicitly selected operator endpoint inside the agent. service-macos is only macOS boot integration; the agent remains usable in foreground or under another supervisor when it is absent.

The product of this refactor is a smaller system. The authoritative stacked clean-successor G0 baseline is 182,217 handwritten production-source lines across 523 files and 22 publishable packages; agent-app alone holds approximately 66,000. Stable v1 ships at most 130,000 lines — the binding number, with a roadmap-rounded 28.66% reduction and 71.34% retained while the exact percentage remains report output rather than a second gate — and core + module-sdk + cli are capped at 15,000 lines. These are machine-tracked release gates.

Package count is not a success metric. The current v1 roster contains 23 publishable packages because runtimes, communication transports, durable stores, operator products, and host integration have genuinely different ownership and failure boundaries. Architecture gates protect narrow responsibilities and selected dependency closure; they never combine unrelated concerns merely to reduce a count.

The v1 distribution remains one pnpm monorepo releasing first-party packages in lockstep. An agent project owns an ordinary `package.json` and lockfile. Configuration selects only already-installed packages and never turns a JSON edit into remote code installation. The intended distribution is open source with a deliberate license split: implementations are GPL-3.0-only while the `module-sdk` and `operator` extension surfaces are Apache-2.0, so third-party modules and renderers may carry any license when their file-level provenance and licensing authority support that declaration (section 2.6).

Implementation occurs in the public clean-history successor described in section 2.7. Public repository visibility does not authorize package publication, release, deployment, consumer restart, live-service repointing, or removal of the successor deployment guard.

### 1.1 The one-page mental model

A mono-agent project is an ordinary directory, and understanding any agent means answering three questions in order:

1. **What code exists here?** `package.json` and the lockfile answer completely. Installing or removing a dependency is the only way code enters or leaves; no config edit, no download, no discovery.
2. **What does this agent use?** `mono-agent.config.json` answers completely. Presence means selected; absence means off. Every replaceable choice names its implementation at the point of use — the map key is the instance's stable name, `$use` is the exact installed package.
3. **Who owns everything else?** The scope table in section 2.1: model tools live in `.mcp.json`, instructions in `skills/`, schedules in `cron/*.md`, and each product (TUI, web, service-macos, docs-mcp) has its own small config. Nothing outside a file's scope can be caused by that file.

Two rules follow, and they are the contract this architecture defends:

- **Reading rule** — every behavior of a running agent traces to one visible line in one of those files. If no line selects it, the behavior does not exist. There is nothing to discover that the files do not say.
- **Writing rule** — behavior changes in exactly this order: install (`package.json`), select (config), restart. No step happens implicitly, and no later step can occur without the earlier one.

When extending, ask "what is my thing?" before "how do I hook in": a tool is an MCP server; know-how is a skill; a schedule is a Markdown job; durable detached work is an external service that re-enters through an explicit channel or webhook; a new user interface is an operator product; only a replacement for a framework semantic is a typed module. The full ladder is section 2.3.

Hold this page and the rest of the document is elaboration; the architecture's job — and its gates' job — is to keep this page true.

Stable v1 must prove all of the following:

- a minimal Pi + webhook agent installs no unselected channel, UI, memory, exporter, service, or native module and completes one real turn;
- every configured capability names its exact package through `$use` and fails validation when the package is absent, the package kind is wrong, or its API version is incompatible;
- `config explain` identifies the owning schema, effective source, and safe remediation for every resolved value;
- one project-owned MCP integration works without a core change, first-party catalog edit, or custom mono-agent module;
- Pi and Claude SDK can coexist, with routing expressed as explicit `runtime` and runtime-owned `model` fields;
- TUI and web produce equivalent operator domain state and available actions from shared fixtures while retaining platform-native presentation;
- the sanitized Personal Agent fixture preserves the current runtime policy, local providers, BuJo memory, channels, cron, project MCP wiring, state, and Phoenix export without selecting products in its agent config;
- the section 2.6 open-source distribution checklist passes: package licenses match the declared split, notices and governance files exist, and the community-module discovery page is generated;
- a fresh clone at the approved publication candidate contains no predecessor-history refs, passes working-tree and reachable-history secret scans, and retains the successor deployment guard until final v0 release and consumer pinning are proved;
- Personal Agent and the active A8C Assistant pass their capability matrices, rollback rehearsals, exact single-consumer proofs, and 24-hour soaks.

## 2. Normative product decisions

### 2.1 Configuration scopes

Each concern has one authoritative owner:

| Concern | Authoritative surface | What does not belong there |
| --- | --- | --- |
| One agent's behavior | `mono-agent.config.json` | TUI/web lifecycle, macOS service installation, documentation-client registration |
| Project-specific model tools | `.mcp.json` | Framework runtime, memory, channel, or trigger replacement |
| Model instructions and workflows | `skills/` | Host lifecycle or hidden credentials |
| Scheduled agent work | `cron/*.md` | Long prompts duplicated in JSON |
| Installed code | `package.json` and lockfile | Activation inferred merely from package presence |
| TUI/web/service/docs behavior | Product-specific config, only when needed | Agent runtime policy |
| Independent collectors and watchdogs | Project or host operations | Core as a generic process supervisor |

This separation is normative. A single all-products JSON file is explicitly rejected because independently deployed products have different lifecycles, permissions, and failure modes.

### 2.2 Explicit typed modules

Agent configuration has typed slots, not a generic plugin plane:

| Slot | Cardinality | Stable identity | Implementation |
| --- | --- | --- | --- |
| `runtimes` | zero or more | map key | required `$use` |
| `channels` | zero or more | map key | required `$use` |
| `memory` | zero or one | slot itself | required `$use` when present |
| `state` | zero or one | slot itself | required `$use` when present |
| `triggers` | zero or more | map key | required `$use` |
| `observability.exporters` | zero or more | map key | required `$use` |
| `policy.sandbox` | off or one implementation | slot itself | required `$use` when active |

The map key answers “which configured instance?” and `$use` answers “which code implements it?”. They are intentionally separate. This permits two instances of one module, stable cross-references, and implementation replacement without renaming routes or jobs. Singleton slots (`memory`, `state`, `policy.sandbox`) have no second identity to learn: the slot name itself is the stable id.

Presence means selected. There is no repetitive `enabled: true` and no nested generic `config` wrapper. A selected module validates its remaining inline fields. `$use` is a literal package identity, never an alias, environment reference, local path, or inferred mapping.

The loader:

1. resolves exactly the packages named by `$use`;
2. requires each to be a direct project dependency pinned by the lockfile;
3. verifies its declared capability kind and API version against the containing slot;
4. composes and applies the package-owned leaf schema;
5. performs no installation, self-registration, lifecycle start, or host mutation while loading or validating.

### 2.3 MCP-first extension ladder

Project authors should not create a mono-agent module for ordinary integrations:

| Desired capability | Lowest correct boundary |
| --- | --- |
| The model calls a project or domain tool | MCP server in `.mcp.json` |
| Work must outlive the originating turn | External service with its own durable lifecycle and explicit delivery through an existing webhook or channel |
| The model needs instructions for an existing CLI or MCP | Skill |
| Work should run on a schedule | Trigger module plus Markdown job |
| An external system pushes a request into the agent | Existing webhook channel |
| A process collects data independently | Project or host service |
| A process must detect complete agent death | Host watchdog outside the agent |
| Automatic runtime, channel, memory, state, trigger, exporter, or sandbox semantics must be replaced | Narrow typed module package |
| A new user interface is needed | Product consuming the operator protocol |

A stdio MCP child may be started and stopped by the configured harness. A remote MCP server owns its own process lifecycle. Mono-agent does not turn MCP into a generic daemon manager.

Model-visible tool names and orchestration UX remain MCP-owned. First-party v1 grants no privileged host capability to an MCP server. The broader child-run capability family is deliberately deferred; section 12.3 records the old design only as archive/revival material that requires a new consumer and ADR before admission.

### 2.4 Product boundaries

- `channel-operator` is an endpoint selected inside an agent and serving the shared operator protocol.
- `operator` is a headless library containing that protocol, client, directory, domain state, and fixtures.
- `tui` and `web` are separate products consuming operator. Neither is selected by the agent config.
- `service-macos` is a separate product that reconciles macOS launchd state from its own config. It starts a validated agent runner but does not own turn, channel, memory, or product semantics.
- `docs-mcp` is an ordinary companion MCP for authoring and documentation lookup. It is configured in the coding client's MCP configuration, not in the running agent.
- `create-mono-agent` is a scaffolder. It writes files and dependency manifests before the agent exists; it is never part of the agent runtime graph.

Installing software and registering an OS service necessarily require an installation or reconciliation action. JSON remains the desired-state source, but a file cannot register itself with launchd merely by existing. Programmatic APIs are primary; CLI commands are optional frontends.

### 2.5 Explicit v1 cuts

The following do not exist in first-party v1:

- conversational self-configuration and `tui --configure`;
- `lite` and `journal` memory modes;
- WhatsApp;
- Supermemory;
- the generic orchestrator extra;
- A2A;
- continuations, the `continuation.claim` host grant, and every continuation
  config, environment, schema, validation, CLI, and discovery surface;
- historical backfill/resend;
- a generic plugin registry, tool-plugin kind, extension-plugin kind, package self-registration, or single-file path plugin;
- request-scoped child-run host capabilities (`request.context`, `request.progress`, `agent.run.spawn/observe/cancel`) — designed but deferred, with the design recorded in section 12.3;
- the v0 second persona file (`context.soulPath`) — identity remains a single instructions file;
- user-facing compaction tuning knobs — compaction policy is runtime-owned;
- the `append-host-summary` memory write mode — `capture` and disabled remain;
- one mega-config selecting agents, products, companions, and deployment.

Revival paths are recorded in section 12.3. A cut is a product decision, not a claim that every historical surface was unused; the three new field-level cuts above are additionally evidenced by zero fleet configs setting them.

Three surfaces are retained by explicit product decision despite having no selected consumer in the section 6 fixtures: `runtime-codex` and `runtime-opencode`, because independently executing multiple native runtimes is the product's differentiating showcase, and pi-provider access to the same model families does not exercise native app-server sessions, approvals, or cancellation; and `sandbox-srt`, the first-party implementation proving the `policy.sandbox` slot. All three pass the same capability matrices and live smokes as consumer-backed modules (G3, G5). Every other retention in the deletion ledger is held to the consumer-evidence test.

### 2.6 Licensing and open-source distribution

v1 is developed in a public open-source successor, while package distribution remains gated, and the license layout is part of the architecture because it decides who can build on which seam:

- `module-sdk` and `operator` are Apache-2.0. They are the two public extension surfaces — typed module contracts and the renderer protocol/client — so a third-party module or renderer that imports them may carry any license.
- Every other first-party package — core, cli, all first-party modules, and all products — is GPL-3.0-only. Forks and modifications of those packages remain GPL-3.0-only.
- Third-party typed modules and renderers choose their own license.

This decision does not relicense the GPL-3.0-only successor seed. Code in an Apache-2.0 package must be newly authored for that package under Apache-2.0 or covered by explicit documented permission from every relevant copyright holder. Copying or adapting GPL code into an Apache package and changing its manifest without that permission is forbidden. Before the split lands, V1-010 produces a reviewed file-level provenance and authority report and makes inbound contribution terms explicit for future changes to differently licensed packages. Any file with incomplete authority remains GPL-3.0-only or is independently reimplemented without copying protected expression.

Mechanically, every publishable package carries its own `LICENSE` file and a manifest `license` field matching this split, and the release pipeline generates a third-party notice inventory for runtime dependencies (the pi packages are ordinary MIT npm dependencies, not vendored code). The repository keeps `CONTRIBUTING.md` and `SECURITY.md` and adds `CODE_OF_CONDUCT.md` plus a short `GOVERNANCE.md` naming the maintainer decision model.

Third-party module discovery is deliberate but is not a marketplace: modules advertise the `mono-agent-module` npm keyword and their capability kind, and canonical documentation generates a community-modules page listing modules whose maintainers attest the public compliance suite passes. Listing is documentation, never endorsement, and never affects loading — installation remains an explicit `package.json` edit.

The G8 "OSS" exit is this checklist verified at the candidate SHA: the provenance and authority report supports every Apache-2.0 file; license files and manifest fields match the declared split; inbound contribution terms are explicit; the generated third-party notices are current; `CODE_OF_CONDUCT.md` and `GOVERNANCE.md` exist; the community-modules page and capability ladder are published. The Apache-2.0 target for `module-sdk` and `operator` is ratified in the G0 ADR subject to those provenance and authority gates.

### 2.7 Repository lineage and publication

The successor was seeded from the audited Git-tracked tree of predecessor commit `79140866712145cb5cc3e2b742445db4fb1b4df8` plus documented bootstrap sanitation and the deployment guard. PR #542 entered the successor as one final-state patch rather than a replay of its predecessor commits.

The predecessor's complete Git history remains a separate private archive. It is never merged, grafted, or made reachable from successor refs; a needed maintenance change crosses only as an audited patch. Content-identical blobs or trees independently recreated by that patch may retain their deterministic Git object ids without establishing lineage. Predecessor commits, tags, remote refs, merge ancestry, and predecessor-only history objects must not be imported or reachable. The successor is the public clean-history development repository. Public visibility does not authorize package publication, deployment, consumer restart, live-service repointing, or canonical-name cutover. Working-tree and reachable-history secret scans, OSS checks, branch protection, and release readiness remain G8 gates.

`refs/tags/archive/v0-final-full` is an annotated successor archive tag whose peeled commit is the audited clean-history final-v0 `ARCHIVE_SHA`, and protected `refs/heads/v0-maintenance` points at the same commit. They are created together with an atomic ref update after successor V1-004 PR A merges. The successor never creates a `v0.16.0` tag. Neither archive ref is the private full-history archive. Repository renames do not alter these roles.

Until the root deployment guard is removed during a reviewed canonical-repository cutover, the predecessor remains the live v0 source and the successor cannot publish packages, deploy or restart consumers, or repoint live services.

V1-005 performs that repository-role transition as two PRs because the
successor is squash-only. V1-005A merges every named pin, dormant-surface action,
per-consumer rollback proof, sanitized evidence artifact, and source-URL update
while the root bootstrap guard remains present. V1-005B starts only from A's
exact merged main SHA, adds the final repository attestation, establishes public
clean-history `mono-agent-next` as canonical, and removes the guard. B does not
publish a package, deploy or restart a consumer, or repoint a live service; its
parent SHA proves the guard survived every prerequisite.

The predecessor's registry credentials do not transfer to the successor.
Before any v1 beta publication, V1-048 must establish and verify an explicitly
approved successor publishing authority: either an `NPM_TOKEN` Actions secret
for the current staged-promotion workflow or a reviewed trusted-publishing
replacement that supports every publish and dist-tag operation. No credential
is assumed, copied, or committed. Publication remains blocked until the
canonical-repository cutover is complete, the bootstrap guard is absent at the
exact candidate SHA, the authority preflight succeeds without exposing secret
material, and the packed candidate is green.

## 3. Deletion ledger

This section is normative. Every deletion names its evidence or explicit product decision, replacement when one exists, archive source, and gate. Usage evidence includes config, CLI and flags, services, scheduled jobs, source imports, persisted state, and selected production-consumer matrices.

### 3.1 Archive and detach live consumers before deletion (G0.25)

The predecessor's normal `main` checkout is the live source for the local CLI and Personal Agent. The successor is development-only under its deployment guard. Phase A cannot begin while a consumer resolves either repository's `main`.

The predecessor is the sole final-v0 release authority. Its current Actions
runs are rejected before their first step by the account billing/spending-limit
state. Restoring hosted Actions or separately approving and authorizing the
documented local release path is a prerequisite to V1-004; the guarded
successor is not a fallback publisher. Its required credential-free PR dry run
is expressly permitted while the guard remains: it builds every publishable
tarball, pairs npm `--force` only with the non-mutating `--dry-run` branch,
strips npm/OIDC credentials and ambient force/dry-run configuration, uses exact
neutral npm configuration from the private tarball directory, and performs no
explicit registry-integrity inspection, publish, or dist-tag promotion. npm may
read public metadata as part of its own dry-run validation. It proves packaging
only; a real publish remains guarded, authenticated, and never receives
`--force`.

1. In a predecessor release PR, apply the reviewed final-seed payload and
   lockstep `0.16.0`, merge to predecessor `main`, create predecessor tag
   `v0.16.0`, publish, and registry-verify every artifact. This exact version is
   `v0-final` below.
2. In successor V1-004 PR A, apply the equivalent final-v0 release-payload and
   version patch while the bootstrap guard remains present. Its squash merge is
   `ARCHIVE_SHA`; no predecessor commit or ref crosses.
3. Atomically create annotated `refs/tags/archive/v0-final-full`, peeled to
   `ARCHIVE_SHA`, and protected `refs/heads/v0-maintenance` at `ARCHIVE_SHA`.
   Never create a successor `v0.16.0` tag. Successor maintenance releases remain
   `0.16.x`; the separate private predecessor remains the full-history archive.
4. In successor PR B, add validated
   `refactor/evidence/g0.25/v0-archive.json` without moving either archive ref.
   It records predecessor tag/main identity; complete package set, versions,
   manifests, dependency/publish order, allowlisted release-source digests,
   packed tarball integrities and registry matches; `ARCHIVE_SHA`; annotated tag
   object and peeled commit; protected branch target; guard presence at both PR
   heads; absence of a successor `v0.16.0` tag; and history separation.
   Whole-tree equality is not required because successor-only guard, governance,
   and G0 evidence sit outside the defined release payload. Independently
   recreated content-identical blobs or trees may share deterministic object ids
   without importing predecessor history.
5. Immediately before the first V1-005 mutation, capture a machine-validated,
   exhaustive inventory. It covers the eight managed agents (Personal Agent,
   Ambra Sleep, Therapy/Council, A8C Assistant, Test, Inner Child,
   Transcription, Finances); shared controller and maintenance LaunchAgents;
   Personal watchdog and session-web; the mono-agent web service on port 5050
   with a coherent database-safe SQLite/WAL backup; Codex and Claude docs-MCP
   registrations; `~/.local/bin`, Personal/A8C bins, NVM/Homebrew links,
   memory-recall wrappers, and service wrappers; the dormant final-demo-gemma4
   and multi-agent-demo plists; targeted stale Tailscale Serve handlers on ports
   5417–5420; and retired `~/a8c-agents`, which remains stopped.
6. For every inventory row, record exact paths, process/PID or service labels,
   config hash, package closure and CLI hashes, ports, source-repository
   references, immutable `0.16.0` target, retained rollback target and command,
   health proof, and explicit disposition. Classify sandbox-readable historical
   paths separately as non-execution references.
7. Pin each explicitly authorized inventory row through its own lifecycle to the
   exact predecessor-published `0.16.0` registry artifact, never successor code.
   Prove package version and closure, process command, config, channel ownership,
   memory, bounded startup health, and atomic per-consumer rollback.
8. Prove the dormant jobs unloaded, archive their KeepAlive plists recoverably,
   and remove only the recorded stale Tailscale Serve handlers; a global Serve
   reset is forbidden. Record revival source paths for every Phase A capability.
9. Prove no executable surface resolves either repository `main`. Commit every
   preceding action, sanitized artifact, and source-URL transition in V1-005A
   while the guard remains present, merge A, then re-probe its exact main SHA.
10. Start V1-005B only from that merged SHA. B adds the final repository
    attestation, establishes public clean-history `mono-agent-next` as canonical,
    and removes the root guard. This repository-only PR publishes nothing and
    does not deploy, restart, or repoint a live consumer.

Any executable surface still resolving repository `main`, incomplete rollback
or inventory evidence, real publish or live mutation from the guarded successor,
or early guard removal blocks G0.25. The credential-free dry run above is
verification, not an attempted release.

V1-004 task completion is intentionally earlier than aggregate G0.25 closure.
Its successor PR A and PR B run the default/G0 ledger checks plus their dedicated
archive/equivalence evidence checker. PR B must not require aggregate
`--stage G0.25`, because V1-005's live consumer and canonical-transition proofs
cannot exist yet. V1-004 completes after both PRs and the dedicated archive
evidence are green; full G0.25 runs and closes only at the reviewed V1-005B SHA
with all pin, rollback, retired/dormant, and canonical-transition evidence.

### 3.2 Phase A deletion on lean v0 main (G0.5)

| Item | Provisional source lines | Evidence or explicit decision | Replacement or revival |
| --- | --- | --- | --- |
| whatsapp-adapter | 2,082 | No selected v1 production consumer; removes Baileys dependency | Community channel candidate from archive |
| A2A provider/consumer | G0 measure | No active consumer selects it; its only live evidence was the retired A8C fleet | Archive/revival channel candidate |
| Continuation service, store, workers, host grant, and configuration/environment/schema/CLI validation and discovery | G0 measure | No active config, environment, runtime package, or process selects it; its only live evidence was the retired A8C fleet | Archive/revival capability candidate |
| memory-supermemory | ~700 | Explicit v1 cut; selected v1 consumers use local BuJo | Community memory-module candidate |
| agent-orchestrator extra | ~500 | Explicit v1 cut; no active consumer selects the generic broker | MCP or separate product candidate if a new consumer justifies it |
| Self-config engine, patch allowlist, transaction, `tui --configure` UI, generated `mono-agent-configure` skill, and default selection | G0 measure | Explicit v1 cut; ordinary `tui --local` still uses the non-configuring path in `createLocalConfigurationSession()` | Extract/retain ordinary local-session behavior; schema-derived init, explain, docs |
| Historical backfill CLI/application | G0 measure | Explicit v1 cut; live export and public mapping seams remain | Archived standalone tool candidate |
| Direct `@anthropic-ai/sdk` dependency evaluation | 0 | Currently satisfies `@anthropic-ai/claude-agent-sdk`'s `>=0.93` peer while Pi brings 0.91.1 | Remove only if packed peer/runtime proof succeeds; otherwise retain |

G0 replaces provisional counts with exact source and test counts. Removed CLI surfaces return precise guidance. TUI and web remove SELF-CONFIG affordances in the same change, but ordinary `tui --local` remains. V1-006 owns A2A and continuation deletion/source maps together with the other Phase A cuts. It must not delete `packages/observability/src/run-export-mapping.ts` or `packages/observability/src/session-mapping.ts`; they remain live export and public seams. No v1 mechanism is added during G0.5.

### 3.3 Phase B paired replacement and deletion

Each row lands one v1 implementation and deletes or retires the named v0 machinery in the same gate. A temporary compatibility entry point may call the converted implementation; a forked copy is forbidden. "Now" figures are bundle totals grouping related files across packages, not single-file clusters; G0's classifier replaces them with exact reproducible counts.

| Machinery | Now | Planning target | Gate | Preserved outcome or explicit cut |
| --- | --- | --- | --- | --- |
| Managed background and launchd closure | 14,350 | ≤2,500 in service-macos | G6–G7 | Separate service config; programmatic inspect/plan/apply/remove; pinned runner; validate-before-restart; honest status; no resurrection after stop |
| Setup wizard, init, provider setup | 12,500 | ≤3,000 in create-mono-agent | G1 | Schema-derived scaffolder; runtime-owned auth; bounded real route checks |
| Presets registry and command | ~1,000 | 0 | G1 | Scaffold templates land before deletion |
| Doctor orchestration | 3,517 | ≤500 in cli | G1 | Every check maps to core validation, typed-module diagnostics, or reviewed retirement; exit codes and JSON remain |
| Config reference implementation | 1,357 | 0 | G1 | Generated reference and explain land in the same slice |
| Durable history plus Pi compaction/session drivers | ~3,580 | ≤700 neutral transcript plus native bindings | G3 | Neutral transcript canonical; Pi owns native session and compaction details |
| Memory command and health plumbing | 4,157 | ≤800 module-owned maintenance surface | G5 | Retained BuJo commands move to memory-local |
| Memory rebuild/replay/forget internals | ~10,000 | ≤5,000 | G5 | Audit, rebuild, forget, and intake retry preserved |
| Lite and journal memory modes | G0 measure | 0 | G5 | Explicit cut; no automatic conversion |
| Presence and trace registry | 931 | ≤400 in state-local | G5 | Discovery and readiness remain |
| OTLP/Phoenix export and session mapping | ~1,571 | Focused exporter-otlp | G5 | Live export and session mapping remain |
| Threading/idempotency indexes | ~2,062 | Per-channel state helper | G4 | Delivery idempotency remains |
| Channel composition glue | 4,420 | ≤800 lifecycle in core/module-sdk | G4 | Per-channel health, steering, config, and degradation remain |
| App controller | 4,435 | ≤1,200 host loop in core | G1 | Load → validate → initialize → serve → drain → stop |
| Config package | 4,854 | ≤1,500 absorbed into core (counted in the kernel gate) | G1 | One agent envelope plus one schema per selected typed module |
| Repeated atomic-write and HTTP bootstraps | ~2,200 | secure-fs and HTTP helpers in module-sdk | G1–G4 | Express remains only in web; security semantics stay compatible |
| Harness orchestration, responder, context, sessions | ~7,000 | ~3,000 in core | G1–G3 | Turn/session coordination remains core |

## 4. Complexity and maintainability budget

The authoritative stacked clean-successor G0 baseline is 182,217 production-source lines across 523 files. The preliminary 2026-07-22 counter reported 182,118; the normalized classifier reclassified 83 test-helper lines and the nine-line TUI Vitest config to produce an original-v0 baseline of 182,026. The bootstrap initially removed one meaningless terminal blank line from `packages/agent-app/src/package-version.ts`, then reviewed seed hardening added 192 net production lines: 30 in `packages/memory/src/store/db-core.ts` for owner-only SQLite creation, 160 in `packages/agent-app/src/first-run-managed-memory.ts` for the permanent descriptor-bound first-run marker contract and its doctor snapshot revalidation, and 2 in `packages/agent-app/src/doctor.ts` for its doctor integration. Therefore `182,026 - 1 + 192 = 182,217`; this exact stacked head, not the pre-review seed, is the G0 authority. The final seed review then replaced one fixed-delay SSE test assertion with a bounded capacity-release probe, adding nine test lines and no production code. The exact final seed therefore reports 179,145 test lines across 439 files and 17,659 excluded-with-reason lines across 62 files, for 379,021 executable lines across 1,024 files. Its snapshot digest is `3e5ffd9a140519f490f391f5f3dc470269e68711ab72e6189a1089004e770054`, its classified-file manifest digest is `ad3c3255dbd404ea51a5f52814968d6a8499a1224b6f3db71eca6b793aa92b65`, and its committed baseline-file digest is `a984af137989d798c800202c37905c1a28deaf21d0d40da3961bbb4d888a441b`. The mixed webapp Vite config remains production because it owns shipped PWA/product build behavior. V1-002 commits `scripts/v1-complexity-report.mjs` and baseline report #1 so this lineage reproduces from a clean checkout. The report operates only on Git-tracked files and emits the included-file manifest, classification, line count, and digest. Every executable source file is production, test, generated, vendored, or excluded-with-reason; an unclassified source file fails the gate-exit report rather than every CI run, so budget honesty is machine-tracked without per-PR friction.

Production and test source are reported separately. Reducing tests never satisfies the production budget. Generated files are excluded only when their generator and reproducibility check are recorded.

| Budget | Gate |
| --- | --- |
| Kernel: core + module-sdk + cli | ≤15,000 production-source lines |
| Repository production source at G8 | ≤130,000 (binding); roadmap-rounded 28.66% reduction and 71.34% retained, with exact reduction reported |
| Package responsibilities | One coherent ownership and lifecycle boundary per package; count reported, not gated |
| Config representations per field | One authoritative schema field; generated projections are not parallel representations |
| Operator implementations | One shared wire client and domain state; renderer presentation remains local |
| Native modules | Minimal no-memory scaffold has zero; memory-local alone may retain better-sqlite3 and sqlite-vec through stable |
| Minimal scaffold closure | Measured at first G1 vertical slice and ratcheted |

Indicative ring allocation, derived from the section 3.3 targets and measured v0 sizes. These are planning figures for steering, not gates; complexity reports replace them with per-package actuals:

| Ring | Packages | Planning allocation |
| --- | --- | --- |
| Kernel | core, module-sdk, cli | ≤15,000 (gate) |
| Runtime modules | runtime-pi, runtime-claude, runtime-codex, runtime-opencode | ~12,000 |
| Channel modules | five channels | ~15,000 |
| Trigger and durable modules | trigger-cron, memory-local, state-local, exporter-otlp, sandbox-srt | ~14,000 |
| Operator layer | operator, tui, web | ~18,000 |
| Products and companions | create-mono-agent, service-macos, docs-mcp | ~6,500 |

The allocations sum to roughly 80,500; the 130,000 ceiling exists as honest slack, not a target. The 15,000-line kernel cap is at most 18.6% of that planning allocation, and the remainder sits behind replaceable module seams or independent product boundaries. The minimal-agent closure (kernel + runtime-pi + channel-webhook) is expected near 22,000 lines with zero native modules.

The report also tracks public exports, dependency edges, cycles, config fields, selected-package closure, and duplicated protocol/config implementations. Rules are paired deletion, one implementation, and boundary before budget. The 130,000-line cap is binding; the percentage is a rounded roadmap label, not a second gate. A line target never justifies mixed lifecycles, weaker reliability, deleted required tests, or compressed unreadable code.

## 5. Target architecture

### 5.1 Dependency direction

    create-mono-agent ──writes──► package.json + lockfile + agent config

    cli ────────────────────────► core ───────────────► module-sdk
    configured typed modules ─────────────────────────► module-sdk
    core MCP client ────────────► project .mcp.json services

    agent channel-operator ─────► operator protocol ◄──── tui
                                              ▲     ◄──── web

    service-macos ──starts──────► core runner + agent config
    docs-mcp ───────serves──────► coding clients

Core imports no concrete runtime, channel, memory, state, trigger, exporter, sandbox, UI, documentation server, or service manager. module-sdk provides only typed contracts, schema/provenance helpers, compliance kits, and shared secure filesystem/HTTP primitives.

The architecture checker rejects:

- core dependencies on a concrete module or product;
- a module implementing more than its declared typed contract;
- renderers importing runtime or channel implementations;
- a product treating agent config as its own lifecycle configuration;
- package auto-discovery or catalog scanning during config load;
- circular capability requirements.

### 5.2 Core responsibility

Core owns:

- strict agent-config loading, explicit `$use` resolution, schema composition, and value provenance;
- request, turn, session, concurrency, admission, cancellation, settlement, and backpressure;
- runtime selection and ordered fallback;
- context, skills, MCP, tool, approval, and sandbox-policy negotiation;
- normalized events, health aggregation, graceful startup/drain/shutdown;
- bounded host capabilities granted only to the selected typed module that requires them.

Core does not own provider SDKs/auth, transport mechanics, memory algorithms, storage formats, exporters, UI state, documentation search, setup wizards, OS service definitions, package installation, or arbitrary project process supervision.

### 5.3 Typed module contract

module-sdk exports focused definitions rather than `definePlugin`, and slots are open or reserved:

- Open slots — runtime, channel, and memory — have public factories (`defineRuntimeModule`, `defineChannelModule`, `defineMemoryModule`), published compliance suites, and third-party replacement support at v1. Each is justified by at least two real implementations or a demonstrated replacement demand.
- Reserved slots — state, trigger, exporter, and sandbox — use the same `$use` selection shape and are internally typed identically, but their contracts stay internal to the monorepo until a second real implementation is admitted. The public factory and compliance suite for a reserved slot ship with that promotion, post-1.0 at the earliest. This keeps the kernel small without ossifying the config format.

Every package manifest declares exact package identity, version, `apiVersion: 1`, one capability kind, one-line responsibility, executable schema, optional bounded diagnostics, and optional namespaced maintenance/auth commands. A package cannot receive undeclared host capabilities or return contributions outside its kind.

The module definition must be import-side-effect-free. Import may construct static schemas/manifests but may not read secrets, access the network, spawn a process, or write project/host state. Compliance tests instrument those boundaries.

The selected config's inline fields are validated by the selected module schema. Core-owned directive keys begin with `$`; v1 defines `$schema`, `$use`, and `$env`. Module schemas may not redefine them.

Multiple runtime/channel/trigger/exporter instances may select the same package. Singleton slots select at most one implementation. state-local may coherently own transcript, run recorder, presence, and delivery-idempotency because they share one local durability discipline. OTLP remains separate because its lifecycle, failures, and operations differ.

Third-party typed modules are supported at the open seams — runtime, channel, and memory. They must be installed direct dependencies and pass the relevant compliance contract; no first-party catalog edit is required. Project-local domain behavior should still use MCP instead of creating a module.

### 5.4 Runtime routing and authentication

`runtimes` configures execution-engine instances. `routing` expresses ordered policy separately:

    {
      "runtime": "configured-runtime-instance",
      "model": "runtime-owned-model-identifier"
    }

Core understands only the runtime instance id and passes the model identifier to that module for validation. There is no universal provider field:

- runtime-pi validates `<provider>:<model>`, for example `openai-codex:gpt-5.6-sol`;
- runtime-pi additionally accepts user-defined OpenAI-compatible local providers (Ollama, LM Studio) whose models then route as ordinary provider-qualified identifiers;
- runtime-claude SDK validates a native model id, for example `claude-opus-4-8`;
- runtime-codex and runtime-opencode validate their own native identifiers.

Authentication, OAuth/API-key resolution, model discovery, native sessions, stream retry, and runtime-specific options remain runtime-owned. A project may configure Pi, Claude SDK, Codex, and OpenCode together.

Fallback is an attempt boundary, not migration of one runtime's private session object. The neutral transcript supplies canonical settled history to the next eligible runtime. Capability negotiation rejects a route that cannot satisfy required MCP, tool, attachment, approval, structured-output, or sandbox policy. A fallback never widens permissions and never blindly repeats a committed non-idempotent effect.

Runtime-neutral history commits user-visible input, settled output, AskUser evidence, verbatim appends, selected route, and provider-session linkage only after settlement. Provider-native sessions are optimization and execution state, never the only user-visible history.

### 5.5 Channel and trigger contracts

Channels validate/redact their config; emit normalized inbound requests; manage reply streams; declare attachment, live-input, AskUser, proactive, and runtime-control capabilities; enforce allowlists/auth; expose bounded health; and stop idempotently. A channel advertising proactive capability may also contribute model-visible send tools — message and file delivery bound to its configured instance and recorded in destination history — exposed under normal tool policy.

Configuration, authentication, and structural failures fail closed. Transport failure is visible degradation with bounded recovery and does not crash an otherwise healthy agent. A degraded channel never reports healthy.

Triggers initiate runs but are not communication channels. trigger-cron owns job discovery, schedule/watchdog/overlap policy, and delivery intent. Delivery itself uses an explicitly referenced proactive channel instance — including the operator channel, whose proactive deliveries open a new operator conversation persisted by attached products such as web. Markdown remains the canonical prompt/job body.

### 5.6 MCP and detached-work boundary

Model-visible tool names and orchestration UX remain MCP-owned. First-party v1
does not grant an MCP server privileged host capabilities, and an MCP must not
shell out to a human CLI or import core internals to reach host behavior.

Work that outlives its originating turn belongs to a separately operated
durable service with its own auth, state, retry, and recovery. It can re-enter
mono-agent through an existing explicit webhook or channel, subject to that
boundary's ordinary admission and delivery policy. A future child-run or
continuation capability requires current consumer evidence, a new ADR, and a
paired security design; v1 does not preserve the old grant transport in
anticipation of that decision.

### 5.7 State, durability, and lifecycle

Every durable module documents ownership, atomicity/idempotency, schema versioning, retention, backup/restore, reset/purge, corruption behavior, and redaction. Crash tests prove atomic completion or explicit recoverable state. Unknown delivery remains unknown.

memory-local creates a missing SQLite database exclusively through a no-follow
descriptor and makes only that newly created descriptor owner-private. Before
opening an existing database, it fails closed unless descriptor-based checks
prove a regular file, the expected owner and exact `0600` mode, and stable
device/inode identity across path inspection and open. It never path-chmods or
silently repairs pre-existing operator data. Symlink and path-swap races must
leave both the database path and adversarial target unchanged.

Agent config loading and validation are read-only. `createAgentHost` starts only selected agent modules and drains them in reverse lifecycle order. Products are not started or reconciled by loading agent config.

service-macos owns separate inspect/plan/apply/remove APIs over its own desired-state file. Web owns its own listen/auth/storage config. docs-mcp registration is ordinary coding-client MCP configuration. Product APIs may have optional CLI frontends, but no CLI command is the source of truth.

Changing `$use` never fetches code. Installing/removing a package changes `package.json` and the lockfile explicitly. Removing a stateful module requires its documented audit/export/removal procedure before deleting its config and dependency.

## 6. Configuration

### 6.1 Agent config rules

Canonical file: `mono-agent.config.json` — strict JSON, `configVersion: 1`, unknown fields rejected, paths relative to the config file. `$schema` points to the exact composed schema generated for the locked dependency graph.

JSON is authoritative. Environment values never override fields implicitly. An explicit `{"$env":"NAME"}` may occupy only a schema-approved scalar position, including an element of an array whose schema marks its items env-eligible. Missing referenced values are errors; secret fields reject inline literals. Process environment wins over an explicitly supplied protected env file. Explain output reports the environment variable name but never its value.

There is no interpolation, inheritance, profile overlay, implicit alias, self-registration, hot reload, or local path module. Alternate profiles are separate config files.

### 6.2 Minimal agent

This fixture installs core, module-sdk, cli, runtime-pi, and channel-webhook only:

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
      "auth": {
        "path": "./.secrets/pi/auth.json"
      }
    }
  },
  "routing": {
    "primary": {
      "runtime": "pi",
      "model": "openai-codex:gpt-5.6-sol"
    },
    "fallbacks": [],
    "effort": "high"
  },
  "session": {
    "mode": "continuous"
  },
  "channels": {
    "inbound": {
      "$use": "@mono-agent/channel-webhook",
      "listen": {
        "host": "127.0.0.1",
        "port": 3210
      },
      "apiKey": {
        "$env": "WEBHOOK_API_KEY"
      }
    }
  },
  "policy": {
    "tools": {
      "default": "deny",
      "allow": []
    },
    "approvals": {
      "default": "ask"
    },
    "sandbox": {
      "mode": "off"
    }
  }
}
```

### 6.3 Sanitized Personal Agent migration fixture

This is the full agent-process config, not a maximal first-party showcase. It preserves the actual Personal Agent decisions while replacing personal identifiers and secret values. Products remain outside it by design.

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "personal-agent",
    "name": "Personal Agent",
    "instructions": "./IDENTITY.md",
    "workspace": "."
  },
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": {
        "path": "/Users/example/.pi/personal-agent/auth.json"
      },
      "sessions": {
        "root": "./.mono-agent/sessions"
      },
      "retry": {
        "maxDelayMs": 30000
      },
      "localProviders": [
        {
          "id": "ollama",
          "baseUrl": "http://127.0.0.1:11434"
        }
      ]
    }
  },
  "routing": {
    "primary": {
      "runtime": "pi",
      "model": "openai-codex:gpt-5.6-sol"
    },
    "fallbacks": [
      {
        "runtime": "pi",
        "model": "github-copilot:gemini-3.1-pro-preview"
      },
      {
        "runtime": "pi",
        "model": "github-copilot:gemini-3.5-flash"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:kimi-k2.7-code"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:glm-5.2"
      },
      {
        "runtime": "pi",
        "model": "anthropic:claude-opus-4-8"
      },
      {
        "runtime": "pi",
        "model": "anthropic:claude-fable-5"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:kimi-k2.6"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:glm-5.1"
      },
      {
        "runtime": "pi",
        "model": "openai-codex:gpt-5.6-terra"
      }
    ],
    "effort": "high"
  },
  "session": {
    "mode": "continuous",
    "idleTimeoutMs": 1800000,
    "rollover": "daily",
    "timezone": "Europe/Rome",
    "isolateProactiveRuns": true
  },
  "context": {
    "skills": {
      "roots": [
        "./skills"
      ],
      "load": "all",
      "disclosure": "index",
      "maxBytes": 96000
    },
    "mcp": {
      "configPath": "./.mcp.json"
    }
  },
  "memory": {
    "$use": "@mono-agent/memory-local",
    "root": "./.mono-agent/memory",
    "maxBytes": 96000,
    "capture": {
      "enabled": true,
      "model": {
        "runtime": "pi",
        "model": "openai-codex:gpt-5.4-mini"
      },
      "timeoutMs": 360000
    },
    "embeddings": {
      "provider": "ollama",
      "endpoint": "http://127.0.0.1:11434",
      "model": "nomic-embed-text:v1.5",
      "dimensions": 768
    },
    "recallTool": {
      "enabled": true
    }
  },
  "state": {
    "$use": "@mono-agent/state-local",
    "root": "./.mono-agent/state",
    "runs": {
      "artifactsDirectory": "./.mono-agent/artifacts",
      "retentionDays": 30
    },
    "discovery": {
      "registryDirectory": "./.mono-agent/trace-sources",
      "sourceId": "personal-agent",
      "sourceLabel": "Personal Agent"
    }
  },
  "policy": {
    "tools": {
      "default": "allow",
      "deny": []
    },
    "approvals": {
      "default": "allow"
    },
    "sandbox": {
      "mode": "off"
    }
  },
  "channels": {
    "telegram": {
      "$use": "@mono-agent/channel-telegram",
      "botToken": {
        "$env": "MONO_AGENT_TELEGRAM_BOT_TOKEN"
      },
      "allowedChatIds": [
        {
          "$env": "PERSONAL_AGENT_TELEGRAM_CHAT_ID"
        }
      ],
      "allowAllChats": false,
      "defaultDestination": {
        "$env": "PERSONAL_AGENT_TELEGRAM_CHAT_ID"
      },
      "reactions": {
        "working": true,
        "done": false,
        "error": true
      },
      "quietHours": {
        "start": "23:00",
        "end": "07:00",
        "timezone": "Europe/Rome"
      },
      "transport": {
        "ipFamily": 4
      },
      "transcription": {
        "endpoint": "http://127.0.0.1:50060/v1/audio/transcriptions",
        "model": "large-v3-v20240930"
      }
    },
    "webhook": {
      "$use": "@mono-agent/channel-webhook",
      "listen": {
        "host": "100.64.0.10",
        "port": 4313
      },
      "allowNonLoopback": true,
      "apiKey": {
        "$env": "MONO_AGENT_WEBHOOK_API_KEY"
      },
      "routesDirectory": "./webhook",
      "defaultMode": "async",
      "retentionMs": 300000,
      "maxStoredRequests": 100
    },
    "openai-api": {
      "$use": "@mono-agent/channel-openai-api",
      "listen": {
        "host": "0.0.0.0",
        "port": 4312
      },
      "allowNonLoopback": true,
      "basePath": "/v1",
      "apiKey": {
        "$env": "MONO_AGENT_OPENAI_API_KEY"
      },
      "modelId": "personal-agent"
    },
    "operator": {
      "$use": "@mono-agent/channel-operator",
      "listen": {
        "host": "127.0.0.1",
        "port": 0
      },
      "auth": {
        "token": {
          "$env": "MONO_AGENT_OPERATOR_TOKEN"
        }
      }
    }
  },
  "triggers": {
    "cron": {
      "$use": "@mono-agent/trigger-cron",
      "jobsDirectory": "./cron",
      "timezone": "Europe/Rome"
    }
  },
  "observability": {
    "exporters": {
      "phoenix": {
        "$use": "@mono-agent/exporter-otlp",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "personal-agent",
        "includeSensitiveData": false
      }
    }
  }
}
```

The fixture intentionally omits Slack, native sandboxing, TUI, web, docs-mcp, and service-macos because the live Personal Agent process does not select those capabilities. A2A, continuations, and host-capability grants are v1 cuts. It intentionally includes the local Ollama provider because the live config registers one. Phoenix exports metadata by default; exporting prompts, replies, tool arguments/results, or system instructions is a separate explicit opt-in for a trusted collector.

### 6.4 Multi-runtime addition

Adding native Claude SDK is explicit. No provider field is forced onto Claude:

```json
{
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": {
        "path": "/Users/example/.pi/personal-agent/auth.json"
      }
    },
    "claude-sdk": {
      "$use": "@mono-agent/runtime-claude",
      "mode": "sdk",
      "auth": {
        "method": "oauth-token",
        "token": {
          "$env": "CLAUDE_CODE_OAUTH_TOKEN"
        }
      }
    }
  },
  "routing": {
    "primary": {
      "runtime": "pi",
      "model": "openai-codex:gpt-5.6-sol"
    },
    "fallbacks": [
      {
        "runtime": "claude-sdk",
        "model": "claude-opus-4-8"
      },
      {
        "runtime": "pi",
        "model": "anthropic:claude-opus-4-8"
      }
    ]
  }
}
```

The two fallback entries deliberately show the same model family through different execution paths.

### 6.5 Project MCP and Markdown jobs

The agent config references the standard MCP file; it does not copy custom server definitions:

```json
{
  "mcpServers": {
    "transcribe": {
      "type": "stdio",
      "command": "node",
      "args": [
        "./tools/transcribe-mcp/dist/mcp-server.js"
      ]
    },
    "deep-research": {
      "type": "stdio",
      "command": "node",
      "args": [
        "./tools/deep-research-mcp.js"
      ]
    }
  }
}
```

The framework has no package knowledge of the tools these servers expose.
Skills explain their use. An MCP receives no privileged mono-agent host grant.
If its work must outlive the originating call, the separately operated service
owns durability and re-enters through a configured webhook or channel.

A scheduled job references stable runtime and channel instance ids:

```yaml
---
id: morning-briefing
expression: 30 7 * * *
timezone: Europe/Rome
runtime: pi
model: openai-codex:gpt-5.6-sol
effort: high
notify: telegram
---

Compose the morning briefing.
```

`notify: telegram` uses the selected channel instance and its explicit `defaultDestination`. Multiple destinations use an object with `channel` and `destination` rather than a global route registry.

### 6.6 Product configuration

service-macos has its own desired-state file. It is not mentioned by the agent:

```json
{
  "$schema": "./.mono-agent/service-macos.config.schema.json",
  "configVersion": 1,
  "services": {
    "personal-agent": {
      "agentConfig": "/Users/example/personal-agent/mono-agent.config.json",
      "startAtLogin": true,
      "restartPolicy": "on-failure",
      "environmentFile": "/Users/example/personal-agent/.env",
      "logs": {
        "directory": "/Users/example/.mono-agent/logs",
        "maxBytes": 10485760,
        "retainFiles": 5
      }
    }
  }
}
```

If service-macos is absent, the same agent config runs foreground or under another supervisor. Removing service-macos never changes agent semantics.

The machine-wide web product likewise owns its listener, browser authentication, storage, and agent discovery:

```json
{
  "$schema": "./.mono-agent/web.config.schema.json",
  "configVersion": 1,
  "listen": {
    "host": "127.0.0.1",
    "port": 5050
  },
  "auth": {
    "token": {
      "$env": "MONO_AGENT_WEB_AUTH_TOKEN"
    }
  },
  "allowInsecureHttp": false,
  "dataDirectory": "./.mono-agent/web",
  "agentRegistries": [
    "/Users/example/personal-agent/.mono-agent/trace-sources"
  ]
}
```

Loopback is the safe default. Direct plaintext LAN or Tailscale-IP binding
requires a token of at least 24 characters and explicit
`"allowInsecureHttp": true`; that flag acknowledges unencrypted transport and
does not provide TLS. Prefer loopback behind an HTTPS reverse proxy or
Tailscale Serve. Host/Origin checks remain request-integrity defenses, not a
replacement for bearer authentication or encryption.

TUI needs no persistent product config for the common case; it discovers an agent through the same owner-private registry or accepts an explicit operator endpoint. docs-mcp is placed in the coding client's `mcpServers` map. No central products registry is introduced.

### 6.7 Schema, provenance, and commands

One executable schema per core section or selected typed module is the only handwritten definition. Types, validation, defaults, composed JSON Schema, editor completion, redaction, explain output, setup prompts, and reference docs derive from it.

Runtime routes reference configured `runtimes` only. Memory capture routes use the same `{ runtime, model }` shape. Trigger notification references configured proactive channels only. MCP server names reference entries present in `.mcp.json`; no MCP host-grant section exists in v1. Wrong-kind, missing, incompatible, over-broad, and cyclic references fail with both source paths.

The CLI discovers optional diagnostics/auth/maintenance commands only from modules explicitly named by `$use`. It never scans dependencies or a first-party catalog. Runtime and lifecycle commands remain optional frontends over public APIs; programmatic consumers can load, validate, run, inspect, and reconcile the relevant product without spawning a human CLI.

## 7. Operator, packages, CLI, and documentation

### 7.1 One operator interface, multiple renderers

channel-operator serves one agent over loopback HTTP. operator supplies protocol schemas, the single agent client, cross-agent directory, capability negotiation, domain state machines, and golden fixtures. TUI and web import operator and may not reimplement wire decoding or action eligibility.

The wire remains HTTP routes plus NDJSON turn streaming with disconnect-aborts-turn semantics. An SSE redesign is out of v1: EventSource cannot POST and would add buffering while changing a load-bearing cancellation boundary.

Given the same fixture stream and capabilities, TUI and web produce equivalent conversation/turn state, AskUser state, and available actions. Renderers retain layout, navigation, widgets, terminal/browser integration, and platform persistence.

The shared schema covers discovery/selection/pinning, conversations, turns,
live input, cancellation, AskUser, model/effort overrides, attachments,
quoting, config/replay/health views, per-turn context-window usage with
compaction and provider-session eviction telemetry, and proactive delivery into
new operator conversations. Capability flags, not type presence, determine
what an endpoint and product may expose.

The first runnable G2 slice deliberately implements a narrower executable
path: owner-private discovery reading, strict text-turn streaming,
cancellation, runtime overrides, health, pi-tui rendering, authenticated web
text conversations, atomic owner-private JSON state, and web-service turn
survival across browser response disconnect/reload. The paired channel reports
attachments, quotes, live input, AskUser, proactive delivery, config view, and
replay as unsupported. Web uploads, notifications, structured AskUser UI,
multi-user accounts, PWA/TLS/service management, and remote reset are not in
this slice. A renderer exit never stops the agent; web product shutdown may
cancel its owned active turns. Later verticals must enable additional
capabilities explicitly rather than relying on the shared schema alone.

Products are installed and launched independently. service-macos may start agent and web as separately declared services, but it never infers web from agent config.

### 7.2 v1 package roster — 23

| Ownership category | Packages |
| --- | --- |
| Core infrastructure (3) | module-sdk, core, cli |
| Runtime modules (4) | runtime-pi, runtime-claude, runtime-codex, runtime-opencode |
| Channel modules (5) | channel-telegram, channel-slack, channel-webhook, channel-openai-api, channel-operator |
| Trigger modules (1) | trigger-cron |
| Durable capability modules (4) | memory-local, state-local, exporter-otlp, sandbox-srt |
| Operator layer (3) | operator, tui, web |
| Project tooling (1) | create-mono-agent |
| Host products (1) | service-macos |
| Companion MCPs (1) | docs-mcp |

The 14 runtime/channel/trigger/durable packages are agent-selectable typed modules. TUI, web, service-macos, docs-mcp, and create-mono-agent are not agent modules. operator is a shared library. Core, module-sdk, and CLI arrive through dependencies rather than synthetic config entries.

Against the 22-package v0 baseline the roster is a net +1. V1-003 maps every shipped v0 package to this roster or an explicit cut so the arithmetic is derived rather than explained by a misleading new-package list. In particular, `create-mono-agent` and `docs-mcp` already ship in v0 and are refactored into their narrower v1 responsibilities; they are not new package-count increases. Every boundary must be justified independently, and the line budget in section 4, not the package count, is the size metric.

Retired v0 names: agent-app, agent-contracts, agent-harness, agent-runtime, config, observability, runtime-adapter, operator-adapter, channel-cron, plus Phase A deletions. `plugin-sdk` was an unshipped design name, not a published v0 package, so it is neither a retired package nor a deletion target. Package count is reported but not gated. Package READMEs and public API maps derive from owned metadata.

### 7.3 CLI disposition

| Command | v1 disposition |
| --- | --- |
| init / setup | create-mono-agent-backed; alias preserved |
| validate / doctor | Core validation plus selected typed-module diagnostics |
| auth | Routed to explicitly configured runtime instances |
| sandbox | Routed to configured sandbox module; precise absence response when off |
| config | Explain, schema, and authoring helpers; never conversational mutation |
| start | Foreground core runner over one agent config |
| restart / stop / status / logs | Foreground/process inspection or optional service-macos frontend when given service config |
| service plan/apply/remove | Optional frontend over service-macos public APIs |
| tui | Starts TUI product and connects by discovery or endpoint |
| web | Starts web product from web product config |
| install-skill | Transactional managed skill copy; unrelated to docs-mcp |
| runs | state-local maintenance surface |
| memory | memory-local maintenance surface |
| presets | Deleted after equivalent scaffold templates land |
| backfill | Deleted at G0.5 with archive guidance |
| tui --configure | Deleted with self-config and points to init/schema/explain |

The CLI hardcodes no provider, channel, memory backend, product, or platform behavior. Removing the CLI does not make agent or product APIs unusable.

### 7.4 Documentation and contribution

Canonical documentation provides:

- the one-page mental model (section 1.1) as the documentation landing page;
- one minimal quickstart;
- the sanitized Personal Agent fixture;
- one focused multi-runtime example;
- generated core and per-module schema references;
- separate TUI, web, service-macos, and docs-mcp lifecycle guides;
- a package responsibility/dependency/API map;
- a capability ladder explaining MCP versus typed module versus product.

docs-mcp is an optional delivery form of canonical docs, not their source of truth. Its corpus and the website are generated from the same files and digest-checked.

Contributor paths are intentionally different:

- add a domain integration by publishing or checking in an MCP server and a skill;
- add a runtime, channel, or memory implementation only when replacing that framework semantic, using the matching module-sdk factory and public compliance suite (reserved slots accept third-party implementations only after their section 5.3 promotion);
- add a renderer by consuming operator;
- add a host integration as a separate product over the runner contract.

First-party additions update package-catalog metadata and standard package docs. Third-party typed modules need no first-party catalog edit, but must be installed direct dependencies and satisfy the public compliance contract. They are discovered through the `mono-agent-module` npm keyword and the generated community-modules page (section 2.6).

## 8. Atomic requirement and parity ledger

G0 creates `refactor/v1-requirements.json` before product deletion. It is the machine-readable disposition of v0 behavior. Each row contains:

- one independently falsifiable assertion;
- stable requirement id, owner, gate, consumer applicability, and `kept` or `cut` disposition;
- source evidence from config, CLI/flags, code, tests, docs, services/jobs, durable state, or consumer inventory;
- for a kept row, named proof assertions and automated/live/migration evidence type;
- for a cut row, deletion decision and archive/revival location.

The ledger is a reviewed disposition checklist, not a bespoke
test-to-requirement execution framework. Its strict validator rejects unknown
keys, malformed or unsorted identifiers, undeclared owners/gates/evidence
types, incomplete feature-registry coverage, invalid kept/cut shapes, unsafe or
missing current source-evidence paths, duplicate proof ids, ordinary code
behavior without automated proof, and emits a deterministic semantic digest.
At G0, future proof paths remain declarative. A stage check then requires every
named proof path for kept requirements through that milestone to exist; it does
not execute the proof or judge its substance, which remains the owning gate's
exit review. Release tags select the enforced milestone: v0 tags use G0, v1
beta and other non-RC prereleases use G6, v1 release candidates use G7, and
stable v1 tags use G8. Operational cutover rows may use captured live evidence;
normal code behavior requires automated proof.

The inventory below is a discovery seed, not the final atomic row count.

**Core host**

- deterministic identity/instruction/skill composition, disclosure, and byte limits (the v0 second persona file `soulPath` is a cut row: no fleet config sets it);
- request/reply/AskUser/attachment normalization;
- MCP and tool policy intersection without privilege widening;
- concurrency, pending admission, cancellation, backpressure, and settlement;
- per-run turn ceiling (`maxTurns`) with honest rejection where a runtime cannot enforce it;
- oversized tool-output offloading into run artifacts with bounded inline summaries;
- continuous/per-message sessions, idle expiry, rollover timezone, and proactive isolation;
- live-input acknowledgement and normal-turn fallback;
- proactive exact-destination delivery, verbatim mode, and NOTHING_TO_REPORT suppression;
- request-level runtime/model/effort overrides;
- message-text effort keyword escalation (`think`/`extra think`/`ultra think`) with escalation-only strict-rank semantics;
- programmatic embedding without CLI.

**Agent configuration and module loading**

- strict `agent`, `runtimes`, `routing`, `session`, `context`, singleton capability, map capability, and `policy` schemas;
- stable instance ids and literal `$use` ownership;
- direct-dependency and lockfile enforcement;
- module kind/API/schema verification;
- no alias mapping, self-registration, dependency scan, path module, or download;
- package import side-effect instrumentation;
- value provenance, secret redaction, composed schema, and explain output;
- wrong-slot, missing-reference, incompatible-model, and cyclic-reference diagnostics;
- load/validate without process, service, MCP-registration, package, or filesystem mutation.

**Continuations (cut)**

- claim origin identity, policy snapshots, reply destinations, deadlines, and
  bounds;
- leases, retries, cancellation, expiry, and dead letters;
- tool-free synthesis, instance routes, delivery receipts, and unknown-delivery
  recovery;
- list, status, retry, cancel, resolve, and `per-record-v3` maintenance;
- `continuation.claim` grants plus continuation config, environment, schema,
  validation, CLI, and discovery surfaces.

These are separate atomic cut rows at G0.5. V1-006 deletes both the runtime and
every selectable or discoverable surface and records their clean-history
archive paths; no placeholder validation or host-grant transport survives.

**Runtime routing**

- Pi execution including provider-qualified model ids, OAuth/API-key resolution, tool steering, native tools including the Node REPL, native sessions, stream retry, and compaction linkage (user-facing compaction tuning knobs are a cut row: policy is runtime-owned and no fleet config tunes it);
- user-defined OpenAI-compatible local providers on runtime-pi (the live Personal Agent registers a local Ollama endpoint);
- Claude SDK and Claude CLI modes with native model ids;
- Codex app-server and OpenCode app-server with stable-version guard;
- ordered same-runtime and cross-runtime fallback using explicit `{ runtime, model }` entries;
- runtime-owned model validation and auth;
- capability eligibility (including structured-output schemas) and permission monotonicity;
- canonical transcript replay without private-session migration;
- no replay of committed non-idempotent effects;
- typed provider/runtime failures with causes and no secret leakage.

**Channel shared compliance**

Every channel proves normalization, allowlist/auth, advertised AskUser/live-input/proactive/verbatim behavior, instance-bound model-visible send tools where advertised, delivery idempotency, bounded health, visible degradation, idempotent stop, and redaction independently.

**Telegram**

Polling, media, voice transcription, adversarial filenames, in-place activity, steering, runtime controls, commands, quiet hours, status reactions, non-blocking tappable reply options distinct from blocking AskUser, model-invoked message and file sending, exact chat authorization, and final delivery.

**Slack**

One Socket Mode consumer, thread/conversation identity, assistant status with reaction fallback, transient tool ledger, shortcuts, App Home, runtime controls, model-invoked message sending, and honest final-only/silent-delivery limits.

**Webhook**

Directory-defined routes, per-request auth, prompt/model/effort, sync/async behavior, timeout, status retention, request bounds, and no system-prompt leakage.

**OpenAI-compatible API**

Model discovery, streaming/non-streaming Chat Completions, correct SSE/JSON termination, conversation identity, bounded images, sampling warnings, authentication, and host-tool rendering.

**Cron trigger**

Markdown jobs, five-field/timezone validation, duplicate rejection, runtime/model override objects, channel-instance notification, skip/queue/replace/overflow, per-job watchdog, and honest missed/degraded outcomes. Cron is proved as a trigger rather than a channel.

**Operator endpoint and products**

- protocol and frame bounds, disconnect cancellation, capability advertisement, and owner-private discovery;
- every TUI/web wire interaction uses the shared client;
- fixture-equivalent domain state and actions;
- per-turn context-window usage, compaction, and provider-session eviction telemetry;
- proactive trigger delivery into a new operator conversation persisted by attached products;
- independent product startup/config and no agent-config product registry;
- TUI conversations, model/effort, cancel, live input, AskUser, quote, attachments, config, replay, health;
- web durability, uploads, notifications, active-turn survival, invalidation, deletion, browser auth, host/origin safety.

**Memory**

SQLite identity, migrations, ownership, corruption reporting, exclusive
no-follow creation, and descriptor-proved pre-existing database type, owner,
`0600` mode, and device/inode identity; unsafe databases fail closed without
path chmod or target mutation. A new BuJo root permanently retains its canonical
`.first-run-memory-initializing` marker: an exclusively created `wx+`,
owner-owned, `0600`, single-link regular file whose pinned descriptor changes
exact `initializing:<uuid>\n` to `initialized:<same-uuid>\n` only after durable
generation publication. The pathname is never renamed, replaced, or unlinked.
Exact bytes, descriptor/path device-inode identity, owner, mode, link count, and
root identity are checked before and after commit; failure retains inspectable
in-flight state. Doctor fails closed for in-flight, malformed, permissive,
multi-link, swapped, missing-after-read, and legacy
`.first-run-memory-initializing.released-*` marker states.
V1-042 owns this contract and V1-045 consumes it. The retained behavior also
covers BuJo recall with/without embeddings, vector + FTS, dimensions,
breaker/fallback, completed-turn capture idempotency, runtime-backed capture,
consolidation, strict audit, preview, backup, rebuild, forget, and intake retry.
Lite, journal, and the `append-host-summary` write mode are cut rows (fleet
configs use only `capture` and disabled).

**State**

Atomic canonical transcript, duplicate protection, provider-session linkage, verbatim append, AskUser evidence, run summaries/events, retention, stale-run classification, memory-run separation, owner-private discovery/presence with the optional machine-wide discovery mirror, a rollover-independent cursor-paged run-history model tool, and channel delivery-idempotency indexes.

**Observability**

Structured event bounds/redaction, OTLP/Phoenix mapping, project/session mapping, pressure, flush/shutdown, include-sensitive warning, opt-in content-pattern credential scanning of retained free text, and visible degradation.

**Security and sandbox**

No inline secrets in secret fields; redaction in
logs/errors/health/explain/docs; owner-only creation plus descriptor/no-follow
type, mode, ownership, and identity checks where promised; no path-based chmod
of pre-existing operator data; adversarial symlink/swap rejection; shared HTTP
bind/bearer/Host/Origin/body/shutdown hardening; fallback policy monotonicity;
SRT off/native/network/integrity behavior.

**MCP-first project extension**

- named standard MCP config loading;
- custom MCP without mono-agent package/catalog changes;
- no privileged host grant or hidden core import for project MCPs;
- detached work owned externally and re-entering only through an explicit configured channel or webhook;
- skills as the instruction boundary;
- remote MCP process independence;
- no generic core process supervision.

**Operations and products**

- foreground agent start after strict validation;
- exact process/config/version identity and bounded health;
- service-macos separate config and programmatic read-only inspect/plan;
- fingerprinted explicit apply/remove, staged promotion, drift rejection, logs, restart/stop, and no resurrection;
- agent works when service-macos is absent;
- web separate config and machine-wide operation;
- docs-mcp ordinary client registration and corpus drift proof;
- config loading never mutates any product or host state.

**Setup, contributor, and release**

- scaffolded package.json contains only required direct dependencies with exact versions and lockfile;
- minimal, Personal Agent, and multi-runtime fixtures round-trip;
- runtime-owned auth discovery with bounded checks and honest noninteractive behavior;
- schema-derived docs and explain;
- one external open-slot module (channel or memory) fixture loads without a core/catalog edit;
- one custom MCP fixture works without module-sdk;
- package docs derive from metadata;
- lockstep API/peer compatibility and packed-consumer verification.

## 9. Data migration and rollback

### 9.1 State classification

BuJo memory is the only v0 application state adopted as canonical by v1.

| State | v1 treatment | Reason |
| --- | --- | --- |
| BuJo roots, SQLite identity, embedding metadata, unresolved intake | Preserve after audited rehearsal and backup | User-owned durable memory |
| A2A and continuation records | Archive with final v0 source; do not import | No active consumer selects either capability; first-party v1 cuts both |
| Conversation history, native runtime sessions, run artifacts, web conversations | Do not import; retain read-only v0 copy through rollback window | No stable cross-version product promise |
| Logs and transient caches | Do not import beyond existing operations policy | Diagnostic, not canonical |

v1 uses distinct directories for new transcript, runs, discovery, exporter, and web state. The audited BuJo memory directory is the only v0 canonical application-state directory adopted.

### 9.2 Memory cutover

Freeze the memory format through both betas. Per consumer: audit; back up; rehearse on a copy; compare representative vector and FTS recall; perform capture, duplicate admission, forget preview, and rebuild; prove v0-final and v1 readers; cut over with a final audit; retain backup through rollback.

Any integrity failure, format mutation, missing behavior, or remaining lite/journal dependency blocks that consumer. Lite/journal data is not automatically converted; separately migrate it to BuJo or keep that consumer on frozen v0.

An existing database with an unsafe type, owner, mode, link target, or unstable
descriptor identity also blocks adoption. Remediation is an explicit operator
backup/copy/permission operation outside memory-local; the module reports the
condition and never path-chmods the existing database or an adversarial target.

### 9.3 Agent and product migration

There is no v0 config parser. Each consumer receives:

- explicitly authored v1 agent config and exact selected-module package closure;
- existing or migrated `.mcp.json`, skills, Markdown jobs, and project services;
- separate product configs only for installed products;
- a field-by-field migration map to typed agent slot, MCP/skill/cron, product config, host operations, or explicit cut.

Every G7 cutover consumer installs the exact registry-verified beta published
by V1-048. A repository checkout, tarball that was not the verified registry
artifact, mutable dist-tag without resolved-version proof, or unpublished local
build is not a cutover candidate.

Personal Agent shadow uses separate service ids and ports with Telegram delivery disabled. Cutover occurs at a session rollover boundary. The sanitized section 6.3 fixture is the review artifact for behavior coverage; the live file supplies exact private paths and identifiers.

After Personal Agent passes rollback proof and a 24-hour soak, the active
`~/agents/a8c-assistant` migrates as a distinct consumer with Slack, webhook,
cron, BuJo, auth, state, and exact single-consumer proof. The retired
`~/a8c-agents` outcome fleet remains stopped and is not migrated.

service-macos plan binds its own config digest, agent config/package/lockfile digests, exact Node and runner paths, protected environment source, observed launchd state, and logs. It never expands secrets into service definitions, installs dependencies, rewrites agent config, or shells through a human CLI command. Apply stages/promotes atomically; restart validates replacement first; stop proves unload and process death; remove disables recovery.

The web product is migrated independently against channel-operator and its discovery registry. docs-mcp is registered independently in each selected coding client. Neither is inferred from agent config or service-macos package presence.

If service-macos was never installed/applied, no launchd state exists and the agent remains foreground-runnable. To remove an existing service, inspect and apply its removal through the service product before removing its product config/dependency. Merely deleting JSON is not an implicit host mutation.

Before the successor guard is removed, V1-005 proves the dormant
`ai.mono-agent.final-demo-gemma4` and `ai.mono-agent.multi-agent-demo` jobs
unloaded, archives their KeepAlive plists outside the auto-load directory with
rollback data, and removes only their recorded stale Tailscale Serve routes.
Sandbox-readable old-checkout roots are recorded as non-execution references.

### 9.4 Rollback

Stop and prove death of v1; audit memory; restore a complete pre-cutover backup only when format/records require it; load retained v0; prove version, config, process, channels, and health; record reason. The G0.25 pin records and retains each consumer's pre-pin installation, service definition, config, and rollback command so a failed `0.16.0` adoption can be reversed independently.

Immediate rollback triggers: duplicate Telegram/Slack consumption, memory corruption/loss, unprovable process identity, auth failure hidden by fallback, healthy-while-unavailable, missed schedule without explicit failure, crash loop, or secret exposure.

## 10. Delivery gates

| Gate | Content | Exit evidence |
| --- | --- | --- |
| G0 — commitment | ADR ratifies typed modules, scoped products, cuts, migration, budgets, clean-history lineage, and license authority; exact classifier/baseline and atomic ledger | Reviewed ADR; manifest/digest/count reproducible; every behavior kept or cut |
| G0.25 — archive/detach | Predecessor release PR publishes final v0; successor PR A applies the equivalent release payload under guard; annotated archive tag and protected maintenance branch are atomically fixed at `ARCHIVE_SHA`; successor PR B commits dedicated equivalence/history evidence; V1-005A merges the exhaustive inventory, immutable consumer pins, host/source transition, and sanitized proofs with the guard present; only V1-005B makes `mono-agent-next` canonical and removes the guard | Credential-free all-tarball dry run; registry/source/manifest/tarball equivalence; exact archive refs and no successor `v0.16.0` tag; machine-validated paths/processes/config and closure hashes/ports/rollback/dispositions; coherent web SQLite/WAL backup; retired/dormant proof; A parent/merge and B parent/HEAD prove guard present through prerequisites and absent only at the reviewed V1-005B SHA |
| G0.5 — deletion-first v0 | WhatsApp, Supermemory, orchestrator extra, A2A, continuation runtime/host grant/configuration/discovery, self-config authority/generated skill, and historical backfill removed; ordinary local TUI, export mapping, and permanent policy aliases preserved; direct Anthropic SDK removed only if peer proof permits | Focused + broad CI green; no SELF-CONFIG/A2A/continuation runtime or selectable surface; local TUI/export/policy-alias/packed-peer proofs; complexity delta |
| G1 — config-first skeleton | module-sdk typed contracts; strict slot schema; direct-dependency loader; core host/API; thin CLI; minimal Pi + webhook; schema scaffolder; old config/controller/wizard machinery deleted | Packed clean-project turn; no-side-effect import/load; exact closure; explain/schema tests; external open-slot module and ordinary MCP fixtures |
| G2 — operator products | operator client/directory/domain fixtures; channel-operator; TUI/web standalone products | Fixture parity; no second decoder/action reducer; independent product lifecycle smokes |
| G3 — runtimes/history | Canonical transcript; four runtimes; structured runtime/model routing; Pi-native sessions/compaction; old drivers deleted | One live smoke/family; same/cross-runtime fallback; settlement/history |
| G4 — channels/triggers | Five channels plus trigger-cron; shared security/compliance; old glue/index duplication deleted | Atomic rows; Telegram/Slack/OpenAI smokes; clock-controlled cron |
| G5 — durable capabilities | state-local, memory-local BuJo-only with permanent descriptor-bound first-run marker, exporter-otlp, sandbox-srt; old state/memory/observability deleted | Durable review; memory rehearsal; permanent canonical marker proof; descriptor/no-follow SQLite identity and adversarial symlink/swap proof; exporter/sandbox proofs |
| G6 — products/release | Refactor existing create-mono-agent and docs-mcp; add service-macos as a separate product; generate docs and migration guide; adapt lockstep beta; after canonical cutover, establish approved successor registry authority and publish the exact packed beta candidate | Packed minimal/Personal/multi-runtime scaffolds; all packages accounted; service/docs smokes; guard-absent exact-SHA authority preflight; registry publish/install verification |
| G7 — production beta | Install the registry-verified beta; migrate Personal Agent, then active A8C Assistant | Exact published version/SHA; consumer matrices, audits, rollback, exact single consumer, 24-hour soak each |
| G8 — stable | Ledger green; source ≤130k (binding; roadmap-rounded 28.66% reduction, 71.34% retained); kernel ≤15k; clean-history release readiness; separately approved stable publish | Exact-SHA reports; packed consumer install; section 2.6 OSS and section 2.7 history checks green; clean public clone; post-launch dispositions |

Gates merge in order. Work inside a gate may run concurrently only where the task graph permits. V1-004 PR A and PR B use the default/G0 checks plus their dedicated archive-evidence checker; aggregate G0.25 intentionally waits for the final V1-005 evidence and SHA.

## 11. Execution task graph

Every implementation PR names task and requirement ids, includes paired deletion, and gives every external review finding a fixed/follow-up/rejected disposition. A task is complete only when proof is committed.

Execution conventions: development begins with the three G0 PRs in order — the ADR (V1-001), the classifier and baseline report (V1-002), and the requirement manifest (V1-003). One task per PR unless a row explicitly pairs deliverables; branches name their task (for example `v1/g1-v1-013`). A PR that discovers scope this document missed amends the PRD in the same review rather than absorbing it silently. After the G0 ADR merges, architecture questions cite the ADR and this section tracks execution only.

Task identifiers remain stable across plan consolidation. V1-007, V1-008, and
V1-021 are intentionally unused after their work was folded into surviving
tasks; V1-037, V1-040, and V1-041 were retired when A2A and continuations moved
into V1-006's deletion wave. None of those identifiers requires a separate PR
or leaves unowned work.

| ID | Gate | Depends on | Deliverable and paired deletion | Required proof |
| --- | --- | --- | --- | --- |
| V1-001 | G0 | — | Ratify ADR for typed modules, product boundaries, config, cuts, migration, budgets | Architecture approval |
| V1-002 | G0 | V1-001 | Commit classifier and normalized baseline | Clean-checkout digest/count reproduction |
| V1-003 | G0 | V1-002 | Build the strict, stage-aware atomic requirement manifest from the normalized classifier | Zero unclassified behaviors; complete feature coverage; deterministic digest; source-path and release-milestone tests |
| V1-004 | G0.25 | V1-002, V1-003 | After predecessor Actions billing is restored or a separate path is approved, merge/publish/verify the predecessor final-seed payload at `v0.16.0`; successor PR A applies its equivalent release payload under guard and defines `ARCHIVE_SHA`; atomically create annotated `refs/tags/archive/v0-final-full` plus protected `refs/heads/v0-maintenance` there without a successor `v0.16.0` tag; PR B commits validated `refactor/evidence/g0.25/v0-archive.json` without moving the refs | Credential-free all-tarball dry run; watched registry publish/install; package/source/manifest/tarball integrity equivalence; archive tag object/peeled SHA and protected branch proof; guard present at both PR heads; clean-history proof that distinguishes deterministic shared content objects from forbidden predecessor history |
| V1-005 | G0.25 | V1-004 | Immediately inventory the eight managed agents including Therapy/Council, shared controller/maintenance jobs, Personal watchdog/session-web, web:5050 plus coherent SQLite/WAL backup, Codex/Claude docs-MCP, all bin/NVM/Homebrew/memory-recall/service wrappers, dormant demo jobs/targeted Serve routes, and stopped retired A8C fleet; record exact path/process/config/closure/CLI/port/source/target/rollback/health/disposition fields; V1-005A pins authorized rows to predecessor-published `0.16.0`, performs bounded host/source-URL changes, and merges all sanitized evidence while the guard remains; V1-005B starts from A's merged SHA, adds the final attestation, establishes `mono-agent-next` as canonical, and removes the guard in a repository-only PR | Machine-validated exhaustive inventory captured immediately before mutation; per-row resolution/process/config/state/rollback proof; no executable old-source resolution or dormant resurrection path; coherent database backup; A merged with guard present and re-probed without drift; B parent/HEAD prove guard present through prerequisites and absent only at final SHA; B publishes, deploys, restarts, and repoints nothing |
| V1-006 | G0.5 | V1-005 | One deletion wave: remove WhatsApp, Supermemory, orchestrator extra, A2A, the continuation runtime/host grant plus all config/environment/schema/validation/CLI/discovery surfaces, self-config authority/transactions/`tui --configure` plus generated `mono-agent-configure` skill/default selection, and historical backfill CLI/app; extract ordinary `tui --local` behavior from `createLocalConfigurationSession()`; preserve run-export/session mapping and permanent `ask_collaborator` policy canonicalization; remove direct Anthropic SDK only if peer proof permits | Focused and negative tests, no A2A/continuation runtime or selectable/discoverable surface, ordinary local TUI proof, legacy deny-policy proof, packed dependency peer/runtime proof, export/public seam tests, architecture/docs, complexity delta |
| V1-009 | G0.5 | V1-006 | Certify lean v0 base | Focused lanes + broad CI; ledger/delta |
| V1-010 | G1 | V1-009 | Create module-sdk/core/cli skeletons, category rules, and the section 2.6 license split with explicit inbound terms and file-level provenance/authority | Catalog, dependency, API, provenance/authority, license, pack checks |
| V1-011 | G1 | V1-010 | Implement typed contracts for all seven slots — public factories and compliance kits for the three open slots, internal contracts for reserved slots — with manifests, schemas, diagnostics/commands | Type tests, import-side-effect instrumentation, one fixture per open kind |
| V1-012 | G1 | V1-011 | Implement strict agent/runtimes/routing/context/capability/policy schema with `$use`, inline leaf config, references, provenance | Minimal/Personal/multi-runtime fixtures; error/redaction tests |
| V1-013 | G1 | V1-011, V1-012 | Implement exact direct-dependency/lockfile module loader; reject aliases, paths, scans, wrong kinds | Resolution/digest/dependency negatives; no lifecycle/install side effects |
| V1-014 | G1 | V1-011 | Implement secure-fs and shared HTTP lifecycle helpers; replace install-skill and cleanup race surfaces plus redirect checking | Transactional/no-clobber owner-only filesystem and checked-redirect adversarial contracts |
| V1-015 | G1 | V1-011, V1-012, V1-013 | Implement host lifecycle, bounds, settlement, health, shutdown, monotonic tool policy, response redaction, safe JSON normalization, and own-property tool aliases with no MCP privileged-host grant plane | Lifecycle/crash/backpressure, policy non-widening, redaction/prototype, alias, and MCP-boundary negatives |
| V1-016 | G1 | V1-012, V1-015 | Implement load/validate/create/inspect APIs and thin CLI validate/schema/explain/diagnostic routing | Programmatic/CLI parity; exit/JSON compatibility; read-only load |
| V1-017 | G1 | V1-012, V1-016 | Land schema-derived minimal and selected-stack scaffolds; delete presets/wizard/config reference and generic merge-patch settings writer | Packed snapshots, exact closure, names-only secret example, concurrent transactional failure |
| V1-018 | G1 | V1-011, V1-016 | Convert doctor inventory to core + selected-module diagnostics; delete old orchestration | Every v0 check mapped or cut |
| V1-019 | G1 | V1-013, V1-015 | Complete real Pi + webhook vertical slice and project MCP fixture; delete app-controller/config glue | Packed clean-project turn and minimal closure |
| V1-020 | G2 | V1-011 | Extract operator protocol, one strict NDJSON client, and turn/stream/AskUser/capability/directory domain state | Golden valid/malformed wire/frame/disconnect tests; deterministic reducer/action fixtures |
| V1-022 | G2 | V1-015, V1-020 | Extract channel-operator typed module | Protocol compliance and disconnect abort |
| V1-023 | G2 | V1-020, V1-022 | Migrate TUI as standalone operator product; delete local interpretations/config-mode UI | TUI parity and interactive smoke |
| V1-024 | G2 | V1-020, V1-022 | Migrate web as standalone operator product with separate config and durable ownership; make smoke templates isolate home/state, choose an ephemeral port, and clean the exact PID | Web parity, restart/upload/notification/auth smoke and Markdown/TOML contract parity |
| V1-025 | G3 | V1-015 | Extract canonical neutral transcript into state-local | Settlement, duplicate, replay, AskUser, corruption |
| V1-026 | G3 | V1-019, V1-025 | Finish runtime-pi with owned session-reservation commits, checked WebSearch failures, and literal edits; delete hand-rolled drivers | Pi live smoke, reservation-race/linkage, redirect/error, and literal replacement proofs |
| V1-027 | G3 | V1-015, V1-025 | Extract Claude SDK and CLI modes | Mode-specific live smokes/failures |
| V1-028 | G3 | V1-015, V1-025 | Extract Codex app-server runtime | Approval/cancel/session live smoke |
| V1-029 | G3 | V1-015, V1-025 | Extract OpenCode app-server and stable-version guard | Version/failure live smoke |
| V1-030 | G3 | V1-026, V1-027, V1-028, V1-029 | Implement `{ runtime, model }` routing, runtime-owned model validation, capability negotiation, same/cross-runtime fallback | Full fallback matrix and policy monotonicity |
| V1-031 | G4 | V1-011, V1-014, V1-015 | Finalize channel contract and shared compliance | Fixture channel passes all advertised rows |
| V1-032 | G4 | V1-031 | Extract Telegram; delete composition glue | Poll/media/voice/steering/proactive smoke |
| V1-033 | G4 | V1-031 | Extract Slack; delete composition glue | Single Socket consumer/thread/status/command smoke |
| V1-034 | G4 | V1-019, V1-031 | Finish webhook module and directory-defined routes | Auth/timeout/status/bounds tests |
| V1-035 | G4 | V1-014, V1-031 | Extract OpenAI API channel and delete Express-only bootstrap | Open WebUI, SSE/JSON termination |
| V1-036 | G4 | V1-011, V1-015 | Extract trigger-cron; delete channel-shaped cron composition | Clock, overlap, queue/replace/watchdog/delivery tests |
| V1-038 | G4 | V1-032, V1-033, V1-034, V1-035, V1-036 | Delete remaining channel/trigger glue and duplicated delivery indexes | Architecture/dead-code audit; all rows green |
| V1-039 | G5 | V1-025, V1-038 | Complete state-local recorder, presence, idempotency, retention, maintenance | Crash/permissions/retention/stale-state |
| V1-042 | G5 | V1-030 | Extract memory-local BuJo, health, and maintenance; retain the permanent descriptor-bound first-run marker contract; keep writer fencing through recovery; redact public provider failures; reject unsafe pre-existing SQLite database type/owner/mode/device-inode identity using descriptor/no-follow checks without path-chmodding operator data; delete lite/journal and old plumbing | Real-store audit/recall/rebuild/forget; concurrent recovery and error-redaction proofs; permanent canonical marker exact-byte/inode/owner/`0600`/single-link/root-identity proof with pre/post-commit swaps, forged same-inode bytes, malformed/in-flight/legacy states, and no pathname rename/unlink; missing-database secure-create plus pre-existing non-regular, wrong-owner, non-`0600`, symlink, and path-swap tests proving fail-closed no-mutation behavior |
| V1-043 | G5 | V1-030 | Extract exporter-otlp; delete mixed observability | OTLP/Phoenix mapping/pressure/shutdown |
| V1-044 | G5 | V1-011, V1-030 | Extract sandbox-srt | Off/native/network/integrity/policy smoke |
| V1-045 | G6 | V1-017, V1-030, V1-038, V1-042 | Refactor existing create-mono-agent for exact selected dependencies and minimal/Personal/multi-runtime stacks; consume memory-local's permanent first-run marker contract without reimplementing it | Packed scaffold matrix, first turns, and initialized/in-flight first-run BuJo fixtures |
| V1-046 | G6 | V1-016, V1-024, V1-039 | Build service-macos as separate product over runner; delete managed closure | Separate-config inspect/plan/apply/remove, drift, install/restart/stop/rollback live smoke |
| V1-047 | G6 | V1-012, V1-030, V1-038, V1-042, V1-043, V1-044, V1-045, V1-046 | Generate config/API/package/product docs; refactor existing docs-mcp as an ordinary companion MCP | Docs/accessibility/link/drift gates; client registration smoke |
| V1-048 | G6 | V1-005, V1-023, V1-024, V1-030, V1-038, V1-042, V1-043, V1-044, V1-045, V1-046, V1-047 | Adapt lockstep beta and packed-consumer verification; prove the canonical successor guard absent; establish and preflight an approved successor `NPM_TOKEN` or reviewed trusted-publishing authority; publish the exact beta candidate | Minimal/Personal/multi-runtime installs; all 23 packages mapped; foreground/service/product proofs; redacted authority preflight; tag/main/SHA match; registry publish, metadata, and clean-install verification |
| V1-049 | G7 | V1-048 | Install the registry-verified beta, rehearse, and cut over Personal Agent exclusively without publishing another version | Exact registry version/SHA and guard-removal proof; consumer matrix, memory/state audit, rollback, 24-hour soak |
| V1-050 | G7 | V1-049 | Rehearse and cut over active `~/agents/a8c-assistant` exclusively; keep retired A8C fleet stopped | Slack/webhook/cron/BuJo/auth/state matrix, rollback, exact single consumer, 24-hour soak |
| V1-051 | G8 | V1-050 | Close ledger, complexity, security, docs, section 2.6 OSS authority, section 2.7 clean-history publication readiness, and reviews | Full gate, working-tree/reachable-history secret scans, branch protections, and clean-clone proof at candidate SHA |
| V1-052 | G8 | V1-051 | After explicit approval, publish stable, announce v0 deprecation, and observe the 30-day window | Clean public clone, registry verification, consumer install, post-launch report |

## 12. Risks, non-goals, revival, and maintenance

### 12.1 Risks

| Risk | Mitigation |
| --- | --- |
| Explicit `$use` feels verbose | It appears only at real replaceable seams; exact implementation is reviewable and no alias magic exists |
| module-sdk grows into a generic plugin framework | Three public factories at open slots, reserved-slot contracts internal until an admitted second implementation, no generic lifecycle hook/tool/extension kind, architecture and 15k kernel gates |
| Agent config becomes a mega-config | Products, MCP definitions, job bodies, skills, and host ops have separate authoritative surfaces |
| Product behavior becomes hidden after leaving agent config | Product package and product-specific config are explicit; package presence never activates anything |
| Custom MCP is abused as a daemon manager | Decision ladder and lifecycle docs distinguish stdio tools, remote services, collectors, and watchdogs |
| Copyleft uncertainty deters third-party modules | Apache-2.0 module-sdk and operator only where file-level provenance and copyright authority permit; explicit inbound terms, per-package licenses, and G8 audit |
| Private predecessor history leaks into publication | Histories never merge; only audited patches cross; reachable-history secret scan and fresh-clone proof block canonical cutover and stable release |
| Runtime mixing loses continuity | Canonical transcript plus explicit route capability checks; private sessions never cross runtimes |
| Cross-runtime fallback duplicates side effects | Settlement and idempotency evidence; no blind retry after committed non-idempotent effects |
| Pi-native integration couples history to Pi | Neutral transcript canonical; Pi sessions remain optimization/linkage |
| Shared operator becomes lowest-common-denominator UI | Only protocol/domain/actions shared; presentation and persistence remain product-owned |
| service-macos becomes agent lifecycle owner | Separate product config and APIs; core runner works without it; no turn/channel/memory semantics in service |
| Doctor/status shrink breaks scripts | Exit codes/JSON frozen; check inventory prevents silent drops |
| Memory simplification drops integrity behavior | Atomic ledger and real-store rehearsal; lite/journal are explicit cuts |
| Rewrite grows or becomes less legible | Paired deletion, one implementation, reproducible ≤130k and kernel gates with recorded reduction |
| Twenty-three packages feel hard to explore | Generated responsibility/dependency/config/API maps and role-based contributor paths |

### 12.2 Non-goals and cuts

Non-goals:

- backward-compatible v0 config parsing or public API shims;
- independent first-party package versioning;
- malicious-module sandboxing;
- hosted marketplace;
- generic plugin registry, path plugins, package self-registration, or dynamic package installation;
- remote MCP receipt of privileged host capabilities in v1;
- child-run host-capability grants (request context/progress, spawn/observe/cancel) in v1;
- a core-owned model-visible Agent/subagent tool;
- a universal provider abstraction across runtimes;
- one configuration file for agent and every product;
- side effects during config load/validate;
- importing old conversation/provider/run/web history;
- operator transport replacement or a universal cross-platform widget framework;
- hot reload;
- Node SQLite/vector migration during stable;
- Windows/Linux service managers in first-party v1;
- migration or restart of the retired A8C outcome fleet.
- publishing, merging, or grafting the private predecessor Git history into the successor.

Explicit cuts remain self-config, `tui --configure`, lite/journal memory,
WhatsApp, Supermemory, generic orchestrator extra, A2A, the continuation
runtime/host grant and all selectable or discoverable continuation surfaces,
and backfill/resend.

### 12.3 Revival and community opportunities

The exact successor `refs/tags/archive/v0-final-full` clean-history source map supports:

- WhatsApp as a channel module only if it genuinely owns bidirectional ingress/delivery;
- Supermemory as a memory module;
- A2A as a channel module only when a new active consumer and authenticated
  interoperability proof justify first-party ownership;
- continuation coordination as a separate capability only when a new active
  consumer, durable-state owner, and security ADR justify a host grant;
- collaborator/orchestration behavior preferably as MCPs or a separate product, not a generic extension hook;
- conversational self-configuration only as a separate reviewed product;
- historical resend as a standalone operations tool;
- alternative memory algorithms as separate memory modules, never modes mixed into memory-local.

Separately from archive revival, a possible child-run capability plane is recorded only as future research: `request.context` (read-only origin identity and run metadata), `request.progress` (bounded progress publication), and `agent.run.spawn/observe/cancel` with maximum depth, children per run, concurrency, duration, runtime allowlist, output bounds, narrow-only child policy and sandbox inheritance, and parent-cancellation cascade. A post-1.0 amendment may admit it only when a real consuming MCP exists and must design a new grant transport and threat model rather than assuming the archived continuation transport.

Revival must use the capability ladder, public contracts, compliance suites, security rules, and budgets. It does not restore code to core.

### 12.4 PRD maintenance

Architecture lives in `docs/reference/v1-architecture.md`. This PRD owns execution status and reviewed roadmap amendments. Until V1-003 generates the requirement report, this document also carries the detailed behavior inventory; thereafter behavior status lives in that report and section 11 ids remain the execution source.

The minimal, Personal Agent, multi-runtime, MCP, service-macos, and web examples are sanitized generated fixtures. Their JSON/YAML must parse, selected `$use` packages must equal expected direct dependencies, and generated documentation must reproduce them without drift.

Any new v0 feature merged after this revision must be atomized in the requirement manifest or explicitly cut through a reviewed amendment before stable. Release criteria may tighten but never weaken without explicit approval.

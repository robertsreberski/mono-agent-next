# Mono-Agent v1: Smaller by Design

Status: Proposed (revision 9 — execution-ready)
Target release: 1.0 beta, followed by 1.0 stable
Last updated: 2026-07-22
Primary audience: maintainers, contributors, and individual agent builders
Decision scope: complete v1 architecture, configuration, deletion ledger, migration, and production rollout

## 1. Executive summary

Mono-agent v1 is a production-grade, config-first wrapper around independently selected agent runtimes. Its user-facing center is one strict `mono-agent.config.json` describing one portable agent. The host loads runtime, channel, memory, state, trigger, continuation, exporter, and sandbox implementations only through typed capability slots. Every replaceable implementation is visible at the point of use through an exact `"$use"` package reference.

There is no generic `plugins` registry, no hidden built-in-name-to-package mapping, no package self-registration, and no runtime package download. Stable instance ids are config keys; `$use` identifies the installed implementation. Project-specific model tools remain ordinary MCP servers in `.mcp.json`, instructions remain skills, scheduled work remains Markdown, and independent collectors or watchdogs remain project or host operations.

Config-first does not mean mega-config-first. TUI, web, service-macos, docs-mcp, and create-mono-agent have independent ownership and lifecycle. They are installed explicitly and use their own small configuration, if they need configuration at all. TUI and web consume one shared operator protocol exposed by an explicitly selected operator endpoint inside the agent. service-macos is only macOS boot integration; the agent remains usable in foreground or under another supervisor when it is absent.

The product of this refactor is a smaller system. The provisional v0 baseline is approximately 182,000–189,000 handwritten production-source lines depending on classification (measured 182,118 on 2026-07-22; exact at G0) across 22 publishable packages; agent-app alone holds approximately 66,000. Stable v1 ships at most 130,000 lines — the binding number, an expected reduction of roughly 30%, with the exact percentage recorded against the normalized G0 baseline rather than gated — and core + module-sdk + cli are capped at 15,000 lines. These are machine-tracked release gates.

Package count is not a success metric. The current v1 roster remains 25 publishable packages because runtimes, communication transports, durable stores, operator products, and host integration have genuinely different ownership and failure boundaries. Architecture gates protect narrow responsibilities and selected dependency closure; they never combine unrelated concerns merely to reduce a count.

The v1 distribution remains one pnpm monorepo releasing first-party packages in lockstep. An agent project owns an ordinary `package.json` and lockfile. Configuration selects only already-installed packages and never turns a JSON edit into remote code installation. Distribution is open source with a deliberate license split: implementations are GPL-3.0-only while the `module-sdk` and `operator` extension surfaces are Apache-2.0, so third-party modules and renderers may carry any license (section 2.6).

### 1.1 The one-page mental model

A mono-agent project is an ordinary directory, and understanding any agent means answering three questions in order:

1. **What code exists here?** `package.json` and the lockfile answer completely. Installing or removing a dependency is the only way code enters or leaves; no config edit, no download, no discovery.
2. **What does this agent use?** `mono-agent.config.json` answers completely. Presence means selected; absence means off. Every replaceable choice names its implementation at the point of use — the map key is the instance's stable name, `$use` is the exact installed package.
3. **Who owns everything else?** The scope table in section 2.1: model tools live in `.mcp.json`, instructions in `skills/`, schedules in `cron/*.md`, and each product (TUI, web, service-macos, docs-mcp) has its own small config. Nothing outside a file's scope can be caused by that file.

Two rules follow, and they are the contract this architecture defends:

- **Reading rule** — every behavior of a running agent traces to one visible line in one of those files. If no line selects it, the behavior does not exist. There is nothing to discover that the files do not say.
- **Writing rule** — behavior changes in exactly this order: install (`package.json`), select (config), restart. No step happens implicitly, and no later step can occur without the earlier one.

When extending, ask "what is my thing?" before "how do I hook in": a tool is an MCP server; know-how is a skill; a schedule is a Markdown job; deferred completion is a continuation claim; a new user interface is an operator product; only a replacement for a framework semantic is a typed module. The full ladder is section 2.3.

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
- Personal Agent and the A8C orchestrator pass their capability matrices, rollback rehearsals, exact single-consumer proofs, and 24-hour soaks.

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
| `continuations` | zero or one | slot itself | required `$use` when present |
| `observability.exporters` | zero or more | map key | required `$use` |
| `policy.sandbox` | off or one implementation | slot itself | required `$use` when active |

The map key answers “which configured instance?” and `$use` answers “which code implements it?”. They are intentionally separate. This permits two instances of one module, stable cross-references, and implementation replacement without renaming routes or jobs. Singleton slots (`memory`, `state`, `continuations`, `policy.sandbox`) have no second identity to learn: the slot name itself is the stable id.

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
| A model tool must deliver a result after its originating turn | MCP plus an explicit `continuation.claim` grant and the continuations module |
| The model needs instructions for an existing CLI or MCP | Skill |
| Work should run on a schedule | Trigger module plus Markdown job |
| An external system pushes a request into the agent | Existing webhook channel |
| A process collects data independently | Project or host service |
| A process must detect complete agent death | Host watchdog outside the agent |
| Automatic runtime, channel, memory, state, trigger, exporter, continuation, or sandbox semantics must be replaced | Narrow typed module package |
| A new user interface is needed | Product consuming the operator protocol |

A stdio MCP child may be started and stopped by the configured harness. A remote MCP server owns its own process lifecycle. Mono-agent does not turn MCP into a generic daemon manager.

Model-visible tool names and orchestration UX remain MCP-owned even when the tool needs privileged host work. v1 defines exactly one grantable host capability — `continuation.claim` (section 5.6). The grant is explicit in agent config, bound to the originating request, and unavailable to every other MCP server. The broader child-run capability family is deliberately deferred; section 12.3 records its design.

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

v1 is distributed as a public open-source project, and the license layout is part of the architecture because it decides who can build on which seam:

- `module-sdk` and `operator` are Apache-2.0. They are the two public extension surfaces — typed module contracts and the renderer protocol/client — so a third-party module or renderer that imports them may carry any license.
- Every other first-party package — core, cli, all first-party modules, and all products — is GPL-3.0-only. Forks and modifications of those packages remain GPL-3.0-only.
- Third-party typed modules and renderers choose their own license.

Mechanically, every publishable package carries its own `LICENSE` file and a manifest `license` field matching this split, and the release pipeline generates a third-party notice inventory for runtime dependencies (the pi packages are ordinary MIT npm dependencies, not vendored code). The repository keeps `CONTRIBUTING.md` and `SECURITY.md` and adds `CODE_OF_CONDUCT.md` plus a short `GOVERNANCE.md` naming the maintainer decision model.

Third-party module discovery is deliberate but is not a marketplace: modules advertise the `mono-agent-module` npm keyword and their capability kind, and canonical documentation generates a community-modules page listing modules whose maintainers attest the public compliance suite passes. Listing is documentation, never endorsement, and never affects loading — installation remains an explicit `package.json` edit.

The G8 "OSS" exit is this checklist verified at the candidate SHA: license files and manifest fields match the declared split; the generated third-party notices are current; `CODE_OF_CONDUCT.md` and `GOVERNANCE.md` exist; the community-modules page and capability ladder are published. The Apache-2.0 licensing of `module-sdk` and `operator` is ratified in the G0 ADR alongside the architecture itself.

## 3. Deletion ledger

This section is normative. Every deletion names its evidence or explicit product decision, replacement when one exists, archive source, and gate. Usage evidence includes config, CLI and flags, services, scheduled jobs, source imports, persisted state, and selected production-consumer matrices.

### 3.1 Archive and detach live consumers before deletion (G0.25)

The normal `main` checkout is a live source for the local CLI and Personal Agent. Phase A cannot begin while a consumer resolves code from it.

1. Cut the final full v0 as a normal semver lockstep release. This exact version is `v0-final` below.
2. Create `archive/v0-final-full` at that release commit and a `v0-maintenance` branch for critical fixes.
3. Pin the local CLI, Personal Agent, A8C orchestrator, and every linked worker away from repository `main` to the exact release.
4. Prove each consumer's resolved package version, process command, config path, channel ownership, memory health, continuation health where applicable, and bounded startup health.
5. Record revival source paths for every Phase A capability.

Any consumer still resolving repository `main` blocks G0.25.

### 3.2 Phase A deletion on lean v0 main (G0.5)

| Item | Provisional source lines | Evidence or explicit decision | Replacement or revival |
| --- | --- | --- | --- |
| whatsapp-adapter | 2,082 | No selected v1 production consumer; removes Baileys dependency | Community channel candidate from archive |
| A2A — retained | — | Four A8C workers serve authenticated A2A and the orchestrator consumes them | First-party channel-a2a |
| memory-supermemory | ~700 | Explicit v1 cut; selected v1 consumers use local BuJo | Community memory-module candidate |
| agent-orchestrator extra | ~500 | Explicit v1 cut; A8C control broker is a separate service | MCP or separate product candidate |
| Self-config engine, patch allowlist, transaction, `tui --configure`, and UI | ~1,900 | Explicit v1 cut; interaction-invoked rather than config-enabled | Schema-derived init, explain, docs |
| Backfill command and export mapping | ~1,700 | Explicit v1 cut; live OTLP remains | Archived standalone tool candidate |
| Unused `@anthropic-ai/sdk` dependency in agent-runtime | 0 | Declared but never imported | None |

G0 replaces provisional counts with exact source and test counts. Removed CLI surfaces return precise guidance. TUI and web remove SELF-CONFIG affordances in the same change. No v1 mechanism is added during G0.5.

### 3.3 Phase B paired replacement and deletion

Each row lands one v1 implementation and deletes or retires the named v0 machinery in the same gate. A temporary compatibility entry point may call the converted implementation; a forked copy is forbidden. "Now" figures are bundle totals grouping related files across packages, not single-file clusters; G0's classifier replaces them with exact reproducible counts.

| Machinery | Now | Planning target | Gate | Preserved outcome or explicit cut |
| --- | --- | --- | --- | --- |
| Managed background and launchd closure | 14,350 | ≤2,500 in service-macos | G6–G7 | Separate service config; programmatic inspect/plan/apply/remove; pinned runner; validate-before-restart; honest status; no resurrection after stop |
| Setup wizard, init, provider setup | 12,500 | ≤3,000 in create-mono-agent | G1 | Schema-derived scaffolder; runtime-owned auth; bounded real route checks |
| Presets registry and command | ~1,000 | 0 | G1 | Scaffold templates land before deletion |
| Doctor orchestration | 3,517 | ≤500 in cli | G1 | Every check maps to core validation, typed-module diagnostics, or reviewed retirement; exit codes and JSON remain |
| Config reference implementation | 1,357 | 0 | G1 | Generated reference and explain land in the same slice |
| Continuation service, store, workers | 5,206 | ≤2,500 in continuations | G5 | Claim, origin, leases, synthesis, retry, cancellation, unknown delivery, routes, CLI, and current format |
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

The baseline figure (182,118 measured on 2026-07-22 excluding handwritten declaration files; approximately 189,000 in the original estimate) is provisional until G0 commits `scripts/v1-complexity-report.mjs` and baseline report #1. The report operates only on Git-tracked files and emits the included-file manifest, classification, line count, and digest. Every executable source file is production, test, generated, vendored, or excluded-with-reason; an unclassified source file fails the gate-exit report rather than every CI run, so budget honesty is machine-tracked without per-PR friction.

Production and test source are reported separately. Reducing tests never satisfies the production budget. Generated files are excluded only when their generator and reproducibility check are recorded.

| Budget | Gate |
| --- | --- |
| Kernel: core + module-sdk + cli | ≤15,000 production-source lines |
| Repository production source at G8 | ≤130,000 (binding); reduction vs the normalized G0 baseline recorded, expected ≈30% |
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
| Channel modules | six channels | ~18,000 |
| Trigger and durable modules | trigger-cron, memory-local, state-local, continuations, exporter-otlp, sandbox-srt | ~17,000 |
| Operator layer | operator, tui, web | ~18,000 |
| Products and companions | create-mono-agent, service-macos, docs-mcp | ~6,500 |

The allocations sum to roughly 87,000; the 130,000 ceiling exists as honest slack, not a target. About one sixth of shipped code is kernel, and the remainder sits behind replaceable module seams or independent product boundaries. The minimal-agent closure (kernel + runtime-pi + channel-webhook) is expected near 22,000 lines with zero native modules.

The report also tracks public exports, dependency edges, cycles, config fields, selected-package closure, and duplicated protocol/config implementations. Rules are paired deletion, one implementation, and boundary before budget. A line target never justifies mixed lifecycles, weaker reliability, deleted required tests, or compressed unreadable code.

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

Core imports no concrete runtime, channel, memory, state, trigger, continuation, exporter, sandbox, UI, documentation server, or service manager. module-sdk provides only typed contracts, schema/provenance helpers, compliance kits, and shared secure filesystem/HTTP primitives.

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

Core does not own provider SDKs/auth, transport mechanics, memory algorithms, storage formats, continuation records/workers, exporters, UI state, documentation search, setup wizards, OS service definitions, package installation, or arbitrary project process supervision.

### 5.3 Typed module contract

module-sdk exports focused definitions rather than `definePlugin`, and slots are open or reserved:

- Open slots — runtime, channel, and memory — have public factories (`defineRuntimeModule`, `defineChannelModule`, `defineMemoryModule`), published compliance suites, and third-party replacement support at v1. Each is justified by at least two real implementations or a demonstrated replacement demand.
- Reserved slots — state, trigger, continuations, exporter, and sandbox — use the same `$use` selection shape and are internally typed identically, but their contracts stay internal to the monorepo until a second real implementation is admitted. The public factory and compliance suite for a reserved slot ship with that promotion, post-1.0 at the earliest. This keeps the kernel small without ossifying the config format.

Every package manifest declares exact package identity, version, `apiVersion: 1`, one capability kind, one-line responsibility, executable schema, optional bounded diagnostics, and optional namespaced maintenance/auth commands. A package cannot receive undeclared host capabilities or return contributions outside its kind.

The module definition must be import-side-effect-free. Import may construct static schemas/manifests but may not read secrets, access the network, spawn a process, or write project/host state. Compliance tests instrument those boundaries.

The selected config's inline fields are validated by the selected module schema. Core-owned directive keys begin with `$`; v1 defines `$schema`, `$use`, and `$env`. Module schemas may not redefine them.

Multiple runtime/channel/trigger/exporter instances may select the same package. Singleton slots select at most one implementation. state-local may coherently own transcript, run recorder, presence, and delivery-idempotency because they share one local durability discipline. Continuations and OTLP remain separate because their state machines, failures, and operations differ.

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

### 5.6 Privileged MCP host capabilities

Model-visible tool names and orchestration UX remain MCP-owned even when a tool needs privileged host work. An MCP must not shell out to a human CLI or import core internals to reach host behavior.

v1 defines exactly one grantable host capability:

- `continuation.claim` — create a durable continuation claim (section 5.7), grantable only when the continuations module is selected.

Grants are request-scoped capability URLs/tokens injected only into explicitly named trusted local stdio children. They are never included in the model prompt, tool result, transcript, logs, artifacts, or remote MCP environment; they are bound to the originating request and expire with it. Unlisted MCPs receive no host capability. Remote MCP capability delegation is outside v1. This grant transport has a live v0 analog — the continuation claim URL/token headers the orchestrator already consumes — so v1 is extracting a proven mechanism, not inventing one.

The broader child-run capability family — request context/progress publication and `agent.run.spawn/observe/cancel` for Agent-style subagent tools — is deliberately deferred: it has no current consumer, and specifying it ahead of one fails the same evidence test this PRD applies to deletions. Section 12.3 records the deferred design so a post-1.0 amendment can admit it through this same grant transport without a new mechanism. Until then an ephemeral child run is not a v1 concept; a durable independently operated agent has its own agent config and is contacted through A2A or operator.

### 5.7 Continuation coordination

A continuation is the durable return path for work completing after the originating turn:

1. bind the claim to origin run, conversation, policy snapshot, reply destination, and deadline;
2. accept one later result with leases, duplicate handling, cancellation, expiry, and recovery;
3. enqueue tool-free synthesis with pinned origin context;
4. deliver only to the authorized destination and persist an idempotent receipt;
5. expose list, status, retry, cancel, and explicit resolution.

The optional continuations module owns claim API, request-scoped capability issuance for explicitly named MCP servers, records, `per-record-v3` format, state machine, workers, retries/dead letters, routes, and operations. Core owns no continuation record or worker. It grants only origin/settlement hooks plus bounded `enqueueRun` and `deliver` capabilities.

This is not A2A-only. A2A may create a continuation, but a project MCP can also claim one for deferred research, approvals, personal-agent work, or another asynchronous operation. Personal Agent's current fixture does not select continuations because its live `.mcp.json` has no continuation-capable server.

### 5.8 State, durability, and lifecycle

Every durable module documents ownership, atomicity/idempotency, schema versioning, retention, backup/restore, reset/purge, corruption behavior, and redaction. Crash tests prove atomic completion or explicit recoverable state. Unknown delivery remains unknown.

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
        "includeSensitiveData": true
      }
    }
  }
}
```

The fixture intentionally omits continuations, host-capability grants, Slack, A2A, native sandboxing, TUI, web, docs-mcp, and service-macos because the live Personal Agent agent process does not select those capabilities. It intentionally includes the local Ollama provider because the live config registers one.

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

The framework has no package knowledge of the tools these servers expose. Skills explain their use. A normal MCP needs no host grant. An MCP whose work may outlive its originating turn receives the only grantable v1 host capability, and the agent must select `@mono-agent/continuations`:

```json
{
  "context": {
    "mcp": {
      "configPath": "./.mcp.json",
      "servers": {
        "deep-research": {
          "grants": [
            "continuation.claim"
          ]
        }
      }
    }
  }
}
```

The server claims a continuation before its turn settles and submits the result later through the claim URL; delivery, synthesis, and receipts follow section 5.7. Agent-style subagent tools (`Agent`, `AgentStatus`, `AgentCancel`) belong to the deferred child-run capability family recorded in section 12.3.

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
    "host": "0.0.0.0",
    "port": 5050
  },
  "auth": {
    "token": {
      "$env": "MONO_AGENT_WEB_AUTH_TOKEN"
    }
  },
  "dataDirectory": "./.mono-agent/web",
  "agentRegistries": [
    "/Users/example/personal-agent/.mono-agent/trace-sources"
  ]
}
```

TUI needs no persistent product config for the common case; it discovers an agent through the same owner-private registry or accepts an explicit operator endpoint. docs-mcp is placed in the coding client's `mcpServers` map. No central products registry is introduced.

### 6.7 Schema, provenance, and commands

One executable schema per core section or selected typed module is the only handwritten definition. Types, validation, defaults, composed JSON Schema, editor completion, redaction, explain output, setup prompts, and reference docs derive from it.

Runtime routes reference configured `runtimes` only. Memory capture routes use the same `{ runtime, model }` shape. Trigger notification references configured proactive channels only. MCP grant entries reference servers present in `.mcp.json`; the only grantable capability is `continuation.claim`, which requires trusted local stdio transport and a selected continuations module. Continuations reference explicitly granted MCP server names and proactive channel instances only. Wrong-kind, missing, incompatible, over-broad, and cyclic references fail with both source paths.

The CLI discovers optional diagnostics/auth/maintenance commands only from modules explicitly named by `$use`. It never scans dependencies or a first-party catalog. Runtime and lifecycle commands remain optional frontends over public APIs; programmatic consumers can load, validate, run, inspect, and reconcile the relevant product without spawning a human CLI.

## 7. Operator, packages, CLI, and documentation

### 7.1 One operator interface, multiple renderers

channel-operator serves one agent over loopback HTTP. operator supplies protocol schemas, the single agent client, cross-agent directory, capability negotiation, domain state machines, and golden fixtures. TUI and web import operator and may not reimplement wire decoding or action eligibility.

The wire remains HTTP routes plus NDJSON turn streaming with disconnect-aborts-turn semantics. An SSE redesign is out of v1: EventSource cannot POST and would add buffering while changing a load-bearing cancellation boundary.

Given the same fixture stream and capabilities, TUI and web produce equivalent conversation/turn state, AskUser state, and available actions. Renderers retain layout, navigation, widgets, terminal/browser integration, and platform persistence.

The shared contract covers discovery/selection/pinning, conversations, turns, live input, cancellation, AskUser, model/effort overrides, attachments, quoting, config/replay/health views, per-turn context-window usage with compaction and provider-session eviction telemetry, proactive delivery into new operator conversations, and renderer exit without stopping the agent. Web keeps its durable SQLite store, uploads, active-turn survival, and notifications. TUI keeps pi-tui rendering and terminal UX.

Products are installed and launched independently. service-macos may start agent and web as separately declared services, but it never infers web from agent config.

### 7.2 v1 package roster — currently 25

| Ownership category | Packages |
| --- | --- |
| Core infrastructure (3) | module-sdk, core, cli |
| Runtime modules (4) | runtime-pi, runtime-claude, runtime-codex, runtime-opencode |
| Channel modules (6) | channel-telegram, channel-slack, channel-webhook, channel-openai-api, channel-a2a, channel-operator |
| Trigger modules (1) | trigger-cron |
| Durable capability modules (5) | memory-local, state-local, continuations, exporter-otlp, sandbox-srt |
| Operator layer (3) | operator, tui, web |
| Project tooling (1) | create-mono-agent |
| Host products (1) | service-macos |
| Companion MCPs (1) | docs-mcp |

The 16 runtime/channel/trigger/durable packages are agent-selectable typed modules. TUI, web, service-macos, docs-mcp, and create-mono-agent are not agent modules. operator is a shared library. Core, module-sdk, and CLI arrive through dependencies rather than synthetic config entries.

Against the 22-package v0 baseline the roster is a net +3, and each increase is named rather than waved off: one runtime package became four because multi-runtime execution is the differentiating showcase (section 2.5); the operator layer split into operator and channel-operator so renderers and the agent endpoint stop sharing one package; and module-sdk, create-mono-agent, service-macos, and docs-mcp isolate lifecycles v0 mixed inside agent-app. Every increase is an ownership boundary, not new behavior; the line budget in section 4, not the package count, is the size metric.

Retired v0 names: agent-app, agent-contracts, agent-harness, agent-runtime, config, observability, runtime-adapter, operator-adapter, channel-cron, plugin-sdk, plus Phase A deletions. Package count is reported but not gated. Package READMEs and public API maps derive from owned metadata.

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
| continuations | continuations maintenance surface |
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

The ledger is a reviewed disposition checklist, not a bespoke test-to-requirement CI framework. CI enforces only that the ledger parses, ids are unique and stable, and every row is `kept` or `cut`. Each kept row names its proof — a test path, captured live evidence, or migration artifact — and the owning gate's exit review verifies those named proofs. Operational cutover rows may use captured live evidence; normal code behavior requires automated proof.

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

**A2A**

Agent Card, provider endpoint, bearer auth, production-record-compatible idempotency, remote discovery/consumption, and no core dependency.

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

SQLite identity, migrations, ownership, corruption reporting, BuJo recall with/without embeddings, vector + FTS, dimensions, breaker/fallback, completed-turn capture idempotency, runtime-backed capture, consolidation, strict audit, preview, backup, rebuild, forget, and intake retry. Lite, journal, and the `append-host-summary` write mode are cut rows (fleet configs use only `capture` and disabled).

**State**

Atomic canonical transcript, duplicate protection, provider-session linkage, verbatim append, AskUser evidence, run summaries/events, retention, stale-run classification, memory-run separation, owner-private discovery/presence with the optional machine-wide discovery mirror, a rollover-independent cursor-paged run-history model tool, and channel delivery-idempotency indexes.

**Continuations**

Claim capability, origin binding, deadlines/bounds, durable leases, retry, cancellation, dead letters, channel-instance routes, tool-free synthesis, receipts, unknown-delivery recovery, `per-record-v3` compatibility, and list/status/retry/cancel/resolve without token exposure.

**Observability**

Structured event bounds/redaction, OTLP/Phoenix mapping, project/session mapping, pressure, flush/shutdown, include-sensitive warning, opt-in content-pattern credential scanning of retained free text, and visible degradation.

**Security and sandbox**

No inline secrets in secret fields; redaction in logs/errors/health/explain/docs; owner-only writes and symlink/ownership checks where promised; shared HTTP bind/bearer/Host/Origin/body/shutdown hardening; fallback policy monotonicity; SRT off/native/network/integrity behavior.

**MCP-first project extension**

- named standard MCP config loading;
- `continuation.claim` grants only for named trusted local stdio servers, with no token exposure to the model;
- custom MCP without mono-agent package/catalog changes;
- durable detached completion only through an explicit continuation claim;
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

Continuity policy is memory plus continuation control state where a consumer uses continuations. A pending continuation is active work with a delivery obligation, not disposable history.

| State | v1 treatment | Reason |
| --- | --- | --- |
| BuJo roots, SQLite identity, embedding metadata, unresolved intake | Preserve after audited rehearsal and backup | User-owned durable memory |
| Continuation `per-record-v3` records, origins, transactions, ownership, guards, receipts | Preserve for A8C cutover | Active claims, idempotency, rollback, unknown delivery |
| Conversation history, native runtime sessions, run artifacts, web conversations | Do not import; retain read-only v0 copy through rollback window | No stable cross-version product promise |
| Logs and transient caches | Do not import beyond existing operations policy | Diagnostic, not canonical |

v1 uses distinct directories for new transcript, runs, discovery, exporter, and web state. Memory and continuation directories are the only v0 canonical directories adopted.

### 9.2 Memory cutover

Freeze the memory format through both betas. Per consumer: audit; back up; rehearse on a copy; compare representative vector and FTS recall; perform capture, duplicate admission, forget preview, and rebuild; prove v0-final and v1 readers; cut over with a final audit; retain backup through rollback.

Any integrity failure, format mutation, missing behavior, or remaining lite/journal dependency blocks that consumer. Lite/journal data is not automatically converted; separately migrate it to BuJo or keep that consumer on frozen v0.

### 9.3 Continuation cutover

continuations preserves `per-record-v3` through beta. G5 uses a sanitized corpus and a captured week of orchestrator records to prove:

1. v0-final and v1 open equivalent cloned stores and produce the same normalized inventory;
2. both execute claim, activate/abandon, submit, lease recovery, synthesize, deliver, retry, cancel, dead-letter, and resolve transitions;
3. v0-final reopens v1-written terminal, active, unknown-delivery, and legacy-migrated records;
4. ownership, permissions, bounds, HMAC/digest, interrupted transactions, and rollback guards fail closed.

Shadow uses a clone with delivery disabled; two coordinators never own canonical state simultaneously. At cutover, stop v0, prove process death and lock release, back up, start v1, and reconcile every nonterminal id before delivery.

If compatibility fails, freeze new claims, drain active and unknown records to zero under v0, archive terminal state, and start a fresh v1 store. Any unresolved claim blocks. This fallback requires a PRD amendment.

### 9.4 Agent and product migration

There is no v0 config parser. Each consumer receives:

- explicitly authored v1 agent config and exact selected-module package closure;
- existing or migrated `.mcp.json`, skills, Markdown jobs, and project services;
- separate product configs only for installed products;
- a field-by-field migration map to typed agent slot, MCP/skill/cron, product config, host operations, or explicit cut.

Personal Agent shadow uses separate service ids and ports with Telegram delivery disabled. Cutover occurs at a session rollover boundary. The sanitized section 6.3 fixture is the review artifact for behavior coverage; the live file supplies exact private paths and identifiers.

service-macos plan binds its own config digest, agent config/package/lockfile digests, exact Node and runner paths, protected environment source, observed launchd state, and logs. It never expands secrets into service definitions, installs dependencies, rewrites agent config, or shells through a human CLI command. Apply stages/promotes atomically; restart validates replacement first; stop proves unload and process death; remove disables recovery.

The web product is migrated independently against channel-operator and its discovery registry. docs-mcp is registered independently in each selected coding client. Neither is inferred from agent config or service-macos package presence.

If service-macos was never installed/applied, no launchd state exists and the agent remains foreground-runnable. To remove an existing service, inspect and apply its removal through the service product before removing its product config/dependency. Merely deleting JSON is not an implicit host mutation.

### 9.5 Rollback

Stop and prove death of v1; reconcile continuation state where selected; audit memory; restore a complete pre-cutover backup only when format/records require it; load retained v0; prove version, config, process, channels, and health; record reason.

Immediate rollback triggers: duplicate Telegram/Slack consumption, missing or duplicate continuation delivery, memory corruption/loss, unprovable process identity, auth failure hidden by fallback, healthy-while-unavailable, missed schedule without explicit failure, crash loop, or secret exposure.

## 10. Delivery gates

| Gate | Content | Exit evidence |
| --- | --- | --- |
| G0 — commitment | ADR ratifies typed modules, scoped products, cuts, migration, budgets; exact classifier/baseline and atomic ledger | Reviewed ADR; manifest/digest/count reproducible; every behavior kept or cut |
| G0.25 — archive/detach | Final v0 release, archive tag, maintenance branch; local CLI and consumers pinned off main | Exact versions, processes, configs, channel ownership, memory/continuation health |
| G0.5 — deletion-first v0 | WhatsApp, Supermemory, orchestrator extra, self-config, backfill, unused dependency removed | Focused + broad CI green; no SELF-CONFIG; complexity delta |
| G1 — config-first skeleton | module-sdk typed contracts; strict slot schema; direct-dependency loader; core host/API and scoped MCP grants; thin CLI; minimal Pi + webhook; schema scaffolder; old config/controller/wizard machinery deleted | Packed clean-project turn; no-side-effect import/load; exact closure; explain/schema tests; external open-slot module and continuation-claim MCP fixtures |
| G2 — operator products | operator client/directory/domain fixtures; channel-operator; TUI/web standalone products | Fixture parity; no second decoder/action reducer; independent product lifecycle smokes |
| G3 — runtimes/history | Canonical transcript; four runtimes; structured runtime/model routing; Pi-native sessions/compaction; old drivers deleted | One live smoke/family; same/cross-runtime fallback; settlement/history |
| G4 — channels/triggers | Six channels plus trigger-cron; shared security/compliance; old glue/index duplication deleted | Atomic rows; Telegram/Slack/A2A/OpenAI smokes; clock-controlled cron |
| G5 — durable capabilities | state-local, continuations, memory-local BuJo-only, exporter-otlp, sandbox-srt; old state/memory/observability deleted | Durable review; memory rehearsal; continuation corpus/week; exporter/sandbox proofs |
| G6 — products/release | create-mono-agent; service-macos separate product; docs-mcp; generated docs; lockstep beta; migration guide | Packed minimal/Personal/multi-runtime scaffolds; all packages accounted; service and docs product smokes |
| G7 — production beta | Publish beta; migrate Personal Agent, then A8C orchestrator | Consumer matrices, audits, rollback, exact single consumer, 24-hour soak each |
| G8 — stable | Ledger green; source ≤130k with recorded reduction vs baseline; kernel ≤15k; stable publish | Exact-SHA reports; packed consumer install; section 2.6 OSS checklist green; post-launch dispositions |

Gates merge in order. Work inside a gate may run concurrently only where the task graph permits.

## 11. Execution task graph

Every implementation PR names task and requirement ids, includes paired deletion, and gives every external review finding a fixed/follow-up/rejected disposition. A task is complete only when proof is committed.

Execution conventions: development begins with the three G0 PRs in order — the ADR (V1-001), the classifier and baseline report (V1-002), and the requirement manifest (V1-003). One task per PR unless a row explicitly pairs deliverables; branches name their task (for example `v1/g1-v1-013`). A PR that discovers scope this document missed amends the PRD in the same review rather than absorbing it silently. After the G0 ADR merges, architecture questions cite the ADR and this section tracks execution only.

| ID | Gate | Depends on | Deliverable and paired deletion | Required proof |
| --- | --- | --- | --- | --- |
| V1-001 | G0 | — | Ratify ADR for typed modules, product boundaries, config, cuts, migration, budgets | Architecture approval |
| V1-002 | G0 | V1-001 | Commit classifier and normalized baseline | Clean-checkout digest/count reproduction |
| V1-003 | G0 | V1-001 | Build atomic requirement manifest | Zero unclassified behaviors; deterministic ledger |
| V1-004 | G0.25 | V1-002, V1-003 | Cut final v0 and archive/maintenance refs | Registry install and tag/SHA/version match |
| V1-005 | G0.25 | V1-004 | Pin local CLI and main-linked consumers to v0-final | Resolution/process/config/state proof |
| V1-006 | G0.5 | V1-005 | One deletion wave: remove WhatsApp, Supermemory, orchestrator extra, self-config with transactions and `tui --configure` UI affordances, backfill/export mapping (retaining live export), and the unused dependency | Focused tests, negative tests with guidance, architecture/docs, complexity delta |
| V1-009 | G0.5 | V1-006 | Certify lean v0 base | Focused lanes + broad CI; ledger/delta |
| V1-010 | G1 | V1-009 | Create module-sdk/core/cli skeletons, category rules, and the section 2.6 license split in package manifests | Catalog, dependency, API, license, pack checks |
| V1-011 | G1 | V1-010 | Implement typed contracts for all eight slots — public factories and compliance kits for the three open slots, internal contracts for reserved slots — with manifests, schemas, diagnostics/commands | Type tests, import-side-effect instrumentation, one fixture per open kind |
| V1-012 | G1 | V1-011 | Implement strict agent/runtimes/routing/context/capability/policy schema with `$use`, inline leaf config, references, provenance | Minimal/Personal/multi-runtime fixtures; error/redaction tests |
| V1-013 | G1 | V1-011, V1-012 | Implement exact direct-dependency/lockfile module loader; reject aliases, paths, scans, wrong kinds | Resolution/digest/dependency negatives; no lifecycle/install side effects |
| V1-014 | G1 | V1-011 | Implement secure-fs and shared HTTP lifecycle helpers | Adversarial filesystem/HTTP contracts |
| V1-015 | G1 | V1-011, V1-012, V1-013 | Implement host lifecycle, bounds, settlement, health, shutdown, and the request-scoped `continuation.claim` grant hook | Lifecycle/crash/backpressure plus grant isolation and token-scoping tests |
| V1-016 | G1 | V1-012, V1-015 | Implement load/validate/create/inspect APIs and thin CLI validate/schema/explain/diagnostic routing | Programmatic/CLI parity; exit/JSON compatibility; read-only load |
| V1-017 | G1 | V1-012, V1-016 | Land schema-derived minimal and selected-stack scaffolds; delete presets/wizard/config reference | Packed snapshots, exact closure, names-only secret example, transactional failure |
| V1-018 | G1 | V1-011, V1-016 | Convert doctor inventory to core + selected-module diagnostics; delete old orchestration | Every v0 check mapped or cut |
| V1-019 | G1 | V1-013, V1-015 | Complete real Pi + webhook vertical slice and project MCP fixture; delete app-controller/config glue | Packed clean-project turn and minimal closure |
| V1-020 | G2 | V1-011 | Extract operator protocol, one NDJSON client, and turn/stream/AskUser/capability/directory domain state | Golden wire/frame/disconnect tests; deterministic reducer/action fixtures |
| V1-022 | G2 | V1-015, V1-020 | Extract channel-operator typed module | Protocol compliance and disconnect abort |
| V1-023 | G2 | V1-020, V1-022 | Migrate TUI as standalone operator product; delete local interpretations/config-mode UI | TUI parity and interactive smoke |
| V1-024 | G2 | V1-020, V1-022 | Migrate web as standalone operator product with separate config and durable ownership | Web parity, restart/upload/notification/auth smoke |
| V1-025 | G3 | V1-015 | Extract canonical neutral transcript into state-local | Settlement, duplicate, replay, AskUser, corruption |
| V1-026 | G3 | V1-019, V1-025 | Finish runtime-pi with upstream sessions/compaction; delete hand-rolled drivers | Pi live smoke and linkage |
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
| V1-037 | G4 | V1-031 | Extract A2A provider/consumer channel | Production corpus and authenticated smoke |
| V1-038 | G4 | V1-032, V1-033, V1-034, V1-035, V1-036, V1-037 | Delete remaining channel/trigger glue and duplicated delivery indexes | Architecture/dead-code audit; all rows green |
| V1-039 | G5 | V1-025, V1-038 | Complete state-local recorder, presence, idempotency, retention, maintenance | Crash/permissions/retention/stale-state |
| V1-040 | G5 | V1-014, V1-015 | Extract continuation store/state machine/worker/operations preserving `per-record-v3` | Sanitized + transition corpus; cross-open |
| V1-041 | G5 | V1-030, V1-038, V1-040 | Wire origin settlement, synthesis queue, channel routes, receipts, recovery | Week-of-records and fault injection |
| V1-042 | G5 | V1-030 | Extract memory-local BuJo, health, maintenance; delete lite/journal and old plumbing | Real-store audit/recall/rebuild/forget |
| V1-043 | G5 | V1-030 | Extract exporter-otlp; delete mixed observability | OTLP/Phoenix mapping/pressure/shutdown |
| V1-044 | G5 | V1-011, V1-030 | Extract sandbox-srt | Off/native/network/integrity/policy smoke |
| V1-045 | G6 | V1-017, V1-030, V1-038, V1-042 | Finish create-mono-agent for exact selected dependencies and minimal/Personal/multi-runtime stacks | Packed scaffold matrix and first turns |
| V1-046 | G6 | V1-016, V1-024, V1-039 | Build service-macos as separate product over runner; delete managed closure | Separate-config inspect/plan/apply/remove, drift, install/restart/stop/rollback live smoke |
| V1-047 | G6 | V1-012, V1-030, V1-038, V1-041, V1-042, V1-043, V1-044, V1-045 | Generate config/API/package/product docs; migrate docs-mcp as ordinary companion MCP | Docs/accessibility/link/drift gates; client registration smoke |
| V1-048 | G6 | V1-023, V1-024, V1-030, V1-038, V1-041, V1-042, V1-043, V1-044, V1-045, V1-046, V1-047 | Adapt lockstep beta and packed-consumer verification | Minimal/Personal/multi-runtime installs; all 25 packages mapped; foreground/service/product proofs |
| V1-049 | G7 | V1-048 | Rehearse and cut over Personal Agent exclusively | Consumer matrix, memory/state audit, rollback, 24-hour soak |
| V1-050 | G7 | V1-049 | Rehearse and cut over A8C orchestrator exclusively | Continuation reconciliation, Slack/A2A, rollback, 24-hour soak |
| V1-051 | G8 | V1-050 | Close ledger, complexity, security, docs, the section 2.6 OSS checklist, reviews | Full gate at candidate SHA |
| V1-052 | G8 | V1-051 | Publish stable, announce v0 deprecation, observe 30-day window | Registry verification, consumer install, post-launch report |

## 12. Risks, non-goals, revival, and maintenance

### 12.1 Risks

| Risk | Mitigation |
| --- | --- |
| Explicit `$use` feels verbose | It appears only at real replaceable seams; exact implementation is reviewable and no alias magic exists |
| module-sdk grows into a generic plugin framework | Three public factories at open slots, reserved-slot contracts internal until an admitted second implementation, no generic lifecycle hook/tool/extension kind, architecture and 15k kernel gates |
| Agent config becomes a mega-config | Products, MCP definitions, job bodies, skills, and host ops have separate authoritative surfaces |
| Product behavior becomes hidden after leaving agent config | Product package and product-specific config are explicit; package presence never activates anything |
| Custom MCP is abused as a daemon manager | Decision ladder and lifecycle docs distinguish stdio tools, remote services, collectors, and watchdogs |
| Continuation claim tokens leak or outlive their origin | Request-scoped capability URL/token bound to origin and deadline, never in prompt/transcript/logs; the child-run grant family is deferred entirely (section 12.3) |
| Copyleft uncertainty deters third-party modules | Apache-2.0 module-sdk and operator, with the split stated per package in section 2.6 |
| Runtime mixing loses continuity | Canonical transcript plus explicit route capability checks; private sessions never cross runtimes |
| Cross-runtime fallback duplicates side effects | Settlement and idempotency evidence; no blind retry after committed non-idempotent effects |
| Continuation extraction loses active work | `per-record-v3`, cross-open corpus, week rehearsal, unresolved claims block cutover |
| Pi-native integration couples history to Pi | Neutral transcript canonical; Pi sessions remain optimization/linkage |
| Shared operator becomes lowest-common-denominator UI | Only protocol/domain/actions shared; presentation and persistence remain product-owned |
| service-macos becomes agent lifecycle owner | Separate product config and APIs; core runner works without it; no turn/channel/memory semantics in service |
| Doctor/status shrink breaks scripts | Exit codes/JSON frozen; check inventory prevents silent drops |
| Memory simplification drops integrity behavior | Atomic ledger and real-store rehearsal; lite/journal are explicit cuts |
| Rewrite grows or becomes less legible | Paired deletion, one implementation, reproducible ≤130k and kernel gates with recorded reduction |
| Twenty-five packages feel hard to explore | Generated responsibility/dependency/config/API maps and role-based contributor paths |

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
- fleet-wide A8C worker migration beyond the named orchestrator cutover.

Explicit cuts remain self-config, `tui --configure`, lite/journal memory, WhatsApp, Supermemory, generic orchestrator extra, and backfill/resend.

### 12.3 Revival and community opportunities

The exact `archive/v0-final-full` source map supports:

- WhatsApp as a channel module only if it genuinely owns bidirectional ingress/delivery;
- Supermemory as a memory module;
- collaborator/orchestration behavior preferably as MCPs or a separate product, not a generic extension hook;
- conversational self-configuration only as a separate reviewed product;
- historical resend as a standalone operations tool;
- alternative memory algorithms as separate memory modules, never modes mixed into memory-local.

Separately from archive revival, the deferred child-run capability plane is recorded here as future design: `request.context` (read-only origin identity and run metadata), `request.progress` (bounded progress publication), and `agent.run.spawn/observe/cancel` with maximum depth, children per run, concurrency, duration, runtime allowlist, output bounds, narrow-only child policy and sandbox inheritance, and parent-cancellation cascade. A post-1.0 amendment admits it only when a real consuming MCP exists, reusing the section 5.6 grant transport unchanged.

Revival must use the capability ladder, public contracts, compliance suites, security rules, and budgets. It does not restore code to core.

### 12.4 PRD maintenance

This PRD is the decision source until the G0 ADR and generated ledger exist. Thereafter architecture lives in the ADR, behavior status in the requirement report, and execution status in section 11 ids.

The minimal, Personal Agent, multi-runtime, MCP, service-macos, and web examples are sanitized generated fixtures. Their JSON/YAML must parse, selected `$use` packages must equal expected direct dependencies, and generated documentation must reproduce them without drift.

Any new v0 feature merged after this revision must be atomized in the requirement manifest or explicitly cut through a reviewed amendment before stable. Release criteria may tighten but never weaken without explicit approval.

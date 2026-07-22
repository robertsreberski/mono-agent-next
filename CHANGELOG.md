# Release notes

## 0.15.0 — Live steering and precise runtime activity (2026-07-22)

### Highlights

- Plain-text follow-ups sent while an agent is working can now steer the active
  turn from Slack, Telegram, and the web console. The adapter-neutral live-input
  contract carries provider acknowledgement through Claude SDK, Codex
  app-server, and Pi runs, while unsupported providers and end-of-turn races
  queue the message as the next ordinary turn instead of losing it.
- The web console persists live follow-ups and their pending, applied, queued,
  or cancelled state in its owner-private SQLite store. Applied guidance is
  committed to canonical conversation history and memory, so reloads, restarts,
  and later turns preserve what changed the answer.
- Pi, Codex app-server, and OpenCode app-server now publish exact provider-native
  context measurements and normalized compaction lifecycles. The web console
  renders measured usage and one update-in-place compaction activity row without
  exposing provider summaries.

### Reliability and security

- The v1 closeout removes the retired `session-web` / live-relay vertical and
  other proven-dead compatibility APIs, narrows controller, lifecycle, doctor,
  memory, and Slack ownership boundaries, and makes config validation and the
  final CI verdict explicit.
- Runtime shutdown/backpressure, managed web logs, orphan cleanup, artifact
  credential scanning, dependency audits, and packed-package verification are
  now bounded and executable repository gates.
- Slack AskUser cards use unique Block Kit action identifiers, and long web
  conversation lists remain independently scrollable so the composer stays
  visible at desktop and mobile viewport sizes.

### Compatibility

- Existing Slack, Telegram, and web configurations require no migration for
  live steering. Attachments continue through the ordinary queued-turn path;
  each live follow-up is bounded to 8,000 characters.
- The retired `@mono-agent/session-web` package is no longer part of the
  publishable catalog. All 22 remaining catalog-publishable packages move
  together to 0.15.0; keep every `@mono-agent/*` package and
  `create-mono-agent` on the same exact version.

## 0.14.0 — Durable conversations and self-healing agents (2026-07-21)

### Highlights

- `AskUser` is now one adapter-neutral structured interaction across the web
  console, Slack, and Telegram. It supports one to five questions, described
  choices, custom replies, and multi-select forms while preserving the logical
  producer's history and targeting the physical channel conversation.
- Cron and webhook results can create dedicated, marked web-console
  conversations through the explicit `web:new` destination. Successful
  deliveries append durable agent history, preserve the selected thread, and
  use authenticated, idempotent loopback ingress.
- `RunHistory` now searches logical conversations across daily rollover
  buckets, with compact overviews, cursor-paged timelines, and guided follow-up
  calls that avoid recursive history payloads.

### Reliability and documentation

- Managed macOS LaunchAgents gain an authenticated self-healing controller that
  checks worker/runtime identity at login and every five minutes, stages safe
  replacements while the existing worker serves, retries failed recovery, and
  still respects an explicit stop.
- `@mono-agent/docs-mcp` now exposes the unified `mono_agent_docs` search/read
  tool with heading anchors, source offsets, offline link targets, and exact
  previous/next continuation actions over the version-matched corpus.
- The final-agent demo no longer imposes a positive turn cap by default;
  `runtime.maxTurns` remains available as an explicit opt-in. Package READMEs,
  generated API inventories, link checks, and website accessibility coverage
  have also been standardized across the publishable set.

### Compatibility

- The documentation MCP's former `search_mono_agent_docs` tool is replaced by
  `mono_agent_docs` and its v2 response schema; exact-version consumers should
  update the configured tool name with this release.
- The scheduled CLI compatibility spellings `restart --force`, `metrics`, and
  `audit-runs` are removed. Use `restart --clear-sessions`, `runs report`, and
  `runs audit --artifacts <path>` respectively. The unrelated `--force` flags
  on `install-skill` and `web reset` remain supported.
- All 23 catalog-publishable packages move together to 0.14.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.13.0 — Native channel controls and safer operator workflows (2026-07-20)

### Highlights

- Slack and Telegram now provide native model and reasoning-effort selectors
  derived from the configured primary and fallback models. Slack supports both
  mention commands and workspace-registered `/<bot-username>-model` and
  `/<bot-username>-effort` commands, with DM-wide, channel-wide, and
  thread-local override scopes.
- Slack now matches Telegram's final-answer delivery: transient, redacted tool
  activity remains a separate progress message, the completed answer is posted
  as a fresh message, and the progress message is then removed best-effort.
- The new `@mono-agent/docs-mcp` companion provides version-matched semantic and
  exact-identifier search over the bundled mono-agent documentation.
- The always-on web console gains clearer agent navigation, response status,
  browser notifications, quoted-reply rendering, and the canonical `/gui`
  operator route.

### Reliability and security

- Managed runtime startup and restart readiness are faster and stricter, while
  Pi's SRT launch path enforces the configured all-network sandbox and preserves
  system DNS resolution.
- Runtime failover survives re-initialization against loopback MCP endpoints,
  indexed skills prefer the dedicated `ReadSkill` path, and Slack markdown/tool
  previews no longer expose internal sentinels or absolute paths.
- Telegram file delivery remains bound to the originating chat, and its
  interactive sessions retain durable reply history across control actions.

### Compatibility

- Slack slash commands require the bot `commands` scope plus registered
  `/<bot-username>-model` and `/<bot-username>-effort` commands. Socket Mode
  carries both command and menu payloads, so no public request URL is needed.
- The CLI now uses grouped help and uniform JSON/exit-code contracts; deprecated
  command shims and the legacy read-only `sessions` command have been removed.
- All 23 catalog-publishable packages, including the new
  `@mono-agent/docs-mcp`, move together to 0.13.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.12.0 — Always-on web console and resilient agent sessions (2026-07-17)

### Highlights

- `mono-agent web start` installs an always-on assistant-ui browser console for
  every locally discovered agent. The service owns its conversations and
  in-flight turns, persists owner-private state and uploads, and keeps work
  running across browser reloads or disconnects.
- The Pi runtime adds the managed `NodeRepl` tool: a run-scoped JavaScript REPL
  with multiline input, top-level `await`, workspace package resolution, and
  the same native-sandbox boundary as `Bash`.

### Reliability

- Pi compaction now treats a still-overflowing context as `context_limit`,
  preserving typed failure evidence and allowing the configured fallback chain
  to recover instead of terminating as an unclassified provider error.
- TUI self-configuration remains attached to the same marked conversation
  after approvals, rejections, proposal-free turns, `done`, and `no changes`.
  Only an explicit exit leaves configuration mode, while successful changes
  restart the managed agent and reconnect to the proven fresh endpoint.

### Compatibility and security

- `mono-agent web` now owns the persistent chat console; the previous read-only
  run browser remains available as `mono-agent sessions`.
- The web console listens on `0.0.0.0:5050` by default for trusted LAN and
  Tailnet use and deliberately has no application login. Use `--loopback` when
  network peers must not have owner-equivalent access, and do not expose it to
  an untrusted or public network.
- `NodeRepl` joins the Pi bridge's managed allow-all tool set. Restrictive tool
  policies must name it explicitly when JavaScript evaluation is desired.
- All 22 catalog-publishable packages, including the new `@mono-agent/web`,
  move together to 0.12.0. Keep every `@mono-agent/*` package and
  `create-mono-agent` on the same exact version.

## 0.11.6 — Configurable A2A request bodies (2026-07-17)

### Added

- A2A providers can set `provider.maxRequestBytes` or
  `MONO_AGENT_A2A_MAX_REQUEST_BYTES` when authenticated task envelopes exceed
  the SDK's default request-body size.
- Configured JSON-RPC and REST routes authenticate before parsing and return
  protocol-shaped errors for oversized or malformed JSON bodies.

### Compatibility

- Omitting the setting preserves the A2A SDK default. Configured values must be
  integers from 1,024 through 100,000,000 bytes.
- All 21 catalog-publishable packages move together to 0.11.6. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.5 — Transient tool activity without thought clutter (2026-07-17)

### Added

- Interactive Slack and Telegram replies now expose tool starts in one
  cumulative, redacted status message while the agent works. Adjacent duplicate
  calls are compacted, and the same message is replaced by the final answer.
- `showHints: false` remains the opt-out for these activity previews. Proactive
  deliveries do not create a ledger, and acknowledged cancellation removes a
  still-transient status message on a best-effort basis.

### Fixed

- Pi streams and the OpenAI-compatible API no longer synthesize messages such
  as `Running Bash...` into assistant reasoning. Structured tool events and
  genuine model thoughts remain available to their intended consumers.

### Compatibility

- Existing Slack and Telegram configurations require no changes. Preview text
  is bounded and redacted before delivery.
- All 21 catalog-publishable packages move together to 0.11.5. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.4 — Hardened runtime operations and bounded state (2026-07-17)

### Highlights

- Webhooks now support static bearer authentication through `webhook.apiKey` /
  `MONO_AGENT_WEBHOOK_API_KEY`. Non-loopback binds require both explicit
  opt-in and a key, while endpoint-specific `maxRunMs` values can override the
  adapter watchdog.
- Managed macOS launchd instances now bound stdout and stderr automatically:
  active files plus three retained generations are capped at 5 MiB each and
  checked every five minutes. `validate` and `doctor` report the safely
  inspected inventory.
- Running observability artifacts checkpoint after 25 events or five seconds.
  Retention also sweeps orphaned atomic temporaries, exporter buffers are
  bounded, and sensitive exports can opt into high-confidence content-pattern
  secret redaction.
- Confirmed Slack and Telegram sends are appended to the destination
  conversation history, so later replies and cold replay include what the user
  actually received. TUI replay also renders recorded session boundaries.
- Slack's code-only `silent` delivery option is now explicit: both proactive
  sends and message streams accept the request, warn once that Slack cannot
  suppress bot-post notifications, and post with normal notification behavior.

### Reliability

- Durable A2A admissions publish atomically; continuation migration and
  rollback recovery are hardened; notification fallbacks are resolved and
  cancellation-bound per run rather than retained from process startup.
- Cold durable Pi resumes seed canonical history structurally only when a
  transcript must be recreated, avoiding duplicated or omitted turns.
  `restart --force` now removes both Pi transcripts and canonical active
  conversation history for a genuine fresh start.
- Memory maintenance now keeps read-only opens side-effect free, bounds replay
  guards and Supermemory completion fingerprints, normalizes proven embedding
  transport failures without swallowing programming errors, and retains at
  most three explicit-forget backups for 30 days while preserving active
  recovery state.
- OpenAI-compatible streaming caps serialized tool-result SSE frames at
  256 KiB and warns when sampling parameters are ignored. WhatsApp preserves
  FIFO handling per chat while allowing independent chats to progress
  concurrently.
- Release assurance now checks package-count drift, root workspace pins,
  exact known-compatible Pi dependency pins, explicit release-age policy,
  high-severity advisory dispositions, and isolated packed-consumer installs.

### Security

- Runtime-adapter sandbox injection is authoritative, and native Node launcher
  trust checks prevent caller overrides and unsafe launcher substitution.
- Network adapters recheck the actual resolved bind address; Pi OAuth stores
  refuse symlinked paths; managed-runtime provenance is bound to the verified
  dependency closure and rejects hardlinked runtime files.
- Session Web markdown rendering is hardened against adversarial fragments.
  Slack credential logging is redacted, and repository secret scanning now
  recognizes Telegram Bot API tokens, including token-bearing URLs.
- Shared owner-private publication, locking, replacement, and redaction
  primitives fail closed on FIFOs, link swaps, interrupted publication, and
  unsafe recovery races.

### Compatibility

- Existing loopback-only webhooks remain unauthenticated unless `apiKey` is
  configured. Existing non-loopback webhook deployments must add an API key;
  endpoint watchdog overrides are optional.
- Proven-dead compatibility exports were removed, including TUI cancellation
  aliases and `TUI_PACKAGE_VERSION`, Session Web's `listInstanceSessions`,
  Slack's redaction wrapper, Telegram's no-op `showThoughts`, unused
  wizard/readiness/runtime helpers, and legacy memory distillation,
  entity-extraction, vector-index, and recall-factory surfaces.
- The deprecated `recipes` command, `--recipe` init/validate alias, and CLI
  `--fallback-models <csv>` flag remain supported in 0.11.4 and are scheduled
  for removal in v2.0.0. JSON `runtime.fallbackModels`, the matching environment
  input, and legacy tool-policy aliases are not scheduled for removal.
- All 21 catalog-publishable packages move together to 0.11.4. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.3 — Configurable Pi provider transport (2026-07-16)

### Added

- Adds a typed Pi-native transport preference with `auto`, `sse`, `websocket`,
  and `websocket-cached` modes through `providers.piNative.transport`,
  `MONO_AGENT_PI_TRANSPORT`, and the programmatic `piTransport` run option.
- Reports the normalized requested mode as
  `diagnostics.pi_transport_requested` on every Pi result path.

### Reliability

- Keeps an explicitly configured host transport authoritative over
  request-scoped runtime extensions while allowing an extension to choose the
  transport when the host leaves it unset.
- Preserves Pi's provider-specific compatibility and fallback behavior by
  defaulting to `auto`; providers without multiple transports ignore the
  preference.

### Compatibility

- Existing configurations require no changes. Set the new field only when a
  provider supports or requires an explicit transport.
- All 21 catalog-publishable packages move together to 0.11.3. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.2 — Reliable native-notify continuations (2026-07-15)

### Fixed

- Preserves the logical cron or webhook conversation for durable history while
  binding continuation follow-ups to the host-resolved physical notification
  destination.
- Applies webhook notification precedence consistently: configured destination,
  deliverable request conversation, then a uniquely inferred fallback.
- Keeps physical reply destinations host-only and out of model-visible prompts.

### Compatibility

- No configuration changes are required. Existing explicit notification
  destinations continue to take precedence.
- All 21 catalog-publishable packages move together to 0.11.2. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.1 — Release provenance and continuation documentation (2026-07-15)

### Fixed

- Reconciles the repository release history with the already-published 0.10.0
  and 0.11.0 package sets, preserving their original commits and tags.
- Clarifies that interactive continuation delivery synthesizes from the
  immutable origin snapshot prepared and bound by the originating run, rather
  than reconstructing context from mutable latest history.

### Compatibility

- Runtime behavior is unchanged from 0.11.0; this patch release carries the
  documentation correction and a complete, traceable lockstep release surface.
- All 21 catalog-publishable packages move together to 0.11.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.0 — Durable conversation and continuation context (2026-07-14)

### Highlights

- Configured agents now keep the latest 64 messages for each exact conversation
  id in an owner-only, disk-backed history store. The bound is independent of
  `runtime.maxTurns`, and cold processes recover the history without requiring
  provider-session resume.
- Interactive continuation claims pin one immutable origin snapshot before the
  origin turn commits. The host closes and drains claim admission, prepares the
  bounded snapshot, finalizes its durable binding, activates the whole origin
  group only after successful commit, and abandons pending claims when the
  origin fails.
- Continuation synthesis consumes the pinned snapshot and preserves an explicit
  prior-day rollover bucket. It no longer depends on mutable latest history
  that can disappear on restart or be rebucketed after midnight.
- Missing, abandoned, legacy, or unreadable/corrupt origin snapshot blobs use
  one fixed zero-model response instead of an unbounded history-read retry
  loop. An invalid immutable binding HMAC is treated as state tampering and is
  dead-lettered without native delivery. Status exposes the origin-context
  state and the `origin_context_unavailable` completion kind.
- Per-record continuation state moves to v3 with content-addressed owner-only
  snapshot blobs, a 256 MiB aggregate blob quota, digest/HMAC binding,
  crash-recoverable group activation, stricter filesystem identity checks, and
  an old-reader rollback guard.
- Durable Pi resume is now coordinated by the canonical history record. Before
  a provider can mutate JSONL, history fsyncs a separate bounded dirty fence
  under a cross-process conversation lock without changing or pruning
  canonical history. A successful turn fsyncs the provider file and directory,
  atomically commits history with the clean epoch and transcript revision, then
  clears the fence. Processes compare that revision with their warm handle and
  cold-reopen every unconfirmed handle—even after a harness reload with an
  empty local map—so serialized A/B/A writers cannot branch from outdated
  process memory. Missing, legacy, fenced, host-only-appended, or
  unsynchronized state rotates a random provider epoch.
- Provider sessions are explicitly invalidated when any pre-history commit
  stage fails. Durable Pi invalidation waits for JSONL deletion and parent
  directory fsync, propagates cleanup failures, and blocks cold reopen while
  cleanup is in flight. History rotation and retention also retire every exact
  cold/live provider id before it becomes unreachable; dirty fences double as
  crash-recovery retirement journals, while a fence whose canonical revision
  proves the turn committed is cleared without deleting its valid transcript.

### Compatibility

- The configured app's default history changes from a process-local 12-message
  (or `2 * maxTurns`) window to a restart-durable 64-message window. Programs
  that inject `historyStore` retain their custom behavior. Default files live
  in the owner-only `history/` directory next to the configured artifact
  directory; each serialized message is capped at 64 KiB.
- The default history store is bounded across conversations as well: 256 MiB,
  10,000 conversations, and 365 days of inactivity. It stages and fsyncs a
  completed turn before the semantic commit, never evicts committed history on
  prepare/abort, and independently caps all live unpublished stages at 256 MiB
  by default (`maxStagedBytes` can tune the programmatic store). Dead or
  markerless stages are reclaimed immediately, including after an abort-cleanup
  failure. It prunes oldest inactive files only after publication and uses
  an owner-only fixed 16-shard cross-process lock table so separate
  channel/worker processes cannot lose same-conversation or root-retention
  updates or create unbounded lock files. Legacy per-conversation SQLite locks
  are honored without unlinking or creating new ones. Failed fresh turns leave
  a bounded crash fence rather than a counted history record, so they cannot
  evict successful conversations; inactive fences carry the exact provider id
  needed for fail-closed reclamation.
- Programmatic custom history stores that do not implement
  `beginProviderSessionTurn` and advertise fail-closed provider-session
  retirement keep ordinary process-local warm sessions, and the harness
  deliberately withholds `piSessionsRoot`: crash-safe durable provider resume
  requires both the history-owned epoch transaction and exact-id transcript
  retirement. Ordinary host-only history appends retire and rotate that epoch
  before a later model turn.
- Interactive origin snapshots retain at most 64 messages, 64 KiB of content
  per message, and 256 KiB total. If the completed origin turn cannot fit, the
  origin request fails before success is committed; older whole turns are
  evicted first under ordinary size pressure.
- Opening an existing v1/v2 continuation store migrates it idempotently and
  installs a guard that makes 0.10 and older runtimes fail closed. Do not remove
  the guard or point an older runtime at upgraded state; restore the complete
  pre-upgrade state directory for a runtime rollback.
- Legacy interactive records that lack an immutable snapshot cannot recreate
  past context retroactively. They remain idempotently recoverable and deliver
  the deterministic zero-model fallback.
- All 21 catalog-publishable packages move together to 0.11.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.10.0 — Durable A2A lifecycle joins (2026-07-14)

### Highlights

- A2A consumers can now admit a logical dispatch with a mandatory stable
  `idempotencyKey` and receive a lifecycle handle containing the current
  authoritative projection, an independently abortable terminal observer, and
  an explicit cancellation operation.
- Terminal observation rejoins the original provider admission with the same
  canonical request. Stopping or timing out an observer does not cancel remote
  work, while explicit cancellation remains a separate, auditable authority.
- Terminal outcomes are discriminated as completed, failed, canceled,
  rejected, authentication-required, or input-required and retain the final
  response for bounded orchestration decisions.
- The top-level `dispatchA2AMessage` helper and exported lifecycle types make
  restart-safe broker reconciliation available without exposing provider
  internals.

### Compatibility

- Existing `sendA2AMessage`, streaming, and responder APIs are unchanged.
  Durable lifecycle callers should use `dispatchA2AMessage`; its
  `idempotencyKey` is required and is never generated implicitly.
- Observation `signal` and `timeoutMs` values govern only the local join. They
  never imply remote cancellation; call `cancel()` explicitly when cancellation
  is intended.
- All 21 catalog-publishable packages move together to 0.10.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.
- The 0.9.2 source preparation was not published to npm. Its reliability and
  maintenance changes, documented in the next section, ship publicly as part
  of 0.10.0.

## 0.9.2 — Reliable context, polling, provenance, and memory maintenance (2026-07-14)

### Highlights

- `ReadSkill` now loads a selected skill completely instead of silently
  truncating larger instruction files at the former 64 KiB boundary, while
  retaining the existing path and selection guards.
- Telegram long polling tolerates sustained transient network failures through
  a 90-second retry window. grammY's internal retry logger is disabled so raw
  Bot API URLs and credentials cannot bypass the framework's redaction layer.
- Runtime dependency provenance ignores only mutable
  `node_modules/.vite/vitest` result caches. Sibling `.vite` content, JavaScript,
  native addons, modes, and safe symlink targets remain attested.
- Operators can prepare a sealed, content-free explicit-ID memory-forget plan,
  apply it only while the agent is stopped, and restore from a full owner-only
  backup. Stale plans, unsafe paths, drift, tampering, and interrupted root
  swaps fail closed or recover automatically.

### Compatibility

- Existing agent configuration remains compatible; the reliability changes are
  active without new configuration.
- Memory forget is intentionally an offline maintenance operation. Stop the
  configured agent before apply or restore, and retain the generated backup
  until post-cleanup strict audit and live verification are complete.
- All 21 catalog-publishable packages move together to 0.9.2. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.9.1 — Durable A2A dispatch admission (2026-07-14)

### Highlights

- A2A callers can attach a versioned `idempotencyKey` metadata extension after
  verifying that the remote Agent Card advertises durable support. Unsupported
  peers fail before a task is submitted.
- Providers fsync a payload-bound admission before invoking the responder.
  Same-process concurrent duplicates share one execution; a concurrent provider
  process loses the exclusive admission and fails closed as
  `idempotency_in_doubt`. Retained terminal tasks replay, and a changed request
  under the same key fails with a typed conflict.
- Immediate and blocking callers share the same admitted task while retaining
  their own response projection and history length. The provider persists an
  immediate acceptance and monitors it to a terminal task without treating
  response preferences as different work.
- A provider restart with an active receipt fails closed as
  `idempotency_in_doubt`; it never guesses that model work is safe to repeat.
  Expired results compact to permanent conflict tombstones, and bounded store
  capacity fails closed instead of evicting a live or previously bound key.
- Owner-only state, strict persisted-result validation, file and directory
  fsync, cross-process exclusive admission, and permanent key ownership close
  crash, expiry, and concurrent-provider replay races.

### Compatibility

- Durable A2A idempotency is opt-in. A config-loaded provider advertises it only
  when plugin `config.provider.idempotency.namespace` (or the equivalent
  full-root/env setting) is an explicit stable logical principal; `stateDir`,
  retention, and maximum records remain configurable.
- Direct consumers may pass `idempotencyKey`. Programmatic responder bridges
  may supply `idempotencyKeyForRequest`; neither path invents a random identity.
- The contract is at-most-once and fail-closed across ambiguous failure, not a
  claim of exactly-once execution across an unknowable process/network crash.
- All 21 catalog-publishable packages move together to 0.9.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.9.0 — Durable origin-bound continuations (2026-07-14)

### Highlights

- Long-running tool work can claim a host-owned continuation before dispatch,
  return the interactive turn promptly, and later bind the durable result to the
  exact originating conversation without exposing channel routes or credentials
  to the model, A2A payloads, or result contracts.
- Continuation synthesis is isolated, tool-disabled, and at most once. Its
  output is persisted before delivery, so restart-safe native-channel retries
  reuse the same synthesis instead of running the model again.
- Reply, actionable-notification, silent, and capture modes support interactive
  and detached work. Status, retry, cancel, and delivery-unknown resolution give
  operators a durable control surface for recovery and auditing.
- Configured loopback MCP servers receive short-lived opaque claim capabilities;
  spoofed or remote claim transports are rejected. Pi tool failures now retain
  their error status through runtime bridging and telemetry.
- Bounded concurrent workers, active-record admission limits, operation
  timeouts, and keyset-paginated operator reads prevent one hung provider or
  abusive claim origin from stalling or exhausting the continuation service.
- Multi-message native delivery requires every chunk to succeed. Partial sends
  become delivery-unknown, and operator-confirmed sends use a history-only
  commit so reconciliation can never repost the answer.

### Compatibility

- All 21 catalog-publishable packages move together to 0.9.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.
- Durable continuations are opt-in. Existing agents keep their current turn and
  delivery behavior until a continuation service and eligible MCP servers or
  detached routes are explicitly configured.

### Upgrade

- Upgrading managed SRT from 0.8 or earlier is an offline transition. Stop
  every old background and foreground mono-agent process for the OS user, and
  wait for old `mono-agent init` and `mono-agent sandbox setup` commands to
  exit, before installing 0.9. Keep them stopped through the first 0.9 sandbox
  setup. Older versions do not honor 0.9's permanent OS-level install guard,
  so mixed-version setup or repair is unsafe.

## 0.8.0 — Durable operations and direct access (2026-07-13)

This is the first public npm release containing the Product v1 source line. The
0.7.0 source tag remains an immutable milestone but was not published to npm.

### Highlights

- Completed turns are durably admitted before success is reported. BuJo capture
  now has fsynced intake, restart-safe retries and dead letters, strict output
  contracts, exact replay adoption, and health-visible reconciliation.
- Strict memory audit now verifies managed generations, canonical graph and
  SQLite parity, vector coverage, intake/outbox state, stale runtime artifacts,
  and legacy timestamp adoption without silently accepting partial state.
- `/cancel` emits one terminal acknowledgement across Telegram, Slack, and
  WhatsApp, stays out of model/history/memory processing, and records user
  cancellation without degrading fleet health.
- Session Web and the OpenAI-compatible API support authenticated direct LAN and
  Tailscale access. Tailscale Serve remains optional for HTTPS and full PWA
  installation behavior.
- Blocking asks retain their history; completed prior runs can be inspected
  through a conversation-scoped, read-only tool; request-scoped MCP delivery no
  longer leaks tools between concurrent turns.
- Per-turn effort keywords, native voice transcription, safer Telegram logging,
  cron de-duplication, and loaded-build provenance improve day-to-day operation.
- Lockstep publication now binds immutable tarballs to a clean exact tag and
  verified build provenance, stages and integrity-checks the complete package
  set before promotion, and smoke-tests all three public CLI entry paths.

### Compatibility

- Node.js **22.19.0 or newer** is required. This is a new requirement for public
  npm users upgrading from 0.6.2; it was already the floor for the unpublished
  0.7.0 source milestone.
- All 21 catalog-publishable packages move together to 0.8.0. Do not mix
  `@mono-agent/*` or `create-mono-agent` versions.
- BuJo entity writes now replace the complete canonical record. Integrations
  that call the low-level `upsertEntity` API must provide every field they want
  retained instead of relying on omitted fields from an older record.
- `AgentHarnessResponse.metadata.summary` no longer exposes `systemPrompt` and
  is typed as `ExternalRunSummary`. Private recorder artifacts still retain the
  prompt for local inspection, but channel/programmatic callers must not depend
  on receiving it from the harness response.

### Upgrade

Users on 0.6.2 can upgrade directly to 0.8.0; no public 0.7.0 package is
required. Follow the
[product-v1 cutover checklist](./docs/memory/validation-and-cli.md#enable-v1-on-an-existing-agent)
and run `mono-agent memory audit --strict --json` after upgrading a built-in
memory agent.

## 0.7.0 — Product v1 (2026-07-11)

Product v1 is the 0.7.0 source/tag milestone; it is a product milestone, not an
npm major-version claim. This exact version was not published to npm; its
content is included in the 0.8.0 public release.

### Highlights

- A new agent remains config-first: scaffold one folder, then continue in the
  local configuration conversation with the bundled `mono-agent-configure` and
  `mono-agent-memory` skills.
- `MemoryRecall` is enabled by default. Lite, Journal, and BuJo now have strict
  tiers, bounded/background work, metadata-only health, measurable graph recall,
  and side-by-side rebuild/rollback generations with integrity-qualified immutable
  snapshots.
- Supermemory is an external plugin (`@mono-agent/memory-supermemory`) rather
  than bundled core behavior.
- Active conversation history wins over durable memory for questions about the
  immediately preceding message.
- App-owned Slack, Telegram, file/button, and blocking `AskUser` tools work under
  enforced managed-SRT network policies without serializing proxy credentials or
  widening destination allowlists.

### Compatibility

- The minimum supported Node.js version is now **22.19.0** (previously Node.js 20). This aligns every published package with the Pi runtime already shipped in the `@mono-agent/agent-app` dependency graph. Upgrade Node before installing or updating mono-agent; Node 20 is no longer supported.

### Upgrade

Follow the [product-v1 cutover checklist](./docs/memory/validation-and-cli.md#enable-v1-on-an-existing-agent), including the built-in-memory versus Supermemory branch.

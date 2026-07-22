---
title: "Artifacts, latency & trace registry"
description: "Understand JSONL recorder checkpoints, bounded reads, stale-run reconciliation, latency events, retention, and trace-source discovery."
sidebar:
  order: 1
---

mono-agent is local-first about observability: every run gets a JSONL event artifact and a summary in a folder on disk, and the host publishes a small heartbeat manifest so the CLI can discover running agents. At `start()`, the recorder performs separate atomic replacements for an empty events file and a `running` summary. It redacts non-numeric values under sensitive-looking object keys, scans retained free text for a closed set of high-confidence credential shapes, and buffers later events with a 4,096-byte default cap per string. It schedules incremental `running` snapshots and writes a final snapshot at `finish()`/`fail()`. Every boundary replaces the events file first and summary second. These temp-file-and-rename writes provide no append, fsync, power-loss durability, or cross-file transaction guarantee. The artifacts are the best-effort on-disk prefix after a successful recorder boundary; the [Phoenix exporter](/observability/phoenix-and-backfill/) is an optional, additive layer on top.

This page covers where artifacts land, the latency-attribution events inside them, and the trace-source registry that `mono-agent status` reads.

## Run artifacts (JSONL)

Each agent run writes two files into `artifacts.dir`:

- `run-<id>.events.jsonl` — the latest successfully replaced snapshot of sensitive-key-redacted, credential-scanned, bounded events that reached the recorder's in-memory buffer, one event per line (assistant deltas, tool calls/results, timing, usage/cost).
- `run-<id>.summary.json` — a private local roll-up of the run (final `status`, aggregate usage/cost, model, and the compiled `systemPrompt` when captured). See [Run status](#run-status-and-stale-run-reconciliation) for the status values. Routed runs preserve normalized `failoverHistory` (model, failure, subkind, and request id when available). The companion events JSONL records bounded `provider_route_safety` events with each uniform or provider-native contract/status. Credentials and private resolver options are never copied into either artifact.

Memory-maintenance runs (`mem-*`, used by BuJo capture and rituals) write the same two-file shape under `artifacts.dir/memory/`. Keeping them in a separate namespace lets operator surfaces default to human-facing agent runs while still allowing explicit memory export, audit, and metrics flows.

Artifacts are written for every run regardless of whether any exporter is configured. Non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes. Long strings are capped. The closed scan is defense in depth, not a general secret or privacy scrubber. Summaries intentionally retain private operator context such as the compiled system prompt; keep the artifact directory access-controlled and do not expose it as an application response. Public `AgentHarnessResponse.metadata.summary` is typed as `ExternalRunSummary` and excludes `systemPrompt` on every path. The webhook adapter repeats that sanitization for sync, async, status, and callback destinations, including custom responders. Separately from JSONL recording, the tool-bloat guard attempts to save each oversized tool-result block under `tool-output/`; only paths returned by a successful persistence callback are retained, and failures leave the compact truncation summary without the omitted bytes (coverage: `auto`).

:::note
Current matcher limitations remain follow-up work. Key names that put a space, dot, slash, or colon between `private`/`api` and `key` are not matched (for example, `private key`, `api.key`, `private/key`, or `api:key`). Because matching is substring-based, string values under benign keys such as `credentialType`, `bearerStatus`, and `privateKeyboard` are conservatively redacted. These classifications document the current behavior; this issue does not change the production matcher.
:::

The recorder writes the initial `running` summary immediately and then schedules
a best-effort incremental snapshot after 25 new events or five seconds from the
first uncheckpointed event, whichever comes first. `onEvent` does not await
filesystem I/O: concurrent triggers coalesce behind one serialized writer, and
an incremental write failure cannot fail the run. Summary and event contents
are captured from the same in-memory point, and terminal finalization is queued
after every already-scheduled checkpoint, so a late `running` write cannot
replace `succeeded`, `failed`, or `cancelled`.

This is best-effort, bounded crash-prefix recovery rather than whole-trail
durability. With a healthy local filesystem, the scheduler leaves fewer than 25
newly accepted events—or roughly five seconds of sparse events—outside a
scheduled snapshot; it cannot bound filesystem completion time or failure. The
events file is atomically replaced first and the summary file second. Those two
renames are not a transaction, so a death between them may leave a newer events
prefix beside the prior summary. A death before the first checkpoint, during a
write, or after a filesystem failure can still lose the unsaved tail.

```json
{
  "artifacts": {
    "dir": "./.mono-agent/artifacts",
    "retention": {
      "maxAgeDays": 365,
      "maxCount": 50000,
      "dryRun": false
    },
    "memoryRetention": {
      "maxAgeDays": 7,
      "maxCount": 5000,
      "dryRun": false
    }
  }
}
```

| Key | Default | Env var | Coverage |
| --- | --- | --- | --- |
| `artifacts.dir` | `./.mono-agent/artifacts` | `MONO_AGENT_ARTIFACT_DIR` | config |
| `artifacts.retention.maxAgeDays` | `365` | `MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS` | config |
| `artifacts.retention.maxCount` | `50000` | `MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT` | config |
| `artifacts.retention.dryRun` | `false` | `MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN` | config |
| `artifacts.memoryRetention.maxAgeDays` | `7` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS` | config |
| `artifacts.memoryRetention.maxCount` | `5000` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT` | config |
| `artifacts.memoryRetention.dryRun` | `artifacts.retention.dryRun` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN` | config |

These files are exactly what the [backfill command](/observability/phoenix-and-backfill/) replays into Phoenix after the fact — `run-*.summary.json` plus `run-*.events.jsonl` are read back and exported with their original historical timestamps. The default backfill/audit/metrics/operator views read agent runs only; pass `--include-memory` where supported to add memory-maintenance runs. Explicit `--run mem-*` backfills can still reach memory artifacts, including legacy top-level `mem-*` files from older mixed directories. The `error` / `failoverHistory` fields are written into the live record *and* re-canonicalized by the recorded-runs list reader, so they surface for both freshly-failed runs and re-read artifacts (artifacts written before this field was added carry no source data to recover).

The host applies artifact retention once at startup, after stale-run reconciliation, and then on a periodic in-app sweep. Agent runs use `artifacts.retention`; memory runs use `artifacts.memoryRetention`, defaulting to a shorter 7-day / 5,000-run window. Retention deletes only terminal run summaries and their matching event files; summaries still marked `running` are never deleted by the retention pass. Set `dryRun: true` to log which runs would be pruned without removing files; memory retention inherits the agent dry-run setting when its own `dryRun` is unset.

### Run status and stale-run reconciliation

A run summary's `status` is one of:

| Status | Meaning |
| --- | --- |
| `running` | The run is in flight (not yet settled). |
| `succeeded` | The turn completed normally. |
| `failed` | The turn ended with an error. |
| `cancelled` | The turn was aborted by a caller (e.g. a newer follow-up cancelled it). |
| `interrupted` | The run never settled on its own — the process died mid-run, or a watchdog (e.g. the [cron run watchdog](/channels/cron/#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve)) aborted a wedged run. |

A crashed process can leave the most recent incrementally checkpointed summary at `running`. To self-heal that, the host runs `reconcileStaleRunArtifacts()` **once at startup**: it scans the artifacts directory and rewrites any summary left at `running` by a *previous* process to `interrupted` (failure kind `process_death`) while preserving the checkpointed event trail. It is fire-and-forget — best-effort, runs in the background, and never gates readiness — so a large artifacts directory can never delay start. In the [Phoenix export](/observability/phoenix-and-backfill/), `interrupted` maps to an ERROR span, alongside `failed` and `cancelled`.

Reconciliation repairs status only and can report only data that reached a recorder write boundary. It can preserve the last completed checkpointed prefix; a death before the first incremental checkpoint or after a failed write can still reconcile as `process_death` with `eventCount: 0` even though events occurred. A death between the two file renames can also leave a newer events file beside the prior summary. The live broadcast may show connected TUI/web clients a newer best-effort tail, but it is not recovery for data absent from disk.

Failure kinds are an open string set because provider/runtime adapters can surface new values. The display taxonomy currently explains the common operator-facing kinds including `context_limit`, `usage_limit`, `process_death`, `cancelled` and its cancellation variants, `provider_unavailable`, `provider_unavailable_exhausted`, `runtime_error`, `session_not_found`, and `session_busy`; unknown values stay visible and get a generic artifact/log inspection hint. `context_limit` specifically means request input still exceeded the selected model's usable window after bridge recovery; unlike quota/output/max-turn `usage_limit`, it is eligible for configured route fallback.

For a read-only inventory, run `mono-agent runs audit`. It scans every `*.summary.json` file in the artifact directory, reports malformed summaries, status and failure-kind histograms, unrecognized values, stale `running` summaries, and failure-kind rates. Unlike startup reconciliation, the audit never rewrites `running` summaries; it only flags what the startup reconciler would consider stale.

```bash
mono-agent runs audit --consumer /path/to/agent --json
mono-agent runs audit --artifacts /path/to/.mono-agent/artifacts --stale-after-ms 30000
```

:::tip
The artifacts directory is the on-disk record after a successful recorder boundary; it is not a crash-safe journal of in-flight events. Keep it out of version control (it grows per run) but back it up if you care about historical runs you might want to backfill or audit later.
:::

## Agent-facing prior-run evidence (`RunHistory`)

`RunHistory` is an app-owned, read-only, request-scoped MCP tool that lets the agent recover exact evidence from its own recorded runs without shelling into `artifacts.dir`. It has no separate config key: allow-all exposes it automatically on MCP-capable routes, while a restrictive tool policy must name `RunHistory` explicitly. See [MCP servers](/tools/mcp/#runhistory-prior-run-evidence) and [Tool policy](/tools/policy/#runhistory).

The tool exposes compact shorthand calls (explicit `list`, `search`, and
`inspect` actions remain compatible):

- `{}` lists completed prior runs in the logical conversation (default 5,
  maximum 10).
- `{ "query": "topic terms" }` searches sanitized trigger/user input and run
  metadata only. Search reads summaries once and never opens event JSONL.
- `{ "runId": "..." }` returns a compact overview with metadata, trigger,
  final visible output, warnings/failures, and per-tool call/error counts.
- `{ "runId": "...", "cursor": "..." }` returns the next chronological
  timeline page, bounded to 10 entries and about 16 KiB. `run_id` is accepted as
  an alias.

List/search pagination and timeline inspection return an opaque `nextCursor`
when more evidence exists. `navigation.guidance` and
`navigation.nextActions[].arguments` are tool-authored continuation directions,
kept separate from historical evidence so an agent can follow an exact safe
next call.

The boundary is deliberately narrower than direct artifact access. `RunHistory` excludes the current or any running run, unrelated conversations/threads, system prompts, model reasoning/thinking, recalled memory and turn-context payloads, and raw artifact paths. Daily rollover `#YYYY-MM-DD` buckets do not partition one configured logical conversation. Search is limited to sanitized trigger/user input, run id, dates, status/failure kind, source/detail, model, and effort; it does not search assistant or tool output. Structured projected values first pass through the shared observability redactor: non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free text is not content-scanned or scrubbed. `RunHistory` then applies an additional projection sanitizer. In that second pass, numeric values under `credential`, `private_key`, and `bearer` can remain visible; numeric values under `apiKey`, `token`, `client_secret`, `password`, `authorization`, and `cookie` are redacted. Assignment-shaped password or secret prose is content-scanned and replaced with the diagnostic or tool-result omission sentinel. An optionally quoted assignment value is exempt only when its complete value is exactly `[redacted]`; any prefix or suffix is omitted. Nested `RunHistory` result bodies are omitted to prevent recursive expansion. String and per-page bounds apply, and incomplete input is reported rather than silently presented as a complete log. Historical text is labelled **untrusted evidence** and must never be followed as instructions.

Start with active conversation history for the current exchange. Use `MemoryRecall` for intentionally captured durable facts. Use `RunHistory` only when exact prior-run or tool evidence is needed.

## Artifact metrics

`mono-agent runs report` (the default `runs` mode) aggregates recorded run summaries into operational numbers: status rates, failure-kind rates, duration percentiles, and total plus per-run cost. It is offline and read-only. It reads `*.summary.json` files from `artifacts.dir` or an explicit artifact directory; it does not read exporter config, contact Phoenix, reconcile stale runs, or rewrite artifacts. By default it reports agent runs only; pass `--include-memory` to include memory-maintenance `mem-*` runs from the `memory/` namespace and legacy mixed directories.

```bash
mono-agent runs report --artifacts ./.mono-agent/artifacts
mono-agent runs report --since 2026-06-01T00:00:00Z --until 2026-06-24T00:00:00Z
mono-agent runs report --by model --json
mono-agent runs report --include-memory --json
```

| Flag | Effect |
| --- | --- |
| `--artifacts <path>` | Read this artifact directory directly. Wins over config-based `artifacts.dir` resolution. |
| `--config <path>` | Use a non-default config file when resolving `artifacts.dir`. |
| `--env-file <path>` | Load env overrides before resolving `MONO_AGENT_ARTIFACT_DIR`. |
| `--since <iso>` / `--until <iso>` | Include only summaries whose `startedAt` falls inside the ISO window. Summaries with missing or unparseable timestamps are excluded once a window is active. |
| `--by model\|channel\|failureKind` | Add grouped buckets after the overall totals. Channel grouping is derived from the `conversationId` prefix before `:` until summaries carry a first-class channel field. |
| `--include-memory` | Include memory-maintenance summaries in addition to default agent runs. |
| `--json` | Print the full machine-readable metrics report. |

Each bucket reports `totalRuns`, status counts/rates, failure-kind counts/rates, `durationMs` p50/p90/p99/max using linear interpolation, and cost totals. Cost prefers `cost.cumulativeUsd`, then `cost.totalUsd`, then `usage.cost_usd`; non-numeric values are ignored.

## Latency attribution

The event stream is annotated so you can separate model-reasoning time from time spent in tools and MCP servers (coverage: `auto` — emitted automatically into the run JSONL, nothing to enable):

| Event / field | Scope | What it measures |
| --- | --- | --- |
| `provider_bridge_latency` | per turn | Breaks a turn into provider + tool + IO time vs. harness overhead, so you can see how much wall-clock the bridge itself added. |
| `tool_timing` (`execution_ms`) | per tool call | How long each tool's execution took. |
| `mcp_call_duration_ms` | per MCP tool result | Duration of the underlying MCP call, carried on the result. |

Because these live in the JSONL, you get the attribution even with no exporter configured. When the Phoenix exporter is on, a tool's `tool_use` + `tool_timing` + `tool_result` events merge by `tool_use_id` into a single TOOL span — see [Phoenix export & backfill](/observability/phoenix-and-backfill/).

## Trace-source registry

The host periodically writes a heartbeat manifest describing this agent into `traceability.registryDir`. `mono-agent status` reads that directory to list known trace sources and mark any whose last heartbeat is older than `staleAfterMs` as stale. This is how the CLI discovers running agents on the machine without a central service.

When `registryDir` is a config-local override (as `mono-agent init` scaffolds), the same manifest is ALSO best-effort mirrored into the global `~/.mono-agent/trace-sources` registry (`traceability.globalDiscovery`, default `true`), so `mono-agent tui`/`status` run from anywhere on the machine still finds this agent. See [Terminal UI](/observability/tui/) for how discovery merges the two registries.

```json
{
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000,
    "globalDiscovery": true
  }
}
```

| Key | Default | Env var | Notes |
| --- | --- | --- | --- |
| `traceability.registryDir` | `./.mono-agent/trace-sources` | `MONO_AGENT_TRACE_REGISTRY_DIR` | Directory of heartbeat manifests. |
| `traceability.sourceId` | `my-agent` | `MONO_AGENT_TRACE_SOURCE_ID` | Stable id for this agent; keys its manifest. |
| `traceability.sourceLabel` | `My Agent` | `MONO_AGENT_TRACE_SOURCE_LABEL` | Human-friendly name shown by `status` (and used as the default Phoenix project name). |
| `traceability.heartbeatMs` | `10000` | `MONO_AGENT_TRACE_HEARTBEAT_MS` | How often the manifest is refreshed. |
| `traceability.staleAfterMs` | `30000` | `MONO_AGENT_TRACE_STALE_AFTER_MS` | Age after which `status` marks a source stale. |
| `traceability.globalDiscovery` | `true` | `MONO_AGENT_TRACE_GLOBAL_DISCOVERY` | When `registryDir` differs from the global default, also mirror this agent's manifest there. Set `false` to keep registration local-only. |

### Content-free memory health

An `agent-runtime.trace-source.v1` manifest may carry a typed `memoryHealth` snapshot alongside
process health. The host computes it at trace registration, forces one post-lifecycle refresh after
the store starts or reloads, then caches ordinary memory-state/trace refreshes and uses a
completion-based steady-state interval of at least 30 seconds; a fast process-heartbeat setting does
not turn into a fast full memory audit. It publishes the same value to the primary registry and any
enabled best-effort global mirror. Memory health is independent of process health: a source can be `running` while its
memory is `degraded`, or have memory `in_progress` while durable work drains normally.

The nested contract is discriminated by `backend`. Built-in `bujo` requires `mode`
(`lite`, `journal`, or `bujo`), its core status, canonically ordered closed issues, and optional
whitelisted counts (`pending`, `due`, `dead`, `outbox`, `temporary`, `memories`, `vectors`, and
`missingVectors`). `supermemory` carries only `unknown`; `none` carries `not_configured` or
`unknown`; neither remote/absent variant carries mode, issues, or counts. Registry readers normalize
this as untrusted input: unknown fields are discarded, while a semantically contradictory newest
snapshot becomes a timestamp-preserving `unknown` variant rather than disappearing and leaving an
older green value authoritative. A duplicate local/global source keeps the independently freshest
`memoryHealth.checkedAt` rather than coupling it to whichever process manifest won the ordinary
source merge.

The snapshot is safe for discovery surfaces: it contains no paths, filenames, record/run ids,
memory or model text, payloads, or raw provider/native errors. `none/not_configured`,
`none/unknown`, and `supermemory/unknown` omit `mode`; the latter is unknown because a local trace registry cannot
assert health of the remote index. For the exact strict CLI schema and exit contract, see
[Memory validation & CLI](/memory/validation-and-cli/#strict-provider-free-health-gate).

Keep `staleAfterMs` comfortably larger than `heartbeatMs` (the defaults give a 3× margin) so a single missed write does not flap a healthy agent into the stale state. Registries also self-prune: manifests whose heartbeat is older than 7 days AND whose process is no longer running are deleted automatically the next time an agent starts or `mono-agent tui` runs.

:::note
`sourceLabel` doubles as the default Phoenix project name when no `projectName` is set on the exporter, so pick a label that reads well in a trace UI as well as in the CLI.
:::

## How `start` and `status` use this

`mono-agent start` prints the active traceability source — Phoenix when an `observability.exporters` Phoenix entry is configured, otherwise the local JSONL artifacts — and `mono-agent status` reads the registry to report each known source as live or stale. See the [CLI reference](/observability/cli-reference/) for the full command surface, and [Phoenix export & backfill](/observability/phoenix-and-backfill/) for sending these same events to a trace viewer.

The launchd fleet green check does not trust the interactive shell runtime. Generic mode discovers
every matching plist present; a host gate can pass `--expect-labels <csv>` to require an exact
duplicate-free set, so a removed or added fleet plist drives RED. Discovery requires a canonical
filename/`Label` match, control-free `ProgramArguments`, and absolute executable/config paths. Managed
paths and operational values may contain spaces because loaded arguments are compared structurally. It
accepts both a closed legacy direct-Node shape and the exact current hardened `/usr/bin/env -i` producer
shape; the latter may contain only the operational environment allowlist plus its managed-worker marker.
Because the copied CLI lives outside Git, current managed-runtime checks also pass
`--repo <deploy-checkout>` to pin build/SHA provenance to the source tree. A read-only attestation requires
the canonical content-addressed cache path, a valid v4 marker and complete byte-level closure manifest,
semantic equality between source and cached execution closures (including configured plugins), and the
install-time filesystem identities of package entries, links, and every resolution-path directory inside
the private install root; canonical ancestors above it must remain owner-private. The loaded process must
start after the conservative finalized-runtime boundary. It
invokes `/usr/bin/plutil` and `/bin/launchctl` with a closed system environment, then reads each
service's exact Node executable, CLI path, absolute `--config`/`--env-file` arguments, and complete managed
environment for the Node/ABI, build-marker, `validate --json`, `memory audit --strict --json`, and
`metrics --json` probes. Initial and final `launchctl print` reads must match the persisted program,
structured arguments, working directory, origin plist, and PID. The running PID's actual Node executable
device/inode and cwd must also match.
On supported POSIX/macOS hosts, the root build holds an exclusive lock from before clearing the old
marker through package/demo build, required CLI/TUI executable-mode finalization, output sync,
deterministic output-digest calculation, installed
root/workspace dependency-tree calculation, and atomic owner-only marker publication. The dependency
digest covers file bytes, modes, and canonical symlink topology without following links, so rebuilding a
native addon, removing an executable bit, or rewriting installed JavaScript invalidates the proof even
when the lockfile and source SHA are unchanged. Links may resolve only within an attested dependency
root or to an exact workspace package root; arbitrary ignored in-repository referents fail closed.

For every running PID, the check requires the build lock to be absent, the checkout to be clean and
stable across both reads, and the marker's full SHA to match both that checkout and the full
per-instance expected SHA. Marker Node/ABI must match the runtime, its output and dependency digests
must match fresh digests of the current deploy outputs and installed dependency tree, and the process
must have started after build completion. It repeats the marker, digests, and checkout-state probes,
reconverts each selected canonical plist and requires its fingerprint to remain unchanged, repeats the
managed-runtime and loaded-launch-definition attestations, then performs a global final launchd PID/state
pass after every expensive row completes. This closes build, dependency/cache mutation,
persisted-versus-loaded launch-contract replacement, checkout, and early-row restart races.
Every expected fleet service must be running; a clean prior exit is not green.

Probe children retain only non-secret, launchd-safe operational environment values; shell-only
`MONO_AGENT_*`, provider credentials, `NODE_OPTIONS`, and proxy overrides cannot make the check
pass. Probes have hard timeouts, marker failures collapse to closed diagnostics, and closed memory
status/issue/count relationships are validated before a fleet verdict. The current fleet contract
is Node `24.15.0` and modules ABI `137`; running those probes with ambient Node, config, credentials,
or a checkout HEAD alone cannot prove that the deployed process loaded the current native build.
Reports expose only closed states and counts: they never include marker bytes, absolute paths,
process arguments, working directories, or other raw probe output. A multi-checkout warning states
only how many deploy checkouts were found. The marker is POSIX/macOS deploy proof; builds on
unsupported hosts complete normally without publishing it. A stale lock may be removed only after
an operator confirms that no root build remains active.

To wire any of this up from code rather than config (custom hosts, embedding the runtime), see [Programmatic usage](/programmatic/).

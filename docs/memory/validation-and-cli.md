---
title: "Validation & CLI maintenance"
description: "Validate memory configuration and use the config-aware mono-agent memory commands for inspection, health, recovery, rebuild, rollback, and explicit forget."
sidebar:
  order: 5
---

This page covers how `mono-agent validate` verifies memory configuration and liveness and how `mono-agent memory` audits and safely repairs the configured backend from an agent folder. It also explains the `memory.llm` provider choices (`ollama` vs `agent-host`) that the validator inspects. The standalone `memory-bujo` binary that used to run out-of-band maintenance against a memory root has been [removed](#memory-bujo-cli--removed) — every maintenance operation now runs config-aware through `mono-agent memory`.

The memory subsystem **never silently downshifts**: invalid tier prerequisites and managed index-identity problems fail validation, while operational provider liveness problems appear explicitly as `waiting` in the Memory section. Run `mono-agent validate` before cutover, after changing the tier/provider/model/dimension, and after loading or pulling any model.

## `mono-agent memory` — config-aware preview

`mono-agent memory` is the operator preview for the memory configured in the current agent folder. It loads the same `mono-agent.config.json` and `.env` resolution path as the app, so it sees the active memory mode, backend, root path, embeddings provider, and Supermemory settings without a separate root argument.

This operator surface remains available when `memory.recallTool.enabled` is `false`. That setting removes the live `MemoryRecall` tool from the agent; it does not disable explicit operator inspection or maintenance. Preview and live recall share the same backend, Supermemory-container, embeddings, and credential resolution, with bypassing the live-tool gate as the only preview-specific behavior.

Coverage: cli.

```bash
# High-level memory configuration and local-store counts
mono-agent memory stats

# Today's or a specific daily markdown file
mono-agent memory today
mono-agent memory show 2026-07-06

# Recall through the configured backend
mono-agent memory search "release checklist"

# Highest-salience local memories
mono-agent memory top --limit 10

# Detailed local operator telemetry (may include local paths/source locations)
mono-agent memory audit --json

# Closed, content-free health contract for automation/fleet checks
mono-agent memory audit --strict --json

# Inspect durable completed-turn intake without printing its payloads
mono-agent memory inspect --json
mono-agent memory inspect <64-character-id> --json

# With the matching agent stopped: make all or one selected item due
mono-agent memory retry --json
mono-agent memory retry <64-character-id> --json
# Explicitly abandon one item
mono-agent memory resolve <64-character-id> <reason-slug> --json

# Build and atomically activate a fresh index from canonical files
mono-agent memory rebuild --json

# Swap back to the retained prior generation
mono-agent memory rollback --json

# One-time explicit TOFU for a stopped legacy managed or unmanaged BuJo
# index whose replay-owned SQLite state predates the canonical sidecar
mono-agent memory adopt-replay --json

# Explicit, reversible removal of selected BuJo memories
mono-agent memory forget prepare --ids-file ./forget-ids.txt --reason noise_cleanup --plan ./forget-plan.json --json
mono-agent stop
mono-agent memory forget apply --plan ./forget-plan.json --json
# Optional only while no durable post-cleanup change has occurred
mono-agent memory forget restore --backup /path/returned/by/apply --json

# Machine-readable output for scripts
mono-agent memory stats --json
```

If memory is disabled or missing from config, the command exits successfully and says no memory backend is configured. For local BuJo/journal/lite memory, `stats` reports the configured tier, write mode, recall-tool state, memory root and active database paths, daily-file counts, markdown/database sizes, record/status/type counts, latest capture/access timestamps, and top entities. `today` / `show <date>` print daily markdown when present, and `top` ranks local memories by salience.

Plain `audit` is the detailed local operator report: its JSON contains counts, store bytes, exact-duplicate ratio, vector coverage, access concentration, vector backlog, active-generation identity, rebuild policy/source fingerprint, and explicit source-migration accounting. The latter distinguishes indexed items from raw-audit records, unstructured records, missing-identity records (with source locations), recognized legacy-source records (with source locations), and Journal duplicates. It never includes memory text, query text, entity names, queue keys, or source content, but it can include configured filesystem paths and source locations. Use the strict audit below—not plain `audit`—as a closed fleet or monitoring contract.

While the configured store runs, it atomically publishes a coalesced metadata-only snapshot at `.index/runtime.json` (plus a 30-second heartbeat). `audit` uses that snapshot for queue capacity/backlog/high-water/drain/failure/discard counts and embedding/LLM call counts since that store start. It marks a closed, dead-process, invalid, or older-than-90-seconds snapshot as stale. Monetary cost, tokens, and search percentiles remain `null` unless another telemetry surface records them; audit does not guess them from memory content.

`search` uses the same recall path as the `MemoryRecall` tool. When local semantic embeddings are configured but unavailable, it prints a warning and falls back to FTS-only recall instead of pretending semantic search succeeded. For Supermemory-backed agents, `search` queries Supermemory and `stats` reports the known configured container/base URL while marking local SQLite-only counts as unknown.

### Reversible explicit BuJo forget plans

`memory forget` is an operator-selected cleanup path, not an LLM classification pass. Put at most 32 existing memory ids, one per line, in the ids file. `prepare` reads only canonical BuJo sources, rejects missing, duplicate, or already-terminal ids, and creates a new `0600`, single-link JSON plan outside the memory root. The plan contains ids and binding metadata but no memory text. Its root fingerprint, canonical source fingerprint, reason slug, timestamp, and checksum make stale or accidentally edited plans fail closed. The checksum is edit detection inside the trusted same-user operator boundary; it is not authentication against another process running as that same OS user.

Run `apply` only after stopping the configured agent. A package-owned stopped-store coordinator acquires the authoritative memory-writer lease, finishes any prior durable recovery, rechecks the plan and active managed index, and then makes a fully fsynced, verified sibling backup before the first semantic change. A stable sibling transaction record blocks every normal writer until apply or recovery commits. Each selected item uses the ordinary durable migration-forget transaction: its canonical bullet becomes `dropped`, the exact terminal timestamp enters replay authority and SQLite, and a safe managed rebuild refreshes index and graph projections. No chat LLM is called; the configured embeddings provider is used by the bounded durable update and rebuild. JSON and human output contain only metadata, counts, fingerprints, plan/backup paths, and fixed failure codes—never memory text or raw package errors.

If apply fails after the transaction record exists, the coordinator closes the index, restores the complete snapshot, verifies canonical/index parity and its tree fingerprint, and reports whether recovery succeeded. A process death leaves the fsynced transaction and deterministic backup discoverable; normal store startup refuses until a later apply/restore invocation completes recovery. An explicit `restore` prevalidates the snapshot, rechecks the exact post-apply tree at the commit boundary, then atomically renames the current root into retained quarantine and consumes the sibling snapshot as the restored root. It never makes a third full copy. A failed activation rolls the quarantine back; an unverified quarantine is never deleted. Only the exact active SQLite coordination files are checkpointed and removed while the writer lease is held. Every unrelated file—including arbitrary names ending in `-shm` or `-wal`—participates in freshness and blocks overwrite.

The app's startup and hourly artifact-retention sweep keeps the three newest forget backups and expires snapshots after 30 days. It covers root-bound managed siblings such as `.mono-agent/.memory-forget-backup-*` and, for conventional `.mono-agent/memory`, manual `.mono-agent/operator/forget-*` directories. The sweep shares the stopped-store maintenance lease, defers while recovery is pending, never follows symlinks, and inherits `artifacts.memoryRetention.dryRun`. Before deletion it atomically renames each selected directory to another reserved retention name, so an interrupted sweep leaves a claim that the next sweep can discover and finish. Copy any backup that must outlive this rollback window outside those reserved names.

### Strict provider-free health gate

`mono-agent memory audit --strict --json` is the closed, provider-free health contract. It makes no embedding, chat-model, Ollama, LM Studio, OpenAI, or Supermemory request. For the built-in backend it takes a bounded, snapshot-coherent view of managed identity, SQLite integrity and metadata, FTS/vector coverage, canonical source parity (including BuJo's exact replay projection), rollback-source freshness, durable completed-turn intake, capture outbox, temporary artifacts, and the runtime snapshot. SQLite still requires the native modules built for the Node runtime that invokes the command; an unavailable native module reports `unknown` rather than leaking the loader error.

Fresh durable work is `in_progress`, but it cannot remain successful forever after its owner disappears. A due intake item with no active retry, or a published capture intent awaiting replay, becomes `work_stalled` after the same 90-second grace used for runtime staleness. The timestamps and stability digests used for that decision remain private; the public report carries only the stable issue and aggregate counts. A live/fresh Journal write lock is similarly distinguished from a stale or malformed owner without mutating the lock during audit.

The JSON object has exactly these fields (the `mode` field exists only for `backend: "bujo"`):

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1`. |
| `backend` | `bujo`, `supermemory`, or `none`. |
| `mode` | For `bujo` only: `lite`, `journal`, or `bujo`. |
| `status` | `healthy`, `in_progress`, `degraded`, `unhealthy`, `unknown`, or `not_configured`. |
| `checkedAt` | ISO-8601 instant for this audit. |
| `issues` | Canonically ordered subset of the closed issue-code list below. |
| `counts` | Exact non-negative integer keys: `pending`, `due`, `dead`, `outbox`, `temporary`, `memories`, `vectors`, `missingVectors`. |

The statuses and process exit codes are deliberately different dimensions:

| Status | Meaning | Exit |
| --- | --- | --- |
| `healthy` | No issue code is present. | `0` |
| `in_progress` | Durable or snapshot-coherent work is actively pending, with no degraded/unhealthy/unknown condition. | `0` |
| `degraded` | Dead letters, stalled durable work, or missing, stale, or invalid runtime telemetry needs attention. | `1` |
| `unhealthy` | Managed identity, database/index, canonical source, intake/outbox, or temporary-artifact integrity failed. | `1` |
| `unknown` | The built-in database/native module or health check could not be inspected, or a remote Supermemory index cannot be inspected locally. | `1` |
| `not_configured` | No memory backend is configured (`backend: "none"`; no `mode`). | `0` |

For `backend: "bujo"`, classification uses this exact precedence:

1. `database_unavailable`, `native_module_unavailable`, or `health_check_failed` → `unknown`.
2. Any of `manifest_missing`, `manifest_invalid`, `configured_identity_mismatch`,
   `database_missing`, `sqlite_integrity_failed`, `metadata_mismatch`, `fts_mismatch`,
   `vector_mismatch`, `orphaned_rows`, `canonical_mismatch`, `canonical_invalid`,
   `intake_invalid`, `outbox_invalid`, or `temporary_artifacts` → `unhealthy`.
3. `dead_letters`, `work_stalled`, `runtime_missing`, `runtime_stale`, or `runtime_invalid` → `degraded`.
4. Otherwise, `mutation_in_progress`, `intake_pending`, or `outbox_pending` → `in_progress`.
5. No issues → `healthy`.

CLI misuse—including using `--strict` on any subcommand except `memory audit`—exits `2`. The complete closed issue vocabulary is:

```text
manifest_missing manifest_invalid configured_identity_mismatch
database_missing database_unavailable native_module_unavailable health_check_failed
sqlite_integrity_failed metadata_mismatch fts_mismatch vector_mismatch
orphaned_rows canonical_mismatch canonical_invalid mutation_in_progress
intake_invalid intake_pending dead_letters outbox_invalid outbox_pending
work_stalled temporary_artifacts runtime_missing runtime_stale runtime_invalid
```

The strict report is metadata-only by construction. It never publishes paths, filenames, record or run ids, model text, payloads, raw provider/native errors, or arbitrary extra fields. `backend: "supermemory"` therefore reports `unknown` with empty issues and zeroed counts instead of pretending to know remote health; an absent backend reports `not_configured` with the same closed empty shape.

### BuJo replay projection and explicit legacy adoption

The BuJo tier keeps one owner-only canonical replay authority at
`memory.path/.replay-projection-v1.json`. It exactly describes the replay-owned
thread edges, supersession lifecycle/edges, and migration-forget terminal
timestamps that cannot be reconstructed from daily markdown and `graph.jsonl`
alone. The file is metadata-only: ids, timestamps, thread weights, authority
kinds, and content-free authority digests, never memory text or model output.
It must be an owner-owned, single-link regular file with mode `0600` and exact
canonical JSON.

Strict audit compares this entire projection with SQLite. A plausible raw
SQLite edge or lifecycle update that has no exact sidecar authority is still
RED as `canonical_mismatch`; malformed/unsafe canonical bytes are
`canonical_invalid`. Missing plus nonempty legacy replay state is never
auto-blessed by startup, audit, or rebuild. Lite and Journal do not consume the
BuJo sidecar and reject replay-owned lifecycle/edges in their databases.
Interrupted atomic replay-sidecar publication files are also strict temporary
artifacts: they increase `counts.temporary` and report `temporary_artifacts`
instead of being ignored, adopted, or interpreted as canonical authority.

For the one legacy case where a managed generation or legacy unmanaged
`memory.db` legitimately predates the sidecar, make the trust decision
explicitly over SSH. Use this flow only after strict audit or a refused rebuild
identifies a missing projection beside nonempty replay state:

```bash
cd /path/to/agent
mono-agent stop
mono-agent memory adopt-replay --json
mono-agent memory rebuild --json
mono-agent start
mono-agent memory audit --strict --json
```

`adopt-replay` is an explicit trust-on-first-use operation. It requires the
configured built-in `mode: "bujo"`, a stopped store, a missing sidecar, an
exact canonical non-replay base, and a SQLite `BEGIN IMMEDIATE` fence plus
logical digest under the memory-root writer lease. It supports either a managed
active BuJo generation whose semantic identity matches config or a legacy
unmanaged BuJo `memory.db` whose identity can be pinned safely. The database
and every present SQLite sidecar (`-wal`, `-shm`, or `-journal`) must be
current-user-owned, single-link regular files with mode `0600`; adoption rejects
unsafe family members instead of chmodding or following them.

The durable state may contain a bounded set of disjoint capture intents and
completed receipts plus at most one migration marker. Adoption proves that any
already-applied SQLite replay rows are an exact subset of that durable authority
before it binds the full projection. An unexplained row, overlapping mutable
capture plans, or a mutable pending capture beside a pending migration fails
closed. Immutable completed capture receipts may coexist with a later pending
migration. The mandatory immediate `memory rebuild` completes mutable attested
work without another chat-model or embeddings call and removes retireable
markers; a retained completed receipt remains until its intake item resolves.
The subsequent candidate build still uses the configured embeddings provider,
in bounded batches, before it activates the managed generation. Do not run
`start`, capture, migration, or any other writer between adoption and rebuild.

Adoption publishes the sidecar without overwriting existing authority and
retires an advertised BuJo rollback before the canonical change. A Lite or
Journal rollback is outside the replay source domain and remains advertised.
Its success JSON
contains only `backend`, `mode`, `status`, counts for terminals/supersedes/
threads, `authorityDigest`, and `rebuildRequired: true`; it does not reveal
memory text or paths. All failures use stable closed codes/messages. JSON mode
emits one parseable metadata-only failure object on stdout; human mode emits the
same fixed code/message on stderr. Neither includes memory/model text, ids,
paths, marker/database details, or arbitrary underlying errors.

| Adoption failure code | Fixed meaning |
| --- | --- |
| `replay_adoption_usage` | The command/flags do not match the documented adoption invocation. |
| `replay_adoption_config_invalid` | The mono-agent configuration could not be validated. |
| `replay_adoption_requires_bujo` | Configured memory is not built-in BuJo with embeddings. |
| `replay_adoption_agent_running` | The configured agent is still running. |
| `replay_adoption_failed` | A closed operational precondition or integrity check failed; keep the agent stopped and inspect strict health. |

Adoption does not repair, reinterpret, or prove the historical meaning of raw
SQLite state—the operator is accepting that meaning. The required follow-up
rebuild fingerprints the sidecar with the other BuJo canonical sources,
finishes any attested pending protocol without repeating paid provider work,
then uses the configured embeddings provider for the normal semantic candidate
build, reprojects the authority into a fully validated generation, and preserves
it exactly.
Future capture/migration projection changes retire an affected BuJo rollback
before publication; daily-source changes still retire a rollback from any tier.
Thus `rollback` is never advertised against stale replay authority. For an empty
or new root, do not adopt: ordinary rebuild initializes the exact empty
projection safely.

### Completed-turn intake inspection and recovery

The config-aware intake commands operate only on the built-in Lite/Journal/BuJo intake; Supermemory rejects them. `inspect` is read-only and may be used while the agent is running. It returns only the stable 64-character item id, state, admission timestamp, attempt/revision, due flag, and bounded failure category (`model_output`, `provider`, or `processing`), plus aggregate state counts. It never returns `runId`, `conversationId`, summary/capture text, payload hash, filesystem path, or raw model/provider error.

`retry` and `resolve` acquire the memory writer lease and refuse to run while the trace registries show a live process for the same canonical config. Stop the agent first:

```bash
mono-agent stop

# With no id, retry all dead letters and make all delayed pending items due now.
mono-agent memory retry --json
# Or retry one item selected from `inspect`.
mono-agent memory retry <64-character-id> --json

# Explicitly retire one pending/dead item without claiming capture succeeded.
mono-agent memory resolve <64-character-id> operator_discarded --json

mono-agent start
```

`retry` resets selected dead letters to pending and makes selected delayed pending work immediately due; processing resumes after the store starts. A successful no-op still exits `0`, so inspect `changed`/`retried` in JSON. `resolve` is an explicit abandonment: it writes an `operator_resolved` receipt and preserves the permanent id/payload commitment so the same completed run cannot be admitted as new work later. Its reason must be a 1–64 character lowercase slug that begins with a letter/digit and then uses only letters, digits, underscores, or hyphens. It refuses an item with a retained semantic plan because that recoverable commit must finish first. A missing/already-resolved id returns `changed: false`, so automation must check the field rather than the exit code alone.

## `mono-agent validate` — memory liveness

`mono-agent validate` (the agent-app doctor) checks both the configured identity and liveness. A managed generation whose tier, embeddings provider/model, or dimension differs from the current config is an `error` immediately—before any provider/network probe—with the exact active and configured identities plus the stop/rebuild/validate sequence. Invalid/unavailable native SQLite bindings and malformed or missing managed metadata are also errors. Operational provider failures remain `waiting`, so they do not flip the overall result. Read the Memory section. Downstream validation with `mono-agent validate --consumer <path>` never creates a memory root: a missing Lite root is a warning, while missing Journal/BuJo managed authority is an error.

Only Lite may remain unmanaged. Journal and BuJo always require the managed `.index/manifest.json` authority; a manifestless, deleted, or corrupt managed identity is an error and never falls back to a legacy `memory.db`. Fresh init creates the empty managed Journal/BuJo generation without indexing content, but interactive guided readiness first proves the selected embeddings service with a fixed non-user request and exact dimension. Flag/non-TTY scaffolding does not perform that probe or claim readiness. Init deliberately leaves every pre-existing memory root untouched. For an existing or damaged root, stop the agent, run `mono-agent memory rebuild`, and validate again to establish or repair the managed generation.

For scripting, `mono-agent validate --json` writes exactly one top-level JSON object with `ok: boolean` and `sections` (plus `preset` when requested). It emits no ANSI or human prose on stdout and exits `0` exactly when `ok` is `true`; errors exit `1`.

Coverage: cli.

| Tier | Checks performed |
| --- | --- |
| `lite` | Memory root creatable and writable. |
| `journal` | Root writable + configured embeddings identity and provider-specific live probe. |
| `bujo` | All journal checks + explicit capture-LLM config (`agent-host` or Ollama) + consolidation cadence. |

The checks run in this order:

1. **Managed generation identity and native availability** — dynamically loads the built-in memory implementation, rejects ABI/native-loading failures, validates managed manifest authority, and compares the active tier/provider/model/dimension with the configured identity. A mismatch tells you to `mono-agent stop`, run `mono-agent memory rebuild`, and validate again.
2. **Memory root writable** — confirms `memory.path` is creatable and writable.
3. **Provider-specific typed discovery** — Ollama enumerates `/api/tags` and requires `/api/show` capabilities to include `embedding`; LM Studio requires an exact `type: "embedding"` entry from `/api/v1/models` and uses its `key`. OpenAI keeps its credential/config checks.
4. **Real embeddings probe** — Ollama calls `/api/embed`; LM Studio calls `/v1/embeddings`. The selected provider must return one non-empty finite numeric vector with the configured dimension. A declared LM Studio `apiKeyEnv` whose variable is missing reports `waiting`; it never retries keyless. No provider falls through to another provider.
5. **Chat model pulled** (bujo only) — only when `memory.llm.provider` is `ollama`; probes the chat endpoint and checks the chat model against its `/api/tags`. `agent-host` chat LLMs are **not** checked against Ollama.
6. **Consolidation cadence** (bujo only) — reports the consolidation cron expression and whether the scheduler will run for the configured `bujo` tier.

:::caution
For launchd fleet proof, the invoking runtime and durable configuration are part of the result. The fleet checker reads each plist's exact Node executable, `cli.js`, absolute `--config`/`--env-file` arguments, and managed `PATH`, then uses them for the runtime/ABI probe, `validate --json`, `memory audit --strict --json`, and `metrics --json`. Probe children keep only launchd-safe operational environment values: shell-only `MONO_AGENT_*`, provider credentials, `NODE_OPTIONS`, and proxy overrides are deliberately scrubbed so the exact env file remains authoritative. Every subprocess has a hard timeout, and the checker rejects status/issue/count combinations that contradict the producer contract instead of trusting a green status string. The current fleet contract is exact Node `24.15.0` with modules ABI `137`; the ambient shell's Node, config, CLI, or credentials are not evidence that the service can load `better-sqlite3`/`sqlite-vec`.
:::

A healthy bujo report looks like:

```text
[ok] memory.mode     bujo
[ok] consolidation   0 */2 * * * (auto)
```

Embeddings checks target only the configured backend. Selecting LM Studio never causes an Ollama request, and provider failure is not a cross-provider fallback. With `llm.provider: "agent-host"`, the Ollama chat-model pull check is skipped even when embeddings use Ollama or LM Studio. See [Embeddings](/memory/embeddings/) for the provider matrix and [Consolidation](/memory/rituals/) for the auto-scheduler.

:::caution
Use the exact `:v1.5` tag for the default embeddings model. The bare alias `nomic-embed-text` (no tag) may be absent from your Ollama install and will fail the provider at startup — `validate` checks for the exact tag.
:::

## `memory.llm` provider choices

The validator's behavior depends on `memory.llm.provider`. There are two providers, and which one you pick changes both what runs BuJo capture and what `validate` probes. The tier contract is strict: `journal` requires embeddings, and `bujo` requires both embeddings and `memory.llm`; an invalid tier never silently downshifts.

| Field | `ollama` | `agent-host` |
| --- | --- | --- |
| `provider` | `"ollama"` | `"agent-host"` |
| `model` | local model string, e.g. `qwen3.6:latest` | SDK runtime ref, e.g. `pi:openai-codex:gpt-5.6-terra` |
| `executionMode` | (n/a) | must be `"sdk"` |
| `endpoint` | Ollama URL (default `http://localhost:11434`) | **rejected** — Ollama-only |
| `validate` chat-model check | yes (probes `/api/tags`) | no |

Env overrides: `MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE`, `MONO_AGENT_MEMORY_LLM_ENDPOINT`.

### Ollama-backed memory LLM

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": {
      "provider": "ollama",
      "model": "qwen3.6:latest",
      "endpoint": "http://localhost:11434"
    }
  }
}
```

### Host-runtime (SDK) memory LLM

The `agent-host` provider runs memory LLM passes (one batched memory/graph extraction and, only when close existing candidates need classification, one batched reconcile) on their **own dedicated SDK runtime built from `memory.llm.model`** — independent of the channel runtime — so there is no separate local chat model to pull. The `model` is a runtime reference and `executionMode` **must** be `"sdk"`. Do not set `endpoint` — it is Ollama-only and rejected here.

:::note
The memory LLM always executes on `memory.llm.model`, and that model is its **sole primary** — the memory turn does **not** inherit canonical `runtime.fallbacks` or legacy `runtime.fallbackModels`, so there is no failover chain on memory passes. This is deliberate: reusing the channel fallback router would silently run capture on `runtime.model`.
:::

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKeyEnv": "OPENAI_API_KEY",
      "dim": 1536
    },
    "llm": {
      "provider": "agent-host",
      "model": "pi:openai-codex:gpt-5.6-terra",
      "executionMode": "sdk"
    }
  }
}
```

:::caution
`agent-host` memory LLMs are SDK-only for now. CLI-backed refs (e.g. `codex:gpt-5.6-terra`) or an explicit `executionMode: "cli"` are **rejected** at config validation, because those runtimes cannot yet guarantee a no-tools / no-external-actions memory turn.
:::

## The memory-LLM timeout

`MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` / `memory.llm.timeoutMs` sets the per-call timeout for the **in-app** memory LLM — each per-turn [capture](/memory/capture-and-recall/#capture--per-turn-intelligent-capture-bujo) call (one extraction + at most one reconcile). Its default is **`60000`** and the value is bounded `1000`–`600000` ms. Raise it when a slow local memory model trips the cap on extraction or reconcile.

There used to be a second default: the removed standalone `memory-bujo` binary read the same env var but defaulted to `120000`. That binary and its `migrate` path are [gone](#memory-bujo-cli--removed), so only the in-app `60000` default remains.

When the in-app memory LLM does exceed its timeout, the run reports it explicitly — `agent-host memory LLM timed out after 60000ms (provider too slow or unavailable)` — rather than the generic `cancelled` it used to surface, so a slow or dead provider is diagnosable from the run record. The provider answer still succeeds, while the already-admitted turn remains pending for durable retry instead of being reported as captured or lost; see [Capture & recall](/memory/capture-and-recall/).

## Safe index generations: rebuild and rollback

Use the config-aware commands for normal operation:

```bash
cd /path/to/agent
mono-agent stop
mono-agent memory rebuild --json
# Optional detailed local accounting (may include paths/source locations)
mono-agent memory audit --json
# Stopped pre-start gate
mono-agent validate
mono-agent start
# Closed automation gate, including live runtime telemetry
mono-agent memory audit --strict --json
```

`rebuild` reads the configured tier, embeddings provider/model, and dimension; snapshots the canonical markdown/graph sources plus BuJo's exact replay sidecar; builds a complete candidate under `.index/generations/<generation>/memory.db`; validates its schema, exact payloads, complete edge/lifecycle/replay inventory, Journal hash provenance, FTS coverage, vector coverage, and model identity; then atomically switches a small manifest. The replay sidecar participates in the BuJo source fingerprint and is preserved exactly rather than inferred from SQLite. The old active database is retained only through a fresh immutable online-backup generation after tier-exact payload/source parity is proven; repairable lifecycle/source/edge/hash state is normalized on that copy, and Journal may retain its documented recoverable missing-vector backlog. The manifest commits the copy's complete logical state—including WAL-visible rows and vector blobs—so same-count semantic tampering cannot hide behind an unchanged main-file checksum. When source, tier, provider/model, and dimension are unchanged, every retained vector is additionally compared with the newly embedded candidate (missing Journal backlog rows remain repairable). The first supported daily-source mutation atomically removes any rollback advertisement before changing its source; a BuJo graph/replay-only mutation removes only an advertised BuJo rollback. Normal capture may therefore make `memory rollback` unavailable immediately instead of leaving a stale advertised target, while a Lite/Journal rollback remains valid across a graph/replay-only change; out-of-band source edits still surface as `canonical_mismatch`. SQLite writer fences hold the source stable during backup and every soon-to-be-active/retained database stable across final validation plus manifest rename; the fsynced temporary manifest's identity and exact bytes are rechecked immediately before that rename, and the renamed file is checked again after every durability callback. If canonical source is ahead of a stale index, rebuild still activates the correct candidate but deliberately omits that unsafe rollback instead of stamping it with a current fingerprint. The previous active index remains usable if any step fails before activation. A divergent legacy `memory.db` remains byte-for-byte in place but is not advertised as rollback; only a parity-compatible legacy database is adopted by online backup.

The running agent must be stopped. The command refuses a matching live process, an active writer lease/SQLite transaction, concurrent source changes, symlinked source paths, or a concurrent manifest change. Journal/BuJo rebuilds can call the configured embeddings provider in bounded batches; rebuild never calls the chat LLM. Rollback swaps already-validated generations and makes no embedding or chat-model request.

`rollback` is deliberately conservative: its retained generation must match the currently configured tier/provider/model/dimension, its canonical source fingerprint must still match, and its persisted logical integrity commitment must verify. Rollbacks retained by an older build without that commitment fail closed; run one current `rebuild` first to create a verified snapshot. If the rebuild accompanied a tier, embeddings-provider/model, or dimension change, restore that prior config first, then run:

```bash
mono-agent stop
# restore the prior memory.mode / embeddings provider / model / dimension in mono-agent.config.json
mono-agent memory rollback --json
mono-agent validate
mono-agent start
mono-agent memory audit --strict --json
```

Before switching, rollback tries to snapshot the outgoing current index under the same rules. If that outgoing index is already semantically divergent or corrupt, recovery to the verified target still succeeds but no reverse rollback is advertised.

The logical digest is an integrity/CAS commitment under mono-agent's owner-only path and writer controls, not cryptographic authentication against the same OS owner deliberately rewriting both the database and its manifest. Across a tier or model change, rollback also makes no provider call to regenerate the old vectors; it protects the fenced prior snapshot instead. Treat coordinated owner edits as explicit operator replacement, not a supported recovery path.

Rebuild output and `audit --json` report the generation name, indexed count, raw/unstructured/missing-identity/legacy-source/Journal-duplicate skips, source locations that require review, and legacy associations derived by exact unique whole-name matching. BuJo raw audit files are never promoted automatically into the curated index, and no command replays history through a paid chat model.

Supermemory owns its remote index, so `mono-agent memory rebuild`, `rollback`, and `adopt-replay` reject that backend explicitly.

## Enable v1 on an existing agent

`0.8.0` is the first product-v1 lockstep release published to npm. The immutable
`0.7.0` source tag introduced the milestone but was not published. Product v1 is
a product milestone, not an npm major-`1` claim. This is the complete cutover
for an existing local agent, with one backend-specific branch in step 6.

1. Confirm Node.js meets the supported floor. The repository `.nvmrc` pins the exact minimum; an existing agent directory may not contain that file, so select the version explicitly there:

   ```bash
   node --version                 # must be >= 22.19.0
   nvm install 22.19.0            # only if it is not installed
   nvm use 22.19.0
   ```

2. Stop the old agent before changing its installed packages. Then upgrade the
   package that already owns the global `mono-agent` command and confirm the
   exact published version. `create-mono-agent` and `@mono-agent/agent-app` both
   provide that command, so do not install both globally:

   ```bash
   cd /path/to/agent
   mono-agent stop
   npm ls -g --depth=0 create-mono-agent @mono-agent/agent-app || true
   ```

   If `create-mono-agent` is listed, upgrade that owner:

   ```bash
   npm i -g "create-mono-agent@0.8.0"
   ```

   Otherwise, if `@mono-agent/agent-app` is listed, upgrade that owner instead:

   ```bash
   npm i -g "@mono-agent/agent-app@0.8.0"
   ```

   Then confirm the command resolves to the new version:

   ```bash
   mono-agent --version
   ```

   For a new global install, prefer `create-mono-agent`. To switch package
   owners, uninstall the currently listed package before installing the other
   one. If this agent's existing configuration selects Supermemory as
   `memory.backend`, install the matching plugin in the agent folder now,
   before any new CLI command loads the configured responder:

   ```bash
   VERSION="0.8.0"
   npm install --save-exact "@mono-agent/memory-supermemory@$VERSION"
   ```

3. Check/refresh the two managed configuration skills. Reconcile any
   operator-modified skill before using `--update`. On macOS, ensure the
   background agent is ready before opening the dedicated SELF-CONFIG
   conversation:

   ```bash
   mono-agent install-skill --project --check
   mono-agent install-skill --project --update
   mono-agent status
   mono-agent tui --configure
   mono-agent config
   ```

   The opening message marks SELF-CONFIG, maps every capability area once, and begins a user-led workflow conversation; never enter secrets. The bundled `mono-agent-configure` and `mono-agent-memory` skills can prepare an incremental constrained proposal, but the host still validates it and asks for separate approval before writing. No proposal, rejection, approval, `done`, or `no changes` exits the session. Approval restarts the background agent and waits for a new ready source; a failed new config restores the files and restarts the previous agent. Only quitting closes SELF-CONFIG, while the background agent stays up. Off macOS, edit the config/identity manually, validate, use `start --foreground`, and open ordinary `tui`; conversational configuration is unavailable.

4. Confirm that the exact embeddings model is available from the selected provider. For Ollama:

   ```bash
   ollama list
   ollama pull nomic-embed-text:v1.5   # only if that exact tag is absent
   ```

   For LM Studio, load the embedding model, start the local server, and ensure the typed discovery key from `/api/v1/models` matches `memory.embeddings.model`. If `apiKeyEnv` is configured, export that variable before validation; omitting both key fields intentionally selects keyless mode.

5. Validate the configured folder and read the **Memory** section. A running provider process is not sufficient if the active managed generation has a different tier/provider/model/dimension, the configured endpoint differs, typed discovery cannot find the exact model, or the real embedding probe fails:

   ```bash
   mono-agent validate
   ```

6. For the built-in Lite, Journal, or BuJo backend, inspect the stopped store:

   ```bash
   mono-agent memory audit --json
   ```

   Only for a legacy BuJo store, and only when the audit or first rebuild
   explicitly identifies nonempty replay-owned SQLite state without its
   canonical projection, adopt that replay state while every writer remains
   stopped:

   ```bash
   mono-agent memory adopt-replay --json
   ```

   Then build the managed index, verify it, and start the agent:

   ```bash
   mono-agent memory rebuild --json
   mono-agent memory audit --json
   mono-agent validate
   mono-agent start
   mono-agent memory audit --strict --json
   mono-agent status
   ```

   Do not run `adopt-replay` merely because an audit is unhealthy: it is a
   trust-on-first-use command for the exact missing-projection legacy case and
   rejects unrelated drift. If the first rebuild gives that explicit adoption
   instruction, run `adopt-replay` and then rerun the rebuild without starting
   another writer between them.

   If `memory.backend` is `supermemory`, the matching plugin was installed in
   step 2. Skip `adopt-replay`, `memory rebuild`, and `rollback`: Supermemory
   owns its remote index and those built-in index-transition commands
   intentionally reject it.

   ```bash
   mono-agent validate
   mono-agent start
   mono-agent status
   ```

   `memory audit --json` is safe for Supermemory but reports local integration
   metadata only; it cannot inspect the remote index.

7. Verify both kinds of context in the TUI or an enabled conversational channel without restarting between messages. For Telegram, send `Reply exactly with this token: V1-HISTORY-<unique>`, wait for that reply, then ask `What did you send in the last message?` and confirm the token comes back. That second run should use active history and inject no durable memory. Finally ask a qualified durable-memory question such as `What did we decide about releases last month?` to exercise `MemoryRecall`.

The strict audit deliberately includes live runtime telemetry. While the agent is stopped it reports
`runtime_missing` or `runtime_stale` instead of claiming the whole running system is healthy. Use
`mono-agent validate` after a stopped rebuild or rollback, then start the agent and run the strict
audit as the closed live gate.

If `memory.llm.provider` is `agent-host`, the selected embeddings service is independent: Ollama is needed only for `memory.embeddings.provider: "ollama"`, while LM Studio embeddings use only LM Studio. You do not need an Ollama chat model. If rollback is needed, stop the agent, restore the prior tier/provider/model/dimension if it changed, run `mono-agent memory rollback --json`, validate, start again, and run the strict audit.

## `memory-bujo` CLI — removed

The standalone `memory-bujo` binary and its compatibility error-deflector have been removed. The env-var-driven, `<root>`-positional workflow is gone with the bin; managed configuration comes from `mono-agent.config.json`, and every maintenance operation now runs config-aware from the agent folder.

Coverage: cli.

| Removed `memory-bujo` command | Replacement |
| --- | --- |
| `rebuild <root> --tier <t>` | [`mono-agent memory rebuild`](#safe-index-generations-rebuild-and-rollback) — config-aware; run from the agent folder |
| `rollback <root> --tier <t>` | [`mono-agent memory rollback`](#safe-index-generations-rebuild-and-rollback) — config-aware; run from the agent folder |
| `recall <root> "<query>"` | [`mono-agent memory search "<query>"`](#mono-agent-memory--config-aware-preview) |
| `index <root>` | Removed with no one-for-one scheduled replacement; the in-app [scheduler](/memory/rituals/) calls only projection-only `store.consolidate()` |
| `reflect <root>` | Removed with no one-for-one scheduled replacement; the in-app [scheduler](/memory/rituals/) does not run reflection |
| `migrate <root>` | Removed historical v1→v2 workflow with no current CLI replacement |

The config-aware `mono-agent memory rebuild` / `rollback` read the tier, embeddings provider/model, and dimension from config, so they no longer need a `--tier` flag or a positional `<root>`; see [Safe index generations](#safe-index-generations-rebuild-and-rollback). The removal is recorded in [Deprecations](/reference/deprecations/).

## Related

- [Embeddings](/memory/embeddings/) — providers, models, dimensions, and env vars.
- [Capture & recall](/memory/capture-and-recall/) — `writeMode` and the `MemoryRecall` tool.
- [Consolidation](/memory/rituals/) — in-app consolidation auto-scheduler.
- [Config blueprint](/config/blueprint/) — the full annotated `memory` block.
- [Environment variables](/config/env-vars/) — every `MONO_AGENT_MEMORY_*` override.
- [CLI reference](/observability/cli-reference/) — the broader `mono-agent` command surface.

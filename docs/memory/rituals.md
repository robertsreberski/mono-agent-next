---
title: "Consolidation"
description: "Configure and verify BuJo's in-app projection-only consolidation schedule and understand exactly which memory state it does and does not change."
sidebar:
  order: 3
---

The `bujo` memory tier maintains itself with one scheduled **consolidation** pass that
runs **in-app** — no external cron, launchd, or sidecar process. Consolidation is a
lightweight, projection-only housekeeping cycle: refresh the living `index.md`, keep the
retired `future-log.md` stub empty, and report how many exact-normalized duplicate groups
were found.

The `consolidate()` operation itself is deterministic and makes no chat-model call. In v1,
salience is static canonical Markdown metadata: scheduled consolidation does not decay it,
and it never supersedes, deletes, or rewrites canonical memories. Journal content-hash
identity and BuJo capture reconciliation prevent most new duplicates at write time.
The in-app scheduler starts only for the strict `bujo` tier. Configuration therefore requires
`memory.mode: "bujo"`, embeddings, and `memory.llm`; omitting a prerequisite is a validation
error, never a downshift to Journal. The `lite` and `journal` tiers do not run scheduled
maintenance. For tier selection and the
`memory.llm` block, see [Capture & recall](/memory/capture-and-recall/) and the
[Memory overview](/memory/). Coverage type: **config**.

## The in-app scheduler

When the configured store tier is `bujo`, `agent-app` starts a consolidation scheduler
alongside your channels.

| Pass | What it does | Default cron |
| --- | --- | --- |
| Consolidation | Refresh `index.md`, keep `future-log.md` empty, report the duplicate-group count; no canonical-memory mutation | `0 */2 * * *` |

The scheduler starts with the app and stops cleanly on shutdown. The pass is error
isolated: a failed consolidation is logged and the scheduler carries on.

**Overlap protection:** a new run is skipped if the previous consolidation is still in
flight. Long passes will not stack up or run concurrently with themselves.

Cron expressions are evaluated by the in-app scheduler. The default runs every two hours
because the projection pass is intentionally cheap and does not call an LLM.

## Configuration

Consolidation lives under `memory.consolidation` with the same `{ enabled, cron }` shape
used elsewhere in config.

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "ollama", "model": "qwen3.6:latest" },
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" }
  }
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `memory.consolidation.enabled` | boolean | `true` | Run scheduled consolidation |
| `memory.consolidation.cron` | string | `0 */2 * * *` | Five-field UTC consolidation cadence; hashed `H` fields are not supported |

The consolidation schedule is evaluated in UTC. It accepts the shared parser's five-field syntax, including named months and weekdays, but rejects hashed `H` fields because consolidation has no per-job identity from which to derive a stable hash seed.

### Enable / disable

To keep the `bujo` tier but turn off scheduled consolidation, set `enabled` to `false`:

```json
{
  "memory": {
    "mode": "bujo",
    "consolidation": { "enabled": false }
  }
}
```

You can also shift cadence — e.g. every four hours:

```json
{
  "memory": {
    "mode": "bujo",
    "consolidation": { "cron": "0 */4 * * *" }
  }
}
```

### Environment overrides

Each key has a `MONO_AGENT_MEMORY_*` env var that overrides the config value:

| Env var | Overrides |
|---------|-----------|
| `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | `memory.consolidation.enabled` |
| `MONO_AGENT_MEMORY_CONSOLIDATION_CRON` | `memory.consolidation.cron` |

```bash
export MONO_AGENT_MEMORY_CONSOLIDATION_CRON="0 */4 * * *"
export MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED=true
```

Retired `memory.reflection.*` / `memory.migration.*` keys and
`MONO_AGENT_MEMORY_REFLECTION_*` / `MONO_AGENT_MEMORY_MIGRATION_*` env vars are tolerated
but ignored. `mono-agent validate` reports value-free warnings when it sees them.

## Living index files

Projection-only consolidation maintains these markdown files at the root of your
`memory.path`:

- **`index.md`** — a living table of contents: entry counts, the top/most-relevant
  memories, and a bounded entity graph preview. The preview filters ephemeral
  calendar/time rows (`date`, `datetime`, `day`, `duration`, `month`, `quarter`,
  `temporal`, `time`, `timestamp`, `week`, `weekday`, and `year`) and collapses
  NFKC-, case-, whitespace-, dash-, and underscore-equivalent names to one lexical
  referent. It scans deterministic source pages until the inventory ends or the explicit
  10,000-row safety ceiling is reached, retaining only bounded reconciliation state before
  rendering at most 50 rows. When canonical rows disagree on type, including a duplicate
  on a later source page after 50 output rows are already available, the preview omits the
  type instead of choosing one. This is projection-only: canonical entity ids,
  relations, and associations are not rewritten. The consolidation result reports the
  duplicate-group count separately.
- **`future-log.md`** — a retired compatibility stub. Consolidation writes it as exactly
  `# Future Log` and does not project future items there.

Because the whole `bujo` store is plain markdown on disk, these files are human-readable
and diffable — you can browse them directly or commit them.

## Why consolidation is projection-only

Canonical Markdown and the active SQLite index must move together. Any lifecycle feature
that decays salience, merges duplicates, or supersedes existing facts therefore needs the
same durable transaction, replay, validation, and rollback guarantees as capture and
migration. V1 keeps the scheduled path deliberately small and safe. Richer lifecycle
mutation belongs behind an explicit future feature or external plugin boundary, not an
implicit timer that rewrites memory.

## Verifying the schedule

`mono-agent validate` reports the configured cadence in its Memory section:

```text
[ok] memory.mode     bujo
[ok] consolidation   0 */2 * * * (auto)
```

See [Validation & CLI](/memory/validation-and-cli/) for the full liveness check. Validation
reports scheduled consolidation only when the configured store tier is `bujo`; otherwise it
reports that consolidation is not scheduled.

:::caution
Scheduled consolidation needs a valid strict `bujo` configuration. Missing embeddings or
`memory.llm` fails configuration instead of silently running a reduced tier. Manual deterministic
`consolidate()` remains available to programmatic callers and has the same projection-only
contract. Validate before relying on automated maintenance.
:::

## Manual / out-of-band runs

The standalone `memory-bujo` CLI that used to offer manual `reflect`, `migrate`, and `index`
runs has been removed; any invocation now prints a removal error and exits non-zero. There is no
longer a manual out-of-band path:

- `index` and `reflect` — removed with no one-for-one scheduled replacement. The in-app
  [scheduler](#the-in-app-scheduler) calls only projection-only `store.consolidate()`; it does
  not invoke either legacy operation.
- `migrate` — a removed historical v1→v2 workflow with no current CLI replacement.
- `rebuild` / `rollback` — use the config-aware
  [`mono-agent memory rebuild` / `rollback`](/memory/validation-and-cli/#safe-index-generations-rebuild-and-rollback)
  from the agent folder.

See [Validation & CLI](/memory/validation-and-cli/#memory-bujo-cli--removed) for the full command
mapping and [Deprecations](/reference/deprecations/) for the removal record.

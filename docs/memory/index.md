---
title: "Memory"
description: "Choose a memory backend and tier, understand its files and dependencies, and follow the config-first path for capture, recall, and maintenance."
sidebar:
  order: 0
---

This guide covers the three memory tiers available in mono-agent, all backed by the
same `@mono-agent/memory/store` + `@mono-agent/memory/bujo` substrate. Pick the tier
that matches your external-dependency budget; all tiers share the same config shape —
only `memory.mode` and the optional embeddings/LLM blocks differ.

Weighing the built-in engine against an external memory service? See
[Backends: BuJo vs Supermemory](/memory/backends-comparison/).
Planning shared knowledge across several agents? See
[Fleet-scale shared knowledge](/memory/backends-comparison/#fleet-scale-shared-knowledge)
for the current framework boundary and external-service pattern.

## Memory Tiers

| Capability | `lite` | `journal` | `bujo` |
| --- | --- | --- | --- |
| FTS keyword recall | yes | yes | yes |
| Deterministic host observation | canonical daily log | canonical daily log, hash-deduplicated | separate raw audit |
| Hybrid recall (BM25 + vector RRF) | — | yes | yes |
| Semantic indexing off the successful-turn path | — | yes, bounded batches | yes, during bounded curation |
| Static canonical salience metadata | yes | yes | yes |
| LLM capture/reconcile (ADD/UPDATE/SUPERSEDE/NOOP) | — | — | yes |
| Entity graph | — | — | yes |
| Projection-only consolidation (`index.md` + duplicate-group count) | — | — | yes |
| Auto-scheduled maintenance (in-app scheduler) | — | — | yes |
| Living `index.md` + retired `future-log.md` stub | — | — | yes |
| **Requires embeddings** | no | **yes** | **yes** |
| **Requires chat model** | no | no | **yes** |

### `lite`

FTS keyword recall plus a canonical daily host observation. No external dependencies — SQLite
is bundled. Suitable when you want lightweight, predictable context injection without
running Ollama. Host summaries can be appended after each run
(`writeMode: "append-host-summary"`).

### `journal`

Adds hybrid recall (BM25 + vector RRF) on top of the lite tier. Salience remains
static canonical Markdown metadata; the scheduler does not decay it over time.
Requires a configured Ollama, LM Studio, or OpenAI embeddings provider. No chat model needed.
The host first fsyncs the completed turn into run-id-keyed durable intake, then projects a lexical
observation using a stable content-hash identity and queues vector indexing in bounded batches. A
slow or temporarily unavailable embedding provider therefore does not delay terminal reporting;
the admitted turn survives restart and its lexical/vector projections retry.

### `bujo` (BuJo — Bullet Journal memory)

The full tier: hybrid recall plus bounded LLM curation, an entity graph, and lightweight
consolidation. The host first fsyncs a run-id-keyed completed-turn record, then projects a compact
immutable observation in `audit/`, outside curated recall. `writeMode: "capture"` then uses one batched memory/graph extraction and at
most one batched reconcile call to promote durable facts into daily notes, classifying close
entries as ADD / UPDATE / SUPERSEDE / NOOP. Each fact retains only its explicitly extracted
entity associations. The raw audit is never automatically treated as curated truth.

A **consolidation** pass keeps the store legible as a projection: it refreshes the living
`index.md`, writes `future-log.md` as an empty retired stub (`# Future Log`), and reports
how many exact-normalized duplicate groups it found. It does not change salience,
supersede or rewrite canonical memories, or create monthly projection files. Capture-time
reconciliation and Journal content-hash identities prevent most new duplicates before this
report is needed.

Consolidation is **auto-scheduled in-app** for the `bujo` tier: the agent-app scheduler
runs `store.consolidate()` at the configured cron cadence (default `0 */2 * * *`, every
two hours). No external cron or launchd setup is required. Run `mono-agent validate` to
confirm whether automatic consolidation will run.

Requires embeddings and a chat model for the LLM pipelines. The app-level chat model can
be a direct Ollama model or an `agent-host` runtime model reference such as
`pi:openai-codex:gpt-5.6-terra`.

The tier matrix is strict. `lite` rejects embeddings/LLM configuration, `journal` requires
embeddings and rejects a memory LLM/consolidation, and `bujo` requires both embeddings and
the memory LLM. Invalid configuration fails instead of silently downshifting.

## Local persistence threat model

The built-in Lite, Journal, and BuJo store is designed for one trusted OS owner on a local
filesystem. Its defensive file handling primarily protects against process or host crashes during
fsync-ordered state transitions and against accidental concurrent writers, especially a maintenance
CLI racing the running agent. Atomic publication, durable receipts, writer leases, stable file-identity
and single-link checks, owner-only coordination records, and symlink rejection let those cases
recover deterministically or fail closed instead of reporting a corrupt or partial transition as
success.

This is not a multi-tenant or adversarial security boundary. In particular, checksums and logical
digests detect unexpected changes inside the trusted same-user workflow; they do not authenticate
the store against a malicious process running as that OS owner (or as root) that can rewrite both
data and its commitments. Network-provider trust and external memory backends are separate
boundaries. Manual same-owner edits are outside this guarantee: stop the agent and use the
documented maintenance flows instead of rewriting managed files in place. See [reversible forget
plans](/memory/validation-and-cli/#reversible-explicit-bujo-forget-plans) and [safe rebuild and
rollback](/memory/validation-and-cli/#safe-index-generations-rebuild-and-rollback) for the concrete
locking, recovery, and integrity rules.

This posture is specific to durability-critical memory state and its coordination records: do not
copy it mechanically into lower-stakes files, and do not remove an individual guard without
re-proving the surrounding durability and writer-lease protocol.

## Config

### Lite tier (no external deps)

```jsonc
{
  "memory": {
    "mode": "lite",
    "path": "./.mono-agent/memory",      // root directory; created on first run
    "writeMode": "append-host-summary",  // disabled | append-host-summary
    "maxBytes": 64000                    // context-load byte cap
  }
}
```

### Journal tier (embeddings, no chat model)

```jsonc
{
  "memory": {
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "maxBytes": 64000,
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",  // IMPORTANT: use the exact :v1.5 tag — the
                                         // bare "nomic-embed-text" alias may not exist
      "endpoint": "http://localhost:11434",
      "dim": 768                         // nomic-embed-text:v1.5 output dimension
    }
  }
}
```

### Bujo tier (embeddings + chat model + consolidation)

```jsonc
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "maxBytes": 64000,
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": {                             // required for bujo LLM pipelines
      "provider": "ollama",
      "model": "qwen3.6:latest",         // any local chat model; set MONO_AGENT_MEMORY_LLM_MODEL for CLI
      "endpoint": "http://localhost:11434"
    },
    // Lightweight consolidation is auto-scheduled in-app for the bujo tier.
    "consolidation": {
      "enabled": true,
      "cron": "0 */2 * * *"            // every two hours (default)
    }
  }
}
```

For Pi SDK memory capture through the host runtime, use:

```jsonc
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

`agent-host` memory LLMs are SDK-only for now. CLI-backed refs such as
`codex:gpt-5.6-terra`, or explicit `executionMode: "cli"`, are rejected because those
runtimes cannot yet guarantee a no-tools/no-external-actions memory turn.

### Per-turn write mode (`memory.writeMode`)

How the **host** persists each completed turn (independent of the tier's recall):

- `disabled` — never write.
- `append-host-summary` — admit a deterministic observation by stable provider run id. The built-in backend fsyncs it, then projects it without a chat LLM: Lite/Journal put it in the canonical daily log, Journal queues semantic indexing after the lexical commit, and BuJo puts it in the separate raw audit. Supermemory instead awaits one run-keyed remote upsert of the summary.
- `capture` — on the built-in backend, fsync the summary and full capture text by stable provider run id, then project the raw audit and run serialized BuJo curation in the background. One contract-explicit, strictly validated extraction call plus at most one strict batch-reconcile call writes canonical facts and precise graph evidence. The extraction prompt spells out the exact field, `0..1` salience, identifier, reference, and relation rules. Reconciliation spells out each exact action shape: `ADD` omits target/text, `NOOP` requires a supplied target id and omits text, and `UPDATE`/`SUPERSEDE` require target plus complete replacement text. The provider-neutral strict parser never fills or coerces an invalid result. A normal stop drains for up to 10 seconds; a timed-out active attempt remains pending for restart. Provider/model failures retry with bounded exponential backoff for more than 24 hours, then remain as a durable dead letter rather than claiming success. Built-in `capture` requires `mode: "bujo"`; Supermemory accepts it independently of the compatibility mode and awaits a remote upsert before its service performs asynchronous extraction.

The strong built-in write returns only after the owner-only `.capture-intake/pending` record and
directory entry plus its compact content-free admission commitment are durable. Repeating the same
run and payload remains idempotent after bounded rich-receipt pruning; a conflicting payload fails
closed. Projection/capture transitions use monotonic receipts and run-derived fact
ids, so restart after canonical/SQLite commit cannot duplicate the audit or semantic fact. Invalid
or partial model JSON remains retryable and never counts as a successful empty capture. An intake
admission failure leaves the provider answer intact but reports explicit memory degradation.

Low-signal successful turns are skipped in every write mode: the `NOTHING_TO_REPORT` no-op sentinel and tiny explicit test/ping probes such as `test` / `test ok`. Cron and webhook writes are assistant-answer-only, so trigger prompts and webhook pre-instructions do not enter memory.

```jsonc
{ "memory": { "mode": "bujo", "writeMode": "capture", "path": "./.mono-agent/memory" /* + embeddings + llm */ } }
```

## Prerequisites

### Lite tier

No external prerequisites. SQLite is bundled.

### Journal tier

**Embeddings service:** guided init chooses Ollama or LM Studio and proves the exact
model/dimension. For Ollama, pull the default model first:

```bash
ollama pull nomic-embed-text:v1.5
```

Use the exact `:v1.5` tag. The bare alias `nomic-embed-text` (without a tag) may not
be present in your Ollama installation and will cause the embeddings provider to fail
at startup. `mono-agent validate` checks for this exact tag.

### Bujo tier

**Embeddings service:** guided init chooses Ollama or LM Studio independently from the
capture LLM. For Ollama embeddings, pull the default model first:

```bash
ollama pull nomic-embed-text:v1.5
```

**Chat model (required for LLM pipelines when using `llm.provider: "ollama"`):**

```bash
ollama pull qwen3.6:latest   # or any local chat model you prefer
```

Set `memory.llm.model` or `MONO_AGENT_MEMORY_LLM_MODEL` to the capture model used by the
configured app. With `memory.llm.provider: "agent-host"`, that value may be an SDK runtime
model reference such as `pi:openai-codex:gpt-5.6-terra`. The old standalone `migrate` and
`reflect` workflows are not part of the current operator surface.

## Auto-Scheduler (bujo tier)

When `memory.mode` is `"bujo"` and `memory.llm` is configured, the agent-app starts an
**in-app consolidation scheduler** alongside the other channels. It runs
`store.consolidate()` at the UTC `memory.consolidation.cron` cadence (default `0 */2 * * *`,
every two hours). The schedule accepts shared five-field cron syntax but not hashed `H` fields.
Consolidation refreshes the living `index.md`, keeps `future-log.md` as a
literal empty stub, and reports the duplicate-group count. It never decays salience or automatically
supersedes or rewrites canonical memories.

Overlap protection: a new run is skipped if the previous consolidation is still in
flight. Failures are logged and the scheduler carries on. The scheduler starts with the
app and stops cleanly on shutdown.

`mono-agent validate` reports the configured cadence in the Memory section:

```text
[ok] memory.mode     bujo
[ok] consolidation   0 */2 * * * (auto)
```

To disable scheduled consolidation while keeping the tier, set
`memory.consolidation.enabled: false`. Env overrides:
`MONO_AGENT_MEMORY_CONSOLIDATION_CRON` and `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED`.
Retired `memory.reflection.*` / `memory.migration.*` keys and their env vars are tolerated
but ignored; `mono-agent validate` reports a warning when it sees them.

## CLI maintenance

Use the config-aware CLI from the agent folder for index transitions. It reads the exact
tier/provider/model/dimension from `mono-agent.config.json`, refuses a running configured agent,
builds a validated generation beside the active database, and switches it atomically.

```bash
mono-agent stop
mono-agent memory rebuild --json
mono-agent validate
mono-agent start
mono-agent memory audit --strict --json

# If needed: stop, restore the prior tier/model/dim config, then swap generations
mono-agent memory rollback --json
```

The strict audit is a provider-free, closed JSON health gate over managed identity,
SQLite/canonical consistency, durable intake/outbox state, and the runtime snapshot. It
publishes only a status, closed issue codes, and the eight counts `pending`, `due`, `dead`,
`outbox`, `temporary`, `memories`, `vectors`, and `missingVectors`; it never publishes
paths, ids, payloads, memory/model text, or raw errors. `healthy`, `in_progress`, and
`not_configured` exit 0; `degraded`, `unhealthy`, and `unknown` exit 1. See the
[strict health contract](/memory/validation-and-cli/#strict-provider-free-health-gate) for
the exact schema and issue vocabulary. Because that contract includes live runtime telemetry,
a stopped store is expected to report `runtime_missing` or `runtime_stale`; use `validate` as the
stopped pre-start gate and run the strict audit after `start`.

When strict health reports pending/dead intake, `mono-agent memory inspect [<id>] --json`
shows metadata only. With the matching agent stopped, `memory retry [<id>]` makes selected
work due for the next store start; `memory resolve <id> <reason-slug>` explicitly abandons
one item without claiming capture succeeded. Mutations acquire the writer lease and fail if
the trace registry shows the configured agent still running. See
[intake recovery](/memory/validation-and-cli/#completed-turn-intake-inspection-and-recovery).

Rebuild never calls the chat LLM or replays historical turns through a paid model. It may
re-embed canonical Journal/BuJo facts in bounded batches. A prior index is retained only as
a fresh immutable, source-parity-verified backup with a logical integrity commitment;
divergent legacy/current indexes are preserved but not advertised as safe rollback.
Pre-activation failures leave the current active generation in place. See the [safe generation model](/memory/validation-and-cli/#safe-index-generations-rebuild-and-rollback) for layout, source accounting, safety gates, and rollback; use the separate [product-v1 cutover checklist](/memory/validation-and-cli/#enable-v1-on-an-existing-agent) for an existing agent.

The standalone `memory-bujo` binary that used to offer root-oriented inspection and manual
maintenance has been removed; any invocation now prints a removal error and exits non-zero. Run
every maintenance operation config-aware from the agent folder instead:

- `rebuild` / `rollback` → `mono-agent memory rebuild` / `mono-agent memory rollback` (they read
  tier, embeddings provider/model, and dimension from config, so there is no `--tier` flag or
  positional `<root>`).
- `recall` → `mono-agent memory search "<query>"`.
- `index` and `reflect` → removed with no one-for-one scheduled replacement. The in-app
  scheduler runs only projection-only `store.consolidate()`; it does not invoke either legacy
  operation.
- `migrate` → removed historical v1→v2 workflow with no current CLI replacement.

See [Validation & CLI](/memory/validation-and-cli/#memory-bujo-cli--removed) for the full mapping
and [Deprecations](/reference/deprecations/) for the removal record.

`MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` sets the per-call chat-LLM timeout for the **in-app** memory
LLM (per-turn capture): it maps to `memory.llm.timeoutMs` and defaults to `60000`. A capture runs
one extraction call and at most one reconcile call; a timeout is recorded and warned without
failing the user's reply. The raw audit survives, and the admitted turn remains pending for
durable retry rather than being declared captured or lost. Raise the timeout for slow models. See
[Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout).

## Liveness Check — `mono-agent validate`

`mono-agent validate` (the agent-app doctor) first dynamically loads the built-in memory
implementation and validates managed identity. Journal and BuJo require a valid managed
`.index/manifest.json`; only Lite may remain unmanaged. Missing/corrupt managed metadata,
a tier/provider/model/dimension mismatch, or native-module/ABI failure is an `error` with stop,
rebuild, and revalidate remediation. It then runs liveness checks that scale with the tier:

**lite:** confirms the memory root is creatable and writable.

**journal / bujo:**
1. **Memory root writable** — confirms `memory.path` is creatable and writable.
2. **Typed embedding model** — Ollama requires `/api/show` capability `embedding`; LM
   Studio requires exact type `embedding` in `/api/v1/models`. OpenAI keeps its
   credential/config checks.
3. **Real provider probe** — the configured backend must return one non-empty finite vector
   from `/api/embed` or `/v1/embeddings` with the configured dimension. Missing declared LM
   Studio auth reports `waiting`; failure never crosses providers.

**bujo (additional):**
4. **Chat model pulled** — only when `memory.llm.provider` is `ollama`; probes the chat
   endpoint and checks the chat model against that endpoint's `/api/tags`. `agent-host`
   chat LLMs are not checked against Ollama.
5. **Consolidation cadence** — reports the consolidation cron expression and whether
   the scheduler will run (tier is bujo with an llm configured).

Provider reachability or missing pulled models emit a loud `[warn]` in the validate report's
Memory section (status `waiting`, so those operational warnings do not flip the overall
result to `error`). Structural/managed/native failures are errors. There is **no silent
fallback**: the host never downgrades the configured tier. Run `mono-agent validate` before
cutover (and after pulling models) to confirm the tier is live. For automation,
`mono-agent validate --json` emits one prose/ANSI-free `{ok, sections, ...}` object and exits
0 exactly when `ok` is true.

## Composer Integration

When composing an agent with `mono-agent-composer`, the composer explains the three
tiers during the memory strategy step (question 6). See
`packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md` for
the full question flow and config blocks the composer writes.

## Recall Tool (`MemoryRecall`)

The agent gets a single read-only `MemoryRecall` tool — FTS search for Lite and hybrid keyword/semantic search for Journal/BuJo. It is **auto-provisioned by `agent-app`** from the single `config.memory` block and defaults on for every configured tier; set `recallTool.enabled` to `false` to opt out. There is no hand-wired `.mcp.json` entry and no separate local LLM to run.

Unqualified active-conversation questions are not durable-memory searches. For example,
`What did you send in the last message?` bypasses automatic recall, and a mistaken tool call
returns guidance to use the current provider conversation without querying the memory backend.
Qualified archived history still uses the tool. BuJo tool recall may add one deterministic graph
hop; automatic context remains direct-only, while Lite/Journal never expand the graph.

Recalled entries do **not** sit in the system prompt. The harness appends them to the **user message** each turn (when recall returns hits), so memory survives a session resume; a `memory_recalled` diagnostic keeps recall visible in run traces. The `MemoryRecall` tool described here is the *on-demand* path the agent can additionally call mid-turn to pull more. See [Context assembly → Memory recall](/context/assembly/#memory-recall).

Under the hood `agent-app` exposes a request-scoped loopback MCP endpoint over its **same app-owned retrieval service and store**. Automatic recall and an identical normalized tool query share one per-turn lookup; a materially different query may search again. Recall needs no chat LLM; durable writes stay in-app via per-turn capture (`writeMode: "capture"`). This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture`/`memory_note` — both dropped, since in-app capture already covers durable writes).

**Migrating off `@mono-agent/memory-mcp` (external consumers):** the package is removed from this repo (the published `0.3.0` stays on npm but receives no further updates). If you depended on it directly: (1) **as an MCP server bin / `node .../memory-mcp/dist/main.js` in a `.mcp.json`** — drop that entry and instead set `config.memory.recallTool.enabled: true` so the host auto-provisions the bundled `mono-agent-memory` recall server (no hand-wired entry, no separate LLM); (2) **as a library import (`@mono-agent/memory-mcp`)** — build directly on `@mono-agent/memory/bujo` (`createBujoMemoryStore`) + `@mono-agent/memory/search` (`createEmbeddingProvider`), which is exactly what the recall server does; (3) **the `memory_capture` / `memory_note` write tools have no replacement tool** — durable writes are now host-driven per turn via `memory.writeMode: "capture"` (or `append-host-summary`), so the agent no longer needs an explicit write tool.

**Tool-policy note:** `MemoryRecall` is an MCP tool, and like every MCP server tool (config `mcpServers`, `AskCollaborator`) it is **gated by its declaration, not by `tools.allowedTools`**. `tools.allowedTools` filters the built-in runtime tools (Read/Bash/…) and adapter send tools; it does **not** suppress app-injected MCP tools. Set `config.memory.recallTool.enabled: false` to remove the on-demand tool; automatic score- and answer-evidence-gated context recall remains part of configured memory.

## References

- [Memory quality benchmark](/memory/benchmarking/) — disposable offline quality and efficiency gate
- Feature registry rows: `docs/reference/feature-registry.md` — `memory.lite`, `memory.journal`, `memory.bujo`, `memory.write-mode`, `memory.per-turn-capture`, `memory.recall-tool`

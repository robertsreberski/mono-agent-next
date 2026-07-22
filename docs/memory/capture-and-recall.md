---
title: "Write modes, capture & recall"
description: "Understand completed-turn admission, write modes, automatic context recall, and the MemoryRecall tool across built-in and external memory backends."
sidebar:
  order: 2
---

This page covers the two halves of the memory loop: how the host **writes** each completed turn (`memory.writeMode`) and how the agent **reads** what it stored back through the auto-provisioned `MemoryRecall` tool. Both are driven by the single `config.memory` block — there is no separate `.mcp.json` entry to hand-wire.

For tier selection (lite / journal / bujo) and embeddings setup, start at the [Memory overview](/memory/) and [Embeddings](/memory/embeddings/). Recall is the read path; scheduled consolidation is the maintenance path covered in [Consolidation](/memory/rituals/).

## Write modes (`memory.writeMode`)

`memory.writeMode` controls how the **host runtime** persists each completed turn. It is independent of the tier's recall capability. Coverage: **config** (env: `MONO_AGENT_MEMORY_WRITE_MODE`).

| Mode | What it does | Backend / tiers | LLM |
|------|--------------|-------|-----|
| `disabled` | Never persist turns. Recall still works over existing backend state. | all | no |
| `append-host-summary` | Admit one deterministic host observation by provider run id. The built-in backend fsyncs and projects it; Supermemory awaits a remote upsert. | built-in Lite/Journal/BuJo; Supermemory | built-in: no; Supermemory: service-owned |
| `capture` | Admit the host summary plus full approved capture text by provider run id. Built-in BuJo curates in the background; Supermemory sends it for server-side extraction. | built-in BuJo; Supermemory | BuJo: configured chat model; Supermemory: service-owned |

The host deliberately skips memory writes for two low-signal successful turns, in every write mode: final answers equal to `NOTHING_TO_REPORT` (the cron/webhook no-op sentinel) and tiny explicit test/ping probes such as `test` / `test ok`. Short contextual acknowledgements are not skipped by this default.

Cron and webhook turns are also capture-hygienic: when they do write memory, only the assistant answer is written. The trigger prompt or webhook pre-instructions are never sent to the deterministic host summary or intelligent capture pipeline.

Memory persistence is **host-owned**. When a user says “remember this,” the agent should acknowledge the request normally and let the configured write mode decide whether and how to persist the completed turn after the reply succeeds. It must not use shell, filesystem, or database tools to edit `.mono-agent/memory`, canonical Markdown, SQLite rows, manifests, generations, or indexes directly. Operators should stop the agent and use the `mono-agent memory ...` maintenance commands when they need to rebuild, migrate, audit, or repair memory state.

```json
{
  "memory": {
    "mode": "journal",
    "writeMode": "append-host-summary",
    "path": "./.mono-agent/memory"
  }
}
```

```bash
MONO_AGENT_MEMORY_WRITE_MODE=append-host-summary
```

### Durable completed-turn admission

The built-in store implements the harness's strong completed-turn write. Before a successful
turn reaches terminal reporting, the harness awaits an owner-only, fsynced record under
`memory.path/.capture-intake/pending/`. The filename is the SHA-256 hash of the stable provider
run id; retrying the same run and payload is a successful duplicate, while reusing that run id
with different bytes fails closed. An admission failure does not replace the provider's answer,
but it emits an explicit memory-degradation warning instead of pretending the turn was saved.

The admitted record is the restart boundary. It contains the bounded deterministic summary and,
for `writeMode: "capture"`, the bounded host-approved capture text. Projection and BuJo curation
may run after the reply, but a process restart resumes them from the durable record. Pending work
uses 16 bounded exponential-backoff attempts (one minute initially, capped at six hours, spanning
more than 24 hours) before moving to a durable dead letter. Resolved receipts are retained in a
bounded rich set, while an exact content-free `id + payload-hash` commitment remains permanently
in one of 256 cataloged compact append-only ledger shards. A sibling owner-only integrity catalog
commits every shard's byte high-water mark and SHA-256 after the shard append is fsynced. Missing,
truncated, or valid-looking replacement shards therefore fail closed. A crash between shard append
and catalog commit can advance the catalog only when every suffix entry still has an exact
materialized intake receipt and after the exact shard inode is fsynced again. A separate
owner-only schema marker at the memory root proves that the catalog has existed, so deleting both
the ledger and catalog cannot masquerade as a pre-ledger upgrade. Receipt pruning therefore cannot make an old run
admissible again or create another raw-audit line/curated fact. The intake directories are `0700`
and records/ledger shards are `0600`; symlinks, ownership changes, conflicting payloads, malformed
records, partial ledger writes, and unsafe crash transitions are rejected or deterministically
recovered before admission.

A safe rebuild may change the BuJo embedding provider or dimension while a run-owned semantic
plan is retained: the candidate is rebuilt from canonical source with the new embedding identity,
and the exact plan remains available until intake resolution. Rebuilding that retained plan into
Lite or Journal is refused before source mutation, because those tiers cannot preserve the same
BuJo run-derived ids and provider-bound replay contract. Start the current BuJo configuration to
finish the durable intake before changing tiers.

External `MemoryStore` implementations can opt into the same contract with
`persistCompletedTurn`. Stores without it retain the legacy `appendHostSummary` plus optional
`scheduleCapture` behavior. The bundled Supermemory backend implements the strong method as one
awaited, run-id-keyed remote upsert and propagates admission failure to the harness warning path.
Within one store process, the 10,000 most recently completed or exactly retried run fingerprints
are retained in a bounded LRU by default. An exact retained retry is returned as a duplicate
without a second request and refreshes its position; a retained run id reused with different
payload bytes fails before any request. Failed and still-in-flight admissions do not consume the
completed-entry budget, while concurrent exact retries remain coalesced separately. Each retained
entry is only two SHA-256 digests, without raw ids or content. After LRU eviction or process
restart, the remote stable custom id still makes a retry converge on one logical upsert, but the
remote API does not expose a conditional create/read result that lets mono-agent classify that
request as a duplicate or detect an older conflicting payload. A different post-eviction payload
can therefore replace the remote document at the same stable id. That first request becomes the
new in-flight/local fingerprint, so its exact concurrent retries coalesce and concurrent
alternatives still fail as conflicts.

### Legacy BuJo capture compatibility

The bundled harness does not call `scheduleCapture` on `BujoMemoryStore`.
Because the built-in store implements `persistCompletedTurn`, configured BuJo
agents always use the strong branch described above; capture mode reaches the
strict parser only after durable, run-idempotent admission.

BuJo retains `scheduleCapture`, direct `capture()`, and the loose capture exports
as explicit opt-in compatibility/composition surfaces for direct embedders and
offline calibration tooling. No bundled host invokes them. Their best-effort
queue is created only when a direct caller invokes `scheduleCapture`; it is absent
during normal bundled host operation. New integrations should use
`persistCompletedTurn` instead.

### Strict tier write behavior

- **Lite:** projects the admitted normalized host observation to `daily/YYYY-MM-DD.md` and indexes it for FTS. It never embeds and never calls a chat model.
- **Journal:** projects the admitted observation with a case-preserving, NFKC/whitespace-normalized SHA-256 identity, then makes it available to FTS. Semantic indexing is queued in batches of up to 32, so Ollama/LM Studio/OpenAI embedding latency is not on the provider-success critical path. Repeated content converges on one markdown/index identity.
- **BuJo:** projects each admitted compact host observation to `audit/YYYY-MM-DD.md`, outside curated recall. Only `writeMode: "capture"` asks the memory model to promote durable facts into canonical `daily/` notes and the graph. A model outage therefore cannot turn an uncurated raw transcript into recalled fact.

### Exact BuJo replay projection

BuJo capture can also create replay-owned state that canonical daily markdown
and `graph.jsonl` cannot reconstruct by themselves: thread edges, supersession
lifecycle/edges, and terminal timestamps from an explicit migration forget.
The owner-only `memory.path/.replay-projection-v1.json` is the exact canonical
authority for that state. It contains only metadata—memory ids, timestamps,
thread weights, authority kinds, and content-free SHA-256 authority digests;
it contains no memory text or model output.

Capture and migration publish their exact projection delta while the durable
capture intent or migration marker still exists, prove that SQLite matches it,
and only then retire that durable authority. A crash at any boundary therefore
leaves enough state for an idempotent replay. Strict health compares the full
sidecar and SQLite projection exactly; structurally plausible lifecycle or
edges written directly to SQLite are `canonical_mismatch`, not trusted history.
The sidecar itself is strict canonical JSON, an owner-owned single-link regular
file with mode `0600`, and is bounded to 32 MiB / 131,072 entries.

Lite and Journal do not consume the BuJo sidecar and reject replay-owned
lifecycle or edges in their SQLite index. BuJo also never infers a nonempty
projection from SQLite: if a legacy managed generation or unmanaged `memory.db`
has replay state but no sidecar, keep the agent stopped and use the explicit
metadata-only `mono-agent memory adopt-replay --json` trust-on-first-use flow
before rebuild. Adoption can safely attest multiple disjoint capture
intents/receipts and at most one migration marker. Mutable pending capture work
and a pending migration are mutually exclusive; immutable completed capture
receipts may coexist with the later migration, and retained receipts remain
until intake resolves.
Rebuild must immediately follow adoption and completes any attested protocol
without repeating provider work. Building the replacement semantic generation
still uses the configured embeddings provider before activation. Never start
the service between those steps.
See [Validation & CLI](/memory/validation-and-cli/#bujo-replay-projection-and-explicit-legacy-adoption).

The durable intake and both downstream paths are bounded and observable. Intake admits at most
4,096 active pending/dead records of at most 640 KiB each and retains at most 4,096 resolved
receipts. Its permanent content-free ledger grows by one fixed 129-byte entry per distinct run id
across up to 256 lazily created shard files plus one fixed-size 256-slot integrity catalog. Journal
indexing holds at most 256 items / 2 MiB. Each capture-model completion is
rejected before parsing when it exceeds 262,144 JavaScript characters. Runtime snapshots report
content-free intake pending/dead/resolved/due/transition counts alongside downstream queue and
shutdown state. The store republishes that snapshot immediately after admission and every durable
intake transition, so a strict health audit sees newly accepted work as `in_progress` without
waiting for the periodic heartbeat. Notification failures never roll back or misreport the durable
transition; the on-disk intake remains authoritative. Shutdown gives work up to 10 seconds to
drain; after that deadline it aborts the cooperative active attempt and returns while the intake
record remains pending for restart.

Operators can inspect that intake without reading its summaries or capture text:

```bash
mono-agent memory inspect --json
mono-agent memory inspect <64-character-id> --json
```

Inspection returns only ids, states, timestamps, attempts/revisions, due flags, bounded failure
categories, and aggregate counts. With the matching agent stopped, `memory retry [<id>]` makes
dead/delayed work due for processing after restart. `memory resolve <id> <reason-slug>` is the
explicit loss-accepting path: it records `operator_resolved` without claiming capture succeeded,
preserves permanent duplicate protection, and refuses recoverable retained semantic plans. See
[Validation & CLI](/memory/validation-and-cli/#completed-turn-intake-inspection-and-recovery) for
the liveness fence, exact inputs, and no-op semantics.

### `capture` — per-turn intelligent capture (bujo)

`capture` fsyncs the completed turn into durable intake, then projects its compact raw audit and
runs curation in the background, except for the low-signal skipped turns described above. The plan
uses exactly one chat-LLM call to extract up to eight atomic memories plus their precise
entities/relations, then at most one additional batched call to classify close existing candidates
as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP`. Clearly novel candidates skip the second call. Entity
extraction is part of the first call, not a third pass.

Key properties:

- **Local admission before terminal status.** The provider call is already complete; terminal reporting waits only for the bounded filesystem admission, never for embeddings or the chat model.
- **Restartable background work.** Raw-audit projection and curation resume from pending intake after restart or provider recovery.
- **Serialized per store.** Captures do not race each other against the same memory root.
- **Bounded shutdown without admitted-work loss.** A normal stop drains accepted work with a 10-second safety deadline. If a provider ignores cancellation, stop still returns and the durable pending record resumes on restart.
- **Strict model contracts.** Extraction and reconciliation accept one exact, bounded JSON value with complete arrays/decisions and no duplicate keys, unknown fields, partial filtering, unsafe text, or ambiguous target collisions. Reconciliation spells out the exact per-action shape: `ADD` has index/action only; `NOOP` requires a supplied target id; `UPDATE` and `SUPERSEDE` require that target plus complete replacement text. Invalid output retries and never counts as successful capture.
- **Reconcile is intelligent**, not append-only: the pipeline classifies each observation as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP` against existing memories to avoid duplication.
- **Crash-idempotent semantic commit.** Run-derived fact ids, a retained semantic plan, and the exact replay projection make a post-commit/pre-receipt replay converge without another model call, duplicate fact, or unattested lifecycle/edge.
- **Associations are precise.** Each curated fact carries only the entity IDs explicitly extracted for that fact; the implementation never creates a turn-wide memory/entity Cartesian product.

On the built-in backend, this path uses a chat LLM, so `writeMode: "capture"`
**requires `mode: "bujo"`** and fails config validation otherwise—there is no
silent fallback or tier downshift. The external Supermemory backend accepts
`capture` independently of the compatibility `mode` value because extraction is
owned by the service.

```json
{
  "memory": {
    "mode": "bujo",
    "writeMode": "capture",
    "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.6-terra" }
  }
}
```

```bash
MONO_AGENT_MEMORY_MODE=bujo
MONO_AGENT_MEMORY_WRITE_MODE=capture
```

:::caution
The capture pipeline never replaces the user's successful provider answer. An LLM/embedding timeout emits a memory warning, leaves the admitted turn pending, and retries it durably; only exhaustion moves it to a dead letter. Raise the in-app per-call timeout — `memory.llm.timeoutMs` (env `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS`), **default `60000`** — for a slow model; see [Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout).
:::

The BuJo chat model used by capture comes from the tier's required `memory.llm` block. [Scheduled consolidation](/memory/rituals/) keeps that strict tier contract but is projection-only and makes no LLM call. With `memory.llm.provider: "agent-host"`, capture can point at an SDK runtime model reference (e.g. `pi:openai-codex:gpt-5.6-terra`). The extraction prompt explicitly states exact fields, array bounds, identifier/reference grammar, lowercase relations, and the canonical `0..1` salience range. The provider-neutral strict parser remains authoritative and never clamps, rescales, or coerces model values. Standalone `migrate` remains Ollama-only; legacy `reflect` is a read-only due-state report and needs no model.

## The `MemoryRecall` tool

The agent reads memory back through a single, read-only `MemoryRecall` tool: hybrid **keyword (FTS) + vector** search over the same memory it writes to. Coverage: **config** (env: `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`).

`MemoryRecall` runs **no chat LLM** — recall is embeddings + full-text search only. Durable writes stay in-app on the agent-host LLM via [per-turn capture](#capture--per-turn-intelligent-capture-bujo); recall just reads.

Questions about the active chat are intentionally not durable-memory queries. For unqualified prompts such as `What did you send in the last message?`, `What was your previous reply?`, or `What happened in this conversation?`, automatic recall injects nothing and `MemoryRecall` returns guidance to use the active conversation history without calling the memory backend. Qualified archived questions—such as `What did Alice's last message say?` or `What did we decide last month?`—still use durable recall. This prevents an older semantically similar record from displacing the actual latest Telegram message.

:::note
**Where recalled memory appears in the prompt.** Beyond this on-demand tool, the harness *automatically* appends recalled memory to the **user message** at the start of each turn (when a recall returns hits), clearly delimited as background context — it is **not** folded into the system prompt. Riding the user message is what lets memory survive a session resume on runtimes that drop the system prompt. The injected block is not persisted to history, and a `memory_recalled` diagnostic records that recall fired (source + byte size, not the content). See [Context assembly → Memory recall](/context/assembly/#memory-recall).
:::

### How it is provisioned

The configured harness auto-provisions `MemoryRecall` from the single `config.memory` block unless `config.memory.recallTool.enabled` is explicitly `false`. This default applies both to config loaded from disk and to direct `createConfiguredAgentHarness` / `createConfiguredAgentResponder` composition whose typed memory block omits `recallTool`. It exposes a request-scoped loopback MCP endpoint backed by the **same open store and retrieval service** as automatic recall. Identical normalized automatic/tool queries share one per-turn lookup; a different tool query may search again. No second SQLite handle, embedding request, or hand-maintained MCP config is involved. Caller-supplied request extensions are composed with the default tool instead of replacing it.

The endpoint is allocated only after the turn acquires a provider-concurrency slot, so queued turns do not accumulate listeners. If endpoint startup fails, the host warns and omits the explicit tool for that turn; automatic recall and the provider response continue. If the memory backend itself fails during a tool call, `MemoryRecall` returns an explicit degraded result instead of fabricated hits.

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "recallTool": { "enabled": true }
  }
}
```

```bash
MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED=true
```

| `recallTool.enabled` default | Condition |
|------------------------------|-----------|
| **on** | every configured tier: Lite (FTS), Journal/BuJo (hybrid), and external backends |
| off | only when set explicitly to `false` |

This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture` / `memory_note` write tools — both dropped, since in-app capture now covers durable writes). To build a recall server directly in your own code, compose `@mono-agent/memory/bujo` (`createBujoMemoryStore`) with `@mono-agent/memory/search` (`createEmbeddingProvider`) — exactly what the bundled server does. See [Programmatic composition](/programmatic/composition/).

### Recall scoring

Recall fuses two retrievers and re-ranks the result:

- **BM25 keyword (FTS)** over the markdown entries.
- **Vector similarity** over the configured embeddings.
- Results are combined with **Reciprocal Rank Fusion (RRF)** and evidence strength; salience/insight are small tie-breakers. `lastAccessedAt` and access counts are telemetry only and never affect ranking.
- Automatic recall treats raw embedding similarity as ranking evidence, not a calibrated probability: it first considers the `0.65` absolute / `77%` top-relative score band, then applies a deterministic direct-fact gate to a bounded candidate window. The gate admits only canonical, unambiguous shapes: an explicitly named possessive property (`Morgan's phone number is ...`), a direct choice (`Morgan selected ... as the deployment color`), a direct event date/time, or a direct work/live location. Coordination, reported or ditransitive speech, negation/unknown values, actor/relationship questions, subordinate clauses, and multi-hop evidence abstain. Those records remain available through the default-on `MemoryRecall` tool, where the model can inspect separate results and provenance instead of receiving a fabricated binding. The gate adds no embedding or chat-model call, works across provider score scales, injects nothing for unsupported questions, and remains capped at five hits / 8 KB. Deliberate tool calls may inspect more results (up to the requested limit).

You can exercise the same hybrid scoring config-aware from the agent folder with `mono-agent memory search`:

```bash
mono-agent memory search "what did we decide about the rollout?"
```

### Entity graph (bujo auto)

The BuJo tier also maintains a lightweight entity graph beside the curated daily notes. During `writeMode: "capture"`, the first bounded extraction plan records people, projects, organizations, concepts, precise per-memory associations, and directed relationships in `graph.jsonl` under `memory.path`.

There is no separate config switch. The graph is built only for a valid configured `bujo` tier: `memory.mode: "bujo"` plus embeddings and `memory.llm`. The `lite` and `journal` tiers do not build it. Capture is serialized per store and runs after durable local admission, so graph extraction never blocks on the provider-success path; if the memory LLM fails or times out, the pending intake retries without publishing partial graph state.

Only an explicit `MemoryRecall` call uses the graph, and expansion is deterministic and limited to one hop: direct BM25/vector seeds contribute their associated entities, and one directly related entity may pull in neighboring memories. Automatic prompt injection stays direct-only and never synthesizes a graph answer in the background. Lite and Journal never expand the graph. The living `index.md`, regenerated by the in-app consolidation scheduler, includes a bounded top-entity preview so the graph is inspectable as plain markdown. That projection scans deterministic source pages through inventory exhaustion or a 10,000-row safety ceiling, retaining only bounded reconciliation state before rendering at most 50 lexical groups. It filters ephemeral calendar/time nodes and collapses lexically equivalent display names without changing canonical graph state; it is not canonical entity resolution.

### Tool policy: recall is gated by `recallTool.enabled`, not `allowedTools`

`MemoryRecall` is an MCP tool. Like every MCP server tool, it is **gated by its declaration, not by `tools.allowedTools`**. `tools.allowedTools` filters the built-in runtime tools (Read/Bash/…); it does **not** suppress app-injected MCP tools. So `tools.allowedTools: []` ("no built-in tools") still leaves `MemoryRecall` available when it is enabled.

:::caution
To withhold the on-demand memory tool from the agent, set `config.memory.recallTool.enabled: false` — that is the switch that controls this tool, not the allowlist. Automatic score- and answer-evidence-gated context recall remains part of a configured memory backend.
:::

See [Tool policy](/tools/policy/) and [MCP tools](/tools/mcp/) for how MCP-provided tools differ from the built-in allowlist.

## Environment variables

| Env var | Config key | Notes |
|---------|-----------|-------|
| `MONO_AGENT_MEMORY_WRITE_MODE` | `memory.writeMode` | `disabled` / `append-host-summary` / `capture`; built-in `capture` requires `mode: bujo`, while Supermemory extraction is service-owned |
| `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | `memory.recallTool.enabled` | Auto-provisioned `MemoryRecall`; default on for every configured tier |
| `MONO_AGENT_MEMORY_MODE` | `memory.mode` | `lite` / `journal` / `bujo` |
| `MONO_AGENT_MEMORY_LLM_MODEL` | `memory.llm.model` | Chat model for the capture pipeline |
| `MONO_AGENT_MEMORY_LLM_ENDPOINT` | `memory.llm.endpoint` | Ollama chat endpoint (default `http://localhost:11434`) |
| `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | `memory.llm.timeoutMs` | Per-call in-app chat-LLM timeout, **default `60000`**. See [Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout). |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama` / `lmstudio` / `openai`; defaults to `ollama` once the required Journal/BuJo embeddings block is present; no cross-provider fallback |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Defaults by provider (`nomic-embed-text:v1.5` for Ollama; `text-embedding-nomic-embed-text-v1.5` for LM Studio) |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Defaults to `768`; set it when the model output dimension differs |

See [Environment variables](/config/env-vars/) for the full table and precedence rules.

Journal and BuJo require an explicit, non-empty `memory.embeddings` **block**, but they do not require every field in that block. Provider, model, and dimension use the defaults above; even a block that only overrides `dim` is valid.

## Related pages

- [Memory overview](/memory/) — tier matrix and the single `memory` config block
- [Embeddings](/memory/embeddings/) — the provider/model behind vector recall
- [Consolidation](/memory/rituals/) — scheduled projection refresh and duplicate-group counting, without canonical-memory mutation
- [Validation & CLI](/memory/validation-and-cli/) — `mono-agent validate` checks and `mono-agent memory` maintenance

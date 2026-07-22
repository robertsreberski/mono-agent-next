---
title: "Backends: BuJo vs Supermemory"
description: "Compare mono-agent's local BuJo memory engine with the optional local or hosted Supermemory backend, including durability, privacy, cost, and setup tradeoffs."
sidebar:
  order: 0.5
---

mono-agent's memory engine is pluggable. `memory.backend` selects it:

- **BuJo** (`backend: "bujo"`, the default) — the built-in engine
  (`@mono-agent/memory/store` + `@mono-agent/memory/bujo`) across its three tiers
  (`lite` / `journal` / `bujo`). Persistence is local SQLite + Markdown; Journal
  and BuJo send text to whichever local or hosted embedding/model providers you configure.
- **Supermemory** (`backend: "supermemory"`) — an explicitly installed plugin backed by an external memory service
  ([supermemory.ai](https://supermemory.ai)) reached over REST. Runs locally as a single
  OSS binary or against the hosted cloud. It extracts and consolidates memories
  server-side.

Both implement the same internal `MemoryStore` contract and surface through the same
`MemoryRecall` tool, so the agent's behavior is identical from the model's point of
view — what differs is where memory lives, how it's built, and what it costs to run.

Supermemory is not in the default app install. Before selecting it, install the
exact lockstep package version printed by `mono-agent --version`:

```bash
APP_VERSION="$(mono-agent --version | sed 's/^mono-agent //')"
npm install "@mono-agent/memory-supermemory@${APP_VERSION}"
```

> Terminology: "BuJo" names the whole built-in engine here. Its top `bujo` tier (LLM
> capture + entity graph + consolidation) is the fairest like-for-like comparison with
> Supermemory; the `lite`/`journal` tiers are lighter. For tier selection within BuJo, see
> the [Memory overview](/memory/).

## At a glance

| Dimension | BuJo (built-in) | Supermemory (external) |
| --- | --- | --- |
| Where data lives | Local SQLite + markdown at `memory.path` — yours, human-readable | Supermemory instance (local binary or hosted cloud); its own store |
| Runs without a network | Lite: yes. Journal/BuJo: yes when their configured embedding/chat providers are local | Yes only when the local service and its extraction model are local |
| Memory extraction | `bujo`: separate raw audit + bounded in-app LLM curation and precise entity graph. `lite`/`journal`: deterministic canonical capture, no chat LLM | Server-side, inside Supermemory — you just POST turns |
| Dependencies | Configured embeddings (`journal`/`bujo`) + required chat model (`bujo`) | The Supermemory binary + an OpenAI-compatible LLM endpoint for its extractor (Ollama works); embeddings bundled |
| Recall | Embeddings + FTS, RRF fusion + static salience metadata, no LLM | Hybrid search (`/v4/search`, legacy `/v3` fallback) |
| Completed-turn boundary | Awaited owner-private, fsynced run-keyed intake; projection/indexing/curation resumes from it | Awaited run-keyed `/v3/documents` upsert; service extraction/indexing remains asynchronous |
| Read-after-write | Lite/Journal lexical row or BuJo raw audit follows durable admission; semantic indexing/curation is bounded and async | A successfully admitted turn is not necessarily searchable yet |
| Maintenance | `bujo`: projection-only consolidation every two hours by default (`index.md`, empty `future-log.md`, duplicate-group count) | Consolidation happens server-side; BuJo scheduled consolidation is a no-op |
| Cost model | Your tokens for `bujo` capture; embeddings local | Extraction runs on Supermemory's configured LLM endpoint |
| Privacy / ownership | Storage is local, plain-text Markdown you can read and `grep`; configured hosted embedding/chat providers still receive their request text | Local binary keeps the adapter REST hop on-machine; hosted cloud receives completed-turn text, recall queries, and returned memory |
| Setup effort | Pull Ollama models (for `journal`/`bujo`); zero extra services for `lite` | Install the optional mono-agent plugin plus `supermemory-server` (and point it at an LLM) |
| Lock-in / portability | Open SQLite + markdown; no service | Data lives in Supermemory; no shared index with BuJo |
| `MemoryRecall` tool | Same tool, same shape | Same tool (proxies Supermemory search behind the same name) |

## How they differ

### Architecture & storage
BuJo is a single embedded SQLite database plus living markdown notes under
`memory.path` — everything is on disk, human-readable, and yours. Supermemory is a
separate service: the OSS binary `supermemory-server` (default
`http://127.0.0.1:6767`) with an embedded graph engine, or the hosted cloud. With
Supermemory there is no local mono-agent store — memory lives in the instance. The
resolved config retains compatibility defaults for `memory.path`/`mode`, but operators
do not need to set them and the plugin ignores them; `embeddings`/`llm` are also ignored.

### Memory extraction
This is the biggest conceptual difference. BuJo's `bujo` tier first records a compact raw
audit outside recall, then runs **in-app** curation with one batched memory/graph extraction
and at most one batched reconcile (ADD / UPDATE / SUPERSEDE / NOOP). Associations are
fact-specific rather than turn-wide. It therefore needs a chat model (`memory.llm`). Lite
and Journal skip the chat LLM entirely; Journal hash-deduplicates lexical capture and embeds
in bounded background batches. Supermemory does extraction and
consolidation **server-side**: you POST raw turns and it decides what to remember, so no
`memory.llm` is needed on the mono-agent side. See
[Write modes, capture & recall](/memory/capture-and-recall/).

### Recall
Both back the auto-provisioned `MemoryRecall` tool and the per-turn recall-into-context.
BuJo ranks with embeddings + full-text BM25 fused via RRF, with relevance-first static
salience/insight tie-breakers and no LLM call (see [Embeddings](/memory/embeddings/)). Supermemory runs its
own hybrid search. Deliberate tool/search calls return their top-ranked hits; BuJo tool calls
may expand one graph hop. Automatic context recall remains direct-only, applies the host score
and answer-evidence gate, and injects nothing for unsupported attributes or unqualified
current/last-message questions.

### Latency & read-after-write
The built-in store awaits an owner-private, fsynced completed-turn intake before
terminal reporting, then runs projection, semantic indexing, or curation through
restartable work. Supermemory also exposes a strong boundary: mono-agent awaits
the run-keyed `/v3/documents` upsert and reports a failed admission explicitly.
The service still performs extraction and indexing asynchronously, so a fact
admitted this turn may take seconds to minutes to become searchable—do not rely
on reading it back within the same turn.

### Maintenance & consolidation
BuJo's `bujo` tier auto-runs projection-only **consolidation** every two hours by default:
`index.md` refresh, an empty retired `future-log.md` stub, and a duplicate-group count —
see [Consolidation](/memory/rituals/). It does not decay salience or automatically supersede
canonical memories. Supermemory performs its own consolidation server-side, so the BuJo
scheduler does not run for the Supermemory backend.

### Privacy & data ownership
BuJo keeps storage local in formats you own and can inspect. Journal/BuJo still
send input text to configured embedding/chat endpoints, so use local providers
when an offline boundary matters. The Supermemory **local binary** keeps the
adapter's REST traffic on-machine, but stores data in its own format. The
Supermemory **hosted cloud** receives the deterministic summary and optional full capture
text, recall queries, and the memory returned by search. Strong completed-turn metadata
omits raw run and conversation ids, but that does not make the turn content anonymous.
When payloads must stay on-machine, use the local service with a local extraction model
and verify the service's own storage and outbound configuration.

## Config side by side

BuJo (`bujo` tier — full capture + projection-only consolidation):

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5" },
    "llm": { "provider": "agent-host", "model": "claude:claude-sonnet-4-6" },
    "recallTool": { "enabled": true }
  }
}
```

Supermemory (server-side extraction — no local path, embeddings, or memory LLM required):

```json
{
  "memory": {
    "backend": "supermemory",
    "writeMode": "capture",
    "supermemory": { "baseUrl": "http://127.0.0.1:6767", "container": "my-agent" },
    "recallTool": { "enabled": true }
  }
}
```

The Supermemory API key is supplied via the environment
(`MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY`), never written into JSON. For the full key list
(including `apiKeyEnv`, `timeoutMs`, `exposeMcpServer`) see
[Environment variables → Memory](/config/env-vars/). `writeMode: "capture"` is the
recommended mode for Supermemory (full turns → server-side extraction); BuJo's lighter
tiers default to `append-host-summary`.

## When to use what

**Use BuJo (the default) when:**

- You want a fully local, zero-or-Ollama-only setup with no extra service to run.
- You value human-readable, owned memory you can read, `grep`, and version.
- You want the entity graph, mutation-free scheduled projections, and deterministic, inspectable
  recall.
- You're on `lite`/`journal` and don't want any LLM in the memory loop at all.

Within BuJo, pick the tier by your dependency budget (`lite` → no deps, `journal` →
embeddings, `bujo` → embeddings + chat model). See the [Memory overview](/memory/).

**Use Supermemory when:**

- You want best-in-class server-side extraction/consolidation **without running a capture
  LLM yourself** in mono-agent.
- You already run Supermemory, or want to use its hosted cloud.
- You're comparing external memory layers and want a first-class, swappable backend rather
  than the model calling memory tools ad hoc.

A full, runnable example lives in the
[Telegram + Supermemory playbook](/playbooks/telegram-supermemory-memory/).

## Fleet-scale shared knowledge

When memory is configured, one mono-agent app constructs one `MemoryStore` and
shares it across its responders and ritual scheduler. BuJo opens the configured
`memory.path` under a single-writer lease. The contract carries conversation
identity on reads and writes, plus a stable run identity for strong completed-turn
admission; it has no fleet-member, role, or approval identity. It does not provide
a shared canonical knowledge service with role-scoped access, human approval
queues, or cross-agent policies for curation, supersession, and retraction. Those
guarantees are intentionally outside Memory v2's current scope.

An external backend may deliberately point several agents at one namespace.
Mono-agent treats that as backend-owned behavior: it does not add authorization,
approval, or consistency semantics around the shared container. Fleets that need
those guarantees should use a dedicated knowledge service behind an external
plugin or MCP boundary rather than sharing a BuJo directory.

## Limits & gotchas

- **No shared index.** Switching `memory.backend` does **not** migrate existing memories —
  BuJo and Supermemory are separate stores and never share data.
- **Async ingestion.** Supermemory captures are eventually searchable, not immediately
  (see latency above).
- **MCP server is cloud-only.** Supermemory's hosted MCP server can't point at a
  self-hosted instance, so recall here uses the in-app REST-proxied `MemoryRecall` tool
  (works everywhere). `memory.supermemory.exposeMcpServer: true` additionally injects the
  hosted MCP server for cloud deployments with an API key.
- **Scheduled consolidation is BuJo-only.** The BuJo scheduler does not run for external backends.

## See also

- [Memory overview & tiers](/memory/)
- [Write modes, capture & recall](/memory/capture-and-recall/)
- [Consolidation](/memory/rituals/)
- [Embeddings](/memory/embeddings/)
- [Environment variables → Memory](/config/env-vars/)
- [Telegram + Supermemory playbook](/playbooks/telegram-supermemory-memory/)
